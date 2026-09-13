import { Chip, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
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

type SyncJobRow = {
  id: string;
  shop: string;
  seller_account_id: string;
  job_type: string;
  status: string;
  attempts: number | null;
  last_error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string | null;
  age_minutes: number | null;
};

async function readSyncJobs(): Promise<
  | { ok: true; jobs: SyncJobRow[] }
  | { ok: false; message: string }
> {
  const client = await createClient();
  if (!client) return { ok: false, message: "Supabase unavailable" };
  const { data, error } = await client
    .from("vexim_sync_jobs")
    .select("id,seller_account_id,shop,job_type,status,attempts,last_error,started_at,finished_at,created_at,age_minutes")
    .order("started_at", { ascending: false })
    .limit(100);
  if (error) return { ok: false, message: error.message };
  return { ok: true, jobs: (data ?? []) as SyncJobRow[] };
}

function fmtAge(min: number | null): string {
  if (min === null || min === undefined) return "—";
  const m = Math.round(min);
  if (m < 60) return `${m} phút trước`;
  if (m < 1440) return `${Math.floor(m / 60)} giờ ${m % 60} phút`;
  return `${Math.floor(m / 1440)} ngày`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("vi-VN", { hour12: false });
  } catch {
    return iso.slice(0, 19);
  }
}

export default async function SyncHealthPage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  // Sync jobs thật từ connections.sync_jobs (qua view vexim_sync_jobs)
  let syncRows: SyncJobRow[] = [];
  let syncFailed = false;
  let syncNoSupabase = false;
  let syncMessage = "";
  if (session.mode === "supabase") {
    const res = await readSyncJobs();
    if (res.ok) syncRows = res.jobs;
    else {
      if (res.message === "Supabase unavailable") syncNoSupabase = true;
      else {
        syncFailed = true;
        syncMessage = res.message;
      }
    }
  }

  // Report requests (đã thật từ trước)
  let reportRows: ReportRequestUiRow[] = [];
  let reportFailed = false;
  let reportNoSupabase = false;
  try {
    reportRows = (await readReportRequests()).map(mapReportRequestRow);
  } catch (err) {
    if (err instanceof Error && err.message === "Supabase unavailable") reportNoSupabase = true;
    else reportFailed = true;
  }
  const stale = reportRows.filter((r) => r.isStale).length;
  const failedReports = reportRows.filter((r) => r.tone === "down").length;

  return (
    <>
      <PageHeader
        title="Sức khỏe đồng bộ"
        sub="sync_jobs · report_requests · cập nhật realtime"
        desc="Trường hợp dữ liệu không mới phải thấy ngay tại đây: từng job, độ trễ, số lần retry, lỗi gần nhất."
      />

      <Panel
        title="Job đồng bộ gần nhất"
        hint={
          session.mode !== "supabase"
            ? "chế độ demo — không có job thật"
            : syncNoSupabase
              ? "chưa nối Supabase"
              : syncFailed
                ? `không đọc được vexim_sync_jobs: ${syncMessage.slice(0, 120)}`
                : `${syncRows.length} job gần nhất · connections.sync_jobs · worker ghi thật`
        }
      >
        {session.mode !== "supabase" ? (
          <p className="text-[13px] text-muted">
            Chế độ demo không có job thật. Khi chạy production, worker ghi mỗi lần bắt đầu/kết thúc vào <code>connections.sync_jobs</code> và bảng này hiện ở đây.
          </p>
        ) : syncNoSupabase ? (
          <p className="text-[13px] text-muted">
            <b className="text-amber">Chưa nối Supabase</b> — không đọc được job thật.
          </p>
        ) : syncFailed ? (
          <p className="text-[13px] text-muted">
            <b className="text-amber">Không đọc được vexim_sync_jobs</b> — kiểm tra migration 0023 và RLS <code>rls_read_sync_jobs</code>. Worker vẫn ghi bằng service_role, nhưng view cần quyền <code>can_read_seller_account</code>.
          </p>
        ) : syncRows.length === 0 ? (
          <p className="text-[13px] text-muted">
            Chưa có job nào được ghi. Worker ghi <code>sync_jobs</code> mỗi khi chạy <code>inventory.pull</code>, <code>report.pull</code>, <code>ads.sync</code>… Kiểm tra cron và <code>seller_accounts data_source=production</code>.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableCls.table}>
              <thead>
                <tr>
                  <th className={tableCls.th}>Job</th>
                  <th className={tableCls.th}>Shop</th>
                  <th className={tableCls.th}>Trạng thái</th>
                  <th className={`${tableCls.th} text-right`}>Bắt đầu</th>
                  <th className={`${tableCls.th} text-right`}>Kết thúc</th>
                  <th className={tableCls.th}>Độ trễ</th>
                  <th className={`${tableCls.th} text-right`}>Retry</th>
                  <th className={tableCls.th}>Lỗi</th>
                </tr>
              </thead>
              <tbody>
                {syncRows.map((j) => (
                  <tr key={j.id}>
                    <td className={`${tableCls.td} font-bold`}>{j.job_type}</td>
                    <td className={tableCls.td}>{j.shop}</td>
                    <td className={tableCls.td}>
                      <Chip tone={statusChip[j.status] ?? "gray"}>{j.status}</Chip>
                    </td>
                    <td className={tableCls.tdNum}>{fmtTime(j.started_at ?? j.created_at)}</td>
                    <td className={tableCls.tdNum}>{fmtTime(j.finished_at)}</td>
                    <td className={tableCls.td}>{fmtAge(j.age_minutes)}</td>
                    <td className={`${tableCls.tdNum} ${Number(j.attempts ?? 0) > 0 ? "font-bold text-amber" : ""}`}>
                      {j.attempts ?? 0}
                    </td>
                    <td className={`${tableCls.td} max-w-[260px] truncate text-[11.5px] ${j.last_error ? "text-red" : "text-soft"}`} title={j.last_error ?? undefined}>
                      {j.last_error ? j.last_error.slice(0, 120) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
