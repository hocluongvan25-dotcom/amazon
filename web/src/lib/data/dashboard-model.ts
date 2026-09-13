/**
 * Data model cho Dashboard KPI tổng hợp — đọc từ nhiều Supabase views.
 * Gom KPI từ: orders, inventory, listings, pricing, settlements, health, alerts.
 */

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
  adsSpend7d?: number | null;
  adsAcos7d?: number | null;
  adsCurrency?: string | null;
  tacos?: number | null;
}): DashboardKpi[] {
  const ads: DashboardKpi[] =
    stats.adsSpend7d === null || stats.adsSpend7d === undefined
      ? []
      : [
          {
            label: "Chi ads 7 ngày",
            value: `${stats.adsCurrency ?? ""} ${Number(stats.adsSpend7d).toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}`.trim(),
            sub:
              stats.tacos === null || stats.tacos === undefined
                ? `ACOS ${stats.adsAcos7d === null || stats.adsAcos7d === undefined ? "—" : `${stats.adsAcos7d}%`} · TACOS cần F4 cùng kỳ`
                : `ACOS ${stats.adsAcos7d ?? "—"}% · TACOS ${stats.tacos.toFixed(1)}% (mục tiêu ≤ 8%)`,
            tone:
              stats.tacos === null || stats.tacos === undefined
                ? "warn"
                : stats.tacos <= 8
                  ? "up"
                  : "warn",
          },
        ];
  return [
    ...ads,
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
