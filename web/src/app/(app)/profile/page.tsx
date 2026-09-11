import { NoAccess, PageHeader } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import ProfileClient from "./ProfileClient";

/**
 * Trang cá nhân — mọi role đều truy cập được.
 */
export default async function ProfilePage() {
  const session = await requireSession();
  // Mọi role đều xem được trang cá nhân (không check ALLOWED)
  void NoAccess;

  return (
    <>
      <PageHeader
        title="Trang cá nhân"
        desc="Thông tin tài khoản, bảo mật, và tùy chọn cá nhân. Chỉ bạn và Admin mới xem được trang này."
      />
      <ProfileClient session={session} />
    </>
  );
}
