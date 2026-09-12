/**
 * Test tra seller_id + marketplace (web/src/lib/spapi/whoami.ts).
 * spapi được inject — không gọi network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  discoverSellerIdentity,
  extractSellerId,
  parseInventory,
  parseMarketplaces,
  pickActiveMarketplace,
  type SpApiFn,
} from "../../web/src/lib/spapi/whoami.ts";

const US = {
  marketplace: {
    id: "ATVPDKIKX0DER",
    name: "Amazon.com",
    countryCode: "US",
    defaultCurrencyCode: "USD",
    domainName: "www.amazon.com",
  },
  participation: { isParticipating: true, hasSuspendedListings: false },
};
const SUSPENDED = {
  marketplace: {
    id: "A2EUQ1WTGCTBG2",
    name: "Amazon.ca",
    countryCode: "CA",
    defaultCurrencyCode: "CAD",
    domainName: "www.amazon.ca",
  },
  participation: { isParticipating: false, hasSuspendedListings: true },
};

const SUMMARIES = {
  granularity: { granularityType: "Marketplace", granularityId: "ATVPDKIKX0DER" },
  inventorySummaries: [
    { asin: "B0TEST0001", sellerSku: "XMO-950-BLK", fnSku: "X00DEMO01F" },
    { asin: "B0TEST0009", sellerSku: "VPN-220", fnSku: "X00DEMO09F" },
  ],
};

const FEES_OK = {
  payload: {
    FeesEstimateResult: {
      Status: "Success",
      FeesEstimateIdentifier: {
        MarketplaceId: "ATVPDKIKX0DER",
        SellerId: "A1VEXIMSELF",
        IdType: "ASIN",
        IdValue: "B0TEST0001",
      },
    },
  },
};

function mockSpapi(
  impl: (method: string, path: string) => { status: number; data: unknown } | Promise<{ status: number; data: unknown }>,
): SpApiFn {
  return async (method, path) => {
    const r = await impl(method, path);
    return { status: r.status, data: r.data, raw: JSON.stringify(r.data) };
  };
}

test("1. happy path: 3 bước thành công → sellerId + marketplace + skuCount", async () => {
  const spapi = mockSpapi((method, path) => {
    if (method === "GET" && path.includes("marketplaceParticipations")) {
      return { status: 200, data: { payload: [SUSPENDED, US] } };
    }
    if (method === "GET" && path.includes("/fba/inventory/v1/summaries")) {
      return { status: 200, data: SUMMARIES };
    }
    if (method === "POST" && path.includes("/products/fees/v0/items/")) {
      assert.ok(path.includes("B0TEST0001"), `fees path phải dùng ASIN mẫu, thực tế ${path}`);
      return { status: 200, data: FEES_OK };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });

  const r = await discoverSellerIdentity({ spapi, region: "NA" });
  assert.equal(r.ok, true);
  assert.equal(r.sellerId, "A1VEXIMSELF");
  assert.equal(r.marketplace?.id, "ATVPDKIKX0DER");
  assert.equal(r.marketplace?.countryCode, "US");
  assert.equal(r.inventory?.skuCount, 2);
  assert.equal(r.inventory?.sampleAsin, "B0TEST0001");
  assert.equal(r.inventory?.sampleSku, "XMO-950-BLK");
  assert.equal(r.steps.marketplaces.ok, true);
  assert.equal(r.steps.inventory.ok, true);
  assert.equal(r.steps.feesEstimate.ok, true);
  assert.match(r.sqlHint ?? "", /A1VEXIMSELF/);
  assert.match(r.sqlHint ?? "", /ATVPDKIKX0DER/);
});

test("2. fees ClientError vẫn lấy được SellerId (cách Amazon lộ merchant id)", async () => {
  const clientError = {
    payload: {
      FeesEstimateResult: {
        Status: "ClientError",
        FeesEstimateIdentifier: {
          MarketplaceId: "ATVPDKIKX0DER",
          SellerId: "A2VYDBAL8BMVQK",
          IdType: "ASIN",
          IdValue: "B0TEST0001",
        },
        Error: { Code: "InvalidParameterValue", Message: "client-side error" },
      },
    },
  };
  const extracted = extractSellerId(clientError);
  assert.equal(extracted.sellerId, "A2VYDBAL8BMVQK");
  assert.equal(extracted.status, "ClientError");

  const spapi = mockSpapi((method, path) => {
    if (path.includes("marketplaceParticipations")) return { status: 200, data: { payload: [US] } };
    if (path.includes("/fba/inventory/")) return { status: 200, data: SUMMARIES };
    if (path.includes("/fees/")) return { status: 400, data: clientError };
    throw new Error(`unexpected ${method} ${path}`);
  });
  const r = await discoverSellerIdentity({ spapi, region: "NA" });
  assert.equal(r.ok, true);
  assert.equal(r.sellerId, "A2VYDBAL8BMVQK");
  assert.equal(r.steps.feesEstimate.ok, true);
});

test("3. bước 1 lỗi không throw — bước 2/3 skipped", async () => {
  const spapi = mockSpapi((method, path) => {
    if (path.includes("marketplaceParticipations")) {
      return { status: 403, data: { errors: [{ message: "Unauthorized" }] } };
    }
    throw new Error(`bước khác không được gọi khi bước 1 fail: ${method} ${path}`);
  });
  const r = await discoverSellerIdentity({ spapi, region: "NA" });
  assert.equal(r.ok, false);
  assert.equal(r.sellerId, null);
  assert.equal(r.steps.marketplaces.ok, false);
  assert.match(r.steps.marketplaces.error ?? "", /HTTP 403/);
  assert.equal(r.steps.inventory.skipped, true);
  assert.equal(r.steps.feesEstimate.skipped, true);
});

test("4. bước 2 lỗi không throw — bước 3 skipped, marketplace vẫn giữ", async () => {
  const spapi = mockSpapi((method, path) => {
    if (path.includes("marketplaceParticipations")) return { status: 200, data: { payload: [US] } };
    if (path.includes("/fba/inventory/")) return { status: 401, data: { message: "Access to requested resource is denied" } };
    throw new Error(`fees không được gọi khi inventory fail: ${method} ${path}`);
  });
  const r = await discoverSellerIdentity({ spapi, region: "NA" });
  assert.equal(r.ok, false);
  assert.equal(r.marketplace?.id, "ATVPDKIKX0DER");
  assert.equal(r.steps.marketplaces.ok, true);
  assert.equal(r.steps.inventory.ok, false);
  assert.match(r.steps.inventory.error ?? "", /HTTP 401/);
  assert.equal(r.steps.feesEstimate.skipped, true);
});

test("5. inventory trống (0 SKU) → DÙNG ASIN dự phòng, vẫn ra sellerId", async () => {
  const spapi = mockSpapi((method, path) => {
    if (path.includes("marketplaceParticipations")) return { status: 200, data: { payload: [US] } };
    if (path.includes("/fba/inventory/")) {
      return { status: 200, data: { inventorySummaries: [] } };
    }
    if (path.includes("/products/fees/v0/items/")) {
      // ASIN dự phòng mặc định (B08N5WRWNW) phải xuất hiện trong path
      assert.match(path, /B08N5WRWNW/, `phải gọi fees bằng ASIN dự phòng, thực tế ${path}`);
      return { status: 200, data: FEES_OK };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  const r = await discoverSellerIdentity({ spapi, region: "NA" });
  assert.equal(r.ok, true, "inventory trống vẫn phải tra được sellerId");
  assert.equal(r.inventory?.skuCount, 0);
  assert.equal(r.inventory?.sampleAsin, null);
  assert.equal(r.steps.inventory.ok, true);
  assert.equal(r.steps.feesEstimate.ok, true);
  assert.equal(r.sellerId, "A1VEXIMSELF");
  assert.equal(r.usedFallbackAsin, true);
  assert.equal(r.asin, "B08N5WRWNW");
  assert.equal(r.steps.feesEstimate.data?.usedFallbackAsin, true);
  assert.equal(r.steps.feesEstimate.data?.asin, "B08N5WRWNW");
});

test("5b. fallbackAsin=null + inventory trống → fees skipped (không tự bịa ASIN)", async () => {
  const spapi = mockSpapi((method, path) => {
    if (path.includes("marketplaceParticipations")) return { status: 200, data: { payload: [US] } };
    if (path.includes("/fba/inventory/")) {
      return { status: 200, data: { inventorySummaries: [] } };
    }
    throw new Error(`fees không được gọi khi tắt fallback ASIN: ${method} ${path}`);
  });
  const r = await discoverSellerIdentity({ spapi, region: "NA", fallbackAsin: null });
  assert.equal(r.ok, false);
  assert.equal(r.sellerId, null);
  assert.equal(r.usedFallbackAsin, false);
  assert.equal(r.steps.inventory.ok, true);
  assert.equal(r.steps.feesEstimate.skipped, true);
  assert.match(r.steps.feesEstimate.skipReason ?? "", /ASIN/);
});

test("5c. inventory CÓ ASIN → không dùng fallback (ưu tiên SKU thật của mình)", async () => {
  const spapi = mockSpapi((method, path) => {
    if (path.includes("marketplaceParticipations")) return { status: 200, data: { payload: [US] } };
    if (path.includes("/fba/inventory/")) return { status: 200, data: SUMMARIES };
    if (path.includes("/products/fees/v0/items/")) {
      assert.match(path, /B0TEST0001/, `phải dùng ASIN từ inventory, thực tế ${path}`);
      return { status: 200, data: FEES_OK };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  const r = await discoverSellerIdentity({ spapi, region: "NA" });
  assert.equal(r.usedFallbackAsin, false);
  assert.equal(r.asin, "B0TEST0001");
  assert.equal(r.steps.feesEstimate.data?.usedFallbackAsin, false);
});

test("5d. ƯU TIÊN US: shop tham gia CA + US, Amazon trả CA trước", async () => {
  const CA = {
    marketplace: {
      id: "A2EUQ1WTGCTBG2",
      name: "Amazon.ca",
      countryCode: "CA",
      defaultCurrencyCode: "CAD",
      domainName: "www.amazon.ca",
    },
    participation: { isParticipating: true, hasSuspendedListings: false },
  };
  const spapi = mockSpapi((method, path) => {
    if (path.includes("marketplaceParticipations")) {
      return { status: 200, data: { payload: [CA, US] } }; // CA đứng TRƯỚC
    }
    if (path.includes("/fba/inventory/")) return { status: 200, data: SUMMARIES };
    if (path.includes("/products/fees/v0/items/")) {
      return {
        status: 200,
        data: {
          payload: {
            FeesEstimateResult: {
              Status: "Success",
              FeesEstimateIdentifier: {
                MarketplaceId: "ATVPDKIKX0DER",
                SellerId: "AQMVYI4HJTI4C",
                IdType: "ASIN",
                IdValue: "B0TEST0001",
              },
            },
          },
        },
      };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  const r = await discoverSellerIdentity({ spapi, region: "NA" });
  assert.equal(r.marketplace?.id, "ATVPDKIKX0DER", "phải chốt US, không phải CA");
  assert.equal(r.marketplace?.countryCode, "US");
  assert.equal(r.sellerId, "AQMVYI4HJTI4C");
  assert.equal(r.marketplaces.length, 2, "vẫn trả đủ danh sách marketplace");
  // sqlHint phải khai CẢ US lẫn CA (shop bán 2 marketplace)
  assert.match(r.sqlHint ?? "", /ATVPDKIKX0DER/);
  assert.match(r.sqlHint ?? "", /A2EUQ1WTGCTBG2/);
  assert.match(r.sqlHint ?? "", /AQMVYI4HJTI4C/);
  assert.match(r.sqlHint ?? "", /data_source = 'production'/);
});

test("5e. preferredMarketplaceId có thể đổi (không hard-code US)", async () => {
  const r = pickActiveMarketplace(
    parseMarketplaces({ payload: [US, SUSPENDED] }),
    "A2EUQ1WTGCTBG2",
  );
  // không có CA active → rơi về active đầu tiên (US)
  assert.equal(r?.id, "ATVPDKIKX0DER");
});

test("6. chọn marketplace đầu tiên KHÔNG suspended + parse helpers", async () => {
  const list = parseMarketplaces({ payload: [SUSPENDED, US] });
  assert.equal(list.length, 2);
  assert.equal(list[0].isSuspended, true);
  assert.equal(list[1].isSuspended, false);
  const picked = pickActiveMarketplace(list);
  assert.equal(picked?.id, "ATVPDKIKX0DER");

  const inv = parseInventory({
    payload: {
      inventorySummaries: [{ asin: "B00SAMPLE", sellerSku: "SKU-1" }],
      pagination: { nextToken: "abc" },
    },
  });
  assert.equal(inv.skuCount, 1);
  assert.equal(inv.hasMore, true);
  assert.equal(inv.sampleAsin, "B00SAMPLE");

  const spapi = mockSpapi((method, path) => {
    if (path.includes("marketplaceParticipations")) {
      return { status: 200, data: { payload: [SUSPENDED, US] } };
    }
    if (path.includes("/fba/inventory/")) return { status: 200, data: SUMMARIES };
    if (path.includes("/fees/")) return { status: 200, data: FEES_OK };
    throw new Error(`unexpected ${method} ${path}`);
  });
  const r = await discoverSellerIdentity({ spapi, region: "NA" });
  assert.equal(r.marketplace?.id, "ATVPDKIKX0DER");
  assert.equal(r.marketplaces.length, 2);
  assert.equal(r.ok, true);
});
