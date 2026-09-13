import { ChangeForm } from "@/components/ppc/ChangeForm";
import { Chip, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { demoAdGroups, demoCampaignFor, demoNegativeKeywords, demoTargets } from "@/lib/data/ppc-demo";
import {
  adsMoney,
  adsNum,
  adsPct,
  budgetStateOf,
  campaignTypeBadge,
  isAcosOverTarget,
  matchTypeLabel,
  targetKindLabel,
  targetText,
  type AdsAdGroupRaw,
  type AdsCampaignRaw,
  type AdsNegativeKeywordRaw,
  type AdsTargetRaw,
} from "@/lib/data/ppc-model";
import { readAdsAdGroups, readAdsCampaigns, readAdsNegativeKeywords, readAdsPermissions, readAdsTargets } from "@/lib/data/ppc";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo", "op_ppc"];

const stateChip: Record<string, { label: string; tone: "green" | "amber" | "gray" }> = {
  ENABLED: { label: "Đang chạy", tone: "green" },
  PAUSED: { label: "Tạm dừng", tone: "amber" },
  ARCHIVED: { label: "Lưu trữ", tone: "gray" },
};

function TargetsTable({
  rows,
  canWrite,
  currency,
}: {
  rows: AdsTargetRaw[];
  canWrite: boolean;
  currency: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-[10px] border border-dashed border-line px-3 py-4 text-center text-[12.5px] text-soft">
        Ad group này chưa có từ khoá/nhóm sản phẩm trong dữ liệu (chạy <code>worker:ads-sync</code> để tải).
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className={tableCls.table}>
        <thead>
          <tr>
            <th className={tableCls.th}>Từ khoá / nhóm</th>
            <th className={tableCls.th}>Khớp</th>
            <th className={`${tableCls.th} text-right`}>Bid</th>
            <th className={`${tableCls.th} text-right`}>Chi 7d</th>
            <th className={`${tableCls.th} text-right`}>Click · CPC</th>
            <th className={`${tableCls.th} text-right`}>Đơn · ACOS</th>
            <th className={tableCls.th}>Trạng thái</th>
            <th className={tableCls.th}>Hành động</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const st = stateChip[(t.state ?? "").toUpperCase()] ?? { label: t.state ?? "—", tone: "gray" as const };
            const isKeyword = (t.target_kind ?? "").toLowerCase() === "keyword";
            const running = (t.state ?? "").toUpperCase() === "ENABLED";
            return (
              <tr key={`${t.ad_group_id}-${t.target_key}`}>
                <td className={tableCls.td}>
                  <div className="font-bold">{targetText(t)}</div>
                  <div className="text-[11px] text-soft">
                    {targetKindLabel(t.target_kind)} · {t.target_key}
                  </div>
                </td>
                <td className={tableCls.td}>{matchTypeLabel(t.match_type)}</td>
                <td className={tableCls.tdNum}>
                  {t.bid === null ? "—" : adsMoney(t.bid, t.currency ?? currency)}
                  {t.bid === null && !isKeyword ? (
                    <div className="text-[11px] text-soft">bid theo ad group</div>
                  ) : null}
                </td>
                <td className={tableCls.tdNum}>{adsMoney(t.spend_7d, t.currency ?? currency)}</td>
                <td className={tableCls.tdNum}>
                  <div>{adsNum(t.clicks_7d)}</div>
                  <div className="text-[11px] text-soft">{adsMoney(t.cpc_7d, t.currency ?? currency)}</div>
                </td>
                <td className={tableCls.tdNum}>
                  <div>{adsNum(t.purchases_7d)}</div>
                  <div className={`text-[11px] ${isAcosOverTarget(t.acos_7d ?? null) ? "font-bold text-red" : "text-soft"}`}>
                    {adsPct(t.acos_7d)}
                  </div>
                </td>
                <td className={tableCls.td}>
                  <Chip tone={st.tone}>{st.label}</Chip>
                </td>
                <td className={tableCls.td}>
                  {canWrite ? (
                    <div className="flex flex-col gap-2">
                      {isKeyword ? (
                        <ChangeForm
                          sellerAccountId={t.seller_account_id}
                          adsProfileId={t.ads_profile_id}
                          action="set_bid"
                          entityType="keyword"
                          entityKey={t.target_key}
                          campaignId={t.campaign_id}
                          adGroupId={t.ad_group_id}
                          label={targetText(t)}
                          valueLabel="Bid mới"
                          defaultValue={t.bid ?? ""}
                          submitLabel="Đổi bid"
                          hint="Tăng > 30%/ngày ⇒ chờ trưởng phòng duyệt"
                          inputWidth="w-24"
                        />
                      ) : null}
                      <ChangeForm
                        sellerAccountId={t.seller_account_id}
                        adsProfileId={t.ads_profile_id}
                        action="set_state"
                        entityType="keyword"
                        entityKey={t.target_key}
                        campaignId={t.campaign_id}
                        adGroupId={t.ad_group_id}
                        label={targetText(t)}
                        fixedValue={running ? "PAUSED" : "ENABLED"}
                        submitLabel={running ? "Tạm dừng" : "Bật lại"}
                        danger={running}
                        hint={running ? "Tạm dừng: không cần duyệt" : "Bật lại từ dừng: cần duyệt"}
                      />
                    </div>
                  ) : (
                    <span className="text-[11.5px] text-soft">chỉ xem</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default async function CampaignDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ campaignId: string }>;
  searchParams: Promise<{ shop?: string }>;
}) {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;
  const { campaignId: rawId } = await params;
  const campaignId = decodeURIComponent(rawId);
  const sp = await searchParams;

  if (session.mode === "demo") {
    const campaign = demoCampaignFor(campaignId);
    const groups = demoAdGroups.filter((g) => g.campaign_id === campaignId);
    const targets = demoTargets.filter((t) => t.campaign_id === campaignId);
    return (
      <>
        <div className="mb-3 text-sm font-bold text-amber">DEMO · Dữ liệu minh họa (chưa nối Supabase)</div>
        <PageHeader
          title={`A2 — ${campaign?.name ?? campaignId}`}
          sub={`${groups.length} ad group · ${targets.length} từ khoá/nhóm sản phẩm`}
          desc="Chi tiết campaign: hiệu quả từng từ khóa và các đề xuất tối ưu — giảm bid từ khóa kém, tạm dừng từ khóa đốt tiền, nới ngân sách khi campaign hết tiền sớm."
        />
        <CampaignBody
          campaign={campaign}
          groups={groups}
          targets={targets}
          negatives={demoNegativeKeywords.filter((n) => n.campaign_id === campaignId)}
          canWrite
        />
      </>
    );
  }

  let campaign: AdsCampaignRaw | undefined;
  let groups: AdsAdGroupRaw[] = [];
  let targets: AdsTargetRaw[] = [];
  let negatives: AdsNegativeKeywordRaw[] = [];
  let canWrite = false;
  let failed: string | null = null;
  try {
    const [campaigns, g, t, perms] = await Promise.all([
      readAdsCampaigns(sp.shop ?? null),
      readAdsAdGroups({ sellerAccountId: sp.shop ?? null, campaignId }),
      readAdsTargets({ sellerAccountId: sp.shop ?? null, campaignId }),
      readAdsPermissions(sp.shop ?? null),
    ]);
    campaign = campaigns.find((c) => c.campaign_id === campaignId);
    groups = g;
    targets = t;
    canWrite = perms.canWrite;
    // Negative của campaign: đọc theo shop rồi lọc — view không nhận tham số campaign.
    negatives = (await readAdsNegativeKeywords({ sellerAccountId: sp.shop ?? null })).filter(
      (n) => n.campaign_id === campaignId,
    );
  } catch (error) {
    failed = error instanceof Error ? error.message : "Không đọc được chi tiết campaign";
  }

  return (
    <>
      <PageHeader
        title={`A2 — ${campaign?.name ?? campaignId}`}
        sub={`${groups.length} ad group · ${targets.length} từ khoá/nhóm sản phẩm · ${negatives.length} negative đã chặn`}
        desc="Chi tiết campaign: hiệu quả từng từ khóa và các đề xuất tối ưu — giảm bid từ khóa kém, tạm dừng từ khóa đốt tiền, nới ngân sách khi campaign hết tiền sớm."
      />
      {failed ? (
        <div className="mb-3 rounded-[10px] bg-red-soft px-3.5 py-2.5 text-[13px] font-semibold text-[#a01717]">
          Không đọc được chi tiết: {failed}
        </div>
      ) : null}
      {!canWrite ? (
        <div className="mb-3 rounded-[10px] bg-amber-soft px-3.5 py-2.5 text-[13px] font-semibold text-[#8a5602]">
          Tài khoản này không có quyền ghi cho shop này — chỉ xem được.
        </div>
      ) : null}
      <CampaignBody campaign={campaign} groups={groups} targets={targets} negatives={negatives} canWrite={canWrite} />
    </>
  );
}

function CampaignBody({
  campaign,
  groups,
  targets,
  negatives,
  canWrite,
}: {
  campaign: AdsCampaignRaw | undefined;
  groups: AdsAdGroupRaw[];
  targets: AdsTargetRaw[];
  negatives: AdsNegativeKeywordRaw[];
  canWrite: boolean;
}) {
  const currency = campaign?.currency ?? groups[0]?.currency ?? "USD";
  const b = campaign ? budgetStateOf(campaign) : null;
  const type = campaign ? campaignTypeBadge(campaign.campaign_type) : null;
  const running = (campaign?.state ?? "").toUpperCase() === "ENABLED";

  return (
    <>
      {campaign ? (
        <Panel title="Campaign" hint="số 7 ngày · đọc từ vexim_ads_campaigns">
          <div className="flex flex-wrap items-center gap-3 text-[13px]">
            {type ? <span className="font-bold">{type.label}</span> : null}
            <Chip tone={(stateChip[(campaign.state ?? "").toUpperCase()] ?? { tone: "gray" as const }).tone}>
              {(stateChip[(campaign.state ?? "").toUpperCase()] ?? { label: campaign.state ?? "—" }).label}
            </Chip>
            {b ? <Chip tone={b.tone}>{b.label}</Chip> : null}
            <span className="text-soft">{b?.hint}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[13px]">
            <span>
              Ngân sách ngày: <b>{adsMoney(campaign.daily_budget, currency)}</b>
            </span>
            <span>
              Chi 7 ngày: <b>{adsMoney(campaign.spend_7d, currency)}</b>
            </span>
            <span>
              ACOS 7 ngày:{" "}
              <b className={isAcosOverTarget(campaign.acos_7d) ? "text-red" : ""}>{adsPct(campaign.acos_7d)}</b>
            </span>
            <span>
              ROAS 7 ngày: <b>{campaign.roas_7d === null ? "—" : `${Number(campaign.roas_7d).toFixed(2)}×`}</b>
            </span>
            <span>
              Đơn 7 ngày: <b>{adsNum(campaign.purchases_7d)}</b>
            </span>
          </div>
          {canWrite ? (
            <div className="mt-3 flex flex-wrap items-start gap-3">
              <ChangeForm
                sellerAccountId={campaign.seller_account_id}
                adsProfileId={campaign.ads_profile_id}
                action="set_budget"
                entityType="campaign"
                entityKey={campaign.campaign_id}
                label={campaign.name}
                valueLabel={`Ngân sách mới (${currency})`}
                defaultValue={campaign.daily_budget ?? ""}
                submitLabel="Đổi ngân sách"
                hint="Tăng > 30%/ngày ⇒ chờ trưởng phòng PPC duyệt (SOP-05 b4)"
              />
              <ChangeForm
                sellerAccountId={campaign.seller_account_id}
                adsProfileId={campaign.ads_profile_id}
                action="set_state"
                entityType="campaign"
                entityKey={campaign.campaign_id}
                label={campaign.name}
                fixedValue={running ? "PAUSED" : "ENABLED"}
                submitLabel={running ? "Tạm dừng campaign" : "Bật lại campaign"}
                danger={running}
                hint={running ? "Tạm dừng: tự chạy (chặn chi tiêu)" : "Bật lại từ dừng: cần trưởng phòng duyệt"}
              />
            </div>
          ) : null}
        </Panel>
      ) : (
        <Panel title="Không tìm thấy campaign này" hint={campaignIdHint(campaign, groups)}>
          <p className="text-[13px] text-soft">
            Chưa có campaign trong DB: chạy <code>npm run worker:ads-sync</code> để tải cấu trúc campaign/ad group/target
            từ Amazon, rồi mở lại.
          </p>
        </Panel>
      )}

      <Panel title="Ad group" hint={`${groups.length} nhóm · hiệu quả 7 ngày`}>
        {groups.length === 0 ? (
          <div className="rounded-[10px] border border-dashed border-line px-3 py-6 text-center text-[13px] text-soft">
            Chưa có ad group nào trong dữ liệu.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableCls.table}>
              <thead>
                <tr>
                  <th className={tableCls.th}>Ad group</th>
                  <th className={`${tableCls.th} text-right`}>Bid mặc định</th>
                  <th className={`${tableCls.th} text-right`}>Chi 7d</th>
                  <th className={`${tableCls.th} text-right`}>Click · CPC</th>
                  <th className={`${tableCls.th} text-right`}>Đơn · ACOS</th>
                  <th className={`${tableCls.th} text-right`}>Từ khoá</th>
                  <th className={tableCls.th}>Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const st = stateChip[(g.state ?? "").toUpperCase()] ?? { label: g.state ?? "—", tone: "gray" as const };
                  return (
                    <tr key={g.ad_group_id}>
                      <td className={tableCls.td}>
                        <div className="font-bold">{g.name}</div>
                        <div className="text-[11px] text-soft">{g.ad_group_id}</div>
                      </td>
                      <td className={tableCls.tdNum}>{adsMoney(g.default_bid, g.currency ?? currency)}</td>
                      <td className={tableCls.tdNum}>{adsMoney(g.spend_7d, g.currency ?? currency)}</td>
                      <td className={tableCls.tdNum}>
                        <div>{adsNum(g.clicks_7d)}</div>
                        <div className="text-[11px] text-soft">{adsMoney(g.cpc_7d, g.currency ?? currency)}</div>
                      </td>
                      <td className={tableCls.tdNum}>
                        <div>{adsNum(g.purchases_7d)}</div>
                        <div className={`text-[11px] ${isAcosOverTarget(g.acos_7d) ? "font-bold text-red" : "text-soft"}`}>
                          {adsPct(g.acos_7d)}
                        </div>
                      </td>
                      <td className={tableCls.tdNum}>
                        {adsNum(g.enabled_targets)}/{adsNum(g.target_count)}
                      </td>
                      <td className={tableCls.td}>
                        <Chip tone={st.tone}>{st.label}</Chip>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {groups.map((g) => {
        const rows = targets.filter((t) => t.ad_group_id === g.ad_group_id);
        return (
          <Panel
            key={g.ad_group_id}
            title={`Từ khoá &amp; nhóm sản phẩm — ${g.name}`}
            hint={`${rows.length} dòng · bid cao nhất lên đầu`}
          >
            <TargetsTable rows={rows} canWrite={canWrite} currency={g.currency ?? currency} />
          </Panel>
        );
      })}

      {targets.length > 0 && groups.length === 0 ? (
        <Panel title="Từ khoá &amp; nhóm sản phẩm" hint={`${targets.length} dòng`}>
          <TargetsTable rows={targets} canWrite={canWrite} currency={currency} />
        </Panel>
      ) : null}

      <Panel
        title="Negative keyword đã chặn (gương DB)"
        hint="nguồn: duyệt gợi ý A3 · nhập tay · đồng bộ từ API"
      >
        {negatives.length === 0 ? (
          <div className="rounded-[10px] border border-dashed border-line px-3 py-6 text-center text-[13px] text-soft">
            Campaign này chưa chặn từ khoá nào.
          </div>
        ) : (
          <table className={tableCls.table}>
            <thead>
              <tr>
                <th className={tableCls.th}>Từ khoá bị chặn</th>
                <th className={tableCls.th}>Kiểu chặn</th>
                <th className={tableCls.th}>Ad group</th>
                <th className={tableCls.th}>Nguồn</th>
              </tr>
            </thead>
            <tbody>
              {negatives.map((n) => (
                <tr key={n.id}>
                  <td className={`${tableCls.td} font-bold`}>{n.keyword_text}</td>
                  <td className={tableCls.td}>{matchTypeLabel(n.match_type)}</td>
                  <td className={tableCls.td}>{n.ad_group_name ?? n.ad_group_id ?? "—"}</td>
                  <td className={tableCls.td}>{n.source ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}

function campaignIdHint(campaign: AdsCampaignRaw | undefined, groups: AdsAdGroupRaw[]): string {
  if (campaign) return campaign.campaign_id;
  if (groups.length > 0) return groups[0].campaign_id;
  return "cần worker:ads-sync";
}
