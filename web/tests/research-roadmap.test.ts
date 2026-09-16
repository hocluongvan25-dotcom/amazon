/**
 * Test Module 8 — Validation Roadmap: quy mô lô test theo velocity BI QUAN,
 * vốn lô, ngân sách ads, mức lỗ tối đa và các ca thiếu dữ liệu.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { computeFinancial } from "../src/lib/research/domain/pnl.ts";
import {
  computeRoadmap,
  suggestAdsBudgetPerDay,
} from "../src/lib/research/domain/roadmap.ts";
import type { AssessmentAssumptions } from "../src/lib/research/domain/types.ts";

function healthy(over: Partial<AssessmentAssumptions> = {}): AssessmentAssumptions {
  return {
    marketplace: "US",
    currency: "USD",
    title: "Giá đỡ inox nhà bếp",
    keywords: ["kitchen organizer"],
    prices: { pessimistic: 34.99, base: 39.99, optimistic: 44.99 },
    cogsPerUnit: 6,
    inboundFreightPerUnit: 1.5,
    packDims: { lengthIn: 10, widthIn: 6, heightIn: 0.5, weightLb: 0.75 },
    referralRate: 0.15,
    cpc: 0.8,
    conversionRate: 0.1,
    pessimisticUnitsPerDay: 3,
    ...over,
  };
}

test("lô test = velocity bi quan × số ngày phủ (mặc định 45)", () => {
  const a = healthy();
  const r = computeRoadmap(a, computeFinancial(a));
  assert.equal(r.testOrderQty, 135); // ceil(3×45)
  assert.equal(r.coverDays, 45);
  // Vốn hàng = 135 × landed cost 7.5
  assert.equal(r.lotCapital, 1012.5);
});

test("đổi số ngày phủ xuống 30 → quy mô lô tính lại", () => {
  const a = healthy({ testCoverDays: 30 });
  const r = computeRoadmap(a, computeFinancial(a));
  assert.equal(r.testOrderQty, 90);
});

test("ngân sách ads/ngày gợi ý = velocity × PPC/đơn; tổng chi 45 ngày", () => {
  const a = healthy();
  const f = computeFinancial(a);
  // PPC/đơn = 0.8/0.1 = 8; velocity 3 → 24/ngày
  assert.equal(suggestAdsBudgetPerDay(a, f.scenarios.base.ppcPerOrder), 24);
  const r = computeRoadmap(a, f);
  assert.equal(r.adsBudgetPerDay, 24);
  assert.equal(r.adsTestSpend, 1080); // 24 × 45
  assert.equal(r.adsTestDays, 45);
});

test("ACOS hòa vốn lấy từ biên trước PPC của kịch bản cơ sở", () => {
  const a = healthy();
  const r = computeRoadmap(a, computeFinancial(a));
  assert.equal(r.breakEvenAcosPct, 53.8);
});

test("kịch bản bi quan vẫn có lời → mức lỗ tối đa xấp xỉ bằng chi ads test", () => {
  const a = healthy();
  const r = computeRoadmap(a, computeFinancial(a));
  assert.equal(r.maxLossAmount, 1080);
  assert.ok(r.notes.some((n) => n.includes("dương")));
});

test("kịch bản bi quan lỗ vốn → mức lỗ tối đa gồm lỗ/đơn × lô + ads", () => {
  const a = healthy({
    prices: { pessimistic: 19.99, base: 29.99, optimistic: 34.99 },
    pessimisticUnitsPerDay: 2,
  });
  const r = computeRoadmap(a, computeFinancial(a));
  // qty = 90; pess: giá 19.99 − tổng chi 22.68 = −2.69/đơn; ads/ngày 16 → 720
  // maxLoss = 2.69×90 + 720 = 242.1 + 720 = 962.1
  assert.equal(r.testOrderQty, 90);
  assert.equal(r.maxLossAmount, 962.1);
});

test("thiếu velocity → mọi đại lượng lô test là null và có ghi chú, KHÔNG bịa số", () => {
  const a = healthy({ pessimisticUnitsPerDay: null });
  const r = computeRoadmap(a, computeFinancial(a));
  assert.equal(r.testOrderQty, null);
  assert.equal(r.lotCapital, null);
  assert.equal(r.adsBudgetPerDay, null);
  assert.equal(r.adsTestSpend, null);
  assert.equal(r.maxLossAmount, null);
  assert.ok(r.notes.some((n) => n.includes("Chưa có đơn/ngày")));
});

test("thiếu CPC/CR → không gợi ý ads/ngày dù có velocity", () => {
  const a = healthy({ cpc: null });
  const r = computeRoadmap(a, computeFinancial(a));
  assert.equal(r.adsBudgetPerDay, null);
  assert.equal(r.adsTestSpend, null);
  assert.ok(r.notes.some((n) => n.includes("CPC")));
});

test("ngân sách ads nhập tay được tôn trọng thay cho gợi ý", () => {
  const a = healthy({ adsBudgetPerDay: 10 });
  const r = computeRoadmap(a, computeFinancial(a));
  assert.equal(r.adsBudgetPerDay, 10);
  assert.equal(r.adsTestSpend, 450);
});

test("có sẵn lịch gate 8 tuần và kill criteria rating < 4 sau 50 đơn", () => {
  const r = computeRoadmap(healthy(), computeFinancial(healthy()));
  assert.ok(r.gates.length >= 4);
  assert.ok(r.killCriteria.some((k) => k.includes("Rating < 4")));
});

/* ---- velocityLadderRange: khoảng min–max khi CHƯA chốt velocity (sự cố 16/09/2026) ---- */
import { velocityLadder, velocityLadderRange } from "../src/lib/research/domain/roadmap.ts";

