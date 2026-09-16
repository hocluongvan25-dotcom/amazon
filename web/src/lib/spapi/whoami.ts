/**
 * Tra seller_id + marketplace của chính refresh_token đang cấu hình
 * (self-authorization — token của shop mình, không phải shop khách).
 *
 * Amazon KHÔNG có endpoint trả seller ID của chính bạn:
 *   - getMarketplaceParticipations → chỉ marketplace
 *   - getAccount (beta) → sandbox + EU, vẫn không có sellerId
 *   - seller ID chỉ lộ ở query `selling_partner_id` lúc OAuth authorize
 *
 * Cách khả dĩ: POST /products/fees/v0/items/{Asin}/feesEstimate
 * rồi đọc payload.FeesEstimateResult.FeesEstimateIdentifier.SellerId
 * (kể cả khi Status = ClientError — SellerId vẫn có).
 *
 * Logic thuần: nhận `spapi` qua tham số để test không cần network.
 * Mỗi bước lỗi được bắt riêng, không làm hỏng bước khác.
 */

export type SpApiFn = (
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  path: string,
  opts?: {
    body?: unknown;
    query?: Record<string, string | number | undefined>;
    headers?: Record<string, string>;
  },
) => Promise<{ status: number; data: unknown; raw: string }>;

export type MarketplaceInfo = {
  id: string;
  name: string;
  countryCode: string;
  currencyCode: string;
  domainName: string;
  isSuspended: boolean;
  /**
   * TÊN SHOP của seller TRÊN marketplace này — `storeName` của
   * MarketplaceParticipation (Sellers API v1), theo mô hình chính thức:
   *   "storeName": "The name of the seller's store as displayed in the marketplace"
   *   (bắt buộc có trong response từ changelog SP-API 18/12/2024)
   *
   * ⚠️ KHÁC `name` — `name` là tên SÀN ("Amazon.com"), `storeName` mới là tên
   * gian hàng của mình. Đây chính là field trước đây bị bỏ qua khiến "kéo shop về
   * mà không hiển thị được tên shop Amazon".
   */
  storeName: string | null;
};

export type WhoamiStep<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
};

export type InventoryWhoami = {
  skuCount: number;
  hasMore: boolean;
  sampleAsin: string | null;
  sampleSku: string | null;
};

export type FeesWhoami = {
  sellerId: string | null;
  status: string | null;
  /** ASIN thật sự dùng để gọi feesEstimate (từ inventory hoặc fallback) */
  asin: string | null;
  /** true = inventory trống/0 SKU, phải mượn ASIN dự phòng */
  usedFallbackAsin: boolean;
};

/**
 * Marketplace mặc định của shop production VEXIM.
 * Shop bán cả US + CA, nhưng Amazon trả danh sách marketplaceParticipations
 * theo thứ tự bất định → phải ƯU TIÊN US thay vì lấy phần tử đầu tiên, nếu
 * không sellerId/marketplace chốt cho DB có thể rơi vào CA (A2EUQ1WTGCTBG2).
 */
export const US_MARKETPLACE_ID = "ATVPDKIKX0DER";

/**
 * ASIN dự phòng khi inventory trống.
 *
 * feesEstimate là cách duy nhất Amazon lộ SellerId, mà nó cần một ASIN.
 * Shop mới chưa có tồn kho FBA → bước inventory trả 0 summary → trước đây
 * bước fees bị skip và whoami không bao giờ trả sellerId (rơi đúng vào tình
 * huống cần khai shop production lần đầu). Một ASIN bất kỳ tồn tại trên
 * marketplace là đủ: ta chỉ cần SellerId trong payload trả về, không cần
 * đúng SKU của mình.
 */
export const DEFAULT_FALLBACK_ASIN = "B08N5WRWNW";

