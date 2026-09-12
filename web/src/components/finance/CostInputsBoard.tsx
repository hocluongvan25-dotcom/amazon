"use client";

/**
 * CostInputsBoard — nhập & quản lý GIÁ VỐN theo bậc hiệu lực (Đợt A).
 *
 * Đây là chỗ gỡ chặn F3 (giá trị khiếu nại), F4 (lãi theo SKU) và P1 (giá sàn):
 * thiếu giá vốn thì ba màn đó chỉ hiện "—", nên trang này phải NHẬP ĐƯỢC THẬT.
 *
 * Ghi dữ liệu đi qua Server Action → RPC migration 0016. Quyền do
 * `iam.can_write_seller_account()` + `iam.is_cost_editor()` chốt ở DB; UI chỉ
 * ẩn/hiện cho đỡ nhầm, KHÔNG phải nơi phân quyền.
 */

import { Fragment, useMemo, useState, useTransition, type ChangeEvent } from "react";
import { Chip, Panel, tableCls } from "@/components/ui";
import {
  closeCostInputAction,
  deleteCostInputAction,
  importCostInputsAction,
  saveCostInputAction,
  type CostActionResult,
} from "@/app/(app)/finance/costs/actions";
import {
  COST_CURRENCIES,
  COST_IMPORT_COLUMNS,
  COST_SOURCE_VI,
  groupCostLadder,
  parseCostImportCsv,
  type CostCoverageRow,
  type CostImportError,
  type CostInputRow,
} from "@/lib/data/cost-model";
import { money } from "@/lib/data/finance-model";

const inputCls =
  "w-full rounded-lg border border-line bg-card px-2.5 py-1.5 text-[12.5px] outline-none focus:border-ink";
const labelCls = "mb-1 block text-[11px] font-bold uppercase tracking-wide text-soft";
const btnPrimary =
  "rounded-full bg-ink px-4 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-50";
const btnGhost =
  "rounded-full border border-line px-3 py-1 text-[11.5px] font-semibold text-muted hover:border-ink hover:text-ink disabled:opacity-50";

type Notice = { tone: "green" | "red"; text: string; errors?: CostImportError[] };

