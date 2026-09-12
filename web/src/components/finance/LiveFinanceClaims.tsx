/**
 * LiveFinanceClaims — server component cho F3 (bồi hoàn FBA, SOP-09).
 * Đọc Supabase (view public + RLS), nếu lỗi thì báo rõ thay vì hiện bảng rỗng.
 */
import { ClaimBoard } from "@/components/finance/ClaimBoard";
import { KpiCard, KpiGrid, Panel } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { readClaimHistory, readReimbursementClaims } from "@/lib/data/finance-claims";
import { money, summarizeClaims, type ClaimHistoryRow, type ClaimRow } from "@/lib/data/finance-model";

export async function LiveFinanceClaims({ shop }: { shop?: string }) {
  let claims: ClaimRow[] = [];
  let history: Record<string, ClaimHistoryRow[]> = {};
  let failed: string | null = null;

  try {
    const rows = await readReimbursementClaims(shop);
    if (rows === null) throw new Error("Chưa cấu hình Supabase");
    claims = rows;
    // Lấy lịch sử trong 1 lượt (chỉ cho các claim đang hiển thị, tối đa 200)
    for (const claim of claims.slice(0, 200)) {
      const detail = await readClaimHistory(claim.id);
      history[claim.id] = detail ?? [];
    }
  } catch (error) {
    failed = error instanceof Error ? error.message : "Không đọc được dữ liệu claim";
  }

  const session = await requireSession();
  const canWrite = session.mode === "supabase";
  // Quyền duyệt thật do `iam.is_finance_editor()` chốt ở DB; UI chỉ ẩn cho gọn.
  const canDecide = session.persona === "ceo";

  if (failed) {
    return (
      <Panel title="Bồi hoàn FBA (F3)" hint="không đọc được dữ liệu">
        <p className="text-[13px] text-amber">
          {failed}. Kiểm tra view <code>vexim_reimbursement_claims</code> đã được migration 0015 tạo và worker
          đã chạy F3 chưa.
        </p>
      </Panel>
    );
  }

  const summary = summarizeClaims(claims);
  const currency = claims[0]?.currency ?? "USD";
  const filedWithoutCase = claims.filter((c) => c.status === "filed" && !c.amazon_case_id).length;

  return (
    <>
      <div className="mb-3 text-sm font-bold text-accent-ink">
        SUPABASE · đối chiếu tự động kho vs nhận vs bồi hoàn
      </div>
      <KpiGrid>
        <KpiCard
          label="Khoản nghi ngờ đang mở"
          value={String(summary.byStatus.to_claim + summary.byStatus.suspected)}
          sub={`${summary.total} khoản tổng cộng · ${summary.units} đơn vị hàng`}
          tone="flat"
        />
        <KpiCard
          label="Giá trị đang khiếu nại"
          value={money(summary.openValue, currency)}
          sub="theo giá vốn hiệu lực tại ngày phát sinh"
          tone="flat"
        />
        <KpiCard
          label="Đã về tiền"
          value={money(summary.paidValue, currency)}
          sub={`${summary.byStatus.paid} khoản được Amazon trả`}
          tone="flat"
        />
        <KpiCard
          label="Quá hạn 48h (SOP-09)"
          value={String(summary.overdueCount)}
          sub={
            summary.missingCostCount > 0
              ? `${summary.missingCostCount} khoản chưa có giá vốn — ước tính đang trống`
              : "không có khoản nào thiếu giá vốn"
          }
          tone={summary.overdueCount > 0 ? "warn" : "flat"}
        />
      </KpiGrid>

      <Panel title="Quy trình SOP-09" hint="7 bước · nhịp tuần">
        <ol className="grid gap-1.5 text-[12.5px] text-muted lg:grid-cols-2">
          <li>1. Worker đối chiếu Ledger ↔ inbound ↔ bồi hoàn → đánh dấu khoản nghi ngờ.</li>
          <li>2. Phân loại nguyên nhân (mất FC / hư hỏng / thiếu khi nhập / thu sai phí).</li>
          <li>3. Đối chiếu giá vốn hiệu lực để ra giá trị khiếu nại.</li>
          <li>4. Nộp case trên Seller Central và ghi mã case vào hệ thống (bắt buộc).</li>
          <li>5. Theo dõi 48h: quá hạn chưa có kết luận thì đẩy case (cột “Tuổi claim” báo đỏ).</li>
          <li>6. Amazon chấp nhận → ghi nhận tiền về, khớp với report Reimbursements.</li>
          <li>7. Tổng hợp vào báo cáo khách hàng tuần (SOP-12), đóng hồ sơ và lưu chứng từ.</li>
        </ol>
        {filedWithoutCase > 0 ? (
          <p className="mt-2 text-[12.5px] font-semibold text-red">
            ⚠ {filedWithoutCase} khoản ghi “đã nộp” nhưng thiếu mã case — cần bổ sung.
          </p>
        ) : null}
      </Panel>

      <ClaimBoard claims={claims} history={history} canWrite={canWrite} canDecide={canDecide} />

      <Panel title="Nguồn dữ liệu" hint="kiểm chứng khi lệch số">
        <ul className="space-y-1 text-[12.5px] text-muted">
          <li>
            • <b>GET_LEDGER_DETAIL_VIEW_DATA</b> — sổ cái kho 18 tháng: EventType, Reason, Disposition, Quantity.
          </li>
          <li>
            • <b>GET_FBA_REIMBURSEMENTS_DATA</b> — từng khoản Amazon đã bồi hoàn (reimbursement-id, case-id,
            amount-total) để khớp với claim.
          </li>
          <li>
            • <b>GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA / AGE</b> — hàng tồn lâu ngày không nhúc nhích để
            soi khoản mất chưa được bồi hoàn.
          </li>
          <li>• Giá vốn: bảng nội bộ <code>catalog.cost_inputs</code> do VEXIM nhập, lấy theo bậc hiệu lực.</li>
        </ul>
      </Panel>
    </>
  );
}
