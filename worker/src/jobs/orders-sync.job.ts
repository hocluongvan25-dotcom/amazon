/**
 * Job đồng bộ Đơn hàng (Module 4 — O1/O3/O4).
 *
 * Kiến trúc 3 tầng (giống Module 1/3):
 *   Tầng 1 (realtime)  notification ORDER_CHANGE → kéo chi tiết đơn (getOrders/getOrderItems)
 *   Tầng 2 (delta)     getOrders theo LastUpdatedAfter (0.0167 rps · burst 20) mỗi 15–30 phút
 *   Tầng 3 (đối soát)  report GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL +
 *                      GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE hằng ngày 2h sáng
 *
 * ⚠️ VÌ SAO REPORT LÀ TẦNG 3 MÀ KHÔNG PHẢI TẦNG 2:
 *   Report "Orders By Last Update" là order-tracking report — Amazon ghi rõ nó
 *   KHÔNG có thông tin định danh người mua (đúng quyết định không-PII v1.1) và
 *   cũng KHÔNG có cột hạn ship (latest-ship-date). Hạn ship thật chỉ có ở
 *   getOrders/notification ORDER_CHANGE → queue FBM lấy hạn từ tầng 1/2, còn tầng 3
 *   dùng để đối soát trạng thái/SKU/tiền. Vì vậy `deadlineAssumed=true` là BÌNH THƯỜNG
 *   khi chỉ có dữ liệu report (xem domain/orders.ts → fbmShipDeadline).
 *
 * Rate limit Orders API v0 (kiểm chứng Orders API v0 reference):
 *   getOrders / getOrder / getOrderBuyerInfo / getOrderAddress : 0.0167 rps · burst 20
 *   getOrderItems : 0.5 rps · burst 30
 *   getOrderAddress/getOrderBuyerInfo = RESTRICTED (PII) → KHÔNG gọi (quyết định v1.1).
 */
import type {
  AlertRowInput,
  DbAdapter,
  OrderDailyRowInput,
  OrderRowInput,
  ReturnRowInput,
  SyncJobRecord,
} from "../db/adapter.ts";
import {
  buildFbmQueue,
  fbmShipAlert,
  orderDeltaWindow,
  orderKpis,
  returnHotspots,
  returnsBreakdown,
  type FbmQueueItem,
  type ReturnReasonSummary,
} from "../domain/orders.ts";
import { groupOrders, parseAllOrdersReport, unitsBySku, type ParsedOrder } from "../reports/all-orders.parser.ts";
import { parseReturnsReport, type ReturnRowParsed } from "../reports/returns.parser.ts";

export type OrdersSyncConfig = {
  /** Tần suất kéo delta (phút) — tài liệu Amazon khuyến nghị 15–30 phút */
  deltaIntervalMinutes: number;
  maxResultsPerPage: number;
  /** Orders API v0 — getOrders */
  requestsPerSecond: number;
  burst: number;
  /** getOrderItems (rate cao hơn) */
  orderItemsRequestsPerSecond: number;
  orderItemsBurst: number;
  reportScheduleCron: string;
  reportRetentionDays: number;
  returnsMaxRangeDays: number;
  handlingHoursFallback: number;
};

export const DEFAULT_ORDERS_SYNC_CONFIG: OrdersSyncConfig = {
  deltaIntervalMinutes: 15,
  maxResultsPerPage: 100, // MaxResultsPerPage tối đa = 100 theo reference
  requestsPerSecond: 0.0167,
  burst: 20,
  orderItemsRequestsPerSecond: 0.5,
  orderItemsBurst: 30,
  reportScheduleCron: "0 2 * * *",
  reportRetentionDays: 30, // "Order reports are retained for 30 days"
  returnsMaxRangeDays: 60, // "You can request up to 60 days of data in a single report"
  handlingHoursFallback: 24,
};

