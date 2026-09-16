/**
 * MODULE 0 — ĐỒNG BỘ TÊN SHOP AMAZON (storeName) → DB (server-only).
 *
 * ============================================================================
 * BỐI CẢNH (lỗi người dùng báo 16/09/2026)
 * ============================================================================
 * "Đã kết nối được với shop nhưng KHÔNG hiển thị tên shop Amazon đã kéo về."
 *
 * Kết luận điều tra: API không lỗi. `getMarketplaceParticipations` vẫn trả đủ dữ
 * liệu, trong đó có `storeName` — tên shop trên Amazon. Lỗi nằm ở phía mình:
 *   1. `parseMarketplaces()` bỏ qua `storeName` (chỉ lấy marketplace.name =
 *      "Amazon.com" → đây là tên SÀN, không phải tên shop);
 *   2. DB không có cột nào chứa tên shop (`display_name` là nhãn vận hành do
 *      VEXIM tự đặt);
 *   3. Không có chỗ nào gọi API để lấy tên shop rồi lưu lại.
 *
 * NAY: mỗi shop đã authorize được gọi Participations bằng CHÍNH refresh token của
 * shop đó (không mượn token shop khác — tránh ghi tên shop A cho shop B), tên
 * từng marketplace được lưu vào `connections.seller_accounts.store_name` qua RPC
 * `vexim_worker_set_shop_store_name` (migration 0031).
 *
 * QUY TẮC AN TOÀN:
 *   • Chỉ ghi khi Amazon THẬT SỰ trả tên — không bịa, không ghi chuỗi rỗng.
 *   • Không đụng `display_name` (nhãn vận hành của VEXIM).
 *   • Shop chưa có token ⇒ báo "chưa kết nối", KHÔNG dùng token shop khác.
 *   • Ngoại lệ có kiểm soát: shop self-authorization (refresh token trong env
 *     AMAZON_LWA_REFRESH_TOKEN) chỉ được nhận tên khi seller_id của shop TRÙNG
 *     seller id của token đó (mặc định AQMVYI4HJTI4C). Sai seller id ⇒ bỏ qua.
 *   • Mọi lỗi được trả về dạng có thể hành động (thiếu gì, làm gì tiếp), không
 *     nuốt lỗi thành "không có tên shop".
 */

// Import TƯƠNG ĐỐI (không dùng alias "@/…") để worker/tests import trực tiếp file
// này bằng node --test được — alias chỉ Next.js resolve.
import { adminRpc, isMissingRpcError } from "./admin-rpc.ts";
import {
  explainMissingStoreName,
  fetchStoreNamesWithToken,
  type StoreNameFetchResult,
} from "../spapi/shop-name.ts";
import { normalizeStoreName } from "../spapi/whoami.ts";

// Re-export để code cũ (và test) vẫn import từ đây được như trước.
export { isMissingRpcError };

/** Seller id của token self-authorization mặc định (shop production VEXIM). */
export const DEFAULT_SELF_SELLER_ID = "AQMVYI4HJTI4C";

export type ShopCredential = {
  sellerAccountId: string;
  sellerId: string;
  marketplace: string;
  displayName: string;
  storeName: string | null;
  shopStatus: string | null;
  dataSource: string | null;
  hasToken: boolean;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
};

export type ShopNameSyncStatus =
  | "updated"
  | "unchanged"
  | "missing"
  | "error"
  | "skipped_no_token";

export type ShopNameSyncRow = {
  sellerAccountId: string;
  displayName: string;
  marketplaceId: string;
  /** Tên Amazon trả về (null khi không lấy được) */
  storeName: string | null;
  /** Tên đang có trong DB trước khi đồng bộ */
  previousStoreName: string | null;
  status: ShopNameSyncStatus;
  message: string;
  /** Token nào đã dùng để gọi API */
  tokenSource: "shop-token" | "env-token" | "none";
};

export type ShopNameSyncReport = {
  ok: boolean;
  message: string;
  syncedAt: string;
  checked: number;
  updated: number;
  unchanged: number;
  missing: number;
  failed: number;
  skipped: number;
  rows: ShopNameSyncRow[];
};

/**
 * Danh sách shop + token (service_role). Trả `null` khi KHÔNG đọc được để caller
 * hiển thị đúng nguyên nhân thay vì "0 shop".
 */
