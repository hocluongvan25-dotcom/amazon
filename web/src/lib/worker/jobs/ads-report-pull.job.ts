/**
 * Job — TỰ ĐỘNG KÉO REPORT AMAZON ADS (Module 5 phần 1).
 *
 *   POST /reporting/reports → GET /reporting/reports/{id} (poll) → tải GZIP_JSON
 *   → parse → RPC  →  (campaigns) cảnh báo + sự kiện ngân sách
 *                  →  (advertised) lấp ads_spend cho F4
 *
 * BA LUẬT GIỐNG 0019 (sai một cái là cron thành "xanh giả"):
 *   1. KHÔNG BLOCK CHỜ report — poll vài lần, chưa xong thì ghi trạng thái vào
 *      `connections.report_requests` (khoá bằng reportTypeId) và lần sau poll
 *      TIẾP ĐÚNG reportId đó, không xin report mới.
 *   2. TÔN TRỌNG COOLDOWN — mỗi loại report một trần; job đọc report_requests
 *      trước khi xin mới.
 *   3. REPORT RỖNG KHÔNG PHẢI LỖI — ngày không chạy quảng cáo thì không có dòng.
 *      Ghi `no_data` để UI nói "không chạy" thay vì "chưa kéo".
 *
 * KHÁC 0019 Ở CHỖ NÀO:
 *   • Có BƯỚC NGHIỆP VỤ sau khi nhập: cảnh báo `acos_over_target` /
 *     `budget_exhausted` (rule đã có trong ops.alert_rules, module='ads') và
 *     `ads.budget_events` (hour_source='unavailable' — report v3 KHÔNG có giờ).
 *     Cả hai đều tính từ CHÍNH dữ liệu vừa nhập, không đọc lại DB, nên không có
 *     chuyện "cảnh báo dựa trên số cũ".
 *   • Report `spAdvertisedProduct` được dùng để lấp `finance.sku_profit_daily.ads_spend`
 *     (F4 + TACOS) — CHỈ cập nhật dòng lợi nhuận đã có, không tạo dòng mới, và
 *     không trộn tiền tệ.
 *
 * AN TOÀN DỮ LIỆU: job không tự chọn DB thật — runner chỉ đưa SupabaseDbAdapter
 * vào khi cfg.mode === "production" (giống report-pull.job.ts).
 */
import type { DbAdapter, ReportRequestRow, ReportRequestStatus } from "../db/adapter.ts";
import { AdsApiRequestError, type AdsClient, type AdsReportInfo } from "../amazon/ads.ts";
import {
  adsSpecOf,
  importAdsReport,
  parseAdsReportText,
  type AdsImportOutcome,
  type AdsReportKind,
} from "../ads/registry.ts";

export type AdsPullShop = {
  id: string;
  displayName: string;
  marketplace: string;
};

export type AdsPullAction =
  | "created"
  | "polled"
  | "imported"
  | "no_data"
  | "dry_run"
  | "pending"
  | "throttled"
  | "failed"
  | "skipped";

export type AdsPeriod = {
  start: string | null;
  end: string | null;
};

export type AdsOutcome = {
  shopId: string;
  shopName: string;
  kind: AdsReportKind;
  reportTypeId: string;
  action: AdsPullAction;
  status: ReportRequestStatus | null;
  reportId: string | null;
  period: AdsPeriod;
  rows: number;
  days: number;
  counts: AdsImportOutcome | null;
  summary: string | null;
  warnings: string[];
  message: string;
  gzipped: boolean;
  bytes: number;
  /** số cảnh báo đã tạo/cập nhật ở bước nghiệp vụ (chỉ report campaigns) */
  alertsFired: number;
  /** số dòng ads_spend đã lấp (chỉ report advertised-products) */
  spendApplied: number;
  needsReauth: boolean;
};

