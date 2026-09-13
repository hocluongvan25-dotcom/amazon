"use client";

/**
 * Bảng Người dùng & phân quyền — 3 nút Sửa · Quyền · Khóa đều LÀM THẬT.
 *
 * ĐỔI GỐC 13/09/2026 (yêu cầu của anh Hồ Lương Văn):
 *   • Bảng cũ render 6 tài khoản MOCK viết cứng + 3 nút `disabled` — nhìn như lỗi
 *     phân quyền nhưng thật ra là màn demo. Nay bảng đọc `iam.*` thật (server
 *     truyền xuống) và 3 nút gọi server action → RPC của 0022.
 *   • Nút bị CHẶN thì nói RÕ LÝ DO ngay trên nút (không để bấm rồi mới báo lỗi).
 *     Luật ẩn/hiện nằm ở `@/lib/users-model` và phải khớp DB; DB vẫn là chốt chặn cuối.
 *   • "Khóa" là thao tác thật: sau khi khóa, người đó MẤT quyền ở tầng RLS. Vì vậy
 *     phải xác nhận 2 bước (bấm Khóa → hiện hộp xác nhận), KHÔNG dùng window.confirm
 *     (có thể bị chặn trong iframe nhúng).
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Chip, Panel, tableCls } from "@/components/ui";
import type { AdminAuditRow, DepartmentOption, ShopOption } from "@/lib/data/users-admin";
import {
  auditActionLabel,
  auditDiff,
  canChangeAccess,
  canEditProfile,
  canLock,
  canUnlock,
  defaultAssignableRole,
  DEPT_REQUIRED_ROLES,
  READ_ONLY_ROLES,
  relativeTime,
  roleLabel,
  scopeLabel,
  statusMeta,
  assignableRoles,
  type AdminUser,
} from "@/lib/users-model";
import { setAccessAction, setLockAction, updateProfileAction } from "./actions";

type EditorMode = "edit" | "access" | "lock";

type Props = {
  demo: boolean;
  users: AdminUser[];
  me: AdminUser | null;
  departments: DepartmentOption[];
  shops: ShopOption[];
  audit: AdminAuditRow[];
};

export function UsersBoard({ demo, users, me, departments, shops, audit }: Props) {
  // Nút bật/tắt theo LUẬT THẬT kể cả ở chế độ demo: người xem thấy ngay vì sao
  // dòng "chính mình" không có nút Quyền/Khóa (không ai tự nâng quyền/tự khóa).
  const [editor, setEditor] = useState<{ mode: EditorMode; userId: string } | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const target = editor ? users.find((u) => u.userId === editor.userId) ?? null : null;

  function openEditor(mode: EditorMode, userId: string) {
    setMessage(null);
    setEditor((cur) => (cur && cur.mode === mode && cur.userId === userId ? null : { mode, userId }));
  }

  return (
    <>
      {demo ? (
        <div className="mb-4 rounded-[13px] border-2 border-dashed border-amber/60 bg-amber-soft px-4 py-3 text-[12.5px] text-[#8a5602]">
          <b>CHẾ ĐỘ DEMO</b> — bảng dưới là dữ liệu GIẢ LẬP để xem giao diện (email đuôi{" "}
          <code>@vexim.example</code>). Chưa cấu hình Supabase nên không đọc được{" "}
          <code>iam.user_profiles</code>; nút Sửa/Quyền/Khóa chỉ mô phỏng, không ghi vào DB.
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <a
          href="/module0/users/new"
          className="h-9 rounded-full bg-accent px-4 py-2 text-[12.5px] font-extrabold text-white transition hover:bg-accent-ink"
        >
          ＋ Thêm người dùng
        </a>
        <span className="text-[12px] font-semibold text-soft">
          {me
            ? `Bạn đăng nhập là ${me.displayName} · ${roleLabel(me.role)} (cấp ${me.roleLevel})`
            : demo
              ? "Bạn đang là persona CEO trong chế độ demo"
              : ""}
        </span>
      </div>

      {message ? (
        <div
          className={`mb-3 rounded-[11px] border px-3.5 py-2.5 text-[12.5px] font-semibold ${
            message.ok
              ? "border-green/40 bg-green-soft text-[#0b7a55]"
              : "border-red/40 bg-red-soft text-[#a01717]"
          }`}
        >
          {message.ok ? "✅ " : "⛔ "}
          {message.text}
        </div>
      ) : null}

      <Panel
        title={`${users.length} tài khoản`}
        hint={
          demo
            ? "dữ liệu giả lập — production đọc iam.user_profiles"
            : "iam.user_profiles · iam.role_assignments · iam.assignments"
        }
      >
        <div className="overflow-x-auto">
          <table className={tableCls.table}>
            <thead>
              <tr>
                <th className={tableCls.th}>Tên</th>
                <th className={tableCls.th}>Email</th>
                <th className={tableCls.th}>Vai trò</th>
                <th className={tableCls.th}>Phòng</th>
                <th className={tableCls.th}>Phạm vi shop</th>
                <th className={tableCls.th}>Đăng nhập cuối</th>
                <th className={tableCls.th}>Trạng thái</th>
                <th className={tableCls.th}>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const st = statusMeta(u.status);
                const edit = canEditProfile(me, u);
                const access = canChangeAccess(me, u);
                const locked = u.status === "suspended";
                const lock = locked ? canUnlock(me, u) : canLock(me, u);
                return (
                  <tr key={u.userId} className={locked ? "bg-red-soft/40" : undefined}>
                    <td className={`${tableCls.td} font-bold`}>
                      {u.displayName}
                      {u.isSelf ? (
                        <span className="ml-1.5 rounded-full bg-blue-soft px-1.5 py-0.5 text-[10.5px] font-extrabold text-[#1e40af]">
                          bạn
                        </span>
                      ) : null}
                    </td>
                    <td className={tableCls.td}>
                      {u.email}
                      {u.phone ? <div className="text-[11.5px] text-soft">{u.phone}</div> : null}
                    </td>
                    <td className={tableCls.td}>
                      <Chip tone="blue">{roleLabel(u.role)}</Chip>
                      <div className="mt-0.5 text-[11px] text-soft">cấp {u.roleLevel}</div>
                    </td>
                    <td className={tableCls.td}>{u.department || "—"}</td>
                    <td className={tableCls.td}>{scopeLabel(u)}</td>
                    <td className={tableCls.td} title={u.lastLoginAt ?? undefined}>
                      {relativeTime(u.lastLoginAt ?? u.lastSignInAt)}
                    </td>
                    <td className={tableCls.td}>
                      <Chip tone={st.tone}>{st.label}</Chip>
                    </td>
                    <td className={tableCls.td}>
                      <div className="flex gap-1.5">
                        <RowButton
                          label="Sửa"
                          enabled={edit.ok}
                          reason={edit.reason}
                          onClick={() => openEditor("edit", u.userId)}
                          active={editor?.mode === "edit" && editor.userId === u.userId}
                        />
                        <RowButton
                          label="Quyền"
                          enabled={access.ok}
                          reason={access.reason}
                          onClick={() => openEditor("access", u.userId)}
                          active={editor?.mode === "access" && editor.userId === u.userId}
                        />
                        <RowButton
                          label={locked ? "Mở khóa" : "Khóa"}
                          enabled={lock.ok}
                          reason={lock.reason}
                          danger={!locked}
                          good={locked}
                          onClick={() => openEditor("lock", u.userId)}
                          active={editor?.mode === "lock" && editor.userId === u.userId}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
              {users.length === 0 ? (
                <tr>
                  <td className={`${tableCls.td} text-soft`} colSpan={8}>
                    Chưa có hồ sơ người dùng nào trong <code>iam.user_profiles</code>.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Panel>

      {editor && target ? (
        <div className="mt-4">
          {editor.mode === "edit" ? (
            <EditForm
              demo={demo}
              user={target}
              onDone={(ok, text) => {
                setMessage({ ok, text });
                if (ok) setEditor(null);
              }}
            />
          ) : null}
          {editor.mode === "access" ? (
            <AccessForm
              demo={demo}
              user={target}
              me={me}
              departments={departments}
              shops={shops}
              onDone={(ok, text) => {
                setMessage({ ok, text });
                if (ok) setEditor(null);
              }}
            />
          ) : null}
          {editor.mode === "lock" ? (
            <LockForm
              demo={demo}
              user={target}
              onDone={(ok, text) => {
                setMessage({ ok, text });
                if (ok) setEditor(null);
              }}
              onCancel={() => setEditor(null)}
            />
          ) : null}
        </div>
      ) : null}

      <Panel
        title="Nhật ký thao tác quản trị"
        hint={demo ? "trống ở chế độ demo" : "iam.audit_logs · module iam (append-only)"}
      >
        {audit.length === 0 ? (
          <p className="text-[12.5px] text-soft">
            {demo
              ? "Chế độ demo không có nhật ký thật. Khi chạy Supabase, mọi thao tác mời/sửa/khóa/cấp quyền được ghi tại đây."
              : "Chưa có thao tác quản trị nào được ghi."}
          </p>
        ) : (
          <ul className="divide-y divide-[#f0f2f6]">
            {audit.map((a) => (
              <li key={a.id} className="py-2 text-[12.5px]">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone={a.result === "ok" ? "green" : "red"}>
                    {auditActionLabel(a.action)}
                  </Chip>
                  <b>{a.entity ?? "—"}</b>
                  <span className="text-soft">
                    bởi {a.actorName ?? a.actorEmail ?? "không rõ"} · {relativeTime(a.createdAt)}
                  </span>
                </div>
                <div className="mt-1 text-[12px] text-muted">
                  {auditDiff(a.beforeValue, a.afterValue)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <RoleMatrix />
    </>
  );
}

/* --------------------------------------------------------------- nút trong bảng -- */

