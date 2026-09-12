/**
 * Test model PHÍ THEO FC (migration 0019) — phí lưu kho · phí inbound · trạng thái report.
 *
 * Bốn thứ phải khoá:
 *   1. Chuỗi select PHẢI khớp hợp đồng cột của 5 view (harness BƯỚC 20 soát trên
 *      Postgres thật) — sai một cột là PGRST204 và SẬP trang.
 *   2. PostgREST trả numeric/bigint dạng CHUỖI ("10.79", "89.2"). Mapper phải ép
 *      số, nếu không UI nối chuỗi ("9.40" + "3.60" = "9.403.60").
 *   3. KHÔNG BAO GIỜ cộng tiền khác tiền tệ: mọi hàm tổng đều nhóm theo currency.
 *   4. Không có số → nhãn "chưa rõ", KHÔNG bịa 0 (0 USD nghĩa là "không tốn phí",
 *      khác hẳn "chưa biết phí").
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  INBOUND_ISSUE_SELECT,
  INBOUND_ISSUE_SHIPMENT_SELECT,
  REPORT_REQUEST_SELECT,
  STORAGE_FEE_BY_FC_SELECT,
  STORAGE_FEE_SELECT,
  feeByFcForMonth,
  feeByFcForSku,
  feeTrend,
  formatFeeSharePct,
  issueFeesByCurrency,
  issuesForShipment,
  latestFeeMonth,
  mapInboundIssueRow,
  mapInboundIssueShipmentRow,
  mapReportRequestRow,
  mapStorageFeeByFcRow,
  mapStorageFeeRow,
  mergeInboundIssues,
  moneyLabel,
  monthLabel,
  problemTypeLabel,
  reportTypeLabel,
  severityOf,
  storageFeesForSku,
  type InboundIssueRaw,
  type InboundIssueShipmentRaw,
  type ReportRequestRaw,
  type StorageFeeByFcRaw,
  type StorageFeeRaw,
} from "../src/lib/data/fees-model.ts";

/* ------------------------------------------------------------------ */
/* Fixture                                                              */
/* ------------------------------------------------------------------ */

const feeRaw = (over: Partial<StorageFeeRaw> = {}): StorageFeeRaw => ({
  seller_account_id: "shop-1",
  shop: "VEXIM · US",
  month_of_charge: "2026-08",
  fnsku: "X001A1",
  asin: "B0DEMOA1",
  sku: "VPN-220",
  sku_source: "fnsku",
  product_name: "Vali 20 inch",
  fc: "ONT8",
  country_code: "US",
  product_size_tier: "STANDARD",
  average_quantity_on_hand: "120.5",
  average_quantity_pending_removal: "0",
  average_quantity_customer_orders: "30",
  estimated_total_item_volume: "10.8",
  volume_units: "cubic feet",
  storage_rate: "0.87",
  currency: "USD",
  estimated_monthly_storage_fee: "10.79",
  dangerous_goods_storage_type: "",
  eligible_for_inventory_discount: true,
  qualifies_for_inventory_discount: false,
  total_incentive_fee_amount: "1.20",
  source: "report",
  imported_at: "2026-09-12T03:00:00Z",
  ...over,
});

const byFcRaw = (over: Partial<StorageFeeByFcRaw> = {}): StorageFeeByFcRaw => ({
  seller_account_id: "shop-1",
  shop: "VEXIM · US",
  month_of_charge: "2026-08",
  fc: "ONT8",
  currency: "USD",
  storage_fee: "10.79",
  total_volume: "12.4",
  avg_units_on_hand: "120.5",
  product_lines: "1",
  fnsku_count: "1",
  volume_units: "cubic feet",
  month_fee_total: "12.10",
  month_fc_count: "3",
  fee_share_pct: "89.2",
  imported_at: "2026-09-12T03:00:00Z",
  ...over,
});

