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
  const [debugInfo, setDebugInfo] = useState<string | null>(null);
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
      setErrorMsg(
        "Link xác thực không hợp lệ (thiếu token_hash hoặc type). Vui lòng yêu cầu gửi lại email.",
      );
      setDebugInfo(
        `token_hash=${token_hash ? "có" : "thiếu"} type=${type ?? "thiếu"} next=${nextParam ?? ""}`,
      );
      setStatus("error");
      return;
    }

    // Giữ bản non-null để TypeScript không phàn nàn trong closure
    const th = token_hash;
    const tp = type;

    async function run() {
      setStatus("verifying");
      const supabase = createClient();
      if (!supabase) {
        setErrorMsg(
          "Chưa cấu hình Supabase (DEMO MODE). Không thể xác thực.",
        );
        setStatus("error");
        return;
      }

      try {
        const { data, error } = await supabase.auth.verifyOtp({
          token_hash: th,
          type: tp as "invite" | "recovery" | "email" | "email_change" | "signup",
        });

        if (error) {
          const msg = translateConfirmError(error.message, tp ?? undefined);
          setErrorMsg(msg);
          setDebugInfo(error.message);
          setStatus("error");
          return;
        }

        // Nếu là invite, điểm danh đăng nhập (invited → active)
        if (tp === "invite") {
          try {
            await supabase.rpc("vexim_touch_login");
          } catch {}
        }

        setStatus("done");
        // Xoá token_hash khỏi URL trước khi redirect để tránh lộ
        try {
          // Giữ lại ?next=...? Không, xoá hết cho sạch
          history.replaceState(null, "", window.location.pathname);
        } catch {}

        setTimeout(() => {
          router.push(safeNext);
          router.refresh();
        }, 800);

        // data có thể chứa user
        if (data.user) {
          // optional log
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setErrorMsg(translateConfirmError(msg, tp ?? undefined));
        setDebugInfo(msg);
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
                {status === "parsing"
                  ? "Đang đọc link xác thực…"
                  : "Đang xác thực…"}
              </h1>
              <p className="mt-2 text-[13px] text-muted">
                Vui lòng chờ. Hệ thống đang xác thực token_hash từ email.
              </p>
              <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-bg">
                <div className="h-full w-1/2 animate-pulse rounded-full bg-accent" />
              </div>
              <p className="mt-3 text-[11.5px] text-soft">
                Sau khi xác thực, bạn sẽ được chuyển tới{" "}
                <code>{nextPath}</code> (đã chặn open-redirect).
              </p>
            </>
          ) : null}

          {status === "error" ? (
            <>
              <div className="text-[28px]">⚠️</div>
              <h1 className="mt-2 text-[18px] font-extrabold tracking-tight text-[#a01717]">
                Xác thực thất bại
              </h1>
              <p className="mt-2 rounded-lg bg-red-soft px-3 py-2.5 text-[13px] font-semibold text-[#a01717]">
                {errorMsg}
              </p>
              <div className="mt-3 text-[12.5px] text-muted">
                <p className="font-bold">Bạn cần làm gì:</p>
                <ul className="mt-1 list-disc pl-5">
                  <li>Link xác thực chỉ dùng được một lần và hết hạn nhanh. Nhờ quản trị viên gửi lại lời mời.</li>
                  <li>Nếu bạn đã xác thực trước đó, hãy thử đăng nhập tại <a href="/login" className="font-bold text-accent underline">/login</a>.</li>
                  <li>Nếu bạn tự sửa tham số <code>next</code> trên URL, hệ thống sẽ chặn và đưa về <code>/dashboard</code> để tránh open-redirect.</li>
                </ul>
                {debugInfo ? (
                  <p className="mt-3 rounded bg-bg px-2 py-1 text-[11px] text-soft">
                    Chi tiết kỹ thuật: {debugInfo}
                  </p>
                ) : null}
              </div>
              <a
                href="/login"
                className="mt-4 inline-flex h-9 items-center justify-center rounded-full bg-ink px-4 text-[12.5px] font-bold text-white"
              >
                Về trang đăng nhập →
              </a>
            </>
          ) : null}

          {status === "done" ? (
            <>
              <div className="text-[28px]">✅</div>
              <h1 className="mt-2 text-[18px] font-extrabold tracking-tight text-[#0b7a55]">
                Xác thực thành công
              </h1>
              <p className="mt-1 text-[13px] text-muted">
                Đang chuyển bạn tới <code>{nextPath}</code>…
              </p>
            </>
          ) : null}
        </div>

        <p className="mt-4 text-center text-[11.5px] text-soft">
          Trang này xử lý nhánh email template dùng{" "}
          <code>{"{{ .TokenHash }}"}</code> — gọi{" "}
          <code>verifyOtp</code> và chặn open-redirect cho tham số <code>next</code>.
        </p>
      </div>
    </div>
  );
}
