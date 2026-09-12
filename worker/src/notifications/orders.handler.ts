/**
 * Handler notification ORDER_CHANGE (Tầng 1 — realtime) cho Module 4.
 *
 * Payload (developer-docs.amazon.com/sp-api/docs/notification-type-values):
 *   {
 *     "NotificationVersion": "1.0",
 *     "NotificationType": "ORDER_CHANGE",
 *     "PayloadVersion": "1.0",
 *     "EventTime": "2020-01-11T00:09:53.109Z",
 *     "Payload": {
 *       "OrderChangeNotification": {
 *         "NotificationLevel": "OrderLevel",
 *         "SellerId": "A3TH9S8BH6GOGM",
 *         "AmazonOrderId": "903-8868176-2219830",
 *         "OrderChangeType": "BuyerRequestedChange",   // OrderStatusChange | BuyerRequestedChange | DeliveryTipChange
 *         "OrderChangeTrigger": { "TimeOfOrderChange": "...", "ChangeReason": "Buyer Requested Cancel" },
 *         "Summary": {
 *           "MarketplaceId": "ATVPDKIKX0DER", "OrderStatus": "Unshipped",
 *           "PurchaseDate": "...", "DestinationPostalCode": "48110",   ← PII!
 *           "FulfillmentType": "MFN", "OrderType": "StandardOrder",
 *           "NumberOfItemsShipped": 0, "NumberOfItemsUnshipped": 10,
 *           "EarliestShipDate": "...", "LatestShipDate": "...", "CancelNotifyDate": "...",
 *           "OrderPrograms": ["Business"], "ShippingPrograms": ["EasyShip"],
 *           "OrderItems": [{ "OrderItemId", "SellerSKU", "Quantity", "QuantityShipped",
 *                            "IsBuyerRequestedCancel", … }]
 *         }
 *       }
 *     }
 *   }
 *
 * ⚠️ PII: `DestinationPostalCode` là dữ liệu định danh gần (mã bưu chính + ngày + SKU
 * có thể nhận dạng người mua) → handler BÓC BỎ trước khi ghi DB, dù Amazon gửi kèm.
 * Quyết định v1.1: chỉ giữ state/country của điểm giao.
 *
 * Notification KHÔNG có giá tiền → đơn tạo từ notification có `orderTotal = null`;
 * giá lấy từ getOrders/report (tầng 2/3). Bù lại nó có LatestShipDate — thứ mà
 * report order-tracking không có → đây là nguồn chuẩn cho queue FBM (O3).
 */
import type { DbAdapter, OrderRowInput } from "../db/adapter.ts";
import { buildFbmQueue, fbmShipAlert } from "../domain/orders.ts";

export type OrderChangeSummary = {
  MarketplaceId?: string;
  MarketplaceID?: string; // một số tài liệu ghi ID
  OrderStatus?: string;
  PurchaseDate?: string;
  DestinationPostalCode?: string | null;
  FulfillmentType?: string;
  OrderType?: string;
  NumberOfItemsShipped?: number;
  NumberOfItemsUnshipped?: number;
  EarliestShipDate?: string;
  LatestShipDate?: string;
  CancelNotifyDate?: string;
  OrderPrograms?: string[];
  ShippingPrograms?: string[];
  OrderItems?: {
    OrderItemId?: string;
    SellerSKU?: string;
    SupplySourceId?: string | null;
    OrderItemStatus?: string;
    Quantity?: number;
    QuantityShipped?: number;
    IsBuyerRequestedCancel?: boolean;
  }[];
};

export type OrderChangeNotification = {
  NotificationLevel?: string;
  SellerId?: string;
  AmazonOrderId?: string;
  OrderChangeType?: string;
  OrderChangeTrigger?: { TimeOfOrderChange?: string; ChangeReason?: string };
  Summary?: OrderChangeSummary;
};

/** Bóc OrderChangeNotification ở cả hai kiểu casing. */
export function extractOrderChange(payload: unknown): OrderChangeNotification | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as {
    Payload?: { OrderChangeNotification?: OrderChangeNotification };
    payload?: { orderChangeNotification?: OrderChangeNotification };
  };
  const body = p.Payload?.OrderChangeNotification ?? p.payload?.orderChangeNotification;
  if (!body || !body.AmazonOrderId) return null;
  return body;
}

export function isOrderChange(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as { notificationType?: string; NotificationType?: string };
  const type = p.notificationType ?? p.NotificationType;
  if (type && type !== "ORDER_CHANGE") return false;
  return extractOrderChange(payload) !== null;
}

/** Kết quả chuẩn hóa — KHÔNG chứa trường PII nào. */
export type NormalizedOrderChange = {
  amazonOrderId: string;
  marketplaceId: string | null;
  status: string;
  fulfillmentChannel: string | null;
  purchaseDate: string;
  latestShipDate: string | null;
  earliestShipDate: string | null;
  cancelNotifyDate: string | null;
  changeType: string | null;
  changeReason: string | null;
  timeOfChange: string | null;
  itemsCount: number;
  itemsShipped: number;
  itemsUnshipped: number;
  items: { amazonOrderItemId: string; sku: string | null; quantity: number; quantityShipped: number; status: string | null }[];
  buyerRequestedCancel: boolean;
  /** các trường đã bị loại vì PII (kiểm toán) */
  droppedPiiFields: string[];
};

