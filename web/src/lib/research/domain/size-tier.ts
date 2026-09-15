/**
 * Module 8 — Phân FBA SIZE TIER & ƯỚC LƯỢNG PHÍ FULFILMENT (marketplace US).
 *
 * NGUỒN QUY TẮC (đọc/kiểm chứng lại hằng năm — Amazon đổi phí mỗi năm):
 *   • Size tier 2026 (hiệu lực 15/01/2026, thêm bậc "Small Bulky"):
 *       Small standard  ≤15 × ≤12 × ≤0.75 in · ≤16 oz           (chỉ cân nặng đơn vị)
 *       Large standard  ≤18 × ≤14 × ≤8 in    · ≤20 lb           (max(unit, dim/139))
 *       Small Bulky     ≤37 × ≤28 × ≤20 in   · ≤50 lb · L+girth ≤130
 *       Large Bulky     ≤59 × ≤33 × ≤33 in   · ≤50 lb · L+girth ≤130
 *       Extra-Large     vượt ngưỡng trên (4 băng cân ≤50 / 50–70 / 70–150 / 150+)
 *       (Large envelope ≤13 × ≤11 × ≤1 in · ≤10 oz — bậc mỏng nhẹ, xếp trước)
 *     Dimensional weight FBA = L×W×H / 139; bậc bulky giả định W/H tối thiểu 2".
 *   • Phí fulfilment 2026 (không apparel, giá ≥ $10, mức tham khảo; CHỈ là bảng
 *     ƯỚC LƯỢNG khi chưa gọi SP-API Product Fees — con số chuẩn phải lấy từ
 *     getMyFeesEstimateForASIN/SKU và đánh dấu feeSource='spapi').
 *
 * Tài liệu: docs/ke-hoach-module-8-tham-dinh-rnd-san-pham.md (mục 8, G1).
 */

import type {
  FeeSource,
  PackDimensions,
  PackagingOption,
  SizeTierCode,
  SizeTierResult,
} from "./types.ts";

export const FEE_TABLE_VERSION = "FBA-US-2026-approx";
const DIM_DIVISOR = 139;

/* ------------------------------ Hằng số tier ------------------------------ */

export const SIZE_TIER_LABEL: Record<SizeTierCode, string> = {
  large_envelope: "Large Envelope (phong bì lớn)",
  small_standard: "Small Standard",
  large_standard: "Large Standard",
  small_bulky: "Small Bulky (cồng kềnh nhỏ — bậc mới 2026)",
  large_bulky: "Large Bulky (cồng kềnh lớn)",
  extra_large: "Extra-Large (siêu lớn)",
};

/** Thứ tự tăng dần; phải đạt MỌI điều kiện của bậc nhỏ nhất phù hợp. */
type TierCeiling = {
  code: SizeTierCode;
  longest: number;
  median: number;
  shortest: number;
  maxWeightLb: number;
  maxLengthPlusGirth?: number;
};

const TIER_CEILINGS: TierCeiling[] = [
  { code: "large_envelope", longest: 13, median: 11, shortest: 1, maxWeightLb: 10 / 16 },
  { code: "small_standard", longest: 15, median: 12, shortest: 0.75, maxWeightLb: 1 },
  { code: "large_standard", longest: 18, median: 14, shortest: 8, maxWeightLb: 20 },
  {
    code: "small_bulky",
    longest: 37,
    median: 28,
    shortest: 20,
    maxWeightLb: 50,
    maxLengthPlusGirth: 130,
  },
  {
    code: "large_bulky",
    longest: 59,
    median: 33,
    shortest: 33,
    maxWeightLb: 50,
    maxLengthPlusGirth: 130,
  },
];

/* --------------------------- Bảng phí tham khảo --------------------------- */
/** Bậc cân (lb, trên-dưới) → phí/đơn vị, mức 2026 tham khảo (items ≥ $10). */
const SMALL_STANDARD_FEES: { upToLb: number; fee: number }[] = [
  { upToLb: 4 / 16, fee: 3.06 },
  { upToLb: 8 / 16, fee: 3.15 },
  { upToLb: 16 / 16, fee: 3.36 },
];

const LARGE_ENVELOPE_FEES: { upToLb: number; fee: number }[] = [
  { upToLb: 4 / 16, fee: 3.27 },
  { upToLb: 8 / 16, fee: 3.55 },
  { upToLb: 10 / 16, fee: 3.77 },
];

