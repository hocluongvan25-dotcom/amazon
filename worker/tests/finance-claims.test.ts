/**
 * Test F3 (bồi hoàn FBA / SOP-09) + F4 (lợi nhuận SKU) — thuần, không cần mạng.
 * Bám cột thật của:
 *   • GET_FBA_REIMBURSEMENTS_DATA
 *   • GET_LEDGER_DETAIL_VIEW_DATA
 *   • dòng tiền đã quyết toán (finance.financial_events) + catalog.cost_inputs
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MockDbAdapter } from "../src/db/adapter.ts";
import {
  buildSkuProfitRows,
  claimAgeHours,
  classifyLedgerEvent,
  detectClaims,
  estimateClaimAmount,
  overdueClaims,
  reconcileClaims,
  summarizeClaims,
  summarizeProfit,
  CLAIM_SLA_HOURS,
} from "../src/domain/finance-claims.ts";
import { runFinanceClaims } from "../src/jobs/finance-claims.job.ts";
import { monthRange, runFinanceClaimsCli } from "../src/runtime/run-finance-claims.ts";
import { parseLedgerReport } from "../src/reports/inventory-ledger.parser.ts";
import { parseReimbursementsReport, reimbursementDedupeKey } from "../src/reports/reimbursements.parser.ts";

const SELLER = "11111111-1111-4111-8111-111111111111";

/* ================================================================== */
/* Parser report reimbursements                                        */
/* ================================================================== */

const REIMB_TSV = [
  "approval-date\treimbursement-id\tcase-id\tamazon-order-id\treason\tsku\tfnsku\tasin\tproduct-name\tcondition\tcurrency-unit\tamount-per-unit\tamount-total\tquantity-reimbursed-cash\tquantity-reimbursed-inventory\tquantity-reimbursed-total\toriginal-reimbursement-id\toriginal-reimbursement-type",
  "2026-09-01\tREIMB-1\tCASE-1\t111-1\tLost\tSKU-A\tX00A\tB0A\tTúi du lịch\tNew\tUSD\t12,50\t25,00\t2\t0\t2\t\t",
  "2026-09-02\tREIMB-2\tCASE-2\t\tDamaged\tSKU-B\tX00B\tB0B\tTúi nhỏ\tUsed\tUSD\t9.99\t9.99\t0\t1\t1\t\t",
].join("\n");

test("parse report reimbursements: cột Amazon, số kiểu local, BOM, khoá chống trùng", () => {
  const parsed = parseReimbursementsReport("\uFEFF" + REIMB_TSV);
  assert.equal(parsed.warnings.length, 0);
  assert.equal(parsed.lines.length, 2);
  assert.equal(parsed.currency, "USD");
  assert.equal(parsed.totalAmount, 34.99); // 25 + 9.99
  assert.equal(parsed.lines[0].amountTotal, 25); // "25,00" kiểu EU
  assert.equal(parsed.lines[0].amountPerUnit, 12.5);
  assert.equal(parsed.lines[0].quantityReimbursedCash, 2);
  assert.equal(parsed.lines[1].quantityReimbursedInventory, 1);
  assert.equal(parsed.lines[0].dedupeKey, reimbursementDedupeKey({ reimbursementId: "REIMB-1", sku: "SKU-A", reason: "Lost", amountTotal: 25 }));
});

test("parse report reimbursements: thiếu cột bắt buộc → cảnh báo, không trả dòng rác", () => {
  const parsed = parseReimbursementsReport("approval-date\tsku\n2026-09-01\tSKU-A");
  assert.equal(parsed.lines.length, 0);
  assert.ok(parsed.warnings.some((w) => w.includes("Thiếu cột bắt buộc")));
  assert.equal(parseReimbursementsReport("").warnings[0], "Report rỗng");
});

/* ================================================================== */
/* Parser report ledger                                                */
/* ================================================================== */

