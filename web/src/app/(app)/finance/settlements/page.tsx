import { Chip, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { settlementList } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";
import type { SettlementStatus } from "@/lib/types";

const ALLOWED: PersonaKey[] = ["ceo"];

const statusTone: Record<SettlementStatus, "green" | "amber" | "gray" | "blue"> = {
  deposited: "green",
  processing: "amber",
  open: "blue",
};
const statusLabel: Record<SettlementStatus, string> = {
  deposited: "Đã chuyển khoản",
  processing: "Đang xử lý",
  open: "Kỳ đang mở",
};

function usd(v: number) {
  const sign = v < 0 ? "−" : "";
  return `${sign}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function moneyCls(v: number) {
  return v > 0 ? "text-green font-semibold" : v < 0 ? "text-red" : "text-soft";
}

export default async function SettlementsPage({
  searchParams,
}: {
  searchParams: Promise<{ shop?: string; status?: string }>;
}) {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  const sp = await searchParams;
  const filterShop = sp.shop ?? "all";
  const filterStatus = sp.status ?? "all";

  let rows = settlementList.filter(
    (r) =>
      (filterShop === "all" || r.shop === filterShop) &&
      (filterStatus === "all" || r.status === filterStatus),
  );
  rows = [...rows].sort((a, b) => {
    // kỳ mở lên đầu, kỳ đã deposit sắp xếp theo depositDate desc
    if (a.status === "open" && b.status !== "open") return -1;
    if (b.status === "open" && a.status !== "open") return 1;
    return b.depositDate.localeCompare(a.depositDate);
  });

  const shops = [...new Set(settlementList.map((r) => r.shop))];

  const totalDeposited = settlementList
    .filter((r) => r.status === "deposited")
    .reduce((s, r) => s + r.transferAmount, 0);
  const openBalance = settlementList
    .filter((r) => r.status === "open")
    .reduce(
      (s, r) => s + r.sales + r.refunds + r.amazonFeesTotal + r.advertisingFees + r.otherCharges,
      0,
    );

  return (
    <>
      <PageHeader
        title="Kỳ thanh toán (Settlements)"
        sub={`${settlementList.length} kỳ · ${shops.length} shop · đối soát khi có kỳ mới từ report GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE`}
        desc="Nguồn: Finances API v0 (listFinancialEventGroups / listFinancialEventsByGroupId) + report Settlement V2 flat file. Mỗi kỳ 14 ngày (mặc định); tiền chuyển về tài khoản sau khi Amazon trừ reserve."
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
              href === "/finance/settlements"
                ? "rounded-full border border-accent bg-accent-soft px-4 py-1.5 text-[12.5px] font-bold text-accent-ink"
                : "rounded-full border border-line bg-card px-4 py-1.5 text-[12.5px] font-bold text-muted transition hover:border-accent hover:bg-accent-soft hover:text-accent-ink"
            }
          >
            {label}
          </a>
        ))}
      </div>

      {/* 4 KPI */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-[13px] border border-line bg-card px-4 py-3">
          <div className="text-[11.5px] font-bold uppercase text-soft">Tiền về kỳ gần nhất</div>
          <div className="mt-0.5 text-[23px] font-extrabold">
            {usd(settlementList.find((r) => r.status === "deposited")?.transferAmount ?? 0)}
          </div>
          <div className="mt-0.5 text-[12px] font-semibold text-soft">kỳ 27/08 → 09/09</div>
        </div>
        <div className="rounded-[13px] border border-line bg-card px-4 py-3">
          <div className="text-[11.5px] font-bold uppercase text-soft">Tổng đã nhận 6 kỳ</div>
          <div className="mt-0.5 text-[23px] font-extrabold">{usd(totalDeposited)}</div>
          <div className="mt-0.5 text-[12px] font-semibold text-green">về tài khoản ****4218</div>
        </div>
        <div className="rounded-[13px] border border-line bg-card px-4 py-3">
          <div className="text-[11.5px] font-bold uppercase text-soft">Số dư kỳ đang mở</div>
          <div className="mt-0.5 text-[23px] font-extrabold">{usd(openBalance)}</div>
          <div className="mt-0.5 text-[12px] font-semibold text-blue">dự kiến đóng 23/09</div>
        </div>
        <div className="rounded-[13px] border border-line bg-card px-4 py-3">
          <div className="text-[11.5px] font-bold uppercase text-soft">Tổng phí kỳ này</div>
          <div className="mt-0.5 text-[23px] font-extrabold">
            {usd(
              -(
                settlementList
                  .filter((r) => r.status === "deposited")
                  .reduce((s, r) => s + Math.abs(r.amazonFeesTotal) + Math.abs(r.advertisingFees), 0)
              ),
            )}
          </div>
          <div className="mt-0.5 text-[12px] font-semibold text-soft">referral + FBA + storage + ads</div>
        </div>
      </div>

      {/* Filter shop / trạng thái */}
      <div className="mb-3 flex flex-wrap gap-2">
        <span className="self-center text-[11.5px] font-bold uppercase tracking-wide text-soft">Shop:</span>
        {[["all", "Tất cả"], ...shops.map((s) => [s, `Shop ${s}`] as [string, string])].map(([key, label]) => {
          const active = filterShop === key;
          return (
            <a
              key={key}
              href={`/finance/settlements?shop=${key}${filterStatus !== "all" ? `&status=${filterStatus}` : ""}`}
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
        <span className="mx-1 w-px self-stretch bg-line" />
        <span className="self-center text-[11.5px] font-bold uppercase tracking-wide text-soft">Trạng thái:</span>
        {(
          [
            ["all", "Tất cả"],
            ["deposited", "Đã gửi"],
            ["processing", "Đang xử lý"],
            ["open", "Đang mở"],
          ] as [string, string][]
        ).map(([key, label]) => {
          const active = filterStatus === key;
          return (
            <a
              key={key}
              href={`/finance/settlements?status=${key}${filterShop !== "all" ? `&shop=${filterShop}` : ""}`}
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

      <Panel title={`${rows.length} kỳ settlement`} hint="click một kỳ để xem chi tiết dòng tiền + breakdown theo SKU">
        <table className={tableCls.table}>
          <thead>
            <tr>
              <th className={tableCls.th}>Mã kỳ / Shop</th>
              <th className={tableCls.th}>Giai đoạn</th>
              <th className={tableCls.th}>Ngày chuyển</th>
              <th className={`${tableCls.th} text-right`}>Bán hàng</th>
              <th className={`${tableCls.th} text-right`}>Refunds</th>
              <th className={`${tableCls.th} text-right`}>Fees Amazon</th>
              <th className={`${tableCls.th} text-right`}>Ads</th>
              <th className={`${tableCls.th} text-right`}>Khác</th>
              <th className={`${tableCls.th} text-right`}>Tiền về</th>
              <th className={tableCls.th}>Trạng thái</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.shop}-${r.id}`}>
                <td className={tableCls.td}>
                  <span className="font-mono text-[11.5px] text-soft">{r.id}</span>
                  <div className="font-bold">Shop {r.shop}</div>
                </td>
                <td className={tableCls.td}>
                  {r.startDate} → {r.endDate}
                </td>
                <td className={tableCls.td}>
                  {r.status === "open" ? <span className="text-soft">—</span> : r.depositDate}
                  {r.status === "deposited" ? (
                    <div className="text-[11px] text-soft">{r.accountDeposit}</div>
                  ) : null}
                </td>
                <td className={`${tableCls.tdNum} font-semibold text-green`}>{usd(r.sales)}</td>
                <td className={`${tableCls.tdNum} ${moneyCls(r.refunds)}`}>{usd(r.refunds)}</td>
                <td className={`${tableCls.tdNum} ${moneyCls(r.amazonFeesTotal)}`}>{usd(r.amazonFeesTotal)}</td>
                <td className={`${tableCls.tdNum} ${moneyCls(r.advertisingFees)}`}>{usd(r.advertisingFees)}</td>
                <td className={`${tableCls.tdNum} ${moneyCls(r.otherCharges)}`}>{usd(r.otherCharges)}</td>
                <td className={`${tableCls.tdNum} font-extrabold text-accent-ink`}>
                  {r.status === "open" ? (
                    <span className="text-soft">đang mở</span>
                  ) : (
                    <a
                      href={`/finance/settlements/detail?id=${r.id}`}
                      className="text-accent-ink underline underline-offset-2"
                    >
                      {usd(r.transferAmount)}
                    </a>
                  )}
                </td>
                <td className={tableCls.td}>
                  <Chip tone={statusTone[r.status]}>{statusLabel[r.status]}</Chip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <p className="mt-3 text-[11.5px] font-semibold text-soft">
        Transfer = Sales + Shipping/GiftWrap − Refunds − AmazonFees (referral+FBA+storage+closing) − Ads ±
        Adjustments/Reimbursements. Reserve (số tiền Amazon giữ cho chargeback) được giải tỏa sau 7 ngày theo kỳ
        tiếp theo. Đối soát lệch {">"}1% tự động tạo cảnh báo SOP-10.
      </p>
    </>
  );
}
