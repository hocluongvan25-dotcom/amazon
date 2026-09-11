/**
 * Typed client FBA Inventory API v1 — getInventorySummaries.
 * Kiểu dữ liệu theo Swagger chính thức của Amazon (fba-inventory-api-model).
 * Rate limit: 2 req/s · burst 30 (worker tôn trọng + backoff theo Retry-After).
 */
import { LwaTokenManager } from "./lwa.ts";

export type ReservedQuantity = {
  totalReservedQuantity?: number;
  pendingCustomerOrderQuantity?: number;
  pendingTransshipmentQuantity?: number;
  fcProcessingQuantity?: number;
};

export type InventoryDetails = {
  fulfillableQuantity?: number;
  reservedQuantity?: ReservedQuantity;
  unfulfillableQuantity?: { totalUnfulfillableQuantity?: number };
  inboundWorkingQuantity?: number;
  inboundShippedQuantity?: number;
  inboundReceivingQuantity?: number;
};

export type InventorySummary = {
  asin: string;
  fnSku: string;
  sellerSku: string;
  conditionType?: string;
  inventoryDetails?: InventoryDetails;
  lastUpdatedTime?: string;
  totalQuantity?: number;
  productName?: string;
};

export type GetInventorySummariesResponse = {
  granularity: { granularityType: string; granularityId: string };
  inventorySummaries: InventorySummary[];
};

/** Dạng chuẩn hóa worker dùng chung (snapshot / daily / metrics) */
export type NormalizedInventory = {
  sku: string;
  asin: string;
  fnSku: string;
  fulfillable: number;
  reserved: number;
  inbound: number; // working + shipped + receiving
  total: number;
};

export function normalizeSummary(s: InventorySummary): NormalizedInventory {
  const d = s.inventoryDetails ?? {};
  return {
    sku: s.sellerSku,
    asin: s.asin,
    fnSku: s.fnSku,
    fulfillable: d.fulfillableQuantity ?? 0,
    reserved: d.reservedQuantity?.totalReservedQuantity ?? 0,
    inbound:
      (d.inboundWorkingQuantity ?? 0) +
      (d.inboundShippedQuantity ?? 0) +
      (d.inboundReceivingQuantity ?? 0),
    total: s.totalQuantity ?? 0,
  };
}

export class FbaInventoryClient {
  private readonly host: string;
  private readonly lwa: LwaTokenManager;
  private readonly fetchFn: typeof fetch;

  constructor(opts: { host: string; lwa: LwaTokenManager; fetchFn?: typeof fetch }) {
    this.host = opts.host;
    this.lwa = opts.lwa;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async getInventorySummaries(params: {
    marketplaceId: string;
    sellerSkus?: string[];
    details?: boolean;
  }): Promise<GetInventorySummariesResponse> {
    const fetchFn = this.fetchFn;
    const token = await this.lwa.getAccessToken();
    const url = new URL(`${this.host}/fba/inventory/v1/summaries`);
    url.searchParams.set("granularityType", "Marketplace");
    url.searchParams.set("granularityId", params.marketplaceId);
    url.searchParams.set("details", String(params.details ?? true));
    if (params.sellerSkus?.length) {
      for (const sku of params.sellerSkus) url.searchParams.append("sellerSkus", sku);
    }

    // retry đơn giản theo Retry-After (token bucket của Amazon)
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetchFn(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 429) {
        const waitMs = Number(res.headers.get("retry-after") ?? 1) * 1000;
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (!res.ok) {
        throw new Error(`getInventorySummaries HTTP ${res.status}: ${await res.text()}`);
      }
      return (await res.json()) as GetInventorySummariesResponse;
    }
    throw new Error("getInventorySummaries: vượt số lần retry (429)");
  }
}
