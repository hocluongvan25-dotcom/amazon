/**
 * Bộ component UI dùng chung — thiết kế đúng wireframe đã duyệt.
 * (Server-safe: không dùng hook.)
 */
import type { AlertSeverity, KpiCardData, MiniItemData } from "@/lib/types";
import Link from "next/link";
import type { ReactNode } from "react";

/* ---------- Header trang ---------- */
export function PageHeader({
  title,
  sub,
  desc,
}: {
  title: string;
  sub?: string;
  desc?: string;
}) {
  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-[21px] font-extrabold tracking-tight">{title}</h1>
        {sub ? (
          <span className="text-[12.5px] font-semibold text-soft">{sub}</span>
        ) : null}
      </div>
      {desc ? <p className="mt-1 text-[13px] text-muted">{desc}</p> : null}
    </div>
  );
}

/* ---------- Thẻ KPI ---------- */
const toneClass: Record<string, string> = {
  up: "text-green",
  down: "text-red",
  warn: "text-amber",
  flat: "text-soft",
};

export function KpiGrid({ children }: { children: ReactNode }) {
  return (
    <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {children}
    </div>
  );
}

export function KpiCard({ label, value, sub, tone = "flat" }: KpiCardData) {
  return (
    <div className="rounded-[13px] border border-line bg-card px-4 py-3.5">
      <div className="text-[11.5px] font-bold uppercase tracking-wide text-soft">
        {label}
      </div>
      <div className="mt-0.5 text-[23px] font-extrabold tracking-tight">
        {value}
      </div>
      <div className={`mt-0.5 text-[12px] font-semibold ${toneClass[tone]}`}>
        {sub}
      </div>
    </div>
  );
}

/* ---------- Panel ---------- */
export function Panel({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-4 rounded-[13px] border border-line bg-card px-[18px] py-4">
      <h3 className="mb-2.5 flex flex-wrap items-center gap-2 text-[14.5px] font-bold">
        {title}
        {hint ? (
          <span className="text-[11.5px] font-medium text-soft">{hint}</span>
        ) : null}
      </h3>
      {children}
    </section>
  );
}

/* ---------- Chip trạng thái ---------- */
const chipTone: Record<string, string> = {
  red: "bg-red-soft text-[#a01717]",
  amber: "bg-amber-soft text-[#8a5602]",
  green: "bg-green-soft text-[#0b7a55]",
  gray: "bg-[#eef1f5] text-muted",
  blue: "bg-blue-soft text-[#1e40af]",
};
export function Chip({
  tone = "gray",
  children,
}: {
  tone?: keyof typeof chipTone;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11.5px] font-extrabold ${chipTone[tone]}`}
    >
      {children}
    </span>
  );
}

/* ---------- Hàng cảnh báo ---------- */
const alertTone: Record<AlertSeverity, string> = {
  red: "bg-red-soft text-[#a01717]",
  amber: "bg-amber-soft text-[#8a5602]",
  green: "bg-green-soft text-[#0b7a55]",
};
const alertDot: Record<AlertSeverity, string> = {
  red: "bg-red",
  amber: "bg-amber",
  green: "bg-green",
};

export function AlertList({
  items,
}: {
  items: { tone: AlertSeverity; text: string }[];
}) {
  return (
    <div className="flex flex-col gap-2">
      {items.map((a, i) => (
        <div
          key={i}
          className={`flex items-start gap-2.5 rounded-[10px] px-3.5 py-2.5 text-[13px] font-semibold leading-snug ${alertTone[a.tone]}`}
        >
          <span
            className={`mt-[5px] h-[9px] w-[9px] shrink-0 rounded-full ${alertDot[a.tone]}`}
          />
          {a.text}
        </div>
      ))}
    </div>
  );
}

/* ---------- Danh sách mini ---------- */
const miniTone: Record<string, string> = {
  up: "text-green",
  down: "text-red",
  warn: "text-amber",
  flat: "text-muted",
};

export function MiniList({ items }: { items: MiniItemData[] }) {
  return (
    <div className="flex flex-col gap-2">
      {items.map((m, i) => (
        <div
          key={i}
          className="flex items-center gap-2.5 rounded-[10px] border border-line px-3 py-2.5 text-[13px]"
        >
          <span>{m.icon}</span>
          <div className="min-w-0">
            <div className="font-bold">{m.title}</div>
            <div className="text-[12px] text-soft">{m.sub}</div>
          </div>
          <span
            className={`ml-auto whitespace-nowrap text-[12.5px] font-extrabold ${miniTone[m.tone ?? "flat"]}`}
          >
            {m.right}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ---------- Biểu đồ cột đơn giản ---------- */
export function Bars({
  data,
}: {
  data: { label: string; pct: number; today?: boolean }[];
}) {
  return (
    <div className="flex h-[130px] items-end gap-1.5 pt-1.5">
      {data.map((d, i) => (
        <div
          key={i}
          className="flex h-full flex-col items-center justify-end gap-1.5"
        >
          <div
            className={`w-full rounded-t-[5px] ${
              d.today
                ? "bg-gradient-to-b from-[#ffd9a0] to-[#ffb84d]"
                : "bg-gradient-to-b from-[#bfd3f5] to-[#8fb3f0]"
            }`}
            style={{ height: `${d.pct}%` }}
          />
          <span className="text-[10px] font-bold text-soft">{d.label}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------- Bảng ---------- */
export const tableCls = {
  table: "w-full border-collapse text-[13px]",
  th: "border-b border-line px-2 py-[7px] text-left text-[11px] font-extrabold uppercase tracking-wider text-soft",
  td: "border-b border-[#f0f2f6] px-2 py-2 align-middle",
  tdNum: "border-b border-[#f0f2f6] px-2 py-2 text-right align-middle tabular-nums",
};

/* ---------- Bảng 2 cột ---------- */
export function Grid2({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">{children}</div>;
}

/* ---------- Không có quyền ---------- */
export function NoAccess() {
  return (
    <div className="mx-auto mt-16 max-w-md rounded-2xl border border-line bg-card p-8 text-center">
      <div className="text-4xl">🔒</div>
      <h2 className="mt-3 text-lg font-extrabold">Không có quyền truy cập</h2>
      <p className="mt-2 text-[13px] text-muted">
        Trang này ngoài phạm vi vai trò hiện tại. Phân quyền được đảm bảo bằng
        RLS ở tầng database — không chỉ ẩn giao diện.
      </p>
      <Link
        href="/dashboard"
        className="mt-5 inline-block rounded-full bg-ink px-5 py-2.5 text-[14px] font-semibold text-white"
      >
        Về trang chủ
      </Link>
    </div>
  );
}
