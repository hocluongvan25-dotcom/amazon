/**
 * Test Module 4 — đường Orders API v0 (SP-API) mới thêm 16/09/2026.
 *
 * Vì sao có bộ test này: đây là đường DUY NHẤT đưa đơn hàng về DB mà trước đây
 * repo chỉ có tài liệu mô tả. Sai một tham số bắt buộc (`MarketplaceIds`) hoặc
 * hiểu sai trần tốc độ (0.0167 rps · burst 20) là job lỗi/429 trong im lặng —
 * đúng loại lỗi đã khiến màn /orders trống suốt thời gian dài.
 *
 * Chạy: cd web && npm test   (node --experimental-strip-types --test)
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  PII_LOCKED_PATHS,
  apiItemToRowInput,
  apiOrderToRowInput,
  assertMarketplaceIds,
  clampMaxResultsPerPage,
  isPiiLockedPath,
  moneyToNumber,
  normalizeApiOrderStatus,
  orderDailyFromApiOrders,
  type ApiOrder,
} from "../src/lib/worker/domain/orders-api.ts";
import {
  ORDERS_RATE_LIMIT,
  OrdersClient,
  TokenBucket,
  clampTooRecentBefore,
  ordersHostForRegion,
} from "../src/lib/worker/amazon/orders.ts";
import {
  SP_API_BEFORE_SAFETY_MARGIN_MINUTES,
  SP_API_ORDERS_DATA_LAG_MINUTES,
  spApiSafeBefore,
} from "../src/lib/worker/domain/orders.ts";
import { groupOrdersByDay, runOrdersSyncAll, utcDayKey } from "../src/lib/worker/run-orders-sync.ts";
import type { DbAdapter, OrderRowInput } from "../src/lib/worker/db/adapter.ts";
import type { LwaTokenManager } from "../src/lib/worker/amazon/lwa.ts";

/* ------------------------------- fixtures ------------------------------- */

const ORDER_OK: ApiOrder = {
  AmazonOrderId: "112-1234567-1234567",
  SellerOrderId: "SO-1",
  PurchaseDate: "2026-09-14T10:00:00Z",
  LastUpdateDate: "2026-09-15T08:30:00Z",
  OrderStatus: "Unshipped",
  FulfillmentChannel: "MFN",
  MarketplaceId: "ATVPDKIKX0DER",
  OrderTotal: { Amount: "39.99", CurrencyCode: "USD" },
  NumberOfItemsShipped: 1,
  NumberOfItemsUnshipped: 2,
  LatestShipDate: "2020-01-01T00:00:00Z",
  // PII có trong response THẬT — mapper phải bỏ qua, không ghi vào DB.
  ShippingAddress: { City: "Seattle", PostalCode: "98101" },
  BuyerInfo: { BuyerEmail: "a@b.com" },
};

const ITEM_OK = {
  OrderItemId: "OI-1",
  SellerSKU: "VXL-20",
  ASIN: "B0TESTASIN",
  Title: "Vali size 20",
  QuantityOrdered: 2,
  QuantityShipped: 0,
  ItemPrice: { Amount: "29.50", CurrencyCode: "USD" },
  BuyerInfo: { BuyerEmail: "a@b.com" },
};

const lwaFake = { getAccessToken: async () => "tok" } as unknown as LwaTokenManager;

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/* --------------------------- luật tham số bắt buộc --------------------------- */

test("assertMarketplaceIds: getOrders THIẾU MarketplaceIds là lỗi nói rõ cách sửa", () => {
  assert.throws(() => assertMarketplaceIds([]), /MarketplaceIds/);
  assert.throws(() => assertMarketplaceIds(["  ", ""]), /MarketplaceIds/);
  assert.deepEqual(assertMarketplaceIds([" ATVPDKIKX0DER "]), ["ATVPDKIKX0DER"]);
});

test("clampMaxResultsPerPage: kẹp vào 1..100 theo model Orders v0", () => {
  assert.equal(clampMaxResultsPerPage(undefined), 100);
  assert.equal(clampMaxResultsPerPage(0), 100);
  assert.equal(clampMaxResultsPerPage(-3), 100);
  assert.equal(clampMaxResultsPerPage(37), 37);
  assert.equal(clampMaxResultsPerPage(5000), 100);
});

test("moneyToNumber: chuỗi tiền của Amazon → số, giá trị lạ → null (không bịa 0)", () => {
  assert.equal(moneyToNumber({ Amount: "12.34", CurrencyCode: "USD" }), 12.34);
  assert.equal(moneyToNumber({ Amount: 7 }), 7);
  assert.equal(moneyToNumber(null), null);
  assert.equal(moneyToNumber({ Amount: "n/a" }), null);
});

