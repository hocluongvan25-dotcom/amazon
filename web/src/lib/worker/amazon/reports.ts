/**
 * Typed client Reports API v0 (2021-06-30) — createReport → getReport → getReportDocument.
 *
 * VÌ SAO CẦN (Module 3 nâng cao, đợt 2):
 *   Bốn report nuôi các màn I2/I4 và phí theo FC đều KHÔNG có API realtime:
 *     • GET_LEDGER_SUMMARY_VIEW_DATA (thay cho DEPRECATED GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA) → phân bổ tồn theo FC
 *     • GET_LEDGER_DETAIL_VIEW_DATA (thay cho DEPRECATED GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA) → lịch sử nhận hàng
 *     • GET_FBA_STORAGE_FEE_CHARGES_DATA                → phí lưu kho theo FC
 *     • GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA  → phí inbound sai quy cách
 *   Trước đây phải vào Seller Central tải file TSV rồi nạp tay. Client này để
 *   Vercel Cron tự kéo mỗi ngày (route /api/cron/report-pull).
 *
 * FIX 400 09/2026:
 *   2 report FBA cũ bị Amazon deprecated từ 31/01/2023 → 400 InvalidInput "Report type is deprecated"
 *   → Migrate sang ledger reports với reportOptions, và cải thiện log details để Worker console thấy lý do.
 *
 * BA ĐẶC THÙ PHẢI XỬ LÝ (nếu không cron sẽ "xanh giả"):
 *   1. BẤT ĐỒNG BỘ: createReport chỉ trả reportId. Report chạy IN_QUEUE →
 *      IN_PROGRESS → DONE (có documentId). Cron không được block chờ: ghi trạng
 *      thái vào connections.report_requests (0019) rồi lần chạy sau poll tiếp.
 *   2. TRẦN TỐC ĐỘ: report FBA dạng daily chỉ được yêu cầu 1 lần / 4 giờ cho
 *      MỖI loại; createReport/getReportDocument chung trần 0.0167 req/s.
 *      Gặp 429/QuotaExceeded → KHÔNG retry dồn, trả về để cron ghi nhận.
 *   3. NÉN GZIP: document có `compressionAlgorithm: "GZIP"` → `content` là URL
 *      của file NÉN, phải tải rồi giải nén. Không giải nén thì parser nhận
 *      binary rác và báo "report rỗng" — rất khó đoán bệnh.
 *
 * Rate limit & schema: developer-docs.amazon.com/sp-api/docs/reports-api-v0-reference
 */
import { LwaTokenManager } from "./lwa.ts";

const USER_AGENT = "VEXIM-Worker/1.0 (Language=TypeScript; Platform=Vercel)";
const API_PATH = "/reports/2021-06-30";

/** processingStatus của Amazon (nguyên văn, KHÔNG đổi sang chữ thường). */
export type ReportProcessingStatus =
  | "IN_QUEUE"
  | "IN_PROGRESS"
  | "DONE"
  | "CANCELLED"
  | "FATAL";

export type ReportInfo = {
  reportId: string;
  reportType?: string | null;
  marketplaceIds?: string[];
  processingStatus: ReportProcessingStatus;
  /** chỉ có khi DONE — dùng để lấy document */
  documentId?: string | null;
  createdTime?: string | null;
  processingStartTime?: string | null;
  processingEndTime?: string | null;
  dataStartTime?: string | null;
  dataEndTime?: string | null;
  dataCollectionStart?: string | null;
  dataCollectionEnd?: string | null;
  /** Amazon trả kèm khi CANCELLED/FATAL (đôi khi null) */
  message?: string | null;
};

export type ReportDocumentInfo = {
  reportDocumentId: string;
  /** "GZIP" hoặc null (không nén) */
  compressionAlgorithm?: string | null;
  /** URL tải file, HOẶC nội dung trực tiếp với document nhỏ không nén */
  content?: string | null;
  contentType?: string | null;
  length?: number | null;
};

/** Lỗi SP-API có cấu trúc — giữ code + details để tầng trên phân biệt trần tốc độ và log rõ 400. */
export type SpApiError = { code: string; message: string; status: number; details?: string };

