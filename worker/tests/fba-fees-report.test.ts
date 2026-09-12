/**
 * Test 0019 — phí lưu kho theo FC · phí inbound sai quy cách · Reports API tự động.
 *
 * Năm chỗ dễ "xanh giả" nhất, và test khoá từng chỗ:
 *   1. PARSER: report phí lưu kho đặt cột bằng GẠCH DƯỚI (month_of_charge) còn
 *      report inbound dùng GẠCH NỐI (issue-reported-date). Cả hai phải đọc được
 *      qua cùng một chuẩn hoá tên cột; thiếu cột khoá → TỪ CHỐI nhập, không đoán.
 *   2. TIỀN TỆ: không bao giờ cộng USD với CAD. Mọi tổng đều tách theo currency.
 *   3. LUẬT GHI: MockDbAdapter phải hành xử ĐÚNG như RPC 0019 (skip/merge/update,
 *      status lạ → failed, cùng khoảng ngày → 1 dòng, attempts++) — nếu không thì
 *      test xanh mà production phình bảng.
 *   4. REPORTS API BẤT ĐỒNG BỘ: chưa DONE thì trả `pending` và GHI TRẠNG THÁI để
 *      lần sau poll tiếp — KHÔNG xin report mới (trần 1 lần / 4 giờ của Amazon).
 *   5. GZIP: document nén phải giải nén trước khi parse; không giải thì parser
 *      thấy binary và báo "report rỗng" — lỗi rất khó đoán bệnh.
 */
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { test } from "node:test";

import { MockDbAdapter } from "../../web/src/lib/worker/db/adapter.ts";
import {
  boolOrNull,
  numOrNull,
  parseInboundNoncomplianceReport,
  parseStorageFeeReport,
  toIsoMonth,
} from "../src/reports/fba-fees.parser.ts";
import {
  ALL_REPORT_KINDS,
  importParsedReport,
  kindOfReportType,
  parseReportText,
  REPORT_SPECS,
  specOf,
} from "../src/reports/registry.ts";
import { computePeriod, runReportPull } from "../src/jobs/report-pull.job.ts";
import {
  normalizeReportInfo,
  ReportsClient,
  SpApiRequestError,
} from "../src/amazon/reports.ts";
import type { LwaTokenManager } from "../src/amazon/lwa.ts";

// ============================================================================
// Fixture helpers
// ============================================================================

const tsv = (headers: string[], rows: string[][]): string =>
  [headers.join("\t"), ...rows.map((r) => r.join("\t"))].join("\n") + "\n";

/** Cột đúng tên của GET_FBA_STORAGE_FEE_CHARGES_DATA (gạch dưới). */
const FEE_HEADERS = [
  "asin", "fnsku", "product_name", "fulfillment_center", "country_code",
  "longest_side", "median_side", "shortest_side", "measurement_units", "weight",
  "weight_units", "item_volume", "volume_units", "product_size_tier",
  "average_quantity_on_hand", "average_quantity_pending_removal",
  "estimated_total_item_volume", "month_of_charge", "storage_rate", "currency",
  "estimated_monthly_storage_fee", "dangerous_goods_storage_type",
  "eligible_for_inventory_discount", "qualifies_for_inventory_discount",
  "total_incentive_fee_amount", "breakdown_incentive_fee_amount",
  "average_quantity_customer_orders",
];

/** Cột đúng tên của GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA (gạch nối). */
const NC_HEADERS = [
  "issue-reported-date", "shipment-creation-date", "fba-shipment-id", "fba-carton-id",
  "fulfillment-center-id", "sku", "fnsku", "asin", "product-name", "problem-type",
  "problem-quantity", "expected-quantity", "received-quantity",
  "performance-measurement-unit", "coaching-level", "fee-type", "currency",
  "fee-total", "problem-level", "alert-status",
];

const feeRow = (over: Record<string, string> = {}): string[] => {
  const base: Record<string, string> = {
    asin: "B0DEMOA1", fnsku: "X001A1", product_name: "Mat ong 500ml",
    fulfillment_center: "ont8", country_code: "us", longest_side: "8.5",
    median_side: "5.2", shortest_side: "2.1", measurement_units: "inches",
    weight: "1.2", weight_units: "pounds", item_volume: "0.09",
    volume_units: "cubic feet", product_size_tier: "STANDARD",
    average_quantity_on_hand: "120", average_quantity_pending_removal: "0",
    estimated_total_item_volume: "10.8", month_of_charge: "2026-08",
    storage_rate: "0.87", currency: "usd", estimated_monthly_storage_fee: "9.40",
    dangerous_goods_storage_type: "", eligible_for_inventory_discount: "true",
    qualifies_for_inventory_discount: "false", total_incentive_fee_amount: "1.20",
    breakdown_incentive_fee_amount: "0.30", average_quantity_customer_orders: "30",
  };
  return FEE_HEADERS.map((h) => (h in over ? over[h] : base[h] ?? ""));
};

const ncRow = (over: Record<string, string> = {}): string[] => {
  const base: Record<string, string> = {
    "issue-reported-date": "2026-09-08", "shipment-creation-date": "2026-09-01",
    "fba-shipment-id": "fba15dg9wjkr", "fba-carton-id": "FBA15DG9WJKR000001",
    "fulfillment-center-id": "ont8", sku: "VPN-220", fnsku: "X001A1",
    asin: "B0DEMOA1", "product-name": "Vali 20 inch",
    "problem-type": "oversized_carton", "problem-quantity": "2",
    "expected-quantity": "100", "received-quantity": "93",
    "performance-measurement-unit": "UNIT", "coaching-level": "level_2",
    "fee-type": "manual_processing", currency: "usd", "fee-total": "0.30",
    "problem-level": "CARTON", "alert-status": "alert",
  };
  return NC_HEADERS.map((h) => (h in over ? over[h] : base[h] ?? ""));
};

const SHOP = { id: "shop-1", displayName: "VEXIM · US", marketplace: "ATVPDKIKX0DER" };

// ============================================================================
// 1. toIsoMonth / numOrNull / boolOrNull
// ============================================================================

test("toIsoMonth: đọc 5 dạng tháng Amazon/Seller Central hay xuất", () => {
  assert.equal(toIsoMonth("2026-08").iso, "2026-08");
  assert.equal(toIsoMonth("2026-8").iso, "2026-08");
  assert.equal(toIsoMonth("2026-08-01").iso, "2026-08");
  assert.equal(toIsoMonth("August 2026").iso, "2026-08");
  assert.equal(toIsoMonth("aug 2026").iso, "2026-08");
  assert.equal(toIsoMonth("September 2026").iso, "2026-09");
  assert.equal(toIsoMonth("08/2026").iso, "2026-08");
  assert.equal(toIsoMonth("2026/08").iso, "2026-08");
});

test("toIsoMonth: tháng không đọc được → null (KHÔNG đoán, RPC cũng sẽ bỏ dòng)", () => {
  assert.equal(toIsoMonth("").iso, null);
  assert.equal(toIsoMonth(null).iso, null);
  assert.equal(toIsoMonth("N/A").iso, null);
  assert.equal(toIsoMonth("13/2026").iso, null);
  assert.equal(toIsoMonth("2026-13").iso, null);
});

test("toIsoMonth: 08/09 là MƠ HỒ (MM/YY hay YY/MM) → phải đánh dấu ambiguous", () => {
  const r = toIsoMonth("08/09");
  assert.equal(r.ambiguous, true, "phải báo mơ hồ để tầng trên cảnh báo");
});

