/**
 * Test Module 8 — NGƯỠNG CHỊU ĐỰNG ADS & lưới độ nhạy CPC × CR & bảng velocity.
 *
 * Vì sao có: CPC/CR/velocity là ẩn số user KHÔNG THỂ biết ở G1. Engine phải
 * đổi hướng: tính NGƯỠNG (CPC tối đa, CR tối thiểu, PPC/đơn tối đa) và bày
 * bảng vốn theo velocity — thay vì bắt đoán một con số rồi tính như thật.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  adFeasibility,
  computeFinancial,
  cpcCrSensitivityGrid,
  maxAffordablePpcPerOrder,
  preAdProfitOf,
  DEFAULT_CONVERSION_ASSUMPTION,
} from "../src/lib/research/domain/pnl.ts";
import { velocityLadder } from "../src/lib/research/domain/roadmap.ts";
import type { AssessmentAssumptions, ScenarioPnl } from "../src/lib/research/domain/types.ts";

/** Fixture khớp nhau từng cent: price 30, chi phí không-ads 17.7, PPC 5. */
function sc(): ScenarioPnl {
  return {
    scenario: "pessimistic",
    price: 30,
    landedCost: 8,
    referralFee: 4.5,
    fbaFee: 3.5,
    fbaFeeSource: "estimated_table",
    storageFee: 0.5,
    ppcPerOrder: 5,
    returnReserve: 1.2,
    otherPerUnit: 0,
    totalCosts: 22.7,
    netProfit: 7.3,
    netMarginPct: 24.3,
    breakEvenAcosPct: 41,
  };
}

function assumptions(patch: Partial<AssessmentAssumptions> = {}): AssessmentAssumptions {
  return {
    marketplace: "US",
    currency: "USD",
    title: "Sản phẩm test",
    keywords: ["test"],
    seedAsin: null,
    categoryNode: null,
    prices: { pessimistic: 30, base: 35, optimistic: 40 },
    cogsPerUnit: 6,
    inboundFreightPerUnit: 2,
    packDims: { lengthIn: 10, widthIn: 6, heightIn: 0.5, weightLb: 0.75 },
    ...patch,
  };
}

test("preAdProfitOf: đảo ngược đúng — lời trước ads = net + PPC", () => {
  assert.equal(preAdProfitOf(sc()), 12.3); // 7.3 + 5
  assert.equal(preAdProfitOf({ ...sc(), ppcPerOrder: null, netProfit: 12.3, totalCosts: 17.7 }), 12.3);
});

test("maxAffordablePpcPerOrder: ngưỡng 0% và 20%; âm → null", () => {
  assert.equal(maxAffordablePpcPerOrder(sc(), 0), 12.3);
  assert.equal(maxAffordablePpcPerOrder(sc(), 20), 6.3); // 12.3 − 6
  // biên trước ads chỉ còn 5 (< 20% của 30 = 6) ⇒ ngưỡng 20% bất thi
  const tight = { ...sc(), netProfit: 0, ppcPerOrder: 5, totalCosts: 25 } as ScenarioPnl;
  assert.equal(maxAffordablePpcPerOrder(tight, 20), null);
  assert.equal(maxAffordablePpcPerOrder(tight, 0), 5);
  // lỗ ngay cả khi không ads ⇒ cả hai null
  const dead = { ...sc(), netProfit: -2, ppcPerOrder: 0, totalCosts: 32 } as ScenarioPnl;
  assert.equal(maxAffordablePpcPerOrder(dead, 0), null);
  assert.equal(maxAffordablePpcPerOrder(dead, 20), null);
});

test("adFeasibility: CPC tối đa theo CR user nhập; CR tối thiểu theo CPC user nhập", () => {
  const f = adFeasibility(assumptions({ cpc: 0.9, conversionRate: 0.1 }), sc());
  assert.equal(f.preAdProfitPerUnit, 12.3);
  assert.equal(f.maxPpcPerOrderBreakEven, 12.3);
  assert.equal(f.maxPpcPerOrderRedFlag, 6.3);
  assert.equal(f.crUsed.assumed, false);
  assert.equal(f.maxCpcBreakEven, 1.23); // 12.3 × 10%
  assert.equal(f.maxCpcRedFlag, 0.63); // 6.3 × 10%
  assert.equal(f.minCrBreakEvenPct, 7.3); // 0.9/12.3
  assert.equal(f.minCrRedFlagPct, 14.3); // 0.9/6.3
});

