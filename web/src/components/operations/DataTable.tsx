"use client";
import { useState } from "react";
import { Panel, tableCls } from "@/components/ui";
import {
  filterRows,
  money,
  text,
  totals,
  type Column,
  type DataRow,
} from "@/lib/data/operations-model";

export function DataTable({
  rows,
  columns,
  title,
  amount,
  events = false,
}: {
  rows: DataRow[];
  columns: Column[];
  title: string;
  amount?: string;
  events?: boolean;
}) {
  const [filters, setFilters] = useState({
    q: "",
    shop: "",
    status: "",
    type: "",
  });
  const [page, setPage] = useState(0);
  const filtered = filterRows(rows, filters);
  const pages = Math.max(1, Math.ceil(filtered.length / 50));
  const current = Math.min(page, pages - 1);
  const change = (key: keyof typeof filters, value: string) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(0);
  };
  const options = (key: string) =>
    [
      ...new Set(
        rows
          .map((r) => (typeof r[key] === "string" ? (r[key] as string) : ""))
          .filter(Boolean),
      ),
    ].sort();
  return (
    <Panel
      title={title}
      hint={`${filtered.length} bản ghi · toàn bộ kỳ có trong DB, không phải riêng hôm nay`}
    >
      <div className="mb-4 flex flex-wrap gap-3 text-sm">
        <input
          aria-label="Tìm mã đơn, SKU hoặc kỳ"
          placeholder="Tìm mã đơn, SKU, kỳ…"
          value={filters.q}
          onChange={(e) => change("q", e.target.value)}
          className="rounded border border-line p-2"
        />
        <select
          aria-label="Lọc shop"
          value={filters.shop}
          onChange={(e) => change("shop", e.target.value)}
          className="rounded border border-line p-2"
        >
          <option value="">Tất cả shop</option>
          {options("seller_account_id").map((id) => (
            <option key={id} value={id}>
              {text(rows.find((r) => r.seller_account_id === id)?.shop)} ·{" "}
              {id.slice(0, 8)}
            </option>
          ))}
        </select>
        {options("status").length > 0 && (
          <select
            aria-label="Lọc trạng thái"
            value={filters.status}
            onChange={(e) => change("status", e.target.value)}
            className="rounded border border-line p-2"
          >
            <option value="">Tất cả trạng thái</option>
            {options("status").map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        )}
        {events && (
          <select
            aria-label="Lọc loại dòng tiền"
            value={filters.type}
            onChange={(e) => change("type", e.target.value)}
            className="rounded border border-line p-2"
          >
            <option value="">Tất cả loại</option>
            {options("event_type").map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        )}
      </div>
      {amount && (
        <div className="mb-4 text-sm">
          <b>
            Tổng giá trị các bản ghi đang lọc
            {events ? " (loại Transfer để tránh cộng kép)" : ""}:
          </b>
          {totals(filtered, amount, events).map((g) => (
            <p key={g.currency}>
              {money(g.total, g.currency)}
              {g.missing
                ? ` · ${g.missing} bản ghi thiếu số tiền (tổng chưa đầy đủ)`
                : ""}
            </p>
          ))}
          <p className="text-muted">
            Không quy đổi tiền tệ; không phải lợi nhuận hay số dư ngân hàng.
          </p>
        </div>
      )}
      {!filtered.length ? (
        <p role="status">
          {rows.length
            ? "Không có kết quả khớp bộ lọc."
            : "Chưa có dữ liệu trong phạm vi được phép đọc. Cần đồng bộ report; không dùng dữ liệu demo thay thế."}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className={tableCls.table}>
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.key} className={tableCls.th}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.slice(current * 50, current * 50 + 50).map((row) => (
                  <tr key={row.id}>
                    {columns.map((c) => (
                      <td key={c.key} className={tableCls.td}>
                        {c.link ? (
                          <a
                            className="text-accent-ink underline"
                            href={`${c.link}?id=${encodeURIComponent(row.id)}`}
                          >
                            {text(row[c.key])}
                          </a>
                        ) : c.money ? (
                          money(row[c.key], row[c.money])
                        ) : (
                          text(row[c.key])
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex gap-4 text-sm">
            <button
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              ← Trước
            </button>
            <span>
              Trang {current + 1}/{pages}
            </span>
            <button
              disabled={current + 1 >= pages}
              onClick={() => setPage(current + 1)}
            >
              Sau →
            </button>
          </div>
        </>
      )}
    </Panel>
  );
}