test("numOrNull: đọc số thập phân + số có dấu phẩy nghìn; rác → null", () => {
  assert.equal(numOrNull("0.87"), 0.87);
  assert.equal(numOrNull("1,234.56"), 1234.56);
  assert.equal(numOrNull("-3.5"), -3.5);
  assert.equal(numOrNull("120"), 120);
  assert.equal(numOrNull("N/A"), null);
  assert.equal(numOrNull("-"), null);
  assert.equal(numOrNull(""), null);
  assert.equal(numOrNull(null), null);
  assert.equal(numOrNull("abc"), null);
});

test("boolOrNull: TRUE/yes/1 → true; false/no/0 → false; rác → null", () => {
  assert.equal(boolOrNull("TRUE"), true);
  assert.equal(boolOrNull("yes"), true);
  assert.equal(boolOrNull("1"), true);
  assert.equal(boolOrNull("False"), false);
  assert.equal(boolOrNull("no"), false);
  assert.equal(boolOrNull("N/A"), null);
});

// ============================================================================
// 2. parseStorageFeeReport
// ============================================================================

test("phí lưu kho: đọc cột GẠCH DƯỚI theo tên (đảo thứ tự cột vẫn chạy)", () => {
  const shuffled = [...FEE_HEADERS].reverse();
  const row = feeRow();
  const text = tsv(shuffled, [shuffled.map((h) => row[FEE_HEADERS.indexOf(h)])]);
  const p = parseStorageFeeReport(text);
  assert.equal(p.rows.length, 1);
  assert.equal(p.skipped, 0);
  assert.equal(p.rows[0].monthOfCharge, "2026-08");
  assert.equal(p.rows[0].estimatedMonthlyStorageFee, 9.4);
  assert.equal(p.rows[0].storageRate, 0.87);
  assert.equal(p.rows[0].averageQuantityOnHand, 120);
});

test("phí lưu kho: chuẩn hoá hoa/thường (fc, asin, fnsku, currency) + giữ số đo", () => {
  const p = parseStorageFeeReport(tsv(FEE_HEADERS, [feeRow()]));
  const r = p.rows[0];
  assert.equal(r.fulfillmentCenter, "ONT8");
  assert.equal(r.countryCode, "US");
  assert.equal(r.currency, "USD");
  assert.equal(r.asin, "B0DEMOA1");
  assert.equal(r.fnsku, "X001A1");
  assert.equal(r.eligibleForInventoryDiscount, true);
  assert.equal(r.qualifiesForInventoryDiscount, false);
  assert.equal(r.totalIncentiveFeeAmount, 1.2);
  assert.equal(r.longestSide, 8.5);
  assert.equal(r.volumeUnits, "cubic feet");
  assert.equal(r.source, "report");
});

test("phí lưu kho: thiếu cột month_of_charge → TỪ CHỐI cả file, nói rõ nghi ngờ sai report", () => {
  const headers = FEE_HEADERS.filter((h) => h !== "month_of_charge");
  const row = feeRow().filter((_, i) => FEE_HEADERS[i] !== "month_of_charge");
  const p = parseStorageFeeReport(tsv(headers, [row]));
  assert.equal(p.rows.length, 0);
  assert.match(p.warnings[0], /thiếu cột "month-of-charge"/);
  assert.match(p.warnings[0], /GET_FBA_STORAGE_FEE_CHARGES_DATA/);
});

test("phí lưu kho: thiếu CẢ asin lẫn fnsku → không nhập (phí mồ côi không gắn được sản phẩm)", () => {
  const headers = FEE_HEADERS.filter((h) => h !== "asin" && h !== "fnsku");
  const row = feeRow().filter((_, i) => !["asin", "fnsku"].includes(FEE_HEADERS[i]));
  const p = parseStorageFeeReport(tsv(headers, [row]));
  assert.equal(p.rows.length, 0);
  assert.match(p.warnings[0], /thiếu cả "asin" lẫn "fnsku"/);
});

test("phí lưu kho: dòng có tháng không đọc được → BỎ + đếm skipped + nêu mẫu thật", () => {
  const p = parseStorageFeeReport(tsv(FEE_HEADERS, [
    feeRow(),
    feeRow({ month_of_charge: "September", fnsku: "X001A2" }),
  ]));
  assert.equal(p.rows.length, 1);
  assert.equal(p.skipped, 1);
  assert.match(p.warnings.join("\n"), /bỏ 1 dòng/);
  assert.match(p.warnings.join("\n"), /"September"/);
});

test("phí lưu kho: dòng không có ASIN lẫn FNSKU → BỎ (không tạo dòng phí mồ côi)", () => {
  const p = parseStorageFeeReport(tsv(FEE_HEADERS, [feeRow(), feeRow({ asin: "", fnsku: "" })]));
  assert.equal(p.rows.length, 1);
  assert.equal(p.skipped, 1);
  assert.match(p.warnings.join("\n"), /không có ASIN\/FNSKU/);
});

test("phí lưu kho: KHÔNG cộng tiền khác tiền tệ — currencies liệt kê, tổng tách riêng", () => {
  const p = parseStorageFeeReport(tsv(FEE_HEADERS, [
    feeRow({ currency: "usd", estimated_monthly_storage_fee: "9.40" }),
    feeRow({ fnsku: "X001A2", currency: "cad", estimated_monthly_storage_fee: "11.52" }),
  ]));
  assert.deepEqual(p.currencies, ["CAD", "USD"]);
  assert.equal(p.byMonthFcCurrency["2026-08|ONT8|USD"].fee, 9.4);
  assert.equal(p.byMonthFcCurrency["2026-08|ONT8|CAD"].fee, 11.52);
  assert.match(p.warnings.join("\n"), /2 tiền tệ/);
  assert.match(p.warnings.join("\n"), /KHÔNG cộng gộp/);
});

test("phí lưu kho: tổng theo kỳ (tháng|FC|tiền) — không gộp 2 tháng thành một con số", () => {
  const p = parseStorageFeeReport(tsv(FEE_HEADERS, [
    feeRow({ month_of_charge: "2026-08", estimated_monthly_storage_fee: "9.40" }),
    feeRow({ month_of_charge: "2026-09", estimated_monthly_storage_fee: "20.52" }),
    feeRow({ month_of_charge: "2026-08", fulfillment_center: "phx7", estimated_monthly_storage_fee: "3.52" }),
  ]));
  assert.deepEqual(p.months, ["2026-08", "2026-09"]);
  assert.equal(p.byMonthFcCurrency["2026-08|ONT8|USD"].fee, 9.4);
  assert.equal(p.byMonthFcCurrency["2026-09|ONT8|USD"].fee, 20.52);
  assert.equal(p.byMonthFcCurrency["2026-08|PHX7|USD"].fee, 3.52);
});

test("phí lưu kho: phí không đọc được → null + cảnh báo (không suy ra 0)", () => {
  const p = parseStorageFeeReport(tsv(FEE_HEADERS, [
    feeRow({ estimated_monthly_storage_fee: "N/A" }),
  ]));
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0].estimatedMonthlyStorageFee, null);
  assert.equal(p.byMonthFcCurrency["2026-08|ONT8|USD"].fee, 0);
  assert.match(p.warnings.join("\n"), /không đọc được cột phí/);
  assert.match(p.warnings.join("\n"), /không suy ra 0/);
});

test("phí lưu kho: file rỗng / chỉ có tiêu đề → 0 dòng + cảnh báo rõ", () => {
  assert.match(parseStorageFeeReport("").warnings[0], /rỗng/);
  const headerOnly = tsv(FEE_HEADERS, []);
  const p = parseStorageFeeReport(headerOnly);
  assert.equal(p.rows.length, 0);
  assert.match(p.warnings.join("\n"), /không có dòng dữ liệu/);
});