export type WhoamiResult = {
  ok: boolean;
  region: string;
  marketplaces: MarketplaceInfo[];
  marketplace: MarketplaceInfo | null;
  /** Tên shop Amazon (storeName) của marketplace đã chốt — null nếu Amazon không trả */
  storeName: string | null;
  /** Tên shop theo TỪNG marketplace (US/CA có thể khác nhau) */
  storeNames: {
    marketplaceId: string;
    countryCode: string;
    storeName: string | null;
    isSuspended: boolean;
  }[];
  inventory: InventoryWhoami | null;
  sellerId: string | null;
  /** ASIN đã dùng cho feesEstimate (inventory hoặc fallback) */
  asin: string | null;
  usedFallbackAsin: boolean;
  steps: {
    marketplaces: WhoamiStep<MarketplaceInfo[]>;
    inventory: WhoamiStep<InventoryWhoami>;
    feesEstimate: WhoamiStep<FeesWhoami>;
  };
  sqlHint: string | null;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function unwrapPayload(data: unknown): unknown {
  const r = asRecord(data);
  if (r && "payload" in r) return r.payload;
  return data;
}

function clip(raw: string, max = 400): string {
  const s = raw.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function httpError(status: number, raw: string): string {
  return `HTTP ${status}: ${clip(raw) || "(empty)"}`;
}

/**
 * Chuẩn hoá tên shop: bỏ khoảng trắng thừa, chuỗi rỗng ⇒ null.
 * Amazon có thể trả `storeName` thiếu (app/token rất cũ) — khi đó null, KHÔNG
 * được bịa ra tên từ marketplace.name (sẽ ghi "Amazon.com" thành tên shop).
 */
export function normalizeStoreName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/\s+/g, " ").trim();
  return s.length > 0 ? s : null;
}

export function parseMarketplaces(data: unknown): MarketplaceInfo[] {
  const payload = unwrapPayload(data);
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(asRecord(payload)?.marketplaceParticipations)
      ? (asRecord(payload)!.marketplaceParticipations as unknown[])
      : [];
  const out: MarketplaceInfo[] = [];
  for (const item of list) {
    const row = asRecord(item);
    if (!row) continue;
    const mp = asRecord(row.marketplace) ?? row;
    const part = asRecord(row.participation);
    const id = typeof mp.id === "string" ? mp.id : "";
    if (!id) continue;
    const isParticipating = part?.isParticipating;
    const hasSuspended = part?.hasSuspendedListings;
    const isSuspended =
      hasSuspended === true || isParticipating === false;
    // storeName nằm ở cấp MarketplaceParticipation (cạnh `marketplace`). Vài
    // payload sandbox/proxy bọc trong `participation`/`marketplace` → đọc thêm
    // để không mất tên shop, nhưng vẫn xếp đúng thứ tự ưu tiên theo spec.
    const storeName =
      normalizeStoreName(row.storeName) ??
      normalizeStoreName(part?.storeName) ??
      normalizeStoreName(mp.storeName);
    out.push({
      id,
      name: typeof mp.name === "string" ? mp.name : id,
      countryCode: typeof mp.countryCode === "string" ? mp.countryCode : "",
      currencyCode:
        typeof mp.defaultCurrencyCode === "string"
          ? mp.defaultCurrencyCode
          : typeof mp.currencyCode === "string"
            ? mp.currencyCode
            : "",
      domainName: typeof mp.domainName === "string" ? mp.domainName : "",
      isSuspended,
      storeName,
    });
  }
  return out;
}

/**
 * Tên shop Amazon của một marketplace cụ thể trong danh sách participations.
 *
 * Vì sao cần hàm riêng: `storeName` là thuộc tính THEO TỪNG MARKETPLACE — shop
 * VEXIM bán US + CA có thể đặt tên khác nhau ("VEXIM US" / "VEXIM CA"). Ghi tên
 * của US cho dòng CA là sai dữ liệu, nên luôn tra theo đúng marketplace id.
 */
export function storeNameForMarketplace(
  list: MarketplaceInfo[],
  marketplaceId: string,
): string | null {
  const id = (marketplaceId ?? "").trim();
  if (!id) return null;
  return list.find((m) => m.id === id)?.storeName ?? null;
}

