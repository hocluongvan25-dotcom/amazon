"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  getSafeRedirectPath,
  translateConfirmError,
} from "@/lib/site-origin";

type Status = "parsing" | "verifying" | "done" | "error";

export default function ConfirmClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<Status>("parsing");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [nextPath, setNextPath] = useState("/dashboard");

  useEffect(() => {
    const token_hash = searchParams.get("token_hash");
    const type = searchParams.get("type") as
      | "invite"
      | "recovery"
      | "email"
      | "email_change"
      | "signup"
      | null;
    const nextParam = searchParams.get("next");

    const safeNext = getSafeRedirectPath(nextParam, "/dashboard");
    setNextPath(safeNext);

    if (!token_hash || !type) {
      setErrorMsg("Link xác thực không hợp lệ hoặc đã hết hạn.");
      setStatus("error");
      return;
    }

    const th = token_hash;
    const tp = type;

    async function run() {
      setStatus("verifying");
      const supabase = createClient();
      if (!supabase) {
        setErrorMsg("Chưa cấu hình Supabase.");
        setStatus("error");
        return;
      }

      try {
        const { error } = await supabase.auth.verifyOtp({
          token_hash: th,
          type: tp as "invite" | "recovery" | "email" | "email_change" | "signup",
        });

        if (error) {
          setErrorMsg(translateConfirmError(error.message, tp ?? undefined));
          setStatus("error");
          return;
        }

        if (tp === "invite") {
          try {
            await supabase.rpc("vexim_touch_login");
          } catch {}
        }

        setStatus("done");
        try {
          history.replaceState(null, "", window.location.pathname);
        } catch {}

        setTimeout(() => {
          router.push(safeNext);
          router.refresh();
        }, 800);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setErrorMsg(translateConfirmError(msg, tp ?? undefined));
        setStatus("error");
      }
    }

    run();
  }, [searchParams, router]);

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
          {status === "parsing" || status === "verifying" ? (
            <>
              <h1 className="text-[18px] font-extrabold tracking-tight">
                {status === "parsing" ? "Đang đọc link…" : "Đang xác thực…"}
              </h1>
              <p className="mt-2 text-[13px] text-muted">Vui lòng chờ trong giây lát.</p>
              <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-bg">
                <div className="h-full w-1/2 animate-pulse rounded-full bg-accent" />
              </div>
            </>
          ) : null}

          {status === "error" ? (
            <>
              <h1 className="mt-2 text-[18px] font-extrabold tracking-tight">Xác thực thất bại</h1>
              <p className="mt-2 rounded-lg bg-red-soft px-3 py-2.5 text-[13px] font-semibold text-[#a01717]">
                {errorMsg}
              </p>
              <p className="mt-3 text-[12.5px] text-muted">
                Link chỉ dùng được một lần. Vui lòng yêu cầu gửi lại email hoặc đăng nhập tại{" "}
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

          {status === "done" ? (
            <>
              <h1 className="mt-2 text-[18px] font-extrabold tracking-tight text-[#0b7a55]">
                Xác thực thành công
              </h1>
              <p className="mt-1 text-[13px] text-muted">Đang chuyển hướng…</p>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
