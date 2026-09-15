/**
 * Module 8 G3 — Tab 2 (bản web, chưa PDF): tập trung thị trường.
 * Tính TRỰC TIẾP từ snapshot đối thủ mới nhất bằng engine concentration.ts;
 * chưa lưu điểm vào scorecard (việc đó thuộc job research:scorecard ở G4).
 */

import { Chip, KpiCard, KpiGrid, Panel, tableCls } from "@/components/ui";
import {
  analyzeConcentration,
  scoreCompetition,
  type CompetitorInput,
} from "@/lib/research/domain";
import type { CompetitorRowView } from "@/lib/data/research";
import type { VelocityResult } from "@/lib/research/domain";

function toneForCr3(v: number | null): "up" | "warn" | "down" | "flat" {
  if (v === null) return "flat";
  if (v < 50) return "up";
  if (v < 65) return "warn";
  return "down";
}

function hhiLabel(h: number | null): string {
  if (h === null) return "—";
  if (h < 1500) return `${h} · cạnh tranh`;
  if (h < 2500) return `${h} · tập trung vừa`;
  return `${h} · tập trung cao`;
}

export function MarketConcentrationPanel({
  competitors,
  velocity,
}: {
  competitors: CompetitorRowView[];
  velocity: VelocityResult | null;
}) {
  const input: CompetitorInput[] = competitors.map((c) => ({
    asin: c.asin,
    parentAsin: c.parent_asin,
    brand: c.brand,
    isSponsored: c.is_sponsored,
    position: c.position,
    price: c.price,
    rating: c.rating,
    ratingsTotal: c.ratings_total,
    estUnitsMonth: c.est_units_month,
    estRevenueMonth: c.est_revenue_month,
    isAmazon1p: !!c.is_amazon_1p,
  }));

  if (!input.length) {
    return (
      <Panel title="Thị phần & cạnh tranh (G3)" hint="từ SERP + sales estimation">
        <div className="rounded-[10px] bg-[#f4f6fa] px-3 py-2 text-[12.5px] text-soft">
          Chưa có snapshot đối thủ. Xếp hàng thu thập <b>SERP</b> rồi <b>products</b> trên panel
          &quot;Thu thập dữ liệu&quot;; cần tối thiểu 10 sản phẩm organic có sales estimate
          (sai số BSR→sales 20–40%) mới chấm được CR3/CR5/HHI.
        </div>
      </Panel>
    );
  }

  const c = analyzeConcentration(input);
  const scored = scoreCompetition(c);
  const shareFor = (pct: number | null): number => (pct === null ? 0 : Math.min(100, pct));

  return (
    <Panel
      title="Thị phần & cạnh tranh (G3)"
      hint={`gộp variation theo parent ASIN · metric: ${c.metric === "revenue" ? "doanh thu/tháng" : c.metric === "units" ? "đơn/tháng" : "chưa đủ"}`}
    >
      {c.notes.map((n, i) => (
        <div key={i} className="mb-2 rounded-[10px] bg-amber-soft px-3 py-2 text-[12px] font-semibold text-[#8a5602]">
          {n}
        </div>
      ))}

      <KpiGrid>
        <KpiCard label="CR3 (3 brand đầu)" value={c.cr3Pct === null ? "chưa đủ cơ sở" : `${c.cr3Pct.toFixed(1)}%`} sub="veto đỏ khi > 65%" tone={toneForCr3(c.cr3Pct)} />
        <KpiCard label="CR5" value={c.cr5Pct === null ? "—" : `${c.cr5Pct.toFixed(1)}%`} sub="top 5 thương hiệu" tone="flat" />
        <KpiCard label="HHI" value={hhiLabel(c.hhi)} sub="tổng bình phương thị phần" tone={c.hhi !== null && c.hhi >= 2500 ? "down" : "flat"} />
        <KpiCard
          label="Amazon 1P"
          value={c.amazon1p.inTop3 ? "CÓ ở top 3" : c.amazon1p.productCount ? `${c.amazon1p.productCount} sản phẩm` : "không"}
          sub={c.amazon1p.organicSharePct !== null ? `${c.amazon1p.organicSharePct}% organic` : "—"}
          tone={c.amazon1p.inTop3 ? "down" : "up"}
        />
      </KpiGrid>

      {/* Veto/cảnh báo cạnh tranh */}
      {scored.vetoes.length > 0 && (
        <div className="mb-3 space-y-2">
          {scored.vetoes.map((v) => (
            <div key={v.code} className="rounded-[10px] bg-red-soft px-3.5 py-2.5 text-[13px] font-semibold text-[#a01717]">
              🚫 VETO ĐỎ · {v.title} — {v.detail}
            </div>
          ))}
        </div>
      )}
      {scored.warnings.length > 0 && (
        <div className="mb-3 space-y-1">
          {scored.warnings.map((w, i) => (
            <div key={i} className="rounded-[10px] bg-amber-soft px-3.5 py-2 text-[12.5px] font-semibold text-[#8a5602]">
              ⚠️ {w}
            </div>
          ))}
        </div>
      )}

      {/* Biểu đồ thị phần brand (thanh ngang) */}
      <h4 className="mb-2 mt-1 text-[12px] font-extrabold uppercase tracking-wide text-soft">
        Thị phần theo thương hiệu (đã gộp variation)
      </h4>
      <div className="mb-4 space-y-1.5">
        {c.brands.slice(0, 10).map((b) => {
          const pct = c.metric === "revenue" ? b.revenueSharePct : c.metric === "units" ? b.unitSharePct : null;
          return (
            <div key={b.brand} className="flex items-center gap-2 text-[12px]">
              <div className="w-32 truncate font-bold">{b.brand}</div>
              <div className="h-[14px] flex-1 overflow-hidden rounded-full bg-[#eef1f6]">
                <div
                  className={`h-full rounded-full ${b.brand === "Amazon Basics" ? "bg-red" : "bg-[#8fb3f0]"}`}
                  style={{ width: `${shareFor(pct)}%` }}
                />
              </div>
              <div className="w-14 text-right tabular-nums font-extrabold">
                {pct === null ? "—" : `${pct.toFixed(1)}%`}
              </div>
              <div className="w-16 text-right text-[11px] text-soft">{b.productCount} SP</div>
            </div>
          );
        })}
      </div>

      <div className="overflow-x-auto">
        <table className={tableCls.table}>
          <thead>
            <tr>
              <th className={tableCls.th}>Thương hiệu</th>
              <th className={`${tableCls.th} text-right`}>Sản phẩm organic</th>
              <th className={`${tableCls.th} text-right`}>Vị trí cao nhất</th>
              <th className={`${tableCls.th} text-right`}>Thị phần đơn</th>
              <th className={`${tableCls.th} text-right`}>Thị phần thu</th>
            </tr>
          </thead>
          <tbody>
            {c.brands.map((b) => (
              <tr key={b.brand}>
                <td className={tableCls.td}>
                  {b.brand}
                  {b.brand.toLowerCase().includes("amazon") ? <Chip tone="red">1P</Chip> : null}
                </td>
                <td className={tableCls.tdNum}>{b.productCount}</td>
                <td className={tableCls.tdNum}>#{b.topPosition}</td>
                <td className={tableCls.tdNum}>{b.unitSharePct === null ? "—" : `${b.unitSharePct}%`}</td>
                <td className={tableCls.tdNum}>{b.revenueSharePct === null ? "—" : `${b.revenueSharePct}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11.5px] text-muted">
        <Chip tone={scored.pillar.score === null ? "gray" : scored.pillar.score >= 7 ? "green" : scored.pillar.score >= 5 ? "amber" : "red"}>
          Trụ cạnh tranh: {scored.pillar.score === null ? "chưa đủ cơ sở" : `${scored.pillar.score.toFixed(1)}/10`}
        </Chip>
        <span>{scored.pillar.reason}</span>
        <span className="w-full">
          Quy mô ước lượng:{" "}
          {c.totalEstUnitsMonth ? `${c.totalEstUnitsMonth.toLocaleString("en-US")} đơn/tháng` : "—"}
          {c.totalEstRevenueMonth ? ` · $${c.totalEstRevenueMonth.toLocaleString("en-US", { maximumFractionDigits: 0 })}/tháng` : ""}
          · đánh giá TB {c.avgRating ?? "—"}★ · slot sponsored trang 1: {c.sponsoredSharePct ?? "—"}%.
          Sales estimate BSR→sales sai số 20–40% (phụ lục phương pháp).
        </span>
        {velocity ? (
          <span className="w-full font-semibold text-ink">
            Review velocity (2 lần quét gần nhất):{" "}
            <b>{velocity.reviewsPerDay?.toFixed(1)} review mới/ngày</b> trung bình top
            organic; ASIN nhanh nhất {velocity.perAsin[0]?.asin} ({velocity.perAsin[0]?.reviewsPerDay.toFixed(1)}/ngày).
          </span>
        ) : (
          <span className="w-full text-soft">
            Review velocity cần 2 lần quét SERP cách nhau (tối thiểu 3 ASIN có đủ 2 mốc) —
            chạy lại bước SERP sau ≥7 ngày để có. Chỗ cắm Keepa (lịch sử BSR/mùa vụ) để dành
            cho G7; hiện BSR chỉ là ảnh chụp tại thời điểm quét.
          </span>
        )}
      </div>
    </Panel>
  );
}
