/**
 * GET /api/amazon/oauth/start — bước 1 của luồng kết nối THẬT (Module 0).
 *
 *   /api/amazon/oauth/start?service=ads&shop=<uuid>            (bấm trong app)
 *   /api/amazon/oauth/start?service=spapi&shop=<uuid>&sig=…    (link gửi chủ shop)
 *   /api/amazon/oauth/start?service=ads&shop=<uuid>&redirect=/ppc
 *
 * Làm gì:
 *   1. Kiểm tra `service` (spapi|ads) và credential tương ứng trong env.
 *   2. Xác thực lượt bấm: có session VEXIM HOẶC `sig` do chính app ký
 *      (xem lib/oauth/start-link.ts — chủ shop không có tài khoản VEXIM).
 *   3. Sinh `state` có chữ ký HMAC (service + shop + redirect + nonce, TTL 10 phút)
 *      và ghi vào connections.oauth_states để đảm bảo dùng MỘT lần.
 *   4. 302 sang trang authorize của Amazon (Seller Central consent cho SP-API,
 *      LWA /ap/oa cho Ads) — đúng endpoint theo REGION của app.
 *
 * KHÔNG làm gì ở đây: không đổi code, không chạm refresh token. Callback lo.
 */
import { NextResponse } from "next/server";

import { getAppSession } from "@/lib/auth/session";
import {
  buildAuthorizeUrl,
  createState,
  createOAuthStore,
  isOAuthService,
  loadOAuthConfig,
  startLinkSignature,
  verifyStartLinkSignature,
  type OAuthService,
} from "@/lib/oauth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json({ ok: false, ...body }, { status });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const rawService = url.searchParams.get("service");
  const shop = url.searchParams.get("shop")?.trim() || null;
  const redirect = url.searchParams.get("redirect")?.trim() || null;
  const sellerHint = url.searchParams.get("sellerHint")?.trim() || null;
  const sig = url.searchParams.get("sig");

  if (!isOAuthService(rawService)) {
    return json(400, {
      error: `service phải là "spapi" hoặc "ads" (nhận ${JSON.stringify(rawService)}).`,
      hint: "/api/amazon/oauth/start?service=ads&shop=<seller_account_id>",
    });
  }
  const service = rawService as OAuthService;

  const config = loadOAuthConfig();
  if (!config.stateSecret) {
    return json(500, {
      error: "Chưa cấu hình OAUTH_STATE_SECRET — không ký được state (chống CSRF).",
      hint:
        "Vercel → Environment Variables → thêm OAUTH_STATE_SECRET (chuỗi ngẫu nhiên 64 hex). " +
        'Sinh khoá: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    });
  }
  if (!config.tokenKey) {
    return json(500, {
      error: "Chưa cấu hình OAUTH_TOKEN_ENC_KEY — authorize xong cũng không lưu được token.",
      hint: "Thêm OAUTH_TOKEN_ENC_KEY rồi chạy lại. RPC 0020 từ chối lưu token plaintext.",
    });
  }

  // ---- Xác thực lượt bấm: session VEXIM hoặc link đã ký ----------------------
  const session = await getAppSession();
  const signature = startLinkSignature({ service, shop, redirect }, config.stateSecret);
  const signedOk = verifyStartLinkSignature({ service, shop, redirect }, sig, config.stateSecret);
  if (!session && !signedOk) {
    return json(401, {
      error: "Link kết nối không hợp lệ: cần đăng nhập VEXIM hoặc link có chữ ký (sig).",
      hint: `Mở trang /module0/connect để lấy link mới, hoặc dùng sig=${signature.slice(0, 12)}… (app tự sinh).`,
    });
  }

  const serviceConfig = config.services[service];
  if (!serviceConfig) {
    const needed =
      service === "ads"
        ? "AMAZON_ADS_CLIENT_ID + AMAZON_ADS_CLIENT_SECRET (Security profile trong Advertising Console)"
        : "AMAZON_LWA_CLIENT_ID + AMAZON_LWA_CLIENT_SECRET (+ AMAZON_SP_API_APPLICATION_ID cho luồng consent)";
    return json(501, {
      error: `Chưa cấu hình credential ${service === "ads" ? "Amazon Ads API" : "SP-API"} nên không sinh được link authorize.`,
      hint: `Cần ${needed}. Nếu ĐÃ có refresh token ${service} thì dùng POST /api/amazon/oauth/import.`,
    });
  }

  // ---- state: ký + ghi DB (một lần dùng) ------------------------------------
  const state = createState(
    { service, shop, redirect, sellerHint, actorId: session?.userId ?? null },
    config.stateSecret,
  );

  if (config.supabase) {
    try {
      const store = createOAuthStore(config.supabase);
      await store.setState({
        state,
        service,
        sellerAccountId: shop,
        redirectUri: redirect,
        scope: serviceConfig.scope,
        actorId: session?.userId ?? null,
        sellerHint,
      });
      await store.recordEvent({
        sellerAccountId: shop,
        service,
        event: "authorize_started",
        status: "ok",
        detail: signedOk && !session ? "link đã ký (chủ shop tự bấm)" : `user ${session?.email ?? session?.userId ?? "?"}`,
        actorId: session?.userId ?? null,
      });
    } catch (e) {
      // Không ghi được state vào DB thì VẪN cho authorize tiếp: state đã có chữ ký
      // HMAC nên callback vẫn xác thực được (chỉ mất khả năng chống dùng-lần-2
      // và mất audit). Báo rõ trong response để người vận hành biết mà sửa.
      return json(500, {
        error: "Không ghi được state xuống Supabase — dừng để tránh mất audit/chống replay.",
        hint: (e as Error).message,
      });
    }
  }

  const { url: authorizeUrl, flow } = buildAuthorizeUrl({
    service,
    region: serviceConfig.region,
    clientId: serviceConfig.clientId,
    redirectUri: config.redirectUri,
    state,
    applicationId: serviceConfig.applicationId,
    scope: serviceConfig.scope,
  });

  // Với request từ trình duyệt → 302 thẳng sang Amazon.
  const acceptsHtml = (req.headers.get("accept") ?? "").includes("text/html");
  if (acceptsHtml) {
    const res = NextResponse.redirect(authorizeUrl, 302);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
  // Gọi bằng curl/fetch → trả JSON để dev soi link mà không bị redirect theo.
  return NextResponse.json({
    ok: true,
    service,
    shop,
    flow,
    region: serviceConfig.region,
    redirectUri: config.redirectUri,
    authorizeUrl,
    stateIssued: true,
  });
}
