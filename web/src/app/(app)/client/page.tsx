import {
  KpiCard,
  KpiGrid,
  MiniList,
  NoAccess,
  PageHeader,
  Panel,
} from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { clientKpis, clientReports } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo", "client"];

export default async function ClientPage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  return (
    <>
      <div className="mb-4 rounded-[13px] bg-blue px-[18px] py-3.5 text-[13px] font-semibold text-white">
        🏢 Chế độ khách hàng (Client Viewer) — chỉ đọc, chỉ thấy shop của doanh
        nghiệp mình · không thấy tác vụ nội bộ &amp; phân công của VEXIM
      </div>
      <PageHeader
        title="Shop của bạn"
        sub="Doanh nghiệp A · 2 shop · cập nhật 06:00"
      />
      <KpiGrid>
        {clientKpis.map((k) => (
          <KpiCard key={k.label} {...k} />
        ))}
      </KpiGrid>
      <Panel title="Báo cáo định kỳ">
        <MiniList items={clientReports} />
      </Panel>
    </>
  );
}
