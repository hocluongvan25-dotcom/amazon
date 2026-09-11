/**
 * Adapter tầng dữ liệu — đúng kiến trúc đã chốt (Mock → Sandbox → Production):
 *
 *   MockProvider       chạy DEMO MODE hôm nay (không cần Supabase/Amazon)
 *   SupabaseProvider   đọc bảng thật khi có project Supabase + dữ liệu đồng bộ
 *   (AmazonProvider    nằm ở worker — không nằm trong web app)
 *
 * Hiện tại: mọi trang đọc trực tiếp từ lib/data/mock.ts (MockProvider).
 * Khi Supabase sẵn sàng, các trang đổi nguồn qua interface này mà không sửa UI.
 */

export type DataSource = "mock" | "sandbox" | "production";

export interface DataProvider {
  readonly source: DataSource;
  // TODO (Tier 3): getKpiDaily, getAlerts, getSyncJobs, ... đọc từ Supabase
}

export const mockProvider: DataProvider = { source: "mock" };

export function getProvider(): DataProvider {
  // TODO: khi NEXT_PUBLIC_SUPABASE_URL + dữ liệu đồng bộ sẵn sàng:
  // return supabaseProvider (đọc Postgres qua RLS)
  return mockProvider;
}
