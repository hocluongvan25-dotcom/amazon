/**
 * Test ĐỢT A — ghi listing thật (L1/L2/L4).
 *
 * Khoá ba thứ từng làm Module 1 "có màn hình mà không có dữ liệu":
 *   1. `upsertListing()` từng là STUB RỖNG → ghi Supabase không xuống DB.
 *   2. Luật "null = chưa biết → KHÔNG đè" phải giống nhau ở mock và DB thật,
 *      nếu không test xanh mà production sai.
 *   3. Runner `listings:sync` phải từ chối ghi DB thật khi chưa đủ credentials.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildListingPayload,
  buildListingsPayload,
  parseReportNumber,
} from "../../web/src/lib/worker/db/listing-payload.ts";
import { MockDbAdapter, type ListingStateRow } from "../../web/src/lib/worker/db/adapter.ts";
import type { ListingsItem } from "../src/amazon/listings.ts";
import { extractListingState } from "../src/amazon/listings.ts";
import { DEFAULT_DETAIL_LIMIT, runListingsSync } from "../src/jobs/listings-sync.job.ts";
import { runListingsSyncCli, throttle } from "../src/runtime/run-listings-sync.ts";

const SELLER = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-12T02:00:00Z");

const ML_HEAD =
  "item-name\titem-description\tlisting-id\tseller-sku\tprice\tquantity\topen-date\tDeprecated column\titem-is-marketplace\tproduct-id-type\tDeprecated column\titem-note\titem-condition\tDeprecated column\tDeprecated column\tDeprecated column\tasin1\tDeprecated column\tDeprecated column\twill-ship-internationally\texpedited-shipping\tDeprecated column\tproduct-id\tDeprecated column\tadd-delete\tpending-quantity\tfulfilment-channel\tmerchant-shipping-group\tstatus\tMinimum order quantity\tSell remainder";

const row = (sku: string, price: string, qty: string, asin: string, status: string) =>
  `${sku} title\tMo ta\t1\t${sku}\t${price}\t${qty}\t08/12/2024\t\t1\t1\t\t\tNew\t\t\t\t${asin}\t\t\t\t\tB0X\t\t\ta\ta\tDEFAULT\tStandard\t${status}\t\t`;

/* ---------- parse số kiểu local ---------- */

test("parseReportNumber: đọc đúng cả kiểu US và kiểu local, không đoán bừa", () => {
  assert.equal(parseReportNumber("129.99"), 129.99);
  assert.equal(parseReportNumber("129,99"), 129.99);
  assert.equal(parseReportNumber("1.299,99"), 1299.99, "1.299,99 (VN/EU) → 1299.99");
  assert.equal(parseReportNumber("1,299.99"), 1299.99, "1,299.99 (US) → 1299.99");
  assert.equal(parseReportNumber("$1,299.99"), 1299.99, "bỏ ký tự tiền tệ");
  assert.equal(parseReportNumber(" 59.90 "), 59.9);
  assert.equal(parseReportNumber(42), 42);
  // Không đọc được → null ("chưa biết"), KHÔNG ném lỗi làm hỏng cả lô đồng bộ
  assert.equal(parseReportNumber(""), null);
  assert.equal(parseReportNumber("N/A"), null);
  assert.equal(parseReportNumber("--"), null);
  assert.equal(parseReportNumber(null), null);
  assert.equal(parseReportNumber(undefined), null);
});

/* ---------- payload: phân biệt "chưa biết" và "biết là rỗng" ---------- */

test("buildListingPayload: null = chưa biết (vẫn gửi key), issues=[] = biết là rỗng", () => {
  const payload = buildListingPayload({
    sellerAccountId: SELLER,
    sku: "XMO-950-BLK",
    asin: "B0C7T31F",
    itemName: "XMO 950",
    status: null, // report ghi "Closed" → parser trả null
    price: "1.299,99",
    currency: "usd",
    quantity: 142,
    issues: [],
    strandedReason: null,
    source: "report",
    updatedAt: NOW,
  });

  assert.equal(payload.sku, "XMO-950-BLK");
  assert.equal(payload.status, null);
  assert.equal(payload.price, 1299.99);
  assert.deepEqual(payload.issues, []);
  assert.ok("stranded_reason" in payload, "stranded_reason phải có mặt để xoá lý do cũ");
  assert.equal(payload.stranded_reason, null);
  assert.equal(payload.source, "report");
  assert.equal(payload.synced_at, "2026-09-12T02:00:00.000Z");
  // sellerAccountId KHÔNG nằm trong payload dòng (RPC nhận p_seller riêng)
  assert.equal((payload as Record<string, unknown>).sellerAccountId, undefined);
});

