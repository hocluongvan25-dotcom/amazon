/**
 * Cron API — Vercel Cron gọi mỗi ngày để TỰ KÉO 4 report FBA (0019).
 *
 *   /api/cron/report-pull                       → cả 4 loại report
 *   /api/cron/report-pull?kinds=storage-fees    → chỉ phí lưu kho
 *   /api/cron/report-pull?days=7                → ghi đè khoảng ngày mặc định
 *   /api/cron/report-pull?dryRun=1              → tải + parse, KHÔNG ghi DB
 *
 * Protect bằng CRON_SECRET (Authorization: Bearer <CRON_SECRET>) — Vercel Cron tự
 * gửi header này. Thiếu CRON_SECRET trên production → trả 500 kèm hướng dẫn
 * (bài học từ /api/cron/inventory-sync: trả 401 mơ hồ khiến Vercel chỉ hiện
 * "failed" và không ai biết nguyên nhân là thiếu biến môi trường).
 *
 * VÌ SAO maxDuration = 60 VÀ CHỈ POLL 2 LẦN:
 *   Report Amazon tạo bất đồng bộ. Cron KHÔNG được ngồi chờ: poll 2 lần cách nhau
 *   5 giây, chưa xong thì ghi trạng thái vào connections.report_requests và để
 *   lần chạy sau poll tiếp đúng reportId đó (job đã xử lý). Muốn chờ lâu hơn thì
 *   chạy CLI: `npm run worker:reports-pull` (không bị trần 60s của serverless).
 */
import { NextResponse } from "next/server";
import { ALL_REPORT_KINDS, isReportKind, runReportPullAll, type ReportKind } from "@/lib/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CRON_POLL_ATTEMPTS = 2;
const CRON_POLL_DELAY_MS = 5_000;

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
  const daysRaw = url.searchParams.get("days");
  const days = daysRaw && Number.isFinite(Number(daysRaw)) ? Number(daysRaw) : null;
  const dryRun = url.searchParams.get("dryRun") === "1" || url.searchParams.get("dryRun") === "true";

  const buf: string[] = [];
  try {
    const res = await runReportPullAll({
      kinds,
      days,
      dryRun,
      pollAttempts: CRON_POLL_ATTEMPTS,
      pollDelayMs: CRON_POLL_DELAY_MS,
      stdout: {
        write: (s: string) => {
          buf.push(s);
          return undefined;
        },
      },
    });
    return NextResponse.json({
      ok: res.failed === 0,
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
