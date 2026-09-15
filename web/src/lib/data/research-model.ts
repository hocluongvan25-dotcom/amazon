/**
 * Module 8 — model dữ liệu thuần cho màn /research (dùng cho cả demo lẫn
 * Supabase mode): định nghĩa dòng danh sách khớp view
 * `public.vexim_research_assessments`, helper parse form, dữ liệu mẫu DEMO tính
 * thẳng từ engine (không viết cứng kết quả).
 */

import {
  computeAssessment,
  type AssessmentAssumptions,
  type AssessmentResult,
  type VerdictCode,
} from "@/lib/research/domain";

/* ------------------------------- Row danh sách ------------------------------ */

export type AssessmentListRow = {
  id: string;
  org_id: string | null;
  org_name: string | null;
  code: string;
  title: string;
  marketplace: string;
  currency: string;
  keywords: string[] | null;
  status: string;
  verdict: VerdictCode | null;
  overall_score: number | null;
  base_margin_pct: number | null;
  pess_margin_pct: number | null;
  size_tier: string | null;
  veto_count: number;
  red_veto_count: number;
  analyst_name: string | null;
  data_expires_at: string | null;
  created_at: string;
};

export const VERDICT_LABEL: Record<VerdictCode, string> = {
  go_test: "AN TOÀN — NÊN TEST",
  improve: "CẦN CẢI TIẾN SẢN PHẨM",
  do_not_invest: "KHÔNG NÊN ĐẦU TƯ",
  insufficient_data: "CHƯA ĐỦ CƠ SỞ — đang thu thập",
};

export const VERDICT_TONE: Record<VerdictCode, "green" | "amber" | "red" | "gray"> = {
  go_test: "green",
  improve: "amber",
  do_not_invest: "red",
  insufficient_data: "gray",
};

export const STATUS_LABEL: Record<string, string> = {
  collecting: "Đang thu thập",
  drafting: "AI soạn nháp",
  in_review: "Chờ thẩm định",
  approved: "Đã duyệt",
  published: "Đã phát hành",
  stale: "Hết hạn số liệu",
};

export function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

/* -------------------------------- Form parse ------------------------------- */

export type ResearchFormRaw = {
  title: string;
  keywords: string;
  seedAsin?: string;
  categoryNode?: string;
  pricePessimistic: string;
  priceBase: string;
  priceOptimistic: string;
  cogsPerUnit: string;
  inboundFreightPerUnit: string;
  lengthIn: string;
  widthIn: string;
  heightIn: string;
  weightLb: string;
  referralRate?: string;
  fbaFeeOverride?: string;
  cpc?: string;
  conversionRatePct?: string;
  returnRatePct?: string;
  otherPerUnit?: string;
  pessimisticUnitsPerDay?: string;
  testCoverDays?: string;
  adsBudgetPerDay?: string;
  adsTestDays?: string;
  fragile?: boolean;
  certificationRequired?: boolean;
  patentRisk?: boolean;
};

function num(s: string | undefined | null): number | null {
  if (s === undefined || s === null || s.toString().trim() === "") return null;
  const v = Number(String(s).replace(",", ".").trim());
  return Number.isFinite(v) ? v : null;
}

function numOr(s: string | null | undefined, fallback: number): number {
  const v = num(s);
  return v === null ? fallback : v;
}

/**
 * Chuyển form thô → AssessmentAssumptions cho engine. Trường không bắt buộc
 * để null khi để trống (engine hiện "chưa đủ cơ sở", không bịa 0).
 */
export function formToAssumptions(raw: ResearchFormRaw): AssessmentAssumptions {
  const referral = num(raw.referralRate);
  const crPct = num(raw.conversionRatePct);
  const returnPct = num(raw.returnRatePct);
  return {
    marketplace: "US",
    currency: "USD",
    title: raw.title.trim(),
    keywords: raw.keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
    seedAsin: raw.seedAsin?.trim() ? raw.seedAsin.trim() : null,
    categoryNode: raw.categoryNode?.trim() ? raw.categoryNode.trim() : null,
    prices: {
      pessimistic: numOr(raw.pricePessimistic, NaN),
      base: numOr(raw.priceBase, NaN),
      optimistic: numOr(raw.priceOptimistic, NaN),
    },
    cogsPerUnit: numOr(raw.cogsPerUnit, NaN),
    inboundFreightPerUnit: numOr(raw.inboundFreightPerUnit, 0),
    packDims: {
      lengthIn: numOr(raw.lengthIn, NaN),
      widthIn: numOr(raw.widthIn, NaN),
      heightIn: numOr(raw.heightIn, NaN),
      weightLb: numOr(raw.weightLb, NaN),
    },
    referralRate: referral === null ? undefined : referral / 100,
    fbaFeeOverride: num(raw.fbaFeeOverride),
    cpc: num(raw.cpc),
    conversionRate: crPct === null ? null : crPct / 100,
    returnRate: (returnPct === null ? 4 : returnPct) / 100,
    otherPerUnit: num(raw.otherPerUnit) ?? 0,
    fragile: !!raw.fragile,
    certificationRequired: !!raw.certificationRequired,
    patentRisk: !!raw.patentRisk,
    pessimisticUnitsPerDay: num(raw.pessimisticUnitsPerDay),
    testCoverDays: num(raw.testCoverDays) ?? undefined,
    adsBudgetPerDay: num(raw.adsBudgetPerDay),
    adsTestDays: num(raw.adsTestDays) ?? undefined,
  };
}

