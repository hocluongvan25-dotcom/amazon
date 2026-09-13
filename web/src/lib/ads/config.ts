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
  // ---- Module 5 Phần 2&3 (chiều GHI) ---------------------------------------
  // Mỗi operation một media type RIÊNG: gửi sai là Amazon trả 415/400 chứ không
  // "tự hiểu". Đối chiếu 3 nguồn độc lập (manifest Airbyte source-amazon-ads sinh
  // từ spec Amazon · 2 client production · withone.ai/Postman) ngày 13/09/2026.
  spKeyword: "application/vnd.spKeyword.v3+json",
  spNegativeKeyword: "application/vnd.spNegativeKeyword.v3+json",
  spCampaignNegativeKeyword: "application/vnd.spCampaignNegativeKeyword.v3+json",
  spAdGroup: "application/vnd.spAdGroup.v3+json",
  spProductAd: "application/vnd.spProductAd.v3+json",
  spTargetingClause: "application/vnd.spTargetingClause.v3+json",
  spNegativeTargetingClause: "application/vnd.spNegativeTargetingClause.v3+json",
  spCampaignNegativeTargetingClause: "application/vnd.spCampaignNegativeTargetingClause.v3+json",
} as const;

/**
 * Trần số thực thể trong MỘT lần gọi ghi của SP v3 (Amazon trả 207 Multi-Status
 * theo lô; gửi quá trần là 400 cả lô).
 */
export const ADS_WRITE_BATCH_SIZE = 100;

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
  /**
   * Module 5 Phần 2&3 — công tắc CHIỀU GHI. Mặc định TẮT: cron ads-apply chỉ báo
   * cáo, không gọi PUT/POST lên Amazon. Bật bằng ADS_WRITE_ENABLED=1 khi đã duyệt
   * thử trên một shop và chấp nhận rằng thay đổi sẽ lên tài khoản quảng cáo thật.
   */
  writeEnabled: boolean;
  /** Số đề xuất tối đa mỗi lượt áp dụng (trần thứ hai, sau daily_change_cap của DB). */
  writeBatchLimit: number;
  /** Phút một lô "đang áp dụng" bị coi là kẹt (cron trước chết giữa chừng). */
  writeStaleMinutes: number;
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

/**
 * Lịch cron ads-apply (giờ UTC) — PHẢI khớp vercel.json.
 * tests/ppc-write.test.ts đọc vercel.json và so trực tiếp với hằng này, nên đổi một
 * chỗ mà quên chỗ kia là test đỏ ngay.
 *
 * Vì sao daily lúc 04:20 chứ không phải mỗi 15 phút: (a) nhất quán với 4 cron sẵn có
 * đều chạy 1 lần/ngày; (b) chạy SAU ads-sync 04:00 để số liệu vừa nhập được dùng cho
 * verify; (c) Vercel Hobby giới hạn số cron job và tần suất tối thiểu 1 lần/ngày.
 * Plan Pro có thể nâng lên mỗi 15 phút để đề xuất đã duyệt được áp dụng gần realtime —
 * khi đó sửa cả hai chỗ (test sẽ báo nếu lệch).
 */
export const ADS_APPLY_CRON = "20 4 * * *";

/** ADS_WRITE_ENABLED=1|true|yes|on → bật chiều ghi (mặc định TẮT). */
export function adsWriteEnabled(env: Record<string, string | undefined>): boolean {
  return ["1", "true", "yes", "on"].includes(String(env.ADS_WRITE_ENABLED ?? "").trim().toLowerCase());
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
    writeEnabled: adsWriteEnabled(env),
    writeBatchLimit: pickInt(env, "ADS_WRITE_BATCH_LIMIT", 100, 500),
    writeStaleMinutes: pickInt(env, "ADS_WRITE_STALE_MINUTES", 30, 720),
    // "ready" = gọi được Amazon VÀ lưu được kết quả. Thiếu token env KHÔNG làm
    // config bất sẵn (token có thể nằm trong DB theo từng shop).
    ready: !!ads && !!oauth.tokenKey && !!oauth.supabase,
    problems,
  };
}
