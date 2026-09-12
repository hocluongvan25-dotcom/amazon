/**
 * Job đồng bộ Listing (Tầng 3 — hằng ngày 2h sáng / Đợt 1).
 * Nạp 3 report: Merchant Listings ALL (toàn bộ) + INACTIVE + STRANDED
 * → upsert trạng thái từng SKU → xuất queue L4 (SOP-03).
 *
 * Nguyên tắc: report là nguồn SỐ LƯỢNG + trạng thái hằng ngày; realtime
 * (notification) là nguồn TRẠNG THÁI tức thời — cả hai ghi lên cùng
 * listing state, field nào không chắc (status null) thì bỏ qua, không đè.
 * Luật đó được thực thi ở RPC `public.vexim_worker_upsert_listings` (0016) và
 * MockDbAdapter áp y hệt để test không xanh giả.
 *
 * L2 cần ISSUES ĐÚNG MÃ AMAZON, mà report Merchant Listings KHÔNG có cột đó —
 * muốn có phải gọi `getListingsItem(includedData=issues)`. Vì vậy job nhận một
 * hook `fetchDetail` tuỳ chọn: chỉ gọi cho SKU đang có vấn đề, có giới hạn số
 * lần (rate limit 5 rps / burst 10) và KHÔNG bịa issue khi không gọi được.
 */
import type { DbAdapter, ListingLifecycleStatus, ListingStateRow } from "../db/adapter.ts";
import type { ListingsItem } from "../amazon/listings.ts";
import {
  parseMerchantListingsReport,
  parseStrandedInventoryReport,
} from "../reports/merchant-listings.parser.ts";

export type ListingQueueEntry = {
  sku: string;
  status: ListingLifecycleStatus;
  cause: string; // stranded reason hoặc trạng thái + cột status gốc
  /** mã issue Amazon (8541, 90220…) khi đã gọi getListingsItem */
  issueCodes?: string[];
};

export type ListingsSyncReport = {
  sellerAccountId: string;
  listingsProcessed: number;
  inactiveCount: number;
  strandedCount: number;
  queue: ListingQueueEntry[];
  warnings: string[];
  /** số SKU đã gọi getListingsItem để lấy issues thật (L2) */
  detailsFetched: number;
  /** số SKU có ≥1 issue ERROR sau đồng bộ */
  withErrors: number;
  alerts: import("../db/adapter.ts").AlertRowInput[];
  job: import("../db/adapter.ts").SyncJobRecord;
};

/** Mặc định tối đa số lần gọi getListingsItem trong một lần đồng bộ. */
export const DEFAULT_DETAIL_LIMIT = 50;

export type ListingsSyncOptions = {
  sellerAccountId: string;
  /** Nội dung report GET_MERCHANT_LISTINGS_ALL_DATA (TSV) */
  allReportText: string;
  /** Nội dung report GET_MERCHANT_LISTINGS_INACTIVE_DATA (TSV) — có thể trống */
  inactiveReportText?: string;
  /** Nội dung report GET_STRANDED_INVENTORY_UI_DATA (TSV) */
  strandedReportText?: string;
  adapter: DbAdapter;
  now?: Date;
  /**
   * Hook gọi `getListingsItem` (Listings Items API 2021-08-01,
   * includedData=summaries,issues) cho SKU đang có vấn đề.
   * Không truyền → chỉ dùng dữ liệu report (L2 sẽ trống issues, KHÔNG bịa).
   */
  fetchDetail?: (sku: string) => Promise<ListingsItem>;
  /** Chặn số lần gọi API (mặc định DEFAULT_DETAIL_LIMIT) */
  detailLimit?: number;
};

/** Dựng hàng đợi + alert từ trạng thái (hàm thuần — test được, không I/O). */
export function buildListingQueueEntry(input: {
  sku: string;
  status: ListingLifecycleStatus;
  statusRaw?: string;
  strandedReason?: string | null;
  issueCodes?: string[];
  missingFromAllReport?: boolean;
}): ListingQueueEntry {
  const cause = input.strandedReason
    ? `Stranded — ${input.strandedReason}`
    : input.issueCodes && input.issueCodes.length > 0
      ? `Issue Amazon: ${input.issueCodes.join(", ")}`
      : input.missingFromAllReport
        ? `Trạng thái "${input.status}" — không còn trong report ALL`
        : `Trạng thái "${input.statusRaw ?? input.status}" từ report Merchant Listings`;
  return {
    sku: input.sku,
    status: input.status,
    cause,
    issueCodes: input.issueCodes ?? [],
  };
}

