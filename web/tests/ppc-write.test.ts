/**
 * Test Module 5 PHẦN 2&3 — chiều GHI lên Amazon Ads (Sponsored Products v3).
 *
 * Đây là phần nguy hiểm nhất của cả hệ thống: mỗi dòng sai là TIỀN THẬT của chủ shop
 * bị đổi trên tài khoản quảng cáo. Vì vậy test tập trung vào các chốt an toàn:
 *
 *   • Bảng operation (method/path/media type/tên khoá body) đóng băng đúng hợp đồng
 *     SP v3 đã đối chiếu — sai một chữ Amazon trả 400 cho CẢ LÔ.
 *   • Payload: budget là OBJECT lồng {budget, budgetType}, state viết HOA, matchType
 *     là NEGATIVE_EXACT/NEGATIVE_PHRASE (không phải negativeExact của v2).
 *   • Phản hồi 207 Multi-Status: tách success/error THEO INDEX; dòng không có kết
 *     quả thì coi là FAILED (không được đoán là thành công).
 *   • Verify-before-write: Amazon đang khác before_value → SKIP, không ghi đè.
 *   • 429/5xx/mạng → giữ "applying" cho lượt sau đòi lại, KHÔNG đánh dấu failed.
 *   • ADS_WRITE_ENABLED tắt → không gọi Amazon và KHÔNG giành lô.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { encryptToken } from "../src/lib/oauth/crypto.ts";
import {
  ADS_APPLY_CRON,
  ADS_MEDIA,
  AdsClient,
  ADS_WRITE_BATCH_SIZE,
  ADS_WRITE_OPS,
  VERIFY_TOLERANCE,
  buildWriteItem,
  createAdsDb,
  chunk,
  emptySnapshot,
  groupByOp,
  isSponsoredProducts,
  matchResults,
  negativeKey,
  opForRequest,
  parseMultiStatus,
  readSnapshot,
  roundBid,
  runAdsApply,
  toWireMatchType,
  verifyRequest,
  type AmazonSnapshot,
  type PpcChangeRequest,
  type WriteOp,
} from "../src/lib/ads/index.ts";

const SHOP = "aaaaaaaa-1111-4111-8111-111111111111";

/** Một đề xuất đầy đủ cột (RPC vexim_worker_ppc_pending_changes trả về). */
function req(over: Partial<PpcChangeRequest> = {}): PpcChangeRequest {
  return {
    requestId: "11111111-1111-4111-8111-111111111111",
    sellerAccountId: SHOP,
    shop: "A1 · US",
    adsProfileId: "111",
    entityType: "keyword",
    changeType: "bid",
    amazonEntityId: "KW1",
    campaignId: "C1",
    adGroupId: "AG1",
    label: "mat ong hoa nhan",
    matchType: null,
    currency: "USD",
    beforeValue: { bid: 1.2 },
    afterValue: { bid: 1.02 },
    deltaPct: -15,
    attempts: 1,
    batchId: "22222222-2222-4222-8222-222222222222",
    campaignType: "SP",
    campaignName: "SP main",
    campaignState: "ENABLED",
    campaignDailyBudget: 25,
    status: "applying",
    lastError: null,
    proposedAt: "2026-09-13T01:00:00Z",
    decidedAt: "2026-09-13T02:00:00Z",
    expiresAt: "2026-09-16T01:00:00Z",
    claimedAt: "2026-09-13T04:20:00Z",
    ...over,
  };
}

/* ================================================================== */
/* 1. Bảng operation SP v3 — hợp đồng đóng băng                        */
/* ================================================================== */

test("ADS_WRITE_OPS: đúng method/path/media type/tên khoá của SP v3", () => {
  const expected: Record<string, [string, string, string, string, string, string]> = {
    updateCampaigns: ["PUT", "/sp/campaigns", "campaigns", "campaigns", "campaignId", ADS_MEDIA.spCampaign],
    updateKeywords: ["PUT", "/sp/keywords", "keywords", "keywords", "keywordId", ADS_MEDIA.spKeyword],
    updateAdGroups: ["PUT", "/sp/adGroups", "adGroups", "adGroups", "adGroupId", ADS_MEDIA.spAdGroup],
    createNegativeKeywords: [
      "POST",
      "/sp/negativeKeywords",
      "negativeKeywords",
      "negativeKeywords",
      "negativeKeywordId",
      ADS_MEDIA.spNegativeKeyword,
    ],
    createCampaignNegativeKeywords: [
      "POST",
      "/sp/campaignNegativeKeywords",
      "campaignNegativeKeywords",
      "campaignNegativeKeywords",
      "campaignNegativeKeywordId",
      ADS_MEDIA.spCampaignNegativeKeyword,
    ],
  };
  assert.deepEqual(Object.keys(ADS_WRITE_OPS).sort(), Object.keys(expected).sort(), "đúng 5 operation, không tự mở thêm");
  for (const [key, [method, path, bodyKey, resultKey, idField, media]] of Object.entries(expected)) {
    const op = ADS_WRITE_OPS[key as keyof typeof ADS_WRITE_OPS] as WriteOp;
    assert.equal(op.method, method, `${key}: method`);
    assert.equal(op.path, path, `${key}: path`);
    assert.equal(op.bodyKey, bodyKey, `${key}: khoá bọc mảng trong body`);
    assert.equal(op.resultKey, resultKey, `${key}: khoá chứa {success,error} trong 207`);
    assert.equal(op.idField, idField, `${key}: trường id Amazon`);
    assert.equal(op.media, media, `${key}: media type`);
    assert.match(op.media, /^application\/vnd\.sp.+\.v3\+json$/, "media type phải là bản v3");
  }
});

test("chiều ghi KHÔNG mở cho target/SB/SD (chưa xác minh được hợp đồng thì không đoán)", () => {
  const paths = Object.values(ADS_WRITE_OPS).map((o) => o.path);
  assert.equal(paths.some((p) => p.includes("/sp/targets")), false, "không PUT /sp/targets");
  assert.equal(paths.some((p) => p.startsWith("/sb") || p.startsWith("/sd")), false, "không đụng SB/SD");
});

test("opForRequest: ánh xạ entity × change → operation, cặp lạ trả null", () => {
  assert.equal(opForRequest(req({ entityType: "campaign", changeType: "budget" }))?.key, "updateCampaigns");
  assert.equal(opForRequest(req({ entityType: "campaign", changeType: "state" }))?.key, "updateCampaigns");
  assert.equal(opForRequest(req({ entityType: "campaign", changeType: "name" }))?.key, "updateCampaigns");
  assert.equal(opForRequest(req({ entityType: "keyword", changeType: "bid" }))?.key, "updateKeywords");
  assert.equal(opForRequest(req({ entityType: "keyword", changeType: "state" }))?.key, "updateKeywords");
  assert.equal(opForRequest(req({ entityType: "ad_group", changeType: "state" }))?.key, "updateAdGroups");
  assert.equal(opForRequest(req({ entityType: "negative_keyword", changeType: "create" }))?.key, "createNegativeKeywords");
  assert.equal(
    opForRequest(req({ entityType: "campaign_negative_keyword", changeType: "create" }))?.key,
    "createCampaignNegativeKeywords",
  );
  // KHÔNG đoán endpoint cho cặp chưa hỗ trợ
  assert.equal(opForRequest(req({ entityType: "campaign", changeType: "bid" })), null);
  assert.equal(opForRequest(req({ entityType: "keyword", changeType: "budget" })), null);
  assert.equal(opForRequest(req({ entityType: "negative_keyword", changeType: "state" })), null);
  assert.equal(opForRequest(req({ entityType: "ad_group", changeType: "bid" })), null);
});

test("isSponsoredProducts: chỉ SP (rỗng = chưa rõ thì cho qua, RPC đã skip non-SP trước đó)", () => {
  assert.equal(isSponsoredProducts("SP"), true);
  assert.equal(isSponsoredProducts("sponsoredProducts"), true);
  assert.equal(isSponsoredProducts(""), true);
  assert.equal(isSponsoredProducts(null), true);
  assert.equal(isSponsoredProducts("SB"), false);
  assert.equal(isSponsoredProducts("sd"), false);
});

/* ================================================================== */
/* 2. Payload gửi Amazon                                              */
/* ================================================================== */

test("buildWriteItem: budget campaign là OBJECT lồng {budget, budgetType} (SP v3)", () => {
  const { item, reason } = buildWriteItem(
    req({ entityType: "campaign", changeType: "budget", amazonEntityId: "C1", afterValue: { budget: 30 }, beforeValue: { budget: 25, budget_type: "DAILY" } }),
  );
  assert.equal(reason, null);
  assert.deepEqual(item, { campaignId: "C1", budget: { budget: 30, budgetType: "DAILY" } });
});

