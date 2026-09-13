import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assignableRoles,
  auditActionLabel,
  auditDiff,
  canChangeAccess,
  canEditProfile,
  canLock,
  canUnlock,
  defaultAssignableRole,
  relativeTime,
  roleLabel,
  roleLevel,
  scopeLabel,
  statusMeta,
  type AdminUser,
} from "../src/lib/users-model.ts";

/**
 * Các luật ở đây PHẢI khớp `iam.role_level()` + `public.vexim_admin_*` trong
 * `supabase/migrations/0022_user_admin.sql`. Nếu không khớp thì nút hiện mà bấm
 * vào báo lỗi (hoặc tệ hơn: nút ẩn nhưng DB vẫn cho phép).
 */

function user(over: Partial<AdminUser> & { userId: string; role: string }): AdminUser {
  return {
    email: `${over.userId}@vexim.vn`,
    displayName: over.userId,
    phone: null,
    status: "active",
    roleLevel: roleLevel(over.role),
    roles: [over.role],
    department: "",
    departmentCode: "",
    shopCount: 0,
    shopIds: [],
    canWriteShops: false,
    veximEmployee: true,
    orgName: null,
    lastLoginAt: null,
    lastSignInAt: null,
    createdAt: null,
    isSelf: false,
    ...over,
  };
}

const superAdmin = user({ userId: "sv", role: "super_admin" });
const orgAdmin = user({ userId: "org", role: "org_admin" });
const lead = user({ userId: "lead", role: "dept_lead" });
const operator = user({ userId: "op", role: "operator" });
const invited = user({ userId: "moi", role: "analyst", status: "invited" });

test("thứ bậc vai trò khớp iam.role_level", () => {
  assert.equal(roleLevel("super_admin"), 100);
  assert.equal(roleLevel("org_admin"), 80);
  assert.equal(roleLevel("dept_lead"), 50);
  assert.equal(roleLevel("operator"), 30);
  assert.equal(roleLevel("analyst"), 20);
  assert.equal(roleLevel("client_viewer"), 10);
  assert.equal(roleLevel("khong_ton_tai"), 0);
  assert.equal(roleLabel("dept_lead"), "Dept Lead");
  assert.equal(roleLabel(""), "—");
});

test("chỉ gán được vai trò THẤP HƠN cấp mình (khớp luật DB)", () => {
  assert.deepEqual(assignableRoles(100), [
    "org_admin",
    "dept_lead",
    "operator",
    "analyst",
    "client_viewer",
  ]);
  assert.deepEqual(assignableRoles(80), ["dept_lead", "operator", "analyst", "client_viewer"]);
  assert.deepEqual(assignableRoles(50), ["operator", "analyst", "client_viewer"]);
  // operator (30) chỉ gán được vai trò THẤP HƠN: analyst · client_viewer.
  // (DB còn cho trưởng phòng cấp quyền trong phòng mình, nhưng màn Người dùng chỉ
  //  cho admin mở — xem chú thích ở `canChangeAccess`.)
  assert.deepEqual(assignableRoles(30), ["analyst", "client_viewer"]);
  assert.deepEqual(assignableRoles(20), ["client_viewer"]);
  assert.deepEqual(assignableRoles(10), []);
  // Vai trò đang có mà không nằm trong danh sách gán được ⇒ rơi về lựa chọn thấp nhất.
  assert.equal(defaultAssignableRole(100, "operator"), "operator");
  // 50 (dept_lead) gán được operator/analyst/client_viewer ⇒ vai trò hiện tại không
  // nằm trong danh sách thì rơi về lựa chọn THẤP NHẤT.
  assert.equal(defaultAssignableRole(50, "super_admin"), "client_viewer");
});

test("nút Sửa: admin nào cũng sửa được người ngang cấp trở xuống, không sửa người cấp cao hơn", () => {
  assert.equal(canEditProfile(superAdmin, operator).ok, true);
  assert.equal(canEditProfile(orgAdmin, operator).ok, true);
  assert.equal(canEditProfile(orgAdmin, superAdmin).ok, false);
  assert.equal(canEditProfile(operator, operator).ok, false);
  assert.equal(canEditProfile(null, operator).ok, false);
  // Tự sửa hồ sơ mình: được (policy 0004 + grant cột của 0022).
  const me = user({ userId: "me", role: "org_admin", isSelf: true });
  assert.equal(canEditProfile(me, me).ok, true);
});

test("nút Quyền: không tự đổi mình, không vượt cấp, không đụng tài khoản đang khóa", () => {
  assert.equal(canChangeAccess(superAdmin, operator).ok, true);
  assert.equal(canChangeAccess(orgAdmin, lead).ok, true);
  const selfRole = canChangeAccess(superAdmin, superAdmin);
  assert.equal(selfRole.ok, false);
  assert.match(selfRole.reason ?? "", /tự đổi vai trò/);
  assert.equal(canChangeAccess(orgAdmin, superAdmin).ok, false);
  assert.equal(canChangeAccess(lead, operator).ok, false);
  assert.equal(
    canChangeAccess(superAdmin, user({ userId: "lock", role: "operator", status: "suspended" })).ok,
    false,
  );
});

