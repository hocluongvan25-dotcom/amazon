/**
 * Module 6 (Đợt 2) — Domain logic F3 (bồi hoàn FBA, SOP-09) & F4 (lợi nhuận SKU).
 *
 * NGUỒN DỮ LIỆU (đã kiểm chứng developer-docs.amazon.com, 12/09/2026):
 *   • GET_LEDGER_DETAIL_VIEW_DATA  → phát hiện khoản nghi ngờ (EventType/Reason/Disposition)
 *   • GET_FBA_REIMBURSEMENTS_DATA  → đối chiếu tiền đã bồi hoàn (SOP-09 bước 6)
 *   • catalog.cost_inputs          → giá vốn hiệu lực (KHÔNG có trong SP-API, VEXIM tự nhập)
 *   • finance.financial_events     → doanh thu/phí đã quyết toán (từ settlement V2)
 *   • Product Fees API getMyFeesEstimates → chỉ để ƯỚC TÍNH khi chưa có phí thật
 *
 * NGUYÊN TẮC SỐ LIỆU (giữ đúng tinh thần "không bịa số" của repo):
 *   • Thiếu giá vốn → estimated_amount = null, KHÔNG đoán.
 *   • gross_profit = null nếu thiếu giá vốn; ads_spend = null nếu Module 5 chưa đồng bộ.
 *   • Phí ước tính từ Fees API phải gắn nhãn fee_source='fees_api' để UI phân biệt
 *     với phí THẬT đã quyết toán (fee_source='settled').
 */

/* ============================================================================
 * F3 — PHÂN LOẠI & PHÁT HIỆN KHOẢN NGHI NGỜ (SOP-09 bước 1–3)
 * ==========================================================================*/

export const CLAIM_CATEGORY_LABEL: Record<ClaimCategory, string> = {
  lost_fc: "Mất tại FC",
  damaged_fc: "Hư hỏng tại FC",
  inbound_missing: "Thiếu khi nhập kho",
  fee_error: "Thu sai phí",
  return_missing: "Mất khi trả hàng",
  other: "Khác — cần phân loại",
};

export type ClaimCategory =
  | "lost_fc"
  | "damaged_fc"
  | "inbound_missing"
  | "fee_error"
  | "return_missing"
  | "other";

export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  suspected: "Nghi ngờ",
  to_claim: "Cần nộp",
  filed: "Đã nộp case",
  approved: "Amazon chấp nhận",
  rejected: "Amazon từ chối",
  paid: "Đã về tiền",
  closed: "Đã đóng",
};

export type ClaimStatus =
  | "suspected"
  | "to_claim"
  | "filed"
  | "approved"
  | "rejected"
  | "paid"
  | "closed";

/** SLA SOP-09 bước 5: quá 48h không phản hồi thì đẩy case. */
export const CLAIM_SLA_HOURS = 48;

/** Số lượng tối thiểu để mở khoản nghi ngờ (1 đơn vị mất cũng đáng claim). */
export const MIN_CLAIM_QUANTITY = 1;

