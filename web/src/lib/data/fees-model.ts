/**
 * Model phí theo FC (0019) — đọc từ 5 view công khai:
 *   • vexim_storage_fees              phí lưu kho theo ASIN/FNSKU × FC × tháng
 *   • vexim_storage_fee_by_fc         PHÂN BỔ PHÍ THEO FC (shop × tháng × FC × tiền)
 *   • vexim_inbound_issues            từng vấn đề khi Amazon nhận lô + phí
 *   • vexim_inbound_issue_shipments   gộp vấn đề theo lô
 *   • vexim_report_requests           cron Reports API đang ở đâu (Module 0)
 *
 * HAI QUY TẮC SỐ LIỆU (vi phạm là ra quyết định sai):
 *   1. PostgREST trả `numeric`/`bigint` dạng CHUỖI. Không ép Number thì UI ghép
 *      chuỗi: "40" + "10" = "4010". Mọi số đi qua numOf/intOf dưới đây.
 *   2. KHÔNG BAO GIỜ cộng tiền khác tiền tệ (shop bán US + CA). Dữ liệu được
 *      nhóm theo currency và UI render từng nhóm một, mỗi nhóm một tổng.
 *
 * Report phí lưu kho KHÔNG có cột seller SKU → view suy SKU qua FNSKU (report
 * 0018) hoặc ASIN (catalog). `skuSource` nói rõ lấy từ đâu; "none" = chưa ánh
 * xạ được, UI phải hiện "chưa gắn được SKU" thay vì im lặng gán đại.
 */

/* ------------------------------------------------------------------ */
/* Raw (snake_case đúng như view trả về)                               */
/* ------------------------------------------------------------------ */

export type StorageFeeRaw = {
  seller_account_id: string;
  shop: string;
  month_of_charge: string;
  fnsku: string | null;
  asin: string | null;
  sku: string | null;
  sku_source: string | null;
  product_name: string | null;
  fc: string | null;
  country_code: string | null;
  product_size_tier: string | null;
  average_quantity_on_hand: string | number | null;
  average_quantity_pending_removal: string | number | null;
  average_quantity_customer_orders: string | number | null;
  estimated_total_item_volume: string | number | null;
  volume_units: string | null;
  storage_rate: string | number | null;
  currency: string | null;
  estimated_monthly_storage_fee: string | number | null;
  dangerous_goods_storage_type: string | null;
  eligible_for_inventory_discount: boolean | null;
  qualifies_for_inventory_discount: boolean | null;
  total_incentive_fee_amount: string | number | null;
  source: string | null;
  imported_at: string | null;
};

export type StorageFeeByFcRaw = {
  seller_account_id: string;
  shop: string;
  month_of_charge: string;
  fc: string | null;
  currency: string | null;
  storage_fee: string | number | null;
  total_volume: string | number | null;
  avg_units_on_hand: string | number | null;
  product_lines: string | number | null;
  fnsku_count: string | number | null;
  volume_units: string | null;
  month_fee_total: string | number | null;
  month_fc_count: string | number | null;
  fee_share_pct: string | number | null;
  imported_at: string | null;
};

export type InboundIssueRaw = {
  seller_account_id: string;
  shop: string;
  issue_reported_date: string;
  days_ago: string | number | null;
  shipment_creation_date: string | null;
  shipment_id: string | null;
  carton_id: string | null;
  fc: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  product_name: string | null;
  problem_type: string | null;
  problem_quantity: string | number | null;
  expected_quantity: string | number | null;
  received_quantity: string | number | null;
  performance_measurement_unit: string | null;
  coaching_level: string | null;
  fee_type: string | null;
  currency: string | null;
  fee_total: string | number | null;
  problem_level: string | null;
  alert_status: string | null;
  source: string | null;
  imported_at: string | null;
};

