/**
 * GET /api/amazon/whoami
 *
 * Tra seller_id + marketplace của refresh_token đang cấu hình trên Vercel
 * (self-authorization). Khoá bằng CRON_SECRET giống route cron — không
 * trả access token. Thiếu CRON_SECRET trên production → 500 rõ ràng
 * (không lặp lại bug im lặng 401 của route cron cũ).
 *
 * Middleware whitelist path này (không đòi cookie session).
 */
import { NextResponse } from "next/server";
import { getSpApiConfig, spapi } from "@/lib/spapi/client";
import { discoverSellerIdentity } from "@/lib/spapi/whoami";

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
          "(chuỗi ngẫu nhiên dài) cho cả Production và Preview, rồi Redeploy. " +
          "Gọi endpoint này với header Authorization: Bearer <CRON_SECRET>.",
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
    return NextResponse.json(
      { ok: false, error: auth.error, hint: auth.hint },
      { status: auth.status },
    );
  }

  const cfg = getSpApiConfig();
  if (!cfg.configured) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Thiếu AMAZON_LWA_CLIENT_ID / AMAZON_LWA_CLIENT_SECRET / AMAZON_LWA_REFRESH_TOKEN.",
        hint:
          "Vercel → Environment Variables → thêm 3 biến LWA (token của CHÍNH shop bạn, " +
          "self-authorization). Sau khi set, Redeploy rồi gọi lại endpoint này.",
        region: cfg.region,
        spapiConfigured: false,
        cronSecretConfigured: !!process.env.CRON_SECRET,
      },
      { status: 200 },
    );
  }

  try {
    const result = await discoverSellerIdentity({
      spapi,
      region: cfg.region,
    });
    return NextResponse.json({
      ...result,
      spapiConfigured: true,
      cronSecretConfigured: !!process.env.CRON_SECRET,
      notes: [
        "Không trả access_token / refresh_token / cookie value.",
        "sellerId lấy từ feesEstimate.FeesEstimateIdentifier.SellerId — Amazon không có endpoint whoami chính thức.",
        "Dùng seller_id + marketplace để khai connections.seller_accounts.",
      ],
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}

export const POST = GET;
