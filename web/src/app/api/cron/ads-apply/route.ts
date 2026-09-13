/**
 * GET/POST /api/cron/ads-apply — ÁP DỤNG thay đổi PPC lên Amazon (Module 5 Phần 2&3).
 *
 *   /api/cron/ads-apply                  → lấy lô ĐÃ DUYỆT, đối chiếu Amazon, rồi ghi
 *   /api/cron/ads-apply?dryRun=1         → đọc hàng đợi + đọc Amazon + in payload, KHÔNG gửi
 *   /api/cron/ads-apply?shop=<uuid>      → chỉ một shop (nhiều shop: phân cách bằng dấu ,)
 *   /api/cron/ads-apply?limit=50         → tối đa bao nhiêu đề xuất mỗi shop (≤500)
 *   /api/cron/ads-apply?skipVerify=1     → bỏ bước đọc lại Amazon (CHỈ khi đối soát tay)
 *
 * Chốt an toàn (xem thêm header của lib/ads/write.ts):
 *   • ADS_WRITE_ENABLED chưa bật → trả ok + hint, KHÔNG gọi Amazon và KHÔNG giành lô.
 *   • Chỉ áp dụng những dòng đã có người DUYỆT trong ads.change_requests.
 *   • Trước khi ghi luôn ĐỌC LẠI Amazon: giá trị hiện tại khác before_value → skip.
 *   • 429/5xx/lỗi mạng → dòng giữ trạng thái "applying" để lượt sau đòi lại (reclaim),
 *     không retry dồn trong cùng một lượt.
 *
 * Đây là route DUY NHẤT được phép gọi Amazon bằng service_role để ghi; UI chỉ tạo đề
 * xuất và duyệt qua RPC (anon + phiên đăng nhập).
 */
import { NextResponse } from "next/server";

import { createAdsDb, loadAdsConfig, runAdsApply } from "@/lib/ads";

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

function flag(raw: string | null): boolean {
  return ["1", "true", "yes", "on"].includes((raw ?? "").trim().toLowerCase());
}

export async function GET(req: Request) {
  const auth = authorize(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error, hint: auth.hint }, { status: auth.status });
  }

  const url = new URL(req.url);
  const config = loadAdsConfig();
  const dryRun = flag(url.searchParams.get("dryRun"));
  const skipVerify = flag(url.searchParams.get("skipVerify"));
  const shopParam = url.searchParams.get("shop")?.trim();
  const shops = shopParam ? shopParam.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw && Number.isFinite(Number(limitRaw)) ? Math.max(1, Math.min(Number(limitRaw), 500)) : undefined;
  const maxShopsRaw = url.searchParams.get("maxShops");
  const maxShops =
    maxShopsRaw && Number.isFinite(Number(maxShopsRaw)) ? Math.max(1, Math.min(Number(maxShopsRaw), 50)) : undefined;

  if (!config.ready && !dryRun) {
    return NextResponse.json(
      {
        ok: false,
        error: "Chưa đủ cấu hình để áp dụng thay đổi PPC.",
        problems: config.problems,
        hint:
          "Cần AMAZON_ADS_CLIENT_ID/SECRET + OAUTH_TOKEN_ENC_KEY + Supabase service role. " +
          "Xem trước mà không cần Supabase ghi: /api/cron/ads-apply?dryRun=1",
      },
      { status: 500 },
    );
  }

  const buf: string[] = [];
  try {
    // dryRun vẫn cần DB để ĐỌC hàng đợi; chỉ khác là không ghi kết quả.
    const db = config.supabase ? createAdsDb(config.supabase) : null;
    const res = await runAdsApply({
      config,
      db,
      shops,
      maxShops,
      limit,
      dryRun,
      skipVerify,
      stdout: {
        write: (s: string) => {
          buf.push(s);
          return undefined;
        },
      },
    });

    return NextResponse.json({
      ok: res.errors.length === 0 && res.counts.failed === 0,
      enabled: res.enabled,
      ready: res.ready,
      db: res.db,
      dryRun: res.dryRun,
      region: res.region,
      host: res.host,
      shopsProcessed: res.shopsProcessed,
      counts: res.counts,
      outcomes: res.outcomes,
      warnings: res.warnings,
      errors: res.errors,
      problems: res.problems,
      hint: res.hint,
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