test("phí lưu kho: tháng dạng chữ 'August 2026' vẫn nhập được (Seller Central xuất file chữ)", () => {
  const p = parseStorageFeeReport(tsv(FEE_HEADERS, [feeRow({ month_of_charge: "August 2026" })]));
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0].monthOfCharge, "2026-08");
  assert.equal(p.skipped, 0);
});

// ============================================================================
// 3. parseInboundNoncomplianceReport
// ============================================================================

test("phí inbound: đọc cột GẠCH NỐI theo tên + chuẩn hoá mã lô/FC/loại vấn đề", () => {
  const p = parseInboundNoncomplianceReport(tsv(NC_HEADERS, [ncRow()]));
  assert.equal(p.rows.length, 1);
  const r = p.rows[0];
  assert.equal(r.issueReportedDate, "2026-09-08");
  assert.equal(r.shipmentCreationDate, "2026-09-01");
  assert.equal(r.fbaShipmentId, "FBA15DG9WJKR");
  assert.equal(r.fbaCartonId, "FBA15DG9WJKR000001");
  assert.equal(r.fulfillmentCenterId, "ONT8");
  assert.equal(r.problemType, "OVERSIZED_CARTON");
  assert.equal(r.coachingLevel, "LEVEL_2");
  assert.equal(r.feeType, "MANUAL_PROCESSING");
  assert.equal(r.currency, "USD");
  assert.equal(r.feeTotal, 0.3);
  assert.equal(r.alertStatus, "ALERT");
  assert.equal(r.problemLevel, "CARTON");
});

test("phí inbound: expected/received/problem-quantity là SỐ NGUYÊN của DÒNG có vấn đề", () => {
  const p = parseInboundNoncomplianceReport(tsv(NC_HEADERS, [
    ncRow({ "expected-quantity": "100", "received-quantity": "93", "problem-quantity": "2" }),
  ]));
  assert.equal(p.rows[0].expectedQuantity, 100);
  assert.equal(p.rows[0].receivedQuantity, 93);
  assert.equal(p.rows[0].problemQuantity, 2);
  assert.match(p.warnings.join("\n"), /không cộng dồn hai cột này theo lô/);
});

test("phí inbound: thiếu issue-reported-date → TỪ CHỐI cả file (không có ngày thì không xếp được)", () => {
  const headers = NC_HEADERS.filter((h) => h !== "issue-reported-date");
  const row = ncRow().filter((_, i) => NC_HEADERS[i] !== "issue-reported-date");
  const p = parseInboundNoncomplianceReport(tsv(headers, [row]));
  assert.equal(p.rows.length, 0);
  assert.match(p.warnings[0], /thiếu cột "issue-reported-date"/);
});

test("phí inbound: thiếu problem-type → TỪ CHỐI (mọi dòng sẽ trùng khoá và bị gộp thành 1)", () => {
  const headers = NC_HEADERS.filter((h) => h !== "problem-type");
  const row = ncRow().filter((_, i) => NC_HEADERS[i] !== "problem-type");
  const p = parseInboundNoncomplianceReport(tsv(headers, [row]));
  assert.equal(p.rows.length, 0);
  assert.match(p.warnings[0], /thiếu cột "problem-type"/);
});

test("phí inbound: ngày không đọc được → BỎ dòng + nêu mẫu", () => {
  const p = parseInboundNoncomplianceReport(tsv(NC_HEADERS, [
    ncRow(),
    ncRow({ "issue-reported-date": "không rõ", "fba-carton-id": "X2" }),
  ]));
  assert.equal(p.rows.length, 1);
  assert.equal(p.skipped, 1);
  assert.match(p.warnings.join("\n"), /bỏ 1 dòng/);
});

test("phí inbound: ngày MM/DD/YYYY được hiểu theo lịch Mỹ NHƯNG phải cảnh báo", () => {
  const p = parseInboundNoncomplianceReport(tsv(NC_HEADERS, [ncRow({ "issue-reported-date": "09/08/2026" })]));
  assert.equal(p.rows[0].issueReportedDate, "2026-09-08");
  assert.match(p.warnings.join("\n"), /lịch Mỹ/);
});

test("phí inbound: file RỖNG là tin tốt (không có vấn đề gì), không phải lỗi", () => {
  const p = parseInboundNoncomplianceReport("");
  assert.equal(p.rows.length, 0);
  assert.match(p.warnings[0], /không có vấn đề\/phí nào được ghi nhận/);
  assert.match(p.warnings[0], /không phải lỗi/);
});

test("phí inbound: tổng phí theo loại phí × tiền tệ + danh sách lô + loại vấn đề", () => {
  const p = parseInboundNoncomplianceReport(tsv(NC_HEADERS, [
    ncRow(),
    ncRow({ "fba-carton-id": "C2", "problem-type": "missing_label", "fee-total": "0.55" }),
    ncRow({ "fba-shipment-id": "FBA17XYZ", "fba-carton-id": "C3", "problem-type": "damaged_item", "fee-type": "other", "fee-total": "2.00", currency: "usd" }),
  ]));
  assert.equal(p.rows.length, 3);
  assert.deepEqual(p.shipments, ["FBA15DG9WJKR", "FBA17XYZ"]);
  assert.deepEqual(p.problemTypes, ["DAMAGED_ITEM", "MISSING_LABEL", "OVERSIZED_CARTON"]);
  // Gom theo LOẠI PHÍ × TIỀN TỆ: đây là số tiền thật mất vì làm sai quy cách
  assert.equal(p.feeByType["MANUAL_PROCESSING|USD"].fee, 0.85);
  assert.equal(p.feeByType["MANUAL_PROCESSING|USD"].lines, 2);
  assert.equal(p.feeByType["OTHER|USD"].fee, 2.0);
  assert.equal(p.feeByType["OTHER|USD"].lines, 1);
});

test("phí inbound: không có SKU vẫn giữ dòng (vấn đề cấp carton) nhưng nói rõ hạn chế", () => {
  const p = parseInboundNoncomplianceReport(tsv(NC_HEADERS, [ncRow({ sku: "" })]));
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0].sku, "");
  assert.match(p.warnings.join("\n"), /không có SKU/);
});

// ============================================================================
// 4. Registry — một định nghĩa cho CLI, cron và test
// ============================================================================

test("registry: 4 loại report đúng reportType của Amazon + trần 4 giờ", () => {
  assert.deepEqual([...ALL_REPORT_KINDS], ["fc", "receipts", "storage-fees", "noncompliance"]);
  assert.equal(specOf("storage-fees").reportType, "GET_FBA_STORAGE_FEE_CHARGES_DATA");
  assert.equal(specOf("noncompliance").reportType, "GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA");
  assert.equal(specOf("fc").reportType, "GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA");
  assert.equal(specOf("receipts").reportType, "GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA");
  for (const k of ALL_REPORT_KINDS) {
    assert.equal(REPORT_SPECS[k].cooldownHours, 4, `${k}: report FBA daily trần 1 lần/4 giờ`);
    assert.ok(REPORT_SPECS[k].label.length > 5, `${k}: phải có nhãn tiếng Việt cho log`);
    assert.ok(REPORT_SPECS[k].screen.length > 0, `${k}: phải nói rõ nuôi màn nào`);
  }
  assert.equal(kindOfReportType("GET_FBA_STORAGE_FEE_CHARGES_DATA"), "storage-fees");
  assert.equal(kindOfReportType("GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE"), null);
});

