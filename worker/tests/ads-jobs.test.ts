/**
 * Test Module 5 phần 1 — HAI JOB của Amazon Ads.
 *
 * Đây là chỗ khoá những luật KHÔNG được vi phạm (mỗi luật ứng với một cách hỏng
 * thật, đã gặp ở 0019 với SP-API):
 *   1. POLL-KHÔNG-TẠO-MỚI: report đang chạy thì lần sau poll đúng reportId đó.
 *      Xin report mới mỗi lần chạy là tự bắn vào trần tốc độ của Amazon.
 *   2. CÙNG KHOẢNG NGÀY: đã nhập rồi thì BỎ QUA (không nhập lại, không xin lại).
 *   3. REPORT RỖNG = no_data, KHÔNG phải lỗi.
 *   4. DRY-RUN không ghi gì: không dòng dữ liệu, không trạng thái request,
 *      không cảnh báo.
 *   5. 429 ≠ 401: 429 là "thử lại sau"; 401/403 là "phải re-authorize ở Module 0".
 *   6. CẢNH BÁO TỰ NỔ: ACOS vượt mục tiêu và ngân sách bị dùng hết phải tạo cảnh
 *      báo + sự kiện ngân sách, tính từ chính dữ liệu vừa nhập.
 *   7. ads_spend chảy vào F4 (TACOS thật) nhưng KHÔNG tạo dòng mới và KHÔNG trộn
 *      tiền tệ.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { MockDbAdapter } from "../../web/src/lib/worker/db/adapter.ts";
import { AdsApiRequestError, type AdsClient, type AdsReportInfo } from "../src/amazon/ads.ts";
import { runAdsEntitySync, type AdsSyncShop } from "../src/jobs/ads-sync.job.ts";
import { runAdsReportPull, computeAdsPeriod } from "../src/jobs/ads-report-pull.job.ts";
import { runOauthReminder } from "../src/jobs/oauth-reminder.job.ts";

// ============================================================================
// Fixture
// ============================================================================

const SHOP: AdsSyncShop = {
  id: "11111111-1111-1111-1111-111111111111",
  displayName: "VEXIM US",
  marketplace: "ATVPDKIKX0DER",
};

const NOW = new Date("2026-09-13T00:00:00.000Z");

type FakeAdsConfig = {
  profiles?: Record<string, unknown>[];
  campaigns?: Record<string, unknown>[];
  adGroups?: Record<string, unknown>[];
  targets?: Record<string, unknown>[];
  /** các trạng thái report trả lần lượt cho mỗi lần poll */
  statuses?: AdsReportInfo["status"][];
  text?: string;
  throwOnCreate?: unknown;
};

/** AdsClient giả — chỉ ghi lại lời gọi để test kiểm tra HÀNH VI, không mạng. */
class FakeAds {
  created: { reportTypeId: string; startDate: string }[] = [];
  polls = 0;
  downloads: string[] = [];
  listCalls = 0;
  profileCalls = 0;

  // Không dùng parameter property: worker test chạy `node --experimental-strip-types`
  // (strip-only) nên cú pháp đó bị từ chối.
  private readonly cfg: FakeAdsConfig;

  constructor(cfg: FakeAdsConfig = {}) {
    this.cfg = cfg;
  }

  async getProfiles() {
    this.profileCalls++;
    return (this.cfg.profiles ?? [
      {
        profileId: "P-1",
        countryCode: "US",
        currency: "USD",
        timezone: null,
        accountType: "seller",
        accountName: "VEXIM",
        marketplaceId: "ATVPDKIKX0DER",
        managerAccountId: null,
      },
    ]) as never;
  }

  async listCampaigns() {
    this.listCalls++;
    return (this.cfg.campaigns ?? [
      {
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
      },
    ]) as never;
  }

  async listAdGroups() {
    this.listCalls++;
    return (this.cfg.adGroups ?? [
      { adGroupId: "AG-1", campaignId: "C-1", name: "Vali 20 inch", state: "ENABLED", defaultBid: 0.75 },
    ]) as never;
  }

  async listTargets() {
    this.listCalls++;
    return (this.cfg.targets ?? [
      {
        targetKey: "KW-1",
        targetKind: "keyword",
        campaignId: "C-1",
        adGroupId: "AG-1",
        keywordText: "vali 20 inch",
        matchType: "EXACT",
        expressionType: null,
        expressionValue: null,
        bid: 1.1,
        state: "ENABLED",
      },
    ]) as never;
  }

