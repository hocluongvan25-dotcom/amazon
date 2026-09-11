import { Chip, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { syncJobs } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo"];

const statusChip: Record<string, "green" | "amber" | "gray" | "red"> = {
  done: "green",
  running: "amber",
  pending: "gray",
  failed: "red",
};

export default async function SyncHealthPage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

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
