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
  ADS_AD_GROUP_SELECT,
  ADS_AUDIT_SELECT,
  ADS_BUDGET_EVENT_SELECT,
  ADS_CAMPAIGN_SELECT,
  ADS_CHANGE_SELECT,
  ADS_KPI_SELECT,
  ADS_NEGATIVE_KEYWORD_SELECT,
  ADS_SEARCH_TERM_SELECT,
  ADS_TARGET_SELECT,
  a3BlockRisk,
  a3ChangeKey,
  a3Evidence,
  a3FailedChange,
  a3HasOpenChange,
  a3InFlightMap,
  a3Freshness,
  a3LatestDay,
  A3_STALE_DAYS,
  auditActionLabel,
  changeActionLabel,
  changePct,
  changePctLabel,
  changeStatusMeta,
  changeSummary,
  a3ReadyToBlock,
  filterSearchTerms,
  matchTypeLabel,
  revertible,
  splitQueue,
  suggestionShortLabel,
  targetKindLabel,
  targetText,
  type AdsChangeRaw,
  type AdsSearchTermRaw,
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

/* ==================================================================== */
/* MODULE 5 PHẦN 2 & 3 — A2 · A3 · hàng đợi duyệt                       */
/* ==================================================================== */

const term = (over: Partial<AdsSearchTermRaw> = {}): AdsSearchTermRaw => ({
  seller_account_id: "shop-1",
  shop: "VEXIM US",
  campaign_id: "C-1",
  campaign_name: "Vali 20 inch",
  campaign_state: "ENABLED",
  ad_group_id: "AG-1",
  ad_group_name: "Nhóm chính",
  keyword_id: "KW-1",
  keyword_text: "vali kéo size 20",
  term: "vali 20 inch size 20",
  match_type: "BROAD",
  currency: "USD",
  last_day: "2026-09-12",
  impressions_7d: 1000,
  clicks_7d: 30,
  spend_7d: 15,
  sales_7d: 0,
  purchases_7d: 0,
  units_7d: 0,
  spend_14d: 30,
  sales_14d: 0,
  has_orders_7d: false,
  last_order_day: null,
  cpc_7d: 0.5,
  ctr_7d: 3,
  acos_7d: null,
  roas_7d: null,
  acos_14d: null,
  pending_suggestion_id: null,
  pending_suggestion_type: null,
  pending_confidence: null,
  pending_confidence_label: null,
  pending_reasons: null,
  pending_evidence: null,
  negative_keyword_id: null,
  negative_match_type: null,
  ...over,
});

const change = (over: Partial<AdsChangeRaw> = {}): AdsChangeRaw => ({
  id: "ch-1",
  seller_account_id: "shop-1",
  shop: "VEXIM US",
  ads_profile_id: "P-1",
  entity_type: "campaign",
  entity_key: "C-1",
  campaign_id: "C-1",
  ad_group_id: null,
  entity_label: "Vali 20 inch",
  action: "set_budget",
  payload: { value: 60 },
  before_value: { value: 40 },
  after_value: { value: 60 },
  before_text: "40",
  after_text: "60",
  currency: "USD",
  reason: null,
  suggestion_id: null,
  requires_approval: true,
  approval_reason: "Tăng 50.0%/ngày > 30% (SOP-05 bước 4) ⇒ cần trưởng phòng PPC duyệt.",
  status: "pending_approval",
  requested_by: "u1",
  requested_by_name: "Operator PPC",
  requested_at: "2026-09-13T02:00:00Z",
  decided_by: null,
  decided_by_name: null,
  decided_at: null,
  decision_note: null,
  applied_at: null,
  error: null,
  attempts: 0,
  revert_of: null,
  reverted_by: null,
  source: "web",
  is_open: true,
  can_revert: false,
  created_at: "2026-09-13T02:00:00Z",
  updated_at: "2026-09-13T02:00:00Z",
  ...over,
});

test("M5P2: bộ lọc A3 mặc định là luật SOP-04 (có click · chi ≥ 10 · 0 đơn)", () => {
  const rows = [
    term(),                                                       // đủ điều kiện
    term({ term: "từ khoá có đơn", purchases_7d: 3 }),            // có đơn ⇒ bỏ
    term({ term: "quá ít click", clicks_7d: 2, spend_7d: 40 }),   // < 5 click ⇒ bỏ
    term({ term: "chi nhỏ", clicks_7d: 30, spend_7d: 4 }),        // < 10 tiền ⇒ bỏ
  ];
  const out = filterSearchTerms(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].term, "vali 20 inch size 20");

  // Tắt "chỉ 0 đơn" ⇒ dòng có đơn quay lại, nhưng vẫn tôn trọng click/chi tối thiểu
  const all = filterSearchTerms(rows, { onlyNoOrders: false });
  assert.deepEqual(all.map((r) => r.term).sort(), ["từ khoá có đơn", "vali 20 inch size 20"]);
});

