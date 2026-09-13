"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { PERSONAS, type PersonaKey } from "@/lib/roles";

export default function LoginForm({ supabaseMode }: { supabaseMode: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function loginAsDemo(persona: PersonaKey) {
    document.cookie = `demo_role=${persona}; path=/; max-age=${60 * 60 * 24 * 7}`;
    router.push(next);
    router.refresh();
  }

  async function loginSupabase(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      if (!supabase) throw new Error("Supabase chưa cấu hình");
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) throw error;
      router.push(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Đăng nhập thất bại");
    } finally {
      setLoading(false);
    }
  }

  if (!supabaseMode) {
    return (
      <div className="mt-5">
        <div className="mb-3 text-[11.5px] font-extrabold uppercase tracking-widest text-soft">
          Chọn vai trò demo (kiểm chứng phân quyền theo phòng)
        </div>
        <div className="flex flex-col gap-2">
          {(Object.keys(PERSONAS) as PersonaKey[]).map((k) => {
            const p = PERSONAS[k];
            return (
              <button
                key={k}
                onClick={() => loginAsDemo(k)}
                className="flex items-center gap-3 rounded-xl border border-line px-4 py-3 text-left transition hover:border-accent hover:bg-accent-soft"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#dfe6f3] text-[12px] font-extrabold text-[#3c4a63]">
                  {p.avatar}
                </span>
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-bold">{p.label}</span>
                  <span className="block truncate text-[12px] text-soft">
                    {p.scope}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  const [resetMode, setResetMode] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Vui lòng nhập email hợp lệ để gửi link đặt lại mật khẩu.");
      return;
    }
    setResetLoading(true);
    try {
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      if (!supabase) throw new Error("Supabase chưa cấu hình");
      // Tính redirect_to an toàn: dùng origin hiện tại + /auth/confirm
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      const redirectTo = origin ? `${origin}/auth/confirm?next=/dashboard` : undefined;
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo,
      });
      if (error) throw error;
      setResetSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không gửi được email đặt lại mật khẩu.");
    } finally {
      setResetLoading(false);
    }
  }

  return (
    <>
      <form onSubmit={loginSupabase} className="mt-5 flex flex-col gap-3">
        <label className="text-[12.5px] font-bold text-muted">
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="mt-1 w-full rounded-[9px] border border-line px-3 py-2.5 text-[13.5px] outline-none focus:border-accent"
            placeholder="ten@vexim.vn"
          />
        </label>
        <label className="text-[12.5px] font-bold text-muted">
          Mật khẩu
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required={!resetMode}
            className="mt-1 w-full rounded-[9px] border border-line px-3 py-2.5 text-[13.5px] outline-none focus:border-accent"
            placeholder="••••••••"
          />
        </label>
        {error ? (
          <div className="rounded-lg bg-red-soft px-3 py-2 text-[12.5px] font-semibold text-[#a01717]">
            {error}
          </div>
        ) : null}
        <button
          type="submit"
          disabled={loading}
          className="mt-1 rounded-full bg-ink px-5 py-2.5 text-[14px] font-semibold text-white disabled:opacity-60"
        >
          {loading ? "Đang đăng nhập…" : "Đăng nhập"}
        </button>
        <div className="mt-1 flex items-center justify-between text-[12px]">
          <button
            type="button"
            onClick={() => {
              setResetMode(!resetMode);
              setError(null);
              setResetSent(false);
            }}
            className="font-semibold text-soft underline hover:text-ink"
          >
            {resetMode ? "← Quay lại đăng nhập" : "Quên mật khẩu / Chưa có mật khẩu?"}
          </button>
          <a href="/invite" className="font-semibold text-soft underline hover:text-ink">
            Trang đặt mật khẩu /invite
          </a>
        </div>
      </form>

      {resetMode ? (
        <form onSubmit={handleResetPassword} className="mt-4 rounded-[12px] border border-amber/40 bg-amber-soft px-4 py-3">
          <h3 className="text-[13px] font-extrabold text-[#8a5602]">Đặt lại mật khẩu / Kích hoạt tài khoản được mời</h3>
          <p className="mt-1 text-[12px] text-[#8a5602]">
            Tài khoản vừa được super_admin tạo <b>chưa có mật khẩu</b> nên không thể đăng nhập ở form trên. Bạn phải dùng <b>link trong email mời</b> (mở trang <code>/invite</code> với <code>#access_token=…</code>).
            Nếu link hết hạn hoặc bạn vào thẳng <code>/login</code>, hãy nhập email ở trên và bấm nút dưới — hệ thống sẽ gửi link đặt lại mật khẩu qua <code>/auth/confirm</code> (đã chặn open-redirect).
          </p>
          {resetSent ? (
            <div className="mt-2 rounded-lg bg-green-soft px-3 py-2 text-[12px] font-bold text-[#0b7a55]">
              ✅ Đã gửi email đặt lại mật khẩu đến <b>{email}</b>. Kiểm tra hộp thư (kể cả Spam) và bấm vào link — link sẽ mở trang xác thực tại <code>/auth/confirm</code> rồi cho đặt mật khẩu mới.
            </div>
          ) : null}
          <button
            type="submit"
            disabled={resetLoading}
            className="mt-2 h-9 rounded-full bg-amber px-4 text-[12.5px] font-extrabold text-white hover:brightness-95 disabled:opacity-60"
          >
            {resetLoading ? "Đang gửi…" : "Gửi link đặt lại mật khẩu →"}
          </button>
        </form>
      ) : (
        <div className="mt-4 rounded-[12px] border border-line bg-bg px-4 py-3 text-[11.5px] text-soft">
          <b className="text-muted">Luồng mời chuẩn:</b>
          <ol className="mt-1 list-decimal pl-5">
            <li>Super Admin tạo tài khoản ở <code>/module0/users/new</code> → hệ thống gọi <code>POST /auth/v1/invite</code> với <code>redirect_to: &lt;origin&gt;/invite</code>.</li>
            <li>Email mời chứa link dạng <code>https://&lt;project&gt;.supabase.co/auth/v1/verify?...&redirect_to=https://&lt;domain&gt;/invite</code> → Supabase redirect về <code>https://&lt;domain&gt;/invite#access_token=…&refresh_token=…</code>.</li>
            <li>Trang <code>/invite</code> (public, đã mở trong middleware) đọc hash, gọi <code>setSession()</code> qua storage adapter của <code>@supabase/ssr</code> (cookie phiên được ghi như login thường), xoá token khỏi URL, hiện form đặt mật khẩu.</li>
            <li>Đặt mật khẩu → <code>updateUser({"{password}"})</code> → <code>vexim_touch_login()</code> (hồ sơ <code>invited</code> ⇒ <code>active</code>) → <code>/dashboard</code>.</li>
          </ol>
          <p className="mt-2">
            Nếu bạn thấy mình bị đá về <code>/login</code> khi bấm link mời, kiểm tra: <code>NEXT_PUBLIC_SITE_URL</code> trong Vercel đã đặt thành <code>https://&lt;domain&gt;</code> chưa, và trong Supabase Dashboard → Authentication → URL Configuration → Site URL có phải là production domain không (đừng để <code>http://localhost:3000</code>).
          </p>
        </div>
      )}
    </>
  );
}
