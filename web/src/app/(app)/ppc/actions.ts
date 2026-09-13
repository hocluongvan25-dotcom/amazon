"use server";

/**
 * Server Action cho khối "Thay đổi PPC" của /ppc (Module 5 PHẦN 2&3).
 *
 * Mọi ghi đều đi qua RPC của migration 0021 bằng CLIENT PHIÊN (anon + JWT của
 * người đang đăng nhập) để quyền do DB chốt:
 *   • vexim_ppc_propose_changes  — tạo đề xuất (validate guardrail ngay trong DB)
 *   • vexim_ppc_decide_change    — approve/reject MỘT đề xuất (chỉ approver)
 *   • vexim_ppc_decide_bulk      — approve/reject cả lô (một dòng lỗi không hỏng cả lô)
 *   • vexim_ppc_set_policy       — đổi guardrail (chỉ approver, audit before/after)
 *
 * Web KHÔNG dùng service_role ở đây và KHÔNG insert/update thẳng ads.change_requests:
 * mọi chuyển trạng thái phải qua RPC để trigger audit (iam.audit_logs) chắc chắn chạy.
 * Chiều gọi Amazon là việc của cron /api/cron/ads-apply (service_role), không phải
 * của action này — người duyệt không bao giờ trực tiếp bắn request lên Amazon.
 */

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { readPpcPolicies, readPpcNegatives } from "@/lib/data/ppc-write";
import {
  buildProposalPayload,
  validateNegativeDraft,
  validatePolicyDraft,
  validateProposalItems,
  type NegativeDraft,
  type PolicyDraft,
  type PpcProposalItem,
} from "@/lib/data/ppc-write-model";

export type PpcActionResult = {
  ok: boolean;
  message: string;
  /** lý do từng dòng bị chặn/trùng — UI hiện nguyên văn, không tóm tắt mất chi tiết */
  warnings: string[];
  inserted?: number;
  duplicates?: number;
  blocked?: number;
  decided?: number;
};

function fail(message: string, warnings: string[] = []): PpcActionResult {
  return { ok: false, message, warnings };
}

/** Kết quả jsonb của public.vexim_ppc_propose_changes. */
type ProposeRpcResult = {
  ok?: boolean;
  inserted?: number;
  duplicates?: number;
  blocked?: number;
  ids?: string[];
  warnings?: { label?: string; kind?: string; message?: string }[];
  auto_applied?: boolean;
};

function warningLines(warnings: ProposeRpcResult["warnings"]): string[] {
  return (warnings ?? [])
    .map((w) => `${w.label ? `"${w.label}" — ` : ""}${w.message ?? ""}${w.kind ? ` (${w.kind})` : ""}`)
    .filter((s) => s.trim() !== "");
}

/* ============================ Tạo đề xuất ============================ */

export async function proposeChangesAction(input: {
  shopId: string;
  items: PpcProposalItem[];
  source?: "manual" | "suggestion" | "import";
  reason?: string;
  adsProfileId?: string;
}): Promise<PpcActionResult> {
  const shopId = String(input.shopId ?? "").trim();
  if (!shopId) return fail("Chưa chọn shop.");

  const client = await createClient();
  if (!client) return fail("Chưa cấu hình Supabase — không tạo được đề xuất thay đổi PPC.");

  // Validate LẠI trên server bằng guardrail đọc từ DB: client có thể gửi bất cứ
  // thứ gì, và RPC cũng sẽ chặn — nhưng chặn ở đây thì người dùng nhận lý do
  // tiếng Việt theo từng dòng thay vì một lỗi 500.
  const policies = await readPpcPolicies(shopId).catch(() => null);
  const policy = policies?.find((p) => p.shopId === shopId) ?? null;
  if (!policy) {
    return fail(
      "Không đọc được guardrail của shop này (vexim_ppc_policies) — có thể chưa chạy migration 0021 hoặc bạn không có quyền trên shop.",
    );
  }
  const negatives = await readPpcNegatives(shopId, 500).catch(() => []);
  const validated = validateProposalItems(input.items ?? [], policy, { negatives });
  if (!validated.ok) return fail(validated.message, validated.warnings.map((w) => `${w.label ? `"${w.label}" — ` : ""}${w.message}`));

  const payload = buildProposalPayload({
    shopId,
    items: validated.items,
    adsProfileId: input.adsProfileId ?? null,
    source: input.source ?? "manual",
    reason: input.reason ?? null,
  });

  const { data, error } = await client.rpc("vexim_ppc_propose_changes", { p_payload: payload });
  if (error) return fail(`Không tạo được đề xuất: ${error.message}`);

  const res = (data ?? {}) as ProposeRpcResult;
  const inserted = Number(res.inserted ?? 0);
  const duplicates = Number(res.duplicates ?? 0);
  const blocked = Number(res.blocked ?? 0);
  const lines = [
    ...warningLines(res.warnings),
    ...validated.warnings.filter((w) => w.kind === "approval").map((w) => `${w.label ? `"${w.label}" — ` : ""}${w.message}`),
  ];

  revalidatePath("/ppc");

  if (inserted === 0) {
    return {
      ok: false,
      message: `Không tạo được đề xuất nào: ${blocked} bị guardrail chặn, ${duplicates} trùng/không có gì để đổi.`,
      warnings: lines,
      inserted,
      duplicates,
      blocked,
    };
  }

  return {
    ok: true,
    message:
      `Đã tạo ${inserted} đề xuất` +
      (res.auto_applied && inserted > 0 ? " (một số dòng được TỰ DUYỆT theo guardrail — cron sẽ đối chiếu Amazon trước khi ghi)" : " — chờ trưởng phòng PPC duyệt") +
      (duplicates > 0 ? ` · ${duplicates} trùng bị bỏ qua` : "") +
      (blocked > 0 ? ` · ${blocked} bị chặn` : "") +
      ".",
    warnings: lines,
    inserted,
    duplicates,
    blocked,
  };
}

