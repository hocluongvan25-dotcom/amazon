/**
 * LiveInventory — server component đọc Supabase cho Module 3 (I1/I4 + overview).
 * Dùng khi session.mode === "supabase".
 *
 * Các trang fulfillment/* gọi component này thay vì mock data.
 */
import { Chip, KpiCard, KpiGrid, MiniList, PageHeader, Panel, tableCls } from "@/components/ui";
import { readInventoryLatest, readInboundShipments } from "@/lib/data/inventory";
import {
  mapInventoryRow,
  mapInboundRow,
  computeFulfillKpis,
  buildSkuStock,
  formatInventoryValueTotal,
  formatStockValue,
  formatUnitCost,
  summarizeInventoryValue,
  type InventoryLatestRaw,
  type InboundShipmentRaw,
} from "@/lib/data/inventory-model";
import type { InventoryRow, InboundRow } from "@/lib/types";

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
        desc="Nguồn: FBA Inventory API + notification FBA_INVENTORY_AVAILABILITY_CHANGES (realtime) + đối soát report 2h sáng. Cover = fulfillable ÷ velocity 14 ngày."
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
        desc="Nguồn: FBA Inventory API (getInventorySummaries) + report Inventory Aged · role: Inventory and Order Tracking."
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

  const rows = rawRows.map(mapInboundRow);
  const moving = rows.filter((r) =>
    ["IN_TRANSIT", "SHIPPED", "DELIVERED", "RECEIVING"].includes(r.status),
  );
  const pending = rows.filter((r) => r.status === "WORKING");

  return (
    <>
      <div className="mb-3 text-sm font-bold text-accent-ink">
        SUPABASE · dữ liệu thật từ vexim_inbound_shipments
      </div>
      <PageHeader
        title="Inbound shipments"
        sub={`${rows.length} lô · ${moving.length} đang di chuyển · ${pending.length} chờ placement`}
        desc="Nguồn: Fulfillment Inbound API v2024-03-20 (getInboundPlan/getShipment) · đối soát nhận hàng: GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA. Trạng thái chuẩn Amazon."
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
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <Panel title="Quy tắc đối soát">
            <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-muted">
              <li>Lô CLOSED: so thực nhận vs kế hoạch — thiếu &gt; 0 sinh task SOP-09 (claim bồi hoàn) kèm giá trị.</li>
              <li>Đang di chuyển (IN_TRANSIT/RECEIVING): theo dõi ETA, trễ &gt; 3 ngày so lịch sử tuyến → cảnh báo.</li>
              <li>WORKING chờ placement: đẩy hoàn tất các步骤 confirm (Đợt 2 — thao tác ghi).</li>
            </ul>
          </Panel>
        </>
      )}
    </>
  );
}
