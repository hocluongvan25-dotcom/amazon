/**
 * GET /api/oauth/amazon/start?seller=<uuid>&confirm=1
 *
 * FIX MD1000/MD9100 09/2026:
 *   Log bạn gửi đã OK: redirect_uri OK + version=beta, nhưng vẫn MD9100
 *   → 99% là Allowed Return URLs trong Console lệch 100% với env, hoặc App Draft thiếu Test Accounts
 */

import { NextResponse } from "next/server";

import { getAppSession } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { buildAuthorizeUrl, normalizeRegion, validateRedirectUri } from "@/lib/spapi/oauth";

export const dynamic = "force-dynamic";

function backTo(req: Request, params: Record<string, string>): NextResponse {
  const url = new URL("/module0/connect", new URL(req.url).origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

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
  if (appId === "") missing.push("AMAZON_SP_API_APP_ID");
  if (clientId === "") missing.push("AMAZON_LWA_CLIENT_ID");
  if (clientSecret === "") missing.push("AMAZON_LWA_CLIENT_SECRET");
  if (redirectUri === "") missing.push("AMAZON_SP_API_REDIRECT_URI");
  if (missing.length > 0) {
    return backTo(req, {
      oauth: "error",
      msg: `Thiếu env: ${missing.join(" · ")}. Điền vào Vercel → Env Variables.`,
    });
  }

  // FIX MD9100: Đối soát redirect_uri 100% - log chi tiết để debug
  const allowedReturnUrlsEnv = (process.env.AMAZON_LWA_ALLOWED_RETURN_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const validation = validateRedirectUri(redirectUri, allowedReturnUrlsEnv.length > 0 ? allowedReturnUrlsEnv : undefined);

  if (!validation.ok) {
    console.error(
      `[OAuth Start] MD1000/MD9100 RISK - validation FAIL: ${validation.hint} | redirectUri=${redirectUri} | allowedEnv=${allowedReturnUrlsEnv.join(", ") || "(not set)"} | hasTrailingSlash=${validation.details.hasTrailingSlash} | closeMatches=${validation.details.closeMatches.join("|") || "none"}`,
    );
  } else {
    if (allowedReturnUrlsEnv.length === 0) {
      console.warn(
        `[OAuth Start] redirect_uri format OK but NO env AMAZON_LWA_ALLOWED_RETURN_URLS to compare with Console — MD9100 can still happen if Console has different value. redirect_uri=${redirectUri} | appId=${appId} | region=${region} | seller=${sellerId} | hint: ${validation.hint}`,
      );
      console.warn(
        `[OAuth Start] ACTION REQUIRED: Vào Developer Console → Apps & Services → App ${appId} → LWA Credentials → Allowed Return URLs, đối soát thủ công 100% với env [${redirectUri}] — lệch 1 ký tự (/ cuối, https) là MD9100. Xem /api/oauth/amazon/diag để chi tiết.`,
      );
    } else {
      console.log(
        `[OAuth Start] redirect_uri OK: ${redirectUri} | appId=${appId} | region=${region} | seller=${sellerId} | exactMatch=${validation.details.exactMatch}`,
      );
    }
  }

  const supa = await createClient();
  const { data: shops, error: shopErr } = (await supa!
    .from("vexim_shops")
    .select("seller_account_id, shop, marketplace, data_source")
    .eq("seller_account_id", sellerId)) as {
    data: { seller_account_id: string; shop: string; marketplace: string; data_source: string | null }[] | null;
    error: { message: string } | null;
  };
  if (shopErr) {
    return backTo(req, { oauth: "error", msg: `Không đọc được shop: ${shopErr.message}` });
  }
  if (!shops || shops.length === 0) {
    return backTo(req, { oauth: "error", msg: "Bạn không có quyền với shop này." });
  }

  // Chống ghi đè nhầm
  try {
    const { data: tokenRows } = (await supa!
      .from("vexim_oauth_connections")
      .select("seller_account_id")
      .eq("seller_account_id", sellerId)
      .limit(1)) as { data: { seller_account_id: string }[] | null; error: unknown };
    const hasToken = tokenRows && tokenRows.length > 0;
    if (hasToken && !confirmOverwrite) {
      return backTo(req, {
        warn: `Gian hàng ${shops[0].shop} (${shops[0].marketplace}) ĐÃ có token. Nếu kết nối lại, token cũ sẽ bị GHI ĐÈ. Xác nhận trong modal để tiếp tục.`,
        oauth: "error",
        msg: `Cần xác nhận ghi đè token cho ${shops[0].shop}`,
      });
    }
  } catch {}

  const created = await adminRpc("vexim_worker_create_oauth_state", {
    p_seller: sellerId,
    p_redirect_to: "/module0/connect",
    p_ttl_minutes: 30,
  });
  if (!created.ok) {
    return backTo(req, { oauth: "error", msg: `Không tạo được phiên authorize: ${created.error}` });
  }
  const rows = Array.isArray(created.data) ? created.data : [];
  const state = rows.length > 0 ? String((rows[0] as { state?: unknown }).state ?? "") : "";
  if (state === "") {
    return backTo(req, { oauth: "error", msg: "RPC create_oauth_state không trả về state." });
  }

  const authorizeUrl = buildAuthorizeUrl({ appId, state, redirectUri, region });
  console.log(`[OAuth Start] Redirect to Amazon consent: ${authorizeUrl} | seller=${sellerId} | shop=${shops[0].shop} | validation=${validation.ok ? "OK" : "FAIL"} | hint=${validation.hint}`);

  // Thêm log hướng dẫn fix MD9100 nếu validation chỉ OK theo format nhưng chưa đối soát Console
  if (allowedReturnUrlsEnv.length === 0) {
    console.log(
      `[OAuth Start] MD9100 diagnostic: Nếu vẫn MD9100 dù log báo OK, 99% là Console Allowed Return URLs lệch với env. Vào Console check: env=[${redirectUri}] vs Console=??. Mở /api/oauth/amazon/diag để xem chi tiết.`,
    );
  }

  return NextResponse.redirect(authorizeUrl);
}
