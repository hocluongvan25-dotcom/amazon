/**
 * Test Module 1 — client Listings Items API + notification handlers
 * + parser report Merchant Listings/Stranded + job đồng bộ.
 * Payload/đường dẫn bám reference Amazon đã kiểm chứng (2021-08-01, PayloadVersion 2023-12-13).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ListingsItemsClient,
  extractListingState,
  type ListingsItem,
} from "../src/amazon/listings.ts";
import {
  handleListingsItemStatusChange,
  handleListingsItemIssuesChange,
  deriveStatus,
} from "../src/notifications/listings.handler.ts";
import {
  parseMerchantListingsReport,
  parseStrandedInventoryReport,
  normalizeMerchantStatus,
} from "../src/reports/merchant-listings.parser.ts";
import { runListingsSync } from "../src/jobs/listings-sync.job.ts";
import { MockDbAdapter } from "../src/db/adapter.ts";

const SELLER_ACC = "11111111-1111-4111-8111-111111111111";

/* ---------- deriveStatus ---------- */

test("BUYABLE/DISCOVERABLE → trạng thái L1", () => {
  assert.equal(deriveStatus({ buyable: true, discoverable: true }), "ACTIVE");
  assert.equal(deriveStatus({ buyable: true, discoverable: false }), "SUPPRESSED");
  assert.equal(deriveStatus({ buyable: false, discoverable: true }), "INACTIVE");
  assert.equal(deriveStatus({ buyable: false, discoverable: false }), "INACTIVE");
  assert.equal(deriveStatus({ buyable: null, discoverable: null }), null); // Status [] = không áp dụng
});

/* ---------- Client getListingsItem ---------- */

test("getListingsItem: URL + query đúng chuẩn + chịu itemName null", async () => {
  let calledUrl = "";
  let calls = 0;
  const fetchFn = (async (url: string | URL) => {
    calls++;
    calledUrl = url.toString();
    const item: ListingsItem = {
      sku: "XMO-950-BLK",
      summaries: [
        {
          marketplaceId: "ATVPDKIKX0DER",
          asin: "B0C7T31F",
          productType: "LUGGAGE",
          status: ["DISCOVERABLE"], // mất BUYABLE
          itemName: null, // đã ghi nhận null thực tế
        },
      ],
      issues: [
        {
          code: "8541",
          message: "Attributes tagged as relevant_attributes are incomplete.",
          severity: "WARNING",
          attributeNames: ["item_diameter", "theme"],
        },
      ],
    };
    return new Response(JSON.stringify(item), { status: 200 });
  }) as unknown as typeof fetch;

  const lwa = { getAccessToken: async () => "TOKEN" } as never;
  const client = new ListingsItemsClient({ host: "https://sellingpartnerapi-na.amazon.com", lwa, fetchFn });
  const item = await client.getListingsItem({
    sellerId: "A1SELLER",
    sku: "XMO-950-BLK",
    marketplaceId: "ATVPDKIKX0DER",
    issueLocale: "en_US",
  });

  assert.equal(calls, 1);
  assert.ok(calledUrl.startsWith("https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/A1SELLER/XMO-950-BLK"));
  assert.ok(calledUrl.includes("marketplaceIds=ATVPDKIKX0DER"));
  assert.ok(calledUrl.includes("includedData="));
  assert.ok(calledUrl.includes("issueLocale=en_US"));
  assert.equal(item.summaries?.[0]?.itemName, null); // không crash

  const state = extractListingState(item);
  assert.equal(state.asin, "B0C7T31F");
  assert.equal(state.productType, "LUGGAGE");
  assert.equal(state.buyable, false);
  assert.equal(state.discoverable, true);
  assert.equal(state.issueErrors, 0);
  assert.equal(state.issueWarnings, 1);
});

test("extractListingState: gom enforcement actions từ issues", () => {
  const item: ListingsItem = {
    sku: "VPN-220",
    issues: [
      {
        code: "90220",
        severity: "ERROR",
        message: "'product_description' is required but not supplied.",
        attributeNames: ["product_description"],
        enforcements: { actions: ["LISTING_SUPPRESSED"] },
      },
      {
        severity: "ERROR",
        message: "Ảnh không đạt độ phân giải",
        enforcements: { actions: ["SEARCH_SUPPRESSED"] },
      },
    ],
  };
  const state = extractListingState(item);
  assert.equal(state.issueErrors, 2);
  assert.deepEqual([...state.enforcementActions].sort(), ["LISTING_SUPPRESSED", "SEARCH_SUPPRESSED"]);
});