/** Chuẩn hoá chuỗi so khớp (bỏ khoảng trắng/gạch, viết thường). */
function norm(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

/**
 * Phân loại một dòng ledger thành nhóm SOP-09.
 * Trả `null` = dòng này KHÔNG phải khoản có thể claim (bán hàng, nhập kho bình
 * thường, chuyển kho…) → không đưa vào hàng đợi, tránh làm nhiễu người xử lý.
 */
export function classifyLedgerEvent(row: {
  eventType: string | null;
  reason?: string | null;
  disposition?: string | null;
  quantity?: number | null;
}): ClaimCategory | null {
  const qty = row.quantity ?? 1;
  if (qty >= 0) return null; // chỉ mất/hư mới là số âm trong ledger

  const event = norm(row.eventType);
  const reason = norm(row.reason);
  const disposition = norm(row.disposition);

  // Nhập kho (Receipts / VendorReturns) thiếu hàng so với kế hoạch
  if (event.includes("receipt") || event.includes("vendorreturn")) {
    return "inbound_missing";
  }

  // Khách trả hàng nhưng hàng không về kho / hư khi về
  if (event.includes("customerreturn")) {
    if (disposition.includes("unfulfil") || disposition.includes("defect") || disposition.includes("damage")) {
      return "damaged_fc";
    }
    if (reason.includes("missing") || reason.includes("lost") || reason.includes("notreceived")) {
      return "lost_fc";
    }
    return "return_missing";
  }

  // Điều chỉnh kho tại FC: mất / hư / tìm thấy
  if (event.includes("adjust")) {
    if (reason.includes("found") || reason.includes("foundinventory")) return null; // tìm thấy = không mất
    if (reason.includes("damage") || disposition.includes("damage") || disposition.includes("defect")) {
      return "damaged_fc";
    }
    if (reason.includes("lost") || reason.includes("missing") || reason.includes("disposed")) {
      return "lost_fc";
    }
    if (reason.includes("fee") || reason.includes("charge")) return "fee_error";
    return "other";
  }

  // Dòng phí (không phải hàng) — chỉ có ở một số biến thể report
  if (event.includes("fee") || event.includes("charge")) return "fee_error";

  return null;
}

export type SuspectedClaim = {
  sellerAccountId: string;
  marketplaceId: string;
  sku: string;
  fnsku: string | null;
  asin: string | null;
  category: ClaimCategory;
  source: "ledger";
  sourceRef: string;
  sourceDate: string | null;
  sourceReason: string | null;
  quantity: number;
  currency: string;
  unitCost: number | null;
  estimatedAmount: number | null;
};

/**
 * Ước tính giá trị claim (SOP-09 bước 3).
 * Thiếu giá vốn → null (không đoán); giá vốn 0 vẫn tính 0 để người dùng thấy
 * "có giá vốn nhưng bằng 0" thay vì tưởng là thiếu dữ liệu.
 */
export function estimateClaimAmount(input: {
  quantity: number | null | undefined;
  unitCost: number | null | undefined;
}): number | null {
  const qty = Math.abs(input.quantity ?? 0);
  if (qty <= 0) return null;
  if (input.unitCost === null || input.unitCost === undefined) return null;
  return Math.round(qty * input.unitCost * 100) / 100;
}

/**
 * Dựng danh sách khoản nghi ngờ từ dòng ledger + bảng giá vốn hiệu lực.
 * Một khoản = (nguồn, ReferenceID, SKU) — gộp nhiều dòng cùng tham chiếu (ví dụ
 * 3 dòng -1 của cùng một shipment) thành một khoản với tổng số lượng.
 */
export function detectClaims(input: {
  sellerAccountId: string;
  marketplaceId: string;
  currency?: string;
  rows: {
    date: string | null;
    sku: string | null;
    fnsku: string | null;
    asin: string | null;
    eventType: string | null;
    referenceId: string | null;
    quantity: number | null;
    disposition: string | null;
    reason: string | null;
  }[];
  /** Tra giá vốn theo SKU (catalog.cost_inputs — quy đổi ngày do người gọi quyết định) */
  unitCostBySku: Record<string, number | null>;
}): { claims: SuspectedClaim[]; skipped: number } {
  const merged = new Map<string, SuspectedClaim>();
  let skipped = 0;

  for (const row of input.rows) {
    const category = classifyLedgerEvent(row);
    if (category === null) {
      skipped++;
      continue;
    }
    if (!row.sku) {
      skipped++;
      continue;
    }

    const quantity = Math.abs(row.quantity ?? 0);
    if (quantity < MIN_CLAIM_QUANTITY) {
      skipped++;
      continue;
    }

    const sourceRef = row.referenceId?.trim() || `${row.eventType ?? "event"}:${row.date ?? "unknown"}`;
    const key = `${sourceRef}|${row.sku}`;
    const unitCost = input.unitCostBySku[row.sku] ?? null;

    const existing = merged.get(key);
    if (existing) {
      existing.quantity += quantity;
      existing.estimatedAmount = estimateClaimAmount({ quantity: existing.quantity, unitCost: existing.unitCost });
      continue;
    }

    merged.set(key, {
      sellerAccountId: input.sellerAccountId,
      marketplaceId: input.marketplaceId,
      sku: row.sku,
      fnsku: row.fnsku,
      asin: row.asin,
      category,
      source: "ledger",
      sourceRef,
      sourceDate: row.date,
      sourceReason: row.reason ?? row.disposition ?? null,
      quantity,
      currency: input.currency ?? "USD",
      unitCost,
      estimatedAmount: estimateClaimAmount({ quantity, unitCost }),
    });
  }

  return { claims: [...merged.values()], skipped };
}

/** Tuổi khoản claim (giờ) — dùng cùng công thức với view public `age_hours`. */
export function claimAgeHours(claim: { detectedAt: Date | string; filedAt?: Date | string | null }, now: Date): number {
  const base = claim.filedAt ? new Date(claim.filedAt) : new Date(claim.detectedAt);
  return Math.max(0, Math.round((now.getTime() - base.getTime()) / 3_600_000));
}

/**
 * Cảnh báo quá hạn SOP-09 bước 5: case đã nộp nhưng > 48h chưa có kết luận,
 * hoặc khoản "cần nộp" nằm im > 48h.
 */
export function overdueClaims(
  claims: {
    id: string;
    sku: string;
    status: ClaimStatus;
    detectedAt: Date | string;
    filedAt?: Date | string | null;
  }[],
  now: Date,
  slaHours: number = CLAIM_SLA_HOURS,
): { id: string; sku: string; status: ClaimStatus; ageHours: number }[] {
  const watch: ClaimStatus[] = ["to_claim", "filed"];
  return claims
    .filter((c) => watch.includes(c.status) && claimAgeHours(c, now) > slaHours)
    .map((c) => ({ id: c.id, sku: c.sku, status: c.status, ageHours: claimAgeHours(c, now) }));
}

export type ClaimSummary = {
  total: number;
  byStatus: Record<ClaimStatus, number>;
  /** Tổng giá trị ước tính của các khoản CHƯA kết luận (không gồm paid/closed/rejected) */
  openValue: number;
  /** Tổng tiền THỰC đã về (chỉ khoản paid) */
  paidValue: number;
  /** Số khoản thiếu giá vốn → giá trị ước tính không đủ tin cậy */
  missingCostCount: number;
};

/** Tổng hợp hàng đợi claim cho KPI dashboard (Module 6). */
export function summarizeClaims(
  claims: {
    status: ClaimStatus;
    estimatedAmount: number | null;
    unitCost: number | null;
    reimbursedAmount?: number | null;
  }[],
): ClaimSummary {
  const byStatus = {} as Record<ClaimStatus, number>;
  for (const s of Object.keys(CLAIM_STATUS_LABEL) as ClaimStatus[]) byStatus[s] = 0;

  let openValue = 0;
  let paidValue = 0;
  let missingCostCount = 0;

  for (const c of claims) {
    byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
    if (c.unitCost === null) missingCostCount++;
    if (c.status === "paid") paidValue += c.reimbursedAmount ?? c.estimatedAmount ?? 0;
    else if (c.status !== "closed" && c.status !== "rejected") openValue += c.estimatedAmount ?? 0;
  }

  return {
    total: claims.length,
    byStatus,
    openValue: Math.round(openValue * 100) / 100,
    paidValue: Math.round(paidValue * 100) / 100,
    missingCostCount,
  };
}

/**
 * Đối chiếu claim nội bộ với reimbursement Amazon trả về (SOP-09 bước 6).
 * Khớp theo reimbursement-id đã ghi trên claim, nếu chưa có thì theo SKU + số tiền.
 * Trả về cả hai chiều lệch để người dùng thấy rõ cái gì chưa khớp.
 */
export function reconcileClaims(input: {
  claims: {
    id: string;
    sku: string | null;
    status: ClaimStatus;
    reimbursedAmount: number | null;
    reimbursementId: string | null;
  }[];
  reimbursements: {
    reimbursementId: string | null;
    sku: string | null;
    amountTotal: number | null;
  }[];
}): {
  matched: { claimId: string; reimbursementId: string | null; amount: number | null }[];
  claimsWithoutReimbursement: string[];
  reimbursementsWithoutClaim: { reimbursementId: string | null; sku: string | null; amountTotal: number | null }[];
  /** Tổng lệch giữa số ghi trên claim và số Amazon trả (chỉ khoản đã khớp) */
  diffTotal: number;
} {
  const matched: { claimId: string; reimbursementId: string | null; amount: number | null }[] = [];
  const used = new Set<number>();
  const claimsWithoutReimbursement: string[] = [];

  for (const claim of input.claims) {
    let hitIndex = -1;

    if (claim.reimbursementId) {
      hitIndex = input.reimbursements.findIndex(
        (r, i) => !used.has(i) && r.reimbursementId === claim.reimbursementId,
      );
    }
    if (hitIndex < 0) {
      hitIndex = input.reimbursements.findIndex(
        (r, i) =>
          !used.has(i) &&
          r.sku === claim.sku &&
          claim.reimbursedAmount !== null &&
          r.amountTotal !== null &&
          Math.abs(r.amountTotal - claim.reimbursedAmount) < 0.01,
      );
    }
    if (hitIndex < 0) {
      if (claim.status === "paid" || claim.status === "filed" || claim.status === "approved") {
        claimsWithoutReimbursement.push(claim.id);
      }
      continue;
    }

    used.add(hitIndex);
    matched.push({
      claimId: claim.id,
      reimbursementId: input.reimbursements[hitIndex].reimbursementId,
      amount: input.reimbursements[hitIndex].amountTotal,
    });
  }

  const diffTotal = matched.reduce((sum, m) => {
    const claim = input.claims.find((c) => c.id === m.claimId);
    const claimAmount = claim?.reimbursedAmount ?? null;
    if (claimAmount === null || m.amount === null) return sum;
    return sum + (m.amount - claimAmount);
  }, 0);

  return {
    matched,
    claimsWithoutReimbursement,
    reimbursementsWithoutClaim: input.reimbursements
      .map((r, i) => ({ r, i }))
      .filter(({ i }) => !used.has(i))
      .map(({ r }) => r),
    diffTotal: Math.round(diffTotal * 100) / 100,
  };
}

/* ============================================================================
 * F4 — LỢI NHUẬN SKU
 * ==========================================================================*/

/** Bản đồ nhóm dòng tiền (khớp web/src/lib/finance? và finance-sync job) */
export type ProfitEventRow = {
  sku: string | null;
  eventType: string;
  amount: number;
  quantity?: number | null;
  currency?: string | null;
  eventDate: Date | string;
};

export type SkuProfitRowInput = {
  sku: string;
  day: string;
  currency: string;
  units: number;
  revenue: number;
  refunds: number;
  amazonFees: number;
  promo: number;
  cogs: number | null;
  adsSpend: number | null;
  grossProfit: number | null;
  unitCost: number | null;
  feeSource: "settled" | "fees_api" | "unavailable";
};

/**
 * Tính lợi nhuận gộp theo SKU/ngày từ dòng tiền đã quyết toán.
 *
 * Công thức (Module 6 / F4):
 *   lãi gộp = doanh thu (ProductSale + ShippingCredit) − hoàn tiền (Refund)
 *             + promo (PromotionRebate) − phí Amazon (ReferralFee/FBAFee/…)
 *             − giá vốn (đơn vị bán × giá vốn hiệu lực)
 *   `ads_spend` KHÔNG trừ vào lãi gộp ở đây: ads lấy từ Module 5 (PPC) và được
 *   phân bổ ở tầng hiển thị; cột được giữ riêng để không trộn hai nguồn số.
 *
 * Quy ước dấu: dòng tiền trong settlement đã có dấu của Amazon (phí là số âm,
 * doanh thu dương). Hàm này KHÔNG tự đảo dấu — chỉ bám dấu report, để tổng bằng
 * đúng số tiền thật.
 */
export function buildSkuProfitRows(input: {
  minDay: string;
  maxDay?: string;
  events: ProfitEventRow[];
  unitCostBySku: Record<string, number | null>;
  adsSpendBySkuDay?: Record<string, number>;
  /** Khi phí chưa quyết toán mà chỉ có ước tính Fees API cho cả kỳ */
  feeEstimatesBySku?: Record<string, number>;
}): SkuProfitRowInput[] {
  const maxDay = input.maxDay ?? input.minDay;
  const buckets = new Map<string, SkuProfitRowInput>();

  const dayOf = (value: Date | string): string => {
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? input.minDay : d.toISOString().slice(0, 10);
  };

  const key = (sku: string, day: string, currency: string) => `${sku}|${day}|${currency}`;
  const getBucket = (sku: string, day: string, currency: string): SkuProfitRowInput => {
    const k = key(sku, day, currency);
    let row = buckets.get(k);
    if (!row) {
      row = {
        sku,
        day,
        currency,
        units: 0,
        revenue: 0,
        refunds: 0,
        amazonFees: 0,
        promo: 0,
        cogs: null,
        adsSpend: null,
        grossProfit: null,
        unitCost: input.unitCostBySku[sku] ?? null,
        feeSource: "settled",
      };
      buckets.set(k, row);
    }
    return row;
  };

  for (const event of input.events) {
    if (!event.sku) continue; // dòng tiền không gắn SKU (subscription, transfer…) → không vào F4
    const day = dayOf(event.eventDate);
    // Chỉ nhận trong khoảng yêu cầu (eventDate của Amazon có thể lệch múi giờ)
    if (day < input.minDay || day > maxDay) continue;

    const currency = (event.currency ?? "USD").toUpperCase();
    const bucket = getBucket(event.sku, day, currency);

    switch (event.eventType) {
      case "ProductSale":
        bucket.revenue += event.amount;
        bucket.units += event.quantity ?? 0;
        break;
      case "ShippingCredit":
        bucket.revenue += event.amount;
        break;
      case "Refund":
        bucket.refunds += event.amount; // thường âm → cộng trực tiếp
        break;
      case "PromotionRebate":
        bucket.promo += event.amount;
        break;
      case "Reimbursement":
        bucket.revenue += event.amount; // tiền bồi hoàn FBA cũng là thu nhập của SKU
        break;
      case "ReferralFee":
      case "FBAFee":
      case "StorageFee":
      case "AdvertisingFee":
      case "ServiceFee":
      case "Subscription":
        bucket.amazonFees += event.amount; // Amazon trả về dấu âm
        break;
      default:
        // Adjustment/Transfer/Reserve: giữ ở F2, không đưa vào lãi gộp SKU
        break;
    }
  }

  const rows: SkuProfitRowInput[] = [];
  for (const bucket of buckets.values()) {
    const trimmedSku = bucket.sku.trim();
    const unitCost = input.unitCostBySku[trimmedSku] ?? null;
    const soldForCogs = Math.max(bucket.units, 0);
    const cogs = unitCost === null ? null : Math.round(unitCost * soldForCogs * 100) / 100;

    const ads = input.adsSpendBySkuDay?.[`${trimmedSku}|${bucket.day}`] ?? null;
    const feeEstimate = input.feeEstimatesBySku?.[trimmedSku] ?? null;
    // Chỉ dùng phí ƯỚC TÍNH khi kỳ chưa có phí thật (bucket.amazonFees = 0) — và
    // luôn gắn nhãn fees_api để UI không trộn số ước tính với số đã quyết toán.
    const amazonFees = bucket.amazonFees === 0 && feeEstimate !== null ? feeEstimate : bucket.amazonFees;

    const grossProfit =
      cogs === null
        ? null
        : Math.round((bucket.revenue + bucket.refunds + bucket.promo + amazonFees - cogs) * 100) / 100;

    rows.push({
      ...bucket,
      sku: trimmedSku,
      unitCost,
      cogs,
      adsSpend: ads,
      revenue: round2(bucket.revenue),
      refunds: round2(bucket.refunds),
      amazonFees: round2(amazonFees),
      promo: round2(bucket.promo),
      grossProfit,
      feeSource:
        bucket.amazonFees !== 0 ? "settled" : feeEstimate !== null ? "fees_api" : "unavailable",
    });
  }

  return rows.sort((a, b) => (a.day === b.day ? a.sku.localeCompare(b.sku) : a.day.localeCompare(b.day)));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** KPI lợi nhuận cho dashboard: tổng doanh thu, lãi gộp, số SKU lỗ. */
export function summarizeProfit(rows: SkuProfitRowInput[]): {
  revenue: number;
  fees: number;
  cogs: number | null;
  grossProfit: number | null;
  lossSkus: { sku: string; grossProfit: number }[];
  missingCostCount: number;
} {
  let revenue = 0;
  let fees = 0;
  let cogs = 0;
  let gross = 0;
  let hasCogs = false;
  let missingCostCount = 0;
  const lossMap = new Map<string, number>();

  for (const row of rows) {
    revenue += row.revenue + row.refunds + row.promo;
    fees += row.amazonFees;
    if (row.cogs === null) {
      missingCostCount++;
    } else {
      hasCogs = true;
      cogs += row.cogs;
    }
    if (row.grossProfit !== null) {
      gross += row.grossProfit;
      lossMap.set(row.sku, (lossMap.get(row.sku) ?? 0) + row.grossProfit);
    }
  }

  return {
    revenue: round2(revenue),
    fees: round2(fees),
    cogs: hasCogs ? round2(cogs) : null,
    grossProfit: hasCogs ? round2(gross) : null,
    lossSkus: [...lossMap.entries()]
      .filter(([, v]) => v < 0)
      .map(([sku, grossProfit]) => ({ sku, grossProfit: round2(grossProfit) }))
      .sort((a, b) => a.grossProfit - b.grossProfit),
    missingCostCount,
  };
}
