import {
  Bars,
  Chip,
  KpiCard,
  KpiGrid,
  NoAccess,
  PageHeader,
  Panel,
  tableCls,
} from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { ceoKpis, redShops, revenue14d } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo"];

export default async function DashboardPage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  return (
    <>
      <PageHeader
        title="Tổng quan"
        sub="Hôm qua · 14 shop · cập nhật 06:00"
        desc="Số liệu chốt từ bảng kpi_daily (đồng bộ từ SP-API). Mỗi con số trả lời câu hỏi: hôm nay phải làm gì?"
      />
      <KpiGrid>
        {ceoKpis.map((k) => (
          <KpiCard key={k.label} {...k} />
        ))}
      </KpiGrid>
      <Panel title="Doanh thu 14 ngày gần nhất" hint="toàn bộ shop · USD">
        <Bars data={revenue14d} />
      </Panel>
      <Panel title="Shop &quot;đỏ&quot; hôm nay" hint="xếp theo mức ảnh hưởng doanh thu">
        <table className={tableCls.table}>
          <thead>
            <tr>
              <th className={tableCls.th}>Shop</th>
              <th className={tableCls.th}>Vấn đề</th>
              <th className={tableCls.th}>Ảnh hưởng</th>
              <th className={tableCls.th}>Phòng phụ trách</th>
              <th className={tableCls.th}>Trạng thái</th>
            </tr>
          </thead>
          <tbody>
            {redShops.map((s) => (
              <tr key={s.shop}>
                <td className={`${tableCls.td} font-bold`}>{s.shop}</td>
                <td className={tableCls.td}>{s.issue}</td>
                <td className={tableCls.tdNum}>{s.impact}</td>
                <td className={tableCls.td}>{s.dept}</td>
                <td className={tableCls.td}>
                  <Chip tone={s.tone === "red" ? "red" : "amber"}>
                    {s.status}
                  </Chip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
