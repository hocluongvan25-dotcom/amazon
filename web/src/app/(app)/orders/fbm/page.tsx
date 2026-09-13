import { LiveOperations } from "@/components/operations/LiveOperations";
import { Chip, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { fbmQueue } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo"];

export default async function FbmQueuePage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;
  if (session.mode === "supabase") return <LiveOperations screen="fbm" />;

  return (
    <>
      <div className="mb-3 text-sm font-bold text-amber">DEMO · Dữ liệu minh họa</div>
      <PageHeader
        title="Queue FBM — chờ xác nhận"
        sub="4 đơn · 1 đơn quá hạn"
        desc="Hàng đợi đơn tự giao hàng (FBM) với đồng hồ đếm ngược thời hạn ship từng đơn — ưu tiên xử lý đơn gấp để không trễ hạn với Amazon."
      />
      <Panel title="Đơn chờ xử lý" hint="xếp theo hạn ship gần nhất">
        <table className={tableCls.table}>
          <thead>
            <tr>
              <th className={tableCls.th}>Mã đơn</th>
              <th className={tableCls.th}>Shop</th>
              <th className={tableCls.th}>Hạn ship</th>
              <th className={tableCls.th}>Đếm ngược</th>
              <th className={tableCls.th}>Trạng thái</th>
            </tr>
          </thead>
          <tbody>
            {fbmQueue.map((f) => (
              <tr key={f.id}>
                <td className={`${tableCls.td} font-mono text-[12px] font-bold`}>{f.id}</td>
                <td className={tableCls.td}>{f.shop}</td>
                <td className={tableCls.td}>{f.deadline}</td>
                <td className={`${tableCls.td} font-extrabold ${f.late ? "text-red" : "text-amber"}`}>
                  {f.countdown}
                </td>
                <td className={tableCls.td}>
                  <Chip tone={f.late ? "red" : "amber"}>
                    {f.late ? "QUÁ HẠN" : "Trong hạn"}
                  </Chip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel title="Nguyên tắc (SOP-06)">
        <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-muted">
          <li>Xác nhận đơn theo thứ tự hạn; đơn quá hạn đẩy lên đầu + cảnh báo đỏ.</li>
          <li>Gửi tracking xong đánh dấu tại hệ thống — ảnh hưởng chỉ số Late Shipment Rate (&lt; 4%).</li>
          <li>Tin nhắn buyer liên quan: trả lời trong 24h (log nội bộ — SP-API không đọc hộp thư).</li>
        </ul>
      </Panel>
    </>
  );
}