test("registry: parseReportText điều phối đúng parser + tóm tắt 1 dòng để log", () => {
  const fee = parseReportText("storage-fees", tsv(FEE_HEADERS, [feeRow()]));
  assert.equal(fee.kind, "storage-fees");
  assert.equal(fee.rows.length, 1);
  assert.match(fee.summary, /1 dòng · tháng 2026-08 · phí 9.4 USD/);

  const nc = parseReportText("noncompliance", tsv(NC_HEADERS, [ncRow()]));
  assert.match(nc.summary, /1 dòng · 1 lô · phí 0.3 USD/);
  assert.match(nc.summary, /OVERSIZED_CARTON/);
});

test("registry: importParsedReport ghi qua MockDbAdapter và trả counts + currencies", async () => {
  const db = new MockDbAdapter();
  const parsed = parseReportText("storage-fees", tsv(FEE_HEADERS, [
    feeRow(),
    feeRow({ fnsku: "X001A2", currency: "cad", estimated_monthly_storage_fee: "11.52" }),
  ]));
  const out = await importParsedReport(db, "shop-1", parsed);
  assert.equal(out.inserted, 2);
  assert.equal(out.updated, 0);
  assert.equal(out.groups, 1, "1 tháng");
  assert.deepEqual(out.currencies, ["CAD", "USD"]);
  assert.equal(db.storageFees.length, 2);
});

test("registry: nhập LẠI cùng file → updated, không nhân đôi (idempotent)", async () => {
  const db = new MockDbAdapter();
  const parsed = parseReportText("storage-fees", tsv(FEE_HEADERS, [feeRow()]));
  await importParsedReport(db, "shop-1", parsed);
  const again = await importParsedReport(db, "shop-1", parsed);
  assert.equal(again.inserted, 0);
  assert.equal(again.updated, 1);
  assert.equal(db.storageFees.length, 1);
});

test("registry: report rỗng → không gọi RPC, trả counts 0 + skipped của parser", async () => {
  const db = new MockDbAdapter();
  const parsed = parseReportText("noncompliance", "");
  const out = await importParsedReport(db, "shop-1", parsed);
  assert.deepEqual(
    { inserted: out.inserted, updated: out.updated, groups: out.groups },
    { inserted: 0, updated: 0, groups: 0 },
  );
  assert.equal(db.noncompliance.length, 0);
});

test("registry: CHẶN ghi nhầm rows của report này sang bảng report khác", async () => {
  const db = new MockDbAdapter();
  const ncParsed = parseReportText("noncompliance", tsv(NC_HEADERS, [ncRow()]));
  await assert.rejects(
    () => importParsedReport(db, "shop-1", { ...ncParsed, kind: "storage-fees" }),
    /không phải của report "storage-fees"/,
  );
});

// ============================================================================
// 5. Luật ghi của MockDbAdapter phải GIỐNG RPC 0019
// ============================================================================

test("mock phí lưu kho: tháng sai dạng / thiếu ASIN+FNSKU → skipped (như RPC)", async () => {
  const db = new MockDbAdapter();
  const out = await db.upsertStorageFees("shop-1", [
    { monthOfCharge: "2026-08", fnsku: "X1", estimatedMonthlyStorageFee: 1 },
    { monthOfCharge: "August 2026", fnsku: "X2", estimatedMonthlyStorageFee: 2 },
    { monthOfCharge: "2026-08", fnsku: "", asin: "", estimatedMonthlyStorageFee: 3 },
  ]);
  assert.equal(out.inserted, 1);
  assert.equal(out.skipped, 2);
  assert.equal(out.groups, 1);
});

test("mock phí lưu kho: trùng khoá trong CÙNG file → gộp 1 dòng lấy số lớn hơn (như RPC max())", async () => {
  const db = new MockDbAdapter();
  const out = await db.upsertStorageFees("shop-1", [
    { monthOfCharge: "2026-08", fnsku: "X1", fulfillmentCenter: "ONT8", estimatedMonthlyStorageFee: 9.4, averageQuantityOnHand: 100 },
    { monthOfCharge: "2026-08", fnsku: "x1", fulfillmentCenter: "ont8", estimatedMonthlyStorageFee: 4.1, averageQuantityOnHand: 120 },
  ]);
  assert.equal(out.merged, 1);
  assert.equal(out.inserted, 1);
  assert.equal(db.storageFees.length, 1);
  assert.equal(db.storageFees[0].estimatedMonthlyStorageFee, 9.4, "max(9.4, 4.1)");
  assert.equal(db.storageFees[0].averageQuantityOnHand, 120, "max(100, 120)");
});

test("mock phí lưu kho: nhập lại — số MỚI khác null đè số cũ, null GIỮ số cũ (coalesce như RPC)", async () => {
  const db = new MockDbAdapter();
  await db.upsertStorageFees("shop-1", [
    { monthOfCharge: "2026-08", fnsku: "X1", estimatedMonthlyStorageFee: 9.4, currency: "USD", storageRate: 0.87 },
  ]);
  const out = await db.upsertStorageFees("shop-1", [
    { monthOfCharge: "2026-08", fnsku: "X1", estimatedMonthlyStorageFee: null, currency: "USD", storageRate: 2.4 },
  ]);
  assert.equal(out.updated, 1);
  assert.equal(out.inserted, 0);
  assert.equal(db.storageFees[0].estimatedMonthlyStorageFee, 9.4, "null không được xoá số cũ");
  assert.equal(db.storageFees[0].storageRate, 2.4, "số mới thắng");
});

test("mock phí inbound: khoá theo ngày × lô × carton × SKU × loại vấn đề", async () => {
  const db = new MockDbAdapter();
  const first = await db.upsertNoncompliance("shop-1", [
    { issueReportedDate: "2026-09-08", fbaShipmentId: "FBA1", fbaCartonId: "C1", sku: "S1", problemType: "OVERSIZED_CARTON", feeTotal: 0.3, currency: "USD" },
    { issueReportedDate: "2026-09-08", fbaShipmentId: "FBA1", fbaCartonId: "C2", sku: "S1", problemType: "OVERSIZED_CARTON", feeTotal: 0.5, currency: "USD" },
    { issueReportedDate: "2026-09-08", fbaShipmentId: "FBA1", fbaCartonId: "C1", sku: "S1", problemType: "MISSING_LABEL", feeTotal: 0.2, currency: "USD" },
    { issueReportedDate: "không rõ", fbaShipmentId: "FBA1", sku: "S1", problemType: "X" },
  ]);
  assert.equal(first.inserted, 3);
  assert.equal(first.skipped, 1);
  assert.equal(first.groups, 1, "1 lô");
  const again = await db.upsertNoncompliance("shop-1", [
    { issueReportedDate: "2026-09-08", fbaShipmentId: "fba1", fbaCartonId: "c1", sku: "S1", problemType: "oversized_carton", feeTotal: 0.45, currency: "usd" },
  ]);
  assert.equal(again.updated, 1);
  assert.equal(again.inserted, 0);
  assert.equal(db.noncompliance.length, 3);
});

