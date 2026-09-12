/** Read contract for the security-invoker views in migration 0010. */
export type HealthSnapshot = {
  seller_account_id: string; marketplace_id: string; shop: string;
  day: string; captured_at: string; account_status: string | null;
  tone: string | null; score: number | null; rates: unknown;
};
export type HealthIssue = {
  id: string; seller_account_id: string; marketplace_id: string; shop: string;
  label: string; severity: string; defects_count: number; status: string | null;
  reporting_from: string | null; case_id: string | null; owner_id: string | null;
};
export function rateText(rates: unknown, key: string): string {
  if (!Array.isArray(rates)) return "—";
  const value = rates.find(r => r && r.key === key)?.rate;
  return typeof value === "number" && Number.isFinite(value) ? `${value}%` : "—";
}
export function healthTone(tone: string | null): "red" | "amber" | "green" | "gray" {
  return tone === "red" || tone === "amber" || tone === "green" ? tone : "gray";
}
export function sortIssues(rows: HealthIssue[]): HealthIssue[] {
  const rank: Record<string, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  return [...rows].sort((a, b) => (rank[a.severity] ?? 4) - (rank[b.severity] ?? 4) || a.id.localeCompare(b.id));
}
export type PageResult = { data: unknown[] | null; error: unknown };
/** Fetch every page: PostgREST's default row cap must not silently alter KPIs. */
export async function readAll<T>(read: (from: number, to: number) => PromiseLike<PageResult>): Promise<T[]> {
  const rows: T[] = [];
  const size = 500;
  for (let from = 0; ; from += size) {
    const result = await read(from, from + size - 1);
    if (result.error || !result.data) throw new Error("Health data unavailable");
    rows.push(...result.data as T[]);
    if (result.data.length < size) return rows;
  }
}
