/**
 * Test model GIÁ VỐN `/finance/costs` (Đợt A — gỡ chặn F3/F4/P1).
 *
 * Thuần, không cần Supabase. Ba nhóm khoá:
 *   • parse template CSV — sai dòng nào báo đúng dòng đó, KHÔNG ghi nửa lô
 *   • ngày — nhận YYYY-MM-DD và DD/MM/YYYY, TỪ CHỐI MM/DD/YYYY mơ hồ
 *   • bậc thang hiệu lực — bậc đang áp dụng / sắp tới / đã hết, và độ phủ SKU
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COST_IMPORT_COLUMNS,
  COST_TEMPLATE_CSV,
  costTemplateFilename,
  formatImportResult,
  groupCostLadder,
  MAX_IMPORT_ROWS,
  parseCostAmount,
  parseCostDay,
  parseCostImportCsv,
  splitCsvLine,
  summarizeCostInputs,
  summarizeCoverage,
  validateCostForm,
  type CostCoverageRow,
  type CostInputRow,
} from "../src/lib/data/cost-model.ts";

const TODAY = "2026-09-12";

function input(partial: Partial<CostInputRow>): CostInputRow {
  return {
    id: partial.id ?? "c1",
    seller_account_id: partial.seller_account_id ?? "shop-a",
    shop: partial.shop ?? "Shop A",
    sku: partial.sku ?? "TG-LUG-20-BLK",
    unit_cost: partial.unit_cost ?? 41.5,
    currency: partial.currency ?? "USD",
    effective_from: partial.effective_from ?? "2026-09-01",
    effective_to: partial.effective_to ?? null,
    ...partial,
  };
}

function coverage(partial: Partial<CostCoverageRow>): CostCoverageRow {
  return {
    seller_account_id: partial.seller_account_id ?? "shop-a",
    shop: partial.shop ?? "Shop A",
    sku: partial.sku ?? "TG-LUG-20-BLK",
    currency: partial.currency ?? "USD",
    ...partial,
  };
}

/* ---------- số & ngày ---------- */

test("parseCostAmount: cùng một luật với worker/DB — không đoán bừa", () => {
  assert.equal(parseCostAmount("41.50"), 41.5);
  assert.equal(parseCostAmount("41,50"), 41.5);
  assert.equal(parseCostAmount("1.234,56"), 1234.56, "kiểu VN/EU");
  assert.equal(parseCostAmount("1,234.56"), 1234.56, "kiểu US");
  assert.equal(parseCostAmount("0"), 0, "giá vốn 0 là hợp lệ (hàng tặng/khuyến mãi)");
  assert.equal(parseCostAmount(""), null);
  assert.equal(parseCostAmount("abc"), null);
});

test("parseCostDay: nhận ISO + DD/MM/YYYY, từ chối ngày mơ hồ", () => {
  assert.deepEqual(parseCostDay("2026-09-01"), { value: "2026-09-01" });
  assert.deepEqual(parseCostDay("2026/9/1"), { value: "2026-09-01" }, "ISO thiếu số 0 vẫn đọc được");
  assert.deepEqual(parseCostDay("01/09/2026"), { value: "2026-09-01" }, "DD/MM/YYYY quy ước VN");
  assert.deepEqual(parseCostDay(""), { value: null }, "để trống = chưa kết thúc hiệu lực");
  // 13/25 rõ ràng là MM/DD → phải CHẶN, không tự đổi thành ngày khác
  assert.match(parseCostDay("25/13/2026").error ?? "", /tháng > 12/);
  assert.match(parseCostDay("09-12-2026").value ?? "", /^2026-12-09$/, "DD-MM-YYYY vẫn theo quy ước VN");
  assert.match(parseCostDay("12/31/2026").error ?? "", /tháng > 12/);
  assert.match(parseCostDay("01.09.2026").error ?? "", /sai định dạng/);
});

/* ---------- template CSV ---------- */

