/**
 * Reporting API v3 (Amazon Ads) — luồng 3 bước BẤT ĐỒNG BỘ:
 *
 *   1. POST /reporting/reports                     → { reportId, status: "PENDING", url: null }
 *   2. GET  /reporting/reports/{reportId}          → status PENDING|PROCESSING|COMPLETED|FAILED…
 *                                                     khi COMPLETED thì có `url` (S3) + `urlExpiresAt`
 *   3. GET  <url>                                  → file GZIP_JSON → giải nén → MẢNG row
 *
 * Amazon nói rõ report có thể chạy TỚI 3 GIỜ. Nên cron KHÔNG được ngồi chờ:
 * xin report → ghi reportId vào ads.report_requests → lần chạy sau poll tiếp
 * (đúng quy ước đã chốt, giống job report-pull của SP-API).
 *
 * Hai mã trạng thái dễ hiểu sai:
 *   425 = đã có yêu cầu report Y HỆT đang chạy → giữ reportId cũ, poll tiếp (không phải lỗi)
 *   429 = trần tốc độ → bỏ qua lượt này, KHÔNG retry dồn
 *
 * Cột (columns) khác nhau theo loại report và theo loại nhà quảng cáo:
 *   seller dùng sales7d/purchases7d; vendor/author dùng sales14d — nên cửa sổ
 *   attribution là tham số, và khi Amazon chê cột nào thì BỎ CỘT ĐÓ rồi xin lại
 *   (thà thiếu một cột còn hơn cả ngày không có số liệu).
 */
import type { AdsClient } from "./client.ts";
import { ADS_MEDIA, ADS_REPORT_MAX_DAYS, ADS_REPORT_RETENTION_DAYS } from "./config.ts";
import { AdsApiError } from "./errors.ts";

export type AdsReportKind = "campaigns" | "advertised" | "searchTerms" | "targeting";

export const ADS_REPORT_KINDS: readonly AdsReportKind[] = ["campaigns", "advertised", "searchTerms", "targeting"];

export function isAdsReportKind(v: unknown): v is AdsReportKind {
  return typeof v === "string" && (ADS_REPORT_KINDS as readonly string[]).includes(v);
}

export type ReportSpec = {
  kind: AdsReportKind;
  reportTypeId: string;
  adProduct: string;
  /** v3 nhận MẢNG groupBy; mình dùng 1 phần tử cho khớp khoá unique của ads.report_requests. */
  groupBy: string[];
  /** groupBy dạng chuỗi (ghi vào DB — khoá unique dùng text). */
  groupByKey: string;
  columns: string[];
  /** Bộ cột tối thiểu đã được xác minh chạy được — dùng khi Amazon chê cột. */
  minimalColumns: string[];
  timeUnit: "DAILY" | "SUMMARY";
  maxDays: number;
  retentionDays: number;
  /** RPC 0020 nào nhận dữ liệu của loại này. */
  rpc: string;
};

export type ReportRange = { startDate: string; endDate: string };

/**
 * Cột theo từng loại report (tên cột lấy từ tài liệu Report types v3 + RPC 0020
 * đã chấp nhận cả alias v2/v3 nên đẩy thẳng lên được).
 */
