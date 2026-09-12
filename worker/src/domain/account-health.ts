/**
 * Module 7 — Domain logic Account Health (H1/H2).
 *
 * Nguồn dữ liệu (đã đối chiếu developer-docs.amazon.com):
 *   • Report `GET_V2_SELLER_PERFORMANCE_REPORT` — "Seller Performance Report",
 *     dữ liệu của Account Health dashboard: accountStatuses[] + performanceMetrics
 *     (lateShipmentRate, invoiceDefectRate, orderDefectRate.afn/.mfn,
 *     onTimeDeliveryRate, unitOnTimeDeliveryRate, validTrackingRate,
 *     preFulfillmentCancellationRate, warningStates{accountHealthRating,
 *     listingPolicyViolations, productAuthenticityCustomerComplaints, …}).
 *     Lưu ý: `GET_V1_SELLER_PERFORMANCE_REPORT` là bản CŨ (XML Customer Metrics),
 *     vẫn dùng được nhưng thiếu warningStates/AHR → module này bám V2.
 *   • Notification `ACCOUNT_STATUS_CHANGED` — payloadVersion 2021-01-01,
 *     payload.accountStatusChangeNotification.{previousAccountStatus,currentAccountStatus}
 *     ∈ NORMAL | AT_RISK | DEACTIVATED.
 *   • SOP-08: SLA nghiêm trọng ≤ 24h; phân loại IP · hàng hạn chế · chất lượng ·
 *     hiệu suất giao hàng.
 *
 * Nguyên tắc số liệu: report CÓ targetValue/targetCondition riêng cho từng chỉ số.
 * Ta ưu tiên ngưỡng của report; bảng ngưỡng dưới đây chỉ là FALLBACK khi report
 * thiếu, và luôn bị đánh dấu `targetSource = "fallback"` để không ai nhầm là số Amazon.
 */

/* ============================================================================
 * 1. TÔNE / TRẠNG THÁI
 * ==========================================================================*/

export type HealthTone = "green" | "amber" | "red";
/** Kết quả đánh giá 1 chỉ số — "unknown" khi thiếu dữ liệu (KHÔNG tự coi là xanh). */
export type MetricTone = HealthTone | "unknown";

export const TONE_RANK: Record<HealthTone, number> = { green: 0, amber: 1, red: 2 };

/** Tông xấu hơn trong hai tông (green < amber < red). */
export function worseTone(a: HealthTone, b: HealthTone): HealthTone {
  return TONE_RANK[a] >= TONE_RANK[b] ? a : b;
}

/** Gộp nhiều tông, bỏ qua "unknown" — hết unknown thì trả "unknown". */
export function combineTones(tones: MetricTone[]): MetricTone {
  const known = tones.filter((t): t is HealthTone => t !== "unknown");
  if (known.length === 0) return "unknown";
  return known.reduce((acc, t) => worseTone(acc, t), "green");
}

export const TONE_LABEL_VN: Record<HealthTone, string> = {
  green: "Khỏe",
  amber: "Cần theo dõi",
  red: "Rủi ro",
};

/* ============================================================================
 * 2. CHỈ SỐ HIỆU SUẤT — ngưỡng & đánh giá
 * ==========================================================================*/

export type TargetCondition = "lt" | "gt" | "lte" | "gte";

export type RateTarget = {
  value: number;
  condition: TargetCondition;
  /** Nguồn ngưỡng: report (Amazon trả kèm) hay bảng fallback của VEXIM */
  source: "report" | "fallback";
  /** Mô tả ngưỡng để hiển thị (vd "< 1%") */
  label: string;
};

/**
 * Ngưỡng FALLBACK theo chuẩn Amazon (tài liệu Account Health / seller performance).
 * ⚠️ Chỉ dùng khi report không trả targetValue — cột "nguồn" trên UI phải hiện
 * "fallback" để phân biệt với số Amazon cung cấp.
 */
