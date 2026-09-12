/**
 * Job đồng bộ Account Health (Module 7 — H1/H2).
 *
 *   Tầng 1 (realtime) notification ACCOUNT_STATUS_CHANGED → cập nhật ngay trạng thái
 *                     (xem notifications/account-health.handler.ts)
 *   Tầng 2 (hằng ngày) report GET_V2_SELLER_PERFORMANCE_REPORT (2h sáng) → snapshot
 *                     AHR + 6 chỉ số + 10 nhóm vi phạm (SOP-08)
 *
 * Vì sao KHÔNG dùng GET_V1_SELLER_PERFORMANCE_REPORT: V1 là XML Customer Metrics
 * (performanceChecklist, không có AHR/warningStates) — xem parser.
 *
 * Rate limit Reports API: 0.0222 rps · burst 10 (Amazon giữ report 72 giờ sau khi tạo).
 * Role cần: Selling Partner Insights (đã xin trong hồ sơ v1.1).
 */
import type {
  AccountHealthIssueRowInput,
  AccountHealthSnapshotRowInput,
  AlertRowInput,
  DbAdapter,
  SyncJobRecord,
} from "../db/adapter.ts";
import {
  evaluateShopHealth,
  healthAlerts,
  healthTaskDraft,
  type HealthIssue,
  type ShopHealth,
} from "../domain/account-health.ts";
import { parseSellerPerformanceReport, type ParsedRate } from "../reports/seller-performance.parser.ts";

export type AccountHealthSyncConfig = {
  reportType: "GET_V2_SELLER_PERFORMANCE_REPORT";
  deprecatedReportType: "GET_V1_SELLER_PERFORMANCE_REPORT";
  cron: string;
  /** Reports API v2021-06-30 */
  requestsPerSecond: number;
  burst: number;
  /** Amazon giữ report để tải trong 72 giờ */
  reportRetentionHours: number;
  /** SLA theo SOP-08 */
  slaHoursRed: number;
  slaHoursAmber: number;
};

export const DEFAULT_ACCOUNT_HEALTH_SYNC_CONFIG: AccountHealthSyncConfig = {
  reportType: "GET_V2_SELLER_PERFORMANCE_REPORT",
  deprecatedReportType: "GET_V1_SELLER_PERFORMANCE_REPORT",
  cron: "0 2 * * *",
  requestsPerSecond: 0.0222,
  burst: 10,
  reportRetentionHours: 72,
  slaHoursRed: 24,
  slaHoursAmber: 72,
};

export type AccountHealthSnapshot = {
  sellerAccountId: string;
  marketplaceId: string | null;
  accountStatus: string | null;
  ahrStatus: string | number | null;
  health: ShopHealth;
  snapshotRow: AccountHealthSnapshotRowInput;
  issueRows: AccountHealthIssueRowInput[];
  alerts: AlertRowInput[];
  taskDraft: { title: string; description: string; slaHours: number | null } | null;
  warnings: string[];
  reportId: string | null;
  source: "report" | "mock";
};

/** Các chỉ số cần đưa lên H1 (gộp afn/mfn của ODR thành 1 dòng — lấy mức xấu hơn). */
export function summarizeRates(rates: ParsedRate[]): {
  key: string;
  rate: number | null;
  status: string | null;
  targetValue: number | null;
  targetCondition: string | null;
  channel?: "afn" | "mfn";
}[] {
  const odr = rates.filter((r) => r.key === "orderDefectRate");
  const others = rates.filter((r) => r.key !== "orderDefectRate");

  const out = others.map((r) => ({
    key: r.key,
    rate: r.rate,
    status: r.status,
    targetValue: r.targetValue,
    targetCondition: r.targetCondition,
  }));

  if (odr.length > 0) {
    // FBA (afn) là kênh Amazon tự chịu trách nhiệm giao hàng → vẫn theo dõi,
    // nhưng khi tính ODR chung lấy mức CAO NHẤT (xấu nhất) giữa 2 kênh.
    const worst = odr.reduce((acc, r) => ((r.rate ?? -1) > (acc.rate ?? -1) ? r : acc), odr[0]);
    out.push({
      key: "orderDefectRate",
      rate: worst.rate,
      status: worst.status,
      targetValue: worst.targetValue,
      targetCondition: worst.targetCondition,
    });
  }
  return out;
}

/**
 * Dựng snapshot Account Health (thuần) từ nội dung report V2.
 * `reportJson` nhận cả JSON string (nội dung tải từ getReportDocument).
 */
