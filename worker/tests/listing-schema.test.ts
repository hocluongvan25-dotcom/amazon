/**
 * Test L3 — tải JSON Schema product type (Product Type Definitions API
 * 2020-09-01): link schema.link.resource, tải bằng fetch KHÔNG Authorization,
 * lưu vào cache để web dựng form động.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ListingsItemsClient, type ProductTypeDefinition } from "../src/amazon/listings.ts";
import { MockDbAdapter } from "../src/db/adapter.ts";
import {
  extractSchemaLink,
  fetchProductTypeSchema,
  runListingSchemaCli,
  summarizeSchema,
} from "../src/runtime/run-listing-schema.ts";

/** getDefinitionsProductType trả LINK (không inline) — đúng shape Amazon 2020-09-01 */
const DEF_WITH_LINK: ProductTypeDefinition = {
  meta: { schemaVersion: "2.0", productType: "LUGGAGE" },
  schema: { link: { resource: "https://schema.example/product-type.json", verb: "GET" }, checksum: "abc" },
  requirements: "LISTING",
  requirementsEnforced: "ENFORCED",
};

const SCHEMA = {
  $id: "amazon-product-type-schema/LUGGAGE",
  type: "object",
  required: ["item_name", "brand"],
  properties: {
    item_name: { type: "array", maxLength: 75 },
    brand: { type: "array" },
    bullet_point: { type: "array", maxLength: 500 },
  },
};

test("extractSchemaLink: lấy đúng schema.link.resource, trả null khi Amazon đổi shape", () => {
  assert.equal(extractSchemaLink(DEF_WITH_LINK), "https://schema.example/product-type.json");
  assert.equal(extractSchemaLink({ meta: {} }), null);
  assert.equal(extractSchemaLink({ schema: { link: {} } }), null);
  assert.equal(extractSchemaLink(null), null);
});

test("summarizeSchema: đếm attribute + required + $id để in log", () => {
  assert.deepEqual(summarizeSchema(SCHEMA), {
    attributes: 3,
    required: 2,
    id: "amazon-product-type-schema/LUGGAGE",
  });
  assert.deepEqual(summarizeSchema({}), { attributes: 0, required: 0, id: null });
});

test("fetchProductTypeSchema: tải link bằng fetch KHÔNG kèm Authorization", async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: url.toString(), init });
    return new Response(JSON.stringify(SCHEMA), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const schema = await fetchProductTypeSchema(DEF_WITH_LINK, fetchFn);
  assert.equal((schema.properties as Record<string, unknown>).item_name != null, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://schema.example/product-type.json");
  // link là pre-signed: KHÔNG được gửi Authorization
  const headers = (seen[0].init?.headers ?? {}) as Record<string, string>;
  assert.equal(headers.Authorization, undefined);
});

test("fetchProductTypeSchema: nhận schema inline nếu Amazon trả thẳng, không gọi mạng", async () => {
  let called = 0;
  const fetchFn = (async () => {
    called++;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const inline = { ...SCHEMA } as unknown as ProductTypeDefinition & Record<string, unknown>;
  const schema = await fetchProductTypeSchema(inline, fetchFn);
  assert.equal(schema.$id, "amazon-product-type-schema/LUGGAGE");
  assert.equal(called, 0);
});

test("fetchProductTypeSchema: link lỗi/không có link → báo lỗi rõ ràng (không lưu schema rác)", async () => {
  const failFetch = (async () => new Response("Forbidden", { status: 403, statusText: "Forbidden" })) as unknown as typeof fetch;
  await assert.rejects(() => fetchProductTypeSchema(DEF_WITH_LINK, failFetch), /HTTP 403/);

  const notObject = (async () => new Response("[1,2,3]", { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(() => fetchProductTypeSchema(DEF_WITH_LINK, notObject), /không phải JSON object/);

  await assert.rejects(() => fetchProductTypeSchema({ meta: {} }, failFetch), /schema\.link\.resource/);
});

test("runListingSchemaCli: dry-run/mock KHÔNG gọi Amazon và KHÔNG ghi cache", async () => {
  let networkCalls = 0;
  const result = await runListingSchemaCli({
    productType: "LUGGAGE",
    dryRun: true,
    fetchFn: (async () => {
      networkCalls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
    stdout: { write: () => {} },
  });
  assert.equal(result.db, "mock");
  assert.equal(networkCalls, 0);
  assert.equal(result.summary.productType, "LUGGAGE");
});

test("runListingSchemaCli: tải schema → lưu cache đúng marketplace/productType/requirements", async () => {
  const { client, calls } = (() => {
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url.toString()}`);
      return new Response(
        JSON.stringify({ ...DEF_WITH_LINK, schema: { link: { resource: "https://schema.example/pt.json" } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const lwa = { getAccessToken: async () => "TOKEN" } as never;
    return {
      client: new ListingsItemsClient({ host: "https://sellingpartnerapi-na.amazon.com", lwa, fetchFn }),
      calls,
    };
  })();

  const adapter = new MockDbAdapter();
  const result = await runListingSchemaCli({
    sellerAccountId: "11111111-1111-4111-8111-111111111111",
    productType: "LUGGAGE",
    requirements: "LISTING",
    adapter,
    client,
    fetchFn: (async () =>
      new Response(JSON.stringify(SCHEMA), { status: 200 })) as unknown as typeof fetch,
    stdout: { write: () => {} },
  });

  assert.equal(result.db, "mock");
  assert.equal(adapter.productTypeSchemas.length, 1);
  const saved = adapter.productTypeSchemas[0];
  assert.equal(saved.marketplaceId, "ATVPDKIKX0DER");
  assert.equal(saved.productType, "LUGGAGE");
  assert.equal(saved.requirements, "LISTING");
  assert.equal(result.summary.required, 2);
  // gọi đúng path Product Type Definitions 2020-09-01
  assert.ok(calls[0].startsWith("GET https://sellingpartnerapi-na.amazon.com/definitions/2020-09-01/productTypes/LUGGAGE?"));
  assert.ok(calls[0].includes("requirements=LISTING"));
});

test("runListingSchemaCli: thiếu --product-type hoặc requirements sai → báo lỗi ngay", async () => {
  await assert.rejects(() => runListingSchemaCli({ productType: null }), /--product-type/);
  await assert.rejects(
    () => runListingSchemaCli({ productType: "LUGGAGE", requirements: "SAI" }),
    /requirements không hợp lệ/,
  );
});
