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
};

export type WhoamiResult = {
  ok: boolean;
  region: string;
  marketplaces: MarketplaceInfo[];
  marketplace: MarketplaceInfo | null;
  inventory: InventoryWhoami | null;
  sellerId: string | null;
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
    });
  }
  return out;
}

export function pickActiveMarketplace(
  list: MarketplaceInfo[],
): MarketplaceInfo | null {
  return list.find((m) => !m.isSuspended) ?? null;
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

function sqlHintFor(
  sellerId: string | null,
  mp: MarketplaceInfo | null,
): string | null {
  if (!sellerId || !mp) return null;
  return (
    `-- Khai vào connections.seller_accounts:\n` +
    `--   seller_id   = '${sellerId}'\n` +
    `--   marketplace = '${mp.id}'  -- ${mp.name}${mp.countryCode ? ` (${mp.countryCode})` : ""}`
  );
}

export async function discoverSellerIdentity(opts: {
  spapi: SpApiFn;
  region: string;
}): Promise<WhoamiResult> {
  const { spapi, region } = opts;

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
  const marketplace = pickActiveMarketplace(marketplaces);

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

  // --- 3. feesEstimate → SellerId ---
  if (!marketplace) {
    steps.feesEstimate = skipped(
      "Không có marketplace đang hoạt động (bước 1 lỗi).",
    );
  } else if (!sampleAsin) {
    steps.feesEstimate = skipped(
      "Không có ASIN mẫu từ inventory (bước 2 lỗi hoặc shop chưa có SKU).",
    );
  } else {
    try {
      const r = await spapi(
        "POST",
        `/products/fees/v0/items/${encodeURIComponent(sampleAsin)}/feesEstimate`,
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
      if (r.status >= 400) {
        // Vẫn thử đọc SellerId — Amazon đôi khi trả 4xx kèm identifier.
        const extracted = extractSellerId(r.data);
        if (extracted.sellerId) {
          steps.feesEstimate = {
            ok: true,
            data: extracted,
            error: httpError(r.status, r.raw),
          };
        } else {
          steps.feesEstimate = { ok: false, error: httpError(r.status, r.raw) };
        }
      } else {
        const extracted = extractSellerId(r.data);
        if (extracted.sellerId) {
          steps.feesEstimate = { ok: true, data: extracted };
        } else {
          steps.feesEstimate = {
            ok: false,
            data: extracted,
            error:
              "feesEstimate không chứa FeesEstimateIdentifier.SellerId.",
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

  return {
    ok,
    region,
    marketplaces,
    marketplace,
    inventory,
    sellerId,
    steps,
    sqlHint: sqlHintFor(sellerId, marketplace),
  };
}
