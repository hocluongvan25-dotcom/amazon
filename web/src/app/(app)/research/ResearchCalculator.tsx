"use client";

/**
 * Module 8 G1 — máy tính what-if tài chính:
 * chuyên viên nhập giả định, engine chạy ngay trên trình duyệt (thuần TS),
 * nút "Lưu hồ sơ" gọi server action → RPC security-definer (hoặc báo demo).
 *
 * Bố cục: 4 TAB nhỏ theo nhiệm vụ (Ngách → Giá & chi phí → Đóng gói & rủi ro
 * → Velocity & lô test), mỗi tab có chấm trạng thái hợp lệ/lỗi để không bị
 * ngợp bởi ~25 ô nhập dồn trên một màn hình. Cột phải vẫn là kết quả engine
 * cập nhật trực tiếp khi gõ.
 */

import { useMemo, useState, useTransition, type ReactNode } from "react";
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
        {suffix ? <span className="whitespace-nowrap text-[11.5px] text-soft">{suffix}</span> : null}
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
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11.5px] font-bold text-soft">{label}</span>
      <input className={inputCls} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      {hint ? <span className="mt-0.5 block text-[10.5px] text-muted">{hint}</span> : null}
    </label>
  );
}

function CheckField({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-[12.5px] font-semibold">
      <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint ? <span className="block text-[10.5px] font-normal text-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

/** Tiêu đề nhóm con trong tab (gạch ngang kèm nhãn). */
function FieldGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset>
      <legend className="mb-2 text-[10.5px] font-extrabold uppercase tracking-[0.08em] text-muted">
        {title}
      </legend>
      {children}
    </fieldset>
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

/* --------------------------------- tabs ---------------------------------- */

type TabKey = "nganh" | "gia" | "donggoi" | "velocity";
const TAB_ORDER: TabKey[] = ["nganh", "gia", "donggoi", "velocity"];
const TAB_META: Record<TabKey, { label: string; duty: string }> = {
  nganh: { label: "Ngách & từ khóa", duty: "Xác định sản phẩm cần thẩm định" },
  gia: { label: "Giá & chi phí/đơn vị", duty: "3 kịch bản giá, vốn, phí FBA, quảng cáo" },
  donggoi: { label: "Đóng gói & rủi ro", duty: "Kích thước FBA, dễ vỡ, chứng nhận, bằng sáng chế" },
  velocity: { label: "Velocity & lô test", duty: "Đơn/ngày bi quan, số ngày phủ, ngân sách thử" },
};

/** Ánh xạ thông điệp lỗi của engine về tab phụ trách. */
function errorToTab(msg: string): TabKey {
  if (msg.includes("tên ngách") || msg.includes("từ khóa")) return "nganh";
  if (msg.includes("Kích thước") || msg.includes("khối lượng")) return "donggoi";
  return "gia";
}

function num(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function ResearchCalculator({ canSave }: { canSave: boolean }) {
  const [form, setForm] = useState<ResearchFormRaw>(DEFAULTS);
  const [state, setState] = useState<SaveAssessmentState | null>(null);
  const [tab, setTab] = useState<TabKey>("nganh");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const set = (patch: Partial<ResearchFormRaw>) => {
    setState(null);
    setForm((f) => ({ ...f, ...patch }));
  };

  const { errors, result, errorsByTab } = useMemo<{
    errors: string[];
    result: AssessmentResult | null;
    errorsByTab: Record<TabKey, string[]>;
  }>(() => {
    const a = formToAssumptions(form);
    const e = validateAssumptions(a);
    const by: Record<TabKey, string[]> = { nganh: [], gia: [], donggoi: [], velocity: [] };
    for (const m of e) by[errorToTab(m)].push(m);
    return { errors: e, result: e.length ? null : computeAssessment(a), errorsByTab: by };
  }, [form]);

  // Đánh dấu tab "đủ thông tin" để chấm xanh (chỉ kiểm các nhóm bắt buộc).
  const filled: Record<TabKey, boolean> = {
    nganh: !!form.title.trim() && !!form.keywords.trim(),
    gia:
      num(form.pricePessimistic) !== null &&
      num(form.priceBase) !== null &&
      num(form.priceOptimistic) !== null &&
      num(form.cogsPerUnit) !== null &&
      num(form.inboundFreightPerUnit) !== null,
    donggoi:
      num(form.lengthIn) !== null &&
      num(form.widthIn) !== null &&
      num(form.heightIn) !== null &&
      num(form.weightLb) !== null,
    velocity: num(form.pessimisticUnitsPerDay) !== null && num(form.testCoverDays) !== null,
  };

  const tabIndex = TAB_ORDER.indexOf(tab);
  const goTab = (k: TabKey) => setTab(k);
  const save = () => {
    if (errors.length) {
      setTab(errorToTab(errors[0]));
      return;
    }
    startTransition(async () => {
      const r = await saveAssessmentAction(form);
      setState(r);
      if (r.ok && r.id) router.push(`/research/${r.id}`);
    });
  };

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(420px,560px)_1fr]">
      {/* Cột nhập — chia tab theo nhiệm vụ */}
      <div>
        <div className="rounded-[13px] border border-line bg-card">
          {/* Hàng tab */}
          <div role="tablist" className="flex flex-wrap gap-1 border-b border-line p-1.5">
            {TAB_ORDER.map((k, i) => {
              const active = k === tab;
              const errs = errorsByTab[k].length;
              const dot = statusDot(errs, filled[k]);
              return (
                <button
                  key={k}
                  role="tab"
                  aria-selected={active}
                  type="button"
                  onClick={() => goTab(k)}
                  className={`flex items-center gap-1.5 rounded-[9px] px-2.5 py-1.5 text-[12px] font-extrabold transition ${
                    active ? "bg-[#1f3a5f] text-white" : "text-soft hover:bg-[#f4f6fa] hover:text-ink"
                  }`}
                >
                  <span
                    className={`inline-block h-2 w-2 shrink-0 rounded-full ${dot}`}
                    title={errs ? `${errs} lỗi cần sửa` : filled[k] ? "đã đủ thông tin" : "chưa điền đủ"}
                  />
                  {i + 1}. {TAB_META[k].label}
                </button>
              );
            })}
          </div>

          <div className="px-[18px] py-4">
            <p className="mb-3 text-[11.5px] font-semibold text-muted">
              Nhiệm vụ bước này: {TAB_META[tab].duty}.
            </p>

            {/* TAB 1 — NGÁCH */}
            {tab === "nganh" && (
              <div className="space-y-3">
                <TextField
                  label="Tên ngách / sản phẩm *"
                  value={form.title}
                  onChange={(v) => set({ title: v })}
                />
                <TextField
                  label="Từ khóa ngách (phẩy cách nhau) *"
                  value={form.keywords}
                  onChange={(v) => set({ keywords: v })}
                  placeholder="vd: silicone baby plate"
                  hint="Từ khóa đầu tiên dùng cho lượt quét SERP ở G2."
                />
                <TextField
                  label="ASIN hạt nhân (tùy chọn)"
                  value={form.seedAsin ?? ""}
                  onChange={(v) => set({ seedAsin: v })}
                  hint="G2 sẽ quét lan từ ASIN này; để trống nếu chưa có."
                />
              </div>
            )}

            {/* TAB 2 — GIÁ & CHI PHÍ */}
            {tab === "gia" && (
              <div className="space-y-4">
                <FieldGroup title="Kịch bản giá bán (USD)">
                  <div className="grid grid-cols-3 gap-2.5">
                    <NumField label="Giá BI QUAN *" value={form.pricePessimistic} onChange={(v) => set({ pricePessimistic: v })} suffix="$" hint="kịch bản xấu nhất" />
                    <NumField label="Giá CƠ SỞ *" value={form.priceBase} onChange={(v) => set({ priceBase: v })} suffix="$" />
                    <NumField label="Giá QUAN TÂM *" value={form.priceOptimistic} onChange={(v) => set({ priceOptimistic: v })} suffix="$" hint="kịch bản tốt nhất" />
                  </div>
                </FieldGroup>

                <FieldGroup title="Chi phí mỗi đơn vị (USD)">
                  <div className="grid grid-cols-3 gap-2.5">
                    <NumField label="Giá vốn tận xưởng *" value={form.cogsPerUnit} onChange={(v) => set({ cogsPerUnit: v })} suffix="$" />
                    <NumField label="Cước VN→FBA/đơn *" value={form.inboundFreightPerUnit} onChange={(v) => set({ inboundFreightPerUnit: v })} suffix="$" />
                    <NumField label="Chi phí khác/đơn" value={form.otherPerUnit ?? ""} onChange={(v) => set({ otherPerUnit: v })} suffix="$" hint="bao bì, dán nhãn…" />
                    <NumField label="Referral %" value={form.referralRate ?? ""} onChange={(v) => set({ referralRate: v })} suffix="%" hint="mặc định 15%" />
                    <NumField label="Phí FBA thực (SP-API)" value={form.fbaFeeOverride ?? ""} onChange={(v) => set({ fbaFeeOverride: v })} suffix="$" hint="trống = ước lượng bảng 2026" />
                    <NumField label="Tỉ lệ trả hàng" value={form.returnRatePct ?? ""} onChange={(v) => set({ returnRatePct: v })} suffix="%" hint="mặc định 4%" />
                  </div>
                </FieldGroup>

                <FieldGroup title="Quảng cáo & chuyển đổi">
                  <div className="grid grid-cols-2 gap-2.5">
                    <NumField label="CPC giả định" value={form.cpc ?? ""} onChange={(v) => set({ cpc: v })} suffix="$/click" />
                    <NumField label="Tỉ lệ chuyển đổi" value={form.conversionRatePct ?? ""} onChange={(v) => set({ conversionRatePct: v })} suffix="%" hint="vd: 10" />
                  </div>
                </FieldGroup>
              </div>
            )}

            {/* TAB 3 — ĐÓNG GÓI & RỦI RO */}
            {tab === "donggoi" && (
              <div className="space-y-4">
                <FieldGroup title="Kích thước đã gồm bao bì (dùng tra size-tier & phí FBA)">
                  <div className="grid grid-cols-4 gap-2.5">
                    <NumField label="Dài" value={form.lengthIn} onChange={(v) => set({ lengthIn: v })} suffix="in" />
                    <NumField label="Rộng" value={form.widthIn} onChange={(v) => set({ widthIn: v })} suffix="in" />
                    <NumField label="Cao" value={form.heightIn} onChange={(v) => set({ heightIn: v })} suffix="in" />
                    <NumField label="Khối lượng" value={form.weightLb} onChange={(v) => set({ weightLb: v })} suffix="lb" />
                  </div>
                </FieldGroup>
                <FieldGroup title="Cờ rủi ro (kéo điểm trụ logistics/khác biệt xuống)">
                  <div className="space-y-2">
                    <CheckField label="Dễ vỡ / cần bảo vệ đặc biệt" checked={!!form.fragile} onChange={(v) => set({ fragile: v })} hint="Tăng phí đóng gói và tỉ lệ hỏng hóc khi vận chuyển." />
                    <CheckField label="Cần chứng nhận (điện/trẻ em/thực phẩm…)" checked={!!form.certificationRequired} onChange={(v) => set({ certificationRequired: v })} hint="CPC, FCC, FDA… có thể trễ lịch vào hàng." />
                    <CheckField label="Nghi ngờ rủi ro bằng sáng chế" checked={!!form.patentRisk} onChange={(v) => set({ patentRisk: v })} hint="Cần tra cứu bằng sáng chế/trademark trước khi đặt mẫu." />
                  </div>
                </FieldGroup>
              </div>
            )}

            {/* TAB 4 — VELOCITY & LÔ TEST */}
            {tab === "velocity" && (
              <div className="space-y-4">
                <FieldGroup title="Kịch bản BI QUAN (quyết định GO/NO-GO)">
                  <div className="grid grid-cols-2 gap-2.5">
                    <NumField label="Đơn/ngày BI QUAN" value={form.pessimisticUnitsPerDay ?? ""} onChange={(v) => set({ pessimisticUnitsPerDay: v })} suffix="đơn/ngày" hint="G2–G3 sẽ hiệu chỉnh bằng sales estimation thật." />
                    <NumField label="Số ngày phủ lô test" value={form.testCoverDays ?? ""} onChange={(v) => set({ testCoverDays: v })} suffix="ngày" hint="30–45, mặc định 45" />
                  </div>
                </FieldGroup>
                <FieldGroup title="Ngân sách ads chạy thử">
                  <div className="grid grid-cols-2 gap-2.5">
                    <NumField label="Ngân sách ads/ngày" value={form.adsBudgetPerDay ?? ""} onChange={(v) => set({ adsBudgetPerDay: v })} suffix="$" hint="để trống = engine tự gợi ý theo CPC & CVR" />
                    <NumField label="Số ngày chạy ads test" value={form.adsTestDays ?? ""} onChange={(v) => set({ adsTestDays: v })} suffix="ngày" />
                  </div>
                </FieldGroup>
              </div>
            )}

            {/* Lỗi riêng của tab đang xem */}
            {errorsByTab[tab].length > 0 && (
              <div className="mt-4 rounded-[10px] border border-amber/50 bg-amber-soft px-3 py-2">
                <p className="mb-1 text-[11.5px] font-extrabold text-[#8a5602]">Cần sửa ở bước này:</p>
                <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-[#8a5602]">
                  {errorsByTab[tab].map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Điều hướng + lưu */}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
              <button
                type="button"
                disabled={tabIndex === 0}
                onClick={() => goTab(TAB_ORDER[tabIndex - 1])}
                className="rounded-[9px] border border-line bg-white px-3 py-1.5 text-[12px] font-extrabold text-soft disabled:opacity-40"
              >
                ← Bước trước
              </button>
              <div className="flex items-center gap-2">
                {tabIndex < TAB_ORDER.length - 1 ? (
                  <button
                    type="button"
                    onClick={() => goTab(TAB_ORDER[tabIndex + 1])}
                    className="rounded-[9px] border border-[#1f3a5f] px-3 py-1.5 text-[12px] font-extrabold text-[#1f3a5f]"
                  >
                    Bước tiếp →
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={!!errors.length || pending || !canSave}
                  onClick={save}
                  title={errors.length ? "Còn ô bắt buộc chưa hợp lệ — xem chấm đỏ trên các tab" : undefined}
                  className="rounded-[10px] bg-[#1f3a5f] px-4 py-1.5 text-[12.5px] font-extrabold text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {pending ? "Đang lưu…" : "Lưu hồ sơ thẩm định"}
                </button>
              </div>
            </div>

            {!canSave && (
              <p className="mt-2 text-[11.5px] font-semibold text-amber">
                DEMO MODE: máy tính chạy được nhưng không lưu hồ sơ.
              </p>
            )}
            {state && (
              <div className="mt-2">
                <Chip tone={state.ok ? "green" : "amber"}>{state.message}</Chip>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Cột kết quả */}
      <div>
        {errors.length > 0 ? (
          <Panel title="Còn thiếu dữ liệu">
            <p className="mb-2 text-[12px] text-soft">
              Kết quả sẽ hiện khi tất cả ô bắt buộc hợp lệ. Các tab có lỗi được chấm đỏ:
            </p>
            <ul className="list-disc space-y-1 pl-5 text-[13px] text-[#8a5602]">
              {errors.map((e) => (
                <li key={e}>
                  <b>[{TAB_META[errorToTab(e)].label}]</b> {e}
                </li>
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

/** Chấm trạng thái tab: đỏ = có lỗi, xanh = đủ thông tin, xám = chưa điền. */
function statusDot(errorCount: number, isFilled: boolean): string {
  if (errorCount > 0) return "bg-[#c0392b]";
  if (isFilled) return "bg-[#1e8e4f]";
  return "bg-[#c7cedb]";
}
