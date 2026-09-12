/**
 * Job — TỰ ĐỘNG KÉO 4 REPORT FBA qua Reports API (0019).
 *
 *   createReport → getReport (poll) → getReportDocument → tải (GZIP) → parse → RPC
 *
 * CHẠY Ở ĐÂU: Vercel Cron (`/api/cron/report-pull`, mỗi ngày) và CLI
 * (`worker reports:pull`). Vì Vercel đặt root = `web`, job nằm ở web/ — worker
 * dùng qua shim `worker/src/jobs/report-pull.job.ts`.
 *
 * BA LUẬT QUAN TRỌNG (sai một cái là cron thành "xanh giả"):
 *
 *   1. KHÔNG BLOCK CHỜ REPORT. Report chạy bất đồng bộ (IN_QUEUE → IN_PROGRESS →
 *      DONE). Cron chỉ poll vài lần với delay ngắn; chưa xong thì GHI TRẠNG THÁI
 *      vào connections.report_requests và trả về `pending` — lần chạy sau poll
 *      tiếp đúng reportId đó, KHÔNG xin report mới.
 *
 *   2. TÔN TRỌNG TRẦN 4 GIỜ. Report FBA dạng daily chỉ được yêu cầu 1 lần / 4 giờ
 *      cho MỖI loại. Nếu trong cửa sổ cooldown đã có yêu cầu (bất kể khoảng ngày)
 *      → poll cái cũ hoặc bỏ qua, kèm lý do rõ ràng trong log.
 *
 *   3. REPORT RỖNG KHÔNG PHẢI LỖI. Không có vấn đề inbound nào = không có dòng.
 *      Ghi status `no_data` để lần sau không tưởng là "chưa kéo", và UI giữ nhãn
 *      "không có phí/vấn đề nào" thay vì "chưa có dữ liệu".
 *
 * AN TOÀN DỮ LIỆU: job này KHÔNG tự quyết định ghi DB thật — việc đó do runner
 * (chỉ đưa SupabaseDbAdapter vào khi cfg.mode === "production"), giống mọi job khác.
 */
import type { DbAdapter, ReportRequestRow, ReportRequestStatus } from "../db/adapter.ts";
import {
  ReportsClient,
  SpApiRequestError,
  type ReportInfo,
} from "../amazon/reports.ts";
import {
  importParsedReport,
  parseReportText,
  specOf,
  type ImportOutcome,
  type ReportKind,
} from "../reports/registry.ts";

/** Shop tối thiểu mà job cần (ActiveShop của adapter thoả mãn). */
export type ReportPullShop = {
  id: string;
  displayName: string;
  marketplace: string;
};

export type ReportPullAction =
  | "created"      // vừa xin report mới, đang chờ Amazon
  | "polled"       // poll report cũ, vẫn chưa xong
  | "imported"     // tải + parse + ghi DB xong
  | "no_data"      // report DONE nhưng rỗng
  | "dry_run"      // đã tải + parse, KHÔNG ghi (--dry-run)
  | "pending"      // hết lượt poll trong lần chạy này, lần sau poll tiếp
  | "throttled"    // Amazon chặn vì trần tốc độ / hạn mức
  | "failed"       // lỗi thật (FATAL/CANCELLED/HTTP/mạng)
  | "skipped";     // không làm gì (chưa có credential, trong cooldown, …)

export type ReportPeriod = {
  /** YYYY-MM-DD (ghi vào DB) */
  start: string | null;
  end: string | null;
  /** ISO 8601 UTC (gửi Amazon) */
  startIso: string | null;
  endIso: string | null;
};

export type ReportRequestOutcome = {
  shopId: string;
  shopName: string;
  kind: ReportKind;
  reportType: string;
  action: ReportPullAction;
  status: ReportRequestStatus | null;
  reportId: string | null;
  documentId: string | null;
  period: ReportPeriod;
  /** số dòng hợp lệ đã parse (không phải số dòng ghi được — xem counts) */
  rows: number;
  counts: ImportOutcome | null;
  summary: string | null;
  warnings: string[];
  message: string;
  gzipped: boolean;
  bytes: number;
};

