/**
 * Test Module 8 — Scorecard 5 trụ: trọng số, bảng điểm tài chính, veto cứng,
 * và luật "thiếu dữ liệu → chưa đủ cơ sở, KHÔNG tự bịa điểm".
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { computeFinancial } from "../src/lib/research/domain/pnl.ts";
import {
  computeScorecard,
  financeScore,
  logisticsScore,
  PILLAR_WEIGHTS,
} from "../src/lib/research/domain/scorecard.ts";
import type { AssessmentAssumptions } from "../src/lib/research/domain/types.ts";

function healthy(): AssessmentAssumptions {
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
  };
}

test("trọng số 5 trụ cộng đúng 100%", () => {
  const sum = Object.values(PILLAR_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(Math.round(sum * 100), 100);
});

test("bảng điểm tài chính theo biên %", () => {
  assert.equal(financeScore(40), 10);
  assert.equal(financeScore(32), 9);
  assert.equal(financeScore(27), 7);
  assert.equal(financeScore(22), 5);
  assert.equal(financeScore(17), 3);
  assert.equal(financeScore(8), 1);
});

test("G1: chỉ trụ tài chính + logistics có điểm; 3 trụ còn lại là 'chưa đủ cơ sở'", () => {
  const a = healthy();
  const s = computeScorecard(a, computeFinancial(a));
  const byKey = new Map(s.pillars.map((p) => [p.pillar, p]));
  assert.equal(byKey.get("finance")?.score !== null, true);
  assert.equal(byKey.get("logistics")?.score !== null, true);
  assert.equal(byKey.get("competition")?.score, null);
  assert.equal(byKey.get("demand")?.score, null);
  assert.equal(byKey.get("differentiation")?.score, null);
  // Chưa đủ 5 trụ → KHÔNG có điểm tổng, verdict chưa đủ cơ sở
  assert.equal(s.overallScore, null);
  assert.equal(s.verdict, "insufficient_data");
  assert.match(s.verdictLabel, /CHƯA ĐỦ CƠ SỞ/);
});

test("sản phẩm khỏe + đủ dữ liệu PPC: trụ tài chính 9, không veto", () => {
  const a = healthy();
  const s = computeScorecard(a, computeFinancial(a));
  const fin = s.pillars.find((p) => p.pillar === "finance");
  assert.equal(fin?.score, 9); // biên cơ sở 33.8%
  assert.deepEqual(s.vetoes, []);
});

test("biên bi quan < 20% → veto đỏ margin_below_20 dù điểm trụ cơ sở có thể cao", () => {
  const a = healthy();
  a.prices = { pessimistic: 24.99, base: 29.99, optimistic: 34.99 };
  const s = computeScorecard(a, computeFinancial(a));
  const veto = s.vetoes.find((v) => v.code === "margin_below_20");
  assert.ok(veto);
  assert.equal(veto?.severity, "red");
});

test("logistics: small standard điểm 10, trừ điểm theo bậc bulky", () => {
  const a = healthy();
  assert.equal(logisticsScore(a).score, 10);
  a.packDims = { lengthIn: 20, widthIn: 15, heightIn: 10, weightLb: 5 };
  assert.equal(logisticsScore(a).score, 7); // small bulky −3
  a.packDims = { lengthIn: 40, widthIn: 20, heightIn: 10, weightLb: 10 };
  assert.equal(logisticsScore(a).score, 4); // large bulky −6
  a.packDims = { lengthIn: 70, widthIn: 30, heightIn: 20, weightLb: 80 };
  assert.equal(logisticsScore(a).score, 1); // extra-large
});

test("hàng dễ vỡ/cần chứng nhận trừ thêm điểm logistics", () => {
  const a = healthy();
  a.fragile = true;
  a.certificationRequired = true;
  assert.equal(logisticsScore(a).score, 8);
});

test("rào cản chứng nhận/bằng sáng chế → veto đỏ cert_barrier", () => {
  const a = healthy();
  a.patentRisk = true;
  const s = computeScorecard(a, computeFinancial(a));
  assert.ok(s.vetoes.some((v) => v.code === "cert_barrier" && v.severity === "red"));
});

test("oversize sinh veto mức warning kèm bằng chứng tier", () => {
  const a = healthy();
  a.packDims = { lengthIn: 20, widthIn: 15, heightIn: 10, weightLb: 5 };
  const s = computeScorecard(a, computeFinancial(a));
  const v = s.vetoes.find((x) => x.code === "oversize");
  assert.ok(v);
  assert.equal(v?.severity, "warning");
  assert.equal((v?.evidence as { tier: string }).tier, "small_bulky");
});