test("buildWriteItem: budget làm tròn 2 chữ số, thiếu budgetType thì mặc định DAILY", () => {
  const { item } = buildWriteItem(
    req({ entityType: "campaign", changeType: "budget", amazonEntityId: "C1", afterValue: { budget: 30.005 }, beforeValue: null }),
  );
  assert.deepEqual(item, { campaignId: "C1", budget: { budget: 30.01, budgetType: "DAILY" } });
});

test("buildWriteItem: budget ≤ 0 / không phải số → null kèm lý do (không gửi bậy)", () => {
  for (const bad of [0, -5, "abc", null]) {
    const out = buildWriteItem(req({ entityType: "campaign", changeType: "budget", amazonEntityId: "C1", afterValue: { budget: bad } }));
    assert.equal(out.item, null, `budget=${String(bad)} phải bị chặn`);
    assert.match(out.reason ?? "", /số dương/);
  }
});

test("buildWriteItem: state campaign/keyword/adGroup viết HOA; state lạ → null", () => {
  assert.deepEqual(
    buildWriteItem(req({ entityType: "campaign", changeType: "state", amazonEntityId: "C1", afterValue: { state: "paused" } })).item,
    { campaignId: "C1", state: "PAUSED" },
  );
  assert.deepEqual(
    buildWriteItem(req({ entityType: "keyword", changeType: "state", amazonEntityId: "KW1", afterValue: { state: "Enabled" } })).item,
    { keywordId: "KW1", state: "ENABLED" },
  );
  assert.deepEqual(
    buildWriteItem(req({ entityType: "ad_group", changeType: "state", amazonEntityId: "AG1", afterValue: { state: "PAUSED" } })).item,
    { adGroupId: "AG1", state: "PAUSED" },
  );
  const bad = buildWriteItem(req({ entityType: "campaign", changeType: "state", amazonEntityId: "C1", afterValue: { state: "STOPPED" } }));
  assert.equal(bad.item, null);
  assert.match(bad.reason ?? "", /không hợp lệ/);
});

test("buildWriteItem: bid keyword làm tròn 2 chữ số, thiếu id thì chặn", () => {
  assert.deepEqual(buildWriteItem(req({ afterValue: { bid: 1.005 } })).item, { keywordId: "KW1", bid: 1.01 });
  assert.equal(roundBid(1.0049), 1);
  assert.equal(roundBid(0.07), 0.07);
  const noId = buildWriteItem(req({ amazonEntityId: "" }));
  assert.equal(noId.item, null);
  assert.match(noId.reason ?? "", /thiếu keywordId/);
});

test("buildWriteItem: negative keyword cấp ad group có adGroupId, cấp campaign thì không", () => {
  const adGroupLevel = buildWriteItem(
    req({
      entityType: "negative_keyword",
      changeType: "create",
      amazonEntityId: "",
      campaignId: "C1",
      adGroupId: "AG1",
      label: "free sample",
      matchType: "NEGATIVE_EXACT",
      afterValue: {},
    }),
  );
  assert.deepEqual(adGroupLevel.item, {
    campaignId: "C1",
    adGroupId: "AG1",
    keywordText: "free sample",
    matchType: "NEGATIVE_EXACT",
    state: "ENABLED",
  });

  const campaignLevel = buildWriteItem(
    req({
      entityType: "campaign_negative_keyword",
      changeType: "create",
      amazonEntityId: "",
      campaignId: "C1",
      adGroupId: "AG1",
      label: "cheap",
      matchType: "NEGATIVE_PHRASE",
      afterValue: { keyword_text: "cheap" },
    }),
  );
  assert.deepEqual(campaignLevel.item, {
    campaignId: "C1",
    keywordText: "cheap",
    matchType: "NEGATIVE_PHRASE",
    state: "ENABLED",
  });
  assert.equal("adGroupId" in (campaignLevel.item ?? {}), false, "phủ định cấp campaign không được kèm adGroupId");
});

test("buildWriteItem: negative keyword thiếu campaignId/adGroupId/text → chặn kèm lý do", () => {
  const base = { entityType: "negative_keyword" as const, changeType: "create" as const, amazonEntityId: "" };
  assert.match(buildWriteItem(req({ ...base, label: "", afterValue: {} })).reason ?? "", /thiếu keywordText/);
  assert.match(buildWriteItem(req({ ...base, campaignId: "", label: "x", afterValue: {} })).reason ?? "", /thiếu campaignId/);
  assert.match(buildWriteItem(req({ ...base, adGroupId: "", label: "x", afterValue: {} })).reason ?? "", /cần adGroupId/);
});

test("toWireMatchType: kiểu v2 (negativeExact) → v3 (NEGATIVE_EXACT); lạ → null", () => {
  assert.equal(toWireMatchType("negativeExact"), "NEGATIVE_EXACT");
  assert.equal(toWireMatchType("NEGATIVE EXACT"), "NEGATIVE_EXACT");
  assert.equal(toWireMatchType("phrase"), "NEGATIVE_PHRASE");
  assert.equal(toWireMatchType(""), "NEGATIVE_EXACT");
  assert.equal(toWireMatchType(null), "NEGATIVE_EXACT");
  assert.equal(toWireMatchType("negativeBroad"), null);
  // buildWriteItem dùng chính hàm này → dữ liệu cũ vẫn gửi được, dữ liệu lạ bị chặn
  const ok = buildWriteItem(
    req({ entityType: "negative_keyword", changeType: "create", amazonEntityId: "", label: "x", matchType: "negativePhrase", afterValue: {} }),
  );
  assert.equal((ok.item ?? {}).matchType, "NEGATIVE_PHRASE");
  const bad = buildWriteItem(
    req({ entityType: "negative_keyword", changeType: "create", amazonEntityId: "", label: "x", matchType: "negativeBroad", afterValue: {} }),
  );
  assert.equal(bad.item, null);
  assert.match(bad.reason ?? "", /SP v3/);
});

test("groupByOp + chunk: gom theo operation, mỗi lô ≤ ADS_WRITE_BATCH_SIZE", () => {
  assert.equal(ADS_WRITE_BATCH_SIZE, 100, "Amazon giới hạn 100 phần tử mỗi lần ghi");
  const list = [
    req({ requestId: "r1", entityType: "keyword", changeType: "bid", amazonEntityId: "K1" }),
    req({ requestId: "r2", entityType: "campaign", changeType: "budget", amazonEntityId: "C1" }),
    req({ requestId: "r3", entityType: "keyword", changeType: "state", amazonEntityId: "K2" }),
  ];
  const grouped = groupByOp(list);
  assert.equal(grouped.get("updateKeywords")?.length, 2);
  assert.equal(grouped.get("updateCampaigns")?.length, 1);

  const many = Array.from({ length: 250 }, (_, i) => req({ requestId: `r${i}`, amazonEntityId: `K${i}` }));
  const parts = chunk(many, ADS_WRITE_BATCH_SIZE);
  assert.deepEqual(parts.map((p) => p.length), [100, 100, 50]);
  assert.deepEqual(chunk([], 100), []);
  assert.equal(chunk([1, 2, 3], 0).length, 3, "size ≤ 0 không được chia vô hạn");
});

/* ================================================================== */
/* 3. Phản hồi 207 Multi-Status                                       */
/* ================================================================== */

test("parseMultiStatus: 207 chuẩn {success, error} — đọc cả id và lỗi lồng nhau", () => {
  const parsed = parseMultiStatus(
    {
      campaigns: {
        success: [{ index: 0, campaignId: "C1" }],
        error: [{ index: 1, errors: [{ code: "INVALID_BID", message: "Bid vượt trần của Amazon" }] }],
      },
    },
    "campaigns",
    "campaignId",
  );
  assert.equal(parsed.unparsed, false);
  assert.equal(parsed.bare, false);
  assert.equal(parsed.success.length, 1);
  assert.equal(parsed.success[0].id, "C1");
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.errors[0].index, 1);
  assert.equal(parsed.errors[0].code, "INVALID_BID");
  assert.match(parsed.errors[0].message, /Bid vượt trần/);
});

test("parseMultiStatus: id có thể nằm lồng trong object thực thể (một số tài khoản trả vậy)", () => {
  const parsed = parseMultiStatus(
    { negativeKeywords: { success: [{ index: 0, negativeKeyword: { negativeKeywordId: "NK9" } }], error: [] } },
    "negativeKeywords",
    "negativeKeywordId",
  );
  assert.equal(parsed.success[0].id, "NK9");
});

