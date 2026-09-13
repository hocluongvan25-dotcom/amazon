#!/usr/bin/env node
/**
 * CLI entry cho worker.
 * Load .env.local từ thư mục web/ (cùng file env với app) nếu có.
 * Chạy: npm run worker:inventory-sync
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInventorySyncAll } from "./runtime/run-inventory-sync.ts";
import {
  runAccountHealthImport,
  runFinanceImport,
  runOrdersImport,
} from "./runtime/run-report-import.ts";
import { runListingPublishCli } from "./runtime/run-listing-publish.ts";
import { runListingSchemaCli } from "./runtime/run-listing-schema.ts";
import { runFinanceClaimsCli } from "./runtime/run-finance-claims.ts";
import { runListingsSyncCli } from "./runtime/run-listings-sync.ts";
import { runInventoryFcSyncCli } from "./runtime/run-inventory-fc-sync.ts";
import { runReportPullCli } from "./runtime/run-report-pull.ts";
import { runAdsPullCli, runAdsSyncCli } from "./runtime/run-ads.ts";
import { runAdsPullCli, runAdsSyncCli, runOauthSoonCli } from "./runtime/run-ads.ts";

/** Đọc tham số dạng --key=value / --flag (không có giá trị) */
function parseArgs(argv: string[]): { flags: Set<string>; values: Record<string, string> } {
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    if (m[2] === undefined) flags.add(m[1]);
    else values[m[1]] = m[2];
  }
  return { flags, values };
}

function printImportResult(r: {
  module: string;
  mode: string;
  db: string;
  sellerAccountId: string;
  summary: Record<string, unknown>;
  warnings: string[];
}): void {
  process.stdout.write(
    `\n[${r.module}:sync] mode=${r.mode} · db=${r.db} · seller=${r.sellerAccountId}\n`,
  );
  for (const [k, v] of Object.entries(r.summary)) {
    process.stdout.write(`  ${k.padEnd(16)} ${Array.isArray(v) ? v.join(", ") : String(v)}\n`);
  }
  if (r.warnings.length > 0) {
    process.stdout.write(`  cảnh báo (${r.warnings.length}):\n`);
    for (const w of r.warnings) process.stdout.write(`    - ${w}\n`);
  }
  if (r.db === "mock") {
    process.stdout.write(
      "  \u26a0 chạy trong bộ nhớ (dry-run / chưa đủ credentials) — KHÔNG ghi DB thật.\n",
    );
  }
}

// Load .env.local từ web/ nếu có (đồng bộ env với web app)
function loadDotEnv() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../../web/.env.local"),
    resolve(here, "../../.env.local"),
    resolve(here, "../.env.local"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      const k = m[1];
      let v = m[2];
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (process.env[k] === undefined) process.env[k] = v;
    }
    return p;
  }
  return null;
}
const loaded = loadDotEnv();

const cmd = process.argv[2];

