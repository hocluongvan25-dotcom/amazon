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
  DbAdapter,
  InventorySnapshotRow,
  InventoryDailyRow,
  ListingStateRow,
  NotificationRecord,
  SyncJobRecord,
  AlertRowInput,
  ActiveShop,
} from "./adapter.ts";

type Json = unknown;

/** Schema nghiệp vụ VEXIM — value truyền vào header Accept/Content-Profile. */
type SchemaName = "connections" | "inventory" | "ops";

/**
 * Schema mặc định của PostgREST (public) — RPC ở đây thì KHÔNG set header
 * profile, vì PostgREST resolve theo schema đầu tiên trong db-schemas.
 */
const RPC_PATHS = {
  activeProductionShops: "/rest/v1/rpc/active_production_shops",
  unitsSoldPerDay: "/rest/v1/rpc/units_sold_per_day",
} as const;

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
      throw new Error(`Supabase ${method} ${path} → ${res.status}: ${await res.text().catch(() => "")}`);
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

  // ---------- Stubs cho Tier sau ----------
  async recordNotification(_row: NotificationRecord): Promise<void> {}
  async upsertListing(_row: ListingStateRow): Promise<void> {}
}
