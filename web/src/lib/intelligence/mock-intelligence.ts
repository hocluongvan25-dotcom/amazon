/**
 * Module 8 G2 — provider dữ liệu thị trường GIẢ (deterministic) cho demo/test.
 *
 * Mọi kết quả sinh từ một bảng ASIN cố định (`B0MOCK001..030`) nên chạy lần
 * nào cũng như lần nào (không random theo thời gian); mỗi bản ghi đều gắn
 * nhãn `mock` để không ai nhầm với dữ liệu thật.
 */

import type {
  CollectionEntry,
  CreateCollectionResult,
  IntelligenceProvider,
  ReviewsRequest,
  SalesEstimateRequest,
  SearchRequest,
} from "./types.ts";

/* ------------------------------ deterministic ----------------------------- */

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AMAZON_DOMAIN_DEFAULT = "amazon.com";

/* ------------------------------ vũ trụ ASIN ------------------------------- */

type MockBrand = { name: string; count: number; oneP?: boolean };

// Cấu trúc thị trường cố ý: CR3 khá cao + có 1P để G3/G1 có gì mà chấm.
const BRANDS: MockBrand[] = [
  { name: "KitchenPro", count: 8 },
  { name: "SteelHome", count: 6 },
  { name: "Amazon Basics", count: 3, oneP: true },
  { name: "OrganizeIt", count: 4 },
  { name: "CounterCraft", count: 2 },
  { name: "NordicSpace", count: 1 },
  { name: "TidyCo", count: 1 },
  { name: "HomePivot", count: 1 },
];

type AsinSpec = {
  asin: string;
  index: number;
  brand: MockBrand;
  parentAsin: string;
  variationCount: number;
  isVariation: boolean;
};

function buildUniverse(): AsinSpec[] {
  const out: AsinSpec[] = [];
  let i = 0;
  BRANDS.forEach((brand) => {
    let brandPos = 0;
    while (brandPos < brand.count) {
      const index = i + 1;
      const asin = `B0MOCK${String(index).padStart(3, "0")}`;
      // Mỗi cụm 3 ASIN cùng brand là 1 variation family (ASIN đầu là parent).
      const inCluster = brandPos % 3;
      const parentIndex = index - inCluster;
      const parentAsin = `B0MOCK${String(parentIndex).padStart(3, "0")}`;
      // cụm cuối có thể cụt 1-2
      const remaining = brand.count - brandPos;
      const variationCount = Math.min(3, remaining);
      out.push({
        asin,
        index,
        brand,
        parentAsin,
        variationCount,
        isVariation: inCluster !== 0,
      });
      brandPos++;
      i++;
    }
  });
  return out;
}

const UNIVERSE = buildUniverse();
const byAsin = new Map(UNIVERSE.map((u) => [u.asin, u]));

function asinPricing(spec: AsinSpec) {
  const rnd = mulberry32(hashString(spec.asin + "#price"));
  const base = spec.brand.oneP
    ? 21.99 + Math.floor(rnd() * 8)
    : 24.99 + Math.floor(rnd() * 18);
  const rating = spec.brand.oneP
    ? 4.1 + rnd() * 0.5
    : 3.7 + rnd() * 1.1; // vài listing 1P điểm thấp
  const ratingsTotal = Math.floor(1200 + rnd() * 40000);
  const bsrRank = 40 + spec.index * 180 + Math.floor(rnd() * 120);
  return { base, rating: Math.round(rating * 10) / 10, ratingsTotal, bsrRank };
}

/* -------------------------------- review kho ------------------------------ */

const PAIN_SNIPPETS: { stars: number; title: string; body: string }[] = [
  { stars: 1, title: "Rusted within weeks", body: "This started rusting after three weeks next to the sink, even though I dried it by hand. Disappointing for stainless steel." },
  { stars: 2, title: "Wobbles with light weight", body: "The shelf wobbles badly once you put a few plates on it. The feet are uneven and there is no way to adjust them." },
  { stars: 1, title: "Sharp metal edges", body: "There is a sharp burr along one edge and I cut my finger while assembling it. Needs better finishing at the factory." },
  { stars: 2, title: "Arrived dented", body: "Box was fine but the metal panel arrived bent in the corner, like it was dropped before packing. Frustrating." },
  { stars: 1, title: "Missing screws", body: "Hardware pack was missing four screws so I could not finish assembly without a trip to the hardware store." },
  { stars: 2, title: "Smaller than the photos", body: "The dimensions in the listing make it look bigger. My dinner plates do not fit upright at all." },
  { stars: 1, title: "Coating peels off", body: "The black coating started peeling after a month and leaves dark flecks on my clean dishes." },
  { stars: 2, title: "Rust spots after dishwasher", body: "Top rack dishwasher was supposed to be fine but rust spots appeared around the welds after two washes." },
  { stars: 1, title: "Cheap thin metal", body: "Much thinner than expected. It flexes when you pick it up and feels like it could bend permanently." },
  { stars: 2, title: "Assembly holes do not line up", body: "The pre-drilled holes are slightly off so the rack never sits square. I had to force the screws." },
  { stars: 1, title: "Broke after two months", body: "One of the support bars snapped under normal use. We only kept mugs and cereal bowls on it." },
  { stars: 2, title: "Packaging crushed", body: "The packaging is just thin plastic and the item was scratched on arrival. Needs more protection." },
];

