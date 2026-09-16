/**
 * Module 8 G7 — Tab mùa vụ BSR (bản web).
 * Nguồn: bsr_history tích lũy từ các lần quét Rainforest (0 credit) hoặc
 * backfill Keepa. Thiếu điểm → "chưa đủ cơ sở", không suy diễn mùa vụ.
 */

import { Chip, Panel, tableCls } from "@/components/ui";
import {
  computeSeasonality,
  restockAdvice,
  summarizeBsr,
  type BsrPoint,
} from "@/lib/research/domain";

const MONTHS = [
  "tháng 1", "tháng 2", "tháng 3", "tháng 4", "tháng 5", "tháng 6",
  "tháng 7", "tháng 8", "tháng 9", "tháng 10", "tháng 11", "tháng 12",
];

const CONF_LABEL: Record<string, string> = {
  high: "cao (≥2 năm)",
  medium: "vừa (≥8 tháng)",
  low: "thấp (<2 năm, chỉ tham khảo)",
};

function rank(n: number | null): string {
  return n === null ? "—" : Math.round(n).toLocaleString("vi-VN");
}

export function SeasonalityPanel({ data }: { data: BsrHistoryDataLike | null }) {
  const now = new Date();

  if (!data) {
    return (
      <Panel
        title="Mùa vụ & lịch sử BSR (G7)"
        hint="từ nhiều lần quét Rainforest hoặc backfill Keepa"
      >
        <div className="rounded-[10px] bg-[#f4f6fa] px-3 py-2 text-[12.5px] text-soft">
          Không tải được lịch sử BSR (xem nhật ký hệ thống).
        </div>
      </Panel>
    );
  }

  const points = data.points;

  if (!points.length) {
    return (
      <Panel
        title="Mùa vụ & lịch sử BSR (G7)"
        hint="từ nhiều lần quét Rainforest hoặc backfill Keepa"
      >
        <div className="rounded-[10px] bg-[#f4f6fa] px-3 py-2 text-[12.5px] text-soft">
          Chưa có điểm BSR lịch sử nào. Sau khi cron thu thập chạy lặp lại (mỗi 7–14 ngày/lần),
          engine tự dựng chuỗi BSR ở đây — cần ≥12 điểm trải ≥8 tuần mới nhận diện mùa vụ.
          {data.keepaConfigured
            ? " Đã cấu hình KEEPA_API_KEY: bật RESEARCH_KEEPA_BACKFILL=1 để nạp lịch sử nhiều năm ngay."
            : " Nhanh hơn là mua Keepa và cấu hình KEEPA_API_KEY để backfill 1–2 năm lịch sử."}
        </div>
      </Panel>
    );
  }

  const byAsin = new Map<string, BsrPoint[]>();
  for (const p of points) {
    const arr = byAsin.get(p.asin) ?? [];
    arr.push(p);
    byAsin.set(p.asin, arr);
  }
  const season = computeSeasonality(points, now);
  const advice = restockAdvice(points, { leadWeeks: 8, now });

  const asinRows = [...byAsin.entries()]
    .map(([asin, pts]) => ({ asin, t: summarizeBsr(pts, now) }))
    .sort((a, b) => (a.t.latestBsr ?? 1e9) - (b.t.latestBsr ?? 1e9))
    .slice(0, 8);

  const trend = (slope: number | null, r2: number | null): string => {
    if (slope === null) return "—";
    const flat = Math.abs(slope) < 1; // <1 hạng/ngày
    if (flat) return `đi ngang${r2 !== null ? ` (R²=${r2.toFixed(2)})` : ""}`;
    return slope < 0
      ? `▲ bán chạy hơn${r2 !== null ? ` (R²=${r2.toFixed(2)})` : ""}`
      : `▼ chậm lại${r2 !== null ? ` (R²=${r2.toFixed(2)})` : ""}`;
  };

  return (
    <Panel
      title="Mùa vụ & lịch sử BSR (G7)"
      hint={`${data.asinCount} ASIN · trung bình ${data.pointsPerAsin} điểm/ASIN · BSR nhỏ = bán chạy`}
    >
      {data.mode === "demo" && (
        <div className="mb-2 rounded-[10px] bg-amber-soft px-3 py-2 text-[12px] font-semibold text-[#8a5602]">
          DEMO: chuỗi BSR do MockKeepa mô phỏng (mùa cao điểm tháng 10–11), không phải thị trường thật.
        </div>
      )}

      {!season ? (
        <div className="mb-3 rounded-[10px] bg-[#f4f6fa] px-3 py-2 text-[12.5px] text-soft">
          <b>Chưa đủ cơ sở nhận diện mùa vụ.</b> Cần ≥12 điểm, trải ≥8 tuần và ≥4 tháng có đủ
          số quan sát; hiện có {points.length} điểm trên {data.asinCount} ASIN.
          Vẫn xem được xu hướng từng ASIN ở bảng dưới.
        </div>
      ) : (
        <div className="mb-3 grid gap-2 sm:grid-cols-3">
          <div className="rounded-[10px] border border-slate-200 p-3">
            <div className="text-[11px] uppercase tracking-wide text-soft">Tháng cao điểm</div>
            <div className="mt-0.5 text-[15px] font-bold text-ink">
              {season.peakMonth ? MONTHS[season.peakMonth - 1] : "—"}
            </div>
            <div className="text-[11px] text-soft">
              chậm nhất: {season.troughMonth ? MONTHS[season.troughMonth - 1] : "—"}
            </div>
          </div>
          <div className="rounded-[10px] border border-slate-200 p-3">
            <div className="text-[11px] uppercase tracking-wide text-soft">Độ sâu mùa vụ</div>
            <div className="mt-0.5 text-[15px] font-bold text-ink">
              {season.peakTroughRatio === null ? "—" : `${(season.peakTroughRatio * 100).toFixed(0)}%`}
            </div>
            <div className="text-[11px] text-soft">
              BSR đỉnh/đáy {season.peakTroughRatio !== null && season.peakTroughRatio < 0.75
                ? "· lệch mùa rõ"
                : "· gần như quanh năm"}
            </div>
          </div>
          <div className="rounded-[10px] border border-slate-200 p-3">
            <div className="text-[11px] uppercase tracking-wide text-soft">Độ tin cậy</div>
            <div className="mt-0.5 text-[15px] font-bold text-ink">
              <Chip tone={season.confidence === "high" ? "up" : season.confidence === "medium" ? "warn" : "down"}>
                {CONF_LABEL[season.confidence]}
              </Chip>
            </div>
            <div className="text-[11px] text-soft">{season.spanDays} ngày · {season.yearsCovered} năm</div>
          </div>
        </div>
      )}

      {advice && (
        <div className="mb-3 rounded-[10px] border border-blue-200 bg-blue-50 px-3 py-2 text-[12.5px] text-blue-900">
          📦 Lịch nhập hàng khuyến nghị: hàng phải về kho trước {MONTHS[advice.peakMonth - 1]} 8 tuần →
          <b> chốt đơn xưởng trong {MONTHS[advice.orderByMonth - 1]}</b>
          {advice.confidence !== "high" && " (độ tin cậy thấp, cần thêm dữ liệu Keepa)"}.
        </div>
      )}

      <table className={tableCls.table}>
        <thead>
          <tr>
            <th className={tableCls.th}>ASIN</th>
            <th className={`${tableCls.th} text-right`}>BSR hiện tại</th>
            <th className={`${tableCls.th} text-right`}>TB 30 ngày</th>
            <th className={`${tableCls.th} text-right`}>TB 90 ngày</th>
            <th className={tableCls.th}>Xu hướng</th>
            <th className={`${tableCls.th} text-right`}>Số điểm</th>
          </tr>
        </thead>
        <tbody>
          {asinRows.map(({ asin, t }) => (
            <tr key={asin}>
              <td className={`${tableCls.td} font-mono text-[12px]`}>{asin}</td>
              <td className={tableCls.tdNum}>{rank(t.latestBsr)}</td>
              <td className={tableCls.tdNum}>{rank(t.medianBsr30d)}</td>
              <td className={tableCls.tdNum}>{rank(t.medianBsr90d)}</td>
              <td className={tableCls.td}>{trend(t.slopePerDay, t.r2)}</td>
              <td className={tableCls.tdNum}>{t.points} ({t.spanDays} ngày)</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[11.5px] text-soft">
        BSR lấy nguyên trạng từ Rainforest/Keepa tại thời điểm quét (lưu bsr_history); BSR nhấp nháy
        theo ngày nên dùng trung vị 30/90 ngày, không tin một điểm đơn lẻ.
      </p>
    </Panel>
  );
}

type BsrHistoryDataLike = {
  mode: "demo" | "supabase";
  points: BsrPoint[];
  asinCount: number;
  pointsPerAsin: number;
  keepaConfigured: boolean;
};
