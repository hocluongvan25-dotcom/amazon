/**
 * Data model cho Module 3 (Kho vận & FBA) — đọc từ Supabase public views.
 * View: vexim_inventory_latest, vexim_inbound_shipments (0011/0017) +
 *       vexim_inventory_fc, vexim_inventory_receipts,
 *       vexim_inbound_receipt_shipments (0018 — phân bổ FC + lịch sử nhận hàng)
 *
 * Ánh xạ cột DB → UI type, tính chỉ số velocity/cover/suggest từ domain logic.
 * Tuân thủ đúng công thức docs/phan-tich-ky-thuat-module-3-kho-van.md mục 2.
 *
 * Từ migration 0017 view trả THÊM giá vốn hiệu lực + GIÁ TRỊ TỒN KHO:
 *   stock_value       = fulfillable × unit_cost
 *   total_stock_value = (fulfillable + reserved + inbound) × unit_cost
 * Đơn vị tiền = TIỀN CỦA GIÁ VỐN (value_currency), KHÔNG tự quy đổi sang tiền bán:
 * VEXIM nhập hàng bằng VND và bán bằng USD — quy đổi ở tầng web là đoán tỷ giá.
 * Thiếu giá vốn → NULL + value_basis = 'missing' (I1/I3 hiện "—", không hiện 0 giả).
 */

import type {
  FcAllocationRow,
  InventoryRow,
  InboundRow,
  InventoryValueBasis,
  ReceiptRow,
  ReceiptShipmentRow,
  RestockRow,
} from "@/lib/types";
// Import TƯƠNG ĐỐI + đuôi .ts (như cost-model.ts): model này được test bằng
// `node --experimental-strip-types`, mà runner không hiểu alias `@/`.
import { COVER_ALERT_THRESHOLD } from "../worker/domain/inventory-metrics.ts";

/* ------------------------------------------------------------------ */
/* Raw shape từ Supabase view                                         */
/* ------------------------------------------------------------------ */

/** vexim_inventory_latest — mỗi (seller_account_id, sku) 1 dòng mới nhất */
export type InventoryLatestRaw = {
  seller_account_id: string;
  shop: string;
  sku: string;
  asin: string | null;
  fulfillable: number;
  reserved: number;
  inbound: number;
  captured_at: string;
  day: string | null;
  days_of_cover: number | null;
  velocity: number | null;
  suggest_restock: number | null;
  in_stock: boolean | null;
  /* ↓ migration 0017 — giá vốn hiệu lực + giá trị tồn (nối CUỐI view) */
  unit_cost?: number | null;
  cost_currency?: string | null;
  cost_effective_from?: string | null;
  cost_source?: string | null;
  stock_value?: number | null;
  total_stock_value?: number | null;
  value_currency?: string | null;
  value_basis?: string | null;
};

/** vexim_inbound_shipments */
export type InboundShipmentRaw = {
  id: string;
  seller_account_id: string;
  shop: string;
  shipment_id: string;
  status: string | null;
  quantity: number | null;
  eta_date: string | null;
  created_at: string;
};

/* ------------------------------------------------------------------ */
/* Select strings cho PostgREST                                        */
/* ------------------------------------------------------------------ */

/** 8 cột 0017 nối CUỐI vexim_inventory_latest — harness BƯỚC 18 soát đúng thứ tự. */
export const INVENTORY_VALUE_COLUMNS = [
  "unit_cost",
  "cost_currency",
  "cost_effective_from",
  "cost_source",
  "stock_value",
  "total_stock_value",
  "value_currency",
  "value_basis",
] as const;

/**
 * PostgREST select theo TÊN: thiếu/sai 1 cột là PGRST204 và SẬP CẢ TRANG I1/I3.
 */
export const INVENTORY_SELECT =
  "seller_account_id,shop,sku,asin,fulfillable,reserved,inbound,captured_at,day,days_of_cover,velocity,suggest_restock,in_stock," +
  INVENTORY_VALUE_COLUMNS.join(",");