test("M5P3: filter A3 không loại dòng đã chặn (để đối chiếu) nhưng a3ReadyToBlock thì loại", () => {
  const rows = [
    term({ negative_keyword_id: "neg-1", negative_match_type: "NEGATIVE_EXACT" }),
    term({ term: "đang chờ duyệt", pending_suggestion_id: "sug-1", pending_suggestion_type: "negative_phrase" }),
    term({ term: "chưa có gì" }),
  ];
  assert.equal(filterSearchTerms(rows).length, 3);
  const ready = a3ReadyToBlock(rows);
  assert.equal(ready.length, 1);
  assert.equal(ready[0].term, "chưa có gì");
});

test("M5P3: thứ tự hàng đợi & nút Revert — chỉ dòng applied chưa bị đảo mới revert được", () => {
  const rows = [
    change(),
    change({ id: "ch-2", status: "applied", can_revert: true, applied_at: "2026-09-13T03:00:00Z" }),
    change({ id: "ch-3", status: "applied", can_revert: false, reverted_by: "ch-9" }),
    change({ id: "ch-4", status: "applying", can_revert: false }),
    change({ id: "ch-5", status: "failed", error: "INVALID_ARGUMENT" }),
  ];
  const q = splitQueue(rows);
  assert.equal(q.pending.length, 1);
  assert.deepEqual(q.inflight.map((r) => r.id), ["ch-4"]);
  assert.deepEqual(q.done.map((r) => r.id), ["ch-2", "ch-3", "ch-5"]);
  assert.deepEqual(revertible(rows).map((r) => r.id), ["ch-2"]);
});

test("M5P3: % thay đổi chỉ để HIỂN THỊ — DB mới là nơi quyết định duyệt", () => {
  assert.equal(changePct("40", "60"), 50);
  assert.equal(changePct("100", "120"), 20);
  assert.equal(changePct("0.61", "0.5"), -18);
  assert.equal(changePctLabel("40", "60"), "+50.0%");
  assert.equal(changePctLabel("0.61", "0.5"), "-18.0%");
  // Không so được ⇒ "—" (KHÔNG hiện 0%: 0% trông như "không đổi")
  assert.equal(changePct("0", "60"), null);
  assert.equal(changePct(null, "60"), null);
  assert.equal(changePct("abc", "60"), null);
  assert.equal(changePctLabel(null, null), "—");
});

test("M5P3: trạng thái nói rõ 'CHƯA gửi Amazon' để không ai tưởng đã xong", () => {
  assert.match(changeStatusMeta("pending_approval").label, /Chờ trưởng phòng/);
  assert.match(changeStatusMeta("pending_approval").hint, /Chưa gửi gì lên Amazon/);
  assert.equal(changeStatusMeta("applied").tone, "green");
  assert.equal(changeStatusMeta("failed").tone, "red");
  assert.match(changeStatusMeta("failed").hint, /GIỮ NGUYÊN/);
  assert.equal(changeActionLabel("add_negative_exact"), "Thêm negative (chính xác)");
  assert.equal(auditActionLabel("ads.change_released"), "Trả lại hàng đợi (throttle)");
});

test("M5P3: câu tóm tắt thay đổi đọc được bằng tiếng Việt (ngân sách · bid · negative)", () => {
  assert.equal(changeSummary(change()), "USD 40 → USD 60 (+50.0%)");
  assert.equal(
    changeSummary(change({ action: "set_bid", before_text: "0.61", after_text: "0.5", currency: "USD" })),
    "USD 0.61 → USD 0.5 (-18.0%)",
  );
  assert.equal(
    changeSummary(change({ action: "add_negative_exact", before_text: null, after_text: "vali size 20 hàng hiệu" })),
    'Chặn "vali size 20 hàng hiệu"',
  );
  assert.equal(
    changeSummary(change({ action: "set_state", before_text: "PAUSED", after_text: "ENABLED" })),
    "PAUSED → ENABLED",
  );
});

