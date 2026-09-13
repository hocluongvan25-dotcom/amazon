/**
 * Test Module 5 — Ads API tầng giao thức (config, lỗi, profile, Reporting v3, client).
 *
 * Đây là những thứ sai một cái là MẤT SỐ LIỆU hoặc CHẾT CRON:
 *   • sai host theo vùng → 401/403 mà không hiểu vì sao (profile EU gọi host NA);
 *   • chọn nhầm profileId → số liệu PPC của thị trường khác trộn vào shop;
 *   • hiểu sai trạng thái report (425 = trùng, không phải lỗi; PENDING ≠ FAILED)
 *     → hoặc xin report dồn, hoặc bỏ dữ liệu;
 *   • file report là GZIP_JSON → không giải nén là parse ra rác.
 */
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { test } from "node:test";

import {
  ADS_HOSTS,
  ADS_MEDIA,
  ADS_REPORT_KINDS,
  AdsApiError,
  AdsClient,
  buildReportRequest,
  clampWindowToRetention,
  classifyReportStatus,
  countryFromMarketplace,
  createReportWithColumnFallback,
  describeAdsFailure,
  decorateRows,
  downloadReportRows,
  adsHostForRegion,
  loadAdsConfig,
  normalizeCampaignPage,
  normalizeReportTicket,
  normalizeProfiles,
  parseBadColumns,
  parseReportBytes,
  parseReportText,
  pickProfile,
  reportSpec,
  reportWindow,
  toProfileRpcRows,
} from "../src/lib/ads/index.ts";

const FULL_ENV = {
  AMAZON_ADS_CLIENT_ID: "amzn1.application-oa2-client.ads",
  AMAZON_ADS_CLIENT_SECRET: "amzn1.oa2-cs.v1.ads",
  AMAZON_ADS_REFRESH_TOKEN: "Atzr|ads-refresh-demo",
  AMAZON_ADS_REGION: "NA",
  OAUTH_TOKEN_ENC_KEY: "a".repeat(64),
  NEXT_PUBLIC_SUPABASE_URL: "https://demo.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
};

/* ------------------------------------------------------------------ */
/* 1. Cấu hình + host theo vùng                                        */
/* ------------------------------------------------------------------ */
test("loadAdsConfig: host theo vùng, ready khi đủ credential + khoá + supabase", () => {
  const cfg = loadAdsConfig(FULL_ENV);
  assert.equal(cfg.region, "NA");
  assert.equal(cfg.host, "https://advertising-api.amazon.com");
  assert.equal(cfg.ready, true);
  assert.equal(cfg.envRefreshToken, "Atzr|ads-refresh-demo");
  assert.equal(cfg.attributionDays, 7);
  assert.equal(cfg.reportDays, 7);
  assert.equal(cfg.profileTypeHint, "seller");
  assert.equal(cfg.scope, "ads::campaign_management");

  assert.equal(loadAdsConfig({ ...FULL_ENV, AMAZON_ADS_REGION: "EU" }).host, ADS_HOSTS.EU);
  assert.equal(loadAdsConfig({ ...FULL_ENV, AMAZON_ADS_REGION: "FE" }).host, ADS_HOSTS.FE);
  assert.equal(
    loadAdsConfig({ ...FULL_ENV, AMAZON_ADS_BASE_URL: "https://custom.example/api/" }).host,
    "https://custom.example/api",
    "override phải bỏ slash thừa",
  );
  assert.equal(adsHostForRegion("EU"), "https://advertising-api-eu.amazon.com");
});

test("loadAdsConfig: thiếu credential/khoá → problems chỉ đúng việc phải làm; chưa ready", () => {
  const empty = loadAdsConfig({});
  assert.equal(empty.ready, false);
  assert.equal(empty.clientId, null);
  assert.ok(empty.problems.some((p) => p.includes("AMAZON_ADS_CLIENT_ID")));
  assert.ok(empty.problems.some((p) => p.includes("OAUTH_TOKEN_ENC_KEY")));
  assert.ok(empty.problems.some((p) => p.includes("SUPABASE_SERVICE_ROLE_KEY")));

  // Thiếu AMAZON_ADS_REFRESH_TOKEN KHÔNG làm bất ready: token có thể nằm trong DB theo shop.
  const noEnvToken = loadAdsConfig({ ...FULL_ENV, AMAZON_ADS_REFRESH_TOKEN: undefined });
  assert.equal(noEnvToken.ready, true);
  assert.ok(noEnvToken.problems.some((p) => p.includes("AMAZON_ADS_REFRESH_TOKEN")));
});

