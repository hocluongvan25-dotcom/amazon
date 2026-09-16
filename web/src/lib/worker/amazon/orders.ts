/**
 * Client Orders API v0 (SP-API) — GET /orders/v0/orders · /orders/v0/orders/{id} ·
 * /orders/v0/orders/{id}/orderItems.
 *
 * VÌ SAO CẦN (sự cố 16/09/2026 — câu hỏi của chủ dự án trên màn /orders):
 *   `worker/src/jobs/orders-sync.job.ts` MÔ TẢ 3 tầng (notification realtime · delta
 *   getOrders · đối soát bằng report) nhưng repo **chưa có client nào gọi getOrders**
 *   và cũng không có CLI/cron cho đơn hàng ⇒ không đường nào đưa đơn về DB. Màn
 *   /orders vì thế luôn trống dù shop đã kết nối.
 *
 * Hợp đồng lấy từ model chính thức `amzn/selling-partner-api-models`
 * (`models/orders-api-model/ordersV0.json`):
 *   • `MarketplaceIds` BẮT BUỘC (thiếu ⇒ 400 MissingParameter).
 *   • `MaxResultsPerPage` 1–100; phân trang `NextToken` (token KHÔNG áp lại filter).
 *   • Rate: getOrders **0.0167 rps · burst 20**; getOrder/getOrderItems **0.5 rps · burst 30**.
 *     `x-amzn-RateLimit-Limit` trả về con số thật của tài khoản — ta log lại khi khác.
 *   • PII (`/address`, `/buyerInfo`, `/orderItems/buyerInfo`) KHÔNG được gọi ở đây.
 */
import { LwaTokenManager } from "./lwa.ts";
import { SpApiRequestError } from "./reports.ts";
import {
  assertMarketplaceIds,
  clampMaxResultsPerPage,
  isPiiLockedPath,
  type ApiOrder,
  type ApiOrderItem,
} from "../domain/orders-api.ts";
import { SP_API_BEFORE_LAG_TOTAL_MS } from "../domain/orders.ts";

const USER_AGENT = "VEXIM-Worker/1.0 (Language=TypeScript; Platform=Vercel)";
const API_PATH = "/orders/v0";

/** Trần tốc độ theo model chính thức — để nguyên số của Amazon, KHÔNG tự nới. */
export const ORDERS_RATE_LIMIT = {
  /** GET /orders/v0/orders */
  listOrders: { rate: 0.0167, burst: 20 },
  /** GET /orders/v0/orders/{orderId} */
  getOrder: { rate: 0.5, burst: 30 },
  /** GET /orders/v0/orders/{orderId}/orderItems */
  orderItems: { rate: 0.5, burst: 30 },
} as const;

/**
 * Xô token đơn giản theo (rate, burst) của Amazon.
 *
 * Vì sao cần: 0.0167 rps = 1 request/60 giây. Bắn liền 5 trang mà không chờ là ăn
 * 429; chờ mù 60s mỗi trang thì vượt trần 60s của Vercel Function. Xô cho phép
 * dùng hết `burst` trước, sau đó mới chờ đúng 1/rate mỗi request.
 */
export class TokenBucket {
  readonly rate: number;
  readonly burst: number;
  private tokens: number;
  private last: number;
  private readonly now: () => number;

  // KHÔNG dùng parameter property (`constructor(readonly x)`) — Node chạy test bằng
  // `--experimental-strip-types` (chỉ XOÁ kiểu, không biên dịch) nên cú pháp đó bị
  // từ chối: ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. Khai báo trường tường minh.
  constructor(rate: number, burst: number, now: () => number = () => Date.now()) {
    this.rate = rate;
    this.burst = burst;
    this.now = now;
    this.tokens = burst;
    this.last = now();
  }

  private refill(at: number): void {
    const seconds = (at - this.last) / 1000;
    this.last = at;
    this.tokens = Math.min(this.burst, this.tokens + seconds * this.rate);
  }

  /** Số ms phải chờ trước khi có token (0 = gọi được ngay). */
  msUntilToken(at: number = this.now()): number {
    this.refill(at);
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.rate) * 1000);
  }

  take(at: number = this.now()): void {
    this.refill(at);
    this.tokens = Math.max(0, this.tokens - 1);
  }
}

export type OrdersListQuery = {
  /** BẮT BUỘC — MarketplaceId của shop (vd ATVPDKIKX0DER cho US). */
  marketplaceIds: readonly string[];
  /** ISO 8601 hoặc Date — Amazon trả đơn *created/updated* trong khoảng. */
  lastUpdatedAfter?: Date | string | null;
  lastUpdatedBefore?: Date | string | null;
  createdAfter?: Date | string | null;
  orderStatuses?: readonly string[];
  fulfillmentChannels?: readonly string[];
  maxResultsPerPage?: number | null;
};

