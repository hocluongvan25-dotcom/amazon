/**
 * Test cho 2 bug màn Module 0 · Sync health báo:
 *
 *   1. sync_jobs MỒ CÔI: mỗi lần chạy inventory.pull tạo ra MỘT dòng "running"
 *      và MỘT dòng "done" riêng biệt (caller không dùng lại object job đã có
 *      id) → danh sách "Job đồng bộ gần nhất" đầy dòng running không bao giờ
 *      kết thúc dù job đã xong.
 *
 *   2. report_requests "CHỜ QUÁ LÂU" vĩnh viễn: kỳ dữ liệu (data_start/end)
 *      trượt theo `now` mỗi ngày → dòng "Amazon đang xếp hàng" của kỳ HÔM QUA
 *      không bao giờ được poll lại (samePeriod không khớp, cooldown đã qua)
 *      và cũng không ai đóng nó → tuổi tăng mãi (1478 phút...).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { MockDbAdapter } from "../src/lib/worker/db/adapter.ts";
import { runInventorySyncAll } from "../src/lib/worker/run-inventory-sync.ts";
import { runReportPull } from "../src/lib/worker/jobs/report-pull.job.ts";
import { runAdsReportPull } from "../src/lib/worker/jobs/ads-report-pull.job.ts";

const SHOP = {
  id: "00000000-0000-0000-0000-00000000s001",
  sellerId: "SELLER1",
  marketplace: "ATVPDKIKX0DER",
  displayName: "Shop test",
  leadDays: 32,
  safetyDays: 14,
};

/* ============================================================================
 * 1. sync_jobs: một lần chạy = MỘT dòng, running → done (không mồ côi)
 * ==========================================================================*/

test("inventory-sync: job running được CHUYỂN thành done trên cùng một dòng (không mồ côi)", async () => {
  let mock: MockDbAdapter | null = null;
  await runInventorySyncAll({
    seedMockData: (db) => {
      mock = db;
    },
  });
  assert.ok(mock, "phải chạy demo mode với MockDbAdapter trong test env");
  const jobs = (mock as MockDbAdapter).jobs.filter((j) => j.jobType === "inventory.pull");
  assert.equal(jobs.length, 1, `một shop một lần chạy = MỘT dòng sync_jobs, got ${jobs.length}`);
  assert.equal(jobs[0].status, "done");
  assert.ok(jobs[0].finishedAt, "dòng done phải có finished_at");
  // KHÔNG còn dòng "running" nào sót lại
  assert.equal(
    (mock as MockDbAdapter).jobs.filter((j) => j.status === "running").length,
    0,
    "không được để dòng running mồ côi",
  );
});

test("MockDbAdapter.recordSyncJob: mô phỏng đúng Supabase — có id thì UPDATE, không INSERT thêm", async () => {
  const db = new MockDbAdapter();
  const job: import("../src/lib/worker/db/adapter.ts").SyncJobRecord = {
    sellerAccountId: SHOP.id,
    jobType: "inventory.pull",
    status: "running",
    startedAt: new Date(),
  };
  await db.recordSyncJob(job);
  assert.ok(job.id, "lần đầu phải gán id (như POST return=representation)");
  job.status = "done";
  await db.recordSyncJob(job);
  assert.equal(db.jobs.length, 1, "lần hai phải PATCH đúng dòng cũ");
  assert.equal(db.jobs[0].status, "done");
});

/* ============================================================================
 * 2. report_requests kỳ cũ treo quá 24h → tự đóng (cancelled), hết "CHỜ QUÁ LÂU"
 * ==========================================================================*/

