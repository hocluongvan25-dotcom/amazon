/**
 * LiveInventory — server component đọc Supabase cho Module 3 (I1/I4 + overview).
 * Dùng khi session.mode === "supabase".
 *
 * Các trang fulfillment/* gọi component này thay vì mock data.
 */
import { Chip, KpiCard, KpiGrid, MiniList, PageHeader, Panel, tableCls } from "@/components/ui";
import {
  readInventoryLatest,
  readInboundShipments,
  readReceiptShipments,
} from "@/lib/data/inventory";
import {
  readInboundIssues,
  readInboundIssueShipments,
  readStorageFeeByFc,
  readStorageFees,
} from "@/lib/data/fees";
import {
  feeByFcForMonth,
  issueFeesByCurrency,
  latestFeeMonth,
  mapInboundIssueRow,
  mapInboundIssueShipmentRow,
  mapStorageFeeByFcRow,
  mapStorageFeeRow,
  mergeInboundIssues,
  moneyLabel,
  type InboundIssueShipmentUiRow,
  type InboundIssueUiRow,
  type StorageFeeByFcUiRow,
} from "@/lib/data/fees-model";
import {
  mapInventoryRow,
  mapInboundRow,
  mapReceiptShipmentRow,
  mergeInboundReconcile,
  computeFulfillKpis,
  buildSkuStock,
  formatInventoryValueTotal,
  formatStockValue,
  formatUnitCost,
  summarizeInventoryValue,
  type InventoryLatestRaw,
  type InboundShipmentRaw,
} from "@/lib/data/inventory-model";
import type { InventoryRow, InboundRow, ReceiptShipmentRow } from "@/lib/types";

const statusTone: Record<InventoryRow["status"], "red" | "amber" | "green" | "gray"> = {
  out: "red",
  low: "amber",
  ok: "green",
  aged: "gray",
};

function coverCell(r: InventoryRow) {
  if (r.status === "out")
    return <span className="font-extrabold text-red">Hết hàng</span>;
  if (r.coverDays === null) return <span className="text-soft">—</span>;
  return (
    <span
      className={`font-extrabold ${
        r.coverDays < 7 ? "text-red" : r.coverDays < 14 ? "text-amber" : "text-muted"
      }`}
    >
      {r.coverDays} ngày
    </span>
  );
}

/* ================================================================== */
/* I1 — Tồn kho theo SKU                                              */
/* ================================================================== */

