/**
 * Job đồng bộ Tài chính (Module 6 — F1/F2).
 *
 * Nguồn:
 *   • Report settlement (tự động theo kỳ): GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2
 *     (bản _FLAT_FILE và _XML đã bị Amazon DEPRECATED — xem reports/settlement.parser.ts)
 *   • Finances API v0: listFinancialEvents / listFinancialEventGroups — 0.5 rps · burst 30
 *     → dùng cho tầng delta + backfill, không phải cho đối soát kỳ đã chốt.
 *   • Report GET_LEDGER_DETAIL_VIEW_DATA (sổ cái chi tiết, hằng ngày) — Đợt 2.
 *
 * Đối soát theo SOP-10: lệch > 1% → cảnh báo `reconciliation_mismatch` cho phòng Tài chính.
 * Domain dùng chung với web: worker/src/domain/finance.ts (reconcileSettlement,
 * feeTakeRate, tacos, totalTakeRate, estimateReserveHold, estimateOpenPayout).
 */
import type {
  AlertRowInput,
  DbAdapter,
  FinancialEventRowInput,
  SettlementRowInput,
  SyncJobRecord,
} from "../db/adapter.ts";
import {
  DEFAULT_RESERVE_RATE,
  RECONCILE_TOLERANCE_PCT,
  feeTakeRate,
  netTransfer,
  reconcileSettlement,
  tacos,
  totalTakeRate,
  type SettlementGroup,
} from "../domain/finance.ts";
import {
  GROUP_LABELS,
  classifySettlementLine,
  parseSettlementReport,
  type SettlementLine,
} from "../reports/settlement.parser.ts";

export type FinanceSyncConfig = {
  /** Report settlement hiện hành (bản cũ đã deprecated) */
  settlementReportType: "GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2";
  deprecatedSettlementReportTypes: readonly string[];
  ledgerReportType: "GET_LEDGER_DETAIL_VIEW_DATA";
  reportsRequestsPerSecond: number;
  reportsBurst: number;
  /** Finances API v0 — listFinancialEvents */
  financialEventsRequestsPerSecond: number;
  financialEventsBurst: number;
  financialEventsMaxResults: number;
  /** SOP-10: đối soát 2h sáng, chốt KPI 6h sáng */
  cron: string;
  tolerancePct: number;
  reserveRate: number;
};

export const DEFAULT_FINANCE_SYNC_CONFIG: FinanceSyncConfig = {
  settlementReportType: "GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2",
  deprecatedSettlementReportTypes: [
    "GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE",
    "GET_V2_SETTLEMENT_REPORT_DATA_XML",
  ],
  ledgerReportType: "GET_LEDGER_DETAIL_VIEW_DATA",
  reportsRequestsPerSecond: 0.0222,
  reportsBurst: 10,
  financialEventsRequestsPerSecond: 0.5,
  financialEventsBurst: 30,
  financialEventsMaxResults: 100,
  cron: "0 2 * * *",
  tolerancePct: RECONCILE_TOLERANCE_PCT,
  reserveRate: DEFAULT_RESERVE_RATE,
};

/* ============================================================================
 * Phân loại dòng tiền cho màn F2 (khớp FinancialEventType của web)
 * ==========================================================================*/

export type FinanceEventType =
  | "ProductSale"
  | "ShippingCredit"
  | "Refund"
  | "ReferralFee"
  | "FBAFee"
  | "StorageFee"
  | "AdvertisingFee"
  | "Reimbursement"
  | "Adjustment"
  | "ServiceFee"
  | "Subscription"
  | "Reserve"
  | "Transfer"
  | "PromotionRebate";

/**
 * Ánh xạ dòng settlement → loại sự kiện F2.
 * Bám cột amount-type/amount-description của report V2. Giá trị lạ → Adjustment
 * (không bao giờ mất dòng tiền).
 */
