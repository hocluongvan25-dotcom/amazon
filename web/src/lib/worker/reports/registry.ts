/**
 * Bảng đăng ký 4 report FBA mà VEXIM tự kéo qua Reports API (0019).
 *
 *   kind           reportType                                          nuôi màn
 *   ─────────────  ──────────────────────────────────────────────────  ────────
 *   fc             GET_LEDGER_SUMMARY_VIEW_DATA (thay cho DEPRECATED
 *                  GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA)           I2 · I3
 *   receipts       GET_LEDGER_DETAIL_VIEW_DATA (thay cho DEPRECATED
 *                  GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA)          I2 · I4
 *   storage-fees   GET_FBA_STORAGE_FEE_CHARGES_DATA                     I2 · phí FC
 *   noncompliance  GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA       I4
 *
 * LÝ DO ĐỔI (SP-API 400 InvalidInput 09/2026):
 *   Amazon đã DEPRECATED 2 report FBA cũ từ 31/01/2023:
 *     GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA
 *     GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA
 *   và trả 400 InvalidInput với details "Report type is deprecated".
 *   Thay thế chuẩn theo Amazon docs:
 *     fc       → GET_LEDGER_SUMMARY_VIEW_DATA + aggregateByLocation=FC + aggregatedByTimePeriod=DAILY
 *     receipts → GET_LEDGER_DETAIL_VIEW_DATA (filter EventType=Receipts ở parser)
 *
 * Vì sao gộp một chỗ: CLI (`worker reports:pull`), Vercel Cron
 * (`/api/cron/report-pull`) và test đều cần CÙNG một định nghĩa — loại report,
 * khoảng ngày mặc định, trần tốc độ, parser nào, ghi qua RPC nào. Nếu mỗi nơi
 * khai một kiểu thì sớm muộn cron sẽ kéo khoảng ngày khác CLI và số liệu lệch nhau.
 *
 * TRẦN TỐC ĐỘ (developer-docs.amazon.com/sp-api/docs/report-type-values-fba):
 * report FBA dạng daily chỉ được yêu cầu 1 lần / 4 giờ cho MỖI loại; nhóm
 * near-real-time là 1 lần / 30 phút. `cooldownHours` dưới đây là con số job dùng
 * để QUYẾT ĐỊNH có xin report mới hay không — không phải để trang trí.
 */
import type {
  DbAdapter,
  FcAllocationRowInput,
  FeeUpsertCounts,
  NoncomplianceRowInput,
  ReceiptRowInput,
  ReportUpsertCounts,
  StorageFeeRowInput,
} from "../db/adapter.ts";
import {
  parseFcAllocationReport,
  parseLedgerDetailAsReceipts,
  parseLedgerSummaryAsFc,
  parseReceiptsReport,
} from "./fba-inventory.parser.ts";
import {
  parseInboundNoncomplianceReport,
  parseStorageFeeReport,
} from "./fba-fees.parser.ts";

export type ReportKind = "fc" | "receipts" | "storage-fees" | "noncompliance";

export type ReportSpec = {
  kind: ReportKind;
  /** hằng số reportType của Amazon — gửi nguyên văn trong createReport */
  reportType: string;
  /** tên tiếng Việt dùng trong log/UI */
  label: string;
  /** màn nào ăn dữ liệu này — để log nói rõ "kéo về để làm gì" */
  screen: string;
  /**
   * Report có khoảng ngày. Cả 4 loại dưới đây đều nhận dataStartTime/dataEndTime;
   * nếu Amazon từ chối khoảng ngày cho một loại nào đó, job tự thử lại KHÔNG kèm
   * khoảng ngày (và ghi cảnh báo) chứ không bỏ cuộc.
   */
  needsDateRange: boolean;
  /** kéo lùi bao nhiêu ngày khi người dùng không chỉ định */
  lookbackDays: number;
  /** trần yêu cầu lại của Amazon (giờ) — dưới mức này thì poll report cũ */
  cooldownHours: number;
  /** reportOptions bắt buộc cho Ledger reports */
  reportOptions?: Record<string, string>;
  /** ghi chú deprecated để log rõ khi Amazon trả 400 */
  deprecatedNote?: string;
};

