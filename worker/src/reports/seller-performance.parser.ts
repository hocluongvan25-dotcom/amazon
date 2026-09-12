/**
 * Parser report GET_V2_SELLER_PERFORMANCE_REPORT (Seller Performance Report).
 *
 * Cấu trúc do Amazon công bố (developer-docs.amazon.com/sp-api/docs/report-type-values-performance):
 *   accountStatuses: [{ marketplaceId, status }]
 *   performanceMetrics: [{
 *     marketplaceId,
 *     lateShipmentRate / invoiceDefectRate / onTimeDeliveryRate / unitOnTimeDeliveryRate /
 *     validTrackingRate / preFulfillmentCancellationRate:
 *        { reportingDateRange{reportingDateFrom, reportingDateTo}, status, targetValue,
 *          targetCondition, orderCount, rate }
 *     orderDefectRate: { afn: {...}, mfn: {...} }
 *     warningStates: {
 *       accountHealthRating: { ahrStatus, reportingDateRange }
 *       listingPolicyViolations / productAuthenticityCustomerComplaints /
 *       productConditionCustomerComplaints / productSafetyCustomerComplaints /
 *       receivedIntellectualPropertyComplaints / restrictedProductPolicyViolations /
 *       suspectedIntellectualPropertyViolations / foodAndProductSafetyIssues /
 *       customerProductReviewsPolicyViolations / otherPolicyViolations /
 *       documentRequests: { reportingDateRange, status, targetValue, targetCondition, defectsCount }
 *     }
 *   }]
 *
 * Vì sao KHÔNG dùng GET_V1_SELLER_PERFORMANCE_REPORT: bản V1 là "XML Customer Metrics
 * Report" (performanceChecklist/orderDefectRate dạng XML) — thiếu warningStates/AHR và
 * phải parse XML. V2 là bản Account Health dashboard dùng hiện hành.
 *
 * Parser KHOAN DUNG có chủ đích: Amazon thêm/bớt khóa giữa các kỳ report → khóa lạ
 * không bị nuốt, được đưa vào `unknownKeys` (cảnh báo) để không mất dữ liệu.
 */
import type { HealthIssue } from "../domain/account-health.ts";
import { issueSeverity, violationMeta } from "../domain/account-health.ts";

export type ParsedRate = {
  key: string;
  rate: number | null;
  status: string | null;
  targetValue: number | null;
  targetCondition: string | null;
  reportingFrom: string | null;
  reportingTo: string | null;
  /** số đếm kèm chỉ số (orderCount, lateShipmentCount, defects…) để drill-down */
  counters: Record<string, number>;
};

export type ParsedAccountStatus = { marketplaceId: string | null; status: string | null };

export type SellerPerformanceParsed = {
  marketplaceId: string | null;
  accountStatuses: ParsedAccountStatus[];
  ahrStatus: string | number | null;
  rates: ParsedRate[];
  issues: HealthIssue[];
  unknownKeys: string[];
  warnings: string[];
};

/** Chỉ số cấp cao nhất trong performanceMetrics (ngoài orderDefectRate có afn/mfn). */
const RATE_KEYS = [
  "lateShipmentRate",
  "invoiceDefectRate",
  "onTimeDeliveryRate",
  "unitOnTimeDeliveryRate",
  "validTrackingRate",
  "preFulfillmentCancellationRate",
] as const;