export function financialEventType(line: SettlementLine): FinanceEventType {
  const desc = (line.amountDescription ?? "").toLowerCase().replace(/\s+/g, "");
  const group = classifySettlementLine(line);

  if (group === GROUP_LABELS.reserve) return "Reserve";
  if (group === GROUP_LABELS.transfers) return "Transfer";
  if (group === GROUP_LABELS.advertising) return "AdvertisingFee";
  if (desc.includes("reimbursement") || desc.includes("reimbursementamount")) return "Reimbursement";
  if (group === GROUP_LABELS.productSales) return "ProductSale";
  if (group === GROUP_LABELS.shipping || group === GROUP_LABELS.giftWrap) return "ShippingCredit";
  if (group === GROUP_LABELS.promotions) return "PromotionRebate";
  if (group === GROUP_LABELS.fees) {
    if (desc.includes("referral")) return "ReferralFee";
    if (desc.startsWith("fba") || desc.includes("fulfillment")) return "FBAFee";
    if (desc.includes("storage")) return "StorageFee";
    if (desc.includes("subscription")) return "Subscription";
    if (desc.includes("chargeback") || desc.includes("closingfee") || desc.includes("servicefee")) return "ServiceFee";
    return "FBAFee";
  }
  if ((line.transactionType ?? "").toLowerCase() === "refund") return "Refund";
  if (line.adjustmentId || (line.transactionType ?? "").toLowerCase() === "adjustment") return "Adjustment";
  return "Adjustment";
}

function eventDedupeKey(line: SettlementLine, index: number): string {
  return [
    line.settlementId,
    index,
    line.postedDate ?? line.postedDateTime ?? "",
    line.transactionType ?? "",
    line.amountType ?? "",
    line.amountDescription ?? "",
    line.orderId ?? "",
    line.sku ?? "",
    line.amount,
  ].join("|");
}

/* ============================================================================
 * Snapshot THUẦN
 * ==========================================================================*/

export type FinanceSnapshot = {
  sellerAccountId: string;
  settlement: SettlementRowInput | null;
  events: FinancialEventRowInput[];
  groups: SettlementGroup[];
  /** tổng theo các nhóm (không gồm dòng Transfer nếu report có) */
  calcTotal: number;
  /** số tiền chuyển về ngân hàng dùng để đối soát */
  transferAmount: number;
  transferSource: "transfer-line" | "total-amount" | "none";
  /** null = khớp trong dung sai; số khác = chênh lệch USD */
  reconcileDiff: number | null;
  takeRate: number;
  tacos: number;
  totalTakeRate: number;
  reserveHold: number;
  alerts: AlertRowInput[];
  warnings: string[];
  metrics: {
    lines: number;
    productSales: number;
    amazonFees: number;
    advertising: number;
    refunds: number;
  };
};

/**
 * Dựng snapshot tài chính từ nội dung report settlement (thuần, không I/O).
 * Xuất cả nhóm phí (F1), dòng tiền (F2) và kết quả đối soát (SOP-10).
 */
