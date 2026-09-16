/**
 * Cron API — Vercel Cron gọi mỗi ngày để TỰ KÉO report.
 *
 *   /api/cron/report-pull                            → 4 report FBA (0019) + Ads (0020)
 *   /api/cron/report-pull?kinds=storage-fees         → chỉ phí lưu kho (FBA)
 *   /api/cron/report-pull?ads=0                      → bỏ phần Amazon Ads
 *   /api/cron/report-pull?adsApply=0                  → bỏ phần GHI (duyệt → Amazon)
 *   /api/cron/report-pull?adsKinds=campaigns,targeting → chỉ vài loại report Ads
 *   /api/cron/report-pull?days=7                     → ghi đè khoảng ngày mặc định
 *   /api/cron/report-pull?dryRun=1                   → tải + parse, KHÔNG ghi DB
 *   /api/cron/report-pull?orders=0                   → bỏ phần đồng bộ ĐƠN HÀNG
 *
 * VÌ SAO ADS DÙNG CHUNG MỘT CRON (không thêm cron thứ ba):
 *   Vercel Hobby chỉ cho 2 cron/ngày (02:00 inventory-sync · 03:00 report-pull).
 *   Thêm cron thứ ba là vượt hạn mức ⇒ ghép vào đây theo thứ tự: FBA → cấu trúc
 *   Ads (profile/campaign/ad group/target) → report Ads.
 *
 * VÌ SAO ĐƠN HÀNG CŨNG GHÉP VÀO (16/09/2026):
 *   Đường delta Orders API v0 (`/api/cron/orders-sync`) chỉ cho 0.0167 rps nên chạy
 *   dày vô ích; mà màn /orders trước đây không có cron nào cả ⇒ bảng luôn rỗng.
 *   Chạy kèm ở đây (sau Ads) là đủ cho nhịp vận hành 1 lần/ngày; muốn kéo ngay thì
 *   bấm nút "Đồng bộ đơn hàng ngay" trên /orders hoặc gọi thẳng
 *   `/api/cron/orders-sync` (cùng CRON_SECRET). Khi dự án lên gói Pro có thể thêm
 *   mục cron riêng cho /api/cron/orders-sync để chạy mỗi 30 phút.
 *
 * VÌ SAO maxDuration = 60 VÀ CHỈ POLL 2 LẦN:
 *   Cả SP-API Reports và Ads Reporting v3 đều BẤT ĐỒNG BỘ. Cron KHÔNG được ngồi
 *   chờ: poll 2 lần cách nhau vài giây, chưa xong thì ghi trạng thái vào
 *   connections.report_requests và lần chạy sau poll tiếp ĐÚNG reportId đó (job
 *   đã xử lý). Muốn chờ lâu hơn thì chạy CLI:
 *   `cd worker && npm run worker:reports-pull` / `npm run worker:ads-pull` (không bị trần 60s).
 *
 * Protect bằng CRON_SECRET (Authorization: Bearer <CRON_SECRET>) — Vercel Cron tự
 * gửi header này. Thiếu CRON_SECRET trên production → trả 500 kèm hướng dẫn
 * (bài học từ /api/cron/inventory-sync: trả 401 mơ hồ khiến Vercel chỉ hiện
 * "failed" và không ai biết nguyên nhân là thiếu biến môi trường).
 */
