/**
 * Test Module 5 phần 1 — hai JOB của Amazon Ads (đồng bộ cấu trúc + kéo report)
 * và job nhắc re-authorize của Module 0.
 *
 * Đây là tầng dễ "xanh giả" nhất, nên mỗi test khoá một LUẬT:
 *   1. KHÔNG XIN REPORT MỚI khi report cũ còn trong cooldown — phải poll đúng
 *      reportId đã ghi (nếu không: đốt trần tốc độ của Amazon).
 *   2. Report rỗng = `no_data`, KHÔNG phải lỗi (ngày không chạy quảng cáo).
 *   3. `--dry-run` không ghi gì: không dòng metrics, không trạng thái report,
 *      không cảnh báo.
 *   4. 429 (trần tốc độ) KHÁC 401/403 (phải re-authorize ở Module 0).
 *   5. CẢNH BÁO NGHIỆP VỤ tự nổ từ số vừa nhập: ACOS vượt ngưỡng + ngân sách cạn,
 *      kèm sự kiện ngân sách (hour_source='unavailable' — v3 không có giờ).
 *   6. ads_spend chảy vào F4 (TINK: chỉ UPDATE dòng đã có, không tạo dòng mới).
 *   7. Token sắp hết hạn: tạo cảnh báo MỘT LẦN (đánh dấu đã nhắc), không lặp mỗi ngày.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { MockDbAdapter } from "../../web/src/lib/worker/db/adapter.ts";
import { AdsApiRequestError, type AdsClient } from "../src/amazon/ads.ts";
import { runAdsEntitySync, type AdsSyncShop } from "../src/jobs/ads-sync.job.ts";
import { computeAdsPeriod, runAdsReportPull } from "../src/jobs/ads-report-pull.job.ts";
import { runOauthReminder } from "../src/jobs/oauth-reminder.job.ts";

const SHOP: AdsSyncShop = {
  id: "11111111-1111-1111-1111-111111111111",
  displayName: "VEXIM US",
  marketplace: "ATVPDKIKX0DER",
};

const NOW = new Date("2026-09-13T00:00:00Z");

const profileJson = {
  profileId: "P-1",
  countryCode: "US",
  currency: "USD",
  timezone: "America/Los_Angeles",
  accountType: "seller",
  accountName: "VEXIM",
  marketplaceId: "ATVPDKIKX0DER",
  managerAccountId: null,
};

const campaignJson = {
  campaignId: "C-1",
  name: "Vali 20 inch",
  state: "ENABLED",
  campaignType: "SPONSORED_PRODUCTS",
  targetingType: "MANUAL",
  dailyBudget: 20,
  budgetCurrency: "USD",
  budgetType: "DAILY",
  portfolioId: null,
  biddingStrategy: "LEGACY_FOR_SALES",
  startDate: "2026-01-01",
  endDate: null,
  premiumBidAdjustment: false,
};

type FakeOpts = {
  statuses?: ("PENDING" | "PROCESSING" | "COMPLETED" | "FAILED")[];
  text?: string;
  createError?: unknown;
  throwOnProfiles?: unknown;
  profiles?: unknown[];
  /** negative ĐANG CÓ trên Amazon — hàm sẽ trả về */
  negatives?: unknown[];
  /** lỗi cho lần gọi KHÔNG filter (mô phỏng Amazon đòi campaignIdFilter) */
  negativeListError?: unknown;
  /** lỗi cho MỌI lần gọi (kể cả theo campaign) */
  negativeAlwaysError?: unknown;
};

class FakeAds {
  created: { name: string; startDate: string; endDate: string; configuration: { reportTypeId: string } }[] = [];
  polls: string[] = [];
  downloads: string[] = [];
  /** mỗi lần gọi listNegativeKeywords ghi lại tham số để test soi (filter hay không) */
  negativeCalls: { campaignIds?: string[] }[] = [];
  private opts: FakeOpts;

  constructor(opts: FakeOpts = {}) {
    this.opts = opts;
  }

