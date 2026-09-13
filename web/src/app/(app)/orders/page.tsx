import { LiveOperations } from "@/components/operations/LiveOperations";
import {
  AlertList,
  Chip,
  Grid2,
  KpiCard,
  KpiGrid,
  NoAccess,
  PageHeader,
  Panel,
  tableCls,
} from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { ordersAlerts, ordersKpis, shipMetrics } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo"];

export default async function OrdersPage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;
  if (session.mode === "supabase") return <LiveOperations screen="orders" />;

  return (
    <>
      <div className="mb-3 text-sm font-bold text-amber">DEMO · Dữ liệu minh họa</div>
      <PageHeader
        title="Đơn hàng & CSKH"
        sub="Hôm nay"
        desc="Theo dõi toàn bộ đơn hàng theo thời gian thực: đơn mới, đơn cần giao gấp, chỉ số giao hàng so với ngưỡng Amazon và các việc CSKH cần xử lý ngay."
      />
      <div className="mb-4 flex flex-wrap gap-2">
        {[
          ["/orders/list", "📋 Danh sách đơn"],
          ["/orders/fbm", "⏱ Queue FBM"],
          ["/orders/returns", "↩ Returns & Refunds"],
        ].map(([href, label]) => (
          <a
            key={href}
            href={href}
            className="rounded-full border border-line bg-card px-4 py-1.5 text-[12.5px] font-bold text-muted transition hover:border-accent hover:bg-accent-soft hover:text-accent-ink"
          >
            {label}
          </a>
        ))}
      </div>
      <KpiGrid>
        {ordersKpis.map((k) => (
          <KpiCard key={k.label} {...k} />
        ))}
      </KpiGrid>
      <Grid2>
        <Panel title="Chỉ số giao hàng so với ngưỡng Amazon">
          <table className={tableCls.table}>
            <thead>
              <tr>
                <th className={tableCls.th}>Chỉ số</th>
                <th className={`${tableCls.th} text-right`}>Hiện tại</th>
                <th className={`${tableCls.th} text-right`}>Ngưỡng</th>
                <th className={tableCls.th}>Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {shipMetrics.map((m) => (
                <tr key={m.name}>
                  <td className={`${tableCls.td} font-bold`}>{m.name}</td>
                  <td className={tableCls.tdNum}>{m.current}</td>
                  <td className={tableCls.tdNum}>{m.threshold}</td>
                  <td className={tableCls.td}>
                    <Chip tone={m.safe ? "green" : "red"}>
                      {m.safe ? "An toàn" : "Vượt ngưỡng"}
                    </Chip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="Việc cần làm ngay">
          <AlertList items={ordersAlerts} />
        </Panel>
      </Grid2>
    </>
  );
}
