/**
 * Test Module 8 G1 — auto-điền từ ASIN hạt nhân (Rainforest product) và form
 * TRẮNG (không còn điền sẵn số demo). Chốt yêu cầu 16/09/2026: user chỉ cần
 * gõ ASIN + giá vốn + cước; kích thước/khối lượng/giả do hệ thống cào về.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PRICE_SCENARIO_SPREAD_PCT,
  parseAsinAutofill,
} from "../src/lib/research/domain/asin-autofill.ts";
import { MockIntelligenceProvider } from "../src/lib/intelligence/mock-intelligence.ts";
import { BLANK_FORM, errorsBySection } from "../src/lib/research/new-form.ts";

/** Shape Rainforest product thật: dimensions_object + buybox_winner. */
const RAINFOREST_LIKE = {
  request_info: { success: true },
  product: {
    asin: "B0GZN6YMHS",
    parent_asin: "B0GZN6YMH0",
    title: "Kitchen Shelf Organizer, Stainless Steel",
    brand: "KitchenPro",
    rating: 4.4,
    ratings_total: 1234,
    buybox_winner: {
      price: { value: 39.99, currency: "USD" },
      sold_by: { name: "KitchenPro Direct" },
    },
    dimensions_object: { length: 12.5, width: 8, height: 1.25, unit: "inches", weight: 24, weight_unit: "ounces" },
  },
};

test("parseAsinAutofill: đọc kích thước/khối lượng/giá; gợi ý 3 kịch bản ±10%", () => {
  const r = parseAsinAutofill(RAINFOREST_LIKE);
  assert.ok(r);
  assert.equal(r.title, "Kitchen Shelf Organizer, Stainless Steel");
  assert.equal(r.brand, "KitchenPro");
  assert.equal(r.lengthIn, 12.5);
  assert.equal(r.widthIn, 8);
  assert.equal(r.heightIn, 1.25);
  assert.equal(r.weightLb, 1.5); // 24 oz ÷ 16
  assert.equal(r.price, 39.99);
  assert.equal(PRICE_SCENARIO_SPREAD_PCT, 10);
  assert.deepEqual(r.suggestedPrices, { pessimistic: 35.99, base: 39.99, optimistic: 43.99 });
  assert.deepEqual(r.missing, []);
});

test("parseAsinAutofill: dimensions dạng chuỗi + weight pounds (không có dimensions_object)", () => {
  const r = parseAsinAutofill({
    product: {
      asin: "B0XYZ",
      title: "Rack",
      dimensions: "10 x 6 x 0.5 inches; 1.25 pounds",
      buybox_winner: { price: { value: 25, currency: "USD" } },
    },
  });
  assert.ok(r);
  assert.equal(r.lengthIn, 10);
  assert.equal(r.widthIn, 6);
  assert.equal(r.heightIn, 0.5);
  assert.equal(r.weightLb, 1.25);
  assert.equal(r.price, 25);
});

test("parseAsinAutofill: listing thiếu giá → suggestedPrices null và báo rõ còn thiếu gì", () => {
  const r = parseAsinAutofill({
    product: {
      asin: "B0NOPRICE",
      title: "Rack without price",
      dimensions_object: { length: 9, width: 5, height: 1, unit: "inches", weight: 1, weight_unit: "pounds" },
    },
  });
  assert.ok(r);
  assert.equal(r.price, null);
  assert.equal(r.suggestedPrices, null);
  assert.ok(r.missing.some((m) => m.includes("giá buybox")));
});

test("parseAsinAutofill: ASIN không tồn tại / payload rác → null (action sẽ báo lỗi)", () => {
  assert.equal(parseAsinAutofill({ product: null }), null);
  assert.equal(parseAsinAutofill({}), null);
  assert.equal(parseAsinAutofill(null), null);
  assert.equal(parseAsinAutofill("không phải object"), null);
});

test("parseAsinAutofill: chạy được trên provider MOCK (deterministic, gắn nhãn ở action)", async () => {
  const mock = new MockIntelligenceProvider();
  const json = await mock.product("B0MOCK001");
  const r = parseAsinAutofill(json);
  assert.ok(r, "mock phải parse được qua cùng parser");
  assert.ok(r.lengthIn !== null && r.widthIn !== null && r.heightIn !== null);
  assert.ok(r.weightLb !== null);
  assert.ok(r.price !== null);
  assert.ok(r.suggestedPrices);
});

/* ------------------------- form TRẮNG (hết pre-fill demo) ------------------------- */

test("BLANK_FORM: mọi ô text trống, mọi cờ rủi ro tắt", () => {
  for (const [k, v] of Object.entries(BLANK_FORM)) {
    if (typeof v === "string") assert.equal(v, "", `trường ${k} phải trống`);
    else assert.equal(v, false, `cờ ${k} phải tắt`);
  }
});

test("BLANK_FORM: validate chỉ bắt lỗi trường BẮT BUỘC, không đụng trường tùy chọn", () => {
  const { errors, bySection } = errorsBySection(BLANK_FORM);
  // Bắt buộc: tên ngách + từ khóa (nganh), 3 giá + giá vốn (gia), kích thước (donggoi).
  assert.equal(bySection.nganh.length, 2);
  assert.ok(bySection.gia.length >= 4, `giá×3 + vốn, nhận ${bySection.gia.length}`);
  assert.ok(bySection.donggoi.some((m) => m.includes("Kích thước")));
  // Cước để trống = 0 (hợp lệ); velocity/ads đều tùy chọn → KHÔNG có lỗi riêng.
  assert.equal(bySection.velocity.length, 0);
  assert.equal(errors.length, bySection.nganh.length + bySection.gia.length + bySection.donggoi.length);
});