test("normalizeApiOrderStatus: giữ nguyên văn trạng thái Amazon, rỗng → Unknown", () => {
  assert.equal(normalizeApiOrderStatus("Unshipped"), "Unshipped");
  assert.equal(normalizeApiOrderStatus(" PartiallyShipped "), "PartiallyShipped");
  assert.equal(normalizeApiOrderStatus(null), "Unknown");
});

/* --------------------------------- mapping -------------------------------- */

test("apiOrderToRowInput: ánh xạ đúng cột DB, KHÔNG mang PII địa chỉ/người mua", () => {
  const row = apiOrderToRowInput("shop-1", ORDER_OK, [ITEM_OK]);
  assert.ok(row);
  assert.equal(row.amazonOrderId, "112-1234567-1234567");
  assert.equal(row.merchantOrderId, "SO-1");
  assert.equal(row.status, "Unshipped");
  assert.equal(row.channel, "MFN");
  assert.equal(row.orderTotal, 39.99);
  assert.equal(row.currency, "USD");
  assert.equal(row.itemsCount, 3); // 1 shipped + 2 unshipped
  assert.equal(row.marketplaceId, "ATVPDKIKX0DER");
  // Đường API không có quyền đọc địa chỉ (PII) ⇒ để null, có chủ đích.
  assert.equal(row.shipState, null);
  assert.equal(row.shipCountry, null);
  assert.equal(row.orderItems.length, 1);
  assert.equal(row.orderItems[0].sku, "VXL-20");
  assert.equal(row.orderItems[0].quantity, 2);
  assert.equal(row.orderItems[0].itemPrice, 29.5);
  assert.equal(JSON.stringify(row).includes("Seattle"), false);
  assert.equal(JSON.stringify(row).includes("a@b.com"), false);
});

test("apiOrderToRowInput: thiếu AmazonOrderId hoặc PurchaseDate ⇒ bỏ (không ghi rác)", () => {
  assert.equal(apiOrderToRowInput("s", { ...ORDER_OK, AmazonOrderId: "" }), null);
  assert.equal(apiOrderToRowInput("s", { ...ORDER_OK, PurchaseDate: null }), null);
  assert.equal(apiOrderToRowInput("s", { ...ORDER_OK, PurchaseDate: "không-phải-ngày" }), null);
});

test("apiItemToRowInput: item thiếu OrderItemId bị bỏ (khoá upsert)", () => {
  assert.equal(apiItemToRowInput({ OrderItemId: "" }), null);
  assert.equal(apiItemToRowInput({ SellerSKU: "X" }), null);
});

test("orderDailyFromApiOrders: loại đơn Canceled, cộng đúng units/sales, đếm FBM chờ ship", () => {
  const now = new Date("2026-09-16T00:00:00Z");
  // Đơn chờ ship nhưng mốc cập nhật nguồn đã cũ > 24h ⇒ tính là QUÁ HẠN (đường API
  // không có latest-ship-date thật trong tổng hợp này; xem doc của fbmOverdue).
  const pending = apiOrderToRowInput("s", { ...ORDER_OK, LastUpdateDate: "2026-09-13T00:00:00Z" }, [ITEM_OK])!;
  const canceled = apiOrderToRowInput(
    "s",
    { ...ORDER_OK, AmazonOrderId: "X-2", OrderStatus: "Canceled", OrderTotal: { Amount: "10.00", CurrencyCode: "USD" } },
    [{ ...ITEM_OK, OrderItemId: "OI-2" }],
  )!;
  const daily = orderDailyFromApiOrders("s", "2026-09-14", [pending, canceled], now);
  assert.equal(daily.ordersCount, 1);
  assert.equal(daily.units, 2);
  assert.equal(daily.salesAmount, 39.99);
  assert.equal(daily.fbmUnshipped, 1);
  assert.equal(daily.fbmOverdue, 1); // lastUpdated 15/09 08:30 > 24h trước mốc now
  assert.equal(daily.returnsCount, 0);
});

/* ---------------------------------- PII ---------------------------------- */

