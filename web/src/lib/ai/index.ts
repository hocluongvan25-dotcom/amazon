/**
 * Module 8 G4 — factory tầng AI (server-only).
 *
 *   LLM_PROVIDER=openai + LLM_API_KEY  → OpenAiLlmProvider (model LLM_MODEL
 *                                        hoặc mặc định gpt-4.1-mini)
 *   thiếu key / provider=mock          → MockLlmProvider (deterministic,
 *                                        data_source='mock', không tốn tiền)
 *
 * Job ghi rõ provider+model vào llm_runs để UI luôn phân biệt được dữ liệu
 * phân tích thật với dữ liệu giả lập.
 */

import { MockLlmProvider } from "./mock-llm.ts";
import { OpenAiLlmProvider } from "./openai.ts";
import { DEFAULT_MODEL } from "./pricing.ts";
import type { LlmProvider } from "./types.ts";

export type LlmContext = {
  provider: LlmProvider;
  /** true khi có khóa OpenAI thật */
  configured: boolean;
};

export function getLlmProvider(env: NodeJS.ProcessEnv = process.env): LlmContext {
  // Mặc định: CÓ LLM_API_KEY là chạy OpenAI (LLM_PROVIDER không cần điền);
  // đặt LLM_PROVIDER=mock (hoặc để trống key) để ép dùng mock không tốn tiền.
  const providerName = (env.LLM_PROVIDER ?? "").trim().toLowerCase();
  const apiKey = env.LLM_API_KEY?.trim();
  if (providerName !== "mock" && apiKey) {
    return {
      configured: true,
      provider: new OpenAiLlmProvider({
        apiKey,
        model: env.LLM_MODEL?.trim() || DEFAULT_MODEL,
        baseUrl: env.OPENAI_BASE_URL?.trim() || undefined,
      }),
    };
  }
  return { configured: false, provider: new MockLlmProvider() };
}

export * from "./types.ts";
export * from "./pricing.ts";
export * from "./pain-pipeline.ts";
export * from "./prompts.ts";
export { MockLlmProvider } from "./mock-llm.ts";
export { OpenAiLlmProvider, LlmNotConfiguredError, LlmResponseError } from "./openai.ts";
