/**
 * LivePpc — server component cho /ppc (Module 5, phần đọc).
 *
 * Mọi con số trên trang đều truy được về NGUỒN: view nào, cửa sổ ngày nào, nhập
 * lúc nào. Đó là lý do trang luôn có khối "Tiến trình đồng bộ" và "Cách đọc số":
 * Ops phải phân biệt được "ACOS cao thật" với "dữ liệu cũ/thiếu" trước khi sửa bid.
 *
 * Trang KHÔNG tự tính lại tỷ lệ: view 0020 đã tính spend/sales theo đúng cửa sổ
 * 7 ngày kết thúc ở NGÀY DỮ LIỆU MỚI NHẤT (không hardcode hôm qua), model chỉ
 * tổng hợp lại theo tiền tệ.
 */
import Link from "next/link";

import { AlertList, Bars, Chip, Grid2, KpiCard, KpiGrid, PageHeader, Panel, tableCls } from "@/components/ui";
import { readPpcPageData } from "@/lib/data/ads";
import {
  UNKNOWN_CURRENCY,
  agoText,
  bestSearchTerms,
  budgetWatch,
  buildAdsAlerts,
  buildAdsKpis,
  campaignsOverTarget,
  countText,
  dailySeries,
  emptyStateReason,
  moneyText,
  pctText,
  primaryTotals,
  ratioText,
  spendBars,
  summarizeSyncHealth,
  topSearchTerms,
  totalsByCurrency,
  trendText,
  trendTone,
  wastedSearchTerms,
} from "@/lib/data/ads-model";

const toneClass = {
  up: "text-green",
  down: "text-red",
  warn: "text-amber",
  flat: "text-muted",
} as const;

function CcyFilter({ currencies, active }: { currencies: string[]; active: string | null }) {
  if (currencies.length <= 1) return null;
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-[12px] font-bold text-soft">Tiền tệ:</span>
      <Link
        href="/ppc"
        className={`rounded-full border px-2.5 py-0.5 text-[11.5px] font-bold transition ${
          active === null ? "border-accent bg-accent-soft text-accent-ink" : "border-line bg-card text-muted hover:border-accent"
        }`}
      >
        Tất cả
      </Link>
      {currencies.map((c) => (
        <Link
          key={c}
          href={`/ppc?ccy=${encodeURIComponent(c)}`}
          className={`rounded-full border px-2.5 py-0.5 text-[11.5px] font-bold transition ${
            active === c ? "border-accent bg-accent-soft text-accent-ink" : "border-line bg-card text-muted hover:border-accent"
          }`}
        >
          {c}
        </Link>
      ))}
    </span>
  );
}

