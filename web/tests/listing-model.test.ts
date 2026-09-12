/**
 * Test model Module 1 (Listing — L1/L2/L4) sau migration 0016.
 *
 * Điểm khoá:
 *   • issue JSONB nguyên văn Amazon (enforcements.actions) phải chuẩn hoá được,
 *     nếu không cột "bị Amazon chặn" luôn trống dù listing đang bị ẩn;
 *   • trạng thái lạ KHÔNG được ép về INACTIVE (đếm nhầm listing chết);
 *   • thiếu dữ liệu (quantity/issues) → null/"—", không hiện 0 giả;
 *   • L4 nêu đúng LÝ DO (stranded reason > enforcement > mã issue) để biết sửa gì.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeListingKpis,
  LISTINGS_SELECT,
  LISTING_QUEUE_SELECT,
  LISTING_STATUS_TONE,
  LISTING_STATUS_VI,
  mapListingQueueItem,
  mapListingRow,
  normalizeEnforcements,
  normalizeIssues,
  normalizeStatus,
  type ListingRaw,
} from "../src/lib/data/listing-model.ts";
import type { ListingStatus } from "../src/lib/types.ts";

function raw(partial: Partial<ListingRaw>): ListingRaw {
  return {
    id: "1",
    seller_account_id: "shop-a",
    shop: "Shop A",
    sku: partial.sku ?? "TG-LUG-20-BLK",
    asin: "B0DEMO001",
    title: "TravelGear 20",
    status: "ACTIVE",
    price: 129.99,
    currency: "USD",
    updated_at: "2026-09-12T02:00:00Z",
    error_count: 0,
    warning_count: 0,
    issues: null,
    buy_box_won: true,
    buy_box_price: 129.99,
    competitor_price: 132.5,
    offer_captured_at: "2026-09-12T02:00:00Z",
    ...partial,
  };
}

/** Issue đúng hình dạng Amazon trả (worker 0016 ghi nguyên văn vào jsonb). */
function amazonIssue(over: Record<string, unknown> = {}) {
  return {
    code: "8541",
    message: "Attributes tagged as relevant_attributes are incomplete.",
    severity: "ERROR",
    attributeNames: ["item_name"],
    categories: ["A", "B"],
    enforcements: { actions: ["SEARCH_SUPPRESSED"] },
    ...over,
  };
}

/* ---------- select phải khớp cột view ---------- */

test("LISTINGS_SELECT lấy đủ cột 0016; QUEUE_SELECT bỏ cột offer của view queue", () => {
  for (const col of [
    "product_type",
    "buyable",
    "discoverable",
    "quantity",
    "stranded_reason",
    "enforcement_actions",
    "last_source",
    "last_synced_at",
    "issues",
  ]) {
    assert.ok(LISTINGS_SELECT.split(",").includes(col), `LISTINGS_SELECT thiếu ${col}`);
    assert.ok(LISTING_QUEUE_SELECT.split(",").includes(col), `LISTING_QUEUE_SELECT thiếu ${col}`);
  }
  // vexim_listing_queue KHÔNG có buy_box_* → select mà có là PostgREST báo PGRST204
  for (const col of ["buy_box_won", "buy_box_price", "competitor_price", "offer_captured_at"]) {
    assert.equal(LISTING_QUEUE_SELECT.split(",").includes(col), false, `queue không được select ${col}`);
    assert.ok(LISTINGS_SELECT.split(",").includes(col));
  }
});

/* ---------- trạng thái ---------- */