test("parseMultiStatus: mảng trần / {key:[…]} / {errors:[…]} / null — không bao giờ đoán là thành công", () => {
  const bare = parseMultiStatus([{ keywordId: "K1" }], "keywords", "keywordId");
  assert.equal(bare.bare, true);
  assert.equal(bare.success[0].index, 0);
  assert.equal(bare.success[0].id, "K1");

  const wrappedArray = parseMultiStatus({ keywords: [{ keywordId: "K2" }] }, "keywords", "keywordId");
  assert.equal(wrappedArray.bare, true);
  assert.equal(wrappedArray.success[0].id, "K2");

  const batchError = parseMultiStatus({ errors: [{ code: "UNAUTHORIZED", message: "thiếu quyền advertiser_campaign_edit" }] }, "keywords", "keywordId");
  assert.equal(batchError.unparsed, true, "lỗi cả lô phải là unparsed để caller đánh dấu failed");
  assert.equal(batchError.errors[0].code, "UNAUTHORIZED");

  const nul = parseMultiStatus(null, "keywords", "keywordId");
  assert.equal(nul.unparsed, true);
  const emptyObj = parseMultiStatus({ keywords: {} }, "keywords", "keywordId");
  assert.equal(emptyObj.unparsed, true, "không có success cũng không có error → không được coi là ok");
});

test("matchResults: nối index → đúng đề xuất; thiếu index thì dò theo id Amazon", () => {
  const batch = [
    req({ requestId: "r0", amazonEntityId: "C1", entityType: "campaign", changeType: "budget" }),
    req({ requestId: "r1", amazonEntityId: "C2", entityType: "campaign", changeType: "budget" }),
  ];
  const byIndex = matchResults(
    batch,
    parseMultiStatus(
      { campaigns: { success: [{ index: 1, campaignId: "C2" }], error: [{ index: 0, errors: [{ code: "E", message: "lỗi" }] }] } },
      "campaigns",
      "campaignId",
    ),
    ADS_WRITE_OPS.updateCampaigns,
  );
  assert.equal(byIndex.get("r1")?.status, "applied");
  assert.equal(byIndex.get("r1")?.createdId, "C2");
  assert.equal(byIndex.get("r0")?.status, "failed");
  assert.match(byIndex.get("r0")?.message ?? "", /E: lỗi/);

  const noIndex = matchResults(
    batch,
    { success: [{ index: null, id: "C2", raw: {} }], errors: [], bare: true, unparsed: false },
    ADS_WRITE_OPS.updateCampaigns,
  );
  assert.equal(noIndex.get("r1")?.status, "applied", "không có index thì phải dò được theo id");
});

test("matchResults: dòng Amazon không trả kết quả → FAILED (không im lặng coi là xong)", () => {
  const batch = [
    req({ requestId: "r0", amazonEntityId: "C1", entityType: "campaign", changeType: "budget" }),
    req({ requestId: "r1", amazonEntityId: "C2", entityType: "campaign", changeType: "budget" }),
  ];
  const m = matchResults(
    batch,
    parseMultiStatus({ campaigns: { success: [{ index: 0, campaignId: "C1" }], error: [] } }, "campaigns", "campaignId"),
    ADS_WRITE_OPS.updateCampaigns,
  );
  assert.equal(m.get("r0")?.status, "applied");
  assert.equal(m.get("r1")?.status, "failed");
  assert.match(m.get("r1")?.message ?? "", /không trả kết quả/);
});

test("matchResults: phản hồi không đọc được → cả lô failed kèm lỗi gốc", () => {
  const batch = [req({ requestId: "r0" })];
  const m = matchResults(batch, { success: [], errors: [{ index: null, code: "403", message: "thiếu quyền" }], bare: false, unparsed: true }, ADS_WRITE_OPS.updateKeywords);
  assert.equal(m.get("r0")?.status, "failed");
  assert.match(m.get("r0")?.message ?? "", /403: thiếu quyền/);
});

/* ================================================================== */
/* 4. Verify before write (đối chiếu Amazon)                          */
/* ================================================================== */

function snap(over: Partial<AmazonSnapshot> = {}): AmazonSnapshot {
  return { ...emptySnapshot(), ...over };
}

test("verify: Amazon đang khác before_value → SKIP, không ghi đè thay đổi tay", () => {
  const s = snap({ campaigns: new Map([["C1", { budget: 40, budgetType: "DAILY", state: "ENABLED", name: null }]]) });
  const out = verifyRequest(req({ entityType: "campaign", changeType: "budget", amazonEntityId: "C1", beforeValue: { budget: 25 }, afterValue: { budget: 30 } }), s);
  assert.equal(out.ok, false);
  assert.match(out.reason ?? "", /40/);
  assert.match(out.reason ?? "", /25/);
  assert.match(out.reason ?? "", /đổi tay/);
  assert.equal(out.current, "40");
});

test("verify: khớp before_value (trong dung sai làm tròn) → cho ghi", () => {
  const s = snap({ campaigns: new Map([["C1", { budget: 25.001, budgetType: "DAILY", state: "ENABLED", name: null }]]) });
  const out = verifyRequest(req({ entityType: "campaign", changeType: "budget", amazonEntityId: "C1", beforeValue: { budget: 25 }, afterValue: { budget: 30 } }), s);
  assert.equal(out.ok, true);
  assert.equal(out.unverifiable, false);
  assert.ok(VERIFY_TOLERANCE > 0 && VERIFY_TOLERANCE < 0.01, "dung sai phải nhỏ hơn 1 xu");
});

test("verify: campaign đã ARCHIVED → skip (Amazon không cho sửa nữa)", () => {
  const s = snap({ campaigns: new Map([["C1", { budget: 25, budgetType: "DAILY", state: "ARCHIVED", name: null }]]) });
  const out = verifyRequest(req({ entityType: "campaign", changeType: "budget", amazonEntityId: "C1", beforeValue: { budget: 25 } }), s);
  assert.equal(out.ok, false);
  assert.match(out.reason ?? "", /ARCHIVED/);
});

test("verify: không đọc được thực thể → skip + đánh dấu unverifiable (không ghi mù)", () => {
  const out = verifyRequest(req({ entityType: "campaign", changeType: "budget", amazonEntityId: "C9", beforeValue: { budget: 25 } }), snap());
  assert.equal(out.ok, false);
  assert.equal(out.unverifiable, true);
  assert.match(out.reason ?? "", /Không đọc được campaign C9/);

  const kw = verifyRequest(req({ amazonEntityId: "KW404" }), snap());
  assert.equal(kw.ok, false);
  assert.equal(kw.unverifiable, true);
});

test("verify: before_value không có số → vẫn cho ghi nhưng nói rõ là không đối chiếu được", () => {
  const s = snap({ keywords: new Map([["KW1", { bid: 1.9, state: "ENABLED", campaignId: "C1", adGroupId: "AG1" }]]) });
  const out = verifyRequest(req({ beforeValue: null, afterValue: { bid: 1.5 } }), s);
  assert.equal(out.ok, true);
  assert.equal(out.unverifiable, true);
  assert.equal(out.current, "1.9");
});

test("verify: keyword bid lệch / đã ở trạng thái đích → skip", () => {
  const s = snap({ keywords: new Map([["KW1", { bid: 1.5, state: "PAUSED", campaignId: "C1", adGroupId: "AG1" }]]) });
  const drift = verifyRequest(req({ beforeValue: { bid: 1.2 }, afterValue: { bid: 1.02 } }), s);
  assert.equal(drift.ok, false);
  assert.match(drift.reason ?? "", /1.5/);

  const same = verifyRequest(req({ changeType: "state", beforeValue: { state: "ENABLED" }, afterValue: { state: "PAUSED" } }), s);
  assert.equal(same.ok, false);
  assert.match(same.reason ?? "", /đã ở trạng thái PAUSED/);

  const stateDrift = verifyRequest(req({ changeType: "state", beforeValue: { state: "ENABLED" }, afterValue: { state: "ARCHIVED" } }), s);
  assert.equal(stateDrift.ok, false);
  assert.match(stateDrift.reason ?? "", /đổi tay/);
});

test("verify: keyword đọc được nhưng bị cắt trang → nói rõ độ phủ trong lý do skip", () => {
  const s = snap({ keywordsTruncated: true, keywordsPages: 10 });
  const out = verifyRequest(req({ amazonEntityId: "KW404" }), s);
  assert.equal(out.ok, false);
  assert.match(out.reason ?? "", /bị cắt ở 10 trang/);
});

test("verify: ad_group chưa mở chiều ghi → skip, không đoán", () => {
  const out = verifyRequest(req({ entityType: "ad_group", changeType: "state", amazonEntityId: "AG1", afterValue: { state: "PAUSED" } }), snap());
  assert.equal(out.ok, false);
  assert.match(out.reason ?? "", /chưa mở/);
});

