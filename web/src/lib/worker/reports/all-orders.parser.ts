/**
 * Parser report GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL
 * ("Flat File Orders By Last Update Report" — nhóm Order tracking reports).
 *
 * Amazon ghi rõ về nhóm report này:
 *   "The reports are intended for order tracking, not to drive a seller's
 *    fulfillment process, as they do not include customer-identifying information"
 * → ĐÂY là lựa chọn đúng cho quyết định v1.1 "không xin role restricted / không PII":
 *   report không có buyer-name, buyer-email, buyer-phone, ship-address, recipient-name.
 *
 * Cột (theo tài liệu, tab-delimited):
 *   amazon-order-id, merchant-order-id, purchase-date, last-updated-date, order-status,
 *   order-item-id, fulfillment-channel, sales-channel, order-channel, ship-service-level,
 *   product-name, sku, asin, item-status, quantity, currency, item-price, item-tax,
 *   shipping-price, shipping-tax, gift-wrap-price, gift-wrap-tax,
 *   item-promotion-discount, ship-promotion-discount, ship-city, ship-state,
 *   ship-postal-code, ship-country, promotion-ids, is-business-order,
 *   purchase-order-number, price-designation
 *
 * QUYẾT ĐỊNH PII (defense-in-depth, không chỉ dựa vào việc Amazon không trả):
 *   ship-city và ship-postal-code bị BỎ NGAY khi parse (không đưa vào object trả về,
 *   không lọt vào `raw` của DB) vì postal code + city có thể nhận dạng cá nhân.
 *   Giữ ship-state + ship-country (mức vùng, phục vụ phân tích vận chuyển/thuế).
 *   Danh sách cột bị bỏ được trả về trong `droppedPiiColumns` để test/kiểm toán.
 *
 * ⚠️ Report này KHÔNG có cột hạn ship (latest-ship-date) → queue FBM không thể lấy
 * hạn thật từ đây. Hạn thật lấy từ getOrders/notification ORDER_CHANGE
 * (`LatestShipDate`); report dùng để đối soát trạng thái/SKU/tiền. Parser đánh dấu
 * `hasShipDeadline=false` để tầng trên biết chắc.
 */

export type AllOrdersRow = {
  amazonOrderId: string;
  merchantOrderId: string | null;
  purchaseDate: string;
  lastUpdatedDate: string | null;
  orderStatus: string;
  orderItemId: string;
  fulfillmentChannel: string | null; // AFN | MFN
  salesChannel: string | null;
  orderChannel: string | null;
  shipServiceLevel: string | null;
  productName: string | null;
  sku: string | null;
  asin: string | null;
  itemStatus: string | null;
  quantity: number;
  currency: string | null;
  itemPrice: number;
  itemTax: number;
  shippingPrice: number;
  shippingTax: number;
  itemPromotionDiscount: number;
  shipPromotionDiscount: number;
  /** mức vùng — KHÔNG phải định danh cá nhân */
  shipState: string | null;
  shipCountry: string | null;
  isBusinessOrder: boolean | null;
  priceDesignation: string | null;
};

export type AllOrdersParseResult = {
  rows: AllOrdersRow[];
  warnings: string[];
  /** cột PII đã bị loại bỏ khi parse (kiểm toán) */
  droppedPiiColumns: string[];
  hasShipDeadline: false;
};

/** Cột bị loại vì là PII/định danh gần (không bao giờ vào DB). */
export const ALL_ORDERS_PII_COLUMNS = ["ship-city", "ship-postal-code"] as const;

