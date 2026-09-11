/**
 * Test chỉ số kho vận — đúng công thức docs/phan-tich-ky-thuat-module-3-kho-van.md
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeVelocity14,
  daysOfCover,
  restockSuggestion,
  stockoutSeverity,
} from "../src/domain/inventory-metrics.ts";

test("velocity: loại 2 ngày đỉnh outlier rồi chia 14", () => {
  // 14 ngày: twelve ngày 10 đơn + 2 ngày đỉnh 50 = tổng 220 → (220 − 100) / 14
  const days = [10, 50, 10, 10, 50, 10, 10, 10, 10, 10, 10, 10, 10, 10];
  assert.equal(computeVelocity14(days), (220 - 100) / 14);
});

test("velocity: ít hơn 7 ngày dữ liệu → 0 (không đủ tin cậy)", () => {
  assert.equal(computeVelocity14([5, 5, 5]), 0);
});

test("velocity: 7–13 ngày vẫn tính trên cửa sổ 14", () => {
  const days = [10, 10, 10, 10, 10, 10, 10, 10]; // 8 ngày
  // sort desc: không có outlier nổi bật (đều 10) → (80 − 20)/14
  assert.equal(computeVelocity14(days), (80 - 20) / 14);
});

test("cover: floor(fulfillable / velocity) — đúng số hiển thị màn I1", () => {
  assert.equal(daysOfCover(88, 17), 5); // 88/17 = 5.17 → 5 (khớp mock XMO-950-BLK)
  assert.equal(daysOfCover(140, 18), 7);
});

test("cover: velocity 0 (SKU mới) → null", () => {
  assert.equal(daysOfCover(500, 0), null);
});

test("đề xuất nhập: trừ cả reserved + inbound, làm tròn case pack", () => {
  // velocity 17 · lead 32 · safety 14 · tồn 88 + reserved 12 + inbound 60
  // = 17×46 − 160 = 622 → case pack 20 → 640
  assert.equal(
    restockSuggestion({
      velocity: 17,
      leadDays: 32,
      fulfillable: 88,
      reserved: 12,
      inbound: 60,
      casePack: 20,
    }),
    640,
  );
});

test("đề xuất nhập: đủ hàng → null", () => {
  assert.equal(
    restockSuggestion({
      velocity: 2,
      leadDays: 32,
      fulfillable: 3000,
      reserved: 0,
      inbound: 0,
    }),
    null,
  );
});

test("mức cảnh báo: <7 đỏ · 7–13 vàng · ≥14 không cảnh báo", () => {
  assert.equal(stockoutSeverity(5), "red");
  assert.equal(stockoutSeverity(7), "amber");
  assert.equal(stockoutSeverity(13), "amber");
  assert.equal(stockoutSeverity(14), null);
  assert.equal(stockoutSeverity(null), null);
});