const issueRaw = (over: Partial<InboundIssueRaw> = {}): InboundIssueRaw => ({
  seller_account_id: "shop-1",
  shop: "VEXIM · US",
  issue_reported_date: "2026-09-08",
  days_ago: "4",
  shipment_creation_date: "2026-09-01",
  shipment_id: "FBA15DG9WJKR",
  carton_id: "FBA15DG9WJKR000001",
  fc: "ONT8",
  sku: "VPN-220",
  fnsku: "X001A1",
  asin: "B0DEMOA1",
  product_name: "Vali 20 inch",
  problem_type: "OVERSIZED_CARTON",
  problem_quantity: "2",
  expected_quantity: "100",
  received_quantity: "93",
  performance_measurement_unit: "UNIT",
  coaching_level: "LEVEL_2",
  fee_type: "MANUAL_PROCESSING",
  currency: "USD",
  fee_total: "0.30",
  problem_level: "CARTON",
  alert_status: "ALERT",
  source: "report",
  imported_at: "2026-09-12T03:00:00Z",
  ...over,
});

const issueShipRaw = (over: Partial<InboundIssueShipmentRaw> = {}): InboundIssueShipmentRaw => ({
  seller_account_id: "shop-1",
  shop: "VEXIM · US",
  shipment_id: "FBA15DG9WJKR",
  fc: "ONT8",
  shipment_creation_date: "2026-09-01",
  currency: "USD",
  issue_count: "2",
  fee_total: "0.85",
  problem_units: "7",
  sku_count: "1",
  first_issue_date: "2026-09-08",
  last_issue_date: "2026-09-08",
  problem_types: "MISSING_LABEL, OVERSIZED_CARTON",
  coaching_levels: "LEVEL_1, LEVEL_2",
  alert_statuses: "ALERT",
  shipment_status: "CLOSED",
  imported_at: "2026-09-12T03:00:00Z",
  ...over,
});

const requestRaw = (over: Partial<ReportRequestRaw> = {}): ReportRequestRaw => ({
  id: "rr-1",
  seller_account_id: "shop-1",
  shop: "VEXIM · US",
  report_type: "GET_FBA_STORAGE_FEE_CHARGES_DATA",
  marketplace_id: "ATVPDKIKX0DER",
  data_start: "2026-06-09",
  data_end: "2026-09-12",
  report_id: "ID3-REP-1",
  report_document_id: "amzn1.spdoc.1.4.demo",
  status: "imported",
  rows_imported: "5",
  attempts: "3",
  last_error: null,
  requested_at: "2026-09-12T03:00:00Z",
  completed_at: "2026-09-12T03:02:00Z",
  imported_at: "2026-09-12T03:02:00Z",
  age_minutes: "12",
  is_stale: false,
  ...over,
});

/* ------------------------------------------------------------------ */
/* 1. Hợp đồng cột — sai một cột là sập trang (PGRST204)                */
/* ------------------------------------------------------------------ */

test("select khớp đúng hợp đồng cột của 5 view 0019", () => {
  assert.equal(
    STORAGE_FEE_SELECT,
    "seller_account_id,shop,month_of_charge,fnsku,asin,sku,sku_source,product_name,fc," +
      "country_code,product_size_tier,average_quantity_on_hand,average_quantity_pending_removal," +
      "average_quantity_customer_orders,estimated_total_item_volume,volume_units,storage_rate," +
      "currency,estimated_monthly_storage_fee,dangerous_goods_storage_type," +
      "eligible_for_inventory_discount,qualifies_for_inventory_discount,total_incentive_fee_amount," +
      "source,imported_at",
  );
  assert.equal(
    STORAGE_FEE_BY_FC_SELECT,
    "seller_account_id,shop,month_of_charge,fc,currency,storage_fee,total_volume," +
      "avg_units_on_hand,product_lines,fnsku_count,volume_units,month_fee_total," +
      "month_fc_count,fee_share_pct,imported_at",
  );
  assert.equal(
    INBOUND_ISSUE_SELECT,
    "seller_account_id,shop,issue_reported_date,days_ago,shipment_creation_date,shipment_id," +
      "carton_id,fc,sku,fnsku,asin,product_name,problem_type,problem_quantity,expected_quantity," +
      "received_quantity,performance_measurement_unit,coaching_level,fee_type,currency,fee_total," +
      "problem_level,alert_status,source,imported_at",
  );
  assert.equal(
    INBOUND_ISSUE_SHIPMENT_SELECT,
    "seller_account_id,shop,shipment_id,fc,shipment_creation_date,currency,issue_count," +
      "fee_total,problem_units,sku_count,first_issue_date,last_issue_date,problem_types," +
      "coaching_levels,alert_statuses,shipment_status,imported_at",
  );
  assert.equal(
    REPORT_REQUEST_SELECT,
    "id,seller_account_id,shop,report_type,marketplace_id,data_start,data_end,report_id," +
      "report_document_id,status,rows_imported,attempts,last_error,requested_at,completed_at," +
      "imported_at,age_minutes,is_stale",
  );
});

