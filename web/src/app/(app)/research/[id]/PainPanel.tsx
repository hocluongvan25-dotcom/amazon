"use client";

/**
 * Module 8 G4 — Tab/Section 3: phân cụm điểm đau từ review 1–3★.
 *
 * Gồm 4 khối theo đặc tả:
 *   1. review_cluster_table — pain theo 3 cụm (tần suất/nghiêm trọng/ưu tiên)
 *   2. quote_list           — trích dẫn truy gốc ASIN–sao–ngày–link Amazon
 *   3. spec_sheet           — yêu cầu cho xưởng, nhãn llm_suggested chờ người ký
 *   4. impact×effort matrix — ma trận chọn thứ tự khắc phục
 *
 * Con số tần suất/nghiêm trọng do hệ thống tính lại, KHÔNG lấy nguyên từ LLM;
 * mọi câu trích dẫn đã được đối chiếu nguyên văn ở worker + trigger DB.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Chip, Panel, tableCls } from "@/components/ui";
import type { PainData } from "@/lib/data/research-pain";
import type { PainClusterCode, PainItem, PainPriority } from "@/lib/research/domain";
import { enqueueAnalyzeAction, updatePainItemAction } from "../actions";

const PRIORITY_TONE: Record<PainPriority, "red" | "amber" | "gray"> = {
  must: "red",
  should: "amber",
  skip: "gray",
};
const PRIORITY_LABEL: Record<PainPriority, string> = {
  must: "Must — bắt buộc",
  should: "Should — nên làm",
  skip: "Skip — hoãn",
};
const CLUSTER_TONE: Record<PainClusterCode, "red" | "amber" | "gray"> = {
  quality: "red",
  logistics: "amber",
  expectation_gap: "gray",
};
const fmtUsd = (n: number): string =>
  n === 0 ? "$0" : n < 0.01 ? `<$0.01` : `$${n.toFixed(4)}`;

function Stars({ value }: { value: number | null }) {
  if (value === null || value === undefined) return <span className="text-muted">—</span>;
  return <span className="font-bold">{value.toFixed(1)}★</span>;
}

function QuoteList({ item }: { item: PainItem }) {
  const [open, setOpen] = useState(false);
  if (!item.quotes.length) return <span className="text-[11.5px] text-muted">không có trích dẫn truy gốc</span>;
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[11.5px] font-bold text-soft underline decoration-dotted"
      >
        {open ? "▲ Ẩn" : "▼"} {item.quotes.length} trích dẫn truy gốc
      </button>
      {open && (
        <ul className="mt-1 flex flex-col gap-1.5">
          {item.quotes.map((q) => (
            <li key={`${item.itemKey}-${q.reviewId}`} className="rounded-[8px] border border-line bg-white p-2 text-[12px]">
              <div className="italic text-ink">“{q.quote}”</div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-soft">
                <Chip tone="gray">{q.asin}</Chip>
                <Stars value={q.stars} />
                <span>{q.reviewDate ?? "không ngày"}</span>
                {q.verified && <Chip tone="green">đã mua</Chip>}
                {q.helpfulCount > 0 && <span>· {q.helpfulCount} hữu ích</span>}
                {q.photosCount > 0 && <span>· {q.photosCount} ảnh</span>}
                {q.url && (
                  <a
                    href={q.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="ml-auto font-bold text-[#1f4e79] hover:underline"
                  >
                    mở review gốc ↗
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Ma trận impact (trục dọc, cao trên) × effort (trục ngang, thấp trái). */
function ImpactEffortMatrix({ items }: { items: PainItem[] }) {
  const cell = 2.25; // rem
  const pos = (v: number): number => Math.max(0.4, Math.min(10, v)) / 10;
  return (
    <div className="overflow-x-auto">
      <div className="inline-block">
        <div className="flex">
          <div className="mr-1 flex flex-col items-center justify-center">
            <span className="rotate-180 text-[10.5px] font-bold uppercase tracking-wide text-muted [writing-mode:vertical-rl]">
              Impact → cao
            </span>
          </div>
          <div
            className="relative rounded-[10px] border border-line bg-[#f7f9fc]"
            style={{ width: `${cell * 10}rem`, height: `${cell * 10}rem` }}
          >
            {/* gói gợi ý: impact cao + effort thấp = làm ngay (góc trên-trái) */}
            <div className="absolute left-0 top-0 h-1/2 w-1/2 rounded-tl-[10px] bg-green-100/50" />
            <div className="absolute bottom-0 right-0 h-1/2 w-1/2 rounded-br-[10px] bg-red-100/40" />
            {[1, 2, 3, 4].map((g) => (
              <div key={g} className="absolute border-b border-r border-dashed border-line/70"
                style={{ left: `${g * 25}%`, top: 0, width: 0, height: "100%" }} />
            ))}
            {items.map((it) => {
              const left = pos(it.effortScore) * 100;
              const top = (1 - pos(it.impactScore)) * 100;
              return (
                <div
                  key={it.itemKey}
                  className="absolute -translate-x-1/2 -translate-y-1/2"
                  style={{ left: `${left}%`, top: `${top}%` }}
                  title={`${it.title} · impact ${it.impactScore}/effort ${it.effortScore}`}
                >
                  <span
                    className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-extrabold text-white ${
                      it.priority === "must" ? "bg-red-600" : it.priority === "should" ? "bg-amber-500" : "bg-gray-400"
                    }`}
                  >
                    {it.frequency}
                  </span>
                </div>
              );
            })}
            <span className="absolute left-1 top-0.5 text-[10px] font-bold text-green-800">làm ngay (cao impact · thấp effort)</span>
            <span className="absolute bottom-0.5 right-1 text-[10px] font-bold text-red-800">cân nhắc kỹ (cao effort · thấp impact)</span>
          </div>
        </div>
        <div className="ml-5 mt-1 text-center text-[10.5px] font-bold uppercase tracking-wide text-muted">
          Effort → nặng (trái = nhẹ)
        </div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-soft">
          {items.map((it) => (
            <span key={it.itemKey}>
              <b>{it.frequency}</b> = {it.title}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function PainPanel({ assessmentId, data, connected }: { assessmentId: string; data: PainData; connected: boolean }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const router = useRouter();

  const enqueue = () =>
    startTransition(async () => {
      const r = await enqueueAnalyzeAction(assessmentId);
      setMessage({ ok: r.ok, text: r.message });
      router.refresh();
    });

  const changePriority = (itemKey: string, priority: PainPriority) =>
    startTransition(async () => {
      const r = await updatePainItemAction(assessmentId, itemKey, { priority });
      setMessage({ ok: r.ok, text: r.ok ? `Đã đổi ưu tiên "${priority}" cho ${itemKey}.` : r.message });
      router.refresh();
    });

  const hasPain = data.items.length > 0;
  const failedRuns = data.llmRuns.filter((r) => r.status === "failed");
  const mockMode = data.llmRuns.some((r) => r.provider === "mock") && data.mode === "demo";

  return (
    <Panel
      title="Điểm đau khách hàng (G4 — LLM map/reduce trên review 1–3★)"
      hint="mọi trích dẫn truy nguyên văn review gốc; tần suất/nghiêm trọng tính lại từ dữ liệu, không lấy từ LLM"
    >
      {/* Điều phối + nhật ký token/cost */}
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-[10px] border border-line bg-[#f7f9fc] p-3">
        <button
          type="button"
          disabled={pending || !connected}
          onClick={enqueue}
          className="rounded-[9px] border border-line bg-white px-3 py-1.5 text-[12px] font-extrabold disabled:opacity-40"
        >
          {hasPain ? "↻ Phân tích lại bằng LLM" : "+ Xếp hàng phân tích pain (LLM)"}
        </button>
        <span className="text-[11.5px] text-muted">
          map theo lô 25 review → reduce top ≤5 pain; gpt-4.1-mini khi có LLM_API_KEY.
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {mockMode && <Chip tone="amber">dữ liệu MOCK minh họa</Chip>}
          {data.llmRuns.length > 0 && (
            <>
              <Chip tone="gray">{data.llmRuns.filter((r) => r.sectionKey === "pain_map").length} lô map + {data.llmRuns.filter((r) => r.sectionKey === "pain_reduce").length} reduce</Chip>
              <Chip tone="gray">{(data.totals.tokensIn + data.totals.tokensOut).toLocaleString("en-US")} token</Chip>
              <Chip tone="green">{fmtUsd(data.totals.costUsd)}</Chip>
              {failedRuns.length > 0 && <Chip tone="red">{failedRuns.length} lượt lỗi</Chip>}
            </>
          )}
        </div>
      </div>
      {message && <Chip tone={message.ok ? "green" : "amber"}>{message.text}</Chip>}

      {!hasPain ? (
        <div className="rounded-[10px] bg-[#f4f6fa] px-3 py-3 text-[12.5px] text-soft">
          Chưa có phân tích pain. Cần thu thập review 1–3★ ở panel G2 (mục tiêu ~500 review/ngách), rồi bấm
          “Xếp hàng phân tích pain”. Khi chưa đủ 30 review, trụ khác biệt hóa để <b>“chưa đủ cơ sở”</b>, không chấm bừa.
        </div>
      ) : (
        <>
          {/* 1. review_cluster_table */}
          <h4 className="mb-1.5 mt-2 text-[12px] font-extrabold uppercase tracking-wide text-soft">
            1. Bảng cụm điểm đau (review_cluster_table)
          </h4>
          <div className="overflow-x-auto">
            <table className={tableCls.table}>
              <thead>
                <tr>
                  <th className={tableCls.th}>Cụm</th>
                  <th className={`${tableCls.th} text-right`}>Review nhắc</th>
                  <th className={`${tableCls.th} text-right`}>Tỉ lệ</th>
                  <th className={`${tableCls.th} text-right`}>Số pain</th>
                  <th className={`${tableCls.th} text-right`}>Sao TB</th>
                  <th className={tableCls.th}>Nhận định LLM (nháp — cần người thẩm định)</th>
                </tr>
              </thead>
              <tbody>
                {data.clusters.map((c) => (
                  <tr key={c.code}>
                    <td className={tableCls.td}>
                      <Chip tone={CLUSTER_TONE[c.code]}>{c.label}</Chip>
                    </td>
                    <td className={tableCls.tdNum}>{c.reviewCount}</td>
                    <td className={tableCls.tdNum}>{c.sharePct.toFixed(1)}%</td>
                    <td className={tableCls.tdNum}>{c.itemCount}</td>
                    <td className={tableCls.tdNum}>{c.avgStars !== null ? c.avgStars.toFixed(1) : "—"}</td>
                    <td className={`${tableCls.td} text-[11.5px] text-soft`}>{c.narrative ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pain items + quotes */}
          <h4 className="mb-1.5 mt-4 text-[12px] font-extrabold uppercase tracking-wide text-soft">
            2. Pain ưu tiên & trích dẫn truy gốc (quote_list)
          </h4>
          <div className="overflow-x-auto">
            <table className={tableCls.table}>
              <thead>
                <tr>
                  <th className={tableCls.th}>Pain</th>
                  <th className={tableCls.th}>Cụm</th>
                  <th className={`${tableCls.th} text-right`}>Tần suất</th>
                  <th className={`${tableCls.th} text-right`}>Sao TB</th>
                  <th className={`${tableCls.th} text-right`}>Mức nghiêm trọng</th>
                  <th className={tableCls.th}>Ưu tiên (thẩm định lại)</th>
                  <th className={tableCls.th}>Gợi ý xử lý</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((it) => (
                  <tr key={it.itemKey} className="align-top">
                    <td className={tableCls.td}>
                      <b>{it.title}</b>
                      {it.subLabel && <div className="text-[11px] text-muted">{it.subLabel}</div>}
                      <QuoteList item={it} />
                    </td>
                    <td className={tableCls.td}>
                      <Chip tone={CLUSTER_TONE[it.cluster]}>
                        {data.clusters.find((c) => c.code === it.cluster)?.label ?? it.cluster}
                      </Chip>
                    </td>
                    <td className={tableCls.tdNum}>
                      {it.frequency}
                      <div className="text-[10.5px] text-soft">{it.frequencyPct.toFixed(1)}%</div>
                    </td>
                    <td className={tableCls.tdNum}><Stars value={it.avgStars} /></td>
                    <td className={tableCls.tdNum}>{it.severity.toFixed(1)}/10</td>
                    <td className={tableCls.td}>
                      <div className="flex flex-col gap-1">
                        {(["must", "should", "skip"] as PainPriority[]).map((p) => (
                          <button
                            key={p}
                            type="button"
                            disabled={pending || !connected}
                            onClick={() => changePriority(it.itemKey, p)}
                            className={`rounded-[7px] border px-1.5 py-0.5 text-[10.5px] font-bold disabled:opacity-40 ${
                              it.priority === p
                                ? "border-ink bg-ink text-white"
                                : "border-line bg-white text-soft"
                            }`}
                            title="Đổi ưu tiên — chuyển nhãn sang human_confirmed"
                          >
                            {PRIORITY_LABEL[p]}
                          </button>
                        ))}
                      </div>
                    </td>
                    <td className={`${tableCls.td} text-[11.5px] text-soft`}>
                      <div>{it.factoryRequirement ?? <span className="text-muted">chỉ sửa được qua listing, xem spec</span>}</div>
                      {it.listingFix && (
                        <div className="mt-1 rounded-[7px] bg-blue-50 px-1.5 py-1 text-[11px] text-[#1f4e79]">
                          📷 Listing: {it.listingFix}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 3. spec sheet */}
          <h4 className="mb-1.5 mt-4 text-[12px] font-extrabold uppercase tracking-wide text-soft">
            3. Spec sheet gửi xưởng (chờ người xác nhận)
          </h4>
          <div className="overflow-x-auto">
            <table className={tableCls.table}>
              <thead>
                <tr>
                  <th className={tableCls.th}>Pain</th>
                  <th className={tableCls.th}>Yêu cầu kỹ thuật</th>
                  <th className={tableCls.th}>Cách kiểm</th>
                  <th className={tableCls.th}>Tiêu chuẩn đạt</th>
                  <th className={tableCls.th}>Tác động giá</th>
                  <th className={tableCls.th}>Nguồn</th>
                </tr>
              </thead>
              <tbody>
                {data.specs.map((s) => (
                  <tr key={s.itemKey} className="align-top">
                    <td className={tableCls.td}>
                      <b>{s.painTitle}</b>
                      <div className="text-[10.5px] text-muted">{data.clusters.find((c) => c.code === s.cluster)?.label}</div>
                    </td>
                    <td className={tableCls.td}>{s.requirement ?? "—"}</td>
                    <td className={tableCls.td}>{s.testMethod ?? "—"}</td>
                    <td className={tableCls.td}>{s.acceptanceStandard ?? "—"}</td>
                    <td className={tableCls.td}>{s.costImpactEstimate ?? "—"}</td>
                    <td className={tableCls.td}>
                      {s.source === "human_confirmed" ? (
                        <Chip tone="green">đã người xác nhận</Chip>
                      ) : (
                        <Chip tone="amber">llm_suggested</Chip>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-1 text-[11px] text-muted">
            Mọi dòng spec mặc định <b>llm_suggested</b> (AI gợi ý, chưa phải chỉ thị sản xuất). Đổi ưu tiên hoặc
            chỉnh yêu cầu sẽ chuyển sang <b>human_confirmed</b> và ghi audit log.
          </div>

          {/* 4. ma trận */}
          <h4 className="mb-1.5 mt-4 text-[12px] font-extrabold uppercase tracking-wide text-soft">
            4. Ma trận impact × effort
          </h4>
          <ImpactEffortMatrix items={data.items} />
        </>
      )}

      {/* Nhật ký LLM chi tiết */}
      {data.llmRuns.length > 0 && (
        <>
          <h4 className="mb-1.5 mt-4 text-[12px] font-extrabold uppercase tracking-wide text-soft">
            Nhật ký lượt gọi LLM (llm_runs)
          </h4>
          <table className={tableCls.table}>
            <thead>
              <tr>
                <th className={tableCls.th}>Bước</th>
                <th className={tableCls.th}>Trạng thái</th>
                <th className={tableCls.th}>Model</th>
                <th className={`${tableCls.th} text-right`}>Token vào/ra</th>
                <th className={`${tableCls.th} text-right`}>Chi phí</th>
                <th className={tableCls.th}>Thời điểm</th>
              </tr>
            </thead>
            <tbody>
              {data.llmRuns.map((r, i) => (
                <tr key={i}>
                  <td className={tableCls.td}>
                    {r.sectionKey}
                    {r.chunkIndex !== null ? ` #${r.chunkIndex}` : ""}
                  </td>
                  <td className={tableCls.td}>
                    <Chip tone={r.status === "ok" ? "green" : "red"}>{r.status}</Chip>
                    {r.error && <div className="text-[10.5px] text-red">{r.error}</div>}
                  </td>
                  <td className={tableCls.td}>{r.model}</td>
                  <td className={tableCls.tdNum}>{r.tokensIn} / {r.tokensOut}</td>
                  <td className={tableCls.tdNum}>{fmtUsd(r.costUsd)}</td>
                  <td className={tableCls.td}>{new Date(r.createdAt).toLocaleString("vi-VN")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Panel>
  );
}
