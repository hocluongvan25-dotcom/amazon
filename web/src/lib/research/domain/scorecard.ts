/**
 * Module 8 — Niche Scorecard: chấm 5 trụ thang 1–10, trọng số, các VETO cứng.
 *
 * NGUYÊN TẮC (đúng văn hóa codebase):
 *   • Trụ chưa có dữ liệu → score = null + lý do "chưa đủ cơ sở"; KHÔNG bịa điểm.
 *   • Điểm tổng chỉ tính khi ĐỦ 5 trụ; thiếu → overallScore=null, verdict
 *     "insufficient_data" (không thể nhân trung bình trên một tập con).
 *   • Veto do engine sinh từ số liệu; người soát chỉ ghi biên bản phản biện,
 *     không gỡ được cờ (luật này được siết tiếp bằng state machine ở G5).
 *
 * Trọng số PRD: tài chính 25% · cạnh tranh 25% · nhu cầu 20% · khác biệt hóa 20%
 * · logistics 10%.
 */

import { MARGIN_RED_FLAG } from "./pnl.ts";
import { classifySizeTier } from "./size-tier.ts";
import type {
  AssessmentAssumptions,
  FinancialResult,
  PillarKey,
  PillarScore,
  ScorecardResult,
  VetoFlag,
} from "./types.ts";

export const PILLAR_WEIGHTS: Record<PillarKey, number> = {
  finance: 0.25,
  competition: 0.25,
  demand: 0.2,
  differentiation: 0.2,
  logistics: 0.1,
};

export const PILLAR_LABELS: Record<PillarKey, string> = {
  finance: "Tài chính & biên lợi nhuận",
  competition: "Cạnh tranh & rủi ro độc quyền",
  demand: "Nhu cầu & xu hướng",
  differentiation: "Khác biệt hóa từ điểm đau",
  logistics: "Logistics & chuỗi cung ứng",
};

const R1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Bảng điểm trụ tài chính theo biên % kịch bản CƠ SỞ (sau PPC nếu có).
 * Thang bậc công khai, chuyên viên nhìn thẳng vào ngưỡng.
 */
export function financeScore(baseMarginPct: number): number {
  if (baseMarginPct >= 35) return 10;
  if (baseMarginPct >= 30) return 9;
  if (baseMarginPct >= 25) return 7;
  if (baseMarginPct >= 20) return 5;
  if (baseMarginPct >= 15) return 3;
  return 1;
}

/** Trụ logistics: xuất phát 10, trừ theo tier và rủi ro hàng/dễ vỡ. */
export function logisticsScore(a: AssessmentAssumptions): {
  score: number;
  reason: string;
} {
  const t = classifySizeTier(a.packDims);
  let score = 10;
  const why: string[] = [];
  switch (t.tier) {
    case "large_envelope":
    case "small_standard":
      break;
    case "large_standard":
      score -= 1;
      why.push("Large Standard");
      break;
    case "small_bulky":
      score -= 3;
      why.push("Small Bulky — phí FBA ~gấp đôi standard");
      break;
    case "large_bulky":
      score -= 6;
      why.push("Large Bulky — vốn cước và phí cao");
      break;
    case "extra_large":
      score = 1;
      why.push("Extra-Large — ngoài khổ FBA thông thường");
      break;
  }
  if (a.fragile) {
    score -= 1;
    why.push("hàng dễ vỡ");
  }
  if (a.certificationRequired) {
    score -= 1;
    why.push("cần chứng nhận");
  }
  return {
    score: Math.max(1, Math.min(10, score)),
    reason: why.length ? why.join(" · ") : `${t.label} — khổ vận chuyển tối ưu`,
  };
}

function pillar(
  key: PillarKey,
  score: number | null,
  confidence: PillarScore["confidence"],
  reason: string,
): PillarScore {
  return { pillar: key, label: PILLAR_LABELS[key], weight: PILLAR_WEIGHTS[key], score, confidence, reason };
}