/* ------------------------------------------------------------------ */
/* 2. Ép kiểu: numeric về chuỗi → số                                    */
/* ------------------------------------------------------------------ */

test("mapStorageFeeRow: ép chuỗi thành SỐ (không để UI nối chuỗi)", () => {
  const r = mapStorageFeeRow(feeRaw());
  assert.equal(r.fee, 10.79);
  assert.equal(r.storageRate, 0.87);
  assert.equal(r.avgOnHand, 120.5);
  assert.equal(r.totalVolume, 10.8);
  assert.equal(r.incentive, 1.2);
  assert.equal(typeof r.fee, "number");
});

test("mapStorageFeeRow: phí null → nhãn 'chưa rõ phí', KHÔNG hiện 0", () => {
  const r = mapStorageFeeRow(feeRaw({ estimated_monthly_storage_fee: null }));
  assert.equal(r.fee, null);
  assert.equal(r.feeLabel, "chưa rõ phí");
  const ok = mapStorageFeeRow(feeRaw());
  assert.equal(ok.feeLabel, "10,79 USD");
});

test("mapStorageFeeRow: SKU suy ra phải kèm nhãn nguồn (fnsku/asin/none)", () => {
  assert.equal(mapStorageFeeRow(feeRaw({ sku_source: "fnsku" })).skuSourceLabel, "khớp FNSKU");
  assert.equal(mapStorageFeeRow(feeRaw({ sku_source: "asin" })).skuSourceLabel, "khớp ASIN");
  const none = mapStorageFeeRow(feeRaw({ sku: null, sku_source: "none" }));
  assert.equal(none.sku, null);
  assert.equal(none.skuSource, "none");
  assert.equal(none.skuSourceLabel, "chưa gắn được SKU");
  // nguồn lạ → coi như chưa gắn được (không đoán)
  assert.equal(mapStorageFeeRow(feeRaw({ sku_source: "weird" })).skuSource, "none");
});

test("mapStorageFeeRow: FC rỗng → '(không rõ FC)', boolean giữ null khi report không nói", () => {
  assert.equal(mapStorageFeeRow(feeRaw({ fc: null })).fc, "(không rõ FC)");
  assert.equal(mapStorageFeeRow(feeRaw({ eligible_for_inventory_discount: null })).eligibleDiscount, null);
  assert.equal(mapStorageFeeRow(feeRaw({ qualifies_for_inventory_discount: false })).qualifiesDiscount, false);
});

test("mapStorageFeeByFcRow: số + % + tổng kỳ đều là số; % null → 'không rõ %'", () => {
  const r = mapStorageFeeByFcRow(byFcRaw());
  assert.equal(r.fee, 10.79);
  assert.equal(r.sharePct, 89.2);
  assert.equal(r.shareLabel, "89,2%");
  assert.equal(r.monthTotal, 12.1);
  assert.equal(r.monthFcCount, 3);
  assert.equal(r.lines, 1);
  const unknown = mapStorageFeeByFcRow(byFcRaw({ storage_fee: null, fee_share_pct: null }));
  assert.equal(unknown.fee, null);
  assert.equal(unknown.shareLabel, "không rõ %");
  assert.equal(unknown.feeLabel, "chưa rõ phí");
  assert.equal(formatFeeSharePct(null), "không rõ %");
});

