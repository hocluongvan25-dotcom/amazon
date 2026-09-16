/**
 * Module 8 G7 — lịch sử BSR & mùa vụ (hàm thuần, test node:test).
 *
 * Nguồn chuỗi:
 *  - NGAY: competitor_snapshots tích lũy qua các lần quét Rainforest
 *    (mỗi run có bsr_rank + thời điểm) — đủ khi cron chạy lặp lại.
 *  - SAU NÀY: Keepa backfill nhiều năm (parser Keepa CSV ở dưới).
 *
 * Nguyên tắc "chưa đủ cơ sở": mùa vụ cần ≥2 năm HOẶC ≥8 tuần trải đều
 * với số điểm tối thiểu; không đủ thì trả null chứ không suy diễn.
 *
 * Lưu ý chiều BSR: rank NHỎ = bán chạy; BSR giảm = nhu cầu tăng.
 */

export type BsrSource = "rainforest" | "keepa";

export type BsrPoint = {
  asin: string;
  /** ngày quan sát (ISO date hoặc datetime) */
  observedAt: string;
  bsrRank: number | null;
  source: BsrSource;
};

export type SeriesPoint = { t: Date; bsr: number };

const DAY_MS = 86_400_000;
const MEDIAN_MIN_POINTS = 3;

function med(n: number[]): number | null {
  const a = n.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (a.length === 0) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function toSeries(points: BsrPoint[]): SeriesPoint[] {
  return points
    .filter((p) => typeof p.bsrRank === "number" && p.bsrRank > 0)
    .map((p) => ({ t: new Date(p.observedAt), bsr: p.bsrRank as number }))
    .filter((p) => !Number.isNaN(p.t.getTime()))
    .sort((a, b) => a.t.getTime() - b.t.getTime());
}

export type BsrTrend = {
  points: number;
  spanDays: number;
  latestBsr: number | null;
  medianBsr: number | null;
  medianBsr30d: number | null;
  medianBsr90d: number | null;
  /** slope BSR/ngày theo hồi quy tuyến tính (ÂM = rank tốt lên/bán chạy hơn) */
  slopePerDay: number | null;
  /** hệ số góc tương quan -1..1; null khi < 2 điểm */
  r2: number | null;
};

/** Tóm tắt xu hướng BSR của 1 ASIN từ chuỗi tích lũy. */
export function summarizeBsr(points: BsrPoint[], now: Date = new Date()): BsrTrend {
  const s = toSeries(points);
  const result: BsrTrend = {
    points: s.length,
    spanDays: s.length >= 2 ? Math.round((s[s.length - 1].t.getTime() - s[0].t.getTime()) / DAY_MS) : 0,
    latestBsr: s.length ? s[s.length - 1].bsr : null,
    medianBsr: med(s.map((p) => p.bsr)),
    medianBsr30d: med(s.filter((p) => now.getTime() - p.t.getTime() <= 30 * DAY_MS).map((p) => p.bsr)),
    medianBsr90d: med(s.filter((p) => now.getTime() - p.t.getTime() <= 90 * DAY_MS).map((p) => p.bsr)),
    slopePerDay: null,
    r2: null,
  };
  if (s.length >= 2) {
    const t0 = s[0].t.getTime();
    const xs = s.map((p) => (p.t.getTime() - t0) / DAY_MS);
    const ys = s.map((p) => p.bsr);
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let cov = 0;
    let vx = 0;
    let vy = 0;
    for (let i = 0; i < n; i++) {
      cov += (xs[i] - mx) * (ys[i] - my);
      vx += (xs[i] - mx) ** 2;
      vy += (ys[i] - my) ** 2;
    }
    result.slopePerDay = vx === 0 ? null : cov / vx;
    result.r2 = vx === 0 || vy === 0 ? null : (cov * cov) / (vx * vy);
  }
  return result;
}

/* ------------------------------ MÙA VỤ ---------------------------------- */

export type SeasonalMonth = {
  /** tháng lịch 1..12 */
  month: number;
  observations: number;
  medianBsr: number | null;
  /** chỉ số mùa vụ: trung vị BSR tháng / trung vị chung (<1 = bán chạy hơn TBC) */
  index: number | null;
};

export type Seasonality = {
  asin: string | null; // null = gộp nhiều ASIN
  overallMedianBsr: number;
  months: SeasonalMonth[];
  /** tháng bán chạy nhất (BSR thấp nhất) */
  peakMonth: number | null;
  /** tháng chậm nhất (BSR cao nhất) */
  troughMonth: number | null;
  /** tỉ lệ độ sâu mùa vụ: BSR đáy / BSR đỉnh (càng nhỏ càng lệch mùa rõ) */
  peakTroughRatio: number | null;
  spanDays: number;
  yearsCovered: number;
  confidence: "high" | "medium" | "low";
};

export const SEASONALITY = {
  /** số điểm tối thiểu để thử tính */
  minPoints: 12,
  /** số ngày tối thiểu trải chuỗi với dữ liệu ngắn hạn */
  minSpanDaysShort: 56, // 8 tuần
  /** số quan sát tối thiểu mỗi tháng để tin chỉ số */
  minObsPerMonth: 2,
  /** tỉ lệ dưới đó coi là có mùa vụ rõ (đỉnh/đỉnh-trough lệch ≥25%) */
  strongRatio: 0.75,
} as const;

/**
 * Chỉ số mùa vụ theo tháng lịch. Dữ liệu 1 năm có chuỗi ≥8 tuần & mật độ
 * đủ thì cho confidence 'low' (chỉ để tham khảo); ≥2 năm mới 'high';
 * không đủ điều kiện → null = "chưa đủ cơ sở".
 */
export function computeSeasonality(points: BsrPoint[], now: Date = new Date()): Seasonality | null {
  const s = toSeries(points);
  if (s.length < SEASONALITY.minPoints) return null;
  const spanDays = (s[s.length - 1].t.getTime() - s[0].t.getTime()) / DAY_MS;

  const overall = med(s.map((p) => p.bsr));
  if (overall === null) return null;

  const byMonth = new Map<number, number[]>();
  for (const p of s) {
    const m = p.t.getUTCMonth() + 1;
    const arr = byMonth.get(m) ?? [];
    arr.push(p.bsr);
    byMonth.set(m, arr);
  }

  const months: SeasonalMonth[] = [];
  let usable = 0;
  for (let m = 1; m <= 12; m++) {
    const arr = byMonth.get(m) ?? [];
    const bucketMedian = arr.length >= MEDIAN_MIN_POINTS ? med(arr) : null;
    if (arr.length >= SEASONALITY.minObsPerMonth && bucketMedian !== null) usable++;
    months.push({
      month: m,
      observations: arr.length,
      medianBsr: bucketMedian,
      index: bucketMedian === null ? null : bucketMedian / overall,
    });
  }

  const years = new Set(s.map((p) => p.t.getUTCFullYear())).size;
  const longEnough = spanDays >= SEASONALITY.minSpanDaysShort;
  if (!longEnough || usable < 4) return null;

  type ScoredMonth = SeasonalMonth & { medianBsr: number };
  const scored = months.filter((m) => m.medianBsr !== null) as ScoredMonth[];
  const peak = scored.reduce<ScoredMonth | null>(
    (acc, m) => (acc === null || m.medianBsr < acc.medianBsr ? m : acc),
    null,
  );
  const trough = scored.reduce<ScoredMonth | null>(
    (acc, m) => (acc === null || m.medianBsr > acc.medianBsr ? m : acc),
    null,
  );

  const confidence: Seasonality["confidence"] = years >= 2 ? "high" : spanDays >= 240 ? "medium" : "low";
  const asins = new Set(points.map((p) => p.asin));

  return {
    asin: asins.size === 1 ? [...asins][0] : null,
    overallMedianBsr: overall,
    months,
    peakMonth: peak?.month ?? null,
    troughMonth: trough?.month ?? null,
    peakTroughRatio: peak && trough ? peak.medianBsr / trough.medianBsr : null,
    spanDays: Math.round(spanDays),
    yearsCovered: years,
    confidence,
  };
}

/**
 * Khuyến nghị thời điểm vào hàng: hàng cần về kho TRƯỚC tháng đỉnh
 * `leadWeeksWeek` (mặc định 8 tuần sản xuất + tàu). Trả null nếu chưa
 * đủ cơ sở mùa vụ.
 */
export function restockAdvice(
  points: BsrPoint[],
  opts: { leadWeeks?: number; now?: Date } = {},
): { peakMonth: number; orderByMonth: number; confidence: Seasonality["confidence"]; ratio: number } | null {
  const sea = computeSeasonality(points, opts.now ?? new Date());
  if (!sea || sea.peakMonth === null || sea.peakTroughRatio === null) return null;
  if (sea.peakTroughRatio >= SEASONALITY.strongRatio) {
    // Biên độ <25% → không có đỉnh mùa vụ đủ rõ để canh lịch.
    return null;
  }
  const leadWeeks = opts.leadWeeks ?? 8;
  // lùi ngày đỉnh (lấy ngày 15 của tháng đỉnh) số tuần lead
  const peakDate = new Date(Date.UTC(2000, sea.peakMonth - 1, 15));
  peakDate.setUTCDate(peakDate.getUTCDate() - leadWeeks * 7);
  let orderMonth = peakDate.getUTCMonth() + 1;
  if (orderMonth === 0) orderMonth = 12;
  return { peakMonth: sea.peakMonth, orderByMonth: orderMonth, confidence: sea.confidence, ratio: sea.peakTroughRatio };
}

/* --------------------- VELOCITY TỪ N MỐC (≥2) --------------------------- */

export type RatingSnapshot = { asin: string; observedAt: string; ratingsTotal: number | null };

export type VelocityEstimate = {
  asin: string;
  points: number;
  spanDays: number;
  /** review mới/ngày theo hồi quy tuyến tính trên N mốc */
  reviewsPerDay: number | null;
  /** reviews mới/tháng quy đổi */
  reviewsPerMonth: number | null;
  r2: number | null;
  confidence: "high" | "medium" | "low" | null;
};

/**
 * Hồi quy tuyến tính ratings_total theo thời gian trên N lần quét (tốt hơn
 * phép lấy 2 điểm của G3 khi cron chạy ≥3 lần). ratings_total chỉ tăng đơn
 * điệu; điểm nhiễu (giảm do đổi variation) bị loại bằng cách lấy dồn max.
 */
export function reviewVelocityFromSnapshots(
  snaps: RatingSnapshot[],
  now: Date = new Date(),
): VelocityEstimate {
  void now;
  const asins = new Set(snaps.map((s) => s.asin));
  const asin = asins.size === 1 ? [...asins][0] : snaps[0]?.asin ?? "";
  const pts = snaps
    .filter((s) => typeof s.ratingsTotal === "number" && (s.ratingsTotal as number) >= 0)
    .map((s) => ({ t: new Date(s.observedAt).getTime(), v: s.ratingsTotal as number }))
    .filter((p) => !Number.isNaN(p.t))
    .sort((a, b) => a.t - b.t);

  // dồn max để loại nhiễu giảm tổng review.
  let runningMax = -1;
  const mono = pts
    .map((p) => {
      runningMax = Math.max(runningMax, p.v);
      return { t: p.t, v: runningMax };
    })
    // loại các điểm không đổi liên tiếp (không thêm thông tin xu hướng)
    .filter((p, i, arr) => i === 0 || p.v !== arr[i - 1].v || i === arr.length - 1);

  const est: VelocityEstimate = {
    asin,
    points: pts.length,
    spanDays: pts.length >= 2 ? Math.round((pts[pts.length - 1].t - pts[0].t) / DAY_MS) : 0,
    reviewsPerDay: null,
    reviewsPerMonth: null,
    r2: null,
    confidence: null,
  };
  if (mono.length < 2 || est.spanDays < 1) return est;

  const xs = mono.map((p) => (p.t - mono[0].t) / DAY_MS);
  const ys = mono.map((p) => p.v);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    vx += (xs[i] - mx) ** 2;
    vy += (ys[i] - my) ** 2;
  }
  const slope = vx === 0 ? 0 : cov / vx;
  const r2 = vx === 0 || vy === 0 ? null : (cov * cov) / (vx * vy);
  est.reviewsPerDay = Math.max(0, slope);
  est.reviewsPerMonth = est.reviewsPerDay * 30;
  est.r2 = r2;
  // ≥3 điểm, trải ≥21 ngày, R²≥0.7 thì tin được; dưới nữa tùy mức.
  if (mono.length >= 3 && est.spanDays >= 21 && (r2 ?? 0) >= 0.7) est.confidence = "high";
  else if (mono.length >= 2 && est.spanDays >= 7) est.confidence = "medium";
  else est.confidence = "low";
  return est;
}

