import {
  AlertList,
  Bars,
  Chip,
  Grid2,
  NoAccess,
  PageHeader,
  Panel,
  tableCls,
} from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { readPricing } from "@/lib/data/pricing";
import { COST_BASIS_HINT, COST_BASIS_VI, mapPricingRow, type PricingRaw } from "@/lib/data/pricing-model";
import { pricingDetails, pricingRows } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo"];

/** P2 chi tiết giá — supabase mode */
async function LivePricingDetail({ sku }: { sku: string }) {
  let rawRows: PricingRaw[] = [];
  let failed = false;

  try {
    rawRows = await readPricing();
  } catch {
    failed = true;
  }

  const raw = rawRows.find((r) => r.sku === sku);

  if (failed) {
    return (
      <>
        <div className="mb-3 text-sm font-bold text-accent-ink">SUPABASE</div>
        <PageHeader title={`Chi tiết giá · ${sku}`} sub="Lỗi tải dữ liệu" />
        <Panel title="Lỗi"><p role="alert">Không thể đọc Supabase.</p></Panel>
      </>
    );
  }

  if (!raw) {
    return (
      <>
        <div className="mb-3 text-sm font-bold text-accent-ink">SUPABASE</div>
        <PageHeader title={`Chi tiết giá · ${sku}`} sub="Không tìm thấy SKU" />
        <Panel title="Không tìm thấy">
          <p className="text-[13px] text-muted">SKU chưa có trong vexim_pricing.</p>
        </Panel>
      </>
    );
  }

  const r = mapPricingRow(raw);
  const boxTone = r.boxStatus === "holding" ? "green" : r.boxStatus === "at_risk" ? "amber" : r.boxStatus === "lost" ? "red" : "gray";
  const boxLabel = r.boxStatus === "holding" ? "Đang giữ box" : r.boxStatus === "at_risk" ? "Sắp mất" : r.boxStatus === "lost" ? "Mất box" : "Không offer";

  return (
    <>
      <div className="mb-3 text-sm font-bold text-accent-ink">SUPABASE · dữ liệu thật từ vexim_pricing</div>
      <PageHeader
        title={`Chi tiết giá · ${sku}`}
        sub={`${raw.asin ?? "—"} · ${raw.shop}`}
        desc="Lịch sử giá · offer đối thủ · breakdown giá sàn."
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <a href="/pricing" className="rounded-full border border-line bg-card px-4 py-1.5 text-[12.5px] font-bold text-muted transition hover:border-accent hover:text-accent-ink">
          ← Quay lại bảng giá
        </a>
      </div>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Giá mình", value: `$${r.ourPrice.toFixed(2)}`, sub: `cập nhật ${r.lastPriceChange}` },
          { label: "FOEP", value: r.foep ? `$${r.foep.toFixed(2)}` : "—", sub: "chưa có trong DB" },
          {
            label: "Giá sàn",
            value: usd(r.floorPrice),
            sub: r.floorPrice === null
              ? COST_BASIS_VI[r.costBasis]
              : `biên ${r.currentMargin === null ? "—" : `${r.currentMargin.toFixed(1)}%`}`,
          },
          { label: "Buy Box", value: boxLabel, sub: `${r.competitorCount} đối thủ` },
        ].map((k) => (
          <div key={k.label} className="rounded-[13px] border border-line bg-card px-4 py-3">
            <div className="text-[11.5px] font-bold uppercase text-soft">{k.label}</div>
            <div className="text-[22px] font-extrabold">{k.value}</div>
            <div className="text-[12px] text-soft">{k.sub}</div>
          </div>
        ))}
      </div>
      <Grid2>
        <Panel title="Lịch sử giá" hint="cần getPricing + ANY_OFFER_CHANGED">
          <p className="text-[13px] text-muted">
            Lịch sử giá 30 ngày chưa có trong DB — cần worker sync Pricing API.
          </p>
        </Panel>
        <Panel
          title="Breakdown giá sàn"
          hint={`catalog.effective_cost() + fees estimate · ${COST_BASIS_VI[r.costBasis]}`}
        >
          <table className={tableCls.table}>
            <tbody>
              <tr>
                <td className={tableCls.td}>
                  Giá vốn hiệu lực
                  <div className="text-[11px] text-soft">
                    {r.costEffectiveFrom ? `áp dụng từ ${r.costEffectiveFrom}` : "chưa nhập"}
                    {r.costCurrency ? ` · ${r.costCurrency}` : ""}
                    {r.costSource ? ` · nguồn ${r.costSource}` : ""}
                  </div>
                </td>
                <td className={tableCls.tdNum}>{usd(r.unitCost)}</td>
              </tr>
              <tr>
                <td className={tableCls.td}>FBA fulfillment fee</td>
                <td className={tableCls.tdNum}>{usd(raw.fba_fee)}</td>
              </tr>
              <tr>
                <td className={tableCls.td}>Phí khác / đơn vị</td>
                <td className={tableCls.tdNum}>{usd(r.otherFeePerUnit)}</td>
              </tr>
              <tr>
                <td className={tableCls.td}>
                  Referral fee
                  <div className="text-[11px] text-soft">
                    {raw.referral_fee !== null
                      ? "số thật từ fees estimate"
                      : `chưa có fees estimate → dùng tỷ lệ cấu hình ${pct(r.referralRateUsed, 0)}`}
                  </div>
                </td>
                <td className={tableCls.tdNum}>
                  {usd(raw.referral_fee)}
                  <div className="text-[11px] text-soft">{pct(r.referralRateUsed)}</div>
                </td>
              </tr>
              <tr>
                <td className={tableCls.td}>Biên tối thiểu (cấu hình)</td>
                <td className={tableCls.tdNum}>{pct(r.minMarginRate, 0)}</td>
              </tr>
              <tr className="border-t-2 border-line">
                <td className={`${tableCls.td} font-extrabold`}>
                  Giá sàn = (vốn + FBA + khác) / (1 − referral − biên)
                </td>
                <td className={`${tableCls.tdNum} font-extrabold text-accent-ink`}>{usd(r.floorPrice)}</td>
              </tr>
              <tr>
                <td className={tableCls.td}>Lãi gộp tại giá {usd(r.ourPrice)}</td>
                <td className={`${tableCls.tdNum} font-bold ${r.grossProfit !== null && r.grossProfit < 0 ? "text-red" : "text-green"}`}>
                  {usd(r.grossProfit)}
                  <div className="text-[11px] text-soft">
                    biên {r.currentMargin === null ? "—" : `${r.currentMargin.toFixed(1)}%`}
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          {r.floorPrice === null ? (
            <p className="mt-2 rounded-lg border border-amber bg-amber-soft px-3 py-2 text-[12px] font-semibold text-[#8a5602]">
              {COST_BASIS_HINT[r.costBasis]} →{" "}
              <a href="/finance/costs" className="underline underline-offset-2">nhập giá vốn tại đây</a>.
            </p>
          ) : (
            <p className="mt-2 text-[11.5px] text-soft">
              Giá áp thấp hơn giá sàn sẽ bị chặn ở bước duyệt (P3), trừ khi trưởng phòng override có lý do.
            </p>
          )}
        </Panel>
      </Grid2>
      <Panel title="Offers đối thủ" hint="cần getItemOffers + getListingOffersBatch">
        <p className="text-[13px] text-muted">
          Chi tiết offers đối thủ chưa có trong DB — cần worker sync Pricing API (getListingOffersBatch).
        </p>
      </Panel>
    </>
  );
}

