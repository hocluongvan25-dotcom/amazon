/**
 * Model thuần cho F3 (bồi hoàn FBA — SOP-09) & F4 (lợi nhuận SKU).
 *
 * Dùng chung giữa server component (đọc view public) và test — KHÔNG import
 * Supabase ở đây để test được bằng `node --experimental-strip-types`.
 *
 * Nguyên tắc số liệu (giữ đúng tinh thần repo):
 *   • Thiếu giá vốn → lãi gộp để trống, hiển thị "—", không suy diễn.
 *   • Phí ước tính (Fees API) khác phí thật đã quyết toán → luôn ghi rõ nguồn.
 *   • Số âm/âm 0 không được làm tròn thành "0" (mất dấu tiền).
 */

export const CLAIM_STATUS_ORDER = [
  "suspected",
  "to_claim",
  "filed",
  "approved",
  "rejected",
  "paid",
  "closed",
] as const;

export type ClaimStatusKey = (typeof CLAIM_STATUS_ORDER)[number];

export const CLAIM_STATUS_VI: Record<string, string> = {
  suspected: "Nghi ngờ",
  to_claim: "Cần nộp",
  filed: "Đã nộp case",
  approved: "Amazon chấp nhận",
  rejected: "Amazon từ chối",
  paid: "Đã về tiền",
  closed: "Đã đóng",
};

export const CLAIM_CATEGORY_VI: Record<string, string> = {
  lost_fc: "Mất tại FC",
  damaged_fc: "Hư hỏng tại FC",
  inbound_missing: "Thiếu khi nhập kho",
  fee_error: "Thu sai phí",
  return_missing: "Mất khi trả hàng",
  other: "Khác — cần phân loại",
};

export const CLAIM_SOURCE_VI: Record<string, string> = {
  ledger: "Sổ cái kho (Ledger)",
  inbound: "Lô nhập hàng",
  adjustment: "Điều chỉnh kho",
  manual: "Nhập tay",
};

export const FEE_SOURCE_VI: Record<string, string> = {
  settled: "Phí thật (đã quyết toán)",
  fees_api: "Ước tính — Product Fees API",
  unavailable: "Chưa có phí",
};

/** SLA SOP-09 bước 5: quá 48h chưa có kết luận thì đẩy case. */
export const CLAIM_SLA_HOURS = 48;

export type ClaimRow = {
  id: string;
  seller_account_id: string;
  shop: string;
  sku: string;
  fnsku?: string | null;
  asin?: string | null;
  category: string;
  source: string;
  source_ref: string;
  source_date?: string | null;
  source_reason?: string | null;
  quantity: number | null;
  currency: string;
  unit_cost: number | null;
  estimated_amount: number | null;
  status: string;
  amazon_case_id?: string | null;
  filed_at?: string | null;
  decided_at?: string | null;
  decision_note?: string | null;
  reimbursed_amount?: number | null;
  reimbursement_id?: string | null;
  note?: string | null;
  detected_at: string;
  updated_at?: string | null;
  age_hours?: number | null;
};

export type ClaimHistoryRow = {
  id: string;
  claim_id: string;
  stage: string;
  from_status: string | null;
  to_status: string | null;
  actor_id: string | null;
  note: string | null;
  created_at: string;
};

export type SkuProfitDbRow = {
  seller_account_id: string;
  shop: string;
  sku: string;
  day: string;
  currency: string;
  units: number;
  revenue: number;
  refunds: number;
  amazon_fees: number;
  promo: number;
  cogs: number | null;
  ads_spend: number | null;
  gross_profit: number | null;
  unit_cost: number | null;
  fee_source: string;
  computed_at: string;
};

/* ------------------------------------------------------------------ */
/* Định dạng                                                          */
/* ------------------------------------------------------------------ */

/** Tiền: giữ dấu, 2 chữ số thập phân; null/rỗng → "—" (KHÔNG hiện 0 giả). */
export function money(value: number | string | null | undefined, currency = ""): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  const text = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  return currency ? `${text} ${currency}` : text;
}

export function percent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

/** Tổng lãi gộp trên doanh thu; null khi thiếu dữ liệu (không bịa tỷ lệ). */
export function marginPct(grossProfit: number | null, revenue: number | null): number | null {
  if (grossProfit === null || revenue === null || revenue === 0) return null;
  return grossProfit / revenue;
}

