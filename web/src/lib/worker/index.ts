/**
 * Re-export worker runtime cho web server-side (CRON + manual trigger).
 * Next.js được cấu hình để transpile ../worker/src bằng transpilePackages.
 */
export { runInventorySyncAll } from "../../../../worker/src/runtime/run-inventory-sync";
export type { InventorySyncRunResult } from "../../../../worker/src/runtime/run-inventory-sync";
