"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { NotificationItem } from "@/lib/types";

const toneBg: Record<string, string> = {
  red: "bg-red-soft",
  amber: "bg-amber-soft",
  green: "bg-green-soft",
  error: "bg-red-soft",
  warning: "bg-amber-soft",
  info: "bg-green-soft",
  success: "bg-green-soft",
};
const toneDot: Record<string, string> = {
  red: "bg-red",
  amber: "bg-amber",
  green: "bg-green",
  error: "bg-red",
  warning: "bg-amber",
  info: "bg-green",
  success: "bg-green",
};

export default function BellDropdown({
  initial,
  unreadCount: _u,
  live = false,
  loading = false,
  onOpenChange,
  onRefresh,
}: {
  initial: NotificationItem[];
  unreadCount?: number;
  live?: boolean;
  loading?: boolean;
  onOpenChange?: (open: boolean) => void;
  onRefresh?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>(initial);
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);

  // Sync khi initial thay đổi (re-fetch từ BellWithData)
  useEffect(() => {
    setItems(initial);
  }, [initial]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  function setOpenBoth(v: boolean) {
    setOpen(v);
    onOpenChange?.(v);
  }

  const unread = items.filter((i) => !i.read).length;

  function markAllRead() {
    setItems((prev) => prev.map((i) => ({ ...i, read: true })));
    // Server-side mark read được handle trong onOpenChange (khi mở dropdown)
  }

  function openItem(it: NotificationItem) {
    setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, read: true } : x)));
    setOpenBoth(false);
    if (it.href) router.push(it.href);
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpenBoth(!open)}
        className="relative grid h-[34px] w-[34px] place-items-center rounded-[9px] border border-line bg-card text-[15px] transition hover:border-accent hover:bg-accent-soft"
        aria-label={`Cảnh báo · ${unread} chưa đọc`}
        aria-expanded={open}
      >
        🔔
        {live ? (
          <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-green ring-2 ring-card" title="DB live" />
        ) : null}
        {unread > 0 ? (
          <span className="absolute -right-1.5 -top-1.5 min-w-[18px] rounded-full bg-red px-1.5 py-0.5 text-center text-[10.5px] font-extrabold leading-none text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 top-[42px] z-50 w-[380px] max-w-[92vw] overflow-hidden rounded-[13px] border border-line bg-card shadow-xl">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-[13.5px] font-extrabold">Thông báo</span>
              {live ? (
                <span className="rounded-full bg-green-soft px-2 py-0.5 text-[10px] font-extrabold text-[#0b7a55]">● LIVE DB</span>
              ) : (
                <span className="rounded-full bg-amber-soft px-2 py-0.5 text-[10px] font-extrabold text-[#8c5a00]">DEMO</span>
              )}
              {loading ? (
                <span className="text-[11px] text-soft">đang tải…</span>
              ) : null}
            </div>
            <div className="flex items-center gap-3">
              {onRefresh ? (
                <button onClick={onRefresh} title="Tải lại"
                  className="text-[11px] font-bold text-muted hover:text-accent-ink">
                  ↻
                </button>
              ) : null}
              <button onClick={markAllRead}
                className="text-[11.5px] font-bold text-blue underline underline-offset-2 hover:text-accent-ink">
                Đánh dấu đã đọc
              </button>
            </div>
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {items.length === 0 ? (
              <div className="px-4 py-10 text-center text-[13px] text-soft">
                <div className="mb-2 text-3xl">🎉</div>
                Không có thông báo mới.
              </div>
            ) : (
              items.map((it) => {
                const Content = (
                  <div className="flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-bg">
                    <span
                      className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg ${toneBg[it.tone] ?? "bg-bg"} text-[15px]`}
                    >
                      {it.icon}
                    </span>
                    <span className="mt-[3px] h-2 w-2 shrink-0 rounded-full">
                      {!it.read ? (
                        <span className={`block h-2 w-2 rounded-full ${toneDot[it.tone] ?? "bg-accent"}`} />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`block text-[13px] font-bold ${it.read ? "text-muted" : ""}`}>
                        {it.title}
                      </span>
                      <span className="mt-0.5 block text-[12px] text-soft">{it.detail}</span>
                      <span className="mt-1 block text-[11px] text-soft">{it.time}</span>
                    </span>
                  </div>
                );
                const href = it.href;
                return href ? (
                  <Link key={it.id} href={href} onClick={() => openItem(it)} className="block">
                    {Content}
                  </Link>
                ) : (
                  <button key={it.id} onClick={() => openItem(it)} className="block w-full">
                    {Content}
                  </button>
                );
              })
            )}
          </div>
          <div className="border-t border-line px-4 py-2 text-center">
            <Link
              href="/module4/account-health"
              onClick={() => setOpenBoth(false)}
              className="text-[12px] font-bold text-muted hover:text-accent-ink"
            >
              Xem tất cả cảnh báo & sức khỏe hệ thống →
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
