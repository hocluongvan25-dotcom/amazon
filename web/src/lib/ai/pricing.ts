/**
 * Module 8 G4 — bảng giá token (USD/1 triệu token vào/ra) và hàm tính chi phí.
 * Cập nhật theo bảng giá OpenAI công khai 09/2026 (xem
 * docs/module-8-uoc-luong-chi-phi-1-phan-tich.md). Con số chi phí G4 luôn
 * được ghi thật vào research.llm_runs (cost_usd) kèm model + token.
 */

export type ModelPrice = { inPerM: number; outPerM: number; currency: "USD" };

export const LLM_PRICING: Record<string, ModelPrice> = {
  // Hàng OpenAI (model mới)
  "gpt-4.1-mini": { inPerM: 0.4, outPerM: 1.6, currency: "USD" },
  "gpt-4.1-nano": { inPerM: 0.1, outPerM: 0.4, currency: "USD" },
  "gpt-4.1": { inPerM: 2.0, outPerM: 8.0, currency: "USD" },
  "gpt-5-mini": { inPerM: 0.25, outPerM: 2.0, currency: "USD" },
  "gpt-4o-mini": { inPerM: 0.15, outPerM: 0.6, currency: "USD" },
  "gpt-4o": { inPerM: 2.5, outPerM: 10.0, currency: "USD" },
};

export const DEFAULT_MODEL = "gpt-4.1-mini";

/** Model nội bộ của mock (không tốn tiền — giá 0). */
export const MOCK_MODEL = "mock-llm-1";
LLM_PRICING[MOCK_MODEL] = { inPerM: 0, outPerM: 0, currency: "USD" };

/** Chi phí USD cho 1 lượt gọi; model lạ → null (bắt khai báo, không bịa giá). */
export function estimateLlmCost(
  model: string,
  promptTokens: number,
  outputTokens: number,
): number | null {
  const p = LLM_PRICING[model];
  if (!p) return null;
  const cost = (promptTokens / 1_000_000) * p.inPerM + (outputTokens / 1_000_000) * p.outPerM;
  return Math.round(cost * 1_000_000) / 1_000_000; // làm tròn 6 chữ số
}

/**
 * Ước lượng token thô (dùng cho mock/không có usage): ~4 ký tự/token tiếng
 * Anh. KHÔNG dùng để tính tiền model thật — model thật lấy usage trong
 * response. Tiếng Việt dài hơn ~20%, cộng hệ lệch an toàn 1.1.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil((text.length / 4) * 1.1));
}
