/**
 * Test SupabaseDbAdapter — QUY TẮC POSTGREST (chống tái phát PGRST205/PGRST202).
 *
 * Sự cố thật 12/09/2026: worker gọi `/rest/v1/connections.seller_accounts`
 * và `/rest/v1/rpc/connections.active_production_shops`. PostgREST không hiểu
 * "schema.table"/"schema.rpc" → 400 PGRST205/PGRST202 → cron chết ngay vòng
 * lặp đầu, log chỉ hiện "0 shop".
 *
 * Bài test này khoá cả hai quy tắc:
 *   1. path KHÔNG được có dấu chấm (schema prefix)
 *   2. schema chọn bằng header Accept-Profile / Content-Profile
 *   3. RPC gọi wrapper trong schema public (0008), không prefix schema
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SupabaseDbAdapter } from "../../web/src/lib/worker/db/supabase.ts";

type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
};

type Reply = { status: number; body: unknown };

/** fetch giả: ghi lại mọi cuộc gọi, trả lời theo hàng đợi hoặc mặc định. */
function makeFetch(defaultBody: unknown = [], replies: Record<string, Reply> = {}) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method,
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });

    const key = Object.keys(replies).find((k) => {
      const [m, p] = k.split(" ");
      return method === m && new URL(url).pathname === p;
    });
    const { status, body } = key ? replies[key] : { status: 200, body: defaultBody };
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return { calls, fetchFn };
}

const URL_BASE = "https://demo.supabase.co";
const KEY = "service-role-key";

/** path PostgREST hợp lệ: /rest/v1/<table> hoặc /rest/v1/rpc/<fn> — KHÔNG dấu chấm */
const VALID_PATH = /^\/rest\/v1\/(?:rpc\/)?[a-z0-9_]+$/;

function assertNoSchemaPrefix(calls: Call[]) {
  for (const c of calls) {
    const { pathname } = new URL(c.url);
    assert.match(
      pathname,
      VALID_PATH,
      `path không được chứa tiền tố schema (PGRST205): ${pathname}`,
    );
  }
}

const SHOP_ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  seller_id: "AQMVYI4HJTI4C",
  marketplace: "ATVPDKIKX0DER",
  display_name: "P1 · US",
  lead_days: 32,
  safety_days: 14,
};

test("1. listActiveProductionShops → RPC public, KHÔNG prefix schema, KHÔNG profile header", async () => {
  const { calls, fetchFn } = makeFetch([SHOP_ROW]);
  const db = new SupabaseDbAdapter(URL_BASE, KEY, fetchFn);

  const shops = await db.listActiveProductionShops();

  assert.equal(calls.length, 1);
  const [c] = calls;
  assert.equal(c.method, "POST");
  assert.equal(new URL(c.url).pathname, "/rest/v1/rpc/active_production_shops");
  assert.equal(
    c.headers["Accept-Profile"],
    undefined,
    "RPC nằm trong public wrapper 0008 — set profile header sẽ trỏ sai schema",
  );
  assert.equal(c.headers["Content-Profile"], undefined);
  assertNoSchemaPrefix(calls);

  // PostgREST trả snake_case → phải map sang ActiveShop (camelCase)
  assert.equal(shops.length, 1);
  assert.equal(shops[0].id, SHOP_ROW.id);
  assert.equal(shops[0].sellerId, "AQMVYI4HJTI4C");
  assert.equal(shops[0].displayName, "P1 · US");
  assert.equal(shops[0].leadDays, 32);
  assert.equal(shops[0].safetyDays, 14);
});

test("2. RPC lỗi → fallback GET /rest/v1/seller_accounts + Accept-Profile: connections", async () => {
  const { calls, fetchFn } = makeFetch([], {
    "POST /rest/v1/rpc/active_production_shops": { status: 404, body: { code: "PGRST202" } },
    "GET /rest/v1/seller_accounts": { status: 200, body: [SHOP_ROW] },
  });
  const db = new SupabaseDbAdapter(URL_BASE, KEY, fetchFn);

  const shops = await db.listActiveProductionShops();

  assert.equal(calls.length, 2);
  const fallback = calls[1];
  assert.equal(fallback.method, "GET");
  assert.equal(new URL(fallback.url).pathname, "/rest/v1/seller_accounts");
  assert.equal(fallback.headers["Accept-Profile"], "connections");
  const u = new URL(fallback.url);
  assert.equal(u.searchParams.get("status"), "eq.active");
  assert.equal(u.searchParams.get("data_source"), "eq.production");
  assertNoSchemaPrefix(calls);
  assert.equal(shops[0].sellerId, "AQMVYI4HJTI4C");
});

