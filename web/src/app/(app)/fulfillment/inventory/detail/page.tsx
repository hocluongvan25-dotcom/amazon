import { Bars, Chip, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { readInventoryLatest } from "@/lib/data/inventory";
import { mapInventoryRow, type InventoryLatestRaw } from "@/lib/data/inventory-model";
import { inventoryDetails, inventoryRows } from "@/lib/data/mock";
import type { PersonaKey } from "@/lib/roles";

const ALLOWED: PersonaKey[] = ["ceo", "lead_fulfill"];

/** I2 chi tiết tồn SKU — supabase mode */
async function LiveInventoryDetail({ sku }: { sku: string }) {
  let rawRows: InventoryLatestRaw[] = [];
  let failed = false;

  try {
    rawRows = await readInventoryLatest();
  } catch {
    failed = true;
  }

  const allRows = rawRows.map(mapInventoryRow);
  const row = allRows.find((r) => r.sku === sku);
  const raw = rawRows.find((r) => r.sku === sku);

  if (failed) {
    return (
      <>
        <div className="mb-3 text-sm font-bold text-accent-ink">
          SUPABASE · dữ liệu thật
        </div>
        <PageHeader
          title={`Tồn kho — ${sku}`}
          sub="Không tải được dữ liệu"
        />
        <Panel title="Lỗi">
          <p role="alert">
            Không thể đọc Supabase. Kiểm tra migration 0011, quyền SELECT,
            RLS và phiên đăng nhập rồi tải lại.
          </p>
        </Panel>
      </>
    );
  }

  if (!row || !raw) {
    return (
      <>
        <div className="mb-3 text-sm font-bold text-accent-ink">
          SUPABASE · dữ liệu thật
        </div>
        <PageHeader title={`Tồn kho — ${sku}`} sub="Không tìm thấy SKU" />
        <Panel title="Không tìm thấy">
          <p className="text-[13px] text-muted">
            SKU chưa có dữ liệu trong vexim_inventory_latest. Kiểm tra lại
            mã SKU hoặc chờ worker đồng bộ.
          </p>
        </Panel>
      </>
    );
  }

  // Tính thời gian cập nhật
  const now = new Date();
  const capturedAt = raw.captured_at ? new Date(raw.captured_at) : null;
  const minutesAgo = capturedAt
    ? Math.round((now.getTime() - capturedAt.getTime()) / 60000)
    : null;

  return (
    <>
      <div className="mb-3 text-sm font-bold text-accent-ink">
        SUPABASE · dữ liệu thật từ vexim_inventory_latest
      </div>
      <PageHeader
        title={`Tồn kho — ${sku}`}
        sub={`${raw.asin ?? "—"} · ${raw.shop} · cập nhật ${minutesAgo !== null ? `${minutesAgo} phút` : "—"} trước`}
        desc="Nguồn: snapshots (getInventorySummaries) · phân bổ FC: GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA · nhận hàng: GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA."
      />
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Khả dụng / Reserved", value: `${row.fulfillable} / ${row.reserved}`, sub: "đơn vị" },
          { label: "Đang về (inbound)", value: `${row.inbound}`, sub: "lô đang trên đường" },
          { label: "Days of cover", value: row.coverDays === null ? "—" : `${row.coverDays} ngày`, sub: `velocity ${row.velocity}/ngày (14 ngày)` },
          { label: "Đề xuất nhập", value: row.suggest === null ? "Đủ hàng" : `${row.suggest} đơn vị`, sub: "SOP-01" },
        ].map((k) => (
          <div key={k.label} className="rounded-[13px] border border-line bg-card px-4 py-3.5">
            <div className="text-[11.5px] font-bold uppercase tracking-wide text-soft">{k.label}</div>
            <div className="mt-0.5 text-[19px] font-extrabold tracking-tight">{k.value}</div>
            <div className="mt-0.5 truncate text-[11.5px] font-semibold text-soft">{k.sub}</div>
          </div>
        ))}
      </div>
      <Panel title="Phân bổ theo fulfillment center" hint="cần report GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA">
        <p className="text-[13px] text-muted">
          Dữ liệu phân bổ FC chưa có trong vexim_inventory_latest — cần bổ sung view từ
          report GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA (Đợt 2: worker sync report theo FC).
        </p>
      </Panel>
      <Panel title="Lịch sử nhận hàng" hint="cần report GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA">
        <p className="text-[13px] text-muted">
          Dữ liệu nhận hàng chi tiết chưa có — cần bổ sung view từ
          report GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA (Đợt 2: worker sync receipt data).
        </p>
      </Panel>
    </>
  );
}

