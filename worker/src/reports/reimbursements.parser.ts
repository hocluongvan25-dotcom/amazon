/**
 * Parser report FBA REIMBURSEMENTS — `GET_FBA_REIMBURSEMENTS_DATA` (Module 6 / F3).
 *
 * Cột (kiểm chứng developer-docs.amazon.com/sp-api/docs/report-type-values-fba,
 * 12/09/2026 — "FBA Reimbursements Report"):
 *   approval-date, reimbursement-id, case-id, amazon-order-id, reason, sku, fnsku,
 *   asin, product-name, condition, currency-unit, amount-per-unit, amount-total,
 *   quantity-reimbursed-cash, quantity-reimbursed-inventory,
 *   quantity-reimbursed-total, original-reimbursement-id, original-reimbursement-type
 *
 * Lưu ý thực tế (giống report settlement V2): số tiền có thể ở định dạng local
 * ("1.234,56" kiểu EU) → dùng chung parseLocalizedAmount, KHÔNG Number() trực tiếp.
 * Report có BOM UTF-8 ở 3 byte đầu → cắt trước khi tách header.
 *
 * Chỉ tiêu thụ reportType HTML/TSV; KHÔNG lấy PII người mua (report không có).
 */
import { parseLocalizedAmount } from "./settlement.parser.ts";

export type ReimbursementLine = {
  reimbursementId: string | null;
  caseId: string | null;
  amazonOrderId: string | null;
  reason: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  condition: string | null;
  currency: string | null;
  amountPerUnit: number | null;
  amountTotal: number | null;
  quantityReimbursedCash: number | null;
  quantityReimbursedInventory: number | null;
  quantityReimbursedTotal: number | null;
  approvalDate: string | null;
  originalReimbursementId: string | null;
  originalReimbursementType: string | null;
  /** Khoá chống trùng khi import lại (SOP-09 chạy hằng tuần) */
  dedupeKey: string;
};

export type ReimbursementParseResult = {
  lines: ReimbursementLine[];
  /** Tổng tiền đã được Amazon bồi hoàn trong report (chỉ dòng có amount-total) */
  totalAmount: number;
  currency: string | null;
  warnings: string[];
};

const COL = {
  approvalDate: "approval-date",
  reimbursementId: "reimbursement-id",
  caseId: "case-id",
  amazonOrderId: "amazon-order-id",
  reason: "reason",
  sku: "sku",
  fnsku: "fnsku",
  asin: "asin",
  condition: "condition",
  currency: "currency-unit",
  amountPerUnit: "amount-per-unit",
  amountTotal: "amount-total",
  qtyCash: "quantity-reimbursed-cash",
  qtyInventory: "quantity-reimbursed-inventory",
  qtyTotal: "quantity-reimbursed-total",
  originalId: "original-reimbursement-id",
  originalType: "original-reimbursement-type",
} as const;

/** Cột tối thiểu để một dòng có nghĩa (thiếu là bỏ qua dòng đó). */
const REQUIRED: readonly string[] = [COL.reimbursementId, COL.amountTotal];

/**
 * Khoá chống trùng: reimbursement-id + sku + reason.
 * Amazon có thể bồi hoàn cùng một reimbursement-id cho nhiều SKU (một case nhiều
 * dòng) nên phải gộp cả sku; reason để phân biệt bồi hoàn gốc và bồi hoàn lại
 * (original-reimbursement-id trỏ về khoản bị hoàn tác — vẫn giữ riêng dòng).
 */
export function reimbursementDedupeKey(line: {
  reimbursementId: string | null;
  sku: string | null;
  reason: string | null;
  amountTotal: number | null;
}): string {
  return [line.reimbursementId ?? "", line.sku ?? "", line.reason ?? "", line.amountTotal ?? ""].join("|");
}

export function parseReimbursementsReport(text: string): ReimbursementParseResult {
  const warnings: string[] = [];
  const lines = (text ?? "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);

  if (lines.length < 2) {
    return { lines: [], totalAmount: 0, currency: null, warnings: ["Report rỗng"] };
  }

  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const header = lines[0].split("\t").map(norm);
  const idx = (name: string) => header.indexOf(norm(name));

  for (const c of REQUIRED) {
    if (idx(c) < 0) {
      warnings.push(`Thiếu cột bắt buộc: ${c}`);
      return { lines: [], totalAmount: 0, currency: null, warnings };
    }
  }

  const parsed: ReimbursementLine[] = [];
  let totalAmount = 0;
  let currency: string | null = null;

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split("\t");
    const raw = (name: string): string | null => {
      const k = idx(name);
      if (k < 0) return null;
      const v = cells[k];
      return v === undefined || v.trim() === "" ? null : v.trim();
    };

    const reimbursementId = raw(COL.reimbursementId);
    const amountTotal = parseLocalizedAmount(raw(COL.amountTotal));
    if (!reimbursementId && amountTotal === null) {
      warnings.push(`Dòng ${i + 1}: thiếu reimbursement-id và amount-total — bỏ qua`);
      continue;
    }

    const sku = raw(COL.sku);
    const reason = raw(COL.reason);
    const line: ReimbursementLine = {
      reimbursementId,
      caseId: raw(COL.caseId),
      amazonOrderId: raw(COL.amazonOrderId),
      reason,
      sku,
      fnsku: raw(COL.fnsku),
      asin: raw(COL.asin),
      condition: raw(COL.condition),
      currency: raw(COL.currency),
      amountPerUnit: parseLocalizedAmount(raw(COL.amountPerUnit)),
      amountTotal,
      quantityReimbursedCash: intOrNull(raw(COL.qtyCash)),
      quantityReimbursedInventory: intOrNull(raw(COL.qtyInventory)),
      quantityReimbursedTotal: intOrNull(raw(COL.qtyTotal)),
      approvalDate: raw(COL.approvalDate),
      originalReimbursementId: raw(COL.originalId),
      originalReimbursementType: raw(COL.originalType),
      dedupeKey: reimbursementDedupeKey({ reimbursementId, sku, reason, amountTotal }),
    };

    currency = currency ?? line.currency;
    if (amountTotal !== null) totalAmount += amountTotal;
    parsed.push(line);
  }

  return {
    lines: parsed,
    totalAmount: Math.round(totalAmount * 100) / 100,
    currency,
    warnings,
  };
}

function intOrNull(raw: string | null): number | null {
  const n = parseLocalizedAmount(raw);
  return n === null ? null : Math.trunc(n);
}
