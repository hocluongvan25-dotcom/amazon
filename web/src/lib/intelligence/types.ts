/**
 * Module 8 G2 — hợp đồng tầng cung cấp dữ liệu thị trường.
 *
 * Mọi method trả về JSON THÔ theo shape Rainforest; parser chuẩn hoá nằm ở
 * `lib/research/domain/collection.ts` để test được không cần mạng.
 * Implement: mock-intelligence.ts (deterministic, mặc định ở demo) và
 * rainforest/client.ts (REST thật, server-only, thiếu key → ném lỗi rõ ràng).
 */

export type IntelligenceName = "rainforest" | "mock";

export type SearchRequest = {
  keyword: string;
  /** amazon.com | amazon.co.uk … (mặc định amazon.com) */
  amazonDomain?: string;
  page?: number;
  /** mặc định false: lấy cả sponsored để G3 tách/đếm CR3 thị phần quảng cáo */
  excludeSponsored?: boolean;
};

export type ReviewsRequest = {
  asin: string;
  amazonDomain?: string;
  /** mặc định all_critical (1–3★) */
  reviewStars?: "all_critical" | "all" | "one_star" | "two_star" | "three_star";
  page?: number;
  maxPages?: number;
};

export type SalesEstimateRequest = {
  asin?: string;
  /** dự phòng khi chưa có ASIN: ước theo BSR + category node */
  bsrRank?: number;
  categoryNode?: string;
  amazonDomain?: string;
};

/**
 * Collection (Rainforest Collections API): gom nhiều request vào 1 lần
 * chạy bất đồng bộ, trả collection id để webhook/ poll nhận kết quả.
 */
export type CollectionEntry = {
  type: "product" | "offers" | "sales_estimation" | "reviews";
  asin?: string;
  [key: string]: unknown;
};

export type CreateCollectionResult = {
  collectionId: string;
  credits: number;
};

export interface IntelligenceProvider {
  readonly name: IntelligenceName;
  /** search (SERP) 1 trang */
  search(req: SearchRequest): Promise<unknown>;
  /** product details (BSR, variations, dims) */
  product(asin: string, amazonDomain?: string): Promise<unknown>;
  /** offers (buybox seller, 1P) */
  offers(asin: string, amazonDomain?: string): Promise<unknown>;
  /** sales estimation */
  salesEstimate(req: SalesEstimateRequest): Promise<unknown>;
  /** reviews (mặc định critical 1–3★, phân trang) */
  reviews(req: ReviewsRequest): Promise<unknown>;
  /** tạo Collection bất đồng bộ cho loạt ASIN */
  createCollection(entries: CollectionEntry[]): Promise<CreateCollectionResult>;
  /** kết quả 1 collection (id trả về từ createCollection) */
  getCollection(collectionId: string): Promise<unknown>;
}

export class IntelligenceNotConfiguredError extends Error {
  constructor() {
    super(
      "Chưa cấu hình RAINFOREST_API_KEY — job thu thập phải trả 'skipped', " +
        "không được làm đỏ dashboard. Xem docs/ke-hoach-module-8-tham-dinh-rnd-san-pham.md mục 5.3.",
    );
    this.name = "IntelligenceNotConfiguredError";
  }
}
