"use server";

/**
 * Server Action của màn Kết nối shop (Module 0 — SOP-11).
 *
 * VIỆC DUY NHẤT: đồng bộ TÊN SHOP AMAZON (storeName) từ Sellers API v1 vào DB.
 *
 * Vì sao cần action (không phải nút gọi API từ trình duyệt):
 *   • Refresh token của shop nằm ở `connections.oauth_tokens` — không có policy
 *     RLS, chỉ service_role đọc được ⇒ thao tác phải chạy ở server.
 *   • Tên shop phải được gọi bằng CHÍNH token của shop đó. Làm ở client sẽ phải
 *     phơi token ra trình duyệt — tuyệt đối không.
 *
 * Phân quyền: giống màn Kết nối shop — chỉ quản trị (persona `ceo`) và phải có
 * phiên Supabase. Action KHÔNG tự quyết định quyền ghi dữ liệu: mọi thay đổi đi
 * qua RPC `vexim_worker_set_shop_store_name` (security definer, chỉ service_role,
 * migration 0031).
 */

import { revalidatePath } from "next/cache";

import { getAppSession } from "@/lib/auth/session";
import { syncShopStoreNames, type ShopNameSyncReport } from "@/lib/data/shop-names";

export type SyncStoreNamesState = {
  ok: boolean;
  message: string;
  report: ShopNameSyncReport | null;
};

const CONNECT_PATH = "/module0/connect";

export async function syncStoreNamesAction(input?: {
  sellerAccountId?: string;
}): Promise<SyncStoreNamesState> {
  const session = await getAppSession();
  if (!session) {
    return { ok: false, message: "Chưa đăng nhập — không đồng bộ được tên shop.", report: null };
  }
  if (session.mode !== "supabase") {
    return {
      ok: false,
      message: "Đang ở DEMO MODE (chưa cấu hình Supabase) nên không có shop thật để đồng bộ.",
      report: null,
    };
  }
  if (session.persona !== "ceo") {
    return { ok: false, message: "Chỉ quản trị viên được đồng bộ tên shop Amazon.", report: null };
  }

  const sellerAccountId = (input?.sellerAccountId ?? "").trim();
  const report = await syncShopStoreNames(
    sellerAccountId ? { sellerAccountIds: [sellerAccountId] } : undefined,
  );

  if (report.ok) revalidatePath(CONNECT_PATH);

  return {
    ok: report.ok,
    message: report.message,
    report,
  };
}
