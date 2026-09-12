/**
 * Test model Module 2 (P1 — Giá & Featured Offer) sau migration 0016 + 0017.
 *
 * Điểm khoá: vexim_pricing đã trả GIÁ VỐN HIỆU LỰC + giá sàn + biên thật, nên
 * web KHÔNG được tự chế "giá sàn ≈ tổng phí" nữa (lỗi của 0013 làm P1 báo lãi
 * cho SKU đang lỗ). Thiếu giá vốn → NULL + nhãn lý do, không phải 0.
 *
 * Từ 0017 view nối thêm doanh số 30 ngày + người phụ trách: SKU CHƯA CÓ ĐƠN phải
 * giữ NULL (không suy ra 0 đơn/ngày) và cột owner lấy từ iam.module_owner().
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COST_BASIS_HINT,
  COST_BASIS_VI,
  computePricingKpis,
  DEFAULT_MIN_MARGIN_PCT,
  formatRevenue30d,
  formatSales30d,
  formatVelocity30d,
  isCostBlocked,
  mapPricingRow,
  PRICING_SALES_COLUMNS,
  PRICING_SELECT,
  revenuePerDay30d,
  velocitySortValue,
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
    /* ↓ 0017: 60 đơn vị / 45 đơn / 7.799,40 USD trong 30 ngày → 2 đơn vị/ngày */
    units_30d: 60,
    orders_30d: 45,
    revenue_30d: 7799.4,
    revenue_currency: "USD",
    velocity_30d: 2,
    last_order_at: "2026-09-11T02:00:00Z",
    owner: "Minh",
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

/* ---------- 0017: doanh số 30 ngày + người phụ trách ---------- */

test("PRICING_SELECT: 7 cột 0017 phải nối ĐÚNG THỨ TỰ ở cuối (sai là PGRST204 sập trang)", () => {
  const cols = PRICING_SELECT.split(",");
  assert.deepEqual(cols.slice(-7), [...PRICING_SALES_COLUMNS]);
});

test("mapPricingRow: velocity30d/units/revenue/owner lấy từ view, không hard-code 0", () => {
  const r = mapPricingRow(raw({}));
  assert.equal(r.units30d, 60);
  assert.equal(r.orders30d, 45);
  assert.equal(r.velocity30d, 2);
  assert.equal(r.revenue30d, 7799.4);
  assert.equal(r.revenueCurrency, "USD");
  assert.equal(r.lastOrderAt, "2026-09-11T02:00:00Z");
  assert.equal(r.owner, "Minh");
});

test("mapPricingRow: SKU CHƯA CÓ ĐƠN → velocity/revenue NULL, không suy ra 0", () => {
  const r = mapPricingRow(
    raw({
      units_30d: null,
      orders_30d: null,
      revenue_30d: null,
      revenue_currency: null,
      velocity_30d: null,
      last_order_at: null,
    }),
  );
  assert.equal(r.units30d, null);
  assert.equal(r.velocity30d, null);
  assert.equal(r.revenue30d, null);
  assert.equal(r.revenueCurrency, null);
  assert.equal(r.lastOrderAt, null);
});

test("mapPricingRow: view cũ chưa có velocity_30d → tự suy từ units_30d (không bỏ trống oan)", () => {
  const r = mapPricingRow(raw({ velocity_30d: null, units_30d: 90 }));
  assert.equal(r.velocity30d, 3);
});

test("mapPricingRow: chưa gán người phụ trách → '—', không bịa tên", () => {
  assert.equal(mapPricingRow(raw({ owner: null })).owner, "—");
});

test("formatSales30d/formatVelocity30d: NULL in '—' chứ không in 0", () => {
  assert.equal(formatSales30d({ units30d: 60, orders30d: 45 }), "60 đơn vị · 45 đơn");
  assert.equal(formatSales30d({ units30d: 60, orders30d: null }), "60 đơn vị");
  assert.equal(formatSales30d({ units30d: null, orders30d: null }), "—");
  assert.equal(formatVelocity30d(2), "2/ngày");
  assert.equal(formatVelocity30d(0.2), "0.2/ngày");
  assert.equal(formatVelocity30d(null), "—");
});

test("formatRevenue30d: lẫn tiền tệ thì BÁO RÕ, không cộng gộp rồi in một số sai", () => {
  assert.equal(formatRevenue30d(1234.5, "USD"), "$1,234.50");
  assert.equal(formatRevenue30d(1234.5, "EUR"), "1,234.50 EUR");
  assert.equal(formatRevenue30d(1234.5, null), "1,234.50 ⚠ lẫn tiền tệ");
  assert.equal(formatRevenue30d(null, "USD"), "—");
});

test("velocitySortValue: SKU chưa có đơn xếp CUỐI khi sort 'Velocity cao'", () => {
  assert.equal(velocitySortValue({ velocity30d: 2 }), 2);
  assert.equal(velocitySortValue({ velocity30d: null }), Number.NEGATIVE_INFINITY);
  const sorted = [
    { velocity30d: null },
    { velocity30d: 0.5 },
    { velocity30d: 3 },
  ].sort((a, b) => velocitySortValue(b) - velocitySortValue(a));
  assert.deepEqual(
    sorted.map((r) => r.velocity30d),
    [3, 0.5, null],
  );
});

test("revenuePerDay30d: tiền mất mỗi ngày nếu mất Buy Box = doanh thu 30 ngày ÷ 30", () => {
  assert.equal(revenuePerDay30d({ revenue30d: 300 }), 10);
  assert.equal(revenuePerDay30d({ revenue30d: 100 }), 3.33);
  assert.equal(revenuePerDay30d({ revenue30d: null }), null);
});