export const REPORT_SPECS: Record<ReportKind, ReportSpec> = {
  fc: {
    kind: "fc",
    // FIX 1: reportType cũ GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA đã bị Amazon deprecated từ 31/01/2023
    // → 400 InvalidInput "Report type is deprecated" cho cả P1-US và P2-CA
    // Thay bằng GET_LEDGER_SUMMARY_VIEW_DATA + aggregateByLocation=FC + DAILY (chuẩn mới)
    reportType: "GET_LEDGER_SUMMARY_VIEW_DATA",
    label: "Phân bổ tồn theo FC (Ledger Summary FC/DAILY)",
    screen: "I2 · I3",
    needsDateRange: true,
    // FIX 2: DAILY ledger yêu cầu start và end CÙNG NGÀY, end = 23:59:59Z
    // lookback 1 ngày = snapshot mới nhất, tránh Amazon trả rỗng nếu range quá rộng
    lookbackDays: 1,
    cooldownHours: 4,
    reportOptions: {
      aggregateByLocation: "FC",
      aggregatedByTimePeriod: "DAILY",
    },
    deprecatedNote: "Cũ: GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA đã deprecated 31/01/2023 → 400 InvalidInput",
  },
  receipts: {
    kind: "receipts",
    // FIX 1: GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA cũng deprecated → 400
    // Thay bằng GET_LEDGER_DETAIL_VIEW_DATA, filter EventType=Receipts ở parser
    reportType: "GET_LEDGER_DETAIL_VIEW_DATA",
    label: "Lịch sử nhận hàng (Ledger Detail Receipts)",
    screen: "I2 · I4",
    needsDateRange: true,
    lookbackDays: 30,
    cooldownHours: 4,
    // Detail view không cần reportOptions bắt buộc, nhưng có thể filter
    // Để rỗng = lấy tất cả event, parser sẽ lọc Receipts
    reportOptions: {},
    deprecatedNote: "Cũ: GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA deprecated 31/01/2023 → 400",
  },
  "storage-fees": {
    kind: "storage-fees",
    reportType: "GET_FBA_STORAGE_FEE_CHARGES_DATA",
    label: "Phí lưu kho theo FC (FBA Storage Fees)",
    screen: "I2 · phân bổ phí FC",
    needsDateRange: true,
    // Phí tính theo THÁNG: 95 ngày ≈ 3 tháng để có trend và tháng đang chạy.
    lookbackDays: 95,
    cooldownHours: 4,
  },
  noncompliance: {
    kind: "noncompliance",
    reportType: "GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA",
    label: "Phí inbound sai quy cách (FBA Inbound Performance)",
    screen: "I4",
    needsDateRange: true,
    lookbackDays: 60,
    cooldownHours: 4,
  },
};

export const ALL_REPORT_KINDS: readonly ReportKind[] = [
  "fc",
  "receipts",
  "storage-fees",
  "noncompliance",
];

export function isReportKind(value: string | null | undefined): value is ReportKind {
  return (ALL_REPORT_KINDS as readonly string[]).includes(String(value ?? ""));
}

export function specOf(kind: ReportKind): ReportSpec {
  return REPORT_SPECS[kind];
}

/** reportType → kind (cron nhận reportType từ Amazon, cần ánh xạ ngược). */
export function kindOfReportType(reportType: string): ReportKind | null {
  const found = ALL_REPORT_KINDS.find((k) => REPORT_SPECS[k].reportType === reportType);
  return found ?? null;
}

// ============================================================================
// Parse: một hàm cho cả 4 loại (hỗ trợ cả format cũ và mới Ledger)
// ============================================================================

export type AnyReportRow =
  | FcAllocationRowInput
  | ReceiptRowInput
  | StorageFeeRowInput
  | NoncomplianceRowInput;