export class SpApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: string;

  constructor(err: SpApiError) {
    // FIX 3: log chi tiết Worker console — Amazon trả errors[0].details với lý do 400 InvalidInput
    // Ví dụ: "Report type GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA is deprecated, please use GET_LEDGER_SUMMARY_VIEW_DATA"
    // hoặc "Missing required reportOptions: aggregateByLocation, aggregatedByTimePeriod"
    // hoặc "Invalid reportOptions: aggregatedByTimePeriod must be DAILY for FC"
    const detailSuffix = err.details ? ` | details: ${err.details}` : "";
    super(`SP-API ${err.status} ${err.code}: ${err.message}${detailSuffix}`);
    this.name = "SpApiRequestError";
    this.status = err.status;
    this.code = err.code;
    this.details = err.details ?? err.message;
  }

  /** Trần tốc độ / hạn mức report — KHÔNG phải lỗi cấu hình, lần chạy sau thử lại. */
  get isThrottled(): boolean {
    return this.status === 429 || /quota|throttl|rate.?limit/i.test(this.code + (this.details ?? ""));
  }
}

export type ReportsClientOptions = {
  host: string;
  lwa: LwaTokenManager;
  fetchFn?: typeof fetch;
  /** số lần thử lại khi 429/5xx (mặc định 3) */
  maxRetries?: number;
  /** cho test: không chờ thật */
  sleep?: (ms: number) => Promise<void>;
};

