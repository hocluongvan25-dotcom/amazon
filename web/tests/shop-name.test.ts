/**
 * Test lưới an toàn hiển thị tên shop (fix "tên shop dạng mã thô" 09/2026):
 * displayName từ DB có thể là mã kỹ thuật (ATVPDKIKX0DER…, UUID, "P1 · ATVPDKIKX0DER")
 * khi DB chưa chạy migration 0026 — friendlyShopName phải thay bằng tên đọc được,
 * nhưng KHÔNG được đụng tên thân thiện do người vận hành đặt.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { friendlyShopName, groupBySeller, marketplaceLabel } from "../src/lib/data/oauth-shared.ts";
import type { ConnectShopRow } from "../src/lib/data/oauth-shared.ts";

const base = (over: Partial<ConnectShopRow>): Pick<ConnectShopRow, "displayName" | "shop" | "marketplaceId"> => ({
  displayName: "",
  shop: "",
  marketplaceId: "ATVPDKIKX0DER",
  ...over,
});

test("tên thân thiện do người dùng đặt → giữ nguyên", () => {
  assert.equal(friendlyShopName(base({ displayName: "VEXIM US - Chính" })), "VEXIM US - Chính");
  assert.equal(friendlyShopName(base({ displayName: "P1 · US" })), "P1 · US"); // kỹ thuật nhưng vẫn đọc được
});

test("displayName = mã marketplace thô → 'Shop US'", () => {
  assert.equal(friendlyShopName(base({ displayName: "ATVPDKIKX0DER" })), "Shop US");
  assert.equal(
    friendlyShopName(base({ displayName: "A2EUQ1WTGCTBG2", marketplaceId: "A2EUQ1WTGCTBG2" })),
    "Shop CA",
  );
});

test("displayName dính mã marketplace thô kiểu 'P1 · ATVPDKIKX0DER' → 'Shop US'", () => {
  assert.equal(friendlyShopName(base({ displayName: "P1 · ATVPDKIKX0DER" })), "Shop US");
});

test("displayName là UUID → 'Shop US'", () => {
  assert.equal(
    friendlyShopName(base({ displayName: "ba4b4c68-6cf5-4096-9ea9-b42a01c07e87" })),
    "Shop US",
  );
});

test("displayName rỗng → fallback shop, rồi 'Shop <code>'", () => {
  assert.equal(friendlyShopName(base({ displayName: "", shop: "Cửa hàng A" })), "Cửa hàng A");
  assert.equal(friendlyShopName(base({ displayName: "", shop: "" })), "Shop US");
  assert.equal(
    friendlyShopName(base({ displayName: "", shop: "", marketplaceId: "A2EUQ1WTGCTBG2" })),
    "Shop CA",
  );
});

test("marketplaceLabel: mã lạ không crash, trả mã rút gọn", () => {
  const m = marketplaceLabel("AXXXXUNKNOWN1");
  assert.equal(typeof m.code, "string");
  assert.ok(m.code.length >= 2);
});

test("groupBySeller: cùng seller_id → chung 1 nhóm (P1·US + P2·CA không tách card)", () => {
  const mk = (over: Partial<ConnectShopRow>): ConnectShopRow => ({
    sellerAccountId: "id-" + Math.random(),
    shop: "",
    marketplace: "ATVPDKIKX0DER",
    marketplaceId: "ATVPDKIKX0DER",
    sellerId: "AQMVYI4HJTI4C",
    displayName: "",
    dataSource: "production",
    status: "active",
    hasToken: false,
    isActive: false,
    isExpired: false,
    needsReauth: false,
    daysLeft: null,
    expiresAt: null,
    authorizedAt: null,
    noticeDays: null,
    refreshCount: null,
    rotateReminderSent: false,
    noticeSentAt: null,
    adsProfiles: 0,
    ...over,
  });
  const groups = groupBySeller([
    mk({ displayName: "VEXIM US - Chính" }),
    mk({ displayName: "VEXIM CA - Canada", marketplace: "A2EUQ1WTGCTBG2", marketplaceId: "A2EUQ1WTGCTBG2" }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].shops.length, 2);
  assert.equal(groups[0].sellerId, "AQMVYI4HJTI4C");
});
