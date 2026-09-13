/**
 * Tính origin thật của site để dùng cho `redirect_to` khi mời người dùng.
 *
 * VÌ SAO CẦN:
 *   - `/api/admin/invite-user` gọi GoTrue `POST /auth/v1/invite` mà không truyền
 *     `redirect_to` ⇒ Supabase dùng “Site URL” của project (mặc định localhost:3000).
 *   - Production không tự biết mình là ai nếu không nói → email mời toàn localhost.
 *   - Thứ tự ưu tiên: NEXT_PUBLIC_SITE_URL → VERCEL_PROJECT_PRODUCTION_URL → VERCEL_URL → origin của request → fallback localhost.
 *
 * Dùng ở:
 *   - Route `/api/admin/invite-user` (server): truyền `redirect_to: <origin>/invite`
 *   - Client: hiển thị “Link trong email sẽ mở trang đặt mật khẩu tại …”
 *   - Middleware + auth pages: chặn open-redirect.
 */

export type SiteSource = "env" | "vercel" | "request" | "fallback";

export type SiteOriginResult = {
  origin: string;
  source: SiteSource;
  isLocalhost: boolean;
  warning: string | null;
  inviteUrl: string;
};

/**
 * Kiểm tra origin có phải localhost không.
 */
export function isLocalhostOrigin(origin: string): boolean {
  if (!origin) return false;
  const lower = origin.toLowerCase();
  return (
    lower.includes("localhost") ||
    lower.includes("127.0.0.1") ||
    lower.includes("::1") ||
    lower.includes("0.0.0.0")
  );
}

/**
 * Chuẩn hoá origin: trim + bỏ trailing slash.
 */
export function normalizeOrigin(origin: string): string {
  if (!origin) return "";
  let o = origin.trim();
  // Bỏ trailing slash
  o = o.replace(/\/+$/, "");
  return o;
}

/**
 * Chuẩn hoá domain của Vercel (không có protocol) thành origin https.
 */
function vercelDomainToOrigin(domain: string): string {
  let d = domain.trim().replace(/\/+$/, "");
  // Nếu đã có protocol thì giữ, nếu không thì thêm https://
  if (!/^https?:\/\//i.test(d)) {
    d = `https://${d}`;
  }
  return normalizeOrigin(d);
}

type ResolveOpts = {
  env?: Record<string, string | undefined>;
  request?: Request;
  headers?: Headers | Record<string, string | undefined>;
};

function getHeader(
  headers: Headers | Record<string, string | undefined> | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  // Record case-insensitive lookup
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return (v as string) ?? null;
  }
  return null;
}

/**
 * Tính origin từ env + request. Pure, dễ test.
 */
export function resolveSiteOrigin(opts: ResolveOpts = {}): SiteOriginResult {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const req = opts.request;
  const headersFromReq = req?.headers as unknown as Headers | undefined;
  const headers = opts.headers ?? headersFromReq;

  let origin = "";
  let source: SiteSource = "fallback";

  const siteUrl = env.NEXT_PUBLIC_SITE_URL?.trim();
  if (siteUrl) {
    origin = normalizeOrigin(siteUrl);
    source = "env";
  } else if (env.VERCEL_PROJECT_PRODUCTION_URL?.trim()) {
    origin = vercelDomainToOrigin(env.VERCEL_PROJECT_PRODUCTION_URL);
    source = "vercel";
  } else if (env.VERCEL_URL?.trim()) {
    origin = vercelDomainToOrigin(env.VERCEL_URL);
    source = "vercel";
  } else if (headers) {
    // Ưu tiên header Origin nếu hợp lệ
    const originHeader = getHeader(headers, "origin");
    if (originHeader && /^https?:\/\//i.test(originHeader.trim())) {
      origin = normalizeOrigin(originHeader.trim());
      source = "request";
    } else {
      // Dựng từ x-forwarded-proto + x-forwarded-host / host
      const protoHeader = getHeader(headers, "x-forwarded-proto");
      const hostHeader =
        getHeader(headers, "x-forwarded-host") ?? getHeader(headers, "host");
      if (hostHeader) {
        const proto = protoHeader?.split(",")[0]?.trim() || "https";
        // Nếu host đã chứa protocol thì dùng luôn
        if (/^https?:\/\//i.test(hostHeader.trim())) {
          origin = normalizeOrigin(hostHeader.trim());
        } else {
          origin = normalizeOrigin(`${proto}://${hostHeader.trim()}`);
        }
        source = "request";
      }
    }
  }

  if (!origin) {
    origin = "http://localhost:3000";
    source = "fallback";
  }

  const isLocalhost = isLocalhostOrigin(origin);
  let warning: string | null = null;

  const isProd =
    env.NODE_ENV === "production" ||
    env.VERCEL_ENV === "production" ||
    !!env.VERCEL_PROJECT_PRODUCTION_URL;

  if (isLocalhost && isProd) {
    warning =
      "Đang ở production nhưng origin vẫn là localhost — kiểm tra NEXT_PUBLIC_SITE_URL trong Vercel (Site URL của Supabase vẫn là http://localhost:3000).";
  }

  const inviteUrl = `${origin.replace(/\/+$/, "")}/invite`;

  return { origin, source, isLocalhost, warning, inviteUrl };
}

