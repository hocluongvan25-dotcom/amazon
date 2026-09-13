/**
 * Test Module 5 PHẦN 3 — CHIỀU GHI lên Amazon Ads (bid · ngân sách · negative).
 *
 * Tầng này ghi vào TÀI KHOẢN THẬT nên test phải khoá đúng những chỗ có thể gây
 * thiệt hại tiền:
 *   1. Payload gửi Amazon đúng hình dạng v3 (`budget:{budgetType,budget}`, PUT
 *      `/sp/campaigns` · PUT `/sp/keywords` · POST `/sp/negativeKeywords`) và
 *      luôn có header `Amazon-Advertising-API-Scope` (thiếu là 400/404).
 *   2. HTTP 200 mà Amazon trả `INVALID_ARGUMENT` = THẤT BẠI (không được ghi
 *      "đã áp dụng" chỉ vì request không ném lỗi).
 *   3. Mảng kết quả RỖNG = thất bại (không có bằng chứng Amazon đã ghi).
 *   4. Job chỉ claim dòng ĐÃ DUYỆT — dòng `pending_approval` (>30%/ngày) KHÔNG
 *      bao giờ được gửi lên Amazon trước khi trưởng phòng PPC duyệt (SOP-05 b4).
 *   5. Thất bại ⇒ KHÔNG cập nhật cục bộ (A1/A2 không được hiển thị số chưa từng có).
 *   6. 429/5xx ⇒ TRẢ LẠI hàng đợi (applying → approved), quá trần số lần thì failed.
 *   7. 401/403 ⇒ RE-AUTHORIZE (Module 0), trả yêu cầu về hàng đợi — không bắt
 *      người dùng duyệt lại và không thử lại 5 lần vô ích.
 *   8. Thiếu `ads_profile_id` ⇒ dừng, không đoán profile (ghi sai marketplace là sai tiền).
 *   9. `--dry-run` không claim, không gọi Amazon.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { MockDbAdapter } from "../../web/src/lib/worker/db/adapter.ts";
import { AdsApiRequestError, AdsClient, AdsLwaTokenManager, normalizeWriteResponse } from "../src/amazon/ads.ts";
import { runAdsApply, type AdsApplyShop } from "../src/jobs/ads-apply.job.ts";

const SHOP: AdsApplyShop = { id: "11111111-1111-1111-1111-111111111111", displayName: "VEXIM US" };

/** fetch giả: ghi lại request, trả phản hồi theo kịch bản. */
function fakeFetch(responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* giữ nguyên chuỗi (form-urlencoded của LWA) */
      }
    }
    if (!u.includes("/auth/o2/token")) calls.push({ url: u, method: String(init?.method ?? "GET"), headers, body });
    return responder(u, init ?? {});
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function makeClient(fetchFn: typeof fetch, maxRetries = 0) {
  const lwa = new AdsLwaTokenManager(
    { clientId: "cid", clientSecret: "sec", refreshToken: "rt" },
    fetchFn,
  );
  return new AdsClient({ host: "https://advertising-api.amazon.com", clientId: "cid", lwa, fetchFn, maxRetries, sleep: async () => {} });
}

/** LWA luôn trả token để test chỉ tập trung vào phần ghi. */
const lwaOk = (url: string) =>
  url.includes("/auth/o2/token")
    ? json({ access_token: "AT-1", expires_in: 3600 })
    : null;

/* ============================================================================
 * 1. Hình dạng payload v3
 * ==========================================================================*/

test("M5P3 client: ngân sách đi PUT /sp/campaigns dạng budget:{budgetType,budget}", async () => {
  const { fetchFn, calls } = fakeFetch((url) => lwaOk(url) ?? json([{ code: "SUCCESS", campaignId: "C-1" }]));
  const client = makeClient(fetchFn);

  const out = await client.updateCampaigns("P-1", [{ campaignId: "C-1", budget: 25.678 }]);

  assert.equal(out.ok, true);
  assert.equal(out.items[0].id, "C-1");
  const call = calls[0];
  assert.equal(call.method, "PUT");
  assert.equal(call.url, "https://advertising-api.amazon.com/sp/campaigns");
  assert.equal(call.headers["Amazon-Advertising-API-Scope"], "P-1");
  assert.equal(call.headers["Amazon-Advertising-API-ClientId"], "cid");
  assert.deepEqual(call.body, { campaigns: [{ campaignId: "C-1", budget: { budgetType: "DAILY", budget: 25.68 } }] });
});