function RowButton({
  label,
  enabled,
  reason,
  onClick,
  active,
  danger,
  good,
}: {
  label: string;
  enabled: boolean;
  reason?: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  good?: boolean;
}) {
  const base = "h-7 rounded-md border px-2 text-[11px] font-bold transition";
  const cls = !enabled
    ? "cursor-not-allowed border-dashed border-line text-soft"
    : active
      ? "border-accent bg-accent text-white"
      : danger
        ? "border-red/50 text-red hover:bg-red-soft"
        : good
          ? "border-green/50 text-[#0b7a55] hover:bg-green-soft"
          : "border-line text-muted hover:border-accent hover:text-accent-ink";
  return (
    <button
      type="button"
      disabled={!enabled}
      title={enabled ? label : (reason ?? "Không đủ quyền")}
      onClick={onClick}
      className={`${base} ${cls}`}
    >
      {label}
    </button>
  );
}

/* ---------------------------------------------------------------- hộp Sửa ------ */

function EditForm({
  demo,
  user,
  onDone,
}: {
  demo: boolean;
  user: AdminUser;
  onDone: (ok: boolean, text: string) => void;
}) {
  const [name, setName] = useState(user.displayName);
  const [phone, setPhone] = useState(user.phone ?? "");
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      if (demo) {
        onDone(true, "Chế độ demo: đã mô phỏng lưu (không ghi DB).");
        return;
      }
      const r = await updateProfileAction({ userId: user.userId, displayName: name, phone });
      onDone(r.ok, r.message);
    });
  }

  return (
    <form onSubmit={submit} className="rounded-[13px] border border-line bg-card px-4 py-3.5">
      <div className="text-[13.5px] font-extrabold">
        Sửa hồ sơ · <span className="text-muted">{user.email}</span>
      </div>
      <p className="mt-1 text-[12px] text-soft">
        Ghi vào <code>iam.user_profiles</code> (tên · điện thoại) và lưu vết vào{" "}
        <code>iam.audit_logs</code>. Vai trò/phạm vi shop đổi ở nút <b>Quyền</b>; trạng thái
        đổi ở nút <b>Khóa</b>.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-[12px] font-bold text-muted">
          Họ tên
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 block h-9 w-56 rounded-md border border-line bg-white px-2.5 text-[13px] font-semibold text-ink"
          />
        </label>
        <label className="text-[12px] font-bold text-muted">
          Điện thoại
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+84 …"
            className="mt-1 block h-9 w-44 rounded-md border border-line bg-white px-2.5 text-[13px] font-semibold text-ink"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="h-9 rounded-full bg-accent px-4 text-[12.5px] font-extrabold text-white transition hover:bg-accent-ink disabled:opacity-60"
        >
          {pending ? "Đang lưu…" : "Lưu hồ sơ"}
        </button>
      </div>
    </form>
  );
}

