"use client";

/**
 * BỘ CHỌN PHẠM VI SHOP ở Topbar — thay cho select TRANG TRÍ trước 16/09/2026.
 *
 * Trước đây control này chỉ có một `<option>{persona.shop}</option>` và không có
 * `onChange` ⇒ người dùng kéo shop về hệ thống xong vẫn không chọn được shop nào.
 *
 * Bây giờ:
 *   • Danh sách shop = `vexim_shops` (RLS: chỉ shop người đăng nhập đọc được) +
 *     mục "Tất cả shop"; nhãn kèm tên shop Amazon khi đã lấy được storeName.
 *   • Chọn shop ⇒ ghi cookie `shop_scope` rồi `router.refresh()`: mọi server
 *     component trong lượt xem này đọc lại dữ liệu ĐÚNG shop đó (xem
 *     `resolveShopScope` ở `@/lib/data/shop-scope`).
 *   • Không có shop nào (DEMO MODE / RLS không cho shop nào) ⇒ khoá control và nói
 *     rõ lý do, không để một select rỗng gây hiểu sai.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  SHOP_SCOPE_COOKIE,
  SHOP_SCOPE_MAX_AGE_SECONDS,
  allShopsLabel,
  shopOptionLabel,
  type ShopOption,
} from "@/lib/data/shop-scope-model";

export default function ShopScopeSelect({
  shops,
  current,
  mode,
}: {
  shops: ShopOption[];
  /** id shop đang chọn, `null` = tất cả shop */
  current: string | null;
  mode: "demo" | "supabase";
}) {
  const router = useRouter();
  const [value, setValue] = useState(current ?? "");
  const [pending, startTransition] = useTransition();

  function pick(next: string) {
    setValue(next);
    document.cookie = `${SHOP_SCOPE_COOKIE}=${next}; path=/; max-age=${SHOP_SCOPE_MAX_AGE_SECONDS}; samesite=lax`;
    // Đọc lại MỌI server component của lượt xem này với phạm vi shop mới.
    startTransition(() => router.refresh());
  }

  const disabled = shops.length === 0;
  const title = disabled
    ? mode === "demo"
      ? "DEMO MODE chưa nối Supabase nên chưa có shop thật để chọn"
      : "Tài khoản này chưa đọc được shop nào (RLS) — vào Module 0 · Kết nối shop để thêm/kết nối shop"
    : "Phạm vi shop cho các màn có lọc theo shop (Đơn hàng, Tài chính…)";

  return (
    <select
      value={value}
      disabled={disabled}
      title={title}
      aria-label="Phạm vi shop"
      onChange={(e) => pick(e.target.value)}
      className={`max-w-[260px] shrink-0 rounded-[9px] border px-2.5 py-[7px] text-[12.5px] font-semibold ${
        disabled
          ? "border-line bg-card text-soft"
          : value
            ? "border-accent bg-accent-soft text-accent-ink"
            : "border-line bg-card text-muted"
      } ${pending ? "opacity-60" : ""}`}
    >
      <option value="">{allShopsLabel(shops.length)}</option>
      {shops.map((s) => (
        <option key={s.id} value={s.id}>
          {shopOptionLabel(s)}
        </option>
      ))}
    </select>
  );
}
