/**
 * SHIM — code thật nằm ở web/src/lib/worker/jobs/inventory-fc-sync.job.ts.
 *
 * LÝ DO: report nay được kéo TỰ ĐỘNG qua Reports API từ Vercel Cron (root = web),
 * nên luật nhập report phân bổ FC / lịch sử nhận hàng phải chạy được trong web/.
 * Giữ shim để worker/src/cli.ts, worker/src/runtime/* và worker/tests/* không đổi.
 */
export * from "../../../web/src/lib/worker/jobs/inventory-fc-sync.job.ts";
