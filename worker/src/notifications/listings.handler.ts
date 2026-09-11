/**
 * Handler notification Listing (Tầng 1 — realtime) cho Module 1.
 *
 * LISTINGS_ITEM_STATUS_CHANGE (PayloadVersion 1.0):
 *   { SellerId, MarketplaceId, Asin, Sku, CreatedDate, Status: ["BUYABLE","DISCOVERABLE"] }
 *   — phát khi listing được tạo / xóa / buyability thay đổi.
 *   Status rỗng = trạng thái không áp dụng (FAQ Listings) → bỏ qua, không ghi đè.
 *
 * LISTINGS_ITEM_ISSUES_CHANGE (PayloadVersion 2023-12-13 hoặc 1.0):
 *   { SellerId, MarketplaceId, Asin, Sku, Severities: ["ERROR","WARNING"],
 *     EnforcementActions: ["SEARCH_SUPPRESSED","LISTING_SUPPRESSED",
 *                          "ATTRIBUTE_SUPPRESSED","CATALOG_ITEM_REMOVED"] }
 *   — KHÔNG chứa chi tiết issue; theo docs phải gọi getListingsItem
 *     (includedData: issues) để lấy chi tiết.
 */
import type { DbAdapter, ListingLifecycleStatus } from "../db/adapter.ts";

export type ListingsItemStatusChangePayload = {
  SellerId?: string;
  MarketplaceId?: string;
  Asin?: string;
  Sku?: string;
  CreatedDate?: string;
  Status?: string[];
};

export type ListingsItemIssuesChangePayload = {
  SellerId?: string;
  MarketplaceId?: string;
  Asin?: string;
  Sku?: string;
  Severities?: string[];
  EnforcementActions?: string[];
};

/**
 * BUYABLE/DISCOVERABLE → trạng thái L1:
 *  buyable + discoverable        → ACTIVE
 *  buyable + không discoverable  → SUPPRESSED (search suppressed)
 *  không buyable                 → INACTIVE (listing suppressed)
 *  STRANDED chỉ đến từ report stranded (tồn không gắn listing active).
 */
export function deriveStatus(flags: {
  buyable: boolean | null;
  discoverable: boolean | null;
}): ListingLifecycleStatus | null {
  if (flags.buyable === null && flags.discoverable === null) return null;
  if (flags.buyable) return flags.discoverable === false ? "SUPPRESSED" : "ACTIVE";
  return "INACTIVE";
}

export function isListingsItemStatusChange(
  payload: unknown,
): payload is ListingsItemStatusChangePayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "Sku" in payload &&
    "Status" in payload &&
    Array.isArray((payload as ListingsItemStatusChangePayload).Status)
  );
}

export function isListingsItemIssuesChange(
  payload: unknown,
): payload is ListingsItemIssuesChangePayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "Sku" in payload &&
    ("Severities" in payload || "EnforcementActions" in payload)
  );
}

/** STATUS_CHANGE → cập nhật trạng thái L1 + cảnh báo listing_inactive nếu mất ACTIVE */
export async function handleListingsItemStatusChange(
  payload: unknown,
  adapter: DbAdapter,
  opts: { sellerAccountId: string; now?: Date },
): Promise<{ sku: string; status: ListingLifecycleStatus | null } | null> {
  if (!isListingsItemStatusChange(payload)) return null;
  const now = opts.now ?? new Date();
  const flags = payload.Status ?? [];
  const status = deriveStatus({
    buyable: flags.length > 0 ? flags.includes("BUYABLE") : null,
    discoverable: flags.length > 0 ? flags.includes("DISCOVERABLE") : null,
  });

  await adapter.recordNotification({
    sellerAccountId: opts.sellerAccountId,
    notificationType: "LISTINGS_ITEM_STATUS_CHANGE",
    raw: payload,
    normalized: { sku: payload.Sku, asin: payload.Asin, status },
    receivedAt: now,
  });

  if (payload.Sku && status !== null) {
    await adapter.upsertListing({
      sellerAccountId: opts.sellerAccountId,
      sku: payload.Sku,
      asin: payload.Asin ?? null,
      status,
      buyable: flags.length > 0 ? flags.includes("BUYABLE") : null,
      discoverable: flags.length > 0 ? flags.includes("DISCOVERABLE") : null,
      updatedAt: now,
    });
  }
  return payload.Sku ? { sku: payload.Sku, status } : null;
}

/**
 * ISSUES_CHANGE → ghi notification + (nếu có fetchDetail) gọi getListingsItem
 * lấy chi tiết issue đúng hướng dẫn Amazon — notification không đủ dữ liệu.
 */
export async function handleListingsItemIssuesChange(
  payload: unknown,
  adapter: DbAdapter,
  opts: {
    sellerAccountId: string;
    now?: Date;
    /** hàm lấy chi tiết: sku → Promise<ListingsItem> (getListingsItem) */
    fetchDetail?: (sku: string) => Promise<import("../amazon/listings.ts").ListingsItem>;
  },
): Promise<{
  sku: string;
  severities: string[];
  enforcementActions: string[];
  detailFetched: boolean;
} | null> {
  if (!isListingsItemIssuesChange(payload)) return null;
  const now = opts.now ?? new Date();
  const severities = payload.Severities ?? [];
  const enforcementActions = payload.EnforcementActions ?? [];

  await adapter.recordNotification({
    sellerAccountId: opts.sellerAccountId,
    notificationType: "LISTINGS_ITEM_ISSUES_CHANGE",
    raw: payload,
    normalized: { sku: payload.Sku, asin: payload.Asin, severities, enforcementActions },
    receivedAt: now,
  });

  let detailFetched = false;
  if (payload.Sku && opts.fetchDetail) {
    const item = await opts.fetchDetail(payload.Sku);
    const { extractListingState } = await import("../amazon/listings.ts");
    const state = extractListingState(item);
    await adapter.upsertListing({
      sellerAccountId: opts.sellerAccountId,
      sku: payload.Sku,
      asin: payload.Asin ?? state.asin,
      itemName: state.itemName,
      issueErrors: state.issueErrors,
      issueWarnings: state.issueWarnings,
      enforcementActions: state.enforcementActions.length > 0 ? state.enforcementActions : enforcementActions,
      updatedAt: now,
    });
    detailFetched = true;
  }
  return payload.Sku ? { sku: payload.Sku, severities, enforcementActions, detailFetched } : null;
}
