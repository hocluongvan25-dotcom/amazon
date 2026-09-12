/**
 * Module 6 — Domain logic nghiệp vụ Tài chính & Đối soát.
 *
 * Các hàm chạy trên worker (đối soát report settlement + ledger + financial events)
 * và server-side khi hiển thị trang F1/F2 trên web.
 *
 * Công thức bám docs Finances API v0 + report GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE
 * (xem docs/ke-hoach-trien-khai-theo-module.md mục Module 6).
 */

/* ---------- Hằng số ---------- */

/** Ngưỡng lệch đối soát được phép (1% — trên mức đó tạo cảnh báo SOP-10) */
export const RECONCILE_TOLERANCE_PCT = 0.01;
/** Thời gian giữ Reserve của Amazon (7 ngày theo chính sách hiện hành) */
export const RESERVE_HOLD_DAYS = 7;
/** Tỷ lệ reserve mặc định khi kỳ mới mở (Amazon thường giữ 3-5% tổng sales) */
export const DEFAULT_RESERVE_RATE = 0.05;

/* ---------- Tổng hợp settlement từ các nhóm ---------- */

export type SettlementGroup = {
  label: string;
  amount: number;
  children?: { label: string; amount: number }[];
};

/**
 * Tính tổng tiền vào (các nhóm dương) từ list groups.
 * Lưu ý: không bao gồm reserve hold/release (được tách riêng thành Transfer).
 */
export function totalCredits(groups: SettlementGroup[]): number {
  return groups.filter((g) => g.amount > 0).reduce((s, g) => s + g.amount, 0);
}

/** Tính tổng tiền ra (phí + refund, trị tuyệt đối) */
export function totalDebits(groups: SettlementGroup[]): number {
  return groups
    .filter((g) => g.amount < 0)
    .reduce((s, g) => s + Math.abs(g.amount), 0);
}

/** Net = tổng (tiền vào − tiền ra); nếu đầu vào đủ groups sẽ khớp transferAmount */
export function netTransfer(groups: SettlementGroup[]): number {
  return Math.round(groups.reduce((s, g) => s + g.amount, 0) * 100) / 100;
}

/**
 * Kiểm tra tính khớp giữa tổng các nhóm và transferAmount kỳ settlement.
 * Dung sai tính theo `calc` (tổng hợp từ groups — nguồn đáng tin hơn trong đối soát nội bộ).
 * @returns `null` nếu khớp trong dung sai, hoặc chênh lệch USD nếu lệch.
 */
export function reconcileSettlement(
  groups: SettlementGroup[],
  transferAmount: number,
  tolerancePct: number = RECONCILE_TOLERANCE_PCT,
): number | null {
  const calc = netTransfer(groups);
  const diff = Math.round((calc - transferAmount) * 100) / 100;
  // Lấy max theo giá trị tuyệt đối của calc hoặc transfer để không bị lệch khi transfer ≈ 0
  const base = Math.max(Math.abs(calc), Math.abs(transferAmount), 1);
  if (Math.abs(diff) <= base * tolerancePct) return null;
  return diff;
}

/* ---------- Take rate ---------- */

/**
 * Tỷ lệ phí Amazon trên product sales (referral + FBA + storage + variable closing +
 * high-volume listing + subscription pro-rated). Ads tách riêng.
 */
export function feeTakeRate(groups: SettlementGroup[]): number {
  const sales = groups.find((g) => g.label.startsWith("Product sales"))?.amount ?? 0;
  if (sales <= 0) return 0;
  const feeGroup = groups.find((g) => g.label === "Amazon Fees");
  const fees = feeGroup ? Math.abs(feeGroup.amount) : 0;
  return Math.round((fees / sales) * 1000) / 10; // 1 chữ số %
}

/** TACOS (TACOS = ads / product sales). */
export function tacos(groups: SettlementGroup[]): number {
  const sales = groups.find((g) => g.label.startsWith("Product sales"))?.amount ?? 0;
  if (sales <= 0) return 0;
  const adsGroup = groups.find((g) => g.label.startsWith("Advertising"));
  const ads = adsGroup ? Math.abs(adsGroup.amount) : 0;
  return Math.round((ads / sales) * 1000) / 10;
}

/** Tổng take rate (fee + ads) / sales. */
export function totalTakeRate(groups: SettlementGroup[]): number {
  const sales = groups.find((g) => g.label.startsWith("Product sales"))?.amount ?? 0;
  if (sales <= 0) return 0;
  const fees = Math.abs(groups.find((g) => g.label === "Amazon Fees")?.amount ?? 0);
  const ads = Math.abs(groups.find((g) => g.label.startsWith("Advertising"))?.amount ?? 0);
  return Math.round(((fees + ads) / sales) * 1000) / 10;
}

/* ---------- Ước tính reserve khi kỳ đang mở ---------- */

/**
 * Ước tính số tiền Amazon đang giữ trong kỳ mở = ước lượng sales × reserve rate.
 * Không biết chính xác đến khi kỳ đóng (Amazon báo chính thức trong settlement).
 */
export function estimateReserveHold(openPeriodSales: number, rate: number = DEFAULT_RESERVE_RATE): number {
  return Math.round(openPeriodSales * rate * 100) / 100;
}

/**
 * Ước tính số dư kỳ mở sẽ chuyển về = (sales − refunds − fees − ads ± other) − reserveHold.
 * Con số này thay đổi đến khi kỳ đóng, chỉ dùng để ước tính cashflow.
 */
export function estimateOpenPayout(input: {
  sales: number;
  refunds: number;
  amazonFees: number; // trị âm
  advertising: number; // trị âm
  otherCharges: number;
  reserveRate?: number;
}): { estimatedPayout: number; reserveHold: number } {
  const preReserve =
    input.sales + input.refunds + input.amazonFees + input.advertising + input.otherCharges;
  const reserve = estimateReserveHold(input.sales, input.reserveRate);
  const payout = Math.round((preReserve - reserve) * 100) / 100;
  return { estimatedPayout: payout, reserveHold: reserve };
}

/* ---------- Phân loại event cho dashboard ---------- */

export type EventSummary = {
  sales: number;
  refunds: number;
  amazonFees: number;
  ads: number;
  reimbursements: number;
  other: number;
};

/**
 * Tổng hợp list financial events thành 6 nhóm (dùng cho dashboard F2 và đối soát).
 * @param events danh sách events, mỗi event có `type` và `amount` (dương vào, âm ra)
 */
export function summarizeEvents(
  events: { type: string; amount: number }[],
): EventSummary {
  const out: EventSummary = {
    sales: 0,
    refunds: 0,
    amazonFees: 0,
    ads: 0,
    reimbursements: 0,
    other: 0,
  };
  for (const e of events) {
    switch (e.type) {
      case "ProductSale":
      case "ShippingCredit":
        out.sales += e.amount;
        break;
      case "Refund":
        out.refunds += e.amount;
        break;
      case "ReferralFee":
      case "FBAFee":
      case "StorageFee":
      case "ServiceFee":
      case "Subscription":
        out.amazonFees += e.amount;
        break;
      case "AdvertisingFee":
        out.ads += e.amount;
        break;
      case "Reimbursement":
        out.reimbursements += e.amount;
        break;
      default:
        out.other += e.amount;
    }
  }
  return out;
}
