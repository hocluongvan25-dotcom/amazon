/**
 * Module 8 G4 — test lớp thuần phân cụm pain:
 * đối chiếu trích dẫn nguyên văn, loại câu bịa, tính lại tần suất/nghiêm
 * trọng, chốt priority, chấm trụ differentiation/demand.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_QUOTE_WORDS,
  MIN_REVIEWS_FOR_DIFFERENTIATION,
  PAIN_CLUSTER_ORDER,
  extractVerbatimQuote,
  reducePainAnalysis,
  scoreDemand,
  scoreDifferentiation,
  validateObservations,
  validateQuote,
  type AnalysisReview,
  type PainItemDraft,
  type PainObservation,
} from "../src/lib/research/domain/index.ts";

function review(over: Partial<AnalysisReview> & { id: string; body: string }): AnalysisReview {
  return {
    asin: "B000TEST01",
    sourceReviewId: over.id,
    stars: over.stars ?? 1,
    title: over.title ?? null,
    body: over.body,
    reviewDate: over.reviewDate ?? "2026-08-01",
    helpfulCount: over.helpfulCount ?? 0,
    verified: over.verified ?? false,
    photosCount: over.photosCount ?? 0,
    url: over.url ?? `https://amazon.com/dp/B000TEST01#${over.id}`,
    dataSource: "rainforest",
  };
}

/* ----------------------- đối chiếu trích dẫn ----------------------- */

test("trích nguyên văn 1 đoạn câu trong body → trả đúng text gốc", () => {
  const body = "I really wanted to like it, but the metal RUSTED after two weeks in the dishwasher.";
  const q = extractVerbatimQuote("the metal rusted after two weeks", body);
  assert.equal(q, "the metal RUSTED after two weeks");
});

test("trích lệch hoa/thường và thừa khoảng trắng vẫn khớp, giữ nguyên văn gốc", () => {
  const body = "  The   handle broke  off after 3 days. Very disappointed. ";
  const q = extractVerbatimQuote("the handle broke off after 3 days", body);
  assert.equal(q, "The   handle broke  off after 3 days");
});

test("câu trích CÓ DẤU PHẨY giữa câu vẫn khớp nguyên văn", () => {
  const body = "Cheap material, flimsy hinge, it snapped in a month.";
  const q = extractVerbatimQuote("cheap material, flimsy hinge", body);
  assert.ok(q?.toLowerCase().includes("cheap material, flimsy hinge"));
});

test("trích theo dấu ba chấm: mọi đoạn phải có trong body theo thứ tự", () => {
  const body = "The lid does not seal at all and after a month the gasket started to smell bad.";
  const q = extractVerbatimQuote("the lid does not seal … gasket started to smell", body);
  assert.ok(q);
  assert.ok(q!.startsWith("The lid does not seal"));
  assert.ok(q!.includes("gasket started to smell"));
});

test("CÂU BỊA không có trong body → null", () => {
  const body = "It works fine, no complaints so far after a month of daily use.";
  assert.equal(extractVerbatimQuote("the battery exploded on my counter", body), null);
  assert.equal(extractVerbatimQuote("it caught fire and burned my house", body), null);
});

test("câu trích dài hơn 25 từ → từ chối", () => {
  const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
  assert.equal(extractVerbatimQuote(words, words), null);
  assert.equal(MAX_QUOTE_WORDS, 25);
});

test("validateQuote gắn đầy đủ metadata truy gốc ASIN–sao–ngày–link", () => {
  const r = review({
    id: "R1",
    body: "Arrived with a cracked corner and the box was crushed.",
    stars: 2,
    reviewDate: "2026-07-11",
    verified: true,
    helpfulCount: 12,
    url: "https://www.amazon.com/dp/X#R1",
  });
  const q = validateQuote("arrived with a cracked corner", r);
  assert.ok(q);
  assert.equal(q!.reviewId, "R1");
  assert.equal(q!.asin, "B000TEST01");
  assert.equal(q!.stars, 2);
  assert.equal(q!.reviewDate, "2026-07-11");
  assert.equal(q!.url, "https://www.amazon.com/dp/X#R1");
  assert.equal(q!.verified, true);
});

