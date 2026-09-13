/**
 * SupabaseDbAdapter — ghi/đọc dữ liệu xuống Supabase (service_role).
 *
 * Không dùng @supabase/supabase-js để worker nhẹ — gọi REST API với fetch.
 * Không đi qua RLS (service_role bypass). Khớp DbAdapter interface.
 *
 * ⚠️ QUY TẮC POSTGREST (đọc trước khi sửa — sai là dính PGRST205/PGRST202):
 *
 *   1. Đường dẫn KHÔNG BAO GIỜ có tiền tố schema:
 *        ✅ /rest/v1/seller_accounts
 *        ❌ /rest/v1/connections.seller_accounts
 *      PostgREST không hiểu "schema.table": nó tìm một bảng có TÊN chứa dấu
 *      chấm trong schema mặc định (public) → PGRST205 "Could not find the
 *      table 'public.connections.seller_accounts' in the schema cache".
 *      Hàm request() bên dưới có chốt chặn throw ngay nếu path còn dấu chấm.
 *
 *   2. Chọn schema bằng HEADER (đúng chuẩn supabase-js / postgrest-js):
 *        GET / HEAD           → Accept-Profile:   connections
 *        POST / PATCH /DELETE → Content-Profile:  connections
 *      (gửi cả hai cho mọi method để chắc chắn đúng schema ở cả chiều đọc
 *       lẫn chiều ghi — PostgREST bỏ qua header không dùng tới)
 *
 *   3. RPC gọi qua /rest/v1/rpc/<tên> KHÔNG có tiền tố schema. Schema mặc
 *      định của PostgREST là `public`, nên worker dùng các wrapper
 *      public.active_production_shops / public.units_sold_per_day do
 *      migration 0008 tạo (schema connections/inventory có thể chưa được
 *      phơi trong "Exposed schemas" → vẫn PGRST202 nếu gọi trực tiếp).
 */
import type {
  AccountHealthIssueRowInput,
  AccountHealthSnapshotRowInput,
  ActiveShop,
  AlertRowInput,
  DbAdapter,
  FcAllocationRowInput,
  FinancialEventRowInput,
  InventoryDailyRow,
  InventorySnapshotRow,
  ListingPublishQueueRow,
  ListingPublishResultInput,
  ProductTypeSchemaInput,
  ReceiptRowInput,
  FeeUpsertCounts,
  NoncomplianceRowInput,
  ReportUpsertCounts,
  ReportRequestInput,
  ReportRequestRow,
  StorageFeeRowInput,
  ReimbursementRowInput,
  ReimbursementClaimRowInput,
  ReimbursementClaimRow,
  SkuProfitRowInput,
  EffectiveCostRow,
  FinancialEventQueryRow,
  ListingStateRow,
  NotificationRecord,
  OrderDailyRowInput,
  OrderRowInput,
  ReturnRowInput,
  SettlementRowInput,
  SyncJobRecord,
  AdsAdGroupRowInput,
  AdsBudgetEventRowInput,
  AdsCampaignMetricRowInput,
  AdsCampaignRowInput,
  AdsEntityCounts,
  AdsMetricCounts,
  AdsProductMetricRowInput,
  AdsProfileRow,
  AdsProfileRowInput,
  AdsSearchTermRowInput,
  AdsSuggestionCounts,
  AdsSuggestionRowInput,
  AdsChangeRow,
  AdsChangeRecordInput,
  AdsChangeRecordResult,
  AdsChangeReleaseResult,
  AdsSpendCounts,
  AdsTargetMetricRowInput,
  AdsTargetRowInput,
  OauthConsumeResult,
  OauthSoonRow,
  OauthStateResult,
  OauthTokenInput,
  OauthTokenResult,
} from "./adapter.ts";
import { normalizeReportRequestStatus } from "./adapter.ts";
import { buildListingPayload, type ListingUpsertPayload } from "./listing-payload.ts";

type Json = unknown;

/** Schema nghiệp vụ VEXIM — value truyền vào header Accept/Content-Profile. */
type SchemaName =
  | "connections"
  | "inventory"
  | "ops"
  | "sales"
  | "finance"
  | "account_health";

/**
 * Schema nghiệp vụ PHẢI nằm trong Supabase → Settings → API → "Exposed schemas",
 * nếu không PostgREST trả PGRST205/PGRST202 (sự cố thật 12/09/2026 — xem migration
 * 0008). Danh sách này dùng để sinh thông báo lỗi có hướng dẫn thay vì lỗi thô.
 */
const REQUIRED_EXPOSED_SCHEMAS = [
  "connections",
  "inventory",
  "ops",
  "sales",
  "finance",
  "account_health",
] as const;

/**
 * Schema mặc định của PostgREST (public) — RPC ở đây thì KHÔNG set header
 * profile, vì PostgREST resolve theo schema đầu tiên trong db-schemas.
 */
const RPC_PATHS = {
  activeProductionShops: "/rest/v1/rpc/active_production_shops",
  unitsSoldPerDay: "/rest/v1/rpc/units_sold_per_day",
  // L3 (migration 0014 §7C) — worker nhận hàng đợi publish + ghi kết quả
  claimListingPublish: "/rest/v1/rpc/vexim_worker_claim_listing_publish",
  recordPublishResult: "/rest/v1/rpc/vexim_worker_record_publish_result",
  upsertProductTypeSchema: "/rest/v1/rpc/vexim_worker_upsert_product_type_schema",
  upsertReimbursements: "/rest/v1/rpc/vexim_worker_upsert_reimbursements",
  upsertClaims: "/rest/v1/rpc/vexim_worker_upsert_claims",
  upsertProfit: "/rest/v1/rpc/vexim_worker_upsert_profit",
  financialEvents: "/rest/v1/rpc/vexim_worker_financial_events",
  effectiveCosts: "/rest/v1/rpc/vexim_worker_effective_costs",
  // Đợt A (migration 0016) — ghi listing (L1/L2/L4). Giá vốn worker vẫn đọc qua
  // vexim_worker_effective_costs của 0015 (không tạo RPC trùng chức năng).
  upsertListings: "/rest/v1/rpc/vexim_worker_upsert_listings",
  // Module 3 nâng cao (migration 0018) — nhập 2 report FBA inventory:
  // phân bổ tồn theo FC (I2) + lịch sử nhận hàng (I2/I4 đối soát).
  upsertFcAllocation: "/rest/v1/rpc/vexim_worker_upsert_fc_allocation",
  upsertReceipts: "/rest/v1/rpc/vexim_worker_upsert_receipts",
  /* 0019 — phí theo FC + trạng thái report */
  upsertStorageFees: "/rest/v1/rpc/vexim_worker_upsert_storage_fees",
  upsertNoncompliance: "/rest/v1/rpc/vexim_worker_upsert_noncompliance",
  setReportRequest: "/rest/v1/rpc/vexim_worker_set_report_request",

  /* ---- Module 5 phần 1 (0020): Amazon Ads ---- */
  upsertAdsProfiles: "/rest/v1/rpc/vexim_worker_upsert_ads_profiles",
  upsertAdsCampaigns: "/rest/v1/rpc/vexim_worker_upsert_ads_campaigns",
  upsertAdsAdGroups: "/rest/v1/rpc/vexim_worker_upsert_ads_ad_groups",
  upsertAdsTargets: "/rest/v1/rpc/vexim_worker_upsert_ads_targets",
  upsertAdsCampaignMetrics: "/rest/v1/rpc/vexim_worker_upsert_ads_campaign_metrics",
  upsertAdsTargetMetrics: "/rest/v1/rpc/vexim_worker_upsert_ads_target_metrics",
  upsertAdsSearchTerms: "/rest/v1/rpc/vexim_worker_upsert_ads_search_terms",
  upsertAdsProductMetrics: "/rest/v1/rpc/vexim_worker_upsert_ads_product_metrics",
  upsertAdsBudgetEvents: "/rest/v1/rpc/vexim_worker_upsert_ads_budget_events",
  upsertAdsSuggestions: "/rest/v1/rpc/vexim_worker_upsert_ads_suggestions",
  applyAdsSpend: "/rest/v1/rpc/vexim_worker_apply_ads_spend",
  /* Module 5 phần 3 (0021) — hàng đợi ghi lên Amazon Ads */
  claimAdsChanges: "/rest/v1/rpc/vexim_worker_claim_ads_changes",
  recordAdsChange: "/rest/v1/rpc/vexim_worker_record_ads_change",
  releaseAdsChange: "/rest/v1/rpc/vexim_worker_release_ads_change",

  /* ---- Module 0 (0020): token platform + re-authorize ---- */
  setOauthToken: "/rest/v1/rpc/vexim_worker_set_oauth_token",
  createOauthState: "/rest/v1/rpc/vexim_worker_create_oauth_state",
  consumeOauthState: "/rest/v1/rpc/vexim_worker_consume_oauth_state",
  markOauthNotice: "/rest/v1/rpc/vexim_worker_mark_oauth_notice",
  oauthSoon: "/rest/v1/rpc/vexim_worker_oauth_soon",
} as const;

