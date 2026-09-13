import { Bars, Chip, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo"];

type ApiUsageRow = {
  seller_account_id: string;
  shop: string;
  day: string;
  api_group: string;
  calls: number;
};

type SummaryRow = {
  api_group: string;
  calls_today: number;
  shops: number;
  latest_day: string | null;
};

async function readApiUsage(): Promise<
  | { ok: true; daily: ApiUsageRow[]; summary: SummaryRow[] }
  | { ok: false; message: string }
> {
  const client = await createClient();
  if (!client) return { ok: false, message: "Supabase unavailable" };

  // Thử view tổng hợp trước (nhanh), fallback sang RPC theo ngày
  const [dailyRes, summaryRes] = await Promise.all([
    client
      .from("vexim_api_usage_daily")
      .select("seller_account_id,shop,day,api_group,calls")
      .order("day", { ascending: false })
      .order("calls", { ascending: false })
      .limit(200),
    client.from("vexim_api_usage_summary").select("api_group,calls_today,shops,latest_day").limit(50),
  ]);

  if (dailyRes.error && summaryRes.error) {
    return { ok: false, message: dailyRes.error.message || summaryRes.error.message };
  }

  const daily = (dailyRes.data ?? []) as ApiUsageRow[];
  const summary = (summaryRes.data ?? []) as SummaryRow[];

  // Nếu summary view rỗng nhưng daily có dữ liệu, tự tổng hợp hôm nay
  if (summary.length === 0 && daily.length > 0) {
    const today = new Date().toISOString().slice(0, 10);
    const todayRows = daily.filter((r) => r.day === today);
    const map = new Map<string, { calls: number; shops: Set<string> }>();
    for (const r of todayRows) {
      const g = map.get(r.api_group) ?? { calls: 0, shops: new Set<string>() };
      g.calls += r.calls;
      g.shops.add(r.seller_account_id);
      map.set(r.api_group, g);
    }
    const fallback: SummaryRow[] = [...map.entries()].map(([api_group, v]) => ({
      api_group,
      calls_today: v.calls,
      shops: v.shops.size,
      latest_day: today,
    }));
    return { ok: true, daily, summary: fallback };
  }

  return { ok: true, daily, summary };
}

export default async function ApiUsagePage() {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  let daily: ApiUsageRow[] = [];
  let summary: SummaryRow[] = [];
  let failed = false;
  let noSupabase = false;
  let message = "";

  if (session.mode === "supabase") {
    const res = await readApiUsage();
    if (res.ok) {
      daily = res.daily;
      summary = res.summary;
    } else {
      if (res.message === "Supabase unavailable") noSupabase = true;
      else {
        failed = true;
        message = res.message;
      }
    }
  }

  const totalToday = summary.reduce((s, r) => s + (r.calls_today ?? 0), 0);
  const maxCalls = Math.max(1, ...summary.map((r) => r.calls_today ?? 0));

  return (
    <>
      <PageHeader
        title="Mức dùng API & chi phí"
        sub={
          session.mode !== "supabase"
            ? "chế độ demo — không có usage thật"
            : noSupabase
              ? "chưa nối Supabase"
              : failed
                ? `không đọc được api_usage_daily: ${message.slice(0, 100)}`
                : `Hôm nay · ${totalToday} calls · ${summary.length} nhóm API · ${daily.length} dòng chi tiết`
        }
        desc="Thống kê lượng gọi API Amazon của hệ thống theo ngày và theo nhóm chức năng — theo dõi để tránh chạm giới hạn tốc độ của Amazon."
      />

      {session.mode !== "supabase" ? (
        <Panel title="Chế độ demo" hint="không có usage thật">
          <p className="text-[13px] text-muted">
            Chế độ demo không có kết nối Supabase nên không có mức dùng API thật. Khi chạy production, worker ghi số lần gọi API vào <code>connections.api_usage_daily</code> (upsert theo shop/ngày/nhóm) và màn này hiện biểu đồ + chi tiết.
          </p>
        </Panel>
      ) : noSupabase ? (
        <Panel title="Chưa nối Supabase" hint="thiếu env">
          <p className="text-[13px] text-muted">
            <b className="text-amber">Chưa nối Supabase</b> — không đọc được usage thật.
          </p>
        </Panel>
      ) : failed ? (
        <Panel title="Không đọc được dữ liệu" hint="kiểm tra migration 0023">
          <p className="text-[13px] text-muted">
            <b className="text-amber">Không đọc được vexim_api_usage_daily</b> — {message}
            <br />
            Kiểm tra đã chạy migration 0023 (policy <code>rls_read_api_usage</code> + view) và worker đã ghi qua <code>vexim_worker_record_api_usage</code>.
          </p>
        </Panel>
      ) : daily.length === 0 ? (
        <Panel title="Chưa có dữ liệu" hint="worker chưa ghi">
          <p className="text-[13px] text-muted">
            Chưa có dòng nào trong <code>connections.api_usage_daily</code>. Worker bắt đầu ghi từ sau migration 0023 mỗi khi gọi SP-API (inventory, reports…). Nếu vừa deploy, chạy thử <code>inventory-sync</code> hoặc <code>report-pull</code> rồi quay lại.
          </p>
          <p className="mt-2 text-[12px] text-soft">
            Gợi ý: <code>SELECT * FROM connections.api_usage_daily ORDER BY day DESC LIMIT 20</code> để kiểm tra trực tiếp.
          </p>
        </Panel>
      ) : (
        <>
          <Panel title="Calls theo nhóm API — hôm nay" hint={`${totalToday} calls tổng · ${summary.length} nhóm`}>
            <Bars
              data={summary.map((r) => ({
                label: r.api_group,
                pct: Math.round(((r.calls_today ?? 0) / maxCalls) * 100),
              }))}
            />
          </Panel>

          <Panel title="Chi tiết hôm nay" hint="tổng hợp từ api_usage_daily">
            <table className={tableCls.table}>
              <thead>
                <tr>
                  <th className={tableCls.th}>Nhóm API</th>
                  <th className={`${tableCls.th} text-right`}>Calls hôm nay</th>
                  <th className={`${tableCls.th} text-right`}>Số shop</th>
                  <th className={tableCls.th}>Ngày mới nhất</th>
                  <th className={tableCls.th}>Đánh giá</th>
                </tr>
              </thead>
              <tbody>
                {summary.map((r) => (
                  <tr key={r.api_group}>
                    <td className={`${tableCls.td} font-bold`}>{r.api_group}</td>
                    <td className={tableCls.tdNum}>{r.calls_today}</td>
                    <td className={tableCls.tdNum}>{r.shops}</td>
                    <td className={tableCls.td}>{r.latest_day ?? "—"}</td>
                    <td className={tableCls.td}>
                      <Chip tone={r.calls_today > 1000 ? "amber" : "green"}>
                        {r.calls_today > 1000 ? "cao" : "ổn định"}
                      </Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          <Panel title="Chi tiết theo ngày/shop/nhóm" hint={`${daily.length} dòng gần nhất · api_usage_daily`}>
            <div className="overflow-x-auto">
              <table className={tableCls.table}>
                <thead>
                  <tr>
                    <th className={tableCls.th}>Ngày</th>
                    <th className={tableCls.th}>Shop</th>
                    <th className={tableCls.th}>Nhóm API</th>
                    <th className={`${tableCls.th} text-right`}>Calls</th>
                  </tr>
                </thead>
                <tbody>
                  {daily.slice(0, 100).map((r, i) => (
                    <tr key={`${r.seller_account_id}-${r.day}-${r.api_group}-${i}`}>
                      <td className={tableCls.td}>{r.day}</td>
                      <td className={tableCls.td}>{r.shop}</td>
                      <td className={`${tableCls.td} font-bold`}>{r.api_group}</td>
                      <td className={tableCls.tdNum}>{r.calls}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </>
  );
}