import { NextResponse } from "next/server";
import {
  ALL_REPORT_KINDS,
  ADS_ALL_KINDS,
  isAdsReportKind,
  isReportKind,
  runAdsApplyAll,
  runAdsPullAll,
  runAdsSyncAll,
  runOrdersSyncAll,
  runReportPullAll,
  type AdsReportKind,
  type ReportKind,
} from "@/lib/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CRON_POLL_ATTEMPTS = 2;
const CRON_POLL_DELAY_MS = 5_000;
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
  // Phần GHI tách cờ riêng: có shop chỉ muốn kéo số liệu mà chưa muốn cho cron
  // ghi lên Amazon (ví dụ đang kiểm tra quyền của app Ads).
  const withAdsApply = url.searchParams.get("adsApply") !== "0";
  // Phần ĐƠN HÀNG tách cờ riêng: shop nào chưa xong hồ sơ SP-API Orders vẫn chạy
  // được report FBA/Ads như cũ.
  const withOrders = url.searchParams.get("orders") !== "0";

  const buf: string[] = [];
  const out = {
    write: (s: string) => {
      buf.push(s);
      return undefined;
    },
  };

  try {
    // 1. Report FBA (0019) — giữ nguyên hành vi cũ.
    const res = await runReportPullAll({
      kinds,
      days,
      dryRun,
      pollAttempts: CRON_POLL_ATTEMPTS,
      pollDelayMs: CRON_POLL_DELAY_MS,
      stdout: out,
    });

    // 2. Amazon Ads (0020): cấu trúc trước (profile → campaign → target) rồi report.
    //    Không cấu hình token Ads thì cả hai trả `skipped` kèm hướng dẫn, KHÔNG throw.
    let adsSync: Awaited<ReturnType<typeof runAdsSyncAll>> | null = null;
    let adsPull: Awaited<ReturnType<typeof runAdsPullAll>> | null = null;
    let adsApply: Awaited<ReturnType<typeof runAdsApplyAll>> | null = null;
    if (withAds) {
      adsSync = await runAdsSyncAll({ stdout: out, dryRun });
      adsPull = await runAdsPullAll({
        kinds: adsKinds,
        days,
        dryRun,
        pollAttempts: CRON_ADS_POLL_ATTEMPTS,
        pollDelayMs: CRON_ADS_POLL_DELAY_MS,
        stdout: out,
      });

      // 3. GHI: chỉ áp dụng yêu cầu ĐÃ ĐƯỢC DUYỆT (ngưỡng >30%/ngày đã qua tay
      //    trưởng phòng PPC ở UI). Chạy sau sync để có ads_profile_id.
      if (withAdsApply) adsApply = await runAdsApplyAll({ dryRun, stdout: out });
    }

    // 4. ĐƠN HÀNG (Orders API v0): delta getOrders → orderItems → upsert. Chạy CUỐI
    //    để phần FBA/Ads không bị phần này ăn hết 60s; ngân sách item giữ nhỏ
    //    (8s) vì cron là lượt "quét nhanh", còn backfill thì dùng CLI/nút.
    let orders: Awaited<ReturnType<typeof runOrdersSyncAll>> | null = null;
    if (withOrders) {
      orders = await runOrdersSyncAll({
        days,
        dryRun,
        maxItemMs: 8_000,
        stdout: out,
      });
    }

    return NextResponse.json({
      ok: res.failed === 0 && (orders?.failed ?? 0) === 0,
      mode: res.mode,
      db: res.db,
      apiConfigured: res.apiConfigured,
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
      dryRun,
      ads: {
        enabled: withAds,
        unknownKinds: badAdsKinds,
        sync: adsSync
          ? {
              db: adsSync.db,
              apiConfigured: adsSync.apiConfigured,
              synced: adsSync.synced,
              skipped: adsSync.skipped,
              failed: adsSync.failed,
              needsReauth: adsSync.needsReauth,
              shops: adsSync.shops,
              errors: adsSync.errors,
            }
          : null,
        apply: adsApply
          ? {
              db: adsApply.db,
              apiConfigured: adsApply.apiConfigured,
              claimed: adsApply.claimed,
              applied: adsApply.applied,
              failed: adsApply.failed,
              released: adsApply.released,
              needsReauth: adsApply.needsReauth,
              shops: adsApply.shops,
              errors: adsApply.errors,
            }
          : null,
        pull: adsPull
          ? {
              db: adsPull.db,
              apiConfigured: adsPull.apiConfigured,
              kindsRequested: adsPull.kindsRequested,
              counts: {
                imported: adsPull.imported,
                pending: adsPull.pending,
                noData: adsPull.noData,
                throttled: adsPull.throttled,
                failed: adsPull.failed,
                skipped: adsPull.skipped,
              },
              rowsImported: adsPull.rowsImported,
              alertsFired: adsPull.alertsFired,
              spendApplied: adsPull.spendApplied,
              outcomes: adsPull.outcomes,
              errors: adsPull.errors,
            }
          : null,
      },
      orders: orders
        ? {
            enabled: withOrders,
            db: orders.db,
            apiConfigured: orders.apiConfigured,
            shopsProcessed: orders.shopsProcessed,
            ordersUpserted: orders.ordersUpserted,
            itemsUpserted: orders.itemsUpserted,
            pages: orders.pages,
            throttled: orders.throttled,
            deferred: orders.deferred,
            skipped: orders.skipped,
            failed: orders.failed,
            outcomes: orders.outcomes,
            errors: orders.errors,
          }
        : null,
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
