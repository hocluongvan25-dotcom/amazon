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
  const [showPassword, setShowPassword] = useState(false);
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
          Chọn vai trò demo
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
                  <span className="block truncate text-[12px] text-soft">{p.scope}</span>
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
      setError("Vui lòng nhập email hợp lệ.");
      return;
    }
    setResetLoading(true);
    try {
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      if (!supabase) throw new Error("Supabase chưa cấu hình");
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      const redirectTo = origin ? `${origin}/auth/confirm?next=/dashboard` : undefined;
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo,
      });
      if (error) throw error;
      setResetSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không gửi được email.");
    } finally {
      setResetLoading(false);
    }
  }

  return (
    <>
      <form onSubmit={resetMode ? handleResetPassword : loginSupabase} className="mt-5 flex flex-col gap-3">
        <label className="text-[12.5px] font-bold text-muted">
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="mt-1 w-full rounded-[10px] border border-line px-3 py-2.5 text-[13.5px] outline-none focus:border-accent"
            placeholder="ten@vexim.vn"
          />
        </label>

        {!resetMode ? (
          <label className="text-[12.5px] font-bold text-muted">
            Mật khẩu
            <div className="relative mt-1">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full rounded-[10px] border border-line px-3 py-2.5 pr-10 text-[13.5px] outline-none focus:border-accent"
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-soft transition hover:bg-bg hover:text-ink"
                aria-label={showPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
                tabIndex={-1}
              >
                {showPassword ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                    <path d="M10.73 5.08A10.94 10.94 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                    <path d="M6.38 6.38A13.16 13.16 0 0 0 2 12s3 7 10 7a10.94 10.94 0 0 0 5.39-1.39" />
                    <line x1="2" y1="2" x2="22" y2="22" />
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
          </label>
        ) : null}

        {error ? (
          <div className="rounded-lg bg-red-soft px-3 py-2 text-[12.5px] font-semibold text-[#a01717]">
            {error}
          </div>
        ) : null}

        {resetMode && resetSent ? (
          <div className="rounded-lg bg-green-soft px-3 py-2 text-[12.5px] font-semibold text-[#0b7a55]">
            Đã gửi email đặt lại mật khẩu đến <b>{email}</b>. Vui lòng kiểm tra hộp thư.
          </div>
        ) : null}

        <button
          type="submit"
          disabled={resetMode ? resetLoading : loading}
          className="mt-1 rounded-full bg-ink px-5 py-2.5 text-[14px] font-semibold text-white transition hover:bg-black disabled:opacity-60"
        >
          {resetMode ? (resetLoading ? "Đang gửi…" : "Gửi link đặt lại mật khẩu") : loading ? "Đang đăng nhập…" : "Đăng nhập"}
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
            {resetMode ? "← Quay lại đăng nhập" : "Quên mật khẩu?"}
          </button>
        </div>
      </form>
    </>
  );
}
