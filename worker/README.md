# VEXIM Ops Worker — Sync Layer (Module 3 Kho vận + Module 1 Listing)

Đồng bộ tồn kho Amazon FBA theo kiến trúc 3 tầng trong
`docs/phan-tich-ky-thuat-module-3-kho-van.md` §1.1:

| Tầng | Nguồn | Tần suất | File |
|------|-------|----------|------|
| 1 — Realtime | Notification `FBA_INVENTORY_AVAILABILITY_CHANGES` (EventBridge/SQS) | Sự kiện | `src/notifications/fba-inventory.handler.ts` |
| 2 — Snapshot | `getInventorySummaries` (FBA Inventory v1) | 30–60 phút/shop | `src/jobs/inventory-sync.job.ts` + `src/amazon/fba-inventory.ts` |
| 3 — Đối soát | Report `GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA` (TSV) | 2h sáng | `src/reports/myi.parser.ts` |

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
