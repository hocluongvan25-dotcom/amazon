"use server";

/**
 * Module 8 G5 — server actions cho Report Canvas (theo PHIÊN NGƯỜI DÙNG).
 * Mọi ghi DB qua RPC security-definer của migration 0029; web không dùng
 * service_role. LLM gọi server-side bằng LLM_API_KEY (không lộ ra client);
 * câu trích/số đưa vào doc đều bị DB đối chiếu lại khi section_save.
 */

import { revalidatePath } from "next/cache";
import { getLlmProvider, estimateLlmCost } from "@/lib/ai";
import {
  SECTION_REGISTRY,
  markdownLiteToDoc,
  validateDocShape,
  type SectionStatus,
  type TiptapDoc,
} from "@/lib/research/domain";
import { createClient } from "@/lib/supabase/server";
import { loadNarrativeContext } from "@/lib/data/research-report";
import type { LlmRunRecord } from "@/lib/ai/types";

export type ReportActionState = { ok: boolean; message: string; [k: string]: unknown };

async function dbOrDemo(): Promise<
  | ReturnType<typeof createClient>
  | null
> {
  return createClient();
}

const revalidate = (id: string) => revalidatePath(`/research/${id}/editor`);

export async function openDraftAction(assessmentId: string): Promise<ReportActionState> {
  const db = await dbOrDemo();
  if (!db) return { ok: false, message: "DEMO MODE: bản demo không tạo version thật." };
  const { data, error } = await db.rpc("vexim_research_report_open_draft", { p_assessment: assessmentId });
  if (error) return { ok: false, message: error.message };
  revalidate(assessmentId);
  return { ok: true, message: `Đã mở bản nháp v${(data as { versionNo: number }).versionNo}.` };
}

/* ------------------------------- LOCK ----------------------------------- */

export async function lockSectionAction(
  assessmentId: string,
  version: number,
  sectionKey: string,
  release: boolean,
): Promise<ReportActionState & { lockOwner?: string | null; mine?: boolean }> {
  const db = await dbOrDemo();
  if (!db) return { ok: true, message: "demo", mine: true, lockOwner: null };
  const { data, error } = await db.rpc("vexim_research_report_section_lock", {
    p_assessment: assessmentId,
    p_version: version,
    p_section: sectionKey,
    p_release: release,
  });
  if (error) return { ok: false, message: error.message };
  const r = data as { ok: boolean; mine: boolean; lockOwner: string | null; message?: string };
  return { ok: r.ok, message: r.message ?? "", mine: r.mine, lockOwner: r.lockOwner };
}

/* ------------------------------- SAVE ----------------------------------- */

export async function saveSectionAction(
  assessmentId: string,
  version: number,
  sectionKey: string,
  content: TiptapDoc,
  source: "human" | "ai" | "human_regen" = "human",
  llmRunId: string | null = null,
): Promise<ReportActionState> {
  const shapeErrors = validateDocShape(content);
  if (shapeErrors.length) {
    return { ok: false, message: `Nội dung không hợp lệ: ${shapeErrors.join("; ")}` };
  }
  const db = await dbOrDemo();
  if (!db) return { ok: true, message: "DEMO MODE: bản demo không lưu nội dung." };
  const { error } = await db.rpc("vexim_research_report_section_save", {
    p_assessment: assessmentId,
    p_version: version,
    p_section: sectionKey,
    p_content: content,
    p_source: source,
    p_llm_run_id: llmRunId,
  });
  if (error) return { ok: false, message: error.message };
  revalidate(assessmentId);
  return { ok: true, message: "Đã lưu" };
}

/* ------------------------------ VERIFY ---------------------------------- */

export async function verifySectionAction(
  assessmentId: string,
  version: number,
  sectionKey: string,
  verify: boolean,
): Promise<ReportActionState & { status?: SectionStatus }> {
  const db = await dbOrDemo();
  if (!db) return { ok: false, message: "DEMO MODE: không ký version thật." };
  const { data, error } = await db.rpc("vexim_research_report_verify_section", {
    p_assessment: assessmentId,
    p_version: version,
    p_section: sectionKey,
    p_verify: verify,
  });
  if (error) return { ok: false, message: error.message };
  revalidate(assessmentId);
  const r = data as { status: SectionStatus };
  return { ok: true, message: verify ? `Đã ký "${sectionKey}".` : `Đã bỏ ký "${sectionKey}".`, status: r.status };
}