test("validateQuote không nhận câu của review KHÁC (dù tồn tại ở nơi khác)", () => {
  const rA = review({ id: "RA", body: "Handle broke on day two." });
  const rB = review({ id: "RB", body: "Rusted immediately in the sink." });
  assert.ok(validateQuote("handle broke on day two", rA));
  // rB không chứa câu đó → null
  assert.equal(validateQuote("handle broke on day two", rB), null);
});

/* ------------------------- validate observations ------------------------- */

test("observations sai review/sai cụm/câu bịa đều bị loại và đếm", () => {
  const reviews = [
    review({ id: "R1", body: "The coating peeled off after a week, terrible quality." }),
    review({ id: "R2", body: "Smaller than it looks in the photos, totally misleading size." }),
  ];
  const obs: PainObservation[] = [
    { reviewId: "R1", cluster: "quality", subLabel: null, painTitle: "Lớp phủ bong tróc", quote: "the coating peeled off after a week" },
    { reviewId: "R2", cluster: "expectation_gap", subLabel: null, painTitle: "Nhỏ hơn mô tả", quote: "smaller than it looks in the photos" },
    { reviewId: "R9", cluster: "quality", subLabel: null, painTitle: "Ma", quote: "ghost review" }, // không có review
    { reviewId: "R1", cluster: "quality", subLabel: null, painTitle: "Bịa", quote: "it electrocuted my dog" }, // câu bịa
  ];
  const { valid, dropped, quotesDropped } = validateObservations(obs, reviews);
  assert.equal(valid.length, 2);
  assert.equal(dropped, 2);
  assert.equal(quotesDropped, 1);
});

/* ------------------------------ reduce ------------------------------ */

function buildDataset(n: number, body: (i: number) => string, stars = 1) {
  const reviews: AnalysisReview[] = Array.from({ length: n }, (_, i) =>
    review({ id: `R${i}`, body: body(i), stars: (i % 3) + 1 <= stars ? (i % 3) + 1 : 2 }),
  );
  return reviews;
}

test("reduce: tần suất/độ nghiêm trọng/priority được TÍNH LẠI từ review, không tin LLM", () => {
  // 40 review, 12 review nhắc gỉ sét (cụm quality)
  const reviews: AnalysisReview[] = Array.from({ length: 40 }, (_, i) =>
    review({
      id: `R${i}`,
      stars: i < 12 ? 1 : 3,
      body: i < 12 ? `The metal rusted quickly on unit ${i}, very poor.` : `It is okay overall for unit ${i}, nothing special.`,
    }),
  );
  const observations: PainObservation[] = Array.from({ length: 12 }, (_, i) => ({
    reviewId: `R${i}`,
    cluster: "quality",
    subLabel: "gỉ sét",
    painTitle: "Khung inox gỉ sét",
    quote: "the metal rusted quickly",
  }));
  const drafts: PainItemDraft[] = [
    {
      itemKey: "rust-frame",
      cluster: "quality",
      title: "Khung/ vật liệu inox gỉ sét",
      subLabel: "gỉ sét",
      reviewIds: Array.from({ length: 12 }, (_, i) => `R${i}`),
      effortHint: 2,
      factoryRequirement: "Đổi sang inox 304, kiểm tra lớp mạ điện phân.",
      listingFix: null,
      testMethod: "Thử muối phun 48h",
      acceptanceStandard: "Không xuất hiện gỉ sau 48h thử muối",
      costImpactEstimate: "+$0.4/đơn",
    },
  ];
  const { analysis } = reducePainAnalysis({
    drafts,
    observations,
    reviews,
    narratives: { quality: "Nhiều khách phản ánh gỉ sét." },
    provider: "mock",
    model: "mock-1",
    generatedAt: "2026-09-16T00:00:00.000Z",
  });

  assert.equal(analysis.sampleSize, 40);
  const item = analysis.items.find((i) => i.itemKey === "rust-frame")!;
  assert.ok(item, "phải có pain item");
  assert.equal(item.frequency, 12);
  assert.equal(item.frequencyPct, 30); // 12/40
  assert.equal(item.avgStars, 1);
  assert.ok(item.severity >= 8, `severity cao vì 1★ + 30% mẫu, thực tế ${item.severity}`);
  assert.equal(item.priority, "must");
  assert.equal(item.quotes.length, 3);
  // quote đại diện phải truy được
  for (const q of item.quotes) {
    assert.ok(q.asin && q.stars !== null && q.reviewDate && q.url);
    assert.ok(reviews.some((r) => r.sourceReviewId === q.reviewId));
  }
  const cluster = analysis.clusters.find((c) => c.code === "quality")!;
  assert.equal(cluster.sharePct, 30);
  assert.equal(cluster.narrative, "Nhiều khách phản ánh gỉ sét.");
  // spec sheet gắn nhãn llm_suggested
  const spec = analysis.specs.find((s) => s.itemKey === "rust-frame")!;
  assert.equal(spec.source, "llm_suggested");
  assert.equal(spec.requirement, drafts[0].factoryRequirement);
});

