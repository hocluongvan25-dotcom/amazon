/**
 * Test Module 7 — domain Account Health + parser report + job + notification.
 * Khoá: KHÔNG bao giờ coi "thiếu dữ liệu" là "khỏe"; ngưỡng lấy từ report trước,
 * fallback phải bị đánh dấu; vi phạm Critical leo thang red; SOP-08 SLA 24h.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MockDbAdapter } from "../src/db/adapter.ts";
import {
  AHR_BANDS,
  accountStatusTone,
  ahrTone,
  combineTones,
  escalationPlan,
  evaluateRate,
  evaluateShopHealth,
  healthAlerts,
  healthTaskDraft,
  issueSeverity,
  meetsTarget,
  normalizeMetricStatus,
  openIssues,
  targetLabel,
  violationMeta,
  worseTone,
} from "../src/domain/account-health.ts";
import {
  DEFAULT_ACCOUNT_HEALTH_SYNC_CONFIG,
  buildAccountHealthSnapshot,
  runAccountHealthSync,
  summarizeRates,
} from "../src/jobs/account-health-sync.job.ts";
import {
  parseSellerPerformanceReport,
  type SellerPerformanceParsed,
} from "../src/reports/seller-performance.parser.ts";
import {
  extractAccountStatusChange,
  handleAccountStatusChanged,
  isAccountStatusChanged,
} from "../src/notifications/account-health.handler.ts";

/* ============================================================================
 * Domain
 * ==========================================================================*/

describe("tông sức khỏe — gộp & so sánh", () => {
  test("worseTone lấy mức xấu hơn", () => {
    assert.equal(worseTone("green", "amber"), "amber");
    assert.equal(worseTone("red", "amber"), "red");
    assert.equal(worseTone("green", "green"), "green");
  });

  test("combineTones bỏ qua unknown, nhưng toàn unknown thì trả unknown", () => {
    assert.equal(combineTones(["green", "unknown"]), "green");
    assert.equal(combineTones(["unknown", "unknown"]), "unknown");
    assert.equal(combineTones(["green", "red"]), "red");
  });

  test("accountStatusTone map 3 giá trị hợp lệ, lạ → unknown", () => {
    assert.equal(accountStatusTone("NORMAL"), "green");
    assert.equal(accountStatusTone("at_risk"), "amber");
    assert.equal(accountStatusTone("DEACTIVATED"), "red");
    assert.equal(accountStatusTone("KHONG_BIET"), "unknown");
  });
});

describe("evaluateRate — ngưỡng của report > fallback; thiếu dữ liệu ≠ khỏe", () => {
  test("dùng status Amazon khi map được", () => {
    const r = evaluateRate({ key: "lateShipmentRate", rate: 3.1, status: "GOOD" });
    assert.equal(r.tone, "green");
    assert.match(r.note!, /status/);
  });

  test("dùng targetValue/targetCondition của report (ODR < 1%)", () => {
    const pass = evaluateRate({ key: "orderDefectRate", rate: 0.4, targetValue: 1, targetCondition: "lt" });
    assert.equal(pass.tone, "green");
    assert.equal(pass.target!.source, "report");
    assert.equal(pass.target!.label, "< 1%");

    const fail = evaluateRate({ key: "orderDefectRate", rate: 1.7, targetValue: 1, targetCondition: "lt" });
    assert.equal(fail.tone, "red");
  });

  test("sát ngưỡng (trong 10%) → amber để cảnh báo sớm", () => {
    const near = evaluateRate({ key: "orderDefectRate", rate: 0.95, targetValue: 1, targetCondition: "lt" });
    assert.equal(near.tone, "amber");
  });

  test("VTR là ngưỡng 'gt' (≥ 95%) — 92% là đỏ", () => {
    const bad = evaluateRate({ key: "validTrackingRate", rate: 92, targetValue: 95, targetCondition: "gt" });
    assert.equal(bad.tone, "red");
    const ok = evaluateRate({ key: "validTrackingRate", rate: 99.2, targetValue: 95, targetCondition: "gt" });
    assert.equal(ok.tone, "green");
  });

  test("thiếu targetValue → dùng ngưỡng fallback và ĐÁNH DẤU nguồn", () => {
    const r = evaluateRate({ key: "preFulfillmentCancellationRate", rate: 1.1 });
    assert.equal(r.target!.source, "fallback");
    assert.match(r.note!, /fallback/);
    assert.equal(r.tone, "green");
  });

  test("không có số → unknown (KHÔNG tự coi là xanh)", () => {
    assert.equal(evaluateRate({ key: "orderDefectRate", rate: null }).tone, "unknown");
  });

  test("meetsTarget/targetLabel đúng cả 4 comparator", () => {
    assert.equal(meetsTarget(1, 2, "lt"), true);
    assert.equal(meetsTarget(2, 2, "lte"), true);
    assert.equal(meetsTarget(2, 2, "lt"), false);
    assert.equal(meetsTarget(96, 95, "gt"), true);
    assert.equal(targetLabel(2.5, "lt"), "< 2.5%");
    assert.equal(targetLabel(95, "gte"), "≥ 95%");
  });

  test("normalizeMetricStatus map khoan dung + trả null với giá trị lạ", () => {
    assert.equal(normalizeMetricStatus("HEALTHY"), "green");
    assert.equal(normalizeMetricStatus("AT_RISK"), "amber");
    assert.equal(normalizeMetricStatus("NOT_MET"), "red");
    assert.equal(normalizeMetricStatus("gì đó mới"), null);
  });
});

