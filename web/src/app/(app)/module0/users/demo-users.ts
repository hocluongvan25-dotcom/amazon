/**
 * Dữ liệu GIẢ LẬP cho chế độ DEMO (chưa cấu hình Supabase) của màn Người dùng.
 *
 * VÌ SAO CÓ FILE NÀY (13/09/2026):
 *   Màn `/module0/users` trước đây đọc 6 tài khoản viết cứng trong
 *   `web/src/lib/data/mock.ts` với email thật kiểu `haianh@vexim.vn`. Người dùng
 *   thật mở lên tưởng đó là nhân viên đã mời. Yêu cầu: bỏ hẳn. Nay:
 *     • Bảng THẬT đọc `iam.user_profiles` qua `public.vexim_admin_users()`.
 *     • Chế độ demo (chỉ để xem giao diện) dùng danh sách dưới đây — tên và email
 *       ghi rõ là giả lập (`@vexim.example`), KHÔNG trùng bất kỳ ai thật.
 */

import type { AdminUser } from "@/lib/users-model";

function demo(
  userId: string,
  email: string,
  displayName: string,
  role: string,
  roleLevel: number,
  department: string,
  departmentCode: string,
  shopCount: number,
  shopIds: string[],
  status: string,
  canWriteShops: boolean,
  isSelf = false,
): AdminUser {
  return {
    userId,
    email,
    displayName,
    phone: null,
    status,
    role,
    roleLevel,
    roles: [role],
    department,
    departmentCode,
    shopCount,
    shopIds,
    canWriteShops,
    veximEmployee: role !== "client_viewer",
    orgName: role === "client_viewer" ? "Khách hàng demo" : null,
    lastLoginAt: status === "invited" ? null : new Date(Date.now() - 3600_000).toISOString(),
    lastSignInAt: null,
    createdAt: null,
    isSelf,
  };
}

export const DEMO_SHOPS = [
  { id: "demo-shop-a1", shop: "A1 · US (demo)", status: "production" },
  { id: "demo-shop-a2", shop: "A2 · CA (demo)", status: "production" },
  { id: "demo-shop-b1", shop: "B1 · UK (demo)", status: "production" },
];

export const DEMO_DEPARTMENTS = [
  { id: "demo-dept-ppc", code: "ppc", name: "Quảng cáo (PPC)" },
  { id: "demo-dept-ops", code: "ops_health", name: "Vận hành & Account Health" },
  { id: "demo-dept-fin", code: "finance", name: "Tài chính & Đối soát" },
];

export const DEMO_USERS: AdminUser[] = [
  demo(
    "demo-super",
    "superadmin@vexim.example",
    "Demo · Super Admin",
    "super_admin",
    100,
    "Điều phối",
    "",
    DEMO_SHOPS.length,
    DEMO_SHOPS.map((s) => s.id),
    "active",
    true,
    true,
  ),
  demo(
    "demo-lead",
    "truongphong.ppc@vexim.example",
    "Demo · Trưởng phòng PPC",
    "dept_lead",
    50,
    "Quảng cáo (PPC)",
    "ppc",
    2,
    [DEMO_SHOPS[0].id, DEMO_SHOPS[1].id],
    "active",
    true,
  ),
  demo(
    "demo-op",
    "nhanvien.ppc@vexim.example",
    "Demo · Nhân viên PPC",
    "operator",
    30,
    "Quảng cáo (PPC)",
    "ppc",
    1,
    [DEMO_SHOPS[0].id],
    "active",
    true,
  ),
  demo(
    "demo-invited",
    "moi.moi@vexim.example",
    "Demo · Người vừa được mời",
    "analyst",
    20,
    "Tài chính & Đối soát",
    "finance",
    0,
    [],
    "invited",
    false,
  ),
  demo(
    "demo-locked",
    "dakhoa@vexim.example",
    "Demo · Tài khoản đã khóa",
    "operator",
    30,
    "Vận hành & Account Health",
    "ops_health",
    2,
    [DEMO_SHOPS[0].id, DEMO_SHOPS[2].id],
    "suspended",
    true,
  ),
];
