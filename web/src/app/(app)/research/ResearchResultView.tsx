/**
 * Module 8 — trình bày KẾT QUẢ engine thẩm định (thuần presentational, dùng
 * được trong server component). Mọi con số do engine
 * `lib/research/domain` tính; component KHÔNG tự suy diễn.
 */

import type { ReactNode } from "react";
import { Chip, KpiCard, KpiGrid, Panel, tableCls } from "@/components/ui";
import {
  SCENARIO_LABEL,
  SCENARIO_ORDER,
  type AssessmentResult,
  type ScenarioKey,
} from "@/lib/research/domain";
import { VERDICT_LABEL, VERDICT_TONE } from "@/lib/data/research-model";

export const usd = (v: number | null | undefined, digits = 2): string =>
  v === null || v === undefined || Number.isNaN(v)
    ? "—"
    : `$${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export const pct = (v: number | null | undefined, digits = 1): string =>
  v === null || v === undefined || Number.isNaN(v) ? "—" : `${v.toFixed(digits)}%`;

const PILLAR_LABEL: Record<string, string> = {
  finance: "Tài chính",
  competition: "Cạnh tranh",
  demand: "Nhu cầu",
  differentiation: "Khác biệt",
  logistics: "Logistics",
};

function marginTone(m: number | null | undefined): "up" | "down" | "warn" {
  if (m === null || m === undefined || Number.isNaN(m)) return "warn";
  if (m >= 20) return "up";
  if (m >= 12) return "warn";
  return "down";
}

/** Thanh điểm 1 trụ (score null = vạch xám "chưa đủ cơ sở"). */
function PillarBar({
  label,
  weight,
  score,
  reason,
}: {
  label: string;
  weight: number;
  score: number | null;
  reason: string;
}) {
  const color =
    score === null
      ? "bg-[#d7dce4]"
      : score >= 7
        ? "bg-green"
        : score >= 5
          ? "bg-amber"
          : "bg-red";
  return (
    <div className="mb-2.5">
      <div className="mb-1 flex items-baseline justify-between text-[12.5px]">
        <span className="font-bold">
          {label} <span className="font-medium text-soft">· trọng số {Math.round(weight * 100)}%</span>
        </span>
        <span className="font-extrabold tabular-nums">{score === null ? "chưa đủ cơ sở" : `${score.toFixed(1)}/10`}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-[#eef1f6]">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${score === null ? 4 : score * 10}%` }} />
      </div>
      <div className="mt-1 text-[11.5px] leading-snug text-muted">{reason}</div>
    </div>
  );
}

