/**
 * `state` của luồng OAuth — chữ ký HMAC, KHÔNG cần session/cookie (Module 0).
 *
 * Vì sao stateless + có chữ ký:
 *   • Vercel serverless không giữ memory giữa 2 request; dựa vào cookie thì hỏng
 *     ngay khi chủ shop authorize trên ĐIỆN THOẠI (mở link từ email/chat) rồi
 *     Amazon redirect về trình duyệt khác.
 *   • State phải mang được: service (spapi|ads), shop (uuid), chỗ quay về, và
 *     seller_hint — nếu chỉ là chuỗi ngẫu nhiên thì callback không biết ghi token
 *     cho shop nào.
 *   • Nếu KHÔNG ký, kẻ tấn công tự sửa shop trong state → gắn token của shop A vào
 *     shop B. HMAC-SHA256 bằng OAUTH_STATE_SECRET chặn đúng việc đó.
 *
 * Định dạng: base64url(JSON claims) + "." + base64url(HMAC-SHA256)
 * TTL mặc định 10 phút: authorization code của Amazon chỉ sống 5 phút, nên state
 * sống lâu hơn một chút là đủ; để lâu thành cửa cho replay.
 *
 * Ngoài chữ ký, mỗi lượt state còn được ghi vào `connections.oauth_states`
 * (migration 0020) để (a) audit và (b) đảm bảo MỘT state chỉ dùng MỘT lần —
 * RPC vexim_oauth_consume_state trả already_used=true nếu bị dùng lại.
 */
import { createHmac, randomBytes } from "node:crypto";

import { safeEqual } from "./crypto.ts";

export type OAuthService = "spapi" | "ads";

export const OAUTH_SERVICES = ["spapi", "ads"] as const;

export function isOAuthService(value: unknown): value is OAuthService {
  return value === "spapi" || value === "ads";
}

export const SERVICE_LABEL: Record<OAuthService, string> = {
  spapi: "SP-API (đơn hàng · tồn kho · tài chính)",
  ads: "Amazon Ads API (PPC · báo cáo quảng cáo)",
};

export type OAuthStateClaims = {
  /** API nào đang được authorize — quyết định client_id/secret dùng ở callback. */
  service: OAuthService;
  /** connections.seller_account_id. Có thể trống khi kết nối shop chưa có trong DB. */
  shop?: string;
  /** Đường về trong app sau callback (chỉ nhận path nội bộ, xem sanitizeRedirect). */
  redirect?: string;
  /** Seller ID / merchant token chủ shop khai trước — đối chiếu sau khi authorize. */
  sellerHint?: string;
  /** user_id của người bấm nút (để ghi audit "ai đã kết nối"). */
  actorId?: string;
  nonce: string;
  iat: number;
  exp: number;
};

export type StateReadResult =
  | { ok: true; claims: OAuthStateClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired"; detail: string };

export const STATE_TTL_SECONDS = 600;

const b64u = (input: string | Buffer): string =>
  Buffer.from(input).toString("base64url");

function sign(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

/**
 * Chỉ nhận path nội bộ (`/module0/connect`). Chặn tuyệt đối `https://…`,
 * `//host`, và `/\/` — nếu không thì state thành công cụ open-redirect.
 */
export function sanitizeRedirect(value: string | null | undefined): string | undefined {
  const raw = (value ?? "").trim();
  if (!raw) return undefined;
  if (!raw.startsWith("/")) return undefined;
  if (raw.startsWith("//")) return undefined;
  if (raw.includes("\\")) return undefined;
  if (raw.includes("://")) return undefined;
  return raw.slice(0, 300);
}

export function createState(
  input: {
    service: OAuthService;
    shop?: string | null;
    redirect?: string | null;
    sellerHint?: string | null;
    actorId?: string | null;
  },
  secret: string,
  opts: { ttlSeconds?: number; now?: number } = {},
): string {
  if (!secret) {
    throw new Error(
      "Thiếu OAUTH_STATE_SECRET — không thể ký state. Sinh khoá: " +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  const nowSeconds = Math.floor((opts.now ?? Date.now()) / 1000);
  const ttl = opts.ttlSeconds ?? STATE_TTL_SECONDS;
  const claims: OAuthStateClaims = {
    service: input.service,
    shop: input.shop?.trim() || undefined,
    redirect: sanitizeRedirect(input.redirect),
    sellerHint: input.sellerHint?.trim() || undefined,
    actorId: input.actorId?.trim() || undefined,
    nonce: randomBytes(12).toString("base64url"),
    iat: nowSeconds,
    exp: nowSeconds + ttl,
  };
  const payload = b64u(JSON.stringify(claims));
  return `${payload}.${sign(payload, secret)}`;
}

export function readState(
  token: string | null | undefined,
  secret: string,
  opts: { now?: number } = {},
): StateReadResult {
  const raw = (token ?? "").trim();
  const dot = raw.lastIndexOf(".");
  if (!raw || dot <= 0 || dot === raw.length - 1) {
    return { ok: false, reason: "malformed", detail: "state thiếu hoặc sai định dạng payload.signature" };
  }
  const payload = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  if (!safeEqual(signature, sign(payload, secret))) {
    return { ok: false, reason: "bad_signature", detail: "state không do VEXIM sinh ra (sai chữ ký HMAC)" };
  }
  let claims: OAuthStateClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthStateClaims;
  } catch {
    return { ok: false, reason: "malformed", detail: "payload state không phải JSON hợp lệ" };
  }
  if (!isOAuthService(claims?.service)) {
    return { ok: false, reason: "malformed", detail: `service trong state lạ: ${String(claims?.service)}` };
  }
  const nowSeconds = Math.floor((opts.now ?? Date.now()) / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= nowSeconds) {
    return {
      ok: false,
      reason: "expired",
      detail: `state đã hết hạn (TTL ${STATE_TTL_SECONDS / 60} phút) — bấm Kết nối lại`,
    };
  }
  return { ok: true, claims };
}

/** Đọc claims MÀ KHÔNG kiểm chữ ký — chỉ dùng để log lỗi, không bao giờ để quyết định. */
export function peekState(token: string | null | undefined): Partial<OAuthStateClaims> | null {
  const raw = (token ?? "").trim();
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  try {
    return JSON.parse(Buffer.from(raw.slice(0, dot), "base64url").toString("utf8")) as Partial<OAuthStateClaims>;
  } catch {
    return null;
  }
}
