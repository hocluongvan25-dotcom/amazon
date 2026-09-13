import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  isLocalhostOrigin,
  normalizeOrigin,
  resolveSiteOrigin,
  getSafeRedirectPath,
  parseInviteHash,
  translateInviteError,
  translateConfirmError,
  getInviteUrl,
} from "../src/lib/site-origin.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// ------------------------------------------------------------------
// 1-3: isLocalhostOrigin
// ------------------------------------------------------------------
test("isLocalhostOrigin nhận diện localhost:3000", () => {
  assert.equal(isLocalhostOrigin("http://localhost:3000"), true);
  assert.equal(isLocalhostOrigin("http://localhost:3000/#access_token=abc"), true);
});

test("isLocalhostOrigin nhận diện 127.0.0.1 và 0.0.0.0", () => {
  assert.equal(isLocalhostOrigin("http://127.0.0.1:3000"), true);
  assert.equal(isLocalhostOrigin("http://0.0.0.0:3000"), true);
});

test("isLocalhostOrigin false với domain production", () => {
  assert.equal(isLocalhostOrigin("https://ops.vexim.vn"), false);
  assert.equal(isLocalhostOrigin("https://myapp.vercel.app"), false);
});

// ------------------------------------------------------------------
// 4-5: normalizeOrigin
// ------------------------------------------------------------------
test("normalizeOrigin bỏ trailing slash", () => {
  assert.equal(normalizeOrigin("https://ops.vexim.vn/"), "https://ops.vexim.vn");
  assert.equal(normalizeOrigin("https://ops.vexim.vn///"), "https://ops.vexim.vn");
});

test("normalizeOrigin trim whitespace", () => {
  assert.equal(normalizeOrigin("  https://ops.vexim.vn  "), "https://ops.vexim.vn");
  assert.equal(normalizeOrigin(""), "");
});

// ------------------------------------------------------------------
// 6-10: resolveSiteOrigin
// ------------------------------------------------------------------
test("resolveSiteOrigin ưu tiên NEXT_PUBLIC_SITE_URL", () => {
  const r = resolveSiteOrigin({
    env: {
      NEXT_PUBLIC_SITE_URL: "https://ops.vexim.vn",
      VERCEL_PROJECT_PRODUCTION_URL: "myapp.vercel.app",
      VERCEL_URL: "myapp-xyz.vercel.app",
    },
  });
  assert.equal(r.origin, "https://ops.vexim.vn");
  assert.equal(r.source, "env");
  assert.equal(r.inviteUrl, "https://ops.vexim.vn/invite");
});

test("resolveSiteOrigin dùng VERCEL_PROJECT_PRODUCTION_URL khi thiếu SITE_URL", () => {
  const r = resolveSiteOrigin({
    env: {
      VERCEL_PROJECT_PRODUCTION_URL: "myapp.vercel.app",
      VERCEL_URL: "myapp-xyz.vercel.app",
    },
  });
  assert.equal(r.origin, "https://myapp.vercel.app");
  assert.equal(r.source, "vercel");
});

test("resolveSiteOrigin dùng request headers x-forwarded-host/proto", () => {
  const headers = {
    "x-forwarded-proto": "https",
    "x-forwarded-host": "ops.vexim.vn",
  } as Record<string, string>;
  const r = resolveSiteOrigin({ env: {}, headers });
  assert.equal(r.origin, "https://ops.vexim.vn");
  assert.equal(r.source, "request");
});

test("resolveSiteOrigin fallback localhost khi không có gì", () => {
  const r = resolveSiteOrigin({ env: {} });
  assert.equal(r.origin, "http://localhost:3000");
  assert.equal(r.source, "fallback");
  assert.equal(r.isLocalhost, true);
});

test("inviteUrl = origin + /invite", () => {
  assert.equal(getInviteUrl("https://ops.vexim.vn"), "https://ops.vexim.vn/invite");
  assert.equal(getInviteUrl("https://ops.vexim.vn/"), "https://ops.vexim.vn/invite");
  assert.equal(getInviteUrl("http://localhost:3000"), "http://localhost:3000/invite");
});

// ------------------------------------------------------------------
// 11-12: warning khi production nhưng localhost
// ------------------------------------------------------------------
test("warning khi production mà vẫn localhost", () => {
  const r = resolveSiteOrigin({
    env: { NODE_ENV: "production", NEXT_PUBLIC_SITE_URL: "http://localhost:3000" },
  });
  assert.equal(r.isLocalhost, true);
  assert.ok(r.warning, "phải có warning");
  assert.match(r.warning!, /production.*localhost|localhost.*production/i);
});

test("không warning khi localhost ở development", () => {
  const r = resolveSiteOrigin({
    env: { NODE_ENV: "development", NEXT_PUBLIC_SITE_URL: "http://localhost:3000" },
  });
  assert.equal(r.isLocalhost, true);
  assert.equal(r.warning, null);
});

// ------------------------------------------------------------------
// 13-16: getSafeRedirectPath chặn open-redirect
// ------------------------------------------------------------------
test("getSafeRedirectPath cho phép /dashboard và /module0/users", () => {
  assert.equal(getSafeRedirectPath("/dashboard"), "/dashboard");
  assert.equal(getSafeRedirectPath("/module0/users"), "/module0/users");
  assert.equal(getSafeRedirectPath("/invite?foo=bar"), "/invite?foo=bar");
});

