/**
 * Client Product Fees API v0 (SP-API) — POST /products/fees/v0/items/{Asin}/feesEstimate
 * (operation getMyFeesEstimateForASIN).
 *
 * VÌ SAO CẦN: số phí CHUẨN duy nhất để G1 khỏi phán ngược so với Revenue
 * Calculator của Amazon (sự cố B074VBLKSL 16/09/2026: ước lượng lệch $2.7/đơn
 * vì referral 15% mặc định ≠ 8% thực tế + phí FBA bảng 2026 ≠ số chuẩn).
 * Xem domain/product-fees.ts cho hợp đồng request/response.
 *
 * Rate limit: 1 rps · burst 2 (Product Fees API Rate Limits). Token bucket giữ
 * nguyên số của Amazon, KHÔNG tự nới.
 */
import { LwaTokenManager } from "./lwa.ts";
import { SpApiRequestError } from "./reports.ts";
import { mapFeesEstimateResponse, type SpApiFeesEstimate } from "../domain/product-fees.ts";

const USER_AGENT = "VEXIM-Worker/1.0 (Language=TypeScript; Platform=Vercel)";

export const PRODUCT_FEES_RATE_LIMIT = {
  /** getMyFeesEstimateForASIN / ForSKU — 1 rps · burst 2 theo docs chính thức */
  estimate: { rate: 1, burst: 2 },
} as const;

export type FeesEstimateForAsinInput = {
  asin: string;
  marketplaceId: string;
  /** Giá dự kiến bán — Amazon ước phí THEO giá này (ListingPrice). */
  price: number;
  currency?: string;
  /** mặc định true = tính phí FBA (đúng luồng thẩm định của VEXIM) */
  isAmazonFulfilled?: boolean;
};

export type ProductFeesClientOptions = {
  /** mặc định https://sellingpartnerapi-na.amazon.com */
  host?: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  log?: (line: string) => void;
};

/** Xô token tối giản 1 rps · burst 2 (không cần class đầy đủ của Orders). */
type Bucket = { tokens: number; last: number };

export class ProductFeesClient {
  private readonly lwa: LwaTokenManager;
  private readonly host: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly log: (line: string) => void;
  private readonly bucket: Bucket;

  constructor(lwa: LwaTokenManager, opts: ProductFeesClientOptions = {}) {
    if (!opts.host) throw new Error("ProductFeesClient: thiếu host SP-API");
    this.lwa = lwa;
    this.host = opts.host.replace(/\/$/, "");
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = opts.maxRetries ?? 3;
    this.log = opts.log ?? (() => {});
    this.bucket = { tokens: PRODUCT_FEES_RATE_LIMIT.estimate.burst, last: Date.now() };
  }

  private async takeToken(): Promise<void> {
    const { rate, burst } = PRODUCT_FEES_RATE_LIMIT.estimate;
    const now = Date.now();
    const seconds = (now - this.bucket.last) / 1000;
    this.bucket.last = now;
    this.bucket.tokens = Math.min(burst, this.bucket.tokens + seconds * rate);
    if (this.bucket.tokens >= 1) {
      this.bucket.tokens -= 1;
      return;
    }
    const waitMs = Math.ceil(((1 - this.bucket.tokens) / rate) * 1000);
    // Trần chờ 8s — vượt thì báo bận thay vì giữ function tới lúc bị kill.
    if (waitMs > 8_000) {
      throw new SpApiRequestError({
        code: "QuotaExceeded",
        message: `Trần tốc độ Product Fees: cần chờ ${Math.round(waitMs / 1000)}s — thử lại sau`,
        status: 429,
      });
    }
    await this.sleep(waitMs);
    this.bucket.tokens = 0;
  }

  /**
   * Ước tính phí chuẩn cho 1 ASIN tại 1 mức giá. KHÔNG ném lỗi khi Amazon trả
   * lỗi nghiệp vụ (ASIN không tồn tại…) — trả ok=false kèm mã để UI giải thích;
   * chỉ ném khi hỏng hạ tầng (mạng, token, JSON) sau khi đã retry 429/5xx.
   */
  async estimateForAsin(input: FeesEstimateForAsinInput): Promise<SpApiFeesEstimate> {
    const asin = String(input.asin ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin)) {
      throw new Error(`ProductFees: ASIN không hợp lệ (${asin || "rỗng"}) — cần đúng 10 ký tự`);
    }
    if (!(Number.isFinite(input.price) && input.price > 0)) {
      throw new Error("ProductFees: price phải là số dương (giá dự kiến bán)");
    }
    const marketplaceId = String(input.marketplaceId ?? "").trim();
    if (!marketplaceId) throw new Error("ProductFees: thiếu marketplaceId");

    const body = {
      FeesEstimateRequest: {
        MarketplaceId: marketplaceId,
        IsAmazonFulfilled: input.isAmazonFulfilled ?? true,
        Identifier: `vexim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        PriceToEstimateFees: {
          ListingPrice: {
            CurrencyCode: input.currency ?? "USD",
            Amount: Math.round(input.price * 100) / 100,
          },
        },
      },
    };

    const url = `${this.host}/products/fees/v0/items/${encodeURIComponent(asin)}/feesEstimate`;
    let attempt = 0;
    let lastWait = 1000;

    for (;;) {
      await this.takeToken();
      const token = await this.lwa.getAccessToken();
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-amz-access-token": token,
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(body),
      });

      const text = await res.text();

      if (res.ok) {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          throw new SpApiRequestError({
            code: "InvalidResponse",
            message: "Product Fees API trả về không phải JSON",
            status: res.status,
            details: text.slice(0, 300),
          });
        }
        return mapFeesEstimateResponse(json);
      }

      if (res.status === 429 || res.status >= 500) {
        attempt += 1;
        if (attempt > this.maxRetries) {
          throw new SpApiRequestError({
            code: res.status === 429 ? "QuotaExceeded" : "ServiceUnavailable",
            message: `Product Fees API lỗi HTTP ${res.status}`,
            status: res.status,
            details: text.slice(0, 300),
          });
        }
        const retryAfter = Number(res.headers.get("retry-after") ?? 0);
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : lastWait;
        this.log(`[product-fees] HTTP ${res.status} — thử lại sau ${waitMs}ms (lần ${attempt}/${this.maxRetries})\n`);
        await this.sleep(waitMs);
        lastWait = Math.min(lastWait * 2, 15_000);
        continue;
      }

      // 4xx khác (400/403/404): lôi mã + thông điệp Amazon ra cho dễ sửa.
      let code: string | undefined;
      let message: string | undefined;
      let details: string | undefined;
      try {
        const parsed = JSON.parse(text) as { errors?: { code?: string; message?: string; details?: string }[] };
        code = parsed.errors?.[0]?.code;
        message = parsed.errors?.[0]?.message;
        details = parsed.errors?.[0]?.details;
      } catch {
        /* body không phải JSON */
      }
      throw new SpApiRequestError({
        code: code ?? `Http${res.status}`,
        message: message ?? `Product Fees API lỗi HTTP ${res.status}`,
        status: res.status,
        details: details ?? text.slice(0, 300),
      });
    }
  }
}
