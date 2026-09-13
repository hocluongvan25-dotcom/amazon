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
 * FIX MD1000/MD9100 09/2026:
 *   - MD1000: thiếu ?version=beta trong authorize URL, redirect_uri không khớp Allowed Return URLs
 *   - MD9100: This app can't connect right now — sau khi fix MD1000, nhảy sang Amazon nhưng báo MD9100
 *     Nguyên nhân chính: redirect_uri lệch 100% (kể cả / cuối, http vs https) hoặc App Draft thiếu Test Accounts / sai Region NA
 *   - Fix: thêm version=beta, validateRedirectUri 100% match, log chi tiết, thêm diag endpoint
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
  // FIX MD1000: Amazon yêu cầu version=beta trong consent screen, thiếu sẽ báo MD1000
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
 * FIX MD1000/MD9100: Đối soát redirect_uri với Allowed Return URLs
 * Amazon yêu cầu redirect_uri truyền trong authorize PHẢI khớp 100% (từng ký tự, kể cả trailing slash, http vs https)
 * với URL đã khai báo trong LWA Credentials → Allowed Return URLs
 * Lỗi MD1000/MD9100 thường do:
 *   - https://example.com/callback vs https://example.com/callback/ (lệch / cuối)
 *   - http vs https
 *   - có port :3000 ở local nhưng production không
 *   - URL encode khác nhau
 */
export type RedirectUriValidation = {
  ok: boolean;
  hint: string;
  details: {
    redirectUri: string;
    hasTrailingSlash: boolean;
    protocol: string | null;
    host: string | null;
    path: string | null;
    allowedUrls: string[];
    exactMatch: boolean;
    closeMatches: string[]; // những URL gần giống nhưng lệch 1 ký tự
  };
};

export function validateRedirectUri(redirectUri: string, allowedUrls?: string[]): RedirectUriValidation {
  const uri = (redirectUri ?? "").trim();
  const allowed = (allowedUrls ?? []).map((s) => s.trim()).filter((s) => s.length > 0);

  const baseDetails = {
    redirectUri: uri,
    hasTrailingSlash: uri.endsWith("/"),
    protocol: null as string | null,
    host: null as string | null,
    path: null as string | null,
    allowedUrls: allowed,
    exactMatch: false,
    closeMatches: [] as string[],
  };

  if (uri === "") {
    return {
      ok: false,
      hint: "redirect_uri rỗng — phải set AMAZON_SP_API_REDIRECT_URI trên Vercel",
      details: baseDetails,
    };
  }

  try {
    const u = new URL(uri);
    baseDetails.protocol = u.protocol;
    baseDetails.host = u.host;
    baseDetails.path = u.pathname;
    if (u.protocol !== "https:" && !u.hostname.includes("localhost") && !u.hostname.includes("127.0.0.1")) {
      return {
        ok: false,
        hint: `redirect_uri phải https (đang là ${u.protocol}) — Amazon từ chối http trừ localhost. Đổi env sang https.`,
        details: baseDetails,
      };
    }
  } catch {
    return {
      ok: false,
      hint: `redirect_uri không phải URL hợp lệ: ${uri} — kiểm tra lại env`,
      details: baseDetails,
    };
  }

  // Tìm exact match
  const exactMatch = allowed.some((a) => a === uri);
  baseDetails.exactMatch = exactMatch;

  // Tìm close matches (gần giống nhưng lệch / cuối hoặc case)
  const closeMatches = allowed.filter((a) => {
    if (a === uri) return false;
    // lệch trailing slash
    if (a.replace(/\/$/, "") === uri.replace(/\/$/, "")) return true;
    // lệch case
    if (a.toLowerCase() === uri.toLowerCase()) return true;
    // lệch http vs https
    if (a.replace(/^https:/, "http:") === uri || a.replace(/^http:/, "https:") === uri) return true;
    return false;
  });
  baseDetails.closeMatches = closeMatches;

  if (allowed.length > 0) {
    if (!exactMatch) {
      const closeHint =
        closeMatches.length > 0
          ? ` Gần giống nhưng lệch: ${closeMatches.join(" | ")} — kiểm tra dấu / cuối, https vs http, chữ hoa/thường.`
          : "";
      return {
        ok: false,
        hint: `MD1000/MD9100: redirect_uri [${uri}] không khớp 100% với Allowed Return URLs [${allowed.join(" | ")}]. Amazon yêu cầu khớp TỪNG KÝ TỰ.${closeHint} Vào Apps & Services → LWA Credentials → Allowed Return URLs để đối soát.`,
        details: baseDetails,
      };
    }
  } else {
    // Không có allowed list từ env, chỉ cảnh báo chung
    if (uri.endsWith("/") && uri !== "https://localhost/" && !uri.includes("localhost")) {
      return {
        ok: true,
        hint: `redirect_uri có dấu / cuối [${uri}] — đảm bảo trong Console cũng có / cuối. Nếu Console không có /, sẽ MD9100. Khuyến nghị bỏ / cuối cho an toàn.`,
        details: baseDetails,
      };
    }
  }

  return { ok: true, hint: "redirect_uri khớp 100% (hoặc không có allowed list để đối soát, cần check Console)", details: baseDetails };
}

/**
 * Giải thích lỗi MD1000/MD9100 cho người vận hành
 */
export function explainMdError(code: string): string {
  switch (code) {
    case "MD1000":
      return (
        "MD1000: App ID sai, chưa publish, hoặc thiếu version=beta, hoặc redirect_uri không khớp Allowed Return URLs. " +
        "Check: 1) App ID amzn1.sp.solution... đúng chưa, 2) URL có version=beta chưa, 3) redirect_uri khớp 100% từng ký tự với Console (kể cả / cuối, https)."
      );
    case "MD9100":
      return (
        "MD9100: This app can't connect right now — thường do redirect_uri lệch 100% (khả năng cao nhất) hoặc App ở Draft mà Seller không nằm trong Test Accounts, hoặc sai Region NA/EU/FE. " +
        "Check: 1) Apps & Services → LWA Credentials → Allowed Return URLs vs env AMAZON_SP_API_REDIRECT_URI (so sánh từng ký tự), " +
        "2) App Status Draft hay Published, nếu Draft thì Seller email phải trong Test Accounts, " +
        "3) Region phải NA cho US/CA, " +
        "4) Log [OAuth Start] để xem URI thực tế."
      );
    default:
      return `Lỗi ${code}: kiểm tra redirect_uri và App Status trong Developer Console`;
  }
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
