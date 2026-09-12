/**
 * Job nhập 2 report FBA inventory — Module 3 nâng cao (migration 0018).
 *
 *   • GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA → inventory.fc_allocation
 *     (I2: "hàng của SKU này đang nằm ở FC nào, mỗi FC bao nhiêu %")
 *   • GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA → inventory.receipts
 *     (I2/I4: "Amazon thực nhận bao nhiêu, ngày nào, lô nào")
 *
 * VÌ SAO KHÔNG DÙNG API:
 *   listInventorySummaries / getFulfillmentInventory chỉ trả TỔNG theo SKU
 *   (fulfillable · reserved · inbound) — không tách theo FC, và không có khái
 *   niệm "lịch sử đã nhận". Inbound API chỉ mô tả lô ĐANG mở; lô CLOSED thì số
 *   nhận chi tiết không còn. Hai khối này của I2 chỉ có số thật từ report.
 *
 * NGUYÊN TẮC:
 *   1. Report là SNAPSHOT/LỊCH SỬ → ghi đúng khoá tự nhiên (ngày × SKU × FC ×
 *      disposition / ngày × SKU × lô × FC). Nhập lại KHÔNG nhân đôi (RPC 0018).
 *   2. Chỉ tổng hợp trên SNAPSHOT MỚI NHẤT của file. Cộng dồn nhiều ngày sẽ ra
 *      con số không có nghĩa (100 đơn vị hôm qua + 100 hôm nay ≠ 200 tồn).
 *   3. Disposition rỗng = "không rõ" → đếm riêng `unknownDispositionUnits`,
 *      KHÔNG gộp vào bán được.
 *   4. "Số gửi" (expected) KHÔNG có trong report → job KHÔNG tính tỉ lệ nhận.
 *      Việc đối soát expected vs received nằm ở view
 *      public.vexim_inbound_receipt_shipments (0018), vì expected đến từ
 *      inventory.inbound_shipments do job inventory:sync ghi từ Inbound API.
 *   5. Chạy thiếu credentials / --dry-run → MockDbAdapter (không ghi DB thật),
 *      nhưng số liệu tóm tắt vẫn tính y hệt để đối chiếu bằng mắt.
 */
import type {
  DbAdapter,
  FcAllocationRowInput,
  ReceiptRowInput,
  ReportUpsertCounts,
  SyncJobRecord,
} from "../db/adapter.ts";
import {
  parseFcAllocationReport,
  parseReceiptsReport,
  type FcAllocationRow,
  type ReceiptRow,
} from "../reports/fba-inventory.parser.ts";

/** Một FC trong snapshot mới nhất: bao nhiêu đơn vị, bao nhiêu SKU, chiếm bao nhiêu %. */
export type FcShare = {
  fc: string;
  units: number;
  skus: number;
  /** NULL khi tổng tồn = 0 (không có hàng để chia) — không bịa 0% */
  sharePct: number | null;
};

/** Một lô hàng Amazon đã nhận (gộp các dòng cùng fba-shipment-id). */
export type ReceiptShipmentSummary = {
  shipmentId: string;
  fc: string | null;
  units: number;
  skus: number;
  firstDate: string;
  lastDate: string;
};

export type InventoryFcSyncReport = {
  sellerAccountId: string;
  fc: {
    /** số dòng report đọc được (đã bỏ dòng rác) */
    rows: number;
    /** số dòng rác bị bỏ */
    skipped: number;
    /** tổng đơn vị của SNAPSHOT MỚI NHẤT */
    units: number;
    snapshotDates: string[];
    latestSnapshot: string | null;
    skus: number;
    fcCount: number;
    sellableUnits: number;
    unsellableUnits: number;
    /** disposition rỗng — "không rõ", KHÔNG được tính là bán được */
    unknownDispositionUnits: number;
    topFcs: FcShare[];
    db: ReportUpsertCounts | null;
  };
  receipts: {
    rows: number;
    skipped: number;
    units: number;
    shipments: number;
    from: string | null;
    to: string | null;
    byShipment: ReceiptShipmentSummary[];
    db: ReportUpsertCounts | null;
  };
  warnings: string[];
  job: SyncJobRecord;
};

export type InventoryFcSyncOptions = {
  sellerAccountId: string;
  /** Nội dung report GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA (TSV) */
  fcReportText?: string;
  /** Nội dung report GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA (TSV) */
  receiptsReportText?: string;
  adapter: DbAdapter;
  now?: Date;
  /** Số FC tối đa đưa vào tóm tắt (mặc định 10) */
  topFcLimit?: number;
};

export const DEFAULT_TOP_FC_LIMIT = 10;

