/**
 * Cấu hình worker — đúng kiến trúc adapter Mock → Sandbox → Production.
 *
 * production : có LWA credentials + Supabase  → gọi SP-API thật, ghi DB thật
 * sandbox    : có LWA sandbox credentials     → gọi sandbox SP-API, ghi mock
 * mock       : chưa có credentials           → dữ liệu giả (test/UI dev)
 *
 * Environment variables (đồng bộ với web/.env.local.example để một file .env.local
 * dùng được cho cả web và worker):
 *   AMAZON_LWA_CLIENT_ID / AMAZON_LWA_CLIENT_SECRET / AMAZON_LWA_REFRESH_TOKEN
 *   AMAZON_SP_API_REGION (NA/EU/FE, mặc định NA)
 *   AMAZON_ADS_CLIENT_ID / AMAZON_ADS_CLIENT_SECRET / AMAZON_ADS_REFRESH_TOKEN
 *   AMAZON_ADS_REGION (NA/EU/FE) — app Ads là đăng ký riêng, không dùng chung SP-API
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */
export type DataMode = "mock" | "sandbox" | "production";

export type WorkerConfig = {
  mode: DataMode;
  lwa: {
    clientId: string;
    clientSecret: string;
    refreshToken?: string;
  } | null;
  /**
   * Amazon Ads là ĐĂNG KÝ RIÊNG (app riêng + refresh token riêng): biến môi
   * trường của SP-API KHÔNG dùng được cho Ads. Thiếu ADS_* thì phần Ads chạy ở
   * chế độ "chưa cấu hình" và job trả `skipped` kèm hướng dẫn — không ném lỗi.
   */
  ads: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  } | null;
  adsHost: string;
  supabase: {
    url: string;
    serviceRoleKey: string;
  } | null;
  spApiHost: string;
  leadDaysDefault: number;
  safetyDaysDefault: number;
};

/** Host Ads theo vùng — KHÁC host SP-API (xem amazon/ads.ts). */
const ADS_HOSTS: Record<string, string> = {
  NA: "https://advertising-api.amazon.com",
  EU: "https://advertising-api-eu.amazon.com",
  FE: "https://advertising-api-fe.amazon.com",
};

const HOSTS: Record<string, string> = {
  NA: "https://sellingpartnerapi-na.amazon.com",
  EU: "https://sellingpartnerapi-eu.amazon.com",
  FE: "https://sellingpartnerapi-fe.amazon.com",
  NA_SANDBOX: "https://sandbox.sellingpartnerapi-na.amazon.com",
};

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): WorkerConfig {
  // CHỈ đọc bộ biến chính thức (khớp env đã set trên Vercel) — không fallback
  // sang tên biến cũ (SPAPI_LWA_*, ADS_LWA_*, SUPABASE_URL) để tránh lệch cấu hình.
  const clientId = env.AMAZON_LWA_CLIENT_ID;
  const clientSecret = env.AMAZON_LWA_CLIENT_SECRET;
  const refreshToken = env.AMAZON_LWA_REFRESH_TOKEN;
  const sbUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const sbKey = env.SUPABASE_SERVICE_ROLE_KEY;

  const adsClientId = env.AMAZON_ADS_CLIENT_ID;
  const adsClientSecret = env.AMAZON_ADS_CLIENT_SECRET;
  const adsRefreshToken = env.AMAZON_ADS_REFRESH_TOKEN;
  const adsRegion = (env.AMAZON_ADS_REGION ?? env.AMAZON_SP_API_REGION ?? "NA").toUpperCase();

  const region = (env.AMAZON_SP_API_REGION ?? "NA").toUpperCase();
  const hasProd = !!(clientId && clientSecret && refreshToken && sbUrl && sbKey);
  const hasSandbox = !!(clientId && clientSecret);

  return {
    mode: hasProd ? "production" : hasSandbox ? "sandbox" : "mock",
    lwa: clientId && clientSecret ? { clientId, clientSecret, refreshToken } : null,
    supabase: sbUrl && sbKey ? { url: sbUrl, serviceRoleKey: sbKey } : null,
    ads:
      adsClientId && adsClientSecret && adsRefreshToken
        ? { clientId: adsClientId, clientSecret: adsClientSecret, refreshToken: adsRefreshToken }
        : null,
    adsHost: ADS_HOSTS[adsRegion] ?? ADS_HOSTS.NA,
    spApiHost: hasProd ? HOSTS[region] ?? HOSTS.NA : HOSTS.NA_SANDBOX,
    leadDaysDefault: Number(env.VEXIM_LEAD_DAYS ?? "32"),
    safetyDaysDefault: Number(env.VEXIM_SAFETY_DAYS ?? "14"),
  };
}