test("M5P3 client: bid/state đi PUT /sp/keywords (state viết hoa)", async () => {
  const { fetchFn, calls } = fakeFetch((url) => lwaOk(url) ?? json([{ code: "SUCCESS", keywordId: "KW-9" }]));
  const client = makeClient(fetchFn);

  const out = await client.updateKeywords("P-1", [{ keywordId: "KW-9", bid: 1.005, state: "paused" }]);

  assert.equal(out.ok, true);
  assert.deepEqual(calls[0].body, { keywords: [{ keywordId: "KW-9", bid: 1.01, state: "PAUSED" }] });
});

test("M5P3 client: negative keyword đi POST /sp/negativeKeywords và lấy keywordId Amazon trả về", async () => {
  const { fetchFn, calls } = fakeFetch((url) =>
    lwaOk(url) ?? json([{ code: "SUCCESS", keywordId: "NEG-77" }]),
  );
  const client = makeClient(fetchFn);

  const out = await client.createNegativeKeywords("P-1", [
    { campaignId: "C-1", adGroupId: "AG-1", keywordText: "vali 20 inch size 20", matchType: "NEGATIVE_EXACT" },
  ]);

  assert.equal(out.ok, true);
  assert.equal(out.items[0].id, "NEG-77");
  assert.equal(calls[0].url, "https://advertising-api.amazon.com/sp/negativeKeywords");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, {
    negativeKeywords: [
      {
        campaignId: "C-1",
        adGroupId: "AG-1",
        keywordText: "vali 20 inch size 20",
        matchType: "NEGATIVE_EXACT",
        state: "ENABLED",
      },
    ],
  });
});

/* ============================================================================
 * 2. Đọc kết quả ghi: 200 chưa phải thành công
 * ==========================================================================*/

test("M5P3 client: HTTP 200 + INVALID_ARGUMENT = THẤT BẠI (không báo thành công sai)", async () => {
  const { fetchFn } = fakeFetch((url) =>
    lwaOk(url) ??
    json([
      { code: "SUCCESS", keywordId: "KW-1" },
      { code: "INVALID_ARGUMENT", description: "Bid vượt trần cho phép" },
    ]),
  );
  const client = makeClient(fetchFn);

  const out = await client.updateKeywords("P-1", [
    { keywordId: "KW-1", bid: 1.1 },
    { keywordId: "KW-2", bid: 99 },
  ]);

  assert.equal(out.ok, false);
  assert.equal(out.succeeded, 1);
  assert.equal(out.failed, 1);
  assert.equal(out.items[1].code, "INVALID_ARGUMENT");
  assert.match(out.items[1].description, /vượt trần/);
});

test("M5P3 client: mảng kết quả RỖNG ⇒ coi là thất bại (không có bằng chứng đã ghi)", async () => {
  const out = normalizeWriteResponse([], 2, ["keywordId"]);
  assert.equal(out.ok, false);
  assert.equal(out.failed, 2);
  assert.equal(out.items.length, 0);
});

test("M5P3 client: 429 được phân loại là giới hạn tốc độ (khác 401 phải re-authorize)", async () => {
  const throttled = fakeFetch((url) => lwaOk(url) ?? json({ code: "Throttling", message: "slow down" }, 429));
  const client = makeClient(throttled.fetchFn, 0);
  await assert.rejects(
    () => client.updateCampaigns("P-1", [{ campaignId: "C-1", budget: 10 }]),
    (e: unknown) => {
      assert.ok(e instanceof AdsApiRequestError);
      assert.equal(e.isThrottled, true);
      assert.equal(e.isAuthError, false);
      return true;
    },
  );

  const unauthorized = fakeFetch((url) => lwaOk(url) ?? json({ code: "UNAUTHORIZED", message: "token expired" }, 401));
  const client2 = makeClient(unauthorized.fetchFn, 0);
  await assert.rejects(
    () => client2.updateKeywords("P-1", [{ keywordId: "KW-1", bid: 1 }]),
    (e: unknown) => {
      assert.ok(e instanceof AdsApiRequestError);
      assert.equal(e.isAuthError, true);
      assert.equal(e.isThrottled, false);
      return true;
    },
  );
});

