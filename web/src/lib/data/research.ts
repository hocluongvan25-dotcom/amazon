/**
 * Module 8 — đọc hồ sơ thẩm định:
 * - Supabase mode: đọc qua view public.vexim_research_* (RLS theo org do
 *   migration 0025 áp); KHÔNG dùng service_role.
 * - Demo mode (chưa cấu hình Supabase): số liệu mẫu tính từ engine G1.
 */

import {
  computeAssessment,
  mergeExternalScores,
  parseProductBundle,
  parseSearchPage,
  computeReviewVelocity,
  scoreCompetitionFromSnapshots,
  type AssessmentAssumptions,
  type AssessmentResult,
  type CompetitorRow,
  type PillarKey,
  type PillarScore,
  type VelocityResult,
  type VetoFlag,
} from "@/lib/research/domain";
import { MockIntelligenceProvider } from "@/lib/intelligence";
import { createClient } from "@/lib/supabase/server";
import {
  DEMO_ASSESSMENTS,
  DEMO_ASSUMPTIONS,
  DEMO_RESULTS,
  type AssessmentListRow,
} from "./research-model";

export type AssessmentDetail = {
  row: AssessmentListRow;
  result: AssessmentResult;
};

/** Danh sách hồ sơ (view đã tóm tắt biên lợi nhuận/trụ/verdict). */
export async function readAssessments(): Promise<{
  rows: AssessmentListRow[];
  mode: "demo" | "supabase";
}> {
  const db = await createClient();
  if (!db) {
    return { rows: DEMO_ASSESSMENTS, mode: "demo" };
  }
  const { data, error } = await db
    .from("vexim_research_assessments")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) {
    throw new Error(`Không đọc được danh sách hồ sơ thẩm định — ${error.message}`);
  }
  return { rows: (data ?? []) as unknown as AssessmentListRow[], mode: "supabase" };
}

/**
 * Chi tiết 1 hồ sơ. Với hồ sơ thật, giả định lấy từ bảng versioned
 * assessment_inputs rồi CHẠY LẠI engine để dựng kết quả hiển thị — một nguồn
 * sự thật duy nhất là engine TypeScript (DB chỉ lưu trữ).
 */
export async function readAssessmentDetail(id: string): Promise<AssessmentDetail | null> {
  if (id.startsWith("demo-")) {
    const row = DEMO_ASSESSMENTS.find((r) => r.id === id);
    const engineResult = DEMO_RESULTS[id];
    if (!row || !engineResult) return null;
    // Demo: chấm luôn trụ cạnh tranh từ dữ liệu mock minh họa.
    const competitors = await buildDemoCompetitors(id);
    const scored = scoreCompetitionFromView(competitors);
    const result = mergeExternalScores(
      engineResult,
      scored.pillar ? { competition: scored.pillar } : {},
      scored.vetoes,
    );
    return { row, result };
  }

  const db = await createClient();
  if (!db) return null;

  const [assessmentRes, inputsRes, scorecardsRes, vetoesRes] = await Promise.all([
    db.from("vexim_research_assessments").select("*").eq("id", id).maybeSingle(),
    db
      .from("vexim_research_inputs")
      .select("*")
      .eq("assessment_id", id)
      .order("version", { ascending: false })
      .limit(1),
    db.from("vexim_research_scorecards").select("*").eq("assessment_id", id),
    db.from("vexim_research_vetoes").select("*").eq("assessment_id", id),
  ]);

  if (assessmentRes.error) {
    throw new Error(`Không đọc được hồ sơ — ${assessmentRes.error.message}`);
  }
  const row = assessmentRes.data as AssessmentListRow | null;
  if (!row) return null;

  const latest = inputsRes.data?.[0] as { inputs: AssessmentAssumptions } | undefined;
  if (!latest) {
    throw new Error(`Hồ sơ ${row.code} thiếu giả định đầu vào (versioned inputs).`);
  }
  const engineResult = computeAssessment(latest.inputs, new Date(row.created_at));

  // Ghép điểm/veto worker đã chấm từ dữ liệu thu thập (G3+: competition...).
  const overrides: Partial<Record<PillarKey, Pick<PillarScore, "score" | "confidence" | "reason">>> = {};
  for (const s of (scorecardsRes.data ?? []) as Array<{
    pillar: PillarKey;
    score: number | null;
    confidence: PillarScore["confidence"];
    reason: string;
  }>) {
    if (s.score !== null && s.pillar !== "finance" && s.pillar !== "logistics") {
      overrides[s.pillar] = { score: s.score, confidence: s.confidence, reason: s.reason };
    }
  }
  const externalVetoes = ((vetoesRes.data ?? []) as Array<{
    rule_code: VetoFlag["code"];
    severity: VetoFlag["severity"];
    title: string;
    detail: string;
    evidence: Record<string, unknown>;
  }>)
    .filter((v) => v.rule_code === "cr3_above_65" || v.rule_code === "amazon1p_top3")
    .map((v) => ({ code: v.rule_code, severity: v.severity, title: v.title, detail: v.detail, evidence: v.evidence ?? {} }));

  const result = mergeExternalScores(engineResult, overrides, externalVetoes);
  return { row, result };
}

