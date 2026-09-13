/**
 * Lỗi Ads API — phân loại để cron biết NÊN LÀM GÌ TIẾP, không đoán.
 *
 * Ba nguyên tắc (đã thành quy ước của repo):
 *   1. 429 / 5xx → `retryable = true` kèm `retryAfterSec` (đọc header Retry-After),
 *      nhưng KHÔNG tự retry dồn: cron bỏ qua, lần chạy sau làm tiếp. Amazon tính trần
 *      tốc độ theo hàng đợi vùng — retry dồn làm cả hàng đợi nghẽn.
 *   2. 425 (báo cáo trùng) KHÔNG phải lỗi: nghĩa là report y hệt đang được tạo →
 *      giữ reportId cũ và poll tiếp.
 *   3. 401/403 → nói thẳng việc phải làm (đổi access token? sai vùng? profile không
 *      thuộc tài khoản?) thay vì in nguyên văn message của Amazon.
 */

export type AdsErrorCode =
  | "throttled"
  | "duplicate_report"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "invalid_column"
  | "server_error"
  | "network"
  | "bad_response";

export type AdsFailure = {
  code: AdsErrorCode;
  status: number;
  message: string;
  hint: string | null;
  retryable: boolean;
  retryAfterSec: number | null;
  /** Tên cột Amazon chê (nếu lỗi là invalid_column) → client bỏ cột đó rồi xin lại. */
  badColumns: string[];
  raw: string | null;
};

export class AdsApiError extends Error {
  readonly code: AdsErrorCode;
  readonly status: number;
  readonly hint: string | null;
  readonly retryable: boolean;
  readonly retryAfterSec: number | null;
  readonly badColumns: string[];
  readonly path: string;
  readonly profileId: string | null;
  /** Phản hồi thô (cắt 500 ký tự) — để biết Amazon/proxy đang trả gì khi lỗi lạ. */
  readonly raw: string | null;

  constructor(failure: AdsFailure, ctx: { path?: string; profileId?: string | null } = {}) {
    super(failure.message);
    this.name = "AdsApiError";
    this.code = failure.code;
    this.status = failure.status;
    this.hint = failure.hint;
    this.retryable = failure.retryable;
    this.retryAfterSec = failure.retryAfterSec;
    this.badColumns = failure.badColumns;
    this.path = ctx.path ?? "";
    this.profileId = ctx.profileId ?? null;
    this.raw = failure.raw ?? null;
  }
}

/** Lỗi về token/refresh — tách riêng vì cách xử lý khác (phải re-authorize). */
export type AdsTokenErrorCode =
  | "no_token"
  | "decrypt_failed"
  | "token_expired"
  | "token_revoked"
  | "refresh_failed"
  | "no_credential";

export class AdsTokenError extends Error {
  readonly code: AdsTokenErrorCode;
  readonly hint: string | null;
  readonly shopId: string | null;
  /** invalid_grant → chủ shop PHẢI bấm lại; 429 → chờ lần sau. */
  readonly retryable: boolean;

