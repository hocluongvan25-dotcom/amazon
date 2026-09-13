/**
 * Data model cho Module 5 (PPC phần đọc) — số liệu Ads từ các view 0020.
 *
 * Ba nguyên tắc bất di bất dịch (sai là Ops ra quyết định nhầm):
 *
 *  1. KHÔNG CỘNG TIỀN KHÁC TIỀN TỆ. Một shop có thể chạy US + CA + MX; view đã
 *     tách theo currency, model này giữ nguyên sự tách đó (`totalsByCurrency`).
 *     Cộng $ và C$ ra một con "tổng chi" là con số vô nghĩa.
 *  2. TỶ LỆ TỔNG = TỔNG/TỔNG, không phải trung bình của các tỷ lệ. ACOS của 2
 *     campaign KHÔNG bằng (ACOS1+ACOS2)/2 — campaign spend lớn phải nặng hơn.
 *     Vì thế model tính lại từ spend7/sales7 thay vì lấy acos7 có sẵn.
 *  3. CHƯA BIẾT ≠ 0. Thiếu doanh thu tổng (Module 4 chưa đồng bộ) → TACOS là
 *     null và UI hiện "—"; thiếu metrics → không bịa 0%. Mọi chỗ "không đủ dữ
 *     liệu" đều đi kèm lý do để người xem biết phải làm gì tiếp.
 */

import type { AlertSeverity, KpiCardData } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Kiểu dữ liệu thô từ view (snake_case — đúng như PostgREST trả)      */
/* ------------------------------------------------------------------ */

export type AdsKpiDbRow = {
  seller_account_id: string;
  shop: string;
  shop_status: string | null;
  currency: string | null;
  metrics_day: string | null;
  spend_yesterday: number | string | null;
  clicks_yesterday: number | string | null;
  spend7: number | string | null;
  ad_sales7: number | string | null;
  ad_orders7: number | string | null;
  clicks7: number | string | null;
  impressions7: number | string | null;
  acos7: number | string | null;
  roas7: number | string | null;
  ctr7: number | string | null;
  cpc7: number | string | null;
  total_sales7: number | string | null;
  total_orders7: number | string | null;
  tacos7: number | string | null;
  tacos_unknown: boolean | null;
  campaigns_enabled: number | string | null;
  campaigns_over_target: number | string | null;
  campaigns_exhausted: number | string | null;
  budget_daily_total: number | string | null;
  last_metrics_day: string | null;
  last_imported_at: string | null;
  hours_since_import: number | string | null;
  is_stale: boolean | null;
};

export type AdsCampaignDbRow = {
  seller_account_id: string;
  shop: string;
  ads_profile_id: string | null;
  campaign_id: string;
  campaign_name: string | null;
  campaign_type: string | null;
  state: string | null;
  targeting_type: string | null;
  cost_type: string | null;
  daily_budget: number | string | null;
  budget_type: string | null;
  currency: string | null;
  start_date: string | null;
  end_date: string | null;
  last_metrics_day: string | null;
  days_with_data: number | string | null;
  spend_yesterday: number | string | null;
  spend7: number | string | null;
  sales7: number | string | null;
  ad_orders7: number | string | null;
  clicks7: number | string | null;
  impressions7: number | string | null;
  acos7: number | string | null;
  roas7: number | string | null;
  cpc7: number | string | null;
  acos_trend_pts: number | string | null;
  budget_used_pct: number | string | null;
  exhausted_at_estimate: string | null;
  budget_exhausted: boolean | null;
  over_acos_target: boolean | null;
  acos_target: number | string | null;
  source: string | null;
};

export type AdsSearchTermDbRow = {
  seller_account_id: string;
  shop: string;
  search_term: string;
  is_placement_without_keyword: boolean | null;
  campaign_id: string | null;
  campaign_name: string | null;
  ad_group_name: string | null;
  keyword_text: string | null;
  match_type: string | null;
  keyword_type: string | null;
  currency: string | null;
  impressions: number | string | null;
  clicks: number | string | null;
  spend: number | string | null;
  sales7: number | string | null;
  ad_orders7: number | string | null;
  ctr: number | string | null;
  cpc: number | string | null;
  acos7: number | string | null;
  days_with_data: number | string | null;
  bid: number | string | null;
  ad_keyword_status: string | null;
  wasted_spend_signal: boolean | null;
};

export type AdsCampaignDailyDbRow = {
  seller_account_id: string;
  shop: string;
  day: string;
  campaign_id: string;
  campaign_name: string | null;
  currency: string | null;
  impressions: number | string | null;
  clicks: number | string | null;
  spend: number | string | null;
  sales7d: number | string | null;
  ad_orders7d: number | string | null;
  acos7d: number | string | null;
  cpc: number | string | null;
  budget_amount: number | string | null;
  campaign_status: string | null;
  imported_at: string | null;
};

export type AdsBudgetUsageDbRow = {
  seller_account_id: string;
  shop: string;
  day: string | null;
  campaign_id: string;
  campaign_name: string | null;
  campaign_state: string | null;
  budget_type: string | null;
  currency: string | null;
  budget: number | string | null;
  spend: number | string | null;
  percentage_used: number | string | null;
  delivered_clicks: number | string | null;
  last_captured_at: string | null;
  source: string | null;
  exhausted_at_estimate: string | null;
  snapshots_over_100pct: number | string | null;
  budget_exhausted: boolean | null;
  exhausted_note: string | null;
};

export type AdsReportRequestDbRow = {
  id: string;
  seller_account_id: string;
  shop: string;
  ads_profile_id: string | null;
  report_type_id: string;
  time_unit: string | null;
  group_by: string | null;
  date_start: string | null;
  date_end: string | null;
  ads_report_id: string | null;
  status: string;
  failure_reason: string | null;
  rows_imported: number | string | null;
  attempts: number | string | null;
  last_error: string | null;
  requested_at: string | null;
  imported_at: string | null;
  age_minutes: number | string | null;
  is_stale: boolean | null;
};

/* ------------------------------------------------------------------ */
/* Ép kiểu an toàn (PostgREST trả numeric thành chuỗi)                  */
/* ------------------------------------------------------------------ */

