/**
 * Module 2 — Domain logic nghiệp vụ Giá & Featured Offer.
 *
 * Các hàm ở đây chạy trên worker (đồng bộ SP-API → Supabase) và được
 * tái sử dụng bởi API routes phía web để hiển thị/kiểm tra trước khi duyệt.
 *
 * Công thức bám docs/ke-hoach-trien-khai-theo-module.md (Module 2) và
 * tài liệu SP-API Product Pricing v0 + Product Fees v0 + 2022-05-01.
 */

/* ---------- Hằng số quy tắc ---------- */

/** Tỷ lệ referral fee mặc định (đa số category là 15%) — có thể override theo SKU/category */
export const DEFAULT_REFERRAL_RATE = 0.15;
/** Biên lợi nhuận tối thiểu mặc định (% của giá bán) */
export const DEFAULT_MIN_MARGIN_RATE = 0.10;
/** Ngưỡng % thay đổi giá cần trưởng phòng duyệt */
export const APPROVAL_DELTA_PCT_THRESHOLD = 0.02; // 2%
/** Dung sai FOEP: dưới mức này được coi là "khớp" (không cần điều chỉnh) */
export const FOEP_TOLERANCE = 0.02; // $0.02
/** Thời gian (giờ) mất box trước khi rule auto-ra đề xuất giành lại */
export const AUTO_RECOVER_LOST_BOX_HOURS = 2;

/* ---------- Giá sàn (floor price) ---------- */

export type FeeBreakdownInput = {
  cogs: number; // giá vốn
  /** Tỷ lệ referral fee; mặc định 15% */
  referralFeeRate?: number;
  /** FBA fulfillment fee (USD, lấy từ getMyFeesEstimate) */
  fbaFee: number;
  /** Phí khác: closing fee, storage fee pro-rated, high-volume listing fee, v.v. */
  otherFees?: number;
  /** Biên tối thiểu theo % giá bán (0.10 = 10%) */
  minMarginRate?: number;
};

export type FeeBreakdown = {
  cogs: number;
  referralFeeRate: number;
  referralFeeAmount: number;
  fbaFee: number;
  otherFees: number;
  minMarginRate: number;
  minMarginAmount: number;
  floorPrice: number;
};

/**
 * Tính giá sàn (floor price) — giá bán thấp nhất còn lại biên tối thiểu.
 *
 * Công thức:
 *   floor = (cogs + fbaFee + otherFees) / (1 - referralRate - minMarginRate)
 *
 * Vì referral và biên tối thiểu đều tính theo giá bán (chứ không theo cost),
 * phải giải phương trình:
 *   price = cogs + fba + other + referralRate*price + minMarginRate*price
 *   → price * (1 - referralRate - minMarginRate) = cogs + fba + other
 *
 * @returns làm tròn lên 2 chữ số thập phân (theo USD cent)
 */
export function computeFloorPrice(input: FeeBreakdownInput): FeeBreakdown {
  const referralFeeRate = input.referralFeeRate ?? DEFAULT_REFERRAL_RATE;
  const minMarginRate = input.minMarginRate ?? DEFAULT_MIN_MARGIN_RATE;
  const otherFees = input.otherFees ?? 0;
  const denom = 1 - referralFeeRate - minMarginRate;
  if (denom <= 0) {
    throw new RangeError(
      `Tổng tỷ lệ (referral ${(referralFeeRate * 100).toFixed(1)}% + biên tối thiểu ${(minMarginRate * 100).toFixed(1)}%) ≥ 100% — cấu hình sai`,
    );
  }
  const floorPrice = Math.ceil(((input.cogs + input.fbaFee + otherFees) / denom) * 100) / 100;
  const referralFeeAmount = Math.round(floorPrice * referralFeeRate * 100) / 100;
  const minMarginAmount = Math.round(floorPrice * minMarginRate * 100) / 100;
  return {
    cogs: input.cogs,
    referralFeeRate,
    referralFeeAmount,
    fbaFee: input.fbaFee,
    otherFees,
    minMarginRate,
    minMarginAmount,
    floorPrice,
  };
}

/* ---------- Biên hiện tại ---------- */

/**
 * Tính biên % tại giá bán `price` cho trước, dựa trên breakdown giá sàn.
 * Dùng cho cột "Biên" màn P1.
 */
