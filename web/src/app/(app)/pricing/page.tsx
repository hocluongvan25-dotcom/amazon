import {
  AlertList,
  Chip,
  Grid2,
  KpiCard,
  KpiGrid,
  NoAccess,
  PageHeader,
  Panel,
  tableCls,
} from "@/components/ui";
import { LivePricingPage } from "@/components/pricing/LivePricing";
import { requireSession } from "@/lib/auth/session";
import { pricingAlerts, pricingKpis, pricingRows } from "@/lib/data/mock";
import {
  COST_BASIS_VI,
  formatRevenue30d,
  formatSales30d,
  formatVelocity30d,
  isCostBlocked,
  velocitySortValue,
} from "@/lib/data/pricing-model";
import type { PersonaKey } from "@/lib/roles";
import type { BoxStatus, PricingRow } from "@/lib/types";

const ALLOWED: PersonaKey[] = ["ceo"];

const boxTone: Record<BoxStatus, "green" | "amber" | "red" | "gray"> = {
  holding: "green",
  at_risk: "amber",
  lost: "red",
  no_box: "gray",
};
const boxLabel: Record<BoxStatus, string> = {
  holding: "Đang giữ box",
  at_risk: "Sắp mất",
  lost: "Mất box",
  no_box: "Không có offer",
};

function usd(v: number | null) {
  if (v === null) return "—";
  return `$${v.toFixed(2)}`;
}
function marginCls(m: number, tone: "red" | "amber" | "green" | "gray") {
  return tone === "red"
    ? "font-extrabold text-red"
    : tone === "amber"
      ? "font-bold text-amber"
      : tone === "gray"
        ? "text-soft"
        : "text-green font-semibold";
}
/** Ô giá sàn: chưa có giá vốn → "—" kèm lý do (không lấy phí làm sàn). */
function floorCell(r: PricingRow) {
  if (r.floorPrice === null) {
    return `— · ${COST_BASIS_VI[r.costBasis]}`;
  }
  return usd(r.floorPrice);
}
function marginCell(r: PricingRow) {
  return r.currentMargin === null ? "—" : `${r.currentMargin.toFixed(1)}%`;
}

