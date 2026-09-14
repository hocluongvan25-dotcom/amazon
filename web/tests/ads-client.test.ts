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
