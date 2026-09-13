/**
 * Test tầng MODEL của Module 5 UI (thuần — không Supabase, không React):
 *
 *   • ads-model: ép kiểu từ view, tổng hợp THEO TIỀN TỆ, tỷ lệ tính bằng TỔNG/TỔNG,
 *     "chưa biết" phải ra null chứ không ra 0, danh sách việc cần làm, nhãn ước lượng.
 *   • dashboard-model: card Ads/TACOS trên Dashboard CEO khi chưa đồng bộ.
 *   • finance-model: ads_spend + TACOS của F4 (cột riêng, không trừ lãi gộp).
 *
 * Vì sao test kỹ phần này: đây là chỗ con số đi ra quyết định. Một phép trung bình
 * sai (ACOS = trung bình các ACOS) hoặc một con 0 thay cho "chưa biết" là Ops cắt
 * bid của campaign đang lãi.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ADS_KPI_SELECT,
  ADS_PROFILE_SELECT,
  agoText,
  bestSearchTerms,
  budgetWatch,
  buildAdsAlerts,
  buildAdsKpis,
  campaignsOverTarget,
  countText,
  dailySeries,
  emptyStateReason,
  flag,
  int,
  mapAdsBudgetUsage,
  mapAdsCampaign,
  mapAdsDaily,
  mapAdsKpi,
  mapAdsProfileRow,
  mapAdsReportRequest,
  mapAdsSearchTerm,
  moneyText,
  num,
  pctText,
  primaryTotals,
  ratioText,
  round,
  spendBars,
  str,
  summarizeAdsForDashboard,
  summarizeSyncHealth,
  topSearchTerms,
  totalsByCurrency,
  trendText,
  trendTone,
  wastedSearchTerms,
  type AdsBudgetUsageDbRow,
  type AdsCampaignDbRow,
  type AdsKpiDbRow,
  type AdsCampaignDailyDbRow,
  type AdsReportRequestDbRow,
  type AdsSearchTermDbRow,
} from "../src/lib/data/ads-model.ts";
import {
  buildAdsDetailLine,
  buildAdsKpi,
  buildPpcDeptSummary,
  ppcAlertCount,
} from "../src/lib/data/dashboard-model.ts";
import {
  adsTacosPct,
  aggregateProfit,
  percent,
  profitKpis,
  type SkuProfitDbRow,
} from "../src/lib/data/finance-model.ts";

const SHOP_A = "aaaaaaaa-0000-4000-8000-000000000001";
const SHOP_B = "bbbbbbbb-0000-4000-8000-000000000002";

/* ------------------------------------------------------------------ */
/* Fixture: dòng THÔ như PostgREST trả (numeric thành chuỗi)           */
/* ------------------------------------------------------------------ */

/** Shop A: ACOS 50% trên spend 100 — cố tình để kiểm tra "tổng/tổng ≠ trung bình". */
function kpiA(p: Partial<AdsKpiDbRow> = {}): AdsKpiDbRow {
  return {
    seller_account_id: SHOP_A,
    shop: "A1 · US",
    shop_status: "active",
    currency: "USD",
    metrics_day: "2026-09-12",
    spend_yesterday: "12.5",
    clicks_yesterday: "20",
    spend7: "100",
    ad_sales7: "200",
    ad_orders7: "8",
    clicks7: "200",
    impressions7: "10000",
    acos7: "50",
    roas7: "2",
    ctr7: "2",
    cpc7: "0.5",
    total_sales7: "1000",
    total_orders7: "40",
    tacos7: "10",
    tacos_unknown: false,
    campaigns_enabled: "3",
    campaigns_over_target: "1",
    campaigns_exhausted: "0",
    budget_daily_total: "75",
    last_metrics_day: "2026-09-12",
    last_imported_at: "2026-09-13T04:05:00Z",
    hours_since_import: "2.5",
    is_stale: false,
    ...p,
  };
}

/** Shop B: ACOS 10% trên spend 10, dữ liệu CŨ (is_stale). */
function kpiB(p: Partial<AdsKpiDbRow> = {}): AdsKpiDbRow {
  return kpiA({
    seller_account_id: SHOP_B,
    shop: "B2 · US",
    metrics_day: "2026-09-11",
    spend_yesterday: "3",
    clicks_yesterday: "5",
    spend7: "10",
    ad_sales7: "100",
    ad_orders7: "4",
    clicks7: "50",
    impressions7: "5000",
    acos7: "10",
    total_sales7: "500",
    tacos7: "2",
    campaigns_enabled: "2",
    campaigns_over_target: "0",
    campaigns_exhausted: "1",
    budget_daily_total: "20",
    last_metrics_day: "2026-09-11",
    last_imported_at: "2026-09-12T04:05:00Z",
    hours_since_import: "26",
    is_stale: true,
    ...p,
  });
}

function campaign(p: Partial<AdsCampaignDbRow> = {}): AdsCampaignDbRow {
  return {
    seller_account_id: SHOP_A,
    shop: "A1 · US",
    ads_profile_id: "111",
    campaign_id: "c1",
    campaign_name: "SP main",
    campaign_type: "sp",
    state: "ENABLED",
    targeting_type: "MANUAL",
    cost_type: "CPC",
    daily_budget: "50",
    budget_type: "DAILY",
    currency: "USD",
    start_date: "2026-01-01",
    end_date: null,
    last_metrics_day: "2026-09-12",
    days_with_data: "7",
    spend_yesterday: "42",
    spend7: "210",
    sales7: "600",
    ad_orders7: "20",
    clicks7: "300",
    impressions7: "9000",
    acos7: "35",
    roas7: "2.86",
    cpc7: "0.7",
    acos_trend_pts: "4.2",
    budget_used_pct: "84",
    exhausted_at_estimate: null,
    budget_exhausted: false,
    over_acos_target: true,
    acos_target: "25",
    source: "sp_campaigns_list",
    ...p,
  };
}

