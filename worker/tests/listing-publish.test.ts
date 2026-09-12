/**
 * Test L3 — job publish listing: thứ tự gọi API (restrictions → put/patch),
 * xử lý ACCEPTED/INVALID, hạn chế danh mục (blocked), lỗi mạng (failed).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ListingsItemsClient } from "../src/amazon/listings.ts";
import { runListingPublish, formatRestrictionBlockers } from "../src/jobs/listing-publish.job.ts";
import { MockDbAdapter, type ListingPublishQueueRow } from "../src/db/adapter.ts";

const SELLER_ACC = "11111111-1111-4111-8111-111111111111";

function makeClient(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: url.toString(),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return handler(url.toString(), init);
  }) as unknown as typeof fetch;
  const lwa = { getAccessToken: async () => "TOKEN" } as never;
  return {
    calls,
    client: new ListingsItemsClient({ host: "https://sellingpartnerapi-na.amazon.com", lwa, fetchFn }),
  };
}

function seed(rows: Partial<ListingPublishQueueRow>[]): MockDbAdapter {
  const db = new MockDbAdapter();
  db.publishQueue = rows.map((row, index) => ({
    queueId: row.queueId ?? `q-${index + 1}`,
    sellerAccountId: row.sellerAccountId ?? SELLER_ACC,
    draftId: row.draftId ?? `d-${index + 1}`,
    sku: row.sku ?? `SKU-${index + 1}`,
    asin: row.asin ?? null,
    marketplaceId: row.marketplaceId ?? "ATVPDKIKX0DER",
    productType: row.productType ?? "LUGGAGE",
    requirements: row.requirements ?? "LISTING",
    method: row.method ?? "patch",
    payload: row.payload ?? { patches: [] },
    attempts: row.attempts ?? 0,
  }));
  return db;
}

test("formatRestrictionBlockers: gom reasonCode + message + link xin duyệt", () => {
  const blockers = formatRestrictionBlockers({
    restrictions: [
      {
        marketplaceId: "ATVPDKIKX0DER",
        reasons: [
          { reasonCode: "NOT_ELIGIBLE", message: "Not eligible to sell" },
          {
            reasonCode: "APPROVAL_REQUIRED",
            message: "Approval required",
            links: [{ resource: "https://sellercentral.amazon.com/hz/approvalrequest/restrictions/approve?asin=B0X" }],
          },
        ],
      },
    ],
  });
  assert.equal(blockers.length, 2);
  assert.ok(blockers[0].startsWith("NOT_ELIGIBLE:"));
  assert.ok(blockers[1].includes("approvalrequest"));
  assert.deepEqual(formatRestrictionBlockers({ restrictions: [] }), []);
});

test("patch listing có ASIN: kiểm tra restrictions TRƯỚC rồi mới patch, kết quả ACCEPTED", async () => {
  const db = seed([
    {
      sku: "XMO-950-BLK",
      asin: "B0C7T31F",
      method: "patch",
      payload: { productType: "LUGGAGE", patches: [{ op: "replace", path: "/attributes/item_name", value: [{ value: "X" }] }] },
    },
  ]);
  const { calls, client } = makeClient((url) => {
    if (url.includes("/listings/2021-08-01/restrictions")) {
      return new Response(JSON.stringify({ restrictions: [] }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ sku: "XMO-950-BLK", status: "ACCEPTED", submissionId: "SUB-1", issues: [] }),
      { status: 200 },
    );
  });

  const report = await runListingPublish({
    sellerAccountId: SELLER_ACC,
    sellerId: "A1SELLER",
    client,
    adapter: db,
    issueLocale: "en_US",
  });

  assert.equal(report.accepted, 1);
  assert.equal(calls.length, 2, "phải gọi restrictions rồi mới tới patchListingsItem");
  assert.ok(calls[0].url.includes("/listings/2021-08-01/restrictions"));
  assert.ok(calls[0].url.includes("asin=B0C7T31F"));
  assert.ok(calls[0].url.includes("reasonLocale=en_US"));
  assert.equal(calls[1].method, "PATCH");
  assert.ok(calls[1].url.includes("/listings/2021-08-01/items/A1SELLER/XMO-950-BLK"));
  assert.ok(calls[1].url.includes("marketplaceIds=ATVPDKIKX0DER"));
  // Body KHÔNG được chứa marketplaceIds
  assert.deepEqual(Object.keys(calls[1].body as object).sort(), ["patches", "productType"]);
  assert.equal(db.publishResults[0].status, "accepted");
  assert.equal(db.publishResults[0].submissionId, "SUB-1");
});

test("listing mới (không ASIN): bỏ qua restrictions, gọi PUT với requirements", async () => {
  const db = seed([
    {
      sku: "NEW-1",
      asin: null,
      method: "put",
      requirements: "LISTING",
      payload: { productType: "LUGGAGE", requirements: "LISTING", attributes: { item_name: [{ value: "Vali mới" }] } },
    },
  ]);
  const { calls, client } = makeClient(() =>
    new Response(JSON.stringify({ sku: "NEW-1", status: "ACCEPTED", submissionId: "SUB-2" }), { status: 200 }),
  );

  const report = await runListingPublish({ sellerAccountId: SELLER_ACC, sellerId: "A1SELLER", client, adapter: db });

  assert.equal(report.accepted, 1);
  assert.equal(calls.length, 1, "listing mới không gọi getListingsRestrictions");
  assert.equal(calls[0].method, "PUT");
  assert.deepEqual(Object.keys(calls[0].body as object).sort(), ["attributes", "productType", "requirements"]);
  assert.equal((calls[0].body as { requirements: string }).requirements, "LISTING");
});

test("hạn chế danh mục: NOT_ELIGIBLE → blocked, KHÔNG gọi Amazon", async () => {
  const db = seed([{ sku: "RESTRICTED-1", asin: "B0RESTRICTED", method: "patch" }]);
  const { calls, client } = makeClient(() =>
    new Response(
      JSON.stringify({
        restrictions: [
          {
            marketplaceId: "ATVPDKIKX0DER",
            conditionType: "new_new",
            reasons: [{ reasonCode: "NOT_ELIGIBLE", message: "You are not eligible to sell this ASIN" }],
          },
        ],
      }),
      { status: 200 },
    ),
  );

  const report = await runListingPublish({ sellerAccountId: SELLER_ACC, sellerId: "A1SELLER", client, adapter: db });

  assert.equal(report.blocked, 1);
  assert.equal(calls.length, 1, "chỉ gọi restrictions, không gửi patch");
  assert.equal(db.publishResults[0].status, "blocked");
  assert.ok(String(db.publishResults[0].blockReason).includes("NOT_ELIGIBLE"));
});

test("Amazon trả INVALID → failed kèm issues để người soạn sửa", async () => {
  const db = seed([{ sku: "BAD-1", asin: "B0BAD", method: "patch" }]);
  const { client } = makeClient((url) => {
    if (url.includes("/restrictions")) return new Response(JSON.stringify({ restrictions: [] }), { status: 200 });
    return new Response(
      JSON.stringify({
        sku: "BAD-1",
        status: "INVALID",
        submissionId: "SUB-3",
        issues: [{ code: "90220", message: "'product_description' is required but not supplied.", severity: "ERROR" }],
      }),
      { status: 200 },
    );
  });

  const report = await runListingPublish({ sellerAccountId: SELLER_ACC, sellerId: "A1SELLER", client, adapter: db });

  assert.equal(report.invalid, 1);
  assert.equal(db.publishResults[0].status, "invalid");
  assert.equal((db.publishResults[0].issues as unknown[]).length, 1);
});

test("lỗi mạng/5xx khi kiểm tra hạn chế → failed (không gửi liều)", async () => {
  const db = seed([{ sku: "ERR-1", asin: "B0ERR", method: "patch" }]);
  const { calls, client } = makeClient(() => new Response("boom", { status: 500 }));

  const report = await runListingPublish({ sellerAccountId: SELLER_ACC, sellerId: "A1SELLER", client, adapter: db });

  assert.equal(report.failed, 1);
  assert.equal(calls.length, 1);
  assert.ok(String(db.publishResults[0].error).includes("Không kiểm tra được hạn chế danh mục"));
});

test("dryRun: chỉ kiểm tra, không gửi Amazon và không ghi DB", async () => {
  const db = seed([{ sku: "DRY-1", asin: "B0DRY", method: "patch" }]);
  const { calls, client } = makeClient(() => new Response(JSON.stringify({ restrictions: [] }), { status: 200 }));

  const report = await runListingPublish({
    sellerAccountId: SELLER_ACC,
    sellerId: "A1SELLER",
    client,
    adapter: db,
    dryRun: true,
  });

  assert.equal(report.processed, 1);
  assert.equal(calls.length, 1);
  assert.equal(db.publishResults.length, 0, "dryRun không ghi kết quả");
});