const LEDGER_TSV = [
  "Date\tFNSKU\tASIN\tMSKU\tTitle\tEventType\tReferenceID\tQuantity\tFulfillmentCenter\tDisposition\tReason\tCountry\tReconciledQuantity\tUnreconciledQuantity",
  "2026-09-05\tX00A\tB0A\tSKU-A\tTúi\tAdjustments\tREF-1\t-3\tPHX7\tSELLABLE\tMISSING\tUS\t-3\t-3",
  "2026-09-05\tX00C\tB0C\tSKU-C\tTúi nhỏ\tAdjustments\tREF-2\t-1\tPHX7\tDEFECTIVE\tDAMAGED\tUS\t-1\t-1",
  "2026-09-05\tX00D\tB0D\tSKU-D\tTúi to\tReceipts\tREF-3\t-2\tPHX7\tSELLABLE\tMISSING\tUS\t-2\t-2",
  "2026-09-06\tX00A\tB0A\tSKU-A\tTúi\tShipments\tREF-4\t-5\tPHX7\tSELLABLE\tORDERED\tUS\t-5\t0",
  "2026-09-06\tX00E\tB0E\tSKU-E\tTúi\tAdjustments\tREF-5\t2\tPHX7\tSELLABLE\tFOUND\tUS\t2\t0",
].join("\n");

test("parse report ledger: cột Amazon, số âm, đếm theo EventType", () => {
  const parsed = parseLedgerReport(LEDGER_TSV);
  assert.equal(parsed.warnings.length, 0);
  assert.equal(parsed.rows.length, 5);
  assert.equal(parsed.rows[0].sku, "SKU-A");
  assert.equal(parsed.rows[0].quantity, -3);
  assert.deepEqual(parsed.eventCounts, { Adjustments: 3, Receipts: 1, Shipments: 1 });
});

/* ================================================================== */
/* F3 — phân loại + phát hiện                                           */
/* ================================================================== */

test("classifyLedgerEvent: chỉ mất/hư mới thành claim, hàng bán/tìm thấy thì bỏ", () => {
  assert.equal(classifyLedgerEvent({ eventType: "Shipments", quantity: -5 }), null); // đã bán
  assert.equal(classifyLedgerEvent({ eventType: "Adjustments", reason: "FOUND", quantity: 2 }), null);
  assert.equal(classifyLedgerEvent({ eventType: "Adjustments", reason: "MISSING", quantity: -3 }), "lost_fc");
  assert.equal(
    classifyLedgerEvent({ eventType: "Adjustments", reason: "DAMAGED", disposition: "DEFECTIVE", quantity: -1 }),
    "damaged_fc",
  );
  assert.equal(classifyLedgerEvent({ eventType: "Receipts", reason: "MISSING", quantity: -2 }), "inbound_missing");
  assert.equal(
    classifyLedgerEvent({ eventType: "CustomerReturns", reason: "NOT_RECEIVED", quantity: -1 }),
    "lost_fc",
  );
  assert.equal(classifyLedgerEvent({ eventType: "Adjustments", reason: "UNKNOWN", quantity: -1 }), "other");
  // số dương (nhập thêm) không bao giờ là claim
  assert.equal(classifyLedgerEvent({ eventType: "Receipts", quantity: 10 }), null);
});

test("estimateClaimAmount: thiếu giá vốn → null, KHÔNG đoán; giá vốn 0 vẫn là 0", () => {
  assert.equal(estimateClaimAmount({ quantity: 3, unitCost: 12.5 }), 37.5);
  assert.equal(estimateClaimAmount({ quantity: 3, unitCost: null }), null);
  assert.equal(estimateClaimAmount({ quantity: 3, unitCost: undefined }), null);
  assert.equal(estimateClaimAmount({ quantity: 0, unitCost: 12.5 }), null);
  assert.equal(estimateClaimAmount({ quantity: 2, unitCost: 0 }), 0);
});

test("detectClaims: gộp dòng cùng ReferenceID+SKU, bỏ dòng không phải claim, đánh dấu thiếu giá vốn", () => {
  const rows = parseLedgerReport(LEDGER_TSV).rows;
  const { claims, skipped } = detectClaims({
    sellerAccountId: SELLER,
    marketplaceId: "ATVPDKIKX0DER",
    rows,
    unitCostBySku: { "SKU-A": 12.5, "SKU-D": 4 },
  });

  assert.equal(skipped, 2); // Shipments + Adjustments FOUND
  const byRef = Object.fromEntries(claims.map((c) => [c.sourceRef, c]));
  assert.equal(claims.length, 3);
  assert.equal(byRef["REF-1"].category, "lost_fc");
  assert.equal(byRef["REF-1"].quantity, 3);
  assert.equal(byRef["REF-1"].estimatedAmount, 37.5);
  assert.equal(byRef["REF-2"].category, "damaged_fc");
  assert.equal(byRef["REF-2"].unitCost, null);
  assert.equal(byRef["REF-2"].estimatedAmount, null); // thiếu giá vốn
  assert.equal(byRef["REF-3"].category, "inbound_missing");
  assert.equal(byRef["REF-3"].estimatedAmount, 8); // 2 × 4
  // gộp nhiều dòng cùng tham chiếu
  const merged = detectClaims({
    sellerAccountId: SELLER,
    marketplaceId: "ATVPDKIKX0DER",
    rows: [
      { date: "2026-09-05", sku: "SKU-A", fnsku: "X00A", asin: "B0A", eventType: "Adjustments", referenceId: "REF-X", quantity: -1, disposition: "SELLABLE", reason: "MISSING" },
      { date: "2026-09-05", sku: "SKU-A", fnsku: "X00A", asin: "B0A", eventType: "Adjustments", referenceId: "REF-X", quantity: -2, disposition: "SELLABLE", reason: "MISSING" },
    ],
    unitCostBySku: { "SKU-A": 10 },
  });
  assert.equal(merged.claims.length, 1);
  assert.equal(merged.claims[0].quantity, 3);
  assert.equal(merged.claims[0].estimatedAmount, 30);
});

