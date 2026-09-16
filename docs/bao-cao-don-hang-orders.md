# Báo cáo Module 4 — Đơn hàng (`/orders`): bộ chọn shop & kết nối Orders API

Ngày 16/09/2026 · Nhánh `arena/01a0a83c-amazon` · Người thực hiện: Arena Agent

---

## 0. Ba câu hỏi của chủ dự án và trả lời ngắn

| Câu hỏi | Trả lời |
| --- | --- |
| “Trang `/orders` kiểm tra lại xem có vấn đề gì không?” | Có **hai vấn đề thật**: (1) **không có đường nào đưa đơn về DB** — web không có cron, không có CLI, không có client `getOrders`; (2) bảng **không lọc theo shop** dù có bộ chọn. Cả hai đã sửa trong lần này. |
| “Kiểm tra xem kết nối API đã chuẩn chưa?” | **Chưa chuẩn — nhưng không phải sai tham số, mà là THIẾU tầng gọi.** Mã nguồn chưa từng gọi `GET /orders/v0/orders`: `worker/src/jobs/orders-sync.job.ts` chỉ *mô tả* tầng delta trong tài liệu, còn `getOrders` chỉ xuất hiện trong **comment**. Nay đã có client + runner + cron + CLI, viết theo đúng model chính thức (mục 4). |
| “Sao không chọn được shop đã kéo về? Hay mặc định là như thế?” | **Không phải mặc định — đó là control giả.** Select trên Topbar trước đây render đúng **một** `<option>` lấy từ chuỗi `persona.shop` (“Shop: Tất cả (14)”), **không có `onChange`**, không đọc DB. Kéo shop về xong vẫn không chọn được vì control đó không nối vào đâu cả. Đã thay bằng bộ chọn thật (mục 2). |

---

## 1. Bối cảnh: `/orders` gồm những gì

- 5 trang: `/orders` (dashboard), `/orders/list`, `/orders/[id]` (chi tiết), `/orders/fbm` (queue hạn ship), `/orders/returns`. Gate `ALLOWED = ["ceo"]`.
- Chế độ SUPABASE: mọi trang đổ về `LiveOperations` → `readOperations(screen)` → đọc **view** `public.vexim_orders` / `vexim_fbm_queue` / `vexim_returns` / `vexim_order_items` (migration `0011_web_public_views.sql:59`), bằng **cookie người đăng nhập + anon key** (không service_role ⇒ RLS là hàng rào cuối).
- Chế độ DEMO: `web/src/app/(app)/orders/page.tsx` dùng `mock.ts` (`ordersKpis`, `shipMetrics`, `ordersAlerts`).
- Không có `lib/data/orders*.ts`: mọi màn dùng chung reader `operations.ts` theo `screen`.

---

## 2. Bộ chọn shop: từ control giả → phạm vi shop thật dùng chung toàn app

### 2.1. Trước đây sai thế nào

```tsx
// Topbar.tsx (bản cũ) — không onChange, không đọc DB, một option duy nhất:
<select><option>{persona.shop}</option></select>
```

Hệ quả: (a) không chọn được shop nào; (b) **dữ liệu các màn cũng không lọc theo shop** — chọn shop chỉ là “trang trí” nên mọi màn luôn hiện dữ liệu của mọi shop, gây cảm giác “không có gì thay đổi”. Đây là cùng một lỗi gốc với sự cố Module 1 (“không thấy shop nào”): **bộ chọn shop là chỗ chưa bao giờ được làm thật**.

### 2.2. Bây giờ

| Thành phần | Vai trò |
| --- | --- |
| `web/src/lib/data/shop-scope-model.ts` | Phần **thuần** (không import `next/headers`, không Supabase) ⇒ test được bằng `node --test` và import được từ client component: `pickShopScopeId`, `shopOptionLabel`, `allShopsLabel`, `SHOP_SCOPE_COOKIE`, `SHOP_SCOPE_MAX_AGE_SECONDS`. |
| `web/src/lib/data/shop-scope.ts` | Phần **server**: `readShopScopeOptions()` đọc `vexim_shops` (RLS lọc sẵn), **lùi cột V3 → V2** (`store_name` có từ migration 0031) để deploy code trước migration không vỡ bộ chọn; `resolveShopScope(urlShop?)`. |
| `web/src/components/shell/ShopScopeSelect.tsx` | Client: select **thật**, `onChange` ghi cookie `shop_scope` rồi `router.refresh()`; không có shop nào thì **khoá** và ghi rõ lý do (DEMO MODE · RLS không cho shop nào). |
| `web/src/app/(app)/layout.tsx` | `resolveShopScope()` → truyền xuống `AppShell` → `Topbar` (lỗi đọc shop **không** làm sập trang: `.catch()` + trong hàm đã bọc try). |

