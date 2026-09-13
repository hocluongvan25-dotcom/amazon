/**
 * SINGLE SOURCE OF TRUTH cho các đường dẫn auth của middleware.
 *
 * Vì sao tách riêng: trước đây BYPASS_AUTH_PATHS nằm trong middleware.ts còn
 * /api/version copy tay một bản list → hai bản lệch nhau (version thiếu
 * /api/version trong list) khiến việc verify deployment không tin được.
 * Giờ cả middleware lẫn /api/version cùng import từ đây.
 *
 * BYPASS_AUTH_PATHS: request đi thẳng vào route handler, KHÔNG qua Supabase
 * getUser() — route tự bảo vệ bằng Bearer <CRON_SECRET> / signature / state.
 * QUAN TRỌNG cho OAuth: Amazon gọi callback về KHÔNG kèm cookie Supabase —
 * nếu thiếu bypass /api/oauth thì middleware 307 → /login → Vercel 404.
 *
 * PUBLIC_PATHS: trang công khai không yêu cầu đăng nhập (vẫn qua getUser()
 * để refresh session nếu có cookie).
 */

export const PUBLIC_PATHS = [
  "/",
  "/landing",
  "/login",
  "/invite",
  "/auth/confirm",
] as const;

export const BYPASS_AUTH_PATHS = [
  "/api/cron",
  "/api/webhooks",
  "/api/whoami",
  "/api/amazon/whoami",
  "/api/oauth",
  "/api/version",
] as const;

/** Bỏ trailing slash (trừ "/" gốc) để "/api/oauth/" match như "/api/oauth". */
export function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

/**
 * Request đi thẳng vào route handler, không qua check session Supabase.
 * Amazon gọi /api/oauth/amazon/callback KHÔNG kèm cookie — nếu hàm này trả
 * false cho path đó thì middleware 307 → /login → Vercel 404 (bug 09/2026).
 */
export function isBypassPath(pathname: string): boolean {
  const p = normalizePath(pathname);
  return BYPASS_AUTH_PATHS.some((b) => p === b || p.startsWith(`${b}/`));
}

/** Trang công khai — không yêu cầu đăng nhập. */
export function isPublicPath(pathname: string): boolean {
  const p = normalizePath(pathname);
  return PUBLIC_PATHS.some((b) => p === b || p.startsWith(`${b}/`));
}