test("M5P2: nhãn target/match đọc được + bằng chứng A3 ghi đủ số", () => {
  assert.equal(targetKindLabel("keyword"), "Từ khoá");
  assert.equal(targetKindLabel("product"), "Nhóm sản phẩm");
  assert.equal(matchTypeLabel("NEGATIVE_PHRASE"), "Chặn cụm từ");
  assert.equal(targetText({ keyword_text: "vali", expression_value: "B0X", target_key: "K1" }), "vali");
  assert.equal(targetText({ expression_value: "B0X", target_key: "K1" }), "B0X");
  assert.equal(targetText({ target_key: "K1" }), "K1");
  assert.equal(targetText({}), "(không có tên)");
  assert.equal(suggestionShortLabel("negative_phrase"), "Phrase");
  assert.equal(suggestionShortLabel("negative_exact"), "Exact");
  assert.match(a3Evidence(term()), /30 click · 0 đơn · USD 15\.00 · 7 ngày/);
});

test("Hợp đồng cột 0021: chuỗi select khớp view (harness BƯỚC 22 soát trên Postgres thật)", () => {
  // Mỗi tên cột phải là một mục riêng, không có khoảng trắng thừa — PGRST204 nếu sai.
  for (const [label, select] of [
    ["vexim_ads_ad_groups", ADS_AD_GROUP_SELECT],
    ["vexim_ads_targets", ADS_TARGET_SELECT],
    ["vexim_ads_search_terms", ADS_SEARCH_TERM_SELECT],
    ["vexim_ads_changes", ADS_CHANGE_SELECT],
    ["vexim_ads_negative_keywords", ADS_NEGATIVE_KEYWORD_SELECT],
    ["vexim_ads_audit", ADS_AUDIT_SELECT],
  ] as const) {
    const cols = select.split(",");
    assert.ok(cols.length > 5, `${label}: chuỗi select quá ngắn`);
    for (const c of cols) {
      assert.equal(c, c.trim(), `${label}: cột "${c}" có khoảng trắng thừa`);
      assert.match(c, /^[a-z_][a-z0-9_]*$/, `${label}: cột "${c}" không hợp lệ`);
    }
    assert.equal(new Set(cols).size, cols.length, `${label}: cột trùng`);
  }
  // Cột quyết định của hàng đợi: thiếu `can_revert` là mất nút Revert 1 chạm.
  assert.ok(ADS_CHANGE_SELECT.includes("can_revert"));
  assert.ok(ADS_CHANGE_SELECT.includes("requires_approval"));
  assert.ok(ADS_CHANGE_SELECT.includes("approval_reason"));
  // A3: thiếu `pending_suggestion_id` là không duyệt được gợi ý nào.
  assert.ok(ADS_SEARCH_TERM_SELECT.includes("pending_suggestion_id"));
  assert.ok(ADS_SEARCH_TERM_SELECT.includes("negative_keyword_id"));
});

/* ==========================================================================
 * A3 (16/09/2026): "số này là số của NGÀY NÀO?" + chống chặn oan
 * --------------------------------------------------------------------------
 * Cột `*_7d` của view tính theo NGÀY DỮ LIỆU CUỐI, không phải hôm nay. Cron ngừng
 * chạy thì màn vẫn hiện "chi 7 ngày" của ba tuần trước mà không nói gì ⇒ người
 * vận hành tưởng số mới rồi đi chặn từ khoá. 2 hàm dưới đây là chốt chặn đó.
 * ========================================================================== */

test("A3: ngày dữ liệu mới nhất lấy MAX last_day, bỏ dòng rỗng", () => {
  assert.equal(a3LatestDay([]), null);
  assert.equal(a3LatestDay([term({ last_day: null }), term({ last_day: "2026-09-10" })]), "2026-09-10");
  assert.equal(
    a3LatestDay([term({ last_day: "2026-09-10" }), term({ last_day: "2026-09-14" }), term({ last_day: null })]),
    "2026-09-14",
  );
});

test("A3: dữ liệu hôm qua / hôm nay KHÔNG báo cũ (report ngày trễ T-1 là bình thường)", () => {
  const today = new Date("2026-09-16T05:00:00Z");
  const f = a3Freshness([term({ last_day: "2026-09-15" })], today);
  assert.equal(f.day, "2026-09-15");
  assert.equal(f.ageDays, 1);
  assert.equal(f.stale, false);
  assert.match(f.label, /cách đây 1 ngày/);
  assert.ok(!/CŨ/.test(f.label));

  const sameDay = a3Freshness([term({ last_day: "2026-09-16" })], today);
  assert.equal(sameDay.ageDays, 0);
  assert.equal(sameDay.stale, false);
  assert.match(sameDay.label, /hôm nay/);
});

