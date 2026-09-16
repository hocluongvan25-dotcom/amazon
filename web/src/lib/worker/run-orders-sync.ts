/**
 * Runner — ĐỒNG BỘ ĐƠN HÀNG qua Orders API v0 cho MỌI shop production.
 *
 *   /api/cron/orders-sync  →  runOrdersSyncAll()  →  OrdersClient + adapter
 *
 * VÌ SAO CÓ FILE NÀY (sự cố 16/09/2026, câu hỏi của chủ dự án trên màn /orders):
 *   Module 4 có job + adapter + parser đầy đủ nhưng **không có runner**: không CLI,
 *   không cron, không client gọi getOrders ⇒ DB không bao giờ có đơn, màn /orders
 *   trống mãi và bộ chọn shop cũng chẳng có gì để xem. Runner này nối đúng tầng
 *   delta mà `jobs/orders-sync.job.ts` đã mô tả:
 *
 *     mỗi shop → getOrders(LastUpdatedAfter = now − N ngày) → getOrderItems (có trần)
 *     → upsert sales.orders + order_items + order_daily → alert FBM → sync_jobs
 *
 * Ba quyết định CỐ Ý (ghi rõ để lần sau không phải đoán):
 *   1. KHÔNG gọi endpoint PII (`/address`, `/buyerInfo`) — quyết định v1.1. Hệ quả:
 *      `ship_state`/`ship_country` để trống ở đường API; muốn có thì dùng tầng report
 *      (`worker:orders-sync --report=<file>`), nơi report đã bỏ PII sẵn.
 *   2. `getOrderItems` có NGÂN SÁCH THỜI GIAN mỗi lượt (`maxItemMs`, mặc định 12s):
 *      0.5 rps · burst 30 ⇒ 37 request đầu đi ngay rồi mỗi request cách 2s; xin item
 *      cho vài trăm đơn là vượt trần 60s của Vercel. Hết ngân sách thì DỪNG, đơn
 *      vẫn được ghi (thiếu SKU) và lượt sau lấy tiếp — log nói rõ số đơn bị hoãn.
 *      Đơn được xử lý MỚI NHẤT TRƯỚC (LastUpdateDate giảm dần): đơn vừa phát sinh /
 *      vừa đổi trạng thái là đơn cần SKU ngay cho queue FBM.
 *   3. Lần đầu không có mốc cũ ⇒ mặc định nhìn lại 7 ngày (`--days=N` để backfill,
 *      tối đa 60 ngày). getOrders KHÔNG giới hạn số ngày, nhưng kéo quá rộng thì
 *      chạm trần tốc độ ngay lượt đầu.
 */
import { loadConfig, type DataMode } from "./config.ts";
import { LwaTokenManager } from "./amazon/lwa.ts";
import { OrdersClient, ordersHostForRegion } from "./amazon/orders.ts";
import { MockDbAdapter, type ActiveShop, type AlertRowInput, type DbAdapter, type OrderDailyRowInput, type OrderRowInput, type SyncJobRecord } from "./db/adapter.ts";
import { SupabaseDbAdapter } from "./db/supabase.ts";
import { buildFbmQueue, fbmShipAlert, orderDeltaWindow, spApiSafeBefore } from "./domain/orders.ts";
import { apiOrderToRowInput, orderDailyFromApiOrders } from "./domain/orders-api.ts";

export type OrdersSyncOutcome = {
  shop: string;
  shopId: string;
  window: string;
  orders: number;
  items: number;
  pages: number;
  days: number;
  throttled: boolean;
  /** số đơn chưa lấy được item trong lượt này (sẽ lấy ở lượt sau) */
  itemsDeferred: number;
  status: "done" | "skipped" | "failed";
  message: string;
};