test("verify: negative keyword đã có trên Amazon → skip; đọc lỗi → skip unverifiable", () => {
  const s = snap({ negatives: new Set([negativeKey("C1", "AG1", "Free Sample", "NEGATIVE_EXACT")]) });
  const dup = verifyRequest(
    req({
      entityType: "negative_keyword",
      changeType: "create",
      amazonEntityId: "",
      campaignId: "C1",
      adGroupId: "AG1",
      label: "free sample",
      matchType: "NEGATIVE_EXACT",
      afterValue: { keyword_text: "free sample", match_type: "NEGATIVE_EXACT" },
    }),
    s,
  );
  assert.equal(dup.ok, false);
  assert.match(dup.reason ?? "", /đã có/i);

  const fresh = verifyRequest(
    req({
      entityType: "campaign_negative_keyword",
      changeType: "create",
      amazonEntityId: "",
      campaignId: "C1",
      adGroupId: "",
      label: "cheap",
      matchType: "NEGATIVE_PHRASE",
      afterValue: { keyword_text: "cheap", match_type: "NEGATIVE_PHRASE" },
    }),
    s,
  );
  assert.equal(fresh.ok, true, "từ khác / cấp khác thì không phải trùng");

  const readErr = snap({ readErrors: ["Không đọc được negative keyword (/sp/negativeKeywords/list): 403 forbidden"] });
  const blind = verifyRequest(
    req({ entityType: "negative_keyword", changeType: "create", amazonEntityId: "", campaignId: "C1", adGroupId: "AG1", label: "free", afterValue: {} }),
    readErr,
  );
  assert.equal(blind.ok, false);
  assert.equal(blind.unverifiable, true);
  assert.match(blind.reason ?? "", /không tạo mù/i);
});

test("negativeKey: khử hoa/thường + khoảng trắng hai đầu (giống lower(btrim()) của khoá unique trong 0021)", () => {
  assert.equal(negativeKey("C1", "AG1", "  Free Sample ", "negative_exact"), negativeKey("C1", "AG1", "free sample", "NEGATIVE_EXACT"));
  assert.notEqual(negativeKey("C1", "AG1", "free sample", "NEGATIVE_EXACT"), negativeKey("C1", "", "free sample", "NEGATIVE_EXACT"));
  // Khoảng trắng BÊN TRONG không bị gộp — đúng như lower(btrim()) của Postgres,
  // nên "free  sample" và "free sample" là hai từ khoá khác nhau với Amazon.
  assert.notEqual(negativeKey("C1", "AG1", "free  sample", "NEGATIVE_EXACT"), negativeKey("C1", "AG1", "free sample", "NEGATIVE_EXACT"));
});

/* ================================================================== */
/* 5. Fixtures cho luồng thật (fetch + db giả)                        */
/* ================================================================== */

const KEY = "b".repeat(64);
const SB = { url: "https://demo.supabase.co/", serviceRoleKey: "service-key" };
const OK_TOKEN = { access_token: "Atza|access-1h", expires_in: 3600, token_type: "bearer" };
const PROFILES = [
  {
    profileId: "111",
    countryCode: "US",
    currencyCode: "USD",
    accountInfo: { id: "ENTITY_US", type: "seller", name: "VEXIM US", marketplaceStringId: "ATVPDKIKX0DER" },
  },
];

type Call = { url: string; method: string; path: string; body: unknown; scope: string | null };

const FAKE_CREATED_PREFIX: Record<string, string> = {
  negativeKeywordId: "NK",
  campaignNegativeKeywordId: "CNK",
};

function opForPath(path: string): WriteOp | null {
  return Object.values(ADS_WRITE_OPS).find((o) => o.path === path) ?? null;
}

/** Phản hồi 207 "mọi dòng đều ok" — id tạo mới thì bịa theo tiền tố. */
function defaultWriteBody(path: string, body: unknown): unknown {
  const op = opForPath(path);
  if (!op) return {};
  const items = ((body as Record<string, unknown>)?.[op.bodyKey] ?? []) as Record<string, unknown>[];
  const success = items.map((it, i) => ({
    index: i,
    [op.idField]: it[op.idField] ?? `${FAKE_CREATED_PREFIX[op.idField] ?? "ID"}-${i + 1}`,
  }));
  return { [op.resultKey]: { success, error: [] } };
}

function json(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type AdsFetchOpts = {
  campaigns?: Record<string, unknown>[];
  /** POST /sp/campaigns/list CÓ filter bị từ chối (để test đường lùi không filter) */
  campaignFilterStatus?: number;
  allCampaigns?: Record<string, unknown>[];
  keywords?: Record<string, unknown>[];
  /** số trang keyword (nextToken) — trang cuối không còn nextToken */
  keywordPages?: number;
  negatives?: Record<string, unknown>[];
  campaignNegatives?: Record<string, unknown>[];
  /** ép một đường đọc trả lỗi */
  listError?: { path: string; status: number; body?: unknown };
  /** phản hồi chiều ghi theo path (mặc định 207 ok hết) */
  write?: Record<string, { status: number; body?: unknown }>;
};

function adsFetch(opts: AdsFetchOpts = {}) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const u = String(url);
    const method = String(init.method ?? "GET");
    const headers = (init.headers ?? {}) as Record<string, string>;
    let body: unknown;
    try {
      body = init.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = String(init.body);
    }
    const path = new URL(u).pathname;
    calls.push({ url: u, method, path, body, scope: headers["Amazon-Advertising-API-Scope"] ?? null });

    if (u.includes("/auth/o2/token")) return json(200, OK_TOKEN);
    if (path === "/v2/profiles") return json(200, PROFILES);

    const forced = opts.listError && path === opts.listError.path ? opts.listError : null;
    if (forced) return json(forced.status, forced.body ?? { errors: [{ code: "FORBIDDEN", message: "thiếu quyền đọc" }] });

    if (path === "/sp/campaigns/list") {
      const hasFilter = !!((body as Record<string, unknown>)?.campaignIdFilter);
      if (hasFilter && opts.campaignFilterStatus) {
        return json(opts.campaignFilterStatus, { errors: [{ code: "INVALID_ARGUMENT", message: "campaignIdFilter không hỗ trợ" }] });
      }
      const rows = hasFilter ? (opts.campaigns ?? []) : (opts.allCampaigns ?? opts.campaigns ?? []);
      return json(200, { campaigns: rows });
    }
    if (path === "/sp/keywords/list") {
      const pages = opts.keywordPages ?? 1;
      const nextToken = (body as Record<string, unknown>)?.nextToken as string | undefined;
      const page = nextToken ? Number(nextToken.replace("p", "")) : 1;
      const res: Record<string, unknown> = { keywords: opts.keywords ?? [] };
      if (page < pages) res.nextToken = `p${page + 1}`;
      return json(200, res);
    }
    if (path === "/sp/negativeKeywords/list") return json(200, { negativeKeywords: opts.negatives ?? [] });
    if (path === "/sp/campaignNegativeKeywords/list") {
      return json(200, { campaignNegativeKeywords: opts.campaignNegatives ?? [] });
    }

    const w = opts.write?.[path];
    if (w) return json(w.status, w.body ?? defaultWriteBody(path, body));
    if (opForPath(path)) return json(207, defaultWriteBody(path, body));
    return json(404, { errors: [{ code: "NOT_FOUND", message: `test không biết path ${path}` }] });
  }) as unknown as typeof fetch;
  return { fetchFn, calls, writes: () => calls.filter((c) => c.method === "PUT" || (c.method === "POST" && opForPath(c.path) !== null)) };
}

type DbCall = { fn: string; args: unknown[] };

function tokenRow(over: Record<string, unknown> = {}) {
  return {
    id: "tok-1",
    sellerAccountId: SHOP,
    encryptedRefreshToken: encryptToken("Atzr|IwEBI-ads-refresh-demo", KEY),
    status: "active",
    expiresAt: "2027-09-12T00:00:00+00:00",
    reauthorizeAt: "2027-09-12T00:00:00+00:00",
    lastRefreshAt: null,
    lastError: null,
    clientId: null,
    scope: "ads::campaign_management",
    adsAccountId: null,
    ...over,
  };
}

type ApplyDbOpts = {
  requests?: PpcChangeRequest[];
  approved?: PpcChangeRequest[];
  capLeft?: { sellerAccountId: string; shop: string | null; dailyCap: number; usedToday: number; waiting: number }[];
  tokenRow?: ReturnType<typeof tokenRow> | null;
  batch?: Record<string, unknown>;
  failSetResult?: boolean;
  alerts?: { ruleCode: string; nextAction: string }[];
};

