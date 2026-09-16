/**
 * Module 8 G3 — phân tích TẬP TRUNG THỊ TRƯỜNG từ snapshot đối thủ.
 *
 * Quy tắc nghiệp vụ (tài liệu M8 mục 3/Tab 2):
 *   • Gộp VARIATION trước khi tính: các ASIN cùng parent_asin là 1 sản phẩm
 *     (lấy đại diện vị trí cao nhất, chỉ số lấy MAX để tránh cộng trùng sales).
 *   • CR3/CR5/HHI tính theo THỊ PHẦN THUƯỚC (ưu tiên est revenue; thiếu thì
 *     units; thiếu nữa → null = "chưa đủ cơ sở", KHÔNG bịa).
 *   • Amazon 1P trong top 3 organic là VETO ĐỎ; CR3 > 65% là VETO ĐỎ.
 *   • Sponsored không tính vào thị phần tự nhiên, chỉ đếm mật độ quảng cáo.
 *
 * Thuần, không I/O — test được toàn bộ.
 */

import { PILLAR_LABELS, PILLAR_WEIGHTS } from "./scorecard.ts";
import type { PillarScore, VetoFlag } from "./types.ts";

export type CompetitorInput = {
  asin: string;
  parentAsin?: string | null;
  brand?: string | null;
  isSponsored: boolean;
  position: number;
  price?: number | null;
  rating?: number | null;
  ratingsTotal?: number | null;
  estUnitsMonth?: number | null;
  estRevenueMonth?: number | null;
  isAmazon1p: boolean;
};

export type BrandShare = {
  brand: string;
  /** số sản phẩm (sau gộp variation) của brand trong organic */
  productCount: number;
  unitSharePct: number | null;
  revenueSharePct: number | null;
  topPosition: number;
};

export type ConcentrationResult = {
  organicCount: number;
  sponsoredCount: number;
  sponsoredSharePct: number | null;
  brands: BrandShare[];
  /** thương hiệu dùng để xếp hạng thị phần */
  metric: "revenue" | "units" | null;
  cr3Pct: number | null;
  cr5Pct: number | null;
  /** HHI trên thang 0–10.000 (tổng bình phương % thị phần các brand) */
  hhi: number | null;
  totalEstUnitsMonth: number | null;
  totalEstRevenueMonth: number | null;
  amazon1p: {
    productCount: number;
    organicSharePct: number | null;
    inTop3: boolean;
  };
  avgRating: number | null;
  /** tỉ lệ sản phẩm organic có ước lượng sales (revenue hoặc units) */
  salesCoveragePct: number;
  sufficientData: boolean;
  notes: string[];
};

const MIN_ORGANIC = 10;
const MIN_SALES_COVERAGE = 0.7;
const R1 = (n: number) => Math.round(n * 10) / 10;

/** Gộp variation theo parent_asin; không parent thì chính ASIN là khóa. */
export function rollUpVariations(rows: CompetitorInput[]): CompetitorInput[] {
  const groups = new Map<string, CompetitorInput>();
  for (const row of rows) {
    if (row.isSponsored) continue; // slot quảng cáo không gộp vào thị phần tự nhiên
    const key = (row.parentAsin ?? row.asin).toUpperCase();
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...row });
      continue;
    }
    // đại diện: vị trí nhỏ hơn; số liệu sales/rating lấy MAX để khỏi cộng trùng.
    groups.set(key, {
      ...existing,
      position: Math.min(existing.position, row.position),
      brand: existing.brand ?? row.brand,
      price: existing.price ?? row.price,
      rating: Math.max(existing.rating ?? 0, row.rating ?? 0) || null,
      ratingsTotal: Math.max(existing.ratingsTotal ?? 0, row.ratingsTotal ?? 0) || null,
      estUnitsMonth: Math.max(existing.estUnitsMonth ?? 0, row.estUnitsMonth ?? 0) || null,
      estRevenueMonth: Math.max(existing.estRevenueMonth ?? 0, row.estRevenueMonth ?? 0) || null,
      isAmazon1p: existing.isAmazon1p || row.isAmazon1p,
    });
  }
  return [...groups.values()].sort((a, b) => a.position - b.position);
}

