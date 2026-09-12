/**
 * Test Module 4 — parser report + job đồng bộ + handler notification ORDER_CHANGE.
 * Khoá: cột PII bị bỏ, gom đơn/tiền, chống trùng khi import lại, alert FBM.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MockDbAdapter } from "../src/db/adapter.ts";
import {
  ALL_ORDERS_PII_COLUMNS,
  groupOrders,
  parseAllOrdersReport,
  unitsBySku,
} from "../src/reports/all-orders.parser.ts";
import { parseReturnsReport } from "../src/reports/returns.parser.ts";
import {
  DEFAULT_ORDERS_SYNC_CONFIG,
  ORDERS_REPORT_TYPES,
  PII_LOCKED_OPERATIONS,
  buildOrdersSnapshot,
  dayKey,
  parseReportDate,
  runOrdersSync,
} from "../src/jobs/orders-sync.job.ts";
import {
  extractOrderChange,
  handleOrderChange,
  isOrderChange,
  normalizeOrderChange,
} from "../src/notifications/orders.handler.ts";

/* ============================================================================
 * Fixture: report Orders By Last Update (order-tracking — không có PII Amazon gửi kèm)
 * ==========================================================================*/

const ORDERS_TSV = [
  "amazon-order-id\tmerchant-order-id\tpurchase-date\tlast-updated-date\torder-status\torder-item-id\tfulfillment-channel\tsales-channel\torder-channel\tship-service-level\tproduct-name\tsku\tasin\titem-status\tquantity\tcurrency\titem-price\titem-tax\tshipping-price\tshipping-tax\tgift-wrap-price\tgift-wrap-tax\titem-promotion-discount\tship-promotion-discount\tship-city\tship-state\tship-postal-code\tship-country\tpromotion-ids\tis-business-order\tpurchase-order-number\tprice-designation",
  "111-1111111-1111111\t\t2026-09-09T08:00:00Z\t2026-09-10T09:00:00Z\tUnshipped\tOIID-1\tMFN\tAmazon.com\tAmazon.com\tStd US Dom\tMáy lọc không khí XMO\tXMO-950-BLK\tB0C7T31F\tUnshipped\t2\tUSD\t129.99\t0.00\t0.00\t0.00\t0.00\t0.00\t10.00\t0.00\tHouston\tTX\t77002\tUS\t\tfalse\t\tRetail",
  "111-1111111-1111111\t\t2026-09-09T08:00:00Z\t2026-09-10T09:00:00Z\tUnshipped\tOIID-2\tMFN\tAmazon.com\tAmazon.com\tStd US Dom\tLọc thay thế\tXMO-FLT-01\tB0C7T31G\tUnshipped\t1\tUSD\t19.50\t1.50\t0.00\t0.00\t0.00\t0.00\t0.00\t0.00\tHouston\tTX\t77002\tUS\t\tfalse\t\tRetail",
  "222-2222222-2222222\t\t2026-09-08T01:00:00Z\t2026-09-10T02:00:00Z\tShipped\tOIID-3\tAFN\tAmazon.com\tAmazon.com\tExpedited\tMáy hút ẩm VPN\tVPN-220-PRO\tB0DEMO0002\tShipped\t1\tUSD\t240.00\t0.00\t0.00\t0.00\t0.00\t0.00\t0.00\t0.00\tDallas\tTX\t75201\tUS\t\tfalse\t\tRetail",
].join("\n");

