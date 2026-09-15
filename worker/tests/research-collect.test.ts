/**
 * Module 8 G2 — test các job thu thập (thuần, không mạng):
 * serp/products/reviews, idempotence queue, PII guard, collection bất đồng bộ.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MockIntelligenceProvider } from "../../web/src/lib/intelligence/mock-intelligence.ts";
import type {
  CompetitorRow,
  CriticalReviewRow,
} from "../../web/src/lib/research/domain/index.ts";
import type { IntelligenceProvider } from "../../web/src/lib/intelligence/types.ts";
import {
  collectProducts,
  collectReviews,
  collectSerp,
  drainResearchQueue,
  parseProductCollectionResults,
  type ClaimedRun,
  type FinishStatus,
  type ResearchWorkerPort,
} from "../../web/src/lib/worker/jobs/research-collect.job.ts";

function makeRun(over: Partial<ClaimedRun> = {}): ClaimedRun {
  return {
    id: "run-1",
    assessmentId: "assess-1",
    orgId: "org-1",
    kind: "serp",
    params: {},
    title: "Ngách test",
    marketplace: "US",
    keywords: ["kitchen shelf"],
    seedAsin: null,
    categoryNode: null,
    ...over,
  };
}

class FakePort implements ResearchWorkerPort {
  queued: ClaimedRun[] = [];
  competitors: CompetitorRow[] = [];
  reviews: CriticalReviewRow[] = [];
  finishes: { runId: string; status: FinishStatus; credits: number; error?: string | null }[] = [];
  external: Record<string, string> = {};
  serpAsins: string[] = [];
  serpRows: CompetitorRow[] = [];
  productRows: CompetitorRow[] = [];
  pillars: { pillar: string; score: number | null; reason: string }[] = [];
  vetoReplacements: { assessmentId: string; vetoes: unknown[] }[] = [];
  constructor(queued: ClaimedRun[] = []) {
    this.queued = [...queued];
  }
  async claimRun(kind: string) {
    const i = this.queued.findIndex((r) => r.kind === kind);
    return i === -1 ? null : this.queued.splice(i, 1)[0];
  }
  async upsertCompetitors(_runId: string, rows: CompetitorRow[]) {
    this.competitors.push(...rows);
    return { rows: rows.length };
  }
  async upsertReviews(_runId: string, rows: CriticalReviewRow[]) {
    const before = this.reviews.length;
    const seen = new Set(this.reviews.map((r) => `${r.asin}:${r.sourceReviewId}`));
    let dup = 0;
    for (const r of rows) {
      const k = `${r.asin}:${r.sourceReviewId}`;
      if (seen.has(k)) {
        dup++;
        continue;
      }
      seen.add(k);
      this.reviews.push(r);
    }
    return { inserted: this.reviews.length - before - dup, duplicatesSkipped: dup };
  }
  async attachExternalId(runId: string, externalId: string) {
    this.external[runId] = externalId;
  }
  async finishRun(input: {
    runId: string;
    status: FinishStatus;
    creditsUsed?: number;
    error?: string | null;
  }) {
    this.finishes.push({
      runId: input.runId,
      status: input.status,
      credits: input.creditsUsed ?? 0,
      error: input.error ?? null,
    });
  }
  async latestSerpAsins(_id: string, limit: number) {
    return this.serpAsins.slice(0, limit);
  }
  async latestScoringRows() {
    return { serp: this.serpRows, products: this.productRows };
  }
  async setPillar(input: {
    pillar: string;
    score: number | null;
    confidence: string | null;
    reason: string;
  }) {
    this.pillars.push({ pillar: input.pillar, score: input.score, reason: input.reason });
  }
  async replaceCompetitionVetoes(assessmentId: string, vetoes: unknown[]) {
    this.vetoReplacements.push({ assessmentId, vetoes });
  }
}

test("collectSerp: ghi 26 ASIN (có tách sponsored), finish done trừ 1 credit/trang", async () => {
  const provider = new MockIntelligenceProvider();
  const port = new FakePort();
  const run = makeRun();
  const out = await collectSerp(run, provider, port);
  assert.equal(out.status, "done");
  assert.equal(out.creditsUsed, 1);
  assert.equal(port.competitors.length, 26);
  assert.ok(port.competitors.some((c) => c.isSponsored));
  assert.ok(port.competitors.some((c) => !c.isSponsored));
  assert.equal(port.competitors[0].dataSource, "mock");
  assert.deepEqual(port.finishes[0], { runId: "run-1", status: "done", credits: 1, error: null });
});

test("collectSerp: 2 trang vẫn khống chế pages ≤ 2", async () => {
  const provider = new MockIntelligenceProvider();
  const port = new FakePort();
  const run = makeRun({ params: { pages: 9 } });
  const out = await collectSerp(run, provider, port);
  assert.equal(out.creditsUsed, 2);
});

test("collectSerp: provider trả SERP rỗng → no_data, không phải lỗi", async () => {
  const fake: IntelligenceProvider = {
    name: "rainforest",
    search: async () => ({ search_results: [] }),
    product: async () => ({}),
    offers: async () => ({}),
    salesEstimate: async () => ({}),
    reviews: async () => ({ reviews: [] }),
    createCollection: async () => {
      throw new Error("không dùng");
    },
    getCollection: async () => ({}),
  };
  const port = new FakePort();
  const out = await collectSerp(makeRun(), fake, port);
  assert.equal(out.status, "no_data");
  assert.equal(port.competitors.length, 0);
  assert.equal(port.finishes[0].status, "no_data");
});

test("collectProducts (mock/direct): bám ASIN từ SERP, mỗi ASIN 3 request, có sales estimate", async () => {
  const provider = new MockIntelligenceProvider();
  const port = new FakePort();
  port.serpAsins = ["B0MOCK001", "B0MOCK002", "B0MOCK003"];
  const run = makeRun({ kind: "products" });
  const out = await collectProducts(run, provider, port);
  assert.equal(out.status, "done");
  assert.equal(out.competitors, 3);
  assert.equal(out.creditsUsed, 9);
  for (const c of port.competitors) {
    assert.ok(c.estUnitsMonth !== null && c.estUnitsMonth !== undefined);
  }
  // B0MOCK015 không nằm trong danh sách; nhưng B0MOCK001..003 là KitchenPro (không 1P)
  assert.equal(port.finishes[0].status, "done");
});

test("collectProducts khi chưa có SERP → failed với hướng dẫn chạy serp trước", async () => {
  const provider = new MockIntelligenceProvider();
  const port = new FakePort();
  const run = makeRun({ kind: "products" });
  const out = await collectProducts(run, provider, port);
  assert.equal(out.status, "failed");
  assert.match(port.finishes[0].error ?? "", /collect-serp/);
});

test("collectProducts với provider thật: tạo Collection bất đồng bộ + gắn external id, chưa tính credit", async () => {
  const fake: IntelligenceProvider = {
    name: "rainforest",
    search: async () => ({ search_results: [] }),
    product: async () => ({}),
    offers: async () => ({}),
    salesEstimate: async () => ({}),
    reviews: async () => ({ reviews: [] }),
    createCollection: async (entries) => ({ collectionId: "COL-9", credits: entries.length }),
    getCollection: async () => ({}),
  };
  const port = new FakePort();
  port.serpAsins = ["B0MOCK001", "B0MOCK002"];
  const run = makeRun({ kind: "products" });
  const out = await collectProducts(run, fake, port);
  assert.equal(out.status, "collection_created");
  assert.equal(port.external["run-1"], "COL-9");
  assert.equal(out.creditsUsed, 0); // credit ghi lúc webhook hoàn tất
  assert.equal(port.finishes.length, 0);
});

test("parseProductCollectionResults: gom 3 request/ASIN thành 1 CompetitorRow", () => {
  const json = {
    results: [
      { request: { type: "product", asin: "b0a" }, success: true, output: { product: { asin: "B0A", brand: "X", bestseller_rank: { rank: 10, category: "C" } } } },
      { request: { type: "offers", asin: "b0a" }, success: true, output: { offers: [{ is_buybox_winner: true, sold_by: { name: "X Direct" } }] } },
      { request: { type: "sales_estimation", asin: "b0a" }, success: true, output: { sales_estimation: { est_monthly_units: 100 } } },
      { request: { type: "product", asin: "b0b" }, success: false, output: null },
    ],
  };
  const rows = parseProductCollectionResults(json);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].asin, "B0A");
  assert.equal(rows[0].bsrRank, 10);
  assert.equal(rows[0].estUnitsMonth, 100);
});

test("G3: applyCompetitionScoring ghi điểm trụ + veto CR3/1P từ snapshot ghép SERP+products", async () => {
  // SERP: 12 sản phẩm 2 brand tập trung cao, vị trí #1 Amazon 1P
  const serp: CompetitorRow[] = [];
  for (let i = 0; i < 12; i++) {
    serp.push({
      asin: `S${i}`,
      parentAsin: `P${i}`,
      brand: i < 8 ? "MonoBrand" : "OtherBrand",
      isSponsored: false,
      position: i + 1,
      isAmazon1p: false,
      currency: "USD",
      dataSource: "rainforest",
    });
  }
  serp[0].isAmazon1p = true;
  // Products run làm giàu sales estimate (tổng doanh thu lệch mạnh về MonoBrand)
  const products: CompetitorRow[] = serp.map((s, i) => ({
    ...s,
    position: 0,
    estRevenueMonth: i < 8 ? 50_000 : 5_000,
    estUnitsMonth: i < 8 ? 1500 : 150,
  }));
  const port = new FakePort();
  port.serpRows = serp;
  port.productRows = products;

  const { applyCompetitionScoring } = await import(
    "../../web/src/lib/worker/jobs/research-collect.job.ts"
  );
  const out = await applyCompetitionScoring("assess-1", port);
  assert.equal(out.scored, true);
  const pillar = port.pillars.find((p) => p.pillar === "competition");
  assert.ok(pillar && pillar.score !== null && pillar.score <= 3, `điểm phải ≤3, được ${pillar?.score}`);
  // 2 veto: CR3 > 65 và Amazon 1P top3
  const last = port.vetoReplacements.at(-1);
  assert.equal(last?.assessmentId, "assess-1");
  const codes = (last?.vetoes as { code: string }[]).map((v) => v.code).sort();
  assert.deepEqual(codes, ["amazon1p_top3", "cr3_above_65"]);
});

test("G3: applyCompetitionScoring khi chưa đủ sales → điểm null, không veto", async () => {
  const port = new FakePort();
  port.serpRows = [
    { asin: "A", isSponsored: false, position: 1, isAmazon1p: false, currency: "USD", dataSource: "rainforest" },
  ];
  const { applyCompetitionScoring } = await import(
    "../../web/src/lib/worker/jobs/research-collect.job.ts"
  );
  const out = await applyCompetitionScoring("a1", port);
  assert.equal(out.scored, false);
  assert.equal(port.pillars[0].score, null);
  assert.deepEqual(port.vetoReplacements[0].vetoes, []);
});

test("collectReviews: gom review nhiều ASIN, dừng khi đủ target/asin, mọi dòng sạch PII", async () => {
  const provider = new MockIntelligenceProvider();
  const port = new FakePort();
  port.serpAsins = ["B0MOCK001", "B0MOCK002"];
  const run = makeRun({ kind: "reviews", params: { targetPerAsin: 5 } });
  const out = await collectReviews(run, provider, port);
  assert.equal(out.status, "done");
  assert.ok(port.reviews.length >= 10);
  for (const r of port.reviews) {
    assert.ok(r.stars !== null && r.stars <= 3);
    assert.equal("reviewer_name" in r, false);
  }
  assert.ok(out.creditsUsed >= 2);
});

test("collectReviews: không ASIN → failed", async () => {
  const port = new FakePort();
  const out = await collectReviews(makeRun({ kind: "reviews" }), new MockIntelligenceProvider(), port);
  assert.equal(out.status, "failed");
});

test("collectReviews: provider CÓ trả tên reviewer trong JSON thô → parser loại sạch, không lọt xuống DB", async () => {
  const fake: IntelligenceProvider = {
    name: "rainforest",
    search: async () => ({ search_results: [] }),
    product: async () => ({}),
    offers: async () => ({}),
    salesEstimate: async () => ({}),
    reviews: async () => ({
      reviews: [
        { id: "X1", asin: "B0MOCK001", rating: 1, body: "bad", reviewer_name: "Leak Name", reviewer_avatar: "http://avatar" },
      ],
      pagination: { total_pages: 1 },
    }),
    createCollection: async () => {
      throw new Error("không dùng");
    },
    getCollection: async () => ({}),
  };
  const port = new FakePort();
  port.serpAsins = ["B0MOCK001"];
  const out = await collectReviews(makeRun({ kind: "reviews", params: { maxPagesPerAsin: 1 } }), fake, port);
  assert.equal(out.status, "done");
  assert.equal(port.reviews.length, 1);
  for (const r of port.reviews) {
    assert.equal("reviewer_name" in r, false);
    assert.equal(JSON.stringify(r).includes("Leak Name"), false);
    assert.equal(JSON.stringify(r).includes("avatar"), false);
  }
});

// Hàng rào PII cuối cùng nằm ở RPC vexim_research_worker_upsert_reviews
// (migration 0026) — đã được khoá ở harness PGlite BƯỚC 25 (payload dính
// reviewerName bị từ chối thẳng thắn).

test("drainResearchQueue: nhận lần lượt serp → products → reviews rồi dừng", async () => {
  const provider = new MockIntelligenceProvider();
  const runs = [
    makeRun({ id: "r-serp", kind: "serp" }),
    makeRun({ id: "r-prod", kind: "products", params: { asins: ["B0MOCK001"] } }),
    makeRun({ id: "r-rev", kind: "reviews", params: { asins: ["B0MOCK001"], targetPerAsin: 3, maxPagesPerAsin: 1 } }),
  ];
  const port = new FakePort(runs);
  const outcomes = await drainResearchQueue(provider, port, { kinds: ["serp", "products", "reviews"] });
  assert.equal(outcomes.length, 3);
  assert.deepEqual(outcomes.map((o) => o.kind), ["serp", "products", "reviews"]);
  assert.ok(outcomes.every((o) => o.status === "done"));
});

test("drainResearchQueue: provider lỗi được bắt và run ghi failed", async () => {
  const broken: IntelligenceProvider = {
    name: "rainforest",
    search: async () => {
      throw new Error("Rainforest HTTP 500");
    },
    product: async () => ({}),
    offers: async () => ({}),
    salesEstimate: async () => ({}),
    reviews: async () => ({ reviews: [] }),
    createCollection: async () => {
      throw new Error("x");
    },
    getCollection: async () => ({}),
  };
  const port = new FakePort([makeRun({ id: "r-x", kind: "serp" })]);
  const outcomes = await drainResearchQueue(broken, port, { kinds: ["serp"] });
  assert.equal(outcomes[0].status, "failed");
  assert.match(port.finishes[0].error ?? "", /500/);
});
