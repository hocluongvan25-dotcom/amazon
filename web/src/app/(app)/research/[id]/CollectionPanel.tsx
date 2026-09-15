"use client";

/**
 * Module 8 G2 — panel tiến độ thu thập dữ liệu trên trang chi tiết.
 * Nút "Xếp hàng" gọi server action (RPC theo phiên người dùng); worker/cron
 * mới là bên chạy Rainforest và ghi kết quả.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Chip, Panel, tableCls } from "@/components/ui";
import type { CollectionData } from "@/lib/data/research";
import { enqueueCollectionAction } from "../actions";

const KIND_LABEL: Record<string, string> = {
  serp: "SERP (đối thủ trên trang tìm kiếm)",
  products: "Product + Offers + Sales (bất đồng bộ qua Collection)",
  reviews: "Review 1–3★ (pain khách hàng)",
  fees: "SP-API Product Fees (G2+)",
};

const STATUS_TONE: Record<string, "gray" | "amber" | "green" | "red"> = {
  queued: "gray",
  running: "amber",
  done: "green",
  no_data: "gray",
  failed: "red",
};

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

  const enqueue = (kind: "serp" | "products" | "reviews") => {
    startTransition(async () => {
      const r = await enqueueCollectionAction(assessmentId, kind, {});
      setMessage({ ok: r.ok, text: r.message });
      router.refresh();
    });
  };

  return (
    <Panel
      title="Thu thập dữ liệu (G2 — Rainforest)"
      hint="worker/cron nhận hàng đợi; mỗi lượt ghi 1 collection_run + sổ cái credits"
    >
      {!connected && (
        <div className="mb-3 rounded-[10px] bg-amber-soft px-3 py-2 text-[12.5px] font-semibold text-[#8a5602]">
          DEMO MODE: chưa nối Supabase/Rainforest — panel này chỉ hiển thị khi triển khai thật.
          Thiếu <code>RAINFOREST_API_KEY</code> worker chạy provider mock (gắn <code>data_source=&quot;mock&quot;</code>).
        </div>
      )}

      <div className="mb-3 flex flex-wrap gap-2">
        {(["serp", "products", "reviews"] as const).map((k) => (
          <button
            key={k}
            type="button"
            disabled={pending || !connected}
            onClick={() => enqueue(k)}
            className="rounded-[9px] border border-line bg-white px-3 py-1.5 text-[12px] font-extrabold disabled:opacity-40"
          >
            + Xếp hàng: {KIND_LABEL[k]}
          </button>
        ))}
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
