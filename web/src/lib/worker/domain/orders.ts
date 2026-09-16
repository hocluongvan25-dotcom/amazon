/**
 * Module 4 — Domain logic nghiệp vụ Đơn hàng & CSKH (O1–O4).
 *
 * Thuần hàm (pure) — chạy trên worker và test được không cần credentials.
 * Công thức bám tài liệu Amazon:
 *   • Orders API v0 — getOrders/getOrderItems, rate 0.0167 rps · burst 20
 *     (getOrderItems 0.5 rps · burst 30) — xem docs/ke-hoach-trien-khai-theo-module.md
 *   • Report GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL — "Order tracking
 *     report": Amazon ghi rõ report này KHÔNG chứa thông tin định danh người mua
 *     (no customer-identifying information) → đúng quyết định "không PII" v1.1.
 *   • Report GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE — mã lý do trả hàng.
 *
 * Quyết định đã chốt (docs/de-xuat-trien-khai-he-thong-vexim.md v1.1):
 *   KHÔNG xin role restricted → không gọi getOrderAddress/getOrderBuyerInfo.
 *   Đơn vị "an toàn" giữ lại: trạng thái, kênh AFN/MFN, số món, tiền, SKU,
 *   và state/country của điểm giao (KHÔNG city/postal).
 */

/* ============================================================================
 * 1. TRẠNG THÁI ĐƠN
 * ==========================================================================*/

/** Trạng thái đơn theo Orders API v0 (GetOrders — OrderStatus enum). */
export type AmazonOrderStatus =
  | "Pending"
  | "Unshipped"
  | "PartiallyShipped"
  | "Shipped"
  | "Canceled"
  | "Unfulfillable"
  | "InvoiceUnconfirmed"
  | "PendingAvailability"
  | "UpComing";

/** Trạng thái rút gọn cho màn O1 (khớp type OrderRow.status của web). */
export type OrderUiStatus = "Pending" | "Shipped" | "Cancelled" | "Delivered";

export const AMAZON_ORDER_STATUSES: AmazonOrderStatus[] = [
  "Pending",
  "Unshipped",
  "PartiallyShipped",
  "Shipped",
  "Canceled",
  "Unfulfillable",
  "InvoiceUnconfirmed",
  "PendingAvailability",
  "UpComing",
];

/**
 * Chuẩn hóa trạng thái Amazon → trạng thái UI.
 * `Delivery` không phải trạng thái của Orders API (Amazon không trả trạng thái
 * "đã giao") — chỉ suy ra từ report/notification khi có thông tin giao hàng;
 * vì vậy hàm này KHÔNG tự đoán "Delivered", để tầng trên quyết định.
 */
export function normalizeOrderStatus(raw: string): OrderUiStatus {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "canceled" || s === "cancelled") return "Cancelled";
  if (s === "shipped" || s === "partiallyshipped") return "Shipped";
  return "Pending"; // Pending, Unshipped, PendingAvailability, UpComing, InvoiceUnconfirmed, Unfulfillable, lạ
}

/** Đơn FBM (do seller tự ship) hay FBA (Amazon ship). */
export function isFbm(fulfillmentChannel: string | null | undefined): boolean {
  return (fulfillmentChannel ?? "").trim().toUpperCase() === "MFN";
}

/* ============================================================================
 * 2. ĐẾM NGƯỢC HẠN SHIP FBM (O3 — queue FBM)
 * ==========================================================================*/

/** Giờ xử lý mặc định khi report không có latest-ship-date (handling time 1 ngày). */
export const DEFAULT_HANDLING_HOURS = 24;

/** Các mốc cảnh báo của queue FBM (giờ còn lại) — SOP-06. */
export const FBM_RISK_BANDS = {
  overdue: 0, // đã quá hạn
  critical: 4, // < 4h
  warning: 12, // < 12h
} as const;

export type FbmRisk = "overdue" | "critical" | "warning" | "ok";

export type FbmDeadlineInput = {
  purchaseDate: string; // ISO 8601
  latestShipDate?: string | null; // ISO 8601 (từ getOrders/report)
  handlingHours?: number; // chỉ dùng khi thiếu latestShipDate
};

export type FbmDeadline = {
  deadline: Date;
  /** true khi phải tự suy ra hạn (report không có cột latest-ship-date) */
  assumed: boolean;
};

/**
 * Hạn ship của đơn FBM.
 * Ưu tiên `LatestShipDate` của Amazon; thiếu thì suy ra purchaseDate + handling
 * và đánh dấu `assumed=true` để UI/alert biết đây là số ước lượng.
 */