test("loadAdsConfig: vendor dùng attribution 14d; reportDays bị kẹp vào trần 31 ngày", () => {
  assert.equal(loadAdsConfig({ ...FULL_ENV, AMAZON_ADS_ATTRIBUTION_DAYS: "14" }).attributionDays, 14);
  assert.equal(loadAdsConfig({ ...FULL_ENV, AMAZON_ADS_ATTRIBUTION_DAYS: "30" }).attributionDays, 30);
  assert.equal(loadAdsConfig({ ...FULL_ENV, AMAZON_ADS_ATTRIBUTION_DAYS: "9" }).attributionDays, 7, "lạ → về 7");
  assert.equal(loadAdsConfig({ ...FULL_ENV, AMAZON_ADS_REPORT_DAYS: "90" }).reportDays, 31, "Amazon cho tối đa 31 ngày");
  assert.equal(loadAdsConfig({ ...FULL_ENV, AMAZON_ADS_REPORT_DAYS: "0" }).reportDays, 7);
});

/* ------------------------------------------------------------------ */
/* 2. Phân loại lỗi                                                    */
/* ------------------------------------------------------------------ */
test("429 → retryable kèm Retry-After (số giây và HTTP-date); hint nói KHÔNG retry dồn", () => {
  const f = describeAdsFailure(429, '{"code":"TOO_MANY_REQUESTS","message":"slow down"}', { retryAfterHeader: "30" });
  assert.equal(f.code, "throttled");
  assert.equal(f.retryable, true);
  assert.equal(f.retryAfterSec, 30);
  assert.match(f.hint!, /KHÔNG retry dồn/);

  const byDate = describeAdsFailure(429, "", {
    retryAfterHeader: new Date(Date.now() + 45_000).toUTCString(),
  });
  assert.ok(byDate.retryAfterSec! >= 40 && byDate.retryAfterSec! <= 46, `đọc HTTP-date: ${byDate.retryAfterSec}`);
});

test("425 = đã có report y hệt đang chạy → KHÔNG phải lỗi, giữ reportId cũ", () => {
  const f = describeAdsFailure(425, '{"message":"Too soon to make the additional request"}');
  assert.equal(f.code, "duplicate_report");
  assert.equal(f.retryable, false);
  assert.match(f.hint!, /poll tiếp/);
});

test("401/403 dịch ra việc phải làm (re-authorize / sai vùng)", () => {
  const un = describeAdsFailure(401, '{"code":"UNAUTHORIZED","message":"Invalid access token"}');
  assert.equal(un.code, "unauthorized");
  assert.match(un.hint!, /Re-authorize|re-authorize|QUÁ HẠN/);

  const fb = describeAdsFailure(403, '{"message":"Not authorized"}');
  assert.equal(fb.code, "forbidden");
  assert.match(fb.hint!, /SAI VÙNG|vùng/);
});

test("400 chê cột → code invalid_column + trích đúng tên cột để bỏ ra rồi xin lại", () => {
  const f = describeAdsFailure(400, "Invalid columns: campaignBudgetAmount, targetingExpression");
  assert.equal(f.code, "invalid_column");
  assert.deepEqual(f.badColumns.sort(), ["campaignBudgetAmount", "targetingExpression"]);

  const quoted = describeAdsFailure(400, "The column 'sales30d' is not supported for reportTypeId spCampaigns");
  assert.equal(quoted.code, "invalid_column");
  assert.ok(quoted.badColumns.includes("sales30d"));

  assert.deepEqual(parseBadColumns(null), []);
  assert.deepEqual(parseBadColumns("startDate must be before endDate"), [], "không có tên cột → mảng rỗng");
});

test("5xx retryable; body không phải JSON vẫn ra message đọc được", () => {
  assert.equal(describeAdsFailure(503, "upstream boom").retryable, true);
  assert.equal(describeAdsFailure(500, "").code, "server_error");
  const html = describeAdsFailure(400, "<html>Bad Request</html>");
  assert.equal(html.code, "invalid_request");
  assert.match(html.message, /Bad Request/);
});

/* ------------------------------------------------------------------ */
/* 3. Profile — chọn profileId cho đúng shop                           */
/* ------------------------------------------------------------------ */
const PROFILES_RAW = [
  {
    profileId: "111",
    countryCode: "US",
    currencyCode: "USD",
    timezone: "America/Los_Angeles",
    accountInfo: { id: "ENTITY_US", type: "seller", name: "VEXIM US", marketplaceStringId: "ATVPDKIKX0DER" },
    dailyBudget: { amount: 100, currencyCode: "USD" },
  },
  {
    profileId: "222",
    countryCode: "GB",
    currencyCode: "GBP",
    timezone: "Europe/London",
    accountInfo: { id: "ENTITY_UK", type: "seller", name: "VEXIM UK", marketplaceStringId: "A1F83G8C2ARO7P" },
    dailyBudget: { amount: 50, currencyCode: "GBP" },
  },
  {
    profileId: "333",
    countryCode: "US",
    currencyCode: "USD",
    accountInfo: { id: "VENDOR_US", type: "vendor", name: "VEXIM Vendor" },
  },
];

