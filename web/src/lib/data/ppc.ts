/**
 * Supabase reader cho màn A1 — QUẢNG CÁO (Module 5 phần 1).
 *
 *   • vexim_ads_kpi             — KPI theo shop × tiền tệ (7/14/30 ngày)
 *   • vexim_ads_campaigns       — bảng campaign + ACOS/ROAS + trạng thái ngân sách
 *   • vexim_ads_budget_events   — ngày cạn ngân sách (để giải thích "vì sao hết đơn")
 *   • vexim_ads_negative_suggestions — số gợi ý negative đang chờ duyệt (A3)
 *   • vexim_sku_profit          — doanh thu sản phẩm để tính TACOS THẬT
 *
 * Cả 5 view đều `security_invoker` ⇒ RLS bảng gốc vẫn áp (user chỉ thấy shop được
 * gán qua `iam.can_read_seller_account`).
 *
 * Dữ liệu chỉ có sau khi worker chạy (các script nằm trong gói `worker/`, KHÔNG phải
 * `web/` — đứng ở thư mục gốc repo thì `cd worker` trước):
 *   npm run worker:ads-sync    (profile → campaign → ad group → target)
 *   npm run worker:ads-pull    (5 report metrics qua Reporting API v3)
 * hoặc Vercel Cron /api/cron/report-pull (02:00 inventory · 03:00 reports + ads).
 */

import { createClient } from "@/lib/supabase/server";
import { readAll } from "./inventory-model";
import type {
  AdsAdGroupRaw,
  AdsAuditRaw,
  AdsBudgetEventRaw,
  AdsCampaignRaw,
  AdsChangeRaw,
  AdsKpiRaw,
  AdsNegativeKeywordRaw,
  AdsSearchTermRaw,
  AdsTargetRaw,
} from "./ppc-model";
import {
  ADS_AD_GROUP_SELECT,
  ADS_AUDIT_SELECT,
  ADS_BUDGET_EVENT_SELECT,
  ADS_CAMPAIGN_SELECT,
  ADS_CHANGE_SELECT,
  ADS_KPI_SELECT,
  ADS_NEGATIVE_KEYWORD_SELECT,
  ADS_SEARCH_TERM_SELECT,
  ADS_TARGET_SELECT,
} from "./ppc-model";

export type AdsSuggestionCountRaw = { seller_account_id: string; pending_count: number | null };

export async function readAdsKpi(sellerAccountId?: string | null): Promise<AdsKpiRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  return readAll<AdsKpiRaw>((from, to) => {
    let q = client.from("vexim_ads_kpi").select(ADS_KPI_SELECT).order("spend_7d", { ascending: false }).range(from, to);
    if (sellerAccountId) q = q.eq("seller_account_id", sellerAccountId);
    return q;
  });
}

export async function readAdsCampaigns(sellerAccountId?: string | null): Promise<AdsCampaignRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  return readAll<AdsCampaignRaw>((from, to) => {
    let q = client
      .from("vexim_ads_campaigns")
      .select(ADS_CAMPAIGN_SELECT)
      // Sắp theo chi 7 ngày: campaign đốt tiền nhiều nhất lên đầu — đúng thứ tự
      // người vận hành cần nhìn (NULL xuống cuối).
      .order("spend_7d", { ascending: false, nullsFirst: false })
      .order("name")
      .range(from, to);
    if (sellerAccountId) q = q.eq("seller_account_id", sellerAccountId);
    return q;
  });
}

export async function readAdsBudgetEvents(
  opts: { sellerAccountId?: string | null; days?: number } = {},
): Promise<AdsBudgetEventRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  const days = opts.days ?? 14;
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return readAll<AdsBudgetEventRaw>((from, to) => {
    let q = client
      .from("vexim_ads_budget_events")
      .select(ADS_BUDGET_EVENT_SELECT)
      .gte("day", since)
      .order("day", { ascending: false })
      .range(from, to);
    if (opts.sellerAccountId) q = q.eq("seller_account_id", opts.sellerAccountId);
    return q;
  });
}

/** Số gợi ý negative đang chờ duyệt — con số của A3, hiện sớm ở A1. */
export async function readPendingSuggestionCount(sellerAccountId?: string | null): Promise<number> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  const { data, error } = await client
    .from("vexim_ads_negative_suggestions")
    .select("seller_account_id")
    .eq("status", "pending")
    .limit(5000);
  if (error || !data) return 0;
  const rows = data as { seller_account_id: string }[];
  return sellerAccountId
    ? rows.filter((r) => r.seller_account_id === sellerAccountId).length
    : rows.length;
}

