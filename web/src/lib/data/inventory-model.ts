/**
 * Data model cho Module 3 (Kho vận & FBA) — đọc từ Supabase public views.
 * View: vexim_inventory_latest, vexim_inbound_shipments
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

import type { InventoryRow, InboundRow, InventoryValueBasis, RestockRow } from "@/lib/types";
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