test("SLA SOP-09: quá 48h thì tính là quá hạn (cả to_claim lẫn filed)", () => {
  const now = new Date("2026-09-12T10:00:00Z");
  assert.equal(CLAIM_SLA_HOURS, 48);
  assert.equal(claimAgeHours({ detectedAt: "2026-09-10T10:00:00Z" }, now), 48);
  const overdue = overdueClaims(
    [
      { id: "c1", sku: "SKU-A", status: "filed", detectedAt: "2026-09-05T10:00:00Z", filedAt: "2026-09-09T10:00:00Z" },
      { id: "c2", sku: "SKU-B", status: "filed", detectedAt: "2026-09-12T01:00:00Z", filedAt: "2026-09-12T01:00:00Z" },
      { id: "c3", sku: "SKU-C", status: "paid", detectedAt: "2026-08-01T00:00:00Z" },
    ],
    now,
  );
  assert.deepEqual(overdue.map((o) => o.id), ["c1"]);
  assert.equal(overdue[0].ageHours, 72);
});

test("summarizeClaims: giá trị đang mở, tiền đã về, số khoản thiếu giá vốn", () => {
  const summary = summarizeClaims([
    { status: "suspected", estimatedAmount: 37.5, unitCost: 12.5 },
    { status: "suspected", estimatedAmount: null, unitCost: null },
    { status: "filed", estimatedAmount: 20, unitCost: 10 },
    { status: "paid", estimatedAmount: 30, unitCost: 15, reimbursedAmount: 30 },
    { status: "rejected", estimatedAmount: 10, unitCost: 5 },
  ]);
  assert.equal(summary.total, 5);
  assert.equal(summary.byStatus.suspected, 2);
  assert.equal(summary.openValue, 57.5); // 37.5 + 20 (bỏ rejected/paid/closed)
  assert.equal(summary.paidValue, 30);
  assert.equal(summary.missingCostCount, 1);
});

test("reconcileClaims: khớp theo mã reimbursement hoặc SKU+số tiền, chỉ ra phần lệch", () => {
  const result = reconcileClaims({
    claims: [
      { id: "c1", sku: "SKU-A", status: "paid", reimbursedAmount: 25, reimbursementId: "REIMB-1" },
      { id: "c2", sku: "SKU-B", status: "filed", reimbursedAmount: 9.99, reimbursementId: null },
      { id: "c3", sku: "SKU-C", status: "filed", reimbursedAmount: 5, reimbursementId: null },
    ],
    reimbursements: [
      { reimbursementId: "REIMB-1", sku: "SKU-A", amountTotal: 25 },
      { reimbursementId: "REIMB-2", sku: "SKU-B", amountTotal: 9.99 },
      { reimbursementId: "REIMB-9", sku: "SKU-Z", amountTotal: 3 },
    ],
  });
  assert.equal(result.matched.length, 2);
  assert.deepEqual(result.claimsWithoutReimbursement, ["c3"]);
  assert.deepEqual(result.reimbursementsWithoutClaim.map((r) => r.reimbursementId), ["REIMB-9"]);
  assert.equal(result.diffTotal, 0);
});

/* ================================================================== */
/* F4 — lợi nhuận SKU                                                  */
/* ================================================================== */