  async createReport(req: { configuration: { reportTypeId: string }; startDate: string }) {
    if (this.cfg.throwOnCreate) throw this.cfg.throwOnCreate;
    this.created.push({
      reportTypeId: req.configuration.reportTypeId,
      startDate: req.startDate,
    });
    return { reportId: `R-${this.created.length}` };
  }

  async getReport(reportId: string): Promise<AdsReportInfo> {
    this.polls++;
    const status = this.cfg.statuses?.shift() ?? "COMPLETED";
    return {
      reportId,
      status,
      url: status === "COMPLETED" ? `https://files.example/${reportId}` : null,
      failureReason: status === "FAILED" ? "Invalid column: acos7d" : null,
      createdAt: null,
      updatedAt: null,
    };
  }

  async fetchReportContent(reportId: string) {
    this.downloads.push(reportId);
    const info = await this.getReport(reportId);
    if (info.status !== "COMPLETED") {
      return { info, text: null, gzipped: false, bytes: 0 };
    }
    const text = this.cfg.text ?? "[]";
    return { info, text, gzipped: true, bytes: text.length };
  }
}

const asClient = (fake: FakeAds): AdsClient => fake as unknown as AdsClient;

const campaignReport = (rows: Record<string, unknown>[]) => JSON.stringify(rows);

const baseOpts = (db: MockDbAdapter, fake: FakeAds) => ({
  db,
  shops: [SHOP],
  clientFor: () => asClient(fake),
  now: NOW,
  pollAttempts: 2,
  pollDelayMs: 0,
  sleep: async () => {},
  adsProfileFor: () => ({ adsProfileId: "P-1", currency: "USD" }),
  log: () => {},
});

// ============================================================================
// 1. ĐỒNG BỘ CẤU TRÚC
// ============================================================================

test("ads-sync: profile → campaign → ad group → target đều được ghi, gắn đúng ads_profile_id", async () => {
  const db = new MockDbAdapter();
  const fake = new FakeAds();
  const res = await runAdsEntitySync({ db, shops: [SHOP], clientFor: () => asClient(fake), log: () => {} });

  assert.equal(res.synced, 1);
  assert.equal(res.failed, 0);
  assert.equal(db.adsProfiles.length, 1);
  assert.equal(db.adsCampaigns.length, 1);
  assert.equal(db.adsAdGroups.length, 1);
  assert.equal(db.adsTargets.length, 1);
  assert.equal(db.adsProfiles[0].marketplace, "ATVPDKIKX0DER");
  assert.equal(db.adsProfiles[0].currency, "USD");
  assert.equal(db.adsCampaigns[0].adsProfileId, "P-1", "campaign phải gắn profile Ads (khoá tiền tệ)");
  assert.equal(db.adsCampaigns[0].dailyBudget, 20);
  assert.equal(db.adsTargets[0].targetKind, "keyword");
  assert.equal(db.adsTargets[0].keywordText, "vali 20 inch");
  assert.equal(fake.listCalls, 3, "gọi 3 lượt: campaigns · adGroups · targets");
});

test("ads-sync: nhập lại cùng dữ liệu → updated, KHÔNG nhân đôi", async () => {
  const db = new MockDbAdapter();
  const fake = new FakeAds();
  await runAdsEntitySync({ db, shops: [SHOP], clientFor: () => asClient(fake), log: () => {} });
  const second = await runAdsEntitySync({ db, shops: [SHOP], clientFor: () => asClient(fake), log: () => {} });

  assert.equal(db.adsCampaigns.length, 1);
  assert.equal(db.adsTargets.length, 1);
  assert.equal(second.results[0].counts.campaigns.updated, 1);
  assert.equal(second.results[0].counts.campaigns.inserted, 0);
});

test("ads-sync: chưa cấu hình credential → skipped kèm hướng dẫn, KHÔNG throw", async () => {
  const db = new MockDbAdapter();
  const res = await runAdsEntitySync({ db, shops: [SHOP], clientFor: () => null, log: () => {} });
  assert.equal(res.skipped, 1);
  assert.equal(res.failed, 0);
  assert.match(res.results[0].message, /AMAZON_ADS_CLIENT_ID/);
  assert.equal(db.adsCampaigns.length, 0, "không có credential thì không được ghi gì");
});

