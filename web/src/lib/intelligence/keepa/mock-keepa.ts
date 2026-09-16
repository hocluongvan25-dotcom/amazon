/**
 * Module 8 G7 — Keepa GIẢ (không cần key): sinh chuỗi BSR tất định để test
 * engine mùa vụ end-to-end. Dạng mùa: nền 10.000, bán chạy (~3.000) quanh
 * tháng 10–11 (mùa quà/lễ), chững lại (~12.000) tháng 1–2.
 */

import type { BsrPoint } from "../../research/domain/seasonality.ts";
import type { BsrHistoryProvider, BsrHistoryQuery } from "./types.ts";

export class MockKeepaProvider implements BsrHistoryProvider {
  readonly name = "mock-keepa";
  readonly configured = false;

  async fetchBsrHistory(query: BsrHistoryQuery): Promise<{ points: BsrPoint[]; asinsFound: number }> {
    const sinceDays = query.sinceDays ?? 365;
    const now = Date.now();
    const points: BsrPoint[] = [];

    for (const asin of query.asins) {
      // mẫu 7 ngày/lần
      for (let d = sinceDays; d >= 0; d -= 7) {
        const t = new Date(now - d * 86_400_000);
        const m = t.getUTCMonth();
        let base = 10_000;
        if (m === 9 || m === 10) base = 3_200; // peak
        else if (m === 0 || m === 1) base = 11_800; // trough
        // tất định theo ASIN+ngày, dao động ±6%
        const seed = (asin.charCodeAt(asin.length - 1) + d) % 13;
        const jitter = 1 + (seed - 6) * 0.01;
        points.push({
          asin,
          observedAt: t.toISOString(),
          bsrRank: Math.round(base * jitter),
          source: "keepa",
        });
      }
    }
    return { points, asinsFound: query.asins.length };
  }
}
