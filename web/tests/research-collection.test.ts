/**
 * Module 8 G2 — test parser thuần collection + provider mock.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseDimensions,
  parseProductBundle,
  parseReviewsPage,
  parseSearchPage,
  summarizeCompetitors,
} from "../src/lib/research/domain/collection.ts";
import { MockIntelligenceProvider } from "../src/lib/intelligence/mock-intelligence.ts";

test("parseSearchPage: tách sponsored/organic và vị trí organic đánh liên tục", () => {
  const json = {
    search_results: [
      { position: 1, asin: "B0A", title: "Quảng cáo A", brand: "AdCo", is_sponsored: true, price: { value: 19.99, currency: "USD" }, rating: 4.2, ratings_total: 100 },
      { position: 2, asin: "B0B", title: "Tự nhiên B", brand: "OrgCo", is_sponsored: false, price: { value: 29.99, currency: "USD" }, rating: 4.5, ratings_total: 2000 },
      { position: 3, asin: "B0C", is_sponsored: false, price: { value: 9.99 } },
      { position: 4 /* thiếu asin → loại */, title: "quảng cáo không ASIN" },
    ],
    pagination: { current_page: 1, total_pages: 2, total_results: 60 },
  };
  const out = parseSearchPage(json);
  assert.equal(out.sponsored.length, 1);
  assert.equal(out.organic.length, 2);
  assert.equal(out.organic[0].asin, "B0B");
  assert.equal(out.organic[0].position, 1); // vị trí organic được đánh lại
  assert.equal(out.organic[0].brand, "OrgCo");
  assert.equal(out.sponsored[0].isSponsored, true);
  assert.equal(out.totalResults, 60);
  // thiếu currency vẫn mặc định USD, không nổ
  assert.equal(out.organic[1].currency, "USD");
});

test("parseProductBundle: gộp product + offers + sales, nhận diện Amazon 1P", () => {
  const bundle = {
    product: {
      product: {
        asin: "B0B",
        parent_asin: "B0PARENT",
        brand: "OrgCo",
        rating: 4.4,
        ratings_total: 5000,
        bestseller_rank: { rank: 412, category: "Kitchen" },
        variations: [{ asin: "B0B" }, { asin: "B0B2" }],
        dimensions_object: { length: 10, width: 6, height: 0.5, unit: "inches", weight: 0.75, weight_unit: "pounds" },
      },
    },
    offers: {
      offers: [
        { is_buybox_winner: false, sold_by: { name: "Reseller" } },
        { is_buybox_winner: true, sold_by: { name: "Amazon.com" } },
      ],
    },
    sales: {
      sales_estimation: { est_monthly_units: 9100, est_monthly_revenue: { value: 272909 } },
    },
  };
  const patch = parseProductBundle(bundle);
  assert.equal(patch.parentAsin, "B0PARENT");
  assert.equal(patch.bsrRank, 412);
  assert.equal(patch.variationCount, 2);
  assert.equal(patch.buyboxSeller, "Amazon.com");
  assert.equal(patch.isAmazon1p, true);
  assert.equal(patch.estUnitsMonth, 9100);
  assert.equal(patch.estRevenueMonth, 272909);
  assert.deepEqual([patch.lengthIn, patch.widthIn, patch.heightIn, patch.weightLb], [10, 6, 0.5, 0.75]);
});

test("parseProductBundle: seller bên thứ 3 thì không phải 1P", () => {
  const patch = parseProductBundle({
    product: { product: { asin: "X", buybox_winner: { sold_by: { name: "KitchenPro Direct" } } } },
  });
  assert.equal(patch.isAmazon1p, false);
});

test("parseDimensions: chuỗi inches + ounces và object cm/kg", () => {
  const a = parseDimensions("10 x 6 x 0.5 inches; 12 ounces");
  assert.deepEqual([a.lengthIn, a.widthIn, a.heightIn], [10, 6, 0.5]);
  assert.equal(a.weightLb, 0.75);
  const b = parseDimensions({ length: 25.4, width: 15.24, height: 1.27, unit: "cm", weight: 1, weight_unit: "kg" });
  assert.ok(Math.abs((b.lengthIn ?? 0) - 10) < 0.01);
  assert.ok(Math.abs((b.weightLb ?? 0) - 2.20462) < 0.01);
});