test("ads-sync: 401/403 → needsReauth=true (việc phải làm là KẾT NỐI LẠI, không phải thử lại)", async () => {
  const db = new MockDbAdapter();
  const fake = new FakeAds();
  fake.getProfiles = async () => {
    throw new AdsApiRequestError({
      status: 403,
      code: "UnauthorizedException",
      message: "profile không thuộc tài khoản đang token hoá",
    });
  };
  const res = await runAdsEntitySync({ db, shops: [SHOP], clientFor: () => asClient(fake), log: () => {} });
  assert.equal(res.failed, 1);
  assert.deepEqual(res.needsReauth, [SHOP.id]);
  assert.match(res.results[0].message, /re-authorize/);
});

test("ads-sync: dry-run chỉ ĐỌC, không ghi DB", async () => {
  const db = new MockDbAdapter();
  const fake = new FakeAds();
  const res = await runAdsEntitySync({
    db,
    shops: [SHOP],
    clientFor: () => asClient(fake),
    dryRun: true,
    log: () => {},
  });
  assert.equal(res.synced, 1);
  assert.equal(fake.profileCalls, 1, "dry-run vẫn kiểm tra được token/profile");
  assert.equal(fake.listCalls, 0, "dry-run không kéo cấu trúc");
  assert.equal(db.adsProfiles.length, 0);
  assert.equal(db.adsCampaigns.length, 0);
  assert.match(res.results[0].message, /dry-run/);
});

// ============================================================================
// 2. KÉO REPORT — luật trần tốc độ & trạng thái
// ============================================================================

test("ads-pull: xin report → poll → nhập; trạng thái report được ghi vào report_requests", async () => {
  const db = new MockDbAdapter();
  const fake = new FakeAds({
    statuses: ["PENDING", "COMPLETED"],
    text: campaignReport([
      { date: "2026-09-12", campaignId: "C-1", campaignName: "Vali 20 inch", cost: 12.5, clicks: 5, sales7d: 40, impressions: 900 },
    ]),
  });
  const res = await runAdsReportPull({ ...baseOpts(db, fake), kinds: ["campaigns"] });

  assert.equal(res.imported, 1);
  assert.equal(res.failed, 0);
  assert.equal(fake.created.length, 1);
  assert.equal(fake.created[0].reportTypeId, "spCampaigns");
  assert.equal(db.adsCampaignMetrics.length, 1);
  assert.equal(db.adsCampaignMetrics[0].cost, 12.5);
  assert.equal(db.adsCampaignMetrics[0].adsProfileId, "P-1");
  assert.equal(db.adsCampaignMetrics[0].currency, "USD");
  assert.equal(db.reportRequests.length, 1);
  assert.equal(db.reportRequests[0].status, "imported");
  assert.equal(db.reportRequests[0].reportType, "spCampaigns");
  assert.equal(db.reportRequests[0].rowsImported, 1);
});

test("ads-pull: report đang chạy → lần sau POLL ĐÚNG reportId đó (không xin report mới)", async () => {
  const db = new MockDbAdapter();
  const fake = new FakeAds({ statuses: ["PROCESSING", "PROCESSING"], text: "[]" });
  const first = await runAdsReportPull({ ...baseOpts(db, fake), kinds: ["campaigns"] });
  assert.equal(first.pending, 1);
  assert.equal(fake.created.length, 1);
  assert.equal(db.reportRequests[0].status, "in_progress");
  assert.equal(db.reportRequests[0].reportId, "R-1");

  // Lần chạy sau: Amazon đã xong → nhập, và TUYỆT ĐỐI không xin report mới.
  const fake2 = new FakeAds({
    statuses: ["COMPLETED"],
    text: campaignReport([{ date: "2026-09-12", campaignId: "C-1", cost: 3, clicks: 1 }]),
  });
  const second = await runAdsReportPull({ ...baseOpts(db, fake2), kinds: ["campaigns"] });
  assert.equal(second.imported, 1);
  assert.equal(fake2.created.length, 0, "phải poll report cũ, không tạo report mới");
  assert.equal(fake2.downloads[0], "R-1");
  assert.equal(db.adsCampaignMetrics.length, 1);
});

