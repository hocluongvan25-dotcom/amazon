/**
 * AdsDb — cổng ghi/đọc Supabase cho đồng bộ Ads (service_role, gọi REST bằng fetch).
 *
 * Vì sao KHÔNG nhét vào `lib/worker/db/supabase.ts` (SupabaseDbAdapter):
 *   adapter đó là interface DbAdapter 51KB dùng chung cho mọi job + có MockDbAdapter;
 *   thêm 11 method Ads vào đó bắt phải sửa cả mock và mọi job. Module 5 chỉ cần một
 *   mặt cắt hẹp (token + 11 RPC 0020) nên tách riêng: dễ test bằng fetch giả, và
 *   hỏng thì chỉ hỏng Ads.
 *
 * HAI QUY TẮC POSTGREST (sai là PGRST202/PGRST205, đã trả giá ở migration 0008):
 *   1. path KHÔNG có tiền tố schema:  /rest/v1/oauth_tokens  (không phải connections.oauth_tokens)
 *   2. chọn schema bằng header: Accept-Profile / Content-Profile = connections
 *   RPC nằm ở public → không cần header.
 */
import type { AdsTokenRow, TokenStore } from "./tokens.ts";
import type { PpcChangeRequest, PpcChangeType, PpcEntityType } from "./write.ts";

export class AdsDbError extends Error {
  readonly code: string;
  readonly hint: string | null;
  constructor(message: string, opts: { code?: string; hint?: string | null } = {}) {
    super(message);
    this.name = "AdsDbError";
    this.code = opts.code ?? "db_error";
    this.hint = opts.hint ?? null;
  }
}

export const ADS_RPC = {
  upsertProfiles: "vexim_worker_upsert_ads_profiles",
  upsertCampaigns: "vexim_worker_upsert_ads_campaigns",
  upsertMetrics: "vexim_worker_upsert_ads_metrics",
  upsertTargeting: "vexim_worker_upsert_ads_targeting",
  upsertSearchTerms: "vexim_worker_upsert_ads_search_terms",
  upsertAdvertised: "vexim_worker_upsert_ads_advertised",
  upsertBudgetUsage: "vexim_worker_upsert_ads_budget_usage",
  setReportRequest: "vexim_worker_set_ads_report_request",
  pendingReports: "vexim_worker_pending_ads_reports",
  raiseAlerts: "vexim_ads_raise_alerts",
  fillProfitAdsSpend: "vexim_worker_fill_profit_ads_spend",
  recordEvent: "vexim_oauth_record_event",
  /** Module 5 PHẦN 2&3 (migration 0021) — chiều GHI PPC. */
  ppcPendingChanges: "vexim_worker_ppc_pending_changes",
  ppcSetResult: "vexim_worker_ppc_set_result",
  ppcRaiseAlerts: "vexim_ppc_raise_alerts",
} as const;

/** Cột đọc từ connections.oauth_tokens — KHÔNG select encrypted token ngoài lúc cần đổi. */
const TOKEN_SELECT = [
  "id",
  "seller_account_id",
  "encrypted_refresh_token",
  "status",
  "expires_at",
  "reauthorize_at",
  "last_refresh_at",
  "last_error",
  "client_id",
  "scope",
  "ads_account_id",
].join(",");

export const SHOP_SELECT = ["id", "display_name", "marketplace", "status", "data_source"].join(",");

export type AdsShop = {
  id: string;
  displayName: string;
  marketplace: string | null;
  status: string | null;
  dataSource: string | null;
};

/** Cột đọc khi dryRun duyệt hàng đợi (không giành lô). */
export const PPC_REQUEST_SELECT = [
  "id",
  "seller_account_id",
  "ads_profile_id",
  "entity_type",
  "change_type",
  "amazon_entity_id",
  "campaign_id",
  "ad_group_id",
  "label",
  "match_type",
  "currency",
  "before_value",
  "after_value",
  "delta_pct",
  "attempts",
  "batch_id",
  "status",
  "proposed_at",
  "decided_at",
  "expires_at",
  "claimed_at",
  "last_error",
].join(",");

