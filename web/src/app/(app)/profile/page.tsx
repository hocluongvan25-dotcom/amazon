import { Chip, NoAccess, PageHeader, Panel } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { profileByPersona } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";

/**
 * Trang cá nhân — mọi role đều truy cập được (chỉ xem/chỉnh sửa thông tin của mình).
 * Ở DEMO MODE: dữ liệu theo persona; ở SUPABASE MODE: lấy từ auth.users + iam.user_profiles.
 */
export default async function ProfilePage() {
  const session = await requireSession();
  const profile = profileByPersona[session.persona];

  return (
    <>
      <PageHeader
        title="Trang cá nhân"
        desc="Thông tin tài khoản, bảo mật, và tùy chọn cá nhân. Chỉ bạn và Admin mới xem được trang này."
      />

      <div className="mb-4 rounded-[13px] border border-line bg-card px-5 py-5">
        <div className="flex flex-wrap items-center gap-4">
          <div className="grid h-[72px] w-[72px] shrink-0 place-items-center rounded-full bg-[#dfe6f3] text-[26px] font-extrabold text-[#3c4a63]">
            {profile.avatarInitials}
          </div>
          <div>
            <div className="text-[20px] font-extrabold">{profile.name}</div>
            <div className="mt-0.5 text-[13px] text-muted">{profile.email}</div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Chip tone="blue">{profile.role}</Chip>
              <Chip tone="gray">{profile.department}</Chip>
              <Chip tone={profile.mfaEnabled ? "green" : "amber"}>
                {profile.mfaEnabled ? "Đã bật 2FA" : "Chưa bật 2FA"}
              </Chip>
            </div>
          </div>
          <button
            type="button"
            disabled
            title="Chỉnh sửa ảnh (sau khi tích hợp Supabase Storage)"
            className="ml-auto cursor-not-allowed rounded-full border border-dashed border-line px-4 py-2 text-[12.5px] font-bold text-soft"
          >
            📷 Đổi ảnh đại diện
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Thông tin cá nhân" hint="sẽ đồng bộ với Supabase Auth">
          <div className="flex flex-col gap-3 text-[13px]">
            {[
              ["Họ và tên", profile.name],
              ["Email", profile.email],
              ["Số điện thoại", profile.phone],
              ["Vai trò", profile.role],
              ["Phòng ban", profile.department],
              ["Ngày tham gia", profile.joinedAt],
              ["Đăng nhập lần cuối", profile.lastLogin],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between border-b border-[#f0f2f6] pb-2 last:border-0">
                <span className="text-soft">{k}</span>
                <span className="font-semibold">{v}</span>
              </div>
            ))}
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
            <div className="flex items-center justify-between rounded-[10px] border border-line px-3 py-2.5">
              <div>
                <div className="text-[13px] font-bold">Xác thực 2 yếu tố (MFA)</div>
                <div className="text-[12px] text-soft">Bảo vệ tài khoản bằng ứng dụng Authenticator</div>
              </div>
              <Chip tone={profile.mfaEnabled ? "green" : "amber"}>
                {profile.mfaEnabled ? "Đã bật" : "Chưa bật"}
              </Chip>
            </div>
            <div className="flex items-center justify-between rounded-[10px] border border-line px-3 py-2.5">
              <div>
                <div className="text-[13px] font-bold">Đổi mật khẩu</div>
                <div className="text-[12px] text-soft">Đổi mật khẩu đăng nhập</div>
              </div>
              <button disabled className="h-8 cursor-not-allowed rounded-md border border-dashed border-line px-3 text-[11.5px] font-bold text-soft">
                Đổi mật khẩu
              </button>
            </div>
            <div className="flex items-center justify-between rounded-[10px] border border-line px-3 py-2.5">
              <div>
                <div className="text-[13px] font-bold">Phiên đăng nhập</div>
                <div className="text-[12px] text-soft">Quản lý các thiết bị đang đăng nhập</div>
              </div>
              <button disabled className="h-8 cursor-not-allowed rounded-md border border-dashed border-line px-3 text-[11.5px] font-bold text-soft">
                Quản lý
              </button>
            </div>
          </div>
        </Panel>

        <Panel title="Tùy chọn" hint="giao diện + ngôn ngữ + thông báo">
          <div className="flex flex-col gap-3 text-[13px]">
            {[
              ["Ngôn ngữ", "Tiếng Việt"],
              ["Múi giờ", "Asia/Ho_Chi_Minh (GMT+7)"],
              ["Tiền tệ hiển thị", "USD ($)"],
              ["Email cảnh báo quan trọng", "Bật"],
              ["Email báo cáo hàng ngày", "Tắt (chỉ in-app)"],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between border-b border-[#f0f2f6] pb-2 last:border-0">
                <span className="text-soft">{k}</span>
                <span className="font-semibold">{v}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Phiên làm việc hiện tại" hint="demo/supabase mode">
          <div className="flex flex-col gap-2 text-[13px]">
            <div className="flex justify-between">
              <span className="text-soft">Chế độ</span>
              <Chip tone={session.mode === "demo" ? "amber" : "green"}>
                {session.mode === "demo" ? "DEMO" : "SUPABASE"}
              </Chip>
            </div>
            <div className="flex justify-between">
              <span className="text-soft">User ID</span>
              <span className="font-mono text-[11.5px]">
                {session.userId ? session.userId.slice(0, 12) + "…" : "(demo)"}
              </span>
            </div>
            <div className="mt-2 rounded-[8px] bg-bg px-3 py-2 text-[11.5px] text-soft">
              Các chức năng chỉnh sửa (đổi mật khẩu, đổi ảnh, chỉnh thông tin, bật MFA) sẽ mở khi
              chuyển sang SUPABASE MODE và có Supabase Auth hoạt động đầy đủ.
            </div>
          </div>
        </Panel>
      </div>
    </>
  );
}