/* ----------------------- PARSER KEEPA CSV (backfill) -------------------- */

/**
 * Keepa dùng "Keepa Time Minutes": số PHÚT kể 01/01/2011 00:00 UTC
 * (không phải epoch 1970). Xem Keepa API docs, mục CSV product data.
 */
export const KEEPA_EPOCH_MS = Date.UTC(2011, 0, 1);
export function keepaMinutesToDate(minutes: number): Date {
  return new Date(KEEPA_EPOCH_MS + minutes * 60_000);
}

/**
 * Parse mảng CSV sales rank của Keepa (csv index 3 = AMAZON): dạng dẹt
 * [time, value, time, value, …]; value = -1 nghĩa là không có dữ liệu.
 * Chuyển thành BsrPoint chuẩn của engine để cùng đường tính mùa vụ.
 */
export function parseKeepaSalesRankCsv(
  csv: number[] | null | undefined,
  asin: string,
): BsrPoint[] {
  if (!Array.isArray(csv) || csv.length < 2) return [];
  const out: BsrPoint[] = [];
  for (let i = 0; i + 1 < csv.length; i += 2) {
    const minutes = csv[i];
    const value = csv[i + 1];
    if (typeof minutes !== "number" || typeof value !== "number") continue;
    out.push({
      asin,
      observedAt: keepaMinutesToDate(minutes).toISOString(),
      bsrRank: value >= 0 ? value : null,
      source: "keepa",
    });
  }
  return out;
}
