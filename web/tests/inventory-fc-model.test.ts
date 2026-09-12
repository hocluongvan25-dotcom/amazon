/**
 * Test model Module 3 nâng cao (migration 0018) — phân bổ tồn theo FC + lịch sử
 * nhận hàng + đối soát nhận/gửi theo lô.
 *
 * Ba thứ phải khoá:
 *   1. Chuỗi select PHẢI khớp hợp đồng cột của view (harness BƯỚC 19 soát trên
 *      Postgres thật) — sai một cột là PGRST204 và SẬP trang I2/I4.
 *   2. PostgREST trả bigint/numeric dưới dạng CHUỖI ("85", "58.8"). Mapper phải
 *      ép số, nếu không UI sẽ NỐI CHUỖI ("40" + "10" = "4010") mà vẫn "có số".
 *   3. Không có dữ liệu → NULL + nhãn nói rõ ("chưa rõ số gửi", "không rõ %"),
 *      KHÔNG BAO GIỜ suy ra "nhận đủ" hay "0%".
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FC_ALLOCATION_SELECT,
  RECEIPT_SELECT,
  RECEIPT_SHIPMENT_SELECT,
  fcAllocationForSku,
  formatSharePct,
  mapFcAllocationRow,
  mapReceiptRow,
  mapReceiptShipmentRow,
  mergeInboundReconcile,
  receiptStateLabel,
  receiptsForSku,
  summarizeFcAllocation,
  type FcAllocationRaw,
  type ReceiptRaw,
  type ReceiptShipmentRaw,
} from "../src/lib/data/inventory-model.ts";
import type { FcAllocationRow, InboundRow, ReceiptRow } from "../src/lib/types.ts";

/* ------------------------------------------------------------------ */
/* 1. Hợp đồng cột — khớp đúng self-check 11.5 của migration 0018      */
/* ------------------------------------------------------------------ */

test("0018 select: vexim_inventory_fc khớp hợp đồng cột (sai 1 cột là PGRST204)", () => {
  assert.equal(
    FC_ALLOCATION_SELECT,
    "seller_account_id,shop,snapshot_date,sku,fnsku,product_name,fc,country,quantity," +
      "sellable_qty,unsellable_qty,unknown_qty,sku_total_qty,sku_fc_count,fc_share_pct,source,imported_at",
  );
});

test("0018 select: vexim_inventory_receipts + vexim_inbound_receipt_shipments khớp hợp đồng cột", () => {
  assert.equal(
    RECEIPT_SELECT,
    "seller_account_id,shop,received_date,days_ago,sku,fnsku,product_name,quantity," +
      "shipment_id,fc,source,imported_at",
  );
  assert.equal(
    RECEIPT_SHIPMENT_SELECT,
    "seller_account_id,shop,shipment_id,fc,first_received_date,last_received_date," +
      "received_units,sku_count,shipment_status,expected_eta,expected_units,diff_units," +
      "receipt_rate_pct,reconcile_state,expected_source",
  );
});

/* ------------------------------------------------------------------ */
/* 2. Phân bổ FC                                                       */
/* ------------------------------------------------------------------ */

function rawFc(partial: Partial<FcAllocationRaw> = {}): FcAllocationRaw {
  return {
    seller_account_id: "s1",
    shop: "Shop US",
    snapshot_date: "2026-09-11",
    sku: "VXI-20",
    fnsku: "X001",
    product_name: "Vali 20",
    fc: "ONT8",
    country: "US",
    quantity: 50,
    // PostgREST trả sum()/count()/numeric bằng CHUỖI
    sellable_qty: "40",
    unsellable_qty: "10",
    unknown_qty: "0",
    sku_total_qty: "85",
    sku_fc_count: "2",
    fc_share_pct: "58.8",
    source: "report",
    imported_at: "2026-09-12T02:00:00Z",
    ...partial,
  };
}