/**
 * TACOS = chi phí ads / doanh thu, trả TỶ LỆ (0.124 = 12.4%) để dùng chung
 * `percent()` với margin. Null khi chưa có số ads (Module 5 chưa đồng bộ) hoặc
 * doanh thu ≤ 0 — KHÔNG trả 0 vì 0% TACOS nghĩa là "không tốn đồng ads nào".
 */
export function adsTacosPct(adsSpend: number | null, revenue: number | null): number | null {
  if (adsSpend === null || revenue === null || revenue <= 0) return null;
  return adsSpend / revenue;
}

/* ------------------------------------------------------------------ */
/* F3 — hàng đợi claim                                                */
/* ------------------------------------------------------------------ */

export type ClaimSummary = {
  total: number;
  byStatus: Record<string, number>;
  openValue: number;
  paidValue: number;
  missingCostCount: number;
  overdueCount: number;
  /** Tổng số lượng hàng đang khiếu nại (theo đơn vị) */
  units: number;
};

export function summarizeClaims(rows: ClaimRow[], now: Date = new Date()): ClaimSummary {
  const byStatus: Record<string, number> = {};
  for (const key of CLAIM_STATUS_ORDER) byStatus[key] = 0;

  let openValue = 0;
  let paidValue = 0;
  let missingCostCount = 0;
  let overdueCount = 0;
  let units = 0;

  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    units += row.quantity ?? 0;
    if (row.unit_cost === null || row.unit_cost === undefined) missingCostCount++;

    if (row.status === "paid") paidValue += row.reimbursed_amount ?? row.estimated_amount ?? 0;
    else if (row.status !== "closed" && row.status !== "rejected") openValue += row.estimated_amount ?? 0;

    if (isClaimOverdue(row, now)) overdueCount++;
  }

  return {
    total: rows.length,
    byStatus,
    openValue: round2(openValue),
    paidValue: round2(paidValue),
    missingCostCount,
    overdueCount,
    units,
  };
}

/**
 * Quá hạn SOP-09: khoản "cần nộp"/"đã nộp" nằm quá 48h kể từ lúc nộp (hoặc phát hiện).
 * Ưu tiên `age_hours` do VIEW tính (đồng hồ DB) — client lệch giờ vẫn đúng.
 */
export function isClaimOverdue(row: ClaimRow, now: Date = new Date()): boolean {
  if (row.status !== "to_claim" && row.status !== "filed") return false;
  if (typeof row.age_hours === "number") return row.age_hours > CLAIM_SLA_HOURS;
  const base = row.filed_at ?? row.detected_at;
  const ms = now.getTime() - new Date(base).getTime();
  return Math.round(ms / 3_600_000) > CLAIM_SLA_HOURS;
}

/** Hành động khả dụng theo trạng thái — khớp máy trạng thái trong migration 0015. */
export function claimActions(status: string, canDecide: boolean): { action: string; label: string; needs: "none" | "case" | "amount" | "note" }[] {
  switch (status) {
    case "suspected":
      return [
        { action: "to_claim", label: "Đưa vào danh sách nộp", needs: "note" },
        { action: "close", label: "Đóng (không claim)", needs: "note" },
      ];
    case "to_claim":
      return canDecide
        ? [
            { action: "file", label: "Đã nộp case Amazon", needs: "case" },
            { action: "close", label: "Đóng", needs: "note" },
          ]
        : [{ action: "file", label: "Đã nộp case Amazon", needs: "case" }];
    case "filed":
      return canDecide
        ? [
            { action: "approve", label: "Amazon chấp nhận", needs: "note" },
            { action: "reject", label: "Amazon từ chối", needs: "note" },
            { action: "close", label: "Đóng", needs: "note" },
          ]
        : [];
    case "approved":
      return canDecide
        ? [
            { action: "paid", label: "Ghi tiền đã về", needs: "amount" },
            { action: "close", label: "Đóng", needs: "note" },
          ]
        : [];
    case "rejected":
      return canDecide ? [{ action: "reopen", label: "Nộp lại", needs: "note" }] : [];
    default:
      return [];
  }
}

