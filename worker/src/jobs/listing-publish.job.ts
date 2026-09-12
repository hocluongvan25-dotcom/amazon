/**
 * Job PUBLISH listing (L3 — Đợt 2).
 *
 * Nhận hàng đợi `catalog.listing_publish_queue` (web đẩy vào khi trưởng phòng
 * bấm Publish) rồi thực hiện ĐÚNG thứ tự Amazon khuyến nghị:
 *
 *   1. ASIN đã tồn tại → getListingsRestrictions (Listings Restrictions API
 *      2021-08-01). Có reason (APPROVAL_REQUIRED / ASIN_NOT_FOUND /
 *      NOT_ELIGIBLE) → đánh dấu `blocked` + lý do, KHÔNG gửi Amazon.
 *   2. listing đã có trên Amazon → patchListingsItem (JSON Patch, sửa từng
 *      attribute). Listing mới → putListingsItem (productType + requirements
 *      + attributes).
 *   3. Ghi kết quả: ACCEPTED → bản nháp `published`; INVALID → `failed` kèm
 *      issues để người soạn sửa; lỗi mạng/5xx → `failed` để chạy lại.
 *
 * `marketplaceIds` là QUERY PARAM — client đã set sẵn, job không nhét vào body.
 */

import type { DbAdapter, ListingPublishQueueRow, ListingPublishResultInput } from "../db/adapter.ts";
import type { JsonPatchOperation, ListingsItemsClient, ListingsRequirements } from "../amazon/listings.ts";

export type ListingPublishReport = {
  sellerAccountId: string;
  processed: number;
  accepted: number;
  invalid: number;
  blocked: number;
  failed: number;
  items: {
    queueId: string;
    sku: string;
    status: ListingPublishResultInput["status"];
    submissionId?: string | null;
    note?: string;
  }[];
};

/** Gom reasonCode + message + link của getListingsRestrictions thành 1 chuỗi. */
export function formatRestrictionBlockers(restrictions: {
  restrictions?: { marketplaceId?: string; reasons?: { reasonCode?: string; message?: string; links?: { resource?: string }[] }[] }[];
}): string[] {
  const out: string[] = [];
  for (const item of restrictions.restrictions ?? []) {
    for (const reason of item.reasons ?? []) {
      const code = reason.reasonCode ?? "UNKNOWN";
      const link = reason.links?.[0]?.resource;
      out.push(`${code}: ${reason.message ?? ""}${link ? ` — ${link}` : ""}`.trim());
    }
  }
  return out;
}

export async function runListingPublish(opts: {
  sellerAccountId: string;
  /** Seller ID dùng cho SP-API (khác seller_account_id nội bộ của VEXIM) */
  sellerId: string;
  client: ListingsItemsClient;
  adapter: DbAdapter;
  limit?: number;
  issueLocale?: string;
  /** true = chỉ kiểm tra hạn chế danh mục, KHÔNG gửi lên Amazon và không ghi DB */
  dryRun?: boolean;
}): Promise<ListingPublishReport> {
  const rows = await opts.adapter.listListingPublishQueue(opts.sellerAccountId, opts.limit ?? 20);

  const report: ListingPublishReport = {
    sellerAccountId: opts.sellerAccountId,
    processed: 0,
    accepted: 0,
    invalid: 0,
    blocked: 0,
    failed: 0,
    items: [],
  };

  for (const row of rows) {
    report.processed += 1;
    const result = await processRow(row, opts);
    report.items.push({
      queueId: row.queueId,
      sku: row.sku,
      status: result.status,
      submissionId: result.submissionId ?? null,
      note: result.blockReason ?? result.error ?? undefined,
    });
    if (result.status === "accepted") report.accepted += 1;
    else if (result.status === "invalid") report.invalid += 1;
    else if (result.status === "blocked") report.blocked += 1;
    else if (result.status === "failed") report.failed += 1;

    if (!opts.dryRun) await opts.adapter.recordListingPublishResult(result);
  }

  return report;
}

async function processRow(
  row: ListingPublishQueueRow,
  opts: {
    sellerId: string;
    client: ListingsItemsClient;
    issueLocale?: string;
    dryRun?: boolean;
  },
): Promise<ListingPublishResultInput> {
  /* 1) Hạn chế danh mục — bắt buộc với ASIN đã có trên Amazon */
  if (row.asin) {
    try {
      const restrictions = await opts.client.getListingsRestrictions({
        sellerId: opts.sellerId,
        asin: row.asin,
        marketplaceId: row.marketplaceId,
        reasonLocale: opts.issueLocale,
      });
      const blockers = formatRestrictionBlockers(restrictions);
      if (blockers.length > 0) {
        return { queueId: row.queueId, status: "blocked", blockReason: blockers.join(" | ") };
      }
    } catch (error) {
      return {
        queueId: row.queueId,
        status: "failed",
        error: `Không kiểm tra được hạn chế danh mục: ${(error as Error).message}`,
      };
    }
  }

  if (opts.dryRun) {
    return { queueId: row.queueId, status: "sent", blockReason: "dry-run: chưa gửi Amazon" };
  }

  /* 2) Gửi lên Amazon */
  try {
    const submission =
      row.method === "put"
        ? await opts.client.putListingsItem({
            sellerId: opts.sellerId,
            sku: row.sku,
            marketplaceId: row.marketplaceId,
            productType: row.productType,
            requirements: row.requirements as ListingsRequirements,
            attributes: (row.payload.attributes ?? {}) as Record<string, unknown[]>,
            issueLocale: opts.issueLocale,
          })
        : await opts.client.patchListingsItem({
            sellerId: opts.sellerId,
            sku: row.sku,
            marketplaceId: row.marketplaceId,
            productType: row.productType,
            patches: (row.payload.patches ?? []) as JsonPatchOperation[],
            issueLocale: opts.issueLocale,
          });

    const status = submission.status === "ACCEPTED" ? "accepted" : "invalid";
    return {
      queueId: row.queueId,
      status,
      submissionId: submission.submissionId,
      issues: submission.issues ?? [],
    };
  } catch (error) {
    return { queueId: row.queueId, status: "failed", error: (error as Error).message };
  }
}
