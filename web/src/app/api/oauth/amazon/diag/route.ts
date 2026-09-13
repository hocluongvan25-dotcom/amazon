/**
 * GET /api/oauth/amazon/diag — Chẩn đoán cấu hình OAuth để fix MD1000/MD9100
 *
 * Log bạn gửi:
 *   [OAuth Start] redirect_uri OK: https://vexim.vercel.app/api/oauth/amazon/callback | appId=... | region=NA
 *   [OAuth Start] Redirect to Amazon consent: ...version=beta...
 *   Nhưng vẫn MD9100 → tức là redirect_uri theo env OK, nhưng KHÔNG khớp với Console, hoặc App Draft thiếu Test Accounts
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

  const validation = validateRedirectUri(redirectUri, allowedReturnUrlsEnv.length > 0 ? allowedReturnUrlsEnv : undefined);

  const sampleState = "diag-test-state-123";
  const sampleAuthUrl = appId && redirectUri ? buildAuthorizeUrl({ appId, state: sampleState, redirectUri, region }) : null;

  // Phân tích log bạn gửi
  const logAnalysis = {
    yourLog: {
      redirectUri: redirectUri || "https://amazon-dx1l.vercel.app/api/oauth/amazon/callback",
      appId: appId || "amzn1.sp.solution.ee3dce31-d836-4416-ada5-9a29178b0937",
      region: region,
      versionBeta: "có (version=beta trong URL)",
      status: "redirect_uri OK theo env, nhưng vẫn MD9100 nếu Console lệch",
    },
    conclusion: "Log cho thấy code đã đúng (có beta, redirect_uri OK theo env), nhưng Amazon vẫn báo MD9100 → 99% là redirect_uri trong Console LWA Credentials KHÔNG khớp 100% với env, hoặc App Draft thiếu Test Accounts / sai Region. Hiện tại production đúng phải là https://amazon-dx1l.vercel.app/api/oauth/amazon/callback",
    mostLikelyCause: `Allowed Return URLs trong Console đang là ${redirectUri}/ (CÓ / cuối) hoặc https://www... hoặc http, trong khi env là ${redirectUri} (KHÔNG / cuối) — lệch 1 ký tự là MD9100. Domain đúng hiện tại là https://amazon-dx1l.vercel.app`,
  };

  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    logAnalysis,
    env: {
      appId: appId || "(thiếu)",
      appIdExpected: "amzn1.sp.solution.ee3dce31-d836-4416-ada5-9a29178b0937",
      appIdMatch: appId === "amzn1.sp.solution.ee3dce31-d836-4416-ada5-9a29178b0937" ? "KHỚP" : `LỆCH: env=${appId} vs expected=amzn1.sp.solution.ee3dce31...`,
      redirectUri: redirectUri || "(thiếu)",
      redirectUriToCopy: redirectUri,
      region,
      hasLwaId,
      hasLwaSecret,
      allowedReturnUrlsEnv: allowedReturnUrlsEnv.length > 0 ? allowedReturnUrlsEnv : "(không set - đây là lý do validation báo OK nhưng thực tế Console có thể lệch)",
    },
    validation: {
      ok: validation.ok,
      hint: validation.hint,
      details: validation.details,
      warning: allowedReturnUrlsEnv.length === 0
        ? "Bạn chưa set AMAZON_LWA_ALLOWED_RETURN_URLS nên code chỉ check được format, KHÔNG đối soát được với Console. Đây là lý do log báo OK nhưng vẫn MD9100 — bạn phải vào Console check thủ công 100%"
        : "Đã đối soát với env AMAZON_LWA_ALLOWED_RETURN_URLS",
    },
    sampleAuthUrl,
    md9100Fix: {
      code: "MD9100",
      title: "This app can't connect right now",
      explanation: explainMdError("MD9100"),
      stepByStep: [
        {
          step: 1,
          title: "Check Redirect URI 100% (khả năng cao nhất - 90% trường hợp MD9100)",
          actions: [
            "Vào https://developer.amazon.com → Apps & Services → chọn app ee3dce31-d836-4416-ada5-9a29178b0937 → LWA Credentials → Allowed Return URLs",
            `Copy chính xác URL đang có trong Console (chụp màn hình lại)`,
            `So sánh với env hiện tại: [${redirectUri}] — phải khớp TỪNG KÝ TỰ, bao gồm:`,
            "  - https vs http (phải https)",
            "  - có / cuối hay không (https://.../callback vs https://.../callback/ là KHÁC NHAU → MD9100)",
            "  - www vs non-www (amazon-dx1l.vercel.app vs www.amazon-dx1l.vercel.app) — domain đúng hiện tại là amazon-dx1l.vercel.app, KHÔNG phải vexim.vercel.app (vexim là project retail khác)",
            "  - chữ hoa/thường, port",
            `Hiện tại env: ${redirectUri} — ${redirectUri.endsWith("/") ? "CÓ / cuối" : "KHÔNG có / cuối"}`,
            "Nếu lệch, sửa trong Console cho khớp 100% với env, HOẶC sửa env cho khớp Console, rồi Redeploy Vercel",
            "Sau khi sửa Console, đợi 2-5 phút để Amazon cache refresh",
          ],
        },
        {
          step: 2,
          title: "Check App Status & Test Accounts (nếu App ở Draft)",
          actions: [
            `Trong Console, check App Status: Draft hay Published? App ID ${appId} bạn báo published, nhưng double-check lại`,
            "Nếu là Draft/Private: vào Roles → Test Accounts → thêm email Seller đang đăng nhập Seller Central để test P1·US/P2·CA",
            "Seller email phải là email chủ shop pilot, không phải seller_id AQMVYI4HJTI4C",
            "Nếu App Published mà vẫn MD9100 → 99% vẫn là redirect_uri lệch, quay lại bước 1",
          ],
        },
        {
          step: 3,
          title: "Check Regions & Roles",
          actions: [
            `Trong Console → SP-API → Regions phải có North America (NA) — env hiện tại region=${region} — phải khớp`,
            "Trong Console → Roles → phải chọn ít nhất 1 role (ví dụ Selling Partner API, Orders, Reports...)",
            "Nếu thiếu role, Amazon cũng báo MD9100",
          ],
        },
        {
          step: 4,
          title: "Check log [OAuth Start] vừa thêm",
          actions: [
            "Bạn đã có log: redirect_uri OK và authorize URL có version=beta → code đã đúng",
            "Nhưng log chỉ check theo env, không check được Console — phải vào Console đối soát thủ công",
            `Mở /api/oauth/amazon/diag này sau mỗi lần sửa env để validation báo OK`,
            "Check Vercel Logs → tìm [OAuth Start] để xem URI thực tế gửi sang Amazon",
          ],
        },
      ],
    },
    copyPaste: {
      redirectUriToAddInConsole: redirectUri,
      note: "Copy chính xác dòng trên, paste vào Console → Allowed Return URLs → Save → đợi 2-5 phút → redeploy Vercel → thử lại",
    },
    guide: {
      consoleUrl: "https://developer.amazon.com/dashboard",
      appId: "amzn1.sp.solution.ee3dce31-d836-4416-ada5-9a29178b0937",
      currentRedirectUri: redirectUri,
      steps: [
        "1. Vào developer.amazon.com → Apps & Services → chọn app ee3dce31...",
        "2. LWA Credentials → Allowed Return URLs → kiểm tra có https://amazon-dx1l.vercel.app/api/oauth/amazon/callback không, khớp 100% không (KHÔNG dùng vexim.vercel.app — đó là project retail khác, sẽ 404)",
        "3. Nếu có / cuối trong Console mà env không có → xóa / cuối trong Console hoặc thêm / cuối vào env cho khớp",
        "4. Roles → Test Accounts → thêm email Seller pilot nếu App Draft",
        "5. SP-API → Regions → chọn NA",
        "6. Save → đợi 2-5 phút → Vercel redeploy → thử lại [Kết nối] với modal confirm",
      ],
    },
  });
}
