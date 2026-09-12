import { NoAccess, PageHeader } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import type { PersonaKey } from "@/lib/roles";
import NewUserForm from "./NewUserForm";

const ALLOWED: PersonaKey[] = ["ceo"];

export default async function NewUserPage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  return (
    <>
      <PageHeader
        title="Thêm người dùng"
        sub="iam.user_profiles · iam.role_assignments"
        desc="Tạo tài khoản nhân viên và gán vai trò/phòng/shop. Quy tắc: chỉ role cấp CAO hơn mới gán được role cấp dưới; mọi thay đổi ghi audit_log."
      />
      <div className="mb-4">
        <a
          href="/module0/users"
          className="rounded-full border border-line bg-card px-4 py-1.5 text-[12.5px] font-bold text-muted transition hover:border-accent hover:text-accent-ink"
        >
          ← Danh sách người dùng
        </a>
      </div>
      <NewUserForm />
    </>
  );
}
