"use client";

/**
 * Hàng đợi duyệt thay đổi quảng cáo (Module 5 P3 · SOP-05 bước 4).
 *
 *   • CHỜ DUYỆT: tăng ngân sách/bid > 30%/ngày, hoặc bật lại campaign đang dừng.
 *     Chưa có gì được gửi lên Amazon ở trạng thái này.
 *   • ĐANG BAY: đã duyệt (hoặc tự duyệt vì dưới ngưỡng) — worker sẽ gửi.
 *   • ĐÃ XONG: Amazon đã nhận / bị từ chối — kèm nút REVERT 1 CHẠM cho Ops.
 *
 * QUYỀN: nút duyệt chỉ hiện khi người dùng có quyền (persona trưởng phòng/CEO ở
 * demo, `iam.is_ads_approver()` ở DB). Ẩn nút KHÔNG phải phân quyền — RPC của
 * 0021 vẫn từ chối nếu người bấm không có quyền.
 */

import { useMemo, useState, useTransition } from "react";

import {
  cancelAdsChangeAction,
  decideAdsChangeAction,
  revertAdsChangeAction,
} from "@/app/(app)/ppc/actions";
import { Chip, Panel, tableCls } from "@/components/ui";
import {
  changeActionLabel,
  changeStatusMeta,
  changeSummary,
  splitQueue,
  type AdsChangeRaw,
} from "@/lib/data/ppc-model";

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace("T", " ");
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function Row({
  row,
  canDecide,
  busy,
  onDecide,
  onCancel,
  onRevert,
}: {
  row: AdsChangeRaw;
  canDecide: boolean;
  busy: boolean;
  onDecide: (id: string, decision: "approve" | "reject") => void;
  onCancel: (id: string) => void;
  onRevert: (id: string) => void;
}) {
  const meta = changeStatusMeta(row.status);
  return (
    <tr>
      <td className={tableCls.td}>
        <div className="font-bold">{changeActionLabel(row.action)}</div>
        <div className="text-[11.5px] text-soft">
          {row.entity_type} · {row.entity_label ?? row.entity_key}
        </div>
        <div className="text-[11px] text-soft">
          {row.campaign_id ? `campaign ${row.campaign_id}` : ""}
          {row.ad_group_id ? ` · ad group ${row.ad_group_id}` : ""}
        </div>
      </td>
      <td className={tableCls.td}>
        <div className="font-semibold">{changeSummary(row)}</div>
        {row.reason ? <div className="text-[11.5px] text-soft">Lý do: {row.reason}</div> : null}
      </td>
      <td className={tableCls.td}>
        <Chip tone={meta.tone}>{meta.label}</Chip>
        <div className="mt-0.5 text-[11px] leading-snug text-soft">{row.approval_reason ?? meta.hint}</div>
        {row.error ? <div className="mt-0.5 text-[11px] font-semibold text-red">Lỗi: {row.error}</div> : null}
        {row.attempts && row.attempts > 1 ? (
          <div className="text-[11px] text-soft">Đã thử {row.attempts} lần</div>
        ) : null}
      </td>
      <td className={tableCls.td}>
        <div className="text-[12px]">{row.requested_by_name ?? "—"}</div>
        <div className="text-[11px] text-soft">{when(row.requested_at)}</div>
        {row.decided_by_name ? (
          <div className="text-[11px] text-soft">
            {row.status === "rejected" ? "Từ chối" : "Duyệt"}: {row.decided_by_name} · {when(row.decided_at)}
          </div>
        ) : null}
        {row.applied_at ? <div className="text-[11px] text-soft">Amazon nhận: {when(row.applied_at)}</div> : null}
      </td>
      <td className={tableCls.td}>
        <div className="flex flex-wrap items-center gap-1.5">
          {row.status === "pending_approval" && canDecide ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => onDecide(row.id, "approve")}
                className="rounded-lg bg-green px-2.5 py-1 text-[12px] font-bold text-white disabled:opacity-60"
              >
                Duyệt &amp; gửi
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onDecide(row.id, "reject")}
                className="rounded-lg border border-line bg-red-soft px-2.5 py-1 text-[12px] font-bold text-[#a01717] disabled:opacity-60"
              >
                Từ chối
              </button>
            </>
          ) : null}
          {row.status === "pending_approval" || row.status === "approved" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onCancel(row.id)}
              className="rounded-lg border border-line px-2.5 py-1 text-[12px] font-bold text-muted disabled:opacity-60"
            >
              Huỷ
            </button>
          ) : null}
          {row.can_revert ? (
            <button
              type="button"
              disabled={busy}
              title="Tạo yêu cầu đi ngược lại (không sửa dòng cũ — giữ lịch sử)"
              onClick={() => onRevert(row.id)}
              className="rounded-lg border border-line bg-amber-soft px-2.5 py-1 text-[12px] font-bold text-[#8a5602] disabled:opacity-60"
            >
              ↺ Revert 1 chạm
            </button>
          ) : null}
          {row.reverted_by ? <Chip tone="gray">đã bị đảo</Chip> : null}
          {row.status === "failed" ? <Chip tone="red">không có gì được gửi tiếp</Chip> : null}
        </div>
      </td>
    </tr>
  );
}

