/**
 * Runner — đồng bộ tồn kho cho tất cả shop production active.
 *
 * Luồng (đúng docs/phan-tich-ky-thuat-module-3-kho-van.md mục 1.1 tầng 2):
 *   1. Lấy danh sách shop active từ DB
 *   2. Mỗi shop: tạo sync_job record running
 *   3. Gọi getInventorySummaries (có pagination, retry 429/5xx)
 *   4. Chuẩn hóa → snapshot → tính velocity/cover/đề xuất từ dữ liệu bán
 *   5. upsert inventory_snapshots + inventory_daily
 *   6. Tạo ops.alerts cho stockout / low cover (dedupe 24h)
 *   7. Cập nhật sync_jobs trạng thái done/failed
 *
 * Ở DEMO MODE (không có credentials hoặc Supabase unreachable) → dùng dữ liệu
 * giả + MockDbAdapter để training/demo không cần kết nối SP-API thật.
 *
 * NGUYÊN TẮC AN TOÀN DỮ LIỆU (bắt buộc):
 *   DB thật CHỈ được ghi khi mode === "production", tức có đủ cả LWA credentials
 *   lẫn Supabase credentials. Có Supabase mà thiếu LWA → chạy demo TRONG BỘ NHỚ,
 *   tuyệt đối không ghi SKU giả xuống DB production.
 */
import { loadConfig } from "../config.ts";
import { LwaTokenManager } from "../amazon/lwa.ts";
import { FbaInventoryClient } from "../amazon/fba-inventory.ts";
import { MockDbAdapter, type DbAdapter, type ActiveShop } from "../db/adapter.ts";
import { SupabaseDbAdapter } from "../db/supabase.ts";
import { runInventorySync } from "../jobs/inventory-sync.job.ts";

export type InventorySyncRunResult = {
  mode: "mock" | "sandbox" | "production";
  /** "supabase" = có ghi DB thật; "mock" = chỉ chạy trong bộ nhớ. */
  db: "supabase" | "mock";
  shopsProcessed: number;
  totalSkus: number;
  totalAlerts: number;
  errors: { shopId: string; error: string }[];
};

const DEMO_SHOP: ActiveShop = {
  id: "00000000-0000-0000-0000-000000000001",
  sellerId: "DEMO-SELLER",
  marketplace: "ATVPDKIKX0DER",
  displayName: "DEMO · US",
  leadDays: 32,
  safetyDays: 14,
};

