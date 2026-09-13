/**
 * GET /api/oauth/amazon/diag — Chẩn đoán cấu hình OAuth để fix MD1000/MD9100
 *
 * Trả về env hiện tại (không lộ secret) + validation redirect_uri để đối soát với Amazon Developer Console
 * Chỉ cho phép CEO (check session) — không public
 */

import { NextResponse } from "next/server";
import { getAppSession } from "@/lib/auth/session";
import { buildAuthorizeUrl, normalizeRegion, validateRedirectUri, explainMdError } from "@/lib/spapi/oauth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getAppSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Chưa đăng nhập" }, { status: 401 });
  }
  if (session.persona !== "ceo") {
    return NextResponse.json({ ok: false, error: "Chỉ CEO được xem diag" }, { status: 403 });
  }

  const appId = (process.env.AMAZON_SP_API_APP_ID ?? "").trim();
  const redirectUri = (process.env.AMAZON_SP_API_REDIRECT_URI ?? "").trim();
  const region = normalizeRegion(process.env.AMAZON_SP_API_REGION);
  const allowedReturnUrlsEnv = (process.env.AMAZON_LWA_ALLOWED_RETURN_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const hasLwaId = !!process.env.AMAZON_LWA_CLIENT_ID;
  const hasLwaSecret = !!process.env.AMAZON_LWA_CLIENT_SECRET;
  const hasSupabaseServiceKey = !!process.env.SUPABASE_SERVICE_ROLE_KEY;

  const validation = validateRedirectUri(redirectUri, allowedReturnUrlsEnv.length > 0 ? allowedReturnUrlsEnv : undefined);

  // Tạo URL mẫu để đối soát
  const sampleState = "diag-test-state-123";
  const sampleAuthUrl = appId && redirectUri ? buildAuthorizeUrl({ appId, state: sampleState, redirectUri, region }) : null;

  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    env: {
      appId: appId || "(thiếu)",
      appIdFull: appId ? `${appId.slice(0, 20)}...${appId.slice(-8)}` : "(thiếu)",
      redirectUri: redirectUri || "(thiếu)",
      region,
      hasLwaId,
      hasLwaSecret,
      hasSupabaseServiceKey,
      allowedReturnUrlsEnv: allowedReturnUrlsEnv.length > 0 ? allowedReturnUrlsEnv : "(không set - cần check Console thủ công)",
    },
    validation: {
      ok: validation.ok,
      hint: validation.hint,
      details: validation.details,
    },
    sampleAuthUrl,
    checks: {
      md1000: {
        code: "MD1000",
        explanation: explainMdError("MD1000"),
        checklist: [
          `App ID phải đúng: ${appId || "(thiếu)"} — so với Console Apps & Services`,
          `URL phải có version=beta — code đã thêm: ${sampleAuthUrl?.includes("version=beta") ? "OK có beta" : "THIẾU beta"}`,
          `redirect_uri phải khớp 100% Allowed Return URLs — validation: ${validation.ok ? "OK" : "FAIL: " + validation.hint}`,
          `Nếu App Draft: Seller phải trong Test Accounts`,
        ],
      },
      md9100: {
        code: "MD9100",
        explanation: explainMdError("MD9100"),
        checklist: [
          `1. Check Redirect URI 100% (khả năng cao nhất): Vào Apps & Services → LWA Credentials → Allowed Return URLs, so sánh với env AMAZON_SP_API_REDIRECT_URI [${redirectUri || "(thiếu)"}] — khớp từng chữ cái, bao gồm https và / cuối`,
          `   - Hiện tại env có / cuối: ${redirectUri.endsWith("/") ? "CÓ / cuối" : "KHÔNG có / cuối"} — Console cũng phải y hệt`,
          `   - Protocol: ${validation.details.protocol || "?"} — phải https`,
          `   - Host: ${validation.details.host || "?"} — phải đúng domain Vercel`,
          `   - Close matches (gần giống nhưng lệch): ${validation.details.closeMatches.length > 0 ? validation.details.closeMatches.join(" | ") : "không có"}`,
          `2. Check App Status & Regions: App ID ${appId || "(thiếu)"} đang Draft hay Published? Nếu Draft/Private, Seller email đăng nhập phải trong Test Accounts, và Region phải NA cho US/CA (hiện tại env region=${region})`,
          `3. Check log [OAuth Start] trong Vercel Logs để xem URI thực tế gửi sang Amazon`,
          `4. Nếu đã fix redirect_uri, phải đợi vài phút để Amazon cache refresh, hoặc thử lại sau`,
        ],
      },
    },
    guide: {
      step1: "Vào https://developer.amazon.com → Apps & Services → chọn app ee3dce31... → LWA Credentials → Allowed Return URLs",
      step2: `Copy chính xác URL trong Console, paste vào Vercel Env AMAZON_SP_API_REDIRECT_URI (hiện tại: ${redirectUri || "(thiếu)"})`,
      step3: "Nếu App ở Draft: vào Roles → Test Accounts → thêm email Seller đang test P1·US/P2·CA",
      step4: "Đảm bảo Region trong Console chọn North America (NA) cho US/CA, và env AMAZON_SP_API_REGION=NA",
      step5: "Redeploy Vercel sau khi sửa env, rồi bấm lại [Kết nối] với modal xác nhận",
      step6: "Check /api/oauth/amazon/diag lại sau redeploy để validation OK",
    },
  });
}
