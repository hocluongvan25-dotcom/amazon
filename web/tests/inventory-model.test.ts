/**
 * Test model Module 3 (Kho vận & FBA) sau migration 0017.
 *
 * Điểm khoá: "giá trị tồn kho" phải là Σ tồn × GIÁ VỐN HIỆU LỰC thật (0016 đã mở
 * khoá nhập giá vốn, 0017 nối cột vào vexim_inventory_latest). Nguyên tắc:
 *   • thiếu giá vốn → NULL + nhãn 'missing', KHÔNG hiện $0 (I3 từng để "—" cứng);
 *   • tính theo TIỀN CỦA GIÁ VỐN — VEXIM nhập VND, bán USD, không tự quy đổi;
 *   • không bao giờ CỘNG GỘP hai tiền tệ trong một con số tổng.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildRestockRows,
  computeFulfillKpis,
  formatInventoryValueTotal,
  formatStockValue,
  formatUnitCost,
  INVENTORY_SELECT,
  INVENTORY_VALUE_COLUMNS,
  mapInventoryRow,
  summarizeInventoryValue,
  summarizeRestockValue,
  type InventoryLatestRaw,
} from "../src/lib/data/inventory-model.ts";
import type { InventoryRow } from "../src/lib/types.ts";

/** Một dòng vexim_inventory_latest (0011 + 8 cột 0017 nối cuối). */
function rawInv(partial: Partial<InventoryLatestRaw> = {}): InventoryLatestRaw {
  return {
    seller_account_id: "shop-a",
    shop: "Shop A",
    sku: partial.sku ?? "TG-LUG-20-BLK",
    asin: "B0DEMO001",
    fulfillable: 100,
    reserved: 20,
    inbound: 30,
    captured_at: "2026-09-12T02:00:00Z",
    day: "2026-09-12",
    days_of_cover: 25,
    velocity: 4,
    suggest_restock: 120,
    in_stock: true,
    unit_cost: 10,
    cost_currency: "USD",
    cost_effective_from: "2026-09-01",
    cost_source: "csv",
    stock_value: 1000,
    total_stock_value: 1500,
    value_currency: "USD",
    value_basis: "cost",
    ...partial,
  };
}

/** InventoryRow dựng tay cho các test tổng hợp (không cần đi qua map). */
function row(partial: Partial<InventoryRow> = {}): InventoryRow {
  return {
    sku: partial.sku ?? "TG-LUG-20-BLK",
    asin: "B0DEMO001",
    shop: "Shop A",
    fulfillable: 100,
    reserved: 20,
    inbound: 30,
    velocity: 4,
    coverDays: 25,
    suggest: 120,
    agedDays: null,
    status: "ok",
    statusLabel: "Đủ hàng",
    unitCost: 10,
    costCurrency: "USD",
    costEffectiveFrom: "2026-09-01",
    costSource: "csv",
    stockValue: 1000,
    totalStockValue: 1500,
    valueCurrency: "USD",
    valueBasis: "cost",
    ...partial,
  };
}

/* ---------- select phải khớp cột view ---------- */

test("INVENTORY_SELECT: 8 cột giá trị 0017 nối ĐÚNG THỨ TỰ ở cuối (sai là PGRST204)", () => {
  const cols = INVENTORY_SELECT.split(",");
  assert.deepEqual(cols.slice(-8), [...INVENTORY_VALUE_COLUMNS]);
  // cột 0011 vẫn phải còn nguyên — thiếu là I1 mất velocity/cover
  for (const col of ["fulfillable", "reserved", "inbound", "days_of_cover", "velocity", "suggest_restock"]) {
    assert.ok(cols.includes(col), `INVENTORY_SELECT thiếu ${col}`);
  }
});

/* ---------- mapping ---------- */

test("mapInventoryRow: giữ giá vốn + giá trị tồn DB tính (không tự tính lại lệch)", () => {
  const r = mapInventoryRow(rawInv({}));
  assert.equal(r.unitCost, 10);
  assert.equal(r.costCurrency, "USD");
  assert.equal(r.costSource, "csv");
  assert.equal(r.costEffectiveFrom, "2026-09-01");
  assert.equal(r.stockValue, 1000);
  assert.equal(r.totalStockValue, 1500);
  assert.equal(r.valueCurrency, "USD");
  assert.equal(r.valueBasis, "cost");
});

test("mapInventoryRow: THIẾU giá vốn → giá trị NULL + nhãn 'missing', không hiện 0 giả", () => {
  const r = mapInventoryRow(
    rawInv({
      unit_cost: null,
      cost_currency: null,
      cost_effective_from: null,
      cost_source: null,
      stock_value: null,
      total_stock_value: null,
      value_currency: null,
      value_basis: "missing",
    }),
  );
  assert.equal(r.unitCost, null);
  assert.equal(r.stockValue, null);
  assert.equal(r.totalStockValue, null);
  assert.equal(r.valueBasis, "missing");
  assert.equal(formatUnitCost(r), "—");
});

test("mapInventoryRow: view cũ chưa có cột giá trị → coi như thiếu giá vốn (không crash)", () => {
  const legacy = rawInv({});
  delete (legacy as Record<string, unknown>).unit_cost;
  delete (legacy as Record<string, unknown>).total_stock_value;
  const r = mapInventoryRow(legacy);
  assert.equal(r.unitCost, null);
  assert.equal(r.totalStockValue, null);
  assert.equal(r.valueBasis, "missing");
});

/* ---------- định dạng tiền ---------- */

