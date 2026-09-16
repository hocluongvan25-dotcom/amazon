"use client";

/**
 * Nút "Chạy đồng bộ ngay" của màn A1 — gọi server action `runAdsSyncNowAction`.
 *
 * Vì sao cần: trên Vercel KHÔNG chạy được `npm run worker:ads-sync` (không có
 * shell), nên nếu chỉ hướng dẫn bằng câu lệnh thì người vận hành không có cách
 * nào tự kéo dữ liệu hay tự đọc lỗi Amazon. Nút này chạy đúng 2 job của cron
 * (sync cấu trúc → kéo 5 report) một cách thủ công và in ra kết quả thật.
 */

import { useState, useTransition } from "react";

import { runAdsSyncNowAction, type AdsSyncNowState } from "@/app/(app)/ppc/actions";

export function AdsSyncNowButton({ label = "▶ Chạy đồng bộ Amazon Ads ngay" }: { label?: string }) {
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<AdsSyncNowState | null>(null);

  function run() {
    startTransition(async () => {
      const res = await runAdsSyncNowAction();
      setState(res);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className="self-start rounded-[9px] bg-ink px-3.5 py-2 text-[12.5px] font-bold text-white disabled:opacity-50"
      >
        {pending ? "Đang chạy (có thể mất tới 1 phút)…" : label}
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
