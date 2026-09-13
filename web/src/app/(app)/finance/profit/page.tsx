import { LiveSkuProfit } from "@/components/finance/LiveSkuProfit";
import { ProfitTable } from "@/components/finance/ProfitTable";
import { NoAccess, PageHeader } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import type { SkuProfitDbRow } from "@/lib/data/finance-model";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo"];

/** Dữ liệu minh họa DEMO MODE — khớp hình dạng view vexim_sku_profit. */
const demoProfit: SkuProfitDbRow[] = [
  {
    seller_account_id: "demo",
    shop: "Shop A",
    sku: "TG-LUG-20-BLK",
    day: "2026-09-10",
    currency: "USD",
    units: 6,
    revenue: 300,
    refunds: -25,
    amazon_fees: -63,
    promo: -5,
    cogs: 75,
    ads_spend: null,
    gross_profit: 132,
    unit_cost: 12.5,
    fee_source: "settled",
    computed_at: "2026-09-11T02:00:00Z",
  },
  {
    seller_account_id: "demo",
    shop: "Shop A",
    sku: "TG-POUCH-07-GRY",
    day: "2026-09-10",
    currency: "USD",
    units: 9,
    revenue: 180,
    refunds: 0,
    amazon_fees: -52,
    promo: 0,
    cogs: 89.1,
    ads_spend: null,
    gross_profit: 38.9,
    unit_cost: 9.9,
    fee_source: "settled",
    computed_at: "2026-09-11T02:00:00Z",
  },
  {
    seller_account_id: "demo",
    shop: "Shop B",
    sku: "TG-LOSS-01",
    day: "2026-09-10",
    currency: "USD",
    units: 4,
    revenue: 60,
    refunds: -12,
    amazon_fees: -21,
    promo: 0,
    cogs: 56,
    ads_spend: null,
    gross_profit: -29,
    unit_cost: 14,
    fee_source: "settled",
    computed_at: "2026-09-11T02:00:00Z",
  },
  {
    seller_account_id: "demo",
    shop: "Shop B",
    sku: "TG-CABLE-2M",
    day: "2026-09-10",
    currency: "USD",
    units: 5,
    revenue: 95,
    refunds: 0,
    amazon_fees: -19,
    promo: 0,
    cogs: null,
    ads_spend: null,
    gross_profit: null,
    unit_cost: null,
    fee_source: "fees_api",
    computed_at: "2026-09-11T02:00:00Z",
  },
];

export default async function ProfitPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; shop?: string }>;
}) {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  const sp = await searchParams;
  if (session.mode === "supabase") return <LiveSkuProfit month={sp.month} shop={sp.shop} />;

  return (
    <>
      <div className="mb-3 text-sm font-bold text-amber">DEMO · Dữ liệu minh họa</div>
      <PageHeader
        title="Lợi nhuận SKU (F4)"
        sub="Tháng 09/2026 · 14 shop · đối soát hằng ngày"
        desc="Lợi nhuận thực của từng SKU sau khi trừ phí Amazon và giá vốn — biết chính xác sản phẩm nào đang lãi, sản phẩm nào đang lỗ."
      />
      <ProfitTable rows={demoProfit} period="2026-09" />
    </>
  );
}
