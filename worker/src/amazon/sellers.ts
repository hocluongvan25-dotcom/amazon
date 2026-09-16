/**
 * Sellers API v1 — client cho worker/CLI (bản thật, thay cho stub "sau này sẽ gọi").
 *
 * ============================================================================
 * ĐIỀU TRA 16/09/2026 — "kết nối được shop nhưng KHÔNG hiển thị tên shop Amazon"
 * ============================================================================
 * File này trước đây chỉ có comment: "tạm thời đọc shop list từ DB; sau này sẽ gọi
 * getMarketplaceParticipations". Hệ quả: chưa có chỗ nào thực sự gọi API Sellers,
 * nên chưa bao giờ có TÊN SHOP để hiển thị.
 *
 * Theo mô hình chính thức (repo amzn/selling-partner-api-models,
 * models/sellers-api-model/sellers.json):
 *
 *   GET https://{sellingpartnerapi-*.amazon.com}/sellers/v1/marketplaceParticipations
 *   Headers: x-amz-access-token: <LWA access token>
 *   → 200 { "payload": [ { "marketplace": {...}, "participation": {...},
 *                         "storeName": "BestSellerStore" } ] }
 *
 *   `storeName` (required trong definition MarketplaceParticipation) = "The name of
 *   the seller's store as displayed in the marketplace" — CÓ TỪ 18/12/2024.
 *   Rate limit: 0.016 req/s, burst 15 ⇒ không gọi trong vòng lặp dày.
 *
 * Parse THUẦN nằm ở web/src/lib/spapi/whoami.ts (dùng chung web + worker, test
 * không cần network). File này chỉ bọc phần GỌI API.
 */

import {
  parseMarketplaces,
  storeNameForMarketplace,
  type MarketplaceInfo,
} from "../../../web/src/lib/spapi/whoami.ts";

export type { MarketplaceInfo };
export { parseMarketplaces, storeNameForMarketplace };

/** Chữ ký hàm gọi SP-API (khớp web/src/lib/spapi/client.ts — inject để test). */
export type SpApiFn = (
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  path: string,
  opts?: {
    body?: unknown;
    query?: Record<string, string | number | undefined>;
    headers?: Record<string, string>;
  },
) => Promise<{ status: number; data: unknown; raw: string }>;

export const MARKETPLACE_PARTICIPATIONS_PATH = "/sellers/v1/marketplaceParticipations";
/** getAccount (beta) — cần role AISP; chỉ dùng để tham khảo business name. */
export const ACCOUNT_PATH = "/sellers/v1/account";

export type ParticipationsResult =
  | {
      ok: true;
      marketplaces: MarketplaceInfo[];
      /** marketplace nào Amazon CÓ trả tên shop */
      storeNames: { marketplaceId: string; storeName: string }[];
      /** true = Amazon trả participation nhưng thiếu storeName (token/app cũ) */
      missingStoreName: boolean;
    }
  | { ok: false; status: number | null; error: string };

function clip(raw: string, max = 300): string {
  const s = (raw ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Giải thích lỗi SP-API bằng câu có thể hành động được. */
export function explainParticipationsError(status: number, raw: string): string {
  const body = clip(raw);
  switch (status) {
    case 403:
      return (
        `403 — SP-API từ chối getMarketplaceParticipations (${body || "không có body"}). ` +
        "Thường gặp: token của shop khác, shop chưa authorize app, hoặc app Draft mà seller " +
        "không nằm trong Test Accounts."
      );
    case 401:
      return "401 — access token không hợp lệ/hết hạn khi gọi Sellers API (kiểm tra vùng NA/EU/FE).";
    case 429:
      return "429 — vượt rate limit (0.016 req/s) của getMarketplaceParticipations; chờ rồi thử lại.";
    default:
      return `HTTP ${status} — ${body || "không có body"}`;
  }
}

/**
 * Gọi getMarketplaceParticipations và trả về marketplace + TÊN SHOP (storeName).
 * Không đọc env: người gọi truyền `spapi` (đã gắn token của ĐÚNG shop đó).
 */
export async function getMarketplaceParticipations(
  spapi: SpApiFn,
): Promise<ParticipationsResult> {
  let res: { status: number; data: unknown; raw: string };
  try {
    res = await spapi("GET", MARKETPLACE_PARTICIPATIONS_PATH);
  } catch (e) {
    return {
      ok: false,
      status: null,
      error: `Không gọi được Sellers API: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (res.status >= 400) {
    return { ok: false, status: res.status, error: explainParticipationsError(res.status, res.raw) };
  }

  const marketplaces = parseMarketplaces(res.data);
  const storeNames = marketplaces
    .filter((m) => m.storeName !== null)
    .map((m) => ({ marketplaceId: m.id, storeName: m.storeName as string }));

  if (marketplaces.length === 0) {
    return {
      ok: false,
      status: res.status,
      error:
        "Amazon trả 200 nhưng không có marketplaceParticipations nào — kiểm tra token có thuộc " +
        `seller đang bán trên marketplace này không. Body: ${clip(res.raw)}`,
    };
  }

  return {
    ok: true,
    marketplaces,
    storeNames,
    missingStoreName: storeNames.length === 0,
  };
}

/**
 * Lấy tên shop (storeName) của MỘT marketplace — dùng khi tác vụ chỉ quan tâm
 * tên của shop trên marketplace đang đồng bộ (US khác CA).
 */
export async function getStoreName(
  spapi: SpApiFn,
  marketplaceId: string,
): Promise<{ ok: boolean; storeName: string | null; error: string | null }> {
  const r = await getMarketplaceParticipations(spapi);
  if (!r.ok) return { ok: false, storeName: null, error: r.error };
  const storeName = storeNameForMarketplace(r.marketplaces, marketplaceId);
  return {
    ok: storeName !== null,
    storeName,
    error: storeName === null
      ? `Amazon không trả storeName cho marketplace ${marketplaceId} (field có từ 18/12/2024).`
      : null,
  };
}