test("monthLabel + moneyLabel: định dạng kiểu Việt Nam, luôn kèm đơn vị tiền", () => {
  assert.equal(monthLabel("2026-08"), "T08/2026");
  assert.equal(monthLabel("2026-8"), "2026-8", "tháng không đúng dạng → giữ nguyên, không bịa");
  assert.equal(moneyLabel(1234.5, "USD"), "1.234,50 USD");
  assert.equal(moneyLabel(0, "CAD"), "0,00 CAD");
  assert.equal(moneyLabel(null, "USD"), "chưa rõ phí");
  assert.equal(moneyLabel(1.5, null), "1,50");
});

/* ------------------------------------------------------------------ */
/* 3. KHÔNG cộng tiền khác tiền tệ                                      */
/* ------------------------------------------------------------------ */

test("feeByFcForMonth: nhóm theo currency — USD và CAD không bao giờ nằm một bảng", () => {
  const rows = [
    mapStorageFeeByFcRow(byFcRaw({ fc: "ONT8", currency: "USD", storage_fee: "10.79", fee_share_pct: "89.2" })),
    mapStorageFeeByFcRow(byFcRaw({ fc: "PHX7", currency: "USD", storage_fee: "1.31", fee_share_pct: "10.8" })),
    mapStorageFeeByFcRow(byFcRaw({ fc: "ONT8", currency: "CAD", storage_fee: "3.60", fee_share_pct: "100" })),
  ];
  const groups = feeByFcForMonth(rows, "2026-08");
  assert.equal(groups.length, 2);
  assert.equal(groups[0].currency, "USD", "nhóm tiền lớn hơn lên trước");
  assert.equal(groups[0].total, 12.1);
  assert.deepEqual(groups[0].rows.map((r) => r.fc), ["ONT8", "PHX7"], "FC phí cao hơn lên trước");
  assert.equal(groups[1].currency, "CAD");
  assert.equal(groups[1].total, 3.6);
});

test("feeByFcForMonth: lọc đúng kỳ + cả nhóm không đọc được phí → total null (không bịa 0)", () => {
  const rows = [
    mapStorageFeeByFcRow(byFcRaw({ month_of_charge: "2026-08", storage_fee: "10.00" })),
    mapStorageFeeByFcRow(byFcRaw({ month_of_charge: "2026-09", storage_fee: "22.00" })),
  ];
  assert.equal(feeByFcForMonth(rows, "2026-09").length, 1);
  assert.equal(feeByFcForMonth(rows, "2026-09")[0].rows[0].fee, 22);
  assert.equal(feeByFcForMonth(rows, "2026-07").length, 0);
  const allNull = feeByFcForMonth(
    [mapStorageFeeByFcRow(byFcRaw({ storage_fee: null }))],
    "2026-08",
  );
  assert.equal(allNull[0].total, null);
});

test("issueFeesByCurrency: tổng phí inbound tách theo tiền tệ", () => {
  const rows = [
    mapInboundIssueRow(issueRaw({ fee_total: "0.30", currency: "USD" })),
    mapInboundIssueRow(issueRaw({ fee_total: "0.55", currency: "USD", carton_id: "C2" })),
    mapInboundIssueRow(issueRaw({ fee_total: "2.00", currency: "CAD", carton_id: "C3" })),
    mapInboundIssueRow(issueRaw({ fee_total: null, currency: "USD", carton_id: "C4" })),
  ];
  const totals = issueFeesByCurrency(rows);
  assert.equal(totals.length, 2, "hai tiền tệ = hai nhóm, không cộng chung");
  assert.equal(totals[0].currency, "CAD", "nhóm phí lớn hơn lên trước");
  assert.equal(totals[0].fee, 2);
  assert.equal(totals[1].currency, "USD");
  assert.equal(totals[1].fee, 0.85);
  assert.equal(totals[1].count, 2, "dòng không đọc được phí không được đếm");
});

