"use client";

/**
 * Bảng lợi nhuận SKU (F4) — gộp theo SKU trong kỳ, sắp để lộ SKU lỗ trước.
 *
 * Số liệu đọc thẳng từ vexim_sku_profit (worker tính bằng dòng tiền settlement
 * đã quyết toán + giá vốn VEXIM). Thiếu giá vốn → cột lãi gộp để "—".
 */

import { useMemo, useState } from "react";
import { Chip, KpiCard, KpiGrid, Panel, tableCls } from "@/components/ui";
import {
  aggregateProfit,
  FEE_SOURCE_VI,
  money,
  percent,
  profitKpis,
  type SkuProfitDbRow,
} from "@/lib/data/finance-model";

type SortKey = "gross" | "revenue" | "sku" | "units" | "margin";

export function ProfitTable({ rows, period }: { rows: SkuProfitDbRow[]; period: string }) {
  const [q, setQ] = useState("");
  const [shop, setShop] = useState("");
  const [lossOnly, setLossOnly] = useState(false);
  const [missingOnly, setMissingOnly] = useState(false);
  const [sort, setSort] = useState<SortKey>("gross");

  const shops = useMemo(() => [...new Set(rows.map((r) => r.shop))].sort(), [rows]);
  const kpis = useMemo(() => profitKpis(rows), [rows]);

  const aggregated = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = aggregateProfit(rows)
      .filter((r) => (shop ? r.shop === shop : true))
      .filter((r) => (lossOnly ? (r.grossProfit ?? 0) < 0 : true))
      .filter((r) => (missingOnly ? !r.hasFullCost : true))
      .filter((r) => (needle ? r.sku.toLowerCase().includes(needle) : true));

    return list.sort((a, b) => {
      switch (sort) {
        case "revenue":
          return b.revenue - a.revenue;
        case "units":
          return b.units - a.units;
        case "sku":
          return a.sku.localeCompare(b.sku);
        case "margin":
          return (a.margin ?? Infinity) - (b.margin ?? Infinity); // biên lãi thấp trước
        default:
          // SKU lỗ lên đầu, thiếu giá vốn xuống cuối
          if (a.grossProfit === null && b.grossProfit === null) return a.sku.localeCompare(b.sku);
          if (a.grossProfit === null) return 1;
          if (b.grossProfit === null) return -1;
          return a.grossProfit - b.grossProfit;
      }
    });
  }, [rows, q, shop, lossOnly, missingOnly, sort]);

  const currency = rows[0]?.currency ?? "USD";

  return (
    <>
      <KpiGrid>
        <KpiCard
          label={`Doanh thu thuần · ${period}`}
          value={money(kpis.revenue, currency)}
          sub={`${kpis.skuCount} SKU có phát sinh`}
          tone="flat"
        />
        <KpiCard
          label="Phí Amazon"
          value={money(kpis.fees, currency)}
          sub="referral + FBA + storage + ads theo settlement"
          tone="flat"
        />
        <KpiCard
          label="Giá vốn (VEXIM nhập)"
          value={kpis.cogs === null ? "—" : money(kpis.cogs, currency)}
          sub={kpis.missingCostRows > 0 ? `${kpis.missingCostRows} dòng thiếu giá vốn` : "đủ giá vốn"}
          tone={kpis.missingCostRows > 0 ? "warn" : "flat"}
        />
        <KpiCard
          label="Lãi gộp"
          value={kpis.grossProfit === null ? "—" : money(kpis.grossProfit, currency)}
          sub={
            kpis.lossSkus > 0
              ? `${kpis.lossSkus} SKU đang lỗ · biên ${percent(kpis.margin)}`
              : `biên lãi gộp ${percent(kpis.margin)}`
          }
          tone={kpis.grossProfit !== null && kpis.grossProfit < 0 ? "warn" : "flat"}
        />
      </KpiGrid>

      <Panel
        title="Lợi nhuận theo SKU"
        hint={`${aggregated.length}/${kpis.skuCount} SKU · sắp xếp để lộ SKU lỗ trước · bấm tiêu đề cột`}
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Tìm SKU"
            className="w-56 rounded-lg border border-line bg-card px-3 py-1.5 text-[12.5px]"
          />
          {shops.length > 1 ? (
            <select
              value={shop}
              onChange={(e) => setShop(e.target.value)}
              className="rounded-lg border border-line bg-card px-2 py-1.5 text-[12.5px] font-semibold"
            >
              <option value="">Mọi shop</option>
              {shops.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          ) : null}
          <label className="flex items-center gap-1.5 text-[12.5px] font-semibold">
            <input type="checkbox" checked={lossOnly} onChange={(e) => setLossOnly(e.target.checked)} />
            Chỉ SKU lỗ
          </label>
          <label className="flex items-center gap-1.5 text-[12.5px] font-semibold">
            <input type="checkbox" checked={missingOnly} onChange={(e) => setMissingOnly(e.target.checked)} />
            Chỉ dòng thiếu giá vốn
          </label>
        </div>

        <div className="overflow-x-auto">
          <table className={tableCls.table}>
            <thead>
              <tr>
                <th
                  className={`${tableCls.th} cursor-pointer`}
                  onClick={() => setSort("sku")}
                >
                  SKU {sort === "sku" ? "▲" : ""}
                </th>
                <th className={tableCls.th}>Shop</th>
                <th
                  className={`${tableCls.th} cursor-pointer text-right`}
                  onClick={() => setSort("units")}
                >
                  SL {sort === "units" ? "▲" : ""}
                </th>
                <th
                  className={`${tableCls.th} cursor-pointer text-right`}
                  onClick={() => setSort("revenue")}
                >
                  Doanh thu {sort === "revenue" ? "▼" : ""}
                </th>
                <th className={`${tableCls.th} text-right`}>Hoàn/khuyến mãi</th>
                <th className={`${tableCls.th} text-right`}>Phí Amazon</th>
                <th className={`${tableCls.th} text-right`}>Giá vốn</th>
                <th
                  className={`${tableCls.th} cursor-pointer text-right`}
                  onClick={() => setSort("gross")}
                >
                  Lãi gộp {sort === "gross" ? "▲" : ""}
                </th>
                <th
                  className={`${tableCls.th} cursor-pointer text-right`}
                  onClick={() => setSort("margin")}
                >
                  Biên {sort === "margin" ? "▲" : ""}
                </th>
                <th className={tableCls.th}>Nguồn phí</th>
              </tr>
            </thead>
            <tbody>
              {aggregated.map((r) => (
                <tr key={`${r.sku}|${r.currency}`}>
                  <td className={`${tableCls.td} font-bold`}>{r.sku}</td>
                  <td className={tableCls.td}>{r.shop}</td>
                  <td className={tableCls.tdNum}>{r.units}</td>
                  <td className={tableCls.tdNum}>{money(r.revenue, r.currency)}</td>
                  <td className={tableCls.tdNum}>
                    {money(r.refunds + r.promo, r.currency)}
                  </td>
                  <td className={tableCls.tdNum}>{money(r.fees, r.currency)}</td>
                  <td className={tableCls.tdNum}>
                    {r.cogs === null ? (
                      <span className="font-semibold text-amber">thiếu giá vốn</span>
                    ) : (
                      money(r.cogs, r.currency)
                    )}
                  </td>
                  <td
                    className={`${tableCls.tdNum} font-bold ${
                      r.grossProfit === null ? "text-soft" : r.grossProfit < 0 ? "text-red" : "text-green"
                    }`}
                  >
                    {r.grossProfit === null ? "—" : money(r.grossProfit, r.currency)}
                  </td>
                  <td className={tableCls.tdNum}>{r.grossProfit === null ? "—" : percent(r.margin)}</td>
                  <td className={tableCls.td}>
                    <Chip tone={r.feeSource === "settled" ? "green" : r.feeSource === "fees_api" ? "amber" : "gray"}>
                      {FEE_SOURCE_VI[r.feeSource] ?? r.feeSource}
                    </Chip>
                  </td>
                </tr>
              ))}
              {aggregated.length === 0 ? (
                <tr>
                  <td className={tableCls.td} colSpan={10}>
                    Kỳ này chưa có dòng nào — worker F4 chỉ ghi sau khi có settlement/ledger
                    và giá vốn VEXIM đã nhập.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11.5px] text-soft">
          Lãi gộp = doanh thu + hoàn/khuyến mãi + phí Amazon (âm) − giá vốn. Chi phí quảng cáo là cột riêng
          (Module 5 chưa đồng bộ nên để “—” thay vì tính 0). Cột “giá vốn/đv” lấy theo bậc hiệu lực tại đúng
          ngày phát sinh.
        </p>
      </Panel>
    </>
  );
}