/** Gợi ý danh mục cho người dùng khi khoản bị xếp "other" (SOP-09 bước 2). */
export const CLAIM_CATEGORY_OPTIONS = Object.keys(CLAIM_CATEGORY_VI).map((key) => ({
  key,
  label: CLAIM_CATEGORY_VI[key],
}));

/* ------------------------------------------------------------------ */
/* F4 — lợi nhuận SKU                                                 */
/* ------------------------------------------------------------------ */

export type ProfitAggregate = {
  sku: string;
  shop: string;
  currency: string;
  units: number;
  revenue: number;
  refunds: number;
  fees: number;
  promo: number;
  cogs: number | null;
  grossProfit: number | null;
  margin: number | null;
  /** true khi MỌI dòng ngày đều có giá vốn; false khi thiếu ít nhất 1 dòng */
  hasFullCost: boolean;
  feeSource: string;
  days: number;
  /**
   * Chi phí quảng cáo (Module 5). NULL khi CHƯA ngày nào có dữ liệu ads —
   * theo thiết kế 0015, ads_spend là cột riêng và KHÔNG được mặc định 0
   * (0 nghĩa là "đã đo và không tốn đồng nào", khác hẳn "chưa biết").
   */
  adsSpend: number | null;
  /** Số ngày có ads_spend thật. */
  adsDays: number;
  /**
   * true khi MỌI ngày trong kỳ đều có ads_spend. false + adsSpend khác null =
   * con số CHỈ LÀ MỘT PHẦN (thiếu ngày) → UI phải nói rõ, không trình bày như tổng.
   */
  hasFullAds: boolean;
  /** TACOS = ads_spend / doanh thu (TỶ LỆ, như margin — `percent()` sẽ nhân 100). */
  tacos: number | null;
};

/**
 * Gộp lợi nhuận theo SKU (mọi ngày trong kỳ).
 * Nếu BẤT KỲ dòng ngày nào thiếu giá vốn → lãi gộp SKU = null (không cộng
 * thiếu), để người dùng biết con số chưa đủ tin cậy thay vì thấy số sai.
 */
export function aggregateProfit(rows: SkuProfitDbRow[]): ProfitAggregate[] {
  const map = new Map<string, Omit<ProfitAggregate, "adsSpend" | "hasFullAds" | "tacos"> & { adsSpend: number; adsDays: number; missingCost: boolean; feeSources: Set<string> }>();

  for (const row of rows) {
    const key = `${row.sku}|${row.currency}`;
    let entry = map.get(key);
    if (!entry) {
      entry = {
        sku: row.sku,
        shop: row.shop,
        currency: row.currency,
        units: 0,
        revenue: 0,
        refunds: 0,
        fees: 0,
        promo: 0,
        cogs: 0,
        grossProfit: 0,
        margin: null,
        hasFullCost: true,
        feeSource: row.fee_source,
        days: 0,
        missingCost: false,
        feeSources: new Set<string>(),
        adsSpend: 0,
        adsDays: 0,
      };
      map.set(key, entry);
    }

    entry.units += row.units ?? 0;
    entry.revenue += row.revenue ?? 0;
    entry.refunds += row.refunds ?? 0;
    entry.fees += row.amazon_fees ?? 0;
    entry.promo += row.promo ?? 0;
    entry.days += 1;
    entry.feeSources.add(row.fee_source);
    // ads_spend: chỉ cộng ngày CÓ số. Ngày null = Module 5 chưa đồng bộ ngày đó,
    // cộng như 0 sẽ làm TACOS thấp hơn thật mà không ai biết.
    if (row.ads_spend !== null && row.ads_spend !== undefined) {
      entry.adsSpend = (entry.adsSpend ?? 0) + row.ads_spend;
      entry.adsDays += 1;
    }

    if (row.cogs === null || row.gross_profit === null) {
      entry.missingCost = true;
      entry.hasFullCost = false;
    } else {
      entry.cogs = (entry.cogs ?? 0) + row.cogs;
      entry.grossProfit = (entry.grossProfit ?? 0) + row.gross_profit;
    }
  }

  return [...map.values()]
    .map((entry) => {
      const revenue = round2(entry.revenue + entry.refunds + entry.promo);
      const gross = entry.hasFullCost ? round2(entry.grossProfit ?? 0) : null;
      // adsSpend = null khi chưa có NGÀY NÀO được Module 5 lấp (giữ đúng quy ước
      // "chưa biết ≠ 0" của 0015).
      const adsSpend = entry.adsDays > 0 ? round2(entry.adsSpend ?? 0) : null;
      const hasFullAds = entry.adsDays > 0 && entry.adsDays === entry.days;
      return {
        sku: entry.sku,
        shop: entry.shop,
        currency: entry.currency,
        units: entry.units,
        revenue,
        refunds: round2(entry.refunds),
        fees: round2(entry.fees),
        promo: round2(entry.promo),
        cogs: entry.hasFullCost ? round2(entry.cogs ?? 0) : null,
        grossProfit: gross,
        margin: marginPct(gross, revenue),
        hasFullCost: entry.hasFullCost,
        feeSource: entry.feeSources.size === 1 ? [...entry.feeSources][0] : "mixed",
        days: entry.days,
        adsSpend,
        adsDays: entry.adsDays,
        hasFullAds,
        tacos: adsTacosPct(adsSpend, revenue),
      };
    })
    // Mặc định: SKU lỗ trước (để lộ ngay khoản đang mất tiền), thiếu giá vốn xuống cuối.
    .sort((a, b) => (a.grossProfit ?? Infinity) - (b.grossProfit ?? Infinity));
}