export default async function InventoryDetailPage({
  searchParams,
}: {
  searchParams: Promise<{ sku?: string }>;
}) {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  const { sku } = await searchParams;

  // Supabase mode → đọc từ vexim_inventory_latest
  if (session.mode === "supabase") {
    return <LiveInventoryDetail sku={sku ?? ""} />;
  }

  // Demo mode → mock data
  const detail = sku ? inventoryDetails[sku] : undefined;
  const row = inventoryRows.find((r) => r.sku === sku);

  return (
    <>
      <div className="mb-3 text-sm font-bold text-amber">DEMO · Dữ liệu minh họa</div>
      <PageHeader
        title={`Tồn kho — ${sku ?? ""}`}
        sub={detail ? `${detail.asin} · FNSKU ${detail.fnsku} · ${detail.shop}` : "Không tìm thấy SKU"}
        desc="Nguồn: snapshots 90 ngày (getInventorySummaries) · phân bổ FC: GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA · nhận hàng: GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA."
      />
      {detail && row ? (
        <>
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: "Khả dụng / Reserved", value: `${row.fulfillable} / ${row.reserved}`, sub: "đơn vị" },
              { label: "Đang về (inbound)", value: `${row.inbound}`, sub: detail.inboundComing.map((i) => `${i.id} · ${i.units} ETA ${i.eta}`).join(" · ") || "—" },
              { label: "Days of cover", value: row.coverDays === null ? "—" : `${row.coverDays} ngày`, sub: `velocity ${row.velocity}/ngày (14 ngày)` },
              { label: "Giá vốn hiện hành", value: detail.unitCost, sub: "bảng cost_inputs (theo kỳ hiệu lực)" },
            ].map((k) => (
              <div key={k.label} className="rounded-[13px] border border-line bg-card px-4 py-3.5">
                <div className="text-[11.5px] font-bold uppercase tracking-wide text-soft">{k.label}</div>
                <div className="mt-0.5 text-[19px] font-extrabold tracking-tight">{k.value}</div>
                <div className="mt-0.5 truncate text-[11.5px] font-semibold text-soft">{k.sub}</div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel title="Tồn kho 90 ngày" hint="inventory_snapshots">
              <Bars data={detail.stock90.map(d => ({ ...d, today: d.label === "T12" }))} />
            </Panel>
            <Panel title="Doanh số 90 ngày" hint="đơn vị bán theo tuần">
              <Bars data={detail.sales90} />
            </Panel>
            <Panel title="Phân bổ theo fulfillment center" hint="snapshot hằng ngày">
              <table className={tableCls.table}>
                <thead>
                  <tr>
                    <th className={tableCls.th}>FC</th>
                    <th className={`${tableCls.th} text-right`}>Số lượng</th>
                    <th className={tableCls.th}>Trạng thái</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.fcAllocation.map((f, i) => (
                    <tr key={i}>
                      <td className={`${tableCls.td} font-bold`}>{f.fc}</td>
                      <td className={tableCls.tdNum}>{f.units}</td>
                      <td className={tableCls.td}>
                        <Chip tone={f.disposition.startsWith("Khả dụng") ? "green" : "amber"}>
                          {f.disposition}
                        </Chip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
            <Panel title="Lịch sử nhận hàng" hint="đối soát thực nhận vs kế hoạch">
              <table className={tableCls.table}>
                <thead>
                  <tr>
                    <th className={tableCls.th}>Ngày</th>
                    <th className={tableCls.th}>Shipment</th>
                    <th className={`${tableCls.th} text-right`}>Kế hoạch</th>
                    <th className={`${tableCls.th} text-right`}>Thực nhận</th>
                    <th className={tableCls.th}>Kết quả</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.receipts.map((r, i) => {
                    const gap = r.expected - r.received;
                    return (
                      <tr key={i}>
                        <td className={tableCls.td}>{r.date}</td>
                        <td className={`${tableCls.td} font-mono text-[12px]`}>{r.shipment}</td>
                        <td className={tableCls.tdNum}>{r.expected}</td>
                        <td className={tableCls.tdNum}>{r.received}</td>
                        <td className={tableCls.td}>
                          <Chip tone={gap === 0 ? "green" : "red"}>
                            {gap === 0 ? "Đủ" : `Thiếu ${gap} → SOP-09`}
                          </Chip>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Panel>
          </div>
        </>
      ) : (
        <Panel title="Không tìm thấy">
          <p className="text-[13px] text-muted">
            SKU chưa có dữ liệu chi tiết trong DEMO MODE — thử{" "}
            <a href="/fulfillment/inventory/detail?sku=XMO-950-BLK" className="font-bold text-blue underline underline-offset-2">
              XMO-950-BLK
            </a>
            .
          </p>
        </Panel>
      )}
    </>
  );
}
