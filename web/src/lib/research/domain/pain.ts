/**
 * Module 8 G4 — PHÂN CỤM ĐIỂM ĐAU (pain-point clustering), lớp THUẦN.
 *
 * Phân chia 3 cụm theo đặc tả: Quality / Expectation Gap / Logistics.
 *
 * NGUYÊN TẮC CHỐNG BỊA (đặc tả mục 7):
 *   • LLM chỉ trích câu NGUYÊN VĂN trong review; hàm validateQuote đối chiếu
 *     chuỗi token — không khớp reviews_raw.body thì LOẠI (đếm quotesDropped).
 *   • Tần suất/độ nghiêm trọng/ưu tiên được TÍNH LẠI deterministic từ tập
 *     review, không tin con số LLM trả về.
 *   • Thiếu review (< ngưỡng mẫu) → trụ differentiation = null "chưa đủ cơ sở".
 *   • LLM KHÔNG sinh veto/score; score do các hàm ở đây sinh.
 */

import type { CriticalReviewRow } from "./collection.ts";
import { R1 } from "./numbers.ts";

/* ================================ TYPES ================================== */

export const PAIN_SCHEMA_VERSION = "pain-0.1.0";

export type PainClusterCode = "quality" | "expectation_gap" | "logistics";
export const PAIN_CLUSTER_ORDER: PainClusterCode[] = [
  "quality",
  "expectation_gap",
  "logistics",
];
export const PAIN_CLUSTER_LABELS: Record<PainClusterCode, string> = {
  quality: "Chất lượng sản phẩm (Quality)",
  expectation_gap: "Lệch kỳ vọng so với mô tả (Expectation Gap)",
  logistics: "Đóng gói & vận hành (Logistics)",
};

export type PainPriority = "must" | "should" | "skip";
export const PRIORITY_LABELS: Record<PainPriority, string> = {
  must: "Must — bắt buộc xử lý",
  should: "Should — nên xử lý",
  skip: "Skip — theo dõi",
};

/** Review kèm id nội bộ (uuid reviews_raw khi đến từ DB). */
export type AnalysisReview = CriticalReviewRow & { dbId?: string | null };

/** Trích dẫn gốc đã xác thực truy được về 1 review. */
export type PainQuote = {
  reviewId: string; // source_review_id (id Amazon, không phải id người review)
  dbId?: string | null; // uuid reviews_raw
  quote: string; // NGUYÊN VĂN trích từ body (≤ 25 từ)
  asin: string;
  stars: number | null;
  reviewDate: string | null;
  url: string | null;
  verified: boolean;
  helpfulCount: number;
  photosCount: number;
};

/** Một quan sát pain ở bước MAP (gắn với đúng 1 review). */
export type PainObservation = {
  reviewId: string;
  cluster: PainClusterCode;
  subLabel: string | null;
  painTitle: string;
  quote: string; // câu LLM trích, sẽ được đối chiếu nguyên văn
};

/** Gợi ý mục pain từ bước REDUCE (con số sẽ bị tính lại, không tin LLM). */
export type PainItemDraft = {
  itemKey: string; // khóa ổn định do LLM đặt (slug ngắn), tối đa 40 ký tự
  cluster: PainClusterCode;
  title: string;
  subLabel: string | null;
  reviewIds: string[]; // review mà LLM gom vào pain này (để đếm lại)
  effortHint: number | null; // 1 (nhẹ) … 3 (nặng) — chỉ là gợi ý
  factoryRequirement: string | null;
  listingFix: string | null;
  testMethod: string | null;
  acceptanceStandard: string | null;
  costImpactEstimate: string | null;
};

export type PainItem = PainItemDraft & {
  frequency: number; // số review distinct nhắc pain
  frequencyPct: number; // % trên tổng mẫu review
  avgStars: number | null;
  severity: number; // 1..10 (sao thấp + tần suất cao)
  impactScore: number; // 1..10 cho ma trận impact×effort
  effortScore: number; // 1..10
  priority: PainPriority;
  quotes: PainQuote[];
};