  async getProfiles() {
    if (this.opts.throwOnProfiles) throw this.opts.throwOnProfiles;
    return (this.opts.profiles ?? [profileJson]) as never;
  }

  async listCampaigns() {
    return [campaignJson] as never;
  }

  async listAdGroups() {
    return [{ adGroupId: "AG-1", campaignId: "C-1", name: "Vali 20 inch", state: "ENABLED", defaultBid: 0.75 }] as never;
  }

  async listNegativeKeywords(_profileId: string, opts: { campaignIds?: string[] } = {}) {
    this.negativeCalls.push({ campaignIds: opts.campaignIds });
    if (this.opts.negativeAlwaysError) throw this.opts.negativeAlwaysError;
    const filtered = (opts.campaignIds ?? []).length > 0;
    if (!filtered && this.opts.negativeListError) throw this.opts.negativeListError;
    return (this.opts.negatives ?? []) as never;
  }

  async listTargets() {
    return [
      {
        targetKey: "KW-1",
        targetKind: "keyword" as const,
        campaignId: "C-1",
        adGroupId: "AG-1",
        keywordText: "vali 20 inch",
        matchType: "EXACT",
        expressionType: null,
        expressionValue: null,
        bid: 1.1,
        state: "ENABLED",
      },
    ] as never;
  }

  async createReport(req: {
    name: string;
    startDate: string;
    endDate: string;
    configuration: { reportTypeId: string };
  }) {
    if (this.opts.createError) throw this.opts.createError;
    this.created.push(req);
    return { reportId: `R-${this.created.length}` };
  }

  async getReport(reportId: string) {
    this.polls.push(reportId);
    const status = this.opts.statuses?.shift() ?? "COMPLETED";
    return {
      reportId,
      status,
      url: status === "COMPLETED" ? `https://files.example/${reportId}` : null,
      failureReason: null,
      createdAt: null,
      updatedAt: null,
    };
  }

  async fetchReportContent(reportId: string) {
    this.downloads.push(reportId);
    const info = await this.getReport(reportId);
    if (info.status !== "COMPLETED") return { info, text: null, gzipped: false, bytes: 0 };
    const text = this.opts.text ?? "[]";
    return { info, text, gzipped: false, bytes: text.length };
  }
}

const asClient = (f: FakeAds) => f as unknown as AdsClient;

const jsonText = (rows: Record<string, unknown>[]) => JSON.stringify(rows);

const pullOpts = (db: MockDbAdapter, fake: FakeAds, over: Record<string, unknown> = {}) => ({
  db,
  shops: [SHOP],
  clientFor: () => asClient(fake),
  now: NOW,
  pollAttempts: 2,
  pollDelayMs: 0,
  sleep: async () => {},
  adsProfileFor: () => ({ adsProfileId: "P-1", currency: "USD" }),
  fireAlerts: true,
  applySpend: true,
  log: () => {},
  ...over,
});

// ============================================================================
// 1. ĐỒNG BỘ CẤU TRÚC
// ============================================================================

test("ads-sync: ghi profile → campaign → ad group → target, giữ tỷ lệ đếm được", async () => {
  const db = new MockDbAdapter();
  const res = await runAdsEntitySync({
    db,
    shops: [SHOP],
    clientFor: () => asClient(new FakeAds()),
    log: () => {},
  });

  assert.equal(res.synced, 1);
  assert.equal(res.failed, 0);
  assert.equal(db.adsProfiles.length, 1);
  assert.equal(db.adsProfiles[0].adsProfileId, "P-1");
  assert.equal(db.adsProfiles[0].marketplace, "ATVPDKIKX0DER");
  assert.equal(db.adsProfiles[0].currency, "USD");
  assert.equal(db.adsCampaigns.length, 1);
  assert.equal(db.adsCampaigns[0].campaignId, "C-1");
  assert.equal(db.adsCampaigns[0].adsProfileId, "P-1", "campaign phải gắn profile để không trộn số giữa 2 marketplace");
  assert.equal(db.adsAdGroups.length, 1);
  assert.equal(db.adsTargets.length, 1);
  assert.equal(db.adsTargets[0].targetKind, "keyword");
  assert.equal(res.results[0].counts.campaigns.inserted, 1);
});