/** Đổi tên cột snake_case (RPC/bảng) → PpcChangeRequest của write.ts. */
function toPpcRequest(r: Record<string, unknown>): PpcChangeRequest {
  return {
    requestId: String(r.request_id ?? r.id ?? ""),
    sellerAccountId: String(r.seller_account_id ?? ""),
    shop: toStr(r.shop),
    adsProfileId: toStr(r.ads_profile_id) ?? "",
    entityType: (toStr(r.entity_type) ?? "campaign") as PpcEntityType,
    changeType: (toStr(r.change_type) ?? "bid") as PpcChangeType,
    amazonEntityId: toStr(r.amazon_entity_id) ?? "",
    campaignId: toStr(r.campaign_id) ?? "",
    adGroupId: toStr(r.ad_group_id) ?? "",
    label: toStr(r.label) ?? "",
    matchType: toStr(r.match_type),
    currency: toStr(r.currency),
    beforeValue: asRecord(r.before_value),
    afterValue: asRecord(r.after_value),
    deltaPct: toNumOrNull(r.delta_pct),
    attempts: toNum(r.attempts),
    batchId: toStr(r.batch_id),
    campaignType: toStr(r.campaign_type),
    campaignName: toStr(r.campaign_name),
    campaignState: toStr(r.campaign_state),
    campaignDailyBudget: toNumOrNull(r.campaign_daily_budget),
    status: toStr(r.status),
    lastError: toStr(r.last_error),
    proposedAt: toStr(r.proposed_at),
    decidedAt: toStr(r.decided_at),
    expiresAt: toStr(r.expires_at),
    claimedAt: toStr(r.claimed_at),
  };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return null;
}

export type AdsReportRequestInput = {
  reportTypeId: string;
  adsProfileId?: string | null;
  adProduct?: string;
  groupBy?: string;
  timeUnit?: "DAILY" | "SUMMARY";
  dateStart?: string | null;
  dateEnd?: string | null;
  adsReportId?: string | null;
  status?: string;
  failureReason?: string | null;
  downloadUrl?: string | null;
  rowsImported?: number | null;
  attempts?: number | null;
  lastError?: string | null;
  requestedAt?: string | null;
  completedAt?: string | null;
  importedAt?: string | null;
};

export type AdsReportRequestRow = {
  id: string;
  status: string;
  adsReportId: string | null;
};

export type PendingAdsReport = {
  sellerAccountId: string;
  adsProfileId: string | null;
  reportTypeId: string;
  adProduct: string | null;
  groupBy: string | null;
  timeUnit: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  adsReportId: string;
  status: string;
  attempts: number;
  lastError: string | null;
  requestedAt: string | null;
  marketplace: string | null;
};

export type UpsertCounts = {
  inserted: number;
  updated: number;
  rowsWritten: number;
  skipped: number;
  merged: number;
  days: number | null;
  extra: Record<string, number | string | null>;
};

export type AdsAlertRow = {
  shopId: string;
  shopName: string | null;
  ruleCode: string;
  entityKey: string | null;
  severity: string | null;
  metric: number | null;
  threshold: number | null;
  alertId: string | null;
  nextAction: string | null;
};

/** Một đề xuất ĐÃ DUYỆT trong hàng đợi, do RPC worker trả về (đã đổi tên cột). */
export type PpcCapLeft = {
  sellerAccountId: string;
  shop: string | null;
  dailyCap: number;
  usedToday: number;
  waiting: number;
};

/** Lô hàng RPC "giành" cho cron: status approved → applying + batch_id + attempts+1. */
export type PpcPendingBatch = {
  batchId: string | null;
  expired: number;
  reclaimed: number;
  skippedUnsupported: number;
  count: number;
  capLeft: PpcCapLeft[];
  requests: PpcChangeRequest[];
};

/** Kết quả MỘT dòng sau khi gọi Amazon (RPC chỉ nhận applied/failed/skipped). */
export type PpcResultRow = {
  id: string;
  status: "applied" | "failed" | "skipped";
  batchId?: string | null;
  error?: string | null;
  /** id Amazon trả về khi TẠO negative keyword (để lần sau bật/tắt bằng id thật) */
  createdId?: string | null;
  amazonResponse?: Record<string, unknown> | null;
  /** cron đã đọc lại Amazon và khớp before_value (audit ghi giá trị này) */
  verifiedBefore?: boolean;
};

