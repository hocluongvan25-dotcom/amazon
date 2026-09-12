/**
 * Job F3 + F4 (Module 6, Đợt 2) — chạy bằng worker/service_role.
 *
 *   F3 (SOP-09):
 *     1. đọc report `GET_LEDGER_DETAIL_VIEW_DATA` → phát hiện khoản nghi ngờ
 *        (EventType/Reason/Disposition + Quantity âm), nhân giá vốn hiệu lực
 *     2. ghi vào hàng đợi claim (RPC worker — chỉ chèn mới/refresh dòng
 *        'suspected', KHÔNG đụng khoản con người đang xử lý)
 *     3. đối chiếu report `GET_FBA_REIMBURSEMENTS_DATA` với claim nội bộ và
 *        cảnh báo lệch (không tự đánh dấu 'paid' thay người dùng)
 *
 *   F4: từ dòng tiền đã quyết toán + giá vốn hiệu lực → lợi nhuận SKU/ngày
 *       (thiếu giá vốn → gross_profit NULL, không bịa số)
 *
 * KHÔNG gọi Amazon ở đây: runner/CLI chịu trách nhiệm tải report (Reports API)
 * rồi truyền nội dung vào job — giữ job thuần để test được không cần mạng.
 */

import type {
  AlertRowInput,
  DbAdapter,
  ReimbursementRowInput,
  SkuProfitRowInput,
  SyncJobRecord,
} from "../db/adapter.ts";
import {
  CLAIM_CATEGORY_LABEL,
  buildSkuProfitRows,
  detectClaims,
  reconcileClaims,
  summarizeClaims,
  summarizeProfit,
  type ClaimStatus,
  type SuspectedClaim,
} from "../domain/finance-claims.ts";
import { parseReimbursementsReport, type ReimbursementLine } from "../reports/reimbursements.parser.ts";
import { parseLedgerReport, type LedgerRow } from "../reports/inventory-ledger.parser.ts";

export type FinanceClaimsReport = {
  sellerAccountId: string;
  mode: "full" | "claims-only" | "profit-only";
  claims: {
    detected: number;
    inserted: number;
    refreshed: number;
    kept: number;
    skipped: number;
    byCategory: Record<string, number>;
    missingCost: number;
    estimateTotal: number;
  };
  reimbursements: {
    lines: number;
    inserted: number;
    updated: number;
    totalAmount: number;
    currency: string | null;
  } | null;
  reconciliation: {
    matched: number;
    claimsWithoutReimbursement: number;
    reimbursementsWithoutClaim: number;
    diffTotal: number;
  } | null;
  profit: {
    rows: number;
    revenue: number;
    fees: number;
    cogs: number | null;
    grossProfit: number | null;
    lossSkus: { sku: string; grossProfit: number }[];
    missingCostRows: number;
  } | null;
  warnings: string[];
};

/**
 * Tiền xử lý khoản nghi ngờ thành payload RPC (snake→camel như adapter yêu cầu).
 * `unitCost` đã tra sẵn theo ngày phát hiện ở tầng gọi (catalog.cost_inputs).
 */
export function toClaimInputs(claims: SuspectedClaim[]): {
  sku: string;
  fnsku: string | null;
  asin: string | null;
  category: string;
  source: string;
  sourceRef: string;
  sourceDate: string | null;
  sourceReason: string | null;
  quantity: number;
  currency: string;
  unitCost: number | null;
  estimatedAmount: number | null;
  marketplaceId: string;
}[] {
  return claims.map((c) => ({
    sku: c.sku,
    fnsku: c.fnsku,
    asin: c.asin,
    category: c.category,
    source: c.source,
    sourceRef: c.sourceRef,
    sourceDate: c.sourceDate,
    sourceReason: c.sourceReason,
    quantity: c.quantity,
    currency: c.currency,
    unitCost: c.unitCost,
    estimatedAmount: c.estimatedAmount,
    marketplaceId: c.marketplaceId,
  }));
}

/** Đổi dòng report reimbursement thành payload RPC (giữ nguyên khoá chống trùng). */
export function toReimbursementInputs(lines: ReimbursementLine[]): {
  reimbursementId: string | null;
  caseId: string | null;
  reason: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  condition: string | null;
  currency: string | null;
  amountPerUnit: number | null;
  amountTotal: number | null;
  quantityReimbursedCash: number | null;
  quantityReimbursedInventory: number | null;
  quantityReimbursedTotal: number | null;
  approvalDate: string | null;
  originalReimbursementId: string | null;
  originalReimbursementType: string | null;
  dedupeKey: string;
  marketplaceId: string | null;
}[] {
  return lines.map((l) => ({
    reimbursementId: l.reimbursementId,
    caseId: l.caseId,
    reason: l.reason,
    sku: l.sku,
    fnsku: l.fnsku,
    asin: l.asin,
    condition: l.condition,
    currency: l.currency,
    amountPerUnit: l.amountPerUnit,
    amountTotal: l.amountTotal,
    quantityReimbursedCash: l.quantityReimbursedCash,
    quantityReimbursedInventory: l.quantityReimbursedInventory,
    quantityReimbursedTotal: l.quantityReimbursedTotal,
    approvalDate: l.approvalDate,
    originalReimbursementId: l.originalReimbursementId,
    originalReimbursementType: l.originalReimbursementType,
    dedupeKey: l.dedupeKey,
    marketplaceId: null,
  }));
}

