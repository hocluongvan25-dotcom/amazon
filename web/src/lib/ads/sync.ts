/**
 * runAdsSync — đồng bộ Amazon Ads API → Supabase (Module 5, phần đọc).
 *
 * Thứ tự MỖI lần chạy (cron /api/cron/ads-sync):
 *
 *   PHA 1 · POLL   vexim_worker_pending_ads_reports → GET /reporting/reports/{id}
 *                  COMPLETED → tải file gzip → parse → RPC upsert → status 'imported'
 *                  PENDING/PROCESSING → status 'processing', để lần sau poll tiếp
 *                  FAILED/EXPIRED → status 'failed' kèm lý do
 *   PHA 2 · REQUEST GET /v2/profiles (chọn profileId) → POST /sp/campaigns/list
 *                  → POST /reporting/reports cho 4 loại (spCampaigns, spAdvertisedProduct,
 *                    spSearchTerm, spTargeting) → ghi reportId vào ads.report_requests
 *   PHA 3 · ALERT  vexim_ads_raise_alerts (ACOS vượt ngưỡng, ngân sách cạn, sync cũ)
 *   PHA 4 · F4     vexim_worker_fill_profit_ads_spend (ads_spend vào lãi theo SKU)
 *
 * Vì sao POLL trước REQUEST: report xin hôm qua thường đã xong vào sáng nay — nhập
 * cái đã có trước, rồi mới xin lô mới. Cũng nhờ vậy cron KHÔNG BAO GIỜ ngồi chờ
 * Amazon (report có thể chạy tới 3 giờ): chưa xong thì ghi trạng thái và thoát.
 *
 * Ba luật dữ liệu (giống job report-pull của SP-API):
 *   • Report RỖNG không phải lỗi → status 'no_data' (SP mới chạy, chưa có click).
 *   • 429 → status 'throttled', bỏ qua, KHÔNG retry dồn trong cùng lượt.
 *   • 425 → đã có report y hệt đang chạy → giữ cái cũ, poll tiếp.
 */
import { AdsClient } from "./client.ts";
import { loadAdsConfig, type AdsRuntimeConfig } from "./config.ts";
import { createAdsDb, type AdsDb, type PendingAdsReport, type UpsertCounts } from "./db.ts";
import { AdsApiError, AdsTokenError, type AdsErrorCode } from "./errors.ts";
import {
  normalizeProfiles,
  pickProfile,
  toProfileRpcRows,
  type AdsProfile,
} from "./profiles.ts";
import {
  ADS_REPORT_KINDS,
  classifyReportStatus,
  clampWindowToRetention,
  createReportWithColumnFallback,
  decorateRows,
  downloadReportRows,
  getReport,
  reportSpec,
  reportWindow,
  type AdsReportKind,
  type ReportRange,
  type ReportSpec,
} from "./reports.ts";
import { AdsTokenManager, type AdsAccessToken } from "./tokens.ts";

export type AdsSyncAction =
  | "profiles"
  | "campaigns"
  | "created"
  | "polled"
  | "imported"
  | "no_data"
  | "duplicate"
  | "throttled"
  | "failed"
  | "skipped"
  | "alerts"
  | "profit";

export type AdsSyncStep = {
  shopId: string;
  shopName: string;
  kind: AdsReportKind | "profiles" | "campaigns" | "alerts" | "profit" | "token";
  action: AdsSyncAction;
  reportTypeId?: string;
  range?: ReportRange | null;
  reportId?: string | null;
  rows?: number;
  counts?: UpsertCounts | null;
  message: string;
};

export type AdsSyncShopResult = {
  shopId: string;
  shopName: string;
  marketplace: string | null;
  tokenSource: "db" | "env" | null;
  profileId: string | null;
  profileReason: string;
  steps: AdsSyncStep[];
  imported: number;
  rowsImported: number;
  pending: number;
  throttled: number;
  failed: number;
  alerts: number;
  profitRows: number;
  warnings: string[];
  error: string | null;
};

export type AdsSyncOptions = {
  config?: AdsRuntimeConfig;
  /** null = dry-run: gọi Amazon + parse nhưng KHÔNG ghi DB. */
  db?: AdsDb | null;
  fetchFn?: typeof fetch;
  shops?: string[];
  kinds?: AdsReportKind[];
  days?: number;
  endDate?: string | null;
  /** all = poll rồi request · poll = chỉ nhập report đã xong · request = chỉ xin report mới. */
  phase?: "all" | "poll" | "request";
  /** Poll thêm vài lần ngay sau khi xin report (cron: 2 lần × 5s; CLI: nhiều hơn). */
  pollAttempts?: number;
  pollDelayMs?: number;
  raiseAlerts?: boolean;
  fillProfit?: boolean;
  dryRun?: boolean;
  maxShops?: number;
  stdout?: { write: (s: string) => unknown };
  now?: () => Date;
};