/**
 * Wrapper tiện cho Route Handler: đọc process.env + request.
 */
export function getSiteOrigin(req?: Request): SiteOriginResult {
  return resolveSiteOrigin({ request: req });
}

/**
 * Tạo URL mời đầy đủ.
 */
export function getInviteUrl(origin: string): string {
  return `${normalizeOrigin(origin)}/invite`;
}

/**
 * Chặn open-redirect: chỉ cho phép path nội bộ bắt đầu bằng / và không phải //, không chứa :// hoặc \.
 * Trả về path an toàn, mặc định /dashboard.
 */
export function getSafeRedirectPath(
  next: string | null | undefined,
  fallback: string = "/dashboard",
): string {
  if (!next) return fallback;
  const trimmed = next.trim();
  if (!trimmed) return fallback;
  if (trimmed.length > 500) return fallback;
  if (!trimmed.startsWith("/")) return fallback;
  if (trimmed.startsWith("//")) return fallback;
  if (trimmed.includes("://")) return fallback;
  if (trimmed.includes("\\")) return fallback;
  // Cho phép /invite, /auth/confirm, /dashboard, ... nhưng không cho /auth/confirm?token_hash=... loop? vẫn cho.
  // Nếu chứa ký tự điều khiển thì chặn
  if (/[\s<>]/.test(trimmed) && !trimmed.includes("?") && !trimmed.includes("=")) {
    // Cho phép query string có space encode? đơn giản: nếu có space thì chặn
    // Nhưng URLSearchParams có thể có space encode, ta chỉ chặn < >.
    if (/[<>]/.test(trimmed)) return fallback;
  }
  return trimmed;
}

/**
 * Parse hash fragment của Supabase invite: #access_token=...&refresh_token=...&type=invite
 * hoặc #error=...&error_description=...
 */
export type ParsedInviteHash = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: string;
  token_type?: string;
  type?: string;
  error?: string;
  error_code?: string;
  error_description?: string;
  [key: string]: string | undefined;
};

export function parseInviteHash(hash: string): ParsedInviteHash {
  if (!hash) return {};
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return {};
  const params = new URLSearchParams(raw);
  const result: ParsedInviteHash = {};
  for (const [k, v] of params.entries()) {
    result[k] = v;
  }
  return result;
}

/**
 * Dịch lỗi invite sang tiếng Việt + hướng xử lý.
 */
export function translateInviteError(
  error: string,
  description?: string,
): string {
  const e = (error || "").toLowerCase();
  const d = (description || "").toLowerCase();

  // Hết hạn
  if (
    e.includes("expired") ||
    e.includes("otp_expired") ||
    d.includes("expired") ||
    d.includes("otp_expired") ||
    d.includes("token has expired")
  ) {
    return "Link mời đã hết hạn (thường có hiệu lực 24h). Vui lòng liên hệ quản trị viên để gửi lại lời mời.";
  }

  if (e.includes("access_denied") || e.includes("invalid_grant") || e.includes("invalid")) {
    return "Link mời không hợp lệ hoặc đã được sử dụng. Nhờ quản trị viên mời lại và kiểm tra email đúng.";
  }

  if (e.includes("not_found") || d.includes("not found")) {
    return "Không tìm thấy lời mời. Link có thể đã bị thu hồi hoặc email không khớp. Liên hệ quản trị viên.";
  }

  if (description) {
    // Nếu có mô tả gốc, trả kèm bản dịch chung
    return `Link không hợp lệ: ${description}. Vui lòng liên hệ quản trị viên để gửi lại lời mời.`;
  }

  if (error) {
    return `Link mời không hợp lệ (${error}). Vui lòng liên hệ quản trị viên để gửi lại lời mời.`;
  }

  return "Link mời không hợp lệ hoặc đã hết hạn. Vui lòng liên hệ quản trị viên để gửi lại lời mời.";
}

/**
 * Dịch lỗi verifyOtp (token_hash flow) sang tiếng Việt.
 */
export function translateConfirmError(
  message: string,
  type?: string,
): string {
  const m = (message || "").toLowerCase();
  if (m.includes("expired") || m.includes("otp_expired")) {
    return "Link xác thực đã hết hạn. Nhờ quản trị viên gửi lại email mời hoặc đặt lại mật khẩu.";
  }
  if (m.includes("invalid") || m.includes("not found") || m.includes("token")) {
    return "Link xác thực không hợp lệ hoặc đã được sử dụng. Vui lòng yêu cầu gửi lại.";
  }
  if (type === "invite") {
    return `Xác thực lời mời thất bại: ${message}. Liên hệ quản trị viên.`;
  }
  return `Xác thực thất bại: ${message}. Vui lòng thử lại hoặc liên hệ quản trị viên.`;
}