function usd(v: number | null) {
  return v === null ? "—" : `$${v.toFixed(2)}`;
}

function pct(v: number | null, digits = 1) {
  return v === null ? "—" : `${(v * 100).toFixed(digits)}%`;
}

export default async function PricingDetailPage({
  searchParams,
}: {
  searchParams: Promise<{ sku?: string }>;
}) {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  const { sku } = await searchParams;

  // Supabase mode
  if (session.mode === "supabase") {
    return <LivePricingDetail sku={sku ?? ""} />;
  }

  const selSku = sku && pricingDetails[sku] ? sku : "XMO-950-BLK";
  const d = pricingDetails[selSku];
  const r = pricingRows.find((x) => x.sku === selSku);

  // data sparkline (normalize 0-100 theo max của khoảng)
  const allPrices = d.history.flatMap((h) => [h.myPrice, h.buyBoxPrice, h.lowestCompetitor]);
  const max = Math.max(...allPrices);
  const min = Math.min(...allPrices);
  const range = max - min || 1;
  const barData = d.history
    .slice(-30)
    .reverse()
    .map((h) => ({
      label: h.date.slice(0, 5),
      pct: Math.round(((h.myPrice - min) / range) * 80) + 15,
      today: h.date === d.history[0].date,
    }));

  return (
    <>
      <PageHeader
        title={`Chi tiết giá · ${d.sku}`}
        sub={`ASIN ${d.asin} · ${d.shop}`}
        desc="Lịch sử giá 30 ngày · danh sách offer đối thủ (getItemOffers + getListingOffersBatch) · breakdown giá sàn (getMyFeesEstimate)."
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <a href="/pricing" className="rounded-full border border-line bg-card px-4 py-1.5 text-[12.5px] font-bold text-muted transition hover:border-accent hover:text-accent-ink">
          ← Quay lại bảng giá
        </a>
        <a
          href={`/pricing/approve?sku=${d.sku}`}
          className="h-9 rounded-full bg-accent px-4 py-2 text-[12.5px] font-extrabold text-white transition hover:bg-accent-ink"
        >
          ✅ Đề xuất điều chỉnh giá
        </a>
      </div>

      {r ? (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-[13px] border border-line bg-card px-4 py-3">
            <div className="text-[11.5px] font-bold uppercase text-soft">Giá mình</div>
            <div className="text-[22px] font-extrabold">{usd(r.ourPrice)}</div>
            <div className="text-[12px] text-soft">cập nhật {r.lastPriceChange}</div>
          </div>
          <div className="rounded-[13px] border border-line bg-card px-4 py-3">
            <div className="text-[11.5px] font-bold uppercase text-soft">FOEP</div>
            <div className="text-[22px] font-extrabold">{r.foep ? usd(r.foep) : "—"}</div>
            <div className={`text-[12px] font-semibold ${r.foepDelta && r.foepDelta > 0 ? "text-red" : "text-green"}`}>
              {r.foepDelta && r.foepDelta > 0
                ? `cao hơn $${r.foepDelta.toFixed(2)}`
                : r.foepDelta === 0
                  ? "khớp FOEP"
                  : "chưa có"}
            </div>
          </div>
          <div className="rounded-[13px] border border-line bg-card px-4 py-3">
            <div className="text-[11.5px] font-bold uppercase text-soft">Giá sàn</div>
            <div className="text-[22px] font-extrabold">{usd(r.floorPrice)}</div>
            <div
              className={`text-[12px] font-semibold ${
                r.marginTone === "red" ? "text-red" : r.marginTone === "gray" ? "text-amber" : "text-green"
              }`}
            >
              {r.currentMargin === null
                ? `${COST_BASIS_VI[r.costBasis]} — nhập giá vốn để có sàn`
                : `biên ${r.currentMargin.toFixed(1)}%`}
            </div>
          </div>
          <div className="rounded-[13px] border border-line bg-card px-4 py-3">
            <div className="text-[11.5px] font-bold uppercase text-soft">Buy Box</div>
            <div className="mt-1">
              <Chip
                tone={
                  r.boxStatus === "holding"
                    ? "green"
                    : r.boxStatus === "at_risk"
                      ? "amber"
                      : r.boxStatus === "lost"
                        ? "red"
                        : "gray"
                }
              >
                {r.boxStatus === "holding"
                  ? "Đang giữ box"
                  : r.boxStatus === "at_risk"
                    ? "Sắp mất"
                    : r.boxStatus === "lost"
                      ? "Mất box"
                      : "Không offer"}
              </Chip>
            </div>
            <div className="mt-1 text-[12px] text-soft">{r.competitorCount} đối thủ</div>
          </div>
        </div>
      ) : null}

      <AlertList items={d.alerts} />

      <Grid2>
        <Panel title="Lịch sử giá 30 ngày" hint="cam = giá mình · xanh = giá giữ box · xanh nhạt = đối thủ thấp nhất">
          <Bars data={barData} />
          <div className="mt-3 flex flex-wrap gap-3 text-[11.5px] font-bold text-soft">
            <span><span className="inline-block h-2 w-4 rounded-sm bg-[#ffb84d]" /> Giá chúng tôi</span>
            <span><span className="inline-block h-2 w-4 rounded-sm bg-[#5ba578]" /> Giá Buy Box</span>
            <span><span className="inline-block h-2 w-4 rounded-sm bg-[#8fb3f0]" /> Thấp nhất đối thủ</span>
          </div>
          <p className="mt-2 text-[11.5px] text-soft">
            Nguồn: getPricing + getFeaturedOfferExpectedPriceBatch định kỳ mỗi giờ cho SKU trọng yếu; ANY_OFFER_CHANGED push realtime.
          </p>
        </Panel>

        <Panel title="Breakdown giá sàn" hint="từ getMyFeesEstimateForSKU (Product Fees API v0)">
          <table className={tableCls.table}>
            <tbody>
              <tr>
                <td className={tableCls.td}>Giá vốn (COGS)</td>
                <td className={tableCls.tdNum}>{usd(d.fees.cogs)}</td>
              </tr>
              <tr>
                <td className={tableCls.td}>Referral fee ({d.fees.referralFeeRate}%)</td>
                <td className={tableCls.tdNum}>−{usd(d.fees.referralFeeAmount)}</td>
              </tr>
              <tr>
                <td className={tableCls.td}>FBA fulfillment fee</td>
                <td className={tableCls.tdNum}>−{usd(d.fees.fbaFee)}</td>
              </tr>
              <tr>
                <td className={tableCls.td}>Phí khác (closing / storage…)</td>
                <td className={tableCls.tdNum}>−{usd(d.fees.otherFees)}</td>
              </tr>
              <tr>
                <td className={tableCls.td}>Biên tối thiểu ({d.fees.minMarginRate}%)</td>
                <td className={tableCls.tdNum}>{usd(d.fees.minMarginAmount)}</td>
              </tr>
              <tr className="border-t-2 border-line">
                <td className={`${tableCls.td} font-extrabold`}>Giá sàn (floor)</td>
                <td className={`${tableCls.tdNum} font-extrabold text-accent-ink`}>{usd(d.fees.floorPrice)}</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-[11.5px] text-soft">
            Giá áp thấp hơn giá sàn sẽ bị chặn bởi quy trình duyệt (trừ khi trưởng phòng override có lý do).
          </p>
        </Panel>
      </Grid2>

      <Panel title={`Offers hiện tại trên trang chi tiết (${d.offers.length} sellers)`} hint="getItemOffers + getListingOffersBatch · sắp xếp theo giá landed (giá + ship)">
        <table className={tableCls.table}>
          <thead>
            <tr>
              <th className={tableCls.th}>Seller</th>
              <th className={tableCls.th}>Fulfillment</th>
              <th className={tableCls.th}>Tình trạng</th>
              <th className={`${tableCls.th} text-right`}>Giá</th>
              <th className={`${tableCls.th} text-right`}>Ship</th>
              <th className={`${tableCls.th} text-right`}>Landed</th>
              <th className={tableCls.th}>Rating</th>
              <th className={tableCls.th}>Featured?</th>
            </tr>
          </thead>
          <tbody>
            {[...d.offers]
              .sort((a, b) => a.landedPrice - b.landedPrice)
              .map((o) => (
                <tr key={o.sellerId} className={o.isMe ? "bg-accent-soft/40" : ""}>
                  <td className={tableCls.td}>
                    <span className={o.isMe ? "font-extrabold text-accent-ink" : "font-semibold"}>
                      {o.sellerLabel}
                    </span>
                    {o.isMe ? <span className="ml-1 text-[10.5px] font-bold text-accent-ink">(chúng tôi)</span> : null}
                  </td>
                  <td className={tableCls.td}>
                    <Chip tone={o.fulfillment === "FBA" || o.fulfillment === "AMZ" ? "green" : "gray"}>
                      {o.fulfillment}
                    </Chip>
                  </td>
                  <td className={tableCls.td}>{o.condition}</td>
                  <td className={tableCls.tdNum}>{usd(o.price)}</td>
                  <td className={tableCls.tdNum}>{o.shipping ? usd(o.shipping) : "miễn phí"}</td>
                  <td className={`${tableCls.tdNum} font-bold`}>{usd(o.landedPrice)}</td>
                  <td className={tableCls.td}>
                    {o.rating ? (
                      <>
                        {o.rating}★ <span className="text-[11px] text-soft">({o.feedbackCount?.toLocaleString()})</span>
                      </>
                    ) : (
                      <span className="text-soft">—</span>
                    )}
                  </td>
                  <td className={tableCls.td}>
                    {o.isFeatured ? <Chip tone="amber">🏆 Buy Box</Chip> : <span className="text-soft">—</span>}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </Panel>

      <p className="mt-3 text-[11.5px] font-semibold text-soft">
        Landed price = giá + shipping (FBA/AMZ thường miễn ship prime). Buy Box ưu tiên FBA + giá landed thấp nhất +
        tài khoản khỏe (Seller Feedback, ODR, Late Shipment Rate,…) — FOEP là giá Amazon ước tính cần có để vào box.
      </p>
    </>
  );
}