export async function runListingsSync(opts: ListingsSyncOptions): Promise<ListingsSyncReport> {
  const now = opts.now ?? new Date();
  const warnings: string[] = [];
  const queue: ListingQueueEntry[] = [];
  const rows: ListingStateRow[] = [];

  const job: import("../db/adapter.ts").SyncJobRecord = {
    sellerAccountId: opts.sellerAccountId,
    jobType: "listings.sync",
    status: "running",
    startedAt: now,
    payload: { source: "report" },
  };
  await opts.adapter.recordSyncJob(job);

  try {
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

      rows.push({
        sellerAccountId: opts.sellerAccountId,
        sku: r.sku,
        asin: r.asin,
        itemName: r.itemName,
        status,
        price: r.price,
        quantity: r.quantity,
        // key CÓ MẶT (kể cả null) → hết stranded thì xoá được lý do cũ ở L4
        strandedReason: strandedRow?.strandedReason ?? null,
        source: "report",
        updatedAt: now,
      });

      if (status && status !== "ACTIVE") {
        queue.push(
          buildListingQueueEntry({
            sku: r.sku,
            status,
            statusRaw: r.statusRaw,
            strandedReason: strandedRow?.strandedReason ?? null,
          }),
        );
      }
    }

    // SKU stranded không có trong report ALL (listing đã bị xóa khỏi account)
    const allSkus = new Set(all.rows.map((r) => r.sku));
    for (const [sku, r] of strandedBySku) {
      if (allSkus.has(sku)) continue;
      rows.push({
        sellerAccountId: opts.sellerAccountId,
        sku,
        asin: r.asin,
        itemName: r.itemName,
        status: "STRANDED",
        quantity: r.quantity,
        strandedReason: r.strandedReason,
        source: "report",
        updatedAt: now,
      });
      queue.push(
        buildListingQueueEntry({
          sku,
          status: "STRANDED",
          strandedReason: r.strandedReason,
          missingFromAllReport: true,
        }),
      );
    }

    // 4) L2: lấy issues THẬT cho SKU đang có vấn đề (không có thì để trống)
    let detailsFetched = 0;
    if (opts.fetchDetail) {
      const limit = opts.detailLimit ?? DEFAULT_DETAIL_LIMIT;
      const flagged = rows.filter((r) => r.status === null || r.status !== "ACTIVE");
      for (const row of flagged.slice(0, limit)) {
        try {
          const item = await opts.fetchDetail(row.sku);
          const { extractListingState } = await import("../amazon/listings.ts");
          const state = extractListingState(item);
          row.asin = row.asin ?? state.asin;
          row.itemName = row.itemName ?? state.itemName;
          row.productType = state.productType;
          row.issues = state.issues;
          row.buyable = state.buyable;
          row.discoverable = state.discoverable;
          row.enforcementActions = state.enforcementActions;
          detailsFetched++;

          const entry = queue.find((q) => q.sku === row.sku);
          const codes = state.issues
            .map((i) => i.code)
            .filter((c): c is string => typeof c === "string" && c.length > 0);
          if (entry && codes.length > 0) entry.issueCodes = codes;
          if (entry) {
            entry.cause = buildListingQueueEntry({
              sku: row.sku,
              status: row.status ?? "INACTIVE",
              strandedReason: row.strandedReason ?? null,
              issueCodes: codes,
            }).cause;
          }
        } catch (e) {
          // Không gọi được (404 SKU đã xoá / 429 / thiếu quyền) → ghi rõ, KHÔNG bịa issue
          warnings.push(
            `SKU ${row.sku}: không lấy được issues từ getListingsItem (${(e as Error).message}) — L2 để trống`,
          );
        }
      }
      if (flagged.length > limit) {
        warnings.push(
          `Có ${flagged.length} SKU cần soi issues nhưng giới hạn ${limit} lần gọi getListingsItem — tăng --detail-limit nếu muốn đủ`,
        );
      }
    }

    // 5) Ghi MỘT LÔ (1 request) thay vì từng dòng — report có thể vài nghìn SKU
    await opts.adapter.upsertListings(rows);

    // 6) Alert `listing_inactive` (rule đã seed từ 0001) + đóng alert khi hết lỗi
    const alerts: import("../db/adapter.ts").AlertRowInput[] = [];
    const flaggedCount = queue.length;
    if (flaggedCount > 0) {
      const strandedOnly = queue.filter((q) => q.status === "STRANDED").length;
      alerts.push({
        sellerAccountId: opts.sellerAccountId,
        ruleCode: "listing_inactive",
        severity: strandedOnly > 0 ? "red" : "amber",
        title: `${flaggedCount} listing không ACTIVE (SOP-03)`,
        detail:
          queue
            .slice(0, 5)
            .map((q) => `${q.sku}: ${q.cause}`)
            .join(" · ") + (queue.length > 5 ? ` · +${queue.length - 5} SKU khác` : ""),
      });
    }
    for (const alert of alerts) await opts.adapter.upsertAlert(alert);
    if (flaggedCount === 0) {
      await opts.adapter.resolveAlerts({
        sellerAccountId: opts.sellerAccountId,
        ruleCode: "listing_inactive",
        note: "Không còn listing inactive/stranded sau lần đồng bộ này",
        resolvedAt: now,
      });
    }

    job.status = "done";
    job.finishedAt = new Date();
    job.payload = {
      source: "report",
      listings: rows.length,
      flagged: flaggedCount,
      detailsFetched,
    };
    await opts.adapter.recordSyncJob(job);

    return {
      sellerAccountId: opts.sellerAccountId,
      listingsProcessed: all.rows.length,
      inactiveCount: all.rows.filter(
        (r) => r.status === "INACTIVE" || r.status === "SUPPRESSED",
      ).length,
      strandedCount: stranded.rows.length,
      queue,
      warnings,
      detailsFetched,
      withErrors: rows.filter(
        (r) => (r.issues ?? []).some((i) => i.severity === "ERROR"),
      ).length,
      alerts,
      job,
    };
  } catch (e) {
    job.status = "failed";
    job.finishedAt = new Date();
    job.lastError = (e as Error).message;
    await opts.adapter.recordSyncJob(job);
    throw e;
  }
}
