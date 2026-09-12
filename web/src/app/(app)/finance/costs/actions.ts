"use server";

/**
 * Server Action cho trang GIÁ VỐN `/finance/costs` (Đợt A — gỡ chặn F3/F4/P1).
 *
 * Mọi ghi đều đi qua RPC của migration 0016 bằng ANON client + phiên đăng nhập,
 * để quyền do `iam.can_write_seller_account()` + `iam.is_cost_editor()` chốt ở DB
 * (web KHÔNG dùng service_role, KHÔNG insert/update thẳng bảng catalog.cost_inputs).
 *
 *   • vexim_upsert_cost_input  — nhập tay một bậc (tự cắt ngọn bậc cũ)
 *   • vexim_import_cost_inputs — import CSV theo template (atomic: có lỗi → không ghi gì)
 *   • vexim_close_cost_input   — kết thúc hiệu lực một bậc (giữ lịch sử cho F4)
 *   • vexim_delete_cost_input  — xoá bậc nhập sai (chỉ admin/trưởng phòng Tài chính)
 */

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  formatImportResult,
  MAX_IMPORT_ROWS,
  parseCostImportCsv,
  validateCostForm,
  type CostImportError,
} from "@/lib/data/cost-model";

/** Kết quả jsonb của `public.vexim_import_cost_inputs` (migration 0016). */
type ImportRpcResult = {
  ok?: boolean;
  rows?: number;
  inserted?: number;
  updated?: number;
  closed_previous?: number;
  superseded?: number;
  errors?: CostImportError[];
};

export type CostActionResult = {
  ok: boolean;
  message: string;
  errors?: CostImportError[];
};

/** Trang đọc giá vốn + các trang hưởng lợi từ nó (F4 lãi, P1 sàn giá). */
function revalidateCostPaths() {
  revalidatePath("/finance/costs");
  revalidatePath("/finance/profit");
  revalidatePath("/finance/claims");
  revalidatePath("/pricing");
  revalidatePath("/finance");
}

function fail(message: string, errors?: CostImportError[]): CostActionResult {
  return { ok: false, message, ...(errors ? { errors } : {}) };
}

/* ============================ Nhập tay một bậc ============================ */

export async function saveCostInputAction(formData: FormData): Promise<CostActionResult> {
  const validated = validateCostForm({
    sellerAccountId: String(formData.get("sellerAccountId") ?? "").trim(),
    sku: String(formData.get("sku") ?? ""),
    unitCost: String(formData.get("unitCost") ?? ""),
    currency: String(formData.get("currency") ?? "USD"),
    effectiveFrom: String(formData.get("effectiveFrom") ?? ""),
    effectiveTo: String(formData.get("effectiveTo") ?? ""),
    note: String(formData.get("note") ?? ""),
  });
  if (!validated.ok) return fail(validated.message);

  const client = await createClient();
  if (!client) return fail("Chưa cấu hình Supabase — không ghi được giá vốn.");

  const { data, error } = await client.rpc("vexim_upsert_cost_input", validated.payload);
  if (error) {
    // DB trả lý do thật: thiếu quyền / SKU quá dài / ngày kết thúc ≤ ngày bắt đầu…
    return fail(`Không ghi được: ${error.message}`);
  }

  const res = (data ?? {}) as Record<string, unknown>;
  const updated = Number(res.updated ?? 0) > 0;
  revalidateCostPaths();
  return {
    ok: true,
    message: `${updated ? "Đã cập nhật" : "Đã thêm"} bậc giá vốn ${String(res.sku ?? validated.payload.p_sku)} từ ${validated.payload.p_effective_from}${
      Number(res.closed_previous ?? 0) > 0 ? ` (tự kết thúc ${res.closed_previous} bậc cũ)` : ""
    }.`,
  };
}

/* ============================ Import CSV theo template ============================ */

