/**
 * Module 8 G7 — test engine mùa vụ BSR + velocity N mốc + parser Keepa.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeSeasonality,
  keepaMinutesToDate,
  parseKeepaSalesRankCsv,
  restockAdvice,
  reviewVelocityFromSnapshots,
  summarizeBsr,
  type BsrPoint,
} from "../src/lib/research/domain/seasonality.ts";

/** Sinh chuỗi BSR nhân tạo: 24 tháng, đỉnh bán (rank thấp) vào tháng 11. */
function syntheticSeries(now: Date, years = 2, pointsPerMonth = 2): BsrPoint[] {
  const out: BsrPoint[] = [];
  for (let y = 0; y < years; y++) {
    for (let m = 0; m < 12; m++) {
      for (let k = 0; k < pointsPerMonth; k++) {
        const day = 1 + k * 14;
        const t = new Date(Date.UTC(now.getUTCFullYear() - (years - y), m, day));
        if (t > now) continue;
        // rank nền 10.000; tháng 10-11 rank 3.000 (bán chạy gấp ~3)
        const seasonal = m === 10 || m === 9 ? 3_000 : m === 0 ? 11_500 : 10_000;
        out.push({ asin: "B0G5001", observedAt: t.toISOString(), bsrRank: seasonal, source: "rainforest" });
      }
    }
  }
  return out;
}

test("summarizeBsr: slope âm = rank tốt lên, median theo cửa sổ thời gian", () => {
  const now = new Date("2026-09-16T00:00:00Z");
  const pts: BsrPoint[] = [
    { asin: "A", observedAt: "2026-08-01T00:00:00Z", bsrRank: 20_000, source: "rainforest" },
    { asin: "A", observedAt: "2026-08-16T00:00:00Z", bsrRank: 15_000, source: "rainforest" },
    { asin: "A", observedAt: "2026-09-01T00:00:00Z", bsrRank: 10_000, source: "rainforest" },
    { asin: "A", observedAt: "2025-01-01T00:00:00Z", bsrRank: 90_000, source: "keepa" },
  ];
  const t = summarizeBsr(pts, now);
  assert.equal(t.points, 4);
  assert.equal(t.latestBsr, 10_000);
  assert.equal(t.medianBsr30d, 10_000);
  assert.ok(t.slopePerDay !== null && t.slopePerDay < 0, "slope phải âm");
  assert.ok((t.r2 ?? 0) > 0.9);
});

test("mùa vụ: thiếu điểm (<12) → chưa đủ cơ sở (null)", () => {
  const now = new Date("2026-09-16T00:00:00Z");
  const pts: BsrPoint[] = Array.from({ length: 6 }, (_, i) => ({
    asin: "A",
    observedAt: new Date(Date.UTC(2026, 8, 1 + i * 3)).toISOString(),
    bsrRank: 10_000 + i,
    source: "rainforest" as const,
  }));
  assert.equal(computeSeasonality(pts, now), null);
});

test("mùa vụ: chuỗi 2 năm có đỉnh tháng 10-11 → phát hiện đúng, ratio <0.75", () => {
  const now = new Date("2026-09-16T00:00:00Z");
  const sea = computeSeasonality(syntheticSeries(now, 2, 3), now);
  assert.ok(sea);
  assert.ok(sea.peakMonth === 10 || sea.peakMonth === 11, `đỉnh phải rơi tháng 10/11, nhận ${sea?.peakMonth}`);
  assert.ok(sea.troughMonth === 1);
  assert.ok((sea.peakTroughRatio ?? 1) < 0.75);
  assert.equal(sea.confidence, "high");
  assert.equal(sea.yearsCovered, 2);
});

test("restockAdvice: đỉnh tháng 11, lead 8 tuần → phải đặt hàng khoảng tháng 9", () => {
  const now = new Date("2026-09-16T00:00:00Z");
  const adv = restockAdvice(syntheticSeries(now, 2, 3), { leadWeeks: 8, now });
  assert.ok(adv);
  // 15/11 lùi 56 ngày ≈ 20/9
  assert.ok([8, 9, 10].includes(adv.orderByMonth), `nhận tháng ${adv.orderByMonth}`);
});

test("restockAdvice: biên độ mùa vụ <25% → không canh lịch (null)", () => {
  const now = new Date("2026-09-16T00:00:00Z");
  const flat = syntheticSeries(now, 2, 3).map((p) => ({ ...p, bsrRank: 10_000 + (p.bsrRank! % 50) }));
  assert.equal(restockAdvice(flat, { now }), null);
});

test("velocity: hồi quy N mốc ratings_total tăng đều, loại điểm nhiễu giảm", () => {
  const snaps = [
    { asin: "A", observedAt: "2026-08-01T00:00:00Z", ratingsTotal: 100 },
    { asin: "A", observedAt: "2026-08-11T00:00:00Z", ratingsTotal: 98 }, // nhiễu giảm → bị dồn max
    { asin: "A", observedAt: "2026-08-21T00:00:00Z", ratingsTotal: 120 },
    { asin: "A", observedAt: "2026-09-01T00:00:00Z", ratingsTotal: 131 },
  ];
  const v = reviewVelocityFromSnapshots(snaps);
  assert.equal(v.points, 4);
  assert.ok(v.reviewsPerDay !== null);
  // (131-100)/31 ngày ≈ 1/ngày
  assert.ok(Math.abs(v.reviewsPerDay - 1) < 0.15, `nhận ${v.reviewsPerDay}`);
  assert.ok((v.reviewsPerMonth ?? 0) > 25);
});

test("velocity: 1 điểm duy nhất → null + chưa đủ cơ sở", () => {
  const v = reviewVelocityFromSnapshots([
    { asin: "A", observedAt: "2026-09-01Z", ratingsTotal: 50 },
  ]);
  assert.equal(v.reviewsPerDay, null);
  assert.equal(v.confidence, null);
});

test("Keepa parser: phút kể 2011, -1 = không dữ liệu, dẹt [time,value,…]", () => {
  const d0 = keepaMinutesToDate(0);
  assert.equal(d0.toISOString(), "2011-01-01T00:00:00.000Z");
  const oneYearMin = Math.floor((Date.UTC(2012, 0, 1) - Date.UTC(2011, 0, 1)) / 60_000);
  const pts = parseKeepaSalesRankCsv([0, 5_000, oneYearMin, -1], "B0K1");
  assert.equal(pts.length, 2);
  assert.equal(pts[0].bsrRank, 5_000);
  assert.equal(pts[0].source, "keepa");
  assert.equal(pts[1].bsrRank, null, "-1 phải thành null");
  assert.equal(parseKeepaSalesRankCsv(null, "A").length, 0);
});
