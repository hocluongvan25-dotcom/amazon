"use client";

/**
 * Nút ghi của Module 5 P3 — dùng chung cho A2 (ngân sách · bid · bật/tạm dừng) và
 * A3 (thêm negative).
 *
 * VÌ SAO KHÔNG PHẢI "GỬI LÀ XONG":
 *   Bấm nút KHÔNG có nghĩa là Amazon đã đổi. Yêu cầu đi vào hàng đợi; nếu vượt
 *   ngưỡng 30%/ngày thì phải chờ trưởng phòng PPC duyệt TRƯỚC khi worker gọi API
 *   (SOP-05 bước 4). Vì vậy thông báo trả về nói rõ: "đã gửi duyệt" hay "worker
 *   sẽ gửi" — và DB đọc lại before/after nên client không thể tự miễn duyệt.
 */

import { useState, useTransition } from "react";

import { submitAdsChangeAction } from "@/app/(app)/ppc/actions";
import { Chip } from "@/components/ui";

type Props = {
  sellerAccountId: string;
  adsProfileId?: string | null;
  action: "set_budget" | "set_bid" | "set_state" | "add_negative_exact" | "add_negative_phrase";
  entityType: "campaign" | "keyword" | "search_term";
  entityKey: string;
  campaignId?: string | null;
  adGroupId?: string | null;
  label?: string | null;
  suggestionId?: string | null;
  /** Có ô nhập giá trị mới (ngân sách · bid · chữ search term). */
  valueLabel?: string;
  defaultValue?: string | number | null;
  /** Giá trị cố định, không cần ô nhập (ENABLED / PAUSED). */
  fixedValue?: string;
  submitLabel: string;
  /** Gợi ý quy tắc ngay dưới nút (ngưỡng duyệt, SOP…). */
  hint?: string;
  /** Nền đỏ cho hành động chặn chi tiêu (tạm dừng) / gỡ. */
  danger?: boolean;
  /** Bề rộng ô nhập (mặc định 28 = 7rem). */
  inputWidth?: string;
};

export function ChangeForm(props: Props) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(String(props.defaultValue ?? ""));
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const needsInput = props.valueLabel !== undefined;

  function submit(formData: FormData) {
    startTransition(async () => {
      setMsg(null);
      const result = await submitAdsChangeAction(formData);
      setMsg({ ok: result.ok, text: result.message });
      if (result.ok) {
        setOpen(false);
        setReason("");
      }
    });
  }

  const buttonCls = props.danger
    ? "rounded-lg border border-line bg-red-soft px-2.5 py-1 text-[12px] font-bold text-[#a01717] hover:brightness-95"
    : "rounded-lg border border-line bg-[#eef1f5] px-2.5 py-1 text-[12px] font-bold text-muted hover:brightness-95";

  if (!open) {
    return (
      <div className="flex flex-col items-start gap-1">
        <button
          type="button"
          className={buttonCls}
          disabled={pending}
          onClick={() => setOpen(true)}
        >
          {pending ? "Đang gửi…" : props.submitLabel}
        </button>
        {props.hint ? <span className="text-[10.5px] leading-tight text-soft">{props.hint}</span> : null}
        {msg ? (
          <span className={`text-[11px] font-semibold ${msg.ok ? "text-green" : "text-red"}`}>{msg.text}</span>
        ) : null}
      </div>
    );
  }

  return (
    <form action={submit} className="flex flex-col gap-1.5 rounded-[10px] border border-line bg-card p-2">
      <input type="hidden" name="sellerAccountId" value={props.sellerAccountId} />
      <input type="hidden" name="action" value={props.action} />
      <input type="hidden" name="entityType" value={props.entityType} />
      <input type="hidden" name="entityKey" value={props.entityKey} />
      {props.campaignId ? <input type="hidden" name="campaignId" value={props.campaignId} /> : null}
      {props.adGroupId ? <input type="hidden" name="adGroupId" value={props.adGroupId} /> : null}
      {props.label ? <input type="hidden" name="label" value={props.label} /> : null}
      {props.suggestionId ? <input type="hidden" name="suggestionId" value={props.suggestionId} /> : null}
      {props.adsProfileId ? <input type="hidden" name="adsProfileId" value={props.adsProfileId} /> : null}
      <input
        type="hidden"
        name="value"
        value={needsInput ? value : (props.fixedValue ?? "")}
      />

      {needsInput ? (
        <label className="flex items-center gap-1.5 text-[11.5px] font-semibold text-muted">
          {props.valueLabel}
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            inputMode="decimal"
            autoFocus
            className={`rounded-lg border border-line bg-card px-2 py-1 text-[12px] ${props.inputWidth ?? "w-28"}`}
          />
        </label>
      ) : (
        <span className="text-[11.5px] font-bold text-muted">
          Đặt trạng thái = {props.fixedValue}
        </span>
      )}

      <label className="flex items-start gap-1.5 text-[11.5px] text-muted">
        Lý do
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="ví dụ: ACOS 62% · SOP-05 bước 3"
          className="w-44 rounded-lg border border-line bg-card px-2 py-1 text-[12px]"
        />
      </label>

      <div className="flex items-center gap-1.5">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-accent px-2.5 py-1 text-[12px] font-bold text-white disabled:opacity-60"
        >
          {pending ? "Đang gửi…" : "Xác nhận"}
        </button>
        <button
          type="button"
          className="rounded-lg border border-line px-2.5 py-1 text-[12px] font-bold text-muted"
          onClick={() => setOpen(false)}
        >
          Thôi
        </button>
        <Chip tone="amber">sẽ vào hàng đợi duyệt</Chip>
      </div>

      {msg ? (
        <span className={`text-[11px] font-semibold ${msg.ok ? "text-green" : "text-red"}`}>{msg.text}</span>
      ) : null}
    </form>
  );
}
