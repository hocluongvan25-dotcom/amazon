import {
  Chip,
  KpiCard,
  KpiGrid,
  NoAccess,
  PageHeader,
  Panel,
  tableCls,
} from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { listingKpis, listingQueue } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo"];

export default async function ListingPage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  return (
    <>
      <PageHeader
        title="Listing & Nội dung"
        sub="Hôm qua · 14 shop"
        desc="Nguồn: Listings Items API + notification LISTINGS_ITEM_ISSUES_CHANGE + report Merchant Listings."
      />
      <div className="mb-4 flex flex-wrap gap-2">
        {[
          ["/listing/list", "📋 Danh sách listing"],
          ["/listing/queue", "🚑 Hàng đợi inactive/stranded"],
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
        {listingKpis.map((k) => (
          <KpiCard key={k.label} {...k} />
        ))}
      </KpiGrid>
      <Panel title="Hàng đợi xử lý hôm nay" hint="xếp theo doanh thu/SKU">
        <table className={tableCls.table}>
          <thead>
            <tr>
              <th className={tableCls.th}>SKU / ASIN</th>
              <th className={tableCls.th}>Shop</th>
              <th className={tableCls.th}>Vấn đề</th>
              <th className={`${tableCls.th} text-right`}>Doanh thu/SKU</th>
              <th className={tableCls.th}>Ưu tiên</th>
              <th className={tableCls.th}>Người phụ trách</th>
            </tr>
          </thead>
          <tbody>
            {listingQueue.map((r) => (
              <tr key={r.sku}>
                <td className={`${tableCls.td} font-bold`}>
                  {r.sku} · {r.asin}
                </td>
                <td className={tableCls.td}>{r.shop}</td>
                <td className={tableCls.td}>{r.issue}</td>
                <td className={tableCls.tdNum}>{r.revenuePerDay}</td>
                <td className={tableCls.td}>
                  <Chip tone={r.priority}>{r.priorityLabel}</Chip>
                </td>
                <td className={tableCls.td}>{r.owner}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
