/**
 * Runner CLI cho L3 — tải JSON SCHEMA product type rồi lưu vào cache.
 *
 * VÌ SAO CẦN WORKER: web chạy bằng anon key, KHÔNG có credential SP-API nên
 * không tự gọi `getDefinitionsProductType` (Product Type Definitions API
 * 2020-09-01) được. Worker tải schema (required / maxLength / enum thật của
 * Amazon) rồi ghi vào `catalog.listing_product_type_schemas`; web đọc lại qua
 * view `public.vexim_listing_product_type_schemas` để dựng form động.
 *
 * LƯU Ý VỀ SCHEMA: response của getDefinitionsProductType KHÔNG chứa schema
 * inline mà trỏ tới `schema.link.resource` (pre-signed URL, tải không cần
 * Authorization — theo use case guide "Download the schema"). Runner tải link
 * đó rồi lưu phần JSON Schema (không lưu link, vì link hết hạn).
 *
 * AN TOÀN DỮ LIỆU (giống run-inventory-sync.ts / run-listing-publish.ts):
 * CHỈ gọi Amazon + ghi DB thật khi `cfg.mode === "production"` và không
 * truyền --dry-run. Các trường hợp khác chạy bộ nhớ, không gọi mạng.
 *
 * Chạy: npm run worker:listing-schema -- --product-type=LUGGAGE [--seller=<uuid>]
 *        [--marketplace=ATVPDKIKX0DER] [--requirements=LISTING] [--dry-run]
 */

import type { ListingsItemsClient, ProductTypeDefinition } from "../amazon/listings.ts";
import { ListingsItemsClient as Client } from "../amazon/listings.ts";
import { LwaTokenManager } from "../amazon/lwa.ts";
import { loadConfig } from "../config.ts";
import { MockDbAdapter, type ActiveShop, type DbAdapter } from "../db/adapter.ts";
import { SupabaseDbAdapter } from "../db/supabase.ts";

export type ListingSchemaCliResult = {
  mode: string;
  db: "supabase" | "mock";
  sellerAccountId: string;
  summary: Record<string, unknown>;
};

/** URL tải JSON Schema (nằm trong schema.link.resource) — null nếu Amazon đổi shape. */
export function extractSchemaLink(def: ProductTypeDefinition | null | undefined): string | null {
  const link = def?.schema?.link?.resource;
  return typeof link === "string" && link.length > 0 ? link : null;
}

/** Đếm nhanh để in log: số attribute + số attribute bắt buộc trong JSON Schema. */
export function summarizeSchema(schema: Record<string, unknown>): {
  attributes: number;
  required: number;
  id: string | null;
} {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
  return {
    attributes: Object.keys(properties).length,
    required: required.length,
    id: typeof schema.$id === "string" ? schema.$id : null,
  };
}

/**
 * Tải JSON Schema từ link (hoặc nhận schema inline nếu Amazon trả thẳng).
 * Không gửi Authorization: link là pre-signed, tự hết hạn sau ít phút.
 */