test("feeTrend: cộng các kỳ CÙNG tiền tệ; khác tiền tệ thì không cộng", () => {
  const rows = [
    mapStorageFeeRow(feeRaw({ month_of_charge: "2026-08", estimated_monthly_storage_fee: "10.00", currency: "USD" })),
    mapStorageFeeRow(feeRaw({ month_of_charge: "2026-08", fc: "PHX7", estimated_monthly_storage_fee: "2.00", currency: "USD" })),
    mapStorageFeeRow(feeRaw({ month_of_charge: "2026-09", estimated_monthly_storage_fee: "22.50", currency: "USD" })),
  ];
  const trend = feeTrend(rows);
  assert.deepEqual(trend.map((t) => t.month), ["2026-08", "2026-09"]);
  assert.equal(trend[0].fee, 12);
  assert.equal(trend[1].fee, 22.5);
  assert.equal(trend[0].monthLabel, "T08/2026");

  const mixed = feeTrend([
    mapStorageFeeRow(feeRaw({ month_of_charge: "2026-08", estimated_monthly_storage_fee: "10.00", currency: "USD" })),
    mapStorageFeeRow(feeRaw({ month_of_charge: "2026-08", fc: "ONT8", estimated_monthly_storage_fee: "3.60", currency: "CAD", fnsku: "X2" })),
  ]);
  assert.equal(mixed[0].fee, 10, "không cộng 10 USD với 3.60 CAD");
});

/* ------------------------------------------------------------------ */
/* 4. Truy vấn phía UI                                                  */
/* ------------------------------------------------------------------ */

test("latestFeeMonth: kỳ mới nhất có dữ liệu; rỗng → null", () => {
  assert.equal(latestFeeMonth([{ month: "2026-08" }, { month: "2026-09" }, { month: "2026-07" }]), "2026-09");
  assert.equal(latestFeeMonth([]), null);
});

test("storageFeesForSku: khớp theo SKU HOẶC FNSKU HOẶC ASIN (report phí không có SKU)", () => {
  const rows = [
    mapStorageFeeRow(feeRaw({ sku: "VPN-220", fnsku: "X001A1", month_of_charge: "2026-08" })),
    mapStorageFeeRow(feeRaw({ sku: null, sku_source: "none", fnsku: "X001A1", asin: "B0OTHER", month_of_charge: "2026-09" })),
    mapStorageFeeRow(feeRaw({ sku: "OTHER-SKU", fnsku: "X999", asin: "B999", month_of_charge: "2026-08" })),
  ];
  // Chỉ có SKU: dòng chưa gắn được SKU (sku_source='none') KHÔNG khớp — đúng,
  // vì không có bằng chứng nào nối nó với SKU này.
  assert.equal(storageFeesForSku(rows, { sku: "vpn-220" }).length, 1);
  // I2 luôn đưa cả FNSKU (từ report 0018) và ASIN (từ catalog) → bắt được dòng
  // phí mà view chưa gắn SKU, thay vì giấu mất phí thật của sản phẩm.
  const bySku = storageFeesForSku(rows, { sku: "vpn-220", fnsku: "X001A1" });
  assert.equal(bySku.length, 2, "khớp SKU + dòng chưa gắn SKU nhưng trùng FNSKU");
  assert.equal(bySku[0].month, "2026-09", "kỳ mới hơn lên trước");
  assert.equal(storageFeesForSku(rows, { asin: "B999" }).length, 1);
  assert.equal(storageFeesForSku(rows, {}).length, 0, "không có thông tin gì → không đoán bừa");
});

