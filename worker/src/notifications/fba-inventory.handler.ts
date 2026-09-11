/**
 * Handler notification FBA_INVENTORY_AVAILABILITY_CHANGES (Tầng 1 — realtime).
 * Schema theo developer-docs.amazon.com/sp-api/docs/notification-type-values:
 *   { SellerId, FNSKU, ASIN, SKU,
 *     FulfillmentInventoryByMarketplace: [{ MarketplaceId, FulfillmentInventoryDetails }]
 *   }
 * Handler phòng thủ: trường không chắc chắn để optional, LUÔN giữ raw để replay.
 */
import type { DbAdapter } from "../db/adapter.ts";

export type FbaInventoryAvailabilityChangeNotification = {
  SellerId?: string;
  FNSKU?: string;
  ASIN?: string;
  SKU?: string;
  FulfillmentInventoryByMarketplace?: {
    MarketplaceId?: string;
    FulfillmentInventoryDetails?: {
      Condition?: string;
      SupplyType?: string;
      Quantity?: number;
      ReservedQuantityBreakdown?: { TotalReserved?: number };
      InboundQuantity?: number;
    }[];
  }[];
};

export type NormalizedInventoryChange = {
  sellerId: string | null;
  sku: string | null;
  asin: string | null;
  fnSku: string | null;
  byMarketplace: {
    marketplaceId: string | null;
    available: number;
    reserved: number;
    inbound: number;
  }[];
};

export function isFbaInventoryAvailabilityChange(
  payload: unknown,
): payload is FbaInventoryAvailabilityChangeNotification {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "FulfillmentInventoryByMarketplace" in payload &&
    Array.isArray(
      (payload as FbaInventoryAvailabilityChangeNotification)
        .FulfillmentInventoryByMarketplace,
    )
  );
}

/** Chuẩn hóa payload → dạng thống nhất; không ném lỗi với payload lạ (giữ raw) */
export function normalizeChange(
  payload: FbaInventoryAvailabilityChangeNotification,
): NormalizedInventoryChange {
  const byMarketplace = (payload.FulfillmentInventoryByMarketplace ?? []).map((m) => {
    const details = m.FulfillmentInventoryDetails ?? [];
    let available = 0;
    let reserved = 0;
    let inbound = 0;
    for (const d of details) {
      if (d.SupplyType === "INBOUND" || d.SupplyType === "Inbound") {
        inbound += d.Quantity ?? 0;
      } else {
        available += d.Quantity ?? 0;
        reserved += d.ReservedQuantityBreakdown?.TotalReserved ?? 0;
      }
    }
    return { marketplaceId: m.MarketplaceId ?? null, available, reserved, inbound };
  });

  return {
    sellerId: payload.SellerId ?? null,
    sku: payload.SKU ?? null,
    asin: payload.ASIN ?? null,
    fnSku: payload.FNSKU ?? null,
    byMarketplace,
  };
}

/** Điểm vào từ EventBridge/SQS → webhook. Trả về null nếu không phải loại này. */
export async function handleFbaInventoryAvailabilityChange(
  payload: unknown,
  adapter: DbAdapter,
  opts: { sellerAccountId: string },
): Promise<NormalizedInventoryChange | null> {
  if (!isFbaInventoryAvailabilityChange(payload)) return null;
  const normalized = normalizeChange(payload);
  await adapter.recordNotification({
    sellerAccountId: opts.sellerAccountId,
    notificationType: "FBA_INVENTORY_AVAILABILITY_CHANGES",
    raw: payload,
    normalized,
    receivedAt: new Date(),
  });
  // TODO (khi có Supabase): đẩy realtime lên UI + kích hoạt job metrics SKU đổi
  return normalized;
}
