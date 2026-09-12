/**
 * Runner CLI cho Module 1 — đồng bộ listing từ report (L1 / L2 / L4).
 *
 *   worker:listings-sync -- --all=<merchant-listings-all.tsv>
 *                            [--inactive=<merchant-listings-inactive.tsv>]
 *                            [--stranded=<stranded-inventory.tsv>]
 *                            [--seller=<uuid shop>] [--details] [--detail-limit=50]
 *                            [--dry-run]
 *
 * NGUỒN DỮ LIỆU (đúng tên report của Amazon — xem docs/ke-hoach-trien-khai-theo-module.md):
 *   • GET_MERCHANT_LISTINGS_ALL_DATA      → toàn bộ SKU + trạng thái + giá + tồn  (L1)
 *   • GET_MERCHANT_LISTINGS_INACTIVE_DATA → SKU inactive (đối chiếu lệch với ALL)  (L4)
 *   • GET_STRANDED_INVENTORY_UI_DATA      → tồn không gắn listing active + lý do   (L4)
 *   • getListingsItem(includedData=issues)→ issue ĐÚNG MÃ Amazon, chỉ có khi gọi API (L2)
 *
 * Report không có cột "issues" — muốn L2 hiện mã lỗi thật thì phải gọi
 * getListingsItem. `--details` bật việc đó (chỉ khi có credentials + không dry-run),
 * giới hạn `--detail-limit` lần gọi vì rate limit 5 req/s · burst 10.
 *
 * AN TOÀN DỮ LIỆU (giống mọi runner khác của worker): CHỈ ghi DB thật + gọi
 * Amazon khi `cfg.mode === "production"` và không --dry-run. Còn lại chạy trong
 * bộ nhớ (MockDbAdapter) và in bản tóm tắt để đối chiếu.
 */

import { readFileSync } from "node:fs";

import { ListingsItemsClient } from "../amazon/listings.ts";
import { LwaTokenManager } from "../amazon/lwa.ts";
import { loadConfig } from "../config.ts";
import { MockDbAdapter, type ActiveShop, type DbAdapter } from "../db/adapter.ts";
import { SupabaseDbAdapter } from "../db/supabase.ts";
import {
  DEFAULT_DETAIL_LIMIT,
  runListingsSync,
  type ListingsSyncReport,
} from "../jobs/listings-sync.job.ts";

export type ListingsSyncCliResult = {
  mode: string;
  db: "supabase" | "mock";
  sellerAccountId: string;
  summary: Record<string, unknown>;
  warnings: string[];
  report: ListingsSyncReport | null;
};

function pickShop(
  shops: ActiveShop[],
  sellerAccountId: string | null | undefined,
): { shop: ActiveShop | null; error: string | null } {
  if (sellerAccountId) {
    const found = shops.find((s) => s.id === sellerAccountId);
    return found ? { shop: found, error: null } : { shop: null, error: `Không thấy shop ${sellerAccountId}` };
  }
  if (shops.length === 1) return { shop: shops[0], error: null };
  return {
    shop: null,
    error:
      `Có ${shops.length} shop production → phải chỉ định --seller=<uuid>. ` +
      `Danh sách: ${shops.map((s) => `${s.displayName}=${s.id}`).join(", ")}`,
  };
}

/**
 * Gọi liên tiếp getListingsItem thì phải tự giới hạn: 5 req/s (burst 10).
 * Giữ 220ms giữa 2 lần gọi ≈ 4.5 rps — dưới trần, không cần đọc header.
 */
export function throttle<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  minGapMs: number,
): (...args: A) => Promise<R> {
  let last = 0;
  return async (...args: A) => {
    const wait = last + minGapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    return fn(...args);
  };
}

