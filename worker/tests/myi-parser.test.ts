/**
 * Test parser report GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA (TSV chuẩn Amazon)
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMyiInventoryReport } from "../src/reports/myi.parser.ts";

const HEAD =
  "snapshot-date\tsku\tfnsku\tasin\tproduct-name\tafn-warehouse-quantity\tafn-fulfillable-quantity\tafn-unsellable-quantity\tafn-reserved-quantity\tafn-total-quantity\tafn-inbound-working-quantity\tafn-inbound-shipped-quantity\tafn-inbound-receiving-quantity";

test("parse dòng chuẩn: đủ số liệu, công thức khớp", () => {
  const tsv = [
    HEAD,
    // warehouse = 40 + 0 + 8 = 48; total = 48 + 0 + 60 + 0 = 108
    "2026-09-11\tXMO-950-BLK\tX00DEMO01F\tB0TEST0001\tXMO 950 Black\t48\t40\t0\t8\t108\t0\t60\t0",
  ].join("\n");

  const { rows, warnings } = parseMyiInventoryReport(tsv);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.sku, "XMO-950-BLK");
  assert.equal(r.fulfillable, 40);
  assert.equal(r.reserved, 8);
  assert.equal(r.inboundShipped, 60);
  assert.equal(r.total, 108);
  assert.deepEqual(warnings, []);
});

test("cột reserved rỗng → cảnh báo, không đè số (vấn đề thực tế đã ghi nhận)", () => {
  const tsv = [
    HEAD,
    "2026-09-11\tVPN-220\tX00DEMO02F\tB0TEST0002\tVPN 220\t\t30\t0\t\t60\t0\t0\t0",
  ].join("\n");

  const { rows, warnings } = parseMyiInventoryReport(tsv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fulfillable, 30);
  assert.equal(rows[0].reserved, 0);
  assert.ok(
    warnings.some((w) => w.includes("afn-reserved-quantity rỗng")),
    "phải có cảnh báo reserved rỗng",
  );
});

test("công thức afn không khớp → cảnh báo đối soát", () => {
  const tsv = [
    HEAD,
    // warehouse khai 99 nhưng 40+0+8=48 → lệch
    "2026-09-11\tBAD-1\tX00DEMO03F\tB0TEST0003\tBad row\t99\t40\t0\t8\t200\t0\t0\t0",
  ].join("\n");

  const { warnings } = parseMyiInventoryReport(tsv);
  assert.ok(warnings.some((w) => w.includes("afn-warehouse-quantity=99")));
  assert.ok(warnings.some((w) => w.includes("afn-total-quantity=200")));
});

test("thiếu cột bắt buộc → cảnh báo, không crash", () => {
  const { rows, warnings } = parseMyiInventoryReport("sku\tasin\nA\tB0X");
  assert.equal(rows.length, 0);
  assert.ok(warnings.some((w) => w.includes("Thiếu cột bắt buộc")));
});
