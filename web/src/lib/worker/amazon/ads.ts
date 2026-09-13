/**
 * Client Amazon Ads (Module 5 phần 1) — LWA → /v2/profiles → Campaign
 * Management v3 (`/sp/*`) → Reporting API v3 (`/reporting/reports`).
 *
 * VÌ SAO CÓ FILE NÀY (khác SP-API thế nào):
 *   • Ads là ĐĂNG KÝ RIÊNG: không nằm trong SP-API, host khác
 *     (advertising-api.amazon.com, EU: advertising-api-eu.amazon.com), và
 *     credential (client id/secret + refresh token) là của ứng dụng Ads.
 *   • Mọi request phải có 2 header: `Amazon-Advertising-API-ClientId` và — với
 *     API theo profile — `Amazon-Advertising-API-Scope: <profileId>`.
 *     Thiếu Scope là 400/404 rất khó đoán, nên client tự gắn.
 *   • Reporting v3 là BẤT ĐỒNG BỘ giống SP-API: POST tạo → GET trạng thái →
 *     tải URL (GZIP_JSON). Nhưng content-type của request thì riêng:
 *     `application/vnd.createasyncreportrequest.v3+json`.
 *   • Report v3 CHỈ có DAILY / SUMMARY — KHÔNG có HOURLY (muốn theo giờ phải
 *     dùng Amazon Marketing Stream). Vì vậy đừng ai đó thêm timeUnit: "HOURLY".
 *
 * BA LỖI PHẢI PHÂN BIỆT ĐƯỢC (nếu không job sẽ báo sai):
 *   • 429 / Throttling       → trần tốc độ, lần chạy sau thử lại (`isThrottled`)
 *   • 401 / invalid_grant    → refresh token hết hạn/đổi role ⇒ PHẢI re-authorize
 *     (`isAuthError`) — đúng luồng Module 0, không phải lỗi cấu hình tạm thời.
 *   • còn lại                → lỗi thật, ghi lastError để người xem xử lý.
 *
 * Rate limit & schema: advertising.amazon.com/docs (Reporting v3 · SP Campaign
 * Management v3). Client KHÔNG được coi là "chạy được" chỉ vì compile được —
 * đã có test với fetch giả cho từng nhánh.
 */
import { gunzipText } from "./reports.ts";

const USER_AGENT = "VEXIM-Worker/1.0 (Language=TypeScript; Platform=Vercel)";
const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

/** Vùng Ads — khác SP-API (NA/EU/FE) và có host riêng cho EU/FE. */
export const ADS_HOSTS: Record<string, string> = {
  NA: "https://advertising-api.amazon.com",
  EU: "https://advertising-api-eu.amazon.com",
  FE: "https://advertising-api-fe.amazon.com",
};

export function adsHostForRegion(region: string | null | undefined): string {
  const key = String(region ?? "NA").toUpperCase();
  return ADS_HOSTS[key] ?? ADS_HOSTS.NA;
}

export type AdsErrorShape = { code: string; message: string; status: number };

export class AdsApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: string;

  constructor(err: AdsErrorShape) {
    super(`Ads API ${err.status} ${err.code}: ${err.message}`);
    this.name = "AdsApiRequestError";
    this.status = err.status;
    this.code = err.code;
    this.details = err.message;
  }

  /** Trần tốc độ / hạn mức — KHÔNG phải lỗi cấu hình, lần chạy sau thử lại. */
  get isThrottled(): boolean {
    return this.status === 429 || /throttl|rate.?limit|quota/i.test(this.code + this.details);
  }

  /**
   * Token không còn dùng được (hết hạn 365 ngày, bị thu hồi, hoặc role mới của
   * Ads chưa được cấp quyền) ⇒ shop phải RE-AUTHORIZE ở Module 0 → Kết nối shop.
   */
  get isAuthError(): boolean {
    return (
      this.status === 401 ||
      this.status === 403 ||
      /invalid_grant|invalid_client|unauthorized|access_denied|token/i.test(
        `${this.code} ${this.details ?? ""}`,
      )
    );
  }
}

export type AdsLwaCredentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

