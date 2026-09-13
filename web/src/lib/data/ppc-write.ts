/**
 * Module 5 PHẦN 3 — CHIỀU GHI (chỉ là cửa gọi RPC của 0021).
 *
 *   • Không có đường nào ghi thẳng vào bảng: mọi thay đổi đi qua RPC
 *     `vexim_request_ads_change` → hàng đợi `ads.change_requests` → worker
 *     (`worker:ads-apply` / cron 03:00) → Amazon Ads API v3 → `iam.audit_logs`.
 *   • NGƯỠNG DUYỆT DO DB TÍNH (trigger 0021 §5), không phải web: client khai
 *     `requiresApproval: false` cũng vô ích — DB đọc lại before/after rồi tự quyết.
 *     Vì vậy ở đây KHÔNG gửi và KHÔNG kiểm tra ngưỡng; web chỉ nói lại lời DB.
 *   • Web chạy bằng ANON client + cookie phiên (RLS + `iam.can_write_seller_account`
 *     quyết định quyền) — KHÔNG dùng service_role.
 *
 * Dùng bởi server action ở `web/src/app/(app)/ppc/actions.ts`.
 */

import { createClient } from "@/lib/supabase/server";

export type WriteResult<T = Record<string, unknown>> =
  | ({ ok: true; message: string } & T)
  | { ok: false; message: string };

export type AdsChangeAction =
  | "set_budget"
  | "set_bid"
  | "set_state"
  | "add_negative_exact"
  | "add_negative_phrase";

export type AdsChangeEntityType = "campaign" | "keyword" | "search_term";

export type AdsChangeRequestInput = {
  sellerAccountId: string;
  action: AdsChangeAction;
  entityType: AdsChangeEntityType;
  entityKey: string;
  campaignId?: string | null;
  adGroupId?: string | null;
  /** Giá trị mới: số (budget/bid) · "ENABLED"/"PAUSED" · chữ của search term. */
  value: string | number;
  label?: string | null;
  reason?: string | null;
  suggestionId?: string | null;
  adsProfileId?: string | null;
};

export type AdsChangeRowOut = {
  changeId: string;
  status: string;
  requiresApproval: boolean;
  approvalReason: string | null;
  beforeText: string | null;
  afterText: string | null;
  currency: string | null;
};

export type AdsSuggestionOut = {
  suggestionId: string;
  status: string;
  changeId: string | null;
  message: string;
};

/** SQLSTATE → câu tiếng Việt. Trigger/RPC nói lý do, web chỉ dịch cho dễ đọc. */
function friendlyError(error: { message: string; code?: string | null }): string {
  const raw = error.message ?? "";
  if (raw.includes("CURRENT_USER") || raw.includes("permission denied")) {
    return "Bạn không có quyền ghi cho shop này (RLS chặn).";
  }
  switch (error.code) {
    case "42501":
      return raw.replace(/^\[M5P3\]\s*/, "");
    case "23505":
      return raw.replace(/^\[M5P3\]\s*/, "");
    case "P0002":
      return raw.replace(/^\[M5P3\]\s*/, "");
    case "22023":
      return raw.replace(/^\[M5P3\]\s*/, "");
    default:
      return `Không thực hiện được: ${raw}`;
  }
}

function jsonValue(value: unknown): string | null {
  const v = (value as { value?: unknown } | null)?.value;
  return v === null || v === undefined ? null : String(v);
}

/**
 * Tạo yêu cầu thay đổi. DB trả về ngay trạng thái thật:
 *   • `approved`        → không vượt ngưỡng (hoặc người yêu cầu chính là trưởng phòng)
 *   • `pending_approval`→ > 30%/ngày: chờ trưởng phòng PPC duyệt TRƯỚC khi gửi Amazon
 */
export async function requestAdsChange(
  input: AdsChangeRequestInput,
): Promise<WriteResult<{ change: AdsChangeRowOut }>> {
  if (!input.sellerAccountId) return { ok: false, message: "Thiếu sellerAccountId." };
  if (!input.entityKey) return { ok: false, message: "Thiếu đối tượng cần sửa (entityKey)." };
  const value = String(input.value ?? "").trim();
  if (value === "") return { ok: false, message: "Chưa nhập giá trị mới." };

  const client = await createClient();
  if (!client) return { ok: false, message: "Chưa cấu hình Supabase." };

  const payload = {
    action: input.action,
    entityType: input.entityType,
    entityKey: input.entityKey,
    campaignId: input.campaignId ?? null,
    adGroupId: input.adGroupId ?? null,
    value,
    label: input.label ?? null,
    reason: input.reason ?? null,
    suggestionId: input.suggestionId ?? null,
    adsProfileId: input.adsProfileId ?? null,
  };

  const { data, error } = await client.rpc("vexim_request_ads_change", {
    p_seller: input.sellerAccountId,
    p_req: payload,
  });
  if (error) return { ok: false, message: friendlyError(error) };

  const row = (Array.isArray(data) ? data[0] : undefined) as
    | {
        change_id: string;
        status: string;
        requires_approval: boolean;
        approval_reason: string | null;
        before_value: unknown;
        after_value: unknown;
        currency: string | null;
      }
    | undefined;
  if (!row?.change_id) return { ok: false, message: "RPC không trả về yêu cầu vừa tạo." };

  const change: AdsChangeRowOut = {
    changeId: row.change_id,
    status: row.status,
    requiresApproval: row.requires_approval === true,
    approvalReason: row.approval_reason,
    beforeText: jsonValue(row.before_value),
    afterText: jsonValue(row.after_value),
    currency: row.currency ?? null,
  };

  return {
    ok: true,
    change,
    message:
      change.status === "pending_approval"
        ? `Đã gửi duyệt: ${change.approvalReason ?? "vượt ngưỡng 30%/ngày"}. Yêu cầu CHƯA được gửi lên Amazon.`
        : "Đã duyệt tự động (không vượt ngưỡng 30%/ngày) — worker sẽ gửi Amazon trong lần chạy tới.",
  };
}