const RETURNS_TSV = [
  "Order ID\tOrder date\tReturn request date\tReturn request status\tAmazon RMA ID\tMerchant RMA ID\tLabel type\tLabel cost\tCurrency code\tReturn carrier\tTracking ID\tLabel to be paid by\tA-to-Z Claim\tIs prime\tASIN\tMerchant SKU\tItem Name\tReturn quantity\tReturn Reason\tIn policy\tReturn type\tResolution\tInvoice number\tReturn delivery date\tOrder Amount\tOrder quantity\tSafeT Action reason\tSafeT claim id\tSafeT claim state\tSafeT claim creation time\tSafeT claim reimbursement amount\tRefunded Amount",
  "111-1111111-1111111\t2026-09-09T08:00:00Z\t2026-09-15T10:00:00Z\tCompleted\tRMA-1\t\tMerchant\t5.99\tUSD\tUSPS\t9400111111111111111111\tMerchant\tfalse\ttrue\tB0C7T31F\tXMO-950-BLK\tMáy lọc không khí XMO\t1\tItem defective or doesn't work\tYes\tReturn\tRefund\t\t2026-09-18T10:00:00Z\t129.99\t2\t\t\t\t\t\t129.99",
  "111-1111111-1111111\t2026-09-09T08:00:00Z\t2026-09-16T10:00:00Z\tCompleted\tRMA-2\t\tMerchant\t5.99\tUSD\tUSPS\t9400111111111111111112\tMerchant\tfalse\tfalse\tB0C7T31F\tXMO-950-BLK\tMáy lọc không khí XMO\t1\tNo longer needed\tNo\tReturn\tRefund\t\t2026-09-19T10:00:00Z\t129.99\t2\t\t\t\t\t\t120.00",
  "222-2222222-2222222\t2026-09-08T01:00:00Z\t2026-09-14T10:00:00Z\tCompleted\tRMA-3\t\tAmazon\t0.00\tUSD\tAmazon\t\tAmazon\tfalse\ttrue\tB0DEMO0002\tVPN-220-PRO\tMáy hút ẩm VPN\t1\tArrived too late\tYes\tReturn\tRefund\t\t2026-09-20T10:00:00Z\t240.00\t1\t\t\t\t\t\t240.00",
].join("\n");

/* ============================================================================
 * Parser orders
 * ==========================================================================*/

describe("parseAllOrdersReport", () => {
  test("parse đủ dòng và không lọt cột PII vào object", () => {
    const res = parseAllOrdersReport(ORDERS_TSV);
    assert.equal(res.rows.length, 3);
    assert.equal(res.hasShipDeadline, false); // report tracking không có hạn ship
    assert.deepEqual(res.droppedPiiColumns, [...ALL_ORDERS_PII_COLUMNS]);
    assert.match(res.warnings.join(" "), /loại 2 cột PII/);

    const row = res.rows[0];
    assert.equal(row.amazonOrderId, "111-1111111-1111111");
    assert.equal(row.sku, "XMO-950-BLK");
    assert.equal(row.quantity, 2);
    assert.equal(row.itemPrice, 129.99);
    assert.equal(row.shipState, "TX");
    assert.equal(row.shipCountry, "US");
    // khẳng định cứng: không có thuộc tính nào chứa thành phố / mã bưu chính
    assert.equal("shipCity" in row, false);
    assert.equal("shipPostalCode" in row, false);
  });

  test("report rỗng → không dòng + cảnh báo", () => {
    const res = parseAllOrdersReport("");
    assert.equal(res.rows.length, 0);
    assert.match(res.warnings[0], /rỗng/);
  });

  test("thiếu cột bắt buộc → trả rỗng kèm tên cột thiếu", () => {
    const res = parseAllOrdersReport("amazon-order-id\torder-status\n1\tShipped");
    assert.equal(res.rows.length, 0);
    assert.match(res.warnings.join(" "), /Thiếu cột bắt buộc/);
  });
});

describe("groupOrders / unitsBySku", () => {
  test("gộp 2 dòng item thành 1 đơn, cộng tiền theo công thức item total", () => {
    const orders = groupOrders(parseAllOrdersReport(ORDERS_TSV).rows);
    assert.equal(orders.length, 2);
    const o1 = orders.find((o) => o.amazonOrderId === "111-1111111-1111111")!;
    assert.equal(o1.itemsCount, 3);
    // (129.99 + 0 + 0 + 0 − 10) + (19.50 + 1.50) = 119.99 + 21 = 140.99
    assert.equal(o1.orderTotal, 140.99);
    assert.equal(o1.items.length, 2);
    assert.equal(o1.sku, "XMO-950-BLK"); // SKU chính = dòng đầu
    assert.equal(o1.fulfillmentChannel, "MFN");
  });

  test("unitsBySku đếm đơn vị bán theo SKU", () => {
    const units = unitsBySku(parseAllOrdersReport(ORDERS_TSV).rows);
    assert.deepEqual(units, { "XMO-950-BLK": 2, "XMO-FLT-01": 1, "VPN-220-PRO": 1 });
  });
});

/* ============================================================================
 * Parser returns
 * ==========================================================================*/

