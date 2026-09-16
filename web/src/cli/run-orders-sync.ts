/**
 * CLI đồng bộ ĐƠN HÀNG (Module 4 — Orders API v0) chạy từ máy/VPS có mạng ra
 * Amazon + Supabase, KHÔNG cần Next.js server (không bị trần 60s của Vercel).
 *
 *   cd worker && npm run worker:orders-sync -- --days=7
 *   cd worker && npm run worker:orders-sync -- --days=30 --maxItems=1000
 *   cd worker && npm run worker:orders-sync -- --shop=<uuid> --dryRun
 *   cd worker && npm run worker:orders-sync -- --report=/tmp/all-orders.txt [--returns=/tmp/returns.txt]
 *
 * Tự nạp .env.local rồi .env (không ghi đè biến đã có trong môi trường).
 * Thiếu credential ⇒ chạy DEMO trong bộ nhớ và nói rõ, KHÔNG ghi DB.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..", "..");

for (const f of [".env.local", ".env"]) {
  const p = join(webRoot, f);
  if (!existsSync(p)) continue;
  for (const rawLine of readFileSync(p, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

const { runOrdersSyncAll } = await import("../lib/worker/run-orders-sync.ts");

const args = process.argv.slice(2);
function flag(name: string): string | null {
  const withEq = args.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(name.length + 3);
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith("--")) return args[idx + 1];
  return null;
}
const has = (name: string): boolean => args.includes(`--${name}`);

const days = flag("days");
const maxItems = flag("maxItems");
const shop = flag("shop");
const dryRun = has("dryRun") || flag("dryRun") === "1";

const reportPath = flag("report");
const returnsPath = flag("returns");

if (reportPath) {
  // TẦNG 3 — ĐỐI SOÁT BẰNG REPORT: GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL
  // là đường DUY NHẤT có `ship-state`/`ship-country` (Orders API khoá PII địa chỉ).
  // Dùng khi cần backfill dài hoặc khi delta API bị hoãn vì trần tốc độ.
  const { loadConfig } = await import("../lib/worker/config.ts");
  const { SupabaseDbAdapter } = await import("../lib/worker/db/supabase.ts");
  const { runOrdersSync } = await import("../lib/worker/jobs/orders-sync.job.ts");

  const cfg = loadConfig();
  if (cfg.mode !== "production" || !cfg.supabase) {
    console.error(
      "[orders-sync] Tầng report cần SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (mode=production) để GHI. " +
        "Thiếu ⇒ không chạy để tránh tưởng đã đồng bộ.",
    );
    process.exit(1);
  }
  if (!existsSync(reportPath)) {
    console.error(`Không đọc được file report: ${reportPath}`);
    process.exit(1);
  }
  const ordersReportText = readFileSync(reportPath, "utf8");
  const returnsReportText = returnsPath && existsSync(returnsPath) ? readFileSync(returnsPath, "utf8") : undefined;
  const adapter = new SupabaseDbAdapter(cfg.supabase.url, cfg.supabase.serviceRoleKey);
  const shops = await adapter.listActiveProductionShops();
  if (shops.length === 0) {
    console.log("[orders-sync] không có shop production nào để ghi report.");
    process.exit(0);
  }
  for (const s of shops) {
    const out = await runOrdersSync(
      { sellerAccountId: s.id, ordersReportText, returnsReportText },
      adapter,
    );
    console.log(`[orders-sync] report → ${s.displayName}: ${out.ordersProcessed} đơn · ${out.returnsProcessed} hoàn/trả`);
  }
  process.exit(0);
}

const res = await runOrdersSyncAll({
  days: days ? Number(days) : null,
  maxItemFetches: maxItems ? Number(maxItems) : null,
  sellerAccountId: shop,
  dryRun,
  stdout: { write: (s: string) => process.stdout.write(s) },
});

console.log(
  `\n[orders-sync] xong: ${res.ordersUpserted} đơn · ${res.itemsUpserted} dòng hàng · ${res.pages} trang` +
    ` · bỏ qua ${res.skipped} · lỗi ${res.failed}` +
    (res.deferred > 0 ? ` · hoãn item ${res.deferred} đơn` : "") +
    (res.throttled ? " · CÓ lần bị hoãn vì trần tốc độ" : ""),
);
process.exit(res.failed > 0 ? 1 : 0);
