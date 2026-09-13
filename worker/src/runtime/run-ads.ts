/**
 * Runner CLI — MODULE 5 PHẦN 1 (Amazon Ads).
 *
 *   worker:ads-sync  [--seller=<uuid>] [--dry-run]
 *       GET /v2/profiles → Campaign Management v3 list (campaign · ad group · keyword/target)
 *       → RPC upsert (0020). Chạy TRƯỚC ads:pull để có ads_profile_id + tiền tệ.
 *
 *   worker:ads-pull  [--kind=all|campaigns|targeting|search-terms|advertised-products|purchased-products]
 *                    [--days=30] [--seller=<uuid>] [--dry-run] [--poll=3]
 *                    [--campaigns=<file.json>] [--targeting=<file.json>] [--search-terms=<file>]
 *                    [--advertised-products=<file>] [--purchased-products=<file>]
 *       Reporting API v3: create → poll → tải GZIP_JSON → parse → RPC.
 *       Sau khi nhập: cảnh báo ACOS/ngân sách + `ads.budget_events` + lấp ads_spend (F4).
 *
 *   worker:ads-apply [--seller=<uuid>] [--limit=20] [--dry-run]
 *       Áp dụng các yêu cầu ĐÃ ĐƯỢC DUYỆT lên Amazon Ads (bid · ngân sách ·
 *       negative) rồi ghi kết quả + audit. Chạy sau ads-sync (cần ads_profile_id).
 *
 * HAI CHẾ ĐỘ CỦA ads:pull (giống reports:pull của 0019):
 *   (A) API  — không có cờ file: gọi Amazon (cần AMAZON_ADS_CLIENT_ID/SECRET/REFRESH_TOKEN).
 *   (B) FILE — có --<kind>=<đường dẫn>: nạp file JSON đã giải nén, đi ĐÚNG pipeline
 *       parse → RPC nên luật nhập giống hệt chế độ A. Dùng khi app Ads chưa được
 *       duyệt role hoặc khi cần nạp lại dữ liệu lịch sử.
 *
 * AN TOÀN DỮ LIỆU: DB thật chỉ ghi khi mode=production và không --dry-run.
 * Thiếu credential ⇒ chạy DEMO trong bộ nhớ, KHÔNG ghi gì.
 */
import { readFileSync } from "node:fs";

