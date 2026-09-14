"use client";

import Link from "next/link";
import { PERSONAS, type PersonaKey } from "@/lib/roles";
import type { Session } from "@/lib/auth/session";
import type { TopbarScope } from "@/lib/data/topbar-scope";

export default function Topbar({
  session,
  bellSlot,
  scope,
}: {
  session: Session;
  bellSlot: React.ReactNode;
  /** Số shop thật đếm từ DB (SUPABASE MODE). Thiếu ⇒ ẩn số, không hiện mock. */
  scope?: TopbarScope | null;
}) {
  const persona = PERSONAS[session.persona];
  const isDemo = session.mode === "demo";

  // SUPABASE MODE: chỉ hiện số ĐẾM ĐƯỢC từ DB qua RLS — tuyệt đối không dùng
  // chuỗi mock của persona ("Tất cả (14)" là dữ liệu wireframe DEMO).
  const shopLabel = isDemo
    ? persona.shop
    : scope?.shopCount == null
      ? "Shop: —"
      : `Shop: ${scope.shopCount}${scope.productionCount != null ? ` (${scope.productionCount} production)` : ""}`;

  function switchPersona(next: string) {
    // Chỉ dùng ở DEMO MODE — kiểm chứng phân quyền theo phòng
    document.cookie = `demo_role=${next}; path=/; max-age=${60 * 60 * 24 * 7}`;
    window.location.href = "/dashboard";
  }

  return (
    <div className="sticky top-0 z-40 overflow-visible border-b border-line bg-card/95 backdrop-blur">
      <div className="flex h-[58px] items-center gap-2.5 overflow-visible px-4">
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
          // Vai trò THẬT từ iam.role_assignments — không hiện nhãn persona demo
          // ("Ban điều hành VEXIM" là mock wireframe). Không đọc được ⇒ ẩn hẳn.
          scope?.roleLabel ? (
            <span className="shrink-0 rounded-[9px] border border-accent bg-accent-soft px-2.5 py-[7px] text-[12.5px] font-extrabold text-accent-ink">
              {scope.roleLabel}
            </span>
          ) : null
        )}

        {isDemo ? (
          // Bộ lọc khách hàng chỉ có nghĩa ở DEMO (multi-tenant mô phỏng).
          // SUPABASE MODE: RLS đã lọc sẵn theo người đăng nhập — không hiện
          // dropdown giả tạo cảm giác "chọn được".
          <select className="shrink-0 rounded-[9px] border border-line bg-card px-2.5 py-[7px] text-[12.5px] font-semibold text-muted">
            <option>{persona.org}</option>
          </select>
        ) : null}
        <Link
          href="/module0/connect"
          title="Danh sách shop bạn được phép đọc (RLS) — bấm để mở Kết nối shop"
          className="shrink-0 rounded-[9px] border border-line bg-card px-2.5 py-[7px] text-[12.5px] font-semibold text-muted hover:border-accent"
        >
          {shopLabel}
        </Link>
        <select className="hidden shrink-0 rounded-[9px] border border-line bg-card px-2.5 py-[7px] text-[12.5px] font-semibold text-muted md:block">
          <option>Hôm qua</option>
          <option>7 ngày</option>
          <option>30 ngày</option>
        </select>

        <div className="ml-auto flex shrink-0 items-center gap-2.5">
          {bellSlot}
          <Link
            href="/profile"
            title="Trang cá nhân"
            className="grid h-[34px] w-[34px] place-items-center rounded-full bg-[#dfe6f3] text-[12px] font-extrabold text-[#3c4a63] transition hover:ring-2 hover:ring-accent"
          >
            {isDemo ? persona.avatar : (session.email ?? "?").slice(0, 2).toUpperCase()}
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
            🔒 Đăng nhập: <b className="text-blue">{session.email ?? "?"}</b>
            {scope?.roleLabel ? <> · vai trò <b className="text-blue">{scope.roleLabel}</b></> : null} ·{" "}
            <span className="text-soft">SUPABASE MODE · phạm vi dữ liệu theo RLS</span>
          </>
        )}
      </div>
    </div>
  );
}
