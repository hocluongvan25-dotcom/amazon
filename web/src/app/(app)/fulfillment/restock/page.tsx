import { Chip, KpiCard, KpiGrid, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { readInventoryLatest } from "@/lib/data/inventory";
import {
  mapInventoryRow,
  buildRestockRows,
  formatInventoryValueTotal,
  summarizeRestockValue,
  type InventoryLatestRaw,
} from "@/lib/data/inventory-model";
import { restockPlan } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo", "lead_fulfill"];

/** I3 kế hoạch nhập hàng — supabase mode */
async function LiveRestockPlan() {
  let rawRows: InventoryLatestRaw[] = [];
  let failed = false;

  try {
    rawRows = await readInventoryLatest();
  } catch {
    failed = true;
  }

  const allRows = rawRows.map(mapInventoryRow);
  const plan = buildRestockRows(allRows);

  const totalSuggest = plan.reduce((s, r) => s + r.suggest, 0);
  // 0017: giá trị các lô đề xuất = Σ (đề xuất nhập × giá vốn hiệu lực), theo từng tiền tệ
  const restockValue = summarizeRestockValue(allRows);

  return (
    <>
      <div className="mb-3 text-sm font-bold text-accent-ink">
        SUPABASE · dữ liệu thật từ vexim_inventory_latest
      </div>
      <PageHeader
        title="Kế hoạch nhập hàng"
        sub="SOP-01 · vòng đời 8 bước: nháp → chốt giá vốn → duyệt → tạo inbound → theo dõi → đối soát"
        desc="Đề xuất tự động = velocity × (lead time + safety 14 ngày) − (khả dụng + reserved + đang về). Ghi ra Amazon (createInboundPlan) kích hoạt ở Đợt 2."
      />
      {failed ? (
        <Panel title="Không tải được dữ liệu">
          <p role="alert">
            Không thể đọc Supabase. Kiểm tra migration 0011, quyền SELECT,
            RLS và phiên đăng nhập rồi tải lại.
          </p>
        </Panel>
      ) : (
        <>
          <KpiGrid>
            <KpiCard
              label="SKU cần nhập"
              value={String(plan.length)}
              sub="cover dưới ngưỡng hoặc hết hàng"
              tone={plan.length > 0 ? "down" : "flat"}
            />
            <KpiCard
              label="Tổng đề xuất"
              value={totalSuggest.toLocaleString("en-US")}
              sub={
                restockValue.missingCost > 0
                  ? `đơn vị · giá trị ${formatInventoryValueTotal(restockValue)} — ${restockValue.missingCost} SKU thiếu giá vốn`
                  : `đơn vị · giá trị ${formatInventoryValueTotal(restockValue)}`
              }
              tone={restockValue.missingCost > 0 ? "warn" : "flat"}
            />
            <KpiCard
              label="Chờ duyệt / chờ khách"
              value="0"
              sub="chưa có quy trình duyệt trong DB"
              tone="flat"
            />
            <KpiCard
              label="Đã tạo inbound plan"
              value="0"
              sub="chờ Đợt 2 — ghi Amazon"
              tone="flat"
            />
          </KpiGrid>
          <Panel
            title="Đề xuất từ dữ liệu thật"
            hint="velocity × (lead time + safety) − tồn · giá trị lô = đề xuất × giá vốn hiệu lực"
          >
            {plan.length === 0 ? (
              <p className="text-[13px] text-muted">
                Không có SKU nào cần nhập — tất cả cover đủ hoặc chưa có velocity.
              </p>
            ) : (
              <table className={tableCls.table}>
                <thead>
                  <tr>
                    <th className={tableCls.th}>SKU</th>
                    <th className={tableCls.th}>Shop</th>
                    <th className={`${tableCls.th} text-right`}>Đề xuất nhập</th>
                    <th className={`${tableCls.th} text-right`}>Giá vốn</th>
                    <th className={`${tableCls.th} text-right`}>Giá trị lô</th>
                    <th className={tableCls.th}>Tiến độ</th>
                    <th className={tableCls.th}>Trạng thái</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.map((r) => (
                    <tr key={r.sku}>
                      <td className={`${tableCls.td} font-bold`}>{r.sku}</td>
                      <td className={tableCls.td}>{r.shop}</td>
                      <td className={`${tableCls.tdNum} font-extrabold`}>{r.suggest}</td>
                      <td className={tableCls.tdNum}>{r.unitCost}</td>
                      <td className={tableCls.tdNum}>{r.value}</td>
                      <td className={tableCls.td}>
                        <Chip tone="blue">{r.step}</Chip>
                      </td>
                      <td className={tableCls.td}>
                        <Chip tone={r.tone}>{r.stepLabel}</Chip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
          <Panel title="Ghi ra Amazon — bị khóa ở Đợt 1">
            <div className="flex flex-col gap-2">
              <button
                disabled
                className="w-fit cursor-not-allowed rounded-full bg-[#eef1f5] px-5 py-2.5 text-[13.5px] font-bold text-soft"
                title="Mở khi: profile được duyệt + role Amazon Fulfillment active + pilot đối soát ≥99%"
              >
                🔒 Duyệt &amp; tạo inbound plan trên Amazon (createInboundPlan)
              </button>
              <p className="text-[12.5px] text-muted">
                Điều kiện kích hoạt: ① Developer Profile được duyệt · ② role{" "}
                <b>Amazon Fulfillment</b> active (đã chốt nộp kèm) · ③ pilot đối soát ≥
                99%. Khi mở: mọi thao tác vẫn đi qua duyệt theo ngưỡng giá trị lô +
                audit log như thiết kế.
              </p>
            </div>
          </Panel>
        </>
      )}
    </>
  );
}

export default async function RestockPage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  // Supabase mode → đọc từ vexim_inventory_latest
  if (session.mode === "supabase") {
    return <LiveRestockPlan />;
  }

  // Demo mode → mock data
  const totalValue = 1378 + 648 + 542 + 124 + 954;

  return (
    <>
      <div className="mb-3 text-sm font-bold text-amber">DEMO · Dữ liệu minh họa</div>
      <PageHeader
        title="Kế hoạch nhập hàng"
        sub="SOP-01 · vòng đời 8 bước: nháp → chốt giá vốn → duyệt → tạo inbound → theo dõi → đối soát"
        desc="Đề xuất tự động = velocity × (lead time + safety 14 ngày) − (khả dụng + reserved + đang về). Ghi ra Amazon (createInboundPlan) kích hoạt ở Đợt 2."
      />
      <KpiGrid>
        <KpiCard label="SKU cần nhập" value="5" sub="cover dưới ngưỡng hoặc hết hàng" tone="down" />
        <KpiCard label="Tổng giá trị đề xuất" value={`$${totalValue.toLocaleString("en-US")}`} sub="theo giá vốn hiện hành" tone="flat" />
        <KpiCard label="Chờ duyệt / chờ khách" value="3" sub="1 nháp · 1 chốt giá vốn · 1 kiểm tra lô" tone="warn" />
        <KpiCard label="Đã tạo inbound plan" value="2" sub="VPN-220 · XMO-950-WHT" tone="up" />
      </KpiGrid>
      <Panel title="Kế hoạch hiện tại" hint="trạng thái theo bước SOP-01">
        <table className={tableCls.table}>
          <thead>
            <tr>
              <th className={tableCls.th}>SKU</th>
              <th className={tableCls.th}>Shop</th>
              <th className={`${tableCls.th} text-right`}>Đề xuất nhập</th>
              <th className={`${tableCls.th} text-right`}>Giá vốn</th>
              <th className={`${tableCls.th} text-right`}>Giá trị lô</th>
              <th className={tableCls.th}>Tiến độ</th>
              <th className={tableCls.th}>Trạng thái</th>
            </tr>
          </thead>
          <tbody>
            {restockPlan.map((r) => (
              <tr key={r.sku}>
                <td className={`${tableCls.td} font-bold`}>{r.sku}</td>
                <td className={tableCls.td}>{r.shop}</td>
                <td className={`${tableCls.tdNum} font-extrabold`}>{r.suggest}</td>
                <td className={tableCls.tdNum}>{r.unitCost}</td>
                <td className={tableCls.tdNum}>{r.value}</td>
                <td className={tableCls.td}>
                  <Chip tone="blue">{r.step}</Chip>
                </td>
                <td className={tableCls.td}>
                  <Chip tone={r.tone}>{r.stepLabel}</Chip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel title="Ghi ra Amazon — bị khóa ở Đợt 1">
        <div className="flex flex-col gap-2">
          <button
            disabled
            className="w-fit cursor-not-allowed rounded-full bg-[#eef1f5] px-5 py-2.5 text-[13.5px] font-bold text-soft"
            title="Mở khi: profile được duyệt + role Amazon Fulfillment active + pilot đối soát ≥99%"
          >
            🔒 Duyệt &amp; tạo inbound plan trên Amazon (createInboundPlan)
          </button>
          <p className="text-[12.5px] text-muted">
            Điều kiện kích hoạt: ① Developer Profile được duyệt · ② role{" "}
            <b>Amazon Fulfillment</b> active (đã chốt nộp kèm) · ③ pilot đối soát ≥
            99%. Khi mở: mọi thao tác vẫn đi qua duyệt theo ngưỡng giá trị lô +
            audit log như thiết kế.
          </p>
        </div>
      </Panel>
    </>
  );
}
