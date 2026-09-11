/**
 * Job đồng bộ Listing (Tầng 3 — hằng ngày 2h sáng / Đợt 1).
 * Nạp 3 report: Merchant Listings ALL (toàn bộ) + INACTIVE + STRANDED
 * → upsert trạng thái từng SKU → xuất queue L4 (SOP-03).
 *
 * Nguyên tắc: report là nguồn SỐ LƯỢNG + trạng thái hằng ngày; realtime
 * (notification) là nguồn TRẠNG THÁI tức thời — cả hai ghi lên cùng
 * listing state, field nào không chắc (status null) thì bỏ qua, không đè.
 */
import type { DbAdapter, ListingLifecycleStatus } from "../db/adapter.ts";
import {
  parseMerchantListingsReport,
  parseStrandedInventoryReport,
} from "../reports/merchant-listings.parser.ts";

export type ListingQueueEntry = {
  sku: string;
  status: ListingLifecycleStatus;
  cause: string; // stranded reason hoặc trạng thái + cột status gốc
};

export type ListingsSyncReport = {
  sellerAccountId: string;
  listingsProcessed: number;
  inactiveCount: number;
  strandedCount: number;
  queue: ListingQueueEntry[];
  warnings: string[];
};

export async function runListingsSync(opts: {
  sellerAccountId: string;
  /** Nội dung report GET_MERCHANT_LISTINGS_ALL_DATA (TSV) */
  allReportText: string;
  /** Nội dung report GET_MERCHANT_LISTINGS_INACTIVE_DATA (TSV) — có thể trống */
  inactiveReportText?: string;
  /** Nội dung report GET_STRANDED_INVENTORY_UI_DATA (TSV) */
  strandedReportText?: string;
  adapter: DbAdapter;
  now?: Date;
}): Promise<ListingsSyncReport> {
  const now = opts.now ?? new Date();
  const warnings: string[] = [];
  const queue: ListingQueueEntry[] = [];

  // 1) Report ALL — toàn bộ listing + trạng thái
  const all = parseMerchantListingsReport(opts.allReportText);
  warnings.push(...all.warnings);

  // 2) Report INACTIVE — bổ sung nguyên nhân inactive (cùng format)
  const inactive = opts.inactiveReportText
    ? parseMerchantListingsReport(opts.inactiveReportText)
    : { rows: [], warnings: [] };
  warnings.push(...inactive.warnings);
  const inactiveSkus = new Set(inactive.rows.map((r) => r.sku));

  // 3) Report STRANDED — tồn không gắn listing active
  const stranded = opts.strandedReportText
    ? parseStrandedInventoryReport(opts.strandedReportText)
    : { rows: [], warnings: [] };
  warnings.push(...stranded.warnings);
  const strandedBySku = new Map(stranded.rows.map((r) => [r.sku, r]));

  for (const r of all.rows) {
    const strandedRow = strandedBySku.get(r.sku);
    let status: ListingLifecycleStatus | null = r.status;
    if (strandedRow) status = "STRANDED";
    else if (inactiveSkus.has(r.sku) && status === "ACTIVE") {
      // report ALL cũ hơn/có lệch với report INACTIVE → cảnh báo, không đè
      warnings.push(
        `SKU ${r.sku}: report ALL ghi "${r.statusRaw}" nhưng có mặt trong report INACTIVE — giữ theo report INACTIVE`,
      );
      status = "INACTIVE";
    }

    await opts.adapter.upsertListing({
      sellerAccountId: opts.sellerAccountId,
      sku: r.sku,
      asin: r.asin,
      itemName: r.itemName,
      status,
      price: r.price,
      quantity: r.quantity,
      strandedReason: strandedRow?.strandedReason ?? null,
      updatedAt: now,
    });

    if (status && status !== "ACTIVE") {
      queue.push({
        sku: r.sku,
        status,
        cause: strandedRow
          ? `Stranded — ${strandedRow.strandedReason}`
          : `Trạng thái "${r.statusRaw}" từ report Merchant Listings`,
      });
    }
  }

  // SKU stranded không có trong report ALL (listing đã bị xóa khỏi account)
  const allSkus = new Set(all.rows.map((r) => r.sku));
  for (const [sku, r] of strandedBySku) {
    if (allSkus.has(sku)) continue;
    await opts.adapter.upsertListing({
      sellerAccountId: opts.sellerAccountId,
      sku,
      asin: r.asin,
      itemName: r.itemName,
      status: "STRANDED",
      strandedReason: r.strandedReason,
      updatedAt: now,
    });
    queue.push({ sku, status: "STRANDED", cause: `Stranded — ${r.strandedReason} (không còn trong report ALL)` });
  }

  return {
    sellerAccountId: opts.sellerAccountId,
    listingsProcessed: all.rows.length,
    inactiveCount: all.rows.filter((r) => r.status === "INACTIVE" || r.status === "SUPPRESSED").length,
    strandedCount: stranded.rows.length,
    queue,
    warnings,
  };
}