/** Sinh các cờ veto/phủ định từ số liệu G1 (các cờ CR3/Amazon 1P bổ sung ở G2). */
export function buildVetoes(
  a: AssessmentAssumptions,
  f: FinancialResult,
): VetoFlag[] {
  const vetoes: VetoFlag[] = [];
  const pess = f.scenarios.pessimistic;
  const base = f.scenarios.base;

  if (pess.netMarginPct < MARGIN_RED_FLAG * 100) {
    vetoes.push({
      code: "margin_below_20",
      severity: "red",
      title: "Biên lợi nhuận dưới ngưỡng an toàn",
      detail: `Net margin kịch bản bi quan là ${pess.netMarginPct.toFixed(1)}% (ngưỡng cứng ${MARGIN_RED_FLAG * 100}%).`,
      evidence: {
        pessimisticMarginPct: pess.netMarginPct,
        baseMarginPct: base.netMarginPct,
        thresholdPct: MARGIN_RED_FLAG * 100,
      },
    });
  }

  const t = classifySizeTier(a.packDims);
  if (t.isOversize) {
    vetoes.push({
      code: "oversize",
      severity: "warning",
      title: "Đóng gói đẩy lên nhóm cồng kềnh/oversize",
      detail: `Kích thước đóng gói rơi vào ${t.label}; phí FBA và vốn cước cao hơn chuẩn.`,
      evidence: {
        tier: t.tier,
        sides: t.sides,
        billableWeightLb: t.billableWeightLb,
        suggestions: f.packagingSuggestions.length - 1,
      },
    });
  }

  if (a.certificationRequired || a.patentRisk) {
    const bits: string[] = [];
    if (a.certificationRequired) bits.push("chứng nhận danh mục");
    if (a.patentRisk) bits.push("nghi vấn bằng sáng chế");
    vetoes.push({
      code: "cert_barrier",
      severity: "red",
      title: "Rào cản pháp lý/chứng nhận chưa gỡ",
      detail: `Còn rào cản ${bits.join(" và ")} trước khi đưa hàng lên sàn.`,
      evidence: {
        certificationRequired: !!a.certificationRequired,
        patentRisk: !!a.patentRisk,
      },
    });
  }
  return vetoes;
}

/**
 * G3+ — ghép điểm các trụ do worker chấm từ dữ liệu thu thập (competition ở G3,
 * demand/differentiation ở G4) vào scorecard engine G1. HÀM THUẦN: không I/O;
 * data layer đọc view vexim_research_scorecards/vetoes rồi truyền vào.
 *
 * - Trụ nào có điểm trong `pillarOverrides` (score khác null) thì thay thế;
 *   trụ chưa chấm giữ nguyên null ("chưa đủ cơ sở").
 *   - Veto bổ sung (CR3/1P…) được GỘP, không nhân đôi theo rule_code.
 *   - Khi đủ 5 trụ mới tính lại overallScore/verdict; thiếu vẫn insufficient_data.
 */
export function mergeExternalScores(
  result: import("./types.ts").AssessmentResult,
  pillarOverrides: Partial<Record<PillarKey, Pick<PillarScore, "score" | "confidence" | "reason">>>,
  extraVetoes: VetoFlag[] = [],
): import("./types.ts").AssessmentResult {
  const pillars = result.scorecard.pillars.map((p) => {
    const over = pillarOverrides[p.pillar];
    return over && over.score !== null && over.score !== undefined
      ? { ...p, score: over.score, confidence: over.confidence ?? p.confidence, reason: over.reason || p.reason }
      : p;
  });

  const byCode = new Map<string, VetoFlag>();
  for (const v of result.scorecard.vetoes) byCode.set(v.code, v);
  for (const v of extraVetoes) if (!byCode.has(v.code)) byCode.set(v.code, v);
  const vetoes = [...byCode.values()];

  const ready = pillars.every((p) => p.score !== null);
  let overallScore: number | null = null;
  let verdictCode: ScorecardResult["verdict"];
  if (!ready) {
    verdictCode = "insufficient_data";
  } else {
    overallScore = R1(pillars.reduce((acc, p) => acc + (p.score ?? 0) * p.weight, 0));
    const hasRedVeto = vetoes.some((v) => v.severity === "red");
    if (overallScore <= 4.9) verdictCode = "do_not_invest";
    else if (overallScore < 8 || hasRedVeto) verdictCode = "improve";
    else verdictCode = "go_test";
  }
  const v = verdictLabel(verdictCode);

  return {
    ...result,
    scorecard: { pillars, overallScore, verdict: v.code, verdictLabel: v.label, vetoes },
  };
}

