/**
 * GET /api/oauth/amazon/callback?spapi_oauth_code=…&state=…&selling_partner_id=…
 * hoặc ?code=…&state=… (fallback LWA cũ)
 *
 * Bước 2 (Amazon gọi về) — đổi code lấy refresh token và lưu vào DB.
 *
 * FIX 404 + spapi_oauth_code 09/2026:
 *   - Amazon SP-API OAuth trả về `spapi_oauth_code` chứ không phải `code`
 *   - Trước chỉ đọc `code` → rỗng → báo "Amazon không trả về code" → user thấy lỗi, và nếu middleware chặn thì 404
 *   - Nay đọc cả `spapi_oauth_code` và `code` (ưu tiên spapi_oauth_code)
 *   - Thêm bypass /api/oauth trong middleware để tránh 404/redirect login
 *   - Log full URL để debug
 *
 * FIX PGRST205 09/2026 ("Could not find the table 'public.seller_accounts'"):
 *   - Bảng seller_accounts nằm ở schema `connections` (migration 0001), KHÔNG
 *     phải `public`. Trước đây route gọi GET/PATCH /rest/v1/seller_accounts
 *     không kèm header Accept-Profile/Content-Profile → PostgREST tìm trong
 *     public → PGRST205 → "Không đọc được shop" dù OAuth đã thành công.
 *   - Nay đọc/ghi qua RPC public (migration 0025): vexim_worker_get_shop +
 *     vexim_worker_claim_seller_id — cùng pattern với consume_oauth_state /
 *     set_oauth_token (0020) vốn chạy OK trong cùng luồng. RPC public không
 *     phụ thuộc "Exposed schemas" (bài học 0008 của worker).
 *   - Nếu RPC chưa tồn tại (chưa push 0025 — PGRST202): fallback gọi REST kèm
 *     header Accept-Profile: connections; nếu vẫn fail thì báo đúng việc cần
 *     làm (push migration 0025) thay vì thông báo PGRST205 khó hiểu.
 */

import { NextResponse } from "next/server";

import { normalizeRegion, exchangeCodeForRefreshToken, explainLwaError, validateRedirectUri } from "@/lib/spapi/oauth";

export const dynamic = "force-dynamic";

const SHOP_SELECT = "id,display_name,seller_id";

type ShopRow = { id: string; display_name: string | null; seller_id: string | null };