**Luật phạm vi (đã có test):** `?shop=` trên URL **thắng** cookie; cả hai đều phải nằm trong danh sách `vexim_shops` **đọc được**; id lạ/đã thu hồi/không có trong RLS ⇒ **bỏ qua** chứ không hiện trang lỗi; cuối cùng không chọn gì = **tất cả shop**. Nhãn: `Tất cả shop (N)`, mỗi shop `tên nội bộ — storeName` (bỏ vế sau nếu rỗng hoặc trùng tên).

**Vì sao không dùng `vexim_listings`:** bài học Task 3 — shop đã kết nối mà chưa sync listing vẫn phải chọn được. Nguồn duy nhất đúng là `vexim_shops`.

### 2.3. Lọc theo shop ở tầng DB (mọi màn operations)

```ts
// web/src/lib/data/operations.ts
readOperations(screen, filter?, shopId?)   // + eq("seller_account_id", shopId) khi có shopId
```

`LiveOperations` tự `resolveShopScope()` và truyền `scope.shopId` xuống ⇒ **mọi** màn đơn hàng/tài chính (`orders`, `fbm`, `returns`, `items`, `settlements`, `events`) đọc đúng shop đang chọn. Dòng mô tả trên tiêu đề ghi rõ `phạm vi: shop X` hoặc `tất cả shop (N)`; Topbar thêm “phạm vi shop: …”. Các view `vexim_*` đều có `seller_account_id` (0011) nên lọc ở DB hợp lệ cho mọi screen.

Ghi chú: chỗ cũ của select **tổ chức** (cũng là control tĩnh) nay đổi thành `<span>` (ẩn dưới `lg`) — không còn hai select cùng trông như chọn được.

---

## 3. Vì sao bảng đơn hàng trống: thiếu **runner**, không phải thiếu API

Điều tra ngày 16/09:

1. `web/vercel.json` chỉ có 3 cron: `inventory-sync 0 2` · `report-pull 0 3` · `research-collect 17 4` — **không có orders**.
2. `web/package.json` (worker) có `worker:ads-*`, `worker:reports-pull`, `worker:oauth-soon` — **không có `worker:orders-sync`**.
3. `web` **không** có file orders nào về nghiệp vụ; cả bộ (domain/parser/job) **chỉ nằm ở `worker/src`** ⇒ Vercel (Root Directory = `web`) không thể chạy.
4. `getOrders` chỉ là **comment** trong `jobs/orders-sync.job.ts`; tầng 1 (notification `ORDER_CHANGE`) và tầng 2 (delta API) **chưa được code**; chỉ tầng 3 (report) có thật nhưng web cũng chưa có kind report cho đơn.
5. Adapter thì **đã có sẵn** ở web: `upsertOrders` (on_conflict `seller_account_id+amazon_order_id`, xoá `order_items` theo `order_id` rồi ghi lại), `upsertReturns`, `upsertOrderDaily` ⇒ chỉ thiếu người gọi.

### 3.1. Đã bổ sung (theo đúng quy ước “code thật ở `web/`”)

