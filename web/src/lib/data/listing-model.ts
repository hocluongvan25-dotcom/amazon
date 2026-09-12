/**
 * Data model cho Module 1 (Listing & Content) — đọc từ Supabase public views.
 * Views: vexim_listings, vexim_listing_queue
 */

import type {
  ListingIssueItem,
  ListingListRow,
  ListingQueueItem,
  ListingSource,
  ListingStatus,
} from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Raw shape từ Supabase view                                         */
/* ------------------------------------------------------------------ */

/** vexim_listings */
export type ListingRaw = {
  id: string;
  seller_account_id: string;
  shop: string;
  sku: string;
  asin: string | null;
  title: string | null;
  status: string;
  price: number | null;
  currency: string | null;
  updated_at: string;
  error_count: number;
  warning_count: number;
  issues: unknown;
  buy_box_won: boolean | null;
  buy_box_price: number | null;
  competitor_price: number | null;
  offer_captured_at: string | null;
  /* ↓ migration 0016 — cột nối thêm ở CUỐI view */
  product_type?: string | null;
  buyable?: boolean | null;
  discoverable?: boolean | null;
  quantity?: number | null;
  stranded_reason?: string | null;
  enforcement_actions?: unknown;
  last_source?: string | null;
  last_synced_at?: string | null;
  /* ↓ migration 0017 — doanh số 30 ngày + người phụ trách (nối CUỐI view) */
  units_30d?: number | null;
  orders_30d?: number | null;
  revenue_30d?: number | null;
  revenue_currency?: string | null;
  velocity_30d?: number | null;
  last_order_at?: string | null;
  owner?: string | null;
};

/** vexim_listing_queue — cùng shape nhưng chỉ dòng có vấn đề */
export type ListingQueueRaw = ListingRaw;

/* ------------------------------------------------------------------ */
/* Select strings                                                      */
/* ------------------------------------------------------------------ */

/** 7 cột 0017 nối CUỐI cả hai view — harness BƯỚC 18 soát đúng thứ tự này. */
export const LISTING_SALES_COLUMNS = [
  "units_30d",
  "orders_30d",
  "revenue_30d",
  "revenue_currency",
  "velocity_30d",
  "last_order_at",
  "owner",
] as const;

const SALES_TAIL = LISTING_SALES_COLUMNS.join(",");

/**
 * PostgREST select theo TÊN: thiếu/sai 1 cột là PGRST204 và SẬP CẢ TRANG L1.
 */
export const LISTINGS_SELECT =
  "id,seller_account_id,shop,sku,asin,title,status,price,currency,updated_at,error_count,warning_count,issues,buy_box_won,buy_box_price,competitor_price,offer_captured_at,product_type,buyable,discoverable,quantity,stranded_reason,enforcement_actions,last_source,last_synced_at," +
  SALES_TAIL;

/** vexim_listing_queue KHÔNG có cột offer → select riêng, tránh lỗi PGRST204. */
export const LISTING_QUEUE_SELECT =
  "id,seller_account_id,shop,sku,asin,title,status,price,currency,updated_at,error_count,warning_count,issues,quantity,stranded_reason,enforcement_actions,product_type,last_source,last_synced_at,buyable,discoverable," +
  SALES_TAIL;

/**
 * Màu + nhãn trạng thái — MỘT bản dùng chung cho demo và live, để thêm trạng thái
 * mới (REMOVED/CLOSED/DELETED/UNKNOWN của 0016) không phải sửa hai chỗ.
 */
export const LISTING_STATUS_TONE: Record<ListingStatus, "green" | "amber" | "red" | "gray"> = {
  ACTIVE: "green",
  INACTIVE: "amber",
  STRANDED: "red",
  SUPPRESSED: "red",
  REMOVED: "gray",
  CLOSED: "gray",
  DELETED: "gray",
  UNKNOWN: "amber",
};

export const LISTING_STATUS_VI: Record<ListingStatus, string> = {
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  STRANDED: "Stranded",
  SUPPRESSED: "Bị ẩn (suppressed)",
  REMOVED: "Đã gỡ (removal)",
  CLOSED: "Đã đóng",
  DELETED: "Đã xoá",
  UNKNOWN: "Chưa rõ — cần soi lại",
};

