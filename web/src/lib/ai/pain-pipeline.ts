/**
 * Module 8 G4 — điều phối phân cụm pain bằng LLM (map/reduce), server-only.
 *
 *   review 1–3★ (đã lưu) ──MAP (theo lô ≤chunkSize)──▶ quan sát có trích dẫn
 *   ──REDUCE (1 lượt)──▶ draft pain ──validate & TÍNH LẠI deterministic──▶
 *   PainAnalysis (clusters/items/quotes/specs) + điểm trụ differentiation.
 *
 * Mọi lượt gọi LLM đều sinh LlmRunRecord (token/cost/prompt_hash) để ghi
 * research.llm_runs; không khớp giá token của model thì ném lỗi (không âm
 * thầm tính sai chi phí). Quote không truy gốc bị loại và đếm công khai.
 */

import {
  PAIN_SCHEMA_VERSION,
  reducePainAnalysis,
  scoreDifferentiation,
  validateObservations,
  type AnalysisReview,
  type PainAnalysis,
  type PainClusterCode,
  type PainObservation,
} from "../research/domain/pain.ts";
import { estimateLlmCost } from "./pricing.ts";
import type {
  LlmProvider,
  LlmRunRecord,
  MapChunkInput,
  ReducePainInput,
} from "./types.ts";

export const DEFAULT_CHUNK_SIZE = 25;

export type PainPipelineOptions = {
  assessmentId: string;
  reviews: AnalysisReview[];
  provider: LlmProvider;
  chunkSize?: number;
  createdBy?: "ai" | "human_regen";
  now?: Date;
  /** bối cảnh ngách gửi kèm mỗi lô map */
  context?: { title?: string; keywords?: string[]; marketplace?: string };
  log?: (line: string) => void;
  /** Ghi llm_runs (worker cắm RPC; test để trống). */
  recordRun?: (rec: LlmRunRecord) => Promise<void> | void;
};

export type PainPipelineResult = {
  analysis: PainAnalysis;
  differentiation: ReturnType<typeof scoreDifferentiation>;
  llmRuns: LlmRunRecord[];
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
};

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Lọc review đủ nội dung để trích dẫn; khử trùng source_review_id. */
export function prepareReviews(reviews: AnalysisReview[]): AnalysisReview[] {
  const seen = new Set<string>();
  const out: AnalysisReview[] = [];
  for (const r of reviews) {
    if (seen.has(r.sourceReviewId)) continue;
    const words = (r.body.match(/[\p{L}\p{N}]+/gu) ?? []).length;
    if (words < 4) continue; // câu quá ngắn không đủ để trích pain
    seen.add(r.sourceReviewId);
    out.push(r);
  }
  return out;
}

function costOf(
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const cost = estimateLlmCost(model, tokensIn, tokensOut);
  if (cost === null) {
    // Chốt an toàn tài chính: chưa khai báo giá model thì dừng, không ghi bừa.
    throw new Error(`Chưa khai báo giá token cho model "${model}" — bổ sung bảng LLM_PRICING trước khi chạy`);
  }
  return cost;
}

async function record(
  rec: LlmRunRecord,
  opts: PainPipelineOptions,
): Promise<void> {
  opts.log?.(
    `[llm] ${rec.sectionKey}${rec.chunkIndex !== null ? ` #${rec.chunkIndex}` : ""} ${rec.status} ` +
      `${rec.model} · ${rec.tokensIn}+${rec.tokensOut} tok · $${rec.costUsd.toFixed(5)}`,
  );
  await opts.recordRun?.(rec);
}