function applyDb(opts: ApplyDbOpts = {}) {
  const calls: DbCall[] = [];
  const results: Record<string, unknown>[] = [];
  const rec = (fn: string) => (...args: unknown[]) => calls.push({ fn, args });
  const db = {
    async listShops() {
      rec("listShops")();
      return [{ id: SHOP, displayName: "A1 · US", marketplace: "ATVPDKIKX0DER", status: "active", dataSource: "production" }];
    },
    async getAdsToken(shopId: string) {
      rec("getAdsToken")(shopId);
      return opts.tokenRow === undefined ? tokenRow() : opts.tokenRow;
    },
    async touchAdsToken(id: string, patch: unknown) {
      rec("touchAdsToken")(id, patch);
    },
    async pendingChanges(shopId: string | null, limit?: number, stale?: number) {
      rec("pendingChanges")(shopId, limit, stale);
      const requests = opts.requests ?? [];
      return {
        batchId: "22222222-2222-4222-8222-222222222222",
        expired: 0,
        reclaimed: 0,
        skippedUnsupported: 0,
        count: requests.length,
        capLeft: opts.capLeft ?? [],
        requests,
        ...(opts.batch ?? {}),
      };
    },
    async listApprovedChanges(shopId: string | null, limit?: number) {
      rec("listApprovedChanges")(shopId, limit);
      return opts.approved ?? [];
    },
    async setChangeResult(row: Record<string, unknown>) {
      rec("setChangeResult")(row);
      if (opts.failSetResult) throw new Error("db offline");
      results.push(row);
      return { ok: row.status !== "failed", id: row.id, status: row.status };
    },
    async raisePpcAlerts(shopId: string | null) {
      rec("raisePpcAlerts")(shopId);
      return (opts.alerts ?? []).map((a) => ({
        shopId,
        shopName: "A1 · US",
        ruleCode: a.ruleCode,
        entityKey: null,
        severity: "amber",
        metric: 1,
        threshold: 24,
        alertId: null,
        nextAction: a.nextAction,
      }));
    },
  };
  return {
    db: db as never,
    calls,
    results,
    called: (fn: string) => calls.filter((c) => c.fn === fn),
  };
}

function writeConfig(over: Record<string, unknown> = {}) {
  return {
    region: "NA",
    host: "https://advertising-api.amazon.com",
    clientId: "ads-client-id",
    clientSecret: "ads-secret",
    scope: "ads::campaign_management",
    tokenKey: KEY,
    supabase: SB,
    envRefreshToken: null,
    accountId: null,
    countryCodeHint: null,
    profileTypeHint: "seller",
    attributionDays: 7,
    reportDays: 7,
    writeEnabled: true,
    writeBatchLimit: 100,
    writeStaleMinutes: 30,
    ready: true,
    problems: [],
    ...over,
  } as never;
}

const NOW = () => new Date("2026-09-13T04:20:00Z");

/* ================================================================== */
/* 6. readSnapshot — đọc Amazon để đối chiếu                          */
/* ================================================================== */

function clientWith(fetchFn: typeof fetch, profileId = "111") {
  return new AdsClient({
    host: "https://advertising-api.amazon.com",
    clientId: "ads-client-id",
    profileId,
    getAccessToken: async () => "Atza|access-1h",
    fetchFn,
  });
}

test("readSnapshot: dùng campaignIdFilter/keywordId khi đọc được (ít trang, ít tốn quota)", async () => {
  const { fetchFn, calls } = adsFetch({
    campaigns: [{ campaignId: "C1", state: "ENABLED", budget: { budget: 25, budgetType: "DAILY" } }],
    keywords: [{ keywordId: "KW1", bid: 1.2, state: "ENABLED", campaignId: "C1", adGroupId: "AG1" }],
    negatives: [{ campaignId: "C1", adGroupId: "AG1", keywordText: "free sample", matchType: "NEGATIVE_EXACT" }],
  });
  const snap = await readSnapshot(
    clientWith(fetchFn),
    [
      req({ entityType: "campaign", changeType: "budget", amazonEntityId: "C1" }),
      req({ requestId: "r2", amazonEntityId: "KW1" }),
      req({ requestId: "r3", entityType: "negative_keyword", changeType: "create", amazonEntityId: "", label: "cheap" }),
    ],
    {},
  );
  assert.equal(snap.campaigns.get("C1")?.budget, 25);
  assert.equal(snap.keywords.get("KW1")?.bid, 1.2);
  assert.equal(snap.negatives.has(negativeKey("C1", "AG1", "free sample", "NEGATIVE_EXACT")), true);
  assert.deepEqual(snap.readErrors, []);

  const campaignCall = calls.find((c) => c.path === "/sp/campaigns/list");
  assert.deepEqual((campaignCall?.body as Record<string, unknown>).campaignIdFilter, { include: ["C1"] });
  const negCall = calls.find((c) => c.path === "/sp/negativeKeywords/list");
  assert.deepEqual((negCall?.body as Record<string, unknown>).campaignIdFilter, { include: ["C1"] });
  assert.equal(negCall?.scope, "111", "mọi call phải kèm Amazon-Advertising-API-Scope");
});

test("readSnapshot: Amazon từ chối filter → LÙI về đọc không filter rồi lọc tại chỗ", async () => {
  const { fetchFn, calls } = adsFetch({
    campaignFilterStatus: 400,
    allCampaigns: [
      { campaignId: "C1", state: "ENABLED", budget: { budget: 25, budgetType: "DAILY" } },
      { campaignId: "OTHER", state: "ENABLED", budget: { budget: 9, budgetType: "DAILY" } },
    ],
  });
  const snap = await readSnapshot(clientWith(fetchFn), [req({ entityType: "campaign", changeType: "budget", amazonEntityId: "C1" })], {});
  assert.equal(snap.campaigns.get("C1")?.budget, 25, "vẫn verify được nhờ đường lùi");
  assert.equal(snap.readErrors.length, 1);
  assert.match(snap.readErrors[0], /campaignIdFilter bị từ chối/);
  assert.equal(calls.filter((c) => c.path === "/sp/campaigns/list").length, 2, "gọi lại lần 2 không filter");
});

test("readSnapshot: phân trang keyword và nói THẬT khi bị cắt ở maxPages", async () => {
  const { fetchFn } = adsFetch({ keywords: [{ keywordId: "KW1", bid: 1.2, state: "ENABLED" }], keywordPages: 3 });
  const full = await readSnapshot(clientWith(fetchFn), [req()], { maxPages: 5 });
  assert.equal(full.keywordsPages, 3);
  assert.equal(full.keywordsTruncated, false);

  const cut = await readSnapshot(clientWith(fetchFn), [req()], { maxPages: 1 });
  assert.equal(cut.keywordsPages, 1);
  assert.equal(cut.keywordsTruncated, true, "phải biết là chưa đọc hết — verify sẽ nói rõ độ phủ");
});

test("readSnapshot: đọc lỗi một phần → ghi vào readErrors, không ném (verify sẽ skip)", async () => {
  const { fetchFn } = adsFetch({
    campaigns: [{ campaignId: "C1", state: "ENABLED", budget: { budget: 25, budgetType: "DAILY" } }],
    listError: { path: "/sp/negativeKeywords/list", status: 403 },
  });
  const snap = await readSnapshot(
    clientWith(fetchFn),
    [
      req({ entityType: "campaign", changeType: "budget", amazonEntityId: "C1" }),
      req({ requestId: "r2", entityType: "negative_keyword", changeType: "create", amazonEntityId: "", label: "cheap" }),
    ],
    {},
  );
  assert.equal(snap.campaigns.size, 1, "phần đọc được vẫn dùng được");
  assert.ok(snap.readErrors.some((e) => e.includes("/sp/negativeKeywords/list")));
});

/* ================================================================== */
/* 7. runAdsApply — chốt an toàn                                      */
/* ================================================================== */

test("ADS_WRITE_ENABLED tắt: KHÔNG gọi Amazon và KHÔNG giành lô (hàng đợi nguyên trạng)", async () => {
  const store = applyDb({ requests: [req()] });
  const { fetchFn, calls } = adsFetch({});
  const res = await runAdsApply({ config: writeConfig({ writeEnabled: false }), db: store.db, fetchFn, now: NOW });
  assert.equal(res.enabled, false);
  assert.equal(res.shopsProcessed, 0);
  assert.equal(res.counts.claimed, 0);
  assert.equal(calls.length, 0, "không một request nào tới Amazon");
  assert.equal(store.called("pendingChanges").length, 0, "không giành lô → đề xuất vẫn ở approved");
  assert.equal(store.results.length, 0);
  assert.match(res.hint ?? "", /ADS_WRITE_ENABLED/);
  assert.match(res.hint ?? "", /dryRun=1/);
  assert.ok(res.warnings.some((w) => /đang TẮT/i.test(w)));
});

test("thiếu credential Ads / thiếu Supabase → dừng kèm việc phải làm", async () => {
  const { fetchFn, calls } = adsFetch({});
  const noCred = await runAdsApply({ config: writeConfig({ clientId: null }), db: applyDb().db, fetchFn, now: NOW });
  assert.match(noCred.errors[0], /AMAZON_ADS_CLIENT_ID/);
  assert.equal(calls.length, 0);

  const noDb = await runAdsApply({ config: writeConfig(), db: null, fetchFn, now: NOW });
  assert.match(noDb.errors[0], /Supabase/);
});

