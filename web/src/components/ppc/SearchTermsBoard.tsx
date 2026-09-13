"use client";

/**
 * A3 — SEARCH TERM & GỢI Ý NEGATIVE (Module 5 phần 2 · SOP-04).
 *
 * Màn này trả lời đúng một câu hỏi của người vận hành: "từ khoá nào đang đốt tiền
 * mà không ra đơn, và tôi chặn nó bằng một cú bấm?"
 *
 *   • Bộ lọc MẶC ĐỊNH là luật SOP-04: có click (≥ 5), chi ≥ 10, 0 đơn trong 7 ngày.
 *   • Gợi ý (Exact/Phrase) do job tổng hợp sinh ra kèm bằng chứng; ở đây chỉ
 *     duyệt/từ chối. Duyệt ⇒ RPC tự sinh yêu cầu thêm negative → hàng đợi → worker
 *     → Amazon Ads API v3 (đi CÙNG một đường ghi với đổi bid/ngân sách).
 *   • Đã chặn rồi thì KHÔNG hiện nút thêm nữa (view trả `negative_keyword_id`) —
 *     tránh tạo yêu cầu trùng mà Amazon cũng sẽ từ chối.
 */

import { useMemo, useState, useTransition } from "react";

import { decideSuggestionAction } from "@/app/(app)/ppc/actions";
import { ChangeForm } from "@/components/ppc/ChangeForm";
import { Chip, Panel, tableCls } from "@/components/ui";
import {
  A3_DEFAULT_FILTER,
  a3Evidence,
  adsMoney,
  adsNum,
  adsPct,
  filterSearchTerms,
  matchTypeLabel,
  suggestionShortLabel,
  type AdsSearchTermRaw,
} from "@/lib/data/ppc-model";

type Props = {
  rows: AdsSearchTermRaw[];
  /** Có quyền duyệt gợi ý (trưởng phòng PPC / CEO) — DB vẫn là chốt cuối. */
  canDecide: boolean;
  /** Cố định theo campaign khi mở từ A2. */
  campaignId?: string | null;
  campaignName?: string | null;
};