export type InboundIssueShipmentRaw = {
  seller_account_id: string;
  shop: string;
  shipment_id: string;
  fc: string | null;
  shipment_creation_date: string | null;
  currency: string | null;
  issue_count: string | number | null;
  fee_total: string | number | null;
  problem_units: string | number | null;
  sku_count: string | number | null;
  first_issue_date: string | null;
  last_issue_date: string | null;
  problem_types: string | null;
  coaching_levels: string | null;
  alert_statuses: string | null;
  shipment_status: string | null;
  imported_at: string | null;
};

export type ReportRequestRaw = {
  id: string;
  seller_account_id: string;
  shop: string;
  report_type: string;
  marketplace_id: string | null;
  data_start: string | null;
  data_end: string | null;
  report_id: string | null;
  report_document_id: string | null;
  status: string | null;
  rows_imported: string | number | null;
  attempts: string | number | null;
  last_error: string | null;
  requested_at: string | null;
  completed_at: string | null;
  imported_at: string | null;
  age_minutes: string | number | null;
  is_stale: boolean | null;
};

/* ------------------------------------------------------------------ */
/* Chuỗi select — PHẢI khớp đúng hợp đồng cột trong 0019 (self-check)  */
/* ------------------------------------------------------------------ */

export const STORAGE_FEE_SELECT =
  "seller_account_id,shop,month_of_charge,fnsku,asin,sku,sku_source,product_name,fc," +
  "country_code,product_size_tier,average_quantity_on_hand,average_quantity_pending_removal," +
  "average_quantity_customer_orders,estimated_total_item_volume,volume_units,storage_rate," +
  "currency,estimated_monthly_storage_fee,dangerous_goods_storage_type," +
  "eligible_for_inventory_discount,qualifies_for_inventory_discount,total_incentive_fee_amount," +
  "source,imported_at";

export const STORAGE_FEE_BY_FC_SELECT =
  "seller_account_id,shop,month_of_charge,fc,currency,storage_fee,total_volume," +
  "avg_units_on_hand,product_lines,fnsku_count,volume_units,month_fee_total," +
  "month_fc_count,fee_share_pct,imported_at";

export const INBOUND_ISSUE_SELECT =
  "seller_account_id,shop,issue_reported_date,days_ago,shipment_creation_date,shipment_id," +
  "carton_id,fc,sku,fnsku,asin,product_name,problem_type,problem_quantity,expected_quantity," +
  "received_quantity,performance_measurement_unit,coaching_level,fee_type,currency,fee_total," +
  "problem_level,alert_status,source,imported_at";

export const INBOUND_ISSUE_SHIPMENT_SELECT =
  "seller_account_id,shop,shipment_id,fc,shipment_creation_date,currency,issue_count," +
  "fee_total,problem_units,sku_count,first_issue_date,last_issue_date,problem_types," +
  "coaching_levels,alert_statuses,shipment_status,imported_at";

export const REPORT_REQUEST_SELECT =
  "id,seller_account_id,shop,report_type,marketplace_id,data_start,data_end,report_id," +
  "report_document_id,status,rows_imported,attempts,last_error,requested_at,completed_at," +
  "imported_at,age_minutes,is_stale";

/* ------------------------------------------------------------------ */
/* Kiểu dùng cho UI                                                    */
/* ------------------------------------------------------------------ */

export type SkuSource = "fnsku" | "asin" | "none";

export type StorageFeeUiRow = {
  month: string;
  monthLabel: string;
  shop: string;
  sku: string | null;
  skuSource: SkuSource;
  skuSourceLabel: string;
  fnsku: string | null;
  asin: string | null;
  productName: string | null;
  fc: string;
  currency: string | null;
  fee: number | null;
  feeLabel: string;
  storageRate: number | null;
  avgOnHand: number | null;
  avgPendingRemoval: number | null;
  avgCustomerOrders: number | null;
  totalVolume: number | null;
  volumeUnits: string | null;
  sizeTier: string | null;
  incentive: number | null;
  eligibleDiscount: boolean | null;
  qualifiesDiscount: boolean | null;
  dangerousGoods: string | null;
  importedAt: string | null;
};