test("3. inventory: snapshot + daily ghi đúng schema inventory", async () => {
  const { calls, fetchFn } = makeFetch([]);
  const db = new SupabaseDbAdapter(URL_BASE, KEY, fetchFn);

  await db.upsertInventorySnapshot({
    sellerAccountId: SHOP_ROW.id,
    sku: "XMO-950-BLK",
    asin: "B0TEST0001",
    fulfillable: 88,
    reserved: 12,
    inbound: 60,
    capturedAt: new Date("2026-09-12T06:00:00Z"),
  });
  await db.upsertInventoryDaily({
    sellerAccountId: SHOP_ROW.id,
    day: "2026-09-12",
    sku: "XMO-950-BLK",
    units: 88,
    daysOfCover: 6,
    inStock: true,
  });

  assertNoSchemaPrefix(calls);
  const [snap, daily] = calls;
  assert.equal(new URL(snap.url).pathname, "/rest/v1/inventory_snapshots");
  assert.equal(snap.headers["Accept-Profile"], "inventory");
  assert.equal(snap.headers["Content-Profile"], "inventory");
  assert.equal(new URL(daily.url).pathname, "/rest/v1/inventory_daily");
  assert.equal(daily.headers["Content-Profile"], "inventory");
});

test("4. getSellingDays → RPC public units_sold_per_day (wrapper 0008)", async () => {
  const { calls, fetchFn } = makeFetch([{ d: "2026-09-12", q: 17 }]);
  const db = new SupabaseDbAdapter(URL_BASE, KEY, fetchFn);

  const days = await db.getSellingDays(SHOP_ROW.id, "XMO-950-BLK", 14);

  assert.deepEqual(days, [17]);
  const [c] = calls;
  assert.equal(new URL(c.url).pathname, "/rest/v1/rpc/units_sold_per_day");
  assert.equal(c.headers["Accept-Profile"], undefined);
  assert.deepEqual(c.body, {
    p_seller: SHOP_ROW.id,
    p_sku: "XMO-950-BLK",
    p_days: 14,
  });
  assertNoSchemaPrefix(calls);
});

test("5. sync_jobs (insert + patch) đúng schema connections, không prefix", async () => {
  const { calls, fetchFn } = makeFetch([{ id: "job-1" }]);
  const db = new SupabaseDbAdapter(URL_BASE, KEY, fetchFn);

  const job = {
    sellerAccountId: SHOP_ROW.id,
    jobType: "inventory.pull",
    status: "running" as const,
    attempts: 1,
    startedAt: new Date("2026-09-12T06:00:00Z"),
  };
  await db.recordSyncJob(job);
  assert.equal(job.id, "job-1", "insert có return=representation → nhận lại id");

  await db.recordSyncJob({ ...job, status: "done", finishedAt: new Date("2026-09-12T06:01:00Z") });

  assertNoSchemaPrefix(calls);
  const [insert, patch] = calls;
  assert.equal(insert.method, "POST");
  assert.equal(new URL(insert.url).pathname, "/rest/v1/sync_jobs");
  assert.equal(insert.headers["Content-Profile"], "connections");
  assert.equal(insert.headers["Accept-Profile"], "connections");

  assert.equal(patch.method, "PATCH");
  assert.equal(new URL(patch.url).pathname, "/rest/v1/sync_jobs");
  assert.equal(new URL(patch.url).searchParams.get("id"), "eq.job-1");
  assert.equal(patch.headers["Content-Profile"], "connections");
});

test("6. alerts: đọc ops.alert_rules + ops.alerts, insert đúng schema ops", async () => {
  const { calls, fetchFn } = makeFetch([]);
  const db = new SupabaseDbAdapter(URL_BASE, KEY, fetchFn);

  await db.upsertAlert({
    sellerAccountId: SHOP_ROW.id,
    ruleCode: "stockout",
    severity: "red",
    title: "Hết hàng XMO-950-BLK — cần nhập ngay",
    detail: "cover 0 ngày",
  });

  assertNoSchemaPrefix(calls);
  const paths = calls.map((c) => new URL(c.url).pathname);
  assert.deepEqual(paths, ["/rest/v1/alert_rules", "/rest/v1/alerts", "/rest/v1/alerts"]);
  for (const c of calls) {
    assert.equal(c.headers["Accept-Profile"], "ops");
    assert.equal(c.headers["Content-Profile"], "ops");
  }
});

