/**
 * SupabaseDbAdapter — ghi/đọc dữ liệu xuống Supabase (service_role).
 *
 * Không dùng @supabase/supabase-js để worker nhẹ — gọi REST API với fetch.
 * Không đi qua RLS (service_role bypass). Khớp DbAdapter interface.
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
    opts?: { body?: unknown; prefer?: string; search?: Record<string, string> },
  ): Promise<T> {
    const u = new URL(`${this.url}${path}`);
    if (opts?.search) Object.entries(opts.search).forEach(([k, v]) => u.searchParams.set(k, v));
    const headers: Record<string, string> = {
      apikey: this.serviceKey,
      Authorization: `Bearer ${this.serviceKey}`,
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
    await this.request("POST", "/rest/v1/inventory.inventory_snapshots", {
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
    await this.request("POST", "/rest/v1/inventory.inventory_daily", {
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
   * Sử dụng RPC inventory.units_sold_per_day đã tạo ở migration 0005.
   */
  async getSellingDays(sellerAccountId: string, sku: string, days: number): Promise<number[]> {
    try {
      const rows = await this.request<{ d: string; q: number }[]>(
        "POST",
        "/rest/v1/rpc/inventory.units_sold_per_day",
        {
          body: { p_seller: sellerAccountId, p_sku: sku, p_days: days },
        },
      );
      if (!Array.isArray(rows)) return new Array(days).fill(0);
      return rows.map((r) => Number(r.q) || 0);
    } catch {
      // RPC chưa có (migration 0005 chưa chạy) → trả rỗng, velocity=0
      return [];
    }
  }

  // ---------- Shops ----------
  async listActiveProductionShops(): Promise<ActiveShop[]> {
    try {
      const rows = await this.request<ActiveShop[]>(
        "POST",
        "/rest/v1/rpc/connections.active_production_shops",
        {},
      );
      if (Array.isArray(rows)) return rows;
    } catch {
      // fallthrough đến truy vấn trực tiếp
    }
    // Fallback nếu RPC chưa có — truy vấn trực tiếp (data_source='production' và status='active')
    const rows = await this.request<
      { id: string; seller_id: string; marketplace: string; display_name: string }[]
    >("GET", "/rest/v1/connections.seller_accounts", {
      search: {
        select: "id,seller_id,marketplace,display_name",
        status: "eq.active",
        data_source: "eq.production",
      },
    });
    return (rows ?? []).map((r) => ({
      id: r.id,
      sellerId: r.seller_id,
      marketplace: r.marketplace,
      displayName: r.display_name,
      leadDays: 32,
      safetyDays: 14,
    }));
  }

  // ---------- Sync jobs ----------
  async recordSyncJob(job: SyncJobRecord): Promise<void> {
    if (job.id) {
      await this.request("PATCH", `/rest/v1/connections.sync_jobs`, {
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
        "/rest/v1/connections.sync_jobs",
        {
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
    const rules = await this.request<{ id: string }[]>("GET", "/rest/v1/ops.alert_rules", {
      search: { rule_code: `eq.${input.ruleCode}`, select: "id", is_active: "eq.true" },
    });
    const ruleId = rules?.[0]?.id ?? null;

    // Chỉ insert nếu chưa có alert open trùng trong 24h qua
    const existing = await this.request<{ id: string }[]>("GET", "/rest/v1/ops.alerts", {
      search: {
        seller_account_id: `eq.${input.sellerAccountId}`,
        title: `eq.${input.title}`,
        status: "eq.open",
        select: "id",
        fired_at: `gte.${new Date(Date.now() - 86_400_000).toISOString()}`,
      },
    });
    if (Array.isArray(existing) && existing.length > 0) return;

    await this.request("POST", "/rest/v1/ops.alerts", {
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
