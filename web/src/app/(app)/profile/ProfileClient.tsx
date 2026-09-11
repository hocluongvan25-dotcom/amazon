"use client";

import { useRouter } from "next/navigation";
import { Chip, Panel } from "@/components/ui";
import { profileByPersona } from "@/lib/data/mock";
import { PERSONAS } from "@/lib/roles";
import type { Session } from "@/lib/auth/session";
import type { Profile } from "@/lib/types";

/**
 * Trang cá nhân.
 * - DEMO MODE: hiển thị theo persona đang chọn (dữ liệu cứng trong mock)
 * - SUPABASE MODE: lấy email/userId từ auth; các trường role/phòng/MFA sẽ đọc từ bảng
 *   iam.user_profiles khi migration đẩy lên project Supabase của VEXIM (hiện tại server
 *   tạm coi mọi user đăng nhập là ceo — xem lib/auth/session.ts).
 */
export default function ProfileClient({ session }: { session: Session }) {
  const router = useRouter();
  const isDemo = session.mode === "demo";

  // Dữ liệu hiển thị: ở demo lấy từ mock theo persona; ở supabase ưu tiên email/userId thật
  const mock: Profile = profileByPersona[session.persona];
  const displayName = isDemo || !session.email ? mock.name : session.email.split("@")[0];
  const displayEmail = session.email ?? mock.email;
  const avatarInitial = (isDemo ? mock.avatarInitials : (session.email?.slice(0, 2).toUpperCase() ?? "NA"));

  async function logout() {
    try {
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      if (supabase) await supabase.auth.signOut();
    } catch {
      /* ignore */
    }
    document.cookie = "demo_role=; path=/; max-age=0";
    window.location.href = "/login";
  }

  return (
    <>
      <div className="mb-4 rounded-[13px] border border-line bg-card px-5 py-5">
        <div className="flex flex-wrap items-center gap-4">
          <div className="grid h-[72px] w-[72px] shrink-0 place-items-center rounded-full bg-[#dfe6f3] text-[26px] font-extrabold text-[#3c4a63]">
            {avatarInitial}
          </div>
          <div>
            <div className="text-[20px] font-extrabold">{displayName}</div>
            <div className="mt-0.5 text-[13px] text-muted">{displayEmail}</div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Chip tone="blue">{isDemo ? mock.role : "Đồng bộ vai trò sau"}</Chip>
              <Chip tone="gray">{isDemo ? mock.department : "—"}</Chip>
              <Chip tone={!isDemo ? "green" : mock.mfaEnabled ? "green" : "amber"}>
                {!isDemo ? "Đã đăng nhập" : mock.mfaEnabled ? "Đã bật 2FA" : "Chưa bật 2FA"}
              </Chip>
              {!isDemo ? (
                <Chip tone="amber">Chưa đồng bộ iam.user_profiles</Chip>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            disabled
            title="Đổi ảnh đại diện — sẽ mở sau khi tích hợp Supabase Storage"
            className="ml-auto cursor-not-allowed rounded-full border border-dashed border-line px-4 py-2 text-[12.5px] font-bold text-soft"
          >
            📷 Đổi ảnh đại diện
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Thông tin cá nhân" hint={isDemo ? "dữ liệu demo" : "từ Supabase Auth"}>
          <div className="flex flex-col gap-3 text-[13px]">
            <Row label="Họ và tên" value={displayName} />
            <Row label="Email" value={displayEmail} />
            <Row label="Số điện thoại" value={isDemo ? mock.phone : "—"} />
            <Row label="Vai trò" value={isDemo ? mock.role : "(sẽ đọc từ iam.role_assignments)"} />
            <Row label="Phòng ban" value={isDemo ? mock.department : "—"} />
            <Row label="Ngày tham gia" value={isDemo ? mock.joinedAt : "—"} />
            <Row label="Đăng nhập lần cuối" value={isDemo ? mock.lastLogin : "vừa xong"} />
            <button
              disabled
              className="mt-2 h-9 cursor-not-allowed rounded-full border border-dashed border-line px-4 text-[12.5px] font-bold text-soft"
            >
              ✏️ Chỉnh sửa thông tin
            </button>
          </div>
        </Panel>

        <Panel title="Bảo mật" hint="2FA, phiên đăng nhập, mật khẩu">
          <div className="flex flex-col gap-2">
            <Row2
              title="Xác thực 2 yếu tố (MFA)"
              sub="Bảo vệ tài khoản bằng ứng dụng Authenticator"
              right={
                <Chip tone={isDemo && mock.mfaEnabled ? "green" : "amber"}>
                  {isDemo && mock.mfaEnabled ? "Đã bật" : "Chưa bật"}
                </Chip>
              }
              action={
                <button disabled className="h-8 cursor-not-allowed rounded-md border border-dashed border-line px-3 text-[11.5px] font-bold text-soft">
                  Cài đặt
                </button>
              }
            />
            <Row2
              title="Đổi mật khẩu"
              sub="Đổi mật khẩu đăng nhập"
              action={
                <button disabled className="h-8 cursor-not-allowed rounded-md border border-dashed border-line px-3 text-[11.5px] font-bold text-soft">
                  Đổi mật khẩu
                </button>
              }
            />
            <Row2
              title="Phiên đăng nhập"
              sub="Quản lý các thiết bị đang đăng nhập"
              action={
                <button disabled className="h-8 cursor-not-allowed rounded-md border border-dashed border-line px-3 text-[11.5px] font-bold text-soft">
                  Quản lý
                </button>
              }
            />
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

        <Panel title="Phiên làm việc hiện tại" hint="demo/supabase mode">
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
              <span className="font-mono text-[11.5px]">
                {session.userId ? session.userId.slice(0, 12) + "…" : "(demo)"}
              </span>
            </div>
            {isDemo ? (
              <div className="mt-2 rounded-[8px] bg-amber-soft px-3 py-2 text-[11.5px] text-[#8a5602]">
                Đang ở DEMO MODE — dữ liệu trên trang này là mẫu. Đăng nhập bằng Supabase để
                xem thông tin tài khoản thật.
              </div>
            ) : (
              <div className="mt-2 rounded-[8px] bg-bg px-3 py-2 text-[11.5px] text-soft">
                Các chức năng chỉnh sửa (đổi mk/ảnh/2FA/MFA/phân quyền) sẽ hoạt động sau khi đẩy
                3 migrations + bảng <code>iam.user_profiles</code> lên project Supabase
                <b> pitmyzovjwflkyoqjbkz</b> và bổ sung server actions tương ứng.
              </div>
            )}
          </div>
        </Panel>

        <div className="lg:col-span-2">
          <Panel title="Đăng xuất">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-[13px] text-muted">
                Đăng xuất khỏi thiết bị này. Bạn sẽ cần đăng nhập lại để tiếp tục.
                {!isDemo ? " Sẽ xóa phiên trên Supabase Auth." : ""}
              </div>
              <button
                onClick={logout}
                className="h-10 rounded-full bg-red px-5 text-[13px] font-extrabold text-white transition hover:bg-[#a01717]"
              >
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

function Row2({
  title, sub, right, action,
}: { title: string; sub: string; right?: React.ReactNode; action: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between rounded-[10px] border border-line px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-[13px] font-bold">{title}</div>
        <div className="text-[12px] text-soft">{sub}</div>
      </div>
      <div className="ml-3 flex shrink-0 items-center gap-2">
        {right}
        {action}
      </div>
    </div>
  );
}