test("buildSkuProfitRows: doanh thu − hoàn − phí − giá vốn; thiếu giá vốn → lãi NULL", () => {
  const rows = buildSkuProfitRows({
    minDay: "2026-09-05",
    maxDay: "2026-09-05",
    events: [
      { sku: "SKU-A", eventType: "ProductSale", amount: 200, quantity: 4, eventDate: "2026-09-05T10:00:00Z" },
      { sku: "SKU-A", eventType: "ShippingCredit", amount: 8, eventDate: "2026-09-05T10:05:00Z" },
      { sku: "SKU-A", eventType: "Refund", amount: -25, eventDate: "2026-09-05T11:00:00Z" },
      { sku: "SKU-A", eventType: "PromotionRebate", amount: -5, eventDate: "2026-09-05T11:30:00Z" },
      { sku: "SKU-A", eventType: "ReferralFee", amount: -30, eventDate: "2026-09-05T12:00:00Z" },
      { sku: "SKU-A", eventType: "FBAFee", amount: -12, eventDate: "2026-09-05T12:01:00Z" },
      { sku: "SKU-B", eventType: "ProductSale", amount: 50, quantity: 1, eventDate: "2026-09-05T10:00:00Z" },
      // dòng không gắn SKU (transfer/subscription) không được vào F4
      { sku: null, eventType: "Transfer", amount: -1000, eventDate: "2026-09-05T13:00:00Z" },
      // ngoài khoảng ngày
      { sku: "SKU-A", eventType: "ProductSale", amount: 999, quantity: 9, eventDate: "2026-09-04T23:00:00Z" },
    ],
    unitCostBySku: { "SKU-A": 12.5, "SKU-B": null },
  });

  assert.equal(rows.length, 2);
  const a = rows.find((r) => r.sku === "SKU-A")!;
  assert.equal(a.units, 4);
  assert.equal(a.revenue, 208);
  assert.equal(a.refunds, -25);
  assert.equal(a.amazonFees, -42);
  assert.equal(a.cogs, 50); // 4 × 12.5
  assert.equal(a.grossProfit, 86); // 208 − 25 − 5 − 42 − 50
  assert.equal(a.feeSource, "settled");

  const b = rows.find((r) => r.sku === "SKU-B")!;
  assert.equal(b.cogs, null);
  assert.equal(b.grossProfit, null); // thiếu giá vốn → KHÔNG bịa lãi
});

test("buildSkuProfitRows: ads chỉ có khi Module 5 đồng bộ; phí ước tính phải gắn nhãn fees_api", () => {
  const rows = buildSkuProfitRows({
    minDay: "2026-09-05",
    events: [{ sku: "SKU-A", eventType: "ProductSale", amount: 100, quantity: 2, eventDate: "2026-09-05T10:00:00Z" }],
    unitCostBySku: { "SKU-A": 10 },
    adsSpendBySkuDay: { "SKU-A|2026-09-05": 7.5 },
    feeEstimatesBySku: { "SKU-A": -18 },
  });
  assert.equal(rows[0].adsSpend, 7.5);
  assert.equal(rows[0].amazonFees, -18); // chưa có phí thật → dùng ước tính
  assert.equal(rows[0].feeSource, "fees_api"); // và phải nói rõ là ước tính
  assert.equal(rows[0].grossProfit, 62); // 100 − 18 − 20 (cogs 2 × 10)

  const noAds = buildSkuProfitRows({
    minDay: "2026-09-05",
    events: [{ sku: "SKU-A", eventType: "ProductSale", amount: 100, quantity: 2, eventDate: "2026-09-05T10:00:00Z" }],
    unitCostBySku: { "SKU-A": 10 },
  });
  assert.equal(noAds[0].adsSpend, null); // Module 5 chưa đồng bộ = null, không phải 0
  assert.equal(noAds[0].feeSource, "unavailable");
});

test("summarizeProfit: chỉ ra SKU lỗ, số dòng thiếu giá vốn; tổng lãi null khi không có giá vốn", () => {
  const rows = buildSkuProfitRows({
    minDay: "2026-09-05",
    events: [
      { sku: "SKU-LOSS", eventType: "ProductSale", amount: 20, quantity: 2, eventDate: "2026-09-05T10:00:00Z" },
      { sku: "SKU-LOSS", eventType: "ReferralFee", amount: -3, eventDate: "2026-09-05T10:01:00Z" },
      { sku: "SKU-GAIN", eventType: "ProductSale", amount: 200, quantity: 2, eventDate: "2026-09-05T10:00:00Z" },
      { sku: "SKU-NOCOST", eventType: "ProductSale", amount: 50, quantity: 1, eventDate: "2026-09-05T10:00:00Z" },
    ],
    unitCostBySku: { "SKU-LOSS": 12, "SKU-GAIN": 40, "SKU-NOCOST": null },
  });
  const summary = summarizeProfit(rows);
  assert.equal(summary.revenue, 270);
  assert.equal(summary.fees, -3);
  assert.equal(summary.cogs, 104); // 2×12 + 2×40 (SKU-NOCOST không có giá vốn → không cộng)
  assert.equal(summary.grossProfit, 113); // (20−3−24) + (200−80) — chưa gồm SKU-NOCOST
  assert.deepEqual(summary.lossSkus, [{ sku: "SKU-LOSS", grossProfit: -7 }]);
  assert.equal(summary.missingCostCount, 1);

  const allMissing = summarizeProfit(
    buildSkuProfitRows({ minDay: "2026-09-05", events: [{ sku: "X", eventType: "ProductSale", amount: 10, quantity: 1, eventDate: "2026-09-05T00:00:00Z" }], unitCostBySku: {} }),
  );
  assert.equal(allMissing.grossProfit, null);
  assert.equal(allMissing.cogs, null);
});