test("normalizeProfiles đọc cả nested (accountInfo/dailyBudget) lẫn phẳng, bỏ profile không id", () => {
  const list = normalizeProfiles(PROFILES_RAW);
  assert.equal(list.length, 3);
  assert.equal(list[0].accountId, "ENTITY_US");
  assert.equal(list[0].accountType, "seller");
  assert.equal(list[0].marketplaceId, "ATVPDKIKX0DER");
  assert.equal(list[0].dailyBudget, 100);
  assert.equal(list[0].currencyCode, "USD");
  assert.equal(list[2].dailyBudget, null);

  // {profiles:[…]} và mảng phẳng đều nhận; profile thiếu profileId bị loại
  assert.equal(normalizeProfiles({ profiles: PROFILES_RAW }).length, 3);
  assert.equal(normalizeProfiles([{ countryCode: "US" }, ...PROFILES_RAW]).length, 3);
  assert.equal(normalizeProfiles(null).length, 0);

  // bản phẳng (vài SDK trả phẳng accountId/currency/amount)
  const flat = normalizeProfiles([
    { profileId: "9", countryCode: "de", currency: "EUR", accountId: "A9", accountType: "SELLER", amount: "12.5" },
  ]);
  assert.equal(flat[0].countryCode, "DE");
  assert.equal(flat[0].currencyCode, "EUR");
  assert.equal(flat[0].accountType, "seller");
  assert.equal(flat[0].dailyBudget, 12.5);
});

test("pickProfile khớp theo marketplace của shop (ưu tiên cao nhất)", () => {
  const d = pickProfile(normalizeProfiles(PROFILES_RAW), { marketplaceId: "A1F83G8C2ARO7P" });
  assert.equal(d.profile?.profileId, "222");
  assert.match(d.reason, /marketplaceStringId/);
  assert.equal(d.warnings.length, 0);
});

test("pickProfile khớp theo quốc gia suy từ marketplace; vendor bị loại khi hint là seller", () => {
  const d = pickProfile(normalizeProfiles(PROFILES_RAW), { marketplaceId: "ATVPDKIKX0DER" });
  assert.equal(d.profile?.profileId, "111", "marketplaceStringId khớp trước, không rơi vào vendor US");

  const byCountry = pickProfile(normalizeProfiles(PROFILES_RAW), { countryCode: "GB" });
  assert.equal(byCountry.profile?.profileId, "222");

  assert.equal(countryFromMarketplace("ATVPDKIKX0DER"), "US");
  assert.equal(countryFromMarketplace("A1F83G8C2ARO7P"), "GB");
  assert.equal(countryFromMarketplace("KHONG_RO"), null);
});

test("nhiều profile cùng quốc gia → ưu tiên isDefault, kèm CẢNH BÁO (không im lặng chọn bừa)", () => {
  const dup = normalizeProfiles([
    { profileId: "A", countryCode: "US", accountInfo: { type: "seller" } },
    { profileId: "B", countryCode: "US", accountInfo: { type: "seller" }, isDefault: true },
  ]);
  const d = pickProfile(dup, { countryCode: "US" });
  assert.equal(d.profile?.profileId, "B");
  assert.equal(d.warnings.length, 1);
  assert.match(d.warnings[0], /2 profile/);
});

test("không khớp gì: 1 profile thì dùng kèm cảnh báo, nhiều profile thì DỪNG (không đoán)", () => {
  const only = normalizeProfiles([{ profileId: "Z", countryCode: "JP", accountInfo: { type: "seller" } }]);
  const d1 = pickProfile(only, { countryCode: "US" });
  assert.equal(d1.profile?.profileId, "Z");
  assert.match(d1.warnings[0], /chỉ có 1 profile/);

  const d2 = pickProfile(normalizeProfiles(PROFILES_RAW), { countryCode: "FR" });
  assert.equal(d2.profile, null);
  assert.match(d2.reason, /Không đoán/);
  assert.match(d2.reason, /AMAZON_ADS_PROFILE_ID|ads_account_id/);
});

test("profileId bị ép: không có trong danh sách thì DỪNG, không chọn cái gần giống", () => {
  const d = pickProfile(normalizeProfiles(PROFILES_RAW), { profileId: "999" });
  assert.equal(d.profile, null);
  assert.match(d.reason, /999 không nằm trong/);

  const ok = pickProfile(normalizeProfiles(PROFILES_RAW), { profileId: "333" });
  assert.equal(ok.profile?.profileId, "333", "ép thì dùng đúng cái đó kể cả vendor");
});

