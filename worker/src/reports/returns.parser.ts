/**
 * Parser report GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE (Returns Report by Return Date).
 *
 * Cột (theo tài liệu developer-docs.amazon.com/sp-api/docs/report-type-values-returns):
 *   Order ID, Order date, Return request date, Return request status, Amazon RMA ID,
 *   Merchant RMA ID, Label type, Label cost, Currency code, Return carrier, Tracking ID,
 *   Label to be paid by, A-to-Z Claim, Is prime, ASIN, Merchant SKU, Item Name,
 *   Return quantity, Return Reason, In policy, Return type, Resolution, Invoice number,
 *   Return delivery date, Order Amount, Order quantity, SafeT Action reason,
 *   SafeT claim id, SafeT claim state, SafeT claim creation time,
 *   SafeT claim reimbursement amount, Refunded Amount
 *
 * Role cần: Inventory and Order Tracking (đã xin). Giới hạn: tối đa 60 ngày/lần request.
 * Report này KHÔNG chứa PII (không tên/địa chỉ/điện thoại người mua) — chỉ có
 * tracking id + carrier (thuộc VEXIM/đơn vị vận chuyển, không định danh buyer).
 *
 * "Return Reason" trong flat file là TEXT (vd "No longer needed",
 * "Item defective or doesn't work"); một số báo cáo/XML dùng mã (APPAREL_TOO_SMALL).
 * Parser chuẩn hóa qua domain `returnReasonLabel`.
 */
import { returnReasonLabel, type ReturnReasonGroup } from "../domain/orders.ts";

export type ReturnRowParsed = {
  amazonOrderId: string;
  orderDate: string | null;
  returnRequestDate: string;
  returnRequestStatus: string | null;
  amazonRmaId: string | null;
  merchantRmaId: string | null;
  labelType: string | null;
  labelCost: number | null;
  currency: string | null;
  returnCarrier: string | null;
  trackingId: string | null;
  labelToBePaidBy: string | null;
  aToZClaim: boolean | null;
  isPrime: boolean | null;
  asin: string | null;
  sku: string | null;
  itemName: string | null;
  quantity: number;
  /** chuỗi gốc Amazon trả */
  reasonRaw: string;
  /** nhãn tiếng Việt + nhóm phân tích */
  reasonLabel: string;
  reasonGroup: ReturnReasonGroup;
  reasonCode: string;
  inPolicy: string | null;
  returnType: string | null;
  resolution: string | null;
  refundedAmount: number;
  safeTClaimId: string | null;
  safeTClaimState: string | null;
  safeTReimbursementAmount: number;
};

export type ReturnsParseResult = {
  rows: ReturnRowParsed[];
  warnings: string[];
};

const COL = {
  orderId: "Order ID",
  orderDate: "Order date",
  returnRequestDate: "Return request date",
  returnRequestStatus: "Return request status",
  amazonRmaId: "Amazon RMA ID",
  merchantRmaId: "Merchant RMA ID",
  labelType: "Label type",
  labelCost: "Label cost",
  currency: "Currency code",
  carrier: "Return carrier",
  trackingId: "Tracking ID",
  labelPaidBy: "Label to be paid by",
  aToZ: "A-to-Z Claim",
  isPrime: "Is prime",
  asin: "ASIN",
  sku: "Merchant SKU",
  itemName: "Item Name",
  quantity: "Return quantity",
  reason: "Return Reason",
  inPolicy: "In policy",
  returnType: "Return type",
  resolution: "Resolution",
  invoiceNumber: "Invoice number",
  returnDeliveryDate: "Return delivery date",
  orderAmount: "Order Amount",
  orderQuantity: "Order quantity",
  safeTActionReason: "SafeT Action reason",
  safeTClaimId: "SafeT claim id",
  safeTClaimState: "SafeT claim state",
  safeTClaimCreatedAt: "SafeT claim creation time",
  safeTReimbursement: "SafeT claim reimbursement amount",
  refundedAmount: "Refunded Amount",
} as const;

const REQUIRED = [COL.orderId, COL.returnRequestDate, COL.sku] as const;

function toNum(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v.replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function toBool(v: string | undefined): boolean | null {
  if (v === undefined || v === "") return null;
  const s = v.trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(s)) return true;
  if (["false", "0", "no", "n"].includes(s)) return false;
  return null;
}

/**
 * Parse report trả hàng. Header so khớp KHÔNG phân biệt hoa/thường và bỏ khoảng
 * trắng thừa (Amazon có kỳ trả "Return  Reason").
 */
export function parseReturnsReport(text: string): ReturnsParseResult {
  const warnings: string[] = [];
  const lines = (text ?? "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);

  if (lines.length < 2) return { rows: [], warnings: ["Report rỗng"] };

  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const header = lines[0].split("\t").map(norm);
  const idx = (name: string) => header.indexOf(norm(name));

  for (const c of REQUIRED) {
    if (idx(c) < 0) {
      warnings.push(`Thiếu cột bắt buộc: ${c}`);
      return { rows: [], warnings };
    }
  }

  const missing = Object.values(COL).filter((c) => idx(c) < 0);
  if (missing.length > 0) {
    warnings.push(`Report thiếu ${missing.length} cột tuỳ chọn (giá trị = null): ${missing.join(", ")}`);
  }

  const rows: ReturnRowParsed[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split("\t");
    const raw = (name: string): string | undefined => {
      const k = idx(name);
      if (k < 0) return undefined;
      const v = cells[k];
      return v === undefined ? undefined : v.trim();
    };

    const reasonRaw = raw(COL.reason) ?? "";
    const info = returnReasonLabel(reasonRaw);

    rows.push({
      amazonOrderId: raw(COL.orderId) ?? "",
      orderDate: raw(COL.orderDate) || null,
      returnRequestDate: raw(COL.returnRequestDate) ?? "",
      returnRequestStatus: raw(COL.returnRequestStatus) || null,
      amazonRmaId: raw(COL.amazonRmaId) || null,
      merchantRmaId: raw(COL.merchantRmaId) || null,
      labelType: raw(COL.labelType) || null,
      labelCost: toNum(raw(COL.labelCost)),
      currency: raw(COL.currency) || null,
      returnCarrier: raw(COL.carrier) || null,
      trackingId: raw(COL.trackingId) || null,
      labelToBePaidBy: raw(COL.labelPaidBy) || null,
      aToZClaim: toBool(raw(COL.aToZ)),
      isPrime: toBool(raw(COL.isPrime)),
      asin: raw(COL.asin) || null,
      sku: raw(COL.sku) || null,
      itemName: raw(COL.itemName) || null,
      quantity: toNum(raw(COL.quantity)) ?? 1,
      reasonRaw,
      reasonLabel: info.label,
      reasonGroup: info.group,
      reasonCode: info.code,
      inPolicy: raw(COL.inPolicy) || null,
      returnType: raw(COL.returnType) || null,
      resolution: raw(COL.resolution) || null,
      refundedAmount: toNum(raw(COL.refundedAmount)) ?? toNum(raw(COL.orderAmount)) ?? 0,
      safeTClaimId: raw(COL.safeTClaimId) || null,
      safeTClaimState: raw(COL.safeTClaimState) || null,
      safeTReimbursementAmount: toNum(raw(COL.safeTReimbursement)) ?? 0,
    });
  }

  return { rows, warnings };
}
