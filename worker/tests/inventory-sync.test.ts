/**
 * Test handler notification FBA_INVENTORY_AVAILABILITY_CHANGES + job đồng bộ
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  handleFbaInventoryAvailabilityChange,
  isFbaInventoryAvailabilityChange,
} from "../src/notifications/fba-inventory.handler.ts";
import { runInventorySync, reconcileInventory } from "../src/jobs/inventory-sync.job.ts";
import { MockDbAdapter } from "../src/db/adapter.ts";
import type { GetInventorySummariesResponse } from "../src/amazon/fba-inventory.ts";

const SELLER = "11111111-1111-4111-8111-111111111111";

test("payload Amazon chuẩn → nhận diện + chuẩn hóa + ghi raw", async () => {
  const db = new MockDbAdapter();
  const payload = {
    SellerId: "A1SELLER",
    FNSKU: "X00DEMO01F",
    ASIN: "B0TEST0001",
    SKU: "XMO-950-BLK",
    FulfillmentInventoryByMarketplace: [
      {
        MarketplaceId: "ATVPDKIKX0DER",
        FulfillmentInventoryDetails: [
          { Condition: "New", SupplyType: "OnHand", Quantity: 88, ReservedQuantityBreakdown: { TotalReserved: 12 } },
          { Condition: "New", SupplyType: "Inbound", Quantity: 60 },
        ],
      },
    ],
  };

  assert.ok(isFbaInventoryAvailabilityChange(payload));
  const normalized = await handleFbaInventoryAvailabilityChange(payload, db, {
    sellerAccountId: SELLER,
  });
  assert.ok(normalized);
  assert.equal(normalized.sku, "XMO-950-BLK");
  assert.equal(normalized.byMarketplace[0].available, 88);
  assert.equal(normalized.byMarketplace[0].reserved, 12);
  assert.equal(normalized.byMarketplace[0].inbound, 60);
  // raw luôn được giữ lại để replay
  assert.equal(db.notifications.length, 1);
  assert.equal(db.notifications[0].notificationType, "FBA_INVENTORY_AVAILABILITY_CHANGES");
});

test("payload lạ → trả null, không ghi", async () => {
  const db = new MockDbAdapter();
  const result = await handleFbaInventoryAvailabilityChange({ foo: "bar" }, db, {
    sellerAccountId: SELLER,
  });
  assert.equal(result, null);
  assert.equal(db.notifications.length, 0);
});

test("job đồng bộ: snapshot + daily + cảnh báo + đề xuất nhập", async () => {
  const db = new MockDbAdapter();
  // 14 ngày: twelve ngày 17 đơn + 2 ngày đỉnh 50 → velocity = (304 − 100)/14 ≈ 14.571
  db.seedSellingDays(SELLER, "XMO-950-BLK", [
    17, 50, 17, 17, 50, 17, 17, 17, 17, 17, 17, 17, 17, 17,
  ]);

  const summaries: GetInventorySummariesResponse = {
    granularity: { granularityType: "Marketplace", granularityId: "ATVPDKIKX0DER" },
    inventorySummaries: [
      {
        asin: "B0TEST0001",
        fnSku: "X00DEMO01F",
        sellerSku: "XMO-950-BLK",
        totalQuantity: 160,
        inventoryDetails: {
          fulfillableQuantity: 88,
          reservedQuantity: { totalReservedQuantity: 12 },
          inboundWorkingQuantity: 0,
          inboundShippedQuantity: 60,
          inboundReceivingQuantity: 0,
        },
      },
      {
        asin: "B0TEST0009",
        fnSku: "X00DEMO09F",
        sellerSku: "NEW-NO-HISTORY", // SKU mới — velocity 0
        totalQuantity: 300,
        inventoryDetails: { fulfillableQuantity: 300 },
      },
    ],
  };

  const report = await runInventorySync({
    sellerAccountId: SELLER,
    marketplaceId: "ATVPDKIKX0DER",
    client: { getInventorySummaries: async () => summaries },
    adapter: db,
    leadDays: 32,
    now: new Date("2026-09-11T06:00:00Z"),
  });

  assert.equal(report.skusProcessed, 2);
  // velocity = 204/14 ≈ 14.571 → cover = floor(88/14.571) = 6 → đỏ (< 7)
  const alert = report.alerts.find((a) => a.sku === "XMO-950-BLK");
  assert.ok(alert);
  assert.equal(alert.severity, "red");
  assert.equal(alert.coverDays, 6);
  // đề xuất: 14.571×46 − 160 = 510.29 → ceil = 511
  const sug = report.suggestions.find((s) => s.sku === "XMO-950-BLK");
  assert.ok(sug);
  assert.equal(sug.suggest, 511);
  // SKU mới không có đề xuất ảo (velocity 0 → need âm)
  assert.ok(!report.suggestions.some((s) => s.sku === "NEW-NO-HISTORY"));

  // snapshot + daily đã ghi
  assert.equal(db.snapshots.length, 2);
  assert.equal(db.daily.length, 2);
  const daily = db.daily.find((d) => d.sku === "XMO-950-BLK");
  assert.ok(daily);
  assert.equal(daily.daysOfCover, 6);
  assert.equal(daily.inStock, true);
});

test("đối soát tầng 3: snapshot vs report → trả lệch, không đè số", () => {
  const snapshot = [
    { sku: "A", asin: "B0A", fnSku: "X1", fulfillable: 40, reserved: 8, inbound: 60, total: 108 },
    { sku: "B", asin: "B0B", fnSku: "X2", fulfillable: 30, reserved: 0, inbound: 0, total: 30 },
  ];
  const reportRows = [
    { sku: "A", fulfillable: 40, reserved: 8, inbound: 60 }, // khớp
    { sku: "B", fulfillable: 28, reserved: 0, inbound: 0 }, // lệch fulfillable
  ];
  const diffs = reconcileInventory(snapshot, reportRows);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].sku, "B");
  assert.equal(diffs[0].field, "fulfillable");
  assert.equal(diffs[0].snapshot, 30);
  assert.equal(diffs[0].report, 28);
});
