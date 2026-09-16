/**
 * Test Module 5 phần 1 (0020) — ENGINE Amazon Ads: client + registry/parser.
 *
 * Bốn chỗ dễ "xanh giả" nhất, và test khoá từng chỗ:
 *   1. HEADER: Ads API cần `Amazon-Advertising-API-ClientId` + (với API theo
 *      profile) `Amazon-Advertising-API-Scope`. Thiếu Scope là 400/404 rất khó
 *      đoán — test kiểm tra header thật, không kiểm tra "có gọi hàm".
 *   2. CONTENT-TYPE của Reporting v3:
 *      `application/vnd.createasyncreportrequest.v3+json` + thân request có
 *      reportTypeId/groupBy/timeUnit=DAILY/format=GZIP_JSON.
 *   3. PHÂN BIỆT LỖI: 429 → isThrottled (thử lại sau); 401/403 → isAuthError
 *      (PHẢI re-authorize ở Module 0). Nhầm hai cái này là hỏng cả luồng SOP-11.
 *   4. PARSER: report GZIP-đã-giải-nén có thể là mảng JSON / JSON-lines / object
 *      bọc mảng; dòng thiếu khoá phải bị BỎ và đếm, KHÔNG bịa 0; không lưu số
 *      dẫn xuất (ACOS/ROAS/CPC) mà v3 không trả.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { MockDbAdapter } from "../../web/src/lib/worker/db/adapter.ts";
import {
  AdsApiRequestError,
  AdsClient,
  AdsLwaTokenManager,
  adsHostForRegion,
  normalizeReportInfo,
} from "../src/amazon/ads.ts";
import {
  ADS_ALL_KINDS,
  ADS_REPORT_SPECS,
  adsKindOfReportType,
  adsSpecOf,
  importAdsReport,
  isAdsReportKind,
  parseAdsReportText,
  readAdsReportRecords,
} from "../src/ads/registry.ts";

// ============================================================================
// Hạ tầng fetch giả — ghi lại request để kiểm tra header/body
// ============================================================================

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function makeFetch(routes: {
  [match: string]: (call: Call) => { status?: number; json?: unknown; text?: string; bytes?: Uint8Array; headers?: Record<string, string> };
}): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = String(v);
    const bodyText = typeof init?.body === "string" ? init.body : null;
    const call: Call = {
      url,
      method: String(init?.method ?? "GET"),
      headers,
      body: bodyText ? JSON.parse(bodyText) : null,
    };
    calls.push(call);
    const route = Object.entries(routes).find(([m]) => url.includes(m));
    if (!route) throw new Error(`fetch giả: không có route cho ${url}`);
    const out = route[1](call);
    const status = out.status ?? 200;
    const payload = out.bytes
      ? out.bytes
      : out.text !== undefined
        ? out.text
        : JSON.stringify(out.json ?? {});
    return new Response(payload, {
      status,
      headers: { "content-type": "application/json", ...(out.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const client = (fetchFn: typeof fetch, clientId = "amzn1.application-oa2-client.ads") =>
  new AdsClient({
    host: adsHostForRegion("NA"),
    clientId,
    lwa: new AdsLwaTokenManager(
      { clientId, clientSecret: "shh", refreshToken: "Atzr|refresh-ads" },
      fetchFn,
    ),
    fetchFn,
    maxRetries: 1,
    sleep: async () => {},
  });

// ============================================================================
// 1. LWA riêng của app Ads
// ============================================================================

test("ads: LWA dùng grant_type=refresh_token + cache token (không gọi lại mỗi request)", async () => {
  const { fetchFn, calls } = makeFetch({
    "api.amazon.com/auth/o2/token": () => ({ json: { access_token: "Atza|tok", expires_in: 3600 } }),
    "/v2/profiles": () => ({ json: [] }),
  });
  const c = client(fetchFn);
  await c.getProfiles();
  await c.getProfiles();
  const tokenCalls = calls.filter((x) => x.url.includes("auth/o2/token"));
  assert.equal(tokenCalls.length, 1, "token phải được cache giữa 2 request");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(calls[0].body, null); // body là URLSearchParams, không phải JSON
});

test("ads: LWA invalid_grant → isAuthError (KHÔNG phải lỗi tạm thời)", async () => {
  const { fetchFn } = makeFetch({
    "auth/o2/token": () => ({ status: 400, json: { error: "invalid_grant", error_description: "refresh token expired" } }),
  });
  const c = client(fetchFn);
  await assert.rejects(
    () => c.getProfiles(),
    (e: unknown) => {
      assert.ok(e instanceof AdsApiRequestError);
      assert.equal(e.isAuthError, true);
      assert.equal(e.isThrottled, false);
      return true;
    },
  );
});

// ============================================================================
// 2. Profiles + Campaign Management v3
// ============================================================================

test("ads: getProfiles đọc accountInfo (marketplaceStringId/type) + chịu được object bọc mảng", async () => {
  const { fetchFn, calls } = makeFetch({
    "auth/o2/token": () => ({ json: { access_token: "t", expires_in: 3600 } }),
    "/v2/profiles": () => ({
      json: {
        profiles: [
          {
            profileId: 123,
            countryCode: "US",
            currency: "USD",
            timezone: "America/Los_Angeles",
            accountInfo: { marketplaceStringId: "ATVPDKIKX0DER", type: "seller", name: "VEXIM" },
          },
        ],
      },
    }),
  });
  const c = client(fetchFn);
  const profiles = await c.getProfiles();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].profileId, "123");
  assert.equal(profiles[0].marketplaceId, "ATVPDKIKX0DER");
  assert.equal(profiles[0].currency, "USD");
  // Header bắt buộc của Ads (không có Scope ở API profiles — Scope chỉ cho API theo profile)
  assert.equal(calls[1].headers["amazon-advertising-api-clientid"], "amzn1.application-oa2-client.ads");
  assert.equal(calls[1].headers.authorization, "Bearer t");
});

test("ads: listCampaigns gắn Amazon-Advertising-API-Scope + đi hết phân trang nextToken", async () => {
  let page = 0;
  const { fetchFn, calls } = makeFetch({
    "auth/o2/token": () => ({ json: { access_token: "t", expires_in: 3600 } }),
    "/sp/campaigns/list": () => {
      page++;
      return page === 1
        ? { json: { campaigns: [{ campaignId: "C-1", name: "Vali", state: "ENABLED", budget: { budget: 20, budgetCurrency: "USD", budgetType: "DAILY" } }], nextToken: "T2" } }
        : { json: { campaigns: [{ campaignId: "C-2", name: "Auto" }] } };
    },
  });
  const c = client(fetchFn);
  const campaigns = await c.listCampaigns("999");
  assert.equal(campaigns.length, 2);
  assert.equal(campaigns[0].dailyBudget, null, "v3 gói ngân sách trong `budget` — client đọc thêm budgetCurrency/budgetType");
  assert.equal(campaigns[0].budgetCurrency, "USD");
  const listCalls = calls.filter((x) => x.url.includes("/sp/campaigns/list"));
  assert.equal(listCalls.length, 2, "phải đi tiếp khi có nextToken");
  assert.equal(listCalls[0].headers["amazon-advertising-api-scope"], "999");
  assert.equal(listCalls[1].body && (listCalls[1].body as Record<string, unknown>).nextToken, "T2");
});

test("ads: listTargets gộp keyword + product target về MỘT kiểu (A2 hiển thị chung bảng)", async () => {
  const { fetchFn } = makeFetch({
    "auth/o2/token": () => ({ json: { access_token: "t", expires_in: 3600 } }),
    "/sp/keywords/list": () => ({
      json: { keywords: [{ keywordId: "KW-1", adGroupId: "AG-1", campaignId: "C-1", keywordText: "vali 20 inch", matchType: "exact", bid: 1.1, state: "ENABLED" }] },
    }),
    "/sp/targets/list": () => ({
      json: { targetingClauses: [{ targetId: "T-1", adGroupId: "AG-1", campaignId: "C-1", expression: [{ type: "ASIN_SAME_AS", value: "B08N5WRWNW" }], bid: 0.9 }] },
    }),
  });
  const c = client(fetchFn);
  const targets = await c.listTargets("999");
  assert.equal(targets.length, 2);
  const kw = targets.find((t) => t.targetKind === "keyword");
  const pt = targets.find((t) => t.targetKind === "product_target");
  assert.equal(kw?.targetKey, "KW-1");
  assert.equal(kw?.matchType, "EXACT", "matchType chuẩn hoá HOA (DB lưu HOA)");
  assert.equal(pt?.targetKey, "T-1");
  assert.equal(pt?.expressionType, "ASIN_SAME_AS");
  assert.equal(pt?.expressionValue, "B08N5WRWNW");
});

// ============================================================================
// 3. Reporting v3 — request + trạng thái + tải file
// ============================================================================

test("ads: createReport dùng đúng Content-Type vnd.createasyncreportrequest.v3+json + timeUnit DAILY + format GZIP_JSON", async () => {
  const { fetchFn, calls } = makeFetch({
    "auth/o2/token": () => ({ json: { access_token: "t", expires_in: 3600 } }),
    "/reporting/reports": () => ({ json: { reportId: "R-1" } }),
  });
  const c = client(fetchFn);
  const spec = adsSpecOf("campaigns");
  const { reportId } = await c.createReport({
    name: "VEXIM spCampaigns",
    startDate: "2026-08-14",
    endDate: "2026-09-13",
    configuration: {
      adProduct: spec.adProduct,
      groupBy: spec.groupBy,
      columns: spec.columns,
      reportTypeId: spec.reportTypeId,
      timeUnit: "DAILY",
      format: "GZIP_JSON",
    },
  });
  assert.equal(reportId, "R-1");
  const post = calls.find((x) => x.url.endsWith("/reporting/reports") && x.method === "POST");
  assert.ok(post);
  assert.equal(post.headers["content-type"], "application/vnd.createasyncreportrequest.v3+json");
  const body = post.body as { configuration: Record<string, unknown> };
  assert.equal(body.configuration.reportTypeId, "spCampaigns");
  assert.equal(body.configuration.timeUnit, "DAILY");
  assert.equal(body.configuration.format, "GZIP_JSON");
  assert.deepEqual(body.configuration.groupBy, ["campaign"]);
});

test("ads: KHÔNG có spec nào dùng HOURLY (v3 chỉ DAILY/SUMMARY) và KHÔNG xin cột dẫn xuất", async () => {
  const banned = ["acos", "roas", "cpc", "ctr", "hourly"];
  for (const kind of ADS_ALL_KINDS) {
    const spec = adsSpecOf(kind);
    for (const col of spec.columns) {
      for (const b of banned) {
        assert.ok(
          !col.toLowerCase().includes(b),
          `${kind}: cột "${col}" không được yêu cầu (v3 không trả / không có HOURLY)`,
        );
      }
    }
    assert.ok(spec.columns.includes("date"), `${kind}: report theo ngày phải xin cột date`);
    assert.equal(spec.cooldownHours, 4);
  }
});

test("ads: trạng thái lạ → PROCESSING (poll tiếp), FAILED giữ failureReason", () => {
  assert.equal(normalizeReportInfo({ status: "WEIRD" }).status, "PROCESSING");
  assert.equal(normalizeReportInfo({ status: "completed" }).status, "COMPLETED");
  const failed = normalizeReportInfo({ status: "FAILED", failureReason: "Invalid column: acos7d" });
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.failureReason, "Invalid column: acos7d");
});

test("ads: downloadReport giải nén GZIP_JSON; file không nén vẫn đọc được", async () => {
  const json = JSON.stringify([{ date: "2026-09-12", campaignId: "C-1", cost: 12.5 }]);
  const gz = new Uint8Array(gzipSync(Buffer.from(json, "utf8")));
  const { fetchFn } = makeFetch({
    "auth/o2/token": () => ({ json: { access_token: "t", expires_in: 3600 } }),
    "files.example/gz": () => ({ bytes: gz }),
    "files.example/plain": () => ({ text: json }),
  });
  const c = client(fetchFn);
  const a = await c.downloadReport("https://files.example/gz");
  assert.equal(a.gzipped, true);
  assert.match(a.text, /"campaignId":"C-1"/);
  const b = await c.downloadReport("https://files.example/plain");
  assert.equal(b.gzipped, false, "file không nén (JSON thô) không được coi là lỗi");
  assert.match(b.text, /campaignId/);
});

test("ads: 429 → isThrottled và thử lại; 401 → isAuthError (không thử lại vô ích)", async () => {
  let attempt = 0;
  const { fetchFn } = makeFetch({
    "auth/o2/token": () => ({ json: { access_token: "t", expires_in: 3600 } }),
    "/sp/campaigns/list": () => {
      attempt++;
      return attempt === 1
        ? { status: 429, json: { code: "Throttling", message: "slow down" } }
        : { json: { campaigns: [] } };
    },
  });
  const c = client(fetchFn);
  await c.listCampaigns("999");
  assert.equal(attempt, 2, "429 phải được thử lại (trần tốc độ không phải lỗi cấu hình)");

  const blocked = makeFetch({
    "auth/o2/token": () => ({ json: { access_token: "t", expires_in: 3600 } }),
    "/sp/campaigns/list": () => ({ status: 403, json: { code: "UnauthorizedException", message: "no access to profile" } }),
  });
  const c2 = client(blocked.fetchFn);
  await assert.rejects(
    () => c2.listCampaigns("999"),
    (e: unknown) => {
      assert.ok(e instanceof AdsApiRequestError);
      assert.equal(e.isAuthError, true);
      assert.equal(blocked.calls.filter((x) => x.url.includes("campaigns/list")).length, 1, "401/403 không được retry");
      return true;
    },
  );
});

// ============================================================================
// 4. Parser — 3 hình dạng file + luật khoá
// ============================================================================

test("ads: readAdsReportRecords đọc được mảng JSON · JSON-lines · object bọc mảng · metadata → rỗng", () => {
  assert.deepEqual(readAdsReportRecords('[{"a":1}]'), [{ a: 1 }]);
  assert.deepEqual(readAdsReportRecords('{"a":1}\n{"a":2}'), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(readAdsReportRecords('{"records":[{"a":1}]}'), [{ a: 1 }]);
  assert.deepEqual(readAdsReportRecords('{"reportId":"R-1","status":"COMPLETED"}'), [], "object metadata không phải dòng dữ liệu");
  assert.deepEqual(readAdsReportRecords(""), []);
  assert.throws(() => readAdsReportRecords("không phải json"), /không phải JSON/);
});

test("ads: parse campaigns giữ ĐÚNG khoá RPC 0020 + bỏ dòng thiếu ngày/campaign", () => {
  const text = JSON.stringify([
    {
      date: "2026-09-12",
      campaignId: "C-1",
      campaignName: "Vali 20 inch",
      campaignStatus: "ENABLED",
      campaignBudgetAmount: "20.00",
      campaignBudgetCurrencyCode: "USD",
      impressions: "1000",
      clicks: "20",
      cost: "18.5",
      sales7d: "90",
      sales14d: "95",
      purchases7d: "3",
      unitsSoldClicks7d: "3",
    },
    { date: "2026-09-12", cost: "5" }, // thiếu campaignId → bỏ
    { campaignId: "C-2", cost: "5" }, // thiếu ngày → bỏ
  ]);
  const parsed = parseAdsReportText("campaigns", text, { adsProfileId: "999", currency: "USD" });
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.skipped, 2);
  assert.equal(parsed.days, 1);
  const row = parsed.rows[0];
  assert.equal(row.day, "2026-09-12");
  assert.equal(row.campaignId, "C-1");
  assert.equal(row.adsProfileId, "999");
  assert.equal(row.currency, "USD");
  assert.equal(row.budgetAmount, 20);
  assert.equal(row.cost, 18.5);
  assert.equal(row.unitsSoldClicks7d, 3);
  assert.equal(row.units7d, 3, "bí danh units7d cho RPC (cùng giá trị, không phải cửa sổ khác)");
  assert.equal(row.acos7d, undefined, "KHÔNG tự tính ACOS rồi lưu vào DB");
  assert.ok(parsed.warnings.some((w) => w.includes("2 dòng bị bỏ")));
});

test("ads: parse search terms giữ nguyên chuỗi người mua gõ (RPC lower() — parser không tự sửa)", () => {
  const parsed = parseAdsReportText(
    "search-terms",
    JSON.stringify([
      { date: "2026-09-12", campaignId: "C-1", adGroupId: "AG-1", keywordId: "KW-1", keyword: "vali 20 inch", matchType: "EXACT", searchTerm: "Vali 20 Inch TSA", clicks: "12", cost: "9.6", sales7d: "0" },
      { date: "2026-09-12", campaignId: "C-1", adGroupId: "AG-1", searchTerm: "  " }, // term rỗng → bỏ
    ]),
  );
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].searchTerm, "Vali 20 Inch TSA");
  assert.equal(parsed.rows[0].keywordText, "vali 20 inch");
  assert.equal(parsed.skipped, 1);
});

test("ads: parse advertised/purchased — đúng ASIN/SKU, purchased đòi purchasedAsin + đọc salesOtherSku", () => {
  const adv = parseAdsReportText(
    "advertised-products",
    JSON.stringify([{ date: "2026-09-12", campaignId: "C-1", advertisedAsin: "B08N5WRWNW", advertisedSku: "SKU-1", cost: "10" }]),
  );
  assert.equal(adv.rows[0].advertisedSku, "SKU-1");
  assert.equal(adv.rows[0].purchasedAsin, undefined);

  const pur = parseAdsReportText(
    "purchased-products",
    JSON.stringify([
      { date: "2026-09-12", campaignId: "C-1", advertisedAsin: "B08N5WRWNW", advertisedSku: "SKU-1", purchasedAsin: "B07OTHER", sales7d: "0", salesOtherSku7d: "45", unitsSoldOtherSku7d: "1" },
      { date: "2026-09-12", campaignId: "C-1", advertisedAsin: "B08N5WRWNW" }, // thiếu purchasedAsin → bỏ
    ]),
  );
  assert.equal(pur.rows.length, 1);
  assert.equal(pur.rows[0].purchasedAsin, "B07OTHER");
  assert.equal(pur.rows[0].salesOtherSku7d, 45);
  assert.equal(pur.skipped, 1);
});

test("ads: importAdsReport từ chối rows của loại report khác (không ghi nhầm bảng)", async () => {
  const db = new MockDbAdapter();
  const parsed = parseAdsReportText(
    "campaigns",
    JSON.stringify([{ date: "2026-09-12", campaignId: "C-1", cost: "1" }]),
  );
  await assert.rejects(
    () => importAdsReport(db, "shop-1", { ...parsed, kind: "search-terms" }),
    /không phải của report "search-terms"/,
  );
});

test("ads: nhập lại cùng dữ liệu → updated, KHÔNG nhân đôi (giống RPC 0020)", async () => {
  const db = new MockDbAdapter();
  const text = JSON.stringify([
    { date: "2026-09-12", campaignId: "C-1", cost: "10", sales7d: "40", clicks: "5" },
    { date: "2026-09-13", campaignId: "C-1", cost: "12", sales7d: "50", clicks: "6" },
  ]);
  const parsed = parseAdsReportText("campaigns", text, { adsProfileId: "999", currency: "USD" });
  const first = await importAdsReport(db, "shop-1", parsed);
  assert.equal(first.inserted, 2);
  assert.equal(first.updated, 0);
  assert.equal(first.days, 2);
  assert.equal(first.currencies, "USD");
  const second = await importAdsReport(db, "shop-1", parsed);
  assert.equal(second.inserted, 0);
  assert.equal(second.updated, 2);
  assert.equal(db.adsCampaignMetrics.length, 2);
});

test("ads: bảng đăng ký khớp reportTypeId ↔ kind (khoá để cron không kéo nhầm)", () => {
  assert.equal(adsKindOfReportType("spTargeting"), "targeting");
  assert.equal(adsKindOfReportType("spPurchasedProduct"), "purchased-products");
  assert.equal(adsKindOfReportType("SP_CAMPAIGNS"), null);
  assert.equal(isAdsReportKind("search-terms"), true);
  assert.equal(isAdsReportKind("spSearchTerm"), false, "isAdsReportKind nhận KIND nội bộ, không phải reportTypeId");
  assert.equal(Object.keys(ADS_REPORT_SPECS).length, 5);
});


// ============================================================================
// 6. HỢP ĐỒNG VỚI TÀI LIỆU AMAZON (chống 400 im lặng)
// ============================================================================
// Vì sao có mục này: một report sai `groupBy` hoặc sai tên cột thì Amazon trả
// 400 ngay lúc tạo report — job chỉ ghi `failed`, màn A1/A2/A3 trắng và KHÔNG ai
// biết vì sao. Ngày 16/09/2026 đã dính ĐÚNG 2 lỗi như vậy:
//   • spTargeting xin cột `targetingExpression` (tên đó thuộc report Sponsored
//     Display) → phải là `targeting`
//   • spPurchasedProduct dùng groupBy `purchasedAsin` (giá trị của
//     sbPurchasedProduct) → phải là `asin`
//
// Nguồn đối chiếu (16/09/2026):
//   • Reporting v3 report types — advertising.amazon.com/API/docs/en-us/guides/
//     reporting/v3/report-types/{campaign,targeting,search-term,
//     advertised-product,purchased-product}
//   • Postman collection chính thức: github.com/amzn/ads-advanced-tools-docs
//     (postman/Amazon_Ads_API.postman_collection.json — mẫu spCampaigns:
//     groupBy ["campaign","adGroup"], columns [impressions, clicks, cost…])
//   • Đối chiếu chéo với connector đang chạy thật (airbyte source-amazon-ads).

/** groupBy hợp lệ của từng report type — CHỈ những giá trị này. */
const DOC_GROUP_BY: Record<string, string[]> = {
  spCampaigns: ["campaign", "adGroup", "campaignPlacement"],
  spTargeting: ["targeting"],
  spSearchTerm: ["searchTerm"],
  spAdvertisedProduct: ["advertiser"],
  spPurchasedProduct: ["asin"],
};