export const ORDERS_REPORT_TYPES = {
  allOrdersByLastUpdate: "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL",
  returnsByReturnDate: "GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE",
} as const;

/* ============================================================================
 * Snapshot THUẦN (không I/O) — test được với mock
 * ==========================================================================*/

export type OrdersSnapshot = {
  sellerAccountId: string;
  orders: OrderRowInput[];
  returns: ReturnRowInput[];
  daily: OrderDailyRowInput;
  kpis: ReturnType<typeof orderKpis>;
  fbmQueue: FbmQueueItem[];
  returnsBreakdown: ReturnReasonSummary[];
  hotspots: ReturnType<typeof returnHotspots>;
  alerts: AlertRowInput[];
  warnings: string[];
  /** nguồn dữ liệu — KHÔNG bao giờ để mock lẫn vào số thật */
  dataSource: "report" | "mock";
  /** lần đồng bộ kế tiếp nên bắt đầu từ đâu (watermark) */
  nextWatermark: Date;
  deltaWindow: { lastUpdatedAfter: Date; watermark: Date };
};

/** dd-mm-yyyy hoặc ISO → Date (report trả nhiều định dạng tuỳ marketplace) */
export function parseReportDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  // ISO 8601 — khớp CHÍNH XÁC pattern, không để new Date() tự đoán theo locale
  // (new Date("10/09/2026 08:30") cho ra 09/10/2026 kiểu Mỹ → sai ngày của report EU).
  const iso = s.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/,
  );
  if (iso) {
    const [, y, mo, d, hh = "0", mi = "0", ss = "0", tz] = iso;
    let ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi), Number(ss));
    if (tz && tz.toUpperCase() !== "Z") {
      const off = /^([+-])(\d{2}):?(\d{2})$/.exec(tz);
      if (off) ms -= (off[1] === "-" ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3])) * 60_000;
    }
    const dt = new Date(ms);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  // dd-mm-yyyy hoặc dd/mm/yyyy (kèm giờ tuỳ chọn)
  const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const [, d, mo, y, hh = "0", mm = "0", ss = "0"] = m;
    const dt = new Date(
      Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss)),
    );
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  // yyyy-mm-dd không giờ
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) {
    const dt = new Date(Date.UTC(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  return null;
}

function toOrderRow(sellerAccountId: string, order: ParsedOrder, marketplaceId?: string | null): OrderRowInput {
  return {
    sellerAccountId,
    amazonOrderId: order.amazonOrderId,
    merchantOrderId: order.merchantOrderId,
    status: order.orderStatus,
    channel: order.fulfillmentChannel,
    purchaseDate: parseReportDate(order.purchaseDate) ?? new Date(0),
    lastUpdatedDate: parseReportDate(order.lastUpdatedDate),
    orderTotal: order.orderTotal,
    currency: order.currency ?? "USD",
    itemsCount: order.itemsCount,
    marketplaceId: marketplaceId ?? null,
    orderItems: order.items.map((i) => ({
      amazonOrderItemId: i.orderItemId,
      sku: i.sku,
      asin: i.asin,
      itemName: i.productName,
      quantity: i.quantity,
      itemPrice: i.itemPrice,
      itemStatus: i.itemStatus,
    })),
  };
}

function toReturnRow(sellerAccountId: string, r: ReturnRowParsed): ReturnRowInput {
  return {
    sellerAccountId,
    amazonOrderId: r.amazonOrderId,
    amazonRmaId: r.amazonRmaId,
    returnDate: parseReportDate(r.returnRequestDate) ?? new Date(0),
    reason: r.reasonRaw,
    reasonLabel: r.reasonLabel,
    reasonGroup: r.reasonGroup,
    status: r.returnRequestStatus,
    resolution: r.resolution,
    refundAmount: r.refundedAmount,
    currency: r.currency ?? "USD",
    sku: r.sku,
    asin: r.asin,
    quantity: r.quantity,
    dedupeKey:
      r.amazonRmaId ??
      `NO-RMA:${r.amazonOrderId}:${r.sku ?? ""}:${r.returnRequestDate}:${r.quantity}`,
  };
}

/** dd-mm-yyyy theo UTC — khoá rollup ngày (kpi_daily dùng cùng quy ước) */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Dựng snapshot đơn hàng từ nội dung 2 report (thuần, không I/O).
 * `lastSyncAt = null` → lần chạy đầu (watermark = now).
 */
export function buildOrdersSnapshot(input: {
  sellerAccountId: string;
  ordersReportText: string;
  returnsReportText?: string;
  lastSyncAt?: Date | null;
  now?: Date;
  marketplaceId?: string | null;
  handlingHours?: number;
}): OrdersSnapshot {
  const now = input.now ?? new Date();
  const warnings: string[] = [];
  const cfg = DEFAULT_ORDERS_SYNC_CONFIG;

  const parsedOrders = parseAllOrdersReport(input.ordersReportText);
  warnings.push(...parsedOrders.warnings);
  const orders = groupOrders(parsedOrders.rows).map((o) => toOrderRow(input.sellerAccountId, o, input.marketplaceId));

  const parsedReturns = input.returnsReportText
    ? parseReturnsReport(input.returnsReportText)
    : { rows: [], warnings: [] };
  warnings.push(...parsedReturns.warnings);
  const returns = parsedReturns.rows.map((r) => toReturnRow(input.sellerAccountId, r));

  const kpis = orderKpis(
    orders.map((o) => ({
      amazonOrderId: o.amazonOrderId,
      status: o.status,
      fulfillmentChannel: o.channel,
      purchaseDate: o.purchaseDate.toISOString(),
      latestShipDate: null,
      orderTotal: o.orderTotal,
      itemsCount: o.itemsCount,
      sku: o.orderItems[0]?.sku ?? null,
      currency: o.currency,
    })),
  );

  // Hạn ship thật không có trong report → dùng fallback purchaseDate + handling,
  // đánh dấu rõ để UI hiển thị "hạn ước lượng" (xem fbmQueue[].deadlineAssumed).
  const fbmQueue = buildFbmQueue(
    orders.map((o) => ({
      amazonOrderId: o.amazonOrderId,
      status: o.status,
      fulfillmentChannel: o.channel,
      purchaseDate: o.purchaseDate.toISOString(),
      latestShipDate: null,
      orderTotal: o.orderTotal,
      itemsCount: o.itemsCount,
      sku: o.orderItems[0]?.sku ?? null,
    })),
    now,
    { handlingHours: input.handlingHours ?? cfg.handlingHoursFallback },
  );

  const breakdown = returnsBreakdown(
    returns.map((r) => ({
      amazonOrderId: r.amazonOrderId,
      sku: r.sku,
      returnDate: r.returnDate.toISOString(),
      reason: r.reason,
      refundAmount: r.refundAmount,
      currency: r.currency,
    })),
  );

  const hotspots = returnHotspots(
    returns.map((r) => ({
      amazonOrderId: r.amazonOrderId,
      sku: r.sku,
      returnDate: r.returnDate.toISOString(),
      reason: r.reason,
      refundAmount: r.refundAmount,
    })),
    unitsBySku(parsedOrders.rows),
  );

  const alerts: AlertRowInput[] = [];
  const shipAlert = fbmShipAlert(fbmQueue);
  if (shipAlert) {
    alerts.push({
      sellerAccountId: input.sellerAccountId,
      ruleCode: shipAlert.ruleCode,
      severity: shipAlert.severity,
      title: shipAlert.title,
      detail: shipAlert.detail,
    });
  }
  const hot = hotspots.filter((h) => h.hot);
  if (hot.length > 0) {
    alerts.push({
      sellerAccountId: input.sellerAccountId,
      ruleCode: "return_reason_spike",
      severity: "amber",
      title: `${hot.length} SKU bị trả nhiều trong kỳ`,
      detail:
        hot
          .slice(0, 5)
          .map((h) => `${h.sku}: ${h.returns} đơn trả${h.ratePct !== null ? ` (${h.ratePct}%)` : ""}`)
          .join(" · ") + " — rà chất lượng theo SOP-07.",
    });
  }

  const day = dayKey(now);
  const daily: OrderDailyRowInput = {
    sellerAccountId: input.sellerAccountId,
    day,
    ordersCount: kpis.orders,
    units: kpis.units,
    salesAmount: kpis.sales,
    currency: kpis.currency,
    fbmUnshipped: kpis.fbmUnshipped,
    fbmOverdue: fbmQueue.filter((q) => q.risk === "overdue").length,
    returnsCount: returns.length,
    returnsAmount: Math.round(returns.reduce((s, r) => s + Math.abs(r.refundAmount ?? 0), 0) * 100) / 100,
  };

  const deltaWindow = orderDeltaWindow(input.lastSyncAt ?? null, now);

  return {
    sellerAccountId: input.sellerAccountId,
    orders,
    returns,
    daily,
    kpis,
    fbmQueue,
    returnsBreakdown: breakdown,
    hotspots,
    alerts,
    warnings,
    dataSource: input.ordersReportText.trim().length > 0 ? "report" : "mock",
    nextWatermark: deltaWindow.watermark,
    deltaWindow,
  };
}

/* ============================================================================
 * Chạy thật (có I/O) — ghi xuống DB qua adapter
 * ==========================================================================*/

export type OrdersSyncResult = Omit<OrdersSnapshot, "orders" | "returns"> & {
  ordersProcessed: number;
  returnsProcessed: number;
  job: SyncJobRecord;
};

/**
 * Đồng bộ đơn hàng từ report (import thủ công hoặc tải qua Report API).
 * Ghi: sales.orders (+ items), sales.returns_refunds, sales.order_daily, ops.alerts.
 * Luôn ghi `connections.sync_jobs` để màn 0.2 thấy được job này.
 */
export async function runOrdersSync(
  input: {
    sellerAccountId: string;
    ordersReportText: string;
    returnsReportText?: string;
    lastSyncAt?: Date | null;
    now?: Date;
    marketplaceId?: string | null;
    handlingHours?: number;
  },
  adapter: DbAdapter,
): Promise<OrdersSyncResult> {
  const now = input.now ?? new Date();
  const snapshot = buildOrdersSnapshot(input);

  const job: SyncJobRecord = {
    sellerAccountId: input.sellerAccountId,
    jobType: "orders.sync",
    status: "running",
    startedAt: now,
    payload: {
      deltaFrom: snapshot.deltaWindow.lastUpdatedAfter.toISOString(),
      orders: snapshot.orders.length,
      returns: snapshot.returns.length,
      dataSource: snapshot.dataSource,
    },
  };
  await adapter.recordSyncJob(job);

  try {
    await adapter.upsertOrders(snapshot.orders);
    await adapter.upsertReturns(snapshot.returns);
    await adapter.upsertOrderDaily(snapshot.daily);
    for (const alert of snapshot.alerts) await adapter.upsertAlert(alert);

    job.status = "done";
    job.finishedAt = new Date();
    await adapter.recordSyncJob(job);
  } catch (e) {
    job.status = "failed";
    job.finishedAt = new Date();
    job.lastError = (e as Error).message;
    await adapter.recordSyncJob(job);
    throw e;
  }

  const { orders, returns, ...rest } = snapshot;
  return {
    ...rest,
    ordersProcessed: orders.length,
    returnsProcessed: returns.length,
    job,
  };
}

/** Nhắc rõ trong code: các operation bị khoá vì PII (quyết định v1.1). */
export const PII_LOCKED_OPERATIONS = [
  "getOrderAddress",
  "getOrderBuyerInfo",
  "getOrderItemsBuyerInfo",
] as const;