/* ================================================================== */
/* Job (I/O qua MockDbAdapter)                                         */
/* ================================================================== */

function seedAdapter(): MockDbAdapter {
  const db = new MockDbAdapter();
  db.effectiveCosts = [
    { sellerAccountId: SELLER, sku: "SKU-A", unitCost: 12.5, currency: "USD", effectiveFrom: "2026-08-01", effectiveTo: null },
    { sellerAccountId: SELLER, sku: "SKU-D", unitCost: 4, currency: "USD", effectiveFrom: "2026-08-01", effectiveTo: null },
  ];
  return db;
}

test("runFinanceClaims: ledger → claim, import reimbursement → đối chiếu + cảnh báo chưa khớp", async () => {
  const db = seedAdapter();
  const report = await runFinanceClaims({
    sellerAccountId: SELLER,
    ledgerReportText: LEDGER_TSV,
    reimbursementsReportText: REIMB_TSV,
    adapter: db,
    now: new Date("2026-09-12T12:00:00Z"),
  });

  assert.equal(report.claims.detected, 3);
  assert.equal(report.claims.inserted, 3);
  assert.equal(report.claims.missingCost, 1);
  assert.equal(report.claims.estimateTotal, 45.5); // 37.5 + 0 + 8
  assert.deepEqual(report.claims.byCategory, { lost_fc: 1, damaged_fc: 1, inbound_missing: 1 });
  assert.equal(report.reimbursements?.inserted, 2);
  assert.equal(report.reimbursements?.totalAmount, 34.99);
  assert.equal(report.reconciliation?.reimbursementsWithoutClaim, 2); // chưa ai khớp
  assert.equal(db.reimbursementClaims.length, 3);
  assert.ok(db.alerts.some((a) => a.ruleCode === "reimbursement_unmatched"));
  assert.equal(db.jobs[db.jobs.length - 1]?.status, "done");
  assert.ok(report.warnings.some((w) => w.includes("Thiếu giá vốn")));
});

test("runFinanceClaims: chạy lại KHÔNG nhân đôi claim, không đụng khoản đã nộp", async () => {
  const db = seedAdapter();
  await runFinanceClaims({ sellerAccountId: SELLER, ledgerReportText: LEDGER_TSV, adapter: db });
  assert.equal(db.reimbursementClaims.length, 3);

  // người dùng đã chuyển 1 khoản sang filed
  db.reimbursementClaims[0].status = "filed";

  const second = await runFinanceClaims({ sellerAccountId: SELLER, ledgerReportText: LEDGER_TSV, adapter: db });
  assert.equal(second.claims.inserted, 0);
  assert.equal(second.claims.refreshed, 2); // 2 khoản còn suspected được cập nhật số liệu
  assert.equal(db.reimbursementClaims.length, 3);
  assert.equal(db.reimbursementClaims[0].status, "filed"); // giữ nguyên việc của con người
});

