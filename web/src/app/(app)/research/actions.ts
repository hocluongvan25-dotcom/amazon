"use server";

/**
 * Module 8 — server action G1: nhận giả định từ form what-if, chạy lại engine
 * ở server (không tin số client gửi), rồi ghi DUY NHẤT qua RPC
 * public.vexim_research_create_assessment (migration 0025). Demo mode không có
 * Supabase → trả kết quả tính nhưng không lưu.
 */

import { revalidatePath } from "next/cache";
import {
  RESEARCH_ENGINE_VERSION,
  computeAssessment,
  validateAssumptions,
} from "@/lib/research/domain";
import { createClient } from "@/lib/supabase/server";
import { formToAssumptions, type ResearchFormRaw } from "@/lib/data/research-model";

export type SaveAssessmentState = {
  ok: boolean;
  message: string;
  code?: string;
  id?: string;
  /** Kết quả engine trả về ngay cả khi không lưu (demo) để client hiển thị. */
  computed?: {
    verdict: string;
    overallScore: number | null;
    baseMarginPct: number;
    pessMarginPct: number;
    redVetoCount: number;
  };
};

export async function saveAssessmentAction(raw: ResearchFormRaw): Promise<SaveAssessmentState> {
  const assumptions = formToAssumptions(raw);
  const errors = validateAssumptions(assumptions);
  if (errors.length) {
    return { ok: false, message: errors.join(" · ") };
  }

  const result = computeAssessment(assumptions);
  const computed = {
    verdict: result.scorecard.verdict,
    overallScore: result.scorecard.overallScore,
    baseMarginPct: result.financial.scenarios.base.netMarginPct,
    pessMarginPct: result.financial.scenarios.pessimistic.netMarginPct,
    redVetoCount: result.scorecard.vetoes.filter((v) => v.severity === "red").length,
  };

  const db = await createClient();
  if (!db) {
    return {
      ok: false,
      message:
        "DEMO MODE: máy tính what-if đã chạy nhưng bản demo không lưu hồ sơ. Kết nối Supabase để lưu qua RPC (cần vai trò analyst/dept_lead).",
      computed,
    };
  }

  const { data, error } = await db.rpc("vexim_research_create_assessment", {
    p_payload: {
      assumptions,
      result,
      engineVersion: RESEARCH_ENGINE_VERSION,
    },
  });
  if (error) {
    return { ok: false, message: error.message, computed };
  }
  const out = data as { ok: boolean; id: string; code: string };
  revalidatePath("/research");
  return {
    ok: true,
    message: `Đã lưu hồ sơ ${out.code}. G1 lưu được tài chính + scorecard; các trụ Competition/Demand/Differentiation sẽ điền ở G2–G4.`,
    code: out.code,
    id: out.id,
    computed,
  };
}

export type EnqueueState = { ok: boolean; message: string };

/**
 * G2 — analyst xếp hàng 1 lượt thu thập (serp/products/reviews). Ghi qua RPC
 * vexim_research_enqueue_run bằng PHIÊN NGƯỜI DÙNG (không service_role); worker
 * /cron nhận việc sau đó.
 */
export async function enqueueCollectionAction(
  assessmentId: string,
  kind: "serp" | "products" | "reviews",
  params: Record<string, unknown> = {},
): Promise<EnqueueState> {
  const db = await createClient();
  if (!db) {
    return {
      ok: false,
      message: "DEMO MODE: không xếp hàng thu thập được; cần Supabase + worker/cron.",
    };
  }
  const { data, error } = await db.rpc("vexim_research_enqueue_run", {
    p_assessment: assessmentId,
    p_kind: kind,
    p_params: params,
  });
  if (error) return { ok: false, message: error.message };
  const out = data as { ok: boolean; run_id: string };
  revalidatePath(`/research/${assessmentId}`);
  return { ok: true, message: `Đã xếp hàng lượt "${kind}" (${out.run_id.slice(0, 8)}). Worker/cron sẽ nhận và chạy.` };
}
