/**
 * LivePricing — server component đọc Supabase cho Module 2 (P1/P2/P3).
 */
import {
  AlertList,
  Chip,
  Grid2,
  KpiCard,
  KpiGrid,
  PageHeader,
  Panel,
  tableCls,
} from "@/components/ui";
import { readPricing } from "@/lib/data/pricing";
import {
  COST_BASIS_HINT,
  COST_BASIS_VI,
  computePricingKpis,
  isCostBlocked,
  mapPricingRow,
  type PricingRaw,
} from "@/lib/data/pricing-model";
import type { BoxStatus, PricingRow } from "@/lib/types";

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

/**
 * Ô GIÁ SÀN: thiếu giá vốn thì hiện "—" KÈM lý do + chỗ nhập.
 * (Bản 0013 hiện tổng phí làm "giá sàn" → người dùng tưởng lãi, nên phải chặn hiển thị sai.)
 */
function FloorCell({ r }: { r: PricingRow }) {
  if (r.floorPrice === null) {
    return (
      <span className="text-soft" title={COST_BASIS_HINT[r.costBasis]}>
        —<span className="block text-[10.5px] font-bold text-amber">{COST_BASIS_VI[r.costBasis]}</span>
      </span>
    );
  }
  return (
    <>
      {usd(r.floorPrice)}
      {r.belowFloor === true ? (
        <div className="text-[11px] font-bold text-red">dưới sàn!</div>
      ) : r.costBasis === "cost_only" ? (
        <div className="text-[10.5px] text-soft" title={COST_BASIS_HINT.cost_only}>phí cấu hình</div>
      ) : null}
    </>
  );
}

function MarginCell({ r }: { r: PricingRow }) {
  if (r.currentMargin === null) return <span className="text-soft">—</span>;
  return <span className={marginCls(r.currentMargin, r.marginTone)}>{r.currentMargin.toFixed(1)}%</span>;
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

function chipHref(base: Record<string, string | undefined>, key: string, value: string) {
  const params = new URLSearchParams();
  const merged = { ...base, [key]: value === "all" ? undefined : value };
  for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v);
  const qs = params.toString();
  return `/pricing${qs ? `?${qs}` : ""}`;
}

/* ================================================================== */
/* P1 — Bảng giá & Buy Box                                            */
/* ================================================================== */

