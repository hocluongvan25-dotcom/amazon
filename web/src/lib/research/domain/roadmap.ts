
/**
 * Module 8 — Tab 4: Validation Roadmap (G1).
 *
 * G1: các con số dựa trên velocity BI QUAN do chuyên viên nhập (G2+ sẽ điền từ
 * Rainforest sales estimation). Quy tắc PRD: lô test phủ hàng 30–45 ngày theo
 * kịch bản BI QUAN (không theo trung bình); mức lỗ tối đa = tổn thất nếu bán
 * không chạy + ngân sách ads thăm dò.
 */

import { landedCost } from "./pnl.ts";
import type {
  AssessmentAssumptions,
  FinancialResult,
  RoadmapResult,
  VelocityLadderRow,
} from "./types.ts";

export const DEFAULT_COVER_DAYS = 45;
export const DEFAULT_ADS_TEST_DAYS = 45;
const R2 = (n: number): number => Math.round(n * 100) / 100;
const CEIL = (n: number): number => Math.ceil(n);

/**
 * Ngân sách ads/ngày GỢI Ý = velocity bi quan × CPC/CR (tức PPC/đơn × số đơn
 * dự kiến/ngày). Null khi thiếu CPC/CR hoặc velocity.
 */
export function suggestAdsBudgetPerDay(
  a: AssessmentAssumptions,
  ppcPerOrder: number | null,
): number | null {
  if (
    typeof a.pessimisticUnitsPerDay !== "number" ||
    ppcPerOrder === null
  ) {
    return null;
  }
  return R2(a.pessimisticUnitsPerDay * ppcPerOrder);
}

/** Kill criteria chuẩn (chuyên viên có thể hiệu đính sau trên editor G5). */
export function defaultKillCriteria(): string[] {
  return [
    "Rating < 4,0 sau 50 đơn đầu tiên → dừng, rà soát chất lượng",
    "ACOS thực tế > ACOS hòa vốn 2 tuần liên tiếp → cắt/đổi từ khóa",
    "Tỉ lệ trả hàng > 8% (cao gấp đôi dự phòng 4%) → rà lỗi mô tả/chất lượng",
    "Sau 45 ngày không vào được top 30 từ khóa nền với ngân sách đề xuất → không quy mô",
  ];
}

export function defaultGates(): { week: number; metrics: string[] }[] {
  return [
    { week: 1, metrics: ["Hàng về FBA", "listing live", "khởi chạy ads nền", "theo dõi CPC"] },
    { week: 2, metrics: ["CR theo từ khóa", "CPC thực", "số đơn đầu", "review sớm"] },
    { week: 4, metrics: ["ACOS", "tỷ lệ chuyển đổi", "tồn days-of-cover", "phản hồi 1–3 sao"] },
    { week: 8, metrics: ["rating sau 50 đơn", "TACOS", "biên thực", "quyết định QUY MÔ/SỬA/DỪNG"] },
  ];
}

export function computeRoadmap(
  a: AssessmentAssumptions,
  f: FinancialResult,
): RoadmapResult {
  const coverDays = a.testCoverDays ?? DEFAULT_COVER_DAYS;
  const adsTestDays = a.adsTestDays ?? DEFAULT_ADS_TEST_DAYS;

  const velocity =
    typeof a.pessimisticUnitsPerDay === "number" && a.pessimisticUnitsPerDay > 0
      ? a.pessimisticUnitsPerDay
      : null;

  const testOrderQty = velocity === null ? null : CEIL(velocity * coverDays);
  const unitLanded = landedCost(a);
  const lotCapital = testOrderQty === null ? null : R2(testOrderQty * unitLanded);

  const basePpc = f.scenarios.base.ppcPerOrder;
  const suggested = suggestAdsBudgetPerDay(a, basePpc);
  const adsBudgetPerDay =
    typeof a.adsBudgetPerDay === "number" ? a.adsBudgetPerDay : suggested;
  const adsTestSpend = adsBudgetPerDay === null ? null : R2(adsBudgetPerDay * adsTestDays);

  const breakEvenAcosPct = f.scenarios.base.breakEvenAcosPct;

  // Mức lỗ tối đa: nếu biên bi quan âm, lô test lỗ trên từng đơn + toàn bộ ads.
  const pess = f.scenarios.pessimistic;
  let maxLossAmount: number | null = null;
  const notes: string[] = [];
  if (testOrderQty !== null) {
    const perUnitLoss = pess.netProfit < 0 ? Math.abs(pess.netProfit) : 0;
    maxLossAmount = R2(perUnitLoss * testOrderQty + (adsTestSpend ?? 0));
    if (pess.netProfit >= 0) {
      notes.push(
        `Kịch bản bi quan vẫn dương $${pess.netProfit.toFixed(2)}/đơn — mức lỗ tối đa xấp xỉ bằng ngân sách ads test.`,
      );
    }
  } else {
    notes.push("Chưa có đơn/ngày kịch bản bi quan → chưa tính được quy mô lô test và mức lỗ tối đa.");
  }
  if (basePpc === null) {
    notes.push("Thiếu CPC/tỉ lệ chuyển đổi → chưa gợi ý được ngân sách ads/ngày.");
  }
  notes.push(`Lô test tính trên velocity BI QUAN phủ hàng ${coverDays} ngày (không dùng kịch bản trung bình).`);

  return {
    testOrderQty,
    coverDays,
    lotCapital,
    adsBudgetPerDay,
    adsTestDays,
    adsTestSpend,
    breakEvenAcosPct,
    maxLossAmount,
    gates: defaultGates(),
    killCriteria: defaultKillCriteria(),
    notes,
  };
}