test("0 profile → lý do nói rõ có thể do SAI VÙNG (profile EU không hiện khi gọi host NA)", () => {
  const d = pickProfile([], {});
  assert.equal(d.profile, null);
  assert.match(d.reason, /0 profile/);
  assert.match(d.reason, /vùng/);
});

test("toProfileRpcRows giữ nguyên raw nested + chèn isDefault/source cho RPC 0020", () => {
  const rows = toProfileRpcRows(normalizeProfiles(PROFILES_RAW), { pickedProfileId: "222" });
  assert.equal(rows.length, 3);
  assert.equal(rows[1].isDefault, true);
  assert.equal(rows[0].isDefault, false);
  assert.equal(rows[0].source, "ads_api");
  assert.deepEqual((rows[0].accountInfo as Record<string, unknown>).type, "seller", "RPC đọc accountInfo nested");
});

/* ------------------------------------------------------------------ */
/* 4. Reporting v3 — spec, khoảng ngày, body, trạng thái               */
/* ------------------------------------------------------------------ */
test("reportSpec: đúng reportTypeId/groupBy, DAILY thì cột có `date`, seller dùng sales7d", () => {
  const c = reportSpec("campaigns");
  assert.equal(c.reportTypeId, "spCampaigns");
  assert.deepEqual(c.groupBy, ["campaign"]);
  assert.equal(c.groupByKey, "campaign");
  assert.equal(c.adProduct, "SPONSORED_PRODUCTS");
  assert.equal(c.timeUnit, "DAILY");
  assert.equal(c.retentionDays, 95);
  assert.ok(c.columns.includes("date"), "DAILY bắt buộc có cột date");
  assert.ok(c.columns.includes("sales7d") && c.columns.includes("purchases7d"));
  assert.ok(c.minimalColumns.every((x) => c.columns.includes(x)), "bộ tối thiểu phải là tập con");

  assert.equal(reportSpec("advertised").reportTypeId, "spAdvertisedProduct");
  assert.deepEqual(reportSpec("advertised").groupBy, ["asin"]);
  assert.equal(reportSpec("searchTerms").reportTypeId, "spSearchTerm");
  assert.equal(reportSpec("searchTerms").retentionDays, 65, "search term chỉ giữ 65 ngày");
  assert.equal(reportSpec("targeting").reportTypeId, "spTargeting");

  const v14 = reportSpec("campaigns", { attributionDays: 14 });
  assert.ok(v14.columns.includes("sales14d") && !v14.columns.includes("sales7d"), "vendor/author dùng 14d");

  assert.deepEqual([...ADS_REPORT_KINDS], ["campaigns", "advertised", "searchTerms", "targeting"]);
});

test("reportWindow kết thúc ở HÔM QUA (UTC) — dữ liệu hôm nay chưa chốt attribution", () => {
  const now = new Date("2026-09-13T09:00:00Z");
  const w = reportWindow({ days: 7, now });
  assert.equal(w.endDate, "2026-09-12");
  assert.equal(w.startDate, "2026-09-06");

  const one = reportWindow({ days: 1, now });
  assert.equal(one.startDate, "2026-09-12");
  assert.equal(one.endDate, "2026-09-12");

  const capped = reportWindow({ days: 999, now });
  const span = (Date.parse(capped.endDate) - Date.parse(capped.startDate)) / 86_400_000 + 1;
  assert.equal(span, 31, "không được vượt trần 31 ngày của Amazon");

  const custom = reportWindow({ days: 3, endDate: "2026-08-01", now });
  assert.deepEqual(custom, { startDate: "2026-07-30", endDate: "2026-08-01" });
});

test("clampWindowToRetention không xin quá retention (searchTerm 65 ngày)", () => {
  const now = new Date("2026-09-13T00:00:00Z");
  const spec = reportSpec("searchTerms");
  const clamped = clampWindowToRetention({ startDate: "2026-01-01", endDate: "2026-09-12" }, spec, now);
  assert.equal(clamped.endDate, "2026-09-12");
  assert.ok(clamped.startDate > "2026-07-01", `start phải nằm trong 65 ngày, nhận ${clamped.startDate}`);

  const untouched = clampWindowToRetention({ startDate: "2026-09-01", endDate: "2026-09-12" }, spec, now);
  assert.equal(untouched.startDate, "2026-09-01");
});

