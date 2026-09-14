/**
 * Test client Amazon Ads — so khớp với tài liệu chính thức
 * (amzn/ads-advanced-tools-docs, Postman collection + Reporting v3 docs):
 *
 *   1. Các endpoint /sp/* PHẢI gửi vendor media type
 *      (application/vnd.spCampaign.v3+json…) cho CẢ Content-Type lẫn Accept —
 *      application/json có thể bị 415 UNSUPPORTED_MEDIA_TYPE.
 *   2. Reporting v3 giữ content type riêng application/vnd.createasyncreportrequest.v3+json.
 *   3. spPurchasedProduct groupBy là ["asin"] (tên cột purchasedAsin ≠ tên groupBy).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { spV3MediaType } from "../src/lib/worker/amazon/ads.ts";
import { ADS_REPORT_SPECS } from "../src/lib/worker/ads/registry.ts";

test("spV3MediaType: map đúng vendor media type theo Postman collection chính thức", () => {
  assert.equal(spV3MediaType("/sp/campaigns"), "application/vnd.spCampaign.v3+json");
  assert.equal(spV3MediaType("/sp/campaigns/list"), "application/vnd.spCampaign.v3+json");
  assert.equal(spV3MediaType("/sp/adGroups/list"), "application/vnd.spAdGroup.v3+json");
  assert.equal(spV3MediaType("/sp/keywords"), "application/vnd.spKeyword.v3+json");
  assert.equal(spV3MediaType("/sp/keywords/list"), "application/vnd.spKeyword.v3+json");
  assert.equal(spV3MediaType("/sp/targets/list"), "application/vnd.spTargetingClause.v3+json");
  assert.equal(spV3MediaType("/sp/negativeKeywords"), "application/vnd.spNegativeKeyword.v3+json");
  assert.equal(spV3MediaType("/sp/negativeKeywords/list"), "application/vnd.spNegativeKeyword.v3+json");
  assert.equal(spV3MediaType("/sp/productAds/list"), "application/vnd.spProductAd.v3+json");
});

test("spV3MediaType: campaignNegative* KHÔNG bị nhầm thành campaigns (prefix dài trước)", () => {
  assert.equal(
    spV3MediaType("/sp/campaignNegativeKeywords"),
    "application/vnd.spCampaignNegativeKeyword.v3+json",
  );
  assert.equal(
    spV3MediaType("/sp/campaignNegativeTargets/list"),
    "application/vnd.spCampaignNegativeTargetingClause.v3+json",
  );
});

test("spV3MediaType: path ngoài /sp/* → null (dùng application/json)", () => {
  assert.equal(spV3MediaType("/v2/profiles"), null);
  assert.equal(spV3MediaType("/reporting/reports"), null);
  assert.equal(spV3MediaType("/reporting/reports/abc-123"), null);
});

test("registry: spPurchasedProduct groupBy = ['asin'] theo docs Reporting v3", () => {
  const spec = ADS_REPORT_SPECS["purchased-products"];
  assert.deepEqual(spec.groupBy, ["asin"]);
  // Cột purchasedAsin vẫn nằm trong columns — chỉ groupBy là "asin"
  assert.ok(spec.columns.includes("purchasedAsin"));
});

test("registry: các groupBy còn lại khớp docs (campaign/targeting/searchTerm/advertiser)", () => {
  assert.deepEqual(ADS_REPORT_SPECS["campaigns"].groupBy, ["campaign"]);
  assert.deepEqual(ADS_REPORT_SPECS["targeting"].groupBy, ["targeting"]);
  assert.deepEqual(ADS_REPORT_SPECS["search-terms"].groupBy, ["searchTerm"]);
  assert.deepEqual(ADS_REPORT_SPECS["advertised-products"].groupBy, ["advertiser"]);
});

/* ============================================================================
 * Chẩn đoán lỗi LWA — unauthorized_client là lỗi CẤU HÌNH env, không phải
 * token shop. Re-authorize không sửa được; message phải chỉ đúng chỗ sửa.
 * ==========================================================================*/
import { AdsApiRequestError, AdsLwaTokenManager } from "../src/lib/worker/amazon/ads.ts";

test("AdsApiRequestError: unauthorized_client → isConfigError (KHÔNG khuyên re-authorize)", () => {
  const e = new AdsApiRequestError({
    status: 400,
    code: "unauthorized_client",
    message: '{"error_index":"xxx"}',
  });
  assert.equal(e.isConfigError, true);
  // isAuthError cũng match (regex 'unauthorized') — nhưng job phải ưu tiên
  // isConfigError trước, nên chỉ cần isConfigError đúng là đủ.
});

test("AdsApiRequestError: invalid_grant → KHÔNG phải config error (là token hết hạn)", () => {
  const e = new AdsApiRequestError({ status: 400, code: "invalid_grant", message: "expired" });
  assert.equal(e.isConfigError, false);
  assert.equal(e.isAuthError, true);
});

test("AdsLwaTokenManager: LWA 400 unauthorized_client → message kèm hướng dẫn sửa env AMAZON_ADS_*", async () => {
  const fakeFetch = (async () =>
    new Response('{"error":"unauthorized_client","error_description":"Client not authorized"}', {
      status: 400,
    })) as unknown as typeof fetch;
  const mgr = new AdsLwaTokenManager(
    { clientId: "cid", clientSecret: "sec", refreshToken: "rt" },
    fakeFetch,
  );
  await assert.rejects(
    () => mgr.getAccessToken(),
    (e: unknown) => {
      assert.ok(e instanceof AdsApiRequestError);
      assert.equal(e.code, "unauthorized_client");
      assert.match(e.message, /AMAZON_ADS_REFRESH_TOKEN không thuộc về cặp/);
      assert.match(e.message, /re-authorize shop KHÔNG sửa được/i);
      return true;
    },
  );
});

test("AdsLwaTokenManager: LWA 400 invalid_grant → message khuyên lấy refresh token mới", async () => {
  const fakeFetch = (async () =>
    new Response('{"error":"invalid_grant","error_description":"expired"}', { status: 400 })) as unknown as typeof fetch;
  const mgr = new AdsLwaTokenManager(
    { clientId: "cid", clientSecret: "sec", refreshToken: "rt" },
    fakeFetch,
  );
  await assert.rejects(
    () => mgr.getAccessToken(),
    (e: unknown) => {
      assert.ok(e instanceof AdsApiRequestError);
      assert.match(e.message, /refresh token Ads hết hạn|bị thu hồi/);
      return true;
    },
  );
});