export type AdsPullResult = {
  source: "api" | "file" | "none";
  shopsProcessed: number;
  outcomes: AdsOutcome[];
  imported: number;
  pending: number;
  noData: number;
  throttled: number;
  failed: number;
  skipped: number;
  rowsImported: number;
  alertsFired: number;
  spendApplied: number;
  errors: { shopId: string; kind: AdsReportKind; error: string }[];
};

export type AdsAlertThresholds = {
  /** % ACOS vượt là cảnh báo — khớp rule acos_over_target (mặc định 25) */
  acosTargetPct: number;
  /** % ngân sách ngày dùng tới là cảnh báo — khớp rule budget_exhausted (95) */
  budgetUsagePct: number;
  /** bỏ qua campaign quá nhỏ: dưới ngưỡng này thì chưa đáng cảnh báo */
  minClicks7d: number;
  minSpend7d: number;
};

export const DEFAULT_ADS_THRESHOLDS: AdsAlertThresholds = {
  acosTargetPct: 25,
  budgetUsagePct: 95,
  minClicks7d: 10,
  minSpend7d: 5,
};

export type AdsPullOptions = {
  db: DbAdapter;
  shops: AdsPullShop[];
  kinds?: readonly AdsReportKind[];
  days?: number | null;
  dryRun?: boolean;
  now?: Date;
  log?: (s: string) => void;
  /** null = chưa cấu hình credential Ads → outcome `skipped` kèm hướng dẫn */
  clientFor?: (shop: AdsPullShop) => AdsClient | null;
  /** nạp từ file/chuỗi (CLI --file / test) thay vì gọi Amazon */
  texts?: Partial<Record<AdsReportKind, string>>;
  pollAttempts?: number;
  pollDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** bước nghiệp vụ sau khi nhập (mặc định BẬT) */
  fireAlerts?: boolean;
  applySpend?: boolean;
  thresholds?: Partial<AdsAlertThresholds>;
  /** profile Ads dùng cho lần nhập (cron: profile khớp marketplace của shop) */
  adsProfileFor?: (shop: AdsPullShop) => { adsProfileId: string | null; currency: string | null } | null;
};

const DEFAULT_POLL_ATTEMPTS = 3;
const DEFAULT_POLL_DELAY_MS = 20_000;

const RESUMABLE: readonly ReportRequestStatus[] = ["requested", "in_queue", "in_progress", "done"];

/**
 * Giống report-pull FBA: report Ads của KỲ CŨ vẫn treo requested/in_queue/
 * in_progress quá số giờ này thì đóng lại (cancelled) — kỳ Ads trượt theo
 * `now` mỗi ngày nên dòng hôm qua không bao giờ được poll lại, thành "CHỜ QUÁ
 * LÂU" vĩnh viễn trên màn Sync health.
 */
const STALE_PENDING_HOURS = 24;

const pad2 = (n: number) => String(n).padStart(2, "0");
const isoDay = (d: Date) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

export function computeAdsPeriod(kind: AdsReportKind, opts: { days?: number | null; now: Date }): AdsPeriod {
  const spec = adsSpecOf(kind);
  const days = Math.max(1, Math.round(opts.days ?? spec.lookbackDays));
  const end = new Date(opts.now.getTime());
  const start = new Date(end.getTime() - days * 86_400_000);
  return { start: isoDay(start), end: isoDay(end) };
}

function samePeriod(a: AdsPeriod, row: ReportRequestRow): boolean {
  return (row.dataStart ?? null) === a.start && (row.dataEnd ?? null) === a.end;
}

function hoursSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (now.getTime() - t) / 3_600_000;
}

function fmtCounts(c: AdsImportOutcome | null): string {
  if (!c) return "";
  const parts = [`ghi mới ${c.inserted}`, `cập nhật ${c.updated}`];
  if (c.merged > 0) parts.push(`gộp trùng khoá ${c.merged}`);
  if (c.skipped > 0) parts.push(`BỎ ${c.skipped} dòng rác`);
  if (c.currencies) parts.push(`tiền: ${c.currencies}`);
  return parts.join(" · ");
}

