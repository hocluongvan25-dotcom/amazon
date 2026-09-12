/**
 * Data model cho Module 2 (Giá & Featured Offer) — đọc từ Supabase vexim_pricing.
 *
 * Từ migration 0016, view trả GIÁ VỐN HIỆU LỰC + giá sàn + biên thật, nên ở đây
 * KHÔNG còn tự chế "floor ≈ tổng phí" như bản 0013 (làm P1 báo lãi sai).
 *
 * Nguyên tắc hiển thị:
 *   • Thiếu giá vốn (cost_basis = fees_only) → floorPrice/currentMargin là NULL,
 *     UI hiện "—" và nói rõ phải nhập giá vốn ở /finance/costs. KHÔNG hiện 0.
 *   • Giá vốn lệch tiền tệ (currency_mismatch) → cũng NULL, kèm nhãn lý do.
 *   • Công thức khớp worker/src/domain/pricing.ts và khớp SQL trong 0016:
 *       floor  = (cogs + fba + other) / (1 − referralRate − minMarginRate)
 *       margin = (price − cogs − referral − fba − other) / price × 100
 */

import type { BoxStatus, CostBasis, PricingRow } from "@/lib/types";

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
  /* ↓ migration 0016 */
  unit_cost: number | null;
  cost_currency: string | null;
  cost_effective_from: string | null;
  cost_source: string | null;
  referral_rate_used: number | null;
  min_margin_rate: number | null;
  other_fee_per_unit: number | null;
  floor_price: number | null;
  gross_profit: number | null;
  margin_pct: number | null;
  below_floor: boolean | null;
  cost_basis: CostBasis | string | null;
  /* ↓ migration 0017: doanh số 30 ngày + người phụ trách (nối CUỐI view) */
  units_30d: number | null;
  orders_30d: number | null;
  revenue_30d: number | null;
  revenue_currency: string | null;
  velocity_30d: number | null;
  last_order_at: string | null;
  owner: string | null;
};

/* ------------------------------------------------------------------ */
/* Select strings                                                      */
/* ------------------------------------------------------------------ */

/**
 * PostgREST select theo TÊN: thiếu 1 cột là PGRST204 và SẬP CẢ TRANG P1, nên chuỗi
 * này phải bám sát cột của `public.vexim_pricing` (0016 + 7 cột nối cuối của 0017).
 */
export const PRICING_SELECT =
  "id,seller_account_id,shop,sku,asin,title,our_price,currency,updated_at,buy_box_won,buy_box_price,competitor_price,offer_captured_at,referral_fee,fba_fee,total_fees,fees_estimated_at,unit_cost,cost_currency,cost_effective_from,cost_source,referral_rate_used,min_margin_rate,other_fee_per_unit,floor_price,gross_profit,margin_pct,below_floor,cost_basis,units_30d,orders_30d,revenue_30d,revenue_currency,velocity_30d,last_order_at,owner";

/** 7 cột 0017 nối cuối vexim_pricing — harness BƯỚC 18 soát đúng danh sách này. */
export const PRICING_SALES_COLUMNS = [
  "units_30d",
  "orders_30d",
  "revenue_30d",
  "revenue_currency",
  "velocity_30d",
  "last_order_at",
  "owner",
] as const;

/* ------------------------------------------------------------------ */
/* Nhãn tiếng Việt                                                     */
/* ------------------------------------------------------------------ */

export const COST_BASIS_VI: Record<string, string> = {
  "cost+fees": "Giá vốn + phí Amazon",
  cost_only: "Giá vốn, phí theo cấu hình",
  fees_only: "Chưa có giá vốn",
  currency_mismatch: "Giá vốn lệch tiền tệ",
  unavailable: "Chưa có giá vốn lẫn phí",
};

/** Vì sao không tính được giá sàn — chỉ thẳng chỗ cần làm (nhập giá vốn). */
export const COST_BASIS_HINT: Record<string, string> = {
  "cost+fees": "số tin được: vốn hiệu lực + phí Amazon",
  cost_only: "chưa có fees estimate → referral tính theo tỷ lệ cấu hình",
  fees_only: "nhập giá vốn ở /finance/costs để có giá sàn",
  currency_mismatch: "giá vốn ghi bằng tiền tệ khác giá bán → không cộng được",
  unavailable: "thiếu cả giá vốn lẫn phí",
};

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

