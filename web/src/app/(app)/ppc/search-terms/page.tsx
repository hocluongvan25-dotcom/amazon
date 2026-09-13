import { SearchTermsBoard } from "@/components/ppc/SearchTermsBoard";
import { NoAccess, PageHeader, Panel } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { demoChanges, demoSearchTerms } from "@/lib/data/ppc-demo";
import { filterSearchTerms, type AdsSearchTermRaw } from "@/lib/data/ppc-model";
import { readAdsPermissions, readAdsSearchTerms } from "@/lib/data/ppc";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo", "op_ppc"];

/** Persona nào được bấm duyệt ở DEMO MODE (DB vẫn là chốt cuối ở chế độ thật). */
const DEMO_DECIDERS: PersonaKey[] = ["ceo"];

export default async function SearchTermsPage({
  searchParams,
}: {
  searchParams: Promise<{ campaign?: string; shop?: string }>;
}) {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;
  const sp = await searchParams;
  const campaignId = sp.campaign?.trim() || null;

  if (session.mode === "demo") {
    const rows = filterSearchTerms(demoSearchTerms, {
      campaignId: campaignId ?? undefined,
      minSpend: 0,
      minClicks: 0,
      onlyNoOrders: false,
    });
    return (
      <>
        <div className="mb-3 text-sm font-bold text-amber">DEMO · Dữ liệu minh họa (chưa nối Supabase)</div>
        <PageHeader
          title="A3 — Search term &amp; Negative keyword"
          sub="3 gợi ý đang chờ · 1 term đã chặn"
          desc="Phân tích từ khóa tìm kiếm thực tế của khách: từ nào có click nhưng không ra đơn sẽ được gợi ý chặn (negative) kèm bằng chứng — duyệt là hệ thống tự áp dụng."
        />
        <SearchTermsBoard rows={rows} canDecide={DEMO_DECIDERS.includes(session.persona)} campaignId={campaignId} />
        <Panel title="Vì sao màn này quan trọng" hint={`${demoChanges.length} dòng thay đổi trong demo`}>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] text-soft">
            <li>Mỗi gợi ý kèm BẰNG CHỨNG (click · chi · số đơn · lý do) — không phải "AI đoán".</li>
            <li>Duyệt một gợi ý = tạo yêu cầu thêm negative đi CÙNG đường ghi với đổi bid/ngân sách.</li>
            <li>Chặn negative không cần duyệt ngưỡng (hành động giảm chi tiêu) nhưng vẫn có nhật ký.</li>
          </ul>
        </Panel>
      </>
    );
  }

  let rows: AdsSearchTermRaw[] = [];
  let failed: string | null = null;
  let canDecide = false;
  let canWrite = false;
  try {
    const [data, perms] = await Promise.all([
      readAdsSearchTerms({ sellerAccountId: sp.shop ?? null, campaignId }),
      readAdsPermissions(sp.shop ?? null),
    ]);
    rows = data;
    canDecide = perms.canApprove;
    canWrite = perms.canWrite;
  } catch (error) {
    failed = error instanceof Error ? error.message : "Không đọc được dữ liệu search term";
  }

  const ready = rows.filter(
    (r) => r.negative_keyword_id === null && r.pending_suggestion_id === null && (r.purchases_7d ?? 0) === 0,
  ).length;
  const waiting = rows.filter((r) => r.pending_suggestion_id !== null).length;
  const blocked = rows.filter((r) => r.negative_keyword_id !== null).length;

  return (
    <>
      <PageHeader
        title="A3 — Search term &amp; Negative keyword"
        sub={`${rows.length} dòng dữ liệu · ${waiting} gợi ý chờ duyệt · ${blocked} đã chặn · ${ready} dòng đáng xem không có gợi ý`}
        desc="Phân tích từ khóa tìm kiếm thực tế của khách: từ nào có click nhưng không ra đơn sẽ được gợi ý chặn (negative) kèm bằng chứng — duyệt là hệ thống tự áp dụng lên Amazon."
      />

      {failed ? (
        <div className="mb-3 rounded-[10px] bg-red-soft px-3.5 py-2.5 text-[13px] font-semibold text-[#a01717]">
          Không đọc được dữ liệu: {failed}
        </div>
      ) : null}

      {!canWrite ? (
        <div className="mb-3 rounded-[10px] bg-amber-soft px-3.5 py-2.5 text-[13px] font-semibold text-[#8a5602]">
          Tài khoản này KHÔNG có quyền ghi cho shop đang chọn — chỉ xem được. (Đổi shop hoặc xin quyền PPC.)
        </div>
      ) : null}

      {rows.length === 0 ? (
        <Panel title="Chưa có dữ liệu search term" hint="cần chạy worker:ads-pull --kind=search-terms">
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] text-soft">
            <li>
              Chạy <code>npm run worker:ads-pull -- --kind=search-terms --days=30</code> để tải report search term.
            </li>
            <li>
              Gợi ý negative do job tổng hợp sinh kèm bằng chứng; sau đó quay lại màn này để duyệt.
            </li>
          </ul>
        </Panel>
      ) : (
        <SearchTermsBoard rows={rows} canDecide={canDecide} campaignId={campaignId} />
      )}
    </>
  );
}