test("mock trạng thái report: cùng (loại report, khoảng ngày) → 1 dòng, attempts tăng dần", async () => {
  const db = new MockDbAdapter();
  const a = await db.setReportRequest("shop-1", {
    reportType: "GET_FBA_STORAGE_FEE_CHARGES_DATA",
    dataStart: "2026-08-01", dataEnd: "2026-08-31",
    reportId: "ID-1", status: "requested", requestedAt: "2026-09-12T03:00:00Z",
  });
  assert.equal(a.attempts, 1);
  const b = await db.setReportRequest("shop-1", {
    reportType: "GET_FBA_STORAGE_FEE_CHARGES_DATA",
    dataStart: "2026-08-01", dataEnd: "2026-08-31",
    reportId: "ID-1", status: "in_progress",
  });
  assert.equal(b.id, a.id, "không được tạo dòng mới");
  assert.equal(b.attempts, 2);
  const c = await db.setReportRequest("shop-1", {
    reportType: "GET_FBA_STORAGE_FEE_CHARGES_DATA",
    dataStart: "2026-08-01", dataEnd: "2026-08-31",
    reportId: "ID-1", reportDocumentId: "DOC-1", status: "imported", rowsImported: 42,
  });
  assert.equal(c.attempts, 3);
  assert.equal(c.rowsImported, 42);
  assert.equal(c.reportDocumentId, "DOC-1");
  assert.equal(db.reportRequests.length, 1);
});

test("mock trạng thái report: khoảng ngày KHÁC → dòng khác (mỗi kỳ một vết)", async () => {
  const db = new MockDbAdapter();
  await db.setReportRequest("shop-1", { reportType: "T", dataStart: "2026-08-01", dataEnd: "2026-08-31", status: "imported" });
  await db.setReportRequest("shop-1", { reportType: "T", dataStart: "2026-09-01", dataEnd: "2026-09-12", status: "requested" });
  const list = await db.listReportRequests("shop-1");
  assert.equal(list.length, 2);
  const onlyT = await db.listReportRequests("shop-1", { reportType: "T" });
  assert.equal(onlyT.length, 2);
  const none = await db.listReportRequests("shop-2");
  assert.equal(none.length, 0, "không rò trạng thái sang shop khác");
});

test("mock trạng thái report: status lạ → 'failed' (đúng luật RPC, để view lọc được)", async () => {
  const db = new MockDbAdapter();
  const r = await db.setReportRequest("shop-1", { reportType: "T", status: "KHONG_RO" as never });
  assert.equal(r.status, "failed");
});

test("mock trạng thái report: thiếu reportType → ném lỗi (không ghi dòng mồ côi)", async () => {
  const db = new MockDbAdapter();
  await assert.rejects(
    () => db.setReportRequest("shop-1", { reportType: "  ", status: "requested" }),
    /thiếu reportType/,
  );
});

// ============================================================================
// 6. computePeriod
// ============================================================================

test("computePeriod: khoảng ngày theo lookback của từng loại report (UTC)", () => {
  const now = new Date("2026-09-12T03:00:00Z");
  assert.deepEqual(computePeriod("fc", { now }), {
    start: "2026-09-10", end: "2026-09-12",
    startIso: "2026-09-10T00:00:00Z", endIso: "2026-09-12T23:59:59Z",
  });
  assert.equal(computePeriod("receipts", { now }).start, "2026-08-13");
  assert.equal(computePeriod("storage-fees", { now }).start, "2026-06-09");
  assert.equal(computePeriod("noncompliance", { now }).start, "2026-07-14");
  assert.equal(computePeriod("storage-fees", { days: 7, now }).start, "2026-09-05");
  assert.equal(computePeriod("fc", { days: 0, now }).start, "2026-09-11", "days=0 → tối thiểu 1 ngày");
});

// ============================================================================
// 7. ReportsClient — HTTP, GZIP, retry, lỗi có cấu trúc
// ============================================================================

const fakeLwa = { getAccessToken: async () => "TOKEN" } as unknown as LwaTokenManager;

type FakeResponse = {
  status: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
  buf?: Uint8Array;
};

const makeFetch = (script: FakeResponse[]) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const spec = script[Math.min(calls.length - 1, script.length - 1)];
    const headers = new Map(Object.entries(spec.headers ?? {}));
    return {
      ok: spec.status >= 200 && spec.status < 300,
      status: spec.status,
      statusText: `HTTP ${spec.status}`,
      headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? headers.get(k) ?? null },
      json: async () => spec.body,
      text: async () => spec.text ?? JSON.stringify(spec.body ?? {}),
      arrayBuffer: async () => {
        const b = spec.buf ?? new TextEncoder().encode(spec.text ?? "");
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
};

test("createReport: gửi đúng body (reportType, marketplaceIds, khoảng ngày) + token LWA", async () => {
  const { fn, calls } = makeFetch([{ status: 202, body: { reportId: "ID-9" } }]);
  const c = new ReportsClient({ host: "https://example.test", lwa: fakeLwa, fetchFn: fn, sleep: async () => {} });
  const r = await c.createReport({
    reportType: "GET_FBA_STORAGE_FEE_CHARGES_DATA",
    marketplaceIds: ["ATVPDKIKX0DER"],
    dataStartTime: "2026-06-09T00:00:00Z",
    dataEndTime: "2026-09-12T23:59:59Z",
  });
  assert.equal(r.reportId, "ID-9");
  assert.equal(calls[0].url, "https://example.test/reports/2021-06-30/reports");
  const init = calls[0].init!;
  assert.equal(init.method, "POST");
  const headers = init.headers as Record<string, string>;
  assert.equal(headers["x-amz-access-token"], "TOKEN");
  assert.deepEqual(JSON.parse(String(init.body)), {
    reportType: "GET_FBA_STORAGE_FEE_CHARGES_DATA",
    marketplaceIds: ["ATVPDKIKX0DER"],
    dataStartTime: "2026-06-09T00:00:00Z",
    dataEndTime: "2026-09-12T23:59:59Z",
  });
});

test("createReport: KHÔNG gửi dataStartTime rỗng (Amazon trả 400 InvalidInput)", async () => {
  const { fn, calls } = makeFetch([{ status: 202, body: { reportId: "ID-10" } }]);
  const c = new ReportsClient({ host: "https://example.test", lwa: fakeLwa, fetchFn: fn, sleep: async () => {} });
  await c.createReport({ reportType: "T", marketplaceIds: ["M"], dataStartTime: null, dataEndTime: null });
  const body = JSON.parse(String(calls[0].init!.body)) as Record<string, unknown>;
  assert.equal("dataStartTime" in body, false);
  assert.equal("dataEndTime" in body, false);
});

test("createReport: Amazon không trả reportId → ném lỗi nói rõ (không âm thầm coi như xong)", async () => {
  const { fn } = makeFetch([{ status: 200, body: {} }]);
  const c = new ReportsClient({ host: "https://example.test", lwa: fakeLwa, fetchFn: fn, sleep: async () => {} });
  await assert.rejects(() => c.createReport({ reportType: "T", marketplaceIds: ["M"] }), /không trả reportId/);
});

test("getReport: trạng thái lạ → coi như IN_PROGRESS (poll tiếp, không bỏ cuộc oan)", () => {
  assert.equal(normalizeReportInfo({ processingStatus: "WEIRD" }).processingStatus, "IN_PROGRESS");
  assert.equal(normalizeReportInfo({}).processingStatus, "IN_PROGRESS");
  assert.equal(normalizeReportInfo({ processingStatus: "done", reportId: "R", documentId: "D" }).processingStatus, "DONE");
  const info = normalizeReportInfo({ processingStatus: "DONE", reportId: "R", documentId: "D", marketplaceIds: ["M"] });
  assert.equal(info.documentId, "D");
  assert.deepEqual(info.marketplaceIds, ["M"]);
});