test("buildReportRequest đúng shape tài liệu v3 (name/startDate/endDate/configuration)", () => {
  const spec = reportSpec("campaigns");
  const body = buildReportRequest(spec, { startDate: "2026-09-01", endDate: "2026-09-07" });
  assert.equal(body.startDate, "2026-09-01");
  assert.equal(body.endDate, "2026-09-07");
  const cfg = body.configuration as Record<string, unknown>;
  assert.equal(cfg.adProduct, "SPONSORED_PRODUCTS");
  assert.equal(cfg.reportTypeId, "spCampaigns");
  assert.deepEqual(cfg.groupBy, ["campaign"]);
  assert.equal(cfg.timeUnit, "DAILY");
  assert.equal(cfg.format, "GZIP_JSON");
  assert.ok(Array.isArray(cfg.columns) && (cfg.columns as string[]).includes("date"));
  assert.equal(cfg.filters, undefined, "không gửi filters rỗng");
  assert.match(String(body.name), /^vexim_spCampaigns_/);

  const withFilter = buildReportRequest(spec, { startDate: "a", endDate: "b" }, {
    filters: [{ field: "campaignStatus", values: ["ENABLED"] }],
    columns: ["date", "cost"],
  });
  assert.deepEqual((withFilter.configuration as Record<string, unknown>).filters, [
    { field: "campaignStatus", values: ["ENABLED"] },
  ]);
  assert.deepEqual((withFilter.configuration as Record<string, unknown>).columns, ["date", "cost"]);
});

test("classifyReportStatus: PENDING/PROCESSING = chờ, COMPLETED = tải, FAILED/EXPIRED = chết", () => {
  assert.equal(classifyReportStatus("PENDING"), "pending");
  assert.equal(classifyReportStatus("processing"), "pending");
  assert.equal(classifyReportStatus("IN_QUEUE"), "pending");
  assert.equal(classifyReportStatus("COMPLETED"), "completed");
  assert.equal(classifyReportStatus("FAILED"), "failed");
  assert.equal(classifyReportStatus("CANCELLED"), "failed");
  assert.equal(classifyReportStatus("EXPIRED"), "failed");
  assert.equal(classifyReportStatus(null), "unknown");
  assert.equal(classifyReportStatus("GI_MA"), "unknown", "trạng thái lạ → unknown, không đoán là xong");
});

test("normalizeReportTicket đọc reportId/status/url/urlExpiresAt/rowCount/failureReason", () => {
  const t = normalizeReportTicket({
    reportId: "rpt-1",
    status: "completed",
    url: "https://s3.example/report.gz",
    urlExpiresAt: "2026-09-13T12:00:00Z",
    rowCount: "120",
    fileSize: null,
    failureReason: null,
    createdAt: "2026-09-13T04:00:00Z",
    updatedAt: "2026-09-13T04:05:00Z",
  });
  assert.equal(t.reportId, "rpt-1");
  assert.equal(t.status, "COMPLETED", "status phải uppercase để so sánh không phân biệt hoa thường");
  assert.equal(t.url, "https://s3.example/report.gz");
  assert.equal(t.rowCount, 120);
  assert.equal(t.fileSize, null);

  // Lúc mới tạo: PENDING, url null → biết ngay là chưa tải được
  const fresh = normalizeReportTicket({ reportId: "rpt-2", status: "PENDING", url: null });
  assert.equal(classifyReportStatus(fresh.status), "pending");
  assert.equal(fresh.url, null);
  assert.equal(fresh.reportId, "rpt-2");

  // Report hỏng: failureReason/statusDetails
  const broken = normalizeReportTicket({ reportId: "rpt-3", status: "FAILED", statusDetails: "no data" });
  assert.equal(broken.failureReason, "no data");
  assert.equal(normalizeReportTicket(null).reportId, null);
});

/* ------------------------------------------------------------------ */
/* 5. Đọc file report (GZIP_JSON)                                      */
/* ------------------------------------------------------------------ */
test("parseReportText nhận mảng JSON, NDJSON, {rows:[]}, object đơn lẻ; bỏ dòng rác", () => {
  assert.deepEqual(parseReportText('[{"date":"2026-09-01","cost":1.5},{"date":"2026-09-02","cost":2}]'), [
    { date: "2026-09-01", cost: 1.5 },
    { date: "2026-09-02", cost: 2 },
  ]);
  assert.deepEqual(parseReportText('{"date":"2026-09-01","cost":1.5}'), [{ date: "2026-09-01", cost: 1.5 }]);
  assert.deepEqual(parseReportText('{"rows":[{"a":1}]}'), [{ a: 1 }]);
  assert.deepEqual(
    parseReportText('{"date":"2026-09-01","cost":1}\n{"date":"2026-09-02","cost":2}\n'),
    [
      { date: "2026-09-01", cost: 1 },
      { date: "2026-09-02", cost: 2 },
    ],
    "NDJSON (mỗi dòng một object)",
  );
  assert.deepEqual(parseReportText(""), [], "file rỗng = 0 dòng, không phải lỗi");
  assert.deepEqual(parseReportText("   "), []);
  // NDJSON lẫn dòng rác: giữ dòng đọc được, bỏ dòng không parse (không ném)
  const mixed = parseReportText('{"a":1}\nRAC\n{"b":2}');
  assert.deepEqual(mixed, [{ a: 1 }, { b: 2 }]);
  // mảng JSON có phần tử không phải object → lọc bỏ
  assert.deepEqual(parseReportText('[{"a":1},3,null]'), [{ a: 1 }]);
});

