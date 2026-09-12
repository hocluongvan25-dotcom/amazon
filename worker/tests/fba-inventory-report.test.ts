/**
 * Test Module 3 nâng cao — phân bổ tồn theo FC + lịch sử nhận hàng (0018).
 *
 * Bốn thứ phải khoá, vì đây là chỗ dễ "xanh giả" nhất:
 *   1. Parser đọc cột THEO TÊN (Amazon đổi thứ tự cột vẫn chạy) và TỪ CHỐI
 *      file thiếu cột bắt buộc thay vì đoán theo vị trí.
 *   2. Ngày phải về đúng YYYY-MM-DD (RPC 0018 chỉ nhận dạng đó); ngày kiểu
 *      MM/DD/YYYY được hiểu theo lịch Mỹ nhưng PHẢI báo động, không im lặng.
 *   3. Chỉ tổng hợp SNAPSHOT MỚI NHẤT — cộng nhiều ngày sẽ ra số tồn sai.
 *   4. Luật idempotent (nhập lại = update) + gộp dòng trùng khoá phải GIỐNG
 *      NHAU ở MockDbAdapter và RPC thật, nếu không test xanh mà production phình bảng.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { MockDbAdapter } from "../../web/src/lib/worker/db/adapter.ts";
import {
  DEFAULT_TOP_FC_LIMIT,
  runInventoryFcSync,
  summarizeFcAllocation,
  summarizeReceiptsByShipment,
} from "../src/jobs/inventory-fc-sync.job.ts";
import {
  intOrNull,
  parseFcAllocationReport,
  parseReceiptsReport,
  toIsoDate,
  type FcAllocationRow,
  type ReceiptRow,
} from "../src/reports/fba-inventory.parser.ts";
import { runInventoryFcSyncCli } from "../src/runtime/run-inventory-fc-sync.ts";

const SELLER = "22222222-2222-4222-8222-222222222222";

const FC_HEAD =
  "snapshot-date\tfnsku\tsku\tproduct-name\tquantity\tfulfillment-center-id\tdetailed-disposition\tcountry";
const fcRow = (
  date: string,
  sku: string,
  qty: string,
  fc: string,
  disp: string,
  fnsku = "X001ABC",
): string => `${date}\t${fnsku}\t${sku}\tTen san pham\t${qty}\t${fc}\t${disp}\tUS`;

const RX_HEAD =
  "received-date\tfnsku\tsku\tproduct-name\tquantity\tfba-shipment-id\tfulfillment-center-id";
const rxRow = (
  date: string,
  sku: string,
  qty: string,
  shipment: string,
  fc: string,
): string => `${date}\tX001ABC\t${sku}\tTen san pham\t${qty}\t${shipment}\t${fc}`;

/* ---------- ngày + số ---------- */

test("toIsoDate: đọc ISO (kèm giờ), kiểu Mỹ, chữ; KHÔNG đoán khi không đọc được", () => {
  assert.deepEqual(toIsoDate("2026-09-11"), { iso: "2026-09-11", ambiguous: false });
  assert.deepEqual(toIsoDate("2026-09-11T00:00:00+00:00"), {
    iso: "2026-09-11",
    ambiguous: false,
  });
  assert.deepEqual(toIsoDate("2026-9-5"), { iso: "2026-09-05", ambiguous: false }, "thiếu số 0 vẫn đọc");
  assert.deepEqual(toIsoDate("Sep 11, 2026"), { iso: "2026-09-11", ambiguous: false });
  // kiểu Mỹ: mặc định MM/DD/YYYY nhưng PHẢI nói ra là có thể hiểu sai
  assert.deepEqual(toIsoDate("09/11/2026"), { iso: "2026-09-11", ambiguous: true });
  // vị trí đầu > 12 → chắc chắn là DD/MM → đảo lại
  assert.deepEqual(toIsoDate("23/11/2026"), { iso: "2026-11-23", ambiguous: true });
  assert.deepEqual(toIsoDate("11/09/2026"), { iso: "2026-11-09", ambiguous: true });
  // rác → null (dòng sẽ bị bỏ, không suy ra "hôm nay")
  assert.equal(toIsoDate("khong phai ngay").iso, null);
  assert.equal(toIsoDate("").iso, null);
  assert.equal(toIsoDate(null).iso, null);
  assert.equal(toIsoDate("2026-13-45").iso, null, "tháng/ngày vô lý → null");
});

