import Link from "next/link";

import { KpiCard, KpiGrid, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { readClientSnapshot } from "@/lib/data/client-portal";
import {
  depositText,
  formatCount,
  formatMoney,
  formatMoneyList,
  latestSettlement,
  periodText,
  shortDate,
} from "@/lib/client-model";
import type { PersonaKey } from "@/lib/roles";

/**
 * Cổng khách hàng (Client Viewer) — CHỈ ĐỌC, chỉ thấy shop của doanh nghiệp mình.
 *
 * ĐỔI GỐC 13/09/2026: trang này trước đây in 4 KPI + 2 "báo cáo" VIẾT CỨNG
 * (`$186,400` · `5,120` đơn · `AHR 780` · `$23,900` · "Báo cáo tuần 37") ngay cả
 * khi đã nối Supabase — khách mở link production là thấy số bịa. Nay:
 *   • Số liệu đọc từ view có RLS (`vexim_order_daily` · `vexim_shop_health` ·
 *     `vexim_settlements` · `vexim_sku_sales_30d`), phạm vi shop do RLS quyết định
 *     theo org/assignment ⇒ khách chỉ thấy shop của mình.
 *   • Không có dữ liệu ⇒ ghi "chưa có dữ liệu", không suy diễn ra số.
 */
const DEMO_ALLOWED: PersonaKey[] = ["ceo", "client"];

export default async function ClientPage() {
  const session = await requireSession();

  if (session.mode === "demo") {
    if (!DEMO_ALLOWED.includes(session.persona)) return <NoAccess />;
    return (
      <>
        <PageHeader title="Shop của bạn" sub="chế độ demo — không có số liệu thật" />
        <div className="mb-4 rounded-[13px] border-2 border-dashed border-amber/60 bg-amber-soft px-4 py-3.5 text-[12.5px] text-[#8a5602]">
          <b>CHẾ ĐỘ DEMO.</b> Bản xem trước này KHÔNG hiển thị số liệu giả. Cổng khách hàng
          đọc dữ liệu thật của shop khách được gán (RLS), nên khi chưa cấu hình Supabase thì
          không có gì để hiển thị — đăng nhập bằng tài khoản thật để xem số của mình.
        </div>
        <KpiGrid>
          <KpiCard label="Doanh thu tháng này" value="—" sub="cần đăng nhập + dữ liệu đồng bộ" tone="flat" />
          <KpiCard label="Đơn hàng tháng" value="—" sub="cần đăng nhập + dữ liệu đồng bộ" tone="flat" />
          <KpiCard label="Sức khỏe tài khoản" value="—" sub="chưa có snapshot account health" tone="flat" />
          <KpiCard label="Kỳ thanh toán gần nhất" value="—" sub="chưa có kỳ settlement" tone="flat" />
        </KpiGrid>
      </>
    );
  }

  const snap = await readClientSnapshot();
  if (!snap.ok) {
    return (
      <>
        <PageHeader title="Shop của bạn" sub="cổng khách hàng — chỉ đọc" />
        <NoAccess />
        <Panel title="Vì sao bị chặn" hint="thông điệp từ hệ thống">
          <p className="text-[12.5px] text-muted">{snap.message}</p>
        </Panel>
      </>
    );
  }

  const d = snap.data;
  const last = latestSettlement(d.settlements);
  const empty = d.shops.length === 0;

  return (
    <>
      {d.isClientViewer ? (
        <div className="mb-4 rounded-[13px] bg-blue px-[18px] py-3.5 text-[13px] font-semibold text-white">
          🏢 Chế độ khách hàng (Client Viewer) — chỉ đọc, chỉ thấy shop của doanh nghiệp mình ·
          không thấy tác vụ nội bộ &amp; phân công của VEXIM
        </div>
      ) : (
        <div className="mb-4 rounded-[13px] border border-line bg-card px-[18px] py-3.5 text-[12.5px] text-muted">
          Bạn là nhân sự VEXIM (không phải tài khoản khách hàng), nên đang xem cổng này với
          phạm vi shop mà RLS cho phép: <b>{d.shops.length} shop</b>. Khách hàng chỉ thấy shop
          của doanh nghiệp mình.
        </div>
      )}

      <PageHeader
        title={d.orgName ? `Shop của ${d.orgName}` : "Shop của bạn"}
        sub={`${d.shops.length} shop · kỳ ${d.month} · ${d.hasAnyData ? "số liệu từ dữ liệu đồng bộ" : "chưa có dữ liệu đồng bộ"}`}
        desc="Mọi số liệu bên dưới đọc trực tiếp từ cơ sở dữ liệu (RLS theo shop của bạn). Chỗ nào chưa đồng bộ thì ghi rõ “chưa có dữ liệu” — không có số suy diễn."
      />

      {empty ? (
        <Panel title="Chưa có shop nào được gán" hint="doanh nghiệp của bạn chưa có shop trong hệ thống">
          <p className="text-[12.5px] text-muted">
            Tài khoản của bạn chưa được gán shop nào (hoặc shop chưa được kết nối). Vui lòng liên
            hệ VEXIM để gán shop cho doanh nghiệp của bạn — khi đó trang này sẽ hiện số liệu thật.
          </p>
        </Panel>
      ) : (
        <>
          <KpiGrid>
            <KpiCard
              label={`Doanh thu tháng ${d.month}`}
              value={formatMoneyList(d.monthRevenue)}
              sub={
                d.monthRevenue.length
                  ? "tổng doanh số đơn (sales_amount) trong tháng"
                  : "chưa đồng bộ đơn hàng tháng này"
              }
              tone={d.monthRevenue.length ? "flat" : "flat"}
            />
            <KpiCard
              label="Đơn hàng tháng"
              value={formatCount(d.monthOrders)}
              sub={
                d.returnRate === null
                  ? "chưa có dữ liệu trả hàng"
                  : `hoàn ${formatCount(d.monthReturns)} đơn · tỉ lệ ${d.returnRate}%`
              }
              tone="flat"
            />
            <KpiCard
              label="Sức khỏe tài khoản"
              value={d.health.label}
              sub={d.health.detail}
              tone={d.health.tone}
            />
            <KpiCard
              label="Kỳ thanh toán gần nhất"
              value={last ? formatMoney(last.total, last.currency ?? "USD") : "—"}
              sub={last ? `${last.shop} · ${depositText(last)}` : "chưa có kỳ settlement nào"}
              tone="flat"
            />
          </KpiGrid>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel
              title="Sản phẩm bán chạy 30 ngày"
              hint={d.topSkus.length ? "vexim_sku_sales_30d" : "chưa có đơn nào trong 30 ngày"}
            >
              {d.topSkus.length === 0 ? (
                <p className="text-[12.5px] text-soft">Chưa có dữ liệu bán trong 30 ngày gần nhất.</p>
              ) : (
                <table className={tableCls.table}>
                  <thead>
                    <tr>
                      <th className={tableCls.th}>SKU</th>
                      <th className={tableCls.th}>Shop</th>
                      <th className={tableCls.th}>Đơn vị</th>
                      <th className={tableCls.th}>Doanh thu</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.topSkus.map((s) => (
                      <tr key={`${s.shop}-${s.sku}`}>
                        <td className={`${tableCls.td} font-bold`}>{s.sku}</td>
                        <td className={tableCls.td}>{s.shop}</td>
                        <td className={tableCls.tdNum}>{formatCount(s.units)}</td>
                        <td className={tableCls.tdNum}>{formatMoney(s.revenue, s.currency ?? "USD")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>

            <Panel
              title="Kỳ thanh toán (settlement)"
              hint={d.settlements.length ? `${d.settlements.length} kỳ gần nhất` : "chưa có kỳ nào"}
            >
              {d.settlements.length === 0 ? (
                <p className="text-[12.5px] text-soft">
                  Chưa có settlement nào được đồng bộ. Khi có, mỗi kỳ hiện kèm số tiền và ngày
                  chi trả thật.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {[...d.settlements]
                    .sort((a, b) => String(b.periodEnd ?? "").localeCompare(String(a.periodEnd ?? "")))
                    .slice(0, 6)
                    .map((s) => (
                      <li
                        key={`${s.shop}-${s.settlementId}`}
                        className="flex items-center gap-2.5 rounded-[10px] border border-line px-3 py-2.5 text-[13px]"
                      >
                        <span>📄</span>
                        <div className="min-w-0">
                          <div className="font-bold">
                            {s.shop} · kỳ {periodText(null, s.periodEnd)}
                          </div>
                          <div className="text-[12px] text-soft">
                            {s.depositDate ? `chi trả ${shortDate(s.depositDate)}` : "chưa có ngày chi trả"}
                          </div>
                        </div>
                        <span className="ml-auto whitespace-nowrap text-[12.5px] font-extrabold">
                          {formatMoney(s.total, s.currency ?? "USD")}
                        </span>
                      </li>
                    ))}
                </ul>
              )}
            </Panel>
          </div>

          <Panel title="Shop bạn đang xem" hint="phạm vi do phân quyền quyết định (RLS), không phải do giao diện">
            <table className={tableCls.table}>
              <thead>
                <tr>
                  <th className={tableCls.th}>Shop</th>
                  <th className={tableCls.th}>Marketplace</th>
                  <th className={tableCls.th}>Trạng thái kết nối</th>
                </tr>
              </thead>
              <tbody>
                {d.shops.map((s) => (
                  <tr key={s.id}>
                    <td className={`${tableCls.td} font-bold`}>{s.shop}</td>
                    <td className={tableCls.td}>{s.marketplace ?? "—"}</td>
                    <td className={tableCls.td}>{s.status ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </>
      )}

      <p className="mt-4 text-[11.5px] font-semibold text-soft">
        Cần báo cáo khác? <Link href="/dashboard" className="underline">Về trang tổng quan</Link> ·
        nội dung cổng khách hàng do VEXIM cấu hình; mọi con số đều đọc từ dữ liệu đã đồng bộ, không
        nhập tay.
      </p>
    </>
  );
}
