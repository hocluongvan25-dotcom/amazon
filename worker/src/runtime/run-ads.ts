/**
 * Runner CLI — MODULE 5 PHẦN 1 (Amazon Ads) + luồng token Module 0.
 *
 *   worker:ads-sync  [--seller=<uuid>] [--dry-run]
 *       GET /v2/profiles → campaigns → ad groups → keywords/targets (cấu trúc)
 *
 *   worker:ads-pull  [--kind=campaigns|targeting|search-terms|advertised-products|purchased-products|all]
 *                    [--days=30] [--seller=<uuid>] [--dry-run] [--poll=3]
 *                    [--campaigns=<file.json>] [--targeting=<file.json>] … (nạp file GZIP-đã-giải-nén)
 *       POST /reporting/reports → poll → tải GZIP_JSON → parse → RPC
 *       → cảnh báo acos_over_target / budget_exhausted + budget_events + lấp ads_spend (F4)
 *
 *   worker:oauth-soon [--days=30]
 *       Danh sách shop sắp/đã hết hạn refresh token (cron nhắc re-authorize, SOP-11).
 *
 * HAI CHẾ ĐỘ của ads-pull (giống reports:pull của 0019):
 *   (A) API  — không có cờ file: gọi Ads Reporting API v3 (cần AMAZON_ADS_*).
 *   (B) FILE — có --<kind>=<file>: bỏ qua Amazon, đi qua ĐÚNG pipeline parse → RPC.
 *
 * AN TOÀN DỮ LIỆU: chỉ ghi DB thật khi mode=production và không --dry-run.
 */
import { readFileSync } from "node:fs";

import { loadConfig } from "../config.ts";
import { runAdsPullAll, runAdsSyncAll, runOauthReminderAll } from "../run-ads.ts";
import { adsRunContext } from "../run-ads.ts";
import {
  ADS_ALL_KINDS,
  adsSpecOf,
  isAdsReportKind,
  type AdsReportKind,
} from "../ads/registry.ts";

export type AdsSyncCliResult = {
  mode: string;
  db: "supabase" | "mock";
  apiConfigured: boolean;
  dryRun: boolean;
  synced: number;
  skipped: number;
  failed: number;
  needsReauth: string[];
};

export async function runAdsSyncCli(opts: {
  sellerAccountId?: string | null;
  dryRun?: boolean;
  stdout?: { write: (s: string) => void };
}): Promise<AdsSyncCliResult> {
  const log = (s: string) => opts.stdout?.write(s);
  const cfg = loadConfig();
  const dryRun = opts.dryRun === true;

  if (!cfg.ads && !dryRun) {
    log(
      "[ads-sync] ⚠ chưa có credential Amazon Ads. Cần 3 biến (Vercel → Environment Variables):\n" +
        "    AMAZON_ADS_CLIENT_ID · AMAZON_ADS_CLIENT_SECRET · AMAZON_ADS_REFRESH_TOKEN\n" +
        "    (tuỳ chọn: AMAZON_ADS_REGION=NA|EU|FE — mặc định NA)\n" +
        "  Ads là ĐĂNG KÝ RIÊNG, KHÔNG dùng chung app SP-API. Sau khi có token, chạy lại lệnh này.\n",
    );
  }
  if (dryRun) log("[ads-sync] DRY-RUN — chỉ gọi Amazon để đọc, KHÔNG ghi DB.\n");

  const res = await runAdsSyncAll({
    dryRun,
    sellerAccountId: opts.sellerAccountId ?? null,
    requireSingleShop: false,
    stdout: opts.stdout,
  });

  log(
    `\n[ads-sync] KẾT QUẢ · db=${res.db} · apiConfigured=${res.apiConfigured}\n` +
      `   đồng bộ xong : ${res.synced}\n` +
      `   bỏ qua       : ${res.skipped}   (chưa có credential Ads)\n` +
      `   lỗi          : ${res.failed}\n` +
      (res.needsReauth.length > 0
        ? `   ⚠ CẦN RE-AUTHORIZE (Module 0 → Kết nối shop): ${res.needsReauth.length} shop\n`
        : ""),
  );
  for (const s of res.shops) {
    log(
      `   · ${s.shop.padEnd(20)} ${s.action.padEnd(8)} profile=${s.profiles} ` +
        `campaign=${s.campaigns} adGroup=${s.adGroups} target=${s.targets}\n`,
    );
  }
  if (res.errors.length > 0) {
    log(`   LỖI cần xem:\n${res.errors.map((e) => `     · ${e.error}\n`).join("")}`);
  }

  return {
    mode: res.mode,
    db: res.db,
    apiConfigured: res.apiConfigured,
    dryRun,
    synced: res.synced,
    skipped: res.skipped,
    failed: res.failed,
    needsReauth: res.needsReauth,
  };
}

