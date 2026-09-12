/**
 * Parser report settlement — GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2.
 *
 * ⚠️ SỰ THẬT ĐÃ KIỂM CHỨNG (developer-docs.amazon.com/sp-api/docs/report-type-values-settlement):
 *   • `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE` và `GET_V2_SETTLEMENT_REPORT_DATA_XML`
 *     đã BỊ DEPRECATED (SP-API Deprecation Schedule). Report thay thế là
 *     `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2` — vẫn tab-delimited nhưng gộp mọi
 *     loại phí vào 3 cột tổng quát: `amount-type`, `amount-description`, `amount`.
 *     → Parser này bám bản _V2. (Tài liệu nội bộ trước đây ghi bản cũ — đã sửa.)
 *   • Điểm cần lưu ý: "amounts are displayed in local currency formats
 *     (for example, 95,00 for EU instead of 95.00)" → phải parse số theo locale,
 *     KHÔNG được dùng Number() trực tiếp.
 *
 * Cột: settlement-id, settlement-start-date, settlement-end-date, deposit-date,
 *      total-amount, currency, transaction-type, order-id, merchant-order-id,
 *      adjustment-id, shipment-id, marketplace-name, amount-type, amount-description,
 *      amount, fulfillment-id, posted-date, posted-date-time, order-item-code,
 *      merchant-order-item-id, merchant-adjustment-item-id, sku, quantity-purchased,
 *      promotion-id
 *
 * Settlement KHÔNG request/schedule được — Amazon tự tạo kỳ; ta dùng getReports để
 * tìm report đã sinh (xem DEFAULT_FINANCE_SYNC_CONFIG trong jobs/finance-sync.job.ts).
 */
import { type SettlementGroup } from "../domain/finance.ts";

export type SettlementLine = {
  settlementId: string;
  settlementStartDate: string | null;
  settlementEndDate: string | null;
  depositDate: string | null;
  totalAmount: number | null;
  currency: string | null;
  transactionType: string | null;
  orderId: string | null;
  merchantOrderId: string | null;
  adjustmentId: string | null;
  shipmentId: string | null;
  marketplaceName: string | null;
  amountType: string | null;
  amountDescription: string | null;
  amount: number;
  fulfillmentId: string | null;
  postedDate: string | null;
  postedDateTime: string | null;
  orderItemCode: string | null;
  merchantOrderItemId: string | null;
  merchantAdjustmentItemId: string | null;
  sku: string | null;
  quantityPurchased: number | null;
  promotionId: string | null;
};

export type SettlementParseResult = {
  /** id kỳ (lấy từ dòng đầu — mọi dòng của một file dùng chung id) */
  settlementId: string | null;
  startDate: string | null;
  endDate: string | null;
  depositDate: string | null;
  totalAmount: number | null;
  currency: string | null;
  lines: SettlementLine[];
  groups: SettlementGroup[];
  warnings: string[];
};

const COL = {
  settlementId: "settlement-id",
  startDate: "settlement-start-date",
  endDate: "settlement-end-date",
  depositDate: "deposit-date",
  totalAmount: "total-amount",
  currency: "currency",
  transactionType: "transaction-type",
  orderId: "order-id",
  merchantOrderId: "merchant-order-id",
  adjustmentId: "adjustment-id",
  shipmentId: "shipment-id",
  marketplaceName: "marketplace-name",
  amountType: "amount-type",
  amountDescription: "amount-description",
  amount: "amount",
  fulfillmentId: "fulfillment-id",
  postedDate: "posted-date",
  postedDateTime: "posted-date-time",
  orderItemCode: "order-item-code",
  merchantOrderItemId: "merchant-order-item-id",
  merchantAdjustmentItemId: "merchant-adjustment-item-id",
  sku: "sku",
  quantityPurchased: "quantity-purchased",
  promotionId: "promotion-id",
} as const;

const REQUIRED = [COL.settlementId, COL.amountType, COL.amount] as const;

/* ============================================================================
 * Số theo locale
 * ==========================================================================*/

/**
 * Parse số tiền "kiểu local" của report settlement V2.
 *
 * Quy tắc (đã kiểm chứng bằng test):
 *   "95.00"      → 95          (US)
 *   "95,00"      → 95          (EU — ví dụ chính trong tài liệu Amazon)
 *   "1,234.56"   → 1234.56     (US có phân cách nghìn)
 *   "1.234,56"   → 1234.56     (EU có phân cách nghìn)
 *   "1,234"      → 1234        (phân cách nghìn — 3 chữ số sau dấu → không phải thập phân)
 *   "-95,00"     → -95         (hoàn tiền/phí âm)
 *   ""           → null
 *
 * Nguyên tắc: nếu có CẢ hai loại dấu → dấu xuất hiện SAU CÙNG là dấu thập phân.
 * Nếu chỉ có một loại: theo sau đúng 2 chữ số → thập phân; ngược lại → phân cách nghìn.
 */
