/**
 * Module 8 G4 — hợp đồng tầng LLM (server-only).
 *
 * Gọi THẲNG REST bằng fetch (không SDK) đúng nguyên tắc phụ lục C của kế
 * hoạch. Mọi lần gọi sinh usage token để ghi research.llm_runs; output bắt
 * buộc khớp schema JSON (hỏng schema → ném lỗi, job lưu run status=failed).
 */

import type {
  AnalysisReview,
  PainClusterCode,
  PainItemDraft,
  PainObservation,
} from "../research/domain/pain.ts";

export type LlmProviderName = "openai" | "mock";

export type LlmUsage = {
  promptTokens: number;
  outputTokens: number;
};

export type LlmCallResult<T> = {
  data: T;
  usage: LlmUsage;
  /** model THỰC TẾ trả kết quả (provider có thể fallback model rẻ hơn). */
  model: string;
  /** băm SHA-256 của prompt gửi đi (cache regenerate + truy vết llm_runs). */
  promptHash: string;
};

/* ------------------------------- MAP (G4) ------------------------------- */

export type MapChunkInput = {
  assessmentId: string;
  chunkIndex: number;
  reviews: AnalysisReview[];
  /** bối cảnh ngách giúp LLM diễn giải đúng nội dung review */
  context?: {
    title?: string;
    keywords?: string[];
    marketplace?: string;
  };
};

export type MapChunkOutput = {
  observations: PainObservation[];
};

/* ------------------------------ REDUCE (G4) ----------------------------- */

export type ReducePainInput = {
  assessmentId: string;
  reviews: AnalysisReview[];
  observations: PainObservation[];
};

export type ReducePainOutput = {
  /** Top 3–5 pain toàn ngách (reviewIds để hệ thống đếm lại tần suất). */
  drafts: PainItemDraft[];
  /** Dàn ý ngắn theo 3 cụm (tiếng Việt), đánh nhãn AI nháp. */
  narratives: Partial<Record<PainClusterCode, string>>;
  executiveNarrative: string;
};

export interface LlmProvider {
  readonly name: LlmProviderName;
  readonly model: string;
  /** MAP: gán nhãn cụm + trích nguyên văn câu pain cho từng review. */
  mapPainChunk(input: MapChunkInput): Promise<LlmCallResult<MapChunkOutput>>;
  /** REDUCE: gom pain toàn ngách, chọn quote, gợi ý yêu cầu kỹ thuật. */
  reducePain(input: ReducePainInput): Promise<LlmCallResult<ReducePainOutput>>;
}

/** Bản ghi nhật ký 1 lần gọi LLM để ghi research.llm_runs. */
export type LlmRunRecord = {
  assessmentId: string;
  sectionKey: "pain_map" | "pain_reduce";
  provider: LlmProviderName;
  model: string;
  promptHash: string;
  inputRefs: Record<string, unknown>;
  output: unknown;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  status: "ok" | "failed";
  error: string | null;
  chunkIndex: number | null;
  createdBy: "ai" | "human_regen";
  createdAt: string;
};
