/**
 * PHẦN THUẦN của Orders API v0 — kiểu dữ liệu Amazon trả về + hàm ánh xạ sang
 * `OrderRowInput`/`OrderItemInput`/`OrderDailyRowInput` của adapter.
 *
 * VÌ SAO TÁCH FILE NÀY (16/09/2026):
 *   Module 4 trước đây CHỈ có đường "report" (GET_FLAT_FILE_ALL_ORDERS_*). Tầng
 *   delta (`getOrders`) được mô tả trong tài liệu job nhưng **chưa có client** ⇒
 *   đơn hàng không bao giờ tự về, màn `/orders` trống mãi. Client ở
 *   `amazon/orders.ts` gọi HTTP; mọi luật ánh xạ/kiểm tra nằm ở đây để test được
 *   bằng `node --test` mà không cần mạng.
 *
 * Nguồn hợp đồng: `amzn/selling-partner-api-models` → `models/orders-api-model/ordersV0.json`
 *   • GET /orders/v0/orders — `MarketplaceIds` **BẮT BUỘC**, `MaxResultsPerPage` 1–100,
 *     phân trang bằng `NextToken`.
 *   • GET /orders/v0/orders/{orderId}/orderItems — phân trang bằng `NextToken`.
 *   • Rate (mô tả trong chính file model): getOrders 0.0167 rps · burst 20;
 *     getOrder/getOrderItems 0.5 rps · burst 30.
 *   • Trường `ShippingAddress`/`BuyerInfo` là PII ⇒ KHÔNG đọc (quyết định v1.1);
 *     xem `PII_LOCKED_PATHS`.
 */
import type { OrderDailyRowInput, OrderItemInput, OrderRowInput } from "../db/adapter.ts";

/* ------------------------------- kiểu wire ------------------------------- */

export type ApiMoney = { Amount?: string | number | null; CurrencyCode?: string | null };

/** Order trong `payload.Orders[]` của getOrders (chỉ các trường ta thực sự dùng). */
export type ApiOrder = {
  AmazonOrderId?: string | null;
  SellerOrderId?: string | null;
  PurchaseDate?: string | null;
  LastUpdateDate?: string | null;
  OrderStatus?: string | null;
  /** AFN = FBA · MFN = FBM */
  FulfillmentChannel?: string | null;
  SalesChannel?: string | null;
  MarketplaceId?: string | null;
  OrderTotal?: ApiMoney | null;
  NumberOfItemsShipped?: number | null;
  NumberOfItemsUnshipped?: number | null;
  ShipmentServiceLevelCategory?: string | null;
  EarliestShipDate?: string | null;
  LatestShipDate?: string | null;
  IsPrime?: boolean | null;
  IsBusinessOrder?: boolean | null;
  /** PII — có thể xuất hiện trong response; ta KHÔNG BAO GIỜ đọc/ghi. */
  ShippingAddress?: unknown;
  BuyerInfo?: unknown;
};

/** Item trong `payload.OrderItems[]` của orderItems. */
export type ApiOrderItem = {
  OrderItemId?: string | null;
  ASIN?: string | null;
  SellerSKU?: string | null;
  Title?: string | null;
  QuantityOrdered?: number | null;
  QuantityShipped?: number | null;
  ItemPrice?: ApiMoney | null;
  ItemTax?: ApiMoney | null;
  ShippingPrice?: ApiMoney | null;
  PromotionDiscount?: ApiMoney | null;
  /** BuyerInfo là PII ⇒ không đọc. */
  BuyerInfo?: unknown;
};

/* --------------------------- luật kiểm tra (thuần) ------------------------ */

/** `MaxResultsPerPage` theo model: 1–100. Ngoài khoảng ⇒ kẹp lại, không gửi 400. */
export const ORDERS_MAX_RESULTS_PER_PAGE = 100;

