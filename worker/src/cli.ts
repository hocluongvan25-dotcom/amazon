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
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(
        [
          "VEXIM Ops — worker CLI",
          "",
          "  inventory:sync    Tầng 2: đồng bộ FBA Inventory cho tất cả shop production active",
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