/** Bảng tên shop theo marketplace — dùng cho UI/diag/log. */
export function storeNameTable(
  list: MarketplaceInfo[],
): { marketplaceId: string; countryCode: string; storeName: string | null; isSuspended: boolean }[] {
  return list.map((m) => ({
    marketplaceId: m.id,
    countryCode: m.countryCode,
    storeName: m.storeName,
    isSuspended: m.isSuspended,
  }));
}

/**
 * Chọn marketplace để chốt: ƯU TIÊN US (ATVPDKIKX0DER) nếu đang hoạt động,
 * rồi mới đến marketplace active đầu tiên còn lại.
 * Thứ tự Amazon trả về không ổn định — không ưu tiên thì lúc ra US lúc ra CA.
 */
export function pickActiveMarketplace(
  list: MarketplaceInfo[],
  preferredId: string = US_MARKETPLACE_ID,
): MarketplaceInfo | null {
  const active = list.filter((m) => !m.isSuspended);
  return active.find((m) => m.id === preferredId) ?? active[0] ?? null;
}

export function parseInventory(data: unknown): InventoryWhoami {
  const root = asRecord(data);
  const payload = asRecord(unwrapPayload(data));
  const summariesRaw =
    (payload?.inventorySummaries as unknown) ??
    (root?.inventorySummaries as unknown) ??
    [];
  const summaries = Array.isArray(summariesRaw) ? summariesRaw : [];
  let sampleAsin: string | null = null;
  let sampleSku: string | null = null;
  for (const s of summaries) {
    const row = asRecord(s);
    if (!row) continue;
    const asin = typeof row.asin === "string" ? row.asin : "";
    const sku = typeof row.sellerSku === "string" ? row.sellerSku : "";
    if (asin && !sampleAsin) {
      sampleAsin = asin;
      sampleSku = sku || null;
    }
    if (sampleAsin) break;
  }
  const pagination =
    asRecord(payload?.pagination) ?? asRecord(root?.pagination);
  const hasMore =
    typeof pagination?.nextToken === "string" &&
    pagination.nextToken.length > 0;
  return {
    skuCount: summaries.length,
    hasMore,
    sampleAsin,
    sampleSku,
  };
}

export function extractSellerId(data: unknown): {
  sellerId: string | null;
  status: string | null;
} {
  const payload = unwrapPayload(data);
  const fer =
    asRecord(asRecord(payload)?.FeesEstimateResult) ??
    asRecord(asRecord(data)?.FeesEstimateResult) ??
    asRecord(payload);
  const status = typeof fer?.Status === "string" ? fer.Status : null;
  const ident = asRecord(fer?.FeesEstimateIdentifier);
  const sellerId =
    typeof ident?.SellerId === "string" && ident.SellerId.length > 0
      ? ident.SellerId
      : null;
  return { sellerId, status };
}

function skipped<T>(reason: string): WhoamiStep<T> {
  return { ok: false, skipped: true, skipReason: reason };
}

/**
 * Sinh SQL khai shop production — một dòng cho MỖI marketplace đang hoạt động
 * (shop VEXIM bán cả US + CA, thiếu một bên là mất nửa dữ liệu đồng bộ).
 * Idempotent nhờ unique (seller_id, marketplace) + on conflict.
 *
 * Kèm luôn `store_name` (tên shop Amazon) khi API trả về — để khai shop xong là
 * UI hiển thị được tên shop, không phải chờ đồng bộ lại.
 */
function sqlLiteral(v: string | null): string {
  if (v === null) return "null";
  return `'${v.replace(/'/g, "''")}'`;
}