export type AdsSyncResult = {
  ready: boolean;
  db: "supabase" | "none";
  phase: "all" | "poll" | "request";
  region: string;
  host: string;
  dryRun: boolean;
  shopsProcessed: number;
  counts: Record<AdsSyncAction, number>;
  rowsImported: number;
  alerts: number;
  profitRows: number;
  outcomes: AdsSyncShopResult[];
  warnings: string[];
  errors: string[];
  problems: string[];
};

/** reportTypeId → loại report nội bộ (pending rows chỉ lưu reportTypeId). */
export function kindForReportTypeId(reportTypeId: string): AdsReportKind | null {
  const map: Record<string, AdsReportKind> = {
    spCampaigns: "campaigns",
    spAdvertisedProduct: "advertised",
    spSearchTerm: "searchTerms",
    spTargeting: "targeting",
  };
  return map[reportTypeId] ?? null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function countsText(c: UpsertCounts | null | undefined): string {
  if (!c) return "";
  const parts = [
    c.inserted ? `inserted ${c.inserted}` : "",
    c.updated ? `updated ${c.updated}` : "",
    c.rowsWritten ? `rows ${c.rowsWritten}` : "",
    c.merged ? `merged ${c.merged}` : "",
    c.skipped ? `RÁC ${c.skipped}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/**
 * Ước lượng % ngân sách đã tiêu từ report spCampaigns (cost / campaignBudgetAmount).
 *
 * NÓI RÕ: đây là số LIỆU NGÀY (không phải real-time). Amazon chỉ có endpoint budget
 * usage cho Sponsored Brands (`POST /sb/campaigns/budget/usage`, 207 multi-status);
 * Sponsored Products chưa có. Nên ta tính từ report và đánh dấu `source` để UI/không
 * ai tưởng đây là số đo trong ngày.
 */
export function budgetRowsFromCampaignRows(
  rows: Record<string, unknown>[],
  ctx: { profileId: string; capturedAt: string; source?: string },
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    const budgetRaw = r.campaignBudgetAmount ?? r.campaignBudget ?? r.budgetAmount;
    const budget = Number(budgetRaw);
    const cost = Number(r.cost);
    if (!Number.isFinite(budget) || budget <= 0 || !Number.isFinite(cost)) continue;
    const day = String(r.date ?? r.day ?? "").slice(0, 10);
    if (!day) continue;
    out.push({
      ...r,
      adsProfileId: ctx.profileId,
      campaignId: r.campaignId,
      campaignName: r.campaignName ?? null,
      day,
      budget,
      spend: cost,
      percentageUsed: Number(((cost / budget) * 100).toFixed(2)),
      budgetUsagePercent: Number((cost / budget).toFixed(4)),
      capturedAt: ctx.capturedAt,
      currencyCode: r.campaignBudgetCurrencyCode ?? r.currencyCode ?? null,
      source: ctx.source ?? "sp_campaigns_report_estimate",
    });
  }
  return out;
}

export async function runAdsSync(opts: AdsSyncOptions = {}): Promise<AdsSyncResult> {
  const config = opts.config ?? loadAdsConfig();
  const now = opts.now ?? (() => new Date());
  const dryRun = opts.dryRun === true || opts.db === null || opts.db === undefined;
  const db: AdsDb | null = dryRun ? null : (opts.db ?? null);
  const fetchFn = opts.fetchFn ?? fetch;
  const phase = opts.phase ?? "all";
  const kinds = (opts.kinds ?? [...ADS_REPORT_KINDS]).filter((k) => (ADS_REPORT_KINDS as readonly string[]).includes(k));
  const log = (s: string) => opts.stdout?.write(s);
  const counts: Record<AdsSyncAction, number> = {
    profiles: 0,
    campaigns: 0,
    created: 0,
    polled: 0,
    imported: 0,
    no_data: 0,
    duplicate: 0,
    throttled: 0,
    failed: 0,
    skipped: 0,
    alerts: 0,
    profit: 0,
  };
  const warnings: string[] = [];
  const errors: string[] = [];
  const outcomes: AdsSyncShopResult[] = [];

  const result: AdsSyncResult = {
    ready: config.ready,
    db: db ? "supabase" : "none",
    phase,
    region: config.region,
    host: config.host,
    dryRun,
    shopsProcessed: 0,
    counts,
    rowsImported: 0,
    alerts: 0,
    profitRows: 0,
    outcomes,
    warnings,
    errors,
    problems: config.problems,
  };

  if (!config.clientId || !config.clientSecret) {
    errors.push(
      "Chưa có AMAZON_ADS_CLIENT_ID/SECRET → không gọi được Ads API. " +
        "Lấy ở advertising.amazon.com → Developer Console → Security profile (loại Web app).",
    );
    log?.(`[ads-sync] DỪNG: ${errors[0]}\n`);
    return result;
  }

  const tokenManager = new AdsTokenManager(
    {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      region: config.region,
      tokenKey: config.tokenKey,
      envRefreshToken: config.envRefreshToken,
    },
    { store: db, fetchFn, now },
  );

  // ---- Danh sách shop -------------------------------------------------------
  let shops: { id: string; displayName: string; marketplace: string | null }[] = [];
  if (db) {
    try {
      const all = await db.listShops();
      shops = all
        .filter((s) => (opts.shops && opts.shops.length > 0 ? opts.shops.includes(s.id) : true))
        .slice(0, opts.maxShops ?? 50)
        .map((s) => ({ id: s.id, displayName: s.displayName, marketplace: s.marketplace }));
    } catch (e) {
      errors.push(`Không đọc được danh sách shop: ${(e as Error).message}`);
      log?.(`[ads-sync] DỪNG: ${errors[0]}\n`);
      return result;
    }
  } else if (opts.shops && opts.shops.length > 0) {
    // dry-run không đọc DB được → chỉ chạy cho những shop được nêu đích danh
    shops = opts.shops.map((id) => ({ id, displayName: id.slice(0, 8), marketplace: null }));
    warnings.push("dry-run: không đọc được danh sách shop từ DB — chỉ chạy cho shop truyền vào.");
  } else {
    warnings.push("dry-run: không có db nên không biết shop nào để chạy (truyền --shop=<uuid> nếu muốn thử).");
  }

  log?.(
    `[ads-sync] host=${config.host} region=${config.region} · ${shops.length} shop · ` +
      `phase=${phase} · kinds=${kinds.join(",")} · days=${opts.days ?? config.reportDays} · dryRun=${dryRun}\n`,
  );

  const clientFor = (token: AdsAccessToken) =>
    new AdsClient({
      host: config.host,
      clientId: token.clientId,
      accountId: config.accountId,
      getAccessToken: async () => token.accessToken,
      fetchFn,
    });

  /* ======================================================================= */
  /* PHA 1 — POLL các report đang chờ                                        */
  /* ======================================================================= */
  const pollOne = async (
    shopId: string,
    shopName: string,
    client: AdsClient,
    pending: PendingAdsReport,
    out: AdsSyncShopResult,
  ): Promise<void> => {
    const kind = kindForReportTypeId(pending.reportTypeId);
    if (!kind) {
      out.steps.push({
        shopId,
        shopName,
        kind: "token",
        action: "skipped",
        reportTypeId: pending.reportTypeId,
        message: `reportTypeId '${pending.reportTypeId}' không nằm trong bộ Module 5 — bỏ qua.`,
      });
      counts.skipped += 1;
      return;
    }
    const spec = reportSpec(kind, { attributionDays: config.attributionDays });
    const range: ReportRange = {
      startDate: (pending.dateStart ?? "").slice(0, 10),
      endDate: (pending.dateEnd ?? "").slice(0, 10),
    };

    let ticket;
    try {
      ticket = await getReport(client, pending.adsReportId);
    } catch (e) {
      const err = e as AdsApiError;
      const retryable = err instanceof AdsApiError ? err.retryable : false;
      out.steps.push({
        shopId,
        shopName,
        kind,
        action: retryable ? "throttled" : "failed",
        reportTypeId: pending.reportTypeId,
        range,
        reportId: pending.adsReportId,
        message: err.message + (err.hint ? ` → ${err.hint}` : ""),
      });
      if (retryable) counts.throttled += 1;
      else {
        counts.failed += 1;
        // reportId chết (EXPIRED/404) → xoá để lần sau xin lại
        if (db && (err.code === "not_found" || /expired/i.test(err.message))) {
          await db
            .setReportRequest(shopId, {
              reportTypeId: pending.reportTypeId,
              adsProfileId: pending.adsProfileId,
              adProduct: pending.adProduct ?? undefined,
              groupBy: pending.groupBy ?? undefined,
              timeUnit: (pending.timeUnit as "DAILY" | "SUMMARY") ?? "DAILY",
              dateStart: range.startDate,
              dateEnd: range.endDate,
              status: "failed",
              lastError: err.message.slice(0, 400),
              failureReason: err.code,
            })
            .catch(() => null);
        }
      }
      return;
    }

    const state = classifyReportStatus(ticket.status);

    if (state === "pending") {
      const attempts = pending.attempts + 1;
      // Report Ads tối đa 3 giờ; cron chạy ngày 1 lần nên 3 lượt = 3 ngày là quá đủ.
      const gaveUp = attempts > 3;
      out.steps.push({
        shopId,
        shopName,
        kind,
        action: gaveUp ? "failed" : "polled",
        reportTypeId: pending.reportTypeId,
        range,
        reportId: ticket.reportId,
        message: gaveUp
          ? `Amazon vẫn chưa xong sau ${attempts} lần poll (status ${ticket.status}) → đánh dấu failed để xin report mới.`
          : `Amazon đang tạo report (status ${ticket.status}, lần poll ${attempts}) — lần chạy sau poll tiếp.`,
      });
      if (gaveUp) counts.failed += 1;
      else counts.polled += 1;
      if (db) {
        await db
          .setReportRequest(shopId, {
            reportTypeId: pending.reportTypeId,
            adsProfileId: pending.adsProfileId,
            adProduct: pending.adProduct ?? undefined,
            groupBy: pending.groupBy ?? undefined,
            timeUnit: (pending.timeUnit as "DAILY" | "SUMMARY") ?? "DAILY",
            dateStart: range.startDate,
            dateEnd: range.endDate,
            adsReportId: ticket.reportId ?? pending.adsReportId,
            status: gaveUp ? "failed" : "processing",
            lastError: gaveUp ? `still ${ticket.status} after ${attempts} polls` : null,
          })
          .catch(() => null);
      }
      return;
    }

    if (state === "failed") {
      out.steps.push({
        shopId,
        shopName,
        kind,
        action: "failed",
        reportTypeId: pending.reportTypeId,
        range,
        reportId: ticket.reportId,
        message: `Amazon báo hỏng report (${ticket.status}): ${ticket.failureReason ?? "không rõ lý do"}.`,
      });
      counts.failed += 1;
      if (db) {
        await db
          .setReportRequest(shopId, {
            reportTypeId: pending.reportTypeId,
            adsProfileId: pending.adsProfileId,
            adProduct: pending.adProduct ?? undefined,
            groupBy: pending.groupBy ?? undefined,
            timeUnit: (pending.timeUnit as "DAILY" | "SUMMARY") ?? "DAILY",
            dateStart: range.startDate,
            dateEnd: range.endDate,
            adsReportId: ticket.reportId ?? pending.adsReportId,
            status: "failed",
            failureReason: ticket.failureReason,
            completedAt: now().toISOString(),
          })
          .catch(() => null);
      }
      return;
    }

    if (!ticket.url) {
      out.steps.push({
        shopId,
        shopName,
        kind,
        action: "polled",
        reportTypeId: pending.reportTypeId,
        range,
        reportId: ticket.reportId,
        message: `status=${ticket.status} nhưng Amazon chưa trả url tải file — lần sau poll lại.`,
      });
      counts.polled += 1;
      return;
    }

    // ---- COMPLETED: tải + parse + ghi --------------------------------------
    try {
      const downloaded = await downloadReportRows({ url: ticket.url }, { fetchFn });
      const rows = decorateRows(downloaded.rows, {
        profileId: pending.adsProfileId ?? client.profileId ?? "",
        reportId: ticket.reportId,
        currency: null,
        source: "ads_reporting_v3",
      });
      const countsOut = await writeRows(db, shopId, kind, spec, rows);

      if (rows.length === 0) {
        out.steps.push({
          shopId,
          shopName,
          kind,
          action: "no_data",
          reportTypeId: pending.reportTypeId,
          range,
          reportId: ticket.reportId,
          rows: 0,
          message:
            "Report xong nhưng RỖNG — không phải lỗi (campaign mới chạy/chưa có click). " +
            "Đánh dấu no_data để lần sau không tưởng là chưa kéo.",
        });
        counts.no_data += 1;
      } else {
        out.steps.push({
          shopId,
          shopName,
          kind,
          action: "imported",
          reportTypeId: pending.reportTypeId,
          range,
          reportId: ticket.reportId,
          rows: rows.length,
          counts: countsOut,
          message: `nhập ${rows.length} dòng ${pending.reportTypeId}${countsText(countsOut)} · tải ${downloaded.bytes}B qua ${downloaded.via}.`,
        });
        counts.imported += 1;
        out.imported += 1;
        out.rowsImported += rows.length;
        result.rowsImported += rows.length;
      }
      if (countsOut && countsOut.skipped > 0) {
        out.warnings.push(
          `${pending.reportTypeId}: RPC loại ${countsOut.skipped} dòng RÁC (thiếu khoá/thiếu ngày) — xem lại cột Amazon trả.`,
        );
      }

      if (db) {
        await db
          .setReportRequest(shopId, {
            reportTypeId: pending.reportTypeId,
            adsProfileId: pending.adsProfileId,
            adProduct: pending.adProduct ?? undefined,
            groupBy: pending.groupBy ?? undefined,
            timeUnit: (pending.timeUnit as "DAILY" | "SUMMARY") ?? "DAILY",
            dateStart: range.startDate,
            dateEnd: range.endDate,
            adsReportId: ticket.reportId ?? pending.adsReportId,
            status: rows.length === 0 ? "no_data" : "imported",
            rowsImported: rows.length,
            downloadUrl: ticket.url,
            completedAt: now().toISOString(),
            importedAt: now().toISOString(),
          })
          .catch(() => null);
      }
    } catch (e) {
      const err = e as Error;
      out.steps.push({
        shopId,
        shopName,
        kind,
        action: "failed",
        reportTypeId: pending.reportTypeId,
        range,
        reportId: ticket.reportId,
        message: `Tải/nhập report thất bại: ${err.message}`,
      });
      counts.failed += 1;
      if (db) {
        await db
          .setReportRequest(shopId, {
            reportTypeId: pending.reportTypeId,
            adsProfileId: pending.adsProfileId,
            adProduct: pending.adProduct ?? undefined,
            groupBy: pending.groupBy ?? undefined,
            timeUnit: (pending.timeUnit as "DAILY" | "SUMMARY") ?? "DAILY",
            dateStart: range.startDate,
            dateEnd: range.endDate,
            adsReportId: ticket.reportId ?? pending.adsReportId,
            status: "failed",
            lastError: err.message.slice(0, 400),
          })
          .catch(() => null);
      }
    }
  };

  /** Ghi rows đúng RPC của loại report; campaigns thì kèm ước lượng budget. */
  async function writeRows(
    target: AdsDb | null,
    shopId: string,
    kind: AdsReportKind,
    spec: ReportSpec,
    rows: Record<string, unknown>[],
  ): Promise<UpsertCounts | null> {
    if (!target || rows.length === 0) return null;
    switch (kind) {
      case "campaigns": {
        const c = await target.upsertMetrics(shopId, rows);
        // Ước lượng ngân sách từ chính lô này (không tốn thêm call Amazon).
        const budgetRows = budgetRowsFromCampaignRows(rows, {
          profileId: String(rows[0]?.adsProfileId ?? ""),
          capturedAt: now().toISOString(),
        });
        if (budgetRows.length > 0) {
          const b = await target.upsertBudgetUsage(shopId, budgetRows);
          warnings.push(
            `${shopId.slice(0, 8)}… ${spec.reportTypeId}: ghi ${budgetRows.length} dòng budget_usage ƯỚC LƯỢNG ` +
              `từ cost/campaignBudgetAmount (source=sp_campaigns_report_estimate) — không phải số real-time trong ngày.`,
          );
          if (b.rowsWritten + b.inserted > 0) counts.imported += 0; // chỉ ghi log, không đếm 2 lần
        }
        return c;
      }
      case "advertised":
        return target.upsertAdvertised(shopId, rows);
      case "searchTerms":
        return target.upsertSearchTerms(shopId, rows);
      case "targeting":
        return target.upsertTargeting(shopId, rows);
    }
  }

  if (phase !== "request" && db) {
    let pending: PendingAdsReport[] = [];
    try {
      pending = await db.pendingReports({ limit: 100 });
    } catch (e) {
      errors.push(`Không đọc được report đang chờ: ${(e as Error).message}`);
    }
    if (pending.length > 0) {
      log?.(`[ads-sync] POLL ${pending.length} report đang chờ…\n`);
      const byShop = new Map<string, PendingAdsReport[]>();
      for (const p of pending) {
        const list = byShop.get(p.sellerAccountId) ?? [];
        list.push(p);
        byShop.set(p.sellerAccountId, list);
      }
      const shopInfo = new Map(shops.map((s) => [s.id, s]));
      for (const [shopId, list] of byShop) {
        const name = shopInfo.get(shopId)?.displayName ?? shopId.slice(0, 8);
        const out = newShopResult(shopId, name, shopInfo.get(shopId)?.marketplace ?? null);
        outcomes.push(out);
        try {
          const token = await tokenManager.accessToken(shopId);
          out.tokenSource = token.source;
          const client = clientFor(token);
          for (const p of list) {
            await pollOne(shopId, name, client.withProfile(p.adsProfileId ?? ""), p, out);
          }
        } catch (e) {
          failShop(out, e, counts);
        }
        flushShop(out, log);
      }
    }
  }

  /* ======================================================================= */
  /* PHA 2 — REQUEST: profiles + campaigns + 4 report                        */
  /* ======================================================================= */
  if (phase !== "poll") {
    for (const shop of shops) {
      const out = newShopResult(shop.id, shop.displayName, shop.marketplace);
      outcomes.push(out);
      result.shopsProcessed += 1;

      let token: AdsAccessToken;
      try {
        token = await tokenManager.accessToken(shop.id);
        out.tokenSource = token.source;
      } catch (e) {
        failShop(out, e, counts);
        if (db && e instanceof AdsTokenError) {
          await db.recordEvent({
            sellerAccountId: shop.id,
            service: "ads",
            event: e.code === "no_token" ? "ads_sync_no_token" : "ads_sync_token_failed",
            status: "error",
            detail: `${e.code}: ${e.message}${e.hint ? ` → ${e.hint}` : ""}`.slice(0, 500),
          });
        }
        flushShop(out, log);
        continue;
      }

      const client = clientFor(token);

      // ---- profiles: bắt buộc, vì mọi call khác cần profileId ---------------
      let profiles: AdsProfile[] = [];
      let profileId: string | null = null;
      try {
        const raw = await client.listProfiles();
        profiles = normalizeProfiles(raw);
        const decision = pickProfile(profiles, {
          profileId: token.adsAccountId ?? null,
          marketplaceId: shop.marketplace,
          countryCode: config.countryCodeHint,
          accountType: config.profileTypeHint,
        });
        out.profileReason = decision.reason;
        out.warnings.push(...decision.warnings);
        profileId = decision.profile?.profileId ?? null;
        out.profileId = profileId;

        if (db) {
          const c = await db.upsertProfiles(shop.id, toProfileRpcRows(profiles, { pickedProfileId: profileId }));
          out.steps.push({
            shopId: shop.id,
            shopName: shop.displayName,
            kind: "profiles",
            action: "profiles",
            rows: profiles.length,
            counts: c,
            message: `${profiles.length} profile${countsText(c)} · chọn ${profileId ?? "KHÔNG CHỌN ĐƯỢC"} — ${decision.reason}`,
          });
          counts.profiles += 1;
        }

        if (!profileId) {
          out.steps.push({
            shopId: shop.id,
            shopName: shop.displayName,
            kind: "profiles",
            action: "skipped",
            message: `Không chốt được profileId → bỏ qua campaign/report của shop này. ${decision.reason}`,
          });
          counts.skipped += 1;
          out.error = decision.reason;
          flushShop(out, log);
          continue;
        }
      } catch (e) {
        failShop(out, e, counts, "Không lấy được /v2/profiles");
        flushShop(out, log);
        continue;
      }

      const scoped = client.withProfile(profileId);

      // ---- campaigns (metadata: ngân sách, trạng thái, ngày) ----------------
      try {
        const page = await scoped.listAllSpCampaigns({ maxPages: 10 });
        if (page.truncated) {
          out.warnings.push(
            `Shop ${shop.displayName}: campaign nhiều hơn 10 trang → mới lấy ${page.campaigns.length}. ` +
              `Tăng maxPages nếu tài khoản lớn.`,
          );
        }
        if (db && page.campaigns.length > 0) {
          const rows = page.campaigns.map((c) => ({ ...c, adsProfileId: profileId, source: "sp_campaigns_list" }));
          const c = await db.upsertCampaigns(shop.id, rows);
          out.steps.push({
            shopId: shop.id,
            shopName: shop.displayName,
            kind: "campaigns",
            action: "campaigns",
            rows: rows.length,
            counts: c,
            message: `${rows.length} campaign${countsText(c)} (${page.pages} trang).`,
          });
          counts.campaigns += 1;
        } else {
          out.steps.push({
            shopId: shop.id,
            shopName: shop.displayName,
            kind: "campaigns",
            action: page.campaigns.length === 0 ? "no_data" : "skipped",
            rows: page.campaigns.length,
            message:
              page.campaigns.length === 0
                ? "Tài khoản chưa có campaign SP nào (không phải lỗi)."
                : "dry-run: không ghi ads.campaigns.",
          });
          if (page.campaigns.length === 0) counts.no_data += 1;
          else counts.skipped += 1;
        }
      } catch (e) {
        const err = e as AdsApiError;
        out.steps.push({
          shopId: shop.id,
          shopName: shop.displayName,
          kind: "campaigns",
          action: err instanceof AdsApiError && err.retryable ? "throttled" : "failed",
          message: `Không lấy được danh sách campaign: ${err.message}${err.hint ? ` → ${err.hint}` : ""}`,
        });
        if (err instanceof AdsApiError && err.retryable) counts.throttled += 1;
        else counts.failed += 1;
      }

      // ---- reports ---------------------------------------------------------
      for (const kind of kinds) {
        const spec = reportSpec(kind, { attributionDays: config.attributionDays });
        const range = clampWindowToRetention(
          reportWindow({ days: opts.days ?? config.reportDays, endDate: opts.endDate ?? null, now: now(), spec }),
          spec,
          now(),
        );

        if (db) {
          // Ghi Ý ĐỊNH trước khi gọi Amazon: nếu call chết giữa chừng, lần sau vẫn biết
          // khoảng ngày này chưa có dữ liệu (thay vì im lặng bỏ trống).
          await db
            .setReportRequest(shop.id, {
              reportTypeId: spec.reportTypeId,
              adsProfileId: profileId,
              adProduct: spec.adProduct,
              groupBy: spec.groupByKey,
              timeUnit: spec.timeUnit,
              dateStart: range.startDate,
              dateEnd: range.endDate,
              status: "requested",
              requestedAt: now().toISOString(),
            })
            .catch(() => null);
        }

        try {
          const created = await createReportWithColumnFallback(scoped, spec, range);
          out.warnings.push(...created.warnings);
          const ticket = created.ticket;
          out.steps.push({
            shopId: shop.id,
            shopName: shop.displayName,
            kind,
            action: "created",
            reportTypeId: spec.reportTypeId,
            range,
            reportId: ticket.reportId,
            message:
              `xin report ${spec.reportTypeId} ${range.startDate}→${range.endDate} ` +
              `(${created.usedColumns.length} cột) → ${ticket.reportId} · status ${ticket.status}`,
          });
          counts.created += 1;

          if (db) {
            await db
              .setReportRequest(shop.id, {
                reportTypeId: spec.reportTypeId,
                adsProfileId: profileId,
                adProduct: spec.adProduct,
                groupBy: spec.groupByKey,
                timeUnit: spec.timeUnit,
                dateStart: range.startDate,
                dateEnd: range.endDate,
                adsReportId: ticket.reportId,
                status: classifyReportStatus(ticket.status) === "completed" ? "processing" : "requested",
                requestedAt: now().toISOString(),
              })
              .catch(() => null);
          }

          // Poll ngay vài lần (report nhỏ thường xong trong vài chục giây). Chưa xong
          // thì thôi — pha POLL của lần chạy sau sẽ tiếp. KHÔNG chờ lâu.
          const attempts = opts.pollAttempts ?? 0;
          const delay = opts.pollDelayMs ?? 5_000;
          for (let i = 0; i < attempts && ticket.reportId; i += 1) {
            await sleep(delay);
            const pendingRow: PendingAdsReport = {
              sellerAccountId: shop.id,
              adsProfileId: profileId,
              reportTypeId: spec.reportTypeId,
              adProduct: spec.adProduct,
              groupBy: spec.groupByKey,
              timeUnit: spec.timeUnit,
              dateStart: range.startDate,
              dateEnd: range.endDate,
              adsReportId: ticket.reportId,
              status: "requested",
              attempts: i,
              lastError: null,
              requestedAt: now().toISOString(),
              marketplace: shop.marketplace,
            };
            const before = out.imported;
            await pollOne(shop.id, shop.displayName, scoped, pendingRow, out);
            if (out.imported > before || out.steps.some((s) => s.action === "no_data" && s.reportId === ticket.reportId)) {
              break; // đã nhập xong (hoặc report rỗng) → khỏi poll tiếp
            }
          }
        } catch (e) {
          const err = e as AdsApiError;
          const code: AdsErrorCode = err instanceof AdsApiError ? err.code : "bad_response";
          const action: AdsSyncAction =
            code === "throttled" ? "throttled" : code === "duplicate_report" ? "duplicate" : "failed";
          out.steps.push({
            shopId: shop.id,
            shopName: shop.displayName,
            kind,
            action,
            reportTypeId: spec.reportTypeId,
            range,
            message: `${err.message}${err.hint ? ` → ${err.hint}` : ""}`,
          });
          counts[action] += 1;
          if (db) {
            await db
              .setReportRequest(shop.id, {
                reportTypeId: spec.reportTypeId,
                adsProfileId: profileId,
                adProduct: spec.adProduct,
                groupBy: spec.groupByKey,
                timeUnit: spec.timeUnit,
                dateStart: range.startDate,
                dateEnd: range.endDate,
                status: action === "throttled" ? "throttled" : action === "duplicate" ? "processing" : "failed",
                lastError: err.message.slice(0, 400),
                failureReason: code,
              })
              .catch(() => null);
          }
        }
      }

      // ---- PHA 3 + 4: alert + lấp ads_spend vào F4 -------------------------
      const lastDay =
        opts.endDate?.slice(0, 10) ??
        clampWindowToRetention(
          reportWindow({ days: opts.days ?? config.reportDays, endDate: null, now: now() }),
          reportSpec("campaigns"),
          now(),
        ).endDate;

      if (db && opts.raiseAlerts !== false) {
        try {
          const alerts = await db.raiseAlerts(shop.id, lastDay);
          out.alerts = alerts.length;
          result.alerts += alerts.length;
          counts.alerts += alerts.length > 0 ? 1 : 0;
          out.steps.push({
            shopId: shop.id,
            shopName: shop.displayName,
            kind: "alerts",
            action: "alerts",
            rows: alerts.length,
            message:
              alerts.length > 0
                ? `${alerts.length} cảnh báo: ${alerts
                    .slice(0, 4)
                    .map((a) => `${a.ruleCode} (${a.severity ?? "?"})${a.nextAction ? ` → ${a.nextAction}` : ""}`)
                    .join("; ")}`
                : `không có cảnh báo nào cho ngày ${lastDay}.`,
          });
        } catch (e) {
          out.warnings.push(`Không chạy được vexim_ads_raise_alerts: ${(e as Error).message}`);
        }
      }

      if (db && opts.fillProfit !== false) {
        try {
          const fill = await db.fillProfitAdsSpend(shop.id, { from: null, to: null });
          out.profitRows = fill.rowsUpdated;
          result.profitRows += fill.rowsUpdated;
          counts.profit += fill.rowsUpdated > 0 ? 1 : 0;
          out.steps.push({
            shopId: shop.id,
            shopName: shop.displayName,
            kind: "profit",
            action: "profit",
            rows: fill.rowsUpdated,
            message:
              `F4: cập nhật ads_spend cho ${fill.rowsUpdated} dòng (${fill.days} ngày · ${fill.skus} SKU)` +
              (fill.unmatched > 0
                ? ` · ${fill.unmatched} SKU quảng cáo KHÔNG khớp listings → giữ NULL, không bịa số`
                : ""),
          });
          if (fill.unmatched > 0) {
            out.warnings.push(
              `${fill.unmatched} advertisedSku không khớp catalog/listings của shop → ads_spend của chúng để NULL. ` +
                `Kiểm tra SKU trong campaign có trùng SKU trong listings không.`,
            );
          }
        } catch (e) {
          out.warnings.push(`Không chạy được vexim_worker_fill_profit_ads_spend: ${(e as Error).message}`);
        }
      }

      flushShop(out, log);
    }
  }

  for (const w of tokenManager.warnings) if (!warnings.includes(w)) warnings.push(w);
  result.warnings = warnings;
  result.errors = errors;
  return result;
}

/* ------------------------------------------------------------------ */
function newShopResult(shopId: string, shopName: string, marketplace: string | null): AdsSyncShopResult {
  return {
    shopId,
    shopName,
    marketplace,
    tokenSource: null,
    profileId: null,
    profileReason: "",
    steps: [],
    imported: 0,
    rowsImported: 0,
    pending: 0,
    throttled: 0,
    failed: 0,
    alerts: 0,
    profitRows: 0,
    warnings: [],
    error: null,
  };
}

/**
 * Ghi lỗi của cả shop vào kết quả + ĐẾM vào bộ đếm chung.
 * `counts` phải truyền vào vì failShop nằm ngoài runAdsSync (không closure được).
 */
function failShop(
  out: AdsSyncShopResult,
  e: unknown,
  counts: Record<AdsSyncAction, number>,
  prefix = "",
) {
  // Không intersect AdsTokenError & AdsApiError: hai lớp có `code` khác kiểu nên TS
  // rút intersection về never. Đọc từng thuộc tính qua narrowing riêng.
  const message = e instanceof Error ? e.message : String(e);
  const hint = (e as { hint?: string | null } | null)?.hint ?? null;
  const retryable = (e as { retryable?: boolean } | null)?.retryable === true;
  out.error = `${prefix ? `${prefix}: ` : ""}${message}${hint ? ` → ${hint}` : ""}`;
  // Lỗi token (chưa kết nối / hết hạn) không phải "hỏng cron" → skipped, để lần
  // sau chủ shop authorize xong là chạy được ngay, không cần sửa code.
  const skipped = e instanceof AdsTokenError || retryable;
  out.steps.push({
    shopId: out.shopId,
    shopName: out.shopName,
    kind: "token",
    action: skipped ? "skipped" : "failed",
    message: out.error,
  });
  // Phải đếm: không thì cron in ra "0 shop lỗi" trong khi thực tế chẳng shop nào
  // được đồng bộ — người vận hành tưởng mọi thứ ổn.
  if (skipped) counts.skipped += 1;
  else counts.failed += 1;
}

function flushShop(out: AdsSyncShopResult, log?: (s: string) => unknown) {
  if (!log) return;
  log(`\n[${out.shopName}] token=${out.tokenSource ?? "—"} profile=${out.profileId ?? "—"}\n`);
  for (const s of out.steps) {
    log(`  ${s.action.padEnd(9)} ${s.kind.padEnd(11)} ${s.message}\n`);
  }
  for (const w of out.warnings) log(`  ⚠ ${w}\n`);
  if (out.error) log(`  ✖ ${out.error}\n`);
}