export async function runInventorySyncAll(
  deps: {
    now?: Date;
    stdout?: { write: (s: string) => void };
    seedMockData?: (db: MockDbAdapter) => void;
  } = {},
): Promise<InventorySyncRunResult> {
  const log = deps.stdout?.write ?? (() => {});
  const cfg = loadConfig();
  const now = deps.now ?? new Date();

  const mock = new MockDbAdapter();
  if (deps.seedMockData) deps.seedMockData(mock);

  let db: DbAdapter;
  let shops: ActiveShop[];

  // ==========================================================================
  // CHẶN CỨNG: chỉ ghi DB THẬT khi mode === "production".
  //
  // loadConfig() chỉ trả mode="production" khi có ĐỦ 5 biến:
  //   AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET, AMAZON_LWA_REFRESH_TOKEN,
  //   NEXT_PUBLIC_SUPABASE_URL (hoặc SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY
  //
  // TRƯỚC ĐÂY điều kiện là `if (cfg.supabase)` — tức chỉ cần Supabase URL +
  // service role key. Cấu hình đó đã có thật trên Vercel của VEXIM trong khi
  // AMAZON_LWA_* chưa set → client rơi xuống makeMockClient() và ghi SKU demo
  // (XMO-950-BLK / VPN-220 / B0DEMO0001…) thẳng vào DB production.
  // Đó là sự cố dữ liệu, không phải demo vô hại. Chặn tại đây.
  // ==========================================================================
  const allowRealDb = cfg.mode === "production" && cfg.supabase !== null;

  if (allowRealDb && cfg.supabase) {
    const sb = new SupabaseDbAdapter(cfg.supabase.url, cfg.supabase.serviceRoleKey);
    try {
      const shopsFromDb = await sb.listActiveProductionShops();
      if (shopsFromDb.length === 0) {
        // KHÔNG fallback DEMO_SHOP nữa: UUID 00000000-…-000000000001 không tồn
        // tại trong connections.seller_accounts, mà
        // inventory_snapshots.seller_account_id có FK tới bảng đó → insert sẽ
        // vỡ khoá ngoại và mỗi shop bị ghi sync_jobs status='failed'.
        // Trả về sạch để cron báo "0 shop" — đúng sự thật, dễ chẩn đoán.
        log(
          `[inventory-sync] mode=production nhưng KHÔNG có shop nào thoả ` +
            `(status='active' AND data_source='production'). Không sync gì cả.\n`,
        );
        return {
          mode: cfg.mode,
          db: "supabase",
          shopsProcessed: 0,
          totalSkus: 0,
          totalAlerts: 0,
          errors: [],
        };
      }
      db = sb;
      shops = shopsFromDb;
      log(
        `[inventory-sync] mode=production host=${cfg.spApiHost} · ${shops.length} shop production\n`,
      );
    } catch (e) {
      log(
        `[inventory-sync] cảnh báo: không kết nối được DB (${(e as Error).message.split("\n")[0]}). Chuyển DEMO MODE.\n`,
      );
      db = mock;
      shops = [DEMO_SHOP];
    }
  } else {
    db = mock;
    shops = [DEMO_SHOP];
    if (cfg.supabase) {
      log(
        `[inventory-sync] mode=${cfg.mode} · có Supabase credentials nhưng THIẾU AMAZON_LWA_* → ` +
          `KHÔNG ghi DB thật (chống demo data lọt vào production). Chạy demo trong bộ nhớ.\n`,
      );
    } else {
      log(
        `[inventory-sync] mode=${cfg.mode} (chưa đủ Supabase + LWA — chạy demo trong bộ nhớ, không ghi DB)\n`,
      );
    }
  }

  // Đảm bảo mock db có dữ liệu bán cho các shop demo
  if (db instanceof MockDbAdapter) {
    seedSellingDaysForShop(db, DEMO_SHOP.id);
  }

  const result: InventorySyncRunResult = {
    mode: cfg.mode,
    db: db instanceof SupabaseDbAdapter ? "supabase" : "mock",
    shopsProcessed: 0,
    totalSkus: 0,
    totalAlerts: 0,
    errors: [],
  };

  // Client giả cho demo mode
  const makeMockClient = () =>
    ({
      getInventorySummaries: async () => ({
        granularity: { granularityType: "Marketplace", granularityId: "ATVPDKIKX0DER" },
        inventorySummaries: [
          {
            asin: "B0DEMO0001",
            fnSku: "X00DEMO01",
            sellerSku: "XMO-950-BLK",
            totalQuantity: 160,
            inventoryDetails: {
              fulfillableQuantity: 88,
              reservedQuantity: { totalReservedQuantity: 12 },
              inboundWorkingQuantity: 0,
              inboundShippedQuantity: 60,
              inboundReceivingQuantity: 0,
            },
          },
          {
            asin: "B0DEMO0002",
            fnSku: "X00DEMO02",
            sellerSku: "VPN-220",
            totalQuantity: 214,
            inventoryDetails: {
              fulfillableQuantity: 214,
              reservedQuantity: { totalReservedQuantity: 0 },
              inboundWorkingQuantity: 0,
              inboundShippedQuantity: 0,
              inboundReceivingQuantity: 0,
            },
          },
        ],
      }),
    }) as unknown as InstanceType<typeof FbaInventoryClient>;

  for (const shop of shops) {
    const startedAt = new Date();
    await db.recordSyncJob({
      sellerAccountId: shop.id,
      jobType: "inventory.pull",
      status: "running",
      attempts: 1,
      startedAt,
      payload: { marketplace: shop.marketplace, lead_days: shop.leadDays },
    });

    try {
      let client: InstanceType<typeof FbaInventoryClient>;
      if (cfg.lwa?.refreshToken && cfg.supabase && db instanceof SupabaseDbAdapter) {
        const tokens = new LwaTokenManager({
          clientId: cfg.lwa.clientId,
          clientSecret: cfg.lwa.clientSecret,
          refreshToken: cfg.lwa.refreshToken,
        });
        client = new FbaInventoryClient({ host: cfg.spApiHost, lwa: tokens });
      } else {
        if (db instanceof MockDbAdapter && !hasSeedFor(db, shop.id)) {
          seedSellingDaysForShop(db, shop.id);
        }
        client = makeMockClient();
      }

      const report = await runInventorySync({
        sellerAccountId: shop.id,
        marketplaceId: shop.marketplace,
        client,
        adapter: db,
        leadDays: shop.leadDays ?? cfg.leadDaysDefault,
        now,
      });

      for (const a of report.alerts) {
        await db.upsertAlert({
          sellerAccountId: shop.id,
          ruleCode: a.type === "stockout" ? "stockout" : "stockout_risk",
          severity: a.severity,
          title:
            a.type === "stockout"
              ? `Hết hàng ${a.sku} — cần nhập ngay`
              : `Tồn ${a.sku} chỉ còn ${a.coverDays} ngày cover`,
          detail: `Shop ${shop.displayName} · SKU ${a.sku} · cover ${a.coverDays} ngày`,
        });
        result.totalAlerts++;
      }

      await db.recordSyncJob({
        sellerAccountId: shop.id,
        jobType: "inventory.pull",
        status: "done",
        finishedAt: new Date(),
      });

      result.shopsProcessed++;
      result.totalSkus += report.skusProcessed;
      log(
        `  ✓ ${shop.displayName} (${shop.marketplace}) · ${report.skusProcessed} SKUs · ${report.alerts.length} alerts · ${report.suggestions.length} đề xuất nhập\n`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ shopId: shop.id, error: message });
      await db.recordSyncJob({
        sellerAccountId: shop.id,
        jobType: "inventory.pull",
        status: "failed",
        lastError: message,
        finishedAt: new Date(),
      });
      log(`  ✗ ${shop.displayName}: ${message}\n`);
    }
  }

  log(
    `[inventory-sync] xong · ${result.shopsProcessed} shops · ${result.totalSkus} SKUs · ${result.totalAlerts} alerts · ${result.errors.length} errors\n`,
  );
  return result;
}

// ---------- Demo seed ----------
function seedSellingDaysForShop(db: MockDbAdapter, shopId: string) {
  db.seedSellingDays(shopId, "XMO-950-BLK", [
    17, 50, 17, 17, 50, 17, 17, 17, 17, 17, 17, 17, 17, 17,
  ]);
  db.seedSellingDays(shopId, "VPN-220", [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]);
}

function hasSeedFor(db: MockDbAdapter, shopId: string): boolean {
  // @ts-expect-error — truy cập field nội bộ MockDbAdapter
  return Object.keys(db.sellingDays).some((k) => k.startsWith(`${shopId}:`));
}