/* ============================================================================
 * 3. Job: chỉ ghi cái đã duyệt, thất bại thì không ghi cục bộ
 * ==========================================================================*/

function seedQueue(db: MockDbAdapter) {
  db.adsCampaigns.push({
    sellerAccountId: SHOP.id,
    campaignId: "C-1",
    campaignType: "sp",
    name: "Vali 20 inch",
    state: "ENABLED",
    dailyBudget: 100,
  } as never);
  db.adsTargets.push({
    sellerAccountId: SHOP.id,
    targetKey: "KW-1",
    targetKind: "keyword",
    campaignId: "C-1",
    adGroupId: "AG-1",
    keywordText: "vali 20 inch",
    bid: 1,
    state: "ENABLED",
  } as never);
}

const approved = (db: MockDbAdapter, extra: Partial<Parameters<MockDbAdapter["seedAdsChange"]>[0]> = {}) =>
  db.seedAdsChange({
    sellerAccountId: SHOP.id,
    entityType: "campaign",
    entityKey: "C-1",
    campaignId: "C-1",
    adGroupId: "",
    action: "set_budget",
    payload: {},
    beforeValue: { value: 100 },
    afterValue: { value: 120 },
    adsProfileId: "P-1",
    currency: "USD",
    entityLabel: "Vali 20 inch",
    suggestionId: null,
    attempts: 0,
    ...extra,
  });

test("M5P3 job: claim dòng đã duyệt → gọi Amazon → ghi applied + cập nhật cục bộ", async () => {
  const db = new MockDbAdapter();
  seedQueue(db);
  approved(db);
  const { fetchFn, calls } = fakeFetch((url) => lwaOk(url) ?? json([{ code: "SUCCESS", campaignId: "C-1" }]));

  const res = await runAdsApply({ db, shops: [SHOP], clientFor: () => makeClient(fetchFn) });

  assert.equal(res.applied, 1);
  assert.equal(res.failed, 0);
  assert.equal(calls.length, 1);
  assert.equal(db.adsCampaigns[0].dailyBudget, 120, "ngân sách cục bộ phải theo giá trị Amazon đã nhận");
  assert.equal(db.adsChanges[0].status, "applied");
  assert.equal(Number(db.adsChanges[0].attempts), 1);
});

test("M5P3 job: dòng chờ duyệt (>30%/ngày) KHÔNG bao giờ được gửi lên Amazon", async () => {
  const db = new MockDbAdapter();
  seedQueue(db);
  approved(db, { afterValue: { value: 300 }, status: "pending_approval" });
  const { fetchFn, calls } = fakeFetch((url) => lwaOk(url) ?? json([{ code: "SUCCESS" }]));

  const res = await runAdsApply({ db, shops: [SHOP], clientFor: () => makeClient(fetchFn) });

  assert.equal(res.claimed, 0);
  assert.equal(calls.length, 0, "không được có request nào khi chưa có người duyệt");
  assert.equal(db.adsCampaigns[0].dailyBudget, 100);
  assert.equal(db.adsChanges[0].status, "pending_approval");
});

test("M5P3 job: Amazon từ chối ⇒ failed, KHÔNG ghi cục bộ, có lý do để người xem đọc", async () => {
  const db = new MockDbAdapter();
  seedQueue(db);
  approved(db);
  const { fetchFn } = fakeFetch((url) =>
    lwaOk(url) ?? json([{ code: "INVALID_ARGUMENT", description: "Budget quá thấp so với chi tiêu 7 ngày" }]),
  );

  const res = await runAdsApply({ db, shops: [SHOP], clientFor: () => makeClient(fetchFn) });

  assert.equal(res.failed, 1);
  assert.equal(db.adsCampaigns[0].dailyBudget, 100, "thất bại thì KHÔNG được đổi ngân sách cục bộ");
  assert.equal(db.adsChanges[0].status, "failed");
  assert.match(String(db.adsChanges[0].error), /INVALID_ARGUMENT/);
  assert.match(res.results[0].changes[0].message, /Amazon TỪ CHỐI/);
});

