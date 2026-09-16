/**
 * Cron API — ĐỒNG BỘ ĐƠN HÀNG (Module 4) qua Orders API v0.
 *
 *   /api/cron/orders-sync                → mọi shop production, nhìn lại 7 ngày
 *   /api/cron/orders-sync?days=30        → backfill (kẹp 1..60)
 *   /api/cron/orders-sync?shop=<uuid>    → chỉ một shop
 *   /api/cron/orders-sync?maxItems=50    → trần số đơn được lấy orderItems lượt này
 *   /api/cron/orders-sync?dryRun=1       → gọi Amazon + parse, KHÔNG ghi DB
 *
 * VÌ SAO CÓ ENDPOINT NÀY (16/09/2026):
 *   Trước đây Module 4 chỉ có đường REPORT (`/api/cron/report-pull` với kinds
 *   fc/receipts/storage-fees/noncompliance — KHÔNG có report đơn hàng) và màn
 *   /orders vì thế luôn rỗng. Nay đường delta chạy thật:
 *   getOrders(LastUpdatedAfter) → getOrderItems → upsert orders/order_items/order_daily.
 *
 * VÌ SAO 30 PHÚT/LẦN MÀ TRONG CÙNG MỘT CRON (không thêm cron thứ tư):
 *   Vercel Hobby giới hạn cron; hơn nữa getOrders chỉ cho 0.0167 rps nên chạy dày
 *   cũng vô ích. `vercel.json` đặt lịch "mỗi 30 phút" cho đường này — Hobby chỉ hỗ trợ
 *   tần suất theo NGÀY nên nếu bị từ chối khi deploy, dùng lịch 2 giờ/lần.
 *   Chạy tay ngay tại chỗ: nút "Đồng bộ ngay" trên /orders hoặc
 *   `cd worker && npm run worker:orders-sync -- --days=7`.
 *
 * Rate limit: getOrders 0.0167 rps/burst 20 · getOrderItems 0.5 rps/burst 30 ⇒ mỗi
 * lượt cron có TRẦN (mặc định 200 đơn lấy item). Đơn chưa lấy được item vẫn ghi
 * được đơn (thiếu SKU) và lần chạy sau bù — response ghi rõ `deferred`.
 *
 * Protect bằng CRON_SECRET (Authorization: Bearer <CRON_SECRET>). Thiếu CRON_SECRET
 * trên production ⇒ 500 kèm hướng dẫn (không trả 401 mơ hồ).
 */
import { NextResponse } from "next/server";
import { runOrdersSyncAll } from "@/lib/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

export async function GET(req: Request) {
  const auth = authorize(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error, hint: auth.hint }, { status: auth.status });
  }

  const url = new URL(req.url);
  const daysRaw = url.searchParams.get("days");
  const days = daysRaw && Number.isFinite(Number(daysRaw)) ? Number(daysRaw) : null;
  const maxItemsRaw = url.searchParams.get("maxItems");
  const maxItemFetches =
    maxItemsRaw && Number.isFinite(Number(maxItemsRaw)) ? Number(maxItemsRaw) : null;
  const shop = url.searchParams.get("shop");
  const dryRun = url.searchParams.get("dryRun") === "1" || url.searchParams.get("dryRun") === "true";

  const buf: string[] = [];
  const out = {
    write: (s: string) => {
      buf.push(s);
      return undefined;
    },
  };

  try {
    const res = await runOrdersSyncAll({
      days,
      maxItemFetches,
      sellerAccountId: shop,
      dryRun,
      stdout: out,
    });

    return NextResponse.json({
      ok: res.failed === 0,
      mode: res.mode,
      db: res.db,
      apiConfigured: res.apiConfigured,
      shopsProcessed: res.shopsProcessed,
      counts: {
        orders: res.ordersUpserted,
        items: res.itemsUpserted,
        pages: res.pages,
        throttled: res.throttled,
        deferred: res.deferred,
        skipped: res.skipped,
        failed: res.failed,
      },
      outcomes: res.outcomes,
      errors: res.errors,
      days: days ?? 7,
      maxItemFetches: maxItemFetches ?? 200,
      dryRun,
      hint:
        res.skipped > 0 && res.ordersUpserted === 0
          ? "Chưa có đơn nào được ghi. Kiểm tra AMAZON_LWA_CLIENT_ID/_SECRET/_REFRESH_TOKEN + SUPABASE_SERVICE_ROLE_KEY, " +
            "và shop phải có status='active' AND data_source='production' (Module 0 · Kết nối shop)."
          : undefined,
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