/* --------------------------- LLM REGENERATE ----------------------------- */

/**
 * Sinh lại 1 khối narrative bằng LLM. KHÔNG tự ghi đè: trả doc + llmRunId để
 * UI hiện diff cho người soát; chấp nhận mới gọi saveSectionAction.
 */
export async function regenerateSectionAction(
  assessmentId: string,
  version: number,
  sectionKey: string,
): Promise<ReportActionState & { doc?: TiptapDoc; llmRunId?: string; missingTokens?: string[]; costUsd?: number }> {
  void version;
  const def = SECTION_REGISTRY.find((s) => s.key === sectionKey);
  if (!def?.narrative) return { ok: false, message: `Section ${sectionKey} không có khối narrative.` };

  const ctx = await loadNarrativeContext(assessmentId);
  const { provider } = getLlmProvider();
  let result;
  try {
    result = await provider.sectionNarrative({
      assessmentId,
      sectionKey,
      sectionTitle: def.title,
      brief: def.brief,
      metrics: ctx.metrics,
      quotes: ctx.quotes,
      context: ctx.contextText,
    });
  } catch (e) {
    return { ok: false, message: `LLM lỗi: ${e instanceof Error ? e.message : String(e)}` };
  }

  const cost = estimateLlmCost(result.model, result.usage.promptTokens, result.usage.outputTokens);
  if (cost === null) {
    return { ok: false, message: `Chưa khai báo giá token cho model "${result.model}" — không ghi run mù chi phí.` };
  }
  const resolution = {
    metrics: new Map(ctx.metrics.map((m) => [m.key, m])),
    quotes: new Map(ctx.quotes.map((q) => [q.reviewId, q])),
  };
  const converted = markdownLiteToDoc(result.data.markdown, resolution);

  const db = await dbOrDemo();
  let llmRunId: string | null = null;
  if (db) {
    const run: LlmRunRecord = {
      assessmentId,
      sectionKey: `narrative_${sectionKey}` as `narrative_${string}`,
      provider: provider.name,
      model: result.model,
      promptHash: result.promptHash,
      inputRefs: { sectionKey, metrics: ctx.metrics.map((m) => m.key), quoteIds: ctx.quotes.map((q) => q.reviewId) },
      output: result.data,
      tokensIn: result.usage.promptTokens,
      tokensOut: result.usage.outputTokens,
      costUsd: cost,
      status: "ok",
      error: null,
      chunkIndex: null,
      createdBy: "human_regen",
      createdAt: new Date().toISOString(),
    };
    const { data: runData, error: runErr } = await db.rpc("vexim_research_record_narrative_run", { p_run: run });
    if (runErr) return { ok: false, message: `Ghi nhật ký LLM lỗi: ${runErr.message}` };
    llmRunId = (runData as { id: string }).id;
  }

  return {
    ok: true,
    message: provider.name === "mock" ? "Đã sinh nháp bằng MOCK." : `Đã sinh nháp bằng ${result.model}.`,
    doc: converted.doc,
    llmRunId: llmRunId ?? undefined,
    missingTokens: converted.missingTokens,
    costUsd: cost,
  };
}

