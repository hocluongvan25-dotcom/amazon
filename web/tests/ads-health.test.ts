/**
 * Test Module 5 phần 1 — CHẨN ĐOÁN KẾT NỐI Amazon Ads (`/ppc`).
 *
 * Vì sao có test này: câu hỏi thật của chủ dự án 16/09/2026 là "module này đã
 * kết nối, hoạt động đúng chưa?" mà màn hình chỉ trả lời "Chưa có dữ liệu Amazon
 * Ads". Panel chẩn đoán phải nói được TẮC Ở ĐÂU theo đúng thứ tự 5 cổng:
 *
 *   credential Ads → shop có profile Ads → cấu trúc campaign → metrics → lỗi report
 *
 * Bốn luật được khoá ở đây:
 *   1. Thiếu credential ⇒ cổng 1 đỏ, các cổng sau ở trạng thái "chờ" (KHÔNG báo
 *      lỗi lung tung — người mới nhìn không biết bắt đầu từ đâu).
 *   2. Chỉ khi cổng trước mở thì cổng sau mới được KẾT LUẬN.
 *   3. Lỗi Amazon ở lần xin report gần nhất phải hiện NGUYÊN VĂN (đây là chỗ duy
 *      nhất lộ ra lỗi 400 "Invalid groupBy/column").
 *   4. Không bao giờ trả GIÁ TRỊ credential — chỉ true/false.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  a3EmptyReason,
  buildGates,
  readAdsCredentialsPresence,
  stuckGate,
  type AdsCounts,
} from "../src/lib/data/ads-health-model.ts";

const NO_COUNTS: AdsCounts = {
  profiles: null,
  campaigns: null,
  targets: null,
  searchTerms: null,
  metricRows: null,
  lastMetricDay: null,
};

function counts(patch: Partial<AdsCounts>): AdsCounts {
  return { ...NO_COUNTS, ...patch };
}

function find(gates: ReturnType<typeof buildGates>, key: string) {
  const g = gates.find((x) => x.key === key);
  assert.ok(g, `thiếu cổng ${key}`);
  return g;
}

/* ------------------------------------------------------------------ */
/* 1. Đọc env — chỉ CÓ/KHÔNG, không lộ giá trị                         */
/* ------------------------------------------------------------------ */

test("env: đủ 3 biến mới coi là kết nối được; tên biến dự phòng ADS_LWA_* vẫn nhận", () => {
  assert.equal(readAdsCredentialsPresence({}).complete, false);
  assert.equal(
    readAdsCredentialsPresence({
      AMAZON_ADS_CLIENT_ID: "amzn1.client",
      AMAZON_ADS_CLIENT_SECRET: "shhh",
      // thiếu refresh token ⇒ KHÔNG dùng được (loadConfig().ads === null)
    }).complete,
    false,
  );
  assert.equal(
    readAdsCredentialsPresence({
      AMAZON_ADS_CLIENT_ID: "a",
      AMAZON_ADS_CLIENT_SECRET: "b",
      AMAZON_ADS_REFRESH_TOKEN: "c",
    }).complete,
    true,
  );
  assert.equal(
    readAdsCredentialsPresence({ ADS_LWA_CLIENT_ID: "a", ADS_LWA_CLIENT_SECRET: "b", ADS_LWA_REFRESH_TOKEN: "c" })
      .complete,
    true,
  );
});

test("env: biến rỗng/khoảng trắng không tính là đã cấu hình; vùng mặc định NA và viết HOA", () => {
  const blank = readAdsCredentialsPresence({
    AMAZON_ADS_CLIENT_ID: "  ",
    AMAZON_ADS_CLIENT_SECRET: "",
    AMAZON_ADS_REFRESH_TOKEN: "\n",
  });
  assert.deepEqual(blank, { clientId: false, clientSecret: false, refreshToken: false, region: "NA", complete: false });
  assert.equal(readAdsCredentialsPresence({ AMAZON_ADS_REGION: "eu" }).region, "EU");
  assert.equal(
    readAdsCredentialsPresence({ AMAZON_SP_API_REGION: "fe" }).region,
    "FE",
    "không đặt vùng Ads riêng thì lấy vùng SP-API",
  );
});

