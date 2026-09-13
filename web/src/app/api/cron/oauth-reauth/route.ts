/**
 * GET/POST /api/cron/oauth-reauth — quét hạn Re-authorize 365 ngày (Module 0).
 *
 *   /api/cron/oauth-reauth                     → mọi service, nhắc trước 30 ngày
 *   /api/cron/oauth-reauth?noticeDays=45       → đổi số ngày nhắc
 *   /api/cron/oauth-reauth?service=ads         → chỉ quét token Ads API
 *
 * Vì sao PHẢI có cron này:
 *   Amazon buộc chủ shop RE-AUTHORIZE mỗi 365 ngày và chỉ gửi email nhắc cho CHỦ
 *   SHOP (không gửi cho developer). Quá hạn thì refresh token chết: MỌI job đồng bộ
 *   của shop đó dừng, và khoảng trống dữ liệu KHÔNG backfill được (Reports API chỉ
 *   giữ 60–95 ngày, Ads 65–95 ngày). Nên hệ thống phải tự đếm ngày.
 *
 * RPC vexim_oauth_reauth_scan (migration 0020) làm phần việc:
 *   • còn ≤ noticeDays ngày → alert amber `reauth_required` (dedupe theo entity_key)
 *   • quá hạn               → alert ĐỎ + tự chuyển token sang status='expired'
 *                             để worker không gọi API bằng token chết
 *   • vừa re-authorize      → tự đóng alert cũ
 * Route này chỉ chạy RPC và trả kết quả cho Vercel log.
 *
 * Bảo vệ bằng CRON_SECRET (Authorization: Bearer) — giống /api/cron/report-pull.
 */
import { NextResponse } from "next/server";

import { createOAuthStore, isOAuthService, loadOAuthConfig, type OAuthService } from "@/lib/oauth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

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
    return { ok: false, status: 401, error: "Sai hoặc thiếu header Authorization: Bearer <CRON_SECRET>." };
  }
  return { ok: true };
}

export async function GET(req: Request) {
  const auth = authorize(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error, hint: auth.hint }, { status: auth.status });
  }

  const url = new URL(req.url);
  const config = loadOAuthConfig();
  if (!config.supabase) {
    return NextResponse.json(
      {
        ok: false,
        error: "Chưa cấu hình Supabase service role — không quét được token.",
        problems: config.problems,
      },
      { status: 500 },
    );
  }

  const noticeRaw = url.searchParams.get("noticeDays");
  const noticeDays = noticeRaw && Number.isFinite(Number(noticeRaw)) ? Number(noticeRaw) : 30;
  const rawService = url.searchParams.get("service");
  const service: OAuthService | null = isOAuthService(rawService) ? rawService : null;

  const store = createOAuthStore(config.supabase);
  try {
    const rows = await store.scanReauth({ noticeDays, service });
    const due = rows.filter((r) => r.alertSeverity !== null);
    const overdue = rows.filter((r) => (r.daysToReauth ?? 0) <= 0);
    return NextResponse.json({
      ok: true,
      scanned: rows.length,
      noticeDays,
      service: service ?? "all",
      dueSoon: due.length,
      overdue: overdue.length,
      /** Không có token nào → chưa shop nào kết nối (không phải lỗi). */
      rows: rows.map((r) => ({
        shop: r.shopName,
        shopId: r.shopId,
        service: r.tokenService,
        tokenStatus: r.tokenStatus,
        daysToReauth: r.daysToReauth,
        severity: r.alertSeverity,
        nextAction: r.nextAction,
      })),
      hint:
        due.length > 0
          ? "Gửi link Re-authorize cho chủ shop: /module0/connect (nút Kết nối lại ở dòng đang vàng/đỏ)."
          : "Chưa có token nào tới hạn.",
      cronSecretConfigured: !!process.env.CRON_SECRET,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export const POST = GET;
