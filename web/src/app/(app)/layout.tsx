import type { ReactNode } from "react";
import AppShell from "@/components/shell/AppShell";
import { requireSession } from "@/lib/auth/session";
import BellWithData from "@/components/notifications/BellWithData";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();

  return (
    <AppShell session={session} bellSlot={<BellWithData session={session} />}>
      {children}
    </AppShell>
  );
}