/* ------------------------------- mock provider ----------------------------- */

export class MockIntelligenceProvider implements IntelligenceProvider {
  readonly name = "mock" as const;

  private collections = new Map<string, { entries: CollectionEntry[]; createdAt: number }>();

  async search(req: SearchRequest): Promise<unknown> {
    const domain = req.amazonDomain ?? AMAZON_DOMAIN_DEFAULT;
    const page = req.page ?? 1;
    // Xáo trộn ổn định theo từng từ khóa + trang.
    const ordered = [...UNIVERSE].sort(
      (a, b) =>
        (hashString(req.keyword + ":" + a.asin) % 100000) -
        (hashString(req.keyword + ":" + b.asin) % 100000),
    );
    const pageSize = 30;
    const slice = ordered.slice((page - 1) * pageSize, page * pageSize);
    const searchResults = slice.map((spec, i) => {
      const p = asinPricing(spec);
      // 4 vị trí đầu của trang 1 là sponsored (trừ khi loại trừ).
      const isSponsored = page === 1 && i < 4 && !req.excludeSponsored;
      return {
        position: i + 1,
        asin: spec.asin,
        title: `${spec.brand.name} ${req.keyword} rack, adjustable stainless steel organizer`,
        brand: spec.brand.name,
        is_sponsored: isSponsored,
        sponsored_position: isSponsored ? i + 1 : undefined,
        price: { value: p.base, currency: "USD", symbol: "$", raw: `$${p.base.toFixed(2)}` },
        rating: p.rating,
        ratings_total: p.ratingsTotal,
        link: `https://${domain}/dp/${spec.asin}`,
      };
    });
    return {
      search_results: searchResults,
      search_information: {
        amazon_domain: domain,
        search_term: req.keyword,
      },
      pagination: { current_page: page, total_pages: 1, total_results: UNIVERSE.length },
    };
  }

  async product(asin: string): Promise<unknown> {
    const spec = byAsin.get(asin.toUpperCase());
    if (!spec) return { product: null };
    const p = asinPricing(spec);
    const rnd = mulberry32(hashString(asin + "#dims"));
    const length = +(8 + rnd() * 6).toFixed(2);
    const width = +(4 + rnd() * 4).toFixed(2);
    const height = +(0.4 + rnd() * 1.2).toFixed(2);
    const weight = +(0.5 + rnd() * 2.4).toFixed(2);
    return {
      product: {
        asin: spec.asin,
        parent_asin: spec.parentAsin,
        title: `${spec.brand.name} stainless steel adjustable rack`,
        brand: spec.brand.name,
        rating: p.rating,
        ratings_total: p.ratingsTotal,
        bestseller_rank: { rank: p.bsrRank, category: "Kitchen & Dining > Storage & Organization > Racks" },
        buybox_winner: {
          price: { value: p.base, currency: "USD" },
          sold_by: spec.brand.oneP ? { name: "Amazon.com" } : { name: `${spec.brand.name} Direct` },
          is_amazon_fresh: !!spec.brand.oneP,
        },
        variations: spec.isVariation
          ? undefined
          : Array.from({ length: spec.variationCount }, (_, k) => ({
              asin: `B0MOCK${String(spec.index + k).padStart(3, "0")}`,
              title: `color variant ${k + 1}`,
              is_current_asin: k === 0,
            })),
        dimensions_object: {
          length, width, height, unit: "inches",
          weight, weight_unit: "pounds",
        },
        dimensions: `${length} x ${width} x ${height} inches; ${weight} pounds`,
      },
    };
  }

  async offers(asin: string): Promise<unknown> {
    const spec = byAsin.get(asin.toUpperCase());
    if (!spec) return { offers: [] };
    const p = asinPricing(spec);
    const sellerName = spec.brand.oneP ? "Amazon.com" : `${spec.brand.name} Direct`;
    return {
      asin: spec.asin,
      offers: [
        {
          is_buybox_winner: true,
          price: { value: p.base, currency: "USD" },
          sold_by: { name: sellerName },
          is_amazon_fresh: !!spec.brand.oneP,
          is_prime: true,
        },
        {
          is_buybox_winner: false,
          price: { value: +(p.base + 1.5).toFixed(2), currency: "USD" },
          sold_by: { name: "Marketplace Reseller" },
          is_prime: false,
        },
      ],
    };
  }