test("parseReviewsPage: chỉ giữ 1–3★, loại PII reviewer, parse ngày/ảnh/verified", () => {
  const json = {
    reviews: [
      { id: "R1", rating: 2, title: "Rỉ sét", body: "Rusted in weeks.", date: { utc: "2026-08-01T10:00:00Z" }, verified_purchase: true, helpful_votes: 12, photos: [{ link: "p1" }, { link: "p2" }], reviewer_name: "John D", link: "http://x/R1" },
      { id: "R2", rating: 5, title: "Tốt", body: "Love it.", date: { raw: "July 3, 2026" } },
      { id: "R3", rating: 1, title: "Vỡ", body: "Arrived broken.", date: { utc: "2026-07-15T00:00:00Z" }, verified_purchase: false, photos: [] },
      { rating: 2, body: "không có id → bỏ" },
    ],
    pagination: { current_page: 1, total_pages: 4, total_reviews: 40 },
  };
  const out = parseReviewsPage(json, "b0b");
  assert.equal(out.reviews.length, 2);
  assert.equal(out.skipped, 2); // 1 review 5★ + 1 thiếu id
  assert.equal(out.totalPages, 4);
  assert.equal(out.reviews[0].asin, "B0B");
  assert.equal(out.reviews[0].reviewDate, "2026-08-01");
  assert.equal(out.reviews[0].photosCount, 2);
  assert.equal(out.reviews[0].verified, true);
  // TUYỆT ĐỐI không có trường danh tính
  for (const r of out.reviews) {
    assert.equal("reviewerName" in r, false);
    assert.equal("reviewer_name" in r, false);
    assert.equal(JSON.stringify(r).includes("John"), false);
  }
});

test("summarizeCompetitors đếm sponsored/sales/bsr", () => {
  const rows = [
    { asin: "A", isSponsored: true, isAmazon1p: false, position: 1, currency: "USD" },
    { asin: "B", isSponsored: false, isAmazon1p: false, position: 1, currency: "USD", estUnitsMonth: 100 },
    { asin: "C", isSponsored: false, isAmazon1p: false, position: 2, currency: "USD", estUnitsMonth: 200, bsrRank: 3 },
  ];
  const s = summarizeCompetitors(rows as never[]);
  assert.deepEqual(s, { total: 3, sponsored: 1, withSalesEstimate: 2, withBsr: 1 });
});

test("MockIntelligenceProvider: deterministic, có sponsored/1P và review không PII", async () => {
  const p1 = new MockIntelligenceProvider();
  const p2 = new MockIntelligenceProvider();
  const s1 = parseSearchPage(await p1.search({ keyword: "kitchen shelf" }));
  const s2 = parseSearchPage(await p2.search({ keyword: "kitchen shelf" }));
  assert.equal(s1.organic.length + s1.sponsored.length, 26); // vũ trụ mock cố định 26 ASIN
  assert.ok(s1.sponsored.length >= 1, "phải có slot sponsored");
  assert.deepEqual(s1, s2, "2 instance phải cho kết quả y hệt (deterministic)");

  // Có brand Amazon 1P trong vũ trụ mock
  const productJson = await p1.product("B0MOCK015"); // Amazon Basics bắt đầu sau 14 slot (8+6)
  const offersJson = await p1.offers("B0MOCK015");
  const salesJson = await p1.salesEstimate({ asin: "B0MOCK015" });
  const patch = parseProductBundle({ product: productJson, offers: offersJson, sales: salesJson });
  assert.equal(patch.isAmazon1p, true);
  assert.ok((patch.estUnitsMonth ?? 0) > 0);

  // ASIN ngoài top 10 không có review → no_data path
  const empty = parseReviewsPage(await p1.reviews({ asin: "B0MOCK025" }), "B0MOCK025");
  assert.equal(empty.reviews.length, 0);

  // ASIN top có review nhiều trang, không kèm tên reviewer
  const r1 = parseReviewsPage(await p1.reviews({ asin: "B0MOCK001", page: 1 }), "B0MOCK001");
  const r2 = parseReviewsPage(await p1.reviews({ asin: "B0MOCK001", page: 2 }), "B0MOCK001");
  assert.ok(r1.reviews.length > 0 && r2.reviews.length > 0);
  const ids = new Set([...r1.reviews, ...r2.reviews].map((r) => r.sourceReviewId));
  assert.equal(ids.size, r1.reviews.length + r2.reviews.length, "id review không trùng giữa các trang");
  for (const r of [...r1.reviews, ...r2.reviews]) assert.equal("reviewer_name" in r, false);
});

test("MockIntelligenceProvider: createCollection + getCollection mô phỏng đủ 3 endpoint/ASIN", async () => {
  const p = new MockIntelligenceProvider();
  const { collectionId, credits } = await p.createCollection([
    { type: "product", asin: "B0MOCK001" },
    { type: "offers", asin: "B0MOCK001" },
    { type: "sales_estimation", asin: "B0MOCK001" },
  ]);
  assert.equal(credits, 3);
  const result = await p.getCollection(collectionId);
  assert.equal((result as { results: unknown[] }).results.length, 3);
});
