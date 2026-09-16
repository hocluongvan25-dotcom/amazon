/**
 * MODULE 0 — THÊM / XOÁ SHOP (server-only, màn Kết nối shop · SOP-11).
 *
 * Yêu cầu 16/09/2026: "thêm một nút thêm shop mới cho VEXIM để sau này kết nối
 * cho dễ" + "xoá giúp những shop demo".
 *
 * PHÂN TẦNG QUYỀN (không tự quyết ở route):
 *   • Luật thật nằm ở DB — RPC `public.vexim_admin_create_shop` /
 *     `vexim_admin_delete_shop` (migration 0032) đều kiểm `iam.is_user_admin()`,
 *     dùng SECURITY DEFINER và ghi `iam.audit_logs`.
 *   • Web KHÔNG có policy ghi nào trên `connections.seller_accounts` — không có
 *     đường vòng nào qua REST.
 *   • Server action chỉ chuyển tiếp tham số + dịch lỗi sang câu tiếng Việt.
 *
 * XOÁ LÀ THẬT: xoá shop kéo theo token, listing, đơn hàng, tồn kho, cảnh báo của
 * shop đó (51 khoá ngoại ON DELETE CASCADE). Vì vậy luồng xoá có 2 bước: gọi
 * trước với `force=false` để ĐẾM dữ liệu phụ thuộc, chỉ xoá khi `force=true`.
 */

import { adminRpc, isMissingRpcError } from "./admin-rpc.ts";
import { validateNewShop, type NewShopInput, type NewShopValidation } from "./shop-admin-model.ts";

export type CreatedShop = {
  sellerAccountId: string;
  displayName: string;
  marketplace: string;
  sellerId: string | null;
  status: string;
  dataSource: string;
  /** false = shop đã tồn tại (không tạo trùng) */
  created: boolean;
};

export type CreateShopResult =
  | { ok: true; shop: CreatedShop }
  | { ok: false; error: string; fieldErrors: NewShopValidation["errors"]; hint: string | null };

/** Bảng đếm dữ liệu phụ thuộc: { "sales.orders": 128, ... } */
export type DependentCounts = Record<string, number>;

export type DeleteShopResult =
  | {
      ok: true;
      deleted: boolean;
      /** true = chưa xoá, cần gọi lại với force = true */
      requiresForce: boolean;
      shop: string | null;
      dependents: DependentCounts;
      message: string;
    }
  | { ok: false; error: string; hint: string | null };

function asCounts(v: unknown): DependentCounts {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
  const out: DependentCounts = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const n = Number(val);
    if (Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
}

/** Câu tóm tắt dữ liệu sẽ mất — dùng trong modal xác nhận. */
export function describeDependents(counts: DependentCounts): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return "Không có dữ liệu đã đồng bộ nào của shop này.";
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([table, n]) => `${table.split(".")[1] ?? table}: ${n}`)
    .join(" · ");
}

/**
 * Thêm shop mới. Kiểm tra dữ liệu ở tầng model (thông điệp thống nhất với form),
 * rồi gọi RPC. Shop tạo ra ở trạng thái `paused` (chưa kết nối).
 */
export async function createShop(
  input: NewShopInput,
  opts?: { fetchFn?: typeof fetch },
): Promise<CreateShopResult> {
  const valid = validateNewShop(input);
  if (!valid.ok) {
    return { ok: false, error: "Dữ liệu chưa hợp lệ.", fieldErrors: valid.errors, hint: null };
  }

  const rpc = await adminRpc<Record<string, unknown>[]>(
    "vexim_admin_create_shop",
    {
      p_display_name: valid.value.displayName,
      p_marketplace: valid.value.marketplace,
      p_seller_id: valid.value.sellerId,
      p_org_id: null,
      p_data_source: "production",
    },
    opts?.fetchFn ?? fetch,
  );

  if (!rpc.ok) {
    return {
      ok: false,
      error: rpc.error,
      fieldErrors: {},
      hint: isMissingRpcError(rpc.error, rpc.status)
        ? "Chạy migration supabase/migrations/0032_shop_admin.sql (RPC vexim_admin_create_shop) rồi thử lại."
        : rpc.status === 401 || rpc.status === 403
          ? "Chỉ quản trị viên (super_admin/org_admin) được thêm shop."
          : "Kiểm tra SUPABASE_SERVICE_ROLE_KEY trên môi trường deploy.",
    };
  }

  const row = Array.isArray(rpc.data) ? rpc.data[0] : undefined;
  if (!row || !row.seller_account_id) {
    return { ok: false, error: "RPC không trả về shop vừa tạo.", fieldErrors: {}, hint: null };
  }

  return {
    ok: true,
    shop: {
      sellerAccountId: String(row.seller_account_id),
      displayName: String(row.display_name ?? valid.value.displayName),
      marketplace: String(row.marketplace ?? valid.value.marketplace),
      sellerId: row.seller_id === null || row.seller_id === undefined ? null : String(row.seller_id),
      status: String(row.status ?? "paused"),
      dataSource: String(row.data_source ?? "production"),
      created: row.created !== false,
    },
  };
}

