/**
 * Module 8 — Phân hệ 1: UNIT ECONOMICS (tính biên lợi nhuận giả định).
 *
 * Tái sử dụng tinh thần của worker/src/domain/pricing.ts (giá sàn, biên) nhưng
 * dành cho sản phẩm CHƯA đưa lên sàn: đầu vào là 3 kịch bản giá + COGS + bao bì
 * + giả định PPC; đầu ra là P&L từng cent/đơn vị, mô phỏng quy mô tháng và bảng
 * tối ưu bao bì để tụt FBA size tier.
 *
 * Ngưỡng cứng PRD: Net Margin < 20% (kịch bản BI QUAN) → cờ đỏ tài chính.
 */

import {
  classifySizeTier,
  estimateFbaFeeUs,
  estimateStorageMonthly,
  evaluatePackaging,
  FEE_TABLE_VERSION,
} from "./size-tier.ts";
import type {
  AssessmentAssumptions,
  FeeSource,
  FinancialResult,
  MonthlySimulation,
  ScenarioKey,
  ScenarioPnl,
} from "./types.ts";

export const DEFAULT_REFERRAL_RATE = 0.15;
export const DEFAULT_RETURN_RATE = 0.04;
export const MARGIN_RED_FLAG = 0.2; // Hard filter PRD: < 20% = CẢNH BÁO ĐỎ
const R2 = (n: number): number => Math.round(n * 100) / 100; // tiền: 2 chữ số
const R1 = (n: number): number => Math.round(n * 10) / 10; // phần trăm: 1 chữ số

/** Giá vốn cập cảng FBA (landed cost) = giá tận xưởng + cước phân bổ/đơn vị. */
export function landedCost(a: AssessmentAssumptions): number {
  return R2(a.cogsPerUnit + (a.inboundFreightPerUnit ?? 0));
}

/**
 * Phí FBA/đơn vị dùng cho tính toán:
 *  1. fbaFeeOverride (SP-API Product Fees) nếu có — con số CHUẨN;
 *  2. không thì ước lượng theo bảng phí hằng năm từ kích thước đóng gói.
 */
export function resolveFbaFee(a: AssessmentAssumptions): {
  fee: number;
  source: FeeSource;
} {
  if (typeof a.fbaFeeOverride === "number" && Number.isFinite(a.fbaFeeOverride)) {
    return { fee: R2(a.fbaFeeOverride), source: "spapi" };
  }
  const t = classifySizeTier(a.packDims);
  return { fee: estimateFbaFeeUs(t.tier, t.billableWeightLb), source: "estimated_table" };
}

/**
 * P&L cho 1 kịch bản giá.
 *
 *   Net profit = giá − (landed COGS + referral + FBA + storage + PPC/đơn
                        + dự phòng trả hàng + chi phí khác)
 *   Net margin % = net profit / giá
 *   Break-even ACOS = biên TRƯỚC PPC (đây là trần ACOS chấp nhận được)
 *
 * PPC/đơn = CPC / CR (mỗi đơn cần 1/CR lượt click). Thiếu CPC hoặc CR → null
 * (KHÔNG tự bịa 0 — đúng quy ước "thiếu dữ liệu thì nói rõ").
 */
export function computeScenarioPnl(
  a: AssessmentAssumptions,
  scenario: ScenarioKey,
  fba: { fee: number; source: FeeSource },
  storageFee: number,
): ScenarioPnl {
  const price = a.prices[scenario];
  const referralRate = a.referralRate ?? DEFAULT_REFERRAL_RATE;
  const returnRate = a.returnRate ?? DEFAULT_RETURN_RATE;

  const landed = landedCost(a);
  const referralFee = R2(price * referralRate);
  const ppcPerOrder =
    typeof a.cpc === "number" && typeof a.conversionRate === "number" && a.conversionRate > 0
      ? R2(a.cpc / a.conversionRate)
      : null;
  const returnReserve = R2(price * returnRate);
  const other = R2(a.otherPerUnit ?? 0);

  const totalCosts = R2(
    landed +
      referralFee +
      fba.fee +
      storageFee +
      (ppcPerOrder ?? 0) +
      returnReserve +
      other,
  );
  const netProfit = R2(price - totalCosts);
  const netMarginPct = price > 0 ? R1((netProfit / price) * 100) : 0;
  const preAdProfit =
    price - landed - referralFee - fba.fee - storageFee - returnReserve - other;
  const breakEvenAcosPct = price > 0 ? R1((preAdProfit / price) * 100) : 0;

  return {
    scenario,
    price: R2(price),
    landedCost: landed,
    referralFee,
    fbaFee: fba.fee,
    fbaFeeSource: fba.source,
    storageFee,
    ppcPerOrder,
    returnReserve,
    otherPerUnit: other,
    totalCosts,
    netProfit,
    netMarginPct,
    breakEvenAcosPct,
  };
}

/**
 * Sinh các phương án bao bì để khảo sát khả năng tụt size tier:
 *  - hiện tại (baseline);
 *  - nén bề dày về ≤0.75" (để về Small Standard nếu hai cạnh kia đạt);
 *  - thu cạnh dài ≤15" và dày ≤0.75";
 *  - thu vào Large Standard (≤18×14×8) khi đang bulky.
 * Chỉ giữ phương án KHÁC tier hiện tại và khả thi (số đo dương ≤ hiện tại).
 */