test("feeByFcForSku: lọc đúng kỳ, phí lớn nhất lên trước", () => {
  const rows = [
    mapStorageFeeRow(feeRaw({ month_of_charge: "2026-08", fc: "ONT8", estimated_monthly_storage_fee: "10.00" })),
    mapStorageFeeRow(feeRaw({ month_of_charge: "2026-08", fc: "PHX7", estimated_monthly_storage_fee: "22.00" })),
    mapStorageFeeRow(feeRaw({ month_of_charge: "2026-09", fc: "ONT8", estimated_monthly_storage_fee: "5.00" })),
  ];
  const list = feeByFcForSku(rows, "2026-08");
  assert.deepEqual(list.map((r) => r.fc), ["PHX7", "ONT8"]);
});

/* ------------------------------------------------------------------ */
/* 5. Phí inbound                                                       */
/* ------------------------------------------------------------------ */

test("mapInboundIssueRow: dịch loại vấn đề + ép số + nhãn ngày", () => {
  const r = mapInboundIssueRow(issueRaw());
  assert.equal(r.problemTypeLabel, "Thùng quá khổ");
  assert.equal(r.problemType, "OVERSIZED_CARTON");
  assert.equal(r.expected, 100);
  assert.equal(r.received, 93);
  assert.equal(r.problemQty, 2);
  assert.equal(r.fee, 0.3);
  assert.equal(r.dateLabel, "2026-09-08 (4 ngày trước)");
  assert.equal(r.tone, "warn", "ALERT → vàng");
});

test("problemTypeLabel: loại vấn đề lạ → giữ nguyên mã (không dịch bừa)", () => {
  assert.equal(problemTypeLabel("MISSING_LABEL"), "Thiếu nhãn");
  assert.equal(problemTypeLabel("DAMAGED_ITEM"), "Hàng hư hỏng");
  assert.equal(problemTypeLabel("SOMETHING_NEW"), "SOMETHING_NEW");
  assert.equal(problemTypeLabel(""), "(không rõ loại)");
});

test("severityOf + tone: CRITICAL/LEVEL_3 → đỏ, ALERT/LEVEL_2 → vàng, còn lại xám", () => {
  assert.equal(severityOf(["CRITICAL"]), 3);
  assert.equal(severityOf(["LEVEL_1"]), 1);
  assert.equal(severityOf([null, "ALERT"]), 2);
  assert.equal(mapInboundIssueRow(issueRaw({ alert_status: "CRITICAL" })).tone, "down");
  assert.equal(mapInboundIssueRow(issueRaw({ alert_status: null, coaching_level: null, fee_total: null })).tone, "flat");
});

test("mapInboundIssueShipmentRow: tách danh sách + dịch nhãn + KHÔNG cộng tiền khác currency", () => {
  const r = mapInboundIssueShipmentRow(issueShipRaw());
  assert.deepEqual(r.problemTypes, ["Thiếu nhãn", "Thùng quá khổ"]);
  assert.deepEqual(r.coachingLevels, ["LEVEL_1", "LEVEL_2"]);
  assert.deepEqual(r.alertStatuses, ["ALERT"]);
  assert.equal(r.issueCount, 2);
  assert.equal(r.fee, 0.85);
  assert.equal(r.feeLabel, "0,85 USD");
  assert.equal(r.problemUnits, 7);
  assert.equal(r.shipmentStatus, "CLOSED");
  assert.equal(r.firstDate, "2026-09-08");
  assert.equal(r.tone, "warn");
  // mỗi dòng là MỘT currency (view nhóm theo currency) → nhãn luôn kèm đơn vị
  const cad = mapInboundIssueShipmentRow(issueShipRaw({ currency: "CAD", fee_total: "1.00" }));
  assert.equal(cad.feeLabel, "1,00 CAD");
});

test("issuesForShipment: lọc đúng lô (không phân biệt hoa thường), mới nhất lên trước", () => {
  const rows = [
    mapInboundIssueRow(issueRaw({ issue_reported_date: "2026-09-08", carton_id: "C1" })),
    mapInboundIssueRow(issueRaw({ issue_reported_date: "2026-09-09", carton_id: "C2" })),
    mapInboundIssueRow(issueRaw({ shipment_id: "FBA_OTHER", carton_id: "C3" })),
  ];
  const list = issuesForShipment(rows, "fba15dg9wjkr");
  assert.equal(list.length, 2);
  assert.equal(list[0].date, "2026-09-09");
});

