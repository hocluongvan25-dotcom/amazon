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
 * FIX TÊN SHOP 16/09/2026 ("kết nối được mà không hiện tên shop Amazon"):
 *   Ngay sau khi lưu refresh token, gọi Sellers API v1 bằng CHÍNH token vừa đổi
 *   để lấy `storeName` của từng marketplace và lưu vào DB (cột store_name —
 *   migration 0031). Lỗi ở bước này KHÔNG được làm hỏng kết nối (token đã lưu
 *   thành công rồi) — chỉ trả thêm thông báo để người vận hành bấm đồng bộ lại.
 */

import { NextResponse } from "next/server";

import { normalizeRegion, exchangeCodeForRefreshToken, explainLwaError, validateRedirectUri } from "@/lib/spapi/oauth";
import { listShopCredentials, syncStoreNamesWithFreshToken } from "@/lib/data/shop-names";

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
  init: { method: string; body?: unknown; prefer?: string },
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

  /**
   * Đọc shop theo hai đường:
   *   1. RPC public.vexim_worker_list_shop_credentials (0031) — KHÔNG phụ thuộc
   *      việc schema `connections` có nằm trong "Exposed schemas" hay không.
   *   2. Fallback REST cũ — để code chạy được ngay cả khi chưa chạy 0031.
   */
  let shop: ShopRow | undefined;
  const credentials = await listShopCredentials();
  if (credentials.ok) {
    const found = credentials.shops.find((s) => s.sellerAccountId === sellerId);
    if (found) {
      shop = { id: found.sellerAccountId, display_name: found.displayName, seller_id: found.sellerId };
    }
  } else {
    const shopRes = await adminRest(
      `/rest/v1/seller_accounts?id=eq.${sellerId}&select=${SHOP_SELECT}&limit=1`,
      { method: "GET" },
    );
    if (!shopRes.ok) {
      return back(req, { oauth: "error", msg: `Không đọc được shop: ${shopRes.error}` });
    }
    shop = (Array.isArray(shopRes.data) ? shopRes.data[0] : undefined) as ShopRow | undefined;
  }
  if (!shop) return back(req, { oauth: "error", msg: "Shop không tồn tại." });

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

  // ---------------------------------------------------------------------------
  // TÊN SHOP AMAZON (storeName) — DÙNG CHÍNH TOKEN VỪA ĐỔI ĐƯỢC
  // ---------------------------------------------------------------------------
  // Sellers API v1 (GET /sellers/v1/marketplaceParticipations) trả `storeName`
  // cho từng marketplace: "The name of the seller's store as displayed in the
  // marketplace". Token vừa đổi thuộc ĐÚNG seller này ⇒ ghi tên vào đúng dòng
  // shop, không thể lẫn shop khác.
  //
  // Không chặn kết nối: token đã lưu xong. Lỗi chỉ hiện thành ghi chú vàng trên
  // màn Kết nối shop, kèm nút [Đồng bộ tên shop] để thử lại.
  let storeName: string | null = null;
  let storeNote: string | null = null;
  const sellerKey = sellingPartnerId || shop.seller_id || "";
  if (sellerKey !== "") {
    try {
      const sync = await syncStoreNamesWithFreshToken({
        sellerId: sellerKey,
        refreshToken: exchanged.refreshToken,
        region: normalizeRegion(process.env.AMAZON_SP_API_REGION),
      });
      const row = sync.rows.find((r) => r.sellerAccountId === sellerId);
      storeName = row?.storeName ?? null;
      if (!storeName) {
        storeNote =
          row?.message ??
          `Chưa lấy được tên shop Amazon cho seller ${sellerKey}: ${sync.message}`;
      }
      console.log(
        `[OAuth Callback] storeName sync: updated=${sync.updated} unchanged=${sync.unchanged} ` +
          `missing=${sync.missing} failed=${sync.failed} skipped=${sync.skipped} | ${sync.message}`,
      );
    } catch (e) {
      storeNote = `Không lấy được tên shop Amazon: ${e instanceof Error ? e.message : String(e)}`;
      console.error(`[OAuth Callback] storeName sync threw: ${storeNote}`);
    }
  } else {
    storeNote =
      "Amazon không trả selling_partner_id trong callback nên chưa đối chiếu được shop — " +
      "bấm [Đồng bộ tên shop] trên màn Kết nối shop.";
  }

  console.log(
    `[OAuth Callback] Success seller=${sellerId} days=${savedRow?.days_left} ` +
      `replaced=${savedRow?.replaced} storeName=${storeName ?? "(chưa có)"}`,
  );

  return back(req, {
    oauth: "ok",
    seller: sellerId,
    shop: shop.display_name ?? "",
    days: String(savedRow?.days_left ?? ""),
    replaced: savedRow?.replaced === true ? "1" : "0",
    store: storeName ?? "",
    storeMsg: storeNote ?? "",
  });
}
