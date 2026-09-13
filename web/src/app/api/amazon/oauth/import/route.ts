/**
 * /api/amazon/oauth/import — nhập refresh token ĐÃ CÓ SẴN vào DB (Module 0).
 *
 * Dùng khi nào:
 *   • VEXIM đã self-authorize app SP-API và đang giữ AMAZON_LWA_REFRESH_TOKEN trên
 *     Vercel → bootstrap vào đúng shop, để cron đọc token TỪ DB (không phải env).
 *   • Đã có refresh token AMAZON_ADS_REFRESH_TOKEN của Ads API (trường hợp của VEXIM
 *     hiện tại) → nhập vào shop, kèm token_source='env' để biết nguồn.
 *   • Chủ shop gửi token qua kênh bảo mật → người vận hành dán vào (token_source='manual').
 *
 * POST { service, shop, refreshToken? , source?: "env"|"manual" }
 *   - source="env": lấy token từ biến môi trường, KHÔNG nhận token trong body.
 *   - thiếu source: bắt buộc có refreshToken trong body.
 * GET → trạng thái cấu hình (KHÔNG in secret, chỉ true/false) để trang /module0/connect
 *       hiện nút nào dùng được.
 *
 * Bảo mật:
 *   • Bắt buộc có phiên VEXIM; persona "client" bị chặn (khách không quản token).
 *   • Kiểm tra user CÓ THẤY shop đó không (đọc vexim_connections bằng client của
 *     user → RLS lọc theo iam.can_read_seller_account) trước khi ghi bằng service role.
 *   • Token plaintext chỉ tồn tại trong bộ nhớ request; xuống DB là bản enc:v1:.
 *   • Không log token; audit ghi "ai nhập, service nào, nguồn nào".
 */
import { NextResponse } from "next/server";

import { getAppSession } from "@/lib/auth/session";
import {
  createOAuthStore,
  encryptToken,
  isOAuthService,
  loadOAuthConfig,
  looksLikePlainRefreshToken,
  type OAuthService,
} from "@/lib/oauth";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ALLOWED_PERSONAS = new Set(["ceo", "lead_fulfill", "op_ppc"]);

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json({ ok: status < 400, ...body }, { status });
}

export async function GET() {
  const session = await getAppSession();
  if (!session) return json(401, { error: "Chưa đăng nhập." });
  if (!ALLOWED_PERSONAS.has(session.persona)) {
    return json(403, { error: `Vai trò ${session.persona} không được quản lý token.` });
  }
  const config = loadOAuthConfig();
  // CHỈ trả cờ, không trả giá trị secret.
  return NextResponse.json({
    ok: true,
    redirectUri: config.redirectUri,
    baseUrl: config.baseUrl,
    ready: {
      tokenKey: !!config.tokenKey,
      stateSecret: !!config.stateSecret,
      supabase: !!config.supabase,
      spapiLink: !!config.services.spapi,
      adsLink: !!config.services.ads,
      spapiEnvToken: !!config.services.spapi?.envRefreshToken,
      adsEnvToken: !!config.services.ads?.envRefreshToken,
    },
    regions: {
      spapi: config.services.spapi?.region ?? null,
      ads: config.services.ads?.region ?? null,
    },
    problems: config.problems,
  });
}

type ImportBody = {
  service?: unknown;
  shop?: unknown;
  refreshToken?: unknown;
  source?: unknown;
  sellingPartnerId?: unknown;
  adsAccountId?: unknown;
};

