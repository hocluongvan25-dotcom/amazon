/**
 * Supabase reader cho Module 5 PHẦN 2&3 (chiều GHI PPC) — migration 0021.
 *
 *   • vexim_ppc_policies          guardrail hiệu lực + trạng thái hàng đợi
 *   • vexim_ppc_change_requests   hàng đợi: chờ duyệt / đã duyệt / kết quả
 *   • vexim_ppc_suggestions       gợi ý sinh TỪ SỐ LIỆU (không ghi gì)
 *   • vexim_ads_negative_keywords từ khoá phủ định đang có hiệu lực
 *
 * Cả 4 view đều `security_invoker = true` và bảng gốc có RLS theo
 * `iam.can_read_seller_account` → đọc bằng CLIENT PHIÊN, mỗi người chỉ thấy shop
 * mình được gán. `can_decide` / `can_edit_policy` cũng do DB tính (web không tự
 * suy quyền) nên nút Duyệt chỉ hiện với người DB cho phép.
 *
 * Trang /ppc không được sập vì một view lỗi: mỗi nguồn đọc trong `guard()`, lỗi
 * nào thì ghi vào `partialErrors` và hiện nguyên văn lý do.
 */
import { createClient } from "@/lib/supabase/server";
import { adsWriteEnabled } from "@/lib/ads/config.ts";
import { readAll } from "./inventory-model.ts";
import {
  PPC_NEGATIVE_SELECT,
  PPC_POLICY_SELECT,
  PPC_REQUEST_SELECT,
  PPC_SUGGESTION_SELECT,
  mapPpcNegative,
  mapPpcPolicy,
  mapPpcRequest,
  mapPpcSuggestion,
  type PpcNegative,
  type PpcNegativeDbRow,
  type PpcPolicy,
  type PpcPolicyDbRow,
  type PpcRequest,
  type PpcRequestDbRow,
  type PpcSuggestion,
  type PpcSuggestionDbRow,
} from "./ppc-write-model.ts";

/** View của 0021 chưa có → nói thẳng phải chạy migration nào. */
function explain(view: string, error: { message: string; code?: string | null }): Error {
  const missing = /could not find|does not exist|42P01|PGRST205/i.test(error.message);
  return new Error(
    missing
      ? `Chưa có view ${view} — cần chạy migration 0021 (Module 5 PPC phần ghi: hàng đợi thay đổi + guardrail).`
      : `Không đọc được ${view}: ${error.message}`,
  );
}

async function clientOrThrow() {
  const client = await createClient();
  if (!client) throw new Error("Chưa cấu hình Supabase");
  return client;
}

/* ------------------------------------------------------------------ */
/* Guardrail (policy)                                                  */
/* ------------------------------------------------------------------ */

export async function readPpcPolicyRows(shopId?: string): Promise<PpcPolicyDbRow[]> {
  const client = await clientOrThrow();
  let q = client.from("vexim_ppc_policies").select(PPC_POLICY_SELECT);
  if (shopId) q = q.eq("seller_account_id", shopId);
  const { data, error } = await q.order("shop", { ascending: true }).limit(200);
  if (error) throw explain("vexim_ppc_policies", error);
  return (data ?? []) as unknown as PpcPolicyDbRow[];
}

export async function readPpcPolicies(shopId?: string): Promise<PpcPolicy[] | null> {
  const client = await createClient();
  if (!client) return null;
  const raw = await readPpcPolicyRows(shopId);
  return raw.map(mapPpcPolicy);
}

/* ------------------------------------------------------------------ */
/* Hàng đợi thay đổi                                                   */
/* ------------------------------------------------------------------ */

export type PpcRequestFilter = {
  shopId?: string;
  /** lọc theo trạng thái; mặc định đọc mọi trạng thái (UI tự chia nhóm) */
  statuses?: string[];
  limit?: number;
};

export async function readPpcRequestRows(filter: PpcRequestFilter = {}): Promise<PpcRequestDbRow[]> {
  const client = await clientOrThrow();
  const limit = filter.limit ?? 400;
  if (filter.statuses && filter.statuses.length > 0) {
    // Builder PostgREST là MUTABLE: dựng query mới cho từng trang.
    const rows = await readAll<PpcRequestDbRow>((from, to) => {
      let q = client
        .from("vexim_ppc_change_requests")
        .select(PPC_REQUEST_SELECT)
        .in("status", filter.statuses as string[]);
      if (filter.shopId) q = q.eq("seller_account_id", filter.shopId);
      return q
        .order("is_open", { ascending: false })
        .order("proposed_at", { ascending: false })
        .range(from, Math.min(to, from + (limit - from) - 1));
    });
    return rows.slice(0, limit);
  }
  const rows = await readAll<PpcRequestDbRow>((from, to) => {
    let q = client.from("vexim_ppc_change_requests").select(PPC_REQUEST_SELECT);
    if (filter.shopId) q = q.eq("seller_account_id", filter.shopId);
    return q
      .order("is_open", { ascending: false })
      .order("proposed_at", { ascending: false })
      .range(from, Math.min(to, from + (limit - from) - 1));
  });
  return rows.slice(0, limit);
}