test("parseReportBytes tự giải nén GZIP (kiểm magic byte, không tin header)", async () => {
  const rows = [
    { date: "2026-09-01", campaignId: "1", impressions: 100, clicks: 5, cost: 4.2, sales7d: 40, purchases7d: 2 },
    { date: "2026-09-02", campaignId: "1", impressions: 120, clicks: 6, cost: 5.1, sales7d: 51, purchases7d: 3 },
  ];
  const gz = gzipSync(Buffer.from(JSON.stringify(rows), "utf8"));
  const parsed = await parseReportBytes(new Uint8Array(gz));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].sales7d, 51);

  // Không nén cũng đọc được (vài endpoint trả JSON trơn)
  const plain = await parseReportBytes(new TextEncoder().encode(JSON.stringify(rows)));
  assert.equal(plain.length, 2);

  // BOM đầu file không làm hỏng parse
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('[{"a":1}]')]);
  assert.deepEqual(await parseReportBytes(bom), [{ a: 1 }]);
});

test("downloadReportRows tải từ url S3 (không cần header auth) và giải nén", async () => {
  const rows = [{ date: "2026-09-01", cost: 9.9 }];
  const gz = gzipSync(Buffer.from(JSON.stringify(rows), "utf8"));
  const calls: string[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    assert.equal((init?.headers as Record<string, string>)?.Authorization, undefined, "S3 url không cần Bearer");
    return new Response(gz, { status: 200 });
  }) as unknown as typeof fetch;

  const out = await downloadReportRows({ url: "https://s3.example/r.gz" }, { fetchFn: fakeFetch });
  assert.equal(out.via, "s3_url");
  assert.equal(out.rows.length, 1);
  assert.equal(out.bytes, gz.byteLength);
  assert.deepEqual(calls, ["https://s3.example/r.gz"]);
});

test("downloadReportRows: url hết hạn (403) → nói rõ phải poll lại để lấy url mới", async () => {
  const fakeFetch = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(
    () => downloadReportRows({ url: "https://s3.example/expired.gz" }, { fetchFn: fakeFetch }),
    (e: unknown) => e instanceof AdsApiError && /urlExpiresAt|url mới/.test(e.hint ?? ""),
  );
  await assert.rejects(
    () => downloadReportRows({}, {}),
    (e: unknown) => e instanceof AdsApiError && e.code === "bad_response",
  );
});

test("decorateRows chèn ngữ cảnh, KHÔNG đổi tên cột của Amazon", () => {
  const rows = decorateRows([{ date: "2026-09-01", cost: 1, searchTerm: "*" }], {
    profileId: "111",
    reportId: "rpt-1",
    currency: "USD",
  });
  assert.equal(rows[0].adsProfileId, "111");
  assert.equal(rows[0].reportId, "rpt-1");
  assert.equal(rows[0].currencyCode, "USD");
  assert.equal(rows[0].source, "ads_reporting_v3");
  // Giữ nguyên cột gốc: RPC 0020 chấp nhận cả alias v2/v3 nên không được đổi tên
  assert.equal(rows[0].cost, 1);
  assert.equal(rows[0].searchTerm, "*", "searchTerm '*' (không khớp keyword) phải GIỮ, không được bỏ");
  assert.equal(rows[0].date, "2026-09-01");
});

/* ------------------------------------------------------------------ */
/* 6. Xin report — tự bớt cột khi Amazon chê                           */
/* ------------------------------------------------------------------ */
type FakeClient = { request: (m: string, p: string, o?: { body?: unknown }) => Promise<unknown> };

function fakeClient(script: ((body: Record<string, unknown>, attempt: number) => unknown)[]): {
  client: unknown;
  bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  const client = {
    request: async (_m: string, _p: string, o?: { body?: unknown }) => {
      const body = (o?.body ?? {}) as Record<string, unknown>;
      bodies.push(body);
      const step = script[Math.min(bodies.length - 1, script.length - 1)];
      const out = step(body, bodies.length);
      if (out instanceof Error) throw out;
      return out;
    },
  };
  return { client, bodies };
}

function columnError(cols: string): AdsApiError {
  return new AdsApiError(describeAdsFailure(400, `Invalid columns: ${cols}`), { path: "/reporting/reports" });
}

