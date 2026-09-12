import { Chip, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { users } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";

/**
 * Quản lý người dùng & quyền — chỉ CEO (super_admin/org_admin) được truy cập.
 * DEMO MODE: 6 user cứng theo wireframe; SUPABASE MODE: query iam.user_profiles.
 */
const ALLOWED: PersonaKey[] = ["ceo"];

export default async function UsersPage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  return (
    <>
      <PageHeader
        title="Người dùng & phân quyền"
        sub={`${users.length} tài khoản · iam.user_profiles · iam.role_assignments`}
        desc="Vai trò hệ thống (RBAC) + gán user ↔ shop ↔ module. Phân quyền thực thi bằng RLS ở tầng database — không chỉ ẩn giao diện."
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <a
          href="/module0/users/new"
          className="h-9 rounded-full bg-accent px-4 py-2 text-[12.5px] font-extrabold text-white transition hover:bg-accent-ink"
        >
          ＋ Thêm người dùng
        </a>
        <button
          disabled
          title="Mời nhân viên theo link (chuyển sang SUPABASE MODE sẽ mở)"
          className="h-9 cursor-not-allowed rounded-full border border-dashed border-line px-4 py-2 text-[12.5px] font-bold text-soft"
        >
          🔗 Mời theo link
        </button>
        <button
          disabled
          className="h-9 cursor-not-allowed rounded-full border border-dashed border-line px-4 py-2 text-[12.5px] font-bold text-soft"
        >
          ⬇ Import CSV
        </button>
      </div>

      <Panel title={`${users.length} tài khoản`} hint="Super Admin và Org Admin có thể sửa/phân quyền người khác">
        <table className={tableCls.table}>
          <thead>
            <tr>
              <th className={tableCls.th}>Tên</th>
              <th className={tableCls.th}>Email</th>
              <th className={tableCls.th}>Vai trò</th>
              <th className={tableCls.th}>Phòng</th>
              <th className={tableCls.th}>Phạm vi shop</th>
              <th className={tableCls.th}>Trạng thái</th>
              <th className={tableCls.th}>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.email}>
                <td className={`${tableCls.td} font-bold`}>{u.name}</td>
                <td className={tableCls.td}>{u.email}</td>
                <td className={tableCls.td}>
                  <Chip tone="blue">{u.role}</Chip>
                </td>
                <td className={tableCls.td}>{u.department}</td>
                <td className={tableCls.td}>{u.shops}</td>
                <td className={tableCls.td}>
                  <Chip tone={u.status === "active" ? "green" : "gray"}>
                    {u.status === "active" ? "Đang hoạt động" : "Đã mời"}
                  </Chip>
                </td>
                <td className={tableCls.td}>
                  <div className="flex gap-1.5">
                    <button
                      disabled
                      className="h-7 cursor-not-allowed rounded-md border border-dashed border-line px-2 text-[11px] font-bold text-soft"
                      title="Sửa thông tin"
                    >
                      Sửa
                    </button>
                    <button
                      disabled
                      className="h-7 cursor-not-allowed rounded-md border border-dashed border-line px-2 text-[11px] font-bold text-soft"
                      title="Phân quyền lại"
                    >
                      Quyền
                    </button>
                    <button
                      disabled
                      className="h-7 cursor-not-allowed rounded-md border border-dashed border-line px-2 text-[11px] font-bold text-red"
                      title="Khóa tài khoản"
                    >
                      Khóa
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Phân cấp vai trò (RBAC)" hint="khớp migration 0001_init.sql — session.persona bám đúng bảng này">
        <div className="grid grid-cols-1 gap-2 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
          {[
            ["Super Admin", "Toàn hệ thống VEXIM", "Có thể gán mọi role", 100],
            ["Org Admin", "1 doanh nghiệp (nhóm shop)", "Gán dept-lead/operator/analyst/client", 80],
            ["Dept Lead", "Trưởng phòng", "Duyệt thao tác rủi ro · Gán operator/analyst", 50],
            ["Operator", "Nhân viên vận hành", "Không gán quyền cho ai", 30],
            ["Analyst / Viewer", "Chỉ đọc", "Xuất báo cáo", 20],
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
          Quy tắc: chỉ role ở level CAO HƠN mới được gán/sửa role cấp dưới. Không thể tự nâng quyền
          cho chính mình. Khóa/kích hoạt tài khoản = soft delete (chuyển status disabled). Mọi thay
          đổi quyền đều ghi vào audit_log (actor + thời gian + cũ→mới).
        </p>
      </Panel>
    </>
  );
}
