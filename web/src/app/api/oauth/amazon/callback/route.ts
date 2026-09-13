/**
 * GET /api/oauth/amazon/callback?code=…&state=…&selling_partner_id=…
 *
 * Bước 2 (Amazon gọi về) — đổi code lấy refresh token và lưu vào DB.
 *
 * NĂM CHỐT AN TOÀN (mỗi chốt ứng với một cách hỏng thật đã gặp):
 *   1. STATE DÙNG MỘT LẦN: `consume_oauth_state` đánh dấu used_at; state cũ/hết
 *      hạn/không tồn tại → dừng, KHÔNG lưu token.
 *   2. ĐÚNG SHOP: `selling_partner_id` Amazon trả về phải khớp seller_id của shop
 *      đang nối. Lệch ⇒ shop khác đã authorize ⇒ KHÔNG lưu (nếu lưu, token của
 *      shop A sẽ được dùng như token của shop B — sai toàn bộ số liệu).
 *   3. TOKEN RỖNG KHÔNG LƯU: RPC set_oauth_token cũng chặn lần nữa.
 *   4. ĐỔI TOKEN XONG MỚI GHI: code chỉ dùng được một lần, nên mọi bước kiểm tra
 *      phải xong TRƯỚC khi tiêu thụ code.
 *   5. LUÔN QUAY VỀ MÀN HÌNH KÈM LÝ DO: không trả JSON trần — người dùng đang ở
 *      Seller Central, phải thấy được việc gì vừa xảy ra.
 */
import { NextResponse } from "next/server";

import { normalizeRegion, exchangeCodeForRefreshToken, explainLwaError } from "@/lib/spapi/oauth";

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
  const code = (url.searchParams.get("code") ?? "").trim();
  const state = (url.searchParams.get("state") ?? "").trim();
  const sellingPartnerId = (url.searchParams.get("selling_partner_id") ?? "").trim();
  const amazonError = (url.searchParams.get("error") ?? "").trim();

  const redirectUri = (process.env.AMAZON_SP_API_REDIRECT_URI ?? "").trim();
  const clientId = (process.env.AMAZON_LWA_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.AMAZON_LWA_CLIENT_SECRET ?? "").trim();

  // --- 1. tiêu thụ state -------------------------------------------------------
  const consumed = await adminRest("/rest/v1/rpc/vexim_worker_consume_oauth_state", {
    method: "POST",
    body: { p_state: state },
  });
  if (!consumed.ok) {
    return back(req, { oauth: "error", msg: `Không kiểm tra được state: ${consumed.error}` });
  }
  const row = (Array.isArray(consumed.data) ? consumed.data[0] : consumed.data) as
    | { seller_account_id?: string; redirect_to?: string | null; ok?: boolean; message?: string }
    | undefined;
  if (!row || row.ok !== true || !row.seller_account_id) {
    return back(req, {
      oauth: "error",
      msg: row?.message ?? "state không hợp lệ (link cũ hoặc đã dùng) — bấm Kết nối lại.",
    });
  }
  const sellerId = row.seller_account_id;

  if (amazonError !== "") {
    return back(req, {
      oauth: "error",
      seller: sellerId,
      msg: explainLwaError(amazonError, url.searchParams.get("error_description")),
    });
  }
  if (code === "") {
    return back(req, { oauth: "error", seller: sellerId, msg: "Amazon không trả về `code`." });
  }
  if (redirectUri === "" || clientId === "" || clientSecret === "") {
    return back(req, {
      oauth: "error",
      seller: sellerId,
      msg:
        "Thiếu AMAZON_SP_API_REDIRECT_URI / AMAZON_LWA_CLIENT_ID / AMAZON_LWA_CLIENT_SECRET " +
        "trên server — không đổi được code lấy token.",
    });
  }

  // --- 2. shop này là shop nào? ------------------------------------------------
  const shopRes = await adminRest(
    `/rest/v1/seller_accounts?id=eq.${sellerId}&select=${SHOP_SELECT}&limit=1`,
    { method: "GET" },
  );
  if (!shopRes.ok) {
    return back(req, { oauth: "error", msg: `Không đọc được shop: ${shopRes.error}` });
  }
  const shop = (Array.isArray(shopRes.data) ? shopRes.data[0] : undefined) as ShopRow | undefined;
  if (!shop) return back(req, { oauth: "error", msg: "Shop không tồn tại trong hệ thống." });

  // Chốt 2: chống nối nhầm shop.
  if (sellingPartnerId !== "" && shop.seller_id && shop.seller_id !== sellingPartnerId) {
    return back(req, {
      oauth: "error",
      seller: sellerId,
      msg:
        `Bạn vừa authorize một shop KHÁC (Amazon trả selling_partner_id=${sellingPartnerId}, ` +
        `shop này là ${shop.seller_id}) nên hệ thống KHÔNG lưu token. ` +
        "Kiểm tra lại tài khoản Seller Central trước khi bấm Kết nối.",
    });
  }

  // --- 3. đổi code lấy refresh token ------------------------------------------
  const exchanged = await exchangeCodeForRefreshToken({ code, redirectUri, clientId, clientSecret });
  if (!exchanged.ok) {
    return back(req, {
      oauth: "error",
      seller: sellerId,
      msg: explainLwaError(exchanged.error, exchanged.description),
    });
  }

  // --- 4. lưu token (RPC 0020 chặn token rỗng + reset cờ nhắc) -----------------
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
    return back(req, { oauth: "error", seller: sellerId, msg: `Không lưu được token: ${saved.error}` });
  }
  const savedRow = (Array.isArray(saved.data) ? saved.data[0] : saved.data) as
    | { days_left?: number; replaced?: boolean }
    | undefined;

  // --- 5. bổ sung seller_id còn thiếu (không ghi đè giá trị đã có) -------------
  if (sellingPartnerId !== "" && !shop.seller_id) {
    const patched = await adminRest(`/rest/v1/seller_accounts?id=eq.${sellerId}`, {
      method: "PATCH",
      body: { seller_id: sellingPartnerId },
      prefer: "return=minimal",
    });
    if (!patched.ok) {
      // Không phải lỗi chặn: token đã lưu xong. Chỉ ghi chú để người dùng biết.
      return back(req, {
        oauth: "ok",
        seller: sellerId,
        days: String(savedRow?.days_left ?? ""),
        warn: `Đã lưu token nhưng chưa cập nhật được seller_id: ${patched.error}`,
      });
    }
  }

  return back(req, {
    oauth: "ok",
    seller: sellerId,
    days: String(savedRow?.days_left ?? ""),
    replaced: savedRow?.replaced === true ? "1" : "0",
  });
}