const LARGE_STANDARD_FEES: { upToLb: number; fee: number }[] = [
  { upToLb: 4 / 16, fee: 3.68 },
  { upToLb: 8 / 16, fee: 3.86 },
  { upToLb: 12 / 16, fee: 3.86 },
  { upToLb: 16 / 16, fee: 4.13 },
  { upToLb: 1.5, fee: 5.9 },
  { upToLb: 2, fee: 6.14 },
  { upToLb: 2.5, fee: 6.63 },
  { upToLb: 3, fee: 6.81 },
  // >3 lb: 6.92 + $0.16 cho mỗi nửa lb trên 3 (xem estimateLargeStandardOver3Lb)
];

const ROUND2 = (n: number): number => Math.round(n * 100) / 100;

/* ------------------------------- Phân tier ------------------------------- */

export function sortedSides(d: PackDimensions): [number, number, number] {
  return [d.lengthIn, d.widthIn, d.heightIn].sort((a, b) => b - a) as [
    number,
    number,
    number,
  ];
}

export function dimensionalWeightLb(d: PackDimensions, minSides = 0): number {
  const [l, m, s] = sortedSides(d);
  const vol = l * Math.max(m, minSides) * Math.max(s, minSides);
  return ROUND2(vol / DIM_DIVISOR);
}

export function lengthPlusGirth(d: PackDimensions): number {
  const [l, m, s] = sortedSides(d);
  return l + 2 * m + 2 * s;
}

function nearBoundary(actual: number, ceiling: number, tol = 0.05): boolean {
  if (ceiling <= 0) return false;
  return actual <= ceiling && actual / ceiling >= 1 - tol;
}

/**
 * Phân size tier cho đơn vị đóng gói. Số đo phải là của BAO BÌ GỬI FBA, không
 * phải sản phẩm trần (đây là lỗi phổ biến khiến phí bị đội tier).
 */
export function classifySizeTier(d: PackDimensions): SizeTierResult {
  const sides = sortedSides(d);
  const [longest, median, shortest] = sides;
  const lpg = lengthPlusGirth(d);

  let tier: SizeTierCode = "extra_large";
  let matchedCeiling: TierCeiling | null = null;
  for (const c of TIER_CEILINGS) {
    const fitDims =
      longest <= c.longest && median <= c.median && shortest <= c.shortest;
    const fitWeight = d.weightLb <= c.maxWeightLb;
    const fitGirth = c.maxLengthPlusGirth === undefined || lpg <= c.maxLengthPlusGirth;
    if (fitDims && fitWeight && fitGirth) {
      tier = c.code;
      matchedCeiling = c;
      break;
    }
  }

  // Khối lượng tính phí:
  //  - small standard / large envelope / extra-large 150+: chỉ cân nặng đơn vị
  //  - large standard: max(unit, dimensional/139)
  //  - bulky: dimensional với W/H giả định tối thiểu 2"
  let dimW = 0;
  if (tier === "large_standard") dimW = dimensionalWeightLb(d, 0);
  if (tier === "small_bulky" || tier === "large_bulky" || tier === "extra_large") {
    dimW = dimensionalWeightLb(d, 2);
  }
  const billable = Math.max(d.weightLb, dimW);

  // Cảnh báo mép ngưỡng — nơi tối ưu bao bì có thể tụt 1 tier. Chỉ kiểm theo
  // trần của chính bậc đang xếp; extra_large không có trần nên bỏ qua.
  const near: string[] = [];
  if (matchedCeiling) {
    const checks: { actual: number; ceiling: number; name: string }[] = [
      { actual: longest, ceiling: matchedCeiling.longest, name: "cạnh dài nhất" },
      { actual: median, ceiling: matchedCeiling.median, name: "cạnh trung vị" },
      { actual: shortest, ceiling: matchedCeiling.shortest, name: "cạnh ngắn nhất (bề dày)" },
      { actual: d.weightLb, ceiling: matchedCeiling.maxWeightLb, name: "khối lượng" },
    ];
    if (matchedCeiling.maxLengthPlusGirth !== undefined) {
      checks.push({
        actual: ROUND2(lpg),
        ceiling: matchedCeiling.maxLengthPlusGirth,
        name: "dài + vòng bụng",
      });
    }
    for (const c of checks) {
      if (nearBoundary(c.actual, c.ceiling)) {
        near.push(
          `${c.name} ${c.actual} nằm rất sát trần ${c.ceiling} — tối ưu bao bì có thể tụt tier`,
        );
      }
    }
  }

  return {
    tier,
    label: SIZE_TIER_LABEL[tier],
    sides,
    unitWeightLb: d.weightLb,
    dimensionalWeightLb: ROUND2(dimW),
    billableWeightLb: ROUND2(billable),
    lengthPlusGirthIn: ROUND2(lpg),
    isOversize: tier === "small_bulky" || tier === "large_bulky" || tier === "extra_large",
    nearBoundaries: near,
  };
}

/* ----------------------------- Ước lượng phí ----------------------------- */