test("normalizeStatus: đủ tập 0016, chữ thường của seed cũ, và KHÔNG ép trạng thái lạ về INACTIVE", () => {
  assert.equal(normalizeStatus("Active [*]"), "UNKNOWN", "report ghi 'Active [*]' → chưa rõ, không được đoán ACTIVE");
  assert.equal(normalizeStatus("active"), "ACTIVE");
  assert.equal(normalizeStatus("STRANDED"), "STRANDED");
  assert.equal(normalizeStatus("REMOVED"), "REMOVED");
  assert.equal(normalizeStatus("CLOSED"), "CLOSED");
  assert.equal(normalizeStatus("DELETED"), "DELETED");
  assert.equal(normalizeStatus(""), "UNKNOWN");
  assert.equal(normalizeStatus(null), "UNKNOWN");
  // mọi trạng thái đều có nhãn + màu (Record đủ key → thiếu là typecheck fail)
  const all: ListingStatus[] = ["ACTIVE", "INACTIVE", "STRANDED", "SUPPRESSED", "REMOVED", "CLOSED", "DELETED", "UNKNOWN"];
  for (const st of all) {
    assert.ok(LISTING_STATUS_VI[st], `thiếu nhãn ${st}`);
    assert.ok(LISTING_STATUS_TONE[st], `thiếu màu ${st}`);
  }
  assert.equal(LISTING_STATUS_TONE.UNKNOWN, "amber", "chưa rõ thì phải vàng, không được xanh như ACTIVE");
});

/* ---------- issues ---------- */

test("normalizeIssues: đọc issue nguyên văn Amazon (enforcements.actions) + dạng phẳng cũ", () => {
  const issues = normalizeIssues([
    amazonIssue(),
    amazonIssue({ code: "90220", severity: "WARNING", enforcements: undefined }),
    { code: "—", severity: "ERROR", message: "Ảnh swatch thiếu", enforcement: "LISTING_SUPPRESSED" },
  ]);

  assert.equal(issues.length, 3);
  assert.equal(issues[0].code, "8541");
  assert.equal(issues[0].severity, "ERROR");
  assert.deepEqual(issues[0].attributeNames, ["item_name"]);
  assert.equal(issues[0].enforcement, "SEARCH_SUPPRESSED", "phải lấy từ enforcements.actions");
  assert.equal(issues[1].severity, "WARNING");
  assert.equal(issues[1].enforcement, undefined, "không bịa enforcement Amazon không trả");
  assert.equal(issues[2].enforcement, "LISTING_SUPPRESSED", "dạng phẳng cũ vẫn đọc được");
});

test("normalizeIssues: dữ liệu rác → mảng rỗng, không ném lỗi làm sập trang L2", () => {
  assert.deepEqual(normalizeIssues(null), []);
  assert.deepEqual(normalizeIssues(undefined), []);
  assert.deepEqual(normalizeIssues("không phải mảng"), []);
  assert.deepEqual(normalizeIssues({ code: "8541" }), []);
  assert.deepEqual(normalizeIssues([null, 42, "x"]), []);
  // thiếu field → có giá trị mặc định rõ ràng
  assert.deepEqual(normalizeIssues([{}]), [{ code: "—", severity: "INFO", message: "—", attributeNames: [] }]);
  assert.deepEqual(normalizeIssues([amazonIssue({ enforcements: { actions: [] } })])[0].enforcement, undefined);
});

test("normalizeEnforcements: mảng nhãn Amazon → string[], rác → []", () => {
  assert.deepEqual(normalizeEnforcements(["SEARCH_SUPPRESSED", "LISTING_SUPPRESSED"]), [
    "SEARCH_SUPPRESSED",
    "LISTING_SUPPRESSED",
  ]);
  assert.deepEqual(normalizeEnforcements(null), []);
  assert.deepEqual(normalizeEnforcements("SEARCH_SUPPRESSED"), []);
});

/* ---------- L1 ---------- */