export function clampMaxResultsPerPage(value?: number | null): number {
  const n = Math.floor(Number(value ?? ORDERS_MAX_RESULTS_PER_PAGE));
  if (!Number.isFinite(n) || n <= 0) return ORDERS_MAX_RESULTS_PER_PAGE;
  return Math.min(n, ORDERS_MAX_RESULTS_PER_PAGE);
}

/**
 * `MarketplaceIds` là tham số BẮT BUỘC của getOrders — thiếu là Amazon trả 400
 * `MissingParameter`. Chặn ở đây để lỗi đọc được ngay trong log job, kèm hướng dẫn.
 */
export function assertMarketplaceIds(ids: readonly string[] | null | undefined): string[] {
  const clean = (ids ?? []).map((s) => String(s ?? "").trim()).filter(Boolean);
  if (clean.length === 0) {
    throw new Error(
      "getOrders cần MarketplaceIds (bắt buộc theo Orders API v0). " +
        "Shop thiếu `marketplace` trong connections.seller_accounts — đồng bộ lại shop rồi thử lại.",
    );
  }
  return clean;
}

/** Amazon trả ISO 8601; giá trị rỗng/‘null’ phải thành null, KHÔNG bịa ngày. */
export function isoOrNull(value?: string | null): Date | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const dt = new Date(raw);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/** `{Amount: "12.34", CurrencyCode: "USD"}` → 12.34 (chuỗi rỗng ⇒ null). */
export function moneyToNumber(money?: ApiMoney | null): number | null {
  const raw = money?.Amount;
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).replace(/[^0-9.\-]/g, "");
  // Chuỗi không có chữ số ("n/a", "--", "") ⇒ null. Nếu chỉ Number(...) thì "" thành
  // 0 và tiền rác sẽ lặng lẽ thành "đơn 0 đồng".
  if (!/[0-9]/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Trạng thái Amazon giữ NGUYÊN VĂN (Unshipped/Canceled…) — UI/log đối chiếu Seller Central. */
export function normalizeApiOrderStatus(raw?: string | null): string {
  return String(raw ?? "").trim() || "Unknown";
}

/** Số món: ưu tiên cộng shipped + unshipped; thiếu cả hai thì lấy số item đã đọc. */
export function apiItemsCount(order: ApiOrder, fallbackItems?: readonly unknown[] | null): number {
  const shipped = Number(order.NumberOfItemsShipped ?? NaN);
  const unshipped = Number(order.NumberOfItemsUnshipped ?? NaN);
  if (Number.isFinite(shipped) || Number.isFinite(unshipped)) {
    return (Number.isFinite(shipped) ? shipped : 0) + (Number.isFinite(unshipped) ? unshipped : 0);
  }
  return fallbackItems?.length ?? 0;
}

/** Item Amazon → dòng `sales.order_items`. Bỏ dòng không có OrderItemId (khoá ghi DB). */
export function apiItemToRowInput(item: ApiOrderItem): OrderItemInput | null {
  const id = String(item.OrderItemId ?? "").trim();
  if (!id) return null;
  return {
    amazonOrderItemId: id,
    sku: item.SellerSKU ?? null,
    asin: item.ASIN ?? null,
    itemName: item.Title ?? null,
    quantity: Number(item.QuantityOrdered ?? 0) || 0,
    itemPrice: moneyToNumber(item.ItemPrice) ?? 0,
    itemStatus: item.QuantityShipped != null ? `shipped:${Number(item.QuantityShipped) || 0}` : null,
  };
}

/**
 * Order Amazon → dòng `sales.orders`. Bỏ đơn thiếu `AmazonOrderId`/`PurchaseDate`
 * (không có khoá upsert hoặc không có mốc thời gian thì ghi vào DB cũng vô nghĩa).
 *
 * `shipState`/`shipCountry` LẤY TỪ ĐÂU: Orders API v0 trả `ShippingAddress` (PII,
 * bị khoá) — địa chỉ chỉ có ở endpoint restricted. Vì vậy đường API để trống 2 cột
 * này; tầng report (đã bỏ PII sẵn) hoặc notification mới có. Ghi rõ để người đọc
 * không tưởng là mất dữ liệu.
 */
export function apiOrderToRowInput(
  sellerAccountId: string,
  order: ApiOrder,
  items: readonly ApiOrderItem[] = [],
): OrderRowInput | null {
  const amazonOrderId = String(order.AmazonOrderId ?? "").trim();
  const purchaseDate = isoOrNull(order.PurchaseDate);
  if (!amazonOrderId || !purchaseDate) return null;

  const mappedItems = items
    .map(apiItemToRowInput)
    .filter((i): i is OrderItemInput => i !== null);

  return {
    sellerAccountId,
    amazonOrderId,
    merchantOrderId: order.SellerOrderId ?? null,
    status: normalizeApiOrderStatus(order.OrderStatus),
    channel: order.FulfillmentChannel ?? null,
    purchaseDate,
    lastUpdatedDate: isoOrNull(order.LastUpdateDate),
    orderTotal: moneyToNumber(order.OrderTotal),
    currency: order.OrderTotal?.CurrencyCode ?? "USD",
    itemsCount: apiItemsCount(order, items),
    marketplaceId: order.MarketplaceId ?? null,
    // PII: xem doc block phía trên — 2 cột này chỉ có từ tầng report.
    shipState: null,
    shipCountry: null,
    orderItems: mappedItems,
  };
}

/** Đơn CHƯA giao (đếm cho queue FBM) — MFN + Unshipped/PartiallyShipped. */
export function isPendingFbm(r: Pick<OrderRowInput, "channel" | "status">): boolean {
  return r.channel === "MFN" && (r.status === "Unshipped" || r.status === "PartiallyShipped");
}

/**
 * Tổng hợp `sales.order_daily` từ danh sách đơn của ĐÚNG một ngày.
 * `day` do caller chốt (theo `purchaseDate` UTC) — hàm này không tự đoán ngày.
 */
export function orderDailyFromApiOrders(
  sellerAccountId: string,
  day: string,
  rows: readonly OrderRowInput[],
  now: Date = new Date(),
): OrderDailyRowInput {
  const counted = rows.filter((r) => r.status !== "Canceled");
  const units = counted.reduce(
    (sum, r) => sum + r.orderItems.reduce((s, i) => s + (Number(i.quantity) || 0), 0),
    0,
  );
  const salesAmount = counted.reduce((sum, r) => sum + (Number(r.orderTotal) || 0), 0);
  const fbmUnshipped = counted.filter(isPendingFbm).length;
  const fbmOverdue = counted.filter(
    (r) =>
      isPendingFbm(r) &&
      r.lastUpdatedDate !== null &&
      r.lastUpdatedDate !== undefined &&
      // `lastUpdatedDate` chỉ là mốc cập nhật nguồn; hạn ship thật không có ở đường API.
      now.getTime() - r.lastUpdatedDate.getTime() > 24 * 3600_000,
  ).length;

  return {
    sellerAccountId,
    day,
    ordersCount: counted.length,
    units,
    salesAmount: Math.round(salesAmount * 100) / 100,
    currency: counted[0]?.currency ?? "USD",
    fbmUnshipped,
    fbmOverdue,
    returnsCount: 0,
    returnsAmount: 0,
  };
}

/* ------------------------------ khoá PII ------------------------------ */

/** Endpoint trả PII — CỐ Ý không có client (quyết định v1.1: không lấy dữ liệu người mua). */
export const PII_LOCKED_PATHS = [
  "/orders/v0/orders/{orderId}/address",
  "/orders/v0/orders/{orderId}/buyerInfo",
  "/orders/v0/orders/{orderId}/orderItems/buyerInfo",
] as const;

export function isPiiLockedPath(path: string): boolean {
  return (PII_LOCKED_PATHS as readonly string[]).some((p) => path === p || path.endsWith("/address") || path.endsWith("/buyerInfo"));
}
