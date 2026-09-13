import { NoAccess, PageHeader, Panel } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { isForbidden, type AdminAuditRow } from "@/lib/data/users-admin";
import type { PersonaKey } from "@/lib/roles";
import AuditLogBoard from "./AuditLogBoard";

const DEMO_ALLOWED: PersonaKey[] = ["ceo"];

type SearchParams = { module?: string; q?: string; limit?: string };

async function readAuditAll(params: {
  limit: number;
  module: string | null;
  search: string | null;
}): Promise<
  | { ok: true; audit: AdminAuditRow[] }
  | { ok: false; message: string }
> {
  const client = await createClient();
  if (!client) return { ok: false, message: "Chưa cấu hình Supabase (chế độ demo)." };

  const { data, error } = await client.rpc("vexim_audit_all", {
    p_limit: params.limit,
    p_module: params.module,
    p_search: params.search,
  });

  if (error) {
    const msg = error.message || "Không đọc được nhật ký.";
    return { ok: false, message: isForbidden(msg) ? "Bạn không có quyền xem nhật ký." : msg };
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
    module: string | null;
    shop: string | null;
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
    module: r.module,
    shop: r.shop,
  }));

  return { ok: true, audit };
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const session = await requireSession();
  const sp = searchParams ? await searchParams : {};
  const pModule = (sp.module ?? "").trim() || null;
  const pSearch = (sp.q ?? "").trim() || null;
  const pLimitRaw = Number(sp.limit ?? 200);
  const pLimit = Number.isFinite(pLimitRaw) ? Math.min(Math.max(pLimitRaw, 1), 200) : 200;

  // SUPABASE MODE — toàn hệ thống
  if (session.mode === "supabase") {
    const snapshot = await readAuditAll({ limit: pLimit, module: pModule, search: pSearch });
    if (!snapshot.ok) {
      return (
        <>
          <PageHeader
            title="Nhật ký thao tác (audit log)"
            sub="iam.audit_logs · toàn hệ thống · append-only"
            desc="Toàn bộ thao tác quản trị và ghi ra Amazon được ghi append-only, không cho update/delete. Chỉ admin hoặc người có quyền shop được xem."
          />
          <NoAccess />
          <Panel title="Vì sao bị chặn" hint="thông điệp từ database">
            <p className="text-[12.5px] text-muted">{snapshot.message}</p>
            <p className="mt-2 text-[12px] text-soft">
              Quyền xem do <code>iam.is_user_admin()</code> và <code>iam.can_read_seller_account</code> quyết định (migration 0022/0023).
            </p>
          </Panel>
        </>
      );
    }

    return (
      <>
        <PageHeader
          title="Nhật ký thao tác (audit log)"
          sub={`${snapshot.audit.length} bản ghi gần nhất · toàn hệ thống · ${pModule ? `module=${pModule}` : "mọi module"}${pSearch ? ` · tìm \"${pSearch}\"` : ""}`}
          desc="Nhật ký mọi thao tác quan trọng trong hệ thống: ai đổi giá, sửa listing, chỉnh quảng cáo hay quản trị người dùng — lúc nào, giá trị trước/sau ra sao. Nhật ký không thể sửa hay xóa."
        />
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <a
            href="/module0/users"
            className="rounded-full border border-line bg-card px-4 py-1.5 text-[12.5px] font-bold text-muted transition hover:border-accent hover:text-accent-ink"
          >
            ← Người dùng & phân quyền
          </a>
          <form className="flex flex-wrap items-center gap-2" method="GET">
            <select
              name="module"
              defaultValue={pModule ?? ""}
              className="h-8 rounded-full border border-line bg-card px-3 text-[12.5px] font-semibold"
            >
              <option value="">Tất cả module</option>
              <option value="iam">iam</option>
              <option value="catalog">catalog</option>
              <option value="price">price</option>
              <option value="ads">ads</option>
              <option value="inventory">inventory</option>
              <option value="sales">sales</option>
              <option value="finance">finance</option>
              <option value="ops">ops</option>
              <option value="connections">connections</option>
            </select>
            <input
              name="q"
              defaultValue={pSearch ?? ""}
              placeholder="Tìm entity, email, action…"
              className="h-8 w-56 rounded-full border border-line bg-card px-3 text-[12.5px] outline-none focus:border-accent"
            />
            <input type="hidden" name="limit" value={String(pLimit)} />
            <button
              type="submit"
              className="h-8 rounded-full bg-accent px-4 text-[12.5px] font-bold text-white"
            >
              Lọc
            </button>
            <a
              href="/module0/audit-log"
              className="h-8 rounded-full border border-line bg-card px-4 py-1.5 text-[12.5px] font-bold text-muted"
            >
              Xóa lọc
            </a>
          </form>
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
        desc="Nhật ký mọi thao tác quan trọng trong hệ thống — không thể sửa hay xóa. Chế độ demo chưa kết nối cơ sở dữ liệu nên bảng để trống; đăng nhập tài khoản thật để xem."
      />
      <div className="mb-4 rounded-[13px] border-2 border-dashed border-amber/60 bg-amber-soft px-4 py-3 text-[12.5px] text-[#8a5602]">
        <b>CHẾ ĐỘ DEMO — bảng để TRỐNG theo chủ đích.</b> Không bày dữ liệu giả trong màn kiểm toán. Đăng nhập bằng tài khoản thật (super_admin/org_admin) để đọc <code>iam.audit_logs</code> thật.
      </div>
      <AuditLogBoard audit={[]} demo />
    </>
  );
}
