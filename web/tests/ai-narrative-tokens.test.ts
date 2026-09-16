/**
 * Module 8 G5/G6 — chống tái phát bug token narrative mất dấu `}`:
 * cả mock lẫn prompt hướng dẫn LLM phải phát hành đúng `{{metric:k}}` /
 * `{{quote:id}}`; sau parse phải ra chip khóa cứng, không còn text thô.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MockLlmProvider } from "../src/lib/ai/mock-llm.ts";
import { buildSectionMessages } from "../src/lib/ai/prompts.ts";
import { markdownLiteToDoc, docToPlainText } from "../src/lib/research/domain/report.ts";
import type { MetricToken, QuoteToken } from "../src/lib/research/domain/report.ts";

const quotes: QuoteToken[] = [
  { reviewId: "B0MOCK006-R01", asin: "B0MOCK006", quote: "rusting after weeks", stars: 1, reviewDate: "2026-08-21", url: null },
];
const metrics: MetricToken[] = [{ key: "base_margin_pct", label: "biên cơ sở", value: "33.8%" }];

test("mock sectionNarrative phát hành token quote đúng định dạng và parse ra quoteChip", async () => {
  const p = new MockLlmProvider();
  const r = await p.sectionNarrative({
    assessmentId: "a1",
    sectionKey: "rd_clusters",
    sectionTitle: "cụm pain",
    brief: "",
    metrics,
    quotes,
    context: "ctx",
  });
  assert.match(r.data.markdown, /\{\{quote:B0MOCK006-R01\}\}/, "phải có token đóng đủ 2 dấu }");
  assert.match(r.data.markdown, /\{\{metric:base_margin_pct\}\}/);

  const { doc, missingTokens } = markdownLiteToDoc(r.data.markdown, {
    metrics: new Map(metrics.map((m) => [m.key, m])),
    quotes: new Map(quotes.map((q) => [q.reviewId, q])),
  });
  assert.deepEqual(missingTokens, []);
  const chipCount = { metric: 0, quote: 0 };
  const walk = (n: { type?: string; content?: unknown[] }): void => {
    if (n.type === "metricToken") chipCount.metric++;
    if (n.type === "quoteChip") chipCount.quote++;
    (n.content as { type?: string; content?: unknown[] }[])?.forEach(walk);
  };
  (doc.content ?? []).forEach(walk as never);
  assert.equal(chipCount.quote, 1, "phải có 1 quoteChip");
  assert.ok(chipCount.metric >= 1);
  assert.ok(!docToPlainText(doc).includes("{{"), "không được còn token text thô");
});

test("buildSectionMessages: danh sách cấp phép in đúng token {{quote:id}}", () => {
  const messages = buildSectionMessages({
    assessmentId: "a1",
    sectionKey: "rd_pain_top",
    sectionTitle: "top pain",
    brief: "",
    metrics,
    quotes,
    context: "ctx",
  });
  const joined = messages.map((m) => m.content).join("\n");
  assert.match(joined, /\{\{quote:B0MOCK006-R01\}\}/);
  assert.match(joined, /\{\{metric:base_margin_pct\}\}/);
});
