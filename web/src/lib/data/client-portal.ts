/**
 * CLIENT PORTAL — ĐỌC dữ liệu THẬT cho `/client` (khách hàng của VEXIM).
 *
 * TRƯỚC 13/09/2026 trang này KHÔNG đọc DB: nó render `clientKpis` / `clientReports`
 * viết cứng trong `mock.ts` ($186,400 · 5,120 đơn · AHR 780 · $23,900 · "báo cáo
 * tuần 37") — kể cả trên production đã nối Supabase. Khách hàng mở link là thấy
 * số của một doanh nghiệp không tồn tại.
 *
 * Nay mọi con số đến từ view có `security_invoker` (RLS theo đúng shop mà người
 * đang đăng nhập được xem):
 *   · `vexim_shops`          → shop của khách (doanh nghiệp mình)
 *   · `vexim_order_daily`    → doanh thu / đơn / hoàn theo ngày (gộp trong tháng)
 *   · `vexim_shop_health`    → snapshot account health mới nhất mỗi shop
 *   · `vexim_settlements`    → kỳ thanh toán
 *   · `vexim_sku_sales_30d`  → sản phẩm bán chạy 30 ngày
 *
 * KHÔNG có dòng nào ⇒ trả mảng rỗng để trang nói "chưa có dữ liệu" (không bịa,
 * không suy ra 0).
 */

import { createClient } from "@/lib/supabase/server";
import {
  monthStart,
  returnRatePct,
  sumByCurrency,
  summarizeHealth,
  type CurrencyTotal,
  type HealthSummary,
  type SettlementLite,
} from "@/lib/client-model";

export type ClientShop = {
  id: string;
  shop: string;
  marketplace: string | null;
  status: string | null;
};

export type ClientTopSku = {
  sku: string;
  shop: string;
  units: number;
  revenue: number;
  currency: string | null;
};

export type ClientSnapshot = {
  /** Tên doanh nghiệp của khách (null = nhân viên VEXIM đang xem, không phải khách). */
  orgName: string | null;
  isClientViewer: boolean;
  viewerName: string | null;
  shops: ClientShop[];
  month: string;
  monthRevenue: CurrencyTotal[];
  monthOrders: number | null;
  monthReturns: number | null;
  returnRate: number | null;
  health: HealthSummary;
  redShops: string[];
  settlements: SettlementLite[];
  settlementTotal: CurrencyTotal[];
  topSkus: ClientTopSku[];
  /** Có ít nhất một nguồn số liệu thật (dù bằng 0) hay chưa. */
  hasAnyData: boolean;
};

const DAY_SELECT = "seller_account_id,shop,day,orders_count,units,sales_amount,currency,returns_count,returns_amount";

/** Không có quyền / chưa đăng nhập ⇒ nói rõ, KHÔNG hiển thị số rỗng. */
export async function readClientSnapshot(): Promise<
  { ok: true; data: ClientSnapshot } | { ok: false; message: string }
> {
  const client = await createClient();
  if (!client) return { ok: false, message: "Chưa cấu hình Supabase (chế độ demo)." };

  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) return { ok: false, message: "Chưa đăng nhập." };

  const start = monthStart();

  const [profileRes, rolesRes, shopRes, dailyRes, healthRes, settleRes, skuRes] = await Promise.all([
    client.schema("iam").from("user_profiles").select("display_name, org_id").eq("id", user.id).maybeSingle(),
    client.schema("iam").from("role_assignments").select("role").eq("user_id", user.id),
    client.from("vexim_shops").select("seller_account_id, shop, marketplace, status").order("shop"),
    client.from("vexim_order_daily").select(DAY_SELECT).gte("day", start),
    client.from("vexim_shop_health").select("seller_account_id, shop, tone, score, ahr_status"),
    client.from("vexim_settlements").select("settlement_id, shop, period_start, period_end, deposit_date, total_amount, currency, status"),
    client.from("vexim_sku_sales_30d").select("sku, shop, units_30d, revenue_30d, currency").order("revenue_30d", { ascending: false }).limit(8),
  ]);

  // Shop: RLS đã giới hạn theo org/assignment của người đăng nhập.
  const shops: ClientShop[] = (
    (shopRes.data ?? []) as unknown as {
      seller_account_id: string;
      shop: string;
      marketplace: string | null;
      status: string | null;
    }[]
  ).map((s) => ({
    id: s.seller_account_id,
    shop: s.shop,
    marketplace: s.marketplace,
    status: s.status,
  }));

  const daily = (dailyRes.data ?? []) as unknown as {
    orders_count: number | null;
    units: number | null;
    sales_amount: number | string | null;
    currency: string | null;
    returns_count: number | null;
    returns_amount: number | string | null;
  }[];

  const monthOrders = daily.length
    ? daily.reduce((sum, r) => sum + Number(r.orders_count ?? 0), 0)
    : null;
  const monthReturns = daily.length
    ? daily.reduce((sum, r) => sum + Number(r.returns_count ?? 0), 0)
    : null;

  const monthRevenue = sumByCurrency(daily.map((r) => ({ amount: r.sales_amount, currency: r.currency })));

  const healthRows = (healthRes.data ?? []) as unknown as { seller_account_id: string; shop: string; tone: string | null; score: number | null }[];
  const redShops = healthRows
    .filter((h) => (h.tone ?? "").toLowerCase() === "red")
    .map((h) => h.shop);

  const settlements: SettlementLite[] = (
    (settleRes.data ?? []) as unknown as {
      settlement_id: string;
      shop: string;
      period_end: string | null;
      deposit_date: string | null;
      total_amount: number | string | null;
      currency: string | null;
    }[]
  ).map((s) => ({
    settlementId: s.settlement_id,
    shop: s.shop,
    periodEnd: s.period_end,
    depositDate: s.deposit_date,
    total: Number(s.total_amount ?? 0),
    currency: s.currency,
  }));

  const topSkus: ClientTopSku[] = (
    (skuRes.data ?? []) as unknown as {
      sku: string;
      shop: string;
      units_30d: number | null;
      revenue_30d: number | string | null;
      currency: string | null;
    }[]
  ).map((r) => ({
    sku: r.sku,
    shop: r.shop,
    units: Number(r.units_30d ?? 0),
    revenue: Number(r.revenue_30d ?? 0),
    currency: r.currency,
  }));

  const roles = ((rolesRes.data ?? []) as unknown as { role: string }[]).map((r) => r.role);
  const profile = profileRes.data as { display_name: string | null; org_id: string | null } | null;

  let orgName: string | null = null;
  if (profile?.org_id) {
    const { data: org } = await client
      .schema("iam")
      .from("organizations")
      .select("name")
      .eq("id", profile.org_id)
      .maybeSingle();
    orgName = (org as { name?: string } | null)?.name ?? null;
  }

  return {
    ok: true,
    data: {
      orgName,
      isClientViewer: roles.includes("client_viewer"),
      viewerName: profile?.display_name ?? user.email ?? null,
      shops,
      month: start.slice(0, 7),
      monthRevenue,
      monthOrders: monthOrders === null ? null : Math.round(monthOrders),
      monthReturns: monthReturns === null ? null : Math.round(monthReturns),
      returnRate: monthOrders && monthReturns !== null ? returnRatePct(monthOrders, monthReturns) : null,
      health: summarizeHealth(healthRows, redShops),
      redShops,
      settlements,
      settlementTotal: sumByCurrency(
        settlements.map((s) => ({ amount: s.total, currency: s.currency })),
      ),
      topSkus,
      hasAnyData: daily.length > 0 || healthRows.length > 0 || settlements.length > 0 || topSkus.length > 0,
    },
  };
}
