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
import { requireSession } from "@/lib/auth/session";
import { campaignsOver, ppcAlerts, ppcKpis } from "@/lib/data/mock";
import {
  adsMoney,
  adsNum,
  adsPct,
  budgetStateOf,
  campaignTypeBadge,
  computeTacos,
  kpiCardsFrom,
  ppcAlertsFrom,
  type AdsBudgetEventRaw,
  type AdsCampaignRaw,
  type AdsKpiRaw,
} from "@/lib/data/ppc-model";
import {
  readAdsBudgetEvents,
  readAdsCampaigns,
  readAdsKpi,
  readPendingSuggestionCount,
  readProductRevenue,
} from "@/lib/data/ppc";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo", "op_ppc"];

const stateChip: Record<string, { label: string; tone: "green" | "amber" | "gray" | "red" }> = {
  ENABLED: { label: "Đang chạy", tone: "green" },
  PAUSED: { label: "Tạm dừng", tone: "amber" },
  ARCHIVED: { label: "Lưu trữ", tone: "gray" },
};

/** Bảng A1 — dữ liệu THẬT từ view `vexim_ads_campaigns`. */
function CampaignTable({ rows }: { rows: AdsCampaignRaw[] }) {
  return (
    <table className={tableCls.table}>
      <thead>
        <tr>
          <th className={tableCls.th}>Campaign</th>
          <th className={tableCls.th}>Ngân sách</th>
          <th className={`${tableCls.th} text-right`}>Chi hôm qua</th>
          <th className={`${tableCls.th} text-right`}>Chi 7d</th>
          <th className={`${tableCls.th} text-right`}>ACOS 7d</th>
          <th className={`${tableCls.th} text-right`}>ACOS 14d</th>
          <th className={`${tableCls.th} text-right`}>ROAS 7d</th>
          <th className={`${tableCls.th} text-right`}>Đơn 7d</th>
          <th className={`${tableCls.th} text-right`}>CTR · CPC</th>
          <th className={tableCls.th}>Ngày cuối</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => {
          const b = budgetStateOf(c);
          const type = campaignTypeBadge(c.campaign_type);
          const st = stateChip[(c.state ?? "").toUpperCase()] ?? { label: c.state ?? "—", tone: "gray" as const };
          return (
            <tr key={`${c.seller_account_id}-${c.campaign_id}`}>
              <td className={tableCls.td}>
                <div className="font-bold">{c.name}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-soft">
                  <span title={type.title}>{type.label}</span>
                  <span>·</span>
                  <Chip tone={st.tone}>{st.label}</Chip>
                  <span>· {c.shop}</span>
                </div>
              </td>
              <td className={tableCls.td}>
                <div className="text-[12.5px] font-semibold">
                  {c.daily_budget === null ? "chưa có" : `${adsMoney(c.daily_budget, c.currency ?? "")}/ngày`}
                </div>
                <div className="mt-0.5" title={b.hint}>
                  <Chip tone={b.tone}>{b.label}</Chip>
                </div>
                <div className="mt-0.5 text-[11px] text-soft">{b.hint}</div>
              </td>
              <td className={tableCls.tdNum}>
                <div>{adsMoney(c.spend_yesterday, c.currency ?? "")}</div>
                <div className="text-[11px] text-soft">{adsPct(c.budget_usage_yesterday_pct)} ngân sách</div>
              </td>
              <td className={tableCls.tdNum}>
                <div className="font-semibold">{adsMoney(c.spend_7d, c.currency ?? "")}</div>
                <div className="text-[11px] text-soft">
                  14d {adsMoney(c.spend_14d, c.currency ?? "")} · 30d {adsMoney(c.spend_30d, c.currency ?? "")}
                </div>
              </td>
              <td className={`${tableCls.tdNum} font-bold ${c.acos_7d !== null && c.acos_7d > 25 ? "text-red" : ""}`}>
                {adsPct(c.acos_7d)}
              </td>
              <td className={tableCls.tdNum}>{adsPct(c.acos_14d)}</td>
              <td className={tableCls.tdNum}>{c.roas_7d === null ? "—" : `${Number(c.roas_7d).toFixed(2)}×`}</td>
              <td className={tableCls.tdNum}>
                <div>{adsNum(c.purchases_7d)}</div>
                <div className="text-[11px] text-soft">{adsNum(c.units_7d)} sp</div>
              </td>
              <td className={tableCls.tdNum}>
                <div>{adsPct(c.ctr_7d)}</div>
                <div className="text-[11px] text-soft">
                  {adsMoney(c.cpc_7d, c.currency ?? "")} · {adsNum(c.clicks_7d)} click
                </div>
              </td>
              <td className={tableCls.td}>{c.last_day ?? "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function BudgetEventTable({ rows }: { rows: AdsBudgetEventRaw[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-[10px] border border-dashed border-line px-3 py-6 text-center text-[13px] text-soft">
        Không có ngày nào cạn ngân sách trong 14 ngày gần nhất.
      </div>
    );
  }
  return (
    <table className={tableCls.table}>
      <thead>
        <tr>
          <th className={tableCls.th}>Ngày</th>
          <th className={tableCls.th}>Campaign</th>
          <th className={tableCls.th}>Loại</th>
          <th className={`${tableCls.th} text-right`}>Chi / Ngân sách</th>
          <th className={`${tableCls.th} text-right`}>% dùng</th>
          <th className={tableCls.th}>Giờ cạn</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((e) => (
          <tr key={e.id}>
            <td className={tableCls.td}>{e.day}</td>
            <td className={`${tableCls.td} font-bold`}>{e.campaign_name ?? e.campaign_id}</td>
            <td className={tableCls.td}>{e.event_type}</td>
            <td className={tableCls.tdNum}>
              {adsMoney(e.cost, e.currency ?? "")} / {adsMoney(e.budget_amount, e.currency ?? "")}
            </td>
            <td className={`${tableCls.tdNum} font-bold`}>{adsPct(e.usage_pct)}</td>
            <td className={tableCls.td}>
              {e.hour_known && e.exhausted_hour !== null ? (
                `${e.exhausted_hour}h`
              ) : (
                <span className="text-soft" title="Reporting API v3 không có dữ liệu theo giờ (cần Amazon Marketing Stream)">
                  chưa biết giờ
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EmptyAds() {
  return (
    <Panel title="Chưa có dữ liệu Amazon Ads" hint="chạy 2 lệnh dưới đây (hoặc chờ cron 03:00 UTC)">
      <div className="flex flex-col gap-2 text-[13px]">
        <div className="rounded-[10px] border border-dashed border-line px-3 py-2.5">
          <div className="font-bold">1. Đồng bộ cấu trúc (profile → campaign → ad group → từ khoá)</div>
          <code className="text-[12px] text-soft">npm run worker:ads-sync</code>
        </div>
        <div className="rounded-[10px] border border-dashed border-line px-3 py-2.5">
          <div className="font-bold">2. Kéo 5 report metrics (Reporting API v3)</div>
          <code className="text-[12px] text-soft">npm run worker:ads-pull</code>
        </div>
        <div className="text-soft">
          Cần credential riêng của Amazon Ads (AMAZON_ADS_CLIENT_ID · AMAZON_ADS_CLIENT_SECRET ·
          AMAZON_ADS_REFRESH_TOKEN) — Ads là đăng ký riêng, KHÔNG dùng chung app SP-API.
        </div>
      </div>
    </Panel>
  );
}

async function LivePpc() {
  let kpis: AdsKpiRaw[] = [];
  let campaigns: AdsCampaignRaw[] = [];
  let budgetEvents: AdsBudgetEventRaw[] = [];
  let pending = 0;
  let loadError: string | null = null;

  try {
    [kpis, campaigns, budgetEvents, pending] = await Promise.all([
      readAdsKpi(),
      readAdsCampaigns(),
      readAdsBudgetEvents({ days: 14 }),
      readPendingSuggestionCount(),
    ]);
  } catch (e) {
    loadError = (e as Error).message;
  }

  const mainKpi = kpis.slice().sort((a, b) => (b.spend_7d ?? 0) - (a.spend_7d ?? 0))[0];
  let tacos: number | null = null;
  if (mainKpi?.last_day) {
    try {
      const last = Date.parse(`${mainKpi.last_day}T00:00:00Z`);
      const from = new Date(last - 6 * 86_400_000).toISOString().slice(0, 10);
      const revenue = await readProductRevenue({
        sellerAccountId: mainKpi.seller_account_id,
        from,
        to: mainKpi.last_day,
      });
      tacos = computeTacos(mainKpi, revenue);
    } catch {
      tacos = null; // thiếu F4 không được làm sập màn quảng cáo
    }
  }

  const cards = kpiCardsFrom(kpis, tacos);
  const alerts = ppcAlertsFrom({ campaigns, budgetEvents, negativeSuggestionsPending: pending });

  return (
    <>
      <PageHeader
        title="Quảng cáo (PPC)"
        sub={
          kpis.length > 0
            ? `Ngày mới nhất ${mainKpi?.last_day ?? "—"} · cửa sổ 7/14/30 ngày · ${campaigns.length} campaign`
            : "Chưa có dữ liệu Amazon Ads"
        }
        desc="Nguồn: Amazon Ads API — Campaign Management v3 (cấu trúc) + Reporting API v3 (metrics theo ngày). ACOS/ROAS/CPC do hệ thống suy ra từ cost ÷ sales vì v3 không trả sẵn."
      />

      {loadError ? (
        <div className="mb-3 rounded-[10px] border border-line px-3 py-2.5 text-[13px] text-soft">
          Không đọc được dữ liệu quảng cáo: {loadError}
        </div>
      ) : null}

      {cards.length > 0 ? (
        <KpiGrid>
          {cards.map((k) => (
            <KpiCard key={k.label} {...k} />
          ))}
        </KpiGrid>
      ) : null}

      {cards.length === 0 ? (
        <EmptyAds />
      ) : (
        <>
          <Grid2>
            <Panel title="Cần xử lý ngay" hint="tính từ số liệu thật, không phải câu chữ mẫu">
              <AlertList items={alerts} />
            </Panel>
            <Panel title="Vì sao hết đơn giữa ngày" hint="ngày cạn ngân sách · 14 ngày gần nhất">
              <BudgetEventTable rows={budgetEvents} />
            </Panel>
          </Grid2>

          <Panel
            title="Campaign"
            hint="chi 7 ngày · ACOS suy ra · trạng thái ngân sách theo ngày mới nhất có số"
          >
            <CampaignTable rows={campaigns} />
          </Panel>

          <Panel title="Chưa làm được ở bước này" hint="phần 2 và phần 3 của Module 5">
            <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] text-soft">
              <li>
                <b>A2 — chi tiết campaign</b> (ad group → từ khoá/nhóm sản phẩm): đã có bảng
                <code className="mx-1">ads.targets</code> + view <code>vexim_ads_targets</code>, chưa có màn hình.
              </li>
              <li>
                <b>A3 — search term &amp; gợi ý negative</b>: bảng <code>search_terms</code>/
                <code>negative_suggestions</code> đã có dữ liệu, chờ màn duyệt.
              </li>
              <li>
                <b>Phần 3 — ghi ngược lên Amazon</b> (đổi ngân sách/bid, thêm negative): cần ngưỡng duyệt
                trưởng phòng (tăng &gt; 30%/ngày, SOP-05 bước 4) + ghi <code>iam.audit_logs</code>.
              </li>
            </ul>
          </Panel>
        </>
      )}
    </>
  );
}

export default async function PpcPage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  if (session.mode === "supabase") return <LivePpc />;

  return (
    <>
      <div className="mb-3 text-sm font-bold text-amber">DEMO · Dữ liệu minh họa</div>
      <PageHeader
        title="Quảng cáo (PPC)"
        sub={session.persona === "op_ppc" ? "Hôm qua · 5 shop được gán · ACOS tính theo 7 ngày" : "Hôm qua · ACOS tính theo 7 ngày"}
        desc="Nguồn: Amazon Ads API — campaign metrics theo ngày, search term report hằng ngày."
      />
      <KpiGrid>
        {ppcKpis.map((k) => (
          <KpiCard key={k.label} {...k} />
        ))}
      </KpiGrid>
      <Grid2>
        <Panel title="Cần xử lý ngay">
          <AlertList items={ppcAlerts} />
        </Panel>
        <Panel title="Campaign ACOS vượt ngưỡng" hint="7 ngày">
          <table className={tableCls.table}>
            <thead>
              <tr>
                <th className={tableCls.th}>Campaign</th>
                <th className={`${tableCls.th} text-right`}>Spend 7d</th>
                <th className={`${tableCls.th} text-right`}>ACOS</th>
                <th className={tableCls.th}>Xu hướng</th>
              </tr>
            </thead>
            <tbody>
              {campaignsOver.map((c) => (
                <tr key={c.name}>
                  <td className={`${tableCls.td} font-bold`}>{c.name}</td>
                  <td className={tableCls.tdNum}>{c.spend7d}</td>
                  <td className={`${tableCls.tdNum} font-bold text-red`}>{c.acos}</td>
                  <td className={tableCls.td}>{c.trend}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </Grid2>
    </>
  );
}