function back(req: Request, params: Record<string, string>): NextResponse {
  const url = new URL("/module0/connect", new URL(req.url).origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

async function adminRest(
  path: string,
  init: { method: string; body?: unknown; prefer?: string; schema?: string },
): Promise<{ ok: boolean; data: unknown; error: string | null }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { ok: false, data: null, error: "chưa cấu hình SUPABASE_SERVICE_ROLE_KEY" };

  const res = await fetch(`${url}${path}`, {
    method: init.method,
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(init.prefer ? { Prefer: init.prefer } : {}),
      // PostgREST chọn schema bằng HEADER, không phải prefix path (xem 0008):
      //   GET/HEAD → Accept-Profile · POST/PATCH/DELETE → Content-Profile
      ...(init.schema ? { "Accept-Profile": init.schema, "Content-Profile": init.schema } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg =
      typeof data === "object" && data !== null && "message" in data
        ? String((data as { message: unknown }).message)
        : `HTTP ${res.status}`;
    return { ok: false, data, error: msg };
  }
  return { ok: true, data, error: null };
}

/** PGRST202 = function không tồn tại trong schema cache (chưa push migration 0025). */
function isMissingRpc(r: { ok: boolean; data: unknown; error: string | null }): boolean {
  if (r.ok) return false;
  const codeStr =
    typeof r.data === "object" && r.data !== null && "code" in r.data
      ? String((r.data as { code: unknown }).code)
      : "";
  return codeStr === "PGRST202" || /could not find the function/i.test(r.error ?? "");
}

/**
 * Đọc shop: ưu tiên RPC public.vexim_worker_get_shop (0025); nếu RPC chưa có
 * thì fallback REST với header Accept-Profile: connections (chỉ chạy được khi
 * schema connections nằm trong "Exposed schemas").
 */
async function readShop(sellerId: string): Promise<{ ok: boolean; shop: ShopRow | null; error: string | null }> {
  const viaRpc = await adminRest("/rest/v1/rpc/vexim_worker_get_shop", {
    method: "POST",
    body: { p_seller: sellerId },
  });
  if (viaRpc.ok) {
    const shop = (Array.isArray(viaRpc.data) ? viaRpc.data[0] : viaRpc.data) as ShopRow | undefined;
    return { ok: true, shop: shop ?? null, error: null };
  }
  if (!isMissingRpc(viaRpc)) return { ok: false, shop: null, error: viaRpc.error };

  console.warn(
    `[OAuth Callback] RPC vexim_worker_get_shop chưa có (PGRST202) — chưa push migration 0025? Fallback REST + Accept-Profile: connections`,
  );
  const viaRest = await adminRest(
    `/rest/v1/seller_accounts?id=eq.${sellerId}&select=${SHOP_SELECT}&limit=1`,
    { method: "GET", schema: "connections" },
  );
  if (viaRest.ok) {
    const shop = (Array.isArray(viaRest.data) ? viaRest.data[0] : undefined) as ShopRow | undefined;
    return { ok: true, shop: shop ?? null, error: null };
  }
  return {
    ok: false,
    shop: null,
    error:
      `${viaRest.error} — bảng seller_accounts nằm ở schema connections (không phải public). ` +
      `Fix: push migration 0025 (supabase db push) để có RPC vexim_worker_get_shop, ` +
      `hoặc thêm 'connections' vào Exposed schemas (Dashboard → Settings → API).`,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  // FIX 404: Amazon SP-API trả spapi_oauth_code, không phải code
  const spapiCode = (url.searchParams.get("spapi_oauth_code") ?? "").trim();
  const lwaCode = (url.searchParams.get("code") ?? "").trim();
  const code = spapiCode || lwaCode;

  const state = (url.searchParams.get("state") ?? "").trim();
  const sellingPartnerId = (url.searchParams.get("selling_partner_id") ?? "").trim();
  const amazonError = (url.searchParams.get("error") ?? "").trim();
  const amazonErrorDesc = (url.searchParams.get("error_description") ?? "").trim();

  const redirectUri = (process.env.AMAZON_SP_API_REDIRECT_URI ?? "").trim();
  const clientId = (process.env.AMAZON_LWA_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.AMAZON_LWA_CLIENT_SECRET ?? "").trim();
  const appId = (process.env.AMAZON_SP_API_APP_ID ?? "").trim();

  console.log(
    `[OAuth Callback] URL=${url.toString()} | spapi_oauth_code=${spapiCode ? "present(" + spapiCode.slice(0, 8) + "...)" : "missing"} code=${lwaCode ? "present" : "missing"} state=${state.slice(0, 8)}... seller Amazon=${sellingPartnerId} error=${amazonError} redirectUri=${redirectUri} appId=${appId}`,
  );

  const validation = validateRedirectUri(redirectUri);
  if (!validation.ok) {
    console.error(`[OAuth Callback] MD9100 risk - ${validation.hint}`);
  }

  if (state === "") {
    console.error(`[OAuth Callback] Missing state — possible direct access without OAuth flow`);
    return back(req, { oauth: "error", msg: "Thiếu state — link callback không hợp lệ. Bấm Kết nối lại từ màn Kết nối shop." });
  }

  const consumed = await adminRest("/rest/v1/rpc/vexim_worker_consume_oauth_state", {
    method: "POST",
    body: { p_state: state },
  });
  if (!consumed.ok) {
    console.error(`[OAuth Callback] consume_oauth_state failed: ${consumed.error} state=${state}`);
    return back(req, { oauth: "error", msg: `Không kiểm tra được state: ${consumed.error} — có thể hết hạn (30p) hoặc đã dùng. Bấm Kết nối lại.` });
  }
  const row = (Array.isArray(consumed.data) ? consumed.data[0] : consumed.data) as
    | { seller_account_id?: string; redirect_to?: string | null; ok?: boolean; message?: string }
    | undefined;
  if (!row || row.ok !== true || !row.seller_account_id) {
    console.error(`[OAuth Callback] Invalid state: ${JSON.stringify(row)} state=${state}`);
    return back(req, { oauth: "error", msg: row?.message ?? "state không hợp lệ — bấm Kết nối lại." });
  }
  const sellerId = row.seller_account_id;

  if (amazonError !== "") {
    console.error(`[OAuth Callback] Amazon error: ${amazonError} desc=${amazonErrorDesc} seller=${sellerId}`);
    return back(req, {
      oauth: "error",
      seller: sellerId,
      msg: explainLwaError(amazonError, amazonErrorDesc || null) + ` (Code: ${amazonError})`,
    });
  }
  if (code === "") {
    console.error(`[OAuth Callback] Missing both spapi_oauth_code and code. URL=${url.toString()}`);
    return back(req, {
      oauth: "error",
      seller: sellerId,
      msg: "Amazon không trả về spapi_oauth_code (hoặc code). Đã fix để nhận cả 2 — check log [OAuth Callback] để xem params thực tế.",
    });
  }
  if (redirectUri === "" || clientId === "" || clientSecret === "") {
    return back(req, { oauth: "error", seller: sellerId, msg: "Thiếu redirect_uri/clientId/clientSecret trên server." });
  }

  const shopRes = await readShop(sellerId);
  if (!shopRes.ok) {
    console.error(`[OAuth Callback] Read shop failed: ${shopRes.error} seller=${sellerId}`);
    return back(req, { oauth: "error", seller: sellerId, msg: `Không đọc được shop: ${shopRes.error}` });
  }
  const shop = shopRes.shop;
  if (!shop) return back(req, { oauth: "error", seller: sellerId, msg: "Shop không tồn tại." });

  if (sellingPartnerId !== "" && shop.seller_id && shop.seller_id !== sellingPartnerId) {
    return back(req, {
      oauth: "error",
      seller: sellerId,
      msg: `Bạn vừa authorize shop KHÁC (Amazon trả ${sellingPartnerId}, shop này là ${shop.seller_id}) nên KHÔNG lưu token.`,
    });
  }

  console.log(`[OAuth Callback] Exchanging code: ${code.slice(0, 8)}... redirectUri=${redirectUri} seller=${sellerId}`);
  const exchanged = await exchangeCodeForRefreshToken({ code, redirectUri, clientId, clientSecret });
  if (!exchanged.ok) {
    console.error(`[OAuth Callback] Exchange failed: ${exchanged.error} desc=${exchanged.description}`);
    return back(req, { oauth: "error", seller: sellerId, msg: explainLwaError(exchanged.error, exchanged.description) });
  }

  const saved = await adminRest("/rest/v1/rpc/vexim_worker_set_oauth_token", {
    method: "POST",
    body: {
      p_seller: sellerId,
      p_token: {
        refreshToken: exchanged.refreshToken,
        authScope: null,
        authorizedAt: new Date().toISOString(),
        noticeDays: 30,
        region: normalizeRegion(process.env.AMAZON_SP_API_REGION),
      },
    },
  });
  if (!saved.ok) {
    console.error(`[OAuth Callback] Save token failed: ${saved.error}`);
    return back(req, { oauth: "error", seller: sellerId, msg: `Không lưu được token: ${saved.error}` });
  }
  const savedRow = (Array.isArray(saved.data) ? saved.data[0] : saved.data) as
    | { days_left?: number; replaced?: boolean }
    | undefined;

  if (sellingPartnerId !== "" && !shop.seller_id) {
    // Điền seller_id Amazon lần đầu — RPC 0025 (chỉ ghi khi đang rỗng, không ghi đè).
    const claimed = await adminRest("/rest/v1/rpc/vexim_worker_claim_seller_id", {
      method: "POST",
      body: { p_seller: sellerId, p_seller_id: sellingPartnerId },
    });
    if (!claimed.ok && isMissingRpc(claimed)) {
      // Chưa push 0025 — fallback PATCH kèm Content-Profile: connections.
      const patched = await adminRest(`/rest/v1/seller_accounts?id=eq.${sellerId}&seller_id=is.null`, {
        method: "PATCH",
        body: { seller_id: sellingPartnerId },
        prefer: "return=minimal",
        schema: "connections",
      });
      if (!patched.ok) {
        // Token ĐÃ lưu OK — thiếu seller_id chỉ là metadata, không fail cả luồng.
        console.warn(`[OAuth Callback] claim seller_id fallback failed (non-fatal): ${patched.error}`);
      }
    } else if (!claimed.ok) {
      console.warn(`[OAuth Callback] claim seller_id failed (non-fatal): ${claimed.error}`);
    } else {
      const claimRow = (Array.isArray(claimed.data) ? claimed.data[0] : claimed.data) as
        | { claimed?: boolean; message?: string }
        | undefined;
      console.log(`[OAuth Callback] claim seller_id: claimed=${claimRow?.claimed} msg=${claimRow?.message}`);
    }
  }

  console.log(`[OAuth Callback] Success seller=${sellerId} days=${savedRow?.days_left} replaced=${savedRow?.replaced}`);

  return back(req, {
    oauth: "ok",
    seller: sellerId,
    days: String(savedRow?.days_left ?? ""),
    replaced: savedRow?.replaced === true ? "1" : "0",
  });
}
