/**
 * Test model Module 2 (P1 — Giá & Featured Offer) sau migration 0016.
 *
 * Điểm khoá: vexim_pricing đã trả GIÁ VỐN HIỆU LỰC + giá sàn + biên thật, nên
 * web KHÔNG được tự chế "giá sàn ≈ tổng phí" nữa (lỗi của 0013 làm P1 báo lãi
 * cho SKU đang lỗ). Thiếu giá vốn → NULL + nhãn lý do, không phải 0.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COST_BASIS_HINT,
  COST_BASIS_VI,
  computePricingKpis,
  DEFAULT_MIN_MARGIN_PCT,
  isCostBlocked,
  mapPricingRow,
  PRICING_SELECT,
  type PricingRaw,
} from "../src/lib/data/pricing-model.ts";

function raw(partial: Partial<PricingRaw>): PricingRaw {
  return {
    id: "1",
    seller_account_id: "shop-a",
    shop: "Shop A",
    sku: partial.sku ?? "TG-LUG-20-BLK",
    asin: "B0DEMO001",
    title: "TravelGear 20",
    our_price: 129.99,
    currency: "USD",
    updated_at: "2026-09-12T02:00:00Z",
    buy_box_won: true,
    buy_box_price: 129.99,
    competitor_price: 132.5,
    offer_captured_at: "2026-09-12T02:00:00Z",
    referral_fee: 19.5,
    fba_fee: 5.5,
    total_fees: 25,
    fees_estimated_at: "2026-09-11T02:00:00Z",
    unit_cost: 40,
    cost_currency: "USD",
    cost_effective_from: "2026-09-01",
    cost_source: "csv",
    referral_rate_used: 0.15,
    min_margin_rate: 0.1,
    other_fee_per_unit: 0,
    floor_price: 60.67,
    gross_profit: 39.5,
    margin_pct: 39.5,
    below_floor: false,
    cost_basis: "cost+fees",
    ...partial,
  };
}

test("PRICING_SELECT: phải lấy đủ cột 0016, thiếu là UI hiện '—' oan", () => {
  for (const col of [
    "unit_cost",
    "cost_currency",
    "cost_effective_from",
    "cost_source",
    "referral_rate_used",
    "min_margin_rate",
    "other_fee_per_unit",
    "floor_price",
    "gross_profit",
    "margin_pct",
    "below_floor",
    "cost_basis",
  ]) {
    assert.ok(PRICING_SELECT.split(",").includes(col), `thiếu cột ${col} trong PRICING_SELECT`);
  }
});

test("mapPricingRow: dùng giá sàn/biên DB tính — KHÔNG lấy tổng phí làm sàn", () => {
  const r = mapPricingRow(raw({}));
  assert.equal(r.floorPrice, 60.67);
  assert.equal(r.currentMargin, 39.5);
  assert.equal(r.grossProfit, 39.5);
  assert.equal(r.unitCost, 40);
  assert.equal(r.costBasis, "cost+fees");
  assert.equal(r.marginTone, "green");
  assert.equal(r.belowFloor, false);
  // tổng phí (25) KHÔNG được dùng làm giá sàn như bản 0013
  assert.notEqual(r.floorPrice, 25);
});

test("mapPricingRow: THIẾU giá vốn → sàn/biên NULL, nhãn fees_only, tone gray (không phải 0/đỏ)", () => {
  const r = mapPricingRow(
    raw({
      unit_cost: null,
      cost_currency: null,
      cost_effective_from: null,
      cost_source: null,
      floor_price: null,
      gross_profit: null,
      margin_pct: null,
      below_floor: null,
      cost_basis: "fees_only",
    }),
  );
  assert.equal(r.floorPrice, null);
  assert.equal(r.currentMargin, null);
  assert.equal(r.grossProfit, null);
  assert.equal(r.belowFloor, null);
  assert.equal(r.costBasis, "fees_only");
  assert.equal(r.marginTone, "gray", "chưa tính được thì KHÔNG tô đỏ như thể đang lỗ");
  assert.equal(isCostBlocked(r), true);
  assert.match(COST_BASIS_VI.fees_only, /Chưa có giá vốn/);
  assert.match(COST_BASIS_HINT.fees_only, /\/finance\/costs/, "phải chỉ thẳng chỗ nhập giá vốn");
});

test("mapPricingRow: giá vốn lệch tiền tệ → không cộng được, nhãn currency_mismatch", () => {
  const r = mapPricingRow(
    raw({
      unit_cost: 40,
      cost_currency: "EUR",
      currency: "USD",
      floor_price: null,
      margin_pct: null,
      below_floor: null,
      cost_basis: "currency_mismatch",
    }),
  );
  assert.equal(r.floorPrice, null);
  assert.equal(r.costBasis, "currency_mismatch");
  assert.equal(isCostBlocked(r), true);
});

test("mapPricingRow: dưới giá sàn → belowFloor true + tone đỏ", () => {
  const r = mapPricingRow(raw({ our_price: 50, floor_price: 60.67, margin_pct: -21, below_floor: true }));
  assert.equal(r.belowFloor, true);
  assert.equal(r.currentMargin, -21);
  assert.equal(r.marginTone, "red");
});

test("mapPricingRow: biên mỏng hơn ngưỡng cấu hình → amber theo min_margin_rate của DB", () => {
  // DB cấu hình biên tối thiểu 20% → biên 25% vẫn xanh, 15% thành vàng
  const strict = mapPricingRow(raw({ min_margin_rate: 0.2, margin_pct: 25 }));
  assert.equal(strict.marginTone, "green");
  const thin = mapPricingRow(raw({ min_margin_rate: 0.2, margin_pct: 15 }));
  assert.equal(thin.marginTone, "amber");
  // thiếu cấu hình → dùng mặc định 10% (khớp worker/src/domain/pricing.ts)
  assert.equal(DEFAULT_MIN_MARGIN_PCT, 10);
  assert.equal(mapPricingRow(raw({ min_margin_rate: null, margin_pct: 9.5 })).marginTone, "amber");
  assert.equal(mapPricingRow(raw({ min_margin_rate: null, margin_pct: 10.5 })).marginTone, "green");
});

test("mapPricingRow: view CHƯA chạy 0016 (thiếu cột) → không nổ, suy ra nhãn từ dữ liệu", () => {
  // Giả lập DB cũ: các cột mới là undefined (PostgREST không trả field)
  const legacy = {
    id: "1",
    seller_account_id: "shop-a",
    shop: "Shop A",
    sku: "OLD-1",
    asin: null,
    title: null,
    our_price: 100,
    currency: "USD",
    updated_at: "2026-09-12T02:00:00Z",
    buy_box_won: null,
    buy_box_price: null,
    competitor_price: null,
    offer_captured_at: null,
    referral_fee: null,
    fba_fee: null,
    total_fees: 15,
    fees_estimated_at: null,
  } as unknown as PricingRaw;

  const r = mapPricingRow(legacy);
  assert.equal(r.floorPrice, null, "không có giá vốn thì KHÔNG được chế sàn từ total_fees");
  assert.equal(r.currentMargin, null);
  assert.equal(r.costBasis, "fees_only");
  assert.equal(r.boxStatus, "no_box");
});

test("mapPricingRow: buy box — có offer mà giá mình cao hơn đối thủ 5% thì tính là mất box", () => {
  assert.equal(mapPricingRow(raw({ buy_box_won: null })).boxStatus, "no_box");
  assert.equal(mapPricingRow(raw({ buy_box_won: true })).boxStatus, "holding");
  assert.equal(
    mapPricingRow(raw({ buy_box_won: false, our_price: 130, competitor_price: 100 })).boxStatus,
    "lost",
  );
  assert.equal(
    mapPricingRow(raw({ buy_box_won: false, our_price: 101, competitor_price: 100 })).boxStatus,
    "at_risk",
  );
});

test("computePricingKpis: đếm SKU dưới sàn theo below_floor + nêu số SKU thiếu giá vốn", () => {
  const rows = [
    mapPricingRow(raw({ sku: "OK" })),
    mapPricingRow(raw({ sku: "FLOOR", our_price: 50, below_floor: true, margin_pct: -21 })),
    mapPricingRow(
      raw({
        sku: "NOCOST",
        unit_cost: null,
        cost_currency: null,
        floor_price: null,
        gross_profit: null,
        margin_pct: null,
        below_floor: null,
        cost_basis: "fees_only",
      }),
    ),
  ];
  const kpis = computePricingKpis(rows);
  const byLabel = Object.fromEntries(kpis.map((k) => [k.label, k]));

  assert.equal(byLabel["SKU dưới giá sàn"].value, "1");
  assert.equal(byLabel["SKU dưới giá sàn"].tone, "down");
  assert.equal(byLabel["SKU chưa có giá vốn"].value, "1");
  assert.equal(byLabel["SKU chưa có giá vốn"].tone, "warn");
  // biên trung bình chỉ tính trên SKU CÓ số — không chia cho SKU thiếu giá vốn
  assert.equal(byLabel["Biên trung bình"].value, `${((39.5 + -21) / 2).toFixed(1)}%`);
  assert.match(byLabel["Biên trung bình"].sub, /2\/3 SKU có giá vốn/);
  assert.equal(byLabel["SKU đang giữ Buy Box"].value, "3 / 3");
});

test("computePricingKpis: chưa SKU nào có giá vốn → biên trung bình '—', không hiện 0%", () => {
  const rows = [
    mapPricingRow(raw({ unit_cost: null, floor_price: null, margin_pct: null, below_floor: null, cost_basis: "fees_only" })),
  ];
  const kpis = computePricingKpis(rows);
  const margin = kpis.find((k) => k.label === "Biên trung bình");
  assert.equal(margin?.value, "—");
  assert.equal(margin?.tone, "warn");
  assert.equal(computePricingKpis([]).find((k) => k.label === "Biên trung bình")?.value, "—");
});