test("downloadDocument: GZIP → tải URL rồi GIẢI NÉN ra TSV", async () => {
  const text = tsv(FEE_HEADERS, [feeRow()]);
  const gz = gzipSync(Buffer.from(text, "utf8"));
  const { fn, calls } = makeFetch([{ status: 200, buf: new Uint8Array(gz) }]);
  const c = new ReportsClient({ host: "https://example.test", lwa: fakeLwa, fetchFn: fn, sleep: async () => {} });
  const out = await c.downloadDocument({
    reportDocumentId: "DOC-1",
    compressionAlgorithm: "GZIP",
    content: "https://s3.example/report.gz",
  });
  assert.equal(out.gzipped, true);
  assert.equal(out.text, text);
  assert.equal(calls[0].url, "https://s3.example/report.gz");
  assert.ok(out.bytes > 0);
});

test("downloadDocument: không nén + content là URL → trả text thô", async () => {
  const text = tsv(NC_HEADERS, [ncRow()]);
  const { fn } = makeFetch([{ status: 200, text }]);
  const c = new ReportsClient({ host: "https://example.test", lwa: fakeLwa, fetchFn: fn, sleep: async () => {} });
  const out = await c.downloadDocument({ reportDocumentId: "D", content: "https://s3.example/r.tsv" });
  assert.equal(out.gzipped, false);
  assert.equal(out.text, text);
});

test("downloadDocument: content là NỘI DUNG trực tiếp (document nhỏ) → dùng luôn, không fetch", async () => {
  const text = tsv(NC_HEADERS, [ncRow()]);
  const { fn, calls } = makeFetch([{ status: 200, text: "KHÔNG ĐƯỢC GỌI" }]);
  const c = new ReportsClient({ host: "https://example.test", lwa: fakeLwa, fetchFn: fn, sleep: async () => {} });
  const out = await c.downloadDocument({ reportDocumentId: "D", content: text });
  assert.equal(out.text, text);
  assert.equal(calls.length, 0);
});

test("downloadDocument: báo GZIP mà content không phải URL → lỗi rõ ràng (không trả binary rác)", async () => {
  const { fn } = makeFetch([{ status: 200, text: "" }]);
  const c = new ReportsClient({ host: "https://example.test", lwa: fakeLwa, fetchFn: fn, sleep: async () => {} });
  await assert.rejects(
    () => c.downloadDocument({ reportDocumentId: "D", compressionAlgorithm: "GZIP", content: "abc" }),
    /không giải nén được/,
  );
  await assert.rejects(
    () => c.downloadDocument({ reportDocumentId: "D", content: "" }),
    /không trả content/,
  );
});

test("client: 429 có Retry-After → chờ rồi thử lại; hết lượt → SpApiRequestError.isThrottled", async () => {
  const waits: number[] = [];
  const { fn } = makeFetch([
    { status: 429, headers: { "retry-after": "2" }, text: '{"errors":[{"code":"QuotaExceeded","message":"slow down"}]}' },
    { status: 200, body: { reportId: "ID-1" } },
  ]);
  const c = new ReportsClient({
    host: "https://example.test", lwa: fakeLwa, fetchFn: fn,
    sleep: async (ms) => { waits.push(ms); },
  });
  const r = await c.createReport({ reportType: "T", marketplaceIds: ["M"] });
  assert.equal(r.reportId, "ID-1");
  assert.deepEqual(waits, [2000], "chờ đúng Retry-After");

  const { fn: fn2 } = makeFetch([
    { status: 429, text: '{"errors":[{"code":"QuotaExceeded","message":"slow down"}]}' },
    { status: 429, text: '{"errors":[{"code":"QuotaExceeded","message":"slow down"}]}' },
    { status: 429, text: '{"errors":[{"code":"QuotaExceeded","message":"slow down"}]}' },
    { status: 429, text: '{"errors":[{"code":"QuotaExceeded","message":"slow down"}]}' },
  ]);
  const c2 = new ReportsClient({ host: "https://example.test", lwa: fakeLwa, fetchFn: fn2, sleep: async () => {}, maxRetries: 2 });
  await assert.rejects(
    () => c2.createReport({ reportType: "T", marketplaceIds: ["M"] }),
    (e: unknown) => e instanceof SpApiRequestError && e.isThrottled === true && e.status === 429,
  );
});

test("client: 400 (sai tham số) → ném ngay, KHÔNG retry; isThrottled=false", async () => {
  const { fn, calls } = makeFetch([
    { status: 400, text: '{"errors":[{"code":"InvalidInput","message":"dataStartTime is invalid"}]}' },
  ]);
  const c = new ReportsClient({ host: "https://example.test", lwa: fakeLwa, fetchFn: fn, sleep: async () => {} });
  await assert.rejects(
    () => c.getReport("ID-1"),
    (e: unknown) => e instanceof SpApiRequestError && e.code === "InvalidInput" && e.isThrottled === false,
  );
  assert.equal(calls.length, 1, "400 không được retry");
});

test("client: 5xx → retry có backoff rồi thành công", async () => {
  const waits: number[] = [];
  const { fn, calls } = makeFetch([
    { status: 503, text: "service unavailable" },
    { status: 200, body: { reportId: "R", processingStatus: "DONE", documentId: "D" } },
  ]);
  const c = new ReportsClient({ host: "https://example.test", lwa: fakeLwa, fetchFn: fn, sleep: async (ms) => { waits.push(ms); } });
  const info = await c.getReport("R");
  assert.equal(info.processingStatus, "DONE");
  assert.equal(calls.length, 2);
  assert.equal(waits.length, 1);
});

test("fetchReportContent: chưa DONE → text null (job ghi pending, KHÔNG tải document)", async () => {
  const { fn } = makeFetch([{ status: 200, body: { reportId: "R", processingStatus: "IN_PROGRESS" } }]);
  const c = new ReportsClient({ host: "https://example.test", lwa: fakeLwa, fetchFn: fn, sleep: async () => {} });
  const out = await c.fetchReportContent("R");
  assert.equal(out.text, null);
  assert.equal(out.info.processingStatus, "IN_PROGRESS");
});

test("fetchReportContent: DONE mà thiếu documentId → lỗi rõ (không im lặng trả rỗng)", async () => {
  const { fn } = makeFetch([{ status: 200, body: { reportId: "R", processingStatus: "DONE" } }]);
  const c = new ReportsClient({ host: "https://example.test", lwa: fakeLwa, fetchFn: fn, sleep: async () => {} });
  await assert.rejects(() => c.fetchReportContent("R"), /không trả documentId/);
});

// ============================================================================
// 8. Job runReportPull — vòng đời thật của một lần cron chạy
// ============================================================================

type Scripted = {
  create?: (p: { reportType: string; dataStartTime?: string | null }) => Promise<{ reportId: string }>;
  statuses?: string[];
  document?: { text: string; gzipped?: boolean } | null;
  error?: unknown;
};

function fakeClient(script: Scripted) {
  const calls = { create: 0, getReport: 0, fetchContent: 0 };
  const client = {
    createReport: async (p: { reportType: string; dataStartTime?: string | null }) => {
      calls.create++;
      if (script.error) throw script.error;
      if (script.create) return script.create(p);
      return { reportId: `REP-${calls.create}` };
    },
    getReport: async (reportId: string) => {
      calls.getReport++;
      if (script.error) throw script.error;
      const st = (script.statuses ?? ["DONE"])[Math.min(calls.getReport - 1, (script.statuses ?? ["DONE"]).length - 1)];
      return normalizeReportInfo({ reportId, processingStatus: st, documentId: st === "DONE" ? "DOC-1" : null });
    },
    fetchReportContent: async (reportId: string) => {
      calls.fetchContent++;
      if (script.error) throw script.error;
      const st = (script.statuses ?? ["DONE"])[Math.min(calls.getReport, (script.statuses ?? ["DONE"]).length - 1)];
      if (st !== "DONE") {
        return { info: normalizeReportInfo({ reportId, processingStatus: st }), text: null, gzipped: false, bytes: 0, documentId: null };
      }
      const doc = script.document ?? { text: "" };
      return {
        info: normalizeReportInfo({ reportId, processingStatus: "DONE", documentId: "DOC-1" }),
        text: doc.text,
        gzipped: doc.gzipped === true,
        bytes: doc.text.length,
        documentId: "DOC-1",
      };
    },
  };
  return { client: client as unknown as ReportsClient, calls };
}

