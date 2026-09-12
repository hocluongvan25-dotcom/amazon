import { Chip, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { LiveListingQueue } from "@/components/listing/LiveListing";
import { requireSession } from "@/lib/auth/session";
import { listingQueueFull } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo"];

export default async function ListingQueuePage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  // Supabase mode
  if (session.mode === "supabase") {
    return <LiveListingQueue />;
  }

  // Demo mode
  const open = listingQueueFull.length;
  const unassigned = listingQueueFull.filter((r) => r.owner === "—").length;
  const highRev = listingQueueFull.filter((r) => r.priority === "red").length;

  return (
    <>
      <div className="mb-3 text-sm font-bold text-amber">DEMO · Dữ liệu minh họa</div>
      <PageHeader
        title="Hàng đợi inactive / stranded — SOP-03"
        sub={`${open} SKU đang mở · ${unassigned} chưa gán · SLA: SKU doanh thu cao ≤ 24h`}
        desc="Nguồn: report GET_MERCHANT_LISTINGS_INACTIVE_DATA + GET_STRANDED_INVENTORY_UI_DATA (hằng ngày) + notification LISTINGS_ITEM_ISSUES_CHANGE (realtime)."
      />
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[
          { label: "SKU đang mở", value: `${open}`, sub: "inactive + stranded + suppressed", tone: "down" },
          { label: "Ưu tiên cao (≤ 24h)", value: `${highRev}`, sub: "doanh thu cao — SLA hôm nay", tone: "down" },
          { label: "Chưa gán người xử lý", value: `${unassigned}`, sub: "trưởng phòng gán ngay khi vào ca", tone: unassigned > 0 ? "warn" : "up" },
        ].map((k) => (
          <div key={k.label} className="rounded-[13px] border border-line bg-card px-4 py-3.5">
            <div className="text-[11.5px] font-bold uppercase tracking-wide text-soft">{k.label}</div>
            <div
              className={`mt-0.5 text-[22px] font-extrabold tracking-tight ${
                k.tone === "down" ? "text-red" : k.tone === "warn" ? "text-amber" : "text-green"
              }`}
            >
              {k.value}
            </div>
            <div className="mt-0.5 text-[11.5px] font-semibold text-soft">{k.sub}</div>
          </div>
        ))}
      </div>
      <Panel title="Queue xử lý hôm nay" hint="xếp theo doanh thu/SKU — SOP-03: xác định nguyên nhân → sửa → duyệt → theo dõi 24h">
        <table className={tableCls.table}>
          <thead>
            <tr>
              <th className={tableCls.th}>SKU / ASIN</th>
              <th className={tableCls.th}>Shop</th>
              <th className={tableCls.th}>Nguyên nhân (mã lỗi)</th>
              <th className={tableCls.th}>Đề xuất sửa</th>
              <th className={tableCls.th}>SLA</th>
              <th className={`${tableCls.th} text-right`}>Doanh thu/SKU</th>
              <th className={tableCls.th}>Ưu tiên</th>
              <th className={tableCls.th}>Ai giữ</th>
            </tr>
          </thead>
          <tbody>
            {listingQueueFull.map((r) => (
              <tr key={r.sku}>
                <td className={tableCls.td}>
                  <a href={`/listing/detail?sku=${r.sku}`} className="font-bold text-blue underline underline-offset-2">
                    {r.sku}
                  </a>
                  <div className="text-[11.5px] text-soft">{r.asin}</div>
                </td>
                <td className={tableCls.td}>{r.shop}</td>
                <td className={`${tableCls.td} text-[12.5px]`}>
                  {r.cause}
                  <div className="mt-0.5 text-[11px] font-bold text-soft">{r.causeCode}</div>
                </td>
                <td className={`${tableCls.td} max-w-[260px] text-[12.5px]`}>{r.suggestion}</td>
                <td className={`${tableCls.td} text-[12px] font-bold`}>{r.slaLabel}</td>
                <td className={tableCls.tdNum}>{r.revenuePerDay}</td>
                <td className={tableCls.td}>
                  <Chip tone={r.priority}>{r.priorityLabel}</Chip>
                </td>
                <td className={`${tableCls.td} font-bold ${r.owner === "—" ? "text-red" : ""}`}>{r.owner}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <p className="mt-3 text-[11.5px] font-semibold text-soft">
        Luồng SOP-03: hệ thống xác định nguyên nhân từ issues list → Listing soạn bản sửa tại Seller Central →
        trưởng phòng duyệt → theo dõi 24h xác nhận ACTIVE. Stranded do tồn không bán được → phối Kho vận (SOP-03
        bước 6). Publish bằng patchListingsItem mở khóa Đợt 2.
      </p>
    </>
  );
}
