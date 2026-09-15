/**
 * Module 8 G2 — parser THUẦN cho dữ liệu thu thập đối thủ/review.
 *
 * Không I/O, không phụ thuộc nhà cung cấp: hàm nhận đúng JSON thô của
 * Rainforest (shape thật của endpoint request?type=search|product|offers|
 * sales_estimation|reviews) và trả về các dòng chuẩn hoá để upsert qua RPC.
 *
 * QUY TẮC BẮT BUỘC:
 *   • Parser review KHÔNG bao giờ phát ra danh tính người review
 *     (reviewer_name / avatar / profile / user_id) — RPC worker cũng chặn
 *     lần cuối nếu còn sót (migration 0026).
 *   • Thiếu trường nào để trường đó null/undefined, KHÔNG bịa số.
 *   • Review chỉ giữ 1–3★ (endpoint dùng review_stars=all_critical; parser
 *     lọc lại lần nữa cho chắc).
 */

export type IntelligenceDataSource = "rainforest" | "mock";

export type CompetitorRow = {
  position: number;
  isSponsored: boolean;
  asin: string;
  parentAsin?: string | null;
  brand?: string | null;
  title?: string | null;
  price?: number | null;
  currency: string;
  rating?: number | null;
  ratingsTotal?: number | null;
  bsrRank?: number | null;
  bsrCategory?: string | null;
  estUnitsMonth?: number | null;
  estRevenueMonth?: number | null;
  buyboxSeller?: string | null;
  isAmazon1p: boolean;
  variationCount?: number | null;
  lengthIn?: number | null;
  widthIn?: number | null;
  heightIn?: number | null;
  weightLb?: number | null;
  dataSource: IntelligenceDataSource;
};

export type CriticalReviewRow = {
  asin: string;
  sourceReviewId: string;
  stars: number | null;
  title: string | null;
  body: string;
  reviewDate: string | null; // YYYY-MM-DD
  helpfulCount: number;
  verified: boolean;
  photosCount: number;
  url: string | null;
  dataSource: IntelligenceDataSource;
};

