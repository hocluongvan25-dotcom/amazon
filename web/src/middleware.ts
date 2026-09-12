import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Middleware bảo vệ toàn bộ app:
 * - DEMO MODE (chưa cấu hình Supabase): yêu cầu cookie demo_role
 * - SUPABASE MODE: gọi supabase.auth.getUser() để refresh cookie phiên
 *   (server.ts ghi "middleware sẽ refresh session" — trước đây middleware
 *   chỉ kiểm tra cookie tên sb-* có tồn tại, KHÔNG refresh, nên user bị
 *   đá ra login khi access token hết hạn dù refresh token còn hạn).
 *   Không tin cookie demo_role khi đã cấu hình Supabase (tránh lọt vào
 *   production bằng cookie demo còn sót).
 * Việc phân quyền chi tiết (RLS) thực hiện ở tầng database + server layout.
 */
const PUBLIC_PATHS = ["/login"];
// Cron + webhook tự kiểm tra signature/CRON_SECRET.
// /api/whoami là endpoint chẩn đoán — phải vào được cả khi CHƯA đăng nhập.
const BYPASS_AUTH_PATHS = ["/api/cron/", "/api/webhooks/", "/api/whoami"];

const MW_HEADER = "x-vexim-middleware";

function isPublicOrBypass(pathname: string) {
  return (
    BYPASS_AUTH_PATHS.some((p) => pathname.startsWith(p)) ||
    PUBLIC_PATHS.some((p) => pathname.startsWith(p))
  );
}

function loginRedirect(req: NextRequest, cookieSource?: NextResponse) {
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  url.searchParams.set("next", req.nextUrl.pathname);
  const res = NextResponse.redirect(url);
  res.headers.set(MW_HEADER, "1");
  if (cookieSource) {
    cookieSource.cookies.getAll().forEach((c) => res.cookies.set(c));
  }
  return res;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set(MW_HEADER, "1");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    if (isPublicOrBypass(pathname)) {
      const res = NextResponse.next({ request: { headers: requestHeaders } });
      res.headers.set(MW_HEADER, "1");
      return res;
    }
    if (!req.cookies.has("demo_role")) {
      return loginRedirect(req);
    }
    const res = NextResponse.next({ request: { headers: requestHeaders } });
    res.headers.set(MW_HEADER, "1");
    return res;
  }

  // SUPABASE MODE — luôn gọi getUser() để refresh token, kể cả /login và
  // /api/whoami, rồi mới quyết định có redirect hay không.
  let response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(MW_HEADER, "1");

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll(
        cookiesToSet: {
          name: string;
          value: string;
          options: CookieOptions;
        }[],
      ) {
        cookiesToSet.forEach(({ name, value }) => req.cookies.set(name, value));
        response = NextResponse.next({ request: { headers: requestHeaders } });
        response.headers.set(MW_HEADER, "1");
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  // Không chạy code giữa createServerClient và getUser() — sai lệch dễ
  // khiến user bị logout ngẫu nhiên (cảnh báo chính thức của @supabase/ssr).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && !isPublicOrBypass(pathname)) {
    return loginRedirect(req, response);
  }
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|css|js)$).*)",
  ],
};