/**
 * Cột hợp lệ theo tài liệu (base metrics + additional metrics của đúng report
 * type). Muốn thêm cột mới ⇒ thêm vào đây TRƯỚC, kèm link tài liệu trong PR.
 */
const DOC_COLUMNS: Record<string, string[]> = {
  spCampaigns: [
  "adGroupId", "adGroupName", "adStatus", "addToList", "attributedSalesSameSku14d",
  "attributedSalesSameSku1d", "attributedSalesSameSku30d", "attributedSalesSameSku7d",
  "campaignApplicableBudgetRuleId", "campaignApplicableBudgetRuleName",
  "campaignBiddingStrategy", "campaignBudgetAmount", "campaignBudgetCurrencyCode",
  "campaignBudgetType", "campaignId", "campaignName", "campaignRuleBasedBudgetAmount",
  "campaignStatus", "clickThroughRate", "clicks", "cost", "costPerClick", "date",
  "impressions", "kindleEditionNormalizedPagesRead14d",
  "kindleEditionNormalizedPagesRoyalties14d", "placementClassification", "purchases14d",
  "purchases1d", "purchases30d", "purchases7d", "purchasesSameSku14d", "purchasesSameSku1d",
  "purchasesSameSku30d", "purchasesSameSku7d", "qualifiedBorrows", "royaltyQualifiedBorrows",
  "sales14d", "sales1d", "sales30d", "sales7d", "spend", "startDate",
  "topOfSearchImpressionShare", "unitsSoldClicks14d", "unitsSoldClicks1d",
  "unitsSoldClicks30d", "unitsSoldClicks7d", "unitsSoldSameSku14d", "unitsSoldSameSku1d",
  "unitsSoldSameSku30d", "unitsSoldSameSku7d",
  ],
  spTargeting: [
  "acosClicks14d", "acosClicks7d", "adGroupId", "adGroupName", "adKeywordStatus", "addToList",
  "attributedSalesSameSku14d", "attributedSalesSameSku1d", "attributedSalesSameSku30d",
  "attributedSalesSameSku7d", "campaignBudgetAmount", "campaignBudgetCurrencyCode",
  "campaignBudgetType", "campaignId", "campaignName", "campaignStatus", "clickThroughRate",
  "clicks", "cost", "costPerClick", "date", "impressions", "keyword", "keywordBid",
  "keywordId", "keywordType", "kindleEditionNormalizedPagesRead14d",
  "kindleEditionNormalizedPagesRoyalties14d", "matchType", "portfolioId", "purchases14d",
  "purchases1d", "purchases30d", "purchases7d", "purchasesSameSku14d", "purchasesSameSku1d",
  "purchasesSameSku30d", "purchasesSameSku7d", "qualifiedBorrows", "roasClicks14d",
  "roasClicks7d", "royaltyQualifiedBorrows", "sales14d", "sales1d", "sales30d", "sales7d",
  "salesOtherSku7d", "startDate", "targeting", "topOfSearchImpressionShare",
  "unitsSoldClicks14d", "unitsSoldClicks1d", "unitsSoldClicks30d", "unitsSoldClicks7d",
  "unitsSoldOtherSku7d", "unitsSoldSameSku14d", "unitsSoldSameSku1d", "unitsSoldSameSku30d",
  "unitsSoldSameSku7d",
  ],
  spSearchTerm: [
  "acosClicks14d", "acosClicks7d", "adGroupId", "adGroupName", "adKeywordStatus", "addToList",
  "attributedSalesSameSku14d", "attributedSalesSameSku1d", "attributedSalesSameSku30d",
  "attributedSalesSameSku7d", "campaignBudgetAmount", "campaignBudgetCurrencyCode",
  "campaignBudgetType", "campaignId", "campaignName", "campaignStatus", "clickThroughRate",
  "clicks", "cost", "costPerClick", "date", "impressions", "keyword", "keywordBid",
  "keywordId", "keywordType", "kindleEditionNormalizedPagesRead14d",
  "kindleEditionNormalizedPagesRoyalties14d", "matchType", "portfolioId", "purchases14d",
  "purchases1d", "purchases30d", "purchases7d", "purchasesSameSku14d", "purchasesSameSku1d",
  "purchasesSameSku30d", "purchasesSameSku7d", "qualifiedBorrows", "roasClicks14d",
  "roasClicks7d", "royaltyQualifiedBorrows", "sales14d", "sales1d", "sales30d", "sales7d",
  "salesOtherSku7d", "searchTerm", "startDate", "targeting", "unitsSoldClicks14d",
  "unitsSoldClicks1d", "unitsSoldClicks30d", "unitsSoldClicks7d", "unitsSoldOtherSku7d",
  "unitsSoldSameSku14d", "unitsSoldSameSku1d", "unitsSoldSameSku30d", "unitsSoldSameSku7d",
  ],
  spAdvertisedProduct: [
  "acosClicks14d", "acosClicks7d", "adGroupId", "adGroupName", "adId", "addToList",
  "advertisedAsin", "advertisedSku", "attributedSalesSameSku14d", "attributedSalesSameSku1d",
  "attributedSalesSameSku30d", "attributedSalesSameSku7d", "campaignBudgetAmount",
  "campaignBudgetCurrencyCode", "campaignBudgetType", "campaignId", "campaignName",
  "campaignStatus", "clickThroughRate", "clicks", "cost", "costPerClick", "date",
  "impressions", "kindleEditionNormalizedPagesRead14d",
  "kindleEditionNormalizedPagesRoyalties14d", "portfolioId", "purchases14d", "purchases1d",
  "purchases30d", "purchases7d", "purchasesSameSku14d", "purchasesSameSku1d",
  "purchasesSameSku30d", "purchasesSameSku7d", "qualifiedBorrows", "roasClicks14d",
  "roasClicks7d", "royaltyQualifiedBorrows", "sales14d", "sales1d", "sales30d", "sales7d",
  "salesOtherSku7d", "spend", "startDate", "unitsSoldClicks14d", "unitsSoldClicks1d",
  "unitsSoldClicks30d", "unitsSoldClicks7d", "unitsSoldOtherSku7d", "unitsSoldSameSku14d",
  "unitsSoldSameSku1d", "unitsSoldSameSku30d", "unitsSoldSameSku7d",
  ],
  spPurchasedProduct: [
  "adGroupId", "adGroupName", "addToList", "addToListFromClicks", "advertisedAsin",
  "advertisedSku", "campaignBudgetCurrencyCode", "campaignId", "campaignName", "date",
  "keyword", "keywordId", "keywordType", "kindleEditionNormalizedPagesRead14d",
  "kindleEditionNormalizedPagesRoyalties14d", "matchType", "portfolioId", "purchasedAsin",
  "purchases14d", "purchases1d", "purchases30d", "purchases7d", "purchasesOtherSku14d",
  "purchasesOtherSku1d", "purchasesOtherSku30d", "purchasesOtherSku7d", "qualifiedBorrows",
  "qualifiedBorrowsFromClicks", "royaltyQualifiedBorrows", "royaltyQualifiedBorrowsFromClicks",
  "sales14d", "sales1d", "sales30d", "sales7d", "salesOtherSku14d", "salesOtherSku1d",
  "salesOtherSku30d", "salesOtherSku7d", "startDate", "unitsSoldClicks14d",
  "unitsSoldClicks1d", "unitsSoldClicks30d", "unitsSoldClicks7d", "unitsSoldOtherSku14d",
  "unitsSoldOtherSku1d", "unitsSoldOtherSku30d", "unitsSoldOtherSku7d",
  ],
};

