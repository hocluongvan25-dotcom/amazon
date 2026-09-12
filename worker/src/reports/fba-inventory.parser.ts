/**
 * SHIM — code thật nằm ở web/src/lib/worker/reports/fba-inventory.parser.ts.
 *
 * LÝ DO: Vercel đặt Root Directory = `web`, nên web/ PHẢI tự đủ. Report nay
 * được TẢI TỰ ĐỘNG qua Reports API từ Vercel Cron (route /api/cron/report-pull),
 * tức là parser phải chạy được trong web/ — không chỉ trong CLI local.
 * Giữ shim để worker/src/* và worker/tests/* không phải đổi đường import.
 */
export * from "../../../web/src/lib/worker/reports/fba-inventory.parser.ts";