/** Tách 1 dòng thành (sku, fc, disposition) đã chuẩn hoá — dùng cho cả tổng hợp. */
function normFc(r: FcAllocationRow): { sku: string; fc: string; disp: string } {
  return {
    sku: r.sku.trim(),
    fc: r.fulfillmentCenterId === "" ? "(không rõ FC)" : r.fulfillmentCenterId,
    disp: r.detailedDisposition,
  };
}

/**
 * Tổng hợp phân bổ FC trên MỘT snapshot.
 * Tách ra hàm riêng để test được mà không cần DB.
 */
export function summarizeFcAllocation(
  rows: FcAllocationRow[],
  limit: number = DEFAULT_TOP_FC_LIMIT,
): InventoryFcSyncReport["fc"] {
  const snapshotDates = Array.from(new Set(rows.map((r) => r.snapshotDate))).sort();
  const latestSnapshot = snapshotDates[snapshotDates.length - 1] ?? null;
  const latest = latestSnapshot === null ? [] : rows.filter((r) => r.snapshotDate === latestSnapshot);

  let units = 0;
  let sellableUnits = 0;
  let unsellableUnits = 0;
  let unknownDispositionUnits = 0;
  const skus = new Set<string>();
  const perFc = new Map<string, { units: number; skus: Set<string> }>();

  for (const r of latest) {
    const { sku, fc, disp } = normFc(r);
    units += r.quantity;
    if (disp === "SELLABLE") sellableUnits += r.quantity;
    else if (disp === "") unknownDispositionUnits += r.quantity;
    else unsellableUnits += r.quantity;
    skus.add(sku);
    const bucket = perFc.get(fc) ?? { units: 0, skus: new Set<string>() };
    bucket.units += r.quantity;
    bucket.skus.add(sku);
    perFc.set(fc, bucket);
  }

  const topFcs: FcShare[] = Array.from(perFc.entries())
    .map(([fc, v]) => ({
      fc,
      units: v.units,
      skus: v.skus.size,
      // Tổng = 0 → NULL (xem giải thích ở kiểu FcShare)
      sharePct: units > 0 ? Math.round((v.units / units) * 1000) / 10 : null,
    }))
    .sort((a, b) => b.units - a.units || a.fc.localeCompare(b.fc))
    .slice(0, Math.max(1, limit));

  return {
    rows: rows.length,
    skipped: 0, // tầng parse đã đếm; job gán lại từ kết quả parse
    units,
    snapshotDates,
    latestSnapshot,
    skus: skus.size,
    fcCount: perFc.size,
    sellableUnits,
    unsellableUnits,
    unknownDispositionUnits,
    topFcs,
    db: null,
  };
}

/** Gộp các dòng nhận hàng theo lô — lô không có mã thì KHÔNG vào bảng này. */
export function summarizeReceiptsByShipment(rows: ReceiptRow[]): ReceiptShipmentSummary[] {
  const byId = new Map<string, ReceiptShipmentSummary & { skuSet: Set<string> }>();
  for (const r of rows) {
    if (r.fbaShipmentId === "") continue;
    const prev =
      byId.get(r.fbaShipmentId) ??
      ({
        shipmentId: r.fbaShipmentId,
        fc: r.fulfillmentCenterId === "" ? null : r.fulfillmentCenterId,
        units: 0,
        skus: 0,
        firstDate: r.receivedDate,
        lastDate: r.receivedDate,
        skuSet: new Set<string>(),
      } as ReceiptShipmentSummary & { skuSet: Set<string> });
    prev.units += r.quantity;
    prev.skuSet.add(r.sku.trim());
    if (r.receivedDate < prev.firstDate) prev.firstDate = r.receivedDate;
    if (r.receivedDate > prev.lastDate) prev.lastDate = r.receivedDate;
    if (prev.fc === null && r.fulfillmentCenterId !== "") prev.fc = r.fulfillmentCenterId;
    byId.set(r.fbaShipmentId, prev);
  }
  return Array.from(byId.values())
    .map(({ skuSet, ...rest }) => ({ ...rest, skus: skuSet.size }))
    .sort((a, b) => b.lastDate.localeCompare(a.lastDate) || a.shipmentId.localeCompare(b.shipmentId));
}

