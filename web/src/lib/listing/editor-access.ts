/**
 * HAI LUẬT THUẦN của trình soạn listing (L3) — tách khỏi Supabase để test được
 * bằng `node --test` và để client/server dùng chung một nguồn sự thật.
 *
 * 1. `normalizeShopOptions` — bộ chọn shop lấy từ view `public.vexim_shops`
 *    (RLS lọc sẵn), KHÔNG lấy từ listing đã đồng bộ.
 *    Vì sao: shop vừa kết nối chưa có listing nào trong `vexim_listings` —
 *    nếu lấy shop từ đó thì shop thật biến mất khỏi màn hình đúng lúc cần soạn
 *    bản nháp đầu tiên ("không thấy shop nào dù đã kết nối"). Shop mới tạo
 *    (status `paused`, chờ authorize) vẫn phải chọn được; chỉ shop `revoked`
 *    (shop demo/đã gỡ) mới bị ẩn.
 *
 * 2. `resolveEditorAccess` — quyền ghi của người đang đăng nhập, MIRROR ĐÚNG
 *    hàm `iam.can_write_seller_account(uuid)` (migration 0001 + 0022):
 *      · tài khoản bị khóa (`status = 'suspended'`) ⇒ mất quyền thật
 *      · super_admin ⇒ ghi được mọi shop
 *      · còn lại ⇒ cần `iam.assignments.can_write = true` cho ĐÚNG shop đó
 *    Trước đây UI chỉ đọc `iam.assignments` nên super_admin KHÔNG có dòng
 *    assignment (shop mới kết nối sau migration 0007) bị khóa cả form dù DB
 *    cho phép ghi — đó là lỗi "nhấn vào không cho nhập liệu".
 *    Đây vẫn chỉ là GỢI Ý cho UI: RLS + trigger 0014 mới là nơi chặn thật.
 */

export type ShopOption = {
  sellerAccountId: string;
  /** Nhãn vận hành VEXIM đặt (`vexim_shops.shop` = `display_name`) */
  shop: string;
  /** Tên shop trên Amazon (`store_name`, migration 0031) — null nếu chưa đồng bộ */
  storeName?: string | null;
};

/** Một dòng thô đọc từ `vexim_shops` (cột thiếu khi migration chưa chạy). */
export type ShopOptionRow = {
  seller_account_id?: unknown;
  shop?: unknown;
  display_name?: unknown;
  store_name?: unknown;
  status?: unknown;
  data_source?: unknown;
};

function text(value: unknown): string {
  if (value == null) return "";
  return String(value).trim();
}

/**
 * Chuẩn hoá danh sách shop cho mọi bộ chọn shop của Module 1:
 *   • bỏ shop `revoked` (shop demo/đã xoá khỏi vận hành) — giữ shop `paused`
 *   • gộp trùng theo seller_account_id (một shop có nhiều dòng view)
 *   • nhãn = `shop` (nhãn vận hành), fallback `display_name` rồi tới id
 *   • sắp xếp theo nhãn (vi) để thứ tự ổn định giữa các lần tải
 */
export function normalizeShopOptions(rows: readonly ShopOptionRow[]): ShopOption[] {
  const byId = new Map<string, ShopOption>();
  for (const row of rows) {
    const id = text(row.seller_account_id);
    if (!id) continue;
    if (text(row.status) === "revoked") continue;
    const label = text(row.shop) || text(row.display_name) || id;
    const storeName = text(row.store_name) || null;
    byId.set(id, { sellerAccountId: id, shop: label, storeName });
  }
  return [...byId.values()].sort((a, b) => a.shop.localeCompare(b.shop, "vi"));
}

/**
 * Nhãn hiển thị: nhãn vận hành + tên shop Amazon khi đã có và KHÁC nhãn vận hành
 * (trùng nhau thì hiện 1 lần cho gọn).
 */
export function shopOptionLabel(option: Pick<ShopOption, "shop" | "storeName">): string {
  const store = text(option.storeName);
  const label = text(option.shop);
  if (!store || store.toLowerCase() === label.toLowerCase()) return label;
  return `${label} · 🏪 ${store}`;
}

export type EditorAccessInput = {
  /** `iam.user_profiles.status` của người đang đăng nhập */
  profileStatus?: string | null;
  /** `iam.role_assignments` của người đang đăng nhập */
  roles: readonly { role?: unknown; department_id?: unknown }[];
  /** `iam.assignments` của người đang đăng nhập TRÊN shop đang mở */
  assignments: readonly { can_write?: unknown }[];
  /** id phòng ban `listing` (null khi chưa đọc được → dept_lead không tính) */
  listingDepartmentId?: string | null;
};

export type EditorAccess = {
  /** Có quyền ghi trên shop này không (khớp `iam.can_write_seller_account`) */
  canWrite: boolean;
  /** Trưởng phòng Listing / super_admin / org_admin — được duyệt & từ chối */
  isApprover: boolean;
};

export function resolveEditorAccess(input: EditorAccessInput): EditorAccess {
  // 0022: tài khoản bị khóa mất quyền THẬT (không chỉ ẩn nút)
  if (text(input.profileStatus) === "suspended") return { canWrite: false, isApprover: false };

  const roles = input.roles ?? [];
  const hasRole = (role: string) => roles.some((r) => text(r.role) === role);

  const isSuperAdmin = hasRole("super_admin");
  const isOrgAdmin = hasRole("org_admin");
  const listingDeptId = text(input.listingDepartmentId);
  const isListingLead =
    listingDeptId !== "" &&
    roles.some((r) => text(r.role) === "dept_lead" && text(r.department_id) === listingDeptId);

  const canWrite =
    isSuperAdmin || (input.assignments ?? []).some((a) => a.can_write === true);

  return { canWrite, isApprover: isSuperAdmin || isOrgAdmin || isListingLead };
}