/** Khóa trong warningStates (10 nhóm + accountHealthRating + documentRequests). */
const WARNING_KEYS = [
  "listingPolicyViolations",
  "productAuthenticityCustomerComplaints",
  "productConditionCustomerComplaints",
  "productSafetyCustomerComplaints",
  "receivedIntellectualPropertyComplaints",
  "restrictedProductPolicyViolations",
  "suspectedIntellectualPropertyViolations",
  "foodAndProductSafetyIssues",
  "customerProductReviewsPolicyViolations",
  "otherPolicyViolations",
  "documentRequests",
] as const;

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** Kéo reportingDateRange{from,to} + status/targetValue/targetCondition + counters. */
function readMetricBlock(block: Record<string, unknown>): {
  rate: number | null;
  status: string | null;
  targetValue: number | null;
  targetCondition: string | null;
  reportingFrom: string | null;
  reportingTo: string | null;
  counters: Record<string, number>;
} {
  const range = asRecord(block.reportingDateRange);
  const counters: Record<string, number> = {};
  // Tài liệu Amazon liệt kê `rate` nằm trong khối con với orderDefectRate
  // (orderCount → rate, fulfillmentType). Vì vậy nếu block không có `rate` ở cấp
  // cao nhất thì tìm `rate` trong các khối con trước khi kết luận là thiếu số.
  let rate = num(block.rate);
  if (rate === null) {
    for (const v of Object.values(block)) {
      const inner = asRecord(v);
      if (typeof inner.rate === "number") {
        rate = inner.rate;
        break;
      }
    }
  }
  for (const [k, v] of Object.entries(block)) {
    if (typeof v === "number") counters[k] = v;
    // invoiceDefectRate: { invoiceDefect: {status,count}, missingInvoice:{...}, lateInvoice:{...} }
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      const inner = asRecord(v);
      if (typeof inner.count === "number") counters[k] = inner.count;
    }
  }
  return {
    rate,
    status: str(block.status),
    targetValue: num(block.targetValue),
    targetCondition: str(block.targetCondition),
    reportingFrom: str(range.reportingDateFrom),
    reportingTo: str(range.reportingDateTo),
    counters,
  };
}

/** Một nhóm warningStates → HealthIssue (null nếu khối không tồn tại). */
function readWarningIssue(key: string, block: Record<string, unknown>): HealthIssue | null {
  if (Object.keys(block).length === 0) {
    // vẫn tạo issue "rỗng" để UI thấy nhóm này có trong report nhưng không vi phạm
    return null;
  }
  const range = asRecord(block.reportingDateRange);
  const defectsCount = num(block.defectsCount) ?? 0;
  const meta = violationMeta(key);
  return {
    category: key,
    label: meta.label,
    severity: issueSeverity(key, defectsCount),
    group: meta.group,
    defectsCount,
    status: str(block.status),
    targetValue: num(block.targetValue),
    targetCondition: str(block.targetCondition),
    reportingFrom: str(range.reportingDateFrom),
    reportingTo: str(range.reportingDateTo),
  };
}

/**
 * Parse report. Nhận cả JSON string (nội dung tải từ getReportDocument) và object.
 * `marketplaceId` truyền vào chỉ dùng để CHỌN phần tử performanceMetrics phù hợp
 * khi report chứa nhiều marketplace.
 */