/* ---------- Notification handlers ---------- */

test("STATUS_CHANGE: BUYABLE+DISCOVERABLE → ACTIVE, ghi notification + listing", async () => {
  const db = new MockDbAdapter();
  const res = await handleListingsItemStatusChange(
    {
      SellerId: "A1SELLER",
      MarketplaceId: "ATVPDKIKX0DER",
      Asin: "B0C7T31F",
      Sku: "XMO-950-BLK",
      CreatedDate: "2026-09-11T06:00:00.000Z",
      Status: ["BUYABLE", "DISCOVERABLE"],
    },
    db,
    { sellerAccountId: SELLER_ACC },
  );
  assert.ok(res);
  assert.equal(res.sku, "XMO-950-BLK");
  assert.equal(res.status, "ACTIVE");
  assert.equal(db.notifications.length, 1);
  assert.equal(db.notifications[0].notificationType, "LISTINGS_ITEM_STATUS_CHANGE");
  assert.equal(db.listings.length, 1);
  assert.equal(db.listings[0].status, "ACTIVE");
  assert.equal(db.listings[0].buyable, true);
});

test("STATUS_CHANGE: Status rỗng (không áp dụng) → KHÔNG ghi đè trạng thái", async () => {
  const db = new MockDbAdapter();
  const res = await handleListingsItemStatusChange(
    { SellerId: "A1SELLER", Asin: "B0X", Sku: "SKU-1", Status: [] },
    db,
    { sellerAccountId: SELLER_ACC },
  );
  assert.ok(res);
  assert.equal(res.status, null);
  assert.equal(db.listings.length, 0); // không upsert khi chưa biết trạng thái
  assert.equal(db.notifications.length, 1); // vẫn giữ raw để replay
});

test("ISSUES_CHANGE: ghi notification + gọi getListingsItem lấy chi tiết (đúng hướng dẫn Amazon)", async () => {
  const db = new MockDbAdapter();
  const res = await handleListingsItemIssuesChange(
    {
      SellerId: "A1SELLER",
      MarketplaceId: "ATVPDKIKX0DER",
      Asin: "B0C7T31F",
      Sku: "XMO-950-BLK",
      Severities: ["ERROR"],
      EnforcementActions: ["SEARCH_SUPPRESSED"],
    },
    db,
    {
      sellerAccountId: SELLER_ACC,
      fetchDetail: async () => ({
        sku: "XMO-950-BLK",
        summaries: [{ asin: "B0C7T31F", status: ["DISCOVERABLE"], itemName: null }],
        issues: [{ code: "—", severity: "ERROR", message: "Ảnh swatch thiếu", enforcements: { actions: ["SEARCH_SUPPRESSED"] } }],
      }),
    },
  );
  assert.ok(res);
  assert.equal(res.detailFetched, true);
  assert.equal(db.notifications.length, 1);
  assert.equal(db.listings.length, 1);
  assert.equal(db.listings[0].issueErrors, 1);
  assert.deepEqual(db.listings[0].enforcementActions, ["SEARCH_SUPPRESSED"]);
});

test("payload lạ → cả 2 handler trả null, không ghi gì", async () => {
  const db = new MockDbAdapter();
  assert.equal(await handleListingsItemStatusChange({ foo: 1 }, db, { sellerAccountId: SELLER_ACC }), null);
  assert.equal(await handleListingsItemIssuesChange({ foo: 1 }, db, { sellerAccountId: SELLER_ACC }), null);
  assert.equal(db.notifications.length, 0);
});

/* ---------- Parser report Merchant Listings ---------- */

