/**
 * Runner nhập REPORT THẬT vào DB cho Module 4 / 6 / 7 (đường "cắm là chạy" đầu tiên).
 *
 * LÝ DO TỒN TẠI:
 *   Tải report qua Reports API (createReport → getReportDocument → tải file) là Đợt 2;
 *   nhưng để nghiệm thu 3 module này với dữ liệu thật, VEXIM có thể tải report từ
 *   Seller Central (hoặc bằng script khác) rồi import bằng CLI này. Parser + job đã
 *   đúng chuẩn report đó, nên khi bật Reports API chỉ cần thay nguồn text.
 *
 * AN TOÀN DỮ LIỆU (giữ đúng nguyên tắc của run-inventory-sync.ts):
 *   DB thật CHỈ được ghi khi cfg.mode === "production" (đủ LWA + Supabase credentials)
 *   và người chạy không truyền --dry-run. Mọi trường hợp khác chạy trong bộ nhớ
 *   (MockDbAdapter) và in bản tóm tắt để đối chiếu.
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "../config.ts";
import { MockDbAdapter, type ActiveShop, type DbAdapter } from "../db/adapter.ts";
import { SupabaseDbAdapter } from "../db/supabase.ts";
import { runAccountHealthSync } from "../jobs/account-health-sync.job.ts";
import { runFinanceSync } from "../jobs/finance-sync.job.ts";
import { runOrdersSync } from "../jobs/orders-sync.job.ts";

export type ImportOptions = {
  /** Đường dẫn file report (TSV cho orders/returns/settlement, JSON cho account health) */
  file: string;
  /** File report phụ (returns cho orders:sync) */
  extraFile?: string | null;
  /** UUID shop trong connections.seller_accounts; bỏ trống → tự chọn theo marketplace hoặc shop duy nhất */
  sellerAccountId?: string | null;
  marketplaceId?: string | null;
  /** Chạy trong bộ nhớ, không ghi DB */
  dryRun?: boolean;
  now?: Date;
  stdout?: { write: (s: string) => void };
};

export type ImportResult = {
  module: "orders" | "finance" | "account_health";
  mode: "mock" | "sandbox" | "production";
  db: "supabase" | "mock";
  sellerAccountId: string;
  summary: Record<string, unknown>;
  warnings: string[];
  errors: string[];
};

const readText = (p: string) => readFileSync(p, "utf8");

/**
 * Chọn adapter đúng chuẩn an toàn.
 * Trả kèm cờ db để báo cáo rõ dữ liệu đã xuống DB thật hay chỉ nằm trong bộ nhớ.
 */
async function pickAdapter(opts: {
  dryRun: boolean;
  sellerAccountId: string | null | undefined;
  marketplaceId?: string | null;
  log: (s: string) => void;
}): Promise<{ db: DbAdapter; dbKind: "supabase" | "mock"; shops: ActiveShop[] }> {
  const cfg = loadConfig();
  const mock = new MockDbAdapter();

  if (opts.dryRun || cfg.mode !== "production" || !cfg.supabase) {
    return { db: mock, dbKind: "mock", shops: [] };
  }

  const sb = new SupabaseDbAdapter(cfg.supabase.url, cfg.supabase.serviceRoleKey);
  const shops = await sb.listActiveProductionShops();
  if (shops.length === 0) {
    opts.log(
      "[import] mode=production nhưng không có shop nào (status='active' AND data_source='production') → chạy dry-run.\n",
    );
    return { db: mock, dbKind: "mock", shops: [] };
  }
  return { db: sb, dbKind: "supabase", shops };
}

/**
 * Xác định shop đích của report.
 * - --seller trỏ thẳng tới UUID shop
 * - account health: report có marketplaceId → khớp shop theo marketplace
 * - còn lại: nếu chỉ có ĐÚNG 1 shop production thì dùng shop đó
 * Không đoán khi mơ hồ (nhiều shop mà không rõ) — báo lỗi để người chạy chỉ định.
 */
function resolveShop(
  shops: ActiveShop[],
  sellerAccountId: string | null | undefined,
  marketplaceId: string | null | undefined,
): { shop: ActiveShop | null; error: string | null } {
  if (sellerAccountId) {
    const found = shops.find((s) => s.id === sellerAccountId);
    return found
      ? { shop: found, error: null }
      : { shop: null, error: `Không thấy shop ${sellerAccountId} trong danh sách production active` };
  }
  if (marketplaceId) {
    const found = shops.find((s) => s.marketplace === marketplaceId);
    if (found) return { shop: found, error: null };
    return { shop: null, error: `Không có shop production nào ở marketplace ${marketplaceId}` };
  }
  if (shops.length === 1) return { shop: shops[0], error: null };
  return {
    shop: null,
    error:
      `Có ${shops.length} shop production → phải chỉ định --seller=<uuid>. ` +
      `Danh sách: ${shops.map((s) => `${s.displayName}=${s.id}`).join(", ")}`,
  };
}