export const INBOUND_SELECT =
  "id,seller_account_id,shop,shipment_id,status,quantity,eta_date,created_at";

/* ------------------------------------------------------------------ */
/* Mapping: raw → UI types                                            */
/* ------------------------------------------------------------------ */

/** Xác định trạng thái tồn kho */
export function inventoryStatus(
  fulfillable: number,
  coverDays: number | null,
  velocity: number | null,
): InventoryRow["status"] {
  if (fulfillable === 0) return "out";
  if (coverDays !== null && coverDays < COVER_ALERT_THRESHOLD) return "low";
  // Tồn lâu: cover > 365 và velocity rất thấp → aged
  if (coverDays !== null && coverDays > 365 && velocity !== null && velocity < 2)
    return "aged";
  return "ok";
}

function statusLabel(status: InventoryRow["status"]): string {
  switch (status) {
    case "out":
      return "Hết hàng — chờ lô về";
    case "low":
      return "Sắp hết (cover 7–14)";
    case "ok":
      return "Đủ hàng";
    case "aged":
      return "Tồn lâu >365 ngày";
  }
}

/** Map 1 dòng vexim_inventory_latest → InventoryRow cho UI */
export function mapInventoryRow(raw: InventoryLatestRaw): InventoryRow {
  // Worker tính velocity (loại 2 ngày đỉnh) và lưu ở inventory_daily
  const velocity = raw.velocity ?? 0;

  // days_of_cover: worker tính hoặc suy từ fulfillable / velocity
  const coverDays =
    raw.days_of_cover !== null && raw.days_of_cover !== undefined
      ? Math.floor(raw.days_of_cover)
      : velocity > 0
        ? Math.floor(raw.fulfillable / velocity)
        : null;

  // suggest_restock: worker đã tính theo SOP-01
  // Nếu worker chưa ghi (null), tính lại từ domain logic khi đủ dữ liệu
  const suggest = raw.suggest_restock ?? null;

  const status = inventoryStatus(raw.fulfillable, coverDays, velocity);

  // Giá vốn + giá trị tồn (0017): DB đã tính, ở đây chỉ chuẩn hoá NULL/nhãn.
  // Nhãn suy từ CHÍNH con số (có giá vốn hay không) — không tin nhãn nếu cột thiếu.
  const unitCost = raw.unit_cost ?? null;
  const valueBasis: InventoryValueBasis = unitCost !== null ? "cost" : "missing";

  return {
    sku: raw.sku,
    asin: raw.asin ?? "—",
    shop: raw.shop,
    fulfillable: raw.fulfillable,
    reserved: raw.reserved,
    inbound: raw.inbound,
    velocity,
    coverDays,
    suggest,
    agedDays: status === "aged" && coverDays !== null ? coverDays : null,
    status,
    statusLabel: statusLabel(status),
    unitCost,
    costCurrency: raw.cost_currency ?? null,
    costEffectiveFrom: raw.cost_effective_from ?? null,
    costSource: raw.cost_source ?? null,
    stockValue: raw.stock_value ?? null,
    totalStockValue: raw.total_stock_value ?? null,
    valueCurrency: raw.value_currency ?? null,
    valueBasis,
  };
}

/* ------------------------------------------------------------------ */
/* Giá trị tồn kho (0017)                                              */
/* ------------------------------------------------------------------ */

/**
 * Định dạng tiền theo TIỀN TỆ CỦA GIÁ VỐN. VND không lấy 2 số lẻ (không ai nói
 * "1.234.567,89 ₫"); thiếu tiền tệ thì in số trần chứ không bịa ký hiệu.
 */
export function formatStockValue(amount: number | null, currency: string | null): string {
  if (amount === null) return "—";
  const digits = currency === "VND" ? 0 : 2;
  const n = amount.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  if (currency === null) return n;
  if (currency === "USD") return `$${n}`;
  if (currency === "VND") return `${n} ₫`;
  return `${n} ${currency}`;
}