/** Ngưỡng biên tối thiểu mặc định khi DB chưa có cấu hình (khớp worker/pricing.ts). */
export const DEFAULT_MIN_MARGIN_PCT = 10;

function toCostBasis(raw: string | null | undefined): CostBasis {
  switch (raw) {
    case "cost+fees":
    case "cost_only":
    case "fees_only":
    case "currency_mismatch":
    case "unavailable":
      return raw;
    default:
      // View cũ (chưa chạy 0016) không có cột → suy ra từ dữ liệu, không bịa nhãn
      return "unavailable";
  }
}

/** Map 1 dòng vexim_pricing → PricingRow cho UI (P1) */
export function mapPricingRow(raw: PricingRaw): PricingRow {
  const ourPrice = raw.our_price ?? 0;
  const boxStatus = determineBoxStatus(raw.buy_box_won, raw.our_price, raw.competitor_price);

  // Giá vốn thiếu/lệch tiền tệ → DB trả NULL; ta GIỮ NULL, không suy ra từ phí.
  const unitCost = raw.unit_cost ?? null;
  const floorPrice = raw.floor_price ?? null;
  const grossProfit = raw.gross_profit ?? null;
  const costBasis = toCostBasis(raw.cost_basis ?? (unitCost === null ? "fees_only" : "cost_only"));

  // Biên: ưu tiên số DB tính (đã làm tròn 1 chữ số); DB chưa có cột (view cũ) thì
  // tính lại từ floor — nhưng chỉ khi CÓ giá vốn, nếu không để null.
  let currentMargin: number | null = raw.margin_pct ?? null;
  if (currentMargin === null && floorPrice !== null && ourPrice > 0) {
    currentMargin = ((ourPrice - floorPrice) / ourPrice) * 100;
  }

  const minMarginPct = (raw.min_margin_rate ?? DEFAULT_MIN_MARGIN_PCT / 100) * 100;
  const marginTone: PricingRow["marginTone"] =
    currentMargin === null
      ? "gray" // chưa tính được — KHÔNG tô đỏ/xanh cho số không tồn tại
      : currentMargin < 0
        ? "red"
        : currentMargin < minMarginPct
          ? "amber"
          : "green";

  const belowFloor = raw.below_floor ?? (floorPrice !== null && ourPrice > 0 ? ourPrice < floorPrice : null);

  // FOEP: chưa có trong DB → null
  // Doanh số 30 ngày (0017): view trả NULL khi SKU chưa có đơn nào — GIỮ NULL,
  // không suy ra 0 (0 đơn thật ≠ chưa có dữ liệu đơn).
  const units30d = raw.units_30d ?? null;
  const velocity30d =
    raw.velocity_30d ?? (units30d === null ? null : Math.round((units30d / 30) * 100) / 100);

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
    competitorCount: 0, // chưa có trong DB (cần Pricing API — Đợt 2)
    velocity30d,
    lastPriceChange: timeAgoShort(raw.updated_at),
    // iam.module_owner(shop, 'pricing') — tên nhân viên VEXIM, không email/không uuid
    owner: raw.owner ?? "—",
    units30d,
    orders30d: raw.orders_30d ?? null,
    revenue30d: raw.revenue_30d ?? null,
    revenueCurrency: raw.revenue_currency ?? null,
    lastOrderAt: raw.last_order_at ?? null,
    unitCost,
    costCurrency: raw.cost_currency ?? null,
    costEffectiveFrom: raw.cost_effective_from ?? null,
    costSource: raw.cost_source ?? null,
    grossProfit,
    belowFloor,
    referralRateUsed: raw.referral_rate_used ?? null,
    minMarginRate: raw.min_margin_rate ?? null,
    otherFeePerUnit: raw.other_fee_per_unit ?? null,
    costBasis,
  };
}

