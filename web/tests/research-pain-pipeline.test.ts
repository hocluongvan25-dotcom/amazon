/**
 * Module 8 G4 — test tầng AI: mock provider deterministic, pipeline
 * map/reduce end-to-end (quote truy gốc, đếm token/cost, chặn model lạ),
 * bảng giá token.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MockLlmProvider, estimateLlmCost, runPainPipeline } from "../src/lib/ai/index.ts";
import {
  PAIN_CLUSTER_ORDER,
  extractVerbatimQuote,
  type AnalysisReview,
} from "../src/lib/research/domain/index.ts";

const SNIPPETS: { stars: number; title: string; body: string }[] = [
  { stars: 1, title: "Rusted within weeks", body: "This started rusting after three weeks next to the sink, even though I dried it by hand. Disappointing for stainless steel." },
  { stars: 2, title: "Wobbles with light weight", body: "The shelf wobbles badly once you put a few plates on it. The feet are uneven and there is no way to adjust them." },
  { stars: 1, title: "Sharp metal edges", body: "There is a sharp burr along one edge and I cut my finger while assembling it. Needs better finishing at the factory." },
  { stars: 2, title: "Arrived dented", body: "Box was fine but the metal panel arrived bent in the corner, like it was dropped before packing. Frustrating." },
  { stars: 1, title: "Missing screws", body: "Hardware pack was missing four screws so I could not finish assembly without a trip to the hardware store." },
  { stars: 2, title: "Smaller than the photos", body: "The dimensions in the listing make it look bigger. My dinner plates do not fit upright at all." },
  { stars: 1, title: "Coating peels off", body: "The black coating started peeling after a month and leaves dark flecks on my clean dishes." },
  { stars: 2, title: "Rust spots after dishwasher", body: "Top rack dishwasher was supposed to be fine but rust spots appeared around the welds after two washes." },
  { stars: 1, title: "Cheap thin metal", body: "Much thinner than expected. It flexes when you pick it up and feels like it could bend permanently." },
  { stars: 2, title: "Assembly holes do not line up", body: "The pre-drilled holes are slightly off so the rack never sits square. I had to force the screws." },
  { stars: 1, title: "Broke after two months", body: "One of the support bars snapped under normal use. We only kept mugs and cereal bowls on it." },
  { stars: 2, title: "Packaging crushed", body: "The packaging is just thin plastic and the item was scratched on arrival. Needs more protection." },
];

/** Nhân kho review ra ≥30 review trên 8 ASIN (mỗi ASIN lệch nội dung 1 chút). */
function buildReviews(): AnalysisReview[] {
  const out: AnalysisReview[] = [];
  let n = 0;
  for (let a = 0; a < 8; a++) {
    for (let s = 0; s < SNIPPETS.length; s++) {
      if (n >= 96) break;
      const snip = SNIPPETS[s];
      const asin = `B0A${String(a + 1).padStart(2, "0")}TEST`;
      out.push({
        asin,
        sourceReviewId: `R${n}`,
        dbId: `db-${n}`,
        stars: snip.stars,
        title: snip.title,
        body: snip.body,
        reviewDate: `2026-0${(n % 8) + 1}-1${n % 9}`,
        helpfulCount: (s * 3) % 17,
        verified: s % 2 === 0,
        photosCount: s % 5 === 0 ? 1 : 0,
        url: `https://www.amazon.com/dp/${asin}#R${n}`,
        dataSource: "rainforest",
      });
      n++;
    }
  }
  return out;
}

test("bảng giá: model khai báo tính đúng; model lạ → null", () => {
  assert.equal(estimateLlmCost("gpt-4.1-mini", 1_000_000, 1_000_000), 0.4 + 1.6);
  assert.equal(estimateLlmCost("gpt-4o-mini", 1_000_000, 0), 0.15);
  assert.equal(estimateLlmCost("mock-llm-1", 9999, 9999), 0);
  assert.equal(estimateLlmCost("model-khong-ton-tai", 1, 1), null);
});