test("A3: dữ liệu đứng quá ngưỡng ⇒ cảnh báo CŨ kèm số ngày", () => {
  const today = new Date("2026-09-16T05:00:00Z");
  const f = a3Freshness([term({ last_day: "2026-09-01" })], today);
  assert.equal(f.stale, true);
  assert.equal(f.ageDays, 15);
  assert.match(f.label, /2026-09-01/);
  assert.match(f.label, /CŨ/);
  // Ngưỡng là hằng số công khai — đổi ngưỡng thì phải đổi cả luật này.
  assert.equal(A3_STALE_DAYS, 2);
  assert.equal(a3Freshness([term({ last_day: "2026-09-14" })], today).stale, false, "đúng 2 ngày vẫn coi là bình thường");
  assert.equal(a3Freshness([term({ last_day: "2026-09-13" })], today).stale, true, "quá 2 ngày là cũ");
});

test("A3: chưa có dòng nào ⇒ không dọa 'cũ' (chỉ nói chưa có ngày)", () => {
  const f = a3Freshness([], new Date("2026-09-16T05:00:00Z"));
  assert.equal(f.day, null);
  assert.equal(f.stale, false);
  assert.equal(f.ageDays, null);
  assert.match(f.label, /chưa có ngày dữ liệu/);
});

test("A3: cảnh báo CHẶN OAN khi 14 ngày có doanh số mà 7 ngày không đơn", () => {
  const risky = a3BlockRisk(term({ purchases_7d: 0, sales_14d: 42.5, currency: "USD" }));
  assert.ok(risky, "phải có cảnh báo");
  assert.match(risky as string, /doanh số trong 14 ngày/);
  assert.match(risky as string, /USD 42\.50/);
  assert.match(risky as string, /cắt phần này/);
});

test("A3: KHÔNG cảnh báo khi 14 ngày cũng không có doanh số, khi 7 ngày đã có đơn, hoặc thiếu số", () => {
  assert.equal(a3BlockRisk(term({ purchases_7d: 0, sales_14d: 0 })), null);
  assert.equal(a3BlockRisk(term({ purchases_7d: 0, sales_14d: null })), null);
  assert.equal(a3BlockRisk(term({ purchases_7d: 0 })), null, "sales_14d undefined = chưa biết, không đoán");
  assert.equal(
    a3BlockRisk(term({ purchases_7d: 1, sales_14d: 99 })),
    null,
    "7 ngày đã có đơn thì bộ lọc SOP-04 không đụng tới dòng này",
  );
});

/* ==========================================================================
 * A3 (16/09/2026): yêu cầu chặn ĐANG BAY — chống bấm "Chặn" lần hai
 * --------------------------------------------------------------------------
 * Duyệt một gợi ý ⇒ `pending_suggestion_id` biến mất, gương negative chỉ có sau
 * khi worker ghi THÀNH CÔNG. Khoảng giữa đó màn phải nói "đã có yêu cầu rồi",
 * nếu không người vận hành tạo yêu cầu trùng và Amazon báo lỗi trùng.
 * ========================================================================== */

test("A3: khoá nối yêu cầu chặn phân biệt campaign · ad group · chữ (không phân biệt hoa thường)", () => {
  assert.equal(a3ChangeKey("C1", "AG1", "Vali 20 inch"), "C1|AG1|vali 20 inch");
  assert.equal(a3ChangeKey("C1", "AG2", "vali 20 inch"), "C1|AG2|vali 20 inch");
  assert.equal(a3ChangeKey("C2", "AG1", "vali 20 inch"), "C2|AG1|vali 20 inch");
  assert.equal(a3ChangeKey(null, null, null), "||");
  assert.equal(a3ChangeKey("C1", "AG1", "  VALI  "), a3ChangeKey("C1", "AG1", "vali"));
});

test("A3: chỉ gom yêu cầu CHẶN search term — bỏ set_bid/set_budget và entity khác", () => {
  const map = a3InFlightMap([
    change({ id: "ch1", action: "add_negative_exact", entity_type: "search_term", entity_key: "vali to", ad_group_id: "AG-1", status: "approved" }),
    change({ id: "ch2", action: "set_bid", entity_type: "keyword", entity_key: "vali to", ad_group_id: "AG-1", status: "approved" }),
    change({ id: "ch3", action: "add_negative_phrase", entity_type: "keyword", entity_key: "vali to", ad_group_id: "AG-1", status: "approved" }),
  ]);
  assert.deepEqual(Object.keys(map), ["C-1|AG-1|vali to"]);
  assert.equal(map["C-1|AG-1|vali to"].changeId, "ch1");
});

