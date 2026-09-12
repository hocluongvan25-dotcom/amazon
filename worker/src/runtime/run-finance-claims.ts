/**
 * Runner CLI cho F3 + F4 (Module 6, Đợt 2).
 *
 *   F3 — bồi hoàn FBA (SOP-09):
 *     • đọc report ledger (GET_LEDGER_DETAIL_VIEW_DATA) → khoản nghi ngờ
 *     • đọc report reimbursements (GET_FBA_REIMBURSEMENTS_DATA) → đối chiếu
 *   F4 — lợi nhuận SKU: đọc dòng tiền đã quyết toán trong kỳ + giá vốn hiệu lực
 *
 * HAI CÁCH CHẠY (giống các runner khác của worker):
 *   • `--file=<path>` / `--reimbursements=<path>`: nạp report đã tải sẵn (dùng
 *     khi SP-API chưa cấp credentials, hoặc chạy lại trên file lưu trữ).
 *   • Không có `--file`: gọi Reports API bằng credentials trong web/.env.local
 *     (chỉ khi mode = production). Việc tải report nằm ở `ReportsClient`, hiện
 *     worker chưa có client Reports đầy đủ → runner báo rõ thay vì giả vờ chạy.
 *
 * AN TOÀN DỮ LIỆU: CHỈ ghi DB thật khi `cfg.mode === "production"` và không
 * truyền --dry-run — giống run-inventory-sync.ts / run-finance-sync đã có.
 *
 * Chạy: npm run worker:finance-claims -- --seller=<uuid> [--ledger=<file>]
 *        [--reimbursements=<file>] [--month=2026-09] [--dry-run]
 */

import { readFileSync } from "node:fs";

import { loadConfig } from "../config.ts";
import { MockDbAdapter, type ActiveShop, type DbAdapter } from "../db/adapter.ts";
import { SupabaseDbAdapter } from "../db/supabase.ts";
import { runFinanceClaims, type FinanceClaimsReport } from "../jobs/finance-claims.job.ts";

export type FinanceClaimsCliResult = {
  mode: string;
  db: "supabase" | "mock";
  sellerAccountId: string;
  summary: Record<string, unknown>;
  report: FinanceClaimsReport | null;
};

