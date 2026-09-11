"use client";

import Link from "next/link";
import { PERSONAS, type PersonaKey } from "@/lib/roles";
import type { Session } from "@/lib/auth/session";
import BellDropdown from "@/components/notifications/BellDropdown";
import type { NotificationItem } from "@/lib/types";

export default function Topbar({
  session,
  notifications,
  unreadCount,
}: {
  session: Session;
  notifications: NotificationItem[];
  unreadCount: number;
}) {
  const persona = PERSONAS[session.persona];

  function switchPersona(next: string) {
    // Chỉ dùng ở DEMO MODE — kiểm chứng phân quyền theo phòng
    document.cookie = `demo_role=${next}; path=/; max-age=${60 * 60 * 24 * 7}`;
    window.location.href = "/dashboard";
  }

  return (
    <div className="sticky top-0 z-40 border-b border-line bg-card/95 backdrop-blur">
      <div className="flex h-[58px] items-center gap-2.5 overflow-x-auto px-4">
        <Link href="/dashboard" className="flex shrink-0 items-center gap-2 text-[15px] font-extrabold">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-ink text-accent">V</span>
          VEXIM&nbsp;Ops
        </Link>

        {session.mode === "demo" ? (
          <select
            value={session.persona}
            onChange={(e) => switchPersona(e.target.value)}
            title="Bộ mô phỏng vai trò (DEMO MODE)"
            className="min-w-[250px] shrink-0 rounded-[9px] border border-accent bg-accent-soft px-2.5 py-[7px] text-[12.5px] font-extrabold text-accent-ink"
          >
            {(Object.keys(PERSONAS) as PersonaKey[]).map((k) => (
              <option key={k} value={k}>
                👁 Đang xem: {PERSONAS[k].label}
              </option>
            ))}
          </select>
        ) : (
          <span className="shrink-0 rounded-[9px] border border-accent bg-accent-soft px-2.5 py-[7px] text-[12.5px] font-extrabold text-accent-ink">
            {persona.label}
          </span>
        )}

        <select className="shrink-0 rounded-[9px] border border-line bg-card px-2.5 py-[7px] text-[12.5px] font-semibold text-muted">
          <option>{persona.org}</option>
        </select>
        <select className="shrink-0 rounded-[9px] border border-line bg-card px-2.5 py-[7px] text-[12.5px] font-semibold text-muted">
          <option>{persona.shop}</option>
        </select>
        <select className="hidden shrink-0 rounded-[9px] border border-line bg-card px-2.5 py-[7px] text-[12.5px] font-semibold text-muted md:block">
          <option>Hôm qua</option>
          <option>7 ngày</option>
          <option>30 ngày</option>
        </select>

        <div className="ml-auto flex shrink-0 items-center gap-2.5">
          <BellDropdown initial={notifications} unreadCount={unreadCount} />
          <Link
            href="/profile"
            title="Trang cá nhân"
            className="grid h-[34px] w-[34px] place-items-center rounded-full bg-[#dfe6f3] text-[12px] font-extrabold text-[#3c4a63] transition hover:ring-2 hover:ring-accent"
          >
            {persona.avatar}
          </Link>
        </div>
      </div>

      <div className="flex items-center gap-2.5 border-t border-line bg-blue-soft px-4 py-2 text-[12.5px] font-semibold text-[#1e3a8a]">
        {session.mode === "demo" ? (
          <>
            🔒 Vai trò: <b className="text-blue">{persona.label}</b> — {persona.scope} ·{" "}
            <span className="text-soft">DEMO MODE</span>
          </>
        ) : (
          <>
            🔒 Đăng nhập: <b className="text-blue">{session.email ?? persona.label}</b> ·{" "}
            <span className="text-soft">SUPABASE MODE</span>
          </>
        )}
      </div>
    </div>
  );
}