test("pipeline mock end-to-end: pain đủ 3 cụm, quote truy gốc, cost=0, llm_runs đầy đủ", async () => {
  const reviews = buildReviews();
  const provider = new MockLlmProvider();
  const records: unknown[] = [];
  const result = await runPainPipeline({
    assessmentId: "assess-1",
    reviews,
    provider,
    chunkSize: 25,
    log: () => {},
    recordRun: async (r) => { records.push(r); },
    now: new Date("2026-09-16T00:00:00Z"),
  });

  const { analysis } = result;
  assert.equal(analysis.provider, "mock");
  assert.equal(analysis.model, "mock-llm-1");
  assert.ok(analysis.sampleSize >= 30, `mẫu ${analysis.sampleSize}`);
  assert.equal(analysis.asinCount, 8);

  const codes = analysis.clusters.map((c) => c.code);
  assert.deepEqual(codes, PAIN_CLUSTER_ORDER);
  // dữ liệu mock có cả 3 loại pain
  const nonEmpty = analysis.clusters.filter((c) => c.itemCount > 0).map((c) => c.code);
  assert.ok(nonEmpty.includes("quality"));
  assert.ok(nonEmpty.includes("expectation_gap"));
  assert.ok(nonEmpty.includes("logistics"));

  // items ≤ 5, mọi item có 1-3 quote và quote truy được ASIN–sao–ngày–link
  assert.ok(analysis.items.length >= 4 && analysis.items.length <= 5);
  for (const item of analysis.items) {
    assert.ok(item.quotes.length >= 1 && item.quotes.length <= 3);
    for (const q of item.quotes) {
      const src = reviews.find((r) => r.sourceReviewId === q.reviewId)!;
      assert.ok(src, "quote phải trỏ review tồn tại");
      // Mọi đoạn (đã bỏ dấu …) phải truy nguyên văn trong body của đúng review.
      for (const seg of q.quote.split(" … ")) {
        assert.ok(extractVerbatimQuote(seg, src.body) !== null, `quote không truy gốc: "${seg}" trong "${src.body}"`);
      }
      assert.ok(q.url && q.reviewDate && q.asin);
    }
    assert.ok(["must", "should", "skip"].includes(item.priority));
  }

  // spec sheet: must/should có gợi ý, gắn nhãn llm_suggested
  assert.ok(analysis.specs.length >= 3);
  for (const sp of analysis.specs) {
    assert.equal(sp.source, "llm_suggested");
    assert.ok(sp.requirement || sp.acceptanceStandard || sp.testMethod);
  }

  // trụ differentiation có điểm vì đã đủ mẫu
  assert.equal(result.differentiation.score !== null, true);
  assert.ok(["medium", "high"].includes(result.differentiation.confidence ?? ""));

  // nhật ký LLM: ≥1 map + 1 reduce, cost mock = 0 nhưng token > 0
  const mapRuns = result.llmRuns.filter((r) => r.sectionKey === "pain_map");
  const reduceRuns = result.llmRuns.filter((r) => r.sectionKey === "pain_reduce");
  assert.ok(mapRuns.length >= 2, `số lô map ${mapRuns.length}`);
  assert.equal(reduceRuns.length, 1);
  for (const r of result.llmRuns) {
    assert.equal(r.status, "ok");
    assert.ok(r.promptHash.length === 64);
    assert.ok(r.tokensIn > 0 && r.tokensOut > 0);
    assert.equal(r.costUsd, 0);
  }
  assert.equal(records.length, result.llmRuns.length);
  assert.equal(result.totalCostUsd, 0);
});

test("pipeline: model lạ chưa khai báo giá → ném lỗi và ghi run failed", async () => {
  const reviews = buildReviews().slice(0, 25);
  const provider = new MockLlmProvider();
  // Ép model lạ qua override prototype property
  Object.defineProperty(provider, "model", { value: "gpt-xyz-future", configurable: true });
  const runs: { status: string }[] = [];
  await assert.rejects(
    () =>
      runPainPipeline({
        assessmentId: "a",
        reviews,
        provider,
        chunkSize: 25,
        recordRun: (r) => { runs.push(r); },
      }),
    /khai báo giá token/,
  );
  assert.equal(runs[0]?.status, "failed");
});

test("pipeline: các lô map chạy song song không vượt concurrency (mặc định 4)", async () => {
  const reviews = buildReviews().slice(0, 75); // 3 lô theo chunkSize 25
  let active = 0;
  let maxActive = 0;
  const provider = new MockLlmProvider();
  const origMap = provider.mapPainChunk.bind(provider);
  provider.mapPainChunk = async (input) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    const out = await origMap(input);
    active--;
    return out;
  };
  await runPainPipeline({ assessmentId: "a", reviews, provider, chunkSize: 25, concurrency: 2, log: () => {} });
  assert.equal(maxActive, 2, "tối đa 2 lô đồng thời");

  // mặc định 4: 3 lô có thể chạy cùng lúc
  let maxDefault = 0;
  let active2 = 0;
  const p2 = new MockLlmProvider();
  const orig2 = p2.mapPainChunk.bind(p2);
  p2.mapPainChunk = async (input) => {
    active2++;
    maxDefault = Math.max(maxDefault, active2);
    await new Promise((r) => setTimeout(r, 5));
    const out = await orig2(input);
    active2--;
    return out;
  };
  await runPainPipeline({ assessmentId: "a", reviews, provider: p2, chunkSize: 25, log: () => {} });
  assert.equal(maxDefault, 3);
});

test("pipeline: không có review → reduce trên mẫu rỗng trả analysis rỗng, trụ null", async () => {
  const result = await runPainPipeline({
    assessmentId: "a",
    reviews: [],
    provider: new MockLlmProvider(),
    log: () => {},
  });
  assert.equal(result.analysis.sampleSize, 0);
  assert.equal(result.analysis.items.length, 0);
  assert.equal(result.differentiation.score, null);
});

