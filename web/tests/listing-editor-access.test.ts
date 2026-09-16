/**
 * Test Module 1 — bộ chọn shop + quyền ghi của trình soạn listing.
 *
 * Khoá 2 lỗi thật gặp ngày 16/09/2026 trên /listing/editor:
 *   1. "Không thấy shop nào dù đã kết nối shop": bộ chọn shop từng đọc từ
 *      `vexim_listings` (chỉ có shop ĐÃ ĐỒNG BỘ listing) ⇒ shop vừa kết nối biến
 *      mất. Nay đọc từ `vexim_shops` ⇒ shop mới tinh (paused) vẫn chọn được,
 *      chỉ shop `revoked` (demo/đã gỡ) bị ẩn.
 *   2. "Nhấn vào không cho nhập liệu": UI chỉ coi `iam.assignments.can_write` là
 *      có quyền, bỏ sót `super_admin` ⇒ super_admin không có dòng assignment cho
 *      shop mới kết nối bị khoá cứng cả form dù DB (`iam.can_write_seller_account`)
 *      vẫn cho ghi. `resolveEditorAccess` mirror đúng luật DB đó.
 *
 * Thuần — không cần Supabase, không cần Next.js.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeShopOptions,
  resolveEditorAccess,
  shopOptionLabel,
} from "../src/lib/listing/editor-access.ts";

/* ------------------------------------------------------------------ */
/* 1. Bộ chọn shop                                                     */
/* ------------------------------------------------------------------ */

test("bộ chọn shop: đọc từ vexim_shops nên shop MỚI KẾT NỐI (chưa có listing) vẫn hiện", () => {
  const shops = normalizeShopOptions([
    { seller_account_id: "s1", shop: "VEXIM US - Chính", status: "active", store_name: "Vexim Global" },
    // shop vừa thêm bằng [+ Thêm shop mới]: chưa authorize, chưa có listing nào
    { seller_account_id: "s2", shop: "Shop khách test - US", status: "paused", store_name: null },
  ]);
  assert.equal(shops.length, 2);
  assert.deepEqual(
    shops.map((s) => s.sellerAccountId),
    ["s2", "s1"], // xếp theo nhãn: "Shop khách test - US" < "VEXIM US - Chính"
  );
});

test("bộ chọn shop: ẨN shop demo/đã gỡ (revoked), không ẩn shop paused", () => {
  const shops = normalizeShopOptions([
    { seller_account_id: "A1", shop: "A1 · US", status: "revoked" },
    { seller_account_id: "B1", shop: "B1 · CA", status: "revoked" },
    { seller_account_id: "P1", shop: "P1 · US", status: "active" },
    { seller_account_id: "P9", shop: "Shop mới", status: "paused" },
  ]);
  assert.deepEqual(shops.map((s) => s.sellerAccountId), ["P1", "P9"]);
});

test("bộ chọn shop: gộp trùng theo seller_account_id, nhãn fallback display_name rồi id", () => {
  const shops = normalizeShopOptions([
    { seller_account_id: "s1", shop: "  ", display_name: "Nhãn vận hành", status: "active" },
    { seller_account_id: "s1", shop: "VEXIM US - Chính", status: "active" },
    { seller_account_id: "s2", shop: "", display_name: null, status: "active" },
    { seller_account_id: "", shop: "rác", status: "active" },
  ]);
  // sắp theo nhãn kiểu tiếng Việt (không phân biệt hoa/thường): "s2" < "VEXIM…"
  assert.deepEqual(shops, [
    { sellerAccountId: "s2", shop: "s2", storeName: null }, // không có nhãn ⇒ dùng id, không hiện dòng trắng
    { sellerAccountId: "s1", shop: "VEXIM US - Chính", storeName: null },
  ]);
});

test("bộ chọn shop: chưa chạy 0031 (không có cột store_name) vẫn chuẩn hoá được", () => {
  const shops = normalizeShopOptions([{ seller_account_id: "s1", shop: "P1 · US", status: "active" }]);
  assert.deepEqual(shops, [{ sellerAccountId: "s1", shop: "P1 · US", storeName: null }]);
});

test("nhãn shop: ghép tên Amazon khi khác nhãn vận hành, tránh lặp khi trùng nhau", () => {
  assert.equal(
    shopOptionLabel({ shop: "VEXIM US - Chính", storeName: "Vexim Global" }),
    "VEXIM US - Chính · 🏪 Vexim Global",
  );
  assert.equal(shopOptionLabel({ shop: "Vexim Global", storeName: "vexim global" }), "Vexim Global");
  assert.equal(shopOptionLabel({ shop: "P1 · US", storeName: null }), "P1 · US");
});

/* ------------------------------------------------------------------ */
/* 2. Quyền ghi — mirror iam.can_write_seller_account()                */
/* ------------------------------------------------------------------ */

test("quyền ghi: super_admin ghi được MỌI shop dù không có dòng assignment (lỗi form khoá cứng)", () => {
  const access = resolveEditorAccess({
    profileStatus: "active",
    roles: [{ role: "super_admin", department_id: null }],
    assignments: [], // shop mới kết nối → chưa có assignment nào
    listingDepartmentId: null,
  });
  assert.deepEqual(access, { canWrite: true, isApprover: true });
});

test("quyền ghi: người thường không có assignment ⇒ chỉ đọc (khớp RLS)", () => {
  assert.deepEqual(
    resolveEditorAccess({ profileStatus: "active", roles: [{ role: "operator", department_id: null }], assignments: [] }),
    { canWrite: false, isApprover: false },
  );
});

test("quyền ghi: assignment can_write=true là đủ để ghi (không cần vai trò)", () => {
  assert.deepEqual(
    resolveEditorAccess({
      profileStatus: "active",
      roles: [{ role: "operator", department_id: "listing" }],
      assignments: [{ can_write: true }],
    }),
    { canWrite: true, isApprover: false },
  );
  assert.equal(
    resolveEditorAccess({ profileStatus: "active", roles: [], assignments: [{ can_write: false }] }).canWrite,
    false,
  );
});

test("quyền ghi: tài khoản bị khoá (suspended) mất quyền THẬT, kể cả super_admin", () => {
  assert.deepEqual(
    resolveEditorAccess({
      profileStatus: "suspended",
      roles: [{ role: "super_admin", department_id: null }],
      assignments: [{ can_write: true }],
    }),
    { canWrite: false, isApprover: false },
  );
});

test("quyền duyệt: org_admin duyệt được nhưng KHÔNG tự có quyền ghi shop", () => {
  assert.deepEqual(
    resolveEditorAccess({ profileStatus: "active", roles: [{ role: "org_admin", department_id: null }], assignments: [] }),
    { canWrite: false, isApprover: true },
  );
});

test("quyền duyệt: chỉ dept_lead PHÒNG LISTING mới duyệt; thiếu id phòng ban ⇒ không tính", () => {
  const listingLead = { role: "dept_lead", department_id: "dept-listing" };
  const financeLead = { role: "dept_lead", department_id: "dept-finance" };
  assert.equal(
    resolveEditorAccess({
      profileStatus: "active",
      roles: [listingLead],
      assignments: [],
      listingDepartmentId: "dept-listing",
    }).isApprover,
    true,
  );
  assert.equal(
    resolveEditorAccess({
      profileStatus: "active",
      roles: [financeLead],
      assignments: [],
      listingDepartmentId: "dept-listing",
    }).isApprover,
    false,
  );
  assert.equal(
    resolveEditorAccess({ profileStatus: "active", roles: [listingLead], assignments: [], listingDepartmentId: null })
      .isApprover,
    false,
  );
});
