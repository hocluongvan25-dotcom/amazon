/**
 * Module 8 G2 — runner thu thập dữ liệu ngách (CLI + Vercel Cron dùng chung).
 *
 *   /api/cron/research-collect  →  drainResearchQueue() qua các run queued
 *   CLI: npm run worker:research-collect -- --kinds=serp,products,reviews
 *
 * AN TOÀN DỮ LIỆU:
 *   • Không có Supabase → KHÔNG ghi (chế độ demo chỉ chạy thử provider, mọi
 *     tương tác DB đổ vào cổng no-op có đếm).
 *   • Không có RAINFOREST_API_KEY → provider mock (kết quả gắn data_source='mock');
 *     runner báo rõ mode để không ai tưởng là dữ liệu thật.
 *   • Tất cả ghi DB thật đi qua RPC service_role migration 0026.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getIntelligenceProvider } from "../intelligence/index.ts";
import { getLlmProvider } from "../ai/index.ts";
import type {
  AnalysisReview,
  CompetitorRow,
  CriticalReviewRow,
  VetoFlag,
} from "../research/domain/index.ts";
import type { LlmRunRecord } from "../ai/types.ts";
import {
  drainResearchQueue,
  type ClaimedRun,
  type CollectOutcome,
  type PainAnalysisPayload,
  type ResearchWorkerPort,
} from "./jobs/research-collect.job.ts";

const snakeReview = (r: Record<string, unknown>): AnalysisReview => ({
  asin: String(r.asin),
  sourceReviewId: String(r.source_review_id),
  dbId: (r.id as string | undefined) ?? null,
  stars: Number(r.stars ?? 0),
  title: (r.title as string | null) ?? null,
  body: String(r.body ?? ""),
  reviewDate: (r.review_date as string | null) ?? null,
  helpfulCount: Number(r.helpful_count ?? 0),
  verified: !!r.verified,
  photosCount: Number(r.photos_count ?? 0),
  url: (r.url as string | null) ?? null,
  dataSource: (r.data_source as AnalysisReview["dataSource"]) ?? "rainforest",
});

/* ----------------------------- cổng Supabase ------------------------------ */

export class SupabaseResearchPort implements ResearchWorkerPort {
  private readonly sb: SupabaseClient;