export type InventoryValueSummary = {
  /** Tổng (fulfillable + reserved + inbound) × giá vốn, theo từng tiền tệ. */
  byCurrency: { currency: string; total: number }[];
  /** Số SKU định giá được / tổng số SKU. */
  valued: number;
  /** SKU còn tồn mà CHƯA có giá vốn → con số tổng chưa đủ, phải nói rõ. */
  missingCost: number;
  total: number;
};

/**
 * Cộng giá trị tồn theo TỪNG TIỀN TỆ — không bao giờ cộng VND với USD.
 * `total` chỉ có nghĩa khi tất cả cùng một tiền tệ (byCurrency.length === 1).
 */
export function summarizeInventoryValue(rows: InventoryRow[]): InventoryValueSummary {
  const totals = new Map<string, number>();
  let valued = 0;
  let missingCost = 0;

  for (const r of rows) {
    if (r.totalStockValue === null) {
      // Chỉ đếm là "thiếu giá vốn" khi THẬT SỰ còn tồn để định giá
      if (r.fulfillable + r.reserved + r.inbound > 0) missingCost += 1;
      continue;
    }
    valued += 1;
    const key = r.valueCurrency ?? "?";
    totals.set(key, (totals.get(key) ?? 0) + r.totalStockValue);
  }

  const byCurrency = [...totals.entries()]
    .map(([currency, total]) => ({ currency, total: Math.round(total * 100) / 100 }))
    .sort((a, b) => b.total - a.total);

  return {
    byCurrency,
    valued,
    missingCost,
    total: byCurrency.length === 1 ? byCurrency[0].total : 0,
  };
}

/** Chuỗi tiền cho KPI: 1 tiền tệ → số tiền; nhiều tiền tệ → liệt kê, không cộng bừa. */
export function formatInventoryValueTotal(sum: InventoryValueSummary): string {
  if (sum.byCurrency.length === 0) return "—";
  if (sum.byCurrency.length === 1) {
    return formatStockValue(sum.byCurrency[0].total, sum.byCurrency[0].currency);
  }
  return sum.byCurrency
    .map((c) => formatStockValue(c.total, c.currency))
    .join(" + ");
}

/** Giá vốn của một SKU: "— · chưa nhập" để I1/I3 nói thẳng việc cần làm. */
export function formatUnitCost(r: InventoryRow): string {
  if (r.unitCost === null) return "—";
  return formatStockValue(r.unitCost, r.costCurrency);
}

/** Map vexim_inbound_shipments → InboundRow cho UI */
export function mapInboundRow(raw: InboundShipmentRaw): InboundRow {
  const status = raw.status ?? "UNKNOWN";

  // Tone theo trạng thái chuẩn Amazon
  const closed = status === "CLOSED";
  const inTransit = ["IN_TRANSIT", "SHIPPED", "DELIVERED"].includes(status);
  const receiving = status === "RECEIVING";
  const working = status === "WORKING";

  const statusTone: InboundRow["statusTone"] = closed
    ? "green"
    : inTransit || receiving
      ? "amber"
      : working
        ? "gray"
        : "blue";

  // ETA
  let eta = "—";
  if (raw.eta_date) {
    const etaDate = new Date(raw.eta_date);
    const now = new Date();
    const diffMs = etaDate.getTime() - now.getTime();
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    if (closed) {
      eta = `đã nhận ${raw.eta_date}`;
    } else if (diffDays <= 0) {
      eta = "hôm nay";
    } else if (diffDays === 1) {
      eta = "1 ngày";
    } else {
      eta = `${diffDays} ngày`;
    }
  }

  return {
    id: raw.shipment_id,
    shop: raw.shop,
    status,
    statusTone,
    units: raw.quantity ?? 0,
    fc: working ? "— chờ placement" : "—", // FC destination cần thêm view riêng
    eta,
    reconcile: closed ? "Chờ đối soát" : "—",
    reconcileTone: "flat",
  };
}

/* ------------------------------------------------------------------ */
/* Derived metrics cho overview / KPI                                  */
/* ------------------------------------------------------------------ */

