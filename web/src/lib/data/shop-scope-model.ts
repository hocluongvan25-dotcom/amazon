/**
 * PHẦN THUẦN của "phạm vi shop" — không import Supabase/Next nên:
 *   • `node --test` kiểm được (web/tests/shop-scope.test.ts), và
 *   • component CLIENT (`ShopScopeSelect`) import được (file `shop-scope.ts` có
 *     `next/headers` + Supabase ⇒ chỉ dùng ở server).
 *
 * Xem `shop-scope.ts` để biết vì sao có cả file này (sự cố bộ chọn shop giả
 * trên Topbar, 16/09/2026).
 */

/** Cookie giữ phạm vi shop đang chọn (do `ShopScopeSelect` ghi). */
export const SHOP_SCOPE_COOKIE = "shop_scope";

/** 90 ngày — đủ dài để người vận hành không phải chọn lại mỗi ngày. */
export const SHOP_SCOPE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

export type ShopOption = {
  id: string;
  /** nhãn vận hành (display_name) */
  name: string;
  /** tên shop Amazon (storeName) — có sau migration 0031, có thể null */
  storeName: string | null;
  status: string | null;
};

/**
 * Chọn phạm vi shop từ (URL, cookie) + danh sách đọc được. Hàm THUẦN.
 *
 * Luật:
 *   1. `?shop=` thắng cookie (link chia sẻ được giữ nguyên hành vi cũ).
 *   2. Cả hai phải nằm trong danh sách shop người dùng ĐỌC ĐƯỢC — cookie cũ trỏ
 *      sang shop đã thu hồi/đổi quyền thì bỏ qua (thà về "tất cả shop" còn hơn
 *      dựng truy vấn rồi trả rỗng khó hiểu).
 *   3. Chuỗi rỗng/khoảng trắng = "tất cả shop".
 *
 * @returns id shop đang chọn, hoặc `null` = tất cả shop.
 */
export function pickShopScopeId(
  shops: readonly { id: string }[],
  urlShop?: string | null,
  cookieShop?: string | null,
): string | null {
  const known = new Set(shops.map((s) => s.id));
  for (const candidate of [urlShop, cookieShop]) {
    const value = (candidate ?? "").trim();
    if (value && known.has(value)) return value;
  }
  return null;
}

/** Nhãn hiển thị: "VEXIM US — Vexim Global" khi đã có tên shop Amazon. */
export function shopOptionLabel(shop: { name: string; storeName?: string | null }): string {
  const store = (shop.storeName ?? "").trim();
  if (!store || store === shop.name) return shop.name;
  return `${shop.name} — ${store}`;
}

/** Nhãn của mục "tất cả shop" trên bộ chọn. */
export function allShopsLabel(count: number): string {
  return count > 0 ? `Tất cả shop (${count})` : "Tất cả shop";
}