/** Chuẩn hóa notification → dạng lưu DB (bỏ PII). */
export function normalizeOrderChange(n: OrderChangeNotification): NormalizedOrderChange {
  const s = n.Summary ?? {};
  const droppedPiiFields: string[] = [];
  if (s.DestinationPostalCode) droppedPiiFields.push("DestinationPostalCode");

  const items = (s.OrderItems ?? []).map((i) => ({
    amazonOrderItemId: i.OrderItemId ?? "",
    sku: i.SellerSKU ?? null,
    quantity: i.Quantity ?? 0,
    quantityShipped: i.QuantityShipped ?? 0,
    status: i.OrderItemStatus ?? null,
  }));

  const itemsCount = items.reduce((acc, i) => acc + i.quantity, 0);
  // Buyer yêu cầu huỷ nằm ở cấp item (IsBuyerRequestedCancel) — SAP-06 xử lý ngay
  const buyerRequestedCancel = (s.OrderItems ?? []).some((i) => i.IsBuyerRequestedCancel === true);

  return {
    amazonOrderId: n.AmazonOrderId ?? "",
    marketplaceId: s.MarketplaceId ?? s.MarketplaceID ?? null,
    status: s.OrderStatus ?? "Pending",
    fulfillmentChannel: s.FulfillmentType ?? null,
    purchaseDate: s.PurchaseDate ?? new Date().toISOString(),
    latestShipDate: s.LatestShipDate ?? null,
    earliestShipDate: s.EarliestShipDate ?? null,
    cancelNotifyDate: s.CancelNotifyDate ?? null,
    changeType: n.OrderChangeType ?? null,
    changeReason: n.OrderChangeTrigger?.ChangeReason ?? null,
    timeOfChange: n.OrderChangeTrigger?.TimeOfOrderChange ?? null,
    itemsCount: itemsCount || (s.NumberOfItemsShipped ?? 0) + (s.NumberOfItemsUnshipped ?? 0),
    itemsShipped: s.NumberOfItemsShipped ?? 0,
    itemsUnshipped: s.NumberOfItemsUnshipped ?? 0,
    items,
    buyerRequestedCancel,
    droppedPiiFields,
  };
}

export type OrderChangeResult = {
  amazonOrderId: string;
  status: string;
  fulfillmentChannel: string | null;
  changeType: string | null;
  /** true khi buyer yêu cầu huỷ — CSKH phải xử lý theo SOP-06 */
  buyerRequestedCancel: boolean;
  droppedPiiFields: string[];
  alertCreated: boolean;
};

/**
 * Xử lý ORDER_CHANGE: ghi notification (đã bỏ PII) → upsert đơn → cảnh báo FBM nếu
 * hạn ship gấp/đã trễ (rule `fbm_late_ship`).
 */
export async function handleOrderChange(
  payload: unknown,
  adapter: DbAdapter,
  opts: { sellerAccountId: string; now?: Date; handlingHours?: number },
): Promise<OrderChangeResult | null> {
  const change = extractOrderChange(payload);
  if (!change) return null;
  const now = opts.now ?? new Date();
  const normalized = normalizeOrderChange(change);

  await adapter.recordNotification({
    sellerAccountId: opts.sellerAccountId,
    notificationType: "ORDER_CHANGE",
    // PII đã bị bỏ: raw lưu bản đã bóc DestinationPostalCode
    raw: {
      OrderChangeNotification: {
        ...change,
        Summary: change.Summary
          ? { ...change.Summary, DestinationPostalCode: undefined }
          : change.Summary,
      },
    },
    normalized: {
      ...normalized,
      droppedPiiFields: normalized.droppedPiiFields,
    },
    receivedAt: now,
  });

  const order: OrderRowInput = {
    sellerAccountId: opts.sellerAccountId,
    amazonOrderId: normalized.amazonOrderId,
    merchantOrderId: null,
    status: normalized.status,
    channel: normalized.fulfillmentChannel,
    purchaseDate: new Date(normalized.purchaseDate),
    lastUpdatedDate: normalized.timeOfChange ? new Date(normalized.timeOfChange) : now,
    orderTotal: null, // notification không có giá — lấy từ getOrders/report
    currency: "USD",
    itemsCount: normalized.itemsCount,
    marketplaceId: normalized.marketplaceId,
    orderItems: normalized.items.map((i) => ({
      amazonOrderItemId: i.amazonOrderItemId,
      sku: i.sku,
      asin: null,
      itemName: null,
      quantity: i.quantity,
      itemPrice: 0,
      itemStatus: i.status,
    })),
  };
  await adapter.upsertOrders([order]);

  // Queue FBM: dùng hạn THẬT từ LatestShipDate của notification
  const queue = buildFbmQueue(
    [
      {
        amazonOrderId: normalized.amazonOrderId,
        status: normalized.status,
        fulfillmentChannel: normalized.fulfillmentChannel,
        purchaseDate: normalized.purchaseDate,
        latestShipDate: normalized.latestShipDate,
        itemsCount: normalized.itemsCount,
        sku: normalized.items[0]?.sku ?? null,
      },
    ],
    now,
    { handlingHours: opts.handlingHours },
  );

  let alertCreated = false;
  const alert = fbmShipAlert(queue);
  if (alert) {
    await adapter.upsertAlert({
      sellerAccountId: opts.sellerAccountId,
      ruleCode: alert.ruleCode,
      severity: alert.severity,
      title: alert.title,
      detail: `${alert.detail} (nguồn: notification ORDER_CHANGE${normalized.changeType ? ` · ${normalized.changeType}` : ""})`,
    });
    alertCreated = true;
  }

  return {
    amazonOrderId: normalized.amazonOrderId,
    status: normalized.status,
    fulfillmentChannel: normalized.fulfillmentChannel,
    changeType: normalized.changeType,
    buyerRequestedCancel: normalized.buyerRequestedCancel,
    droppedPiiFields: normalized.droppedPiiFields,
    alertCreated,
  };
}
