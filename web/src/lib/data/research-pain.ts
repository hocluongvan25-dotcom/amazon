/**
 * Module 8 G4 — đọc kết quả phân tích pain cho UI (Tab 3).
 * Supabase: 5 view public.vexim_research_{pain_clusters,pain_items,
 * pain_quotes,improvement_specs,llm_runs} (RLS theo org). Demo: chạy
 * MockLlmProvider trên review mock — gắn rõ provider='mock'.
 */

import { MockLlmProvider } from "@/lib/ai";
import { runPainPipeline } from "@/lib/ai/pain-pipeline";
import { MockIntelligenceProvider } from "@/lib/intelligence";
import { parseReviewsPage, type AnalysisReview } from "@/lib/research/domain";
import type {
  ImprovementSpec,
  PainClusterCode,
  PainClusterSummary,
  PainItem,
  PainPriority,
  PainQuote,
} from "@/lib/research/domain";
import { createClient } from "@/lib/supabase/server";

export type LlmRunView = {
  sectionKey: string;
  chunkIndex: number | null;
  provider: string;
  model: string;
  promptHash: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  status: "ok" | "failed";
  error: string | null;
  createdAt: string;
};

export type PainData = {
  mode: "demo" | "supabase";
  clusters: PainClusterSummary[];
  items: PainItem[];
  specs: ImprovementSpec[];
  llmRuns: LlmRunView[];
  totals: {
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    failed: number;
  };
};

const CLUSTER_LABEL: Record<PainClusterCode, string> = {
  quality: "Chất lượng sản phẩm",
  expectation_gap: "Lệch kỳ vọng so với mô tả",
  logistics: "Đóng gói & vận hành",
};

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));

/* ------------------------------ DEMO ------------------------------------- */

let demoCache: Promise<PainData> | null = null;

async function buildDemoPain(): Promise<PainData> {
  const intel = new MockIntelligenceProvider();
  const reviews: AnalysisReview[] = [];
  const seen = new Set<string>();
  // 10 ASIN mock đầu có review (xem mock-intelligence.ts), 2 trang/ASIN.
  const asins = Array.from({ length: 10 }, (_, i) => `B0MOCK${String(i + 1).padStart(3, "0")}`);
  for (const asin of asins) {
    for (let page = 1; page <= 2; page++) {
      const json = await intel.reviews({ asin, amazonDomain: "amazon.com", page, reviewStars: "all_critical" });
      for (const r of parseReviewsPage(json, asin, "mock").reviews) {
        if (!seen.has(r.sourceReviewId)) {
          seen.add(r.sourceReviewId);
          reviews.push({ ...r, dbId: null });
        }
      }
    }
  }
  const result = await runPainPipeline({
    assessmentId: "demo",
    reviews,
    provider: new MockLlmProvider(),
    log: () => {},
  });
  const a = result.analysis;
  return {
    mode: "demo",
    clusters: a.clusters,
    items: a.items,
    specs: a.specs,
    llmRuns: result.llmRuns.map((r) => ({
      sectionKey: r.sectionKey,
      chunkIndex: r.chunkIndex,
      provider: r.provider,
      model: r.model,
      promptHash: r.promptHash,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      costUsd: r.costUsd,
      status: r.status,
      error: r.error,
      createdAt: r.createdAt,
    })),
    totals: {
      tokensIn: result.totalTokensIn,
      tokensOut: result.totalTokensOut,
      costUsd: result.totalCostUsd,
      failed: 0,
    },
  };
}

/* --------------------------- SUPABASE VIEW ------------------------------- */

type RawRow = Record<string, unknown>;

function mapCluster(r: RawRow): PainClusterSummary {
  const code = String(r.cluster_code) as PainClusterCode;
  return {
    code,
    label: CLUSTER_LABEL[code] ?? code,
    sharePct: num(r.share_pct) ?? 0,
    reviewCount: num(r.review_count) ?? 0,
    itemCount: num(r.item_count) ?? 0,
    avgStars: num(r.severity_avg_stars),
    narrative: str(r.narrative),
  };
}

function mapItem(r: RawRow): Omit<PainItem, "quotes"> {
  return {
    itemKey: String(r.item_key),
    cluster: String(r.cluster_code) as PainClusterCode,
    title: String(r.title),
    subLabel: str(r.sub_label),
    reviewIds: [], // view không trả danh sách reviewId (truy qua quotes)
    effortHint: (num(r.effort_hint) as number | null) ?? null,
    factoryRequirement: str(r.factory_requirement),
    listingFix: str(r.listing_fix),
    testMethod: null,
    acceptanceStandard: null,
    costImpactEstimate: null,
    frequency: num(r.frequency) ?? 0,
    frequencyPct: num(r.frequency_pct) ?? 0,
    avgStars: num(r.avg_stars),
    severity: num(r.severity) ?? 0,
    impactScore: num(r.impact_score) ?? 0,
    effortScore: num(r.effort_score) ?? 0,
    priority: String(r.priority ?? "should") as PainPriority,
  };
}

