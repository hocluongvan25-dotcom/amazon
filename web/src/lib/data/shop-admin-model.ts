/**
 * MODULE 0 — MODEL THUẦN cho việc THÊM SHOP MỚI (màn Kết nối shop, SOP-11).
 *
 * Vì sao tách riêng file model:
 *   • Cùng một luật kiểm tra phải dùng ở CẢ client (form) lẫn server (server
 *     action) — nếu để trong component thì server không dùng lại được, còn để
 *     trong action thì client phải chờ round-trip mới biết thiếu gì.
 *   • Luật nằm ở DB (RPC `vexim_admin_create_shop`, migration 0032) là chốt cuối;
 *     file này chỉ để báo lỗi SỚM và ĐỒNG NHẤT về câu chữ.
 *
 * Không import server code — dùng được ở client component và trong test.
 */

// Đuôi .ts để file này import được bằng `node --test` (web/tests) — Next.js vẫn resolve bình thường.
import { MARKETPLACE_META } from "./oauth-shared.ts";

/** Marketplace chọn được khi thêm shop (nhãn 🇺🇸 US · Hoa Kỳ). */
export const SHOP_MARKETPLACES: { id: string; code: string; name: string; flag: string }[] = Object.entries(
  MARKETPLACE_META,
).map(([id, meta]) => ({ id, ...meta }));

export type NewShopInput = {
  displayName: string;
  marketplace: string;
  /** để trống nếu chưa biết — Amazon trả ở bước authorize */
  sellerId?: string | null;
};

export type NewShopValidation = {
  ok: boolean;
  /** lỗi theo từng trường, câu tiếng Việt hiển thị thẳng lên form */
  errors: Partial<Record<"displayName" | "marketplace" | "sellerId", string>>;
  /** giá trị đã chuẩn hoá để gửi xuống server */
  value: { displayName: string; marketplace: string; sellerId: string | null };
};

/**
 * Luật (khớp RPC 0032 — sửa một bên thì sửa cả hai):
 *   • Tên gọi nội bộ: bắt buộc, ≤ 120 ký tự.
 *   • Marketplace: bắt buộc, phải nằm trong danh sách đã biết (id của Amazon).
 *   • Seller ID: TUỲ CHỌN, nếu nhập thì chỉ chữ + số, 6–32 ký tự.
 */
export function validateNewShop(input: NewShopInput): NewShopValidation {
  const displayName = (input.displayName ?? "").replace(/\s+/g, " ").trim();
  const marketplace = (input.marketplace ?? "").trim();
  const sellerIdRaw = (input.sellerId ?? "").trim();

  const errors: NewShopValidation["errors"] = {};

  if (displayName === "") {
    errors.displayName = "Nhập tên gọi nội bộ (ví dụ: VEXIM US - Chính, Shop khách A - US).";
  } else if (displayName.length > 120) {
    errors.displayName = `Tên gọi quá dài (${displayName.length}/120 ký tự).`;
  }

  if (marketplace === "") {
    errors.marketplace = "Chọn marketplace (US/CA/UK/DE/JP/MX…).";
  } else if (!SHOP_MARKETPLACES.some((m) => m.id === marketplace)) {
    errors.marketplace = `Marketplace "${marketplace}" không nằm trong danh sách hỗ trợ.`;
  }

  let sellerId: string | null = sellerIdRaw === "" ? null : sellerIdRaw.toUpperCase();
  if (sellerId !== null && !/^[A-Z0-9]{6,32}$/.test(sellerId)) {
    errors.sellerId =
      "Seller ID chỉ gồm chữ và số (6–32 ký tự). Để trống nếu chưa biết — hệ thống tự điền khi shop authorize.";
    sellerId = null;
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    value: { displayName, marketplace, sellerId },
  };
}

/**
 * Nhãn marketplace cho UI ("🇺🇸 US · Hoa Kỳ").
 * Lạ ⇒ trả nguyên id để người vận hành thấy giá trị thật, không bịa tên.
 */
export function marketplaceOptionLabel(id: string): string {
  const m = SHOP_MARKETPLACES.find((x) => x.id === id);
  return m ? `${m.flag} ${m.code} · ${m.name}` : id;
}
