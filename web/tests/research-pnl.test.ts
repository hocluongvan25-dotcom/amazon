/**
 * Test Module 8 — Unit Economics: P&L 3 kịch bản, break-even ACOS, storage,
 * cảnh báo đỏ margin < 20%, tối ưu bao bì, mô phỏng quy mô tháng.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeFinancial,
  landedCost,
  MARGIN_RED_FLAG,
  resolveFbaFee,
  simulateMonth,
} from "../src/lib/research/domain/pnl.ts";
import type { AssessmentAssumptions } from "../src/lib/research/domain/types.ts";

/** Sản phẩm mẫu khỏe: small standard ~0.75 lb, giá $39.99, CPC $0.80 / CR 10%. */
function healthy(): AssessmentAssumptions {
  return {
    marketplace: "US",
    currency: "USD",
    title: "Giá đỡ inox nhà bếp",
    keywords: ["kitchen organizer"],
    seedAsin: null,
    categoryNode: null,
    prices: { pessimistic: 34.99, base: 39.99, optimistic: 44.99 },
    cogsPerUnit: 6,
    inboundFreightPerUnit: 1.5,
    packDims: { lengthIn: 10, widthIn: 6, heightIn: 0.5, weightLb: 0.75 },
    referralRate: 0.15,
    fbaFeeOverride: null,
    cpc: 0.8,
    conversionRate: 0.1,
    returnRate: 0.04,
    otherPerUnit: 0,
  };
}

test("landed cost = giá vốn + cước về FBA", () => {
  assert.equal(landedCost(healthy()), 7.5);
});

test("ưu tiên phí SP-API khi có override; không có thì ước lượng theo bảng", () => {
  const a = healthy();
  const est = resolveFbaFee(a);
  assert.equal(est.source, "estimated_table");
  assert.ok(est.fee > 0);
  a.fbaFeeOverride = 4.1;
  const exact = resolveFbaFee(a);
  assert.equal(exact.source, "spapi");
  assert.equal(exact.fee, 4.1);
});

test("P&L kịch bản cơ sở: từng cent khớp công thức, đã trừ PPC", () => {
  const f = computeFinancial(healthy());
  const b = f.scenarios.base;
  assert.equal(b.price, 39.99);
  assert.equal(b.landedCost, 7.5);
  assert.equal(b.referralFee, 6); // 39.99 × 15%
  assert.equal(b.fbaFee, 3.36); // small standard ≤16 oz (bảng 2026)
  assert.equal(b.ppcPerOrder, 8); // 0.8 / 0.1
  assert.equal(b.returnReserve, 1.6); // 39.99 × 4%
  assert.equal(b.netProfit, 13.51);
  assert.equal(b.netMarginPct, 33.8);
  // Break-even ACOS = biên TRƯỚC PPC
  assert.equal(b.breakEvenAcosPct, 53.8);
});

test("kịch bản bi quan của sản phẩm khỏe vẫn ≥20% → không cờ đỏ", () => {
  const f = computeFinancial(healthy());
  assert.ok(f.scenarios.pessimistic.netMarginPct >= MARGIN_RED_FLAG * 100);
  assert.equal(
    f.warnings.some((w) => w.includes("CẢNH BÁO ĐỎ")),
    false,
  );
});

test("thiếu CPC/CR → PPC/đơn null (KHÔNG bịa 0) và có cảnh báo", () => {
  const a = healthy();
  a.cpc = null;
  const f = computeFinancial(a);
  assert.equal(f.scenarios.base.ppcPerOrder, null);
  assert.ok(f.warnings.some((w) => w.includes("PPC/đơn để trống")));
  // Biên lúc này là biên TRƯỚC quảng cáo
  const pre = computeFinancial(healthy()).scenarios.base;
  assert.ok(f.scenarios.base.netProfit > pre.netProfit + 7.9);
});

test("giá thấp khiến biên bi quan < 20% → cảnh báo đỏ", () => {
  const a = healthy();
  a.prices = { pessimistic: 24.99, base: 29.99, optimistic: 34.99 };
  const f = computeFinancial(a);
  assert.ok(f.scenarios.pessimistic.netMarginPct < 20);
  assert.ok(f.warnings.some((w) => w.includes("CẢNH BÁO ĐỎ")));
});

test("mô phỏng tháng: doanh thu/lãi/ads tại mốc 500 đơn (kịch bản cơ sở)", () => {
  const f = computeFinancial(healthy());
  const m = simulateMonth(healthy(), f.scenarios.base, 500);
  assert.equal(m.unitsPerMonth, 500);
  assert.equal(m.revenue, 19995);
  assert.equal(m.netProfit, 6755);
  assert.equal(m.adSpend, 4000);
});

test("mô phỏng tháng thiếu PPC → adSpend null", () => {
  const a = healthy();
  a.cpc = null;
  const f = computeFinancial(a);
  assert.equal(simulateMonth(a, f.scenarios.base, 300).adSpend, null);
});

test("hàng oversize sinh cảnh báo + phương án nén khổ standard", () => {
  const a = healthy();
  a.packDims = { lengthIn: 20, widthIn: 15, heightIn: 10, weightLb: 5 };
  const f = computeFinancial(a);
  assert.equal(f.currentPackaging.tier, "small_bulky");
  assert.ok(f.warnings.some((w) => w.includes("nhóm")));
  // Có ít nhất 1 phương án đổi tier tiết kiệm được
  const alts = f.packagingSuggestions.slice(1);
  assert.ok(alts.length >= 1);
  for (const opt of alts) {
    assert.notEqual(opt.tier, "small_bulky");
    assert.ok((opt.savingPerUnit ?? 0) > 0);
  }
});

test("storage: dùng số nhập tay nếu có, không thì ước lượng từ khối lượng", () => {
  const f1 = computeFinancial(healthy());
  assert.equal(f1.storage.lowPerMonth, 0.02); // 30 in³ → 0.02 ft³ × 0.78
  const a = healthy();
  a.storagePerUnitMonthLow = 0.15;
  a.storagePerUnitMonthPeak = 0.5;
  const f2 = computeFinancial(a);
  assert.equal(f2.storage.lowPerMonth, 0.15);
  assert.equal(f2.storage.peakPerMonth, 0.5);
  assert.equal(f2.storage.source, "manual");
});

test("feeTableVersion gắn nhãn rõ nguồn bảng phí", () => {
  assert.match(computeFinancial(healthy()).feeTableVersion, /FBA-US-2026/);
});
