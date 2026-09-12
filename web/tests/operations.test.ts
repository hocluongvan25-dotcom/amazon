import { test } from "node:test";
import assert from "node:assert/strict";
import {
  breakdownRows,
  deadline,
  filterRows,
  money,
  numeric,
  reconciliation,
  screens,
  totals,
  validId,
  type DataRow,
} from "../src/lib/data/operations-model.ts";

test("numeric null/empty/invalid remain unknown; zero and negative survive", () => {
  for (const v of [null, undefined, "", " ", {}, NaN, "bad"])
    assert.equal(numeric(v), null);
  assert.equal(numeric("0"), 0);
  assert.equal(numeric("-12.34"), -12.34);
  assert.equal(money(null, "USD"), "—");
  assert.match(money(0, "JPY"), /0 JPY/);
});
test("money totals separate currencies and flag incomplete records", () => {
  const rows = [
    { id: "a", amount: 10, currency: "USD" },
    { id: "b", amount: -2, currency: "USD" },
    { id: "c", amount: 100, currency: "JPY" },
    { id: "d", amount: null, currency: "USD" },
  ];
  assert.deepEqual(totals(rows, "amount"), [
    { currency: "USD", total: 8, missing: 1 },
    { currency: "JPY", total: 100, missing: 0 },
  ]);
  assert.deepEqual(
    totals(
      [
        ...rows,
        { id: "e", amount: 500, currency: "USD", event_type: "Transfer" },
      ],
      "amount",
      true,
    ),
    totals(rows, "amount"),
  );
});
test("FBM prefers Amazon deadline and explicitly labels estimate, unknown and overdue", () => {
  const now = Date.parse("2026-09-12T00:00:00Z");
  const row: DataRow = {
    id: "1",
    purchase_date: "2026-09-10T00:00:00Z",
    latest_ship_date: "2026-09-12T06:00:00Z",
  };
  assert.equal(deadline(row, now).deadlineSource, "Amazon");
  assert.equal(deadline(row, now).countdown, "6.0 giờ");
  assert.match(
    String(deadline({ ...row, latest_ship_date: null }, now).deadlineSource),
    /Ước lượng/,
  );
  assert.match(
    String(deadline({ ...row, latest_ship_date: null }, now).countdown),
    /Quá hạn 24.0/,
  );
  assert.equal(deadline({ id: "missing" }, now).deadline, null);
});
test("nullable diff is not proof of reconciliation", () => {
  assert.match(reconciliation({ id: "1", reconcile_diff: null }), /Chưa/);
  assert.match(
    reconciliation({
      id: "1",
      reconciled_at: "today",
      reconcile_diff: null,
      breakdown: { transferSource: "none" },
    }),
    /Chưa/,
  );
  assert.match(
    reconciliation({ id: "1", reconciled_at: "today", reconcile_diff: 0 }),
    /dung sai/,
  );
  assert.match(
    reconciliation({ id: "1", reconciled_at: "today", reconcile_diff: -2 }),
    /chênh lệch/,
  );
});
test("filters use shop UUID, combine search/status/type without name collisions", () => {
  const rows = [
    {
      id: "1",
      shop: "Same",
      seller_account_id: "a",
      sku: "ABC",
      status: "open",
      event_type: "Refund",
    },
    {
      id: "2",
      shop: "Same",
      seller_account_id: "b",
      sku: "ABC",
      status: "open",
      event_type: "Refund",
    },
  ];
  assert.deepEqual(
    filterRows(rows, {
      q: "abc",
      shop: "a",
      status: "open",
      type: "Refund",
    }).map((r) => r.id),
    ["1"],
  );
  assert.equal(
    filterRows(rows, { q: "absent", shop: "", status: "", type: "" }).length,
    0,
  );
});
test("breakdown handles malformed JSON without rendering arbitrary fields", () => {
  for (const v of [null, {}, { groups: {} }])
    assert.deepEqual(breakdownRows(v), []);
  assert.deepEqual(
    breakdownRows({
      groups: [{ label: "Fees", amount: -12, private: "secret" }, null],
    }),
    [{ id: "0", label: "Fees", amount: -12 }],
  );
});
test("details require internal UUID; all public projections exclude buyer PII/raw", () => {
  assert.equal(validId("12948510001"), false);
  assert.equal(validId(undefined), false);
  assert.equal(validId("cccc0000-0000-4000-8000-000000000001"), true);
  for (const s of Object.values(screens)) {
    assert.match(s.view, /^vexim_/);
    assert.doesNotMatch(
      s.select,
      /buyer_|ship_address|ship_city|postal|raw|\*/,
    );
  }
});
