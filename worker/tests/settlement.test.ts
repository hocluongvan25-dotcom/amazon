/**
 * Test Module 6 — parser report settlement V2 + job đồng bộ tài chính.
 * Khoá: số kiểu local (95,00 / 1.234,56), nhóm phí khớp domain finance.ts,
 * đối soát trừ đúng dòng Transfer, và thay (không cộng dồn) dòng tiền khi import lại.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MockDbAdapter } from "../src/db/adapter.ts";
import {
  DEFAULT_FINANCE_SYNC_CONFIG,
  buildFinanceSnapshot,
  financialEventType,
  runFinanceSync,
} from "../src/jobs/finance-sync.job.ts";
import {
  GROUP_LABELS,
  classifySettlementLine,
  parseLocalizedAmount,
  parseSettlementReport,
  settlementGroups,
} from "../src/reports/settlement.parser.ts";
import { RECONCILE_TOLERANCE_PCT, netTransfer } from "../src/domain/finance.ts";

/* ============================================================================
 * Số kiểu local — điểm dễ sai nhất của report settlement V2
 * ==========================================================================*/

describe("parseLocalizedAmount", () => {
  test("US: dấu chấm thập phân", () => {
    assert.equal(parseLocalizedAmount("95.00"), 95);
    assert.equal(parseLocalizedAmount("129.99"), 129.99);
  });
  test("EU: dấu phẩy thập phân (ví dụ chính trong tài liệu Amazon: 95,00)", () => {
    assert.equal(parseLocalizedAmount("95,00"), 95);
    assert.equal(parseLocalizedAmount("1.234,56"), 1234.56);
  });
  test("US có phân cách nghìn", () => {
    assert.equal(parseLocalizedAmount("1,234.56"), 1234.56);
  });
  test("một dấu + 3 chữ số → phân cách nghìn, KHÔNG phải thập phân", () => {
    assert.equal(parseLocalizedAmount("1,234"), 1234);
    assert.equal(parseLocalizedAmount("1.234"), 1234);
  });
  test("âm và ngoặc đơn (một số hệ thống kế toán)", () => {
    assert.equal(parseLocalizedAmount("-95,00"), -95);
    assert.equal(parseLocalizedAmount("(12,34)"), -12.34);
  });
  test("có ký hiệu tiền tệ", () => {
    assert.equal(parseLocalizedAmount("$1,234.50"), 1234.5);
    assert.equal(parseLocalizedAmount("€95,00"), 95);
  });
  test("rỗng/rác → null (không đoán thành 0)", () => {
    assert.equal(parseLocalizedAmount(""), null);
    assert.equal(parseLocalizedAmount(null), null);
    assert.equal(parseLocalizedAmount("không-phải-số"), null);
  });
});

/* ============================================================================
 * Fixture report V2
 * ==========================================================================*/

const HEADER = [
  "settlement-id", "settlement-start-date", "settlement-end-date", "deposit-date", "total-amount",
  "currency", "transaction-type", "order-id", "merchant-order-id", "adjustment-id", "shipment-id",
  "marketplace-name", "amount-type", "amount-description", "amount", "fulfillment-id", "posted-date",
  "posted-date-time", "order-item-code", "merchant-order-item-id", "merchant-adjustment-item-id",
  "sku", "quantity-purchased", "promotion-id",
].join("\t");