export type ReportPullResult = {
  /** "api" = gọi Amazon; "file" = nạp từ file local; "none" = không có gì để làm */
  source: "api" | "file" | "none";
  shopsProcessed: number;
  outcomes: ReportRequestOutcome[];
  imported: number;
  pending: number;
  noData: number;
  throttled: number;
  failed: number;
  skipped: number;
  rowsImported: number;
  errors: { shopId: string; kind: ReportKind; error: string }[];
};

export type ReportPullOptions = {
  db: DbAdapter;
  shops: ReportPullShop[];
  kinds?: readonly ReportKind[];
  /** ghi đè lookbackDays của spec (số ngày lùi về trước) */
  days?: number | null;
  dryRun?: boolean;
  now?: Date;
  log?: (s: string) => void;
  /**
   * Trả về client cho một shop; `null` = chưa có credential → job ghi `skipped`
   * kèm hướng dẫn, KHÔNG ném lỗi (cron phải chạy tiếp các shop khác).
   */
  clientFor?: (shop: ReportPullShop) => ReportsClient | null;
  /**
   * Nạp thẳng nội dung report (từ file local qua CLI, hoặc fixture trong test)
   * thay vì gọi Amazon. Đi qua ĐÚNG pipeline parse → RPC nên luật nhập không
   * bị chia làm hai bản.
   */
  texts?: Partial<Record<ReportKind, string>>;
  /** số lần poll trong MỘT lần chạy (mặc định 3) */
  pollAttempts?: number;
  /** delay giữa 2 lần poll, ms (mặc định 20s — cron 60s thì không chờ lâu hơn) */
  pollDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_POLL_ATTEMPTS = 3;
const DEFAULT_POLL_DELAY_MS = 20_000;

/** Trạng thái "còn phải quay lại" — lần chạy sau poll tiếp, không xin report mới. */
const RESUMABLE: readonly ReportRequestStatus[] = [
  "requested", "in_queue", "in_progress", "done",
];

const pad2 = (n: number) => String(n).padStart(2, "0");
const isoDay = (d: Date) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

/** Khoảng ngày gửi Amazon + lưu DB (UTC — Amazon hiểu dataStartTime theo UTC). */
export function computePeriod(
  kind: ReportKind,
  opts: { days?: number | null; now: Date },
): ReportPeriod {
  const spec = specOf(kind);
  if (!spec.needsDateRange) {
    return { start: null, end: null, startIso: null, endIso: null };
  }
  const days = Math.max(1, Math.round(opts.days ?? spec.lookbackDays));
  const end = new Date(opts.now.getTime());
  const start = new Date(end.getTime() - days * 86_400_000);
  return {
    start: isoDay(start),
    end: isoDay(end),
    startIso: `${isoDay(start)}T00:00:00Z`,
    endIso: `${isoDay(end)}T23:59:59Z`,
  };
}

function samePeriod(a: ReportPeriod, row: ReportRequestRow): boolean {
  return (row.dataStart ?? null) === a.start && (row.dataEnd ?? null) === a.end;
}

function hoursSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (now.getTime() - t) / 3_600_000;
}

function fmtCounts(c: ImportOutcome | null): string {
  if (!c) return "";
  const parts = [
    `ghi mới ${c.inserted}`,
    `cập nhật ${c.updated}`,
  ];
  if (c.merged > 0) parts.push(`gộp trùng khoá ${c.merged}`);
  if (c.skipped > 0) parts.push(`BỎ ${c.skipped} dòng rác`);
  if (c.currencies.length > 0) parts.push(`tiền: ${c.currencies.join(", ")}`);
  return parts.join(" · ");
}