export function parseLocalizedAmount(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  let s = String(raw).trim();
  if (s === "") return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1).trim();
  } else if (s.startsWith("+")) {
    s = s.slice(1).trim();
  }

  s = s.replace(/[^\d.,]/g, ""); // bỏ ký hiệu tiền tệ, khoảng trắng
  if (s === "") return null;

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");

  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    const decimalSep = lastDot > lastComma ? "." : ",";
    const thousandsSep = decimalSep === "." ? "," : ".";
    normalized = s.split(thousandsSep).join("").replace(decimalSep, ".");
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? "." : ",";
    const parts = s.split(sep);
    const decimals = parts[parts.length - 1] ?? "";
    // đúng 1 dấu và đúng 2 chữ số sau dấu → thập phân; còn lại → phân cách nghìn
    normalized =
      parts.length === 2 && decimals.length === 2 ? `${parts[0]}.${decimals}` : parts.join("");
  } else {
    normalized = s;
  }

  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  const value = Math.round(n * 100) / 100;
  return negative ? -value : value;
}

/* ============================================================================
 * Nhóm phí (khớp label mà domain finance.ts đang dùng)
 * ==========================================================================*/

/** Nhãn nhóm — giữ ĐÚNG chuỗi này vì domain finance.ts tra theo label. */
export const GROUP_LABELS = {
  productSales: "Product sales",
  shipping: "Shipping credits",
  giftWrap: "Gift wrap credits",
  promotions: "Promotional rebates",
  fees: "Amazon Fees",
  advertising: "Advertising",
  transfers: "Transfers",
  reserve: "Reserve",
  other: "Other adjustments",
} as const;

/**
 * Ánh xạ (transaction-type, amount-type, amount-description) → nhóm hiển thị F1.
 * Bám bảng "amount-type / amount-description" của report V2; giá trị lạ rơi vào
 * "Other adjustments" (không bao giờ bị mất khỏi tổng).
 */
export function classifySettlementLine(line: {
  transactionType?: string | null;
  amountType?: string | null;
  amountDescription?: string | null;
}): string {
  // Chuẩn hóa: bỏ khoảng trắng + lowercase ("Cost of Advertising" → "costofadvertising")
  const key = (v: string | null | undefined) => (v ?? "").trim().toLowerCase().replace(/\s+/g, "");
  const type = key(line.amountType);
  const desc = key(line.amountDescription);
  const tx = (line.transactionType ?? "").trim().toLowerCase();

  if (type === "transfer" || tx === "transfer") return GROUP_LABELS.transfers;
  if (type === "reserve" || tx === "reserve") return GROUP_LABELS.reserve;
  if (type === "costofadvertising") return GROUP_LABELS.advertising;
  if (type === "itemfees" || type === "fees") return GROUP_LABELS.fees;
  if (type === "promotion") return GROUP_LABELS.promotions;

  if (type === "itemprice") {
    if (desc === "principal" || desc === "productcharges") return GROUP_LABELS.productSales;
    if (desc === "shipping" || desc === "shippingcharges" || desc === "shippingtax") return GROUP_LABELS.shipping;
    if (desc === "giftwrap" || desc === "giftwrapcharges" || desc === "giftwraptax") return GROUP_LABELS.giftWrap;
    if (desc === "promotion" || desc === "promotionalrebates") return GROUP_LABELS.promotions;
    return GROUP_LABELS.other;
  }

  return GROUP_LABELS.other;
}

/**
 * Gộp các dòng settlement thành nhóm (cấp 1) + children (cấp 2 = amount-description).
 * Khớp cấu trúc `SettlementGroup` mà domain finance.ts dùng
 * (totalCredits/totalDebits/netTransfer/feeTakeRate/tacos đều nhận mảng này).
 */
