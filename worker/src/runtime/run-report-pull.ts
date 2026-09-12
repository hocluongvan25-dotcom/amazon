/**
 * Runner CLI — TỰ KÉO / NẠP 4 REPORT FBA (0019).
 *
 *   worker:reports-pull -- [--type=<fc|receipts|storage-fees|noncompliance|all>]
 *                          [--days=<số ngày lùi>] [--seller=<uuid>]
 *                          [--fc=<file>] [--receipts=<file>]
 *                          [--storage-fees=<file>] [--noncompliance=<file>]
 *                          [--dry-run] [--poll=<số lần>]
 *
 * HAI CHẾ ĐỘ:
 *   (A) API  — không có cờ file nào: gọi Reports API (createReport → poll → tải GZIP →
 *       parse → ghi). Cần AMAZON_LWA_* + Supabase (mode=production). Đây là chế độ
 *       Vercel Cron chạy mỗi ngày lúc 03:00 UTC.
 *   (B) FILE — có --<kind>=<đường dẫn>: bỏ qua Amazon, nạp TSV đã tải từ Seller
 *       Central. Đi qua ĐÚNG pipeline parse → RPC nên luật nhập giống hệt chế độ A.
 *       Dùng để nạp dữ liệu lịch sử, hoặc khi role Reports API chưa được duyệt.
 *
 *   (A) là mặc định; (B) chỉ kích hoạt khi có ít nhất một cờ file.
 *
 * AN TOÀN DỮ LIỆU: DB thật chỉ được ghi khi cfg.mode === "production" và không
 * --dry-run (luật chung của worker — xem run-inventory-sync.ts).
 */
import { readFileSync } from "node:fs";

import { loadConfig } from "../config.ts";
import { runReportPullAll } from "../run-report-pull.ts";
import {
  ALL_REPORT_KINDS,
  isReportKind,
  specOf,
  type ReportKind,
} from "../reports/registry.ts";

export type ReportPullCliResult = {
  mode: string;
  db: "supabase" | "mock";
  apiConfigured: boolean;
  source: "api" | "file";
  kinds: ReportKind[];
  files: Record<string, string>;
  dryRun: boolean;
  counts: {
    imported: number;
    pending: number;
    noData: number;
    throttled: number;
    failed: number;
    skipped: number;
  };
  rowsImported: number;
  errors: { shopId: string; kind: ReportKind; error: string }[];
};

