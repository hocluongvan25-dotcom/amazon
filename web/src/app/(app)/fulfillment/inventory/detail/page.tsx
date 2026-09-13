import { Bars, Chip, NoAccess, PageHeader, Panel, tableCls } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import { readFcAllocation, readInventoryLatest, readReceipts } from "@/lib/data/inventory";
import { readStorageFees } from "@/lib/data/fees";
import {
  feeByFcForSku,
  feeTrend,
  latestFeeMonth,
  mapStorageFeeRow,
  storageFeesForSku,
  type StorageFeeRaw,
  type StorageFeeUiRow,
} from "@/lib/data/fees-model";
import {
  fcAllocationForSku,
  formatStockValue,
  formatUnitCost,
  mapFcAllocationRow,
  mapInventoryRow,
  mapReceiptRow,
  receiptsForSku,
  summarizeFcAllocation,
  type FcAllocationRaw,
  type InventoryLatestRaw,
  type ReceiptRaw,
} from "@/lib/data/inventory-model";
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

  // 0018: phân bổ FC + lịch sử nhận hàng đọc TÁCH BIỆT. Nếu DB chưa chạy 0018
  // (hoặc chưa nhập report) thì hai khối đó tự giải thích, phần còn lại của I2
  // vẫn phải chạy — không được sập cả trang vì một view mới.
  let fcRaw: FcAllocationRaw[] = [];
  let rxRaw: ReceiptRaw[] = [];
  let fcFailed = false;
  let rxFailed = false;
  try {
    fcRaw = await readFcAllocation();
  } catch {
    fcFailed = true;
  }
  try {
    rxRaw = await readReceipts();
  } catch {
    rxFailed = true;
  }
  // 0019: phí lưu kho của SKU này (report phí KHÔNG có cột SKU → view suy SKU
  // qua FNSKU/ASIN, nên ở đây khớp bằng CẢ BA: sku, fnsku, asin).
  let feeRaw: StorageFeeRaw[] = [];
  let feeFailed = false;
  try {
    feeRaw = await readStorageFees();
  } catch {
    feeFailed = true;
  }

  const fcRows = fcAllocationForSku(fcRaw.map(mapFcAllocationRow), sku);
  const fcSummary = summarizeFcAllocation(fcRows);
  const rxRows = receiptsForSku(rxRaw.map(mapReceiptRow), sku);
  const rxUnits = rxRows.reduce((sum, r) => sum + r.units, 0);

  const allRows = rawRows.map(mapInventoryRow);
  const row = allRows.find((r) => r.sku === sku);
  const raw = rawRows.find((r) => r.sku === sku);

  // FNSKU không có trong vexim_inventory_latest → lấy từ report phân bổ FC (0018),
  // nơi mỗi dòng tồn theo FC đều kèm FNSKU của chính SKU đó.
  const fcRawForSku = fcRaw.find(
    (r) => r.sku.trim().toLowerCase() === sku.trim().toLowerCase() && r.fnsku,
  );
  const feeRows: StorageFeeUiRow[] = storageFeesForSku(feeRaw.map(mapStorageFeeRow), {
    sku,
    fnsku: fcRawForSku?.fnsku ?? null,
    asin: raw?.asin ?? null,
  });
  const feeMonth = latestFeeMonth(feeRows);
  const feeThisMonth = feeMonth ? feeByFcForSku(feeRows, feeMonth) : [];
  const feeMonths = feeTrend(feeRows);
  const feeUnmapped = feeRows.filter((r) => r.skuSource === "none").length;

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
        desc="Hồ sơ tồn kho chi tiết của một SKU: diễn biến tồn theo ngày, phân bổ tại từng kho Amazon và lịch sử nhận hàng."
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
      <Panel
        title="Giá trị tồn kho"
        hint="migration 0017 · giá vốn hiệu lực từ catalog.cost_inputs"
      >
        {row.unitCost === null ? (
          <p className="text-[13px] text-muted">
            <b className="text-amber">Chưa có giá vốn</b> cho SKU này nên chưa định giá được tồn kho — nhập tại{" "}
            <a href="/finance/costs" className="font-bold text-blue underline underline-offset-2">
              Giá vốn (F3)
            </a>. Hệ thống KHÔNG tự ước lượng để tránh báo cáo vốn sai.
          </p>
        ) : (
          <ul className="space-y-1.5 text-[13px] text-muted">
            <li>
              Giá vốn hiệu lực: <b>{formatUnitCost(row)}</b>
              {row.costEffectiveFrom ? ` (áp dụng từ ${row.costEffectiveFrom})` : ""}
              {row.costSource ? ` · nguồn ${row.costSource}` : ""}
            </li>
            <li>
              Khả dụng {row.fulfillable} × giá vốn ={" "}
              <b>{formatStockValue(row.stockValue, row.valueCurrency)}</b>
            </li>
            <li>
              Cộng reserved {row.reserved} + đang về {row.inbound} ={" "}
              <b className="text-accent-ink">
                {formatStockValue(row.totalStockValue, row.valueCurrency)}
              </b>{" "}
              vốn đang nằm ở kho Amazon và trên đường về
            </li>
            <li className="text-[12px] text-soft">
              Tính theo tiền của giá vốn ({row.valueCurrency ?? "—"}), không tự quy đổi sang tiền bán.
            </li>
          </ul>
        )}
      </Panel>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel
          title="Phân bổ theo fulfillment center"
          hint={
            fcSummary.snapshotDate
              ? `report snapshot ${fcSummary.snapshotDate} · vexim_inventory_fc`
              : "report GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA"
          }
        >
          {fcFailed ? (
            <p className="text-[13px] text-muted">
              <b className="text-amber">Chưa đọc được vexim_inventory_fc</b> — kiểm tra đã chạy
              migration 0018 và quyền SELECT chưa. Các khối khác của trang này vẫn dùng dữ liệu thật.
            </p>
          ) : fcRows.length === 0 ? (
            <p className="text-[13px] text-muted">
              Chưa có phân bổ FC của SKU này. Số này <b>không lấy được từ API tồn kho</b> (API chỉ trả
              tổng theo SKU, không tách theo FC) — cần nhập report{" "}
              <b>FBA Daily Inventory History</b>:{" "}
              <code className="text-[12px]">npm run worker:inventory-fc -- --fc=&lt;file.tsv&gt;</code>.
            </p>
          ) : (
            <>
              <table className={tableCls.table}>
                <thead>
                  <tr>
                    <th className={tableCls.th}>FC</th>
                    <th className={`${tableCls.th} text-right`}>Tổng</th>
                    <th className={`${tableCls.th} text-right`}>% của SKU</th>
                    <th className={`${tableCls.th} text-right`}>Bán được</th>
                    <th className={`${tableCls.th} text-right`}>Không bán được</th>
                    <th className={`${tableCls.th} text-right`}>Không rõ</th>
                  </tr>
                </thead>
                <tbody>
                  {fcRows.map((f) => (
                    <tr key={f.fc}>
                      <td className={`${tableCls.td} font-bold`}>{f.fc}</td>
                      <td className={`${tableCls.tdNum} font-bold`}>{f.units}</td>
                      <td className={tableCls.tdNum}>{f.shareLabel}</td>
                      <td className={tableCls.tdNum}>{f.sellable}</td>
                      <td className={tableCls.tdNum}>
                        {f.unsellable > 0 ? (
                          <span className="font-bold text-amber">{f.unsellable}</span>
                        ) : (
                          f.unsellable
                        )}
                      </td>
                      <td className={tableCls.tdNum}>
                        {f.unknown > 0 ? (
                          <span className="text-soft" title="report không ghi disposition cho dòng này">
                            {f.unknown}
                          </span>
                        ) : (
                          f.unknown
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[12px] text-soft">
                Tổng {fcSummary.units} đơn vị ở {fcSummary.fcCount} FC · snapshot {fcSummary.snapshotDate} ·
                bán được {fcSummary.sellable} · không bán được {fcSummary.unsellable}
                {fcSummary.unknown > 0 ? ` · KHÔNG RÕ disposition ${fcSummary.unknown}` : ""}. Số theo
                report (không phải realtime); % NULL nghĩa là tổng tồn của SKU = 0, không phải 0%.
              </p>
            </>
          )}
        </Panel>
        <Panel
          title="Lịch sử nhận hàng"
          hint={
            rxRows.length > 0
              ? `${rxRows.length} lần nhận · vexim_inventory_receipts`
              : "report GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA"
          }
        >
          {rxFailed ? (
            <p className="text-[13px] text-muted">
              <b className="text-amber">Chưa đọc được vexim_inventory_receipts</b> — kiểm tra đã chạy
              migration 0018 và quyền SELECT chưa.
            </p>
          ) : rxRows.length === 0 ? (
            <p className="text-[13px] text-muted">
              Chưa có lần nhận nào của SKU này. Report <b>FBA Received Inventory</b> là nguồn duy nhất
              (Inbound API chỉ mô tả lô đang mở, lô đã CLOSED thì không còn số chi tiết):{" "}
              <code className="text-[12px]">npm run worker:inventory-fc -- --receipts=&lt;file.tsv&gt;</code>.
              Đối soát <b>gửi vs nhận theo lô</b> xem ở{" "}
              <a href="/fulfillment/inbound" className="font-bold text-blue underline underline-offset-2">
                Inbound shipments (I4)
              </a>
              .
            </p>
          ) : (
            <>
              <table className={tableCls.table}>
                <thead>
                  <tr>
                    <th className={tableCls.th}>Ngày nhận</th>
                    <th className={tableCls.th}>Lô (shipment)</th>
                    <th className={tableCls.th}>FC</th>
                    <th className={`${tableCls.th} text-right`}>Thực nhận</th>
                  </tr>
                </thead>
                <tbody>
                  {rxRows.map((r, i) => (
                    <tr key={`${r.date}-${r.shipment ?? "no-shipment"}-${i}`}>
                      <td className={tableCls.td}>{r.dateLabel}</td>
                      <td className={`${tableCls.td} font-mono text-[12px]`}>
                        {r.shipment ?? <span className="text-soft">không gắn lô</span>}
                      </td>
                      <td className={tableCls.td}>{r.fc ?? <span className="text-soft">—</span>}</td>
                      <td className={`${tableCls.tdNum} font-bold`}>{r.units}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[12px] text-soft">
                Đã nhận {rxUnits} đơn vị qua {rxRows.length} lần · gần nhất {rxRows[0]?.date ?? "—"}.
                Đây là số Amazon THỰC nhận; số gửi kế hoạch nằm ở lô (I4) — report này không có cột
                &quot;số gửi&quot; nên không tự suy ra ở đây.
              </p>
            </>
          )}
        </Panel>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* 0019 — PHÍ LƯU KHO CỦA SKU NÀY: nằm ở FC nào thì tốn bao nhiêu tiền  */}
      {/* ------------------------------------------------------------------ */}
      <Panel
        title="Phí lưu kho theo FC"
        hint={
          feeMonth
            ? `kỳ ${feeMonth} · report GET_FBA_STORAGE_FEE_CHARGES_DATA`
            : "report GET_FBA_STORAGE_FEE_CHARGES_DATA (chưa có dữ liệu)"
        }
      >
        {feeFailed ? (
          <p className="text-[13px] text-muted">
            <b className="text-amber">Chưa đọc được vexim_storage_fees</b> — kiểm tra đã chạy
            migration 0019 và quyền SELECT chưa. Các khối khác của trang này vẫn dùng dữ liệu thật.
          </p>
        ) : feeRows.length === 0 ? (
          <p className="text-[13px] text-muted">
            Chưa có phí lưu kho của SKU này. Phí lưu kho <b>không có trong API tồn kho</b> — Amazon chỉ
            đưa qua report tháng. Kéo bằng{" "}
            <code className="text-[12px]">npm run worker:reports-pull -- --type=storage-fees</code> hoặc
            nạp file <code className="text-[12px]">--storage-fees=&lt;file.tsv&gt;</code>.
          </p>
        ) : (
          <>
            {feeUnmapped > 0 ? (
              <p className="mb-2 text-[12.5px] text-amber">
                {feeUnmapped} dòng phí chưa gắn được SKU trong catalog — hệ thống khớp theo FNSKU/ASIN
                của report. Kiểm tra lại FNSKU trong report phân bổ FC (0018) hoặc ASIN trong catalog để
                gắn chắc chắn hơn.
              </p>
            ) : null}
            <table className={tableCls.table}>
              <thead>
                <tr>
                  <th className={tableCls.th}>Kỳ</th>
                  <th className={tableCls.th}>FC</th>
                  <th className={`${tableCls.th} text-right`}>Phí lưu kho</th>
                  <th className={`${tableCls.th} text-right`}>Rate</th>
                  <th className={`${tableCls.th} text-right`}>Tồn BQ</th>
                  <th className={`${tableCls.th} text-right`}>Thể tích</th>
                  <th className={tableCls.th}>Khớp SKU qua</th>
                </tr>
              </thead>
              <tbody>
                {feeThisMonth.map((f) => (
                  <tr key={`${f.month}-${f.fc}-${f.fnsku ?? f.asin}`}>
                    <td className={tableCls.td}>{f.monthLabel}</td>
                    <td className={`${tableCls.td} font-mono text-[12px] font-bold`}>{f.fc}</td>
                    <td className={`${tableCls.tdNum} font-extrabold`}>{f.feeLabel}</td>
                    <td className={tableCls.tdNum}>{f.storageRate ?? "—"}</td>
                    <td className={tableCls.tdNum}>
                      {f.avgOnHand === null ? <span className="text-soft">chưa rõ</span> : f.avgOnHand}
                    </td>
                    <td className={tableCls.tdNum}>
                      {f.totalVolume === null ? (
                        <span className="text-soft">chưa rõ</span>
                      ) : (
                        `${f.totalVolume}${f.volumeUnits ? ` ${f.volumeUnits}` : ""}`
                      )}
                    </td>
                    <td className={tableCls.td}>
                      <Chip tone={f.skuSource === "none" ? "amber" : "gray"}>{f.skuSourceLabel}</Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {feeMonths.length > 1 ? (
              <div className="mt-3">
                <div className="mb-1 text-[12.5px] font-bold text-muted">Diễn biến phí theo kỳ</div>
                <table className={tableCls.table}>
                  <thead>
                    <tr>
                      <th className={tableCls.th}>Kỳ</th>
                      <th className={`${tableCls.th} text-right`}>Phí</th>
                      <th className={`${tableCls.th} text-right`}>So kỳ trước</th>
                    </tr>
                  </thead>
                  <tbody>
                    {feeMonths.map((m, idx) => {
                      const prev = idx > 0 ? feeMonths[idx - 1] : null;
                      const delta =
                        prev && prev.fee !== null && m.fee !== null && prev.currency === m.currency
                          ? Math.round((m.fee - prev.fee) * 100) / 100
                          : null;
                      return (
                        <tr key={m.month}>
                          <td className={tableCls.td}>{m.monthLabel}</td>
                          <td className={`${tableCls.tdNum} font-bold`}>
                            {m.fee === null ? "chưa rõ" : m.fee.toLocaleString("vi-VN", { minimumFractionDigits: 2 })}
                            {m.currency ? ` ${m.currency}` : ""}
                          </td>
                          <td
                            className={`${tableCls.tdNum} font-bold ${
                              delta === null ? "text-soft" : delta > 0 ? "text-red" : delta < 0 ? "text-green" : ""
                            }`}
                          >
                            {delta === null
                              ? "—"
                              : `${delta > 0 ? "+" : ""}${delta.toLocaleString("vi-VN", { minimumFractionDigits: 2 })}`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="mt-2 text-[12px] text-soft">
                  So kỳ trước chỉ tính khi HAI kỳ cùng một tiền tệ (không so USD với CAD). Q4 rate lưu kho
                  của Amazon cao hơn hẳn — phí nhảy vọt ở kỳ 09–12 thường là do rate, không phải do tồn nhiều.
                </p>
              </div>
            ) : null}
          </>
        )}
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
        desc="Hồ sơ tồn kho chi tiết của một SKU trong 90 ngày: diễn biến tồn theo ngày, phân bổ tại từng kho Amazon và lịch sử nhận hàng."
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
