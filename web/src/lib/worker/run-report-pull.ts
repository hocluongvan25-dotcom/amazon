/**
 * Runner — TỰ ĐỘNG KÉO REPORT FBA cho mọi shop production (Vercel Cron).
 *
 *   /api/cron/report-pull  →  runReportPullAll()  →  runReportPull() (job)
 *
 * Luồng:
 *   1. loadConfig() — chỉ chạy THẬT khi có đủ AMAZON_LWA_* + Supabase (mode=production)
 *   2. Lấy shop production active từ DB (không có shop → trả sạch, log rõ)
 *   3. Mỗi shop × mỗi loại report: xin/poll/tải/parse/nhập (xem report-pull.job.ts)
 *   4. Trả bảng outcome để cron route in ra JSON — người vận hành đọc được
 *      "cái nào đã nhập, cái nào Amazon còn đang tạo, cái nào bị trần 4 giờ".
 *
 * AN TOÀN DỮ LIỆU (giống run-inventory-sync.ts): DB thật CHỈ được dùng khi
 * mode === "production". Thiếu credential → chạy với MockDbAdapter trong bộ nhớ
 * và cron vẫn trả 200 (không làm đỏ dashboard một cách vô ích), nhưng log nói
 * thẳng là đang ở chế độ demo và cần bật biến môi trường nào.
 */
import { loadConfig, type DataMode } from "./config.ts";
import { LwaTokenManager } from "./amazon/lwa.ts";
import { ReportsClient } from "./amazon/reports.ts";
import { MockDbAdapter, type ActiveShop, type DbAdapter } from "./db/adapter.ts";
import { SupabaseDbAdapter } from "./db/supabase.ts";
import {
  runReportPull,
  type ReportPullAction,
  type ReportPullShop,
} from "./jobs/report-pull.job.ts";
import { ALL_REPORT_KINDS, type ReportKind } from "./reports/registry.ts";

export type ReportPullRunResult = {
  mode: DataMode;
  db: "supabase" | "mock";
  /** có credential để gọi Amazon hay không — cron route phơi ra để chẩn đoán */
  apiConfigured: boolean;
  shopsProcessed: number;
  kindsRequested: ReportKind[];
  imported: number;
  pending: number;
  noData: number;
  throttled: number;
  failed: number;
  skipped: number;
  rowsImported: number;
  outcomes: {
    shop: string;
    kind: ReportKind;
    reportType: string;
    action: ReportPullAction;
    status: string | null;
    reportId: string | null;
    period: string;
    rows: number;
    summary: string | null;
    message: string;
    warnings: string[];
  }[];
  errors: { shopId: string; kind: ReportKind; error: string }[];
};

const DEMO_SHOP: ActiveShop = {
  id: "00000000-0000-0000-0000-000000000001",
  sellerId: "DEMO-SELLER",
  marketplace: "ATVPDKIKX0DER",
  displayName: "DEMO · US",
  leadDays: 32,
  safetyDays: 14,
};

