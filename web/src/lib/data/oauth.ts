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
 */

import { createClient } from "@/lib/supabase/server";
import { readAll } from "./inventory-model";

export type ConnectShopRow = {
  sellerAccountId: string;
  shop: string;
  marketplace: string;
  status: string | null;
  hasToken: boolean;
  isActive: boolean;
  isExpired: boolean;
  needsReauth: boolean;
  daysLeft: number | null;
  expiresAt: string | null;
  authorizedAt: string | null;
  noticeDays: number | null;
  refreshCount: number | null;
  rotateReminderSent: boolean;
  noticeSentAt: string | null;
  adsProfiles: number;
};

const SHOP_SELECT = "seller_account_id,shop,marketplace,status,data_source";
const TOKEN_SELECT =
  "seller_account_id,shop,is_active,is_expired,needs_reauth,days_left,expires_at," +
  "authorized_at,notice_days,refresh_count,rotate_reminder_sent,notice_sent_at,ads_profiles";

export async function readConnectShops(): Promise<ConnectShopRow[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");

  const shops = await readAll<Record<string, unknown>>((from, to) =>
    client.from("vexim_shops").select(SHOP_SELECT).order("shop").range(from, to),
  );

  // View token có thể chưa tồn tại (chưa chạy 0020) — khi đó màn hình vẫn phải
  // hiện danh sách shop kèm trạng thái "chưa kết nối", KHÔNG sập cả trang.
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
      return {
        sellerAccountId: id,
        shop: String(s.shop ?? id),
        marketplace: String(s.marketplace ?? ""),
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

/** Trạng thái hiển thị — gom luật vào một chỗ để UI không tự đoán. */
export function connectStatusOf(row: ConnectShopRow):
  | { label: string; tone: "green" | "amber" | "red" | "gray"; hint: string } {
  if (!row.hasToken) {
    return {
      label: "Chưa kết nối",
      tone: "gray",
      hint: "Shop chưa từng authorize app — bấm Kết nối để lấy refresh token.",
    };
  }
  if (row.isExpired || !row.isActive) {
    return {
      label: "Token hết hạn",
      tone: "red",
      hint: "Refresh token đã hết hạn/thu hồi: mọi module đang ngừng đồng bộ. Phải authorize lại.",
    };
  }
  if (row.needsReauth) {
    return {
      label: `Sắp hết hạn (${row.daysLeft ?? "?"} ngày)`,
      tone: "amber",
      hint: `Còn ${row.daysLeft ?? "?"} ngày (nhắc trước ${row.noticeDays ?? 30} ngày) — nên kết nối lại trước khi hết.`,
    };
  }
  return {
    label: "Đang hoạt động",
    tone: "green",
    hint: "Token còn hiệu lực, đồng bộ chạy bình thường.",
  };
}
