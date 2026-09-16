/**
 * Module 8 G1 — auto-điền form thẩm định từ ASIN hạt nhân (Rainforest product).
 *
 * VÌ SAO (yêu cầu 16/09/2026 của chủ dự án): user chỉ biết mỗi ASIN đối thủ;
 * kích thước, khối lượng, giá bán hiện tại là thứ tra được — KHÔNG bắt nhập
 * tay. User gõ đúng ASIN + giá vốn + cước là đủ xem phân tích.
 *
 * Tái sử dụng `parseProductBundle` (đã xử lý cả shape Rainforest thật lẫn mock
 * deterministic) — file này chỉ gọt kết quả thành patch cho form bước 1 và
 * kèm 3 kịch bản giá GỢI Ý quanh giá đối thủ (±10%, ghi rõ là gợi ý).
 */

import { parseProductBundle } from "./collection.ts";

/** Biên độ gợi ý 3 kịch bản giá quanh giá đối thủ: bi quan −10%, quan tâm +10%. */
export const PRICE_SCENARIO_SPREAD_PCT = 10;

const R2 = (n: number): number => Math.round(n * 100) / 100;

export type AsinAutofillResult = {
  title: string | null;
  brand: string | null;
  /** Kích thước sản phẩm theo listing (inch) — null nếu Amazon không công bố. */
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
  weightLb: number | null;
  /** Giá buybox hiện tại của đối thủ (USD) — nguồn gợi ý giá cơ sở. */
  price: number | null;
  currency: string | null;
  /** 3 kịch bản giá gợi ý quanh giá đối thủ (chỉ có khi đọc được giá). */
  suggestedPrices: { pessimistic: number; base: number; optimistic: number } | null;
  /** Những thứ listing KHÔNG công bố — UI nói rõ để user biết phải tự lo. */
  missing: string[];
};

/**
 * Parse response `product` (Rainforest hoặc mock) → bộ auto-điền.
 * Trả null khi không tìm thấy listing ({product: null}) hoặc payload rác.
 */
export function parseAsinAutofill(productJson: unknown): AsinAutofillResult | null {
  if (!productJson || typeof productJson !== "object") return null;
  // Rainforest trả {product: null} khi ASIN không tồn tại.
  if ((productJson as Record<string, unknown>).product === null) return null;

  const patch = parseProductBundle({ product: productJson });
  // parseProductBundle luôn gán title/brand (có thể null) — chỉ coi là TÌM THẤY
  // khi có ít nhất một giá trị mang nội dung thật.
  const foundAnything =
    (patch.title ?? null) !== null ||
    (patch.price ?? null) !== null ||
    patch.lengthIn != null ||
    patch.weightLb != null;
  if (!foundAnything) return null;

  const price = typeof patch.price === "number" && Number.isFinite(patch.price) ? patch.price : null;
  const spread = PRICE_SCENARIO_SPREAD_PCT / 100;
  const suggestedPrices =
    price !== null && price > 0
      ? {
          pessimistic: R2(price * (1 - spread)),
          base: R2(price),
          optimistic: R2(price * (1 + spread)),
        }
      : null;

  const missing: string[] = [];
  if (patch.lengthIn == null || patch.widthIn == null || patch.heightIn == null) {
    missing.push("kích thước (listing không công bố — đo mẫu thật)");
  }
  if (patch.weightLb == null) missing.push("khối lượng (listing không công bố — cân mẫu thật)");
  if (price === null) missing.push("giá buybox (không đọc được — tự khảo sát giá đối thủ)");

  return {
    title: patch.title ?? null,
    brand: patch.brand ?? null,
    lengthIn: typeof patch.lengthIn === "number" ? R2(patch.lengthIn) : null,
    widthIn: typeof patch.widthIn === "number" ? R2(patch.widthIn) : null,
    heightIn: typeof patch.heightIn === "number" ? R2(patch.heightIn) : null,
    weightLb: typeof patch.weightLb === "number" ? R2(patch.weightLb) : null,
    price,
    currency: patch.currency ?? null,
    suggestedPrices,
    missing,
  };
}