/**
 * Doanh thu sản phẩm (F4) trong khoảng ngày — đầu vào của TACOS.
 * KHÔNG dùng doanh thu đơn hàng (orders) vì TACOS chuẩn là chi ads ÷ doanh thu
 * sản phẩm đã trừ huỷ/hoàn.
 */
export async function readProductRevenue(
  opts: { sellerAccountId?: string | null; from: string; to: string },
): Promise<{ day: string; currency: string; revenue: number | null }[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  const rows = await readAll<{ day: string; currency: string; revenue: number | null }>((from, to) => {
    let q = client
      .from("vexim_sku_profit")
      .select("day,currency,revenue")
      .gte("day", opts.from)
      .lte("day", opts.to)
      .range(from, to);
    if (opts.sellerAccountId) q = q.eq("seller_account_id", opts.sellerAccountId);
    return q;
  });
  return rows;
}

/* ==================================================================== */
/* MODULE 5 P2/P3 — đọc dữ liệu cho A2 · A3 · hàng đợi duyệt · audit   */
/* ==================================================================== */

/**
 * Bản `readAll` riêng cho PPC: thông báo lỗi nói ĐÚNG bảng/view đang đọc.
 * (Dùng readAll của inventory-model thì mọi lỗi đều hiện "Inventory data unavailable"
 * — đã có lần mất thời gian vì thông báo sai bảng.)
 */
async function readAllPpc<T>(view: string, read: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  const rows: T[] = [];
  const size = 500;
  for (let from = 0; ; from += size) {
    const result = await read(from, from + size - 1);
    if (result.error || !result.data) {
      throw new Error(`Không đọc được ${view}: ${result.error?.message ?? "không có dữ liệu"}`);
    }
    rows.push(...(result.data as T[]));
    if ((result.data as T[]).length < size) return rows;
  }
}

/** A2 — ad group của (một) campaign, kèm hiệu quả 7 ngày. */
export async function readAdsAdGroups(opts: {
  sellerAccountId?: string | null;
  campaignId?: string | null;
} = {}): Promise<AdsAdGroupRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  return readAllPpc<AdsAdGroupRaw>("vexim_ads_ad_groups", (from, to) => {
    let q = client
      .from("vexim_ads_ad_groups")
      .select(ADS_AD_GROUP_SELECT)
      .order("spend_7d", { ascending: false, nullsFirst: false })
      .order("name")
      .range(from, to);
    if (opts.sellerAccountId) q = q.eq("seller_account_id", opts.sellerAccountId);
    if (opts.campaignId) q = q.eq("campaign_id", opts.campaignId);
    return q;
  });
}

/** A2 — từ khoá/nhóm sản phẩm của (một) ad group hoặc cả campaign. */
export async function readAdsTargets(opts: {
  sellerAccountId?: string | null;
  campaignId?: string | null;
  adGroupId?: string | null;
  kind?: "keyword" | "product" | null;
} = {}): Promise<AdsTargetRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  return readAllPpc<AdsTargetRaw>("vexim_ads_targets", (from, to) => {
    let q = client
      .from("vexim_ads_targets")
      .select(ADS_TARGET_SELECT)
      // Từ khoá đốt tiền lên đầu: đúng thứ tự người tối ưu cần nhìn.
      .order("spend_7d", { ascending: false, nullsFirst: false })
      .order("target_key")
      .range(from, to);
    if (opts.sellerAccountId) q = q.eq("seller_account_id", opts.sellerAccountId);
    if (opts.campaignId) q = q.eq("campaign_id", opts.campaignId);
    if (opts.adGroupId) q = q.eq("ad_group_id", opts.adGroupId);
    if (opts.kind) q = q.eq("target_kind", opts.kind);
    return q;
  });
}

/**
 * A3 — search term 7/14 ngày + gợi ý đang chờ + cờ đã chặn.
 * Sắp theo chi 7 ngày giảm dần để "dòng đốt tiền" nằm trên cùng; lọc theo
 * SOP-04 (`filterSearchTerms`) làm ở tầng model vì view là dữ liệu gộp.
 */
export async function readAdsSearchTerms(opts: {
  sellerAccountId?: string | null;
  campaignId?: string | null;
  adGroupId?: string | null;
  /** Giới hạn số dòng đọc về (mặc định 3000) — tránh kéo cả trăm nghìn dòng. */
  maxRows?: number;
} = {}): Promise<AdsSearchTermRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  const max = Math.max(1, Math.min(opts.maxRows ?? 3000, 20_000));
  const rows: AdsSearchTermRaw[] = [];
  const size = 500;
  for (let from = 0; from < max; from += size) {
    let q = client
      .from("vexim_ads_search_terms")
      .select(ADS_SEARCH_TERM_SELECT)
      .order("spend_7d", { ascending: false, nullsFirst: false })
      .order("term")
      .range(from, Math.min(from + size, max) - 1);
    if (opts.sellerAccountId) q = q.eq("seller_account_id", opts.sellerAccountId);
    if (opts.campaignId) q = q.eq("campaign_id", opts.campaignId);
    if (opts.adGroupId) q = q.eq("ad_group_id", opts.adGroupId);
    const { data, error } = await q;
    if (error || !data) {
      throw new Error(`Không đọc được vexim_ads_search_terms: ${error?.message ?? "không có dữ liệu"}`);
    }
    const page = data as unknown as AdsSearchTermRaw[];
    rows.push(...page);
    if (page.length < Math.min(size, max - from)) break;
  }
  return rows;
}

