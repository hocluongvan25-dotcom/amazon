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
import type {
  CompetitorRow,
  CriticalReviewRow,
} from "../research/domain/index.ts";
import {
  drainResearchQueue,
  type ClaimedRun,
  type CollectOutcome,
  type ResearchWorkerPort,
} from "./jobs/research-collect.job.ts";

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

  async latestSerpAsins(assessmentId: string, limit: number): Promise<string[]> {
    const { data: runs, error: e1 } = await this.sb
      .from("vexim_research_runs")
      .select("run_id")
      .eq("assessment_id", assessmentId)
      .eq("kind", "serp")
      .eq("status", "done")
      .order("finished_at", { ascending: false })
      .limit(1);
    if (e1) throw new Error(`latestSerpAsins runs: ${e1.message}`);
    const runId = (runs?.[0] as { run_id?: string } | undefined)?.run_id;
    if (!runId) return [];
    const { data: rows, error: e2 } = await this.sb
      .from("vexim_research_competitors")
      .select("asin")
      .eq("run_id", runId)
      .eq("is_sponsored", false)
      .order("position", { ascending: true })
      .limit(limit);
    if (e2) throw new Error(`latestSerpAsins rows: ${e2.message}`);
    return (rows ?? []).map((r) => String((r as { asin: string }).asin));
  }
}

/* ------------------------------- cổng no-op ------------------------------- */

/** Chế độ chưa có Supabase: chạy provider để demo, gom lại những gì LẼ RA được ghi. */
export class NoopResearchPort implements ResearchWorkerPort {
  claimed: ClaimedRun[] = [];
  competitorWrites = 0;
  reviewWrites = 0;
  private queue: ClaimedRun[];
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
    return { rows: rows.length };
  }
  async upsertReviews(_runId: string, rows: CriticalReviewRow[]) {
    this.reviewWrites += rows.length;
    return { inserted: rows.length, duplicatesSkipped: 0 };
  }
  async attachExternalId(): Promise<void> {}
  async finishRun(): Promise<void> {}
  async latestSerpAsins(_assessmentId: string, _limit: number): Promise<string[]> {
    return [];
  }
}

export type ResearchCollectResult = {
  mode: "production" | "demo";
  providerName: "rainforest" | "mock";
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
  });

  return {
    mode: useRealDb && configured ? "production" : "demo",
    providerName: provider.name,
    db,
    outcomes,
    message: `Đã xử lý ${outcomes.length} lượt thu thập (${provider.name}/${db}).`,
  };
}