/**
 * RPC 0018 trả (inserted, updated, skipped, merged, units, snapshots|shipments).
 * PostgREST có thể trả số dưới dạng chuỗi → ép Number để tầng trên cộng được.
 */
type RpcReportCounts = {
  inserted?: number | string | null;
  updated?: number | string | null;
  skipped?: number | string | null;
  merged?: number | string | null;
};

function toReportCounts(row?: RpcReportCounts | null): ReportUpsertCounts {
  const num = (v: number | string | null | undefined) => Number(v ?? 0) || 0;
  return {
    inserted: num(row?.inserted),
    updated: num(row?.updated),
    skipped: num(row?.skipped),
    merged: num(row?.merged),
  };
}

/**
 * RPC 0019 trả (inserted, updated, skipped, merged, months|shipments, currencies).
 * `currencies` là chuỗi "CAD,USD" (rỗng nếu report không có cột tiền) → tách mảng.
 * KHÔNG có tổng tiền: cộng hai tiền tệ là vô nghĩa, việc cộng để tầng view làm.
 */
type RpcFeeCounts = {
  inserted?: number | string | null;
  updated?: number | string | null;
  skipped?: number | string | null;
  merged?: number | string | null;
  months?: number | string | null;
  shipments?: number | string | null;
  currencies?: string | null;
};

function toFeeCounts(row?: RpcFeeCounts | null): FeeUpsertCounts {
  const num = (v: number | string | null | undefined) => Number(v ?? 0) || 0;
  return {
    inserted: num(row?.inserted),
    updated: num(row?.updated),
    skipped: num(row?.skipped),
    merged: num(row?.merged),
    groups: num(row?.months ?? row?.shipments),
    currencies: (row?.currencies ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c !== ""),
  };
}

/** Trạng thái report đọc từ connections.report_requests (rắn → camelCase). */
function toReportRequestRow(r: {
  id: string;
  seller_account_id: string;
  report_type: string;
  marketplace_id?: string | null;
  data_start?: string | null;
  data_end?: string | null;
  report_id?: string | null;
  report_document_id?: string | null;
  status?: string | null;
  rows_imported?: number | string | null;
  attempts?: number | string | null;
  last_error?: string | null;
  requested_at?: string | null;
  completed_at?: string | null;
  imported_at?: string | null;
}): ReportRequestRow {
  const num = (v: number | string | null | undefined) => (v === null || v === undefined ? null : Number(v));
  return {
    id: r.id,
    sellerAccountId: r.seller_account_id,
    reportType: r.report_type,
    marketplaceId: r.marketplace_id ?? null,
    dataStart: r.data_start ? String(r.data_start).slice(0, 10) : null,
    dataEnd: r.data_end ? String(r.data_end).slice(0, 10) : null,
    reportId: r.report_id ?? null,
    reportDocumentId: r.report_document_id ?? null,
    status: normalizeReportRequestStatus(r.status),
    rowsImported: num(r.rows_imported),
    attempts: num(r.attempts) ?? 0,
    lastError: r.last_error ?? null,
    requestedAt: r.requested_at ?? null,
    completedAt: r.completed_at ?? null,
    importedAt: r.imported_at ?? null,
  };
}

export class SupabaseDbAdapter implements DbAdapter {
  private readonly url: string;
  private readonly serviceKey: string;
  private readonly fetchFn: typeof fetch;

  constructor(url: string, serviceKey: string, fetchFn: typeof fetch = fetch) {
    this.url = url;
    this.serviceKey = serviceKey;
    this.fetchFn = fetchFn;
  }

