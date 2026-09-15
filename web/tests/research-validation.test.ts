/**
 * Test Module 8 — validateAssumptions (chốt chặn dữ liệu đầu vào trước khi lưu).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { computeAssessment, validateAssumptions } from "../src/lib/research/domain/index.ts";
import type { AssessmentAssumptions } from "../src/lib/research/domain/types.ts";

function base(): AssessmentAssumptions {
  return {
    marketplace: "US",
    currency: "USD",
    title: "Ngách thử nghiệm",
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

test("bộ giả định mẫu hợp lệ — không lỗi", () => {
  assert.deepEqual(validateAssumptions(base()), []);
});

test("thiếu tên/từ khóa/giá/chi phí đều bị bắt", () => {
  const a = base();
  a.title = "  ";
  a.keywords = [];
  a.prices.base = 0;
  a.cogsPerUnit = -1;
  const errs = validateAssumptions(a);
  assert.ok(errs.some((e) => e.includes("tên")));
  assert.ok(errs.some((e) => e.includes("từ khóa")));
  assert.ok(errs.some((e) => e.includes("kịch bản")));
  assert.ok(errs.some((e) => e.includes("Giá vốn")));
});

test("kích thước đóng gói phải dương", () => {
  const a = base();
  a.packDims = { lengthIn: 0, widthIn: 6, heightIn: 0.5, weightLb: 0.75 };
  assert.ok(validateAssumptions(a).some((e) => e.includes("Kích thước")));
});

test("referral/CR ngoài khoảng (0,1) bị từ chối", () => {
  const a1 = base();
  a1.referralRate = 1.5;
  assert.ok(validateAssumptions(a1).some((e) => e.includes("referral")));
  const a2 = base();
  a2.conversionRate = 0;
  assert.ok(validateAssumptions(a2).some((e) => e.includes("chuyển đổi")));
});

test("computeAssessment trả đủ 3 phần và gắn phiên bản engine", () => {
  const r = computeAssessment(base(), new Date("2026-09-15T00:00:00Z"));
  assert.ok(r.financial.scenarios.base.netMarginPct > 0);
  assert.equal(r.scorecard.pillars.length, 5);
  assert.equal(r.roadmap.coverDays, 45);
  assert.match(r.engineVersion, /research-engine/);
  assert.equal(r.computedAt, "2026-09-15T00:00:00.000Z");
});
