import type { ReactNode } from "react";
import AppShell from "@/components/shell/AppShell";
import { requireSession } from "@/lib/auth/session";
import { readNavBadges } from "@/lib/data/nav-badges";
import { resolveShopScope, type ShopScope } from "@/lib/data/shop-scope";
import { touchLogin } from "@/lib/data/users-write";
import BellWithData from "@/components/notifications/BellWithData";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  // ĐIỂM DANH ĐĂNG NHẬP (Module 0 — migration 0022): hồ sơ `invited` chuyển
  // `active`, ghi `last_login_at` để cột "Đăng nhập cuối" ở màn Người dùng có
  // nghĩa. RPC tự bỏ qua (không UPDATE) nếu vừa ghi trong 5 phút nên không tạo
  // một lượt ghi mỗi lần tải trang. Lỗi ở đây KHÔNG được làm sập trang.
  if (session.mode === "supabase") await touchLogin().catch(() => null);

  // Badge menu = SỐ THẬT đang chờ xử lý (đếm ở DB, có RLS). Chế độ DEMO hoặc khi
  // query lỗi ⇒ không có badge nào (thà trống còn hơn số sai — xem nav-badges.ts).
  const badges = session.mode === "supabase" ? await readNavBadges().catch(() => ({})) : {};

  // PHẠM VI SHOP cho bộ chọn ở Topbar (sự cố 16/09: control này trước đây là select
  // trang trí, không đọc DB nên không chọn được shop nào). DEMO MODE không có DB
  // ⇒ danh sách rỗng và bộ chọn tự nói rõ lý do, không im lặng.
  const shopScope: ShopScope =
    session.mode === "supabase"
      ? await resolveShopScope().catch(() => ({ shops: [], shopId: null, shop: null }))
      : { shops: [], shopId: null, shop: null };

  return (
    <AppShell
      session={session}
      bellSlot={<BellWithData session={session} />}
      badges={badges}
      shopScope={shopScope}
    >
      {children}
    </AppShell>
  );
}