export async function fetchProductTypeSchema(
  def: ProductTypeDefinition | null | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  if (def && typeof (def as { properties?: unknown }).properties === "object" && def.properties !== null) {
    return def as unknown as Record<string, unknown>; // Amazon trả inline (một số SDK/phiên bản)
  }
  const link = extractSchemaLink(def);
  if (!link) {
    throw new Error(
      "[listing:schema] getDefinitionsProductType không trả schema.link.resource — kiểm tra lại version 2020-09-01",
    );
  }
  const res = await fetchFn(link);
  if (!res.ok) {
    throw new Error(`[listing:schema] tải schema thất bại: HTTP ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as unknown;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("[listing:schema] schema tải về không phải JSON object");
  }
  return body as Record<string, unknown>;
}

function pickShop(
  shops: ActiveShop[],
  sellerAccountId: string | null | undefined,
): { shop: ActiveShop | null; error: string | null } {
  if (sellerAccountId) {
    const found = shops.find((s) => s.id === sellerAccountId);
    return found ? { shop: found, error: null } : { shop: null, error: `Không thấy shop ${sellerAccountId}` };
  }
  if (shops.length === 1) return { shop: shops[0], error: null };
  return {
    shop: null,
    error:
      `Có ${shops.length} shop production → phải chỉ định --seller=<uuid>. ` +
      `Danh sách: ${shops.map((s) => `${s.displayName}=${s.id}`).join(", ")}`,
  };
}

export async function runListingSchemaCli(opts: {
  sellerAccountId?: string | null;
  productType: string | null;
  marketplaceId?: string;
  requirements?: string;
  locale?: string;
  dryRun?: boolean;
  stdout?: { write: (s: string) => void };
  /** Cho test: tiêm client/fetch giả */
  client?: ListingsItemsClient;
  adapter?: DbAdapter;
  fetchFn?: typeof fetch;
}): Promise<ListingSchemaCliResult> {
  const log = (s: string) => opts.stdout?.write(s);
  const cfg = loadConfig();
  const dryRun = opts.dryRun === true;
  const marketplaceId = opts.marketplaceId ?? "ATVPDKIKX0DER";
  const requirements = opts.requirements ?? "LISTING";
  const locale = opts.locale ?? "en_US";

  const productType = (opts.productType ?? "").trim();
  if (!productType) {
    throw new Error("Thiếu --product-type=<PRODUCT_TYPE> (vd LUGGAGE, HOME_BED_AND_BATH…)");
  }
  if (!["LISTING", "LISTING_PRODUCT_ONLY", "LISTING_OFFER_ONLY", "OFFER"].includes(requirements)) {
    throw new Error(`--requirements không hợp lệ: ${requirements}`);
  }

  // TEST/DEMO: có adapter+client tiêm vào thì chạy thật trong bộ nhớ.
  if (opts.adapter && opts.client) {
    const def = await opts.client.getDefinitionsProductType({
      productType,
      marketplaceId,
      requirements: requirements as never,
      locale,
    });
    const schema = await fetchProductTypeSchema(def, opts.fetchFn ?? fetch);
    await opts.adapter.upsertProductTypeSchema({ marketplaceId, productType, requirements, schema });
    const sum = summarizeSchema(schema);
    log(
      `[listing:schema] đã lưu schema ${productType} (${marketplaceId}/${requirements}): ` +
        `${sum.attributes} attribute · ${sum.required} bắt buộc\n`,
    );
    return {
      mode: cfg.mode,
      db: opts.adapter instanceof MockDbAdapter ? "mock" : "supabase",
      sellerAccountId: opts.sellerAccountId ?? "(test)",
      summary: { marketplaceId, productType, requirements, ...sum },
    };
  }

  if (dryRun || cfg.mode !== "production" || !cfg.supabase || !cfg.lwa) {
    log(
      `[listing:schema] mode=${cfg.mode}${dryRun ? " · --dry-run" : ""} → KHÔNG gọi Amazon, KHÔNG ghi DB.\n` +
        `  Sẽ tải schema ${productType} cho ${marketplaceId} (requirements=${requirements}).\n` +
        "  (Cần AMAZON_LWA_* + SUPABASE_SERVICE_ROLE_KEY trong web/.env.local để chạy thật.)\n",
    );
    return {
      mode: cfg.mode,
      db: "mock",
      sellerAccountId: opts.sellerAccountId ?? "(chưa chọn)",
      summary: { note: "dry-run/mock — không gọi SP-API, không ghi cache", productType, marketplaceId, requirements },
    };
  }

  const db: DbAdapter = new SupabaseDbAdapter(cfg.supabase.url, cfg.supabase.serviceRoleKey);
  const shops = await db.listActiveProductionShops();
  const { shop, error } = pickShop(shops, opts.sellerAccountId);
  if (!shop) throw new Error(error ?? "Không xác định được shop");

  const client =
    opts.client ??
    new Client({
      host: cfg.spApiHost,
      lwa: new LwaTokenManager({
        clientId: cfg.lwa.clientId,
        clientSecret: cfg.lwa.clientSecret,
        refreshToken: cfg.lwa.refreshToken,
      }),
    });

  const def = await client.getDefinitionsProductType({
    productType,
    marketplaceId,
    requirements: requirements as never,
    locale,
    sellerId: shop.sellerId,
  });
  const schema = await fetchProductTypeSchema(def, opts.fetchFn ?? fetch);
  await db.upsertProductTypeSchema({ marketplaceId, productType, requirements, schema });

  const sum = summarizeSchema(schema);
  log(
    `\n[listing:schema] shop=${shop.displayName} (${shop.sellerId})\n` +
      `  ${productType} · ${marketplaceId} · ${requirements} → ${sum.attributes} attribute · ${sum.required} bắt buộc\n` +
      `  đã lưu vào cache — form L3 sẽ dùng required/maxLength từ schema này.\n`,
  );

  return {
    mode: cfg.mode,
    db: "supabase",
    sellerAccountId: shop.id,
    summary: { shop: shop.displayName, marketplaceId, productType, requirements, ...sum },
  };
}
