import { Chip, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { ordersList } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo"];

const statusTone: Record<string, "green" | "amber" | "gray" | "red"> = {
  Shipped: "green",
  Delivered: "green",
  Pending: "amber",
  Cancelled: "gray",
};

export default async function OrdersListPage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  return (
    <>
      <PageHeader
        title="Danh sách đơn hàng"
        sub="341 đơn hôm nay · FBA 320 · FBM 21"
        desc="Nguồn: Orders API (getOrders delta 15–30 phút) + ORDER_CHANGE realtime + đối soát All Orders report 2h sáng."
      />
      <Panel title="Đơn gần đây" hint="không hiển thị thông tin cá nhân người mua (PII) — theo hồ sơ v1.1">
        <table className={tableCls.table}>
          <thead>
            <tr>
              <th className={tableCls.th}>Mã đơn</th>
              <th className={tableCls.th}>Thời gian</th>
              <th className={tableCls.th}>Trạng thái</th>
              <th className={tableCls.th}>Kênh</th>
              <th className={`${tableCls.th} text-right`}>Số món</th>
              <th className={`${tableCls.th} text-right`}>Tổng tiền</th>
              <th className={tableCls.th}>SKU chính</th>
              <th className={tableCls.th}>Shop</th>
            </tr>
          </thead>
          <tbody>
            {ordersList.map((o) => (
              <tr key={o.id}>
                <td className={`${tableCls.td} font-mono text-[12px] font-bold`}>
                  <a href={`/orders/detail?id=${o.id}`} className="text-blue underline underline-offset-2">
                    {o.id}
                  </a>
                </td>
                <td className={tableCls.td}>{o.date}</td>
                <td className={tableCls.td}>
                  <Chip tone={statusTone[o.status]}>{o.status}</Chip>
                </td>
                <td className={tableCls.td}>{o.channel}</td>
                <td className={tableCls.tdNum}>{o.itemsCount}</td>
                <td className={tableCls.tdNum}>{o.total}</td>
                <td className={tableCls.td}>{o.mainSku}</td>
                <td className={tableCls.td}>{o.shop}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
