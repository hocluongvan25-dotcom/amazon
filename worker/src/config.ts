/**
 * Cấu hình worker — đúng kiến trúc adapter Mock → Sandbox → Production.
 *
 * production : có LWA credentials + Supabase  → gọi SP-API thật
 * sandbox    : có LWA sandbox                 → gọi host sandbox của SP-API
 * mock       : chưa có gì                     → toàn bộ dữ liệu giả (test/UI dev)
 */
export type DataMode = "mock" | "sandbox" | "production";

export type WorkerConfig = {
  mode: DataMode;
  lwa: { clientId: string; clientSecret: string; refreshToken?: string } | null;
  supabase: { url: string; serviceRoleKey: string } | null;
  /** Host SP-API theo vùng (NA/EU/FE) */
  spApiHost: string;
};

const NA_HOST = "https://sellingpartnerapi-na.amazon.com";
const NA_SANDBOX_HOST = "https://sandbox.sellingpartnerapi-na.amazon.com";

export function loadConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  const clientId = env.SPAPI_LWA_CLIENT_ID;
  const clientSecret = env.SPAPI_LWA_CLIENT_SECRET;
  const refreshToken = env.SPAPI_LWA_REFRESH_TOKEN;
  const sbUrl = env.NEXT_PUBLIC_SUPABASE_URL ?? env.SUPABASE_URL;
  const sbKey = env.SUPABASE_SERVICE_ROLE_KEY;

  const hasProd = !!(clientId && clientSecret && sbUrl && sbKey);
  const hasSandbox = !!(clientId && clientSecret);

  return {
    mode: hasProd ? "production" : hasSandbox ? "sandbox" : "mock",
    lwa: clientId && clientSecret ? { clientId, clientSecret, refreshToken } : null,
    supabase: sbUrl && sbKey ? { url: sbUrl, serviceRoleKey: sbKey } : null,
    spApiHost: hasProd ? NA_HOST : NA_SANDBOX_HOST,
  };
}