function pickShop(
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

/** Khoảng ngày của một tháng "YYYY-MM" (mặc định: tháng hiện tại). */
export function monthRange(month: string | null | undefined, now = new Date()): { from: string; to: string } {
  const value = (month ?? "").trim() || now.toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(value)) {
    throw new Error(`--month phải có dạng YYYY-MM (nhận "${value}")`);
  }
  const [year, m] = value.split("-").map(Number);
  const first = new Date(Date.UTC(year, m - 1, 1));
  const last = new Date(Date.UTC(year, m, 0)); // ngày cuối tháng
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

export async function runFinanceClaimsCli(opts: {
  sellerAccountId?: string | null;
  ledgerFile?: string | null;
  reimbursementsFile?: string | null;
  month?: string | null;
  dryRun?: boolean;
  stdout?: { write: (s: string) => void };
  /** Cho test: tiêm adapter */
  adapter?: DbAdapter;
}): Promise<FinanceClaimsCliResult> {
  const log = (s: string) => opts.stdout?.write(s);
  const cfg = loadConfig();
  const dryRun = opts.dryRun === true;

  const ledgerText = opts.ledgerFile ? readFileSync(opts.ledgerFile, "utf8") : null;
  const reimbursementsText = opts.reimbursementsFile ? readFileSync(opts.reimbursementsFile, "utf8") : null;
  const range = monthRange(opts.month);

  if (!ledgerText && !reimbursementsText) {
    log(
      "[finance:claims] chưa có nguồn dữ liệu.\n" +
        "  → Truyền --ledger=<file report GET_LEDGER_DETAIL_VIEW_DATA> và/hoặc\n" +
        "     --reimbursements=<file report GET_FBA_REIMBURSEMENTS_DATA>.\n" +
        "  → Hoặc dùng worker:finance-sync cho dòng tiền settlement rồi chạy lại F4.\n",
    );
    return {
      mode: cfg.mode,
      db: "mock",
      sellerAccountId: opts.sellerAccountId ?? "(chưa chọn)",
      summary: { note: "chưa có report để xử lý" },
      report: null,
    };
  }

  if (dryRun || cfg.mode !== "production" || !cfg.supabase) {
    log(
      `[finance:claims] mode=${cfg.mode}${dryRun ? " · --dry-run" : ""} → chạy trong bộ nhớ, KHÔNG ghi DB thật.\n` +
        `  Sẽ xử lý: ledger=${ledgerText ? "có" : "không"} · reimbursements=${reimbursementsText ? "có" : "không"}\n`,
    );
    const adapter = opts.adapter ?? new MockDbAdapter();
    const report = await runFinanceClaims({
      sellerAccountId: opts.sellerAccountId ?? "(mock)",
      adapter,
      ledgerReportText: ledgerText,
      reimbursementsReportText: reimbursementsText,
      dryRun: true,
    });
    log(
      `  (bộ nhớ) phát hiện ${report.claims.detected} khoản nghi ngờ · ` +
        `${report.claims.missingCost} khoản thiếu giá vốn · ước tính ${report.claims.estimateTotal}\n`,
    );
    return {
      mode: cfg.mode,
      db: "mock",
      sellerAccountId: opts.sellerAccountId ?? "(mock)",
      summary: {
        detected: report.claims.detected,
        inserted: report.claims.inserted,
        reimbursements: report.reimbursements?.lines ?? 0,
        dryRun: true,
      },
      report,
    };
  }

  const db: DbAdapter = opts.adapter ?? new SupabaseDbAdapter(cfg.supabase.url, cfg.supabase.serviceRoleKey);
  const shops = await db.listActiveProductionShops();
  const { shop, error } = pickShop(shops, opts.sellerAccountId);
  if (!shop) throw new Error(error ?? "Không xác định được shop");

  // F4: dòng tiền đã quyết toán trong kỳ (worker đọc qua RPC service_role)
  const events = await db.listFinancialEvents(shop.id, range.from, range.to);

  const report = await runFinanceClaims({
    sellerAccountId: shop.id,
    adapter: db,
    ledgerReportText: ledgerText,
    reimbursementsReportText: reimbursementsText,
    profit: events.length > 0 ? { from: range.from, to: range.to, events } : null,
    dryRun,
  });

  log(
    `\n[finance:claims] shop=${shop.displayName} (${shop.sellerId}) · kỳ ${range.from} → ${range.to}\n` +
      `  F3: phát hiện ${report.claims.detected} · chèn ${report.claims.inserted} · refresh ${report.claims.refreshed} · ` +
      `giữ nguyên ${report.claims.kept} · thiếu giá vốn ${report.claims.missingCost}\n`,
  );
  if (report.reimbursements) {
    log(
      `  Bồi hoàn Amazon: ${report.reimbursements.lines} dòng · mới ${report.reimbursements.inserted} · ` +
        `cập nhật ${report.reimbursements.updated} · tổng ${report.reimbursements.totalAmount} ${report.reimbursements.currency ?? ""}\n`,
    );
  }
  if (report.reconciliation) {
    log(
      `  Đối chiếu: khớp ${report.reconciliation.matched} · claim chưa có tiền về ${report.reconciliation.claimsWithoutReimbursement} · ` +
        `khoản Amazon trả chưa khớp claim ${report.reconciliation.reimbursementsWithoutClaim} · lệch ${report.reconciliation.diffTotal}\n`,
    );
  }
  if (report.profit) {
    log(
      `  F4: ${report.profit.rows} dòng SKU/ngày · lãi gộp ${report.profit.grossProfit ?? "— (thiếu giá vốn)"} · ` +
        `SKU lỗ ${report.profit.lossSkus.length}\n`,
    );
  }
  for (const w of report.warnings.slice(0, 5)) log(`  ⚠ ${w}\n`);

  return {
    mode: cfg.mode,
    db: "supabase",
    sellerAccountId: shop.id,
    summary: {
      shop: shop.displayName,
      detected: report.claims.detected,
      claimsInserted: report.claims.inserted,
      reimbursements: report.reimbursements?.lines ?? 0,
      profitRows: report.profit?.rows ?? 0,
      dryRun,
    },
    report,
  };
}
