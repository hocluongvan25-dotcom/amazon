"use client";

/**
 * Module 8 G2 — panel tiến độ thu thập dữ liệu trên trang chi tiết.
 * Nút "Xếp hàng" gọi server action (RPC theo phiên người dùng); worker/cron
 * mới là bên chạy Rainforest và ghi kết quả.
 *
 * Lượt test thật đầu tiên nên dùng cấu hình TIẾT KIỆM credits:
 *   serp pages=1 (1 credit) + products topN=10 direct (30 credits)
 *   + reviews topN=5 × 1 trang (≤5 credits) ≈ 36 credits.
 * Mặc định khi bỏ direct, products tạo Collection bất đồng bộ 30 ASIN × 3 =
 * 90 request và phải có webhook/RAINFOREST_WEBHOOK_BASE_URL.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Chip, Panel, tableCls } from "@/components/ui";
import type { CollectionData } from "@/lib/data/research";
import { enqueueAndRunCollectionAction } from "../actions";

const KIND_LABEL: Record<string, string> = {
  serp: "SERP (đối thủ trên trang tìm kiếm)",
  products: "Product + Offers + Sales",
  reviews: "Review 1–3★ (pain khách hàng)",
  fees: "SP-API Product Fees (G2+)",
};

const STATUS_TONE: Record<string, "gray" | "amber" | "green" | "red"> = {
  queued: "gray",
  running: "amber",
  done: "green",
  no_data: "gray",
  failed: "red",
  collection_created: "amber",
};

const numCls =
  "w-16 rounded-[7px] border border-line bg-white px-2 py-1 text-[12px] font-bold";
const lblCls = "flex items-center gap-1.5 text-[12px] font-semibold text-soft";

export function CollectionPanel({
  assessmentId,
  data,
  connected,
}: {
  assessmentId: string;
  data: CollectionData;
  connected: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const router = useRouter();

  // Tham số tiết kiệm credits mặc định cho lần chạy thật đầu tiên.
  const [serpPages, setSerpPages] = useState(1);
  const [productsTopN, setProductsTopN] = useState(10);
  const [productsDirect, setProductsDirect] = useState(true);
  const [reviewsTopN, setReviewsTopN] = useState(5);
  const [reviewPages, setReviewPages] = useState(1);

  const serpCredits = Math.min(Math.max(serpPages || 1, 1), 2);
  const productsCredits = productsDirect
    ? Math.min(Math.max(productsTopN || 1, 1), 50) * 3
    : Math.min(Math.max(productsTopN || 1, 1), 50) * 3; // Collection: ghi khi webhook về
  const reviewsCredits =
    Math.min(Math.max(reviewsTopN || 1, 1), 20) *
    Math.min(Math.max(reviewPages || 1, 1), 10);

  // MỖI NÚT = XẾP HÀNG + CHẠY NGAY trong request (không chờ cron). Cron chỉ
  // chạy ngầm vét lượt sót / lượt bị Vercel cắt giữa chừng (migration 0034).
  const enqueue = (
    kind: "serp" | "products" | "reviews",
    params: Record<string, unknown>,
    credits: number,
  ) => {
    startTransition(async () => {
      setMessage({ ok: true, text: `Đang chạy lượt "${kind}" (≈${credits} credits) — chờ chút…` });
      const r = await enqueueAndRunCollectionAction(assessmentId, kind, params);
      setMessage({ ok: r.ok, text: r.message });
      router.refresh();
    });
  };

  return (
    <Panel
      title="Thu thập dữ liệu (G2 — Rainforest)"
      hint="mỗi nút = xếp hàng + CHẠY NGAY trong request; cron chỉ chạy ngầm vét lượt sót; mỗi lượt ghi 1 collection_run + sổ cái credits"
    >
      {!connected && (
        <div className="mb-3 rounded-[10px] bg-amber-soft px-3 py-2 text-[12.5px] font-semibold text-[#8a5602]">
          DEMO MODE: chưa nối Supabase/Rainforest — panel này chỉ hiển thị khi triển khai thật.
          Thiếu <code>RAINFOREST_API_KEY</code> worker chạy provider mock (gắn <code>data_source=&quot;mock&quot;</code>).
        </div>
      )}

      <div className="mb-3 grid gap-2 rounded-[10px] border border-line bg-[#f7f9fc] p-3 sm:grid-cols-3">
        {/* SERP */}
        <div className="flex flex-col gap-2">
          <label className={lblCls}>
            Số trang SERP
            <input
              type="number" min={1} max={2} value={serpPages}
              disabled={pending || !connected}
              onChange={(e) => setSerpPages(Number(e.target.value))}
              className={numCls}
            />
          </label>
          <button
            type="button"
            disabled={pending || !connected}
            onClick={() =>
              enqueue("serp", { pages: serpCredits }, serpCredits)
            }
            className="rounded-[9px] bg-blue px-3 py-1.5 text-[12px] font-extrabold text-white hover:bg-blue-800 disabled:opacity-40"
          >
            {pending ? "Đang chạy…" : `▶ Chạy ngay: ${KIND_LABEL.serp}`}
          </button>
          <span className="text-[11px] text-muted">≈ {serpCredits} credit</span>
        </div>

        {/* Products */}
        <div className="flex flex-col gap-2">
          <label className={lblCls}>
            Số ASIN (topN)
            <input
              type="number" min={1} max={50} value={productsTopN}
              disabled={pending || !connected}
              onChange={(e) => setProductsTopN(Number(e.target.value))}
              className={numCls}
            />
          </label>
          <label className={lblCls}>
            <input
              type="checkbox" checked={productsDirect}
              disabled={pending || !connected}
              onChange={(e) => setProductsDirect(e.target.checked)}
            />
            direct đồng bộ (không qua Collection/webhook)
          </label>
          <button
            type="button"
            disabled={pending || !connected}
            onClick={() =>
              enqueue(
                "products",
                { topN: productsTopN, direct: productsDirect },
                productsCredits,
              )
            }
            className="rounded-[9px] bg-blue px-3 py-1.5 text-[12px] font-extrabold text-white hover:bg-blue-800 disabled:opacity-40"
          >
            {pending ? "Đang chạy…" : `▶ Chạy ngay: ${KIND_LABEL.products}`}
          </button>
          <span className="text-[11px] text-muted">
            ≈ {productsCredits} credits (3 request/ASIN
            {productsDirect ? ", direct" : ", Collection bất đồng bộ"})
          </span>
        </div>

        {/* Reviews */}
        <div className="flex flex-col gap-2">
          <label className={lblCls}>
            Số ASIN
            <input
              type="number" min={1} max={20} value={reviewsTopN}
              disabled={pending || !connected}
              onChange={(e) => setReviewsTopN(Number(e.target.value))}
              className={numCls}
            />
          </label>
          <label className={lblCls}>
            Trang/ASIN
            <input
              type="number" min={1} max={10} value={reviewPages}
              disabled={pending || !connected}
              onChange={(e) => setReviewPages(Number(e.target.value))}
              className={numCls}
            />
          </label>
          <button
            type="button"
            disabled={pending || !connected}
            onClick={() =>
              enqueue(
                "reviews",
                { topN: reviewsTopN, maxPagesPerAsin: reviewPages, targetPerAsin: 50 },
                reviewsCredits,
              )
            }
            className="rounded-[9px] bg-blue px-3 py-1.5 text-[12px] font-extrabold text-white hover:bg-blue-800 disabled:opacity-40"
          >
            {pending ? "Đang chạy…" : `▶ Chạy ngay: ${KIND_LABEL.reviews}`}
          </button>
          <span className="text-[11px] text-muted">
            ≤ {reviewsCredits} credits. G4 đủ mẫu: đặt 10 ASIN × 5 trang ≈ 500 review 1–3★.
          </span>
        </div>
      </div>

      <div className="mb-2 text-[11.5px] text-muted">
        Gói test thật đầu tiên gợi ý: SERP 1 trang → products topN 10 direct → reviews 5 ASIN × 1 trang
        = <b>≈ {serpCredits + productsCredits + reviewsCredits} credits</b> (trial 100 credits).
        Chạy lần lượt, sau mỗi bước kiểm tra bảng dưới trước khi xếp bước kế.
      </div>

      {message && <Chip tone={message.ok ? "green" : "amber"}>{message.text}</Chip>}

      <h4 className="mb-1.5 mt-3 text-[12px] font-extrabold uppercase tracking-wide text-soft">
        Hàng đợi & lịch sử lượt quét
      </h4>
      {data.runs.length === 0 ? (
        <div className="rounded-[10px] bg-[#f4f6fa] px-3 py-2 text-[12.5px] text-soft">
          Chưa có lượt thu thập nào. Bắt đầu bằng SERP, sau đó mới chạy products/reviews.
        </div>
      ) : (
        <table className={tableCls.table}>
          <thead>
            <tr>
              <th className={tableCls.th}>Loại</th>
              <th className={tableCls.th}>Trạng thái</th>
              <th className={`${tableCls.th} text-right`}>Credits</th>
              <th className={tableCls.th}>Thời điểm</th>
              <th className={tableCls.th}>Ghi chú/lỗi</th>
            </tr>
          </thead>
          <tbody>
            {data.runs.map((r) => (
              <tr key={r.run_id}>
                <td className={tableCls.td}>{KIND_LABEL[r.kind] ?? r.kind}</td>
                <td className={tableCls.td}>
                  <Chip tone={STATUS_TONE[r.status] ?? "gray"}>{r.status}</Chip>
                  {r.provider === "mock" ? <Chip tone="amber">mock</Chip> : null}
                </td>
                <td className={tableCls.tdNum}>{r.credits_used ?? 0}</td>
                <td className={tableCls.td}>{r.finished_at ? new Date(r.finished_at).toLocaleString("vi-VN") : "—"}</td>
                <td className={`${tableCls.td} text-red`}>{r.error ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data.competitors.length > 0 && (
        <>
          <h4 className="mb-1.5 mt-4 text-[12px] font-extrabold uppercase tracking-wide text-soft">
            Đối thủ lần quét mới nhất ({data.competitors.length} listing)
          </h4>
          <div className="overflow-x-auto">
            <table className={tableCls.table}>
              <thead>
                <tr>
                  <th className={tableCls.th}>#</th>
                  <th className={tableCls.th}>ASIN / brand</th>
                  <th className={`${tableCls.th} text-right`}>Giá</th>
                  <th className={`${tableCls.th} text-right`}>Sao</th>
                  <th className={`${tableCls.th} text-right`}>Lượt đánh giá</th>
                  <th className={`${tableCls.th} text-right`}>BSR</th>
                  <th className={`${tableCls.th} text-right`}>Đơn/tháng ước lượng</th>
                  <th className={tableCls.th}>Buybox</th>
                </tr>
              </thead>
              <tbody>
                {data.competitors.map((c) => (
                  <tr key={`${c.run_id}-${c.asin}`}>
                    <td className={tableCls.td}>
                      {c.position}
                      {c.is_sponsored ? <Chip tone="amber">sponsored</Chip> : null}
                    </td>
                    <td className={tableCls.td}>
                      <b>{c.asin}</b>
                      <div className="text-[11.5px] text-soft">{c.brand ?? "—"}</div>
                    </td>
                    <td className={tableCls.tdNum}>{c.price ? `$${c.price.toFixed(2)}` : "—"}</td>
                    <td className={tableCls.tdNum}>{c.rating ?? "—"}</td>
                    <td className={tableCls.tdNum}>{c.ratings_total?.toLocaleString("en-US") ?? "—"}</td>
                    <td className={tableCls.tdNum}>{c.bsr_rank ?? "—"}</td>
                    <td className={tableCls.tdNum}>
                      {c.est_units_month ? (
                        <>
                          {c.est_units_month.toLocaleString("en-US")}
                          <div className="text-[10.5px] text-soft">sai số 20–40%</div>
                        </>
                      ) : (
                        "chưa có"
                      )}
                    </td>
                    <td className={tableCls.td}>
                      {c.is_amazon_1p ? <Chip tone="red">Amazon 1P</Chip> : c.buybox_seller ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2 text-[11.5px] text-muted">
            Review 1–3★ đã thu: <b>{data.reviewCount}</b>. Các chỉ số CR3/HHI, review velocity,
            phân cụm pain sẽ chấm ở G3–G4.
          </div>
        </>
      )}
    </Panel>
  );
}
