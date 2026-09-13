/**
 * Data model cho Dashboard KPI tổng hợp — đọc từ nhiều Supabase views.
 * Gom KPI từ: orders, inventory, listings, pricing, settlements, health, alerts,
 * và (Module 5) KPI Ads + TACOS từ vexim_ads_kpis.
 *
 * Quy tắc khi đưa số Ads lên Dashboard: chưa đồng bộ thì hiện "—" kèm LÝ DO,
 * không hiện 0 — CEO thấy "TACOS 0%" sẽ tưởng quảng cáo miễn phí.
 */
import {
  agoText,
  countText,
  moneyText,
  pctText,
  type AdsDashboardSummary,
} from "./ads-model.ts";

/* ------------------------------------------------------------------ */
/* Dashboard KPI types                                                */
/* ------------------------------------------------------------------ */

export type DashboardKpi = {
  label: string;
  value: string;
  sub: string;
  tone: "up" | "down" | "warn" | "flat";
};

export type RedShop = {
  shop: string;
  issue: string;
  impact: string;
  dept: string;
  tone: "red" | "amber";
  status: string;
};

export type DeptSummary = {
  name: string;
  href: string;
  icon: string;
  kpi: string;
  kpiSub: string;
  alertCount: number;
  tone: "up" | "down" | "warn" | "flat";
};

/* ------------------------------------------------------------------ */
/* Aggregation logic                                                  */
/* ------------------------------------------------------------------ */

export function buildCeoKpis(stats: {
  orderCount: number;
  lowStockSku: number;
  totalFulfillable: number;
  holdingBox: number;
  totalSku: number;
  openAlerts: number;
  latestSettlement: number | null;
}): DashboardKpi[] {
  return [
    {
      label: "Đơn hàng (tổng DB)",
      value: stats.orderCount.toLocaleString("en-US"),
      sub: "tổng đơn trong vexim_orders",
      tone: stats.orderCount > 0 ? "up" : "flat",
    },
    {
      label: "SKU sắp hết hàng",
      value: String(stats.lowStockSku),
      sub: `${stats.totalFulfillable.toLocaleString("en-US")} tồn khả dụng · toàn shop`,
      tone: stats.lowStockSku > 0 ? "down" : "up",
    },
    {
      label: "Buy Box holding",
      value: `${stats.holdingBox} / ${stats.totalSku}`,
      sub: `${stats.totalSku > 0 ? Math.round((stats.holdingBox / stats.totalSku) * 100) : 0}% SKU giữ box`,
      tone: stats.holdingBox > stats.totalSku * 0.7 ? "up" : "warn",
    },
    {
      label: "Cảnh báo mở",
      value: String(stats.openAlerts),
      sub: stats.latestSettlement !== null
        ? `kỳ gần nhất: $${stats.latestSettlement.toLocaleString("en-US")}`
        : "chưa có settlement",
      tone: stats.openAlerts > 5 ? "down" : stats.openAlerts > 0 ? "warn" : "up",
    },
  ];
}

/**
 * Card KPI Ads cho Dashboard CEO. `ads = null` nghĩa là KHÔNG ĐỌC ĐƯỢC
 * (0020 chưa chạy / lỗi view) — khác với "đọc được nhưng chưa có dữ liệu".
 */
export function buildAdsKpi(ads: AdsDashboardSummary | null, readError: string | null = null): DashboardKpi {
  const base = { label: "Ads 7 ngày · TACOS", value: "—", sub: "", tone: "flat" as const };

  if (readError) return { ...base, sub: `chưa đọc được KPI Ads (${readError})`, tone: "warn" };
  if (!ads || !ads.hasData) {
    return {
      ...base,
      sub: "chưa đồng bộ Ads — chạy cron /api/cron/ads-sync",
      tone: "warn",
    };
  }

  const t = ads.primary;
  if (!t) return { ...base, sub: "chưa có metrics Ads", tone: "warn" };

  const ccy = t.currency;
  const tacos =
    t.tacos7 === null
      ? t.tacosUnknownShops > 0
        ? "TACOS — (thiếu tổng doanh thu)"
        : "TACOS — (chưa có doanh thu)"
      : `TACOS ${pctText(t.tacos7)}${t.tacosPartial ? " (một phần shop)" : ""}`;

  return {
    label: `Ads 7 ngày · ${ccy}`,
    value: moneyText(t.spend7),
    sub: `${tacos} · ACOS ${pctText(t.acos7)} · ${ads.staleShops > 0 ? `DỮ LIỆU CŨ ${ads.staleShops} shop` : `nhập ${agoText(ads.hoursSinceImport)}`}`,
    tone: ads.staleShops > 0 ? "down" : t.campaignsOverTarget > 0 || t.campaignsExhausted > 0 ? "warn" : "up",
  };
}