export type AdsPullCliResult = {
  mode: string;
  db: "supabase" | "mock";
  apiConfigured: boolean;
  source: "api" | "file";
  kinds: AdsReportKind[];
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
  alertsFired: number;
  spendApplied: number;
  needsReauth: string[];
  errors: { shopId: string; kind: AdsReportKind; error: string }[];
};

export async function runAdsPullCli(opts: {
  kind?: string | null;
  days?: number | null;
  sellerAccountId?: string | null;
  files?: Partial<Record<AdsReportKind, string | null>>;
  dryRun?: boolean;
  pollAttempts?: number;
  fireAlerts?: boolean;
  applySpend?: boolean;
  stdout?: { write: (s: string) => void };
}): Promise<AdsPullCliResult> {
  const log = (s: string) => opts.stdout?.write(s);
  const cfg = loadConfig();
  const dryRun = opts.dryRun === true;

  const rawKind = (opts.kind ?? "").trim().toLowerCase();
  let kinds: AdsReportKind[];
  const unknown: string[] = [];
  if (rawKind === "" || rawKind === "all") {
    kinds = [...ADS_ALL_KINDS];
  } else {
    kinds = [];
    for (const part of rawKind.split(",").map((p) => p.trim()).filter(Boolean)) {
      if (isAdsReportKind(part)) kinds.push(part);
      else unknown.push(part);
    }
    if (kinds.length === 0) kinds = [...ADS_ALL_KINDS];
  }
  if (unknown.length > 0) {
    log(
      `[ads-pull] ⚠ không biết loại report: ${unknown.join(", ")}. ` +
        `Chọn được: ${ADS_ALL_KINDS.join(" | ")} | all.\n`,
    );
  }

  const texts: Partial<Record<AdsReportKind, string>> = {};
  const files: Record<string, string> = {};
  const missing: string[] = [];
  for (const kind of ADS_ALL_KINDS) {
    const path = opts.files?.[kind];
    if (!path) continue;
    try {
      texts[kind] = readFileSync(path, "utf8");
      files[kind] = path;
    } catch (e) {
      missing.push(`${kind}: ${path} (${(e as Error).message.split("\n")[0]})`);
    }
  }
  if (missing.length > 0) log(`[ads-pull] ⚠ không đọc được file: ${missing.join(" · ")}\n`);
  const fileMode = Object.keys(texts).length > 0;
  if (fileMode) kinds = Object.keys(texts).filter((k): k is AdsReportKind => isAdsReportKind(k));

  if (!cfg.ads && !fileMode && !dryRun) {
    log(
      "[ads-pull] ⚠ chưa có credential Amazon Ads (AMAZON_ADS_CLIENT_ID / _SECRET / _REFRESH_TOKEN).\n" +
        "  Trong lúc chờ: nạp file đã tải bằng --campaigns=<file.json> --targeting=<file.json> …\n",
    );
  }
  log(
    `[ads-pull] mode=${cfg.mode} · host=${cfg.adsHost} · nguồn=${fileMode ? "FILE" : "API"} · ` +
      `loại: ${kinds.map((k) => adsSpecOf(k).reportTypeId).join(", ")}\n`,
  );
  if (dryRun) log("[ads-pull] DRY-RUN — parse và tính, KHÔNG ghi DB.\n");

  const res = await runAdsPullAll({
    kinds,
    days: opts.days ?? null,
    dryRun,
    texts: fileMode ? texts : undefined,
    sellerAccountId: opts.sellerAccountId ?? null,
    requireSingleShop: fileMode,
    pollAttempts: opts.pollAttempts,
    fireAlerts: opts.fireAlerts,
    applySpend: opts.applySpend,
    stdout: opts.stdout,
  });

  log(
    `\n[ads-pull] KẾT QUẢ · db=${res.db} · apiConfigured=${res.apiConfigured} · ${res.shopsProcessed} shop\n` +
      `   đã nhập        : ${res.imported}\n` +
      `   đang chờ Amazon: ${res.pending}   (lần chạy sau poll tiếp, không xin report mới)\n` +
      `   report rỗng    : ${res.noData}   (không chạy quảng cáo ≠ lỗi)\n` +
      `   bị trần tốc độ : ${res.throttled}\n` +
      `   lỗi            : ${res.failed}\n` +
      `   bỏ qua         : ${res.skipped}\n` +
      `   dòng đã ghi    : ${res.rowsImported}\n` +
      `   cảnh báo rule  : ${res.alertsFired}   (acos_over_target · budget_exhausted)\n` +
      `   lấp ads_spend  : ${res.spendApplied} dòng F4 (TACOS thật)\n`,
  );
  const reauth = res.outcomes.filter((o) => o.needsReauth).map((o) => o.shop);
  if (reauth.length > 0) {
    log(
      `   ⚠ CẦN RE-AUTHORIZE (Module 0 → Kết nối shop, SOP-11): ${reauth.join(", ")}\n`,
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
    alertsFired: res.alertsFired,
    spendApplied: res.spendApplied,
    needsReauth: reauth,
    errors: res.errors,
  };
}

export type OauthSoonCliResult = {
  mode: string;
  db: "supabase" | "mock";
  count: number;
  marked: number;
  alertsCreated: number;
  dryRun: boolean;
  message: string;
  shops: {
    sellerAccountId: string;
    shop: string | null;
    expiresAt: string | null;
    daysLeft: number | null;
    needsReauth: boolean;
    alreadyNoticed: boolean;
    adsProfiles: number;
  }[];
};

/**
 * `worker:oauth-soon` — cron nhắc re-authorize đọc danh sách shop sắp hết hạn.
 * Vì sao cần lệnh riêng: view `vexim_oauth_connections` lọc theo auth.uid() nên
 * service_role đọc ra 0 dòng; RPC `vexim_worker_oauth_soon` mới trả được dữ liệu.
 */
export async function runOauthSoonCli(opts: {
  days?: number | null;
  /** true = tạo cảnh báo + đánh dấu đã nhắc (việc cron làm); false = chỉ đọc */
  mark?: boolean;
  stdout?: { write: (s: string) => void };
}): Promise<OauthSoonCliResult> {
  const log = (s: string) => opts.stdout?.write(s);
  const ctx = await adsRunContext({ log });
  const res = await runOauthReminderAll({
    days: opts.days ?? null,
    dryRun: opts.mark !== true,
    stdout: opts.stdout,
  });
  return {
    mode: res.mode,
    db: res.db,
    count: res.checked,
    marked: res.marked,
    alertsCreated: res.alertsCreated,
    dryRun: res.dryRun,
    message: res.message,
    shops: res.shops.map((r) => ({
      sellerAccountId: r.sellerAccountId,
      shop: r.shop,
      expiresAt: r.expiresAt,
      daysLeft: r.daysLeft,
      needsReauth: r.needsReauth,
      alreadyNoticed: r.alreadyNoticed,
      adsProfiles: r.adsProfiles,
    })),
  };
}