describe("ahrTone — Account Health Rating", () => {
  test("thang số 0–1000", () => {
    assert.equal(ahrTone(850), "green");
    assert.equal(ahrTone(150), "amber");
    assert.equal(ahrTone(60), "red");
    assert.equal(AHR_BANDS.green, 200);
  });
  test("nhãn chuỗi", () => {
    assert.equal(ahrTone("GOOD"), "green");
    assert.equal(ahrTone("AT_RISK"), "amber");
    assert.equal(ahrTone("CRITICAL"), "red");
  });
  test("chưa có AHR → unknown; giá trị lạ → amber (fail-safe, không hiện xanh)", () => {
    assert.equal(ahrTone(null), "unknown");
    assert.equal(ahrTone("điểm mới của Amazon"), "amber");
  });
});

describe("vi phạm — severity & danh sách mở", () => {
  test("nhóm IP/hàng giả mặc định Critical", () => {
    assert.equal(violationMeta("receivedIntellectualPropertyComplaints").severity, "Critical");
    assert.equal(violationMeta("receivedIntellectualPropertyComplaints").group, "ip");
    assert.equal(violationMeta("listingPolicyViolations").group, "restricted");
  });

  test("defectsCount ≥ 3 nâng severity 1 mức (tối đa Critical)", () => {
    assert.equal(issueSeverity("otherPolicyViolations", 0), "Medium");
    assert.equal(issueSeverity("otherPolicyViolations", 3), "High");
    assert.equal(issueSeverity("receivedIntellectualPropertyComplaints", 5), "Critical");
  });

  test("openIssues chỉ giữ vi phạm thật, xếp nghiêm trọng lên trước", () => {
    const issues = [
      { category: "otherPolicyViolations", label: "x", severity: "Medium" as const, group: "other", defectsCount: 0, status: null, targetValue: null, targetCondition: null, reportingFrom: null, reportingTo: null },
      { category: "receivedIntellectualPropertyComplaints", label: "y", severity: "Critical" as const, group: "ip", defectsCount: 2, status: null, targetValue: null, targetCondition: null, reportingFrom: null, reportingTo: null },
      { category: "listingPolicyViolations", label: "z", severity: "High" as const, group: "restricted", defectsCount: 0, status: "AT_RISK", targetValue: null, targetCondition: null, reportingFrom: null, reportingTo: null },
    ];
    const open = openIssues(issues);
    assert.deepEqual(open.map((i) => i.category), [
      "receivedIntellectualPropertyComplaints",
      "listingPolicyViolations",
    ]);
  });
});

