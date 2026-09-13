import { LiveOperations } from "@/components/operations/LiveOperations";
import { Chip, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { eventTypeFilters, financialEvents } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";
import type { FinancialEventType } from "@/lib/types";

const ALLOWED: PersonaKey[] = ["ceo"];

const eventTone: Record<FinancialEventType, "green" | "red" | "amber" | "blue" | "gray"> = {
  ProductSale: "green",
  ShippingCredit: "green",
  Refund: "red",
  ReferralFee: "red",
  FBAFee: "red",
  StorageFee: "red",
  AdvertisingFee: "amber",
  Reimbursement: "green",
  Adjustment: "blue",
  ServiceFee: "red",
  Subscription: "red",
  Reserve: "gray",
  // Bổ sung khi cắm dữ liệu thật từ report settlement V2 (module 6)
  Transfer: "blue",
  PromotionRebate: "amber",
};
void eventTone;

function usd(v: number) {
  const sign = v < 0 ? "−" : "";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}
function moneyCls(v: number) {
  return v > 0 ? "font-bold text-green" : v < 0 ? "text-red" : "text-soft";
}

export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; shop?: string; q?: string }>;
}) {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;
  if (session.mode === "supabase") return <LiveOperations screen="events" />;

  const sp = await searchParams;
  const fType = (sp.type ?? "all") as FinancialEventType | "all";
  const fShop = sp.shop ?? "all";
  const q = (sp.q ?? "").trim().toLowerCase();

  let rows = financialEvents.filter((e) => {
    if (fType !== "all" && e.type !== fType) return false;
    if (fShop !== "all" && e.shop !== fShop) return false;
    if (q) {
      const hay = `${e.id} ${e.description} ${e.orderId ?? ""} ${e.sku ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Tổng hợp nhanh theo filter
  const totalIn = rows.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
  const totalOut = rows.filter((e) => e.amount < 0).reduce((s, e) => s + e.amount, 0);
  const shops = [...new Set(financialEvents.map((e) => e.shop))];

  return (
    <>
      <div className="mb-3 text-sm font-bold text-amber">DEMO · Dữ liệu minh họa</div>
      <PageHeader
        title="Dòng tài chính"
        sub={`${financialEvents.length} sự kiện trên ${shops.length} shop · append-only`}
        desc="Sổ cái mọi biến động tiền trên Amazon: bán hàng, hoàn tiền, phí, điều chỉnh… Mỗi đồng ra vào đều truy vết được — nền tảng cho đối soát và tính lợi nhuận."
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <a href="/finance" className="rounded-full border border-line bg-card px-4 py-1.5 text-[12.5px] font-bold text-muted transition hover:border-accent hover:text-accent-ink">
          ← Tổng quan tài chính
        </a>
        {[
          ["/finance/settlements", "🏦 Kỳ settlement (F1)"],
          ["/finance/events", "📒 Dòng tài chính (F2)"],
        ].map(([href, label]) => (
          <a
            key={href}
            href={href}
            className={
              href === "/finance/events"
                ? "rounded-full border border-accent bg-accent-soft px-4 py-1.5 text-[12.5px] font-bold text-accent-ink"
                : "rounded-full border border-line bg-card px-4 py-1.5 text-[12.5px] font-bold text-muted transition hover:border-accent hover:bg-accent-soft hover:text-accent-ink"
            }
          >
            {label}
          </a>
        ))}
      </div>

      {/* KPI lọc được */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-[13px] border border-line bg-card px-4 py-3">
          <div className="text-[11.5px] font-bold uppercase text-soft">Sự kiện khớp bộ lọc</div>
          <div className="mt-0.5 text-[23px] font-extrabold">{rows.length}</div>
          <div className="mt-0.5 text-[12px] text-soft">dòng tài chính</div>
        </div>
        <div className="rounded-[13px] border border-line bg-card px-4 py-3">
          <div className="text-[11.5px] font-bold uppercase text-soft">Tiền vào</div>
          <div className="mt-0.5 text-[23px] font-extrabold text-green">{usd(totalIn)}</div>
          <div className="mt-0.5 text-[12px] text-soft">sales + reimbursements</div>
        </div>
        <div className="rounded-[13px] border border-line bg-card px-4 py-3">
          <div className="text-[11.5px] font-bold uppercase text-soft">Tiền ra</div>
          <div className="mt-0.5 text-[23px] font-extrabold text-red">{usd(totalOut)}</div>
          <div className="mt-0.5 text-[12px] text-soft">fees + refunds + ads</div>
        </div>
        <div className="rounded-[13px] border border-line bg-card px-4 py-3">
          <div className="text-[11.5px] font-bold uppercase text-soft">Net (mẫu)</div>
          <div className="mt-0.5 text-[23px] font-extrabold text-accent-ink">{usd(totalIn + totalOut)}</div>
          <div className="mt-0.5 text-[12px] text-soft">bộ lọc hiện tại</div>
        </div>
      </div>

      {/* Filter */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <form action="/finance/events" method="get" className="flex flex-1 items-center gap-2">
          {fType !== "all" ? <input type="hidden" name="type" value={fType} /> : null}
          {fShop !== "all" ? <input type="hidden" name="shop" value={fShop} /> : null}
          <input
            name="q"
            defaultValue={sp.q ?? ""}
            placeholder="Tìm order ID / SKU / mô tả…"
            className="h-9 w-full max-w-xs rounded-full border border-line bg-card px-4 text-[13px] font-semibold outline-none placeholder:text-soft focus:border-accent"
          />
          <button
            type="submit"
            className="h-9 rounded-full border border-line bg-card px-4 text-[12.5px] font-bold text-muted transition hover:border-accent hover:text-accent-ink"
          >
            Tìm
          </button>
        </form>
        <button
          type="button"
          disabled
          title="Xuất CSV cho đối soát (kích hoạt khi có Supabase)"
          className="h-9 cursor-not-allowed rounded-full border border-dashed border-line px-4 py-2 text-[12.5px] font-bold text-soft"
        >
          ⬇ Xuất CSV
        </button>
      </div>

      <div className="mb-2 flex flex-wrap gap-2">
        <span className="self-center text-[11.5px] font-bold uppercase tracking-wide text-soft">Loại:</span>
        {eventTypeFilters.map((f) => {
          const active = fType === f.id;
          return (
            <a
              key={f.id}
              href={`/finance/events?type=${f.id}${fShop !== "all" ? `&shop=${fShop}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
              className={`rounded-full border px-3.5 py-1.5 text-[12.5px] font-bold transition ${
                active
                  ? "border-accent bg-accent-soft text-accent-ink"
                  : "border-line bg-card text-muted hover:border-accent"
              }`}
            >
              {f.label}
            </a>
          );
        })}
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        <span className="self-center text-[11.5px] font-bold uppercase tracking-wide text-soft">Shop:</span>
        {[["all", "Tất cả"], ...shops.map((s) => [s, `Shop ${s}`] as [string, string])].map(([key, label]) => {
          const active = fShop === key;
          return (
            <a
              key={key}
              href={`/finance/events?shop=${key}${fType !== "all" ? `&type=${fType}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
              className={`rounded-full border px-3.5 py-1.5 text-[12.5px] font-bold transition ${
                active
                  ? "border-accent bg-accent-soft text-accent-ink"
                  : "border-line bg-card text-muted hover:border-accent"
              }`}
            >
              {label}
            </a>
          );
        })}
      </div>

      <Panel title={`${rows.length} dòng tài chính`} hint="thời gian thực · sắp xếp mới nhất trước">
        <table className={tableCls.table}>
          <thead>
            <tr>
              <th className={tableCls.th}>Thời gian</th>
              <th className={tableCls.th}>Shop</th>
              <th className={tableCls.th}>Loại</th>
              <th className={tableCls.th}>Mô tả</th>
              <th className={tableCls.th}>Order / SKU</th>
              <th className={`${tableCls.th} text-right`}>Số tiền</th>
              <th className={tableCls.th}>Kỳ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <td className={tableCls.td}>
                  <span className="font-mono text-[12px]">{e.postedAt}</span>
                </td>
                <td className={tableCls.td}>{e.shop}</td>
                <td className={tableCls.td}>
                  <Chip tone={eventTone[e.type]}>{e.typeLabel}</Chip>
                </td>
                <td className={tableCls.td}>
                  <div className="max-w-[320px] truncate" title={e.description}>
                    {e.description}
                  </div>
                </td>
                <td className={tableCls.td}>
                  {e.orderId ? (
                    <a
                      href={`/orders/detail?id=${e.orderId}`}
                      className="font-mono text-[11.5px] text-blue underline underline-offset-2"
                    >
                      {e.orderId.slice(0, 10)}…
                    </a>
                  ) : null}
                  {e.sku ? (
                    <div>
                      <a href={`/pricing/detail?sku=${e.sku}`} className="font-bold text-[12px] text-blue underline underline-offset-2">
                        {e.sku}
                      </a>
                    </div>
                  ) : null}
                </td>
                <td className={`${tableCls.tdNum} ${moneyCls(e.amount)}`}>{usd(e.amount)}</td>
                <td className={tableCls.td}>
                  {e.settlementId ? (
                    <a href={`/finance/settlements/detail?id=${e.settlementId}`} className="font-mono text-[11.5px] text-soft underline underline-offset-2">
                      {e.settlementId === "OPEN-A1" || e.settlementId.startsWith("OPEN") ? "kỳ mở" : e.settlementId.slice(0, 8)}…
                    </a>
                  ) : (
                    <span className="text-soft">—</span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className={`${tableCls.td} text-center text-soft`}>
                  Không có sự kiện nào khớp bộ lọc.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>

      <p className="mt-3 text-[11.5px] font-semibold text-soft">
        Append-only: không thể sửa/xóa trên UI (đối soát với Amazon là nguồn sự thật). F4 Lợi nhuận SKU (Đợt 2) sẽ
        JOIN bảng này với bảng `catalog.cost_inputs` (giá vốn) + ads spend phân bổ để tính lãi thực từng SKU.
      </p>
    </>
  );
}