test("env: KHÔNG trả giá trị credential ra ngoài (chống phơi token lên UI/log)", () => {
  const presence = readAdsCredentialsPresence({
    AMAZON_ADS_CLIENT_ID: "amzn1.application-oa2-client.SECRET_VALUE",
    AMAZON_ADS_CLIENT_SECRET: "SUPER-SECRET",
    AMAZON_ADS_REFRESH_TOKEN: "Atzr|SUPER-SECRET-REFRESH",
  });
  const dump = JSON.stringify(presence);
  assert.ok(!dump.includes("SUPER-SECRET"), "không được chứa giá trị secret");
  assert.ok(!dump.includes("SECRET_VALUE"), "không được chứa client id");
  assert.deepEqual(Object.keys(presence).sort(), ["clientId", "clientSecret", "complete", "refreshToken", "region"]);
});

/* ------------------------------------------------------------------ */
/* 2. Năm cổng — đúng thứ tự, đúng trạng thái                          */
/* ------------------------------------------------------------------ */

test("cổng: CHƯA có credential ⇒ cổng 1 đỏ, 4 cổng sau ở trạng thái chờ", () => {
  const gates = buildGates(readAdsCredentialsPresence({}), NO_COUNTS, []);
  assert.equal(gates.length, 5);
  assert.deepEqual(
    gates.map((g) => g.key),
    ["credentials", "shop_profile", "structure", "metrics", "last_report"],
  );
  const creds = find(gates, "credentials");
  assert.equal(creds.ok, false);
  assert.equal(creds.blocked, false, "cổng 1 luôn là cổng được đánh giá đầu tiên");
  assert.match(creds.detail, /AMAZON_ADS_CLIENT_ID/);
  assert.match(creds.detail, /AMAZON_ADS_CLIENT_SECRET/);
  assert.match(creds.detail, /AMAZON_ADS_REFRESH_TOKEN/);
  for (const key of ["shop_profile", "structure", "metrics", "last_report"]) {
    assert.equal(find(gates, key).blocked, true, `${key} phải ở trạng thái chờ`);
  }
  assert.equal(gates.find((g) => !g.ok && !g.blocked)?.key, "credentials");
});

test("cổng: có credential nhưng 0 profile Ads ⇒ cổng 2 đỏ, cổng 3–5 chờ", () => {
  const gates = buildGates(
    readAdsCredentialsPresence({
      AMAZON_ADS_CLIENT_ID: "a",
      AMAZON_ADS_CLIENT_SECRET: "b",
      AMAZON_ADS_REFRESH_TOKEN: "c",
    }),
    counts({ profiles: 0 }),
    [],
  );
  assert.equal(find(gates, "credentials").ok, true);
  const profile = find(gates, "shop_profile");
  assert.equal(profile.ok, false);
  assert.equal(profile.blocked, false);
  assert.match(profile.detail, /0 profile/);
  assert.equal(find(gates, "structure").blocked, true);
  assert.equal(find(gates, "metrics").blocked, true);
});

test("cổng: có profile + campaign nhưng metrics rỗng ⇒ cổng 4 đỏ và nói rõ report chưa về", () => {
  const gates = buildGates(
    readAdsCredentialsPresence({
      AMAZON_ADS_CLIENT_ID: "a",
      AMAZON_ADS_CLIENT_SECRET: "b",
      AMAZON_ADS_REFRESH_TOKEN: "c",
    }),
    counts({ profiles: 1, campaigns: 12, metricRows: 0, lastMetricDay: null }),
    [],
  );
  assert.equal(find(gates, "structure").ok, true);
  assert.match(find(gates, "structure").detail, /12 campaign/);
  const metrics = find(gates, "metrics");
  assert.equal(metrics.ok, false);
  assert.equal(metrics.blocked, false);
  assert.match(metrics.detail, /chưa có dòng metrics/);
  assert.equal(gates.find((g) => !g.ok && !g.blocked)?.key, "metrics");
});

