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
          "",
          "Cờ dùng chung: --seller=<uuid> (bắt buộc khi >1 shop) · --dry-run (chỉ chạy trong bộ nhớ)",
          "",
          "Env đọc từ web/.env.local (hoặc biến môi trường hệ thống):",
          "  AMAZON_LWA_CLIENT_ID / SECRET / REFRESH_TOKEN",
          "  SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_URL",
          "  AMAZON_SP_API_REGION=NA (mặc định)",
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
