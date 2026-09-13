/**
 * SHIM — code thật ở web/src/lib/worker/jobs/ads-report-pull.job.ts (Vercel Cron cần chạy trong web/).
 * Giữ shim để CLI và test của worker dùng chung MỘT bản.
 */
export * from "../../../web/src/lib/worker/jobs/ads-report-pull.job.ts";