function sqlHintFor(
  sellerId: string | null,
  marketplaces: MarketplaceInfo[],
): string | null {
  if (!sellerId) return null;
  const active = marketplaces.filter((m) => !m.isSuspended);
  if (active.length === 0) return null;
  const anyStoreName = active.some((m) => m.storeName !== null);

  const rows = active
    .map((m, i) => {
      const label = `P${i + 1} · ${m.countryCode || m.id}`;
      const cols =
        `  ((select id from iam.organizations where slug = 'vexim'), ` +
        `'${sellerId}', '${m.id}', '${label}', 'active', 'production'` +
        (anyStoreName ? `, ${sqlLiteral(m.storeName)}` : "") +
        `)`;
      return cols;
    })
    .join(",\n");

  const cols = anyStoreName
    ? `(org_id, seller_id, marketplace, display_name, status, data_source, store_name)`
    : `(org_id, seller_id, marketplace, display_name, status, data_source)`;

  const conflictUpdate = anyStoreName
    ? `  set status = 'active', data_source = 'production',\n` +
      `      store_name = coalesce(excluded.store_name, seller_accounts.store_name);`
    : `  set status = 'active', data_source = 'production';`;

  return (
    `-- Khai shop production vào connections.seller_accounts (idempotent):\n` +
    `insert into connections.seller_accounts\n` +
    `  ${cols}\n` +
    `values\n${rows}\n` +
    `on conflict (seller_id, marketplace) do update\n` +
    `${conflictUpdate}\n` +
    `-- (hoặc chỉ cần chạy migration supabase/migrations/0009_seed_production_shops.sql)`
  );
}

