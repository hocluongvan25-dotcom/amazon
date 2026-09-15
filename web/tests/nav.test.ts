/**
 * Test MENU TRÁI (2 lỗi Ops báo trước khi bàn giao):
 *
 *   1. Ở `/ppc/search-terms` thì CẢ "Quảng cáo (PPC)" lẫn "Search term & chặn (A3)"
 *      cùng sáng cam, vì logic cũ `pathname.startsWith(href + "/")` coi mục cha là
 *      khớp. Test này khoá luật mới: so khớp theo BIÊN ĐOẠN rồi chọn href KHỚP DÀI
 *      NHẤT ⇒ mỗi lúc chỉ MỘT mục sáng, và kiểm cho TOÀN BỘ menu (không chỉ /ppc).
 *   2. Số đỏ cạnh menu trước đây là số mock cứng trong `roles.ts`. Test khoá: NAV
 *      KHÔNG còn trường `count`, và badge chỉ hiện khi có số thật > 0.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activeHrefFor,
  badgeOf,
  isNavActive,
  navFor,
  NAV,
  type PersonaKey,
} from "../src/lib/roles.ts";

/** Mọi href CÓ trong menu của 4 persona (dùng để kiểm "chỉ 1 mục sáng"). */
const ALL_HREFS: string[] = [...new Set(NAV.flatMap((g) => g.items.map((it) => it.href)))];

function activeCount(pathname: string, persona: PersonaKey = "ceo"): number {
  const hrefs = navFor(persona).flatMap((g) => g.items.map((it) => it.href));
  return hrefs.filter((h) => h === activeHrefFor(hrefs, pathname)).length;
}

test("menu: mục con thắng mục cha — /ppc/search-terms CHỈ sáng A3 (lỗi Ops báo)", () => {
  assert.equal(activeHrefFor(ALL_HREFS, "/ppc/search-terms"), "/ppc/search-terms");
  assert.equal(activeHrefFor(ALL_HREFS, "/ppc/approvals"), "/ppc/approvals");
  assert.equal(activeHrefFor(ALL_HREFS, "/ppc"), "/ppc");
  // Trang con KHÔNG có trong menu ⇒ sáng mục cha gần nhất (không phải không sáng gì)
  assert.equal(activeHrefFor(ALL_HREFS, "/ppc/campaigns/C-DEMO-01"), "/ppc");
});

test("menu: cùng nhóm cha/con khác đều đúng (kiểm TOÀN BỘ menu, không chỉ /ppc)", () => {
  const EXPECTED: [string, string][] = [
    ["/dashboard", "/dashboard"],
    ["/health", "/health"],
    ["/health/violations", "/health"],
    ["/listing", "/listing"],
    ["/listing/editor", "/listing/editor"],
    ["/listing/list", "/listing"],
    ["/listing/queue", "/listing"],
    ["/pricing", "/pricing"],
    ["/pricing/approve", "/pricing"],
    ["/pricing/detail?sku=X", "/pricing"],
    ["/ppc", "/ppc"],
    ["/ppc/search-terms", "/ppc/search-terms"],
    ["/ppc/approvals", "/ppc/approvals"],
    ["/ppc/campaigns/C-1", "/ppc"],
    ["/fulfillment", "/fulfillment"],
    ["/fulfillment/inbound", "/fulfillment"],
    ["/orders", "/orders"],
    ["/orders/fbm", "/orders"],
    ["/orders/returns", "/orders"],
    ["/finance", "/finance"],
    ["/finance/claims", "/finance/claims"],
    ["/finance/costs", "/finance/costs"],
    ["/finance/profit", "/finance/profit"],
    ["/finance/settlements", "/finance"],
    ["/research", "/research"],
    ["/research/new", "/research"],
    ["/research/PR-202609-0001", "/research"],
    ["/client", "/client"],
    ["/module0/connect", "/module0/connect"],
    ["/module0/sync-health", "/module0/sync-health"],
    ["/module0/api-usage", "/module0/api-usage"],
    ["/module0/audit-log", "/module0/audit-log"],
    ["/module0/users", "/module0/users"],
    ["/module0/users/new", "/module0/users"],
    ["/profile", "/profile"],
  ];
  for (const [pathname, href] of EXPECTED) {
    assert.equal(activeHrefFor(ALL_HREFS, pathname), href, `sai mục sáng cho ${pathname}`);
  }
});

test("menu: mỗi đường dẫn CHỈ sáng đúng 1 mục, với cả 4 vai trò", () => {
  const paths = ALL_HREFS.concat([
    "/ppc/search-terms",
    "/ppc/approvals",
    "/ppc/campaigns/C-DEMO-01",
    "/finance/settlements/detail",
    "/orders/detail",
  ]);
  for (const persona of ["ceo", "op_ppc", "lead_fulfill", "client"] as PersonaKey[]) {
    for (const p of paths) {
      assert.ok(activeCount(p, persona) <= 1, `${persona} · ${p} sáng nhiều hơn 1 mục`);
    }
  }
});

test("menu: khớp theo BIÊN ĐOẠN — /ppcx KHÔNG được tính là /ppc", () => {
  assert.equal(isNavActive("/ppc", "/ppc"), true);
  assert.equal(isNavActive("/ppc/", "/ppc"), true);
  assert.equal(isNavActive("/ppc/search-terms", "/ppc"), true);
  assert.equal(isNavActive("/ppcx", "/ppc"), false);
  assert.equal(isNavActive("/ppc-old/x", "/ppc"), false);
  assert.equal(isNavActive("/finance/claims", "/finance/claim"), false);
  // Query string / hash không làm mất trạng thái sáng
  assert.equal(isNavActive("/ppc?shop=1", "/ppc"), true);
  assert.equal(isNavActive("/ppc/search-terms?q=vali#top", "/ppc/search-terms"), true);
  assert.equal(isNavActive("", "/ppc"), false);
});

test("badge: NAV KHÔNG còn số mock, và badge chỉ hiện khi có số THẬT > 0", () => {
  for (const g of NAV) {
    for (const it of g.items) {
      assert.equal(
        Object.hasOwn(it, "count"),
        false,
        `${it.href} vẫn còn trường count (số mock) — badge phải lấy từ readNavBadges()`,
      );
    }
  }
  // Có query thật ⇒ hiện; chưa nối hoặc 0 ⇒ ẨN (thà trống còn hơn số sai)
  assert.equal(badgeOf({ "/ppc": 3 }, "/ppc"), 3);
  assert.equal(badgeOf({ "/ppc": 3 }, "/ppc/search-terms"), null);
  assert.equal(badgeOf({ "/ppc": 0 }, "/ppc"), null);
  assert.equal(badgeOf({}, "/ppc"), null);
  assert.equal(badgeOf(undefined, "/ppc"), null);
  assert.equal(badgeOf({ "/ppc": Number.NaN }, "/ppc"), null);
  assert.equal(badgeOf({ "/ppc": 2.7 }, "/ppc"), 2);
});