/* ==================== Thêm từ khoá phủ định (nhập tay) ==================== */

export async function proposeNegativeKeywordAction(input: {
  shopId: string;
  draft: NegativeDraft;
  adsProfileId?: string;
}): Promise<PpcActionResult> {
  const shopId = String(input.shopId ?? "").trim();
  if (!shopId) return fail("Chưa chọn shop.");
  const client = await createClient();
  if (!client) return fail("Chưa cấu hình Supabase.");

  const negatives = await readPpcNegatives(shopId, 500).catch(() => []);
  const checked = validateNegativeDraft(input.draft, { negatives });
  if (!checked.ok || !checked.item) return fail(checked.message);

  return proposeChangesAction({
    shopId,
    items: [checked.item],
    source: "manual",
    reason: checked.item.reason ?? undefined,
    adsProfileId: input.adsProfileId,
  });
}

/* ============================ Duyệt / từ chối ============================ */

const DECISIONS = ["approve", "reject"] as const;

export async function decideChangeAction(input: {
  id: string;
  decision: (typeof DECISIONS)[number];
  note?: string;
}): Promise<PpcActionResult> {
  const id = String(input.id ?? "").trim();
  const decision = String(input.decision ?? "").trim().toLowerCase();
  if (!id) return fail("Thiếu đề xuất cần duyệt.");
  if (!DECISIONS.includes(decision as (typeof DECISIONS)[number])) {
    return fail("Quyết định phải là approve hoặc reject.");
  }

  const client = await createClient();
  if (!client) return fail("Chưa cấu hình Supabase.");

  const { data, error } = await client.rpc("vexim_ppc_decide_change", {
    p_request_id: id,
    p_decision: decision,
    p_note: String(input.note ?? "").trim() || null,
  });
  if (error) {
    // DB trả lý do thật: không phải approver / đã duyệt rồi / quá TTL / tự duyệt…
    return fail(`Không ${decision === "approve" ? "duyệt" : "từ chối"} được: ${error.message}`);
  }

  const res = (data ?? {}) as { status?: string; label?: string; note?: string };
  revalidatePath("/ppc");
  return {
    ok: true,
    message:
      decision === "approve"
        ? `Đã duyệt "${res.label ?? id}" — cron ads-apply sẽ đọc lại Amazon rồi mới ghi (chạy lúc 04:20 UTC; muốn chạy ngay thì bật ADS_WRITE_ENABLED và trigger cron).`
        : `Đã từ chối "${res.label ?? id}" — không có gì được gửi lên Amazon.`,
    warnings: res.note ? [`Ghi chú quyết định: ${res.note}`] : [],
    decided: 1,
  };
}

export async function decideBulkAction(input: {
  ids: string[];
  decision: (typeof DECISIONS)[number];
  note?: string;
}): Promise<PpcActionResult> {
  const ids = (input.ids ?? []).map((x) => String(x).trim()).filter(Boolean);
  const decision = String(input.decision ?? "").trim().toLowerCase();
  if (ids.length === 0) return fail("Chưa chọn đề xuất nào.");
  if (ids.length > 500) return fail(`Tối đa 500 đề xuất mỗi lần (đang chọn ${ids.length}).`);
  if (!DECISIONS.includes(decision as (typeof DECISIONS)[number])) {
    return fail("Quyết định phải là approve hoặc reject.");
  }

  const client = await createClient();
  if (!client) return fail("Chưa cấu hình Supabase.");

  const { data, error } = await client.rpc("vexim_ppc_decide_bulk", {
    p_request_ids: ids,
    p_decision: decision,
    p_note: String(input.note ?? "").trim() || null,
  });
  if (error) return fail(`Không xử lý được cả lô: ${error.message}`);

  const res = (data ?? {}) as { decided?: number; failed?: number; errors?: { id?: string; error?: string }[] };
  const decided = Number(res.decided ?? 0);
  const failed = Number(res.failed ?? 0);
  revalidatePath("/ppc");
  return {
    ok: failed === 0 && decided > 0,
    message:
      `${decision === "approve" ? "Đã duyệt" : "Đã từ chối"} ${decided}/${ids.length} đề xuất` +
      (failed > 0 ? ` · ${failed} dòng lỗi (đã duyệt rồi / quá hạn / thiếu quyền)` : "") +
      (decision === "approve" && decided > 0 ? " — chờ cron ads-apply áp dụng." : "."),
    warnings: (res.errors ?? []).map((e) => `${String(e.id ?? "").slice(0, 8)}… — ${e.error ?? "lỗi không rõ"}`),
    decided,
  };
}

/* ============================ Guardrail ============================ */

export async function savePolicyAction(input: { shopId: string; draft: PolicyDraft }): Promise<PpcActionResult> {
  const shopId = String(input.shopId ?? "").trim();
  if (!shopId) return fail("Chưa chọn shop.");

  const checked = validatePolicyDraft(input.draft);
  if (!checked.ok || !checked.policy) return fail(checked.message);

  const client = await createClient();
  if (!client) return fail("Chưa cấu hình Supabase.");

  const { error } = await client.rpc("vexim_ppc_set_policy", {
    p_payload: { seller_account_id: shopId, policy: checked.policy },
  });
  if (error) {
    // CHECK của bảng (sàn>trần, cap<=0) hoặc thiếu quyền approver → nguyên văn
    return fail(`Không lưu được guardrail: ${error.message}`);
  }

  revalidatePath("/ppc");
  return { ok: true, message: checked.message, warnings: [] };
}
