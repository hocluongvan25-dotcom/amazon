/**
 * Login with Amazon (LWA) — phần OAuth THẬT của Module 0.
 *
 * Hai "mặt hàng" dùng CHUNG giao thức LWA nhưng KHÁC app credential:
 *   • spapi : app SP-API (Seller Central → Developer Central). Link authorize là
 *             trang CONSENT của Seller Central, callback trả `spapi_oauth_code`.
 *   • ads   : Security profile trong Advertising Console (client_id/secret riêng,
 *             scope `ads::campaign_management`). Link authorize là LWA /ap/oa,
 *             callback trả `code`.
 * Callback vì thế phải nhận CẢ HAI tên tham số — sai một cái là mất token của
 * chủ shop (và phải nhờ họ authorize lại từ đầu).
 *
 * Endpoint THEO VÙNG (app EU/FE không đổi được về NA):
 *   NA → www.amazon.com / api.amazon.com / sellercentral.amazon.com
 *   EU → eu.account.amazon.com / api.amazon.co.uk / eu.sellercentral.amazon.com
 *   FE → apac.account.amazon.com / api.amazon.co.jp / sellercentral.amazon.co.jp
 *
 * Access token sống ~3600 giây; refresh token sống 365 NGÀY rồi phải
 * re-authorize (xem vexim_oauth_reauth_scan của migration 0020).
 */
import type { OAuthService } from "./state.ts";

export type AmazonRegion = "NA" | "EU" | "FE";

export const AMAZON_REGIONS: AmazonRegion[] = ["NA", "EU", "FE"];

export function asAmazonRegion(value: string | null | undefined, fallback: AmazonRegion = "NA"): AmazonRegion {
  const raw = (value ?? "").trim().toUpperCase();
  if (raw === "EU" || raw === "GB" || raw === "UK" || raw === "DE") return "EU";
  if (raw === "FE" || raw === "JP" || raw === "AU" || raw === "APAC") return "FE";
  if (raw === "NA" || raw === "US" || raw === "CA" || raw === "MX") return "NA";
  return fallback;
}

const AUTHORIZE_HOSTS: Record<AmazonRegion, string> = {
  NA: "https://www.amazon.com/ap/oa",
  EU: "https://eu.account.amazon.com/ap/oa",
  FE: "https://apac.account.amazon.com/ap/oa",
};

const TOKEN_HOSTS: Record<AmazonRegion, string> = {
  NA: "https://api.amazon.com/auth/o2/token",
  EU: "https://api.amazon.co.uk/auth/o2/token",
  FE: "https://api.amazon.co.jp/auth/o2/token",
};

const CONSENT_HOSTS: Record<AmazonRegion, string> = {
  NA: "https://sellercentral.amazon.com/apps/authorize/consent",
  EU: "https://eu.sellercentral.amazon.com/apps/authorize/consent",
  FE: "https://sellercentral.amazon.co.jp/apps/authorize/consent",
};

/** Scope Ads API. `cpc_advertising` là tên cũ — Amazon vẫn chấp nhận cả hai. */
export const ADS_SCOPE = "ads::campaign_management";
export const SPAPI_SCOPE = "sellingpartnerapi::all";

export function authorizeEndpoint(region: AmazonRegion): string {
  return AUTHORIZE_HOSTS[region];
}

export function tokenEndpoint(region: AmazonRegion, override?: string | null): string {
  const custom = (override ?? "").trim();
  return custom || TOKEN_HOSTS[region];
}

export function consentEndpoint(region: AmazonRegion): string {
  return CONSENT_HOSTS[region];
}

export type AuthorizeLinkInput = {
  service: OAuthService;
  region: AmazonRegion;
  clientId: string;
  redirectUri: string;
  state: string;
  /** AMAZON_SP_API_APPLICATION_ID (amzn1.sp.solution.…) — bắt buộc cho luồng consent SP-API. */
  applicationId?: string | null;
  scope?: string;
};

/**
 * Sinh link cho chủ shop bấm.
 * SP-API có application_id → dùng trang consent của Seller Central (đúng luồng
 * Amazon duyệt app); không có → rơi về LWA /ap/oa với scope sellingpartnerapi::all.
 */
export function buildAuthorizeUrl(input: AuthorizeLinkInput): { url: string; flow: "seller_central_consent" | "lwa" } {
  const scope = input.scope?.trim() || (input.service === "ads" ? ADS_SCOPE : SPAPI_SCOPE);
  if (input.service === "spapi" && input.applicationId?.trim()) {
    const url = new URL(consentEndpoint(input.region));
    url.searchParams.set("application_id", input.applicationId.trim());
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("state", input.state);
    url.searchParams.set("version", "beta");
    return { url: url.toString(), flow: "seller_central_consent" };
  }
  const url = new URL(authorizeEndpoint(input.region));
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("scope", scope);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  return { url: url.toString(), flow: "lwa" };
}

