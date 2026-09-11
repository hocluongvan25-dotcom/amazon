/**
 * Parser report GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA (Tầng 3 — đối soát 2h sáng).
 * File chuẩn Amazon: tab-separated, dòng đầu là tên cột.
 * Cột & công thức theo tài liệu report types:
 *   afn-warehouse-quantity = afn-fulfillable-quantity + afn-unsellable-quantity + afn-reserved-quantity
 *   afn-total-quantity     = afn-warehouse-quantity + afn-inbound-working/shipped/receiving-quantity
 * Lưu ý đã ghi trong docs/phan-tich-ky-thuat-module-3-kho-van.md: một số kỳ
 * report có cột reserved rỗng → parser KHÔNG tự tin đè số, trả về warning.
 */
export type MyiRow = {
  sku: string;
  fnSku: string;
  asin: string;
  fulfillable: number;
  reserved: number;
  unsellable: number;
  warehouse: number;
  inboundWorking: number;
  inboundShipped: number;
  inboundReceiving: number;
  total: number;
};

export type MyiParseResult = {
  rows: MyiRow[];
  warnings: string[];
};

const COLS = {
  sku: "sku",
  fnSku: "fnsku",
  asin: "asin",
  fulfillable: "afn-fulfillable-quantity",
  reserved: "afn-reserved-quantity",
  unsellable: "afn-unsellable-quantity",
  warehouse: "afn-warehouse-quantity",
  inboundWorking: "afn-inbound-working-quantity",
  inboundShipped: "afn-inbound-shipped-quantity",
  inboundReceiving: "afn-inbound-receiving-quantity",
  total: "afn-total-quantity",
} as const;

function toNum(v: string | undefined): number {
  if (v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function parseMyiInventoryReport(text: string): MyiParseResult {
  const warnings: string[] = [];
  const lines = text.split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0);
  if (lines.length < 2) return { rows: [], warnings: ["Report rỗng"] };

  const header = lines[0].split("\t").map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);

  const required = [COLS.sku, COLS.fulfillable, COLS.total];
  for (const c of required) {
    if (idx(c) < 0) {
      warnings.push(`Thiếu cột bắt buộc: ${c}`);
      return { rows: [], warnings };
    }
  }

  const rows: MyiRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split("\t");
    const raw = (name: string) => (idx(name) >= 0 ? cells[idx(name)]?.trim() : undefined);

    const reservedRaw = raw(COLS.reserved);
    const row: MyiRow = {
      sku: raw(COLS.sku) ?? "",
      fnSku: raw(COLS.fnSku) ?? "",
      asin: raw(COLS.asin) ?? "",
      fulfillable: toNum(raw(COLS.fulfillable)),
      reserved: toNum(reservedRaw),
      unsellable: toNum(raw(COLS.unsellable)),
      warehouse: toNum(raw(COLS.warehouse)),
      inboundWorking: toNum(raw(COLS.inboundWorking)),
      inboundShipped: toNum(raw(COLS.inboundShipped)),
      inboundReceiving: toNum(raw(COLS.inboundReceiving)),
      total: toNum(raw(COLS.total)),
    };

    // Cảnh báo reserved rỗng (vấn đề đã ghi nhận thực tế) 
    if (reservedRaw === "") {
      warnings.push(
        `Dòng ${i + 1} (${row.sku}): cột afn-reserved-quantity rỗng — không dùng report này đè reserved, giữ số từ getInventorySummaries`,
      );
    }

    // Đối soát công thức chuẩn của Amazon
    const calcWarehouse =
      row.fulfillable + row.unsellable + row.reserved;
    if (row.warehouse !== 0 && calcWarehouse !== row.warehouse) {
      warnings.push(
        `Dòng ${i + 1} (${row.sku}): afn-warehouse-quantity=${row.warehouse} ≠ fulfillable+unsellable+reserved=${calcWarehouse}`,
      );
    }
    const calcTotal =
      row.warehouse + row.inboundWorking + row.inboundShipped + row.inboundReceiving;
    if (row.total !== 0 && calcTotal !== row.total) {
      warnings.push(
        `Dòng ${i + 1} (${row.sku}): afn-total-quantity=${row.total} ≠ warehouse+inbound=${calcTotal}`,
      );
    }

    rows.push(row);
  }

  return { rows, warnings };
}
