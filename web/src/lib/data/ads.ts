/**
 * Supabase reader cho Module 5 (PPC phần đọc) — migration 0020.
 *
 *   • vexim_ads_kpis            KPI + TACOS theo shop × CURRENCY
 *   • vexim_ads_campaigns       campaign + cấu hình + metrics 7 ngày + cờ cảnh báo
 *   • vexim_ads_campaign_daily  chuỗi ngày cho biểu đồ trend
 *   • vexim_ads_search_terms    search term gộp 7 ngày + tín hiệu đốt tiền
 *   • vexim_ads_budget_usage    % ngân sách + giờ cạn (ƯỚC LƯỢNG)
 *   • vexim_ads_report_requests cron Ads đang ở đâu (chờ / đã nhập / lỗi)
 *   • vexim_ads_profiles        profileId đã đồng bộ của từng shop
 *
 * Mọi view đều `security_invoker = true` và bảng gốc có policy
 * `iam.can_read_seller_account` → đọc bằng CLIENT PHIÊN, mỗi người chỉ thấy shop
 * mình được gán. Không dùng service role ở tầng UI.
 *
 * Chưa cấu hình Supabase → trả null để trang rơi về DEMO MODE (giống finance-claims).
 */
import { createClient } from "@/lib/supabase/server";
import { readAll } from "./inventory-model.ts";
import {
  ADS_BUDGET_SELECT,
  ADS_PROFILE_SELECT,
  ADS_CAMPAIGN_SELECT,
  ADS_DAILY_SELECT,
  ADS_KPI_SELECT,
  ADS_REPORT_REQUEST_SELECT,
  ADS_SEARCH_TERM_SELECT,
  mapAdsBudgetUsage,
  mapAdsCampaign,
  mapAdsDaily,
  mapAdsKpi,
  mapAdsProfileRow,
  mapAdsReportRequest,
  mapAdsSearchTerm,
  type AdsBudgetUsage,
  type AdsBudgetUsageDbRow,
  type AdsCampaign,
  type AdsCampaignDbRow,
  type AdsCampaignDailyDbRow,
  type AdsDailyPoint,
  type AdsKpi,
  type AdsKpiDbRow,
  type AdsProfileDbRow,
  type AdsProfileRow,
  type AdsReportRequest,
  type AdsReportRequestDbRow,
  type AdsSearchTerm,
  type AdsSearchTermDbRow,
} from "./ads-model.ts";

/** View của 0020 chưa có → nói thẳng phải chạy migration nào (42P01/PGRST205). */
function explain(view: string, error: { message: string; code?: string | null }): Error {
  const missing = /could not find|does not exist|42P01|PGRST205/i.test(error.message);
  return new Error(
    missing
      ? `Chưa có view ${view} — cần chạy migration 0020 (Module 5 PPC phần đọc).`
      : `Không đọc được ${view}: ${error.message}`,
  );
}

async function clientOrThrow() {
  const client = await createClient();
  if (!client) throw new Error("Chưa cấu hình Supabase");
  return client;
}

/* ------------------------------------------------------------------ */
/* KPI + TACOS                                                        */
/* ------------------------------------------------------------------ */

export async function readAdsKpiRows(): Promise<AdsKpiDbRow[] | null> {
  const client = await createClient();
  if (!client) return null;
  const rows = await readAll<AdsKpiDbRow>((from, to) =>
    client
      .from("vexim_ads_kpis")
      .select(ADS_KPI_SELECT)
      .order("currency", { ascending: true })
      .order("spend7", { ascending: false, nullsFirst: false })
      .range(from, to),
  );
  return rows;
}

export async function readAdsKpis(): Promise<AdsKpi[] | null> {
  let raw: AdsKpiDbRow[] | null;
  try {
    raw = await readAdsKpiRows();
  } catch (e) {
    throw explain("vexim_ads_kpis", e as { message: string });
  }
  return raw === null ? null : raw.map(mapAdsKpi);
}

/* ------------------------------------------------------------------ */
/* Campaign                                                           */
/* ------------------------------------------------------------------ */

export type AdsCampaignFilter = {
  shopId?: string;
  /** true = chỉ campaign có spend trong cửa sổ 7 ngày. */
  withSpendOnly?: boolean;
  limit?: number;
};

export async function readAdsCampaignRows(filter: AdsCampaignFilter = {}): Promise<AdsCampaignDbRow[]> {
  const client = await clientOrThrow();
  let q = client.from("vexim_ads_campaigns").select(ADS_CAMPAIGN_SELECT);
  if (filter.shopId) q = q.eq("seller_account_id", filter.shopId);
  if (filter.withSpendOnly) q = q.gt("spend7", 0);
  // spend lớn trước: campaign quan trọng nhất luôn nằm trong trang đầu tiên.
  q = q.order("spend7", { ascending: false, nullsFirst: false }).order("campaign_name", { ascending: true });
  const { data, error } = await q.limit(filter.limit ?? 500);
  if (error) throw explain("vexim_ads_campaigns", error);
  return (data ?? []) as unknown as AdsCampaignDbRow[];
}