export function analyzeConcentration(rows: CompetitorInput[]): ConcentrationResult {
  const notes: string[] = [];
  const sponsored = rows.filter((r) => r.isSponsored);
  const organicRolled = rollUpVariations(rows);
  const organicCount = organicRolled.length;

  // coverage ước lượng sales
  const withRevenue = organicRolled.filter((r) => (r.estRevenueMonth ?? 0) > 0);
  const withUnits = organicRolled.filter((r) => (r.estUnitsMonth ?? 0) > 0);
  const revenueCoverage = organicCount ? withRevenue.length / organicCount : 0;
  const unitsCoverage = organicCount ? withUnits.length / organicCount : 0;
  let metric: ConcentrationResult["metric"] = null;
  if (organicCount >= MIN_ORGANIC && revenueCoverage >= MIN_SALES_COVERAGE) metric = "revenue";
  else if (organicCount >= MIN_ORGANIC && unitsCoverage >= MIN_SALES_COVERAGE) metric = "units";

  const totalEstRevenueMonth = metric ? organicRolled.reduce((s, r) => s + (r.estRevenueMonth ?? 0), 0) : null;
  const totalEstUnitsMonth = metric ? organicRolled.reduce((s, r) => s + (r.estUnitsMonth ?? 0), 0) : null;

  // gom brand
  const brandMap = new Map<string, CompetitorInput[]>();
  for (const r of organicRolled) {
    const brand = (r.brand ?? "Không rõ").trim() || "Không rõ";
    if (!brandMap.has(brand)) brandMap.set(brand, []);
    brandMap.get(brand)!.push(r);
  }
  const brands: BrandShare[] = [...brandMap.entries()].map(([brand, items]) => {
    const units = items.reduce((s, r) => s + (r.estUnitsMonth ?? 0), 0);
    const revenue = items.reduce((s, r) => s + (r.estRevenueMonth ?? 0), 0);
    return {
      brand,
      productCount: items.length,
      topPosition: Math.min(...items.map((r) => r.position)),
      unitSharePct: metric && totalEstUnitsMonth ? R1((units / totalEstUnitsMonth) * 100) : null,
      revenueSharePct: metric === "revenue" && totalEstRevenueMonth ? R1((revenue / totalEstRevenueMonth) * 100) : null,
    };
  });
  const shareKey = (b: BrandShare): number =>
    metric === "revenue" ? (b.revenueSharePct ?? 0) : metric === "units" ? (b.unitSharePct ?? 0) : 0;
  brands.sort((a, b) => shareKey(b) - shareKey(a) || a.topPosition - b.topPosition);

  const cr3Pct = metric ? R1(brands.slice(0, 3).reduce((s, b) => s + shareKey(b), 0)) : null;
  const cr5Pct = metric ? R1(brands.slice(0, 5).reduce((s, b) => s + shareKey(b), 0)) : null;
  const hhi = metric ? Math.round(brands.reduce((s, b) => s + shareKey(b) ** 2, 0)) : null;

  // Amazon 1P
  const onePProducts = organicRolled.filter((r) => r.isAmazon1p);
  const inTop3 = organicRolled.slice(0, 3).some((r) => r.isAmazon1p);
  const amazon1p = {
    productCount: onePProducts.length,
    organicSharePct: organicCount ? R1((onePProducts.length / organicCount) * 100) : null,
    inTop3,
  };

  // sponsored density: số slot sponsored trên TỔNG slot trang 1 đã lấy
  const totalSlots = rows.length;
  const sponsoredSharePct = totalSlots ? R1((sponsored.length / totalSlots) * 100) : null;

  // rating trung bình (organic, có rating)
  const rated = organicRolled.filter((r) => r.rating !== null && r.rating !== undefined);
  const avgRating = rated.length
    ? R1(rated.reduce((s, r) => s + (r.rating ?? 0), 0) / rated.length)
    : null;

  const sufficientData = metric !== null;
  if (organicCount < MIN_ORGANIC) notes.push(`Mới có ${organicCount} sản phẩm organic (cần ≥ ${MIN_ORGANIC}) — chưa đủ cơ sở chấm tập trung.`);
  else if (!sufficientData)
    notes.push(
      `Chỉ ${Math.round(Math.max(revenueCoverage, unitsCoverage) * 100)}% sản phẩm có sales estimate (cần ≥ ${MIN_SALES_COVERAGE * 100}%) — chạy bước products/sales_estimation trước khi chấm CR3/HHI.`,
    );
  if (sponsoredSharePct !== null && sponsoredSharePct > 25)
    notes.push(`Mật độ slot sponsored trang 1 là ${sponsoredSharePct}% — giá thầu quảng cáo ngách này có thể bị đẩy cao.`);

  return {
    organicCount,
    sponsoredCount: sponsored.length,
    sponsoredSharePct,
    brands,
    metric,
    cr3Pct,
    cr5Pct,
    hhi,
    totalEstUnitsMonth,
    totalEstRevenueMonth,
    amazon1p,
    avgRating,
    salesCoveragePct: Math.round(Math.max(revenueCoverage, unitsCoverage) * 100),
    sufficientData,
    notes,
  };
}