import { loadConfig } from "../config.ts";
import { runAdsApplyAll, runAdsPullAll, runAdsSyncAll, runOauthReminderAll } from "../run-ads.ts";
import { ADS_ALL_KINDS, adsSpecOf, isAdsReportKind, type AdsReportKind } from "../ads/registry.ts";

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

  if (!cfg.ads) {
    log(
      "[ads:sync] ⚠ chưa có credential Amazon Ads. Cần (Vercel → Environment Variables):\n" +
        "    AMAZON_ADS_CLIENT_ID · AMAZON_ADS_CLIENT_SECRET · AMAZON_ADS_REFRESH_TOKEN\n" +
        "    tuỳ chọn AMAZON_ADS_REGION=NA|EU|FE (mặc định NA)\n" +
        "  Ads là ĐĂNG KÝ RIÊNG — KHÔNG dùng chung LWA của app SP-API.\n",
    );
  }
  if (opts.dryRun) log("[ads:sync] DRY-RUN — gọi Amazon để đọc, KHÔNG ghi DB.\n");

  const res = await runAdsSyncAll({
    dryRun: opts.dryRun === true,
    sellerAccountId: opts.sellerAccountId ?? null,
    requireSingleShop: false,
    stdout: opts.stdout,
  });

  log(
    `\n[ads:sync] KẾT QUẢ · db=${res.db} · apiConfigured=${res.apiConfigured}\n` +
      `   đồng bộ xong : ${res.synced}\n` +
      `   bỏ qua       : ${res.skipped}\n` +
      `   lỗi          : ${res.failed}\n`,
  );
  for (const s of res.shops) {
    log(
      `   · ${s.shop.padEnd(18)} ${s.action.padEnd(8)} profile=${s.profiles} ` +
        `campaign=${s.campaigns} adGroup=${s.adGroups} target=${s.targets}\n`,
    );
  }
  if (res.needsReauth.length > 0) {
    log(`   ⚠ CẦN RE-AUTHORIZE (Module 0 → Kết nối shop): ${res.needsReauth.join(", ")}\n`);
  }
  if (res.errors.length > 0) {
    log(`   LỖI cần xem:\n${res.errors.map((e) => `     · ${e.error}\n`).join("")}`);
  }

  return {
    mode: res.mode,
    db: res.db,
    apiConfigured: res.apiConfigured,
    dryRun: opts.dryRun === true,
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
      `[ads:pull] ⚠ không biết loại report: ${unknown.join(", ")}. ` +
        `Chọn được: ${ADS_ALL_KINDS.join(" | ")} | all.\n`,
    );
  }

  // Chế độ FILE: đọc các đường dẫn được truyền vào
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
  if (missing.length > 0) log(`[ads:pull] ⚠ không đọc được file: ${missing.join(" · ")}\n`);
  const fileMode = Object.keys(texts).length > 0;
  if (fileMode) kinds = Object.keys(texts).filter((k): k is AdsReportKind => isAdsReportKind(k));

  if (!cfg.ads && !fileMode) {
    log(
      "[ads:pull] ⚠ chưa có credential Amazon Ads (AMAZON_ADS_CLIENT_ID / _SECRET / _REFRESH_TOKEN).\n" +
        "  Trong lúc chờ: nạp file đã giải nén bằng --campaigns=<file.json> --targeting=<file.json> …\n",
    );
  }
  log(
    `[ads:pull] mode=${cfg.mode} · host=${cfg.adsHost} · nguồn=${fileMode ? "FILE" : "API"} · ` +
      `loại: ${kinds.map((k) => adsSpecOf(k).reportTypeId).join(", ")}\n`,
  );
  if (dryRun) log("[ads:pull] DRY-RUN — parse và tính, KHÔNG ghi DB.\n");

  const res = await runAdsPullAll({
    kinds,
    days: opts.days ?? null,
    dryRun,
    texts: fileMode ? texts : undefined,
    sellerAccountId: opts.sellerAccountId ?? null,
    requireSingleShop: fileMode,
    pollAttempts: opts.pollAttempts,
    fireAlerts: opts.fireAlerts !== false,
    applySpend: opts.applySpend !== false,
    stdout: opts.stdout,
  });

  log(
    `\n[ads:pull] KẾT QUẢ · db=${res.db} · apiConfigured=${res.apiConfigured} · ${res.shopsProcessed} shop\n` +
      `   đã nhập        : ${res.imported}\n` +
      `   đang chờ Amazon: ${res.pending}\n` +
      `   report rỗng    : ${res.noData}   (không chạy quảng cáo ≠ lỗi)\n` +
      `   bị trần tốc độ : ${res.throttled}\n` +
      `   lỗi            : ${res.failed}\n` +
      `   bỏ qua         : ${res.skipped}\n` +
      `   dòng đã ghi    : ${res.rowsImported}\n` +
      `   cảnh báo tạo   : ${res.alertsFired}   (acos_over_target · budget_exhausted)\n` +
      `   lấp ads_spend  : ${res.spendApplied} dòng F4 (TACOS thật)\n`,
  );
  if (res.db === "mock") {
    log("   ⚠ chạy trong bộ nhớ (dry-run / chưa đủ credentials) — KHÔNG ghi DB thật.\n");
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
    needsReauth: res.outcomes.filter((o) => o.needsReauth).map((o) => o.shop),
    errors: res.errors,
  };
}

export type AdsApplyCliResult = {
  mode: string;
  db: "supabase" | "mock";
  apiConfigured: boolean;
  dryRun: boolean;
  claimed: number;
  applied: number;
  failed: number;
  released: number;
  needsReauth: string[];
};

