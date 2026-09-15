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
