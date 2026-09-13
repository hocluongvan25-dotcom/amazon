/**
 * MODULE 0 — CHIỀU GHI của màn Người dùng (chỉ là cửa gọi RPC của 0022).
 *
 *   • KHÔNG có đường nào UPDATE/INSERT thẳng vào `iam.user_profiles` từ web:
 *     mọi thay đổi đi qua `vexim_admin_update_user` / `vexim_admin_set_user_access`
 *     (security definer) — nơi DB kiểm `iam.is_user_admin`, cấp bậc, phòng ban và
 *     ghi `iam.audit_logs`. Route/server action KHÔNG tự quyết định quyền.
 *   • Khóa tài khoản là thao tác THẬT: sau khi khóa, người đó mất quyền ngay ở
 *     tầng RLS (`iam.has_role` trả false) — không phải chỉ đổi màu chip.
 *   • Web chạy bằng ANON client + cookie phiên — KHÔNG dùng service_role.
 */

import { createClient } from "@/lib/supabase/server";

export type WriteResult = { ok: true; message: string } | { ok: false; message: string };

/** SQLSTATE / thông điệp của RPC → câu tiếng Việt cho người dùng. */
function friendlyError(error: { message: string; code?: string | null }): string {
  const raw = (error.message ?? "").trim();
  const cleaned = raw.replace(/^\[M0\]\s*/, "");
  switch (error.code) {
    case "42501":
      return cleaned || "Bạn không có quyền thực hiện thao tác này.";
    case "22023":
    case "P0002":
      return cleaned || "Dữ liệu không hợp lệ.";
    default:
      if (raw.includes("permission denied") || raw.includes("CURRENT_USER")) {
        return "Bạn không có quyền thực hiện thao tác này.";
      }
      return cleaned || "Không thực hiện được thao tác.";
  }
}

/** Sửa hồ sơ (tên · điện thoại). Không đổi trạng thái ở đây — xem `setUserLock`. */
export async function updateUserProfile(input: {
  userId: string;
  displayName: string;
  phone: string | null;
}): Promise<WriteResult> {
  const name = input.displayName.trim();
  if (!name) return { ok: false, message: "Vui lòng nhập họ tên." };

  const client = await createClient();
  if (!client) return { ok: false, message: "Chưa cấu hình Supabase (chế độ demo)." };

  const { data, error } = await client.rpc("vexim_admin_update_user", {
    p_user_id: input.userId,
    p_display_name: name,
    p_phone: input.phone?.trim() ? input.phone.trim() : null,
    p_status: null,
  });
  if (error) return { ok: false, message: friendlyError(error) };

  const row = (Array.isArray(data) ? data[0] : undefined) as { message?: string } | undefined;
  return { ok: true, message: row?.message ?? "Đã lưu thông tin." };
}

/** Khóa / mở khóa tài khoản (một RPC, hai hướng — DB ghi audit tương ứng). */
export async function setUserLock(input: {
  userId: string;
  locked: boolean;
}): Promise<WriteResult> {
  const client = await createClient();
  if (!client) return { ok: false, message: "Chưa cấu hình Supabase (chế độ demo)." };

  const { data, error } = await client.rpc("vexim_admin_update_user", {
    p_user_id: input.userId,
    p_display_name: null,
    p_phone: null,
    p_status: input.locked ? "suspended" : "active",
  });
  if (error) return { ok: false, message: friendlyError(error) };

  const row = (Array.isArray(data) ? data[0] : undefined) as { message?: string } | undefined;
  return {
    ok: true,
    message:
      row?.message ??
      (input.locked ? "Đã khóa tài khoản." : "Đã mở khóa tài khoản."),
  };
}

/**
 * Cấp quyền: vai trò + phòng ban + phạm vi shop trong MỘT lời gọi.
 * `shopIds` rỗng + vai trò có ghi dữ liệu = người đó chưa thấy shop nào (DB trả lời
 * rõ điều này trong message để không ai tưởng là đã xong).
 */
export async function setUserAccess(input: {
  userId: string;
  role: string;
  departmentCode: string | null;
  shopIds: string[];
}): Promise<WriteResult> {
  if (!input.role) return { ok: false, message: "Vui lòng chọn vai trò." };

  const client = await createClient();
  if (!client) return { ok: false, message: "Chưa cấu hình Supabase (chế độ demo)." };

  const { data, error } = await client.rpc("vexim_admin_set_user_access", {
    p_user_id: input.userId,
    p_role: input.role,
    p_department: input.departmentCode,
    p_shop_ids: input.shopIds,
  });
  if (error) return { ok: false, message: friendlyError(error) };

  const row = (Array.isArray(data) ? data[0] : undefined) as { message?: string } | undefined;
  return { ok: true, message: row?.message ?? "Đã cập nhật quyền." };
}

/**
 * Điểm danh lần đăng nhập (hồ sơ `invited` → `active`, ghi `last_login_at`).
 * Gọi một lần mỗi lần vào app; bản thân RPC tự bỏ qua nếu vừa ghi trong 5 phút.
 */
export async function touchLogin(): Promise<void> {
  const client = await createClient();
  if (!client) return;
  await client.rpc("vexim_touch_login");
}