export function computeFulfillKpis(rows: InventoryRow[]) {
  const lowOrOut = rows.filter(
    (r) => r.status === "out" || r.status === "low",
  );
  const totalFulfillable = rows.reduce((s, r) => s + r.fulfillable, 0);
  const agedCount = rows.filter((r) => r.status === "aged").length;

  return [
    {
      label: "SKU sắp hết hàng",
      value: String(lowOrOut.length),
      sub: "cover < 14 ngày",
      tone: lowOrOut.length > 0 ? ("down" as const) : ("flat" as const),
    },
    (() => {
      // 0017: giá trị tồn = Σ (khả dụng + reserved + đang về) × giá vốn hiệu lực
      const sum = summarizeInventoryValue(rows);
      return {
        label: "Giá trị tồn kho",
        value: formatInventoryValueTotal(sum),
        sub:
          sum.missingCost > 0
            ? `${totalFulfillable.toLocaleString("en-US")} đơn vị khả dụng · ${sum.missingCost} SKU chưa có giá vốn`
            : `${totalFulfillable.toLocaleString("en-US")} đơn vị khả dụng · đủ giá vốn`,
        tone: (sum.missingCost > 0 ? "warn" : "flat") as "warn" | "flat",
      };
    })(),
    {
      label: "SKU cần nhập",
      value: String(rows.filter((r) => r.suggest !== null && r.suggest > 0).length),
      sub: "đề xuất nhập > 0",
      tone: "flat" as const,
    },
    {
      label: "Tồn > 365 ngày",
      value: `${agedCount} SKU`,
      sub: "chuẩn bị removal để tránh phí dài hạn",
      tone: agedCount > 0 ? ("warn" as const) : ("flat" as const),
    },
  ];
}

/** SKU sắp hết xếp theo doanh thu (velocity × giá — nếu có giá) → cho overview */
export function buildSkuStock(rows: InventoryRow[]) {
  return rows
    .filter((r) => r.status === "out" || r.status === "low")
    .sort((a, b) => b.velocity - a.velocity)
    .slice(0, 5)
    .map((r) => ({
      sku: r.sku,
      stock: r.fulfillable,
      coverDays: r.coverDays ?? 0,
      coverTone: (r.coverDays !== null && r.coverDays < 7 ? "red" : "amber") as
        | "red"
        | "amber",
      perDay: r.velocity,
      suggest: r.suggest ?? 0,
    }));
}

/** Chuyển InventoryRow[] thành RestockRow[] cho I3 */
export function buildRestockRows(
  rows: InventoryRow[],
): RestockRow[] {
  return rows
    .filter((r) => r.suggest !== null && r.suggest > 0)
    .sort((a, b) => (b.suggest ?? 0) - (a.suggest ?? 0))
    .map((r) => ({
      sku: r.sku,
      shop: r.shop,
      suggest: r.suggest!,
      // 0017: giá vốn hiệu lực + giá trị lô = đề xuất nhập × giá vốn (SOP-01 bước 2)
      unitCost: formatUnitCost(r),
      value:
        r.unitCost === null
          ? "— chưa có giá vốn"
          : formatStockValue(
              Math.round(r.suggest! * r.unitCost * 100) / 100,
              r.costCurrency,
            ),
      step: "1/8",
      stepLabel: r.unitCost === null ? "Nháp — thiếu giá vốn" : "Nháp — chưa gửi duyệt",
      tone: (r.unitCost === null ? "amber" : "gray") as "amber" | "gray",
    }));
}

/** Tổng giá trị các lô đề xuất nhập (theo từng tiền tệ) — KPI của I3. */
export function summarizeRestockValue(rows: InventoryRow[]): InventoryValueSummary {
  const withSuggest = rows
    .filter((r) => r.suggest !== null && r.suggest > 0 && r.unitCost !== null)
    .map((r) => ({
      ...r,
      totalStockValue: Math.round(r.suggest! * r.unitCost! * 100) / 100,
    }));
  const missingCost = rows.filter(
    (r) => r.suggest !== null && r.suggest > 0 && r.unitCost === null,
  ).length;
  const sum = summarizeInventoryValue(withSuggest);
  return { ...sum, missingCost: sum.missingCost + missingCost };
}

