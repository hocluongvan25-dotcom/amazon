/**
 * Module 8 G2 — các bước thu thập dữ liệu ngách (Rainforest/mock).
 *
 * Job THUẦN: provider + cổng DB truyền vào nên test được không cần mạng/Supabase.
 * Mọi ghi DB đi qua ResearchWorkerPort (sản xuất: RPC service_role của
 * migration 0026 — xem run-research-collect.ts).
 *
 * Luồng credit: số request Rainforest tiêu thụ được báo về finishRun để ghi
 * sổ cái; báo cáo rỗng → 'no_data' (KHÔNG phải lỗi).
 */

import type {
  AnalysisReview,
  CompetitorRow,
  CriticalReviewRow,
  IntelligenceDataSource,
  PainAnalysis,
  VelocitySnapshot,
  VetoFlag,
} from "../../research/domain/index.ts";
import {
  decideCreditBudget,
  parseProductBundle,
  parseReviewsPage,
  parseSearchPage,
  scoreCompetitionFromSnapshots,
  scoreDemandFromSnapshots,
  summarizeCompetitors,
  type BsrPoint,
} from "../../research/domain/index.ts";
import type {
  CollectionEntry,
  IntelligenceProvider,
} from "../../intelligence/types.ts";
import { runPainPipeline } from "../../ai/pain-pipeline.ts";
import type { LlmProvider, LlmRunRecord } from "../../ai/types.ts";

export type ClaimedRun = {
  id: string;
  assessmentId: string;
  orgId: string;
  kind: "serp" | "products" | "offers" | "sales" | "reviews" | "fees" | "analyze";
  params: Record<string, unknown>;
  title: string;
  marketplace: string;
  keywords: string[];
  seedAsin: string | null;
  categoryNode: string | null;
};

export type FinishStatus = "done" | "no_data" | "failed";

export type ResearchWorkerPort = {
  claimRun(kind: string, assessmentId?: string | null): Promise<ClaimedRun | null>;
  upsertCompetitors(runId: string, rows: CompetitorRow[]): Promise<{ rows: number }>;
  upsertReviews(runId: string, rows: CriticalReviewRow[]): Promise<{
    inserted: number;
    duplicatesSkipped: number;
  }>;
  /** gắn external collection id khi chạy bất đồng bộ (run giữ nguyên 'running') */
  attachExternalId?(runId: string, externalId: string): Promise<void>;
  finishRun(input: {
    runId: string;
    status: FinishStatus;
    creditsUsed?: number;
    externalId?: string | null;
    error?: string | null;
  }): Promise<void>;
  /** ASIN organic của lần quét SERP gần nhất (cho products/reviews bám theo). */
  latestSerpAsins(assessmentId: string, limit: number): Promise<string[]>;
  /** Toàn bộ snapshot 2 loại run mới nhất để chấm tập trung thị phần (G3). */
  latestScoringRows(assessmentId: string): Promise<{
    serp: CompetitorRow[];
    products: CompetitorRow[];
  }>;
  setPillar(input: {
    assessmentId: string;
    pillar: "finance" | "competition" | "demand" | "differentiation" | "logistics";
    score: number | null;
    confidence: "high" | "medium" | "low" | null;
    reason: string;
    metrics?: Record<string, unknown>;
  }): Promise<void>;
  /** Thay thế tập veto cạnh tranh của engine (giữ veto tài chính/chứng nhận). */
  replaceCompetitionVetoes(assessmentId: string, vetoes: VetoFlag[]): Promise<void>;

  /* ------------------------------- G4: LLM pain ------------------------- */
  /** Toàn bộ review 1–3★ đã lưu để phân tích pain (đọc từ reviews_raw). */
  loadReviewsForAnalysis(assessmentId: string): Promise<AnalysisReview[]>;
  /** Ghi nhật ký 1 lượt gọi LLM, trả id dòng llm_runs. */
  recordLlmRun(rec: LlmRunRecord): Promise<string>;
  /** Thay thế toàn bộ kết quả pain 1 lượt phân tích (RPC worker 0028). */
  savePainAnalysis(
    assessmentId: string,
    payload: PainAnalysisPayload,
    reduceRunId: string | null,
  ): Promise<Record<string, number>>;
  /** 2 mốc ratings_total gần nhất để tính velocity review (có thể rỗng). */
  demandVelocitySnapshots(
    assessmentId: string,
  ): Promise<{ prev: VelocitySnapshot[]; current: VelocitySnapshot[] }>;

  /* ------------------------------- G7: budget + BSR --------------------- */
  /** credit đã tiêu của org trong tháng (RPC vexim_research_credit_status). */
  creditStatus?(orgId: string): Promise<{ creditsSpent: number }>;
  /** gộp BSR từ competitor_snapshots vào bsr_history (0 credit). */
  refreshBsrHistory?(assessmentId: string): Promise<number>;
  /** nạp điểm BSR backfill (Keepa) vào bsr_history. */
  upsertBsrPoints?(orgId: string, points: BsrPoint[], assessmentId: string | null): Promise<number>;
};