// Kỳ 12948507001: 129.99 − 10 (promo) − 19.50 (referral) − 5.20 (FBA) − 0.50 (storage) − 8 (ads) = 86.79
const SETTLEMENT_TSV = [
  HEADER,
  "12948507001\t2026-08-16\t2026-08-31\t2026-09-02\t86.79\tUSD\tOrder\t111-1111111-1111111\t\t\t\tAmazon.com\tItemPrice\tPrincipal\t129.99\tAFN\t2026-09-01\t2026-09-01T02:00:00Z\toi-1\tmoi-1\t\tXMO-950-BLK\t2\t",
  "12948507001\t2026-08-16\t2026-08-31\t2026-09-02\t86.79\tUSD\tOrder\t111-1111111-1111111\t\t\t\tAmazon.com\tItemPrice\tPromotion\t-10.00\tAFN\t2026-09-01\t2026-09-01T02:00:00Z\toi-1\tmoi-1\t\tXMO-950-BLK\t2\tPROMO-1",
  "12948507001\t2026-08-16\t2026-08-31\t2026-09-02\t86.79\tUSD\tOrder\t111-1111111-1111111\t\t\t\tAmazon.com\tItemFees\tReferralFee\t-19.50\tAFN\t2026-09-01\t2026-09-01T02:00:00Z\toi-1\tmoi-1\t\tXMO-950-BLK\t2\t",
  "12948507001\t2026-08-16\t2026-08-31\t2026-09-02\t86.79\tUSD\tOrder\t111-1111111-1111111\t\t\t\tAmazon.com\tItemFees\tFBAPerUnitFulfillmentFee\t-5.20\tAFN\t2026-09-01\t2026-09-01T02:00:00Z\toi-1\tmoi-1\t\tXMO-950-BLK\t2\t",
  "12948507001\t2026-08-16\t2026-08-31\t2026-09-02\t86.79\tUSD\tOrder\t111-1111111-1111111\t\t\t\tAmazon.com\tItemFees\tStorageFee\t-0.50\tAFN\t2026-09-01\t2026-09-01T02:00:00Z\t\t\t\tXMO-950-BLK\t2\t",
  "12948507001\t2026-08-16\t2026-08-31\t2026-09-02\t86.79\tUSD\tOrder\t111-1111111-1111111\t\t\t\tAmazon.com\tCost of Advertising\t\t-8.00\tAFN\t2026-09-01\t2026-09-01T02:00:00Z\t\t\t\t\t\t",
  "12948507001\t2026-08-16\t2026-08-31\t2026-09-02\t86.79\tUSD\tTransfer\t\t\t\t\tAmazon.com\tTransfer\tPrevious Reserve Amount Balance\t86.79\t\t2026-09-02\t2026-09-02T03:00:00Z\t\t\t\t\t\t",
].join("\n");

// Cùng kỳ nhưng định dạng EU (dấu phẩy thập phân + phân cách nghìn dấu chấm)
const SETTLEMENT_EU_TSV = [
  HEADER,
  "12948507002\t2026-08-16\t2026-08-31\t2026-09-02\t1.234,56\tEUR\tOrder\t222-2222222-2222222\t\t\t\tAmazon.de\tItemPrice\tPrincipal\t1.500,00\tAFN\t2026-09-01\t2026-09-01T02:00:00Z\toi-9\tmoi-9\t\tVPN-220-PRO\t1\t",
  "12948507002\t2026-08-16\t2026-08-31\t2026-09-02\t1.234,56\tEUR\tOrder\t222-2222222-2222222\t\t\t\tAmazon.de\tItemFees\tReferralFee\t-225,00\tAFN\t2026-09-01\t2026-09-01T02:00:00Z\toi-9\tmoi-9\t\tVPN-220-PRO\t1\t",
  "12948507002\t2026-08-16\t2026-08-31\t2026-09-02\t1.234,56\tEUR\tOrder\t222-2222222-2222222\t\t\t\tAmazon.de\tCost of Advertising\t\t-40,44\tAFN\t2026-09-01\t2026-09-01T02:00:00Z\t\t\t\t\t\t",
  "12948507002\t2026-08-16\t2026-08-31\t2026-09-02\t1.234,56\tEUR\tTransfer\t\t\t\t\tAmazon.de\tTransfer\t\t1.234,56\t\t2026-09-02\t2026-09-02T03:00:00Z\t\t\t\t\t\t",
].join("\n");

/* ============================================================================
 * Parse + nhóm
 * ==========================================================================*/

