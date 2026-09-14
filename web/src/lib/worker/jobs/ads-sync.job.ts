/**
 * Job — ĐỒNG BỘ CẤU TRÚC quảng cáo (Module 5 phần 1).
 *
 *   GET /v2/profiles → POST /sp/campaigns/list → /sp/adGroups/list → /sp/keywords+targets/list
 *
 * Đây là "phần xương" của Module 5: metrics (ads-report-pull.job.ts) chỉ có nghĩa
 * khi campaign/ad group/target đã có mặt trong DB — nếu không, A1/A2 hiện ra
 * những campaign không tên và A3 không biết từ khoá nào đang đốt tiền.
 *
 * BA LUẬT:
 *   1. PROFILE LÀ GỐC: mỗi marketplace một profile Ads. Metrics/campaign luôn gắn
 *      `ads_profile_id` — trộn số của 2 profile là sai tiền tệ ngay từ gốc.
 *   2. SHOP 1 MARKETPLACE VẪN CÓ THỂ CÓ NHIỀU PROFILE (US + CA trong NA hợp
 *      nhất). Job ghi HẾT profile mà token nhìn thấy, không tự chọn hộ.
 *   3. LỖI TOKEN = RE-AUTHORIZE, KHÔNG PHẢI LỖI TẠM: 401/invalid_grant được báo
 *      riêng ở `needsReauth` để màn Kết nối shop hiện đúng việc phải làm
 *      (Module 0 · SOP-11), thay vì "sync lỗi" chung chung.
 *
 * KHÔNG ghi đè dữ liệu người dùng: job chỉ upsert theo khoá tự nhiên; campaign
 * `endDate` gửi kèm null nghĩa là "Amazon nói không còn hạn" (RPC 0020 hiểu đúng).
 */
import type {
  AdsAdGroupRowInput,
  AdsCampaignRowInput,
  AdsProfileRowInput,
  AdsTargetRowInput,
  AdsEntityCounts,
  DbAdapter,
} from "../db/adapter.ts";
import { AdsApiRequestError, type AdsClient } from "../amazon/ads.ts";

export type AdsSyncShop = {
  id: string;
  displayName: string;
  /** marketplace của shop (ATVPDKIKX0DER…) — dùng để ưu tiên đúng profile */
  marketplace: string;
};

export type AdsSyncCounts = {
  profiles: AdsEntityCounts;
  campaigns: AdsEntityCounts;
  adGroups: AdsEntityCounts;
  targets: AdsEntityCounts;
};

export type AdsSyncShopResult = {
  shopId: string;
  shopName: string;
  action: "synced" | "skipped" | "failed";
  profilesFound: number;
  profilesUsed: AdsProfileRowInput[];
  counts: AdsSyncCounts;
  /** true = token hết hạn/không đủ quyền ⇒ phải re-authorize ở Module 0 */
  needsReauth: boolean;
  message: string;
  errors: string[];
};

export type AdsSyncResult = {
  shopsProcessed: number;
  synced: number;
  skipped: number;
  failed: number;
  needsReauth: string[];
  results: AdsSyncShopResult[];
  errors: { shopId: string; error: string }[];
};

export type AdsSyncOptions = {
  db: DbAdapter;
  shops: AdsSyncShop[];
  /** null = chưa cấu hình credential Ads → job trả `skipped` kèm hướng dẫn */
  clientFor?: (shop: AdsSyncShop) => AdsClient | null;
  dryRun?: boolean;
  now?: Date;
  log?: (s: string) => void;
};

const ZERO: AdsEntityCounts = { inserted: 0, updated: 0, skipped: 0, merged: 0 };

const emptyCounts = (): AdsSyncCounts => ({
  profiles: { ...ZERO },
  campaigns: { ...ZERO },
  adGroups: { ...ZERO },
  targets: { ...ZERO },
});