/** Payload JSON cho RPC vexim_research_worker_save_pain_analysis (0028). */
export type PainAnalysisPayload = {
  model: string;
  provider: string;
  schemaVersion: string;
  sampleSize: number;
  asinCount: number;
  observationsDropped: number;
  quotesDropped: number;
  generatedAt: string;
  executiveNarrative: string | null;
  clusters: PainAnalysis["clusters"];
  items: PainAnalysis["items"];
  specs: PainAnalysis["specs"];
};

export type CollectOutcome = {
  runId: string;
  kind: string;
  status: FinishStatus | "collection_created";
  creditsUsed: number;
  competitors?: number;
  reviews?: { inserted: number; duplicatesSkipped: number };
  analysis?: {
    provider: string;
    model: string;
    items: number;
    quotes: number;
    specs: number;
    quotesDropped: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    llmRuns: number;
  };
  message: string;
};

const MARKETPLACE_DOMAIN: Record<string, string> = {
  US: "amazon.com",
  UK: "amazon.co.uk",
  DE: "amazon.de",
  CA: "amazon.ca",
  JP: "amazon.co.jp",
  AU: "amazon.com.au",
};

function domainOf(marketplace: string | null | undefined): string {
  return MARKETPLACE_DOMAIN[(marketplace ?? "US").toUpperCase()] ?? "amazon.com";
}

