/**
 * Module 8 G4 — tín hiệu trụ DEMAND từ snapshot G2/G3 (KHÔNG gọi LLM):
 *   • trung vị ước lượng đơn/tháng (sales_estimation Rainforest, sai số 20–40%)
 *   • velocity review từ 2 mốc ratings_total (xem concentration.ts)
 *
 * Logic điểm nằm trọn ở pain.scoreDemand; file này chỉ dựng DemandSignals từ
 * dữ liệu thu thập để worker gọi qua 1 hàm.
 */

import {
  computeReviewVelocity,
  type VelocityResult,
  type VelocitySnapshot,
} from "./concentration.ts";
import type { CompetitorRow } from "./collection.ts";
import { median, scoreDemand, type DemandSignals, type G4PillarScores } from "./pain.ts";

/** Chọn các hàng organic có ước lượng đơn để tính trung vị thị trường. */
export function medianUnitsMonth(products: CompetitorRow[]): {
  median: number | null;
  sampleSize: number;
} {
  const units = products
    .filter((r) => !r.isSponsored)
    .map((r) => (typeof r.estUnitsMonth === "number" ? r.estUnitsMonth : null))
    .filter((u): u is number => typeof u === "number" && Number.isFinite(u) && u > 0)
    .sort((a, b) => a - b);
  if (!units.length) return { median: null, sampleSize: 0 };
  return { median: median(units), sampleSize: units.length };
}

/**
 * Dựng tín hiệu demand.
 * @param products  snapshot products/sales mới nhất (có estUnitsMonth)
 * @param snapshots cặp mốc ratings (cũ → mới) để tính velocity; thiếu thì null
 */
export function buildDemandSignals(
  products: CompetitorRow[],
  snapshots?: { prev: VelocitySnapshot[]; current: VelocitySnapshot[] } | null,
): DemandSignals {
  const { median: med, sampleSize } = medianUnitsMonth(products);
  const organic = products.filter((r) => !r.isSponsored);
  const ratingsMedian = median(
    organic
      .map((r) => (typeof r.ratingsTotal === "number" ? r.ratingsTotal : null))
      .filter((v): v is number => typeof v === "number" && v > 0),
  );
  let velocity: VelocityResult | null = null;
  if (snapshots && snapshots.prev.length && snapshots.current.length) {
    velocity = computeReviewVelocity(snapshots.prev, snapshots.current);
  }
  return {
    medianUnitsMonth: med,
    medianRatingsTotal: ratingsMedian,
    unitsSampleSize: sampleSize,
    reviewVelocityMonth:
      velocity?.reviewsPerDay !== null && velocity?.reviewsPerDay !== undefined
        ? Math.round(velocity.reviewsPerDay * 30)
        : null,
  };
}

export function scoreDemandFromSnapshots(
  products: CompetitorRow[],
  snapshots?: { prev: VelocitySnapshot[]; current: VelocitySnapshot[] } | null,
): G4PillarScores["demand"] {
  return scoreDemand(buildDemandSignals(products, snapshots));
}
