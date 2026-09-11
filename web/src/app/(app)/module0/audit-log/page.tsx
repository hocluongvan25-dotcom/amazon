import { Chip, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { auditLogs } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo"];

export default async function AuditLogPage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  return (
    <>
      <PageHeader
        title="Nhật ký thao tác (audit log)"
        sub="iam.audit_logs · append-only"
        desc="Toàn bộ thao tác ghi ra Amazon (đổi giá, sửa listing, chỉnh campaign) ghi: ai · lúc nào · giá trị trước/sau · kết quả. Bảng không cho update/delete."
      />
      <Panel title="Thao tác gần nhất">
        <table className={tableCls.table}>
          <thead>
            <tr>
              <th className={tableCls.th}>Thời gian</th>
              <th className={tableCls.th}>Người thao tác</th>
              <th className={tableCls.th}>Module</th>
              <th className={tableCls.th}>Hành động</th>
              <th className={tableCls.th}>Đối tượng</th>
              <th className={tableCls.th}>Thay đổi</th>
              <th className={tableCls.th}>Kết quả</th>
            </tr>
          </thead>
          <tbody>
            {auditLogs.map((a, i) => (
              <tr key={i}>
                <td className={tableCls.td}>{a.time}</td>
                <td className={`${tableCls.td} font-bold`}>{a.actor}</td>
                <td className={tableCls.td}>{a.module}</td>
                <td className={`${tableCls.td} font-mono text-[12px]`}>
                  {a.action}
                </td>
                <td className={tableCls.td}>{a.entity}</td>
                <td className={tableCls.td}>{a.change}</td>
                <td className={tableCls.td}>
                  <Chip tone={a.result === "ok" ? "green" : "red"}>
                    {a.result === "ok" ? "OK" : "Lỗi"}
                  </Chip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel title="Quy tắc duyệt theo ngưỡng (đã chốt)">
        <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-muted">
          <li>Đổi giá ≤ 2%: operator tự duyệt · &gt; 2%: trưởng phòng duyệt.</li>
          <li>Tăng budget campaign &gt; 30%/ngày: trưởng phòng duyệt.</li>
          <li>Lô nhập hàng &gt; ngưỡng $: trưởng phòng Kho vận duyệt.</li>
          <li>Mọi thao tác đều ghi audit log — kể cả bị từ chối.</li>
        </ul>
      </Panel>
    </>
  );
}
