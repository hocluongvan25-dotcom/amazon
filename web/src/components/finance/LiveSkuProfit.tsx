/**
 * LiveSkuProfit — server component cho F4 (lợi nhuận SKU).
 * Đọc vexim_sku_profit theo tháng (mặc định tháng hiện tại) + giá vốn hiệu lực.
 */
import { ProfitTable } from "@/components/finance/ProfitTable";
import { Panel } from "@/components/ui";
import { monthRange, readSkuProfit } from "@/lib/data/finance-claims";
import type { SkuProfitDbRow } from "@/lib/data/finance-model";

export async function LiveSkuProfit({ month, shop }: { month?: string; shop?: string }) {
  const now = new Date();
  const selected = /^\d{4}-\d{2}$/.test(month ?? "") ? (month as string) : now.toISOString().slice(0, 7);
  const { from, to } = monthRange(selected, now);

  let rows: SkuProfitDbRow[] = [];
  let failed: string | null = null;
  try {
    const data = await readSkuProfit({ sellerAccountId: shop, from, to });
    if (data === null) throw new Error("Chưa cấu hình Supabase");
    rows = data;
  } catch (error) {
    failed = error instanceof Error ? error.message : "Không đọc được dữ liệu lợi nhuận";
  }

  const months = [-2, -1, 0].map((offset) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    return d.toISOString().slice(0, 7);
  });

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="font-bold text-accent-ink">SUPABASE · {rows.length} dòng SKU/ngày</span>
        <span className="text-soft">Kỳ:</span>
        {months.map((m) => (
          <a
            key={m}
            href={`/finance/profit?month=${m}`}
            className={`rounded-full border px-3 py-1 text-[12px] font-bold transition ${
              m === selected
                ? "border-accent bg-accent-soft text-accent-ink"
                : "border-line bg-card text-muted hover:border-accent"
            }`}
          >
            {m}
          </a>
        ))}
        <span className="text-[12px] text-soft">
          ({from} → {to})
        </span>
      </div>

      {failed ? (
        <Panel title="Lợi nhuận SKU (F4)" hint="không đọc được dữ liệu">
          <p className="text-[13px] text-amber">
            {failed}. Cần migration 0015 (bảng <code>finance.sku_profit_daily</code> + view{" "}
            <code>vexim_sku_profit</code>) và worker đã chạy <code>worker:finance-claims</code>.
          </p>
        </Panel>
      ) : (
        <ProfitTable rows={rows} period={selected} />
      )}

      <Panel title="Cách tính & giới hạn" hint="để không hiểu sai con số">
        <ul className="space-y-1 text-[12.5px] text-muted">
          <li>
            • <b>Doanh thu</b>: ProductSale + ShippingCredit + Reimbursement; Refund/PromotionRebate cộng theo
            dấu Amazon gửi (không tự đổi dấu).
          </li>
          <li>
            • <b>Phí Amazon</b>: Referral, FBA, Storage, Advertising, Service, Subscription — lấy từ dòng tiền
            settlement (Finances API). Khi một ngày chưa có settlement, hệ thống có thể dùng ước tính Product
            Fees API và ghi rõ nguồn.
          </li>
          <li>
            • <b>Giá vốn</b>: <code>catalog.effective_cost()</code> theo đúng ngày phát sinh — đổi bậc giá vốn
            thì ngày sau dùng giá mới.
          </li>
          <li>
            • <b>Ads</b>: cột riêng, không trừ vào lãi gộp; Module 5 (PPC) chưa đồng bộ nên để “—” chứ không
            mặc định 0.
          </li>
          <li>
            • <b>Không đoán số</b>: thiếu giá vốn → lãi gộp và biên để “—”; vẫn hiện doanh thu để đối chiếu.
          </li>
        </ul>
      </Panel>
    </>
  );
}
