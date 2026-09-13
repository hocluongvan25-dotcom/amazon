/**
 * /ppc — Quảng cáo (Module 5, phần đọc).
 *
 * SUPABASE MODE: <LivePpc/> đọc các view 0020 (vexim_ads_kpis / _campaigns /
 * _search_terms / _campaign_daily / _budget_usage / _report_requests) bằng client
 * phiên → RLS tự lọc theo shop người đó phụ trách.
 *
 * DEMO MODE: giữ số minh hoạ để xem bố cục khi chưa cấu hình Supabase. Số demo
 * được gắn nhãn rõ ràng, KHÔNG bao giờ trộn với dữ liệu thật.
 */
import { AlertList, Grid2, KpiCard, KpiGrid, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { LivePpc } from "@/components/ppc/LivePpc";
import { requireSession } from "@/lib/auth/session";
import { campaignsOver, ppcAlerts, ppcKpis } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";

/** CEO xem hiệu quả tiền; op_ppc là người vận hành campaign hằng ngày. */
const ALLOWED: PersonaKey[] = ["ceo", "op_ppc"];

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<{ ccy?: string; shop?: string }>;
};

export default async function PpcPage({ searchParams }: Props) {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  const sp = await searchParams;
  if (session.mode === "supabase") return <LivePpc ccy={sp.ccy} shopId={sp.shop} />;

  return (
    <>
      <div className="mb-3 text-sm font-bold text-amber">DEMO · Dữ liệu minh họa</div>
      <PageHeader
        title="Quảng cáo (PPC)"
        sub={
          session.persona === "op_ppc"
            ? "Hôm qua · 5 shop được gán · ACOS tính theo 7 ngày"
            : "Hôm qua · ACOS tính theo 7 ngày"
        }
        desc="Nguồn: Amazon Ads API — campaign metrics theo giờ, search term report hằng ngày."
      />
      <KpiGrid>
        {ppcKpis.map((k) => (
          <KpiCard key={k.label} {...k} />
        ))}
      </KpiGrid>
      <Grid2>
        <Panel title="Cần xử lý ngay">
          <AlertList items={ppcAlerts} />
        </Panel>
        <Panel title="Campaign ACOS vượt ngưỡng" hint="7 ngày · chỉnh trực tiếp từ hệ thống">
          <table className={tableCls.table}>
            <thead>
              <tr>
                <th className={tableCls.th}>Campaign</th>
                <th className={`${tableCls.th} text-right`}>Spend 7d</th>
                <th className={`${tableCls.th} text-right`}>ACOS</th>
                <th className={tableCls.th}>Xu hướng</th>
              </tr>
            </thead>
            <tbody>
              {campaignsOver.map((c) => (
                <tr key={c.name}>
                  <td className={`${tableCls.td} font-bold`}>{c.name}</td>
                  <td className={tableCls.tdNum}>{c.spend7d}</td>
                  <td className={`${tableCls.tdNum} font-bold text-red`}>{c.acos}</td>
                  <td className={tableCls.td}>{c.trend}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </Grid2>
    </>
  );
}