export const LISTING_SOURCE_VI: Record<string, string> = {
  report: "Report Seller Central",
  api: "Listings Items API",
  notification: "Notification (realtime)",
  manual: "Nhập tay",
};

/* ------------------------------------------------------------------ */
/* Mapping                                                             */
/* ------------------------------------------------------------------ */

/**
 * Chuẩn hoá trạng thái. Report cũ seed 'active' chữ thường, worker ghi 'ACTIVE';
 * 0016 thêm REMOVED/CLOSED/DELETED và UNKNOWN (report ghi trạng thái không đọc được).
 * KHÔNG ép trạng thái lạ về INACTIVE — sai một chữ là L1 đếm nhầm listing chết.
 */
export function normalizeStatus(raw: string | null | undefined): ListingStatus {
  const s = (raw ?? "").trim().toUpperCase();
  switch (s) {
    case "ACTIVE":
    case "INACTIVE":
    case "STRANDED":
    case "SUPPRESSED":
    case "REMOVED":
    case "CLOSED":
    case "DELETED":
      return s;
    default:
      return "UNKNOWN";
  }
}

/**
 * Issue JSONB → ListingIssueItem[] để hiển thị (L2).
 *
 * Nhận cả hai hình dạng:
 *   • nguyên văn Amazon (0016 worker ghi): { code, message, severity, attributeNames,
 *     categories, enforcements: { actions: [...] } }
 *   • dạng phẳng cũ (demo/seed): { …, enforcement: "SEARCH_SUPPRESSED" }
 * Thiếu mã → "—", thiếu severity → INFO. KHÔNG bịa thêm field.
 */
export function normalizeIssues(raw: unknown): ListingIssueItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ListingIssueItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const i = entry as Record<string, unknown>;
    const severityRaw = String(i.severity ?? "").toUpperCase();
    const severity: ListingIssueItem["severity"] =
      severityRaw === "ERROR" ? "ERROR" : severityRaw === "WARNING" ? "WARNING" : "INFO";

    // enforcements.actions (Amazon) → chuỗi nhãn; dạng phẳng cũ dùng `enforcement`
    let enforcement: string | undefined;
    const enf = i.enforcements as { actions?: unknown } | undefined;
    if (enf && Array.isArray(enf.actions) && enf.actions.length > 0) {
      enforcement = enf.actions.map((a) => String(a)).join(", ");
    } else if (typeof i.enforcement === "string" && i.enforcement) {
      enforcement = i.enforcement;
    }

    out.push({
      code: typeof i.code === "string" && i.code ? i.code : "—",
      severity,
      message: typeof i.message === "string" && i.message ? i.message : "—",
      attributeNames: Array.isArray(i.attributeNames) ? i.attributeNames.map((a) => String(a)) : [],
      ...(enforcement ? { enforcement } : {}),
    });
  }
  return out;
}

/** enforcement_actions JSONB → mảng nhãn (Amazon trả ['SEARCH_SUPPRESSED', …]). */
export function normalizeEnforcements(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((a) => String(a)).filter(Boolean);
}

function toSource(raw: string | null | undefined): ListingSource | null {
  switch (raw) {
    case "report":
    case "api":
    case "notification":
    case "manual":
      return raw;
    default:
      return null;
  }
}

export function formatPrice(price: number | null, currency: string | null): string {
  if (price === null) return "—";
  return `$${price.toFixed(2)}`;
}

/**
 * Doanh thu 30 ngày → chuỗi hiển thị.
 * `currency = null` = đơn của shop lẫn nhiều tiền tệ: view KHÔNG cộng gộp và ta
 * cũng không tự quy đổi (không có tỷ giá thật) → báo rõ thay vì in một số sai.
 */
export function formatRevenue30d(amount: number | null, currency: string | null): string {
  if (amount === null) return "—";
  const n = amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (currency === null) return `${n} ⚠ lẫn tiền tệ`;
  return currency === "USD" ? `$${n}` : `${n} ${currency}`;
}

