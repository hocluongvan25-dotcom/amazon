import { createClient } from "@/lib/supabase/server";
import { readAll, sortIssues, type HealthSnapshot, type HealthIssue } from "./health-model";

/** Session-scoped anon client only; underlying table RLS remains authoritative. */
export async function getLiveHealth() {
  try {
    const db = await createClient();
    if (!db) throw new Error("Supabase not configured");
    const [snapshots, issues] = await Promise.all([
      readAll<HealthSnapshot>((from, to) => db.from("vexim_shop_health")
        .select("seller_account_id,marketplace_id,shop,day,captured_at,account_status,tone,score,rates")
        .order("seller_account_id").order("marketplace_id").range(from, to)),
      readAll<HealthIssue>((from, to) => db.from("vexim_health_issues")
        .select("id,seller_account_id,marketplace_id,shop,label,severity,defects_count,status,reporting_from,case_id,owner_id")
        .order("id").range(from, to)),
    ]);
    return { ok: true as const, snapshots, issues: sortIssues(issues) };
  } catch {
    // Never expose raw database errors or fall back to demo data.
    return { ok: false as const };
  }
}
