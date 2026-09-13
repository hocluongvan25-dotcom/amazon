/**
 * Runner cho Module 5 phần 1 — MỘT chỗ dựng client + chọn shop cho cả hai job
 * Ads (đồng bộ cấu trúc và kéo report metrics).
 *
 * Vì sao gộp vào một file: hai job dùng CHUNG đúng một thứ đáng nhầm — cách dựng
 * `AdsClient` (LWA riêng của app Ads + host theo vùng) và cách chọn profile
 * (ads_profile_id + currency) cho từng shop. Tách làm hai file thì sớm muộn một
 * bên quên `Amazon-Advertising-API-Scope` hoặc lấy sai profile, và số liệu lệch
 * mà không ai biết vì sao.
 *
 * AN TOÀN DỮ LIỆU (giống run-report-pull.ts): DB thật CHỈ khi mode=production;
 * thiếu credential Ads → job trả `skipped` kèm hướng dẫn, KHÔNG làm đỏ dashboard.
 *
 *   /api/cron/report-pull  →  runAdsSyncAll() + runAdsPullAll() + runAdsApplyAll()
 *                             (cùng route, sau khi kéo report FBA — Hobby chỉ cho
 *                             2 cron/ngày). Phần GHI chạy CUỐI cùng vì nó phụ
 *                             thuộc cấu trúc vừa đồng bộ (ads_profile_id).
 */
import { loadConfig, type DataMode, type WorkerConfig } from "./config.ts";
import { AdsClient, AdsLwaTokenManager } from "./amazon/ads.ts";
import { MockDbAdapter, type ActiveShop, type DbAdapter } from "./db/adapter.ts";
import { SupabaseDbAdapter } from "./db/supabase.ts";
import { runAdsEntitySync, type AdsSyncResult, type AdsSyncShop } from "./jobs/ads-sync.job.ts";
import { runAdsReportPull, type AdsPullResult, type AdsPullShop } from "./jobs/ads-report-pull.job.ts";
import { runAdsApply, type AdsApplyResult, type AdsApplyShop } from "./jobs/ads-apply.job.ts";
import { runOauthReminder, type OauthReminderResult } from "./jobs/oauth-reminder.job.ts";
import { ADS_ALL_KINDS, type AdsReportKind } from "./ads/registry.ts";

const DEMO_SHOP: ActiveShop = {
  id: "00000000-0000-0000-0000-000000000001",
  sellerId: "DEMO-SELLER",
  marketplace: "ATVPDKIKX0DER",
  displayName: "DEMO · US",
  leadDays: 32,
  safetyDays: 14,
};

export type AdsRunContext = {
  mode: DataMode;
  db: "supabase" | "mock";
  apiConfigured: boolean;
  db_: DbAdapter;
  shops: AdsPullShop[];
};