/**
 * CLI `worker:ads-apply` — chiều GHI. Không có cờ nào để bỏ qua hàng đợi duyệt:
 * muốn ghi thì phải có yêu cầu `approved` trong DB (do người tạo/duyệt ở web).
 */
export async function runAdsApplyCli(opts: {
  sellerAccountId?: string | null;
  limit?: number | null;
  dryRun?: boolean;
  stdout?: { write: (s: string) => void };
}): Promise<AdsApplyCliResult> {
  const log = (s: string) => opts.stdout?.write(s);
  const cfg = loadConfig();

  if (!cfg.ads) {
    log(
      "[ads:apply] ⚠ chưa có credential Amazon Ads ⇒ KHÔNG gửi thay đổi nào lên Amazon.\n" +
        "    Cần AMAZON_ADS_CLIENT_ID · AMAZON_ADS_CLIENT_SECRET · AMAZON_ADS_REFRESH_TOKEN\n",
    );
  }
  if (opts.dryRun) log("[ads:apply] DRY-RUN — không claim, không gọi Amazon.\n");

  const res = await runAdsApplyAll({
    sellerAccountId: opts.sellerAccountId ?? null,
    limit: opts.limit ?? undefined,
    dryRun: opts.dryRun === true,
    stdout: opts.stdout,
  });

  log(
    `[ads:apply] ${res.claimed} yêu cầu đã nhận · ${res.applied} áp dụng · ` +
      `${res.failed} thất bại · ${res.released} trả lại hàng đợi` +
      (res.needsReauth.length > 0 ? ` · CẦN RE-AUTHORIZE: ${res.needsReauth.join(", ")}` : "") +
      "\n",
  );
  return {
    mode: res.mode,
    db: res.db,
    apiConfigured: res.apiConfigured,
    dryRun: opts.dryRun === true,
    claimed: res.claimed,
    applied: res.applied,
    failed: res.failed,
    released: res.released,
    needsReauth: res.needsReauth,
  };
}

export type OauthSoonCliResult = {
  mode: string;
  db: "supabase" | "mock";
  dryRun: boolean;
  /** số shop được kiểm tra (không phải số shop cần nhắc) */
  count: number;
  alertsCreated: number;
  marked: number;
  needsReauth: string[];
};

/**
 * CLI `worker:oauth:soon` — shop sắp/đã hết hạn refresh token (Module 0 · SOP-11).
 *
 * MẶC ĐỊNH CHỈ ĐỌC: không tạo cảnh báo, không đánh dấu "đã nhắc" — vì cờ đó chỉ
 * được cron bật MỘT LẦN cho mỗi shop. Muốn ghi thì phải truyền `--mark` (dùng khi
 * chạy tay thay cron).
 */
export async function runOauthSoonCli(opts: {
  days?: number | null;
  mark?: boolean;
  stdout?: { write: (s: string) => void };
}): Promise<OauthSoonCliResult> {
  const mark = opts.mark === true;
  const res = await runOauthReminderAll({
    days: opts.days ?? null,
    dryRun: !mark,
    stdout: opts.stdout,
  });
  const needsReauth = res.shops.filter((s) => s.needsReauth).map((s) => s.shop ?? s.sellerAccountId);
  opts.stdout?.write(
    `[oauth:soon] ${res.shops.length} shop cần nhắc${mark ? "" : " (chế độ chỉ đọc — thêm --mark để ghi cảnh báo)"}` +
      (res.shops.length > 0
        ? `:\n` +
          res.shops
            .map(
              (s) =>
                `   ${s.shop ?? s.sellerAccountId} · còn ${s.daysLeft ?? "?"} ngày · ` +
                `hạn ${s.expiresAt ?? "?"}${s.alreadyNoticed ? " · đã nhắc trước đó" : ""}\n`,
            )
            .join("")
        : " — mọi token đều còn hạn.\n"),
  );
  return {
    mode: res.mode,
    db: res.db,
    dryRun: res.dryRun,
    count: res.checked,
    alertsCreated: res.alertsCreated,
    marked: res.marked,
    needsReauth,
  };
}
