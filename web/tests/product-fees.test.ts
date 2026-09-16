/**
 * Test Product Fees API v0 — số CHUẨN SP-API cho thẩm định G1.
 *
 * Sinh ra từ sự cố B074VBLKSL (16/09/2026): Revenue Calculator Amazon cho
 * referral $0.79 + FBA $3.91 (biên +50.6%) nhưng engine phán −14.9% vì referral
 * mặc định 15% + bảng phí ước lượng $5.90. Fixture dưới đây chính là các con
 * số của ca đó — khoá lại để không tái diễn.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SP_API_FEE_TYPES,
  mapFeesEstimateResponse,
  referralRatePctFromFee,
} from "../src/lib/worker/domain/product-fees.ts";
import {
  PRODUCT_FEES_RATE_LIMIT,
  ProductFeesClient,
} from "../src/lib/worker/amazon/product-fees.ts";
import { lookupSpApiFeesForAsin } from "../src/lib/worker/run-product-fees.ts";
import type { LwaTokenManager } from "../src/lib/worker/amazon/lwa.ts";

const lwaFake = { getAccessToken: async () => "tok" } as unknown as LwaTokenManager;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Response chuẩn shape model productFeesV0.json — số của ASIN B074VBLKSL @ $9.89. */
const FEES_OK_PAYLOAD = {
  payload: {
    Status: "Success",
    FeesEstimateIdentifier: {
      MarketplaceId: "ATVPDKIKX0DER",
      SellerId: "A1SELLER",
      IdType: "ASIN",
      IdValue: "B074VBLKSL",
      IsAmazonFulfilled: true,
      SellerInputIdentifier: "vexim-1",
    },
    FeesEstimate: {
      TimeOfFeesEstimation: "2026-09-16T08:00:00Z",
      TotalFeesEstimate: { CurrencyCode: "USD", Amount: 4.7 },
      FeeDetailList: [
        {
          FeeType: "ReferralFee",
          FeeAmount: { CurrencyCode: "USD", Amount: 0.79 },
          FinalFee: { CurrencyCode: "USD", Amount: 0.79 },
        },
        {
          FeeType: "FulfillmentFees",
          FeeAmount: { CurrencyCode: "USD", Amount: 3.91 },
          FinalFee: { CurrencyCode: "USD", Amount: 3.91 },
        },
      ],
    },
  },
};

test("mapFeesEstimateResponse: ca B074VBLKSL — referral 8% + FBA $3.91, tổng $4.70", () => {
  const r = mapFeesEstimateResponse(FEES_OK_PAYLOAD);
  assert.equal(r.ok, true);
  assert.equal(r.referralFee, 0.79); // KHÔNG phải $1.48 của mặc định 15%
  assert.equal(r.fulfillmentFee, 3.91); // KHÔNG phải $5.90 của bảng ước lượng
  assert.equal(r.totalFees, 4.7);
  assert.equal(r.currency, "USD");
  assert.equal(r.lines.length, 2);
  assert.equal(r.timeOfEstimation, "2026-09-16T08:00:00Z");
  assert.equal(r.sellerId, "A1SELLER");
});

test("mapFeesEstimateResponse: FulfillmentFees + FBAWeightHandlingFee tách riêng vẫn cộng gộp", () => {
  const json = structuredClone(FEES_OK_PAYLOAD);
  json.payload.FeesEstimate.FeeDetailList.push({
    FeeType: SP_API_FEE_TYPES.weightHandling,
    FeeAmount: { CurrencyCode: "USD", Amount: 0.4 },
    FinalFee: { CurrencyCode: "USD", Amount: 0.4 },
  } as never);
  const r = mapFeesEstimateResponse(json);
  assert.equal(r.fulfillmentFee, 4.31); // 3.91 + 0.40
});