export type PpcSetResultRow = {
  ok: boolean;
  id: string;
  status: string;
  label: string | null;
  entityType: string | null;
  changeType: string | null;
  attempts: number;
  createdId: string | null;
  alertId: string | null;
  error: string | null;
};

export type FillAdsSpendResult = {
  rowsUpdated: number;
  days: number;
  skus: number;
  unmatched: number;
  currencies: string[];
};

export interface AdsDb extends TokenStore {
  listShops(): Promise<AdsShop[]>;
  getAdsToken(shopId: string): Promise<AdsTokenRow | null>;
  touchAdsToken(
    id: string,
    patch: { lastRefreshAt?: string; lastError?: string | null; status?: string },
  ): Promise<void>;
  upsertProfiles(seller: string, rows: unknown[]): Promise<UpsertCounts>;
  upsertCampaigns(seller: string, rows: unknown[]): Promise<UpsertCounts>;
  upsertMetrics(seller: string, rows: unknown[]): Promise<UpsertCounts>;
  upsertTargeting(seller: string, rows: unknown[]): Promise<UpsertCounts>;
  upsertSearchTerms(seller: string, rows: unknown[]): Promise<UpsertCounts>;
  upsertAdvertised(seller: string, rows: unknown[]): Promise<UpsertCounts>;
  upsertBudgetUsage(seller: string, rows: unknown[]): Promise<UpsertCounts>;
  setReportRequest(seller: string, req: AdsReportRequestInput): Promise<AdsReportRequestRow>;
  pendingReports(opts?: {
    seller?: string | null;
    statuses?: string;
    limit?: number;
  }): Promise<PendingAdsReport[]>;
  raiseAlerts(seller: string | null, day?: string | null): Promise<AdsAlertRow[]>;
  fillProfitAdsSpend(seller: string, opts?: { from?: string | null; to?: string | null }): Promise<FillAdsSpendResult>;
  /** Giành lô đề xuất đã duyệt (RPC tự quét TTL, đòi lại lô kẹt, skip non-SP). */
  pendingChanges(shopId: string | null, limit?: number, staleMinutes?: number): Promise<PpcPendingBatch>;
  /** Đọc đề xuất approved mà KHÔNG giành lô — chỉ cho dryRun. */
  listApprovedChanges(shopId: string | null, limit?: number): Promise<PpcChangeRequest[]>;
  /** Ghi kết quả áp dụng của MỘT dòng (kèm audit + upsert negative keyword + alert). */
  setChangeResult(row: PpcResultRow): Promise<PpcSetResultRow>;
  /** Nổ/đóng alert của hàng đợi PPC cho MỘT shop (cuối mỗi lượt cron). */
  raisePpcAlerts(shopId: string | null): Promise<AdsAlertRow[]>;
  recordEvent(input: {
    sellerAccountId?: string | null;
    service?: "ads" | "spapi";
    event: string;
    status?: "ok" | "error";
    detail?: string;
  }): Promise<string | null>;
}

export type AdsDbConfig = { url: string; serviceRoleKey: string };