test("isPiiLockedPath: 3 endpoint PII bị khoá, đường thường không bị", () => {
  assert.equal(PII_LOCKED_PATHS.length, 3);
  assert.equal(isPiiLockedPath("/orders/v0/orders/112-1/address"), true);
  assert.equal(isPiiLockedPath("/orders/v0/orders/112-1/buyerInfo"), true);
  assert.equal(isPiiLockedPath("/orders/v0/orders/112-1/orderItems/buyerInfo"), true);
  assert.equal(isPiiLockedPath("/orders/v0/orders/112-1/orderItems"), false);
  assert.equal(isPiiLockedPath("/orders/v0/orders"), false);
});

/* ------------------------------- rate limit ------------------------------- */

test("ORDERS_RATE_LIMIT: đúng số trong model chính thức (không tự nới)", () => {
  assert.equal(ORDERS_RATE_LIMIT.listOrders.rate, 0.0167);
  assert.equal(ORDERS_RATE_LIMIT.listOrders.burst, 20);
  assert.equal(ORDERS_RATE_LIMIT.orderItems.rate, 0.5);
  assert.equal(ORDERS_RATE_LIMIT.orderItems.burst, 30);
});

test("TokenBucket: tiêu hết burst thì phải chờ, chờ đúng 1/rate", () => {
  let t = 0;
  const bucket = new TokenBucket(0.0167, 20, () => t);
  for (let i = 0; i < 20; i += 1) {
    assert.equal(bucket.msUntilToken(), 0); // burst 20 đi ngay
    bucket.take();
  }
  const wait = bucket.msUntilToken();
  assert.ok(wait > 59_000 && wait <= 60_000, `chờ ~60s, nhận ${wait}`);
  t += 60_000; // đủ 1 token nạp lại
  assert.equal(bucket.msUntilToken(), 0);
});

test("ordersHostForRegion: NA/EU/FE/sandbox — sai host là 403/không thấy đơn", () => {
  assert.equal(ordersHostForRegion("NA"), "https://sellingpartnerapi-na.amazon.com");
  assert.equal(ordersHostForRegion("EU"), "https://sellingpartnerapi-eu.amazon.com");
  assert.equal(ordersHostForRegion("FE"), "https://sellingpartnerapi-fe.amazon.com");
  assert.equal(ordersHostForRegion("NA_SANDBOX"), "https://sandbox.sellingpartnerapi-na.amazon.com");
  assert.equal(ordersHostForRegion("lạ"), "https://sellingpartnerapi-na.amazon.com");
});

/* -------------------------------- HTTP client -------------------------------- */

test("getOrdersPage: gửi đủ MarketplaceIds/MaxResultsPerPage và đọc NextToken", async () => {
  const urls: string[] = [];
  const fetchFn = (async (url: string | URL) => {
    urls.push(String(url));
    if (urls.length === 1) {
      return jsonResponse({ payload: { Orders: [ORDER_OK], NextToken: "T1" } });
    }
    return jsonResponse({ payload: { Orders: [{ ...ORDER_OK, AmazonOrderId: "X-2" }] } });
  }) as unknown as typeof fetch;
  const client = new OrdersClient(lwaFake, { fetchFn, sleep: async () => {}, host: "https://example.test" });

  const res = await client.listOrders({ marketplaceIds: ["ATVPDKIKX0DER"], lastUpdatedAfter: new Date("2026-09-09T00:00:00Z") });
  assert.equal(res.orders.length, 2);
  assert.equal(res.pages, 2);
  assert.equal(res.truncated, false);
  assert.ok(urls[0].includes("StartIndex" ) === false);
  assert.ok(urls[0].includes("MarketplaceIds=ATVPDKIKX0DER"));
  assert.ok(urls[0].includes("MaxResultsPerPage=100"));
  assert.ok(urls[0].includes("LastUpdatedAfter=2026-09-09T00%3A00%3A00.000Z"));
  assert.equal(urls[0].includes("NextToken"), false);
  assert.ok(urls[1].includes("NextToken=T1"));
});

/* -------- chặn mốc "...Before" quá mới — sự cố 400 InvalidInput 16/09/2026 -------- */

test("spApiSafeBefore: lùi đúng 2 phút trễ dữ liệu + 1 phút biên độ đồng hồ", () => {
  const now = new Date("2026-09-16T10:00:00Z");
  assert.equal(SP_API_ORDERS_DATA_LAG_MINUTES, 2);
  assert.equal(SP_API_BEFORE_SAFETY_MARGIN_MINUTES, 1);
  assert.equal(spApiSafeBefore(now).toISOString(), "2026-09-16T09:57:00.000Z");
  assert.equal(spApiSafeBefore(now, 2).toISOString(), "2026-09-16T09:55:00.000Z");
});