export type OrdersListResult = {
  orders: ApiOrder[];
  pages: number;
  /** còn trang chưa đọc (do chạm trần chờ) — lần cron sau đọc tiếp từ mốc thời gian */
  truncated: boolean;
  /** có request bị hoãn vì trần tốc độ (job ghi vào log, KHÔNG coi là lỗi) */
  throttled: boolean;
  requestId: string | null;
  /** giá trị `x-amzn-RateLimit-Limit` nếu Amazon trả (để log khi khác mặc định) */
  rateLimitHint: string | null;
};

export type OrderItemsResult = {
  items: ApiOrderItem[];
  pages: number;
  throttled: boolean;
};

export type OrdersClientOptions = {
  /** mặc định https://sellingpartnerapi-na.amazon.com */
  host?: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** số lần thử lại cho 429/5xx mỗi request */
  maxRetries?: number;
  /**
   * Chờ TỐI ĐA cho một lượt throttle. Vượt ngưỡng thì DỪNG và trả `throttled`
   * (đừng giữ function của Vercel tới lúc bị kill — lần chạy sau đọc tiếp).
   */
  maxWaitMs?: number;
  /** trần số trang mỗi lượt (mặc định 20 = đúng burst của getOrders) */
  maxPages?: number;
  log?: (line: string) => void;
};

export type OrdersPage = {
  orders: ApiOrder[];
  nextToken: string | null;
  requestId: string | null;
  rateLimitHint: string | null;
};

function isoOrUndefined(value?: Date | string | null): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return undefined;
  return dt.toISOString();
}

/**
 * PHÒNG THỦ SỰ CỐ 16/09/2026 (mọi shop 400 InvalidInput): Amazon đòi mốc
 * `...Before` phải sớm hơn giờ hiện tại ÍT NHẤT 2 phút (dữ liệu getOrders có độ trễ
 * hệ thống ~2 phút). Caller nào lỡ truyền mốc quá mới (vd `now`) thì tự động lùi về
 * mốc an toàn nhất và log rõ — thu hẹp cửa sổ vài phút còn hơn cả lượt sync chết.
 * `nowMs` tách riêng để test được mà không phụ thuộc đồng hồ thật.
 */
export function clampTooRecentBefore(
  iso: string | undefined,
  log: (line: string) => void = () => {},
  nowMs: number = Date.now(),
): string | undefined {
  if (!iso) return undefined;
  const t = new Date(iso).getTime();
  const safeMax = nowMs - SP_API_BEFORE_LAG_TOTAL_MS;
  if (!Number.isNaN(t) && t > safeMax) {
    const clamped = new Date(safeMax).toISOString();
    log(
      `[orders] LastUpdatedBefore=${iso} mới hơn mức Amazon chấp nhận (phải sớm hơn hiện tại ≥ 2 phút) ` +
        `→ tự lùi về ${clamped}.\n`,
    );
    return clamped;
  }
  return iso;
}

export class OrdersClient {
  private readonly lwa: LwaTokenManager;
  private readonly host: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly maxWaitMs: number;
  private readonly maxPages: number;
  private readonly log: (line: string) => void;
  private readonly bucketOrders: TokenBucket;
  private readonly bucketItems: TokenBucket;

  constructor(lwa: LwaTokenManager, opts: OrdersClientOptions = {}) {
    this.lwa = lwa;
    this.host = (opts.host ?? "https://sellingpartnerapi-na.amazon.com").replace(/\/$/, "");
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = opts.maxRetries ?? 3;
    this.maxWaitMs = opts.maxWaitMs ?? 15_000;
    this.maxPages = opts.maxPages ?? 20;
    this.log = opts.log ?? (() => {});
    this.bucketOrders = new TokenBucket(ORDERS_RATE_LIMIT.listOrders.rate, ORDERS_RATE_LIMIT.listOrders.burst);
    this.bucketItems = new TokenBucket(ORDERS_RATE_LIMIT.orderItems.rate, ORDERS_RATE_LIMIT.orderItems.burst);
  }