/** Module 4 — import report đơn hàng (+ returns tuỳ chọn). */
export async function runOrdersImport(opts: ImportOptions): Promise<ImportResult> {
  const log = (s: string) => opts.stdout?.write(s);
  const cfg = loadConfig();
  const { db, dbKind, shops } = await pickAdapter({
    dryRun: opts.dryRun === true,
    sellerAccountId: opts.sellerAccountId,
    log,
  });

  const shop = dbKind === "supabase" ? resolveShop(shops, opts.sellerAccountId, opts.marketplaceId) : { shop: null, error: null };
  if (shop.error) throw new Error(shop.error);
  const sellerAccountId = shop.shop?.id ?? opts.sellerAccountId ?? "00000000-0000-0000-0000-000000000001";

  const ordersReportText = readText(opts.file);
  const returnsReportText = opts.extraFile ? readText(opts.extraFile) : undefined;

  const snapshot = await runOrdersSync(
    {
      sellerAccountId,
      ordersReportText,
      returnsReportText,
      now: opts.now,
      marketplaceId: opts.marketplaceId ?? shop.shop?.marketplace ?? null,
    },
    db,
  );

  return {
    module: "orders",
    mode: cfg.mode,
    db: dbKind,
    sellerAccountId,
    summary: {
      shop: shop.shop?.displayName ?? "(dry-run)",
      // OrdersSyncResult cố tình KHÔNG trả mảng orders/returns (có thể rất lớn)
      // → dùng số đã ghi.
      orders: snapshot.ordersProcessed,
      returns: snapshot.returnsProcessed,
      units: snapshot.kpis.units,
      sales: snapshot.kpis.sales,
      fbmUnshipped: snapshot.kpis.fbmUnshipped,
      fbmQueue: snapshot.fbmQueue.length,
      dataSource: snapshot.dataSource,
      day: snapshot.daily.day,
      alerts: snapshot.alerts.length,
    },
    warnings: snapshot.warnings,
    errors: [],
  };
}

/** Module 6 — import report settlement V2 (đối soát theo SOP-10). */
export async function runFinanceImport(opts: ImportOptions): Promise<ImportResult> {
  const log = (s: string) => opts.stdout?.write(s);
  const cfg = loadConfig();
  const { db, dbKind, shops } = await pickAdapter({
    dryRun: opts.dryRun === true,
    sellerAccountId: opts.sellerAccountId,
    log,
  });
  if (dbKind === "supabase" && shops.length > 1 && !opts.sellerAccountId) {
    throw new Error(
      `Có ${shops.length} shop production → phải chỉ định --seller=<uuid> (report settlement không ghi rõ marketplace). ` +
        `Danh sách: ${shops.map((s) => `${s.displayName}=${s.id}`).join(", ")}`,
    );
  }
  const sellerAccountId =
    (opts.sellerAccountId ?? shops[0]?.id) ?? "00000000-0000-0000-0000-000000000001";

  const snapshot = await runFinanceSync(
    { sellerAccountId, settlementReportText: readText(opts.file), now: opts.now },
    db,
  );

  return {
    module: "finance",
    mode: cfg.mode,
    db: dbKind,
    sellerAccountId,
    summary: {
      settlementId: snapshot.settlement?.settlementId ?? null,
      depositDate: snapshot.settlement?.depositDate ?? null,
      transferAmount: snapshot.transferAmount,
      transferSource: snapshot.transferSource,
      calcTotal: snapshot.calcTotal,
      reconcileDiff: snapshot.reconcileDiff,
      takeRate: snapshot.takeRate,
      tacos: snapshot.tacos,
      lines: snapshot.metrics.lines,
      alerts: snapshot.alerts.length,
    },
    warnings: snapshot.warnings,
    errors: [],
  };
}

/** Module 7 — import report performance V2 (Account Health). */
export async function runAccountHealthImport(opts: ImportOptions): Promise<ImportResult> {
  const log = (s: string) => opts.stdout?.write(s);
  const cfg = loadConfig();
  const { db, dbKind, shops } = await pickAdapter({
    dryRun: opts.dryRun === true,
    sellerAccountId: opts.sellerAccountId,
    marketplaceId: opts.marketplaceId,
    log,
  });

  const shop = dbKind === "supabase" ? resolveShop(shops, opts.sellerAccountId, opts.marketplaceId) : { shop: null, error: null };
  if (shop.error) throw new Error(shop.error);
  const sellerAccountId = shop.shop?.id ?? opts.sellerAccountId ?? "00000000-0000-0000-0000-000000000001";

  const snapshot = await runAccountHealthSync(
    {
      sellerAccountId,
      reportJson: readText(opts.file),
      marketplaceId: opts.marketplaceId ?? shop.shop?.marketplace ?? null,
      now: opts.now,
    },
    db,
  );

  return {
    module: "account_health",
    mode: cfg.mode,
    db: dbKind,
    sellerAccountId,
    summary: {
      shop: shop.shop?.displayName ?? "(dry-run)",
      accountStatus: snapshot.accountStatus,
      ahrStatus: snapshot.ahrStatus,
      tone: snapshot.health.tone,
      score: snapshot.health.score,
      openIssues: snapshot.health.openIssues.length,
      criticalIssues: snapshot.health.criticalIssues,
      rates: snapshot.health.rateTones.map((r) => `${r.key}=${r.rate ?? "—"} (${r.tone})`),
      alerts: snapshot.alerts.length,
    },
    warnings: snapshot.warnings,
    errors: [],
  };
}