export async function listShopCredentials(
  opts?: { fetchFn?: typeof fetch },
): Promise<{ ok: true; shops: ShopCredential[] } | { ok: false; error: string; hint: string }> {
  const fetchFn = opts?.fetchFn ?? fetch;
  const rpc = await adminRpc<Record<string, unknown>[]>(
    "vexim_worker_list_shop_credentials",
    {},
    fetchFn,
  );
  if (!rpc.ok) {
    return {
      ok: false,
      error: rpc.error,
      hint: isMissingRpcError(rpc.error, rpc.status)
        ? "Chạy migration supabase/migrations/0031_shop_store_name.sql (RPC vexim_worker_list_shop_credentials)."
        : "Kiểm tra SUPABASE_SERVICE_ROLE_KEY trên môi trường deploy.",
    };
  }
  const rows = Array.isArray(rpc.data) ? rpc.data : [];
  return {
    ok: true,
    shops: rows.map((r) => ({
      sellerAccountId: String(r.seller_account_id ?? ""),
      sellerId: String(r.seller_id ?? ""),
      marketplace: String(r.marketplace ?? ""),
      displayName: String(r.display_name ?? ""),
      storeName: normalizeStoreName(r.store_name),
      shopStatus: r.shop_status === null || r.shop_status === undefined ? null : String(r.shop_status),
      dataSource: r.data_source === null || r.data_source === undefined ? null : String(r.data_source),
      hasToken: r.has_token === true,
      refreshToken:
        typeof r.refresh_token === "string" && r.refresh_token.length > 0 ? r.refresh_token : null,
      tokenExpiresAt: r.token_expires_at ? String(r.token_expires_at) : null,
    })),
  };
}

/** Ghi tên shop Amazon — bỏ qua tên rỗng (không xoá dữ liệu cũ). */
export async function saveShopStoreName(
  opts: {
    sellerAccountId: string;
    storeName: string;
    source?: "spapi" | "manual";
    fetchFn?: typeof fetch;
  },
): Promise<{ ok: boolean; changed: boolean; error: string | null }> {
  const name = normalizeStoreName(opts.storeName);
  if (!name) return { ok: false, changed: false, error: "Tên shop rỗng — không ghi." };
  const rpc = await adminRpc<{ changed?: boolean }[]>(
    "vexim_worker_set_shop_store_name",
    {
      p_seller: opts.sellerAccountId,
      p_store_name: name,
      p_source: opts.source ?? "spapi",
    },
    opts.fetchFn ?? fetch,
  );
  if (!rpc.ok) return { ok: false, changed: false, error: rpc.error };
  const row = Array.isArray(rpc.data) ? rpc.data[0] : undefined;
  return { ok: true, changed: row?.changed === true, error: null };
}

type TokenResolver = (
  shop: ShopCredential,
) => { token: string; source: "shop-token" | "env-token" } | null;

type SyncOptions = {
  fetchFn?: typeof fetch;
  clientId?: string;
  clientSecret?: string;
  region?: string | null;
  /** chỉ đồng bộ các shop này (mặc định: hết) */
  sellerAccountIds?: string[];
};

/**
 * Chạy đồng bộ cho một nhóm shop (đã có quyết định token) — dùng chung cho cả
 * luồng "quét tất cả shop" và luồng "vừa OAuth xong".
 */