export async function LiveInventoryList({ filter }: { filter: string }) {
  let rawRows: InventoryLatestRaw[] = [];
  let failed = false;

  try {
    rawRows = await readInventoryLatest();
  } catch {
    failed = true;
  }

  const allRows = rawRows.map(mapInventoryRow);
  const rows = allRows.filter((r) => {
    if (filter === "low") return r.status === "low" || r.status === "out";
    if (filter === "out") return r.status === "out";
    if (filter === "aged") return r.status === "aged";
    return true;
  });

  const filters: [string, string, string][] = [
    ["all", "Tất cả", `${allRows.length}`],
    ["low", "Sắp hết (cover <14)", `${allRows.filter((r) => r.status === "low" || r.status === "out").length}`],
    ["out", "Hết hàng", `${allRows.filter((r) => r.status === "out").length}`],
    ["aged", "Tồn lâu >365 ngày", `${allRows.filter((r) => r.status === "aged").length}`],
  ];

  // 0017: giá trị tồn = Σ (khả dụng + reserved + đang về) × giá vốn hiệu lực
  const valueSum = summarizeInventoryValue(allRows);
  const lowOrOut = allRows.filter((r) => r.status === "low" || r.status === "out").length;

  const now = new Date();
  const latestCapture = rawRows[0]?.captured_at
    ? new Date(rawRows[0].captured_at)
    : null;
  const minutesAgo = latestCapture
    ? Math.round((now.getTime() - latestCapture.getTime()) / 60000)
    : null;

  return (
    <>
      <div className="mb-3 text-sm font-bold text-accent-ink">
        SUPABASE · dữ liệu thật từ vexim_inventory_latest
      </div>
      <PageHeader
        title="Tồn kho theo SKU"
        sub={`${allRows.length} SKU · cập nhật ${minutesAgo !== null ? `${minutesAgo} phút` : "—"} trước (vexim_inventory_latest)`}
        desc="Tồn kho FBA theo thời gian thực của từng SKU: số bán được, số đang giữ, số ngày bán còn lại — phát hiện sớm SKU sắp hết hàng."
      />
      <div className="mb-4 flex flex-wrap gap-2">
        {filters.map(([key, label, count]) => (
          <a
            key={key}
            href={key === "all" ? "/fulfillment/inventory" : `/fulfillment/inventory?f=${key}`}
            className={`rounded-full border px-4 py-1.5 text-[12.5px] font-bold transition ${
              filter === key
                ? "border-accent bg-accent-soft text-accent-ink"
                : "border-line bg-card text-muted hover:border-accent"
            }`}
          >
            {label} · {count}
          </a>
        ))}
      </div>
      {failed ? (
        <Panel title="Không tải được dữ liệu">
          <p role="alert">
            Không thể đọc Supabase. Kiểm tra migration 0011/0017, quyền SELECT,
            RLS và phiên đăng nhập rồi tải lại.
          </p>
        </Panel>
      ) : (
        <>
        <KpiGrid>
          <KpiCard
            label="Giá trị tồn kho"
            value={formatInventoryValueTotal(valueSum)}
            sub="Σ (khả dụng + reserved + đang về) × giá vốn"
            tone={valueSum.byCurrency.length === 0 ? "warn" : "flat"}
          />
          <KpiCard
            label="SKU chưa có giá vốn"
            value={String(valueSum.missingCost)}
            sub={
              valueSum.missingCost > 0
                ? "chưa định giá được — nhập ở /finance/costs"
                : `${valueSum.valued} SKU đã định giá đủ`
            }
            tone={valueSum.missingCost > 0 ? "warn" : "up"}
          />
          <KpiCard
            label="SKU sắp hết / hết hàng"
            value={String(lowOrOut)}
            sub="cover < 14 ngày"
            tone={lowOrOut > 0 ? "down" : "flat"}
          />
          <KpiCard
            label="Tồn khả dụng"
            value={allRows
              .reduce((sum, r) => sum + r.fulfillable, 0)
              .toLocaleString("en-US")}
            sub="đơn vị · mọi shop"
            tone="flat"
          />
        </KpiGrid>
        <Panel title="Danh sách SKU" hint="xếp theo mức rủi ro hết hàng → doanh thu">
          <table className={tableCls.table}>
            <thead>
              <tr>
                <th className={tableCls.th}>SKU / ASIN</th>
                <th className={tableCls.th}>Shop</th>
                <th className={`${tableCls.th} text-right`}>Khả dụng</th>
                <th className={`${tableCls.th} text-right`}>Reserved</th>
                <th className={`${tableCls.th} text-right`}>Đang về</th>
                <th className={`${tableCls.th} text-right`}>Bán/ngày</th>
                <th className={`${tableCls.th} text-right`}>Cover</th>
                <th className={`${tableCls.th} text-right`}>Đề xuất nhập</th>
                <th className={`${tableCls.th} text-right`}>Giá vốn</th>
                <th className={`${tableCls.th} text-right`}>Giá trị tồn</th>
                <th className={tableCls.th}>Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.sku}>
                  <td className={tableCls.td}>
                    <a
                      href={`/fulfillment/inventory/detail?sku=${r.sku}`}
                      className="font-bold text-blue underline underline-offset-2"
                    >
                      {r.sku}
                    </a>
                    <div className="text-[11.5px] text-soft">{r.asin}</div>
                  </td>
                  <td className={tableCls.td}>{r.shop}</td>
                  <td className={`${tableCls.tdNum} font-bold`}>{r.fulfillable}</td>
                  <td className={tableCls.tdNum}>{r.reserved}</td>
                  <td className={tableCls.tdNum}>{r.inbound}</td>
                  <td className={tableCls.tdNum}>{r.velocity}</td>
                  <td className={tableCls.tdNum}>{coverCell(r)}</td>
                  <td className={`${tableCls.tdNum} font-bold`}>
                    {r.suggest === null ? "—" : r.suggest}
                  </td>
                  {/* 0017: giá vốn hiệu lực — thiếu thì "—" kèm việc cần làm, không đoán */}
                  <td className={tableCls.tdNum}>
                    {r.unitCost === null ? (
                      <span
                        className="text-soft"
                        title="Chưa nhập giá vốn cho SKU này — nhập tại /finance/costs"
                      >
                        —
                      </span>
                    ) : (
                      <>
                        {formatUnitCost(r)}
                        <div className="text-[10.5px] text-soft">
                          {r.costSource ?? "—"}
                          {r.costEffectiveFrom ? ` · ${r.costEffectiveFrom}` : ""}
                        </div>
                      </>
                    )}
                  </td>
                  <td className={tableCls.tdNum}>
                    {r.totalStockValue === null ? (
                      <span className="text-soft">— chưa định giá</span>
                    ) : (
                      <>
                        <span className="font-bold">
                          {formatStockValue(r.totalStockValue, r.valueCurrency)}
                        </span>
                        <div className="text-[10.5px] text-soft" title="chỉ tính phần khả dụng × giá vốn">
                          khả dụng {formatStockValue(r.stockValue, r.valueCurrency)}
                        </div>
                      </>
                    )}
                  </td>
                  <td className={tableCls.td}>
                    <Chip tone={statusTone[r.status]}>{r.statusLabel}</Chip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        </>
      )}
      <Panel title="Nguyên tắc tính" hint="đúng docs/phan-tich-ky-thuat-module-3-kho-van.md">
        <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-muted">
          <li><b>Cover</b> chỉ tính số khả dụng — reserved (đang pick/ship) theo dõi riêng, không dùng để an tâm.</li>
          <li><b>Đề xuất nhập</b> = velocity × (lead time + safety 14 ngày) − (khả dụng + reserved + đang về), làm tròn theo case pack.</li>
          <li>SKU mới chưa có lịch sử bán (velocity 0): nhập theo kế hoạch launch — hệ thống không tự sinh số ảo.</li>
          <li>Đơn hàng đang về đã được trừ — tránh nhập chồng lô.</li>
          <li>
            <b>Giá trị tồn</b> (migration 0017) = (khả dụng + reserved + đang về) × <b>giá vốn hiệu lực</b> của
            bậc đang áp dụng (<code>catalog.effective_cost</code>) — tính theo TIỀN CỦA GIÁ VỐN, không tự quy đổi
            sang tiền bán. SKU chưa nhập giá vốn hiện <b>—</b> và được đếm riêng ở KPI, không hiện 0.
          </li>
        </ul>
      </Panel>
    </>
  );
}

