/**
 * Job đồng bộ tồn kho (Tầng 2 — theo lịch 30–60 phút/shop).
 * Luồng: getInventorySummaries → chuẩn hóa → snapshot → tính metrics
 * (velocity từ dữ liệu bán) → chốt inventory_daily + cảnh báo.
 * Tầng 3 (report MYI) đối soát riêng: so snapshot vs report → warnings.
 */
import type { DbAdapter } from "../db/adapter.ts";
import {
  FbaInventoryClient,
  normalizeSummary,
  type NormalizedInventory,
} from "../amazon/fba-inventory.ts";
import {
  computeVelocity14,
  daysOfCover,
  restockSuggestion,
  stockoutSeverity,
} from "../domain/inventory-metrics.ts";

export type InventoryAlert = {
  sku: string;
  severity: "red" | "amber";
  type: "stockout" | "low_cover";
  coverDays: number | null;
};

export type InventorySyncReport = {
  sellerAccountId: string;
  skusProcessed: number;
  alerts: InventoryAlert[];
  suggestions: { sku: string; suggest: number }[];
};

export async function runInventorySync(opts: {
  sellerAccountId: string;
  marketplaceId: string;
  client: Pick<FbaInventoryClient, "getInventorySummaries">;
  adapter: DbAdapter;
  leadDays?: number; // theo cấu hình shop
  now?: Date;
}): Promise<InventorySyncReport> {
  const now = opts.now ?? new Date();
  const res = await opts.client.getInventorySummaries({
    marketplaceId: opts.marketplaceId,
  });

  const alerts: InventoryAlert[] = [];
  const suggestions: { sku: string; suggest: number }[] = [];
  const day = now.toISOString().slice(0, 10);

  for (const summary of res.inventorySummaries) {
    const n: NormalizedInventory = normalizeSummary(summary);

    await opts.adapter.upsertInventorySnapshot({
      sellerAccountId: opts.sellerAccountId,
      sku: n.sku,
      asin: n.asin,
      fulfillable: n.fulfillable,
      reserved: n.reserved,
      inbound: n.inbound,
      capturedAt: now,
    });

    const sellingDays = await opts.adapter.getSellingDays(
      opts.sellerAccountId,
      n.sku,
      14,
    );
    const velocity = computeVelocity14(sellingDays);
    const cover = daysOfCover(n.fulfillable, velocity);

    await opts.adapter.upsertInventoryDaily({
      sellerAccountId: opts.sellerAccountId,
      day,
      sku: n.sku,
      units: n.fulfillable,
      daysOfCover: cover,
      inStock: n.fulfillable > 0,
    });

    const severity = stockoutSeverity(cover);
    if (n.fulfillable === 0) {
      alerts.push({ sku: n.sku, severity: "red", type: "stockout", coverDays: 0 });
    } else if (severity) {
      alerts.push({
        sku: n.sku,
        severity,
        type: "low_cover",
        coverDays: cover,
      });
    }

    const suggest = restockSuggestion({
      velocity,
      leadDays: opts.leadDays ?? 32,
      fulfillable: n.fulfillable,
      reserved: n.reserved,
      inbound: n.inbound,
    });
    if (suggest !== null) suggestions.push({ sku: n.sku, suggest });
  }

  return {
    sellerAccountId: opts.sellerAccountId,
    skusProcessed: res.inventorySummaries.length,
    alerts,
    suggestions,
  };
}

/**
 * Đối soát Tầng 3: snapshot (tầng 2) vs report MYI (tầng 3).
 * Trả về danh sách lệch — đẩy lên Sync Health, KHÔNG tự đè số (nguyên tắc đã chốt).
 */
export function reconcileInventory(
  snapshot: NormalizedInventory[],
  reportRows: { sku: string; fulfillable: number; reserved: number; inbound: number }[],
): { sku: string; field: string; snapshot: number; report: number }[] {
  const diffs: { sku: string; field: string; snapshot: number; report: number }[] = [];
  const bySku = new Map(snapshot.map((s) => [s.sku, s]));
  for (const r of reportRows) {
    const s = bySku.get(r.sku);
    if (!s) continue;
    if (s.fulfillable !== r.fulfillable)
      diffs.push({ sku: r.sku, field: "fulfillable", snapshot: s.fulfillable, report: r.fulfillable });
    if (s.reserved !== r.reserved)
      diffs.push({ sku: r.sku, field: "reserved", snapshot: s.reserved, report: r.reserved });
    if (s.inbound !== r.inbound)
      diffs.push({ sku: r.sku, field: "inbound", snapshot: s.inbound, report: r.inbound });
  }
  return diffs;
}