function columnsFor(kind: AdsReportKind, w: 7 | 14 | 30): { full: string[]; minimal: string[] } {
  const sales = `sales${w}d`;
  const purchases = `purchases${w}d`;
  const units = `unitsSoldClicks${w}d`;
  const acos = `acosClicks${w}d`;
  const roas = `roasClicks${w}d`;

  switch (kind) {
    case "campaigns":
      return {
        full: [
          "date",
          "campaignId",
          "campaignName",
          "campaignStatus",
          "campaignType",
          "campaignBudgetAmount",
          "campaignBudgetCurrencyCode",
          "impressions",
          "clicks",
          "cost",
          sales,
          purchases,
          units,
          acos,
          roas,
        ],
        // Bộ tối thiểu đã thấy chạy thật (groupBy campaign, DAILY): date/campaignId/
        // impressions/clicks/cost/sales7d/purchases7d.
        minimal: ["date", "campaignId", "impressions", "clicks", "cost", sales, purchases],
      };
    case "advertised":
      return {
        full: [
          "date",
          "campaignId",
          "adGroupId",
          "advertisedAsin",
          "advertisedSku",
          "impressions",
          "clicks",
          "cost",
          sales,
          purchases,
          units,
        ],
        minimal: ["date", "advertisedAsin", "impressions", "clicks", "cost", sales, purchases],
      };
    case "searchTerms":
      return {
        full: [
          "date",
          "campaignId",
          "campaignName",
          "adGroupId",
          "adGroupName",
          "keywordId",
          "keyword",
          "keywordType",
          "matchType",
          "targeting",
          "searchTerm",
          "impressions",
          "clicks",
          "cost",
          sales,
          purchases,
          units,
          acos,
        ],
        minimal: ["date", "searchTerm", "campaignId", "clicks", "cost", sales, purchases],
      };
    case "targeting":
      return {
        full: [
          "date",
          "campaignId",
          "campaignName",
          "adGroupId",
          "adGroupName",
          "targetingId",
          "targetingExpression",
          "keywordId",
          "keyword",
          "keywordType",
          "matchType",
          "impressions",
          "clicks",
          "cost",
          sales,
          purchases,
          units,
          acos,
        ],
        minimal: ["date", "campaignId", "targetingId", "clicks", "cost", sales, purchases],
      };
  }
}

export const REPORT_TYPE_IDS: Record<AdsReportKind, string> = {
  campaigns: "spCampaigns",
  advertised: "spAdvertisedProduct",
  searchTerms: "spSearchTerm",
  targeting: "spTargeting",
};

export function reportSpec(
  kind: AdsReportKind,
  opts: { attributionDays?: 7 | 14 | 30; timeUnit?: "DAILY" | "SUMMARY" } = {},
): ReportSpec {
  const w = opts.attributionDays ?? 7;
  const { full, minimal } = columnsFor(kind, w);
  const reportTypeId = REPORT_TYPE_IDS[kind];
  return {
    kind,
    reportTypeId,
    adProduct: "SPONSORED_PRODUCTS",
    groupBy: groupByFor(kind),
    groupByKey: groupByFor(kind)[0],
    columns: full,
    minimalColumns: minimal,
    timeUnit: opts.timeUnit ?? "DAILY",
    maxDays: ADS_REPORT_MAX_DAYS,
    retentionDays: ADS_REPORT_RETENTION_DAYS[reportTypeId] ?? 60,
    rpc: RPC_FOR_KIND[kind],
  };
}

function groupByFor(kind: AdsReportKind): string[] {
  switch (kind) {
    case "campaigns":
      return ["campaign"];
    case "advertised":
      return ["asin"];
    case "searchTerms":
      return ["searchTerm"];
    case "targeting":
      return ["targeting"];
  }
}

export const RPC_FOR_KIND: Record<AdsReportKind, string> = {
  campaigns: "vexim_worker_upsert_ads_metrics",
  advertised: "vexim_worker_upsert_ads_advertised",
  searchTerms: "vexim_worker_upsert_ads_search_terms",
  targeting: "vexim_worker_upsert_ads_targeting",
};

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Khoảng ngày cho report. Mặc định kết thúc ở HÔM QUA (UTC): dữ liệu ngày hôm nay
 * chưa chốt (attribution 7 ngày còn đang cộng dồn) nên kéo hôm nay chỉ tổ ghi số
 * non rồi phải ghi đè. `days` bị kẹp vào trần 31 ngày của Amazon.
 */
export function reportWindow(
  opts: { days?: number; endDate?: Date | string | null; now?: Date; spec?: ReportSpec } = {},
): ReportRange {
  const now = opts.now ?? new Date();
  const maxDays = opts.spec?.maxDays ?? ADS_REPORT_MAX_DAYS;
  const days = Math.max(1, Math.min(Math.floor(opts.days ?? 7), maxDays));

  let end: Date;
  if (opts.endDate) {
    const parsed = typeof opts.endDate === "string" ? new Date(`${opts.endDate.slice(0, 10)}T00:00:00Z`) : opts.endDate;
    end = Number.isNaN(parsed.getTime()) ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)) : parsed;
  } else {
    end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  }
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  return { startDate: isoDay(start), endDate: isoDay(end) };
}