/** Dòng "Chi tiết nhanh" cho khối Ads — trả null khi chưa có gì để nói. */
export function buildAdsDetailLine(ads: AdsDashboardSummary | null): string | null {
  if (!ads || !ads.hasData || !ads.primary) return null;
  const t = ads.primary;
  const parts = [
    `${t.shops} shop · ${moneyText(t.spend7, t.currency)} spend 7 ngày`,
    `ACOS ${pctText(t.acos7)}`,
    `TACOS ${t.tacos7 === null ? "chưa tính được" : pctText(t.tacos7)}`,
    `${countText(t.adOrders7)} đơn từ ads`,
    `${ads.campaignsOverTarget} campaign vượt ngưỡng ACOS`,
    `${ads.campaignsExhausted} campaign cạn ngân sách`,
    `số liệu tới ${t.metricsDay ?? "—"}, nhập ${agoText(ads.hoursSinceImport)}`,
  ];
  return parts.join(" · ");
}

/** Số cảnh báo cho card PPC = việc Ops phải làm ngay (không tính campaign đang chạy tốt). */
export function ppcAlertCount(ads: AdsDashboardSummary | null): number {
  if (!ads) return 0;
  return ads.staleShops + ads.campaignsOverTarget + ads.campaignsExhausted;
}

export function buildDeptSummaries(stats: {
  healthShopsOk: number;
  healthShopsTotal: number;
  listingActive: number;
  listingInactive: number;
  orderCount: number;
  lowStockSku: number;
  holdingBox: number;
  totalSku: number;
  settlementCount: number;
  openAlerts: number;
}): DeptSummary[] {
  return [
    {
      name: "Vận hành & Health",
      href: "/health",
      icon: "🛡️",
      kpi: `${stats.healthShopsOk}/${stats.healthShopsTotal} shop khỏe`,
      kpiSub: `${stats.healthShopsTotal - stats.healthShopsOk} cần xử lý`,
      alertCount: stats.openAlerts,
      tone: stats.healthShopsOk === stats.healthShopsTotal ? "up" : "warn",
    },
    {
      name: "Listing & Nội dung",
      href: "/listing",
      icon: "🏷️",
      kpi: `${stats.listingActive} active`,
      kpiSub: `${stats.listingInactive} inactive/stranded`,
      alertCount: stats.listingInactive,
      tone: stats.listingInactive > 0 ? "down" : "up",
    },
    {
      name: "Kho vận & FBA",
      href: "/fulfillment",
      icon: "📦",
      kpi: `${stats.lowStockSku} SKU sắp hết`,
      kpiSub: "cover < 14 ngày",
      alertCount: stats.lowStockSku,
      tone: stats.lowStockSku > 0 ? "down" : "up",
    },
    {
      name: "Đơn hàng & CSKH",
      href: "/orders",
      icon: "💬",
      kpi: `${stats.orderCount} đơn`,
      kpiSub: "tổng trong DB",
      alertCount: 0,
      tone: "flat",
    },
    {
      name: "Giá & Buy Box",
      href: "/pricing",
      icon: "💲",
      kpi: `${stats.holdingBox}/${stats.totalSku} giữ box`,
      kpiSub: `${stats.totalSku > 0 ? Math.round((stats.holdingBox / stats.totalSku) * 100) : 0}%`,
      alertCount: stats.totalSku - stats.holdingBox,
      tone: stats.holdingBox > stats.totalSku * 0.7 ? "up" : "warn",
    },
    {
      name: "Tài chính & Đối soát",
      href: "/finance",
      icon: "💰",
      kpi: `${stats.settlementCount} kỳ`,
      kpiSub: "settlement đã import",
      alertCount: 0,
      tone: stats.settlementCount > 0 ? "up" : "flat",
    },
  ];
}

/**
 * Card phòng ban PPC — chèn vào cuối danh sách để không xáo trộn thứ tự đã duyệt.
 * `ads = null` → card vẫn hiện với "chưa đồng bộ" (ẩn đi thì không ai biết Module 5
 * chưa chạy, và không ai biết phải bật cron).
 */
export function buildPpcDeptSummary(ads: AdsDashboardSummary | null): DeptSummary {
  if (!ads || !ads.hasData || !ads.primary) {
    return {
      name: "Quảng cáo (PPC)",
      href: "/ppc",
      icon: "📣",
      kpi: "chưa có số liệu",
      kpiSub: "bật cron ads-sync để đồng bộ Ads API",
      alertCount: 0,
      tone: "flat",
    };
  }
  const t = ads.primary;
  const alerts = ppcAlertCount(ads);
  return {
    name: "Quảng cáo (PPC)",
    href: "/ppc",
    icon: "📣",
    kpi: `${moneyText(t.spend7)} · ACOS ${pctText(t.acos7)}`,
    kpiSub:
      `TACOS ${pctText(t.tacos7)} · ${t.currency} · ${t.shops} shop` +
      (ads.staleShops > 0 ? ` · DỮ LIỆU CŨ ${ads.staleShops} shop` : ""),
    alertCount: alerts,
    tone: ads.staleShops > 0 ? "down" : alerts > 0 ? "warn" : "up",
  };
}