/** Hàng đợi + lịch sử thay đổi (view `vexim_ads_changes`). */
export async function readAdsChanges(opts: {
  sellerAccountId?: string | null;
  /** Mặc định đọc các dòng còn mở (chờ duyệt / đã duyệt / đang gửi) + N dòng đã xong. */
  openOnly?: boolean;
  statuses?: string[];
  limit?: number;
} = {}): Promise<AdsChangeRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  let q = client
    .from("vexim_ads_changes")
    .select(ADS_CHANGE_SELECT)
    .order("requested_at", { ascending: false })
    .limit(limit);
  if (opts.sellerAccountId) q = q.eq("seller_account_id", opts.sellerAccountId);
  if (opts.openOnly) q = q.eq("is_open", true);
  if (opts.statuses && opts.statuses.length > 0) q = q.in("status", opts.statuses);
  const { data, error } = await q;
  if (error || !data) {
    throw new Error(`Không đọc được vexim_ads_changes: ${error?.message ?? "không có dữ liệu"}`);
  }
  return data as unknown as AdsChangeRaw[];
}

/** Negative keyword ĐÃ chặn (gương trong DB, không phải danh sách trên Amazon). */
export async function readAdsNegativeKeywords(opts: {
  sellerAccountId?: string | null;
  campaignId?: string | null;
} = {}): Promise<AdsNegativeKeywordRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  return readAllPpc<AdsNegativeKeywordRaw>("vexim_ads_negative_keywords", (from, to) => {
    let q = client
      .from("vexim_ads_negative_keywords")
      .select(ADS_NEGATIVE_KEYWORD_SELECT)
      .order("created_at", { ascending: false })
      .range(from, to);
    if (opts.sellerAccountId) q = q.eq("seller_account_id", opts.sellerAccountId);
    if (opts.campaignId) q = q.eq("campaign_id", opts.campaignId);
    return q;
  });
}

/** Nhật ký thao tác quảng cáo (từ `iam.audit_logs`, chỉ module ads). */
export async function readAdsAudit(opts: {
  sellerAccountId?: string | null;
  limit?: number;
  actions?: string[];
} = {}): Promise<AdsAuditRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  let q = client
    .from("vexim_ads_audit")
    .select(ADS_AUDIT_SELECT)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (opts.sellerAccountId) q = q.eq("seller_account_id", opts.sellerAccountId);
  if (opts.actions && opts.actions.length > 0) q = q.in("action", opts.actions);
  const { data, error } = await q;
  if (error || !data) {
    throw new Error(`Không đọc được vexim_ads_audit: ${error?.message ?? "không có dữ liệu"}`);
  }
  return data as unknown as AdsAuditRaw[];
}

/**
 * Quyền của NGƯỜI ĐANG ĐĂNG NHẬP trên màn PPC — chỉ để ẩn/hiện nút.
 *
 * KHÔNG phải phân quyền: RPC của 0021 vẫn kiểm lại (`iam.is_ads_approver()` /
 * `iam.can_write_seller_account()`) và từ chối nếu không đủ quyền. Hỏi trước ở
 * đây để người vận hành không bấm rồi mới nhận thông báo "không có quyền".
 */
export async function readAdsPermissions(sellerAccountId?: string | null): Promise<{
  canApprove: boolean;
  canWrite: boolean;
  error: string | null;
}> {
  const client = await createClient();
  if (!client) return { canApprove: false, canWrite: false, error: "Chưa cấu hình Supabase" };
  const [approve, write] = await Promise.all([
    client.rpc("vexim_can_ads_approve"),
    sellerAccountId
      ? client.rpc("vexim_can_write_ads", { p_seller: sellerAccountId })
      : Promise.resolve({ data: null, error: null } as { data: unknown; error: null }),
  ]);
  if (approve.error) {
    return { canApprove: false, canWrite: false, error: approve.error.message };
  }
  return {
    canApprove: approve.data === true,
    canWrite: write.data === true,
    error: write.error?.message ?? null,
  };
}
