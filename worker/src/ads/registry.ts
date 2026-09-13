/**
 * SHIM — code thật ở web/src/lib/worker/ads/registry.ts (Vercel Cron cần chạy
 * trong web/). Giữ shim để CLI và test của worker không đổi đường import.
 */
export * from "../../../web/src/lib/worker/ads/registry.ts";
