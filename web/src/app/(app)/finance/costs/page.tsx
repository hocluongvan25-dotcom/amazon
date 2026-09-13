import { LiveCostInputs } from "@/components/finance/LiveCostInputs";
import { CostInputsBoard } from "@/components/finance/CostInputsBoard";
import { KpiCard, KpiGrid, NoAccess, PageHeader } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import {
  summarizeCostInputs,
  summarizeCoverage,
  type CostCoverageRow,
  type CostInputRow,
} from "@/lib/data/cost-model";
import { percent } from "@/lib/data/finance-model";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo"];

/**
 * Dữ liệu minh họa DEMO MODE — khớp đúng hình dạng view của migration 0016
 * (`vexim_cost_inputs` / `vexim_cost_coverage` / `vexim_shops`) để màn hình demo
 * và màn hình thật giống hệt nhau, chỉ khác nguồn dữ liệu.
 */
const demoShops = [
  { id: "demo-shop-a", name: "Shop A (US)" },
  { id: "demo-shop-b", name: "Shop B (EU)" },
];

const demoInputs: CostInputRow[] = [
  {
    id: "demo-c1",
    seller_account_id: "demo-shop-a",
    shop: "Shop A (US)",
    sku: "TG-LUG-20-BLK",
    unit_cost: 41.5,
    currency: "USD",
    effective_from: "2026-07-01",
    effective_to: "2026-09-01",
    source: "manual",
    note: "Giá FOB lô T7",
    is_current: false,
  },
  {
    id: "demo-c2",
    seller_account_id: "demo-shop-a",
    shop: "Shop A (US)",
    sku: "TG-LUG-20-BLK",
    unit_cost: 43.2,
    currency: "USD",
    effective_from: "2026-09-01",
    effective_to: null,
    source: "csv",
    source_ref: "gia-von-T9.csv",
    note: "Nhà máy tăng giá — bậc cũ tự kết thúc 01/09",
    is_current: true,
    is_open_ended: true,
  },
  {
    id: "demo-c3",
    seller_account_id: "demo-shop-a",
    shop: "Shop A (US)",
    sku: "TG-POUCH-07-GRY",
    unit_cost: 9.9,
    currency: "USD",
    effective_from: "2026-08-15",
    effective_to: null,
    source: "manual",
    is_current: true,
    is_open_ended: true,
  },
  {
    id: "demo-c4",
    seller_account_id: "demo-shop-a",
    shop: "Shop A (US)",
    sku: "TG-LUG-20-BLK",
    unit_cost: 45.0,
    currency: "USD",
    effective_from: "2026-10-01",
    effective_to: null,
    source: "csv",
    note: "Đã chốt giá Q4 với nhà máy",
    is_current: false,
  },
  {
    id: "demo-c5",
    seller_account_id: "demo-shop-b",
    shop: "Shop B (EU)",
    sku: "TG-CABLE-2M",
    unit_cost: 3.1,
    currency: "CNY",
    effective_from: "2026-09-01",
    effective_to: null,
    source: "api",
    note: "Giá kho đối tác, chưa gồm thuế nhập",
    is_current: true,
  },
];

const demoCoverage: CostCoverageRow[] = [
  {
    seller_account_id: "demo-shop-a",
    shop: "Shop A (US)",
    sku: "TG-LUG-20-BLK",
    asin: "B0DEMO001",
    title: "TravelGear 20\" Hardside",
    status: "ACTIVE",
    price: 129.99,
    currency: "USD",
    unit_cost: 43.2,
    cost_currency: "USD",
    cost_effective_from: "2026-09-01",
    cost_source: "csv",
    missing_cost: false,
    currency_mismatch: false,
  },
  {
    seller_account_id: "demo-shop-a",
    shop: "Shop A (US)",
    sku: "TG-POUCH-07-GRY",
    asin: "B0DEMO002",
    status: "ACTIVE",
    price: 24.99,
    currency: "USD",
    unit_cost: 9.9,
    cost_currency: "USD",
    cost_effective_from: "2026-08-15",
    cost_source: "manual",
    missing_cost: false,
    currency_mismatch: false,
  },
  {
    seller_account_id: "demo-shop-a",
    shop: "Shop A (US)",
    sku: "TG-ORG-03-NVY",
    asin: "B0DEMO003",
    status: "ACTIVE",
    price: 19.5,
    currency: "USD",
    unit_cost: null,
    missing_cost: true,
    currency_mismatch: false,
  },
  {
    seller_account_id: "demo-shop-b",
    shop: "Shop B (EU)",
    sku: "TG-CABLE-2M",
    asin: "B0DEMO004",
    status: "ACTIVE",
    price: 15.99,
    currency: "EUR",
    unit_cost: 3.1,
    cost_currency: "CNY",
    cost_effective_from: "2026-09-01",
    cost_source: "api",
    missing_cost: false,
    currency_mismatch: true,
  },
];

export default async function CostsPage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  const header = (sub: string) => (
    <PageHeader
      title="Giá vốn (đầu vào F3/F4/P1)"
      sub={sub}
      desc="Quản lý giá vốn từng SKU — nhập tay hoặc import CSV. Giá vốn có hiệu lực theo thời gian nên lợi nhuận quá khứ luôn tính đúng giá tại ngày bán."
    />
  );

  if (session.mode === "supabase") {
    return (
      <>
        {header("dữ liệu thật · catalog.cost_inputs")}
        <LiveCostInputs />
      </>
    );
  }

  const summary = summarizeCostInputs(demoInputs);
  const cov = summarizeCoverage(demoCoverage);

  return (
    <>
      <div className="mb-3 text-sm font-bold text-amber">DEMO · Dữ liệu minh họa — không ghi được</div>
      {header(`${demoInputs.length} bậc giá vốn · ${cov.total} SKU đang bán`)}

      <KpiGrid>
        <KpiCard
          label="Độ phủ giá vốn"
          value={percent(cov.coveragePct)}
          sub={`${cov.covered}/${cov.total} SKU đang bán có giá vốn dùng được`}
          tone={cov.coveragePct !== null && cov.coveragePct < 1 ? "warn" : "up"}
        />
        <KpiCard
          label="SKU đang chặn F3/F4/P1"
          value={String(cov.missing + cov.mismatch)}
          sub={`${cov.missing} thiếu giá vốn · ${cov.mismatch} lệch tiền tệ`}
          tone="down"
        />
        <KpiCard
          label="Bậc đang áp dụng"
          value={String(summary.current)}
          sub={`${summary.skus} SKU · ${summary.shops} shop`}
        />
        <KpiCard
          label="Bậc sắp hiệu lực"
          value={String(summary.upcoming)}
          sub={summary.upcoming > 0 ? "đã nhập trước giá mới" : "không có bậc chờ"}
          tone={summary.upcoming > 0 ? "warn" : "flat"}
        />
      </KpiGrid>

      <CostInputsBoard
        inputs={demoInputs}
        coverage={demoCoverage}
        shops={demoShops}
        canWrite={false}
        canDelete={false}
      />
    </>
  );
}