function src(provider: IntelligenceProvider): IntelligenceDataSource {
  return provider.name === "mock" ? "mock" : "rainforest";
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}
function asNumber(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/* --------------------------------- SERP ----------------------------------- */

export async function collectSerp(
  run: ClaimedRun,
  provider: IntelligenceProvider,
  port: ResearchWorkerPort,
): Promise<CollectOutcome> {
  const keywords = asStringArray(run.params.keywords).length
    ? asStringArray(run.params.keywords)
    : run.keywords;
  const keyword = (run.params.keyword as string) || keywords[0] || run.title;
  const pages = Math.min(Math.max(asNumber(run.params.pages, 1), 1), 2);
  const domain = domainOf(run.marketplace);

  if (!keyword) {
    await port.finishRun({ runId: run.id, status: "failed", error: "thiếu từ khóa quét SERP" });
    return { runId: run.id, kind: run.kind, status: "failed", creditsUsed: 0, message: "thiếu từ khóa" };
  }

  const rows: CompetitorRow[] = [];
  for (let page = 1; page <= pages; page++) {
    const json = await provider.search({ keyword, amazonDomain: domain, page });
    const parsed = parseSearchPage(json, src(provider));
    // Đánh dấu trang để position không tái sử dụng; sponsored giữ cờ thật.
    parsed.organic.forEach((r) => rows.push({ ...r, position: r.position + (page - 1) * 50 }));
    parsed.sponsored.forEach((r) => rows.push({ ...r, position: r.position + (page - 1) * 50 }));
  }

  if (!rows.length) {
    await port.finishRun({ runId: run.id, status: "no_data", creditsUsed: pages });
    return { runId: run.id, kind: run.kind, status: "no_data", creditsUsed: pages, message: "SERP rỗng" };
  }

  const { rows: written } = await port.upsertCompetitors(run.id, rows);
  const summary = summarizeCompetitors(rows);
  await port.finishRun({ runId: run.id, status: "done", creditsUsed: pages });
  return {
    runId: run.id,
    kind: run.kind,
    status: "done",
    creditsUsed: pages,
    competitors: written,
    message: `${written} listing (${summary.sponsored} sponsored, ${rows.length - summary.sponsored} organic)`,
  };
}

/* --------------------------- PRODUCTS + SALES ----------------------------- */

export async function collectProducts(
  run: ClaimedRun,
  provider: IntelligenceProvider,
  port: ResearchWorkerPort,
): Promise<CollectOutcome> {
  const domain = domainOf(run.marketplace);
  const explicit = asStringArray(run.params.asins);
  const limit = Math.min(asNumber(run.params.topN, 30), 50);
  const asins = explicit.length
    ? explicit.slice(0, 50)
    : await port.latestSerpAsins(run.assessmentId, limit);

  if (!asins.length) {
    await port.finishRun({
      runId: run.id,
      status: "failed",
      error: "chưa có SERP — chạy collect-serp trước hoặc truyền params.asins",
    });
    return { runId: run.id, kind: run.kind, status: "failed", creditsUsed: 0, message: "thiếu ASIN" };
  }

  const direct = provider.name === "mock" || run.params.direct === true;
  if (!direct) {
    // Rainforest thật: gom 3 request/ASIN vào Collection bất đồng bộ; webhook
    // (hoặc lượt cron sau) sẽ lấy kết quả. Giới hạn 1.000 request/collection.
    const entries: CollectionEntry[] = asins.flatMap((asin) => [
      { type: "product" as const, asin, amazon_domain: domain },
      { type: "offers" as const, asin, amazon_domain: domain },
      { type: "sales_estimation" as const, asin, amazon_domain: domain },
    ]);
    const { collectionId, credits } = await provider.createCollection(entries);
    await port.attachExternalId?.(run.id, collectionId);
    return {
      runId: run.id,
      kind: run.kind,
      status: "collection_created",
      creditsUsed: 0, // credit ghi khi collection hoàn tất (webhook)
      competitors: asins.length,
      message: `đã tạo collection ${collectionId} (${credits} request, ${asins.length} ASIN)`,
    };
  }

  // Chạy SONG SONG theo nhóm ASIN (mặc định 4, trần 8): bản tuần tự cũ mất
  // ~6–9s/ASIN → 10 ASIN vượt trần 60s của Vercel (sự cố timeout 17/09/2026).
  // Trong mỗi ASIN, product+offers+sales vẫn gọi song song như trước.
  const rows: CompetitorRow[] = [];
  const concurrency = Math.min(Math.max(asNumber(run.params.concurrency, 4), 1), 8);
  for (let i = 0; i < asins.length; i += concurrency) {
    const batch = asins.slice(i, i + concurrency);
    const batchRows = await Promise.all(
      batch.map(async (asin) => {
        const [product, offers, sales] = await Promise.all([
          provider.product(asin, domain),
          provider.offers(asin, domain),
          provider.salesEstimate({ asin, amazonDomain: domain }),
        ]);
        const patch = parseProductBundle({ product, offers, sales });
        return {
          position: 0,
          isSponsored: false,
          asin: asin.toUpperCase(),
          currency: "USD",
          isAmazon1p: false,
          ...patch,
          dataSource: src(provider),
        } as CompetitorRow;
      }),
    );
    rows.push(...batchRows);
  }
  const { rows: written } = await port.upsertCompetitors(run.id, rows);
  const withEstimate = rows.filter((r) => r.estUnitsMonth !== null && r.estUnitsMonth !== undefined).length;
  if (!written) {
    await port.finishRun({ runId: run.id, status: "no_data", creditsUsed: asins.length * 3 });
    return { runId: run.id, kind: run.kind, status: "no_data", creditsUsed: asins.length * 3, message: "không có product bundle" };
  }
  await port.finishRun({ runId: run.id, status: "done", creditsUsed: asins.length * 3 });

  // G3: chấm ngay trụ cạnh tranh từ SERP + product snapshot (không chặn việc
  // thu thập nếu bước chấm lỗi — chỉ ghi log, lần chạy sau chấm lại).
  let scoringMsg = "";
  try {
    const scoring = await applyCompetitionScoring(run.assessmentId, port);
    scoringMsg = ` · ${scoring.message}`;
  } catch (e) {
    scoringMsg = ` · chấm tập trung lỗi: ${(e as Error).message}`;
  }

  // G7: gộp BSR vào lịch sử (0 credit) rồi tùy chọn backfill Keepa (có khóa
  // KEEPA_API_KEY + cờ RESEARCH_KEEPA_BACKFILL=1 mới bật).
  try {
    const points = await port.refreshBsrHistory?.(run.assessmentId);
    if (typeof points === "number") scoringMsg += ` · ${points} điểm BSR`;
    if (process.env.KEEPA_API_KEY && process.env.RESEARCH_KEEPA_BACKFILL === "1" && port.upsertBsrPoints) {
      const { getKeepaProvider } = await import("../../intelligence/keepa/index.ts");
      const keepa = getKeepaProvider(process.env);
      if (keepa.configured) {
        const hist = await keepa.provider.fetchBsrHistory({
          asins,
          marketplace: domain,
          sinceDays: 365,
        });
        const upserted = await port.upsertBsrPoints(run.orgId, hist.points, run.assessmentId);
        scoringMsg += ` · keepa ${upserted} điểm (${hist.asinsFound} ASIN)`;
      }
    }
  } catch (e) {
    scoringMsg += ` · lịch sử BSR lỗi: ${(e as Error).message}`;
  }

  return {
    runId: run.id,
    kind: run.kind,
    status: "done",
    creditsUsed: asins.length * 3,
    competitors: written,
    message: `${written} ASIN làm giàu product/offers/sales (${withEstimate} có sales estimate)${scoringMsg}`,
  };
}

/**
 * G3 — đọc snapshot mới nhất, chấm trụ cạnh tranh và đồng bộ veto CR3/1P.
 * Dùng chung cho direct collect, webhook Collection và job research:scorecard.
 * Trả về thông điệp ngắn để log; chưa đủ dữ liệu vẫn ghi điểm NULL (trung thực).
 */
export async function applyCompetitionScoring(
  assessmentId: string,
  port: ResearchWorkerPort,
): Promise<{ scored: boolean; message: string }> {
  const { serp, products } = await port.latestScoringRows(assessmentId);
  const scored = scoreCompetitionFromSnapshots(serp, products);
  await port.setPillar({
    assessmentId,
    pillar: "competition",
    score: scored.pillar.score,
    confidence: scored.pillar.confidence,
    reason: scored.pillar.reason,
    metrics: {
      cr3Pct: scored.concentration.cr3Pct,
      cr5Pct: scored.concentration.cr5Pct,
      hhi: scored.concentration.hhi,
      metric: scored.concentration.metric,
      amazon1p: scored.concentration.amazon1p,
      sponsoredSharePct: scored.concentration.sponsoredSharePct,
      organicCount: scored.concentration.organicCount,
    },
  });
  await port.replaceCompetitionVetoes(assessmentId, scored.vetoes);
  return {
    scored: scored.pillar.score !== null,
    message:
      scored.pillar.score === null
        ? scored.pillar.reason
        : `trụ cạnh tranh ${scored.pillar.score.toFixed(1)}/10 · CR3 ${scored.concentration.cr3Pct?.toFixed(1)}% · ${scored.vetoes.length} veto`,
  };
}

/* -------------------------------- REVIEWS --------------------------------- */

const FORBIDDEN_REVIEW_KEYS = ["reviewerName", "reviewerId", "reviewerProfileUrl", "reviewer_name", "reviewer_avatar"];

export async function collectReviews(
  run: ClaimedRun,
  provider: IntelligenceProvider,
  port: ResearchWorkerPort,
): Promise<CollectOutcome> {
  const domain = domainOf(run.marketplace);
  const explicit = asStringArray(run.params.asins);
  const topN = Math.min(asNumber(run.params.topN, 10), 20);
  const maxPages = Math.min(asNumber(run.params.maxPagesPerAsin, 5), 10);
  const targetPerAsin = Math.min(asNumber(run.params.targetPerAsin, 50), 200);
  const asins = explicit.length
    ? explicit.slice(0, 20)
    : await port.latestSerpAsins(run.assessmentId, topN);

  if (!asins.length) {
    await port.finishRun({
      runId: run.id,
      status: "failed",
      error: "chưa có SERP — chạy collect-serp trước hoặc truyền params.asins",
    });
    return { runId: run.id, kind: run.kind, status: "failed", creditsUsed: 0, message: "thiếu ASIN" };
  }

  const all: CriticalReviewRow[] = [];
  const seen = new Set<string>();
  let pagesFetched = 0;

  // Song song THEO NHÓM ASIN (mặc định 4): bản tuần tự cũ ~5–8s/trang, lô
  // 5 ASIN × nhiều trang dễ vượt trần 60s của Vercel. Trong mỗi ASIN các
  // trang vẫn gọi TUẦN TỰ vì cần biết trang cuối/target để dừng sớm.
  const concurrency = Math.min(Math.max(asNumber(run.params.concurrency, 4), 1), 8);
  for (let i = 0; i < asins.length; i += concurrency) {
    const batch = asins.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (asin) => {
        const items: CriticalReviewRow[] = [];
        let pages = 0;
        for (let page = 1; page <= maxPages; page++) {
          const json = await provider.reviews({ asin, amazonDomain: domain, page, reviewStars: "all_critical" });
          pages++;
          const parsed = parseReviewsPage(json, asin, src(provider));
          for (const rv of parsed.reviews) {
            const badKey = FORBIDDEN_REVIEW_KEYS.find((k) => k in (rv as Record<string, unknown>));
            if (badKey) throw new Error(`review còn khóa danh tính ${badKey} — dừng để tránh rò PII`);
            items.push(rv);
          }
          const noMore = parsed.totalPages !== null && page >= parsed.totalPages;
          if (noMore || items.length >= targetPerAsin) break;
        }
        return { items, pages };
      }),
    );
    for (const { items, pages } of batchResults) {
      pagesFetched += pages;
      for (const rv of items) {
        const key = `${rv.asin}:${rv.sourceReviewId}`;
        if (!seen.has(key)) {
          seen.add(key);
          all.push(rv);
        }
      }
    }
  }

  if (!all.length) {
    await port.finishRun({ runId: run.id, status: "no_data", creditsUsed: pagesFetched });
    return { runId: run.id, kind: run.kind, status: "no_data", creditsUsed: pagesFetched, message: "không có review 1–3★" };
  }

  const res = await port.upsertReviews(run.id, all);
  await port.finishRun({ runId: run.id, status: "done", creditsUsed: pagesFetched });
  return {
    runId: run.id,
    kind: run.kind,
    status: "done",
    creditsUsed: pagesFetched,
    reviews: res,
    message: `${res.inserted} review mới (${res.duplicatesSkipped} trùng) trên ${asins.length} ASIN`,
  };
}