test("ads-sync: đọc negative ĐANG CÓ trên Amazon về gương (A3 mới biết 'đã chặn')", async () => {
  const db = new MockDbAdapter();
  const fake = new FakeAds({
    negatives: [
      { keywordId: "N-1", campaignId: "C-1", adGroupId: "AG-1", keywordText: "vali to", matchType: "NEGATIVE_EXACT", state: "ENABLED" },
      { keywordId: "N-2", campaignId: "C-1", adGroupId: "AG-1", keywordText: "free ship", matchType: "NEGATIVE_PHRASE", state: "ENABLED" },
    ],
  });
  const res = await runAdsEntitySync({ db, shops: [SHOP], clientFor: () => asClient(fake), log: () => {} });

  assert.equal(res.synced, 1);
  assert.equal(fake.negativeCalls.length, 1, "gọi KHÔNG filter là đủ cho lần đầu — rẻ nhất");
  assert.equal(db.adsNegativeKeywords.length, 2);
  assert.equal(db.adsNegativeKeywords[0].keywordText, "vali to");
  assert.equal(db.adsNegativeKeywords[0].adsProfileId, "P-1", "gương phải gắn profile để không trộn marketplace");
  assert.equal(db.adsNegativeKeywords[0].changeRequestId, null, "negative đọc về KHÔNG gắn với yêu cầu thay đổi nào");
  assert.equal(res.results[0].counts.negativeKeywords.inserted, 2);
  assert.deepEqual(res.results[0].errors, [], "không có lỗi thì không được rải cảnh báo");

  // chạy lần hai: cùng dữ liệu ⇒ UPDATE, không nhân đôi
  await runAdsEntitySync({ db, shops: [SHOP], clientFor: () => asClient(fake), log: () => {} });
  assert.equal(db.adsNegativeKeywords.length, 2);
});

test("ads-sync: Amazon đòi filter ⇒ tự hỏi theo từng campaign (và không làm hỏng sync)", async () => {
  const db = new MockDbAdapter();
  const fake = new FakeAds({
    negativeListError: new AdsApiRequestError({
      status: 400,
      code: "BAD_REQUEST",
      message: "campaignIdFilter is required",
    }),
    negatives: [
      { keywordId: "N-9", campaignId: "C-1", adGroupId: "AG-1", keywordText: "vali to", matchType: "NEGATIVE_EXACT", state: "ENABLED" },
    ],
  });
  const res = await runAdsEntitySync({ db, shops: [SHOP], clientFor: () => asClient(fake), log: () => {} });

  assert.equal(res.synced, 1, "lỗi khi đọc negative KHÔNG được làm hỏng việc đồng bộ cấu trúc");
  assert.equal(fake.negativeCalls.length, 2, "1 lần không filter + 1 lần theo campaign");
  assert.deepEqual(fake.negativeCalls[1].campaignIds, ["C-1"]);
  assert.equal(db.adsNegativeKeywords.length, 1);
  assert.equal(res.results[0].counts.negativeKeywords.inserted, 1);
});

test("ads-sync: đọc negative lỗi hoàn toàn ⇒ sync vẫn xong nhưng PHẢI cảnh báo gương thiếu", async () => {
  const db = new MockDbAdapter();
  const fake = new FakeAds({
    negativeAlwaysError: new AdsApiRequestError({ status: 403, code: "UNAUTHORIZED", message: "not allowed" }),
  });
  const res = await runAdsEntitySync({ db, shops: [SHOP], clientFor: () => asClient(fake), log: () => {} });

  assert.equal(res.synced, 1);
  assert.equal(db.adsNegativeKeywords.length, 0);
  assert.equal(res.results[0].errors.length, 1, "im lặng là tệ nhất: A3 sẽ hiện 'chưa chặn' mà không ai biết vì sao");
  assert.match(res.results[0].errors[0], /gương negative keyword có thể THIẾU/);
  assert.match(res.results[0].errors[0], /not allowed/);
});