export async function runReportPull(opts: ReportPullOptions): Promise<ReportPullResult> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const kinds = (opts.kinds?.length ? opts.kinds : ["fc", "receipts", "storage-fees", "noncompliance"]) as ReportKind[];
  const pollAttempts = Math.max(1, opts.pollAttempts ?? DEFAULT_POLL_ATTEMPTS);
  const pollDelayMs = Math.max(0, opts.pollDelayMs ?? DEFAULT_POLL_DELAY_MS);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const dryRun = opts.dryRun === true;

  const outcomes: ReportRequestOutcome[] = [];
  const errors: ReportPullResult["errors"] = [];
  const fileMode = !!opts.texts && kinds.some((k) => opts.texts?.[k] !== undefined);

  const push = (o: ReportRequestOutcome) => {
    outcomes.push(o);
    const tag = o.action === "imported" ? "OK " : o.action === "failed" || o.action === "throttled" ? "LỖI" : "···";
    log(
      `[report-pull] ${tag} ${o.shopName} · ${specOf(o.kind).label}\n` +
      `           ${o.period.start ? `${o.period.start} → ${o.period.end}` : "không khoảng ngày"} · ` +
      `action=${o.action}${o.reportId ? ` · reportId=${o.reportId}` : ""}\n` +
      `           ${o.message}\n` +
      (o.summary ? `           ${o.summary}\n` : "") +
      (o.counts ? `           ${fmtCounts(o.counts)}\n` : "") +
      (o.warnings.length > 0 ? `${o.warnings.map((w) => `           ⚠ ${w}\n`).join("")}` : ""),
    );
    if (o.action === "failed" || o.action === "throttled") {
      errors.push({ shopId: o.shopId, kind: o.kind, error: o.message });
    }
  };

  /**
   * Khung một outcome. `action` mặc định "skipped" — mọi nhánh đều gán lại trước
   * khi push(), nhưng có giá trị sẵn để TypeScript không phải đoán union.
   */
  const base = (
    shop: ReportPullShop,
    kind: ReportKind,
    period: ReportPeriod,
  ): ReportRequestOutcome => ({
    shopId: shop.id,
    shopName: shop.displayName,
    kind,
    reportType: specOf(kind).reportType,
    action: "skipped",
    status: null as ReportRequestStatus | null,
    reportId: null as string | null,
    documentId: null as string | null,
    period,
    rows: 0,
    counts: null as ImportOutcome | null,
    summary: null as string | null,
    warnings: [] as string[],
    message: "",
    gzipped: false,
    bytes: 0,
  });

  /** Parse + (nếu không dry-run) ghi DB + ghi trạng thái report. */
  const ingest = async (
    shop: ReportPullShop,
    kind: ReportKind,
    period: ReportPeriod,
    text: string,
    ctx: { reportId: string | null; documentId: string | null; marketplaceId?: string | null; requestedAt?: string | null; gzipped?: boolean; bytes?: number },
  ): Promise<ReportRequestOutcome> => {
    const out = base(shop, kind, period);
    out.reportId = ctx.reportId;
    out.documentId = ctx.documentId;
    out.gzipped = ctx.gzipped === true;
    out.bytes = ctx.bytes ?? text.length;

    const parsed = parseReportText(kind, text);
    out.rows = parsed.rows.length;
    out.warnings = parsed.warnings;
    out.summary = parsed.summary;

    if (parsed.rows.length === 0) {
      // Report rỗng: với phí inbound đây là TIN TỐT (không có vấn đề gì).
      out.action = "no_data";
      out.status = "no_data";
      out.message =
        `Report không có dòng nào dùng được (bỏ ${parsed.skipped} dòng rác). ` +
        (kind === "noncompliance"
          ? "Với phí inbound, rỗng thường nghĩa là KHÔNG có vấn đề gì — không phải lỗi."
          : "Kiểm tra lại khoảng ngày hoặc loại report đã chọn.");
      if (!dryRun) {
        await recordState(shop, kind, period, out.status, ctx, { rowsImported: 0, lastError: null });
      }
      return out;
    }

    if (dryRun) {
      out.action = "dry_run";
      out.status = null;
      out.message = `dry-run: đã parse ${parsed.rows.length} dòng, KHÔNG ghi DB.`;
      return out;
    }

    const counts = await importParsedReport(opts.db, shop.id, parsed);
    out.counts = counts;
    out.action = "imported";
    out.status = "imported";
    out.message = `đã nhập ${parsed.rows.length} dòng vào DB.`;
    await recordState(shop, kind, period, "imported", ctx, {
      rowsImported: parsed.rows.length,
      lastError: null,
    });
    return out;
  };

  /** Ghi trạng thái vào connections.report_requests (bỏ qua lỗi để không chết cả job). */
  const recordState = async (
    shop: ReportPullShop,
    kind: ReportKind,
    period: ReportPeriod,
    status: ReportRequestStatus,
    ctx: { reportId?: string | null; documentId?: string | null; marketplaceId?: string | null; requestedAt?: string | null; lastError?: string | null },
    extra?: { rowsImported?: number | null; lastError?: string | null },
  ): Promise<void> => {
    if (dryRun) return;
    try {
      await opts.db.setReportRequest(shop.id, {
        reportType: specOf(kind).reportType,
        marketplaceId: ctx.marketplaceId ?? shop.marketplace ?? null,
        dataStart: period.start,
        dataEnd: period.end,
        reportId: ctx.reportId ?? null,
        reportDocumentId: ctx.documentId ?? null,
        status,
        rowsImported: extra?.rowsImported ?? null,
        lastError: extra?.lastError ?? ctx.lastError ?? null,
        requestedAt: ctx.requestedAt ?? now.toISOString(),
        completedAt: status === "imported" || status === "no_data" ? now.toISOString() : null,
        importedAt: status === "imported" ? now.toISOString() : null,
      });
    } catch (e) {
      log(`[report-pull] ⚠ không ghi được trạng thái report (${(e as Error).message.split("\n")[0]})\n`);
    }
  };

  for (const shop of opts.shops) {
    for (const kind of kinds) {
      const spec = specOf(kind);
      const period = computePeriod(kind, { days: opts.days ?? null, now });

      // ---- (A) Chế độ file / fixture: không gọi Amazon -----------------------
      const text = opts.texts?.[kind];
      if (text !== undefined) {
        try {
          push(await ingest(shop, kind, period, text, {
            reportId: null,
            documentId: null,
            marketplaceId: shop.marketplace,
          }));
        } catch (e) {
          const out = base(shop, kind, period);
          out.action = "failed";
          out.status = "failed";
          out.message = `lỗi khi nạp report từ file: ${(e as Error).message.split("\n")[0]}`;
          push(out);
        }
        continue;
      }

      // ---- (B) Chế độ API ----------------------------------------------------
      const client = opts.clientFor?.(shop) ?? null;
      if (!client) {
        const out = base(shop, kind, period);
        out.action = "skipped";
        out.message =
          "chưa có credential SP-API (AMAZON_LWA_CLIENT_ID / _SECRET / _REFRESH_TOKEN) " +
          `nên không tự kéo "${spec.label}" được. Nhập tay: tải TSV từ Seller Central rồi chạy ` +
          `\`npm run worker:reports-pull -- --${kind}=<file>\`` +
          (kind === "fc" || kind === "receipts"
            ? " (hoặc `npm run worker:inventory-fc` nếu muốn kèm bản tóm tắt FC)."
            : ".");
        push(out);
        continue;
      }

      // ---- (B1) Đọc trạng thái cũ: poll tiếp hay xin mới? ---------------------
      let existing: ReportRequestRow | null = null;
      let samePeriodRow: ReportRequestRow | null = null;
      try {
        const list = await opts.db.listReportRequests(shop.id, {
          reportType: spec.reportType,
          limit: 50,
        });
        samePeriodRow = list.find((r) => samePeriod(period, r)) ?? null;
        // Yêu cầu GẦN NHẤT trong cửa sổ cooldown (bất kể khoảng ngày) — trần của
        // Amazon tính theo LOẠI REPORT, không theo khoảng ngày.
        existing =
          list.find((r) => {
            const h = hoursSince(r.requestedAt, now);
            return h !== null && h >= 0 && h < spec.cooldownHours;
          }) ?? null;
      } catch (e) {
        const out = base(shop, kind, period);
        out.warnings.push(
          `không đọc được trạng thái report cũ (${(e as Error).message.split("\n")[0]}) — ` +
            `sẽ thử xin report mới, có thể chạm trần 4 giờ của Amazon.`,
        );
        log(`[report-pull] ⚠ ${out.warnings[0]}\n`);
      }

      // Đang chờ (kể cả của khoảng ngày khác) → poll tiếp, KHÔNG xin mới.
      const resumable = existing && existing.reportId && RESUMABLE.includes(existing.status)
        ? existing
        : samePeriodRow && samePeriodRow.reportId && RESUMABLE.includes(samePeriodRow.status)
          ? samePeriodRow
          : null;

      if (!resumable) {
        // (TS: phải narrow trực tiếp trên samePeriodRow — biến `done` trung gian
        //  làm mất narrowing và báo "possibly null".)
        if (samePeriodRow && ["imported", "no_data"].includes(samePeriodRow.status)) {
          const out = base(shop, kind, period);
          out.action = "skipped";
          out.status = samePeriodRow.status;
          out.reportId = samePeriodRow.reportId ?? null;
          out.rows = samePeriodRow.rowsImported ?? 0;
          out.message =
            `khoảng ngày này đã ${samePeriodRow.status === "imported" ? "NHẬP XONG" : "không có dữ liệu"} ` +
            `lúc ${samePeriodRow.importedAt ?? samePeriodRow.completedAt ?? samePeriodRow.requestedAt ?? "?"} ` +
            `(${samePeriodRow.rowsImported ?? 0} dòng) — không kéo lại.`;
          push(out);
          continue;
        }
        if (existing) {
          const h = hoursSince(existing.requestedAt, now);
          const out = base(shop, kind, period);
          out.action = "skipped";
          out.status = existing.status;
          out.reportId = existing.reportId ?? null;
          out.message =
            `Amazon chỉ cho yêu cầu loại report này 1 lần / ${spec.cooldownHours} giờ. ` +
            `Lần gần nhất cách đây ${h === null ? "?" : h.toFixed(1)} giờ (status=${existing.status}) ` +
            `→ bỏ qua, lần chạy sau thử lại.`;
          push(out);
          continue;
        }
      }

      // ---- (B2) Xin report mới (nếu không có cái nào để poll tiếp) ------------
      let reportId = resumable?.reportId ?? null;
      const requestedAt = resumable?.requestedAt ?? now.toISOString();

      if (!reportId) {
        try {
          const created = await client.createReport({
            reportType: spec.reportType,
            marketplaceIds: [shop.marketplace],
            dataStartTime: period.startIso,
            dataEndTime: period.endIso,
          });
          reportId = created.reportId;
          await recordState(shop, kind, period, "requested", {
            reportId,
            marketplaceId: shop.marketplace,
            requestedAt,
          });
          const out = base(shop, kind, period);
          out.action = "created";
          out.status = "requested";
          out.reportId = reportId;
          out.message = `đã xin report mới (reportId=${reportId}) — Amazon đang tạo, sẽ poll ở bước sau.`;
          // KHÔNG push ngay: thử poll luôn trong cùng lần chạy (report nhỏ thường
          // xong trong vài chục giây), để cron một ngày có thể nhập luôn dữ liệu.
          const polled = await pollAndIngest(shop, kind, period, client, reportId, requestedAt, out);
          push(polled);
        } catch (e) {
          push(await handleApiError(shop, kind, period, e, { reportId: null, requestedAt }));
        }
        continue;
      }

      // ---- (B3) Poll report đang chờ ------------------------------------------
      const out = base(shop, kind, period);
      out.reportId = reportId;
      out.action = "polled";
      out.message = `poll report có sẵn (reportId=${reportId}, status cũ=${resumable?.status}).`;
      try {
        push(await pollAndIngest(shop, kind, period, client, reportId, requestedAt, out));
      } catch (e) {
        push(await handleApiError(shop, kind, period, e, { reportId, requestedAt }));
      }
    }
  }

  /**
   * Poll tới khi DONE / CANCELLED / FATAL hoặc hết lượt.
   * Hết lượt mà vẫn IN_QUEUE/IN_PROGRESS → trả `pending` (lần chạy sau poll tiếp).
   */
  async function pollAndIngest(
    shop: ReportPullShop,
    kind: ReportKind,
    period: ReportPeriod,
    client: ReportsClient,
    reportId: string,
    requestedAt: string,
    out: ReportRequestOutcome,
  ): Promise<ReportRequestOutcome> {
    let info: ReportInfo | null = null;
    for (let attempt = 1; attempt <= pollAttempts; attempt++) {
      info = await client.getReport(reportId);
      const st = info.processingStatus;

      if (st === "IN_QUEUE" || st === "IN_PROGRESS") {
        out.status = st === "IN_QUEUE" ? "in_queue" : "in_progress";
        if (attempt < pollAttempts) {
          await sleep(pollDelayMs);
          continue;
        }
        out.action = "pending";
        out.message =
          `Amazon vẫn đang tạo report (${st}) sau ${attempt} lần poll — ` +
          `không chờ tiếp, lần chạy sau poll lại reportId=${reportId}.`;
        await recordState(shop, kind, period, out.status, {
          reportId,
          marketplaceId: shop.marketplace,
          requestedAt,
        });
        return out;
      }

      if (st === "CANCELLED" || st === "FATAL") {
        out.action = "failed";
        out.status = st === "CANCELLED" ? "cancelled" : "fatal";
        out.message =
          `Amazon ${st === "CANCELLED" ? "ĐÃ HUỶ" : "BÁO LỖI KHÔNG TẠO ĐƯỢC"} report ` +
          `(${st})${info.message ? `: ${info.message}` : ""}. Lần chạy sau sẽ xin report mới.`;
        await recordState(shop, kind, period, out.status, {
          reportId,
          marketplaceId: shop.marketplace,
          requestedAt,
          lastError: out.message,
        });
        return out;
      }

      // DONE → tải document
      const content = await client.fetchReportContent(reportId);
      if (content.text === null) {
        // Hiếm: getReport nói DONE nhưng fetchReportContent đọc lại vẫn chưa DONE.
        out.action = "pending";
        out.status = "in_progress";
        out.message = `report ${reportId} đổi trạng thái giữa 2 lần đọc (${content.info.processingStatus}) — thử lại lần sau.`;
        return out;
      }
      return ingest(shop, kind, period, content.text, {
        reportId,
        documentId: content.documentId,
        marketplaceId: shop.marketplace,
        requestedAt,
        gzipped: content.gzipped,
        bytes: content.bytes,
      });
    }

    out.action = "pending";
    out.message = `hết ${pollAttempts} lần poll mà chưa có kết quả (reportId=${reportId}).`;
    return out;
  }

  /** Lỗi API → phân biệt TRẦN TỐC ĐỘ (thử lại sau) với lỗi thật (cần người xem). */
  async function handleApiError(
    shop: ReportPullShop,
    kind: ReportKind,
    period: ReportPeriod,
    e: unknown,
    ctx: { reportId: string | null; requestedAt: string },
  ): Promise<ReportRequestOutcome> {
    const out = base(shop, kind, period);
    out.reportId = ctx.reportId;
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    const throttled = e instanceof SpApiRequestError && e.isThrottled;
    out.action = throttled ? "throttled" : "failed";
    out.status = "failed";
    out.message = throttled
      ? `Amazon chặn vì trần tốc độ/hạn mức report — không phải lỗi cấu hình, lần chạy sau thử lại. (${msg})`
      : `gọi Reports API thất bại: ${msg}`;
    await recordState(shop, kind, period, "failed", {
      reportId: ctx.reportId,
      marketplaceId: shop.marketplace,
      requestedAt: ctx.requestedAt,
      lastError: msg,
    });
    return out;
  }

  const tally = (a: ReportPullAction) => outcomes.filter((o) => o.action === a).length;
  return {
    source: fileMode ? "file" : opts.clientFor ? "api" : "none",
    shopsProcessed: new Set(outcomes.map((o) => o.shopId)).size,
    outcomes,
    imported: tally("imported") + tally("dry_run"),
    pending: tally("pending") + tally("created") + tally("polled"),
    noData: tally("no_data"),
    throttled: tally("throttled"),
    failed: tally("failed"),
    skipped: tally("skipped"),
    rowsImported: outcomes.reduce((s, o) => s + (o.counts?.inserted ?? 0) + (o.counts?.updated ?? 0), 0),
    errors,
  };
}