function bandFee(bands: { upToLb: number; fee: number }[], lb: number): number | null {
  for (const b of bands) {
    if (lb <= b.upToLb + 1e-9) return b.fee;
  }
  return null;
}

/** Large standard trên 3 lb: 6.92 + 0.16 × số nửa lb trên 3 (làm tròn lên). */
function largeStandardOver3Lb(lb: number): number {
  const halfLbUnits = Math.ceil((lb - 3) * 2 - 1e-9);
  return ROUND2(6.92 + 0.16 * Math.max(0, halfLbUnits));
}

/**
 * Ước lượng phí fulfilment FBA US 2026 theo tier + khối lượng tính phí.
 * Đây là bảng THAM KHẢO khi chưa có SP-API; mọi nơi hiển thị phải kèm nguồn.
 */
export function estimateFbaFeeUs(tier: SizeTierCode, billableLb: number): number {
  switch (tier) {
    case "large_envelope": {
      const f = bandFee(LARGE_ENVELOPE_FEES, billableLb);
      return f ?? LARGE_ENVELOPE_FEES[LARGE_ENVELOPE_FEES.length - 1].fee;
    }
    case "small_standard": {
      const f = bandFee(SMALL_STANDARD_FEES, billableLb);
      return f ?? SMALL_STANDARD_FEES[SMALL_STANDARD_FEES.length - 1].fee;
    }
    case "large_standard": {
      const f = bandFee(LARGE_STANDARD_FEES, billableLb);
      return f ?? largeStandardOver3Lb(billableLb);
    }
    case "small_bulky":
      // ~$9.60 cho lb đầu + $0.38/lb tiếp theo (mức 2025–2026 tham khảo)
      return ROUND2(9.6 + 0.38 * Math.max(0, Math.ceil(billableLb) - 1));
    case "large_bulky":
      // ~$10.15 cho băng 21–50 lb + $0.43/lb; dùng gần đúng theo billable
      return ROUND2(10.15 + 0.43 * Math.max(0, Math.ceil(billableLb) - 1));
    case "extra_large": {
      if (billableLb <= 50) return ROUND2(26.33 + 0.38 * Math.max(0, Math.ceil(billableLb) - 1));
      if (billableLb <= 70) return ROUND2(40.12 + 0.75 * Math.max(0, Math.ceil(billableLb) - 51));
      if (billableLb <= 150) return ROUND2(54.81 + 0.75 * Math.max(0, Math.ceil(billableLb) - 71));
      return ROUND2(194.95 + 0.19 * Math.max(0, Math.ceil(billableLb) - 151));
    }
  }
}

/** Phí storage/đơn vị/tháng từ khối lượng bao bì (ft³). Mức chuẩn 2026 US. */
export function estimateStorageMonthly(d: PackDimensions, isOversize: boolean): {
  cubicFeet: number;
  low: number;
  peak: number;
} {
  const [l, m, s] = sortedSides(d);
  const cubicFeet = ROUND2((l * m * s) / 1728);
  const lowRate = isOversize ? 0.56 : 0.78; // $/ft³ tháng (Jan–Sep)
  const peakRate = isOversize ? 1.4 : 2.25; // Q4 (Oct–Dec)
  return {
    cubicFeet,
    low: ROUND2(cubicFeet * lowRate),
    peak: ROUND2(cubicFeet * peakRate),
  };
}

/**
 * Đánh giá 1 phương án đóng gói → tier + phí (dùng cho bảng mô phỏng tối ưu
 * bao bì trong Tab 1).
 */
export function evaluatePackaging(
  label: string,
  dims: PackDimensions,
  baselineFee?: number,
  velocityUnitsPerYear?: number | null,
): PackagingOption {
  const t = classifySizeTier(dims);
  const fee = estimateFbaFeeUs(t.tier, t.billableWeightLb);
  const savingPerUnit = baselineFee === undefined ? null : ROUND2(baselineFee - fee);
  const savingPerYear =
    savingPerUnit === null || !velocityUnitsPerYear
      ? null
      : ROUND2(savingPerUnit * velocityUnitsPerYear);
  return {
    label,
    dims,
    tier: t.tier,
    tierLabel: t.label,
    billableWeightLb: t.billableWeightLb,
    fbaFee: fee,
    savingPerUnit,
    savingPerYear,
  };
}

/** Nguồn của con số FBA (chuẩn hoá để hiển thị nhãn). */
export function feeSourceLabel(source: FeeSource): string {
  switch (source) {
    case "spapi":
      return "SP-API Product Fees (phí chuẩn Amazon)";
    case "manual":
      return "Nhập tay";
    case "estimated_table":
      return `Ước lượng theo bảng ${FEE_TABLE_VERSION}`;
  }
}