test("clampTooRecentBefore: mốc mới hơn now−3 phút bị lùi về mốc an toàn; mốc cũ giữ nguyên", () => {
  const nowMs = new Date("2026-09-16T10:00:00Z").getTime();
  const logs: string[] = [];
  const log = (s: string): void => {
    logs.push(s);
  };
  // `now` và mốc TƯƠNG LAI đều bị kẹp về đúng now − 3 phút (2 trễ + 1 biên độ)
  assert.equal(clampTooRecentBefore("2026-09-16T10:00:00.000Z", log, nowMs), "2026-09-16T09:57:00.000Z");
  assert.equal(clampTooRecentBefore("2026-09-16T12:00:00.000Z", log, nowMs), "2026-09-16T09:57:00.000Z");
  // đúng mốc an toàn thì KHÔNG kẹp (chỉ kẹp khi mới hơn nghiêm ngặt)
  assert.equal(clampTooRecentBefore("2026-09-16T09:57:00.000Z", log, nowMs), "2026-09-16T09:57:00.000Z");
  // mốc đã đủ cũ → giữ nguyên, không log
  const old = "2026-09-10T00:00:00.000Z";
  assert.equal(clampTooRecentBefore(old, log, nowMs), old);
  assert.equal(logs.length, 2);
  assert.equal(clampTooRecentBefore(undefined, log, nowMs), undefined);
});

test("getOrdersPage: LastUpdatedBefore = now bị kẹp về mốc ≥ 2 phút trước hiện tại", async () => {
  const urls: string[] = [];
  const logs: string[] = [];
  const fetchFn = (async (url: string | URL) => {
    urls.push(String(url));
    return jsonResponse({ payload: { Orders: [] } });
  }) as unknown as typeof fetch;
  const client = new OrdersClient(lwaFake, {
    fetchFn,
    sleep: async () => {},
    host: "https://example.test",
    log: (s) => logs.push(s),
  });
  await client.listOrders({
    marketplaceIds: ["ATVPDKIKX0DER"],
    // mốc "tương lai" — chắc chắn bị Amazon coi là quá mới (độ trễ dữ liệu 2 phút)
    lastUpdatedBefore: new Date(Date.now() + 60_000),
  });
  const sent = new URL(urls[0]).searchParams.get("LastUpdatedBefore");
  assert.ok(sent, "phải gửi LastUpdatedBefore");
  const t = new Date(sent as string).getTime();
  assert.ok(t <= Date.now() - 2 * 60_000, `mốc gửi đi phải sớm hơn hiện tại ≥ 2 phút, nhận ${sent}`);
  assert.ok(t >= Date.now() - 10 * 60_000, `không được lùi quá xa gây mất dữ liệu, nhận ${sent}`);
  assert.ok(logs.some((l) => l.includes("tự lùi")), "phải log rõ việc tự lùi mốc");
});

test("getOrdersPage: mốc đủ cũ giữ nguyên; cửa sổ sập (Before ≤ After sau clamp) ⇒ lỗi TRƯỚC khi gọi mạng", async () => {
  const urls: string[] = [];
  const fetchFn = (async (url: string | URL) => {
    urls.push(String(url));
    return jsonResponse({ payload: { Orders: [] } });
  }) as unknown as typeof fetch;
  const client = new OrdersClient(lwaFake, { fetchFn, sleep: async () => {}, host: "https://example.test" });

  await client.listOrders({
    marketplaceIds: ["ATVPDKIKX0DER"],
    lastUpdatedAfter: new Date("2026-09-09T00:00:00Z"),
    lastUpdatedBefore: new Date("2026-09-10T00:00:00Z"),
  });
  assert.ok(urls[0].includes("LastUpdatedBefore=2026-09-10T00%3A00%3A00.000Z"));

  const callsBeforeReject = urls.length;
  // After và Before đều "quá mới": clamp lùi Before về now−3 phút ⇒ Before < After
  await assert.rejects(
    () =>
      client.listOrders({
        marketplaceIds: ["ATVPDKIKX0DER"],
        lastUpdatedAfter: new Date(Date.now() - 60_000),
        lastUpdatedBefore: new Date(Date.now() - 30_000),
      }),
    /không hợp lệ/i,
  );
  assert.equal(urls.length, callsBeforeReject, "KHÔNG được gọi mạng khi cửa sổ sập");
});