export const AMAZON_RATE_TARGETS: Record<string, { value: number; condition: TargetCondition }> = {
  orderDefectRate: { value: 1, condition: "lt" }, // ODR < 1%
  preFulfillmentCancellationRate: { value: 2.5, condition: "lt" }, // < 2.5%
  lateShipmentRate: { value: 4, condition: "lt" }, // LSR < 4%
  validTrackingRate: { value: 95, condition: "gt" }, // VTR ≥ 95%
  onTimeDeliveryRate: { value: 90, condition: "gt" }, // OTDR ≥ 90%
  invoiceDefectRate: { value: 6, condition: "lt" }, // IDR < 6%
};

/** Nhãn tiếng Việt của từng chỉ số (dùng cho UI/alert). */
export const RATE_LABELS: Record<string, string> = {
  orderDefectRate: "Order Defect Rate (ODR)",
  preFulfillmentCancellationRate: "Pre-fulfillment Cancellation Rate",
  lateShipmentRate: "Late Shipment Rate (LSR)",
  validTrackingRate: "Valid Tracking Rate (VTR)",
  onTimeDeliveryRate: "On-Time Delivery Rate",
  unitOnTimeDeliveryRate: "Unit On-Time Delivery Rate",
  invoiceDefectRate: "Invoice Defect Rate (IDR)",
};

export function rateLabel(key: string): string {
  return RATE_LABELS[key] ?? key;
}

/**
 * Trạng thái thô Amazon trả trong report (status của từng metric).
 * Giá trị thật của Amazon không được tài liệu liệt kê đầy đủ → map khoan dung,
 * lạ thì trả null và tầng trên tự tính theo ngưỡng.
 */
export function normalizeMetricStatus(raw: string | null | undefined): MetricTone | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (["good", "healthy", "ok", "normal", "met", "green", "no_issues"].includes(s)) return "green";
  if (["at_risk", "at risk", "warning", "amber", "near_threshold", "below_target"].includes(s)) return "amber";
  if (["critical", "poor", "bad", "red", "not_met", "not met", "unhealthy"].includes(s)) return "red";
  return null;
}

/** So sánh một số với ngưỡng + điều kiện. */
export function meetsTarget(value: number, targetValue: number, condition: TargetCondition): boolean {
  switch (condition) {
    case "lt":
      return value < targetValue;
    case "lte":
      return value <= targetValue;
    case "gt":
      return value > targetValue;
    case "gte":
      return value >= targetValue;
  }
}

/**
 * "Sát ngưỡng" — dùng để báo amber (cảnh báo sớm) dù chỉ số vẫn ĐẠT ngưỡng.
 *
 * Quy tắc đo khoảng cách phải theo CHIỀU của ngưỡng, không dùng hiệu số tuyệt đối:
 *   • lt/lte (càng thấp càng tốt, vd ODR < 1%): dải cảnh báo = 10% giá trị ngưỡng
 *     → ODR 0.95% sát ngưỡng 1%, ODR 0.4% thì không.
 *   • gt/gte (càng cao càng tốt, vd VTR ≥ 95%): vùng xấu nằm DƯỚI ngưỡng, nên phải
 *     đo bằng khoảng cách tới trần 100% (10% của 100−ngưỡng, tối thiểu 0.5 điểm).
 *     → VTR 95.4% sát ngưỡng; VTR 99% thì KHÔNG (nếu đo kiểu 10% của 95 = 9.5 thì
 *       VTR 99% cũng bị coi là sát ngưỡng — sai rõ ràng).
 */
export function nearThreshold(value: number, targetValue: number, condition: TargetCondition): boolean {
  const absTarget = Math.abs(targetValue);
  if (condition === "lt" || condition === "lte") {
    const margin = targetValue - value; // dương = chưa vượt ngưỡng
    return margin >= 0 && margin <= Math.max(absTarget * 0.1, 0.01);
  }
  const ceiling = Math.max(100 - absTarget, 1);
  const margin = value - targetValue; // dương = đã trên ngưỡng
  return margin >= 0 && margin <= Math.max(ceiling * 0.1, 0.5);
}

export function targetLabel(value: number, condition: TargetCondition): string {
  const sign = condition === "lt" ? "<" : condition === "lte" ? "≤" : condition === "gt" ? ">" : "≥";
  return `${sign} ${value}%`;
}