  private async request<T = unknown>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    opts?: {
      body?: unknown;
      prefer?: string;
      search?: Record<string, string>;
      /** Schema chứa bảng — truyền header Accept/Content-Profile thay vì prefix path. */
      schema?: SchemaName;
    },
  ): Promise<T> {
    // ---------------------------------------------------------------------
    // CHỐT CHẶN PGRST205: path không được chứa "schema.table".
    // Giữ lại để ai đó copy lại kiểu cũ ("/rest/v1/connections.x") sẽ thấy
    // lỗi ngay tại đây, kèm lý do, thay vì một 400 mơ hồ từ PostgREST.
    // ---------------------------------------------------------------------
    const bare = path.replace(/^\/rest\/v1\//, "");
    if (bare.includes(".")) {
      throw new Error(
        `SupabaseDbAdapter: path không được chứa tiền tố schema ("${path}"). ` +
          `Dùng "/rest/v1/${bare.split(".")[1]}" + opts.schema = "${bare.split(".")[0]}". ` +
          `PostgREST không hỗ trợ "schema.table" → PGRST205.`,
      );
    }

    const u = new URL(`${this.url}${path}`);
    if (opts?.search) Object.entries(opts.search).forEach(([k, v]) => u.searchParams.set(k, v));
    const headers: Record<string, string> = {
      apikey: this.serviceKey,
      Authorization: `Bearer ${this.serviceKey}`,
      // Chọn schema theo đúng quy tắc PostgREST. Gửi cả hai header:
      //  - Accept-Profile  → schema dùng cho đọc/representation trả về
      //  - Content-Profile → schema chứa bảng đích khi ghi
      ...(opts?.schema
        ? { "Accept-Profile": opts.schema, "Content-Profile": opts.schema }
        : {}),
    };
    if (opts?.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts?.prefer) headers["Prefer"] = opts.prefer;

    const res = await this.fetchFn(u.toString(), {
      method,
      headers,
      body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // PGRST205/PGRST202 = schema chưa được PostgREST phơi ra. Lỗi này từng làm
      // cron inventory-sync chết im lặng (log chỉ hiện "0 shop") → thông báo phải
      // nêu đích danh việc cần làm, không để người sau đoán.
      const hint = /PGRST20[25]/.test(text)
        ? `\n→ Schema chưa được PostgREST phơi ra. Vào Supabase → Settings → API → ` +
          `"Exposed schemas" và thêm: ${REQUIRED_EXPOSED_SCHEMAS.join(", ")}. ` +
          `(Chỉ thêm schema cần dùng; sau đó PostgREST tự nạp lại schema cache.)`
        : "";
      throw new Error(`Supabase ${method} ${path} → ${res.status}: ${text}${hint}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // ---------- Inventory ----------
  async upsertInventorySnapshot(row: InventorySnapshotRow): Promise<void> {
    await this.request("POST", "/rest/v1/inventory_snapshots", {
      schema: "inventory",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: {
        seller_account_id: row.sellerAccountId,
        sku: row.sku,
        asin: row.asin,
        fulfillable: row.fulfillable,
        reserved: row.reserved,
        inbound: row.inbound,
        captured_at: row.capturedAt.toISOString(),
      },
    });
  }

  async upsertInventoryDaily(row: InventoryDailyRow): Promise<void> {
    await this.request("POST", "/rest/v1/inventory_daily", {
      schema: "inventory",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: {
        seller_account_id: row.sellerAccountId,
        day: row.day,
        sku: row.sku,
        units: row.units,
        days_of_cover: row.daysOfCover,
        in_stock: row.inStock,
      },
    });
  }

  /**
   * Lấy đơn vị bán theo SKU trong N ngày gần nhất, phần tử đầu = gần nhất.
   * Gọi wrapper public.units_sold_per_day (migration 0008) → đích là
   * inventory.units_sold_per_day (migration 0005).
   */
  async getSellingDays(sellerAccountId: string, sku: string, days: number): Promise<number[]> {
    try {
      const rows = await this.request<{ d: string; q: number }[]>(
        "POST",
        RPC_PATHS.unitsSoldPerDay,
        {
          body: { p_seller: sellerAccountId, p_sku: sku, p_days: days },
        },
      );
      if (!Array.isArray(rows)) return new Array(days).fill(0);
      return rows.map((r) => Number(r.q) || 0);
    } catch {
      // RPC chưa có (migration 0005/0008 chưa chạy) → trả rỗng, velocity=0
      return [];
    }
  }

  // ---------- Shops ----------
  async listActiveProductionShops(): Promise<ActiveShop[]> {
    // PostgREST trả đúng tên cột SQL (snake_case) — phải map sang ActiveShop
    // (camelCase). Trả nguyên rows như trước đây khiến shop.displayName /
    // leadDays = undefined: log hiện "undefined (ATVPDKIKX0DER)" và payload
    // sync_jobs ghi lead_days = null.
    const mapRow = (r: {
      id: string;
      seller_id: string;
      marketplace: string;
      display_name: string;
      lead_days?: number | null;
      safety_days?: number | null;
    }): ActiveShop => ({
      id: r.id,
      sellerId: r.seller_id,
      marketplace: r.marketplace,
      displayName: r.display_name,
      leadDays: r.lead_days ?? 32,
      safetyDays: r.safety_days ?? 14,
    });

    type ShopRow = Parameters<typeof mapRow>[0];

    try {
      // RPC nằm trong schema public (wrapper 0008) — KHÔNG set profile header.
      const rows = await this.request<ShopRow[]>("POST", RPC_PATHS.activeProductionShops, {});
      if (Array.isArray(rows)) return rows.map(mapRow);
    } catch {
      // fallthrough đến truy vấn trực tiếp
    }
    // Fallback nếu RPC chưa có — truy vấn trực tiếp (data_source='production' và status='active')
    const rows = await this.request<ShopRow[]>("GET", "/rest/v1/seller_accounts", {
      schema: "connections",
      search: {
        select: "id,seller_id,marketplace,display_name",
        status: "eq.active",
        data_source: "eq.production",
      },
    });
    return (rows ?? []).map(mapRow);
  }

  // ---------- Sync jobs ----------
  async recordSyncJob(job: SyncJobRecord): Promise<void> {
    if (job.id) {
      await this.request("PATCH", `/rest/v1/sync_jobs`, {
        schema: "connections",
        body: {
          status: job.status,
          attempts: job.attempts,
          last_error: job.lastError ?? null,
          started_at: job.startedAt?.toISOString() ?? null,
          finished_at: job.finishedAt?.toISOString() ?? null,
        },
        search: { id: `eq.${job.id}` },
      });
    } else {
      const [created] = await this.request<{ id: string }[]>(
        "POST",
        "/rest/v1/sync_jobs",
        {
          schema: "connections",
          prefer: "return=representation",
          body: {
            seller_account_id: job.sellerAccountId,
            job_type: job.jobType,
            status: job.status,
            payload: (job.payload as Json) ?? null,
            attempts: job.attempts ?? 0,
            last_error: job.lastError ?? null,
            started_at: job.startedAt?.toISOString() ?? null,
            finished_at: job.finishedAt?.toISOString() ?? null,
          },
        },
      );
      if (created) job.id = created.id;
    }
  }

  // ---------- Alerts ----------
  async upsertAlert(input: AlertRowInput): Promise<void> {
    // Tìm rule_id theo rule_code
    const rules = await this.request<{ id: string }[]>("GET", "/rest/v1/alert_rules", {
      schema: "ops",
      search: { rule_code: `eq.${input.ruleCode}`, select: "id", is_active: "eq.true" },
    });
    const ruleId = rules?.[0]?.id ?? null;

    // Chỉ insert nếu chưa có alert open trùng trong 24h qua
    const existing = await this.request<{ id: string }[]>("GET", "/rest/v1/alerts", {
      schema: "ops",
      search: {
        seller_account_id: `eq.${input.sellerAccountId}`,
        title: `eq.${input.title}`,
        status: "eq.open",
        select: "id",
        fired_at: `gte.${new Date(Date.now() - 86_400_000).toISOString()}`,
      },
    });
    if (Array.isArray(existing) && existing.length > 0) return;

    await this.request("POST", "/rest/v1/alerts", {
      schema: "ops",
      prefer: "return=minimal",
      body: {
        seller_account_id: input.sellerAccountId,
        rule_id: ruleId,
        severity: input.severity,
        title: input.title,
        detail: input.detail ?? null,
        assigned_to: input.assignedTo ?? null,
        status: "open",
      },
    });
  }

  // ---------- Module 4 — Đơn hàng ----------
  /**
   * Ghi theo LÔ: upsert orders (unique seller_account_id + amazon_order_id) rồi
   * THAY thế order_items của đúng các đơn đó.
   * Vì sao thay thế: sales.order_items không có khoá tự nhiên (bảng do migration
   * 0010 bổ sung cột amazon_order_item_id + unique theo order) → đơn giản và an
   * toàn nhất là xoá theo order_id rồi insert lại, tránh nhân đôi item khi sync lại.
   */
  async upsertOrders(rows: OrderRowInput[]): Promise<void> {
    if (rows.length === 0) return;

    const created = await this.request<{ id: string; amazon_order_id: string }[]>(
      "POST",
      "/rest/v1/orders?on_conflict=seller_account_id,amazon_order_id&select=id,amazon_order_id",
      {
        schema: "sales",
        prefer: "resolution=merge-duplicates,return=representation",
        body: rows.map((r) => ({
          seller_account_id: r.sellerAccountId,
          amazon_order_id: r.amazonOrderId,
          merchant_order_id: r.merchantOrderId ?? null,
          status: r.status,
          channel: r.channel ?? null,
          purchase_date: r.purchaseDate.toISOString(),
          last_updated_date: r.lastUpdatedDate?.toISOString() ?? null,
          order_total: r.orderTotal ?? null,
          currency: r.currency ?? "USD",
          items_count: r.itemsCount,
          marketplace_id: r.marketplaceId ?? null,
          ship_state: r.shipState ?? null,
          ship_country: r.shipCountry ?? null,
          pii_stripped: true,
        })),
      },
    );

    const idByOrder = new Map((created ?? []).map((r) => [r.amazon_order_id, r.id]));
    const ids = [...idByOrder.values()];
    if (ids.length === 0) return;

    await this.request("DELETE", "/rest/v1/order_items", {
      schema: "sales",
      search: { order_id: `in.(${ids.join(",")})` },
    });

    const items = rows.flatMap((r) => {
      const orderId = idByOrder.get(r.amazonOrderId);
      if (!orderId) return [];
      return r.orderItems.map((i) => ({
        order_id: orderId,
        amazon_order_item_id: i.amazonOrderItemId,
        asin: i.asin,
        sku: i.sku,
        item_name: i.itemName,
        quantity: i.quantity,
        item_price: i.itemPrice,
        item_status: i.itemStatus,
      }));
    });
    if (items.length > 0) {
      await this.request("POST", "/rest/v1/order_items", {
        schema: "sales",
        prefer: "return=minimal",
        body: items,
      });
    }
  }

  async upsertReturns(rows: ReturnRowInput[]): Promise<void> {
    if (rows.length === 0) return;
    await this.request("POST", "/rest/v1/returns_refunds?on_conflict=seller_account_id,dedupe_key", {
      schema: "sales",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: rows.map((r) => ({
        seller_account_id: r.sellerAccountId,
        amazon_order_id: r.amazonOrderId,
        amazon_rma_id: r.amazonRmaId ?? null,
        dedupe_key: r.dedupeKey,
        return_date: r.returnDate.toISOString(),
        reason: r.reason,
        reason_label: r.reasonLabel,
        reason_group: r.reasonGroup,
        status: r.status ?? null,
        resolution: r.resolution ?? null,
        refund_amount: r.refundAmount ?? null,
        currency: r.currency ?? "USD",
        sku: r.sku ?? null,
        asin: r.asin ?? null,
        quantity: r.quantity ?? null,
      })),
    });
  }

  async upsertOrderDaily(row: OrderDailyRowInput): Promise<void> {
    await this.request("POST", "/rest/v1/order_daily?on_conflict=seller_account_id,day", {
      schema: "sales",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: {
        seller_account_id: row.sellerAccountId,
        day: row.day,
        orders_count: row.ordersCount,
        units: row.units,
        sales_amount: row.salesAmount,
        currency: row.currency,
        fbm_unshipped: row.fbmUnshipped,
        fbm_overdue: row.fbmOverdue,
        returns_count: row.returnsCount,
        returns_amount: row.returnsAmount,
      },
    });
  }

  // ---------- Module 7 — Account Health ----------
  async upsertAccountHealthSnapshot(row: AccountHealthSnapshotRowInput): Promise<void> {
    await this.request(
      "POST",
      "/rest/v1/snapshots?on_conflict=seller_account_id,day,marketplace_id",
      {
        schema: "account_health",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: {
          seller_account_id: row.sellerAccountId,
          day: row.day,
          marketplace_id: row.marketplaceId,
          account_status: row.accountStatus,
          ahr_status: row.ahrStatus,
          tone: row.tone,
          score: row.score,
          rates: row.rates,
          issues: row.issues,
          source_report_id: row.sourceReportId,
          captured_at: row.capturedAt.toISOString(),
        },
      },
    );
  }

  async upsertAccountHealthIssue(row: AccountHealthIssueRowInput): Promise<void> {
    await this.request(
      "POST",
      "/rest/v1/issues?on_conflict=seller_account_id,marketplace_id,category",
      {
        schema: "account_health",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: {
          seller_account_id: row.sellerAccountId,
          marketplace_id: row.marketplaceId,
          category: row.category,
          label: row.label,
          severity: row.severity,
          group_name: row.groupName,
          defects_count: row.defectsCount,
          status: row.status,
          reporting_from: row.reportingFrom ?? null,
          reporting_to: row.reportingTo ?? null,
          updated_at: new Date().toISOString(),
        },
      },
    );
  }

  // ---------- Module 6 — Tài chính ----------
  async upsertSettlement(row: SettlementRowInput): Promise<void> {
    await this.request("POST", "/rest/v1/settlements?on_conflict=seller_account_id,settlement_id", {
      schema: "finance",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: {
        seller_account_id: row.sellerAccountId,
        settlement_id: row.settlementId,
        period_start: row.periodStart,
        period_end: row.periodEnd,
        deposit_date: row.depositDate ?? null,
        total_amount: row.totalAmount,
        currency: row.currency,
        status: row.status,
        breakdown: row.breakdown,
        reconcile_diff: row.reconcileDiff,
        reconciled_at: row.reconciledAt?.toISOString() ?? null,
      },
    });
  }

  /** Thay toàn bộ dòng tiền của một kỳ (kỳ đã chốt là bất biến) */
  async replaceFinancialEvents(
    sellerAccountId: string,
    settlementId: string,
    rows: FinancialEventRowInput[],
  ): Promise<void> {
    await this.request("DELETE", "/rest/v1/financial_events", {
      schema: "finance",
      search: {
        seller_account_id: `eq.${sellerAccountId}`,
        settlement_id: `eq.${settlementId}`,
      },
    });
    if (rows.length === 0) return;
    await this.request("POST", "/rest/v1/financial_events", {
      schema: "finance",
      prefer: "return=minimal",
      body: rows.map((r) => ({
        seller_account_id: r.sellerAccountId,
        settlement_id: r.settlementId ?? null,
        event_type: r.eventType,
        event_date: r.eventDate.toISOString(),
        amount: r.amount,
        currency: r.currency,
        sku: r.sku ?? null,
        amount_type: r.amountType ?? null,
        amount_description: r.amountDescription ?? null,
        order_id: r.orderId ?? null,
        quantity: r.quantity ?? null,
        marketplace_name: r.marketplaceName ?? null,
        dedupe_key: r.dedupeKey ?? null,
        raw: (r.raw as Json) ?? null,
      })),
    });
  }

  // ---------- Alerts (dùng chung) ----------
  async resolveAlerts(input: {
    sellerAccountId: string;
    ruleCode: string;
    /** ghi chú vận hành — ops.alerts chưa có cột note nên hiện chỉ nhận và bỏ qua */
    note?: string | null;
    resolvedAt?: Date;
  }): Promise<void> {
    const rules = await this.request<{ id: string }[]>("GET", "/rest/v1/alert_rules", {
      schema: "ops",
      search: { rule_code: `eq.${input.ruleCode}`, select: "id" },
    });
    const ruleId = rules?.[0]?.id ?? null;
    if (!ruleId) return;

    await this.request("PATCH", "/rest/v1/alerts", {
      schema: "ops",
      prefer: "return=minimal",
      search: {
        seller_account_id: `eq.${input.sellerAccountId}`,
        rule_id: `eq.${ruleId}`,
        status: "eq.open",
      },
      body: {
        status: "resolved",
        resolved_at: (input.resolvedAt ?? new Date()).toISOString(),
      },
    });
  }

  // ---------- Notifications (dùng cho mọi handler realtime) ----------
  async recordNotification(row: NotificationRecord): Promise<void> {
    await this.request("POST", "/rest/v1/notifications_log", {
      schema: "connections",
      prefer: "return=minimal",
      body: {
        seller_account_id: row.sellerAccountId,
        notification_type: row.notificationType,
        raw: (row.raw as Json) ?? null,
        received_at: row.receivedAt.toISOString(),
      },
    });
  }

  // ---------- Module 3 (L3): hàng đợi publish ----------
  /**
   * Nhận các dòng publish đang chờ qua RPC public.vexim_worker_claim_listing_publish
   * (migration 0014) — RPC chỉ cho service_role, tự kiểm tra auth.uid() is null.
   */
  async listListingPublishQueue(sellerAccountId: string, limit = 20): Promise<ListingPublishQueueRow[]> {
    const rows = await this.request<
      {
        queue_id: string;
        draft_id: string;
        sku: string;
        asin: string | null;
        marketplace_id: string;
        product_type: string;
        requirements: string;
        method: string;
        payload: Record<string, unknown>;
        attempts: number;
      }[]
    >("POST", RPC_PATHS.claimListingPublish, {
      body: { p_seller: sellerAccountId, p_limit: limit },
    });
    return (rows ?? []).map((row) => ({
      queueId: row.queue_id,
      sellerAccountId,
      draftId: row.draft_id,
      sku: row.sku,
      asin: row.asin,
      marketplaceId: row.marketplace_id,
      productType: row.product_type,
      requirements: row.requirements,
      method: row.method,
      payload: row.payload ?? {},
      attempts: row.attempts ?? 0,
    }));
  }

  /** Ghi kết quả publish (queue + trạng thái bản nháp + lịch sử qua trigger 0014). */
  async recordListingPublishResult(result: ListingPublishResultInput): Promise<void> {
    await this.request("POST", RPC_PATHS.recordPublishResult, {
      body: {
        p_queue_id: result.queueId,
        p_status: result.status,
        p_submission_id: result.submissionId ?? null,
        p_issues: result.issues ?? [],
        p_error: result.error ?? null,
        p_block_reason: result.blockReason ?? null,
      },
    });
  }

  /**
   * Ghi/cập nhật JSON Schema product type (getDefinitionsProductType) vào cache
   * để form động L3 dùng lại. CHỈ service_role gọi được (RPC kiểm tra auth.uid()).
   */
  async upsertProductTypeSchema(input: ProductTypeSchemaInput): Promise<void> {
    await this.request("POST", RPC_PATHS.upsertProductTypeSchema, {
      body: {
        p_marketplace: input.marketplaceId,
        p_product_type: input.productType,
        p_requirements: input.requirements,
        p_schema: input.schema,
      },
    });
  }

  /* ---- Module 3 nâng cao (0018) — qua RPC service_role của migration 0018 ---- */

  /**
   * Nhập report GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA (phân bổ tồn theo FC).
   * RPC tự khử trùng theo (shop, ngày, SKU, FC, disposition) và CỘNG dồn dòng
   * trùng khoá → nhập lại cùng file không nhân đôi tồn.
   */
  async upsertFcAllocation(
    sellerAccountId: string,
    rows: FcAllocationRowInput[],
  ): Promise<ReportUpsertCounts> {
    const result = await this.request<RpcReportCounts[]>("POST", RPC_PATHS.upsertFcAllocation, {
      body: { p_seller: sellerAccountId, p_rows: rows },
    });
    return toReportCounts(result?.[0]);
  }

  /** Nhập report GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA (lịch sử nhận hàng). */
  async upsertReceipts(
    sellerAccountId: string,
    rows: ReceiptRowInput[],
  ): Promise<ReportUpsertCounts> {
    const result = await this.request<RpcReportCounts[]>("POST", RPC_PATHS.upsertReceipts, {
      body: { p_seller: sellerAccountId, p_rows: rows },
    });
    return toReportCounts(result?.[0]);
  }

  /* ---- Module 3 nâng cao (0019): phí theo FC + trạng thái report ---- */

  /** Nhập report GET_FBA_STORAGE_FEE_CHARGES_DATA (phí lưu kho theo FC × tháng). */
  async upsertStorageFees(
    sellerAccountId: string,
    rows: StorageFeeRowInput[],
  ): Promise<FeeUpsertCounts> {
    const result = await this.request<RpcFeeCounts[]>("POST", RPC_PATHS.upsertStorageFees, {
      body: { p_seller: sellerAccountId, p_rows: rows },
    });
    return toFeeCounts(result?.[0]);
  }

  /** Nhập report GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA (phí inbound). */
  async upsertNoncompliance(
    sellerAccountId: string,
    rows: NoncomplianceRowInput[],
  ): Promise<FeeUpsertCounts> {
    const result = await this.request<RpcFeeCounts[]>("POST", RPC_PATHS.upsertNoncompliance, {
      body: { p_seller: sellerAccountId, p_rows: rows },
    });
    return toFeeCounts(result?.[0]);
  }

  /**
   * Ghi trạng thái một lần yêu cầu report. Khoá (shop, loại report, khoảng ngày)
   * nên gọi lại nhiều lần trong lúc poll KHÔNG tạo dòng mới — chỉ tăng attempts.
   */
  async setReportRequest(
    sellerAccountId: string,
    req: ReportRequestInput,
  ): Promise<ReportRequestRow> {
    const result = await this.request<
      { id: string; status: string | null; report_id: string | null }[]
    >("POST", RPC_PATHS.setReportRequest, {
      body: {
        p_seller: sellerAccountId,
        p_req: {
          reportType: req.reportType,
          marketplaceId: req.marketplaceId ?? null,
          dataStart: req.dataStart ?? null,
          dataEnd: req.dataEnd ?? null,
          reportId: req.reportId ?? null,
          reportDocumentId: req.reportDocumentId ?? null,
          status: req.status,
          rowsImported: req.rowsImported ?? null,
          lastError: req.lastError ?? null,
          requestedAt: req.requestedAt ?? null,
          completedAt: req.completedAt ?? null,
          importedAt: req.importedAt ?? null,
        },
      },
    });
    const row = result?.[0];
    return {
      ...req,
      id: row?.id ?? "",
      sellerAccountId,
      status: normalizeReportRequestStatus(row?.status ?? req.status),
      reportId: row?.report_id ?? req.reportId ?? null,
      attempts: 1,
    };
  }

  /** Đọc trạng thái report (bảng connections.report_requests — service_role bypass RLS). */
  async listReportRequests(
    sellerAccountId: string,
    opts?: { reportType?: string; limit?: number },
  ): Promise<ReportRequestRow[]> {
    const search: Record<string, string> = {
      seller_account_id: `eq.${sellerAccountId}`,
      select:
        "id,seller_account_id,report_type,marketplace_id,data_start,data_end,report_id," +
        "report_document_id,status,rows_imported,attempts,last_error,requested_at," +
        "completed_at,imported_at",
      order: "requested_at.desc",
      limit: String(opts?.limit ?? 200),
    };
    if (opts?.reportType) search.report_type = `eq.${opts.reportType}`;
    const rows = await this.request<Parameters<typeof toReportRequestRow>[0][]>(
      "GET",
      "/rest/v1/report_requests",
      { search, schema: "connections" },
    );
    return (rows ?? []).map(toReportRequestRow);
  }

  /* ---- Module 6 Đợt 2 (F3/F4) — qua RPC service_role của migration 0015 ---- */

  /** Nhập report GET_FBA_REIMBURSEMENTS_DATA (idempotent theo dedupeKey). */
  async upsertReimbursements(
    sellerAccountId: string,
    rows: ReimbursementRowInput[],
  ): Promise<{ inserted: number; updated: number }> {
    const result = await this.request<{ inserted: number; updated: number }[]>(
      "POST",
      RPC_PATHS.upsertReimbursements,
      { body: { p_seller: sellerAccountId, p_rows: rows } },
    );
    const row = result?.[0];
    return { inserted: row?.inserted ?? 0, updated: row?.updated ?? 0 };
  }

  /** Ghi khoản nghi ngờ SOP-09 (chỉ chèn mới/refresh dòng suspected). */
  async upsertReimbursementClaims(
    sellerAccountId: string,
    rows: ReimbursementClaimRowInput[],
  ): Promise<{ inserted: number; refreshed: number; kept: number }> {
    const result = await this.request<{ inserted: number; refreshed: number; kept: number }[]>(
      "POST",
      RPC_PATHS.upsertClaims,
      { body: { p_seller: sellerAccountId, p_rows: rows } },
    );
    const row = result?.[0];
    return { inserted: row?.inserted ?? 0, refreshed: row?.refreshed ?? 0, kept: row?.kept ?? 0 };
  }

  /** Đọc claim hiện có (view public) để đối chiếu với report reimbursement. */
  async listReimbursementClaims(sellerAccountId: string, limit = 500): Promise<ReimbursementClaimRow[]> {
    const rows = await this.request<
      {
        id: string;
        sku: string | null;
        status: string;
        reimbursed_amount: number | null;
        reimbursement_id: string | null;
        detected_at: string;
        filed_at: string | null;
        age_hours: number | null;
      }[]
    >("GET", "/rest/v1/vexim_reimbursement_claims", {
      search: {
        seller_account_id: `eq.${sellerAccountId}`,
        select: "id,sku,status,reimbursed_amount,reimbursement_id,detected_at,filed_at,age_hours",
        order: "detected_at.desc",
        limit: String(limit),
      },
    });
    return (rows ?? []).map((r) => ({
      id: r.id,
      sku: r.sku,
      status: r.status,
      reimbursedAmount: r.reimbursed_amount,
      reimbursementId: r.reimbursement_id,
      detectedAt: r.detected_at,
      filedAt: r.filed_at,
      ageHours: r.age_hours,
    }));
  }

  /** Ghi lợi nhuận SKU/ngày (thay thế theo khoá, không cộng dồn). */
  async upsertSkuProfit(sellerAccountId: string, rows: SkuProfitRowInput[]): Promise<number> {
    const result = await this.request<{ upserted: number }[]>("POST", RPC_PATHS.upsertProfit, {
      body: { p_seller: sellerAccountId, p_rows: rows },
    });
    return result?.[0]?.upserted ?? 0;
  }

  /** Giá vốn hiệu lực tại một ngày (catalog.cost_inputs). */
  async listEffectiveCosts(sellerAccountId: string, on: string): Promise<EffectiveCostRow[]> {
    const rows = await this.request<{ sku: string; unit_cost: number | null; currency: string }[]>(
      "POST",
      RPC_PATHS.effectiveCosts,
      { body: { p_seller: sellerAccountId, p_on: on } },
    );
    return (rows ?? []).map((r) => ({ sku: r.sku, unitCost: r.unit_cost, currency: r.currency }));
  }

  /** Dòng tiền đã quyết toán trong khoảng ngày (đầu vào F4 — RPC 0015 §8B.4). */
  async listFinancialEvents(
    sellerAccountId: string,
    from: string,
    to: string,
    limit = 50000,
  ): Promise<FinancialEventQueryRow[]> {
    const rows = await this.request<
      {
        sku: string | null;
        event_type: string;
        amount_type: string | null;
        amount_description: string | null;
        amount: number;
        quantity: number | null;
        currency: string | null;
        event_date: string;
      }[]
    >("POST", RPC_PATHS.financialEvents, {
      body: { p_seller: sellerAccountId, p_from: from, p_to: to, p_limit: limit },
    });
    return (rows ?? []).map((r) => ({
      sku: r.sku,
      eventType: r.event_type,
      amountType: r.amount_type,
      amountDescription: r.amount_description,
      amount: r.amount,
      quantity: r.quantity,
      currency: r.currency,
      eventDate: r.event_date,
    }));
  }

  // ---------- Module 1: Listing (L1/L2/L4) ----------
  /**
   * Ghi listing qua RPC `public.vexim_worker_upsert_listings` (migration 0016).
   *
   * Vì sao KHÔNG ghi thẳng `/rest/v1/listings` với header Content-Profile: catalog?
   * Vì schema `catalog` chưa chắc nằm trong Supabase → Settings → API → "Exposed
   * schemas"; thiếu nó PostgREST trả PGRST205 và lần đồng bộ chết im lặng (đúng
   * sự cố 12/09/2026 của migration 0008). RPC nằm trong `public` nên luôn resolve.
   *
   * Luật "null = chưa biết → giữ nguyên" do RPC thực thi; xem ./listing-payload.ts.
   */
  async upsertListing(row: ListingStateRow): Promise<void> {
    await this.upsertListings([row]);
  }

  /** Ghi cả lô trong 1 request — report Merchant Listings có thể vài nghìn SKU. */
  async upsertListings(rows: ListingStateRow[]): Promise<void> {
    if (rows.length === 0) return;
    const bySeller = new Map<string, ListingUpsertPayload[]>();
    for (const row of rows) {
      const list = bySeller.get(row.sellerAccountId) ?? [];
      list.push(buildListingPayload(row));
      bySeller.set(row.sellerAccountId, list);
    }
    for (const [sellerAccountId, payload] of bySeller) {
      await this.request("POST", RPC_PATHS.upsertListings, {
        body: { p_seller: sellerAccountId, p_rows: payload },
      });
    }
  }

  /* ==========================================================================
   * MODULE 5 PHẦN 1 (0020) — AMAZON ADS + TOKEN PLATFORM
   * Mọi đường ghi đều đi qua RPC security-definer chỉ service_role cấp quyền
   * (web/authenticated KHÔNG gọi được): xem section 20 của 0020.
   * ========================================================================*/

  private adsCounts(result: unknown): { inserted: number; updated: number; skipped: number; merged: number } {
    const row = (Array.isArray(result) ? result[0] : result) as Record<string, unknown> | undefined;
    return {
      inserted: Number(row?.inserted ?? 0),
      updated: Number(row?.updated ?? 0),
      skipped: Number(row?.skipped ?? 0),
      merged: Number(row?.merged ?? 0),
    };
  }

  private adsMetricCounts(result: unknown): AdsMetricCounts {
    const row = (Array.isArray(result) ? result[0] : result) as Record<string, unknown> | undefined;
    return {
      ...this.adsCounts(result),
      days: row?.days === null || row?.days === undefined ? null : Number(row.days),
      currencies: row?.currencies === null || row?.currencies === undefined ? null : String(row.currencies),
    };
  }

  async upsertAdsProfiles(
    sellerAccountId: string,
    rows: AdsProfileRowInput[],
  ): Promise<AdsEntityCounts> {
    const result = await this.request<unknown[]>("POST", RPC_PATHS.upsertAdsProfiles, {
      body: { p_seller: sellerAccountId, p_rows: rows },
    });
    return this.adsCounts(result);
  }

  /**
   * Đọc profile đã lưu qua VIEW public (schema `ads` không expose cho PostgREST
   * — mọi đường đọc/ghi của web & worker đều đi qua view `vexim_*` + RPC).
   */
  async listAdsProfiles(sellerAccountId: string): Promise<AdsProfileRow[]> {
    const rows = await this.request<Record<string, unknown>[]>("GET", "/rest/v1/vexim_ads_profiles", {
      search: {
        seller_account_id: `eq.${sellerAccountId}`,
        select: "ads_profile_id,marketplace,currency",
      },
    });
    return (rows ?? []).map((r) => ({
      adsProfileId: String(r.ads_profile_id ?? ""),
      marketplace: String(r.marketplace ?? ""),
      currency: r.currency ? String(r.currency) : null,
    }));
  }

  async upsertAdsCampaigns(
    sellerAccountId: string,
    rows: AdsCampaignRowInput[],
  ): Promise<AdsEntityCounts> {
    const result = await this.request<unknown[]>("POST", RPC_PATHS.upsertAdsCampaigns, {
      body: { p_seller: sellerAccountId, p_rows: rows },
    });
    return this.adsCounts(result);
  }

  async upsertAdsAdGroups(
    sellerAccountId: string,
    rows: AdsAdGroupRowInput[],
  ): Promise<AdsEntityCounts> {
    const result = await this.request<unknown[]>("POST", RPC_PATHS.upsertAdsAdGroups, {
      body: { p_seller: sellerAccountId, p_rows: rows },
    });
    return this.adsCounts(result);
  }

  async upsertAdsTargets(
    sellerAccountId: string,
    rows: AdsTargetRowInput[],
  ): Promise<AdsEntityCounts> {
    const result = await this.request<unknown[]>("POST", RPC_PATHS.upsertAdsTargets, {
      body: { p_seller: sellerAccountId, p_rows: rows },
    });
    return this.adsCounts(result);
  }

  async upsertAdsCampaignMetrics(
    sellerAccountId: string,
    rows: AdsCampaignMetricRowInput[],
  ): Promise<AdsMetricCounts> {
    const result = await this.request<unknown[]>("POST", RPC_PATHS.upsertAdsCampaignMetrics, {
      body: { p_seller: sellerAccountId, p_rows: rows },
    });
    return this.adsMetricCounts(result);
  }

  async upsertAdsTargetMetrics(
    sellerAccountId: string,
    rows: AdsTargetMetricRowInput[],
  ): Promise<AdsMetricCounts> {
    const result = await this.request<unknown[]>("POST", RPC_PATHS.upsertAdsTargetMetrics, {
      body: { p_seller: sellerAccountId, p_rows: rows },
    });
    return this.adsMetricCounts(result);
  }

  async upsertAdsSearchTerms(
    sellerAccountId: string,
    rows: AdsSearchTermRowInput[],
  ): Promise<AdsMetricCounts> {
    const result = await this.request<unknown[]>("POST", RPC_PATHS.upsertAdsSearchTerms, {
      body: { p_seller: sellerAccountId, p_rows: rows },
    });
    return this.adsMetricCounts(result);
  }

  async upsertAdsProductMetrics(
    sellerAccountId: string,
    level: "advertised" | "purchased",
    rows: AdsProductMetricRowInput[],
  ): Promise<AdsMetricCounts> {
    const result = await this.request<unknown[]>("POST", RPC_PATHS.upsertAdsProductMetrics, {
      body: { p_seller: sellerAccountId, p_level: level, p_rows: rows },
    });
    return this.adsMetricCounts(result);
  }

  async upsertAdsBudgetEvents(
    sellerAccountId: string,
    rows: AdsBudgetEventRowInput[],
  ): Promise<AdsEntityCounts> {
    const result = await this.request<unknown[]>("POST", RPC_PATHS.upsertAdsBudgetEvents, {
      body: { p_seller: sellerAccountId, p_rows: rows },
    });
    return this.adsCounts(result);
  }

  async upsertAdsSuggestions(
    sellerAccountId: string,
    rows: AdsSuggestionRowInput[],
  ): Promise<AdsSuggestionCounts> {
    const result = await this.request<Record<string, unknown>[]>(
      "POST",
      RPC_PATHS.upsertAdsSuggestions,
      { body: { p_seller: sellerAccountId, p_rows: rows } },
    );
    const row = result?.[0];
    return {
      inserted: Number(row?.inserted ?? 0),
      updated: Number(row?.updated ?? 0),
      skipped: Number(row?.skipped ?? 0),
      kept: Number(row?.kept ?? 0),
    };
  }

  async applyAdsSpend(
    sellerAccountId: string,
    from: string,
    to: string,
  ): Promise<AdsSpendCounts> {
    const result = await this.request<Record<string, unknown>[]>("POST", RPC_PATHS.applyAdsSpend, {
      body: { p_seller: sellerAccountId, p_from: from, p_to: to },
    });
    const row = result?.[0];
    return {
      updated: Number(row?.updated ?? 0),
      skippedNoRow: Number(row?.skipped_no_row ?? 0),
      skippedCurrency: Number(row?.skipped_currency ?? 0),
    };
  }

  /* ---- Module 5 phần 3 (0021): hàng đợi ghi lên Amazon Ads ---- */

  async claimAdsChanges(sellerAccountId: string, limit?: number): Promise<AdsChangeRow[]> {
    const result = await this.request<Record<string, unknown>[]>("POST", RPC_PATHS.claimAdsChanges, {
      body: { p_seller: sellerAccountId, p_limit: limit ?? 20 },
    });
    return (result ?? []).map((r) => ({
      changeId: String(r.change_id ?? ""),
      entityType: String(r.entity_type ?? ""),
      entityKey: String(r.entity_key ?? ""),
      campaignId: String(r.campaign_id ?? ""),
      adGroupId: String(r.ad_group_id ?? ""),
      action: String(r.action ?? "") as AdsChangeRow["action"],
      payload: (r.payload ?? {}) as Record<string, unknown>,
      beforeValue: (r.before_value ?? null) as Record<string, unknown> | null,
      afterValue: (r.after_value ?? null) as Record<string, unknown> | null,
      adsProfileId: String(r.ads_profile_id ?? ""),
      currency: r.currency === null || r.currency === undefined ? null : String(r.currency),
      entityLabel: String(r.entity_label ?? ""),
      suggestionId: r.suggestion_id === null || r.suggestion_id === undefined ? null : String(r.suggestion_id),
      attempts: Number(r.attempts ?? 0),
    }));
  }

  async recordAdsChange(input: AdsChangeRecordInput): Promise<AdsChangeRecordResult> {
    const result = await this.request<Record<string, unknown>[]>("POST", RPC_PATHS.recordAdsChange, {
      body: {
        p_change_id: input.changeId,
        p_ok: input.ok === true,
        p_api: input.api ?? null,
        p_error: input.error ?? null,
      },
    });
    const row = result?.[0];
    return {
      changeId: String(row?.change_id ?? input.changeId),
      status: String(row?.status ?? (input.ok ? "applied" : "failed")),
      mirrored: row?.mirrored === true,
      keywordId: row?.keyword_id === null || row?.keyword_id === undefined ? null : String(row.keyword_id),
      suggestionApplied: row?.suggestion_applied === true,
    };
  }

  async releaseAdsChange(changeId: string, reason: string): Promise<AdsChangeReleaseResult> {
    const result = await this.request<Record<string, unknown>[]>("POST", RPC_PATHS.releaseAdsChange, {
      body: { p_change_id: changeId, p_reason: reason },
    });
    const row = result?.[0];
    return {
      changeId: String(row?.change_id ?? changeId),
      status: String(row?.status ?? "approved"),
      attempts: Number(row?.attempts ?? 0),
    };
  }

  /* ---- Module 0: token platform + re-authorize ---- */

  async saveOauthToken(
    sellerAccountId: string,
    token: OauthTokenInput,
  ): Promise<OauthTokenResult> {
    const result = await this.request<Record<string, unknown>[]>("POST", RPC_PATHS.setOauthToken, {
      body: { p_seller: sellerAccountId, p_token: token },
    });
    const row = result?.[0];
    return {
      id: String(row?.id ?? ""),
      authorizedAt: row?.authorized_at ? String(row.authorized_at) : null,
      expiresAt: row?.expires_at ? String(row.expires_at) : null,
      daysLeft: row?.days_left === null || row?.days_left === undefined ? null : Number(row.days_left),
      refreshCount:
        row?.refresh_count === null || row?.refresh_count === undefined
          ? null
          : Number(row.refresh_count),
      replaced: row?.replaced === true,
    };
  }

  async createOauthState(
    sellerAccountId: string,
    redirectTo?: string | null,
    ttlMinutes?: number | null,
  ): Promise<OauthStateResult> {
    const result = await this.request<Record<string, unknown>[]>("POST", RPC_PATHS.createOauthState, {
      body: { p_seller: sellerAccountId, p_redirect_to: redirectTo ?? null, p_ttl_min: ttlMinutes ?? 30 },
    });
    const row = result?.[0];
    return {
      state: String(row?.state ?? ""),
      expiresAt: row?.expires_at ? String(row.expires_at) : null,
    };
  }

  async consumeOauthState(state: string): Promise<OauthConsumeResult> {
    const result = await this.request<Record<string, unknown>[]>(
      "POST",
      RPC_PATHS.consumeOauthState,
      { body: { p_state: state } },
    );
    const row = result?.[0];
    return {
      ok: row?.ok === true,
      sellerAccountId: row?.seller_account_id ? String(row.seller_account_id) : null,
      redirectTo: row?.redirect_to ? String(row.redirect_to) : null,
      message: String(row?.message ?? ""),
    };
  }

  async markOauthNotice(sellerAccountId: string): Promise<{ rotateReminderSent: boolean }> {
    const result = await this.request<Record<string, unknown>[]>("POST", RPC_PATHS.markOauthNotice, {
      body: { p_seller: sellerAccountId },
    });
    return { rotateReminderSent: result?.[0]?.rotate_reminder_sent === true };
  }

  async listOauthSoon(days?: number | null): Promise<OauthSoonRow[]> {
    const result = await this.request<Record<string, unknown>[]>("POST", RPC_PATHS.oauthSoon, {
      body: { p_days: days ?? null },
    });
    return (result ?? []).map((row) => ({
      sellerAccountId: String(row?.seller_account_id ?? ""),
      shop: row?.shop ? String(row.shop) : null,
      sellerId: row?.seller_id ? String(row.seller_id) : null,
      marketplace: row?.marketplace ? String(row.marketplace) : null,
      authorizedAt: row?.authorized_at ? String(row.authorized_at) : null,
      expiresAt: row?.expires_at ? String(row.expires_at) : null,
      daysLeft: row?.days_left === null || row?.days_left === undefined ? null : Number(row.days_left),
      noticeDays:
        row?.notice_days === null || row?.notice_days === undefined ? null : Number(row.notice_days),
      needsReauth: row?.needs_reauth === true,
      alreadyNoticed: row?.already_noticed === true,
      tokenActive: row?.token_active === true,
      adsProfiles: Number(row?.ads_profiles ?? 0),
    }));
  }
}