/** Dùng chung cho cả 2 runner: chọn DB/shop + dựng client Ads. */
export async function adsRunContext(
  deps: {
    adapter?: DbAdapter;
    log?: (s: string) => void;
    sellerAccountId?: string | null;
    requireSingleShop?: boolean;
  } = {},
): Promise<AdsRunContext> {
  const log = deps.log ?? (() => {});
  const cfg = loadConfig();
  const allowRealDb = cfg.mode === "production" && cfg.supabase !== null;

  if (deps.adapter) {
    return { mode: cfg.mode, db: "mock", apiConfigured: false, db_: deps.adapter, shops: [DEMO_SHOP] };
  }

  if (allowRealDb && cfg.supabase) {
    const sb = new SupabaseDbAdapter(cfg.supabase.url, cfg.supabase.serviceRoleKey);
    try {
      const fromDb = await sb.listActiveProductionShops();
      if (fromDb.length === 0) {
        log("[ads] mode=production nhưng không có shop nào (status='active' AND data_source='production').\n");
        return { mode: cfg.mode, db: "supabase", apiConfigured: true, db_: sb, shops: [] };
      }
      let shops: ActiveShop[] = fromDb;
      if (deps.sellerAccountId) {
        shops = fromDb.filter((s) => s.id === deps.sellerAccountId);
        if (shops.length === 0) {
          log(`[ads] không thấy shop ${deps.sellerAccountId} trong danh sách production → không làm gì.\n`);
          return { mode: cfg.mode, db: "supabase", apiConfigured: true, db_: sb, shops: [] };
        }
      } else if (deps.requireSingleShop && fromDb.length > 1) {
        log(
          `[ads] có ${fromDb.length} shop production → PHẢI chỉ định --seller=<uuid>.\n` +
            fromDb.map((s) => `   ${s.displayName} = ${s.id}\n`).join(""),
        );
        return { mode: cfg.mode, db: "supabase", apiConfigured: true, db_: sb, shops: [] };
      }
      return {
        mode: cfg.mode,
        db: "supabase",
        apiConfigured: cfg.ads !== null,
        db_: sb,
        shops: shops.map((s) => ({ id: s.id, displayName: s.displayName, marketplace: s.marketplace })),
      };
    } catch (e) {
      log(
        `[ads] cảnh báo: không kết nối được DB (${(e as Error).message.split("\n")[0]}) — ` +
          `chuyển DEMO MODE, không ghi gì cả.\n`,
      );
      return { mode: cfg.mode, db: "mock", apiConfigured: false, db_: new MockDbAdapter(), shops: [DEMO_SHOP] };
    }
  }

  log(
    `[ads] mode=${cfg.mode} → chưa đủ credential SP-API/Supabase. Chạy demo trong bộ nhớ, KHÔNG ghi DB.\n`,
  );
  return { mode: cfg.mode, db: "mock", apiConfigured: false, db_: new MockDbAdapter(), shops: [DEMO_SHOP] };
}

export function adsClientFromConfig(cfg: WorkerConfig = loadConfig()): AdsClient | null {
  if (!cfg.ads) return null;
  return new AdsClient({
    host: cfg.adsHost,
    clientId: cfg.ads.clientId,
    lwa: new AdsLwaTokenManager({
      clientId: cfg.ads.clientId,
      clientSecret: cfg.ads.clientSecret,
      refreshToken: cfg.ads.refreshToken,
    }),
  });
}

/** Profile cho shop: ưu tiên khớp marketplace, không có thì lấy profile đầu tiên. */
export async function adsProfileForShop(
  db: DbAdapter,
  shop: AdsPullShop,
): Promise<{ adsProfileId: string | null; currency: string | null }> {
  try {
    const profiles = await db.listAdsProfiles(shop.id);
    if (profiles.length === 0) return { adsProfileId: null, currency: null };
    const match = profiles.find((p) => p.marketplace === shop.marketplace) ?? profiles[0];
    return { adsProfileId: match.adsProfileId, currency: match.currency };
  } catch {
    // Không đọc được profile ⇒ report vẫn nhập được (ads_profile_id NULL), chỉ
    // mất khả năng tách theo profile + tiền tệ. Ghi cảnh báo, không chặn job.
    return { adsProfileId: null, currency: null };
  }
}

export type AdsSyncRunResult = {
  mode: DataMode;
  db: "supabase" | "mock";
  apiConfigured: boolean;
  synced: number;
  skipped: number;
  failed: number;
  needsReauth: string[];
  shops: {
    shop: string;
    action: string;
    profiles: number;
    campaigns: string;
    adGroups: string;
    targets: string;
    message: string;
    errors: string[];
  }[];
  errors: { shopId: string; error: string }[];
};

