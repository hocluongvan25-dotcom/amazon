/**
 * PHẠM VI SHOP dùng chung cho toàn app (bộ chọn ở thanh trên cùng) — phần ĐỌC
 * (server-only: Supabase + cookie).
 *
 * VÌ SAO CÓ FILE NÀY (sự cố 16/09/2026):
 *   Bộ chọn shop trên Topbar trước đây là **select trang trí** — chỉ render
 *   `<option>{persona.shop}</option>` với ĐÚNG MỘT lựa chọn, không `onChange`, không
 *   đọc DB. Người dùng kéo shop về hệ thống xong vẫn không chọn được shop đó ở bất
 *   kỳ màn nào (câu hỏi thật: "Sao lại không chọn được shop đã kéo về hệ thống nhỉ
 *   hay là mặc định nó như thế"). Không phải mặc định — đó là control giả.
 *
 * Luật chọn phạm vi nằm ở `shop-scope-model.ts` (`pickShopScopeId`, có test).
 */
import { cookies } from "next/headers";

import { createClient } from "@/lib/supabase/server";
import { readAll } from "./health-model";
import {
  SHOP_SCOPE_COOKIE,
  pickShopScopeId,
  type ShopOption,
} from "./shop-scope-model";

export {
  SHOP_SCOPE_COOKIE,
  SHOP_SCOPE_MAX_AGE_SECONDS,
  allShopsLabel,
  pickShopScopeId,
  shopOptionLabel,
} from "./shop-scope-model";
export type { ShopOption } from "./shop-scope-model";

const SELECT_V3 = "seller_account_id,shop,store_name,status,data_source";
const SELECT_V2 = "seller_account_id,shop,status,data_source";

/**
 * Shop người dùng đọc được — đọc `vexim_shops` (RLS lọc sẵn), KHÔNG phụ thuộc
 * listing/health đã sync hay chưa: shop mới kết nối phải chọn được ngay.
 *
 * Lùi cột theo mức migration (0031 có `store_name`; 0024/0016 thì chưa) — deploy
 * code trước khi chạy migration không được làm vỡ bộ chọn.
 */
export async function readShopScopeOptions(): Promise<ShopOption[]> {
  const client = await createClient();
  if (!client) return [];

  let rows: Record<string, unknown>[] = [];
  let hasStoreName = true;
  try {
    rows = await readAll<Record<string, unknown>>((from, to) =>
      client.from("vexim_shops").select(SELECT_V3).order("shop").range(from, to),
    );
  } catch {
    hasStoreName = false;
    rows = await readAll<Record<string, unknown>>((from, to) =>
      client.from("vexim_shops").select(SELECT_V2).order("shop").range(from, to),
    );
  }

  return rows
    .filter((r) => String(r.status ?? "") !== "revoked")
    .map((r) => ({
      id: String(r.seller_account_id),
      name: String(r.shop ?? r.display_name ?? "Shop chưa đặt tên"),
      storeName: hasStoreName ? ((r.store_name as string | null) ?? null) : null,
      status: (r.status as string | null) ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type ShopScope = {
  /** Tất cả shop người dùng đọc được (đổ vào bộ chọn). */
  shops: ShopOption[];
  /** Shop đang chọn, `null` = tất cả shop. */
  shopId: string | null;
  shop: ShopOption | null;
};

/**
 * Phạm vi shop của lượt xem hiện tại: URL thắng cookie, cả hai phải nằm trong danh
 * sách đọc được. Lỗi đọc shop KHÔNG được làm sập trang — trả "tất cả shop".
 */
export async function resolveShopScope(urlShop?: string | null): Promise<ShopScope> {
  let shops: ShopOption[] = [];
  try {
    shops = await readShopScopeOptions();
  } catch {
    shops = [];
  }
  const cookieStore = await cookies();
  const shopId = pickShopScopeId(shops, urlShop, cookieStore.get(SHOP_SCOPE_COOKIE)?.value ?? null);
  return { shops, shopId, shop: shops.find((s) => s.id === shopId) ?? null };
}