test("mapFeesEstimateResponse: lỗi nghiệp vụ (Status ≠ Success) → ok=false kèm mã Amazon", () => {
  const r = mapFeesEstimateResponse({
    payload: {
      Status: "ClientError",
      Error: { Type: "Sender", Code: "InvalidParameterValue", Message: "Please verify your inputs." },
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, "ClientError");
  assert.ok(r.errorMessage?.includes("verify"));
});

test("mapFeesEstimateResponse: errors[] cấp ngoài (token/quyền) → ok=false", () => {
  const r = mapFeesEstimateResponse({ errors: [{ code: "Unauthorized", message: "token hết hạn" }] });
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, "Unauthorized");
});

test("mapFeesEstimateResponse: SHAPE THẬT payload.FeesEstimateResult + FeeType FBAFees vẫn parse đúng", () => {
  // Response THẬT bọc thêm lớp FeesEstimateResult và phí FBA tên "FBAFees"
  // (mẫu từ selling-partner-api-docs issue #3487, đổi EUR→USD).
  const r = mapFeesEstimateResponse({
    payload: {
      FeesEstimateResult: {
        Status: "Success",
        FeesEstimateIdentifier: {
          MarketplaceId: "ATVPDKIKX0DER",
          IdType: "ASIN",
          SellerId: "A3SELLER",
          IsAmazonFulfilled: true,
          IdValue: "B09DTD7DQG",
          SellerInputIdentifier: "vexim-1",
        },
        FeesEstimate: {
          TimeOfFeesEstimation: "2026-09-16T11:10:55.000Z",
          TotalFeesEstimate: { CurrencyCode: "USD", Amount: 5.16 },
          FeeDetailList: [
            {
              FeeType: "ReferralFee",
              FeeAmount: { CurrencyCode: "USD", Amount: 0.79 },
              FinalFee: { CurrencyCode: "USD", Amount: 0.79 },
              FeePromotion: { CurrencyCode: "USD", Amount: 0 },
            },
            {
              FeeType: "VariableClosingFee",
              FeeAmount: { CurrencyCode: "USD", Amount: 0 },
              FinalFee: { CurrencyCode: "USD", Amount: 0 },
            },
            {
              FeeType: "FBAFees",
              FeeAmount: { CurrencyCode: "USD", Amount: 4.37 },
              FinalFee: { CurrencyCode: "USD", Amount: 4.37 },
              IncludedFeeDetailList: [
                { FeeType: "FBAPickAndPack", FinalFee: { CurrencyCode: "USD", Amount: 4.37 } },
              ],
            },
          ],
        },
      },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.referralFee, 0.79);
  assert.equal(r.fulfillmentFee, 4.37); // FBAFees — KHÔNG nhân đôi với IncludedFeeDetailList
  assert.equal(r.variableClosingFee, 0);
  assert.equal(r.totalFees, 5.16);
  assert.equal(r.sellerId, "A3SELLER");
});

test("mapFeesEstimateResponse: lỗi shape thật (bọc FeesEstimateResult) vẫn lộ mã + thông điệp Amazon", () => {
  const r = mapFeesEstimateResponse({
    payload: {
      FeesEstimateResult: {
        Status: "ClientError",
        Error: { Type: "Sender", Code: "InvalidParameterValue", Message: "Please verify your inputs." },
      },
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, "ClientError");
  assert.ok(r.errorMessage?.includes("verify"));
});

test("mapFeesEstimateResponse: shape lạ → KHÔNG 'Unknown' mù mờ, kèm trích đoạn payload để chẩn đoán", () => {
  const r = mapFeesEstimateResponse({ payload: { giLa: 1 } });
  assert.equal(r.ok, false);
  assert.ok(r.errorMessage?.includes("Trích đoạn response"), "phải kèm payload thô để dò lỗi");
});

test("referralRatePctFromFee: $0.79 @ $9.89 → 8% (danh mục điện tử), làm tròn 1 chữ số", () => {
  assert.equal(referralRatePctFromFee(0.79, 9.89), 8);
  assert.equal(referralRatePctFromFee(1.48, 9.89), 15);
  assert.equal(referralRatePctFromFee(null, 9.89), null);
  assert.equal(referralRatePctFromFee(0.79, 0), null);
});

test("PRODUCT_FEES_RATE_LIMIT: đúng 1 rps · burst 2 theo docs Product Fees chính thức", () => {
  assert.equal(PRODUCT_FEES_RATE_LIMIT.estimate.rate, 1);
  assert.equal(PRODUCT_FEES_RATE_LIMIT.estimate.burst, 2);
});

test("client: POST đúng path ASIN + body FeesEstimateRequest theo model chính thức", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return jsonResponse(FEES_OK_PAYLOAD);
  }) as unknown as typeof fetch;
  const client = new ProductFeesClient(lwaFake, { fetchFn, sleep: async () => {}, host: "https://example.test" });

  const r = await client.estimateForAsin({
    asin: "b074vblksl", // chữ thường → phải được chuẩn hoá
    marketplaceId: "ATVPDKIKX0DER",
    price: 9.89,
  });

  assert.equal(r.ok, true);
  assert.equal(r.referralFee, 0.79);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/products/fees/v0/items/B074VBLKSL/feesEstimate"));
  assert.equal(calls[0].init.method, "POST");
  const body = JSON.parse(String(calls[0].init.body)) as {
    FeesEstimateRequest: {
      MarketplaceId: string;
      IsAmazonFulfilled: boolean;
      Identifier: string;
      PriceToEstimateFees: { ListingPrice: { CurrencyCode: string; Amount: number } };
    };
  };
  assert.equal(body.FeesEstimateRequest.MarketplaceId, "ATVPDKIKX0DER");
  assert.equal(body.FeesEstimateRequest.IsAmazonFulfilled, true);
  assert.ok(body.FeesEstimateRequest.Identifier.startsWith("vexim-"));
  assert.equal(body.FeesEstimateRequest.PriceToEstimateFees.ListingPrice.Amount, 9.89);
  assert.equal(body.FeesEstimateRequest.PriceToEstimateFees.ListingPrice.CurrencyCode, "USD");
});

test("client: 429 được thử lại rồi thành công; ASIN/giá sai bị chặn TRƯỚC khi gọi mạng", async () => {
  let n = 0;
  const fetchFn = (async () => {
    n += 1;
    if (n === 1) return jsonResponse({ errors: [{ code: "QuotaExceeded", message: "slow down" }] }, 429);
    return jsonResponse(FEES_OK_PAYLOAD);
  }) as unknown as typeof fetch;
  const client = new ProductFeesClient(lwaFake, { fetchFn, sleep: async () => {}, host: "https://example.test" });
  const r = await client.estimateForAsin({ asin: "B074VBLKSL", marketplaceId: "ATVPDKIKX0DER", price: 9.89 });
  assert.equal(r.ok, true);
  assert.equal(n, 2);

  let calls = 0;
  const noNet = (async () => {
    calls += 1;
    return jsonResponse({});
  }) as unknown as typeof fetch;
  const c2 = new ProductFeesClient(lwaFake, { fetchFn: noNet, host: "https://example.test" });
  await assert.rejects(
    () => c2.estimateForAsin({ asin: "ngắn", marketplaceId: "ATVPDKIKX0DER", price: 9.89 }),
    /ASIN/,
  );
  await assert.rejects(
    () => c2.estimateForAsin({ asin: "B074VBLKSL", marketplaceId: "ATVPDKIKX0DER", price: 0 }),
    /price/,
  );
  assert.equal(calls, 0);
});

test("runner: chưa có client (thiếu AMAZON_LWA_*) → báo lý do rõ, KHÔNG gọi mạng", async () => {
  const res = await lookupSpApiFeesForAsin({ asin: "B074VBLKSL", price: 9.89 }, { client: null, shops: [] });
  assert.equal(res.ok, false);
  assert.ok(res.reason?.includes("AMAZON_LWA"));
  assert.equal(res.estimate, null);
  assert.equal(res.marketplaceId, "ATVPDKIKX0DER"); // fallback US
  assert.equal(res.marketplaceFallback, true);
});

test("runner: có shop production → dùng marketplace của shop; client mock trả số chuẩn", async () => {
  const shop = {
    id: "shop-1",
    sellerId: "SELLER",
    marketplace: "ATVPDKIKX0DER",
    displayName: "Shop CA · AQMV",
    leadDays: 32,
    safetyDays: 14,
  };
  const client = {
    estimateForAsin: async () => mapFeesEstimateResponse(FEES_OK_PAYLOAD),
  } as unknown as never;
  const res = await lookupSpApiFeesForAsin(
    { asin: "B074VBLKSL", price: 9.89 },
    { client: client as never, shops: [shop] },
  );
  assert.equal(res.ok, true);
  assert.equal(res.shopName, "Shop CA · AQMV");
  assert.equal(res.marketplaceFallback, false);
  assert.equal(res.estimate?.referralFee, 0.79);
  assert.equal(res.estimate?.fulfillmentFee, 3.91);
});

test("runner: marketplaceId chỉ định ưu tiên hơn shop — shop CA trong DB vẫn gọi marketplace US (sự cố 16/09/2026)", async () => {
  // DB có shop CA đứng đầu; giá nghiên cứu là USD → KHÔNG được gửi sang
  // A2EUQ1WTGCTBG2 (Amazon sẽ trả ClientError "Please verify your inputs").
  const shop = {
    id: "shop-2",
    sellerId: "SELLER",
    marketplace: "A2EUQ1WTGCTBG2",
    displayName: "P2 · CA",
    leadDays: 32,
    safetyDays: 14,
  };
  const seen: Array<{ marketplaceId: string; currency?: string }> = [];
  const client = {
    estimateForAsin: async (input: { marketplaceId: string; currency?: string }) => {
      seen.push(input);
      return mapFeesEstimateResponse(FEES_OK_PAYLOAD);
    },
  } as unknown as never;
  const res = await lookupSpApiFeesForAsin(
    { asin: "B074VBLKSL", price: 9.89, marketplaceId: "ATVPDKIKX0DER", currency: "USD" },
    { client: client as never, shops: [shop] },
  );
  assert.equal(res.ok, true);
  assert.equal(res.marketplaceId, "ATVPDKIKX0DER");
  assert.equal(res.marketplaceFallback, false);
  assert.equal(res.shopName, "P2 · CA"); // shop vẫn hiển thị trong scope
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.marketplaceId, "ATVPDKIKX0DER"); // KHÔNG gọi CA
  assert.equal(seen[0]?.currency, "USD");
});