/** Doanh thu/ngày (L4 xếp ưu tiên theo "đang mất bao nhiêu tiền mỗi ngày"). */
export function formatRevenuePerDay(amount30d: number | null, currency: string | null): string {
  if (amount30d === null) return "—";
  return `${formatRevenue30d(Math.round((amount30d / 30) * 100) / 100, currency)}/ngày`;
}

/**
 * Sort theo doanh thu: SKU CHƯA CÓ ĐƠN xếp cuối, không chen lên đầu như thể
 * doanh thu thấp nhất (cùng luật với sort biên của P1).
 */
export function revenueSortValue(r: { revenue30d: number | null }): number {
  return r.revenue30d ?? Number.NEGATIVE_INFINITY;
}

function timeAgo(updatedAt: string): string {
  const now = new Date();
  const updated = new Date(updatedAt);
  const diffMs = now.getTime() - updated.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  if (diffHours < 1) return "vừa xong";
  if (diffHours < 24) return `${diffHours} giờ trước`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "hôm qua";
  return `${diffDays} ngày trước`;
}

/** Map 1 dòng vexim_listings → ListingListRow cho UI (L1) */
export function mapListingRow(raw: ListingRaw): ListingListRow {
  const issues = normalizeIssues(raw.issues);
  return {
    sku: raw.sku,
    asin: raw.asin ?? "—",
    title: raw.title ?? "—",
    shop: raw.shop,
    brand: "—", // catalog.listings chưa có brand — chờ Catalog API
    status: normalizeStatus(raw.status),
    price: formatPrice(raw.price, raw.currency),
    // quantity từ report Merchant Listings / getListingsItem; null = chưa biết
    stock: raw.quantity ?? null,
    // Đếm từ mảng issue khi có chi tiết (view 0016 đã ưu tiên mảng), fallback bộ đếm
    issueErrors: issues.length > 0 ? issues.filter((i) => i.severity === "ERROR").length : Number(raw.error_count ?? 0),
    issueWarnings: issues.length > 0 ? issues.filter((i) => i.severity === "WARNING").length : Number(raw.warning_count ?? 0),
    // iam.module_owner(shop, 'listings') — tên nhân viên VEXIM, không email/không uuid
    owner: raw.owner ?? "—",
    // 0017: NULL = chưa có đơn nào trong 30 ngày (không suy ra 0)
    revenue30d: raw.revenue_30d ?? null,
    revenueCurrency: raw.revenue_currency ?? null,
    units30d: raw.units_30d ?? null,
    lastOrderAt: raw.last_order_at ?? null,
    updated: timeAgo(raw.updated_at),
    issues,
    productType: raw.product_type ?? null,
    buyable: raw.buyable ?? null,
    discoverable: raw.discoverable ?? null,
    strandedReason: raw.stranded_reason ?? null,
    enforcementActions: normalizeEnforcements(raw.enforcement_actions),
    lastSource: toSource(raw.last_source ?? null),
    lastSyncedAt: raw.last_synced_at ?? null,
  };
}

/**
 * Map vexim_listing_queue → ListingQueueItem cho UI (L4).
 *
 * Nguyên nhân ưu tiên theo thứ tự người xử lý cần biết:
 *   1. lý do STRANDED từ report (có hàng kẹt FC — mất tiền thật, SOP-03 bước 6)
 *   2. enforcement Amazon đang áp (SEARCH_SUPPRESSED → mất traffic)
 *   3. issue ERROR đầu tiên (có mã để tra cứu)
 *   4. trạng thái
 */
