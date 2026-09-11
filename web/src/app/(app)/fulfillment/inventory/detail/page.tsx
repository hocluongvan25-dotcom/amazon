import { Bars, Chip, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { inventoryDetails, inventoryRows } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo", "lead_fulfill"];

export default async function InventoryDetailPage({
  searchParams,
}: {
  searchParams: Promise<{ sku?: string }>;
}) {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  const { sku } = await searchParams;
  const detail = sku ? inventoryDetails[sku] : undefined;
  const row = inventoryRows.find((r) => r.sku === sku);

  return (
    <>
      <PageHeader
        title={`Tồn kho — ${sku ?? ""}`}
        sub={detail ? `${detail.asin} · FNSKU ${detail.fnsku} · ${detail.shop}` : "Không tìm thấy SKU"}
        desc="Nguồn: snapshots 90 ngày (getInventorySummaries) · phân bổ FC: GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA · nhận hàng: GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA."
      />
      {detail && row ? (
        <>
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: "Khả dụng / Reserved", value: `${row.fulfillable} / ${row.reserved}`, sub: "đơn vị" },
              { label: "Đang về (inbound)", value: `${row.inbound}`, sub: detail.inboundComing.map((i) => `${i.id} · ${i.units} ETA ${i.eta}`).join(" · ") || "—" },
              { label: "Days of cover", value: row.coverDays === null ? "—" : `${row.coverDays} ngày`, sub: `velocity ${row.velocity}/ngày (14 ngày)` },
              { label: "Giá vốn hiện hành", value: detail.unitCost, sub: "bảng cost_inputs (theo kỳ hiệu lực)" },
            ].map((k) => (
              <div key={k.label} className="rounded-[13px] border border-line bg-card px-4 py-3.5">
                <div className="text-[11.5px] font-bold uppercase tracking-wide text-soft">{k.label}</div>
                <div className="mt-0.5 text-[19px] font-extrabold tracking-tight">{k.value}</div>
                <div className="mt-0.5 truncate text-[11.5px] font-semibold text-soft">{k.sub}</div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel title="Tồn kho 90 ngày" hint="inventory_snapshots">
              <Bars data={detail.stock90.map(d => ({ ...d, today: d.label === "T12" }))} />
            </Panel>
            <Panel title="Doanh số 90 ngày" hint="đơn vị bán theo tuần">
              <Bars data={detail.sales90} />
            </Panel>
            <Panel title="Phân bổ theo fulfillment center" hint="snapshot hằng ngày">
              <table className={tableCls.table}>
                <thead>
                  <tr>
                    <th className={tableCls.th}>FC</th>
                    <th className={`${tableCls.th} text-right`}>Số lượng</th>
                    <th className={tableCls.th}>Trạng thái</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.fcAllocation.map((f, i) => (
                    <tr key={i}>
                      <td className={`${tableCls.td} font-bold`}>{f.fc}</td>
                      <td className={tableCls.tdNum}>{f.units}</td>
                      <td className={tableCls.td}>
                        <Chip tone={f.disposition.startsWith("Khả dụng") ? "green" : "amber"}>
                          {f.disposition}
                        </Chip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
            <Panel title="Lịch sử nhận hàng" hint="đối soát thực nhận vs kế hoạch">
              <table className={tableCls.table}>
                <thead>
                  <tr>
                    <th className={tableCls.th}>Ngày</th>
                    <th className={tableCls.th}>Shipment</th>
                    <th className={`${tableCls.th} text-right`}>Kế hoạch</th>
                    <th className={`${tableCls.th} text-right`}>Thực nhận</th>
                    <th className={tableCls.th}>Kết quả</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.receipts.map((r, i) => {
                    const gap = r.expected - r.received;
                    return (
                      <tr key={i}>
                        <td className={tableCls.td}>{r.date}</td>
                        <td className={`${tableCls.td} font-mono text-[12px]`}>{r.shipment}</td>
                        <td className={tableCls.tdNum}>{r.expected}</td>
                        <td className={tableCls.tdNum}>{r.received}</td>
                        <td className={tableCls.td}>
                          <Chip tone={gap === 0 ? "green" : "red"}>
                            {gap === 0 ? "Đủ" : `Thiếu ${gap} → SOP-09`}
                          </Chip>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Panel>
          </div>
        </>
      ) : (
        <Panel title="Không tìm thấy">
          <p className="text-[13px] text-muted">
            SKU chưa có dữ liệu chi tiết trong DEMO MODE — thử{" "}
            <a href="/fulfillment/inventory/detail?sku=XMO-950-BLK" className="font-bold text-blue underline underline-offset-2">
              XMO-950-BLK
            </a>
            .
          </p>
        </Panel>
      )}
    </>
  );
}
