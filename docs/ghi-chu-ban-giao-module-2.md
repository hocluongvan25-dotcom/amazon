# Ghi chú bàn giao — Module 2 (Giá & Buy Box — P1/P2/P3)

> Phiên làm việc: 11/09/2026 · branch `arena/01a090a6-amazon`
> Commit base: `6dd39aa` (merge PR #1 — Module 0 + Module 1)

## 1. Bối cảnh

Phiên trước (`arena/01a08b9e-amazon`) bị Arena tự động đóng ngay sau khi PR #1 được merge
(do cơ chế bảo mật: token GitHub của phiên sống đến khi PR của phiên đó đóng).
Workspace sau đó bị refresh (compact `.git` + xóa `node_modules`), làm mất phần code
Module 2 đã làm ở phiên trước (chưa kịp push).

Phiên này đã **xây lại Module 2 hoàn toàn từ đầu** theo spec trong
`docs/ke-hoach-trien-khai-theo-module.md` — đúng cùng scope nhưng code sạch hơn và
có test phủ đầy đủ.

## 2. Trạng thái hiện tại

| Thứ | Trạng thái |
|---|---|
| Commit base | `6dd39aa` = `origin/main` (không thay đổi so với remote) |
| Module 2 P1/P2/P3 (web) | ✅ Hoàn thành — 3 route mới, compile OK, build OK |
| Pricing domain logic (worker) | ✅ Hoàn thành — pure function, test 100% pass |
| Pricing sync job | ✅ Config + pipeline snapshot (pure function test được) |
| Tests | ✅ 73/73 pass (gồm 45 test mới cho Module 2) |
| Next build | ✅ 33 route (thêm 3 route mới /pricing, /pricing/detail, /pricing/approve) |
| Preview dev server | ✅ Đang chạy trên port 3000 (cần cookie `demo_role=ceo` để truy cập) |
| Nav sidebar | ✅ Đã thêm mục "Giá & Buy Box 💲" cho CEO persona |

## 3. Danh sách file mới / sửa đổi

### Web (Next.js App Router)

| File | Loại | Ghi chú |
|---|---|---|
| `web/src/lib/types.ts` | sửa | Thêm `PricingRow`, `CompetitorOffer`, `PriceHistoryPoint`, `FeeBreakdown`, `PricingDetailMock`, `PriceApprovalItem`, `BoxStatus` |
| `web/src/lib/data/mock.ts` | sửa | Thêm `pricingKpis`, `pricingAlerts`, `pricingRows` (12 SKU), `pricingDetails` (2 SKU: XMO-950-BLK + VPN-220-PRO), `priceApprovalQueue` (8 đề xuất) |
| `web/src/lib/roles.ts` | sửa | Thêm nav entry "Giá & Buy Box" cho CEO |
| `web/src/app/(app)/pricing/page.tsx` | **mới** | P1 — Bảng giá & Featured Offer (filter: trạng thái box/shop/biên, sort: risk/margin/velocity/sku, KPI, alert, mini luồng P3) |
| `web/src/app/(app)/pricing/detail/page.tsx` | **mới** | P2 — Chi tiết giá 1 SKU (4 KPI, sparkline giá 30 ngày, breakdown giá sàn, bảng offers đối thủ có cột Featured/Buy Box) |
| `web/src/app/(app)/pricing/approve/page.tsx` | **mới** | P3 — Duyệt & áp giá (tách luồng operator tự duyệt vs trưởng phòng; bảng đề xuất có Δ%, biên sau, nút thao tác bị khóa ở DEMO mode; SOP-02 note) |

### Worker (đồng bộ SP-API)

| File | Loại | Ghi chú |
|---|---|---|
| `worker/src/domain/pricing.ts` | **mới** | Pure functions: `computeFloorPrice`, `computeMargin`, `marginTone`, `computeBoxStatus`, `priceDeltaPct`, `requiresLeadApproval`, `suggestPrice`, `pricingFlag`, `estimatedRevenueLeakage` — 45 test |
| `worker/src/jobs/pricing-sync.job.ts` | **mới** | `DEFAULT_PRICING_SYNC_CONFIG` (batch size 40/20 đúng SP-API docs, cron, RPS 0.5), `RawPricingPayload`, `PricingSnapshot`, `buildPricingSnapshot`, `chunkBatch`, `retryDelay` |
| `worker/tests/pricing.test.ts` | **mới** | 45 test cases (floor, margin, box status, delta, suggest, flag, leakage) |
| `worker/tests/pricing-sync.test.ts` | **mới** | 13 test cases (config, snapshot pipeline, chunk batch, retry backoff) |

### Khác

| File | Loại | Ghi chú |
|---|---|---|
| `.gitignore` | **mới** | Root gitignore (node_modules, .next, env, log…) |

## 4. Kiểm chứng nhanh

```bash
# Test (từ thư mục worker/)
cd worker && npm test            # 73/73 pass

# Type check + build Next
cd web && npm install
cd web && npx tsc --noEmit       # 0 lỗi
cd web && npx next build         # 33 route, build thành công

# Chạy dev (đã chạy sẵn trên port 3000)
cd web && npm run dev            # http://localhost:3000
# Đăng nhập demo: truy cập /login → chọn Ban điều hành VEXIM (ceo) → vào /pricing
```

## 5. Cập nhật — Module 6 (F1/F2) hoàn thành cùng phiên

Cùng phiên làm việc này, **Module 6 — Tài chính & Đối soát (F1/F2)** cũng đã được xây xong,
hoàn thành Đợt 1 (7/7 module đọc).

| File | Mô tả |
|---|---|
| `web/src/app/(app)/finance/page.tsx` | Cập nhật thêm tab navigation → F1/F2, khóa F3/F4 (Đợt 2) |
| `web/src/app/(app)/finance/settlements/page.tsx` | F1 danh sách kỳ settlement (filter shop/status, KPI tiền về/tổng đã nhận/số dư kỳ đang mở/tổng phí) |
| `web/src/app/(app)/finance/settlements/detail/page.tsx` | F1 chi tiết kỳ: nhóm phí + children, top SKU đóng góp, take rate & TACOS |
| `web/src/app/(app)/finance/events/page.tsx` | F2 financial events: filter loại/shop/search, tổng hợp vào/ra/net, link sang orders/pricing/settlements |
| `worker/src/domain/finance.ts` | reconcileSettlement (dung sai 1%), feeTakeRate, tacos, totalTakeRate, estimateReserveHold/OpenPayout, summarizeEvents |
| `worker/tests/finance.test.ts` | 18 test cases |

Tổng sau Module 6: **91/91 worker test pass**, **36 routes build OK** (thêm 3 routes finance).

## 6. Những gì CHƯA làm (nằm ngoài scope P1-P3 Đợt 2)

- **P4 — Quy tắc giá tự động (auto-apply)** — spec ghi rõ Đợt 3, đã khóa bằng chip dashed "P4 · Đợt 3".
- **Thao tác ghi giá thật (patchListingsItem / JSON_LISTINGS_FEED)** — cần SP-API credentials + Supabase; ở bản DEMO các nút "Áp giá" / "Từ chối" bị disabled và ghi rõ.
- **Notification ANY_OFFER_CHANGED / PRICE_HEALTH subscription** — handler notifications thật sẽ ở `worker/src/notifications/` khi có SQS/EventBridge; ở bản DEMO dữ liệu lấy từ mock.
- **getCompetitiveSummary (2022-05-01) thực tế** — giá trị foep/referencePrice đang mock theo spec docs Amazon; khi có credentials sẽ thay bằng API call thật theo lịch `DEFAULT_PRICING_SYNC_CONFIG`.
- **Supabase migration** cho bảng `sku_pricing` / `price_change_requests` — sẽ tạo khi chuyển sang SUPABASE MODE (Module 0 đã có 0001–0003 init).

## 6. Cách push lên GitHub (phiên này đã có token mới)

```bash
# Kiểm tra thay đổi
git status
git diff --stat

# Add & commit
git add .gitignore \
  web/src/lib/types.ts web/src/lib/data/mock.ts web/src/lib/roles.ts \
  "web/src/app/(app)/pricing/" \
  worker/src/domain/pricing.ts worker/src/jobs/pricing-sync.job.ts \
  worker/tests/pricing.test.ts worker/tests/pricing-sync.test.ts

git commit -m "feat(module-2): Giá & Featured Offer — P1 bảng giá, P2 chi tiết, P3 duyệt giá

- P1 /pricing: KPI 4 ô, filter trạng thái box/shop/biên, sort risk/margin/velocity/sku, bảng giá có FOEP, giá sàn, biên, Buy Box status
- P2 /pricing/detail: sparkline 30 ngày, breakdown giá sàn (cogs + referral + FBA + biên tối thiểu), bảng offers đối thủ cột Buy Box
- P3 /pricing/approve: tách luồng operator ≤2% vs trưởng phòng >2%, khóa dưới sàn, SOP-02
- worker pricing domain: computeFloorPrice, computeMargin, computeBoxStatus, suggestPrice, pricingFlag, estimatedRevenueLeakage
- worker pricing-sync.job: config batch (FOEP 40/offers 20/RPS 0.5) đúng SP-API docs, snapshot pipeline, chunkBatch, retryDelay
- Test: 73/73 pass (thêm 45 test mới cho pricing)
- Nav: thêm mục 'Giá & Buy Box 💲' cho CEO
- Build: 33 route OK"

git push origin arena/01a090a6-amazon
```

Sau khi push: mở PR trên GitHub → merge → Vercel tự động deploy bản có màn Giá & Buy Box.

## 7. Nguồn API Amazon bám theo

Mọi operation/rate/batch đều đã đối chiếu `developer-docs.amazon.com`:

- Product Pricing API **v0**: `getPricing` (0.5 rps/1 burst), `getItemOffers`, `getListingOffersBatch` (batch 20, 0.5 rps)
- Product Pricing API **2022-05-01**: `getCompetitiveSummary`, `getFeaturedOfferExpectedPriceBatch` (batch **40** — đây là phiên bản mới)
- Product Fees API **v0**: `getMyFeesEstimateForSKU`, `getMyFeesEstimates` (batch 20, 1 rps/2 burst)
- Listings Items API **2021-08-01**: `patchListingsItem` cho PATCH `/attributes/purchasable_offer`
- Feeds API **2021-06-30**: `JSON_LISTINGS_FEED` cho áp giá hàng loạt >100 SKU
- Notification: `ANY_OFFER_CHANGED`, `PRICE_HEALTH`

## 8. Truy cập preview

Dev server đang chạy trên port 3000 — để xem cần set cookie `demo_role=ceo` (hoặc đăng nhập
tại `/login` và chọn "Ban điều hành VEXIM"). Sau đó vào `/pricing` để xem P1.