export async function LivePricingPage({
  filters,
}: {
  filters: {
    f: string;
    shop: string;
    margin: string;
    q: string;
    sort: string;
  };
}) {
  let rawRows: PricingRaw[] = [];
  let failed = false;

  try {
    rawRows = await readPricing();
  } catch {
    failed = true;
  }

  const allRows = rawRows.map(mapPricingRow);
  const kpis = computePricingKpis(allRows);

  // Filter
  let rows = allRows.filter((r) => {
    if (filters.f !== "all" && r.boxStatus !== filters.f) return false;
    if (filters.shop !== "all" && r.shop !== filters.shop) return false;
    if (filters.margin === "below_floor" && r.belowFloor !== true) return false;
    if (filters.margin === "thin" && !(r.currentMargin !== null && r.currentMargin < 15 && r.marginTone !== "red")) return false;
    if (filters.margin === "no_cost" && !isCostBlocked(r)) return false;
    if (filters.q) {
      const hay = `${r.sku} ${r.asin} ${r.title}`.toLowerCase();
      if (!hay.includes(filters.q)) return false;
    }
    return true;
  });

  rows = [...rows].sort((a, b) => {
    switch (filters.sort) {
      // SKU chưa tính được biên xếp CUỐI (không được chen lên đầu như thể biên thấp nhất)
      case "margin": return (a.currentMargin ?? Number.POSITIVE_INFINITY) - (b.currentMargin ?? Number.POSITIVE_INFINITY);
      case "sku": return a.sku.localeCompare(b.sku);
      case "velocity": return b.velocity30d - a.velocity30d;
      case "risk":
      default: {
        const score = (r: PricingRow) => {
          let s = 0;
          if (r.boxStatus === "lost") s += 100;
          if (r.boxStatus === "at_risk") s += 50;
          if (r.belowFloor === true) s += 80;
          if (isCostBlocked(r)) s += 30; // thiếu giá vốn = không quyết định được giá → cần soi
          s += r.velocity30d / 10;
          return s;
        };
        return score(b) - score(a);
      }
    }
  });

  const shops = [...new Set(allRows.map((r) => r.shop))];
  const noCostCount = allRows.filter(isCostBlocked).length;
  const chip = (active: boolean) =>
    `rounded-full border px-3.5 py-1.5 text-[12.5px] font-bold transition ${
      active
        ? "border-accent bg-accent-soft text-accent-ink"
        : "border-line bg-card text-muted hover:border-accent"
    }`;

  const sp: Record<string, string | undefined> = {
    f: filters.f !== "all" ? filters.f : undefined,
    shop: filters.shop !== "all" ? filters.shop : undefined,
    margin: filters.margin !== "all" ? filters.margin : undefined,
    q: filters.q || undefined,
    sort: filters.sort !== "risk" ? filters.sort : undefined,
  };

  return (
    <>
      <div className="mb-3 text-sm font-bold text-accent-ink">
        SUPABASE · dữ liệu thật từ vexim_pricing
      </div>
      <PageHeader
        title="Giá & Featured Offer (Buy Box)"
        sub={`${allRows.length} SKU · cập nhật từ Supabase`}
        desc="Nguồn: Product Pricing API v0 (getPricing, getCompetitiveSummary), getFeaturedOfferExpectedPriceBatch, Product Fees API (giá sàn), ANY_OFFER_CHANGED + PRICE_HEALTH realtime."
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

      {failed ? (
        <Panel title="Không tải được dữ liệu">
          <p role="alert">Không thể đọc Supabase. Kiểm tra migration 0013, quyền SELECT, RLS.</p>
        </Panel>
      ) : (
        <>
          <KpiGrid>
            {kpis.map((k) => (
              <KpiCard key={k.label} {...k} />
            ))}
          </KpiGrid>

          <Grid2>
            <Panel title="Cảnh báo giá" hint="từ ANY_OFFER_CHANGED + PRICE_HEALTH">
              <AlertList items={[
                ...(noCostCount > 0
                  ? [{
                      tone: "amber" as const,
                      text: `${noCostCount} SKU chưa có giá vốn dùng được → không tính được giá sàn/biên. Nhập tại /finance/costs (F3/F4/P1 cùng dùng nguồn này).`,
                    }]
                  : []),
                ...(allRows.some((r) => r.costBasis === "currency_mismatch")
                  ? [{
                      tone: "red" as const,
                      text: `${allRows.filter((r) => r.costBasis === "currency_mismatch").length} SKU có giá vốn LỆCH TIỀN TỆ với giá bán — không cộng được, cần nhập lại đúng tiền tệ.`,
                    }]
                  : []),
                { tone: "amber" as const, text: "Dữ liệu FOEP/velocity chưa có trong DB — hiển thị khi worker sync Pricing API" },
                { tone: "green" as const, text: `${allRows.filter(r => r.boxStatus === "holding").length} SKU đang giữ Buy Box` },
              ]} />
            </Panel>
            <Panel title="Luồng áp giá" hint="P3">
              <div className="flex flex-col gap-2 text-[13px]">
                {[
                  { step: "1", label: "Đề xuất (auto hoặc operator)", sub: "≤2% operator tự duyệt" },
                  { step: "2", label: "Kiểm tra giá sàn (biên tối thiểu)", sub: "chặn dưới sàn", subTone: "red" },
                  { step: "3", label: "Duyệt (trưởng phòng nếu >2%)", sub: "ghi audit + rollback được" },
                  { step: "4", label: "Áp giá qua patchListingsItem / FEED", sub: "≤1 SKU PATCH · >100 FEED" },
                ].map((s) => (
                  <div key={s.step} className="flex items-center gap-2.5 rounded-[10px] border border-line px-3 py-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-soft text-[11px] font-extrabold text-blue">{s.step}</span>
                    <div className="font-semibold">{s.label}</div>
                    <span className={`ml-auto text-[12px] ${s.subTone === "red" ? "text-red font-bold" : "text-soft"}`}>{s.sub}</span>
                  </div>
                ))}
              </div>
            </Panel>
          </Grid2>

          {/* Tìm kiếm */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <form action="/pricing" method="get" className="flex flex-1 items-center gap-2">
              {(["f", "shop", "margin", "sort"] as const).map((k) =>
                sp[k] ? <input key={k} type="hidden" name={k} value={sp[k]} /> : null,
              )}
              <input
                name="q"
                defaultValue={filters.q}
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

          {/* Filter box status */}
          <div className="mb-2 flex flex-wrap gap-2">
            {([
              ["all", "Tất cả", allRows.length],
              ["holding", "Đang giữ box", allRows.filter((r) => r.boxStatus === "holding").length],
              ["at_risk", "Sắp mất", allRows.filter((r) => r.boxStatus === "at_risk").length],
              ["lost", "Mất box", allRows.filter((r) => r.boxStatus === "lost").length],
              ["no_box", "Không offer", allRows.filter((r) => r.boxStatus === "no_box").length],
            ] as [string, string, number][]).map(([key, label, count]) => (
              <a key={key} href={chipHref(sp, "f", key)} className={chip(filters.f === key)}>
                {label} · {count}
              </a>
            ))}
          </div>
          <div className="mb-2 flex flex-wrap gap-2">
            {[[ "all", "Mọi shop"], ...shops.map((s) => [s, `Shop ${s}`] as [string, string])].map(([key, label]) => (
              <a key={key} href={chipHref(sp, "shop", key)} className={chip(filters.shop === key)}>
                {label}
              </a>
            ))}
            <span className="mx-1 w-px self-stretch bg-line" />
            {([
              ["all", "Mọi biên"],
              ["below_floor", "Dưới giá sàn"],
              ["thin", "Biên mỏng (<15%)"],
              ["no_cost", `Chưa có giá vốn${noCostCount ? ` · ${noCostCount}` : ""}`],
            ] as [string, string][]).map(([key, label]) => (
              <a key={key} href={chipHref(sp, "margin", key)} className={chip(filters.margin === key)}>
                {label}
              </a>
            ))}
          </div>
          <div className="mb-4 flex items-center gap-2 text-[12px] font-bold text-soft">
            Xếp theo:
            {([
              ["risk", "Rủi ro mất box"],
              ["margin", "Biên thấp nhất"],
              ["velocity", "Velocity cao"],
              ["sku", "SKU A→Z"],
            ] as [string, string][]).map(([key, label]) => (
              <a
                key={key}
                href={chipHref(sp, "sort", key)}
                className={filters.sort === key ? "text-accent-ink" : "text-muted hover:text-accent-ink"}
              >
                {label}
              </a>
            ))}
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
                      <FloorCell r={r} />
                    </td>
                    <td className={tableCls.tdNum}>
                      <MarginCell r={r} />
                    </td>
                    <td className={tableCls.tdNum}>
                      {r.competitorCount}
                      {r.velocity30d ? <div className="text-[11px] text-soft">~{r.velocity30d}đ/ngày</div> : null}
                    </td>
                    <td className={tableCls.td}>{r.owner}</td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={10} className={`${tableCls.td} text-center text-soft`}>
                      Không có SKU nào khớp bộ lọc.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </Panel>
          <Panel title="Phạm vi bản đọc" hint={`giá vốn: ${allRows.length - noCostCount}/${allRows.length} SKU`}>
            <p className="text-[13px] text-muted">
              <span className="font-bold text-[#0b7a55]">Đã có (migration 0016):</span> giá vốn hiệu lực theo
              ngày từ <code>catalog.cost_inputs</code> → giá sàn = (vốn + FBA + phí khác) / (1 − referral − biên
              tối thiểu), lãi gộp, % biên, cờ dưới sàn. SKU chưa nhập giá vốn hiện <b>—</b> kèm nhãn lý do
              (nhập tại <a href="/finance/costs" className="font-bold text-blue underline underline-offset-2">Giá vốn</a>).
            </p>
            <p className="mt-1.5 text-[13px] text-muted">
              <span className="font-bold text-amber">Chưa có:</span> FOEP
              (getFeaturedOfferExpectedPriceBatch), velocity30d (Orders join), số đối thủ — hiển thị khi worker
              sync Pricing API.
            </p>
          </Panel>
        </>
      )}
    </>
  );
}

/* ================================================================== */
/* P3 — Hàng chờ duyệt giá                                            */
/* ================================================================== */

export async function LivePriceApprovals() {
  let rawRows: PricingRaw[] = [];
  let failed = false;

  try {
    rawRows = await readPricing();
  } catch {
    failed = true;
  }

  // Lọc SKU có vấn đề (mất box, biên âm, at_risk)
  const allRows = rawRows.map(mapPricingRow);
  const pending = allRows.filter(
    (r) => r.boxStatus === "lost" || r.boxStatus === "at_risk" || r.belowFloor === true || isCostBlocked(r),
  );

  return (
    <>
      <div className="mb-3 text-sm font-bold text-accent-ink">
        SUPABASE · dữ liệu thật từ vexim_pricing
      </div>
      <PageHeader
        title="Duyệt & áp giá — SOP-02"
        sub={`${pending.length} SKU cần xử lý`}
        desc="Đề xuất: ≤2% operator tự duyệt · >2% trưởng phòng duyệt · dưới giá sàn: chặn."
      />
      {failed ? (
        <Panel title="Không tải được dữ liệu">
          <p role="alert">Không thể đọc Supabase.</p>
        </Panel>
      ) : pending.length === 0 ? (
        <Panel title="Không có đề xuất">
          <p className="text-[13px] text-muted">
            Không có SKU nào cần xử lý giá trong DB.
          </p>
        </Panel>
      ) : (
        <Panel title="SKU cần xử lý" hint="mất box / biên âm / sắp mất">
          <table className={tableCls.table}>
            <thead>
              <tr>
                <th className={tableCls.th}>SKU</th>
                <th className={tableCls.th}>Shop</th>
                <th className={tableCls.th}>Trạng thái box</th>
                <th className={`${tableCls.th} text-right`}>Giá hiện tại</th>
                <th className={`${tableCls.th} text-right`}>Biên</th>
                <th className={tableCls.th}>Vấn đề</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((r) => (
                <tr key={r.sku}>
                  <td className={tableCls.td}>
                    <a href={`/pricing/detail?sku=${r.sku}`} className="font-bold text-blue underline underline-offset-2">
                      {r.sku}
                    </a>
                  </td>
                  <td className={tableCls.td}>{r.shop}</td>
                  <td className={tableCls.td}>
                    <Chip tone={boxTone[r.boxStatus]}>{boxLabel[r.boxStatus]}</Chip>
                  </td>
                  <td className={tableCls.tdNum}>{usd(r.ourPrice)}</td>
                  <td className={tableCls.tdNum}>
                    <MarginCell r={r} />
                  </td>
                  <td className={tableCls.td}>
                    {r.belowFloor === true ? (
                      <span className="font-bold text-red">Biên âm — dưới giá sàn</span>
                    ) : isCostBlocked(r) ? (
                      <span className="font-bold text-amber" title={COST_BASIS_HINT[r.costBasis]}>
                        {COST_BASIS_VI[r.costBasis]} — nhập ở /finance/costs
                      </span>
                    ) : r.boxStatus === "lost" ? (
                      <span className="font-bold text-red">Mất box</span>
                    ) : (
                      <span className="font-bold text-amber">Sắp mất box</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
      <Panel title="Thao tác ghi — bị khóa Đợt 1">
        <p className="text-[13px] text-muted">
          Nút "Áp giá" kích hoạt khi có patchListingsItem (Đợt 2). Mọi thao tác ghi đi qua duyệt + audit log.
        </p>
      </Panel>
    </>
  );
}