test("cổng: đủ dữ liệu ⇒ cả 5 cổng xanh, không còn cổng nào tắc", () => {
  const gates = buildGates(
    readAdsCredentialsPresence({
      AMAZON_ADS_CLIENT_ID: "a",
      AMAZON_ADS_CLIENT_SECRET: "b",
      AMAZON_ADS_REFRESH_TOKEN: "c",
      AMAZON_ADS_REGION: "EU",
    }),
    counts({ profiles: 2, campaigns: 30, targets: 120, searchTerms: 40, metricRows: 900, lastMetricDay: "2026-09-15" }),
    [{ shop: "VEXIM US", report_type: "spCampaigns", status: "imported", rows_imported: 300, last_error: null, requested_at: "2026-09-16T03:00:00Z", age_minutes: 120, is_stale: false }],
  );
  assert.deepEqual(gates.map((g) => g.ok), [true, true, true, true, true]);
  assert.equal(gates.find((g) => !g.ok && !g.blocked), undefined);
  assert.match(find(gates, "credentials").detail, /EU/);
  assert.match(find(gates, "metrics").detail, /2026-09-15/);
  assert.match(find(gates, "metrics").detail, /120 từ khoá/);
});

/* ------------------------------------------------------------------ */
/* 3. Lỗi Amazon phải hiện nguyên văn (chỗ duy nhất lộ 400 groupBy/cột) */
/* ------------------------------------------------------------------ */

test("cổng: report lỗi ⇒ cổng 5 đỏ, hiện NGUYÊN VĂN lỗi Amazon và cách xử lý theo mã lỗi", () => {
  const gates = buildGates(
    readAdsCredentialsPresence({
      AMAZON_ADS_CLIENT_ID: "a",
      AMAZON_ADS_CLIENT_SECRET: "b",
      AMAZON_ADS_REFRESH_TOKEN: "c",
    }),
    counts({ profiles: 1, campaigns: 3, metricRows: 10, lastMetricDay: "2026-09-15" }),
    [
      {
        shop: "VEXIM US",
        report_type: "spPurchasedProduct",
        status: "failed",
        rows_imported: null,
        last_error: 'HTTP 400 {"code":"400","details":"groupBy value purchasedAsin is invalid"}',
        requested_at: "2026-09-16T03:00:00Z",
        age_minutes: 30,
        is_stale: false,
      },
      {
        shop: "VEXIM US",
        report_type: "spCampaigns",
        status: "imported",
        rows_imported: 120,
        last_error: null,
        requested_at: "2026-09-16T03:00:05Z",
        age_minutes: 30,
        is_stale: false,
      },
    ],
  );
  const last = find(gates, "last_report");
  assert.equal(last.ok, false);
  assert.equal(last.blocked, false);
  assert.match(last.detail, /groupBy value purchasedAsin is invalid/, "lỗi Amazon phải hiện nguyên văn");
  assert.match(last.fix, /400/);
  assert.match(last.fix, /ads-engine\.test\.ts/, "trỏ đúng test khoá hợp đồng API");
  assert.match(last.fix, /401|invalid_grant/, "phân biệt lỗi token để người dùng re-authorize đúng chỗ");
});

test("cổng: report chỉ đang chờ Amazon (pending) KHÔNG bị coi là lỗi", () => {
  const gates = buildGates(
    readAdsCredentialsPresence({ AMAZON_ADS_CLIENT_ID: "a", AMAZON_ADS_CLIENT_SECRET: "b", AMAZON_ADS_REFRESH_TOKEN: "c" }),
    counts({ profiles: 1, campaigns: 1, metricRows: 5, lastMetricDay: "2026-09-15" }),
    [{ shop: "VEXIM US", report_type: "spCampaigns", status: "in_progress", rows_imported: null, last_error: null, requested_at: "2026-09-16T03:00:00Z", age_minutes: 2, is_stale: false }],
  );
  assert.equal(find(gates, "last_report").ok, true);
});

