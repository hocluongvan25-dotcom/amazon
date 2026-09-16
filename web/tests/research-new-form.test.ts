/**
 * Module 8 G1 — test thuần cho trạng thái form tách 2 trang
 * (/research/new → /research/new/phan-tich): gom lỗi theo thẻ mục và hành vi
 * lưu/đọc nháp khi KHÔNG có sessionStorage (môi trường node/test).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULTS,
  DRAFT_KEY,
  clearDraft,
  errorsBySection,
  loadDraft,
  saveDraft,
} from "../src/lib/research/new-form.ts";

test("DEFAULTS hợp lệ → không lỗi ở bất kỳ thẻ mục nào", () => {
  const { errors, bySection } = errorsBySection(DEFAULTS);
  assert.deepEqual(errors, []);
  assert.deepEqual(bySection.nganh, []);
  assert.deepEqual(bySection.gia, []);
  assert.deepEqual(bySection.donggoi, []);
  assert.deepEqual(bySection.velocity, []);
});

test("thiếu tên/từ khóa → lỗi gom về thẻ 'nganh'", () => {
  const { errors, bySection } = errorsBySection({ ...DEFAULTS, title: "", keywords: "" });
  assert.ok(errors.length >= 2);
  assert.equal(bySection.nganh.length, 2);
  assert.deepEqual(bySection.gia, []);
  assert.deepEqual(bySection.donggoi, []);
});

test("giá kịch bản bằng 0 → lỗi gom về thẻ 'gia'; vốn âm cũng về 'gia'", () => {
  const r1 = errorsBySection({ ...DEFAULTS, priceBase: "0" });
  assert.ok(r1.bySection.gia.some((m) => m.includes("cơ sở") || m.includes("base")));
  assert.deepEqual(r1.bySection.nganh, []);

  const r2 = errorsBySection({ ...DEFAULTS, cogsPerUnit: "-1" });
  assert.ok(r2.bySection.gia.some((m) => m.includes("Giá vốn")));
});

test("thiếu kích thước đóng gói → lỗi gom về thẻ 'donggoi'", () => {
  const { bySection } = errorsBySection({ ...DEFAULTS, weightLb: "" });
  assert.ok(bySection.donggoi.some((m) => m.includes("Kích thước")));
  assert.deepEqual(bySection.gia, []);
});

test("referral ngoài khoảng (0,1) vẫn bị chặn ở thẻ 'gia'", () => {
  const { errors, bySection } = errorsBySection({ ...DEFAULTS, referralRate: "150" });
  assert.ok(errors.some((m) => m.includes("referral")));
  assert.ok(bySection.gia.length >= 1);
});

test("nháp sessionStorage: ngoài trình duyệt các hàm no-op an toàn", () => {
  assert.equal(typeof globalThis.window, "undefined");
  assert.doesNotThrow(() => saveDraft(DEFAULTS));
  assert.doesNotThrow(() => clearDraft());
  assert.equal(loadDraft(), null);
  assert.match(DRAFT_KEY, /^vexim:research-draft/);
});