/* ------------------------------------------------------------------ */
/* Module 3 nâng cao (migration 0018) — phân bổ FC + lịch sử nhận hàng */
/* ------------------------------------------------------------------ */
/*
 * Hai khối này của I2/I4 KHÔNG có từ API:
 *   • API tồn kho chỉ trả TỔNG theo SKU → không biết hàng nằm ở FC nào;
 *   • Inbound API chỉ mô tả lô ĐANG mở → không có lịch sử đã nhận.
 * Nguồn thật là 2 report (worker inventory:fc nhập, RPC 0018 ghi):
 *   GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA · GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA
 *
 * ⚠ PostgREST trả `sum()`/`count()` (bigint) và `numeric` dưới dạng CHUỖI
 *   ("58.8", "85"). Mọi mapper ở đây phải ép Number — nếu không UI sẽ nối chuỗi
 *   thành "4010" thay vì cộng ra 50 (lỗi khó thấy vì vẫn "có số").
 */

/** vexim_inventory_fc — 1 dòng = 1 SKU × 1 FC của snapshot MỚI NHẤT */
export type FcAllocationRaw = {
  seller_account_id: string;
  shop: string;
  snapshot_date: string;
  sku: string;
  fnsku: string | null;
  product_name: string | null;
  fc: string;
  country: string | null;
  quantity: number | string;
  sellable_qty: number | string | null;
  unsellable_qty: number | string | null;
  unknown_qty: number | string | null;
  sku_total_qty: number | string | null;
  sku_fc_count: number | string | null;
  fc_share_pct: number | string | null;
  source: string | null;
  imported_at: string;
};

/** vexim_inventory_receipts — từng lần Amazon thực nhận */
export type ReceiptRaw = {
  seller_account_id: string;
  shop: string;
  received_date: string;
  days_ago: number | string | null;
  sku: string;
  fnsku: string | null;
  product_name: string | null;
  quantity: number | string;
  shipment_id: string | null;
  fc: string | null;
  source: string | null;
  imported_at: string;
};

/** vexim_inbound_receipt_shipments — đối soát thực nhận với số gửi, theo lô */
export type ReceiptShipmentRaw = {
  seller_account_id: string;
  shop: string;
  shipment_id: string;
  fc: string | null;
  first_received_date: string | null;
  last_received_date: string | null;
  received_units: number | string;
  sku_count: number | string | null;
  shipment_status: string | null;
  expected_eta: string | null;
  expected_units: number | string | null;
  diff_units: number | string | null;
  receipt_rate_pct: number | string | null;
  reconcile_state: string | null;
  expected_source: string | null;
};

/**
 * Ba chuỗi select này PHẢI khớp đúng hợp đồng cột mà harness BƯỚC 19
 * (supabase/tests/run-migrations.mjs) soát trên Postgres thật — sai một cột là
 * PostgREST trả PGRST204 và SẬP trang I2/I4.
 */
export const FC_ALLOCATION_SELECT =
  "seller_account_id,shop,snapshot_date,sku,fnsku,product_name,fc,country,quantity," +
  "sellable_qty,unsellable_qty,unknown_qty,sku_total_qty,sku_fc_count,fc_share_pct,source,imported_at";

export const RECEIPT_SELECT =
  "seller_account_id,shop,received_date,days_ago,sku,fnsku,product_name,quantity," +
  "shipment_id,fc,source,imported_at";

export const RECEIPT_SHIPMENT_SELECT =
  "seller_account_id,shop,shipment_id,fc,first_received_date,last_received_date," +
  "received_units,sku_count,shipment_status,expected_eta,expected_units,diff_units," +
  "receipt_rate_pct,reconcile_state,expected_source";

