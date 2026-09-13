import { Suspense } from "react";
import LoginForm from "./login-form";

export const metadata = { title: "Đăng nhập — VEXIM Ops" };

export default function LoginPage() {
  const supabaseMode =
    !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-2 text-[20px] font-extrabold">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-ink text-accent">
            V
          </span>
          VEXIM&nbsp;Ops
        </div>
        <div className="rounded-2xl border border-line bg-card p-7 shadow-sm">
          <h1 className="text-lg font-extrabold tracking-tight">
            Đăng nhập hệ thống
          </h1>
          <p className="mt-1 text-[13px] text-muted">
            Nền tảng quản trị vận hành Amazon — kết nối SP-API chính thức.
          </p>
          <Suspense fallback={null}>
            <LoginForm supabaseMode={supabaseMode} />
          </Suspense>
        </div>
        <p className="mt-4 text-center text-[11.5px] text-soft">
          {supabaseMode ? (
            <>
              Hệ thống đã nối Supabase — mọi số liệu đọc từ cơ sở dữ liệu thật
              (RLS theo quyền của bạn). Đăng nhập để tiếp tục.
            </>
          ) : (
            <>
              DEMO MODE: chưa cấu hình Supabase nên giao diện chạy bằng dữ liệu
              giả lập (MockProvider) — nối Supabase là chuyển nguồn thật, không
              đổi giao diện.
            </>
          )}
        </p>
      </div>
    </div>
  );
}