function term(p: Partial<AdsSearchTermDbRow> = {}): AdsSearchTermDbRow {
  return {
    seller_account_id: SHOP_A,
    shop: "A1 · US",
    search_term: "travel bag",
    is_placement_without_keyword: false,
    campaign_id: "c1",
    campaign_name: "SP main",
    ad_group_name: "AG1",
    keyword_text: "bag",
    match_type: "BROAD",
    keyword_type: "BROAD",
    currency: "USD",
    impressions: "500",
    clicks: "12",
    spend: "9.6",
    sales7: "60",
    ad_orders7: "2",
    ctr: "2.4",
    cpc: "0.8",
    acos7: "16",
    days_with_data: "5",
    bid: "0.85",
    ad_keyword_status: "ENABLED",
    wasted_spend_signal: false,
    ...p,
  };
}

function daily(p: Partial<AdsCampaignDailyDbRow> = {}): AdsCampaignDailyDbRow {
  return {
    seller_account_id: SHOP_A,
    shop: "A1 · US",
    day: "2026-09-12",
    campaign_id: "c1",
    campaign_name: "SP main",
    currency: "USD",
    impressions: "1000",
    clicks: "20",
    spend: "20",
    sales7d: "100",
    ad_orders7d: "4",
    acos7d: "20",
    cpc: "1",
    budget_amount: "50",
    campaign_status: "ENABLED",
    imported_at: "2026-09-13T04:05:00Z",
    ...p,
  };
}

function report(p: Partial<AdsReportRequestDbRow> = {}): AdsReportRequestDbRow {
  return {
    id: "req-1",
    seller_account_id: SHOP_A,
    shop: "A1 · US",
    ads_profile_id: "111",
    report_type_id: "spCampaigns",
    time_unit: "DAILY",
    group_by: "campaign",
    date_start: "2026-09-06",
    date_end: "2026-09-12",
    ads_report_id: "rpt-1",
    status: "imported",
    failure_reason: null,
    rows_imported: "42",
    attempts: "2",
    last_error: null,
    requested_at: "2026-09-13T04:00:00Z",
    imported_at: "2026-09-13T04:06:00Z",
    age_minutes: "10",
    is_stale: false,
    ...p,
  };
}

/* ================================================================== */
/* 1. Ép kiểu + mapper                                                */
/* ================================================================== */
test("num/int/flag/str/round: chuỗi numeric của PostgREST → số; rỗng → null (không phải 0)", () => {
  assert.equal(num("12.50"), 12.5);
  assert.equal(num(0), 0, "số 0 thật phải giữ 0");
  assert.equal(num(null), null);
  assert.equal(num(""), null);
  assert.equal(num("abc"), null);
  assert.equal(int("42.9"), 42);
  assert.equal(int(null), null);

  assert.equal(flag(true), true);
  assert.equal(flag("t"), true, "Postgres boolean qua text");
  assert.equal(flag("false"), false);
  assert.equal(flag(null), null, "null ≠ false: 'chưa biết' khác 'không'");
  assert.equal(flag("??"), null);

  assert.equal(str("  "), null);
  assert.equal(str("USD"), "USD");
  assert.equal(round(36.6666), 36.67);
  assert.equal(round(1.6666, 3), 1.667);
  assert.equal(round(null), null);
});

test("mapAdsKpi: tacos_unknown=true → tacos7 null dù view có trả số", () => {
  const k = mapAdsKpi(kpiA());
  assert.equal(k.spend7, 100);
  assert.equal(k.tacos7, 10);
  assert.equal(k.tacosUnknown, false);
  assert.equal(k.isStale, false);
  assert.equal(k.campaignsEnabled, 3);

  const unknown = mapAdsKpi(kpiA({ tacos_unknown: true, total_sales7: null }));
  assert.equal(unknown.tacos7, null, "không có tổng doanh thu thì KHÔNG được hiện TACOS");
  assert.equal(unknown.tacosUnknown, true);

  // total_sales7 null mà tacos_unknown false (dữ liệu lệch) → vẫn coi là chưa biết
  assert.equal(mapAdsKpi(kpiA({ total_sales7: null, tacos_unknown: false })).tacosUnknown, true);

  // thiếu currency → gom vào nhóm "—", không mặc định USD
  assert.equal(mapAdsKpi(kpiA({ currency: null })).currency, "—");
  // display_name NOT NULL trong DB, nhưng mapper vẫn phòng thủ: rỗng → dùng 8 ký tự đầu của id
  assert.equal(mapAdsKpi(kpiA({ shop: "" })).shop, SHOP_A.slice(0, 8));
});

test("mapAdsSearchTerm: term '*' là PLACEMENT → không phải ứng viên negative", () => {
  const real = mapAdsSearchTerm(term({ search_term: "cheap bag", clicks: "5", sales7: "0", wasted_spend_signal: true }));
  assert.equal(real.negativeCandidate, true);
  assert.equal(real.isPlacementWithoutKeyword, false);

  const placement = mapAdsSearchTerm(
    term({ search_term: "*", is_placement_without_keyword: true, clicks: "9", sales7: "0", wasted_spend_signal: true }),
  );
  assert.equal(placement.isPlacementWithoutKeyword, true);
  assert.equal(placement.negativeCandidate, false, "không thể negative một placement bằng từ khoá");
  assert.equal(placement.wastedSpendSignal, true, "vẫn giữ tín hiệu đốt tiền để hiện ở chỗ khác");

  // '*' mà view quên gắn cờ → mapper tự nhận diện
  assert.equal(mapAdsSearchTerm(term({ search_term: "*", is_placement_without_keyword: false })).isPlacementWithoutKeyword, true);
});

