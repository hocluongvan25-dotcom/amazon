/**
 * GET /api/amazon/oauth/callback — bước 2: Amazon trả code về đây (Module 0).
 *
 * Trình tự (mỗi bước đều ghi audit connections.oauth_events):
 *   1. Kiểm chữ ký `state` (HMAC) + TTL 10 phút.
 *   2. consume_state → đảm bảo MỘT state chỉ dùng MỘT lần (chống replay/CSRF).
 *      Nếu DB chưa chạy migration 0020 thì bỏ qua bước này, nhưng CHẶN ở bước 4.
 *   3. Đổi code lấy access_token + refresh_token qua LWA (endpoint theo region).
 *      SP-API trả `spapi_oauth_code`, Ads/LWA trả `code` — nhận cả hai.
 *   4. Mã hoá refresh token (AES-256-GCM, enc:v1:) rồi ghi qua RPC
 *      vexim_oauth_upsert_token — RPC tự tính hạn re-authorize = +365 ngày.
 *   5. 302 về trang app (redirect trong state) kèm ?oauth=ok.
 *
 * KHÔNG trả token ra response, KHÔNG log token, KHÔNG đưa gì bí mật lên client.
 */
import { NextResponse } from "next/server";

import {
  createOAuthStore,
  encryptToken,
  exchangeAuthorizationCode,
  loadOAuthConfig,
  pickAuthorizationCode,
  readState,
  type LwaError,
  type OAuthService,
} from "@/lib/oauth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Trang mặc định sau khi kết nối xong. */
const FALLBACK_REDIRECT = "/module0/connect";

function safeRedirect(path: string | null | undefined): string {
  const p = (path ?? "").trim();
  if (!p.startsWith("/") || p.startsWith("//") || p.includes("://") || p.includes("\\")) {
    return FALLBACK_REDIRECT;
  }
  return p.slice(0, 300);
}

