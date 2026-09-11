import {
  Grid2,
  KpiCard,
  KpiGrid,
  MiniList,
  NoAccess,
  PageHeader,
  Panel,
  tableCls,
} from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { financeKpis, reimbursements, skuProfit } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo"];

export default async function FinancePage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  return (
    <>
      <PageHeader
        title="Tài chính & Đối soát"
        sub="Kỳ settlement gần nhất · đối soát 2h sáng"
        desc="Nguồn: Finances API + report Settlement / Ledger · lợi nhuận tính với giá vốn nội bộ VEXIM nhập."
      />
      <KpiGrid>
        {financeKpis.map((k) => (
          <KpiCard key={k.label} {...k} />
        ))}
      </KpiGrid>
      <Grid2>
        <Panel title="Lợi nhuận SKU (ước tính)" hint="top 3 · sau phí Amazon + giá vốn">
          <table className={tableCls.table}>
            <thead>
              <tr>
                <th className={tableCls.th}>SKU</th>
                <th className={`${tableCls.th} text-right`}>Doanh thu</th>
                <th className={`${tableCls.th} text-right`}>Phí Amazon</th>
                <th className={`${tableCls.th} text-right`}>Giá vốn</th>
                <th className={`${tableCls.th} text-right`}>Lãi gộp</th>
              </tr>
            </thead>
            <tbody>
              {skuProfit.map((r) => (
                <tr key={r.sku}>
                  <td className={`${tableCls.td} font-bold`}>{r.sku}</td>
                  <td className={tableCls.tdNum}>{r.revenue}</td>
                  <td className={tableCls.tdNum}>{r.amazonFees}</td>
                  <td className={tableCls.tdNum}>{r.cogs}</td>
                  <td
                    className={`${tableCls.tdNum} font-bold ${
                      r.tone === "up" ? "text-green" : "text-amber"
                    }`}
                  >
                    {r.gross}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="Bồi hoàn FBA chờ xử lý">
          <MiniList
            items={reimbursements.map((r) => ({
              icon: "🧾",
              title: r.title,
              sub: r.detail,
              right: r.amount,
              tone: "up" as const,
            }))}
          />
        </Panel>
      </Grid2>
    </>
  );
}