export class ReportsClient {
  private readonly host: string;
  private readonly lwa: LwaTokenManager;
  private readonly fetchFn: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: ReportsClientOptions) {
    this.host = opts.host.replace(/\/$/, "");
    this.lwa = opts.lwa;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // --------------------------------------------------------------------------
  // 1. createReport — xin report
  // --------------------------------------------------------------------------
  async createReport(params: {
    reportType: string;
    marketplaceIds: string[];
    /** ISO 8601 UTC chuẩn — ví dụ 2023-01-15T00:00:00.000Z */
    dataStartTime?: string | null;
    dataEndTime?: string | null;
    reportOptions?: Record<string, string>;
  }): Promise<{ reportId: string }> {
    const body: Record<string, unknown> = {
      reportType: params.reportType,
      marketplaceIds: params.marketplaceIds,
    };
    // Chỉ gửi khi có giá trị: gửi rỗng khiến Amazon trả 400 InvalidInput.
    // FIX 2: dataStartTime/dataEndTime phải là ISO 8601 UTC chuẩn — dùng toISOString() (có ms)
    if (params.dataStartTime) body.dataStartTime = params.dataStartTime;
    if (params.dataEndTime) body.dataEndTime = params.dataEndTime;
    // FIX 1: reportOptions bắt buộc cho ledger reports — thiếu sẽ 400 "Missing reportOptions"
    if (params.reportOptions && Object.keys(params.reportOptions).length > 0) {
      body.reportOptions = params.reportOptions;
    }
    const json = await this.request<{ reportId?: string }>("POST", `${API_PATH}/reports`, body);
    const reportId = json?.reportId;
    if (!reportId) {
      throw new Error(
        `createReport(${params.reportType}): Amazon không trả reportId — phản hồi: ` +
          `${JSON.stringify(json).slice(0, 500)}`,
      );
    }
    return { reportId };
  }

  // --------------------------------------------------------------------------
  // 2. getReport — hỏi trạng thái
  // --------------------------------------------------------------------------
  async getReport(reportId: string): Promise<ReportInfo> {
    const json = await this.request<Record<string, unknown>>(
      "GET",
      `${API_PATH}/reports/${encodeURIComponent(reportId)}`,
    );
    return normalizeReportInfo(json);
  }

  // --------------------------------------------------------------------------
  // 3. getReportDocument — lấy chỗ tải file
  // --------------------------------------------------------------------------
  async getReportDocument(documentId: string): Promise<ReportDocumentInfo> {
    const json = await this.request<Record<string, unknown>>(
      "GET",
      `${API_PATH}/documents/${encodeURIComponent(documentId)}`,
    );
    return {
      reportDocumentId: String(json?.reportDocumentId ?? documentId),
      compressionAlgorithm: (json?.compressionAlgorithm as string | undefined) ?? null,
      content: (json?.content as string | undefined) ?? null,
      contentType: (json?.contentType as string | undefined) ?? null,
      length: typeof json?.length === "number" ? json.length : null,
    };
  }

  // --------------------------------------------------------------------------
  // 4. downloadDocument — tải + GIẢI NÉN GZIP → chuỗi TSV
  // --------------------------------------------------------------------------
  /**
   * `content` có 2 khả năng (tuỳ document):
   *   • URL (thường gặp, và LUÔN là URL khi nén GZIP) → tải về
   *   • nội dung trực tiếp (document nhỏ, không nén) → dùng luôn
   * Nén GZIP thì giải bằng node:zlib (Vercel chạy Node runtime).
   */
  async downloadDocument(doc: ReportDocumentInfo): Promise<{ text: string; gzipped: boolean; bytes: number }> {
    const content = doc.content ?? "";
    if (content === "") {
      throw new Error(
        `getReportDocument(${doc.reportDocumentId}) không trả content — không tải được report`,
      );
    }
    const isUrl = /^https?:\/\//i.test(content.trim());
    const gzipped = String(doc.compressionAlgorithm ?? "").toUpperCase() === "GZIP";

    if (!isUrl) {
      if (gzipped) {
        throw new Error(
          `Document ${doc.reportDocumentId} báo nén GZIP nhưng content không phải URL — ` +
            `không giải nén được chuỗi nội dung trực tiếp. Kiểm tra lại phản hồi getReportDocument.`,
        );
      }
      return { text: content, gzipped: false, bytes: content.length };
    }

    const res = await this.fetchFn(content.trim(), {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) {
      throw new Error(
        `Tải report document thất bại HTTP ${res.status} (URL hết hạn? gọi lại getReportDocument).`,
      );
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!gzipped) {
      return { text: new TextDecoder("utf-8").decode(buf), gzipped: false, bytes: buf.byteLength };
    }
    return { text: await gunzipText(buf), gzipped: true, bytes: buf.byteLength };
  }

  /** getReport + getReportDocument + tải file, gộp thành một bước cho job. */
  async fetchReportContent(reportId: string): Promise<{
    info: ReportInfo;
    text: string | null;
    gzipped: boolean;
    bytes: number;
    documentId: string | null;
  }> {
    const info = await this.getReport(reportId);
    if (info.processingStatus !== "DONE") {
      return { info, text: null, gzipped: false, bytes: 0, documentId: info.documentId ?? null };
    }
    if (!info.documentId) {
      throw new Error(
        `Report ${reportId} DONE nhưng Amazon không trả documentId — không tải được nội dung.`,
      );
    }
    const doc = await this.getReportDocument(info.documentId);
    const { text, gzipped, bytes } = await this.downloadDocument(doc);
    return { info, text, gzipped, bytes, documentId: info.documentId };
  }

  // --------------------------------------------------------------------------
  // HTTP lõi: token LWA + retry 429/5xx + lỗi có cấu trúc + log chi tiết 400
  // --------------------------------------------------------------------------
  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    let lastWait = 1000;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const token = await this.lwa.getAccessToken();
      const url = `${this.host}${path}`;
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method,
          headers: {
            "x-amz-access-token": token,
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            "User-Agent": USER_AGENT,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (e) {
        // Lỗi mạng (DNS/timeout) — thử lại có backoff, không ném ngay.
        lastError = e as Error;
        await this.sleep(lastWait);
        lastWait *= 2;
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after") ?? 0);
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : lastWait;
        const text = await safeText(res);
        const parsed = parseSpApiErrorJson(text);
        lastError = new SpApiRequestError({
          code: parsed.code ?? extractErrorCode(text) ?? (res.status === 429 ? "QuotaExceeded" : "ServiceUnavailable"),
          message: parsed.message ?? text.slice(0, 500),
          details: parsed.details,
          status: res.status,
        });
        // Hết lượt retry → ném để job ghi 'failed' kèm lỗi thật (không im lặng).
        if (attempt === this.maxRetries) throw lastError;
        await this.sleep(waitMs);
        lastWait = Math.min(waitMs * 2, 30_000);
        continue;
      }

      if (!res.ok) {
        const text = await safeText(res);
        const parsed = parseSpApiErrorJson(text);
        // FIX 3: đọc log Worker console chi tiết 400 — parse errors[0].details từ Amazon
        // Ví dụ: {"errors":[{"code":"InvalidInput","message":"Invalid Input","details":"Report type ... deprecated"}]}
        // Trước chỉ slice 500 ký tự, mất details → Worker console không biết lý do
        // Giờ giữ full details để log ra console CloudWatch/Vercel
        const fullBodyForLog = text.length > 2000 ? text.slice(0, 2000) + "…(truncated)" : text;
        // Nếu là 400, log thêm body gốc để debug reportType typo vs enum
        if (res.status === 400) {
          const reqBodyLog = body !== undefined ? JSON.stringify(body).slice(0, 1000) : "(no body - GET)";
          console.error(`[ReportsClient] 400 InvalidInput body=${fullBodyForLog} requestBody=${reqBodyLog}`);
        }
        throw new SpApiRequestError({
          code: parsed.code ?? extractErrorCode(text) ?? `HTTP_${res.status}`,
          message: parsed.message ?? (text.slice(0, 500) || res.statusText),
          details: parsed.details ?? text.slice(0, 1000),
          status: res.status,
        });
      }

      const json = (await res.json()) as T;
      return json;
    }

    throw lastError ?? new Error(`Reports API: vượt số lần retry (${path})`);
  }
}