test("dryRun: đọc hàng đợi approved (KHÔNG giành lô), đọc Amazon, in payload, không gửi", async () => {
  const requests = [req({ entityType: "campaign", changeType: "budget", amazonEntityId: "C1", beforeValue: { budget: 25 }, afterValue: { budget: 30 } })];
  const store = applyDb({ approved: requests });
  const { fetchFn, calls, writes } = adsFetch({ campaigns: [{ campaignId: "C1", state: "ENABLED", budget: { budget: 25, budgetType: "DAILY" } }] });

  const res = await runAdsApply({ config: writeConfig({ writeEnabled: false }), db: store.db, fetchFn, now: NOW, dryRun: true });
  assert.equal(res.dryRun, true);
  assert.equal(store.called("listApprovedChanges").length, 1);
  assert.equal(store.called("pendingChanges").length, 0, "dryRun không được giành lô");
  assert.equal(store.results.length, 0, "dryRun không ghi kết quả");
  assert.equal(writes().length, 0, "dryRun không gửi gì lên Amazon");
  assert.equal(res.counts.deferred, 1);
  const item = res.outcomes[0].items[0];
  assert.equal(item.status, "deferred");
  assert.match(item.message ?? "", /PUT \/sp\/campaigns/);
  assert.match(item.message ?? "", /"budget":\{"budget":30,"budgetType":"DAILY"\}/);
  assert.match(res.hint ?? "", /KHÔNG gửi/);
  assert.ok(calls.some((c) => c.path === "/sp/campaigns/list"), "dryRun vẫn đọc Amazon để đối chiếu");
});

test("happy path: verify khớp → PUT/POST đúng body, ghi applied + verified_before, nổ/đóng alert", async () => {
  const requests = [
    req({ requestId: "r1", entityType: "campaign", changeType: "budget", amazonEntityId: "C1", beforeValue: { budget: 25 }, afterValue: { budget: 30 } }),
    req({ requestId: "r2", entityType: "keyword", changeType: "bid", amazonEntityId: "KW1", beforeValue: { bid: 1.2 }, afterValue: { bid: 1.02 } }),
    req({
      requestId: "r3",
      entityType: "campaign_negative_keyword",
      changeType: "create",
      amazonEntityId: "",
      campaignId: "C1",
      adGroupId: "",
      label: "free sample",
      matchType: "NEGATIVE_EXACT",
      beforeValue: null,
      afterValue: { keyword_text: "free sample", match_type: "NEGATIVE_EXACT" },
    }),
  ];
  const store = applyDb({ requests, alerts: [{ ruleCode: "ppc_pending_approval", nextAction: "resolved" }] });
  const { fetchFn, writes } = adsFetch({
    campaigns: [{ campaignId: "C1", state: "ENABLED", budget: { budget: 25, budgetType: "DAILY" } }],
    keywords: [{ keywordId: "KW1", bid: 1.2, state: "ENABLED", campaignId: "C1", adGroupId: "AG1" }],
  });

  const res = await runAdsApply({ config: writeConfig(), db: store.db, fetchFn, now: NOW });
  assert.deepEqual([res.counts.applied, res.counts.failed, res.counts.skipped], [3, 0, 0]);
  assert.equal(res.counts.verified, 3);
  assert.equal(res.counts.alerts, 1);
  assert.equal(res.outcomes[0].profileId, "111");
  assert.equal(res.outcomes[0].tokenSource, "db");

  const campaignWrite = writes().find((c) => c.path === "/sp/campaigns");
  assert.equal(campaignWrite?.method, "PUT");
  assert.deepEqual(campaignWrite?.body, { campaigns: [{ campaignId: "C1", budget: { budget: 30, budgetType: "DAILY" } }] });
  const keywordWrite = writes().find((c) => c.path === "/sp/keywords");
  assert.deepEqual(keywordWrite?.body, { keywords: [{ keywordId: "KW1", bid: 1.02 }] });
  const negWrite = writes().find((c) => c.path === "/sp/campaignNegativeKeywords");
  assert.equal(negWrite?.method, "POST");
  assert.deepEqual(negWrite?.body, {
    campaignNegativeKeywords: [{ campaignId: "C1", keywordText: "free sample", matchType: "NEGATIVE_EXACT", state: "ENABLED" }],
  });
  assert.equal(campaignWrite?.scope, "111", "header scope phải là profileId của shop");

  const applied = store.results.filter((r) => r.status === "applied");
  assert.equal(applied.length, 3);
  assert.equal(applied.every((r) => r.verifiedBefore === true), true);
  const neg = store.results.find((r) => r.id === "r3");
  assert.equal(neg?.createdId, "CNK-1", "phải lưu id Amazon trả về để lần sau bật/tắt bằng id thật");
  assert.equal(store.called("raisePpcAlerts").length, 1);
});

test("verify lệch: Amazon đã bị đổi tay → SKIP, không gửi PUT", async () => {
  const requests = [req({ requestId: "r1", entityType: "campaign", changeType: "budget", amazonEntityId: "C1", beforeValue: { budget: 25 }, afterValue: { budget: 30 } })];
  const store = applyDb({ requests });
  const { fetchFn, writes } = adsFetch({ campaigns: [{ campaignId: "C1", state: "ENABLED", budget: { budget: 40, budgetType: "DAILY" } }] });

  const res = await runAdsApply({ config: writeConfig(), db: store.db, fetchFn, now: NOW });
  assert.equal(res.counts.skipped, 1);
  assert.equal(res.counts.applied, 0);
  assert.equal(writes().length, 0, "không được ghi đè thay đổi tay của người khác");
  assert.equal(store.results[0].status, "skipped");
  assert.match(String(store.results[0].error), /40/);
});

test("negative keyword đã tồn tại trên Amazon → skip, không POST tạo trùng", async () => {
  const requests = [
    req({
      requestId: "r1",
      entityType: "negative_keyword",
      changeType: "create",
      amazonEntityId: "",
      campaignId: "C1",
      adGroupId: "AG1",
      label: "free sample",
      matchType: "NEGATIVE_EXACT",
      beforeValue: null,
      afterValue: { keyword_text: "free sample", match_type: "NEGATIVE_EXACT" },
    }),
  ];
  const store = applyDb({ requests });
  const { fetchFn, writes } = adsFetch({
    negatives: [{ campaignId: "C1", adGroupId: "AG1", keywordText: "Free Sample", matchType: "NEGATIVE_EXACT" }],
  });
  const res = await runAdsApply({ config: writeConfig(), db: store.db, fetchFn, now: NOW });
  assert.equal(res.counts.skipped, 1);
  assert.equal(writes().length, 0);
  assert.match(String(store.results[0].error), /đã có/i);
});

test("429 khi ghi → giữ 'applying' cho lượt sau đòi lại: KHÔNG ghi failed, KHÔNG retry dồn", async () => {
  const requests = [req({ requestId: "r1", entityType: "campaign", changeType: "budget", amazonEntityId: "C1", beforeValue: { budget: 25 }, afterValue: { budget: 30 } })];
  const store = applyDb({ requests });
  const { fetchFn, calls } = adsFetch({
    campaigns: [{ campaignId: "C1", state: "ENABLED", budget: { budget: 25, budgetType: "DAILY" } }],
    write: { "/sp/campaigns": { status: 429, body: { errors: [{ code: "THROTTLED", message: "Too Many Requests" }] } } },
  });

  const res = await runAdsApply({ config: writeConfig(), db: store.db, fetchFn, now: NOW });
  assert.equal(res.counts.deferred, 1);
  assert.equal(res.counts.failed, 0);
  assert.equal(store.results.length, 0, "không ghi kết quả → dòng vẫn 'applying' để reclaim");
  assert.equal(calls.filter((c) => c.path === "/sp/campaigns" && c.method === "PUT").length, 1, "không retry trong cùng lượt");
  assert.ok(res.warnings.some((w) => /dời lô/i.test(w)));
  assert.match(res.outcomes[0].items[0].message ?? "", /retryable/);
});

test("Amazon trả lỗi từng dòng (400) → failed kèm nguyên văn lý do + http status", async () => {
  const requests = [
    req({ requestId: "r1", entityType: "campaign", changeType: "budget", amazonEntityId: "C1", beforeValue: { budget: 25 }, afterValue: { budget: 30 } }),
    req({ requestId: "r2", entityType: "campaign", changeType: "budget", amazonEntityId: "C2", beforeValue: { budget: 10 }, afterValue: { budget: 12 } }),
  ];
  const store = applyDb({ requests });
  const { fetchFn } = adsFetch({
    campaigns: [
      { campaignId: "C1", state: "ENABLED", budget: { budget: 25, budgetType: "DAILY" } },
      { campaignId: "C2", state: "ENABLED", budget: { budget: 10, budgetType: "DAILY" } },
    ],
    write: {
      "/sp/campaigns": {
        status: 207,
        body: {
          campaigns: {
            success: [{ index: 0, campaignId: "C1" }],
            error: [{ index: 1, errors: [{ code: "INVALID_BUDGET", message: "Budget phải ≥ 15 cho marketplace này" }] }],
          },
        },
      },
    },
  });

  const res = await runAdsApply({ config: writeConfig(), db: store.db, fetchFn, now: NOW });
  assert.equal(res.counts.applied, 1);
  assert.equal(res.counts.failed, 1);
  const failed = store.results.find((r) => r.id === "r2");
  assert.equal(failed?.status, "failed");
  assert.match(String(failed?.error), /INVALID_BUDGET/);
  assert.match(String(failed?.error), /≥ 15/);
  const item = res.outcomes[0].items.find((i) => i.requestId === "r2");
  assert.equal(item?.httpStatus, 207);
});