/** Trưởng phòng PPC duyệt/từ chối — RPC kiểm `iam.is_ads_approver()`. */
export async function decideAdsChange(input: {
  changeId: string;
  decision: "approve" | "reject";
  note?: string | null;
}): Promise<WriteResult<{ status: string }>> {
  const client = await createClient();
  if (!client) return { ok: false, message: "Chưa cấu hình Supabase." };

  const { data, error } = await client.rpc("vexim_decide_ads_change", {
    p_change_id: input.changeId,
    p_decision: input.decision,
    p_note: input.note ?? null,
  });
  if (error) return { ok: false, message: friendlyError(error) };
  const row = (Array.isArray(data) ? data[0] : undefined) as { status: string } | undefined;
  return {
    ok: true,
    status: row?.status ?? "",
    message:
      input.decision === "approve"
        ? "Đã duyệt — worker sẽ gửi lên Amazon trong lần chạy tới."
        : "Đã từ chối — không có gì được gửi lên Amazon.",
  };
}

/** Người yêu cầu tự huỷ khi chưa gửi. */
export async function cancelAdsChange(input: {
  changeId: string;
  note?: string | null;
}): Promise<WriteResult<{ status: string }>> {
  const client = await createClient();
  if (!client) return { ok: false, message: "Chưa cấu hình Supabase." };
  const { data, error } = await client.rpc("vexim_cancel_ads_change", {
    p_change_id: input.changeId,
    p_note: input.note ?? null,
  });
  if (error) return { ok: false, message: friendlyError(error) };
  const row = (Array.isArray(data) ? data[0] : undefined) as { status: string } | undefined;
  return { ok: true, status: row?.status ?? "cancelled", message: "Đã huỷ yêu cầu." };
}

/**
 * REVERT 1 CHẠM (Ops): đảo một thay đổi ĐÃ áp dụng — tạo yêu cầu MỚI đi ngược
 * lại (không sửa dòng cũ ⇒ lịch sử còn nguyên). Negative keyword không revert
 * qua API được (phải xoá trên console Amazon) — DB từ chối và nói rõ.
 */
export async function revertAdsChange(input: {
  changeId: string;
  note?: string | null;
}): Promise<WriteResult<{ change: AdsChangeRowOut }>> {
  const client = await createClient();
  if (!client) return { ok: false, message: "Chưa cấu hình Supabase." };
  const { data, error } = await client.rpc("vexim_revert_ads_change", {
    p_change_id: input.changeId,
    p_note: input.note ?? null,
  });
  if (error) return { ok: false, message: friendlyError(error) };

  const row = (Array.isArray(data) ? data[0] : undefined) as
    | {
        change_id: string;
        status: string;
        requires_approval: boolean;
        approval_reason: string | null;
        before_value: unknown;
        after_value: unknown;
      }
    | undefined;
  if (!row?.change_id) return { ok: false, message: "RPC không trả về yêu cầu đảo." };

  const change: AdsChangeRowOut = {
    changeId: row.change_id,
    status: row.status,
    requiresApproval: row.requires_approval === true,
    approvalReason: row.approval_reason,
    beforeText: jsonValue(row.before_value),
    afterText: jsonValue(row.after_value),
    currency: null,
  };
  return {
    ok: true,
    change,
    message:
      change.status === "pending_approval"
        ? `Đảo ngược cũng vượt ngưỡng ⇒ chờ duyệt: ${change.approvalReason ?? ""}`.trim()
        : "Đã tạo yêu cầu đảo ngược — worker sẽ gửi Amazon trong lần chạy tới.",
  };
}

/**
 * Duyệt gợi ý A3 (SOP-04): duyệt ⇒ RPC tự sinh yêu cầu thêm negative và đẩy vào
 * cùng một đường ghi (hàng đợi → worker → Amazon → audit).
 */
export async function decideAdsSuggestion(input: {
  suggestionId: string;
  decision: "approve" | "reject" | "dismiss";
  note?: string | null;
}): Promise<WriteResult<AdsSuggestionOut>> {
  const client = await createClient();
  if (!client) return { ok: false, message: "Chưa cấu hình Supabase." };
  const { data, error } = await client.rpc("vexim_decide_ads_suggestion", {
    p_suggestion_id: input.suggestionId,
    p_decision: input.decision,
    p_note: input.note ?? null,
  });
  if (error) return { ok: false, message: friendlyError(error) };
  const row = (Array.isArray(data) ? data[0] : undefined) as
    | { suggestion_id: string; status: string; change_id: string | null; message: string }
    | undefined;
  if (!row?.suggestion_id) return { ok: false, message: "RPC không trả về kết quả." };
  return {
    ok: true,
    suggestionId: row.suggestion_id,
    status: row.status,
    changeId: row.change_id ?? null,
    message: row.message ?? "Đã ghi nhận quyết định.",
  };
}
