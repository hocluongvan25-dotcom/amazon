/**
 * Module 8 G5 — dựng NGỮ CẢNH cho LLM soát narrative.
 *
 * Nguyên tắc vàng #1 (tách số/chữ): LLM chỉ nhận DANH SÁCH số được phép trích
 * dưới dạng token; mọi con số hiển thị trên báo cáo đều do engine/snapshot tạo
 * ở đây, LLM không tự nghĩ ra. Câu trích dẫn lấy từ PainAnalysis G4 (đã truy
 * gốc). Builder thuần để test và dùng lại từ server action/worker.
 */

import { R1 } from "./numbers.ts";
import { median, type G4PillarScores, type PainItem } from "./pain.ts";
import type { VelocityResult } from "./concentration.ts";
import type { AssessmentResult } from "./types.ts";
import type { CompetitorRow } from "./collection.ts";
import type { MetricToken, QuoteToken } from "./report.ts";

const NA = "chưa đủ cơ sở";
const pct = (n: number | null | undefined, digits = 1): string =>
  typeof n === "number" && Number.isFinite(n) ? `${R1(n).toFixed(digits)}%` : NA;
const usd = (n: number | null | undefined, digits = 2): string =>
  typeof n === "number" && Number.isFinite(n) ? `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}` : NA;
const num = (n: number | null | undefined): string =>
  typeof n === "number" && Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : NA;

export type NarrativeContextInput = {
  result: AssessmentResult;
  competitors: CompetitorRow[];
  pain: {
    model: string;
    sampleSize: number;
    asinCount: number;
    executiveNarrative: string | null;
    items: PainItem[];
  } | null;
  differentiation: G4PillarScores["differentiation"] | null;
  demand: G4PillarScores["demand"] | null;
  velocity: VelocityResult | null;
  reviewCount: number;
  llm: { providerName: string; model: string };
  collectedAt: string;
};

export type NarrativeContextBundle = {
  metrics: MetricToken[];
  quotes: QuoteToken[];
  /** văn bản ngữ cảnh đính kèm prompt (không phải nội dung in thẳng) */
  contextText: string;
};