test("getOrdersPage: THIẾU MarketplaceIds ⇒ ném lỗi TRƯỚC khi gọi mạng", async () => {
  let called = 0;
  const fetchFn = (async () => {
    called += 1;
    return jsonResponse({});
  }) as unknown as typeof fetch;
  const client = new OrdersClient(lwaFake, { fetchFn, sleep: async () => {} });
  await assert.rejects(() => client.listOrders({ marketplaceIds: [] }), /MarketplaceIds/);
  assert.equal(called, 0);
});

test("client: 429 được thử lại rồi thành công; 403 ném lỗi có mã Amazon", async () => {
  let n = 0;
  const retrying = (async () => {
    n += 1;
    if (n === 1) return jsonResponse({ errors: [{ code: "QuotaExceeded", message: "slow down" }] }, { status: 429 });
    return jsonResponse({ payload: { Orders: [ORDER_OK] } });
  }) as unknown as typeof fetch;
  const okClient = new OrdersClient(lwaFake, { fetchFn: retrying, sleep: async () => {} });
  const res = await okClient.listOrders({ marketplaceIds: ["ATVPDKIKX0DER"] });
  assert.equal(res.orders.length, 1);
  assert.equal(n, 2);

  const forbidden = (async () =>
    jsonResponse({ errors: [{ code: "Unauthorized", message: "not authorized", details: "orders role missing" }] }, { status: 403 })) as unknown as typeof fetch;
  const badClient = new OrdersClient(lwaFake, { fetchFn: forbidden, sleep: async () => {} });
  await assert.rejects(
    () => badClient.listOrders({ marketplaceIds: ["ATVPDKIKX0DER"] }),
    (e: Error) => e.message.includes("not authorized") || e.message.includes("403"),
  );
});

test("listOrderItems: phân trang bằng NextToken, chỉ gửi orderId + NextToken", async () => {
  const urls: string[] = [];
  const fetchFn = (async (url: string | URL) => {
    urls.push(String(url));
    if (urls.length === 1) return jsonResponse({ payload: { OrderItems: [ITEM_OK], NextToken: "N1" } });
    return jsonResponse({ payload: { OrderItems: [{ ...ITEM_OK, OrderItemId: "OI-2" }] } });
  }) as unknown as typeof fetch;
  const client = new OrdersClient(lwaFake, { fetchFn, sleep: async () => {} });
  const res = await client.listOrderItems("112-1234567-1234567");
  assert.equal(res.items.length, 2);
  assert.equal(res.pages, 2);
  assert.ok(urls[0].endsWith("/orders/v0/orders/112-1234567-1234567/orderItems"));
  assert.ok(urls[1].includes("NextToken=N1"));
  assert.equal(urls[1].includes("MarketplaceIds"), false);
});

/* ------------------------- runner (adapter + client giả) ------------------------- */

type FakeDb = {
  adapter: DbAdapter;
  jobs: unknown[];
  orders: OrderRowInput[][];
  daily: unknown[];
  alerts: unknown[];
};

function fakeDb(): FakeDb {
  const store: FakeDb = { adapter: null as unknown as DbAdapter, jobs: [], orders: [], daily: [], alerts: [] };
  store.adapter = {
    recordSyncJob: async (job: unknown) => {
      store.jobs.push(job);
    },
    upsertOrders: async (rows: OrderRowInput[]) => {
      store.orders.push(rows);
    },
    upsertOrderDaily: async (row: unknown) => {
      store.daily.push(row);
    },
    upsertAlert: async (row: unknown) => {
      store.alerts.push(row);
    },
  } as unknown as DbAdapter;
  return store;
}

type ListQueryLike = {
  marketplaceIds?: readonly string[];
  lastUpdatedAfter?: Date;
  lastUpdatedBefore?: Date;
};

function fakeClient(
  orders: ApiOrder[],
  opts: { onItem?: (id: string) => void; onList?: (q: ListQueryLike) => void } = {},
) {
  return {
    listOrders: async (q: ListQueryLike) => {
      opts.onList?.(q);
      return { orders, pages: 1, truncated: false, throttled: false, requestId: "r1", rateLimitHint: null };
    },
    listOrderItems: async (id: string) => {
      opts.onItem?.(id);
      return { items: [ITEM_OK], pages: 1, throttled: false };
    },
  } as unknown as never;
}

