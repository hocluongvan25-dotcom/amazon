/**
 * Module 8 G5 — test builder ngữ cảnh narrative:
 *  - số null/NaN hiển thị "chưa đủ cơ sở", không bịa
 *  - quote lấy theo priority must→should, giới hạn 12
 *  - contextText phản ánh veto + model + kill-criteria
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNarrativeContext } from "../src/lib/research/domain/narrative-context.ts";
import type { PainItem, PainQuote } from "../src/lib/research/domain/pain.ts";

// Hồ sơ tối thiểu chỉ chứa các trường builder đụng tới.
function fakeResult(overrides: Record<string, unknown> = {}) {
  return {
    engineVersion: "engine-test-1",
    assumptions: { prices: { base: 39.99, pessimistic: 34.99, optimistic: 44.99 } },
    financial: {
      scenarios: {
        base: { netMarginPct: 33.8, ppcPerOrder: 8 },
        pessimistic: { netMarginPct: 27.0, ppcPerOrder: 12 },
        optimistic: { netMarginPct: 39.0, ppcPerOrder: 6 },
      },
      currentPackaging: { fbaFee: 3.36, tierLabel: "Small Standard", billableWeightLb: 0.75 },
      warnings: [],
    },
    scorecard: {
      overallScore: null,
      verdict: "insufficient_data",
      verdictLabel: "CHƯA ĐỦ CƠ SỞ",
      pillars: [
        { pillar: "finance", label: "Tài chính", score: 9, confidence: "high", reason: "biên tốt", weight: 0.25 },
        { pillar: "competition", label: "Cạnh tranh", score: 2, confidence: "medium", reason: "CR3 cao", weight: 0.25 },
      ],
      vetoes: [{ code: "cr3_above_65", severity: "red", title: "CR3 > 65%", detail: "CR3 73.5%", evidence: {} }],
    },
    roadmap: {
      testOrderQty: 135,
      lotCapital: 1013,
      adsBudgetPerDay: 24,
      adsTestSpend: 1080,
      breakEvenAcosPct: 53.8,
      maxLossAmount: 1080,
      killCriteria: ["ACOS > 45% sau 30 ngày"],
    },
    ...overrides,
  } as never;
}

function quote(reviewId: string): PainQuote {
  return {
    reviewId,
    asin: "B0G5001",
    quote: `quote ${reviewId}`,
    stars: 1,
    reviewDate: "2026-08-01",
    url: null,
    verified: true,
    helpfulCount: 0,
    photosCount: 0,
  };
}
function item(id: string, priority: "must" | "should" | "skip", freq: number): PainItem {
  return {
    itemKey: id,
    cluster: "durability",
    title: id,
    subLabel: null,
    reviewIds: [`${id}-Q1`, `${id}-Q2`],
    effortHint: 1,
    factoryRequirement: null,
    listingFix: null,
    testMethod: null,
    acceptanceStandard: null,
    costImpactEstimate: null,
    priority,
    frequency: freq,
    frequencyPct: 10,
    avgStars: 1.5,
    severity: 8,
    impactScore: 8,
    effortScore: 3,
    quotes: [quote(`${id}-Q1`), quote(`${id}-Q2`)],
  } as unknown as PainItem;
}

const baseInput = {
  result: fakeResult(),
  competitors: [
    { position: 1, isSponsored: false, asin: "B0G5001", currency: "USD", isAmazon1p: false, price: 30, rating: 4.2, ratingsTotal: 100, estUnitsMonth: 1000, dataSource: "rainforest" as const },
    { position: 2, isSponsored: false, asin: "B0G5002", currency: "USD", isAmazon1p: false, price: 32, rating: 4.0, ratingsTotal: 80, estUnitsMonth: 2000, dataSource: "rainforest" as const },
  ],
  pain: null as never,
  differentiation: null,
  demand: null,
  velocity: null,
  reviewCount: 16,
  llm: { providerName: "mock", model: "mock-llm-1" },
  collectedAt: "2026-09-16",
};

test("narrative context: định dạng số, null → 'chưa đủ cơ sở', không bịa", () => {
  const ctx = buildNarrativeContext(baseInput);
  const m = Object.fromEntries(ctx.metrics.map((x) => [x.key, x.value]));
  assert.equal(m.base_margin_pct, "33.8%");
  assert.equal(m.pess_margin_pct, "27.0%");
  assert.equal(m.base_price, "$39.99");
  assert.equal(m.fba_fee_base, "$3.36");
  assert.equal(m.overall_score, "chưa đủ cơ sở");
  assert.equal(m.median_units_month, "1,500");
  assert.equal(m.review_velocity_month, "chưa đủ cơ sở");
  assert.equal(m.pain_item_count, "chưa đủ cơ sở");
  assert.equal(ctx.quotes.length, 0);
  assert.match(ctx.contextText, /CR3 > 65%/);
});

test("narrative context: quote ưu tiên must→should và giới hạn 12 câu", () => {
  const items = [
    item("skip1", "skip", 1),
    item("should1", "should", 4),
    item("must1", "must", 9),
    item("must2", "must", 8),
    item("must3", "must", 7),
    item("must4", "must", 6),
    item("must5", "must", 5),
    item("must6", "must", 4),
    item("must7", "must", 3),
  ];
  const ctx = buildNarrativeContext({
    ...baseInput,
    pain: {
      model: "mock-llm-1",
      sampleSize: 16,
      asinCount: 5,
      executiveNarrative: null,
      items,
    },
  });
  assert.ok(ctx.quotes.length <= 12, "tối đa 12 quote");
  assert.equal(ctx.quotes.length, 12);
  // hai câu đầu phải thuộc pain "must" có tần suất cao nhất
  assert.equal(ctx.quotes[0].reviewId, "must1-Q1");
  assert.equal(ctx.quotes[1].reviewId, "must1-Q2");
  // pain skip đứng cuối hàng đợi → không lọt khi đủ 12 slot
  assert.ok(!ctx.quotes.some((q) => q.reviewId.startsWith("skip")));
  const m = Object.fromEntries(ctx.metrics.map((x) => [x.key, x.value]));
  assert.equal(m.pain_item_count, "9");
});
