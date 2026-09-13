"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  activeHrefFor,
  badgeOf,
  navFor,
  type NavBadges,
  type PersonaKey,
} from "@/lib/roles";

/**
 * Menu trái.
 *
 *   • CHỈ MỘT mục sáng: chọn theo href KHỚP DÀI NHẤT (`activeHrefFor`) — trước đây
 *     dùng `startsWith` nên ở `/ppc/search-terms` cả "Quảng cáo (PPC)" lẫn
 *     "Search term & chặn (A3)" cùng sáng cam.
 *   • Badge số chỉ hiện khi có SỐ THẬT từ DB (`readNavBadges` truyền xuống prop);
 *     không có query ⇒ không hiện gì. Không còn số mock cứng.
 */
export default function Sidebar({
  persona,
  badges,
}: {
  persona: PersonaKey;
  badges?: NavBadges;
}) {
  const pathname = usePathname();
  const groups = navFor(persona);
  const activeHref = activeHrefFor(
    groups.flatMap((g) => g.items.map((it) => it.href)),
    pathname ?? "",
  );

  return (
    <aside className="border-r border-line bg-card px-2.5 py-3.5">
      <nav>
        {groups.map((g) => (
          <div key={g.group}>
            <div className="px-3 pb-1.5 pt-3 text-[10.5px] font-extrabold uppercase tracking-widest text-soft">
              {g.group}
            </div>
            {g.items.map((it) => {
              const active = it.href === activeHref;
              const badge = badgeOf(badges, it.href);
              return (
                <Link
                  key={it.href}
                  href={it.href}
                  aria-current={active ? "page" : undefined}
                  className={`mb-0.5 flex items-center gap-2.5 rounded-[9px] px-3 py-2 text-[13.5px] font-semibold ${
                    active
                      ? "bg-accent-soft text-accent-ink"
                      : "text-muted hover:bg-bg"
                  }`}
                >
                  <span className="w-5 text-center">{it.icon}</span>
                  {it.label}
                  {badge !== null ? (
                    <span
                      className="ml-auto rounded-full bg-red-soft px-[7px] py-px text-[11px] font-extrabold text-red"
                      title="Số việc đang chờ xử lý — đếm từ DB theo đúng bộ lọc của màn hình"
                    >
                      {badge > 99 ? "99+" : badge}
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
        database, không chỉ ẩn UI. Số đỏ cạnh menu là số THẬT đang chờ xử lý
        (không có số thì nghĩa là không có việc).
      </div>
    </aside>
  );
}