export type ParsedReport = {
  kind: ReportKind;
  rows: AnyReportRow[];
  warnings: string[];
  /** dòng rác bị parser bỏ (khác `merged` của RPC — đừng gộp hai số này) */
  skipped: number;
  /** 1 dòng tóm tắt để log: bao nhiêu dòng · nhóm theo gì · tiền tệ nào */
  summary: string;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Cộng tiền THEO TỪNG TIỀN TỆ — không bao giờ trả về một con số trộn USD với CAD. */
function moneyByCurrency(
  rows: { currency?: string | null; amount: number | null }[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.amount === null || Number.isNaN(r.amount)) continue;
    const cur = (r.currency ?? "").trim() || "(không rõ tiền)";
    out[cur] = round2((out[cur] ?? 0) + r.amount);
  }
  return out;
}

function formatMoney(byCurrency: Record<string, number>): string {
  const entries = Object.entries(byCurrency);
  if (entries.length === 0) return "không đọc được phí";
  return entries.map(([cur, v]) => `${v} ${cur}`).join(" + ");
}

export function parseReportText(kind: ReportKind, text: string): ParsedReport {
  switch (kind) {
    case "fc": {
      // Thử parse format Ledger Summary FC trước (mới), fallback format cũ
      const isLedger = text.toLowerCase().includes("endingwarehousebalance") || text.toLowerCase().includes("startingwarehousebalance");
      if (isLedger) {
        const p = parseLedgerSummaryAsFc(text);
        const units = p.rows.reduce((s, r) => s + r.quantity, 0);
        return {
          kind,
          rows: p.rows as AnyReportRow[],
          warnings: p.warnings,
          skipped: p.skipped,
          summary:
            `${p.rows.length} dòng Ledger Summary FC · ${p.snapshotDates.length} ngày snapshot` +
            ` (mới nhất ${p.snapshotDates.at(-1) ?? "—"}) · ${units} đơn vị (EndingWarehouseBalance)`,
        };
      }
      const p = parseFcAllocationReport(text);
      const units = p.rows.reduce((s, r) => s + r.quantity, 0);
      return {
        kind,
        rows: p.rows as AnyReportRow[],
        warnings: p.warnings,
        skipped: p.skipped,
        summary:
          `${p.rows.length} dòng · ${p.snapshotDates.length} ngày snapshot` +
          ` (mới nhất ${p.snapshotDates.at(-1) ?? "—"}) · ${units} đơn vị`,
      };
    }
    case "receipts": {
      // Thử parse Ledger Detail Receipts trước (mới), fallback cũ
      const isLedgerDetail = text.toLowerCase().includes("eventtype") && text.toLowerCase().includes("referenceid");
      if (isLedgerDetail) {
        const p = parseLedgerDetailAsReceipts(text);
        const units = p.rows.reduce((s, r) => s + r.quantity, 0);
        const shipments = new Set(p.rows.map((r) => r.fbaShipmentId).filter((v) => v !== "")).size;
        return {
          kind,
          rows: p.rows as AnyReportRow[],
          warnings: p.warnings,
          skipped: p.skipped,
          summary:
            `${p.rows.length} dòng Ledger Detail Receipts · ${shipments} lô · ${units} đơn vị` +
            ` · từ ${p.receivedFrom ?? "—"} đến ${p.receivedTo ?? "—"}`,
        };
      }
      const p = parseReceiptsReport(text);
      const units = p.rows.reduce((s, r) => s + r.quantity, 0);
      const shipments = new Set(p.rows.map((r) => r.fbaShipmentId).filter((v) => v !== "")).size;
      return {
        kind,
        rows: p.rows as AnyReportRow[],
        warnings: p.warnings,
        skipped: p.skipped,
        summary:
          `${p.rows.length} dòng · ${shipments} lô · ${units} đơn vị` +
          ` · từ ${p.receivedFrom ?? "—"} đến ${p.receivedTo ?? "—"}`,
      };
    }
    case "storage-fees": {
      const p = parseStorageFeeReport(text);
      const fees = moneyByCurrency(
        p.rows.map((r) => ({ currency: r.currency, amount: r.estimatedMonthlyStorageFee ?? null })),
      );
      const biggest = Object.entries(p.byMonthFcCurrency)
        .sort((a, b) => b[1].fee - a[1].fee)
        .slice(0, 3)
        .map(([k, v]) => `${k.split("|").join("/")} ${round2(v.fee)}`)
        .join(", ");
      return {
        kind,
        rows: p.rows as AnyReportRow[],
        warnings: p.warnings,
        skipped: p.skipped,
        summary:
          `${p.rows.length} dòng · tháng ${p.months.join(", ") || "—"} · ` +
          `phí ${formatMoney(fees)}` +
          (biggest ? ` · kỳ phí lớn nhất: ${biggest}` : ""),
      };
    }
    case "noncompliance": {
      const p = parseInboundNoncomplianceReport(text);
      const fees = moneyByCurrency(
        p.rows.map((r) => ({ currency: r.currency, amount: r.feeTotal ?? null })),
      );
      return {
        kind,
        rows: p.rows as AnyReportRow[],
        warnings: p.warnings,
        skipped: p.skipped,
        summary:
          `${p.rows.length} dòng · ${p.shipments.length} lô · phí ${formatMoney(fees)}` +
          (p.problemTypes.length > 0 ? ` · loại vấn đề: ${p.problemTypes.join(", ")}` : ""),
      };
    }
  }
}

