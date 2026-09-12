/**
 * Test model F3/F4 của web (thuần, không cần Supabase):
 *   • định dạng tiền — thiếu dữ liệu phải là "—", không được hiện 0 giả
 *   • tổng hợp claim + cảnh báo quá hạn SOP-09 (48h)
 *   • gộp lợi nhuận theo SKU — thiếu giá vốn thì lãi gộp phải NULL
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aggregateProfit,
  claimActions,
  CLAIM_SLA_HOURS,
  marginPct,
  money,
  percent,
  profitKpis,
  summarizeClaims,
  type ClaimRow,
  type SkuProfitDbRow,
} from "../src/lib/data/finance-model.ts";

function claim(partial: Partial<ClaimRow>): ClaimRow {
  return {
    id: partial.id ?? "c",
    seller_account_id: "s",
    shop: "Shop A",
    sku: partial.sku ?? "SKU-1",
    category: partial.category ?? "lost_fc",
    source: "ledger",
    source_ref: "REF-1",
    quantity: partial.quantity ?? 1,
    currency: "USD",
    unit_cost: partial.unit_cost ?? 10,
    estimated_amount: partial.estimated_amount ?? 10,
    status: partial.status ?? "suspected",
    detected_at: partial.detected_at ?? "2026-09-01T00:00:00Z",
    age_hours: partial.age_hours,
    ...partial,
  };
}

test("money: số 0 thật khác với thiếu dữ liệu; giữ dấu âm", () => {
  assert.equal(money(null), "—");
  assert.equal(money(undefined), "—");
  assert.equal(money(""), "—");
  assert.equal(money(0, "USD"), "0.00 USD");
  assert.equal(money(-12.5, "USD"), "-12.50 USD");
  assert.equal(money(1234.5), "1,234.50");
  assert.equal(money("9.9"), "9.90");
  assert.equal(money(Number.NaN), "—");
});

test("marginPct: doanh thu 0 hoặc thiếu số → null (không chia cho 0)", () => {
  assert.equal(marginPct(10, 100), 0.1);
  assert.equal(marginPct(null, 100), null);
  assert.equal(marginPct(10, null), null);
  assert.equal(marginPct(10, 0), null);
  assert.equal(percent(0.1234), "12.3%");
  assert.equal(percent(null), "—");
});

test("summarizeClaims: giá trị đang mở/đã về, đếm thiếu giá vốn, đếm quá hạn", () => {
  const now = new Date("2026-09-12T00:00:00Z");
  const rows = [
    claim({ id: "1", status: "suspected", estimated_amount: 37.5 }),
    claim({ id: "2", status: "to_claim", estimated_amount: 20, age_hours: 60 }), // quá 48h
    claim({ id: "3", status: "filed", estimated_amount: 5, age_hours: 10 }),
    claim({ id: "4", status: "paid", reimbursed_amount: 30, estimated_amount: 30 }),
    claim({ id: "5", status: "rejected", estimated_amount: 99, unit_cost: null }),
    claim({ id: "6", status: "closed", estimated_amount: 50 }),
  ];
  const summary = summarizeClaims(rows, now);
  assert.equal(summary.total, 6);
  assert.equal(summary.byStatus.suspected, 1);
  assert.equal(summary.byStatus.paid, 1);
  assert.equal(summary.openValue, 62.5); // 37.5 + 20 + 5 (bỏ paid/rejected/closed)
  assert.equal(summary.paidValue, 30);
  assert.equal(summary.missingCostCount, 1);
  assert.equal(summary.overdueCount, 1);
  assert.equal(summary.units, 6);
  assert.equal(CLAIM_SLA_HOURS, 48);
});

test("quá hạn: dùng age_hours của DB khi có, ngược lại tính từ mốc nộp/phát hiện", () => {
  const now = new Date("2026-09-12T12:00:00Z");
  // Không có age_hours → tính từ filed_at
  const filed = claim({ status: "filed", filed_at: "2026-09-10T10:00:00Z", detected_at: "2026-09-01T00:00:00Z" });
  const summary = summarizeClaims([filed], now);
  assert.equal(summary.overdueCount, 1); // 50h > 48h tính từ lúc nộp (không phải 11 ngày từ lúc phát hiện)
  // age_hours ưu tiên hơn
  assert.equal(summarizeClaims([claim({ status: "filed", age_hours: 5 })], now).overdueCount, 0);
  // trạng thái kết thúc không bao giờ bị coi là quá hạn
  assert.equal(summarizeClaims([claim({ status: "paid", age_hours: 900 })], now).overdueCount, 0);
});

test("claimActions: khớp máy trạng thái 0015 — cần mã case khi nộp, cần quyền khi duyệt", () => {
  assert.deepEqual(
    claimActions("suspected", false).map((a) => a.action),
    ["to_claim", "close"],
  );
  const file = claimActions("to_claim", false);
  assert.equal(file[0].action, "file");
  assert.equal(file[0].needs, "case");

  // Operator thường: chỉ thấy bước nộp case, không thấy duyệt
  assert.deepEqual(
    claimActions("filed", false).map((a) => a.action),
    [],
  );
  const decide = claimActions("filed", true);
  assert.deepEqual(decide.map((a) => a.action), ["approve", "reject", "close"]);
  assert.ok(decide.every((a) => a.needs === "note"));

  const paid = claimActions("approved", true);
  assert.equal(paid[0].action, "paid");
  assert.equal(paid[0].needs, "amount");
  assert.deepEqual(claimActions("rejected", true).map((a) => a.action), ["reopen"]);
  assert.deepEqual(claimActions("closed", true), []);
});

/* ---------------- F4 ---------------- */