export async function readAdsCampaigns(filter: AdsCampaignFilter = {}): Promise<AdsCampaign[]> {
  const raw = await readAdsCampaignRows(filter);
  return raw.map(mapAdsCampaign);
}

/* ------------------------------------------------------------------ */
/* Chuỗi ngày (biểu đồ trend)                                         */
/* ------------------------------------------------------------------ */

export type AdsDailyFilter = {
  shopId?: string;
  /** Ngày bắt đầu (YYYY-MM-DD). Mặc định 14 ngày tính từ hôm qua (UTC). */
  from?: string;
  to?: string;
  limit?: number;
};

export function defaultDailyWindow(now: Date = new Date(), days = 14): { from: string; to: string } {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export async function readAdsDailyRows(filter: AdsDailyFilter = {}): Promise<AdsCampaignDailyDbRow[]> {
  const client = await clientOrThrow();
  const win = defaultDailyWindow();
  const fromDay = filter.from ?? win.from;
  const toDay = filter.to ?? win.to;
  // Builder PostgREST là MUTABLE và đã await một lần thì không nên tái sử dụng:
  // dựng query MỚI cho từng trang, không thì .order() cộng dồn qua mỗi vòng lặp.
  const rows = await readAll<AdsCampaignDailyDbRow>((from, to) => {
    let q = client
      .from("vexim_ads_campaign_daily")
      .select(ADS_DAILY_SELECT)
      .gte("day", fromDay)
      .lte("day", toDay);
    if (filter.shopId) q = q.eq("seller_account_id", filter.shopId);
    return q.order("day", { ascending: true }).range(from, to);
  });
  return filter.limit ? rows.slice(0, filter.limit) : rows;
}

export async function readAdsDaily(filter: AdsDailyFilter = {}): Promise<AdsDailyPoint[]> {
  const raw = await readAdsDailyRows(filter);
  return raw.map(mapAdsDaily);
}

/* ------------------------------------------------------------------ */
/* Search term                                                        */
/* ------------------------------------------------------------------ */

export type AdsSearchTermFilter = {
  shopId?: string;
  /** true = chỉ term có tín hiệu đốt tiền (≥3 click, 0 đơn). */
  wastedOnly?: boolean;
  limit?: number;
};

export async function readAdsSearchTermRows(filter: AdsSearchTermFilter = {}): Promise<AdsSearchTermDbRow[]> {
  const client = await clientOrThrow();
  let q = client.from("vexim_ads_search_terms").select(ADS_SEARCH_TERM_SELECT);
  if (filter.shopId) q = q.eq("seller_account_id", filter.shopId);
  if (filter.wastedOnly) q = q.eq("wasted_spend_signal", true);
  q = q.order("spend", { ascending: false, nullsFirst: false });
  const { data, error } = await q.limit(filter.limit ?? 200);
  if (error) throw explain("vexim_ads_search_terms", error);
  return (data ?? []) as unknown as AdsSearchTermDbRow[];
}

export async function readAdsSearchTerms(filter: AdsSearchTermFilter = {}): Promise<AdsSearchTerm[]> {
  const raw = await readAdsSearchTermRows(filter);
  return raw.map(mapAdsSearchTerm);
}

/* ------------------------------------------------------------------ */
/* Ngân sách                                                          */
/* ------------------------------------------------------------------ */

export async function readAdsBudgetRows(shopId?: string, limit = 200): Promise<AdsBudgetUsageDbRow[]> {
  const client = await clientOrThrow();
  let q = client.from("vexim_ads_budget_usage").select(ADS_BUDGET_SELECT);
  if (shopId) q = q.eq("seller_account_id", shopId);
  const { data, error } = await q.order("percentage_used", { ascending: false, nullsFirst: false }).limit(limit);
  if (error) throw explain("vexim_ads_budget_usage", error);
  return (data ?? []) as unknown as AdsBudgetUsageDbRow[];
}

export async function readAdsBudgetUsage(shopId?: string, limit = 200): Promise<AdsBudgetUsage[]> {
  const raw = await readAdsBudgetRows(shopId, limit);
  return raw.map(mapAdsBudgetUsage);
}

/* ------------------------------------------------------------------ */
/* Tiến trình đồng bộ (report requests)                               */
/* ------------------------------------------------------------------ */

export async function readAdsReportRequestRows(shopId?: string, limit = 100): Promise<AdsReportRequestDbRow[]> {
  const client = await clientOrThrow();
  let q = client.from("vexim_ads_report_requests").select(ADS_REPORT_REQUEST_SELECT);
  if (shopId) q = q.eq("seller_account_id", shopId);
  const { data, error } = await q.order("requested_at", { ascending: false, nullsFirst: true }).limit(limit);
  if (error) throw explain("vexim_ads_report_requests", error);
  return (data ?? []) as unknown as AdsReportRequestDbRow[];
}

export async function readAdsReportRequests(shopId?: string, limit = 100): Promise<AdsReportRequest[]> {
  const raw = await readAdsReportRequestRows(shopId, limit);
  return raw.map(mapAdsReportRequest);
}

/* ------------------------------------------------------------------ */
/* Profile                                                            */
/* ------------------------------------------------------------------ */
/* Profile Ads                                                        */
/* ------------------------------------------------------------------ */

export async function readAdsProfileRows(shopId?: string): Promise<AdsProfileDbRow[]> {
  const client = await clientOrThrow();
  let q = client.from("vexim_ads_profiles").select(ADS_PROFILE_SELECT);
  if (shopId) q = q.eq("seller_account_id", shopId);
  const { data, error } = await q.order("shop", { ascending: true }).order("is_default", { ascending: false });
  if (error) throw explain("vexim_ads_profiles", error);
  return (data ?? []) as unknown as AdsProfileDbRow[];
}

/** null khi chưa cấu hình Supabase (DEMO MODE) — trang phải phân biệt được. */
export async function readAdsProfiles(shopId?: string): Promise<AdsProfileRow[] | null> {
  const client = await createClient();
  if (!client) return null;
  const raw = await readAdsProfileRows(shopId);
  return raw.map(mapAdsProfileRow);
}

/* ------------------------------------------------------------------ */
/* Gom một lượt đọc cho trang /ppc                                    */
/* ------------------------------------------------------------------ */

export type PpcPageData = {
  mode: "supabase" | "demo";
  kpis: AdsKpi[];
  campaigns: AdsCampaign[];
  searchTerms: AdsSearchTerm[];
  daily: AdsDailyPoint[];
  budgetUsage: AdsBudgetUsage[];
  reportRequests: AdsReportRequest[];
  profiles: AdsProfileRow[];
  profileCount: number;
  /** Lỗi từng phần: một view hỏng không được làm sập cả trang. */
  partialErrors: string[];
};

/**
 * Đọc song song mọi nguồn cho /ppc. View nào lỗi thì ghi vào `partialErrors`
 * và phần đó hiện "chưa đọc được" — trang vẫn chạy, vì Ops cần thấy phần còn
 * lại thay vì một màn hình trắng.
 */
export async function readPpcPageData(shopId?: string): Promise<PpcPageData> {
  const client = await createClient();
  if (!client) {
    return {
      mode: "demo",
      kpis: [],
      campaigns: [],
      searchTerms: [],
      daily: [],
      budgetUsage: [],
      reportRequests: [],
      profiles: [],
      profileCount: 0,
      partialErrors: [],
    };
  }

  const partialErrors: string[] = [];
  const guard = async <T>(label: string, run: () => Promise<T | null>, fallback: T): Promise<T> => {
    try {
      const value = await run();
      return value === null ? fallback : value;
    } catch (e) {
      partialErrors.push(e instanceof Error ? e.message : `${label}: lỗi không rõ`);
      return fallback;
    }
  };

  const [kpis, campaigns, searchTerms, daily, budgetUsage, reportRequests, profiles] = await Promise.all([
    guard("KPI Ads", () => readAdsKpis(), [] as AdsKpi[]),
    guard("Campaign", () => readAdsCampaigns({ shopId, limit: 500 }), [] as AdsCampaign[]),
    guard("Search term", () => readAdsSearchTerms({ shopId, limit: 200 }), [] as AdsSearchTerm[]),
    guard("Metrics theo ngày", () => readAdsDaily({ shopId }), [] as AdsDailyPoint[]),
    guard("Ngân sách", () => readAdsBudgetUsage(shopId, 200), [] as AdsBudgetUsage[]),
    guard("Tiến trình report", () => readAdsReportRequests(shopId, 100), [] as AdsReportRequest[]),
    guard("Profile Ads", () => readAdsProfiles(shopId), null as AdsProfileRow[] | null),
  ]);

  return {
    mode: "supabase",
    kpis,
    campaigns,
    searchTerms,
    daily,
    budgetUsage,
    reportRequests,
    profiles: profiles ?? [],
    profileCount: profiles?.length ?? 0,
    partialErrors,
  };
}