export async function importCostInputsAction(formData: FormData): Promise<CostActionResult> {
  const sellerAccountId = String(formData.get("sellerAccountId") ?? "").trim();
  const sourceRef = String(formData.get("sourceRef") ?? "").trim() || null;
  const csvText = String(formData.get("csvText") ?? "");

  if (!sellerAccountId) return fail("Chưa chọn shop.");
  if (!csvText.trim()) return fail("Chưa có nội dung file CSV.");

  // Parse LẠI trên server (không tin bản parse phía client): cùng một luật, cùng
  // một hàm — sai ở dòng nào thì báo đúng dòng đó và KHÔNG gọi RPC.
  const parsed = parseCostImportCsv(csvText);
  if (parsed.rows.length === 0) {
    return fail("File không có dòng dữ liệu nào (đã bỏ qua dòng trống và dòng # ghi chú).", parsed.errors);
  }
  if (parsed.errors.length > 0) {
    return fail(
      `Có ${parsed.errors.length} lỗi trong file — không ghi dòng nào (all-or-nothing). Sửa xong hãy import lại.`,
      parsed.errors,
    );
  }
  if (parsed.rows.length > MAX_IMPORT_ROWS) {
    return fail(`Tối đa ${MAX_IMPORT_ROWS} dòng/lần import (file có ${parsed.rows.length} dòng).`);
  }

  const client = await createClient();
  if (!client) return fail("Chưa cấu hình Supabase — không ghi được giá vốn.");

  const { data, error } = await client.rpc("vexim_import_cost_inputs", {
    p_seller: sellerAccountId,
    // Gửi chuỗi thô: DB parse số/ngày bằng catalog.parse_amount + catalog.parse_day
    p_rows: parsed.rows,
    p_source_ref: sourceRef,
  });
  if (error) return fail(`Không import được: ${error.message}`);

  const res = (data ?? {}) as ImportRpcResult;
  if (res.ok === false) {
    // RPC tự hoàn tác khi phát hiện lỗi ở vòng kiểm tra → không có gì nửa vời
    return fail(formatImportResult(res), res.errors ?? []);
  }

  revalidateCostPaths();
  return { ok: true, message: formatImportResult(res) };
}

/* ============================ Kết thúc hiệu lực một bậc ============================ */

export async function closeCostInputAction(formData: FormData): Promise<CostActionResult> {
  const id = String(formData.get("costInputId") ?? "").trim();
  const effectiveTo = String(formData.get("effectiveTo") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim() || null;
  if (!id) return fail("Thiếu bậc giá vốn cần kết thúc.");
  if (!effectiveTo) return fail("Thiếu ngày kết thúc hiệu lực.");

  const client = await createClient();
  if (!client) return fail("Chưa cấu hình Supabase.");

  const { error } = await client.rpc("vexim_close_cost_input", {
    p_cost_input_id: id,
    p_effective_to: effectiveTo,
    p_note: note,
  });
  if (error) return fail(`Không kết thúc được: ${error.message}`);

  revalidateCostPaths();
  return { ok: true, message: `Đã chốt bậc giá vốn tới ngày ${effectiveTo} (lịch sử vẫn giữ cho F4).` };
}

/* ============================ Xoá bậc nhập sai ============================ */

export async function deleteCostInputAction(formData: FormData): Promise<CostActionResult> {
  const id = String(formData.get("costInputId") ?? "").trim();
  if (!id) return fail("Thiếu bậc giá vốn cần xoá.");

  const client = await createClient();
  if (!client) return fail("Chưa cấu hình Supabase.");

  const { error } = await client.rpc("vexim_delete_cost_input", { p_cost_input_id: id });
  if (error) {
    // DB chặn người không phải admin/trưởng phòng Tài chính → nguyên văn lý do
    return fail(`Không xoá được: ${error.message}`);
  }

  revalidateCostPaths();
  return { ok: true, message: "Đã xoá bậc giá vốn (có ghi audit log)." };
}