test("mergeInboundIssues: ghép phí vào lô, lô không có vấn đề giữ '—', lô mồ côi trả về riêng", () => {
  const inbound = [{ id: "FBA15DG9WJKR" }, { id: "FBA_CLEAN" }];
  const issues = [mapInboundIssueShipmentRow(issueShipRaw()), mapInboundIssueShipmentRow(issueShipRaw({ shipment_id: "FBA_OLD_CLOSED" }))];
  const merged = mergeInboundIssues(inbound, issues);
  assert.equal(merged.matched, 1);
  assert.equal(merged.rows[0].issueCount, 2);
  assert.equal(merged.rows[0].issueFeeLabel, "0,85 USD");
  assert.equal(merged.rows[0].issueTone, "warn");
  assert.equal(merged.rows[1].issueCount, undefined, "lô không có vấn đề → không bịa số 0");
  assert.equal(merged.orphans.length, 1);
  assert.equal(merged.orphans[0].shipmentId, "FBA_OLD_CLOSED");
});

/* ------------------------------------------------------------------ */
/* 6. Trạng thái cron Reports API                                       */
/* ------------------------------------------------------------------ */

test("mapReportRequestRow: nhãn tiếng Việt cho từng trạng thái + kỳ dữ liệu", () => {
  assert.equal(mapReportRequestRow(requestRaw()).statusLabel, "đã nhập");
  assert.equal(mapReportRequestRow(requestRaw()).period, "2026-06-09 → 2026-09-12");
  assert.equal(mapReportRequestRow(requestRaw({ status: "in_progress" })).statusLabel, "Amazon đang tạo");
  assert.equal(mapReportRequestRow(requestRaw({ status: "no_data" })).statusLabel, "report rỗng");
  assert.equal(mapReportRequestRow(requestRaw({ status: "fatal" })).tone, "down");
  assert.equal(mapReportRequestRow(requestRaw({ status: "la_qua" })).statusLabel, "la_qua");
  assert.equal(mapReportRequestRow(requestRaw({ data_start: null, data_end: null })).period, "không khoảng ngày");
  assert.equal(mapReportRequestRow(requestRaw()).rowsImported, 5);
  assert.equal(mapReportRequestRow(requestRaw()).attempts, 3);
});

test("mapReportRequestRow: chờ quá 6 giờ → nhãn CHỜ QUÁ LÂU + tone vàng để màn Sync health báo", () => {
  const r = mapReportRequestRow(requestRaw({ status: "in_progress", is_stale: true, age_minutes: "500" }));
  assert.equal(r.isStale, true);
  assert.equal(r.statusLabel, "Amazon đang tạo · CHỜ QUÁ LÂU");
  assert.equal(r.tone, "warn");
  assert.equal(r.ageMinutes, 500);
  // lỗi thì vẫn đỏ dù stale
  assert.equal(mapReportRequestRow(requestRaw({ status: "failed", is_stale: true })).tone, "down");
});

test("reportTypeLabel: 4 report có nhãn ngắn, report lạ giữ nguyên mã Amazon", () => {
  assert.equal(reportTypeLabel("GET_FBA_STORAGE_FEE_CHARGES_DATA"), "Phí lưu kho");
  assert.equal(reportTypeLabel("GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA"), "Phí inbound");
  assert.equal(reportTypeLabel("GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA"), "Tồn theo FC");
  assert.equal(reportTypeLabel("GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA"), "Lịch sử nhận hàng");
  assert.equal(reportTypeLabel("GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE"), "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE");
});

test("mapReportRequestRow: lỗi 429 được giữ nguyên để người vận hành biết bị trần tốc độ", () => {
  const r = mapReportRequestRow(requestRaw({ status: "failed", last_error: "SP-API 429 QuotaExceeded: You exceeded your quota" }));
  assert.equal(r.tone, "down");
  assert.match(r.lastError ?? "", /429/);
});
