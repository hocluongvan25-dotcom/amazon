import { Bars, Chip, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { apiUsage } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo"];

export default async function ApiUsagePage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  const total = apiUsage.reduce((s, r) => s + r.callsToday, 0);

  return (
    <>
      <PageHeader
        title="Mức dùng API & chi phí"
        sub={`Hôm nay · ${total} calls · theo dõi để kiểm soát chi phí SP-API 2026`}
        desc="Nguồn: Usage API + bảng connections.api_usage_daily. Worker luôn tôn trọng rate limit (token bucket) của từng endpoint."
      />
      <Panel title="Calls theo nhóm API — hôm nay">
        <Bars
          data={apiUsage.map((r) => ({
            label: r.apiGroup.split(" ")[0],
            pct: Math.round((r.callsToday / Math.max(...apiUsage.map((x) => x.callsToday))) * 100),
          }))}
        />
      </Panel>
      <Panel title="Chi tiết" hint="giới hạn theo docs Amazon hiện hành">
        <table className={tableCls.table}>
          <thead>
            <tr>
              <th className={tableCls.th}>Nhóm API</th>
              <th className={`${tableCls.th} text-right`}>Calls hôm nay</th>
              <th className={tableCls.th}>Rate limit tham chiếu</th>
              <th className={tableCls.th}>Đánh giá</th>
            </tr>
          </thead>
          <tbody>
            {apiUsage.map((r) => (
              <tr key={r.apiGroup}>
                <td className={`${tableCls.td} font-bold`}>{r.apiGroup}</td>
                <td className={tableCls.tdNum}>{r.callsToday}</td>
                <td className={tableCls.td}>{r.quota}</td>
                <td className={tableCls.td}>
                  <Chip tone={r.trend === "ổn định" ? "green" : "amber"}>
                    {r.trend}
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
