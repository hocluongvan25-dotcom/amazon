import { Chip, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { priceApprovalQueue } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo"];

function usd(v: number) {
  return `$${v.toFixed(2)}`;
}

export default async function PriceApprovalPage({
  searchParams,
}: {
  searchParams: Promise<{ sku?: string }>;
}) {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  const sp = await searchParams;
  const filterSku = sp.sku ?? null;

  const autoOk = priceApprovalQueue.filter(
    (a) => a.source === "auto" && Math.abs(a.deltaPct) <= 2 && !a.belowFloor,
  );
  const needLead = priceApprovalQueue.filter(
    (a) => a.belowFloor || Math.abs(a.deltaPct) > 2 || a.source === "manual",
  );
  let rows = filterSku ? priceApprovalQueue.filter((a) => a.sku === filterSku) : priceApprovalQueue;
  rows = [...rows].sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));

  return (
    <>
      <PageHeader
        title="Duyệt & áp giá"
        sub={`${priceApprovalQueue.length} đề xuất chờ duyệt`}
        desc="Mọi thay đổi giá đi qua P3: kiểm tra giá sàn → phân quyền duyệt (% ≤2 operator tự duyệt, >2% hoặc dưới sàn trưởng phòng) → patchListingsItem / JSON_LISTINGS_FEED → ghi audit + rollback được."
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <a href="/pricing" className="rounded-full border border-line bg-card px-4 py-1.5 text-[12.5px] font-bold text-muted transition hover:border-accent hover:text-accent-ink">
          ← Bảng giá P1
        </a>
        {filterSku ? (
          <a href="/pricing/approve" className="rounded-full border border-line bg-card px-4 py-1.5 text-[12.5px] font-bold text-muted">
            × Thoát lọc theo SKU
          </a>
        ) : null}
      </div>

      {/* Thống kê luồng */}
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-[13px] border border-green/40 bg-green-soft px-4 py-3">
          <div className="text-[11.5px] font-extrabold uppercase text-[#0b7a55]">Operator tự duyệt</div>
          <div className="mt-0.5 text-[23px] font-extrabold text-[#0b7a55]">{autoOk.length}</div>
          <div className="mt-0.5 text-[12px] font-semibold text-[#0b7a55]">|Δ| ≤ 2% · không dưới sàn · auto-source</div>
        </div>
        <div className="rounded-[13px] border border-amber/40 bg-amber-soft px-4 py-3">
          <div className="text-[11.5px] font-extrabold uppercase text-[#8a5602]">Cần trưởng phòng duyệt</div>
          <div className="mt-0.5 text-[23px] font-extrabold text-[#8a5602]">{needLead.length}</div>
          <div className="mt-0.5 text-[12px] font-semibold text-[#8a5602]">|Δ| &gt; 2% · hoặc đề xuất thủ công · hoặc dưới sàn</div>
        </div>
        <div className="rounded-[13px] border border-line bg-card px-4 py-3">
          <div className="text-[11.5px] font-extrabold uppercase text-soft">Tổng chờ xử lý</div>
          <div className="mt-0.5 text-[23px] font-extrabold">{priceApprovalQueue.length}</div>
          <div className="mt-0.5 text-[12px] font-semibold text-soft">cập nhật 5 phút trước</div>
        </div>
      </div>

      <Panel title={`${rows.length} đề xuất`} hint={filterSku ? `lọc theo SKU ${filterSku}` : "sắp xếp theo |Δ%| giảm dần"}>
        <table className={tableCls.table}>
          <thead>
            <tr>
              <th className={tableCls.th}>Mã</th>
              <th className={tableCls.th}>SKU / ASIN</th>
              <th className={tableCls.th}>Shop</th>
              <th className={tableCls.th}>Giá cũ → mới</th>
              <th className={`${tableCls.th} text-right`}>Δ</th>
              <th className={tableCls.th}>Nguồn / lý do</th>
              <th className={tableCls.th}>Người yêu cầu</th>
              <th className={`${tableCls.th} text-right`}>Biên sau</th>
              <th className={tableCls.th}>Duyệt</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const needsLead = a.belowFloor || Math.abs(a.deltaPct) > 2 || a.source === "manual";
              const deltaCls =
                a.deltaPct < -2 ? "text-red font-bold" : a.deltaPct < 0 ? "text-amber font-semibold" : "text-green font-semibold";
              return (
                <tr key={a.id}>
                  <td className={tableCls.td}>
                    <span className="font-mono text-[11.5px] text-soft">{a.id}</span>
                  </td>
                  <td className={tableCls.td}>
                    <a href={`/pricing/detail?sku=${a.sku}`} className="font-bold text-blue underline underline-offset-2">
                      {a.sku}
                    </a>
                    <div className="text-[11.5px] text-soft">{a.asin}</div>
                  </td>
                  <td className={tableCls.td}>Shop {a.shop}</td>
                  <td className={tableCls.td}>
                    {usd(a.oldPrice)} →{" "}
                    <span className="font-extrabold text-accent-ink">{usd(a.newPrice)}</span>
                  </td>
                  <td className={`${tableCls.tdNum} ${deltaCls}`}>
                    {a.deltaPct > 0 ? "+" : ""}
                    {a.deltaPct.toFixed(1)}%
                  </td>
                  <td className={tableCls.td}>
                    <Chip tone={a.source === "auto" ? "blue" : "gray"}>{a.source === "auto" ? "auto" : "thủ công"}</Chip>
                    <div className="mt-0.5 max-w-[260px] truncate text-[11.5px] text-soft">{a.reason}</div>
                  </td>
                  <td className={tableCls.td}>
                    {a.requestedBy}
                    <div className="text-[11px] text-soft">{a.requestedAt}</div>
                  </td>
                  <td className={`${tableCls.tdNum} ${a.minMarginAfter < 0 ? "font-extrabold text-red" : a.minMarginAfter < 10 ? "font-bold text-amber" : "text-green font-semibold"}`}>
                    {a.minMarginAfter.toFixed(1)}%
                    {a.belowFloor ? <div className="text-[11px] text-red">dưới sàn</div> : null}
                  </td>
                  <td className={tableCls.td}>
                    {needsLead ? (
                      <div className="flex flex-col gap-1">
                        <button
                          disabled
                          title="Trưởng phòng duyệt — kích hoạt khi có auth thật"
                          className="h-7 cursor-not-allowed rounded-md border border-dashed border-line px-2 text-[11px] font-bold text-soft"
                        >
                          🧑‍💼 Trưởng phòng duyệt
                        </button>
                        <button
                          disabled
                          title="Từ chối"
                          className="h-7 cursor-not-allowed rounded-md border border-dashed border-line px-2 text-[11px] font-bold text-soft"
                        >
                          Từ chối
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <button
                          disabled
                          title="Operator tự duyệt — kích hoạt khi có auth thật"
                          className="h-7 cursor-not-allowed rounded-md border border-green/50 bg-green-soft px-2 text-[11px] font-bold text-[#0b7a55]"
                        >
                          ✓ Áp (operator)
                        </button>
                        <button
                          disabled
                          className="h-7 cursor-not-allowed rounded-md border border-dashed border-line px-2 text-[11px] font-bold text-soft"
                        >
                          Lên trưởng phòng
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>

      <div className="rounded-[13px] border border-line bg-card px-4 py-3 text-[12.5px] text-muted">
        <p className="font-bold">Quy tắc SOP-02 (Giá & Buy Box):</p>
        <ul className="mt-1.5 ml-4 list-disc space-y-0.5">
          <li>Mọi thay đổi giá đều ghi vào <code className="rounded bg-bg px-1">audit_log</code> (actor, SKU, cũ→mới, lý do, kết quả).</li>
          <li>Giá áp không được thấp hơn giá sàn — hệ thống chặn tự động, chỉ trưởng phòng mới override được (có bắt buộc lý do).</li>
          <li>Auto-rule chỉ đề xuất, không tự áp — trừ phi có bật P4 và đã được duyệt tự động trong khoảng biên an toàn.</li>
          <li>Sau khi áp: gọi <code className="rounded bg-bg px-1">patchListingsItem</code> cho 1 SKU, hoặc <code className="rounded bg-bg px-1">JSON_LISTINGS_FEED</code> cho hàng loạt &gt;100 SKU.</li>
          <li>Rollback: trong 30 phút có thể hoàn tác 1-click (hệ thống giữ giá cũ).</li>
        </ul>
      </div>

      <p className="mt-3 text-[11.5px] font-semibold text-soft">
        Trang này ở chế độ DEMO (chưa gắn auth thật + Supabase) — các nút hiện bị khóa để minh họa luồng. Khi có
        Supabase: button sẽ call server action phân quyền theo vai trò đăng nhập, ghi audit và gọi SP-API thật.
      </p>
    </>
  );
}