test("template CSV: có đủ cột bắt buộc + dòng ghi chú # để người nhập đọc luật", () => {
  const parsed = parseCostImportCsv(COST_TEMPLATE_CSV);
  assert.deepEqual(parsed.errors, [], `template phải parse sạch: ${JSON.stringify(parsed.errors)}`);
  assert.equal(parsed.rows.length, 4, "template có 4 dòng ví dụ");
  assert.equal(parsed.rows[0].sku, "TG-LUG-20-BLK");
  assert.equal(parsed.rows[0].effective_from, "2026-09-01");
  assert.equal(parsed.rows[0].effective_to, "", "bậc còn hiệu lực → để trống");
  assert.equal(parsed.rows[2].unit_cost, "1.234,56", "số kiểu local trong nháy kép phải giữ nguyên chuỗi cho DB parse");
  assert.equal(parsed.rows[2].currency, "VND");
  assert.ok(COST_TEMPLATE_CSV.includes("#"), "phải có dòng ghi chú");
  assert.match(costTemplateFilename(new Date("2026-09-12T00:00:00Z")), /^vexim-gia-von-template-2026-09-12\.csv$/);
});

test("splitCsvLine: tôn trọng nháy kép + nhận cả file lưu bằng dấu chấm phẩy", () => {
  assert.deepEqual(splitCsvLine('a,"b,c",d'), ["a", "b,c", "d"]);
  assert.deepEqual(splitCsvLine('a,"b""c"'), ["a", 'b"c'], "nháy kép đôi = nháy kép thật");
  assert.deepEqual(splitCsvLine("a;b;c"), ["a", "b", "c"], "Excel VN hay lưu bằng ;");
});

/* ---------- parse file import ---------- */

test("parseCostImportCsv: thiếu SKU / thiếu giá vốn / ngày sai → báo đúng số dòng, không ghi", () => {
  const csv = [
    COST_IMPORT_COLUMNS.join(","),
    "TG-A,10.00,USD,2026-09-01,,ok",
    ",10.00,USD,2026-09-01,,", // dòng 3: thiếu SKU
    "TG-B,,USD,2026-09-01,,", // dòng 4: thiếu giá vốn
    "TG-C,10.00,USD,25/13/2026,,", // dòng 5: tháng 13 — kiểu MM/DD/YYYY mơ hồ phải bị chặn
    "TG-D,-5,USD,2026-09-01,,", // dòng 6: giá vốn âm
    "TG-E,10.00,USD,2026-09-10,2026-09-01,,", // dòng 7: kết thúc trước bắt đầu
    "tg-f,10.00,usd,2026-09-01,,", // dòng 8: hợp lệ (SKU/tiền tệ được upper)
  ].join("\n");
  const parsed = parseCostImportCsv(csv);

  assert.deepEqual(parsed.errors.map((e) => e.line), [3, 4, 5, 6, 7]);
  assert.deepEqual(parsed.rows.map((r) => r.sku), ["TG-A", "TG-F"], "chỉ giữ dòng hợp lệ để xem trước");
  assert.match(parsed.errors[0].message, /thiếu SKU/);
  assert.match(parsed.errors[1].message, /thiếu giá vốn/);
  assert.match(parsed.errors[2].message, /tháng > 12/);
  assert.match(parsed.errors[3].message, /≥ 0/);
  assert.match(parsed.errors[4].message, /phải SAU/);
  assert.equal(parsed.skipped, 5);
});

test("parseCostImportCsv: header thiếu cột bắt buộc → chặn ngay dòng 1 (không đoán tên cột)", () => {
  const bad = parseCostImportCsv("sku,price\nTG-A,10\n");
  assert.equal(bad.rows.length, 0);
  assert.equal(bad.errors.length, 1);
  assert.equal(bad.errors[0].line, 1);
  assert.match(bad.errors[0].message, /thiếu cột bắt buộc/);

  // file rỗng / chỉ có ghi chú → không phải lỗi cú pháp, nhưng cũng không có gì để ghi
  assert.deepEqual(parseCostImportCsv("# chỉ có ghi chú\n").rows, []);
  assert.deepEqual(parseCostImportCsv("").rows, []);
  // header linh hoạt: chấp nhận tên ngắn quen dùng
  const alt = parseCostImportCsv("SKU,Cost,From\nTG-A,10.00,2026-09-01\n");
  assert.deepEqual(alt.errors, []);
  assert.equal(alt.rows[0].unit_cost, "10.00");
});

