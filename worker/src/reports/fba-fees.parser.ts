/**
 * SHIM — code thật nằm ở web/src/lib/worker/reports/fba-fees.parser.ts.
 * Lý do giống fba-inventory.parser.ts: Vercel Cron (root = web) phải tự chạy được.
 */
export * from "../../../web/src/lib/worker/reports/fba-fees.parser.ts";