export function settlementGroups(lines: SettlementLine[]): SettlementGroup[] {
  const order = [
    GROUP_LABELS.productSales,
    GROUP_LABELS.shipping,
    GROUP_LABELS.giftWrap,
    GROUP_LABELS.promotions,
    GROUP_LABELS.fees,
    GROUP_LABELS.advertising,
    GROUP_LABELS.reserve,
    GROUP_LABELS.transfers,
    GROUP_LABELS.other,
  ];
  const map = new Map<string, { label: string; amount: number; children: Map<string, number> }>();

  for (const line of lines) {
    const label = classifySettlementLine(line);
    const entry = map.get(label) ?? { label, amount: 0, children: new Map<string, number>() };
    entry.amount += line.amount;
    const child = (line.amountDescription ?? "").trim() || (line.amountType ?? "khác");
    entry.children.set(child, (entry.children.get(child) ?? 0) + line.amount);
    map.set(label, entry);
  }

  return order
    .filter((label) => map.has(label))
    .map((label) => {
      const e = map.get(label)!;
      return {
        label,
        amount: Math.round(e.amount * 100) / 100,
        children: [...e.children.entries()]
          .map(([k, v]) => ({ label: k, amount: Math.round(v * 100) / 100 }))
          .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
      };
    });
}

/* ============================================================================
 * Parse file
 * ==========================================================================*/

export function parseSettlementReport(text: string): SettlementParseResult {
  const warnings: string[] = [];
  const empty: SettlementParseResult = {
    settlementId: null,
    startDate: null,
    endDate: null,
    depositDate: null,
    totalAmount: null,
    currency: null,
    lines: [],
    groups: [],
    warnings,
  };

  const lines = (text ?? "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return { ...empty, warnings: ["Report rỗng"] };

  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const header = lines[0].split("\t").map(norm);
  const idx = (name: string) => header.indexOf(norm(name));

  for (const c of REQUIRED) {
    if (idx(c) < 0) {
      warnings.push(`Thiếu cột bắt buộc: ${c}`);
      return empty;
    }
  }

  const parsed: SettlementLine[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split("\t");
    const raw = (name: string): string | null => {
      const k = idx(name);
      if (k < 0) return null;
      const v = cells[k];
      return v === undefined || v.trim() === "" ? null : v.trim();
    };

    const amountRaw = raw(COL.amount);
    const amount = parseLocalizedAmount(amountRaw);
    if (amount === null) {
      warnings.push(`Dòng ${i + 1}: amount "${amountRaw ?? ""}" không parse được — bỏ qua`);
      continue;
    }

    parsed.push({
      settlementId: raw(COL.settlementId) ?? "",
      settlementStartDate: raw(COL.startDate),
      settlementEndDate: raw(COL.endDate),
      depositDate: raw(COL.depositDate),
      totalAmount: parseLocalizedAmount(raw(COL.totalAmount)),
      currency: raw(COL.currency),
      transactionType: raw(COL.transactionType),
      orderId: raw(COL.orderId),
      merchantOrderId: raw(COL.merchantOrderId),
      adjustmentId: raw(COL.adjustmentId),
      shipmentId: raw(COL.shipmentId),
      marketplaceName: raw(COL.marketplaceName),
      amountType: raw(COL.amountType),
      amountDescription: raw(COL.amountDescription),
      amount,
      fulfillmentId: raw(COL.fulfillmentId),
      postedDate: raw(COL.postedDate),
      postedDateTime: raw(COL.postedDateTime),
      orderItemCode: raw(COL.orderItemCode),
      merchantOrderItemId: raw(COL.merchantOrderItemId),
      merchantAdjustmentItemId: raw(COL.merchantAdjustmentItemId),
      sku: raw(COL.sku),
      quantityPurchased: parseLocalizedAmount(raw(COL.quantityPurchased)),
      promotionId: raw(COL.promotionId),
    });
  }

  if (parsed.length === 0) return { ...empty, warnings: [...warnings, "Không có dòng dữ liệu hợp lệ"] };

  // settlement-id / kỳ / deposit / total-amount lặp trên mọi dòng → kiểm tra nhất quán
  const first = parsed[0];
  const ids = new Set(parsed.map((l) => l.settlementId));
  if (ids.size > 1) {
    warnings.push(`File chứa ${ids.size} settlement-id khác nhau — giữ id dòng đầu (${first.settlementId})`);
  }
  const totals = new Set(parsed.map((l) => l.totalAmount).filter((v): v is number => v !== null));
  if (totals.size > 1) {
    warnings.push(`total-amount không nhất quán giữa các dòng: ${[...totals].join(", ")}`);
  }

  return {
    settlementId: first.settlementId || null,
    startDate: first.settlementStartDate,
    endDate: first.settlementEndDate,
    depositDate: first.depositDate,
    totalAmount: first.totalAmount,
    currency: first.currency,
    lines: parsed,
    groups: settlementGroups(parsed),
    warnings,
  };
}
