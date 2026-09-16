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

import { getAppSession } from "@/lib/auth/session";
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

/** Ai được chạy đồng bộ Ads thủ công — khớp ALLOWED của trang /ppc. */
const ALLOWED_PERSONAS = new Set(["ceo", "op_ppc"]);

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

/* ==========================================================================
 * PHẦN 1 — KÉO DỮ LIỆU VỀ (Module 5 phần 1): nút "Chạy đồng bộ ngay"
 * ==========================================================================
 * Trên Vercel không có shell để chạy `cd worker && npm run worker:ads-sync`, nên người vận
 * hành cần một nút chạy ĐÚNG 2 job của cron (sync cấu trúc → kéo 5 report Ads)
 * và đọc được kết quả thật (kể cả lỗi Amazon trả về).
 *
 * NGUYÊN TẮC:
 *   • Chỉ CEO / trưởng phòng PPC (persona đã được trang cho phép) và chỉ khi
 *     đang ở SUPABASE mode — DEMO mode không gọi Amazon.
 *   • KHÔNG tự chọn DB thật: `runAdsSyncAll`/`runAdsPullAll` chỉ ghi khi
 *     `loadConfig().mode === "production"` (giống cron) — thiếu credential Ads
 *     thì job trả `skipped` kèm hướng dẫn, không ghi gì.
 *   • Trần 60s như cron: 2 lần poll/report, KHÔNG block chờ Amazon tạo xong.
 * ========================================================================== */
import { runAdsPullAll, runAdsSyncAll } from "@/lib/worker";
import { loadConfig } from "@/lib/worker/config.ts";

export type AdsSyncNowState = {
  ok: boolean;
  message: string;
  /** tóm tắt từng bước — hiện thẳng trên UI */
  lines: string[];
  /** nhật ký thô của job (để copy gửi cho dev khi có lỗi lạ) */
  log: string;
};

export async function runAdsSyncNowAction(): Promise<AdsSyncNowState> {
  const session = await getAppSession();
  if (!session) return { ok: false, message: "Chưa đăng nhập.", lines: [], log: "" };
  if (session.mode !== "supabase") {
    return {
      ok: false,
      message: "Đang ở DEMO MODE — không gọi Amazon. Cần Supabase + credential thật.",
      lines: [],
      log: "",
    };
  }
  if (!ALLOWED_PERSONAS.has(session.persona)) {
    return {
      ok: false,
      message: "Chỉ CEO hoặc trưởng phòng PPC được chạy đồng bộ quảng cáo.",
      lines: [],
      log: "",
    };
  }

  let buf = "";
  const stdout = { write: (s: string) => { buf += s; } };
  const lines: string[] = [];

  try {
    const sync = await runAdsSyncAll({ stdout });
    lines.push(
      `Đồng bộ cấu trúc: ${sync.synced} shop xong · ${sync.skipped} bỏ qua · ${sync.failed} lỗi ` +
        `(DB: ${sync.db}, credential Ads: ${sync.apiConfigured ? "có" : "CHƯA CÓ"})`,
    );
    for (const s of sync.shops) {
      lines.push(`· ${s.shop}: ${s.action} — ${s.message}`);
      for (const e of s.errors) lines.push(`   ⚠ ${e}`);
    }

    const pull = await runAdsPullAll({ stdout, pollAttempts: 2, pollDelayMs: 2_000 });
    lines.push(
      `Kéo report: nhập ${pull.imported} · chờ Amazon ${pull.pending} · không có dữ liệu ${pull.noData} · ` +
        `lỗi ${pull.failed} · ${pull.rowsImported} dòng`,
    );
    for (const o of pull.outcomes) {
      if (o.action === "imported" || o.action === "failed" || o.action === "throttled" || o.action === "no_data") {
        lines.push(`· ${o.shop} / ${o.reportTypeId}: ${o.action} — ${o.message}`);
      }
    }
    for (const e of pull.errors) lines.push(`⚠ ${e.kind}: ${e.error}`);

    const cfg = loadConfig();
    const nothingWasConfigured = !cfg.ads;
    const ok = !nothingWasConfigured && (pull.failed === 0 || pull.imported > 0);
    revalidatePath("/ppc");
    return {
      ok,
      message: nothingWasConfigured
        ? "Chưa cấu hình credential Amazon Ads (AMAZON_ADS_CLIENT_ID / _SECRET / _REFRESH_TOKEN) — xem checklist phía trên."
        : pull.imported > 0
          ? `Xong: đã nhập số liệu cho ${pull.imported} report. Tải lại trang để xem KPI.`
          : pull.pending > 0
            ? "Amazon đang tạo report (PENDING) — bấm lại sau 1–2 phút hoặc chờ cron; KHÔNG cần xin lại từ đầu."
            : `Chạy xong nhưng chưa nhập được report nào (${pull.failed} lỗi) — xem chi tiết bên dưới.`,
      lines,
      log: buf.slice(0, 20_000),
    };
  } catch (e) {
    return {
      ok: false,
      message: `Chạy đồng bộ lỗi: ${(e as Error).message.split("\n")[0]}`,
      lines,
      log: buf.slice(0, 20_000),
    };
  }
}