test("intOrNull: chỉ nhận số nguyên (tồn kho không có số lẻ), bỏ dấu phẩy nghìn", () => {
  assert.equal(intOrNull("12"), 12);
  assert.equal(intOrNull("-3"), -3);
  assert.equal(intOrNull("1,200"), 1200);
  assert.equal(intOrNull(" 7 "), 7);
  assert.equal(intOrNull("abc"), null);
  assert.equal(intOrNull("12.5"), null, "số lẻ không phải tồn kho hợp lệ → null");
  assert.equal(intOrNull(""), null);
  assert.equal(intOrNull(null), null);
});

/* ---------- parser: phân bổ FC ---------- */

test("parseFcAllocationReport: đọc đúng cột theo TÊN kể cả khi đảo thứ tự / thừa cột", () => {
  const text = [
    "country\tsku\tquantity\tfulfillment-center-id\tdetailed-disposition\tsnapshot-date\tfnsku\tproduct-name",
    "US\tVXI-20\t40\tONT8\tSellable\t2026-09-11\tX001\tVali",
  ].join("\n");
  const r = parseFcAllocationReport(text);
  assert.equal(r.rows.length, 1);
  assert.equal(r.skipped, 0);
  assert.deepEqual(r.rows[0], {
    snapshotDate: "2026-09-11",
    sku: "VXI-20",
    fnsku: "X001",
    productName: "Vali",
    quantity: 40,
    fulfillmentCenterId: "ONT8",
    detailedDisposition: "SELLABLE",
    country: "US",
    source: "report",
  } satisfies FcAllocationRow);
});

test("parseFcAllocationReport: thiếu cột bắt buộc → trả rỗng + nói rõ thiếu gì (không đoán vị trí)", () => {
  const text = ["sku\tquantity\tfulfillment-center-id", "VXI-20\t40\tONT8"].join("\n");
  const r = parseFcAllocationReport(text);
  assert.equal(r.rows.length, 0);
  assert.match(r.warnings.join(" "), /snapshot-date/);
  assert.match(r.warnings.join(" "), /GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA/);
});

test("parseFcAllocationReport: file rỗng → cảnh báo, không ném lỗi", () => {
  assert.match(parseFcAllocationReport("").warnings.join(" "), /rỗng/);
  assert.match(parseFcAllocationReport("snapshot-date\tsku\tquantity").warnings.join(" "), /rỗng/);
});

test("parseFcAllocationReport: dòng rác bị bỏ kèm số dòng, FC/disposition được upper()", () => {
  const text = [
    FC_HEAD,
    fcRow("2026-09-11", "VXI-20", "40", "ont8", "Sellable"),
    fcRow("2026-09-11", "VXI-20", "abc", "MDW2", "Sellable"), // quantity rác
    fcRow("khong-ro", "VXI-20", "5", "MDW2", "Sellable"), // ngày không đọc được
    fcRow("2026-09-11", "", "5", "MDW2", "Sellable"), // thiếu sku
    fcRow("2026-09-11", "VXI-20", "7", "", ""), // FC + disposition rỗng
  ].join("\n");
  const r = parseFcAllocationReport(text);
  assert.equal(r.rows.length, 2, "chỉ 2 dòng dùng được");
  assert.equal(r.skipped, 3);
  assert.equal(r.rows[0].fulfillmentCenterId, "ONT8", "FC viết thường → upper để không tách đôi tồn");
  assert.equal(r.rows[0].detailedDisposition, "SELLABLE");
  assert.equal(r.rows[1].fulfillmentCenterId, "", "FC không rõ → rỗng, không bịa mã");
  assert.equal(r.rows[1].detailedDisposition, "");
  assert.match(r.warnings.join("\n"), /Dòng 3.*quantity/);
  assert.match(r.warnings.join("\n"), /Dòng 4.*snapshot-date/);
  assert.match(r.warnings.join("\n"), /Dòng 5.*sku/);
});