const COL = {
  orderId: "amazon-order-id",
  merchantOrderId: "merchant-order-id",
  purchaseDate: "purchase-date",
  lastUpdatedDate: "last-updated-date",
  orderStatus: "order-status",
  orderItemId: "order-item-id",
  fulfillmentChannel: "fulfillment-channel",
  salesChannel: "sales-channel",
  orderChannel: "order-channel",
  shipServiceLevel: "ship-service-level",
  productName: "product-name",
  sku: "sku",
  asin: "asin",
  itemStatus: "item-status",
  quantity: "quantity",
  currency: "currency",
  itemPrice: "item-price",
  itemTax: "item-tax",
  shippingPrice: "shipping-price",
  shippingTax: "shipping-tax",
  giftWrapPrice: "gift-wrap-price",
  giftWrapTax: "gift-wrap-tax",
  itemPromotionDiscount: "item-promotion-discount",
  shipPromotionDiscount: "ship-promotion-discount",
  shipState: "ship-state",
  shipCountry: "ship-country",
  isBusinessOrder: "is-business-order",
  priceDesignation: "price-designation",
} as const;

/** Cột bắt buộc — thiếu thì report không dùng được (trả rỗng + cảnh báo). */
const REQUIRED = [COL.orderId, COL.orderItemId, COL.purchaseDate, COL.orderStatus, COL.quantity] as const;

function toNum(v: string | undefined): number {
  if (v === undefined || v === "") return 0;
  const n = Number(v.replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function toBool(v: string | undefined): boolean | null {
  if (v === undefined || v === "") return null;
  const s = v.trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(s)) return true;
  if (["false", "0", "no", "n"].includes(s)) return false;
  return null;
}

/**
 * Parse nội dung report (tab-delimited, dòng đầu là header).
 * Chịu được: BOM, \r\n, ô trống, report rỗng.
 */
export function parseAllOrdersReport(text: string): AllOrdersParseResult {
  const droppedPiiColumns = [...ALL_ORDERS_PII_COLUMNS];
  const warnings: string[] = [];
  const lines = (text ?? "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);

  if (lines.length < 2) return { rows: [], warnings: ["Report rỗng"], droppedPiiColumns, hasShipDeadline: false };

  const header = lines[0].split("\t").map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);

  for (const c of REQUIRED) {
    if (idx(c) < 0) {
      warnings.push(`Thiếu cột bắt buộc: ${c}`);
      return { rows: [], warnings, droppedPiiColumns, hasShipDeadline: false };
    }
  }

  const missingOptional = Object.values(COL).filter((c) => idx(c) < 0);
  if (missingOptional.length > 0) {
    warnings.push(`Report thiếu ${missingOptional.length} cột tuỳ chọn (giá trị = null): ${missingOptional.join(", ")}`);
  }
  const presentPii = ALL_ORDERS_PII_COLUMNS.filter((c) => idx(c) >= 0);
  if (presentPii.length > 0) {
    warnings.push(`Đã loại ${presentPii.length} cột PII khi parse: ${presentPii.join(", ")} (quyết định v1.1 — không lưu PII)`);
  }

  const rows: AllOrdersRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split("\t");
    const raw = (name: string): string | undefined => {
      const k = idx(name);
      if (k < 0) return undefined;
      const v = cells[k];
      return v === undefined ? undefined : v.trim();
    };

    const orderId = raw(COL.orderId) ?? "";
    if (!orderId) {
      warnings.push(`Dòng ${i + 1}: thiếu amazon-order-id — bỏ qua`);
      continue;
    }

    rows.push({
      amazonOrderId: orderId,
      merchantOrderId: raw(COL.merchantOrderId) || null,
      purchaseDate: raw(COL.purchaseDate) ?? "",
      lastUpdatedDate: raw(COL.lastUpdatedDate) || null,
      orderStatus: raw(COL.orderStatus) ?? "",
      orderItemId: raw(COL.orderItemId) ?? "",
      fulfillmentChannel: raw(COL.fulfillmentChannel) || null,
      salesChannel: raw(COL.salesChannel) || null,
      orderChannel: raw(COL.orderChannel) || null,
      shipServiceLevel: raw(COL.shipServiceLevel) || null,
      productName: raw(COL.productName) || null,
      sku: raw(COL.sku) || null,
      asin: raw(COL.asin) || null,
      itemStatus: raw(COL.itemStatus) || null,
      quantity: toNum(raw(COL.quantity)),
      currency: raw(COL.currency) || null,
      itemPrice: toNum(raw(COL.itemPrice)),
      itemTax: toNum(raw(COL.itemTax)),
      shippingPrice: toNum(raw(COL.shippingPrice)),
      shippingTax: toNum(raw(COL.shippingTax)),
      itemPromotionDiscount: toNum(raw(COL.itemPromotionDiscount)),
      shipPromotionDiscount: toNum(raw(COL.shipPromotionDiscount)),
      shipState: raw(COL.shipState) || null,
      shipCountry: raw(COL.shipCountry) || null,
      isBusinessOrder: toBool(raw(COL.isBusinessOrder)),
      priceDesignation: raw(COL.priceDesignation) || null,
    });
  }

  return { rows, warnings, droppedPiiColumns, hasShipDeadline: false };
}