function toNum(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function toNumOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

export function createAdsDb(cfg: AdsDbConfig, fetchFn: typeof fetch = fetch): AdsDb {
  const base = cfg.url.replace(/\/+$/, "");

  async function call<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    opts: { body?: unknown; schema?: string; prefer?: string; accept?: string } = {},
  ): Promise<T> {
    // Chỉ soi PHẦN PATH, bỏ query string: query chứa "eq.ads"/"eq.active" (có dấu chấm)
    // mà đem test luôn là bắt nhầm.
    const rawPath = path.split("?")[0];
    const bare = rawPath.replace(/^\/rest\/v1\//, "");
    if (bare.includes(".")) {
      throw new AdsDbError(
        `AdsDb: path không được chứa tiền tố schema ("${rawPath}") — PostgREST sẽ trả PGRST205.`,
        { code: "bad_path", hint: `Dùng "/rest/v1/${bare.split(".")[1]}" + schema="${bare.split(".")[0]}".` },
      );
    }
    const headers: Record<string, string> = {
      apikey: cfg.serviceRoleKey,
      Authorization: `Bearer ${cfg.serviceRoleKey}`,
      Accept: opts.accept ?? "application/json",
    };
    if (opts.schema) {
      headers["Accept-Profile"] = opts.schema;
      headers["Content-Profile"] = opts.schema;
    }
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.prefer) headers.Prefer = opts.prefer;

    let res: Response;
    try {
      res = await fetchFn(`${base}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch (e) {
      throw new AdsDbError(`Không gọi được Supabase (${method} ${path}): ${(e as Error).message}`, {
        code: "network",
        hint: "Kiểm tra NEXT_PUBLIC_SUPABASE_URL và mạng của cron.",
      });
    }

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      let code = "";
      let message = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { code?: string; message?: string; hint?: string; details?: string };
        code = j.code ?? "";
        message = j.message ?? message;
        if (j.hint) message += ` · ${j.hint}`;
      } catch {
        // text không phải JSON
      }
      // PGRST202 = không tìm thấy hàm/bảng → gần như chắc chắn chưa chạy migration 0020.
      if (code === "PGRST202" || code === "42P01" || /could not find the function/i.test(message)) {
        throw new AdsDbError(`Supabase không có hàm/bảng cần dùng: ${message}`, {
          code: "missing_rpc",
          hint:
            "Chạy migration supabase/migrations/0020_module0_oauth_module5_ppc_read.sql trên project, " +
            "và kiểm tra Settings → API → Exposed schemas có 'connections' + 'ads'.",
        });
      }
      throw new AdsDbError(`Supabase trả HTTP ${res.status} cho ${method} ${path}: ${message}`, { code });
    }
    if (!text) return undefined as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AdsDbError(`Phản hồi không phải JSON từ ${path}: ${text.slice(0, 200)}`, { code: "bad_json" });
    }
  }

  async function rpc<T>(fn: string, payload: Record<string, unknown>): Promise<T> {
    const out = await call<T>("POST", `/rest/v1/rpc/${fn}`, {
      body: payload,
      prefer: "params=single-object",
    });
    // PostgREST có thể trả 1 object (returns table 1 dòng) hoặc mảng.
    return out;
  }

  function first<T>(rows: T | T[] | null | undefined): T | null {
    if (Array.isArray(rows)) return rows[0] ?? null;
    return (rows as T) ?? null;
  }

  function toCounts(rows: unknown): UpsertCounts {
    const r = (first<Record<string, unknown>>(rows as Record<string, unknown>[]) ?? {}) as Record<string, unknown>;
    const known = new Set([
      "inserted",
      "updated",
      "skipped",
      "merged",
      "rows_written",
      "days",
      "profiles",
      "campaigns",
      "terms",
      "exhausted",
      "currencies",
    ]);
    const extra: Record<string, number | string | null> = {};
    for (const [k, v] of Object.entries(r)) {
      if (!known.has(k)) continue;
      if (["inserted", "updated", "skipped", "merged", "rows_written", "days"].includes(k)) continue;
      extra[k] = typeof v === "string" || typeof v === "number" ? v : null;
    }
    return {
      inserted: toNum(r.inserted),
      updated: toNum(r.updated),
      rowsWritten: toNum(r.rows_written),
      skipped: toNum(r.skipped),
      merged: toNum(r.merged),
      days: toNumOrNull(r.days),
      extra,
    };
  }

  async function upsert(fn: string, seller: string, rows: unknown[]): Promise<UpsertCounts> {
    if (!seller) throw new AdsDbError("Thiếu seller_account_id khi ghi dữ liệu Ads.", { code: "missing_seller" });
    if (!Array.isArray(rows)) throw new AdsDbError("p_rows phải là mảng.", { code: "bad_rows" });
    if (rows.length === 0) {
      return { inserted: 0, updated: 0, rowsWritten: 0, skipped: 0, merged: 0, days: null, extra: {} };
    }
    const out = await rpc<unknown>(fn, { p_seller: seller, p_rows: rows });
    return toCounts(out);
  }

  return {
    async listShops() {
      const rows = await call<Record<string, unknown>[]>(
        "GET",
        `/rest/v1/seller_accounts?select=${encodeURIComponent(SHOP_SELECT)}&status=eq.active&order=display_name.asc`,
        { schema: "connections" },
      );
      return (rows ?? []).map((r) => ({
        id: String(r.id ?? ""),
        displayName: toStr(r.display_name) ?? "(chưa đặt tên)",
        marketplace: toStr(r.marketplace),
        status: toStr(r.status),
        dataSource: toStr(r.data_source),
      }));
    },

    async getAdsToken(shopId) {
      const rows = await call<Record<string, unknown>[]>(
        "GET",
        `/rest/v1/oauth_tokens?select=${encodeURIComponent(TOKEN_SELECT)}` +
          `&seller_account_id=eq.${encodeURIComponent(shopId)}&service=eq.ads&limit=1`,
        { schema: "connections" },
      );
      const r = (rows ?? [])[0];
      if (!r) return null;
      return {
        id: String(r.id ?? ""),
        sellerAccountId: String(r.seller_account_id ?? shopId),
        encryptedRefreshToken: String(r.encrypted_refresh_token ?? ""),
        status: toStr(r.status),
        expiresAt: toStr(r.expires_at),
        reauthorizeAt: toStr(r.reauthorize_at),
        lastRefreshAt: toStr(r.last_refresh_at),
        lastError: toStr(r.last_error),
        clientId: toStr(r.client_id),
        scope: toStr(r.scope),
        adsAccountId: toStr(r.ads_account_id),
      };
    },

    async touchAdsToken(id, patch) {
      const body: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (patch.lastRefreshAt !== undefined) body.last_refresh_at = patch.lastRefreshAt;
      if (patch.lastError !== undefined) body.last_error = patch.lastError;
      if (patch.status !== undefined) body.status = patch.status;
      await call(
        "PATCH",
        `/rest/v1/oauth_tokens?id=eq.${encodeURIComponent(id)}`,
        { body, schema: "connections", prefer: "return=minimal" },
      );
    },

    upsertProfiles: (seller, rows) => upsert(ADS_RPC.upsertProfiles, seller, rows),
    upsertCampaigns: (seller, rows) => upsert(ADS_RPC.upsertCampaigns, seller, rows),
    upsertMetrics: (seller, rows) => upsert(ADS_RPC.upsertMetrics, seller, rows),
    upsertTargeting: (seller, rows) => upsert(ADS_RPC.upsertTargeting, seller, rows),
    upsertSearchTerms: (seller, rows) => upsert(ADS_RPC.upsertSearchTerms, seller, rows),
    upsertAdvertised: (seller, rows) => upsert(ADS_RPC.upsertAdvertised, seller, rows),
    upsertBudgetUsage: (seller, rows) => upsert(ADS_RPC.upsertBudgetUsage, seller, rows),

    async setReportRequest(seller, req) {
      const payload: Record<string, unknown> = {
        reportTypeId: req.reportTypeId,
        adsProfileId: req.adsProfileId ?? "",
        adProduct: req.adProduct ?? "SPONSORED_PRODUCTS",
        groupBy: req.groupBy ?? "",
        timeUnit: req.timeUnit ?? "DAILY",
        dateStart: req.dateStart ?? null,
        dateEnd: req.dateEnd ?? null,
        adsReportId: req.adsReportId ?? null,
        status: req.status ?? "requested",
        failureReason: req.failureReason ?? null,
        downloadUrl: req.downloadUrl ?? null,
        rowsImported: req.rowsImported ?? null,
        attempts: req.attempts ?? null,
        lastError: req.lastError ?? null,
        requestedAt: req.requestedAt ?? null,
        completedAt: req.completedAt ?? null,
        importedAt: req.importedAt ?? null,
      };
      const out = await rpc<unknown>(ADS_RPC.setReportRequest, { p_seller: seller, p_req: payload });
      const row = first<Record<string, unknown>>(out as Record<string, unknown>[]) ?? {};
      return {
        id: String(row.id ?? ""),
        status: toStr(row.status) ?? "requested",
        adsReportId: toStr(row.ads_report_id),
      };
    },

    async pendingReports(opts = {}) {
      const out = await rpc<unknown>(ADS_RPC.pendingReports, {
        p_seller: opts.seller ?? null,
        p_statuses: opts.statuses ?? "requested,processing",
        p_limit: opts.limit ?? 50,
      });
      const rows = (Array.isArray(out) ? out : []) as Record<string, unknown>[];
      return rows.map((r) => ({
        sellerAccountId: String(r.seller_account_id ?? ""),
        adsProfileId: toStr(r.ads_profile_id),
        reportTypeId: String(r.report_type_id ?? ""),
        adProduct: toStr(r.ad_product),
        groupBy: toStr(r.group_by),
        timeUnit: toStr(r.time_unit),
        dateStart: toStr(r.date_start),
        dateEnd: toStr(r.date_end),
        adsReportId: String(r.ads_report_id ?? ""),
        status: String(r.status ?? ""),
        attempts: toNum(r.attempts),
        lastError: toStr(r.last_error),
        requestedAt: toStr(r.requested_at),
        marketplace: toStr(r.marketplace),
      }));
    },

    async raiseAlerts(seller, day) {
      const out = await rpc<unknown>(ADS_RPC.raiseAlerts, { p_seller: seller, p_day: day ?? null });
      const rows = (Array.isArray(out) ? out : out ? [out] : []) as Record<string, unknown>[];
      return rows.map((r) => ({
        shopId: String(r.shop_id ?? ""),
        shopName: toStr(r.shop_name),
        ruleCode: String(r.rule_code ?? ""),
        entityKey: toStr(r.entity_key),
        severity: toStr(r.severity),
        metric: toNumOrNull(r.metric),
        threshold: toNumOrNull(r.threshold),
        alertId: toStr(r.alert_id),
        nextAction: toStr(r.next_action),
      }));
    },

    async fillProfitAdsSpend(seller, opts = {}) {
      const out = await rpc<unknown>(ADS_RPC.fillProfitAdsSpend, {
        p_seller: seller,
        p_from: opts.from ?? null,
        p_to: opts.to ?? null,
      });
      const r = (first<Record<string, unknown>>(out as Record<string, unknown>[]) ?? {}) as Record<string, unknown>;
      return {
        rowsUpdated: toNum(r.rows_updated),
        days: toNum(r.days),
        skus: toNum(r.skus),
        unmatched: toNum(r.unmatched),
        currencies: toStr(r.currencies)?.split(",").map((c) => c.trim()).filter(Boolean) ?? [],
      };
    },

    async pendingChanges(shopId, limit, staleMinutes) {
      const out = await rpc<unknown>(ADS_RPC.ppcPendingChanges, {
        p_seller: shopId ?? null,
        p_limit: limit ?? 100,
        p_stale_minutes: staleMinutes ?? 30,
      });
      const r = (first<Record<string, unknown>>(out as Record<string, unknown>[]) ?? {}) as Record<string, unknown>;
      const rows = Array.isArray(r.requests) ? (r.requests as Record<string, unknown>[]) : [];
      const caps = Array.isArray(r.cap_left) ? (r.cap_left as Record<string, unknown>[]) : [];
      return {
        batchId: toStr(r.batch_id),
        expired: toNum(r.expired),
        reclaimed: toNum(r.reclaimed),
        skippedUnsupported: toNum(r.skipped_unsupported),
        count: toNum(r.count),
        capLeft: caps.map((c) => ({
          sellerAccountId: String(c.seller_account_id ?? ""),
          shop: toStr(c.shop),
          dailyCap: toNum(c.daily_cap),
          usedToday: toNum(c.used_today),
          waiting: toNum(c.waiting),
        })),
        requests: rows.map(toPpcRequest),
      };
    },

    async listApprovedChanges(shopId, limit) {
      // dryRun: đọc thẳng hàng đợi qua PostgREST, KHÔNG giành lô.
      const params = new URLSearchParams({
        select: PPC_REQUEST_SELECT,
        status: "eq.approved",
        order: "decided_at.asc,proposed_at.asc",
        limit: String(limit ?? 100),
      });
      if (shopId) params.set("seller_account_id", `eq.${shopId}`);
      const rows = await call<Record<string, unknown>[]>("GET", `/rest/v1/change_requests?${params.toString()}`, {
        schema: "ads",
      });
      const requests = (rows ?? []).map(toPpcRequest);
      // campaign_type không nằm trong ads.change_requests → đọc thêm để dryRun nói
      // thật là dòng nào sẽ bị skip (chiều ghi chỉ mở cho Sponsored Products).
      const campaignIds = [...new Set(requests.map((r) => r.campaignId).filter(Boolean))];
      if (campaignIds.length > 0) {
        const q = new URLSearchParams({
          select: "campaign_id,campaign_type",
          campaign_id: `in.(${campaignIds.map((c) => `"${c}"`).join(",")})`,
        });
        if (shopId) q.set("seller_account_id", `eq.${shopId}`);
        try {
          const camps = await call<Record<string, unknown>[]>("GET", `/rest/v1/campaigns?${q.toString()}`, {
            schema: "ads",
          });
          const byId = new Map<string, string>();
          for (const c of camps ?? []) {
            const id = toStr(c.campaign_id);
            if (id) byId.set(id, toStr(c.campaign_type) ?? "");
          }
          for (const r of requests) r.campaignType = byId.get(r.campaignId) ?? r.campaignType;
        } catch {
          // không đọc được campaign_type thì dryRun coi như SP (RPC giành lô mới là
          // lớp chắn thật: nó đã tự skip non-SP trước khi giao cho cron).
        }
      }
      return requests;
    },

    async setChangeResult(row) {
      const out = await rpc<unknown>(ADS_RPC.ppcSetResult, {
        p_payload: {
          id: row.id,
          status: row.status,
          batch_id: row.batchId ?? null,
          error: row.error ?? null,
          created_id: row.createdId ?? null,
          amazon_response: row.amazonResponse ?? null,
          verified_before: row.verifiedBefore ?? false,
        },
      });
      const r = (first<Record<string, unknown>>(out as Record<string, unknown>[]) ?? {}) as Record<string, unknown>;
      return {
        ok: r.ok === true,
        id: String(r.id ?? row.id),
        status: toStr(r.status) ?? row.status,
        label: toStr(r.label),
        entityType: toStr(r.entity_type),
        changeType: toStr(r.change_type),
        attempts: toNum(r.attempts),
        createdId: toStr(r.created_id),
        alertId: toStr(r.alert_id),
        error: toStr(r.error),
      };
    },

    async raisePpcAlerts(shopId) {
      const out = await rpc<unknown>(ADS_RPC.ppcRaiseAlerts, { p_seller: shopId ?? null });
      const rows = (Array.isArray(out) ? out : out ? [out] : []) as Record<string, unknown>[];
      return rows.map((r) => ({
        shopId: String(r.shop_id ?? ""),
        shopName: toStr(r.shop_name),
        ruleCode: String(r.rule_code ?? ""),
        entityKey: toStr(r.entity_key),
        severity: toStr(r.severity),
        metric: toNumOrNull(r.metric),
        threshold: toNumOrNull(r.threshold),
        alertId: toStr(r.alert_id),
        nextAction: toStr(r.next_action),
      }));
    },

    async recordEvent(input) {
      try {
        const out = await rpc<unknown>(ADS_RPC.recordEvent, {
          p_payload: {
            sellerAccountId: input.sellerAccountId ?? null,
            service: input.service ?? "ads",
            event: input.event,
            status: input.status ?? "ok",
            detail: input.detail ?? null,
          },
        });
        const id = typeof out === "string" ? out : toStr((first<Record<string, unknown>>(out as Record<string, unknown>[]) ?? {}).id);
        return id;
      } catch {
        // Audit không được làm hỏng luồng đồng bộ.
        return null;
      }
    },
  };
}