export function parseSellerPerformanceReport(
  input: string | unknown,
  opts?: { marketplaceId?: string },
): SellerPerformanceParsed {
  const warnings: string[] = [];
  const unknownKeys: string[] = [];
  const empty: SellerPerformanceParsed = {
    marketplaceId: opts?.marketplaceId ?? null,
    accountStatuses: [],
    ahrStatus: null,
    rates: [],
    issues: [],
    unknownKeys,
    warnings,
  };

  let root: unknown = input;
  if (typeof input === "string") {
    const text = input.trim();
    if (!text) return { ...empty, warnings: ["Report rỗng"] };
    try {
      root = JSON.parse(text);
    } catch (e) {
      return { ...empty, warnings: [`Report không phải JSON hợp lệ: ${(e as Error).message}`] };
    }
  }

  const doc = asRecord(root);
  // Một số đường tải bọc trong { payload: … } — bóc 1 lớp nếu có.
  const body = "accountStatuses" in doc || "performanceMetrics" in doc ? doc : asRecord(doc.payload);

  // ---- accountStatuses ----
  const accountStatuses: ParsedAccountStatus[] = asArray(body.accountStatuses).map((s) => {
    const rec = asRecord(s);
    return { marketplaceId: str(rec.marketplaceId), status: str(rec.status) };
  });
  if (accountStatuses.length === 0) warnings.push("Không có accountStatuses trong report");

  // ---- performanceMetrics (có thể nhiều marketplace) ----
  const metricsList = asArray(body.performanceMetrics).map(asRecord);
  if (metricsList.length === 0) warnings.push("Không có performanceMetrics trong report");

  let metrics = metricsList[0] ?? {};
  if (opts?.marketplaceId && metricsList.length > 1) {
    const match = metricsList.find((m) => str(m.marketplaceId) === opts.marketplaceId);
    if (!match) {
      warnings.push(
        `Report có ${metricsList.length} marketplace nhưng không có ${opts.marketplaceId} — dùng phần tử đầu`,
      );
    } else {
      metrics = match;
    }
  }
  const marketplaceId = opts?.marketplaceId ?? str(metrics.marketplaceId) ?? accountStatuses[0]?.marketplaceId ?? null;

  // ---- rates ----
  const rates: ParsedRate[] = [];
  for (const key of RATE_KEYS) {
    const block = asRecord(metrics[key]);
    if (Object.keys(block).length === 0) continue;
    rates.push({ key, ...readMetricBlock(block) });
  }
  // orderDefectRate tách afn/mfn (cả hai cùng phục vụ ngưỡng ODR 1%)
  const odr = asRecord(metrics.orderDefectRate);
  for (const channel of ["afn", "mfn"] as const) {
    const block = asRecord(odr[channel]);
    if (Object.keys(block).length === 0) continue;
    const parsed = readMetricBlock(block);
    rates.push({
      key: "orderDefectRate",
      ...parsed,
      counters: { ...parsed.counters, channel: channel === "afn" ? 1 : 0 },
    });
  }
  if (rates.length === 0) warnings.push("Không đọc được chỉ số hiệu suất nào từ performanceMetrics");

  // ---- warningStates ----
  const warningStates = asRecord(metrics.warningStates);
  const issues: HealthIssue[] = [];
  for (const key of WARNING_KEYS) {
    const issue = readWarningIssue(key, asRecord(warningStates[key]));
    if (issue) issues.push(issue);
  }
  // khóa lạ trong warningStates → giữ lại dưới dạng category chưa map
  for (const key of Object.keys(warningStates)) {
    if (WARNING_KEYS.includes(key as (typeof WARNING_KEYS)[number])) continue;
    if (key === "accountHealthRating") continue;
    unknownKeys.push(`warningStates.${key}`);
    const issue = readWarningIssue(key, asRecord(warningStates[key]));
    if (issue) issues.push(issue);
  }
  if (Object.keys(warningStates).length === 0) {
    warnings.push("Không có warningStates trong report (bản V1 XML không hỗ trợ — kiểm tra reportType)");
  }

  // ---- AHR ----
  const ahrBlock = asRecord(warningStates.accountHealthRating);
  const ahrStatus =
    ahrBlock.ahrStatus !== undefined && ahrBlock.ahrStatus !== null ? (ahrBlock.ahrStatus as string | number) : null;
  if (ahrStatus === null) warnings.push("Không có ahrStatus (Account Health Rating) trong report");

  // ghi nhận khóa lạ ở cấp metrics để không âm thầm mất dữ liệu mới của Amazon
  for (const key of Object.keys(metrics)) {
    if (key === "marketplaceId" || key === "orderDefectRate" || key === "warningStates") continue;
    if (!RATE_KEYS.includes(key as (typeof RATE_KEYS)[number])) unknownKeys.push(`performanceMetrics.${key}`);
  }

  return { marketplaceId, accountStatuses, ahrStatus, rates, issues, unknownKeys, warnings };
}