describe("parseSettlementReport", () => {
  test("đọc header kỳ + 7 dòng tiền, tổng khớp", () => {
    const res = parseSettlementReport(SETTLEMENT_TSV);
    assert.equal(res.settlementId, "12948507001");
    assert.equal(res.startDate, "2026-08-16");
    assert.equal(res.depositDate, "2026-09-02");
    assert.equal(res.totalAmount, 86.79);
    assert.equal(res.currency, "USD");
    assert.equal(res.lines.length, 7);
    assert.equal(res.warnings.length, 0);
  });

  test("file EU parse đúng số kiểu local", () => {
    const res = parseSettlementReport(SETTLEMENT_EU_TSV);
    assert.equal(res.currency, "EUR");
    assert.equal(res.totalAmount, 1234.56);
    assert.equal(res.lines[0].amount, 1500);
    assert.equal(res.lines[2].amount, -40.44);
  });

  test("report rỗng / thiếu cột bắt buộc → warnings rõ", () => {
    assert.match(parseSettlementReport("").warnings[0], /rỗng/);
    const bad = parseSettlementReport("settlement-id\tamount-type\n1\tItemPrice");
    assert.match(bad.warnings.join(" "), /Thiếu cột bắt buộc/);
  });

  test("trộn nhiều settlement-id trong 1 file → cảnh báo, không âm thầm gộp", () => {
    const rows = SETTLEMENT_TSV.split("\n");
    const mixed = [HEADER, ...rows.slice(1, -1), rows.at(-1)!.replace("12948507001", "999")].join("\n");
    const res = parseSettlementReport(mixed);
    assert.match(res.warnings.join(" "), /settlement-id khác nhau/);
  });

  test("amount không parse được → bỏ dòng + cảnh báo (không tính là 0)", () => {
    const tsv = [HEADER, `9\t\t\t\t\tUSD\tOrder\t\t\t\t\t\tItemPrice\tPrincipal\tN/A\t\t\t\t\t\t\t\t\t`].join("\n");
    const res = parseSettlementReport(tsv);
    assert.equal(res.lines.length, 0);
    assert.match(res.warnings.join(" "), /không parse được/);
  });
});

describe("classifySettlementLine / settlementGroups", () => {
  const res = parseSettlementReport(SETTLEMENT_TSV);

  test("nhóm đúng theo amount-type/amount-description", () => {
    assert.equal(classifySettlementLine({ amountType: "ItemPrice", amountDescription: "Principal" }), GROUP_LABELS.productSales);
    assert.equal(classifySettlementLine({ amountType: "ItemPrice", amountDescription: "Promotion" }), GROUP_LABELS.promotions);
    assert.equal(classifySettlementLine({ amountType: "ItemFees", amountDescription: "ReferralFee" }), GROUP_LABELS.fees);
    assert.equal(classifySettlementLine({ amountType: "Cost of Advertising" }), GROUP_LABELS.advertising);
    assert.equal(classifySettlementLine({ amountType: "Transfer" }), GROUP_LABELS.transfers);
    assert.equal(classifySettlementLine({ amountType: "LoạiMớiCủaAmazon" }), GROUP_LABELS.other);
  });

  test("gộp nhóm cấp 1 + children cấp 2, giữ đúng nhãn domain finance dùng", () => {
    const groups = settlementGroups(res.lines);
    const labels = groups.map((g) => g.label);
    assert.deepEqual(labels, [
      "Product sales", "Promotional rebates", "Amazon Fees", "Advertising", "Transfers",
    ]);
    assert.equal(groups.find((g) => g.label === "Product sales")!.amount, 129.99);
    assert.equal(groups.find((g) => g.label === "Amazon Fees")!.amount, -25.2);
    const fees = groups.find((g) => g.label === "Amazon Fees")!;
    assert.deepEqual(fees.children!.map((c) => c.label).sort(), ["FBAPerUnitFulfillmentFee", "ReferralFee", "StorageFee"]);
  });
});

/* ============================================================================
 * Snapshot + đối soát (SOP-10)
 * ==========================================================================*/

