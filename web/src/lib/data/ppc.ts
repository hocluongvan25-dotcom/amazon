/**
 * Supabase reader cho màn A1 — QUẢNG CÁO (Module 5 phần 1).
 *
 *   • vexim_ads_kpi             — KPI theo shop × tiền tệ (7/14/30 ngày)
 *   • vexim_ads_campaigns       — bảng campaign + ACOS/ROAS + trạng thái ngân sách
 *   • vexim_ads_budget_events   — ngày cạn ngân sách (để giải thích "vì sao hết đơn")
 *   • vexim_ads_negative_suggestions — số gợi ý negative đang chờ duyệt (A3)
 *   • vexim_sku_profit          — doanh thu sản phẩm để tính TACOS THẬT
 *
 * Cả 5 view đều `security_invoker` ⇒ RLS bảng gốc vẫn áp (user chỉ thấy shop được
 * gán qua `iam.can_read_seller_account`).
 *
 * Dữ liệu chỉ có sau khi worker chạy:
 *   npm run worker:ads-sync    (profile → campaign → ad group → target)
 *   npm run worker:ads-pull    (5 report metrics qua Reporting API v3)
 * hoặc Vercel Cron /api/cron/report-pull (02:00 inventory · 03:00 reports + ads).
 */

import { createClient } from "@/lib/supabase/server";
import { readAll } from "./inventory-model";
import type { AdsBudgetEventRaw, AdsCampaignRaw, AdsKpiRaw } from "./ppc-model";
import { ADS_BUDGET_EVENT_SELECT, ADS_CAMPAIGN_SELECT, ADS_KPI_SELECT } from "./ppc-model";

export type AdsSuggestionCountRaw = { seller_account_id: string; pending_count: number | null };

export async function readAdsKpi(sellerAccountId?: string | null): Promise<AdsKpiRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  return readAll<AdsKpiRaw>((from, to) => {
    let q = client.from("vexim_ads_kpi").select(ADS_KPI_SELECT).order("spend_7d", { ascending: false }).range(from, to);
    if (sellerAccountId) q = q.eq("seller_account_id", sellerAccountId);
    return q;
  });
}

export async function readAdsCampaigns(sellerAccountId?: string | null): Promise<AdsCampaignRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  return readAll<AdsCampaignRaw>((from, to) => {
    let q = client
      .from("vexim_ads_campaigns")
      .select(ADS_CAMPAIGN_SELECT)
      // Sắp theo chi 7 ngày: campaign đốt tiền nhiều nhất lên đầu — đúng thứ tự
      // người vận hành cần nhìn (NULL xuống cuối).
      .order("spend_7d", { ascending: false, nullsFirst: false })
      .order("name")
      .range(from, to);
    if (sellerAccountId) q = q.eq("seller_account_id", sellerAccountId);
    return q;
  });
}

export async function readAdsBudgetEvents(
  opts: { sellerAccountId?: string | null; days?: number } = {},
): Promise<AdsBudgetEventRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  const days = opts.days ?? 14;
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return readAll<AdsBudgetEventRaw>((from, to) => {
    let q = client
      .from("vexim_ads_budget_events")
      .select(ADS_BUDGET_EVENT_SELECT)
      .gte("day", since)
      .order("day", { ascending: false })
      .range(from, to);
    if (opts.sellerAccountId) q = q.eq("seller_account_id", opts.sellerAccountId);
    return q;
  });
}

/** Số gợi ý negative đang chờ duyệt — con số của A3, hiện sớm ở A1. */
export async function readPendingSuggestionCount(sellerAccountId?: string | null): Promise<number> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  const { data, error } = await client
    .from("vexim_ads_negative_suggestions")
    .select("seller_account_id")
    .eq("status", "pending")
    .limit(5000);
  if (error || !data) return 0;
  const rows = data as { seller_account_id: string }[];
  return sellerAccountId
    ? rows.filter((r) => r.seller_account_id === sellerAccountId).length
    : rows.length;
}

/**
 * Doanh thu sản phẩm (F4) trong khoảng ngày — đầu vào của TACOS.
 * KHÔNG dùng doanh thu đơn hàng (orders) vì TACOS chuẩn là chi ads ÷ doanh thu
 * sản phẩm đã trừ huỷ/hoàn.
 */
export async function readProductRevenue(
  opts: { sellerAccountId?: string | null; from: string; to: string },
): Promise<{ day: string; currency: string; revenue: number | null }[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  const rows = await readAll<{ day: string; currency: string; revenue: number | null }>((from, to) => {
    let q = client
      .from("vexim_sku_profit")
      .select("day,currency,revenue")
      .gte("day", opts.from)
      .lte("day", opts.to)
      .range(from, to);
    if (opts.sellerAccountId) q = q.eq("seller_account_id", opts.sellerAccountId);
    return q;
  });
  return rows;
}
