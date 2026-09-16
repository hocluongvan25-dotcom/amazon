/**
 * Module 8 G7 — đọc lịch sử BSR (engine mùa vụ) + chi tiêu credits tháng.
 * Supabase: view vexim_research_bsr_history / vexim_research_credit_monthly
 * (RLS theo org). Demo: MockKeepaProvider sinh chuỗi tất định để trình diễn
 * engine, gắn rõ nhãn dữ liệu mô phỏng.
 */

import { getKeepaProvider, MockKeepaProvider } from "@/lib/intelligence/keepa";
import type { BsrPoint } from "@/lib/research/domain";
import { createClient } from "@/lib/supabase/server";
import type { CompetitorRowView } from "./research";

export type BsrHistoryData = {
  mode: "demo" | "supabase";
  points: BsrPoint[];
  /** số ASIN có ít nhất 1 điểm */
  asinCount: number;
  /** số điểm trung bình mỗi ASIN (để biết độ dày lịch sử) */
  pointsPerAsin: number;
  keepaConfigured: boolean;
};

export async function readBsrHistory(
  assessmentId: string,
  competitors: CompetitorRowView[],
): Promise<BsrHistoryData> {
  const keepa = getKeepaProvider();

  if (assessmentId.startsWith("demo-")) {
    const topAsins = competitors
      .filter((c) => !c.is_sponsored)
      .slice(0, 6)
      .map((c) => c.asin);
    const asins = topAsins.length
      ? topAsins
      : ["B0MOCK001", "B0MOCK002", "B0MOCK003"];
    const { points } = await new MockKeepaProvider().fetchBsrHistory({
      asins,
      sinceDays: 365,
    });
    return {
      mode: "demo",
      points,
      asinCount: asins.length,
      pointsPerAsin: Math.round(points.length / asins.length),
      keepaConfigured: false,
    };
  }

  const db = await createClient();
  if (!db) {
    return { mode: "demo", points: [], asinCount: 0, pointsPerAsin: 0, keepaConfigured: keepa.configured };
  }
  const { data, error } = await db
    .from("vexim_research_bsr_history")
    .select("asin,observed_at,bsr_rank,source")
    .eq("assessment_id", assessmentId)
    .order("observed_at", { ascending: true });
  if (error) throw new Error(`Không đọc được lịch sử BSR — ${error.message}`);

  const points: BsrPoint[] = ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    asin: String(r.asin),
    observedAt: String(r.observed_at),
    bsrRank: r.bsr_rank === null || r.bsr_rank === undefined ? null : Number(r.bsr_rank),
    source: String(r.source) as BsrPoint["source"],
  }));
  const asins = new Set(points.map((p) => p.asin));
  return {
    mode: "supabase",
    points,
    asinCount: asins.size,
    pointsPerAsin: asins.size ? Math.round(points.length / asins.size) : 0,
    keepaConfigured: keepa.configured,
  };
}

export type CreditMonthRow = {
  orgId: string;
  orgName: string;
  month: string;
  creditsSpent: number;
  runsCount: number;
  lastSpendAt: string | null;
};

/** Tổng hợp credits tháng của các org mà phiên nhìn thấy được (RLS). */
export async function readCreditMonth(month?: string): Promise<CreditMonthRow[]> {
  const db = await createClient();
  if (!db) return [];
  let q = db
    .from("vexim_research_credit_monthly")
    .select("org_id,org_name,month,credits_spent,runs_count,last_spend_at")
    .order("credits_spent", { ascending: false });
  if (month) q = q.eq("month", month);
  const { data, error } = await q;
  if (error) throw new Error(`Không đọc được sổ cái credits — ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    orgId: String(r.org_id),
    orgName: String(r.org_name ?? ""),
    month: String(r.month),
    creditsSpent: Number(r.credits_spent ?? 0),
    runsCount: Number(r.runs_count ?? 0),
    lastSpendAt: r.last_spend_at ? String(r.last_spend_at) : null,
  }));
}