test("ads-pull: khoảng ngày đã nhập rồi → bỏ qua (không xin lại, không nhập lại)", async () => {
  const db = new MockDbAdapter();
  const text = campaignReport([{ date: "2026-09-12", campaignId: "C-1", cost: 5, clicks: 2 }]);
  const fake = new FakeAds({ statuses: ["COMPLETED"], text });
  await runAdsReportPull({ ...baseOpts(db, fake), kinds: ["campaigns"] });
  const second = await runAdsReportPull({ ...baseOpts(db, fake), kinds: ["campaigns"] });

  assert.equal(second.skipped, 1);
  assert.equal(second.imported, 0);
  assert.equal(fake.created.length, 1, "cùng khoảng ngày ⇒ không xin report mới");
  assert.equal(db.adsCampaignMetrics.length, 1);
  assert.match(second.outcomes[0].message, /đã NHẬP XONG|không có dữ liệu/);
});

test("ads-pull: report rỗng → no_data (không phải lỗi), và ghi trạng thái để lần sau biết", async () => {
  const db = new MockDbAdapter();
  const fake = new FakeAds({ statuses: ["COMPLETED"], text: "[]" });
  const res = await runAdsReportPull({ ...baseOpts(db, fake), kinds: ["campaigns"] });

  assert.equal(res.noData, 1);
  assert.equal(res.failed, 0);
  assert.equal(db.reportRequests[0].status, "no_data");
  assert.equal(db.reportRequests[0].rowsImported, 0);
  assert.match(res.outcomes[0].message, /bình thường/);
});

test("ads-pull: 429 → throttled (thử lại sau), KHÔNG phải needsReauth", async () => {
  const db = new MockDbAdapter();
  const rate = new AdsApiRequestError({ status: 429, code: "Throttling", message: "slow down" });
  const fake = new FakeAds({ throwOnCreate: rate });
  const res = await runAdsReportPull({ ...baseOpts(db, fake), kinds: ["campaigns"] });

  assert.equal(res.throttled, 1);
  assert.equal(res.outcomes[0].needsReauth, false);
  assert.match(res.outcomes[0].message, /trần tốc độ/);
});

test("ads-pull: 401 khi xin report → needsReauth=true (Module 0 phải authorize lại)", async () => {
  const db = new MockDbAdapter();
  const auth = new AdsApiRequestError({
    status: 401,
    code: "UnauthorizedException",
    message: "token hết hạn",
  });
  const fake = new FakeAds({ throwOnCreate: auth });
  const res = await runAdsReportPull({ ...baseOpts(db, fake), kinds: ["campaigns"] });

  assert.equal(res.failed, 1);
  assert.equal(res.outcomes[0].needsReauth, true);
  assert.match(res.outcomes[0].message, /re-authorize/);
  assert.equal(db.reportRequests[0].status, "failed");
});

test("ads-pull: Amazon FAILED → nói rõ nghi ngờ sai CỘT (lỗi hay gặp nhất của v3)", async () => {
  const db = new MockDbAdapter();
  const fake = new FakeAds({ statuses: ["FAILED"] });
  const res = await runAdsReportPull({ ...baseOpts(db, fake), kinds: ["campaigns"] });

  assert.equal(res.failed, 1);
  assert.match(res.outcomes[0].message, /cột|groupBy/);
  assert.equal(db.reportRequests[0].status, "failed");
  assert.match(String(db.reportRequests[0].lastError), /Invalid column/);
});

test("ads-pull: dry-run (chế độ file) không ghi dòng dữ liệu, không ghi trạng thái, không cảnh báo", async () => {
  const db = new MockDbAdapter();
  const fake = new FakeAds();
  const res = await runAdsReportPull({
    ...baseOpts(db, fake),
    kinds: ["campaigns"],
    dryRun: true,
    texts: {
      campaigns: campaignReport([
        { date: "2026-09-12", campaignId: "C-1", campaignName: "Vali", cost: 50, sales7d: 40, clicks: 20, campaignBudgetAmount: 20 },
      ]),
    },
  });

  assert.equal(res.outcomes[0].action, "dry_run");
  assert.equal(db.adsCampaignMetrics.length, 0);
  assert.equal(db.reportRequests.length, 0);
  assert.equal(db.alerts.length, 0);
  assert.equal(db.adsBudgetEvents.length, 0);
});

