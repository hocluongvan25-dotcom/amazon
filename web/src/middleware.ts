import { NextResponse, type NextRequest } from "next/server";

/**
 * Middleware bảo vệ toàn bộ app:
 * - DEMO MODE (chưa cấu hình Supabase): yêu cầu cookie demo_role (đăng nhập demo)
 * - SUPABASE MODE: yêu cầu cookie phiên sb-* (đăng nhập thật qua Supabase Auth)
 * Việc phân quyền chi tiết (RLS) thực hiện ở tầng database + server layout.
 */
const PUBLIC_PATHS = ["/login"];
// Cron + webhook API paths không đi qua auth giao diện (tự kiểm tra signature/CRON_SECRET)
const BYPASS_AUTH_PATHS = ["/api/cron/", "/api/webhooks/"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (BYPASS_AUTH_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const hasDemoSession = req.cookies.has("demo_role");
  const hasSupabaseSession = req.cookies
    .getAll()
    .some((c) => c.name.startsWith("sb-"));

  if (!hasDemoSession && !hasSupabaseSession) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|css|js)$).*)",
  ],
};