describe("buildFinanceSnapshot", () => {
  const NOW = new Date("2026-09-10T03:00:00Z");

  test("kỳ khớp → không alert, take rate/TACOS tính từ nhóm", () => {
    const snap = buildFinanceSnapshot({ sellerAccountId: "shop-1", settlementReportText: SETTLEMENT_TSV, now: NOW });
    assert.equal(snap.settlement!.settlementId, "12948507001");
    assert.equal(snap.settlement!.status, "deposited");
    assert.equal(snap.transferSource, "transfer-line");
    assert.equal(snap.transferAmount, 86.79);
    // Tổng các nhóm KHÁC Transfer = 129.99 − 10 − 25.20 − 8 = 86.79 → khớp dung sai
    assert.equal(snap.calcTotal, 86.79);
    assert.equal(snap.reconcileDiff, null);
    assert.equal(snap.alerts.length, 0);
    assert.equal(snap.takeRate, 19.4); // 25.20 / 129.99
    assert.equal(snap.tacos, 6.2); // 8 / 129.99
    assert.equal(snap.metrics.lines, 7);
  });

  test("kỳ lệch → alert reconciliation_mismatch mức red kèm % lệch", () => {
    const broken = SETTLEMENT_TSV.replace(
      "\tTransfer\tPrevious Reserve Amount Balance\t86.79\t",
      "\tTransfer\tPrevious Reserve Amount Balance\t60.00\t",
    ).replace(/\t86\.79\tUSD/g, "\t60.00\tUSD");
    const snap = buildFinanceSnapshot({ sellerAccountId: "shop-1", settlementReportText: broken, now: NOW });
    assert.equal(snap.transferAmount, 60);
    assert.equal(snap.reconcileDiff !== null, true);
    assert.equal(snap.alerts.length, 1);
    assert.equal(snap.alerts[0].ruleCode, "reconciliation_mismatch");
    assert.equal(snap.alerts[0].severity, "red");
    assert.match(snap.alerts[0].detail, /SOP-10/);
  });

  test("không có dòng Transfer → đối soát bằng total-amount", () => {
    const noTransfer = SETTLEMENT_TSV.split("\n").slice(0, -1).join("\n");
    const snap = buildFinanceSnapshot({ sellerAccountId: "shop-1", settlementReportText: noTransfer, now: NOW });
    assert.equal(snap.transferSource, "total-amount");
    assert.equal(snap.transferAmount, 86.79);
    assert.equal(snap.reconcileDiff, null);
  });

  test("config bám bản report KHÔNG deprecated + rate Finances API", () => {
    assert.equal(DEFAULT_FINANCE_SYNC_CONFIG.settlementReportType, "GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2");
    assert.equal(DEFAULT_FINANCE_SYNC_CONFIG.deprecatedSettlementReportTypes.includes("GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE"), true);
    assert.equal(DEFAULT_FINANCE_SYNC_CONFIG.financialEventsRequestsPerSecond, 0.5);
    assert.equal(DEFAULT_FINANCE_SYNC_CONFIG.financialEventsBurst, 30);
    assert.equal(DEFAULT_FINANCE_SYNC_CONFIG.tolerancePct, RECONCILE_TOLERANCE_PCT);
    assert.equal(DEFAULT_FINANCE_SYNC_CONFIG.tolerancePct, 0.01);
  });
});

