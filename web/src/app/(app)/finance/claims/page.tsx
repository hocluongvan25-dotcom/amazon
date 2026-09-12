import { LiveFinanceClaims } from "@/components/finance/LiveFinanceClaims";
import { Chip, KpiCard, KpiGrid, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import {
  CLAIM_CATEGORY_VI,
  CLAIM_SLA_HOURS,
  CLAIM_STATUS_VI,
  money,
  summarizeClaims,
  type ClaimRow,
} from "@/lib/data/finance-model";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo"];

/** Dữ liệu minh họa DEMO MODE — khớp đúng hình dạng view vexim_reimbursement_claims. */
const demoClaims: ClaimRow[] = [
  {
    id: "demo-1",
    seller_account_id: "demo",
    shop: "Shop A",
    sku: "TG-LUG-20-BLK",
    asin: "B0DEMO001",
    category: "lost_fc",
    source: "ledger",
    source_ref: "ADJ-778812",
    source_reason: "MISSING",
    quantity: 3,
    currency: "USD",
    unit_cost: 12.5,
    estimated_amount: 37.5,
    status: "to_claim",
    detected_at: "2026-09-05T02:10:00Z",
    age_hours: 172,
  },
  {
    id: "demo-2",
    seller_account_id: "demo",
    shop: "Shop A",
    sku: "TG-POUCH-07-GRY",
    asin: "B0DEMO002",
    category: "damaged_fc",
    source: "ledger",
    source_ref: "ADJ-778845",
    source_reason: "DAMAGED",
    quantity: 1,
    currency: "USD",
    unit_cost: 9.9,
    estimated_amount: 9.9,
    status: "filed",
    amazon_case_id: "CASE-22114477",
    filed_at: "2026-09-10T02:00:00Z",
    detected_at: "2026-09-08T02:10:00Z",
    age_hours: 52,
  },
  {
    id: "demo-3",
    seller_account_id: "demo",
    shop: "Shop B",
    sku: "TG-CABLE-2M",
    asin: "B0DEMO003",
    category: "inbound_missing",
    source: "ledger",
    source_ref: "INB-556201",
    source_reason: "MISSING",
    quantity: 5,
    currency: "USD",
    unit_cost: null,
    estimated_amount: null,
    status: "suspected",
    detected_at: "2026-09-11T02:10:00Z",
    age_hours: 10,
  },
  {
    id: "demo-4",
    seller_account_id: "demo",
    shop: "Shop B",
    sku: "TG-POUCH-07-GRY",
    category: "lost_fc",
    source: "ledger",
    source_ref: "ADJ-778301",
    currency: "USD",
    quantity: 2,
    unit_cost: 9.9,
    estimated_amount: 19.8,
    status: "paid",
    amazon_case_id: "CASE-22110032",
    filed_at: "2026-08-30T02:00:00Z",
    decided_at: "2026-09-03T02:00:00Z",
    reimbursed_amount: 19.8,
    reimbursement_id: "REIMB-99321",
    detected_at: "2026-08-28T02:10:00Z",
    age_hours: 340,
  },
];

export default async function ClaimsPage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;
  if (session.mode === "supabase") return <LiveFinanceClaims />;

  const summary = summarizeClaims(demoClaims);

  return (
    <>
      <div className="mb-3 text-sm font-bold text-amber">DEMO · Dữ liệu minh họa</div>
      <PageHeader
        title="Bồi hoàn FBA (F3)"
        sub={`${demoClaims.length} khoản · SLA ${CLAIM_SLA_HOURS}h · nhịp đối chiếu hằng tuần`}
        desc="Nguồn: report Reimbursements + Ledger (Adjustments/CustomerReturns/Receipts) + tồn kho Aged · quy trình SOP-09."
      />
      <KpiGrid>
        <KpiCard
          label="Khoản nghi ngờ đang mở"
          value={String(summary.byStatus.suspected + summary.byStatus.to_claim)}
          sub={`${summary.total} khoản tổng cộng · ${summary.units} đơn vị`}
        />
        <KpiCard label="Giá trị đang khiếu nại" value={money(summary.openValue)} sub="theo giá vốn hiệu lực" />
        <KpiCard label="Đã về tiền" value={money(summary.paidValue)} sub={`${summary.byStatus.paid} khoản`} />
        <KpiCard
          label="Quá hạn 48h"
          value={String(summary.overdueCount)}
          sub={summary.missingCostCount > 0 ? `${summary.missingCostCount} khoản thiếu giá vốn` : "đủ giá vốn"}
          tone={summary.overdueCount > 0 ? "warn" : "flat"}
        />
      </KpiGrid>

      <Panel title="Hàng đợi khiếu nại (SOP-09)" hint="sắp theo mức quá hạn">
        <table className={tableCls.table}>
          <thead>
            <tr>
              <th className={tableCls.th}>SKU</th>
              <th className={tableCls.th}>Shop</th>
              <th className={tableCls.th}>Nguyên nhân</th>
              <th className={`${tableCls.th} text-right`}>SL</th>
              <th className={`${tableCls.th} text-right`}>Giá trị</th>
              <th className={tableCls.th}>Trạng thái</th>
              <th className={tableCls.th}>Tuổi claim</th>
            </tr>
          </thead>
          <tbody>
            {demoClaims.map((c) => (
              <tr key={c.id}>
                <td className={`${tableCls.td} font-bold`}>{c.sku}</td>
                <td className={tableCls.td}>{c.shop}</td>
                <td className={tableCls.td}>{CLAIM_CATEGORY_VI[c.category]}</td>
                <td className={tableCls.tdNum}>{c.quantity}</td>
                <td className={tableCls.tdNum}>{money(c.estimated_amount)}</td>
                <td className={tableCls.td}>
                  <Chip tone={c.status === "paid" ? "green" : c.status === "filed" ? "amber" : "blue"}>
                    {CLAIM_STATUS_VI[c.status]}
                  </Chip>
                </td>
                <td className={tableCls.td}>
                  {c.status === "filed" && (c.age_hours ?? 0) > CLAIM_SLA_HOURS ? (
                    <Chip tone="red">⚠ quá {CLAIM_SLA_HOURS}h</Chip>
                  ) : (
                    <span className="text-[12px] font-semibold text-muted">{c.age_hours}h</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[11.5px] text-soft">
          DEMO MODE — nối Supabase sẽ bật được luồng thao tác (nộp case, duyệt, ghi nhận tiền về) qua RPC đã
          kiểm quyền ở database.
        </p>
      </Panel>
    </>
  );
}