export async function runAdsEntitySync(opts: AdsSyncOptions): Promise<AdsSyncResult> {
  const log = opts.log ?? (() => {});
  const dryRun = opts.dryRun === true;
  const results: AdsSyncShopResult[] = [];
  const errors: AdsSyncResult["errors"] = [];

  for (const shop of opts.shops) {
    const out: AdsSyncShopResult = {
      shopId: shop.id,
      shopName: shop.displayName,
      action: "skipped",
      profilesFound: 0,
      profilesUsed: [],
      counts: emptyCounts(),
      needsReauth: false,
      message: "",
      errors: [],
    };

    const client = opts.clientFor?.(shop) ?? null;
    if (!client) {
      out.message =
        "chưa cấu hình credential Amazon Ads (AMAZON_ADS_CLIENT_ID / _SECRET / _REFRESH_TOKEN) " +
        "nên không đồng bộ được campaign. Đây KHÔNG phải lỗi dữ liệu — A1 sẽ trống cho tới khi có token.";
      results.push(out);
      log(`[ads-sync] ··· ${shop.displayName}: ${out.message}\n`);
      continue;
    }

    try {
      const profiles = await client.getProfiles();
      out.profilesFound = profiles.length;
      const mapped: AdsProfileRowInput[] = profiles
        .filter((p) => p.profileId !== "")
        .map((p) => ({
          adsProfileId: p.profileId,
          // Nếu Amazon không trả marketplaceStringId thì lấy marketplace của shop
          // — KHÔNG bịa "NA": đó là vùng, không phải marketplace.
          marketplace: p.marketplaceId ?? shop.marketplace,
          currency: p.currency,
          countryCode: p.countryCode,
          accountType: p.accountType,
          managerAccountId: p.managerAccountId,
          source: "api",
        }));

      // Profile của shop: ưu tiên khớp marketplace, nhưng VẪN ghi hết (shop US+CA
      // có 2 profile và cả hai đều có campaign).
      const matched = mapped.filter((p) => p.marketplace === shop.marketplace);
      const used = matched.length > 0 ? matched : mapped;
      out.profilesUsed = used;

      if (used.length === 0) {
        out.message = "token Ads không nhìn thấy profile nào (kiểm tra lại quyền của app Ads).";
        out.action = "failed";
        out.errors.push(out.message);
        errors.push({ shopId: shop.id, error: out.message });
        results.push(out);
        log(`[ads-sync] LỖI ${shop.displayName}: ${out.message}\n`);
        continue;
      }

      if (matched.length === 0 && mapped.length > 0) {
        out.errors.push(
          `không có profile nào khớp marketplace của shop (${shop.marketplace}); ` +
            `vẫn đồng bộ ${mapped.length} profile để không mất dữ liệu`,
        );
      }

      if (dryRun) {
        out.action = "synced";
        out.message = `dry-run: thấy ${used.length} profile (${used.map((p) => p.adsProfileId).join(", ")}), KHÔNG ghi DB.`;
        results.push(out);
        log(`[ads-sync] OK  ${shop.displayName}: ${out.message}\n`);
        continue;
      }

      out.counts.profiles = await opts.db.upsertAdsProfiles(shop.id, used);

      for (const p of used) {
        const profileId = p.adsProfileId;
        const campaigns = await client.listCampaigns(profileId);
        const campaignRows: AdsCampaignRowInput[] = campaigns.map((c) => ({
          campaignId: c.campaignId,
          name: c.name ?? c.campaignId,
          adsProfileId: profileId,
          campaignType: c.campaignType ?? "SPONSORED_PRODUCTS",
          state: c.state,
          targetingType: c.targetingType,
          portfolioId: c.portfolioId,
          dailyBudget: c.dailyBudget,
          budgetCurrency: c.budgetCurrency ?? p.currency ?? null,
          budgetType: c.budgetType,
          biddingStrategy: c.biddingStrategy,
          startDate: c.startDate,
          endDate: c.endDate,
        }));
        out.counts.campaigns = addCounts(
          out.counts.campaigns,
          await opts.db.upsertAdsCampaigns(shop.id, campaignRows),
        );

        const adGroups = await client.listAdGroups(profileId);
        const adGroupRows: AdsAdGroupRowInput[] = adGroups.map((g) => ({
          adGroupId: g.adGroupId,
          campaignId: g.campaignId,
          name: g.name,
          state: g.state,
          defaultBid: g.defaultBid,
          adsProfileId: profileId,
          currency: p.currency ?? null,
        }));
        out.counts.adGroups = addCounts(
          out.counts.adGroups,
          await opts.db.upsertAdsAdGroups(shop.id, adGroupRows),
        );

        const targets = await client.listTargets(profileId);
        const targetRows: AdsTargetRowInput[] = targets.map((t) => ({
          targetKey: t.targetKey,
          targetKind: t.targetKind,
          campaignId: t.campaignId,
          adGroupId: t.adGroupId,
          keywordText: t.keywordText,
          matchType: t.matchType,
          expressionType: t.expressionType,
          expressionValue: t.expressionValue,
          bid: t.bid,
          state: t.state,
          adsProfileId: profileId,
        }));
        out.counts.targets = addCounts(
          out.counts.targets,
          await opts.db.upsertAdsTargets(shop.id, targetRows),
        );

        out.message =
          `profile ${profileId}: campaign ${fmt(out.counts.campaigns)} · ` +
          `ad group ${fmt(out.counts.adGroups)} · target ${fmt(out.counts.targets)}`;
        log(`[ads-sync] OK  ${shop.displayName} · ${out.message}\n`);
      }

      out.action = "synced";
      results.push(out);
    } catch (e) {
      const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
      const config = e instanceof AdsApiRequestError && e.isConfigError;
      const auth = !config && e instanceof AdsApiRequestError && e.isAuthError;
      out.action = "failed";
      out.needsReauth = auth;
      out.message = config
        ? `credential Ads trên env SAI (${msg}) ⇒ kiểm tra AMAZON_ADS_CLIENT_ID / _SECRET / _REFRESH_TOKEN — 3 biến phải cùng một Security Profile đã được duyệt Ads API.`
        : auth
          ? `token Ads không dùng được (${msg}) ⇒ PHẢI re-authorize ở Module 0 → Kết nối shop (SOP-11).`
          : `đồng bộ cấu trúc Ads thất bại: ${msg}`;
      out.errors.push(msg);
      errors.push({ shopId: shop.id, error: msg });
      results.push(out);
      log(`[ads-sync] ${auth ? "REAUTH" : "LỖI"} ${shop.displayName}: ${out.message}\n`);
    }
  }

  return {
    shopsProcessed: results.length,
    synced: results.filter((r) => r.action === "synced").length,
    skipped: results.filter((r) => r.action === "skipped").length,
    failed: results.filter((r) => r.action === "failed").length,
    needsReauth: results.filter((r) => r.needsReauth).map((r) => r.shopId),
    results,
    errors,
  };
}

function addCounts(a: AdsEntityCounts, b: AdsEntityCounts): AdsEntityCounts {
  return {
    inserted: a.inserted + b.inserted,
    updated: a.updated + b.updated,
    skipped: a.skipped + b.skipped,
    merged: a.merged + b.merged,
  };
}

function fmt(c: AdsEntityCounts): string {
  return `${c.inserted} mới/${c.updated} cập nhật${c.skipped > 0 ? `/${c.skipped} bỏ` : ""}`;
}
