/**
 * MODULE 0 — ĐỌC dữ liệu NGƯỜI DÙNG THẬT cho màn `/module0/users`.
 *
 * ĐỔI GỐC 13/09/2026: màn này trước đây render một MẢNG MOCK 6 người viết cứng
 * trong `web/src/lib/data/mock.ts` ⇒ người dùng thật mở lên tưởng đó là nhân viên
 * đã mời, trong khi DB không hề có ai. Từ 0022_user_admin.sql, danh sách đọc từ
 * `public.vexim_admin_users()` (security definer, tự kiểm `iam.is_user_admin`).
 *
 * KHÔNG có bảng/view mới cho việc này: dữ liệu nhân sự (email · phòng · quyền) chỉ
 * đi qua RPC có kiểm quyền, không mở RLS rộng cho mọi người đọc.
 */

import { createClient } from "@/lib/supabase/server";
import type { AdminUser } from "@/lib/users-model";

export type AdminAuditRow = {
  id: string;
  createdAt: string | null;
  actorName: string | null;
  actorEmail: string | null;
  action: string;
  entity: string | null;
  beforeValue: Record<string, unknown> | null;
  afterValue: Record<string, unknown> | null;
  result: string | null;
};

export type DepartmentOption = { id: string; code: string; name: string };
export type ShopOption = { id: string; shop: string; status: string | null };

export type UsersSnapshot =
  | {
      ok: true;
      users: AdminUser[];
      audit: AdminAuditRow[];
      departments: DepartmentOption[];
      shops: ShopOption[];
      /** Người đang đăng nhập — để UI biết nút nào được bấm. */
      me: AdminUser | null;
    }
  | { ok: false; message: string };

type RawUser = Record<string, unknown>;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function mapUser(row: RawUser): AdminUser {
  const roles = Array.isArray(row.roles) ? (row.roles as unknown[]).map(str) : [];
  return {
    userId: str(row.user_id),
    email: str(row.email),
    displayName: str(row.display_name) || str(row.email),
    phone: row.phone == null ? null : str(row.phone),
    status: str(row.status) || "active",
    role: str(row.role),
    roleLevel: num(row.role_level),
    roles,
    department: str(row.department),
    departmentCode: str(row.department_code),
    shopCount: num(row.shop_count),
    shopIds: Array.isArray(row.shop_ids) ? (row.shop_ids as unknown[]).map(str) : [],
    canWriteShops: row.can_write_shops === true,
    veximEmployee: row.vexim_employee === true,
    orgName: row.org_name == null ? null : str(row.org_name),
    lastLoginAt: row.last_login_at == null ? null : str(row.last_login_at),
    lastSignInAt: row.last_sign_in_at == null ? null : str(row.last_sign_in_at),
    createdAt: row.created_at == null ? null : str(row.created_at),
    isSelf: row.is_self === true,
  };
}

/** RPC bị chặn quyền ⇒ đây là "không có quyền", không phải lỗi hệ thống. */
export function isForbidden(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("chỉ super_admin") ||
    m.includes("insufficient_privilege") ||
    m.includes("cần đăng nhập") ||
    m.includes("permission denied") ||
    m.includes("không có quyền")
  );
}

/**
 * Đọc MỘT LẦN mọi thứ màn Người dùng cần.
 * Trả `{ ok:false }` khi người gọi không phải admin (DB từ chối) — trang hiển thị
 * "không có quyền" chứ KHÔNG hiển thị bảng rỗng (bảng rỗng gây hiểu sai là
 * "hệ thống chưa có người dùng nào").
 */
export async function readUsersSnapshot(): Promise<UsersSnapshot> {
  const client = await createClient();
  if (!client) return { ok: false, message: "Chưa cấu hình Supabase (chế độ demo)." };

  const { data, error } = await client.rpc("vexim_admin_users");
  if (error) {
    const msg = error.message || "Không đọc được danh sách người dùng.";
    return { ok: false, message: isForbidden(msg) ? "Bạn không phải admin người dùng." : msg };
  }
  const users = ((data ?? []) as unknown as RawUser[]).map(mapUser);

  // Dữ liệu phụ cho hộp thoại "Quyền": phòng ban + shop. Lỗi ở đây KHÔNG làm sập
  // trang — chỉ là thiếu lựa chọn, nên trả mảng rỗng và để UI nói rõ.
  const [deptRes, shopRes, auditRes] = await Promise.all([
    client.schema("iam").from("departments").select("id, code, name").order("code"),
    client.from("vexim_shops").select("seller_account_id, shop, status").order("shop"),
    client.rpc("vexim_admin_audit", { p_limit: 40 }),
  ]);

  const departments: DepartmentOption[] = (
    (deptRes.data ?? []) as unknown as { id: string; code: string; name: string }[]
  ).map((d) => ({ id: d.id, code: d.code, name: d.name }));

  const shops: ShopOption[] = (
    (shopRes.data ?? []) as unknown as {
      seller_account_id: string;
      shop: string;
      status: string | null;
    }[]
  ).map((s) => ({ id: s.seller_account_id, shop: s.shop, status: s.status }));

  const audit: AdminAuditRow[] = auditRes.error
    ? []
    : (
        (auditRes.data ?? []) as unknown as {
          id: string;
          created_at: string | null;
          actor_name: string | null;
          actor_email: string | null;
          action: string;
          entity: string | null;
          before_value: Record<string, unknown> | null;
          after_value: Record<string, unknown> | null;
          result: string | null;
        }[]
      ).map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        actorName: r.actor_name,
        actorEmail: r.actor_email,
        action: r.action,
        entity: r.entity,
        beforeValue: r.before_value,
        afterValue: r.after_value,
        result: r.result,
      }));

  return {
    ok: true,
    users,
    audit,
    departments,
    shops,
    me: users.find((u) => u.isSelf) ?? null,
  };
}