  constructor(sb: SupabaseClient) {
    this.sb = sb;
  }

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.sb.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as T;
  }

  async claimRun(kind: string): Promise<ClaimedRun | null> {
    const data = await this.rpc<{ ok: boolean; run: ClaimedRun | null }>(
      "vexim_research_worker_claim_run",
      { p_kind: kind },
    );
    return data?.run ?? null;
  }

  async upsertCompetitors(runId: string, rows: CompetitorRow[]) {
    return this.rpc<{ rows: number }>("vexim_research_worker_upsert_competitors", {
      p_run_id: runId,
      p_rows: rows,
    });
  }

  async upsertReviews(runId: string, rows: CriticalReviewRow[]) {
    return this.rpc<{ inserted: number; duplicatesSkipped: number }>(
      "vexim_research_worker_upsert_reviews",
      { p_run_id: runId, p_rows: rows },
    );
  }

  async attachExternalId(runId: string, externalId: string): Promise<void> {
    const { error } = await this.sb
      .schema("research")
      .from("collection_runs")
      .update({ external_id: externalId })
      .eq("id", runId);
    if (error) throw new Error(`attachExternalId: ${error.message}`);
  }

  async finishRun(input: {
    runId: string;
    status: "done" | "no_data" | "failed";
    creditsUsed?: number;
    externalId?: string | null;
    error?: string | null;
  }): Promise<void> {
    await this.rpc("vexim_research_worker_finish_run", {
      p_run_id: input.runId,
      p_status: input.status,
      p_credits_used: input.creditsUsed ?? 0,
      p_external_id: input.externalId ?? null,
      p_error: input.error ?? null,
      p_raw: null,
    });
  }

  private async latestRunId(assessmentId: string, kind: string): Promise<string | null> {
    const { data: runs, error } = await this.sb
      .from("vexim_research_runs")
      .select("run_id")
      .eq("assessment_id", assessmentId)
      .eq("kind", kind)
      .eq("status", "done")
      .order("finished_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(`latestRunId(${kind}): ${error.message}`);
    return (runs?.[0] as { run_id?: string } | undefined)?.run_id ?? null;
  }

  private async competitorsOfRun(runId: string | null): Promise<CompetitorRow[]> {
    if (!runId) return [];
    const { data, error } = await this.sb
      .from("vexim_research_competitors")
      .select("*")
      .eq("run_id", runId)
      .order("position", { ascending: true });
    if (error) throw new Error(`competitorsOfRun: ${error.message}`);
    return (data ?? []).map((c) => {
      const r = c as Record<string, unknown>;
      return {
        position: Number(r.position ?? 0),
        isSponsored: !!r.is_sponsored,
        asin: String(r.asin),
        parentAsin: (r.parent_asin as string) ?? null,
        brand: (r.brand as string) ?? null,
        price: (r.price as number) ?? null,
        currency: String(r.currency ?? "USD"),
        rating: (r.rating as number) ?? null,
        ratingsTotal: (r.ratings_total as number) ?? null,
        estUnitsMonth: (r.est_units_month as number) ?? null,
        estRevenueMonth: (r.est_revenue_month as number) ?? null,
        isAmazon1p: !!r.is_amazon_1p,
        dataSource: (r.data_source as "rainforest" | "mock") ?? "rainforest",
      } as CompetitorRow;
    });
  }

  async latestSerpAsins(assessmentId: string, limit: number): Promise<string[]> {
    const runId = await this.latestRunId(assessmentId, "serp");
    const rows = await this.competitorsOfRun(runId);
    return rows.filter((r) => !r.isSponsored).map((r) => r.asin).slice(0, limit);
  }

  async latestScoringRows(assessmentId: string): Promise<{
    serp: CompetitorRow[];
    products: CompetitorRow[];
  }> {
    const [serpRun, productsRun] = await Promise.all([
      this.latestRunId(assessmentId, "serp"),
      this.latestRunId(assessmentId, "products"),
    ]);
    const [serp, products] = await Promise.all([
      this.competitorsOfRun(serpRun),
      this.competitorsOfRun(productsRun),
    ]);
    return { serp, products };
  }

  async setPillar(input: {
    assessmentId: string;
    pillar: "finance" | "competition" | "demand" | "differentiation" | "logistics";
    score: number | null;
    confidence: "high" | "medium" | "low" | null;
    reason: string;
    metrics?: Record<string, unknown>;
  }): Promise<void> {
    await this.rpc("vexim_research_worker_set_pillar", {
      p_assessment: input.assessmentId,
      p_pillar: input.pillar,
      p_score: input.score,
      p_confidence: input.confidence,
      p_reason: input.reason,
      p_metrics: input.metrics ?? {},
    });
  }

  async replaceCompetitionVetoes(assessmentId: string, vetoes: VetoFlag[]): Promise<void> {
    await this.rpc("vexim_research_worker_clear_vetoes", {
      p_assessment: assessmentId,
      p_rule_codes: ["cr3_above_65", "amazon1p_top3"],
    });
    for (const v of vetoes) {
      await this.rpc("vexim_research_worker_add_veto", {
        p_assessment: assessmentId,
        p_rule_code: v.code,
        p_severity: v.severity,
        p_title: v.title,
        p_detail: v.detail,
        p_evidence: v.evidence ?? {},
      });
    }
  }

  /* ------------------------------- G4: LLM pain ------------------------- */

  async loadReviewsForAnalysis(assessmentId: string): Promise<AnalysisReview[]> {
    const { data, error } = await this.sb
      .from("vexim_research_reviews")
      .select("*")
      .eq("assessment_id", assessmentId)
      .order("review_date", { ascending: false, nullsFirst: false });
    if (error) throw new Error(`loadReviewsForAnalysis: ${error.message}`);
    return (data ?? []).map((r) => snakeReview(r as Record<string, unknown>));
  }

  async recordLlmRun(rec: LlmRunRecord): Promise<string> {
    const out = await this.rpc<{ ok: boolean; id: string }>(
      "vexim_research_worker_record_llm_run",
      { p_run: rec },
    );
    return out.id;
  }

  async savePainAnalysis(
    assessmentId: string,
    payload: PainAnalysisPayload,
    reduceRunId: string | null,
  ): Promise<Record<string, number>> {
    const out = await this.rpc<Record<string, number>>(
      "vexim_research_worker_save_pain_analysis",
      { p_assessment: assessmentId, p_payload: payload, p_reduce_run_id: reduceRunId },
    );
    return out;
  }

  async demandVelocitySnapshots(
    assessmentId: string,
  ): Promise<{ prev: import("../research/domain/index.ts").VelocitySnapshot[]; current: import("../research/domain/index.ts").VelocitySnapshot[] }> {
    const { data: runs, error } = await this.sb
      .from("vexim_research_runs")
      .select("run_id,kind,finished_at")
      .eq("assessment_id", assessmentId)
      .eq("kind", "products")
      .eq("status", "done")
      .order("finished_at", { ascending: false })
      .limit(2);
    if (error) throw new Error(`demandVelocitySnapshots: ${error.message}`);
    if (!runs || runs.length < 2) return { prev: [], current: [] };
    const byRun = await Promise.all(
      runs.map((r) => this.competitorsOfRun(String((r as { run_id: string }).run_id))),
    );
    // runs xếp mới → cũ; current = mới, prev = cũ.
    const toSnap = (rows: CompetitorRow[], date: string) =>
      rows
        .filter((r) => !r.isSponsored && typeof r.ratingsTotal === "number")
        .map((r) => ({ asin: r.asin, date, ratingsTotal: r.ratingsTotal as number }));
    const dateOf = (i: number) => {
      const v = runs[i] as { finished_at?: string | null };
      return (v.finished_at ?? new Date().toISOString()).slice(0, 10);
    };
    return { current: toSnap(byRun[0], dateOf(0)), prev: toSnap(byRun[1], dateOf(1)) };
  }
}

