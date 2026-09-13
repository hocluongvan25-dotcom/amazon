/**
 * MODULE 0 — QUẢN TRỊ NGƯỜI DÙNG: LUẬT HIỂN THỊ (pure, không I/O).
 *
 * VÌ SAO TÁCH RA ĐÂY:
 *   Migration 0022 đã CHỐT luật quyền ở tầng DB (ai sửa được ai, vai trò nào gán
 *   được cho ai). Web cần cùng luật đó để ẩn/hiện nút cho khỏi "bấm rồi mới biết
 *   bị chặn" — nhưng KHÔNG được tự quyết: mọi hàm ở đây chỉ ĐOÁN TRƯỚC kết quả,
 *   chốt chặn thật vẫn là RPC security definer.
 *
 *   Vì vậy bảng cấp (`ROLE_LEVELS`) và các luật dưới đây phải KHỚP `iam.role_level`
 *   + `public.vexim_admin_*` trong 0022_user_admin.sql. Lệch nhau ⇒ nút hiện mà
 *   bấm vào báo lỗi (hoặc tệ hơn: nút ẩn mà DB cho phép).
 */

export const ROLE_LEVELS: Record<string, number> = {
  super_admin: 100,
  org_admin: 80,
  dept_lead: 50,
  operator: 30,
  analyst: 20,
  client_viewer: 10,
};

export const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super Admin",
  org_admin: "Org Admin",
  dept_lead: "Dept Lead",
  operator: "Operator",
  analyst: "Analyst",
  client_viewer: "Client Viewer",
};

/** Vai trò chỉ ĐỌC (không được ghi dữ liệu shop). */
export const READ_ONLY_ROLES = new Set(["analyst", "client_viewer"]);

/** Vai trò phải thuộc một phòng ban (xem `vexim_admin_set_user_access`). */
export const DEPT_REQUIRED_ROLES = new Set(["dept_lead", "operator", "analyst"]);

export const ALL_ROLES = [
  "super_admin",
  "org_admin",
  "dept_lead",
  "operator",
  "analyst",
  "client_viewer",
] as const;

export function roleLevel(role: string | null | undefined): number {
  return ROLE_LEVELS[role ?? ""] ?? 0;
}

export function roleLabel(role: string | null | undefined): string {
  if (!role) return "—";
  return ROLE_LABELS[role] ?? role;
}

/** Danh sách vai trò người này được phép GÁN (thấp hơn cấp của mình — luật DB). */
export function assignableRoles(actorLevel: number): string[] {
  return ALL_ROLES.filter((r) => roleLevel(r) < actorLevel);
}

export type AccountStatus = "active" | "invited" | "suspended";

export type StatusMeta = {
  label: string;
  tone: "green" | "amber" | "red";
  hint: string;
};

export function statusMeta(status: string | null | undefined): StatusMeta {
  switch (status) {
    case "active":
      return {
        label: "Đang hoạt động",
        tone: "green",
        hint: "Tài khoản đang dùng bình thường.",
      };
    case "invited":
      return {
        label: "Đã mời",
        tone: "amber",
        hint: "Đã tạo tài khoản, chưa đăng nhập lần nào. Vẫn làm việc được ngay khi vào.",
      };
    case "suspended":
      return {
        label: "Đã khóa",
        tone: "red",
        hint: "Đang bị khóa: MẤT quyền ở tầng dữ liệu (RLS), không chỉ ẩn giao diện.",
      };
    default:
      return { label: status || "—", tone: "amber", hint: "Trạng thái không rõ." };
  }
}

/** Một dòng của bảng Người dùng (đúng theo OUT của `public.vexim_admin_users()`). */
export type AdminUser = {
  userId: string;
  email: string;
  displayName: string;
  phone: string | null;
  status: string;
  role: string;
  roleLevel: number;
  roles: string[];
  department: string;
  departmentCode: string;
  shopCount: number;
  /** Shop đang được gán — để hộp thoại Phân quyền CHỌN SẴN, không ghi đè về rỗng. */
  shopIds: string[];
  canWriteShops: boolean;
  veximEmployee: boolean;
  orgName: string | null;
  lastLoginAt: string | null;
  lastSignInAt: string | null;
  createdAt: string | null;
  isSelf: boolean;
};

export type Decision = { ok: boolean; reason?: string };

/** Có phải admin người dùng không (khớp `iam.is_user_admin`). */
export function isUserAdmin(role: string | null | undefined): boolean {
  return role === "super_admin" || role === "org_admin";
}

/** Người đang đăng nhập chưa xác định được ⇒ coi như không có quyền gì. */
const NO_ACTOR: Decision = { ok: false, reason: "Chưa xác định được người đăng nhập." };