/* --------------------------------- DEMO data -------------------------------- */

const demoHealthy: AssessmentAssumptions = {
  marketplace: "US",
  currency: "USD",
  title: "Giá đỡ inox đa năng nhà bếp",
  keywords: ["kitchen shelf organizer", "stainless steel rack"],
  seedAsin: "B0DEMO0001",
  categoryNode: null,
  prices: { pessimistic: 34.99, base: 39.99, optimistic: 44.99 },
  cogsPerUnit: 6,
  inboundFreightPerUnit: 1.5,
  packDims: { lengthIn: 10, widthIn: 6, heightIn: 0.5, weightLb: 0.75 },
  referralRate: 0.15,
  cpc: 0.8,
  conversionRate: 0.1,
  returnRate: 0.04,
  pessimisticUnitsPerDay: 3,
};

const demoRisky: AssessmentAssumptions = {
  marketplace: "US",
  currency: "USD",
  title: "Thùng gấp gọn đồ chơi trẻ em",
  keywords: ["collapsible toy bin", "large storage box kids"],
  seedAsin: "B0DEMO0002",
  prices: { pessimistic: 29.99, base: 32.99, optimistic: 35.99 },
  cogsPerUnit: 8.5,
  inboundFreightPerUnit: 2.2,
  // Cạnh dài 17" → vẫn Large Standard nhưng dim weight đẩy phí FBA lên ~$9.6;
  // nén cao 8"→6" sẽ tụt phí ~$0.9/đơn (minh họa tối ưu bao bì).
  packDims: { lengthIn: 17, widthIn: 12, heightIn: 8, weightLb: 2.8 },
  referralRate: 0.15,
  cpc: 0.75,
  conversionRate: 0.1,
  returnRate: 0.04,
  pessimisticUnitsPerDay: 2,
  certificationRequired: true,
};

export const DEMO_RESULTS: Record<string, AssessmentResult> = {
  "demo-1": computeAssessment(demoHealthy, new Date("2026-09-14T03:00:00Z")),
  "demo-2": computeAssessment(demoRisky, new Date("2026-09-14T03:00:00Z")),
};

export const DEMO_ASSUMPTIONS: Record<string, AssessmentAssumptions> = {
  "demo-1": demoHealthy,
  "demo-2": demoRisky,
};

function toListRow(id: string, code: string, r: AssessmentResult, createdAt: string): AssessmentListRow {
  return {
    id,
    org_id: null,
    org_name: "VEXIM (demo)",
    code,
    title: r.assumptions.title,
    marketplace: r.assumptions.marketplace,
    currency: r.assumptions.currency,
    keywords: r.assumptions.keywords,
    status: "collecting",
    verdict: r.scorecard.verdict,
    overall_score: r.scorecard.overallScore,
    base_margin_pct: r.financial.scenarios.base.netMarginPct,
    pess_margin_pct: r.financial.scenarios.pessimistic.netMarginPct,
    size_tier: r.financial.currentPackaging.tier,
    veto_count: r.scorecard.vetoes.length,
    red_veto_count: r.scorecard.vetoes.filter((v) => v.severity === "red").length,
    analyst_name: "Hải Anh (demo)",
    data_expires_at: null,
    created_at: createdAt,
  };
}

export const DEMO_ASSESSMENTS: AssessmentListRow[] = [
  toListRow("demo-1", "PR-202609-0001", DEMO_RESULTS["demo-1"], "2026-09-14T03:00:00Z"),
  toListRow("demo-2", "PR-202609-0002", DEMO_RESULTS["demo-2"], "2026-09-13T08:00:00Z"),
];
