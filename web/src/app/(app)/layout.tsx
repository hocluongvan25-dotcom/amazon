import type { ReactNode } from "react";
import AppShell from "@/components/shell/AppShell";
import { requireSession } from "@/lib/auth/session";
import { readNavBadges } from "@/lib/data/nav-badges";
import BellWithData from "@/components/notifications/BellWithData";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  // Badge menu = SỐ THẬT đang chờ xử lý (đếm ở DB, có RLS). Chế độ DEMO hoặc khi
  // query lỗi ⇒ không có badge nào (thà trống còn hơn số sai — xem nav-badges.ts).
  const badges = session.mode === "supabase" ? await readNavBadges().catch(() => ({})) : {};

  return (
    <AppShell session={session} bellSlot={<BellWithData session={session} />} badges={badges}>
      {children}
    </AppShell>
  );
}