/** bigint/numeric về dạng chuỗi → ép số; không đọc được thì NULL ("chưa biết"). */
function numOf(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function intOf(v: unknown, fallback = 0): number {
  return numOf(v) ?? fallback;
}

const sameSku = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** "58,8%" — NULL thì nói rõ là không rõ, không hiện 0% (tổng tồn = 0). */
export function formatSharePct(v: number | null): string {
  if (v === null) return "không rõ %";
  return `${v.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`;
}

export function mapFcAllocationRow(raw: FcAllocationRaw): FcAllocationRow {
  const share = numOf(raw.fc_share_pct);
  const fc = raw.fc === null || raw.fc === "" ? "(không rõ FC)" : raw.fc;
  return {
    sku: raw.sku,
    fc,
    units: intOf(raw.quantity),
    sellable: intOf(raw.sellable_qty),
    unsellable: intOf(raw.unsellable_qty),
    unknown: intOf(raw.unknown_qty),
    sharePct: share,
    shareLabel: formatSharePct(share),
    snapshotDate: String(raw.snapshot_date ?? "").slice(0, 10),
  };
}

export function mapReceiptRow(raw: ReceiptRaw): ReceiptRow {
  const date = String(raw.received_date ?? "").slice(0, 10);
  const days = numOf(raw.days_ago);
  return {
    sku: raw.sku,
    date,
    daysAgo: days,
    dateLabel:
      days === null
        ? date
        : days === 0
          ? `${date} (hôm nay)`
          : `${date} (${days} ngày trước)`,
    shipment: raw.shipment_id === "" ? null : raw.shipment_id,
    fc: raw.fc === "" ? null : raw.fc,
    units: intOf(raw.quantity),
  };
}

/**
 * Nhãn đối soát nhận hàng. Ba trạng thái có số thì nói số; riêng
 * `unknown_expected` PHẢI nói "chưa rõ số gửi" — im lặng ở đây đồng nghĩa với
 * "nhận đủ", tức là tự che mất hàng thiếu (đúng chỗ đau nhất của FBA).
 */
export function receiptStateLabel(
  state: ReceiptShipmentRow["state"],
  received: number,
  expected: number | null,
  diff: number | null,
): string {
  switch (state) {
    case "matched":
      return `Nhận đủ ${received}/${expected ?? received}`;
    case "short":
      return `Thiếu ${Math.abs(diff ?? (expected ?? received) - received)} (nhận ${received}/${expected ?? "?"}) → SOP-09`;
    case "over":
      return `Thừa ${diff ?? received - (expected ?? received)} (nhận ${received}/${expected ?? "?"})`;
    default:
      return `Chưa rõ số gửi (đã nhận ${received})`;
  }
}

export function mapReceiptShipmentRow(raw: ReceiptShipmentRaw): ReceiptShipmentRow {
  const received = intOf(raw.received_units);
  const expected = numOf(raw.expected_units);
  const diff = numOf(raw.diff_units);
  const rate = numOf(raw.receipt_rate_pct);
  const state = (["matched", "short", "over", "unknown_expected"].includes(
    String(raw.reconcile_state ?? ""),
  )
    ? raw.reconcile_state
    : "unknown_expected") as ReceiptShipmentRow["state"];
  return {
    shipmentId: raw.shipment_id,
    fc: raw.fc === "" ? null : raw.fc,
    received,
    expected,
    diff,
    ratePct: rate,
    state,
    label: receiptStateLabel(state, received, expected, diff),
    tone: state === "matched" ? "up" : state === "short" ? "down" : state === "over" ? "warn" : "flat",
    expectedSource: raw.expected_source === "inbound_shipments" ? "inbound_shipments" : "none",
    firstDate: raw.first_received_date ? String(raw.first_received_date).slice(0, 10) : null,
    lastDate: raw.last_received_date ? String(raw.last_received_date).slice(0, 10) : null,
    skuCount: intOf(raw.sku_count),
  };
}

/** I2: phân bổ FC của MỘT SKU — FC giữ nhiều hàng nhất lên trước. */
export function fcAllocationForSku(rows: FcAllocationRow[], sku: string): FcAllocationRow[] {
  return rows
    .filter((r) => sameSku(r.sku, sku))
    .sort((a, b) => b.units - a.units || a.fc.localeCompare(b.fc));
}

/** I2: lịch sử nhận của MỘT SKU — mới nhất lên trước. */
export function receiptsForSku(rows: ReceiptRow[], sku: string): ReceiptRow[] {
  return rows
    .filter((r) => sameSku(r.sku, sku))
    .sort((a, b) => b.date.localeCompare(a.date) || (a.shipment ?? "").localeCompare(b.shipment ?? ""));
}

export type FcAllocationSummary = {
  units: number;
  fcCount: number;
  sellable: number;
  unsellable: number;
  unknown: number;
  snapshotDate: string | null;
  /** FC giữ nhiều hàng nhất — null khi chưa có dữ liệu (không bịa) */
  topFc: { fc: string; units: number; shareLabel: string } | null;
};

/** Tóm tắt phân bổ FC của một SKU để in hint/summary (I2). */
export function summarizeFcAllocation(rows: FcAllocationRow[]): FcAllocationSummary {
  const units = rows.reduce((s, r) => s + r.units, 0);
  const top = rows.length === 0 ? null : rows.reduce((a, b) => (b.units > a.units ? b : a));
  return {
    units,
    fcCount: rows.length,
    sellable: rows.reduce((s, r) => s + r.sellable, 0),
    unsellable: rows.reduce((s, r) => s + r.unsellable, 0),
    unknown: rows.reduce((s, r) => s + r.unknown, 0),
    snapshotDate: rows[0]?.snapshotDate ?? null,
    topFc: top ? { fc: top.fc, units: top.units, shareLabel: top.shareLabel } : null,
  };
}

/**
 * I4: ghép đối soát nhận hàng vào danh sách lô.
 *   • có dữ liệu nhận → FC đích + nhãn đối soát THẬT (đủ / thiếu / thừa / chưa rõ)
 *   • KHÔNG có → GIỮ nhãn cũ ("Chờ đối soát" / "—"), không suy ra "nhận đủ"
 * Lô trong report nhưng không có trong danh sách (lô CLOSED trước khi sync)
 * thì trả về ở `orphans` để UI nói rõ, thay vì âm thầm bỏ đi.
 */
export function mergeInboundReconcile(
  inbound: InboundRow[],
  recon: ReceiptShipmentRow[],
): { rows: InboundRow[]; orphans: ReceiptShipmentRow[]; matched: number } {
  const byId = new Map(recon.map((r) => [r.shipmentId.trim().toUpperCase(), r]));
  let matched = 0;
  const rows = inbound.map((row) => {
    const hit = byId.get(row.id.trim().toUpperCase());
    if (!hit) return row;
    matched++;
    return {
      ...row,
      // FC đích: chỉ thay khi report cho biết (không xoá nhãn "— chờ placement")
      fc: hit.fc ?? row.fc,
      reconcile: hit.label,
      reconcileTone: hit.tone,
    };
  });
  const inboundIds = new Set(inbound.map((r) => r.id.trim().toUpperCase()));
  const orphans = recon.filter((r) => !inboundIds.has(r.shipmentId.trim().toUpperCase()));
  return { rows, orphans, matched };
}

/* ------------------------------------------------------------------ */
/* Phân trang PostgREST                                                */
/* ------------------------------------------------------------------ */

export type PageResult = { data: unknown[] | null; error: unknown };

export async function readAll<T>(
  read: (from: number, to: number) => PromiseLike<PageResult>,
): Promise<T[]> {
  const rows: T[] = [];
  const size = 500;
  for (let from = 0; ; from += size) {
    const result = await read(from, from + size - 1);
    if (result.error || !result.data)
      throw new Error("Inventory data unavailable");
    rows.push(...(result.data as T[]));
    if (result.data.length < size) return rows;
  }
}