test("createReportWithColumnFallback: Amazon chê cột nào → bỏ đúng cột đó rồi xin lại", async () => {
  const { client, bodies } = fakeClient([
    () => columnError("campaignBudgetAmount"),
    () => ({ reportId: "rpt-ok", status: "PENDING", url: null }),
  ]);
  const spec = reportSpec("campaigns");
  const out = await createReportWithColumnFallback(client as never, spec, {
    startDate: "2026-09-01",
    endDate: "2026-09-07",
  });
  assert.equal(out.ticket.reportId, "rpt-ok");
  assert.equal(out.attempts, 2);
  assert.ok(!out.usedColumns.includes("campaignBudgetAmount"), "cột bị chê phải bị bỏ");
  assert.ok(out.usedColumns.includes("cost") && out.usedColumns.includes("date"));
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /Amazon chê cột/);
  // body lần 2 phải có cột đã rút
  const cfg2 = bodies[1].configuration as Record<string, unknown>;
  assert.ok(!(cfg2.columns as string[]).includes("campaignBudgetAmount"));
});

test("createReportWithColumnFallback: lỗi không nêu tên cột → rơi về BỘ CỘT TỐI THIỂU", async () => {
  const { client, bodies } = fakeClient([
    () => new AdsApiError(describeAdsFailure(400, "Configuration is not valid"), { path: "/reporting/reports" }),
    () => ({ reportId: "rpt-min", status: "PENDING" }),
  ]);
  const spec = reportSpec("searchTerms");
  const out = await createReportWithColumnFallback(client as never, spec, {
    startDate: "2026-09-01",
    endDate: "2026-09-07",
  });
  assert.equal(out.ticket.reportId, "rpt-min");
  assert.deepEqual(out.usedColumns, spec.minimalColumns);
  assert.deepEqual((bodies[1].configuration as Record<string, unknown>).columns, spec.minimalColumns);
});

test("createReportWithColumnFallback: 429/425 ném lên NGAY, không thử lại bằng cột khác", async () => {
  const throttled = fakeClient([() => new AdsApiError(describeAdsFailure(429, "", { retryAfterHeader: "60" }))]);
  await assert.rejects(
    () =>
      createReportWithColumnFallback(throttled.client as never, reportSpec("campaigns"), {
        startDate: "2026-09-01",
        endDate: "2026-09-07",
      }),
    (e: unknown) => e instanceof AdsApiError && e.code === "throttled" && e.retryAfterSec === 60,
  );
  assert.equal(throttled.bodies.length, 1, "chỉ gọi 1 lần — retry dồn là nghẽn hàng đợi");

  const dup = fakeClient([() => new AdsApiError(describeAdsFailure(425, "too soon"))]);
  await assert.rejects(
    () =>
      createReportWithColumnFallback(dup.client as never, reportSpec("campaigns"), {
        startDate: "2026-09-01",
        endDate: "2026-09-07",
      }),
    (e: unknown) => e instanceof AdsApiError && e.code === "duplicate_report",
  );
  assert.equal(dup.bodies.length, 1);
});

test("createReportWithColumnFallback: 200 mà không có reportId → báo hỏng, không im lặng", async () => {
  const { client } = fakeClient([() => ({ status: "PENDING" })]);
  await assert.rejects(
    () =>
      createReportWithColumnFallback(client as never, reportSpec("campaigns"), {
        startDate: "2026-09-01",
        endDate: "2026-09-07",
      }),
    (e: unknown) => e instanceof AdsApiError && e.code === "bad_response",
  );
});

/* ------------------------------------------------------------------ */
/* 7. AdsClient — header + phân trang                                  */
/* ------------------------------------------------------------------ */
type Recorded = { url: string; init: RequestInit };