test("ads: groupBy của từng report type khớp tài liệu Amazon (spPurchasedProduct = asin)", () => {
  for (const kind of ADS_ALL_KINDS) {
    const spec = adsSpecOf(kind);
    const allowed = DOC_GROUP_BY[spec.reportTypeId];
    assert.ok(allowed, `thiếu bảng groupBy cho ${spec.reportTypeId}`);
    for (const g of spec.groupBy) {
      assert.ok(
        allowed.includes(g),
        `${spec.reportTypeId}: groupBy "${g}" không có trong tài liệu (hợp lệ: ${allowed.join(", ")})`,
      );
    }
    assert.ok(spec.groupBy.length > 0, `${spec.reportTypeId}: phải có groupBy`);
  }
  // Khoá riêng ca đã từng sai để không ai "sửa lại" thành giá trị cũ
  assert.deepEqual(adsSpecOf("purchased-products").groupBy, ["asin"]);
  assert.ok(
    !adsSpecOf("targeting").columns.includes("targetingExpression"),
    "spTargeting KHÔNG có cột targetingExpression — cột đúng là \"targeting\"",
  );
  assert.ok(adsSpecOf("targeting").columns.includes("targeting"));
});

test("ads: mọi cột của mọi report đều nằm trong danh sách tài liệu (không xin cột lạ)", () => {
  for (const kind of ADS_ALL_KINDS) {
    const spec = adsSpecOf(kind);
    const allowed = DOC_COLUMNS[spec.reportTypeId];
    assert.ok(allowed, `thiếu bảng cột cho ${spec.reportTypeId}`);
    for (const col of spec.columns) {
      assert.ok(
        allowed.includes(col),
        `${spec.reportTypeId}: cột "${col}" không có trong tài liệu Amazon → sẽ 400`,
      );
    }
  }
});
