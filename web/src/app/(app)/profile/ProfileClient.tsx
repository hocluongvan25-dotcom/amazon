"use client";

import { useEffect, useState } from "react";
import { Chip, Panel } from "@/components/ui";
import { profileByPersona } from "@/lib/data/mock";
import { PERSONAS } from "@/lib/roles";
import type { Session } from "@/lib/auth/session";
import type { Profile } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { ROLE_LABEL } from "@/lib/types";

type MyProfileRow = {
  id: string;
  display_name: string;
  email: string;
  phone: string | null;
  avatar_url: string | null;
  mfa_enabled: boolean;
  vexim_employee: boolean;
  role: string | null;
  department: string | null;
  created_at: string;
  last_login_at: string | null;
};

export default function ProfileClient({ session }: { session: Session }) {
  const isDemo = session.mode === "demo";
  const mock: Profile = profileByPersona[session.persona];
  const supabase = isDemo ? null : createClient();

  const [row, setRow] = useState<MyProfileRow | null>(null);
  const [loading, setLoading] = useState(!isDemo);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    (async () => {
      const { data, error } = await supabase
        .schema("iam").from("my_profile")
        .select("*")
        .maybeSingle();
      if (data && !error) {
        setRow(data);
        setName(data.display_name ?? "");
        setPhone(data.phone ?? "");
      }
      setLoading(false);
    })();
  }, [supabase]);

  async function save() {
    if (!supabase) return;
    setSaving(true);
    setSaveMsg(null);
    const { error } = await supabase
      .schema("iam").from("user_profiles")
      .update({ display_name: name, phone })
      .eq("id", session.userId);
    setSaving(false);
    if (error) {
      setSaveMsg(`Lỗi: ${error.message}`);
    } else {
      setSaveMsg("Đã lưu thành công");
      setRow((r) => (r ? { ...r, display_name: name, phone } : r));
      setEditing(false);
      setTimeout(() => setSaveMsg(null), 2500);
    }
  }

  async function logout() {
    if (supabase) {
      try { await supabase.auth.signOut(); } catch { /* ignore */ }
    }
    document.cookie = "demo_role=; path=/; max-age=0";
    window.location.href = "/login";
  }

  const displayName = isDemo
    ? mock.name
    : row?.display_name ?? session.email?.split("@")[0] ?? "Người dùng";
  const displayEmail = isDemo ? mock.email : session.email ?? row?.email ?? "";
  const avatarInitial = (isDemo ? mock.avatarInitials : (row?.display_name ?? displayName).slice(0, 2).toUpperCase());
  const role = isDemo ? mock.role : row?.role ? ROLE_LABEL[row.role as keyof typeof ROLE_LABEL] ?? row.role : "Đang tải…";
  const department = isDemo ? mock.department : row?.department ?? "—";
  const mfa = isDemo ? mock.mfaEnabled : !!row?.mfa_enabled;
  const joinedAt = isDemo
    ? mock.joinedAt
    : row?.created_at ? new Date(row.created_at).toLocaleDateString("vi-VN") : "—";
  const lastLogin = isDemo
    ? mock.lastLogin
    : row?.last_login_at ? new Date(row.last_login_at).toLocaleString("vi-VN") : "vừa xong";

  return (
    <>
      <div className="mb-4 rounded-[13px] border border-line bg-card px-5 py-5">
        <div className="flex flex-wrap items-center gap-4">
          <div className="grid h-[72px] w-[72px] shrink-0 place-items-center rounded-full bg-[#dfe6f3] text-[26px] font-extrabold text-[#3c4a63]">
            {row?.avatar_url ? (
              <img src={row.avatar_url} alt="avatar" className="h-full w-full rounded-full object-cover" />
            ) : avatarInitial}
          </div>
          <div>
            <div className="text-[20px] font-extrabold">{displayName}</div>
            <div className="mt-0.5 text-[13px] text-muted">{displayEmail}</div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Chip tone="blue">{role}</Chip>
              <Chip tone="gray">{department}</Chip>
              <Chip tone={mfa ? "green" : "amber"}>{mfa ? "Đã bật 2FA" : "Chưa bật 2FA"}</Chip>
              {!isDemo && loading ? (
                <Chip tone="gray">Đang tải…</Chip>
              ) : null}
              {!isDemo && !loading && row ? (
                <Chip tone="green">DB connected</Chip>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            disabled
            title="Đổi ảnh — cần Supabase Storage (sẽ triển khai sau)"
            className="ml-auto cursor-not-allowed rounded-full border border-dashed border-line px-4 py-2 text-[12.5px] font-bold text-soft"
          >
            📷 Đổi ảnh đại diện
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Thông tin cá nhân" hint={isDemo ? "dữ liệu demo" : "từ iam.user_profiles"}>
          {editing && !isDemo ? (
            <div className="flex flex-col gap-3 text-[13px]">
              <label className="flex flex-col gap-1">
                <span className="text-[11.5px] font-bold uppercase tracking-wide text-soft">Họ và tên</span>
                <input value={name} onChange={(e) => setName(e.target.value)}
                  className="h-9 rounded-[9px] border border-line bg-card px-3 text-[13px] font-semibold outline-none focus:border-accent" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11.5px] font-bold uppercase tracking-wide text-soft">Số điện thoại</span>
                <input value={phone} onChange={(e) => setPhone(e.target.value)}
                  className="h-9 rounded-[9px] border border-line bg-card px-3 text-[13px] font-semibold outline-none focus:border-accent" />
              </label>
              <div className="flex gap-2 pt-1">
                <button onClick={save} disabled={saving}
                  className="h-9 rounded-full bg-accent px-4 text-[12.5px] font-extrabold text-white disabled:opacity-60">
                  {saving ? "Đang lưu…" : "Lưu thay đổi"}
                </button>
                <button onClick={() => setEditing(false)}
                  className="h-9 rounded-full border border-line bg-card px-4 text-[12.5px] font-bold text-muted">
                  Hủy
                </button>
              </div>
              {saveMsg ? (
                <div className={`rounded-[8px] px-3 py-2 text-[12px] font-bold ${saveMsg.startsWith("Lỗi") ? "bg-red-soft text-[#a01717]" : "bg-green-soft text-[#0b7a55]"}`}>
                  {saveMsg}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-3 text-[13px]">
              <Row label="Họ và tên" value={displayName} />
              <Row label="Email" value={displayEmail} />
              <Row label="Số điện thoại" value={isDemo ? mock.phone : row?.phone || "—"} />
              <Row label="Vai trò" value={role} />
              <Row label="Phòng ban" value={department} />
              <Row label="Ngày tham gia" value={joinedAt} />
              <Row label="Đăng nhập lần cuối" value={lastLogin} />
              {!isDemo ? (
                <button onClick={() => setEditing(true)}
                  className="mt-2 h-9 rounded-full border border-line bg-card px-4 text-[12.5px] font-bold text-muted transition hover:border-accent hover:text-accent-ink">
                  ✏️ Chỉnh sửa thông tin
                </button>
              ) : (
                <button disabled
                  className="mt-2 h-9 cursor-not-allowed rounded-full border border-dashed border-line px-4 text-[12.5px] font-bold text-soft">
                  ✏️ Chỉnh sửa thông tin
                </button>
              )}
            </div>
          )}
        </Panel>

        <Panel title="Bảo mật" hint="2FA, phiên đăng nhập, mật khẩu">
          <div className="flex flex-col gap-2">
            <Row2 title="Xác thực 2 yếu tố (MFA)" sub="Bảo vệ tài khoản bằng Authenticator"
              right={<Chip tone={mfa ? "green" : "amber"}>{mfa ? "Đã bật" : "Chưa bật"}</Chip>}
              action={<button disabled className="h-8 cursor-not-allowed rounded-md border border-dashed border-line px-3 text-[11.5px] font-bold text-soft">Cài đặt</button>} />
            <Row2 title="Đổi mật khẩu" sub="Đổi mật khẩu đăng nhập"
              action={
                <button onClick={() => supabase?.auth.resetPasswordForEmail(displayEmail, { redirectTo: window.location.origin + "/profile" })}
                  disabled={isDemo}
                  className={`h-8 rounded-md px-3 text-[11.5px] font-bold ${isDemo ? "cursor-not-allowed border border-dashed border-line text-soft" : "border border-line bg-card text-muted hover:border-accent"}`}>
                  Gửi link reset
                </button>
              } />
            <Row2 title="Phiên đăng nhập" sub="Quản lý các thiết bị đang đăng nhập"
              action={<button disabled className="h-8 cursor-not-allowed rounded-md border border-dashed border-line px-3 text-[11.5px] font-bold text-soft">Quản lý</button>} />
          </div>
        </Panel>

        <Panel title="Tùy chọn" hint="giao diện + ngôn ngữ + thông báo">
          <div className="flex flex-col gap-3 text-[13px]">
            <Row label="Ngôn ngữ" value="Tiếng Việt" />
            <Row label="Múi giờ" value="Asia/Ho_Chi_Minh (GMT+7)" />
            <Row label="Tiền tệ hiển thị" value="USD ($)" />
            <Row label="Email cảnh báo quan trọng" value="Bật" />
            <Row label="Email báo cáo hàng ngày" value="Tắt (chỉ in-app)" />
          </div>
        </Panel>

        <Panel title="Phiên làm việc hiện tại">
          <div className="flex flex-col gap-2 text-[13px]">
            <div className="flex justify-between">
              <span className="text-soft">Chế độ</span>
              <Chip tone={isDemo ? "amber" : "green"}>{isDemo ? "DEMO" : "SUPABASE"}</Chip>
            </div>
            <div className="flex justify-between">
              <span className="text-soft">Đang xem vai trò</span>
              <span className="font-semibold">{PERSONAS[session.persona].label}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-soft">User ID</span>
              <span className="font-mono text-[11.5px]">{session.userId ? session.userId.slice(0, 12) + "…" : "(demo)"}</span>
            </div>
            <div className="mt-2 rounded-[8px] bg-bg px-3 py-2 text-[11.5px] text-soft">
              {isDemo
                ? "Đang ở DEMO MODE — dữ liệu mẫu. Đăng nhập Supabase để xem dữ liệu thật."
                : "Kết nối đến project pitmyzovjwflkyoqjbkz. Các chức năng 2FA / quản lý phiên / đổi ảnh đại diện sẽ mở ở bản kế tiếp."}
            </div>
          </div>
        </Panel>

        <div className="lg:col-span-2">
          <Panel title="Đăng xuất">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-[13px] text-muted">
                Đăng xuất khỏi thiết bị này. {!isDemo ? "Sẽ xóa phiên trên Supabase Auth." : ""}
              </div>
              <button onClick={logout}
                className="h-10 rounded-full bg-red px-5 text-[13px] font-extrabold text-white transition hover:bg-[#a01717]">
                Đăng xuất
              </button>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-[#f0f2f6] pb-2 last:border-0">
      <span className="text-soft">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

function Row2({ title, sub, right, action }:
  { title: string; sub: string; right?: React.ReactNode; action: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between rounded-[10px] border border-line px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-[13px] font-bold">{title}</div>
        <div className="text-[12px] text-soft">{sub}</div>
      </div>
      <div className="ml-3 flex shrink-0 items-center gap-2">{right}{action}</div>
    </div>
  );
}