export type StorageFeeByFcUiRow = {
  month: string;
  monthLabel: string;
  shop: string;
  fc: string;
  currency: string | null;
  fee: number | null;
  feeLabel: string;
  sharePct: number | null;
  shareLabel: string;
  volume: number | null;
  units: number | null;
  lines: number;
  fnskuCount: number;
  volumeUnits: string | null;
  monthTotal: number | null;
  monthFcCount: number;
  importedAt: string | null;
};

export type InboundIssueUiRow = {
  date: string;
  dateLabel: string;
  daysAgo: number | null;
  shop: string;
  shipmentId: string | null;
  cartonId: string | null;
  fc: string | null;
  sku: string | null;
  productName: string | null;
  problemType: string;
  problemTypeLabel: string;
  problemQty: number | null;
  expected: number | null;
  received: number | null;
  coachingLevel: string | null;
  feeType: string | null;
  currency: string | null;
  fee: number | null;
  feeLabel: string;
  problemLevel: string | null;
  alertStatus: string | null;
  tone: "up" | "down" | "warn" | "flat";
};

export type InboundIssueShipmentUiRow = {
  shipmentId: string;
  shop: string;
  fc: string | null;
  createdAt: string | null;
  currency: string | null;
  issueCount: number;
  fee: number;
  feeLabel: string;
  problemUnits: number;
  skuCount: number;
  problemTypes: string[];
  coachingLevels: string[];
  alertStatuses: string[];
  shipmentStatus: string | null;
  firstDate: string | null;
  lastDate: string | null;
  /** mức độ nghiêm trọng cao nhất trong lô — để sắp xếp "lô đau nhất" lên trước */
  severity: number;
  tone: "up" | "down" | "warn" | "flat";
};

export type ReportRequestUiRow = {
  id: string;
  shop: string;
  reportType: string;
  reportLabel: string;
  period: string;
  status: string;
  statusLabel: string;
  tone: "up" | "down" | "warn" | "flat";
  rowsImported: number | null;
  attempts: number;
  lastError: string | null;
  reportId: string | null;
  documentId: string | null;
  requestedAt: string | null;
  ageMinutes: number | null;
  isStale: boolean;
};

/* ------------------------------------------------------------------ */
/* Ép kiểu: numeric/bigint về chuỗi → số; không đọc được → null          */
/* ------------------------------------------------------------------ */

