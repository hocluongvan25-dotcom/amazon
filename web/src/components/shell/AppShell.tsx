import type { ReactNode } from "react";
import Sidebar from "@/components/shell/Sidebar";
import Topbar from "@/components/shell/Topbar";
import type { Session } from "@/lib/auth/session";

export default function AppShell({
  session,
  children,
}: {
  session: Session;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <Topbar session={session} />
      <div className="mx-auto grid max-w-[1440px] grid-cols-1 lg:grid-cols-[242px_1fr]">
        <div className="hidden lg:block">
          <Sidebar persona={session.persona} />
        </div>
        <main className="max-w-[1150px] px-6 pb-10 pt-6">{children}</main>
      </div>
    </div>
  );
}
