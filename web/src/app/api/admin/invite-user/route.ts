import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/admin/invite-user
 * Body: { email, displayName, phone?, role, departmentCode?, shopIds: uuid[] }
 *
 * VIỆC CỦA ROUTE NÀY CHỈ CÒN MỘT NỬA (sửa 13/09/2026):
 *   1. Mời tài khoản qua GoTrue admin API — bắt buộc dùng SUPABASE_SERVICE_ROLE_KEY
 *      (chỉ có ở server; không bao giờ gửi ra client).
 *   2. Ghi hồ sơ + vai trò + shop + audit bằng RPC `public.vexim_admin_grant_invited_user`
 *      (migration 0022) chạy bằng CHÍNH phiên của người gọi.
 *
 * VÌ SAO ĐỔI: bản cũ tự kiểm vai trò ở route rồi INSERT thẳng vào
 * `iam.user_profiles`/`role_assignments`/`assignments` bằng client của người dùng.
 * Hai lỗ hổng: (a) role `authenticated` KHÔNG được GRANT insert/update trên các
 * bảng đó (0001 chỉ grant select) ⇒ luồng mời hỏng trong production; (b) luật
 * "được gán vai trò nào" nằm ở route nên có hai nguồn sự thật. Nay luật nằm ở DB:
 * `iam.is_user_admin()` + cấp bậc + phòng ban, route không tự quyết gì thêm.
 */

export async function POST(req: Request) {
  try {
    const supabase = await createClient();
    if (!supabase) {
      return NextResponse.json({ error: "Supabase chưa cấu hình" }, { status: 500 });
    }

    // 1. Người gọi phải đang đăng nhập
    const {
      data: { user },
      error: uerr,
    } = await supabase.auth.getUser();
    if (uerr || !user) {
      return NextResponse.json({ error: "Chưa đăng nhập" }, { status: 401 });
    }

    // 2. Đọc tham số
    const body = await req.json().catch(() => null);
    const {
      email,
      displayName,
      phone = null,
      role,
      departmentCode = null,
      shopIds = [],
    } = (body ?? {}) as {
      email?: string;
      displayName?: string;
      phone?: string | null;
      role?: string;
      departmentCode?: string | null;
      shopIds?: string[];
    };

    if (!email || !displayName || !role) {
      return NextResponse.json(
        { error: "Thiếu thông tin bắt buộc (email, tên, vai trò)" },
        { status: 400 },
      );
    }
    const ROLES = [
      "super_admin",
      "org_admin",
      "dept_lead",
      "operator",
      "analyst",
      "client_viewer",
    ];
    if (!ROLES.includes(role)) {
      return NextResponse.json({ error: "Vai trò không hợp lệ" }, { status: 400 });
    }

    // 3. Mời qua GoTrue (cần service_role — chỉ ở server)
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      return NextResponse.json({ error: "Chưa cấu hình SUPABASE_SERVICE_ROLE_KEY" }, { status: 500 });
    }
    const adminAuth = await fetch(`${url}/auth/v1/invite`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ email }),
    });
    if (!adminAuth.ok) {
      const e = await adminAuth.json().catch(() => ({}));
      return NextResponse.json(
        { error: (e as { msg?: string }).msg ?? "Lỗi mời người dùng" },
        { status: adminAuth.status },
      );
    }
    const invited = (await adminAuth.json()) as { id: string };
    const newUserId = invited.id;

    // 4. Hồ sơ + vai trò + shop + audit — do DB quyết định (RPC security definer)
    const { data, error } = await supabase.rpc("vexim_admin_grant_invited_user", {
      p_user_id: newUserId,
      p_email: email,
      p_display_name: displayName,
      p_phone: phone,
      p_role: role,
      p_department: departmentCode,
      p_shop_ids: Array.isArray(shopIds) ? shopIds : [],
    });

    if (error) {
      const raw = (error.message ?? "").replace(/^\[M0\]\s*/, "");
      const status = error.code === "42501" ? 403 : error.code === "22023" ? 400 : 500;
      // Tài khoản auth đã tạo nhưng chưa gán được quyền ⇒ nói rõ để không ai
      // tưởng là xong (hồ sơ có thể được cấp quyền lại ở nút "Quyền").
      return NextResponse.json(
        {
          error: raw || "Không gán được quyền",
          hint: "Tài khoản đăng nhập đã được tạo nhưng CHƯA có quyền — mở danh sách Người dùng để cấp lại.",
          userId: newUserId,
        },
        { status },
      );
    }

    const row = (Array.isArray(data) ? data[0] : undefined) as { message?: string } | undefined;
    return NextResponse.json({ ok: true, userId: newUserId, message: row?.message ?? "Đã tạo tài khoản." });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
