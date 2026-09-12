import { Chip, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { LiveInventoryList } from "@/components/inventory/LiveInventory";
import { requireSession } from "@/lib/auth/session";
import { inventoryRows } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";
import type { InventoryRow } from "@/lib/types";

const ALLOWED: PersonaKey[] = ["ceo", "lead_fulfill"];

const statusTone: Record<InventoryRow["status"], "red" | "amber" | "green" | "gray"> = {
  out: "red",
  low: "amber",
  ok: "green",
  aged: "gray",
};

function coverCell(r: InventoryRow) {
  if (r.status === "out")
    return <span className="font-extrabold text-red">Hết hàng</span>;
  if (r.coverDays === null) return <span className="text-soft">—</span>;
  return (
    <span
      className={`font-extrabold ${
        r.coverDays < 7 ? "text-red" : r.coverDays < 14 ? "text-amber" : "text-muted"
      }`}
    >
      {r.coverDays} ngày
    </span>
  );
}

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ f?: string }>;
}) {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  const { f } = await searchParams;
  const filter = f ?? "all";

  // Supabase mode → đọc từ vexim_inventory_latest
  if (session.mode === "supabase") {
    return <LiveInventoryList filter={filter} />;
  }

  // Demo mode → mock data
  const rows = inventoryRows.filter((r) => {
    if (filter === "low") return r.status === "low" || r.status === "out";
    if (filter === "out") return r.status === "out";
    if (filter === "aged") return r.status === "aged";
    return true;
  });

  const filters: [string, string, string][] = [
    ["all", "Tất cả", `${inventoryRows.length}`],
    ["low", "Sắp hết (cover <14)", `${inventoryRows.filter((r) => r.status === "low" || r.status === "out").length}`],
    ["out", "Hết hàng", `${inventoryRows.filter((r) => r.status === "out").length}`],
    ["aged", "Tồn lâu >365 ngày", `${inventoryRows.filter((r) => r.status === "aged").length}`],
  ];

  return (
    <>
      <div className="mb-3 text-sm font-bold text-amber">DEMO · Dữ liệu minh họa</div>
      <PageHeader
        title="Tồn kho theo SKU"
        sub={`${inventoryRows.length} SKU · cập nhật 45 phút trước (getInventorySummaries)`}
        desc="Nguồn: FBA Inventory API + notification FBA_INVENTORY_AVAILABILITY_CHANGES (realtime) + đối soát report 2h sáng. Cover = fulfillable ÷ velocity 14 ngày."
      />
      <div className="mb-4 flex flex-wrap gap-2">
        {filters.map(([key, label, count]) => (
          <a
            key={key}
            href={key === "all" ? "/fulfillment/inventory" : `/fulfillment/inventory?f=${key}`}
            className={`rounded-full border px-4 py-1.5 text-[12.5px] font-bold transition ${
              filter === key
                ? "border-accent bg-accent-soft text-accent-ink"
                : "border-line bg-card text-muted hover:border-accent"
            }`}
          >
            {label} · {count}
          </a>
        ))}
      </div>
      <Panel title="Danh sách SKU" hint="xếp theo mức rủi ro hết hàng → doanh thu">
        <table className={tableCls.table}>
          <thead>
            <tr>
              <th className={tableCls.th}>SKU / ASIN</th>
              <th className={tableCls.th}>Shop</th>
              <th className={`${tableCls.th} text-right`}>Khả dụng</th>
              <th className={`${tableCls.th} text-right`}>Reserved</th>
              <th className={`${tableCls.th} text-right`}>Đang về</th>
              <th className={`${tableCls.th} text-right`}>Bán/ngày</th>
              <th className={`${tableCls.th} text-right`}>Cover</th>
              <th className={`${tableCls.th} text-right`}>Đề xuất nhập</th>
              <th className={tableCls.th}>Trạng thái</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.sku}>
                <td className={tableCls.td}>
                  <a href={`/fulfillment/inventory/detail?sku=${r.sku}`} className="font-bold text-blue underline underline-offset-2">
                    {r.sku}
                  </a>
                  <div className="text-[11.5px] text-soft">{r.asin}</div>
                </td>
                <td className={tableCls.td}>{r.shop}</td>
                <td className={`${tableCls.tdNum} font-bold`}>{r.fulfillable}</td>
                <td className={tableCls.tdNum}>{r.reserved}</td>
                <td className={tableCls.tdNum}>{r.inbound}</td>
                <td className={tableCls.tdNum}>{r.velocity}</td>
                <td className={tableCls.tdNum}>{coverCell(r)}</td>
                <td className={`${tableCls.tdNum} font-bold`}>
                  {r.suggest === null ? "—" : r.suggest}
                </td>
                <td className={tableCls.td}>
                  <Chip tone={statusTone[r.status]}>{r.statusLabel}</Chip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel title="Nguyên tắc tính" hint="đúng docs/phan-tich-ky-thuat-module-3-kho-van.md">
        <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-muted">
          <li><b>Cover</b> chỉ tính số khả dụng — reserved (đang pick/ship) theo dõi riêng, không dùng để an tâm.</li>
          <li><b>Đề xuất nhập</b> = velocity × (lead time + safety 14 ngày) − (khả dụng + reserved + đang về), làm tròn theo case pack.</li>
          <li>SKU mới chưa có lịch sử bán (velocity 0): nhập theo kế hoạch launch — hệ thống không tự sinh số ảo.</li>
          <li>Đơn hàng đang về đã được trừ — tránh nhập chồng lô.</li>
        </ul>
      </Panel>
    </>
  );
}