/* -------------------------------- helpers --------------------------------- */

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const cleaned = v.replace(/[$,]/g, "").trim();
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Lấy giá trị đầu tiên khác null/undefined theo danh sách key ứng viên. */
function pick(obj: Record<string, unknown> | null | undefined, keys: string[]): unknown {
  if (!obj) return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** "12.5 x 3 x 2 Inches; 1.2 Pounds" hoặc object → inch/lb. */
export function parseDimensions(raw: unknown): {
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
  weightLb: number | null;
} {
  const out: { lengthIn: number | null; widthIn: number | null; heightIn: number | null; weightLb: number | null } = {
    lengthIn: null,
    widthIn: null,
    heightIn: null,
    weightLb: null,
  };
  const obj = asObj(raw);
  if (obj) {
    const toIn = (v: unknown, unit?: string): number | null => {
      const n = num(v);
      if (n === null) return null;
      const u = (unit ?? "").toLowerCase();
      if (u.includes("feet") || u === "ft") return n * 12;
      if (u.includes("cm")) return n / 2.54;
      if (u.includes("mm")) return n / 25.4;
      if (u.includes("meter")) return n * 39.3701;
      return n; // inch mặc định
    };
    const dUnit = asStr(pick(obj, ["unit", "dimensions_unit"])) ?? "";
    const l = toIn(pick(obj, ["length", "length_in"]), dUnit);
    const w = toIn(pick(obj, ["width", "width_in"]), dUnit);
    const h = toIn(pick(obj, ["height", "height_in"]), dUnit);
    if (l !== null) out.lengthIn = l;
    if (w !== null) out.widthIn = w;
    if (h !== null) out.heightIn = h;
    const wRaw = pick(obj, ["weight", "weight_lb", "weight_pounds"]);
    const wUnit = asStr(pick(obj, ["weight_unit"])) ?? "";
    const wn = num(wRaw);
    if (wn !== null) {
      out.weightLb = wUnit.toLowerCase().includes("ounc")
        ? wn / 16
        : wUnit.toLowerCase().includes("kg")
          ? wn * 2.20462
          : wUnit.toLowerCase().includes("gram")
            ? (wn / 453.592)
            : wn;
    }
  }
  if (typeof raw === "string") {
    // VD: "10 x 6 x 0.5 inches" / "12 ounces"
    const m = raw.match(/([\d.,]+)\s*x\s*([\d.,]+)\s*x\s*([\d.,]+)\s*(inches|inch|in|centimeters|cm|feet|ft)?/i);
    if (m) {
      const dims = [m[1], m[2], m[3]].map((x) => num(x.replace(",", ".")));
      const factor = /feet|ft/i.test(m[4] ?? "") ? 12 : /cm|centimeters/i.test(m[4] ?? "") ? 1 / 2.54 : 1;
      const sorted = (dims.filter((d): d is number => d !== null) as number[]).sort((a, b) => b - a);
      if (sorted.length === 3) {
        out.lengthIn = Math.round(sorted[0] * factor * 1000) / 1000;
        out.widthIn = Math.round(sorted[1] * factor * 1000) / 1000;
        out.heightIn = Math.round(sorted[2] * factor * 1000) / 1000;
      }
    }
    const wm = raw.match(/([\d.,]+)\s*(pounds?|lbs?|ounces?|oz|kilograms?|kg)/i);
    if (wm) {
      const n = num(wm[1]);
      if (n !== null) {
        out.weightLb = /ounc|oz/i.test(wm[2]) ? n / 16 : /kilogram|kg/i.test(wm[2]) ? n * 2.20462 : n;
      }
    }
  }
  return out;
}

function parseDate(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === "string") {
    const iso = v.match(/(\d{4}-\d{2}-\d{2})/);
    return iso ? iso[1] : null;
  }
  const obj = asObj(v);
  if (obj) {
    const utc = asStr(obj.utc) ?? asStr(obj.date) ?? asStr(obj.raw);
    if (utc) return parseDate(utc);
  }
  return null;
}

function parsePrice(raw: unknown): { price: number | null; currency: string | null } {
  const obj = asObj(raw);
  if (obj) {
    return {
      price: num(pick(obj, ["value", "amount", "price"])),
      currency: asStr(pick(obj, ["currency"])),
    };
  }
  return { price: num(raw), currency: null };
}

/* ------------------------------ search parser ----------------------------- */

function mapSearchItem(item: Record<string, unknown>, position: number, dataSource: IntelligenceDataSource): CompetitorRow | null {
  const asin = asStr(pick(item, ["asin"]));
  if (!asin) return null;
  const isSponsored = !!pick(item, ["is_sponsored"]);
  const price = parsePrice(pick(item, ["price"]));
  const rating = num(pick(item, ["rating"]));
  return {
    position: num(pick(item, ["position"])) ?? position + 1,
    isSponsored,
    asin: asin.toUpperCase(),
    parentAsin: asStr(pick(item, ["parent_asin"])),
    brand: asStr(pick(item, ["brand"])),
    title: asStr(pick(item, ["title"])),
    price: price.price,
    currency: price.currency ?? "USD",
    rating,
    ratingsTotal: num(pick(item, ["ratings_total", "ratings_count"])),
    isAmazon1p: false,
    dataSource,
  };
}

export type ParsedSearchPage = {
  organic: CompetitorRow[];
  sponsored: CompetitorRow[];
  totalResults: number | null;
};