test("formatStockValue: theo TIỀN CỦA GIÁ VỐN — USD có 2 số lẻ, VND không", () => {
  assert.equal(formatStockValue(1500, "USD"), "$1,500.00");
  assert.equal(formatStockValue(1234567, "VND"), "1,234,567 ₫");
  assert.equal(formatStockValue(1500, "EUR"), "1,500.00 EUR");
  assert.equal(formatStockValue(1500, null), "1,500.00");
  assert.equal(formatStockValue(null, "USD"), "—");
});

/* ---------- tổng hợp giá trị tồn ---------- */

test("summarizeInventoryValue: cộng theo TỪNG tiền tệ, không cộng lẫn VND với USD", () => {
  const sum = summarizeInventoryValue([
    row({ sku: "A", totalStockValue: 1500, valueCurrency: "USD" }),
    row({ sku: "B", totalStockValue: 500, valueCurrency: "USD" }),
  ]);
  assert.equal(sum.byCurrency.length, 1);
  assert.equal(sum.byCurrency[0].total, 2000);
  assert.equal(sum.total, 2000);
  assert.equal(sum.valued, 2);
  assert.equal(sum.missingCost, 0);
  assert.equal(formatInventoryValueTotal(sum), "$2,000.00");
});

test("summarizeInventoryValue: hai tiền tệ → liệt kê riêng, total KHÔNG cộng gộp", () => {
  const sum = summarizeInventoryValue([
    row({ sku: "A", totalStockValue: 1500, valueCurrency: "USD" }),
    row({ sku: "B", totalStockValue: 12000000, valueCurrency: "VND" }),
  ]);
  assert.equal(sum.byCurrency.length, 2);
  assert.equal(sum.total, 0);
  assert.equal(formatInventoryValueTotal(sum), "12,000,000 ₫ + $1,500.00");
});

test("summarizeInventoryValue: SKU thiếu giá vốn đếm riêng, nhưng chỉ khi THẬT SỰ còn tồn", () => {
  const sum = summarizeInventoryValue([
    row({ sku: "A", totalStockValue: 1500, valueCurrency: "USD" }),
    // còn tồn mà chưa có giá vốn → phải báo để đi nhập
    row({ sku: "B", totalStockValue: null, unitCost: null, fulfillable: 50, reserved: 0, inbound: 0 }),
    // hết sạch tồn, chưa có giá vốn → không làm nhiễu con số "thiếu"
    row({ sku: "C", totalStockValue: null, unitCost: null, fulfillable: 0, reserved: 0, inbound: 0 }),
  ]);
  assert.equal(sum.missingCost, 1);
  assert.equal(sum.valued, 1);
  assert.equal(sum.byCurrency[0].total, 1500);
  assert.equal(formatInventoryValueTotal(summarizeInventoryValue([])), "—");
});

test("computeFulfillKpis: có thẻ 'Giá trị tồn kho' và cảnh báo khi còn SKU chưa định giá", () => {
  const kpis = computeFulfillKpis([
    row({ sku: "A", totalStockValue: 1500, valueCurrency: "USD", fulfillable: 100 }),
    row({ sku: "B", totalStockValue: null, unitCost: null, fulfillable: 50, valueBasis: "missing" }),
  ]);
  const valueCard = kpis.find((k) => k.label === "Giá trị tồn kho");
  assert.ok(valueCard, "thiếu KPI Giá trị tồn kho");
  assert.equal(valueCard!.value, "$1,500.00");
  assert.equal(valueCard!.tone, "warn");
  assert.match(valueCard!.sub, /1 SKU chưa có giá vốn/);
});

/* ---------- I3: kế hoạch nhập hàng ---------- */

test("buildRestockRows: giá vốn + giá trị lô = đề xuất × giá vốn (hết cảnh '—' cứng)", () => {
  const plan = buildRestockRows([row({ sku: "A", suggest: 120, unitCost: 10, costCurrency: "USD" })]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].suggest, 120);
  assert.equal(plan[0].unitCost, "$10.00");
  assert.equal(plan[0].value, "$1,200.00");
  assert.equal(plan[0].tone, "gray");
  assert.equal(plan[0].stepLabel, "Nháp — chưa gửi duyệt");
});

test("buildRestockRows: thiếu giá vốn → nói thẳng 'chưa có giá vốn', không in $0", () => {
  const plan = buildRestockRows([
    row({ sku: "B", suggest: 80, unitCost: null, costCurrency: null, stockValue: null, totalStockValue: null, valueBasis: "missing" }),
  ]);
  assert.equal(plan[0].unitCost, "—");
  assert.equal(plan[0].value, "— chưa có giá vốn");
  assert.equal(plan[0].tone, "amber");
  assert.equal(plan[0].stepLabel, "Nháp — thiếu giá vốn");
});

test("buildRestockRows: SKU không cần nhập (suggest null/0) không vào kế hoạch", () => {
  assert.equal(buildRestockRows([row({ suggest: null }), row({ suggest: 0 })]).length, 0);
});

test("summarizeRestockValue: tổng giá trị các lô đề xuất + đếm lô thiếu giá vốn", () => {
  const sum = summarizeRestockValue([
    row({ sku: "A", suggest: 120, unitCost: 10, costCurrency: "USD", valueCurrency: "USD" }),
    row({ sku: "B", suggest: 50, unitCost: 2.65, costCurrency: "USD", valueCurrency: "USD" }),
    row({ sku: "C", suggest: 30, unitCost: null, totalStockValue: null, valueBasis: "missing" }),
    row({ sku: "D", suggest: null }),
  ]);
  // 120×10 + 50×2.65 = 1200 + 132.5
  assert.equal(sum.byCurrency[0].total, 1332.5);
  assert.equal(sum.missingCost, 1);
  assert.equal(formatInventoryValueTotal(sum), "$1,332.50");
});