describe("evaluateShopHealth — điểm & tông tổng hợp", () => {
  test("shop khỏe: ODR thấp, AHR tốt, không vi phạm → green, điểm cao", () => {
    const health = evaluateShopHealth({
      accountStatus: "NORMAL",
      ahrStatus: "GOOD",
      rates: [
        { key: "orderDefectRate", rate: 0.3, targetValue: 1, targetCondition: "lt" },
        { key: "validTrackingRate", rate: 99, targetValue: 95, targetCondition: "gt" },
      ],
      issues: [],
    });
    assert.equal(health.tone, "green");
    assert.equal(health.score, 100);
    assert.equal(health.criticalIssues, 0);
  });

  test("ODR vượt ngưỡng + vi phạm Critical → red, điểm trừ mạnh", () => {
    const health = evaluateShopHealth({
      accountStatus: "NORMAL",
      ahrStatus: 150,
      rates: [{ key: "orderDefectRate", rate: 2.4, targetValue: 1, targetCondition: "lt" }],
      issues: [
        { category: "receivedIntellectualPropertyComplaints", label: "IP", severity: "Critical", group: "ip", defectsCount: 3, status: null, targetValue: null, targetCondition: null, reportingFrom: null, reportingTo: null },
      ],
    });
    assert.equal(health.tone, "red");
    assert.equal(health.criticalIssues, 1);
    assert.equal(health.score < 60, true);
    assert.match(health.summary, /1 vi phạm mở \(1 nghiêm trọng\)/);
  });

  test("DEACTIVATED luôn red dù các chỉ số khác đẹp", () => {
    const health = evaluateShopHealth({
      accountStatus: "DEACTIVATED",
      ahrStatus: "GOOD",
      rates: [{ key: "orderDefectRate", rate: 0.1, targetValue: 1, targetCondition: "lt" }],
      issues: [],
    });
    assert.equal(health.tone, "red");
  });
});

describe("escalationPlan / healthTaskDraft — SOP-08", () => {
  const redShop = {
    accountStatus: "DEACTIVATED" as string | null,
    ahrStatus: null,
    rates: [],
    issues: [],
  };

  test("red → SLA 24h, chủ trì Vận hành & Account Health", () => {
    const plan = escalationPlan(evaluateShopHealth(redShop));
    assert.equal(plan.sop, "SOP-08");
    assert.equal(plan.slaHours, 24);
    assert.match(plan.owner, /Vận hành/);
    assert.equal(plan.steps.length, 5);
  });

  test("green → không mở task", () => {
    const draft = healthTaskDraft("P1 · US", {
      accountStatus: "NORMAL",
      ahrStatus: "GOOD",
      rates: [{ key: "orderDefectRate", rate: 0.2, targetValue: 1, targetCondition: "lt" }],
      issues: [],
    });
    assert.equal(draft, null);
  });

  test("red → nháp task có SLA + nội dung bước", () => {
    const draft = healthTaskDraft("P1 · US", redShop)!;
    assert.match(draft.title, /SOP-08/);
    assert.equal(draft.slaHours, 24);
    assert.match(draft.description, /Nộp appeal/);
  });
});

describe("healthAlerts — rule_code phải khớp ops.alert_rules", () => {
  test("DEACTIVATED → alert account_health mức red", () => {
    const alerts = healthAlerts({ accountStatus: "DEACTIVATED", ahrStatus: null, rates: [], issues: [] });
    assert.equal(alerts[0].ruleCode, "account_health");
    assert.equal(alerts[0].severity, "red");
    assert.match(alerts[0].title, /DEACTIVATED/);
  });

  test("ODR vượt ngưỡng → alert odr_threshold nêu cả nguồn ngưỡng", () => {
    const alerts = healthAlerts({
      accountStatus: "NORMAL",
      ahrStatus: "GOOD",
      rates: [{ key: "orderDefectRate", rate: 1.4 }],
      issues: [],
    });
    const odr = alerts.find((a) => a.ruleCode === "odr_threshold")!;
    assert.equal(odr.severity, "red");
    assert.match(odr.detail, /ngưỡng fallback/);
  });

  test("shop khỏe → không alert", () => {
    const alerts = healthAlerts({
      accountStatus: "NORMAL",
      ahrStatus: "GOOD",
      rates: [{ key: "orderDefectRate", rate: 0.2, targetValue: 1, targetCondition: "lt" }],
      issues: [],
    });
    assert.equal(alerts.length, 0);
  });
});

/* ============================================================================
 * Parser report V2
 * ==========================================================================*/