const noWait = { sleep: async () => {}, pollDelayMs: 0 };

test("job: chưa có credential → skipped kèm hướng dẫn nhập tay, KHÔNG ném lỗi", async () => {
  const db = new MockDbAdapter();
  const res = await runReportPull({ db, shops: [SHOP], kinds: ["storage-fees"], clientFor: () => null, ...noWait });
  assert.equal(res.outcomes.length, 1);
  assert.equal(res.outcomes[0].action, "skipped");
  assert.match(res.outcomes[0].message, /--storage-fees=<file>/);
  assert.equal(res.skipped, 1);
  assert.equal(res.failed, 0);
});

test("job: nạp từ file/text → parse + ghi DB (đi chung pipeline với API)", async () => {
  const db = new MockDbAdapter();
  const res = await runReportPull({
    db, shops: [SHOP], kinds: ["storage-fees"],
    texts: { "storage-fees": tsv(FEE_HEADERS, [feeRow(), feeRow({ fnsku: "X001A2", currency: "cad" })]) },
    ...noWait,
  });
  const o = res.outcomes[0];
  assert.equal(o.action, "imported");
  assert.equal(o.rows, 2);
  assert.equal(o.counts?.inserted, 2);
  assert.deepEqual(o.counts?.currencies, ["CAD", "USD"]);
  assert.equal(res.source, "file");
  assert.equal(db.storageFees.length, 2);
  assert.match(o.summary!, /2 dòng/);
});

test("job: dry-run → parse xong nhưng KHÔNG ghi gì (kể cả trạng thái report)", async () => {
  const db = new MockDbAdapter();
  const res = await runReportPull({
    db, shops: [SHOP], kinds: ["storage-fees"], dryRun: true,
    texts: { "storage-fees": tsv(FEE_HEADERS, [feeRow()]) },
    ...noWait,
  });
  assert.equal(res.outcomes[0].action, "dry_run");
  assert.equal(res.outcomes[0].rows, 1);
  assert.equal(db.storageFees.length, 0, "dry-run không được ghi bảng phí");
  assert.equal(db.reportRequests.length, 0, "dry-run không được ghi trạng thái report");
});

test("job: API — createReport rồi DONE ngay → nhập dữ liệu + ghi trạng thái imported", async () => {
  const db = new MockDbAdapter();
  const { client, calls } = fakeClient({
    statuses: ["DONE"],
    document: { text: tsv(FEE_HEADERS, [feeRow()]), gzipped: true },
  });
  // now cố định để khoảng ngày trong assert không trôi theo ngày chạy test
  const res = await runReportPull({
    db, shops: [SHOP], kinds: ["storage-fees"], clientFor: () => client,
    now: new Date("2026-09-12T03:00:00Z"), ...noWait,
  });
  const o = res.outcomes[0];
  assert.equal(o.action, "imported");
  assert.equal(o.status, "imported");
  assert.equal(o.reportId, "REP-1");
  assert.equal(o.period.start, "2026-06-09");
  assert.equal(o.period.end, "2026-09-12");
  assert.equal(o.documentId, "DOC-1");
  assert.equal(o.gzipped, true);
  assert.equal(calls.create, 1);
  assert.equal(db.storageFees.length, 1);
  const state = await db.listReportRequests("shop-1");
  assert.equal(state.length, 1);
  assert.equal(state[0].status, "imported");
  assert.equal(state[0].reportId, "REP-1");
  assert.equal(state[0].rowsImported, 1);
  assert.equal(state[0].dataStart, "2026-06-09", "lưu khoảng ngày để lần sau không xin lại");
});

test("job: Amazon còn đang tạo (IN_QUEUE → IN_PROGRESS) → trả pending, KHÔNG chờ vô hạn", async () => {
  const db = new MockDbAdapter();
  const { client, calls } = fakeClient({ statuses: ["IN_QUEUE", "IN_PROGRESS", "IN_PROGRESS"] });
  const res = await runReportPull({
    db, shops: [SHOP], kinds: ["noncompliance"], clientFor: () => client,
    pollAttempts: 3, pollDelayMs: 0, sleep: async () => {},
  });
  const o = res.outcomes[0];
  assert.equal(o.action, "pending");
  assert.equal(o.status, "in_progress");
  assert.equal(res.pending, 1);
  assert.equal(calls.getReport, 3, "poll đúng số lần cho phép");
  const state = await db.listReportRequests("shop-1");
  assert.equal(state[0].status, "in_progress");
  assert.equal(state[0].reportId, "REP-1", "lưu reportId để lần sau poll tiếp");
});

test("job: lần chạy sau POLL TIẾP report cũ — KHÔNG xin report mới (trần 1 lần/4 giờ)", async () => {
  const db = new MockDbAdapter();
  const first = fakeClient({ statuses: ["IN_PROGRESS", "IN_PROGRESS"] });
  await runReportPull({
    db, shops: [SHOP], kinds: ["storage-fees"], clientFor: () => first.client,
    pollAttempts: 2, ...noWait,
  });
  assert.equal(first.calls.create, 1);

  const second = fakeClient({
    statuses: ["DONE"],
    document: { text: tsv(FEE_HEADERS, [feeRow()]) },
  });
  const res = await runReportPull({
    db, shops: [SHOP], kinds: ["storage-fees"], clientFor: () => second.client,
    pollAttempts: 2, ...noWait,
  });
  assert.equal(second.calls.create, 0, "phải dùng lại reportId đang chờ");
  assert.equal(res.outcomes[0].action, "imported");
  assert.equal(res.outcomes[0].reportId, "REP-1");
  const state = await db.listReportRequests("shop-1");
  assert.equal(state.length, 1, "chỉ MỘT dòng trạng thái cho kỳ này");
  assert.equal(state[0].attempts >= 2, true, "mỗi lần chạm tăng attempts");
});

test("job: đã nhập xong kỳ này → bỏ qua, không kéo lại", async () => {
  const db = new MockDbAdapter();
  const done = fakeClient({ statuses: ["DONE"], document: { text: tsv(FEE_HEADERS, [feeRow()]) } });
  await runReportPull({ db, shops: [SHOP], kinds: ["storage-fees"], clientFor: () => done.client, ...noWait });
  const again = fakeClient({ statuses: ["DONE"], document: { text: tsv(FEE_HEADERS, [feeRow()]) } });
  const res = await runReportPull({ db, shops: [SHOP], kinds: ["storage-fees"], clientFor: () => again.client, ...noWait });
  assert.equal(res.outcomes[0].action, "skipped");
  assert.match(res.outcomes[0].message, /NHẬP XONG/);
  assert.equal(again.calls.create, 0);
  assert.equal(db.storageFees.length, 1, "không nhập lần hai");
});