test("mapFcAllocationRow: ép số từ chuỗi bigint/numeric (không nối chuỗi thành 4010)", () => {
  const r = mapFcAllocationRow(rawFc());
  assert.equal(r.units, 50);
  assert.equal(r.sellable, 40);
  assert.equal(r.unsellable, 10);
  assert.equal(r.unknown, 0);
  assert.equal(r.sharePct, 58.8);
  assert.equal(r.shareLabel, "58,8%", "hiển thị theo định dạng số VN");
  assert.equal(r.snapshotDate, "2026-09-11");
  assert.equal(typeof r.sellable, "number");
});

test("mapFcAllocationRow: FC rỗng → nhãn rõ ràng; % NULL → 'không rõ %' (không bịa 0%)", () => {
  const noFc = mapFcAllocationRow(rawFc({ fc: "" }));
  assert.equal(noFc.fc, "(không rõ FC)");

  const zero = mapFcAllocationRow(rawFc({ quantity: 0, fc_share_pct: null, sku_total_qty: "0" }));
  assert.equal(zero.sharePct, null);
  assert.equal(zero.shareLabel, "không rõ %");
  assert.equal(formatSharePct(41.176), "41,2%");
});

test("fcAllocationForSku: lọc không phân biệt hoa/thường, FC nhiều hàng nhất lên trước", () => {
  const rows = [
    mapFcAllocationRow(rawFc({ sku: "VXI-20", fc: "PHX7", quantity: 30, fc_share_pct: "37.5" })),
    mapFcAllocationRow(rawFc({ sku: "vxi-20", fc: "ONT8", quantity: 55, fc_share_pct: "62.5" })),
    mapFcAllocationRow(rawFc({ sku: "VXI-28", fc: "MDW2", quantity: 12, fc_share_pct: "100.0" })),
  ];
  const list = fcAllocationForSku(rows, "VXI-20");
  assert.deepEqual(list.map((r) => [r.fc, r.units]), [["ONT8", 55], ["PHX7", 30]]);
  assert.equal(fcAllocationForSku(rows, "khong-co").length, 0);
});

test("summarizeFcAllocation: cộng đúng 3 nhóm disposition, chưa có dữ liệu → topFc NULL", () => {
  const s = summarizeFcAllocation([
    mapFcAllocationRow(rawFc({ fc: "ONT8", quantity: 50, sellable_qty: "40", unsellable_qty: "10" })),
    mapFcAllocationRow(rawFc({ fc: "PHX7", quantity: 35, sellable_qty: "25", unsellable_qty: "0", unknown_qty: "10" })),
  ]);
  assert.equal(s.units, 85);
  assert.equal(s.fcCount, 2);
  assert.equal(s.sellable, 65);
  assert.equal(s.unsellable, 10);
  assert.equal(s.unknown, 10, "disposition rỗng đếm riêng, không gộp vào bán được");
  assert.deepEqual(s.topFc, { fc: "ONT8", units: 50, shareLabel: "58,8%" });
  assert.equal(s.snapshotDate, "2026-09-11");

  const empty = summarizeFcAllocation([]);
  assert.equal(empty.fcCount, 0);
  assert.equal(empty.snapshotDate, null);
  assert.equal(empty.topFc, null);
});

/* ------------------------------------------------------------------ */
/* 3. Lịch sử nhận hàng                                                */
/* ------------------------------------------------------------------ */

function rawRx(partial: Partial<ReceiptRaw> = {}): ReceiptRaw {
  return {
    seller_account_id: "s1",
    shop: "Shop US",
    received_date: "2026-09-05",
    days_ago: 7,
    sku: "VXI-20",
    fnsku: "X001",
    product_name: "Vali 20",
    quantity: 40,
    shipment_id: "FBA15DXYZ1",
    fc: "ONT8",
    source: "report",
    imported_at: "2026-09-12T02:00:00Z",
    ...partial,
  };
}

