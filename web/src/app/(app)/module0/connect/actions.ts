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
import { createShop, deleteShop, type DependentCounts } from "@/lib/data/shop-admin";
import { describeDependents } from "@/lib/data/shop-admin";
import type { NewShopValidation } from "@/lib/data/shop-admin-model";
import { syncShopStoreNames, type ShopNameSyncReport } from "@/lib/data/shop-names";

export type SyncStoreNamesState = {
  ok: boolean;
  message: string;
  report: ShopNameSyncReport | null;
};

export type CreateShopState = {
  ok: boolean;
  message: string;
  /** lỗi theo từng trường của form */
  fieldErrors: NewShopValidation["errors"];
  sellerAccountId: string | null;
};

export type DeleteShopState = {
  ok: boolean;
  deleted: boolean;
  /** true = còn dữ liệu/kết nối, phải xác nhận lần 2 (gọi lại với confirm=true) */
  requiresConfirm: boolean;
  shop: string | null;
  dependencies: DependentCounts;
  dependenciesText: string;
  message: string;
};

const CONNECT_PATH = "/module0/connect";

/** Chặn dùng khi chưa đăng nhập / chưa cấu hình / không phải quản trị. */
async function guardAdmin(): Promise<{ ok: true } | { ok: false; message: string }> {
  const session = await getAppSession();
  if (!session) return { ok: false, message: "Chưa đăng nhập — không thực hiện được." };
  if (session.mode !== "supabase") {
    return { ok: false, message: "Đang ở DEMO MODE (chưa cấu hình Supabase) nên không có shop thật để thao tác." };
  }
  if (session.persona !== "ceo") {
    return { ok: false, message: "Chỉ quản trị viên được thêm/xoá shop." };
  }
  return { ok: true };
}

export async function syncStoreNamesAction(input?: {
  sellerAccountId?: string;
}): Promise<SyncStoreNamesState> {
  const guard = await guardAdmin();
  if (!guard.ok) return { ok: false, message: guard.message, report: null };

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

/**
 * THÊM SHOP MỚI (nút [+ Thêm shop mới] trên màn Kết nối shop).
 *
 * Shop tạo ra ở trạng thái `paused` (CHƯA kết nối) nên worker không đồng bộ:
 * cron hiện dùng một refresh token chung, bật `active` cho shop của khách sẽ kéo
 * dữ liệu của shop khác vào (xem đầu file migration 0032). Sau khi bấm [Kết nối]
 * và shop authorize, Amazon trả `selling_partner_id` → hệ thống tự điền seller id
 * (RPC vexim_worker_claim_shop_seller_id) rồi lấy luôn tên shop (storeName).
 */
export async function createShopAction(input: {
  displayName: string;
  marketplace: string;
  sellerId?: string | null;
}): Promise<CreateShopState> {
  const guard = await guardAdmin();
  if (!guard.ok) return { ok: false, message: guard.message, fieldErrors: {}, sellerAccountId: null };

  const res = await createShop({
    displayName: input.displayName,
    marketplace: input.marketplace,
    sellerId: input.sellerId ?? null,
  });

  if (!res.ok) {
    return {
      ok: false,
      message: res.hint ? `${res.error} ${res.hint}` : res.error,
      fieldErrors: res.fieldErrors,
      sellerAccountId: null,
    };
  }

  revalidatePath(CONNECT_PATH);
  const s = res.shop;
  return {
    ok: true,
    message: s.created
      ? `Đã thêm shop “${s.displayName}”. Bấm [Kết nối] để authorize trên Seller Central.`
      : `Shop “${s.displayName}” đã có trong hệ thống (không tạo trùng).`,
    fieldErrors: {},
    sellerAccountId: s.sellerAccountId,
  };
}

/**
 * XOÁ SHOP. Hai bước:
 *   confirm = false → chỉ ĐẾM dữ liệu phụ thuộc (không xoá gì), UI hiện danh sách
 *                     "sẽ mất những gì" rồi mới hỏi xác nhận.
 *   confirm = true  → xoá thật (kèm token + dữ liệu đã đồng bộ của shop).
 */
export async function deleteShopAction(input: {
  sellerAccountId: string;
  confirm?: boolean;
}): Promise<DeleteShopState> {
  const guard = await guardAdmin();
  if (!guard.ok) {
    return {
      ok: false,
      deleted: false,
      requiresConfirm: false,
      shop: null,
      dependencies: {},
      dependenciesText: "",
      message: guard.message,
    };
  }

  const res = await deleteShop({
    sellerAccountId: input.sellerAccountId,
    force: input.confirm === true,
  });

  if (!res.ok) {
    return {
      ok: false,
      deleted: false,
      requiresConfirm: false,
      shop: null,
      dependencies: {},
      dependenciesText: "",
      message: res.hint ? `${res.error} ${res.hint}` : res.error,
    };
  }

  if (res.deleted) revalidatePath(CONNECT_PATH);

  return {
    ok: res.deleted || res.requiresForce,
    deleted: res.deleted,
    requiresConfirm: res.requiresForce,
    shop: res.shop,
    dependencies: res.dependents,
    dependenciesText: describeDependents(res.dependents),
    message: res.message,
  };
}