test("A3: dòng áp dụng được/đã huỷ KHÔNG tính là đang bay; dòng lỗi thì có (để cho thử lại)", () => {
  const applied = a3InFlightMap([
    change({ id: "ch1", action: "add_negative_exact", entity_type: "search_term", entity_key: "vali to", ad_group_id: "AG-1", status: "applied" }),
    change({ id: "ch2", action: "add_negative_exact", entity_type: "search_term", entity_key: "vali to", ad_group_id: "AG-1", status: "cancelled" }),
  ]);
  assert.equal(a3HasOpenChange(applied, term({ term: "vali to" })), null);
  assert.equal(applied["C-1|AG-1|vali to"].changeId, "ch2");

  const failed = a3InFlightMap([
    change({
      id: "ch3",
      action: "add_negative_exact",
      entity_type: "search_term",
      entity_key: "vali to",
      ad_group_id: "AG-1",
      status: "failed",
      error: "HTTP 400 duplicate keyword",
    }),
  ]);
  assert.equal(a3HasOpenChange(failed, term({ term: "vali to" })), null, "đã lỗi thì KHÔNG khoá nút gửi lại");
  const retry = a3FailedChange(failed, term({ term: "vali to" }));
  assert.ok(retry);
  assert.match(retry?.error ?? "", /duplicate keyword/, "phải hiện nguyên văn lỗi Amazon để biết vì sao");
});

test("A3: cùng một term có cả dòng lỗi cũ và dòng đang bay ⇒ ĐANG BAY thắng", () => {
  const map = a3InFlightMap([
    change({ id: "old", action: "add_negative_exact", entity_type: "search_term", entity_key: "vali to", ad_group_id: "AG-1", status: "failed" }),
    change({ id: "new", action: "add_negative_exact", entity_type: "search_term", entity_key: "vali to", ad_group_id: "AG-1", status: "applying" }),
  ]);
  const flying = a3HasOpenChange(map, term({ term: "vali to" }));
  assert.equal(flying?.changeId, "new");
  assert.equal(a3FailedChange(map, term({ term: "vali to" })), null);
});

test("A3: khớp theo CAMPAIGN + AD GROUP, không chỉ theo chữ (2 shop/campaign cùng term là 2 việc khác nhau)", () => {
  const map = a3InFlightMap([
    change({
      id: "ch1",
      action: "add_negative_exact",
      entity_type: "search_term",
      entity_key: "vali to",
      campaign_id: "C-9",
      ad_group_id: "AG-9",
      status: "pending_approval",
    }),
  ]);
  assert.equal(a3HasOpenChange(map, term({ campaign_id: "C-1", ad_group_id: "AG-1", term: "vali to" })), null);
  assert.equal(a3HasOpenChange(map, term({ campaign_id: "C-9", ad_group_id: "AG-9", term: "vali to" }))?.changeId, "ch1");
});

test("A3: đọc được after_text khi view chỉ trả chữ đã chặn", () => {
  const map = a3InFlightMap([
    change({
      id: "ch1",
      action: "add_negative_exact",
      entity_type: "search_term",
      entity_key: "",
      ad_group_id: "AG-1",
      after_text: "Vali To",
      status: "approved",
    }),
  ]);
  assert.equal(a3HasOpenChange(map, term({ term: "vali to" }))?.changeId, "ch1");
});
test("A3: a3ReadyToBlock loại dòng ĐANG có yêu cầu chặn — nếu không, sau khi duyệt dòng lại bị đếm là 'chưa ai làm gì'", () => {
  const rows = [
    // đủ điều kiện SOP-04, chưa ai làm gì ⇒ phải được đếm
    term({ term: "vali to", clicks_7d: 12, spend_7d: 18.4, purchases_7d: 0 }),
    // đã duyệt gợi ý, đang chờ worker ghi ⇒ KHÔNG được đếm nữa
    term({ term: "vali nho", clicks_7d: 20, spend_7d: 25, purchases_7d: 0 }),
    // lần ghi trước LỖI ⇒ vẫn phải đếm (vẫn cần người thử lại)
    term({ term: "vali dai", clicks_7d: 9, spend_7d: 11.2, purchases_7d: 0 }),
  ];
  const inFlight = a3InFlightMap([
    change({ id: "f1", action: "add_negative_exact", entity_type: "search_term", entity_key: "vali nho", ad_group_id: "AG-1", status: "approved" }),
    change({ id: "f2", action: "add_negative_exact", entity_type: "search_term", entity_key: "vali dai", ad_group_id: "AG-1", status: "failed", error: "…" }),
  ]);
  const ready = a3ReadyToBlock(rows, {}, inFlight).map((r) => r.term);
  assert.deepEqual(ready, ["vali to", "vali dai"]);
  // không truyền inFlight = hành vi cũ (để không phá chỗ gọi khác) — đúng 3 dòng
  assert.equal(a3ReadyToBlock(rows).length, 3);
});