// Header thật 2024: có cột "Deprecated column" trùng tên — parser theo tên không phụ thuộc vị trí
const ML_HEAD =
  "item-name\titem-description\tlisting-id\tseller-sku\tprice\tquantity\topen-date\tDeprecated column\titem-is-marketplace\tproduct-id-type\tDeprecated column\titem-note\titem-condition\tDeprecated column\tDeprecated column\tDeprecated column\tasin1\tDeprecated column\tDeprecated column\twill-ship-internationally\texpedited-shipping\tDeprecated column\tproduct-id\tDeprecated column\tadd-delete\tpending-quantity\tfulfilment-channel\tmerchant-shipping-group\tstatus\tMinimum order quantity\tSell remainder";

test("parser Merchant Listings: header thật có cột Deprecated — theo tên cột", () => {
  const tsv = [
    ML_HEAD,
    'XMO 950 Hardside Spinner\tMô tả\t123\tXMO-950-BLK\t129.99\t142\t08/12/2024\t\t1\t1\t\t\tNew\t\t\t\tB0C7T31F\t\t\t\t\tB0TEST\t\t\ta\ta\tDEFAULT\tStandard\tActive [*]\t\t',
    'VPNova 220 Máy xay\tMô tả\t124\tVPN-220\t59.90\t214\t11/02/2023\t\t1\t1\t\t\tNew\t\t\t\tB0B2X77K\t\t\t\t\tB0TEST2\t\t\ta\ta\tDEFAULT\tStandard\tInactive\t\t',
    'KChef 118 Nồi chiên\tMô tả\t125\tKCH-118-W\t79.99\t310\t03/03/2025\t\t1\t1\t\t\tNew\t\t\t\tB0C4K52D\t\t\t\t\tB0TEST3\t\t\ta\ta\tDEFAULT\tStandard\tActive\t\t',
    'DriftLine 300 cũ\tMô tả\t126\tDRF-100\t45.50\t0\t01/01/2022\t\t1\t1\t\t\tNew\t\t\t\tB0A9F14M\t\t\t\t\tB0TEST4\t\t\ta\ta\tDEFAULT\tStandard\tClosed\t\t',
  ].join("\n");

  const { rows, warnings } = parseMerchantListingsReport(tsv);
  assert.deepEqual(warnings, []);
  assert.equal(rows.length, 4);

  const xmo = rows[0];
  assert.equal(xmo.sku, "XMO-950-BLK");
  assert.equal(xmo.asin, "B0C7T31F");
  assert.equal(xmo.price, "129.99");
  assert.equal(xmo.quantity, 142);
  assert.equal(xmo.fulfilmentChannel, "DEFAULT");
  assert.equal(xmo.status, "SUPPRESSED"); // "Active [*]" — có vấn đề tiềm ẩn
  assert.equal(rows[1].status, "INACTIVE");
  assert.equal(rows[2].status, "ACTIVE");
  assert.equal(rows[3].status, null); // Closed — không ghi đè
});

test("normalizeMerchantStatus: các giá trị thực tế", () => {
  assert.equal(normalizeMerchantStatus("Active"), "ACTIVE");
  assert.equal(normalizeMerchantStatus("Active [*]"), "SUPPRESSED");
  assert.equal(normalizeMerchantStatus("Inactive"), "INACTIVE");
  assert.equal(normalizeMerchantStatus("Closed"), null);
  assert.equal(normalizeMerchantStatus("Deleted"), null);
});

test("parser Merchant Listings: thiếu cột bắt buộc → cảnh báo, không crash", () => {
  const { rows, warnings } = parseMerchantListingsReport("asin1\tprice\nB0X\t9.99");
  assert.equal(rows.length, 0);
  assert.ok(warnings.some((w) => w.includes("Thiếu cột bắt buộc")));
});

/* ---------- Parser report Stranded ---------- */

test("parser Stranded: cột stranded reason + số lượng", () => {
  const tsv = [
    "Title\tASIN\tSKU\tFNSKU\tStranded reason\tQuantity available\tDisposition",
    "VPNova 220\tB0B2X77K\tVPN-220\tX00STRAND1\tListing error (product type invalid)\t214\tFulfillable",
    "Aqura 12 Set\tB0D1Q88B\tAQR-12-SET\tX00STRAND2\tNo listing exists for inventory\t63\tFulfillable",
  ].join("\n");

  const { rows, warnings } = parseStrandedInventoryReport(tsv);
  assert.deepEqual(warnings, []);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].sku, "VPN-220");
  assert.equal(rows[0].strandedReason, "Listing error (product type invalid)");
  assert.equal(rows[0].quantity, 214);
  assert.equal(rows[1].fnSku, "X00STRAND2");
});

