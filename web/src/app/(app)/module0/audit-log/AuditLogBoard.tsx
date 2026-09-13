"use client";

import { useMemo, useState } from "react";
import { Chip, Panel, tableCls } from "@/components/ui";
import type { AdminAuditRow } from "@/lib/data/users-admin";
import { auditActionLabel, auditDiff, relativeTime } from "@/lib/users-model";

type Props = {
  audit: AdminAuditRow[];
  demo: boolean;
};

const PAGE_SIZE = 50;

export default function AuditLogBoard({ audit, demo }: Props) {
  const [filter, setFilter] = useState<string>("all");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);

  const actions = useMemo(() => {
    const set = new Set(audit.map((a) => a.action));
    return Array.from(set).sort();
  }, [audit]);

  const modules = useMemo(() => {
    const set = new Set(audit.map((a) => (a.module ?? "—")).filter(Boolean));
    return Array.from(set).sort();
  }, [audit]);

  const filtered = useMemo(() => {
    let list = audit;
    if (filter !== "all") {
      list = list.filter((a) => a.action === filter);
    }
    if (q.trim()) {
      const lower = q.trim().toLowerCase();
      list = list.filter((a) => {
        return (
          (a.entity ?? "").toLowerCase().includes(lower) ||
          (a.actorEmail ?? "").toLowerCase().includes(lower) ||
          (a.actorName ?? "").toLowerCase().includes(lower) ||
          (a.module ?? "").toLowerCase().includes(lower) ||
          (a.shop ?? "").toLowerCase().includes(lower) ||
          auditActionLabel(a.action).toLowerCase().includes(lower) ||
          auditDiff(a.beforeValue, a.afterValue).toLowerCase().includes(lower)
        );
      });
    }
    return list;
  }, [audit, filter, q]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageClamped = Math.min(page, totalPages - 1);
  const paged = filtered.slice(pageClamped * PAGE_SIZE, (pageClamped + 1) * PAGE_SIZE);

  return (
    <>
      <Panel
        title={`Nhật ký ${demo ? "(demo)" : "toàn hệ thống"}`}
        hint={
          demo
            ? "trống ở chế độ demo"
            : `iam.audit_logs · ${filtered.length}/${audit.length} bản ghi khớp · ${modules.length} module · append-only`
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <select
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setPage(0);
            }}
            className="h-8 rounded-full border border-line bg-card px-3 text-[12.5px] font-semibold"
          >
            <option value="all">Tất cả hành động ({audit.length})</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {auditActionLabel(a)} ({audit.filter((x) => x.action === a).length})
              </option>
            ))}
          </select>

          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(0);
            }}
            placeholder="Lọc nhanh: email, tên, module, shop, entity…"
            className="h-8 w-64 rounded-full border border-line bg-card px-3 text-[12.5px] outline-none focus:border-accent"
          />

          <span className="text-[11.5px] text-soft">
            Hiển thị {paged.length} / {filtered.length} (trang {pageClamped + 1}/{totalPages})
          </span>

          <div className="ml-auto flex gap-1">
            <button
              disabled={pageClamped === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="h-8 rounded-full border border-line bg-card px-3 text-[12px] font-bold disabled:opacity-50"
            >
              ← Trước
            </button>
            <button
              disabled={pageClamped >= totalPages - 1}
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              className="h-8 rounded-full border border-line bg-card px-3 text-[12px] font-bold disabled:opacity-50"
            >
              Sau →
            </button>
          </div>
        </div>

        {demo ? (
          <p className="text-[12.5px] text-soft">
            Chế độ demo không có nhật ký thật. Khi chạy Supabase, mọi thao tác mời/sửa/khóa/cấp quyền được ghi tại đây, phân trang {PAGE_SIZE} dòng/trang để không dài vô hạn.
          </p>
        ) : filtered.length === 0 ? (
          <p className="text-[12.5px] text-soft">
            Không có bản ghi nào khớp bộ lọc. Thử đổi hành động hoặc từ khoá tìm kiếm.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableCls.table}>
              <thead>
                <tr>
                  <th className={tableCls.th}>Thời gian</th>
                  <th className={tableCls.th}>Module</th>
                  <th className={tableCls.th}>Hành động</th>
                  <th className={tableCls.th}>Đối tượng</th>
                  <th className={tableCls.th}>Shop</th>
                  <th className={tableCls.th}>Người thao tác</th>
                  <th className={tableCls.th}>Thay đổi</th>
                  <th className={tableCls.th}>Kết quả</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((a) => (
                  <tr key={a.id}>
                    <td className={tableCls.td} title={a.createdAt ?? undefined}>
                      {relativeTime(a.createdAt)}
                    </td>
                    <td className={tableCls.td}>
                      <Chip tone="blue">{a.module ?? "—"}</Chip>
                    </td>
                    <td className={tableCls.td}>
                      <Chip tone={a.result === "ok" ? "green" : a.result === "error" ? "red" : "blue"}>
                        {auditActionLabel(a.action)}
                      </Chip>
                      <div className="mt-0.5 text-[10.5px] text-soft">{a.action}</div>
                    </td>
                    <td className={`${tableCls.td} font-bold`}>{a.entity ?? "—"}</td>
                    <td className={tableCls.td}>{a.shop ?? "—"}</td>
                    <td className={tableCls.td}>
                      <div className="font-semibold">{a.actorName ?? "—"}</div>
                      <div className="text-[11.5px] text-soft">{a.actorEmail ?? ""}</div>
                    </td>
                    <td className={`${tableCls.td} max-w-[360px] truncate text-[12px]`} title={auditDiff(a.beforeValue, a.afterValue)}>
                      {auditDiff(a.beforeValue, a.afterValue)}
                    </td>
                    <td className={tableCls.td}>
                      <Chip tone={a.result === "ok" ? "green" : "red"}>{a.result ?? "—"}</Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {filtered.length > PAGE_SIZE ? (
          <div className="mt-3 flex items-center justify-between text-[11.5px] text-soft">
            <span>
              Trang {pageClamped + 1}/{totalPages} · {filtered.length} bản ghi khớp · {audit.length} tổng
            </span>
            <div className="flex gap-1">
              <button
                disabled={pageClamped === 0}
                onClick={() => setPage(0)}
                className="h-7 rounded-full border border-line bg-card px-2.5 text-[11px] font-bold disabled:opacity-50"
              >
                Đầu
              </button>
              <button
                disabled={pageClamped === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="h-7 rounded-full border border-line bg-card px-2.5 text-[11px] font-bold disabled:opacity-50"
              >
                ←
              </button>
              <button
                disabled={pageClamped >= totalPages - 1}
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                className="h-7 rounded-full border border-line bg-card px-2.5 text-[11px] font-bold disabled:opacity-50"
              >
                →
              </button>
              <button
                disabled={pageClamped >= totalPages - 1}
                onClick={() => setPage(totalPages - 1)}
                className="h-7 rounded-full border border-line bg-card px-2.5 text-[11px] font-bold disabled:opacity-50"
              >
                Cuối
              </button>
            </div>
          </div>
        ) : null}
      </Panel>

      <Panel title="Quy tắc & Lưu ý" hint="append-only · không xoá được">
        <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-muted">
          <li>Nhật ký đã mở rộng toàn hệ thống: không chỉ <code>iam</code> mà còn <code>price</code>, <code>catalog</code>, <code>ads</code>, <code>inventory</code>, <code>sales</code>, <code>finance</code>…</li>
          <li>Bảng <code>iam.audit_logs</code> là append-only: không có UPDATE/DELETE, chỉ INSERT — nguồn sự thật cuối cùng.</li>
          <li>Mọi thao tác mời/sửa/khóa/cấp quyền và thao tác ghi ra Amazon (đổi giá, sửa listing, duyệt campaign) đều ghi lại.</li>
          <li>Phân trang {PAGE_SIZE} dòng/trang + bộ lọc theo module/hành động + tìm kiếm theo email/entity giúp tra cứu nhanh.</li>
          <li>Đổi giá ≤ 2%: operator tự duyệt · &gt;2%: trưởng phòng duyệt. Tăng budget campaign &gt;30%/ngày: trưởng phòng duyệt. Lô nhập hàng &gt;ngưỡng $: trưởng phòng Kho vận duyệt.</li>
        </ul>
      </Panel>
    </>
  );
}