export function mapListingQueueItem(raw: ListingQueueRaw): ListingQueueItem {
  const issues = normalizeIssues(raw.issues);
  const status = normalizeStatus(raw.status);
  const firstError = issues.find((i) => i.severity === "ERROR") ?? issues[0] ?? null;
  const enforcements = normalizeEnforcements(raw.enforcement_actions);
  const strandedReason = (raw.stranded_reason ?? "").trim() || null;

  let cause: string;
  let causeCode: string;
  if (strandedReason) {
    cause = `Stranded — ${strandedReason}${raw.quantity ? ` · ${raw.quantity} đơn vị kẹt tại FC` : ""}`;
    causeCode = firstError?.code ?? "STRANDED";
  } else if (enforcements.length > 0) {
    cause = `Amazon đang áp: ${enforcements.join(", ")}${firstError ? ` — ${firstError.message}` : ""}`;
    causeCode = enforcements[0];
  } else if (firstError) {
    cause = firstError.message;
    causeCode = firstError.code;
  } else if (status === "UNKNOWN") {
    cause = "Report ghi trạng thái không đọc được — cần soi lại bằng getListingsItem";
    causeCode = "UNKNOWN";
  } else {
    cause = `Listing ${status.toLowerCase()}`;
    causeCode = status;
  }

  const suggestion = buildSuggestion(causeCode, status, { strandedReason, enforcements, buyable: raw.buyable ?? null, discoverable: raw.discoverable ?? null });

  // Ưu tiên: stranded/enforcement → cao nhất (đang mất tiền hoặc mất hiển thị),
  // rồi tới ERROR, WARNING; còn lại thấp.
  const priority: ListingQueueItem["priority"] =
    strandedReason !== null || enforcements.length > 0 || Number(raw.error_count ?? 0) > 0
      ? "red"
      : Number(raw.warning_count ?? 0) > 0 || issues.length > 0
        ? "amber"
        : status === "UNKNOWN"
          ? "amber"
          : "gray";
  const priorityLabel = priority === "red" ? "Cao" : priority === "amber" ? "Vừa" : "Thấp";

  return {
    sku: raw.sku,
    asin: raw.asin ?? "—",
    shop: raw.shop,
    cause,
    causeCode,
    suggestion,
    owner: raw.owner ?? "—",
    slaLabel: strandedReason ? "24h — có hàng kẹt FC" : "chưa gán",
    // 0017: doanh thu/ngày thật từ Orders — L4 biết listing nào đang mất tiền nhiều nhất
    revenue30d: raw.revenue_30d ?? null,
    revenuePerDay: formatRevenuePerDay(raw.revenue_30d ?? null, raw.revenue_currency ?? null),
    priority,
    priorityLabel,
  };
}

function buildSuggestion(
  causeCode: string,
  status: ListingStatus,
  ctx: {
    strandedReason: string | null;
    enforcements: string[];
    buyable: boolean | null;
    discoverable: boolean | null;
  } = { strandedReason: null, enforcements: [], buyable: null, discoverable: null },
): string {
  // Mất BUYABLE/DISCOVERABLE là nguyên nhân "listing ACTIVE mà không bán được"
  if (ctx.buyable === false) {
    return "Mất BUYABLE → không mua được dù listing ACTIVE: sửa issue ERROR rồi chờ Amazon xét lại (SOP-03 bước 2–4)";
  }
  if (ctx.discoverable === false) {
    return "Mất DISCOVERABLE → bị ẩn khỏi tìm kiếm: bổ sung thuộc tính/ảnh thiếu theo issue (SOP-03 bước 2)";
  }
  if (ctx.strandedReason || status === "STRANDED") {
    return ctx.strandedReason
      ? `Stranded: ${ctx.strandedReason} → sửa listing hoặc tạo removal order (SOP-03 bước 6)`
      : "Kiểm tra nguyên nhân stranded → sửa listing hoặc tạo removal (SOP-03 bước 6)";
  }
  if (ctx.enforcements.includes("SEARCH_SUPPRESSED")) {
    return "SEARCH_SUPPRESSED → bổ sung ảnh swatch 500×500+ cho biến thể (SOP-03 bước 2)";
  }
  if (ctx.enforcements.includes("LISTING_SUPPRESSED")) {
    return "LISTING_SUPPRESSED → sửa issue ERROR chặn hiển thị rồi request xét lại (SOP-03 bước 4)";
  }
  if (causeCode === "90220") {
    return "Bổ sung product_description (SOP-03: soạn bản sửa → duyệt → publish)";
  }
  if (causeCode === "8541") {
    return "Bổ sung thuộc tính thiếu theo cảnh báo (SOP-03)";
  }
  if (causeCode === "UNKNOWN" || status === "UNKNOWN") {
    return "Chạy worker listings:sync --details để lấy issue thật từ getListingsItem rồi mới kết luận";
  }
  if (status === "INACTIVE" || status === "CLOSED") {
    return "Listing không ACTIVE: kiểm tra tồn kho/giá, rồi relist qua Seller Central hoặc L3 (SOP-03)";
  }
  return "Xác định nguyên nhân từ issues list → sửa tại Seller Central (SOP-03)";
}