test("mapListingRow: dùng dữ liệu thật 0016 (tồn, product type, stranded, nguồn ghi)", () => {
  const r = mapListingRow(
    raw({
      status: "STRANDED",
      quantity: 214,
      product_type: "LUGGAGE",
      buyable: false,
      discoverable: false,
      stranded_reason: "Listing error (product type invalid)",
      enforcement_actions: ["LISTING_SUPPRESSED"],
      last_source: "report",
      last_synced_at: "2026-09-12T02:00:00Z",
      issues: [amazonIssue()],
      error_count: 0,
      warning_count: 0,
    }),
  );

  assert.equal(r.status, "STRANDED");
  assert.equal(r.stock, 214, "tồn lấy từ quantity của report — hết cảnh hiện 0 giả");
  assert.equal(r.productType, "LUGGAGE");
  assert.equal(r.buyable, false);
  assert.equal(r.discoverable, false);
  assert.equal(r.strandedReason, "Listing error (product type invalid)");
  assert.deepEqual(r.enforcementActions, ["LISTING_SUPPRESSED"]);
  assert.equal(r.lastSource, "report");
  assert.equal(r.issues.length, 1);
  // có mảng chi tiết thì đếm TỪ MẢNG (view 0016 cũng ưu tiên mảng)
  assert.equal(r.issueErrors, 1);
  assert.equal(r.issueWarnings, 0);
});

test("mapListingRow: thiếu cột 0016 (DB chưa migrate) → null/[] chứ không nổ", () => {
  const legacy = {
    id: "1",
    seller_account_id: "shop-a",
    shop: "Shop A",
    sku: "OLD-1",
    asin: null,
    title: null,
    status: "Active [*]",
    price: null,
    currency: null,
    updated_at: "2026-09-12T02:00:00Z",
    error_count: 2,
    warning_count: 1,
    issues: null,
    buy_box_won: null,
    buy_box_price: null,
    competitor_price: null,
    offer_captured_at: null,
  } as unknown as ListingRaw;

  const r = mapListingRow(legacy);
  assert.equal(r.stock, null, "chưa có quantity → null để UI hiện '—'");
  assert.equal(r.productType, null);
  assert.equal(r.buyable, null);
  assert.equal(r.strandedReason, null);
  assert.deepEqual(r.enforcementActions, []);
  assert.equal(r.lastSource, null);
  assert.deepEqual(r.issues, []);
  assert.equal(r.status, "UNKNOWN");
  assert.equal(r.issueErrors, 2, "không có mảng chi tiết → dùng bộ đếm của view");
  assert.equal(r.issueWarnings, 1);
  assert.equal(r.price, "—");
});

/* ---------- L4 ---------- */

test("mapListingQueueItem: ưu tiên LÝ DO STRANDED (có hàng kẹt FC = mất tiền thật)", () => {
  const item = mapListingQueueItem(
    raw({
      status: "STRANDED",
      quantity: 214,
      stranded_reason: "No listing exists for inventory",
      issues: null,
    }),
  );
  assert.match(item.cause, /^Stranded — No listing exists for inventory/);
  assert.match(item.cause, /214 đơn vị kẹt tại FC/);
  assert.equal(item.causeCode, "STRANDED");
  assert.equal(item.priority, "red");
  assert.match(item.slaLabel, /24h/);
  assert.match(item.suggestion, /removal order|SOP-03 bước 6/);
});

test("mapListingQueueItem: không có stranded thì nêu enforcement Amazon đang áp", () => {
  const item = mapListingQueueItem(
    raw({
      status: "ACTIVE",
      enforcement_actions: ["SEARCH_SUPPRESSED"],
      issues: [amazonIssue({ severity: "ERROR", message: "Ảnh swatch thiếu" })],
      error_count: 1,
    }),
  );
  assert.match(item.cause, /^Amazon đang áp: SEARCH_SUPPRESSED/);
  assert.match(item.cause, /Ảnh swatch thiếu/);
  assert.equal(item.causeCode, "SEARCH_SUPPRESSED");
  assert.equal(item.priority, "red");
  assert.match(item.suggestion, /ảnh swatch/i);
});

test("mapListingQueueItem: chỉ có issue → nêu mã + thông điệp; WARNING → ưu tiên vừa", () => {
  const err = mapListingQueueItem(raw({ status: "INACTIVE", issues: [amazonIssue()], error_count: 1 }));
  assert.equal(err.causeCode, "8541");
  assert.match(err.cause, /relevant_attributes/);
  assert.equal(err.priority, "red");

  const warn = mapListingQueueItem(
    raw({ status: "ACTIVE", issues: [amazonIssue({ severity: "WARNING", code: "90220" })], warning_count: 1 }),
  );
  assert.equal(warn.priority, "amber");
  assert.equal(warn.priorityLabel, "Vừa");
  assert.match(warn.suggestion, /product_description/);
});

