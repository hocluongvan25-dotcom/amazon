/**
 * Module 8 G4 — test OpenAI REST provider với fetch giả (không gọi mạng):
 * bóc JSON (kể cả bọc ```json), đếm usage + prompt_hash, retry 429,
 * phân loại lỗi 4xx/không-JSON, yêu cầu khóa API.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LlmNotConfiguredError,
  LlmResponseError,
  OpenAiLlmProvider,
} from "../src/lib/ai/openai.ts";
import type { AnalysisReview } from "../src/lib/research/domain/index.ts";

const review: AnalysisReview = {
  asin: "B001",
  sourceReviewId: "RV-1",
  stars: 1,
  title: "Rust",
  body: "The shelf started rusting after three weeks next to the sink.",
  reviewDate: "2026-09-01",
  helpfulCount: 1,
  verified: true,
  photosCount: 0,
  url: "https://amazon/1",
  dataSource: "rainforest",
};

type Json = Record<string, unknown>;
const okResponse = (content: string, usage = { prompt_tokens: 100, completion_tokens: 20 }): Response =>
  new Response(
    JSON.stringify({
      id: "chatcmpl-x",
      model: "gpt-4.1-mini",
      choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
      usage,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

test("mapPainChunk: bóc JSON bọc trong fence ```json, trả usage + promptHash", async () => {
  const payload: Json = {
    observations: [
      {
        reviewId: "RV-1",
        cluster: "quality",
        subLabel: "gỉ sét",
        painTitle: "Khung gỉ sét",
        quote: "shelf started rusting after three weeks next to the sink",
      },
    ],
  };
  let receivedBody: Record<string, unknown> = {};
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    receivedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return okResponse("```json\n" + JSON.stringify(payload) + "\n```");
  }) as typeof fetch;

  const provider = new OpenAiLlmProvider({ apiKey: "sk-test", fetchFn, maxRetries: 0 });
  const res = await provider.mapPainChunk({ assessmentId: "a", chunkIndex: 0, reviews: [review] });

  assert.equal(res.data.observations.length, 1);
  assert.equal(res.data.observations[0].painTitle, "Khung gỉ sét");
  assert.equal(res.usage.promptTokens, 100);
  assert.equal(res.usage.outputTokens, 20);
  assert.equal(res.model, "gpt-4.1-mini");
  assert.match(res.promptHash, /^[0-9a-f]{64}$/);

  // Yêu cầu giao thức: JSON object, nhiệt độ thấp.
  assert.deepEqual(receivedBody.response_format, { type: "json_object" });
  assert.equal(receivedBody.temperature, 0.2);
});

test("retry: 429 kèm retry-after=0 rồi thành công ở lần thử thứ 2", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: "rate limit" } }), {
        status: 429,
        headers: { "retry-after": "0", "content-type": "application/json" },
      });
    }
    return okResponse(JSON.stringify({ observations: [] }));
  }) as typeof fetch;

  const provider = new OpenAiLlmProvider({ apiKey: "sk-test", fetchFn, maxRetries: 2 });
  const res = await provider.mapPainChunk({ assessmentId: "a", chunkIndex: 0, reviews: [review] });
  assert.equal(calls, 2);
  assert.deepEqual(res.data.observations, []);
});

test("401 → LlmResponseError sau 0 lần retry (không nuốt lỗi xác thực)", async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  const provider = new OpenAiLlmProvider({ apiKey: "sk-bad", fetchFn, maxRetries: 1 });
  await assert.rejects(
    () => provider.mapPainChunk({ assessmentId: "a", chunkIndex: 0, reviews: [review] }),
    (e: unknown) => e instanceof LlmResponseError && /401/.test((e as Error).message),
  );
});

test("nội dung không phải JSON → LlmResponseError", async () => {
  const fetchFn = (async () => okResponse("xin lỗi tôi không thể trả lời")) as typeof fetch;
  const provider = new OpenAiLlmProvider({ apiKey: "sk-test", fetchFn, maxRetries: 0 });
  await assert.rejects(
    () => provider.mapPainChunk({ assessmentId: "a", chunkIndex: 0, reviews: [review] }),
    /không phải JSON/,
  );
});

test("thiếu apiKey → LlmNotConfiguredError khi khởi tạo", () => {
  assert.throws(() => new OpenAiLlmProvider({ apiKey: "" }), LlmNotConfiguredError);
});

test("reducePain: thiếu trường drafts vẫn parse được (pipeline sẽ xử lý rỗng)", async () => {
  const fetchFn = (async () =>
    okResponse(JSON.stringify({ drafts: [], narratives: {}, executiveNarrative: null }))) as typeof fetch;
  const provider = new OpenAiLlmProvider({ apiKey: "sk-test", fetchFn, maxRetries: 0 });
  const res = await provider.reducePain({ assessmentId: "a", reviews: [review], observations: [] });
  assert.deepEqual(res.data.drafts, []);
  assert.match(res.promptHash, /^[0-9a-f]{64}$/);
});
