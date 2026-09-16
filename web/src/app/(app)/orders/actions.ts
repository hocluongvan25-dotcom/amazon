"use server";

/**
 * Server Action của Module 4 (Đơn hàng) — nút "Đồng bộ đơn hàng ngay" trên
 * /orders, /orders/fbm, /orders/returns.
 *
 * VÌ SAO CẦN NÚT (câu hỏi 16/09/2026: "kết nối API đã chuẩn chưa?"):
 *   Đường delta Orders API v0 trước đây KHÔNG có ai gọi — chỉ có tài liệu mô tả.
 *   Nay có cron + CLI, nhưng trên Vercel không chạy được shell và cron chỉ chạy
 *   theo lịch ⇒ người vận hành cần một cách bấm-để-chạy ngay và ĐỌC LỖI THẬT
 *   (thiếu credential, shop chưa 'production', Amazon 429/403…).
 *
 * Quyền: chỉ persona đang xem được màn đơn hàng (ALLOWED của 5 trang orders = ceo)
 * mới được bấm — không mở thêm đường ghi nào khác. Action chỉ GHI vào DB của mình
 * qua service_role trong runner; KHÔNG gửi thay đổi nào lên Amazon.
 */

import { revalidatePath } from "next/cache";

import { getAppSession } from "@/lib/auth/session";
import { runOrdersSyncAll } from "@/lib/worker";

export type OrdersSyncNowState = {
  ok: boolean;
  message: string;
  lines: string[];
  log: string;
};

/** Khớp ALLOWED của 5 trang /orders* (trang chặn theo persona). */
const ALLOWED_PERSONAS = new Set(["ceo"]);

export async function runOrdersSyncNowAction(): Promise<OrdersSyncNowState> {
  const session = await getAppSession();
  if (!session) return { ok: false, message: "Chưa đăng nhập.", lines: [], log: "" };
  if (session.mode !== "supabase") {
    return {
      ok: false,
      message: "Đang ở DEMO MODE — không gọi Amazon. Cần Supabase + credential thật.",
      lines: [],
      log: "",
    };
  }
  if (!ALLOWED_PERSONAS.has(session.persona)) {
    return {
      ok: false,
      message: "Chỉ Ban điều hành (ceo) được chạy đồng bộ đơn hàng.",
      lines: [],
      log: "",
    };
  }

  let buf = "";
  const stdout = {
    write: (s: string) => {
      buf += s;
    },
  };
  const lines: string[] = [];

  try {
    const res = await runOrdersSyncAll({
      days: 7,
      // Trần 60s của Vercel Function: giữ ngân sách item nhỏ để còn thời gian đọc
      // getOrders + ghi DB. Chạy CLI ở worker/ nếu cần backfill lớn.
      maxItemMs: 15_000,
      stdout,
    });

    lines.push(
      `Kết quả: ${res.ordersUpserted} đơn · ${res.itemsUpserted} dòng hàng · ${res.pages} trang ` +
        `(DB: ${res.db}, credential SP-API: ${res.apiConfigured ? "có" : "CHƯA CÓ"})`,
    );
    for (const o of res.outcomes) lines.push(`· ${o.shop}: ${o.status} — ${o.message}`);
    for (const e of res.errors) lines.push(`⚠ ${e.shopId}: ${e.error}`);
    if (res.deferred > 0) {
      lines.push(
        `Lưu ý: ${res.deferred} đơn chưa lấy được dòng hàng trong lượt này (trần tốc độ 0.5 rps) — lượt sau lấy tiếp.`,
      );
    }
    if (res.throttled) {
      lines.push("Amazon đã trả 429 một phần: lượt này phải dừng sớm, chạy lại sau ít phút.");
    }

    const ok = res.failed === 0 && (res.ordersUpserted > 0 || res.shopsProcessed > 0);
    const message = res.failed > 0
      ? `Có ${res.failed} shop LỖI — xem chi tiết bên dưới.`
      : res.ordersUpserted > 0
        ? `Đã đồng bộ ${res.ordersUpserted} đơn hàng.`
        : res.apiConfigured
          ? "Không có đơn nào thay đổi trong 7 ngày gần nhất."
          : "CHƯA có credential SP-API — chưa gọi được Amazon.";

    revalidatePath("/orders");
    revalidatePath("/orders/list");
    revalidatePath("/orders/fbm");
    revalidatePath("/orders/returns");

    return { ok, message, lines, log: buf };
  } catch (e) {
    return {
      ok: false,
      message: `Lỗi khi đồng bộ: ${(e as Error).message}`,
      lines,
      log: buf,
    };
  }
}