test("mapListingQueueItem: mất BUYABLE/DISCOVERABLE → đề xuất đúng bệnh dù report ghi ACTIVE", () => {
  const noBuy = mapListingQueueItem(raw({ status: "ACTIVE", buyable: false, issues: [amazonIssue()], error_count: 1 }));
  assert.match(noBuy.suggestion, /mất BUYABLE/i);

  const noDisc = mapListingQueueItem(raw({ status: "ACTIVE", discoverable: false, issues: [amazonIssue()], error_count: 1 }));
  assert.match(noDisc.suggestion, /mất DISCOVERABLE/i);
});

test("mapListingQueueItem: trạng thái UNKNOWN → bảo chạy --details, không kết luận bừa", () => {
  const item = mapListingQueueItem(raw({ status: "Active [*]", issues: null }));
  assert.equal(item.causeCode, "UNKNOWN");
  assert.match(item.cause, /không đọc được/);
  assert.equal(item.priority, "amber");
  assert.match(item.suggestion, /listings:sync --details/);
});

/* ---------- KPI ---------- */

test("computeListingKpis: đếm stranded/UNKNOWN riêng và nêu số SKU 'ACTIVE mà không bán được'", () => {
  const rows = [
    mapListingRow(raw({ sku: "OK", status: "ACTIVE", buyable: true, discoverable: true })),
    mapListingRow(raw({ sku: "ST", status: "STRANDED", stranded_reason: "No listing exists", quantity: 7 })),
    mapListingRow(raw({ sku: "UN", status: "Active [*]" })),
    mapListingRow(raw({ sku: "SUP", status: "ACTIVE", buyable: false, enforcement_actions: ["SEARCH_SUPPRESSED"], issues: [amazonIssue()], error_count: 1 })),
    mapListingRow(raw({ sku: "WARN", status: "ACTIVE", issues: [amazonIssue({ severity: "WARNING" })], warning_count: 1 })),
    // mất CẢ HAI cờ → vẫn chỉ tính 1 SKU (không được cộng thành 2)
    mapListingRow(raw({ sku: "DEAD", status: "ACTIVE", buyable: false, discoverable: false })),
  ];
  const kpis = computeListingKpis(rows);
  const by = Object.fromEntries(kpis.map((k) => [k.label, k]));

  assert.equal(by["Listing active"].value, "4", "OK + SUP + WARN + DEAD (ST stranded, UN chưa rõ)");
  assert.match(by["Listing active"].sub, /1 chưa rõ trạng thái/);
  assert.equal(by["Listing active"].tone, "warn");
  assert.equal(by["Stranded / inactive"].value, "1");
  assert.match(by["Stranded / inactive"].sub, /1 stranded/);
  assert.match(by["Stranded / inactive"].sub, /1 bị Amazon chặn/);
  assert.equal(by["Listing có lỗi"].value, "1");
  assert.match(by["Listing có lỗi"].sub, /2 SKU có issue chi tiết/);
  assert.equal(by["ACTIVE nhưng không bán được"].value, "2", "SUP (mất BUYABLE + enforcement) + DEAD (mất cả 2 cờ) — mỗi SKU đếm 1 lần");
  assert.match(by["ACTIVE nhưng không bán được"].sub, /2 mất BUYABLE · 1 mất DISCOVERABLE · 1 bị Amazon chặn/);
  assert.equal(by["ACTIVE nhưng không bán được"].tone, "down");
});

test("computeListingKpis: chưa có issue chi tiết → nhắc chạy listings:sync --details", () => {
  const rows = [mapListingRow(raw({ sku: "A", error_count: 3, issues: null }))];
  const kpis = computeListingKpis(rows);
  const err = kpis.find((k) => k.label === "Listing có lỗi");
  assert.equal(err?.value, "1");
  assert.match(err?.sub ?? "", /listings:sync --details/);
  assert.equal(computeListingKpis([])[0].value, "0");
});