test("parseFcAllocationReport: ngày dạng 11-09-2026 vẫn đọc được (kèm cảnh báo mơ hồ)", () => {
  const r = parseFcAllocationReport([FC_HEAD, fcRow("11-09-2026", "VXI-20", "5", "MDW2", "Sellable")].join("\n"));
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].snapshotDate, "2026-11-09");
  assert.match(r.warnings.join("\n"), /MM\/DD\/YYYY/);
});

test("parseFcAllocationReport: ngày MM/DD/YYYY được hiểu theo lịch Mỹ nhưng CÓ cảnh báo", () => {
  const r = parseFcAllocationReport([FC_HEAD, fcRow("09/11/2026", "VXI-20", "40", "ONT8", "Sellable")].join("\n"));
  assert.equal(r.rows[0]?.snapshotDate, "2026-09-11");
  assert.equal(r.warnings.filter((w) => /MM\/DD\/YYYY/.test(w)).length, 1, "chỉ 1 cảnh báo, không spam theo dòng");
});

test("parseFcAllocationReport: fcTotals chỉ tính SNAPSHOT MỚI NHẤT (không cộng dồn nhiều ngày)", () => {
  const r = parseFcAllocationReport(
    [
      FC_HEAD,
      fcRow("2026-09-10", "VXI-20", "60", "ONT8", "Sellable"),
      fcRow("2026-09-11", "VXI-20", "40", "ONT8", "Sellable"),
      fcRow("2026-09-11", "VXI-20", "25", "PHX7", "Sellable"),
    ].join("\n"),
  );
  assert.deepEqual(r.snapshotDates, ["2026-09-10", "2026-09-11"]);
  assert.deepEqual(r.fcTotals, { ONT8: 40, PHX7: 25 }, "60 của hôm qua không được cộng vào");
});

test("parseFcAllocationReport: cảnh báo có trần — file vài chục nghìn dòng lỗi không làm ngập log", () => {
  const bad = Array.from({ length: 30 }, (_, i) => fcRow("2026-09-11", `SKU-${i}`, "abc", "ONT8", "Sellable"));
  const r = parseFcAllocationReport([FC_HEAD, ...bad].join("\n"));
  assert.equal(r.rows.length, 0);
  assert.equal(r.skipped, 30);
  assert.equal(r.warnings.length, 21, "20 cảnh báo đầu + 1 dòng tóm tắt");
  assert.match(r.warnings[20] ?? "", /còn .* dòng lỗi khác/);
});

/* ---------- parser: lịch sử nhận hàng ---------- */

test("parseReceiptsReport: gom số nhận theo lô, bỏ dòng không có mã lô khỏi bảng lô", () => {
  const r = parseReceiptsReport(
    [
      RX_HEAD,
      rxRow("2026-09-05", "VXI-20", "40", "fba15dxyz1", "ont8"),
      rxRow("2026-09-06", "VXI-20", "10", "FBA15DXYZ1", "ONT8"),
      rxRow("2026-09-08", "VXI-28", "18", "FBA15DXYZ2", "PHX7"),
      rxRow("2026-09-09", "VXI-28", "4", "", "MDW2"),
    ].join("\n"),
  );
  assert.equal(r.rows.length, 4);
  assert.equal(r.skipped, 0);
  assert.deepEqual(r.shipmentTotals, { FBA15DXYZ1: 50, FBA15DXYZ2: 18 });
  assert.equal(r.receivedFrom, "2026-09-05");
  assert.equal(r.receivedTo, "2026-09-09");
  assert.equal(r.rows[0].fbaShipmentId, "FBA15DXYZ1", "mã lô viết thường → upper để gộp đúng");
  assert.equal(r.rows[3].fbaShipmentId, "", "không gắn lô → rỗng (không bịa mã)");
});

test("parseReceiptsReport: thiếu cột bắt buộc → trả rỗng + nói rõ", () => {
  const r = parseReceiptsReport(["sku\tquantity", "VXI-20\t40"].join("\n"));
  assert.equal(r.rows.length, 0);
  assert.match(r.warnings.join(" "), /received-date/);
  assert.match(r.warnings.join(" "), /GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA/);
});

/* ---------- tổng hợp (không cần DB) ---------- */

