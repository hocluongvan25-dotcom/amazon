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
    p_provider: null,
  });
  if (error) return { ok: false, message: error.message };
  const out = data as { ok: boolean; run_id: string };
  revalidatePath(`/research/${assessmentId}`);
  return { ok: true, message: `Đã xếp hàng lượt "${kind}" (${out.run_id.slice(0, 8)}). Worker/cron sẽ nhận và chạy.` };
}

/**
 * G4 — xếp hàng phân tích pain bằng LLM (run kind='analyze', provider='llm').
 * Yêu cầu worker có LLM_API_KEY (không có thì worker chạy mock và gắn
 * provider='mock' — UI hiển thị rõ để không nhầm với phân tích thật).
 */
export async function enqueueAnalyzeAction(assessmentId: string): Promise<EnqueueState> {
  const db = await createClient();
  if (!db) {
    return { ok: false, message: "DEMO MODE: không xếp hàng phân tích được; cần Supabase + worker." };
  }
  const { data, error } = await db.rpc("vexim_research_enqueue_run", {
    p_assessment: assessmentId,
    p_kind: "analyze",
    p_params: { chunkSize: 25 },
    p_provider: "llm",
  });
  if (error) return { ok: false, message: error.message };
  const out = data as { ok: boolean; run_id: string };
  revalidatePath(`/research/${assessmentId}`);
  return {
    ok: true,
    message: `Đã xếp hàng phân tích pain bằng LLM (${out.run_id.slice(0, 8)}). Worker sẽ map/reduce trên review 1–3★.`,
  };
}

/**
 * G4 — analyst thẩm định lại 1 pain item: đổi ưu tiên must/should/skip và/sửa
 * yêu cầu cho xưởng. RPC chuyển source sang human_confirmed (migration 0028).
 * Tham số null = giữ nguyên; chuỗi rỗng = bỏ gợi ý.
 */
export async function updatePainItemAction(
  assessmentId: string,
  itemKey: string,
  input: {
    priority?: "must" | "should" | "skip";
    factoryRequirement?: string | null;
    listingFix?: string | null;
  },
): Promise<EnqueueState> {
  const db = await createClient();
  if (!db) {
    return { ok: false, message: "DEMO MODE: bản demo không lưu chỉnh sửa pain." };
  }
  const { error } = await db.rpc("vexim_research_update_pain_item", {
    p_assessment: assessmentId,
    p_item_key: itemKey,
    p_priority: input.priority ?? null,
    p_factory_requirement:
      input.factoryRequirement === undefined ? null : input.factoryRequirement,
    p_listing_fix: input.listingFix === undefined ? null : input.listingFix,
  });
  if (error) return { ok: false, message: error.message };
  revalidatePath(`/research/${assessmentId}`);
  return { ok: true, message: `Đã cập nhật pain "${itemKey}".` };
}
