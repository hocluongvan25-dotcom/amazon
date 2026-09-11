"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navFor, type PersonaKey } from "@/lib/roles";

export default function Sidebar({ persona }: { persona: PersonaKey }) {
  const pathname = usePathname();
  const groups = navFor(persona);

  return (
    <aside className="border-r border-line bg-card px-2.5 py-3.5">
      <nav>
        {groups.map((g) => (
          <div key={g.group}>
            <div className="px-3 pb-1.5 pt-3 text-[10.5px] font-extrabold uppercase tracking-widest text-soft">
              {g.group}
            </div>
            {g.items.map((it) => {
              const active =
                pathname === it.href || pathname.startsWith(it.href + "/");
              return (
                <Link
                  key={it.href}
                  href={it.href}
                  className={`mb-0.5 flex items-center gap-2.5 rounded-[9px] px-3 py-2 text-[13.5px] font-semibold ${
                    active
                      ? "bg-accent-soft text-accent-ink"
                      : "text-muted hover:bg-bg"
                  }`}
                >
                  <span className="w-5 text-center">{it.icon}</span>
                  {it.label}
                  {typeof it.count === "number" && it.count > 0 ? (
                    <span className="ml-auto rounded-full bg-red-soft px-[7px] py-px text-[11px] font-extrabold text-red">
                      {it.count}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="mx-3 mt-4 rounded-[9px] border border-dashed border-line bg-bg px-2.5 py-2.5 text-[11.5px] text-soft">
        Mục hiển thị theo quyền vai trò — thực tế đảm bảo bằng RLS ở tầng
        database, không chỉ ẩn UI.
      </div>
    </aside>
  );
}