  constructor(
    code: AdsTokenErrorCode,
    message: string,
    opts: { hint?: string | null; shopId?: string | null; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "AdsTokenError";
    this.code = code;
    this.hint = opts.hint ?? null;
    this.shopId = opts.shopId ?? null;
    this.retryable = opts.retryable ?? false;
  }
}

function firstString(obj: unknown, keys: string[]): string | null {
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

/** Amazon có thể trả {code,message,details} hoặc {errors:[{code,message}]} hoặc text trơn. */
function extractBody(bodyText: string): { code: string | null; message: string | null } {
  const text = bodyText.trim();
  if (!text) return { code: null, message: null };
  try {
    const parsed = JSON.parse(text) as unknown;
    const rec = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | undefined;
    if (rec && typeof rec === "object") {
      const errors = Array.isArray(rec.errors) ? (rec.errors[0] as Record<string, unknown>) : null;
      return {
        code: firstString(rec, ["code", "errorCode", "error"]) ?? firstString(errors ?? {}, ["code"]),
        message:
          firstString(rec, ["message", "details", "error_description", "error"]) ??
          firstString(errors ?? {}, ["message", "details"]),
      };
    }
  } catch {
    // body không phải JSON (thường là HTML của proxy) → giữ nguyên text
  }
  return { code: null, message: text.slice(0, 300) };
}

/**
 * Đọc tên cột bị chê từ message của Amazon. Ví dụ:
 *   "Invalid columns: campaignBudgetAmount, targetingExpression"
 *   "The column 'sales30d' is not supported for reportTypeId spCampaigns"
 */
export function parseBadColumns(message: string | null): string[] {
  if (!message) return [];
  const out = new Set<string>();
  const quoted = message.match(/'([A-Za-z][A-Za-z0-9_]{2,})'/g) ?? [];
  for (const q of quoted) out.add(q.replace(/'/g, ""));
  const listMatch = message.match(/columns?\s*[:=]\s*([A-Za-z0-9_,\s]+)/i);
  if (listMatch) {
    for (const part of listMatch[1].split(/[,\s]+/)) {
      if (/^[A-Za-z][A-Za-z0-9_]{2,}$/.test(part)) out.add(part);
    }
  }
  return [...out];
}

function retryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const n = Number(headerValue);
  if (Number.isFinite(n) && n >= 0) return Math.min(Math.round(n), 3600);
  const when = Date.parse(headerValue);
  if (!Number.isNaN(when)) {
    const secs = Math.round((when - Date.now()) / 1000);
    return secs > 0 ? Math.min(secs, 3600) : 0;
  }
  return null;
}

export function describeAdsFailure(
  status: number,
  bodyText: string,
  ctx: { retryAfterHeader?: string | null; path?: string } = {},
): AdsFailure {
  const { code: bodyCode, message: bodyMessage } = extractBody(bodyText);
  const retryAfterSec = retryAfter(ctx.retryAfterHeader ?? null);
  const base = {
    status,
    retryAfterSec,
    badColumns: [] as string[],
    raw: bodyText.slice(0, 500) || null,
  };

  if (status === 429) {
    return {
      ...base,
      code: "throttled",
      message: `Amazon chặn vì trần tốc độ (429)${retryAfterSec !== null ? `, Retry-After ${retryAfterSec}s` : ""}.`,
      hint:
        "KHÔNG retry dồn: bỏ qua lượt này, cron lần sau chạy tiếp. Nếu 429 lặp lại nhiều ngày " +
        "thì giảm AMAZON_ADS_REPORT_DAYS hoặc giãn lịch cron.",
      retryable: true,
    };
  }
  if (status === 425) {
    return {
      ...base,
      code: "duplicate_report",
      message: "Amazon báo đã có yêu cầu report y hệt đang chạy (425).",
      hint: "Giữ reportId cũ và poll tiếp — KHÔNG xin report mới.",
      retryable: false,
    };
  }
  if (status === 401) {
    return {
      ...base,
      code: "unauthorized",
      message: bodyMessage ?? "Access token bị từ chối (401).",
      hint:
        "Thường do access token hết hạn (1 giờ) hoặc refresh token đã chết. " +
        "Kiểm tra /module0/connect: nếu trạng thái là 'QUÁ HẠN' thì chủ shop phải Re-authorize.",
      retryable: false,
    };
  }
  if (status === 403) {
    return {
      ...base,
      code: "forbidden",
      message: bodyMessage ?? "Không có quyền trên profile/tài khoản này (403).",
      hint:
        "profileId không thuộc tài khoản của token, hoặc SAI VÙNG (profile EU mà gọi host NA). " +
        "Đối chiếu AMAZON_ADS_REGION với countryCode của profile trong GET /v2/profiles.",
      retryable: false,
    };
  }
  if (status === 404) {
    return {
      ...base,
      code: "not_found",
      message: bodyMessage ?? "Không tìm thấy resource (404).",
      hint: "reportId/profileId sai hoặc report đã EXPIRED (quá hạn tải) → xin report mới.",
      retryable: false,
    };
  }
  if (status === 400 || status === 422) {
    const msg = bodyMessage ?? "Yêu cầu không hợp lệ (400).";
    const badColumns = parseBadColumns(msg);
    const isColumn = badColumns.length > 0 || /column/i.test(msg);
    return {
      ...base,
      code: isColumn ? "invalid_column" : "invalid_request",
      message: msg,
      badColumns,
      hint: isColumn
        ? "Bỏ cột Amazon chê rồi xin lại (client tự làm); nếu rơi xuống bộ cột tối thiểu mà vẫn lỗi " +
          "thì kiểm tra reportTypeId/groupBy có được phép cho adProduct này không."
        : "Kiểm tra body: startDate/endDate (YYYY-MM-DD, tối đa 31 ngày), groupBy, reportTypeId, timeUnit.",
      retryable: false,
    };
  }
  if (status >= 500) {
    return {
      ...base,
      code: "server_error",
      message: bodyMessage ?? `Amazon lỗi phía server (${status}).`,
      hint: "Chờ lần cron sau — không phải lỗi cấu hình của mình.",
      retryable: true,
    };
  }
  return {
    ...base,
    code: "bad_response",
    message: bodyMessage ?? `Phản hồi không mong đợi (HTTP ${status})${bodyCode ? ` · ${bodyCode}` : ""}.`,
    hint: null,
    retryable: false,
  };
}
