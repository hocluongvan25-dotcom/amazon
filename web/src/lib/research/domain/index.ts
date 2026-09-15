/**
 * Module 8 — engine thẩm định R&D (lớp thuần).
 *
 * Một đầu vào duy nhất AssessmentAssumptions → AssessmentResult gồm tài chính,
 * scorecard và lộ trình validate. Không I/O, dùng được cả ở server component,
 * server action lẫn worker job.
 */

import { computeFinancial } from "./pnl.ts";
import { computeRoadmap } from "./roadmap.ts";
import { computeScorecard } from "./scorecard.ts";
import { FEE_TABLE_VERSION } from "./size-tier.ts";
import type { AssessmentAssumptions, AssessmentResult } from "./types.ts";

export const RESEARCH_ENGINE_VERSION = `research-engine-0.1.0+${FEE_TABLE_VERSION}`;

/** Validate sơ bộ giả định đầu vào — trả danh sách lỗi (rỗng = hợp lệ). */
export function validateAssumptions(a: AssessmentAssumptions): string[] {
  const errors: string[] = [];
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (!a.title?.trim()) errors.push("Thiếu tên ngách/sản phẩm");
  if (!a.keywords?.length) errors.push("Cần ít nhất 1 từ khóa ngách");
  if (!num(a.cogsPerUnit) || a.cogsPerUnit < 0) errors.push("Giá vốn/đơn vị phải là số ≥ 0");
  if (!num(a.inboundFreightPerUnit) || a.inboundFreightPerUnit < 0)
    errors.push("Cước vận chuyển về FBA/đơn vị phải là số ≥ 0");
  for (const k of ["pessimistic", "base", "optimistic"] as const) {
    if (!num(a.prices?.[k]) || a.prices[k] <= 0)
      errors.push(`Giá kịch bản ${k} phải lớn hơn 0`);
  }
  const d = a.packDims;
  if (!d || [d.lengthIn, d.widthIn, d.heightIn, d.weightLb].some((v) => !num(v) || v <= 0)) {
    errors.push("Kích thước/khối lượng đóng gói phải là số dương (inch, lb)");
  }
  if (
    a.referralRate !== undefined &&
    (a.referralRate <= 0 || a.referralRate >= 1)
  ) {
    errors.push("Tỷ lệ referral phải nằm trong khoảng (0, 1) — ví dụ 0.15");
  }
  if (
    a.conversionRate !== undefined &&
    a.conversionRate !== null &&
    (a.conversionRate <= 0 || a.conversionRate > 1)
  ) {
    errors.push("Tỉ lệ chuyển đổi phải nằm trong khoảng (0, 1] — ví dụ 0.12");
  }
  return errors;
}

/** Tính toàn bộ hồ sơ thẩm định G1 từ giả định đầu vào. */
export function computeAssessment(
  assumptions: AssessmentAssumptions,
  now: Date = new Date(),
): AssessmentResult {
  const financial = computeFinancial(assumptions);
  const scorecard = computeScorecard(assumptions, financial);
  const roadmap = computeRoadmap(assumptions, financial);
  return {
    assumptions,
    financial,
    scorecard,
    roadmap,
    computedAt: now.toISOString(),
    engineVersion: RESEARCH_ENGINE_VERSION,
  };
}

export * from "./types.ts";
export * from "./size-tier.ts";
export * from "./pnl.ts";
export * from "./scorecard.ts";
export * from "./roadmap.ts";
export * from "./collection.ts";
