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
/**
 * Dịch mã lỗi Supabase/PostgREST hay gặp thành hướng xử lý cụ thể — màn hình
 * lỗi phải CHẨN ĐOÁN được, không chỉ nói "không tải được".
 */
export function healthErrorHint(message: string): string {
  if (/PGRST205|Could not find the table|does not exist/i.test(message)) {
    return "View public.vexim_shop_health / vexim_health_issues chưa tồn tại trên DB này — chạy `supabase db push` (migration 0010/0011), sau đó Settings → API → Reload schema cache.";
  }
  if (/42501|permission denied/i.test(message)) {
    return "Permission denied có 2 nguyên nhân: (1) phiên đăng nhập hết hạn → request chạy dưới role anon (view chỉ GRANT cho authenticated) — thử đăng xuất/đăng nhập lại trước; (2) role authenticated thật sự thiếu GRANT trên view/bảng gốc account_health.* — chạy lại migration 0010 (phần GRANT).";
  }
  if (/JWT|jwt|token|not authenticated|AuthSession/i.test(message)) {
    return "Phiên đăng nhập không hợp lệ/hết hạn — đăng xuất rồi đăng nhập lại.";
  }
  if (/Supabase not configured/i.test(message)) {
    return "Thiếu biến NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY trên môi trường deploy.";
  }
  if (/fetch failed|network|ECONNREFUSED|ETIMEDOUT/i.test(message)) {
    return "Không kết nối được tới Supabase (mạng/DNS/project tạm dừng) — kiểm tra trạng thái project trên dashboard Supabase.";
  }
  return "Xem mã lỗi ở trên; nếu là PGRST3xx hãy kiểm tra Exposed schemas, còn lại kiểm tra RLS/GRANT của migration 0010.";
}

export type PageResult = { data: unknown[] | null; error: unknown };
/** Fetch every page: PostgREST's default row cap must not silently alter KPIs. */
export async function readAll<T>(read: (from: number, to: number) => PromiseLike<PageResult>): Promise<T[]> {
  const rows: T[] = [];
  const size = 500;
  for (let from = 0; ; from += size) {
    const result = await read(from, from + size - 1);
    if (result.error || !result.data) {
      // Giữ nguyên mã lỗi + message của Supabase — nuốt lỗi ở đây thì màn hình
      // chỉ nói được "không tải được" và không ai chẩn đoán từ xa được.
      const e = result.error as { code?: string; message?: string } | null;
      const detail = e ? [e.code, e.message].filter(Boolean).join(" · ") : "no data";
      throw new Error(`Health data unavailable (${detail || "unknown"})`);
    }
    rows.push(...result.data as T[]);
    if (result.data.length < size) return rows;
  }
}
