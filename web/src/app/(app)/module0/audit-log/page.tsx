import { Chip, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { isForbidden, type AdminAuditRow } from "@/lib/data/users-admin";
import { auditActionLabel, auditDiff, relativeTime } from "@/lib/users-model";
import type { PersonaKey } from "@/lib/roles";
import AuditLogBoard from "./AuditLogBoard";

const DEMO_ALLOWED: PersonaKey[] = ["ceo"];

async function readAuditSnapshot(limit = 200): Promise<
  | { ok: true; audit: AdminAuditRow[] }
  | { ok: false; message: string }
> {
  const client = await createClient();
  if (!client) return { ok: false, message: "Chưa cấu hình Supabase (chế độ demo)." };

  const { data, error } = await client.rpc("vexim_admin_audit", { p_limit: limit });
  if (error) {
    const msg = error.message || "Không đọc được nhật ký.";
    return { ok: false, message: isForbidden(msg) ? "Bạn không phải admin người dùng." : msg };
  }

  const audit: AdminAuditRow[] = ((data ?? []) as unknown as {
    id: string;
    created_at: string | null;
    actor_name: string | null;
    actor_email: string | null;
    action: string;
    entity: string | null;
    before_value: Record<string, unknown> | null;
    after_value: Record<string, unknown> | null;
    result: string | null;
  }[]).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    actorName: r.actor_name,
    actorEmail: r.actor_email,
    action: r.action,
    entity: r.entity,
    beforeValue: r.before_value,
    afterValue: r.after_value,
    result: r.result,
  }));

  return { ok: true, audit };
}

export default async function AuditLogPage() {
  const session = await requireSession();

  // SUPABASE MODE
  if (session.mode === "supabase") {
    const snapshot = await readAuditSnapshot(200);
    if (!snapshot.ok) {
      return (
        <>
          <PageHeader
            title="Nhật ký thao tác (audit log)"
            sub="iam.audit_logs · append-only · module iam"
            desc="Toàn bộ thao tác quản trị người dùng và vận hành được ghi append-only, không cho update/delete. Chỉ Super Admin / Org Admin được xem."
          />
          <NoAccess />
          <Panel title="Vì sao bị chặn" hint="thông điệp từ database">
            <p className="text-[12.5px] text-muted">{snapshot.message}</p>
            <p className="mt-2 text-[12px] text-soft">
              Quyền xem nhật ký do <code>iam.is_user_admin()</code> quyết định (migration 0022). Nếu bạn là admin mà vẫn bị chặn, kiểm tra lại vai trò trong <code>iam.role_assignments</code>.
            </p>
          </Panel>
        </>
      );
    }

    return (
      <>
        <PageHeader
          title="Nhật ký thao tác (audit log)"
          sub={`${snapshot.audit.length} bản ghi gần nhất · iam.audit_logs · append-only`}
          desc="Toàn bộ thao tác ghi ra Amazon (đổi giá, sửa listing, chỉnh campaign) và thao tác quản trị người dùng (mời, đổi vai trò, khóa) đều ghi: ai · lúc nào · giá trị trước/sau · kết quả. Bảng không cho update/delete — đây là nguồn sự thật cuối cùng."
        />
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <a
            href="/module0/users"
            className="rounded-full border border-line bg-card px-4 py-1.5 text-[12.5px] font-bold text-muted transition hover:border-accent hover:text-accent-ink"
          >
            ← Người dùng & phân quyền
          </a>
          <span className="text-[12px] text-soft">
            Nhật ký đã được tách khỏi trang Người dùng để tránh trang dài hàng trăm dòng khi có nhiều thao tác.
          </span>
        </div>
        <AuditLogBoard audit={snapshot.audit} demo={false} />
      </>
    );
  }

  // DEMO MODE
  if (!DEMO_ALLOWED.includes(session.persona)) return <NoAccess />;

  return (
    <>
      <PageHeader
        title="Nhật ký thao tác (audit log)"
        sub="chế độ demo — không có nhật ký thật"
        desc="Toàn bộ thao tác ghi ra Amazon và quản trị người dùng đều ghi vào iam.audit_logs (append-only). Chế độ demo không có kết nối Supabase nên bảng để trống; đăng nhập bằng tài khoản thật để xem nhật ký."
      />
      <div className="mb-4 rounded-[13px] border-2 border-dashed border-amber/60 bg-amber-soft px-4 py-3 text-[12.5px] text-[#8a5602]">
        <b>CHẾ ĐỘ DEMO — bảng để TRỐNG theo chủ đích.</b> Không bày dữ liệu giả trong màn kiểm toán. Đăng nhập bằng tài khoản thật (super_admin/org_admin) để đọc <code>iam.audit_logs</code> thật.
      </div>
      <AuditLogBoard audit={[]} demo />
    </>
  );
}
