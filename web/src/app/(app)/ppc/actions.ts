"use server";

/**
 * Server Action của Module 5 PHẦN 2 & 3 — mọi nút "ghi" trên màn PPC đi qua đây.
 *
 * NGUYÊN TẮC:
 *   • Web KHÔNG gọi service_role và KHÔNG tự quyết định ngưỡng duyệt: RPC của
 *     migration 0021 (security definer) kiểm quyền + tính lại ngưỡng > 30%/ngày
 *     từ before/after trong DB. Web chỉ hiển thị lại lời DB.
 *   • Không có action nào gửi thẳng lên Amazon: tất cả đi vào hàng đợi
 *     `ads.change_requests` rồi worker (`worker:ads-apply` / cron 03:00) mới gửi.
 *   • Không có action "duyệt thay người khác": RPC từ chối nếu người gọi không
 *     phải trưởng phòng PPC (iam.is_ads_approver()).
 */

import { revalidatePath } from "next/cache";

import {
  cancelAdsChange,
  decideAdsChange,
  decideAdsSuggestion,
  requestAdsChange,
  revertAdsChange,
  type AdsChangeAction,
  type AdsChangeEntityType,
} from "@/lib/data/ppc-write";

export type ActionState = { ok: boolean; message: string };

const CHANGED_PATHS = ["/ppc", "/ppc/approvals", "/ppc/search-terms"];

function revalidateAll(extra?: string) {
  for (const p of CHANGED_PATHS) revalidatePath(p);
  if (extra) revalidatePath(extra);
}

const ACTIONS = new Set<AdsChangeAction>([
  "set_budget",
  "set_bid",
  "set_state",
  "add_negative_exact",
  "add_negative_phrase",
]);
const ENTITIES = new Set<AdsChangeEntityType>(["campaign", "keyword", "search_term"]);

function str(form: FormData, key: string): string {
  return String(form.get(key) ?? "").trim();
}

/** Nút "Đổi ngân sách / Đổi bid / Bật-tạm dừng / Thêm negative" ở A2 và A3. */
export async function submitAdsChangeAction(form: FormData): Promise<ActionState> {
  const action = str(form, "action") as AdsChangeAction;
  const entityType = str(form, "entityType") as AdsChangeEntityType;
  if (!ACTIONS.has(action)) return { ok: false, message: `Hành động không hợp lệ: ${action || "(rỗng)"}` };
  if (!ENTITIES.has(entityType)) return { ok: false, message: `Đối tượng không hợp lệ: ${entityType || "(rỗng)"}` };

  const result = await requestAdsChange({
    sellerAccountId: str(form, "sellerAccountId"),
    action,
    entityType,
    entityKey: str(form, "entityKey"),
    campaignId: str(form, "campaignId") || null,
    adGroupId: str(form, "adGroupId") || null,
    value: str(form, "value"),
    label: str(form, "label") || null,
    reason: str(form, "reason") || null,
    suggestionId: str(form, "suggestionId") || null,
    adsProfileId: str(form, "adsProfileId") || null,
  });

  if (!result.ok) return { ok: false, message: result.message };
  revalidateAll(str(form, "campaignId") ? `/ppc/campaigns/${str(form, "campaignId")}` : undefined);
  return { ok: true, message: result.message };
}

/** Trưởng phòng PPC duyệt / từ chối (SOP-05 bước 4). */
export async function decideAdsChangeAction(form: FormData): Promise<ActionState> {
  const changeId = str(form, "changeId");
  const decision = str(form, "decision") === "reject" ? "reject" : "approve";
  if (!changeId) return { ok: false, message: "Thiếu changeId." };
  const result = await decideAdsChange({ changeId, decision, note: str(form, "note") || null });
  if (!result.ok) return { ok: false, message: result.message };
  revalidateAll();
  return { ok: true, message: result.message };
}

/** Người yêu cầu tự huỷ yêu cầu chưa gửi. */
export async function cancelAdsChangeAction(form: FormData): Promise<ActionState> {
  const changeId = str(form, "changeId");
  if (!changeId) return { ok: false, message: "Thiếu changeId." };
  const result = await cancelAdsChange({ changeId, note: str(form, "note") || null });
  if (!result.ok) return { ok: false, message: result.message };
  revalidateAll();
  return { ok: true, message: result.message };
}

/** REVERT 1 chạm cho Ops — đảo một thay đổi Amazon ĐÃ nhận. */
export async function revertAdsChangeAction(form: FormData): Promise<ActionState> {
  const changeId = str(form, "changeId");
  if (!changeId) return { ok: false, message: "Thiếu changeId." };
  const result = await revertAdsChange({ changeId, note: str(form, "note") || null });
  if (!result.ok) return { ok: false, message: result.message };
  revalidateAll();
  return { ok: true, message: result.message };
}

/** Duyệt / từ chối / bỏ qua gợi ý negative của A3 (SOP-04). */
export async function decideSuggestionAction(form: FormData): Promise<ActionState> {
  const suggestionId = str(form, "suggestionId");
  const raw = str(form, "decision");
  const decision = raw === "reject" ? "reject" : raw === "dismiss" ? "dismiss" : "approve";
  if (!suggestionId) return { ok: false, message: "Thiếu suggestionId." };
  const result = await decideAdsSuggestion({ suggestionId, decision, note: str(form, "note") || null });
  if (!result.ok) return { ok: false, message: result.message };
  revalidateAll();
  return { ok: true, message: result.message };
}