function numOf(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function intOf(v: unknown, fallback = 0): number {
  return numOf(v) ?? fallback;
}

function dateOf(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return String(v).slice(0, 10);
}

const emptyToNull = (v: string | null | undefined): string | null =>
  v === null || v === undefined || v === "" ? null : v;

/** "2026-08" → "T08/2026" (đọc nhanh kiểu Việt Nam, vẫn giữ thứ tự sắp xếp). */
export function monthLabel(month: string): string {
  const m = month.match(/^(\d{4})-(\d{2})$/);
  if (!m) return month;
  return `T${m[2]}/${m[1]}`;
}

/** Tiền luôn kèm đơn vị; null = "chưa rõ" (KHÔNG hiện 0 — 0 nghĩa là không tốn phí). */
export function moneyLabel(amount: number | null, currency: string | null): string {
  if (amount === null) return "chưa rõ phí";
  const cur = currency ?? "";
  return `${amount.toLocaleString("vi-VN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${cur ? ` ${cur}` : ""}`;
}

export function formatFeeSharePct(v: number | null): string {
  if (v === null) return "không rõ %";
  return `${v.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`;
}

const SKU_SOURCE_LABEL: Record<SkuSource, string> = {
  fnsku: "khớp FNSKU",
  asin: "khớp ASIN",
  none: "chưa gắn được SKU",
};

/** Loại vấn đề inbound: dịch nhãn để người vận hành đọc hiểu ngay. */
const PROBLEM_TYPE_LABEL: Record<string, string> = {
  OVERSIZED_CARTON: "Thùng quá khổ",
  OVERSIZED_PACKAGE: "Kiện quá khổ",
  MISSING_LABEL: "Thiếu nhãn",
  INVALID_LABEL: "Nhãn không hợp lệ",
  DAMAGED_ITEM: "Hàng hư hỏng",
  DAMAGED_CARTON: "Thùng hư hỏng",
  EXPIRED_ITEM: "Hàng hết hạn",
  MISSING_ITEM: "Thiếu hàng",
  RECEIVED_WRONG_ITEM: "Nhận sai hàng",
  NOT_IN_PLAN: "Ngoài kế hoạch lô",
  UNPREPPED_ITEM: "Chưa prep theo yêu cầu",
};

export function problemTypeLabel(type: string | null): string {
  const t = (type ?? "").toUpperCase();
  return PROBLEM_TYPE_LABEL[t] ?? (t === "" ? "(không rõ loại)" : t);
}

/** Nhãn reportType cho màn Sync health — đọc "Phí lưu kho" dễ hơn đọc hằng số Amazon. */
const REPORT_LABEL: Record<string, string> = {
  GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA: "Tồn theo FC",
  GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA: "Lịch sử nhận hàng",
  GET_FBA_STORAGE_FEE_CHARGES_DATA: "Phí lưu kho",
  GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA: "Phí inbound",
};

export function reportTypeLabel(reportType: string): string {
  return REPORT_LABEL[reportType] ?? reportType;
}

const REQUEST_STATUS_LABEL: Record<string, { label: string; tone: "up" | "down" | "warn" | "flat" }> = {
  requested: { label: "đã yêu cầu", tone: "flat" },
  in_queue: { label: "Amazon đang xếp hàng", tone: "flat" },
  in_progress: { label: "Amazon đang tạo", tone: "flat" },
  done: { label: "có file, chưa nhập", tone: "warn" },
  imported: { label: "đã nhập", tone: "up" },
  no_data: { label: "report rỗng", tone: "flat" },
  failed: { label: "lỗi", tone: "down" },
  fatal: { label: "Amazon báo lỗi", tone: "down" },
  cancelled: { label: "Amazon đã huỷ", tone: "down" },
};

/** Mức độ nghiêm trọng của vấn đề inbound (để lô đau nhất lên trước). */
const SEVERITY: Record<string, number> = { CRITICAL: 3, ALERT: 2, LEVEL_3: 3, LEVEL_2: 2, LEVEL_1: 1 };

export function severityOf(values: (string | null)[]): number {
  return values.reduce((max, v) => Math.max(max, SEVERITY[String(v ?? "").toUpperCase()] ?? 0), 0);
}

/* ------------------------------------------------------------------ */
/* Mapper                                                              */
/* ------------------------------------------------------------------ */

export function mapStorageFeeRow(raw: StorageFeeRaw): StorageFeeUiRow {
  const source = (["fnsku", "asin", "none"].includes(String(raw.sku_source ?? ""))
    ? raw.sku_source
    : "none") as SkuSource;
  const fee = numOf(raw.estimated_monthly_storage_fee);
  return {
    month: raw.month_of_charge,
    monthLabel: monthLabel(raw.month_of_charge),
    shop: raw.shop,
    sku: emptyToNull(raw.sku),
    skuSource: source,
    skuSourceLabel: SKU_SOURCE_LABEL[source],
    fnsku: emptyToNull(raw.fnsku),
    asin: emptyToNull(raw.asin),
    productName: emptyToNull(raw.product_name),
    fc: emptyToNull(raw.fc) ?? "(không rõ FC)",
    currency: emptyToNull(raw.currency),
    fee,
    feeLabel: moneyLabel(fee, emptyToNull(raw.currency)),
    storageRate: numOf(raw.storage_rate),
    avgOnHand: numOf(raw.average_quantity_on_hand),
    avgPendingRemoval: numOf(raw.average_quantity_pending_removal),
    avgCustomerOrders: numOf(raw.average_quantity_customer_orders),
    totalVolume: numOf(raw.estimated_total_item_volume),
    volumeUnits: emptyToNull(raw.volume_units),
    sizeTier: emptyToNull(raw.product_size_tier),
    incentive: numOf(raw.total_incentive_fee_amount),
    eligibleDiscount: raw.eligible_for_inventory_discount === null ? null : !!raw.eligible_for_inventory_discount,
    qualifiesDiscount: raw.qualifies_for_inventory_discount === null ? null : !!raw.qualifies_for_inventory_discount,
    dangerousGoods: emptyToNull(raw.dangerous_goods_storage_type),
    importedAt: raw.imported_at ?? null,
  };
}

export function mapStorageFeeByFcRow(raw: StorageFeeByFcRaw): StorageFeeByFcUiRow {
  const fee = numOf(raw.storage_fee);
  const share = numOf(raw.fee_share_pct);
  return {
    month: raw.month_of_charge,
    monthLabel: monthLabel(raw.month_of_charge),
    shop: raw.shop,
    fc: emptyToNull(raw.fc) ?? "(không rõ FC)",
    currency: emptyToNull(raw.currency),
    fee,
    feeLabel: moneyLabel(fee, emptyToNull(raw.currency)),
    sharePct: share,
    shareLabel: formatFeeSharePct(share),
    volume: numOf(raw.total_volume),
    units: numOf(raw.avg_units_on_hand),
    lines: intOf(raw.product_lines),
    fnskuCount: intOf(raw.fnsku_count),
    volumeUnits: emptyToNull(raw.volume_units),
    monthTotal: numOf(raw.month_fee_total),
    monthFcCount: intOf(raw.month_fc_count),
    importedAt: raw.imported_at ?? null,
  };
}

export function mapInboundIssueRow(raw: InboundIssueRaw): InboundIssueUiRow {
  const date = dateOf(raw.issue_reported_date) ?? "";
  const days = numOf(raw.days_ago);
  const fee = numOf(raw.fee_total);
  const currency = emptyToNull(raw.currency);
  const alert = emptyToNull(raw.alert_status);
  const coaching = emptyToNull(raw.coaching_level);
  const severity = severityOf([alert, coaching]);
  return {
    date,
    dateLabel: days === null ? date : days === 0 ? `${date} (hôm nay)` : `${date} (${days} ngày trước)`,
    daysAgo: days,
    shop: raw.shop,
    shipmentId: emptyToNull(raw.shipment_id),
    cartonId: emptyToNull(raw.carton_id),
    fc: emptyToNull(raw.fc),
    sku: emptyToNull(raw.sku),
    productName: emptyToNull(raw.product_name),
    problemType: (raw.problem_type ?? "").toUpperCase(),
    problemTypeLabel: problemTypeLabel(raw.problem_type),
    problemQty: numOf(raw.problem_quantity),
    expected: numOf(raw.expected_quantity),
    received: numOf(raw.received_quantity),
    coachingLevel: coaching,
    feeType: emptyToNull(raw.fee_type),
    currency,
    fee,
    feeLabel: moneyLabel(fee, currency),
    problemLevel: emptyToNull(raw.problem_level),
    alertStatus: alert,
    tone: severity >= 3 ? "down" : severity === 2 ? "warn" : fee !== null && fee > 0 ? "warn" : "flat",
  };
}

export function mapInboundIssueShipmentRow(raw: InboundIssueShipmentRaw): InboundIssueShipmentUiRow {
  const fee = numOf(raw.fee_total) ?? 0;
  const currency = emptyToNull(raw.currency);
  const alerts = splitList(raw.alert_statuses);
  const coachings = splitList(raw.coaching_levels);
  const severity = severityOf([...alerts, ...coachings]);
  return {
    shipmentId: raw.shipment_id,
    shop: raw.shop,
    fc: emptyToNull(raw.fc),
    createdAt: dateOf(raw.shipment_creation_date),
    currency,
    issueCount: intOf(raw.issue_count),
    fee,
    feeLabel: moneyLabel(fee, currency),
    problemUnits: intOf(raw.problem_units),
    skuCount: intOf(raw.sku_count),
    problemTypes: splitList(raw.problem_types).map(problemTypeLabel),
    coachingLevels: coachings,
    alertStatuses: alerts,
    shipmentStatus: emptyToNull(raw.shipment_status),
    firstDate: dateOf(raw.first_issue_date),
    lastDate: dateOf(raw.last_issue_date),
    severity,
    tone: severity >= 3 ? "down" : severity === 2 ? "warn" : fee > 0 ? "warn" : "flat",
  };
}

function splitList(v: string | null): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export function mapReportRequestRow(raw: ReportRequestRaw): ReportRequestUiRow {
  const status = String(raw.status ?? "failed");
  const meta = REQUEST_STATUS_LABEL[status] ?? { label: status, tone: "flat" as const };
  const start = dateOf(raw.data_start);
  const end = dateOf(raw.data_end);
  return {
    id: raw.id,
    shop: raw.shop,
    reportType: raw.report_type,
    reportLabel: reportTypeLabel(raw.report_type),
    period: start && end ? `${start} → ${end}` : "không khoảng ngày",
    status,
    statusLabel: raw.is_stale ? `${meta.label} · CHỜ QUÁ LÂU` : meta.label,
    tone: raw.is_stale && meta.tone !== "down" ? "warn" : meta.tone,
    rowsImported: numOf(raw.rows_imported),
    attempts: intOf(raw.attempts, 0),
    lastError: emptyToNull(raw.last_error),
    reportId: emptyToNull(raw.report_id),
    documentId: emptyToNull(raw.report_document_id),
    requestedAt: raw.requested_at ?? null,
    ageMinutes: numOf(raw.age_minutes),
    isStale: raw.is_stale === true,
  };
}

/* ------------------------------------------------------------------ */
/* Truy vấn phía UI                                                    */
/* ------------------------------------------------------------------ */

const sameId = (a: string | null | undefined, b: string | null | undefined): boolean =>
  String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase() && String(a ?? "") !== "";

/** Kỳ phí mới nhất có dữ liệu (null khi chưa nhập report nào). */
export function latestFeeMonth(rows: { month: string }[]): string | null {
  return rows.reduce<string | null>((max, r) => (max === null || r.month > max ? r.month : max), null);
}

/**
 * I2: phí lưu kho của MỘT SKU. Khớp theo SKU đã ánh xạ, và theo FNSKU/ASIN khi
 * view chưa gắn được SKU (sku_source='none') — thà hiện dòng "chưa gắn được SKU"
 * còn hơn giấu phí thật của sản phẩm đó.
 */
export function storageFeesForSku(
  rows: StorageFeeUiRow[],
  ref: { sku?: string | null; fnsku?: string | null; asin?: string | null },
): StorageFeeUiRow[] {
  return rows
    .filter((r) => sameId(r.sku, ref.sku) || sameId(r.fnsku, ref.fnsku) || sameId(r.asin, ref.asin))
    .sort((a, b) => b.month.localeCompare(a.month) || (b.fee ?? -1) - (a.fee ?? -1));
}

/**
 * Phân bổ phí theo FC cho MỘT kỳ, NHÓM THEO TIỀN TỆ.
 * Trả về mảng nhóm (mỗi nhóm một currency + tổng riêng) để UI không bao giờ
 * cộng USD với CAD. Nhóm nào có tiền lớn hơn lên trước.
 */
export function feeByFcForMonth(
  rows: StorageFeeByFcUiRow[],
  month: string,
): { currency: string; total: number | null; rows: StorageFeeByFcUiRow[] }[] {
  const groups = new Map<string, StorageFeeByFcUiRow[]>();
  for (const r of rows) {
    if (r.month !== month) continue;
    const key = r.currency ?? "(không rõ tiền)";
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([currency, list]) => ({
      currency,
      total: list.reduce<number | null>(
        (sum, r) => (r.fee === null ? sum : (sum ?? 0) + r.fee),
        list.every((r) => r.fee === null) ? null : 0,
      ),
      rows: [...list].sort((a, b) => (b.fee ?? -1) - (a.fee ?? -1) || a.fc.localeCompare(b.fc)),
    }))
    .sort((a, b) => (b.total ?? -1) - (a.total ?? -1));
}

/** I2: phí theo FC của một SKU trong kỳ mới nhất — "SKU này đang tốn phí ở đâu". */
export function feeByFcForSku(rows: StorageFeeUiRow[], month: string): StorageFeeUiRow[] {
  return rows
    .filter((r) => r.month === month)
    .sort((a, b) => (b.fee ?? -1) - (a.fee ?? -1));
}

/** Trend phí của một SKU/FC qua các kỳ — để thấy Q4 đội phí. */
export function feeTrend(rows: StorageFeeUiRow[]): { month: string; monthLabel: string; fee: number | null; currency: string | null }[] {
  const byMonth = new Map<string, { fee: number | null; currency: string | null }>();
  for (const r of rows) {
    const prev = byMonth.get(r.month);
    if (!prev) byMonth.set(r.month, { fee: r.fee, currency: r.currency });
    else if (prev.fee !== null && r.fee !== null && prev.currency === r.currency) {
      prev.fee = Math.round((prev.fee + r.fee) * 100) / 100;
    } else if (prev.fee === null) {
      byMonth.set(r.month, { fee: r.fee, currency: r.currency });
    }
    // khác currency → KHÔNG cộng; giữ nhóm đầu (UI sẽ hiện nhãn tiền của nhóm đó)
  }
  return [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, v]) => ({ month, monthLabel: monthLabel(month), fee: v.fee, currency: v.currency }));
}

