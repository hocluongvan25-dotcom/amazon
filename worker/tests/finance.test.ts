/**
 * Test Module 6 — nghiệp vụ Tài chính & Đối soát (worker/src/domain/finance.ts).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  RECONCILE_TOLERANCE_PCT,
  estimateOpenPayout,
  estimateReserveHold,
  feeTakeRate,
  netTransfer,
  reconcileSettlement,
  summarizeEvents,
  tacos,
  totalCredits,
  totalDebits,
  totalTakeRate,
} from "../src/domain/finance.ts";

const sampleGroups = [
  { label: "Product sales", amount: 58_240.2 },
  { label: "Shipping credits", amount: 1_240.3 },
  { label: "Gift wrap credits", amount: 42 },
  { label: "Promotional rebates", amount: -682 },
  { label: "Refunds", amount: -3_120.3 },
  {
    label: "Amazon Fees", amount: -9_340.1,
    children: [
      { label: "Referral", amount: -6_120.4 },
      { label: "FBA", amount: -2_540.8 },
      { label: "Other", amount: -678.9 },
    ],
  },
  { label: "Advertising (SP/SD/SB)", amount: -4_860.2 },
  { label: "FBA Reimbursement", amount: 324 },
  { label: "Adjustments", amount: 106.1 },
];

describe("totalCredits / totalDebits / netTransfer", () => {
  test("tổng tiền vào = các nhóm dương (sales + ship + gift + reimbursements + adjustments)", () => {
    // 58240.2 + 1240.3 + 42 + 324 + 106.1 = 59,952.6 (promo rebates là âm)
    const c = totalCredits(sampleGroups);
    assert.ok(Math.abs(c - 59_952.6) < 0.01, `credits ${c} phải ~59,952.60`);
  });

  test("tổng tiền ra = các nhóm âm lấy trị tuyệt đối", () => {
    // 682 + 3120.3 + 9340.1 + 4860.2 = 18,002.6
    const d = totalDebits(sampleGroups);
    assert.ok(Math.abs(d - 18_002.6) < 0.01, `debits ${d} phải ~18,002.60`);
  });

  test("netTransfer khớp chênh lệch vào-ra", () => {
    // 59952.6 - 18002.6 = 41,950.0
    const n = netTransfer(sampleGroups);
    assert.ok(Math.abs(n - 41_950.0) < 0.01, `net ${n} phải ~41,950.00`);
  });

  test("mảng rỗng → 0", () => {
    assert.equal(totalCredits([]), 0);
    assert.equal(totalDebits([]), 0);
    assert.equal(netTransfer([]), 0);
  });
});

describe("reconcileSettlement — đối soát", () =>
  void (() => {
    const net = netTransfer(sampleGroups);
    test("khớp hoàn toàn → null (lệch 0)", () => {
      assert.equal(reconcileSettlement(sampleGroups, net), null);
    });

    test("lệch trong dung sai 1% → null", () => {
      // 1% của net = 419.50; lệch ngay tại mức này cần dùng < (không ≤)
      const diffBelow = net * RECONCILE_TOLERANCE_PCT - 0.01;
      assert.equal(reconcileSettlement(sampleGroups, net + diffBelow), null);
      assert.equal(reconcileSettlement(sampleGroups, net - diffBelow), null);
    });

    test("lệch >1% → trả về chênh lệch (USD)", () => {
      // Sai lệch cố ý $500 (lớn hơn nhiều 1% của 41,950 ≈ $420)
      const r = reconcileSettlement(sampleGroups, net - 500);
      assert.equal(r, 500);
    });

    test("transferAmount bằng 0 → dùng so sánh tuyệt đối để tránh chia 0", () => {
      // net ≈ 41,950, cho transfer 0 → chắc chắn lệch
      assert.notEqual(reconcileSettlement(sampleGroups, 0), null);
    });
  })());

describe("feeTakeRate / tacos / totalTakeRate", () => {
  test("fee take rate = AmazonFees / ProductSales (không tính ads)", () => {
    // fees 9340.10 / sales 58240.20 ≈ 16.0%
    const r = feeTakeRate(sampleGroups);
    assert.ok(r >= 15.9 && r <= 16.1, `fee rate ${r} phải tầm 16.0%`);
  });

  test("TACOS = ads / sales", () => {
    // 4860.20 / 58240.20 ≈ 8.3%
    const r = tacos(sampleGroups);
    assert.ok(r >= 8.2 && r <= 8.4, `TACOS ${r} phải tầm 8.3%`);
  });

  test("total take rate = (fees + ads) / sales", () => {
    const r = totalTakeRate(sampleGroups);
    assert.ok(r >= 24.2 && r <= 24.5, `take ${r} phải tầm 24.4%`);
  });

  test("sales 0 → 0 (tránh chia 0)", () => {
    assert.equal(feeTakeRate([{ label: "Amazon Fees", amount: -100 }]), 0);
    assert.equal(tacos([{ label: "Advertising", amount: -10 }]), 0);
  });
});

describe("estimateReserveHold / estimateOpenPayout", () => {
  test("reserve mặc định 5% sales", () => {
    assert.equal(estimateReserveHold(10_000), 500);
  });

  test("tùy chỉnh reserve rate", () => {
    assert.equal(estimateReserveHold(10_000, 0.03), 300);
  });

  test("payout kỳ mở = pre-reserve − reserve", () => {
    // sales 4820.4, refunds -180.2, fees -720.8, ads -380.4, other 0
    // pre = 4820.4 - 180.2 - 720.8 - 380.4 = 3,539.0
    // reserve 5% của 4820.4 = 241.02 → payout = 3,297.98
    const r = estimateOpenPayout({
      sales: 4_820.4,
      refunds: -180.2,
      amazonFees: -720.8,
      advertising: -380.4,
      otherCharges: 0,
    });
    assert.ok(Math.abs(r.reserveHold - 241.02) < 0.01);
    assert.ok(Math.abs(r.estimatedPayout - 3_297.98) < 0.01);
  });
});

describe("summarizeEvents — tổng hợp từ list events", () => {
  const events = [
    { type: "ProductSale", amount: 29.99 },
    { type: "ReferralFee", amount: -4.5 },
    { type: "FBAFee", amount: -5.2 },
    { type: "ProductSale", amount: 59.98 },
    { type: "ReferralFee", amount: -9.0 },
    { type: "Refund", amount: -29.99 },
    { type: "AdvertisingFee", amount: -312.4 },
    { type: "Reimbursement", amount: 324 },
    { type: "Adjustment", amount: 18.2 },
    { type: "StorageFee", amount: -540 },
    { type: "Subscription", amount: -39.99 },
  ];

  test("phân loại đúng nhóm", () => {
    const s = summarizeEvents(events);
    assert.equal(s.sales, 29.99 + 59.98);
    assert.equal(s.refunds, -29.99);
    assert.equal(s.amazonFees, -4.5 - 5.2 - 9 - 540 - 39.99);
    assert.equal(s.ads, -312.4);
    assert.equal(s.reimbursements, 324);
    assert.equal(s.other, 18.2);
  });

  test("mảng rỗng → tổng 0", () => {
    const s = summarizeEvents([]);
    assert.deepEqual(s, { sales: 0, refunds: 0, amazonFees: 0, ads: 0, reimbursements: 0, other: 0 });
  });

  test("các loại không xác định → vào other", () => {
    const s = summarizeEvents([{ type: "__WEIRD__", amount: 9.99 }]);
    assert.equal(s.other, 9.99);
    assert.equal(s.sales, 0);
  });
});