test("mapAdsCampaign / mapAdsBudgetUsage: cờ cảnh báo + nhãn 'ước lượng'", () => {
  const c = mapAdsCampaign(campaign());
  assert.equal(c.overAcosTarget, true);
  assert.equal(c.budgetExhausted, false);
  assert.equal(c.acosTarget, 25);
  assert.equal(c.budgetUsedPct, 84);
  assert.equal(mapAdsCampaign(campaign({ state: null })).state, null);

  const real = mapAdsBudgetUsage({
    seller_account_id: SHOP_A,
    shop: "A1 · US",
    day: "2026-09-12",
    campaign_id: "c1",
    campaign_name: null,
    campaign_state: "ENABLED",
    budget_type: "DAILY",
    currency: "USD",
    budget: "50",
    spend: "42",
    percentage_used: "84",
    delivered_clicks: "300",
    last_captured_at: "2026-09-12T22:00:00Z",
    source: "sb_budget_usage_api",
    exhausted_at_estimate: null,
    snapshots_over_100pct: "0",
    budget_exhausted: false,
    exhausted_note: null,
  } satisfies AdsBudgetUsageDbRow);
  assert.equal(real.campaignName, "c1", "thiếu tên → dùng campaignId, không để trống");
  assert.equal(real.isEstimate, false);

  const estimate = mapAdsBudgetUsage({
    seller_account_id: SHOP_A,
    shop: "A",
    day: "2026-09-12",
    campaign_id: "c1",
    campaign_name: "SP main",
    campaign_state: null,
    budget_type: null,
    currency: "USD",
    budget: "50",
    spend: "50",
    percentage_used: "100",
    delivered_clicks: null,
    last_captured_at: null,
    source: "sp_campaigns_report_estimate",
    exhausted_at_estimate: "2026-09-12T18:00:00Z",
    snapshots_over_100pct: "1",
    budget_exhausted: true,
    exhausted_note: "Ước lượng",
  } satisfies AdsBudgetUsageDbRow);
  assert.equal(estimate.isEstimate, true, "SP không có Budget Usage API → phải gắn nhãn ước lượng");
  assert.equal(estimate.budgetExhausted, true);
});

test("mapAdsReportRequest: nhãn tiếng Việt cho status và reportTypeId", () => {
  const r = mapAdsReportRequest(report());
  assert.equal(r.statusLabel, "đã nhập");
  assert.equal(r.reportLabel, "Campaign (ngày)");
  assert.equal(r.rowsImported, 42);
  assert.equal(mapAdsReportRequest(report({ status: "no_data" })).statusLabel, "rỗng (không có dữ liệu)");
  assert.equal(mapAdsReportRequest(report({ report_type_id: "sbCampaigns" })).reportLabel, "sbCampaigns", "loại lạ → giữ nguyên id");
  assert.equal(mapAdsReportRequest(report({ status: "gì_đó" })).statusLabel, "gì_đó");
});

test("mapAdsProfileRow: đọc đủ cột profile (profileId là scope của mọi call Ads)", () => {
  const row = mapAdsProfileRow({
    seller_account_id: SHOP_A,
    shop: "A1 · US",
    ads_profile_id: "111",
    marketplace: "ATVPDKIKX0DER",
    country_code: "US",
    currency: "USD",
    timezone: "America/Los_Angeles",
    account_id: "ENTITY_US",
    account_type: "seller",
    account_name: "VEXIM US",
    daily_budget: "100.50",
    is_default: true,
    source: "ads_api",
    last_synced_at: "2026-09-13T04:00:00Z",
    campaigns_known: "7",
    last_metrics_day: "2026-09-12",
  });
  assert.equal(row.profileId, "111");
  assert.equal(row.dailyBudget, 100.5);
  assert.equal(row.isDefault, true);
  assert.equal(row.campaignsKnown, 7);
  assert.ok(ADS_PROFILE_SELECT.includes("ads_profile_id"));
});

test("định dạng: tiền/%/xu hướng/'bao lâu trước' — null luôn ra '—'", () => {
  assert.equal(moneyText(null), "—");
  assert.equal(moneyText(0, "USD"), "0.00 USD", "0 thật phải hiện 0");
  assert.equal(moneyText(1234.5, "USD"), "1,234.50 USD");
  assert.equal(moneyText(12.5, null), "12.50");

  assert.equal(pctText(null), "—");
  assert.equal(pctText(36.67), "36.7%");
  assert.equal(pctText(25, 0), "25%");
  assert.equal(ratioText(2.7273), "2.73");
  assert.equal(countText(null), "—");
  assert.equal(countText(1234), "1,234");

  assert.equal(agoText(null), "chưa rõ");
  assert.equal(agoText(0.25), "15 phút trước");
  assert.equal(agoText(2.5), "2.5 giờ trước");
  assert.equal(agoText(26), "26.0 giờ trước", "dưới 48 giờ vẫn nói theo giờ — chính xác hơn");

  assert.equal(trendText(null), "—");
  assert.equal(trendText(0.2), "đi ngang");
  assert.equal(trendText(4.2), "ACOS xấu đi 4.2 điểm");
  assert.equal(trendText(-3), "ACOS tốt hơn 3.0 điểm");
  assert.equal(trendTone(4.2), "down", "ACOS tăng = xấu");
  assert.equal(trendTone(-3), "up");
  assert.equal(trendTone(null), "flat");
});

/* ================================================================== */
/* 2. Tổng hợp theo tiền tệ                                           */
/* ================================================================== */
test("totalsByCurrency: KHÔNG cộng tiền khác tiền tệ, nhóm spend lớn nhất lên đầu", () => {
  const totals = totalsByCurrency([
    mapAdsKpi(kpiA()),
    mapAdsKpi(kpiB()),
    mapAdsKpi(kpiA({ seller_account_id: "cccc", shop: "C3 · UK", currency: "GBP", spend7: "80", ad_sales7: "240" })),
  ]);
  assert.equal(totals.length, 2, "USD và GBP phải tách");
  assert.equal(totals[0].currency, "USD");
  assert.equal(totals[1].currency, "GBP");
  assert.equal(totals[1].spend7, 80, "không được trộn 100+10+80 thành 190");
  assert.equal(primaryTotals(totals)?.currency, "USD");
  assert.equal(primaryTotals([]), null);
});

test("totalsByCurrency: ACOS/ROAS/CTR/CPC = TỔNG/TỔNG, không phải trung bình tỷ lệ", () => {
  const t = primaryTotals(totalsByCurrency([mapAdsKpi(kpiA()), mapAdsKpi(kpiB())]))!;
  assert.equal(t.shops, 2);
  assert.equal(t.spend7, 110);
  assert.equal(t.adSales7, 300);
  // Trung bình cộng acos7 của 2 shop = (50+10)/2 = 30 — SAI. Đúng phải là 110/300.
  assert.equal(t.acos7, 36.67);
  assert.notEqual(t.acos7, 30);
  assert.equal(t.roas7, 2.73);
  assert.equal(t.ctr7, 1.667);
  assert.equal(t.cpc7, 0.44);
  assert.equal(t.spendYesterday, 15.5);
  assert.equal(t.adOrders7, 12);
  assert.equal(t.campaignsEnabled, 5);
  assert.equal(t.campaignsOverTarget, 1);
  assert.equal(t.campaignsExhausted, 1);
  assert.equal(t.budgetDailyTotal, 95);
  assert.equal(t.metricsDay, "2026-09-12", "ngày mới nhất trong nhóm");
  assert.deepEqual(t.shopNames, ["A1 · US", "B2 · US"]);
});