test("velocityLadderRange: chưa chốt velocity vẫn ra khoảng lô test/vốn/ads/lỗ từ lưới", () => {
  const a = healthy({ pessimisticUnitsPerDay: undefined });
  const f = computeFinancial(a);
  const lr = velocityLadderRange(velocityLadder(a, f));
  // Lưới mặc định 1..10 đơn/ngày × 45 ngày phủ
  assert.deepEqual(lr.testOrderQty, [45, 450]);
  // Vốn = qty × landed 7.5
  assert.deepEqual(lr.lotCapital, [337.5, 3375]);
  // Ads đề xuất = velocity × PPC/đơn (8$) → 8..80/ngày; tổng 45 ngày
  assert.deepEqual(lr.adsBudgetPerDay, [8, 80]);
  assert.deepEqual(lr.adsTestSpend, [360, 3600]);
  assert.ok(lr.maxLoss !== null);
  assert.ok(lr.maxLoss[1] > lr.maxLoss[0]); // mức cao lỗ nhiều hơn
});

test("velocityLadderRange: thiếu CPC/CR → cột ads null nhưng lô test/vốn/lỗ vẫn có khoảng", () => {
  const a = healthy({ pessimisticUnitsPerDay: undefined, cpc: undefined, conversionRate: undefined });
  const f = computeFinancial(a);
  const lr = velocityLadderRange(velocityLadder(a, f));
  assert.equal(lr.adsBudgetPerDay, null);
  assert.equal(lr.adsTestSpend, null);
  assert.deepEqual(lr.testOrderQty, [45, 450]);
  assert.deepEqual(lr.lotCapital, [337.5, 3375]);
  assert.ok(lr.maxLoss !== null); // lỗ hàng vẫn tính được (chỉ thiếu phần ads)
});

test("velocityLadderRange: lưới rỗng → mọi khoảng null (không vỡ UI)", () => {
  const lr = velocityLadderRange([]);
  assert.equal(lr.testOrderQty, null);
  assert.equal(lr.lotCapital, null);
  assert.equal(lr.adsBudgetPerDay, null);
  assert.equal(lr.adsTestSpend, null);
  assert.equal(lr.maxLoss, null);
});
