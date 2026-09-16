/**
 * Test PHẠM VI SHOP (bộ chọn trên Topbar) — sự cố 16/09/2026.
 *
 * Chủ dự án hỏi: "Sao lại không chọn được shop đã kéo về hệ thống nhỉ hay là mặc
 * định nó như thế". Trả lời: trước đây bộ chọn là select TRANG TRÍ (1 option, không
 * onChange, không đọc DB). Bộ chọn thật dựa trên `pickShopScopeId` — hàm thuần được
 * khoá ở đây, gồm cả ca nguy hiểm: cookie cũ trỏ sang shop người dùng KHÔNG còn đọc
 * được (shop bị thu hồi / đổi quyền) thì phải bỏ qua, không dựng truy vấn rồi trả
 * rỗng một cách khó hiểu.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SHOP_SCOPE_COOKIE,
  SHOP_SCOPE_MAX_AGE_SECONDS,
  allShopsLabel,
  pickShopScopeId,
  shopOptionLabel,
} from "../src/lib/data/shop-scope-model.ts";

const SHOPS = [
  { id: "s-1", name: "VEXIM US" },
  { id: "s-2", name: "VEXIM EU" },
];

test("phạm vi shop: `?shop=` trên URL thắng cookie", () => {
  assert.equal(pickShopScopeId(SHOPS, "s-2", "s-1"), "s-2");
  assert.equal(pickShopScopeId(SHOPS, "s-1", null), "s-1");
});

test("phạm vi shop: không có URL thì lấy cookie (bộ chọn ở Topbar)", () => {
  assert.equal(pickShopScopeId(SHOPS, null, "s-2"), "s-2");
  assert.equal(pickShopScopeId(SHOPS, "", "s-1"), "s-1");
});

test("phạm vi shop: id KHÔNG nằm trong danh sách đọc được thì bỏ qua (RLS/thu hồi shop)", () => {
  // Shop lạ trên URL nhưng cookie hợp lệ ⇒ dùng cookie, không trả rỗng khó hiểu.
  assert.equal(pickShopScopeId(SHOPS, "s-999", "s-1"), "s-1");
  // Cả hai đều lạ ⇒ "tất cả shop", KHÔNG bao giờ trả id ngoài danh sách.
  assert.equal(pickShopScopeId(SHOPS, "s-999", "s-998"), null);
  assert.equal(pickShopScopeId(SHOPS, "  ", "  "), null);
  assert.equal(pickShopScopeId([], "s-1", "s-1"), null, "không đọc được shop nào ⇒ tất cả (rỗng)");
});

test("phạm vi shop: nhãn shop ghép tên vận hành với tên Amazon, không lặp", () => {
  assert.equal(shopOptionLabel({ name: "VEXIM US", storeName: "Vexim Global" }), "VEXIM US — Vexim Global");
  assert.equal(shopOptionLabel({ name: "VEXIM US", storeName: null }), "VEXIM US");
  assert.equal(shopOptionLabel({ name: "VEXIM US", storeName: "   " }), "VEXIM US");
  assert.equal(
    shopOptionLabel({ name: "VEXIM US", storeName: "VEXIM US" }),
    "VEXIM US",
    "trùng tên thì không hiện 'A — A'",
  );
});

test("phạm vi shop: mục 'tất cả shop' nói rõ số shop đọc được", () => {
  assert.equal(allShopsLabel(0), "Tất cả shop");
  assert.equal(allShopsLabel(14), "Tất cả shop (14)");
});

test("phạm vi shop: tên cookie + thời hạn dùng CHUNG giữa client và server", () => {
  // Client (`ShopScopeSelect`) ghi cookie, server (`resolveShopScope`) đọc lại —
  // lệch tên là bộ chọn im lặng không có tác dụng.
  assert.equal(SHOP_SCOPE_COOKIE, "shop_scope");
  assert.ok(SHOP_SCOPE_MAX_AGE_SECONDS >= 24 * 60 * 60, "ít nhất 1 ngày, tránh mất lựa chọn liên tục");
});