/* --------------------------------------------------------------- hộp Quyền ----- */

function AccessForm({
  demo,
  user,
  me,
  departments,
  shops,
  onDone,
}: {
  demo: boolean;
  user: AdminUser;
  me: AdminUser | null;
  departments: DepartmentOption[];
  shops: ShopOption[];
  onDone: (ok: boolean, text: string) => void;
}) {
  const actorLevel = me?.roleLevel ?? 100;
  const role0 = defaultAssignableRole(actorLevel, user.role);
  const [role, setRole] = useState(role0);
  const [deptCode, setDeptCode] = useState(user.departmentCode || "");
  const [picked, setPicked] = useState<string[]>(user.shopIds);
  const [pending, startTransition] = useTransition();

  const options = assignableRoles(actorLevel);
  const needDept = DEPT_REQUIRED_ROLES.has(role);
  const isSuper = role === "super_admin";

  function toggle(id: string) {
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (needDept && !deptCode) {
      onDone(false, "Vai trò vận hành phải chọn phòng ban.");
      return;
    }
    if (!isSuper && picked.length === 0 && READ_ONLY_ROLES.has(role) === false) {
      onDone(
        false,
        "Chưa chọn shop nào: người này sẽ vào hệ thống nhưng KHÔNG thấy dữ liệu shop nào (RLS chặn toàn bộ).",
      );
      return;
    }
    startTransition(async () => {
      if (demo) {
        onDone(true, "Chế độ demo: đã mô phỏng cấp quyền (không ghi DB).");
        return;
      }
      const r = await setAccessAction({
        userId: user.userId,
        role,
        departmentCode: needDept ? deptCode : null,
        shopIds: isSuper ? [] : picked,
      });
      onDone(r.ok, r.message);
    });
  }

  return (
    <form onSubmit={submit} className="rounded-[13px] border border-line bg-card px-4 py-3.5">
      <div className="text-[13.5px] font-extrabold">
        Phân quyền · <span className="text-muted">{user.displayName}</span>{" "}
        <span className="text-soft">({user.email})</span>
      </div>
      <p className="mt-1 text-[12px] text-soft">
        Ghi vào <code>iam.role_assignments</code> + <code>iam.assignments</code> (thay danh sách
        shop hiện có bằng danh sách chọn bên dưới). Chỉ gán được vai trò <b>thấp hơn cấp của
        bạn</b> ({actorLevel}); DB từ chối nếu bạn tự nâng quyền.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-[12px] font-bold text-muted">
          Vai trò
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="mt-1 block h-9 w-48 rounded-md border border-line bg-white px-2 text-[13px] font-semibold text-ink"
          >
            {options.length === 0 ? <option value="">(không có vai trò nào thấp hơn bạn)</option> : null}
            {options.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[12px] font-bold text-muted">
          Phòng ban {needDept ? <span className="text-red">*</span> : null}
          <select
            value={deptCode}
            onChange={(e) => setDeptCode(e.target.value)}
            disabled={!needDept}
            className="mt-1 block h-9 w-52 rounded-md border border-line bg-white px-2 text-[13px] font-semibold text-ink disabled:bg-bg disabled:text-soft"
          >
            <option value="">— chọn phòng —</option>
            {departments.map((d) => (
              <option key={d.id} value={d.code}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={pending || options.length === 0}
          className="h-9 rounded-full bg-accent px-4 text-[12.5px] font-extrabold text-white transition hover:bg-accent-ink disabled:opacity-60"
        >
          {pending ? "Đang lưu…" : "Lưu quyền"}
        </button>
      </div>

      <div className="mt-3">
        <div className="text-[12px] font-bold text-muted">
          Shop được gán{" "}
          <span className="font-semibold text-soft">
            ({picked.length}/{shops.length} đã chọn
            {isSuper ? " — super_admin không cần gán shop" : ""})
          </span>
        </div>
        <div
          className={`mt-1.5 grid max-h-56 grid-cols-1 gap-1 overflow-y-auto rounded-md border border-line p-2 sm:grid-cols-2 lg:grid-cols-3 ${
            isSuper ? "opacity-50" : ""
          }`}
        >
          {shops.map((s) => (
            <label key={s.id} className="flex items-center gap-1.5 text-[12px] font-semibold">
              <input
                type="checkbox"
                checked={picked.includes(s.id)}
                disabled={isSuper}
                onChange={() => toggle(s.id)}
              />
              {s.shop}
            </label>
          ))}
          {shops.length === 0 ? (
            <span className="text-[12px] text-soft">Chưa đọc được danh sách shop.</span>
          ) : null}
        </div>
      </div>
    </form>
  );
}

/* --------------------------------------------------------------- hộp Khóa ------ */

function LockForm({
  demo,
  user,
  onDone,
  onCancel,
}: {
  demo: boolean;
  user: AdminUser;
  onDone: (ok: boolean, text: string) => void;
  onCancel: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const locked = user.status === "suspended";

  function confirm() {
    startTransition(async () => {
      if (demo) {
        onDone(true, "Chế độ demo: đã mô phỏng (không ghi DB).");
        return;
      }
      const r = await setLockAction({ userId: user.userId, locked: !locked });
      onDone(r.ok, r.message);
    });
  }

  return (
    <div
      className={`rounded-[13px] border-2 px-4 py-3.5 ${
        locked ? "border-amber/50 bg-amber-soft" : "border-red/40 bg-red-soft"
      }`}
    >
      <div className="text-[13.5px] font-extrabold">
        {locked ? "Mở khóa tài khoản" : "Khóa tài khoản"} ·{" "}
        <span className="text-muted">{user.displayName}</span>{" "}
        <span className="text-soft">({user.email})</span>
      </div>
      <p className="mt-1 text-[12.5px] text-[#7a4a00]">
        {locked ? (
          <>
            Mở khóa sẽ <b>phục hồi quyền theo vai trò hiện có</b> (
            {roleLabel(user.role)}
            {user.shopCount ? ` · ${user.shopCount} shop` : ""}). Người này chỉ làm việc được
            nếu vai trò + shop vẫn còn đúng.
          </>
        ) : (
          <>
            Khóa là thao tác <b>THẬT</b>: ngay sau khi khóa, tài khoản này mất quyền ở tầng dữ
            liệu (RLS) trên toàn bộ hệ thống — không chỉ ẩn giao diện. Họ vẫn đăng nhập được
            nhưng thấy trắng dữ liệu (đúng chủ đích: cắt quyền ngay, không đợi token hết hạn).
            Mọi thao tác được ghi <code>iam.audit_logs</code>.
          </>
        )}
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={confirm}
          disabled={pending}
          className={`h-9 rounded-full px-4 text-[12.5px] font-extrabold text-white transition disabled:opacity-60 ${
            locked ? "bg-amber hover:brightness-95" : "bg-red hover:brightness-95"
          }`}
        >
          {pending ? "Đang lưu…" : locked ? "Xác nhận mở khóa" : "Xác nhận khóa"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-9 rounded-full border border-line bg-card px-4 text-[12.5px] font-bold text-muted"
        >
          Hủy
        </button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------- bảng RBAC tĩnh ------ */

function RoleMatrix() {
  return (
    <Panel title="Phân cấp vai trò (RBAC)" hint="khớp iam.role_level() trong 0022_user_admin.sql">
      <div className="grid grid-cols-1 gap-2 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
        {[
          ["Super Admin", "Toàn hệ thống VEXIM", "Gán mọi vai trò trừ ngang cấp", 100],
          ["Org Admin", "1 doanh nghiệp (nhóm shop)", "Gán dept-lead/operator/analyst/client", 80],
          ["Dept Lead", "Trưởng phòng", "Duyệt thao tác rủi ro · gán operator/analyst TRONG phòng mình", 50],
          ["Operator", "Nhân viên vận hành", "Không gán quyền cho ai", 30],
          ["Analyst", "Chỉ đọc", "Xuất báo cáo", 20],
          ["Client Viewer", "Khách hàng", "Chỉ đọc shop của mình", 10],
        ].map(([role, desc, canAssign, lvl]) => (
          <div key={role} className="rounded-[10px] border border-line px-3 py-2.5">
            <div className="flex items-center justify-between">
              <div className="font-bold">{role}</div>
              <span className="rounded-full bg-bg px-2 py-0.5 text-[10.5px] font-extrabold text-soft">
                level {lvl}
              </span>
            </div>
            <div className="mt-0.5 text-[12px] text-soft">{desc}</div>
            <div className="mt-1 text-[11.5px] text-muted">▸ {canAssign}</div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11.5px] font-semibold text-soft">
        Luật do DATABASE thi công (<code>public.vexim_admin_*</code>, migration 0022): không ai tự
        nâng quyền hay tự khóa mình · không sửa được người cấp cao hơn · vai trò vận hành phải
        thuộc một phòng ban · khóa tài khoản = mất quyền thật ở tầng RLS · mọi thay đổi ghi
        <code> iam.audit_logs</code> (không xoá được).
      </p>
    </Panel>
  );
}
