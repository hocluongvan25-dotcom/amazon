import { LiveHealth } from "@/components/health/LiveHealth";
import {
  Chip,
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
import { healthKpis, overdueTasks, shopHealth } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo"];

export default async function HealthPage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;
  if (session.mode === "supabase") return <LiveHealth />;

  return (
    <>
      <PageHeader
        title="Vận hành & Account Health"
        sub="DEMO · dữ liệu minh họa"
        desc="Sức khỏe tài khoản bán hàng: điểm vi phạm, chỉ số hiệu suất so với ngưỡng Amazon yêu cầu — phát hiện rủi ro trước khi tài khoản bị ảnh hưởng."
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <a
          href="/health/violations"
          className="rounded-full border border-line bg-card px-4 py-1.5 text-[12.5px] font-bold text-muted transition hover:border-accent hover:bg-accent-soft hover:text-accent-ink"
        >
          ⚠️ Chi tiết vấn đề đang mở (4)
        </a>
      </div>
      <KpiGrid>
        {healthKpis.map((k) => (
          <KpiCard key={k.label} {...k} />
        ))}
      </KpiGrid>
      <Grid2>
        <Panel title="Sức khỏe theo shop">
          <table className={tableCls.table}>
            <thead>
              <tr>
                <th className={tableCls.th}>Shop</th>
                <th className={`${tableCls.th} text-right`}>AHR</th>
                <th className={`${tableCls.th} text-right`}>ODR</th>
                <th className={`${tableCls.th} text-right`}>Late ship</th>
                <th className={tableCls.th}>Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {shopHealth.map((r) => (
                <tr key={r.shop}>
                  <td className={`${tableCls.td} font-bold`}>{r.shop}</td>
                  <td className={tableCls.tdNum}>{r.ahr}</td>
                  <td className={tableCls.tdNum}>{r.odr}</td>
                  <td className={tableCls.tdNum}>{r.lateShip}</td>
                  <td className={tableCls.td}>
                    <Chip tone={r.status}>{r.statusLabel}</Chip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="Tác vụ quá hạn">
          <MiniList items={overdueTasks} />
        </Panel>
      </Grid2>
    </>
  );
}