/** Số: chấp nhận chuỗi "12.50"; rỗng/không phải số → null (KHÔNG phải 0). */
export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function int(value: unknown): number | null {
  const n = num(value);
  return n === null ? null : Math.trunc(n);
}

/** Boolean từ DB: chỉ true khi đúng true/"t"/"true"/1 — null giữ nguyên null. */
export function flag(value: unknown): boolean | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value;
  const s = String(value).trim().toLowerCase();
  if (s === "t" || s === "true" || s === "1" || s === "yes") return true;
  if (s === "f" || s === "false" || s === "0" || s === "no") return false;
  return null;
}

export function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

export function round(value: number | null, digits = 2): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/* ------------------------------------------------------------------ */
/* Định dạng                                                          */
/* ------------------------------------------------------------------ */

/** Tiền: null → "—" (không hiện 0 giả). */
export function moneyText(value: number | null, currency: string | null = null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const text = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
  return currency ? `${text} ${currency}` : text;
}

/**
 * Phần trăm. `value` là SỐ PHẦN TRĂM (25.4 = 25.4%) vì view Ads đã nhân 100 —
 * khác `percent()` của finance-model nhận tỷ lệ (0.254). Hai hàm một quy ước là
 * nguồn lỗi kinh điển nên đặt tên tách bạch.
 */
