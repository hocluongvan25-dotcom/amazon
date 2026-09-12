"use server";

/**
 * Server Action cho F3 — nộp/duyệt khoản khiếu nại bồi hoàn FBA.
 *
 * Đi qua RPC `public.vexim_update_reimbursement_claim` của migration 0015 bằng
 * ANON client + phiên đăng nhập → RLS/`iam.is_finance_editor()` quyết định
 * quyền ở tầng database (web KHÔNG dùng service_role).
 */

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

const ACTION_LABEL: Record<string, string> = {
  to_claim: "Đưa vào danh sách nộp",
  file: "Đã nộp case Amazon",
  approve: "Amazon chấp nhận",
  reject: "Amazon từ chối",
  paid: "Ghi nhận tiền đã về",
  close: "Đóng hồ sơ",
  reopen: "Mở lại để nộp tiếp",
};

export async function updateClaimAction(
  formData: FormData,
): Promise<{ ok: boolean; message: string }> {
  const claimId = String(formData.get("claimId") ?? "").trim();
  const action = String(formData.get("action") ?? "").trim();
  const caseId = String(formData.get("caseId") ?? "").trim() || null;
  const note = String(formData.get("note") ?? "").trim() || null;
  const rawAmount = String(formData.get("amount") ?? "").trim();

  const label = ACTION_LABEL[action];
  if (!claimId || !label) return { ok: false, message: "Thiếu khoản khiếu nại hoặc hành động." };

  let amount: number | null = null;
  if (rawAmount) {
    amount = Number(rawAmount.replace(/[,\s]/g, ""));
    if (!Number.isFinite(amount)) return { ok: false, message: "Số tiền không hợp lệ." };
  }

  const client = await createClient();
  if (!client) return { ok: false, message: "Chưa cấu hình Supabase." };

  const { error } = await client.rpc("vexim_update_reimbursement_claim", {
    p_claim_id: claimId,
    p_action: action,
    p_case_id: caseId,
    p_amount: amount,
    p_note: note,
    p_evidence: null,
  });

  if (error) {
    // Trigger của 0015 nói rõ lý do (thiếu mã case / thiếu ghi chú / thiếu quyền)
    return { ok: false, message: `Không cập nhật được: ${error.message}` };
  }

  revalidatePath("/finance/claims");
  revalidatePath("/finance");
  return { ok: true, message: `Đã ghi nhận: ${label}.` };
}