test("report-pull FBA: dòng kỳ CŨ treo in_queue > 24h bị đóng thành cancelled", async () => {
  const db = new MockDbAdapter();
  const now = new Date("2026-09-14T03:00:00Z");
  // Kỳ HÔM QUA đang "Amazon đang xếp hàng" từ 25 giờ trước (cron hôm qua tạo).
  await db.setReportRequest(SHOP.id, {
    reportType: "GET_LEDGER_SUMMARY_VIEW_DATA",
    marketplaceId: SHOP.marketplace,
    dataStart: "2026-09-13",
    dataEnd: "2026-09-13",
    reportId: "old-report-1",
    status: "in_queue",
    requestedAt: new Date(now.getTime() - 25 * 3600_000).toISOString(),
  });

  // Cron hôm nay: client giả — kỳ MỚI xin report và Amazon vẫn đang tạo.
  const client = {
    createReport: async () => ({ reportId: "new-report-1" }),
    getReport: async () => ({ reportId: "new-report-1", processingStatus: "IN_QUEUE" }),
    fetchReportContent: async () => ({ text: null, documentId: null, gzipped: false, bytes: 0, info: { processingStatus: "IN_QUEUE" } }),
  };
  await runReportPull({
    db,
    shops: [SHOP],
    kinds: ["fc"],
    now,
    pollAttempts: 1,
    pollDelayMs: 0,
    sleep: async () => {},
    clientFor: () => client as never,
  });

  const rows = await db.listReportRequests(SHOP.id, { reportType: "GET_LEDGER_SUMMARY_VIEW_DATA" });
  const old = rows.find((r) => r.dataStart === "2026-09-13" && r.dataEnd === "2026-09-13");
  assert.ok(old, "dòng kỳ cũ vẫn phải còn trong nhật ký");
  assert.equal(old?.status, "cancelled", "kỳ cũ treo >24h phải bị đóng (cancelled)");
  assert.match(old?.lastError ?? "", /bỏ cuộc sau \d+ giờ/);
});

test("report-pull FBA: dòng kỳ cũ treo MỚI 2 giờ thì KHÔNG bị đóng (còn được poll tiếp)", async () => {
  const db = new MockDbAdapter();
  const now = new Date("2026-09-14T03:00:00Z");
  await db.setReportRequest(SHOP.id, {
    reportType: "GET_LEDGER_SUMMARY_VIEW_DATA",
    marketplaceId: SHOP.marketplace,
    dataStart: "2026-09-13",
    dataEnd: "2026-09-13",
    reportId: "recent-report-1",
    status: "in_queue",
    requestedAt: new Date(now.getTime() - 2 * 3600_000).toISOString(),
  });
  const client = {
    createReport: async () => ({ reportId: "unused" }),
    getReport: async () => ({ reportId: "recent-report-1", processingStatus: "IN_QUEUE" }),
    fetchReportContent: async () => ({ text: null, documentId: null, gzipped: false, bytes: 0, info: { processingStatus: "IN_QUEUE" } }),
  };
  await runReportPull({
    db,
    shops: [SHOP],
    kinds: ["fc"],
    now,
    pollAttempts: 1,
    pollDelayMs: 0,
    sleep: async () => {},
    clientFor: () => client as never,
  });
  const rows = await db.listReportRequests(SHOP.id, { reportType: "GET_LEDGER_SUMMARY_VIEW_DATA" });
  const recent = rows.find((r) => r.reportId === "recent-report-1");
  assert.notEqual(recent?.status, "cancelled", "2 giờ chưa phải bỏ cuộc — trong cooldown còn poll tiếp");
});

test("ads-report-pull: dòng kỳ cũ treo requested > 24h cũng bị đóng thành cancelled", async () => {
  const db = new MockDbAdapter();
  const now = new Date("2026-09-14T03:00:00Z");
  await db.setReportRequest(SHOP.id, {
    reportType: "spCampaigns",
    marketplaceId: SHOP.marketplace,
    dataStart: "2026-08-14",
    dataEnd: "2026-09-13",
    reportId: "ads-old-1",
    status: "requested",
    requestedAt: new Date(now.getTime() - 30 * 3600_000).toISOString(),
  });
  const client = {
    createReport: async () => ({ reportId: "ads-new-1" }),
    getReport: async () => ({ reportId: "ads-new-1", status: "PENDING", url: null, failureReason: null }),
    downloadReport: async () => "",
  };
  await runAdsReportPull({
    db,
    shops: [SHOP],
    kinds: ["campaigns"],
    now,
    pollAttempts: 1,
    pollDelayMs: 0,
    sleep: async () => {},
    clientFor: () => client as never,
    adsProfileFor: () => ({ adsProfileId: "123", currency: "USD" }),
  });
  const rows = await db.listReportRequests(SHOP.id, { reportType: "spCampaigns" });
  const old = rows.find((r) => r.reportId === "ads-old-1");
  assert.equal(old?.status, "cancelled", "kỳ Ads cũ treo >24h phải bị đóng");
});
