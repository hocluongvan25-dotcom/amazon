/**
 * Module 8 G4 — OpenAI Chat Completions client (REST bằng fetch, KHÔNG SDK).
 *
 * Chỉ chạy server-side; key đọc từ LLM_API_KEY (không tiền tố NEXT_PUBLIC_).
 * Yêu cầu JSON object (response_format=json_object), temperature thấp; mọi
 * response trả kèm usage token để ghi llm_runs. Có retry cho 429/5xx.
 */

import { hashMessages } from "./hash.ts";
import { DEFAULT_MODEL } from "./pricing.ts";
import {
  buildMapMessages,
  buildReduceMessages,
  buildSectionMessages,
} from "./prompts.ts";
import type {
  LlmCallResult,
  LlmProvider,
  MapChunkInput,
  MapChunkOutput,
  ReducePainInput,
  ReducePainOutput,
  SectionNarrativeInput,
  SectionNarrativeOutput,
} from "./types.ts";

export class LlmNotConfiguredError extends Error {
  constructor() {
    super("Chưa cấu hình LLM_API_KEY");
    this.name = "LlmNotConfiguredError";
  }
}
export class LlmResponseError extends Error {}

const ENDPOINT = "https://api.openai.com/v1/chat/completions";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type RawMessage = { role: "system" | "user" | "assistant"; content: string };

export type OpenAiOptions = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  maxRetries?: number;
  maxOutputTokens?: number;
};

export class OpenAiLlmProvider implements LlmProvider {
  readonly name = "openai" as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchFn: typeof fetch;
  private readonly maxRetries: number;
  private readonly maxOutputTokens: number;

  constructor(opts: OpenAiOptions) {
    if (!opts.apiKey) throw new LlmNotConfiguredError();
    this.apiKey = opts.apiKey;
    this.model = opts.model || DEFAULT_MODEL;
    this.endpoint = `${(opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.maxRetries = opts.maxRetries ?? 2;
    this.maxOutputTokens = opts.maxOutputTokens ?? 4000;
  }

  /** Bóc JSON từ phản hồi model (chịu được wrapper ```json). */
  private parseJson<T>(content: string): T {
    const trimmed = content.trim();
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fence?.[1]?.trim() ?? trimmed;
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Tìm object JSON đầu tiên trong văn bản.
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start >= 0 && end > start) {
        return JSON.parse(candidate.slice(start, end + 1)) as T;
      }
      throw new LlmResponseError(`LLM trả về không phải JSON hợp lệ: ${candidate.slice(0, 200)}`);
    }
  }

  private async completeJson<T>(
    messages: RawMessage[],
    section: string,
  ): Promise<LlmCallResult<T>> {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const res = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0.2,
          response_format: { type: "json_object" },
          max_completion_tokens: this.maxOutputTokens,
          // KHÔNG gửi 'metadata': OpenAI (từ ~2025) chỉ chấp nhận khi kèm
          // store=true — mà store=true lưu prompt 30 ngày bên họ. Section đã
          // được ghi trong llm_runs.sectionKey, không cần metadata phía OpenAI.
          // Sự cố 17/09/2026: HTTP 400 "metadata only allowed when store enabled".
        }),
      });

      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`OpenAI HTTP ${res.status}`);
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 800 * 2 ** attempt);
        continue;
      }
      const json = (await res.json()) as {
        error?: { message?: string };
        choices?: { message?: { content?: string }; finish_reason?: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        model?: string;
      };
      if (!res.ok || json.error) {
        throw new LlmResponseError(`OpenAI lỗi HTTP ${res.status}: ${json.error?.message ?? res.statusText}`);
      }
      const content = json.choices?.[0]?.message?.content ?? "";
      const data = this.parseJson<T>(content);
      return {
        data,
        model: json.model ?? this.model,
        promptHash: hashMessages(messages),
        usage: {
          promptTokens: json.usage?.prompt_tokens ?? 0,
          outputTokens: json.usage?.completion_tokens ?? 0,
        },
      };
    }
    throw lastErr ?? new LlmResponseError("OpenAI thất bại không rõ lý do");
  }

  async mapPainChunk(input: MapChunkInput) {
    return this.completeJson<MapChunkOutput>(
      buildMapMessages(input) as RawMessage[],
      `pain_map_${input.chunkIndex}`,
    );
  }

  async reducePain(input: ReducePainInput) {
    return this.completeJson<ReducePainOutput>(
      buildReduceMessages(input) as RawMessage[],
      "pain_reduce",
    );
  }

  async sectionNarrative(input: SectionNarrativeInput) {
    return this.completeJson<SectionNarrativeOutput>(
      buildSectionMessages(input) as RawMessage[],
      `narrative_${input.sectionKey}`,
    );
  }
}

export { ENDPOINT as OPENAI_ENDPOINT };
