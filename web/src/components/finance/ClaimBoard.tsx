"use client";

/**
 * Bảng claim bồi hoàn FBA (F3) — lọc, sắp theo tuổi claim, mở rộng xem
 * lịch sử SOP-09 và nộp case ngay trên bảng.
 *
 * Ghi dữ liệu đi qua Server Action → RPC `vexim_update_reimbursement_claim`
 * (migration 0015). Quyền quyết định do DB chốt bằng `iam.is_finance_editor()`;
 * UI chỉ ẩn/hiện cho đỡ nhầm, KHÔNG phải nơi phân quyền.
 */

import { Fragment, useMemo, useState, useTransition } from "react";
import { Chip, Panel, tableCls } from "@/components/ui";
import { updateClaimAction } from "@/app/(app)/finance/claims/actions";
import {
  CLAIM_CATEGORY_VI,
  CLAIM_SLA_HOURS,
  CLAIM_STATUS_VI,
  CLAIM_SOURCE_VI,
  claimActions,
  isClaimOverdue,
  money,
  type ClaimHistoryRow,
  type ClaimRow,
} from "@/lib/data/finance-model";

const statusTone: Record<string, "red" | "amber" | "green" | "blue" | "gray"> = {
  suspected: "blue",
  to_claim: "amber",
  filed: "amber",
  approved: "green",
  rejected: "red",
  paid: "green",
  closed: "gray",
};

/** Nhãn SOP-09 cho từng mốc lịch sử. */
const STAGE_VI: Record<string, string> = {
  detected: "1–2. Phát hiện & phân loại (đối chiếu tự động)",
  updated: "Worker cập nhật số liệu khoản nghi ngờ",
  to_claim: "3. Xác nhận đưa vào danh sách khiếu nại",
  filed: "4. Đã nộp case Amazon (ghi mã case)",
  approved: "5. Amazon chấp nhận",
  rejected: "5. Amazon từ chối",
  paid: "6. Tiền đã về — đối chiếu settlement",
  closed: "7. Đóng hồ sơ",
  reopened: "Mở lại để nộp tiếp",
  reopened_from_rejected: "Mở lại sau khi bị từ chối",
};

function ageLabel(hours: number | null | undefined): string {
  if (hours === null || hours === undefined) return "—";
  if (hours < 24) return `${Math.max(0, Math.round(hours))}h`;
  return `${Math.floor(hours / 24)} ngày ${Math.round(hours % 24)}h`;
}