const fc = (
  date: string,
  sku: string,
  qty: number,
  center: string,
  disp = "SELLABLE",
): FcAllocationRow => ({
  snapshotDate: date,
  sku,
  fnsku: null,
  productName: null,
  quantity: qty,
  fulfillmentCenterId: center,
  detailedDisposition: disp,
  country: "US",
  source: "report",
});

test("summarizeFcAllocation: tách bán được / không bán được / KHÔNG RÕ, tính % trên snapshot mới nhất", () => {
  const s = summarizeFcAllocation([
    fc("2026-09-10", "A", 999, "SDF8"), // snapshot cũ → bỏ
    fc("2026-09-11", "A", 40, "ONT8", "SELLABLE"),
    fc("2026-09-11", "A", 10, "ONT8", "DAMAGED"),
    fc("2026-09-11", "A", 25, "PHX7", "SELLABLE"),
    fc("2026-09-11", "A", 5, "PHX7", ""),
  ]);
  assert.equal(s.latestSnapshot, "2026-09-11");
  assert.equal(s.units, 80, "999 của hôm qua không được cộng");
  assert.equal(s.sellableUnits, 65);
  assert.equal(s.unsellableUnits, 10);
  assert.equal(s.unknownDispositionUnits, 5, "disposition rỗng KHÔNG được tính là bán được");
  assert.equal(s.skus, 1);
  assert.equal(s.fcCount, 2);
  assert.deepEqual(
    s.topFcs.map((f) => [f.fc, f.units, f.sharePct]),
    [
      ["ONT8", 50, 62.5],
      ["PHX7", 30, 37.5],
    ],
  );
});

test("summarizeFcAllocation: tổng = 0 → sharePct NULL (không bịa 0%); FC rỗng gom vào nhãn rõ ràng", () => {
  const s = summarizeFcAllocation([fc("2026-09-11", "A", 0, "ONT8"), fc("2026-09-11", "A", 0, "")]);
  assert.equal(s.units, 0);
  // Cùng 0 đơn vị → tie-break theo tên FC (deterministic, không phụ thuộc thứ tự file)
  assert.deepEqual(
    s.topFcs.map((f) => [f.fc, f.sharePct]),
    [
      ["(không rõ FC)", null],
      ["ONT8", null],
    ],
  );
});

test("summarizeFcAllocation: tôn trọng topFcLimit và sắp xếp giảm dần theo đơn vị", () => {
  const rows = ["A", "B", "C", "D"].map((sku, i) => fc("2026-09-11", sku, (i + 1) * 10, `FC${i}`));
  const s = summarizeFcAllocation(rows, 2);
  assert.equal(s.topFcs.length, 2);
  assert.deepEqual(s.topFcs.map((f) => f.units), [40, 30]);
  assert.equal(s.fcCount, 4, "fcCount vẫn đếm đủ, chỉ danh sách in ra bị cắt");
  assert.equal(DEFAULT_TOP_FC_LIMIT, 10);
});

const rx = (date: string, sku: string, qty: number, shipment: string, center = "ONT8"): ReceiptRow => ({
  receivedDate: date,
  sku,
  fnsku: null,
  productName: null,
  quantity: qty,
  fbaShipmentId: shipment,
  fulfillmentCenterId: center,
  source: "report",
});

test("summarizeReceiptsByShipment: gộp nhiều ngày, đếm SKU, lấy ngày đầu/cuối, sắp lô mới nhất lên trước", () => {
  const list = summarizeReceiptsByShipment([
    rx("2026-09-05", "A", 40, "FBA1"),
    rx("2026-09-06", "A", 10, "FBA1"),
    rx("2026-09-06", "B", 3, "FBA1"),
    rx("2026-09-09", "C", 12, "FBA2", "PHX7"),
    rx("2026-09-09", "D", 4, ""), // không mã lô → không vào bảng đối soát
  ]);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], {
    shipmentId: "FBA2",
    fc: "PHX7",
    units: 12,
    skus: 1,
    firstDate: "2026-09-09",
    lastDate: "2026-09-09",
  });
  assert.deepEqual(list[1], {
    shipmentId: "FBA1",
    fc: "ONT8",
    units: 53,
    skus: 2,
    firstDate: "2026-09-05",
    lastDate: "2026-09-06",
  });
});