test("totalsByCurrency: TACOS — đủ dữ liệu thì tính; thiếu MỘT shop thì null hoặc gắn cờ một phần", () => {
  const full = primaryTotals(totalsByCurrency([mapAdsKpi(kpiA()), mapAdsKpi(kpiB())]))!;
  assert.equal(full.totalSales7, 1500);
  assert.equal(full.tacos7, 7.33, "110/1500 = 7.33%");
  assert.equal(full.tacosUnknownShops, 0);
  assert.equal(full.tacosPartial, false);

  // Shop B chưa có tổng doanh thu (Module 4 chưa đồng bộ)
  const partial = primaryTotals(
    totalsByCurrency([mapAdsKpi(kpiA()), mapAdsKpi(kpiB({ total_sales7: null, tacos_unknown: true }))]),
  )!;
  assert.equal(partial.totalSales7, null, "không được công bố tổng doanh thu khi thiếu một shop");
  assert.equal(partial.tacosUnknownShops, 1);
  assert.equal(partial.tacosPartial, true);
  assert.equal(partial.tacos7, 10, "TACOS tính TRÊN TẬP ĐÃ BIẾT: 100/1000 = 10%");

  // Chưa shop nào có tổng doanh thu → TACOS null (không phải 0)
  const none = primaryTotals(
    totalsByCurrency([
      mapAdsKpi(kpiA({ total_sales7: null, tacos_unknown: true })),
      mapAdsKpi(kpiB({ total_sales7: null, tacos_unknown: true })),
    ]),
  )!;
  assert.equal(none.tacos7, null);
  assert.equal(none.tacosPartial, false);
  assert.equal(none.tacosUnknownShops, 2);
});

test("totalsByCurrency: không có sales/spend → tỷ lệ null (không chia 0, không bịa)", () => {
  const t = primaryTotals(
    totalsByCurrency([mapAdsKpi(kpiA({ spend7: "0", ad_sales7: "0", clicks7: "0", impressions7: "0" }))]),
  )!;
  assert.equal(t.acos7, null);
  assert.equal(t.roas7, null);
  assert.equal(t.ctr7, null);
  assert.equal(t.cpc7, null);
  assert.equal(t.tacos7, 0, "spend 0 trên tổng doanh thu 1000 = 0% THẬT (đã đo, không phải chưa biết)");
});

test("totalsByCurrency: dữ liệu cũ — staleShops đếm shop, hoursSinceImport lấy shop TỆ NHẤT", () => {
  const t = primaryTotals(totalsByCurrency([mapAdsKpi(kpiA()), mapAdsKpi(kpiB())]))!;
  assert.equal(t.staleShops, 1);
  assert.equal(t.hoursSinceImport, 26, "phải lấy max: nói 'vừa nhập 2.5 giờ trước' trong khi 1 shop trễ 26 giờ là nói dối");
  assert.equal(t.lastImportedAt, "2026-09-13T04:05:00Z");
});

/* ================================================================== */
/* 3. KPI cards                                                       */
/* ================================================================== */
test("buildAdsKpis: chưa có dữ liệu → 4 card '—' kèm lý do, tuyệt đối không hiện 0", () => {
  const cards = buildAdsKpis(null);
  assert.equal(cards.length, 4);
  for (const c of cards) {
    assert.equal(c.value, "—");
    assert.match(c.sub, /chưa có dữ liệu Ads/);
  }
});

test("buildAdsKpis: có dữ liệu → spend/ACOS/TACOS/CPC đúng số, nhãn nêu rõ tiền tệ", () => {
  const cards = buildAdsKpis(primaryTotals(totalsByCurrency([mapAdsKpi(kpiA()), mapAdsKpi(kpiB())])));
  assert.equal(cards[0].label, "Spend Ads 7 ngày · USD");
  assert.equal(cards[0].value, "110.00 USD");
  assert.match(cards[0].sub, /12 đơn từ ads/);
  assert.match(cards[0].sub, /15.50 USD/);

  assert.equal(cards[1].value, "36.7%");
  assert.match(cards[1].sub, /ROAS 2.73/);
  assert.match(cards[1].sub, /1 campaign vượt ngưỡng/);
  assert.equal(cards[1].tone, "down");

  assert.equal(cards[2].value, "7.3%");
  assert.match(cards[2].sub, /1,500.00 USD/);
  assert.equal(cards[2].tone, "up");

  assert.equal(cards[3].value, "0.44 USD");
  assert.match(cards[3].sub, /CTR 1.67%/);
  assert.match(cards[3].sub, /250 click/);
});

test("buildAdsKpis: TACOS chưa tính được → '—' + nói thiếu gì; một phần → nói rõ bao nhiêu shop", () => {
  const unknown = buildAdsKpis(
    primaryTotals(
      totalsByCurrency([
        mapAdsKpi(kpiA({ total_sales7: null, tacos_unknown: true })),
        mapAdsKpi(kpiB({ total_sales7: null, tacos_unknown: true })),
      ]),
    ),
  );
  assert.equal(unknown[2].value, "—");
  assert.match(unknown[2].sub, /2\/2 shop chưa có tổng doanh thu/);
  assert.equal(unknown[2].tone, "warn");

  const partial = buildAdsKpis(
    primaryTotals(
      totalsByCurrency([mapAdsKpi(kpiA()), mapAdsKpi(kpiB({ total_sales7: null, tacos_unknown: true }))]),
    ),
  );
  assert.equal(partial[2].value, "10.0%");
  assert.match(partial[2].sub, /chỉ 1\/2 shop có tổng doanh thu/);
  assert.equal(partial[2].tone, "warn", "số một phần phải cảnh báo, không hiện như số đầy đủ");

  // TACOS cao → tone đỏ
  const high = buildAdsKpis(
    primaryTotals(totalsByCurrency([mapAdsKpi(kpiA({ spend7: "400", total_sales7: "1000", tacos7: "40" }))])),
  );
  assert.equal(high[2].tone, "down");
});