export function fbmShipDeadline(input: FbmDeadlineInput): FbmDeadline {
  if (input.latestShipDate) {
    const d = new Date(input.latestShipDate);
    if (!Number.isNaN(d.getTime())) return { deadline: d, assumed: false };
  }
  const base = new Date(input.purchaseDate);
  const hours = input.handlingHours ?? DEFAULT_HANDLING_HOURS;
  return {
    deadline: new Date(base.getTime() + hours * 3_600_000),
    assumed: true,
  };
}

/** Số giờ còn lại tới hạn (âm = trễ). Làm tròn 1 chữ số thập phân. */
export function hoursUntilDeadline(deadline: Date, now: Date = new Date()): number {
  return Math.round(((deadline.getTime() - now.getTime()) / 3_600_000) * 10) / 10;
}

/** Mức rủi ro theo số giờ còn lại. */
export function fbmRisk(hoursLeft: number): FbmRisk {
  if (hoursLeft < FBM_RISK_BANDS.overdue) return "overdue";
  if (hoursLeft < FBM_RISK_BANDS.critical) return "critical";
  if (hoursLeft < FBM_RISK_BANDS.warning) return "warning";
  return "ok";
}

/** Chuỗi đếm ngược cho cột "countdown" của O3 (vd "3h 20m", "quá hạn 5h"). */
export function countdownLabel(hoursLeft: number): string {
  const overdue = hoursLeft < 0;
  const abs = Math.abs(hoursLeft);
  const h = Math.floor(abs);
  const m = Math.round((abs - h) * 60);
  const core = h > 0 ? `${h}h ${m}m` : `${m}m`;
  return overdue ? `quá hạn ${core}` : core;
}

/* ============================================================================
 * 3. KPI ĐƠN HÀNG (O1/O3 + dashboard)
 * ==========================================================================*/

export type OrderLike = {
  amazonOrderId: string;
  status: string; // trạng thái Amazon gốc
  fulfillmentChannel?: string | null;
  purchaseDate: string;
  latestShipDate?: string | null;
  orderTotal?: number | null;
  itemsCount?: number | null;
  sku?: string | null;
  currency?: string;
};

export type OrderKpis = {
  orders: number;
  units: number;
  sales: number;
  currency: string;
  fbmUnshipped: number;
  fbmShipped: number;
  afnOrders: number;
  cancelled: number;
};

/** KPI tổng hợp danh sách đơn (O1). */
export function orderKpis(orders: OrderLike[]): OrderKpis {
  let units = 0;
  let sales = 0;
  let fbmUnshipped = 0;
  let fbmShipped = 0;
  let afnOrders = 0;
  let cancelled = 0;

  for (const o of orders) {
    units += o.itemsCount ?? 0;
    sales += o.orderTotal ?? 0;
    const status = normalizeOrderStatus(o.status);
    if (isFbm(o.fulfillmentChannel)) {
      if (status === "Pending") fbmUnshipped += 1;
      else if (status === "Shipped") fbmShipped += 1;
    } else if ((o.fulfillmentChannel ?? "").trim().toUpperCase() === "AFN") {
      afnOrders += 1;
    }
    if (status === "Cancelled") cancelled += 1;
  }

  return {
    orders: orders.length,
    units,
    sales: Math.round(sales * 100) / 100,
    currency: orders.find((o) => o.currency)?.currency ?? "USD",
    fbmUnshipped,
    fbmShipped,
    afnOrders,
    cancelled,
  };
}

/**
 * Tỷ lệ ship đúng hạn (%) — chỉ tính đơn đã ship có mốc hạn.
 * Đơn chưa ship (còn trong hạn) KHÔNG bị tính là trễ (tránh báo động giả).
 */
export function onTimeShipRate(
  shipped: { shippedAt: string; latestShipDate: string }[],
): number | null {
  const rows = shipped.filter(
    (r) => r.shippedAt && r.latestShipDate && !Number.isNaN(new Date(r.shippedAt).getTime()),
  );
  if (rows.length === 0) return null;
  const onTime = rows.filter((r) => new Date(r.shippedAt) <= new Date(r.latestShipDate)).length;
  return Math.round((onTime / rows.length) * 1000) / 10;
}

/** Danh sách FBM cần xử lý (O3): chỉ đơn chưa ship, sắp xếp hạn gần nhất lên đầu. */
export type FbmQueueItem = {
  amazonOrderId: string;
  purchaseDate: string;
  deadline: Date;
  deadlineAssumed: boolean;
  hoursLeft: number;
  risk: FbmRisk;
  countdown: string;
  sku: string | null;
  itemsCount: number;
};

