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
  const q = new URLSearchParams({
    application_id: opts.appId,
    state: opts.state,
    redirect_uri: opts.redirectUri,
  });
  return `https://${host}/apps/authorize/consent?${q.toString()}`;
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
