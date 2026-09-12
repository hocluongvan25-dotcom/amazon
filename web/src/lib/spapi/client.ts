/**
 * Amazon SP-API client (server-side only).
 *
 * Usage:
 *   import { spapi } from "@/lib/spapi/client";
 *   const r = await spapi("GET", "/sellers/v1/marketplaceParticipations");
 *
 * Tự động:
 * - Lấy access_token từ LWA bằng refresh_token (cache 55 phút)
 * - Gọi vào region NA (sellingpartnerapi-na.amazon.com) mặc định
 * - Bắn header x-amz-access-token + User-Agent đúng chuẩn
 *
 * Không dùng ở client component — refresh_token & client_secret chỉ có server.
 */

type Method = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.token;

  const clientId = process.env.AMAZON_LWA_CLIENT_ID;
  const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET;
  const refreshToken = process.env.AMAZON_LWA_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Thiếu AMAZON_LWA_CLIENT_ID / SECRET / REFRESH_TOKEN trong env");
  }

  const res = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`LWA token fail ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

function hostForRegion(): string {
  const r = (process.env.AMAZON_SP_API_REGION ?? "NA").toUpperCase();
  switch (r) {
    case "NA": return "sellingpartnerapi-na.amazon.com";
    case "EU": return "sellingpartnerapi-eu.amazon.com";
    case "FE": return "sellingpartnerapi-fe.amazon.com";
    default:   return "sellingpartnerapi-na.amazon.com";
  }
}

export async function spapi<T = unknown>(
  method: Method,
  path: string,
  opts?: {
    body?: unknown;
    query?: Record<string, string | number | undefined>;
    headers?: Record<string, string>;
  },
): Promise<{ status: number; data: T; raw: string }> {
  const accessToken = await getAccessToken();
  const host = hostForRegion();
  const url = new URL(`https://${host}${path}`);
  if (opts?.query) {
    Object.entries(opts.query).forEach(([k, v]) => {
      if (v !== undefined) url.searchParams.set(k, String(v));
    });
  }
  const bodyStr = opts?.body !== undefined ? JSON.stringify(opts.body) : undefined;
  const res = await fetch(url.toString(), {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-amz-access-token": accessToken,
      "User-Agent": "VEXIM-Ops/1.0 (Language=Next.js; Platform=Vercel)",
      ...(opts?.headers ?? {}),
    },
    body: bodyStr,
    cache: "no-store",
  });
  const raw = await res.text();
  let data: T;
  try { data = JSON.parse(raw) as T; } catch { data = raw as unknown as T; }
  return { status: res.status, data, raw };
}

/** Kiểm tra xem SP-API đã được cấu hình đầy đủ chưa (dùng cho UI hiển thị trạng thái) */
export function getSpApiConfig(): { region: string; configured: boolean } {
  const region = (process.env.AMAZON_SP_API_REGION ?? "NA").toUpperCase();
  const configured = !!(
    process.env.AMAZON_LWA_CLIENT_ID &&
    process.env.AMAZON_LWA_CLIENT_SECRET &&
    process.env.AMAZON_LWA_REFRESH_TOKEN
  );
  return { region, configured };
}