test("7. CHỐT CHẶN: path có dấu chấm (schema.table) bị từ chối ngay, không gọi mạng", async () => {
  const { calls, fetchFn } = makeFetch([]);
  const db = new SupabaseDbAdapter(URL_BASE, KEY, fetchFn);

  // @ts-expect-error — cố tình gọi sai kiểu cũ để kiểm chứng chốt chặn
  await assert.rejects(() => db.request("GET", "/rest/v1/connections.seller_accounts"), {
    message: /không được chứa tiền tố schema/,
  });
  assert.equal(calls.length, 0, "phải throw TRƯỚC khi gọi fetch");
});

test("8. upsertListing → RPC public (0016), KHÔNG prefix schema, KHÔNG profile header", async () => {
  const { calls, fetchFn } = makeFetch([{ upserted: 1, active_count: 1, flagged_count: 0 }]);
  const db = new SupabaseDbAdapter(URL_BASE, KEY, fetchFn);

  await db.upsertListing({
    sellerAccountId: SHOP_ROW.id,
    sku: "XMO-950-BLK",
    asin: "B0C7T31F",
    itemName: "XMO 950 Hardside Spinner",
    status: "ACTIVE",
    price: "1.299,99", // số kiểu local — tầng ghi phải parse, không đẩy chuỗi lạ xuống DB
    quantity: 142,
    strandedReason: null, // key CÓ MẶT → hết stranded thì xoá được lý do cũ
    source: "report",
    updatedAt: new Date("2026-09-12T02:00:00Z"),
  });

  assert.equal(calls.length, 1);
  assertNoSchemaPrefix(calls);
  const [c] = calls;
  assert.equal(new URL(c.url).pathname, "/rest/v1/rpc/vexim_worker_upsert_listings");
  assert.equal(c.method, "POST");
  // RPC nằm trong schema public → KHÔNG được gửi Accept/Content-Profile (bài học 0008)
  assert.equal(c.headers["Accept-Profile"], undefined);
  assert.equal(c.headers["Content-Profile"], undefined);

  const body = c.body as { p_seller: string; p_rows: Record<string, unknown>[] };
  assert.equal(body.p_seller, SHOP_ROW.id);
  assert.equal(body.p_rows.length, 1);
  const row = body.p_rows[0];
  assert.equal(row.sku, "XMO-950-BLK");
  assert.equal(row.status, "ACTIVE");
  assert.equal(row.price, 1299.99, "1.299,99 phải thành số 1299.99");
  assert.equal(row.stranded_reason, null, "stranded_reason phải CÓ trong payload để xoá lý do cũ");
  assert.equal(row.source, "report");
  assert.equal(row.updated_at, "2026-09-12T02:00:00.000Z");
});

test("9. upsertListings: cả lô = 1 request, nhóm theo shop, lô rỗng không gọi mạng", async () => {
  const { calls, fetchFn } = makeFetch([{ upserted: 3, active_count: 2, flagged_count: 1 }]);
  const db = new SupabaseDbAdapter(URL_BASE, KEY, fetchFn);
  const other = "22222222-2222-4222-8222-222222222222";

  await db.upsertListings([]);
  assert.equal(calls.length, 0, "lô rỗng không được gọi mạng");

  await db.upsertListings([
    { sellerAccountId: SHOP_ROW.id, sku: "A", status: "ACTIVE", updatedAt: new Date("2026-09-12T02:00:00Z") },
    { sellerAccountId: SHOP_ROW.id, sku: "B", status: null, updatedAt: new Date("2026-09-12T02:00:00Z") },
    { sellerAccountId: other, sku: "C", status: "STRANDED", strandedReason: "No listing", updatedAt: new Date("2026-09-12T02:00:00Z") },
  ]);

  assertNoSchemaPrefix(calls);
  assert.equal(calls.length, 2, "mỗi shop 1 request (RPC nhận p_seller)");
  const bodies = calls.map((c) => c.body as { p_seller: string; p_rows: Record<string, unknown>[] });
  assert.equal(bodies[0].p_seller, SHOP_ROW.id);
  assert.equal(bodies[0].p_rows.length, 2);
  assert.equal(bodies[1].p_seller, other);
  assert.equal(bodies[1].p_rows[0].stranded_reason, "No listing");
  // status null = "chưa biết" → vẫn đưa key vào để RPC tự giữ giá trị cũ
  assert.equal(bodies[0].p_rows[1].status, null);
});
