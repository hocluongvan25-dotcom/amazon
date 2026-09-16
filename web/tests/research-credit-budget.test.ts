/**
 * Module 8 G7 — test ngân sách credits Rainforest.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SOFT_BUDGET,
  RAINFOREST_PLANS,
  decideCreditBudget,
  estimateCollectCredits,
} from "../src/lib/research/domain/credit-budget.ts";

test("budget: chưa dùng gì → ok, còn đủ 10.000 credits gói starter", () => {
  const d = decideCreditBudget({ spentMonth: 0 });
  assert.equal(d.level, "ok");
  assert.equal(d.remaining, RAINFOREST_PLANS.starter.monthlyIncluded);
  assert.equal(d.projectedOverageUsd, 0);
});

test("budget: vượt ngân sách nội bộ 2.000 → cảnh báo kèm số tiền overage (chưa vượt gói)", () => {
  const d = decideCreditBudget({ spentMonth: 1_900, estimatedNextCost: 300 });
  assert.equal(d.level, "warn");
  assert.equal(d.projected, 2_200);
  assert.equal(d.projectedOverageCredits, 0, "dưới 10.000 thì chưa overage");
  assert.ok(d.reasons.join(" ").includes("2.000"));
});

test("budget: vượt trần gói → block và quy đổi tiền overage $0.0118/credit", () => {
  const d = decideCreditBudget({ spentMonth: 9_950, estimatedNextCost: 200 });
  assert.equal(d.level, "block");
  assert.equal(d.projected, 10_150);
  assert.equal(d.projectedOverageCredits, 150);
  assert.ok(Math.abs(d.projectedOverageUsd - 150 * 0.0118) < 1e-9);
  assert.equal(d.remaining, 50);
});

test("budget: hardCap tùy chỉnh chặn trước cả ngưỡng gói", () => {
  const d = decideCreditBudget({ spentMonth: 4_900, estimatedNextCost: 200, hardCap: 5_000 });
  assert.equal(d.level, "block");
  assert.equal(d.remaining, 100);
});

test("ước lượng credits 1 hồ sơ mẫu: 1 search + 3 request/ASIN + reviews top10×2 trang", () => {
  // 30 organic, lấy reviews 10 ASIN, 2 trang/ASIN, có sales estimate
  const credits = estimateCollectCredits({ organicAsins: 30, reviewAsins: 10, reviewPagesPerAsin: 2 });
  // 1 + 30*(product+offers+sales=3) + 10*2 = 111
  assert.equal(credits, 111);
});

test("ước lượng credits: không sales estimate thì bớt 1 credit/ASIN", () => {
  const credits = estimateCollectCredits({ organicAsins: 10, withSalesEstimate: false, reviewAsins: 0 });
  assert.equal(credits, 1 + 10 * 2);
});

test("mặc định soft budget = 2.000 đúng env mẫu", () => {
  assert.equal(DEFAULT_SOFT_BUDGET, 2_000);
});