/** Không xin report vượt retention — Amazon sẽ trả 400 hoặc dữ liệu cụt. */
export function clampWindowToRetention(range: ReportRange, spec: ReportSpec, now: Date = new Date()): ReportRange {
  const oldest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - spec.retentionDays + 1));
  const start = new Date(`${range.startDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || start >= oldest) return range;
  return { startDate: isoDay(oldest), endDate: range.endDate };
}

export function buildReportRequest(
  spec: ReportSpec,
  range: ReportRange,
  opts: { name?: string; columns?: string[]; filters?: { field: string; values: string[] }[] } = {},
): Record<string, unknown> {
  const columns = opts.columns ?? spec.columns;
  const configuration: Record<string, unknown> = {
    adProduct: spec.adProduct,
    groupBy: spec.groupBy,
    columns,
    reportTypeId: spec.reportTypeId,
    timeUnit: spec.timeUnit,
    format: "GZIP_JSON",
  };
  if (opts.filters && opts.filters.length > 0) configuration.filters = opts.filters;
  return {
    name:
      opts.name ??
      `vexim_${spec.reportTypeId}_${range.startDate}_${range.endDate}`.slice(0, 100),
    startDate: range.startDate,
    endDate: range.endDate,
    configuration,
  };
}

export type ReportTicket = {
  reportId: string | null;
  status: string | null;
  url: string | null;
  urlExpiresAt: string | null;
  rowCount: number | null;
  fileSize: number | null;
  failureReason: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  raw: Record<string, unknown>;
};

export function normalizeReportTicket(res: unknown): ReportTicket {
  const rec = (res && typeof res === "object" ? res : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const n = (v: unknown) => {
    const x = Number(v);
    return v === null || v === undefined || v === "" || !Number.isFinite(x) ? null : x;
  };
  return {
    reportId: str(rec.reportId),
    status: str(rec.status)?.toUpperCase() ?? null,
    url: str(rec.url),
    urlExpiresAt: str(rec.urlExpiresAt),
    rowCount: n(rec.rowCount),
    fileSize: n(rec.fileSize),
    failureReason: str(rec.failureReason) ?? str(rec.statusDetails),
    createdAt: str(rec.createdAt),
    updatedAt: str(rec.updatedAt) ?? str(rec.generatedAt),
    raw: rec,
  };
}

export type ReportState = "pending" | "completed" | "failed" | "unknown";

/** Amazon: PENDING/PROCESSING = đang tạo; COMPLETED = tải được; còn lại là chết. */
export function classifyReportStatus(status: string | null): ReportState {
  const s = (status ?? "").toUpperCase();
  if (s === "PENDING" || s === "PROCESSING" || s === "IN_PROGRESS" || s === "IN_QUEUE") return "pending";
  if (s === "COMPLETED" || s === "SUCCESS" || s === "DONE") return "completed";
  if (s === "FAILED" || s === "FAILURE" || s === "CANCELLED" || s === "CANCELED" || s === "EXPIRED") return "failed";
  return "unknown";
}

export async function createReport(
  client: AdsClient,
  body: Record<string, unknown>,
): Promise<ReportTicket> {
  const res = await client.request<unknown>("POST", "/reporting/reports", {
    body,
    contentType: ADS_MEDIA.createReport,
    accept: ADS_MEDIA.json,
  });
  return normalizeReportTicket(res);
}

export async function getReport(client: AdsClient, reportId: string): Promise<ReportTicket> {
  const res = await client.request<unknown>("GET", `/reporting/reports/${encodeURIComponent(reportId)}`, {
    // Tài liệu dùng chính media type này cho cả GET; không đặt Accept lạ để tránh 406.
    contentType: ADS_MEDIA.report,
  });
  return normalizeReportTicket(res);
}

export type CreateReportOutcome = {
  ticket: ReportTicket;
  usedColumns: string[];
  attempts: number;
  warnings: string[];
};

/**
 * Xin report, TỰ BỚT CỘT khi Amazon chê (400 invalid column):
 *   lượt 1: đủ cột → lượt 2: bỏ đúng cột bị chê → lượt 3: bộ cột tối thiểu.
 * Hết lượt mà vẫn lỗi thì ném để cron ghi `failed` kèm message thật (không im lặng).
 */
export async function createReportWithColumnFallback(
  client: AdsClient,
  spec: ReportSpec,
  range: ReportRange,
  opts: { name?: string; filters?: { field: string; values: string[] }[]; maxAttempts?: number } = {},
): Promise<CreateReportOutcome> {
  const warnings: string[] = [];
  const maxAttempts = opts.maxAttempts ?? 3;
  let columns = [...spec.columns];
  let attempts = 0;
  let lastError: AdsApiError | null = null;

  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      const ticket = await createReport(client, buildReportRequest(spec, range, { ...opts, columns }));
      if (!ticket.reportId) {
        warnings.push("Amazon trả 200 nhưng không có reportId — coi như thất bại.");
        throw new AdsApiError({
          code: "bad_response",
          status: 200,
          message: "Phản hồi tạo report không có reportId.",
          hint: "Xem raw trong log; có thể tài khoản chưa được bật Reporting v3.",
          retryable: false,
          retryAfterSec: null,
          badColumns: [],
          raw: JSON.stringify(ticket.raw).slice(0, 400),
        });
      }
      return { ticket, usedColumns: columns, attempts, warnings };
    } catch (e) {
      if (!(e instanceof AdsApiError)) throw e;
      lastError = e;
      // 425/429/5xx không liên quan tới cột → ném lên ngay cho cron phân loại.
      if (e.code !== "invalid_column" && e.code !== "invalid_request") throw e;
      if (attempts >= maxAttempts) break;

      const before = columns.length;
      if (e.badColumns.length > 0) {
        const bad = new Set(e.badColumns.map((c) => c.toLowerCase()));
        columns = columns.filter((c) => !bad.has(c.toLowerCase()));
      }
      if (columns.length === before || columns.length < spec.minimalColumns.length) {
        columns = [...spec.minimalColumns];
      }
      warnings.push(
        `Amazon chê cột (${e.message.slice(0, 160)}) → thử lại với ${columns.length} cột: ${columns.join(", ")}.`,
      );
    }
  }

  throw lastError ?? new AdsApiError({
    code: "invalid_request",
    status: 400,
    message: "Không tạo được report.",
    hint: null,
    retryable: false,
    retryAfterSec: null,
    badColumns: [],
    raw: null,
  });
}

/* ------------------------------------------------------------------ */
/* Tải + giải nén file report                                         */
/* ------------------------------------------------------------------ */
const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  // DecompressionStream có sẵn ở Node 18+ và edge runtime → không phải import node:zlib.
  if (typeof DecompressionStream === "undefined") {
    throw new Error("Runtime không có DecompressionStream — không giải nén được report GZIP.");
  }
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1;
}

/**
 * Amazon trả file GZIP_JSON: có thể là MẢNG object, có thể NDJSON (mỗi dòng một
 * object). Nhận cả hai, và nhận cả trường hợp fetch tự giải nén (khi Amazon gửi
 * kèm header Content-Encoding) — kiểm bằng magic byte chứ không tin header.
 */
export async function parseReportBytes(input: ArrayBuffer | Uint8Array): Promise<Record<string, unknown>[]> {
  let bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (isGzip(bytes)) bytes = await gunzip(bytes);
  const text = new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "").trim();
  return parseReportText(text);
}

export function parseReportText(text: string): Record<string, unknown>[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // 1) JSON chuẩn: mảng hoặc object bọc {rows: […]}
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed.filter(isRow) as Record<string, unknown>[];
      if (parsed && typeof parsed === "object") {
        const rec = parsed as Record<string, unknown>;
        if (Array.isArray(rec.rows)) return rec.rows.filter(isRow) as Record<string, unknown>[];
        // một object đơn lẻ (report 1 dòng) cũng là dữ liệu
        if (isRow(rec)) return [rec];
      }
    } catch {
      // rơi xuống NDJSON
    }
  }

  // 2) NDJSON: mỗi dòng một object (bỏ dòng rác không parse được, ĐẾM để báo)
  const rows: Record<string, unknown>[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l === "[" || l === "]") continue;
    try {
      const parsed = JSON.parse(l.endsWith(",") ? l.slice(0, -1) : l) as unknown;
      if (isRow(parsed)) rows.push(parsed as Record<string, unknown>);
    } catch {
      // dòng không phải JSON → bỏ qua (parseReportBytes trả số dòng để caller báo)
    }
  }
  return rows;
}

function isRow(v: unknown): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Tải report: ưu tiên `url` (S3, không cần header auth). Nếu Amazon không trả url
 * (vài vùng/bản cũ) thì fallback gọi /reporting/reports/{id}/rows bằng client.
 */
export async function downloadReportRows(
  input: { url?: string | null; client?: AdsClient | null; reportId?: string | null },
  opts: { fetchFn?: typeof fetch } = {},
): Promise<{ rows: Record<string, unknown>[]; via: "s3_url" | "rows_endpoint"; bytes: number }> {
  const fetchFn = opts.fetchFn ?? fetch;

  if (input.url) {
    const res = await fetchFn(input.url, { headers: { Accept: "*/*" } });
    if (!res.ok) {
      throw new AdsApiError({
        code: res.status === 403 || res.status === 404 ? "not_found" : "bad_response",
        status: res.status,
        message: `Tải file report từ S3 thất bại (HTTP ${res.status}).`,
        hint:
          "url của report có hạn (urlExpiresAt) — quá hạn thì poll lại GET /reporting/reports/{id} " +
          "để lấy url mới, hoặc xin lại report.",
        retryable: res.status >= 500,
        retryAfterSec: null,
        badColumns: [],
        raw: null,
      });
    }
    const buf = await res.arrayBuffer();
    return { rows: await parseReportBytes(buf), via: "s3_url", bytes: buf.byteLength };
  }

  if (input.client && input.reportId) {
    const buf = await input.client.request<ArrayBuffer>(
      "GET",
      `/reporting/reports/${encodeURIComponent(input.reportId)}/rows`,
      { contentType: ADS_MEDIA.report, accept: "application/vnd.compressed+json", raw: true, query: { count: 100000 } },
    );
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    return { rows: await parseReportBytes(bytes), via: "rows_endpoint", bytes: bytes.byteLength };
  }

  throw new AdsApiError({
    code: "bad_response",
    status: 0,
    message: "Không có url của report và cũng không có client để gọi /rows.",
    hint: "Poll lại GET /reporting/reports/{reportId} — khi status=COMPLETED thì url mới có.",
    retryable: false,
    retryAfterSec: null,
    badColumns: [],
    raw: null,
  });
}

/**
 * Gắn thêm ngữ cảnh vào từng row trước khi đẩy lên RPC: profileId, reportId,
 * tiền tệ, nguồn. RPC 0020 chấp nhận cả tên cột v3 lẫn v2 nên KHÔNG đổi tên cột
 * ở đây — đổi tên là mất khả năng đối chiếu với file gốc của Amazon.
 */
export function decorateRows(
  rows: Record<string, unknown>[],
  ctx: { profileId: string; reportId: string | null; currency?: string | null; source?: string },
): Record<string, unknown>[] {
  return rows.map((r) => ({
    ...r,
    adsProfileId: ctx.profileId,
    reportId: ctx.reportId,
    // Amazon không lặp lại tiền tệ trong mỗi row của report SP; lấy từ profile.
    ...(ctx.currency ? { currencyCode: (r.currencyCode as string | undefined) ?? ctx.currency } : {}),
    source: ctx.source ?? "ads_reporting_v3",
  }));
}