test("nút Khóa/Mở khóa: không tự khóa mình, chỉ super_admin đụng super_admin khác", () => {
  assert.equal(canLock(superAdmin, operator).ok, true);
  assert.equal(canLock(orgAdmin, operator).ok, true);
  assert.equal(canLock(orgAdmin, superAdmin).ok, false);
  const self = canLock(superAdmin, superAdmin);
  assert.equal(self.ok, false);
  assert.match(self.reason ?? "", /tự khóa/);
  assert.equal(canUnlock(superAdmin, user({ userId: "l", role: "operator", status: "suspended" })).ok, true);
  assert.equal(canUnlock(null, operator).ok, false);
});

test("trạng thái tài khoản: nhãn + sắc thái + nói rõ khóa là mất quyền thật", () => {
  assert.equal(statusMeta("active").label, "Đang hoạt động");
  assert.equal(statusMeta("active").tone, "green");
  assert.equal(statusMeta("invited").tone, "amber");
  assert.equal(statusMeta("suspended").tone, "red");
  assert.match(statusMeta("suspended").hint, /RLS/);
  assert.equal(statusMeta("la_gi_do").label, "la_gi_do");
});

test("phạm vi shop hiển thị đúng cho từng loại vai trò", () => {
  assert.match(scopeLabel(user({ userId: "s", role: "super_admin", shopCount: 6, canWriteShops: true })), /Toàn hệ thống/);
  assert.match(scopeLabel(user({ userId: "o", role: "operator", shopCount: 2, canWriteShops: true })), /2 shop · quyền ghi/);
  assert.match(scopeLabel(user({ userId: "a", role: "analyst", shopCount: 3 })), /3 shop · chỉ đọc/);
  assert.match(scopeLabel(user({ userId: "z", role: "operator" })), /Chưa gán shop nào/);
});

test("nhật ký quản trị: nhãn hành động + câu 'cũ → mới' đọc được", () => {
  assert.equal(auditActionLabel("user.role_change"), "Đổi vai trò / phạm vi shop");
  assert.equal(auditActionLabel("user.suspend"), "Khóa tài khoản");
  assert.equal(auditActionLabel("user.activate"), "Mở khóa tài khoản");
  assert.equal(auditActionLabel("user.invite"), "Mời người dùng");
  assert.equal(auditActionLabel("la.la"), "la.la");
  const text = auditDiff({ status: "active", role: "operator" }, { status: "suspended", role: "operator" });
  assert.equal(text, "status: active → suspended");
  assert.equal(auditDiff({ a: 1 }, { a: 1 }), "không đổi giá trị");
  assert.equal(auditDiff({ shop_count: 0 }, { shop_count: 2 }), "shop_count: 0 → 2");
  assert.equal(auditDiff(null, { can_write: true }), "can_write: — → có");
});

test("'đăng nhập cuối': chưa đăng nhập / vừa xong / theo giờ", () => {
  const now = new Date("2026-09-13T10:00:00Z");
  assert.equal(relativeTime(null, now), "chưa đăng nhập");
  assert.equal(relativeTime("2026-09-13T09:59:30Z", now), "vừa xong");
  assert.equal(relativeTime("2026-09-13T09:30:00Z", now), "30 phút trước");
  assert.equal(relativeTime("2026-09-13T07:00:00Z", now), "3 giờ trước");
  assert.equal(relativeTime("2026-09-10T10:00:00Z", now), "3 ngày trước");
  assert.equal(relativeTime("không-phải-ngày", now), "—");
});

test("màn Người dùng KHÔNG còn dữ liệu người dùng giả (đã xoá hẳn, không chỉ ẩn)", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const web = join(dirname(fileURLToPath(import.meta.url)), "..");

  // 1) file fixture giả lập của màn Người dùng phải KHÔNG còn tồn tại
  assert.equal(
    existsSync(join(web, "src/app/(app)/module0/users/demo-users.ts")),
    false,
    "demo-users.ts phải bị xoá — bảng người dùng để trắng thay vì bày dữ liệu giả",
  );

  // 2) mock.ts không còn mảng `users` và 6 email giả cũ
  const mock = readFileSync(join(web, "src/lib/data/mock.ts"), "utf8");
  assert.equal(/export const users\s*:/.test(mock), false, "mock.ts không được export mảng users");
  for (const email of [
    "haianh@vexim.vn",
    "mylinh@vexim.vn",
    "tuan@vexim.vn",
    "ha@vexim.vn",
    "lan@vexim.vn",
    "contact@khacha-a.vn",
  ]) {
    assert.equal(mock.includes(email), false, `email giả cũ vẫn còn trong mock.ts: ${email}`);
  }

  // 3) trang Người dùng phải truyền bảng RỖNG ở chế độ demo (không có nhánh dữ liệu mẫu)
  const page = readFileSync(join(web, "src/app/(app)/module0/users/page.tsx"), "utf8");
  assert.match(page, /users=\{\[\]\}/, "nhánh demo phải truyền users={[]}");
  assert.equal(/DEMO_USERS|demo-users/.test(page), false, "trang không được tham chiếu fixture giả");
});

test("mock.ts không còn số liệu khách hàng viết cứng cho /client", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const web = join(dirname(fileURLToPath(import.meta.url)), "..");
  const mock = readFileSync(join(web, "src/lib/data/mock.ts"), "utf8");
  assert.equal(/export const clientKpis\s*:/.test(mock), false, "clientKpis phải bị xoá");
  assert.equal(/export const clientReports\s*:/.test(mock), false, "clientReports phải bị xoá");
  assert.equal(mock.includes("$186,400"), false, "số doanh thu bịa còn sót trong mock.ts");
  assert.equal(mock.includes("$23,900"), false, "số settlement bịa còn sót trong mock.ts");
});