/** SKU chưa tính được giá sàn vì thiếu giá vốn / lệch tiền tệ (đang chặn P1). */
export function isCostBlocked(r: PricingRow): boolean {
  return r.costBasis === "fees_only" || r.costBasis === "currency_mismatch" || r.costBasis === "unavailable";
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

/**
 * "6 đơn vị · 3 đơn" — NULL nghĩa là CHƯA CÓ ĐƠN trong 30 ngày (không phải bán 0).
 */
export function formatSales30d(r: {
  units30d: number | null;
  orders30d: number | null;
}): string {
  if (r.units30d === null) return "—";
  const units = r.units30d.toLocaleString("en-US");
  return r.orders30d === null ? `${units} đơn vị` : `${units} đơn vị · ${r.orders30d} đơn`;
}

/** Velocity = đơn vị/ngày, làm tròn 2 số — dùng cho nhãn và sort "Velocity cao". */
export function formatVelocity30d(v: number | null): string {
  if (v === null) return "—";
  return `${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}/ngày`;
}

/**
 * Tiền 30 ngày. `currency = null` nghĩa là đơn của shop lẫn nhiều tiền tệ → view
 * KHÔNG cộng gộp, ta cũng không được tự quy đổi (không có tỷ giá thật).
 */
export function formatRevenue30d(amount: number | null, currency: string | null): string {
  if (amount === null) return "—";
  const n = amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (currency === null) return `${n} ⚠ lẫn tiền tệ`;
  return currency === "USD" ? `$${n}` : `${n} ${currency}`;
}

/**
 * Giá trị để sort khi cột có thể NULL: SKU CHƯA CÓ ĐƠN xếp CUỐI, không chen lên đầu
 * như thể velocity thấp nhất (cùng luật với sort biên thấp nhất của 0016).
 */
export function velocitySortValue(r: { velocity30d: number | null }): number {
  return r.velocity30d ?? Number.NEGATIVE_INFINITY;
}

/** Tiền đang bị đe doạ mỗi ngày nếu mất Buy Box = doanh thu 30 ngày ÷ 30. */
export function revenuePerDay30d(r: {
  revenue30d: number | null;
}): number | null {
  return r.revenue30d === null ? null : Math.round((r.revenue30d / 30) * 100) / 100;
}

export function computePricingKpis(rows: PricingRow[]) {
  const holding = rows.filter((r) => r.boxStatus === "holding").length;
  const lost = rows.filter((r) => r.boxStatus === "lost").length;
  const atRisk = rows.filter((r) => r.boxStatus === "at_risk").length;
  // "dưới giá sàn" phải là số DB chốt (below_floor), không phải biên âm nói chung
  const belowFloor = rows.filter((r) => r.belowFloor === true).length;
  const noCost = rows.filter((r) => isCostBlocked(r)).length;
  const withMargin = rows.filter((r) => r.currentMargin !== null);
  const avgMargin =
    withMargin.length > 0
      ? withMargin.reduce((sum, r) => sum + (r.currentMargin ?? 0), 0) / withMargin.length
      : null;

  return [
    {
      label: "SKU đang giữ Buy Box",
      value: `${holding} / ${rows.length}`,
      sub: `${rows.length > 0 ? Math.round((holding / rows.length) * 100) : 0}%`,
      tone: "up" as const,
    },
    {
      label: "SKU dưới giá sàn",
      value: String(belowFloor),
      sub: belowFloor > 0 ? "chặn áp giá — xử lý ngay (SOP-02)" : `${atRisk} SKU sắp mất box`,
      tone: belowFloor > 0 ? ("down" as const) : ("flat" as const),
    },
    {
      label: "Biên trung bình",
      value: avgMargin === null ? "—" : `${avgMargin.toFixed(1)}%`,
      sub: avgMargin === null ? "chưa SKU nào tính được biên" : `${withMargin.length}/${rows.length} SKU có giá vốn`,
      tone: avgMargin === null ? ("warn" as const) : avgMargin < DEFAULT_MIN_MARGIN_PCT ? ("warn" as const) : ("up" as const),
    },
    {
      label: "SKU chưa có giá vốn",
      value: String(noCost),
      sub: noCost > 0 ? "nhập ở Giá vốn (F3/F4/P1) để tính sàn" : "đủ giá vốn để tính sàn",
      tone: noCost > 0 ? ("warn" as const) : ("flat" as const),
    },
  ];
}

/** Số SKU mất box — để P3 (duyệt giá) đếm hàng chờ. */
export function countLostBox(rows: PricingRow[]): number {
  return rows.filter((r) => r.boxStatus === "lost").length;
}

export { boxStatusLabel };

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