/* ============================================================================
 * BẢNG VELOCITY → VỐN LÔ TEST (ẩn số velocity xử lý bằng "chọn mức chấp nhận")
 * ==========================================================================*/

/** Các mốc velocity bày ra để user CHỌN (đơn/ngày) — velocity thật có ở G2. */
export const VELOCITY_LADDER_DEFAULT = [1, 2, 3, 5, 8, 10];

/**
 * Velocity bi quan là ẩn số user KHÔNG thể biết ở G1 (phải G2 mới có sales
 * estimation Rainforest). Thay vì bắt đoán, bày ra bảng: với mỗi mức velocity
 * giả định thì vốn lô test, ngân sách ads đề xuất và MỨC LỖ TỐI ĐA là bao
 * nhiêu — user chọn mức rủi ro chấp nhận được. Công thức KHỚP computeRoadmap
 * (coverDays, ads đề xuất = velocity × PPC/đơn kịch bản cơ sở, lỗ tối đa =
 * lỗ/đơn bi quan × số lượng + tổng ads test).
 */
export function velocityLadder(
  a: AssessmentAssumptions,
  f: FinancialResult,
  velocities: readonly number[] = VELOCITY_LADDER_DEFAULT,
): VelocityLadderRow[] {
  const coverDays = a.testCoverDays ?? DEFAULT_COVER_DAYS;
  const adsTestDays = a.adsTestDays ?? DEFAULT_ADS_TEST_DAYS;
  const unitLanded = landedCost(a);
  const basePpc = f.scenarios.base.ppcPerOrder;
  const pess = f.scenarios.pessimistic;
  const perUnitLoss = pess.netProfit < 0 ? Math.abs(pess.netProfit) : 0;

  return velocities
    .filter((v) => Number.isFinite(v) && v > 0)
    .map((v) => {
      const testOrderQty = CEIL(v * coverDays);
      const lotCapital = R2(testOrderQty * unitLanded);
      const adsBudgetPerDay =
        typeof a.adsBudgetPerDay === "number" && Number.isFinite(a.adsBudgetPerDay)
          ? a.adsBudgetPerDay
          : basePpc === null
            ? null
            : R2(v * basePpc);
      const adsTestSpend = adsBudgetPerDay === null ? null : R2(adsBudgetPerDay * adsTestDays);
      const maxLoss = R2(perUnitLoss * testOrderQty + (adsTestSpend ?? 0));
      return { unitsPerDay: v, testOrderQty, lotCapital, adsBudgetPerDay, adsTestSpend, maxLoss };
    });
}

/**
 * Khoảng min–max của lộ trình test theo LƯỚI VẬN TỐC — dùng khi velocity bi quan
 * CHƯA được chốt (G1 không bắt đoán). Thay vì bỏ trống "—", bày ra khoảng giá
 * trị tính từ cùng công thức với computeRoadmap để giám đốc thấy quy mô và chốt
 * mức rủi ro ở bảng "Quy mô lô test theo velocity". Null khi thiếu CPC/CR (lưới
 * không tính được cột ads).
 */
export type VelocityLadderRange = {
  testOrderQty: [number, number] | null;
  lotCapital: [number, number] | null;
  adsBudgetPerDay: [number, number] | null;
  adsTestSpend: [number, number] | null;
  maxLoss: [number, number] | null;
};

export function velocityLadderRange(rows: VelocityLadderRow[]): VelocityLadderRange {
  const span = (vals: (number | null)[]): [number, number] | null => {
    const nums = vals.filter((v): v is number => v !== null && Number.isFinite(v));
    if (nums.length === 0) return null;
    return [Math.min(...nums), Math.max(...nums)];
  };
  return {
    testOrderQty: span(rows.map((r) => r.testOrderQty)),
    lotCapital: span(rows.map((r) => r.lotCapital)),
    adsBudgetPerDay: span(rows.map((r) => r.adsBudgetPerDay)),
    adsTestSpend: span(rows.map((r) => r.adsTestSpend)),
    maxLoss: span(rows.map((r) => r.maxLoss)),
  };
}
