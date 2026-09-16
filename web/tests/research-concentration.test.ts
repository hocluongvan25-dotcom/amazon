/**
 * Module 8 G3 — test engine tập trung thị phần (CR3/CR5/HHI, gộp variation,
 * Amazon 1P, sponsored density, review velocity).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeConcentration,
  computeReviewVelocity,
  mergeCompetitorSnapshots,
  rollUpVariations,
  scoreCompetition,
  type CompetitorInput,
} from "../src/lib/research/domain/concentration.ts";

function row(over: Partial<CompetitorInput> & { asin: string; position: number }): CompetitorInput {
  return {
    isSponsored: false,
    isAmazon1p: false,
    ...over,
  };
}

test("rollUpVariations: cùng parent gộp 1 sản phẩm, sales lấy MAX chứ không cộng", () => {
  const rows = [
    row({ asin: "A1", parentAsin: "P1", position: 2, estUnitsMonth: 900, brand: "B" }),
    row({ asin: "A2", parentAsin: "P1", position: 5, estUnitsMonth: 1200, brand: "B" }),
    row({ asin: "A3", position: 8, estUnitsMonth: 500, brand: "C" }),
    row({ asin: "S1", position: 1, isSponsored: true }),
  ];
  const out = rollUpVariations(rows);
  assert.equal(out.length, 2, "sponsored bị loại, variation gộp còn 2");
  const p1 = out.find((r) => (r.parentAsin ?? r.asin) === "P1");
  assert.equal(p1?.estUnitsMonth, 1200);
  assert.equal(p1?.position, 2);
});

test("analyzeConcentration: CR3/CR5/HHI tính theo revenue và sắp xếp brand giảm dần", () => {
  const brands: Array<[string, number]> = [
    ["Alpha", 70_000], // 70%
    ["Beta", 20_000], // 20%
    ["Gamma", 8_000], // 8%
    ["Delta", 1_500],
    ["Echo", 500],
  ];
  const rows: CompetitorInput[] = [];
  let pos = 1;
  for (const [brand, units] of brands) {
    // mỗi brand 2-3 sản phẩm để đủ 12 organic, tổng revenue thuộc brand
    for (let k = 0; k < 3; k++) {
      const share = [0.5, 0.3, 0.2][k];
      rows.push(
        row({
          asin: `${brand[0]}${pos}`,
          position: pos,
          brand,
          estRevenueMonth: Math.round(units * share),
          estUnitsMonth: Math.round(units * share / 30),
          rating: 4 + (k % 2) * 0.3,
        }),
      );
      pos++;
    }
  }
  // thêm 2 sponsored để đủ hiện diện quảng cáo
  rows.push(row({ asin: "SP1", position: 1, isSponsored: true, brand: "Alpha" }));
  rows.push(row({ asin: "SP2", position: 2, isSponsored: true, brand: "Beta" }));

  const c = analyzeConcentration(rows);
  assert.equal(c.sufficientData, true);
  assert.equal(c.metric, "revenue");
  assert.equal(c.organicCount, 15);
  assert.equal(c.sponsoredCount, 2);
  assert.equal(c.cr3Pct, 98);
  assert.equal(c.cr5Pct, 100);
  // HHI = 70²+20²+8²+1.5²+0.5² = 4900+400+64+2.25+0.25 = 5366.5 → 5366/5367
  assert.ok(Math.abs((c.hhi ?? 0) - 5367) <= 1, `HHI ${c.hhi}`);
  assert.equal(c.brands[0].brand, "Alpha");
  assert.equal(c.brands[0].revenueSharePct, 70);
  assert.ok((c.sponsoredSharePct ?? 0) > 10);
  assert.ok(c.avgRating !== null);
});

test("analyzeConcentration: thiếu sales estimate → không chấm CR (chưa đủ cơ sở)", () => {
  const rows = Array.from({ length: 12 }, (_, i) =>
    row({ asin: `X${i}`, position: i + 1, brand: i % 2 ? "P" : "Q", rating: 4.2 }),
  );
  const c = analyzeConcentration(rows);
  assert.equal(c.sufficientData, false);
  assert.equal(c.cr3Pct, null);
  assert.equal(c.hhi, null);
  assert.ok(c.notes.join(" ").includes("sales estimate"));
});

test("analyzeConcentration: dưới 10 organic → chưa đủ cơ sở", () => {
  const rows = Array.from({ length: 6 }, (_, i) =>
    row({ asin: `Y${i}`, position: i + 1, brand: "Z", estRevenueMonth: 1000 }),
  );
  const c = analyzeConcentration(rows);
  assert.equal(c.sufficientData, false);
  assert.ok(c.notes[0].includes("≥ 10"));
});

test("scoreCompetition: CR3 70% + Amazon top3 → 2 veto đỏ, điểm trần 3", () => {
  const rows: CompetitorInput[] = [];
  const spec: Array<[string, number, boolean?]> = [
    ["Amazon Basics", 60_000, true],
    ["Alpha", 20_000],
    ["Beta", 10_000],
    ["Gamma", 5_000],
    ["Delta", 3_000],
    ["Echo", 2_000],
  ];
  let pos = 1;
  for (const [brand, rev, oneP] of spec) {
    for (let k = 0; k < 2; k++) {
      rows.push(row({ asin: `${brand[0]}${pos}`, position: pos++, brand: brand as string, estRevenueMonth: Math.round(rev / 2), isAmazon1p: !!oneP && k === 0 }));
    }
  }
  const c = analyzeConcentration(rows);
  const s = scoreCompetition(c);
  assert.equal(c.cr3Pct, 90);
  assert.ok(c.amazon1p.inTop3);
  assert.equal(s.vetoes.length, 2);
  assert.deepEqual(s.vetoes.map((v) => v.code).sort(), ["amazon1p_top3", "cr3_above_65"]);
  assert.ok((s.pillar.score ?? 99) <= 3);
});

test("scoreCompetition: ngách phân tán, không 1P → điểm cao, không veto", () => {
  const brands = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const rows: CompetitorInput[] = [];
  let pos = 1;
  brands.forEach((b, bi) => {
    for (let k = 0; k < 2; k++) {
      rows.push(row({ asin: `${b}${k}`, position: pos++, brand: b, estRevenueMonth: 10_000, estUnitsMonth: 330 }));
    }
  });
  const c = analyzeConcentration(rows);
  const s = scoreCompetition(c);
  assert.ok((c.cr3Pct ?? 100) < 40, `CR3 ${c.cr3Pct}`);
  assert.equal(s.vetoes.length, 0);
  assert.ok((s.pillar.score ?? 0) >= 9);
});

test("scoreCompetition: chưa đủ dữ liệu trả trụ null, không sinh veto", () => {
  const c = analyzeConcentration([row({ asin: "Z1", position: 1 })]);
  const s = scoreCompetition(c);
  assert.equal(s.pillar.score, null);
  assert.equal(s.vetoes.length, 0);
});

test("mergeCompetitorSnapshots: giữ vị trí/sponsored từ SERP, đắp sales/1P từ products", () => {
  const serp = [
    row({ asin: "A1", parentAsin: null, position: 1, brand: "Alpha", estRevenueMonth: null, isAmazon1p: false }),
    row({ asin: "A2", position: 2, brand: "Alpha", estRevenueMonth: null }),
  ];
  const products = [
    row({ asin: "a1", position: 0, parentAsin: "P1", estRevenueMonth: 9000, isAmazon1p: true, ratingsTotal: 100 }),
    row({ asin: "A2", position: 0, parentAsin: "P2", estRevenueMonth: 3000, ratingsTotal: 50 }),
    row({ asin: "NEW", position: 0, estRevenueMonth: 100 }),
  ];
  const out = mergeCompetitorSnapshots(serp, products);
  const a1 = out.find((r) => r.asin === "A1")!;
  assert.equal(a1.position, 1, "giữ vị trí SERP");
  assert.equal(a1.estRevenueMonth, 9000);
  assert.equal(a1.isAmazon1p, true);
  assert.equal(a1.parentAsin, "P1");
  assert.ok(out.some((r) => r.asin === "NEW"), "sản phẩm chỉ có ở products vẫn được giữ");
});

test("computeReviewVelocity: cần ≥3 ASIN có 2 mốc, tính review/ngày", () => {
  const prev = [
    { asin: "A", date: "2026-08-01", ratingsTotal: 100 },
    { asin: "B", date: "2026-08-01", ratingsTotal: 200 },
    { asin: "C", date: "2026-08-01", ratingsTotal: 50 },
  ];
  const current = [
    { asin: "A", date: "2026-08-31", ratingsTotal: 130 }, // +30/30 ngày
    { asin: "B", date: "2026-08-31", ratingsTotal: 260 }, // +60/30
    { asin: "C", date: "2026-08-31", ratingsTotal: 50 }, // 0
  ];
  const v = computeReviewVelocity(prev, current);
  assert.equal(v.sufficientData, true);
  assert.equal(v.perAsin.find((x) => x.asin === "A")?.reviewsPerDay, 1);
  assert.equal(v.perAsin.find((x) => x.asin === "B")?.reviewsPerDay, 2);
  assert.equal(v.reviewsPerDay, 1); // 90/90 ngày
});

test("computeReviewVelocity: mới 1 mốc (snapshot đầu) → null đúng quy tắc", () => {
  const v = computeReviewVelocity([], [
    { asin: "A", date: "2026-09-01", ratingsTotal: 10 },
    { asin: "B", date: "2026-09-01", ratingsTotal: 20 },
  ]);
  assert.equal(v.sufficientData, false);
  assert.equal(v.reviewsPerDay, null);
});
