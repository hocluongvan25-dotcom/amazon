/**
 * Parser 2 report FBA inventory dùng cho Module 3 nâng cao (I2 / I4).
 *
 * (1) PHÂN BỔ TỒN THEO FC:
 *   Cũ (DEPRECATED 31/01/2023 → 400 InvalidInput):
 *     GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA
 *   Mới:
 *     GET_LEDGER_SUMMARY_VIEW_DATA + aggregateByLocation=FC + DAILY
 *   Cột cũ: snapshot-date, fnsku, sku, product-name, quantity, fulfillment-center-id, detailed-disposition, country
 *   Cột mới Ledger Summary: Date, FNSKU, MSKU, Title, Disposition, StartingWarehouseBalance, EndingWarehouseBalance, Location, Country
 *
 * (2) LỊCH SỬ NHẬN HÀNG:
 *   Cũ: GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA (deprecated → 400)
 *   Mới: GET_LEDGER_DETAIL_VIEW_DATA (filter EventType=Receipts)
 *   Cột cũ: received-date, fnsku, sku, product-name, quantity, fba-shipment-id, fulfillment-center-id
 *   Cột mới: Date, FNSKU, MSKU, Title, EventType, ReferenceID, Quantity, FulfillmentCenter, Disposition, Reason, Country
 *
 * FIX 400 09/2026:
 *   P1-US/P2-CA bị 400 InvalidInput "Report type is deprecated" → migrate sang ledger reports.
 *   Parser hỗ trợ CẢ 2 format (cũ và mới) để không gãy khi file cũ còn cache.
 *
 * NGUỒN CỘT: developer-docs.amazon.com/sp-api/docs/report-type-values-fba
 */

export type ReportSource = "report";

/** Một dòng phân bổ tồn theo FC (đã chuẩn hoá để ghi thẳng qua RPC 0018). */
export type FcAllocationRow = {
  /** YYYY-MM-DD — ngày Amazon chụp snapshot (cột snapshot-date hoặc Date) */
  snapshotDate: string;
  sku: string;
  fnsku: string | null;
  productName: string | null;
  quantity: number;
  /** Mã FC, đã upper() (report có thể viết 'ont8' / 'ONT8') */
  fulfillmentCenterId: string;
  /** Disposition đã upper(); rỗng = report không cho biết */
  detailedDisposition: string;
  country: string | null;
  source: ReportSource;
};

export type FcAllocationParseResult = {
  rows: FcAllocationRow[];
  warnings: string[];
  /** Dòng bị bỏ (không đủ khoá) — in ra log để không "xanh giả" */
  skipped: number;
  /** Tổng quantity theo FC của SNAPSHOT MỚI NHẤT trong file */
  fcTotals: Record<string, number>;
  /** Các ngày snapshot có trong file (đã sắp xếp, mới nhất ở cuối) */
  snapshotDates: string[];
};

/** Một dòng lịch sử nhận hàng. */
export type ReceiptRow = {
  /** YYYY-MM-DD — ngày Amazon hoàn tất nhận (cột received-date hoặc Date) */
  receivedDate: string;
  sku: string;
  fnsku: string | null;
  productName: string | null;
  quantity: number;
  /** Mã lô FBA (FBA15…), đã upper(); rỗng = report không gắn lô */
  fbaShipmentId: string;
  fulfillmentCenterId: string;
  source: ReportSource;
};

export type ReceiptsParseResult = {
  rows: ReceiptRow[];
  warnings: string[];
  skipped: number;
  /** Tổng số đơn vị thực nhận theo từng lô (bỏ dòng không có mã lô) */
  shipmentTotals: Record<string, number>;
  /** Ngày nhận sớm nhất / muộn nhất trong file — null nếu file rỗng */
  receivedFrom: string | null;
  receivedTo: string | null;
};

/** Giới hạn số cảnh báo in ra — file vài chục nghìn dòng không được làm ngập log. */
export const MAX_WARNINGS = 20;

const FC_COL = {
  snapshotDate: "snapshot-date",
  fnsku: "fnsku",
  sku: "sku",
  productName: "product-name",
  quantity: "quantity",
  fc: "fulfillment-center-id",
  disposition: "detailed-disposition",
  country: "country",
} as const;

