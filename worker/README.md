# VEXIM Ops Worker — Sync Layer (Module 3 Kho vận + Module 1 Listing)

Đồng bộ tồn kho Amazon FBA theo kiến trúc 3 tầng trong
`docs/phan-tich-ky-thuat-module-3-kho-van.md` §1.1:

| Tầng | Nguồn | Tần suất | File |
|------|-------|----------|------|
| 1 — Realtime | Notification `FBA_INVENTORY_AVAILABILITY_CHANGES` (EventBridge/SQS) | Sự kiện | `src/notifications/fba-inventory.handler.ts` |
| 2 — Snapshot | `getInventorySummaries` (FBA Inventory v1) | 30–60 phút/shop | `src/jobs/inventory-sync.job.ts` + `src/amazon/fba-inventory.ts` |
| 3 — Đối soát | Report `GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA` (TSV) | 2h sáng | `src/reports/myi.parser.ts` |

> **⚠️ VỊ TRÍ CODE (đổi 12/09/2026):** inventory sync engine giờ nằm ở
> **`web/src/lib/worker/`**, không còn ở `worker/src/`.
> Lý do: Vercel đặt **Root Directory = `web`**, nên `web/` phải tự đủ — import cũ
> `"../../../../worker/src/runtime/run-inventory-sync"` làm build Vercel fail với
> `Module not found`. Các file `worker/src/{config,amazon/lwa,amazon/fba-inventory,
> db/adapter,db/supabase,domain/inventory-metrics,jobs/inventory-sync.job,
> runtime/run-inventory-sync}.ts` nay là **shim re-export** nên `cli.ts` và
> `worker/tests/*.test.ts` không phải đổi gì (96/96 test vẫn pass).
>
> `worker/` vẫn giữ phần **không** deploy lên Vercel: listings, pricing, finance,
> reports (MYI / merchant listings / stranded), notification handlers.


Nguyên tắc đã chốt: **không bao giờ đè số khi lệch nguồn** — lệch được đẩy
vào Sync Health để con người quyết (tránh bẫy cột `afn-reserved-*` rỗng
trong một số kỳ report).

## Chỉ số nghiệp vụ (`src/domain/inventory-metrics.ts`)

Đúng công thức tài liệu §2:

- `velocity_14d` = (tổng bán 14 ngày − 2 ngày đỉnh outlier) / 14; < 7 ngày dữ liệu → 0
- `days_of_cover` = floor(fulfillable / velocity); velocity 0 → null ("—")
- Đề xuất nhập = ceil theo case pack của `velocity × (lead + safety 14) − (fulfillable + reserved + inbound)`; ≤ 0 → "Đủ hàng"
- Mức cảnh báo: cover < 7 → đỏ · 7–13 → vàng · ≥ 14 → không cảnh báo

## Chạy

```bash
cd worker
npm test          # 16 test (node:test, không cần deps)
```

Không có dependency runtime — Node ≥ 22 (chạy TS trực tiếp qua
`--experimental-strip-types`; **lưu ý**: không dùng parameter property
`constructor(private x)` vì strip-only mode không hỗ trợ).

## Chế độ dữ liệu (`src/config.ts`)

Biến môi trường quyết định chế độ:

| Chế độ | Điều kiện |
|--------|-----------|
| `production` | `SPAPI_LWA_CLIENT_ID` + `SPAPI_LWA_CLIENT_SECRET` + `SPAPI_LWA_REFRESH_TOKEN` + `SUPABASE_URL` (hoặc `NEXT_PUBLIC_SUPABASE_URL`) + `SUPABASE_SERVICE_ROLE_KEY` |
| `sandbox` | Chỉ đủ bộ LWA (host: `sandbox.sellingpartnerapi-na`) |
| `mock` | Thiếu biến — dùng `MockDbAdapter` (in-memory) |

Host mặc định NA: `sellingpartnerapi-na.amazon.com`.

## Chạy production trên Vercel (SP-API + PostgREST)

### 1. Quy tắc PostgREST — đọc trước khi sửa `web/src/lib/worker/db/supabase.ts`

Lỗi PGRST205/PGRST202 từng làm cron chết ngay vòng lặp đầu (12/09/2026)
vì gọi theo kiểu `connections.seller_accounts`:

