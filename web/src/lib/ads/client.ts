/**
 * AdsClient — gọi Amazon Ads API (host theo vùng, header theo đúng tài liệu v3).
 *
 * Header BẮT BUỘC cho mọi call:
 *   Amazon-Ads-ClientId               client_id của ứng dụng LWA (tên mới)
 *   Amazon-Advertising-API-ClientId   tên cũ — gửi cả hai vì tài liệu/SDK lẫn lộn
 *   Authorization: Bearer <access>    access token 1 giờ (AdsTokenManager lo)
 *   Amazon-Advertising-API-Scope      profileId của tài khoản quảng cáo
 *   Amazon-Ads-AccountId              chỉ khi báo cáo xuyên tài khoản (env)
 *
 * Client này KHÔNG tự retry: 429/5xx ném AdsApiError(retryable=true) để tầng trên
 * (cron) quyết định bỏ qua và làm lại ở lần chạy sau. Retry dồn trong cùng một lượt
 * chỉ làm nghẽn hàng đợi tốc độ của cả vùng.
 */
import { ADS_MEDIA } from "./config.ts";
import { AdsApiError, describeAdsFailure } from "./errors.ts";

export type AdsClientOptions = {
  host: string;
  clientId: string;
  /** profileId — bắt buộc cho gần như mọi call trừ GET /v2/profiles. */
  profileId?: string | null;
  /** Amazon-Ads-AccountId (chỉ dùng khi báo cáo xuyên tài khoản). */
  accountId?: string | null;
  /** Lấy access token (cache/refresh do AdsTokenManager lo). */
  getAccessToken: () => Promise<string>;
  fetchFn?: typeof fetch;
};

export type RequestOptions = {
  body?: unknown;
  contentType?: string;
  accept?: string;
  query?: Record<string, string | number | undefined | null>;
  /** true → trả text thô (dùng khi tải file report gzip). */
  raw?: boolean;
};

export type SpCampaignPage = {
  campaigns: Record<string, unknown>[];
  nextToken: string | null;
  totalCount: number | null;
};

export class AdsClient {
  private readonly opts: AdsClientOptions;
  private readonly fetchFn: typeof fetch;

  constructor(opts: AdsClientOptions) {
    this.opts = opts;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  get profileId(): string | null {
    return this.opts.profileId ?? null;
  }

  get host(): string {
    return this.opts.host.replace(/\/+$/, "");
  }

  /** Trả client mới gắn profileId (giữ nguyên token provider) — không mutate. */
  withProfile(profileId: string): AdsClient {
    return new AdsClient({ ...this.opts, profileId });
  }

  headers(contentType?: string, accept?: string): Record<string, string> {
    const h: Record<string, string> = {
      "Amazon-Ads-ClientId": this.opts.clientId,
      "Amazon-Advertising-API-ClientId": this.opts.clientId,
      Accept: accept ?? ADS_MEDIA.json,
    };
    if (this.opts.profileId) h["Amazon-Advertising-API-Scope"] = String(this.opts.profileId);
    if (this.opts.accountId) h["Amazon-Ads-AccountId"] = this.opts.accountId;
    if (contentType) h["Content-Type"] = contentType;
    return h;
  }

  async request<T = unknown>(
    method: "GET" | "POST" | "PUT",
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const url = new URL(`${this.host}${path.startsWith("/") ? path : `/${path}`}`);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
      }
    }

    let accessToken = "";
    try {
      accessToken = await this.opts.getAccessToken();
    } catch (e) {
      // Lỗi token ném lên nguyên văn (AdsTokenError) — cron phân loại riêng.
      throw e;
    }

    const headers = this.headers(opts.contentType, opts.accept);
    headers.Authorization = `Bearer ${accessToken}`;