test("adFeasibility: thiếu CR → dùng benchmark 10% và GẮN CỜ assumed; thiếu CPC → KHÔNG bịa CR tối thiểu", () => {
  assert.equal(DEFAULT_CONVERSION_ASSUMPTION, 0.1);
  const f = adFeasibility(assumptions(), sc()); // không cpc, không conversionRate
  assert.equal(f.crUsed.assumed, true);
  assert.equal(f.crUsed.value, 0.1);
  assert.equal(f.maxCpcRedFlag, 0.63); // vẫn quy đổi được nhờ benchmark
  assert.equal(f.cpcUsed, null);
  assert.equal(f.minCrBreakEvenPct, null);
  assert.equal(f.minCrRedFlagPct, null);
});

test("cpcCrSensitivityGrid: ô tính đúng công thức, cờ passRedFlag theo ngưỡng 20%", () => {
  const g = cpcCrSensitivityGrid(sc());
  assert.equal(g.cpcValues.length, 5);
  assert.equal(g.crPctValues.length, 5);
  // Ô CPC $1.00 × CR 10%: PPC = 10 → net = 30 − 17.7 − 10 = 2.3 → biên 7.7%
  const cell = g.cells[g.cpcValues.indexOf(1.0)][g.crPctValues.indexOf(10)];
  assert.equal(cell.ppcPerOrder, 10);
  assert.equal(cell.netProfit, 2.3);
  assert.equal(cell.netMarginPct, 7.7);
  assert.equal(cell.passRedFlag, false);
  // Ô CPC $0.50 × CR 15%: PPC = 3.33 → net = 8.97 → biên 29.9% ≥ 20%
  const ok = g.cells[g.cpcValues.indexOf(0.5)][g.crPctValues.indexOf(15)];
  assert.equal(ok.ppcPerOrder, 3.33);
  assert.equal(ok.netProfit, 8.97);
  assert.equal(ok.passRedFlag, true);
  // CPC=0 giả định hợp lệ về mặt công thức: biên = biên trước ads
  const g0 = cpcCrSensitivityGrid(sc(), [0], [10]);
  assert.equal(g0.cells[0][0].netMarginPct, 41);
});

/* ------------------- bảng velocity (ẩn số → chọn mức rủi ro) ------------------- */

function healthy(): AssessmentAssumptions {
  return assumptions({
    prices: { pessimistic: 34.99, base: 39.99, optimistic: 44.99 },
    cogsPerUnit: 6,
    inboundFreightPerUnit: 1.5,
    cpc: 0.8,
    conversionRate: 0.1,
    referralRate: 0.15,
    returnRate: 0.04,
  });
}

test("velocityLadder: khớp công thức roadmap — vốn, ads đề xuất, lỗ tối đa", () => {
  const a = healthy();
  const f = computeFinancial(a);
  const rows = velocityLadder(a, f, [2, 5]);
  assert.equal(rows.length, 2);
  const r2 = rows[0];
  assert.equal(r2.unitsPerDay, 2);
  assert.equal(r2.testOrderQty, 90); // 2 × 45 ngày phủ mặc định
  assert.equal(r2.lotCapital, 675); // 90 × landed 7.5
  assert.equal(r2.adsBudgetPerDay, 16); // 2 × PPC/đơn cơ sở (0.8/0.1 = 8)
  assert.equal(r2.adsTestSpend, 720); // 16 × 45 ngày
  // Sản phẩm khỏe: biên bi quan dương ⇒ lỗ tối đa ≈ đúng tổng ads test
  assert.equal(r2.maxLoss, 720);
  assert.equal(rows[1].testOrderQty, 225);
  assert.equal(rows[1].lotCapital, 1687.5);
});

test("velocityLadder: user nhập ngân sách ads thì giữ của user; thiếu CPC/CR ⇒ ads null", () => {
  const a = healthy();
  a.adsBudgetPerDay = 5;
  const f = computeFinancial(a);
  const rows = velocityLadder(a, f, [1]);
  assert.equal(rows[0].adsBudgetPerDay, 5);
  assert.equal(rows[0].adsTestSpend, 225);

  const b = healthy();
  b.cpc = null;
  b.conversionRate = null;
  const rows2 = velocityLadder(b, computeFinancial(b), [1]);
  assert.equal(rows2[0].adsBudgetPerDay, null);
  assert.equal(rows2[0].adsTestSpend, null);
});

test("velocityLadder: lọc velocity ≤ 0 / không phải số", () => {
  const a = healthy();
  const rows = velocityLadder(a, computeFinancial(a), [0, -3, NaN, 4]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].unitsPerDay, 4);
});