function profitRow(partial: Partial<SkuProfitDbRow>): SkuProfitDbRow {
  return {
    seller_account_id: "s",
    shop: "Shop A",
    sku: partial.sku ?? "SKU-1",
    day: partial.day ?? "2026-09-10",
    currency: "USD",
    units: partial.units ?? 1,
    revenue: partial.revenue ?? 100,
    refunds: partial.refunds ?? 0,
    amazon_fees: partial.amazon_fees ?? -15,
    promo: partial.promo ?? 0,
    cogs: partial.cogs === undefined ? 40 : partial.cogs,
    ads_spend: partial.ads_spend ?? null,
    gross_profit: partial.gross_profit === undefined ? 45 : partial.gross_profit,
    unit_cost: partial.unit_cost ?? 40,
    fee_source: partial.fee_source ?? "settled",
    computed_at: "2026-09-11T00:00:00Z",
    ...partial,
  };
}

test("aggregateProfit: cộng nhiều ngày, doanh thu thuần gồm hoàn/khuyến mãi", () => {
  const rows = [
    profitRow({ day: "2026-09-10", units: 2, revenue: 100, refunds: -10, promo: -5, amazon_fees: -15, cogs: 40, gross_profit: 30 }),
    profitRow({ day: "2026-09-11", units: 3, revenue: 150, amazon_fees: -20, cogs: 60, gross_profit: 70 }),
  ];
  const [agg] = aggregateProfit(rows);
  assert.equal(agg.days, 2);
  assert.equal(agg.units, 5);
  assert.equal(agg.revenue, 235); // 100 − 10 − 5 + 150
  assert.equal(agg.fees, -35);
  assert.equal(agg.cogs, 100);
  assert.equal(agg.grossProfit, 100);
  assert.equal(agg.hasFullCost, true);
  assert.equal(agg.margin, 100 / 235);
});

test("aggregateProfit: một ngày thiếu giá vốn → lãi gộp SKU là null, không cộng thiếu", () => {
  const rows = [
    profitRow({ day: "2026-09-10" }),
    profitRow({ day: "2026-09-11", cogs: null, gross_profit: null, unit_cost: null, fee_source: "unavailable" }),
  ];
  const [agg] = aggregateProfit(rows);
  assert.equal(agg.hasFullCost, false);
  assert.equal(agg.cogs, null);
  assert.equal(agg.grossProfit, null);
  assert.equal(agg.margin, null);
  assert.equal(agg.feeSource, "mixed"); // vừa phí thật vừa chưa có phí
});

test("aggregateProfit: sắp SKU lỗ lên đầu, SKU thiếu giá vốn xuống cuối", () => {
  const rows = [
    profitRow({ sku: "B", gross_profit: 100, cogs: 10, unit_cost: 10 }),
    profitRow({ sku: "A", gross_profit: -20, cogs: 50, unit_cost: 50 }),
    profitRow({ sku: "C", gross_profit: null, cogs: null, unit_cost: null }),
  ];
  const order = aggregateProfit(rows).map((r) => r.sku);
  assert.deepEqual(order, ["A", "B", "C"]);
});

test("profitKpis: đếm SKU lỗ, không trộn SKU thiếu giá vốn vào tổng", () => {
  const rows = [
    profitRow({ sku: "A", revenue: 200, refunds: -20, amazon_fees: -30, cogs: 60, gross_profit: 90 }),
    profitRow({ sku: "B", revenue: 50, refunds: 0, amazon_fees: -10, cogs: 70, gross_profit: -30 }),
    profitRow({ sku: "C", revenue: 80, amazon_fees: -10, cogs: null, gross_profit: null, unit_cost: null, fee_source: "fees_api" }),
  ];
  const kpis = profitKpis(rows);
  assert.equal(kpis.revenue, 310); // 200 − 20 + 50 + 80
  assert.equal(kpis.fees, -50);
  assert.equal(kpis.cogs, 130);
  assert.equal(kpis.grossProfit, 60);
  assert.equal(kpis.lossSkus, 1);
  assert.equal(kpis.missingCostRows, 1);
  assert.equal(kpis.skuCount, 3);

  // Không SKU nào có giá vốn → tổng để null thay vì 0
  const noCost = profitKpis([profitRow({ sku: "C", cogs: null, gross_profit: null, unit_cost: null })]);
  assert.equal(noCost.grossProfit, null);
  assert.equal(noCost.cogs, null);
  assert.equal(noCost.margin, null);
  assert.equal(noCost.revenue, 100);
});