/* ------------------------------- cổng no-op ------------------------------- */

/** Chế độ chưa có Supabase: chạy provider để demo, gom lại những gì LẼ RA được ghi. */
export class NoopResearchPort implements ResearchWorkerPort {
  claimed: ClaimedRun[] = [];
  competitorWrites = 0;
  reviewWrites = 0;
  savedPain: { assessmentId: string; payload: PainAnalysisPayload; reduceRunId: string | null }[] = [];
  llmRuns: LlmRunRecord[] = [];
  pillars: { assessmentId: string; pillar: string; score: number | null; reason: string }[] = [];
  private queue: ClaimedRun[];
  private competitors: CompetitorRow[] = [];
  private reviews: CriticalReviewRow[] = [];
  constructor(queued: ClaimedRun[] = []) {
    this.queue = [...queued];
  }
  async claimRun(kind: string): Promise<ClaimedRun | null> {
    const i = this.queue.findIndex((r) => r.kind === kind);
    if (i === -1) return null;
    const [run] = this.queue.splice(i, 1);
    this.claimed.push(run);
    return run;
  }
  async upsertCompetitors(_runId: string, rows: CompetitorRow[]) {
    this.competitorWrites += rows.length;
    this.competitors.push(...rows);
    return { rows: rows.length };
  }
  async upsertReviews(_runId: string, rows: CriticalReviewRow[]) {
    this.reviewWrites += rows.length;
    this.reviews.push(...rows);
    return { inserted: rows.length, duplicatesSkipped: 0 };
  }
  async attachExternalId(): Promise<void> {}
  async finishRun(): Promise<void> {}
  async latestSerpAsins(_assessmentId: string, limit: number): Promise<string[]> {
    return [...new Set(this.competitors.filter((r) => !r.isSponsored).map((r) => r.asin))].slice(0, limit);
  }
  async latestScoringRows(): Promise<{ serp: CompetitorRow[]; products: CompetitorRow[] }> {
    // Demo không tách run: dùng chung snapshot đã upsert cho cả serp/products.
    return { serp: this.competitors, products: this.competitors };
  }
  async setPillar(input: {
    assessmentId: string;
    pillar: string;
    score: number | null;
    confidence: unknown;
    reason: string;
  }): Promise<void> {
    this.pillars.push({
      assessmentId: input.assessmentId,
      pillar: input.pillar,
      score: input.score,
      reason: input.reason,
    });
  }
  async replaceCompetitionVetoes(): Promise<void> {}

