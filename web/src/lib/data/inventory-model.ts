/**
 * Data model cho Module 3 (Kho vận & FBA) — đọc từ Supabase public views.
 * View: vexim_inventory_latest, vexim_inbound_shipments
 *
 * Ánh xạ cột DB → UI type, tính chỉ số velocity/cover/suggest từ domain logic.
 * Tuân thủ đúng công thức docs/phan-tich-ky-thuat-module-3-kho-van.md mục 2.
 */

import type { InventoryRow, InboundRow, RestockRow } from "@/lib/types";
import {
  COVER_ALERT_THRESHOLD,
  SAFETY_DAYS_DEFAULT,
} from "@/lib/worker/domain/inventory-metrics";

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

export const INVENTORY_SELECT =
  "seller_account_id,shop,sku,asin,fulfillable,reserved,inbound,captured_at,day,days_of_cover,velocity,suggest_restock,in_stock";

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
  };
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
    {
      label: "Tồn khả dụng",
      value: totalFulfillable.toLocaleString("en-US"),
      sub: "đơn vị · toàn shop",
      tone: "flat" as const,
    },
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
      unitCost: "—", // cần cost_inputs join
      value: "—", // cần cost_inputs join
      step: "1/8",
      stepLabel: "Nháp — chưa gửi duyệt",
      tone: "gray" as const,
    }));
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
