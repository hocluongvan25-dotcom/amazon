/**
 * Cron API — Vercel Cron gọi mỗi ngày để TỰ KÉO report FBA (0019) + report
 * AMAZON ADS (Module 5 phần 1, 0020).
 *
 *   /api/cron/report-pull                       → 4 report FBA + 5 report Ads
 *   /api/cron/report-pull?kinds=storage-fees    → chỉ phí lưu kho (FBA)
 *   /api/cron/report-pull?oauth=0               → bỏ phần nhắc re-authorize token
 *   /api/cron/report-pull?ads=0                 → bỏ phần Amazon Ads
 *   /api/cron/report-pull?adsKinds=campaigns    → chỉ report campaign của Ads
 *   /api/cron/report-pull?days=7                → ghi đè khoảng ngày mặc định
 *   /api/cron/report-pull?dryRun=1              → tải + parse, KHÔNG ghi DB
 *
 * VÌ SAO ADS CHẠY CHUNG ROUTE NÀY (không thêm cron riêng):
 *   Vercel Hobby giới hạn 2 cron/ngày và repo đã dùng hết (02:00 inventory-sync,
 *   03:00 report-pull). Thêm cron thứ ba là vượt hạn mức của gói → giữ một route,
 *   chạy lần lượt: FBA → cấu trúc Ads → report Ads.
 *
 * Protect bằng CRON_SECRET (Authorization: Bearer <CRON_SECRET>) — Vercel Cron tự
 * gửi header này. Thiếu CRON_SECRET trên production → trả 500 kèm hướng dẫn
 * (bài học từ /api/cron/inventory-sync: trả 401 mơ hồ khiến Vercel chỉ hiện
 * "failed" và không ai biết nguyên nhân là thiếu biến môi trường).
 *
 * VÌ SAO maxDuration = 60 VÀ POLL RẤT ÍT:
 *   Cả SP-API Reports và Ads Reporting v3 đều BẤT ĐỒNG BỘ. Cron KHÔNG được ngồi
 *   chờ: poll 2 lần cách nhau vài giây, chưa xong thì ghi trạng thái vào
 *   connections.report_requests và lần chạy sau poll tiếp đúng reportId đó (job
 *   đã xử lý). Muốn chờ lâu hơn thì chạy CLI: `npm run worker:reports-pull` /
 *   `npm run worker:ads-pull` (không bị trần 60s của serverless).
 */
import { NextResponse } from "next/server";
import {
  ADS_ALL_KINDS,
  ALL_REPORT_KINDS,
  isAdsReportKind,
  isReportKind,
  runAdsPullAll,
  runAdsSyncAll,
  runOauthReminderAll,
  runReportPullAll,
  type AdsReportKind,
  type ReportKind,
} from "@/lib/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CRON_POLL_ATTEMPTS = 2;
const CRON_POLL_DELAY_MS = 5_000;
/** Ads: report v3 thường xong sau vài phút → poll nhanh 1 nhịp, lần sau lấy tiếp. */
const CRON_ADS_POLL_ATTEMPTS = 2;
const CRON_ADS_POLL_DELAY_MS = 2_000;

type AuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 500; error: string; hint?: string };

