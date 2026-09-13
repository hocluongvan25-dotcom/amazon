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
  const [localError, setLocalError] = useState<string | null>(null);
  const [debugInfo, setDebugInfo] = useState<string | null>(null);

  useEffect(() => {
    // Tránh lỗi PKCE của @supabase/ssr: đọc hash TRƯỚC khi khởi tạo client,
    // rồi xoá hash khỏi URL ngay để GoTrueClient không cố parse implicit grant
    // bằng logic PKCE và ném "Not a valid PKCE flow url.".
    const rawHash = window.location.hash;
    const parsed: ParsedInviteHash = parseInviteHash(rawHash);

    // Nếu có lỗi trong hash (ví dụ link hết hạn)
    if (parsed.error) {
      const msg = translateInviteError(
        parsed.error,
        parsed.error_description || parsed.error_code,
      );
      setErrorMsg(msg);
      setDebugInfo(
        `error=${parsed.error} code=${parsed.error_code ?? ""} desc=${parsed.error_description ?? ""}`,
      );
      // Xoá token khỏi thanh địa chỉ
      try {
        history.replaceState(null, "", window.location.pathname + window.location.search);
      } catch {}
      setStatus("error");
      return;
    }

    const hasTokens = !!parsed.access_token && !!parsed.refresh_token;

    // Xoá hash khỏi URL ngay sau khi đã lưu vào bộ nhớ — đi qua storage adapter
    // của ssr nên cookie phiên được ghi y như đăng nhập thường.
    if (rawHash) {
      try {
        history.replaceState(null, "", window.location.pathname + window.location.search);
      } catch {}
    }

    async function run() {
      const supabase = createClient();
      if (!supabase) {
        setErrorMsg(
          "Chưa cấu hình Supabase (DEMO MODE). Không thể xử lý lời mời.",
        );
        setStatus("error");
        return;
      }

      try {
        // Nếu URL có token implicit → setSession
        if (hasTokens) {
          const { data, error } = await supabase.auth.setSession({
            access_token: parsed.access_token!,
            refresh_token: parsed.refresh_token!,
          });
          if (error) {
            const msg = translateInviteError(error.message, error.message);
            setErrorMsg(msg);
            setDebugInfo(error.message);
            setStatus("error");
            return;
          }
          if (data.user?.email) setEmail(data.user.email);
          else {
            // Lấy user sau khi set session
            const { data: u } = await supabase.auth.getUser();
            if (u.user?.email) setEmail(u.user.email);
          }
          setStatus("needs_password");
          return;
        }

        // Không có token trong hash — có thể đã có session (user refresh trang sau khi setSession)
        const { data: sessionData } = await supabase.auth.getSession();
        if (sessionData.session?.user?.email) {
          setEmail(sessionData.session.user.email);
          setStatus("needs_password");
          return;
        }

        // Không có gì cả → link hỏng/hết hạn
        setErrorMsg(
          "Link mời không hợp lệ hoặc đã hết hạn. Vui lòng liên hệ quản trị viên để gửi lại lời mời. Link thường có hiệu lực 24h và chỉ dùng được một lần.",
        );
        setStatus("error");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setErrorMsg(translateInviteError(msg, msg));
        setDebugInfo(msg);
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

      // Điểm danh đăng nhập: hồ sơ invited ⇒ active, ghi last_login_at
      try {
        await supabase.rpc("vexim_touch_login");
      } catch {
        // Không chặn luồng nếu RPC lỗi — vẫn cho vào dashboard
      }

      setStatus("done");
      // Chờ 800ms để user thấy thông báo rồi chuyển
      setTimeout(() => {
        router.push("/dashboard");
        router.refresh();
      }, 800);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Dịch lỗi đặt mật khẩu
      if (msg.toLowerCase().includes("same password")) {
        setLocalError("Mật khẩu mới phải khác mật khẩu cũ (nếu có).");
      } else if (msg.toLowerCase().includes("weak") || msg.toLowerCase().includes("short")) {
        setLocalError("Mật khẩu quá yếu. Dùng ít nhất 6 ký tự, có chữ và số.");
      } else {
        setLocalError(`Không đặt được mật khẩu: ${msg}`);
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
              <p className="mt-2 text-[13px] text-muted">
                Vui lòng chờ trong giây lát. Hệ thống đang xác thực token từ
                email mời.
              </p>
              <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-bg">
                <div className="h-full w-1/2 animate-pulse rounded-full bg-accent" />
              </div>
            </>
          ) : null}

          {status === "error" ? (
            <>
              <div className="text-[28px]">⚠️</div>
              <h1 className="mt-2 text-[18px] font-extrabold tracking-tight text-[#a01717]">
                Link mời không hợp lệ
              </h1>
              <p className="mt-2 rounded-lg bg-red-soft px-3 py-2.5 text-[13px] font-semibold text-[#a01717]">
                {errorMsg}
              </p>
              <div className="mt-3 text-[12.5px] text-muted">
                <p className="font-bold">Bạn cần làm gì:</p>
                <ul className="mt-1 list-disc pl-5">
                  <li>Kiểm tra lại email mời có phải là email mới nhất không (mỗi lần mời lại link cũ hết hiệu lực).</li>
                  <li>Link thường hết hạn sau 24h. Nhờ quản trị viên gửi lại lời mời từ màn “Người dùng & phân quyền”.</li>
                  <li>Nếu bạn đã đặt mật khẩu trước đó, hãy thử đăng nhập tại <a href="/login" className="font-bold text-accent underline">/login</a>.</li>
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

          {status === "needs_password" || status === "setting_password" ? (
            <>
              <h1 className="text-[18px] font-extrabold tracking-tight">
                Đặt mật khẩu
              </h1>
              <p className="mt-1 text-[13px] text-muted">
                {email ? (
                  <>
                    Tài khoản <b>{email}</b> đã được xác thực. Vui lòng đặt mật
                    khẩu để hoàn tất.
                  </>
                ) : (
                  "Tài khoản của bạn đã được xác thực. Vui lòng đặt mật khẩu."
                )}
              </p>

              <form onSubmit={handleSetPassword} className="mt-5 flex flex-col gap-3">
                <label className="text-[12.5px] font-bold text-muted">
                  Mật khẩu mới *
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={6}
                    placeholder="Ít nhất 6 ký tự"
                    className="mt-1 w-full rounded-[9px] border border-line px-3 py-2.5 text-[13.5px] outline-none focus:border-accent"
                  />
                </label>
                <label className="text-[12.5px] font-bold text-muted">
                  Xác nhận mật khẩu *
                  <input
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                    minLength={6}
                    placeholder="Nhập lại mật khẩu"
                    className="mt-1 w-full rounded-[9px] border border-line px-3 py-2.5 text-[13.5px] outline-none focus:border-accent"
                  />
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
                  {status === "setting_password"
                    ? "Đang lưu…"
                    : "Đặt mật khẩu & vào hệ thống →"}
                </button>

                <p className="mt-2 text-[11.5px] text-soft">
                  Sau khi đặt mật khẩu, hồ sơ của bạn sẽ chuyển từ{" "}
                  <code>invited</code> sang <code>active</code> và ghi nhận lần
                  đăng nhập đầu tiên (vexim_touch_login).
                </p>
              </form>
            </>
          ) : null}

          {status === "done" ? (
            <>
              <div className="text-[28px]">✅</div>
              <h1 className="mt-2 text-[18px] font-extrabold tracking-tight text-[#0b7a55]">
                Đã đặt mật khẩu thành công
              </h1>
              <p className="mt-1 text-[13px] text-muted">
                Đang chuyển bạn vào Dashboard…
              </p>
            </>
          ) : null}
        </div>

        <p className="mt-4 text-center text-[11.5px] text-soft">
          Link trong email sẽ mở trang đặt mật khẩu tại <code>/invite</code> —
          token được xoá khỏi thanh địa chỉ ngay sau khi xác thực để tránh lộ.
        </p>
      </div>
    </div>
  );
}