const REPORT = {
  accountStatuses: [{ marketplaceId: "ATVPDKIKX0DER", status: "AT_RISK" }],
  performanceMetrics: [
    {
      marketplaceId: "ATVPDKIKX0DER",
      lateShipmentRate: {
        reportingDateRange: { reportingDateFrom: "2026-08-10", reportingDateTo: "2026-09-09" },
        status: "AT_RISK",
        targetValue: 4,
        targetCondition: "lt",
        orderCount: 320,
        lateShipmentCount: 15,
        rate: 4.7,
      },
      orderDefectRate: {
        afn: { status: "GOOD", targetValue: 1, targetCondition: "lt", orderCount: { rate: 0.2, count: 180 }, claims: { status: "GOOD", count: 0 } },
        mfn: { status: "AT_RISK", targetValue: 1, targetCondition: "lt", orderCount: { rate: 1.4, count: 140 }, claims: { status: "AT_RISK", count: 2 } },
      },
      validTrackingRate: {
        reportingDateRange: { reportingDateFrom: "2026-08-10", reportingDateTo: "2026-09-09" },
        status: "GOOD",
        targetValue: 95,
        targetCondition: "gt",
        shipmentCount: 140,
        validTrackingCount: 138,
        rate: 98.6,
      },
      warningStates: {
        accountHealthRating: { ahrStatus: "FAIR", reportingDateRange: { reportingDateFrom: "2026-08-10", reportingDateTo: "2026-09-09" } },
        listingPolicyViolations: { status: "AT_RISK", defectsCount: 2, targetValue: 0, targetCondition: "lte" },
        receivedIntellectualPropertyComplaints: { status: "AT_RISK", defectsCount: 1 },
        otherPolicyViolations: { defectsCount: 0 },
      },
    },
  ],
};

describe("parseSellerPerformanceReport (GET_V2_SELLER_PERFORMANCE_REPORT)", () => {
  const parsed: SellerPerformanceParsed = parseSellerPerformanceReport(JSON.stringify(REPORT));

  test("đọc accountStatuses + AHR", () => {
    assert.deepEqual(parsed.accountStatuses, [{ marketplaceId: "ATVPDKIKX0DER", status: "AT_RISK" }]);
    assert.equal(parsed.ahrStatus, "FAIR");
    assert.equal(parsed.marketplaceId, "ATVPDKIKX0DER");
  });

  test("đọc 6 chỉ số cấp cao + tách ODR afn/mfn", () => {
    const keys = parsed.rates.map((r) => r.key);
    assert.equal(keys.filter((k) => k === "orderDefectRate").length, 2);
    assert.equal(keys.includes("lateShipmentRate"), true);
    assert.equal(keys.includes("validTrackingRate"), true);
    const mfn = parsed.rates.filter((r) => r.key === "orderDefectRate" && r.counters.channel === 0)[0];
    assert.equal(mfn.rate, 1.4);
    assert.equal(mfn.status, "AT_RISK");
  });

  test("đọc warningStates thành issues + severity theo số lỗi", () => {
    const ip = parsed.issues.find((i) => i.category === "receivedIntellectualPropertyComplaints")!;
    assert.equal(ip.defectsCount, 1);
    assert.equal(ip.severity, "Critical");
    const other = parsed.issues.find((i) => i.category === "otherPolicyViolations")!;
    assert.equal(other.defectsCount, 0);
  });

  test("nhận cả object (không chỉ JSON string) và bóc lớp payload", () => {
    const wrapped = parseSellerPerformanceReport({ payload: REPORT });
    assert.equal(wrapped.rates.length > 0, true);
  });

  test("chọn đúng marketplace khi report có nhiều marketplace", () => {
    const multi = {
      ...REPORT,
      performanceMetrics: [
        REPORT.performanceMetrics[0],
        { ...REPORT.performanceMetrics[0], marketplaceId: "A2EUQ1WTGCTBG2", lateShipmentRate: { rate: 0.5, targetValue: 4, targetCondition: "lt" } },
      ],
    };
    const ca = parseSellerPerformanceReport(multi, { marketplaceId: "A2EUQ1WTGCTBG2" });
    assert.equal(ca.marketplaceId, "A2EUQ1WTGCTBG2");
    assert.equal(ca.rates.find((r) => r.key === "lateShipmentRate")!.rate, 0.5);
  });

  test("JSON hỏng / rỗng → warnings, không throw", () => {
    assert.match(parseSellerPerformanceReport("{khong-phai-json").warnings[0], /không phải JSON/);
    assert.match(parseSellerPerformanceReport("").warnings[0], /rỗng/);
  });

  test("khóa lạ trong warningStates được giữ lại + báo", () => {
    const p = parseSellerPerformanceReport({
      accountStatuses: [],
      performanceMetrics: [{ warningStates: { brandNewViolationType: { defectsCount: 5 } } }],
    });
    assert.equal(p.issues.some((i) => i.category === "brandNewViolationType"), true);
    assert.equal(p.unknownKeys.includes("warningStates.brandNewViolationType"), true);
  });

  test("report V1 (không có warningStates/status) → cảnh báo rõ", () => {
    const v1ish = parseSellerPerformanceReport({ orderDefectRate: { orderCount: 100 } });
    assert.match(v1ish.warnings.join(" "), /warningStates/);
    assert.match(v1ish.warnings.join(" "), /accountStatuses/);
  });
});