export type PainClusterSummary = {
  code: PainClusterCode;
  label: string;
  sharePct: number; // % review có ≥1 pain thuộc cụm
  itemCount: number;
  reviewCount: number;
  avgStars: number | null;
  narrative: string | null; // LLM nháp tiếng Việt
};

export type ImprovementSpec = {
  itemKey: string;
  cluster: PainClusterCode;
  painTitle: string;
  requirement: string | null;
  testMethod: string | null;
  acceptanceStandard: string | null;
  costImpactEstimate: string | null;
  owner: string | null; // người xác nhận điền (G4 để trống)
  source: "llm_suggested" | "human_confirmed";
};

export type PainAnalysis = {
  schemaVersion: string;
  provider: string;
  model: string;
  sampleSize: number;
  asinCount: number;
  clusters: PainClusterSummary[];
  items: PainItem[];
  specs: ImprovementSpec[];
  quotesDropped: number;
  observationsDropped: number;
  executiveNarrative: string | null;
  generatedAt: string; // ISO
};

/** Kết quả chấm 2 trụ G4 (demand từ snapshot, differentiation từ pain). */
export type G4PillarScores = {
  demand: { score: number | null; confidence: "high" | "medium" | "low" | null; reason: string };
  differentiation: {
    score: number | null;
    confidence: "high" | "medium" | "low" | null;
    reason: string;
  };
};

/* ============================ NGUƯỠNG CÔNG KHAI ========================== */

/** Tối thiểu số review 1–3★ để chấm trụ khác biệt hóa (đặc tả: ~500/ngách). */
export const MIN_REVIEWS_FOR_DIFFERENTIATION = 30;
/** Tối đa quote đại diện mỗi pain (đặc tả: 2–3). */
export const MAX_QUOTES_PER_ITEM = 3;
/** Số từ tối đa của 1 câu trích (đặc tả mục 7). */
export const MAX_QUOTE_WORDS = 25;

/* ===================== CHUẨN HÓA & ĐỐI CHIẾU TRÍCH DẪN ================== */

/**
 * Chuẩn hóa nhẹ cho việc đối chiếu: NFKC, lowercase, gộp khoảng trắng.
 * GIỮ NGUYÊN dấu câu bên trong câu (để không biến dạng câu gốc); chỉ cắt các
 * ký tự đầu/cuối không phải chữ-số khi so token.
 */
