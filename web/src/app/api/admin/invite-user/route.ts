import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/admin/invite-user
 * Body: { email, displayName, phone?, role, departmentCode?, shopIds: uuid[] }
 * Server-side route dùng SUPABASE_SERVICE_ROLE_KEY để mời user qua Auth +
 * tạo bản ghi iam.user_profiles / iam.role_assignments / iam.assignments.
 *
 * Bảo mật:
 * 1. Người gọi phải đăng nhập
 * 2. Người gọi phải có role super_admin hoặc org_admin (policy sẽ chặn ở client check)
 * 3. Không cho phép gán role cao hơn role của chính mình
 */
export async function POST(req: Request) {
  try {
    const supabase = await createClient();
    if (!supabase) {
      return NextResponse.json({ error: "Supabase chưa cấu hình" }, { status: 500 });
    }

    // 1. Xác định caller
    const {
      data: { user },
      error: uerr,
    } = await supabase.auth.getUser();
    if (uerr || !user) {
      return NextResponse.json({ error: "Chưa đăng nhập" }, { status: 401 });
    }

    // 2. Kiểm tra caller có quyền admin
    const { data: myRoles } = await supabase
      .schema("iam").from("role_assignments")
      .select("role")
      .eq("user_id", user.id);
    const myRoleSet = new Set((myRoles ?? []).map((r) => r.role as string));
    const isSuper = myRoleSet.has("super_admin");
    const isOrg = myRoleSet.has("org_admin");
    const isDeptLead = myRoleSet.has("dept_lead");
    if (!isSuper && !isOrg && !isDeptLead) {
      return NextResponse.json({ error: "Không có quyền" }, { status: 403 });
    }

    // 3. Parse body
    const body = await req.json();
    const {
      email,
      displayName,
      phone = null,
      role,
      departmentCode = null,
      shopIds = [],
    } = body ?? {};

    if (!email || !displayName || !role) {
      return NextResponse.json({ error: "Thiếu thông tin bắt buộc (email, tên, vai trò)" }, { status: 400 });
    }
    if (!["super_admin", "org_admin", "dept_lead", "operator", "analyst", "client_viewer"].includes(role)) {
      return NextResponse.json({ error: "Vai trò không hợp lệ" }, { status: 400 });
    }
    // Rule: không được gán role cao hơn mình
    const canAssign: Record<string, string[]> = {
      super_admin: ["super_admin", "org_admin", "dept_lead", "operator", "analyst", "client_viewer"],
      org_admin: ["dept_lead", "operator", "analyst", "client_viewer"],
      dept_lead: ["operator", "analyst"],
      operator: [],
      analyst: [],
      client_viewer: [],
    };
    const myHighest = isSuper ? "super_admin" : isOrg ? "org_admin" : "dept_lead";
    if (!canAssign[myHighest].includes(role)) {
      return NextResponse.json({ error: "Bạn không có quyền gán vai trò này" }, { status: 403 });
    }

    // 4. Dùng admin client để mời (cần service_role key) — server-side bypass RLS
    // Lưu ý: chỉ được gọi từ server; không đưa service_role ra client.
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
      return NextResponse.json({ error: (e as { msg?: string }).msg ?? "Lỗi mời người dùng" }, { status: adminAuth.status });
    }
    const invited = (await adminAuth.json()) as { id: string };
    const newUserId = invited.id;

    // 5. Tạo bản ghi iam.user_profiles
    const { error: pErr } = await supabase.schema("iam").from("user_profiles").insert({
      id: newUserId,
      display_name: displayName,
      email,
      phone,
      vexim_employee: role !== "client_viewer",
      org_id: null, // TODO: nếu là org_admin/dept_lead sẽ gán org_id của caller; hiện tại giả định VEXIM nhân viên
    });
    if (pErr) {
      return NextResponse.json({ error: `Tạo profile thất bại: ${pErr.message}` }, { status: 500 });
    }

    // 6. Tìm department_id theo code (nếu có)
    let deptId: string | null = null;
    if (departmentCode) {
      const { data: dept } = await supabase
        .schema("iam").from("departments")
        .select("id")
        .eq("code", departmentCode)
        .maybeSingle();
      deptId = dept?.id ?? null;
    }

    // 7. Gán role
    const { error: rErr } = await supabase.schema("iam").from("role_assignments").insert({
      user_id: newUserId,
      role,
      department_id: deptId,
    });
    if (rErr) {
      return NextResponse.json({ error: `Gán vai trò thất bại: ${rErr.message}` }, { status: 500 });
    }

    // 8. Gán shop (nếu có)
    if (Array.isArray(shopIds) && shopIds.length > 0) {
      const { error: aErr } = await supabase.schema("iam").from("assignments").insert(
        shopIds.map((sellerId: string) => ({
          user_id: newUserId,
          seller_account_id: sellerId,
          module: "account_health", // module mặc định; sẽ cấp bổ sung theo phòng sau
          can_write: role === "operator" || role === "dept_lead" || role === "org_admin" || role === "super_admin",
          assigned_by: user.id,
        })),
      );
      if (aErr) {
        return NextResponse.json({ error: `Gán shop thất bại: ${aErr.message}` }, { status: 500 });
      }
    }

    // 9. Ghi audit
    try {
      await supabase.schema("iam").from("audit_logs").insert({
        actor_id: user.id,
        module: "account_health",
        action: "user.invite",
        entity: newUserId,
        after_value: { email, role, departmentCode, shopIds },
        result: "ok",
      });
    } catch { /* bỏ lỗi audit không block */ }

    return NextResponse.json({ ok: true, userId: newUserId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
