"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { APP_ROLES, DEPARTMENTS, SHOPS } from "@/lib/data/mock";
import { Chip } from "@/components/ui";

/**
 * Form tạo nhân viên mới.
 * Ở DEMO MODE: submit hiện thông báo thành công (chưa ghi DB).
 * Ở SUPABASE MODE: server action tạo user trong auth.users + bản ghi iam.user_profiles + role_assignments,
 * rồi gửi email mời đặt mật khẩu.
 */
export default function NewUserForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState(APP_ROLES[3].id); // mặc định operator
  const [dept, setDept] = useState<string>(DEPARTMENTS[3]);
  const [selectedShops, setSelectedShops] = useState<string[]>([]);
  const [sendInvite, setSendInvite] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roleObj = APP_ROLES.find((r) => r.id === role)!;

  function toggleShop(s: string) {
    setSelectedShops((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );
  }

  function canAssign(assigningRole: (typeof APP_ROLES)[number]["id"]) {
    // Super-admin demo có mọi quyền; ở SUPABASE MODE sẽ đọc từ session.roleLevel
    return roleObj.canAssignTo.includes(assigningRole) || roleObj.id === "super_admin";
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Vui lòng nhập họ tên");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setError("Email không hợp lệ");
    if (selectedShops.length === 0 && role !== "super_admin")
      return setError("Vui lòng chọn ít nhất 1 shop được gán");

    setSubmitting(true);
    // DEMO: giả lập tạo thành công sau 600ms. SUPABASE: gọi server action.
    await new Promise((r) => setTimeout(r, 600));
    setSubmitting(false);
    setDone(true);
  }

  if (done) {
    return (
      <div className="rounded-[13px] border-2 border-green/40 bg-green-soft px-5 py-6">
        <div className="text-3xl">✅</div>
        <div className="mt-2 text-[16px] font-extrabold text-[#0b7a55]">Đã tạo tài khoản thành công</div>
        <div className="mt-1 text-[13px] text-[#0b7a55]">
          <b>{name}</b> · {email} · vai trò <b>{roleObj.label}</b>
          {selectedShops.length > 0 ? (
            <>
              {" "}· {selectedShops.length} shop
            </>
          ) : null}
        </div>
        {sendInvite ? (
          <div className="mt-1 text-[12px] text-[#0b7a55]">
            Email mời đã được gửi đến <b>{email}</b> (sẽ hoạt động khi bật SUPABASE MODE).
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            onClick={() => router.push("/module0/users")}
            className="h-9 rounded-full bg-green px-4 py-2 text-[12.5px] font-extrabold text-white hover:bg-[#0b7a55]"
          >
            Về danh sách người dùng →
          </button>
          <button
            onClick={() => {
              setDone(false);
              setName("");
              setEmail("");
              setPhone("");
              setSelectedShops([]);
            }}
            className="h-9 rounded-full border border-line bg-card px-4 py-2 text-[12.5px] font-bold text-muted"
          >
            ＋ Tạo tiếp người dùng
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <section className="rounded-[13px] border border-line bg-card px-[18px] py-4">
          <h3 className="mb-3 text-[14.5px] font-bold">1. Thông tin cơ bản</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Họ và tên *">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nguyễn Văn A"
                className="h-9 w-full rounded-[9px] border border-line bg-card px-3 text-[13px] font-semibold outline-none focus:border-accent"
              />
            </Field>
            <Field label="Email *">
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                type="email"
                placeholder="vana@vexim.vn"
                className="h-9 w-full rounded-[9px] border border-line bg-card px-3 text-[13px] font-semibold outline-none focus:border-accent"
              />
            </Field>
            <Field label="Số điện thoại">
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+84 ..."
                className="h-9 w-full rounded-[9px] border border-line bg-card px-3 text-[13px] font-semibold outline-none focus:border-accent"
              />
            </Field>
            <Field label="Phòng ban">
              <select
                value={dept}
                onChange={(e) => setDept(e.target.value)}
                className="h-9 w-full rounded-[9px] border border-line bg-card px-3 text-[13px] font-semibold outline-none focus:border-accent"
              >
                {DEPARTMENTS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </section>

        <section className="mt-4 rounded-[13px] border border-line bg-card px-[18px] py-4">
          <h3 className="mb-3 text-[14.5px] font-bold">2. Vai trò hệ thống</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {APP_ROLES.map((r) => {
              const active = role === r.id;
              const disabled = !canAssign(r.id) && r.id !== role;
              return (
                <label
                  key={r.id}
                  className={`flex cursor-pointer flex-col gap-1 rounded-[10px] border p-3 transition ${
                    active
                      ? "border-accent bg-accent-soft"
                      : disabled
                        ? "cursor-not-allowed border-dashed border-line opacity-50"
                        : "border-line hover:border-accent"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="role"
                      value={r.id}
                      checked={active}
                      disabled={disabled}
                      onChange={() => setRole(r.id)}
                      className="accent-accent"
                    />
                    <span className="text-[13px] font-bold">{r.label}</span>
                    <span className="ml-auto rounded-full bg-bg px-2 py-0.5 text-[10px] font-extrabold text-soft">
                      lv {r.level}
                    </span>
                  </div>
                  <div className="pl-6 text-[11.5px] text-soft">{r.desc}</div>
                </label>
              );
            })}
          </div>
          <p className="mt-2 text-[11.5px] font-semibold text-soft">
            Vai trò hiện tại (Super Admin demo) có thể gán mọi cấp. Khi vận hành thật: bạn chỉ có thể
            gán vai trò cấp THẤP hơn vai trò của bạn.
          </p>
        </section>

        <section className="mt-4 rounded-[13px] border border-line bg-card px-[18px] py-4">
          <h3 className="mb-3 text-[14.5px] font-bold">3. Phạm vi shop được gán</h3>
          <div className="mb-2 flex flex-wrap gap-2">
            {SHOPS.map((s) => {
              const active = selectedShops.includes(s);
              return (
                <button
                  type="button"
                  key={s}
                  onClick={() => toggleShop(s)}
                  disabled={role === "super_admin"}
                  className={`rounded-full border px-3.5 py-1.5 text-[12.5px] font-bold transition ${
                    active
                      ? "border-accent bg-accent-soft text-accent-ink"
                      : role === "super_admin"
                        ? "cursor-not-allowed border-dashed border-line text-soft"
                        : "border-line bg-card text-muted hover:border-accent"
                  }`}
                >
                  {active ? "✓ " : ""}
                  {s}
                </button>
              );
            })}
          </div>
          <p className="text-[11.5px] text-soft">
            Super Admin tự động có quyền mọi shop — không cần chọn. Client Viewer phải được gán vào
            chính xác shop của khách hàng họ đại diện.
          </p>
        </section>
      </div>

      <div className="lg:col-span-1">
        <section className="sticky top-20 rounded-[13px] border border-line bg-card px-[18px] py-4">
          <h3 className="mb-3 text-[14.5px] font-bold">Xác nhận</h3>
          <div className="flex flex-col gap-2 text-[12.5px]">
            <Sum label="Họ tên" value={name || "—"} />
            <Sum label="Email" value={email || "—"} />
            <Sum label="Phòng" value={dept} />
            <Sum
              label="Vai trò"
              value={
                <span>
                  <Chip tone="blue">{roleObj.label}</Chip>
                </span>
              }
            />
            <Sum
              label="Shop"
              value={
                selectedShops.length === 0 && role === "super_admin"
                  ? "Tất cả (14 shop)"
                  : selectedShops.length === 0
                    ? "—"
                    : `${selectedShops.length} shop đã chọn`
              }
            />
          </div>

          <label className="mt-3 flex items-start gap-2 text-[12.5px]">
            <input
              type="checkbox"
              checked={sendInvite}
              onChange={(e) => setSendInvite(e.target.checked)}
              className="mt-0.5 accent-accent"
            />
            <span>
              Gửi email mời đến <b>{email || "địa chỉ trên"}</b> để người dùng tự đặt mật khẩu
            </span>
          </label>

          {error ? (
            <div className="mt-3 rounded-[8px] bg-red-soft px-3 py-2 text-[12px] font-bold text-[#a01717]">
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={submitting}
            className="mt-4 h-10 w-full rounded-full bg-accent text-[13px] font-extrabold text-white transition hover:bg-accent-ink disabled:opacity-60"
          >
            {submitting ? "Đang tạo…" : "Tạo tài khoản"}
          </button>
          <button
            type="button"
            onClick={() => router.push("/module0/users")}
            className="mt-2 h-9 w-full rounded-full border border-line bg-card text-[12.5px] font-bold text-muted"
          >
            Hủy
          </button>
        </section>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11.5px] font-bold uppercase tracking-wide text-soft">{label}</span>
      {children}
    </label>
  );
}

function Sum({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-[#f0f2f6] pb-1.5 last:border-0">
      <span className="text-soft">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}
