"use server";

/**
 * Server Action của màn Người dùng (Module 0).
 *
 * NGUYÊN TẮC: action ở đây KHÔNG tự quyết định quyền — chỉ chuyển tiếp tham số
 * xuống RPC security definer của migration 0022 (`vexim_admin_*`). DB kiểm
 * `iam.is_user_admin()`, cấp bậc người gọi/người nhận, phòng ban và ghi audit.
 * Nhờ vậy không thể "gọi API trực tiếp" để vượt mặt giao diện.
 */

import { revalidatePath } from "next/cache";

import { setUserAccess, setUserLock, updateUserProfile } from "@/lib/data/users-write";

export type ActionState = { ok: boolean; message: string };

const USERS_PATH = "/module0/users";

export async function updateProfileAction(input: {
  userId: string;
  displayName: string;
  phone: string | null;
}): Promise<ActionState> {
  if (!input.userId) return { ok: false, message: "Thiếu người dùng." };
  const r = await updateUserProfile(input);
  if (r.ok) revalidatePath(USERS_PATH);
  return r;
}

export async function setAccessAction(input: {
  userId: string;
  role: string;
  departmentCode: string | null;
  shopIds: string[];
}): Promise<ActionState> {
  if (!input.userId) return { ok: false, message: "Thiếu người dùng." };
  const r = await setUserAccess(input);
  if (r.ok) revalidatePath(USERS_PATH);
  return r;
}

export async function setLockAction(input: {
  userId: string;
  locked: boolean;
}): Promise<ActionState> {
  if (!input.userId) return { ok: false, message: "Thiếu người dùng." };
  const r = await setUserLock(input);
  if (r.ok) {
    revalidatePath(USERS_PATH);
    // Khóa/mở khóa đổi quyền đọc dữ liệu của CHÍNH người đó ⇒ làm mới cả menu badge.
    revalidatePath("/dashboard");
  }
  return r;
}
