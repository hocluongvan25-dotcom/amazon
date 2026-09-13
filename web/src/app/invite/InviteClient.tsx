"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  parseInviteHash,
  translateInviteError,
  type ParsedInviteHash,
} from "@/lib/site-origin";

type Status =
  | "parsing"
  | "needs_password"
  | "setting_password"
  | "done"
  | "error";

export default function InviteClient() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("parsing");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    const rawHash = window.location.hash;
    const parsed: ParsedInviteHash = parseInviteHash(rawHash);

    if (parsed.error) {
      const msg = translateInviteError(
        parsed.error,
        parsed.error_description || parsed.error_code,
      );
      setErrorMsg(msg);
      try {
        history.replaceState(null, "", window.location.pathname + window.location.search);
      } catch {}
      setStatus("error");
      return;
    }

    const hasTokens = !!parsed.access_token && !!parsed.refresh_token;

    if (rawHash) {
      try {
        history.replaceState(null, "", window.location.pathname + window.location.search);
      } catch {}
    }

    async function run() {
      const supabase = createClient();
      if (!supabase) {
        setErrorMsg("Chưa cấu hình Supabase. Không thể xử lý lời mời.");
        setStatus("error");
        return;
      }

      try {
        if (hasTokens) {
          const { data, error } = await supabase.auth.setSession({
            access_token: parsed.access_token!,
            refresh_token: parsed.refresh_token!,
          });
          if (error) {
            setErrorMsg(translateInviteError(error.message, error.message));
            setStatus("error");
            return;
          }
          if (data.user?.email) setEmail(data.user.email);
          else {
            const { data: u } = await supabase.auth.getUser();
            if (u.user?.email) setEmail(u.user.email);
          }
          setStatus("needs_password");
          return;
        }

        const { data: sessionData } = await supabase.auth.getSession();
        if (sessionData.session?.user?.email) {
          setEmail(sessionData.session.user.email);
          setStatus("needs_password");
          return;
        }

        setErrorMsg(
          "Link mời không hợp lệ hoặc đã hết hạn. Vui lòng liên hệ quản trị viên để gửi lại lời mời.",
        );
        setStatus("error");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setErrorMsg(translateInviteError(msg, msg));
        setStatus("error");
      }
    }

    run();
  }, []);

  async function handleSetPassword(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);

    if (password.length < 6) {
      setLocalError("Mật khẩu phải có ít nhất 6 ký tự.");
      return;
    }
    if (password !== confirm) {
      setLocalError("Mật khẩu xác nhận không khớp.");
      return;
    }

    setStatus("setting_password");
    try {
      const supabase = createClient();
      if (!supabase) throw new Error("Supabase chưa cấu hình");

      const { error: updErr } = await supabase.auth.updateUser({
        password,
      });
      if (updErr) throw updErr;

      try {
        await supabase.rpc("vexim_touch_login");
      } catch {}

      setStatus("done");
      setTimeout(() => {
        router.push("/dashboard");
        router.refresh();
      }, 800);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("same password")) {
        setLocalError("Mật khẩu mới phải khác mật khẩu cũ.");
      } else if (msg.toLowerCase().includes("weak") || msg.toLowerCase().includes("short")) {
        setLocalError("Mật khẩu quá yếu. Dùng ít nhất 6 ký tự.");
      } else {
        setLocalError(msg);
      }
      setStatus("needs_password");
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-2 text-[20px] font-extrabold">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-ink text-accent">
            V
          </span>
          VEXIM Ops
        </div>

        <div className="rounded-2xl border border-line bg-card p-7 shadow-sm">
          {status === "parsing" ? (
            <>
              <h1 className="text-[18px] font-extrabold tracking-tight">
                Đang xử lý lời mời…
              </h1>
              <p className="mt-2 text-[13px] text-muted">Vui lòng chờ trong giây lát.</p>
              <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-bg">
                <div className="h-full w-1/2 animate-pulse rounded-full bg-accent" />
              </div>
            </>
          ) : null}

          {status === "error" ? (
            <>
              <h1 className="mt-2 text-[18px] font-extrabold tracking-tight">
                Link mời không hợp lệ
              </h1>
              <p className="mt-2 rounded-lg bg-red-soft px-3 py-2.5 text-[13px] font-semibold text-[#a01717]">
                {errorMsg}
              </p>
              <p className="mt-3 text-[12.5px] text-muted">
                Link chỉ dùng được một lần và hết hạn sau 24h. Vui lòng nhờ quản trị viên gửi lại lời mời, hoặc đăng nhập tại{" "}
                <a href="/login" className="font-bold text-accent underline">
                  /login
                </a>
                .
              </p>
              <a
                href="/login"
                className="mt-4 inline-flex h-9 items-center justify-center rounded-full bg-ink px-4 text-[12.5px] font-bold text-white"
              >
                Về trang đăng nhập
              </a>
            </>
          ) : null}

          {status === "needs_password" || status === "setting_password" ? (
            <>
              <h1 className="text-[18px] font-extrabold tracking-tight">Đặt mật khẩu</h1>
              <p className="mt-1 text-[13px] text-muted">
                {email ? (
                  <>
                    Tài khoản <b>{email}</b> đã được xác thực.
                  </>
                ) : (
                  "Tài khoản của bạn đã được xác thực."
                )}
              </p>

              <form onSubmit={handleSetPassword} className="mt-5 flex flex-col gap-3">
                <label className="text-[12.5px] font-bold text-muted">
                  Mật khẩu mới
                  <div className="relative mt-1">
                    <input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      minLength={6}
                      placeholder="Ít nhất 6 ký tự"
                      className="w-full rounded-[10px] border border-line px-3 py-2.5 pr-10 text-[13.5px] outline-none focus:border-accent"
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
                <label className="text-[12.5px] font-bold text-muted">
                  Xác nhận mật khẩu
                  <div className="relative mt-1">
                    <input
                      type={showConfirm ? "text" : "password"}
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      required
                      minLength={6}
                      placeholder="Nhập lại mật khẩu"
                      className="w-full rounded-[10px] border border-line px-3 py-2.5 pr-10 text-[13.5px] outline-none focus:border-accent"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirm((v) => !v)}
                      className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-soft transition hover:bg-bg hover:text-ink"
                      aria-label={showConfirm ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
                      tabIndex={-1}
                    >
                      {showConfirm ? (
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

                {localError ? (
                  <div className="rounded-lg bg-red-soft px-3 py-2 text-[12.5px] font-semibold text-[#a01717]">
                    {localError}
                  </div>
                ) : null}

                <button
                  type="submit"
                  disabled={status === "setting_password"}
                  className="mt-1 rounded-full bg-accent px-5 py-2.5 text-[14px] font-semibold text-white disabled:opacity-60"
                >
                  {status === "setting_password" ? "Đang lưu…" : "Đặt mật khẩu"}
                </button>
              </form>
            </>
          ) : null}

          {status === "done" ? (
            <>
              <h1 className="mt-2 text-[18px] font-extrabold tracking-tight text-[#0b7a55]">
                Đã đặt mật khẩu thành công
              </h1>
              <p className="mt-1 text-[13px] text-muted">Đang chuyển vào hệ thống…</p>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