export function parseSearchPage(
  json: unknown,
  dataSource: IntelligenceDataSource = "rainforest",
): ParsedSearchPage {
  const root = asObj(json) ?? {};
  const list = Array.isArray(root.search_results)
    ? (root.search_results as unknown[])
    : [];
  const organic: CompetitorRow[] = [];
  const sponsored: CompetitorRow[] = [];
  list.forEach((raw, i) => {
    const item = asObj(raw);
    if (!item) return;
    const row = mapSearchItem(item, i + 1, dataSource);
    if (!row) return;
    (row.isSponsored ? sponsored : organic).push(row);
  });
  // Vị trí organic đánh số liên tục cho đúng SERP organic (không tính slot quảng cáo).
  organic.forEach((r, i) => (r.position = i + 1));
  const pagination = asObj(root.pagination);
  return {
    organic,
    sponsored,
    totalResults: num(pagination ? pick(pagination, ["total_results", "results"]) : undefined),
  };
}

/* -------------------- product + offers + sales estimation ------------------ */

/**
 * Ghép dữ liệu 3 endpoint của 1 ASIN thành patch bổ sung cho CompetitorRow.
 * Cho phép truyền từng phần: { product, offers, sales }.
 */
export function parseProductBundle(bundle: {
  product?: unknown;
  offers?: unknown;
  sales?: unknown;
}): Partial<CompetitorRow> {
  const patch: Partial<CompetitorRow> = {};
  const p = asObj(bundle.product);
  if (p) {
    const product = asObj(p.product) ?? p;
    if (!patch.parentAsin) patch.parentAsin = asStr(pick(product, ["parent_asin"]));
    if (!patch.brand) patch.brand = asStr(pick(product, ["brand"]));
    if (!patch.title) patch.title = asStr(pick(product, ["title"]));

    // Buybox / seller
    const bb = asObj(product.buybox_winner) ?? asObj(product.buy_box);
    if (bb) {
      const price = parsePrice(pick(bb, ["price"]));
      if (price.price !== null) patch.price = price.price;
      if (price.currency) patch.currency = price.currency;
      const seller = asObj(bb.sold_by) ?? asObj(bb.seller);
      const sellerName = seller ? asStr(pick(seller, ["name"])) : asStr(pick(bb, ["sold_by"]));
      if (sellerName) patch.buyboxSeller = sellerName;
    }
    if (product.rating !== undefined) patch.rating = num(product.rating);
    if (product.ratings_total !== undefined) patch.ratingsTotal = num(product.ratings_total);

    // BSR: có thể là object {rank, category} hoặc mảng multi_category
    const bsrObj = asObj(product.bestseller_rank) ?? asObj(product.best_sellers_rank);
    if (bsrObj) {
      const top = asObj(bsrObj[0]) ?? bsrObj;
      patch.bsrRank = num(pick(top, ["rank", "position"]));
      patch.bsrCategory = asStr(pick(top, ["category", "category_name"]));
    }
    const variations = Array.isArray(product.variations)
      ? (product.variations as unknown[])
      : [];
    if (variations.length) {
      patch.variationCount = variations.length;
    }

    // Kích thước: thử các key phổ biến của Rainforest.
    const dimsRaw = pick(product, ["dimensions_object", "product_dimensions", "dimensions"]);
    const dims = parseDimensions(dimsRaw);
    if (dims.lengthIn !== null) patch.lengthIn = dims.lengthIn;
    if (dims.widthIn !== null) patch.widthIn = dims.widthIn;
    if (dims.heightIn !== null) patch.heightIn = dims.heightIn;
    if (dims.weightLb !== null) patch.weightLb = dims.weightLb;
    // Đôi khi weight tách riêng (chuỗi "X pounds").
    if (patch.weightLb === null || patch.weightLb === undefined) {
      const w = parseDimensions(pick(product, ["weight"]));
      if (w.weightLb !== null) patch.weightLb = w.weightLb;
    }
  }

  // Offers: seller Amazon = 1P.
  const o = asObj(bundle.offers);
  if (o) {
    const offers = Array.isArray(o.offers) ? (o.offers as unknown[]) : [];
    const buyboxOffer = offers.map(asObj).find((x) => x && (x.is_buybox_winner || x.is_amazon_fresh));
    const offer = buyboxOffer ?? (offers[0] as Record<string, unknown> | undefined);
    if (offer) {
      const seller = asObj(offer.sold_by) ?? asObj(offer.seller);
      const sellerName = seller ? asStr(pick(seller, ["name"])) : asStr(pick(offer, ["sold_by"]));
      if (sellerName && !patch.buyboxSeller) patch.buyboxSeller = sellerName;
    }
  }
  if (patch.buyboxSeller) {
    patch.isAmazon1p = /^amazon(\.com)?(\s+services)?$/i.test(patch.buyboxSeller.trim());
  }

  // Sales estimation
  const s = asObj(bundle.sales);
  if (s) {
    const est = asObj(s.sales_estimation) ?? s;
    patch.estUnitsMonth = num(pick(est, ["est_monthly_units", "estimated_monthly_units_sold", "monthly_units", "est_units_month"]));
    const rev = parsePrice(pick(est, ["est_monthly_revenue", "estimated_monthly_revenue", "monthly_revenue"]));
    patch.estRevenueMonth = rev.price;
  }
  return patch;
}

