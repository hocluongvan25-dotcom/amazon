/**
 * Module 8 — đọc hồ sơ thẩm định:
 * - Supabase mode: đọc qua view public.vexim_research_* (RLS theo org do
 *   migration 0025 áp); KHÔNG dùng service_role.
 * - Demo mode (chưa cấu hình Supabase): số liệu mẫu tính từ engine G1.
 */

import { computeAssessment, type AssessmentAssumptions, type AssessmentResult } from "@/lib/research/domain";
import { createClient } from "@/lib/supabase/server";
import {
  DEMO_ASSESSMENTS,
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
    const result = DEMO_RESULTS[id];
    if (!row || !result) return null;
    return { row, result };
  }

  const db = await createClient();
  if (!db) return null;

  const [assessmentRes, inputsRes] = await Promise.all([
    db.from("vexim_research_assessments").select("*").eq("id", id).maybeSingle(),
    db
      .from("vexim_research_inputs")
      .select("*")
      .eq("assessment_id", id)
      .order("version", { ascending: false })
      .limit(1),
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
  const result = computeAssessment(latest.inputs, new Date(row.created_at));
  return { row, result };
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
};

/** Dữ liệu thu thập G2 cho panel tiến độ trên trang chi tiết. */
export async function readCollectionData(assessmentId: string): Promise<CollectionData | null> {
  if (assessmentId.startsWith("demo-")) {
    return { runs: [], competitors: [], reviewCount: 0, creditSpentMonth: null };
  }
  const db = await createClient();
  if (!db) return { runs: [], competitors: [], reviewCount: 0, creditSpentMonth: null };

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

  const runs = (runsRes.data ?? []) as ResearchRunRow[];
  const allCompetitors = (compRes.data ?? []) as CompetitorRowView[];
  // Giữ lần quét CÓ dữ liệu đối thủ mới nhất (runs đã sắp xếp mới → cũ).
  const runsWithCompetitors = new Set(allCompetitors.map((c) => c.run_id));
  const preferred = runs.map((r) => r.run_id).find((id) => runsWithCompetitors.has(id)) ?? null;
  const competitors = preferred ? allCompetitors.filter((c) => c.run_id === preferred) : [];

  return {
    runs,
    competitors,
    reviewCount: reviewRes.count ?? 0,
    creditSpentMonth: null,
  };
}
