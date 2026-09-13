/**
 * GET /api/oauth/amazon/start?seller=<uuid>&confirm=1
 *
 * Bước 1 của luồng authorize LWA (SOP-11): sinh `state` dùng-một-lần rồi đưa chủ
 * shop sang Seller Central để bấm Authorize.
 *
 * FIX UX SOP-11 (09/2026):
 *   - Trước: seed 8 dòng, dễ bấm nhầm [Kết nối] ghi đè token sai shop
 *   - Nay: thêm ?confirm=1 để chống ghi đè nhầm, và kiểm tra token cũ để cảnh báo
 *   - UI mới có modal xác nhận hiển thị rõ Seller ID, Marketplace, trạng thái token cũ
 *
 * VÌ SAO `state` NẰM Ở DB (không phải cookie): callback là request KHÁC, có thể
 * do Amazon mở trên máy khác/trình duyệt khác, và phải chống CSRF. Ghi state vào
 * `connections.oauth_states` (RPC service_role) rồi kiểm tra ở callback là cách
 * duy nhất còn hiệu lực khi không dựa vào cookie.
 *
 * VÌ SAO PHẢI KIỂM TRA QUYỀN TRƯỚC KHI SINH STATE: nếu ai cũng sinh được state
 * cho shop bất kỳ thì họ có thể khiến shop đó authorize lại vào tài khoản của
 * người khác. Ở đây: chỉ người ĐỌC ĐƯỢC shop đó (qua RLS `vexim_shops`) mới được
 * bắt đầu luồng.
 */
import { NextResponse } from "next/server";

import { getAppSession } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { buildAuthorizeUrl, normalizeRegion } from "@/lib/spapi/oauth";

export const dynamic = "force-dynamic";

function backTo(req: Request, params: Record<string, string>): NextResponse {
  const url = new URL("/module0/connect", new URL(req.url).origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

/** Client service_role: cần để gọi RPC create_oauth_state (RPC từ chối user thường). */
async function adminRpc(
  fn: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; data: unknown; error: string | null }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { ok: false, data: null, error: "chưa cấu hình SUPABASE_SERVICE_ROLE_KEY" };

  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
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
  const sellerId = (url.searchParams.get("seller") ?? "").trim();
  const confirmOverwrite = (url.searchParams.get("confirm") ?? "").trim() === "1";

  const session = await getAppSession();
  if (!session) return NextResponse.redirect(new URL("/login", url.origin));
  if (session.mode !== "supabase") {
    return backTo(req, {
      oauth: "error",
      msg: "Chưa cấu hình Supabase (đang DEMO MODE) — không lưu được token.",
    });
  }
  if (sellerId === "") {
    return backTo(req, { oauth: "error", msg: "Thiếu --seller: không biết kết nối shop nào." });
  }

  const appId = (process.env.AMAZON_SP_API_APP_ID ?? "").trim();
  const clientId = (process.env.AMAZON_LWA_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.AMAZON_LWA_CLIENT_SECRET ?? "").trim();
  const redirectUri = (process.env.AMAZON_SP_API_REDIRECT_URI ?? "").trim();
  const region = normalizeRegion(process.env.AMAZON_SP_API_REGION);

  const missing: string[] = [];
  if (appId === "") missing.push("AMAZON_SP_API_APP_ID (amzn1.sp.solution…)");
  if (clientId === "") missing.push("AMAZON_LWA_CLIENT_ID");
  if (clientSecret === "") missing.push("AMAZON_LWA_CLIENT_SECRET");
  if (redirectUri === "") missing.push("AMAZON_SP_API_REDIRECT_URI");
  if (missing.length > 0) {
    return backTo(req, {
      oauth: "error",
      msg:
        `Thiếu biến môi trường: ${missing.join(" · ")}. ` +
        "Điền vào Vercel → Environment Variables rồi thử lại (redirect URI phải trùng đúng từng ký tự với app SP-API).",
    });
  }

  // Quyền: chỉ người đọc được shop này (RLS của vexim_shops) mới được bắt đầu.
  const supa = await createClient();
  const { data: shops, error: shopErr } = (await supa!
    .from("vexim_shops")
    .select("seller_account_id, shop, marketplace, data_source")
    .eq("seller_account_id", sellerId)) as {
    data: { seller_account_id: string; shop: string; marketplace: string; data_source: string | null }[] | null;
    error: { message: string } | null;
  };
  if (shopErr) {
    return backTo(req, { oauth: "error", msg: `Không đọc được danh sách shop: ${shopErr.message}` });
  }
  if (!shops || shops.length === 0) {
    return backTo(req, {
      oauth: "error",
      msg: "Bạn không có quyền với shop này (hoặc shop không tồn tại).",
    });
  }

  // FIX UX: kiểm tra token cũ để cảnh báo ghi đè nhầm
  // Nếu shop đã có token và chưa có ?confirm=1 thì trả về trang connect với cảnh báo
  try {
    const { data: tokenRows } = (await supa!
      .from("vexim_oauth_connections")
      .select("seller_account_id, is_active, days_left")
      .eq("seller_account_id", sellerId)
      .limit(1)) as {
      data: { seller_account_id: string; is_active: boolean; days_left: number | null }[] | null;
      error: unknown;
    };
    const hasToken = tokenRows && tokenRows.length > 0;
    if (hasToken && !confirmOverwrite) {
      // Trả về trang connect với warn để UI modal hiện lại (tránh bấm nhầm)
      return backTo(req, {
        warn: `Gian hàng ${shops[0].shop} (${shops[0].marketplace}) ĐÃ có token. Nếu kết nối lại, token cũ sẽ bị GHI ĐÈ. Bấm lại nút Kết nối và xác nhận trong modal để tiếp tục.`,
        oauth: "error",
        msg: `Cần xác nhận ghi đè token cho ${shops[0].shop}`,
      });
    }
  } catch {
    // Nếu view chưa tồn tại hoặc lỗi, bỏ qua check — vẫn cho kết nối
  }

  // redirect_to: quay lại màn Kết nối shop sau khi Amazon trả code.
  const created = await adminRpc("vexim_worker_create_oauth_state", {
    p_seller: sellerId,
    p_redirect_to: "/module0/connect",
    p_ttl_minutes: 30,
  });
  if (!created.ok) {
    return backTo(req, {
      oauth: "error",
      msg: `Không tạo được phiên authorize: ${created.error ?? "lỗi không rõ"}`,
    });
  }
  const rows = Array.isArray(created.data) ? created.data : [];
  const state = rows.length > 0 ? String((rows[0] as { state?: unknown }).state ?? "") : "";
  if (state === "") {
    return backTo(req, { oauth: "error", msg: "RPC create_oauth_state không trả về state." });
  }

  const authorizeUrl = buildAuthorizeUrl({ appId, state, redirectUri, region });
  return NextResponse.redirect(authorizeUrl);
}
