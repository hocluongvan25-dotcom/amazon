/**
 * SHIM — code thật đã chuyển sang web/src/lib/worker/.
 *
 * LÝ DO: Vercel đặt Root Directory = `web`, nên web/ PHẢI tự đủ, không được
 * import ra ngoài thư mục đó. Toàn bộ inventory sync engine giờ nằm trong web/
 * (nơi nó thật sự chạy dưới dạng Vercel Cron). worker/ chỉ còn là CLI local
 * và các phần không deploy lên Vercel (listings, pricing, reports, notifications).
 *
 * Giữ shim này để `worker/src/cli.ts` và worker/tests/*.test.ts không phải đổi.
 */
export * from "../../../web/src/lib/worker/amazon/lwa.ts";
