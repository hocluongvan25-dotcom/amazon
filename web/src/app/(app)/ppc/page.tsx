import {
  AlertList,
  Grid2,
  KpiCard,
  KpiGrid,
  NoAccess,
  PageHeader,
  Panel,
  tableCls,
} from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { campaignsOver, ppcAlerts, ppcKpis } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo", "op_ppc"];

export default async function PpcPage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  return (
    <>
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
                  <td className={`${tableCls.tdNum} font-bold text-red`}>
                    {c.acos}
                  </td>
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