export function normalizeText(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

function wordsOf(s: string): string[] {
  return normalizeText(s).match(WORD_RE) ?? [];
}

/**
 * Tìm chuỗi từ của `proposed` xuất hiện LIÊN TỤC trong `body`; trả về đoạn
 * NGUYÊN VĂN trong body gốc (giữ nguyên hoa/thường, dấu câu) hoặc null.
 *
 * Hỗ trợ câu trích có cắt bằng "…"/"..." : khi đó MỌI đoạn (≥3 từ) phải xuất
 * hiện trong body theo đúng thứ tự; đoạn trả về là phần từ đầu đoạn 1 đến
 * cuối đoạn cuối (nội dung giữa dấu ba chấm vẫn là nguyên văn của body).
 */
export function extractVerbatimQuote(proposed: string, body: string): string | null {
  if (!proposed || !body) return null;

  // Tách theo dấu ba chấm (… hoặc ...) — mỗi đoạn phải tìm thấy nguyên văn
  // trong body theo đúng thứ tự.
  const segments = proposed
    .split(/\.\.\.|…/u)
    .map((s) => s.trim())
    .filter((s) => wordsOf(s).length >= 2);
  const parts = segments.length ? segments : [proposed.trim()];

  let cursor = 0;
  const verbatimParts: string[] = [];
  let totalWords = 0;
  for (const part of parts) {
    const tokens = wordsOf(part);
    if (tokens.length < 2 || totalWords + tokens.length > MAX_QUOTE_WORDS) return null;
    const span = findSpanIn(body.slice(cursor), tokens);
    if (!span) return null;
    const absStart = cursor + span.start;
    const absEnd = cursor + span.end;
    verbatimParts.push(body.slice(absStart, absEnd).trim());
    totalWords += tokens.length;
    cursor = absEnd;
  }
  // Nhiều đoạn (LLM cắt bằng …): giữ nguyên văn TỪNG đoạn, nối bằng " … " để
  // người đọc biết phần giữa bị lược — không nhồi text LLM không định trích.
  return parts.length > 1 ? verbatimParts.join(" … ") : verbatimParts[0];
}

function findSpanIn(window: string, tokens: string[]): { start: number; end: number } | null {
  // Giữa 2 từ liên tiếp cho phép dấu câu/khoảng trắng ngắn (≤12 ký tự không
  // phải chữ-số) để khớp câu tự nhiên (", ", " — ", xuống dòng), vẫn ép các
  // từ phải xuất hiện ĐÚNG THỨ TỰ và LIỀN MẠCH.
  const gap = "[^\\p{L}\\p{N}]{0,12}?";
  const strict = new RegExp(
    `(?<![\\p{L}\\p{N}])${tokens
      .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(gap)}(?![\\p{L}\\p{N}])`,
    "iu",
  );
  const m = strict.exec(window);
  if (!m || m.index === undefined) return null;
  return { start: m.index, end: m.index + m[0].length };
}

/**
 * Xác thực 1 câu trích với đúng review nó quy về: phải trích nguyên văn từ
 * CHÍNH body của review đó (không nhận quote của review khác).
 */
export function validateQuote(
  proposed: string,
  review: AnalysisReview,
): PainQuote | null {
  const verbatim = extractVerbatimQuote(proposed, review.body);
  if (!verbatim) return null;
  return {
    reviewId: review.sourceReviewId,
    dbId: review.dbId ?? null,
    quote: verbatim,
    asin: review.asin,
    stars: review.stars,
    reviewDate: review.reviewDate,
    url: review.url,
    verified: review.verified,
    helpfulCount: review.helpfulCount,
    photosCount: review.photosCount,
  };
}

/* ============================ GOM & TÍNH LẠI ============================= */

function clamp10(n: number): number {
  return Math.max(1, Math.min(10, n));
}

function avg(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * Đối chiếu TOÀN BỘ quan sát bước map với review thật:
 *  - bỏ quan sát không có review trong mẫu / sai cụm;
 *  - bỏ quote không truy gốc (đếm quotesDropped);
 * trả về index theo dõi reviewId → các quote hợp lệ.
 */
export function validateObservations(
  observations: PainObservation[],
  reviews: AnalysisReview[],
): {
  valid: { obs: PainObservation; quote: PainQuote }[];
  dropped: number;
  quotesDropped: number;
} {
  const byId = new Map(reviews.map((r) => [r.sourceReviewId, r]));
  const valid: { obs: PainObservation; quote: PainQuote }[] = [];
  const seenQuote = new Set<string>();
  let dropped = 0;
  let quotesDropped = 0;

  for (const obs of observations) {
    const review = byId.get(obs.reviewId);
    if (!review || !obs.painTitle?.trim() || !PAIN_CLUSTER_ORDER.includes(obs.cluster)) {
      dropped++;
      continue;
    }
    const quote = validateQuote(obs.quote, review);
    if (!quote) {
      dropped++;
      quotesDropped++;
      continue;
    }
    const dedupeKey = `${obs.reviewId}:${normalizeText(quote.quote)}`;
    if (seenQuote.has(dedupeKey)) continue;
    seenQuote.add(dedupeKey);
    valid.push({ obs, quote });
  }
  return { valid, dropped, quotesDropped };
}

/** Phân loại mức effort xử lý từ GỢI Ý văn bản LLM (deterministic, công khai). */
export function classifyEffort(d: {
  factoryRequirement: string | null;
  listingFix: string | null;
  testMethod: string | null;
  effortHint: number | null;
}): { score: number; needsFactory: boolean } {
  const text = [d.factoryRequirement, d.testMethod]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const hasListingFix = !!d.listingFix?.trim();

  if (!d.factoryRequirement?.trim()) {
    return { score: hasListingFix ? 2 : 3, needsFactory: false };
  }
  const heavy =
    /electronic|điện|mạch|pin|battery|cert|chứng nhận|cpsc|fcc|khuôn|mold|mould|đổi vật liệu|material change/i.test(
      text,
    );
  const packaging = /đóng gói|packag|hộp|box|bao bì|quy cách/i.test(text);
  if (heavy) return { score: 8, needsFactory: true };
  if (packaging) return { score: 4, needsFactory: true };
  // Mặc định cho sửa hàng/xưởng: 6; hiệu chỉnh theo hint 1..3 → ±1.
  const hintAdj = d.effortHint === 1 ? -1 : d.effortHint === 3 ? 1 : 0;
  return { score: clamp10(6 + hintAdj), needsFactory: true };
}

function priorityFor(
  severity: number,
  frequencyPct: number,
  avgStars: number | null,
): PainPriority {
  const widespread = frequencyPct >= 10;
  const veryAngry = avgStars !== null && avgStars <= 1.5 && frequencyPct >= 5;
  if ((severity >= 8 && widespread) || veryAngry) return "must";
  if (severity >= 5) return "should";
  return "skip";
}

const quoteRank = (q: PainQuote): number =>
  (q.verified ? 100 : 0) +
  (q.photosCount > 0 ? 40 : 0) +
  Math.min(q.helpfulCount, 30) +
  (q.reviewDate ? Date.parse(q.reviewDate) / 1e12 : 0);

export type ReduceInput = {
  drafts: PainItemDraft[];
  observations: PainObservation[];
  reviews: AnalysisReview[];
  narratives?: Partial<Record<PainClusterCode, string | null>>;
  executiveNarrative?: string | null;
  provider: string;
  model: string;
  generatedAt?: string;
};

/**
 * REDUCE — toàn bộ phần số liệu do HÀM NÀY tính lại từ dữ liệu gốc; LLM chỉ
 * cung cấp tiêu đề pain, cách gom reviewId và gợi ý hướng xử lý.
 */
export function reducePainAnalysis(input: ReduceInput): {
  analysis: PainAnalysis;
  quotesDropped: number;
  observationsDropped: number;
} {
  const { valid, dropped, quotesDropped } = validateObservations(
    input.observations,
    input.reviews,
  );

  // reviewId → quotes hợp lệ (gắn cụm của quan sát)
  const obsByReview = new Map<string, { obs: PainObservation; quote: PainQuote }[]>();
  for (const v of valid) {
    const list = obsByReview.get(v.obs.reviewId) ?? [];
    list.push(v);
    obsByReview.set(v.obs.reviewId, list);
  }
  const reviewById = new Map(input.reviews.map((r) => [r.sourceReviewId, r]));
  const sampleSize = input.reviews.length;

  const items: PainItem[] = [];
  const usedObsKeys = new Set<string>();

  for (const draft of input.drafts) {
    if (!PAIN_CLUSTER_ORDER.includes(draft.cluster)) continue;

    // Chỉ nhận reviewId LLM gom khi: tồn tại trong mẫu, có quan sát hợp lệ
    // thuộc ĐÚNG cụm của pain.
    const memberObs: { obs: PainObservation; quote: PainQuote }[] = [];
    const memberReviews = new Set<string>();
    for (const rid of draft.reviewIds ?? []) {
      const candidates = (obsByReview.get(rid) ?? []).filter(
        (v) => v.obs.cluster === draft.cluster && !usedObsKeys.has(`${rid}:${v.obs.painTitle}`),
      );
      if (!candidates.length) continue;
      memberReviews.add(rid);
      for (const c of candidates) {
        memberObs.push(c);
        usedObsKeys.add(`${rid}:${c.obs.painTitle}`);
      }
    }
    if (!memberReviews.size) continue;

    const stars = [...memberReviews]
      .map((rid) => reviewById.get(rid)?.stars)
      .filter((s): s is number => typeof s === "number");
    const avgStars = avg(stars);
    const frequency = memberReviews.size;
    const frequencyPct = sampleSize ? R1((frequency / sampleSize) * 100) : 0;

    // Độ nghiêm trọng: 65% mức sao thấp + 35% mức phổ biến.
    const starScore = avgStars === null ? 5 : clamp10(10 - avgStars * 2.5);
    const freqScore = clamp10((frequencyPct / 20) * 10);
    const severity = R1(clamp10(0.65 * starScore + 0.35 * freqScore));
    const impactScore = severity;
    const { score: effortScore } = classifyEffort(draft);
    const priority = priorityFor(severity, frequencyPct, avgStars);

    // Chọn 2–3 quote đại diện: verified → có ảnh → nhiều helpful → mới nhất.
    // Cùng câu chữ ở 2 review KHÁC NHAU vẫn là bằng chứng độc lập (khách khác,
    // link/sao/ngày khác); chỉ chặn 1 review đóng 2 quote cho cùng pain.
    const chosenReviews = new Set<string>();
    const quotes = memberObs
      .map((m) => m.quote)
      .sort((a, b) => quoteRank(b) - quoteRank(a))
      .filter((q) => {
        if (chosenReviews.has(q.reviewId)) return false;
        chosenReviews.add(q.reviewId);
        return true;
      })
      .slice(0, MAX_QUOTES_PER_ITEM);

    items.push({
      ...draft,
      itemKey: draft.itemKey.slice(0, 40),
      frequency,
      frequencyPct,
      avgStars,
      severity,
      impactScore,
      effortScore,
      priority,
      quotes,
    });
  }

  // Xếp: must → should → skip, trong cùng mức severity giảm dần.
  const rank: Record<PainPriority, number> = { must: 0, should: 1, skip: 2 };
  items.sort((a, b) => rank[a.priority] - rank[b.priority] || b.severity - a.severity);

  // Tổng hợp cụm.
  const clusters: PainClusterSummary[] = PAIN_CLUSTER_ORDER.map((code) => {
    const inCluster = items.filter((i) => i.cluster === code);
    const reviewIds = new Set<string>();
    for (const i of inCluster) for (const q of i.quotes) reviewIds.add(q.reviewId);
    for (const i of inCluster) for (const rid of i.reviewIds) reviewIds.add(rid);
    const stars = [...reviewIds]
      .map((rid) => reviewById.get(rid)?.stars)
      .filter((s): s is number => typeof s === "number");
    return {
      code,
      label: PAIN_CLUSTER_LABELS[code],
      sharePct: sampleSize ? R1((reviewIds.size / sampleSize) * 100) : 0,
      itemCount: inCluster.length,
      reviewCount: reviewIds.size,
      avgStars: avg(stars) === null ? null : R1(avg(stars)!),
      narrative: input.narratives?.[code] ?? null,
    };
  });

  const specs: ImprovementSpec[] = items
    .filter((i) => i.priority !== "skip")
    .map((i) => ({
      itemKey: i.itemKey,
      cluster: i.cluster,
      painTitle: i.title,
      requirement: i.factoryRequirement,
      testMethod: i.testMethod,
      acceptanceStandard: i.acceptanceStandard,
      costImpactEstimate: i.costImpactEstimate,
      owner: null,
      source: "llm_suggested" as const,
    }));

  const asinCount = new Set(input.reviews.map((r) => r.asin)).size;
  const analysis: PainAnalysis = {
    schemaVersion: PAIN_SCHEMA_VERSION,
    provider: input.provider,
    model: input.model,
    sampleSize,
    asinCount,
    clusters,
    items,
    specs,
    quotesDropped,
    observationsDropped: dropped,
    executiveNarrative: input.executiveNarrative ?? null,
    generatedAt: input.generatedAt ?? new Date(0).toISOString(),
  };
  return { analysis, quotesDropped, observationsDropped: dropped };
}

/* ======================= CHẤM TRỤ KHÁC BIỆT HÓA ========================== */

/**
 * Trụ differentiation (20%): điểm đau của đối thủ LÀ khoảng trống khác biệt.
 * - Chưa đủ mẫu (<30 review) → null "chưa đủ cơ sở".
 * - Điểm theo severity TB các pain should/must CÓ hướng xử lý, trừ theo effort.
 * - Thị trường gần như không có pain đáng kể → điểm thấp (khó tạo khác biệt).
 */
export function scoreDifferentiation(analysis: PainAnalysis): G4PillarScores["differentiation"] {
  if (analysis.sampleSize < MIN_REVIEWS_FOR_DIFFERENTIATION) {
    return {
      score: null,
      confidence: null,
      reason: `Mới có ${analysis.sampleSize} review 1–3★, cần ≥${MIN_REVIEWS_FOR_DIFFERENTIATION} để chấm khác biệt hóa`,
    };
  }
  const actionable = analysis.items.filter(
    (i) => i.priority !== "skip" && (i.factoryRequirement?.trim() || i.listingFix?.trim()),
  );
  if (!actionable.length) {
    return {
      score: 4,
      confidence: "low",
      reason: `${analysis.sampleSize} review nhưng không phát hiện pain có hướng xử lý — ít khoảng trống khác biệt rõ`,
    };
  }
  const meanSeverity =
    actionable.reduce((a, i) => a + i.severity, 0) / actionable.length;
  const meanEffort = actionable.reduce((a, i) => a + i.effortScore, 0) / actionable.length;
  const mustBoost = analysis.items.filter((i) => i.priority === "must").length * 0.4;
  const score = R1(clamp10(meanSeverity - 0.3 * (meanEffort - 5) + mustBoost));
  const confidence = analysis.sampleSize >= 200 ? "high" : "medium";
  return {
    score,
    confidence,
    reason: `${actionable.length} pain khả thi (${analysis.items.filter((i) => i.priority === "must").length} must), severity TB ${R1(meanSeverity)}, effort TB ${R1(meanEffort)} trên ${analysis.sampleSize} review`,
  };
}

/* ========================== TRỤ NHU CẦU (DEMAND) ========================= */

export type DemandSignals = {
  /** Trung vị đơn/tháng ước lượng của ASIN organic (sales estimation G2). */
  medianUnitsMonth: number | null;
  /** Trung vị tổng ratings của ASIN organic (quy mô tích lũy). */
  medianRatingsTotal: number | null;
  /** Tổng review mới/tháng của mẫu SERP (tính từ 2 lần quét, G3). */
  reviewVelocityMonth: number | null;
  /** Số ASIN có sales estimate trong mẫu. */
  unitsSampleSize: number;
};

/** Bảng điểm demand công khai theo đơn/tháng trung vị top organic (Amazon US). */
export function scoreDemand(s: DemandSignals): G4PillarScores["demand"] {
  const scoreFromUnits = (u: number): number => {
    if (u >= 10000) return 10;
    if (u >= 5000) return 9;
    if (u >= 3000) return 7;
    if (u >= 1500) return 5;
    if (u >= 700) return 3;
    return 1;
  };
  const scoreFromVelocity = (v: number): number => {
    if (v >= 300) return 10;
    if (v >= 150) return 8;
    if (v >= 60) return 6;
    if (v >= 20) return 4;
    return 2;
  };

  if (s.medianUnitsMonth !== null && s.unitsSampleSize >= 5) {
    const unitScore = scoreFromUnits(s.medianUnitsMonth);
    let score = unitScore;
    let conf: "high" | "medium" = s.unitsSampleSize >= 10 ? "high" : "medium";
    const bits: string[] = [`trung vị ${Math.round(s.medianUnitsMonth).toLocaleString("en-US")} đơn/tháng (${s.unitsSampleSize} ASIN)`];
    if (s.reviewVelocityMonth !== null) {
      const vScore = scoreFromVelocity(s.reviewVelocityMonth);
      score = R1(0.7 * unitScore + 0.3 * vScore);
      bits.push(`velocity ${Math.round(s.reviewVelocityMonth)} review/tháng`);
    }
    return { score, confidence: conf, reason: bits.join(" · ") + " · sales là ƯỚC LƯỢNG từ BSR (sai số 20–40%)" };
  }
  if (s.reviewVelocityMonth !== null) {
    return {
      score: scoreFromVelocity(s.reviewVelocityMonth),
      confidence: "low",
      reason: `Chỉ có velocity ${Math.round(s.reviewVelocityMonth)} review/tháng, chưa có sales estimate — điểm tin cậy thấp`,
    };
  }
  return {
    score: null,
    confidence: null,
    reason: "Chưa có sales estimate hoặc review velocity từ Rainforest (G2/G3)",
  };
}

/** Trung vị tiện ích (số liệu mẫu thị trường). */
export function median(nums: (number | null | undefined)[]): number | null {
  const a = nums.filter((n): n is number => typeof n === "number" && Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
