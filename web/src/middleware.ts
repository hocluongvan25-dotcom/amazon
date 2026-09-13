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
 *
 * Path trong BYPASS_AUTH_PATHS tự kiểm tra Authorization: Bearer <CRON_SECRET>
 * (hoặc signature webhook) — KHÔNG đòi cookie session. Phải return next()
 * TRƯỚC khi gọi getUser(), nếu không request không cookie bị 307 /login.
 */
/**
 * Đường dẫn công khai KHÔNG yêu cầu đăng nhập:
 * - / : landing page tiếng Việt (gắn vào hệ thống, marketing) — nếu đã đăng nhập thì redirect /dashboard ở page.tsx
 * - /landing : alias cho landing (để truy cập trực tiếp)
 * - /login: trang đăng nhập
 * - /invite: trang đặt mật khẩu cho người được mời — nhận #access_token (implicit grant)
 *   từ email. Nếu không mở công khai, request không cookie bị đá về /login và mất token.
 * - /auth/confirm: xử lý nhánh email template dùng {{ .TokenHash }} (verifyOtp + chặn open-redirect).
 *   Cũng phải mở công khai, nếu không token_hash bị mất khi redirect.
 */
const PUBLIC_PATHS = ["/", "/landing", "/login", "/invite", "/auth/confirm"];
const BYPASS_AUTH_PATHS = [
  "/api/cron",
  "/api/webhooks",
  "/api/whoami",
  "/api/amazon/whoami",
];

const MW_HEADER = "x-vexim-middleware";

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function isBypassPath(pathname: string): boolean {
  const p = normalizePath(pathname);
  return BYPASS_AUTH_PATHS.some((b) => p === b || p.startsWith(`${b}/`));
}

function isPublicPath(pathname: string): boolean {
  const p = normalizePath(pathname);
  return PUBLIC_PATHS.some((b) => p === b || p.startsWith(`${b}/`));
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

function passthrough(req: NextRequest): NextResponse {
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set(MW_HEADER, "1");
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set(MW_HEADER, "1");
  return res;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Bypass TRƯỚC mọi thứ — cron / whoami / webhook tự kiểm tra token.
  if (isBypassPath(pathname)) {
    return passthrough(req);
  }

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set(MW_HEADER, "1");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    if (isPublicPath(pathname)) return passthrough(req);
    if (!req.cookies.has("demo_role")) return loginRedirect(req);
    return passthrough(req);
  }

  // SUPABASE MODE — luôn gọi getUser() để refresh token, kể cả /login,
  // rồi mới quyết định có redirect hay không.
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

  if (!user && !isPublicPath(pathname)) {
    return loginRedirect(req, response);
  }
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|css|js)$).*)",
  ],
};