export type OrdersSyncRunResult = {
  mode: DataMode;
  db: "supabase" | "mock";
  apiConfigured: boolean;
  shopsProcessed: number;
  ordersUpserted: number;
  itemsUpserted: number;
  pages: number;
  throttled: boolean;
  deferred: number;
  skipped: number;
  failed: number;
  outcomes: OrdersSyncOutcome[];
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

/** Mốc ISO → ms (0 nếu không đọc được) — chỉ dùng để SẮP XẾP, không ghi DB. */
export function isoMs(value?: string | null): number | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const t = new Date(raw).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Ngày (UTC) của một mốc thời gian — dùng để gom `order_daily`. */
export function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Gom đơn theo NGÀY MUA (UTC) — mỗi ngày một dòng `order_daily`. */
export function groupOrdersByDay(rows: readonly OrderRowInput[]): Map<string, OrderRowInput[]> {
  const map = new Map<string, OrderRowInput[]>();
  for (const row of rows) {
    const key = utcDayKey(row.purchaseDate);
    const bucket = map.get(key);
    if (bucket) bucket.push(row);
    else map.set(key, [row]);
  }
  return map;
}

export async function runOrdersSyncAll(
  deps: {
    /** số ngày nhìn lại (mặc định 7; `--days=N` khi cần backfill, kẹp 1..60) */
    days?: number | null;
    /** trần số đơn được gọi getOrderItems trong lượt này (mặc định 200) */
    maxItemFetches?: number | null;
    /** ngân sách thời gian cho getOrderItems mỗi lượt, ms (mặc định 12.000) */
    maxItemMs?: number | null;
    /** cho test: đồng hồ đo ngân sách item */
    nowMs?: () => number;
    sellerAccountId?: string | null;
    dryRun?: boolean;
    now?: Date;
    stdout?: { write: (s: string) => void };
    /** cho test: tiêm adapter */
    adapter?: DbAdapter;
    /** cho test: tiêm client (trả null = shop không có credential riêng) */
    clientFor?: (shop: ActiveShop) => OrdersClient | null;
  } = {},
): Promise<OrdersSyncRunResult> {
  const log = (text: string): void => {
    deps.stdout?.write(text);
  };
  const cfg = loadConfig();
  const now = deps.now ?? new Date();
  const days = Math.min(Math.max(Math.floor(Number(deps.days ?? 7)) || 7, 1), 60);
  const maxItemFetches = Math.max(0, Math.floor(Number(deps.maxItemFetches ?? 200)) || 0);
  const maxItemMs = Math.max(0, Math.floor(Number(deps.maxItemMs ?? 12_000)) || 0);
  const nowMs = deps.nowMs ?? (() => Date.now());
  const allowRealDb = cfg.mode === "production" && cfg.supabase !== null;

  let db: DbAdapter;
  let shops: ActiveShop[];
  if (deps.adapter) {
    db = deps.adapter;
    shops = [DEMO_SHOP];
  } else if (allowRealDb && cfg.supabase) {
    const sb = new SupabaseDbAdapter(cfg.supabase.url, cfg.supabase.serviceRoleKey);
    try {
      const fromDb = await sb.listActiveProductionShops();
      if (fromDb.length === 0) {
        log("[orders-sync] mode=production nhưng KHÔNG có shop nào thoả (status='active' AND data_source='production') → không kéo đơn nào.\n");
        return emptyResult(cfg.mode, "supabase", true);
      }
      db = sb;
      shops = deps.sellerAccountId ? fromDb.filter((s) => s.id === deps.sellerAccountId) : fromDb;
      if (shops.length === 0) {
        log(`[orders-sync] không thấy shop ${deps.sellerAccountId} trong danh sách production → không làm gì.\n`);
        return emptyResult(cfg.mode, "supabase", true);
      }
      log(
        `[orders-sync] mode=production host=${cfg.spApiHost} · ${shops.length} shop · nhìn lại ${days} ngày` +
          `${deps.dryRun ? " · DRY-RUN (không ghi DB)" : ""}\n`,
      );
    } catch (e) {
      log(`[orders-sync] không kết nối được DB (${(e as Error).message.split("\n")[0]}) → DEMO, không ghi gì.\n`);
      db = new MockDbAdapter();
      shops = [DEMO_SHOP];
    }
  } else {
    db = new MockDbAdapter();
    shops = [DEMO_SHOP];
    log(
      `[orders-sync] mode=${cfg.mode} → CHƯA đủ credential (cần AMAZON_LWA_CLIENT_ID/_SECRET/_REFRESH_TOKEN ` +
        `+ SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY). Chạy demo trong bộ nhớ, KHÔNG ghi DB.\n`,
    );
  }

  const apiConfigured = !!(cfg.lwa?.refreshToken && db instanceof SupabaseDbAdapter);
  const clientFor =
    deps.clientFor ??
    ((shop: ActiveShop): OrdersClient | null => {
      if (!apiConfigured || !cfg.lwa?.refreshToken) return null;
      const lwa = new LwaTokenManager(
        { clientId: cfg.lwa.clientId, clientSecret: cfg.lwa.clientSecret, refreshToken: cfg.lwa.refreshToken },
      );
      return new OrdersClient(lwa, {
        host: ordersHostForRegion(cfg.spApiHost.includes("sandbox") ? "NA_SANDBOX" : (process.env.AMAZON_SP_API_REGION ?? "NA")),
        log,
      });
    });

  // CHỐT SỰ CỐ 16/09/2026 (mọi shop 400 InvalidInput): Amazon BẮT BUỘC mốc
  // LastUpdatedBefore phải sớm hơn giờ hiện tại ÍT NHẤT 2 phút (dữ liệu getOrders có
  // độ trễ hệ thống ~2 phút). Trước đây ta truyền `watermark = now` nên request nào
  // cũng bị từ chối. Nay chặn trên lùi 3 phút (2 phút trễ + 1 phút biên độ đồng hồ);
  // cửa sổ 3 phút bỏ lỡ sẽ được lượt sau phủ lại vì nhìn lại nhiều ngày.
  const lastUpdatedBefore = spApiSafeBefore(now);

  const outcomes: OrdersSyncOutcome[] = [];
  const errors: { shopId: string; error: string }[] = [];
  let ordersUpserted = 0;
  let itemsUpserted = 0;
  let pages = 0;
  let throttled = false;
  let deferred = 0;
  let skipped = 0;
  let failed = 0;

  for (const shop of shops) {
    const window = orderDeltaWindow(new Date(now.getTime() - days * 86_400_000), now);
    const client = clientFor(shop);

    if (!client) {
      skipped += 1;
      const message = apiConfigured
        ? `shop ${shop.displayName} thiếu client Orders (kiểm tra refresh token)`
        : "chưa cấu hình credential SP-API (AMAZON_LWA_*)";
      outcomes.push({
        shop: shop.displayName,
        shopId: shop.id,
        window: window.lastUpdatedAfter.toISOString(),
        orders: 0,
        items: 0,
        pages: 0,
        days,
        throttled: false,
        itemsDeferred: 0,
        status: "skipped",
        message,
      });
      log(`[orders-sync] ${shop.displayName}: BỎ QUA — ${message}\n`);
      continue;
    }

    const jobPayload: Record<string, unknown> = {
      source: "orders-api-v0",
      lastUpdatedAfter: window.lastUpdatedAfter.toISOString(),
      lastUpdatedBefore: lastUpdatedBefore.toISOString(),
      days,
    };
    const job: SyncJobRecord = {
      sellerAccountId: shop.id,
      jobType: "orders.sync",
      status: "running",
      startedAt: now,
      payload: jobPayload,
    };
    if (!deps.dryRun) await db.recordSyncJob(job);

    try {
      const listed = await client.listOrders({
        marketplaceIds: [shop.marketplace],
        lastUpdatedAfter: window.lastUpdatedAfter,
        // KHÔNG dùng window.watermark (= now) — Amazon đòi mốc "...Before" phải sớm
        // hơn giờ hiện tại ít nhất 2 phút, không thì 400 InvalidInput.
        lastUpdatedBefore,
        maxResultsPerPage: 100,
      });
      pages += listed.pages;
      if (listed.throttled) throttled = true;

      // Lấy item trong NGÂN SÁCH THỜI GIAN (0.5 rps · burst 30) — phần còn lại ghi
      // đơn trước, lần chạy sau bù item. MỚI NHẤT TRƯỚC: đơn vừa đổi trạng thái cần
      // SKU ngay cho queue FBM; đơn cũ đã lấy item ở lượt trước đó.
      const itemDeadline = nowMs() + maxItemMs;
      const ordered = [...listed.orders].sort((a, b) => {
        const ta = isoMs(a.LastUpdateDate) ?? isoMs(a.PurchaseDate) ?? 0;
        const tb = isoMs(b.LastUpdateDate) ?? isoMs(b.PurchaseDate) ?? 0;
        return tb - ta;
      });
      const rows: OrderRowInput[] = [];
      let itemFetches = 0;
      let shopItems = 0;
      for (const order of ordered) {
        const wantItems = itemFetches < maxItemFetches && nowMs() < itemDeadline;
        let items: Awaited<ReturnType<typeof client.listOrderItems>>["items"] = [];
        if (wantItems) {
          const orderId = String(order.AmazonOrderId ?? "");
          if (orderId) {
            const res = await client.listOrderItems(orderId);
            items = res.items;
            itemFetches += 1;
            if (res.throttled) throttled = true;
          }
        }
        const row = apiOrderToRowInput(shop.id, order, items);
        if (!row) continue;
        shopItems += row.orderItems.length;
        rows.push(row);
      }
      const itemsDeferredShop = Math.max(0, ordered.length - itemFetches);
      deferred += itemsDeferredShop;

      if (!deps.dryRun) {
        await db.upsertOrders(rows);
        for (const [day, dayRows] of groupOrdersByDay(rows)) {
          await db.upsertOrderDaily(orderDailyFromApiOrders(shop.id, day, dayRows, now));
        }
        // Alert hạn ship FBM: đường API CÓ `LatestShipDate` (khác tầng report) nên
        // hạn ở đây là hạn THẬT, không phải "ước lượng +24h".
        const fbmQueue = buildFbmQueue(
          rows.map((r) => ({
            amazonOrderId: r.amazonOrderId,
            status: r.status,
            fulfillmentChannel: r.channel,
            purchaseDate: r.purchaseDate.toISOString(),
            latestShipDate: listed.orders.find((o) => o.AmazonOrderId === r.amazonOrderId)?.LatestShipDate ?? null,
            orderTotal: r.orderTotal,
            itemsCount: r.itemsCount,
            sku: r.orderItems[0]?.sku ?? null,
          })),
          now,
          { handlingHours: 24 },
        );
        const shipAlert = fbmShipAlert(fbmQueue);
        if (shipAlert) {
          const alert: AlertRowInput = {
            sellerAccountId: shop.id,
            ruleCode: shipAlert.ruleCode,
            severity: shipAlert.severity,
            title: shipAlert.title,
            detail: shipAlert.detail,
          };
          await db.upsertAlert(alert);
        }
      }

      ordersUpserted += rows.length;
      itemsUpserted += shopItems;
      job.status = "done";
      job.finishedAt = new Date();
      job.payload = {
        ...jobPayload,
        orders: rows.length,
        items: shopItems,
        pages: listed.pages,
        throttled: listed.throttled,
        itemsDeferred: itemsDeferredShop,
      };
      if (!deps.dryRun) await db.recordSyncJob(job);

      const message =
        `${rows.length} đơn · ${shopItems} dòng hàng · ${listed.pages} trang` +
        (itemsDeferredShop > 0
          ? ` · HOÃN item ${itemsDeferredShop} đơn (hết ngân sách ${Math.round(maxItemMs / 1000)}s/lượt) — lượt sau lấy tiếp`
          : "") +
        (listed.throttled ? " · bị hoãn vì trần tốc độ getOrders" : "");
      outcomes.push({
        shop: shop.displayName,
        shopId: shop.id,
        window: `${window.lastUpdatedAfter.toISOString()} → ${lastUpdatedBefore.toISOString()}`,
        orders: rows.length,
        items: shopItems,
        pages: listed.pages,
        days,
        throttled: listed.throttled,
        itemsDeferred: itemsDeferredShop,
        status: "done",
        message,
      });
      log(`[orders-sync] ${shop.displayName}: ${message}\n`);
    } catch (e) {
      failed += 1;
      const message = (e as Error).message.split("\n")[0];
      errors.push({ shopId: shop.id, error: message });
      job.status = "failed";
      job.finishedAt = new Date();
      job.lastError = message;
      if (!deps.dryRun) await db.recordSyncJob(job);
      outcomes.push({
        shop: shop.displayName,
        shopId: shop.id,
        window: window.lastUpdatedAfter.toISOString(),
        orders: 0,
        items: 0,
        pages: 0,
        days,
        throttled: false,
        itemsDeferred: 0,
        status: "failed",
        message,
      });
      log(`[orders-sync] ${shop.displayName}: LỖI — ${message}\n`);
    }
  }

  return {
    mode: cfg.mode,
    db: db instanceof SupabaseDbAdapter ? "supabase" : "mock",
    apiConfigured,
    shopsProcessed: shops.length,
    ordersUpserted,
    itemsUpserted,
    pages,
    throttled,
    deferred,
    skipped,
    failed,
    outcomes,
    errors,
  };
}

function emptyResult(mode: DataMode, db: "supabase" | "mock", apiConfigured: boolean): OrdersSyncRunResult {
  return {
    mode,
    db,
    apiConfigured,
    shopsProcessed: 0,
    ordersUpserted: 0,
    itemsUpserted: 0,
    pages: 0,
    throttled: false,
    deferred: 0,
    skipped: 0,
    failed: 0,
    outcomes: [],
    errors: [],
  };
}