/** AI soát nháp HÀNG LOẠT các section còn trống (chưa có chữ/đang 'empty'). */
export async function generateAllDraftsAction(
  assessmentId: string,
  version: number,
): Promise<ReportActionState & { drafted?: number }> {
  const db = await dbOrDemo();
  if (!db) return { ok: false, message: "DEMO MODE: bản demo đã có sẵn nháp mock." };
  const ctx = await loadNarrativeContext(assessmentId);
  const { provider } = getLlmProvider();
  const resolution = {
    metrics: new Map(ctx.metrics.map((m) => [m.key, m])),
    quotes: new Map(ctx.quotes.map((q) => [q.reviewId, q])),
  };
  const defs = SECTION_REGISTRY.filter((s) => s.narrative);
  let drafted = 0;
  const errors: string[] = [];

  const runOne = async (def: (typeof defs)[number]): Promise<void> => {
    try {
      const result = await provider.sectionNarrative({
        assessmentId,
        sectionKey: def.key,
        sectionTitle: def.title,
        brief: def.brief,
        metrics: ctx.metrics,
        quotes: ctx.quotes,
        context: ctx.contextText,
      });
      const cost = estimateLlmCost(result.model, result.usage.promptTokens, result.usage.outputTokens);
      if (cost === null) throw new Error(`thiếu bảng giá model ${result.model}`);
      const { doc, missingTokens } = markdownLiteToDoc(result.data.markdown, resolution);
      const shape = validateDocShape(doc);
      if (shape.length) throw new Error(shape.join("; "));
      const run: LlmRunRecord = {
        assessmentId,
        sectionKey: `narrative_${def.key}` as `narrative_${string}`,
        provider: provider.name,
        model: result.model,
        promptHash: result.promptHash,
        inputRefs: { sectionKey: def.key },
        output: result.data,
        tokensIn: result.usage.promptTokens,
        tokensOut: result.usage.outputTokens,
        costUsd: cost,
        status: "ok",
        error: null,
        chunkIndex: null,
        createdBy: "human_regen",
        createdAt: new Date().toISOString(),
      };
      const { data: runData, error: runErr } = await db.rpc("vexim_research_record_narrative_run", { p_run: run });
      if (runErr) throw runErr;
      const save = await saveSectionAction(
        assessmentId,
        version,
        def.key,
        doc,
        "ai",
        (runData as { id: string }).id,
      );
      if (!save.ok) throw new Error(save.message);
      if (missingTokens.length) errors.push(`${def.key}: bỏ token ${missingTokens.join(", ")}`);
      drafted++;
    } catch (e) {
      errors.push(`${def.key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // 3 section song song mỗi đợt.
  for (let i = 0; i < defs.length; i += 3) {
    await Promise.all(defs.slice(i, i + 3).map(runOne));
  }
  revalidate(assessmentId);
  return {
    ok: errors.length === 0,
    drafted,
    message: errors.length
      ? `Đã nháp ${drafted} section; lỗi/thiếu: ${errors.slice(0, 4).join(" | ")}`
      : `Đã soát nháp ${drafted} khối narrative bằng ${provider.model}.`,
  };
}

/* --------------------------- QUY TRÌNH DUYỆT ---------------------------- */

export async function submitReportAction(assessmentId: string): Promise<ReportActionState> {
  const db = await dbOrDemo();
  if (!db) return { ok: false, message: "DEMO MODE: không gửi duyệt bản demo." };
  const { data, error } = await db.rpc("vexim_research_report_submit", { p_assessment: assessmentId });
  if (error) return { ok: false, message: error.message };
  revalidate(assessmentId);
  revalidatePath(`/research/${assessmentId}`);
  return { ok: true, message: `Đã gửi duyệt v${(data as { versionNo: number }).versionNo}; bản chốt bất biến.` };
}

export async function requestChangesAction(assessmentId: string, note: string): Promise<ReportActionState> {
  const db = await dbOrDemo();
  if (!db) return { ok: false, message: "DEMO MODE." };
  const { data, error } = await db.rpc("vexim_research_report_request_changes", {
    p_assessment: assessmentId,
    p_note: note || null,
  });
  if (error) return { ok: false, message: error.message };
  revalidate(assessmentId);
  const r = data as { newVersion: number };
  return { ok: true, message: `Đã trả hồ sơ; bản nháp v${r.newVersion} mở để sửa (ký lại từ đầu).` };
}

export async function ackVetoAction(
  assessmentId: string,
  version: number,
  ruleCode: string,
  note = "",
): Promise<ReportActionState> {
  const db = await dbOrDemo();
  if (!db) return { ok: false, message: "DEMO MODE." };
  const { error } = await db.rpc("vexim_research_report_ack_veto", {
    p_assessment: assessmentId,
    p_version: version,
    p_rule_code: ruleCode,
    p_note: note || null,
  });
  if (error) return { ok: false, message: error.message };
  revalidate(assessmentId);
  return { ok: true, message: `Đã ghi nhận đã nhìn thấy cờ ${ruleCode}.` };
}

export async function approveReportAction(assessmentId: string): Promise<ReportActionState> {
  const db = await dbOrDemo();
  if (!db) return { ok: false, message: "DEMO MODE." };
  const { data, error } = await db.rpc("vexim_research_report_approve", { p_assessment: assessmentId });
  if (error) return { ok: false, message: error.message };
  revalidate(assessmentId);
  revalidatePath(`/research/${assessmentId}`);
  return { ok: true, message: `Đã phê duyệt v${(data as { versionNo: number }).versionNo}.` };
}