/* ================================================================== */
/* 4. Danh sách việc cần làm                                          */
/* ================================================================== */
const CAMPAIGNS = [
  mapAdsCampaign(campaign()), // over target, spend 210, budget 84%
  mapAdsCampaign(campaign({ campaign_id: "c2", campaign_name: "SP auto", spend7: "60", daily_budget: "30", budget_used_pct: "100", budget_exhausted: true, over_acos_target: false })),
  mapAdsCampaign(campaign({ campaign_id: "c3", campaign_name: "SP nhỏ", spend7: "0", budget_used_pct: null, over_acos_target: true })),
];

test("buildAdsAlerts: dữ liệu cũ lên ĐẦU (mọi con số khác đều đáng ngờ)", () => {
  const alerts = buildAdsAlerts({
    totals: totalsByCurrency([mapAdsKpi(kpiA()), mapAdsKpi(kpiB())]),
    campaigns: CAMPAIGNS,
    searchTerms: [],
    reportRequests: [],
  });
  assert.equal(alerts[0].tone, "red");
  assert.match(alerts[0].text, /Dữ liệu Ads USD cũ/);
  assert.match(alerts[0].text, /1\/2 shop/);
  assert.match(alerts[0].text, /26.0 giờ trước/);
  assert.match(alerts[0].text, /phase=poll/);
});

test("buildAdsAlerts: cạn ngân sách = đỏ, vượt ACOS = vàng, xếp theo spend", () => {
  const alerts = buildAdsAlerts({ totals: [], campaigns: CAMPAIGNS, searchTerms: [], reportRequests: [] });
  const exhausted = alerts.find((a) => /cạn ngân sách/.test(a.text));
  assert.equal(exhausted?.tone, "red");
  assert.match(exhausted!.text, /SP auto/);
  assert.match(exhausted!.text, /100%/);

  const over = alerts.find((a) => /ACOS 35.0% > ngưỡng 25%/.test(a.text));
  assert.equal(over?.tone, "amber");
  assert.match(over!.text, /ACOS xấu đi 4.2 điểm/);
  assert.ok(
    !alerts.some((a) => /SP nhỏ/.test(a.text)),
    "campaign spend 0 vượt ngưỡng thì chưa đáng báo (ACOS của 0 đồng là vô nghĩa)",
  );
});

test("buildAdsAlerts: search term đốt tiền — loại placement '*', kèm tổng tiền đang mất", () => {
  const terms = [
    mapAdsSearchTerm(term({ search_term: "cheap bag", clicks: "5", sales7: "0", spend: "4.2", wasted_spend_signal: true })),
    mapAdsSearchTerm(term({ search_term: "bag for men", clicks: "3", sales7: "0", spend: "2.1", wasted_spend_signal: true })),
    mapAdsSearchTerm(term({ search_term: "*", clicks: "9", sales7: "0", spend: "8", wasted_spend_signal: true })),
    mapAdsSearchTerm(term({ search_term: "good bag", clicks: "4", sales7: "30", spend: "3" })),
  ];
  const alerts = buildAdsAlerts({ totals: [], campaigns: [], searchTerms: terms, reportRequests: [] });
  const wasted = alerts.find((a) => /đốt/.test(a.text));
  assert.equal(wasted?.tone, "amber");
  assert.match(wasted!.text, /2 search term/);
  assert.match(wasted!.text, /6.30 USD/, "4.2 + 2.1, KHÔNG tính 8 của placement");
  assert.match(wasted!.text, /cheap bag/, "nặng nhất trước");
  assert.match(wasted!.text, /Phần 2/, "phải nói rõ chưa tự thêm negative keyword");
});

test("buildAdsAlerts: report chờ quá 2 giờ + report hỏng; không có gì → xanh", () => {
  const alerts = buildAdsAlerts({
    totals: [],
    campaigns: [],
    searchTerms: [],
    reportRequests: [
      mapAdsReportRequest(report({ id: "r1", status: "processing", is_stale: true, age_minutes: "180", report_type_id: "spSearchTerm" })),
      mapAdsReportRequest(report({ id: "r2", status: "failed", failure_reason: "Invalid columns: sales30d" })),
    ],
  });
  assert.match(alerts[0].text, /1 report chờ quá 2 giờ/);
  assert.match(alerts[0].text, /3 giờ/);
  assert.match(alerts[1].text, /hỏng: Invalid columns: sales30d/);

  const calm = buildAdsAlerts({ totals: [], campaigns: [], searchTerms: [], reportRequests: [] });
  assert.equal(calm.length, 1);
  assert.equal(calm[0].tone, "green");
});

test("buildAdsAlerts: TACOS chưa tính được phải báo (CEO dễ tưởng ads rẻ)", () => {
  const alerts = buildAdsAlerts({
    totals: totalsByCurrency([mapAdsKpi(kpiA({ total_sales7: null, tacos_unknown: true }))]),
    campaigns: [],
    searchTerms: [],
    reportRequests: [],
  });
  const tacos = alerts.find((a) => /TACOS/.test(a.text));
  assert.equal(tacos?.tone, "amber");
  assert.match(tacos!.text, /1\/1 shop thiếu tổng doanh thu/);
  assert.match(tacos!.text, /không suy ra 0%/);
});

test("buildAdsAlerts tôn trọng limit", () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    mapAdsCampaign(campaign({ campaign_id: `c${i}`, campaign_name: `C${i}`, budget_exhausted: true, budget_used_pct: "100" })),
  );
  assert.equal(buildAdsAlerts({ totals: [], campaigns: many, searchTerms: [], reportRequests: [], limit: 3 }).length, 3);
});