/* ============================================================================
 * Job + handler
 * ==========================================================================*/

describe("summarizeRates — gộp ODR afn/mfn cho H1", () => {
  test("lấy mức xấu hơn giữa 2 kênh", () => {
    const rates = summarizeRates([
      { key: "orderDefectRate", rate: 0.2, status: "GOOD", targetValue: 1, targetCondition: "lt", reportingFrom: null, reportingTo: null, counters: { channel: 1 } },
      { key: "orderDefectRate", rate: 1.4, status: "AT_RISK", targetValue: 1, targetCondition: "lt", reportingFrom: null, reportingTo: null, counters: { channel: 0 } },
      { key: "validTrackingRate", rate: 98.6, status: "GOOD", targetValue: 95, targetCondition: "gt", reportingFrom: null, reportingTo: null, counters: {} },
    ]);
    assert.equal(rates.filter((r) => r.key === "orderDefectRate").length, 1);
    assert.equal(rates.find((r) => r.key === "orderDefectRate")!.rate, 1.4);
    assert.equal(rates.length, 2);
  });
});

describe("buildAccountHealthSnapshot / runAccountHealthSync", () => {
  const NOW = new Date("2026-09-10T02:00:00Z");

  test("snapshot: trạng thái AT_RISK + AHR FAIR + 2 vi phạm → tone amber/red đúng dữ liệu", () => {
    const snap = buildAccountHealthSnapshot({
      sellerAccountId: "shop-1",
      reportJson: JSON.stringify(REPORT),
      marketplaceId: "ATVPDKIKX0DER",
      reportId: "report-1",
      now: NOW,
    });

    assert.equal(snap.accountStatus, "AT_RISK");
    assert.equal(snap.ahrStatus, "FAIR");
    assert.equal(snap.snapshotRow.day, "2026-09-10");
    assert.equal(snap.snapshotRow.marketplaceId, "ATVPDKIKX0DER");
    assert.equal(snap.snapshotRow.sourceReportId, "report-1");
    assert.equal(snap.issueRows.length, 3); // listingPolicy, IP, otherPolicy
    assert.equal(snap.health.tone === "red" || snap.health.tone === "amber", true);

    // ngưỡng của report phải được ghi kèm nguồn "report", không dùng fallback
    const odr = (snap.snapshotRow.rates as { key: string; targetSource: string | null }[]).find((r) => r.key === "orderDefectRate")!;
    assert.equal(odr.targetSource, "report");
  });

  test("ghi DB: snapshot + issues + alert + tự đóng alert khi NORMAL", async () => {
    const db = new MockDbAdapter();
    await runAccountHealthSync(
      { sellerAccountId: "shop-1", reportJson: JSON.stringify(REPORT), marketplaceId: "ATVPDKIKX0DER", reportId: "r1", now: NOW },
      db,
    );
    assert.equal(db.healthSnapshots.length, 1);
    assert.equal(db.healthIssues.length, 3);
    assert.equal(db.alerts.length > 0, true);
    assert.equal(db.jobs.at(-1)!.jobType, "account_health.sync");
    assert.equal(db.jobs.at(-1)!.status, "done");

    // Import lại lần 2 → upsert, không nhân đôi
    await runAccountHealthSync(
      { sellerAccountId: "shop-1", reportJson: JSON.stringify(REPORT), marketplaceId: "ATVPDKIKX0DER", reportId: "r2", now: NOW },
      db,
    );
    assert.equal(db.healthSnapshots.length, 1);
    assert.equal(db.healthIssues.length, 3);

    // Report NORMAL → tự đóng alert account_health đang mở
    const healthyReport = { accountStatuses: [{ marketplaceId: "ATVPDKIKX0DER", status: "NORMAL" }], performanceMetrics: [] };
    await runAccountHealthSync(
      { sellerAccountId: "shop-1", reportJson: healthyReport, marketplaceId: "ATVPDKIKX0DER", now: NOW },
      db,
    );
    const openAccountHealth = db.alerts.filter((a) => a.ruleCode === "account_health" && !a.resolvedAt);
    assert.equal(openAccountHealth.length, 0);
  });
});