// ============================================================================
// Import: một hàm cho cả 4 loại (đi qua RPC service_role)
// ============================================================================

/**
 * Kết quả nhập. `groups`/`currencies` chỉ có nghĩa với report phí (0019);
 * với report tồn kho (0018) groups = số snapshot / số lô.
 */
export type ImportOutcome = ReportUpsertCounts & {
  groups: number;
  currencies: string[];
};

const NO_COUNTS: ImportOutcome = {
  inserted: 0,
  updated: 0,
  skipped: 0,
  merged: 0,
  groups: 0,
  currencies: [],
};

/** Kiểm tra nhẹ để không ghi nhầm rows của report này sang bảng của report khác. */
function assertRowsMatchKind(kind: ReportKind, rows: AnyReportRow[]): void {
  if (rows.length === 0) return;
  const first = rows[0] as Record<string, unknown>;
  const expected: Record<ReportKind, string> = {
    fc: "snapshotDate",
    receipts: "receivedDate",
    "storage-fees": "monthOfCharge",
    noncompliance: "issueReportedDate",
  };
  const field = expected[kind];
  if (!(field in first)) {
    throw new Error(
      `importParsedReport: rows không phải của report "${kind}" (thiếu trường ${field}). ` +
        `Đã parse nhầm loại report? Kiểm tra lại reportType khi createReport.`,
    );
  }
}

export async function importParsedReport(
  db: DbAdapter,
  sellerAccountId: string,
  parsed: ParsedReport,
): Promise<ImportOutcome> {
  assertRowsMatchKind(parsed.kind, parsed.rows);
  if (parsed.rows.length === 0) return { ...NO_COUNTS, skipped: parsed.skipped };

  switch (parsed.kind) {
    case "fc": {
      const counts = await db.upsertFcAllocation(
        sellerAccountId,
        parsed.rows as FcAllocationRowInput[],
      );
      const snapshots = new Set(
        (parsed.rows as FcAllocationRowInput[]).map((r) => r.snapshotDate),
      ).size;
      return { ...counts, groups: snapshots, currencies: [] };
    }
    case "receipts": {
      const counts = await db.upsertReceipts(
        sellerAccountId,
        parsed.rows as ReceiptRowInput[],
      );
      const shipments = new Set(
        (parsed.rows as ReceiptRowInput[])
          .map((r) => (r.fbaShipmentId ?? "").trim().toUpperCase())
          .filter((v) => v !== ""),
      ).size;
      return { ...counts, groups: shipments, currencies: [] };
    }
    case "storage-fees": {
      const counts: FeeUpsertCounts = await db.upsertStorageFees(
        sellerAccountId,
        parsed.rows as StorageFeeRowInput[],
      );
      return { ...counts, groups: counts.groups, currencies: counts.currencies };
    }
    case "noncompliance": {
      const counts: FeeUpsertCounts = await db.upsertNoncompliance(
        sellerAccountId,
        parsed.rows as NoncomplianceRowInput[],
      );
      return { ...counts, groups: counts.groups, currencies: counts.currencies };
    }
  }
}
