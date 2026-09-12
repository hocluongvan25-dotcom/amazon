/**
 * Runner CLI — Module 3 nâng cao: phân bổ tồn theo FC + lịch sử nhận hàng.
 *
 *   worker:inventory-fc -- --fc=<fba-daily-inventory-history.tsv>
 *                          [--receipts=<fba-received-inventory.tsv>]
 *                          [--seller=<uuid shop>] [--top-fc=10] [--dry-run]
 *
 * LẤY FILE Ở ĐÂU (Seller Central → Reports → Fulfillment → Inventory):
 *   • "FBA Daily Inventory History"  → reportType GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA
 *     (chọn khoảng ngày; mỗi ngày một snapshot, có cột fulfillment-center-id)
 *   • "FBA Received Inventory"       → reportType GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA
 *     (các lần nhận đã hoàn tất, có fba-shipment-id)
 *   Đợt 2 sẽ tự đặt lịch qua Reports API (createReport → getReportDocument);
 *   hiện tại nhập file tay giống orders:sync / listings:sync để không phụ thuộc
 *   quota report (các report FBA dạng daily chỉ được yêu cầu mỗi 4 giờ).
 *
 * AN TOÀN DỮ LIỆU (giống mọi runner khác của worker): CHỈ ghi DB thật khi
 * `cfg.mode === "production"` và không --dry-run. Còn lại chạy trong bộ nhớ
 * (MockDbAdapter) và in bản tóm tắt để đối chiếu.
 */
import { readFileSync } from "node:fs";

import { loadConfig } from "../config.ts";
import { MockDbAdapter, type ActiveShop, type DbAdapter } from "../db/adapter.ts";
import { SupabaseDbAdapter } from "../db/supabase.ts";
import {
  DEFAULT_TOP_FC_LIMIT,
  runInventoryFcSync,
  type InventoryFcSyncReport,
} from "../jobs/inventory-fc-sync.job.ts";

export type InventoryFcSyncCliResult = {
  mode: string;
  db: "supabase" | "mock";
  sellerAccountId: string;
  summary: Record<string, unknown>;
  warnings: string[];
  report: InventoryFcSyncReport | null;
};

/** >1 shop production thì PHẢI chỉ định --seller (không đoán shop). */
export function pickShop(
  shops: ActiveShop[],
  sellerAccountId: string | null | undefined,
): { shop: ActiveShop | null; error: string | null } {
  if (sellerAccountId) {
    const found = shops.find((s) => s.id === sellerAccountId);
    return found ? { shop: found, error: null } : { shop: null, error: `Không thấy shop ${sellerAccountId}` };
  }
  if (shops.length === 1) return { shop: shops[0], error: null };
  return {
    shop: null,
    error:
      `Có ${shops.length} shop production → phải chỉ định --seller=<uuid>. ` +
      `Danh sách: ${shops.map((s) => `${s.displayName}=${s.id}`).join(", ")}`,
  };
}

