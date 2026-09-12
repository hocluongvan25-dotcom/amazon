/**
 * LiveDashboard — server component đọc Supabase cho Dashboard CEO tổng hợp.
 * Gom KPI từ: orders, inventory, listings, pricing, settlements, health, alerts.
 */
import {
  KpiCard,
  KpiGrid,
  NoAccess,
  PageHeader,
  Panel,
  tableCls,
} from "@/components/ui";
import { readDashboardStats } from "@/lib/data/dashboard";
import {
  buildCeoKpis,
  buildDeptSummaries,
} from "@/lib/data/dashboard-model";

export async function LiveDashboard() {
  let stats;
  let failed = false;

  try {
    stats = await readDashboardStats();
  } catch {
    failed = true;
  }

  if (failed || !stats) {
    return (
      <>
        <div className="mb-3 text-sm font-bold text-accent-ink">
          SUPABASE · dữ liệu thật
        </div>
        <PageHeader title="Tổng quan" sub="Lỗi tải dữ liệu" />
        <Panel title="Không tải được dữ liệu">
          <p role="alert">
            Không thể đọc Supabase. Kiểm tra kết nối, quyền SELECT, RLS và
            phiên đăng nhập.
          </p>
        </Panel>
      </>
    );
  }

  const kpis = buildCeoKpis(stats);
  const depts = buildDeptSummaries(stats);

  return (
    <>
      <div className="mb-3 text-sm font-bold text-accent-ink">
        SUPABASE · dữ liệu thật từ tất cả views
      </div>
      <PageHeader
        title="Tổng quan"
        sub={`${stats.orderCount} đơn · ${stats.totalSku} SKU · ${stats.openAlerts} cảnh báo`}
        desc="KPI tổng hợp từ: vexim_orders, vexim_inventory_latest, vexim_listings, vexim_pricing, vexim_settlements, vexim_shop_health, ops.my_alerts."
      />
      <KpiGrid>
        {kpis.map((k) => (
          <KpiCard key={k.label} {...k} />
        ))}
      </KpiGrid>

      <Panel
        title="Theo phòng ban"
        hint="mỗi phòng = 1 module · click để vào chi tiết"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {depts.map((d) => (
            <a
              key={d.name}
              href={d.href}
              className="group rounded-[13px] border border-line bg-card px-4 py-3.5 transition hover:border-accent hover:bg-accent-soft"
            >
              <div className="flex items-center gap-2">
                <span className="text-[18px]">{d.icon}</span>
                <span className="text-[13px] font-extrabold">{d.name}</span>
                {d.alertCount > 0 ? (
                  <span className="ml-auto rounded-full bg-red-soft px-2 py-0.5 text-[11px] font-extrabold text-red">
                    {d.alertCount}
                  </span>
                ) : null}
              </div>
              <div
                className={`mt-1.5 text-[19px] font-extrabold tracking-tight ${
                  d.tone === "down"
                    ? "text-red"
                    : d.tone === "warn"
                      ? "text-amber"
                      : d.tone === "up"
                        ? "text-green"
                        : "text-muted"
                }`}
              >
                {d.kpi}
              </div>
              <div className="mt-0.5 text-[12px] font-semibold text-soft">
                {d.kpiSub}
              </div>
            </a>
          ))}
        </div>
      </Panel>

      <Panel title="Chi tiết nhanh">
        <table className={tableCls.table}>
          <tbody>
            <tr>
              <td className={`${tableCls.td} font-bold`}>📦 Tồn kho</td>
              <td className={tableCls.td}>
                {stats.lowStockSku} SKU cover &lt; 14 ngày ·{" "}
                {stats.totalFulfillable.toLocaleString("en-US")} tồn khả dụng
              </td>
            </tr>
            <tr>
              <td className={`${tableCls.td} font-bold`}>🏷️ Listing</td>
              <td className={tableCls.td}>
                {stats.listingActive} active · {stats.listingInactive}{" "}
                inactive/stranded
              </td>
            </tr>
            <tr>
              <td className={`${tableCls.td} font-bold`}>💲 Buy Box</td>
              <td className={tableCls.td}>
                {stats.holdingBox}/{stats.totalSku} SKU giữ box (
                {stats.totalSku > 0
                  ? Math.round((stats.holdingBox / stats.totalSku) * 100)
                  : 0}
                %)
              </td>
            </tr>
            <tr>
              <td className={`${tableCls.td} font-bold`}>💰 Settlement</td>
              <td className={tableCls.td}>
                {stats.settlementCount} kỳ đã import
                {stats.latestSettlement !== null
                  ? ` · gần nhất: $${stats.latestSettlement.toLocaleString("en-US")}`
                  : ""}
              </td>
            </tr>
            <tr>
              <td className={`${tableCls.td} font-bold`}>🛡️ Health</td>
              <td className={tableCls.td}>
                {stats.healthShopsOk}/{stats.healthShopsTotal} shop khỏe
              </td>
            </tr>
          </tbody>
        </table>
      </Panel>
    </>
  );
}
