/**
 * Test parseStoreNames — bóc storeName thật từ payload Sellers API
 * GET /sellers/v1/marketplaceParticipations (callback OAuth gọi để lấy
 * TÊN CỬA HÀNG THẬT thay cho tên mặc định 'Shop US · XXXX').
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseStoreNames, spapiHost } from "../src/lib/spapi/oauth.ts";

test("parseStoreNames: payload thật của Amazon [{marketplace, participation, storeName}]", () => {
  const data = {
    payload: [
      {
        marketplace: { id: "ATVPDKIKX0DER", countryCode: "US", name: "Amazon.com" },
        participation: { isParticipating: true, hasSuspendedListings: false },
        storeName: "Cửa hàng ABC Official",
      },
      {
        marketplace: { id: "A2EUQ1WTGCTBG2", countryCode: "CA", name: "Amazon.ca" },
        participation: { isParticipating: true, hasSuspendedListings: false },
        storeName: "ABC Canada Store",
      },
    ],
  };
  assert.deepEqual(parseStoreNames(data), [
    { marketplaceId: "ATVPDKIKX0DER", storeName: "Cửa hàng ABC Official" },
    { marketplaceId: "A2EUQ1WTGCTBG2", storeName: "ABC Canada Store" },
  ]);
});

test("parseStoreNames: storeName nằm trong participation (biến thể schema)", () => {
  const data = {
    payload: [
      {
        marketplace: { id: "ATVPDKIKX0DER" },
        participation: { isParticipating: true, storeName: "Shop Trong Participation" },
      },
    ],
  };
  assert.deepEqual(parseStoreNames(data), [
    { marketplaceId: "ATVPDKIKX0DER", storeName: "Shop Trong Participation" },
  ]);
});

test("parseStoreNames: bỏ qua phần tử thiếu storeName hoặc rỗng/toàn khoảng trắng", () => {
  const data = {
    payload: [
      { marketplace: { id: "ATVPDKIKX0DER" }, storeName: "   " },
      { marketplace: { id: "A2EUQ1WTGCTBG2" } },
      { marketplace: { id: "A1F83G8C2ARO7P" }, storeName: "UK Shop" },
    ],
  };
  assert.deepEqual(parseStoreNames(data), [{ marketplaceId: "A1F83G8C2ARO7P", storeName: "UK Shop" }]);
});

test("parseStoreNames: trim khoảng trắng quanh storeName", () => {
  const data = { payload: [{ marketplace: { id: "ATVPDKIKX0DER" }, storeName: "  My Store  " }] };
  assert.deepEqual(parseStoreNames(data), [{ marketplaceId: "ATVPDKIKX0DER", storeName: "My Store" }]);
});

test("parseStoreNames: mảng trần không có wrapper payload vẫn parse được", () => {
  const data = [{ marketplace: { id: "ATVPDKIKX0DER" }, storeName: "Bare Array" }];
  assert.deepEqual(parseStoreNames(data), [{ marketplaceId: "ATVPDKIKX0DER", storeName: "Bare Array" }]);
});

test("parseStoreNames: dữ liệu rác không nổ — null/chuỗi/số/object lỗi → []", () => {
  assert.deepEqual(parseStoreNames(null), []);
  assert.deepEqual(parseStoreNames(undefined), []);
  assert.deepEqual(parseStoreNames("oops"), []);
  assert.deepEqual(parseStoreNames(42), []);
  assert.deepEqual(parseStoreNames({ errors: [{ code: "Unauthorized" }] }), []);
  assert.deepEqual(parseStoreNames({ payload: [null, "x", 7] }), []);
});

test("spapiHost: map đúng region → endpoint SP-API", () => {
  assert.equal(spapiHost("NA"), "sellingpartnerapi-na.amazon.com");
  assert.equal(spapiHost("EU"), "sellingpartnerapi-eu.amazon.com");
  assert.equal(spapiHost("FE"), "sellingpartnerapi-fe.amazon.com");
});