/* ------------------------------ G4: ANALYZE ------------------------------ */

function llmRunKey(r: Pick<LlmRunRecord, "sectionKey" | "chunkIndex">): string {
  return `${r.sectionKey}:${r.chunkIndex ?? "-"}`;
}

/**
 * Bước G4: đọc toàn bộ review 1–3★ đã lưu, chạy map/reduce LLM, xác thực
 * nguyên văn trích dẫn, ghi llm_runs + pain_*, rồi chấm 2 trụ demand và
 * differentiation. Không tốn credits Rainforest; chi phí LLM nằm ở llm_runs.
 */
export async function analyzePain(
  run: ClaimedRun,
  llm: LlmProvider,
  port: ResearchWorkerPort,
): Promise<CollectOutcome> {
  const assessmentId = run.assessmentId;
  const reviews = await port.loadReviewsForAnalysis(assessmentId);
  if (!reviews.length) {
    await port.finishRun({
      runId: run.id,
      status: "no_data",
      error: null,
    });
    return { runId: run.id, kind: run.kind, status: "no_data", creditsUsed: 0, message: "chưa có review 1–3★ để phân tích" };
  }

  const chunkSize = Math.min(
    Math.max(asNumber(run.params.chunkSize, 25), 5),
    100,
  );
  const concurrency = Math.min(Math.max(asNumber(run.params.concurrency, 4), 1), 8);
  const runIds = new Map<string, string>();
  const result = await runPainPipeline({
    assessmentId,
    reviews,
    provider: llm,
    chunkSize,
    concurrency,
    createdBy: run.params.regeneratedBy === "human" ? "human_regen" : "ai",
    context: { title: run.title, keywords: run.keywords, marketplace: run.marketplace },
    recordRun: async (rec) => {
      const id = await port.recordLlmRun(rec);
      runIds.set(llmRunKey(rec), id);
    },
  });

  const a = result.analysis;
  const payload: PainAnalysisPayload = {
    provider: a.provider,
    model: a.model,
    schemaVersion: a.schemaVersion,
    sampleSize: a.sampleSize,
    asinCount: a.asinCount,
    observationsDropped: a.observationsDropped,
    quotesDropped: a.quotesDropped,
    generatedAt: a.generatedAt,
    executiveNarrative: a.executiveNarrative,
    clusters: a.clusters,
    items: a.items,
    specs: a.specs,
  };
  const reduceRunId = runIds.get(llmRunKey({ sectionKey: "pain_reduce", chunkIndex: null })) ?? null;
  const counts = await port.savePainAnalysis(assessmentId, payload, reduceRunId);

  await port.setPillar({
    assessmentId,
    pillar: "differentiation",
    score: result.differentiation.score,
    confidence: result.differentiation.confidence,
    reason: result.differentiation.reason,
    metrics: {
      sampleSize: a.sampleSize,
      asinCount: a.asinCount,
      items: a.items.length,
      quotes: a.items.reduce((s, i) => s + i.quotes.length, 0),
      model: a.model,
      provider: a.provider,
    },
  });

  // Demand: sales estimate + velocity review từ snapshot G2/G3 (không LLM).
  const { products } = await port.latestScoringRows(assessmentId);
  const snapshots = await port.demandVelocitySnapshots(assessmentId);
  const demand = scoreDemandFromSnapshots(products, snapshots);
  await port.setPillar({
    assessmentId,
    pillar: "demand",
    score: demand.score,
    confidence: demand.confidence,
    reason: demand.reason,
    metrics: {
      productsSample: products.length,
      medianRatingsTotal: null,
    },
  });

  await port.finishRun({ runId: run.id, status: "done", creditsUsed: 0 });
  return {
    runId: run.id,
    kind: run.kind,
    status: "done",
    creditsUsed: 0,
    analysis: {
      provider: llm.name,
      model: a.model,
      items: a.items.length,
      quotes: counts.quotes ?? a.items.reduce((s, i) => s + i.quotes.length, 0),
      specs: counts.specs ?? a.specs.length,
      quotesDropped: a.quotesDropped,
      tokensIn: result.totalTokensIn,
      tokensOut: result.totalTokensOut,
      costUsd: result.totalCostUsd,
      llmRuns: result.llmRuns.length,
    },
    message:
      `${a.items.length} pain · ${result.totalTokensIn}+${result.totalTokensOut} token · ` +
      `$${result.totalCostUsd.toFixed(5)} · trụ khác biệt ${result.differentiation.score ?? "null"} · demand ${demand.score ?? "null"}`,
  };
}