/* ------------------------------ reviews parser ----------------------------- */

export type ParsedReviewsPage = {
  reviews: CriticalReviewRow[];
  totalReviews: number | null;
  totalPages: number | null;
  skipped: number;
};

export function parseReviewsPage(
  json: unknown,
  asin: string,
  dataSource: IntelligenceDataSource = "rainforest",
): ParsedReviewsPage {
  const root = asObj(json) ?? {};
  const list = Array.isArray(root.reviews) ? (root.reviews as unknown[]) : [];
  const reviews: CriticalReviewRow[] = [];
  let skipped = 0;
  const upperAsin = asin.toUpperCase();
  for (const raw of list) {
    const r = asObj(raw);
    if (!r) continue;
    const stars = num(pick(r, ["rating", "stars"]));
    // Chỉ giữ review 1–3★ (all_critical); bỏ qua bản ghi không hợp lệ.
    if (stars === null || stars > 3) {
      skipped++;
      continue;
    }
    const id = asStr(pick(r, ["id", "review_id", "reviewId"]));
    if (!id) {
      skipped++;
      continue;
    }
    const photos = Array.isArray(r.photos) ? (r.photos as unknown[]) : [];
    reviews.push({
      asin: upperAsin,
      sourceReviewId: id,
      stars,
      title: asStr(pick(r, ["title"])),
      body: asStr(pick(r, ["body", "content", "text"])) ?? "",
      reviewDate: parseDate(pick(r, ["date", "review_date"])),
      helpfulCount: num(pick(r, ["helpful_votes", "helpful_count"])) ?? 0,
      verified: !!pick(r, ["verified_purchase", "verified"]),
      photosCount: photos.length,
      url: asStr(pick(r, ["link", "url"])),
      dataSource,
      // cố ý KHÔNG lấy reviewer_name / reviewer_avatar / reviewer profile
    });
  }
  const pagination = asObj(root.pagination);
  const summary = asObj(root.review_summary) ?? asObj(root.summary);
  const totalReviews =
    num(pagination ? pick(pagination, ["total_reviews", "total_results"]) : undefined) ??
    (summary ? num(pick(summary, ["total_ratings", "ratings_total", "total_reviews"])) : null);
  return {
    reviews,
    totalReviews,
    totalPages: pagination ? num(pick(pagination, ["total_pages"])) : null,
    skipped,
  };
}

/* -------------------------------- tóm tắt ---------------------------------- */

export function summarizeCompetitors(rows: CompetitorRow[]): {
  total: number;
  sponsored: number;
  withSalesEstimate: number;
  withBsr: number;
} {
  return {
    total: rows.length,
    sponsored: rows.filter((r) => r.isSponsored).length,
    withSalesEstimate: rows.filter((r) => r.estUnitsMonth !== null && r.estUnitsMonth !== undefined).length,
    withBsr: rows.filter((r) => r.bsrRank !== null && r.bsrRank !== undefined).length,
  };
}