describe("financialEventType — nhãn cho màn F2", () => {
  const line = (over: Partial<Parameters<typeof financialEventType>[0]>) => ({
    settlementId: "s", settlementStartDate: null, settlementEndDate: null, depositDate: null,
    totalAmount: null, currency: "USD", transactionType: "Order", orderId: null, merchantOrderId: null,
    adjustmentId: null, shipmentId: null, marketplaceName: null, amountType: "ItemPrice",
    amountDescription: "Principal", amount: 1, fulfillmentId: null, postedDate: null, postedDateTime: null,
    orderItemCode: null, merchantOrderItemId: null, merchantAdjustmentItemId: null, sku: null,
    quantityPurchased: null, promotionId: null, ...over,
  });

  test("map đúng 8 loại chính", () => {
    assert.equal(financialEventType(line({ amountType: "ItemPrice", amountDescription: "Principal" })), "ProductSale");
    assert.equal(financialEventType(line({ amountType: "ItemPrice", amountDescription: "Promotion" })), "PromotionRebate");
    assert.equal(financialEventType(line({ amountType: "ItemFees", amountDescription: "ReferralFee" })), "ReferralFee");
    assert.equal(financialEventType(line({ amountType: "ItemFees", amountDescription: "FBAPerUnitFulfillmentFee" })), "FBAFee");
    assert.equal(financialEventType(line({ amountType: "ItemFees", amountDescription: "StorageFee" })), "StorageFee");
    assert.equal(financialEventType(line({ amountType: "Cost of Advertising" })), "AdvertisingFee");
    assert.equal(financialEventType(line({ amountType: "Transfer" })), "Transfer");
    assert.equal(financialEventType(line({ amountType: "ItemFees", amountDescription: "Subscription" })), "Subscription");
  });

  test("reimbursement được nhận diện trước các nhóm khác", () => {
    assert.equal(
      financialEventType(line({ amountType: "ItemFees", amountDescription: "FBAReimbursement" })),
      "Reimbursement",
    );
  });

  test("loại lạ → Adjustment (không mất dòng tiền)", () => {
    assert.equal(financialEventType(line({ amountType: "SomethingNew" })), "Adjustment");
  });
});

describe("runFinanceSync — ghi DB", () => {
  const NOW = new Date("2026-09-10T03:00:00Z");

  test("ghi settlement + dòng tiền + sync_jobs", async () => {
    const db = new MockDbAdapter();
    const snap = await runFinanceSync(
      { sellerAccountId: "shop-1", settlementReportText: SETTLEMENT_TSV, now: NOW },
      db,
    );
    assert.equal(db.settlements.length, 1);
    assert.equal(db.financialEvents.length, 7);
    assert.equal(db.jobs.at(-1)!.jobType, "finance.sync");
    assert.equal(db.jobs.at(-1)!.status, "done");
    assert.equal(snap.settlement!.breakdown !== undefined, true);
  });

  test("import lại CÙNG kỳ → thay dòng tiền, KHÔNG nhân đôi tiền", async () => {
    const db = new MockDbAdapter();
    await runFinanceSync({ sellerAccountId: "shop-1", settlementReportText: SETTLEMENT_TSV, now: NOW }, db);
    await runFinanceSync({ sellerAccountId: "shop-1", settlementReportText: SETTLEMENT_TSV, now: NOW }, db);
    assert.equal(db.settlements.length, 1);
    assert.equal(db.financialEvents.length, 7);
    const total = db.financialEvents.reduce((s, e) => s + e.amount, 0);
    assert.equal(Math.round(total * 100) / 100, netTransfer(snap0Groups()));
  });

  test("kỳ lệch → alert được ghi", async () => {
    const broken = SETTLEMENT_TSV.replace(/\t86\.79\tUSD/g, "\t60.00\tUSD").replace(
      "\tTransfer\tPrevious Reserve Amount Balance\t86.79\t",
      "\tTransfer\tPrevious Reserve Amount Balance\t60.00\t",
    );
    const db = new MockDbAdapter();
    await runFinanceSync({ sellerAccountId: "shop-1", settlementReportText: broken, now: NOW }, db);
    assert.equal(db.alerts.length, 1);
    assert.equal(db.alerts[0].ruleCode, "reconciliation_mismatch");
  });
});

/** tổng các dòng của fixture (đã trừ Transfer) = 129.99 − 10 − 25.20 − 8 + 86.79 */
function snap0Groups(): { label: string; amount: number }[] {
  return [
    { label: "Product sales", amount: 129.99 },
    { label: "Promotional rebates", amount: -10 },
    { label: "Amazon Fees", amount: -25.2 },
    { label: "Advertising", amount: -8 },
    { label: "Transfers", amount: 86.79 },
  ];
}