function finishRedirect(
  base: string,
  params: Record<string, string | null | undefined>,
): NextResponse {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== "") url.searchParams.set(k, v);
  }
  const res = NextResponse.redirect(url.toString(), 302);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const config = loadOAuthConfig();
  const state = url.searchParams.get("state");
  const amazonError = url.searchParams.get("error");
  const amazonErrorDesc = url.searchParams.get("error_description");
  const code = pickAuthorizationCode(url.searchParams);

  const store = config.supabase ? createOAuthStore(config.supabase) : null;
  const peeked = state ? readState(state, config.stateSecret ?? "") : null;
  const claims = peeked?.ok ? peeked.claims : null;
  const service: OAuthService = claims?.service ?? "spapi";
  const landingBase = `${config.baseUrl}${safeRedirect(claims?.redirect)}`;

  // ---- 0. Cấu hình tối thiểu -------------------------------------------------
  if (!config.stateSecret || !config.tokenKey || !store) {
    return NextResponse.json(
      {
        ok: false,
        error: "OAuth chưa cấu hình đủ trên server.",
        problems: config.problems,
      },
      { status: 500 },
    );
  }

  // ---- 1. Chủ shop bấm "Cancel" trên trang Amazon ----------------------------
  if (amazonError) {
    await store.recordEvent({
      sellerAccountId: claims?.shop ?? null,
      service,
      event: "authorize_denied",
      status: "error",
      detail: `${amazonError}: ${amazonErrorDesc ?? ""}`.slice(0, 500),
    });
    return finishRedirect(landingBase, {
      oauth: "denied",
      service,
      reason: amazonError,
      detail: amazonErrorDesc,
    });
  }

  // ---- 2. state: chữ ký + hạn + một-lần-dùng ---------------------------------
  const verified = readState(state, config.stateSecret);
  if (!verified.ok) {
    await store.recordEvent({
      sellerAccountId: claims?.shop ?? null,
      service,
      event: "state_rejected",
      status: "error",
      detail: `${verified.reason}: ${verified.detail}`.slice(0, 500),
    });
    return finishRedirect(landingBase, {
      oauth: "error",
      service,
      reason: verified.reason,
      detail: verified.detail,
    });
  }
  const ok = verified.claims;

  const consumed = await store.consumeState(state ?? "", code ? "code_received" : "no_code");
  if (consumed.alreadyUsed) {
    await store.recordEvent({
      sellerAccountId: ok.shop ?? null,
      service: ok.service,
      event: "state_reused",
      status: "error",
      detail: "state đã được dùng trước đó — có thể chủ shop bấm lại link cũ",
    });
    return finishRedirect(landingBase, {
      oauth: "error",
      service: ok.service,
      reason: "state_reused",
      detail: "Link authorize đã dùng xong. Bấm Kết nối lại từ /module0/connect.",
    });
  }

  const shopId = ok.shop ?? consumed.sellerAccountId;
  const landing = `${config.baseUrl}${safeRedirect(ok.redirect ?? consumed.redirectUri)}`;
  if (!shopId) {
    await store.recordEvent({
      service: ok.service,
      event: "callback_missing_shop",
      status: "error",
      detail: "state không mang shop và DB cũng không có — không biết ghi token cho ai",
    });
    return finishRedirect(landing, {
      oauth: "error",
      service: ok.service,
      reason: "missing_shop",
      detail: "Link kết nối thiếu shop. Mở /module0/connect và bấm từ dòng của shop cần kết nối.",
    });
  }

  const serviceConfig = config.services[ok.service];
  if (!serviceConfig) {
    await store.recordEvent({
      sellerAccountId: shopId,
      service: ok.service,
      event: "callback_missing_credential",
      status: "error",
      detail: "env thiếu client_id/secret của service này",
    });
    return finishRedirect(landing, {
      oauth: "error",
      service: ok.service,
      reason: "missing_credential",
      detail:
        ok.service === "ads"
          ? "Thiếu AMAZON_ADS_CLIENT_ID/SECRET trên Vercel."
          : "Thiếu AMAZON_LWA_CLIENT_ID/SECRET trên Vercel.",
    });
  }

  if (!code) {
    await store.recordEvent({
      sellerAccountId: shopId,
      service: ok.service,
      event: "callback_missing_code",
      status: "error",
      detail: `Amazon redirect về không có code/spapi_oauth_code: ${url.search.slice(0, 200)}`,
    });
    return finishRedirect(landing, {
      oauth: "error",
      service: ok.service,
      reason: "missing_code",
      detail: "Amazon không trả authorization code (redirect_uri có thể chưa khớp trong app).",
    });
  }

  // ---- 3. đổi code lấy token --------------------------------------------------
  let refreshToken: string | undefined;
  let accessTokenTtl = 0;
  try {
    const tokens = await exchangeAuthorizationCode({
      code,
      redirectUri: config.redirectUri,
      region: serviceConfig.region,
      clientId: serviceConfig.clientId,
      clientSecret: serviceConfig.clientSecret,
      tokenUrl: serviceConfig.tokenUrl,
    });
    refreshToken = tokens.refresh_token;
    accessTokenTtl = tokens.expires_in ?? 0;
  } catch (e) {
    const failure = (e as { lwa?: LwaError }).lwa;
    const message = failure?.message ?? (e as Error).message;
    await store.recordEvent({
      sellerAccountId: shopId,
      service: ok.service,
      event: "token_exchange_failed",
      status: "error",
      detail: message.slice(0, 500),
    });
    return finishRedirect(landing, {
      oauth: "error",
      service: ok.service,
      reason: failure?.code ?? "exchange_failed",
      detail: message.slice(0, 300),
    });
  }

  if (!refreshToken) {
    // App dạng "confidential/server-side" mới được cấp refresh token. Thiếu nó thì
    // mỗi giờ phải nhờ chủ shop authorize lại → phải sửa cấu hình app Amazon.
    await store.recordEvent({
      sellerAccountId: shopId,
      service: ok.service,
      event: "no_refresh_token",
      status: "error",
      detail: "LWA trả access_token nhưng KHÔNG có refresh_token",
    });
    return finishRedirect(landing, {
      oauth: "error",
      service: ok.service,
      reason: "no_refresh_token",
      detail:
        "Amazon không cấp refresh_token: kiểm tra app có bật 'server-side' / confidential client " +
        "(SP-API: app phải là 'Selling Partner Insights' dạng web app; Ads: security profile phải là Web app).",
    });
  }

  // ---- 4. mã hoá + ghi DB -----------------------------------------------------
  const encrypted = encryptToken(refreshToken, config.tokenKey);
  const nowIso = new Date().toISOString();
  try {
    const saved = await store.upsertToken({
      sellerAccountId: shopId,
      service: ok.service,
      encryptedRefreshToken: encrypted,
      authorizedAt: nowIso,
      clientId: serviceConfig.clientId,
      scope: serviceConfig.scope,
      sellingPartnerId: ok.service === "spapi" ? ok.sellerHint ?? undefined : undefined,
      adsAccountId: ok.service === "ads" ? ok.sellerHint ?? undefined : undefined,
      tokenSource: "oauth",
      authorizedBy: ok.actorId ?? undefined,
      status: "active",
    });
    await store.recordEvent({
      sellerAccountId: shopId,
      service: ok.service,
      event: "authorize_completed",
      status: "ok",
      detail:
        `lưu token ${saved.id} · access_token ${accessTokenTtl}s · ` +
        `hạn re-authorize ${saved.reauthorizeAt ?? "?"} (còn ${saved.daysToReauth ?? "?"} ngày)`,
      actorId: ok.actorId ?? undefined,
    });
    return finishRedirect(landing, {
      oauth: "ok",
      service: ok.service,
      shop: shopId,
      reauthorizeAt: saved.reauthorizeAt,
      daysToReauth: String(saved.daysToReauth ?? ""),
    });
  } catch (e) {
    const message = (e as Error).message;
    await store.recordEvent({
      sellerAccountId: shopId,
      service: ok.service,
      event: "token_store_failed",
      status: "error",
      detail: message.slice(0, 500),
      actorId: ok.actorId ?? undefined,
    });
    return finishRedirect(landing, {
      oauth: "error",
      service: ok.service,
      reason: "store_failed",
      detail: message.slice(0, 300),
    });
  }
}