test("mapReceiptRow: ngày + số ngày trước; lô/FC trống → NULL chứ không bịa", () => {
  const r = mapReceiptRow(rawRx());
  assert.equal(r.date, "2026-09-05");
  assert.equal(r.daysAgo, 7);
  assert.equal(r.dateLabel, "2026-09-05 (7 ngày trước)");
  assert.equal(r.shipment, "FBA15DXYZ1");
  assert.equal(r.units, 40);

  assert.equal(mapReceiptRow(rawRx({ days_ago: 0 })).dateLabel, "2026-09-05 (hôm nay)");
  assert.equal(mapReceiptRow(rawRx({ days_ago: "12" })).daysAgo, 12, "bigint về dạng chuỗi");
  const noShip = mapReceiptRow(rawRx({ shipment_id: null, fc: null }));
  assert.equal(noShip.shipment, null);
  assert.equal(noShip.fc, null);
  assert.equal(noShip.dateLabel, "2026-09-05 (7 ngày trước)");
});

test("receiptsForSku: mới nhất lên trước, cùng ngày thì theo mã lô", () => {
  const rows = [
    mapReceiptRow(rawRx({ received_date: "2026-09-05", shipment_id: "FBA1" })),
    mapReceiptRow(rawRx({ received_date: "2026-09-09", shipment_id: "FBA2" })),
    mapReceiptRow(rawRx({ received_date: "2026-09-05", shipment_id: "FBA0" })),
    mapReceiptRow(rawRx({ sku: "VXI-28" })),
  ];
  assert.deepEqual(
    receiptsForSku(rows, "vxi-20").map((r) => r.shipment),
    ["FBA2", "FBA0", "FBA1"],
  );
});

/* ------------------------------------------------------------------ */
/* 4. Đối soát nhận/gửi theo lô                                        */
/* ------------------------------------------------------------------ */

function rawRecon(partial: Partial<ReceiptShipmentRaw> = {}): ReceiptShipmentRaw {
  return {
    seller_account_id: "s1",
    shop: "Shop US",
    shipment_id: "FBA15DXYZ1",
    fc: "ONT8",
    first_received_date: "2026-09-05",
    last_received_date: "2026-09-06",
    received_units: "50",
    sku_count: "2",
    shipment_status: "CLOSED",
    expected_eta: "2026-09-04",
    expected_units: 50,
    diff_units: 0,
    receipt_rate_pct: "100.0",
    reconcile_state: "matched",
    expected_source: "inbound_shipments",
    ...partial,
  };
}

test("mapReceiptShipmentRow: nhận đủ / thiếu / thừa — đúng nhãn, đúng màu, ép số từ chuỗi", () => {
  const matched = mapReceiptShipmentRow(rawRecon());
  assert.equal(matched.received, 50);
  assert.equal(matched.state, "matched");
  assert.equal(matched.label, "Nhận đủ 50/50");
  assert.equal(matched.tone, "up");
  assert.equal(matched.ratePct, 100);
  assert.equal(matched.skuCount, 2);

  const short = mapReceiptShipmentRow(
    rawRecon({ received_units: "18", expected_units: 25, diff_units: -7, receipt_rate_pct: "72.0", reconcile_state: "short" }),
  );
  assert.equal(short.label, "Thiếu 7 (nhận 18/25) → SOP-09");
  assert.equal(short.tone, "down");

  const over = mapReceiptShipmentRow(
    rawRecon({ received_units: "30", expected_units: 20, diff_units: 10, receipt_rate_pct: "150.0", reconcile_state: "over" }),
  );
  assert.equal(over.label, "Thừa 10 (nhận 30/20)");
  assert.equal(over.tone, "warn");
});

test("mapReceiptShipmentRow: KHÔNG có số gửi → 'Chưa rõ số gửi', không suy ra nhận đủ", () => {
  const noPlan = mapReceiptShipmentRow(
    rawRecon({ expected_units: null, diff_units: null, receipt_rate_pct: null, reconcile_state: "unknown_expected", expected_source: "none" }),
  );
  assert.equal(noPlan.expected, null);
  assert.equal(noPlan.state, "unknown_expected");
  assert.equal(noPlan.label, "Chưa rõ số gửi (đã nhận 50)");
  assert.equal(noPlan.tone, "flat");
  assert.equal(noPlan.expectedSource, "none");

  const nullQty = mapReceiptShipmentRow(
    rawRecon({ expected_units: null, diff_units: null, receipt_rate_pct: null, reconcile_state: "unknown_expected" }),
  );
  assert.equal(nullQty.expectedSource, "inbound_shipments", "có dòng lô nhưng quantity NULL");

  // state lạ (view đổi / dữ liệu bẩn) → rơi về 'unknown_expected', không crash
  const weird = mapReceiptShipmentRow(rawRecon({ reconcile_state: "gi-la" }));
  assert.equal(weird.state, "unknown_expected");
});