// ============================================================================
// 3. BƯỚC NGHIỆP VỤ SAU KHI NHẬP (điểm khác 0019)
// ============================================================================

test("ads-pull: ACOS vượt mục tiêu + ngân sách bị dùng hết → TỰ NỔ cảnh báo + sự kiện ngân sách", async () => {
  const db = new MockDbAdapter();
  const fake = new FakeAds();
  const res = await runAdsReportPull({
    ...baseOpts(db, fake),
    kinds: ["campaigns"],
    texts: {
      campaigns: campaignReport([
        // ACOS 7 ngày = 30/100 = 30% > 25% · click 12 ≥ 10 · chi 30 ≥ 5 ⇒ acos_over_target
        // Chi ngày mới nhất 30 / ngân sách 20 = 150% ≥ 95% ⇒ budget_exhausted + budget_events
        {
          date: "2026-09-12",
          campaignId: "C-1",
          campaignName: "Vali 20 inch",
          campaignBudgetAmount: 20,
          campaignBudgetCurrencyCode: "USD",
          cost: 30,
          clicks: 12,
          sales7d: 100,
        },
      ]),
    },
  });

  assert.equal(res.alertsFired, 2);
  assert.equal(db.alerts.length, 2);
  const rules = db.alerts.map((a) => a.ruleCode).sort();
  assert.deepEqual(rules, ["acos_over_target", "budget_exhausted"]);
  assert.equal(
    db.alerts.some((a) => a.title === "acos_over_target · C-1"),
    true,
    "tiêu đề cảnh báo phải CỐ ĐỊNH (có campaignId) để worker dedupe 24h",
  );
  assert.equal(
    db.alerts.some((a) => a.title === "budget_exhausted · C-1"),
    true,
  );
  assert.equal(db.adsBudgetEvents.length, 1);
  assert.equal(db.adsBudgetEvents[0].eventType, "capped");
  assert.equal(db.adsBudgetEvents[0].hourSource, "unavailable", "report v3 không có giờ ⇒ KHÔNG bịa giờ cạn");
});

test("ads-pull: campaign nhỏ (ít click, chi ít) KHÔNG cảnh báo ACOS — tránh nhiễu", async () => {
  const db = new MockDbAdapter();
  const fake = new FakeAds();
  const res = await runAdsReportPull({
    ...baseOpts(db, fake),
    kinds: ["campaigns"],
    texts: {
      campaigns: campaignReport([
        { date: "2026-09-12", campaignId: "C-9", campaignName: "Test nhỏ", cost: 2, clicks: 2, sales7d: 1 },
      ]),
    },
  });
  assert.equal(res.alertsFired, 0);
  assert.equal(db.alerts.length, 0);
});

test("ads-pull: bước cảnh báo không nhân đôi khi chạy lại cùng ngày", async () => {
  const db = new MockDbAdapter();
  const fake = new FakeAds();
  const text = campaignReport([
    { date: "2026-09-12", campaignId: "C-1", campaignName: "Vali", cost: 30, clicks: 12, sales7d: 100, campaignBudgetAmount: 20 },
  ]);
  await runAdsReportPull({ ...baseOpts(db, fake), kinds: ["campaigns"], texts: { campaigns: text } });
  const count1 = db.alerts.length;
  await runAdsReportPull({ ...baseOpts(db, fake), kinds: ["campaigns"], texts: { campaigns: text } });
  assert.equal(db.alerts.length, count1, "worker upsertAlert dedupe theo rule + title trong 24h");
});

// ============================================================================
// 4. ads_spend → F4 (TACOS)
// ============================================================================

test("ads-pull: report advertised-products lấp ads_spend cho dòng F4 đã có (không tạo dòng mới)", async () => {
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
  const res = await runAdsReportPull({
    ...baseOpts(db, fake),
    kinds: ["advertised-products"],
    texts: {
      "advertised-products": campaignReport([
        { date: "2026-09-12", campaignId: "C-1", adGroupId: "AG-1", advertisedSku: "SKU-1", advertisedAsin: "B08N5WRWNW", cost: 18.75 },
      ]),
    },
  });

  assert.equal(res.spendApplied, 1);
  assert.equal(db.skuProfit[0].adsSpend, 18.75);
  assert.equal(db.skuProfit.length, 1, "KHÔNG tạo dòng lợi nhuận mới — chỉ lấp cột ads_spend");
  assert.equal(db.adsAdvertisedProducts.length, 1);
});