export function CostInputsBoard({
  inputs,
  coverage,
  shops,
  canWrite,
  canDelete,
}: {
  inputs: CostInputRow[];
  coverage: CostCoverageRow[];
  shops: { id: string; name: string }[];
  canWrite: boolean;
  canDelete: boolean;
}) {
  const [shopId, setShopId] = useState(shops[0]?.id ?? "");
  const [q, setQ] = useState("");
  const [onlyCurrent, setOnlyCurrent] = useState(true);
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<Notice | null>(null);

  /* ---------- form nhập tay ---------- */
  const [sku, setSku] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [currency, setCurrency] = useState<string>("USD");
  const [effectiveFrom, setEffectiveFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [effectiveTo, setEffectiveTo] = useState("");
  const [note, setNote] = useState("");

  /* ---------- import CSV ---------- */
  const [csvText, setCsvText] = useState("");
  const [csvName, setCsvName] = useState("");
  const [csvPreview, setCsvPreview] = useState<ReturnType<typeof parseCostImportCsv> | null>(null);

  const shopName = shops.find((s) => s.id === shopId)?.name ?? "";
  const shopCurrency = coverage.find((c) => c.seller_account_id === shopId)?.currency ?? "USD";

  const ladder = useMemo(() => groupCostLadder(inputs.filter((r) => r.seller_account_id === shopId)), [inputs, shopId]);

  const ladderRows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return ladder
      .filter((g) => (needle ? g.sku.toLowerCase().includes(needle) : true))
      .filter((g) =>
        onlyCurrent
          ? g.steps.some((s) => (s.effective_from ?? "") <= todayIso() && (s.effective_to === null || s.effective_to > todayIso()))
          : true,
      );
  }, [ladder, q, onlyCurrent]);

  const missing = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return coverage
      .filter((c) => c.seller_account_id === shopId)
      .filter((c) => c.missing_cost === true || c.unit_cost === null || c.currency_mismatch === true)
      .filter((c) => (needle ? c.sku.toLowerCase().includes(needle) : true))
      .sort((a, b) => a.sku.localeCompare(b.sku));
  }, [coverage, shopId, q]);

  const run = (fn: (formData: FormData) => Promise<CostActionResult>, build: (fd: FormData) => void) => {
    if (!canWrite) {
      setNotice({ tone: "red", text: "DEMO MODE — chưa nối Supabase nên không ghi được giá vốn." });
      return;
    }
    const fd = new FormData();
    build(fd);
    startTransition(async () => {
      const result = await fn(fd);
      setNotice({ tone: result.ok ? "green" : "red", text: result.message, errors: result.errors });
    });
  };

  const onPickFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setCsvText(text);
    setCsvName(file.name);
    setCsvPreview(parseCostImportCsv(text));
    setNotice(null);
  };

  const submitManual = () => {
    run(saveCostInputAction, (fd) => {
      fd.set("sellerAccountId", shopId);
      fd.set("sku", sku);
      fd.set("unitCost", unitCost);
      fd.set("currency", currency);
      fd.set("effectiveFrom", effectiveFrom);
      fd.set("effectiveTo", effectiveTo);
      fd.set("note", note);
    });
    setSku("");
    setUnitCost("");
    setNote("");
  };

  const submitImport = () => {
    run(importCostInputsAction, (fd) => {
      fd.set("sellerAccountId", shopId);
      fd.set("sourceRef", csvName);
      fd.set("csvText", csvText);
    });
    setCsvText("");
    setCsvName("");
    setCsvPreview(null);
  };

  /** Bấm "Nhập" từ panel thiếu giá vốn → điền sẵn form cho SKU đó. */
  const prefill = (row: CostCoverageRow) => {
    setSku(row.sku);
    setCurrency(row.currency ?? shopCurrency);
    setEffectiveFrom(todayIso());
    setEffectiveTo("");
    setNote(row.currency_mismatch ? `Lệch tiền tệ: giá vốn đang ghi bằng ${row.cost_currency ?? "?"}` : "");
    setShopId(row.seller_account_id);
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  return (
    <>
      {notice ? (
        <div
          className={`mb-4 rounded-[13px] border px-4 py-3 text-[12.5px] ${
            notice.tone === "green" ? "border-green bg-green-soft text-[#0b7a55]" : "border-red bg-red-soft text-[#a01717]"
          }`}
        >
          <div className="font-bold">{notice.text}</div>
          {notice.errors && notice.errors.length > 0 ? (
            <ul className="mt-1.5 grid gap-0.5 text-[12px]">
              {notice.errors.slice(0, 12).map((e, i) => (
                <li key={i}>
                  <span className="font-semibold">Dòng {e.line || "header"}</span>
                  {e.sku ? ` · ${e.sku}` : ""} — {e.message}
                </li>
              ))}
              {notice.errors.length > 12 ? <li className="text-soft">… và {notice.errors.length - 12} lỗi khác</li> : null}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* ================= BỘ LỌC CHUNG ================= */}
      <div className="mb-4 flex flex-wrap items-end gap-2 rounded-[13px] border border-line bg-card px-4 py-3">
        <div>
          <label className={labelCls} htmlFor="cost-shop">Shop</label>
          <select id="cost-shop" value={shopId} onChange={(e) => setShopId(e.target.value)} className={inputCls}>
            {shops.length === 0 ? <option value="">(chưa có shop nào đọc được)</option> : null}
            {shops.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
        <div className="min-w-56 flex-1">
          <label className={labelCls} htmlFor="cost-q">Tìm SKU</label>
          <input id="cost-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="vd: TG-LUG-20-BLK" className={inputCls} />
        </div>
        <label className="flex items-center gap-1.5 pb-2 text-[12px] font-semibold text-muted">
          <input type="checkbox" checked={onlyCurrent} onChange={(e) => setOnlyCurrent(e.target.checked)} />
          chỉ SKU đang có bậc áp dụng
        </label>
        {!canWrite ? (
          <div className="pb-2 text-[12px] font-bold text-amber">DEMO MODE — chỉ xem, không ghi</div>
        ) : null}
      </div>

      {/* ================= NHẬP TAY ================= */}
      <Panel title="Nhập một bậc giá vốn" hint={`${shopName || "chưa chọn shop"} · bậc mới tự cắt ngọn bậc cũ`}>
        <div className="grid gap-3 md:grid-cols-6">
          <div className="md:col-span-2">
            <label className={labelCls} htmlFor="cost-sku">SKU *</label>
            <input id="cost-sku" value={sku} onChange={(e) => setSku(e.target.value)} placeholder="TG-LUG-20-BLK" className={inputCls} />
          </div>
          <div>
            <label className={labelCls} htmlFor="cost-amount">Giá vốn/đơn vị *</label>
            <input id="cost-amount" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} placeholder="41.50" className={inputCls} />
          </div>
          <div>
            <label className={labelCls} htmlFor="cost-currency">Tiền tệ</label>
            <select id="cost-currency" value={currency} onChange={(e) => setCurrency(e.target.value)} className={inputCls}>
              {COST_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="cost-from">Hiệu lực từ *</label>
            <input id="cost-from" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls} htmlFor="cost-to">Đến (trống = còn hiệu lực)</label>
            <input id="cost-to" type="date" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} className={inputCls} />
          </div>
          <div className="md:col-span-5">
            <label className={labelCls} htmlFor="cost-note">Ghi chú</label>
            <input id="cost-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="vd: giá FOB lô T9, chưa gồm phí đầu VN" className={inputCls} />
          </div>
          <div className="flex items-end pb-1">
            <button type="button" className={btnPrimary} disabled={pending || !canWrite || !shopId} onClick={submitManual}>
              {pending ? "Đang ghi…" : "Lưu giá vốn"}
            </button>
          </div>
        </div>
        <p className="mt-2 text-[11.5px] text-soft">
          Giá vốn được lưu theo khoảng hiệu lực nên F4 vẫn tính đúng lãi của đơn bán ở tháng trước.
          Quyền ghi do <code>iam.is_cost_editor()</code> quyết định ở database.
        </p>
      </Panel>

      {/* ================= IMPORT CSV ================= */}
      <Panel title="Import hàng loạt theo template CSV" hint={`tối đa 500 dòng · all-or-nothing · nguồn: ${csvName || "chưa chọn file"}`}>
        <div className="flex flex-wrap items-center gap-3">
          <a href="/api/finance/cost-template" className={btnGhost} download>
            ⬇ Tải template CSV
          </a>
          <label className={btnGhost}>
            Chọn file CSV
            <input type="file" accept=".csv,text/csv" onChange={onPickFile} className="hidden" />
          </label>
          <button type="button" className={btnPrimary} disabled={pending || !canWrite || !shopId || !csvText} onClick={submitImport}>
            {pending ? "Đang import…" : "Ghi vào hệ thống"}
          </button>
        </div>

        {csvPreview ? (
          <div className="mt-3">
            <div className="flex flex-wrap gap-2 text-[12px]">
              <Chip tone={csvPreview.errors.length === 0 ? "green" : "red"}>
                {csvPreview.rows.length} dòng hợp lệ
              </Chip>
              {csvPreview.errors.length > 0 ? <Chip tone="red">{csvPreview.errors.length} lỗi</Chip> : null}
              {csvPreview.skipped > 0 ? <Chip tone="amber">{csvPreview.skipped} dòng bỏ qua</Chip> : null}
            </div>

            {csvPreview.errors.length > 0 ? (
              <ul className="mt-2 grid gap-0.5 rounded-lg border border-red bg-red-soft px-3 py-2 text-[12px] text-[#a01717]">
                {csvPreview.errors.slice(0, 8).map((e, i) => (
                  <li key={i}>
                    <span className="font-bold">Dòng {e.line || "header"}</span>
                    {e.sku ? ` · ${e.sku}` : ""} — {e.message}
                  </li>
                ))}
                {csvPreview.errors.length > 8 ? <li className="text-soft">… và {csvPreview.errors.length - 8} lỗi khác</li> : null}
                <li className="mt-1 font-semibold">Có lỗi thì KHÔNG ghi dòng nào — sửa file rồi chọn lại.</li>
              </ul>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className={tableCls.table}>
                  <thead>
                    <tr>
                      {COST_IMPORT_COLUMNS.map((c) => <th key={c} className={tableCls.th}>{c}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {csvPreview.rows.slice(0, 8).map((r, i) => (
                      <tr key={i}>
                        <td className={`${tableCls.td} font-bold`}>{r.sku}</td>
                        <td className={tableCls.tdNum}>{r.unit_cost}</td>
                        <td className={tableCls.td}>{r.currency}</td>
                        <td className={tableCls.td}>{r.effective_from}</td>
                        <td className={tableCls.td}>{r.effective_to || "—"}</td>
                        <td className={tableCls.td}>{r.note || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {csvPreview.rows.length > 8 ? (
                  <p className="mt-1 text-[11.5px] text-soft">… và {csvPreview.rows.length - 8} dòng khác (xem đủ khi ghi).</p>
                ) : null}
              </div>
            )}
          </div>
        ) : (
          <p className="mt-2 text-[11.5px] text-soft">
            Cột bắt buộc: <code>sku</code>, <code>unit_cost</code>, <code>effective_from</code> · tuỳ chọn:{" "}
            <code>currency</code>, <code>effective_to</code>, <code>note</code>. Ngày dùng YYYY-MM-DD (hoặc DD/MM/YYYY) —
            KHÔNG dùng MM/DD/YYYY vì mơ hồ.
          </p>
        )}
      </Panel>

      {/* ================= ĐANG CHẶN F3/F4/P1 ================= */}
      <Panel
        title="SKU đang bán nhưng chưa dùng được giá vốn"
        hint={`${missing.length} SKU · đây là danh sách cần gỡ chặn`}
      >
        {missing.length === 0 ? (
          <p className="text-[12.5px] text-[#0b7a55]">
            Không còn SKU nào thiếu giá vốn ở {shopName || "shop này"} — F3/F4/P1 tính được đủ.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableCls.table}>
              <thead>
                <tr>
                  <th className={tableCls.th}>SKU</th>
                  <th className={tableCls.th}>ASIN</th>
                  <th className={tableCls.th}>Trạng thái listing</th>
                  <th className={`${tableCls.th} text-right`}>Giá bán</th>
                  <th className={tableCls.th}>Vấn đề</th>
                  <th className={tableCls.th}></th>
                </tr>
              </thead>
              <tbody>
                {missing.slice(0, 50).map((c) => (
                  <tr key={`${c.seller_account_id}-${c.sku}`}>
                    <td className={`${tableCls.td} font-bold`}>{c.sku}</td>
                    <td className={tableCls.td}>{c.asin ?? "—"}</td>
                    <td className={tableCls.td}>{c.status ?? "—"}</td>
                    <td className={tableCls.tdNum}>{money(c.price, c.currency ?? "")}</td>
                    <td className={tableCls.td}>
                      {c.missing_cost ? (
                        <Chip tone="red">thiếu giá vốn</Chip>
                      ) : (
                        <Chip tone="amber">lệch tiền tệ ({c.cost_currency} ≠ {c.currency})</Chip>
                      )}
                    </td>
                    <td className={tableCls.td}>
                      <button type="button" className={btnGhost} onClick={() => prefill(c)} disabled={!canWrite}>
                        Nhập giá vốn
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {missing.length > 50 ? (
              <p className="mt-1 text-[11.5px] text-soft">Hiển thị 50/{missing.length} — lọc theo SKU hoặc import CSV.</p>
            ) : null}
          </div>
        )}
      </Panel>

      {/* ================= THANG GIÁ VỐN ================= */}
      <Panel title="Thang giá vốn theo SKU" hint={`${ladderRows.length}/${ladder.length} SKU · ${shopName}`}>
        {ladderRows.length === 0 ? (
          <p className="text-[12.5px] text-soft">
            Chưa có bậc giá vốn nào{q ? ` khớp "${q}"` : ""}. Nhập tay ở trên hoặc import CSV.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableCls.table}>
              <thead>
                <tr>
                  <th className={tableCls.th}>SKU</th>
                  <th className={`${tableCls.th} text-right`}>Giá vốn</th>
                  <th className={tableCls.th}>Hiệu lực</th>
                  <th className={tableCls.th}>Nguồn</th>
                  <th className={tableCls.th}>Ghi chú</th>
                  <th className={tableCls.th}>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {ladderRows.map((g) => (
                  <Fragment key={`${g.sellerAccountId}-${g.sku}`}>
                    {g.steps.map((s, idx) => {
                      const isCurrent = s.is_current ?? ((s.effective_from ?? "") <= todayIso() && (s.effective_to === null || s.effective_to > todayIso()));
                      const isFuture = (s.effective_from ?? "") > todayIso();
                      return (
                        <tr key={s.id} className={isCurrent ? "bg-accent-soft" : undefined}>
                          <td className={`${tableCls.td} font-bold`}>
                            {idx === 0 ? g.sku : ""}
                            {idx === 0 ? (
                              <span className="ml-2 align-middle">
                                {isCurrent ? <Chip tone="green">đang áp dụng</Chip> : null}
                                {isFuture ? <Chip tone="blue">sắp hiệu lực</Chip> : null}
                              </span>
                            ) : null}
                          </td>
                          <td className={tableCls.tdNum}>{money(s.unit_cost, s.currency)}</td>
                          <td className={tableCls.td}>
                            <span className="tabular-nums">{s.effective_from ?? "—"}</span>
                            <span className="text-soft"> → </span>
                            <span className="tabular-nums">{s.effective_to ?? "còn hiệu lực"}</span>
                          </td>
                          <td className={tableCls.td}>{COST_SOURCE_VI[s.source ?? ""] ?? s.source ?? "—"}</td>
                          <td className={`${tableCls.td} max-w-[220px] truncate text-soft`} title={s.note ?? ""}>
                            {s.note ?? "—"}
                          </td>
                          <td className={tableCls.td}>
                            <div className="flex gap-1.5">
                              <CloseButton
                                step={s}
                                disabled={!canWrite || pending}
                                onClose={(to, closeNote) =>
                                  run(closeCostInputAction, (fd) => {
                                    fd.set("costInputId", s.id);
                                    fd.set("effectiveTo", to);
                                    fd.set("note", closeNote);
                                  })
                                }
                              />
                              {canDelete ? (
                                <button
                                  type="button"
                                  className={btnGhost}
                                  disabled={pending}
                                  onClick={() => {
                                    if (typeof window !== "undefined" && !window.confirm(`Xoá bậc giá vốn ${g.sku} từ ${s.effective_from}?`)) return;
                                    run(deleteCostInputAction, (fd) => fd.set("costInputId", s.id));
                                  }}
                                >
                                  Xoá
                                </button>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

/** Nút "Kết thúc hiệu lực" — hỏi ngày chốt rồi mới gọi action (không xoá lịch sử). */
function CloseButton({
  step,
  disabled,
  onClose,
}: {
  step: CostInputRow;
  disabled: boolean;
  onClose: (effectiveTo: string, note: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(() => todayIso());
  const [closeNote, setCloseNote] = useState("");

  if (step.effective_to) {
    return <span className="text-[11.5px] text-soft">đã kết thúc {step.effective_to}</span>;
  }
  if (!open) {
    return (
      <button type="button" className={btnGhost} disabled={disabled} onClick={() => setOpen(true)}>
        Kết thúc
      </button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-36 rounded-lg border border-line bg-card px-2 py-1 text-[11.5px]" />
      <input
        value={closeNote}
        onChange={(e) => setCloseNote(e.target.value)}
        placeholder="lý do (tuỳ ý)"
        className="w-40 rounded-lg border border-line bg-card px-2 py-1 text-[11.5px]"
      />
      <button
        type="button"
        className={btnGhost}
        disabled={disabled}
        onClick={() => {
          onClose(to, closeNote);
          setOpen(false);
        }}
      >
        Chốt
      </button>
      <button type="button" className={btnGhost} onClick={() => setOpen(false)}>
        Huỷ
      </button>
    </span>
  );
}

/** Hôm nay theo ngày UTC — cùng quy ước với view (current_date trên server DB). */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