export function computeMargin(price: number, fb: FeeBreakdown): number {
  if (price <= 0) return 0;
  // margin = (price - cogs - fba - other - referral*price) / price
  const profit = price - fb.cogs - fb.fbaFee - fb.otherFees - price * fb.referralFeeRate;
  return Math.round((profit / price) * 1000) / 10; // 1 chữ số thập phân %
}

/** Dải màu hiển thị biên */
export function marginTone(marginPct: number): "red" | "amber" | "green" {
  if (marginPct < 0) return "red";
  if (marginPct < DEFAULT_MIN_MARGIN_RATE * 100) return "amber";
  return "green";
}

/* ---------- Trạng thái Buy Box ---------- */

export type BoxStatus = "holding" | "at_risk" | "lost" | "no_box";

export type BoxStatusInput = {
  /** Ta đang giữ featured offer không? */
  meFeatured: boolean;
  /** FOEP (giá dự kiến vào box); null nếu SKU chửa có offer */
  foep: number | null;
  /** Giá mình hiện tại */
  myPrice: number;
  /** Giá landed (giá+ship) thấp nhất của đối thủ trên cùng condition/fulfillment */
  lowestCompetitorLanded: number | null;
};

/**
 * Phân loại trạng thái Buy Box của 1 SKU:
 * - holding: ta đang giữ box và giá mình ≤ FOEP (+ dung sai)
 * - at_risk: ta đang giữ box nhưng giá > FOEP — có nguy cơ mất
 * - lost: ta không giữ box
 * - no_box: không có offer nào (listing inactive/stranded/out-of-stock)
 */
export function computeBoxStatus(input: BoxStatusInput): BoxStatus {
  if (input.foep === null && input.lowestCompetitorLanded === null) return "no_box";
  if (!input.meFeatured) return "lost";
  if (input.foep !== null && input.myPrice > input.foep + FOEP_TOLERANCE) return "at_risk";
  if (
    input.lowestCompetitorLanded !== null &&
    input.myPrice > input.lowestCompetitorLanded + FOEP_TOLERANCE
  )
    return "at_risk";
  return "holding";
}

/* ---------- Delta giá & phân quyền duyệt ---------- */

/** Delta % = (newPrice - oldPrice) / oldPrice (dương = tăng giá, âm = giảm) */
export function priceDeltaPct(oldPrice: number, newPrice: number): number {
  if (oldPrice <= 0) return 0;
  return Math.round(((newPrice - oldPrice) / oldPrice) * 1000) / 10; // 1 chữ số %
}

/** Có cần trưởng phòng duyệt không? (|Δ| > ngưỡng hoặc đề xuất làm giá dưới sàn) */
export function requiresLeadApproval(
  oldPrice: number,
  newPrice: number,
  floorPrice: number,
): boolean {
  if (newPrice < floorPrice) return true;
  return Math.abs(priceDeltaPct(oldPrice, newPrice)) > APPROVAL_DELTA_PCT_THRESHOLD * 100;
}

/* ---------- Đề xuất giá (auto-rule) ---------- */

export type PriceSuggestionInput = {
  myPrice: number;
  foep: number | null;
  floorPrice: number;
  /** Giá đối thủ thấp nhất landed */
  lowestCompetitorLanded: number | null;
  /** Có đang giữ box không */
  meFeatured: boolean;
  /** Giữ lại 1 cent dưới đối thủ (strategy: undercut-by-a-penny) */
  undercutCents?: number;
};

export type PriceSuggestion = {
  /** Giá đề xuất, đã clamp về trên giá sàn */
  suggestedPrice: number | null;
  /** Lý do đề xuất */
  reason: string;
  /** Có cần trưởng phòng duyệt không */
  needsLead: boolean;
  /** Giá đề xuất có bắng đầu từ giá mình hiện tại không (không có gì để đổi) */
  noop: boolean;
};

/**
 * Đề xuất giá tự động theo quy tắc P4 (giới hạn ở "gợi ý" ở Đợt 2 — không tự áp).
 *
 * Logic:
 * - Nếu ta đang giữ box và giá đang cao hơn FOEP trong khoảng an toàn: không đổi.
 * - Nếu mất box hoặc at_risk và FOEP có giá: đề xuất đặt ở FOEP (hoặc undercut 1¢ nếu đối thủ đang ở FOEP).
 * - Nếu giá đề xuất thấp hơn giá sàn: KHÔNG đề xuất giảm dưới sàn; trả về null + cảnh báo.
 * - Không có FOEP (VD chửa có đủ dữ liệu): dùng lowestCompetitorLanded − undercut.
 */