test("buildListingPayload: field không được nêu thì KHÔNG xuất hiện trong payload", () => {
  const payload = buildListingPayload({
    sellerAccountId: SELLER,
    sku: "A",
    status: "ACTIVE",
    updatedAt: NOW,
  });
  assert.deepEqual(Object.keys(payload).sort(), ["sku", "status", "synced_at", "updated_at"].sort());
  assert.equal("stranded_reason" in payload, false, "không nêu → không gửi → DB giữ nguyên");
  assert.equal(buildListingsPayload([]).length, 0);
});

/* ---------- MockDbAdapter phải khó tính như RPC thật ---------- */

test("MockDbAdapter.upsertListings: null = chưa biết → GIỮ dữ liệu cũ (đúng luật RPC 0016)", async () => {
  const db = new MockDbAdapter();
  await db.upsertListing({
    sellerAccountId: SELLER,
    sku: "A",
    asin: "B0001",
    itemName: "Tên cũ",
    status: "ACTIVE",
    price: "10.00",
    quantity: 5,
    source: "notification",
    updatedAt: NOW,
  });

  // report "Closed" → status null; không nêu price/quantity
  await db.upsertListing({ sellerAccountId: SELLER, sku: "A", status: null, updatedAt: new Date("2026-09-13T02:00:00Z") });

  const a = db.listings.find((l) => l.sku === "A");
  assert.ok(a);
  assert.equal(a.status, "ACTIVE", "status null KHÔNG được xoá trạng thái notification vừa ghi");
  assert.equal(a.itemName, "Tên cũ");
  assert.equal(a.price, "10.00");
  assert.equal(a.quantity, 5);
});

test("MockDbAdapter: issues=[] xoá chi tiết cũ, strandedReason null (key có mặt) xoá lý do", async () => {
  const db = new MockDbAdapter();
  await db.upsertListing({
    sellerAccountId: SELLER,
    sku: "B",
    status: "STRANDED",
    strandedReason: "Listing error",
    issues: [{ code: "8541", severity: "ERROR", message: "thiếu thuộc tính" }],
    updatedAt: NOW,
  });
  await db.upsertListing({ sellerAccountId: SELLER, sku: "B", status: "ACTIVE", strandedReason: null, issues: [], updatedAt: NOW });

  const b = db.listings.find((l) => l.sku === "B");
  assert.equal(b?.strandedReason, null, "hết stranded → lý do phải bị xoá, nếu không L4 giữ oan");
  assert.deepEqual(b?.issues, [], "issues=[] nghĩa là đã xác nhận hết lỗi");

  // key VẮNG → giữ nguyên
  await db.upsertListing({ sellerAccountId: SELLER, sku: "B", status: "INACTIVE", strandedReason: "No listing exists", updatedAt: NOW });
  await db.upsertListing({ sellerAccountId: SELLER, sku: "B", status: "INACTIVE", updatedAt: NOW });
  assert.equal(db.listings.find((l) => l.sku === "B")?.strandedReason, "No listing exists");
});

/* ---------- job: ghi lô + alert + sync job + issues thật cho L2 ---------- */

test("runListingsSync: ghi 1 lô, có alert listing_inactive + sync_jobs listings.sync", async () => {
  const db = new MockDbAdapter();
  const report = await runListingsSync({
    sellerAccountId: SELLER,
    allReportText: [ML_HEAD, row("A-1", "10.00", "3", "B0A1", "Active"), row("B-1", "20.00", "0", "B0B1", "Inactive")].join("\n"),
    adapter: db,
    now: NOW,
  });

  assert.equal(report.listingsProcessed, 2);
  assert.equal(db.listings.length, 2);
  assert.equal(db.jobs.filter((j) => j.jobType === "listings.sync").length, 2, "mở + đóng sync job");
  assert.equal(db.jobs.at(-1)?.status, "done");
  assert.equal(report.alerts.length, 1);
  assert.equal(report.alerts[0].ruleCode, "listing_inactive");
  assert.equal(db.alerts.length, 1, "alert được ghi qua adapter");
  assert.deepEqual(report.queue.map((q) => q.sku), ["B-1"]);
  assert.equal(report.detailsFetched, 0, "không có fetchDetail → không gọi API, không bịa issue");
});