/* ================================================================== */
/* Fulfillment Overview (trang /fulfillment)                           */
/* ================================================================== */

export async function LiveFulfillmentOverview() {
  let inventoryRaw: InventoryLatestRaw[] = [];
  let inboundRaw: InboundShipmentRaw[] = [];
  let failed = false;

  try {
    [inventoryRaw, inboundRaw] = await Promise.all([
      readInventoryLatest(),
      readInboundShipments(),
    ]);
  } catch {
    failed = true;
  }

  // 0019: phí lưu kho theo FC đọc TÁCH BIỆT — chưa chạy 0019 / chưa kéo report
  // thì trang tổng quan vẫn chạy, chỉ panel phí hiện nhãn "chưa có dữ liệu".
  let feeByFc: StorageFeeByFcUiRow[] = [];
  let feeFailed = false;
  try {
    feeByFc = (await readStorageFeeByFc()).map(mapStorageFeeByFcRow);
  } catch {
    feeFailed = true;
  }
  const feeMonth = latestFeeMonth(feeByFc);
  const feeGroups = feeMonth ? feeByFcForMonth(feeByFc, feeMonth) : [];

  const allRows = inventoryRaw.map(mapInventoryRow);
  const kpis = computeFulfillKpis(allRows);
  const skuStock = buildSkuStock(allRows);
  const inboundList = inboundRaw.slice(0, 5).map((s) => {
    const status = s.status ?? "UNKNOWN";
    const isClosed = status === "CLOSED";
    const isProblem = isClosed && s.quantity !== null && s.quantity < 50;
    return {
      icon: isProblem ? "⚠️" : isClosed ? "📦" : "🚚",
      title: `Shipment ${s.shipment_id}`,
      units: `${s.quantity ?? "—"} đơn vị`,
      note: `${s.shop} · ${status}`,
      right: s.eta_date
        ? isClosed
          ? `đã nhận ${s.eta_date}`
          : `ETA ${s.eta_date}`
        : "—",
      tone: (isProblem ? "down" : isClosed ? "warn" : "flat") as "down" | "warn" | "flat",
    };
  });

  return (
    <>
      <div className="mb-3 text-sm font-bold text-accent-ink">
        SUPABASE · dữ liệu thật
      </div>
      <PageHeader
        title="Kho vận & FBA"
        sub={`Hôm nay · ${allRows.length} SKU · tồn kho cập nhật từ Supabase`}
        desc="Tổng quan kho FBA: lượng hàng bán được, hàng đang về, hàng tồn lâu ngày — và cảnh báo SKU cần nhập thêm."
      />
      <div className="mb-4 flex flex-wrap gap-2">
        {[
          ["/fulfillment/inventory", "📦 Tồn kho theo SKU"],
          ["/fulfillment/restock", "🧮 Kế hoạch nhập hàng"],
          ["/fulfillment/inbound", "🚚 Inbound shipments"],
        ].map(([href, label]) => (
          <a
            key={href}
            href={href}
            className="rounded-full border border-line bg-card px-4 py-1.5 text-[12.5px] font-bold text-muted transition hover:border-accent hover:bg-accent-soft hover:text-accent-ink"
          >
            {label}
          </a>
        ))}
      </div>
      {failed ? (
        <Panel title="Không tải được dữ liệu">
          <p role="alert">
            Không thể đọc Supabase. Kiểm tra migration 0011, quyền SELECT,
            RLS và phiên đăng nhập rồi tải lại.
          </p>
        </Panel>
      ) : (
        <>
          <KpiGrid>
            {kpis.map((k) => (
              <KpiCard key={k.label} {...k} />
            ))}
          </KpiGrid>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel title="SKU sắp hết — xếp theo velocity" hint="đề xuất số lượng nhập">
              <table className={tableCls.table}>
                <thead>
                  <tr>
                    <th className={tableCls.th}>SKU</th>
                    <th className={`${tableCls.th} text-right`}>Tồn</th>
                    <th className={`${tableCls.th} text-right`}>Cover</th>
                    <th className={`${tableCls.th} text-right`}>Bán/ngày</th>
                    <th className={`${tableCls.th} text-right`}>Đề xuất nhập</th>
                  </tr>
                </thead>
                <tbody>
                  {skuStock.map((r) => (
                    <tr key={r.sku}>
                      <td className={`${tableCls.td} font-bold`}>{r.sku}</td>
                      <td className={tableCls.tdNum}>{r.stock}</td>
                      <td
                        className={`${tableCls.tdNum} font-bold ${
                          r.coverTone === "red" ? "text-red" : "text-amber"
                        }`}
                      >
                        {r.coverDays} ngày
                      </td>
                      <td className={tableCls.tdNum}>{r.perDay}</td>
                      <td className={`${tableCls.tdNum} font-bold`}>{r.suggest}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
            <Panel title="Inbound shipments">
              <MiniList
                items={inboundList.map((s) => ({
                  icon: s.icon,
                  title: s.title,
                  sub: `${s.units} · ${s.note}`,
                  right: s.right,
                  tone: s.tone,
                }))}
              />
            </Panel>
          </div>

          {/* -------------------------------------------------------------- */}
          {/* 0019 — PHÂN BỔ PHÍ LƯU KHO THEO FC                              */}
          {/* Trả lời câu "hàng đang nằm ở FC nào thì TỐN BAO NHIÊU tiền".     */}
          {/* Tiền KHÔNG được cộng qua lại giữa các currency: mỗi nhóm một tổng. */}
          {/* -------------------------------------------------------------- */}
          <Panel
            title={`Phí lưu kho theo FC${feeMonth ? ` · kỳ ${feeMonth}` : ""}`}
            hint="GET_FBA_STORAGE_FEE_CHARGES_DATA · worker: reports:pull · cron 03:00 UTC"
          >
            {feeFailed ? (
              <p className="text-[13px] text-muted">
                Không đọc được <code>vexim_storage_fee_by_fc</code>. Kiểm tra migration 0019
                đã chạy chưa và quyền SELECT của role.
              </p>
            ) : feeGroups.length === 0 ? (
              <p className="text-[13px] text-muted">
                Chưa có phí lưu kho nào được nhập. Kéo report bằng{" "}
                <code>npm run worker:reports-pull -- --type=storage-fees</code> (cần role
                SP-API), hoặc nạp file đã tải từ Seller Central:{" "}
                <code>--storage-fees=&lt;file.tsv&gt;</code>.
              </p>
            ) : (
              <div className="space-y-4">
                {feeGroups.map((g) => (
                  <div key={g.currency}>
                    <div className="mb-1.5 flex flex-wrap items-baseline gap-2 text-[12.5px]">
                      <b className="font-bold text-accent-ink">{g.currency}</b>
                      <span className="text-muted">
                        tổng kỳ {feeMonth}:{" "}
                        <b className="font-extrabold">{moneyLabel(g.total, g.currency === "(không rõ tiền)" ? null : g.currency)}</b>
                      </span>
                      <span className="text-soft">
                        {g.rows.length} FC · {g.rows.reduce((s, r) => s + r.lines, 0)} dòng sản phẩm
                      </span>
                    </div>
                    <table className={tableCls.table}>
                      <thead>
                        <tr>
                          <th className={tableCls.th}>FC</th>
                          <th className={`${tableCls.th} text-right`}>Phí kỳ này</th>
                          <th className={`${tableCls.th} text-right`}>Tỉ trọng</th>
                          <th className={`${tableCls.th} text-right`}>Thể tích</th>
                          <th className={`${tableCls.th} text-right`}>Tồn BQ</th>
                          <th className={`${tableCls.th} text-right`}>SKU</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.rows.map((r) => (
                          <tr key={`${r.month}-${r.fc}-${r.currency}`}>
                            <td className={`${tableCls.td} font-mono text-[12px] font-bold`}>{r.fc}</td>
                            <td className={`${tableCls.tdNum} font-extrabold`}>{r.feeLabel}</td>
                            <td
                              className={`${tableCls.tdNum} font-bold ${
                                r.sharePct !== null && r.sharePct >= 40 ? "text-amber" : ""
                              }`}
                            >
                              {r.shareLabel}
                            </td>
                            <td className={tableCls.tdNum}>
                              {r.volume === null ? (
                                <span className="text-soft">chưa rõ</span>
                              ) : (
                                `${r.volume.toLocaleString("vi-VN", { maximumFractionDigits: 2 })}${r.volumeUnits ? ` ${r.volumeUnits}` : ""}`
                              )}
                            </td>
                            <td className={tableCls.tdNum}>
                              {r.units === null ? <span className="text-soft">—</span> : r.units.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}
                            </td>
                            <td className={tableCls.tdNum}>{r.fnskuCount}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
                <p className="text-[12px] text-soft">
                  Mỗi bảng là MỘT tiền tệ — hệ thống không cộng USD với CAD. FC chiếm ≥40% phí
                  được tô vàng: đó là nơi đáng xem lại (rút hàng, thanh lý, hoặc chuyển kỳ nhập).
                </p>
              </div>
            )}
          </Panel>
        </>
      )}
    </>
  );
}

/* ================================================================== */
/* I4 — Inbound shipments                                              */
/* ================================================================== */

const recTone: Record<string, "green" | "amber" | "red" | "gray"> = {
  up: "green",
  warn: "amber",
  down: "red",
  flat: "gray",
};

export async function LiveInboundShipments() {
  let rawRows: InboundShipmentRaw[] = [];
  let failed = false;

  try {
    rawRows = await readInboundShipments();
  } catch {
    failed = true;
  }

  // 0018: đối soát nhận hàng đọc TÁCH BIỆT — chưa chạy 0018 / chưa nhập report
  // thì bảng lô vẫn hiện, chỉ cột "Đối soát nhận" giữ nhãn cũ (không bịa "nhận đủ").
  let reconRows: ReceiptShipmentRow[] = [];
  let reconFailed = false;
  try {
    reconRows = (await readReceiptShipments()).map(mapReceiptShipmentRow);
  } catch {
    reconFailed = true;
  }

  // 0019: phí inbound sai quy cách — cũng đọc tách biệt (chưa kéo report thì
  // bảng lô vẫn chạy, chỉ thiếu cột phí).
  let issueShipments: InboundIssueShipmentUiRow[] = [];
  let issues: InboundIssueUiRow[] = [];
  let issueFailed = false;
  try {
    const [shipRaw, issueRaw] = await Promise.all([
      readInboundIssueShipments(),
      readInboundIssues(),
    ]);
    issueShipments = shipRaw.map(mapInboundIssueShipmentRow);
    issues = issueRaw.map(mapInboundIssueRow);
  } catch {
    issueFailed = true;
  }

  const reconMerged = mergeInboundReconcile(rawRows.map(mapInboundRow), reconRows);
  const issueMerged = mergeInboundIssues(reconMerged.rows, issueShipments);
  const merged = { ...reconMerged, rows: issueMerged.rows };
  const rows = merged.rows;
  const moving = rows.filter((r) =>
    ["IN_TRANSIT", "SHIPPED", "DELIVERED", "RECEIVING"].includes(r.status),
  );
  const pending = rows.filter((r) => r.status === "WORKING");
  const shortCount = reconRows.filter((r) => r.state === "short").length;
  const issueFees = issueFeesByCurrency(issues);
  const issueTotalLabel =
    issueFees.length === 0
      ? "chưa rõ"
      : issueFees.map((f) => moneyLabel(f.fee, f.currency === "(không rõ tiền)" ? null : f.currency)).join(" + ");
  const worstShipments = [...issueShipments]
    .sort((a, b) => b.severity - a.severity || b.fee - a.fee)
    .slice(0, 8);
  const orphanIssues = issueMerged.orphans;

  return (
    <>
      <div className="mb-3 text-sm font-bold text-accent-ink">
        SUPABASE · dữ liệu thật từ vexim_inbound_shipments
      </div>
      <PageHeader
        title="Inbound shipments"
        sub={`${rows.length} lô · ${moving.length} đang di chuyển · ${pending.length} chờ placement` +
          (reconFailed || reconRows.length === 0
            ? " · chưa có số nhận từ report"
            : ` · ${merged.matched} lô đã có số nhận${shortCount > 0 ? ` · ${shortCount} lô THIẾU` : ""}`) +
          (issueFailed || issues.length === 0
            ? ""
            : ` · ${issues.length} vấn đề inbound, phí ${issueTotalLabel}`)}
        desc="Theo dõi các lô hàng đang gửi vào kho Amazon: trạng thái vận chuyển, số đã nhận so với số gửi và chênh lệch cần đối soát."
      />
      {failed ? (
        <Panel title="Không tải được dữ liệu">
          <p role="alert">
            Không thể đọc Supabase. Kiểm tra migration 0011, quyền SELECT,
            RLS và phiên đăng nhập rồi tải lại.
          </p>
        </Panel>
      ) : (
        <>
          <Panel title="Tất cả lô hàng" hint="WORKING → SHIPPED → IN_TRANSIT → DELIVERED → CHECKED_IN → RECEIVING → CLOSED">
            <table className={tableCls.table}>
              <thead>
                <tr>
                  <th className={tableCls.th}>Shipment</th>
                  <th className={tableCls.th}>Shop</th>
                  <th className={tableCls.th}>Trạng thái</th>
                  <th className={`${tableCls.th} text-right`}>Số lượng</th>
                  <th className={tableCls.th}>FC đích</th>
                  <th className={tableCls.th}>ETA</th>
                  <th className={tableCls.th}>Đối soát nhận</th>
                  <th className={tableCls.th}>Phí / vấn đề inbound</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td className={`${tableCls.td} font-mono text-[12px] font-bold`}>{s.id}</td>
                    <td className={tableCls.td}>{s.shop}</td>
                    <td className={tableCls.td}>
                      <Chip tone={s.statusTone}>{s.status}</Chip>
                    </td>
                    <td className={`${tableCls.tdNum} font-bold`}>{s.units}</td>
                    <td className={tableCls.td}>{s.fc}</td>
                    <td className={tableCls.td}>{s.eta}</td>
                    <td className={tableCls.td}>
                      <Chip tone={recTone[s.reconcileTone]}>{s.reconcile}</Chip>
                    </td>
                    <td className={tableCls.td}>
                      {s.issueCount === undefined ? (
                        <span className="text-soft">—</span>
                      ) : (
                        <Chip tone={recTone[s.issueTone ?? "flat"]}>
                          {s.issueCount} vấn đề · {s.issueFeeLabel}
                        </Chip>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          {reconFailed ? (
            <Panel title="Đối soát nhận hàng">
              <p className="text-[13px] text-muted">
                <b className="text-amber">Chưa đọc được vexim_inbound_receipt_shipments</b> — kiểm tra đã
                chạy migration 0018 và quyền SELECT chưa. Bảng lô ở trên vẫn là dữ liệu thật; riêng cột
                &quot;Đối soát nhận&quot; giữ nhãn chờ, hệ thống KHÔNG tự coi là đã nhận đủ.
              </p>
            </Panel>
          ) : reconRows.length === 0 ? (
            <Panel title="Đối soát nhận hàng">
              <p className="text-[13px] text-muted">
                Chưa có số thực nhận. Nguồn duy nhất là report{" "}
                <b>FBA Received Inventory</b> (GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA) — nhập bằng{" "}
                <code className="text-[12px]">npm run worker:inventory-fc -- --receipts=&lt;file.tsv&gt;</code>.
              </p>
            </Panel>
          ) : merged.orphans.length > 0 ? (
            <Panel
              title="Lô có số nhận nhưng không còn trong danh sách"
              hint="report receipts · vexim_inbound_receipt_shipments"
            >
              <table className={tableCls.table}>
                <thead>
                  <tr>
                    <th className={tableCls.th}>Shipment</th>
                    <th className={tableCls.th}>FC nhận</th>
                    <th className={`${tableCls.th} text-right`}>Thực nhận</th>
                    <th className={tableCls.th}>Ngày nhận cuối</th>
                    <th className={tableCls.th}>Đối soát</th>
                  </tr>
                </thead>
                <tbody>
                  {merged.orphans.map((o) => (
                    <tr key={o.shipmentId}>
                      <td className={`${tableCls.td} font-mono text-[12px] font-bold`}>{o.shipmentId}</td>
                      <td className={tableCls.td}>{o.fc ?? "—"}</td>
                      <td className={`${tableCls.tdNum} font-bold`}>{o.received}</td>
                      <td className={tableCls.td}>{o.lastDate ?? "—"}</td>
                      <td className={tableCls.td}>
                        <Chip tone={recTone[o.tone]}>{o.label}</Chip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[12px] text-soft">
                Thường là lô đã CLOSED trước khi worker kịp sync nên không còn dòng trong
                inventory.inbound_shipments — số nhận vẫn giữ, chỉ không có &quot;số gửi&quot; để so.
              </p>
            </Panel>
          ) : null}

          {/* -------------------------------------------------------------- */}
          {/* 0019 — PHÍ INBOUND SAI QUY CÁCH: tiền mất vì lô nhập không chuẩn  */}
          {/* -------------------------------------------------------------- */}
          {issueFailed ? (
            <Panel title="Phí &amp; vấn đề khi nhận lô">
              <p className="text-[13px] text-muted">
                <b className="text-amber">Chưa đọc được vexim_inbound_issue_shipments</b> — kiểm tra đã chạy
                migration 0019 và quyền SELECT chưa. Bảng lô ở trên vẫn là dữ liệu thật; riêng cột
                &quot;Phí / vấn đề inbound&quot; để trống, hệ thống KHÔNG suy ra &quot;không có phí&quot;.
              </p>
            </Panel>
          ) : issueShipments.length === 0 ? (
            <Panel title="Phí &amp; vấn đề khi nhận lô" hint="GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA">
              <p className="text-[13px] text-muted">
                Chưa có vấn đề/phí inbound nào được nhập. Kéo report bằng{" "}
                <code>npm run worker:reports-pull -- --type=noncompliance</code> hoặc nạp file{" "}
                <code>--noncompliance=&lt;file.tsv&gt;</code>. <b>Lưu ý:</b> report này RỖNG là chuyện
                bình thường — nghĩa là Amazon không ghi nhận vấn đề gì, không phải lỗi.
              </p>
            </Panel>
          ) : (
            <>
              <Panel
                title="Phí &amp; vấn đề khi Amazon nhận lô"
                hint={`tổng phí: ${issueTotalLabel} · lô nghiêm trọng nhất lên trước`}
              >
                <table className={tableCls.table}>
                  <thead>
                    <tr>
                      <th className={tableCls.th}>Shipment</th>
                      <th className={tableCls.th}>FC</th>
                      <th className={`${tableCls.th} text-right`}>Vấn đề</th>
                      <th className={`${tableCls.th} text-right`}>Đơn vị lỗi</th>
                      <th className={`${tableCls.th} text-right`}>Phí</th>
                      <th className={tableCls.th}>Loại vấn đề</th>
                      <th className={tableCls.th}>Coaching / cảnh báo</th>
                      <th className={tableCls.th}>Ngày báo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {worstShipments.map((r) => (
                      <tr key={`${r.shipmentId}-${r.currency}`}>
                        <td className={`${tableCls.td} font-mono text-[12px] font-bold`}>{r.shipmentId}</td>
                        <td className={tableCls.td}>{r.fc ?? "—"}</td>
                        <td className={`${tableCls.tdNum} font-bold`}>{r.issueCount}</td>
                        <td className={tableCls.tdNum}>{r.problemUnits}</td>
                        <td className={`${tableCls.tdNum} font-extrabold`}>{r.feeLabel}</td>
                        <td className={tableCls.td}>{r.problemTypes.join(" · ")}</td>
                        <td className={tableCls.td}>
                          <Chip tone={recTone[r.tone]}>
                            {[...r.coachingLevels, ...r.alertStatuses].filter(Boolean).join(" · ") || "—"}
                          </Chip>
                        </td>
                        <td className={tableCls.td}>{r.lastDate ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-[12px] text-soft">
                  Phí chỉ được cộng TRONG CÙNG một tiền tệ (mỗi lô một currency từ report). Coaching level
                  là cách Amazon chấm việc nhập hàng của mình — lên LEVEL_3 thì lô sau dễ bị soi hơn.
                </p>
              </Panel>

              <Panel
                title="Chi tiết từng vấn đề"
                hint="expected/received là của DÒNG có vấn đề — không phải của cả lô"
              >
                <table className={tableCls.table}>
                  <thead>
                    <tr>
                      <th className={tableCls.th}>Ngày báo</th>
                      <th className={tableCls.th}>Shipment</th>
                      <th className={tableCls.th}>Carton</th>
                      <th className={tableCls.th}>SKU</th>
                      <th className={tableCls.th}>Vấn đề</th>
                      <th className={`${tableCls.th} text-right`}>Số lỗi</th>
                      <th className={`${tableCls.th} text-right`}>Kế hoạch / thực nhận</th>
                      <th className={`${tableCls.th} text-right`}>Phí</th>
                    </tr>
                  </thead>
                  <tbody>
                    {issues.slice(0, 15).map((r, i) => (
                      <tr key={`${r.date}-${r.shipmentId}-${r.cartonId}-${r.problemType}-${i}`}>
                        <td className={tableCls.td}>{r.dateLabel}</td>
                        <td className={`${tableCls.td} font-mono text-[12px]`}>{r.shipmentId ?? "—"}</td>
                        <td className={`${tableCls.td} font-mono text-[11px]`}>{r.cartonId ?? "—"}</td>
                        <td className={`${tableCls.td} font-bold`}>{r.sku ?? "—"}</td>
                        <td className={tableCls.td}>
                          {r.problemTypeLabel}
                          {r.problemLevel ? <span className="text-soft"> · {r.problemLevel}</span> : null}
                        </td>
                        <td className={tableCls.tdNum}>{r.problemQty ?? "—"}</td>
                        <td className={tableCls.tdNum}>
                          {r.expected === null && r.received === null ? (
                            <span className="text-soft">không rõ</span>
                          ) : (
                            `${r.expected ?? "?"} / ${r.received ?? "?"}`
                          )}
                        </td>
                        <td className={`${tableCls.tdNum} font-bold`}>{r.feeLabel}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-[12px] text-soft">
                  Đối soát CẢ LÔ (gửi bao nhiêu · nhận bao nhiêu) vẫn lấy từ report nhận hàng ở panel trên —
                  hai cột expected/received ở đây chỉ mô tả dòng có vấn đề, cộng dồn theo lô sẽ ra số sai.
                </p>
              </Panel>

              {orphanIssues.length > 0 ? (
                <Panel
                  title="Lô có vấn đề nhưng không nằm trong danh sách"
                  hint={`${orphanIssues.length} lô — report phí nói có, Inbound API không còn dòng`}
                >
                  <table className={tableCls.table}>
                    <thead>
                      <tr>
                        <th className={tableCls.th}>Shipment</th>
                        <th className={tableCls.th}>FC</th>
                        <th className={`${tableCls.th} text-right`}>Vấn đề</th>
                        <th className={`${tableCls.th} text-right`}>Phí</th>
                        <th className={tableCls.th}>Loại vấn đề</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orphanIssues.map((o) => (
                        <tr key={`${o.shipmentId}-${o.currency}`}>
                          <td className={`${tableCls.td} font-mono text-[12px] font-bold`}>{o.shipmentId}</td>
                          <td className={tableCls.td}>{o.fc ?? "—"}</td>
                          <td className={tableCls.tdNum}>{o.issueCount}</td>
                          <td className={`${tableCls.tdNum} font-extrabold`}>{o.feeLabel}</td>
                          {/* problemTypes đã được dịch nhãn ở mapper — không dịch lần 2 */}
                          <td className={tableCls.td}>{o.problemTypes.join(" · ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-2 text-[12px] text-soft">
                    Phí vẫn được tính dù lô không còn trong Inbound API — đừng bỏ qua chỉ vì bảng lô không thấy.
                  </p>
                </Panel>
              ) : null}
            </>
          )}

          <Panel title="Quy tắc đối soát" hint="số nhận = report receipts (0018) · số gửi = Inbound API">
            <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-muted">
              <li>Lô CLOSED: so thực nhận vs kế hoạch — thiếu &gt; 0 sinh task SOP-09 (claim bồi hoàn) kèm giá trị.</li>
              <li>
                <b>Thực nhận</b> lấy từ report GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA (không có trong
                Inbound API); <b>số gửi</b> lấy từ inventory.inbound_shipments. Thiếu một trong hai → nhãn
                &quot;Chưa rõ số gửi&quot;, KHÔNG hiển thị &quot;nhận đủ&quot;.
              </li>
              <li>Đang di chuyển (IN_TRANSIT/RECEIVING): theo dõi ETA, trễ &gt; 3 ngày so lịch sử tuyến → cảnh báo.</li>
              <li>WORKING chờ placement: đẩy hoàn tất các bước confirm (Đợt 2 — thao tác ghi).</li>
              <li>
                <b>Phí inbound</b> (0019): report GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA cho biết
                Amazon tính phí gì vì lô sai quy cách (thiếu nhãn, thùng quá khổ, hàng hư) kèm coaching
                level. Phí này KHÔNG nằm trong đối soát thiếu/thừa — nó là chi phí phải trừ vào lãi lô.
              </li>
            </ul>
          </Panel>
        </>
      )}
    </>
  );
}