  /* G4 demo in-memory */
  async loadReviewsForAnalysis(_assessmentId: string): Promise<AnalysisReview[]> {
    return this.reviews.map((r) => ({ ...r, dbId: null }));
  }
  async recordLlmRun(rec: LlmRunRecord): Promise<string> {
    this.llmRuns.push(rec);
    return `noop-llm-run-${this.llmRuns.length}`;
  }
  async savePainAnalysis(
    assessmentId: string,
    payload: PainAnalysisPayload,
    reduceRunId: string | null,
  ): Promise<Record<string, number>> {
    this.savedPain.push({ assessmentId, payload, reduceRunId });
    return {
      clusters: payload.clusters.length,
      items: payload.items.length,
      quotes: payload.items.reduce((s, i) => s + i.quotes.length, 0),
      specs: payload.specs.length,
    };
  }
  async demandVelocitySnapshots(): Promise<{ prev: never[]; current: never[] }> {
    return { prev: [], current: [] };
  }
}

export type ResearchCollectResult = {
  mode: "production" | "demo";
  providerName: "rainforest" | "mock";
  llmProviderName: string;
  llmConfigured: boolean;
  db: "supabase" | "noop";
  outcomes: CollectOutcome[];
  message: string;
};

export async function runResearchCollect(opts: {
  kinds?: string[];
  max?: number;
  /** tiêm port cho test (mặc định tự dựng theo env) */
  port?: ResearchWorkerPort;
  /** tiêm run giả cho chế độ demo không DB */
  queued?: ClaimedRun[];
  log?: (s: string) => void;
}): Promise<ResearchCollectResult> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const env = process.env;
  const { provider, configured } = getIntelligenceProvider(env);
  const llmContext = getLlmProvider(env);
  if (opts.kinds?.includes("analyze")) {
    log(
      llmContext.configured
        ? `[research] LLM provider=${llmContext.provider.name} model=${llmContext.provider.model}`
        : "[research] LLM CHƯA cấu hình LLM_API_KEY → chạy MOCK (mọi pain gắn provider='mock').",
    );
  }

  const sbUrl = env.NEXT_PUBLIC_SUPABASE_URL ?? env.SUPABASE_URL;
  const sbKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const useRealDb = !!sbUrl && !!sbKey;

  let port: ResearchWorkerPort;
  let db: "supabase" | "noop";
  if (opts.port) {
    port = opts.port;
    db = useRealDb ? "supabase" : "noop";
  } else if (useRealDb && sbUrl && sbKey) {
    port = new SupabaseResearchPort(createClient(sbUrl, sbKey, { auth: { persistSession: false } }));
    db = "supabase";
  } else {
    port = new NoopResearchPort(opts.queued ?? []);
    db = "noop";
    log("[research] THIẾU Supabase URL/service key → chạy DEMO, không ghi DB.");
  }
  if (!configured) {
    log("[research] THIẾU RAINFOREST_API_KEY → dùng provider MOCK (mọi bản ghi gắn data_source='mock').");
  }

  const outcomes = await drainResearchQueue(provider, port, {
    kinds: opts.kinds,
    max: opts.max ?? 20,
    log,
    llm: llmContext.provider,
  });

  return {
    mode: useRealDb && configured ? "production" : "demo",
    providerName: provider.name,
    llmProviderName: llmContext.provider.name,
    llmConfigured: llmContext.configured,
    db,
    outcomes,
    message: `Đã xử lý ${outcomes.length} lượt thu thập/phân tích (${provider.name}+${llmContext.provider.name}/${db}).`,
  };
}
