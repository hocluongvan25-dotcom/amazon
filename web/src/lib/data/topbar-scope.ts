/**
 * Phạm vi hiển thị trên thanh Topbar — SỐ THẬT từ DB, không phải persona demo.
 *
 * VÌ SAO CÓ FILE NÀY:
 *   Trước đây Topbar ở SUPABASE MODE vẫn hiện chuỗi cứng của persona "ceo"
 *   ("Khách hàng: Tất cả" · "Shop: Tất cả (14)") lấy từ roles.ts — đó là mock
 *   của wireframe DEMO. Người dùng thật nhìn thấy "14 shop" trong khi hệ thống
 *   chỉ có 1 shop kết nối ⇒ mất niềm tin vào mọi con số còn lại.
 *
 * NGUYÊN TẮC (giống nav-badges.ts): chỉ hiện số ĐẾM ĐƯỢC từ DB qua RLS —
 * user thấy đúng số shop mình được phép đọc. Đếm lỗi ⇒ trả null và Topbar
 * ẩn con số thay vì hiện số sai.
 */

import { createClient } from "@/lib/supabase/server";
import { pickTopRole } from "@/lib/roles";

export type TopbarScope = {
  /** Số shop user đọc được qua RLS (view vexim_shops); null = không đếm được. */
  shopCount: number | null;
  /** Số shop production trong đó (đã/đang kết nối thật). */
  productionCount: number | null;
  /** Nhãn vai trò THẬT từ iam.role_assignments; null = không đọc được → ẩn. */
  roleLabel: string | null;
};

export async function readTopbarScope(): Promise<TopbarScope> {
  const empty: TopbarScope = { shopCount: null, productionCount: null, roleLabel: null };
  try {
    const client = await createClient();
    if (!client) return empty;

    // head:true — Postgres đếm, không kéo dòng nào (Topbar render ở MỌI trang).
    // role_assignments: RLS cho đọc dòng CỦA MÌNH (0021) — trả về vai trò thật.
    const [all, prod, roles] = await Promise.all([
      client.from("vexim_shops").select("*", { count: "exact", head: true }),
      client
        .from("vexim_shops")
        .select("*", { count: "exact", head: true })
        .eq("data_source", "production"),
      client.schema("iam").from("role_assignments").select("role"),
    ]);
    return {
      shopCount: all.error ? null : (all.count ?? 0),
      productionCount: prod.error ? null : (prod.count ?? 0),
      roleLabel: roles.error
        ? null
        : pickTopRole(((roles.data ?? []) as { role: string }[]).map((r) => r.role)),
    };
  } catch {
    return empty;
  }
}
