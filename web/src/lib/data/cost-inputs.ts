/**
 * Supabase reader cho trang GIÁ VỐN `/finance/costs` (Đợt A).
 *
 * Đọc qua view `public.vexim_cost_inputs` / `public.vexim_cost_coverage`
 * (security_invoker) bằng anon client + phiên đăng nhập → RLS/`iam.can_read_seller_account`
 * quyết định ai thấy shop nào. Web KHÔNG bao giờ dùng service_role.
 * Chưa cấu hình Supabase → trả null để trang rơi về DEMO MODE.
 */

import { createClient } from "@/lib/supabase/server";
import type { CostCoverageRow, CostInputRow } from "./cost-model";

export const COST_INPUT_SELECT = [
  "id",
  "seller_account_id",
  "shop",
  "sku",
  "unit_cost",
  "currency",
  "effective_from",
  "effective_to",
  "source",
  "source_ref",
  "note",
  "created_at",
  "updated_at",
  "is_current",
  "is_open_ended",
].join(",");

export const COST_COVERAGE_SELECT = [
  "seller_account_id",
  "shop",
  "sku",
  "asin",
  "title",
  "status",
  "price",
  "currency",
  "unit_cost",
  "cost_currency",
  "cost_effective_from",
  "cost_source",
  "missing_cost",
  "currency_mismatch",
].join(",");

/**
 * PostgREST mặc định chặn 1000 dòng → đọc theo trang 500 để không cắt IM LẶNG
 * danh sách giá vốn của shop lớn (cùng cách finance-claims.ts làm).
 */
async function readAll<T>(
  read: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[]> {
  const rows: T[] = [];
  const size = 500;
  for (let from = 0; ; from += size) {
    const result = await read(from, from + size - 1);
    if (result.error || !result.data) throw new Error("Cost inputs data unavailable");
    rows.push(...(result.data as T[]));
    if ((result.data as T[]).length < size) return rows;
  }
}

/** Mọi bậc giá vốn của các shop người dùng đọc được. */
export async function readCostInputs(sellerAccountId?: string): Promise<CostInputRow[] | null> {
  const client = await createClient();
  if (!client) return null;

  return readAll<CostInputRow>((from, to) => {
    let query = client
      .from("vexim_cost_inputs")
      .select(COST_INPUT_SELECT)
      .order("sku", { ascending: true })
      .order("effective_from", { ascending: false })
      .range(from, to);
    if (sellerAccountId) query = query.eq("seller_account_id", sellerAccountId);
    return query;
  });
}

/**
 * Danh sách shop người dùng đọc được (view `public.vexim_shops`, RLS lọc sẵn).
 *
 * Vì sao cần view riêng: bộ chọn shop KHÔNG được phụ thuộc listing/health đã sync
 * hay chưa — shop mới tinh vẫn phải chọn được để nhập bậc giá vốn đầu tiên.
 */
export async function readShopOptions(): Promise<{ id: string; name: string }[]> {
  const client = await createClient();
  if (!client) return [];

  const { data, error } = await client
    .from("vexim_shops")
    .select("seller_account_id,shop,status,data_source")
    .order("shop");
  if (error || !data) throw new Error("Shop list unavailable");

  return (data as { seller_account_id: string; shop: string; status?: string }[])
    .filter((r) => r.status !== "revoked")
    .map((r) => ({ id: r.seller_account_id, name: r.shop }));
}

/**
 * SKU đang bán so với giá vốn hiệu lực hôm nay.
 * `onlyMissing=true` → đúng danh sách "đang chặn F3/F4/P1", dùng cho panel Gỡ chặn.
 */
export async function readCostCoverage(
  opts: { sellerAccountId?: string; onlyMissing?: boolean } = {},
): Promise<CostCoverageRow[] | null> {
  const client = await createClient();
  if (!client) return null;

  return readAll<CostCoverageRow>((from, to) => {
    let query = client
      .from("vexim_cost_coverage")
      .select(COST_COVERAGE_SELECT)
      .order("shop", { ascending: true })
      .order("sku", { ascending: true })
      .range(from, to);
    if (opts.sellerAccountId) query = query.eq("seller_account_id", opts.sellerAccountId);
    if (opts.onlyMissing) query = query.eq("missing_cost", true);
    return query;
  });
}