/**
 * Xoá shop. Gọi với `force = false` trước để biết shop còn gì (không xoá gì);
 * chỉ xoá khi `force = true` — sau khi người dùng đã nhìn thấy danh sách dữ liệu
 * sẽ mất.
 */
export async function deleteShop(
  opts: { sellerAccountId: string; force?: boolean; fetchFn?: typeof fetch },
): Promise<DeleteShopResult> {
  const id = (opts.sellerAccountId ?? "").trim();
  if (!id) return { ok: false, error: "Thiếu shop cần xoá.", hint: null };

  const rpc = await adminRpc<Record<string, unknown>[]>(
    "vexim_admin_delete_shop",
    { p_seller_account_id: id, p_force: opts.force === true },
    opts.fetchFn ?? fetch,
  );

  if (!rpc.ok) {
    return {
      ok: false,
      error: rpc.error,
      hint: isMissingRpcError(rpc.error, rpc.status)
        ? "Chạy migration supabase/migrations/0032_shop_admin.sql (RPC vexim_admin_delete_shop) rồi thử lại."
        : rpc.status === 401 || rpc.status === 403
          ? "Chỉ quản trị viên (super_admin/org_admin) được xoá shop."
          : "Kiểm tra SUPABASE_SERVICE_ROLE_KEY trên môi trường deploy.",
    };
  }

  const row = Array.isArray(rpc.data) ? rpc.data[0] : undefined;
  if (!row) return { ok: false, error: "RPC không trả về kết quả xoá shop.", hint: null };

  return {
    ok: true,
    deleted: row.deleted === true,
    requiresForce: row.requires_force === true,
    shop: row.shop === null || row.shop === undefined ? null : String(row.shop),
    dependents: asCounts(row.summary),
    message: String(row.message ?? (row.deleted === true ? "Đã xoá shop." : "Chưa xoá.")),
  };
}

export type ClaimSellerIdResult = {
  ok: boolean;
  matches: boolean;
  adopted: boolean;
  sellerId: string | null;
  message: string;
};

/**
 * Callback OAuth: điền seller id thật (Amazon trả ở `selling_partner_id`) cho
 * shop tạo trước khi authorize (seller_id NULL).
 *
 * `matches = false` ⇒ callback PHẢI từ chối lưu token (shop đang khai seller id
 * khác, hoặc đã có shop khác cùng seller id + marketplace).
 */
export async function claimShopSellerId(
  opts: { sellerAccountId: string; sellerIdFromAmazon: string; fetchFn?: typeof fetch },
): Promise<ClaimSellerIdResult> {
  const rpc = await adminRpc<Record<string, unknown>[]>(
    "vexim_worker_claim_shop_seller_id",
    { p_seller: opts.sellerAccountId, p_seller_id: opts.sellerIdFromAmazon },
    opts.fetchFn ?? fetch,
  );
  if (!rpc.ok) {
    return {
      ok: false,
      matches: false,
      adopted: false,
      sellerId: null,
      message: isMissingRpcError(rpc.error, rpc.status)
        ? "Chưa chạy migration 0032 (RPC vexim_worker_claim_shop_seller_id) nên không tự điền được seller id."
        : rpc.error,
    };
  }
  const row = Array.isArray(rpc.data) ? rpc.data[0] : undefined;
  if (!row) {
    return { ok: false, matches: false, adopted: false, sellerId: null, message: "RPC không trả về kết quả." };
  }
  return {
    ok: true,
    matches: row.matches === true,
    adopted: row.adopted === true,
    sellerId: row.seller_id === null || row.seller_id === undefined ? null : String(row.seller_id),
    message: String(row.message ?? ""),
  };
}