test("bảng xếp hạng: lọc + sắp đúng thứ tự ưu tiên", () => {
  const over = campaignsOverTarget(CAMPAIGNS);
  assert.deepEqual(over.map((c) => c.campaignId), ["c1"], "chỉ campaign CÓ spend và vượt ngưỡng");

  const budget = budgetWatch(CAMPAIGNS);
  assert.deepEqual(budget.map((c) => c.campaignId), ["c2", "c1"], "cạn 100% trước, rồi 84%");
  assert.equal(budgetWatch(CAMPAIGNS, 10, 90).length, 1, "ngưỡng 90% thì chỉ c2");

  // a/b/c: có spend nhưng 0 đơn → KHÔNG phải term hiệu quả (acos null vì không sales)
  const terms = [
    mapAdsSearchTerm(term({ search_term: "a", spend: "5", sales7: "0", ad_orders7: "0", acos7: null })),
    mapAdsSearchTerm(term({ search_term: "b", spend: "50", sales7: "0", ad_orders7: "0", acos7: null })),
    mapAdsSearchTerm(
      term({ search_term: "c", spend: "20", clicks: "4", sales7: "0", ad_orders7: "0", acos7: null, wasted_spend_signal: true }),
    ),
    mapAdsSearchTerm(term({ search_term: "d", spend: "30", sales7: "100", acos7: "30", ad_orders7: "3" })),
    mapAdsSearchTerm(term({ search_term: "e", spend: "40", sales7: "80", acos7: "50", ad_orders7: "2" })),
  ];
  assert.deepEqual(topSearchTerms(terms).map((t) => t.term), ["b", "e", "d", "c", "a"]);
  assert.deepEqual(wastedSearchTerms(terms).map((t) => t.term), ["c"]);
  assert.deepEqual(bestSearchTerms(terms).map((t) => t.term), ["d", "e"], "ACOS thấp trước");
  assert.equal(topSearchTerms(terms, 2).length, 2);
});

/* ================================================================== */
/* 5. Chuỗi ngày + biểu đồ                                            */
/* ================================================================== */
test("dailySeries: cộng theo ngày trong MỘT tiền tệ, không tự điền ngày trống", () => {
  const points = [
    mapAdsDaily(daily({ day: "2026-09-11", spend: "10", sales7d: "50", clicks: "5" })),
    mapAdsDaily(daily({ day: "2026-09-11", campaign_id: "c2", spend: "5", sales7d: "0", clicks: "2" })),
    mapAdsDaily(daily({ day: "2026-09-12", spend: "20", sales7d: "100", clicks: "8" })),
    mapAdsDaily(daily({ day: "2026-09-12", currency: "GBP", spend: "7", sales7d: "30", clicks: "3" })),
  ];
  const usd = dailySeries(points, "USD");
  assert.equal(usd.length, 2);
  assert.deepEqual(usd[0], { day: "2026-09-11", spend: 15, sales: 50, clicks: 7, acos: 30 });
  assert.deepEqual(usd[1], { day: "2026-09-12", spend: 20, sales: 100, clicks: 8, acos: 20 });

  const all = dailySeries(points);
  assert.equal(all[1].spend, 27, "không lọc tiền tệ thì cộng cả GBP — chỉ dùng khi biết rõ một tiền");
  assert.equal(all[1].acos, 20.77);

  // ngày không có sales → acos null chứ không chia 0
  assert.equal(dailySeries([mapAdsDaily(daily({ sales7d: "0", spend: "5" }))])[0].acos, null);
  assert.deepEqual(dailySeries([]), []);
});

test("spendBars: pct theo ngày spend cao nhất, thanh CUỐI là ngày mới nhất CÓ SỐ", () => {
  const series = dailySeries([
    mapAdsDaily(daily({ day: "2026-09-10", spend: "10" })),
    mapAdsDaily(daily({ day: "2026-09-11", spend: "20" })),
    mapAdsDaily(daily({ day: "2026-09-12", spend: "5" })),
  ]);
  const bars = spendBars(series);
  assert.deepEqual(bars.map((b) => b.pct), [50, 100, 25]);
  assert.deepEqual(bars.map((b) => b.label), ["09-10", "09-11", "09-12"]);
  assert.equal(bars[2].today, true, "đánh dấu ngày cuối có dữ liệu, KHÔNG phải hôm nay theo đồng hồ");
  assert.equal(bars[0].today, false);

  // sàn 2% để ngày spend nhỏ vẫn nhìn thấy
  const floor = spendBars(dailySeries([mapAdsDaily(daily({ day: "2026-09-11", spend: "100" })), mapAdsDaily(daily({ day: "2026-09-12", spend: "0.01" }))]));
  assert.equal(floor[1].pct, 2);

  // cắt theo maxDays, lấy phần CUỐI (mới nhất)
  const many = Array.from({ length: 20 }, (_, i) =>
    mapAdsDaily(daily({ day: `2026-08-${String(i + 1).padStart(2, "0")}`, spend: String(i + 1) })),
  );
  assert.equal(spendBars(dailySeries(many), 14).length, 14);
  assert.equal(spendBars([]).length, 0);
});

/* ================================================================== */
/* 6. Sức khoẻ đồng bộ + empty state                                  */
/* ================================================================== */
test("summarizeSyncHealth: đếm đúng từng nhóm trạng thái", () => {
  const health = summarizeSyncHealth([
    mapAdsReportRequest(report({ id: "1", status: "imported", rows_imported: "42", imported_at: "2026-09-13T04:06:00Z" })),
    mapAdsReportRequest(report({ id: "2", status: "imported", rows_imported: "8", imported_at: "2026-09-13T04:20:00Z" })),
    mapAdsReportRequest(report({ id: "3", status: "requested", ads_report_id: "r3", rows_imported: null })),
    mapAdsReportRequest(report({ id: "4", status: "processing", is_stale: true, rows_imported: null })),
    mapAdsReportRequest(report({ id: "5", status: "completed", rows_imported: null })),
    mapAdsReportRequest(report({ id: "6", status: "failed", rows_imported: null })),
    mapAdsReportRequest(report({ id: "7", status: "throttled", rows_imported: null })),
    mapAdsReportRequest(report({ id: "8", status: "no_data", shop: "B2 · US", rows_imported: null })),
  ]);
  assert.equal(health.total, 8);
  assert.equal(health.imported, 2);
  assert.equal(health.waiting, 3, "requested + processing + completed (chờ nhập)");
  assert.equal(health.failed, 2, "failed + throttled");
  assert.equal(health.stale, 1);
  assert.equal(health.rowsImported, 50);
  assert.equal(health.lastImportedAt, "2026-09-13T04:20:00Z");
  assert.deepEqual(health.shops, ["A1 · US", "B2 · US"]);
  assert.equal(health.byStatus.imported, 2);
});