test("reduce: draft LLM khai báo reviewIds KHÔNG khớp cụm/không có quote → bị loại bỏ", () => {
  const reviews = buildDataset(20, (i) =>
    i < 5 ? "Package arrived torn and items were missing." : `average product number ${i}`,
  );
  const observations: PainObservation[] = Array.from({ length: 5 }, (_, i) => ({
    reviewId: `R${i}`,
    cluster: "logistics",
    subLabel: null,
    painTitle: "Thiếu hàng khi giao",
    quote: "package arrived torn",
  }));
  const drafts: PainItemDraft[] = [
    {
      itemKey: "phantom",
      cluster: "logistics",
      title: "Pain ma LLM khai khống",
      subLabel: null,
      reviewIds: ["R10", "R11", "R12"], // các review này không có quan sát hợp lệ
      effortHint: null,
      factoryRequirement: null,
      listingFix: "cập nhật ảnh",
      testMethod: null,
      acceptanceStandard: null,
      costImpactEstimate: null,
    },
  ];
  const { analysis } = reducePainAnalysis({ drafts, observations, reviews, provider: "openai", model: "gpt-x" });
  assert.equal(analysis.items.length, 0, "pain không có chứng cứ phải bị loại");
});

test("reduce: quote trùng lặp giữa các observation không nhân đôi", () => {
  const reviews = [review({ id: "R1", body: "It broke after one use, very flimsy." })];
  const obs: PainObservation[] = [
    { reviewId: "R1", cluster: "quality", subLabel: null, painTitle: "Dễ gãy", quote: "it broke after one use" },
    { reviewId: "R1", cluster: "quality", subLabel: null, painTitle: "Dễ gãy", quote: "it broke after one use" },
  ];
  const drafts: PainItemDraft[] = [
    { itemKey: "brittle", cluster: "quality", title: "Vật liệu giòn", subLabel: null, reviewIds: ["R1"], effortHint: null, factoryRequirement: null, listingFix: null, testMethod: null, acceptanceStandard: null, costImpactEstimate: null },
  ];
  const { analysis } = reducePainAnalysis({ drafts, observations: obs, reviews, provider: "mock", model: "m" });
  assert.equal(analysis.items[0]?.quotes.length, 1);
  assert.equal(analysis.items[0]?.frequency, 1);
});

/* ---------------------- trụ differentiation ---------------------- */

test("differentiation: chưa đủ 30 review → null 'chưa đủ cơ sở'", () => {
  const reviews = buildDataset(10, () => "rusted and broke.");
  const { analysis } = reducePainAnalysis({
    drafts: [],
    observations: [],
    reviews,
    provider: "mock",
    model: "m",
  });
  const d = scoreDifferentiation(analysis);
  assert.equal(d.score, null);
  assert.ok(d.reason.includes(String(MIN_REVIEWS_FOR_DIFFERENTIATION)));
});