export function suggestPrice(input: PriceSuggestionInput): PriceSuggestion {
  const undercut = (input.undercutCents ?? 1) / 100;
  const target =
    input.foep !== null
      ? input.foep
      : input.lowestCompetitorLanded !== null
        ? input.lowestCompetitorLanded - undercut
        : null;

  if (target === null) {
    return { suggestedPrice: null, reason: "Không đủ dữ liệu (không FOEP / không đối thủ)", needsLead: false, noop: true };
  }

  // Đặt giá ở target, nhưng không được thấp hơn floor
  let suggested = Math.round((target - undercut) * 100) / 100;
  let clamped = false;
  if (suggested < input.floorPrice) {
    suggested = input.floorPrice;
    clamped = true;
  }

  // Nếu đề xuất bằng giá hiện tại (trong dung sai) → không cần thay đổi
  if (Math.abs(suggested - input.myPrice) <= FOEP_TOLERANCE) {
    return { suggestedPrice: null, reason: "Giá hiện tại đã tối ưu", needsLead: false, noop: true };
  }

  const delta = priceDeltaPct(input.myPrice, suggested);
  const reason = clamped
    ? `Đề xuất ${input.meFeatured ? "giữ" : "giành"} box: giá đối thủ/FOEP $${target.toFixed(2)} — nhưng đã clamp về giá sàn $${suggested.toFixed(2)} (có thể không giành được box ngay)`
    : `Theo ${input.foep !== null ? "FOEP" : "đối thủ thấp nhất"} $${target.toFixed(2)}${input.meFeatured ? "" : " để giành lại box"}`;
  return {
    suggestedPrice: suggested,
    reason,
    needsLead: requiresLeadApproval(input.myPrice, suggested, input.floorPrice),
    noop: false,
  };
}

/* ---------- Phân loại SKU cho dashboard P1 ---------- */

export type PricingFlag =
  | "below_floor"
  | "lost_box_high_velocity"
  | "at_risk"
  | "lost_box"
  | "no_offer"
  | "ok";

/**
 * Gắn cờ ưu tiên cho SKU — dùng để sắp xếp bảng P1 và tạo KPI/alert.
 * @param lostBoxHours số giờ đã mất box (0 nếu đang giữ)
 * @param velocity velocity 30 ngày (đơn/ngày)
 */
export function pricingFlag(input: {
  status: BoxStatus;
  marginPct: number;
  velocity30d: number;
  lostBoxHours?: number;
}): PricingFlag {
  if (input.marginPct < 0) return "below_floor";
  if (input.status === "no_box") return "no_offer";
  if (input.status === "lost" && input.velocity30d >= 20 && (input.lostBoxHours ?? 0) >= AUTO_RECOVER_LOST_BOX_HOURS)
    return "lost_box_high_velocity";
  if (input.status === "lost") return "lost_box";
  if (input.status === "at_risk") return "at_risk";
  return "ok";
}

/* ---------- Tính revenue bị rò rỉ khi mất box ---------- */

/**
 * Ước tính doanh thu/ngày bị rò rỉ về tay đối thủ khi mất box.
 * Công thức đơn giản: velocity * marketShareLoss * (ourPrice - avgFeesEstimate)
 * (Phiên bản production sẽ dùng conversion rate thực tế theo ASIN.)
 */
export function estimatedRevenueLeakage(
  velocity: number,
  ourPrice: number,
  floorPrice: number,
  lostBoxHours: number,
): number {
  if (lostBoxHours <= 0) return 0;
  // Giả định khi mất box, 70% đơn chuyển sang seller ở box (còn lại chia cho các seller khác / dừng mua)
  const shareLostToBox = 0.7;
  // Giả sử lợi nhuận/đơn ~15% giá bán (ước tính)
  const profitPerUnit = ourPrice - floorPrice;
  const days = lostBoxHours / 24;
  return Math.round(velocity * shareLostToBox * profitPerUnit * days * 100) / 100;
}
