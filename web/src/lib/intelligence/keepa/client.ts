/**
 * Module 8 G7 — client Keepa thật (lịch sử BSR backfill).
 * Tài liệu: https://keepa.gitbook.io/keepa-api/
 *  - GET https://api.keepa.com/product?key=..&domain=1&asin=A,B&stats=1
 *  - products[].csv[3] = mảng sales rank dẹt [time(Keepa minutes), rank, …]
 *  - rank = -1 nghĩa là không có dữ liệu.
 *
 * LƯU Ý: chưa kiểm chứng live (cần KEEPA_API_KEY trả phí); format bám đúng
 * docs. Mọi điểm đi qua parseKeepaSalesRankCsv rồi mới tới engine mùa vụ.
 */

import { parseKeepaSalesRankCsv } from "../../research/domain/seasonality.ts";
import { KEEPA_DOMAINS, type BsrHistoryProvider, type BsrHistoryQuery } from "./types.ts";

export type KeepaClientOptions = {
  apiKey: string;
  baseUrl?: string;
};

export class KeepaClient implements BsrHistoryProvider {
  readonly name = "keepa";
  readonly configured = true;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: KeepaClientOptions) {
    if (!opts.apiKey) throw new Error("Thiếu KEEPA_API_KEY");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.keepa.com").replace(/\/$/, "");
  }

  async fetchBsrHistory(query: BsrHistoryQuery): Promise<{ points: import("../../research/domain/seasonality.ts").BsrPoint[]; asinsFound: number }> {
    const domain = KEEPA_DOMAINS[(query.marketplace ?? "US").toUpperCase()] ?? KEEPA_DOMAINS.US;
    // Keepa giới hạn ~100 ASIN/request; chia lô an toàn 50.
    const batches: string[][] = [];
    for (let i = 0; i < query.asins.length; i += 50) batches.push(query.asins.slice(i, i + 50));

    const all: import("../../research/domain/seasonality.ts").BsrPoint[] = [];
    let found = 0;
    for (const batch of batches) {
      const url =
        `${this.baseUrl}/product?key=${encodeURIComponent(this.apiKey)}` +
        `&domain=${domain.id}&asin=${batch.join(",")}&stats=1&buybox=0&offers=0`;
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) {
        throw new Error(`Keepa HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const body = (await res.json()) as { products?: ({ asin: string; csv?: number[][] } | null)[] };
      for (const p of body.products ?? []) {
        if (!p?.asin || !Array.isArray(p.csv)) continue;
        const csv = p.csv[3];
        if (!Array.isArray(csv) || csv.length < 2) continue;
        const points = parseKeepaSalesRankCsv(csv, p.asin).filter(
          (pt) =>
            pt.bsrRank !== null &&
            (query.sinceDays === undefined ||
              Date.now() - new Date(pt.observedAt).getTime() <= (query.sinceDays ?? 365) * 86_400_000),
        );
        all.push(...points);
        found++;
      }
    }
    return { points: all, asinsFound: found };
  }
}
