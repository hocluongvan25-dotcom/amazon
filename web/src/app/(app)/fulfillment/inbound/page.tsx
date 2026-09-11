import { Chip, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { inboundShipmentsFull } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";
import type { InboundRow } from "@/lib/types";

const ALLOWED: PersonaKey[] = ["ceo", "lead_fulfill"];

const recTone: Record<InboundRow["reconcileTone"], "green" | "amber" | "red" | "gray"> = {
  up: "green",
  warn: "amber",
  down: "red",
  flat: "gray",
};

export default async function InboundPage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  return (
    <>
      <PageHeader
        title="Inbound shipments"
        sub="6 lô · 2 đang di chuyển · 1 chờ placement"
        desc="Nguồn: Fulfillment Inbound API v2024-03-20 (getInboundPlan/getShipment) · đối soát nhận hàng: GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA. Trạng thái chuẩn Amazon."
      />
      <Panel title="Tất cả lô hàng" hint="WORKING → SHIPPED → IN_TRANSIT → DELIVERED → CHECKED_IN → RECEIVING → CLOSED">
        <table className={tableCls.table}>
          <thead>
            <tr>
              <th className={tableCls.th}>Shipment</th>
              <th className={tableCls.th}>Shop</th>
              <th className={tableCls.th}>Trạng thái</th>
              <th className={`${tableCls.th} text-right`}>Số lượng</th>
              <th className={tableCls.th}>FC đích</th>
              <th className={tableCls.th}>ETA</th>
              <th className={tableCls.th}>Đối soát nhận</th>
            </tr>
          </thead>
          <tbody>
            {inboundShipmentsFull.map((s) => (
              <tr key={s.id}>
                <td className={`${tableCls.td} font-mono text-[12px] font-bold`}>{s.id}</td>
                <td className={tableCls.td}>{s.shop}</td>
                <td className={tableCls.td}>
                  <Chip tone={s.statusTone}>{s.status}</Chip>
                </td>
                <td className={`${tableCls.tdNum} font-bold`}>{s.units}</td>
                <td className={tableCls.td}>{s.fc}</td>
                <td className={tableCls.td}>{s.eta}</td>
                <td className={tableCls.td}>
                  <Chip tone={recTone[s.reconcileTone]}>{s.reconcile}</Chip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel title="Quy tắc đối soát">
        <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-muted">
          <li>Lô CLOSED: so thực nhận vs kế hoạch — thiếu &gt; 0 sinh task SOP-09 (claim bồi hoàn) kèm giá trị.</li>
          <li>Đang di chuyển (IN_TRANSIT/RECEIVING): theo dõi ETA, trễ &gt; 3 ngày so lịch sử tuyến → cảnh báo.</li>
          <li>WORKING chờ placement: đẩy hoàn tất các bước confirm (Đợt 2 — thao tác ghi).</li>
        </ul>
      </Panel>
    </>
  );
}