/**
 * Đánh giá 1 chỉ số → tông.
 * Thứ tự quyết định:
 *   1. status của Amazon (nếu map được)
 *   2. targetValue/targetCondition của report
 *   3. ngưỡng fallback của VEXIM (đánh dấu nguồn)
 * Không có gì → "unknown".
 */
export function evaluateRate(input: {
  key: string;
  rate: number | null | undefined;
  status?: string | null;
  targetValue?: number | null;
  targetCondition?: string | null;
}): { tone: MetricTone; target: RateTarget | null; note: string | null } {
  const fromStatus = normalizeMetricStatus(input.status);
  const rate = input.rate;
  const condition = (input.targetCondition ?? "").trim().toLowerCase();
  const validCond = (["lt", "lte", "gt", "gte"] as const).find((c) => c === condition);
  const fallback = AMAZON_RATE_TARGETS[input.key];

  // Ngưỡng vẫn phải hiện lên UI ngay cả khi Amazon đã gắn status — nếu không,
  // màn H1/H2 mất cột "Ngưỡng" đúng lúc amazon trả đủ dữ liệu nhất.
  let target: RateTarget | null = null;
  if (input.targetValue !== null && input.targetValue !== undefined && validCond) {
    target = {
      value: input.targetValue,
      condition: validCond,
      source: "report",
      label: targetLabel(input.targetValue, validCond),
    };
  } else if (fallback) {
    target = {
      value: fallback.value,
      condition: fallback.condition,
      source: "fallback",
      label: targetLabel(fallback.value, fallback.condition),
    };
  }

  if (fromStatus) {
    return {
      tone: fromStatus,
      target,
      note: target ? "theo status của report" : "theo status của report (report không kèm ngưỡng)",
    };
  }

  if (rate === null || rate === undefined || Number.isNaN(rate)) {
    return { tone: "unknown", target, note: "report không có số" };
  }

  if (!target) return { tone: "unknown", target: null, note: "không có ngưỡng để so" };

  const pass = meetsTarget(rate, target.value, target.condition);
  // Đạt ngưỡng nhưng sát biên → amber (cảnh báo sớm); vượt ngưỡng → red.
  const nearEdge = nearThreshold(rate, target.value, target.condition);
  const tone: MetricTone = pass ? (nearEdge ? "amber" : "green") : "red";

  return {
    tone,
    target,
    note: target.source === "fallback" ? "ngưỡng fallback (report không trả target)" : null,
  };
}

/* ============================================================================
 * 3. ACCOUNT STATUS & AHR
 * ==========================================================================*/

export type AmazonAccountStatus = "NORMAL" | "AT_RISK" | "DEACTIVATED";

export function accountStatusTone(status: string | null | undefined): MetricTone {
  const s = (status ?? "").trim().toUpperCase();
  if (s === "NORMAL") return "green";
  if (s === "AT_RISK") return "amber";
  if (s === "DEACTIVATED") return "red";
  return "unknown";
}

/**
 * AHR — Account Health Rating. Seller Central hiển thị thang 0–1000 kèm nhãn.
 * Report trả `ahrStatus` (chuỗi) chứ không phải số, nên hàm nhận cả hai:
 *   • số   : ≥ 200 xanh · 100–199 vàng · < 100 đỏ   (ngưỡng tham chiếu Amazon)
 *   • chuỗi: GOOD/HEALTHY → xanh · FAIR/AT_RISK → vàng · CRITICAL/UNHEALTHY → đỏ
 * Không nhận dạng được → amber (fail-safe: KHÔNG hiển thị xanh khi chưa chắc).
 */
export const AHR_BANDS = { green: 200, amber: 100 } as const;

export function ahrTone(ahrStatus: string | number | null | undefined): MetricTone {
  if (ahrStatus === null || ahrStatus === undefined || ahrStatus === "") return "unknown";

  if (typeof ahrStatus === "number" || /^\d+(\.\d+)?$/.test(String(ahrStatus).trim())) {
    const n = Number(ahrStatus);
    if (n >= AHR_BANDS.green) return "green";
    if (n >= AHR_BANDS.amber) return "amber";
    return "red";
  }

  const s = String(ahrStatus).trim().toLowerCase();
  if (["good", "healthy", "green", "normal", "excellent"].includes(s)) return "green";
  if (["fair", "at_risk", "at risk", "amber", "warning"].includes(s)) return "amber";
  if (["critical", "unhealthy", "red", "poor", "deactivated"].includes(s)) return "red";
  return "amber"; // lạ → fail-safe
}