describe("parseReturnsReport", () => {
  test("parse đủ cột chính + dịch lý do", () => {
    const res = parseReturnsReport(RETURNS_TSV);
    assert.equal(res.rows.length, 3);
    const r = res.rows[0];
    assert.equal(r.amazonOrderId, "111-1111111-1111111");
    assert.equal(r.amazonRmaId, "RMA-1");
    assert.equal(r.sku, "XMO-950-BLK");
    assert.equal(r.quantity, 1);
    assert.equal(r.refundedAmount, 129.99);
    assert.equal(r.reasonGroup, "quality");
    assert.equal(r.reasonLabel, "Hàng lỗi / hư hỏng / thiếu phụ kiện");
    assert.equal(r.aToZClaim, false);
    assert.equal(r.isPrime, true);
  });

  test("thiếu cột Refunded Amount → lấy Order Amount làm giá trị hoàn", () => {
    const tsv = [
      "Order ID\tReturn request date\tMerchant SKU\tReturn Reason\tOrder Amount",
      "1-2-3\t2026-09-15T10:00:00Z\tSKU-1\tDamaged\t49.99",
    ].join("\n");
    const res = parseReturnsReport(tsv);
    assert.equal(res.rows[0].refundedAmount, 49.99);
    assert.match(res.warnings.join(" "), /cột tuỳ chọn/);
  });
});

/* ============================================================================
 * Snapshot + job
 * ==========================================================================*/

describe("buildOrdersSnapshot", () => {
  const NOW = new Date("2026-09-10T12:00:00Z");

  test("KPI, daily rollup, queue FBM và alert trễ hạn", () => {
    const snap = buildOrdersSnapshot({
      sellerAccountId: "shop-1",
      ordersReportText: ORDERS_TSV,
      returnsReportText: RETURNS_TSV,
      now: NOW,
    });

    assert.equal(snap.orders.length, 2);
    assert.equal(snap.returns.length, 3);
    assert.equal(snap.kpis.fbmUnshipped, 1);
    assert.equal(snap.daily.day, "2026-09-10");
    assert.equal(snap.daily.returnsCount, 3);
    assert.equal(snap.daily.returnsAmount, 489.99);
    assert.equal(snap.dataSource, "report");

    // Đơn MFN hạn 2026-09-10T08:00 (purchase 09-09 08:00 + 24h) → đã trễ lúc 12:00
    assert.equal(snap.fbmQueue.length, 1);
    assert.equal(snap.fbmQueue[0].risk, "overdue");
    assert.equal(snap.fbmQueue[0].deadlineAssumed, true);
    assert.equal(snap.alerts.length >= 1, true);
    assert.equal(snap.alerts[0].ruleCode, "fbm_late_ship");
    assert.equal(snap.alerts[0].severity, "red");

    // SKU XMO-950-BLK có 2 đơn trả → vượt ngưỡng hotspot? 2 < 3 đơn, tỷ lệ 2/2=100% ≥ 5% → hot
    const hotspot = snap.hotspots.find((h) => h.sku === "XMO-950-BLK")!;
    assert.equal(hotspot.hot, true);
    assert.equal(hotspot.ratePct, 100);
  });

  test("nguồn dữ liệu quyết định cờ dataSource (mock khi report rỗng)", () => {
    const snap = buildOrdersSnapshot({ sellerAccountId: "s", ordersReportText: " ", now: NOW });
    assert.equal(snap.dataSource, "mock");
    assert.equal(snap.orders.length, 0);
  });

  test("config bám đúng số liệu SP-API đã kiểm chứng", () => {
    assert.equal(DEFAULT_ORDERS_SYNC_CONFIG.requestsPerSecond, 0.0167);
    assert.equal(DEFAULT_ORDERS_SYNC_CONFIG.burst, 20);
    assert.equal(DEFAULT_ORDERS_SYNC_CONFIG.orderItemsRequestsPerSecond, 0.5);
    assert.equal(DEFAULT_ORDERS_SYNC_CONFIG.maxResultsPerPage, 100);
    assert.equal(DEFAULT_ORDERS_SYNC_CONFIG.reportRetentionDays, 30);
    assert.equal(DEFAULT_ORDERS_SYNC_CONFIG.returnsMaxRangeDays, 60);
    assert.equal(ORDERS_REPORT_TYPES.allOrdersByLastUpdate, "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL");
    assert.equal(ORDERS_REPORT_TYPES.returnsByReturnDate, "GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE");
  });

  test("các operation PII bị khoá tường minh", () => {
    assert.deepEqual([...PII_LOCKED_OPERATIONS], ["getOrderAddress", "getOrderBuyerInfo", "getOrderItemsBuyerInfo"]);
  });
});

