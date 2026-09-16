/**
 * Module 8 G7 — cảnh báo ngân sách credits Rainforest của tháng.
 * Worker CHẶN khi dự kiến vượt trần (mặc định 10.000 = gói Starter annual);
 * vượt ngân sách nội bộ (mặc định 2.000) là cảnh báo, kèm ước tiền overage.
 */

import { Panel } from "@/components/ui";
import { RAINFOREST_PLANS, decideCreditBudget } from "@/lib/research/domain";
import type { CreditMonthRow } from "@/lib/data/research-seasonality";

export function CreditBudgetPanel({
  rows,
  softBudget = 2_000,
  hardCap = 10_000,
}: {
  rows: CreditMonthRow[];
  softBudget?: number;
  hardCap?: number;
}) {
  if (!rows.length) {
    return (
      <Panel title="Ngân sách credits Rainforest (G7)" hint="gói Starter annual 10.000 credits/tháng">
        <div className="rounded-[10px] bg-[#f4f6fa] px-3 py-2 text-[12.5px] text-soft">
          Chưa có giao dịch credits nào trong tháng.
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title="Ngân sách credits Rainforest (G7)"
      hint={`cảnh báo nội bộ ${softBudget.toLocaleString("vi-VN")} · trần chặn ${hardCap.toLocaleString("vi-VN")}`}
    >
      <div className="space-y-2">
        {rows.map((r) => {
          const d = decideCreditBudget({
            spentMonth: r.creditsSpent,
            softBudget,
            hardCap,
            plan: RAINFOREST_PLANS.starter,
          });
          const tone =
            d.level === "block"
              ? "border-red-300 bg-red-50 text-red-900"
              : d.level === "warn"
                ? "border-amber-300 bg-amber-50 text-amber-900"
                : "border-slate-200 bg-white text-slate-700";
          const pct = Math.min(100, Math.round((r.creditsSpent / hardCap) * 100));
          return (
            <div key={`${r.orgId}-${r.month}`} className={`rounded-[10px] border px-3 py-2 ${tone}`}>
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <b>{r.orgName || "Khách hàng"}</b>
                <span className="text-[11px] opacity-70">· {r.month}</span>
                <span className="ml-auto font-bold">
                  {r.creditsSpent.toLocaleString("vi-VN")} credits
                </span>
                <span className="text-[11px] opacity-80">
                  {d.remaining.toLocaleString("vi-VN")} credits còn lại trước trần
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded bg-black/10">
                <div
                  className={d.level === "block" ? "h-full bg-red-600" : d.level === "warn" ? "h-full bg-amber-500" : "h-full bg-green-600"}
                  style={{ width: `${pct}%` }}
                />
              </div>
              {d.level !== "ok" && (
                <ul className="mt-1 list-disc pl-4 text-[11.5px]">
                  {d.reasons.map((reason, i) => <li key={i}>{reason}</li>)}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[11.5px] text-soft">
        Ước tính 1 hồ sơ đầy đủ (~30 ASIN organic + review top 10) tốn khoảng 111 credits; mức giá
        overage gói Starter annual là $0,0118/credit.
      </p>
    </Panel>
  );
}
