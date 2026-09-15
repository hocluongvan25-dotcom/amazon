/**
 * SHIM — code thật ở web/src/lib/worker/run-research-collect.ts (Vercel Cron
 * cần chạy trong web/). CLI gọi bản này để dùng chung MỘT implementation.
 */
export { runResearchCollect } from "../../../web/src/lib/worker/run-research-collect.ts";