test("ads-sync: chạy lần hai cập nhật, KHÔNG nhân đôi campaign", async () => {
  const db = new MockDbAdapter();
  const fake = new FakeAds();
  await runAdsEntitySync({ db, shops: [SHOP], clientFor: () => asClient(fake), log: () => {} });
  await runAdsEntitySync({ db, shops: [SHOP], clientFor: () => asClient(fake), log: () => {} });
  assert.equal(db.adsCampaigns.length, 1);
  assert.equal(db.adsAdGroups.length, 1);
});

test("ads-sync: chưa cấu hình credential Ads → skipped kèm hướng dẫn, KHÔNG throw", async () => {
  const db = new MockDbAdapter();
  const res = await runAdsEntitySync({ db, shops: [SHOP], clientFor: () => null, log: () => {} });
  assert.equal(res.skipped, 1);
  assert.equal(res.failed, 0);
  assert.match(res.results[0].message, /AMAZON_ADS_CLIENT_ID/);
  assert.equal(db.adsCampaigns.length, 0);
});

test("ads-sync: token hỏng (401) → needsReauth=true để màn Kết nối shop hiện đúng việc phải làm", async () => {
  const db = new MockDbAdapter();
  const res = await runAdsEntitySync({
    db,
    shops: [SHOP],
    clientFor: () =>
      asClient(
        new FakeAds({
          throwOnProfiles: new AdsApiRequestError({
            status: 401,
            code: "UnauthorizedException",
            message: "token hết hạn",
          }),
        }),
      ),
    log: () => {},
  });
  assert.equal(res.failed, 1);
  assert.deepEqual(res.needsReauth, [SHOP.id]);
  assert.match(res.results[0].message, /Module 0/);
  assert.equal(db.adsProfiles.length, 0);
});

// ============================================================================
// 2. KÉO REPORT — luật trần tốc độ & trạng thái
// ============================================================================

test("ads-pull (file): nhập campaign metrics + ghi trạng thái report", async () => {
  const db = new MockDbAdapter();
  const fake = new FakeAds();
  const text = jsonText([
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
  ]);
  const res = await runAdsReportPull(pullOpts(db, fake, { kinds: ["campaigns"], texts: { campaigns: text } }));

  assert.equal(res.imported, 1);
  assert.equal(db.adsCampaignMetrics.length, 1);
  const m = db.adsCampaignMetrics[0];
  assert.equal(m.day, "2026-09-12");
  assert.equal(m.cost, 18.5);
  assert.equal(m.sales7d, 90);
  assert.equal(m.units7d, 3, "unitsSoldClicks7d được ghi thành units7d cho RPC");
  assert.equal(m.budgetAmount, 20);
  assert.equal(m.adsProfileId, "P-1");
  assert.equal(db.reportRequests.length, 1);
  assert.equal(db.reportRequests[0].status, "imported");
  assert.equal(db.reportRequests[0].reportType, "spCampaigns");
  assert.equal(db.reportRequests[0].rowsImported, 1);
});

test("ads-pull (api): report đang chờ → ghi trạng thái + reportId; lần sau POLL ĐÚNG report đó", async () => {
  const db = new MockDbAdapter();
  const first = new FakeAds({ statuses: ["PROCESSING", "PROCESSING"] });
  const r1 = await runAdsReportPull(pullOpts(db, first, { kinds: ["campaigns"] }));

  assert.equal(r1.outcomes[0].action, "pending");
  assert.equal(first.created.length, 1);
  assert.equal(db.reportRequests.length, 1);
  assert.equal(db.reportRequests[0].status, "in_progress");
  assert.equal(db.reportRequests[0].reportId, "R-1");

  // Lần chạy sau: KHÔNG xin report mới, poll đúng R-1 rồi nhập.
  const second = new FakeAds({
    statuses: ["COMPLETED"],
    text: jsonText([{ date: "2026-09-12", campaignId: "C-1", cost: "4", clicks: "2" }]),
  });
  const r2 = await runAdsReportPull(pullOpts(db, second, { kinds: ["campaigns"] }));

  assert.equal(second.created.length, 0, "phải poll report cũ, KHÔNG xin report mới");
  assert.equal(second.polls[0], "R-1");
  assert.equal(r2.imported, 1);
  assert.equal(db.adsCampaignMetrics.length, 1);
});

