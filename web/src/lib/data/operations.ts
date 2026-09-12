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
    return query.range(from, to);
  });
}
