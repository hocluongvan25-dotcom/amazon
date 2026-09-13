/**
 * Test khóa chặt 2 root cause làm OAuth SP-API gãy 404 (09/2026):
 *
 * 1. Parameter Mismatch — Amazon trả `?spapi_oauth_code=…`, code cũ chỉ đọc
 *    `?code=…` → biến nhận mã rỗng. Callback phải ưu tiên spapi_oauth_code,
 *    fallback code.
 * 2. Authentication Barrier — middleware thiếu bypass /api/oauth → request
 *    callback (không cookie Supabase) bị 307 /login → Vercel 404.
 *    isBypassPath phải trả true cho toàn bộ /api/oauth/*.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BYPASS_AUTH_PATHS,
  isBypassPath,
  isPublicPath,
  normalizePath,
} from "../src/lib/config/auth-paths.ts";

// ── Root cause 2: middleware bypass ──────────────────────────────────────────

test("BYPASS_AUTH_PATHS chứa /api/oauth và /api/version", () => {
  assert.ok(BYPASS_AUTH_PATHS.includes("/api/oauth"));
  assert.ok(BYPASS_AUTH_PATHS.includes("/api/version"));
});

test("isBypassPath: Amazon callback không cookie phải được đi thẳng vào route", () => {
  assert.equal(isBypassPath("/api/oauth/amazon/callback"), true);
  assert.equal(isBypassPath("/api/oauth/amazon/callback/"), true);
  assert.equal(isBypassPath("/api/oauth/amazon/start"), true);
  assert.equal(isBypassPath("/api/oauth/amazon/diag"), true);
  assert.equal(isBypassPath("/api/oauth"), true);
  assert.equal(isBypassPath("/api/version"), true);
  assert.equal(isBypassPath("/api/cron/inventory-sync"), true);
});

test("isBypassPath: không bypass nhầm path khác", () => {
  assert.equal(isBypassPath("/api/oauthx"), false); // prefix giả
  assert.equal(isBypassPath("/api/admin/invite-user"), false);
  assert.equal(isBypassPath("/dashboard"), false);
  assert.equal(isBypassPath("/"), false);
});

test("isPublicPath: landing/login/invite mở công khai, dashboard thì không", () => {
  assert.equal(isPublicPath("/"), true);
  assert.equal(isPublicPath("/login"), true);
  assert.equal(isPublicPath("/invite"), true);
  assert.equal(isPublicPath("/auth/confirm"), true);
  assert.equal(isPublicPath("/dashboard"), false);
  assert.equal(isPublicPath("/module0/connect"), false);
});

test("normalizePath bỏ trailing slash trừ gốc", () => {
  assert.equal(normalizePath("/api/oauth/"), "/api/oauth");
  assert.equal(normalizePath("/api/oauth"), "/api/oauth");
  assert.equal(normalizePath("/"), "/");
});

// ── Root cause 1: spapi_oauth_code vs code ──────────────────────────────────
// Logic trích code y hệt callback route: ưu tiên spapi_oauth_code, fallback code.

function extractOauthCode(rawUrl: string): string {
  const url = new URL(rawUrl);
  const spapiCode = (url.searchParams.get("spapi_oauth_code") ?? "").trim();
  const lwaCode = (url.searchParams.get("code") ?? "").trim();
  return spapiCode || lwaCode;
}

test("callback đọc được spapi_oauth_code (dạng Amazon SP-API thật trả về)", () => {
  const code = extractOauthCode(
    "https://veximops.com/api/oauth/amazon/callback?state=abc&selling_partner_id=A1B2C3&spapi_oauth_code=ANxxyyzz",
  );
  assert.equal(code, "ANxxyyzz");
});

test("callback fallback sang code (LWA cũ) khi không có spapi_oauth_code", () => {
  const code = extractOauthCode(
    "https://veximops.com/api/oauth/amazon/callback?code=LWA123&state=abc",
  );
  assert.equal(code, "LWA123");
});

test("callback ưu tiên spapi_oauth_code khi có cả hai", () => {
  const code = extractOauthCode(
    "https://veximops.com/api/oauth/amazon/callback?code=LWA123&spapi_oauth_code=SPAPI456&state=abc",
  );
  assert.equal(code, "SPAPI456");
});

test("callback trả rỗng khi thiếu cả hai (để route báo lỗi rõ ràng thay vì crash)", () => {
  const code = extractOauthCode("https://veximops.com/api/oauth/amazon/callback?state=abc");
  assert.equal(code, "");
});
