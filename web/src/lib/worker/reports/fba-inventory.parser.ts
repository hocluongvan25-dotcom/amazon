/**
 * Parser 2 report FBA inventory dùng cho Module 3 nâng cao (I2 / I4).
 *
 * ┌ (1) FBA Daily Inventory History Report — PHÂN BỔ TỒN THEO FC
 * │   reportType : GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA
 * │   Cột (đúng tên của Amazon):
 * │     snapshot-date · fnsku · sku · product-name · quantity ·
 * │     fulfillment-center-id · detailed-disposition · country
 * │   Mỗi ngày một snapshot; một SKU có thể nằm ở NHIỀU FC và mỗi FC có thể có
 * │   nhiều dòng theo disposition (Sellable / Unsellable / Damaged / …).
 * │
 * └ (2) FBA Received Inventory Report — LỊCH SỬ NHẬN HÀNG
 *     reportType : GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA
 *     Cột: received-date · fnsku · sku · product-name · quantity ·
 *          fba-shipment-id · fulfillment-center-id
 *     Chỉ chứa các lần nhận ĐÃ HOÀN TẤT tại FC, nội dung cập nhật mỗi ngày.
 *
 * NGUỒN CỘT: developer-docs.amazon.com/sp-api/docs/report-type-values-fba
 * (mục "FBA Inventory Reports"). Cả hai KHÔNG có PII người mua → không cần
 * Restricted Data Token; role cần có là "Amazon Fulfillment".
 *
 * HAI ĐIỀU API KHÔNG CHO BIẾT (lý do phải đi đường report):
 *   • getFulfillmentInventory / listInventorySummaries chỉ trả TỔNG theo SKU,
 *     không tách theo FC → I2 không có "hàng đang nằm ở đâu".
 *   • Inbound API chỉ mô tả lô ĐANG mở; lô đã CLOSED thì không còn số nhận chi
 *     tiết → không có "lịch sử nhận hàng" nếu không giữ report lại.
 *
 * NGUYÊN TẮC PARSE (giống inventory-ledger.parser.ts / merchant-listings.parser.ts):
 *   1. Header đọc theo TÊN, đã chuẩn hoá (bỏ khoảng trắng, gạch, hoa/thường) →
 *      Amazon đổi thứ tự cột vẫn chạy.
 *   2. Thiếu cột BẮT BUỘC → trả rỗng + cảnh báo nói rõ thiếu cột nào. KHÔNG đoán
 *      cột theo vị trí (đoán sai là âm thầm ghi nhầm số tồn).
 *   3. Dòng không đọc được (thiếu SKU / ngày sai định dạng / quantity không phải
 *      số nguyên) → BỎ QUA + cảnh báo + đếm vào `skipped`; không làm hỏng cả file.
 *   4. Ngày trả về dạng YYYY-MM-DD vì RPC 0018 chỉ nhận đúng định dạng đó.
 *      Không đọc được → null (dòng bị bỏ), KHÔNG suy ra "hôm nay".
 *   5. Trùng khoá trong cùng file vẫn được GIỮ ở tầng parse (job/RPC mới cộng
 *      dồn) — parser không tự ý gộp, để log còn nói được "file có dòng trùng".
 */

export type ReportSource = "report";

/** Một dòng phân bổ tồn theo FC (đã chuẩn hoá để ghi thẳng qua RPC 0018). */
export type FcAllocationRow = {
  /** YYYY-MM-DD — ngày Amazon chụp snapshot (cột snapshot-date) */
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
  /** YYYY-MM-DD — ngày Amazon hoàn tất nhận (cột received-date) */
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

const FC_REQUIRED: readonly string[] = [FC_COL.snapshotDate, FC_COL.sku, FC_COL.quantity];
const RX_REQUIRED: readonly string[] = [RX_COL.receivedDate, RX_COL.sku, RX_COL.quantity];

/**
 * `readTsv` / `columnIndex` / `pushWarning` được EXPORT để parser phí (0019)
 * dùng chung: report phí lưu kho đặt tên cột bằng GẠCH DƯỚI
 * (`estimated_monthly_storage_fee`) trong khi report tồn kho dùng GẠCH NỐI
 * (`snapshot-date`). columnIndex() đã bỏ cả hai loại dấu nên một bảng ánh xạ
 * dùng được cho cả hai kiểu file — không nhân đôi code.
 */
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
 *
 * Với dạng số có gạch chéo: mặc định hiểu MM/DD/YYYY (thị trường NA của VEXIM),
 * nhưng nếu vị trí đầu > 12 thì rõ ràng là DD/MM → đảo lại. Cả hai trường hợp
 * đều được báo về để tầng trên ghi cảnh báo một lần (không âm thầm đoán).
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
    let ambiguous = true; // MM/DD hay DD/MM — phải nói ra, không im lặng
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
// (1) GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA — phân bổ tồn theo FC
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
    const lineNo = i + 2; // +1 header, +1 vì index 0-based

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
      // FC rỗng → '' (khoá của RPC 0018); UI sẽ hiện "không rõ FC" chứ không bịa.
      fulfillmentCenterId: (at(cells, FC_COL.fc) ?? "").toUpperCase(),
      detailedDisposition: (at(cells, FC_COL.disposition) ?? "").toUpperCase(),
      country: at(cells, FC_COL.country)?.toUpperCase() ?? null,
      source: "report",
    });
  }

  // Chỉ thống kê SNAPSHOT MỚI NHẤT: cộng cả các ngày cũ vào một con số là vô nghĩa
  // (cùng 100 đơn vị của hôm qua và hôm nay sẽ thành 200).
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
// (2) GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA — lịch sử nhận hàng
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
    if (r.fbaShipmentId === "") continue; // không gắn lô → không đối soát theo lô được
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