test("job: trong cửa sổ 4 giờ mà report cũ LỖI → bỏ qua kèm lý do (không spam Amazon)", async () => {
  const db = new MockDbAdapter();
  await db.setReportRequest("shop-1", {
    reportType: "GET_FBA_STORAGE_FEE_CHARGES_DATA",
    dataStart: "2026-06-09", dataEnd: "2026-09-12",
    status: "failed", reportId: null, requestedAt: new Date().toISOString(),
    lastError: "429",
  });
  const { client, calls } = fakeClient({ statuses: ["DONE"] });
  const res = await runReportPull({
    db, shops: [SHOP], kinds: ["storage-fees"], clientFor: () => client,
    now: new Date(Date.now() + 60_000), ...noWait,
  });
  assert.equal(res.outcomes[0].action, "skipped");
  assert.match(res.outcomes[0].message, /1 lần \/ 4 giờ/);
  assert.equal(calls.create, 0);
});

test("job: quá 4 giờ thì được xin report mới", async () => {
  const db = new MockDbAdapter();
  await db.setReportRequest("shop-1", {
    reportType: "GET_FBA_STORAGE_FEE_CHARGES_DATA",
    dataStart: "2026-06-01", dataEnd: "2026-08-31",
    status: "failed", requestedAt: new Date(Date.now() - 5 * 3600_000).toISOString(),
  });
  const { client, calls } = fakeClient({ statuses: ["DONE"], document: { text: tsv(FEE_HEADERS, [feeRow()]) } });
  const res = await runReportPull({ db, shops: [SHOP], kinds: ["storage-fees"], clientFor: () => client, ...noWait });
  assert.equal(calls.create, 1);
  assert.equal(res.outcomes[0].action, "imported");
});

test("job: report DONE nhưng RỖNG → no_data (với phí inbound là tin tốt, không phải lỗi)", async () => {
  const db = new MockDbAdapter();
  const { client } = fakeClient({ statuses: ["DONE"], document: { text: "" } });
  const res = await runReportPull({ db, shops: [SHOP], kinds: ["noncompliance"], clientFor: () => client, ...noWait });
  const o = res.outcomes[0];
  assert.equal(o.action, "no_data");
  assert.equal(res.noData, 1);
  assert.equal(res.failed, 0);
  assert.match(o.message, /KHÔNG có vấn đề gì/);
  const state = await db.listReportRequests("shop-1");
  assert.equal(state[0].status, "no_data");
});

test("job: Amazon báo FATAL → failed + ghi trạng thái fatal kèm lỗi", async () => {
  const db = new MockDbAdapter();
  const { client } = fakeClient({ statuses: ["FATAL"] });
  const res = await runReportPull({ db, shops: [SHOP], kinds: ["storage-fees"], clientFor: () => client, ...noWait });
  assert.equal(res.outcomes[0].action, "failed");
  assert.equal(res.outcomes[0].status, "fatal");
  assert.equal(res.failed, 1);
  assert.equal(res.errors.length, 1);
  const state = await db.listReportRequests("shop-1");
  assert.equal(state[0].status, "fatal");
});

test("job: Amazon CANCELLED → failed + trạng thái cancelled", async () => {
  const db = new MockDbAdapter();
  const { client } = fakeClient({ statuses: ["CANCELLED"] });
  const res = await runReportPull({ db, shops: [SHOP], kinds: ["storage-fees"], clientFor: () => client, ...noWait });
  assert.equal(res.outcomes[0].status, "cancelled");
  assert.equal((await db.listReportRequests("shop-1"))[0].status, "cancelled");
});

test("job: bị trần tốc độ (429) → action 'throttled', phân biệt với lỗi thật", async () => {
  const db = new MockDbAdapter();
  const err = new SpApiRequestError({ code: "QuotaExceeded", message: "You exceeded your quota", status: 429 });
  const { client } = fakeClient({ error: err });
  const res = await runReportPull({ db, shops: [SHOP], kinds: ["storage-fees"], clientFor: () => client, ...noWait });
  assert.equal(res.outcomes[0].action, "throttled");
  assert.equal(res.throttled, 1);
  assert.match(res.outcomes[0].message, /trần tốc độ/);
  const state = await db.listReportRequests("shop-1");
  assert.equal(state[0].status, "failed");
  assert.match(state[0].lastError ?? "", /QuotaExceeded/);
});

test("job: lỗi 400 InvalidInput → failed (không phải throttled) và ghi lỗi để debug", async () => {
  const db = new MockDbAdapter();
  const err = new SpApiRequestError({ code: "InvalidInput", message: "dataStartTime invalid", status: 400 });
  const { client } = fakeClient({ error: err });
  const res = await runReportPull({ db, shops: [SHOP], kinds: ["storage-fees"], clientFor: () => client, ...noWait });
  assert.equal(res.outcomes[0].action, "failed");
  assert.equal(res.throttled, 0);
  assert.equal(res.failed, 1);
});

test("job: nhiều shop — một shop lỗi (403) không làm chết cả đợt của shop kia", async () => {
  const db = new MockDbAdapter();
  const shop2 = { id: "shop-2", displayName: "VEXIM · CA", marketplace: "A2EUQ1WTGCTBG2" };
  let n = 0;
  const res = await runReportPull({
    db,
    shops: [SHOP, shop2],
    kinds: ["storage-fees"],
    clientFor: (shop) => {
      n++;
      if (shop.id === "shop-2") {
        return { createReport: async () => { throw new Error("403 Access denied"); } } as unknown as ReportsClient;
      }
      return fakeClient({ statuses: ["DONE"], document: { text: tsv(FEE_HEADERS, [feeRow()]) } }).client;
    },
    ...noWait,
  });
  assert.equal(res.outcomes.length, 2);
  assert.equal(res.shopsProcessed, 2);
  assert.equal(n, 2, "mỗi shop một client riêng");
  assert.equal(res.imported, 1, "shop-1 vẫn nhập được");
  assert.equal(res.failed, 1, "shop-2 lỗi thì ghi lỗi, không kéo shop-1 theo");
  assert.equal(db.storageFees.length, 1);
  assert.equal(db.storageFees[0].sellerAccountId ?? "shop-1", "shop-1");
  const s2 = await db.listReportRequests("shop-2");
  assert.equal(s2[0].status, "failed");
  assert.match(s2[0].lastError ?? "", /403/);
});

test("job: cảnh báo của parser được đưa vào outcome để cron route in ra", async () => {
  const db = new MockDbAdapter();
  const res = await runReportPull({
    db, shops: [SHOP], kinds: ["storage-fees"],
    texts: { "storage-fees": tsv(FEE_HEADERS, [feeRow(), feeRow({ month_of_charge: "???", fnsku: "X9" })]) },
    ...noWait,
  });
  assert.equal(res.outcomes[0].warnings.length > 0, true);
  assert.match(res.outcomes[0].warnings.join("\n"), /bỏ 1 dòng/);
});

test("job: ghi trạng thái report lỗi → job vẫn chạy tiếp (không chết cả đợt vì 1 bảng)", async () => {
  const db = new MockDbAdapter();
  // Phá setReportRequest để mô phỏng bảng chưa migrate / RPC chưa có
  (db as unknown as { setReportRequest: unknown }).setReportRequest = async () => {
    throw new Error("PGRST202: function vexim_worker_set_report_request does not exist");
  };
  const { client } = fakeClient({ statuses: ["DONE"], document: { text: tsv(FEE_HEADERS, [feeRow()]) } });
  const logs: string[] = [];
  const res = await runReportPull({
    db, shops: [SHOP], kinds: ["storage-fees"], clientFor: () => client,
    log: (s) => logs.push(s), ...noWait,
  });
  assert.equal(res.outcomes[0].action, "imported", "dữ liệu vẫn phải vào bảng phí");
  assert.match(logs.join(""), /không ghi được trạng thái report/);
});
