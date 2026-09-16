/**
 * Module 8 G7 — test guard ngân sách credits trong drain queue:
 *  - dự kiến chạm trần → run đánh failed, KHÔNG gọi provider
 *  - cảnh báo ngân sách nội bộ → vẫn chạy
 *  - port cũ không có creditStatus → không vỡ
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { MockIntelligenceProvider } from "../src/lib/intelligence/index.ts";
import {
  drainResearchQueue,
  type ClaimedRun,
  type FinishStatus,
  type ResearchWorkerPort,
} from "../src/lib/worker/jobs/research-collect.job.ts";
import type { CompetitorRow, CriticalReviewRow, AnalysisReview, VelocitySnapshot, VetoFlag } from "../src/lib/research/domain/index.ts";
import type { LlmRunRecord } from "../src/lib/ai/types.ts";
import type { PainAnalysisPayload } from "../src/lib/worker/jobs/research-collect.job.ts";

const run = (id: string, kind: ClaimedRun["kind"]): ClaimedRun => ({
  id,
  assessmentId: "aaaaaaaa-0000-4000-8000-000000000001",
  orgId: "bbbbbbbb-0000-4000-8000-000000000002",
  kind,
  params: {},
  title: "Ngách test",
  marketplace: "US",
  keywords: ["rack"],
  seedAsin: null,
  categoryNode: null,
});

class Port implements ResearchWorkerPort {
  claimed: ClaimedRun[] = [];
  finished: { runId: string; status: FinishStatus; error?: string | null }[] = [];
  spent = 0;
  bsrRefreshed = 0;
  constructor(claimed: ClaimedRun[]) {
    this.claimed = [...claimed];
  }
  async claimRun(kind: string) {
    const i = this.claimed.findIndex((r) => r.kind === kind);
    return i < 0 ? null : this.claimed.splice(i, 1)[0];
  }
  async upsertCompetitors(_r: string, rows: CompetitorRow[]) {
    return { rows: rows.length };
  }
  async upsertReviews(_r: string, rows: CriticalReviewRow[]) {
    return { inserted: rows.length, duplicatesSkipped: 0 };
  }
  async finishRun(input: { runId: string; status: FinishStatus; error?: string | null }) {
    this.finished.push(input);
  }
  async latestSerpAsins() {
    return [];
  }
  async latestScoringRows() {
    return { serp: [], products: [] };
  }
  async setPillar() {}
  async replaceCompetitionVetoes(_a: string, _v: VetoFlag[]) {}
  async loadReviewsForAnalysis(): Promise<AnalysisReview[]> {
    return [];
  }
  async recordLlmRun(rec: LlmRunRecord) {
    return `run-${rec.sectionKey}`;
  }
  async savePainAnalysis(_a: string, _p: PainAnalysisPayload): Promise<Record<string, number>> {
    return {};
  }
  async demandVelocitySnapshots(): Promise<{ prev: VelocitySnapshot[]; current: VelocitySnapshot[] }> {
    return { prev: [], current: [] };
  }
  async creditStatus() {
    return { creditsSpent: this.spent };
  }
  async refreshBsrHistory() {
    this.bsrRefreshed++;
    return 0;
  }
}

test("guard: dự kiến vượt trần 10.000 → chặn, run failed, không gọi Rainforest", async () => {
  // serp tốn 1 credit; đã tiêu 10.000 → block
  const port = new Port([run("r1", "serp")]);
  port.spent = 10_000;
  let searchCalled = false;
  const provider = new MockIntelligenceProvider();
  provider.search = (async () => {
    searchCalled = true;
    throw new Error("không được gọi provider khi đã chặn budget");
  }) as typeof provider.search;

  const out = await drainResearchQueue(provider, port, { max: 1, log: () => {} });
  assert.equal(out[0].status, "failed");
  assert.match(out[0].message, /\[budget\]/);
  assert.equal(searchCalled, false, "không được gọi provider khi đã chặn");
  assert.equal(port.finished[0]?.status, "failed");
  assert.match(port.finished[0]?.error ?? "", /trần/);
});

test("guard: vượt ngân sách nội bộ 2.000 nhưng dưới trần → vẫn chạy", async () => {
  const port = new Port([run("r2", "serp")]);
  port.spent = 1_999; // +1 = 2.000 → warn, không chặn
  const provider = new MockIntelligenceProvider();
  const out = await drainResearchQueue(provider, port, { max: 1, log: () => {} });
  assert.equal(out[0].status, "done");
  assert.equal(port.finished[0]?.status, "done");
});

test("guard: chưa tiêu gì → chạy bình thường", async () => {
  const port = new Port([run("r3", "serp")]);
  const provider = new MockIntelligenceProvider();
  const out = await drainResearchQueue(provider, port, { max: 1, log: () => {} });
  assert.equal(out[0].status, "done");
});

test("guard: port không cài creditStatus (tương thích ngược) → không vỡ", async () => {
  const port = new Port([run("r4", "serp")]);
  delete (port as Partial<Port>).creditStatus;
  const provider = new MockIntelligenceProvider();
  const out = await drainResearchQueue(provider, port, { max: 1, log: () => {} });
  assert.equal(out[0].status, "done");
});