  /**
   * Một trang getOrders. Dùng `listOrders()` cho luồng thường (tự phân trang).
   */
  async getOrdersPage(query: OrdersListQuery & { nextToken?: string | null }): Promise<OrdersPage> {
    const params: Record<string, string> = {
      MarketplaceIds: assertMarketplaceIds(query.marketplaceIds).join(","),
      MaxResultsPerPage: String(clampMaxResultsPerPage(query.maxResultsPerPage)),
    };
    const lastUpdatedAfter = isoOrUndefined(query.lastUpdatedAfter);
    const createdAfter = isoOrUndefined(query.createdAfter);
    const lastUpdatedBefore = clampTooRecentBefore(isoOrUndefined(query.lastUpdatedBefore), (s) => this.log(s));
    if (lastUpdatedAfter) params.LastUpdatedAfter = lastUpdatedAfter;
    if (lastUpdatedBefore) params.LastUpdatedBefore = lastUpdatedBefore;
    if (createdAfter) params.CreatedAfter = createdAfter;
    if (query.orderStatuses?.length) params.OrderStatuses = query.orderStatuses.join(",");
    if (query.fulfillmentChannels?.length) params.FulfillmentChannels = query.fulfillmentChannels.join(",");
    if (query.nextToken) params.NextToken = query.nextToken;

    // Cửa sổ sập sau khi clamp (Before ≤ After) thì Amazon cũng từ chối bằng 400
    // InvalidInput — ném lỗi TRƯỚC để job log nói rõ nguyên nhân thay vì lỗi mơ hồ.
    if (
      lastUpdatedAfter &&
      lastUpdatedBefore &&
      new Date(lastUpdatedBefore).getTime() <= new Date(lastUpdatedAfter).getTime()
    ) {
      throw new Error(
        `getOrders: cửa sổ không hợp lệ — LastUpdatedBefore (${lastUpdatedBefore}) không được sớm hơn hoặc bằng ` +
          `LastUpdatedAfter (${lastUpdatedAfter}). Khoảng kéo đang ngắn hơn độ trễ dữ liệu ~2 phút của getOrders.` +
          " Hãy nới khoảng kéo hoặc bỏ LastUpdatedBefore.",
      );
    }

    const { json, rateLimitHint } = await this.request<{
      payload?: { Orders?: ApiOrder[]; NextToken?: string | null };
    }>("GET", `${API_PATH}/orders`, { query: params, bucket: this.bucketOrders });

    const payload = json.payload ?? {};
    return {
      orders: Array.isArray(payload.Orders) ? payload.Orders : [],
      nextToken: payload.NextToken ?? null,
      requestId: (json as { requestId?: string }).requestId ?? null,
      rateLimitHint,
    };
  }

  /**
   * getOrders + tự phân trang tới hết (hoặc tới khi chạm trần chờ/số trang).
   * KHÔNG ném lỗi khi bị hoãn vì trần tốc độ — trả `throttled` để job ghi nhận.
   */
  async listOrders(query: OrdersListQuery): Promise<OrdersListResult> {
    const orders: ApiOrder[] = [];
    let nextToken: string | null = null;
    let pages = 0;
    let throttled = false;
    let requestId: string | null = null;
    let rateLimitHint: string | null = null;

    while (pages < this.maxPages) {
      const wait = this.bucketOrders.msUntilToken();
      if (wait > this.maxWaitMs) {
        throttled = true;
        this.log(
          `[orders] trần tốc độ getOrders (0.0167 rps): cần chờ ${Math.round(wait / 1000)}s > ${Math.round(
            this.maxWaitMs / 1000,
          )}s → dừng lượt này, lần chạy sau đọc tiếp từ LastUpdatedAfter.\n`,
        );
        break;
      }
      const page = await this.getOrdersPage({ ...query, nextToken });
      pages += 1;
      orders.push(...page.orders);
      requestId = page.requestId ?? requestId;
      rateLimitHint = page.rateLimitHint ?? rateLimitHint;
      nextToken = page.nextToken;
      if (!nextToken) break;
    }

    return {
      orders,
      pages,
      truncated: nextToken !== null,
      throttled,
      requestId,
      rateLimitHint,
    };
  }

  /** GET /orders/v0/orders/{orderId} — 1 đơn (404 ⇒ null, không ném lỗi làm sập job). */
  async getOrder(orderId: string): Promise<ApiOrder | null> {
    const id = String(orderId ?? "").trim();
    if (!id) throw new Error("getOrder: thiếu orderId");
    try {
      const { json } = await this.request<{ payload?: ApiOrder }>(
        "GET",
        `${API_PATH}/orders/${encodeURIComponent(id)}`,
        { bucket: this.bucketItems },
      );
      return json.payload ?? null;
    } catch (e) {
      if (e instanceof SpApiRequestError && e.status === 404) return null;
      throw e;
    }
  }

  /** GET /orders/v0/orders/{orderId}/orderItems — tự phân trang (0.5 rps · burst 30). */
  async listOrderItems(orderId: string, opts: { maxPages?: number } = {}): Promise<OrderItemsResult> {
    const id = String(orderId ?? "").trim();
    if (!id) throw new Error("listOrderItems: thiếu orderId");
    const pageLimit = Math.max(1, opts.maxPages ?? this.maxPages);
    const items: ApiOrderItem[] = [];
    let nextToken: string | null = null;
    let pages = 0;
    let throttled = false;

    while (pages < pageLimit) {
      const wait = this.bucketItems.msUntilToken();
      if (wait > this.maxWaitMs) {
        throttled = true;
        this.log(`[orders] trần tốc độ orderItems: chờ ${Math.round(wait / 1000)}s → dừng lượt này.\n`);
        break;
      }
      const params: Record<string, string> = {};
      if (nextToken) params.NextToken = nextToken;
      const { json } = await this.request<{
        payload?: { OrderItems?: ApiOrderItem[]; NextToken?: string | null };
      }>("GET", `${API_PATH}/orders/${encodeURIComponent(id)}/orderItems`, {
        query: params,
        bucket: this.bucketItems,
      });
      pages += 1;
      const payload = json.payload ?? {};
      if (Array.isArray(payload.OrderItems)) items.push(...payload.OrderItems);
      nextToken = payload.NextToken ?? null;
      if (!nextToken) break;
    }

    return { items, pages, throttled };
  }