export function buildFbmQueue(
  orders: OrderLike[],
  now: Date = new Date(),
  opts?: { handlingHours?: number; includeShipped?: boolean },
): FbmQueueItem[] {
  return orders
    .filter((o) => isFbm(o.fulfillmentChannel))
    .filter((o) => (opts?.includeShipped ? true : normalizeOrderStatus(o.status) === "Pending"))
    .map((o) => {
      const { deadline, assumed } = fbmShipDeadline({
        purchaseDate: o.purchaseDate,
        latestShipDate: o.latestShipDate,
        handlingHours: opts?.handlingHours,
      });
      const hoursLeft = hoursUntilDeadline(deadline, now);
      return {
        amazonOrderId: o.amazonOrderId,
        purchaseDate: o.purchaseDate,
        deadline,
        deadlineAssumed: assumed,
        hoursLeft,
        risk: fbmRisk(hoursLeft),
        countdown: countdownLabel(hoursLeft),
        sku: o.sku ?? null,
        itemsCount: o.itemsCount ?? 0,
      };
    })
    .sort((a, b) => a.hoursLeft - b.hoursLeft);
}

/* ============================================================================
 * 4. RETURNS & REFUNDS (O4)
 * ==========================================================================*/

export type ReturnReasonGroup =
  | "quality" // hàng lỗi/hỏng/không như mô tả
  | "size" // sai cỡ/màu
  | "logistics" // giao trễ/giao sai/thiếu
  | "remorse" // đổi ý, không cần nữa
  | "other";

/**
 * Bảng nhóm lý do trả hàng theo mã/chuỗi Amazon.
 * Amazon trả "Return Reason" dạng text (vd "No longer needed", "Item defective or
 * doesn't work"); mã máy đọc (APPAREL_TOO_SMALL…) xuất hiện ở một số báo cáo/XML.
 * Hàm tra bảng chấp nhận CẢ HAI: khớp theo mã trước, sau đó khớp text (chuẩn hóa).
 */
const RETURN_REASON_TABLE: { match: string[]; label: string; group: ReturnReasonGroup }[] = [
  { match: ["no longer needed", "no_longer_needed", "unwanted_item", "ordered_by_mistake", "ordered_wrong_item", "bought_by_mistake"], label: "Không cần nữa / đặt nhầm", group: "remorse" },
  { match: ["item defective or doesn't work", "defective", "item_defective", "damaged", "damaged_item", "item_damaged", "missing parts", "missing_parts", "parts_missing", "quality", "does_not_work", "not_working"], label: "Hàng lỗi / hư hỏng / thiếu phụ kiện", group: "quality" },
  { match: ["not as described", "not_as_described", "wrong item was sent", "wrong_item", "material different", "performance or quality not adequate", "not_compatible", "incompatible", "missing_item", "item_not_as_described"], label: "Không đúng mô tả", group: "quality" },
  { match: ["too small", "too_small", "apparel_too_small", "size too small", "fit_too_small"], label: "Sai cỡ (quá nhỏ)", group: "size" },
  { match: ["too large", "too_large", "apparel_too_large", "size too large", "fit_too_large"], label: "Sai cỡ (quá lớn)", group: "size" },
  { match: ["style", "color", "apparel_style", "wrong_color", "different color", "size_or_fit"], label: "Sai mẫu/màu/kích thước", group: "size" },
  { match: ["arrived late", "too_late", "arrived_too_late", "late_delivery", "delivery_late"], label: "Giao quá trễ", group: "logistics" },
  { match: ["unauthorized purchase", "unauthorized_purchase", "unauthorized"], label: "Mua không được phép (nghi gian lận)", group: "logistics" },
  { match: ["shipping_address_undeliverable", "undeliverable", "customer_returned_item", "return_to_sender"], label: "Không giao được / hoàn về người gửi", group: "logistics" },
];

