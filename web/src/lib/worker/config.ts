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
 *   NEXT_PUBLIC_SUPABASE_URL (hoặc SUPABASE_URL)
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
  supabase: {
    url: string;
    serviceRoleKey: string;
  } | null;
  spApiHost: string;
  leadDaysDefault: number;
  safetyDaysDefault: number;
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
  const clientId = env.AMAZON_LWA_CLIENT_ID ?? env.SPAPI_LWA_CLIENT_ID;
  const clientSecret = env.AMAZON_LWA_CLIENT_SECRET ?? env.SPAPI_LWA_CLIENT_SECRET;
  const refreshToken = env.AMAZON_LWA_REFRESH_TOKEN ?? env.SPAPI_LWA_REFRESH_TOKEN;
  const sbUrl = env.NEXT_PUBLIC_SUPABASE_URL ?? env.SUPABASE_URL;
  const sbKey = env.SUPABASE_SERVICE_ROLE_KEY;

  const region = (env.AMAZON_SP_API_REGION ?? "NA").toUpperCase();
  const hasProd = !!(clientId && clientSecret && refreshToken && sbUrl && sbKey);
  const hasSandbox = !!(clientId && clientSecret);

  return {
    mode: hasProd ? "production" : hasSandbox ? "sandbox" : "mock",
    lwa: clientId && clientSecret ? { clientId, clientSecret, refreshToken } : null,
    supabase: sbUrl && sbKey ? { url: sbUrl, serviceRoleKey: sbKey } : null,
    spApiHost: hasProd ? HOSTS[region] ?? HOSTS.NA : HOSTS.NA_SANDBOX,
    leadDaysDefault: Number(env.VEXIM_LEAD_DAYS ?? "32"),
    safetyDaysDefault: Number(env.VEXIM_SAFETY_DAYS ?? "14"),
  };
}