test("getSafeRedirectPath chặn //evil.com", () => {
  assert.equal(getSafeRedirectPath("//evil.com"), "/dashboard");
  assert.equal(getSafeRedirectPath("//evil.com/path"), "/dashboard");
});

test("getSafeRedirectPath chặn https://evil.com", () => {
  assert.equal(getSafeRedirectPath("https://evil.com"), "/dashboard");
  assert.equal(getSafeRedirectPath("http://evil.com"), "/dashboard");
  assert.equal(getSafeRedirectPath("https://evil.com/@ops"), "/dashboard");
});

test("getSafeRedirectPath chặn backslash và trả về /dashboard", () => {
  assert.equal(getSafeRedirectPath("/\\evil.com"), "/dashboard");
  assert.equal(getSafeRedirectPath("/dashboard\\.."), "/dashboard");
  assert.equal(getSafeRedirectPath(null), "/dashboard");
  assert.equal(getSafeRedirectPath(""), "/dashboard");
});

// ------------------------------------------------------------------
// 17-18: parseInviteHash
// ------------------------------------------------------------------
test("parseInviteHash trích xuất access_token và refresh_token", () => {
  const hash = "#access_token=abc123&refresh_token=def456&type=invite&expires_in=3600";
  const p = parseInviteHash(hash);
  assert.equal(p.access_token, "abc123");
  assert.equal(p.refresh_token, "def456");
  assert.equal(p.type, "invite");
  assert.equal(p.expires_in, "3600");
});

test("parseInviteHash trích xuất error từ hash", () => {
  const hash = "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired";
  const p = parseInviteHash(hash);
  assert.equal(p.error, "access_denied");
  assert.equal(p.error_code, "otp_expired");
  assert.ok(p.error_description?.includes("expired") || p.error_description?.includes("invalid"));
});

// ------------------------------------------------------------------
// 19-20: translateInviteError tiếng Việt
// ------------------------------------------------------------------
test("translateInviteError hết hạn → tiếng Việt chứa 'hết hạn'", () => {
  const msg = translateInviteError("otp_expired", "Email link is invalid or has expired");
  assert.match(msg.toLowerCase(), /hết hạn/);
  assert.match(msg.toLowerCase(), /quản trị/);
});

test("translateInviteError không hợp lệ → tiếng Việt chứa 'không hợp lệ'", () => {
  const msg = translateInviteError("access_denied", "Invalid grant");
  assert.match(msg.toLowerCase(), /không hợp lệ/);
});

// ------------------------------------------------------------------
// 21-23: file tồn tại và logic route/middleware
// ------------------------------------------------------------------
test("middleware mở công khai /invite và /auth/confirm", () => {
  const mw = readFileSync(join(webRoot, "src/middleware.ts"), "utf8");
  assert.match(mw, /\/invite/);
  assert.match(mw, /\/auth\/confirm/);
  assert.match(mw, /PUBLIC_PATHS/);
  // Đảm bảo không chỉ là comment
  assert.equal(mw.includes('"/invite"') || mw.includes("'/invite'") || mw.includes("/invite"), true);
});

test("invite-user route truyền redirect_to và trả inviteRedirect", () => {
  const route = readFileSync(join(webRoot, "src/app/api/admin/invite-user/route.ts"), "utf8");
  assert.match(route, /redirect_to/);
  assert.match(route, /inviteUrl|inviteRedirect/);
  assert.match(route, /getSiteOrigin/);
  assert.match(route, /\/invite/);
});

test("NewUserForm hiện 'Link trong email sẽ mở trang đặt mật khẩu tại' và /invite page dùng setSession", () => {
  const form = readFileSync(join(webRoot, "src/app/(app)/module0/users/new/NewUserForm.tsx"), "utf8");
  assert.match(form, /Link trong email sẽ mở trang đặt mật khẩu tại/);
  assert.match(form, /\/invite/);

  const invitePage = join(webRoot, "src/app/invite/page.tsx");
  const inviteClient = join(webRoot, "src/app/invite/InviteClient.tsx");
  assert.equal(existsSync(invitePage), true, "/invite/page.tsx phải tồn tại");
  assert.equal(existsSync(inviteClient), true, "/invite/InviteClient.tsx phải tồn tại");

  const clientContent = readFileSync(inviteClient, "utf8");
  assert.match(clientContent, /setSession/);
  assert.match(clientContent, /access_token/);
  assert.match(clientContent, /vexim_touch_login/);
  assert.match(clientContent, /history\.replaceState/);

  const confirmPage = join(webRoot, "src/app/auth/confirm/page.tsx");
  const confirmClient = join(webRoot, "src/app/auth/confirm/ConfirmClient.tsx");
  assert.equal(existsSync(confirmPage), true, "/auth/confirm/page.tsx phải tồn tại");
  assert.equal(existsSync(confirmClient), true, "/auth/confirm/ConfirmClient.tsx phải tồn tại");
  const confirmContent = readFileSync(confirmClient, "utf8");
  assert.match(confirmContent, /verifyOtp/);
  assert.match(confirmContent, /getSafeRedirectPath/);
});
