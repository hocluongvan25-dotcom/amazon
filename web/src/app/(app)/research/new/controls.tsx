"use client";

/**
 * Điều khiển nhập liệu dùng chung cho form G1 (trang /research/new).
 * Tách riêng để trang form và trang phân tích không trùng định nghĩa.
 */
import type { ReactNode } from "react";

export const inputCls =
  "w-full rounded-[9px] border border-line bg-white px-2.5 py-1.5 text-[13px] tabular-nums outline-none focus:border-[#8fb3f0]";

export function NumField({
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

export function TextField({
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

export function CheckField({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-[9px] border border-line bg-white px-3 py-2 text-[12.5px] font-semibold">
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        {hint ? <span className="block text-[10.5px] font-normal text-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

/** Nhóm con trong một thẻ (fieldset + legend) thay cho tab step. */
export function FieldGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset>
      <legend className="mb-2 text-[10.5px] font-extrabold uppercase tracking-[0.08em] text-muted">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}