/** Callback của Amazon: SP-API dùng `spapi_oauth_code`, LWA/Ads dùng `code`. */
export function pickAuthorizationCode(params: URLSearchParams): string | null {
  const candidates = [
    params.get("spapi_oauth_code"),
    params.get("code"),
    params.get("spapi_oauth_code ".trim()),
  ];
  for (const c of candidates) {
    const v = (c ?? "").trim();
    if (v) return v;
  }
  return null;
}

export type LwaTokenResponse = {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
};

export type TokenRequestInput = {
  region: AmazonRegion;
  clientId: string;
  clientSecret: string;
  tokenUrl?: string | null;
  fetchFn?: typeof fetch;
};

export type LwaError = {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
};

/**
 * Dịch lỗi LWA ra tiếng Việt có HÀNH ĐỘNG kèm theo.
 * Trả null nếu response không phải lỗi.
 */
export function describeLwaFailure(status: number, bodyText: string): LwaError {
  let code = "";
  let description = "";
  try {
    const json = JSON.parse(bodyText) as { error?: string; error_description?: string };
    code = json.error ?? "";
    description = json.error_description ?? "";
  } catch {
    description = bodyText.slice(0, 300);
  }
  const base = { status, code: code || `http_${status}`, retryable: false };

  if (code === "invalid_grant") {
    return {
      ...base,
      message:
        "Amazon từ chối code/refresh token (invalid_grant). Với code: hết hạn 5 phút hoặc đã dùng lại. " +
        "Với refresh token: chủ shop đã thu hồi hoặc quá 365 ngày → cần bấm Re-authorize ở /module0/connect.",
    };
  }
  if (code === "invalid_client" || status === 401) {
    return {
      ...base,
      message:
        "Sai client_id/client_secret (invalid_client). SP-API và Ads API dùng HAI bộ credential KHÁC nhau — " +
        "kiểm tra AMAZON_LWA_* cho SP-API và AMAZON_ADS_* cho Ads.",
    };
  }
  if (code === "unauthorized_client" || code === "access_denied" || status === 403) {
    return {
      ...base,
      message:
        "Amazon không cho phép lượt gọi này. Thường gặp: redirect_uri chưa khai trong app (phải khớp TUYỆT ĐỐI, " +
        "kể cả http/https và dấu /), hoặc app chưa được duyệt production, hoặc scope Ads chưa bật.",
    };
  }
  if (code === "invalid_scope") {
    return {
      ...base,
      message: `Scope không hợp lệ (${ADS_SCOPE} cho Ads, ${SPAPI_SCOPE} cho SP-API).`,
    };
  }
  if (status === 429 || code === "slow_down") {
    return {
      ...base,
      code: code || "slow_down",
      retryable: true,
      message:
        "LWA báo quá tải (429/slow_down). KHÔNG retry dồn: chờ lần cron sau. " +
        "Trần tốc độ token endpoint tính theo app, không theo shop.",
    };
  }
  if (status >= 500) {
    return {
      ...base,
      code: code || `http_${status}`,
      retryable: true,
      message: `LWA lỗi phía Amazon (HTTP ${status}). ${description}`.trim(),
    };
  }
  return { ...base, code: code || `http_${status}`, message: `LWA từ chối (${status}): ${description || code || "không rõ"}` };
}

async function postForm(
  url: string,
  body: URLSearchParams,
  fetchFn: typeof fetch,
): Promise<{ status: number; text: string }> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "VEXIM-Ops/1.0 (Language=Next.js; Platform=Vercel)",
    },
    body,
    cache: "no-store",
  });
  return { status: res.status, text: await res.text() };
}

/** Đổi authorization code lấy access_token + refresh_token. */
export async function exchangeAuthorizationCode(
  input: TokenRequestInput & { code: string; redirectUri: string },
): Promise<LwaTokenResponse> {
  const url = tokenEndpoint(input.region, input.tokenUrl);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  });
  const { status, text } = await postForm(url, body, input.fetchFn ?? fetch);
  if (status !== 200) {
    const failure = describeLwaFailure(status, text);
    throw Object.assign(new Error(failure.message), { lwa: failure });
  }
  const json = JSON.parse(text) as LwaTokenResponse;
  if (!json.access_token) throw new Error(`LWA trả 200 nhưng thiếu access_token: ${text.slice(0, 200)}`);
  return json;
}

/** Đổi refresh token lấy access token mới (sống ~1 giờ). KHÔNG làm mới refresh token. */
export async function refreshAccessToken(
  input: TokenRequestInput & { refreshToken: string },
): Promise<LwaTokenResponse> {
  const url = tokenEndpoint(input.region, input.tokenUrl);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  });
  const { status, text } = await postForm(url, body, input.fetchFn ?? fetch);
  if (status !== 200) {
    const failure = describeLwaFailure(status, text);
    throw Object.assign(new Error(failure.message), { lwa: failure });
  }
  return JSON.parse(text) as LwaTokenResponse;
}