/* ---------- luật của MockDbAdapter = luật của RPC 0018 ---------- */

test("MockDbAdapter.upsertFcAllocation: bỏ dòng rác, cộng dòng trùng khoá, nhập lại là update", async () => {
  const db = new MockDbAdapter();
  const rows = [
    { snapshotDate: "2026-09-11", sku: "A", quantity: 40, fulfillmentCenterId: "ONT8", detailedDisposition: "SELLABLE" },
    { snapshotDate: "2026-09-11", sku: "A", quantity: 5, fulfillmentCenterId: "PHX7", detailedDisposition: "" },
    { snapshotDate: "2026-09-11", sku: "A", quantity: 5, fulfillmentCenterId: "phx7", detailedDisposition: "" }, // trùng khoá (FC thường)
    { snapshotDate: "11/09/2026", sku: "A", quantity: 7, fulfillmentCenterId: "MDW2", detailedDisposition: "SELLABLE" }, // ngày sai
    { snapshotDate: "2026-09-11", sku: "", quantity: 7, fulfillmentCenterId: "MDW2", detailedDisposition: "SELLABLE" }, // thiếu sku
  ];
  const first = await db.upsertFcAllocation(SELLER, rows);
  assert.deepEqual(first, { inserted: 2, updated: 0, skipped: 2, merged: 1 });
  assert.equal(db.fcAllocation.length, 2);
  const phx = db.fcAllocation.find((r) => r.fulfillmentCenterId === "PHX7");
  assert.equal(phx?.quantity, 10, "2 dòng trùng khoá cộng lại = 10, không ghi 2 dòng");

  const again = await db.upsertFcAllocation(SELLER, rows);
  assert.deepEqual(again, { inserted: 0, updated: 2, skipped: 2, merged: 1 });
  assert.equal(db.fcAllocation.length, 2, "nhập lại không phình bảng");
});

test("MockDbAdapter.upsertReceipts: khoá theo ngày × SKU × lô × FC; lô khác nhau là 2 dòng", async () => {
  const db = new MockDbAdapter();
  const rows = [
    { receivedDate: "2026-09-05", sku: "A", quantity: 40, fbaShipmentId: "FBA1", fulfillmentCenterId: "ONT8" },
    { receivedDate: "2026-09-05", sku: "A", quantity: 10, fbaShipmentId: "FBA2", fulfillmentCenterId: "ONT8" },
    { receivedDate: "2026-09-05", sku: "A", quantity: 10, fbaShipmentId: "FBA2", fulfillmentCenterId: "ONT8" },
  ];
  const first = await db.upsertReceipts(SELLER, rows);
  assert.deepEqual(first, { inserted: 2, updated: 0, skipped: 0, merged: 1 });
  const again = await db.upsertReceipts(SELLER, rows);
  assert.deepEqual(again, { inserted: 0, updated: 2, skipped: 0, merged: 1 });
  assert.equal(db.receipts.length, 2);
  assert.equal(db.receipts.find((r) => r.fbaShipmentId === "FBA2")?.quantity, 20);
});

test("MockDbAdapter: dữ liệu 2 shop không lẫn nhau (khoá có sellerAccountId)", async () => {
  const db = new MockDbAdapter();
  const row = { snapshotDate: "2026-09-11", sku: "A", quantity: 5, fulfillmentCenterId: "ONT8", detailedDisposition: "SELLABLE" };
  await db.upsertFcAllocation(SELLER, [row]);
  const other = "33333333-3333-4333-8333-333333333333";
  const r = await db.upsertFcAllocation(other, [row]);
  assert.equal(r.inserted, 1, "cùng SKU+FC nhưng khác shop → vẫn là dòng mới");
  assert.equal(db.fcAllocation.length, 2);
});

/* ---------- job ---------- */

const FC_TEXT = [
  FC_HEAD,
  fcRow("2026-09-10", "VXI-20", "60", "ONT8", "Sellable"),
  fcRow("2026-09-11", "VXI-20", "40", "ONT8", "Sellable"),
  fcRow("2026-09-11", "VXI-20", "6", "ONT8", "Damaged"),
  fcRow("2026-09-11", "VXI-20", "25", "PHX7", "Sellable"),
  fcRow("2026-09-11", "VXI-28", "18", "PHX7", ""),
].join("\n");

