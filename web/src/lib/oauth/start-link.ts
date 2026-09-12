/**
 * Chữ ký cho LINK KẾT NỐI (`/api/amazon/oauth/start?service=…&shop=…&sig=…`).
 *
 * Vấn đề: người bấm link authorize thường là CHỦ SHOP, không có tài khoản VEXIM
 * → route /start không thể đòi session. Nhưng nếu để trống thì ai cũng ghép được
 * link `?shop=<shop của người khác>` và gắn token Amazon CỦA MÌNH vào shop đó
 * (bẩn dữ liệu, khó truy vết).
 *
 * Giải pháp: app (đã đăng nhập) sinh link kèm `sig` = HMAC-SHA256 của
 * `service|shop|redirect` bằng OAUTH_STATE_SECRET. /start chấp nhận khi
 *   (a) có session VEXIM hợp lệ, HOẶC
 *   (b) `sig` đúng — tức link do chính VEXIM sinh ra.
 * Token vẫn chỉ về đúng shop đã ký, và mọi lượt đều ghi audit `connections.oauth_events`.
 */
import { createHmac } from "node:crypto";

import { safeEqual } from "./crypto.ts";
import { sanitizeRedirect } from "./state.ts";

export type StartLinkParts = {
  service: string;
  shop?: string | null;
  redirect?: string | null;
};

function canonical(parts: StartLinkParts): string {
  return [
    (parts.service ?? "").trim().toLowerCase(),
    (parts.shop ?? "").trim(),
    sanitizeRedirect(parts.redirect) ?? "",
  ].join("|");
}

export function startLinkSignature(parts: StartLinkParts, secret: string): string {
  if (!secret) throw new Error("Thiếu OAUTH_STATE_SECRET — không ký được link kết nối.");
  return createHmac("sha256", secret).update(canonical(parts)).digest("base64url");
}

export function verifyStartLinkSignature(
  parts: StartLinkParts,
  signature: string | null | undefined,
  secret: string,
): boolean {
  const sig = (signature ?? "").trim();
  if (!sig || !secret) return false;
  return safeEqual(sig, startLinkSignature(parts, secret));
}

/** Sinh trọn link /start để dán vào email/chat gửi chủ shop. */
export function buildStartLink(input: {
  baseUrl: string;
  service: string;
  shop?: string | null;
  redirect?: string | null;
  secret: string;
}): string {
  const url = new URL(`${input.baseUrl.replace(/\/+$/, "")}/api/amazon/oauth/start`);
  url.searchParams.set("service", input.service);
  if (input.shop) url.searchParams.set("shop", input.shop);
  const redirect = sanitizeRedirect(input.redirect);
  if (redirect) url.searchParams.set("redirect", redirect);
  url.searchParams.set(
    "sig",
    startLinkSignature({ service: input.service, shop: input.shop, redirect }, input.secret),
  );
  return url.toString();
}