test("emptyStateReason: mỗi trạng thái thiếu dữ liệu một chỉ dẫn KHÁC nhau", () => {
  const noConn = emptyStateReason({ kpis: [], reportRequests: [], profiles: 0 });
  assert.equal(noConn.title, "Chưa có kết nối Amazon Ads");
  assert.ok(noConn.lines.some((l) => /module0\/connect/.test(l)));
  assert.ok(noConn.lines.some((l) => /dryRun=1/.test(l)));

  const noReport = emptyStateReason({ kpis: [], reportRequests: [], profiles: 2 });
  assert.match(noReport.title, /chưa xin report/);
  assert.ok(noReport.lines.some((l) => /CRON_SECRET/.test(l)));

  const waiting = emptyStateReason({
    kpis: [],
    reportRequests: [mapAdsReportRequest(report({ status: "requested" })), mapAdsReportRequest(report({ status: "processing" }))],
    profiles: 2,
  });
  assert.equal(waiting.title, "Report đang được Amazon tạo");
  assert.ok(waiting.lines.some((l) => /2 report đang chờ/.test(l)));

  const stuck = emptyStateReason({
    kpis: [],
    reportRequests: [mapAdsReportRequest(report({ status: "no_data" }))],
    profiles: 2,
  });
  assert.match(stuck.title, /chưa nhập được dòng nào/);
  assert.ok(stuck.lines.some((l) => /no_data/.test(l)));

  assert.deepEqual(emptyStateReason({ kpis: [mapAdsKpi(kpiA())], reportRequests: [], profiles: 1 }).lines, []);
});

test("summarizeAdsForDashboard: tóm tắt cho card CEO", () => {
  const s = summarizeAdsForDashboard([mapAdsKpi(kpiA()), mapAdsKpi(kpiB())]);
  assert.equal(s.hasData, true);
  assert.equal(s.shopCount, 2);
  assert.deepEqual(s.currencies, ["USD"]);
  assert.equal(s.primary?.currency, "USD");
  assert.equal(s.staleShops, 1);
  assert.equal(s.campaignsOverTarget, 1);
  assert.equal(s.campaignsExhausted, 1);
  assert.equal(s.campaignsEnabled, 5);
  assert.equal(s.hoursSinceImport, 26);

  const none = summarizeAdsForDashboard([]);
  assert.equal(none.hasData, false);
  assert.equal(none.primary, null);
  assert.deepEqual(none.currencies, []);
});

/* ================================================================== */
/* 7. Dashboard: card Ads/TACOS                                       */
/* ================================================================== */
const ADS_SUMMARY = summarizeAdsForDashboard([mapAdsKpi(kpiA()), mapAdsKpi(kpiB())]);
const ADS_EMPTY = summarizeAdsForDashboard([]);

test("buildAdsKpi: chưa đọc được / chưa đồng bộ → '—' + lý do, KHÔNG hiện 0%", () => {
  const noData = buildAdsKpi(null);
  assert.equal(noData.value, "—");
  assert.match(noData.sub, /chưa đồng bộ Ads/);
  assert.equal(noData.tone, "warn");

  const readError = buildAdsKpi(null, "Chưa có view vexim_ads_kpis — cần chạy migration 0020");
  assert.equal(readError.value, "—");
  assert.match(readError.sub, /0020/, "phải nói thẳng chưa chạy migration nào");

  const empty = buildAdsKpi(ADS_EMPTY);
  assert.equal(empty.value, "—");
  assert.equal(empty.tone, "warn");
});

test("buildAdsKpi: có dữ liệu → spend + TACOS + ACOS + độ tươi", () => {
  const k = buildAdsKpi(ADS_SUMMARY);
  assert.equal(k.label, "Ads 7 ngày · USD");
  assert.equal(k.value, "110.00");
  assert.match(k.sub, /TACOS 7.3%/);
  assert.match(k.sub, /ACOS 36.7%/);
  assert.match(k.sub, /DỮ LIỆU CŨ 1 shop/, "có shop stale thì phải nói, không hiện 'vừa nhập'");
  assert.equal(k.tone, "down");

  const fresh = buildAdsKpi(summarizeAdsForDashboard([mapAdsKpi(kpiA())]));
  assert.match(fresh.sub, /nhập 2.5 giờ trước/);
  assert.equal(fresh.tone, "warn", "còn 1 campaign vượt ngưỡng ACOS");

  const allGood = buildAdsKpi(
    summarizeAdsForDashboard([mapAdsKpi(kpiA({ campaigns_over_target: "0", campaigns_exhausted: "0" }))]),
  );
  assert.equal(allGood.tone, "up");

  const noTacos = buildAdsKpi(summarizeAdsForDashboard([mapAdsKpi(kpiA({ total_sales7: null, tacos_unknown: true }))]));
  assert.match(noTacos.sub, /TACOS — \(thiếu tổng doanh thu\)/);
});

test("buildPpcDeptSummary + ppcAlertCount + buildAdsDetailLine", () => {
  const none = buildPpcDeptSummary(null);
  assert.equal(none.name, "Quảng cáo (PPC)");
  assert.equal(none.href, "/ppc");
  assert.equal(none.kpi, "chưa có số liệu");
  assert.match(none.kpiSub, /cron ads-sync/);
  assert.equal(none.tone, "flat");
  assert.equal(buildAdsDetailLine(null), null);
  assert.equal(ppcAlertCount(null), 0);

  const card = buildPpcDeptSummary(ADS_SUMMARY);
  assert.equal(card.kpi, "110.00 · ACOS 36.7%");
  assert.match(card.kpiSub, /TACOS 7.3%/);
  assert.match(card.kpiSub, /DỮ LIỆU CŨ 1 shop/);
  assert.equal(card.alertCount, 3, "1 shop stale + 1 campaign vượt ngưỡng + 1 campaign cạn ngân sách");
  assert.equal(card.tone, "down");

  assert.equal(ppcAlertCount(ADS_SUMMARY), 1 + 1 + 1, "stale + over target + exhausted");

  const line = buildAdsDetailLine(ADS_SUMMARY)!;
  assert.match(line, /2 shop · 110.00 USD spend 7 ngày/);
  assert.match(line, /ACOS 36.7%/);
  assert.match(line, /TACOS 7.3%/);
  assert.match(line, /12 đơn từ ads/);
  assert.match(line, /1 campaign cạn ngân sách/);
  assert.match(line, /số liệu tới 2026-09-12/);

  const noTacos = buildAdsDetailLine(summarizeAdsForDashboard([mapAdsKpi(kpiA({ total_sales7: null, tacos_unknown: true }))]));
  assert.match(noTacos!, /TACOS chưa tính được/);
});