describe("runOrdersSync — ghi DB (MockDbAdapter)", () => {
  const NOW = new Date("2026-09-10T12:00:00Z");

  test("ghi orders, order_items, returns, daily, alert, sync_jobs", async () => {
    const db = new MockDbAdapter();
    const result = await runOrdersSync(
      { sellerAccountId: "shop-1", ordersReportText: ORDERS_TSV, returnsReportText: RETURNS_TSV, now: NOW },
      db,
    );

    assert.equal(result.ordersProcessed, 2);
    assert.equal(result.returnsProcessed, 3);
    assert.equal(db.orders.length, 2);
    assert.equal(db.orders.find((o) => o.amazonOrderId === "111-1111111-1111111")!.orderItems.length, 2);
    assert.equal(db.returns.length, 3);
    assert.equal(db.orderDaily.length, 1);
    assert.equal(db.alerts.length, 2); // fbm_late_ship + return_reason_spike
    assert.equal(db.jobs.at(-1)!.status, "done");
    assert.equal(db.jobs.at(-1)!.jobType, "orders.sync");
  });

  test("import lại cùng report → KHÔNG nhân đôi (idempotent)", async () => {
    const db = new MockDbAdapter();
    await runOrdersSync({ sellerAccountId: "shop-1", ordersReportText: ORDERS_TSV, returnsReportText: RETURNS_TSV, now: NOW }, db);
    await runOrdersSync({ sellerAccountId: "shop-1", ordersReportText: ORDERS_TSV, returnsReportText: RETURNS_TSV, now: NOW }, db);

    assert.equal(db.orders.length, 2);
    assert.equal(db.orders[0].orderItems.length, 2);
    assert.equal(db.returns.length, 3);
    assert.equal(db.orderDaily.length, 1);
    assert.equal(db.alerts.length, 2);
  });

  test("lỗi khi ghi → sync_jobs ghi failed rồi ném lỗi tiếp", async () => {
    const db = new MockDbAdapter();
    db.upsertOrders = async () => {
      throw new Error("boom");
    };
    await assert.rejects(
      () => runOrdersSync({ sellerAccountId: "shop-1", ordersReportText: ORDERS_TSV, now: NOW }, db),
      /boom/,
    );
    assert.equal(db.jobs.at(-1)!.status, "failed");
    assert.equal(db.jobs.at(-1)!.lastError, "boom");
  });
});

describe("parseReportDate / dayKey", () => {
  test("ISO có giờ", () => {
    assert.equal(parseReportDate("2026-09-10T12:34:56Z")!.toISOString(), "2026-09-10T12:34:56.000Z");
  });
  test("dd-mm-yyyy (report EU)", () => {
    assert.equal(parseReportDate("10-09-2026")!.toISOString(), "2026-09-10T00:00:00.000Z");
    assert.equal(parseReportDate("10/09/2026 08:30")!.toISOString(), "2026-09-10T08:30:00.000Z");
  });
  test("yyyy-mm-dd", () => {
    assert.equal(parseReportDate("2026-09-10")!.toISOString(), "2026-09-10T00:00:00.000Z");
  });
  test("giá trị rác → null (không đoán)", () => {
    assert.equal(parseReportDate("not-a-date"), null);
    assert.equal(parseReportDate(""), null);
    assert.equal(parseReportDate(null), null);
  });
  test("dayKey theo UTC", () => {
    assert.equal(dayKey(new Date("2026-09-10T23:59:59Z")), "2026-09-10");
  });
});

/* ============================================================================
 * Notification ORDER_CHANGE
 * ==========================================================================*/