export async function runAdsSyncAll(
  deps: {
    stdout?: { write: (s: string) => void };
    dryRun?: boolean;
    adapter?: DbAdapter;
    clientFor?: (shop: AdsSyncShop) => AdsClient | null;
    sellerAccountId?: string | null;
    requireSingleShop?: boolean;
  } = {},
): Promise<AdsSyncRunResult> {
  const log = (t: string) => deps.stdout?.write(t);
  const ctx = await adsRunContext({
    adapter: deps.adapter,
    log,
    sellerAccountId: deps.sellerAccountId,
    requireSingleShop: deps.requireSingleShop,
  });
  const cfg = loadConfig();
  const clientFor =
    deps.clientFor ??
    (cfg.ads && ctx.db === "supabase" ? () => adsClientFromConfig(cfg) : () => null);

  if (ctx.shops.length === 0) return emptySync(ctx.mode, ctx.db, ctx.apiConfigured);

  const result: AdsSyncResult = await runAdsEntitySync({
    db: ctx.db_,
    shops: ctx.shops,
    clientFor,
    dryRun: deps.dryRun === true,
    log,
  });

  const fmt = (c: { inserted: number; updated: number; skipped: number }) =>
    `${c.inserted} mới/${c.updated} cập nhật${c.skipped > 0 ? `/${c.skipped} bỏ` : ""}`;

  return {
    mode: ctx.mode,
    db: ctx.db,
    apiConfigured: ctx.apiConfigured,
    synced: result.synced,
    skipped: result.skipped,
    failed: result.failed,
    needsReauth: result.needsReauth,
    shops: result.results.map((r) => ({
      shop: r.shopName,
      action: r.action,
      profiles: r.profilesFound,
      campaigns: fmt(r.counts.campaigns),
      adGroups: fmt(r.counts.adGroups),
      targets: fmt(r.counts.targets),
      message: r.message,
      errors: r.errors,
    })),
    errors: result.errors,
  };
}

export type AdsPullRunResult = {
  mode: DataMode;
  db: "supabase" | "mock";
  apiConfigured: boolean;
  shopsProcessed: number;
  kindsRequested: AdsReportKind[];
  imported: number;
  pending: number;
  noData: number;
  throttled: number;
  failed: number;
  skipped: number;
  rowsImported: number;
  alertsFired: number;
  spendApplied: number;
  outcomes: {
    shop: string;
    kind: AdsReportKind;
    reportTypeId: string;
    action: string;
    status: string | null;
    reportId: string | null;
    period: string;
    rows: number;
    days: number;
    summary: string | null;
    message: string;
    alertsFired: number;
    spendApplied: number;
    needsReauth: boolean;
    warnings: string[];
  }[];
  errors: { shopId: string; kind: AdsReportKind; error: string }[];
};