/** Access token cache trong bộ nhớ — token endpoint bị Amazon giới hạn tốc độ. */
export class AdsLwaTokenManager {
  private cached: { token: string; expiresAt: number } | null = null;
  constructor(
    private readonly creds: AdsLwaCredentials,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async getAccessToken(force = false): Promise<string> {
    if (!force && this.cached && this.cached.expiresAt > Date.now() + 60_000) {
      return this.cached.token;
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
      refresh_token: this.creds.refreshToken,
    });
    const res = await this.fetchFn(LWA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new AdsApiRequestError({
        status: res.status,
        code: extractCode(text) ?? "LWA_TOKEN_FAILED",
        message: text.slice(0, 300) || res.statusText,
      });
    }
    const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!json.access_token) {
      throw new AdsApiRequestError({
        status: 200,
        code: "LWA_NO_ACCESS_TOKEN",
        message: "LWA không trả access_token",
      });
    }
    this.cached = {
      token: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
    return this.cached.token;
  }
}

/* ============================================================================
 * Kiểu dữ liệu Amazon trả về (giữ nguyên tên trường của Amazon)
 * ==========================================================================*/

export type AdsProfile = {
  profileId: string;
  countryCode: string | null;
  currency: string | null;
  timezone: string | null;
  accountType: string | null;
  accountName: string | null;
  /** marketplaceStringId (ATVPDKIKX0DER…) — dùng để khớp với shop trong DB */
  marketplaceId: string | null;
  managerAccountId: string | null;
};

export type AdsCampaign = {
  campaignId: string;
  name: string | null;
  state: string | null;
  campaignType: string | null;
  targetingType: string | null;
  dailyBudget: number | null;
  budgetCurrency: string | null;
  budgetType: string | null;
  portfolioId: string | null;
  biddingStrategy: string | null;
  startDate: string | null;
  endDate: string | null;
  premiumBidAdjustment: boolean | null;
};

export type AdsAdGroup = {
  adGroupId: string;
  campaignId: string | null;
  name: string | null;
  state: string | null;
  defaultBid: number | null;
};

export type AdsTarget = {
  /** keywordId hoặc targetId — khoá tự nhiên trong DB (`target_key`) */
  targetKey: string;
  targetKind: "keyword" | "product_target";
  campaignId: string | null;
  adGroupId: string | null;
  keywordText: string | null;
  matchType: string | null;
  expressionType: string | null;
  expressionValue: string | null;
  bid: number | null;
  state: string | null;
};

/** Trạng thái report của Ads Reporting v3 (nguyên văn của Amazon). */
export type AdsReportStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";

