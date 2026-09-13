/**
 * Supabase reader cho Dashboard CEO — tổng hợp KPI từ nhiều views.
 * Đọc: vexim_orders, vexim_inventory_latest, vexim_listings, vexim_pricing,
 *       vexim_settlements, vexim_shop_health, ops.my_alerts,
 *       vexim_ads_kpis (Module 5 — spend/ACOS/TACOS)
 */

import { createClient } from "@/lib/supabase/server";
import { readAdsKpis } from "./ads";
import { summarizeAdsForDashboard, type AdsDashboardSummary } from "./ads-model";

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
  };
}


/* ------------------------------------------------------------------ */
/* KPI Ads (Module 5) — đọc riêng để KHÔNG kéo sập cả Dashboard       */
/* ------------------------------------------------------------------ */

export type DashboardAds = {
  /** null khi chưa cấu hình Supabase HOẶC chưa đọc được KPI Ads. */
  summary: AdsDashboardSummary | null;
  /** Lý do không đọc được (vd: migration 0020 chưa chạy) — hiện thẳng lên UI. */
  error: string | null;
};

/**
 * KPI Ads cho Dashboard. KHÔNG ném lỗi: view `vexim_ads_kpis` chỉ tồn tại sau
 * migration 0020, mà Dashboard thì phải chạy được cả trước đó — nên lỗi được trả
 * về như dữ liệu (`error`) để UI nói rõ "chưa đọc được vì X" thay vì trắng trang.
 */
export async function readDashboardAds(): Promise<DashboardAds> {
  try {
    const kpis = await readAdsKpis();
    if (kpis === null) return { summary: null, error: null };
    return { summary: summarizeAdsForDashboard(kpis), error: null };
  } catch (e) {
    return { summary: null, error: e instanceof Error ? e.message : "Không đọc được KPI Ads" };
  }
}