export async function runReportPullAll(
  deps: {
    kinds?: readonly ReportKind[];
    days?: number | null;
    dryRun?: boolean;
    now?: Date;
    stdout?: { write: (s: string) => void };
    /** nạp từ nội dung có sẵn (CLI --file / test) thay vì gọi Amazon */
    texts?: Partial<Record<ReportKind, string>>;
    /** cho test: tiêm adapter */
    adapter?: DbAdapter;
    /** cho test: tiêm client */
    clientFor?: (shop: ReportPullShop) => ReportsClient | null;
    pollAttempts?: number;
    pollDelayMs?: number;
    /** CLI: chỉ chạy 1 shop (cron bỏ qua — cron chạy mọi shop production) */
    sellerAccountId?: string | null;
    /**
     * CLI chế độ file: >1 shop mà không --seller thì DỪNG và liệt kê shop,
     * không đoán (nhập nhầm phí của shop này sang shop khác là sự cố số liệu).
     */
    requireSingleShop?: boolean;
  } = {},
): Promise<ReportPullRunResult> {
  // KHÔNG gán `deps.stdout?.write` trực tiếp: đó là method đã tách khỏi object,
  // gọi với `this === undefined` → crash khi truyền process.stdout
  // ("Cannot read properties of undefined (reading '_writableState')").
  const log = (text: string): void => {
    deps.stdout?.write(text);
  };
  const cfg = loadConfig();
  const now = deps.now ?? new Date();
  const kinds = (deps.kinds?.length ? deps.kinds : ALL_REPORT_KINDS) as ReportKind[];

  let db: DbAdapter;
  let shops: ReportPullShop[];

  // CHẶN CỨNG giống inventory-sync: chỉ chạm DB thật khi mode === "production".
  const allowRealDb = cfg.mode === "production" && cfg.supabase !== null;

  if (deps.adapter) {
    db = deps.adapter;
    shops = [DEMO_SHOP];
  } else if (allowRealDb && cfg.supabase) {
    const sb = new SupabaseDbAdapter(cfg.supabase.url, cfg.supabase.serviceRoleKey);
    try {
      const fromDb = await sb.listActiveProductionShops();
      if (fromDb.length === 0) {
        log(
          "[report-pull] mode=production nhưng KHÔNG có shop nào thoả " +
            "(status='active' AND data_source='production') → không kéo report nào.\n",
        );
        return emptyResult(cfg.mode, "supabase", kinds, true);
      }
      db = sb;
      shops = fromDb;
      if (deps.sellerAccountId) {
        const wanted = fromDb.filter((s) => s.id === deps.sellerAccountId);
        if (wanted.length === 0) {
          log(
            `[report-pull] không thấy shop ${deps.sellerAccountId} trong danh sách production ` +
              `(${fromDb.map((s) => `${s.displayName}=${s.id}`).join(", ")}) → không làm gì.\n`,
          );
          return emptyResult(cfg.mode, "supabase", kinds, true);
        }
        shops = wanted;
      } else if (deps.requireSingleShop && fromDb.length > 1) {
        log(
          `[report-pull] có ${fromDb.length} shop production → PHẢI chỉ định --seller=<uuid>.\n` +
            fromDb.map((s) => `   ${s.displayName} = ${s.id}\n`).join(""),
        );
        return emptyResult(cfg.mode, "supabase", kinds, true);
      }
      log(
        `[report-pull] mode=production host=${cfg.spApiHost} · ${shops.length} shop · ` +
          `${kinds.length} loại report · ${deps.dryRun ? "DRY-RUN (không ghi DB)" : "ghi DB thật"}\n`,
      );
    } catch (e) {
      log(
        `[report-pull] cảnh báo: không kết nối được DB (${(e as Error).message.split("\n")[0]}). ` +
          `Chuyển DEMO MODE — không ghi gì cả.\n`,
      );
      db = new MockDbAdapter();
      shops = [DEMO_SHOP];
    }
  } else {
    db = new MockDbAdapter();
    shops = [DEMO_SHOP];
    log(
      `[report-pull] mode=${cfg.mode} → CHƯA đủ credential (cần AMAZON_LWA_CLIENT_ID, ` +
        `AMAZON_LWA_CLIENT_SECRET, AMAZON_LWA_REFRESH_TOKEN + SUPABASE_URL + ` +
        `SUPABASE_SERVICE_ROLE_KEY). Chạy demo trong bộ nhớ, KHÔNG ghi DB.\n`,
    );
  }

  // Client Amazon: chỉ khi có refresh token (seller scope) — grantless không đọc
  // được report của seller.
  const apiConfigured = !!(cfg.lwa?.refreshToken && db instanceof SupabaseDbAdapter);
  const clientFor =
    deps.clientFor ??
    ((apiConfigured && cfg.lwa?.refreshToken
      ? () =>
          new ReportsClient({
            host: cfg.spApiHost,
            lwa: new LwaTokenManager({
              clientId: cfg.lwa!.clientId,
              clientSecret: cfg.lwa!.clientSecret,
              refreshToken: cfg.lwa!.refreshToken,
            }),
          })
      : () => null));

  const result = await runReportPull({
    db,
    shops,
    kinds,
    days: deps.days ?? null,
    dryRun: deps.dryRun === true,
    now,
    log,
    clientFor,
    texts: deps.texts,
    pollAttempts: deps.pollAttempts,
    pollDelayMs: deps.pollDelayMs,
  });

  return {
    mode: cfg.mode,
    db: db instanceof SupabaseDbAdapter ? "supabase" : "mock",
    apiConfigured,
    shopsProcessed: result.shopsProcessed,
    kindsRequested: kinds,
    imported: result.imported,
    pending: result.pending,
    noData: result.noData,
    throttled: result.throttled,
    failed: result.failed,
    skipped: result.skipped,
    rowsImported: result.rowsImported,
    outcomes: result.outcomes.map((o) => ({
      shop: o.shopName,
      kind: o.kind,
      reportType: o.reportType,
      action: o.action,
      status: o.status,
      reportId: o.reportId,
      period: o.period.start ? `${o.period.start} → ${o.period.end}` : "không khoảng ngày",
      rows: o.rows,
      summary: o.summary,
      message: o.message,
      warnings: o.warnings,
    })),
    errors: result.errors,
  };
}

function emptyResult(
  mode: DataMode,
  db: "supabase" | "mock",
  kinds: ReportKind[],
  apiConfigured: boolean,
): ReportPullRunResult {
  return {
    mode,
    db,
    apiConfigured,
    shopsProcessed: 0,
    kindsRequested: kinds,
    imported: 0,
    pending: 0,
    noData: 0,
    throttled: 0,
    failed: 0,
    skipped: 0,
    rowsImported: 0,
    outcomes: [],
    errors: [],
  };
}