export function SearchTermsBoard({ rows, canDecide, campaignId, campaignName }: Props) {
  const [q, setQ] = useState("");
  const [minSpend, setMinSpend] = useState(String(A3_DEFAULT_FILTER.minSpend));
  const [minClicks, setMinClicks] = useState(String(A3_DEFAULT_FILTER.minClicks));
  const [onlyNoOrders, setOnlyNoOrders] = useState(true);
  const [onlyReady, setOnlyReady] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const filtered = useMemo(
    () =>
      filterSearchTerms(rows, {
        q,
        minSpend: Number(minSpend) || 0,
        minClicks: Number(minClicks) || 0,
        onlyNoOrders,
        campaignId: campaignId ?? undefined,
      }),
    [rows, q, minSpend, minClicks, onlyNoOrders, campaignId],
  );

  const shown = useMemo(
    () =>
      onlyReady
        ? filtered.filter((r) => r.negative_keyword_id === null && r.pending_suggestion_id === null)
        : filtered,
    [filtered, onlyReady],
  );

  const totals = useMemo(() => {
    let spend = 0;
    let clicks = 0;
    let blocked = 0;
    for (const r of shown) {
      spend += Number(r.spend_7d ?? 0);
      clicks += Number(r.clicks_7d ?? 0);
      if (r.negative_keyword_id) blocked += 1;
    }
    return { spend, clicks, blocked };
  }, [shown]);

  function decide(suggestionId: string, decision: "approve" | "reject" | "dismiss", term: string | null) {
    startTransition(async () => {
      setMsg(null);
      const fd = new FormData();
      fd.set("suggestionId", suggestionId);
      fd.set("decision", decision);
      fd.set("note", `A3 · ${decision} gợi ý cho "${term ?? ""}"`);
      const res = await decideSuggestionAction(fd);
      setMsg({ ok: res.ok, text: res.message });
    });
  }

  return (
    <>
      {msg ? (
        <div
          className={`mb-3 rounded-[10px] px-3.5 py-2.5 text-[13px] font-semibold ${
            msg.ok ? "bg-green-soft text-[#0b7a55]" : "bg-red-soft text-[#a01717]"
          }`}
        >
          {msg.text}
        </div>
      ) : null}

      <Panel
        title="Bộ lọc SOP-04 — search term đốt tiền"
        hint={campaignName ? `đang xem campaign: ${campaignName}` : "mặc định: ≥ 5 click · chi ≥ 10 · 0 đơn / 7 ngày"}
      >
        <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Tìm search term / từ khoá / ad group"
            className="w-64 rounded-lg border border-line bg-card px-3 py-1.5"
          />
          <label className="flex items-center gap-1 font-semibold text-muted">
            Chi ≥
            <input
              value={minSpend}
              onChange={(e) => setMinSpend(e.target.value)}
              inputMode="decimal"
              className="w-20 rounded-lg border border-line bg-card px-2 py-1.5"
            />
          </label>
          <label className="flex items-center gap-1 font-semibold text-muted">
            Click ≥
            <input
              value={minClicks}
              onChange={(e) => setMinClicks(e.target.value)}
              inputMode="numeric"
              className="w-16 rounded-lg border border-line bg-card px-2 py-1.5"
            />
          </label>
          <label className="flex items-center gap-1.5 font-semibold text-muted">
            <input type="checkbox" checked={onlyNoOrders} onChange={(e) => setOnlyNoOrders(e.target.checked)} />
            Chỉ dòng 0 đơn
          </label>
          <label className="flex items-center gap-1.5 font-semibold text-muted">
            <input type="checkbox" checked={onlyReady} onChange={(e) => setOnlyReady(e.target.checked)} />
            Chỉ dòng chưa có gợi ý / chưa chặn
          </label>
          <span className="text-soft">
            {shown.length}/{rows.length} dòng · chi {adsMoney(totals.spend, rows[0]?.currency ?? "")} ·{" "}
            {adsNum(totals.clicks)} click · {totals.blocked} đã chặn
          </span>
        </div>
      </Panel>

      <Panel
        title="Search term &amp; gợi ý Negative (Exact / Phrase)"
        hint="gợi ý do job tổng hợp sinh kèm bằng chứng · duyệt là vào hàng đợi ghi Amazon"
      >
        {shown.length === 0 ? (
          <div className="rounded-[10px] border border-dashed border-line px-3 py-6 text-center text-[13px] text-soft">
            Không có dòng nào khớp bộ lọc. Đây là tin TỐT: không có search term nào đốt tiền mà không ra đơn ở
            ngưỡng hiện tại. (Cần dữ liệu thì chạy <code>npm run worker:ads-pull -- --kind=search-terms</code>.)
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableCls.table}>
              <thead>
                <tr>
                  <th className={tableCls.th}>Search term</th>
                  <th className={tableCls.th}>Từ khoá · ad group</th>
                  <th className={`${tableCls.th} text-right`}>Chi 7d</th>
                  <th className={`${tableCls.th} text-right`}>Click · CPC</th>
                  <th className={`${tableCls.th} text-right`}>Đơn · ACOS</th>
                  <th className={tableCls.th}>Gợi ý / đã chặn</th>
                  <th className={tableCls.th}>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const blocked = r.negative_keyword_id !== null;
                  return (
                    <tr key={`${r.seller_account_id}-${r.campaign_id}-${r.ad_group_id}-${r.term}-${r.match_type}`}>
                      <td className={tableCls.td}>
                        <div className="font-bold">{r.term}</div>
                        <div className="text-[11.5px] text-soft">{a3Evidence(r)}</div>
                        {r.last_order_day ? (
                          <div className="text-[11px] text-soft">Đơn cuối: {r.last_order_day}</div>
                        ) : (
                          <div className="text-[11px] font-semibold text-amber">Chưa ra đơn lần nào trong dữ liệu</div>
                        )}
                      </td>
                      <td className={tableCls.td}>
                        <div className="text-[12px]">{r.keyword_text ?? "—"}</div>
                        <div className="text-[11px] text-soft">
                          {matchTypeLabel(r.match_type)} · {r.ad_group_name ?? r.ad_group_id}
                        </div>
                        <div className="text-[11px] text-soft">{r.campaign_name ?? r.campaign_id}</div>
                      </td>
                      <td className={tableCls.tdNum}>{adsMoney(r.spend_7d, r.currency ?? "")}</td>
                      <td className={tableCls.tdNum}>
                        <div>{adsNum(r.clicks_7d)}</div>
                        <div className="text-[11px] text-soft">{adsMoney(r.cpc_7d, r.currency ?? "")}</div>
                      </td>
                      <td className={tableCls.tdNum}>
                        <div>{adsNum(r.purchases_7d)}</div>
                        <div className="text-[11px] text-soft">{adsPct(r.acos_7d)}</div>
                      </td>
                      <td className={tableCls.td}>
                        {blocked ? (
                          <>
                            <Chip tone="green">đã chặn</Chip>
                            <div className="mt-0.5 text-[11px] text-soft">
                              {matchTypeLabel(r.negative_match_type)} · có trong gương DB
                            </div>
                          </>
                        ) : r.pending_suggestion_id ? (
                          <>
                            <Chip tone="amber">{suggestionShortLabel(r.pending_suggestion_type)}</Chip>
                            <div className="mt-0.5 text-[11px] text-soft">
                              Tin cậy: {r.pending_confidence_label ?? r.pending_confidence ?? "—"}
                            </div>
                            {Array.isArray(r.pending_reasons) && r.pending_reasons.length > 0 ? (
                              <ul className="mt-0.5 list-disc pl-4 text-[11px] text-soft">
                                {(r.pending_reasons as unknown[]).slice(0, 3).map((why, i) => (
                                  <li key={i}>{String(why)}</li>
                                ))}
                              </ul>
                            ) : null}
                          </>
                        ) : (
                          <Chip tone="gray">không có gợi ý</Chip>
                        )}
                      </td>
                      <td className={tableCls.td}>
                        {r.pending_suggestion_id ? (
                          <div className="flex flex-col gap-1.5">
                            {canDecide ? (
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  disabled={pending}
                                  onClick={() => decide(r.pending_suggestion_id as string, "approve", r.term)}
                                  className="rounded-lg bg-green px-2.5 py-1 text-[12px] font-bold text-white disabled:opacity-60"
                                >
                                  Duyệt &amp; chặn
                                </button>
                                <button
                                  type="button"
                                  disabled={pending}
                                  onClick={() => decide(r.pending_suggestion_id as string, "reject", r.term)}
                                  className="rounded-lg border border-line px-2.5 py-1 text-[12px] font-bold text-muted disabled:opacity-60"
                                >
                                  Từ chối
                                </button>
                              </div>
                            ) : (
                              <span className="text-[11.5px] text-soft">Chờ trưởng phòng PPC quyết định</span>
                            )}
                          </div>
                        ) : blocked ? (
                          <span className="text-[11.5px] text-soft">Không cần làm gì thêm</span>
                        ) : (
                          <ChangeForm
                            sellerAccountId={r.seller_account_id}
                            action="add_negative_exact"
                            entityType="search_term"
                            entityKey={r.term ?? ""}
                            campaignId={r.campaign_id}
                            adGroupId={r.ad_group_id}
                            label={r.term ?? r.keyword_text ?? ""}
                            valueLabel="Chữ cần chặn"
                            defaultValue={r.term ?? ""}
                            submitLabel="Chặn (Exact)"
                            hint="Negative không cần duyệt ngưỡng — nhưng vẫn vào hàng đợi ghi để có audit."
                            inputWidth="w-44"
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