export function ResearchResultView({ result }: { result: AssessmentResult }) {
  const { financial: fin, scorecard, roadmap: rm } = result;
  const s = fin.scenarios;
  const base = s.base;
  const monthly500 = fin.monthly.find((m) => m.unitsPerMonth === 500);
  const redVetoes = scorecard.vetoes.filter((v) => v.severity === "red");
  const warnVetoes = scorecard.vetoes.filter((v) => v.severity === "warning");

  const pnlRows: { label: string; render: (k: ScenarioKey) => ReactNode }[] = [
    { label: "Giá bán", render: (k) => usd(s[k].price) },
    { label: "Giá vốn + cước về FBA (landed)", render: (k) => `−${usd(s[k].landedCost)}` },
    { label: "Referral fee (%)", render: (k) => `−${usd(s[k].referralFee)}` },
    { label: "Phí FBA fulfilment", render: (k) => `−${usd(s[k].fbaFee)}` },
    { label: "Phí lưu kho (phân bổ)", render: (k) => `−${usd(s[k].storageFee, 3)}` },
    { label: "Quảng cáo/đơn (CPC ÷ CR)", render: (k) => (s[k].ppcPerOrder === null ? "chưa đủ dữ liệu" : `−${usd(s[k].ppcPerOrder)}`) },
    { label: "Dự phòng trả hàng", render: (k) => `−${usd(s[k].returnReserve)}` },
    { label: "Chi phí khác", render: (k) => `−${usd(s[k].otherPerUnit, 2)}` },
    { label: "LỢI NHUẬN/ĐƠN", render: (k) => <b>{usd(s[k].netProfit)}</b> },
    {
      label: "BIÊN LỢI NHUẬN",
      render: (k) => (
        <b className={marginTone(s[k].netMarginPct) === "up" ? "text-green" : marginTone(s[k].netMarginPct) === "down" ? "text-red" : "text-amber"}>
          {pct(s[k].netMarginPct)}
        </b>
      ),
    },
    { label: "ACOS hòa vốn", render: (k) => pct(s[k].breakEvenAcosPct) },
  ];

  return (
    <div>
      {/* Verdict + veto đỏ */}
      <Panel
        title="Kết luận G1"
        hint="G1 mới chấm được 2/5 trụ; kết luận cuối cần G2–G4"
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Chip tone={VERDICT_TONE[scorecard.verdict]}>{VERDICT_LABEL[scorecard.verdict]}</Chip>
          <Chip tone="gray">{fin.currentPackaging.tierLabel}</Chip>
          <Chip tone={base.fbaFeeSource === "spapi" ? "green" : "amber"}>
            FBA fee: {base.fbaFeeSource === "spapi" ? "SP-API (chuẩn)" : `bảng ước lượng ${result.engineVersion.split("+")[1] ?? ""}`}
          </Chip>
        </div>
        {scorecard.overallScore !== null ? (
          <div className="text-[13px]">
            Điểm tổng có trọng số: <b className="text-[16px]">{scorecard.overallScore.toFixed(1)}/10</b>
          </div>
        ) : (
          <div className="rounded-[10px] bg-[#f4f6fa] px-3 py-2 text-[12.5px] text-soft">
            Chưa có điểm tổng: thiếu các trụ Cạnh tranh / Nhu cầu / Khác biệt (sẽ thu ở G2–G4). Engine
            cố ý KHÔNG tự suy diễn khi thiếu dữ liệu.
          </div>
        )}
        {redVetoes.length > 0 && (
          <div className="mt-3 space-y-2">
            {redVetoes.map((v) => (
              <div key={v.code} className="rounded-[10px] bg-red-soft px-3.5 py-2.5 text-[13px] font-semibold leading-snug text-[#a01717]">
                🚫 VETO ĐỎ · {v.title} — {v.detail}
                <div className="mt-0.5 text-[11.5px] font-medium opacity-80">
                  Cờ phủ định cứng; không thể gỡ bằng thao tác người dùng — phải đổi sản phẩm/giá/thiết kế.
                </div>
              </div>
            ))}
          </div>
        )}
        {warnVetoes.length > 0 && (
          <div className="mt-2 space-y-2">
            {warnVetoes.map((v) => (
              <div key={v.code} className="rounded-[10px] bg-amber-soft px-3.5 py-2.5 text-[12.5px] font-semibold leading-snug text-[#8a5602]">
                ⚠️ {v.title} — {v.detail}
              </div>
            ))}
          </div>
        )}
      </Panel>

      <KpiGrid>
        <KpiCard label="Biên kịch bản cơ sở" value={pct(s.base.netMarginPct)} sub={usd(s.base.netProfit) + "/đơn"} tone={marginTone(s.base.netMarginPct)} />
        <KpiCard label="Biên kịch bản BI QUAN" value={pct(s.pessimistic.netMarginPct)} sub={usd(s.pessimistic.netProfit) + "/đơn"} tone={marginTone(s.pessimistic.netMarginPct)} />
        <KpiCard label="ACOS hòa vốn (cơ sở)" value={pct(s.base.breakEvenAcosPct)} sub="ACOS thực phải dưới ngưỡng này" tone="flat" />
        <KpiCard
          label="Lợi nhuận @500 đơn/tháng"
          value={usd(monthly500?.netProfit ?? null, 0)}
          sub={monthly500?.adSpend ? `gồm ads ${usd(monthly500.adSpend, 0)}/tháng` : "chưa có giả định ads"}
          tone={marginTone(s.base.netMarginPct)}
        />
      </KpiGrid>

      {/* Scorecard 5 trụ */}
      <Panel title="Scorecard 5 trụ" hint="trụ chưa có dữ liệu để nguyên 'chưa đủ cơ sở'">
        {scorecard.pillars.map((p) => (
          <PillarBar key={p.pillar} label={PILLAR_LABEL[p.pillar] ?? p.pillar} weight={p.weight} score={p.score} reason={p.reason} />
        ))}
      </Panel>

      {/* P&L 3 kịch bản */}
      <Panel title="P&L theo đơn — 3 kịch bản giá">
        <div className="overflow-x-auto">
          <table className={tableCls.table}>
            <thead>
              <tr>
                <th className={tableCls.th}>Khoản mục</th>
                {SCENARIO_ORDER.map((k) => (
                  <th key={k} className={`${tableCls.th} text-right`}>
                    {SCENARIO_LABEL[k]}
                    <div className="font-medium normal-case text-soft">{usd(s[k].price)}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pnlRows.map((r) => (
                <tr key={r.label}>
                  <td className={tableCls.td}>{r.label}</td>
                  {SCENARIO_ORDER.map((k) => (
                    <td key={k} className={`${tableCls.tdNum} tabular-nums`}>
                      {r.render(k)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {fin.warnings.length > 0 && (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-[12px] text-muted">
            {fin.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
      </Panel>

      {/* Đóng gói/tối ưu FBA */}
      <Panel title="Size tier & tối ưu bao bì" hint={`khối lượng tính phí ${fin.currentPackaging.billableWeightLb.toFixed(2)} lb`}>
        <div className="overflow-x-auto">
          <table className={tableCls.table}>
            <thead>
              <tr>
                <th className={tableCls.th}>Phương án</th>
                <th className={tableCls.th}>Kích thước (inch) / khối lượng</th>
                <th className={tableCls.th}>Size tier</th>
                <th className={`${tableCls.th} text-right`}>Phí FBA/đơn</th>
                <th className={`${tableCls.th} text-right`}>Tiết kiệm/năm</th>
              </tr>
            </thead>
            <tbody>
              <tr className="bg-[#f7f9fc]">
                <td className={tableCls.td}><b>Hiện tại</b></td>
                <td className={tableCls.td}>
                  {fin.currentPackaging.dims.lengthIn}×{fin.currentPackaging.dims.widthIn}×{fin.currentPackaging.dims.heightIn} · {fin.currentPackaging.dims.weightLb} lb
                </td>
                <td className={tableCls.td}>{fin.currentPackaging.tierLabel}</td>
                <td className={tableCls.tdNum}>{usd(fin.currentPackaging.fbaFee)}</td>
                <td className={tableCls.tdNum}>—</td>
              </tr>
              {fin.packagingSuggestions.map((o, i) => (
                <tr key={i}>
                  <td className={tableCls.td}>{o.label}</td>
                  <td className={tableCls.td}>
                    {o.dims.lengthIn}×{o.dims.widthIn}×{o.dims.heightIn} · {o.dims.weightLb.toFixed(2)} lb
                  </td>
                  <td className={tableCls.td}>{o.tierLabel}</td>
                  <td className={tableCls.tdNum}>{usd(o.fbaFee)}</td>
                  <td className={`${tableCls.tdNum} font-bold ${(o.savingPerYear ?? 0) > 0 ? "text-green" : "text-soft"}`}>
                    {o.savingPerYear === null ? "—" : o.savingPerYear > 0 ? usd(o.savingPerYear, 0) : "$0"}
                  </td>
                </tr>
              ))}
              {fin.packagingSuggestions.length === 0 && (
                <tr>
                  <td colSpan={5} className={`${tableCls.td} text-soft`}>
                    Không có phương án nén kích thước nào rẻ hơn hiện tại.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-2 text-[11.5px] text-muted">
          Lưu kho: {fin.storage.cubicFeet.toFixed(3)} ft³/đơn · {usd(fin.storage.lowPerMonth, 3)}–{usd(fin.storage.peakPerMonth, 3)}/tháng
          ({fin.storage.source}) — quy tắc FBA US 2026 ước lượng, cần xác nhận bằng SP-API Product Fees trước khi chốt.
        </div>
      </Panel>

      {/* Roadmap lô test */}
      <Panel title="Lộ trình validate (G1)" hint="mọi mốc lấy theo kịch bản BI QUAN">
        <KpiGrid>
          <KpiCard label={`Lô test (${rm.coverDays} ngày phủ)`} value={rm.testOrderQty === null ? "—" : `${rm.testOrderQty} đơn`} sub={rm.testOrderQty === null ? "nhập đơn/ngày bi quan" : `vốn hàng ${usd(rm.lotCapital, 0)}`} tone="flat" />
          <KpiCard label="Ads thăm dò" value={rm.adsBudgetPerDay === null ? "—" : `${usd(rm.adsBudgetPerDay)}/ngày`} sub={`${rm.adsTestDays} ngày · tổng ${usd(rm.adsTestSpend, 0)}`} tone="flat" />
          <KpiCard label="Mức lỗ tối đa" value={usd(rm.maxLossAmount, 0)} sub="vượt mức này → DỪNG" tone={rm.maxLossAmount !== null && rm.maxLossAmount > 3000 ? "down" : "warn"} />
          <KpiCard label="ACOS mục tiêu sau test" value="≤ break-even" sub="không chốt quảng cáo khi ACOS > hòa vốn" tone="flat" />
        </KpiGrid>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <div className="mb-1 text-[12px] font-extrabold uppercase tracking-wide text-soft">Gate QUY MÔ / SỬA / DỪNG</div>
            <ul className="list-disc space-y-1 pl-5 text-[12.5px]">
              {rm.gates.map((g, i) => (
                <li key={i}>
                  <b>Tuần {g.week}:</b> {g.metrics.join("; ")}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="mb-1 text-[12px] font-extrabold uppercase tracking-wide text-soft">Tiêu chí DỪNG</div>
            <ul className="list-disc space-y-1 pl-5 text-[12.5px]">
              {rm.killCriteria.map((g, i) => (
                <li key={i}>{g}</li>
              ))}
            </ul>
          </div>
        </div>
      </Panel>
    </div>
  );
}