export async function runPainPipeline(
  opts: PainPipelineOptions,
): Promise<PainPipelineResult> {
  const createdBy = opts.createdBy ?? "ai";
  const now = (opts.now ?? new Date()).toISOString();
  const reviews = prepareReviews(opts.reviews);
  const provider = opts.provider;
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;

  const llmRuns: LlmRunRecord[] = [];
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCostUsd = 0;

  // ------------------------------ MAP ------------------------------
  const observations: PainObservation[] = [];
  const chunks = chunk(reviews, chunkSize);
  let preDropped = 0;
  let preQuotesDropped = 0;
  opts.log?.(`[llm] map: ${reviews.length} review chia ${chunks.length} lô (≤${chunkSize})`);

  for (let i = 0; i < chunks.length; i++) {
    const input: MapChunkInput = {
      assessmentId: opts.assessmentId,
      chunkIndex: i,
      reviews: chunks[i],
      context: opts.context,
    };
    const chunkIds = new Set(chunks[i].map((r) => r.sourceReviewId));
    try {
      const res = await provider.mapPainChunk(input);
      const cost = costOf(res.model, res.usage.promptTokens, res.usage.outputTokens);
      // Chỉ nhận quan sát trỏ ĐÚNG vào review của lô (chống gán id xuyên lô),
      // và xác thực nguyên văn câu trích NGAY ở bước map để không rác sang reduce.
      const inChunk = (res.data.observations ?? []).filter((o) => chunkIds.has(o.reviewId));
      const checked = validateObservations(inChunk, chunks[i]);
      observations.push(...checked.valid.map((v) => v.obs));
      preDropped += checked.dropped;
      preQuotesDropped += checked.quotesDropped;
      totalTokensIn += res.usage.promptTokens;
      totalTokensOut += res.usage.outputTokens;
      totalCostUsd += cost;
      const rec: LlmRunRecord = {
        assessmentId: opts.assessmentId,
        sectionKey: "pain_map",
        provider: provider.name,
        model: res.model,
        promptHash: res.promptHash,
        inputRefs: { chunkIndex: i, reviewIds: chunks[i].map((r) => r.sourceReviewId) },
        output: res.data,
        tokensIn: res.usage.promptTokens,
        tokensOut: res.usage.outputTokens,
        costUsd: cost,
        status: "ok",
        error: null,
        chunkIndex: i,
        createdBy,
        createdAt: now,
      };
      llmRuns.push(rec);
      await record(rec, opts);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      const rec: LlmRunRecord = {
        assessmentId: opts.assessmentId,
        sectionKey: "pain_map",
        provider: provider.name,
        model: provider.model,
        promptHash: "",
        inputRefs: { chunkIndex: i, reviewIds: chunks[i].map((r) => r.sourceReviewId) },
        output: null,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        status: "failed",
        error: err,
        chunkIndex: i,
        createdBy,
        createdAt: now,
      };
      llmRuns.push(rec);
      await record(rec, opts);
      throw new Error(`MAP lô ${i} thất bại: ${err}`);
    }
  }

  // ----------------------------- REDUCE -----------------------------
  const reduceInput: ReducePainInput = {
    assessmentId: opts.assessmentId,
    reviews,
    observations,
  };
  let analysis: PainAnalysis;
  try {
    const res = await provider.reducePain(reduceInput);
    const cost = costOf(res.model, res.usage.promptTokens, res.usage.outputTokens);
    totalTokensIn += res.usage.promptTokens;
    totalTokensOut += res.usage.outputTokens;
    totalCostUsd += cost;

    // Tính LẠI toàn bộ tần suất/nghiêm trọng/ưu tiên/quote từ dữ liệu gốc.
    const reduced = reducePainAnalysis({
      drafts: res.data.drafts ?? [],
      observations,
      reviews,
      narratives: res.data.narratives as Partial<Record<PainClusterCode, string | null>>,
      executiveNarrative: res.data.executiveNarrative ?? null,
      provider: provider.name,
      model: res.model,
      generatedAt: now,
    });
    analysis = reduced.analysis;
    // Ghi version ổn định nếu model mock cũ chưa set.
    analysis.schemaVersion = PAIN_SCHEMA_VERSION;
    // Cộng các quan sát/quote đã loại NGAY sau map (validate lần 2 trong
    // reducePainAnalysis chỉ còn thấy dữ liệu sạch nên không phát sinh thêm).
    analysis.quotesDropped += preQuotesDropped;
    analysis.observationsDropped += preDropped;

    const rec: LlmRunRecord = {
      assessmentId: opts.assessmentId,
      sectionKey: "pain_reduce",
      provider: provider.name,
      model: res.model,
      promptHash: res.promptHash,
      inputRefs: { observationCount: observations.length, reviewCount: reviews.length },
      output: res.data,
      tokensIn: res.usage.promptTokens,
      tokensOut: res.usage.outputTokens,
      costUsd: cost,
      status: "ok",
      error: null,
      chunkIndex: null,
      createdBy,
      createdAt: now,
    };
    llmRuns.push(rec);
    await record(rec, opts);
    opts.log?.(
      `[llm] reduce xong: ${analysis.items.length} pain · ${analysis.quotesDropped} quote loại do không truy gốc · $${totalCostUsd.toFixed(5)}`,
    );
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    const rec: LlmRunRecord = {
      assessmentId: opts.assessmentId,
      sectionKey: "pain_reduce",
      provider: provider.name,
      model: provider.model,
      promptHash: "",
      inputRefs: { observationCount: observations.length, reviewCount: reviews.length },
      output: null,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      status: "failed",
      error: err,
      chunkIndex: null,
      createdBy,
      createdAt: now,
    };
    llmRuns.push(rec);
    await record(rec, opts);
    throw new Error(`REDUCE thất bại: ${err}`);
  }

  return {
    analysis,
    differentiation: scoreDifferentiation(analysis),
    llmRuns,
    totalTokensIn,
    totalTokensOut,
    totalCostUsd,
  };
}

/** Báo cáo ngắn cho UI/log (đếm quote bị loại từ bước validate cuối). */
export function summarizeValidation(
  observations: PainObservation[],
  reviews: AnalysisReview[],
): { valid: number; dropped: number; quotesDropped: number } {
  const v = validateObservations(observations, reviews);
  return { valid: v.valid.length, dropped: v.dropped, quotesDropped: v.quotesDropped };
}