export async function runAdsPullAll(
  deps: {
    kinds?: readonly AdsReportKind[];
    days?: number | null;
    dryRun?: boolean;
    now?: Date;
    stdout?: { write: (s: string) => void };
    texts?: Partial<Record<AdsReportKind, string>>;
    adapter?: DbAdapter;
    clientFor?: (shop: AdsPullShop) => AdsClient | null;
    pollAttempts?: number;
    pollDelayMs?: number;
    fireAlerts?: boolean;
    applySpend?: boolean;
    sellerAccountId?: string | null;
    requireSingleShop?: boolean;
  } = {},
): Promise<AdsPullRunResult> {
  const log = (t: string) => deps.stdout?.write(t);
  const ctx = await adsRunContext({
    adapter: deps.adapter,
    log,
    sellerAccountId: deps.sellerAccountId,
    requireSingleShop: deps.requireSingleShop,
  });
  const cfg = loadConfig();
  const kinds = (deps.kinds?.length ? deps.kinds : ADS_ALL_KINDS) as AdsReportKind[];
  const clientFor =
    deps.clientFor ??
    (cfg.ads && ctx.db === "supabase" ? () => adsClientFromConfig(cfg) : () => null);

  if (ctx.shops.length === 0) {
    return {
      mode: ctx.mode,
      db: ctx.db,
      apiConfigured: ctx.apiConfigured,
      shopsProcessed: 0,
      kindsRequested: kinds,
      imported: 0,
      pending: 0,
      noData: 0,
      throttled: 0,
      failed: 0,
      skipped: 0,
      rowsImported: 0,
      alertsFired: 0,
      spendApplied: 0,
      outcomes: [],
      errors: [],
    };
  }

  log(
    `[ads-pull] mode=${ctx.mode} host=${cfg.adsHost} · ${ctx.shops.length} shop · ` +
      `${kinds.length} loại report · ${deps.dryRun ? "DRY-RUN (không ghi DB)" : "ghi DB thật"}\n`,
  );

  const profiles = new Map<string, { adsProfileId: string | null; currency: string | null }>();
  for (const shop of ctx.shops) {
    profiles.set(shop.id, await adsProfileForShop(ctx.db_, shop));
    const p = profiles.get(shop.id);
    if (!p?.adsProfileId) {
      log(
        `[ads-pull] ⚠ ${shop.displayName}: chưa có profile Ads trong DB — chạy ` +
          `\`npm run worker:ads-sync\` trước để có ads_profile_id + tiền tệ.\n`,
      );
    }
  }

  const result: AdsPullResult = await runAdsReportPull({
    db: ctx.db_,
    shops: ctx.shops,
    kinds,
    days: deps.days ?? null,
    dryRun: deps.dryRun === true,
    now: deps.now,
    log,
    clientFor,
    texts: deps.texts,
    pollAttempts: deps.pollAttempts,
    pollDelayMs: deps.pollDelayMs,
    fireAlerts: deps.fireAlerts,
    applySpend: deps.applySpend,
    adsProfileFor: (shop) => profiles.get(shop.id) ?? null,
  });

  return {
    mode: ctx.mode,
    db: ctx.db,
    apiConfigured: ctx.apiConfigured,
    shopsProcessed: result.shopsProcessed,
    kindsRequested: kinds,
    imported: result.imported,
    pending: result.pending,
    noData: result.noData,
    throttled: result.throttled,
    failed: result.failed,
    skipped: result.skipped,
    rowsImported: result.rowsImported,
    alertsFired: result.alertsFired,
    spendApplied: result.spendApplied,
    outcomes: result.outcomes.map((o) => ({
      shop: o.shopName,
      kind: o.kind,
      reportTypeId: o.reportTypeId,
      action: o.action,
      status: o.status,
      reportId: o.reportId,
      period: o.period.start ? `${o.period.start} → ${o.period.end}` : "không khoảng ngày",
      rows: o.rows,
      days: o.days,
      summary: o.summary,
      message: o.message,
      alertsFired: o.alertsFired,
      spendApplied: o.spendApplied,
      needsReauth: o.needsReauth,
      warnings: o.warnings,
    })),
    errors: result.errors,
  };
}

function emptySync(mode: DataMode, db: "supabase" | "mock", apiConfigured: boolean): AdsSyncRunResult {
  return { mode, db, apiConfigured, synced: 0, skipped: 0, failed: 0, needsReauth: [], shops: [], errors: [] };
}


export type OauthReminderRunResult = {
  mode: DataMode;
  db: "supabase" | "mock";
  dryRun: boolean;
  checked: number;
  alertsCreated: number;
  marked: number;
  message: string;
  shops: {
    sellerAccountId: string;
    shop: string | null;
    expiresAt: string | null;
    daysLeft: number | null;
    needsReauth: boolean;
    alreadyNoticed: boolean;
    adsProfiles: number;
    tokenActive: boolean;
  }[];
};

/**
 * Cron hằng ngày: nhắc re-authorize shop sắp/đã hết hạn refresh token (SOP-11).
 * Dùng chung `adsRunContext` vì cùng luật an toàn dữ liệu (DB thật chỉ ở
 * mode=production, thiếu credential thì chạy mock và KHÔNG ghi gì).
 */