function mapQuote(r: RawRow): PainQuote & { itemKey: string } {
  return {
    itemKey: String(r.item_key),
    reviewId: String(r.source_review_id),
    dbId: str(r.review_id),
    quote: String(r.quote),
    asin: String(r.asin),
    stars: num(r.stars),
    reviewDate: str(r.review_date),
    url: str(r.url),
    verified: !!r.verified,
    helpfulCount: num(r.helpful_count) ?? 0,
    photosCount: num(r.photos_count) ?? 0,
  };
}

function mapSpec(r: RawRow): ImprovementSpec {
  return {
    itemKey: String(r.item_key),
    cluster: String(r.cluster_code) as PainClusterCode,
    painTitle: String(r.pain_title),
    requirement: str(r.requirement),
    testMethod: str(r.test_method),
    acceptanceStandard: str(r.acceptance_standard),
    costImpactEstimate: str(r.cost_impact_estimate),
    owner: null,
    source: String(r.source ?? "llm_suggested") as ImprovementSpec["source"],
  };
}

export async function readPainData(assessmentId: string): Promise<PainData | null> {
  if (assessmentId.startsWith("demo-")) {
    if (!demoCache) demoCache = buildDemoPain();
    return demoCache;
  }
  const db = await createClient();
  if (!db) return null;

  const [clustersRes, itemsRes, quotesRes, specsRes, llmRes] = await Promise.all([
    db.from("vexim_research_pain_clusters").select("*").eq("assessment_id", assessmentId),
    db.from("vexim_research_pain_items").select("*").eq("assessment_id", assessmentId),
    db.from("vexim_research_pain_quotes").select("*").eq("assessment_id", assessmentId),
    db.from("vexim_research_improvement_specs").select("*").eq("assessment_id", assessmentId),
    db
      .from("vexim_research_llm_runs")
      .select("*")
      .eq("assessment_id", assessmentId)
      .order("created_at", { ascending: true }),
  ]);
  if (clustersRes.error) throw new Error(`Không đọc được pain clusters — ${clustersRes.error.message}`);
  if (itemsRes.error) throw new Error(`Không đọc được pain items — ${itemsRes.error.message}`);
  if (quotesRes.error) throw new Error(`Không đọc được pain quotes — ${quotesRes.error.message}`);
  if (specsRes.error) throw new Error(`Không đọc được spec sheet — ${specsRes.error.message}`);
  if (llmRes.error) throw new Error(`Không đọc được nhật ký LLM — ${llmRes.error.message}`);

  const quoteByItem = new Map<string, PainQuote[]>();
  for (const q of (quotesRes.data ?? []) as RawRow[]) {
    const mapped = mapQuote(q);
    const { itemKey, ...quote } = mapped;
    const list = quoteByItem.get(itemKey) ?? [];
    list.push(quote);
    quoteByItem.set(itemKey, list);
  }

  const items: PainItem[] = ((itemsRes.data ?? []) as RawRow[]).map((r) => ({
    ...mapItem(r),
    quotes: quoteByItem.get(String(r.item_key)) ?? [],
  }));

  const llmRuns: LlmRunView[] = ((llmRes.data ?? []) as RawRow[]).map((r) => ({
    sectionKey: String(r.section_key),
    chunkIndex: num(r.chunk_index) as number | null,
    provider: String(r.provider),
    model: String(r.model),
    promptHash: str(r.prompt_hash),
    tokensIn: num(r.tokens_in) ?? 0,
    tokensOut: num(r.tokens_out) ?? 0,
    costUsd: num(r.cost_usd) ?? 0,
    status: String(r.status ?? "ok") as "ok" | "failed",
    error: str(r.error),
    createdAt: String(r.created_at),
  }));

  return {
    mode: "supabase",
    clusters: ((clustersRes.data ?? []) as RawRow[]).map(mapCluster),
    items,
    specs: ((specsRes.data ?? []) as RawRow[]).map(mapSpec),
    llmRuns,
    totals: {
      tokensIn: llmRuns.filter((r) => r.status === "ok").reduce((s, r) => s + r.tokensIn, 0),
      tokensOut: llmRuns.filter((r) => r.status === "ok").reduce((s, r) => s + r.tokensOut, 0),
      costUsd: llmRuns.filter((r) => r.status === "ok").reduce((s, r) => s + r.costUsd, 0),
      failed: llmRuns.filter((r) => r.status === "failed").length,
    },
  };
}