/* ============================================================================
 * 4. VI PHẠM / CẢNH BÁO CHÍNH SÁCH (H2)
 * ==========================================================================*/

export type ViolationSeverity = "Critical" | "High" | "Medium" | "Low";

/** 10 nhóm warningStates trong report V2 → nhãn + mức nghiêm trọng mặc định. */
export const VIOLATION_CATEGORIES: Record<
  string,
  { label: string; severity: ViolationSeverity; group: "ip" | "restricted" | "quality" | "performance" | "other" }
> = {
  receivedIntellectualPropertyComplaints: { label: "Khiếu nại IP đã nhận", severity: "Critical", group: "ip" },
  suspectedIntellectualPropertyViolations: { label: "Nghi vi phạm sở hữu trí tuệ", severity: "High", group: "ip" },
  productAuthenticityCustomerComplaints: { label: "Khiếu nại hàng giả/không xác thực", severity: "Critical", group: "quality" },
  productSafetyCustomerComplaints: { label: "Khiếu nại an toàn sản phẩm", severity: "Critical", group: "quality" },
  productConditionCustomerComplaints: { label: "Khiếu nại tình trạng hàng", severity: "High", group: "quality" },
  listingPolicyViolations: { label: "Vi phạm chính sách listing", severity: "High", group: "restricted" },
  restrictedProductPolicyViolations: { label: "Vi phạm hàng hạn chế", severity: "Critical", group: "restricted" },
  foodAndProductSafetyIssues: { label: "Vấn đề an toàn thực phẩm/sản phẩm", severity: "Critical", group: "quality" },
  customerProductReviewsPolicyViolations: { label: "Vi phạm chính sách review", severity: "Medium", group: "restricted" },
  otherPolicyViolations: { label: "Vi phạm chính sách khác", severity: "Medium", group: "other" },
  documentRequests: { label: "Yêu cầu bổ sung hồ sơ (KYC)", severity: "High", group: "other" },
};

export function violationMeta(key: string): { label: string; severity: ViolationSeverity; group: string } {
  return VIOLATION_CATEGORIES[key] ?? { label: key, severity: "Medium", group: "other" };
}

/**
 * Mức nghiêm trọng hiệu dụng: report chỉ trả defectsCount + status, ta nâng mức
 * khi số vi phạm tăng (≥3 lỗi cùng loại = nghiêm trọng hơn 1 mức).
 */
export function issueSeverity(categoryKey: string, defectsCount: number): ViolationSeverity {
  const base = violationMeta(categoryKey).severity;
  const order: ViolationSeverity[] = ["Low", "Medium", "High", "Critical"];
  const idx = order.indexOf(base);
  const bump = defectsCount >= 3 ? 1 : 0;
  return order[Math.min(order.length - 1, idx + bump)];
}

export type HealthIssue = {
  /** khóa nhóm vi phạm (receivedIntellectualPropertyComplaints…) */
  category: string;
  label: string;
  severity: ViolationSeverity;
  group: string;
  defectsCount: number;
  status: string | null;
  targetValue: number | null;
  targetCondition: string | null;
  reportingFrom: string | null;
  reportingTo: string | null;
};

/** Kiểm tra có vi phạm thật hay không (report trả về cả nhóm rỗng). */
export function hasViolation(issue: HealthIssue): boolean {
  if (issue.defectsCount > 0) return true;
  const tone = normalizeMetricStatus(issue.status);
  return tone === "amber" || tone === "red";
}

export function openIssues(issues: HealthIssue[]): HealthIssue[] {
  const order: Record<ViolationSeverity, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  return issues
    .filter(hasViolation)
    .sort((a, b) => order[a.severity] - order[b.severity] || b.defectsCount - a.defectsCount);
}