export async function LivePpc({ ccy, shopId }: { ccy?: string; shopId?: string }) {
  const data = await readPpcPageData(shopId);
  const allTotals = totalsByCurrency(data.kpis);
  const totals = allTotals.filter((t) => (ccy ? t.currency === ccy : true));
  const primary = primaryTotals(totals.length > 0 ? totals : allTotals);

  const campaigns = data.campaigns.filter((c) => (ccy ? c.currency === ccy : true));
  const terms = data.searchTerms.filter((t) => (ccy ? t.currency === ccy : true));
  const health = summarizeSyncHealth(data.reportRequests);
  // Chỉ vẽ biểu đồ khi biết rõ đang vẽ TIỀN TỆ NÀO. Không có KPI (chưa đồng bộ)
  // mà vẫn cộng mọi dòng daily lại là trộn $ với £ — thà không vẽ.
  const series = primary ? dailySeries(data.daily, primary.currency) : [];
  const bars = spendBars(series);

  const alerts = buildAdsAlerts({
    totals: totals.length > 0 ? totals : allTotals,
    campaigns,
    searchTerms: terms,
    reportRequests: data.reportRequests,
  });

  const over = campaignsOverTarget(campaigns, 12);
  const budget = budgetWatch(campaigns, 12);
  const wasted = wastedSearchTerms(terms, 10);
  const top = topSearchTerms(terms, 10);
  const best = bestSearchTerms(terms, 5);
  // Ngưỡng ACOS thật đang áp (view đọc từ ops.alert_rules; mặc định 25 khi rule bị tắt).
  const acosTarget = campaigns.find((c) => c.acosTarget !== null)?.acosTarget ?? null;

  const empty = data.kpis.length === 0 ? emptyStateReason({ kpis: data.kpis, reportRequests: data.reportRequests, profiles: data.profileCount }) : null;

  const freshness = primary
    ? `ngày số liệu mới nhất ${primary.metricsDay ?? "—"} · nhập ${agoText(primary.hoursSinceImport)}`
    : "chưa có metrics";

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <span className="font-bold text-accent-ink">SUPABASE · dữ liệu Ads API thật</span>
        <span className="text-[12px] text-soft">{freshness}</span>
        <CcyFilter currencies={allTotals.map((t) => t.currency)} active={ccy ?? null} />
        <Link href="/module0/connect" className="ml-auto text-[12px] font-bold text-accent-ink hover:underline">
          Kết nối / token Ads →
        </Link>
      </div>

      <PageHeader
        title="Quảng cáo (PPC)"
        sub={`${data.kpis.length} shop có số liệu · cửa sổ 7 ngày · attribution 7 ngày`}
        desc="Nguồn: Amazon Ads Reporting v3 (spCampaigns, spAdvertisedProduct, spSearchTerm, spTargeting) qua cron /api/cron/ads-sync. Số liệu ads luôn trễ hơn realtime — xem “Tiến trình đồng bộ” để biết dữ liệu mới tới đâu."
      />

      {data.partialErrors.length > 0 ? (
        <Panel title="Một phần dữ liệu chưa đọc được" hint="trang vẫn hiện các phần còn lại">
          <ul className="space-y-1 text-[12.5px] text-amber">
            {data.partialErrors.map((e) => (
              <li key={e}>• {e}</li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {empty ? (
        <Panel title={empty.title} hint="chưa có gì để hiển thị">
          <ul className="space-y-1.5 text-[13px] text-muted">
            {empty.lines.map((l) => (
              <li key={l}>• {l}</li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <KpiGrid>
        {buildAdsKpis(primary).map((k) => (
          <KpiCard key={k.label} {...k} />
        ))}
      </KpiGrid>

      <Grid2>
        <Panel title="Cần xử lý ngay" hint="xếp theo mức ảnh hưởng tiền">
          <AlertList items={alerts} />
        </Panel>

        <Panel title="Tiến trình đồng bộ Ads" hint="ads.report_requests · Reporting v3 bất đồng bộ">
          <table className={tableCls.table}>
            <tbody>
              <tr>
                <td className={`${tableCls.td} font-bold`}>Report đã nhập</td>
                <td className={tableCls.tdNum}>{countText(health.imported)}</td>
                <td className={tableCls.td}>{countText(health.rowsImported)} dòng metrics</td>
              </tr>
              <tr>
                <td className={`${tableCls.td} font-bold`}>Đang chờ Amazon</td>
                <td className={tableCls.tdNum}>{countText(health.waiting)}</td>
                <td className={tableCls.td}>lần cron sau poll tiếp</td>
              </tr>
              <tr>
                <td className={`${tableCls.td} font-bold`}>Hỏng / bị giới hạn</td>
                <td className={`${tableCls.tdNum} ${health.failed > 0 ? "font-extrabold text-red" : ""}`}>
                  {countText(health.failed)}
                </td>
                <td className={tableCls.td}>{health.stale > 0 ? `${health.stale} chờ quá 2 giờ` : "không có chờ lâu"}</td>
              </tr>
              <tr>
                <td className={`${tableCls.td} font-bold`}>Nhập lần cuối</td>
                <td className={tableCls.td} colSpan={2}>
                  {health.lastImportedAt ? new Date(health.lastImportedAt).toLocaleString("vi-VN") : "chưa nhập lần nào"}
                </td>
              </tr>
              <tr>
                <td className={`${tableCls.td} font-bold`}>Profile Ads đã lưu</td>
                <td className={tableCls.tdNum}>{countText(data.profileCount)}</td>
                <td className={tableCls.td}>mỗi profile = 1 tài khoản ads/thị trường</td>
              </tr>
            </tbody>
          </table>
          {health.total === 0 ? (
            <p className="mt-2 text-[12px] text-amber">
              Chưa có report nào được xin. Chạy <code>/api/cron/ads-sync</code> (cần <code>CRON_SECRET</code>) rồi tải lại
              trang này.
            </p>
          ) : null}
        </Panel>
      </Grid2>

      {bars.length > 0 ? (
        <Panel
          title={`Spend theo ngày · ${primary?.currency ?? ""}`}
          hint={`${series.length} ngày có dữ liệu · thanh cuối = ngày mới nhất CÓ SỐ (không phải hôm nay)`}
        >
          <Bars data={bars} />
        </Panel>
      ) : null}

      {data.profiles.length > 0 ? (
        <Panel
          title="Tài khoản Ads (profile) đã đồng bộ"
          hint="GET /v2/profiles · profileId là giá trị của header Amazon-Advertising-API-Scope"
        >
          <div className="overflow-x-auto">
            <table className={tableCls.table}>
              <thead>
                <tr>
                  <th className={tableCls.th}>Shop</th>
                  <th className={tableCls.th}>Profile ID</th>
                  <th className={tableCls.th}>Thị trường</th>
                  <th className={tableCls.th}>Loại tài khoản</th>
                  <th className={tableCls.th}>Tiền</th>
                  <th className={`${tableCls.th} text-right`}>Campaign đã biết</th>
                  <th className={tableCls.th}>Ngày số liệu cuối</th>
                  <th className={tableCls.th}>Mặc định</th>
                </tr>
              </thead>
              <tbody>
                {data.profiles.map((pf) => (
                  <tr key={`${pf.shopId}|${pf.profileId}`}>
                    <td className={`${tableCls.td} font-bold`}>{pf.shop}</td>
                    <td className={`${tableCls.td} font-mono text-[12px]`}>{pf.profileId}</td>
                    <td className={tableCls.td}>
                      {pf.countryCode ?? "—"}
                      {pf.marketplace ? <span className="ml-1 text-[11px] text-soft">{pf.marketplace}</span> : null}
                    </td>
                    <td className={tableCls.td}>
                      <Chip tone={pf.accountType === "seller" ? "green" : pf.accountType === "vendor" ? "amber" : "gray"}>
                        {pf.accountType ?? "—"}
                      </Chip>
                      {pf.accountName ? <div className="text-[11px] text-soft">{pf.accountName}</div> : null}
                    </td>
                    <td className={tableCls.td}>{pf.currency ?? "—"}</td>
                    <td className={tableCls.tdNum}>{countText(pf.campaignsKnown)}</td>
                    <td className={tableCls.td}>{pf.lastMetricsDay ?? "chưa có metrics"}</td>
                    <td className={tableCls.td}>{pf.isDefault ? <Chip tone="green">mặc định</Chip> : <span className="text-soft">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11.5px] text-soft">
            Shop có NHIỀU profile (nhiều thị trường) thì cron chọn theo marketplaceStringId của shop; không khớp thì DỪNG
            và báo lý do chứ không đoán — xem <Link href="/module0/connect" className="font-bold hover:underline">/module0/connect</Link>.
          </p>
        </Panel>
      ) : null}

      <Panel title="Campaign vượt ngưỡng ACOS" hint="7 ngày · chỉ campaign có spend · ngưỡng từ ops.alert_rules">
        {over.length === 0 ? (
          <p className="text-[13px] text-muted">
            Không campaign nào vượt ngưỡng
            {acosTarget !== null ? ` ACOS ${pctText(acosTarget, 0)} (đổi ngưỡng ở ops.alert_rules, rule acos_over_target)` : ""}.
            {data.campaigns.length === 0 ? " Chưa có campaign nào được đồng bộ." : ""}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableCls.table}>
              <thead>
                <tr>
                  <th className={tableCls.th}>Campaign</th>
                  <th className={tableCls.th}>Shop</th>
                  <th className={`${tableCls.th} text-right`}>Spend 7d</th>
                  <th className={`${tableCls.th} text-right`}>Sales 7d</th>
                  <th className={`${tableCls.th} text-right`}>ACOS</th>
                  <th className={`${tableCls.th} text-right`}>Ngưỡng</th>
                  <th className={tableCls.th}>Xu hướng</th>
                  <th className={`${tableCls.th} text-right`}>Ngân sách dùng</th>
                  <th className={tableCls.th}>Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {over.map((c) => (
                  <tr key={`${c.shopId}|${c.campaignId}`}>
                    <td className={`${tableCls.td} font-bold`}>{c.name}</td>
                    <td className={tableCls.td}>{c.shop}</td>
                    <td className={tableCls.tdNum}>{moneyText(c.spend7, c.currency)}</td>
                    <td className={tableCls.tdNum}>{moneyText(c.sales7, c.currency)}</td>
                    <td className={`${tableCls.tdNum} font-extrabold text-red`}>{pctText(c.acos7)}</td>
                    <td className={tableCls.tdNum}>{pctText(c.acosTarget, 0)}</td>
                    <td className={`${tableCls.td} text-[12px] font-semibold ${toneClass[trendTone(c.acosTrendPts)]}`}>
                      {trendText(c.acosTrendPts)}
                    </td>
                    <td className={tableCls.tdNum}>
                      {pctText(c.budgetUsedPct, 0)}
                      {c.budgetExhausted ? <span className="ml-1 font-extrabold text-red">cạn</span> : null}
                    </td>
                    <td className={tableCls.td}>
                      <Chip tone={c.state === "ENABLED" ? "green" : c.state === "PAUSED" ? "gray" : "amber"}>
                        {c.state ?? "không rõ"}
                      </Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Grid2>
        <Panel title="Ngân sách cần nới" hint="đã dùng ≥80% ngân sách ngày">
          {budget.length === 0 ? (
            <p className="text-[13px] text-muted">Không campaign nào sát ngân sách trong cửa sổ hiện tại.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className={tableCls.table}>
                <thead>
                  <tr>
                    <th className={tableCls.th}>Campaign</th>
                    <th className={`${tableCls.th} text-right`}>Ngân sách/ngày</th>
                    <th className={`${tableCls.th} text-right`}>Đã dùng</th>
                    <th className={`${tableCls.th} text-right`}>%</th>
                  </tr>
                </thead>
                <tbody>
                  {budget.map((c) => (
                    <tr key={`${c.shopId}|${c.campaignId}|budget`}>
                      <td className={`${tableCls.td} font-bold`}>
                        {c.name}
                        <div className="text-[11px] font-semibold text-soft">{c.shop}</div>
                      </td>
                      <td className={tableCls.tdNum}>{moneyText(c.dailyBudget, c.currency)}</td>
                      <td className={tableCls.tdNum}>{moneyText(c.spendYesterday, c.currency)}</td>
                      <td className={`${tableCls.tdNum} font-extrabold ${c.budgetExhausted ? "text-red" : "text-amber"}`}>
                        {pctText(c.budgetUsedPct, 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-[11.5px] text-soft">
            SP không có endpoint Budget Usage như SB: % ở đây lấy từ <code>ads.budget_usage</code> — cron ghi số THẬT khi
            có, còn không thì ƯỚC LƯỢNG = spend ngày / ngân sách ngày (cột <code>source</code> phân biệt rõ). Giờ cạn là
            suy ra từ lần chụp đầu tiên thấy ≥100%, không phải số Amazon đưa.
          </p>
        </Panel>

        <Panel title="Search term đang đốt tiền" hint="≥3 click · 0 đơn · 7 ngày">
          {wasted.length === 0 ? (
            <p className="text-[13px] text-muted">
              {terms.length === 0
                ? "Chưa có search term report (cần report spSearchTerm được nhập)."
                : "Không term nào chạm ngưỡng đốt tiền (≥3 click mà 0 đơn)."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className={tableCls.table}>
                <thead>
                  <tr>
                    <th className={tableCls.th}>Search term</th>
                    <th className={`${tableCls.th} text-right`}>Click</th>
                    <th className={`${tableCls.th} text-right`}>Spend</th>
                    <th className={tableCls.th}>Khớp từ</th>
                  </tr>
                </thead>
                <tbody>
                  {wasted.map((t) => (
                    <tr key={`${t.shopId}|${t.campaignId}|${t.term}`}>
                      <td className={`${tableCls.td} font-bold`}>
                        “{t.term}”
                        <div className="text-[11px] font-semibold text-soft">
                          {t.campaignName ?? "—"}
                          {t.keywordText ? ` · kw: ${t.keywordText}` : ""}
                        </div>
                      </td>
                      <td className={tableCls.tdNum}>{countText(t.clicks)}</td>
                      <td className={`${tableCls.tdNum} font-extrabold text-red`}>{moneyText(t.spend, t.currency)}</td>
                      <td className={tableCls.td}>
                        <Chip tone="gray">{t.matchType ?? t.keywordType ?? "—"}</Chip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-[11.5px] text-soft">
            Đây là TÍN HIỆU, không phải kết luận: 3 click chưa đủ mẫu để chắc chắn. Thêm negative keyword tự động + luồng
            duyệt + audit log thuộc PPC Phần 2.
          </p>
        </Panel>
      </Grid2>

      <Grid2>
        <Panel title="Top search term theo spend" hint="7 ngày · mọi term kể cả placement">
          {top.length === 0 ? (
            <p className="text-[13px] text-muted">Chưa có dữ liệu search term.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className={tableCls.table}>
                <thead>
                  <tr>
                    <th className={tableCls.th}>Term</th>
                    <th className={`${tableCls.th} text-right`}>Click</th>
                    <th className={`${tableCls.th} text-right`}>Spend</th>
                    <th className={`${tableCls.th} text-right`}>Sales 7d</th>
                    <th className={`${tableCls.th} text-right`}>ACOS</th>
                  </tr>
                </thead>
                <tbody>
                  {top.map((t) => (
                    <tr key={`${t.shopId}|${t.campaignId}|${t.term}|top`}>
                      <td className={`${tableCls.td} font-bold`}>
                        {t.isPlacementWithoutKeyword ? (
                          <span>
                            <Chip tone="amber">placement</Chip> <span className="text-soft">không gắn từ khoá</span>
                          </span>
                        ) : (
                          `“${t.term}”`
                        )}
                      </td>
                      <td className={tableCls.tdNum}>{countText(t.clicks)}</td>
                      <td className={tableCls.tdNum}>{moneyText(t.spend, t.currency)}</td>
                      <td className={tableCls.tdNum}>{moneyText(t.sales7, t.currency)}</td>
                      <td className={tableCls.tdNum}>{pctText(t.acos7)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="Term hiệu quả nhất" hint="có đơn · ACOS thấp → nơi nên tăng bid">
          {best.length === 0 ? (
            <p className="text-[13px] text-muted">Chưa term nào có đơn trong cửa sổ 7 ngày.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className={tableCls.table}>
                <thead>
                  <tr>
                    <th className={tableCls.th}>Term</th>
                    <th className={`${tableCls.th} text-right`}>Đơn 7d</th>
                    <th className={`${tableCls.th} text-right`}>ACOS</th>
                    <th className={`${tableCls.th} text-right`}>Bid</th>
                  </tr>
                </thead>
                <tbody>
                  {best.map((t) => (
                    <tr key={`${t.shopId}|${t.campaignId}|${t.term}|best`}>
                      <td className={`${tableCls.td} font-bold`}>“{t.term}”</td>
                      <td className={tableCls.tdNum}>{countText(t.adOrders7)}</td>
                      <td className={`${tableCls.tdNum} font-extrabold text-green`}>{pctText(t.acos7)}</td>
                      <td className={tableCls.tdNum}>{moneyText(t.bid, t.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </Grid2>

      <Panel title="KPI theo shop × tiền tệ" hint="không cộng tiền khác tiền tệ — mỗi dòng một thị trường">
        {(totals.length > 0 ? totals : allTotals).length === 0 ? (
          <p className="text-[13px] text-muted">Chưa có KPI shop nào.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableCls.table}>
              <thead>
                <tr>
                  <th className={tableCls.th}>Shop</th>
                  <th className={tableCls.th}>Tiền</th>
                  <th className={`${tableCls.th} text-right`}>Spend 7d</th>
                  <th className={`${tableCls.th} text-right`}>Sales ads 7d</th>
                  <th className={`${tableCls.th} text-right`}>ACOS</th>
                  <th className={`${tableCls.th} text-right`}>ROAS</th>
                  <th className={`${tableCls.th} text-right`}>CPC</th>
                  <th className={`${tableCls.th} text-right`}>Tổng doanh thu 7d</th>
                  <th className={`${tableCls.th} text-right`}>TACOS</th>
                  <th className={tableCls.th}>Campaign</th>
                  <th className={tableCls.th}>Dữ liệu</th>
                </tr>
              </thead>
              <tbody>
                {data.kpis
                  .filter((k) => (ccy ? k.currency === ccy : true))
                  .map((k) => (
                    <tr key={`${k.shopId}|${k.currency}`}>
                      <td className={`${tableCls.td} font-bold`}>{k.shop}</td>
                      <td className={tableCls.td}>{k.currency}</td>
                      <td className={tableCls.tdNum}>{moneyText(k.spend7)}</td>
                      <td className={tableCls.tdNum}>{moneyText(k.adSales7)}</td>
                      <td className={`${tableCls.tdNum} font-bold ${k.acos7 !== null && k.acos7 > 25 ? "text-red" : ""}`}>
                        {pctText(k.acos7)}
                      </td>
                      <td className={tableCls.tdNum}>{ratioText(k.roas7)}</td>
                      <td className={tableCls.tdNum}>{moneyText(k.cpc7)}</td>
                      <td className={tableCls.tdNum}>{k.tacosUnknown ? <span className="text-amber">chưa có</span> : moneyText(k.totalSales7)}</td>
                      <td className={tableCls.tdNum}>{pctText(k.tacos7)}</td>
                      <td className={tableCls.tdNum}>
                        {k.campaignsEnabled} bật
                        {k.campaignsOverTarget > 0 ? <span className="ml-1 font-bold text-red">{k.campaignsOverTarget} vượt</span> : null}
                        {k.campaignsExhausted > 0 ? <span className="ml-1 font-bold text-amber">{k.campaignsExhausted} cạn</span> : null}
                      </td>
                      <td className={tableCls.td}>
                        <Chip tone={k.isStale ? "red" : "green"}>
                          {k.isStale ? `cũ · ${agoText(k.hoursSinceImport)}` : `mới · ${agoText(k.hoursSinceImport)}`}
                        </Chip>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Cách đọc số & giới hạn" hint="để không ra quyết định sai vì hiểu nhầm dữ liệu">
        <ul className="space-y-1 text-[12.5px] text-muted">
          <li>
            • <b>Cửa sổ 7 ngày</b> kết thúc ở NGÀY DỮ LIỆU MỚI NHẤT của shop, không phải “hôm nay”. Attribution của Amazon
            hồi tố (đơn của click hôm trước có thể về sau), nên số 7 ngày gần nhất còn nhích lên.
          </li>
          <li>
            • <b>ACOS</b> = spend / doanh thu ads; <b>ROAS</b> = doanh thu ads / spend; <b>TACOS</b> = spend ads / TỔNG
            doanh thu mọi kênh (từ <code>sales.order_daily</code> — cần Module 4 đồng bộ). Chưa có tổng doanh thu thì để
            “—”, không suy ra 0%.
          </li>
          <li>
            • <b>Không cộng khác tiền tệ</b>: shop US và CA tách dòng. Muốn một con số hợp nhất thì phải chốt tỷ giá —
            việc đó thuộc Module 6, không tự làm ở đây.
          </li>
          <li>
            • <b>Doanh thu ads 7 ngày</b> (<code>sales7d</code>) là quy ước cho tài khoản SELLER; tài khoản vendor/author
            dùng 14 ngày. Sai cửa sổ attribution là ACOS lệch hẳn.
          </li>
          <li>
            • <b>Search term “*” / nhãn placement</b> là vị trí hiển thị không gắn từ khoá — dữ liệu thật, không phải rác,
            và không thể negative bằng từ khoá.
          </li>
          <li>
            • <b>Trang này chỉ ĐỌC</b>. Chưa có nút sửa bid/ngân sách: chiều ghi + audit log thuộc PPC Phần 2 &amp; 3.
          </li>
        </ul>
      </Panel>

      {data.daily.length === 0 && data.kpis.length > 0 ? (
        <p className="text-[12px] text-soft">
          Chưa vẽ được biểu đồ ngày: report <code>spCampaigns</code> theo DAILY chưa nhập (xem Tiến trình đồng bộ).
        </p>
      ) : null}

      {primary?.currency === UNKNOWN_CURRENCY ? (
        <p className="text-[12px] text-amber">
          Một số dòng không có mã tiền tệ (Amazon không trả <code>currencyCode</code>) — đã gom vào nhóm “—” để không cộng
          nhầm vào USD/EUR.
        </p>
      ) : null}
    </>
  );
}