export async function discoverSellerIdentity(opts: {
  spapi: SpApiFn;
  region: string;
  /** ASIN dự phòng khi inventory trống — null/undefined = tắt fallback */
  fallbackAsin?: string | null;
  /** Marketplace được ưu tiên (mặc định ATVPDKIKX0DER · US) */
  preferredMarketplaceId?: string;
}): Promise<WhoamiResult> {
  const { spapi, region } = opts;
  const preferredMarketplaceId = opts.preferredMarketplaceId ?? US_MARKETPLACE_ID;
  // fallbackAsin truyền tường minh (undefined = dùng mặc định, null = tắt)
  const fallbackAsin =
    opts.fallbackAsin === undefined
      ? (process.env.AMAZON_WHOAMI_FALLBACK_ASIN ?? DEFAULT_FALLBACK_ASIN)
      : opts.fallbackAsin;

  const steps: WhoamiResult["steps"] = {
    marketplaces: skipped("chưa chạy"),
    inventory: skipped("chưa chạy"),
    feesEstimate: skipped("chưa chạy"),
  };

  // --- 1. marketplaceParticipations ---
  try {
    const r = await spapi("GET", "/sellers/v1/marketplaceParticipations");
    if (r.status >= 400) {
      steps.marketplaces = { ok: false, error: httpError(r.status, r.raw) };
    } else {
      const list = parseMarketplaces(r.data);
      if (list.length === 0) {
        steps.marketplaces = {
          ok: false,
          data: list,
          error: "Amazon không trả marketplace nào cho refresh_token này.",
        };
      } else if (!pickActiveMarketplace(list)) {
        steps.marketplaces = {
          ok: false,
          data: list,
          error: "Mọi marketplace đều suspended / not participating.",
        };
      } else {
        steps.marketplaces = { ok: true, data: list };
      }
    }
  } catch (e) {
    steps.marketplaces = {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const marketplaces = steps.marketplaces.data ?? [];
  // Ưu tiên US — shop production VEXIM bán US + CA, thứ tự trả về không ổn định.
  const marketplace = pickActiveMarketplace(marketplaces, preferredMarketplaceId);

  // --- 2. inventory summaries ---
  if (!marketplace) {
    steps.inventory = skipped(
      "Không có marketplace đang hoạt động (bước 1 lỗi).",
    );
  } else {
    try {
      const r = await spapi("GET", "/fba/inventory/v1/summaries", {
        query: {
          granularityType: "Marketplace",
          granularityId: marketplace.id,
          marketplaceIds: marketplace.id,
          details: "true",
        },
      });
      if (r.status >= 400) {
        steps.inventory = { ok: false, error: httpError(r.status, r.raw) };
      } else {
        steps.inventory = { ok: true, data: parseInventory(r.data) };
      }
    } catch (e) {
      steps.inventory = {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  const inventory = steps.inventory.data ?? null;
  const sampleAsin = inventory?.sampleAsin ?? null;
  // ASIN fallback CHỈ khi bước inventory chạy OK mà trống (0 SKU) — shop mới
  // chưa có hàng FBA. Nếu bước inventory LỖI (401/403/5xx) thì không mượn:
  // cùng token đó gọi fees cũng lỗi, chỉ tốn thêm một request vô ích.
  const inventoryEmpty = steps.inventory.ok === true && !sampleAsin;
  const usedFallbackAsin = inventoryEmpty && !!fallbackAsin;
  const asin = (sampleAsin ?? (inventoryEmpty ? fallbackAsin : null)) || null;
  const fallbackNote = usedFallbackAsin
    ? ` (dùng ASIN dự phòng ${fallbackAsin ?? ""} vì inventory trống)`
    : "";

  // --- 3. feesEstimate → SellerId ---
  if (!marketplace) {
    steps.feesEstimate = skipped(
      "Không có marketplace đang hoạt động (bước 1 lỗi).",
    );
  } else if (!asin) {
    steps.feesEstimate = skipped(
      steps.inventory.ok
        ? "Inventory trống (0 SKU) và fallback ASIN bị tắt (fallbackAsin=null)."
        : "Không có ASIN mẫu: bước inventory lỗi (fallback chỉ dùng khi inventory trống, không dùng khi lỗi).",
    );
  } else {
    try {
      const r = await spapi(
        "POST",
        `/products/fees/v0/items/${encodeURIComponent(asin)}/feesEstimate`,
        {
          body: {
            FeesEstimateRequest: {
              MarketplaceId: marketplace.id,
              IsAmazonFulfilled: true,
              Identifier: "vexim-whoami",
              PriceToEstimateFees: {
                ListingPrice: {
                  CurrencyCode: marketplace.currencyCode || "USD",
                  Amount: 10,
                },
              },
            },
          },
        },
      );
      // Gắn kèm ASIN đã dùng để ai đọc log biết vì sao ra SellerId này.
      const data = (e: { sellerId: string | null; status: string | null }): FeesWhoami => ({
        sellerId: e.sellerId,
        status: e.status,
        asin,
        usedFallbackAsin,
      });

      if (r.status >= 400) {
        // Vẫn thử đọc SellerId — Amazon đôi khi trả 4xx kèm identifier.
        const extracted = extractSellerId(r.data);
        if (extracted.sellerId) {
          steps.feesEstimate = {
            ok: true,
            data: data(extracted),
            error: httpError(r.status, r.raw) + fallbackNote,
          };
        } else {
          steps.feesEstimate = {
            ok: false,
            data: data(extracted),
            error: httpError(r.status, r.raw) + fallbackNote,
          };
        }
      } else {
        const extracted = extractSellerId(r.data);
        if (extracted.sellerId) {
          steps.feesEstimate = { ok: true, data: data(extracted) };
        } else {
          steps.feesEstimate = {
            ok: false,
            data: data(extracted),
            error:
              "feesEstimate không chứa FeesEstimateIdentifier.SellerId." +
              fallbackNote,
          };
        }
      }
    } catch (e) {
      steps.feesEstimate = {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  const sellerId = steps.feesEstimate.data?.sellerId ?? null;
  const ok = Boolean(sellerId && marketplace);
  const storeName = marketplace?.storeName ?? null;

  return {
    ok,
    region,
    marketplaces,
    marketplace,
    storeName,
    storeNames: storeNameTable(marketplaces),
    inventory,
    sellerId,
    asin,
    usedFallbackAsin,
    steps,
    sqlHint: sqlHintFor(sellerId, marketplaces),
  };
}