export async function runListingsSyncCli(opts: {
  allFile?: string | null;
  inactiveFile?: string | null;
  strandedFile?: string | null;
  sellerAccountId?: string | null;
  /** gọi getListingsItem để lấy issues thật cho SKU có vấn đề (L2) */
  withDetails?: boolean;
  detailLimit?: number;
  dryRun?: boolean;
  stdout?: { write: (s: string) => void };
  /** Cho test: tiêm adapter */
  adapter?: DbAdapter;
}): Promise<ListingsSyncCliResult> {
  const log = (s: string) => opts.stdout?.write(s);
  const cfg = loadConfig();
  const dryRun = opts.dryRun === true;

  const read = (p?: string | null) => (p ? readFileSync(p, "utf8") : undefined);
  const allText = read(opts.allFile);
  const inactiveText = read(opts.inactiveFile);
  const strandedText = read(opts.strandedFile);

  if (!allText && !inactiveText && !strandedText) {
    log(
      "[listings:sync] chưa có report để nạp.\n" +
        "  → Tải từ Seller Central (Reports → Inventory) hoặc Reports API rồi truyền:\n" +
        "      --all=<GET_MERCHANT_LISTINGS_ALL_DATA.tsv>\n" +
        "      [--inactive=<GET_MERCHANT_LISTINGS_INACTIVE_DATA.tsv>]\n" +
        "      [--stranded=<GET_STRANDED_INVENTORY_UI_DATA.tsv>]\n" +
        "  → Thiếu --all thì chỉ ghi được SKU stranded/inactive, L1 sẽ không đủ danh sách.\n",
    );
    return {
      mode: cfg.mode,
      db: "mock",
      sellerAccountId: opts.sellerAccountId ?? "(chưa chọn)",
      summary: { note: "chưa có report để xử lý" },
      warnings: [],
      report: null,
    };
  }

  const printSummary = (label: string, report: ListingsSyncReport, dbKind: "supabase" | "mock") => {
    log(
      `\n[listings:sync] ${label} · db=${dbKind}\n` +
        `  listing đã nạp      ${report.listingsProcessed}\n` +
        `  inactive/suppressed ${report.inactiveCount}\n` +
        `  stranded            ${report.strandedCount}\n` +
        `  hàng đợi L4         ${report.queue.length} SKU\n` +
        `  issues thật (L2)    ${report.detailsFetched} SKU đã gọi getListingsItem · ${report.withErrors} SKU có lỗi ERROR\n` +
        `  alert               ${report.alerts.length}\n`,
    );
    for (const q of report.queue.slice(0, 10)) {
      log(`    - ${q.sku} [${q.status}] ${q.cause}\n`);
    }
    if (report.queue.length > 10) log(`    … +${report.queue.length - 10} SKU khác (xem /listing/queue)\n`);
    for (const w of report.warnings.slice(0, 8)) log(`  ⚠ ${w}\n`);
    if (dbKind === "mock") {
      log("  ⚠ chạy trong bộ nhớ (dry-run / chưa đủ credentials) — KHÔNG ghi DB thật.\n");
    }
  };

  // ---- Đường mock / dry-run: không gọi Amazon, không ghi DB -----------------
  if (dryRun || cfg.mode !== "production" || !cfg.supabase) {
    if (opts.withDetails && cfg.mode !== "production") {
      log("[listings:sync] --details bị bỏ qua: cần AMAZON_LWA_* + Supabase (mode=production) mới gọi được getListingsItem.\n");
    }
    const adapter = opts.adapter ?? new MockDbAdapter();
    const report = await runListingsSync({
      sellerAccountId: opts.sellerAccountId ?? "00000000-0000-0000-0000-000000000001",
      allReportText: allText ?? "",
      inactiveReportText: inactiveText,
      strandedReportText: strandedText,
      adapter,
    });
    printSummary(`mode=${cfg.mode}${dryRun ? " · --dry-run" : ""}`, report, "mock");
    return {
      mode: cfg.mode,
      db: "mock",
      sellerAccountId: report.sellerAccountId,
      summary: {
        listings: report.listingsProcessed,
        queue: report.queue.length,
        stranded: report.strandedCount,
        dryRun: true,
      },
      warnings: report.warnings,
      report,
    };
  }

  // ---- Đường production: ghi DB thật, tuỳ chọn gọi Amazon -------------------
  const db: DbAdapter = opts.adapter ?? new SupabaseDbAdapter(cfg.supabase.url, cfg.supabase.serviceRoleKey);
  const shops = await db.listActiveProductionShops();
  const { shop, error } = pickShop(shops, opts.sellerAccountId);
  if (!shop) throw new Error(error ?? "Không xác định được shop");

  // L2: chỉ gọi được khi có LWA credentials (mode=production đã đảm bảo có supabase)
  let fetchDetail: ((sku: string) => Promise<import("../amazon/listings.ts").ListingsItem>) | undefined;
  if (opts.withDetails && cfg.lwa) {
    const client = new ListingsItemsClient({
      host: cfg.spApiHost,
      lwa: new LwaTokenManager({
        clientId: cfg.lwa.clientId,
        clientSecret: cfg.lwa.clientSecret,
        refreshToken: cfg.lwa.refreshToken,
      }),
    });
    fetchDetail = throttle(
      (sku: string) =>
        client.getListingsItem({
          sellerId: shop.sellerId,
          sku,
          marketplaceId: shop.marketplace,
          includedData: ["summaries", "issues"],
          issueLocale: "en_US",
        }),
      220,
    );
  } else if (opts.withDetails) {
    log("[listings:sync] --details bị bỏ qua: thiếu AMAZON_LWA_* nên không gọi được getListingsItem → L2 để trống issues.\n");
  }

  const report = await runListingsSync({
    sellerAccountId: shop.id,
    allReportText: allText ?? "",
    inactiveReportText: inactiveText,
    strandedReportText: strandedText,
    adapter: db,
    fetchDetail,
    detailLimit: opts.detailLimit ?? DEFAULT_DETAIL_LIMIT,
  });

  printSummary(`shop=${shop.displayName} (${shop.sellerId})`, report, "supabase");
  if (!opts.allFile) {
    log("  ⚠ không có --all: chỉ ghi SKU từ report inactive/stranded, L1 sẽ thiếu phần lớn danh sách.\n");
  }

  return {
    mode: cfg.mode,
    db: "supabase",
    sellerAccountId: shop.id,
    summary: {
      shop: shop.displayName,
      listings: report.listingsProcessed,
      inactive: report.inactiveCount,
      stranded: report.strandedCount,
      queue: report.queue.length,
      detailsFetched: report.detailsFetched,
      withErrors: report.withErrors,
      alerts: report.alerts.length,
    },
    warnings: report.warnings,
    report,
  };
}