  // --------------------------------------------------------------------------
  // HTTP lõi — LWA token + trần tốc độ + retry 429/5xx + lỗi có cấu trúc
  // --------------------------------------------------------------------------
  private async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: { query?: Record<string, string>; bucket: TokenBucket },
  ): Promise<{ json: T; rateLimitHint: string | null }> {
    // CHỐT PII: ba endpoint dưới không bao giờ được gọi từ worker (quyết định v1.1).
    if (isPiiLockedPath(path)) {
      throw new Error(
        `Orders API: ${path} là endpoint PII (dữ liệu người mua) — hệ thống CỐ Ý không gọi. ` +
          "Xem domain/orders-api.ts → PII_LOCKED_PATHS.",
      );
    }

    const url = new URL(`${this.host}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

    let attempt = 0;
    let lastWait = 1000;
    let rateLimitHint: string | null = null;

    for (;;) {
      // Xô token phải được "tiêu" ngay trước request THẬT (kể cả lượt thử lại), nếu
      // không thì retry 429 sẽ bắn dồn và ăn 429 tiếp.
      const wait = opts.bucket.msUntilToken();
      if (wait > 0) {
        if (wait > this.maxWaitMs) {
          throw new SpApiRequestError({
            code: "QuotaExceeded",
            message: `Trần tốc độ Orders API: cần chờ ${Math.round(wait / 1000)}s`,
            status: 429,
          });
        }
        await this.sleep(wait);
      }
      opts.bucket.take();

      const token = await this.lwa.getAccessToken();
      const res = await this.fetchFn(url.toString(), {
        method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-amz-access-token": token,
          "User-Agent": USER_AGENT,
        },
      });

      const hint = res.headers.get("x-amzn-RateLimit-Limit");
      if (hint) rateLimitHint = hint;

      if (res.ok) {
        const text = await res.text();
        try {
          return { json: JSON.parse(text) as T, rateLimitHint };
        } catch {
          throw new SpApiRequestError({
            code: "InvalidResponse",
            message: "Orders API trả về không phải JSON",
            status: res.status,
            details: text.slice(0, 300),
          });
        }
      }

      const text = await res.text();
      let code: string | undefined;
      let message: string | undefined;
      let details: string | undefined;
      try {
        const parsed = JSON.parse(text) as { errors?: { code?: string; message?: string; details?: string }[] };
        code = parsed.errors?.[0]?.code;
        message = parsed.errors?.[0]?.message;
        details = parsed.errors?.[0]?.details;
      } catch {
        /* body không phải JSON — dùng text thô */
      }

      if (res.status === 429 || res.status >= 500) {
        attempt += 1;
        if (attempt > this.maxRetries) {
          throw new SpApiRequestError({
            code: code ?? (res.status === 429 ? "QuotaExceeded" : "ServiceUnavailable"),
            message: message ?? `Orders API lỗi HTTP ${res.status}`,
            status: res.status,
            details: details ?? text.slice(0, 300),
          });
        }
        const retryAfter = Number(res.headers.get("retry-after") ?? 0);
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : lastWait;
        this.log(`[orders] HTTP ${res.status} — thử lại sau ${waitMs}ms (lần ${attempt}/${this.maxRetries})\n`);
        await this.sleep(waitMs);
        lastWait = Math.min(lastWait * 2, 30_000);
        continue;
      }

      throw new SpApiRequestError({
        code: code ?? `Http${res.status}`,
        message: message ?? `Orders API lỗi HTTP ${res.status}`,
        status: res.status,
        details: details ?? text.slice(0, 300),
      });
    }
  }
}

/** Host Orders API theo vùng — khớp `spApiHost` của config. */
export function ordersHostForRegion(region: string): string {
  switch (String(region ?? "NA").toUpperCase()) {
    case "EU":
      return "https://sellingpartnerapi-eu.amazon.com";
    case "FE":
      return "https://sellingpartnerapi-fe.amazon.com";
    case "NA_SANDBOX":
      return "https://sandbox.sellingpartnerapi-na.amazon.com";
    default:
      return "https://sellingpartnerapi-na.amazon.com";
  }
}
