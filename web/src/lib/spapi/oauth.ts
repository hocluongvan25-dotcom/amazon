/**
 * Luồng authorize LWA (SP-API) — phần THUẦN, không đụng DB/network ở đâu khác.
 *
 * Vì sao tách riêng khỏi route handler: đây là thứ dễ sai nhất trong Module 0
 * và cũng là thứ KHÔNG test được nếu nằm trong route (route cần cookie +
 * service_role). Hàm thuần ⇒ test được từng dòng: host theo vùng, tham số
 * authorize, và cách đọc lỗi khi đổi code lấy token.
 *
 * BA ĐIỀU LUÔN ĐÚNG VỚI LWA:
 *   1. `redirect_uri` phải GIỐNG HỆT lúc authorize và lúc đổi token — lệch một
 *      ký tự là Amazon trả invalid_grant, mà thông báo lỗi thì rất mơ hồ.
 *   2. `state` dùng MỘT LẦN (chống CSRF) — sinh ở DB, tiêu thụ ở callback.
 *   3. Refresh token chỉ trả về MỘT LẦN duy nhất (lúc đổi code). Không lưu được
 *      nghĩa là phải authorize lại từ đầu.
 *
 * FIX MD1000 09/2026:
 *   - Lỗi MD1000 khi bấm [Kết nối] P1·US/P2·CA: App ID amzn1.sp.solution.ee3dce31... published
 *   - Nguyên nhân: thiếu ?version=beta trong authorize URL, và redirect_uri không khớp 100% Allowed Return URLs
 *   - Fix: thêm version=beta, và log/validate redirect_uri khớp
 */

export type SpApiRegion = "NA" | "EU" | "FE";

export function normalizeRegion(raw: string | null | undefined): SpApiRegion {
  const r = (raw ?? "NA").trim().toUpperCase();
  return r === "EU" || r === "FE" ? r : "NA";
}

/** Seller Central theo vùng — nơi chủ shop bấm Authorize. */
export function sellerCentralHost(region: SpApiRegion): string {
  switch (region) {
    case "EU":
      return "sellercentral-europe.amazon.com";
    case "FE":
      return "sellercentral.amazon.co.jp";
    default:
      return "sellercentral.amazon.com";
  }
}

export function buildAuthorizeUrl(opts: {
  appId: string;
  state: string;
  redirectUri: string;
  region?: SpApiRegion;
}): string {
  const host = sellerCentralHost(opts.region ?? "NA");
  // FIX 1: Thêm version=beta — Amazon yêu cầu, thiếu sẽ báo MD1000
  // Docs: https://developer-docs.amazon.com/sp-api/docs/authorizing-selling-partner-api-applications
  // URL phải là: /apps/authorize/consent?application_id=...&state=...&redirect_uri=...&version=beta
  const q = new URLSearchParams({
    application_id: opts.appId,
    state: opts.state,
    redirect_uri: opts.redirectUri,
    version: "beta",
  });
  return `https://${host}/apps/authorize/consent?${q.toString()}`;
}

/**
 * FIX 2: Đối soát redirect_uri với Allowed Return URLs
 * Amazon yêu cầu redirect_uri truyền trong authorize PHẢI khớp 100% (từng ký tự, kể cả trailing slash)
 * với URL đã khai báo trong LWA Credentials → Allowed Return URLs
 * Lỗi MD1000 thường do lệch: https://example.com/callback vs https://example.com/callback/
 */
export function validateRedirectUri(redirectUri: string, allowedUrls?: string[]): { ok: boolean; hint: string } {
  const uri = (redirectUri ?? "").trim();
  if (uri === "") {
    return { ok: false, hint: "redirect_uri rỗng — phải set AMAZON_SP_API_REDIRECT_URI" };
  }
  try {
    const u = new URL(uri);
    if (u.protocol !== "https:" && !u.hostname.includes("localhost")) {
      return { ok: false, hint: `redirect_uri phải https (đang là ${u.protocol}) — Amazon từ chối http trừ localhost` };
    }
  } catch {
    return { ok: false, hint: `redirect_uri không phải URL hợp lệ: ${uri}` };
  }

  if (allowedUrls && allowedUrls.length > 0) {
    const exactMatch = allowedUrls.some((a) => a.trim() === uri);
    if (!exactMatch) {
      return {
        ok: false,
        hint: `redirect_uri [${uri}] không khớp 100% với Allowed Return URLs đã khai báo: ${allowedUrls.join(" | ")} — lệch 1 ký tự (kể cả / cuối) là MD1000`,
      };
    }
  }

  return { ok: true, hint: "redirect_uri khớp" };
}

export type CodeExchangeResult =
  | {
      ok: true;
      refreshToken: string;
      accessToken: string | null;
      /** giây — access token, KHÔNG phải hạn của refresh token */
      expiresIn: number | null;
    }
  | { ok: false; error: string; description: string | null };

/**
 * Đổi `code` (một lần) lấy refresh token.
 * Không ném lỗi: callback phải luôn hiển thị được lý do cho người dùng.
 */
export async function exchangeCodeForRefreshToken(opts: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  fetchFn?: typeof fetch;
}): Promise<CodeExchangeResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });

  let res: Response;
  try {
    res = await fetchFn("https://api.amazon.com/auth/o2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
    });
  } catch (e) {
    return { ok: false, error: "network", description: (e as Error).message };
  }

  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }

  if (!res.ok) {
    const error = typeof json.error === "string" ? json.error : `http_${res.status}`;
    const description =
      typeof json.error_description === "string"
        ? json.error_description
        : text.slice(0, 300) || null;
    return { ok: false, error, description };
  }

  const refreshToken = typeof json.refresh_token === "string" ? json.refresh_token.trim() : "";
  if (refreshToken === "") {
    // Amazon trả 200 nhưng không có refresh token khi code đã bị dùng hoặc
    // redirect_uri không khớp — coi là lỗi, KHÔNG lưu token rỗng vào DB.
    return {
      ok: false,
      error: "missing_refresh_token",
      description: "Amazon không trả refresh_token (code đã dùng, hoặc redirect_uri không khớp).",
    };
  }

  return {
    ok: true,
    refreshToken,
    accessToken: typeof json.access_token === "string" ? json.access_token : null,
    expiresIn: typeof json.expires_in === "number" ? json.expires_in : null,
  };
}

/** Thông báo tiếng Việt cho người dùng — không phơi chi tiết kỹ thuật thô. */
export function explainLwaError(error: string, description: string | null): string {
  switch (error) {
    case "invalid_grant":
      return (
        "Amazon từ chối code (invalid_grant). Thường do: code đã dùng rồi, hết hạn sau vài phút, " +
        "hoặc redirect URI không khớp đúng từng ký tự với cấu hình app." +
        (description ? ` Amazon nói: ${description}` : "")
      );
    case "invalid_client":
      return `Sai client id/secret của app SP-API (${description ?? "invalid_client"}).`;
    case "missing_refresh_token":
      return description ?? "Amazon không trả refresh token.";
    case "access_denied":
      return "Chủ shop bấm Từ chối (hoặc huỷ) trên Seller Central — chưa cấp quyền cho app.";
    case "network":
      return `Không gọi được api.amazon.com: ${description ?? "lỗi mạng"}`;
    default:
      return `Đổi code thất bại (${error})${description ? `: ${description}` : ""}`;
  }
}
