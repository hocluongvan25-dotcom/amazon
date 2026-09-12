/**
 * Test Module 2 — nghiệp vụ Giá & Buy Box (worker/src/domain/pricing.ts).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  APPROVAL_DELTA_PCT_THRESHOLD,
  DEFAULT_MIN_MARGIN_RATE,
  DEFAULT_REFERRAL_RATE,
  computeBoxStatus,
  computeFloorPrice,
  computeMargin,
  estimatedRevenueLeakage,
  marginTone,
  priceDeltaPct,
  pricingFlag,
  requiresLeadApproval,
  suggestPrice,
} from "../src/domain/pricing.ts";

describe("computeFloorPrice — giá sàn", () => {
  test("tính đúng với cogs + fba + referral 15% + biên tối thiểu 10%", () => {
    // floor = (62.50 + 15.40) / (1 - 0.15 - 0.10) = 77.90 / 0.75 = 103.87 → ceil cent = 103.87
    const fb = computeFloorPrice({ cogs: 62.5, fbaFee: 15.4 });
    assert.ok(fb.floorPrice >= 103.86 && fb.floorPrice <= 103.88, `floor ${fb.floorPrice} phải ~103.87`);
    assert.equal(fb.referralFeeRate, DEFAULT_REFERRAL_RATE);
    assert.equal(fb.minMarginRate, DEFAULT_MIN_MARGIN_RATE);
  });

  test("khi truyền referral + biên tùy chỉnh thì dùng giá trị đó", () => {
    const fb = computeFloorPrice({
      cogs: 45, fbaFee: 10.2,
      referralFeeRate: 0.08, // category có 8%
      minMarginRate: 0.15,
    });
    // denom = 1 - 0.08 - 0.15 = 0.77 → floor = 55.2 / 0.77 ≈ 71.69
    assert.ok(Math.abs(fb.floorPrice - 71.69) < 0.02);
    assert.equal(fb.referralFeeRate, 0.08);
  });

  test("ném lỗi nếu tổng tỷ lệ ≥ 100% (cấu hình sai)", () => {
    assert.throws(
      () => computeFloorPrice({ cogs: 10, fbaFee: 2, referralFeeRate: 0.95, minMarginRate: 0.1 }),
      /cấu hình sai/,
    );
  });

  test("otherFees được cộng vào cost", () => {
    const fb = computeFloorPrice({ cogs: 10, fbaFee: 2, otherFees: 1 });
    // denom 0.75 → 13 / 0.75 ≈ 17.34
    assert.ok(fb.floorPrice > 13);
  });
});

describe("computeMargin — biên hiện tại", () => {
  const fb = computeFloorPrice({ cogs: 62.5, fbaFee: 15.4 });

  test("biên tại giá sàn bằng đúng biên tối thiểu (10%)", () => {
    const m = computeMargin(fb.floorPrice, fb);
    assert.ok(Math.abs(m - 10) < 0.5, `biên ${m} tại floor phải ≈10% (biên tối thiểu)`);
  });

  test("biên dương khi giá cao hơn sàn", () => {
    const m = computeMargin(129.99, fb);
    assert.ok(m > 20, `biên $129.99 phải >20%, thực tế ${m}%`);
  });

  test("biên âm khi giá thấp hơn (cogs + fba + referral)", () => {
    const m = computeMargin(80, fb);
    assert.ok(m < 0);
  });
});

describe("marginTone", () => {
  test("<0 → red", () => assert.equal(marginTone(-1), "red"));
  test("0 ≤ m < 10 → amber", () => {
    assert.equal(marginTone(0), "amber");
    assert.equal(marginTone(5), "amber");
    assert.equal(marginTone(9.9), "amber");
  });
  test("≥ 10 → green", () => {
    assert.equal(marginTone(10), "green");
    assert.equal(marginTone(25), "green");
  });
});

describe("computeBoxStatus — trạng thái Buy Box", () => {
  test("không có FOEP + không đối thủ → no_box", () => {
    assert.equal(
      computeBoxStatus({ meFeatured: false, foep: null, myPrice: 59.9, lowestCompetitorLanded: null }),
      "no_box",
    );
  });
  test("không giữ featured → lost", () => {
    assert.equal(
      computeBoxStatus({ meFeatured: false, foep: 84.99, myPrice: 89, lowestCompetitorLanded: 84.99 }),
      "lost",
    );
  });
  test("giữ box và giá bằng FOEP → holding", () => {
    assert.equal(
      computeBoxStatus({ meFeatured: true, foep: 129.99, myPrice: 129.99, lowestCompetitorLanded: 132.5 }),
      "holding",
    );
  });
  test("giữ box nhưng giá cao hơn FOEP → at_risk", () => {
    assert.equal(
      computeBoxStatus({ meFeatured: true, foep: 127.49, myPrice: 129.99, lowestCompetitorLanded: 125.99 }),
      "at_risk",
    );
  });
});

describe("priceDeltaPct & requiresLeadApproval", () => {
  test("delta giảm", () => {
    assert.ok(Math.abs(priceDeltaPct(100, 98) - -2) < 0.1);
  });
  test("delta tăng", () => {
    assert.ok(Math.abs(priceDeltaPct(59.9, 64.9) - 8.3) < 0.2);
  });
  test("oldPrice 0 → trả về 0 (tránh chia 0)", () => {
    assert.equal(priceDeltaPct(0, 10), 0);
  });
  test("|Δ| ≤ 2% + trên sàn → không cần trưởng phòng", () => {
    assert.equal(requiresLeadApproval(129.99, 127.99, 100), false);
  });
  test("|Δ| > 2% → cần trưởng phòng", () => {
    assert.equal(requiresLeadApproval(89, 84.99, 70), true);
  });
  test(`Δ nhỏ nhưng dưới sàn → vẫn cần trưởng phòng (ngưỡng ${APPROVAL_DELTA_PCT_THRESHOLD * 100}% chỉ là 1 điều kiện)`, () => {
    assert.equal(requiresLeadApproval(10, 9.5, 12), true);
  });
});

describe("suggestPrice — đề xuất giá tự động", () => {
  test("đang giữ box, giá khớp FOEP → không đề xuất (noop)", () => {
    const r = suggestPrice({
      myPrice: 129.99, foep: 129.99, floorPrice: 102,
      lowestCompetitorLanded: 132.5, meFeatured: true,
    });
    assert.equal(r.noop, true);
    assert.equal(r.suggestedPrice, null);
  });

  test("mất box có FOEP → đề xuất đặt dưới FOEP 1¢, trên giá sàn", () => {
    const r = suggestPrice({
      myPrice: 89, foep: 84.99, floorPrice: 72.1,
      lowestCompetitorLanded: 84.99, meFeatured: false,
    });
    assert.equal(r.noop, false);
    assert.ok(r.suggestedPrice !== null && r.suggestedPrice <= 84.99);
    assert.ok(r.suggestedPrice !== null && r.suggestedPrice >= 72.1);
  });

  test("FOEP thấp hơn giá sàn → clamp về floor, không đề xuất dưới sàn", () => {
    const r = suggestPrice({
      myPrice: 12, foep: 11, floorPrice: 13.2,
      lowestCompetitorLanded: 11, meFeatured: true,
    });
    assert.equal(r.suggestedPrice, 13.2);
    assert.match(r.reason, /clamp về giá sàn/);
  });

  test("không FOEP thì dùng lowestCompetitorLanded", () => {
    const r = suggestPrice({
      myPrice: 45.5, foep: null, floorPrice: 31.8,
      lowestCompetitorLanded: 42.0, meFeatured: false,
    });
    assert.ok(r.suggestedPrice !== null && r.suggestedPrice < 42);
  });

  test("không FOEP, không đối thủ → noop", () => {
    const r = suggestPrice({
      myPrice: 50, foep: null, floorPrice: 30,
      lowestCompetitorLanded: null, meFeatured: false,
    });
    assert.equal(r.noop, true);
  });
});

describe("pricingFlag — cờ ưu tiên", () => {
  test("biên âm → below_floor (ưu tiên cao nhất)", () => {
    assert.equal(
      pricingFlag({ status: "holding", marginPct: -2, velocity30d: 10 }),
      "below_floor",
    );
  });
  test("mất box + velocity cao + >2h → lost_box_high_velocity", () => {
    assert.equal(
      pricingFlag({ status: "lost", marginPct: 15, velocity30d: 30, lostBoxHours: 3 }),
      "lost_box_high_velocity",
    );
  });
  test("mất box nhưng velocity thấp → lost_box (thường)", () => {
    assert.equal(
      pricingFlag({ status: "lost", marginPct: 15, velocity30d: 5, lostBoxHours: 5 }),
      "lost_box",
    );
  });
  test("at_risk → at_risk", () => {
    assert.equal(
      pricingFlag({ status: "at_risk", marginPct: 20, velocity30d: 10 }),
      "at_risk",
    );
  });
  test("holding + biên tốt → ok", () => {
    assert.equal(
      pricingFlag({ status: "holding", marginPct: 20, velocity30d: 10 }),
      "ok",
    );
  });
});

describe("estimatedRevenueLeakage — ước tính tổn thất khi mất box", () => {
  test("chưa mất box → $0", () => {
    assert.equal(estimatedRevenueLeakage(30, 89, 72, 0), 0);
  });
  test("mất box 24h thì leak ≈ velocity * 0.7 * profitPerUnit", () => {
    // velocity 41 đơn/ngày, profit ~89-72=17, mất 24h → 41 * 0.7 * 17 * 1 ≈ 487.9
    const leak = estimatedRevenueLeakage(41, 89, 72, 24);
    assert.ok(leak > 400 && leak < 520, `leak ${leak} phải tầm ~488`);
  });
});