function recordingFetch(responder: (call: Recorded, n: number) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return responder(call, calls.length);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

test("AdsClient gửi đủ header: cả 2 tên ClientId, Bearer, Scope=profileId, AccountId khi có", async () => {
  const { fetchFn, calls } = recordingFetch(() => new Response("[]", { status: 200 }));
  const client = new AdsClient({
    host: "https://advertising-api.amazon.com/",
    clientId: "cid-ads",
    accountId: "acc-9",
    profileId: "111",
    getAccessToken: async () => "Atza|access",
    fetchFn,
  });
  await client.listProfiles();
  const h = calls[0].init.headers as Record<string, string>;
  assert.equal(h["Amazon-Ads-ClientId"], "cid-ads");
  assert.equal(h["Amazon-Advertising-API-ClientId"], "cid-ads", "gửi cả tên cũ vì tài liệu/SDK lẫn lộn");
  assert.equal(h.Authorization, "Bearer Atza|access");
  assert.equal(h["Amazon-Advertising-API-Scope"], "111");
  assert.equal(h["Amazon-Ads-AccountId"], "acc-9");
  assert.equal(calls[0].url, "https://advertising-api.amazon.com/v2/profiles", "host thừa slash phải được dọn");
  assert.equal(calls[0].init.method, "GET");
});

test("AdsClient: 429 → AdsApiError retryable + retryAfterSec + path/profile để truy vết", async () => {
  const { fetchFn } = recordingFetch(
    () => new Response('{"code":"TOO_MANY_REQUESTS"}', { status: 429, headers: { "Retry-After": "12" } }),
  );
  const client = new AdsClient({
    host: ADS_HOSTS.NA,
    clientId: "cid",
    profileId: "111",
    getAccessToken: async () => "tok",
    fetchFn,
  });
  await assert.rejects(
    () => client.listProfiles(),
    (e: unknown) => {
      const err = e as AdsApiError;
      return (
        err instanceof AdsApiError &&
        err.code === "throttled" &&
        err.retryable === true &&
        err.retryAfterSec === 12 &&
        err.path === "/v2/profiles" &&
        err.profileId === "111"
      );
    },
  );
});

test("AdsClient: lỗi mạng → retryable, không nhầm với lỗi cấu hình", async () => {
  const fetchFn = (async () => {
    throw new Error("ENOTFOUND");
  }) as unknown as typeof fetch;
  const client = new AdsClient({
    host: ADS_HOSTS.EU,
    clientId: "cid",
    getAccessToken: async () => "tok",
    fetchFn,
  });
  await assert.rejects(
    () => client.listProfiles(),
    (e: unknown) => e instanceof AdsApiError && e.code === "network" && e.retryable === true,
  );
});

test("AdsClient: body không phải JSON → bad_response kèm raw để biết đang nhận gì", async () => {
  const { fetchFn } = recordingFetch(() => new Response("<html>login</html>", { status: 200 }));
  const client = new AdsClient({ host: ADS_HOSTS.NA, clientId: "cid", getAccessToken: async () => "t", fetchFn });
  await assert.rejects(
    () => client.listProfiles(),
    (e: unknown) => e instanceof AdsApiError && e.code === "bad_response" && /html/.test(e.raw ?? ""),
  );
});

test("listSpCampaigns gửi đúng media type + phân trang nextToken, có chốt chặn maxPages", async () => {
  const { fetchFn, calls } = recordingFetch((_c, n) =>
    n === 1
      ? new Response(JSON.stringify({ campaigns: [{ campaignId: "1" }], nextToken: "tok-2" }), { status: 200 })
      : new Response(JSON.stringify({ campaigns: [{ campaignId: "2" }], totalCount: 2 }), { status: 200 }),
  );
  const client = new AdsClient({
    host: ADS_HOSTS.NA,
    clientId: "cid",
    profileId: "111",
    getAccessToken: async () => "tok",
    fetchFn,
  });
  const out = await client.listAllSpCampaigns({ maxPages: 5 });
  assert.equal(out.campaigns.length, 2);
  assert.equal(out.pages, 2);
  assert.equal(out.truncated, false);

  const h = calls[0].init.headers as Record<string, string>;
  assert.equal(h["Content-Type"], ADS_MEDIA.spCampaign);
  assert.equal(h.Accept, ADS_MEDIA.spCampaign);
  assert.equal(calls[0].url, "https://advertising-api.amazon.com/sp/campaigns/list");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { count: 100 });
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { count: 100, nextToken: "tok-2" });

  // nextToken còn mà hết trang cho phép → truncated=true (báo rõ, không im lặng thiếu dữ liệu)
  const always = recordingFetch(() =>
    new Response(JSON.stringify({ campaigns: [{ campaignId: "x" }], nextToken: "more" }), { status: 200 }),
  );
  const c2 = new AdsClient({
    host: ADS_HOSTS.NA,
    clientId: "cid",
    profileId: "1",
    getAccessToken: async () => "t",
    fetchFn: always.fetchFn,
  });
  const cut = await c2.listAllSpCampaigns({ maxPages: 3 });
  assert.equal(cut.pages, 3);
  assert.equal(cut.truncated, true);
});

test("normalizeCampaignPage nhận cả {campaigns:[…]} lẫn mảng trơn (bản cũ)", () => {
  assert.deepEqual(normalizeCampaignPage([{ campaignId: "1" }]), {
    campaigns: [{ campaignId: "1" }],
    nextToken: null,
    totalCount: 1,
  });
  assert.deepEqual(normalizeCampaignPage({ campaigns: [], nextToken: "" , totalCount: "7" }), {
    campaigns: [],
    nextToken: null,
    totalCount: 7,
  });
  assert.deepEqual(normalizeCampaignPage(null), { campaigns: [], nextToken: null, totalCount: null });
});
