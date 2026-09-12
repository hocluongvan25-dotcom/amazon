/**
 * Inventory sync engine — chạy server-side trong Next.js (Vercel Cron + manual trigger).
 *
 * TẠI SAO CODE NẰM Ở ĐÂY, KHÔNG PHẢI Ở worker/:
 *   Vercel đặt Root Directory = `web`, nên `web/` PHẢI tự đủ — không được import
 *   ra ngoài thư mục đó. Import cũ `"../../../../worker/src/runtime/run-inventory-sync"`
 *   làm build Vercel fail:
 *     Module not found: Can't resolve '../../../../worker/src/runtime/run-inventory-sync'
 *   (đã tái hiện bằng cách build web/ trong thư mục cô lập).
 *
 * `worker/` vẫn dùng được engine này qua các shim re-export trong worker/src/,
 * nên `worker/src/cli.ts` và worker/tests/*.test.ts không phải đổi gì.
 */
export { runInventorySyncAll } from "./run-inventory-sync";
export type { InventorySyncRunResult } from "./run-inventory-sync";

/* ---- Reports API (0019): Vercel Cron tự kéo 4 report FBA ---- */
export { runReportPullAll } from "./run-report-pull";
export type { ReportPullRunResult } from "./run-report-pull";
export { REPORT_SPECS, ALL_REPORT_KINDS, isReportKind } from "./reports/registry";
export type { ReportKind } from "./reports/registry";