function verdictLabel(
  code: ScorecardResult["verdict"],
): { code: ScorecardResult["verdict"]; label: string } {
  switch (code) {
    case "go_test":
      return { code, label: "AN TOÀN — NÊN TEST" };
    case "improve":
      return { code, label: "CẦN CẢI TIẾN SẢN PHẨM" };
    case "do_not_invest":
      return { code, label: "KHÔNG NÊN ĐẦU TƯ" };
    case "insufficient_data":
      return { code, label: "CHƯA ĐỦ CƠ SỞ — đang thu thập dữ liệu" };
  }
}

/**
 * Tính scorecard G1:
 *  - Trụ tài chính & logistics có điểm; 3 trụ đối thủ/nhu cầu/khác biệt hóa là
 *    null (do Rainforest + review LLM cung cấp ở G2/G4).
 *  - Chưa đủ trụ ⇒ overallScore = null, verdict = insufficient_data; các cờ veto
 *    đỏ vẫn hiện và được giữ nguyên để không che rủi ro.
 */
export function computeScorecard(
  a: AssessmentAssumptions,
  f: FinancialResult,
): ScorecardResult {
  const baseMargin = f.scenarios.base.netMarginPct;
  const finScore = financeScore(baseMargin);
  const finConfidence: PillarScore["confidence"] =
    f.scenarios.base.fbaFeeSource === "spapi"
      ? "high"
      : f.scenarios.base.ppcPerOrder === null
        ? "low"
        : "medium";

  const log = logisticsScore(a);
  const pillars: PillarScore[] = [
    pillar(
      "finance",
      finScore,
      finConfidence,
      `Biên kịch bản cơ sở ${baseMargin.toFixed(1)}% · bi quan ${f.scenarios.pessimistic.netMarginPct.toFixed(1)}% · ${
        f.scenarios.base.ppcPerOrder === null ? "chưa trừ PPC" : "đã trừ PPC giả định"
      }`,
    ),
    pillar(
      "competition",
      null,
      null,
      "Chưa thu thập SERP/CR₃/Amazon 1P từ Rainforest API (Giai đoạn 2)",
    ),
    pillar(
      "demand",
      null,
      null,
      "Chưa có doanh thu ước tính/phân bố BSR từ Rainforest (Giai đoạn 2)",
    ),
    pillar(
      "differentiation",
      null,
      null,
      "Chưa gom review 1–3 sao & phân cụm điểm đau bằng LLM (Giai đoạn 4)",
    ),
    pillar("logistics", log.score, "medium", log.reason),
  ];

  const vetoes = buildVetoes(a, f);
  const ready = pillars.every((p) => p.score !== null);

  let overallScore: number | null = null;
  let verdictCode: ScorecardResult["verdict"];
  if (!ready) {
    verdictCode = "insufficient_data";
  } else {
    overallScore = R1(
      pillars.reduce((acc, p) => acc + (p.score ?? 0) * p.weight, 0),
    );
    const hasRedVeto = vetoes.some((v) => v.severity === "red");
    if (overallScore <= 4.9) verdictCode = "do_not_invest";
    else if (overallScore < 8 || hasRedVeto) verdictCode = "improve";
    else verdictCode = "go_test";
  }

  const v = verdictLabel(verdictCode);
  return {
    pillars,
    overallScore,
    verdict: v.code,
    verdictLabel: v.label,
    vetoes,
  };
}
