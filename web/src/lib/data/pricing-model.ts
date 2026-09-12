/**
 * Data model cho Module 2 (Giá & Featured Offer) — đọc từ Supabase vexim_pricing.
 */

import type { PricingRow, BoxStatus } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Raw shape từ Supabase view                                         */
/* ------------------------------------------------------------------ */

export type PricingRaw = {
  id: string;
  seller_account_id: string;
  shop: string;
  sku: string;
  asin: string | null;
  title: string | null;
  our_price: number | null;
  currency: string | null;
  updated_at: string;
  buy_box_won: boolean | null;
  buy_box_price: number | null;
  competitor_price: number | null;
  offer_captured_at: string | null;
  referral_fee: number | null;
  fba_fee: number | null;
  total_fees: number | null;
  fees_estimated_at: string | null;
};

/* ------------------------------------------------------------------ */
/* Select strings                                                      */
/* ------------------------------------------------------------------ */

export const PRICING_SELECT =
  "id,seller_account_id,shop,sku,asin,title,our_price,currency,updated_at,buy_box_won,buy_box_price,competitor_price,offer_captured_at,referral_fee,fba_fee,total_fees,fees_estimated_at";

/* ------------------------------------------------------------------ */
/* Mapping                                                             */
/* ------------------------------------------------------------------ */

function determineBoxStatus(
  buyBoxWon: boolean | null,
  ourPrice: number | null,
  competitorPrice: number | null,
): BoxStatus {
  if (buyBoxWon === null) return "no_box";
  if (buyBoxWon) return "holding";
  // Có offer nhưng không giữ box
  if (ourPrice !== null && competitorPrice !== null && ourPrice > competitorPrice * 1.05) {
    return "lost";
  }
  return "at_risk";
}

function boxStatusLabel(status: BoxStatus): string {
  switch (status) {
    case "holding": return "Đang giữ box";
    case "at_risk": return "Sắp mất";
    case "lost": return "Mất box";
    case "no_box": return "Không có offer";
  }
}

/** Map 1 dòng vexim_pricing → PricingRow cho UI (P1) */
export function mapPricingRow(raw: PricingRaw): PricingRow {
  const ourPrice = raw.our_price ?? 0;
  const totalFees = raw.total_fees ?? 0;
  const floorPrice = totalFees > 0 ? totalFees : 0; // floor ≈ fees (thiếu COGS)
  const currentMargin = ourPrice > 0 ? ((ourPrice - floorPrice) / ourPrice) * 100 : 0;
  const marginTone: PricingRow["marginTone"] =
    currentMargin < 0 ? "red" : currentMargin < 10 ? "amber" : "green";

  const boxStatus = determineBoxStatus(raw.buy_box_won, raw.our_price, raw.competitor_price);

  // FOEP: chưa có trong DB → null
  // velocity30d: chưa có trong listings view → 0

  return {
    sku: raw.sku,
    asin: raw.asin ?? "—",
    shop: raw.shop,
    title: raw.title ?? "—",
    ourPrice,
    currency: raw.currency ?? "USD",
    foep: null, // chưa có FOEP data trong DB
    foepDelta: null,
    referencePrice: raw.competitor_price,
    floorPrice,
    currentMargin,
    marginTone,
    boxStatus,
    competitorCount: 0, // chưa có trong DB
    velocity30d: 0, // chưa có trong DB
    lastPriceChange: timeAgoShort(raw.updated_at),
    owner: "—", // chưa có RBAC join
  };
}

function timeAgoShort(updatedAt: string): string {
  const now = new Date();
  const updated = new Date(updatedAt);
  const diffMs = now.getTime() - updated.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  if (diffHours < 1) return "vừa xong";
  if (diffHours < 24) return `${diffHours}h trước`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} ngày`;
}

/* ------------------------------------------------------------------ */
/* Derived metrics                                                     */
/* ------------------------------------------------------------------ */

export function computePricingKpis(rows: PricingRow[]) {
  const holding = rows.filter((r) => r.boxStatus === "holding").length;
  const lost = rows.filter((r) => r.boxStatus === "lost").length;
  const atRisk = rows.filter((r) => r.boxStatus === "at_risk").length;
  const belowFloor = rows.filter((r) => r.currentMargin < 0).length;

  return [
    {
      label: "SKU đang giữ Buy Box",
      value: `${holding} / ${rows.length}`,
      sub: `${rows.length > 0 ? Math.round((holding / rows.length) * 100) : 0}%`,
      tone: "up" as const,
    },
    {
      label: "SKU mất box",
      value: String(lost),
      sub: `${atRisk} sắp mất`,
      tone: lost > 0 ? ("down" as const) : ("flat" as const),
    },
    {
      label: "SKU sắp mất box",
      value: String(atRisk),
      sub: "cần theo dõi",
      tone: atRisk > 0 ? ("warn" as const) : ("flat" as const),
    },
    {
      label: "SKU dưới giá sàn (biên âm)",
      value: String(belowFloor),
      sub: "cần xử lý ngay",
      tone: belowFloor > 0 ? ("down" as const) : ("flat" as const),
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Phân trang PostgREST                                                */
/* ------------------------------------------------------------------ */

export type PageResult = { data: unknown[] | null; error: unknown };

export async function readAll<T>(
  read: (from: number, to: number) => PromiseLike<PageResult>,
): Promise<T[]> {
  const rows: T[] = [];
  const size = 500;
  for (let from = 0; ; from += size) {
    const result = await read(from, from + size - 1);
    if (result.error || !result.data)
      throw new Error("Pricing data unavailable");
    rows.push(...(result.data as T[]));
    if (result.data.length < size) return rows;
  }
}