| Quy tắc | Đúng | Sai |
|---|---|---|
| Đường dẫn không có tiền tố schema | `/rest/v1/seller_accounts` | `/rest/v1/connections.seller_accounts` → **PGRST205** |
| Chọn schema bằng header | `Accept-Profile: connections` (GET) · `Content-Profile: connections` (POST/PATCH/DELETE) | prefix vào path |
| RPC | `/rest/v1/rpc/active_production_shops` (wrapper trong schema `public`) | `/rest/v1/rpc/connections.active_production_shops` → **PGRST202** |

RPC bọc trong `public` bởi **migration `0008_public_rpc_wrappers.sql`**
(`public.active_production_shops`, `public.units_sold_per_day`) vì schema
`connections` / `inventory` có thể chưa nằm trong "Exposed schemas" của project.

### 2. Shop production phải có trong DB thì cron mới chạy

`runInventorySyncAll()` chỉ lặp qua các shop thoả
`status = 'active' AND data_source = 'production'`. Shop thật được đăng ký bởi
**migration `0009_seed_production_shops.sql`**:

```
seller_id   = AQMVYI4HJTI4C
marketplace = ATVPDKIKX0DER (US) + A2EUQ1WTGCTBG2 (CA)
```

Thiếu migration này → cron trả `shopsProcessed: 0` kèm log
"mode=production nhưng KHÔNG có shop nào thoả …".

### 3. FBA Inventory client (`web/src/lib/worker/amazon/fba-inventory.ts`)

`getInventorySummaries` bắt buộc:

- header **`x-amz-access-token`** (SP-API đọc token ở đây; `Authorization: Bearer`
  vẫn gửi kèm để tương thích ngược)
- query **`marketplaceIds`** (`granularityId` một mình không đủ → 400 InvalidInput)

### 4. Tra seller_id: `GET /api/amazon/whoami`

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/amazon/whoami
```

- Ưu tiên marketplace **US (ATVPDKIKX0DER)** khi shop tham gia nhiều marketplace
- Inventory trống (0 SKU) → mượn **ASIN dự phòng** (`AMAZON_WHOAMI_FALLBACK_ASIN`,
  mặc định `B08N5WRWNW`) để vẫn đọc được `SellerId` từ
  `feesEstimate.FeesEstimateIdentifier.SellerId`
- Response trả `productionShop.matchesRefreshToken` — `false` nghĩa là
  `AMAZON_LWA_REFRESH_TOKEN` trên Vercel đang thuộc shop khác

## Trạng thái

- [x] Tier 1 (mock): client LWA + FBA, notification handler, MYI parser, metrics, sync job — 16/16 test
- [ ] Kết nối Supabase thật (thay `MockDbAdapter` bằng adapter Postgres qua service_role)
- [ ] Đính kèm Sandbox App của VEXIM khi profile được duyệt
- [ ] Tầng report FC/receipts/adjustments (SOP-09 đối soát thất thoát)

## Module 1 — Listing (L1/L2/L4, Đợt 1 chỉ đọc)

| Nguồn | File | Ghi chú |
|-------|------|---------|
| `getListingsItem` (Listings Items API 2021-08-01, 5 rps/10 burst) | `src/amazon/listings.ts` | includedData: summaries, attributes, issues, offers, fulfillmentAvailability · itemName CÓ THỂ null |
| Notification `LISTINGS_ITEM_STATUS_CHANGE` | `src/notifications/listings.handler.ts` | Status flags BUYABLE/DISCOVERABLE → ACTIVE/SUPPRESSED/INACTIVE · Status rỗng = không áp dụng (bỏ qua) |
| Notification `LISTINGS_ITEM_ISSUES_CHANGE` (PayloadVersion 2023-12-13) | `src/notifications/listings.handler.ts` | KHÔNG chứa chi tiết → gọi getListingsItem lấy issues (đúng hướng dẫn Amazon) |
| Report `GET_MERCHANT_LISTINGS_ALL_DATA` / `..._INACTIVE_DATA` | `src/reports/merchant-listings.parser.ts` | TSV header thật có cột "Deprecated column" — parse theo TÊN cột · status "Active [*]" → SUPPRESSED |
| Report `GET_STRANDED_INVENTORY_UI_DATA` | `src/reports/merchant-listings.parser.ts` | cột "Stranded reason" → queue L4 (SOP-03) |
| Job nạp hằng ngày 2h sáng | `src/jobs/listings-sync.job.ts` | 3 report → listing state + queue L4 · cảnh báo khi ALL vs INACTIVE lệch nhau, không đè số mù quáng |

Write ops (`putListingsItem`, `patchListingsItem`, `JSON_LISTINGS_FEED`): **khóa đến Đợt 2** theo SOP-03 (Draft → duyệt → Publish).