/**
 * Gom kết quả 1 Rainforest Collection (mỗi ASIN có nhiều request
 * product/offers/sales_estimation) thành CompetitorRow cho run 'products'.
 * Dùng cho webhook Collections lẫn test; KHÔNG I/O.
 */
export function parseProductCollectionResults(
  json: unknown,
  dataSource: IntelligenceDataSource = "rainforest",
): CompetitorRow[] {
  const root = json as {
    results?: { request?: { asin?: string; type?: string }; success?: boolean; output?: unknown }[];
  } | null;
  const byAsin = new Map<string, { product?: unknown; offers?: unknown; sales?: unknown }>();
  for (const item of root?.results ?? []) {
    const asin = item.request?.asin?.toUpperCase();
    if (!asin || item.success === false) continue;
    const bucket = byAsin.get(asin) ?? {};
    const type = item.request?.type;
    if (type === "product") bucket.product = item.output;
    if (type === "offers") bucket.offers = item.output;
    if (type === "sales_estimation") bucket.sales = item.output;
    byAsin.set(asin, bucket);
  }
  const rows: CompetitorRow[] = [];
  for (const [asin, bundle] of byAsin) {
    const patch = parseProductBundle(bundle);
    rows.push({
      position: 0,
      isSponsored: false,
      asin,
      currency: "USD",
      isAmazon1p: false,
      ...patch,
      dataSource,
    });
  }
  return rows;
}

