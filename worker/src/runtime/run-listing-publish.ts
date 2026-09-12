/**
 * Runner CLI cho L3 — publish listing lên Amazon.
 *
 * AN TOÀN DỮ LIỆU (theo đúng nguyên tắc của run-inventory-sync.ts và
 * run-report-import.ts): CHỈ gửi Amazon + ghi DB thật khi
 * `cfg.mode === "production"` và người chạy không truyền --dry-run.
 * Mọi trường hợp khác chạy trong bộ nhớ (MockDbAdapter) — không có hàng đợi
 * thật nên chỉ in thông báo, tuyệt đối không gọi SP-API.
 *
 * Chạy: npm run worker:listing-publish -- --seller=<uuid shop> [--limit=20] [--dry-run]
 */

import { ListingsItemsClient } from "../amazon/listings.ts";
import { LwaTokenManager } from "../amazon/lwa.ts";
import { loadConfig } from "../config.ts";
import { MockDbAdapter, type ActiveShop, type DbAdapter } from "../db/adapter.ts";
import { SupabaseDbAdapter } from "../db/supabase.ts";
import { runListingPublish, type ListingPublishReport } from "../jobs/listing-publish.job.ts";

export type ListingPublishCliResult = {
  mode: string;
  db: "supabase" | "mock";
  sellerAccountId: string;
  summary: Record<string, unknown>;
  report: ListingPublishReport | null;
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

export async function runListingPublishCli(opts: {
  sellerAccountId?: string | null;
  limit?: number;
  dryRun?: boolean;
  stdout?: { write: (s: string) => void };
}): Promise<ListingPublishCliResult> {
  const log = (s: string) => opts.stdout?.write(s);
  const cfg = loadConfig();
  const dryRun = opts.dryRun === true;

  if (dryRun || cfg.mode !== "production" || !cfg.supabase || !cfg.lwa) {
    log(
      `[listing:publish] mode=${cfg.mode}${dryRun ? " · --dry-run" : ""} → chạy bộ nhớ, KHÔNG gọi Amazon, KHÔNG ghi DB.\n` +
        "  (Cần AMAZON_LWA_* + SUPABASE_SERVICE_ROLE_KEY trong web/.env.local để publish thật.)\n",
    );
    return {
      mode: cfg.mode,
      db: "mock",
      sellerAccountId: opts.sellerAccountId ?? "(chưa chọn)",
      summary: { note: "dry-run/mock — không có hàng đợi thật để xử lý" },
      report: null,
    };
  }

  const db: DbAdapter = new SupabaseDbAdapter(cfg.supabase.url, cfg.supabase.serviceRoleKey);
  const shops = await db.listActiveProductionShops();
  const { shop, error } = pickShop(shops, opts.sellerAccountId);
  if (!shop) throw new Error(error ?? "Không xác định được shop");

  const client = new ListingsItemsClient({
    host: cfg.spApiHost,
    lwa: new LwaTokenManager({
      clientId: cfg.lwa.clientId,
      clientSecret: cfg.lwa.clientSecret,
      refreshToken: cfg.lwa.refreshToken,
    }),
  });

  const report = await runListingPublish({
    sellerAccountId: shop.id,
    sellerId: shop.sellerId,
    client,
    adapter: db,
    limit: opts.limit ?? 20,
    issueLocale: "en_US",
    dryRun,
  });

  log(
    `\n[listing:publish] shop=${shop.displayName} (${shop.sellerId})\n` +
      `  xử lý ${report.processed} · ACCEPTED ${report.accepted} · INVALID ${report.invalid} · ` +
      `CHẶN hạn chế ${report.blocked} · LỖI ${report.failed}\n`,
  );
  for (const item of report.items) {
    log(`    - ${item.sku}: ${item.status}${item.note ? ` — ${item.note}` : ""}\n`);
  }
  if (report.blocked > 0) {
    log("  ⚠ Có listing bị Amazon hạn chế danh mục — xem cột block_reason trong vexim_listing_publish_queue.\n");
  }

  return {
    mode: cfg.mode,
    db: "supabase",
    sellerAccountId: shop.id,
    summary: {
      shop: shop.displayName,
      processed: report.processed,
      accepted: report.accepted,
      invalid: report.invalid,
      blocked: report.blocked,
      failed: report.failed,
    },
    report,
  };
}

/** Dùng cho test/không có credentials */
export function createMockPublishAdapter(): DbAdapter {
  return new MockDbAdapter();
}