export function ClaimBoard({
  claims,
  history,
  canWrite,
  canDecide,
}: {
  claims: ClaimRow[];
  history: Record<string, ClaimHistoryRow[]>;
  canWrite: boolean;
  canDecide: boolean;
}) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [shop, setShop] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ tone: "green" | "red"; text: string } | null>(null);

  const shops = useMemo(() => [...new Set(claims.map((c) => c.shop))].sort(), [claims]);
  const categories = useMemo(() => [...new Set(claims.map((c) => c.category))].sort(), [claims]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return claims
      .filter((c) => (status ? c.status === status : true))
      .filter((c) => (category ? c.category === category : true))
      .filter((c) => (shop ? c.shop === shop : true))
      .filter((c) =>
        needle
          ? [c.sku, c.asin ?? "", c.source_ref, c.amazon_case_id ?? "", c.reimbursement_id ?? ""]
              .join(" ")
              .toLowerCase()
              .includes(needle)
          : true,
      )
      .sort((a, b) => {
        const overdue = Number(isClaimOverdue(b)) - Number(isClaimOverdue(a));
        if (overdue !== 0) return overdue;
        return (b.age_hours ?? 0) - (a.age_hours ?? 0);
      });
  }, [claims, q, status, category, shop]);

  const submit = (formData: FormData) => {
    startTransition(async () => {
      const result = await updateClaimAction(formData);
      setNotice(result.ok ? { tone: "green", text: result.message } : { tone: "red", text: result.message });
    });
  };

  return (
    <Panel
      title="Hàng đợi khiếu nại (SOP-09)"
      hint={`${rows.length}/${claims.length} khoản · SLA ${CLAIM_SLA_HOURS}h · sắp theo mức quá hạn`}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Tìm SKU / ASIN / mã case / mã bồi hoàn"
          className="w-64 rounded-lg border border-line bg-card px-3 py-1.5 text-[12.5px]"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-lg border border-line bg-card px-2 py-1.5 text-[12.5px] font-semibold"
        >
          <option value="">Mọi trạng thái</option>
          {Object.entries(CLAIM_STATUS_VI).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded-lg border border-line bg-card px-2 py-1.5 text-[12.5px] font-semibold"
        >
          <option value="">Mọi nguyên nhân</option>
          {categories.map((key) => (
            <option key={key} value={key}>
              {CLAIM_CATEGORY_VI[key] ?? key}
            </option>
          ))}
        </select>
        {shops.length > 1 ? (
          <select
            value={shop}
            onChange={(e) => setShop(e.target.value)}
            className="rounded-lg border border-line bg-card px-2 py-1.5 text-[12.5px] font-semibold"
          >
            <option value="">Mọi shop</option>
            {shops.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {notice ? (
        <div
          className={`mb-3 rounded-lg px-3 py-2 text-[12.5px] font-semibold ${
            notice.tone === "green" ? "bg-green-soft text-[#0b7a55]" : "bg-red-soft text-[#a01717]"
          }`}
        >
          {notice.text}
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className={tableCls.table}>
          <thead>
            <tr>
              <th className={tableCls.th}>SKU</th>
              <th className={tableCls.th}>Shop</th>
              <th className={tableCls.th}>Nguyên nhân</th>
              <th className={`${tableCls.th} text-right`}>SL</th>
              <th className={`${tableCls.th} text-right`}>Giá vốn/đv</th>
              <th className={`${tableCls.th} text-right`}>Giá trị ước tính</th>
              <th className={tableCls.th}>Trạng thái</th>
              <th className={tableCls.th}>Tuổi claim</th>
              <th className={tableCls.th}>Chứng từ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const overdue = isClaimOverdue(c);
              const open = openId === c.id;
              const actions = claimActions(c.status, canDecide);
              return (
                <Fragment key={c.id}>
                  <tr
                    className={`cursor-pointer align-top ${overdue ? "bg-red-soft/40" : ""}`}
                    onClick={() => setOpenId(open ? null : c.id)}
                  >
                    <td className={`${tableCls.td} font-bold`}>
                      <div>{c.sku}</div>
                      <div className="text-[11px] font-medium text-soft">{c.asin ?? "—"}</div>
                    </td>
                    <td className={tableCls.td}>{c.shop}</td>
                    <td className={tableCls.td}>
                      <div>{CLAIM_CATEGORY_VI[c.category] ?? c.category}</div>
                      <div className="text-[11px] text-soft">
                        {CLAIM_SOURCE_VI[c.source] ?? c.source} · {c.source_ref}
                        {c.source_reason ? ` · ${c.source_reason}` : ""}
                      </div>
                    </td>
                    <td className={tableCls.tdNum}>{c.quantity ?? "—"}</td>
                    <td className={tableCls.tdNum}>{money(c.unit_cost, c.currency)}</td>
                    <td className={tableCls.tdNum}>
                      {money(c.estimated_amount, c.currency)}
                      {c.reimbursed_amount !== null && c.reimbursed_amount !== undefined ? (
                        <div className="text-[11px] font-semibold text-green">
                          về {money(c.reimbursed_amount, c.currency)}
                        </div>
                      ) : null}
                    </td>
                    <td className={tableCls.td}>
                      <Chip tone={statusTone[c.status] ?? "gray"}>
                        {CLAIM_STATUS_VI[c.status] ?? c.status}
                      </Chip>
                      {c.amazon_case_id ? (
                        <div className="mt-1 text-[11px] font-semibold text-muted">case {c.amazon_case_id}</div>
                      ) : null}
                    </td>
                    <td className={tableCls.td}>
                      {overdue ? (
                        <Chip tone="red">⚠ {ageLabel(c.age_hours)}</Chip>
                      ) : (
                        <span className="text-[12px] font-semibold text-muted">{ageLabel(c.age_hours)}</span>
                      )}
                    </td>
                    <td className={tableCls.td}>
                      <span className="text-[11.5px] font-semibold text-accent-ink">
                        {open ? "▾ thu gọn" : "▸ chi tiết"}
                      </span>
                    </td>
                  </tr>
                  {open ? (
                    <tr>
                      <td className={tableCls.td} colSpan={9}>
                        <div className="grid gap-4 lg:grid-cols-2">
                          <div>
                            <div className="mb-1.5 text-[12px] font-bold uppercase tracking-wide text-soft">
                              Lịch sử theo SOP-09
                            </div>
                            <ol className="space-y-1.5">
                              {(history[c.id] ?? []).map((h) => (
                                <li key={h.id} className="flex gap-2 text-[12.5px]">
                                  <span className="whitespace-nowrap font-semibold text-muted">
                                    {new Date(h.created_at).toLocaleString("vi-VN")}
                                  </span>
                                  <span>
                                    {STAGE_VI[h.stage] ?? h.stage}
                                    {h.note ? <span className="text-muted"> — {h.note}</span> : null}
                                  </span>
                                </li>
                              ))}
                              {(history[c.id] ?? []).length === 0 ? (
                                <li className="text-[12.5px] text-soft">Chưa có ghi nhận nào.</li>
                              ) : null}
                            </ol>
                          </div>
                          <div>
                            <div className="mb-1.5 text-[12px] font-bold uppercase tracking-wide text-soft">
                              Xử lý tiếp ({CLAIM_STATUS_VI[c.status] ?? c.status})
                            </div>
                            {!canWrite ? (
                              <p className="text-[12.5px] text-soft">
                                DEMO MODE — thao tác cập nhật chỉ bật khi nối Supabase.
                              </p>
                            ) : actions.length === 0 ? (
                              <p className="text-[12.5px] text-soft">
                                {canDecide
                                  ? "Không còn bước nào ở trạng thái này."
                                  : "Cần quyền Trưởng phòng Tài chính để duyệt bước này."}
                              </p>
                            ) : (
                              <form action={submit} className="space-y-2">
                                <input type="hidden" name="claimId" value={c.id} />
                                <div className="flex flex-wrap items-center gap-2">
                                  <select
                                    name="action"
                                    defaultValue={actions[0].action}
                                    className="rounded-lg border border-line bg-card px-2 py-1.5 text-[12.5px] font-semibold"
                                  >
                                    {actions.map((a) => (
                                      <option key={a.action} value={a.action}>
                                        {a.label}
                                      </option>
                                    ))}
                                  </select>
                                  <input
                                    name="caseId"
                                    placeholder="Mã case Amazon (bắt buộc khi nộp)"
                                    className="w-56 rounded-lg border border-line bg-card px-2 py-1.5 text-[12.5px]"
                                  />
                                  <input
                                    name="amount"
                                    inputMode="decimal"
                                    placeholder="Số tiền về (khi ghi nhận đã trả)"
                                    className="w-48 rounded-lg border border-line bg-card px-2 py-1.5 text-[12.5px]"
                                  />
                                </div>
                                <input
                                  name="note"
                                  placeholder="Ghi chú (bắt buộc khi duyệt/từ chối/đóng)"
                                  className="w-full rounded-lg border border-line bg-card px-2 py-1.5 text-[12.5px]"
                                />
                                <button
                                  type="submit"
                                  disabled={pending}
                                  className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-bold text-white disabled:opacity-60"
                                >
                                  {pending ? "Đang lưu…" : "Cập nhật claim"}
                                </button>
                              </form>
                            )}
                            <div className="mt-2 text-[11.5px] text-soft">
                              Kiểm chứng: {CLAIM_SOURCE_VI[c.source] ?? c.source} {c.source_ref} · phát hiện{" "}
                              {new Date(c.detected_at).toLocaleString("vi-VN")}
                              {c.filed_at ? ` · nộp ${new Date(c.filed_at).toLocaleString("vi-VN")}` : ""}
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td className={tableCls.td} colSpan={9}>
                  Không có khoản nào khớp bộ lọc.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11.5px] text-soft">
        Giá trị ước tính = số lượng × giá vốn hiệu lực (catalog.cost_inputs). Ô “—” là VEXIM chưa nhập giá vốn —
        hệ thống không tự đoán tiền.
      </p>
    </Panel>
  );
}
