/**
 * Parser report INVENTORY LEDGER — Detailed View (`GET_LEDGER_DETAIL_VIEW_DATA`)
 * — nguồn phát hiện KHOẢN NGHI NGỜ bồi hoàn cho F3/SOP-09.
 *
 * Cột (kiểm chứng developer-docs.amazon.com/sp-api/docs/report-type-values-fba,
 * 12/09/2026 — "Inventory Ledger Report - Detailed View"):
 *   Date, FNSKU, ASIN, MSKU, Title, EventType, ReferenceID, Quantity,
 *   FulfillmentCenter, Disposition, Reason, Country, ReconciledQuantity,
 *   UnreconciledQuantity
 *
 * EventType nhận: Adjustments | CustomerReturns | Receipts | Shipments |
 * VendorReturns | WhseTransfers (theo reportOptions.eventType).
 * `Disposition` cho biết hàng còn bán được hay đã hỏng/mất; `Reason` là lý do gốc
 * Amazon trả về (chưa diễn giải ra nghiệp vụ VEXIM — việc đó ở domain).
 *
 * KHÔNG lấy cột PII nào (report này không có thông tin người mua).
 */

export type LedgerRow = {
  date: string | null;
  fnsku: string | null;
  asin: string | null;
  sku: string | null;
  eventType: string | null;
  referenceId: string | null;
  quantity: number | null;
  fulfillmentCenter: string | null;
  disposition: string | null;
  reason: string | null;
  country: string | null;
  reconciledQuantity: number | null;
  unreconciledQuantity: number | null;
};

export type LedgerParseResult = {
  rows: LedgerRow[];
  warnings: string[];
  /** Đếm theo EventType để log/kiểm chứng (worker in ra log khi chạy thật) */
  eventCounts: Record<string, number>;
};

const COL = {
  date: "date",
  fnsku: "fnsku",
  asin: "asin",
  sku: "msku",
  eventType: "eventtype",
  referenceId: "referenceid",
  quantity: "quantity",
  fc: "fulfillmentcenter",
  disposition: "disposition",
  reason: "reason",
  country: "country",
  reconciled: "reconciledquantity",
  unreconciled: "unreconciledquantity",
} as const;

const REQUIRED: readonly string[] = [COL.sku, COL.eventType, COL.quantity];

export function parseLedgerReport(text: string): LedgerParseResult {
  const warnings: string[] = [];
  const lines = (text ?? "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);

  if (lines.length < 2) return { rows: [], warnings: ["Report rỗng"], eventCounts: {} };

  const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, "");
  const header = lines[0].split("\t").map(norm);
  const idx = (name: string) => header.indexOf(norm(name));

  for (const c of REQUIRED) {
    if (idx(c) < 0) {
      warnings.push(`Thiếu cột bắt buộc: ${c}`);
      return { rows: [], warnings, eventCounts: {} };
    }
  }

  const rows: LedgerRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split("\t");
    const raw = (name: string): string | null => {
      const k = idx(name);
      if (k < 0) return null;
      const v = cells[k];
      return v === undefined || v.trim() === "" ? null : v.trim();
    };

    const sku = raw(COL.sku);
    const quantity = numberOrNull(raw(COL.quantity));
    if (!sku || quantity === null) {
      warnings.push(`Dòng ${i + 1}: thiếu ${COL.sku} hoặc ${COL.quantity} không phải số — bỏ qua`);
      continue;
    }

    rows.push({
      date: raw(COL.date),
      fnsku: raw(COL.fnsku),
      asin: raw(COL.asin),
      sku,
      eventType: raw(COL.eventType),
      referenceId: raw(COL.referenceId),
      quantity,
      fulfillmentCenter: raw(COL.fc),
      disposition: raw(COL.disposition),
      reason: raw(COL.reason),
      country: raw(COL.country),
      reconciledQuantity: numberOrNull(raw(COL.reconciled)),
      unreconciledQuantity: numberOrNull(raw(COL.unreconciled)),
    });
  }

  const eventCounts: Record<string, number> = {};
  for (const row of rows) {
    const key = row.eventType ?? "(trống)";
    eventCounts[key] = (eventCounts[key] ?? 0) + 1;
  }

  return { rows, warnings, eventCounts };
}

/** Số kiểu ledger: luôn là số nguyên dạng "12" / "-3" (không có định dạng local). */
function numberOrNull(raw: string | null): number | null {
  if (raw === null) return null;
  const s = raw.replace(/[^\d.,-]/g, "");
  if (s === "" || s === "-") return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}