function authorize(req: Request): AuthResult {
  const expected = process.env.CRON_SECRET;
  const isProd = process.env.NODE_ENV === "production";

  if (!expected) {
    if (isProd) {
      return {
        ok: false,
        status: 500,
        error: "CRON_SECRET chưa được cấu hình trên Vercel.",
        hint:
          "Vercel → Project Settings → Environment Variables → thêm CRON_SECRET " +
          "(chuỗi ngẫu nhiên dài) cho Production và Preview, rồi Redeploy.",
      };
    }
    return { ok: true };
  }

  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${expected}`) {
    return {
      ok: false,
      status: 401,
      error: "Sai hoặc thiếu header Authorization: Bearer <CRON_SECRET>.",
    };
  }
  return { ok: true };
}

function parseKinds(raw: string | null): { kinds: ReportKind[]; bad: string[] } {
  if (!raw) return { kinds: [...ALL_REPORT_KINDS], bad: [] };
  const parts = raw.split(",").map((p) => p.trim()).filter((p) => p !== "");
  const kinds: ReportKind[] = [];
  const bad: string[] = [];
  for (const p of parts) {
    if (isReportKind(p)) kinds.push(p);
    else bad.push(p);
  }
  return { kinds: kinds.length > 0 ? kinds : [...ALL_REPORT_KINDS], bad };
}

function parseAdsKinds(raw: string | null): { kinds: AdsReportKind[]; bad: string[] } {
  if (!raw) return { kinds: [...ADS_ALL_KINDS], bad: [] };
  const parts = raw.split(",").map((p) => p.trim()).filter((p) => p !== "");
  const kinds: AdsReportKind[] = [];
  const bad: string[] = [];
  for (const p of parts) {
    if (isAdsReportKind(p)) kinds.push(p);
    else bad.push(p);
  }
  return { kinds: kinds.length > 0 ? kinds : [...ADS_ALL_KINDS], bad };
}

export async function GET(req: Request) {
  const auth = authorize(req);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error, hint: auth.hint },
      { status: auth.status },
    );
  }

  const url = new URL(req.url);
  const { kinds, bad } = parseKinds(url.searchParams.get("kinds"));
  const { kinds: adsKinds, bad: badAdsKinds } = parseAdsKinds(url.searchParams.get("adsKinds"));
  const daysRaw = url.searchParams.get("days");
  const days = daysRaw && Number.isFinite(Number(daysRaw)) ? Number(daysRaw) : null;
  const dryRun = url.searchParams.get("dryRun") === "1" || url.searchParams.get("dryRun") === "true";
  const withAds = url.searchParams.get("ads") !== "0";
  const withOauth = url.searchParams.get("oauth") !== "0";

  const buf: string[] = [];
  const stdout = {
    write: (s: string) => {
      buf.push(s);
      return undefined;
    },
  };

  try {
    // 0. Token platform (Module 0): nhắc re-authorize shop sắp hết hạn refresh
    //    token (365 ngày). Chạy TRƯỚC các bước khác vì token chết là mọi bước
    //    sau hỏng — và vì nhắc sớm thì còn thời gian authorize lại (SOP-11).
    const oauth = withOauth ? await runOauthReminderAll({ dryRun, stdout }) : null;

    // 1. Report FBA (0019) — giữ nguyên hành vi cũ.
    const res = await runReportPullAll({
      kinds,
      days,
      dryRun,
      pollAttempts: CRON_POLL_ATTEMPTS,
      pollDelayMs: CRON_POLL_DELAY_MS,
      stdout,
    });

    // 2. Amazon Ads (0020): cấu trúc trước (profile → campaign → target), rồi report.
    let adsSync: Awaited<ReturnType<typeof runAdsSyncAll>> | null = null;
    let adsPull: Awaited<ReturnType<typeof runAdsPullAll>> | null = null;
    if (withAds && !dryRun) {
      adsSync = await runAdsSyncAll({ stdout });
      adsPull = await runAdsPullAll({
        kinds: adsKinds,
        days,
        dryRun: false,
        pollAttempts: CRON_ADS_POLL_ATTEMPTS,
        pollDelayMs: CRON_ADS_POLL_DELAY_MS,
        stdout,
      });
    } else if (withAds && dryRun) {
      // Dry-run vẫn cho phép KIỂM TRA kết nối Ads (đọc, không ghi).
      adsPull = await runAdsPullAll({
        kinds: adsKinds,
        days,
        dryRun: true,
        pollAttempts: CRON_ADS_POLL_ATTEMPTS,
        pollDelayMs: CRON_ADS_POLL_DELAY_MS,
        stdout,
      });
    }

    const adsFailed = (adsPull?.failed ?? 0) + (adsSync?.failed ?? 0);
    return NextResponse.json({
      ok: res.failed === 0 && adsFailed === 0,
      mode: res.mode,
      db: res.db,
      apiConfigured: res.apiConfigured,
      adsApiConfigured: adsPull?.apiConfigured ?? adsSync?.apiConfigured ?? false,
      shopsProcessed: res.shopsProcessed,
      kindsRequested: res.kindsRequested,
      counts: {
        imported: res.imported,
        pending: res.pending,
        noData: res.noData,
        throttled: res.throttled,
        failed: res.failed,
        skipped: res.skipped,
      },
      rowsImported: res.rowsImported,
      outcomes: res.outcomes,
      errors: res.errors,
      unknownKinds: bad,
      oauth: oauth
        ? {
            skipped: false,
            checked: oauth.checked,
            alertsCreated: oauth.alertsCreated,
            marked: oauth.marked,
            message: oauth.message,
            shops: oauth.shops,
          }
        : { skipped: true, reason: "oauth=0" },
      ads: withAds
        ? {
            skipped: false,
            sync: adsSync
              ? {
                  synced: adsSync.synced,
                  skipped: adsSync.skipped,
                  failed: adsSync.failed,
                  needsReauth: adsSync.needsReauth,
                  shops: adsSync.shops,
                  errors: adsSync.errors,
                }
              : null,
            pull: adsPull
              ? {
                  kindsRequested: adsPull.kindsRequested,
                  imported: adsPull.imported,
                  pending: adsPull.pending,
                  noData: adsPull.noData,
                  throttled: adsPull.throttled,
                  failed: adsPull.failed,
                  skipped: adsPull.skipped,
                  rowsImported: adsPull.rowsImported,
                  alertsFired: adsPull.alertsFired,
                  spendApplied: adsPull.spendApplied,
                  needsReauth: adsPull.outcomes.filter((o) => o.needsReauth).map((o) => o.shop),
                  outcomes: adsPull.outcomes,
                  errors: adsPull.errors,
                }
              : null,
            unknownKinds: badAdsKinds,
          }
        : { skipped: true, reason: "ads=0" },
      dryRun,
      cronSecretConfigured: !!process.env.CRON_SECRET,
      log: buf.join(""),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message, log: buf.join("") },
      { status: 500 },
    );
  }
}

export const POST = GET;