export function buildFinanceSnapshot(input: {
  sellerAccountId: string;
  settlementReportText: string;
  now?: Date;
}): FinanceSnapshot {
  const now = input.now ?? new Date();
  const parsed = parseSettlementReport(input.settlementReportText);
  const warnings = [...parsed.warnings];
  const cfg = DEFAULT_FINANCE_SYNC_CONFIG;

  const groups = parsed.groups;

  // Dòng Transfer (nếu report có) là số tiền thực chuyển về ngân hàng. Khi đó tổng
  // để đối soát phải là tổng các nhóm KHÁC Transfer — cộng cả dòng Transfer vào sẽ
  // đếm hai lần (Transfer = net của mọi dòng còn lại).
  const transferLines = parsed.lines.filter((l) => classifySettlementLine(l) === GROUP_LABELS.transfers);
  const transferSum = Math.round(transferLines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const groupsForReconcile =
    transferLines.length > 0 ? groups.filter((g) => g.label !== GROUP_LABELS.transfers) : groups;
  const calcTotal = netTransfer(groupsForReconcile);
  const transferAmount =
    transferLines.length > 0 ? transferSum : (parsed.totalAmount ?? calcTotal);
  const transferSource: FinanceSnapshot["transferSource"] =
    transferLines.length > 0 ? "transfer-line" : parsed.totalAmount !== null ? "total-amount" : "none";

  // Đối soát: tổng các nhóm vs số tiền chuyển.
  const reconcileDiff =
    parsed.lines.length === 0 || transferSource === "none"
      ? null
      : reconcileSettlement(groupsForReconcile, transferAmount, cfg.tolerancePct);

  if (transferSource === "none") {
    warnings.push("Report không có total-amount và không có dòng Transfer — không đối soát được");
  }

  const events: FinancialEventRowInput[] = parsed.lines.map((line, i) => ({
    sellerAccountId: input.sellerAccountId,
    settlementId: line.settlementId || null,
    eventType: financialEventType(line),
    eventDate: new Date(line.postedDate ?? line.postedDateTime ?? now.toISOString()),
    amount: line.amount,
    currency: line.currency ?? parsed.currency ?? "USD",
    sku: line.sku,
    amountType: line.amountType,
    amountDescription: line.amountDescription,
    orderId: line.orderId,
    quantity: line.quantityPurchased,
    marketplaceName: line.marketplaceName,
    dedupeKey: eventDedupeKey(line, i),
    raw: line,
  }));

  const productSales = groups.find((g) => g.label === GROUP_LABELS.productSales)?.amount ?? 0;
  const amazonFees = Math.abs(groups.find((g) => g.label === GROUP_LABELS.fees)?.amount ?? 0);
  const advertising = Math.abs(groups.find((g) => g.label === GROUP_LABELS.advertising)?.amount ?? 0);

  const settlement: SettlementRowInput | null = parsed.settlementId
    ? {
        sellerAccountId: input.sellerAccountId,
        settlementId: parsed.settlementId,
        periodStart: parsed.startDate ?? now.toISOString().slice(0, 10),
        periodEnd: parsed.endDate ?? now.toISOString().slice(0, 10),
        depositDate: parsed.depositDate,
        totalAmount: transferAmount,
        currency: parsed.currency ?? "USD",
        status: "deposited",
        breakdown: { groups, calcTotal, transferSource },
        reconcileDiff,
        reconciledAt: now,
      }
    : null;

  const alerts: AlertRowInput[] = [];
  if (reconcileDiff !== null) {
    const base = Math.max(Math.abs(calcTotal), Math.abs(transferAmount), 1);
    const diffPct = Math.round((Math.abs(reconcileDiff) / base) * 1000) / 10;
    alerts.push({
      sellerAccountId: input.sellerAccountId,
      ruleCode: "reconciliation_mismatch",
      severity: "red",
      title: `Lệch đối soát kỳ ${parsed.settlementId}: ${reconcileDiff.toFixed(2)} ${parsed.currency ?? "USD"} (${diffPct}%)`,
      detail:
        `Tổng theo nhóm ${calcTotal.toFixed(2)} ≠ số chuyển ${transferAmount.toFixed(2)} ` +
        `(nguồn: ${transferSource}, dung sai cho phép ${cfg.tolerancePct * 100}%). ` +
        `Bước tiếp theo theo SOP-10: rà pipeline trước, lỗi Amazon thì mở case.`,
    });
  }

  return {
    sellerAccountId: input.sellerAccountId,
    settlement,
    events,
    groups,
    calcTotal,
    transferAmount,
    transferSource,
    reconcileDiff,
    takeRate: feeTakeRate(groups),
    tacos: tacos(groups),
    totalTakeRate: totalTakeRate(groups),
    reserveHold: Math.round(productSales * cfg.reserveRate * 100) / 100,
    alerts,
    warnings,
    metrics: {
      lines: parsed.lines.length,
      productSales,
      amazonFees,
      advertising,
    },
  };
}

/* ============================================================================
 * Chạy thật
 * ==========================================================================*/

export async function runFinanceSync(
  input: { sellerAccountId: string; settlementReportText: string; now?: Date },
  adapter: DbAdapter,
): Promise<FinanceSnapshot & { job: SyncJobRecord }> {
  const now = input.now ?? new Date();
  const snapshot = buildFinanceSnapshot(input);

  const job: SyncJobRecord = {
    sellerAccountId: input.sellerAccountId,
    jobType: "finance.sync",
    status: "running",
    startedAt: now,
    payload: {
      settlementId: snapshot.settlement?.settlementId ?? null,
      lines: snapshot.metrics.lines,
      reconcileDiff: snapshot.reconcileDiff,
    },
  };
  await adapter.recordSyncJob(job);

  try {
    if (snapshot.settlement) await adapter.upsertSettlement(snapshot.settlement);
    if (snapshot.settlement) {
      // Kỳ settlement là dữ liệu CHỐT (immutable) → thay toàn bộ dòng tiền của kỳ
      // khi import lại, tránh nhân đôi dòng tiền.
      await adapter.replaceFinancialEvents(
        input.sellerAccountId,
        snapshot.settlement.settlementId,
        snapshot.events,
      );
    }
    for (const alert of snapshot.alerts) await adapter.upsertAlert(alert);

    job.status = "done";
    job.finishedAt = new Date();
    await adapter.recordSyncJob(job);
  } catch (e) {
    job.status = "failed";
    job.finishedAt = new Date();
    job.lastError = (e as Error).message;
    await adapter.recordSyncJob(job);
    throw e;
  }

  return { ...snapshot, job };
}