test("receiptStateLabel: thiếu số mà không có diff vẫn tính ra số thiếu", () => {
  assert.equal(receiptStateLabel("short", 18, 25, null), "Thiếu 7 (nhận 18/25) → SOP-09");
  assert.equal(receiptStateLabel("short", 18, null, null), "Thiếu 0 (nhận 18/?) → SOP-09");
});

const inbound = (id: string, over: Partial<InboundRow> = {}): InboundRow => ({
  id,
  shop: "Shop US",
  status: "CLOSED",
  statusTone: "green",
  units: 50,
  fc: "—",
  eta: "đã nhận 2026-09-04",
  reconcile: "Chờ đối soát",
  reconcileTone: "flat",
  ...over,
});

test("mergeInboundReconcile: có số nhận thì điền FC + đối soát THẬT, khớp lô không phân biệt hoa/thường", () => {
  const { rows, matched } = mergeInboundReconcile(
    [inbound("fba15dxyz1"), inbound("FBA15OTHER")],
    [mapReceiptShipmentRow(rawRecon()), mapReceiptShipmentRow(rawRecon({
      shipment_id: "FBA15SHORT", received_units: "18", expected_units: 25, diff_units: -7, reconcile_state: "short",
    }))],
  );
  assert.equal(matched, 1);
  assert.equal(rows[0].fc, "ONT8", "FC đích lấy từ report nhận hàng (trước đây là '—')");
  assert.equal(rows[0].reconcile, "Nhận đủ 50/50");
  assert.equal(rows[0].reconcileTone, "up");
  assert.equal(rows[1].reconcile, "Chờ đối soát", "không có số nhận → GIỮ nhãn cũ");
  assert.equal(rows[1].reconcileTone, "flat");
});

test("mergeInboundReconcile: không xoá nhãn '— chờ placement', lô mồ côi được trả về riêng", () => {
  const { rows, orphans } = mergeInboundReconcile(
    [inbound("FBA15WORKING", { status: "WORKING", fc: "— chờ placement" })],
    [
      mapReceiptShipmentRow(rawRecon({ shipment_id: "FBA15WORKING", fc: null })),
      mapReceiptShipmentRow(rawRecon({ shipment_id: "FBA15CLOSED-OLD" })),
    ],
  );
  assert.equal(rows[0].fc, "— chờ placement", "report không cho FC thì giữ nhãn cũ");
  assert.equal(rows[0].reconcile, "Nhận đủ 50/50");
  assert.deepEqual(orphans.map((o) => o.shipmentId), ["FBA15CLOSED-OLD"]);
});

test("mergeInboundReconcile: không có report → giữ nguyên toàn bộ, không lô nào bị đổi", () => {
  const before = [inbound("FBA1"), inbound("FBA2")];
  const { rows, orphans, matched } = mergeInboundReconcile(before, []);
  assert.equal(matched, 0);
  assert.equal(orphans.length, 0);
  assert.deepEqual(rows.map((r) => r.reconcile), ["Chờ đối soát", "Chờ đối soát"]);
});

/** Giữ kiểu không trôi: sku phải có mặt để I2 lọc theo SKU. */
test("Kiểu UI: FcAllocationRow/ReceiptRow mang sku để lọc ở I2", () => {
  const fc: FcAllocationRow = mapFcAllocationRow(rawFc());
  const rx: ReceiptRow = mapReceiptRow(rawRx());
  assert.equal(fc.sku, "VXI-20");
  assert.equal(rx.sku, "VXI-20");
});
