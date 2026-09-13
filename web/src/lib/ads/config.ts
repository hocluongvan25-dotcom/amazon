/**
 * Cấu hình Amazon Ads API (Module 5) — đọc từ env, báo thẳng thiếu gì.
 *
 * Ads API dùng BỘ ỨNG DỤNG LWA RIÊNG, không dùng chung credential với SP-API:
 *   AMAZON_ADS_CLIENT_ID / AMAZON_ADS_CLIENT_SECRET   (Security profile, loại Web app)
 *   AMAZON_ADS_REFRESH_TOKEN                          (đã có sẵn → bootstrap vào shop)
 *   AMAZON_ADS_REGION                                 (NA | EU | FE → quyết định host)
 *
 * Host PHẢI khớp vùng của profileId: profile của marketplace EU mà gọi host NA thì
 * Amazon trả 401/403 chứ không "tự chuyển vùng".
 */
import { loadOAuthConfig } from "../oauth/config.ts";
import { asAmazonRegion, type AmazonRegion } from "../oauth/lwa.ts";

export const ADS_HOSTS: Record<AmazonRegion, string> = {
  NA: "https://advertising-api.amazon.com",
  EU: "https://advertising-api-eu.amazon.com",
  FE: "https://advertising-api-fe.amazon.com",
};

/**
 * Media type theo từng operation. Sai media type là Amazon trả 415/400 chứ không
 * "hiểu hộ" — nên đặt tập trung một chỗ, không rải rác trong client.
 */
export const ADS_MEDIA = {
  createReport: "application/vnd.createasyncreportrequest.v3+json",
  report: "application/vnd.createasyncreportrequest.v3+json",
  spCampaign: "application/vnd.spCampaign.v3+json",
  json: "application/json",
} as const;

/** Số ngày tối đa Amazon cho phép trong MỘT lần xin report v3. */
export const ADS_REPORT_MAX_DAYS = 31;

/** Retention (số ngày còn kéo lại được) theo loại report — quá là mất dữ liệu. */
export const ADS_REPORT_RETENTION_DAYS: Record<string, number> = {
  spCampaigns: 95,
  spAdvertisedProduct: 95,
  spTargeting: 95,
  spSearchTerm: 65,
};

export type AdsRuntimeConfig = {
  region: AmazonRegion;
  host: string;
  clientId: string | null;
  clientSecret: string | null;
  scope: string;
  /** Khoá giải mã refresh token trong DB (AES-256-GCM). */
  tokenKey: string | null;
  supabase: { url: string; serviceRoleKey: string } | null;
  /** Refresh token Ads có sẵn trong env — dùng khi shop chưa có token trong DB. */
  envRefreshToken: string | null;
  /** Header Amazon-Ads-AccountId (chỉ cần khi báo cáo xuyên tài khoản). */
  accountId: string | null;
  /** Gợi ý chọn profile: mã quốc gia của shop (US/UK/DE…) — null thì tự suy từ marketplace. */
  countryCodeHint: string | null;
  /** seller | vendor | author — VEXIM là seller. */
  profileTypeHint: string;
  /** Cửa sổ attribution: seller dùng 7d, vendor/author dùng 14d. */
  attributionDays: 7 | 14 | 30;
  /** Số ngày kéo mỗi lần chạy (tối đa 31). */
  reportDays: number;
  ready: boolean;
  problems: string[];
};

function pickInt(env: Record<string, string | undefined>, key: string, fallback: number, max?: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return max ? Math.min(Math.floor(n), max) : Math.floor(n);
}

function pickAttribution(env: Record<string, string | undefined>): 7 | 14 | 30 {
  const n = Number(env.AMAZON_ADS_ATTRIBUTION_DAYS ?? "7");
  return n === 14 || n === 30 ? n : 7;
}

export function adsHostForRegion(region: AmazonRegion, override?: string | null): string {
  const o = (override ?? "").trim().replace(/\/+$/, "");
  if (o) return o;
  return ADS_HOSTS[region] ?? ADS_HOSTS.NA;
}

export function loadAdsConfig(env: Record<string, string | undefined> = process.env): AdsRuntimeConfig {
  // Dùng chung bộ đọc env với OAuth để KHÔNG có hai nguồn sự thật về credential.
  const oauth = loadOAuthConfig(env);
  const ads = oauth.services.ads;
  const region = asAmazonRegion(env.AMAZON_ADS_REGION ?? ads?.region ?? "NA", "NA");
  const problems: string[] = [];

  if (!ads) {
    problems.push(
      "Chưa đủ credential Amazon Ads API: cần AMAZON_ADS_CLIENT_ID + AMAZON_ADS_CLIENT_SECRET " +
        "(advertising.amazon.com → Developer Console → Security profile, chọn loại Web app).",
    );
  }
  if (!oauth.tokenKey) {
    problems.push(
      "Chưa đặt OAUTH_TOKEN_ENC_KEY → không giải mã được refresh token trong DB. " +
        'Sinh khoá: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  if (!oauth.supabase) {
    problems.push(
      "Chưa đặt NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY → không đọc/ghi được " +
        "token và dữ liệu Ads (worker cần service role vì bảng token cấm client).",
    );
  }
  if (ads && !ads.envRefreshToken) {
    problems.push(
      "Chưa có AMAZON_ADS_REFRESH_TOKEN trong env — không sao NẾU mỗi shop đã authorize qua " +
        "/module0/connect (token nằm trong DB). Nếu chưa shop nào authorize thì sync sẽ bỏ qua shop đó.",
    );
  }

  return {
    region,
    host: adsHostForRegion(region, env.AMAZON_ADS_BASE_URL),
    clientId: ads?.clientId ?? null,
    clientSecret: ads?.clientSecret ?? null,
    scope: ads?.scope ?? "ads::campaign_management",
    tokenKey: oauth.tokenKey,
    supabase: oauth.supabase,
    envRefreshToken: ads?.envRefreshToken ?? null,
    accountId: (env.AMAZON_ADS_ACCOUNT_ID ?? "").trim() || null,
    countryCodeHint: (env.AMAZON_ADS_COUNTRY ?? "").trim().toUpperCase() || null,
    profileTypeHint: (env.AMAZON_ADS_PROFILE_TYPE ?? "seller").trim().toLowerCase() || "seller",
    attributionDays: pickAttribution(env),
    reportDays: pickInt(env, "AMAZON_ADS_REPORT_DAYS", 7, ADS_REPORT_MAX_DAYS),
    // "ready" = gọi được Amazon VÀ lưu được kết quả. Thiếu token env KHÔNG làm
    // config bất sẵn (token có thể nằm trong DB theo từng shop).
    ready: !!ads && !!oauth.tokenKey && !!oauth.supabase,
    problems,
  };
}
