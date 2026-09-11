/**
 * Test pricing-sync.job — pipeline SP-API → snapshot và tiện ích batch/retry.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_PRICING_SYNC_CONFIG,
  buildPricingSnapshot,
  chunkBatch,
  retryDelay,
  type RawPricingPayload,
} from "../src/jobs/pricing-sync.job.ts";

describe("DEFAULT_PRICING_SYNC_CONFIG — đúng giới hạn SP-API", () => {
  test("FOEP batch 40 (theo docs SP-API 2022-05-01)", () => {
    assert.equal(DEFAULT_PRICING_SYNC_CONFIG.foepBatchSize, 40);
  });
  test("Offers batch 20", () => {
    assert.equal(DEFAULT_PRICING_SYNC_CONFIG.offersBatchSize, 20);
  });
  test("RPS 0.5 cho Product Pricing", () => {
    assert.equal(DEFAULT_PRICING_SYNC_CONFIG.rateLimitRps, 0.5);
  });
});

describe("buildPricingSnapshot — biến đổi raw payload", () => {
  const base: RawPricingPayload = {
    sku: "XMO-950-BLK", asin: "B0C7T31F", shop: "A1",
    myPrice: 129.99, foep: 127.49, lowestCompetitorLanded: 125.99,
    meFeatured: true,
    cogs: 62.5, fbaFee: 15.4,
    velocity30d: 96, lostBoxHours: 0,
    sampledAt: "2026-09-11T06:00:00Z",
  };

  test("tính đủ các trường cơ bản", () => {
    const snap = buildPricingSnapshot(base);
    assert.equal(snap.sku, "XMO-950-BLK");
    assert.equal(snap.ourPrice, 129.99);
    assert.equal(snap.foep, 127.49);
    assert.equal(snap.foepDelta, 2.5);
    assert.equal(snap.referencePrice, 125.99);
    assert.equal(snap.boxStatus, "at_risk");
    assert.equal(snap.flag, "at_risk");
    assert.equal(snap.velocity30d, 96);
    assert.ok(snap.floorPrice > 100);
    assert.ok(snap.currentMargin > 20);
    assert.equal(snap.marginTone, "green");
  });

  test("mất box + biên âm → flag below_floor (ưu tiên 1)", () => {
    const snap = buildPricingSnapshot({
      ...base,
      myPrice: 24.99, cogs: 18, fbaFee: 7.5,
      foep: 24.49, lowestCompetitorLanded: 23.99,
      meFeatured: false, lostBoxHours: 5, velocity30d: 22,
    });
    assert.equal(snap.marginTone, "red");
    assert.equal(snap.flag, "below_floor");
  });

  test("mất box + velocity cao trên 20 đơn/ngày + mất >2h → lost_box_high_velocity", () => {
    const snap = buildPricingSnapshot({
      ...base,
      meFeatured: false, lostBoxHours: 3, velocity30d: 41,
    });
    assert.equal(snap.boxStatus, "lost");
    assert.equal(snap.flag, "lost_box_high_velocity");
  });

  test("foep null cho listing inactive → no_box", () => {
    const snap = buildPricingSnapshot({
      ...base,
      foep: null, lowestCompetitorLanded: null, meFeatured: false,
    });
    assert.equal(snap.boxStatus, "no_box");
    assert.equal(snap.foepDelta, null);
  });

  test("truyền override referral / minMargin → dùng override", () => {
    const snapDefault = buildPricingSnapshot({ ...base });
    const snapThin = buildPricingSnapshot({
      ...base, referralFeeRate: 0.08, minMarginRate: 0.2,
    });
    assert.ok(snapThin.floorPrice > snapDefault.floorPrice, "biên cao hơn → floor cao hơn");
  });
});

describe("chunkBatch — chia batch theo size", () => {
  test("size 40 với 85 SKU → 3 batch (40, 40, 5)", () => {
    const items = Array.from({ length: 85 }, (_, i) => i);
    const batches = chunkBatch(items, 40);
    assert.equal(batches.length, 3);
    assert.equal(batches[0].length, 40);
    assert.equal(batches[1].length, 40);
    assert.equal(batches[2].length, 5);
  });
  test("đúng size → 1 batch", () => {
    assert.equal(chunkBatch([1, 2], 20).length, 1);
  });
  test("mảng rỗng → 0 batch", () => {
    assert.equal(chunkBatch([], 20).length, 0);
  });
});

describe("retryDelay", () => {
  test("có Retry-After header → dùng đúng giá trị giây", () => {
    assert.equal(retryDelay(0, 5), 5000);
  });
  test("không Retry-After → exponential backoff, cap 30s", () => {
    assert.equal(retryDelay(0), 1000);
    assert.equal(retryDelay(1), 2000);
    assert.equal(retryDelay(2), 4000);
    assert.equal(retryDelay(5), 30_000); // cap
  });
});
