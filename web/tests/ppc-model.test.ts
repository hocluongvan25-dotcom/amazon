/**
 * Test model A1 — QUẢNG CÁO (Module 5 phần 1).
 *
 * Bốn thứ phải khoá (mỗi thứ ứng với một cách hiểu sai rất tốn tiền quảng cáo):
 *   1. Chuỗi select PHẢI khớp hợp đồng cột của view 0020 (harness BƯỚC 21 soát
 *      trên Postgres thật) — sai một cột là PGRST204 và sập trang.
 *   2. NULL khác 0: chưa có doanh thu ⇒ ACOS "—", KHÔNG hiện 0.0% (0% khiến người
 *      vận hành tưởng quảng cáo đang lãi, rồi tăng ngân sách).
 *   3. TACOS chỉ tính khi CÙNG TIỀN TỆ và CÙNG KỲ 7 ngày — TACOS sai kỳ/sai tiền
 *      tệ là con số vô nghĩa nhưng trông rất thuyết phục.
 *   4. Trạng thái ngân sách 'unknown' khi ngân sách khác tiền tệ với số chi:
 *      không được so USD với CAD rồi kết luận "cạn ngân sách".
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ADS_BUDGET_EVENT_SELECT,
  ADS_CAMPAIGN_SELECT,
  ADS_KPI_SELECT,
  adsMoney,
  adsNum,
  adsPct,
  budgetStateOf,
  campaignTypeBadge,
  computeTacos,
  isAcosOverTarget,
  kpiCardsFrom,
  ppcAlertsFrom,
  type AdsCampaignRaw,
  type AdsKpiRaw,
} from "../src/lib/data/ppc-model.ts";

const campaign = (over: Partial<AdsCampaignRaw> = {}): AdsCampaignRaw => ({
  seller_account_id: "shop-1",
  shop: "VEXIM US",
  ads_profile_id: "P-1",
  campaign_id: "C-1",
  campaign_type: "SPONSORED_PRODUCTS",
  name: "Vali 20 inch",
  state: "ENABLED",
  targeting_type: "MANUAL",
  daily_budget: 20,
  currency: "USD",
  last_day: "2026-09-12",
  spend_yesterday: 19.5,
  spend_7d: 100,
  spend_14d: 180,
  spend_30d: 400,
  sales_7d: 400,
  sales_14d: 700,
  sales_30d: 1500,
  purchases_7d: 12,
  units_7d: 14,
  clicks_7d: 100,
  impressions_7d: 5000,
  cpc_7d: 1,
  ctr_7d: 2,
  acos_7d: 25,
  acos_14d: 25.7,
  acos_30d: 26.7,
  roas_7d: 4,
  budget_usage_yesterday_pct: 97.5,
  budget_state: "capped",
  capped_days_30d: 3,
  last_capped_day: "2026-09-12",
  ...over,
});

const kpi = (over: Partial<AdsKpiRaw> = {}): AdsKpiRaw => ({
  seller_account_id: "shop-1",
  shop: "VEXIM US",
  currency: "USD",
  last_day: "2026-09-12",
  spend_7d: 100,
  spend_14d: 180,
  spend_30d: 400,
  sales_7d: 400,
  sales_14d: 700,
  sales_30d: 1500,
  purchases_7d: 12,
  units_7d: 14,
  clicks_7d: 100,
  impressions_7d: 5000,
  cpc_7d: 1,
  acos_7d: 25,
  acos_14d: 25.7,
  acos_30d: 26.7,
  roas_7d: 4,
  ...over,
});

// ---------------------------------------------------------------------------
// 1. Hợp đồng cột (phải khớp view 0020 — harness BƯỚC 21 kiểm tra chiều ngược lại)
// ---------------------------------------------------------------------------

test("ppc: chuỗi select khớp hợp đồng cột của view 0020 (tên cột camel hay snake đều đúng)", () => {
  for (const [name, sel] of [
    ["ADS_KPI_SELECT", ADS_KPI_SELECT],
    ["ADS_CAMPAIGN_SELECT", ADS_CAMPAIGN_SELECT],
    ["ADS_BUDGET_EVENT_SELECT", ADS_BUDGET_EVENT_SELECT],
  ] as const) {
    assert.ok(sel.trim().length > 0, `${name} rỗng`);
    assert.ok(!/\s/.test(sel), `${name} không được có khoảng trắng (PostgREST sẽ hiểu sai)`);
  }
  // Các cột suy ra phải có mặt — nếu view bỏ chúng thì UI mất số mà không rõ vì sao.
  for (const col of ["acos_7d", "acos_14d", "acos_30d", "roas_7d", "cpc_7d", "ctr_7d", "budget_state"]) {
    assert.ok(ADS_CAMPAIGN_SELECT.includes(col), `thiếu cột ${col} trong select campaign`);
  }
  for (const col of ["budget_usage_yesterday_pct", "spend_yesterday", "capped_days_30d"]) {
    assert.ok(ADS_CAMPAIGN_SELECT.includes(col), `thiếu cột ${col} trong select campaign`);
  }
  assert.ok(ADS_BUDGET_EVENT_SELECT.includes("hour_known"), "thiếu hour_known (biết cạn nhưng chưa biết giờ)");
});

// ---------------------------------------------------------------------------
// 2. NULL ≠ 0
// ---------------------------------------------------------------------------

test("ppc: NULL → '—', KHÔNG hiện 0 giả", () => {
  assert.equal(adsMoney(null, "USD"), "—");
  assert.equal(adsPct(null), "—");
  assert.equal(adsNum(null), "—");
  assert.equal(adsMoney(0, "USD"), "USD 0.00", "0 đo được thì phải hiện 0");
  assert.equal(adsPct(0), "0.0%");
});

test("ppc: ACOS NULL (chưa có doanh thu) KHÔNG bị coi là vượt ngưỡng", () => {
  assert.equal(isAcosOverTarget(null), false);
  assert.equal(isAcosOverTarget(25), false, "bằng đúng ngưỡng chưa tính là vượt");
  assert.equal(isAcosOverTarget(25.01), true);
});

// ---------------------------------------------------------------------------
// 3. Trạng thái ngân sách
// ---------------------------------------------------------------------------

test("ppc: ngân sách cạn / còn / chưa có số / KHÁC TIỀN TỆ được phân biệt rõ", () => {
  const capped = budgetStateOf(campaign({ budget_state: "capped", capped_days_30d: 3 }));
  assert.equal(capped.label, "Cạn ngân sách");
  assert.equal(capped.tone, "red");
  assert.match(capped.hint, /3 ngày cạn/);

  assert.equal(budgetStateOf(campaign({ budget_state: "ok" })).tone, "green");
  assert.equal(budgetStateOf(campaign({ budget_state: "no_data", budget_usage_yesterday_pct: null })).label, "Chưa có số");

  const unknown = budgetStateOf(campaign({ budget_state: "unknown", daily_budget: 20, currency: "USD" }));
  assert.equal(unknown.label, "Không so được");
  assert.match(unknown.hint, /KHÁC TIỀN TỆ/);

  const noBudget = budgetStateOf(campaign({ budget_state: "unknown", daily_budget: null }));
  assert.match(noBudget.hint, /chưa có ngân sách ngày/i);
});

test("ppc: loại campaign đọc được cả tên v3 lẫn mã ngắn v2", () => {
  assert.equal(campaignTypeBadge("SPONSORED_PRODUCTS").label, "SP");
  assert.equal(campaignTypeBadge("SP").label, "SP");
  assert.equal(campaignTypeBadge("SPONSORED_BRANDS").label, "SB");
  assert.equal(campaignTypeBadge("SPONSORED_DISPLAY").label, "SD");
  assert.equal(campaignTypeBadge(null).label, "—");
});

// ---------------------------------------------------------------------------
// 4. TACOS — chỉ tính khi cùng tiền tệ & cùng kỳ
// ---------------------------------------------------------------------------

test("ppc: TACOS = chi ads ÷ doanh thu sản phẩm 7 NGÀY CÓ SỐ (không phải 7 ngày lịch)", () => {
  const rows = [
    { day: "2026-09-12", currency: "USD", revenue: 500 },
    { day: "2026-09-11", currency: "USD", revenue: 500 },
    { day: "2026-09-05", currency: "USD", revenue: 9999 }, // NGOÀI cửa sổ 7 ngày → bỏ
  ];
  // spend 7d = 100, doanh thu trong cửa sổ = 1000 ⇒ 10%
  assert.equal(computeTacos(kpi({ spend_7d: 100 }), rows), 10);
});

test("ppc: TACOS KHÔNG trộn tiền tệ và trả null khi thiếu doanh thu", () => {
  const mixed = [
    { day: "2026-09-12", currency: "CAD", revenue: 1000 },
    { day: "2026-09-11", currency: "USD", revenue: 500 },
  ];
  // Chỉ 500 USD được tính (100/500 = 20%); dòng CAD bị bỏ
  assert.equal(computeTacos(kpi({ spend_7d: 100 }), mixed), 20);

  assert.equal(computeTacos(kpi(), [{ day: "2026-09-12", currency: "USD", revenue: 0 }]), null);
  assert.equal(computeTacos(kpi(), []), null);
  assert.equal(computeTacos(kpi({ spend_7d: null }), mixed), null);
  assert.equal(computeTacos(kpi({ currency: null }), mixed), null, "không rõ tiền tệ ⇒ không tính");
});

// ---------------------------------------------------------------------------
// 5. KPI & cảnh báo
// ---------------------------------------------------------------------------

test("ppc: KPI lấy dòng chi tiêu LỚN NHẤT của shop (không cộng USD với CAD)", () => {
  const cards = kpiCardsFrom([kpi({ currency: "CAD", spend_7d: 30 }), kpi({ currency: "USD", spend_7d: 300, acos_7d: 31 })], 7.5);
  assert.equal(cards.length, 5, "chi · ACOS · ROAS · TACOS · đơn");
  assert.equal(cards[0].value, "USD 300.00");
  assert.match(cards[0].sub, /2026-09-12/);
  assert.equal(cards[1].value, "31.0%");
  assert.equal(cards[1].tone, "down", "ACOS vượt 25% ⇒ đánh dấu xấu");
  assert.equal(cards[2].value, "4.00×", "ROAS suy ra = sales_7d ÷ spend_7d (v3 không trả cột này)");
  assert.equal(cards[2].tone, "up", "ROAS ≥ 4 là tốt theo ngưỡng đang dùng");
  assert.equal(kpiCardsFrom([], null).length, 0);
});

test("ppc: cảnh báo dựng từ số thật — không có gì bất thường thì nói thẳng là bình thường", () => {
  const alerts = ppcAlertsFrom({
    campaigns: [
      campaign({ budget_state: "capped" }),
      campaign({ campaign_id: "C-2", name: "Auto", acos_7d: 40, budget_state: "ok" }),
    ],
    budgetEvents: [
      {
        id: "e1",
        seller_account_id: "shop-1",
        shop: "VEXIM US",
        day: "2026-09-12",
        campaign_id: "C-1",
        campaign_name: "Vali 20 inch",
        event_type: "capped",
        budget_amount: 20,
        currency: "USD",
        cost: 19.5,
        usage_pct: 97.5,
        exhausted_hour: null,
        hour_source: "unavailable",
        hour_known: false,
        note: null,
      },
    ],
    negativeSuggestionsPending: 3,
  });
  assert.equal(alerts.length, 3);
  assert.equal(alerts[0].tone, "red");
  assert.match(alerts[0].text, /1 campaign cạn ngân sách/);
  assert.match(alerts[1].text, /"Auto" 40.0%/);
  assert.match(alerts[2].text, /3 gợi ý negative/);

  const calm = ppcAlertsFrom({
    campaigns: [campaign({ budget_state: "ok", acos_7d: 10 })],
    budgetEvents: [],
    negativeSuggestionsPending: 0,
  });
  assert.equal(calm.length, 1);
  assert.equal(calm[0].tone, "green");
});
