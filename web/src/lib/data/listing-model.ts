/**
 * Data model cho Module 1 (Listing & Content) — đọc từ Supabase public views.
 * Views: vexim_listings, vexim_listing_queue
 */

import type { ListingListRow, ListingStatus, ListingQueueItem } from "@/lib/types";

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
};

/** vexim_listing_queue — cùng shape nhưng chỉ dòng có vấn đề */
export type ListingQueueRaw = ListingRaw;

/* ------------------------------------------------------------------ */
/* Select strings                                                      */
/* ------------------------------------------------------------------ */

export const LISTINGS_SELECT =
  "id,seller_account_id,shop,sku,asin,title,status,price,currency,updated_at,error_count,warning_count,issues,buy_box_won,buy_box_price,competitor_price,offer_captured_at";

/* ------------------------------------------------------------------ */
/* Mapping                                                             */
/* ------------------------------------------------------------------ */

function normalizeStatus(raw: string): ListingStatus {
  const s = raw.toUpperCase();
  if (s === "ACTIVE") return "ACTIVE";
  if (s === "INACTIVE") return "INACTIVE";
  if (s === "STRANDED") return "STRANDED";
  if (s === "SUPPRESSED") return "SUPPRESSED";
  return "INACTIVE";
}

export function formatPrice(price: number | null, currency: string | null): string {
  if (price === null) return "—";
  return `$${price.toFixed(2)}`;
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
  return {
    sku: raw.sku,
    asin: raw.asin ?? "—",
    title: raw.title ?? "—",
    shop: raw.shop,
    brand: "—", // catalog.listings chưa có brand — chờ Catalog API
    status: normalizeStatus(raw.status),
    price: formatPrice(raw.price, raw.currency),
    stock: 0, // catalog.listings chưa có stock — chờ Inventory sync
    issueErrors: raw.error_count,
    issueWarnings: raw.warning_count,
    owner: "—", // iam.assignments chưa join — chờ RBAC full
    revenue30d: 0, // chưa có trong listings view — chờ Orders join
    updated: timeAgo(raw.updated_at),
  };
}

/** Map vexim_listing_queue → ListingQueueItem cho UI (L4) */
export function mapListingQueueItem(raw: ListingQueueRaw): ListingQueueItem {
  const issues = Array.isArray(raw.issues) ? raw.issues : [];
  const firstError = issues.find(
    (i: { severity?: string }) => i?.severity === "ERROR",
  );
  const firstIssue = issues[0];

  // Xác định nguyên nhân từ issue đầu tiên
  const cause = firstIssue?.message ?? (raw.status === "stranded" ? "Stranded" : "Không rõ");
  const causeCode = firstIssue?.code ?? raw.status.toUpperCase();

  // Đề xuất sửa theo causeCode (đơn giản)
  const suggestion = buildSuggestion(causeCode, raw.status);

  // Ưu tiên: có error → cao, có warning → vừa, còn lại → thấp
  const priority: ListingQueueItem["priority"] =
    raw.error_count > 0 ? "red" : raw.warning_count > 0 ? "amber" : "gray";
  const priorityLabel = priority === "red" ? "Cao" : priority === "amber" ? "Vừa" : "Thấp";

  return {
    sku: raw.sku,
    asin: raw.asin ?? "—",
    shop: raw.shop,
    cause,
    causeCode,
    suggestion,
    owner: "—",
    slaLabel: "chưa gán",
    revenuePerDay: "—",
    priority,
    priorityLabel,
  };
}

function buildSuggestion(causeCode: string, status: string): string {
  if (status === "stranded" || status === "STRANDED") {
    return "Kiểm tra nguyên nhân stranded → sửa listing hoặc tạo removal (SOP-03 bước 6)";
  }
  if (causeCode === "90220") {
    return "Bổ sung product_description (SOP-03: soạn bản sửa → duyệt → publish)";
  }
  if (causeCode === "SEARCH_SUPPRESSED") {
    return "Bổ sung ảnh swatch 500×500+ cho biến thể (SOP-03 bước 2)";
  }
  if (causeCode === "8541") {
    return "Bổ sung thuộc tính thiếu theo cảnh báo (SOP-03)";
  }
  return "Xác định nguyên nhân từ issues list → sửa tại Seller Central (SOP-03)";
}

/* ------------------------------------------------------------------ */
/* Derived metrics                                                     */
/* ------------------------------------------------------------------ */

export function computeListingKpis(rows: ListingListRow[]) {
  const active = rows.filter((r) => r.status === "ACTIVE").length;
  const inactiveOrStranded = rows.filter(
    (r) => r.status === "INACTIVE" || r.status === "STRANDED",
  ).length;
  const withErrors = rows.filter((r) => r.issueErrors > 0).length;
  const suppressed = rows.filter((r) => r.status === "SUPPRESSED").length;

  return [
    {
      label: "Listing active",
      value: active.toLocaleString("en-US"),
      sub: `${rows.length} tổng SKU`,
      tone: "up" as const,
    },
    {
      label: "Inactive / stranded",
      value: String(inactiveOrStranded),
      sub: `${suppressed} bị ẩn (suppressed)`,
      tone: inactiveOrStranded > 0 ? ("down" as const) : ("up" as const),
    },
    {
      label: "Listing có lỗi",
      value: String(withErrors),
      sub: "issues severity ERROR",
      tone: withErrors > 0 ? ("down" as const) : ("flat" as const),
    },
    {
      label: "Cảnh báo",
      value: String(rows.filter((r) => r.issueWarnings > 0).length),
      sub: "issues severity WARNING",
      tone: "flat" as const,
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