async function main() {
  switch (cmd) {
    case "inventory:sync": {
      if (loaded) process.stderr.write(`[worker] loaded env from ${loaded}\n`);
      const result = await runInventorySyncAll({ stdout: process });
      if (result.errors.length > 0) process.exitCode = 1;
      break;
    }
    case "orders:sync": {
      if (loaded) process.stderr.write(`[worker] loaded env from ${loaded}\n`);
      const { values, flags } = parseArgs(process.argv.slice(3));
      if (!values.file) {
        process.stderr.write("Thiếu --file=<orders.tsv>. Chạy: worker orders:sync --file=orders.tsv [--returns=returns.tsv] [--seller=<uuid>] [--dry-run]\n");
        process.exitCode = 2;
        break;
      }
      printImportResult(
        await runOrdersImport({
          file: values.file,
          extraFile: values.returns ?? null,
          sellerAccountId: values.seller ?? null,
          marketplaceId: values.marketplace ?? null,
          dryRun: flags.has("dry-run"),
          stdout: process.stdout,
        }),
      );
      break;
    }
    case "finance:sync": {
      if (loaded) process.stderr.write(`[worker] loaded env from ${loaded}\n`);
      const { values, flags } = parseArgs(process.argv.slice(3));
      if (!values.file) {
        process.stderr.write("Thiếu --file=<settlement.tsv>. Chạy: worker finance:sync --file=settlement.tsv [--seller=<uuid>] [--dry-run]\n");
        process.exitCode = 2;
        break;
      }
      printImportResult(
        await runFinanceImport({
          file: values.file,
          sellerAccountId: values.seller ?? null,
          dryRun: flags.has("dry-run"),
          stdout: process.stdout,
        }),
      );
      break;
    }
    case "account-health:sync": {
      if (loaded) process.stderr.write(`[worker] loaded env from ${loaded}\n`);
      const { values, flags } = parseArgs(process.argv.slice(3));
      if (!values.file) {
        process.stderr.write("Thiếu --file=<performance.json>. Chạy: worker account-health:sync --file=performance.json [--seller=<uuid>] [--marketplace=ATVPDKIKX0DER] [--dry-run]\n");
        process.exitCode = 2;
        break;
      }
      printImportResult(
        await runAccountHealthImport({
          file: values.file,
          sellerAccountId: values.seller ?? null,
          marketplaceId: values.marketplace ?? null,
          dryRun: flags.has("dry-run"),
          stdout: process.stdout,
        }),
      );
      break;
    }
    case "listing:publish": {
      // L3: gửi các bản nháp ĐÃ DUYỆT vào hàng đợi publish lên Amazon
      const { values, flags } = parseArgs(process.argv.slice(3));
      const result = await runListingPublishCli({
        sellerAccountId: values["seller"] ?? null,
        limit: values["limit"] ? Number(values["limit"]) : undefined,
        dryRun: flags.has("dry-run"),
        stdout: process.stdout,
      });
      if (result.db === "mock") {
        process.stdout.write("  ⚠ chạy trong bộ nhớ (dry-run / chưa đủ credentials) — KHÔNG gửi Amazon.\n");
      }
      break;
    }
    case "listing:schema": {
      // L3: tải JSON Schema product type (getDefinitionsProductType) vào cache
      // để web dựng form động (required/maxLength/enum thật của Amazon)
      const { values, flags } = parseArgs(process.argv.slice(3));
      const result = await runListingSchemaCli({
        sellerAccountId: values["seller"] ?? null,
        productType: values["product-type"] ?? null,
        marketplaceId: values["marketplace"],
        requirements: values["requirements"],
        dryRun: flags.has("dry-run"),
        stdout: process.stdout,
      });
      if (result.db === "mock") {
        process.stdout.write("  ⚠ chạy trong bộ nhớ (dry-run / chưa đủ credentials) — KHÔNG gọi Amazon.\n");
      }
      break;
    }
    case "listings:sync": {
      // Module 1: nạp report listing → L1 (danh sách) + L2 (issues) + L4 (queue)
      if (loaded) process.stderr.write(`[worker] loaded env from ${loaded}\n`);
      const { values, flags } = parseArgs(process.argv.slice(3));
      if (!values.all && !values.inactive && !values.stranded) {
        process.stderr.write(
          "Thiếu report. Chạy: worker listings:sync --all=<merchant-listings-all.tsv>" +
            " [--inactive=<inactive.tsv>] [--stranded=<stranded.tsv>]" +
            " [--seller=<uuid>] [--details] [--detail-limit=50] [--dry-run]\n",
        );
        process.exitCode = 2;
        break;
      }
      // Runner tự in bản tóm tắt (đã có nhãn db=mock/supabase) → không in trùng
      await runListingsSyncCli({
        allFile: values.all ?? null,
        inactiveFile: values.inactive ?? null,
        strandedFile: values.stranded ?? null,
        sellerAccountId: values.seller ?? null,
        withDetails: flags.has("details"),
        detailLimit: values["detail-limit"] ? Number(values["detail-limit"]) : undefined,
        dryRun: flags.has("dry-run"),
        stdout: process.stdout,
      });
      break;
    }
    case "inventory:fc": {
      // Module 3 nâng cao (0018): phân bổ tồn theo FC (I2) + lịch sử nhận hàng
      if (loaded) process.stderr.write(`[worker] loaded env from ${loaded}\n`);
      const { values, flags } = parseArgs(process.argv.slice(3));
      if (!values.fc && !values.receipts) {
        process.stderr.write(
          "Thiếu report. Chạy: worker inventory:fc --fc=<fba-daily-inventory-history.tsv>" +
            " [--receipts=<fba-received-inventory.tsv>] [--seller=<uuid>] [--top-fc=10] [--dry-run]\n",
        );
        process.exitCode = 2;
        break;
      }
      // Runner tự in bản tóm tắt (kèm nhãn db=mock/supabase) → không in trùng
      await runInventoryFcSyncCli({
        fcFile: values.fc ?? null,
        receiptsFile: values.receipts ?? null,
        sellerAccountId: values.seller ?? null,
        topFcLimit: values["top-fc"] ? Number(values["top-fc"]) : undefined,
        dryRun: flags.has("dry-run"),
        stdout: process.stdout,
      });
      break;
    }
    case "reports:pull": {
      // Module 3 nâng cao (0019): TỰ KÉO 4 report FBA qua Reports API, hoặc nạp
      // file TSV local. Đây là lệnh mà Vercel Cron (/api/cron/report-pull) chạy
      // mỗi ngày — CLI để nạp tay / kiểm tra / nạp dữ liệu lịch sử.
      if (loaded) process.stderr.write(`[worker] loaded env from ${loaded}\n`);
      const { values, flags } = parseArgs(process.argv.slice(3));
      await runReportPullCli({
        type: values.type ?? null,
        days: values.days ? Number(values.days) : null,
        sellerAccountId: values.seller ?? null,
        files: {
          fc: values.fc ?? null,
          receipts: values.receipts ?? null,
          "storage-fees": values["storage-fees"] ?? null,
          noncompliance: values.noncompliance ?? null,
        },
        dryRun: flags.has("dry-run"),
        pollAttempts: values.poll ? Number(values.poll) : undefined,
        stdout: process.stdout,
      });
      break;
    }
    case "ads:sync": {
      // Module 5 phần 1: đồng bộ CẤU TRÚC quảng cáo (profile → campaign →
      // ad group → keyword/target). Chạy trước ads:pull để có ads_profile_id.
      if (loaded) process.stderr.write(`[worker] loaded env from ${loaded}\n`);
      const { values, flags } = parseArgs(process.argv.slice(3));
      const result = await runAdsSyncCli({
        sellerAccountId: values.seller ?? null,
        dryRun: flags.has("dry-run"),
        stdout: process.stdout,
      });
      if (result.needsReauth.length > 0 || result.failed > 0) process.exitCode = 1;
      break;
    }
    case "ads:pull": {
      // Module 5 phần 1: TỰ KÉO 5 report Amazon Ads (Reporting API v3) hoặc nạp
      // file JSON đã giải nén. Sau khi nhập: cảnh báo acos_over_target /
      // budget_exhausted + budget_events + lấp ads_spend cho F4 (TACOS thật).
      if (loaded) process.stderr.write(`[worker] loaded env from ${loaded}\n`);
      const { values, flags } = parseArgs(process.argv.slice(3));
      const result = await runAdsPullCli({
        kind: values.kind ?? null,
        days: values.days ? Number(values.days) : null,
        sellerAccountId: values.seller ?? null,
        files: {
          campaigns: values.campaigns ?? null,
          targeting: values.targeting ?? null,
          "search-terms": values["search-terms"] ?? null,
          "advertised-products": values["advertised-products"] ?? null,
          "purchased-products": values["purchased-products"] ?? null,
        },
        dryRun: flags.has("dry-run"),
        pollAttempts: values.poll ? Number(values.poll) : undefined,
        fireAlerts: !flags.has("no-alerts"),
        applySpend: !flags.has("no-spend"),
        stdout: process.stdout,
      });
      if (result.counts.failed > 0 || result.needsReauth.length > 0) process.exitCode = 1;
      break;
    }
    case "oauth:soon": {
      // Module 0: shop sắp/đã hết hạn refresh token (365 ngày) — cron nhắc
      // re-authorize trước khi Ads/SP-API ngừng chạy (SOP-11).
      if (loaded) process.stderr.write(`[worker] loaded env from ${loaded}\n`);
      const { values, flags } = parseArgs(process.argv.slice(3));
      const result = await runOauthSoonCli({
        days: values.days ? Number(values.days) : null,
        // Mặc định chỉ ĐỌC. Cron mới là nơi tạo cảnh báo + đánh dấu đã nhắc.
        mark: flags.has("mark"),
        stdout: process.stdout,
      });
      if (result.count > 0) process.exitCode = 1;
      break;
    }
    case "ads:sync": {
      // Module 5 P1: đồng bộ CẤU TRÚC quảng cáo (profile → campaign → ad group →
      // keyword/target) qua Ads Campaign Management v3. Chạy trước ads:pull.
      if (loaded) process.stderr.write(`[worker] loaded env from ${loaded}\n`);
      const { values, flags } = parseArgs(process.argv.slice(3));
      const result = await runAdsSyncCli({
        sellerAccountId: values.seller ?? null,
        dryRun: flags.has("dry-run"),
        stdout: process.stdout,
      });
      if (result.failed > 0 || result.needsReauth.length > 0) process.exitCode = 1;
      break;
    }
    case "ads:pull": {
      // Module 5 P1: TỰ KÉO 5 report metrics (Reporting API v3) hoặc nạp file JSON.
      // Sau khi nhập: cảnh báo acos_over_target/budget_exhausted + sự kiện ngân sách
      // + lấp finance.sku_profit_daily.ads_spend (F4/TACOS).
      if (loaded) process.stderr.write(`[worker] loaded env from ${loaded}\n`);
      const { values, flags } = parseArgs(process.argv.slice(3));
      const result = await runAdsPullCli({
        kind: values.kind ?? null,
        days: values.days ? Number(values.days) : null,
        sellerAccountId: values.seller ?? null,
        files: {
          campaigns: values.campaigns ?? null,
          targeting: values.targeting ?? null,
          "search-terms": values["search-terms"] ?? null,
          "advertised-products": values["advertised-products"] ?? null,
          "purchased-products": values["purchased-products"] ?? null,
        },
        dryRun: flags.has("dry-run"),
        pollAttempts: values.poll ? Number(values.poll) : undefined,
        fireAlerts: !flags.has("no-alerts"),
        applySpend: !flags.has("no-spend"),
        stdout: process.stdout,
      });
      if (result.counts.failed > 0 || result.needsReauth.length > 0) process.exitCode = 1;
      break;
    }
    case "finance:claims": {
      // Module 6 Đợt 2: F3 bồi hoàn FBA (SOP-09) + F4 lợi nhuận SKU
      const { values, flags } = parseArgs(process.argv.slice(3));
      const result = await runFinanceClaimsCli({
        sellerAccountId: values["seller"] ?? null,
        ledgerFile: values["ledger"] ?? null,
        reimbursementsFile: values["reimbursements"] ?? null,
        month: values["month"] ?? null,
        dryRun: flags.has("dry-run"),
        stdout: process.stdout,
      });
      if (result.db === "mock") {
        process.stdout.write("  ⚠ chạy trong bộ nhớ (dry-run / chưa đủ credentials) — KHÔNG ghi DB thật.\n");
      }
      break;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(
        [
          "VEXIM Ops — worker CLI",
          "",
          "  inventory:sync       Tầng 2: đồng bộ FBA Inventory cho tất cả shop production active",
          "  orders:sync          Nạp report đơn hàng (Module 4): --file=orders.tsv [--returns=returns.tsv]",
          "  finance:sync         Nạp report settlement V2 (Module 6): --file=settlement.tsv",
          "  account-health:sync  Nạp report performance V2 (Module 7): --file=performance.json",
          "  listings:sync        Nạp report listing (Module 1 → L1/L2/L4): --all=listings.tsv [--inactive=…] [--stranded=…] [--details]",
          "  listing:publish      L3: gửi bản nháp đã duyệt lên Amazon (--seller=<uuid> [--limit=20])",
          "  listing:schema       L3: tải JSON Schema product type cho form động (--product-type=LUGGAGE)",
          "  finance:claims       F3+F4: claim bồi hoàn FBA + lợi nhuận SKU (--ledger=<file> --reimbursements=<file>)",
          "  inventory:fc         M3 nâng cao: phân bổ tồn theo FC + lịch sử nhận hàng (--fc=<file> [--receipts=<file>])",
          "  ads:sync             M5 P1: đồng bộ cấu trúc Amazon Ads (profile → campaign → ad group → target)",
          "  ads:pull             M5 P1: TỰ KÉO 5 report Amazon Ads (--kind=all|campaigns|targeting|search-terms|advertised-products|purchased-products",
          "                       [--days=30] [--poll=3]) + cảnh báo ACOS/ngân sách + lấp ads_spend (F4)",
          "  oauth:soon           M0: shop sắp hết hạn token (--days=30 [--mark]) — --mark mới tạo cảnh báo",
          "  ads:sync             M5 P1: đồng bộ cấu trúc Amazon Ads (profile → campaign → ad group → target)",
          "  ads:pull             M5 P1: TỰ KÉO 5 report Amazon Ads (--kind=all|campaigns|targeting|search-terms|advertised-products|purchased-products",
          "                       [--days=30] [--poll=3]) + cảnh báo ACOS/ngân sách + lấp ads_spend (F4/TACOS)",
          "  reports:pull         M3 nâng cao: TỰ KÉO 4 report FBA qua Reports API (--type=all|fc|receipts|storage-fees|noncompliance",
          "                       [--days=7] [--poll=3]) hoặc nạp file: --storage-fees=<tsv> --noncompliance=<tsv>",
          "",
          "Cờ dùng chung: --seller=<uuid> (bắt buộc khi >1 shop) · --dry-run (chỉ chạy trong bộ nhớ)",
          "",
          "Env đọc từ web/.env.local (hoặc biến môi trường hệ thống):",
          "  AMAZON_LWA_CLIENT_ID / SECRET / REFRESH_TOKEN  (SP-API)",
          "  AMAZON_ADS_CLIENT_ID / SECRET / REFRESH_TOKEN  (Amazon Ads — đăng ký RIÊNG)",
          "  SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_URL",
          "  AMAZON_SP_API_REGION=NA (mặc định) · AMAZON_ADS_REGION=NA (mặc định cho Ads)",
          "",
          "Không có credentials → tự động DEMO MODE với dữ liệu giả.",
          "",
        ].join("\n"),
      );
      break;
    default:
      process.stderr.write(`Lệnh không xác định: ${cmd}\nChạy worker --help.\n`);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error("[worker] lỗi không xử lý được:", e);
  process.exit(1);
});
