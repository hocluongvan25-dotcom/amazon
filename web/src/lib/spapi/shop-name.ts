/**
 * TÊN SHOP AMAZON (storeName) — lấy trực tiếp từ Sellers API v1.
 *
 * ============================================================================
 * VÌ SAO CÓ FILE NÀY (sự cố 16/09/2026: "đã kết nối shop nhưng không hiển thị
 * tên shop Amazon đã kéo về")
 * ============================================================================
 * Amazon KHÔNG có endpoint "whoami" cho seller, nhưng TÊN SHOP thì CÓ sẵn trong
 * mô hình chính thức (repo amzn/selling-partner-api-models,
 * models/sellers-api-model/sellers.json):
 *
 *   GET /sellers/v1/marketplaceParticipations  →  200 OK
 *   {
 *     "payload": [
 *       {
 *         "marketplace": { "id": "ATVPDKIKX0DER", "name": "Amazon.com",
 *                          "countryCode": "US", "defaultCurrencyCode": "USD",
 *                          "defaultLanguageCode": "en_US",
 *                          "domainName": "www.amazon.com" },
 *         "participation": { "isParticipating": true,
 *                            "hasSuspendedListings": false },
 *         "storeName": "BestSellerStore"        ← TÊN SHOP TRÊN AMAZON
 *       }
 *     ]
 *   }
 *
 *   • `storeName` được Amazon khai là **required** trong definition
 *     MarketplaceParticipation và chỉ rõ: "The name of the seller's store as
 *     displayed in the marketplace".
 *   • Có từ changelog SP-API 18/12/2024 ("New: Introducing SP-API support for
 *     third-party providers") — app/token cũ có thể chưa thấy field này.
 *   • `storeName` là THEO TỪNG MARKETPLACE: US và CA có thể khác tên.
 *
 * ⇒ Không cần role đặc biệt, không cần report, không tốn phí. Chỉ cần đọc đúng
 *   field. Lỗi trước đây nằm ở client (bỏ qua storeName), không phải ở Amazon.
 *
 * Module này THUẦN + injectable `fetchFn` ⇒ test được không cần network, và dùng
 * được cả trong route OAuth callback, server action lẫn script chẩn đoán.
 */

import { parseMarketplaces, type MarketplaceInfo } from "./whoami.ts";

/** Marketplace có tên shop đọc được từ API. */
export type StoreNameRow = {
  marketplaceId: string;
  countryCode: string;
  storeName: string;
  isSuspended: boolean;
};

export type StoreNameFetchOk = {
  ok: true;
  storeNames: StoreNameRow[];
  /** Cả danh sách participation (giữ nguyên để tra thêm marketplace/domain) */
  marketplaces: MarketplaceInfo[];
  /** true khi Amazon trả participation nhưng KHÔNG có storeName nào */
  missingStoreName: boolean;
  accessTokenExpiresAt: string | null;
};

export type StoreNameFetchFail = {
  ok: false;
  /** Câu tiếng Việt hiển thị thẳng cho người vận hành */
  error: string;
  /** Việc cần làm tiếp — hiện trong UI/log */
  hint: string | null;
  status: number | null;
  /** Lỗi Amazon trả trong body (`errors[]`) nếu có */
  apiErrors: string[];
  /** true = refresh token hỏng/thu hồi ⇒ phải authorize lại (không phải lỗi tạm) */
  needsReauth: boolean;
};

export type StoreNameFetchResult = StoreNameFetchOk | StoreNameFetchFail;

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
export const MARKETPLACE_PARTICIPATIONS_PATH = "/sellers/v1/marketplaceParticipations";