export async function readPpcRequests(filter: PpcRequestFilter = {}): Promise<PpcRequest[]> {
  const raw = await readPpcRequestRows(filter);
  return raw.map(mapPpcRequest);
}

/* ------------------------------------------------------------------ */
/* Gợi ý từ số liệu                                                    */
/* ------------------------------------------------------------------ */

export type PpcSuggestionFilter = {
  shopId?: string;
  /** chỉ lấy loại gợi ý này (negative_keyword / lower_bid / …) */
  kind?: string;
  /** true = chỉ dòng CHƯA có đề xuất mở (mặc định: lấy hết, UI tự làm mờ) */
  actionableOnly?: boolean;
  limit?: number;
};

export async function readPpcSuggestionRows(filter: PpcSuggestionFilter = {}): Promise<PpcSuggestionDbRow[]> {
  const client = await clientOrThrow();
  let q = client.from("vexim_ppc_suggestions").select(PPC_SUGGESTION_SELECT);
  if (filter.shopId) q = q.eq("seller_account_id", filter.shopId);
  if (filter.kind) q = q.eq("kind", filter.kind);
  if (filter.actionableOnly) q = q.eq("has_open_request", false);
  // priority 1 trước, rồi tới tiền đang đốt — việc đáng làm nhất luôn ở trang đầu.
  q = q
    .order("priority", { ascending: true })
    .order("waste7", { ascending: false, nullsFirst: false })
    .order("spend7", { ascending: false, nullsFirst: false });
  const { data, error } = await q.limit(filter.limit ?? 200);
  if (error) throw explain("vexim_ppc_suggestions", error);
  return (data ?? []) as unknown as PpcSuggestionDbRow[];
}

export async function readPpcSuggestions(filter: PpcSuggestionFilter = {}): Promise<PpcSuggestion[]> {
  const raw = await readPpcSuggestionRows(filter);
  return raw.map(mapPpcSuggestion);
}

/* ------------------------------------------------------------------ */
/* Từ khoá phủ định                                                    */
/* ------------------------------------------------------------------ */

export async function readPpcNegativeRows(shopId?: string, limit = 200): Promise<PpcNegativeDbRow[]> {
  const client = await clientOrThrow();
  let q = client.from("vexim_ads_negative_keywords").select(PPC_NEGATIVE_SELECT);
  if (shopId) q = q.eq("seller_account_id", shopId);
  const { data, error } = await q
    .order("last_synced_at", { ascending: false, nullsFirst: true })
    .order("keyword_text", { ascending: true })
    .limit(limit);
  if (error) throw explain("vexim_ads_negative_keywords", error);
  return (data ?? []) as unknown as PpcNegativeDbRow[];
}

export async function readPpcNegatives(shopId?: string, limit = 200): Promise<PpcNegative[]> {
  const raw = await readPpcNegativeRows(shopId, limit);
  return raw.map(mapPpcNegative);
}

/* ------------------------------------------------------------------ */
/* Gom một lượt đọc cho khối "Thay đổi PPC" của /ppc                   */
/* ------------------------------------------------------------------ */

export type PpcWritePageData = {
  mode: "supabase" | "demo";
  policies: PpcPolicy[];
  requests: PpcRequest[];
  suggestions: PpcSuggestion[];
  negatives: PpcNegative[];
  /** ADS_WRITE_ENABLED — cron có được phép gọi Amazon hay không (chỉ đọc ở server) */
  writeEnabled: boolean;
  /** Lỗi từng phần: một view hỏng không được làm sập cả trang. */
  partialErrors: string[];
};

export async function readPpcWritePageData(shopId?: string): Promise<PpcWritePageData> {
  const writeEnabled = adsWriteEnabled(process.env);
  const client = await createClient();
  if (!client) {
    return { mode: "demo", policies: [], requests: [], suggestions: [], negatives: [], writeEnabled, partialErrors: [] };
  }

  const partialErrors: string[] = [];
  const guard = async <T>(label: string, run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      partialErrors.push(e instanceof Error ? e.message : `${label}: lỗi không rõ`);
      return fallback;
    }
  };

  const [policies, requests, suggestions, negatives] = await Promise.all([
    guard("Guardrail PPC", () => readPpcPolicies(shopId).then((v) => v ?? []), [] as PpcPolicy[]),
    guard("Hàng đợi thay đổi", () => readPpcRequests({ shopId, limit: 400 }), [] as PpcRequest[]),
    guard("Gợi ý PPC", () => readPpcSuggestions({ shopId, limit: 200 }), [] as PpcSuggestion[]),
    guard("Từ khoá phủ định", () => readPpcNegatives(shopId, 200), [] as PpcNegative[]),
  ]);

  return { mode: "supabase", policies, requests, suggestions, negatives, writeEnabled, partialErrors };
}
