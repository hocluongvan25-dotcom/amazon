/**
 * Cấu hình OAuth (Module 0) — đọc từ env, KHÔNG bao giờ hardcode secret.
 *
 * Biến môi trường (đã có trong web/.env.local.example):
 *   APP_BASE_URL / OAUTH_REDIRECT_URI   — redirect_uri phải khớp TUYỆT ĐỐI với
 *                                         giá trị đã khai trong app Amazon.
 *   OAUTH_TOKEN_ENC_KEY                 — khoá AES-256-GCM mã hoá refresh token.
 *   OAUTH_STATE_SECRET                  — khoá HMAC ký `state` (fallback CRON_SECRET).
 *   AMAZON_LWA_CLIENT_ID / _SECRET      — app SP-API (+ AMAZON_SP_API_APPLICATION_ID).
 *   AMAZON_ADS_CLIENT_ID / _SECRET      — security profile Ads API (KHÁC bộ SP-API!).
 *   AMAZON_ADS_REFRESH_TOKEN            — token Ads đã có sẵn → route import bootstrap.
 *   AMAZON_SP_API_REGION / AMAZON_ADS_REGION — NA|EU|FE (endpoint đổi theo vùng).
 *   NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY — ghi token qua RPC 0020.
 *
 * Nguyên tắc: thiếu biến thì TRẢ VỀ `ready:false` + danh sách `missing` để UI/cron
 * nói thẳng "thiếu gì, lấy ở đâu" — không im lặng rồi fail giữa luồng authorize
 * (chủ shop bấm 3 lần mới biết là mình chưa cài env thì sẽ bỏ luôn).
 */
import { asAmazonRegion, type AmazonRegion } from "./lwa.ts";
import type { OAuthService } from "./state.ts";

export type OAuthServiceConfig = {
  service: OAuthService;
  clientId: string;
  clientSecret: string;
  region: AmazonRegion;
  /** amzn1.sp.solution.… — chỉ SP-API, để dùng trang consent của Seller Central. */
  applicationId?: string;
  /** Ghi đè token endpoint (hiếm khi cần; mặc định theo region). */
  tokenUrl?: string;
  /** Refresh token có sẵn trong env → route import bootstrap vào DB. */
  envRefreshToken?: string;
  scope: string;
  ready: boolean;
  missing: string[];
};

export type OAuthConfig = {
  baseUrl: string;
  redirectUri: string;
  tokenKey: string | null;
  stateSecret: string | null;
  supabase: { url: string; serviceRoleKey: string } | null;
  services: Record<OAuthService, OAuthServiceConfig | null>;
  /** Thiếu gì, lấy ở đâu — in thẳng ra UI/cron log. */
  problems: string[];
};

export const DEFAULT_REDIRECT_PATH = "/api/amazon/oauth/callback";

function trim(value: string | undefined): string | undefined {
  const v = (value ?? "").trim();
  return v || undefined;
}

export function resolveBaseUrl(env: Record<string, string | undefined>): string {
  const explicit = trim(env.APP_BASE_URL) ?? trim(env.NEXT_PUBLIC_APP_URL);
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = trim(env.VERCEL_PROJECT_PRODUCTION_URL);
  if (vercel) return `https://${vercel}`.replace(/\/+$/, "");
  const port = trim(env.PORT) ?? "3000";
  return `http://localhost:${port}`;
}

export function resolveRedirectUri(env: Record<string, string | undefined>): string {
  const explicit = trim(env.OAUTH_REDIRECT_URI) ?? trim(env.NEXT_PUBLIC_OAUTH_REDIRECT_URI);
  if (explicit) return explicit;
  return `${resolveBaseUrl(env)}${DEFAULT_REDIRECT_PATH}`;
}

