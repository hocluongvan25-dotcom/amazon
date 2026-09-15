/**
 * Module 8 G2 — client Rainforest API (REST, server-only).
 *
 * Tài liệu: https://www.rainforestapi.com/docs
 *   • Request endpoint: GET /request?type=search|product|offers|sales_estimation|reviews
 *   • Collections: PUT /collections/{id} (gộp ≤1.000 request, chạy bất đồng bộ),
 *     kết quả lấy qua GET /collections/{id}/results, webhook báo xong.
 *
 * CHỈ gọi từ job/cron server-side, KHÔNG gọi trong request UI (gọi 30–50s).
 * Thiếu RAINFOREST_API_KEY → ném IntelligenceNotConfiguredError để job trả
 * 'skipped' thay vì làm đỏ dashboard.
 */

import type {
  CollectionEntry,
  CreateCollectionResult,
  IntelligenceProvider,
  ReviewsRequest,
  SalesEstimateRequest,
  SearchRequest,
} from "../types.ts";
import { IntelligenceNotConfiguredError } from "../types.ts";

const BASE = "https://api.rainforestapi.com";

export type RainforestClientOptions = {
  apiKey: string;
  webhookSecret?: string;
  /** base URL webhook Collections khi triển khai (tuyệt đối, công khai) */
  webhookBaseUrl?: string;
  fetchFn?: typeof fetch;
  /** số retry khi 429/5xx (mặc định 2) */
  maxRetries?: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RainforestClient implements IntelligenceProvider {
  readonly name = "rainforest" as const;
  private readonly apiKey: string;
  private readonly webhookSecret: string | undefined;
  private readonly webhookBaseUrl: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly maxRetries: number;

  constructor(opts: RainforestClientOptions) {
    if (!opts.apiKey) throw new IntelligenceNotConfiguredError();
    this.apiKey = opts.apiKey;
    this.webhookSecret = opts.webhookSecret;
    this.webhookBaseUrl = opts.webhookBaseUrl;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.maxRetries = opts.maxRetries ?? 2;
  }

  private async request(params: Record<string, string | number | undefined>): Promise<unknown> {
    const qs = new URLSearchParams({ api_key: this.apiKey, output: "json" });
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    }
    const url = `${BASE}/request?${qs.toString()}`;
    let attempt = 0;
    let lastErr: Error | null = null;
    while (attempt <= this.maxRetries) {
      const res = await this.fetchFn(url, { method: "GET" });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Rainforest HTTP ${res.status}`);
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 800 * 2 ** attempt);
        attempt++;
        continue;
      }
      const json = (await res.json()) as { request_info?: { success?: boolean; message?: string } };
      if (!res.ok || json.request_info?.success === false) {
        throw new Error(`Rainforest lỗi HTTP ${res.status}: ${json.request_info?.message ?? res.statusText}`);
      }
      return json;
    }
    throw lastErr ?? new Error("Rainforest request thất bại không rõ lý do");
  }

  async search(req: SearchRequest): Promise<unknown> {
    return this.request({
      type: "search",
      amazon_domain: req.amazonDomain ?? "amazon.com",
      search_term: req.keyword,
      page: req.page ?? 1,
      exclude_sponsored: req.excludeSponsored ? "true" : undefined,
    });
  }

  async product(asin: string, amazonDomain = "amazon.com"): Promise<unknown> {
    return this.request({ type: "product", amazon_domain: amazonDomain, asin });
  }

  async offers(asin: string, amazonDomain = "amazon.com"): Promise<unknown> {
    return this.request({ type: "offers", amazon_domain: amazonDomain, asin });
  }

  async salesEstimate(req: SalesEstimateRequest): Promise<unknown> {
    return this.request({
      type: "sales_estimation",
      amazon_domain: req.amazonDomain ?? "amazon.com",
      asin: req.asin,
      bsr_rank: req.bsrRank,
      category_node: req.categoryNode,
    });
  }

  async reviews(req: ReviewsRequest): Promise<unknown> {
    return this.request({
      type: "reviews",
      amazon_domain: req.amazonDomain ?? "amazon.com",
      asin: req.asin,
      review_stars: req.reviewStars ?? "all_critical",
      page: req.page ?? 1,
    });
  }

  /**
   * Tạo Collection (PUT idempotent theo collection id client tự đặt).
   * Giới hạn: ≤1.000 request/collection; tạo TUẦN TỰ (Rainforest trả 429 nếu
   * tạo song song ở gói thấp).
   */
  async createCollection(entries: CollectionEntry[]): Promise<CreateCollectionResult> {
    if (entries.length > 1000) {
      throw new Error("Collection tối đa 1.000 request — hãy chia nhỏ đợt thu thập");
    }
    const id = `vexim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const body: Record<string, unknown> = {
      requests: entries.map((e) => ({
        amazon_domain: "amazon.com",
        ...e,
      })),
    };
    if (this.webhookSecret && this.webhookBaseUrl) {
      body.notification_webhook_url = `${this.webhookBaseUrl}/api/webhooks/rainforest?secret=${this.webhookSecret}`;
    }
    const res = await this.fetchFn(`${BASE}/collections/${encodeURIComponent(id)}?api_key=${this.apiKey}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { collection?: { id?: string }; request_info?: { credits_used?: number; success?: boolean; message?: string } };
    if (!res.ok || json.request_info?.success === false) {
      throw new Error(`Rainforest collection lỗi HTTP ${res.status}: ${json.request_info?.message ?? res.statusText}`);
    }
    return {
      collectionId: json.collection?.id ?? id,
      credits: json.request_info?.credits_used ?? entries.length,
    };
  }

  async getCollection(collectionId: string): Promise<unknown> {
    const res = await this.fetchFn(
      `${BASE}/collections/${encodeURIComponent(collectionId)}/results?api_key=${this.apiKey}&output=json`,
      { method: "GET" },
    );
    if (!res.ok) throw new Error(`Rainforest get collection HTTP ${res.status}`);
    return res.json();
  }
}
