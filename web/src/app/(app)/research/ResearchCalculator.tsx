"use client";

/**
 * Module 8 G1 — máy tính what-if tài chính:
 * chuyên viên nhập giả định, engine chạy ngay trên trình duyệt (thuần TS),
 * nút "Lưu hồ sơ" gọi server action → RPC security-definer (hoặc báo demo).
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Chip, Panel } from "@/components/ui";
import {
  computeAssessment,
  validateAssumptions,
  type AssessmentResult,
} from "@/lib/research/domain";
import { formToAssumptions, type ResearchFormRaw } from "@/lib/data/research-model";
import { saveAssessmentAction, type SaveAssessmentState } from "./actions";
import { ResearchResultView } from "./ResearchResultView";

const inputCls =
  "w-full rounded-[9px] border border-line bg-white px-2.5 py-1.5 text-[13px] tabular-nums outline-none focus:border-[#8fb3f0]";

function NumField({
  label,
  value,
  onChange,
  suffix,
  step = "any",
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  suffix?: string;
  step?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11.5px] font-bold text-soft">{label}</span>
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          step={step}
          inputMode="decimal"
          className={inputCls}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {suffix ? <span className="text-[11.5px] text-soft">{suffix}</span> : null}
      </div>
      {hint ? <span className="mt-0.5 block text-[10.5px] text-muted">{hint}</span> : null}
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11.5px] font-bold text-soft">{label}</span>
      <input className={inputCls} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </label>
  );
}

function CheckField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[12.5px] font-semibold">
      <input type="checkbox" className="h-4 w-4" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

const DEFAULTS: ResearchFormRaw = {
  title: "Giá đỡ inox đa năng nhà bếp",
  keywords: "kitchen shelf organizer, stainless steel rack",
  seedAsin: "",
  pricePessimistic: "34.99",
  priceBase: "39.99",
  priceOptimistic: "44.99",
  cogsPerUnit: "6",
  inboundFreightPerUnit: "1.5",
  lengthIn: "10",
  widthIn: "6",
  heightIn: "0.5",
  weightLb: "0.75",
  referralRate: "15",
  fbaFeeOverride: "",
  cpc: "0.8",
  conversionRatePct: "10",
  returnRatePct: "4",
  otherPerUnit: "0",
  pessimisticUnitsPerDay: "3",
  testCoverDays: "45",
  adsBudgetPerDay: "",
  adsTestDays: "45",
  fragile: false,
  certificationRequired: false,
  patentRisk: false,
};

export function ResearchCalculator({ canSave }: { canSave: boolean }) {
  const [form, setForm] = useState<ResearchFormRaw>(DEFAULTS);
  const [state, setState] = useState<SaveAssessmentState | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const set = (patch: Partial<ResearchFormRaw>) => setForm((f) => ({ ...f, ...patch }));

  const { errors, result } = useMemo<{ errors: string[]; result: AssessmentResult | null }>(() => {
    const a = formToAssumptions(form);
    const e = validateAssumptions(a);
    return { errors: e, result: e.length ? null : computeAssessment(a) };
  }, [form]);

  const save = () => {
    startTransition(async () => {
      const r = await saveAssessmentAction(form);
      setState(r);
      if (r.ok && r.id) router.push(`/research/${r.id}`);
    });
  };

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(380px,520px)_1fr]">
      {/* Cột nhập */}
      <div>
        <Panel title="1. Ngách & từ khóa">
          <div className="space-y-3">
            <TextField label="Tên ngách / sản phẩm *" value={form.title} onChange={(v) => set({ title: v })} />
            <TextField
              label="Từ khóa ngách (phẩy cách nhau) *"
              value={form.keywords}
              onChange={(v) => set({ keywords: v })}
              placeholder="vd: silicone baby plate"
            />
            <TextField label="ASIN hạt nhân (tùy chọn — G2 quét lan từ đây)" value={form.seedAsin ?? ""} onChange={(v) => set({ seedAsin: v })} />
          </div>
        </Panel>

        <Panel title="2. Giá & chi phí/đơn vị (USD)">
          <div className="grid grid-cols-3 gap-2.5">
            <NumField label="Giá BI QUAN" value={form.pricePessimistic} onChange={(v) => set({ pricePessimistic: v })} suffix="$" />
            <NumField label="Giá CƠ SỞ" value={form.priceBase} onChange={(v) => set({ priceBase: v })} suffix="$" />
            <NumField label="Giá QUAN TÂM" value={form.priceOptimistic} onChange={(v) => set({ priceOptimistic: v })} suffix="$" />
            <NumField label="Giá vốn tận xưởng *" value={form.cogsPerUnit} onChange={(v) => set({ cogsPerUnit: v })} suffix="$" />
            <NumField label="Cước VN→FBA/đơn" value={form.inboundFreightPerUnit} onChange={(v) => set({ inboundFreightPerUnit: v })} suffix="$" />
            <NumField label="Referral %" value={form.referralRate ?? ""} onChange={(v) => set({ referralRate: v })} suffix="%" hint="mặc định 15%" />
            <NumField label="Phí FBA thực (SP-API)" value={form.fbaFeeOverride ?? ""} onChange={(v) => set({ fbaFeeOverride: v })} suffix="$" hint="để trống = ước lượng bảng 2026" />
            <NumField label="CPC giả định" value={form.cpc ?? ""} onChange={(v) => set({ cpc: v })} suffix="$/click" />
            <NumField label="Tỉ lệ chuyển đổi" value={form.conversionRatePct ?? ""} onChange={(v) => set({ conversionRatePct: v })} suffix="%" />
            <NumField label="Tỉ lệ trả hàng" value={form.returnRatePct ?? ""} onChange={(v) => set({ returnRatePct: v })} suffix="%" hint="mặc định 4%" />
            <NumField label="Chi phí khác/đơn" value={form.otherPerUnit ?? ""} onChange={(v) => set({ otherPerUnit: v })} suffix="$" />
          </div>
        </Panel>

        <Panel title="3. Đóng gói (kích thước đã gồm bao bì)">
          <div className="grid grid-cols-4 gap-2.5">
            <NumField label="Dài" value={form.lengthIn} onChange={(v) => set({ lengthIn: v })} suffix="in" />
            <NumField label="Rộng" value={form.widthIn} onChange={(v) => set({ widthIn: v })} suffix="in" />
            <NumField label="Cao" value={form.heightIn} onChange={(v) => set({ heightIn: v })} suffix="in" />
            <NumField label="Khối lượng" value={form.weightLb} onChange={(v) => set({ weightLb: v })} suffix="lb" />
          </div>
          <div className="mt-3 space-y-1.5">
            <CheckField label="Dễ vỡ / cần bảo vệ đặc biệt" checked={!!form.fragile} onChange={(v) => set({ fragile: v })} />
            <CheckField label="Cần chứng nhận (điện/trẻ em/thực phẩm…)" checked={!!form.certificationRequired} onChange={(v) => set({ certificationRequired: v })} />
            <CheckField label="Nghi ngờ rủi ro bằng sáng chế" checked={!!form.patentRisk} onChange={(v) => set({ patentRisk: v })} />
          </div>
        </Panel>

        <Panel title="4. Velocity & lô test (kịch bản BI QUAN)">
          <div className="grid grid-cols-2 gap-2.5">
            <NumField label="Đơn/ngày BI QUAN" value={form.pessimisticUnitsPerDay ?? ""} onChange={(v) => set({ pessimisticUnitsPerDay: v })} suffix="đơn/ngày" hint="G2 sẽ điền từ sales estimation" />
            <NumField label="Số ngày phủ lô test" value={form.testCoverDays ?? ""} onChange={(v) => set({ testCoverDays: v })} suffix="ngày" hint="30–45, mặc định 45" />
            <NumField label="Ngân sách ads/ngày" value={form.adsBudgetPerDay ?? ""} onChange={(v) => set({ adsBudgetPerDay: v })} suffix="$" hint="trống = tự gợi ý" />
            <NumField label="Số ngày chạy ads test" value={form.adsTestDays ?? ""} onChange={(v) => set({ adsTestDays: v })} suffix="ngày" />
          </div>
        </Panel>

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={!!errors.length || pending || !canSave}
            onClick={save}
            className="rounded-[10px] bg-[#1f3a5f] px-4 py-2 text-[13px] font-extrabold text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? "Đang lưu…" : "Lưu hồ sơ thẩm định"}
          </button>
          {!canSave && (
            <span className="text-[12px] font-semibold text-amber">DEMO MODE: máy tính chạy được nhưng không lưu hồ sơ.</span>
          )}
          {state && (
            <Chip tone={state.ok ? "green" : "amber"}>{state.message}</Chip>
          )}
        </div>
      </div>

      {/* Cột kết quả */}
      <div>
        {errors.length > 0 ? (
          <Panel title="Còn thiếu dữ liệu">
            <ul className="list-disc space-y-1 pl-5 text-[13px] text-[#8a5602]">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </Panel>
        ) : result ? (
          <ResearchResultView result={result} />
        ) : null}
      </div>
    </div>
  );
}