export function buildNarrativeContext(input: NarrativeContextInput): NarrativeContextBundle {
  const { result: r, pain } = input;
  const sc = r.scorecard;
  const fin = r.financial;
  const road = r.roadmap;
  const s = fin.scenarios;

  const organic = input.competitors.filter((c) => !c.isSponsored);
  const units = organic
    .map((c) => c.estUnitsMonth)
    .filter((u): u is number => typeof u === "number" && u > 0);
  const medUnits = median(units);
  const pillar = (key: string): number | null => sc.pillars.find((p) => p.pillar === key)?.score ?? null;
  const pillarReason = (key: string): string => sc.pillars.find((p) => p.pillar === key)?.reason ?? "";

  const metrics: MetricToken[] = [
    { key: "verdict", label: "kết luận scorecard", value: sc.verdictLabel ?? sc.verdict },
    { key: "overall_score", label: "điểm tổng 5 trụ", value: sc.overallScore === null ? NA : `${R1(sc.overallScore)}/10` },
    { key: "base_margin_pct", label: "biên lợi nhuận kịch bản cơ sở", value: pct(s.base.netMarginPct) },
    { key: "pess_margin_pct", label: "biên lợi nhuận bi quan", value: pct(s.pessimistic.netMarginPct) },
    { key: "opt_margin_pct", label: "biên lợi nhuận lạc quan", value: pct(s.optimistic.netMarginPct) },
    { key: "base_price", label: "giá bán kịch bản cơ sở", value: usd(r.assumptions.prices.base) },
    {
      key: "base_ppc_per_order",
      label: "PPC/đơn cơ sở",
      value: s.base.ppcPerOrder === null ? NA : usd(s.base.ppcPerOrder),
    },
    {
      key: "fba_fee_base",
      label: "phí FBA/đơn",
      value: usd(fin.currentPackaging.fbaFee),
    },
    { key: "size_tier", label: "size tier FBA", value: fin.currentPackaging.tierLabel },
    {
      key: "billable_weight_lb",
      label: "khối lượng tính phí (lb)",
      value: fin.currentPackaging.billableWeightLb.toFixed(2),
    },
    { key: "test_order_qty", label: "số lượng lô test đề xuất", value: road.testOrderQty === null ? NA : num(road.testOrderQty) },
    { key: "lot_capital", label: "vốn hàng lô test", value: road.lotCapital === null ? NA : usd(road.lotCapital, 0) },
    { key: "ads_budget_day", label: "ngân sách quảng cáo/ngày", value: road.adsBudgetPerDay === null ? NA : usd(road.adsBudgetPerDay, 0) },
    { key: "ads_test_spend", label: "tổng ngân sách test ads", value: road.adsTestSpend === null ? NA : usd(road.adsTestSpend, 0) },
    { key: "breakeven_acos", label: "ACOS hòa vốn", value: road.breakEvenAcosPct === null ? NA : pct(road.breakEvenAcosPct) },
    { key: "max_loss", label: "mức lỗ tối đa nếu fail", value: road.maxLossAmount === null ? NA : usd(road.maxLossAmount, 0) },
    { key: "organic_count", label: "số ASIN organic trong mẫu", value: String(organic.length) },
    { key: "median_units_month", label: "trung vị đơn/tháng ước lượng", value: medUnits === null ? NA : num(medUnits) },
    {
      key: "review_velocity_month",
      label: "review mới/tháng (velocity)",
      value: input.velocity?.reviewsPerDay === null || input.velocity?.reviewsPerDay === undefined
        ? NA
        : num(input.velocity.reviewsPerDay * 30),
    },
    { key: "review_sample", label: "số review 1–3★ đã thu", value: num(input.reviewCount) },
    { key: "pain_item_count", label: "số điểm đau chính", value: pain ? String(pain.items.length) : NA },
    {
      key: "differentiation_score",
      label: "điểm trụ khác biệt hóa",
      value: input.differentiation?.score !== null && input.differentiation?.score !== undefined
        ? `${R1(input.differentiation.score)}/10`
        : NA,
    },
    {
      key: "demand_score",
      label: "điểm trụ nhu cầu",
      value: input.demand?.score !== null && input.demand?.score !== undefined ? `${R1(input.demand.score)}/10` : NA,
    },
    { key: "finance_score", label: "điểm trụ tài chính", value: (pillar("finance") === null ? NA : `${pillar("finance")}/10`) },
    { key: "competition_score", label: "điểm trụ cạnh tranh", value: (pillar("competition") === null ? NA : `${pillar("competition")}/10`) },
  ];

  // Câu trích: ưu tiên pain must → should, mỗi pain tối đa 2 câu, tổng ≤12.
  const quotes: QuoteToken[] = [];
  if (pain) {
    const order = { must: 0, should: 1, skip: 2 } as const;
    const items = [...pain.items].sort((a, b) => {
      const d = order[a.priority] - order[b.priority];
      return d !== 0 ? d : b.frequency - a.frequency;
    });
    for (const item of items) {
      for (const q of item.quotes.slice(0, 2)) {
        if (quotes.length >= 12) break;
        quotes.push({
          reviewId: q.reviewId,
          asin: q.asin,
          quote: q.quote,
          stars: q.stars,
          reviewDate: q.reviewDate,
          url: q.url,
        });
      }
      if (quotes.length >= 12) break;
    }
  }

  const lines: string[] = [];
  lines.push(`Ngày số liệu: ${input.collectedAt}. Nguồn: Rainforest API (search/product/offers/sales_estimation/reviews), engine nội bộ phiên bản ${r.engineVersion}, phân tích pain bằng ${input.llm.providerName}/${input.llm.model}.`);
  lines.push(`Kết luận máy: ${sc.verdictLabel}; điểm tổng ${sc.overallScore === null ? NA : R1(sc.overallScore)}.`);
  for (const p of sc.pillars) {
    lines.push(`- Trụ ${p.label}: ${p.score === null ? NA : `${R1(p.score)}/10`} (độ tin cậy ${p.confidence ?? NA}). ${p.reason}`);
  }
  if (sc.vetoes.length) {
    lines.push("Cờ veto (engine tính, KHÔNG gỡ được bằng văn bản):");
    for (const v of sc.vetoes) {
      lines.push(`- [${v.severity === "red" ? "ĐỎ" : "VÀNG"}] ${v.code}: ${v.title} — ${v.detail}`);
    }
  }
  lines.push(
    `Tài chính: biên base ${pct(s.base.netMarginPct)}, bi quan ${pct(s.pessimistic.netMarginPct)}, lạc quan ${pct(s.optimistic.netMarginPct)}; phí FBA ${usd(fin.currentPackaging.fbaFee)} (${fin.currentPackaging.tierLabel}).`,
  );
  if (fin.warnings.length) lines.push(`Cảnh báo tài chính: ${fin.warnings.join("; ")}.`);
  lines.push(
    `Roadmap: lô test ${road.testOrderQty === null ? NA : num(road.testOrderQty)} đơn, vốn hàng ${road.lotCapital === null ? NA : usd(road.lotCapital, 0)}, ads test ${road.adsTestSpend === null ? NA : usd(road.adsTestSpend, 0)}, max loss ${road.maxLossAmount === null ? NA : usd(road.maxLossAmount, 0)}.`,
  );
  if (road.killCriteria.length) lines.push(`Kill-criteria: ${road.killCriteria.join("; ")}.`);
  lines.push(
    `Thị trường: ${organic.length} ASIN organic; trung vị đơn/tháng ${medUnits === null ? NA : num(medUnits)} (${units.length} ASIN có sales estimate); velocity ${input.velocity?.reviewsPerDay ? num(input.velocity.reviewsPerDay * 30) + " review/tháng" : NA}.`,
  );
  if (pain) {
    lines.push(
      `Điểm đau (mẫu ${pain.sampleSize} review/${pain.asinCount} ASIN, model ${pain.model}): ${pain.items
        .map((i) => `${i.title} (${i.frequency} nhắc, severity ${i.severity.toFixed(1)})`)
        .join("; ")}`,
    );
    if (pain.executiveNarrative) lines.push(`Tóm tắt pain của bước reduce: ${pain.executiveNarrative}`);
  } else {
    lines.push("Chưa chạy phân tích pain (G4) — không bịa câu trích/điểm đau.");
  }
  if (input.differentiation) lines.push(`Trụ khác biệt hóa: ${input.differentiation.reason}`);
  if (input.demand) lines.push(`Trụ nhu cầu: ${input.demand.reason}`);

  return { metrics, quotes, contextText: lines.join("\n") };
}