| File | Việc |
| --- | --- |
| `web/src/lib/worker/domain/orders-api.ts` | Kiểu wire + hàm thuần: `assertMarketplaceIds`, `clampMaxResultsPerPage`, `moneyToNumber`, `normalizeApiOrderStatus`, `apiOrderToRowInput`, `apiItemToRowInput`, `orderDailyFromApiOrders`, `PII_LOCKED_PATHS`. |
| `web/src/lib/worker/amazon/orders.ts` | Client `OrdersClient`: `listOrders` (tự phân trang), `getOrdersPage`, `getOrder`, `listOrderItems`; `TokenBucket` theo trần Amazon; retry 429/5xx; log `x-amzn-RateLimit-Limit`; **chặn cứng 3 endpoint PII**. |
| `web/src/lib/worker/run-orders-sync.ts` | Runner: mỗi shop → `getOrders(LastUpdatedAfter = now − N ngày)` → `getOrderItems` → `upsertOrders` + `order_daily` → alert hạn ship FBM → `sync_jobs`. |
| `web/src/app/api/cron/orders-sync/route.ts` | Endpoint chạy được (CRON_SECRET), cờ `?days= ?shop= ?maxItems= ?dryRun=1`. |
| `web/src/app/api/cron/report-pull/route.ts` | Gộp thêm bước đơn hàng (cờ `?orders=0` để tắt) — vì repo đã chốt **không thêm cron thứ tư** (hạn mức cron của Vercel). |
| `web/src/app/(app)/orders/actions.ts` + `components/operations/OrdersSyncNowButton.tsx` | Nút **“▶ Đồng bộ đơn hàng ngay”** trên 3 màn đơn hàng: chạy đúng runner rồi in ra kết quả/lỗi thật (trên Vercel không có shell để chạy CLI). |
| `web/src/cli/run-orders-sync.ts` + `npm run worker:orders-sync` | CLI: `--days= --maxItems= --shop= --dryRun`, và `--report=/tmp/all-orders.txt [--returns=…]` cho tầng report. |
| `worker/src/{domain/orders.ts, reports/*.parser.ts, jobs/orders-sync.job.ts}` | Đổi thành **shim** trỏ về `web/src/lib/worker/**` (bộ test 490 của worker vẫn chạy qua shim, tất cả PASS). |

**Bất biến giữ nguyên:** web **không** gọi endpoint PII (`/address`, `/buyerInfo`, `/orderItems/buyerInfo`) — quyết định v1.1 “không lấy dữ liệu người mua”. Vì vậy `ship_state`/`ship_country` ở đường API để **trống có chủ đích**; chỉ tầng report (`GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL`, đã bỏ PII sẵn) mới có 2 cột đó.

---

## 4. Đối chiếu Orders API v0 với model chính thức

Nguồn: `amzn/selling-partner-api-models` → `models/orders-api-model/ordersV0.json` (tải bằng `gh api`, lưu `/tmp/ordersV0.json`).

| Hạng mục | Model chính thức | Code đã viết |
| --- | --- | --- |
| Endpoint danh sách | `GET /orders/v0/orders` | ✅ `/orders/v0/orders` |
| Tham số **bắt buộc** | `MarketplaceIds` (array) | ✅ `assertMarketplaceIds()` — thiếu ⇒ ném lỗi **trước khi gọi mạng**, kèm cách sửa |
| Cỡ trang | `MaxResultsPerPage` 1–100 | ✅ `clampMaxResultsPerPage()` (kẹp về 1..100, mặc định 100) |
| Lọc thời gian | `CreatedAfter/CreatedBefore/LastUpdatedAfter/LastUpdatedBefore` (string ISO) | ✅ delta dùng `LastUpdatedAfter` → `LastUpdatedBefore` + chồng lấn |
| Phân trang | `NextToken` (không áp lại filter) | ✅ tự vòng tới khi hết token hoặc chạm trần |
| Trần tốc độ | getOrders **0.0167 rps · burst 20**; getOrder/getOrderItems **0.5 rps · burst 30** | ✅ `ORDERS_RATE_LIMIT` + `TokenBucket` (có test: hết burst ⇒ chờ ~60s) |
| Mã lỗi | 400/403/404/413/415/429/503 | ✅ 429/5xx retry có `Retry-After`; 403/400 ném lỗi kèm `code`/`message` của Amazon |
| PII | `/address`, `/buyerInfo`, `/orderItems/buyerInfo` cần role restricted | ✅ **không gọi** (`isPiiLockedPath` chặn ở tầng request) |
| `orderItems` | chỉ có `orderId` (path) + `NextToken` | ✅ `listOrderItems(orderId)` — **không** gửi `MarketplaceIds` |