export function buildAccountHealthSnapshot(input: {
  sellerAccountId: string;
  reportJson: string | unknown;
  marketplaceId?: string | null;
  reportId?: string | null;
  now?: Date;
}): AccountHealthSnapshot {
  const now = input.now ?? new Date();
  const parsed = parseSellerPerformanceReport(input.reportJson, { marketplaceId: input.marketplaceId ?? undefined });
  const marketplaceId = parsed.marketplaceId ?? input.marketplaceId ?? null;

  const statuses =
    parsed.accountStatuses.length > 0
      ? parsed.accountStatuses
      : [{ marketplaceId, status: null as string | null }];
  const accountStatus =
    statuses.find((s) => s.marketplaceId === marketplaceId)?.status ?? statuses[0]?.status ?? null;

  const rates = summarizeRates(parsed.rates);
  const issues: HealthIssue[] = parsed.issues;

  const health = evaluateShopHealth({
    accountStatus,
    ahrStatus: parsed.ahrStatus,
    rates,
    issues,
  });

  const snapshotRow: AccountHealthSnapshotRowInput = {
    sellerAccountId: input.sellerAccountId,
    day: now.toISOString().slice(0, 10),
    marketplaceId: marketplaceId ?? "unknown",
    accountStatus,
    ahrStatus: parsed.ahrStatus === null ? null : String(parsed.ahrStatus),
    tone: health.tone,
    score: health.score,
    rates: rates.map((r) => ({
      key: r.key,
      rate: r.rate,
      status: r.status,
      targetValue: r.targetValue,
      targetCondition: r.targetCondition,
      tone: health.rateTones.find((t) => t.key === r.key)?.tone ?? "unknown",
      targetSource: health.rateTones.find((t) => t.key === r.key)?.target?.source ?? null,
    })),
    issues: health.openIssues,
    sourceReportId: input.reportId ?? null,
    capturedAt: now,
  };

  const issueRows: AccountHealthIssueRowInput[] = issues.map((i) => ({
    sellerAccountId: input.sellerAccountId,
    marketplaceId: marketplaceId ?? "unknown",
    category: i.category,
    label: i.label,
    severity: i.severity,
    groupName: i.group,
    defectsCount: i.defectsCount,
    status: i.status,
    reportingFrom: i.reportingFrom,
    reportingTo: i.reportingTo,
  }));

  return {
    sellerAccountId: input.sellerAccountId,
    marketplaceId,
    accountStatus,
    ahrStatus: parsed.ahrStatus,
    health,
    snapshotRow,
    issueRows,
    alerts: healthAlerts({
      accountStatus,
      ahrStatus: parsed.ahrStatus,
      rates,
      issues,
    }),
    taskDraft: healthTaskDraft(marketplaceId ?? "shop", {
      accountStatus,
      ahrStatus: parsed.ahrStatus,
      rates,
      issues,
    }),
    warnings: [...parsed.warnings, ...parsed.unknownKeys.map((k) => `Khóa lạ trong report: ${k}`)],
    reportId: input.reportId ?? null,
    source: parsed.rates.length > 0 || parsed.accountStatuses.length > 0 ? "report" : "mock",
  };
}

/** Chạy thật: ghi account_health.snapshots + account_health.issues + alerts + sync_jobs. */
export async function runAccountHealthSync(
  input: {
    sellerAccountId: string;
    reportJson: string | unknown;
    marketplaceId?: string | null;
    reportId?: string | null;
    now?: Date;
  },
  adapter: DbAdapter,
): Promise<AccountHealthSnapshot & { job: SyncJobRecord }> {
  const now = input.now ?? new Date();
  const snapshot = buildAccountHealthSnapshot(input);

  const job: SyncJobRecord = {
    sellerAccountId: input.sellerAccountId,
    jobType: "account_health.sync",
    status: "running",
    startedAt: now,
    payload: {
      reportType: DEFAULT_ACCOUNT_HEALTH_SYNC_CONFIG.reportType,
      reportId: snapshot.reportId,
      marketplaceId: snapshot.marketplaceId,
      tone: snapshot.health.tone,
      score: snapshot.health.score,
    },
  };
  await adapter.recordSyncJob(job);

  try {
    await adapter.upsertAccountHealthSnapshot(snapshot.snapshotRow);
    for (const issue of snapshot.issueRows) await adapter.upsertAccountHealthIssue(issue);

    // Alert luôn phải gắn sellerAccountId — nếu thiếu, resolveAlerts() sẽ không
    // đóng được alert khi trạng thái về NORMAL (đã dính lỗi này ở bản đầu).
    for (const alert of snapshot.alerts) {
      await adapter.upsertAlert({
        sellerAccountId: input.sellerAccountId,
        ruleCode: alert.ruleCode,
        severity: alert.severity,
        title: alert.title,
        detail: alert.detail,
      });
    }

    // Trạng thái về NORMAL → tự đóng alert account_health đang mở (tránh alert treo)
    if (snapshot.accountStatus === "NORMAL") {
      await adapter.resolveAlerts({
        sellerAccountId: input.sellerAccountId,
        ruleCode: "account_health",
        note: "Amazon trả trạng thái NORMAL — tự đóng theo SOP-08",
        resolvedAt: now,
      });
    }

    job.status = "done";
    job.finishedAt = new Date();
    await adapter.recordSyncJob(job);
  } catch (e) {
    job.status = "failed";
    job.finishedAt = new Date();
    job.lastError = (e as Error).message;
    await adapter.recordSyncJob(job);
    throw e;
  }

  return { ...snapshot, job };
}
