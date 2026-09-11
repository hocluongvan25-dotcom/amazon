import { Chip, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { orderDetails, ordersList } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo"];

export default async function OrderDetailPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  const { id } = await searchParams;
  const detail = id ? orderDetails[id] : undefined;
  const fallback = ordersList.find((o) => o.id === id);

  return (
    <>
      <PageHeader
        title={`Đơn ${id ?? ""}`}
        sub={detail ? `${detail.date} · ${detail.channel} · ${detail.shop}` : (fallback ? `${fallback.date} · ${fallback.channel === "AFN" ? "AFN (FBA)" : "MFN (FBM)"} · Shop ${fallback.shop}` : "Không tìm thấy đơn")}
        desc="Nguồn: getOrder + getOrderItems (Orders API v0). Các trường PII bị khóa theo quyết định v1.1."
      />
      {detail ? (
        <>
          <Panel title="Món hàng" hint="getOrderItems">
            <table className={tableCls.table}>
              <thead>
                <tr>
                  <th className={tableCls.th}>SKU</th>
                  <th className={tableCls.th}>ASIN</th>
                  <th className={`${tableCls.th} text-right`}>Số lượng</th>
                  <th className={`${tableCls.th} text-right`}>Đơn giá</th>
                </tr>
              </thead>
              <tbody>
                {detail.items.map((it) => (
                  <tr key={it.sku}>
                    <td className={`${tableCls.td} font-bold`}>{it.sku}</td>
                    <td className={tableCls.td}>{it.asin}</td>
                    <td className={tableCls.tdNum}>{it.qty}</td>
                    <td className={tableCls.tdNum}>{it.price}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel title="Timeline trạng thái" hint="ORDER_CHANGE realtime">
              <div className="flex flex-col">
                {detail.timeline.map((t, i) => (
                  <div key={i} className="flex gap-3 border-b border-dashed border-[#eef0f4] py-2.5 last:border-0">
                    <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full bg-green-soft text-[11px] font-extrabold text-green">
                      ✓
                    </span>
                    <div>
                      <div className="text-[13px] font-bold">{t.event}</div>
                      <div className="text-[12px] text-soft">{t.time}</div>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
            <Panel title="Dòng tiền" hint="Finances API (đối soát 2h sáng)">
              <div className="flex flex-col gap-2">
                {detail.financials.map((f) => (
                  <div key={f.label} className="flex items-center justify-between rounded-[10px] border border-line px-3 py-2.5 text-[13px]">
                    <span className="font-semibold">{f.label}</span>
                    <span className={`font-extrabold tabular-nums ${f.tone === "down" ? "text-red" : ""}`}>
                      {f.amount}
                    </span>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
          <Panel title="Thông tin người mua">
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-3 rounded-[10px] border border-dashed border-line bg-bg px-3 py-3 text-[13px] text-muted">
                🔒 Tên, địa chỉ, điện thoại người mua — <b>đã khóa</b>
                <Chip tone="gray">
                  Mở khi được duyệt role Direct to Consumer Shipping (PII)
                </Chip>
              </div>
            </div>
          </Panel>
        </>
      ) : (
        <Panel title="Không tìm thấy đơn">
          <p className="text-[13px] text-muted">
            Đơn này chưa có dữ liệu chi tiết trong DEMO MODE — thử mở đơn{" "}
            <a href="/orders/detail?id=114-8823117-2217014" className="font-bold text-blue underline underline-offset-2">
              114-8823117-2217014
            </a>{" "}
            hoặc{" "}
            <a href="/orders/detail?id=113-5541209-1140233" className="font-bold text-blue underline underline-offset-2">
              113-5541209-1140233
            </a>
            .
          </p>
        </Panel>
      )}
    </>
  );
}