export function packagingOptimizations(
  a: AssessmentAssumptions,
  baselineFee: number,
  velocityUnitsPerYear?: number | null,
) {
  const d = a.packDims;
  const t = classifySizeTier(d);
  const candidates: { label: string; dims: typeof d }[] = [];

  if (t.tier !== "small_standard" && t.tier !== "large_envelope") {
    // Cố về Small Standard: 15 × 12 × 0.75
    const dims: typeof d = {
      lengthIn: Math.min(d.lengthIn, 15),
      widthIn: Math.min(d.widthIn, 12),
      heightIn: Math.min(d.heightIn, 0.75),
      weightLb: d.weightLb,
    };
    if (
      dims.lengthIn !== d.lengthIn ||
      dims.widthIn !== d.widthIn ||
      dims.heightIn !== d.heightIn
    ) {
      candidates.push({ label: "Nén tối đa về khổ Standard (mục tiêu ≤15×12×0.75\")", dims });
    }
  }
  if (t.isOversize) {
    // Cố về Large Standard: 18 × 14 × 8
    const dims: typeof d = {
      lengthIn: Math.min(d.lengthIn, 18),
      widthIn: Math.min(d.widthIn, 14),
      heightIn: Math.min(d.heightIn, 8),
      weightLb: Math.min(d.weightLb, 20),
    };
    if (
      dims.lengthIn !== d.lengthIn ||
      dims.widthIn !== d.widthIn ||
      dims.heightIn !== d.heightIn ||
      dims.weightLb !== d.weightLb
    ) {
      candidates.push({ label: "Thu về Large Standard (≤18×14×8\", ≤20 lb)", dims });
    }
  }

  const options = [evaluatePackaging("Bao bì hiện tại", d, baselineFee, velocityUnitsPerYear)];
  for (const c of candidates) {
    const opt = evaluatePackaging(c.label, c.dims, baselineFee, velocityUnitsPerYear);
    if (opt.tier !== options[0].tier && (opt.savingPerUnit ?? 0) > 0) options.push(opt);
  }
  return options;
}

/** Mô phỏng P&L THÁNG tại các mốc sản lượng, dùng kịch bản giá CƠ SỞ. */
export function simulateMonth(
  a: AssessmentAssumptions,
  base: ScenarioPnl,
  unitsPerMonth: number,
): MonthlySimulation {
  const adSpend =
    base.ppcPerOrder === null ? null : R2(base.ppcPerOrder * unitsPerMonth);
  return {
    unitsPerMonth,
    revenue: R2(base.price * unitsPerMonth),
    netProfit: R2(base.netProfit * unitsPerMonth),
    adSpend,
  };
}

/** Tính toàn bộ phần tài chính của hồ sơ thẩm định (G1). */
export function computeFinancial(a: AssessmentAssumptions): FinancialResult {
  const fba = resolveFbaFee(a);
  const tier = classifySizeTier(a.packDims);
  const storageEst = estimateStorageMonthly(a.packDims, tier.isOversize);
  const monthsAssumed = a.storageMonthsAssumed ?? 1;
  const lowPerMonth = a.storagePerUnitMonthLow ?? storageEst.low;
  const peakPerMonth = a.storagePerUnitMonthPeak ?? storageEst.peak;
  // P&L chuẩn dùng phí lưu kho mùa THẤP (thận trọng hơn cho biên); bù lại có cảnh báo mùa cao điểm.
  const storageFee = R2(lowPerMonth * monthsAssumed);

  const scenarios = {
    pessimistic: computeScenarioPnl(a, "pessimistic", fba, storageFee),
    base: computeScenarioPnl(a, "base", fba, storageFee),
    optimistic: computeScenarioPnl(a, "optimistic", fba, storageFee),
  } as Record<ScenarioKey, ScenarioPnl>;

  const monthly = [300, 500, 1000].map((u) => simulateMonth(a, scenarios.base, u));

  const velocityYear =
    typeof a.pessimisticUnitsPerDay === "number"
      ? Math.round(a.pessimisticUnitsPerDay * 365)
      : null;
  const packagingSuggestions = packagingOptimizations(a, fba.fee, velocityYear);
  const currentPackaging = packagingSuggestions[0];

  const warnings: string[] = [];
  if (scenarios.pessimistic.netMarginPct < MARGIN_RED_FLAG * 100) {
    warnings.push(
      `CẢNH BÁO ĐỎ: biên kịch bản bi quan ${scenarios.pessimistic.netMarginPct.toFixed(1)}% dưới ngưỡng ${MARGIN_RED_FLAG * 100}%`,
    );
  }
  if (tier.isOversize) {
    warnings.push(
      `Đóng gói đang ở nhóm ${tier.label} — phí FBA cao, cần xem phương án tối ưu bao bì`,
    );
  }
  for (const n of tier.nearBoundaries) warnings.push(n);
  if (scenarios.base.ppcPerOrder === null) {
    warnings.push("Chưa có CPC/tỉ lệ chuyển đổi → PPC/đơn để trống, biên hiện CHƯA trừ quảng cáo");
  }
  const peakDelta = R2((peakPerMonth - lowPerMonth) * monthsAssumed);
  if (peakDelta > 0) {
    warnings.push(
      `Phí lưu kho mùa cao điểm (Q4) cao hơn mùa thấp ~$${peakDelta.toFixed(2)}/đơn/tháng tồn — tính lại nếu hàng về kho Oct–Dec`,
    );
  }

  return {
    scenarios,
    monthly,
    currentPackaging,
    packagingSuggestions,
    storage: {
      cubicFeet: storageEst.cubicFeet,
      lowPerMonth: R2(lowPerMonth),
      peakPerMonth: R2(peakPerMonth),
      monthsAssumed,
      source:
        a.storagePerUnitMonthLow !== undefined && a.storagePerUnitMonthLow !== null
          ? "manual"
          : `bảng storage US 2026 (${tier.isOversize ? "oversize" : "standard"})`,
    },
    feeTableVersion: FEE_TABLE_VERSION,
    warnings,
  };
}