async function runSync(
  shops: ShopCredential[],
  resolveToken: TokenResolver,
  opts: SyncOptions,
  extraEnvironmentError: string | null,
): Promise<ShopNameSyncReport> {
  const fetchFn = opts.fetchFn ?? fetch;
  const clientId = (opts.clientId ?? process.env.AMAZON_LWA_CLIENT_ID ?? "").trim();
  const clientSecret = (opts.clientSecret ?? process.env.AMAZON_LWA_CLIENT_SECRET ?? "").trim();
  const region = opts.region ?? process.env.AMAZON_SP_API_REGION ?? "NA";

  const rows: ShopNameSyncRow[] = [];
  const syncedAt = new Date().toISOString();

  if (shops.length === 0) {
    return {
      ok: false,
      message: extraEnvironmentError ?? "Không có shop nào để đồng bộ tên.",
      syncedAt,
      checked: 0,
      updated: 0,
      unchanged: 0,
      missing: 0,
      failed: 0,
      skipped: 0,
      rows,
    };
  }

  // Gom theo seller_id: một lần gọi API trả tên cho MỌI marketplace của seller.
  const bySeller = new Map<string, ShopCredential[]>();
  for (const s of shops) {
    const list = bySeller.get(s.sellerId) ?? [];
    list.push(s);
    bySeller.set(s.sellerId, list);
  }

  for (const [, group] of bySeller) {
    const resolved = group.map((s) => resolveToken(s)).find((t) => t !== null) ?? null;

    if (!resolved) {
      for (const s of group) {
        rows.push({
          sellerAccountId: s.sellerAccountId,
          displayName: s.displayName,
          marketplaceId: s.marketplace,
          storeName: null,
          previousStoreName: s.storeName,
          status: "skipped_no_token",
          message:
            "Shop chưa authorize app (không có refresh token) — bấm [Kết nối] để lấy token, " +
            "sau đó đồng bộ lại tên shop.",
          tokenSource: "none",
        });
      }
      continue;
    }

    const result: StoreNameFetchResult = await fetchStoreNamesWithToken({
      clientId,
      clientSecret,
      refreshToken: resolved.token,
      region,
      fetchFn,
    });

    if (!result.ok) {
      for (const s of group) {
        rows.push({
          sellerAccountId: s.sellerAccountId,
          displayName: s.displayName,
          marketplaceId: s.marketplace,
          storeName: null,
          previousStoreName: s.storeName,
          status: "error",
          message: result.hint ? `${result.error} ${result.hint}` : result.error,
          tokenSource: resolved.source,
        });
      }
      continue;
    }

    if (result.storeNames.length === 0) {
      const e = explainMissingStoreName();
      for (const s of group) {
        rows.push({
          sellerAccountId: s.sellerAccountId,
          displayName: s.displayName,
          marketplaceId: s.marketplace,
          storeName: null,
          previousStoreName: s.storeName,
          status: "missing",
          message: e.hint ? `${e.error} ${e.hint}` : e.error,
          tokenSource: resolved.source,
        });
      }
      continue;
    }

    // Bảng tên shop Amazon trả về — tra theo ĐÚNG marketplace của từng dòng shop.
    const table = result.storeNames;

    for (const s of group) {
      const found = table.find((t) => t.marketplaceId === s.marketplace) ?? null;
      if (!found) {
        rows.push({
          sellerAccountId: s.sellerAccountId,
          displayName: s.displayName,
          marketplaceId: s.marketplace,
          storeName: null,
          previousStoreName: s.storeName,
          status: "missing",
          message:
            `Amazon không trả tên shop cho marketplace ${s.marketplace}. ` +
            `Tên hiện có: ${table.map((t) => `${t.marketplaceId}=${t.storeName}`).join(", ") || "—"}.`,
          tokenSource: resolved.source,
        });
        continue;
      }

      const saved = await saveShopStoreName({
        sellerAccountId: s.sellerAccountId,
        storeName: found.storeName,
        source: "spapi",
        fetchFn,
      });
      if (!saved.ok) {
        rows.push({
          sellerAccountId: s.sellerAccountId,
          displayName: s.displayName,
          marketplaceId: s.marketplace,
          storeName: found.storeName,
          previousStoreName: s.storeName,
          status: "error",
          message: `Đọc được tên shop "${found.storeName}" nhưng KHÔNG lưu được: ${saved.error}`,
          tokenSource: resolved.source,
        });
        continue;
      }
      rows.push({
        sellerAccountId: s.sellerAccountId,
        displayName: s.displayName,
        marketplaceId: s.marketplace,
        storeName: found.storeName,
        previousStoreName: s.storeName,
        status: saved.changed ? "updated" : "unchanged",
        message: saved.changed
          ? `Đã lưu tên shop Amazon: “${found.storeName}”.`
          : `Tên shop Amazon không đổi: “${found.storeName}”.`,
        tokenSource: resolved.source,
      });
    }
  }

  const updated = rows.filter((r) => r.status === "updated").length;
  const unchanged = rows.filter((r) => r.status === "unchanged").length;
  const missing = rows.filter((r) => r.status === "missing").length;
  const failed = rows.filter((r) => r.status === "error").length;
  const skipped = rows.filter((r) => r.status === "skipped_no_token").length;

  const parts = [
    `${rows.length} shop đã kiểm`,
    `${updated} vừa cập nhật tên`,
    unchanged > 0 ? `${unchanged} không đổi` : null,
    missing > 0 ? `${missing} Amazon không trả storeName` : null,
    skipped > 0 ? `${skipped} chưa kết nối` : null,
    failed > 0 ? `${failed} lỗi` : null,
  ].filter((s): s is string => s !== null);

  return {
    ok: updated > 0 || unchanged > 0,
    message: `${parts.join(" · ")}.`,
    syncedAt,
    checked: rows.length,
    updated,
    unchanged,
    missing,
    failed,
    skipped,
    rows,
  };
}

