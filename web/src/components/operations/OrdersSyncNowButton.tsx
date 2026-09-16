"use client";

/**
 * Nút "▶ Đồng bộ đơn hàng ngay" — gọi server action `runOrdersSyncNowAction`.
 *
 * VÌ SAO CẦN: cron chỉ chạy theo lịch và Vercel không có shell để chạy
 * `npm run worker:orders-sync`. Không có nút này thì người vận hành đứng trước
 * bảng rỗng mà không có cách nào tự kéo đơn hay tự đọc lỗi Amazon (429/403/thiếu
 * credential). Nút in ra đúng nhật ký của runner, KHÔNG che lỗi.
 */

import { useState, useTransition } from "react";

import { runOrdersSyncNowAction, type OrdersSyncNowState } from "@/app/(app)/orders/actions";

export function OrdersSyncNowButton({
  label = "▶ Đồng bộ đơn hàng ngay",
}: {
  label?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<OrdersSyncNowState | null>(null);

  function run() {
    startTransition(async () => {
      const res = await runOrdersSyncNowAction();
      setState(res);
    });
  }

  return (
    <div className="mb-4 flex flex-col gap-2">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        title="Gọi Orders API v0 (getOrders + getOrderItems) cho mọi shop production, ghi vào bảng đơn hàng"
        className="self-start rounded-[9px] bg-ink px-3.5 py-2 text-[12.5px] font-bold text-white disabled:opacity-50"
      >
        {pending ? "Đang đồng bộ (có thể mất tới 1 phút)…" : label}
      </button>

      {state ? (
        <div
          role="status"
          className={`rounded-[10px] px-3 py-2.5 text-[12.5px] ${
            state.ok ? "bg-green-soft text-[#0b7a55]" : "bg-amber-soft text-[#8a5602]"
          }`}
        >
          <div className="font-bold">{state.message}</div>
          {state.lines.length > 0 ? (
            <ul className="mt-1.5 flex list-disc flex-col gap-0.5 pl-5 font-semibold">
              {state.lines.slice(0, 12).map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          ) : null}
          {state.log ? (
            <details className="mt-2">
              <summary className="cursor-pointer font-bold">Nhật ký đầy đủ</summary>
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap text-[11.5px]">{state.log}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