export type AdsReportInfo = {
  reportId: string;
  status: AdsReportStatus;
  /** chỉ có khi COMPLETED */
  url: string | null;
  failureReason: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type AdsCreateReportRequest = {
  name: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  configuration: {
    adProduct: string; // "SPONSORED_PRODUCTS"
    groupBy: string[]; // ["campaign"] | ["targeting"] | ["searchTerm"] | ["advertiser"]…
    columns: string[];
    reportTypeId: string; // spCampaigns | spTargeting | spSearchTerm | spAdvertisedProduct | spPurchasedProduct
    timeUnit: "DAILY" | "SUMMARY";
    format: "GZIP_JSON" | "CSV";
  };
};

export type AdsClientOptions = {
  host: string;
  clientId: string;
  lwa: AdsLwaTokenManager;
  fetchFn?: typeof fetch;
  /** số lần thử lại khi 429/5xx (mặc định 3) */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
};

export class AdsClient {
  private readonly host: string;
  private readonly clientId: string;
  private readonly lwa: AdsLwaTokenManager;
  private readonly fetchFn: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: AdsClientOptions) {
    this.host = opts.host.replace(/\/$/, "");
    this.clientId = opts.clientId;
    this.lwa = opts.lwa;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // --------------------------------------------------------------------------
  // 1. Profiles API — GET /v2/profiles
  // --------------------------------------------------------------------------
  /**
   * Trả về MỌI profile mà refresh token nhìn thấy. Với shop 1 marketplace
   * thường là 1 dòng; shop US+CA có thể là 2 (NA hợp nhất) — vì vậy DB khoá
   * theo (shop, ads_profile_id) chứ không theo shop.
   */
  async getProfiles(): Promise<AdsProfile[]> {
    const json = await this.request<unknown>("GET", "/v2/profiles");
    const list = Array.isArray(json)
      ? json
      : Array.isArray((json as { profiles?: unknown[] })?.profiles)
        ? ((json as { profiles: unknown[] }).profiles)
        : [];
    return list.map((raw) => normalizeProfile(raw as Record<string, unknown>));
  }

  // --------------------------------------------------------------------------
  // 2. Campaign Management v3 — list endpoints (đọc)
  // --------------------------------------------------------------------------
  async listCampaigns(profileId: string, opts: { maxResults?: number } = {}): Promise<AdsCampaign[]> {
    const body: Record<string, unknown> = {
      maxResults: clampMaxResults(opts.maxResults),
      includeExtendedDataFields: true,
    };
    const items = await this.listAll(profileId, "/sp/campaigns/list", body, ["campaigns", "data", "results"]);
    return items.map((raw) => normalizeCampaign(raw as Record<string, unknown>)).filter((c) => c.campaignId !== "");
  }

  async listAdGroups(profileId: string, opts: { maxResults?: number } = {}): Promise<AdsAdGroup[]> {
    const body: Record<string, unknown> = {
      maxResults: clampMaxResults(opts.maxResults),
      includeExtendedDataFields: true,
    };
    const items = await this.listAll(profileId, "/sp/adGroups/list", body, ["adGroups", "data", "results"]);
    return items.map((raw) => normalizeAdGroup(raw as Record<string, unknown>)).filter((g) => g.adGroupId !== "");
  }

  /**
   * Keywords + product targets gộp về MỘT kiểu `AdsTarget` — vì màn A2 hiển thị
   * chung một bảng "từ khoá / nhóm sản phẩm" và DB khoá theo (ad_group,
   * target_kind, target_key, match_type).
   */
  async listTargets(profileId: string, opts: { maxResults?: number } = {}): Promise<AdsTarget[]> {
    const maxResults = clampMaxResults(opts.maxResults);
    const keywords = await this.listAll(profileId, "/sp/keywords/list",
      { maxResults, includeExtendedDataFields: true }, ["keywords", "data", "results"]);
    const targets = await this.listAll(profileId, "/sp/targets/list",
      { maxResults, includeExtendedDataFields: true }, ["targetingClauses", "targets", "data", "results"]);
    return [
      ...keywords.map((raw) => normalizeKeyword(raw as Record<string, unknown>)),
      ...targets.map((raw) => normalizeProductTarget(raw as Record<string, unknown>)),
    ].filter((t) => t.targetKey !== "");
  }

  // --------------------------------------------------------------------------
  // 3. Reporting v3 — create → poll → tải file
  // --------------------------------------------------------------------------
  async createReport(req: AdsCreateReportRequest): Promise<{ reportId: string }> {
    const json = await this.request<Record<string, unknown>>("POST", "/reporting/reports", req, {
      contentType: "application/vnd.createasyncreportrequest.v3+json",
    });
    const reportId = String(json?.reportId ?? "").trim();
    if (!reportId) {
      throw new Error(
        `createReport(${req.configuration.reportTypeId}): Amazon không trả reportId — ` +
          `phản hồi: ${JSON.stringify(json).slice(0, 200)}`,
      );
    }
    return { reportId };
  }

  async getReport(reportId: string): Promise<AdsReportInfo> {
    const json = await this.request<Record<string, unknown>>(
      "GET",
      `/reporting/reports/${encodeURIComponent(reportId)}`,
    );
    return normalizeReportInfo(json, reportId);
  }

  /** Tải file report (GZIP_JSON) và trả về CHUỖI JSON đã giải nén. */
  async downloadReport(url: string): Promise<{ text: string; gzipped: boolean; bytes: number }> {
    const target = String(url ?? "").trim();
    if (!/^https?:\/\//i.test(target)) {
      throw new Error(`downloadReport: URL không hợp lệ (${target.slice(0, 80)})`);
    }
    const res = await this.fetchFn(target, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) {
      throw new Error(
        `Tải report Ads thất bại HTTP ${res.status} (URL hết hạn? gọi lại getReport).`,
      );
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    // Report v3 tải bằng GZIP; vài report cũ không nén → thử giải, hỏng thì dùng thô.
    try {
      const text = await gunzipText(buf);
      return { text, gzipped: true, bytes: buf.byteLength };
    } catch {
      return { text: new TextDecoder("utf-8").decode(buf), gzipped: false, bytes: buf.byteLength };
    }
  }

  /** getReport + tải file trong một bước — dùng cho job. */
  async fetchReportContent(reportId: string): Promise<{
    info: AdsReportInfo;
    text: string | null;
    gzipped: boolean;
    bytes: number;
  }> {
    const info = await this.getReport(reportId);
    if (info.status !== "COMPLETED") {
      return { info, text: null, gzipped: false, bytes: 0 };
    }
    if (!info.url) {
      throw new Error(
        `Report ${reportId} COMPLETED nhưng Amazon không trả url — không tải được nội dung.`,
      );
    }
    const { text, gzipped, bytes } = await this.downloadReport(info.url);
    return { info, text, gzipped, bytes };
  }

  // --------------------------------------------------------------------------
  // HTTP lõi
  // --------------------------------------------------------------------------
  /** Gọi list endpoint và tự đi hết phân trang (`nextToken`). */
  private async listAll(
    profileId: string,
    path: string,
    body: Record<string, unknown>,
    keys: string[],
  ): Promise<unknown[]> {
    const out: unknown[] = [];
    let nextToken: string | null = null;
    // Trần an toàn: 50 trang × 100 dòng = 5.000 dòng/loại — hơn mức shop 1 người
    // chạy, mà vẫn không thể treo cron vì một nextToken lặp vô hạn.
    for (let page = 0; page < 50; page++) {
      const payload: Record<string, unknown> = { ...body };
      if (nextToken) payload.nextToken = nextToken;
      const json = await this.request<unknown>("POST", path, payload, { profileId });
      const items = pickArray(json, keys);
      out.push(...items);
      nextToken = pickNextToken(json);
      if (!nextToken) break;
    }
    return out;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    opts: { profileId?: string; contentType?: string } = {},
  ): Promise<T> {
    let lastWait = 1000;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const token = await this.lwa.getAccessToken();
      const res = await this.fetchFn(`${this.host}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Amazon-Advertising-API-ClientId": this.clientId,
          ...(opts.profileId ? { "Amazon-Advertising-API-Scope": opts.profileId } : {}),
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          ...(body !== undefined
            ? { "Content-Type": opts.contentType ?? "application/json" }
            : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after") ?? 0);
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : lastWait;
        const text = await safeText(res);
        lastError = new AdsApiRequestError({
          status: res.status,
          code: extractCode(text) ?? (res.status === 429 ? "Throttling" : "ServiceUnavailable"),
          message: text.slice(0, 300),
        });
        if (attempt === this.maxRetries) throw lastError;
        await this.sleep(waitMs);
        lastWait = Math.min(waitMs * 2, 30_000);
        continue;
      }

      if (!res.ok) {
        const text = await safeText(res);
        throw new AdsApiRequestError({
          status: res.status,
          code: extractCode(text) ?? `HTTP_${res.status}`,
          message: text.slice(0, 500) || res.statusText,
        });
      }

      const text = await res.text();
      if (text.trim() === "") return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(
          `Ads API ${path}: phản hồi không phải JSON (${text.slice(0, 120)}…) — ` +
            `kiểm tra lại Content-Type/Accept của request.`,
        );
      }
    }

    throw lastError ?? new Error(`Ads API: vượt số lần retry (${path})`);
  }
}

/* ============================================================================
 * Normalize — Amazon đổi tên trường giữa v2/v3 và giữa các list endpoint,
 * nên đọc theo NHIỀU tên có thể (đã liệt kê) thay vì đoán một tên.
 * ==========================================================================*/

function normalizeProfile(raw: Record<string, unknown>): AdsProfile {
  const info = (raw?.accountInfo ?? {}) as Record<string, unknown>;
  return {
    profileId: String(raw?.profileId ?? "").trim(),
    countryCode: str(raw?.countryCode),
    currency: str(raw?.currency),
    timezone: str(raw?.timezone),
    accountType: str(info?.type),
    accountName: str(info?.name),
    marketplaceId: str(info?.marketplaceStringId),
    managerAccountId: str(raw?.accountId) ?? str(info?.id),
  };
}

function normalizeCampaign(raw: Record<string, unknown>): AdsCampaign {
  // v3 gói ngân sách trong `budget` (v2 để phẳng) — đọc cả hai.
  const budget = (raw?.budget ?? {}) as Record<string, unknown>;
  const bidding = (raw?.bidding ?? {}) as Record<string, unknown>;
  return {
    campaignId: String(raw?.campaignId ?? "").trim(),
    name: str(raw?.name),
    state: str(raw?.state),
    campaignType: str(raw?.campaignType),
    targetingType: str(raw?.targetingType),
    dailyBudget: num(raw?.dailyBudget),
    budgetCurrency: str(budget.budgetCurrency) ?? str(raw?.budgetCurrency),
    budgetType: str(budget.budgetType) ?? str(raw?.budgetType),
    portfolioId: str(raw?.portfolioId),
    biddingStrategy: str(bidding.strategy) ?? str(raw?.biddingStrategy),
    startDate: dateOnly(raw?.startDate),
    endDate: dateOnly(raw?.endDate),
    premiumBidAdjustment: bool(bidding.adjustments != null ? true : raw?.premiumBidAdjustment),
  };
}

function normalizeAdGroup(raw: Record<string, unknown>): AdsAdGroup {
  return {
    adGroupId: String(raw?.adGroupId ?? "").trim(),
    campaignId: str(raw?.campaignId),
    name: str(raw?.name),
    state: str(raw?.state),
    defaultBid: num(raw?.defaultBid),
  };
}

function normalizeKeyword(raw: Record<string, unknown>): AdsTarget {
  return {
    targetKey: String(raw?.keywordId ?? raw?.keyword_id ?? "").trim(),
    targetKind: "keyword",
    campaignId: str(raw?.campaignId),
    adGroupId: str(raw?.adGroupId),
    keywordText: str(raw?.keywordText) ?? str(raw?.keyword),
    matchType: upper(raw?.matchType),
    expressionType: null,
    expressionValue: null,
    bid: num(raw?.bid),
    state: str(raw?.state),
  };
}

function normalizeProductTarget(raw: Record<string, unknown>): AdsTarget {
  const expression = Array.isArray(raw?.expression)
    ? (raw?.expression as Record<string, unknown>[])
    : [];
  const first = expression[0] ?? {};
  return {
    targetKey: String(raw?.targetId ?? raw?.targetingClauseId ?? "").trim(),
    targetKind: "product_target",
    campaignId: str(raw?.campaignId),
    adGroupId: str(raw?.adGroupId),
    keywordText: str(raw?.targetingExpression) ?? null,
    matchType: null,
    expressionType: str(first?.type) ?? str(raw?.expressionType),
    expressionValue: str(first?.value) ?? str(raw?.expressionValue),
    bid: num(raw?.bid),
    state: str(raw?.state),
  };
}

const ADS_REPORT_STATUSES: readonly AdsReportStatus[] = ["PENDING", "PROCESSING", "COMPLETED", "FAILED"];

/**
 * Trạng thái lạ ⇒ coi như PROCESSING để lần sau poll tiếp (không coi là FAILED
 * — bỏ cuộc oan — cũng không coi là COMPLETED — sẽ đi tải URL không có).
 */
export function normalizeReportInfo(
  json: Record<string, unknown> | null | undefined,
  fallbackId = "",
): AdsReportInfo {
  const rawStatus = String(json?.status ?? json?.processingStatus ?? "").toUpperCase();
  const status = (ADS_REPORT_STATUSES as readonly string[]).includes(rawStatus)
    ? (rawStatus as AdsReportStatus)
    : "PROCESSING";
  return {
    reportId: String(json?.reportId ?? fallbackId),
    status,
    url: str(json?.url) ?? str(json?.location),
    failureReason: str(json?.failureReason) ?? str(json?.message),
    createdAt: str(json?.createdAt),
    updatedAt: str(json?.updatedAt),
  };
}

function pickArray(json: unknown, keys: string[]): unknown[] {
  if (Array.isArray(json)) return json;
  const obj = (json ?? {}) as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(obj[key])) return obj[key] as unknown[];
  }
  // Có nextToken mà không có mảng thật ⇒ dừng vòng lặp an toàn (rỗng).
  return [];
}

function pickNextToken(json: unknown): string | null {
  const obj = (json ?? {}) as Record<string, unknown>;
  const token = str(obj.nextToken) ?? str(obj.next_token);
  return token && token !== "" ? token : null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function upper(v: unknown): string | null {
  const s = str(v);
  return s ? s.toUpperCase() : null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function bool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  return null;
}

/** Amazon trả cả "2026-08-01" lẫn ISO đầy đủ — DB chỉ nhận ngày. */
function dateOnly(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function clampMaxResults(n: number | undefined): number {
  const v = Math.round(n ?? 100);
  return Math.min(Math.max(v, 1), 100);
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function extractCode(text: string): string | null {
  const m = text.match(/"(?:code|error)"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}
