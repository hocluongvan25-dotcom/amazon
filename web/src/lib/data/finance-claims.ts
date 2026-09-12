/**
 * Supabase reader cho Module 6 Đợt 2 — F3 (bồi hoàn FBA) & F4 (lợi nhuận SKU).
 *
 * Đọc qua view `public.vexim_*` (security_invoker) bằng anon client + RLS —
 * KHÔNG bao giờ dùng service_role ở web app (worker mới ghi).
 * Chưa cấu hình Supabase → hàm trả null để trang rơi về DEMO MODE.
 */

import { createClient } from "@/lib/supabase/server";
import type { ClaimHistoryRow, ClaimRow, SkuProfitDbRow } from "./finance-model";

export const CLAIM_SELECT = [
  "id",
  "seller_account_id",
  "shop",
  "sku",
  "fnsku",
  "asin",
  "category",
  "source",
  "source_ref",
  "source_date",
  "source_reason",
  "quantity",
  "currency",
  "unit_cost",
  "estimated_amount",
  "status",
  "amazon_case_id",
  "filed_at",
  "decided_at",
  "decision_note",
  "reimbursed_amount",
  "reimbursement_id",
  "note",
  "detected_at",
  "updated_at",
  "age_hours",
].join(",");

export const PROFIT_SELECT = [
  "seller_account_id",
  "shop",
  "sku",
  "day",
  "currency",
  "units",
  "revenue",
  "refunds",
  "amazon_fees",
  "promo",
  "cogs",
  "ads_spend",
  "gross_profit",
  "unit_cost",
  "fee_source",
  "computed_at",
].join(",");

export const HISTORY_SELECT = "id,claim_id,stage,from_status,to_status,actor_id,note,created_at";

/**
 * 500 dòng/trang — PostgREST mặc định chặn 1000; đọc theo trang để không cắt
 * im lặng danh sách claim của shop lớn.
 */
async function readAll<T>(
  read: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[]> {
  const rows: T[] = [];
  const size = 500;
  for (let from = 0; ; from += size) {
    const result = await read(from, from + size - 1);
    if (result.error || !result.data) throw new Error("Finance claims data unavailable");
    rows.push(...(result.data as T[]));
    if ((result.data as T[]).length < size) return rows;
  }
}

export async function readReimbursementClaims(sellerAccountId?: string): Promise<ClaimRow[] | null> {
  const client = await createClient();
  if (!client) return null;

  return readAll<ClaimRow>((from, to) => {
    const query = client
      .from("vexim_reimbursement_claims")
      .select(CLAIM_SELECT)
      .order("detected_at", { ascending: false })
      .order("sku")
      .range(from, to);
    return sellerAccountId ? query.eq("seller_account_id", sellerAccountId) : query;
  });
}

export async function readClaimHistory(claimId: string): Promise<ClaimHistoryRow[] | null> {
  const client = await createClient();
  if (!client) return null;

  const { data, error } = await client
    .from("vexim_reimbursement_claim_events")
    .select(HISTORY_SELECT)
    .eq("claim_id", claimId)
    .order("created_at");
  if (error || !data) throw new Error("Claim history unavailable");
  return data as ClaimHistoryRow[];
}

export async function readSkuProfit(
  opts: { sellerAccountId?: string; from?: string; to?: string; sku?: string } = {},
): Promise<SkuProfitDbRow[] | null> {
  const client = await createClient();
  if (!client) return null;

  return readAll<SkuProfitDbRow>((from, to) => {
    let query = client
      .from("vexim_sku_profit")
      .select(PROFIT_SELECT)
      .order("day", { ascending: false })
      .order("sku")
      .range(from, to);
    if (opts.sellerAccountId) query = query.eq("seller_account_id", opts.sellerAccountId);
    if (opts.from) query = query.gte("day", opts.from);
    if (opts.to) query = query.lte("day", opts.to);
    if (opts.sku) query = query.eq("sku", opts.sku);
    return query;
  });
}

/** Khoảng ngày của một tháng "YYYY-MM". */
export function monthRange(month: string, now = new Date()): { from: string; to: string } {
  const value = /^\d{4}-\d{2}$/.test(month) ? month : now.toISOString().slice(0, 7);
  const [year, m] = value.split("-").map(Number);
  const first = new Date(Date.UTC(year, m - 1, 1));
  const last = new Date(Date.UTC(year, m, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}
