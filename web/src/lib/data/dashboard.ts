/**
 * Supabase reader cho Dashboard CEO — tổng hợp KPI từ nhiều views.
 * Đọc: vexim_orders, vexim_inventory_latest, vexim_listings, vexim_pricing,
 *       vexim_settlements, vexim_shop_health, ops.my_alerts,
 *       vexim_ads_kpi + vexim_sku_profit (Module 5: chi ads & TACOS THẬT)
 */

import { createClient } from "@/lib/supabase/server";
import { computeTacos } from "./ppc-model";

export type DashboardStats = {
  // Orders
  orderCount: number;
  // Inventory
  lowStockSku: number;
  totalFulfillable: number;
  // Listings
  listingActive: number;
  listingInactive: number;
  // Pricing
  holdingBox: number;
  totalSku: number;
  // Settlements
  settlementCount: number;
  latestSettlement: number | null;
  // Health
  healthShopsOk: number;
  healthShopsTotal: number;
  // Alerts
  openAlerts: number;
  // Ads (Module 5) — null khi shop chưa nối Amazon Ads
  adsSpend7d: number | null;
  adsAcos7d: number | null;
  adsCurrency: string | null;
  /** TACOS thật = chi ads 7 ngày ÷ doanh thu sản phẩm 7 ngày (F4), cùng tiền tệ */
  tacos: number | null;
};

async function countRows(
  view: string,
  filters?: Record<string, unknown>,
): Promise<number> {
  const client = await createClient();
  if (!client) return 0;

  let query = client.from(view).select("id", { count: "exact", head: true });
  if (filters) {
    for (const [key, value] of Object.entries(filters)) {
      query = query.eq(key, value);
    }
  }
  const result = await query;
  if (result.error) return 0;
  return result.count ?? 0;
}

export async function readDashboardStats(): Promise<DashboardStats> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");

  // Chạy song song tất cả queries
  const [
    orderCount,
    inventoryRows,
    listingsData,
    pricingData,
    settlementData,
    healthData,
    adsData,
    alertCount,
  ] = await Promise.all([
    // Orders — tổng đơn
    countRows("vexim_orders"),

    // Inventory — lấy fulfillable + velocity để tính low stock
    (async () => {
      const { data, error } = await client
        .from("vexim_inventory_latest")
        .select("fulfillable,reserved,inbound,velocity,days_of_cover");
      if (error || !data) return [] as Record<string, unknown>[];
      return data as Record<string, unknown>[];
    })(),

    // Listings — đếm active/inactive
    (async () => {
      const { data, error } = await client
        .from("vexim_listings")
        .select("status");
      if (error || !data) return [] as Record<string, unknown>[];
      return data as Record<string, unknown>[];
    })(),

    // Pricing — đếm buy_box_won
    (async () => {
      const { data, error } = await client
        .from("vexim_pricing")
        .select("buy_box_won");
      if (error || !data) return [] as Record<string, unknown>[];
      return data as Record<string, unknown>[];
    })(),

    // Settlements — tổng + gần nhất
    (async () => {
      const { data, error } = await client
        .from("vexim_settlements")
        .select("total_amount")
        .order("period_end", { ascending: false })
        .limit(5);
      if (error || !data) return [] as Record<string, unknown>[];
      return data as Record<string, unknown>[];
    })(),

    // Health — đếm shop khỏe
    (async () => {
      const { data, error } = await client
        .from("vexim_shop_health")
        .select("account_status,tone");
      if (error || !data) return [] as Record<string, unknown>[];
      return data as Record<string, unknown>[];
    })(),

    // Ads (Module 5) — chi tiêu 7 ngày của shop có chi lớn nhất (1 dòng/tiền tệ,
    // KHÔNG cộng USD với CAD) + doanh thu sản phẩm 7 ngày để tính TACOS.
    (async () => {
      const { data, error } = await client
        .from("vexim_ads_kpi")
        .select("seller_account_id,currency,last_day,spend_7d,acos_7d")
        .order("spend_7d", { ascending: false, nullsFirst: false })
        .limit(5);
      if (error || !data || data.length === 0) return null;
      const main = data[0] as {
        seller_account_id: string;
        currency: string | null;
        last_day: string | null;
        spend_7d: number | null;
        acos_7d: number | null;
      };
      if (!main.last_day || main.spend_7d === null) return { main, revenue: [] };
      const last = Date.parse(`${main.last_day}T00:00:00Z`);
      const from = new Date(last - 6 * 86_400_000).toISOString().slice(0, 10);
      const { data: rev } = await client
        .from("vexim_sku_profit")
        .select("day,currency,revenue")
        .eq("seller_account_id", main.seller_account_id)
        .gte("day", from)
        .lte("day", main.last_day);
      return { main, revenue: (rev ?? []) as { day: string; currency: string; revenue: number | null }[] };
    })(),

    // Alerts — đếm mở
    (async () => {
      const { data, error } = await client
        .from("ops.my_alerts")
        .select("id", { count: "exact", head: true })
        .eq("status", "open");
      if (error) return 0;
      return data?.length ?? 0;
    })(),
  ]);

  // Inventory stats
  const lowStockSku = inventoryRows.filter((r) => {
    const cover = Number(r.days_of_cover);
    return Number.isFinite(cover) && cover < 14 && cover > 0;
  }).length + inventoryRows.filter((r) => Number(r.fulfillable) === 0).length;

  const totalFulfillable = inventoryRows.reduce(
    (sum, r) => sum + (Number(r.fulfillable) || 0),
    0,
  );

  // Listings stats
  const listingActive = listingsData.filter(
    (r) => String(r.status).toUpperCase() === "ACTIVE",
  ).length;
  const listingInactive = listingsData.filter((r) => {
    const s = String(r.status).toUpperCase();
    return s === "INACTIVE" || s === "STRANDED" || s === "SUPPRESSED";
  }).length;

  // Pricing stats
  const holdingBox = pricingData.filter((r) => r.buy_box_won === true).length;
  const totalSku = pricingData.length;

  // Settlement stats
  const settlementCount = settlementData.length;
  const latestSettlement =
    settlementData.length > 0
      ? Number(settlementData[0].total_amount) || null
      : null;

  // Health stats
  const healthShopsTotal = healthData.length;
  const healthShopsOk = healthData.filter(
    (r) => r.tone === "green" || r.account_status === "NORMAL",
  ).length;

  // Ads stats — TACOS dùng CHUNG công thức với màn PPC (computeTacos) để hai nơi
  // không bao giờ lệch nhau.
  const adsSpend7d = adsData ? adsData.main.spend_7d : null;
  const tacos = adsData ? computeTacos(adsData.main, adsData.revenue) : null;

  return {
    orderCount,
    lowStockSku,
    totalFulfillable,
    listingActive,
    listingInactive,
    holdingBox,
    totalSku,
    settlementCount,
    latestSettlement,
    healthShopsOk,
    healthShopsTotal,
    openAlerts: alertCount,
    adsSpend7d,
    adsAcos7d: adsData ? adsData.main.acos_7d : null,
    adsCurrency: adsData ? adsData.main.currency : null,
    tacos,
  };
}
