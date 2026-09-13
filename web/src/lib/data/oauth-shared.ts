/**
 * Shared types & pure helpers cho màn Kết nối shop (SOP-11) — KHÔNG import server code.
 * File này dùng được cả ở Server Component (oauth.ts) và Client Component (ShopConnectTable.tsx).
 * Nếu để chung trong oauth.ts thì client component sẽ kéo theo `next/headers` → build fail.
 */

export type ConnectShopRow = {
  sellerAccountId: string;
  shop: string;
  marketplace: string;
  marketplaceId: string;
  sellerId: string | null;
  displayName: string;
  dataSource: string | null;
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

export const MARKETPLACE_META: Record<string, { code: string; name: string; flag: string }> = {
  ATVPDKIKX0DER: { code: "US", name: "Hoa Kỳ", flag: "🇺🇸" },
  A2EUQ1WTGCTBG2: { code: "CA", name: "Canada", flag: "🇨🇦" },
  A1AM78C64UM0Y8: { code: "MX", name: "Mexico", flag: "🇲🇽" },
  A1PA6795UKMFR9: { code: "DE", name: "Đức", flag: "🇩🇪" },
  A1F83G8C2ARO7P: { code: "UK", name: "Anh", flag: "🇬🇧" },
  A1RKKUPIHCS9HS: { code: "ES", name: "Tây Ban Nha", flag: "🇪🇸" },
  A13V1IB3VIYZZH: { code: "FR", name: "Pháp", flag: "🇫🇷" },
  APJ6JRA9NG5V4: { code: "IT", name: "Ý", flag: "🇮🇹" },
  A1VC38T7YXB528: { code: "JP", name: "Nhật", flag: "🇯🇵" },
};

export function marketplaceLabel(marketplaceId: string): { code: string; name: string; flag: string } {
  const id = (marketplaceId ?? "").trim();
  return MARKETPLACE_META[id] ?? { code: id.slice(0, 2) || "??", name: id || "Không rõ", flag: "🌐" };
}

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

export function groupBySeller(shops: ConnectShopRow[]): { sellerKey: string; sellerId: string | null; shops: ConnectShopRow[] }[] {
  const map = new Map<string, ConnectShopRow[]>();
  for (const s of shops) {
    const key = s.sellerId ?? s.shop.split("·")[0].trim() ?? s.sellerAccountId;
    const list = map.get(key) ?? [];
    list.push(s);
    map.set(key, list);
  }
  return Array.from(map.entries()).map(([k, list]) => ({
    sellerKey: k,
    sellerId: list[0]?.sellerId ?? null,
    shops: list.sort((a, b) => a.marketplaceId.localeCompare(b.marketplaceId)),
  }));
}