// ============================================================================
// Helper
// ============================================================================

const STATUSES: readonly ReportProcessingStatus[] = [
  "IN_QUEUE", "IN_PROGRESS", "DONE", "CANCELLED", "FATAL",
];

/**
 * Amazon trả trạng thái LẠ (hoặc thiếu) → coi như IN_PROGRESS để cron poll tiếp,
 * KHÔNG coi là DONE (sẽ đi tải document không tồn tại) và không coi là FATAL
 * (sẽ bỏ cuộc oan).
 */
export function normalizeReportInfo(json: Record<string, unknown> | null | undefined): ReportInfo {
  const raw = String(json?.processingStatus ?? "").toUpperCase();
  const status = (STATUSES as readonly string[]).includes(raw)
    ? (raw as ReportProcessingStatus)
    : "IN_PROGRESS";
  return {
    reportId: String(json?.reportId ?? ""),
    reportType: (json?.reportType as string | undefined) ?? null,
    marketplaceIds: Array.isArray(json?.marketplaceIds)
      ? (json?.marketplaceIds as unknown[]).map((m) => String(m))
      : [],
    processingStatus: status,
    documentId: (json?.documentId as string | undefined) ?? null,
    createdTime: (json?.createdTime as string | undefined) ?? null,
    processingStartTime: (json?.processingStartTime as string | undefined) ?? null,
    processingEndTime: (json?.processingEndTime as string | undefined) ?? null,
    dataStartTime: (json?.dataStartTime as string | undefined) ?? null,
    dataEndTime: (json?.dataEndTime as string | undefined) ?? null,
    dataCollectionStart: (json?.dataCollectionStart as string | undefined) ?? null,
    dataCollectionEnd: (json?.dataCollectionEnd as string | undefined) ?? null,
    message: (json?.message as string | undefined) ?? null,
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function extractErrorCode(text: string): string | null {
  const m = text.match(/"code"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * FIX 3: Parse lỗi SP-API chuẩn — Amazon trả dạng:
 * {
 *   "errors": [
 *     {"code":"InvalidInput","message":"Invalid Input","details":"Report type ... is deprecated, please use ..."}
 *   ]
 * }
 * Cần lấy cả details để biết lý do 400: typo reportType vs enum, thiếu reportOptions, sai date format...
 */
function parseSpApiErrorJson(text: string): { code?: string; message?: string; details?: string } {
  try {
    const json = JSON.parse(text) as { errors?: Array<{ code?: string; message?: string; details?: string }> };
    const first = json?.errors?.[0];
    if (first) {
      return {
        code: first.code,
        message: first.message,
        details: first.details,
      };
    }
  } catch {
    // không phải JSON → fallback regex
  }
  return {};
}

/**
 * Giải nén GZIP. Import ĐỘNG (await import) để bundler phía web không kéo
 * node:zlib vào client bundle — code này chỉ chạy server-side (cron/worker).
 */
export async function gunzipText(buf: Uint8Array): Promise<string> {
  const zlib = await import("node:zlib");
  const { promisify } = await import("node:util");
  const gunzip = promisify(zlib.gunzip);
  try {
    const out = await gunzip(buf);
    return new TextDecoder("utf-8").decode(out);
  } catch (e) {
    throw new Error(
      `Giải nén GZIP thất bại (${(e as Error).message.split("\n")[0]}). ` +
        `Có thể document không nén dù Amazon báo GZIP — thử bỏ compressionAlgorithm.`,
    );
  }
}