test("không có token của shop → cả lô failed kèm lý do + alert, không treo im lặng ở 'applying'", async () => {
  const requests = [req({ requestId: "r1" }), req({ requestId: "r2", amazonEntityId: "KW2" })];
  const store = applyDb({ requests, tokenRow: null });
  const { fetchFn, calls } = adsFetch({});

  const res = await runAdsApply({ config: writeConfig(), db: store.db, fetchFn, now: NOW });
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], /access token/);
  assert.equal(store.results.length, 2, "mỗi dòng đều có kết quả để audit không bị mù");
  assert.equal(store.results.every((r) => r.status === "failed"), true);
  assert.match(String(store.results[0].error), /duyệt lại/);
  assert.equal(calls.filter((c) => c.path.startsWith("/sp/")).length, 0, "không gọi Amazon khi không có token");
  assert.equal(res.counts.failed, 2);
});

test("campaign không phải Sponsored Products → lớp chắn thứ hai: skip, không gọi Amazon", async () => {
  const requests = [req({ requestId: "r1", entityType: "campaign", changeType: "budget", amazonEntityId: "C1", campaignType: "SB", beforeValue: { budget: 25 }, afterValue: { budget: 30 } })];
  const store = applyDb({ requests });
  const { fetchFn, writes } = adsFetch({ campaigns: [{ campaignId: "C1", state: "ENABLED", budget: { budget: 25, budgetType: "DAILY" } }] });

  const res = await runAdsApply({ config: writeConfig(), db: store.db, fetchFn, now: NOW });
  assert.equal(res.counts.skipped, 1);
  assert.equal(writes().length, 0);
  assert.match(String(store.results[0].error), /Sponsored Products/);
});

test("payload không dựng được (after_value thiếu số) → failed, không gửi dòng đó", async () => {
  const requests = [req({ requestId: "r1", afterValue: { bid: "abc" } })];
  const store = applyDb({ requests });
  const { fetchFn, writes } = adsFetch({ keywords: [{ keywordId: "KW1", bid: 1.2, state: "ENABLED" }] });
  const res = await runAdsApply({ config: writeConfig(), db: store.db, fetchFn, now: NOW });
  assert.equal(res.counts.failed, 1);
  assert.equal(writes().length, 0);
  assert.match(String(store.results[0].error), /payload không hợp lệ/);
});

test("skipVerify=1: bỏ đọc Amazon (có cảnh báo), kết quả ghi verified_before=false", async () => {
  const requests = [req({ requestId: "r1", entityType: "campaign", changeType: "budget", amazonEntityId: "C1", beforeValue: { budget: 25 }, afterValue: { budget: 30 } })];
  const store = applyDb({ requests });
  const { fetchFn, calls } = adsFetch({});
  const res = await runAdsApply({ config: writeConfig(), db: store.db, fetchFn, now: NOW, skipVerify: true });
  assert.equal(calls.filter((c) => c.path.endsWith("/list")).length, 0, "không đọc Amazon khi skipVerify");
  assert.equal(res.counts.applied, 1);
  assert.equal(res.counts.verified, 0);
  assert.equal(store.results[0].verifiedBefore, false);
  assert.ok(res.outcomes[0].warnings.some((w) => /skipVerify/.test(w)));
});

test("hết trần ngày: cron nói rõ vì sao không lấy được dòng nào (cap_left của RPC)", async () => {
  const store = applyDb({
    requests: [],
    capLeft: [{ sellerAccountId: SHOP, shop: "A1 · US", dailyCap: 50, usedToday: 50, waiting: 12 }],
  });
  const { fetchFn } = adsFetch({});
  const res = await runAdsApply({ config: writeConfig(), db: store.db, fetchFn, now: NOW });
  assert.equal(res.counts.claimed, 0);
  assert.ok(
    res.outcomes[0].warnings.some((w) => /Trần ngày đã dùng hết/.test(w) && /12 việc chờ/.test(w)),
    `warnings: ${JSON.stringify(res.outcomes[0].warnings)}`,
  );
});

test("profileId: hàng đợi có sẵn thì dùng luôn; rỗng thì tự chốt qua GET /v2/profiles", async () => {
  const withProfile = applyDb({ requests: [req({ requestId: "r1", adsProfileId: "999" })] });
  const a = adsFetch({ keywords: [{ keywordId: "KW1", bid: 1.2, state: "ENABLED" }] });
  const resA = await runAdsApply({ config: writeConfig(), db: withProfile.db, fetchFn: a.fetchFn, now: NOW });
  assert.equal(resA.outcomes[0].profileId, "999");
  assert.equal(a.calls.some((c) => c.path === "/v2/profiles"), false, "có profileId rồi thì không hỏi lại Amazon");
  assert.match(resA.outcomes[0].profileReason ?? "", /hàng đợi/);

  const noProfile = applyDb({ requests: [req({ requestId: "r1", adsProfileId: "" })] });
  const b = adsFetch({ keywords: [{ keywordId: "KW1", bid: 1.2, state: "ENABLED" }] });
  const resB = await runAdsApply({ config: writeConfig(), db: noProfile.db, fetchFn: b.fetchFn, now: NOW });
  assert.equal(resB.outcomes[0].profileId, "111");
  assert.equal(b.calls.some((c) => c.path === "/v2/profiles"), true);
});

test("ghi kết quả hỏng (DB offline) → vẫn báo rõ trong warnings, không nuốt lỗi", async () => {
  const requests = [req({ requestId: "r1", entityType: "campaign", changeType: "budget", amazonEntityId: "C1", beforeValue: { budget: 25 }, afterValue: { budget: 30 } })];
  const store = applyDb({ requests, failSetResult: true });
  const { fetchFn } = adsFetch({ campaigns: [{ campaignId: "C1", state: "ENABLED", budget: { budget: 25, budgetType: "DAILY" } }] });
  const res = await runAdsApply({ config: writeConfig(), db: store.db, fetchFn, now: NOW });
  assert.equal(res.counts.applied, 1, "Amazon đã ghi nhận thay đổi — đếm đúng sự thật");
  assert.ok(res.outcomes[0].warnings.some((w) => /Không ghi được kết quả/.test(w)));
  assert.ok(res.errors.some((e) => /Không ghi được kết quả/.test(e)));
});

test("limit: mỗi shop chỉ lấy tối đa writeBatchLimit đề xuất một lượt", async () => {
  const store = applyDb({ requests: [req()] });
  const { fetchFn } = adsFetch({ keywords: [{ keywordId: "KW1", bid: 1.2, state: "ENABLED" }] });
  await runAdsApply({ config: writeConfig({ writeBatchLimit: 25 }), db: store.db, fetchFn, now: NOW });
  assert.equal(store.called("pendingChanges")[0].args[1], 25);
  assert.equal(store.called("pendingChanges")[0].args[2], 30, "staleMinutes phải truyền xuống RPC reclaim");
});

/* ================================================================== */
/* 8. AdsDb: đường PostgREST + ánh xạ cho 3 RPC của 0021              */
/* ================================================================== */

function dbFetch(responder: (call: DbCall & { url: string }) => { status?: number; body: unknown }) {
  const calls: (DbCall & { url: string })[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const u = String(url);
    const call = {
      fn: u.includes("/rpc/") ? u.split("/rpc/")[1].split("?")[0] : `GET ${u.split("?")[0]}`,
      args: init.body ? [JSON.parse(String(init.body))] : [],
      url: u,
      method: String(init.method ?? "GET"),
      headers: (init.headers ?? {}) as Record<string, string>,
    };
    calls.push(call as never);
    const r = responder(call as never);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls: calls as unknown as (DbCall & { url: string; headers: Record<string, string>; method: string })[] };
}