/* ================================================================== */
/* 8. F4: ads_spend + TACOS                                           */
/* ================================================================== */
function profitRow(p: Partial<SkuProfitDbRow> = {}): SkuProfitDbRow {
  return {
    seller_account_id: SHOP_A,
    shop: "A1 · US",
    sku: "SKU-1",
    day: "2026-09-10",
    currency: "USD",
    units: 5,
    revenue: 100,
    refunds: 0,
    amazon_fees: -20,
    promo: 0,
    cogs: 40,
    ads_spend: null,
    gross_profit: 40,
    unit_cost: 8,
    fee_source: "settled",
    computed_at: "2026-09-11T02:00:00Z",
    ...p,
  };
}

test("adsTacosPct: tỷ lệ ads/doanh thu; null khi chưa có số ads (KHÔNG phải 0)", () => {
  assert.equal(adsTacosPct(12.5, 100), 0.125);
  assert.equal(percent(adsTacosPct(12.5, 100)), "12.5%");
  assert.equal(adsTacosPct(null, 100), null);
  assert.equal(adsTacosPct(10, 0), null, "doanh thu 0 → không chia");
  assert.equal(adsTacosPct(0, 100), 0, "ads 0 THẬT (đã đo) thì TACOS 0% là đúng");
});

test("aggregateProfit: ads_spend là CỘT RIÊNG — không trừ vào lãi gộp", () => {
  const [row] = aggregateProfit([profitRow({ ads_spend: 12.5 })]);
  assert.equal(row.grossProfit, 40, "lãi gộp KHÔNG đổi khi có ads_spend (thiết kế 0015)");
  assert.equal(row.adsSpend, 12.5);
  assert.equal(row.adsDays, 1);
  assert.equal(row.hasFullAds, true);
  assert.equal(row.tacos, 0.125, "12.5/100");
});

test("aggregateProfit: chưa ngày nào có ads → adsSpend NULL (không mặc định 0)", () => {
  const [row] = aggregateProfit([profitRow({ day: "2026-09-10" }), profitRow({ day: "2026-09-11" })]);
  assert.equal(row.adsSpend, null);
  assert.equal(row.adsDays, 0);
  assert.equal(row.hasFullAds, false);
  assert.equal(row.tacos, null);
});

test("aggregateProfit: chỉ MỘT PHẦN ngày có ads → cộng phần biết + gắn cờ thiếu", () => {
  const [row] = aggregateProfit([
    profitRow({ day: "2026-09-10", ads_spend: 10, revenue: 100 }),
    profitRow({ day: "2026-09-11", ads_spend: null, revenue: 100 }),
  ]);
  assert.equal(row.adsSpend, 10);
  assert.equal(row.adsDays, 1);
  assert.equal(row.days, 2);
  assert.equal(row.hasFullAds, false, "1/2 ngày → con tổng đang THIẾU, UI phải nói");
  assert.equal(row.tacos, 0.05, "10/200 — TACOS THẤP HƠN thật vì tử số thiếu");
});

test("aggregateProfit: thiếu giá vốn vẫn tính được ads/TACOS (hai chuyện độc lập)", () => {
  const [row] = aggregateProfit([profitRow({ cogs: null, gross_profit: null, ads_spend: 8 })]);
  assert.equal(row.grossProfit, null);
  assert.equal(row.hasFullCost, false);
  assert.equal(row.adsSpend, 8);
  assert.equal(row.tacos, 0.08);
});

test("profitKpis: tổng ads + TACOS + cờ adsPartial để UI không trình bày số thiếu như số đủ", () => {
  const none = profitKpis([profitRow(), profitRow({ day: "2026-09-11" })]);
  assert.equal(none.adsSpend, null);
  assert.equal(none.tacos, null);
  assert.equal(none.adsRows, 0);
  assert.equal(none.rowsMissingAds, 2);
  assert.equal(none.adsPartial, false);

  const full = profitKpis([
    profitRow({ revenue: 100, ads_spend: 10 }),
    profitRow({ day: "2026-09-11", revenue: 100, ads_spend: 5 }),
  ]);
  assert.equal(full.adsSpend, 15);
  assert.equal(full.revenue, 200);
  assert.equal(full.tacos, 0.075);
  assert.equal(percent(full.tacos), "7.5%");
  assert.equal(full.adsPartial, false);
  assert.equal(full.rowsMissingAds, 0);

  const partial = profitKpis([
    profitRow({ revenue: 100, ads_spend: 10 }),
    profitRow({ day: "2026-09-11", revenue: 100, ads_spend: null }),
  ]);
  assert.equal(partial.adsSpend, 10);
  assert.equal(partial.adsPartial, true);
  assert.equal(partial.adsRows, 1);
  assert.equal(partial.rowsMissingAds, 1);
  assert.equal(partial.tacos, 0.05);
  // lãi gộp KHÔNG bị ads_spend đụng vào
  assert.equal(partial.grossProfit, 80);
});

test("hằng số SELECT khớp tên cột view (đổi tên cột phải sửa cả hai nơi)", () => {
  assert.ok(ADS_KPI_SELECT.includes("tacos7") && ADS_KPI_SELECT.includes("tacos_unknown"));
  assert.ok(ADS_KPI_SELECT.includes("hours_since_import") && ADS_KPI_SELECT.includes("is_stale"));
  assert.equal(ADS_KPI_SELECT.split(",").length, 28, "khớp 28 cột đã chốt trong supabase/tests");
  assert.ok(ADS_PROFILE_SELECT.includes("ads_profile_id"));
});
