/**
 * GET /api/amazon/whoami
 *
 * Tra seller_id + marketplace + TÊN SHOP (storeName) của refresh_token đang cấu
 * hình trên Vercel (self-authorization). Khoá bằng CRON_SECRET giống route cron —
 * không trả access token. Thiếu CRON_SECRET trên production → 500 rõ ràng
 * (không lặp lại bug im lặng 401 của route cron cũ).
 *
 * FIX 16/09/2026 — "kéo shop về mà không thấy tên shop":
 *   getMarketplaceParticipations vốn ĐÃ trả `storeName` ("The name of the seller's
 *   store as displayed in the marketplace"), nhưng parseMarketplaces chỉ đọc
 *   marketplace.name (= "Amazon.com") rồi bỏ storeName ⇒ không có tên shop nào để
 *   hiển thị. Nay response có `storeName` + `storeNames[]` theo từng marketplace.
 *
 * Middleware whitelist path này (không đòi cookie session).
 */
import { NextResponse } from "next/server";
import { getSpApiConfig, spapi } from "@/lib/spapi/client";
import { discoverSellerIdentity } from "@/lib/spapi/whoami";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Shop production đã chốt (xem supabase/migrations/0009_seed_production_shops.sql).
 * Dùng để đối chiếu: nếu refresh_token đang cấu hình trả sellerId KHÁC, tức
 * Vercel đang dùng token của shop khác → cron sẽ sync sai shop.
 */
const PRODUCTION_SHOP = {
  sellerId: "AQMVYI4HJTI4C",
  marketplaces: ["ATVPDKIKX0DER", "A2EUQ1WTGCTBG2"], // US + CA
} as const;

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
      // Ưu tiên US khi shop tham gia nhiều marketplace (US + CA).
      preferredMarketplaceId: PRODUCTION_SHOP.marketplaces[0],
    });
    const matchesProductionShop = result.sellerId === PRODUCTION_SHOP.sellerId;

    return NextResponse.json({
      ...result,
      spapiConfigured: true,
      cronSecretConfigured: !!process.env.CRON_SECRET,
      productionShop: {
        ...PRODUCTION_SHOP,
        source: "supabase/migrations/0009_seed_production_shops.sql",
        matchesRefreshToken: matchesProductionShop,
      },
      notes: [
        "Không trả access_token / refresh_token / cookie value.",
        "sellerId lấy từ feesEstimate.FeesEstimateIdentifier.SellerId — Amazon không có endpoint whoami chính thức.",
        "storeName = TÊN SHOP trên Amazon, lấy từ getMarketplaceParticipations.storeName "
          + "(Sellers API v1 — field bắt buộc theo mô hình chính thức, KHÁC marketplace.name là tên sàn).",
        result.storeName
          ? `Tên shop Amazon của ${result.marketplace?.countryCode ?? "?"} (${result.marketplace?.id ?? "?"}): “${result.storeName}”.`
          : "Amazon không trả storeName trong lần gọi này — kiểm tra role/app đã publish; "
            + "field này có từ changelog SP-API 18/12/2024.",
        `Tên shop theo từng marketplace: ${
          result.storeNames
            .map((s) => `${s.marketplaceId}/${s.countryCode || "?"}=${s.storeName ?? "—"}`)
            .join(" · ") || "—"
        }`,
        "Marketplace được ưu tiên ATVPDKIKX0DER (US) — shop production bán cả US + CA.",
        result.usedFallbackAsin
          ? `Inventory trống (0 SKU): đã mượn ASIN dự phòng ${result.asin} để vẫn lấy được SellerId.`
          : null,
        matchesProductionShop
          ? null
          : `sellerId từ token (${result.sellerId ?? "—"}) KHÁC shop production đã chốt (${PRODUCTION_SHOP.sellerId}) — kiểm tra lại AMAZON_LWA_REFRESH_TOKEN trên Vercel.`,
      ].filter((n): n is string => Boolean(n)),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}

export const POST = GET;
