import { NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { settlementDetails, settlementList } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo"];

function usd(v: number) {
  const sign = v < 0 ? "−" : "";
  return `${sign}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function toneCls(v: number) {
  return v > 0 ? "text-green" : v < 0 ? "text-red" : "text-soft";
}

export default async function SettlementDetailPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  const { id } = await searchParams;
  const selId = id && settlementDetails[id] ? id : "12948510001";
  const d = settlementDetails[selId];
  const sum = d.groups.reduce((s, g) => s + g.amount, 0);
  const header = settlementList.find((r) => r.id === selId);

  return (
    <>
      <PageHeader
        title={`Kỳ settlement · ${d.id}`}
        sub={`${d.shop} · ${d.startDate} → ${d.endDate} · chuyển ${d.depositDate}`}
        desc="Chi tiết dòng tiền trong kỳ: nhóm phí theo loại + breakdown top SKU đóng góp doanh thu/phí trong kỳ. Nguồn: listFinancialEventsByGroupId + GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE."
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <a href="/finance/settlements" className="rounded-full border border-line bg-card px-4 py-1.5 text-[12.5px] font-bold text-muted transition hover:border-accent hover:text-accent-ink">
          ← Danh sách kỳ
        </a>
      </div>

      {/* Headline: tiền về */}
      <div className="mb-4 rounded-[13px] border-2 border-accent bg-accent-soft px-5 py-4">
        <div className="text-[11.5px] font-bold uppercase tracking-wide text-accent-ink">
          Tiền chuyển về tài khoản
        </div>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-4">
          <div className="text-[34px] font-extrabold text-accent-ink">{usd(d.transferAmount)}</div>
          <div className="text-[13px] font-semibold text-accent-ink">{d.accountDeposit}</div>
        </div>
        <div className="mt-1 text-[12px] text-accent-ink">Tổng các nhóm dưới đây: {usd(sum)} (khớp transfer)</div>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Panel title="Phân loại dòng tiền" hint="cùng nhóm với V2 Settlement report">
            <table className={tableCls.table}>
              <thead>
                <tr>
                  <th className={tableCls.th}>Nhóm</th>
                  <th className={`${tableCls.th} text-right`}>Số tiền</th>
                  <th className={tableCls.th}>Chi tiết</th>
                </tr>
              </thead>
              <tbody>
                {d.groups.map((g) => (
                  <>
                    <tr key={g.label} className="border-t-2 border-line bg-[#fafbfd]">
                      <td className={`${tableCls.td} font-bold`}>{g.label}</td>
                      <td className={`${tableCls.tdNum} font-extrabold ${toneCls(g.amount)}`}>{usd(g.amount)}</td>
                      <td className={tableCls.td}></td>
                    </tr>
                    {g.children?.map((c) => (
                      <tr key={c.label}>
                        <td className={`${tableCls.td} pl-6 text-[12.5px] text-muted`}>{c.label}</td>
                        <td className={`${tableCls.tdNum} ${toneCls(c.amount)}`}>{usd(c.amount)}</td>
                        <td className={tableCls.td}></td>
                      </tr>
                    ))}
                  </>
                ))}
                <tr className="border-t-2 border-line">
                  <td className={`${tableCls.td} font-extrabold`}>Chuyển khoản ròng</td>
                  <td className={`${tableCls.tdNum} font-extrabold text-accent-ink`}>{usd(d.transferAmount)}</td>
                  <td className={tableCls.td}></td>
                </tr>
              </tbody>
            </table>
          </Panel>
        </div>

        <div className="lg:col-span-2">
          <Panel title="Đầu vào / đầu ra theo loại" hint="tổng hợp nhanh">
            <div className="flex flex-col gap-2 text-[13px]">
              <div className="flex items-center justify-between rounded-[10px] border border-green/30 bg-green-soft px-3 py-2">
                <span className="font-bold text-[#0b7a55]">Tổng tiền vào</span>
                <span className="font-extrabold text-[#0b7a55]">
                  {usd(d.groups.filter((g) => g.amount > 0).reduce((s, g) => s + g.amount, 0))}
                </span>
              </div>
              <div className="flex items-center justify-between rounded-[10px] border border-red/30 bg-red-soft px-3 py-2">
                <span className="font-bold text-[#a01717]">Tổng tiền ra (phí + refund)</span>
                <span className="font-extrabold text-[#a01717]">
                  {usd(d.groups.filter((g) => g.amount < 0).reduce((s, g) => s + g.amount, 0))}
                </span>
              </div>
              <div className="flex items-center justify-between rounded-[10px] border border-accent bg-accent-soft px-3 py-2">
                <span className="font-bold text-accent-ink">Chuyển khoản ròng</span>
                <span className="font-extrabold text-accent-ink">{usd(d.transferAmount)}</span>
              </div>
            </div>
          </Panel>

          <Panel title="Tỷ lệ phí / doanh thu kỳ" hint="so sánh nhanh">
            {(() => {
              const gross = d.groups.find((g) => g.label.startsWith("Product sales"))?.amount ?? 0;
              const fees = Math.abs(
                d.groups.find((g) => g.label === "Amazon Fees")?.amount ?? 0,
              );
              const ads = Math.abs(d.groups.find((g) => g.label.startsWith("Advertising"))?.amount ?? 0);
              const takeRate = ((fees + ads) / gross) * 100;
              return (
                <div className="flex flex-col gap-2 text-[13px]">
                  <div className="flex justify-between">
                    <span className="text-muted">Product sales</span>
                    <span className="font-bold">{usd(gross)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">Amazon Fees rate</span>
                    <span className="font-bold text-red">{((fees / gross) * 100).toFixed(1)}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">Ad spend rate (TACOS)</span>
                    <span className="font-bold text-amber">{((ads / gross) * 100).toFixed(1)}%</span>
                  </div>
                  <div className="mt-1 flex justify-between border-t border-line pt-2">
                    <span className="font-extrabold">Tổng take rate</span>
                    <span className="font-extrabold text-accent-ink">{takeRate.toFixed(1)}%</span>
                  </div>
                  <div className="mt-1 rounded-[8px] bg-bg px-2.5 py-1.5 text-[11.5px] text-soft">
                    Mục tiêu: TACOS ≤ 8% · take rate tổng ≤ 30% (còn ≥70% về VEXIM sau khi trừ giá vốn).
                  </div>
                </div>
              );
            })()}
          </Panel>
        </div>
      </div>

      <Panel title="Top SKU theo doanh thu kỳ này" hint="breakdown từ GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE">
        <table className={tableCls.table}>
          <thead>
            <tr>
              <th className={tableCls.th}>SKU</th>
              <th className={`${tableCls.th} text-right`}>Số lượng</th>
              <th className={`${tableCls.th} text-right`}>Product sales</th>
              <th className={`${tableCls.th} text-right`}>Amazon fees</th>
              <th className={`${tableCls.th} text-right`}>Net sau phí</th>
              <th className={`${tableCls.th} text-right`}>% tổng</th>
            </tr>
          </thead>
          <tbody>
            {(() => {
              const total = d.skuBreakdown.reduce((s, r) => s + r.productSales, 0);
              return d.skuBreakdown.map((r) => (
                <tr key={r.sku}>
                  <td className={`${tableCls.td} font-bold text-blue underline underline-offset-2`}>
                    <a href={`/pricing/detail?sku=${r.sku}`}>{r.sku}</a>
                    <span className="ml-2 text-[11px] font-normal text-soft">
                      <a href={`/listing/detail?sku=${r.sku}`}>listing</a>
                    </span>
                  </td>
                  <td className={tableCls.tdNum}>{r.quantity}</td>
                  <td className={tableCls.tdNum}>{usd(r.productSales)}</td>
                  <td className={`${tableCls.tdNum} text-red`}>{usd(r.amazonFees)}</td>
                  <td className={`${tableCls.tdNum} font-bold text-green`}>{usd(r.net)}</td>
                  <td className={tableCls.tdNum}>
                    {((r.productSales / total) * 100).toFixed(1)}%
                  </td>
                </tr>
              ));
            })()}
          </tbody>
        </table>
      </Panel>

      <p className="mt-3 text-[11.5px] font-semibold text-soft">
        Breakdown theo SKU lấy từ cột item-related fields của settlement report. Lưu ý: lợi nhuận thật (trừ giá vốn
        + ads phân bổ theo SKU) sẽ có ở F4 Lợi nhuận SKU (Đợt 2). F1 mới đối soát dòng tiền vào/ra theo Amazon.
        Kỳ này không có chênh lệch nào {">"}1%.
        {header ? " " : ""}
      </p>
    </>
  );
}
