/**
 * Panel "Chẩn đoán kết nối Amazon Ads" của màn A1 (`/ppc`).
 *
 * Trước 16/09/2026 màn này chỉ có một câu "Chưa có dữ liệu Amazon Ads" + 2 câu
 * lệnh CLI — không nói được vì sao trống. Panel này liệt kê 5 cổng theo ĐÚNG thứ
 * tự phải mở, chỉ ra cổng đang tắc, việc cần làm, và in NGUYÊN VĂN lỗi Amazon ở
 * lần xin report gần nhất (nơi các lỗi 400 như "Invalid groupBy/column" hiện ra).
 */

import { Chip, Panel, tableCls } from "@/components/ui";
import type { AdsDiagnostics as AdsDiagnosticsData } from "@/lib/data/ads-health";
import { AdsSyncNowButton } from "./AdsSyncNowButton";

function GateRow({ gate, index }: { gate: AdsDiagnosticsData["gates"][number]; index: number }) {
  const icon = gate.blocked ? "⏸" : gate.ok ? "✅" : "⛔";
  return (
    <li
      className={`rounded-[10px] border px-3 py-2.5 ${
        gate.blocked ? "border-dashed border-line opacity-70" : gate.ok ? "border-line" : "border-amber/50 bg-amber-soft"
      }`}
    >
      <div className="flex items-start gap-2">
        <span aria-hidden className="mt-0.5 text-[14px]">{icon}</span>
        <div className="flex-1">
          <div className="text-[12.5px] font-bold">
            {gate.label}
            <span className="ml-2 font-semibold text-soft">· {gate.detail}</span>
          </div>
          {!gate.ok && !gate.blocked ? (
            <div className="mt-1 text-[12px] font-semibold text-[#8a5602]">Việc cần làm: {gate.fix}</div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export function AdsDiagnosticsPanel({ data }: { data: AdsDiagnosticsData }) {
  const blocked = data.firstBlocked;
  const failed = data.requests.filter((r) => r.status === "failed" || r.status === "fatal");

  return (
    <Panel
      title="Chẩn đoán kết nối Amazon Ads"
      hint={
        blocked
          ? `tắc ở ${blocked.label}`
          : failed.length > 0
            ? `${failed.length} report lỗi gần đây`
            : "5 cổng đều mở"
      }
    >
      <p className="mb-2.5 text-[13px] text-muted">
        {blocked
          ? `Module 5 phần 1 đã code xong và nối vào cron, nhưng dữ liệu chưa về vì ${blocked.label.toLowerCase()} chưa xong. Mở lần lượt từ trên xuống:`
          : "Kết nối Amazon Ads đã đủ điều kiện chạy. Nếu KPI vẫn trống, xem lỗi report bên dưới."}
      </p>

      <ol className="flex flex-col gap-2">
        {data.gates.map((g, i) => (
          <GateRow key={g.key} gate={g} index={i} />
        ))}
      </ol>

      <div className="mt-3 border-t border-line pt-3">
        <AdsSyncNowButton label={blocked?.key === "credentials" ? "▶ Chạy thử (sẽ báo thiếu credential)" : "▶ Chạy đồng bộ Amazon Ads ngay"} />
        <div className="mt-1.5 text-[11.5px] text-soft">
          Nút này chạy đúng 2 job của cron 03:00 UTC: đồng bộ cấu trúc (profile → campaign → ad group → target) rồi
          kéo 5 report metrics. Cron vẫn tự chạy hằng ngày — bấm đây chỉ để không phải chờ.
        </div>
      </div>

      {data.error ? (
        <div role="alert" className="mt-3 rounded-[10px] bg-amber-soft px-3 py-2 text-[12px] font-semibold text-[#8a5602]">
          Không đọc được bảng trạng thái report ({data.error}) — có thể migration 0019/0020 chưa chạy đủ.
        </div>
      ) : null}

      {data.requests.length > 0 ? (
        <div className="mt-3 border-t border-line pt-3">
          <div className="mb-1.5 text-[12px] font-bold text-muted">
            Lần xin report gần nhất (nguồn: <code>vexim_report_requests</code>)
          </div>
          <table className={tableCls.table}>
            <thead>
              <tr>
                <th className={tableCls.th}>Report</th>
                <th className={tableCls.th}>Shop</th>
                <th className={tableCls.th}>Trạng thái</th>
                <th className={`${tableCls.th} text-right`}>Dòng</th>
                <th className={tableCls.th}>Xin lúc</th>
                <th className={tableCls.th}>Lỗi Amazon</th>
              </tr>
            </thead>
            <tbody>
              {data.requests.map((r, i) => {
                const bad = r.status === "failed" || r.status === "fatal";
                return (
                  <tr key={`${r.report_type}-${r.requested_at}-${i}`}>
                    <td className={`${tableCls.td} font-bold`}>{r.report_type}</td>
                    <td className={tableCls.td}>{r.shop ?? "—"}</td>
                    <td className={tableCls.td}>
                      <Chip tone={bad ? "red" : r.status === "imported" ? "green" : r.status === "no_data" ? "gray" : "amber"}>
                        {r.status}
                      </Chip>
                      {r.is_stale ? <div className="mt-0.5 text-[10.5px] font-bold text-[#8a5602]">treo &gt; 6 giờ</div> : null}
                    </td>
                    <td className={tableCls.tdNum}>{r.rows_imported ?? "—"}</td>
                    <td className={`${tableCls.td} text-[12px]`}>
                      {r.requested_at ? new Date(r.requested_at).toLocaleString("vi-VN") : "—"}
                      {r.age_minutes !== null ? <div className="text-[10.5px] text-soft">cách đây {r.age_minutes} phút</div> : null}
                    </td>
                    <td className={`${tableCls.td} text-[12px]`}>
                      {r.last_error ? <span className="font-semibold text-[#a01717]">{r.last_error}</span> : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </Panel>
  );
}
