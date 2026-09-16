/**
 * Runner — tra PHÍ CHUẨN SP-API (Product Fees API v0) cho 1 ASIN tại 1 mức giá.
 *
 *   action lookupOfficialFeesAction → lookupSpApiFeesForAsin → ProductFeesClient
 *
 * VÌ SAO CẦN (sự cố B074VBLKSL 16/09/2026): bảng phí ước lượng + referral mặc
 * định 15% làm G1 phán NGƯỢC kết quả của Revenue Calculator (−14.9% thay vì
 * +50.6%). Endpoint getMyFeesEstimateForASIN cho số CHUẨN: referral thật theo
 * danh mục + phí FBA thật theo kích thước Amazon đo.
 *
 * Chọn marketplace: shop production đầu tiên trong DB (hoặc `sellerAccountId`
 * chỉ định); không có DB thì fallback ATVPDKIKX0DER (US) và ghi rõ trong log.
 */
import { loadConfig } from "./config.ts";
import { LwaTokenManager } from "./amazon/lwa.ts";
import { ProductFeesClient, type ProductFeesClientOptions } from "./amazon/product-fees.ts";
import { ordersHostForRegion } from "./amazon/orders.ts";
import { SupabaseDbAdapter } from "./db/supabase.ts";
import type { ActiveShop } from "./db/adapter.ts";
import type { SpApiFeesEstimate } from "./domain/product-fees.ts";

export type SpApiFeesLookupResult = {
  ok: boolean;
  reason: string | null;
  shopName: string | null;
  marketplaceId: string | null;
  /** fallback marketplace khi không đọc được shop từ DB */
  marketplaceFallback: boolean;
  estimate: SpApiFeesEstimate | null;
};

const US_MARKETPLACE = "ATVPDKIKX0DER";

export async function lookupSpApiFeesForAsin(
  input: {
    asin: string;
    price: number;
    currency?: string;
    sellerAccountId?: string | null;
  },
  deps: {
    stdout?: { write: (s: string) => void };
    /** cho test: tiêm client (null = chưa có credential) */
    client?: ProductFeesClient | null;
    /** cho test: tiêm danh sách shop thay vì đọc DB */
    shops?: ActiveShop[] | null;
    /** cho test: options client khi tự dựng */
    clientOptions?: ProductFeesClientOptions;
  } = {},
): Promise<SpApiFeesLookupResult> {
  const log = (text: string): void => {
    deps.stdout?.write(text);
  };
  const cfg = loadConfig();

  /* ---- shop & marketplace ---- */
  let shops: ActiveShop[] = deps.shops ?? [];
  if (deps.shops === undefined) {
    if (cfg.mode === "production" && cfg.supabase) {
      try {
        const sb = new SupabaseDbAdapter(cfg.supabase.url, cfg.supabase.serviceRoleKey);
        shops = await sb.listActiveProductionShops();
      } catch (e) {
        log(`[product-fees] không đọc được shop từ DB (${(e as Error).message.split("\n")[0]}) → dùng marketplace US mặc định.\n`);
      }
    }
  }
  const shop = input.sellerAccountId
    ? shops.find((s) => s.id === input.sellerAccountId) ?? null
    : shops[0] ?? null;
  const marketplaceId = shop?.marketplace ?? US_MARKETPLACE;
  const marketplaceFallback = shop === null;
  if (marketplaceFallback) {
    log("[product-fees] chưa có shop production trong DB → ước phí trên marketplace US (ATVPDKIKX0DER).\n");
  } else if (shop) {
    log(`[product-fees] dùng marketplace ${marketplaceId} của shop ${shop.displayName}.\n`);
  }

  /* ---- client SP-API ---- */
  let client = deps.client;
  if (client === undefined) {
    if (!cfg.lwa?.refreshToken) {
      return {
        ok: false,
        reason: "Chưa cấu hình credential SP-API (AMAZON_LWA_CLIENT_ID/_SECRET/_REFRESH_TOKEN) nên không gọi được Product Fees.",
        shopName: shop?.displayName ?? null,
        marketplaceId,
        marketplaceFallback,
        estimate: null,
      };
    }
    const lwa = new LwaTokenManager({
      clientId: cfg.lwa.clientId,
      clientSecret: cfg.lwa.clientSecret,
      refreshToken: cfg.lwa.refreshToken,
    });
    client = new ProductFeesClient(lwa, {
      host: ordersHostForRegion(
        cfg.spApiHost.includes("sandbox") ? "NA_SANDBOX" : (process.env.AMAZON_SP_API_REGION ?? "NA"),
      ),
      log,
      ...deps.clientOptions,
    });
  }
  if (client === null) {
    return {
      ok: false,
      reason: "Chưa cấu hình credential SP-API (AMAZON_LWA_CLIENT_ID/_SECRET/_REFRESH_TOKEN) nên không gọi được Product Fees.",
      shopName: shop?.displayName ?? null,
      marketplaceId,
      marketplaceFallback,
      estimate: null,
    };
  }

  try {
    const estimate = await client.estimateForAsin({
      asin: input.asin,
      marketplaceId,
      price: input.price,
      currency: input.currency ?? "USD",
      isAmazonFulfilled: true,
    });
    if (!estimate.ok) {
      return {
        ok: false,
        reason: `Amazon từ chối ước tính phí (${estimate.errorCode ?? "lỗi không rõ"}): ${estimate.errorMessage ?? ""}`,
        shopName: shop?.displayName ?? null,
        marketplaceId,
        marketplaceFallback,
        estimate,
      };
    }
    return {
      ok: true,
      reason: null,
      shopName: shop?.displayName ?? null,
      marketplaceId,
      marketplaceFallback,
      estimate,
    };
  } catch (e) {
    return {
      ok: false,
      reason: (e as Error).message.split("\n")[0],
      shopName: shop?.displayName ?? null,
      marketplaceId,
      marketplaceFallback,
      estimate: null,
    };
  }
}
