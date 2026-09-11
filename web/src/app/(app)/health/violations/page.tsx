import { Chip, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { healthViolations } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo"];

const sevTone: Record<string, "red" | "amber" | "gray"> = {
  Critical: "red",
  High: "red",
  Medium: "amber",
  Low: "gray",
};

export default async function HealthViolationsPage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  return (
    <>
      <PageHeader
        title="Chi tiết vấn đề tài khoản"
        sub="4 vấn đề mở · 2 shop bị ảnh hưởng"
        desc="Nguồn: GET_V1_SELLER_PERFORMANCE_REPORT (Selling Partner Insights) + ACCOUNT_STATUS_CHANGED. Mỗi vấn đề xử lý theo SOP-08."
      />
      <Panel title="Vấn đề đang mở" hint="xếp theo mức nghiêm trọng">
        <table className={tableCls.table}>
          <thead>
            <tr>
              <th className={tableCls.th}>Loại vi phạm</th>
              <th className={tableCls.th}>Mức độ</th>
              <th className={tableCls.th}>Shop</th>
              <th className={tableCls.th}>Mở ngày</th>
              <th className={tableCls.th}>Trạng thái</th>
              <th className={tableCls.th}>Người xử lý</th>
              <th className={tableCls.th}>Case</th>
            </tr>
          </thead>
          <tbody>
            {healthViolations.map((v) => (
              <tr key={v.caseId}>
                <td className={`${tableCls.td} font-bold`}>{v.type}</td>
                <td className={tableCls.td}>
                  <Chip tone={sevTone[v.severity]}>{v.severity}</Chip>
                </td>
                <td className={tableCls.td}>{v.shop}</td>
                <td className={tableCls.td}>{v.opened}</td>
                <td className={tableCls.td}>{v.status}</td>
                <td className={tableCls.td}>{v.owner}</td>
                <td className={`${tableCls.td} font-mono text-[12px]`}>
                  {v.caseId}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel title="Lưu ý vận hành (SOP-08)">
        <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-muted">
          <li>
            Vi phạm <b>Critical</b> = AHR về 0, có 3 ngày xử lý trước khi
            tài khoản bị deactivate — cảnh báo đỏ ngay trên dashboard.
          </li>
          <li>
            Mọi appeal nộp qua Seller Central; hệ thống theo dõi case và nhắc
            đẩy lại mỗi 48h nếu chưa có phản hồi.
          </li>
          <li>
            Sau khi đóng: post-mortem + bổ sung alert_rules để phòng ngừa tái
            diễn (bước cuối SOP-08).
          </li>
        </ul>
      </Panel>
    </>
  );
}