/** Sửa hồ sơ (tên/điện thoại): admin nào cũng sửa được người ngang cấp trở xuống. */
export function canEditProfile(actor: AdminUser | null, target: AdminUser): Decision {
  if (!actor) return NO_ACTOR;
  if (!isUserAdmin(actor.role)) return { ok: false, reason: "Bạn không phải admin người dùng." };
  if (target.userId === actor.userId) return { ok: true };
  if (target.roleLevel > actor.roleLevel)
    return { ok: false, reason: "Không sửa được người có cấp cao hơn mình." };
  return { ok: true };
}

/** Đổi vai trò/phạm vi shop: không tự đổi mình, chỉ gán vai trò THẤP HƠN mình. */
export function canChangeAccess(actor: AdminUser | null, target: AdminUser): Decision {
  if (!actor) return NO_ACTOR;
  if (!isUserAdmin(actor.role)) return { ok: false, reason: "Bạn không phải admin người dùng." };
  if (target.userId === actor.userId)
    return { ok: false, reason: "Không tự đổi vai trò của mình — nhờ admin khác." };
  if (target.roleLevel > actor.roleLevel)
    return { ok: false, reason: "Không đổi quyền người có cấp cao hơn mình." };
  if (roleLevel(target.role) >= 100 && actor.roleLevel < 100)
    return { ok: false, reason: "Chỉ super_admin đổi được super_admin khác." };
  if (assignableRoles(actor.roleLevel).length === 0)
    return { ok: false, reason: "Cấp của bạn không có vai trò nào thấp hơn để gán." };
  if (target.status === "suspended")
    return { ok: false, reason: "Tài khoản đang bị khóa — mở khóa trước rồi mới cấp quyền." };
  return { ok: true };
}

/** Khóa tài khoản: như đổi quyền, cộng luật "không tự khóa mình". */
export function canLock(actor: AdminUser | null, target: AdminUser): Decision {
  if (!actor) return NO_ACTOR;
  if (!isUserAdmin(actor.role)) return { ok: false, reason: "Bạn không phải admin người dùng." };
  if (target.userId === actor.userId)
    return { ok: false, reason: "Không tự khóa tài khoản của chính mình." };
  if (target.roleLevel > actor.roleLevel)
    return { ok: false, reason: "Không khóa được người có cấp cao hơn mình." };
  if (roleLevel(target.role) >= 100 && actor.roleLevel < 100)
    return { ok: false, reason: "Chỉ super_admin khóa được super_admin khác." };
  return { ok: true };
}

/** Mở khóa: cùng luật với khóa. */
export function canUnlock(actor: AdminUser | null, target: AdminUser): Decision {
  return canLock(actor, target);
}

/* ---------------------------------------------------------------- nhật ký ---- */

/** Nhãn tiếng Việt cho `iam.audit_logs.action` (module iam). */
export function auditActionLabel(action: string | null | undefined): string {
  switch (action) {
    case "user.invite":
      return "Mời người dùng";
    case "user.update":
      return "Sửa hồ sơ";
    case "user.role_change":
      return "Đổi vai trò / phạm vi shop";
    case "user.suspend":
      return "Khóa tài khoản";
    case "user.activate":
      return "Mở khóa tài khoản";
    default:
      return action || "—";
  }
}

/** Câu mô tả "cũ → mới" cho dễ đọc, KHÔNG phải JSON thô. */
export function auditDiff(
  beforeValue: Record<string, unknown> | null,
  afterValue: Record<string, unknown> | null,
): string {
  const keys = new Set([
    ...Object.keys(beforeValue ?? {}),
    ...Object.keys(afterValue ?? {}),
  ]);
  const parts: string[] = [];
  for (const k of keys) {
    const b = beforeValue?.[k];
    const a = afterValue?.[k];
    if (b === a) continue;
    parts.push(`${k}: ${fmt(b)} → ${fmt(a)}`);
  }
  return parts.length ? parts.join(" · ") : "không đổi giá trị";
}

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "có" : "không";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
  return String(v);
}

/** "5 phút trước" / "13/09/2026 09:12" — gọn cho cột bảng. */
export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "chưa đăng nhập";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "—";
  const diffMs = now.getTime() - t.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "vừa xong";
  if (mins < 60) return `${mins} phút trước`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} giờ trước`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ngày trước`;
  return t.toLocaleDateString("vi-VN");
}

/** Số shop hiển thị: super_admin có toàn quyền nên không cần liệt kê assignment. */
export function scopeLabel(user: AdminUser): string {
  if (user.role === "super_admin") return "Toàn hệ thống (không cần gán shop)";
  if (user.shopCount === 0) return "Chưa gán shop nào";
  const suffix = user.canWriteShops ? "quyền ghi" : "chỉ đọc";
  return `${user.shopCount} shop · ${suffix}`;
}

/** Gợi ý vai trò mặc định khi mở hộp "Quyền" (không bao giờ vượt cấp người gọi). */
export function defaultAssignableRole(actorLevel: number, current: string): string {
  const options = assignableRoles(actorLevel);
  if (options.includes(current)) return current;
  return options[options.length - 1] ?? "";
}