export async function runAdsReportPull(opts: AdsPullOptions): Promise<AdsPullResult> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const kinds = (opts.kinds?.length
    ? opts.kinds
    : ["campaigns", "targeting", "search-terms", "advertised-products", "purchased-products"]) as AdsReportKind[];
  const pollAttempts = Math.max(1, opts.pollAttempts ?? DEFAULT_POLL_ATTEMPTS);
  const pollDelayMs = Math.max(0, opts.pollDelayMs ?? DEFAULT_POLL_DELAY_MS);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const dryRun = opts.dryRun === true;
  const fireAlerts = opts.fireAlerts !== false;
  const applySpend = opts.applySpend !== false;
  const th: AdsAlertThresholds = { ...DEFAULT_ADS_THRESHOLDS, ...(opts.thresholds ?? {}) };

  const outcomes: AdsOutcome[] = [];
  const errors: AdsPullResult["errors"] = [];
  const fileMode = !!opts.texts && kinds.some((k) => opts.texts?.[k] !== undefined);

  const push = (o: AdsOutcome) => {
    outcomes.push(o);
    const tag = o.action === "imported" ? "OK " : o.action === "failed" || o.action === "throttled" ? "LỖI" : "···";
    log(
      `[ads-pull] ${tag} ${o.shopName} · ${adsSpecOf(o.kind).label}\n` +
        `           ${o.period.start ? `${o.period.start} → ${o.period.end}` : "không khoảng ngày"} · ` +
        `action=${o.action}${o.reportId ? ` · reportId=${o.reportId}` : ""}\n` +
        `           ${o.message}\n` +
        (o.summary ? `           ${o.summary}\n` : "") +
        (o.counts ? `           ${fmtCounts(o.counts)}\n` : "") +
        (o.alertsFired > 0 ? `           ⚠ đã tạo/cập nhật ${o.alertsFired} cảnh báo theo rule ads\n` : "") +
        (o.spendApplied > 0 ? `           ↳ lấp ads_spend cho ${o.spendApplied} dòng F4\n` : "") +
        (o.warnings.length > 0 ? o.warnings.map((w) => `           ⚠ ${w}\n`).join("") : ""),
    );
    if (o.action === "failed" || o.action === "throttled") {
      errors.push({ shopId: o.shopId, kind: o.kind, error: o.message });
    }
  };

  const base = (shop: AdsPullShop, kind: AdsReportKind, period: AdsPeriod): AdsOutcome => ({
    shopId: shop.id,
    shopName: shop.displayName,
    kind,
    reportTypeId: adsSpecOf(kind).reportTypeId,
    action: "skipped",
    status: null,
    reportId: null,
    period,
    rows: 0,
    days: 0,
    counts: null,
    summary: null,
    warnings: [],
    message: "",
    gzipped: false,
    bytes: 0,
    alertsFired: 0,
    spendApplied: 0,
    needsReauth: false,
  });

  const recordState = async (
    shop: AdsPullShop,
    kind: AdsReportKind,
    period: AdsPeriod,
    status: ReportRequestStatus,
    ctx: { reportId?: string | null; requestedAt?: string | null; lastError?: string | null },
    extra?: { rowsImported?: number | null },
  ): Promise<void> => {
    if (dryRun) return;
    try {
      await opts.db.setReportRequest(shop.id, {
        // reportType = reportTypeId của Ads ⇒ chung bảng với report FBA của 0019
        // mà không đụng nhau (giá trị không bao giờ trùng).
        reportType: adsSpecOf(kind).reportTypeId,
        marketplaceId: shop.marketplace ?? null,
        dataStart: period.start,
        dataEnd: period.end,
        reportId: ctx.reportId ?? null,
        reportDocumentId: null,
        status,
        rowsImported: extra?.rowsImported ?? null,
        lastError: ctx.lastError ?? null,
        requestedAt: ctx.requestedAt ?? now.toISOString(),
        completedAt: status === "imported" || status === "no_data" ? now.toISOString() : null,
        importedAt: status === "imported" ? now.toISOString() : null,
      });
    } catch (e) {
      log(`[ads-pull] ⚠ không ghi được trạng thái report (${(e as Error).message.split("\n")[0]})\n`);
    }
  };

  /**
   * Bước nghiệp vụ SAU khi nhập report campaigns:
   *   • ads.budget_events (capped) + cảnh báo budget_exhausted
   *   • cảnh báo acos_over_target
   * Tính từ chính dữ liệu vừa nhập. Ngưỡng khớp ops.alert_rules (0020).
   */
  const runCampaignBusiness = async (
    shop: AdsPullShop,
    rows: Record<string, unknown>[],
  ): Promise<{ alerts: number; warnings: string[] }> => {
    const warnings: string[] = [];
    if (dryRun || rows.length === 0) return { alerts: 0, warnings };

    const num = (v: unknown): number | null => {
      if (v === null || v === undefined || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const byCampaign = new Map<
      string,
      { name: string; currency: string | null; budget: number | null; days: Map<string, number>; cost7: number; sales7: number; clicks7: number }
    >();
    let lastDay = "";
    for (const r of rows) {
      const day = String(r.day ?? "");
      if (day > lastDay) lastDay = day;
      const id = String(r.campaignId ?? "");
      if (id === "") continue;
      const cur = byCampaign.get(id) ?? {
        name: String(r.campaignName ?? id),
        currency: (r.budgetCurrency as string | null) ?? (r.currency as string | null) ?? null,
        budget: null,
        days: new Map<string, number>(),
        cost7: 0,
        sales7: 0,
        clicks7: 0,
      };
      const cost = num(r.cost) ?? 0;
      const budget = num(r.budgetAmount);
      if (budget !== null) cur.budget = budget;
      cur.days.set(day, (cur.days.get(day) ?? 0) + cost);
      byCampaign.set(id, cur);
    }

    // Cửa sổ 7 ngày tính theo NGÀY MỚI NHẤT có dữ liệu (giống mọi view của 0020:
    // "7 ngày" là 7 ngày gần nhất CÓ số, không phải 7 ngày theo lịch trống).
    const cutoff = shiftDays(lastDay, -6);
    for (const r of rows) {
      const day = String(r.day ?? "");
      if (day < cutoff) continue;
      const id = String(r.campaignId ?? "");
      const cur = byCampaign.get(id);
      if (!cur) continue;
      cur.cost7 += num(r.cost) ?? 0;
      cur.sales7 += num(r.sales7d) ?? 0;
      cur.clicks7 += num(r.clicks) ?? 0;
    }

    let alerts = 0;
    const budgetEvents: Record<string, unknown>[] = [];
    for (const [campaignId, c] of byCampaign) {
      const spendLastDay = c.days.get(lastDay) ?? 0;
      const pct = c.budget && c.budget > 0 ? (spendLastDay / c.budget) * 100 : null;

      if (pct !== null && pct >= th.budgetUsagePct) {
        budgetEvents.push({
          day: lastDay,
          campaignId,
          eventType: "capped",
          budgetAmount: c.budget,
          currency: c.currency,
          cost: round2(spendLastDay),
          usagePct: round2(pct),
          hourSource: "unavailable",
          note:
            `chi tiêu ngày ${lastDay} đạt ${round2(pct)}% ngân sách (${round2(spendLastDay)}/${c.budget}). ` +
            `Report v3 không có dữ liệu theo giờ nên không ghi giờ cạn.`,
        });
        await opts.db.upsertAlert({
          sellerAccountId: shop.id,
          ruleCode: "budget_exhausted",
          severity: "amber",
          // Tiêu đề CỐ ĐỊNH (dedupe 24h của worker dựa vào title) — số liệu ở detail.
          title: `budget_exhausted · ${campaignId}`,
          detail:
            `${c.name}: chi tiêu ${round2(spendLastDay)}/${c.budget} ${c.currency ?? ""} ` +
            `(${round2(pct)}%) ngày ${lastDay} — SOP-04: nới ngân sách hoặc siết từ khoá.`,
        });
        alerts++;
      }

      if (c.sales7 > 0) {
        const acos = (c.cost7 / c.sales7) * 100;
        if (
          acos > th.acosTargetPct &&
          c.clicks7 >= th.minClicks7d &&
          c.cost7 >= th.minSpend7d
        ) {
          await opts.db.upsertAlert({
            sellerAccountId: shop.id,
            ruleCode: "acos_over_target",
            severity: "amber",
            title: `acos_over_target · ${campaignId}`,
            detail:
              `${c.name}: ACOS 7 ngày ${round2(acos)}% (chi ${round2(c.cost7)} / doanh thu ${round2(c.sales7)}` +
              `${c.currency ? ` ${c.currency}` : ""}) · ${c.clicks7} click — mục tiêu ${th.acosTargetPct}%. ` +
              `SOP-05: xem lại bid/từ khoá trước khi tăng tiền.`,
          });
          alerts++;
        }
      }
    }

    if (budgetEvents.length > 0) {
      try {
        await opts.db.upsertAdsBudgetEvents(shop.id, budgetEvents as never);
      } catch (e) {
        warnings.push(`không ghi được sự kiện ngân sách (${(e as Error).message.split("\n")[0]})`);
      }
    }
    return { alerts, warnings };
  };

  const ingest = async (
    shop: AdsPullShop,
    kind: AdsReportKind,
    period: AdsPeriod,
    text: string,
    ctx: {
      reportId: string | null;
      requestedAt?: string | null;
      gzipped?: boolean;
      bytes?: number;
      adsProfileId?: string | null;
      currency?: string | null;
    },
  ): Promise<AdsOutcome> => {
    const out = base(shop, kind, period);
    out.reportId = ctx.reportId;
    out.gzipped = ctx.gzipped === true;
    out.bytes = ctx.bytes ?? text.length;

    const parsed = parseAdsReportText(kind, text, {
      adsProfileId: ctx.adsProfileId ?? null,
      currency: ctx.currency ?? null,
    });
    out.rows = parsed.rows.length;
    out.days = parsed.days;
    out.warnings = parsed.warnings;
    out.summary = parsed.summary;

    if (parsed.rows.length === 0) {
      out.action = "no_data";
      out.status = "no_data";
      out.message =
        `Report không có dòng nào dùng được (bỏ ${parsed.skipped} dòng rác). ` +
        `Với ngày không chạy quảng cáo, đây là bình thường — không phải lỗi.`;
      await recordState(shop, kind, period, "no_data", ctx, { rowsImported: 0 });
      return out;
    }

    if (dryRun) {
      out.action = "dry_run";
      out.message = `dry-run: đã parse ${parsed.rows.length} dòng, KHÔNG ghi DB.`;
      return out;
    }

    out.counts = await importAdsReport(opts.db, shop.id, parsed);
    out.action = "imported";
    out.status = "imported";
    out.message = `đã nhập ${parsed.rows.length} dòng vào DB.`;
    await recordState(shop, kind, period, "imported", ctx, { rowsImported: parsed.rows.length });

    if (kind === "campaigns" && fireAlerts) {
      const biz = await runCampaignBusiness(shop, parsed.rows);
      out.alertsFired = biz.alerts;
      out.warnings.push(...biz.warnings);
    }

    if (kind === "advertised-products" && applySpend && period.start && period.end) {
      try {
        const spend = await opts.db.applyAdsSpend(shop.id, period.start, period.end);
        out.spendApplied = spend.updated;
        if (spend.skippedNoRow > 0 || spend.skippedCurrency > 0) {
          out.warnings.push(
            `ads_spend: ${spend.skippedNoRow} dòng chưa có dòng lợi nhuận F4 tương ứng, ` +
              `${spend.skippedCurrency} dòng lệch tiền tệ (KHÔNG trộn tiền tệ) — chạy F4 cho ngày đó trước.`,
          );
        }
      } catch (e) {
        out.warnings.push(`không lấp được ads_spend (${(e as Error).message.split("\n")[0]})`);
      }
    }
    return out;
  };

  const pollAndIngest = async (
    shop: AdsPullShop,
    kind: AdsReportKind,
    period: AdsPeriod,
    client: AdsClient,
    reportId: string,
    requestedAt: string,
    out: AdsOutcome,
  ): Promise<AdsOutcome> => {
    let info: AdsReportInfo | null = null;
    for (let attempt = 1; attempt <= pollAttempts; attempt++) {
      info = await client.getReport(reportId);
      const st = info.status;

      if (st === "PENDING" || st === "PROCESSING") {
        out.status = st === "PENDING" ? "in_queue" : "in_progress";
        if (attempt < pollAttempts) {
          await sleep(pollDelayMs);
          continue;
        }
        out.action = "pending";
        out.message =
          `Amazon vẫn đang tạo report (${st}) sau ${attempt} lần poll — không chờ tiếp, ` +
          `lần chạy sau poll lại reportId=${reportId}.`;
        await recordState(shop, kind, period, out.status, { reportId, requestedAt });
        return out;
      }

      if (st === "FAILED") {
        out.action = "failed";
        out.status = "failed";
        out.message =
          `Amazon BÁO LỖI không tạo được report${info.failureReason ? `: ${info.failureReason}` : ""}. ` +
          `Kiểm tra lại cột/groupBy của ${adsSpecOf(kind).reportTypeId} (tên cột sai là nguyên nhân hay gặp).`;
        await recordState(shop, kind, period, "failed", {
          reportId,
          requestedAt,
          lastError: out.message,
        });
        return out;
      }

      const content = await client.fetchReportContent(reportId);
      if (content.text === null) {
        out.action = "pending";
        out.status = "in_progress";
        out.message = `report ${reportId} đổi trạng thái giữa 2 lần đọc (${content.info.status}) — thử lại lần sau.`;
        return out;
      }
      const profile = opts.adsProfileFor?.(shop) ?? null;
      return ingest(shop, kind, period, content.text, {
        reportId,
        requestedAt,
        gzipped: content.gzipped,
        bytes: content.bytes,
        adsProfileId: profile?.adsProfileId ?? null,
        currency: profile?.currency ?? null,
      });
    }

    out.action = "pending";
    out.message = `hết ${pollAttempts} lần poll mà chưa có kết quả (reportId=${reportId}).`;
    return out;
  };

  const handleApiError = async (
    shop: AdsPullShop,
    kind: AdsReportKind,
    period: AdsPeriod,
    e: unknown,
    ctx: { reportId: string | null; requestedAt: string },
  ): Promise<AdsOutcome> => {
    const out = base(shop, kind, period);
    out.reportId = ctx.reportId;
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    const throttled = e instanceof AdsApiRequestError && e.isThrottled;
    const config = e instanceof AdsApiRequestError && e.isConfigError;
    // unauthorized_client/invalid_client = credential env sai — re-authorize
    // shop KHÔNG sửa được, nên KHÔNG được gắn needsReauth (tránh chỉ sai hướng).
    const auth = !config && e instanceof AdsApiRequestError && e.isAuthError;
    out.needsReauth = auth;
    out.action = throttled ? "throttled" : "failed";
    out.status = "failed";
    out.message = config
      ? `credential Ads trên env SAI (${msg}) ⇒ kiểm tra AMAZON_ADS_CLIENT_ID / _SECRET / _REFRESH_TOKEN — 3 biến phải cùng một Security Profile đã được duyệt Ads API.`
      : auth
        ? `token Ads không dùng được (${msg}) ⇒ PHẢI re-authorize ở Module 0 → Kết nối shop (SOP-11).`
        : throttled
          ? `Amazon chặn vì trần tốc độ/hạn mức — không phải lỗi cấu hình, lần chạy sau thử lại. (${msg})`
          : `gọi Ads Reporting API thất bại: ${msg}`;
    await recordState(shop, kind, period, "failed", {
      reportId: ctx.reportId,
      requestedAt: ctx.requestedAt,
      lastError: msg,
    });
    return out;
  };

  for (const shop of opts.shops) {
    for (const kind of kinds) {
      const spec = adsSpecOf(kind);
      const period = computeAdsPeriod(kind, { days: opts.days ?? null, now });
      const profile = opts.adsProfileFor?.(shop) ?? null;

      // (A) chế độ file/fixture
      const text = opts.texts?.[kind];
      if (text !== undefined) {
        try {
          push(
            await ingest(shop, kind, period, text, {
              reportId: null,
              adsProfileId: profile?.adsProfileId ?? null,
              currency: profile?.currency ?? null,
            }),
          );
        } catch (e) {
          const out = base(shop, kind, period);
          out.action = "failed";
          out.status = "failed";
          out.message = `lỗi khi nạp report từ file: ${(e as Error).message.split("\n")[0]}`;
          push(out);
        }
        continue;
      }

      // (B) chế độ API
      const client = opts.clientFor?.(shop) ?? null;
      if (!client) {
        const out = base(shop, kind, period);
        out.message =
          `chưa cấu hình credential Amazon Ads (AMAZON_ADS_CLIENT_ID / _SECRET / _REFRESH_TOKEN) ` +
          `nên không tự kéo "${spec.label}" được.`;
        push(out);
        continue;
      }

      let existing: ReportRequestRow | null = null;
      let samePeriodRow: ReportRequestRow | null = null;
      try {
        const list = await opts.db.listReportRequests(shop.id, {
          reportType: spec.reportTypeId,
          limit: 50,
        });
        samePeriodRow = list.find((r) => samePeriod(period, r)) ?? null;
        existing =
          list.find((r) => {
            const h = hoursSince(r.requestedAt, now);
            return h !== null && h >= 0 && h < spec.cooldownHours;
          }) ?? null;

        // Quét dọn dòng kỳ cũ bị bỏ rơi (xem STALE_PENDING_HOURS).
        for (const r of list) {
          if (samePeriod(period, r)) continue;
          if (!["requested", "in_queue", "in_progress"].includes(r.status)) continue;
          const h = hoursSince(r.requestedAt, now);
          if (h === null || h < STALE_PENDING_HOURS) continue;
          if (!dryRun) {
            await recordState(
              shop,
              kind,
              { start: r.dataStart ?? null, end: r.dataEnd ?? null },
              "cancelled",
              {
                reportId: r.reportId ?? null,
                requestedAt: r.requestedAt ?? null,
                lastError:
                  `bỏ cuộc sau ${h.toFixed(0)} giờ chờ Amazon (status=${r.status}) — ` +
                  `kỳ dữ liệu đã trôi qua, lần chạy sau dùng kỳ mới.`,
              },
            );
            log(
              `[ads-pull] 🧹 đóng report kỳ cũ treo ${h.toFixed(0)}h: ${spec.reportTypeId} ` +
                `${r.dataStart ?? "?"} → ${r.dataEnd ?? "?"} (${shop.displayName})\n`,
            );
          }
        }
      } catch (e) {
        log(
          `[ads-pull] ⚠ không đọc được trạng thái report cũ (${(e as Error).message.split("\n")[0]}) — ` +
            `sẽ thử xin report mới.\n`,
        );
      }

      const resumable =
        existing && existing.reportId && RESUMABLE.includes(existing.status)
          ? existing
          : samePeriodRow && samePeriodRow.reportId && RESUMABLE.includes(samePeriodRow.status)
            ? samePeriodRow
            : null;

      if (!resumable) {
        if (samePeriodRow && ["imported", "no_data"].includes(samePeriodRow.status)) {
          const out = base(shop, kind, period);
          out.status = samePeriodRow.status;
          out.reportId = samePeriodRow.reportId ?? null;
          out.rows = samePeriodRow.rowsImported ?? 0;
          out.message =
            `khoảng ngày này đã ${samePeriodRow.status === "imported" ? "NHẬP XONG" : "không có dữ liệu"} ` +
            `(${samePeriodRow.rowsImported ?? 0} dòng) — không kéo lại.`;
          push(out);
          continue;
        }
        if (existing) {
          const h = hoursSince(existing.requestedAt, now);
          const out = base(shop, kind, period);
          out.status = existing.status;
          out.reportId = existing.reportId ?? null;
          out.message =
            `loại report này chỉ được yêu cầu lại sau ${spec.cooldownHours} giờ. ` +
            `Lần gần nhất cách đây ${h === null ? "?" : h.toFixed(1)} giờ (status=${existing.status}) → bỏ qua.`;
          push(out);
          continue;
        }
      }

      let reportId = resumable?.reportId ?? null;
      const requestedAt = resumable?.requestedAt ?? now.toISOString();

      if (!reportId) {
        if (!period.start || !period.end) {
          const out = base(shop, kind, period);
          out.action = "failed";
          out.message = `không tính được khoảng ngày cho ${spec.reportTypeId}.`;
          push(out);
          continue;
        }
        try {
          const created = await client.createReport({
            name: `VEXIM ${spec.reportTypeId} ${period.start}→${period.end}`,
            startDate: period.start,
            endDate: period.end,
            configuration: {
              adProduct: spec.adProduct,
              groupBy: spec.groupBy,
              columns: spec.columns,
              reportTypeId: spec.reportTypeId,
              // DAILY là lựa chọn DUY NHẤT ngoài SUMMARY — v3 không có HOURLY.
              timeUnit: "DAILY",
              format: "GZIP_JSON",
            },
          });
          reportId = created.reportId;
          await recordState(shop, kind, period, "requested", { reportId, requestedAt });
          const out = base(shop, kind, period);
          out.status = "requested";
          out.reportId = reportId;
          out.message = `đã xin report mới (reportId=${reportId}) — Amazon đang tạo, poll tiếp trong lần chạy này.`;
          push(await pollAndIngest(shop, kind, period, client, reportId, requestedAt, out));
        } catch (e) {
          push(await handleApiError(shop, kind, period, e, { reportId: null, requestedAt }));
        }
        continue;
      }

      const out = base(shop, kind, period);
      out.reportId = reportId;
      out.message = `poll report có sẵn (reportId=${reportId}, status cũ=${resumable?.status}).`;
      try {
        push(await pollAndIngest(shop, kind, period, client, reportId, requestedAt, out));
      } catch (e) {
        push(await handleApiError(shop, kind, period, e, { reportId, requestedAt }));
      }
    }
  }

  const tally = (a: AdsPullAction) => outcomes.filter((o) => o.action === a).length;
  return {
    source: fileMode ? "file" : opts.clientFor ? "api" : "none",
    shopsProcessed: new Set(outcomes.map((o) => o.shopId)).size,
    outcomes,
    imported: tally("imported") + tally("dry_run"),
    pending: tally("pending") + tally("created") + tally("polled"),
    noData: tally("no_data"),
    throttled: tally("throttled"),
    failed: tally("failed"),
    skipped: tally("skipped"),
    rowsImported: outcomes.reduce((s, o) => s + (o.counts?.inserted ?? 0) + (o.counts?.updated ?? 0), 0),
    alertsFired: outcomes.reduce((s, o) => s + o.alertsFired, 0),
    spendApplied: outcomes.reduce((s, o) => s + o.spendApplied, 0),
    errors,
  };
}

function shiftDays(day: string, delta: number): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(t)) return day;
  return isoDay(new Date(t + delta * 86_400_000));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