test("runListingsSync: không còn SKU lỗi → đóng alert listing_inactive đang mở", async () => {
  const db = new MockDbAdapter();
  const allActive = [ML_HEAD, row("A-1", "10.00", "3", "B0A1", "Active")].join("\n");
  await runListingsSync({ sellerAccountId: SELLER, allReportText: [ML_HEAD, row("A-1", "10.00", "3", "B0A1", "Inactive")].join("\n"), adapter: db, now: NOW });
  assert.equal(db.alerts.filter((a) => a.ruleCode === "listing_inactive").length, 1);

  const report = await runListingsSync({ sellerAccountId: SELLER, allReportText: allActive, adapter: db, now: NOW });
  assert.equal(report.alerts.length, 0);
  assert.equal(report.queue.length, 0);
});

test("runListingsSync --details: gọi getListingsItem cho SKU có vấn đề, ghi issues ĐÚNG MÃ Amazon", async () => {
  const db = new MockDbAdapter();
  const called: string[] = [];
  const item: ListingsItem = {
    sku: "B-1",
    summaries: [{ asin: "B0B1", productType: "LUGGAGE", status: ["DISCOVERABLE"], itemName: "Tên từ API" }],
    issues: [
      {
        code: "8541",
        message: "Attributes tagged as relevant_attributes are incomplete.",
        severity: "ERROR",
        attributeNames: ["item_name"],
        enforcements: { actions: ["SEARCH_SUPPRESSED"] },
      },
      { code: "90220", message: "Missing product_description", severity: "WARNING" },
    ],
  };

  const report = await runListingsSync({
    sellerAccountId: SELLER,
    allReportText: [ML_HEAD, row("A-1", "10.00", "3", "B0A1", "Active"), row("B-1", "20.00", "0", "B0B1", "Active [*]")].join("\n"),
    adapter: db,
    now: NOW,
    fetchDetail: async (sku) => {
      called.push(sku);
      return item;
    },
  });

  assert.deepEqual(called, ["B-1"], "chỉ gọi cho SKU không ACTIVE — không đốt quota cho SKU khoẻ");
  assert.equal(report.detailsFetched, 1);
  assert.equal(report.withErrors, 1);

  const b = db.listings.find((l) => l.sku === "B-1");
  assert.equal(b?.productType, "LUGGAGE");
  assert.equal(b?.issues?.length, 2, "L2 cần mảng issue nguyên văn, không chỉ số đếm");
  assert.equal(b?.issues?.[0].code, "8541");
  assert.deepEqual(b?.enforcementActions, ["SEARCH_SUPPRESSED"]);
  assert.equal(report.queue[0].cause, "Issue Amazon: 8541, 90220", "L4 nêu đúng mã lỗi để biết sửa gì");
});

test("runListingsSync --details: tôn trọng giới hạn số lần gọi + báo lỗi rõ khi API fail", async () => {
  const db = new MockDbAdapter();
  let calls = 0;
  const manyRows = Array.from({ length: 5 }, (_, i) => row(`S-${i}`, "10.00", "0", `B00${i}`, "Inactive"));
  const report = await runListingsSync({
    sellerAccountId: SELLER,
    allReportText: [ML_HEAD, ...manyRows].join("\n"),
    adapter: db,
    now: NOW,
    detailLimit: 2,
    fetchDetail: async () => {
      calls++;
      throw new Error("getListingsItem 404: SKU không tồn tại");
    },
  });

  assert.equal(calls, 2, "detailLimit phải chặn số lần gọi (rate limit 5 rps/burst 10)");
  assert.equal(report.detailsFetched, 0);
  assert.ok(report.warnings.some((w) => w.includes("404")), "lỗi API phải thành cảnh báo, không im lặng");
  assert.ok(report.warnings.some((w) => w.includes("giới hạn 2")), "phải nói rõ còn bao nhiêu SKU chưa soi");
  // Không gọi được thì KHÔNG bịa issue
  assert.equal(db.listings.find((l) => l.sku === "S-0")?.issues, undefined);
});