  async salesEstimate(req: SalesEstimateRequest): Promise<unknown> {
    const asin = (req.asin ? byAsin.get(req.asin.toUpperCase()) : undefined) ?? null;
    const bsr = req.bsrRank ?? (asin ? asinPricing(asin).bsrRank : 5000);
    // Công thức mock: BSR càng nhỏ bán càng nhiều (đơn điệu, có sai số rõ ràng).
    const estUnits = Math.max(20, Math.round(1_200_000 / Math.sqrt(bsr)));
    const estRevenue = Math.round(estUnits * (asin ? asinPricing(asin).base : 29.99));
    return {
      sales_estimation: {
        asin: asin?.asin ?? null,
        est_monthly_units: estUnits,
        est_monthly_revenue: { value: estRevenue, currency: "USD" },
        category: "Kitchen & Dining > Racks",
        note: "MOCK estimate — real Rainforest sales estimation carries 20–40% uncertainty.",
      },
    };
  }

  async reviews(req: ReviewsRequest): Promise<unknown> {
    const spec = byAsin.get(req.asin.toUpperCase());
    const page = req.page ?? 1;
    if (!spec) return { reviews: [], pagination: { current_page: page, total_pages: 0 } };
    // Chỉ 10 ASIN đầu có dữ liệu review; phần còn lại no_data.
    if (spec.index > 10) return { reviews: [], pagination: { current_page: page, total_pages: 0 } };
    const perPage = 10;
    const totalCritical = 16;
    const totalPages = Math.ceil(totalCritical / perPage);
    if (page > totalPages) return { reviews: [], pagination: { current_page: page, total_pages: totalPages } };

    const start = (page - 1) * perPage;
    const reviews = PAIN_SNIPPETS.slice(0).concat(PAIN_SNIPPETS.slice(0, 4))
      .slice(start, start + perPage)
      .map((tpl, k) => {
        const n = start + k;
        const rnd = mulberry32(hashString(req.asin + "#rv" + n));
        const daysAgo = 10 + n * 17 + Math.floor(rnd() * 6);
        const d = new Date(Date.UTC(2026, 8, 1) - daysAgo * 86_400_000);
        return {
          id: `${req.asin.toUpperCase()}-R${String(n + 1).padStart(2, "0")}`,
          asin: req.asin.toUpperCase(),
          title: tpl.title,
          body: tpl.body,
          rating: tpl.stars,
          date: { utc: d.toISOString().slice(0, 10), raw: d.toISOString().slice(0, 10) },
          verified_purchase: rnd() > 0.25,
          helpful_votes: Math.floor(rnd() * 60),
          photos: rnd() > 0.7 ? [{ link: `https://mocked.local/${req.asin}/photo${n}.jpg` }] : [],
          link: `https://${req.amazonDomain ?? AMAZON_DOMAIN_DEFAULT}/dp/${req.asin}#review-${n}`,
          reviewer_name: "PRIVACY-STRIPPED-IN-MOCK", // parser phải bỏ: không đọc trường này
        };
      });
    return {
      reviews,
      review_summary: { total_ratings: asinPricing(spec).ratingsTotal, stars: 4.1 },
      pagination: { current_page: page, total_pages: totalPages, total_reviews: totalCritical },
    };
  }

  async createCollection(entries: CollectionEntry[]): Promise<CreateCollectionResult> {
    const collectionId = `MOCK-COL-${hashString(entries.map((e) => e.type + (e.asin ?? "")).join("|")).toString(16)}`;
    this.collections.set(collectionId, { entries, createdAt: Date.now() });
    return { collectionId, credits: entries.length };
  }

  async getCollection(collectionId: string): Promise<unknown> {
    const c = this.collections.get(collectionId);
    if (!c) throw new Error(`Mock collection không tồn tại: ${collectionId}`);
    const results: unknown[] = [];
    for (const entry of c.entries) {
      let output: unknown = null;
      if (entry.type === "product" && entry.asin) output = await this.product(entry.asin);
      if (entry.type === "offers" && entry.asin) output = await this.offers(entry.asin);
      if (entry.type === "sales_estimation" && entry.asin) output = await this.salesEstimate({ asin: entry.asin });
      if (entry.type === "reviews" && entry.asin) output = await this.reviews({ asin: entry.asin });
      results.push({ request: entry, success: true, output });
    }
    return {
      collection: { id: collectionId, status: "done", credits: c.entries.length },
      results,
    };
  }
}