/** Chuẩn hóa chuỗi để so khớp (bỏ dấu câu, gạch dưới → khoảng trắng, lowercase). */
export function normalizeReasonKey(raw: string): string {
  return (raw ?? "")
    .trim()
    .toLowerCase()
    // Bỏ mọi ký tự không phải chữ/số ("No_Longer-Needed!" → "no longer needed")
    // nhưng GIỮ chữ có dấu tiếng Việt (\p{L}) để không phá dữ liệu nội bộ.
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type ReturnReasonInfo = {
  raw: string;
  /** mã/khóa đã chuẩn hóa để group by ổn định */
  code: string;
  label: string;
  group: ReturnReasonGroup;
};

/**
 * Dịch "Return Reason" Amazon → nhãn tiếng Việt + nhóm phân tích.
 * Không khớp bảng → giữ nguyên chuỗi gốc làm nhãn, nhóm "other"
 * (không bao giờ nuốt mất dữ liệu lạ của Amazon).
 */
export function returnReasonLabel(raw: string): ReturnReasonInfo {
  const code = normalizeReasonKey(raw);
  if (!code) return { raw: raw ?? "", code: "unknown", label: "Không rõ lý do", group: "other" };

  for (const entry of RETURN_REASON_TABLE) {
    // khớp theo mã (chính xác) hoặc theo text (chứa)
    if (entry.match.some((m) => normalizeReasonKey(m) === code)) {
      return { raw, code, label: entry.label, group: entry.group };
    }
  }
  for (const entry of RETURN_REASON_TABLE) {
    if (entry.match.some((m) => code.includes(normalizeReasonKey(m)))) {
      return { raw, code, label: entry.label, group: entry.group };
    }
  }
  return { raw, code, label: raw.trim(), group: "other" };
}

export type ReturnLike = {
  amazonOrderId?: string | null;
  sku?: string | null;
  returnDate: string;
  reason: string;
  refundAmount?: number | null;
  currency?: string;
};

export type ReturnReasonSummary = {
  code: string;
  label: string;
  group: ReturnReasonGroup;
  count: number;
  refundAmount: number;
  sharePct: number;
};

/** Bảng "lý do lặp lại nhiều" cho O4 (sắp theo số lượng giảm dần). */
export function returnsBreakdown(returns: ReturnLike[]): ReturnReasonSummary[] {
  const map = new Map<string, ReturnReasonSummary>();
  let total = 0;
  let refundTotal = 0;

  for (const r of returns) {
    total += 1;
    refundTotal += Math.abs(r.refundAmount ?? 0);
    const info = returnReasonLabel(r.reason);
    const cur = map.get(info.code) ?? {
      code: info.code,
      label: info.label,
      group: info.group,
      count: 0,
      refundAmount: 0,
      sharePct: 0,
    };
    cur.count += 1;
    cur.refundAmount = Math.round((cur.refundAmount + Math.abs(r.refundAmount ?? 0)) * 100) / 100;
    map.set(info.code, cur);
  }

  return [...map.values()]
    .map((r) => ({
      ...r,
      sharePct: total > 0 ? Math.round((r.count / total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.count - a.count || b.refundAmount - a.refundAmount);
}

/** Tỷ lệ trả hàng (%) theo SKU — đơn vị bán lấy từ report orders cùng kỳ. */
export function returnRatePct(unitsSold: number, returns: number): number | null {
  if (unitsSold <= 0) return null;
  return Math.round((returns / unitsSold) * 1000) / 10;
}

/**
 * Cờ "SKU bị trả nhiều" — điểm nóng chất lượng (SOP-07).
 * Ngưỡng mặc định 3 đơn trả trong kỳ, hoặc tỷ lệ trả ≥ 5%.
 */
export const RETURN_HOTSPOT_COUNT = 3;
export const RETURN_HOTSPOT_RATE_PCT = 5;

export function returnHotspots(
  returns: ReturnLike[],
  unitsBySku: Record<string, number> = {},
): {
  sku: string;
  returns: number;
  reasons: ReturnReasonSummary[];
  unitsSold: number | null;
  ratePct: number | null;
  hot: boolean;
}[] {
  const bySku = new Map<string, ReturnLike[]>();
  for (const r of returns) {
    const sku = (r.sku ?? "").trim();
    if (!sku) continue;
    bySku.set(sku, [...(bySku.get(sku) ?? []), r]);
  }

  return [...bySku.entries()]
    .map(([sku, rows]) => {
      const unitsSold = unitsBySku[sku] ?? null;
      const ratePct = unitsSold === null ? null : returnRatePct(unitsSold, rows.length);
      return {
        sku,
        returns: rows.length,
        reasons: returnsBreakdown(rows),
        unitsSold,
        ratePct,
        hot:
          rows.length >= RETURN_HOTSPOT_COUNT ||
          (ratePct !== null && ratePct >= RETURN_HOTSPOT_RATE_PCT),
      };
    })
    .sort((a, b) => b.returns - a.returns);
}

/* ============================================================================
 * 5. CỬA SỔ ĐỒNG BỘ DELTA (getOrders)
 * ==========================================================================*/

/** Chồng lấn mặc định khi kéo delta (phút) — tránh sót đơn cập nhật trễ. */
export const DELTA_OVERLAP_MINUTES = 5;

/**
 * Cửa sổ kéo delta cho getOrders.
 * Quy tắc: dùng LastUpdatedAfter = (lần đồng bộ trước − chồng lấn) và KHÔNG
 * truyền LastUpdatedBefore (để lần sau luôn tiến tới) — ghi lại `watermark`
 * = thời điểm bắt đầu lần chạy để lần sau dùng tiếp.
 */
export function orderDeltaWindow(
  lastSyncAt: Date | null,
  now: Date = new Date(),
  overlapMinutes = DELTA_OVERLAP_MINUTES,
): { lastUpdatedAfter: Date; watermark: Date } {
  if (!lastSyncAt) {
    // Lần đầu: Backfill 30 ngày (đúng "Definition of ready to plug" mục 5)
    return { lastUpdatedAfter: new Date(now.getTime() - 30 * 86_400_000), watermark: now };
  }
  return {
    lastUpdatedAfter: new Date(lastSyncAt.getTime() - overlapMinutes * 60_000),
    watermark: now,
  };
}

/**
 * Độ trễ dữ liệu HỆ THỐNG của getOrders do Amazon công bố: đơn tạo/cập nhật trong
 * ~2 phút gần nhất CHƯA xuất hiện trong kết quả. Vì vậy `CreatedBefore` /
 * `LastUpdatedBefore` mà KHÔNG sớm hơn "giờ hiện tại" ít nhất 2 phút là bị từ chối
 * bằng 400 InvalidInput (sự cố 16/09/2026: runner truyền `watermark = now` nên MỌI
 * shop đều lỗi, màn /orders không bao giờ có đơn).
 */
export const SP_API_ORDERS_DATA_LAG_MINUTES = 2;

/** Biên độ an toàn cộng thêm: lệch đồng hồ giữa máy ta và server Amazon + thời gian mạng. */
export const SP_API_BEFORE_SAFETY_MARGIN_MINUTES = 1;

/** Tổng số phút phải lùi mốc "...Before" so với `now` (2 phút trễ + 1 phút biên độ). */
export const SP_API_BEFORE_LAG_TOTAL_MS =
  (SP_API_ORDERS_DATA_LAG_MINUTES + SP_API_BEFORE_SAFETY_MARGIN_MINUTES) * 60_000;

/**
 * Mốc chặn trên AN TOÀN cho getOrders (`LastUpdatedBefore`/`CreatedBefore`):
 * `now − (2 phút trễ dữ liệu + 1 phút biên độ)`. KHÔNG BAO GIỜ truyền `now` hoặc
 * mốc mới hơn — Amazon sẽ trả 400 InvalidInput. Kéo delta bỏ lỡ cửa sổ 3 phút cuối
 * cũng không sao: lần chạy sau chồng lấn lại (DELTA_OVERLAP_MINUTES) và cửa sổ mặc
 * định nhìn lại nhiều ngày.
 */
export function spApiSafeBefore(now: Date = new Date(), extraMarginMinutes = 0): Date {
  return new Date(now.getTime() - SP_API_BEFORE_LAG_TOTAL_MS - extraMarginMinutes * 60_000);
}

/* ============================================================================
 * 6. CẢNH BÁO (alert_rules đã seed ở migration 0001/0010)
 * ==========================================================================*/

/** Hạn ship FBM sắp hết (< 4h) hoặc đã trễ → alert rule `fbm_late_ship`. */
export function fbmShipAlert(queue: FbmQueueItem[]): {
  ruleCode: string;
  severity: "red" | "amber";
  title: string;
  detail: string;
} | null {
  const overdue = queue.filter((q) => q.risk === "overdue");
  const urgent = queue.filter((q) => q.risk === "critical");
  if (overdue.length === 0 && urgent.length === 0) return null;

  const parts: string[] = [];
  if (overdue.length > 0) parts.push(`${overdue.length} đơn ĐÃ TRỄ hạn ship`);
  if (urgent.length > 0) parts.push(`${urgent.length} đơn còn < ${FBM_RISK_BANDS.critical}h`);
  const first = queue[0];

  return {
    ruleCode: "fbm_late_ship",
    severity: overdue.length > 0 ? "red" : "amber",
    title: `FBM: ${parts.join(" · ")}`,
    detail:
      `Đơn gấp nhất ${first.amazonOrderId} (${first.countdown}, hạn ` +
      `${first.deadline.toISOString()}${first.deadlineAssumed ? " — hạn ước lượng do thiếu latest-ship-date" : ""}). ` +
      `Xử lý theo SOP-06.`,
  };
}