/* ============================================================================
 * 5. ĐIỂM SỨC KHỎE SHOP (H1) + SOP-08
 * ==========================================================================*/

export type ShopHealthSnapshot = {
  accountStatus: string | null;
  ahrStatus: string | number | null;
  rates: {
    key: string;
    rate: number | null;
    status?: string | null;
    targetValue?: number | null;
    targetCondition?: string | null;
  }[];
  issues: HealthIssue[];
};

export type ShopHealth = {
  tone: MetricTone;
  /** 0–100 (chỉ mang tính xếp hạng nội bộ, KHÔNG phải AHR của Amazon) */
  score: number;
  accountStatusTone: MetricTone;
  ahrTone: MetricTone;
  rateTones: { key: string; label: string; tone: MetricTone; rate: number | null; target: RateTarget | null; note: string | null }[];
  openIssues: HealthIssue[];
  criticalIssues: number;
  summary: string;
};

/**
 * Tính sức khỏe shop.
 * Điểm nội bộ = 100 − (ODR/… vượt ngưỡng) − (vi phạm theo mức) − (AHR/status không xanh).
 * Mục đích: xếp hạng ưu tiên xử lý giữa nhiều shop, KHÔNG thay thế AHR.
 */
export function evaluateShopHealth(snapshot: ShopHealthSnapshot): ShopHealth {
  const statusTone = accountStatusTone(snapshot.accountStatus);
  const ahr = ahrTone(snapshot.ahrStatus);

  const rateTones = snapshot.rates.map((r) => {
    const evaluated = evaluateRate({
      key: r.key,
      rate: r.rate,
      status: r.status,
      targetValue: r.targetValue,
      targetCondition: r.targetCondition,
    });
    return {
      key: r.key,
      label: rateLabel(r.key),
      tone: evaluated.tone,
      rate: r.rate ?? null,
      target: evaluated.target,
      note: evaluated.note,
    };
  });

  const issues = openIssues(snapshot.issues);
  const criticalIssues = issues.filter((i) => i.severity === "Critical").length;

  let score = 100;
  for (const r of rateTones) {
    if (r.tone === "red") score -= 20;
    else if (r.tone === "amber") score -= 8;
  }
  if (ahr === "amber") score -= 15;
  if (ahr === "red") score -= 35;
  if (statusTone === "amber") score -= 20;
  if (statusTone === "red") score -= 50;
  for (const i of issues) {
    score -= i.severity === "Critical" ? 12 : i.severity === "High" ? 6 : 3;
  }
  score = Math.max(0, Math.min(100, Math.round(score)));

  const ratesTone = combineTones([statusTone, ahr, ...rateTones.map((r) => r.tone)]);
  const issuesTone: HealthTone = issues.some((i) => i.severity === "Critical")
    ? "red"
    : issues.length > 0
      ? "amber"
      : "green";
  // Không có dữ liệu chỉ số → giữ "unknown" (KHÔNG hiển thị xanh khi chưa biết)
  const tone: MetricTone =
    ratesTone === "unknown" ? (issues.length > 0 ? issuesTone : "unknown") : worseTone(ratesTone, issuesTone);

  const bits: string[] = [];
  if (snapshot.accountStatus) bits.push(`trạng thái tài khoản ${snapshot.accountStatus}`);
  if (snapshot.ahrStatus !== null && snapshot.ahrStatus !== undefined) bits.push(`AHR ${snapshot.ahrStatus}`);
  bits.push(`${issues.length} vi phạm mở (${criticalIssues} nghiêm trọng)`);

  return {
    tone,
    score,
    accountStatusTone: statusTone,
    ahrTone: ahr,
    rateTones,
    openIssues: issues,
    criticalIssues,
    summary: bits.join(" · "),
  };
}

export type Escalation = {
  sop: "SOP-08";
  /** Giờ phải xử lý xong (null = theo dõi bình thường) */
  slaHours: number | null;
  owner: string;
  steps: string[];
};