const RX_COL = {
  receivedDate: "received-date",
  fnsku: "fnsku",
  sku: "sku",
  productName: "product-name",
  quantity: "quantity",
  shipmentId: "fba-shipment-id",
  fc: "fulfillment-center-id",
} as const;

// Ledger Summary View columns (new)
const LEDGER_SUMMARY_COL = {
  date: "date",
  fnsku: "fnsku",
  asin: "asin",
  msku: "msku",
  title: "title",
  disposition: "disposition",
  startingBalance: "startingwarehousebalance",
  endingBalance: "endingwarehousebalance",
  location: "location",
  country: "country",
  // fallback names
  countryAlt: "countryregion",
  skuAlt: "msku",
  fcAlt: "fulfillmentcenter",
} as const;

const LEDGER_DETAIL_COL = {
  date: "date",
  fnsku: "fnsku",
  msku: "msku",
  title: "title",
  eventType: "eventtype",
  referenceId: "referenceid",
  quantity: "quantity",
  fc: "fulfillmentcenter",
  disposition: "disposition",
  country: "country",
} as const;

const FC_REQUIRED: readonly string[] = [FC_COL.snapshotDate, FC_COL.sku, FC_COL.quantity];
const RX_REQUIRED: readonly string[] = [RX_COL.receivedDate, RX_COL.sku, RX_COL.quantity];
const LEDGER_SUMMARY_REQUIRED: readonly string[] = [LEDGER_SUMMARY_COL.date, LEDGER_SUMMARY_COL.endingBalance];
const LEDGER_DETAIL_REQUIRED: readonly string[] = [LEDGER_DETAIL_COL.date, LEDGER_DETAIL_COL.quantity];

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Ngày trong report FBA gặp 3 dạng:
 *   • ISO            2026-09-11 (đôi khi kèm giờ: 2026-09-11T00:00:00+00:00)
 *   • kiểu Mỹ        09/11/2026 (MM/DD/YYYY — Seller Central NA)
 *   • chữ            Sep 11, 2026
 * Trả về YYYY-MM-DD hoặc NULL nếu không đọc được.
 */
export function toIsoDate(raw: string | null): { iso: string | null; ambiguous: boolean } {
  if (!raw) return { iso: null, ambiguous: false };
  const s = raw.trim();
  if (s === "") return { iso: null, ambiguous: false };

  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    const m = Number(iso[2]);
    const d = Number(iso[3]);
    if (m < 1 || m > 12 || d < 1 || d > 31) return { iso: null, ambiguous: false };
    return { iso: `${iso[1]}-${pad2(m)}-${pad2(d)}`, ambiguous: false };
  }

  const slash = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (slash) {
    let m = Number(slash[1]);
    let d = Number(slash[2]);
    let ambiguous = true;
    if (m > 12 && d <= 12) {
      const t = m;
      m = d;
      d = t;
    }
    if (m < 1 || m > 12 || d < 1 || d > 31) return { iso: null, ambiguous };
    return { iso: `${slash[3]}-${pad2(m)}-${pad2(d)}`, ambiguous };
  }

  const word = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (word) {
    const m = MONTHS[word[1].slice(0, 3).toLowerCase()];
    const d = Number(word[2]);
    if (m && d >= 1 && d <= 31) return { iso: `${word[3]}-${pad2(m)}-${pad2(d)}`, ambiguous: false };
  }

  return { iso: null, ambiguous: false };
}