test("differentiation: đủ mẫu + pain nặng khả thi → điểm cao; pain chỉ sửa listing nhẹ → điểm thấp hơn", () => {
  const heavy = reducePainAnalysis({
    drafts: [
      {
        itemKey: "rust", cluster: "quality", title: "Gỉ sét", subLabel: null,
        reviewIds: Array.from({ length: 20 }, (_, i) => `R${i}`),
        effortHint: 3, factoryRequirement: "đổi vật liệu inox 304, khuôn mới", listingFix: null,
        testMethod: "salt spray", acceptanceStandard: "48h không gỉ", costImpactEstimate: null,
      },
    ],
    observations: Array.from({ length: 20 }, (_, i) => ({
      reviewId: `R${i}`, cluster: "quality" as const, subLabel: null, painTitle: "Gỉ sét",
      quote: "the metal rusted quickly",
    })),
    reviews: Array.from({ length: 100 }, (_, i) =>
      review({ id: `R${i}`, stars: i < 20 ? 1 : 3, body: i < 20 ? "The metal rusted quickly in days." : `fine unit ${i}` }),
    ),
    provider: "mock", model: "m",
  }).analysis;
  const heavyScore = scoreDifferentiation(heavy);
  assert.ok(heavyScore.score !== null && heavyScore.score >= 7, JSON.stringify(heavyScore));

  const light = reducePainAnalysis({
    drafts: [
      {
        itemKey: "size", cluster: "expectation_gap", title: "Tưởng to hơn", subLabel: null,
        reviewIds: Array.from({ length: 6 }, (_, i) => `R${i}`),
        effortHint: 1, factoryRequirement: null, listingFix: "ghi kích thước rõ hơn",
        testMethod: null, acceptanceStandard: null, costImpactEstimate: null,
      },
    ],
    observations: Array.from({ length: 6 }, (_, i) => ({
      reviewId: `R${i}`, cluster: "expectation_gap" as const, subLabel: null, painTitle: "Tưởng to hơn",
      quote: "smaller than the photos show",
    })),
    reviews: Array.from({ length: 100 }, (_, i) =>
      review({ id: `R${i}`, stars: i < 6 ? 2 : 4, body: i < 6 ? "Smaller than the photos show honestly." : `good ${i}` }),
    ),
    provider: "mock", model: "m",
  }).analysis;
  const lightScore = scoreDifferentiation(light);
  assert.ok(lightScore.score !== null);
  assert.ok(lightScore.score < heavyScore.score!, `${lightScore.score} < ${heavyScore.score}`);
});

/* --------------------------- trụ demand --------------------------- */

test("demand: không tín hiệu → null; đơn/tháng cao chạm thang điểm công khai", () => {
  assert.equal(scoreDemand({ medianUnitsMonth: null, medianRatingsTotal: null, reviewVelocityMonth: null, unitsSampleSize: 0 }).score, null);
  assert.equal(scoreDemand({ medianUnitsMonth: 12000, medianRatingsTotal: null, reviewVelocityMonth: null, unitsSampleSize: 12 }).score, 10);
  assert.equal(scoreDemand({ medianUnitsMonth: 800, medianRatingsTotal: null, reviewVelocityMonth: null, unitsSampleSize: 6 }).score, 3);
  // chỉ velocity → điểm nhưng confidence thấp
  const v = scoreDemand({ medianUnitsMonth: null, medianRatingsTotal: null, reviewVelocityMonth: 200, unitsSampleSize: 0 });
  assert.ok(v.score !== null && v.confidence === "low");
  // <5 ASIN có sales → không dùng đơn/tháng
  assert.equal(scoreDemand({ medianUnitsMonth: 12000, medianRatingsTotal: null, reviewVelocityMonth: null, unitsSampleSize: 3 }).score, null);
});

test("đủ 3 mã cụm và nhãn tiếng Việt theo hợp đồng", () => {
  assert.deepEqual(PAIN_CLUSTER_ORDER, ["quality", "expectation_gap", "logistics"]);
});