test("extractListingState: trả issues nguyên văn + đếm severity", () => {
  const state = extractListingState({
    sku: "X",
    summaries: [{ asin: "B0X", productType: "LUGGAGE", status: ["BUYABLE", "DISCOVERABLE"], itemName: null }],
    issues: [
      { code: "8541", severity: "ERROR", message: "e1", enforcements: { actions: ["LISTING_SUPPRESSED"] } },
      { code: "90220", severity: "WARNING", message: "e2" },
    ],
  });
  assert.equal(state.issueErrors, 1);
  assert.equal(state.issueWarnings, 1);
  assert.deepEqual(state.enforcementActions, ["LISTING_SUPPRESSED"]);
  assert.equal(state.issues.length, 2);
  assert.equal(state.issues[0].code, "8541");
  assert.equal(state.issues[1].enforcements, undefined, "không bịa field Amazon không trả");
});

/* ---------- runner: an toàn dữ liệu ---------- */

test("runListingsSyncCli: không có report → hướng dẫn rõ, không ghi gì", async () => {
  let out = "";
  const db = new MockDbAdapter();
  const result = await runListingsSyncCli({
    dryRun: true,
    adapter: db,
    stdout: { write: (s) => { out += s; } },
  });
  assert.equal(result.report, null);
  assert.equal(db.listings.length, 0);
  assert.match(out, /GET_MERCHANT_LISTINGS_ALL_DATA/);
});

test("runListingsSyncCli --dry-run: chạy thật trên report nhưng KHÔNG ghi DB thật", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vexim-listings-"));
  const allPath = path.join(dir, "all.tsv");
  fs.writeFileSync(allPath, [ML_HEAD, row("A-1", "10.00", "3", "B0A1", "Active"), row("B-1", "20.00", "0", "B0B1", "Inactive")].join("\n"));

  let out = "";
  const db = new MockDbAdapter();
  const result = await runListingsSyncCli({
    allFile: allPath,
    dryRun: true,
    adapter: db,
    stdout: { write: (s) => { out += s; } },
  });

  assert.equal(result.db, "mock");
  assert.equal(result.summary.listings, 2);
  assert.equal(result.summary.queue, 1);
  assert.match(out, /KHÔNG ghi DB thật/);
  // mock adapter vẫn nhận dữ liệu để người chạy đối chiếu
  assert.equal(db.listings.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("runListingsSyncCli: --details bị bỏ qua khi chưa có credentials (không gọi Amazon giả)", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vexim-listings-"));
  const allPath = path.join(dir, "all.tsv");
  fs.writeFileSync(allPath, [ML_HEAD, row("B-1", "20.00", "0", "B0B1", "Inactive")].join("\n"));

  let out = "";
  const result = await runListingsSyncCli({
    allFile: allPath,
    withDetails: true,
    dryRun: true,
    adapter: new MockDbAdapter(),
    stdout: { write: (s) => { out += s; } },
  });
  assert.equal(result.db, "mock");
  assert.equal(result.report?.detailsFetched, 0);
  assert.match(out, /--details bị bỏ qua/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("throttle: giữ khoảng cách tối thiểu giữa 2 lần gọi (rate limit getListingsItem)", async () => {
  const stamps: number[] = [];
  const fn = throttle(async () => { stamps.push(Date.now()); }, 40);
  await fn();
  await fn();
  await fn();
  assert.equal(stamps.length, 3);
  assert.ok(stamps[1] - stamps[0] >= 35, `khoảng cách phải ≥ ~40ms (nhận ${stamps[1] - stamps[0]})`);
  assert.ok(stamps[2] - stamps[1] >= 35);
});

test("DEFAULT_DETAIL_LIMIT: có trần mặc định để không đốt quota getListingsItem", () => {
  assert.equal(DEFAULT_DETAIL_LIMIT, 50);
});

/** Giữ kiểu ListingStateRow không trôi: source là tập đóng, không phải string tự do. */
test("ListingStateRow.source chỉ nhận report|api|notification|manual", () => {
  const r: ListingStateRow = { sellerAccountId: SELLER, sku: "A", status: "ACTIVE", source: "api", updatedAt: NOW };
  assert.equal(r.source, "api");
});