/**
 * Ghép 2 loại snapshot cho 1 hồ sơ:
 *   - serpRows: cho vị trí tự nhiên/sponsored + brand cơ sở (lần quét SERP mới nhất);
 *   - productRows: làm giàu sales estimate / buybox 1P / parent / variation
 *     (collection products mới nhất), KHỚP THEO ASIN.
 * Sản phẩm chỉ có trong productRows (hiếm) vẫn được giữ với position 0.
 */
export function mergeCompetitorSnapshots(
  serpRows: CompetitorInput[],
  productRows: CompetitorInput[],
): CompetitorInput[] {
  const enriched = new Map(productRows.map((r) => [r.asin.toUpperCase(), r]));
  const seen = new Set<string>();
  const out: CompetitorInput[] = [];
  for (const s of serpRows) {
    const p = enriched.get(s.asin.toUpperCase());
    seen.add(s.asin.toUpperCase());
    out.push({
      ...s,
      parentAsin: p?.parentAsin ?? s.parentAsin,
      brand: s.brand ?? p?.brand ?? null,
      estUnitsMonth: p?.estUnitsMonth ?? s.estUnitsMonth ?? null,
      estRevenueMonth: p?.estRevenueMonth ?? s.estRevenueMonth ?? null,
      isAmazon1p: s.isAmazon1p || !!p?.isAmazon1p,
      rating: p?.rating ?? s.rating ?? null,
      ratingsTotal: p?.ratingsTotal ?? s.ratingsTotal ?? null,
    });
  }
  for (const p of productRows) {
    if (!seen.has(p.asin.toUpperCase())) out.push({ ...p });
  }
  return out;
}

/* ------------------------------ chấm điểm trụ ------------------------------ */

export type CompetitionScore = {
  pillar: PillarScore;
  vetoes: VetoFlag[];
  warnings: string[];
};

export const CR3_RED_VETO = 65;

/**
 * Trụ cạnh tranh (thang 1–10) theo CR3 + Amazon 1P + mật độ sponsored.
 * Chưa đủ dữ liệu → score null + reason nêu thẳng thiếu gì.
 */
export function scoreCompetition(c: ConcentrationResult): CompetitionScore {
  const vetoes: VetoFlag[] = [];
  const warnings: string[] = [];
  const weight = PILLAR_WEIGHTS.competition;

  if (!c.sufficientData || c.cr3Pct === null) {
    return {
      pillar: {
        pillar: "competition",
        label: PILLAR_LABELS.competition,
        weight,
        score: null,
        confidence: null,
        reason: c.notes[0] ?? "Chưa đủ cơ sở chấm tập trung thị trường",
      },
      vetoes,
      warnings,
    };
  }

  let score: number;
  if (c.cr3Pct < 40) score = 10;
  else if (c.cr3Pct < 50) score = 8;
  else if (c.cr3Pct < 55) score = 7;
  else if (c.cr3Pct < 60) score = 5;
  else if (c.cr3Pct < CR3_RED_VETO) score = 4;
  else if (c.cr3Pct < 75) score = 2;
  else score = 1;

  const reasons: string[] = [
    `CR3 ${c.cr3Pct.toFixed(1)}% · CR5 ${c.cr5Pct?.toFixed(1)}% · HHI ${c.hhi}`,
    `${c.brands.length} thương hiệu trên ${c.organicCount} sản phẩm organic`,
  ];

  if (c.amazon1p.inTop3) {
    score = Math.min(score, 3);
    reasons.unshift("Amazon 1P chiếm top 3 organic");
    vetoes.push({
      code: "amazon1p_top3",
      severity: "red",
      title: "Amazon 1P chiếm top 3 kết quả tự nhiên",
      detail: "Sản phẩm do Amazon bán/ship nằm trong top 3 organic — khó thắng Buy Box và giá khi Amazon trực tiếp bán.",
      evidence: {
        onePProducts: c.amazon1p.productCount,
        onePSharePct: c.amazon1p.organicSharePct,
        inTop3: true,
      },
    });
  } else if (c.amazon1p.productCount > 0) {
    warnings.push(`Có ${c.amazon1p.productCount} sản phẩm Amazon 1P ngoài top 3 (${c.amazon1p.organicSharePct}%).`);
  }

  if (c.cr3Pct > CR3_RED_VETO) {
    vetoes.push({
      code: "cr3_above_65",
      severity: "red",
      title: "Thị phần 3 thương hiệu đầu vượt 65%",
      detail: `CR3 = ${c.cr3Pct.toFixed(1)}% (> ${CR3_RED_VETO}%) — ngách bị chi phối mạnh, người mới khó giành vị trí mà không khác biệt sản phẩm rõ rệt.`,
      evidence: { cr3Pct: c.cr3Pct, cr5Pct: c.cr5Pct, hhi: c.hhi, topBrands: c.brands.slice(0, 3).map((b) => b.brand) },
    });
  }

  if (c.sponsoredSharePct !== null && c.sponsoredSharePct > 25) {
    warnings.push(`Mật độ sponsored trang 1 ${c.sponsoredSharePct}%.`);
  }

  return {
    pillar: {
      pillar: "competition",
      label: PILLAR_LABELS.competition,
      weight,
      score: R1(score),
      confidence: "medium",
      reason: reasons.join(" · "),
    },
    vetoes,
    warnings,
  };
}