/** Số nguyên kiểu report tồn kho: "12" / "-3" (không có phần thập phân). */
export function intOrNull(raw: string | null): number | null {
  if (raw === null) return null;
  const s = raw.trim().replace(/,/g, "");
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export type TsvTable = { header: string[]; lines: string[][] };

/** Tách TSV + chuẩn hoá tên cột (bỏ BOM, khoảng trắng, gạch, hoa/thường). */
export function readTsv(text: string): TsvTable | null {
  const lines = (text ?? "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, "");
  const header = lines[0].split("\t").map(norm);
  return { header, lines: lines.slice(1).map((l) => l.split("\t")) };
}

export function columnIndex(header: string[], name: string): number {
  const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return header.indexOf(norm(name));
}

export function pushWarning(warnings: string[], skipped: number, msg: string): void {
  if (warnings.length < MAX_WARNINGS) warnings.push(msg);
  else if (warnings.length === MAX_WARNINGS) {
    warnings.push(`… còn ${skipped - MAX_WARNINGS}+ dòng lỗi khác (log chỉ in ${MAX_WARNINGS} cảnh báo đầu)`);
  }
}

/** Gom cảnh báo "ngày dạng MM/DD/YYYY" thành MỘT dòng (không spam theo từng dòng). */
function noteAmbiguousDate(warnings: string[], label: string, sample: string): void {
  const msg =
    `${label}: ngày dạng "${sample}" được hiểu theo MM/DD/YYYY (lịch Mỹ). ` +
    `Nếu report này xuất ở thị trường dùng DD/MM/YYYY thì ngày sẽ SAI — kiểm tra lại định dạng xuất file.`;
  if (!warnings.some((w) => w.startsWith(`${label}: ngày dạng`))) warnings.push(msg);
}

// ============================================================================
// (1) CŨ: GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA — phân bổ tồn theo FC
// ============================================================================
export function parseFcAllocationReport(text: string): FcAllocationParseResult {
  const warnings: string[] = [];
  const empty: FcAllocationParseResult = {
    rows: [],
    warnings,
    skipped: 0,
    fcTotals: {},
    snapshotDates: [],
  };

  const table = readTsv(text);
  if (!table) {
    warnings.push("Report phân bổ FC rỗng (không có dòng dữ liệu nào)");
    return empty;
  }

  const missing = FC_REQUIRED.filter((c) => columnIndex(table.header, c) < 0);
  if (missing.length > 0) {
    warnings.push(
      `Report phân bổ FC thiếu cột bắt buộc: ${missing.join(", ")} — ` +
        `đây có phải file GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA không?`,
    );
    return empty;
  }

  const at = (cells: string[], name: string): string | null => {
    const k = columnIndex(table.header, name);
    if (k < 0) return null;
    const v = cells[k];
    return v === undefined || v.trim() === "" ? null : v.trim();
  };

  const rows: FcAllocationRow[] = [];
  let skipped = 0;
  for (let i = 0; i < table.lines.length; i++) {
    const cells = table.lines[i];
    const lineNo = i + 2;

    const sku = at(cells, FC_COL.sku);
    const qty = intOrNull(at(cells, FC_COL.quantity));
    const dateRaw = at(cells, FC_COL.snapshotDate);
    const date = toIsoDate(dateRaw);

    if (!sku || qty === null || date.iso === null) {
      skipped++;
      pushWarning(
        warnings,
        skipped,
        `Dòng ${lineNo}: thiếu ${!sku ? "sku" : qty === null ? "quantity hợp lệ" : "snapshot-date hợp lệ"} — bỏ qua`,
      );
      continue;
    }
    if (date.ambiguous) noteAmbiguousDate(warnings, "Phân bổ FC", dateRaw ?? "");

    rows.push({
      snapshotDate: date.iso,
      sku,
      fnsku: at(cells, FC_COL.fnsku),
      productName: at(cells, FC_COL.productName),
      quantity: qty,
      fulfillmentCenterId: (at(cells, FC_COL.fc) ?? "").toUpperCase(),
      detailedDisposition: (at(cells, FC_COL.disposition) ?? "").toUpperCase(),
      country: at(cells, FC_COL.country)?.toUpperCase() ?? null,
      source: "report",
    });
  }

  const snapshotDates = Array.from(new Set(rows.map((r) => r.snapshotDate))).sort();
  const newest = snapshotDates[snapshotDates.length - 1];
  const fcTotals: Record<string, number> = {};
  for (const r of rows) {
    if (newest && r.snapshotDate !== newest) continue;
    const key = r.fulfillmentCenterId === "" ? "(không rõ FC)" : r.fulfillmentCenterId;
    fcTotals[key] = (fcTotals[key] ?? 0) + r.quantity;
  }

  return { rows, warnings, skipped, fcTotals, snapshotDates };
}

// ============================================================================
// (1b) MỚI: GET_LEDGER_SUMMARY_VIEW_DATA FC/DAILY → FcAllocationRow
// ============================================================================
export function parseLedgerSummaryAsFc(text: string): FcAllocationParseResult {
  const warnings: string[] = [];
  const empty: FcAllocationParseResult = {
    rows: [],
    warnings,
    skipped: 0,
    fcTotals: {},
    snapshotDates: [],
  };

  const table = readTsv(text);
  if (!table) {
    warnings.push("Ledger Summary FC rỗng (không có dòng dữ liệu nào)");
    return empty;
  }

  // Kiểm tra cột bắt buộc của ledger summary
  const hasDate = columnIndex(table.header, LEDGER_SUMMARY_COL.date) >= 0;
  const hasEnding = columnIndex(table.header, LEDGER_SUMMARY_COL.endingBalance) >= 0;
  if (!hasDate || !hasEnding) {
    const missing = [];
    if (!hasDate) missing.push(LEDGER_SUMMARY_COL.date);
    if (!hasEnding) missing.push(LEDGER_SUMMARY_COL.endingBalance);
    warnings.push(
      `Ledger Summary FC thiếu cột bắt buộc: ${missing.join(", ")} — ` +
        `đây có phải file GET_LEDGER_SUMMARY_VIEW_DATA (FC/DAILY) không? Header: ${table.header.join(", ")}`,
    );
    return empty;
  }

  const at = (cells: string[], name: string): string | null => {
    const k = columnIndex(table.header, name);
    if (k < 0) return null;
    const v = cells[k];
    return v === undefined || v.trim() === "" ? null : v.trim();
  };

  // Helper lấy cột với nhiều tên thay thế
  const atAny = (cells: string[], names: string[]): string | null => {
    for (const n of names) {
      const v = at(cells, n);
      if (v !== null) return v;
    }
    return null;
  };

  const rows: FcAllocationRow[] = [];
  let skipped = 0;
  for (let i = 0; i < table.lines.length; i++) {
    const cells = table.lines[i];
    const lineNo = i + 2;

    // MSKU là SKU chính trong ledger, fallback sku nếu có
    const sku = atAny(cells, [LEDGER_SUMMARY_COL.msku, LEDGER_SUMMARY_COL.skuAlt, FC_COL.sku, "sku"]);
    const qtyRaw = at(cells, LEDGER_SUMMARY_COL.endingBalance);
    const qty = intOrNull(qtyRaw);
    const dateRaw = at(cells, LEDGER_SUMMARY_COL.date);
    const date = toIsoDate(dateRaw);

    // Ledger summary có thể có nhiều dòng với quantity 0 → vẫn giữ, nhưng thiếu sku/date/qty thì bỏ
    if (!sku || qty === null || date.iso === null) {
      skipped++;
      pushWarning(
        warnings,
        skipped,
        `Dòng ${lineNo}: thiếu ${!sku ? "MSKU/sku" : qty === null ? "EndingWarehouseBalance" : "Date"} — bỏ qua`,
      );
      continue;
    }
    if (date.ambiguous) noteAmbiguousDate(warnings, "Ledger Summary FC", dateRaw ?? "");

    // Nếu quantity = 0 thì vẫn giữ để biết FC có SKU nhưng hết tồn? Quyết định giữ, RPC sẽ upsert 0
    // Nhưng nếu muốn giảm rác, có thể bỏ 0. Hiện tại giữ để I2 hiển thị đúng.

    const fnsku = atAny(cells, [LEDGER_SUMMARY_COL.fnsku, FC_COL.fnsku]);
    const productName = atAny(cells, [LEDGER_SUMMARY_COL.title, FC_COL.productName, "productname", "title"]);
    const fcRaw = atAny(cells, [LEDGER_SUMMARY_COL.location, LEDGER_SUMMARY_COL.fcAlt, FC_COL.fc, "fulfillmentcenterid"]);
    const dispositionRaw = atAny(cells, [LEDGER_SUMMARY_COL.disposition, FC_COL.disposition, "detaileddisposition"]);
    const countryRaw = atAny(cells, [LEDGER_SUMMARY_COL.country, LEDGER_SUMMARY_COL.countryAlt, FC_COL.country]);

    rows.push({
      snapshotDate: date.iso,
      sku,
      fnsku,
      productName,
      quantity: qty,
      fulfillmentCenterId: (fcRaw ?? "").toUpperCase(),
      detailedDisposition: (dispositionRaw ?? "").toUpperCase(),
      country: countryRaw?.toUpperCase() ?? null,
      source: "report",
    });
  }

  const snapshotDates = Array.from(new Set(rows.map((r) => r.snapshotDate))).sort();
  const newest = snapshotDates[snapshotDates.length - 1];
  const fcTotals: Record<string, number> = {};
  for (const r of rows) {
    if (newest && r.snapshotDate !== newest) continue;
    const key = r.fulfillmentCenterId === "" ? "(không rõ FC)" : r.fulfillmentCenterId;
    fcTotals[key] = (fcTotals[key] ?? 0) + r.quantity;
  }

  if (rows.length === 0 && skipped === 0) {
    warnings.push("Ledger Summary FC: không có dòng nào sau khi parse — kiểm tra report có rỗng hay filter sai?");
  }

  return { rows, warnings, skipped, fcTotals, snapshotDates };
}

// ============================================================================
// (2) CŨ: GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA — lịch sử nhận hàng
// ============================================================================
export function parseReceiptsReport(text: string): ReceiptsParseResult {
  const warnings: string[] = [];
  const empty: ReceiptsParseResult = {
    rows: [],
    warnings,
    skipped: 0,
    shipmentTotals: {},
    receivedFrom: null,
    receivedTo: null,
  };

  const table = readTsv(text);
  if (!table) {
    warnings.push("Report lịch sử nhận hàng rỗng (không có dòng dữ liệu nào)");
    return empty;
  }

  const missing = RX_REQUIRED.filter((c) => columnIndex(table.header, c) < 0);
  if (missing.length > 0) {
    warnings.push(
      `Report lịch sử nhận hàng thiếu cột bắt buộc: ${missing.join(", ")} — ` +
        `đây có phải file GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA không?`,
    );
    return empty;
  }

  const at = (cells: string[], name: string): string | null => {
    const k = columnIndex(table.header, name);
    if (k < 0) return null;
    const v = cells[k];
    return v === undefined || v.trim() === "" ? null : v.trim();
  };

  const rows: ReceiptRow[] = [];
  let skipped = 0;
  for (let i = 0; i < table.lines.length; i++) {
    const cells = table.lines[i];
    const lineNo = i + 2;

    const sku = at(cells, RX_COL.sku);
    const qty = intOrNull(at(cells, RX_COL.quantity));
    const dateRaw = at(cells, RX_COL.receivedDate);
    const date = toIsoDate(dateRaw);

    if (!sku || qty === null || date.iso === null) {
      skipped++;
      pushWarning(
        warnings,
        skipped,
        `Dòng ${lineNo}: thiếu ${!sku ? "sku" : qty === null ? "quantity hợp lệ" : "received-date hợp lệ"} — bỏ qua`,
      );
      continue;
    }
    if (date.ambiguous) noteAmbiguousDate(warnings, "Lịch sử nhận hàng", dateRaw ?? "");

    rows.push({
      receivedDate: date.iso,
      sku,
      fnsku: at(cells, RX_COL.fnsku),
      productName: at(cells, RX_COL.productName),
      quantity: qty,
      fbaShipmentId: (at(cells, RX_COL.shipmentId) ?? "").toUpperCase(),
      fulfillmentCenterId: (at(cells, RX_COL.fc) ?? "").toUpperCase(),
      source: "report",
    });
  }

  const shipmentTotals: Record<string, number> = {};
  for (const r of rows) {
    if (r.fbaShipmentId === "") continue;
    shipmentTotals[r.fbaShipmentId] = (shipmentTotals[r.fbaShipmentId] ?? 0) + r.quantity;
  }
  const dates = rows.map((r) => r.receivedDate).sort();

  return {
    rows,
    warnings,
    skipped,
    shipmentTotals,
    receivedFrom: dates[0] ?? null,
    receivedTo: dates[dates.length - 1] ?? null,
  };
}

// ============================================================================
// (2b) MỚI: GET_LEDGER_DETAIL_VIEW_DATA (EventType=Receipts) → ReceiptRow
// ============================================================================
export function parseLedgerDetailAsReceipts(text: string): ReceiptsParseResult {
  const warnings: string[] = [];
  const empty: ReceiptsParseResult = {
    rows: [],
    warnings,
    skipped: 0,
    shipmentTotals: {},
    receivedFrom: null,
    receivedTo: null,
  };

  const table = readTsv(text);
  if (!table) {
    warnings.push("Ledger Detail Receipts rỗng (không có dòng dữ liệu nào)");
    return empty;
  }

  const hasDate = columnIndex(table.header, LEDGER_DETAIL_COL.date) >= 0;
  const hasQty = columnIndex(table.header, LEDGER_DETAIL_COL.quantity) >= 0;
  const hasEvent = columnIndex(table.header, LEDGER_DETAIL_COL.eventType) >= 0;
  if (!hasDate || !hasQty) {
    warnings.push(
      `Ledger Detail thiếu cột bắt buộc: ${[!hasDate && LEDGER_DETAIL_COL.date, !hasQty && LEDGER_DETAIL_COL.quantity].filter(Boolean).join(", ")} — Header: ${table.header.join(", ")}`,
    );
    return empty;
  }

  const at = (cells: string[], name: string): string | null => {
    const k = columnIndex(table.header, name);
    if (k < 0) return null;
    const v = cells[k];
    return v === undefined || v.trim() === "" ? null : v.trim();
  };

  const atAny = (cells: string[], names: string[]): string | null => {
    for (const n of names) {
      const v = at(cells, n);
      if (v !== null) return v;
    }
    return null;
  };

  const rows: ReceiptRow[] = [];
  let skipped = 0;
  let filteredNonReceipts = 0;

  for (let i = 0; i < table.lines.length; i++) {
    const cells = table.lines[i];
    const lineNo = i + 2;

    // Filter EventType = Receipts nếu có cột eventType
    if (hasEvent) {
      const eventType = at(cells, LEDGER_DETAIL_COL.eventType);
      if (eventType && eventType.toLowerCase() !== "receipts" && eventType.toLowerCase() !== "receipt") {
        filteredNonReceipts++;
        continue;
      }
    }

    const sku = atAny(cells, [LEDGER_DETAIL_COL.msku, "msku", "sku", RX_COL.sku]);
    const qtyRaw = at(cells, LEDGER_DETAIL_COL.quantity);
    const qty = intOrNull(qtyRaw);
    const dateRaw = at(cells, LEDGER_DETAIL_COL.date);
    const date = toIsoDate(dateRaw);

    if (!sku || qty === null || date.iso === null) {
      skipped++;
      pushWarning(
        warnings,
        skipped,
        `Dòng ${lineNo}: thiếu ${!sku ? "MSKU/sku" : qty === null ? "Quantity" : "Date"} — bỏ qua`,
      );
      continue;
    }
    if (date.ambiguous) noteAmbiguousDate(warnings, "Ledger Detail Receipts", dateRaw ?? "");

    const fnsku = atAny(cells, [LEDGER_DETAIL_COL.fnsku, FC_COL.fnsku, "fnsku"]);
    const productName = atAny(cells, [LEDGER_DETAIL_COL.title, "title", "productname"]);
    const shipmentId = atAny(cells, [LEDGER_DETAIL_COL.referenceId, "referenceid", RX_COL.shipmentId, "fbashipmentid"]);
    const fc = atAny(cells, [LEDGER_DETAIL_COL.fc, "fulfillmentcenter", FC_COL.fc, "fulfillmentcenterid"]);

    rows.push({
      receivedDate: date.iso,
      sku,
      fnsku,
      productName,
      quantity: qty,
      fbaShipmentId: (shipmentId ?? "").toUpperCase(),
      fulfillmentCenterId: (fc ?? "").toUpperCase(),
      source: "report",
    });
  }

  if (filteredNonReceipts > 0) {
    warnings.push(`Ledger Detail: đã lọc ${filteredNonReceipts} dòng không phải Receipts (giữ lại ${rows.length} dòng Receipts)`);
  }

  const shipmentTotals: Record<string, number> = {};
  for (const r of rows) {
    if (r.fbaShipmentId === "") continue;
    shipmentTotals[r.fbaShipmentId] = (shipmentTotals[r.fbaShipmentId] ?? 0) + r.quantity;
  }
  const dates = rows.map((r) => r.receivedDate).sort();

  return {
    rows,
    warnings,
    skipped,
    shipmentTotals,
    receivedFrom: dates[0] ?? null,
    receivedTo: dates[dates.length - 1] ?? null,
  };
}
