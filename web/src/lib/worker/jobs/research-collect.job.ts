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
  CompetitorRow,
  CriticalReviewRow,
  IntelligenceDataSource,
} from "../../research/domain/index.ts";
import {
  parseProductBundle,
  parseReviewsPage,
  parseSearchPage,
  summarizeCompetitors,
} from "../../research/domain/index.ts";
import type {
  CollectionEntry,
  IntelligenceProvider,
} from "../../intelligence/types.ts";

export type ClaimedRun = {
  id: string;
  assessmentId: string;
  orgId: string;
  kind: "serp" | "products" | "offers" | "sales" | "reviews" | "fees";
  params: Record<string, unknown>;
  title: string;
  marketplace: string;
  keywords: string[];
  seedAsin: string | null;
  categoryNode: string | null;
};

export type FinishStatus = "done" | "no_data" | "failed";

export type ResearchWorkerPort = {
  claimRun(kind: string): Promise<ClaimedRun | null>;
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
};

export type CollectOutcome = {
  runId: string;
  kind: string;
  status: FinishStatus | "collection_created";
  creditsUsed: number;
  competitors?: number;
  reviews?: { inserted: number; duplicatesSkipped: number };
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

  const rows: CompetitorRow[] = [];
  for (const asin of asins) {
    const [product, offers, sales] = await Promise.all([
      provider.product(asin, domain),
      provider.offers(asin, domain),
      provider.salesEstimate({ asin, amazonDomain: domain }),
    ]);
    const patch = parseProductBundle({ product, offers, sales });
    rows.push({
      position: 0,
      isSponsored: false,
      asin: asin.toUpperCase(),
      currency: "USD",
      isAmazon1p: false,
      ...patch,
      dataSource: src(provider),
    });
  }
  const { rows: written } = await port.upsertCompetitors(run.id, rows);
  const withEstimate = rows.filter((r) => r.estUnitsMonth !== null && r.estUnitsMonth !== undefined).length;
  if (!written) {
    await port.finishRun({ runId: run.id, status: "no_data", creditsUsed: asins.length * 3 });
    return { runId: run.id, kind: run.kind, status: "no_data", creditsUsed: asins.length * 3, message: "không có product bundle" };
  }
  await port.finishRun({ runId: run.id, status: "done", creditsUsed: asins.length * 3 });
  return {
    runId: run.id,
    kind: run.kind,
    status: "done",
    creditsUsed: asins.length * 3,
    competitors: written,
    message: `${written} ASIN làm giàu product/offers/sales (${withEstimate} có sales estimate)`,
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

  for (const asin of asins) {
    for (let page = 1; page <= maxPages; page++) {
      const json = await provider.reviews({ asin, amazonDomain: domain, page, reviewStars: "all_critical" });
      pagesFetched++;
      const parsed = parseReviewsPage(json, asin, src(provider));
      for (const rv of parsed.reviews) {
        const badKey = FORBIDDEN_REVIEW_KEYS.find((k) => k in (rv as Record<string, unknown>));
        if (badKey) throw new Error(`review còn khóa danh tính ${badKey} — dừng để tránh rò PII`);
        const key = `${rv.asin}:${rv.sourceReviewId}`;
        if (!seen.has(key)) {
          seen.add(key);
          all.push(rv);
        }
      }
      const collectedForAsin = all.filter((r) => r.asin === asin.toUpperCase()).length;
      const noMore = parsed.totalPages !== null && page >= parsed.totalPages;
      if (noMore || collectedForAsin >= targetPerAsin) break;
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
export async function drainResearchQueue(
  provider: IntelligenceProvider,
  port: ResearchWorkerPort,
  opts: { kinds?: string[]; max?: number; log?: (s: string) => void },
): Promise<CollectOutcome[]> {
  const kinds = opts.kinds ?? ["serp", "products", "reviews"];
  const max = opts.max ?? 20;
  const outcomes: CollectOutcome[] = [];
  for (let i = 0; i < max; i++) {
    let run: ClaimedRun | null = null;
    for (const kind of kinds) {
      run = await port.claimRun(kind);
      if (run) break;
    }
    if (!run) break;
    const fn = RESEARCH_COLLECTORS[run.kind as keyof typeof RESEARCH_COLLECTORS];
    if (!fn) {
      await port.finishRun({ runId: run.id, status: "failed", error: `loại run chưa hỗ trợ: ${run.kind}` });
      continue;
    }
    try {
      const outcome = await fn(run, provider, port);
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