export async function runFinanceClaims(opts: {
  sellerAccountId: string;
  marketplaceId?: string;
  currency?: string;
  adapter: DbAdapter;
  /** Nội dung report ledger (tuỳ chọn — chỉ chạy F3 khi có) */
  ledgerReportText?: string | null;
  /** Nội dung report reimbursements (tuỳ chọn) */
  reimbursementsReportText?: string | null;
  /** Khoảng ngày + dòng tiền để tính F4 (tuỳ chọn — chỉ chạy F4 khi có) */
  profit?: {
    from: string;
    to: string;
    events: {
      sku: string | null;
      eventType: string;
      amount: number;
      quantity?: number | null;
      currency?: string | null;
      eventDate: Date | string;
    }[];
    adsSpendBySkuDay?: Record<string, number>;
    feeEstimatesBySku?: Record<string, number>;
  } | null;
  /** Claim hiện có để đối chiếu (mặc định: lấy từ adapter) */
  existingClaims?: {
    id: string;
    sku: string | null;
    status: ClaimStatus;
    reimbursedAmount: number | null;
    reimbursementId: string | null;
    detectedAt: Date | string;
    filedAt?: Date | string | null;
  }[];
  now?: Date;
  dryRun?: boolean;
}): Promise<FinanceClaimsReport> {
  const now = opts.now ?? new Date();
  const adapter = opts.adapter;
  const warnings: string[] = [];
  const report: FinanceClaimsReport = {
    sellerAccountId: opts.sellerAccountId,
    mode: "full",
    claims: {
      detected: 0,
      inserted: 0,
      refreshed: 0,
      kept: 0,
      skipped: 0,
      byCategory: {},
      missingCost: 0,
      estimateTotal: 0,
    },
    reimbursements: null,
    reconciliation: null,
    profit: null,
    warnings,
  };

  const job: SyncJobRecord = {
    sellerAccountId: opts.sellerAccountId,
    jobType: "finance.claims",
    status: "running",
    startedAt: now,
    payload: { marketplaceId: opts.marketplaceId ?? null, dryRun: opts.dryRun === true },
  };
  await adapter.recordSyncJob(job);

  try {
    /* ---------------- F3 bước 1–2: phát hiện + ghi khoản nghi ngờ ---------- */
    if (opts.ledgerReportText) {
      const parsed = parseLedgerReport(opts.ledgerReportText);
      warnings.push(...parsed.warnings);

      const costs = await adapter.listEffectiveCosts(opts.sellerAccountId, now.toISOString().slice(0, 10));
      const unitCostBySku: Record<string, number | null> = {};
      for (const c of costs) unitCostBySku[c.sku] = c.unitCost;

      const { claims, skipped } = detectClaims({
        sellerAccountId: opts.sellerAccountId,
        marketplaceId: opts.marketplaceId ?? "ATVPDKIKX0DER",
        currency: opts.currency ?? "USD",
        rows: parsed.rows as LedgerRow[],
        unitCostBySku,
      });

      report.claims.detected = claims.length;
      report.claims.skipped = skipped;
      for (const c of claims) {
        report.claims.byCategory[c.category] = (report.claims.byCategory[c.category] ?? 0) + 1;
        if (c.unitCost === null) report.claims.missingCost++;
        report.claims.estimateTotal += c.estimatedAmount ?? 0;
      }
      report.claims.estimateTotal = Math.round(report.claims.estimateTotal * 100) / 100;

      const missingCostCats = claims
        .filter((c) => c.unitCost === null)
        .map((c) => `${c.sku} (${CLAIM_CATEGORY_LABEL[c.category]})`);
      if (missingCostCats.length > 0) {
        warnings.push(
          `Thiếu giá vốn → không ước tính được giá trị cho: ${missingCostCats.slice(0, 5).join(", ")}` +
            (missingCostCats.length > 5 ? ` … (+${missingCostCats.length - 5})` : ""),
        );
      }

      const written = opts.dryRun
        ? { inserted: 0, refreshed: 0, kept: 0 }
        : await adapter.upsertReimbursementClaims(opts.sellerAccountId, toClaimInputs(claims));
      report.claims.inserted = written.inserted;
      report.claims.refreshed = written.refreshed;
      report.claims.kept = written.kept;
    } else {
      report.mode = report.mode === "full" ? "profit-only" : report.mode;
    }

    /* ---------------- F3 bước 6: đối chiếu reimbursement ------------------ */
    if (opts.reimbursementsReportText) {
      const parsed = parseReimbursementsReport(opts.reimbursementsReportText);
      warnings.push(...parsed.warnings);

      const written = opts.dryRun
        ? { inserted: 0, updated: 0 }
        : await adapter.upsertReimbursements(opts.sellerAccountId, toReimbursementInputs(parsed.lines));
      report.reimbursements = {
        lines: parsed.lines.length,
        inserted: written.inserted,
        updated: written.updated,
        totalAmount: parsed.totalAmount,
        currency: parsed.currency,
      };

      const existing =
        opts.existingClaims ?? (await adapter.listReimbursementClaims(opts.sellerAccountId, 500));
      const rec = reconcileClaims({
        claims: existing.map((c) => ({
          id: c.id,
          sku: c.sku,
          status: c.status,
          reimbursedAmount: c.reimbursedAmount,
          reimbursementId: c.reimbursementId,
        })),
        reimbursements: parsed.lines.map((l) => ({
          reimbursementId: l.reimbursementId,
          sku: l.sku,
          amountTotal: l.amountTotal,
        })),
      });
      report.reconciliation = {
        matched: rec.matched.length,
        claimsWithoutReimbursement: rec.claimsWithoutReimbursement.length,
        reimbursementsWithoutClaim: rec.reimbursementsWithoutClaim.length,
        diffTotal: rec.diffTotal,
      };

      // Cảnh báo khi có tiền Amazon trả mà chưa khớp claim nội bộ (SOP-09 bước 6)
      if (rec.reimbursementsWithoutClaim.length > 0) {
        const sum = rec.reimbursementsWithoutClaim.reduce((s, r) => s + (r.amountTotal ?? 0), 0);
        await adapter.upsertAlert({
          sellerAccountId: opts.sellerAccountId,
          ruleCode: "reimbursement_unmatched",
          severity: "amber",
          title: `${rec.reimbursementsWithoutClaim.length} khoản bồi hoàn Amazon chưa khớp claim nội bộ`,
          detail:
            `Tổng ${Math.round(sum * 100) / 100} ${parsed.currency ?? ""}. ` +
            `SOP-09 bước 6: đối chiếu với Finances API rồi cập nhật claim (mã reimbursement).`,
        });
      }
    } else if (report.mode === "full") {
      report.mode = "claims-only";
    }

    /* ---------------- F4: lợi nhuận SKU ----------------------------------- */
    if (opts.profit) {
      const costs = await adapter.listEffectiveCosts(opts.sellerAccountId, opts.profit.to);
      const unitCostBySku: Record<string, number | null> = {};
      for (const c of costs) unitCostBySku[c.sku] = c.unitCost;

      const rows = buildSkuProfitRows({
        minDay: opts.profit.from,
        maxDay: opts.profit.to,
        events: opts.profit.events,
        unitCostBySku,
        adsSpendBySkuDay: opts.profit.adsSpendBySkuDay,
        feeEstimatesBySku: opts.profit.feeEstimatesBySku,
      });

      if (!opts.dryRun) {
        await adapter.upsertSkuProfit(opts.sellerAccountId, rows as SkuProfitRowInput[]);
      }

      const summary = summarizeProfit(rows);
      report.profit = {
        rows: rows.length,
        revenue: summary.revenue,
        fees: summary.fees,
        cogs: summary.cogs,
        grossProfit: summary.grossProfit,
        lossSkus: summary.lossSkus.slice(0, 20),
        missingCostRows: summary.missingCostCount,
      };

      if (summary.missingCostCount > 0) {
        warnings.push(
          `${summary.missingCostCount} dòng SKU/ngày thiếu giá vốn → lãi gộp để trống ` +
            `(nhập giá vốn ở catalog.cost_inputs rồi chạy lại).`,
        );
      }
      if (summary.lossSkus.length > 0) {
        const worst = summary.lossSkus[0];
        await adapter.upsertAlert({
          sellerAccountId: opts.sellerAccountId,
          ruleCode: "sku_loss",
          severity: "amber",
          title: `${summary.lossSkus.length} SKU đang lỗ trong kỳ`,
          detail:
            `Lỗ nặng nhất: ${worst.sku} (${worst.grossProfit}). ` +
            `Nguồn: dòng tiền settlement đã quyết toán + giá vốn hiệu lực. ` +
            `Chưa trừ ads (Module 5 chưa đồng bộ) — con số lãi thực sẽ thấp hơn.`,
        });
      }
    }

    job.status = "done";
    job.finishedAt = new Date();
    job.payload = {
      claims: report.claims.detected,
      claimsInserted: report.claims.inserted,
      reimbursements: report.reimbursements?.lines ?? 0,
      profitRows: report.profit?.rows ?? 0,
      dryRun: opts.dryRun === true,
    };
    await adapter.recordSyncJob(job);
  } catch (e) {
    job.status = "failed";
    job.finishedAt = new Date();
    job.lastError = (e as Error).message;
    await adapter.recordSyncJob(job);
    throw e;
  }

  return report;
}