/** Kế hoạch xử lý theo SOP-08 (SLA nghiêm trọng ≤ 24h). */
export function escalationPlan(health: ShopHealth): Escalation {
  const sla = health.tone === "red" ? 24 : health.tone === "amber" ? 72 : null;
  return {
    sop: "SOP-08",
    slaHours: sla,
    owner: "Phòng Vận hành & Account Health",
    steps: [
      "Đọc chi tiết vi phạm + mức nghiêm trọng",
      "Phân loại: IP · hàng hạn chế · chất lượng · hiệu suất giao hàng",
      "Thu thập bằng chứng (hóa đơn, chứng nhận, nhật ký vận hành từ hệ thống)",
      "Nộp appeal trên Seller Central + theo dõi case",
      "Bàn giao phòng liên quan nếu nguyên nhân thuộc phòng đó (Listing/Kho/CSKH)",
    ],
  };
}

/* ============================================================================
 * 6. SINH CẢNH BÁO
 * ==========================================================================*/

export type HealthAlert = {
  ruleCode: string;
  severity: HealthTone;
  title: string;
  detail: string;
};

/**
 * Sinh alert từ sức khỏe shop — rule_code phải tồn tại trong ops.alert_rules
 * (`account_health`, `odr_threshold` — seed 0001).
 */
export function healthAlerts(snapshot: ShopHealthSnapshot): HealthAlert[] {
  const health = evaluateShopHealth(snapshot);
  const alerts: HealthAlert[] = [];

  const statusTone = accountStatusTone(snapshot.accountStatus);
  if (statusTone === "amber" || statusTone === "red") {
    alerts.push({
      ruleCode: "account_health",
      severity: statusTone,
      title: `Tài khoản ${snapshot.accountStatus} — ${TONE_LABEL_VN[statusTone]}`,
      detail:
        snapshot.accountStatus === "DEACTIVATED"
          ? "Tài khoản đã bị Amazon khoá. Kích hoạt SOP-08 ngay (SLA 24h), kiểm tra email/case khẩn."
          : "Amazon đặt tài khoản ở trạng thái AT_RISK — rà vi phạm mở + chỉ số vượt ngưỡng theo SOP-08.",
    });
  }

  const odr = health.rateTones.find((r) => r.key === "orderDefectRate");
  if (odr && odr.tone === "red" && odr.rate !== null) {
    const target = odr.target ? odr.target.label : "< 1%";
    alerts.push({
      ruleCode: "odr_threshold",
      severity: "red",
      title: `ODR ${odr.rate}% vượt ngưỡng ${target}`,
      detail:
        `ODR vượt ngưỡng an toàn — rủi ro tài khoản. ` +
        (odr.target?.source === "fallback" ? "(ngưỡng fallback: report không trả targetValue) " : "") +
        "Rà chargebacks/claims/negative feedback theo SOP-08.",
    });
  }

  for (const issue of health.openIssues.filter((i) => i.severity === "Critical")) {
    alerts.push({
      ruleCode: "account_health",
      severity: "red",
      title: `Vi phạm nghiêm trọng: ${issue.label} (${issue.defectsCount})`,
      detail: `Nhóm ${issue.group} · trạng thái ${issue.status ?? "n/a"} · SLA 24h theo SOP-08.`,
    });
  }

  if (alerts.length === 0 && health.tone === "amber") {
    alerts.push({
      ruleCode: "account_health",
      severity: "amber",
      title: "Chỉ số Account Health sát ngưỡng",
      detail: health.summary + " — theo dõi trong ngày, chưa cần leo thang.",
    });
  }

  return alerts;
}

/** Chuyển alert sức khỏe thành nội dung task SOP-08 (dùng cho ops.tasks). */
export function healthTaskDraft(shopLabel: string, snapshot: ShopHealthSnapshot): {
  title: string;
  description: string;
  slaHours: number | null;
} | null {
  const health = evaluateShopHealth(snapshot);
  if (health.tone === "green" || health.tone === "unknown") return null;
  const plan = escalationPlan(health);
  return {
    title: `[SOP-08] ${shopLabel}: ${TONE_LABEL_VN[health.tone]} (điểm ${health.score}/100)`,
    description: `${health.summary}\n\nCác bước:\n${plan.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
    slaHours: plan.slaHours,
  };
}