export async function POST(req: Request) {
  const session = await getAppSession();
  if (!session) return json(401, { error: "Chưa đăng nhập." });
  if (!ALLOWED_PERSONAS.has(session.persona)) {
    return json(403, { error: `Vai trò ${session.persona} không được nhập token (cần ceo/lead_fulfill/op_ppc).` });
  }

  let body: ImportBody;
  try {
    body = (await req.json()) as ImportBody;
  } catch {
    return json(400, { error: "Body phải là JSON." });
  }

  const service = body.service;
  if (!isOAuthService(service)) {
    return json(400, { error: `service phải là "spapi" hoặc "ads" (nhận ${JSON.stringify(service)}).` });
  }
  const svc = service as OAuthService;

  const shop = String(body.shop ?? "").trim();
  if (!shop || !/^[0-9a-f-]{36}$/i.test(shop)) {
    return json(400, {
      error: "shop phải là seller_account_id (uuid) — lấy từ danh sách ở /module0/connect.",
    });
  }

  const config = loadOAuthConfig();
  if (!config.tokenKey || !config.supabase) {
    return json(500, { error: "Chưa cấu hình đủ để lưu token.", problems: config.problems });
  }

  const source = body.source === "env" ? "env" : "manual";
  let plain = String(body.refreshToken ?? "").trim();
  if (source === "env") {
    plain = (config.services[svc]?.envRefreshToken ?? "").trim();
    if (!plain) {
      return json(400, {
        error: `source="env" nhưng biến môi trường ${svc === "ads" ? "AMAZON_ADS_REFRESH_TOKEN" : "AMAZON_LWA_REFRESH_TOKEN"} trống.`,
        hint: "Điền biến đó trên Vercel rồi gọi lại, hoặc dán token trực tiếp (source=manual).",
      });
    }
  }
  if (!plain) {
    return json(400, { error: "Thiếu refreshToken trong body (hoặc dùng source=\"env\")." });
  }
  if (!looksLikePlainRefreshToken(plain) && !plain.startsWith("A")) {
    return json(400, {
      error: "Chuỗi gửi lên không giống refresh token Amazon (thường bắt đầu bằng Atzr|…).",
      hint: "Kiểm tra lại: đây là REFRESH token, không phải access token (Atza|…).",
    });
  }
  if (plain.startsWith("Atza|")) {
    return json(400, {
      error: "Đây là ACCESS token (Atza|…) — sống 1 giờ nên vô dụng cho cron. Cần REFRESH token (Atzr|…).",
    });
  }

  // ---- User có được thấy shop này không? (RLS trả lời hộ) --------------------
  const userClient = await createClient();
  if (userClient) {
    const { data, error } = await userClient
      .from("vexim_connections")
      .select("seller_account_id")
      .eq("seller_account_id", shop)
      .limit(1);
    if (error) {
      return json(500, {
        error: "Không kiểm tra được quyền trên shop này.",
        hint: `${error.message}${error.hint ? ` · ${error.hint}` : ""}`,
      });
    }
    if (!data || data.length === 0) {
      return json(403, {
        error: "Bạn không có quyền trên shop này (RLS chặn) nên không nhập token được.",
        hint: "Nhờ người phụ trách shop đó, hoặc super_admin gán bạn vào iam.assignments.",
      });
    }
  }

  const store = createOAuthStore(config.supabase);
  const encrypted = encryptToken(plain, config.tokenKey);
  const nowIso = new Date().toISOString();
  const serviceConfig = config.services[svc];

  try {
    const saved = await store.upsertToken({
      sellerAccountId: shop,
      service: svc,
      encryptedRefreshToken: encrypted,
      authorizedAt: nowIso,
      clientId: serviceConfig?.clientId,
      scope: serviceConfig?.scope,
      sellingPartnerId:
        svc === "spapi" ? String(body.sellingPartnerId ?? "").trim() || undefined : undefined,
      adsAccountId: svc === "ads" ? String(body.adsAccountId ?? "").trim() || undefined : undefined,
      tokenSource: source,
      authorizedBy: session.userId,
      status: "active",
    });
    await store.recordEvent({
      sellerAccountId: shop,
      service: svc,
      event: source === "env" ? "token_imported_from_env" : "token_imported_manual",
      status: "ok",
      detail: `user ${session.email ?? session.userId} · hạn re-authorize ${saved.reauthorizeAt ?? "?"}`,
      actorId: session.userId,
    });
    return NextResponse.json({
      ok: true,
      service: svc,
      shop,
      tokenId: saved.id,
      status: saved.status,
      reauthorizeAt: saved.reauthorizeAt,
      daysToReauth: saved.daysToReauth,
      note:
        "Token đã mã hoá AES-256-GCM (enc:v1:) trước khi lưu. Hạn re-authorize = hôm nay + 365 ngày; " +
        "hệ thống tự nhắc trước 30 ngày.",
    });
  } catch (e) {
    const message = (e as Error).message;
    await store.recordEvent({
      sellerAccountId: shop,
      service: svc,
      event: "token_import_failed",
      status: "error",
      detail: message.slice(0, 500),
      actorId: session.userId,
    });
    return json(500, { error: "Không lưu được token.", hint: message });
  }
}
