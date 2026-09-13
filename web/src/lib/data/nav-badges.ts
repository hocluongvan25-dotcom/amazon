/**
 * Badge số bên cạnh menu — ĐẾM THẬT TỪ DB (Module 0, hạ tầng dùng chung).
 *
 * VÌ SAO PHẢI LÀM LẠI:
 *   Trước đây số trên menu là hằng số mock trong `roles.ts` (5 · 7 · 12 · 3…).
 *   Với người vận hành, một con số đỏ cạnh "Giá & Buy Box" là LỜI HỨA "có 12 việc
 *   đang chờ" — bấm vào không thấy 12 việc thì mất niềm tin vào cả dashboard.
 *   Nguyên tắc từ nay: **chỉ hiện số đếm được từ DB**, đếm không được thì ẩn.
 *
 * CÁCH ĐẾM:
 *   `select("id", { count: "exact", head: true })` — Postgres đếm rồi trả về ĐÚNG
 *   một con số, KHÔNG kéo dòng nào về (menu chạy ở mọi trang, không được tải dữ liệu).
 *   RLS vẫn áp: user không có quyền đọc shop đó thì số tự nhỏ đi — badge không phải
 *   đường rò dữ liệu.
 *
 * CHƯA NỐI (`/listing`, `/pricing`, `/fulfillment`, `/orders`, `/finance`, `/health`):
 *   các màn đó chưa có định nghĩa "việc cần xử lý" thống nhất trong DB (mỗi màn một
 *   kiểu: quá hạn · thiếu giá vốn · chờ duyệt…). Thà KHÔNG hiện badge còn hơn hiện
 *   một con số đoán. Thêm badge = thêm 1 dòng vào `SPECS` dưới đây.
 */

import { createClient } from "@/lib/supabase/server";
import type { NavBadges } from "@/lib/roles";

type BadgeSpec = {
  href: string;
  /** View/bảng đếm. */
  view: string;
  /** Điều kiện "cần người xử lý" — đúng bằng bộ lọc của màn hình tương ứng. */
  filter?: Record<string, string>;
  /** Giải thích cho người đọc code (không hiện trên UI). */
  meaning: string;
};

export const NAV_BADGE_SPECS: BadgeSpec[] = [
  {
    href: "/ppc",
    view: "vexim_ads_changes",
    filter: { status: "pending_approval" },
    meaning: "Yêu cầu đổi ngân sách/bid vượt ngưỡng đang CHỜ trưởng phòng PPC duyệt (SOP-05 b4).",
  },
  {
    href: "/ppc/search-terms",
    view: "vexim_ads_negative_suggestions",
    filter: { status: "pending" },
    meaning: "Gợi ý negative keyword đang chờ duyệt (A3 · SOP-04).",
  },
];

/**
 * Đếm badge cho menu. Lỗi (chưa chạy migration · mất mạng · RLS chặn) ⇒ **bỏ badge
 * đó**, không throw: một badge lỗi không được làm sập cả layout.
 */
export async function readNavBadges(): Promise<NavBadges> {
  const client = await createClient();
  if (!client) return {};

  const results = await Promise.allSettled(
    NAV_BADGE_SPECS.map(async (spec) => {
      // `select("*", head: true)` — PostgREST vẫn đếm mà không trả dòng nào, và không
      // phụ thuộc tên cột (view đổi cột là badge không được phép vỡ).
      let q = client.from(spec.view).select("*", { count: "exact", head: true });
      for (const [col, val] of Object.entries(spec.filter ?? {})) q = q.eq(col, val);
      const { count, error } = await q;
      if (error) throw new Error(error.message);
      return [spec.href, count ?? 0] as const;
    }),
  );

  const badges: NavBadges = {};
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const [href, n] = r.value;
    if (n > 0) badges[href] = n;
  }
  return badges;
}