    let res: Response;
    try {
      res = await this.fetchFn(url.toString(), {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new AdsApiError(
        {
          code: "network",
          status: 0,
          message: `Không gọi được ${method} ${path}: ${msg}`,
          hint: "Kiểm tra mạng/host đúng vùng chưa (NA/EU/FE). Lỗi mạng là retryable — cron lần sau chạy lại.",
          retryable: true,
          retryAfterSec: null,
          badColumns: [],
          raw: null,
        },
        { path, profileId: this.profileId },
      );
    }

    // 207 Multi-Status (chiều GHI SP v3) vẫn là res.ok — trong body có cả
    // success[] lẫn error[]. Tầng ghi tự tách (parseMultiStatus trong write.ts);
    // ở đây chỉ đánh dấu status để log không nhầm "thành công tuyệt đối".
    if (!res.ok) {
      const text = await safeText(res);
      throw new AdsApiError(
        describeAdsFailure(res.status, text, {
          retryAfterHeader: res.headers.get("retry-after"),
          path,
        }),
        { path, profileId: this.profileId },
      );
    }

    if (opts.raw) {
      // Trả ArrayBuffer để tầng report tự gunzip (Amazon nén GZIP, có/không kèm
      // header Content-Encoding — xem reports.ts).
      return (await res.arrayBuffer()) as unknown as T;
    }

    const text = await safeText(res);
    if (!text) return undefined as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AdsApiError(
        {
          code: "bad_response",
          status: res.status,
          message: `Phản hồi ${method} ${path} không phải JSON (HTTP ${res.status}).`,
          hint: "Có thể Amazon trả HTML của trang lỗi/redirect — xem raw để biết đang nhận gì.",
          retryable: false,
          retryAfterSec: null,
          badColumns: [],
          raw: text.slice(0, 500),
        },
        { path, profileId: this.profileId },
      );
    }
  }

  /**
   * GET /v2/profiles — danh sách tài khoản quảng cáo mà token này thấy được.
   * Đây là cách LẤY profileId (không có profileId thì không gọi được gì khác).
   */
  async listProfiles(): Promise<unknown> {
    return this.request<unknown>("GET", "/v2/profiles", { accept: ADS_MEDIA.json });
  }

  /**
   * POST /sp/campaigns/list — campaign SP (metadata: ngân sách, trạng thái, ngày).
   * Phân trang bằng nextToken (v3); một số tài khoản cũ trả totalCount.
   */
  async listSpCampaigns(input: {
    count?: number;
    nextToken?: string | null;
    stateFilter?: string[];
  } = {}): Promise<SpCampaignPage> {
    const body: Record<string, unknown> = { count: input.count ?? 100 };
    if (input.nextToken) body.nextToken = input.nextToken;
    if (input.stateFilter && input.stateFilter.length > 0) body.stateFilter = { include: input.stateFilter };

    const res = await this.request<unknown>("POST", "/sp/campaigns/list", {
      body,
      contentType: ADS_MEDIA.spCampaign,
      accept: ADS_MEDIA.spCampaign,
    });
    return normalizeCampaignPage(res);
  }

  /**
   * Lấy HẾT campaign (lặp nextToken). `maxPages` là chốt chặn: tài khoản lớn +
   * trần tốc độ → thà thiếu và báo rõ còn hơn treo cron.
   */
  async listAllSpCampaigns(input: { stateFilter?: string[]; maxPages?: number } = {}): Promise<{
    campaigns: Record<string, unknown>[];
    pages: number;
    truncated: boolean;
  }> {
    const maxPages = input.maxPages ?? 20;
    const all: Record<string, unknown>[] = [];
    let nextToken: string | null = null;
    let pages = 0;
    do {
      const page = await this.listSpCampaigns({ nextToken, stateFilter: input.stateFilter });
      all.push(...page.campaigns);
      nextToken = page.nextToken;
      pages += 1;
    } while (nextToken && pages < maxPages);
    return { campaigns: all, pages, truncated: !!nextToken };
  }
}

/** Amazon trả {campaigns:[…], nextToken} hoặc (bản cũ) mảng trơn. */
export function normalizeCampaignPage(res: unknown): SpCampaignPage {
  if (Array.isArray(res)) {
    return { campaigns: res as Record<string, unknown>[], nextToken: null, totalCount: res.length };
  }
  const rec = (res ?? {}) as Record<string, unknown>;
  const list = Array.isArray(rec.campaigns) ? (rec.campaigns as Record<string, unknown>[]) : [];
  const next = typeof rec.nextToken === "string" && rec.nextToken !== "" ? rec.nextToken : null;
  const total =
    typeof rec.totalCount === "number"
      ? rec.totalCount
      : typeof rec.totalCount === "string" && Number.isFinite(Number(rec.totalCount))
        ? Number(rec.totalCount)
        : null;
  return { campaigns: list, nextToken: next, totalCount: total };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
