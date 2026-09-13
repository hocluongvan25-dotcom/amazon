import { ApprovalBoard } from "@/components/ppc/ApprovalBoard";
import { NoAccess, PageHeader, Panel } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { demoAudit, demoChanges } from "@/lib/data/ppc-demo";
import { splitQueue, type AdsChangeRaw } from "@/lib/data/ppc-model";
import { readAdsAudit, readAdsChanges, readAdsPermissions } from "@/lib/data/ppc";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo", "op_ppc"];
const DEMO_DECIDERS: PersonaKey[] = ["ceo"];

type AuditRow = {
  id: string;
  created_at: string | null;
  action: string;
  entity: string | null;
  actor_name: string | null;
  result: string | null;
  after_text: string | null;
};

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ shop?: string }>;
}) {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;
  const sp = await searchParams;

  if (session.mode === "demo") {
    const queue = splitQueue(demoChanges);
    return (
      <>
        <div className="mb-3 text-sm font-bold text-amber">DEMO · Dữ liệu minh họa (chưa nối Supabase)</div>
        <PageHeader
          title="Duyệt thay đổi quảng cáo (SOP-05 bước 4)"
          sub={`${queue.pending.length} chờ duyệt · ${queue.inflight.length} đang bay · ${queue.done.length} đã xong`}
          desc="Tăng ngân sách/bid > 30%/ngày hoặc bật lại campaign đang dừng ⇒ phải có trưởng phòng PPC duyệt TRƯỚC khi worker gọi Amazon Ads API. Mọi bước ghi iam.audit_logs."
        />
        <ApprovalBoard changes={demoChanges} canDecide={DEMO_DECIDERS.includes(session.persona)} audit={demoAudit} />
      </>
    );
  }

  let changes: AdsChangeRaw[] = [];
  let audit: AuditRow[] = [];
  let failed: string | null = null;
  let canApprove = false;
  try {
    const [rows, logs, perms] = await Promise.all([
      readAdsChanges({ sellerAccountId: sp.shop ?? null, limit: 150 }),
      readAdsAudit({ sellerAccountId: sp.shop ?? null, limit: 40 }),
      readAdsPermissions(sp.shop ?? null),
    ]);
    changes = rows;
    audit = logs;
    canApprove = perms.canApprove;
  } catch (error) {
    failed = error instanceof Error ? error.message : "Không đọc được hàng đợi thay đổi";
  }

  const queue = splitQueue(changes);

  return (
    <>
      <PageHeader
        title="Duyệt thay đổi quảng cáo (SOP-05 bước 4)"
        sub={`${queue.pending.length} chờ duyệt · ${queue.inflight.length} đã duyệt/chờ gửi · ${queue.done.length} đã xử lý`}
        desc="Tăng ngân sách/bid > 30%/ngày hoặc bật lại campaign đang dừng ⇒ phải có trưởng phòng PPC duyệt TRƯỚC khi worker gọi Amazon Ads API. Mọi bước ghi iam.audit_logs; Ops có nút Revert 1 chạm."
      />

      {failed ? (
        <div className="mb-3 rounded-[10px] bg-red-soft px-3.5 py-2.5 text-[13px] font-semibold text-[#a01717]">
          Không đọc được dữ liệu: {failed}
        </div>
      ) : null}

      {!canApprove ? (
        <div className="mb-3 rounded-[10px] bg-amber-soft px-3.5 py-2.5 text-[13px] font-semibold text-[#8a5602]">
          Tài khoản này không phải người duyệt PPC (trưởng phòng PPC / ban điều hành) — xem được nhưng không bấm
          duyệt được. RPC của DB là chốt cuối, không phải màn hình này.
        </div>
      ) : null}

      {changes.length === 0 && !failed ? (
        <Panel title="Chưa có thay đổi nào" hint="hàng đợi trống là tin tốt">
          <p className="text-[13px] text-soft">
            Mọi thay đổi bid/ngân sách/negative đều xuất hiện ở đây. Vào{" "}
            <a className="font-bold text-accent-ink" href="/ppc/campaigns/C-DEMO-01">
              chi tiết campaign
            </a>{" "}
            hoặc{" "}
            <a className="font-bold text-accent-ink" href="/ppc/search-terms">
              search term A3
            </a>{" "}
            để tạo yêu cầu đầu tiên.
          </p>
        </Panel>
      ) : (
        <ApprovalBoard changes={changes} canDecide={canApprove} audit={audit} />
      )}
    </>
  );
}