test("ads-pull (api): cùng khoảng ngày đã nhập → bỏ qua, không xin lại", async () => {
  const db = new MockDbAdapter();
  const fake = new FakeAds({ statuses: ["COMPLETED"], text: jsonText([{ date: "2026-09-12", campaignId: "C-1", cost: "4" }]) });
  await runAdsReportPull(pullOpts(db, fake, { kinds: ["campaigns"] }));
  const again = new FakeAds({ statuses: ["COMPLETED"], text: "[]" });
  const r2 = await runAdsReportPull(pullOpts(db, again, { kinds: ["campaigns"] }));

  assert.equal(r2.skipped, 1);
  assert.equal(again.created.length, 0);
  assert.match(r2.outcomes[0].message, /đã NHẬP XONG|không có dữ liệu/);
});

test("ads-pull: report rỗng → no_data (KHÔNG phải lỗi), và KHÔNG tạo cảnh báo", async () => {
  const db = new MockDbAdapter();
  const fake = new FakeAds();
  const res = await runAdsReportPull(pullOpts(db, fake, { kinds: ["campaigns"], texts: { campaigns: "[]" } }));

  assert.equal(res.noData, 1);
  assert.equal(res.failed, 0);
  assert.equal(db.reportRequests[0].status, "no_data");
  assert.equal(db.alerts.length, 0);
});

test("ads-pull: dry-run KHÔNG ghi metrics, KHÔNG ghi trạng thái report, KHÔNG cảnh báo", async () => {
  const db = new MockDbAdapter();
  const fake = new FakeAds();
  const text = jsonText([
    { date: "2026-09-12", campaignId: "C-1", campaignName: "Vali", cost: "50", sales7d: "10", clicks: "30", campaignBudgetAmount: "20" },
  ]);
  const res = await runAdsReportPull(
    pullOpts(db, fake, { kinds: ["campaigns"], texts: { campaigns: text }, dryRun: true }),
  );

  assert.equal(res.outcomes[0].action, "dry_run");
  assert.equal(db.adsCampaignMetrics.length, 0);
  assert.equal(db.reportRequests.length, 0);
  assert.equal(db.alerts.length, 0);
  assert.equal(db.adsBudgetEvents.length, 0);
});

test("ads-pull: 429 → throttled (thử lại sau), KHÔNG đánh dấu cần re-authorize", async () => {
  const db = new MockDbAdapter();
  const fake = new FakeAds({
    createError: new AdsApiRequestError({ status: 429, code: "Throttling", message: "slow down" }),
  });
  const res = await runAdsReportPull(pullOpts(db, fake, { kinds: ["campaigns"] }));
  assert.equal(res.throttled, 1);
  assert.equal(res.outcomes[0].needsReauth, false);
});

test("ads-pull: 401 → failed + needsReauth (việc phải làm là authorize lại, không phải thử lại)", async () => {
  const db = new MockDbAdapter();
  const fake = new FakeAds({
    createError: new AdsApiRequestError({ status: 401, code: "UnauthorizedException", message: "hết hạn" }),
  });
  const res = await runAdsReportPull(pullOpts(db, fake, { kinds: ["campaigns"] }));
  assert.equal(res.failed, 1);
  assert.equal(res.outcomes[0].needsReauth, true);
  assert.equal(db.reportRequests[0].status, "failed");
  assert.match(String(db.reportRequests[0].lastError), /401/);
});

// ============================================================================
// 3. CẢNH BÁO NGHIỆP VỤ (khác 0019 — điểm mới của Module 5)
// ============================================================================

