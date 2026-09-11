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

  return (
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
          required
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
    </form>
  );
}
