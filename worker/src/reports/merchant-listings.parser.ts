/**
 * Parser report Listing (Tầng 3 — đối soát + nạp danh sách hằng ngày 2h sáng).
 *
 * GET_MERCHANT_LISTINGS_ALL_DATA / GET_MERCHANT_LISTINGS_INACTIVE_DATA:
 *   TSV chuẩn Amazon — header thật (2024) có các cột lẫn cả chỗ "Deprecated column"
 *   không dùng; parser đánh chỉ mục THEO TÊN nên không phụ thuộc vị trí cột.
 *   Cột dùng: item-name, seller-sku, asin1, price, quantity, item-condition,
 *             fulfilment-channel (chính tả Anh của Amazon), status.
 *   status: "Active" | "Active [*]" (có vấn đề tiềm ẩn — biến thể bị ẩn) |
 *           "Inactive" | "Closed" | "Deleted"…
 *
 * GET_STRANDED_INVENTORY_UI_DATA:
 *   Cột: title/sku/asin/fnsku + "stranded reason" + quantity (tên cột có thể
 *   khác nhau giữa kỳ report → dùng danh sách tên ứng viên, phòng thủ).
 */
import type { ListingLifecycleStatus } from "../db/adapter.ts";

export type MerchantListingRow = {
  sku: string;
  asin: string | null;
  itemName: string | null;
  price: string | null;
  quantity: number;
  condition: string | null;
  fulfilmentChannel: string | null;
  statusRaw: string;
  status: ListingLifecycleStatus | null; // null = Closed/Unknown → không ghi đè
};

export type StrandedInventoryRow = {
  sku: string;
  asin: string | null;
  fnSku: string | null;
  itemName: string | null;
  strandedReason: string;
  quantity: number;
};

export type ParseResult<T> = { rows: T[]; warnings: string[] };

function splitTsv(text: string): string[][] {
  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .map((l) => l.split("\t"));
}

/** Tìm chỉ mục cột theo danh sách tên ứng viên (đã lower + trim) */
function colIndex(header: string[], candidates: string[]): number {
  for (const c of candidates) {
    const i = header.indexOf(c);
    if (i >= 0) return i;
  }
  return -1;
}

function num(v: string | undefined): number {
  if (!v) return 0;
  const n = Number(v.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** "Active" → ACTIVE · "Active [*]" → SUPPRESSED · "Inactive" → INACTIVE · khác → null */
export function normalizeMerchantStatus(raw: string): ListingLifecycleStatus | null {
  const s = raw.trim();
  if (s === "Active") return "ACTIVE";
  if (s.startsWith("Active")) return "SUPPRESSED"; // Active [*] — có vấn đề tiềm ẩn
  if (s === "Inactive") return "INACTIVE";
  return null; // Closed / Deleted / Unknown — không ghi đè trạng thái đang có
}

export function parseMerchantListingsReport(text: string): ParseResult<MerchantListingRow> {
  const warnings: string[] = [];
  const lines = splitTsv(text);
  if (lines.length < 2) return { rows: [], warnings: ["Report rỗng"] };

  const header = lines[0].map((h) => h.trim().toLowerCase());
  const idx = {
    sku: colIndex(header, ["seller-sku", "sku"]),
    asin: colIndex(header, ["asin1", "asin"]),
    name: colIndex(header, ["item-name", "title"]),
    price: colIndex(header, ["price"]),
    qty: colIndex(header, ["quantity"]),
    cond: colIndex(header, ["item-condition"]),
    channel: colIndex(header, ["fulfilment-channel", "fulfillment-channel"]),
    status: colIndex(header, ["status"]),
  };
  if (idx.sku < 0 || idx.status < 0) {
    warnings.push("Thiếu cột bắt buộc: seller-sku / status");
    return { rows: [], warnings };
  }

  const rows: MerchantListingRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i];
    const cell = (i2: number) => (i2 >= 0 ? (c[i2] ?? "").trim() : "");
    const sku = cell(idx.sku);
    if (!sku) {
      warnings.push(`Dòng ${i + 1}: thiếu seller-sku — bỏ qua`);
      continue;
    }
    const statusRaw = cell(idx.status);
    rows.push({
      sku,
      asin: cell(idx.asin) || null,
      itemName: cell(idx.name) || null,
      price: cell(idx.price) || null,
      quantity: num(cell(idx.qty)),
      condition: cell(idx.cond) || null,
      fulfilmentChannel: cell(idx.channel) || null,
      statusRaw,
      status: normalizeMerchantStatus(statusRaw),
    });
  }
  return { rows, warnings };
}

export function parseStrandedInventoryReport(text: string): ParseResult<StrandedInventoryRow> {
  const warnings: string[] = [];
  const lines = splitTsv(text);
  if (lines.length < 2) return { rows: [], warnings: ["Report rỗng"] };

  const header = lines[0].map((h) => h.trim().toLowerCase());
  const idx = {
    sku: colIndex(header, ["sku", "seller-sku"]),
    asin: colIndex(header, ["asin", "asin1"]),
    fnSku: colIndex(header, ["fnsku"]),
    title: colIndex(header, ["title", "item-name"]),
    reason: colIndex(header, ["stranded reason", "stranded-reason", "reason"]),
    qty: colIndex(header, ["quantity", "quantity available"]),
  };
  if (idx.sku < 0 || idx.reason < 0) {
    warnings.push("Thiếu cột bắt buộc: sku / stranded reason");
    return { rows: [], warnings };
  }

  const rows: StrandedInventoryRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i];
    const cell = (i2: number) => (i2 >= 0 ? (c[i2] ?? "").trim() : "");
    const sku = cell(idx.sku);
    if (!sku) continue;
    rows.push({
      sku,
      asin: cell(idx.asin) || null,
      fnSku: cell(idx.fnSku) || null,
      itemName: cell(idx.title) || null,
      strandedReason: cell(idx.reason),
      quantity: num(cell(idx.qty)),
    });
  }
  return { rows, warnings };
}