/* ==========================================================================
 * 16/09/2026 — màn con A3 KHÔNG được lặp lại panel 5 cổng của `/ppc`
 * --------------------------------------------------------------------------
 * Chủ dự án mở https://veximops.com/ppc và .../ppc/search-terms rồi hỏi "hai trang
 * này giống hệt nhau à?" — đúng, vì cả hai đều đổ nguyên panel chẩn đoán 5 cổng khi
 * chưa có dữ liệu. Từ nay màn con chỉ nói: tắc ở CỔNG NÀO + vì sao RIÊNG nó trống.
 * ========================================================================== */

test("A3: stuckGate lấy đúng cổng đang chặn; không cổng nào chặn thì trả null", () => {
  const credsOk = readAdsCredentialsPresence({
    AMAZON_ADS_CLIENT_ID: "a",
    AMAZON_ADS_CLIENT_SECRET: "b",
    AMAZON_ADS_REFRESH_TOKEN: "c",
  });
  // Chưa có credential ⇒ cổng 1 là cổng chặn (các cổng sau chỉ "chờ").
  const credsMissing = readAdsCredentialsPresence({});
  const g1 = buildGates(credsMissing, NO_COUNTS, []);
  const stuck1 = stuckGate({ firstBlocked: g1.find((g) => !g.ok && !g.blocked) ?? null, gates: g1 });
  assert.equal(stuck1?.key, "credentials");
  assert.match(stuck1?.fix ?? "", /AMAZON_ADS_CLIENT_ID/);

  // Đủ credential + đã có metrics + không lỗi report ⇒ không cổng nào chặn.
  const g2 = buildGates(
    credsOk,
    counts({ profiles: 1, campaigns: 2, targets: 5, searchTerms: 9, metricRows: 30, lastMetricDay: "2026-09-15" }),
    [],
  );
  assert.equal(stuckGate({ firstBlocked: g2.find((g) => !g.ok && !g.blocked) ?? null, gates: g2 }), null);
  // Không truyền firstBlocked thì tự quét (không phụ thuộc thứ tự gọi).
  assert.equal(stuckGate({ firstBlocked: null, gates: g2 }), null);
});

test("A3: a3EmptyReason phân biệt 4 ca trống — mỗi ca một việc cần làm khác nhau", () => {
  // (a) chưa cấu hình Ads
  assert.match(a3EmptyReason(NO_COUNTS, { credentialsOk: false }), /chưa được cấu hình/);
  // (b) đọc DB lỗi
  assert.match(a3EmptyReason(NO_COUNTS, { credentialsOk: true, hasReadError: true }), /Không đọc được số liệu/);
  // (c) có profile nhưng 0 campaign ⇒ đồng bộ cấu trúc chưa tới / sai marketplace
  assert.match(a3EmptyReason(counts({ profiles: 2, campaigns: 0 }), { credentialsOk: true }), /0 campaign/);
  // (d) có campaign nhưng chưa có keyword/target ⇒ chưa thể có search term
  assert.match(
    a3EmptyReason(counts({ profiles: 1, campaigns: 3, targets: 0 }), { credentialsOk: true }),
    /CHƯA có keyword\/target/,
  );
  // (e) ĐÃ có keyword/target nhưng 0 dòng search term ⇒ report spSearchTerm chưa về (bất đồng bộ)
  const reason = a3EmptyReason(counts({ profiles: 1, campaigns: 3, targets: 12, searchTerms: 0 }), {
    credentialsOk: true,
  });
  assert.match(reason, /spSearchTerm/);
  assert.match(reason, /PENDING/, "phải nói report v3 bất đồng bộ để người dùng chờ rồi chạy lại thay vì đi sửa code");
});
