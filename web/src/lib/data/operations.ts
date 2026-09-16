import { createClient } from "@/lib/supabase/server";
import { readAll } from "./health-model";
import { screens, type Screen, type DataRow } from "./operations-model";

/** Only explicit public-view projections. User cookie + anon key; never service_role. */
export async function readOperations(
  screen: Screen,
  filter?: {
    column: "id" | "order_id" | "settlement_id";
    value: string;
    sellerAccountId?: string;
  },
  /** PHẠM VI SHOP (bộ chọn trên Topbar). `null`/bỏ trống = tất cả shop. */
  shopId?: string | null,
) {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  const spec = screens[screen];
  return readAll<DataRow>((from, to) => {
    let query = client.from(spec.view).select(spec.select).order("id");
    if (filter) {
      query = query.eq(filter.column, filter.value);
      if (filter.sellerAccountId)
        query = query.eq("seller_account_id", filter.sellerAccountId);
    }
    // Lọc NGAY Ở DB chứ không lọc sau khi tải: view có RLS, thêm `eq` chỉ thu hẹp
    // phạm vi đọc — nhưng cũng để số dòng/tổng tiền trên bảng đúng phạm vi đã chọn.
    if (shopId) query = query.eq("seller_account_id", shopId);
    return query.range(from, to);
  });
}