test("ads-pull: ACOS vượt ngưỡng + ngân sách cạn → tự nổ cảnh báo + sự kiện ngân sách", async () => {
  const db = new MockDbAdapter();
  const fake = new FakeAds();
  const text = jsonText([
    {
      date: "2026-09-12",
      campaignId: "C-1",
      campaignName: "Vali 20 inch",
      campaignBudgetAmount: "20.00",
      campaignBudgetCurrencyCode: "USD",
      cost: "30",
      clicks: "25",
      sales7d: "50",
    },
  ]);
  const res = await runAdsReportPull(pullOpts(db, fake, { kinds: ["campaigns"], texts: { campaigns: text } }));

  // ACOS 7 ngày = 30/50 = 60% > 25% và click 25 ≥ 10, chi 30 ≥ 5
  // Ngân sách: chi ngày mới nhất 30 / 20 = 150% ≥ 95%
  assert.equal(res.alertsFired, 2);
  const rules = db.alerts.map((a) => a.ruleCode).sort();
  assert.deepEqual(rules, ["acos_over_target", "budget_exhausted"]);
  assert.match(String(db.alerts[0].detail), /ACOS|ngân sách/);
  assert.equal(db.adsBudgetEvents.length, 1);
  assert.equal(db.adsBudgetEvents[0].eventType, "capped");
  assert.equal(db.adsBudgetEvents[0].hourSource, "unavailable", "v3 KHÔNG có dữ liệu giờ — không được bịa");
  assert.equal(db.adsBudgetEvents[0].exhaustedHour ?? null, null);
});

test("ads-pull: cảnh báo dùng tiêu đề CỐ ĐỊNH + không nhân đôi khi chạy lại", async () => {
  const db = new MockDbAdapter();
  const fake = new FakeAds();
  const text = jsonText([
    { date: "2026-09-12", campaignId: "C-1", campaignName: "Vali", cost: "30", clicks: "25", sales7d: "50" },
  ]);
  await runAdsReportPull(pullOpts(db, fake, { kinds: ["campaigns"], texts: { campaigns: text } }));
  const firstTitles = db.alerts.map((a) => a.title);
  await runAdsReportPull(pullOpts(db, fake, { kinds: ["campaigns"], texts: { campaigns: text } }));
  assert.deepEqual(db.alerts.map((a) => a.title), firstTitles, "chạy lại KHÔNG tạo cảnh báo trùng");
  for (const t of firstTitles) {
    assert.ok(!/\d+%/.test(t), `tiêu đề không chứa số liệu đổi theo ngày: ${t}`);
  }
});

test("ads-pull: SKU chưa có dòng F4 → bỏ qua và NÓI RÕ, không tạo dòng lợi nhuận mới", async () => {
  const db = new MockDbAdapter();
  const fake = new FakeAds();
  const text = jsonText([{ date: "2026-09-12", campaignId: "C-1", advertisedSku: "SKU-MOI", cost: "7.5" }]);
  const res = await runAdsReportPull(
    pullOpts(db, fake, { kinds: ["advertised-products"], texts: { "advertised-products": text } }),
  );

  assert.equal(res.spendApplied, 0);
  assert.equal(db.skuProfit.length, 0, "F4 là nguồn sự thật — ads KHÔNG được tạo dòng lợi nhuận");
  assert.ok(res.outcomes[0].warnings.some((w) => /ads_spend/.test(w)), "phải cảnh báo vì sao không lấp được");
});

test("ads-pull: có dòng F4 cùng tiền tệ → lấp ads_spend (TACOS có số thật)", async () => {
  const db = new MockDbAdapter();
  db.skuProfit.push({
    sellerAccountId: SHOP.id,
    sku: "SKU-1",
    day: "2026-09-12",
    currency: "USD",
    units: 3,
    revenue: 120,
    refunds: 0,
    amazonFees: 20,
    promo: 0,
    cogs: 40,
    adsSpend: null,
    grossProfit: null,
    unitCost: null,
    feeSource: "settlement",
  });
  const fake = new FakeAds();
  const text = jsonText([{ date: "2026-09-12", campaignId: "C-1", advertisedSku: "SKU-1", cost: "12.25" }]);
  const res = await runAdsReportPull(
    pullOpts(db, fake, { kinds: ["advertised-products"], texts: { "advertised-products": text } }),
  );

  assert.equal(res.spendApplied, 1);
  assert.equal(db.skuProfit[0].adsSpend, 12.25);
  assert.equal(db.skuProfit.length, 1);
});