describe("ACCOUNT_STATUS_CHANGED handler", () => {
  const notif = {
    notificationVersion: "1.0",
    notificationType: "ACCOUNT_STATUS_CHANGED",
    payloadVersion: "2021-01-01",
    eventTime: "2026-09-10T09:00:00.000Z",
    payload: { accountStatusChangeNotification: { previousAccountStatus: "NORMAL", currentAccountStatus: "AT_RISK" } },
  };

  test("nhận diện + bóc payload (camelCase)", () => {
    assert.equal(isAccountStatusChanged(notif), true);
    assert.deepEqual(extractAccountStatusChange(notif), {
      previousAccountStatus: "NORMAL",
      currentAccountStatus: "AT_RISK",
    });
  });

  test("nhận cả PascalCase (Amazon gửi qua EventBridge)", () => {
    const pascal = {
      NotificationType: "ACCOUNT_STATUS_CHANGED",
      Payload: { AccountStatusChangedNotification: { PreviousAccountStatus: "AT_RISK", CurrentAccountStatus: "DEACTIVATED" } },
    };
    // Amazon dùng camelCase trong payload kể cả khi envelope PascalCase → vẫn phải nhận
    const pascal2 = {
      NotificationType: "ACCOUNT_STATUS_CHANGED",
      Payload: { AccountStatusChangedNotification: { previousAccountStatus: "AT_RISK", currentAccountStatus: "DEACTIVATED" } },
    };
    assert.equal(isAccountStatusChanged(pascal2), true);
    assert.equal(isAccountStatusChanged(pascal), false); // khóa sai casing → không đoán
  });

  test("giá trị không hợp lệ → bỏ qua", () => {
    assert.equal(
      isAccountStatusChanged({ notificationType: "ACCOUNT_STATUS_CHANGED", payload: { accountStatusChangeNotification: { currentAccountStatus: "SUSPENDED" } } }),
      false,
    );
  });

  test("DEACTIVATED → alert đỏ ngay (SOP-08 khẩn)", async () => {
    const db = new MockDbAdapter();
    const res = await handleAccountStatusChanged(
      { notificationType: "ACCOUNT_STATUS_CHANGED", payload: { accountStatusChangeNotification: { previousAccountStatus: "AT_RISK", currentAccountStatus: "DEACTIVATED" } } },
      db,
      { sellerAccountId: "shop-1", marketplaceId: "ATVPDKIKX0DER", now: new Date("2026-09-10T09:00:00Z") },
    );
    assert.equal(res!.currentStatus, "DEACTIVATED");
    assert.equal(res!.tone, "red");
    assert.equal(res!.alertCreated, true);
    assert.equal(db.alerts[0].severity, "red");
    assert.equal(db.healthSnapshots[0].accountStatus, "DEACTIVATED");
    assert.equal(db.notifications[0].notificationType, "ACCOUNT_STATUS_CHANGED");
  });

  test("về NORMAL → tự đóng alert (không để alert treo)", async () => {
    const db = new MockDbAdapter();
    await handleAccountStatusChanged(
      { notificationType: "ACCOUNT_STATUS_CHANGED", payload: { accountStatusChangeNotification: { currentAccountStatus: "AT_RISK" } } },
      db,
      { sellerAccountId: "shop-1", marketplaceId: "ATVPDKIKX0DER" },
    );
    assert.equal(db.alerts.filter((a) => !a.resolvedAt).length, 1);

    const res = await handleAccountStatusChanged(
      { notificationType: "ACCOUNT_STATUS_CHANGED", payload: { accountStatusChangeNotification: { previousAccountStatus: "AT_RISK", currentAccountStatus: "NORMAL" } } },
      db,
      { sellerAccountId: "shop-1", marketplaceId: "ATVPDKIKX0DER" },
    );
    assert.equal(res!.alertsResolved, true);
    assert.equal(db.alerts.filter((a) => !a.resolvedAt).length, 0);
  });

  test("cấu hình job bám đúng report V2 (không phải V1 XML) + Reports API rate", () => {
    assert.equal(DEFAULT_ACCOUNT_HEALTH_SYNC_CONFIG.reportType, "GET_V2_SELLER_PERFORMANCE_REPORT");
    assert.equal(DEFAULT_ACCOUNT_HEALTH_SYNC_CONFIG.deprecatedReportType, "GET_V1_SELLER_PERFORMANCE_REPORT");
    assert.equal(DEFAULT_ACCOUNT_HEALTH_SYNC_CONFIG.requestsPerSecond, 0.0222);
    assert.equal(DEFAULT_ACCOUNT_HEALTH_SYNC_CONFIG.reportRetentionHours, 72);
    assert.equal(DEFAULT_ACCOUNT_HEALTH_SYNC_CONFIG.slaHoursRed, 24);
  });
});