/* ============================================================================
 * Gom dòng item → đơn (order)
 * ==========================================================================*/

export type ParsedOrder = {
  amazonOrderId: string;
  merchantOrderId: string | null;
  purchaseDate: string;
  lastUpdatedDate: string | null;
  orderStatus: string;
  fulfillmentChannel: string | null;
  currency: string | null;
  itemsCount: number; // Σ quantity
  orderTotal: number; // Σ (item + tax + ship − promotion)
  sku: string | null; // SKU chính (dòng đầu) — khớp cột "SKU chính" của O1
  items: {
    orderItemId: string;
    sku: string | null;
    asin: string | null;
    productName: string | null;
    quantity: number;
    itemPrice: number;
    itemStatus: string | null;
    shipServiceLevel: string | null;
  }[];
};

/**
 * Gộp các dòng item thành đơn.
 * `orderTotal` = Σ(item-price + item-tax + shipping-price + shipping-tax
 *                   − item-promotion-discount − ship-promotion-discount)
 * (report không có cột tổng đơn; công thức này khớp cách Amazon tính item total).
 */
export function groupOrders(rows: AllOrdersRow[]): ParsedOrder[] {
  const map = new Map<string, ParsedOrder>();

  for (const r of rows) {
    let order = map.get(r.amazonOrderId);
    if (!order) {
      order = {
        amazonOrderId: r.amazonOrderId,
        merchantOrderId: r.merchantOrderId,
        purchaseDate: r.purchaseDate,
        lastUpdatedDate: r.lastUpdatedDate,
        orderStatus: r.orderStatus,
        fulfillmentChannel: r.fulfillmentChannel,
        currency: r.currency,
        itemsCount: 0,
        orderTotal: 0,
        sku: r.sku,
        items: [],
      };
      map.set(r.amazonOrderId, order);
    }

    order.itemsCount += r.quantity;
    order.orderTotal +=
      r.itemPrice + r.itemTax + r.shippingPrice + r.shippingTax - r.itemPromotionDiscount - r.shipPromotionDiscount;
    order.items.push({
      orderItemId: r.orderItemId,
      sku: r.sku,
      asin: r.asin,
      productName: r.productName,
      quantity: r.quantity,
      itemPrice: r.itemPrice,
      itemStatus: r.itemStatus,
      shipServiceLevel: r.shipServiceLevel,
    });

    // trạng thái mới nhất thắng (report xếp theo lần cập nhật)
    if (r.lastUpdatedDate && (!order.lastUpdatedDate || r.lastUpdatedDate > order.lastUpdatedDate)) {
      order.lastUpdatedDate = r.lastUpdatedDate;
      order.orderStatus = r.orderStatus;
      order.fulfillmentChannel = r.fulfillmentChannel;
    }
  }

  return [...map.values()].map((o) => ({ ...o, orderTotal: Math.round(o.orderTotal * 100) / 100 }));
}

/** Đơn vị bán theo SKU — mẫu số của tỷ lệ trả hàng (O4). */
export function unitsBySku(rows: AllOrdersRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const sku = (r.sku ?? "").trim();
    if (!sku) continue;
    out[sku] = (out[sku] ?? 0) + r.quantity;
  }
  return out;
}
