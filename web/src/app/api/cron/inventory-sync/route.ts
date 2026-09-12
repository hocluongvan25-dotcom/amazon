/**
 * Cron API — được gọi bởi Vercel Cron mỗi 30 phút để đồng bộ tồn kho.
 * Protect bằng CRON_SECRET (header Authorization: Bearer <CRON_SECRET>).
 *
 * Ở DEMO MODE (không SP-API/DB credentials) endpoint vẫn trả 200 và chạy
 * với dữ liệu demo trong bộ nhớ — không làm lỗi build preview trên Vercel.
 *
 * CHẨN ĐOÁN (thêm 12/09/2026):
 *   Trước đây khi CRON_SECRET chưa được đặt, hàm isAuthorized() trả false
 *   trên production và endpoint trả 401 "unauthorized" — trông giống lỗi
 *   xác thực, che mất nguyên nhân thật là THIẾU BIẾN MÔI TRƯỜNG. Vercel Cron
 *   chỉ hiện "failed" không lý do. Nay trả 500 kèm thông báo nêu đích danh
 *   biến còn thiếu.
 */
import { NextResponse } from "next/server";
import { runInventorySyncAll } from "@/lib/worker";
import { getSpApiConfig } from "@/lib/spapi/client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type AuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 500; error: string; hint?: string };

function authorize(req: Request): AuthResult {
  const expected = process.env.CRON_SECRET;
  const isProd = process.env.NODE_ENV === "production";

  // Thiếu biến: KHÔNG im lặng trả 401. Trên production đây là lỗi cấu hình.
  if (!expected) {
    if (isProd) {
      return {
        ok: false,
        status: 500,
        error: "CRON_SECRET chưa được cấu hình trên Vercel.",
        hint:
          "Vercel → Project Settings → Environment Variables → thêm CRON_SECRET " +
          "(chuỗi ngẫu nhiên dài) cho cả Production và Preview, rồi Redeploy. " +
          "Vercel Cron tự gửi header Authorization: Bearer <CRON_SECRET>.",
      };
    }
    // Dev/preview local: cho chạy để test, nhưng nói rõ trong response.
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

async function run() {
  const buf: string[] = [];
  const res = await runInventorySyncAll({
    stdout: {
      write: (s: string) => {
        buf.push(s);
        return true;
      },
    },
  });
  return { res, log: buf.join("") };
}

export async function GET(req: Request) {
  const auth = authorize(req);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error, hint: auth.hint },
      { status: auth.status },
    );
  }

  try {
    const { res, log } = await run();
    return NextResponse.json({
      ok: true,
      mode: res.mode,
      db: res.db,
      shopsProcessed: res.shopsProcessed,
      totalSkus: res.totalSkus,
      totalAlerts: res.totalAlerts,
      errors: res.errors,
      log,
      // LƯU Ý: getSpApiConfig() trả OBJECT {region, configured}, không phải null.
      // `!!getSpApiConfig()` luôn true (bug có từ commit 10974b6) — phải đọc .configured.
      spapiConfigured: getSpApiConfig().configured,
      spapiRegion: getSpApiConfig().region,
      cronSecretConfigured: !!process.env.CRON_SECRET,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}

export const POST = GET;