function chipHref(base: Record<string, string | undefined>, key: string, value: string) {
  const params = new URLSearchParams();
  const merged = { ...base, [key]: value === "all" ? undefined : value };
  for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v);
  const qs = params.toString();
  return `/pricing${qs ? `?${qs}` : ""}`;
}

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ f?: string; shop?: string; margin?: string; q?: string; sort?: string }>;
}) {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  const sp = await searchParams;
  const filters = {
    f: sp.f ?? "all",
    shop: sp.shop ?? "all",
    margin: sp.margin ?? "all",
    q: (sp.q ?? "").trim().toLowerCase(),
    sort: (sp.sort ?? "risk") as "risk" | "margin" | "sku" | "velocity",
  };

  // Supabase mode
  if (session.mode === "supabase") {
    return <LivePricingPage filters={filters} />;
  }

  const state = filters;

  let rows = pricingRows.filter((r) => {
    if (state.f !== "all" && r.boxStatus !== state.f) return false;
    if (state.shop !== "all" && r.shop !== state.shop) return false;
    if (state.margin === "below_floor" && r.belowFloor !== true) return false;
    if (state.margin === "thin" && !(r.currentMargin !== null && r.currentMargin < 15 && r.marginTone !== "red")) return false;
    if (state.margin === "no_cost" && !isCostBlocked(r)) return false;
    if (state.q) {
      const hay = `${r.sku} ${r.asin} ${r.title}`.toLowerCase();
      if (!hay.includes(state.q)) return false;
    }
    return true;
  });
  rows = [...rows].sort((a, b) => {
    switch (state.sort) {
      case "margin":
        // SKU chưa tính được biên xếp cuối — không chen lên đầu như thể biên thấp nhất
        return (a.currentMargin ?? Number.POSITIVE_INFINITY) - (b.currentMargin ?? Number.POSITIVE_INFINITY);
      case "sku":
        return a.sku.localeCompare(b.sku);
      case "velocity":
        // SKU CHƯA CÓ ĐƠN (velocity NULL) xếp cuối — không chen lên đầu như thể bán kém nhất
        return velocitySortValue(b) - velocitySortValue(a);
      case "risk":
      default: {
        // th tự tự: đỏ (mất box + dưới sàn) → at_risk + thấp biên → holding
        const score = (r: typeof rows[number]) => {
          let s = 0;
          if (r.boxStatus === "lost") s += 100;
          if (r.boxStatus === "at_risk") s += 50;
          if (r.belowFloor === true) s += 80;
          if (isCostBlocked(r)) s += 30;
          if (r.foepDelta && r.foepDelta > 2) s += 20;
          s += (r.velocity30d ?? 0) / 10; // chưa có đơn = không cộng điểm urgency
          return s;
        };
        return score(b) - score(a);
      }
    }
  });

  const shops = [...new Set(pricingRows.map((r) => r.shop))];
  const chip = (active: boolean) =>
    `rounded-full border px-3.5 py-1.5 text-[12.5px] font-bold transition ${
      active
        ? "border-accent bg-accent-soft text-accent-ink"
        : "border-line bg-card text-muted hover:border-accent"
    }`;

  return (
    <>
      <PageHeader
        title="Giá & Featured Offer (Buy Box)"
        sub={`${pricingRows.length} SKU · 14 shop · cập nhật 12 phút trước`}
        desc="Nguồn: Product Pricing API v0 (getPricing, getCompetitiveSummary), getFeaturedOfferExpectedPriceBatch 2022-05-01 (FOEP), Product Fees API (giá sàn), ANY_OFFER_CHANGED + PRICE_HEALTH realtime. Hành động ghi giá dùng patchListingsItem / JSON_LISTINGS_FEED."
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {[
          ["/pricing", "💲 Bảng giá & Buy Box (P1)"],
          ["/pricing/approve", "✅ Duyệt & áp giá (P3)"],
        ].map(([href, label]) => (
          <a
            key={href}
            href={href}
            className="rounded-full border border-line bg-card px-4 py-1.5 text-[12.5px] font-bold text-muted transition hover:border-accent hover:bg-accent-soft hover:text-accent-ink"
          >
            {label}
          </a>
        ))}
        <span
          title="P4 (quy tắc tự động) thuộc Đợt 3 — đang khóa"
          className="cursor-not-allowed rounded-full border border-dashed border-line px-4 py-1.5 text-[12.5px] font-bold text-soft"
        >
          ⚙️ Quy tắc tự động (P4 · Đợt 3)
        </span>
      </div>

      <KpiGrid>
        {pricingKpis.map((k) => (
          <KpiCard key={k.label} {...k} />
        ))}
      </KpiGrid>

      <Grid2>
        <Panel title="Cảnh báo giá hôm nay" hint="từ ANY_OFFER_CHANGED + PRICE_HEALTH">
          <AlertList items={pricingAlerts} />
        </Panel>
        <Panel title="Luồng áp giá" hint="P3">
          <div className="flex flex-col gap-2 text-[13px]">
            <div className="flex items-center gap-2.5 rounded-[10px] border border-line px-3 py-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-soft text-[11px] font-extrabold text-blue">1</span>
              <div className="font-semibold">Đề xuất (auto hoặc operator)</div>
              <span className="ml-auto text-[12px] text-soft">≤2% operator tự duyệt</span>
            </div>
            <div className="flex items-center gap-2.5 rounded-[10px] border border-line px-3 py-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-amber-soft text-[11px] font-extrabold text-amber">2</span>
              <div className="font-semibold">Kiểm tra giá sàn (biên tối thiểu)</div>
              <span className="ml-auto text-[12px] text-red font-bold">chặn dưới sàn</span>
            </div>
            <div className="flex items-center gap-2.5 rounded-[10px] border border-line px-3 py-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-amber-soft text-[11px] font-extrabold text-amber">3</span>
              <div className="font-semibold">Duyệt (trưởng phòng nếu {">"}2%)</div>
              <span className="ml-auto text-[12px] text-soft">ghi audit + rollback được</span>
            </div>
            <div className="flex items-center gap-2.5 rounded-[10px] border border-line px-3 py-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-green-soft text-[11px] font-extrabold text-green">4</span>
              <div className="font-semibold">Áp giá qua patchListingsItem / FEED</div>
              <span className="ml-auto text-[12px] text-soft">≤1 SKU PATCH · {">"}100 FEED</span>
            </div>
          </div>
        </Panel>
      </Grid2>

      {/* Tìm kiếm */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <form action="/pricing" method="get" className="flex flex-1 items-center gap-2">
          {(["f", "shop", "margin", "sort"] as const).map((k) =>
            state[k] !== "all" && k !== "sort" ? <input key={k} type="hidden" name={k} value={state[k]} /> : null,
          )}
          {state.sort !== "risk" ? <input type="hidden" name="sort" value={state.sort} /> : null}
          <input
            name="q"
            defaultValue={sp.q ?? ""}
            placeholder="Tìm SKU / ASIN / tiêu đề…"
            className="h-9 w-full max-w-xs rounded-full border border-line bg-card px-4 text-[13px] font-semibold outline-none placeholder:text-soft focus:border-accent"
          />
          <button
            type="submit"
            className="h-9 rounded-full border border-line bg-card px-4 text-[12.5px] font-bold text-muted transition hover:border-accent hover:text-accent-ink"
          >
            Tìm
          </button>
        </form>
        <a
          href="/pricing/approve"
          className="h-9 rounded-full bg-accent px-4 py-2 text-[12.5px] font-extrabold text-white transition hover:bg-accent-ink"
        >
          ✅ Vào hàng chờ duyệt →
        </a>
      </div>

      {/* Filter trạng thái box */}
      <div className="mb-2 flex flex-wrap gap-2">
        {([
          ["all", "Tất cả", pricingRows.length],
          ["holding", "Đang giữ box", pricingRows.filter((r) => r.boxStatus === "holding").length],
          ["at_risk", "Sắp mất", pricingRows.filter((r) => r.boxStatus === "at_risk").length],
          ["lost", "Mất box", pricingRows.filter((r) => r.boxStatus === "lost").length],
          ["no_box", "Không offer", pricingRows.filter((r) => r.boxStatus === "no_box").length],
        ] as [string, string, number][]).map(([key, label, count]) => (
          <a key={key} href={chipHref({ ...sp, q: sp.q }, "f", key)} className={chip(state.f === key)}>
            {label} · {count}
          </a>
        ))}
      </div>
      <div className="mb-2 flex flex-wrap gap-2">
        {[["all", "Mọi shop"], ...shops.map((s) => [s, `Shop ${s}`] as [string, string])].map(([key, label]) => (
          <a key={key} href={chipHref({ ...sp, q: sp.q }, "shop", key)} className={chip(state.shop === key)}>
            {label}
          </a>
        ))}
        <span className="mx-1 w-px self-stretch bg-line" />
        {([
          ["all", "Mọi biên"],
          ["below_floor", "Dưới giá sàn"],
          ["thin", "Biên mỏng (<15%)"],
          ["no_cost", `Chưa có giá vốn · ${pricingRows.filter(isCostBlocked).length}`],
        ] as [string, string][]).map(([key, label]) => (
          <a key={key} href={chipHref({ ...sp, q: sp.q }, "margin", key)} className={chip(state.margin === key)}>
            {label}
          </a>
        ))}
      </div>
      <div className="mb-4 flex items-center gap-2 text-[12px] font-bold text-soft">
        Xếp theo:
        <a
          href={chipHref({ ...sp, q: sp.q }, "sort", "risk")}
          className={state.sort === "risk" ? "text-accent-ink" : "text-muted hover:text-accent-ink"}
        >
          Rủi ro mất box
        </a>{" "}
        ·
        <a
          href={chipHref({ ...sp, q: sp.q }, "sort", "margin")}
          className={state.sort === "margin" ? "text-accent-ink" : "text-muted hover:text-accent-ink"}
        >
          Biên thấp nhất
        </a>{" "}
        ·
        <a
          href={chipHref({ ...sp, q: sp.q }, "sort", "velocity")}
          className={state.sort === "velocity" ? "text-accent-ink" : "text-muted hover:text-accent-ink"}
        >
          Velocity cao
        </a>{" "}
        ·
        <a
          href={chipHref({ ...sp, q: sp.q }, "sort", "sku")}
          className={state.sort === "sku" ? "text-accent-ink" : "text-muted hover:text-accent-ink"}
        >
          SKU A→Z
        </a>
      </div>

      <Panel title={`${rows.length} SKU`} hint="click SKU để xem chi tiết giá / đối thủ / giá sàn">
        <table className={tableCls.table}>
          <thead>
            <tr>
              <th className={tableCls.th}>SKU / Tiêu đề</th>
              <th className={tableCls.th}>Shop</th>
              <th className={tableCls.th}>Buy Box</th>
              <th className={`${tableCls.th} text-right`}>Giá mình</th>
              <th className={`${tableCls.th} text-right`}>FOEP</th>
              <th className={`${tableCls.th} text-right`}>Thấp nhất</th>
              <th className={`${tableCls.th} text-right`}>Giá sàn</th>
              <th className={`${tableCls.th} text-right`}>Biên</th>
              <th className={`${tableCls.th} text-right`}>Bán 30 ngày</th>
              <th className={`${tableCls.th} text-right`}>Đối thủ</th>
              <th className={tableCls.th}>Phụ trách</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.sku}>
                <td className={tableCls.td}>
                  <a href={`/pricing/detail?sku=${r.sku}`} className="font-bold text-blue underline underline-offset-2">
                    {r.sku}
                  </a>
                  <div className="max-w-[260px] truncate text-[11.5px] text-soft">{r.title}</div>
                </td>
                <td className={tableCls.td}>{r.shop}</td>
                <td className={tableCls.td}>
                  <Chip tone={boxTone[r.boxStatus]}>{boxLabel[r.boxStatus]}</Chip>
                </td>
                <td className={tableCls.tdNum}>{usd(r.ourPrice)}</td>
                <td className={tableCls.tdNum}>
                  {r.foep === null ? (
                    <span className="text-soft">—</span>
                  ) : (
                    <>
                      {usd(r.foep)}
                      {r.foepDelta !== null && r.foepDelta > 0 ? (
                        <div className="text-[11px] font-bold text-red">+${r.foepDelta.toFixed(2)}</div>
                      ) : r.foepDelta === 0 ? (
                        <div className="text-[11px] text-green">khớp</div>
                      ) : null}
                    </>
                  )}
                </td>
                <td className={tableCls.tdNum}>
                  {r.referencePrice === null ? <span className="text-soft">—</span> : usd(r.referencePrice)}
                </td>
                <td className={tableCls.tdNum}>
                  {floorCell(r)}
                  {r.belowFloor === true ? (
                    <div className="text-[11px] font-bold text-red">dưới sàn!</div>
                  ) : null}
                </td>
                <td className={`${tableCls.tdNum} ${marginCls(r.currentMargin ?? 0, r.marginTone)}`}>
                  {marginCell(r)}
                </td>
                <td className={tableCls.tdNum}>
                  <div className="font-bold">{formatSales30d(r)}</div>
                  <div className="text-[11px] text-soft">{formatVelocity30d(r.velocity30d)}</div>
                  <div className="text-[11px] font-semibold text-muted">
                    {formatRevenue30d(r.revenue30d, r.revenueCurrency)}
                  </div>
                </td>
                <td className={tableCls.tdNum}>{r.competitorCount}</td>
                <td className={tableCls.td}>
                  {r.owner === "—" ? (
                    <span className="text-soft" title="Chưa gán ai phụ trách module pricing">— chưa gán</span>
                  ) : (
                    <span className="font-semibold">{r.owner}</span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={11} className={`${tableCls.td} text-center text-soft`}>
                  Không có SKU nào khớp bộ lọc.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
      <p className="mt-3 text-[11.5px] font-semibold text-soft">
        FOEP = Featured Offer Expected Price (getFeaturedOfferExpectedPriceBatch 2022-05-01, batch tối đa 40 SKU,
        gọi mỗi giờ cho nhóm SKU trọng yếu). Giá sàn = giá vốn + referral fee (15%) + FBA fulfillment fee + biên
        tối thiểu (mặc định 10%, cấu hình theo shop/SKU). Chênh lệch &gt;2% giá cần trưởng phòng duyệt.
      </p>
    </>
  );
}