const ORDER_CHANGE = {
  NotificationVersion: "1.0",
  NotificationType: "ORDER_CHANGE",
  PayloadVersion: "1.0",
  EventTime: "2026-09-10T09:05:00.000Z",
  Payload: {
    OrderChangeNotification: {
      NotificationLevel: "OrderLevel",
      SellerId: "AQMVYI4HJTI4C",
      AmazonOrderId: "903-8868176-2219830",
      OrderChangeType: "BuyerRequestedChange",
      OrderChangeTrigger: { TimeOfOrderChange: "2026-09-10T09:00:00.000Z", ChangeReason: "Buyer Requested Cancel" },
      Summary: {
        MarketplaceId: "ATVPDKIKX0DER",
        OrderStatus: "Unshipped",
        PurchaseDate: "2026-09-10T08:00:00.000Z",
        DestinationPostalCode: "48110",
        FulfillmentType: "MFN",
        OrderType: "StandardOrder",
        NumberOfItemsShipped: 0,
        NumberOfItemsUnshipped: 2,
        LatestShipDate: "2026-09-10T10:00:00.000Z",
        OrderItems: [
          { OrderItemId: "OIID-1", SellerSKU: "XMO-950-BLK", Quantity: 1, IsBuyerRequestedCancel: true },
          { OrderItemId: "OIID-2", SellerSKU: "XMO-FLT-01", Quantity: 1 },
        ],
      },
    },
  },
  NotificationMetadata: { ApplicationId: "app", SubscriptionId: "sub", PublishTime: "2026-09-10T09:05:00.000Z", NotificationId: "n1" },
};

describe("ORDER_CHANGE handler", () => {
  test("nhận diện đúng notification", () => {
    assert.equal(isOrderChange(ORDER_CHANGE), true);
    assert.equal(isOrderChange({ NotificationType: "ANY_OFFER_CHANGED" }), false);
    assert.equal(extractOrderChange(ORDER_CHANGE)!.AmazonOrderId, "903-8868176-2219830");
  });

  test("nhận cả kiểu camelCase (SQS/EventBridge)", () => {
    const camel = {
      notificationType: "ORDER_CHANGE",
      payload: { orderChangeNotification: { AmazonOrderId: "111-1-1", Summary: { OrderStatus: "Shipped", FulfillmentType: "AFN" } } },
    };
    assert.equal(isOrderChange(camel), true);
    const n = extractOrderChange(camel)!;
    assert.equal(n.Summary!.FulfillmentType, "AFN");
  });

  test("BÓC PII: DestinationPostalCode không lọt vào bản lưu DB", () => {
    const normalized = normalizeOrderChange(extractOrderChange(ORDER_CHANGE)!);
    assert.deepEqual(normalized.droppedPiiFields, ["DestinationPostalCode"]);
    assert.equal("destinationPostalCode" in normalized, false);
    assert.equal(JSON.stringify(normalized).includes("48110"), false);
  });

  test("xử lý: upsert đơn + alert FBM gấp (hạn 10:00, nhận lúc 09:30 → critical)", async () => {
    const db = new MockDbAdapter();
    const result = await handleOrderChange(ORDER_CHANGE, db, {
      sellerAccountId: "shop-1",
      now: new Date("2026-09-10T09:30:00Z"),
    });

    assert.equal(result!.amazonOrderId, "903-8868176-2219830");
    assert.equal(result!.buyerRequestedCancel, true);
    assert.equal(result!.droppedPiiFields.length, 1);

    assert.equal(db.orders.length, 1);
    assert.equal(db.orders[0].orderItems.length, 2);
    assert.equal(db.orders[0].orderTotal, null); // notification không có giá
    assert.equal(db.notifications.length, 1);
    assert.equal(db.notifications[0].notificationType, "ORDER_CHANGE");
    // PII bị bỏ khỏi cả raw đã lưu
    assert.equal(JSON.stringify(db.notifications[0].raw).includes("48110"), false);

    assert.equal(db.alerts.length, 1);
    assert.equal(db.alerts[0].ruleCode, "fbm_late_ship");
    assert.equal(db.alerts[0].severity, "amber"); // còn 30 phút → critical (<4h) nhưng chưa quá hạn
  });

  test("notification không phải ORDER_CHANGE → bỏ qua (null)", async () => {
    const db = new MockDbAdapter();
    const result = await handleOrderChange({ NotificationType: "ANY_OFFER_CHANGED", Payload: {} }, db, {
      sellerAccountId: "shop-1",
    });
    assert.equal(result, null);
    assert.equal(db.orders.length, 0);
  });
});