export function pctText(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

export function ratioText(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

export function countText(value: number | null): string {
  if (value === null) return "—";
  return value.toLocaleString("en-US");
}

/** "3,2 giờ trước" / "12 phút trước" — để biết dữ liệu mới hay cũ. */
export function agoText(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return "chưa rõ";
  if (hours < 1) {
    const m = Math.max(1, Math.round(hours * 60));
    return `${m} phút trước`;
  }
  if (hours < 48) return `${hours.toFixed(1)} giờ trước`;
  return `${Math.round(hours / 24)} ngày trước`;
}

/** Xu hướng ACOS: dương = ACOS TĂNG = XẤU ĐI (ngược trực giác so với doanh thu). */
export function trendText(points: number | null): string {
  if (points === null || !Number.isFinite(points)) return "—";
  const abs = Math.abs(points).toFixed(1);
  if (Math.abs(points) < 0.5) return "đi ngang";
  return points > 0 ? `ACOS xấu đi ${abs} điểm` : `ACOS tốt hơn ${abs} điểm`;
}

export function trendTone(points: number | null): "up" | "down" | "flat" {
  if (points === null || !Number.isFinite(points) || Math.abs(points) < 0.5) return "flat";
  return points > 0 ? "down" : "up";
}

/* ------------------------------------------------------------------ */
/* SELECT dùng cho reader (khớp đúng cột view trong migration 0020)    */
/* ------------------------------------------------------------------ */

export const ADS_KPI_SELECT = [
  "seller_account_id",
  "shop",
  "shop_status",
  "currency",
  "metrics_day",
  "spend_yesterday",
  "clicks_yesterday",
  "spend7",
  "ad_sales7",
  "ad_orders7",
  "clicks7",
  "impressions7",
  "acos7",
  "roas7",
  "ctr7",
  "cpc7",
  "total_sales7",
  "total_orders7",
  "tacos7",
  "tacos_unknown",
  "campaigns_enabled",
  "campaigns_over_target",
  "campaigns_exhausted",
  "budget_daily_total",
  "last_metrics_day",
  "last_imported_at",
  "hours_since_import",
  "is_stale",
].join(",");

export const ADS_CAMPAIGN_SELECT = [
  "seller_account_id",
  "shop",
  "ads_profile_id",
  "campaign_id",
  "campaign_name",
  "campaign_type",
  "state",
  "targeting_type",
  "cost_type",
  "daily_budget",
  "budget_type",
  "currency",
  "start_date",
  "end_date",
  "last_metrics_day",
  "days_with_data",
  "spend_yesterday",
  "spend7",
  "sales7",
  "ad_orders7",
  "clicks7",
  "impressions7",
  "acos7",
  "roas7",
  "cpc7",
  "acos_trend_pts",
  "budget_used_pct",
  "exhausted_at_estimate",
  "budget_exhausted",
  "over_acos_target",
  "acos_target",
  "source",
].join(",");

export const ADS_SEARCH_TERM_SELECT = [
  "seller_account_id",
  "shop",
  "search_term",
  "is_placement_without_keyword",
  "campaign_id",
  "campaign_name",
  "ad_group_name",
  "keyword_text",
  "match_type",
  "keyword_type",
  "currency",
  "impressions",
  "clicks",
  "spend",
  "sales7",
  "ad_orders7",
  "ctr",
  "cpc",
  "acos7",
  "days_with_data",
  "bid",
  "ad_keyword_status",
  "wasted_spend_signal",
].join(",");

export const ADS_DAILY_SELECT = [
  "seller_account_id",
  "shop",
  "day",
  "campaign_id",
  "campaign_name",
  "currency",
  "impressions",
  "clicks",
  "spend",
  "sales7d",
  "ad_orders7d",
  "acos7d",
  "cpc",
  "budget_amount",
  "campaign_status",
  "imported_at",
].join(",");

export const ADS_BUDGET_SELECT = [
  "seller_account_id",
  "shop",
  "day",
  "campaign_id",
  "campaign_name",
  "campaign_state",
  "budget_type",
  "currency",
  "budget",
  "spend",
  "percentage_used",
  "delivered_clicks",
  "last_captured_at",
  "source",
  "exhausted_at_estimate",
  "snapshots_over_100pct",
  "budget_exhausted",
  "exhausted_note",
].join(",");

export const ADS_REPORT_REQUEST_SELECT = [
  "id",
  "seller_account_id",
  "shop",
  "ads_profile_id",
  "report_type_id",
  "time_unit",
  "group_by",
  "date_start",
  "date_end",
  "ads_report_id",
  "status",
  "failure_reason",
  "rows_imported",
  "attempts",
  "last_error",
  "requested_at",
  "imported_at",
  "age_minutes",
  "is_stale",
].join(",");

/* ------------------------------------------------------------------ */
/* Kiểu đã chuẩn hoá cho UI (camelCase, số thật, null = chưa biết)     */
/* ------------------------------------------------------------------ */

export type AdsKpi = {
  shopId: string;
  shop: string;
  currency: string;
  metricsDay: string | null;
  spendYesterday: number | null;
  clicksYesterday: number | null;
  spend7: number | null;
  adSales7: number | null;
  adOrders7: number | null;
  clicks7: number | null;
  impressions7: number | null;
  acos7: number | null;
  roas7: number | null;
  ctr7: number | null;
  cpc7: number | null;
  totalSales7: number | null;
  tacos7: number | null;
  tacosUnknown: boolean;
  campaignsEnabled: number;
  campaignsOverTarget: number;
  campaignsExhausted: number;
  budgetDailyTotal: number | null;
  lastMetricsDay: string | null;
  lastImportedAt: string | null;
  hoursSinceImport: number | null;
  isStale: boolean;
};

/** View tách theo currency; dòng nào không có currency thì gom vào "—". */
export const UNKNOWN_CURRENCY = "—";

export function mapAdsKpi(row: AdsKpiDbRow): AdsKpi {
  const tacosUnknown = flag(row.tacos_unknown) === true || num(row.total_sales7) === null;
  return {
    shopId: row.seller_account_id,
    shop: str(row.shop) ?? row.seller_account_id.slice(0, 8),
    currency: str(row.currency) ?? UNKNOWN_CURRENCY,
    metricsDay: str(row.metrics_day),
    spendYesterday: num(row.spend_yesterday),
    clicksYesterday: int(row.clicks_yesterday),
    spend7: num(row.spend7),
    adSales7: num(row.ad_sales7),
    adOrders7: int(row.ad_orders7),
    clicks7: int(row.clicks7),
    impressions7: int(row.impressions7),
    acos7: num(row.acos7),
    roas7: num(row.roas7),
    ctr7: num(row.ctr7),
    cpc7: num(row.cpc7),
    totalSales7: num(row.total_sales7),
    tacos7: tacosUnknown ? null : num(row.tacos7),
    tacosUnknown,
    campaignsEnabled: int(row.campaigns_enabled) ?? 0,
    campaignsOverTarget: int(row.campaigns_over_target) ?? 0,
    campaignsExhausted: int(row.campaigns_exhausted) ?? 0,
    budgetDailyTotal: num(row.budget_daily_total),
    lastMetricsDay: str(row.last_metrics_day),
    lastImportedAt: str(row.last_imported_at),
    hoursSinceImport: num(row.hours_since_import),
    isStale: flag(row.is_stale) === true,
  };
}

export type AdsCampaign = {
  shopId: string;
  shop: string;
  profileId: string | null;
  campaignId: string;
  name: string;
  type: string | null;
  state: string | null;
  currency: string;
  dailyBudget: number | null;
  spendYesterday: number | null;
  spend7: number | null;
  sales7: number | null;
  adOrders7: number | null;
  clicks7: number | null;
  impressions7: number | null;
  acos7: number | null;
  roas7: number | null;
  cpc7: number | null;
  acosTrendPts: number | null;
  budgetUsedPct: number | null;
  budgetExhausted: boolean;
  overAcosTarget: boolean;
  acosTarget: number | null;
  lastMetricsDay: string | null;
  daysWithData: number | null;
  source: string | null;
};

export function mapAdsCampaign(row: AdsCampaignDbRow): AdsCampaign {
  return {
    shopId: row.seller_account_id,
    shop: str(row.shop) ?? row.seller_account_id.slice(0, 8),
    profileId: str(row.ads_profile_id),
    campaignId: row.campaign_id,
    name: str(row.campaign_name) ?? row.campaign_id,
    type: str(row.campaign_type),
    state: str(row.state),
    currency: str(row.currency) ?? UNKNOWN_CURRENCY,
    dailyBudget: num(row.daily_budget),
    spendYesterday: num(row.spend_yesterday),
    spend7: num(row.spend7),
    sales7: num(row.sales7),
    adOrders7: int(row.ad_orders7),
    clicks7: int(row.clicks7),
    impressions7: int(row.impressions7),
    acos7: num(row.acos7),
    roas7: num(row.roas7),
    cpc7: num(row.cpc7),
    acosTrendPts: num(row.acos_trend_pts),
    budgetUsedPct: num(row.budget_used_pct),
    budgetExhausted: flag(row.budget_exhausted) === true,
    overAcosTarget: flag(row.over_acos_target) === true,
    acosTarget: num(row.acos_target),
    lastMetricsDay: str(row.last_metrics_day),
    daysWithData: int(row.days_with_data),
    source: str(row.source),
  };
}

export type AdsSearchTerm = {
  shopId: string;
  shop: string;
  term: string;
  isPlacementWithoutKeyword: boolean;
  campaignId: string | null;
  campaignName: string | null;
  adGroupName: string | null;
  keywordText: string | null;
  matchType: string | null;
  /** BROAD/PHRASE/EXACT hay TARGETING_EXPRESSION — quyết định sửa bằng cách nào. */
  keywordType: string | null;
  currency: string;
  impressions: number | null;
  clicks: number | null;
  spend: number | null;
  sales7: number | null;
  adOrders7: number | null;
  ctr: number | null;
  cpc: number | null;
  acos7: number | null;
  daysWithData: number | null;
  bid: number | null;
  adKeywordStatus: string | null;
  wastedSpendSignal: boolean;
  /** Tín hiệu đốt tiền TRÊN MỘT TỪ KHOÁ THẬT → mới gợi ý negative được. */
  negativeCandidate: boolean;
};

export function mapAdsSearchTerm(row: AdsSearchTermDbRow): AdsSearchTerm {
  const placement = flag(row.is_placement_without_keyword) === true || row.search_term === "*";
  const wasted = flag(row.wasted_spend_signal) === true;
  return {
    shopId: row.seller_account_id,
    shop: str(row.shop) ?? row.seller_account_id.slice(0, 8),
    term: str(row.search_term) ?? "*",
    isPlacementWithoutKeyword: placement,
    campaignId: str(row.campaign_id),
    campaignName: str(row.campaign_name),
    adGroupName: str(row.ad_group_name),
    keywordText: str(row.keyword_text),
    matchType: str(row.match_type),
    keywordType: str(row.keyword_type),
    currency: str(row.currency) ?? UNKNOWN_CURRENCY,
    impressions: int(row.impressions),
    clicks: int(row.clicks),
    spend: num(row.spend),
    sales7: num(row.sales7),
    adOrders7: int(row.ad_orders7),
    ctr: num(row.ctr),
    cpc: num(row.cpc),
    acos7: num(row.acos7),
    daysWithData: int(row.days_with_data),
    bid: num(row.bid),
    adKeywordStatus: str(row.ad_keyword_status),
    wastedSpendSignal: wasted,
    // term='*' là PLACEMENT không gắn từ khoá (dữ liệu thật, không phải rác):
    // không thể "negative" một placement bằng từ khoá nên tách ra khỏi danh sách gợi ý.
    negativeCandidate: wasted && !placement,
  };
}

export type AdsBudgetUsage = {
  shopId: string;
  shop: string;
  day: string | null;
  campaignId: string;
  campaignName: string;
  campaignState: string | null;
  currency: string;
  budget: number | null;
  spend: number | null;
  percentageUsed: number | null;
  deliveredClicks: number | null;
  lastCapturedAt: string | null;
  source: string | null;
  exhaustedAtEstimate: string | null;
  budgetExhausted: boolean;
  /** true khi % ngân sách là SUY RA từ report ngày (không phải Budget Usage API). */
  isEstimate: boolean;
};

export function mapAdsBudgetUsage(row: AdsBudgetUsageDbRow): AdsBudgetUsage {
  const source = str(row.source);
  return {
    shopId: row.seller_account_id,
    shop: str(row.shop) ?? row.seller_account_id.slice(0, 8),
    day: str(row.day),
    campaignId: row.campaign_id,
    campaignName: str(row.campaign_name) ?? row.campaign_id,
    campaignState: str(row.campaign_state),
    currency: str(row.currency) ?? UNKNOWN_CURRENCY,
    budget: num(row.budget),
    spend: num(row.spend),
    percentageUsed: num(row.percentage_used),
    deliveredClicks: int(row.delivered_clicks),
    lastCapturedAt: str(row.last_captured_at),
    source,
    exhaustedAtEstimate: str(row.exhausted_at_estimate),
    budgetExhausted: flag(row.budget_exhausted) === true,
    isEstimate: source !== null && source.includes("estimate"),
  };
}

export type AdsDailyPoint = {
  shopId: string;
  shop: string;
  day: string;
  campaignId: string;
  campaignName: string | null;
  currency: string;
  impressions: number | null;
  clicks: number | null;
  spend: number | null;
  sales7d: number | null;
  adOrders7d: number | null;
  acos7d: number | null;
  cpc: number | null;
  importedAt: string | null;
};

export function mapAdsDaily(row: AdsCampaignDailyDbRow): AdsDailyPoint {
  return {
    shopId: row.seller_account_id,
    shop: str(row.shop) ?? row.seller_account_id.slice(0, 8),
    day: row.day,
    campaignId: row.campaign_id,
    campaignName: str(row.campaign_name),
    currency: str(row.currency) ?? UNKNOWN_CURRENCY,
    impressions: int(row.impressions),
    clicks: int(row.clicks),
    spend: num(row.spend),
    sales7d: num(row.sales7d),
    adOrders7d: int(row.ad_orders7d),
    acos7d: num(row.acos7d),
    cpc: num(row.cpc),
    importedAt: str(row.imported_at),
  };
}

export const REPORT_STATUS_VI: Record<string, string> = {
  requested: "đã xin, chờ Amazon",
  processing: "Amazon đang tạo",
  completed: "xong, chờ nhập",
  imported: "đã nhập",
  no_data: "rỗng (không có dữ liệu)",
  throttled: "bị giới hạn tốc độ",
  failure: "Amazon báo hỏng",
  failed: "hỏng (quá số lần chờ)",
};

export type AdsReportRequest = {
  id: string;
  shopId: string;
  shop: string;
  reportTypeId: string;
  reportLabel: string;
  timeUnit: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  adsReportId: string | null;
  status: string;
  statusLabel: string;
  failureReason: string | null;
  rowsImported: number | null;
  attempts: number | null;
  lastError: string | null;
  requestedAt: string | null;
  importedAt: string | null;
  ageMinutes: number | null;
  isStale: boolean;
};

export const REPORT_TYPE_LABEL: Record<string, string> = {
  spCampaigns: "Campaign (ngày)",
  spAdvertisedProduct: "ASIN/SKU quảng cáo",
  spSearchTerm: "Search term",
  spTargeting: "Keyword/Target",
};

export function mapAdsReportRequest(row: AdsReportRequestDbRow): AdsReportRequest {
  return {
    id: row.id,
    shopId: row.seller_account_id,
    shop: str(row.shop) ?? row.seller_account_id.slice(0, 8),
    reportTypeId: row.report_type_id,
    reportLabel: REPORT_TYPE_LABEL[row.report_type_id] ?? row.report_type_id,
    timeUnit: str(row.time_unit),
    dateStart: str(row.date_start),
    dateEnd: str(row.date_end),
    adsReportId: str(row.ads_report_id),
    status: row.status,
    statusLabel: REPORT_STATUS_VI[row.status] ?? row.status,
    failureReason: str(row.failure_reason),
    rowsImported: int(row.rows_imported),
    attempts: int(row.attempts),
    lastError: str(row.last_error),
    requestedAt: str(row.requested_at),
    importedAt: str(row.imported_at),
    ageMinutes: int(row.age_minutes),
    isStale: flag(row.is_stale) === true,
  };
}

/* ------------------------------------------------------------------ */
/* Tổng hợp THEO TIỀN TỆ                                              */
/* ------------------------------------------------------------------ */

export type AdsCurrencyTotals = {
  currency: string;
  shops: number;
  shopNames: string[];
  /** Ngày dữ liệu mới nhất trong nhóm (để nhãn không nói "hôm qua" sai). */
  metricsDay: string | null;
  spendYesterday: number;
  spend7: number;
  adSales7: number;
  adOrders7: number;
  clicks7: number;
  impressions7: number;
  /** Tính lại từ TỔNG: không lấy trung bình acos7 của từng shop. */
  acos7: number | null;
  roas7: number | null;
  ctr7: number | null;
  cpc7: number | null;
  totalSales7: number | null;
  tacos7: number | null;
  /** Số shop chưa có tổng doanh thu → TACOS của nhóm chỉ đúng một phần. */
  tacosUnknownShops: number;
  tacosPartial: boolean;
  campaignsEnabled: number;
  campaignsOverTarget: number;
  campaignsExhausted: number;
  budgetDailyTotal: number;
  staleShops: number;
  lastImportedAt: string | null;
  hoursSinceImport: number | null;
};

function sumOf(values: (number | null)[]): number {
  return values.reduce<number>((acc, v) => acc + (v ?? 0), 0);
}

export function totalsByCurrency(kpis: AdsKpi[]): AdsCurrencyTotals[] {
  const groups = new Map<string, AdsKpi[]>();
  for (const k of kpis) {
    const list = groups.get(k.currency) ?? [];
    list.push(k);
    groups.set(k.currency, list);
  }

  return [...groups.entries()]
    .map(([currency, rows]) => {
      const spend7 = sumOf(rows.map((r) => r.spend7));
      const adSales7 = sumOf(rows.map((r) => r.adSales7));
      const clicks7 = sumOf(rows.map((r) => r.clicks7));
      const impressions7 = sumOf(rows.map((r) => r.impressions7));

      // TACOS: chỉ cộng được khi MỌI shop trong nhóm có tổng doanh thu.
      const known = rows.filter((r) => !r.tacosUnknown && r.totalSales7 !== null);
      const unknownShops = rows.length - known.length;
      const totalSales7 = unknownShops === 0 ? sumOf(known.map((r) => r.totalSales7)) : null;
      // TACOS một phần vẫn tính được trên tập shop đã biết, nhưng PHẢI gắn cờ.
      const tacosBase = unknownShops === 0 ? totalSales7 : sumOf(known.map((r) => r.totalSales7));
      const tacosSpend = unknownShops === 0 ? spend7 : sumOf(known.map((r) => r.spend7));

      const imports = rows
        .map((r) => r.lastImportedAt)
        .filter((v): v is string => v !== null)
        .sort();
      const hours = rows.map((r) => r.hoursSinceImport).filter((v): v is number => v !== null);

      return {
        currency,
        shops: rows.length,
        shopNames: rows.map((r) => r.shop).sort(),
        metricsDay: rows
          .map((r) => r.metricsDay ?? r.lastMetricsDay)
          .filter((v): v is string => v !== null)
          .sort()
          .at(-1) ?? null,
        spendYesterday: sumOf(rows.map((r) => r.spendYesterday)),
        spend7,
        adSales7,
        adOrders7: sumOf(rows.map((r) => r.adOrders7)),
        clicks7,
        impressions7,
        acos7: adSales7 > 0 ? round((100 * spend7) / adSales7) : null,
        roas7: spend7 > 0 ? round(adSales7 / spend7) : null,
        ctr7: impressions7 > 0 ? round((100 * clicks7) / impressions7, 3) : null,
        cpc7: clicks7 > 0 ? round(spend7 / clicks7, 3) : null,
        totalSales7,
        tacos7: tacosBase !== null && tacosBase > 0 ? round((100 * tacosSpend) / tacosBase) : null,
        tacosUnknownShops: unknownShops,
        tacosPartial: unknownShops > 0 && known.length > 0,
        campaignsEnabled: sumOf(rows.map((r) => r.campaignsEnabled)),
        campaignsOverTarget: sumOf(rows.map((r) => r.campaignsOverTarget)),
        campaignsExhausted: sumOf(rows.map((r) => r.campaignsExhausted)),
        budgetDailyTotal: sumOf(rows.map((r) => r.budgetDailyTotal)),
        staleShops: rows.filter((r) => r.isStale).length,
        lastImportedAt: imports.at(-1) ?? null,
        hoursSinceImport: hours.length > 0 ? Math.max(...hours) : null,
      } satisfies AdsCurrencyTotals;
    })
    // Tiền tệ chính (spend lớn nhất) lên đầu — Ops nhìn một con số là đúng shop lớn.
    .sort((a, b) => b.spend7 - a.spend7 || a.currency.localeCompare(b.currency));
}

/** Nhóm chính = nhóm spend 7 ngày lớn nhất; null khi chưa có dữ liệu. */
export function primaryTotals(totals: AdsCurrencyTotals[]): AdsCurrencyTotals | null {
  return totals[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* KPI cards                                                          */
/* ------------------------------------------------------------------ */

export function buildAdsKpis(t: AdsCurrencyTotals | null): KpiCardData[] {
  if (!t) {
    return [
      { label: "Spend Ads 7 ngày", value: "—", sub: "chưa có dữ liệu Ads", tone: "flat" },
      { label: "ACOS 7 ngày", value: "—", sub: "chưa có dữ liệu Ads", tone: "flat" },
      { label: "TACOS 7 ngày", value: "—", sub: "chưa có dữ liệu Ads", tone: "flat" },
      { label: "CPC 7 ngày", value: "—", sub: "chưa có dữ liệu Ads", tone: "flat" },
    ];
  }

  const ccy = t.currency === UNKNOWN_CURRENCY ? "" : t.currency;
  const tacosSub =
    t.tacos7 === null
      ? t.tacosUnknownShops > 0
        ? `${t.tacosUnknownShops}/${t.shops} shop chưa có tổng doanh thu (Module 4)`
        : "chưa có tổng doanh thu để tính"
      : t.tacosPartial
        ? `chỉ ${t.shops - t.tacosUnknownShops}/${t.shops} shop có tổng doanh thu`
        : `trên tổng doanh thu ${moneyText(t.totalSales7, ccy)}`;

  return [
    {
      label: `Spend Ads 7 ngày · ${t.currency}`,
      value: moneyText(t.spend7, ccy),
      sub: `${countText(t.adOrders7)} đơn từ ads · hôm qua ${moneyText(t.spendYesterday, ccy)}`,
      tone: "flat",
    },
    {
      label: "ACOS 7 ngày",
      value: pctText(t.acos7),
      sub:
        t.acos7 === null
          ? "chưa có doanh thu ads để tính"
          : `ROAS ${ratioText(t.roas7)} · ${t.campaignsOverTarget} campaign vượt ngưỡng`,
      tone: t.acos7 === null ? "flat" : t.campaignsOverTarget > 0 ? "down" : "up",
    },
    {
      label: "TACOS 7 ngày",
      value: pctText(t.tacos7),
      sub: tacosSub,
      // Số MỘT PHẦN cũng phải cảnh báo: TACOS tính trên tập shop đã biết luôn
      // thấp hơn thật, để màu xanh là tự khen mình.
      tone: t.tacos7 === null || t.tacosPartial ? "warn" : t.tacos7 > 15 ? "down" : t.tacos7 > 10 ? "warn" : "up",
    },
    {
      label: "CPC · CTR 7 ngày",
      value: moneyText(t.cpc7, ccy),
      sub: `CTR ${pctText(t.ctr7, 2)} · ${countText(t.clicks7)} click`,
      tone: "flat",
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Danh sách cần xử lý (thay mock ppcAlerts)                          */
/* ------------------------------------------------------------------ */

export type AdsAlert = { tone: AlertSeverity; text: string };

export function buildAdsAlerts(input: {
  totals: AdsCurrencyTotals[];
  campaigns: AdsCampaign[];
  searchTerms: AdsSearchTerm[];
  reportRequests: AdsReportRequest[];
  limit?: number;
}): AdsAlert[] {
  const out: AdsAlert[] = [];
  const limit = input.limit ?? 8;

  // 1) Dữ liệu cũ = mọi con số trên trang đều đáng ngờ → ưu tiên cao nhất.
  const stale = input.totals.filter((t) => t.staleShops > 0);
  for (const t of stale) {
    out.push({
      tone: "red",
      text:
        `Dữ liệu Ads ${t.currency} cũ: ${t.staleShops}/${t.shops} shop chưa nhập trong ` +
        `${agoText(t.hoursSinceImport)} (ngày số liệu mới nhất ${t.metricsDay ?? "—"}). ` +
        `Chạy /api/cron/ads-sync?phase=poll để nhập report đang chờ.`,
    });
  }

  // 2) Report chờ quá lâu (Amazon kẹt) — khác với "dữ liệu cũ" ở chỗ biết rõ đang chờ gì.
  const stuck = input.reportRequests.filter((r) => r.isStale && (r.status === "requested" || r.status === "processing"));
  if (stuck.length > 0) {
    const worst = stuck[0];
    out.push({
      tone: "amber",
      text:
        `${stuck.length} report chờ quá 2 giờ (mới nhất: ${worst.reportLabel} của ${worst.shop}, ` +
        `${worst.ageMinutes === null ? "?" : Math.round(worst.ageMinutes / 60)} giờ). ` +
        `Lần cron sau sẽ tự poll tiếp; quá 3 lần sẽ xin report mới.`,
    });
  }

  // 3) Report hỏng → nói rõ lý do Amazon trả về.
  const broken = input.reportRequests.filter((r) => r.status === "failed" || r.status === "failure");
  for (const r of broken.slice(0, 2)) {
    out.push({
      tone: "amber",
      text: `Report ${r.reportLabel} của ${r.shop} hỏng: ${r.failureReason ?? r.lastError ?? "không rõ lý do"}.`,
    });
  }

  // 4) Campaign cạn ngân sách: mất doanh thu ngay trong ngày.
  const exhausted = input.campaigns
    .filter((c) => c.budgetExhausted && (c.spend7 ?? 0) > 0)
    .sort((a, b) => (b.spend7 ?? 0) - (a.spend7 ?? 0));
  for (const c of exhausted.slice(0, 3)) {
    out.push({
      tone: "red",
      text:
        `${c.name} (${c.shop}) đã cạn ngân sách — dùng ${pctText(c.budgetUsedPct, 0)} của ` +
        `${moneyText(c.dailyBudget, c.currency)}/ngày. Đang mất hiển thị phần còn lại của ngày.`,
    });
  }

  // 5) ACOS vượt ngưỡng: xếp theo spend (campaign nhỏ vượt ngưỡng thì chưa đáng lo).
  const overTarget = input.campaigns
    // Cùng điều kiện với campaignsOverTarget(): campaign KHÔNG spend mà cờ vượt
    // ngưỡng là dữ liệu lệch — báo lên chỉ thành nhiễu khiến Ops bỏ qua cảnh báo thật.
    .filter((c) => c.overAcosTarget && (c.spend7 ?? 0) > 0)
    .sort((a, b) => (b.spend7 ?? 0) - (a.spend7 ?? 0));
  for (const c of overTarget.slice(0, 3)) {
    out.push({
      tone: "amber",
      text:
        `${c.name} (${c.shop}) ACOS ${pctText(c.acos7)} > ngưỡng ${pctText(c.acosTarget, 0)} ` +
        `trong khi spend 7 ngày ${moneyText(c.spend7, c.currency)} — ${trendText(c.acosTrendPts)}.`,
    });
  }

  // 6) Search term đốt tiền (chỉ từ khoá thật — placement '*' xử lý ở bidding).
  const wasted = input.searchTerms
    .filter((s) => s.negativeCandidate)
    .sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0));
  if (wasted.length > 0) {
    const top = wasted[0];
    const total = sumOf(wasted.map((w) => w.spend));
    out.push({
      tone: "amber",
      text:
        `${wasted.length} search term có ≥3 click mà 0 đơn, đang đốt ${moneyText(total, top.currency)}. ` +
        `Nặng nhất: “${top.term}” (${moneyText(top.spend, top.currency)} · ${countText(top.clicks)} click). ` +
        `Luồng thêm negative keyword tự động thuộc Phần 2.`,
    });
  }

  // 7) TACOS chưa tính được → CEO dễ hiểu nhầm là "ads rẻ".
  for (const t of input.totals) {
    if (t.tacos7 === null && t.tacosUnknownShops > 0 && t.spend7 > 0) {
      out.push({
        tone: "amber",
        text:
          `Chưa tính được TACOS ${t.currency}: ${t.tacosUnknownShops}/${t.shops} shop thiếu tổng doanh thu ` +
          `(cần Module 4 đồng bộ order). Đang hiện "—" chứ không suy ra 0%.`,
      });
      break;
    }
  }

  if (out.length === 0) {
    out.push({ tone: "green", text: "Không có gì vượt ngưỡng trong cửa sổ 7 ngày gần nhất." });
  }
  return out.slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* Bảng xếp hạng                                                      */
/* ------------------------------------------------------------------ */

/** Campaign vượt ngưỡng ACOS, spend lớn trước; chỉ lấy campaign CÓ spend. */
export function campaignsOverTarget(campaigns: AdsCampaign[], limit = 10): AdsCampaign[] {
  return campaigns
    .filter((c) => c.overAcosTarget && (c.spend7 ?? 0) > 0)
    .sort((a, b) => (b.spend7 ?? 0) - (a.spend7 ?? 0))
    .slice(0, limit);
}

/** Campaign cạn/sát ngân sách (≥80%), % cao trước. */
export function budgetWatch(campaigns: AdsCampaign[], limit = 10, threshold = 80): AdsCampaign[] {
  return campaigns
    .filter((c) => c.budgetExhausted || (c.budgetUsedPct ?? 0) >= threshold)
    .sort((a, b) => (b.budgetUsedPct ?? 0) - (a.budgetUsedPct ?? 0))
    .slice(0, limit);
}

/** Top search term theo spend (mọi term, kể cả placement '*'). */
export function topSearchTerms(terms: AdsSearchTerm[], limit = 10): AdsSearchTerm[] {
  return [...terms].sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0)).slice(0, limit);
}

/** Term đang đốt tiền (≥3 click, 0 đơn) — đã loại placement '*'. */
export function wastedSearchTerms(terms: AdsSearchTerm[], limit = 10): AdsSearchTerm[] {
  return terms
    .filter((t) => t.negativeCandidate)
    .sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0))
    .slice(0, limit);
}

/** Term hiệu quả nhất (có đơn, ACOS thấp) để biết nên tăng bid vào đâu. */
export function bestSearchTerms(terms: AdsSearchTerm[], limit = 5): AdsSearchTerm[] {
  return terms
    .filter((t) => (t.adOrders7 ?? 0) > 0 && t.acos7 !== null)
    .sort((a, b) => (a.acos7 ?? Infinity) - (b.acos7 ?? Infinity))
    .slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* Chuỗi ngày cho biểu đồ                                             */
/* ------------------------------------------------------------------ */

export type DayPoint = { day: string; spend: number; sales: number; clicks: number; acos: number | null };

/**
 * Gộp metrics theo NGÀY trong MỘT tiền tệ. Trả về tăng dần theo ngày, chỉ gồm
 * ngày thực sự có dữ liệu (không tự điền ngày trống = không bịa 0).
 */
export function dailySeries(points: AdsDailyPoint[], currency: string | null = null): DayPoint[] {
  const map = new Map<string, DayPoint>();
  for (const p of points) {
    if (currency !== null && p.currency !== currency) continue;
    const day = String(p.day).slice(0, 10);
    const entry = map.get(day) ?? { day, spend: 0, sales: 0, clicks: 0, acos: null };
    entry.spend += p.spend ?? 0;
    entry.sales += p.sales7d ?? 0;
    entry.clicks += p.clicks ?? 0;
    map.set(day, entry);
  }
  return [...map.values()]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((d) => ({ ...d, spend: round(d.spend) ?? 0, sales: round(d.sales) ?? 0, acos: d.sales > 0 ? round((100 * d.spend) / d.sales) : null }));
}

/**
 * Dữ liệu cho component Bars: pct tương đối ngày spend cao nhất.
 * `today` đánh dấu ngày CUỐI có dữ liệu (không phải "hôm nay" theo đồng hồ —
 * dữ liệu ads luôn trễ một ngày, đánh dấu sai là tự lừa mình).
 */
export function spendBars(series: DayPoint[], maxDays = 14): { label: string; pct: number; today?: boolean }[] {
  const tail = series.slice(-maxDays);
  const max = tail.reduce((m, d) => Math.max(m, d.spend), 0);
  return tail.map((d, i) => ({
    label: d.day.slice(5),
    pct: max > 0 ? Math.max(2, Math.round((d.spend / max) * 100)) : 0,
    today: i === tail.length - 1,
  }));
}

/* ------------------------------------------------------------------ */
/* Sức khoẻ đồng bộ (Ops cần biết số trên trang từ đâu ra)            */
/* ------------------------------------------------------------------ */

export type AdsSyncHealth = {
  total: number;
  byStatus: Record<string, number>;
  waiting: number;
  imported: number;
  failed: number;
  stale: number;
  rowsImported: number;
  lastImportedAt: string | null;
  shops: string[];
};

export function summarizeSyncHealth(requests: AdsReportRequest[]): AdsSyncHealth {
  const byStatus: Record<string, number> = {};
  let waiting = 0;
  let imported = 0;
  let failed = 0;
  let stale = 0;
  let rows = 0;
  let last: string | null = null;

  for (const r of requests) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.status === "requested" || r.status === "processing" || r.status === "completed") waiting += 1;
    if (r.status === "imported") imported += 1;
    if (r.status === "failed" || r.status === "failure" || r.status === "throttled") failed += 1;
    if (r.isStale) stale += 1;
    rows += r.rowsImported ?? 0;
    if (r.importedAt !== null && (last === null || r.importedAt > last)) last = r.importedAt;
  }

  return {
    total: requests.length,
    byStatus,
    waiting,
    imported,
    failed,
    stale,
    rowsImported: rows,
    lastImportedAt: last,
    shops: [...new Set(requests.map((r) => r.shop))].sort(),
  };
}

/** Nhãn giải thích vì sao trang chưa có số — dùng cho empty state. */
export function emptyStateReason(input: {
  kpis: AdsKpi[];
  reportRequests: AdsReportRequest[];
  profiles: number;
}): { title: string; lines: string[] } {
  // Có metrics thì có dữ liệu — kiểm tra TRƯỚC, không thì bảng report_requests rỗng
  // (report cũ bị dọn) sẽ làm trang nói "chưa xin report nào" trong khi số đang hiện.
  if (input.kpis.length > 0) {
    return { title: "Đã có dữ liệu", lines: [] };
  }
  if (input.profiles === 0 && input.reportRequests.length === 0) {
    return {
      title: "Chưa có kết nối Amazon Ads",
      lines: [
        "Chưa shop nào có profile Ads trong DB → chưa thể xin report.",
        "Làm gì: /module0/connect → Authorize Ads API cho shop (scope ads::campaign_management), " +
          "hoặc nạp refresh token có sẵn vào ô Import.",
        "Sau khi có token: chạy /api/cron/ads-sync?dryRun=1&shop=<uuid> để thử mà không ghi DB.",
      ],
    };
  }
  if (input.reportRequests.length === 0) {
    return {
      title: "Đã có profile nhưng chưa xin report nào",
      lines: [
        "Bảng ads.report_requests rỗng → cron ads-sync chưa chạy (hoặc chưa bật cron trên Vercel).",
        "Làm gì: gọi /api/cron/ads-sync (header Authorization: Bearer <CRON_SECRET>) rồi quay lại trang này.",
        "Report Ads bất đồng bộ: lần gọi đầu chỉ XIN, pha POLL của lần sau mới nhập số liệu.",
      ],
    };
  }
  if (input.kpis.length === 0) {
    const waiting = input.reportRequests.filter((r) => r.status === "requested" || r.status === "processing").length;
    return {
      title: waiting > 0 ? "Report đang được Amazon tạo" : "Report đã xin nhưng chưa nhập được dòng nào",
      lines:
        waiting > 0
          ? [
              `${waiting} report đang chờ (Amazon cho phép tới 3 giờ).`,
              "Làm gì: chạy /api/cron/ads-sync?phase=poll — xong là trang này có số ngay.",
            ]
          : [
              "Không report nào ở trạng thái imported. Xem bảng “Tiến trình đồng bộ” bên dưới để biết lý do " +
                "(no_data = shop không phát sinh ads; failed = Amazon chê cột/quá hạn).",
            ],
    };
  }
  return { title: "Đã có dữ liệu", lines: [] };
}

/* ------------------------------------------------------------------ */
/* Profile Ads (GET /v2/profiles) — profileId là scope của mọi call    */
/* ------------------------------------------------------------------ */

export const ADS_PROFILE_SELECT = [
  "seller_account_id",
  "shop",
  "ads_profile_id",
  "marketplace",
  "country_code",
  "currency",
  "timezone",
  "account_id",
  "account_type",
  "account_name",
  "daily_budget",
  "is_default",
  "source",
  "last_synced_at",
  "campaigns_known",
  "last_metrics_day",
].join(",");

export type AdsProfileDbRow = {
  seller_account_id: string;
  shop: string | null;
  ads_profile_id: string;
  marketplace: string | null;
  country_code: string | null;
  currency: string | null;
  timezone: string | null;
  account_id: string | null;
  account_type: string | null;
  account_name: string | null;
  daily_budget: number | string | null;
  is_default: boolean | null;
  source: string | null;
  last_synced_at: string | null;
  campaigns_known: number | string | null;
  last_metrics_day: string | null;
};

export type AdsProfileRow = {
  shopId: string;
  shop: string;
  profileId: string;
  marketplace: string | null;
  countryCode: string | null;
  currency: string | null;
  timezone: string | null;
  accountId: string | null;
  accountType: string | null;
  accountName: string | null;
  dailyBudget: number | null;
  isDefault: boolean;
  source: string | null;
  lastSyncedAt: string | null;
  campaignsKnown: number | null;
  lastMetricsDay: string | null;
};

export function mapAdsProfileRow(row: AdsProfileDbRow): AdsProfileRow {
  return {
    shopId: row.seller_account_id,
    shop: str(row.shop) ?? row.seller_account_id.slice(0, 8),
    profileId: row.ads_profile_id,
    marketplace: str(row.marketplace),
    countryCode: str(row.country_code),
    currency: str(row.currency),
    timezone: str(row.timezone),
    accountId: str(row.account_id),
    accountType: str(row.account_type),
    accountName: str(row.account_name),
    dailyBudget: num(row.daily_budget),
    isDefault: flag(row.is_default) === true,
    source: str(row.source),
    lastSyncedAt: str(row.last_synced_at),
    campaignsKnown: int(row.campaigns_known),
    lastMetricsDay: str(row.last_metrics_day),
  };
}

/* ------------------------------------------------------------------ */
/* Tóm tắt cho Dashboard CEO (không phải trang /ppc)                  */
/* ------------------------------------------------------------------ */

export type AdsDashboardSummary = {
  /** Số shop × tiền tệ có metrics trong cửa sổ 7 ngày. */
  shopCount: number;
  currencies: string[];
  totals: AdsCurrencyTotals[];
  /** Nhóm tiền tệ spend lớn nhất — Dashboard chỉ hiện MỘT con số nên phải chọn rõ. */
  primary: AdsCurrencyTotals | null;
  staleShops: number;
  campaignsOverTarget: number;
  campaignsExhausted: number;
  campaignsEnabled: number;
  lastImportedAt: string | null;
  hoursSinceImport: number | null;
  /** true khi chưa có bất kỳ dòng KPI nào (chưa đồng bộ Ads). */
  hasData: boolean;
};

export function summarizeAdsForDashboard(kpis: AdsKpi[]): AdsDashboardSummary {
  const totals = totalsByCurrency(kpis);
  const staleShops = kpis.filter((k) => k.isStale).length;
  const imports = totals.map((t) => t.lastImportedAt).filter((v): v is string => v !== null).sort();
  const hours = totals.map((t) => t.hoursSinceImport).filter((v): v is number => v !== null);

  return {
    shopCount: kpis.length,
    currencies: totals.map((t) => t.currency),
    totals,
    primary: primaryTotals(totals),
    staleShops,
    campaignsOverTarget: totals.reduce((sum, t) => sum + t.campaignsOverTarget, 0),
    campaignsExhausted: totals.reduce((sum, t) => sum + t.campaignsExhausted, 0),
    campaignsEnabled: totals.reduce((sum, t) => sum + t.campaignsEnabled, 0),
    lastImportedAt: imports.at(-1) ?? null,
    hoursSinceImport: hours.length > 0 ? Math.max(...hours) : null,
    hasData: kpis.length > 0,
  };
}