export async function runInventoryFcSync(
  opts: InventoryFcSyncOptions,
): Promise<InventoryFcSyncReport> {
  const now = opts.now ?? new Date();
  const warnings: string[] = [];

  const job: SyncJobRecord = {
    sellerAccountId: opts.sellerAccountId,
    jobType: "inventory.fc_sync",
    status: "running",
    startedAt: now,
    payload: {
      source: "report",
      reports: {
        fc: opts.fcReportText ? "GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA" : null,
        receipts: opts.receiptsReportText ? "GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA" : null,
      },
    },
  };
  await opts.adapter.recordSyncJob(job);

  try {
    if (!opts.fcReportText && !opts.receiptsReportText) {
      warnings.push(
        "Chưa có report nào để nhập. Tải từ Seller Central (Reports → Fulfillment → Inventory):" +
          " FBA Daily Inventory History (phân bổ FC) và/hoặc FBA Received Inventory (lịch sử nhận).",
      );
    }

    // ---- (1) Phân bổ tồn theo FC -------------------------------------------
    const fcParsed = opts.fcReportText
      ? parseFcAllocationReport(opts.fcReportText)
      : { rows: [] as FcAllocationRow[], warnings: [] as string[], skipped: 0, fcTotals: {}, snapshotDates: [] };
    warnings.push(...fcParsed.warnings);

    const fc = summarizeFcAllocation(fcParsed.rows, opts.topFcLimit);
    fc.skipped = fcParsed.skipped;

    let fcDb: ReportUpsertCounts | null = null;
    if (opts.fcReportText) {
      fcDb = await opts.adapter.upsertFcAllocation(
        opts.sellerAccountId,
        fcParsed.rows as FcAllocationRowInput[],
      );
      fc.db = fcDb;
      if (fcParsed.rows.length === 0) {
        warnings.push(
          "Report phân bổ FC không có dòng nào dùng được → I2 vẫn giữ nhãn 'chưa có dữ liệu'.",
        );
      } else if (fc.latestSnapshot !== null && fcParsed.snapshotDates.length > 1) {
        warnings.push(
          `File có ${fcParsed.snapshotDates.length} ngày snapshot — chỉ tổng hợp ngày mới nhất ` +
            `${fc.latestSnapshot} (cộng nhiều ngày sẽ ra số tồn sai).`,
        );
      }
    }

    // ---- (2) Lịch sử nhận hàng ----------------------------------------------
    const rxParsed = opts.receiptsReportText
      ? parseReceiptsReport(opts.receiptsReportText)
      : {
          rows: [] as ReceiptRow[],
          warnings: [] as string[],
          skipped: 0,
          shipmentTotals: {},
          receivedFrom: null,
          receivedTo: null,
        };
    warnings.push(...rxParsed.warnings);

    const byShipment = summarizeReceiptsByShipment(rxParsed.rows);
    const receipts: InventoryFcSyncReport["receipts"] = {
      rows: rxParsed.rows.length,
      skipped: rxParsed.skipped,
      units: rxParsed.rows.reduce((s, r) => s + r.quantity, 0),
      shipments: byShipment.length,
      from: rxParsed.receivedFrom,
      to: rxParsed.receivedTo,
      byShipment,
      db: null,
    };

    if (opts.receiptsReportText) {
      receipts.db = await opts.adapter.upsertReceipts(
        opts.sellerAccountId,
        rxParsed.rows as ReceiptRowInput[],
      );
      const noShipment = rxParsed.rows.filter((r) => r.fbaShipmentId === "").length;
      if (noShipment > 0) {
        warnings.push(
          `${noShipment} dòng nhận hàng KHÔNG có mã lô → vẫn ghi lịch sử theo SKU/ngày, ` +
            `nhưng không đối soát được với số gửi ở I4.`,
        );
      }
      if (rxParsed.rows.length === 0) {
        warnings.push(
          "Report lịch sử nhận hàng không có dòng nào dùng được → I2 vẫn giữ nhãn 'chưa có dữ liệu'.",
        );
      }
    }

    job.status = "done";
    job.finishedAt = new Date();
    job.payload = {
      source: "report",
      fc: opts.fcReportText
        ? {
            rows: fc.rows,
            skipped: fc.skipped,
            units: fc.units,
            latestSnapshot: fc.latestSnapshot,
            fcCount: fc.fcCount,
            inserted: fcDb?.inserted ?? 0,
            updated: fcDb?.updated ?? 0,
          }
        : null,
      receipts: opts.receiptsReportText
        ? {
            rows: receipts.rows,
            skipped: receipts.skipped,
            units: receipts.units,
            shipments: receipts.shipments,
            inserted: receipts.db?.inserted ?? 0,
            updated: receipts.db?.updated ?? 0,
          }
        : null,
    };
    await opts.adapter.recordSyncJob(job);

    return { sellerAccountId: opts.sellerAccountId, fc, receipts, warnings, job };
  } catch (e) {
    job.status = "failed";
    job.finishedAt = new Date();
    job.lastError = (e as Error).message;
    await opts.adapter.recordSyncJob(job);
    throw e;
  }
}