// ============================================================================
// 4. MODULE 0 — nhắc re-authorize
// ============================================================================

test("oauth-reminder: token còn 5 ngày → tạo cảnh báo + đánh dấu đã nhắc (không lặp mỗi ngày)", async () => {
  const db = new MockDbAdapter();
  // ⚠️ Mốc hạn phải tính theo ĐỒNG HỒ THẬT, không theo NOW: MockDbAdapter
  // .listOauthSoon() đếm daysLeft bằng Date.now() (đúng như DB production dùng
  // now()). Dùng NOW cứng ⇒ test đỏ dần theo thời gian dù sản phẩm không đổi.
  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
  await db.saveOauthToken(SHOP.id, {
    refreshToken: "Atzr|abc",
    authorizedAt: NOW.toISOString(),
    expiresAt: soon,
    noticeDays: 30,
  });

  const r1 = await runOauthReminder({ db, now: NOW, log: () => {} });
  assert.equal(r1.checked, 1);
  assert.equal(r1.alertsCreated, 1);
  assert.equal(r1.marked, 1);
  assert.equal(db.alerts[0].ruleCode, "oauth_reauth_due");
  // Khoá LUẬT: cảnh báo phải nói rõ còn bao nhiêu ngày (giá trị lấy từ đồng hồ
  // thật của mock, nên chỉ kiểm tra định dạng + đang trong cửa sổ nhắc).
  assert.match(String(db.alerts[0].detail), /còn \d+ ngày/);

  const r2 = await runOauthReminder({ db, now: NOW, log: () => {} });
  assert.equal(r2.alertsCreated, 0);
  assert.equal(r2.alreadyNoticed.length, 1);
});

test("oauth-reminder: token ĐÃ hết hạn vẫn phải nhắc (đồng bộ đang dừng hẳn)", async () => {
  const db = new MockDbAdapter();
  await db.saveOauthToken(SHOP.id, {
    refreshToken: "Atzr|abc",
    authorizedAt: new Date(NOW.getTime() - 400 * 86_400_000).toISOString(),
    expiresAt: new Date(NOW.getTime() - 10 * 86_400_000).toISOString(),
    noticeDays: 30,
  });
  const res = await runOauthReminder({ db, now: NOW, log: () => {} });
  assert.equal(res.expired.length, 1);
  assert.equal(res.alertsCreated, 1);
  assert.match(String(db.alerts[0].detail), /ĐÃ HẾT HẠN/);
});

test("oauth-reminder: dry-run chỉ đọc — KHÔNG tạo cảnh báo, KHÔNG đánh dấu", async () => {
  const db = new MockDbAdapter();
  await db.saveOauthToken(SHOP.id, {
    refreshToken: "Atzr|abc",
    // đồng hồ thật, xem chú thích ở test "token còn 5 ngày"
    expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    noticeDays: 30,
  });
  const res = await runOauthReminder({ db, now: NOW, dryRun: true, log: () => {} });
  assert.equal(res.due.length, 1);
  assert.equal(res.alertsCreated, 0);
  assert.equal(db.alerts.length, 0);
});

// ============================================================================
// 5. Khoảng ngày
// ============================================================================

test("computeAdsPeriod: mặc định 30 ngày lùi, và tôn trọng --days", () => {
  const p = computeAdsPeriod("campaigns", { now: NOW });
  assert.equal(p.end, "2026-09-13");
  assert.equal(p.start, "2026-08-14");
  const p7 = computeAdsPeriod("campaigns", { days: 7, now: NOW });
  assert.equal(p7.start, "2026-09-06");
  const target = computeAdsPeriod("targeting", { now: NOW });
  assert.equal(target.start, p.start, "mọi loại report dùng cùng lookbackDays mặc định");
});