function serviceConfig(
  service: OAuthService,
  env: Record<string, string | undefined>,
): OAuthServiceConfig | null {
  if (service === "ads") {
    const clientId = trim(env.AMAZON_ADS_CLIENT_ID);
    const clientSecret = trim(env.AMAZON_ADS_CLIENT_SECRET);
    const missing: string[] = [];
    if (!clientId) missing.push("AMAZON_ADS_CLIENT_ID");
    if (!clientSecret) missing.push("AMAZON_ADS_CLIENT_SECRET");
    if (!clientId || !clientSecret) {
      // Chưa có credential Ads vẫn trả về null — route sẽ báo "chưa cấu hình"
      // thay vì gọi Amazon bằng client_id rỗng và nhận 400 khó hiểu.
      void missing;
      return null;
    }
    return {
      service,
      clientId,
      clientSecret,
      region: asAmazonRegion(env.AMAZON_ADS_REGION ?? env.AMAZON_SP_API_REGION),
      tokenUrl: trim(env.AMAZON_ADS_TOKEN_URL),
      envRefreshToken: trim(env.AMAZON_ADS_REFRESH_TOKEN),
      scope: "ads::campaign_management",
      ready: true,
      missing,
    };
  }

  const clientId = trim(env.AMAZON_LWA_CLIENT_ID) ?? trim(env.SPAPI_LWA_CLIENT_ID);
  const clientSecret = trim(env.AMAZON_LWA_CLIENT_SECRET) ?? trim(env.SPAPI_LWA_CLIENT_SECRET);
  if (!clientId || !clientSecret) return null;
  return {
    service,
    clientId,
    clientSecret,
    region: asAmazonRegion(env.AMAZON_SP_API_REGION),
    applicationId: trim(env.AMAZON_SP_API_APPLICATION_ID) ?? trim(env.AMAZON_APP_ID),
    tokenUrl: trim(env.AMAZON_LWA_TOKEN_URL),
    envRefreshToken: trim(env.AMAZON_LWA_REFRESH_TOKEN) ?? trim(env.SPAPI_LWA_REFRESH_TOKEN),
    scope: "sellingpartnerapi::all",
    ready: true,
    missing: [],
  };
}

export function loadOAuthConfig(env: Record<string, string | undefined> = process.env): OAuthConfig {
  const baseUrl = resolveBaseUrl(env);
  const redirectUri = resolveRedirectUri(env);
  const tokenKey = trim(env.OAUTH_TOKEN_ENC_KEY) ?? null;
  const stateSecret = trim(env.OAUTH_STATE_SECRET) ?? trim(env.CRON_SECRET) ?? null;
  const supabaseUrl = trim(env.NEXT_PUBLIC_SUPABASE_URL) ?? trim(env.SUPABASE_URL) ?? null;
  const supabaseKey = trim(env.SUPABASE_SERVICE_ROLE_KEY) ?? null;

  const problems: string[] = [];
  if (!tokenKey) {
    problems.push(
      "OAUTH_TOKEN_ENC_KEY chưa có → KHÔNG lưu được refresh token (RPC 0020 từ chối plaintext). " +
        'Sinh khoá: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  if (!stateSecret) {
    problems.push("OAUTH_STATE_SECRET chưa có → không ký được `state` (chống CSRF). Có thể dùng lại CRON_SECRET.");
  }
  if (!supabaseUrl || !supabaseKey) {
    problems.push("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY chưa đủ → không ghi được token xuống DB.");
  }
  if (!env.AMAZON_ADS_CLIENT_ID) {
    problems.push(
      "AMAZON_ADS_CLIENT_ID/SECRET chưa có → chưa authorize Ads qua link được. " +
        "Nếu ĐÃ có refresh token Ads thì chỉ cần AMAZON_ADS_REFRESH_TOKEN rồi gọi /api/amazon/oauth/import?service=ads&source=env.",
    );
  }
  if (!env.AMAZON_LWA_CLIENT_ID) {
    problems.push("AMAZON_LWA_CLIENT_ID/SECRET chưa có → chưa authorize SP-API qua link được.");
  }

  return {
    baseUrl,
    redirectUri,
    tokenKey,
    stateSecret,
    supabase: supabaseUrl && supabaseKey ? { url: supabaseUrl, serviceRoleKey: supabaseKey } : null,
    services: {
      spapi: serviceConfig("spapi", env),
      ads: serviceConfig("ads", env),
    },
    problems,
  };
}

/** Convenience cho route/cron: trả config hoặc ném lỗi kèm đúng thứ đang thiếu. */
export function requireOAuthConfig(env: Record<string, string | undefined> = process.env): OAuthConfig {
  const config = loadOAuthConfig(env);
  if (!config.tokenKey || !config.stateSecret || !config.supabase) {
    throw new Error(`OAuth chưa cấu hình đủ: ${config.problems.join(" · ")}`);
  }
  return config;
}
