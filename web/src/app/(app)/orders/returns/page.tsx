import { LiveOperations } from "@/components/operations/LiveOperations";
import { Bars, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { returnReasonSummary, returnsList } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo"];

export default async function ReturnsPage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;
  if (session.mode === "supabase") return <LiveOperations screen="returns" />;

  return (
    <>
      <div className="mb-3 text-sm font-bold text-amber">DEMO · Dữ liệu minh họa</div>
      <PageHeader
        title="Returns & Refunds"
        sub="28 return trong 30 ngày · tỷ lệ 2.1%"
        desc="Theo dõi hàng trả về và hoàn tiền: lý do khách trả, tình trạng hàng nhận lại và số tiền hoàn — nắm được tỷ lệ trả hàng của từng sản phẩm."
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Lý do return — 30 ngày" hint="mã lý do Amazon">
          <Bars
            data={returnReasonSummary.map((r) => ({
              label: r.reason.split(" ")[0],
              pct: r.pct * 2.5 > 100 ? 100 : r.pct * 2.5,
            }))}
          />
        </Panel>
        <Panel title="Tổng hợp theo lý do">
          <table className={tableCls.table}>
            <thead>
              <tr>
                <th className={tableCls.th}>Lý do</th>
                <th className={`${tableCls.th} text-right`}>Số lượng</th>
                <th className={`${tableCls.th} text-right`}>Tỷ lệ</th>
              </tr>
            </thead>
            <tbody>
              {returnReasonSummary.map((r) => (
                <tr key={r.reason}>
                  <td className={`${tableCls.td} font-bold`}>{r.reason}</td>
                  <td className={tableCls.tdNum}>{r.count}</td>
                  <td className={tableCls.tdNum}>{r.pct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
      <Panel title="Return mới nhất">
        <table className={tableCls.table}>
          <thead>
            <tr>
              <th className={tableCls.th}>Ngày</th>
              <th className={tableCls.th}>Đơn</th>
              <th className={tableCls.th}>Mã lý do</th>
              <th className={tableCls.th}>Diễn giải</th>
              <th className={tableCls.th}>Trạng thái</th>
              <th className={`${tableCls.th} text-right`}>Hoàn tiền</th>
              <th className={tableCls.th}>Shop</th>
            </tr>
          </thead>
          <tbody>
            {returnsList.map((r) => (
              <tr key={r.id}>
                <td className={tableCls.td}>{r.date}</td>
                <td className={`${tableCls.td} font-mono text-[12px]`}>{r.order}</td>
                <td className={`${tableCls.td} font-mono text-[12px]`}>{r.reasonCode}</td>
                <td className={tableCls.td}>{r.reasonLabel}</td>
                <td className={tableCls.td}>{r.status}</td>
                <td className={tableCls.tdNum}>{r.refund}</td>
                <td className={tableCls.td}>{r.shop}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