const RX_TEXT = [
  RX_HEAD,
  rxRow("2026-09-05", "VXI-20", "40", "fba15dxyz1", "ont8"),
  rxRow("2026-09-06", "VXI-20", "10", "FBA15DXYZ1", "ONT8"),
  rxRow("2026-09-08", "VXI-28", "18", "FBA15DXYZ2", "PHX7"),
  rxRow("2026-09-09", "VXI-28", "5", "", "MDW2"),
].join("\n");

test("runInventoryFcSync: ghi cả 2 report + tóm tắt đúng số + job done", async () => {
  const db = new MockDbAdapter();
  const r = await runInventoryFcSync({
    sellerAccountId: SELLER,
    fcReportText: FC_TEXT,
    receiptsReportText: RX_TEXT,
    adapter: db,
    now: new Date("2026-09-12T02:00:00Z"),
  });

  assert.equal(r.job.jobType, "inventory.fc_sync");
  assert.equal(r.job.status, "done");
  assert.equal(db.jobs.length, 2, "job running + job done");

  // FC: 5 dòng, snapshot mới nhất 40+6+25+18 = 89
  assert.equal(r.fc.rows, 5);
  assert.equal(r.fc.latestSnapshot, "2026-09-11");
  assert.equal(r.fc.units, 89);
  assert.equal(r.fc.sellableUnits, 65);
  assert.equal(r.fc.unsellableUnits, 6);
  assert.equal(r.fc.unknownDispositionUnits, 18);
  assert.equal(r.fc.fcCount, 2);
  assert.equal(r.fc.db?.inserted, 5);

  // Receipts: 4 dòng, 3 lô có mã
  assert.equal(r.receipts.rows, 4);
  assert.equal(r.receipts.units, 73);
  assert.equal(r.receipts.shipments, 2, "chỉ đếm lô CÓ mã; dòng không mã lô vẫn nằm trong lịch sử");
  assert.equal(r.receipts.from, "2026-09-05");
  assert.equal(r.receipts.to, "2026-09-09");
  assert.equal(r.receipts.db?.inserted, 4);
  assert.match(r.warnings.join("\n"), /1 dòng nhận hàng KHÔNG có mã lô/, "nói rõ dòng không đối soát được");
  assert.match(r.warnings.join("\n"), /chỉ tổng hợp ngày mới nhất/, "nói rõ đã bỏ snapshot cũ");
});

test("runInventoryFcSync: nhập LẠI cùng report → updated, không nhân đôi tồn", async () => {
  const db = new MockDbAdapter();
  const opts = { sellerAccountId: SELLER, fcReportText: FC_TEXT, receiptsReportText: RX_TEXT, adapter: db };
  await runInventoryFcSync(opts);
  const second = await runInventoryFcSync(opts);
  assert.equal(second.fc.db?.inserted, 0);
  assert.equal(second.fc.db?.updated, 5);
  assert.equal(second.receipts.db?.inserted, 0);
  assert.equal(second.receipts.db?.updated, 4);
  assert.equal(db.fcAllocation.length, 5);
  assert.equal(db.receipts.length, 4);
});

test("runInventoryFcSync: chỉ đưa 1 report thì report kia không bị ghi rỗng đè", async () => {
  const db = new MockDbAdapter();
  const r = await runInventoryFcSync({ sellerAccountId: SELLER, receiptsReportText: RX_TEXT, adapter: db });
  assert.equal(r.fc.db, null, "không có file FC → không gọi ghi, db = null");
  assert.equal(r.fc.rows, 0);
  assert.equal(db.fcAllocation.length, 0);
  assert.equal(r.receipts.db?.inserted, 4);
});

test("runInventoryFcSync: chưa có report nào → cảnh báo rõ cách lấy file, không ném lỗi", async () => {
  const db = new MockDbAdapter();
  const r = await runInventoryFcSync({ sellerAccountId: SELLER, adapter: db });
  assert.equal(r.job.status, "done");
  assert.match(r.warnings.join("\n"), /Seller Central/);
  assert.match(r.warnings.join("\n"), /FBA Daily Inventory History/);
});

