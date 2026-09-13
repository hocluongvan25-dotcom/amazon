import { NoAccess, PageHeader, Panel } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { readUsersSnapshot } from "@/lib/data/users-admin";
import type { PersonaKey } from "@/lib/roles";
import { DEMO_DEPARTMENTS, DEMO_SHOPS, DEMO_USERS } from "./demo-users";
import { UsersBoard } from "./UsersBoard";

/**
 * Người dùng & phân quyền (Module 0).
 *
 * HAI CHẾ ĐỘ, MỘT GIAO DIỆN:
 *   • SUPABASE MODE: bảng đọc `public.vexim_admin_users()` — RPC security definer
 *     tự kiểm `iam.is_user_admin()` và TỪ CHỐI người không phải admin. Quyền
 *     quyết định ở DB, không ở `persona` của web (persona trong supabase mode
 *     hiện luôn là "ceo" — xem TODO Tier 1 ở `lib/auth/session.ts`, nên KHÔNG được
 *     dùng nó để chặn trang này).
 *   • DEMO MODE (chưa cấu hình Supabase): 5 dòng GIẢ LẬP (`@vexim.example`) để xem
 *     giao diện; ghi chú demo hiện rõ trên đầu bảng. Danh sách nhân viên giả cũ
 *     trong `mock.ts` đã bị xoá (13/09/2026) vì làm người dùng thật hiểu sai.
 */
const DEMO_ALLOWED: PersonaKey[] = ["ceo"];

export default async function UsersPage() {
  const session = await requireSession();

  if (session.mode === "supabase") {
    const snapshot = await readUsersSnapshot();
    if (!snapshot.ok) {
      return (
        <>
          <PageHeader
            title="Người dùng & phân quyền"
            sub="iam.user_profiles · iam.role_assignments"
            desc="Danh sách người dùng chỉ dành cho Super Admin / Org Admin (chặn ở tầng database)."
          />
          <NoAccess />
          <Panel title="Vì sao bị chặn" hint="thông điệp từ database">
            <p className="text-[12.5px] text-muted">{snapshot.message}</p>
            <p className="mt-2 text-[12px] text-soft">
              Quyền xem/sửa người dùng do <code>iam.is_user_admin()</code> quyết định trong
              migration 0022 — không phải do giao diện ẩn nút.
            </p>
          </Panel>
        </>
      );
    }

    return (
      <>
        <PageHeader
          title="Người dùng & phân quyền"
          sub={`${snapshot.users.length} hồ sơ thật · iam.user_profiles · iam.role_assignments`}
          desc="Vai trò (RBAC) + gán người ↔ shop ↔ module. Sửa · Quyền · Khóa đều là thao tác thật, ghi iam.audit_logs; khóa tài khoản cắt quyền ngay ở tầng RLS."
        />
        <UsersBoard
          demo={false}
          users={snapshot.users}
          me={snapshot.me}
          departments={snapshot.departments}
          shops={snapshot.shops}
          audit={snapshot.audit}
        />
      </>
    );
  }

  if (!DEMO_ALLOWED.includes(session.persona)) return <NoAccess />;

  return (
    <>
      <PageHeader
        title="Người dùng & phân quyền"
        sub={`${DEMO_USERS.length} dòng giả lập (chế độ demo) · production đọc iam.user_profiles`}
        desc="Bản xem trước giao diện: Sửa · Quyền · Khóa. Khi cấu hình Supabase, bảng đọc dữ liệu THẬT và 3 nút gọi RPC có kiểm quyền + ghi audit."
      />
      <UsersBoard
        demo
        users={DEMO_USERS}
        me={DEMO_USERS.find((u) => u.isSelf) ?? null}
        departments={DEMO_DEPARTMENTS}
        shops={DEMO_SHOPS}
        audit={[]}
      />
    </>
  );
}
