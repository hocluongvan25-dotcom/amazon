/**
 * Đọc TRẠNG THÁI KẾT NỐI SHOP cho màn Module 0 → Kết nối shop (SOP-11).
 *
 *   • vexim_shops               — shop người dùng đọc được (RLS lọc sẵn)
 *   • vexim_oauth_connections   — hạn token / còn mấy ngày / cần re-auth chưa
 *
 * View `vexim_oauth_connections` CỐ Ý không `security_invoker` (bảng token không
 * có policy cho client) nhưng vẫn lọc theo `iam.can_read_seller_account` và KHÔNG
 * chứa cột token — nên đọc ở đây là an toàn.
 *
 * Shop CHƯA từng authorize sẽ không có dòng trong view token ⇒ phải LEFT JOIN
 * bằng tay: nếu chỉ đọc view token thì shop mới hoàn toàn biến mất khỏi màn
 * hình, đúng lúc cần "Kết nối" nhất.
 *
 * FIX UX SOP-11 (09/2026): tách pure helpers sang oauth-shared.ts để client component không kéo next/headers
 */

import { createClient } from "@/lib/supabase/server";
import { readAll } from "./inventory-model";
import type { ConnectShopRow } from "./oauth-shared";
import { MARKETPLACE_META, marketplaceLabel, connectStatusOf, groupBySeller } from "./oauth-shared";

// Re-export để các file cũ vẫn import từ oauth.ts được
export type { ConnectShopRow } from "./oauth-shared";
export { MARKETPLACE_META, marketplaceLabel, connectStatusOf, groupBySeller };

// Cố gắng lấy seller_id và display_name nếu view đã được migrate (0024), fallback về view cũ
const SHOP_SELECT = "seller_account_id,shop,marketplace,status,data_source";
const SHOP_SELECT_V2 = "seller_account_id,shop,marketplace,status,data_source,seller_id,display_name";
const TOKEN_SELECT =
  "seller_account_id,shop,is_active,is_expired,needs_reauth,days_left,expires_at," +
  "authorized_at,notice_days,refresh_count,rotate_reminder_sent,notice_sent_at,ads_profiles";

export async function readConnectShops(): Promise<ConnectShopRow[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");

  let shops: Record<string, unknown>[] = [];
  try {
    shops = await readAll<Record<string, unknown>>((from, to) =>
      client.from("vexim_shops").select(SHOP_SELECT_V2).order("shop").range(from, to),
    );
  } catch {
    shops = await readAll<Record<string, unknown>>((from, to) =>
      client.from("vexim_shops").select(SHOP_SELECT).order("shop").range(from, to),
    );
  }

  let tokens: Record<string, unknown>[] = [];
  try {
    tokens = await readAll<Record<string, unknown>>((from, to) =>
      client.from("vexim_oauth_connections").select(TOKEN_SELECT).range(from, to),
    );
  } catch {
    tokens = [];
  }
  const byId = new Map(tokens.map((t) => [String(t.seller_account_id), t]));

  return shops
    .filter((s) => String(s.status ?? "") !== "revoked")
    .map((s) => {
      const id = String(s.seller_account_id);
      const t = byId.get(id);
      const marketplaceId = String(s.marketplace ?? "");
      const displayName = String((s as any).display_name ?? s.shop ?? id);
      const sellerId = (s as any).seller_id ? String((s as any).seller_id) : null;
      return {
        sellerAccountId: id,
        shop: String(s.shop ?? id),
        marketplace: marketplaceId,
        marketplaceId,
        sellerId,
        displayName,
        dataSource: s.data_source ? String(s.data_source) : null,
        status: s.status ? String(s.status) : null,
        hasToken: t !== undefined,
        isActive: t?.is_active === true,
        isExpired: t?.is_expired === true,
        needsReauth: t?.needs_reauth === true,
        daysLeft: t?.days_left === undefined || t?.days_left === null ? null : Number(t.days_left),
        expiresAt: t?.expires_at ? String(t.expires_at) : null,
        authorizedAt: t?.authorized_at ? String(t.authorized_at) : null,
        noticeDays:
          t?.notice_days === undefined || t?.notice_days === null ? null : Number(t.notice_days),
        refreshCount:
          t?.refresh_count === undefined || t?.refresh_count === null
            ? null
            : Number(t.refresh_count),
        rotateReminderSent: t?.rotate_reminder_sent === true,
        noticeSentAt: t?.notice_sent_at ? String(t.notice_sent_at) : null,
        adsProfiles: t?.ads_profiles === undefined ? 0 : Number(t.ads_profiles ?? 0),
      };
    });
}