test("runOrdersSyncAll: ghi orders + order_daily + alert FBM, và báo số đơn bị hoãn item", async () => {
  const db = fakeDb();
  const fetched: string[] = [];
  const res = await runOrdersSyncAll({
    adapter: db.adapter,
    days: 7,
    now: new Date("2026-09-16T00:00:00Z"),
    clientFor: () => fakeClient([ORDER_OK, { ...ORDER_OK, AmazonOrderId: "X-2" }], { onItem: (id) => fetched.push(id) }),
  });

  assert.equal(res.failed, 0);
  assert.equal(res.ordersUpserted, 2);
  assert.equal(res.itemsUpserted, 2);
  assert.equal(res.deferred, 0);
  assert.equal(fetched.length, 2);
  assert.equal(db.orders.length, 1);
  assert.equal(db.orders[0].length, 2);
  assert.equal(db.daily.length, 1); // cả 2 đơn cùng ngày mua 14/09
  assert.equal((db.daily[0] as { day: string }).day, "2026-09-14");
  assert.equal(db.alerts.length, 1); // MFN Unshipped quá hạn LatestShipDate
  assert.equal((db.alerts[0] as { ruleCode: string }).ruleCode, "fbm_late_ship");
  assert.equal(db.jobs.length, 2); // running + done
});

test("runOrdersSyncAll: LastUpdatedBefore gửi đi sớm hơn now ≥ 2 phút (chốt sự cố 400 InvalidInput 16/09/2026)", async () => {
  const db = fakeDb();
  const now = new Date("2026-09-16T00:00:00Z");
  let seen: ListQueryLike | null = null;
  const res = await runOrdersSyncAll({
    adapter: db.adapter,
    days: 7,
    now,
    clientFor: () =>
      fakeClient([ORDER_OK], {
        onList: (q) => {
          seen = q;
        },
      }),
  });
  assert.equal(res.failed, 0);
  assert.ok(seen, "runner phải gọi listOrders");
  const q = seen as ListQueryLike;
  assert.ok(q.lastUpdatedBefore, "phải truyền LastUpdatedBefore");
  // Trước đây truyền watermark = now ⇒ Amazon trả 400 cho MỌI shop. Nay mốc phải
  // đúng bằng now − 3 phút (2 phút trễ dữ liệu + 1 phút biên độ đồng hồ).
  assert.equal((q.lastUpdatedBefore as Date).toISOString(), "2026-09-15T23:57:00.000Z");
  assert.ok((q.lastUpdatedBefore as Date).getTime() <= now.getTime() - 2 * 60_000);
  // 7 ngày nhìn lại + 5 phút chồng lấn của orderDeltaWindow
  assert.equal((q.lastUpdatedAfter as Date).toISOString(), "2026-09-08T23:55:00.000Z");
});

test("runOrdersSyncAll: ngân sách item = 0 ⇒ KHÔNG gọi orderItems, đơn vẫn được ghi", async () => {
  const db = fakeDb();
  let itemCalls = 0;
  const res = await runOrdersSyncAll({
    adapter: db.adapter,
    days: 7,
    maxItemMs: 0,
    clientFor: () =>
      fakeClient([ORDER_OK, { ...ORDER_OK, AmazonOrderId: "X-2" }], {
        onItem: () => {
          itemCalls += 1;
        },
      }),
  });
  assert.equal(itemCalls, 0);
  assert.equal(res.ordersUpserted, 2);
  assert.equal(res.itemsUpserted, 0);
  assert.equal(res.deferred, 2);
});

test("runOrdersSyncAll: trần maxItemFetches chặn giữa danh sách, hoãn phần còn lại", async () => {
  const db = fakeDb();
  const res = await runOrdersSyncAll({
    adapter: db.adapter,
    days: 7,
    maxItemFetches: 1,
    clientFor: () => fakeClient([ORDER_OK, { ...ORDER_OK, AmazonOrderId: "X-2" }, { ...ORDER_OK, AmazonOrderId: "X-3" }]),
  });
  assert.equal(res.ordersUpserted, 3);
  assert.equal(res.itemsUpserted, 1);
  assert.equal(res.deferred, 2);
});

test("gom ngày: utcDayKey + groupOrdersByDay theo NGÀY MUA (UTC)", () => {
  assert.equal(utcDayKey(new Date("2026-09-14T23:59:59Z")), "2026-09-14");
  const a = apiOrderToRowInput("s", ORDER_OK, [ITEM_OK])!;
  const b = apiOrderToRowInput("s", { ...ORDER_OK, AmazonOrderId: "X-2", PurchaseDate: "2026-09-15T01:00:00Z" }, [])!;
  const map = groupOrdersByDay([a, b]);
  assert.equal(map.size, 2);
  assert.equal(map.get("2026-09-14")!.length, 1);
  assert.equal(map.get("2026-09-15")!.length, 1);
});
