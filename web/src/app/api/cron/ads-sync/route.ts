/**
 * GET/POST /api/cron/ads-sync — đồng bộ Amazon Ads API (Module 5, phần đọc).
 *
 *   /api/cron/ads-sync                       → poll report cũ + xin report mới (4 loại)
 *   /api/cron/ads-sync?phase=poll            → chỉ nhập report đã xong (nhanh, ít call)
 *   /api/cron/ads-sync?phase=request         → chỉ xin report mới
 *   /api/cron/ads-sync?kinds=campaigns,searchTerms&days=14
 *   /api/cron/ads-sync?shop=<uuid>           → chỉ một shop
 *   /api/cron/ads-sync?dryRun=1              → gọi Amazon + parse, KHÔNG ghi DB
 *   /api/cron/ads-sync?poll=2&delay=5000     → poll thêm 2 lần × 5s sau khi xin report
 *
 * Vì sao KHÔNG ngồi chờ report: Reporting v3 bất đồng bộ, Amazon nói rõ có thể chạy
 * TỚI 3 GIỜ. Cron ghi reportId vào ads.report_requests rồi thoát; lần chạy sau pha
 * POLL nhập tiếp. Trần 60s của serverless vì thế không bao giờ bị chạm.
 *
 * Bảo vệ bằng CRON_SECRET giống /api/cron/report-pull: thiếu biến trên production thì
 * trả 500 kèm hướng dẫn (401 mơ hồ khiến Vercel chỉ hiện "failed", không ai biết vì sao).
 */
import { NextResponse } from "next/server";

import {
  ADS_REPORT_KINDS,
  createAdsDb,
  isAdsReportKind,
  kindForReportTypeId,
  loadAdsConfig,
  runAdsSync,
  type AdsReportKind,
} from "@/lib/ads";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type AuthResult = { ok: true } | { ok: false; status: 401 | 500; error: string; hint?: string };

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
    return { ok: false, status: 401, error: "Sai hoặc thiếu header Authorization: Bearer <CRON_SECRET>." };
  }
  return { ok: true };
}

function parseKinds(raw: string | null): { kinds: AdsReportKind[] | undefined; bad: string[] } {
  if (!raw) return { kinds: undefined, bad: [] };
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const kinds: AdsReportKind[] = [];
  const bad: string[] = [];
  for (const p of parts) {
    // Chấp nhận cả tên nội bộ (campaigns) lẫn reportTypeId (spCampaigns) để người
    // vận hành không phải nhớ bảng ánh xạ.
    const kind: AdsReportKind | null = isAdsReportKind(p) ? p : kindForReportTypeId(p);
    if (kind) kinds.push(kind);
    else bad.push(p);
  }
  return { kinds: kinds.length > 0 ? kinds : [...ADS_REPORT_KINDS], bad };
}

function parsePhase(raw: string | null): "all" | "poll" | "request" {
  return raw === "poll" || raw === "request" ? raw : "all";
}

export async function GET(req: Request) {
  const auth = authorize(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error, hint: auth.hint }, { status: auth.status });
  }

  const url = new URL(req.url);
  const config = loadAdsConfig();
  const { kinds, bad } = parseKinds(url.searchParams.get("kinds"));
  const phase = parsePhase(url.searchParams.get("phase"));
  const dryRun = ["1", "true", "yes"].includes((url.searchParams.get("dryRun") ?? "").toLowerCase());
  const daysRaw = url.searchParams.get("days");
  const days = daysRaw && Number.isFinite(Number(daysRaw)) ? Number(daysRaw) : undefined;
  const shopParam = url.searchParams.get("shop")?.trim();
  const shops = shopParam ? shopParam.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const pollRaw = url.searchParams.get("poll");
  const pollAttempts = pollRaw && Number.isFinite(Number(pollRaw)) ? Math.max(0, Math.min(Number(pollRaw), 6)) : 0;
  const delayRaw = url.searchParams.get("delay");
  const pollDelayMs =
    delayRaw && Number.isFinite(Number(delayRaw)) ? Math.max(1000, Math.min(Number(delayRaw), 20_000)) : 5_000;
  const raiseAlerts = !["0", "false"].includes((url.searchParams.get("alerts") ?? "").toLowerCase());
  const fillProfit = !["0", "false"].includes((url.searchParams.get("profit") ?? "").toLowerCase());

  if (!config.ready && !dryRun) {
    return NextResponse.json(
      {
        ok: false,
        error: "Chưa đủ cấu hình để đồng bộ Ads API.",
        problems: config.problems,
        hint:
          "Cần AMAZON_ADS_CLIENT_ID/SECRET + OAUTH_TOKEN_ENC_KEY + Supabase service role. " +
          "Chạy thử không ghi DB: /api/cron/ads-sync?dryRun=1",
      },
      { status: 500 },
    );
  }

  const buf: string[] = [];
  try {
    const db = !dryRun && config.supabase ? createAdsDb(config.supabase) : null;
    const res = await runAdsSync({
      config,
      db,
      shops,
      kinds,
      days,
      endDate: url.searchParams.get("endDate"),
      phase,
      pollAttempts,
      pollDelayMs,
      raiseAlerts,
      fillProfit,
      dryRun,
      stdout: {
        write: (s: string) => {
          buf.push(s);
          return undefined;
        },
      },
    });

    return NextResponse.json({
      ok: res.errors.length === 0 && res.counts.failed === 0,
      ready: res.ready,
      db: res.db,
      phase: res.phase,
      region: res.region,
      host: res.host,
      dryRun: res.dryRun,
      shopsProcessed: res.shopsProcessed,
      counts: res.counts,
      rowsImported: res.rowsImported,
      alerts: res.alerts,
      profitRows: res.profitRows,
      outcomes: res.outcomes,
      warnings: res.warnings,
      errors: res.errors,
      problems: res.problems,
      unknownKinds: bad,
      hint:
        res.counts.created > 0 && res.counts.imported === 0
          ? "Report đã xin xong và Amazon đang tạo — pha POLL của lần chạy sau sẽ nhập. Chạy sớm hơn: /api/cron/ads-sync?phase=poll"
          : undefined,
      cronSecretConfigured: !!process.env.CRON_SECRET,
      log: buf.join(""),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message, problems: config.problems, log: buf.join("") },
      { status: 500 },
    );
  }
}

export const POST = GET;