export function ApprovalBoard({
  changes,
  canDecide,
  audit,
}: {
  changes: AdsChangeRaw[];
  canDecide: boolean;
  /** 20 dòng nhật ký gần nhất (view vexim_ads_audit) — chứng minh "có ghi dấu". */
  audit: { id: string; created_at: string | null; action: string; entity: string | null; actor_name: string | null; result: string | null; after_text: string | null }[];
}) {
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const { pending: waiting, inflight, done } = useMemo(() => splitQueue(changes), [changes]);

  const run = (fn: (fd: FormData) => Promise<{ ok: boolean; message: string }>, fields: Record<string, string>) => {
    startTransition(async () => {
      setNotice(null);
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.set(k, v);
      const res = await fn(fd);
      setNotice({ ok: res.ok, text: res.message });
    });
  };

  return (
    <>
      {notice ? (
        <div
          className={`mb-3 rounded-[10px] px-3.5 py-2.5 text-[13px] font-semibold ${
            notice.ok ? "bg-green-soft text-[#0b7a55]" : "bg-red-soft text-[#a01717]"
          }`}
        >
          {notice.text}
        </div>
      ) : null}

      <Panel
        title="Chờ trưởng phòng PPC duyệt"
        hint={`${waiting.length} yêu cầu · CHƯA gửi gì lên Amazon · SOP-05 bước 4`}
      >
        {waiting.length === 0 ? (
          <div className="rounded-[10px] border border-dashed border-line px-3 py-6 text-center text-[13px] text-soft">
            Không có yêu cầu nào chờ duyệt. Yêu cầu vượt ngưỡng 30%/ngày sẽ xuất hiện ở đây.
          </div>
        ) : (
          <table className={tableCls.table}>
            <thead>
              <tr>
                <th className={tableCls.th}>Thay đổi</th>
                <th className={tableCls.th}>Trước → sau</th>
                <th className={tableCls.th}>Vì sao cần duyệt</th>
                <th className={tableCls.th}>Người yêu cầu</th>
                <th className={tableCls.th}>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {waiting.map((row) => (
                <Row
                  key={row.id}
                  row={row}
                  canDecide={canDecide}
                  busy={pending}
                  onDecide={(id, decision) => run(decideAdsChangeAction, { changeId: id, decision })}
                  onCancel={(id) => run(cancelAdsChangeAction, { changeId: id })}
                  onRevert={(id) => run(revertAdsChangeAction, { changeId: id })}
                />
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Đã duyệt — chờ worker gửi Amazon" hint={`${inflight.length} yêu cầu`}>
        {inflight.length === 0 ? (
          <div className="rounded-[10px] border border-dashed border-line px-3 py-6 text-center text-[13px] text-soft">
            Không có yêu cầu nào đang bay.
          </div>
        ) : (
          <table className={tableCls.table}>
            <thead>
              <tr>
                <th className={tableCls.th}>Thay đổi</th>
                <th className={tableCls.th}>Trước → sau</th>
                <th className={tableCls.th}>Trạng thái</th>
                <th className={tableCls.th}>Người yêu cầu</th>
                <th className={tableCls.th}>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {inflight.map((row) => (
                <Row
                  key={row.id}
                  row={row}
                  canDecide={canDecide}
                  busy={pending}
                  onDecide={(id, decision) => run(decideAdsChangeAction, { changeId: id, decision })}
                  onCancel={(id) => run(cancelAdsChangeAction, { changeId: id })}
                  onRevert={(id) => run(revertAdsChangeAction, { changeId: id })}
                />
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel
        title="Đã gửi Amazon — lịch sử &amp; REVERT 1 chạm"
        hint={`${done.length} dòng gần nhất · chỉ dòng CHƯA bị đảo mới có nút Revert`}
      >
        {done.length === 0 ? (
          <div className="rounded-[10px] border border-dashed border-line px-3 py-6 text-center text-[13px] text-soft">
            Chưa có thay đổi nào được gửi.
          </div>
        ) : (
          <table className={tableCls.table}>
            <thead>
              <tr>
                <th className={tableCls.th}>Thay đổi</th>
                <th className={tableCls.th}>Trước → sau</th>
                <th className={tableCls.th}>Kết quả Amazon</th>
                <th className={tableCls.th}>Ai · lúc nào</th>
                <th className={tableCls.th}>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {done.map((row) => (
                <Row
                  key={row.id}
                  row={row}
                  canDecide={canDecide}
                  busy={pending}
                  onDecide={(id, decision) => run(decideAdsChangeAction, { changeId: id, decision })}
                  onCancel={(id) => run(cancelAdsChangeAction, { changeId: id })}
                  onRevert={(id) => run(revertAdsChangeAction, { changeId: id })}
                />
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Nhật ký thao tác (iam.audit_logs)" hint="không xoá được · đọc từ view vexim_ads_audit">
        {audit.length === 0 ? (
          <div className="rounded-[10px] border border-dashed border-line px-3 py-6 text-center text-[13px] text-soft">
            Chưa có dòng nhật ký nào cho quảng cáo.
          </div>
        ) : (
          <table className={tableCls.table}>
            <thead>
              <tr>
                <th className={tableCls.th}>Lúc</th>
                <th className={tableCls.th}>Hành động</th>
                <th className={tableCls.th}>Đối tượng</th>
                <th className={tableCls.th}>Kết quả</th>
                <th className={tableCls.th}>Người thao tác</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((a) => (
                <tr key={a.id}>
                  <td className={tableCls.td}>{when(a.created_at)}</td>
                  <td className={tableCls.td}>{a.action}</td>
                  <td className={tableCls.td}>{a.entity ?? "—"}</td>
                  <td className={tableCls.td}>
                    {a.result ?? "—"}
                    {a.after_text ? <span className="text-soft"> · {a.after_text}</span> : null}
                  </td>
                  <td className={tableCls.td}>{a.actor_name ?? "hệ thống/worker"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