test("parseCostImportCsv: quá trần số dòng → yêu cầu chia nhỏ (RPC nhận jsonb)", () => {
  const head = COST_IMPORT_COLUMNS.join(",");
  const lines = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `S-${i},1.00,USD,2026-09-01,,`);
  const parsed = parseCostImportCsv([head, ...lines].join("\n"));
  assert.equal(parsed.rows.length, MAX_IMPORT_ROWS, "phải cắt đúng trần");
  assert.match(parsed.errors.at(-1)?.message ?? "", new RegExp(`tối đa ${MAX_IMPORT_ROWS}`));
});

/* ---------- form nhập tay ---------- */

test("validateCostForm: trả payload đúng tên tham số RPC 0016", () => {
  const ok = validateCostForm({
    sellerAccountId: "shop-a",
    sku: " tg-lug-20-blk ",
    unitCost: "43,20",
    currency: "usd",
    effectiveFrom: "2026-09-01",
    effectiveTo: "",
    note: "  Giá FOB lô T9  ",
  });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.deepEqual(ok.payload, {
    p_seller: "shop-a",
    p_sku: "TG-LUG-20-BLK",
    p_unit_cost: 43.2,
    p_currency: "USD",
    p_effective_from: "2026-09-01",
    p_effective_to: null,
    p_note: "Giá FOB lô T9",
  });
});

test("validateCostForm: chặn từng lỗi bằng tiếng Việt trước khi gọi RPC", () => {
  const base = {
    sellerAccountId: "shop-a",
    sku: "TG-A",
    unitCost: "10.00",
    currency: "USD",
    effectiveFrom: "2026-09-01",
    effectiveTo: "",
    note: "",
  };
  const msg = (over: Partial<typeof base>) => {
    const r = validateCostForm({ ...base, ...over });
    return r.ok ? "(không có lỗi)" : r.message;
  };
  assert.match(msg({ sellerAccountId: "" }), /Chưa chọn shop/);
  assert.match(msg({ sku: "  " }), /Thiếu SKU/);
  assert.match(msg({ sku: "X".repeat(41) }), /40 ký tự/);
  assert.match(msg({ unitCost: "" }), /Thiếu giá vốn/);
  assert.match(msg({ unitCost: "abc" }), /Không đọc được giá vốn/);
  assert.match(msg({ unitCost: "-1" }), /≥ 0/);
  assert.match(msg({ effectiveFrom: "" }), /Thiếu ngày hiệu lực/);
  assert.match(msg({ effectiveFrom: "25/13/2026" }), /tháng > 12/);
  // 31/12 là ngày HỢP LỆ theo quy ước DD/MM — không được bắt lỗi oan
  assert.equal(validateCostForm({ ...base, effectiveFrom: "31/12/2026" }).ok, true);
  assert.match(msg({ effectiveTo: "2026-08-01" }), /phải SAU ngày hiệu lực/);
  // ngày kết thúc hợp lệ → payload có effective_to
  const withTo = validateCostForm({ ...base, effectiveTo: "2026-12-31" });
  assert.equal(withTo.ok && withTo.payload.p_effective_to, "2026-12-31");
});

/* ---------- bậc thang hiệu lực ---------- */

test("summarizeCostInputs: đếm đúng bậc đang áp dụng / sắp tới / đã hết", () => {
  const rows = [
    input({ id: "1", sku: "A", effective_from: "2026-07-01", effective_to: "2026-09-01" }), // hết
    input({ id: "2", sku: "A", effective_from: "2026-09-01", effective_to: null, is_current: true }), // đang
    input({ id: "3", sku: "A", effective_from: "2026-10-01", effective_to: null }), // sắp tới
    input({ id: "4", sku: "B", seller_account_id: "shop-b", shop: "Shop B", effective_from: "2026-09-05" }),
  ];
  const s = summarizeCostInputs(rows, TODAY);
  assert.equal(s.total, 4);
  assert.equal(s.current, 2);
  assert.equal(s.upcoming, 1);
  assert.equal(s.expired, 1);
  assert.equal(s.skus, 2, "đếm SKU theo (shop, sku): A@shop-a + B@shop-b");
  assert.equal(s.shops, 2);
  assert.equal(s.coveredSkus, 2);
});

