/**
 * Supabase reader cho Module 0 — trạng thái kết nối Amazon (migration 0020).
 *
 *   • vexim_connections   — mỗi shop × service: đã authorize chưa, hạn re-authorize
 *                           365 ngày còn bao lâu, trạng thái token, lỗi cuối cùng
 *   • vexim_oauth_events  — nhật ký luồng kết nối (KHÔNG chứa token)
 *
 * Cả hai view đều SECURITY DEFINER nhưng TỰ LỌC bằng iam.can_read_seller_account,
 * nên user chỉ thấy shop mình được gán; bảng gốc connections.oauth_tokens vẫn cấm
 * tuyệt đối client (không policy SELECT).
 *
 * Đọc bằng client PHIÊN (RLS theo user) — không dùng service role ở tầng UI.
 */
import { createClient } from "@/lib/supabase/server";
import { readAll } from "./inventory-model.ts";
import {
  CONNECTION_SELECT,
  EVENT_SELECT,
  mapConnectionRow,
  mapEventRow,
  type ConnectionRaw,
  type ConnectionUiRow,
  type EventRaw,
  type OAuthEventUiRow,
} from "./connections-model.ts";
import type { OAuthService } from "@/lib/oauth/state.ts";

/** Toàn bộ dòng kết nối user này được phép thấy (shop × service). */
export async function readConnections(): Promise<ConnectionRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  return readAll<ConnectionRaw>((from, to) =>
    client
      .from("vexim_connections")
      .select(CONNECTION_SELECT)
      .order("shop", { ascending: true })
      .order("service", { ascending: true })
      .range(from, to),
  );
}

export async function readConnectionRows(): Promise<ConnectionUiRow[]> {
  const raw = await readConnections();
  return raw.map(mapConnectionRow);
}

/**
 * Nhật ký luồng OAuth mới nhất. `limit` mặc định 40: đủ để truy vết một lần
 * authorize hỏng, không đủ để trang nặng.
 */
export async function readOAuthEvents(limit = 40, shopId?: string): Promise<EventRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");
  let q = client.from("vexim_oauth_events").select(EVENT_SELECT).order("created_at", { ascending: false });
  if (shopId) q = q.eq("seller_account_id", shopId);
  const { data, error } = await q.limit(limit);
  if (error) throw new Error(`Không đọc được nhật ký kết nối: ${error.message}`);
  return (data ?? []) as unknown as EventRaw[];
}

export async function readOAuthEventRows(limit = 40, shopId?: string): Promise<OAuthEventUiRow[]> {
  const raw = await readOAuthEvents(limit, shopId);
  return raw.map(mapEventRow);
}

/**
 * Lọc dòng của MỘT service — dùng khi trang chỉ quan tâm Ads (Module 5) hoặc
 * SP-API (Module 3/4). Shop chưa có token của service đó vẫn GIỮ LẠI (service=null)
 * để UI hiện "chưa kết nối" thay vì biến mất khỏi bảng.
 */
export function rowsForService(rows: ConnectionUiRow[], svc: OAuthService): ConnectionUiRow[] {
  return rows.filter((r) => r.service === null || r.service === svc);
}