**Trần 60 giây của Vercel:** `getOrderItems` 0.5 rps ⇒ không thể xin item cho hàng nghìn đơn trong 1 lượt. Runner dùng **ngân sách thời gian** `maxItemMs` (cron 8s · nút bấm 15s), **mới nhất trước** (đơn vừa đổi trạng thái cần SKU cho queue FBM), phần chưa lấy được vẫn **ghi đơn** (thiếu SKU) và **báo rõ số bị hoãn** (`deferred`) để lượt sau bù — không im lặng.

---

## 5. Kiểm chứng

| Hạng mục | Kết quả |
| --- | --- |
| `web npm test` | **431/431** (trước 405; +6 `shop-scope.test.ts`, +20 `orders-api.test.ts`) |
| `web npx tsc --noEmit` | sạch |
| `web npm run build` | OK (`/api/cron/orders-sync` xuất hiện trong bảng route) |
| `worker npm test` | **490/490** (qua shim mới) |
| SSR | `/orders` · `/orders/fbm` · `/orders/returns` = **HTTP 200**; HTML có select phạm vi shop (DEMO: disabled + title “DEMO MODE chưa nối Supabase…”, option “Tất cả shop”), select tổ chức đã đổi thành text |
| Test tự động đường API | 20 test: tham số bắt buộc, kẹp cỡ trang, ánh xạ không mang PII, `NextToken`, 429-retry, 403, gom ngày, ghi orders/order_daily/alert, ngân sách item, trần item |

**Giới hạn của kiểm chứng cục bộ:** máy này **không** có credential SP-API/Supabase thật ⇒ nhánh SUPABASE (bộ chọn shop hiện danh sách shop thật, lọc theo `seller_account_id`) mới được kiểm bằng **test logic + kiểu**, chưa chạy được end-to-end ở đây. Trên máy chủ thật, sau khi có shop `status='active' AND data_source='production'`, bấm nút đồng bộ sẽ trả về số đơn thật hoặc lỗi thật của Amazon.

---

## 6. VEXIM cần làm để đơn hàng chạy

1. **Biến môi trường** (Vercel → Settings → Environment Variables): `AMAZON_LWA_CLIENT_ID`, `AMAZON_LWA_CLIENT_SECRET`, `AMAZON_LWA_REFRESH_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET` (đã có nếu cron cũ chạy được).
2. **Redeploy** để lấy bản web mới (runner + cron + bộ chọn shop).
3. Shop phải ở trạng thái `status='active' AND data_source='production'` (Module 0 · Kết nối shop). Shop còn `sandbox`/`revoked` sẽ bị **bỏ qua** và runner ghi rõ trong log.
4. Chạy lần đầu: mở `/orders` → **“▶ Đồng bộ đơn hàng ngay”** (hoặc chờ cron 03:00 UTC, hoặc `cd worker && npm run worker:orders-sync -- --days=30` để backfill 30 ngày).
5. Nếu muốn có `ship-state`/`ship-country` (vùng giao) thì chạy thêm tầng report: `cd worker && npm run worker:orders-sync -- --report=/tmp/all-orders.txt` (file report tải từ Report API).

---

## 7. Chưa làm (nói thẳng để không bị hiểu là “đã xong hết”)

- **Tầng 1 — notification `ORDER_CHANGE`** vẫn chưa nối (cần SQS queue + role notification; đây là hạng mục hạ tầng riêng). Hiện độ mới của đơn hàng = nhịp cron (1 lần/ngày) hoặc bấm tay.
- **ReportKind cho đơn hàng** chưa nằm trong `reports/registry.ts` của web ⇒ `/api/cron/report-pull?kinds=…` vẫn chỉ có 4 loại FBA; đường report cho đơn chạy qua CLI (`--report=`). Muốn tự động thì thêm 2 loại report (`GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL`, `GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE`) vào registry — việc nhỏ, nên làm ở lần sau khi cần đối soát.
- **Backfill dài (30–60 ngày)** nên chạy bằng CLI, không nên dồn vào cron (trần tốc độ + trần 60s).
- Ở đường API, `order_daily.fbm_overdue` là **ước lượng** theo mốc cập nhật nguồn (đường API không có trường hạn ship trong tổng hợp này); alert hạn ship FBM thì dùng `LatestShipDate` **thật** khi Amazon trả về.