test("M5P3 job: bid gửi lên bằng số, negative ghi vào gương + đóng gợi ý A3", async () => {
  const db = new MockDbAdapter();
  seedQueue(db);
  db.adsTargets.push({
    sellerAccountId: SHOP.id,
    targetKey: "KW-2",
    targetKind: "keyword",
    campaignId: "C-1",
    adGroupId: "AG-1",
    keywordText: "vali 24 inch",
    bid: 2,
    state: "ENABLED",
  } as never);
  approved(db, {
    entityType: "keyword",
    entityKey: "KW-1",
    action: "set_bid",
    beforeValue: { value: 1 },
    afterValue: { value: 1.4 },
  });
  db.adsSuggestions.push({
    sellerAccountId: SHOP.id,
    campaignId: "C-1",
    term: "vali 24 inch size 20",
    suggestionType: "negative_exact",
    status: "approved",
  } as never);
  const sug = db.seedAdsChange({
    sellerAccountId: SHOP.id,
    entityType: "search_term",
    entityKey: "vali 24 inch size 20",
    campaignId: "C-1",
    adGroupId: "AG-1",
    action: "add_negative_exact",
    payload: {},
    beforeValue: null,
    afterValue: { value: "vali 24 inch size 20" },
    adsProfileId: "P-1",
    currency: "USD",
    entityLabel: "vali 24 inch size 20",
    suggestionId: "sug-1",
    attempts: 0,
  });
  const { fetchFn, calls } = fakeFetch((url) =>
    lwaOk(url) ??
    json(url.endsWith("/sp/keywords") ? [{ code: "SUCCESS", keywordId: "KW-1" }] : [{ code: "SUCCESS", keywordId: "NEG-1" }]),
  );

  const res = await runAdsApply({ db, shops: [SHOP], clientFor: () => makeClient(fetchFn), limit: 5 });

  assert.equal(res.applied, 2);
  assert.equal(db.adsTargets.find((t) => t.targetKey === "KW-1")?.bid, 1.4);
  assert.equal(db.adsNegativeKeywords.length, 1);
  assert.equal(db.adsNegativeKeywords[0].keywordText, "vali 24 inch size 20");
  assert.equal(db.adsNegativeKeywords[0].matchType, "NEGATIVE_EXACT");
  assert.equal(db.adsNegativeKeywords[0].keywordId, "NEG-1");
  assert.equal(db.adsSuggestions[0].status, "applied", "duyệt xong và Amazon đã nhận ⇒ gợi ý A3 phải đóng");
  assert.equal(db.adsChanges.find((c) => c.changeId === sug.changeId)?.status, "applied");
  assert.ok(calls.some((c) => c.url.endsWith("/sp/keywords")));
  assert.ok(calls.some((c) => c.url.endsWith("/sp/negativeKeywords")));
});

/* ============================================================================
 * 4. Lỗi tạm thời vs lỗi quyền
 * ==========================================================================*/

test("M5P3 job: 429 ⇒ TRẢ LẠI hàng đợi (approved) và lần chạy sau ghi được", async () => {
  const db = new MockDbAdapter();
  seedQueue(db);
  approved(db);

  const throttled = fakeFetch((url) => lwaOk(url) ?? json({ code: "Throttling" }, 429));
  const first = await runAdsApply({ db, shops: [SHOP], clientFor: () => makeClient(throttled.fetchFn, 0) });

  assert.equal(first.released, 1);
  assert.equal(first.failed, 0);
  assert.equal(db.adsChanges[0].status, "approved", "429 không được đánh dấu thất bại");
  assert.equal(Number(db.adsChanges[0].attempts), 1);

  const ok = fakeFetch((url) => lwaOk(url) ?? json([{ code: "SUCCESS", campaignId: "C-1" }]));
  const second = await runAdsApply({ db, shops: [SHOP], clientFor: () => makeClient(ok.fetchFn) });

  assert.equal(second.applied, 1);
  assert.equal(Number(db.adsChanges[0].attempts), 2, "attempts cộng dồn để biết đã thử mấy lần");
});