export const RESEARCH_COLLECTORS = {
  serp: collectSerp,
  products: collectProducts,
  sales: collectProducts, // sales nằm gối trong products
  reviews: collectReviews,
} as const;

/** Nhận lần lượt mọi run queued của các loại cho phép đến khi hết. */
/** Ước credits cho MỘT run (bi quan), dùng chặn trước khi tiêu. */
async function estimateRunCost(run: ClaimedRun, port: ResearchWorkerPort): Promise<number> {
  const explicit = asStringArray(run.params.asins);
  switch (run.kind) {
    case "serp":
      return 1;
    case "products":
    case "offers":
    case "sales": {
      // product+offers+sales = 3 request/ASIN (cộng 1 search cho chắc)
      const n = explicit.length || (await port.latestSerpAsins(run.assessmentId, 30)).length;
      return n ? 1 + n * 3 : 0;
    }
    case "reviews": {
      const n = explicit.length || (await port.latestSerpAsins(run.assessmentId, 10)).length;
      const pages = Math.max(1, asNumber(run.params.reviewPages, 2));
      return n * pages;
    }
    default:
      return 0; // fees (SP-API), analyze (LLM) không tốn credit Rainforest
  }
}

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export async function drainResearchQueue(
  provider: IntelligenceProvider,
  port: ResearchWorkerPort,
  opts: {
    kinds?: string[];
    max?: number;
    log?: (s: string) => void;
    /** provider LLM cho run 'analyze' (bắt buộc khi kinds gồm 'analyze'). */
    llm?: LlmProvider;
    /**
     * Giới hạn claim trong MỘT hồ sơ (nút "Chạy ngay" trên UI). null/bỏ qua =
     * vét toàn cục (cron/CLI). Sự cố 17/09/2026: không lọc hồ sơ nên nút hồ sơ
     * này nhặt trúng lượt queued của hồ sơ khác.
     */
    assessmentId?: string | null;
  },
): Promise<CollectOutcome[]> {
  const kinds = opts.kinds ?? ["serp", "products", "reviews"];
  const max = opts.max ?? 20;
  const outcomes: CollectOutcome[] = [];
  for (let i = 0; i < max; i++) {
    let run: ClaimedRun | null = null;
    for (const kind of kinds) {
      run = await port.claimRun(kind, opts.assessmentId ?? null);
      if (run) break;
    }
    if (!run) break;
    const fn = RESEARCH_COLLECTORS[run.kind as keyof typeof RESEARCH_COLLECTORS];
    if (!fn && run.kind !== "analyze") {
      await port.finishRun({ runId: run.id, status: "failed", error: `loại run chưa hỗ trợ: ${run.kind}` });
      continue;
    }

    // G7 — CHẶN NGÂN SÁCH trước khi tiêu credit (cảnh báo thì cho chạy,
    // vượt trần cứng thì đánh failed, không gọi Rainforest).
    if (port.creditStatus) {
      try {
        const cost = await estimateRunCost(run, port);
        const { creditsSpent } = await port.creditStatus(run.orgId);
        const decision = decideCreditBudget({
          spentMonth: creditsSpent,
          estimatedNextCost: cost,
          softBudget: envInt("RESEARCH_CREDIT_BUDGET_MONTHLY", 2_000),
          hardCap: envInt("RESEARCH_CREDIT_HARD_CAP_MONTHLY", 10_000),
        });
        if (decision.level === "warn") {
          opts.log?.(`[research] CẢNH BÁO ngân sách credits: ${decision.reasons.join(" ")}`);
        }
        if (decision.level === "block") {
          const reason = `[budget] ${decision.reasons.join(" ")}`;
          await port.finishRun({ runId: run.id, status: "failed", error: reason });
          outcomes.push({ runId: run.id, kind: run.kind, status: "failed", creditsUsed: 0, message: reason });
          opts.log?.(`[research] ${run.kind} ${run.id.slice(0, 8)} → BLOCKED budget`);
          continue;
        }
      } catch (e) {
        // Không vì lỗi đọc sổ cái mà dừng thu thập; chỉ log.
        opts.log?.(`[research] bỏ qua kiểm tra ngân sách: ${(e as Error).message}`);
      }
    }

    try {
      const outcome =
        run.kind === "analyze"
          ? opts.llm
            ? await analyzePain(run, opts.llm, port)
            : (() => {
                throw new Error("run 'analyze' cần LLM provider (LLM_API_KEY hoặc provider=mock)");
              })()
          : fn
            ? await fn(run, provider, port)
            : (() => {
                throw new Error(`loại run chưa hỗ trợ: ${run.kind}`);
              })();
      outcomes.push(outcome);
      opts.log?.(`[research] ${run.kind} ${run.id.slice(0, 8)} → ${outcome.status}: ${outcome.message}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await port.finishRun({ runId: run.id, status: "failed", error: message });
      opts.log?.(`[research] ${run.kind} ${run.id.slice(0, 8)} → FAILED: ${message}`);
      outcomes.push({ runId: run.id, kind: run.kind, status: "failed", creditsUsed: 0, message });
    }
  }
  return outcomes;
}