test("ads-pull: SKU chưa có dòng F4 → bỏ qua và NÓI RÕ (không tự tạo số liệu)", async () => {
  const db = new MockDbAdapter();
  const fake = new FakeAds();
  const res = await runAdsReportPull({
    ...baseOpts(db, fake),
    kinds: ["advertised-products"],
    texts: {
      "advertised-products": campaignReport([
        { date: "2026-09-12", campaignId: "C-1", adGroupId: "AG-1", advertisedSku: "SKU-CHUA-CO", cost: 9 },
      ]),
    },
  });
  assert.equal(res.spendApplied, 0);
  assert.equal(db.skuProfit.length, 0);
  assert.ok(
    res.outcomes[0].warnings.some((w) => w.includes("ads_spend")),
    "phải cảnh báo rõ để người vận hành chạy F4 cho ngày đó",
  );
});

// ============================================================================
// 5. KHOẢNG NGÀY & NHẮC RE-AUTHORIZE (Module 0)
// ============================================================================

test("ads-pull: khoảng ngày mặc định = lookbackDays của spec, tính theo NGÀY (UTC)", () => {
  const p = computeAdsPeriod("campaigns", { now: NOW });
  assert.equal(p.end, "2026-09-13");
  assert.equal(p.start, "2026-08-14");
  const p7 = computeAdsPeriod("campaigns", { days: 7, now: NOW });
  assert.equal(p7.start, "2026-09-06");
});

test("oauth reminder: token còn ≤ notice_days → tạo cảnh báo oauth_reauth_due + đánh dấu đã nhắc", async () => {
  const db = new MockDbAdapter();
  await db.saveOauthToken(SHOP.id, {
    refreshToken: "Atzr|abc",
    authorizedAt: "2026-08-20T00:00:00.000Z",
    noticeDays: 30,
  });
  const res = await runOauthReminder({ db, now: NOW, log: () => {} }); // hết hạn 2027-08-20? -> không tới hạn

  // Mặc định token sống 365 ngày ⇒ chưa tới hạn nhắc.
  assert.equal(res.checked, 0);
  assert.equal(res.alertsCreated, 0);

  // Còn 10 ngày ⇒ phải nhắc.
  const soon = new MockDbAdapter();
  await soon.saveOauthToken(SHOP.id, {
    refreshToken: "Atzr|abc",
    expiresAt: "2026-09-23T00:00:00.000Z",
    noticeDays: 30,
  });
  const res2 = await runOauthReminder({ db: soon, now: NOW, log: () => {} });
  assert.equal(res2.checked, 1);
  assert.equal(res2.alertsCreated, 1);
  assert.equal(res2.marked, 1);
  assert.equal(soon.alerts[0].ruleCode, "oauth_reauth_due");
  // Số ngày làm tròn xuống theo giờ thực lúc chạy (mock đọc đồng hồ hệ thống)
  assert.match(String(soon.alerts[0].detail), /còn (9|10) ngày/);

  // Đã nhắc rồi ⇒ lần chạy sau KHÔNG nhắc lại (tránh spam mỗi ngày).
  const res3 = await runOauthReminder({ db: soon, now: NOW, log: () => {} });
  assert.equal(res3.alertsCreated, 0);
  assert.equal(res3.alreadyNoticed.length, 1);
});

test("oauth reminder: token ĐÃ hết hạn vẫn phải nhắc (đồng bộ đang dừng)", async () => {
  const db = new MockDbAdapter();
  await db.saveOauthToken(SHOP.id, {
    refreshToken: "Atzr|abc",
    expiresAt: "2026-09-01T00:00:00.000Z",
    noticeDays: 30,
  });
  const res = await runOauthReminder({ db, now: NOW, log: () => {} });
  assert.equal(res.expired.length, 1);
  assert.equal(res.alertsCreated, 1);
  assert.match(String(db.alerts[0].detail), /ĐÃ HẾT HẠN/);
});
