/**
 * Test FbaInventoryClient — đúng chuẩn SP-API.
 *
 * Sự cố: client cũ chỉ gửi `Authorization: Bearer <token>` và KHÔNG gửi
 * `marketplaceIds`. getInventorySummaries (FBA Inventory v1) đọc token ở
 * header `x-amz-access-token` và bắt buộc query `marketplaceIds` →
 * 403 "Access to requested resource is denied" / 400 InvalidInput.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FbaInventoryClient,
  normalizeSummary,
} from "../../web/src/lib/worker/amazon/fba-inventory.ts";
import type { LwaTokenManager } from "../../web/src/lib/worker/amazon/lwa.ts";

const HOST = "https://sellingpartnerapi-na.amazon.com";
const US = "ATVPDKIKX0DER";

const fakeLwa = {
  getAccessToken: async () => "Atza|test-token",
} as unknown as LwaTokenManager;

type Call = { url: string; headers: Record<string, string> };

function makeFetch(pages: unknown[]) {
  const calls: Call[] = [];
  let i = 0;
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    const body = pages[Math.min(i, pages.length - 1)];
    i++;
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const PAGE_1 = {
  granularity: { granularityType: "Marketplace", granularityId: US },
  inventorySummaries: [
    { asin: "B0TEST0001", fnSku: "X00DEMO01F", sellerSku: "XMO-950-BLK", totalQuantity: 160 },
  ],
  pagination: { nextToken: "TOKEN-2" },
};

const PAGE_2 = {
  granularity: { granularityType: "Marketplace", granularityId: US },
  inventorySummaries: [
    { asin: "B0TEST0002", fnSku: "X00DEMO02F", sellerSku: "VPN-220", totalQuantity: 214 },
  ],
};

test("1. gửi header x-amz-access-token + query marketplaceIds", async () => {
  const { calls, fetchFn } = makeFetch([PAGE_2]);
  const client = new FbaInventoryClient({ host: HOST, lwa: fakeLwa, fetchFn });

  const res = await client.getInventorySummaries({ marketplaceId: US });

  assert.equal(calls.length, 1);
  const { url, headers } = calls[0];
  const u = new URL(url);

  // --- header bắt buộc của SP-API ---
  assert.equal(headers["x-amz-access-token"], "Atza|test-token", "phải có x-amz-access-token");
  assert.equal(
    headers["Authorization"],
    "Bearer Atza|test-token",
    "giữ Authorization để tương thích ngược",
  );

  // --- query bắt buộc ---
  assert.equal(u.pathname, "/fba/inventory/v1/summaries");
  assert.equal(u.searchParams.get("marketplaceIds"), US, "marketplaceIds là required");
  assert.equal(u.searchParams.get("granularityType"), "Marketplace");
  assert.equal(u.searchParams.get("granularityId"), US);
  assert.equal(u.searchParams.get("details"), "true");

  assert.equal(res.inventorySummaries.length, 1);
});

test("2. pagination: gom đủ các trang, mỗi trang đều gửi đúng token", async () => {
  const { calls, fetchFn } = makeFetch([PAGE_1, PAGE_2]);
  const client = new FbaInventoryClient({ host: HOST, lwa: fakeLwa, fetchFn });

  const res = await client.getInventorySummaries({ marketplaceId: US });

  assert.equal(calls.length, 2, "phải gọi trang 2 theo nextToken");
  assert.equal(new URL(calls[1].url).searchParams.get("nextToken"), "TOKEN-2");
  assert.equal(calls[1].headers["x-amz-access-token"], "Atza|test-token");
  assert.equal(res.inventorySummaries.length, 2);
  assert.deepEqual(
    res.inventorySummaries.map((s) => s.sellerSku),
    ["XMO-950-BLK", "VPN-220"],
  );
});

test("3. normalizeSummary: inbound = working + shipped + receiving", () => {
  const n = normalizeSummary({
    asin: "B0TEST0001",
    fnSku: "X00DEMO01F",
    sellerSku: "XMO-950-BLK",
    totalQuantity: 160,
    inventoryDetails: {
      fulfillableQuantity: 88,
      reservedQuantity: { totalReservedQuantity: 12 },
      inboundWorkingQuantity: 10,
      inboundShippedQuantity: 30,
      inboundReceivingQuantity: 20,
    },
  });
  assert.equal(n.fulfillable, 88);
  assert.equal(n.reserved, 12);
  assert.equal(n.inbound, 60);
  assert.equal(n.total, 160);
});