export async function runOauthReminderAll(
  deps: {
    days?: number | null;
    dryRun?: boolean;
    stdout?: { write: (s: string) => void };
    adapter?: DbAdapter;
  } = {},
): Promise<OauthReminderRunResult> {
  const log = (t: string) => deps.stdout?.write(t);
  const ctx = await adsRunContext({ adapter: deps.adapter, log });
  const result: OauthReminderResult = await runOauthReminder({
    db: ctx.db_,
    days: deps.days ?? null,
    dryRun: deps.dryRun === true,
    log,
  });
  const rows = [...result.expired, ...result.due, ...result.alreadyNoticed];
  return {
    mode: ctx.mode,
    db: ctx.db,
    dryRun: result.dryRun,
    checked: result.checked,
    alertsCreated: result.alertsCreated,
    marked: result.marked,
    message: result.message,
    shops: rows.map((r) => ({
      sellerAccountId: r.sellerAccountId,
      shop: r.shop,
      expiresAt: r.expiresAt,
      daysLeft: r.daysLeft,
      needsReauth: r.needsReauth,
      alreadyNoticed: r.alreadyNoticed,
      adsProfiles: r.adsProfiles,
      tokenActive: r.needsReauth || r.daysLeft !== null,
    })),
  };
}

export type AdsApplyRunResult = {
  mode: DataMode;
  db: "supabase" | "mock";
  apiConfigured: boolean;
  shopsProcessed: number;
  claimed: number;
  applied: number;
  failed: number;
  released: number;
  needsReauth: string[];
  shops: {
    shop: string;
    action: string;
    claimed: number;
    applied: number;
    failed: number;
    released: number;
    needsReauth: boolean;
    message: string;
    changes: AdsApplyResult["results"][number]["changes"];
    errors: string[];
  }[];
  errors: AdsApplyResult["errors"];
};

/**
 * ÁP DỤNG các yêu cầu đã duyệt (Module 5 phần 3).
 *
 * Chạy SAU ads:sync trong cùng cron vì yêu cầu cần `ads_profile_id` — thiếu
 * profile thì job từ chối ghi (không đoán marketplace: ghi sai là sai tiền).
 * Cùng luật an toàn dữ liệu như 2 job kia: DB thật chỉ khi mode=production.
 */
export async function runAdsApplyAll(
  deps: {
    limit?: number;
    dryRun?: boolean;
    stdout?: { write: (s: string) => void };
    adapter?: DbAdapter;
    clientFor?: (shop: AdsApplyShop) => AdsClient | null;
    maxAttempts?: number;
    sellerAccountId?: string | null;
    requireSingleShop?: boolean;
  } = {},
): Promise<AdsApplyRunResult> {
  const log = (t: string) => deps.stdout?.write(t);
  const ctx = await adsRunContext({
    adapter: deps.adapter,
    log,
    sellerAccountId: deps.sellerAccountId,
    requireSingleShop: deps.requireSingleShop,
  });
  const cfg = loadConfig();
  const clientFor =
    deps.clientFor ??
    (cfg.ads && ctx.db === "supabase" ? () => adsClientFromConfig(cfg) : () => null);

  if (ctx.shops.length === 0) {
    return {
      mode: ctx.mode,
      db: ctx.db,
      apiConfigured: ctx.apiConfigured,
      shopsProcessed: 0,
      claimed: 0,
      applied: 0,
      failed: 0,
      released: 0,
      needsReauth: [],
      shops: [],
      errors: [],
    };
  }

  log(`[ads-apply] mode=${ctx.mode} host=${cfg.adsHost} · ${ctx.shops.length} shop\n`);
  const result = await runAdsApply({
    db: ctx.db_,
    shops: ctx.shops.map((s) => ({ id: s.id, displayName: s.displayName })),
    clientFor,
    limit: deps.limit,
    dryRun: deps.dryRun === true,
    maxAttempts: deps.maxAttempts,
    log,
  });

  return {
    mode: ctx.mode,
    db: ctx.db,
    apiConfigured: ctx.apiConfigured,
    shopsProcessed: result.shopsProcessed,
    claimed: result.claimed,
    applied: result.applied,
    failed: result.failed,
    released: result.released,
    needsReauth: result.needsReauth,
    shops: result.results.map((r) => ({
      shop: r.shopName,
      action: r.action,
      claimed: r.claimed,
      applied: r.applied,
      failed: r.failed,
      released: r.released,
      needsReauth: r.needsReauth,
      message: r.message,
      changes: r.changes,
      errors: r.errors,
    })),
    errors: result.errors,
  };
}