/**
 * Quét tên shop cho các shop trong DB (mặc định: tất cả).
 *
 * Nguồn token theo thứ tự:
 *   1. Refresh token CỦA CHÍNH SHOP (connections.oauth_tokens) — chuẩn nhất.
 *   2. Token self-authorization trong env, CHỈ khi seller_id trùng seller id của
 *      token đó (env AMAZON_SELF_SELLER_ID, mặc định DEFAULT_SELF_SELLER_ID).
 *      Nếu không xác định được token thuộc seller nào ⇒ KHÔNG dùng (không ghi
 *      tên của shop này cho shop khác).
 */
export async function syncShopStoreNames(opts?: SyncOptions & {
  envSelfSellerId?: string | null;
  envRefreshToken?: string | null;
}): Promise<ShopNameSyncReport> {
  const fetchFn = opts?.fetchFn ?? fetch;
  const listed = await listShopCredentials({ fetchFn });
  if (!listed.ok) {
    const syncedAt = new Date().toISOString();
    return {
      ok: false,
      message: `Không đọc được danh sách shop: ${listed.error} — ${listed.hint}`,
      syncedAt,
      checked: 0,
      updated: 0,
      unchanged: 0,
      missing: 0,
      failed: 0,
      skipped: 0,
      rows: [],
    };
  }

  const wanted = opts?.sellerAccountIds;
  const shops =
    wanted && wanted.length > 0
      ? listed.shops.filter((s) => wanted.includes(s.sellerAccountId))
      : listed.shops;

  const envToken = (opts?.envRefreshToken ?? process.env.AMAZON_LWA_REFRESH_TOKEN ?? "").trim();
  const envSellerId = (
    opts?.envSelfSellerId ?? process.env.AMAZON_SELF_SELLER_ID ?? DEFAULT_SELF_SELLER_ID
  ).trim();

  return runSync(
    shops,
    (shop) => {
      if (shop.hasToken && shop.refreshToken) {
        return { token: shop.refreshToken, source: "shop-token" };
      }
      if (envToken && envSellerId && shop.sellerId === envSellerId) {
        return { token: envToken, source: "env-token" };
      }
      return null;
    },
    opts ?? {},
    shops.length === 0 ? "Không tìm thấy shop nào khớp yêu cầu." : null,
  );
}

/**
 * Đồng bộ NGAY sau khi OAuth thành công bằng refresh token vừa đổi được.
 *
 * ⚠️ Chỉ áp cho shop có `seller_id` = seller vừa authorize (token vừa đổi thuộc
 * đúng seller đó) ⇒ không thể ghi tên sai shop.
 */
export async function syncStoreNamesWithFreshToken(opts: {
  sellerId: string;
  refreshToken: string;
  fetchFn?: typeof fetch;
  clientId?: string;
  clientSecret?: string;
  region?: string | null;
}): Promise<ShopNameSyncReport> {
  const fetchFn = opts.fetchFn ?? fetch;
  const listed = await listShopCredentials({ fetchFn });
  if (!listed.ok) {
    return {
      ok: false,
      message: `Không đọc được danh sách shop: ${listed.error} — ${listed.hint}`,
      syncedAt: new Date().toISOString(),
      checked: 0,
      updated: 0,
      unchanged: 0,
      missing: 0,
      failed: 0,
      skipped: 0,
      rows: [],
    };
  }
  const sellerId = (opts.sellerId ?? "").trim();
  const shops = listed.shops.filter((s) => s.sellerId === sellerId);
  const token = (opts.refreshToken ?? "").trim();

  if (token === "") {
    return runSync(
      shops,
      () => null,
      opts,
      `Không có refresh token vừa đổi được cho seller ${sellerId || "(trống)"} — bỏ qua đồng bộ tên shop.`,
    );
  }

  return runSync(shops, () => ({ token, source: "shop-token" as const }), opts, null);
}