test("summarizeCostInputs: không có cột is_current thì tự tính theo khoảng ngày", () => {
  const rows = [
    input({ id: "1", sku: "A", effective_from: "2026-09-01", effective_to: "2026-09-12" }), // kết thúc ĐÚNG hôm nay → hết
    input({ id: "2", sku: "B", effective_from: "2026-09-12", effective_to: null }), // bắt đầu hôm nay → đang
  ];
  const s = summarizeCostInputs(rows, TODAY);
  assert.equal(s.current, 1);
  assert.equal(s.expired, 1, "effective_to là ngày KHÔNG còn hiệu lực (nửa mở)");
});

test("summarizeCoverage: SKU thiếu giá vốn / lệch tiền tệ là thứ đang chặn F3/F4/P1", () => {
  const rows = [
    coverage({ sku: "OK", unit_cost: 10, cost_currency: "USD", currency: "USD", missing_cost: false, currency_mismatch: false }),
    coverage({ sku: "MISS", unit_cost: null, missing_cost: true, currency_mismatch: false }),
    coverage({ sku: "FX", unit_cost: 3, cost_currency: "CNY", currency: "EUR", missing_cost: false, currency_mismatch: true }),
  ];
  const s = summarizeCoverage(rows);
  assert.deepEqual({ ...s, coveragePct: Number(s.coveragePct?.toFixed(3)) }, {
    total: 3,
    covered: 1,
    missing: 1,
    mismatch: 1,
    coveragePct: 0.333,
  });
  assert.equal(summarizeCoverage([]).coveragePct, null, "không có SKU → không hiện 0% giả");
  // không có cột view thì tự suy từ dữ liệu thô (demo mode)
  const fallback = summarizeCoverage([coverage({ sku: "X", unit_cost: null })]);
  assert.equal(fallback.missing, 1);
});

test("groupCostLadder: sắp bậc theo thời gian, chỉ ra bậc đang áp dụng và bậc kế tiếp", () => {
  const rows = [
    input({ id: "3", sku: "A", effective_from: "2026-10-01" }),
    input({ id: "1", sku: "A", effective_from: "2026-07-01", effective_to: "2026-09-01" }),
    input({ id: "2", sku: "A", effective_from: "2026-09-01" }),
    input({ id: "9", sku: "B", seller_account_id: "shop-b", shop: "Shop B", effective_from: "2026-08-01" }),
  ];
  const ladder = groupCostLadder(rows, TODAY);
  assert.equal(ladder.length, 2);
  assert.deepEqual(ladder.map((g) => g.sku), ["A", "B"]);
  assert.deepEqual(ladder[0].steps.map((s) => s.id), ["1", "2", "3"], "sắp theo effective_from tăng dần");
  assert.equal(ladder[0].current?.id, "2");
  assert.equal(ladder[0].next?.id, "3", "bậc kế tiếp để cảnh báo giá sắp đổi");
  assert.equal(ladder[1].next, null);
});

test("formatImportResult: nói rõ đã ghi gì — kể cả bậc cũ bị cắt ngọn", () => {
  assert.equal(
    formatImportResult({ ok: true, rows: 12, inserted: 10, updated: 2, closed_previous: 3, superseded: 1 }),
    "Đã ghi 12 dòng · 10 bậc mới · 2 bậc cập nhật · 3 bậc cũ đã cắt ngọn · 1 bậc bị thay.",
  );
  assert.equal(formatImportResult({ ok: false }), "Không ghi dòng nào — xem lỗi bên dưới.");
  assert.equal(formatImportResult({ ok: true, rows: 0 }), "Đã ghi 0 dòng.");
});
