import { Chip, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { syncJobs } from "@/lib/data/mock";
import { readReportRequests } from "@/lib/data/fees";
import { mapReportRequestRow, type ReportRequestUiRow } from "@/lib/data/fees-model";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo"];

const statusChip: Record<string, "green" | "amber" | "gray" | "red"> = {
  done: "green",
  running: "amber",
  pending: "gray",
  failed: "red",
};

const toneChip: Record<string, "green" | "amber" | "gray" | "red"> = {
  up: "green",
  warn: "amber",
  flat: "gray",
  down: "red",
};

export default async function SyncHealthPage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  // 0019: cron Reports API ghi trạng thái mỗi lần yêu cầu report vào
  // connections.report_requests. Đọc TÁCH BIỆT để trang này không sập khi DB
  // chưa chạy 0019 (các panel sync_jobs vẫn là dữ liệu demo như trước).
  let reportRows: ReportRequestUiRow[] = [];
  let reportFailed = false;
  let reportNoSupabase = false;
  try {
    reportRows = (await readReportRequests()).map(mapReportRequestRow);
  } catch (err) {
    // "Supabase unavailable" = app chưa cấu hình Supabase (chế độ demo).
    // Lỗi khác = đã nối DB nhưng thiếu view/quyền (chưa chạy 0019).
    if (err instanceof Error && err.message === "Supabase unavailable") reportNoSupabase = true;
    else reportFailed = true;
  }
  const stale = reportRows.filter((r) => r.isStale).length;
  const failedReports = reportRows.filter((r) => r.tone === "down").length;

  return (
    <>
      <PageHeader
        title="Sức khỏe đồng bộ"
        sub="sync_jobs · notifications_log · cập nhật realtime"
        desc="Trường hợp dữ liệu không mới phải thấy ngay tại đây: từng job, độ trễ, số lần retry, lỗi gần nhất."
      />
      <Panel title="Job đồng bộ gần nhất" hint="mọi trang dashboard đọc dữ liệu sau khi job này xong">
        <table className={tableCls.table}>
          <thead>
            <tr>
              <th className={tableCls.th}>Job</th>
              <th className={tableCls.th}>Shop</th>
              <th className={tableCls.th}>Trạng thái</th>
              <th className={`${tableCls.th} text-right`}>Chạy lúc</th>
              <th className={tableCls.th}>Độ trễ</th>
              <th className={`${tableCls.th} text-right`}>Retry</th>
            </tr>
          </thead>
          <tbody>
            {syncJobs.map((j) => (
              <tr key={j.jobType + j.shop}>
                <td className={`${tableCls.td} font-bold`}>{j.jobType}</td>
                <td className={tableCls.td}>{j.shop}</td>
                <td className={tableCls.td}>
                  <Chip tone={statusChip[j.status]}>{j.statusLabel}</Chip>
                </td>
                <td className={tableCls.tdNum}>{j.lastRun}</td>
                <td className={tableCls.td}>{j.latency}</td>
                <td className={`${tableCls.tdNum} ${j.retries > 0 ? "font-bold text-amber" : ""}`}>
                  {j.retries}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel
        title="Report đã kéo qua Reports API"
        hint={
          reportNoSupabase
            ? "chưa nối Supabase"
            : reportFailed
              ? "chưa đọc được vexim_report_requests"
            : `${reportRows.length} lần yêu cầu${stale > 0 ? ` · ${stale} CHỜ QUÁ LÂU` : ""}${
                failedReports > 0 ? ` · ${failedReports} lỗi` : ""
              }`
        }
      >
        {reportNoSupabase ? (
          <p className="text-[13px] text-muted">
            <b className="text-amber">Chưa nối Supabase</b> — app đang chạy chế độ demo nên không có
            lần kéo report thật nào để hiển thị. Panel này chỉ có số khi web được cấp
            <code> NEXT_PUBLIC_SUPABASE_URL</code> + key và đã chạy migration 0019; cron{" "}
            <code>/api/cron/report-pull</code> cũng cần <code>AMAZON_LWA_*</code> để gọi Amazon.
          </p>
        ) : reportFailed ? (
          <p className="text-[13px] text-muted">
            <b className="text-amber">Chưa đọc được vexim_report_requests</b> — kiểm tra đã chạy
            migration 0019 và quyền SELECT chưa. Panel này theo dõi cron{" "}
            <code>/api/cron/report-pull</code> (mỗi ngày 03:00 UTC): report nào đã nhập, report nào
            Amazon còn đang tạo, report nào bị trần 4 giờ.
          </p>
        ) : reportRows.length === 0 ? (
          <p className="text-[13px] text-muted">
            Chưa có lần yêu cầu report nào được ghi. Cron chỉ ghi khi có đủ credential
            (AMAZON_LWA_* + Supabase) và có shop <code>data_source=&apos;production&apos;</code>. Muốn nạp
            tay: <code>npm run worker:reports-pull -- --storage-fees=&lt;file.tsv&gt;</code>.
          </p>
        ) : (
          <>
            <table className={tableCls.table}>
              <thead>
                <tr>
                  <th className={tableCls.th}>Report</th>
                  <th className={tableCls.th}>Shop</th>
                  <th className={tableCls.th}>Kỳ dữ liệu</th>
                  <th className={tableCls.th}>Trạng thái</th>
                  <th className={`${tableCls.th} text-right`}>Dòng đã nhập</th>
                  <th className={`${tableCls.th} text-right`}>Lần chạm</th>
                  <th className={`${tableCls.th} text-right`}>Tuổi</th>
                  <th className={tableCls.th}>Lỗi gần nhất</th>
                </tr>
              </thead>
              <tbody>
                {reportRows.slice(0, 25).map((r) => (
                  <tr key={r.id}>
                    <td className={`${tableCls.td} font-bold`} title={r.reportType}>
                      {r.reportLabel}
                    </td>
                    <td className={tableCls.td}>{r.shop}</td>
                    <td className={`${tableCls.td} font-mono text-[11.5px]`}>{r.period}</td>
                    <td className={tableCls.td}>
                      <Chip tone={toneChip[r.tone]}>{r.statusLabel}</Chip>
                    </td>
                    <td className={tableCls.tdNum}>{r.rowsImported ?? "—"}</td>
                    <td className={tableCls.tdNum}>{r.attempts}</td>
                    <td className={`${tableCls.tdNum} ${r.isStale ? "font-bold text-amber" : ""}`}>
                      {r.ageMinutes === null ? "—" : `${r.ageMinutes} phút`}
                    </td>
                    <td className={`${tableCls.td} text-[11.5px] ${r.lastError ? "text-red" : "text-soft"}`}>
                      {r.lastError ? r.lastError.slice(0, 90) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[12px] text-soft">
              Report FBA dạng daily chỉ được yêu cầu <b>1 lần / 4 giờ</b> cho mỗi loại, nên cron KHÔNG
              xin report mới khi đang chờ — nó poll tiếp đúng reportId cũ (&quot;Lần chạm&quot; tăng là
              bình thường). Chờ quá 6 giờ thì gắn nhãn <b>CHỜ QUÁ LÂU</b>: vào Seller Central xem report
              đó, hoặc chạy <code>npm run worker:reports-pull -- --type=&lt;loại&gt;</code> để poll tay.
            </p>
          </>
        )}
      </Panel>
      <Panel title="Nguyên tắc đồng bộ 3 tầng (đã chốt trong kiến trúc)">
        <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-muted">
          <li>
            <b>Tầng 1 — realtime:</b> notification ORDER_CHANGE / ANY_OFFER_CHANGED /
            LISTINGS_ITEM_* → cập nhật trong vòng giây–phút.
          </li>
          <li>
            <b>Tầng 2 — theo lịch:</b> Orders delta 15–30 phút · FBA Inventory 30–60
            phút · tôn trọng rate limit từng endpoint.
          </li>
          <li>
            <b>Tầng 3 — đối soát 2h sáng:</b> Reports API (All Orders, Sales &amp;
            Traffic, Settlement) → chốt kpi_daily 6h sáng.
          </li>
        </ul>
      </Panel>
    </>
  );
}
