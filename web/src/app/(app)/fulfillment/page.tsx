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
import { LiveFulfillmentOverview } from "@/components/inventory/LiveInventory";
import { requireSession } from "@/lib/auth/session";
import { fulfillKpis, inboundShipments, inventoryRows, skuStock } from "@/lib/data/mock";
import { formatInventoryValueTotal, summarizeInventoryValue } from "@/lib/data/inventory-model";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo", "lead_fulfill"];

export default async function FulfillmentPage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;
  if (session.mode === "supabase") return <LiveFulfillmentOverview />;

  return (
    <>
      <div className="mb-3 text-sm font-bold text-amber">DEMO · Dữ liệu minh họa</div>
      <PageHeader
        title="Kho vận & FBA"
        sub={
          session.persona === "lead_fulfill"
            ? "Hôm nay · 9 shop có FBA · tồn kho cập nhật 45 phút trước"
            : "Hôm nay · cập nhật tồn kho 45 phút trước"
        }
        desc="Tổng quan kho FBA: lượng hàng bán được, hàng đang về, hàng tồn lâu ngày — và cảnh báo SKU sắp hết hàng cần nhập thêm."
      />
      <div className="mb-4 flex flex-wrap gap-2">
        {[
          ["/fulfillment/inventory", "📦 Tồn kho theo SKU"],
          ["/fulfillment/restock", "🧮 Kế hoạch nhập hàng"],
          ["/fulfillment/inbound", "🚚 Inbound shipments"],
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
        {/* 0017: thẻ "Tồn khả dụng" thành "Giá trị tồn kho" — tính từ chính mock
            inventoryRows để bản demo và bản live kể cùng một câu chuyện */}
        {fulfillKpis
          .map((k) => {
            if (k.label !== "Tồn khả dụng") return k;
            const valueSum = summarizeInventoryValue(inventoryRows);
            return {
              label: "Giá trị tồn kho",
              value: formatInventoryValueTotal(valueSum),
              sub:
                valueSum.missingCost > 0
                  ? `Σ tồn × giá vốn · ${valueSum.missingCost} SKU chưa định giá`
                  : `Σ tồn × giá vốn · đủ ${valueSum.valued} SKU`,
              tone: (valueSum.missingCost > 0 ? "warn" : "flat") as "warn" | "flat",
            };
          })
          .map((k) => (
            <KpiCard key={k.label} {...k} />
          ))}
      </KpiGrid>
      <Grid2>
        <Panel title="SKU sắp hết — xếp theo doanh thu" hint="đề xuất số lượng nhập">
          <table className={tableCls.table}>
            <thead>
              <tr>
                <th className={tableCls.th}>SKU</th>
                <th className={`${tableCls.th} text-right`}>Tồn</th>
                <th className={`${tableCls.th} text-right`}>Cover</th>
                <th className={`${tableCls.th} text-right`}>Bán/ngày</th>
                <th className={`${tableCls.th} text-right`}>Đề xuất nhập</th>
              </tr>
            </thead>
            <tbody>
              {skuStock.map((r) => (
                <tr key={r.sku}>
                  <td className={`${tableCls.td} font-bold`}>{r.sku}</td>
                  <td className={tableCls.tdNum}>{r.stock}</td>
                  <td
                    className={`${tableCls.tdNum} font-bold ${
                      r.coverTone === "red" ? "text-red" : "text-amber"
                    }`}
                  >
                    {r.coverDays} ngày
                  </td>
                  <td className={tableCls.tdNum}>{r.perDay}</td>
                  <td className={`${tableCls.tdNum} font-bold`}>{r.suggest}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="Inbound shipments">
          <MiniList
            items={inboundShipments.map((s) => ({
              icon: s.tone === "down" ? "⚠️" : s.tone === "warn" ? "📦" : "🚚",
              title: `Shipment ${s.id}`,
              sub: `${s.units} · ${s.note}`,
              right: s.right,
              tone: s.tone,
            }))}
          />
        </Panel>
      </Grid2>
    </>
  );
}