export async function runReportPullCli(opts: {
  type?: string | null;
  days?: number | null;
  sellerAccountId?: string | null;
  files?: Partial<Record<ReportKind, string | null>>;
  dryRun?: boolean;
  pollAttempts?: number;
  stdout?: { write: (s: string) => void };
}): Promise<ReportPullCliResult> {
  const log = (s: string) => opts.stdout?.write(s);
  const cfg = loadConfig();
  const dryRun = opts.dryRun === true;

  // ---- chọn loại report ------------------------------------------------------
  const rawType = (opts.type ?? "").trim().toLowerCase();
  let kinds: ReportKind[];
  const unknown: string[] = [];
  if (rawType === "" || rawType === "all") {
    kinds = [...ALL_REPORT_KINDS];
  } else {
    kinds = [];
    for (const part of rawType.split(",").map((p) => p.trim()).filter(Boolean)) {
      if (isReportKind(part)) kinds.push(part);
      else unknown.push(part);
    }
    if (kinds.length === 0) kinds = [...ALL_REPORT_KINDS];
  }
  if (unknown.length > 0) {
    log(
      `[reports:pull] ⚠ không biết loại report: ${unknown.join(", ")}. ` +
        `Chọn được: ${ALL_REPORT_KINDS.join(" | ")} | all.\n`,
    );
  }

  // ---- đọc file (chế độ B) ---------------------------------------------------
  const texts: Partial<Record<ReportKind, string>> = {};
  const files: Record<string, string> = {};
  const missing: string[] = [];
  for (const kind of ALL_REPORT_KINDS) {
    const path = opts.files?.[kind];
    if (!path) continue;
    try {
      texts[kind] = readFileSync(path, "utf8");
      files[kind] = path;
    } catch (e) {
      missing.push(`${kind}: ${path} (${(e as Error).message.split("\n")[0]})`);
    }
  }
  if (missing.length > 0) {
    log(`[reports:pull] ⚠ không đọc được file: ${missing.join(" · ")}\n`);
  }
  const fileMode = Object.keys(texts).length > 0;
  if (fileMode) {
    // Chỉ chạy đúng những loại có file (tránh "skipped" nhiễu cho các loại khác)
    kinds = (Object.keys(texts) as ReportKind[]).filter((k) => isReportKind(k));
  }

  log(
    `[reports:pull] mode=${cfg.mode} · nguồn=${fileMode ? "FILE (nạp TSV local)" : "API (Reports API)"} · ` +
      `loại report: ${kinds.map((k) => specOf(k).reportType).join(", ")}\n`,
  );
  if (opts.days) log(`[reports:pull] khoảng ngày: lùi ${opts.days} ngày (ghi đè mặc định)\n`);
  if (dryRun) log("[reports:pull] DRY-RUN — parse và tính toán, KHÔNG ghi DB.\n");

  const res = await runReportPullAll({
    kinds,
    days: opts.days ?? null,
    dryRun,
    texts: fileMode ? texts : undefined,
    sellerAccountId: opts.sellerAccountId ?? null,
    requireSingleShop: fileMode,
    pollAttempts: opts.pollAttempts,
    stdout: opts.stdout,
  });

  // ---- tóm tắt ----------------------------------------------------------------
  log(
    `\n[reports:pull] KẾT QUẢ · db=${res.db} · apiConfigured=${res.apiConfigured} · ` +
      `${res.shopsProcessed} shop\n` +
      `   đã nhập        : ${res.imported}\n` +
      `   đang chờ Amazon: ${res.pending}   (lần chạy sau poll tiếp, không xin report mới)\n` +
      `   report rỗng    : ${res.noData}   (không có dữ liệu ≠ lỗi)\n` +
      `   bị trần tốc độ : ${res.throttled}\n` +
      `   lỗi            : ${res.failed}\n` +
      `   bỏ qua         : ${res.skipped}\n` +
      `   dòng đã ghi    : ${res.rowsImported}\n`,
  );
  if (res.db === "mock") {
    log("   ⚠ chạy trong bộ nhớ (dry-run / chưa đủ credentials) — KHÔNG ghi DB thật.\n");
  }
  if (!res.apiConfigured && !fileMode) {
    log(
      "   ⚠ chưa có credential Reports API. Cần đủ 5 biến (Vercel → Environment Variables):\n" +
        "       AMAZON_LWA_CLIENT_ID · AMAZON_LWA_CLIENT_SECRET · AMAZON_LWA_REFRESH_TOKEN\n" +
        "       NEXT_PUBLIC_SUPABASE_URL (hoặc SUPABASE_URL) · SUPABASE_SERVICE_ROLE_KEY\n" +
        "     Và role \"Pricing & Product Information\" + \"Amazon Fulfillment\" phải được\n" +
        "     Amazon duyệt cho app SP-API (Developer Central → App store → Roles).\n" +
        "     Trong lúc chờ: nạp file tay bằng --storage-fees=<tsv> --noncompliance=<tsv>.\n",
    );
  }
  if (res.errors.length > 0) {
    log(`   LỖI cần xem:\n${res.errors.map((e) => `     · [${e.kind}] ${e.error}\n`).join("")}`);
  }

  return {
    mode: res.mode,
    db: res.db,
    apiConfigured: res.apiConfigured,
    source: fileMode ? "file" : "api",
    kinds,
    files,
    dryRun,
    counts: {
      imported: res.imported,
      pending: res.pending,
      noData: res.noData,
      throttled: res.throttled,
      failed: res.failed,
      skipped: res.skipped,
    },
    rowsImported: res.rowsImported,
    errors: res.errors,
  };
}
