/**
 * Module 8 G4 — test bước 'analyze' của worker: drain hàng đợi → map/reduce
 * LLM mock → lưu pain qua cổng (giả lập RPC 0028) → set 2 trụ
 * differentiation/demand; và các ca thiếu dữ liệu/thiếu LLM.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MockLlmProvider } from "../src/lib/ai/index.ts";
import type { LlmRunRecord } from "../src/lib/ai/types.ts";
import {
  extractVerbatimQuote,
  scoreDemandFromSnapshots,
  type AnalysisReview,
  type CompetitorRow,
  type VelocitySnapshot,
} from "../src/lib/research/domain/index.ts";
import {
  analyzePain,
  drainResearchQueue,
  type ClaimedRun,
  type FinishStatus,
  type PainAnalysisPayload,
  type ResearchWorkerPort,
} from "../src/lib/worker/jobs/research-collect.job.ts";

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

function buildReviews(): AnalysisReview[] {
  const out: AnalysisReview[] = [];
  let n = 0;
  for (let a = 0; a < 8; a++) {
    for (let s = 0; s < SNIPPETS.length; s++) {
      const snip = SNIPPETS[s];
      const asin = `B0A${String(a + 1).padStart(2, "0")}TEST`;
      out.push({
        asin, sourceReviewId: `R${n}`, dbId: `db-${n}`,
        stars: snip.stars, title: snip.title, body: snip.body,
        reviewDate: `2026-0${(n % 8) + 1}-1${n % 9}`, helpfulCount: (s * 3) % 17,
        verified: s % 2 === 0, photosCount: s % 5 === 0 ? 1 : 0,
        url: `https://www.amazon.com/dp/${asin}#R${n}`, dataSource: "rainforest",
      });
      n++;
    }
  }
  return out;
}

const run = (id: string, kind: ClaimedRun["kind"] = "analyze"): ClaimedRun => ({
  id, assessmentId: "aaaaaaaa-0000-4000-8000-000000000001", orgId: "bbbbbbbb-0000-4000-8000-000000000002",
  kind, params: {}, title: "Ngách test", marketplace: "US", keywords: ["rack"],
  seedAsin: null, categoryNode: null,
});

class FakePort implements ResearchWorkerPort {
  reviews: AnalysisReview[];
  constructor(reviews: AnalysisReview[]) {
    this.reviews = reviews;
  }
  saved: { assessmentId: string; payload: PainAnalysisPayload; reduceRunId: string | null }[] = [];
  llmRuns: LlmRunRecord[] = [];
  pillars: { pillar: string; score: number | null; reason: string }[] = [];
  finished: { runId: string; status: FinishStatus; error?: string | null }[] = [];
  claimed: ClaimedRun[] = [];
  async claimRun(kind: string) {
    const i = this.claimed.findIndex((r) => r.kind === kind);
    if (i < 0) return null;
    return this.claimed.splice(i, 1)[0];
  }
  async loadReviewsForAnalysis(): Promise<AnalysisReview[]> {
    return this.reviews;
  }
  async recordLlmRun(rec: LlmRunRecord) {
    this.llmRuns.push(rec);
    return `db-run-${this.llmRuns.length}`;
  }
  async savePainAnalysis(assessmentId: string, payload: PainAnalysisPayload, reduceRunId: string | null) {
    this.saved.push({ assessmentId, payload, reduceRunId });
    return {
      clusters: payload.clusters.length,
      items: payload.items.length,
      quotes: payload.items.reduce((s, i) => s + i.quotes.length, 0),
      specs: payload.specs.length,
    };
  }
  async latestScoringRows(): Promise<{ serp: CompetitorRow[]; products: CompetitorRow[] }> {
    const mk = (i: number, units: number): CompetitorRow => ({
      position: i, isSponsored: false, asin: `B0A${String(i).padStart(2, "0")}TEST`,
      currency: "USD", isAmazon1p: false, ratingsTotal: 1000 + i * 137,
      estUnitsMonth: units, dataSource: "rainforest",
    });
    const products = [mk(1, 4200), mk(2, 3100), mk(3, 2800), mk(4, 1900), mk(5, 1500), mk(6, 900)];
    return { serp: products, products };
  }
  async demandVelocitySnapshots(): Promise<{ prev: VelocitySnapshot[]; current: VelocitySnapshot[] }> {
    return { prev: [], current: [] };
  }
  async setPillar(p: { pillar: string; score: number | null; reason: string }) {
    this.pillars.push(p);
  }
  async finishRun(input: { runId: string; status: FinishStatus; error?: string | null }) {
    this.finished.push(input);
  }
  // các method G2/G3 không dùng trong test analyze
  async upsertCompetitors() {
    return { rows: 0 };
  }
  async upsertReviews() {
    return { inserted: 0, duplicatesSkipped: 0 };
  }
  async latestSerpAsins() {
    return [];
  }
  async replaceCompetitionVetoes() {}
}

test("analyzePain: map/reduce LLM → lưu pain + llm_runs, set 2 trụ, run done", async () => {
  const port = new FakePort(buildReviews());
  const outcome = await analyzePain(run("run-1"), new MockLlmProvider(), port);

  assert.equal(outcome.status, "done");
  assert.equal(port.finished[0]?.status, "done");
  assert.equal(port.saved.length, 1);

  const { payload, reduceRunId } = port.saved[0];
  assert.ok(reduceRunId, "phải truyền id llm_run của reduce");
  assert.equal(payload.provider, "mock");
  assert.equal(payload.model, "mock-llm-1");
  assert.equal(payload.sampleSize, 96);
  assert.ok(payload.items.length >= 4 && payload.items.length <= 5);
  assert.ok(payload.clusters.every((c) => ["quality", "expectation_gap", "logistics"].includes(c.code)));
  assert.ok(payload.specs.length >= 3);
  for (const sp of payload.specs) {
    // các trường nhãn llm_suggested do DB set; payload tối thiểu có nội dung spec
    assert.ok(sp.requirement || sp.testMethod || sp.acceptanceStandard);
  }

  // mọi quote trong payload truy được body gốc của đúng review
  const byId = new Map(port.reviews.map((r) => [r.sourceReviewId, r]));
  for (const item of payload.items) {
    assert.ok(item.quotes.length >= 1 && item.quotes.length <= 3);
    for (const q of item.quotes) {
      const src = byId.get(q.reviewId);
      assert.ok(src, `review ${q.reviewId} tồn tại`);
      for (const seg of q.quote.split(" … ")) {
        assert.ok(extractVerbatimQuote(seg, src!.body) !== null, `trích không truy gốc: ${seg}`);
      }
    }
  }

  // llm_runs: ≥1 map (chunk 25 → 4 lô trên 96 review) + 1 reduce, đều ok, cost 0
  const maps = port.llmRuns.filter((r) => r.sectionKey === "pain_map");
  const reduces = port.llmRuns.filter((r) => r.sectionKey === "pain_reduce");
  assert.equal(maps.length, 4);
  assert.equal(reduces.length, 1);
  assert.ok(port.llmRuns.every((r) => r.status === "ok" && r.promptHash.length === 64));
  assert.equal(outcome.analysis?.llmRuns, 5);
  assert.equal(outcome.analysis?.costUsd, 0);

  // 2 trụ: differentiation đủ mẫu → có điểm; demand từ 6 sales estimate
  const diff = port.pillars.find((p) => p.pillar === "differentiation");
  const demand = port.pillars.find((p) => p.pillar === "demand");
  assert.ok(diff && diff.score !== null, `differentiation: ${diff?.reason}`);
  assert.ok(demand && demand.score !== null, `demand: ${demand?.reason}`);
});

test("analyzePain: không có review → no_data, không gọi LLM", async () => {
  const port = new FakePort([]);
  const outcome = await analyzePain(run("run-2"), new MockLlmProvider(), port);
  assert.equal(outcome.status, "no_data");
  assert.equal(port.llmRuns.length, 0);
  assert.equal(port.saved.length, 0);
  assert.equal(port.finished[0]?.status, "no_data");
});

test("analyzePain: mẫu <30 review → trụ differentiation NULL (chưa đủ cơ sở), pain vẫn lưu", async () => {
  const port = new FakePort(buildReviews().slice(0, 12));
  const outcome = await analyzePain(run("run-3"), new MockLlmProvider(), port);
  assert.equal(outcome.status, "done");
  const diff = port.pillars.find((p) => p.pillar === "differentiation");
  assert.equal(diff?.score, null);
  assert.match(diff?.reason ?? "", /cần ≥30/);
});

test("drain: run analyze khi thiếu LLM provider → failed với lỗi rõ", async () => {
  const port = new FakePort(buildReviews());
  port.claimed.push(run("run-4"));
  const outcomes = await drainResearchQueue(
    // provider Rainforest không được dùng cho analyze; truyền giả vô hại
    {} as never,
    port,
    { kinds: ["analyze"], max: 1, log: () => {} },
  );
  assert.equal(outcomes[0]?.status, "failed");
  assert.match(outcomes[0]?.message ?? "", /LLM provider/);
  assert.equal(port.finished[0]?.status, "failed");
});

test("demand: velocity từ 2 mốc ratings được phối vào điểm (0.7 units + 0.3 velocity)", () => {
  const products: CompetitorRow[] = [
    { position: 1, isSponsored: false, asin: "A", currency: "USD", isAmazon1p: false, estUnitsMonth: 4000, ratingsTotal: 2000, dataSource: "rainforest" },
    { position: 2, isSponsored: false, asin: "B", currency: "USD", isAmazon1p: false, estUnitsMonth: 3000, ratingsTotal: 1500, dataSource: "rainforest" },
    { position: 3, isSponsored: false, asin: "C", currency: "USD", isAmazon1p: false, estUnitsMonth: 2000, ratingsTotal: 900, dataSource: "rainforest" },
    { position: 4, isSponsored: false, asin: "D", currency: "USD", isAmazon1p: false, estUnitsMonth: 1000, ratingsTotal: 400, dataSource: "rainforest" },
    { position: 5, isSponsored: false, asin: "E", currency: "USD", isAmazon1p: false, estUnitsMonth: 800, ratingsTotal: 300, dataSource: "rainforest" },
  ];
  const noVel = scoreDemandFromSnapshots(products, null);
  assert.ok(noVel.score !== null && noVel.confidence === "medium");

  // 30 ngày, mỗi ASIN thêm ~60 ratings → 2 review/ngày ≈ 60/tháng → velocityScore 6
  const mk = (date: string, delta: number): VelocitySnapshot[] =>
    products.map((p, i) => ({
      asin: p.asin,
      date,
      ratingsTotal: (p.ratingsTotal ?? 0) - (delta ? (i + 2) * delta : 0),
    }));
  const withVel = scoreDemandFromSnapshots(products, {
    prev: mk("2026-08-01", 1),
    current: mk("2026-08-31", 0),
  });
  assert.ok(withVel.score !== null);
  assert.match(withVel.reason, /velocity/);
});