/** KPI tổng cho màn F4 (chỉ tính trên SKU có đủ giá vốn). */
export function profitKpis(rows: SkuProfitDbRow[]): {
  revenue: number;
  fees: number;
  cogs: number | null;
  grossProfit: number | null;
  margin: number | null;
  lossSkus: number;
  missingCostRows: number;
  skuCount: number;
  /** Tổng chi phí ads của những dòng CÓ dữ liệu; null khi chưa dòng nào có. */
  adsSpend: number | null;
  /** TACOS tổng (tỷ lệ) = adsSpend / revenue; null khi chưa có ads hoặc revenue ≤ 0. */
  tacos: number | null;
  adsRows: number;
  rowsMissingAds: number;
  /**
   * true khi CHỈ MỘT PHẦN dòng có ads_spend. Lúc đó TACOS tổng THẤP HƠN thực tế
   * (tử số thiếu) → UI phải nói rõ thay vì để CEO tin con số.
   */
  adsPartial: boolean;
} {
  let revenue = 0;
  let fees = 0;
  let cogs = 0;
  let gross = 0;
  let hasCost = false;
  let missingCostRows = 0;
  let ads = 0;
  let adsRows = 0;
  let rowsMissingAds = 0;
  const perSku = new Map<string, number | null>();

  for (const row of rows) {
    revenue += (row.revenue ?? 0) + (row.refunds ?? 0) + (row.promo ?? 0);
    fees += row.amazon_fees ?? 0;
    if (row.ads_spend === null || row.ads_spend === undefined) rowsMissingAds++;
    else {
      ads += row.ads_spend;
      adsRows++;
    }
    if (row.cogs === null || row.gross_profit === null) {
      missingCostRows++;
      perSku.set(row.sku, null);
    } else {
      hasCost = true;
      cogs += row.cogs;
      gross += row.gross_profit;
      const current = perSku.get(row.sku);
      if (current !== null) perSku.set(row.sku, (current ?? 0) + row.gross_profit);
    }
  }

  const revenueRounded = round2(revenue);
  const grossRounded = hasCost ? round2(gross) : null;
  const adsRounded = adsRows > 0 ? round2(ads) : null;

  return {
    revenue: revenueRounded,
    fees: round2(fees),
    cogs: hasCost ? round2(cogs) : null,
    grossProfit: grossRounded,
    margin: marginPct(grossRounded, revenueRounded),
    lossSkus: [...perSku.values()].filter((v) => v !== null && v < 0).length,
    missingCostRows,
    skuCount: perSku.size,
    adsSpend: adsRounded,
    tacos: adsTacosPct(adsRounded, revenueRounded),
    adsRows,
    rowsMissingAds,
    adsPartial: adsRows > 0 && rowsMissingAds > 0,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