/* ------------------------------------------------------------------ */
/* Derived metrics                                                     */
/* ------------------------------------------------------------------ */

export function computeListingKpis(rows: ListingListRow[]) {
  const active = rows.filter((r) => r.status === "ACTIVE").length;
  const stranded = rows.filter((r) => r.status === "STRANDED").length;
  const inactive = rows.filter((r) => r.status === "INACTIVE").length;
  const suppressed = rows.filter((r) => r.status === "SUPPRESSED").length;
  const unknown = rows.filter((r) => r.status === "UNKNOWN").length;
  const withErrors = rows.filter((r) => r.issueErrors > 0).length;
  // "ACTIVE" mà không mua được / không hiển thị — loại lỗi report không nói ra
  const notBuyable = rows.filter((r) => r.buyable === false).length;
  const notDiscoverable = rows.filter((r) => r.discoverable === false).length;
  // Report ghi ACTIVE nhưng thực tế không bán được — loại lỗi chỉ 0016 mới thấy
  const notSellableWhileActive = rows.filter(
    (r) =>
      r.status === "ACTIVE" &&
      (r.buyable === false || r.discoverable === false || r.enforcementActions.length > 0),
  ).length;
  const enforced = rows.filter((r) => r.enforcementActions.length > 0).length;
  const withDetail = rows.filter((r) => r.issues.length > 0).length;

  return [
    {
      label: "Listing active",
      value: active.toLocaleString("en-US"),
      sub: `${rows.length} tổng SKU${unknown > 0 ? ` · ${unknown} chưa rõ trạng thái` : ""}`,
      tone: unknown > 0 ? ("warn" as const) : ("up" as const),
    },
    {
      label: "Stranded / inactive",
      value: String(stranded + inactive),
      sub: `${stranded} stranded · ${suppressed} suppressed${enforced > 0 ? ` · ${enforced} bị Amazon chặn` : ""}`,
      tone: stranded + inactive > 0 ? ("down" as const) : ("up" as const),
    },
    {
      label: "Listing có lỗi",
      value: String(withErrors),
      sub: withDetail > 0
        ? `${withDetail} SKU có issue chi tiết từ Amazon`
        : "chưa có issue chi tiết — chạy listings:sync --details",
      tone: withErrors > 0 ? ("down" as const) : ("flat" as const),
    },
    {
      // Đếm theo DÒNG, không cộng hai cờ: một SKU mất cả BUYABLE lẫn DISCOVERABLE
      // mà cộng lại thành 2 là báo sai số việc phải làm.
      label: "ACTIVE nhưng không bán được",
      value: String(notSellableWhileActive),
      sub: `${notBuyable} mất BUYABLE · ${notDiscoverable} mất DISCOVERABLE · ${enforced} bị Amazon chặn`,
      tone: notSellableWhileActive > 0 ? ("down" as const) : ("flat" as const),
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Phân trang PostgREST                                                */
/* ------------------------------------------------------------------ */

export type PageResult = { data: unknown[] | null; error: unknown };

export async function readAll<T>(
  read: (from: number, to: number) => PromiseLike<PageResult>,
): Promise<T[]> {
  const rows: T[] = [];
  const size = 500;
  for (let from = 0; ; from += size) {
    const result = await read(from, from + size - 1);
    if (result.error || !result.data)
      throw new Error("Listing data unavailable");
    rows.push(...(result.data as T[]));
    if (result.data.length < size) return rows;
  }
}