/* ---------- Job đồng bộ ---------- */

test("runListingsSync: 3 report → listing state + queue L4 + cảnh báo lệch nguồn", async () => {
  const db = new MockDbAdapter();
  const allTsv = [
    ML_HEAD,
    'XMO 950\tMô tả\t1\tXMO-950-BLK\t129.99\t142\t08/12/2024\t\t1\t1\t\t\tNew\t\t\t\tB0C7T31F\t\t\t\t\tB0TEST\t\t\ta\ta\tDEFAULT\tStd\tActive [*]\t\t',
    'VPN 220\tMô tả\t2\tVPN-220\t59.90\t214\t11/02/2023\t\t1\t1\t\t\tNew\t\t\t\tB0B2X77K\t\t\t\t\tB0T2\t\t\ta\ta\tDEFAULT\tStd\tActive\t\t',
    'KChef 118\tMô tả\t3\tKCH-118-W\t79.99\t310\t03/03/2025\t\t1\t1\t\t\tNew\t\t\t\tB0C4K52D\t\t\t\t\tB0T3\t\t\ta\ta\tDEFAULT\tStd\tActive\t\t',
  ].join("\n");
  // KCH-118-W: report ALL ghi "Active" nhưng nằm trong report INACTIVE (không stranded) → cảnh báo
  const inactiveTsv = [
    ML_HEAD,
    'KChef 118\tMô tả\t3\tKCH-118-W\t79.99\t310\t03/03/2025\t\t1\t1\t\t\tNew\t\t\t\tB0C4K52D\t\t\t\t\tB0T3\t\t\ta\ta\tDEFAULT\tStd\tInactive\t\t',
  ].join("\n");
  const strandedTsv = [
    "Title\tASIN\tSKU\tFNSKU\tStranded reason\tQuantity available",
    "VPN 220\tB0B2X77K\tVPN-220\tX00S1\tListing error (product type invalid)\t214",
    "SKU đã xóa\tB0Z9Z9Z9Z\tGONE-1\tX00S2\tNo listing exists for inventory\t7",
  ].join("\n");

  const report = await runListingsSync({
    sellerAccountId: SELLER_ACC,
    allReportText: allTsv,
    inactiveReportText: inactiveTsv,
    strandedReportText: strandedTsv,
    adapter: db,
    now: new Date("2026-09-11T02:00:00Z"),
  });

  assert.equal(report.listingsProcessed, 3);
  assert.equal(report.strandedCount, 2);
  // XMO-950-BLK: Active [*] → SUPPRESSED; VPN-220: INACTIVE + stranded; GONE-1: stranded mới
  assert.equal(db.listings.length, 4);

  const xmo = db.listings.find((l) => l.sku === "XMO-950-BLK");
  assert.ok(xmo);
  assert.equal(xmo.status, "SUPPRESSED");

  const vpn = db.listings.find((l) => l.sku === "VPN-220");
  assert.ok(vpn);
  assert.equal(vpn.status, "STRANDED"); // stranded đè lên trạng thái report ALL
  assert.equal(vpn.strandedReason, "Listing error (product type invalid)");

  const kch = db.listings.find((l) => l.sku === "KCH-118-W");
  assert.ok(kch);
  assert.equal(kch.status, "INACTIVE"); // theo report INACTIVE khi ALL lệch

  const gone = db.listings.find((l) => l.sku === "GONE-1");
  assert.ok(gone);
  assert.equal(gone.status, "STRANDED");

  // Queue L4: mọi SKU không ACTIVE
  const queueSkus = report.queue.map((q) => q.sku).sort();
  assert.deepEqual(queueSkus, ["GONE-1", "KCH-118-W", "VPN-220", "XMO-950-BLK"]);

  // Cảnh báo lệch giữa report ALL và INACTIVE
  assert.ok(report.warnings.some((w) => w.includes("KCH-118-W") && w.includes("report INACTIVE")));
});