test("M5P3 job: thử quá trần (maxAttempts) ⇒ chuyển thất bại thật để người xem xử lý", async () => {
  const db = new MockDbAdapter();
  seedQueue(db);
  approved(db, { attempts: 4 });
  const throttled = fakeFetch((url) => lwaOk(url) ?? json({ code: "Throttling" }, 429));

  const res = await runAdsApply({ db, shops: [SHOP], clientFor: () => makeClient(throttled.fetchFn, 0), maxAttempts: 5 });

  assert.equal(res.failed, 1);
  assert.equal(db.adsChanges[0].status, "failed");
  assert.match(String(db.adsChanges[0].error), /đã thử 5\/5 lần/);
});

test("M5P3 job: 401 ⇒ needsReauth, TRẢ yêu cầu về hàng đợi (không bắt duyệt lại)", async () => {
  const db = new MockDbAdapter();
  seedQueue(db);
  approved(db, { entityKey: "C-1" });
  db.adsCampaigns.push({
    sellerAccountId: SHOP.id,
    campaignId: "C-2",
    campaignType: "sp",
    name: "Auto",
    state: "ENABLED",
    dailyBudget: 50,
  } as never);
  approved(db, { entityKey: "C-2", campaignId: "C-2", afterValue: { value: 60 }, entityLabel: "Auto" });

  const unauthorized = fakeFetch((url) => lwaOk(url) ?? json({ code: "UNAUTHORIZED" }, 401));
  const res = await runAdsApply({ db, shops: [SHOP], clientFor: () => makeClient(unauthorized.fetchFn, 0) });

  assert.deepEqual(res.needsReauth, [SHOP.displayName]);
  assert.equal(res.results[0].needsReauth, true);
  assert.equal(res.released, 2, "cả 2 yêu cầu trả lại hàng đợi để chạy tiếp sau khi authorize lại");
  assert.ok(db.adsChanges.every((c) => c.status === "approved"));
  assert.equal(db.adsCampaigns[0].dailyBudget, 100);
  assert.equal(db.adsCampaigns[1].dailyBudget, 50);
  assert.match(String(db.adsChanges[0].apiResponse?.reason), /Module 0/);
});

test("M5P3 job: thiếu ads_profile_id ⇒ dừng yêu cầu đó, KHÔNG đoán profile", async () => {
  const db = new MockDbAdapter();
  seedQueue(db);
  approved(db, { adsProfileId: "" });
  const { fetchFn, calls } = fakeFetch((url) => lwaOk(url) ?? json([{ code: "SUCCESS" }]));

  const res = await runAdsApply({ db, shops: [SHOP], clientFor: () => makeClient(fetchFn) });

  assert.equal(res.failed, 1);
  assert.equal(calls.length, 0, "không được gọi Amazon khi chưa biết profile");
  assert.equal(db.adsChanges[0].status, "failed");
  assert.match(String(db.adsChanges[0].error), /worker:ads-sync/);
});

test("M5P3 job: dry-run không claim, không gọi Amazon", async () => {
  const db = new MockDbAdapter();
  seedQueue(db);
  approved(db);
  const { fetchFn, calls } = fakeFetch((url) => lwaOk(url) ?? json([{ code: "SUCCESS" }]));

  const res = await runAdsApply({ db, shops: [SHOP], clientFor: () => makeClient(fetchFn), dryRun: true });

  assert.equal(res.claimed, 0);
  assert.equal(calls.length, 0);
  assert.equal(db.adsChanges[0].status, "approved");
  assert.equal(db.adsCampaigns[0].dailyBudget, 100);
});

test("M5P3 job: chưa cấu hình credential Ads ⇒ skipped kèm hướng dẫn, không ghi gì", async () => {
  const db = new MockDbAdapter();
  seedQueue(db);
  approved(db);

  const res = await runAdsApply({ db, shops: [SHOP], clientFor: () => null });

  assert.equal(res.results[0].action, "skipped");
  assert.match(res.results[0].message, /AMAZON_ADS_CLIENT_ID/);
  assert.equal(db.adsChanges[0].status, "approved");
});
