/**
 * LiveCostInputs — server component cho trang GIÁ VỐN `/finance/costs` (Đợt A).
 *
 * Đọc view `public.vexim_cost_inputs` / `vexim_cost_coverage` / `vexim_shops`
 * bằng anon client + phiên đăng nhập (RLS lọc theo `iam.can_read_seller_account`).
 * Đọc lỗi → BÁO RÕ nguyên nhân thay vì hiện bảng rỗng (bài học từ F3).
 */
import { CostInputsBoard } from "@/components/finance/CostInputsBoard";
import { KpiCard, KpiGrid, Panel } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { readCostCoverage, readCostInputs, readShopOptions } from "@/lib/data/cost-inputs";
import { summarizeCostInputs, summarizeCoverage, type CostCoverageRow, type CostInputRow } from "@/lib/data/cost-model";
import { percent } from "@/lib/data/finance-model";

export async function LiveCostInputs() {
  let inputs: CostInputRow[] = [];
  let coverage: CostCoverageRow[] = [];
  let shops: { id: string; name: string }[] = [];
  let failed: string | null = null;

  try {
    const [rowsInputs, rowsCoverage, rowsShops] = await Promise.all([
      readCostInputs(),
      readCostCoverage(),
      readShopOptions(),
    ]);
    if (rowsInputs === null || rowsCoverage === null) throw new Error("Chưa cấu hình Supabase");
    inputs = rowsInputs;
    coverage = rowsCoverage;
    shops = rowsShops;
  } catch (error) {
    failed = error instanceof Error ? error.message : "Không đọc được dữ liệu giá vốn";
  }

  const session = await requireSession();
  const canWrite = session.mode === "supabase";
  // Quyền XOÁ thật do DB chốt (admin/trưởng phòng Tài chính) — UI chỉ ẩn cho gọn.
  const canDelete = session.persona === "ceo";

  if (failed) {
    return (
      <Panel title="Giá vốn (F3/F4/P1)" hint="không đọc được dữ liệu">
        <p className="text-[13px] text-amber">
          {failed}. Kiểm tra migration <code>0016_core_data_unblock.sql</code> đã chạy (view{" "}
          <code>vexim_cost_inputs</code>, <code>vexim_cost_coverage</code>, <code>vexim_shops</code>) và bạn đã đăng
          nhập bằng user có quyền đọc shop.
        </p>
      </Panel>
    );
  }

  const summary = summarizeCostInputs(inputs);
  const cov = summarizeCoverage(coverage);
  const upcoming = summary.upcoming;

  return (
    <>
      <div className="mb-3 text-sm font-bold text-accent-ink">
        SUPABASE · giá vốn theo bậc hiệu lực — nguồn của F3 (giá trị claim), F4 (lãi SKU) và P1 (giá sàn)
      </div>

      <KpiGrid>
        <KpiCard
          label="Độ phủ giá vốn"
          value={percent(cov.coveragePct)}
          sub={`${cov.covered}/${cov.total} SKU đang bán có giá vốn dùng được`}
          tone={cov.coveragePct !== null && cov.coveragePct < 1 ? "warn" : "up"}
        />
        <KpiCard
          label="SKU đang chặn F3/F4/P1"
          value={String(cov.missing)}
          sub={cov.mismatch > 0 ? `${cov.mismatch} SKU lệch tiền tệ (không cộng được)` : "không có SKU lệch tiền tệ"}
          tone={cov.missing > 0 ? "down" : "flat"}
        />
        <KpiCard
          label="Bậc giá vốn đang áp dụng"
          value={String(summary.current)}
          sub={`${summary.total} bậc đã nhập · ${summary.skus} SKU · ${summary.shops} shop`}
          tone="flat"
        />
        <KpiCard
          label="Bậc sắp hiệu lực"
          value={String(upcoming)}
          sub={upcoming > 0 ? "đã nhập trước giá mới — tới ngày sẽ tự áp dụng" : "chưa có bậc nào chờ tới ngày"}
          tone={upcoming > 0 ? "warn" : "flat"}
        />
      </KpiGrid>

      <CostInputsBoard
        inputs={inputs}
        coverage={coverage}
        shops={shops}
        canWrite={canWrite}
        canDelete={canDelete}
      />
    </>
  );
}
