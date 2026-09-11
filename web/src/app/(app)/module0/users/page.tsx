import { Chip, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { users } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo"];

export default async function UsersPage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  return (
    <>
      <PageHeader
        title="Người dùng & phân quyền"
        sub="iam.user_profiles · role_assignments · assignments"
        desc="Vai trò hệ thống (RBAC) + gán user ↔ shop ↔ module. Khi vận hành thật: đăng nhập qua Supabase Auth, phân quyền thực thi bằng RLS."
      />
      <Panel title="Danh sách người dùng">
        <table className={tableCls.table}>
          <thead>
            <tr>
              <th className={tableCls.th}>Tên</th>
              <th className={tableCls.th}>Email</th>
              <th className={tableCls.th}>Vai trò</th>
              <th className={tableCls.th}>Phòng</th>
              <th className={tableCls.th}>Phạm vi shop</th>
              <th className={tableCls.th}>Trạng thái</th>
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
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel title="Mô hình 6 vai trò (khớp migration 0001)">
        <div className="grid grid-cols-1 gap-2 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
          {[
            ["Super Admin", "Toàn hệ thống VEXIM"],
            ["Org Admin", "1 khách hàng (nhóm shop)"],
            ["Dept Lead", "Trưởng phòng — duyệt thao tác rủi ro"],
            ["Operator", "Chỉ shop được gán · đọc + ghi theo module"],
            ["Analyst / Viewer", "Chỉ đọc, xuất báo cáo"],
            ["Client Viewer", "Khách hàng — chỉ đọc shop của mình"],
          ].map(([role, desc]) => (
            <div key={role} className="rounded-[10px] border border-line px-3 py-2.5">
              <div className="font-bold">{role}</div>
              <div className="text-[12px] text-soft">{desc}</div>
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}