/** Bọc scoreCompetitionFromSnapshots cho snapshot đối thủ đã gộp 1 run. */
function scoreCompetitionFromView(competitors: CompetitorRowView[]) {
  const input: CompetitorRow[] = competitors.map((c) => ({
    asin: c.asin,
    parentAsin: c.parent_asin,
    brand: c.brand,
    isSponsored: c.is_sponsored,
    position: c.position,
    currency: c.currency ?? "USD",
    price: c.price,
    rating: c.rating,
    ratingsTotal: c.ratings_total,
    estUnitsMonth: c.est_units_month,
    estRevenueMonth: c.est_revenue_month,
    isAmazon1p: !!c.is_amazon_1p,
    dataSource: c.data_source === "mock" ? "mock" : "rainforest",
  }));
  const scored = scoreCompetitionFromSnapshots([], input);
  return { pillar: scored.pillar, vetoes: scored.vetoes };
}

/* --------------------------------- G2 ------------------------------------- */

export type ResearchRunRow = {
  run_id: string;
  kind: string;
  status: string;
  provider: string;
  external_id: string | null;
  credits_used: number | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

export type CompetitorRowView = {
  run_id: string;
  position: number;
  is_sponsored: boolean;
  asin: string;
  parent_asin: string | null;
  brand: string | null;
  title: string | null;
  price: number | null;
  currency: string;
  rating: number | null;
  ratings_total: number | null;
  bsr_rank: number | null;
  bsr_category: string | null;
  est_units_month: number | null;
  est_revenue_month: number | null;
  buybox_seller: string | null;
  is_amazon_1p: boolean | null;
  variation_count: number | null;
  data_source: string;
};

export type CollectionData = {
  runs: ResearchRunRow[];
  competitors: CompetitorRowView[];
  reviewCount: number;
  creditSpentMonth: number | null;
  /** review velocity tính từ 2 lần quét gần nhất (null khi chưa đủ 2 mốc) */
  velocity: VelocityResult | null;
};

/* ------------------------------ DEMO G2/G3 -------------------------------- */

/**
 * Dựng snapshot đối thủ MINH HỌA cho hồ sơ demo bằng MockIntelligenceProvider
 * (gắn data_source='mock') — số liệu không phải thị trường thật.
 */
async function buildDemoCompetitors(id: string): Promise<CompetitorRowView[]> {
  const assumptions = DEMO_ASSUMPTIONS[id];
  if (!assumptions) return [];
  const provider = new MockIntelligenceProvider();
  const keyword = assumptions.keywords[0] ?? assumptions.title;
  const search = parseSearchPage(await provider.search({ keyword }), "mock");
  const rows: CompetitorRowView[] = [];
  // Lấy toàn bộ trang SERP mock (4 sponsored + 26 organic); sau gộp variation
  // vẫn còn ≥10 sản phẩm organic để chấm CR3/HHI.
  for (const item of [...search.sponsored, ...search.organic]) {
    const bundle = parseProductBundle({
      product: await provider.product(item.asin),
      offers: await provider.offers(item.asin),
      sales: await provider.salesEstimate({ asin: item.asin }),
    });
    const merged: CompetitorRow = { ...item, ...bundle, dataSource: "mock" };
    rows.push({
      run_id: "demo-run",
      position: merged.position,
      is_sponsored: merged.isSponsored,
      asin: merged.asin,
      parent_asin: merged.parentAsin ?? null,
      brand: merged.brand ?? null,
      title: merged.title ?? null,
      price: merged.price ?? null,
      currency: merged.currency,
      rating: merged.rating ?? null,
      ratings_total: merged.ratingsTotal ?? null,
      bsr_rank: merged.bsrRank ?? null,
      bsr_category: merged.bsrCategory ?? null,
      est_units_month: merged.estUnitsMonth ?? null,
      est_revenue_month: merged.estRevenueMonth ?? null,
      buybox_seller: merged.buyboxSeller ?? null,
      is_amazon_1p: merged.isAmazon1p,
      variation_count: merged.variationCount ?? null,
      data_source: "mock",
    });
  }
  return rows;
}

/** Dữ liệu thu thập G2 cho panel tiến độ trên trang chi tiết. */
export async function readCollectionData(assessmentId: string): Promise<CollectionData | null> {
  if (assessmentId.startsWith("demo-")) {
    const competitors = await buildDemoCompetitors(assessmentId);
    return {
      runs: [],
      competitors,
      reviewCount: 16,
      creditSpentMonth: null,
      velocity: null,
    };
  }
  const db = await createClient();
  if (!db)
    return { runs: [], competitors: [], reviewCount: 0, creditSpentMonth: null, velocity: null };

  const [runsRes, compRes, reviewRes] = await Promise.all([
    db
      .from("vexim_research_runs")
      .select("*")
      .eq("assessment_id", assessmentId)
      .order("created_at", { ascending: false }),
    db
      .from("vexim_research_competitors")
      .select("*")
      .eq("assessment_id", assessmentId)
      .order("position", { ascending: true }),
    db
      .from("vexim_research_reviews")
      .select("source_review_id", { count: "exact", head: true })
      .eq("assessment_id", assessmentId),
  ]);
  if (runsRes.error) throw new Error(`Không đọc được lượt thu thập — ${runsRes.error.message}`);
  if (compRes.error) throw new Error(`Không đọc được dữ liệu đối thủ — ${compRes.error.message}`);

  const runs = (runsRes.data ?? []) as unknown as ResearchRunRow[];
  const allCompetitors = (compRes.data ?? []) as CompetitorRowView[];
  // Giữ lần quét CÓ dữ liệu đối thủ mới nhất (runs đã sắp xếp mới → cũ).
  const runsWithCompetitors = new Set(allCompetitors.map((c) => c.run_id));
  const preferred = runs.map((r) => r.run_id).find((id) => runsWithCompetitors.has(id)) ?? null;
  const competitors = preferred ? allCompetitors.filter((c) => c.run_id === preferred) : [];

  // Review velocity: so 2 lần quét SERP gần nhất (cùng ASIN, lệch ratings_total).
  let velocity: VelocityResult | null = null;
  const serpRuns = runs
    .filter((r) => r.kind === "serp" && r.finished_at)
    .slice(0, 2)
    .sort((a, b) => String(a.finished_at).localeCompare(String(b.finished_at)));
  if (serpRuns.length === 2) {
    const [prevRun, curRun] = serpRuns;
    const toSnap = (r: ResearchRunRow) =>
      allCompetitors
        .filter((c) => c.run_id === r.run_id && !c.is_sponsored && c.ratings_total !== null)
        .map((c) => ({ asin: c.asin, date: String(r.finished_at).slice(0, 10), ratingsTotal: c.ratings_total ?? 0 }));
    velocity = computeReviewVelocity(toSnap(prevRun), toSnap(curRun));
    if (!velocity.sufficientData) velocity = null;
  }

  return {
    runs,
    competitors,
    reviewCount: reviewRes.count ?? 0,
    creditSpentMonth: null,
    velocity,
  };
}