export async function runInventoryFcSyncCli(opts: {
  fcFile?: string | null;
  receiptsFile?: string | null;
  sellerAccountId?: string | null;
  topFcLimit?: number;
  dryRun?: boolean;
  stdout?: { write: (s: string) => void };
  /** Cho test: tiêm adapter */
  adapter?: DbAdapter;
}): Promise<InventoryFcSyncCliResult> {
  const log = (s: string) => opts.stdout?.write(s);
  const cfg = loadConfig();
  const dryRun = opts.dryRun === true;

  const read = (p?: string | null) => (p ? readFileSync(p, "utf8") : undefined);
  const fcText = read(opts.fcFile);
  const rxText = read(opts.receiptsFile);

  if (!fcText && !rxText) {
    log(
      "[inventory:fc] chưa có report để nạp.\n" +
        "  → Seller Central → Reports → Fulfillment → Inventory, tải 2 report:\n" +
        "      --fc=<FBA Daily Inventory History.tsv>       (phân bổ tồn theo FC → I2)\n" +
        "      --receipts=<FBA Received Inventory.tsv>      (lịch sử nhận hàng → I2/I4)\n" +
        "  → Có thể nạp từng file một; thiếu file nào thì khối đó giữ nhãn 'chưa có dữ liệu'.\n",
    );
    return {
      mode: cfg.mode,
      db: "mock",
      sellerAccountId: opts.sellerAccountId ?? "(chưa chọn)",
      summary: { note: "chưa có report để xử lý" },
      warnings: [],
      report: null,
    };
  }

  const printSummary = (
    label: string,
    r: InventoryFcSyncReport,
    dbKind: "supabase" | "mock",
  ): void => {
    log(`\n[inventory:fc] ${label} · db=${dbKind}\n`);
    log(
      `  phân bổ FC          ${r.fc.rows} dòng · ${r.fc.units} đơn vị · ${r.fc.skus} SKU · ${r.fc.fcCount} FC` +
        ` · snapshot ${r.fc.latestSnapshot ?? "(không có)"}` +
        `${r.fc.skipped > 0 ? ` · BỎ ${r.fc.skipped} dòng rác` : ""}\n`,
    );
    if (r.fc.db) {
      log(
        `    ghi DB            inserted ${r.fc.db.inserted} · updated ${r.fc.db.updated}` +
          ` · skipped ${r.fc.db.skipped} · merged ${r.fc.db.merged}\n`,
      );
    }
    log(
      `    disposition       bán được ${r.fc.sellableUnits} · không bán được ${r.fc.unsellableUnits}` +
        ` · KHÔNG RÕ ${r.fc.unknownDispositionUnits}\n`,
    );
    for (const f of r.fc.topFcs) {
      log(
        `      ${f.fc.padEnd(12)} ${String(f.units).padStart(7)} đơn vị` +
          ` · ${String(f.skus).padStart(3)} SKU` +
          ` · ${f.sharePct === null ? "không rõ %" : `${f.sharePct.toFixed(1)}%`}\n`,
      );
    }
    log(
      `  lịch sử nhận hàng   ${r.receipts.rows} dòng · ${r.receipts.units} đơn vị` +
        ` · ${r.receipts.shipments} lô · ${r.receipts.from ?? "—"} → ${r.receipts.to ?? "—"}` +
        `${r.receipts.skipped > 0 ? ` · BỎ ${r.receipts.skipped} dòng rác` : ""}\n`,
    );
    if (r.receipts.db) {
      log(
        `    ghi DB            inserted ${r.receipts.db.inserted} · updated ${r.receipts.db.updated}` +
          ` · skipped ${r.receipts.db.skipped} · merged ${r.receipts.db.merged}\n`,
      );
    }
    for (const s of r.receipts.byShipment.slice(0, 10)) {
      log(
        `      ${s.shipmentId.padEnd(14)} ${String(s.units).padStart(6)} đơn vị` +
          ` · ${String(s.skus).padStart(3)} SKU · ${s.fc ?? "(không rõ FC)"} · ${s.lastDate}\n`,
      );
    }
    if (r.receipts.byShipment.length > 10) {
      log(`      … +${r.receipts.byShipment.length - 10} lô khác (xem /fulfillment/inventory)\n`);
    }
    log(
      "  đối soát nhận/gửi   xem màn I2/I4 — số gửi lấy từ inventory.inbound_shipments" +
        " (worker inventory:sync), không có trong report.\n",
    );
    for (const w of r.warnings.slice(0, 10)) log(`  ⚠ ${w}\n`);
    if (dbKind === "mock") {
      log("  ⚠ chạy trong bộ nhớ (dry-run / chưa đủ credentials) — KHÔNG ghi DB thật.\n");
    }
  };

  const topFcLimit = opts.topFcLimit ?? DEFAULT_TOP_FC_LIMIT;

  // ---- Đường mock / dry-run: không ghi DB -----------------------------------
  if (dryRun || cfg.mode !== "production" || !cfg.supabase) {
    const adapter = opts.adapter ?? new MockDbAdapter();
    const report = await runInventoryFcSync({
      sellerAccountId: opts.sellerAccountId ?? "00000000-0000-0000-0000-000000000001",
      fcReportText: fcText,
      receiptsReportText: rxText,
      adapter,
      topFcLimit,
    });
    printSummary(`mode=${cfg.mode}${dryRun ? " · --dry-run" : ""}`, report, "mock");
    return {
      mode: cfg.mode,
      db: "mock",
      sellerAccountId: report.sellerAccountId,
      summary: {
        fcRows: report.fc.rows,
        fcUnits: report.fc.units,
        fcLatestSnapshot: report.fc.latestSnapshot,
        receiptRows: report.receipts.rows,
        receiptShipments: report.receipts.shipments,
        dryRun: true,
      },
      warnings: report.warnings,
      report,
    };
  }

  // ---- Đường production: ghi DB thật qua RPC 0018 ---------------------------
  const db: DbAdapter =
    opts.adapter ?? new SupabaseDbAdapter(cfg.supabase.url, cfg.supabase.serviceRoleKey);
  const shops = await db.listActiveProductionShops();
  const { shop, error } = pickShop(shops, opts.sellerAccountId);
  if (!shop) throw new Error(error ?? "Không xác định được shop");

  const report = await runInventoryFcSync({
    sellerAccountId: shop.id,
    fcReportText: fcText,
    receiptsReportText: rxText,
    adapter: db,
    topFcLimit,
  });

  printSummary(`shop=${shop.displayName} (${shop.sellerId})`, report, "supabase");

  return {
    mode: cfg.mode,
    db: "supabase",
    sellerAccountId: shop.id,
    summary: {
      shop: shop.displayName,
      fcRows: report.fc.rows,
      fcUnits: report.fc.units,
      fcInserted: report.fc.db?.inserted ?? 0,
      fcUpdated: report.fc.db?.updated ?? 0,
      receiptRows: report.receipts.rows,
      receiptInserted: report.receipts.db?.inserted ?? 0,
      receiptUpdated: report.receipts.db?.updated ?? 0,
    },
    warnings: report.warnings,
    report,
  };
}
