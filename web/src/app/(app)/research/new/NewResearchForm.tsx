"use client";

/**
 * Module 8 G1 — BƯỚC 1/2: trang NHẬP LIỆU riêng, chiếm trọn bề ngang.
 * Không chia tab/step nữa: 4 thẻ mục trải trên lưới nhiều cột để có không
 * gian. Nút cuối trang chuyển sang BƯỚC 2/2 (trang phân tích riêng), nháp
 * được giữ trong sessionStorage.
 */

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Panel } from "@/components/ui";
import type { ResearchFormRaw } from "@/lib/data/research-model";
import { CheckField, FieldGroup, NumField, TextField } from "./controls";
import {
  DEFAULTS,
  SECTION_LABEL,
  errorsBySection,
  saveDraft,
  type FormSection,
} from "@/lib/research/new-form";

const sectionErrCls =
  "mb-3 rounded-[10px] border border-red/40 bg-red-soft px-3 py-2 text-[12px] font-semibold text-[#a01717]";

export function NewResearchForm() {
  const [form, setForm] = useState<ResearchFormRaw>(DEFAULTS);
  const [submitted, setSubmitted] = useState(false);
  const router = useRouter();
  const refs = {
    nganh: useRef<HTMLDivElement>(null),
    gia: useRef<HTMLDivElement>(null),
    donggoi: useRef<HTMLDivElement>(null),
    velocity: useRef<HTMLDivElement>(null),
  };
  const set = (patch: Partial<ResearchFormRaw>) => setForm((f) => ({ ...f, ...patch }));

  const { errors, bySection } = useMemo(() => errorsBySection(form), [form]);
  const showErrors = submitted && errors.length > 0;

  const goAnalysis = () => {
    setSubmitted(true);
    if (errors.length) {
      const first = (Object.keys(bySection) as FormSection[]).find((k) => bySection[k].length);
      if (first) refs[first].current?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    saveDraft(form);
    router.push("/research/new/phan-tich");
  };

  const errBox = (key: FormSection) =>
    bySection[key].length > 0 ? (
      <div className={sectionErrCls}>
        <b className="mb-0.5 block">Cần bổ sung ở mục “{SECTION_LABEL[key]}”:</b>
        <ul className="list-disc space-y-0.5 pl-5">
          {bySection[key].map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </div>
    ) : null;

  return (
    <>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 1 — NGÁCH */}
        <div ref={refs.nganh} className="lg:col-span-2 scroll-mt-4">
          <Panel title="1. Ngách & từ khóa" hint="xác định sản phẩm và truy vấn quét SERP ở G2">
            {showErrors && errBox("nganh")}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
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
                hint="Từ khóa đầu dùng cho lượt quét SERP."
              />
              <TextField
                label="ASIN hạt nhân (tùy chọn)"
                value={form.seedAsin ?? ""}
                onChange={(v) => set({ seedAsin: v })}
                hint="G2 quét lan từ ASIN này; trống cũng được."
              />
            </div>
          </Panel>
        </div>

        {/* 2 — GIÁ & CHI PHÍ */}
        <div ref={refs.gia} className="lg:col-span-2 scroll-mt-4">
          <Panel title="2. Giá & chi phí/đơn vị (USD)" hint="3 kịch bản giá; engine tính P&L ngay ở bước phân tích">
            {showErrors && errBox("gia")}
            <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
              <FieldGroup title="Kịch bản giá bán">
                <div className="grid grid-cols-3 gap-2.5 xl:grid-cols-1">
                  <NumField label="Giá BI QUAN *" value={form.pricePessimistic} onChange={(v) => set({ pricePessimistic: v })} suffix="$" hint="xấu nhất" />
                  <NumField label="Giá CƠ SỞ *" value={form.priceBase} onChange={(v) => set({ priceBase: v })} suffix="$" />
                  <NumField label="Giá QUAN TÂM *" value={form.priceOptimistic} onChange={(v) => set({ priceOptimistic: v })} suffix="$" hint="tốt nhất" />
                </div>
              </FieldGroup>

              <FieldGroup title="Chi phí mỗi đơn vị">
                <div className="grid grid-cols-2 gap-2.5">
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
                <p className="mt-2 text-[11px] leading-snug text-muted">
                  ACOS hòa vốn và PPC/đơn được engine tự suy từ CPC ÷ tỉ lệ chuyển đổi.
                </p>
              </FieldGroup>
            </div>
          </Panel>
        </div>

        {/* 3 — ĐÓNG GÓI */}
        <div ref={refs.donggoi} className="scroll-mt-4">
          <Panel title="3. Đóng gói & rủi ro" hint="kích thước đã gồm bao bì — dùng tra size-tier & phí FBA">
            {showErrors && errBox("donggoi")}
            <FieldGroup title="Kích thước / khối lượng">
              <div className="grid grid-cols-4 gap-2.5">
                <NumField label="Dài" value={form.lengthIn} onChange={(v) => set({ lengthIn: v })} suffix="in" />
                <NumField label="Rộng" value={form.widthIn} onChange={(v) => set({ widthIn: v })} suffix="in" />
                <NumField label="Cao" value={form.heightIn} onChange={(v) => set({ heightIn: v })} suffix="in" />
                <NumField label="Khối lượng" value={form.weightLb} onChange={(v) => set({ weightLb: v })} suffix="lb" />
              </div>
            </FieldGroup>
            <FieldGroup title="Cờ rủi ro">
              <div className="mt-2 space-y-2">
                <CheckField label="Dễ vỡ / cần bảo vệ đặc biệt" checked={!!form.fragile} onChange={(v) => set({ fragile: v })} hint="Tăng phí đóng gói và tỉ lệ hỏng hóc." />
                <CheckField label="Cần chứng nhận (điện/trẻ em/thực phẩm…)" checked={!!form.certificationRequired} onChange={(v) => set({ certificationRequired: v })} hint="CPC, FCC, FDA… có thể trễ lịch vào hàng." />
                <CheckField label="Nghi ngờ rủi ro bằng sáng chế" checked={!!form.patentRisk} onChange={(v) => set({ patentRisk: v })} hint="Cần tra patent/trademark trước khi đặt mẫu." />
              </div>
            </FieldGroup>
          </Panel>
        </div>

        {/* 4 — VELOCITY */}
        <div ref={refs.velocity} className="scroll-mt-4">
          <Panel title="4. Velocity & lô test" hint="kịch bản BI QUAN quyết định GO/NO-GO">
            <FieldGroup title="Đơn lượng & số ngày phủ">
              <div className="grid grid-cols-2 gap-2.5">
                <NumField label="Đơn/ngày BI QUAN" value={form.pessimisticUnitsPerDay ?? ""} onChange={(v) => set({ pessimisticUnitsPerDay: v })} suffix="đơn/ngày" hint="G2–G3 hiệu chỉnh bằng sales estimation thật." />
                <NumField label="Số ngày phủ lô test" value={form.testCoverDays ?? ""} onChange={(v) => set({ testCoverDays: v })} suffix="ngày" hint="30–45, mặc định 45" />
              </div>
            </FieldGroup>
            <FieldGroup title="Ngân sách ads chạy thử">
              <div className="mt-3 grid grid-cols-2 gap-2.5">
                <NumField label="Ngân sách ads/ngày" value={form.adsBudgetPerDay ?? ""} onChange={(v) => set({ adsBudgetPerDay: v })} suffix="$" hint="trống = engine tự gợi ý" />
                <NumField label="Số ngày chạy ads test" value={form.adsTestDays ?? ""} onChange={(v) => set({ adsTestDays: v })} suffix="ngày" />
              </div>
            </FieldGroup>
          </Panel>
        </div>
      </div>

      {/* Thanh hành động cố định đáy trang */}
      <div className="sticky bottom-0 z-10 -mx-6 mt-2 border-t border-line bg-white/95 px-6 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11.5px] text-muted">
            Bước <b>1/2</b> · Nhập giả định — engine chạy trên trình duyệt, chưa tốn credit Rainforest.
            {showErrors ? (
              <span className="ml-2 font-bold text-[#a01717]">Còn {errors.length} lỗi bắt buộc, xem các mục viền đỏ.</span>
            ) : null}
          </p>
          <button
            type="button"
            onClick={goAnalysis}
            className="rounded-[10px] bg-[#1f3a5f] px-5 py-2 text-[13px] font-extrabold text-white hover:bg-[#274b78]"
          >
            Xem kết quả phân tích →
          </button>
        </div>
      </div>
    </>
  );
}