/** I4: vấn đề của MỘT lô (drill-down từ bảng đối soát). */
export function issuesForShipment(rows: InboundIssueUiRow[], shipmentId: string): InboundIssueUiRow[] {
  return rows
    .filter((r) => sameId(r.shipmentId, shipmentId))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.fee ?? -1) - (a.fee ?? -1));
}

/** I4: ghép phí/vấn đề inbound vào bảng lô (giống mergeInboundReconcile của 0018). */
export function mergeInboundIssues<T extends { id: string }>(
  inbound: T[],
  issues: InboundIssueShipmentUiRow[],
): { rows: (T & { issueCount?: number; issueFeeLabel?: string; issueTone?: "up" | "down" | "warn" | "flat" })[]; orphans: InboundIssueShipmentUiRow[]; matched: number } {
  const byId = new Map(issues.map((r) => [r.shipmentId.trim().toUpperCase(), r]));
  let matched = 0;
  const rows = inbound.map((row) => {
    const hit = byId.get(row.id.trim().toUpperCase());
    if (!hit) return row;
    matched++;
    return { ...row, issueCount: hit.issueCount, issueFeeLabel: hit.feeLabel, issueTone: hit.tone };
  });
  const ids = new Set(inbound.map((r) => r.id.trim().toUpperCase()));
  return { rows, orphans: issues.filter((r) => !ids.has(r.shipmentId.trim().toUpperCase())), matched };
}

/** Tổng phí inbound THEO TỪNG TIỀN TỆ (không cộng gộp). */
export function issueFeesByCurrency(
  rows: InboundIssueUiRow[],
): { currency: string; fee: number; count: number }[] {
  const map = new Map<string, { fee: number; count: number }>();
  for (const r of rows) {
    if (r.fee === null) continue;
    const key = r.currency ?? "(không rõ tiền)";
    const cur = map.get(key) ?? { fee: 0, count: 0 };
    cur.fee = Math.round((cur.fee + r.fee) * 100) / 100;
    cur.count += 1;
    map.set(key, cur);
  }
  return [...map.entries()]
    .map(([currency, v]) => ({ currency, ...v }))
    .sort((a, b) => b.fee - a.fee);
}
