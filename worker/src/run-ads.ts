/**
 * SHIM — code thật ở web/src/lib/worker/run-ads.ts (nơi Vercel Cron chạy).
 * Giữ shim để worker/src/cli.ts và test dùng chung MỘT bản runner.
 */
export * from "../../web/src/lib/worker/run-ads.ts";