/** Host SP-API theo vùng — US/CA nằm ở NA. */
export function spapiHostForRegion(raw: string | null | undefined): string {
  const r = (raw ?? "NA").trim().toUpperCase();
  if (r === "EU") return "sellingpartnerapi-eu.amazon.com";
  if (r === "FE") return "sellingpartnerapi-fe.amazon.com";
  return "sellingpartnerapi-na.amazon.com";
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function clip(raw: string, max = 300): string {
  const s = (raw ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Lỗi trong body SP-API: { errors: [{ code, message, details }] } */
export function extractApiErrors(data: unknown): string[] {
  const root = asRecord(data);
  const errors = root?.errors;
  if (!Array.isArray(errors)) return [];
  return errors
    .map((e) => {
      const row = asRecord(e);
      if (!row) return typeof e === "string" ? e : "";
      const code = typeof row.code === "string" ? row.code : "";
      const message = typeof row.message === "string" ? row.message : "";
      const details = typeof row.details === "string" ? row.details : "";
      return [code, message, details].filter((s) => s.length > 0).join(" — ");
    })
    .filter((s) => s.length > 0);
}

/** Participation → danh sách tên shop (chỉ giữ marketplace CÓ storeName). */
export function extractStoreNames(data: unknown): StoreNameRow[] {
  return parseMarketplaces(data)
    .filter((m): m is MarketplaceInfo & { storeName: string } => m.storeName !== null)
    .map((m) => ({
      marketplaceId: m.id,
      countryCode: m.countryCode,
      storeName: m.storeName,
      isSuspended: m.isSuspended,
    }));
}

/** Tên shop của một marketplace cụ thể (null = Amazon không trả). */
export function storeNameOf(data: unknown, marketplaceId: string): string | null {
  const entries = extractStoreNames(data);
  const id = (marketplaceId ?? "").trim();
  if (!id) return null;
  return entries.find((e) => e.marketplaceId === id)?.storeName ?? null;
}

/**
 * Giải thích lỗi LWA/SP-API bằng câu có thể hành động được.
 * Tách riêng để test: đây là chỗ người vận hành đọc khi shop "kết nối mà không
 * hiện tên" — thông báo phải nói rõ ĐANG THIẾU GÌ.
 */
export function explainStoreNameFailure(opts: {
  stage: "lwa" | "spapi" | "parse";
  status?: number | null;
  body?: string;
  apiErrors?: string[];
}): { error: string; hint: string | null; needsReauth: boolean } {
  const { stage, status = null, body = "", apiErrors = [] } = opts;
  const detail = clip(body);
  const apiMsg = apiErrors.length > 0 ? apiErrors.join(" | ") : "";

  if (stage === "lwa") {
    if (detail.includes("invalid_grant")) {
      return {
        error: "Refresh token của shop không còn hiệu lực (Amazon trả invalid_grant).",
        hint:
          "Token đã bị thu hồi/hết hạn (hoặc shop đổi mật khẩu Seller Central). " +
          "Vào Module 0 → Kết nối shop, bấm [Kết nối lại] để authorize lại.",
        needsReauth: true,
      };
    }
    if (detail.includes("invalid_client")) {
      return {
        error: "Sai AMAZON_LWA_CLIENT_ID / AMAZON_LWA_CLIENT_SECRET.",
        hint: "Đối chiếu LWA Credentials trong Amazon Developer Console với env trên Vercel.",
        needsReauth: false,
      };
    }
    return {
      error: `Không lấy được access token từ LWA (HTTP ${status ?? "?"}).`,
      hint: "Kiểm tra client id/secret + refresh token của shop.",
      needsReauth: false,
    };
  }

  if (stage === "spapi") {
    if (status === 403) {
      return {
        error: "SP-API từ chối 403 khi đọc marketplaceParticipations.",
        hint:
          "Thường do refresh token còn hiệu lực nhưng app CHƯA được cấp quyền (shop chưa " +
          "authorize app này, hoặc app ở Draft mà seller không nằm trong Test Accounts).",
        needsReauth: false,
      };
    }
    if (status === 401) {
      return {
        error: "SP-API trả 401 — access token không hợp lệ với vùng đang gọi.",
        hint:
          "Kiểm tra AMAZON_SP_API_REGION (US/CA phải là NA) và refresh token của shop.",
        needsReauth: false,
      };
    }
    if (status === 429) {
      return {
        error: "Bị chặn tạm thời (429) — vượt rate limit của Sellers API.",
        hint:
          "getMarketplaceParticipations chỉ cho 0.016 request/giây (rate limit, burst 15) — " +
          "chờ vài giây rồi bấm đồng bộ lại.",
        needsReauth: false,
      };
    }
    return {
      error: `SP-API trả HTTP ${status ?? "?"} khi đọc marketplaceParticipations.`,
      hint: apiMsg || detail || null,
      needsReauth: false,
    };
  }

  return {
    error: "Amazon trả 200 nhưng không có storeName trong payload.",
    hint:
      apiMsg ||
      "storeName có từ 18/12/2024 — token/app tạo trước đó có thể chưa có field này. " +
        "Thử authorize lại shop để làm mới quyền.",
    needsReauth: false,
  };
}

/** Giải thích khi Amazon trả participation nhưng KHÔNG có storeName. */
export function explainMissingStoreName(): { error: string; hint: string | null; needsReauth: boolean } {
  return explainStoreNameFailure({ stage: "parse" });
}

/**
 * Đổi refresh token (LWA) → access token rồi gọi marketplaceParticipations.
 * KHÔNG đọc env: mọi tham số truyền vào ⇒ test được và dùng được cho token của
 * TỪNG shop (không lẫn token shop khác).
 */
export async function fetchStoreNamesWithToken(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  region?: string | null;
  fetchFn?: typeof fetch;
}): Promise<StoreNameFetchResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const clientId = (opts.clientId ?? "").trim();
  const clientSecret = (opts.clientSecret ?? "").trim();
  const refreshToken = (opts.refreshToken ?? "").trim();

  if (clientId === "" || clientSecret === "" || refreshToken === "") {
    const missing = [
      clientId === "" ? "client id" : null,
      clientSecret === "" ? "client secret" : null,
      refreshToken === "" ? "refresh token" : null,
    ].filter((s): s is string => s !== null);
    return {
      ok: false,
      error: `Thiếu ${missing.join(" / ")} — không gọi được Sellers API.`,
      hint: "Shop chưa authorize (không có token) hoặc env LWA chưa đủ.",
      status: null,
      apiErrors: [],
      needsReauth: false,
    };
  }

  // ---- 1. LWA: refresh_token → access_token ----
  let accessToken = "";
  let expiresAt: string | null = null;
  try {
    const res = await fetchFn(LWA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
      cache: "no-store",
    });
    const raw = await res.text();
    if (!res.ok) {
      const e = explainStoreNameFailure({ stage: "lwa", status: res.status, body: raw });
      return { ok: false, ...e, status: res.status, apiErrors: [] };
    }
    const json = JSON.parse(raw) as { access_token?: string; expires_in?: number };
    accessToken = (json.access_token ?? "").trim();
    if (accessToken === "") {
      const e = explainStoreNameFailure({ stage: "lwa", status: res.status, body: raw });
      return { ok: false, ...e, status: res.status, apiErrors: [] };
    }
    if (typeof json.expires_in === "number" && json.expires_in > 0) {
      expiresAt = new Date(Date.now() + json.expires_in * 1000).toISOString();
    }
  } catch (err) {
    return {
      ok: false,
      error: `Không gọi được LWA token endpoint: ${err instanceof Error ? err.message : String(err)}`,
      hint: "Lỗi mạng/DNS từ server — thử lại; nếu lặp lại, kiểm tra egress của môi trường deploy.",
      status: null,
      apiErrors: [],
      needsReauth: false,
    };
  }

  // ---- 2. Sellers API: marketplaceParticipations ----
  const host = spapiHostForRegion(opts.region);
  const url = `https://${host}${MARKETPLACE_PARTICIPATIONS_PATH}`;
  let status = 0;
  let raw = "";
  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "x-amz-access-token": accessToken,
        "User-Agent": "VEXIM-Ops/1.0 (Language=Next.js; Platform=Vercel)",
      },
      cache: "no-store",
    });
    status = res.status;
    raw = await res.text();
  } catch (err) {
    return {
      ok: false,
      error: `Không gọi được SP-API ${host}: ${err instanceof Error ? err.message : String(err)}`,
      hint: "Kiểm tra kết nối ra ngoài của môi trường deploy.",
      status: null,
      apiErrors: [],
      needsReauth: false,
    };
  }

  let data: unknown = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }
  const apiErrors = extractApiErrors(data);

  if (status >= 400) {
    const e = explainStoreNameFailure({ stage: "spapi", status, body: raw, apiErrors });
    return { ok: false, ...e, status, apiErrors };
  }

  const marketplaces = parseMarketplaces(data);
  const storeNames = extractStoreNames(data);

  if (marketplaces.length === 0) {
    const e = explainStoreNameFailure({ stage: "spapi", status, body: raw, apiErrors });
    return { ok: false, ...e, status, apiErrors };
  }

  return {
    ok: true,
    storeNames,
    marketplaces,
    missingStoreName: storeNames.length === 0,
    accessTokenExpiresAt: expiresAt,
  };
}