test("runFinanceClaims: dryRun không ghi gì; F4 ghi lợi nhuận + cảnh báo SKU lỗ", async () => {
  const db = seedAdapter();
  const dry = await runFinanceClaims({
    sellerAccountId: SELLER,
    ledgerReportText: LEDGER_TSV,
    adapter: db,
    dryRun: true,
  });
  assert.equal(dry.claims.detected, 3);
  assert.equal(dry.claims.inserted, 0);
  assert.equal(db.reimbursementClaims.length, 0);

  const withProfit = await runFinanceClaims({
    sellerAccountId: SELLER,
    adapter: db,
    profit: {
      from: "2026-09-05",
      to: "2026-09-05",
      events: [
        { sku: "SKU-A", eventType: "ProductSale", amount: 20, quantity: 2, eventDate: "2026-09-05T10:00:00Z" },
        { sku: "SKU-A", eventType: "FBAFee", amount: -3, eventDate: "2026-09-05T10:01:00Z" },
      ],
    },
    now: new Date("2026-09-12T12:00:00Z"),
  });
  assert.equal(withProfit.mode, "profit-only");
  assert.equal(withProfit.profit?.rows, 1);
  assert.equal(withProfit.profit?.grossProfit, -8); // 20 − 3 − 25
  assert.deepEqual(withProfit.profit?.lossSkus, [{ sku: "SKU-A", grossProfit: -8 }]);
  assert.equal(db.skuProfit.length, 1);
  assert.ok(db.alerts.some((a) => a.ruleCode === "sku_loss"));
});

test("runFinanceClaims: ghi lại cùng ngày thay thế (không cộng dồn) + giá vốn hiệu lực theo ngày", async () => {
  const db = seedAdapter();
  db.effectiveCosts.push({
    sellerAccountId: SELLER,
    sku: "SKU-A",
    unitCost: 20,
    currency: "USD",
    effectiveFrom: "2026-09-10",
    effectiveTo: null,
  });

  const profitInput = {
    from: "2026-09-05",
    to: "2026-09-05" as string,
    events: [{ sku: "SKU-A", eventType: "ProductSale", amount: 100, quantity: 1, eventDate: "2026-09-05T10:00:00Z" }],
  };
  await runFinanceClaims({ sellerAccountId: SELLER, adapter: db, profit: profitInput });
  const first = db.skuProfit[0];
  assert.equal(first.cogs, 12.5); // ngày 05/09 → giá vốn 12.5 (đợt 10/09 chưa hiệu lực)

  await runFinanceClaims({ sellerAccountId: SELLER, adapter: db, profit: profitInput });
  assert.equal(db.skuProfit.length, 1); // replace, không nhân dòng

  const later = await runFinanceClaims({
    sellerAccountId: SELLER,
    adapter: db,
    profit: { ...profitInput, from: "2026-09-10", to: "2026-09-10", events: [{ sku: "SKU-A", eventType: "ProductSale", amount: 100, quantity: 1, eventDate: "2026-09-10T10:00:00Z" }] },
  });
  assert.equal(later.profit?.rows, 1);
  assert.equal(db.skuProfit.find((r) => r.day === "2026-09-10")?.cogs, 20);
});


/* ================================================================== */
/* Runner CLI                                                          */
/* ================================================================== */

test("monthRange: YYYY-MM → ngày đầu/cuối tháng, chặn định dạng sai", () => {
  assert.deepEqual(monthRange("2026-09"), { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(monthRange("2026-02"), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(monthRange("2024-02"), { from: "2024-02-01", to: "2024-02-29" }); // năm nhuận
  assert.throws(() => monthRange("09-2026"), /YYYY-MM/);
});

test("runner CLI: chưa có report → nói rõ cách truyền file, không ghi gì", async () => {
  const db = new MockDbAdapter();
  const out: string[] = [];
  const result = await runFinanceClaimsCli({
    sellerAccountId: SELLER,
    adapter: db,
    stdout: { write: (s) => void out.push(s) },
  });
  assert.equal(result.report, null);
  assert.equal(db.reimbursementClaims.length, 0);
  assert.ok(out.join("").includes("--ledger=<file"));
});

test("runner CLI --dry-run: đọc file report thật, chạy trong bộ nhớ, KHÔNG ghi DB", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vexim-f3-"));
  const ledgerPath = join(dir, "ledger.tsv");
  const reimbPath = join(dir, "reimb.tsv");
  writeFileSync(ledgerPath, LEDGER_TSV, "utf8");
  writeFileSync(reimbPath, REIMB_TSV, "utf8");

  const db = seedAdapter();
  const out: string[] = [];
  const result = await runFinanceClaimsCli({
    sellerAccountId: SELLER,
    ledgerFile: ledgerPath,
    reimbursementsFile: reimbPath,
    month: "2026-09",
    dryRun: true,
    adapter: db,
    stdout: { write: (s) => void out.push(s) },
  });

  assert.equal(result.summary.detected, 3);
  assert.equal(result.summary.inserted, 0);
  assert.equal(db.reimbursementClaims.length, 0); // dry-run không ghi
  assert.ok(out.join("").includes("KHÔNG ghi DB thật"));
});
