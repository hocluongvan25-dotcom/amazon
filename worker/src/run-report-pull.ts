/**
 * SHIM — code thật ở web/src/lib/worker/run-report-pull.ts (nơi Vercel Cron chạy).
 * Giữ shim để worker/src/cli.ts và runtime dùng chung MỘT bản runner.
 */
export * from "../../web/src/lib/worker/run-report-pull.ts";