test("db.pendingChanges: gọi đúng RPC + ánh xạ snake_case → camelCase (kể cả before/after jsonb)", async () => {
  const { fetchFn, calls } = dbFetch(() => ({
    body: {
      ok: true,
      batch_id: "b-1",
      expired: 1,
      reclaimed: 2,
      skipped_unsupported: 3,
      count: 1,
      cap_left: [{ seller_account_id: SHOP, shop: "A1 · US", daily_cap: 50, used_today: 4, waiting: 7 }],
      requests: [
        {
          request_id: "r-1",
          seller_account_id: SHOP,
          shop: "A1 · US",
          ads_profile_id: "111",
          entity_type: "campaign",
          change_type: "budget",
          amazon_entity_id: "C1",
          campaign_id: "C1",
          ad_group_id: "",
          label: "SP main",
          match_type: null,
          currency: "USD",
          before_value: { budget: 25 },
          after_value: { budget: 30 },
          delta_pct: "20.00",
          attempts: 1,
          batch_id: "b-1",
          decided_at: "2026-09-13T02:00:00Z",
          proposed_at: "2026-09-13T01:00:00Z",
          expires_at: "2026-09-16T01:00:00Z",
          claimed_at: "2026-09-13T04:20:00Z",
          campaign_type: "SP",
          campaign_name: "SP main",
          campaign_state: "ENABLED",
          campaign_daily_budget: "25.00",
        },
      ],
    },
  }));
  const db = createAdsDb(SB, fetchFn);
  const batch = await db.pendingChanges(SHOP, 40, 45);

  assert.equal(calls[0].url, "https://demo.supabase.co/rest/v1/rpc/vexim_worker_ppc_pending_changes");
  assert.deepEqual(calls[0].args[0], { p_seller: SHOP, p_limit: 40, p_stale_minutes: 45 });
  assert.equal(batch.batchId, "b-1");
  assert.deepEqual([batch.expired, batch.reclaimed, batch.skippedUnsupported, batch.count], [1, 2, 3, 1]);
  assert.deepEqual(batch.capLeft[0], { sellerAccountId: SHOP, shop: "A1 · US", dailyCap: 50, usedToday: 4, waiting: 7 });

  const r = batch.requests[0];
  assert.equal(r.requestId, "r-1");
  assert.equal(r.entityType, "campaign");
  assert.deepEqual(r.beforeValue, { budget: 25 });
  assert.deepEqual(r.afterValue, { budget: 30 });
  assert.equal(r.deltaPct, 20, "numeric trả về dạng chuỗi — phải ép số");
  assert.equal(r.campaignDailyBudget, 25);
  assert.equal(r.claimedAt, "2026-09-13T04:20:00Z");
});

test("db.setChangeResult: bọc {p_payload} đúng tên khoá RPC đọc (sai tên là mất audit im lặng)", async () => {
  const { fetchFn, calls } = dbFetch(() => ({
    body: { ok: true, id: "r-1", status: "applied", label: "SP main", entity_type: "campaign", change_type: "budget", attempts: 1, created_id: null, alert_id: null, error: null },
  }));
  const db = createAdsDb(SB, fetchFn);
  const out = await db.setChangeResult({
    id: "r-1",
    status: "applied",
    batchId: "b-1",
    error: null,
    createdId: "NK-1",
    amazonResponse: { index: 0 },
    verifiedBefore: true,
  });
  assert.equal(calls[0].url, "https://demo.supabase.co/rest/v1/rpc/vexim_worker_ppc_set_result");
  assert.deepEqual(calls[0].args[0], {
    p_payload: {
      id: "r-1",
      status: "applied",
      batch_id: "b-1",
      error: null,
      created_id: "NK-1",
      amazon_response: { index: 0 },
      verified_before: true,
    },
  });
  assert.equal(out.status, "applied");
  assert.equal(out.ok, true);
});

test("db.listApprovedChanges: đọc hàng đợi qua PostgREST (schema ads bằng header, path KHÔNG có tiền tố)", async () => {
  const { fetchFn, calls } = dbFetch((c) => {
    if (c.url.includes("/change_requests")) {
      return {
        body: [
          {
            id: "r-1",
            seller_account_id: SHOP,
            ads_profile_id: "",
            entity_type: "keyword",
            change_type: "bid",
            amazon_entity_id: "KW1",
            campaign_id: "C1",
            ad_group_id: "AG1",
            label: "mat ong",
            match_type: null,
            currency: "USD",
            before_value: { bid: 1.2 },
            after_value: { bid: 1.02 },
            delta_pct: "-15.00",
            attempts: 0,
            batch_id: null,
            status: "approved",
            proposed_at: "2026-09-13T01:00:00Z",
            decided_at: "2026-09-13T02:00:00Z",
            expires_at: null,
            claimed_at: null,
            last_error: null,
          },
        ],
      };
    }
    return { body: [{ campaign_id: "C1", campaign_type: "SB" }] };
  });
  const db = createAdsDb(SB, fetchFn);
  const rows = await db.listApprovedChanges(SHOP, 10);

  const first = calls[0];
  assert.ok(first.url.startsWith("https://demo.supabase.co/rest/v1/change_requests?"), first.url);
  assert.ok(first.url.includes("status=eq.approved"));
  assert.ok(first.url.includes(`seller_account_id=eq.${SHOP}`));
  assert.equal(first.headers["Accept-Profile"], "ads", "chọn schema bằng header");
  assert.equal(first.url.includes("ads.change_requests"), false, "path không được có tiền tố schema (PGRST205)");

  assert.equal(rows.length, 1);
  assert.equal(rows[0].requestId, "r-1", "bảng gốc dùng cột id — mapper phải đổi thành requestId");
  assert.equal(rows[0].status, "approved");
  assert.equal(rows[0].campaignType, "SB", "dryRun phải biết campaign không phải SP để báo skip");
});

test("db.raisePpcAlerts: gọi vexim_ppc_raise_alerts và ánh xạ như raiseAlerts của 0020", async () => {
  const { fetchFn, calls } = dbFetch(() => ({
    body: [{ shop_id: SHOP, shop_name: "A1 · US", rule_code: "ppc_change_failed", entity_key: "k", severity: "red", metric: 2, threshold: 1, alert_id: "a-1", next_action: "raised" }],
  }));
  const db = createAdsDb(SB, fetchFn);
  const rows = await db.raisePpcAlerts(SHOP);
  assert.equal(calls[0].url, "https://demo.supabase.co/rest/v1/rpc/vexim_ppc_raise_alerts");
  assert.deepEqual(calls[0].args[0], { p_seller: SHOP });
  assert.deepEqual(rows[0], {
    shopId: SHOP,
    shopName: "A1 · US",
    ruleCode: "ppc_change_failed",
    entityKey: "k",
    severity: "red",
    metric: 2,
    threshold: 1,
    alertId: "a-1",
    nextAction: "raised",
  });
});

/* ================================================================== */
/* 9. Cron route + vercel.json                                        */
/* ================================================================== */

const ROOT = new URL("../../", import.meta.url).pathname;

test("vercel.json có cron ads-apply và lịch KHỚP hằng ADS_APPLY_CRON (chạy sau ads-sync)", () => {
  const vercel = JSON.parse(readFileSync(`${ROOT}web/vercel.json`, "utf8")) as {
    crons: { path: string; schedule: string }[];
  };
  const apply = vercel.crons.find((c) => c.path === "/api/cron/ads-apply");
  assert.ok(apply, "thiếu cron /api/cron/ads-apply trong vercel.json");
  assert.equal(apply?.schedule, ADS_APPLY_CRON, "lịch trong vercel.json phải khớp ADS_APPLY_CRON (UI hiện lịch này)");

  const sync = vercel.crons.find((c) => c.path === "/api/cron/ads-sync");
  assert.ok(sync, "ads-sync phải tồn tại");
  // "phút giờ ngày tháng thứ" — đọc từng phần thay vì regex cho đỡ rối.
  const [applyMin, applyHour] = ADS_APPLY_CRON.split(" ");
  const [syncMin, syncHour] = (sync?.schedule ?? "0 3 * * *").split(" ");
  assert.equal(applyHour, "4", "ads-apply chạy lúc 04:xx UTC");
  assert.equal(
    Number(applyHour) * 60 + Number(applyMin) > Number(syncHour) * 60 + Number(syncMin),
    true,
    "ads-apply phải chạy SAU ads-sync để verify bằng số liệu vừa nhập",
  );
});

test("route ads-apply: khoá bằng CRON_SECRET, maxDuration 60, có dryRun, dùng service_role qua createAdsDb", () => {
  const src = readFileSync(`${ROOT}web/src/app/api/cron/ads-apply/route.ts`, "utf8");
  assert.match(src, /CRON_SECRET/);
  assert.match(src, /export const maxDuration = 60/);
  assert.match(src, /runAdsApply\(/);
  assert.match(src, /dryRun/, "phải có đường xem trước mà không ghi");
  assert.match(src, /createAdsDb/);
  assert.match(src, /export const POST = GET/, "Vercel cron gọi GET; POST để chạy tay");
  assert.equal(src.includes("NEXT_PUBLIC"), false, "không đẩy biến public ra route ghi");
});