/**
 * Tiện ích cho worker: ghép snapshot SERP + products rồi chấm trụ cạnh tranh
 * và sinh veto trong MỘT lượt (dùng cho cả direct collect lẫn webhook).
 */
export function scoreCompetitionFromSnapshots(
  serpRows: CompetitorInput[],
  productRows: CompetitorInput[],
): {
  concentration: ConcentrationResult;
  pillar: PillarScore;
  vetoes: VetoFlag[];
  warnings: string[];
} {
  const merged = mergeCompetitorSnapshots(serpRows, productRows);
  const concentration = analyzeConcentration(merged);
  const scored = scoreCompetition(concentration);
  return {
    concentration,
    pillar: scored.pillar,
    vetoes: scored.vetoes,
    warnings: scored.warnings,
  };
}

/* ----------------------------- review velocity ---------------------------- */

export type VelocitySnapshot = {
  asin: string;
  date: string; // YYYY-MM-DD
  ratingsTotal: number;
};

export type VelocityResult = {
  /** review mới/ngày trung bình toàn ngách (chỉ tính ASIN có đủ 2 mốc) */
  reviewsPerDay: number | null;
  perAsin: { asin: string; reviewsPerDay: number; days: number }[];
  sufficientData: boolean;
};

/**
 * Velocity = (tổng review hiện tại − mốc trước) / số ngày giữa 2 lần quét.
 * Cần ≥2 mốc cho tối thiểu 3 ASIN mới có nghĩa — 1 snapshot → null.
 */
export function computeReviewVelocity(
  prev: VelocitySnapshot[],
  current: VelocitySnapshot[],
  now: Date = new Date(),
): VelocityResult {
  const prevMap = new Map(prev.map((p) => [p.asin.toUpperCase(), p]));
  const perAsin: VelocityResult["perAsin"] = [];
  let totalReviews = 0;
  let totalDays = 0;
  for (const cur of current) {
    const before = prevMap.get(cur.asin.toUpperCase());
    if (!before) continue;
    const days = Math.max(
      1,
      Math.round((new Date(cur.date).getTime() - new Date(before.date).getTime()) / 86_400_000),
    );
    const gained = Math.max(0, cur.ratingsTotal - before.ratingsTotal);
    const perDay = gained / days;
    perAsin.push({ asin: cur.asin, reviewsPerDay: R1(perDay * 10) / 10, days });
    totalReviews += gained;
    totalDays += days;
  }
  // ngày tham chiếu để mốc đầu tiên (snapshot 1 lẻ) không vỡ nghĩa
  void now;
  const sufficientData = perAsin.length >= 3;
  return {
    reviewsPerDay: sufficientData ? R1(totalReviews / perAsin.reduce((s, x) => s + x.days, 0)) : null,
    perAsin: perAsin.sort((a, b) => b.reviewsPerDay - a.reviewsPerDay),
    sufficientData,
  };
}
