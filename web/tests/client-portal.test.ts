import assert from "node:assert/strict";
import { test } from "node:test";

import {
  depositText,
  formatCount,
  formatMoney,
  formatMoneyList,
  latestSettlement,
  monthStart,
  periodText,
  returnRatePct,
  shortDate,
  sumByCurrency,
  summarizeHealth,
  type SettlementLite,
} from "../src/lib/client-model.ts";

/**
 * Cổng khách hàng `/client` trước đây in số viết cứng ($186,400 · 5,120 đơn ·
 * AHR 780 · $23,900). Luật mới: số thật, hoặc "chưa có dữ liệu" — KHÔNG suy diễn.
 * Các hàm dưới đây là phần thuần của luật đó.
 */

test("ngày đầu tháng đúng định dạng PostgREST (YYYY-MM-01)", () => {
  assert.equal(monthStart(new Date("2026-09-13T10:00:00Z")), "2026-09-01");
  assert.equal(monthStart(new Date("2026-01-05T00:00:00Z")), "2026-01-01");
  assert.equal(monthStart(new Date("2026-12-31T23:59:59Z")), "2026-12-01");
});

test("gộp tiền theo loại tiền — không cộng USD với CAD thành một số", () => {
  const r = sumByCurrency([
    { amount: 100.5, currency: "USD" },
    { amount: 49.5, currency: "USD" },
    { amount: "200", currency: "CAD" },
    { amount: null, currency: "USD" },
    { amount: 0, currency: "CAD" },
  ]);
  assert.deepEqual(r, [
    { currency: "CAD", total: 200 },
    { currency: "USD", total: 150 },
  ]);
  assert.deepEqual(sumByCurrency([]), []);
});

test("định dạng tiền: có ký hiệu, số lẻ hợp lý, loại tiền lạ vẫn rõ", () => {
  assert.equal(formatMoney(186400, "USD"), "$186,400");
  assert.equal(formatMoney(1234.56, "USD"), "$1,235");
  assert.equal(formatMoney(12.5, "USD"), "$12.50");
  assert.equal(formatMoney(200, "CAD"), "CA$200");
  assert.equal(formatMoney(1500000, "VND"), "₫1,500,000");
  assert.equal(formatMoney(99, "XYZ"), "99 XYZ");
  assert.equal(formatMoney(Number.NaN, "USD"), "chưa có dữ liệu");
});

test("danh sách tiền: rỗng ⇒ 'chưa có dữ liệu', nhiều loại ⇒ nêu loại bị gộp", () => {
  assert.equal(formatMoneyList([]), "chưa có dữ liệu");
  assert.equal(
    formatMoneyList([
      { currency: "USD", total: 12300 },
      { currency: "CAD", total: 1200 },
    ]),
    "$12,300 · CA$1,200",
  );
  const three = formatMoneyList([
    { currency: "USD", total: 300 },
    { currency: "CAD", total: 200 },
    { currency: "MXN", total: 100 },
  ]);
  assert.equal(three, "$300 · CA$200 +1 loại tiền");
});

test("số đếm: không có dữ liệu thì nói thẳng, không hiện 0 giả", () => {
  assert.equal(formatCount(5120), "5,120");
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(null), "chưa có dữ liệu");
  assert.equal(formatCount(undefined), "chưa có dữ liệu");
  assert.equal(formatCount(Number.NaN), "chưa có dữ liệu");
});

test("tỉ lệ hoàn: chưa có đơn ⇒ null (KHÔNG phải 0%)", () => {
  assert.equal(returnRatePct(0, 3), null);
  assert.equal(returnRatePct(1000, 25), 2.5);
  assert.equal(returnRatePct(3, 1), 33.3);
});

test("sức khỏe tài khoản: chưa có snapshot ⇒ 'chưa có dữ liệu', không mặc định Tốt", () => {
  const none = summarizeHealth([]);
  assert.equal(none.label, "chưa có dữ liệu");
  assert.equal(none.tone, "flat");

  const good = summarizeHealth([
    { tone: "green", score: 900 },
    { tone: "green", score: 780 },
  ]);
  assert.equal(good.label, "Tốt");
  assert.equal(good.tone, "up");
  assert.match(good.detail, /780/);

  const warn = summarizeHealth([{ tone: "green", score: 900 }, { tone: "amber", score: 700 }]);
  assert.equal(warn.label, "Theo dõi");
  assert.equal(warn.tone, "warn");

  const bad = summarizeHealth(
    [
      { tone: "green", score: 900 },
      { tone: "red", score: 420 },
    ],
    ["Shop A1 · US"],
  );
  assert.equal(bad.label, "Cần chú ý");
  assert.equal(bad.tone, "down");
  assert.match(bad.detail, /Shop A1 · US/);
});

function settle(over: Partial<SettlementLite>): SettlementLite {
  return {
    settlementId: "S-1",
    shop: "Shop A1",
    periodEnd: "2026-09-05",
    depositDate: "2026-09-08",
    total: 1000,
    currency: "USD",
    ...over,
  };
}

test("kỳ thanh toán: lấy kỳ mới nhất theo ngày kết thúc; chưa có ⇒ null", () => {
  assert.equal(latestSettlement([]), null);
  const list = [
    settle({ settlementId: "S-1", periodEnd: "2026-08-05" }),
    settle({ settlementId: "S-2", periodEnd: "2026-09-05" }),
    settle({ settlementId: "S-3", periodEnd: null }),
  ];
  assert.equal(latestSettlement(list)?.settlementId, "S-2");
});

test("ngày chi trả: chỉ nói ngày khi DB có ngày thật", () => {
  assert.equal(depositText(null), "chưa có kỳ thanh toán");
  assert.equal(depositText(settle({ depositDate: null })), "chưa có ngày chi trả");
  assert.match(depositText(settle({ depositDate: "2026-09-24T00:00:00Z" })), /24\/9\/2026|24\/09\/2026/);
});

test("ngày & kỳ: giá trị thiếu hiển thị '—' thay vì Invalid Date", () => {
  assert.equal(shortDate(null), "—");
  assert.equal(shortDate("không-phải-ngày"), "—");
  assert.equal(periodText(null, null), "—");
  // vi-VN không đệm 0 ở ngày/tháng ("1/8/2026") — chỉ cần đúng ngày, không phải định dạng ISO.
  assert.match(periodText("2026-08-01", "2026-08-31"), /^1\/8\/2026 → 31\/8\/2026$/);
});
