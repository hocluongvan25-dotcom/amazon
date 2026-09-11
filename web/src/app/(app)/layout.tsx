import type { ReactNode } from "react";
import AppShell from "@/components/shell/AppShell";
import { requireSession } from "@/lib/auth/session";
import { notificationsByPersona } from "@/lib/data/mock";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();

  // Ở DEMO MODE: notifications theo persona; SUPABASE MODE sẽ query từ DB
  const notif = notificationsByPersona[session.persona] ?? [];
  const unread = notif.filter((n) => !n.read).length;

  return (
    <AppShell session={session} notifications={notif} unreadCount={unread}>
      {children}
    </AppShell>
  );
}