test("runInventoryFcSync: ghi DB lỗi → job failed + ném lại (không im lặng coi như xong)", async () => {
  const db = new MockDbAdapter();
  db.upsertFcAllocation = async () => {
    throw new Error("PGRST202: chưa chạy migration 0018");
  };
  await assert.rejects(
    () => runInventoryFcSync({ sellerAccountId: SELLER, fcReportText: FC_TEXT, adapter: db }),
    /0018/,
  );
  const failed = db.jobs[db.jobs.length - 1];
  assert.equal(failed?.status, "failed");
  assert.match(String(failed?.lastError), /0018/);
});

/* ---------- runner CLI ---------- */

test("runInventoryFcSyncCli: chưa có file → hướng dẫn lấy report, không ném lỗi", async () => {
  let out = "";
  const r = await runInventoryFcSyncCli({ stdout: { write: (s) => { out += s; } } });
  assert.equal(r.db, "mock");
  assert.equal(r.report, null);
  assert.match(out, /FBA Daily Inventory History/);
  assert.match(out, /FBA Received Inventory/);
});

test("runInventoryFcSyncCli: --dry-run chạy trong bộ nhớ, in đủ số để đối chiếu", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vexim-fc-"));
  const fcFile = path.join(dir, "fc.tsv");
  const rxFile = path.join(dir, "rx.tsv");
  fs.writeFileSync(fcFile, FC_TEXT);
  fs.writeFileSync(rxFile, RX_TEXT);
  let out = "";
  const adapter = new MockDbAdapter();
  const r = await runInventoryFcSyncCli({
    fcFile,
    receiptsFile: rxFile,
    dryRun: true,
    adapter,
    stdout: { write: (s) => { out += s; } },
  });
  assert.equal(r.db, "mock");
  assert.equal(r.summary.dryRun, true);
  assert.equal(r.summary.fcUnits, 89);
  assert.equal(r.summary.receiptShipments, 2);
  assert.match(out, /KHÔNG ghi DB thật/);
  assert.match(out, /ONT8\s+46 đơn vị/);
  assert.match(out, /FBA15DXYZ1\s+50 đơn vị/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("runInventoryFcSyncCli: KHÔNG ghi DB thật khi thiếu credentials (mode != production)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vexim-fc-"));
  const fcFile = path.join(dir, "fc.tsv");
  fs.writeFileSync(fcFile, FC_TEXT);
  const saved = { ...process.env };
  delete process.env.AMAZON_LWA_CLIENT_ID;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const r = await runInventoryFcSyncCli({ fcFile, adapter: new MockDbAdapter() });
    assert.equal(r.db, "mock");
    assert.notEqual(r.mode, "production");
  } finally {
    process.env = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runInventoryFcSyncCli: >1 shop production mà thiếu --seller → từ chối, không đoán shop", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vexim-fc-"));
  const fcFile = path.join(dir, "fc.tsv");
  fs.writeFileSync(fcFile, FC_TEXT);
  const saved = { ...process.env };
  process.env.AMAZON_LWA_CLIENT_ID = "amzn1.test";
  process.env.AMAZON_LWA_CLIENT_SECRET = "secret";
  process.env.AMAZON_LWA_REFRESH_TOKEN = "refresh";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  const adapter = new MockDbAdapter();
  adapter.seedShops([
    { id: SELLER, displayName: "Shop A", sellerId: "A1", marketplace: "ATVPDKIKX0DER", leadDays: 32, safetyDays: 14 },
    {
      id: "44444444-4444-4444-8444-444444444444",
      displayName: "Shop B",
      sellerId: "B2",
      marketplace: "ATVPDKIKX0DER",
      leadDays: 32,
      safetyDays: 14,
    },
  ]);
  try {
    await assert.rejects(
      () => runInventoryFcSyncCli({ fcFile, adapter }),
      /phải chỉ định --seller/,
    );
    const one = await runInventoryFcSyncCli({ fcFile, sellerAccountId: SELLER, adapter });
    assert.equal(one.db, "supabase", "đủ credentials + chỉ định shop → đi đường ghi DB thật");
    assert.equal(one.summary.fcInserted, 5);
    assert.equal(adapter.fcAllocation.length, 5);
  } finally {
    process.env = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
