# TIẾN ĐỘ TRIỂN KHAI — VEXIM OPS

> Cập nhật: 12/09/2026 · Thứ tự build đã chốt: **0 → 7 → 4 → 3 → 1(đọc) → 2 → 6(đọc)** (21 màn Đợt 1)

## ⚠️ SỰ CỐ 12/09 — fixture test lọt vào DB production (ĐÃ SỬA)

VEXIM tạo project Supabase thật (`pitmyzovjwflkyoqjbkz`) và set 14 biến môi trường trên
Vercel. Đối chiếu dump DB với SQL trong repo phát hiện 3 lỗi chồng nhau:

| # | Lỗi | Bằng chứng | Đã sửa |
|---|---|---|---|
| 1 | `tests/rls_test.sql` kết thúc bằng `commit;` → fixture test bị ghi vĩnh viễn vào DB thật khi chạy nhầm trong SQL Editor | `organizations=3` (2 giả `dna`/`dnb`), `seller_accounts=9` (3 giả), `auth.users` có `u1@`/`u2@vexim.vn`+`client@dna.vn`, `listings=7` (`TEST-S*-`), `tasks=3`, `cost_inputs=2`, `oauth_tokens=1` (`ENCRYPTED-DUMMY`), `audit_logs=1` | migration **0006** + đổi `commit;`→`rollback;` + thêm cờ `vexim.allow_rls_test` |
| 2 | `seed/seed_demo.sql` mục 4+5 mở đầu bằng `if auth.uid() is null then return` — trong SQL Editor `auth.uid()` luôn NULL → **âm thầm bỏ qua** | `user_profiles=3` (đúng bằng 3 fixture test, không có user thật), `role_assignments=3` (không `super_admin` nào), `alerts=0` → chuông thông báo rơi về mock | migration **0007** nhận danh sách email tường minh, không cần phiên đăng nhập |
| 3 | `CRON_SECRET` **không có** trong 14 biến Vercel → `isAuthorized()` trả false trên production → cron 401 im lặng, không bao giờ chạy | `web/src/app/api/cron/inventory-sync/route.ts:16-18` | route trả **500 kèm thông báo nêu đích danh biến thiếu**; VEXIM cần thêm biến |

**Rủi ro thứ 4 (chặn trước khi xảy ra):** điều kiện cũ trong
`worker/src/runtime/run-inventory-sync.ts` là `if (cfg.supabase)`. Với
`NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` đã set nhưng
`AMAZON_LWA_*` chưa set, worker sẽ nối **DB thật** rồi dùng client mock →
ghi SKU demo (`XMO-950-BLK`, `VPN-220`, `B0DEMO0001…`) vào production.
Nay đổi thành `cfg.mode === "production"` (đòi đủ cả 5 biến) + bỏ fallback
`DEMO_SHOP` (UUID `0000…0001` không tồn tại → vỡ FK `inventory_snapshots`).

### Kiểm chứng (chạy thật, không suy luận)

```bash
cd worker && npm test      # 96 tests / 96 pass / 0 fail  (trước đó 93 — thêm 3 test mới)
cd web    && npx next build # ✓ Compiled successfully · 39/39 routes · exit 0
cd supabase && npm test     # 53 PASS / 0 FAIL — PostgreSQL 18.3 (PGlite/WASM)
```

Bộ `supabase/tests/run-migrations.mjs` **tái hiện đúng trạng thái DB của VEXIM**:
khớp **15/15** số đếm bảng và **4/4** email trong dump, rồi chạy 0006 → 0007 và
xác nhận dọn sạch fixture mà **vẫn giữ user thật** `hocluongvan88@gmail.com`.

Test regression có răng: đổi `allowRealDb` về `cfg.supabase !== null` thì test
*"Có Supabase nhưng THIẾU AMAZON_LWA_*"* **FAIL ngay** (đã kiểm chứng bằng cách
revert tạm).

### Việc VEXIM cần làm (theo thứ tự)

1. ✅ SQL Editor → chạy `migrations/0006_cleanup_rls_test_fixtures.sql` — **đã chạy 12/09**
2. ✅ SQL Editor → chạy `migrations/0007_seed_admin_and_alerts.sql` — **đã chạy 12/09**
   (xác nhận: `orgs=1, shops=6, users=1, admins=1, alerts=9, listings=0` — khớp kỳ vọng)
3. ✅ Vercel → thêm `CRON_SECRET` — **đã thêm 12/09**
4. ☐ Merge PR #3 để build Vercel chạy được (xem mục "Build Vercel" dưới)

## Build Vercel fail — nguyên nhân & cách sửa (12/09)

Deployment fail từ **PR #2** (`10974b6`), **không phải** do PR #3:

| Commit | Vercel |
|---|---|
| `6dd39aa` (PR #1) | ✅ success |
| `10974b6` (PR #2) | ❌ failure |
| `8194884`, `38be50c` (PR #3) | ❌ failure |

**Nguyên nhân:** Vercel đặt **Root Directory = `web`**, mà `web/src/lib/worker/index.ts`
import `"../../../../worker/src/runtime/run-inventory-sync"` — vượt ra ngoài `web/`.
Tái hiện bằng cách build `web/` trong thư mục cô lập:

```
./src/lib/worker/index.ts
Module not found: Can't resolve '../../../../worker/src/runtime/run-inventory-sync'
Import trace: ./src/app/api/cron/inventory-sync/route.ts
> Build failed because of webpack errors          BUILD_EXIT=1
```

**Đã sửa:**
- Chuyển 8 file của inventory sync engine vào `web/src/lib/worker/` (closure khép kín,
  không kéo thêm gì): `config`, `amazon/{lwa,fba-inventory}`, `db/{adapter,supabase}`,
  `domain/inventory-metrics`, `jobs/inventory-sync.job`, `run-inventory-sync`
- `worker/src/…` tương ứng thành **shim re-export** → `cli.ts` + 96 test không đổi
- **Dời `vercel.json` từ repo root vào `web/`** — Root Directory = `web` nên file ở
  root **không được Vercel đọc**, cron chưa bao giờ được đăng ký
- Đã loại trừ nguyên nhân khác: `npm ci --dry-run` trong `web/` exit 0 (lockfile đồng bộ)

**Kiểm chứng:** build `web/` cô lập (không có `worker/` bên cạnh) → `BUILD_EXIT=0`,
39/39 routes, có `/api/cron/inventory-sync`. Trước khi sửa: `BUILD_EXIT=1`.

### Nguyên nhân THỨ HAI — `vercel.json` sai vị trí + schedule vượt giới hạn Hobby

Sau khi dời `vercel.json` vào `web/` (bắt buộc, vì Root Directory = `web`), Vercel
**bắt đầu đọc** file đó — và lập tức từ chối vì:

> "Hobby accounts are limited to cron jobs that run once per day... Expressions like
> `0 * * * *` (per-hour) or `*/30 * * * *` (every 30 minutes) will fail deployment."
> — https://vercel.com/docs/cron-jobs/usage-and-pricing

Schedule cũ là `*/30 * * * *`. Trước đây nó **không** gây lỗi chỉ vì file nằm ở repo
root nên Vercel không đọc — tức cron chưa bao giờ được đăng ký.

**Đã đổi thành `0 2 * * *`** (2h sáng — khớp lịch đối soát trong
`docs/phan-tich-ky-thuat-module-3-kho-van.md`). Chạy được trên **mọi** gói Vercel.

Muốn quay lại 30 phút/lần:
- Gói **Pro**: sửa `web/vercel.json` → `"schedule": "*/30 * * * *"`, redeploy
- Gói **Hobby**: giữ route nguyên vẹn và dùng scheduler ngoài (cron-job.org,
  GitHub Actions `schedule`, …) gọi `GET /api/cron/inventory-sync` kèm header
  `Authorization: Bearer <CRON_SECRET>`. Route là HTTP endpoint thường nên
  không phụ thuộc Vercel Cron.

Hiện tại chưa cần 30 phút: `AMAZON_LWA_*` chưa có và cả 6 shop vẫn
`data_source='mock'` → `active_production_shops()` = 0 → sync chưa làm gì.

## Auth — middleware refresh session + `/api/whoami` (12/09)

Hai lỗ hổng khi chuyển sang SUPABASE MODE trên production:

1. **Middleware không refresh phiên.** `web/src/lib/supabase/server.ts` ghi
   *"Server Component đang render — middleware sẽ refresh session"*, nhưng
   middleware cũ chỉ kiểm tra cookie tên `sb-*` **có tồn tại**. Access token
   hết hạn → `getUser()` fail → user bị đá ra `/login` dù refresh token còn hạn.
   Nay gọi `supabase.auth.getUser()` đúng chuẩn `@supabase/ssr` (refresh cookie
   trên response).
2. **Cookie `demo_role` được tin trên production.** Middleware + `getAppSession()`
   ưu tiên `demo_role` trước user Supabase → cookie demo còn sót từ lúc thử
   DEMO MODE sẽ cho vào app mà không cần đăng nhập thật. Nay: đã cấu hình
   Supabase thì **chỉ** nhận `getUser()`; `demo_role` chỉ dùng khi chưa có env.

Endpoint chẩn đoán `GET /api/whoami` (whitelist, không redirect `/login`):
trả cookie **tên** (không value), cờ env (không key), `auth.getUser()`,
`iam.my_profile`, và header `x-vexim-middleware` để biết middleware có chạy.

`GET /api/amazon/whoami` (cũng whitelist; khoá `Authorization: Bearer <CRON_SECRET>`):
tra **seller_id + marketplace** của chính refresh_token (self-authorization) —
3 bước, lỗi từng bước không làm hỏng bước khác:

1. `GET /sellers/v1/marketplaceParticipations`
2. `GET /fba/inventory/v1/summaries` (xác nhận role Inventory, đếm SKU, ASIN mẫu)
3. `POST /products/fees/v0/items/{Asin}/feesEstimate` → `FeesEstimateIdentifier.SellerId`

Amazon không có endpoint whoami chính thức; seller ID chỉ lộ ở feesEstimate
(kể cả khi Status = ClientError). Không trả access token.

Cách gọi (sau khi merge / trên preview của PR, **không** phải domain production
nếu PR chưa merge):

```
curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  https://<host>/api/amazon/whoami
```

## Trạng thái tổng thể

| Luồng việc | Trạng thái |
|---|---|
| **Amazon Developer Profile** (lane Hải Anh) | 🟠 Đã nộp / đang chờ duyệt (2–8 tuần) · role Amazon Fulfillment đã chốt NỘP KÈM · nhớ tạo Sandbox Application ngay sau khi nộp |
| **Landing page** | ✅ Xong (chờ VEXIM thay 4 thông tin thật + deploy HTTPS) |
| **Database (Supabase)** | ✅ **3 migrations + seed đã kiểm chứng trên Postgres 18 thật — 10/10 test RLS multi-tenant PASS** (36 bảng · 44 policies · 12 SOP) · bắt & sửa 3 lỗi SQL trong quá trình test · chỉ còn push lên project khi VEXIM tạo |
| **Web app** | 🟢 Phase 1 đang chạy (xem dưới) |

## Phase 1 — Đợt 1 (Cấp độ 1)

| Module | Màn hình | Trạng thái |
|---|---|---|
| **0. Hạ tầng** | App skeleton + design system (đúng wireframe) | ✅ |
| | Đăng nhập demo 4 vai trò / Supabase Auth (2 mode tự chuyển) | ✅ |
| | Phân quyền UI theo vai trò + chặn trang sai phạm vi + banner phạm vi | ✅ |
| | 0.1 Kết nối shop (wizard 5 bước + checklist điều kiện) | ✅ (bản mock) |
| | 0.2 Sức khỏe đồng bộ (sync jobs, 3 tầng) | ✅ (bản mock) |
| | 0.3 Mức dùng API & chi phí | ✅ (bản mock) |
| | 0.4 Nhật ký thao tác (audit log) | ✅ (bản mock) |
| | 0.5 Người dùng & phân quyền | ✅ (bản mock) |
| | 8 trang dashboard (CEO + 6 phòng + Client) — chuyển từ wireframe sang app thật | ✅ (dữ liệu mock) |
| | SupabaseProvider — trang đọc dữ liệu thật từ Postgres | ⬜ kế tiếp |
| | Typed clients SP-API (từ Swagger models) + sandbox e2e | 🟠 bắt đầu — worker/ Module 3: LWA + FBA Inventory v1 + notification handler + MYI parser (16/16 test, chạy mock; sandbox chờ App duyệt) |
| **7. Account Health** | H1 Health theo shop (dashboard) | ✅ (mock) |
| | H2 Chi tiết vấn đề đang mở (vi phạm theo severity + case SOP-08) | ✅ (mock) |
| | **Domain + sync layer Health** (worker/): ngưỡng Amazon > fallback (đánh dấu nguồn), AHR 0–1000, 10 nhóm vi phạm + severity, SOP-08 (red 24h / amber 72h) · parser report V2 · job snapshot/issue/alert · handler ACCOUNT_STATUS_CHANGED | ✅ 46 test |
| **4. Đơn hàng** | O1 Danh sách đơn (không PII) · O2 Chi tiết đơn (PII khóa) · O3 Queue FBM (đếm ngược) · O4 Returns (mã lý do Amazon) | ✅ (mock) |
| **3. Kho vận (đọc)** | I1 Tồn theo SKU (filter, cover, đề xuất) · I2 Chi tiết tồn (90 ngày, FC, nhận hàng) · I3 Kế hoạch nhập (SOP-01, ghi khóa Đợt 2) · I4 Inbound (trạng thái chuẩn Amazon + đối soát) — kèm **phân tích kỹ thuật** `docs/phan-tich-ky-thuat-module-3-kho-van.md` (đã kiểm chứng: notification FBA_INVENTORY_AVAILABILITY_CHANGES, cột report MYI, report theo FC) | ✅ (mock) |
| | **Sync layer 3 tầng** (worker/): notification → getInventorySummaries → report MYI đối soát; chỉ số velocity/cover/đề xuất nhập đúng công thức §2 | ✅ Tier 1 (mock, 16/16 test) |
| **1. Listing (đọc)** | L1 Danh sách listing (filter trạng thái/shop/loại lỗi/brand, tìm kiếm, sort, xuất CSV) · L2 Chi tiết (thuộc tính theo product type, issues đúng mã lỗi Amazon, lịch sử, offer & Buy Box, doanh thu 30 ngày) · L4 Hàng đợi inactive/stranded theo SOP-03 | ✅ (mock) |
| | **Sync layer Listing** (worker/): getListingsItem + LISTINGS_ITEM_STATUS_CHANGE/ISSUES_CHANGE + 3 report parser (Merchant ALL/INACTIVE, Stranded) | ✅ (mock, 12 test) |
| **2. Giá & Buy Box** | P1 Bảng giá & Featured Offer (FOEP, giá sàn, biên, box status) · P2 Chi tiết giá (30 ngày, breakdown giá sàn, offers đối thủ) · P3 Duyệt & áp giá (≤2% operator / >2% trưởng phòng, khóa dưới sàn, SOP-02) | ✅ mock (PR #2) |
| | **Sync layer Pricing** (worker/): computeFloorPrice / computeMargin / computeBoxStatus / suggestPrice / pricingFlag · buildPricingSnapshot · batch/retry đúng SP-API 2022-05-01 (FOEP batch 40, offers 20, RPS 0.5) | ✅ mock, 73/73 test |
| | **Sync layer Orders** (worker/): parser report All Orders (bỏ cột PII khi parse) + Returns, gom đơn/tiền, queue FBM đếm ngược theo LatestShipDate, KPI/rollup ngày, alert `fbm_late_ship`/`return_reason_spike`, handler ORDER_CHANGE | ✅ 43 test |
| **6. Tài chính (đọc)** | F1 Danh sách kỳ settlement (filter shop/status, tổng tiền vào/ra/phí/ads) · F1 Chi tiết kỳ (phân loại nhóm phí, breakdown SKU, take rate/TACOS) · F2 Financial events (filter loại/shop/search, tổng hợp vào/ra/net) | ✅ mock |
| | **Domain Finance** (worker/): reconcileSettlement (dung sai 1% — SOP-10), totalCredits/Debits/netTransfer, feeTakeRate/TACOS/totalTakeRate, estimateReserveHold/OpenPayout, summarizeEvents | ✅ 91/91 test |
| | **Sync layer Finance** (worker/): parser settlement **V2** (số kiểu local 95,00/1.234,56), nhóm phí khớp domain, đối soát trừ dòng Transfer, replace (không cộng dồn) dòng tiền khi import lại | ✅ 24 test |

**Kiểm chứng build (12/09, sau khi sửa sự cố):** `next build` ✓ Compiled successfully · **39/39 routes** · exit 0 · worker test **96/96** · `supabase` test **53/53** trên PostgreSQL 18.3 ✅

**Cập nhật 11/09 — nối DB thật (sau feedback):**
- ✅ Tạo migration `0004_ui_policies_notifs_profile_invite.sql` bổ sung RLS cho `ops.alerts` (SELECT theo shop được phép), `iam.user_profiles` (self update phone/display_name/avatar_url/mfa_enabled, admin insert/update khi mời user), `iam.departments` & `connections.seller_accounts` cho mọi authenticated user đọc; `iam.role_assignments`/`iam.assignments` cho admin insert.
- ✅ Tạo 2 view tiện ích: `iam.my_profile` (profile + role + department của chính user đang đăng nhập), `ops.my_alerts` (alerts + tên shop của user).
- ✅ Chuông thông báo (`BellWithData.tsx`): query thật từ `ops.my_alerts` qua browser; đánh dấu ack khi mở dropdown; badge "● LIVE DB" khi có dữ liệu DB; fallback mock nếu query lỗi (sandbox) hoặc DB trống.
- ✅ Trang /profile (`ProfileClient.tsx`): đọc từ `iam.my_profile`; cho phép user tự sửa Họ tên / Số điện thoại (update thật xuống `iam.user_profiles`); nút "Gửi link reset mật khẩu" dùng `supabase.auth.resetPasswordForEmail`; panel Đăng xuất đỏ cuối trang.
- ✅ Form tạo user mới (`/module0/users/new`): tải danh sách phòng ban & shop từ DB; gọi `POST /api/admin/invite-user` dùng Supabase Auth Admin API mời email (service_role) + insert `iam.user_profiles`/`iam.role_assignments`/`iam.assignments` + ghi `iam.audit_logs`; kiểm tra phân cấp quyền (super_admin gán mọi role, org_admin không gán được super_admin, dept_lead chỉ được gán operator/analyst).
- ⚠️ ~~Seed `supabase/seed/seed_demo.sql`: tự động tạo super_admin cho tài khoản đang đăng nhập~~ — **SAI**. Mục 4+5 của file này mở đầu bằng `if auth.uid() is null then return`, mà trong SQL Editor `auth.uid()` luôn NULL → âm thầm bỏ qua. Đã thay bằng migration `0007`.
- ✅ Migration `0006_cleanup_rls_test_fixtures.sql` — dọn fixture test theo UUID cố định, idempotent, giữ nguyên user thật.
- ✅ Migration `0007_seed_admin_and_alerts.sql` — tạo profile + super_admin + gán shop + 9 alerts **không cần phiên đăng nhập**; idempotent (dùng `NOT EXISTS` vì `unique(user_id, role, department_id)` không chặn trùng khi `department_id` NULL).
- ✅ `rls_test.sql` — `commit;` → `rollback;`, thêm cờ `vexim.allow_rls_test`, temp table `on commit drop`, tự dọn fixture trước khi seed.
- ✅ `run-inventory-sync.ts` — chỉ ghi DB thật khi `mode === "production"`; bỏ fallback `DEMO_SHOP`; thêm field `db` vào kết quả.
- ✅ `api/cron/inventory-sync/route.ts` — thiếu `CRON_SECRET` trên production → 500 kèm hướng dẫn, không còn 401 im lặng.
- ✅ `supabase/tests/run-migrations.mjs` + `supabase/package.json` — bộ kiểm chứng 53 assertion trên PostgreSQL 18.3.
- ☐ Chờ VEXIM chạy `0006` rồi `0007` trong SQL Editor.
- ☐ Cần thêm **`CRON_SECRET`** trên Vercel (Production + Preview) rồi Redeploy.
- ✅ `SUPABASE_SERVICE_ROLE_KEY` đã có trên Vercel (API invite-user dùng được).

## Hạ tầng Module 4 · 6 · 7 (12/09 — theo thứ tự build 7 → 4 → 6)

Đã dựng **tầng dữ liệu + logic thật** cho 3 module ưu tiên (màn hình đã có từ PR #1/#2,
vẫn đang đọc mock — bước cắm UI vào dữ liệu thật làm ngay sau khi có report thật).

**Migration `0010_module_4_6_7_orders_finance_health.sql`** — bổ sung đúng những gì tầng
sync cần, không đổi/xoá cột cũ:
- `sales.orders` + merchant_order_id/last_updated_date/marketplace_id/ship_state/ship_country/`pii_stripped` + index queue FBM; `sales.order_items` + amazon_order_item_id/item_name/item_status; `sales.returns_refunds` + sku/asin/quantity/amazon_rma_id/reason_label/reason_group/resolution/**dedupe_key** (chống trùng khi import lại)
- bảng mới `sales.order_daily` (KPI ngày: đơn/đơn vị/tiền/FBM quá hạn/returns) và schema mới **`account_health`**: `snapshots` (ngày × marketplace: status, AHR, tone, điểm nội bộ, rates jsonb) + `issues` (vi phạm mở: severity, nhóm, defects_count, case_id, owner, resolved_at)
- `finance.settlements` + deposit_date/status/breakdown/reconcile_diff/reconciled_at; `finance.financial_events` + sku/amount_type/amount_description/order_id/quantity/marketplace_name/dedupe_key
- 3 rule cảnh báo: `fbm_late_ship` (red) · `return_reason_spike` (amber) · `reconciliation_mismatch` (red); RLS + grant; **4 view public** để web đọc không phụ thuộc "Exposed schemas": `vexim_shop_health`, `vexim_health_issues`, `vexim_order_daily`, `vexim_fbm_queue`
- DO-block tự kiểm tra cuối migration: đủ 3 bảng + 3 rule + 4 view, và **raise nếu phát hiện cột PII** trong sales/finance/account_health

**Code worker (đã có test):**
- `domain/orders.ts` (43 test) — chuẩn hoá trạng thái (không tự bịa "Delivered"), hạn ship FBM (dùng LatestShipDate thật; report thiếu thì đánh dấu `assumed`), KPI, hotspot trả hàng (≥3 đơn hoặc ≥5%), cửa sổ delta 15 phút lùi 5 phút chồng lấn, alert theo `rule_code`
- `reports/all-orders.parser.ts` + `reports/returns.parser.ts` — **bỏ `ship-city`/`ship-postal-code` ngay khi parse** (quyết định PII v1.1), gom đơn từ dòng item, dịch mã lý do trả hàng sang tiếng Việt + nhóm
- `jobs/orders-sync.job.ts` — `buildOrdersSnapshot` (thuần, test được) + `runOrdersSync` (ghi orders/items/returns/order_daily/alerts/sync_jobs); giới hạn đúng SP-API: getOrders 0.0167 rps/burst 20, getOrderItems 0.5/30, report all-orders ≤30 ngày, returns ≤60 ngày
- `notifications/orders.handler.ts` — ORDER_CHANGE: **bóc DestinationPostalCode** (PII) trước khi lưu log, upsert đơn, cảnh báo FBM theo hạn ship thật, nhận cả casing PascalCase/camelCase
- `reports/settlement.parser.ts` + `jobs/finance-sync.job.ts` (24 test) — parser bám bản **`GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2`** (bản `_FLAT_FILE`/`_XML` đã deprecated), parse số kiểu local (95,00 → 95), đối soát theo SOP-10: tổng các nhóm **trừ dòng Transfer** vs số tiền chuyển, lệch >1% → alert `reconciliation_mismatch`
- `domain/account-health.ts` + `reports/seller-performance.parser.ts` + `jobs/account-health-sync.job.ts` + `notifications/account-health.handler.ts` (46 test) — parser bám **`GET_V2_SELLER_PERFORMANCE_REPORT`** (bản JSON của Account Health dashboard: accountStatuses, 6 chỉ số, warningStates 10 nhóm vi phạm + AHR) — *tài liệu kế hoạch ghi V1; V1 là bản XML cũ, V2 mới có đủ AHR + vi phạm*; hạ tầng: ưu tiên ngưỡng Amazon, thiếu thì dùng ngưỡng VEXIM và **đánh dấu nguồn**, "thiếu dữ liệu" không bao giờ hiện xanh; ACCOUNT_STATUS_CHANGED về NORMAL → tự đóng alert đang mở
- `db/adapter.ts` + `db/supabase.ts` — 9 method ghi mới cho 3 module (upsertOrders có thay order_items, dedupe returns, snapshot/issue, settlement + **replace** financial_events của kỳ, resolveAlerts); schema `sales|finance|account_health` đã thêm vào gợi ý **Exposed schemas** khi gặp PGRST205/PGRST202
- CLI: `worker orders:sync --file=orders.tsv [--returns=returns.tsv]` · `worker finance:sync --file=settlement.tsv` · `worker account-health:sync --file=performance.json` — chỉ ghi DB thật khi `mode === "production"`; mặc định/`--dry-run` chạy trong bộ nhớ và in bản tóm tắt

**Kiểm chứng (chạy thật):**

```bash
cd worker && npm test     # 241 tests / 241 pass / 0 fail  (trước đó 116)
cd supabase && npm test   # TẤT CẢ PASS — BƯỚC 9 chạy 0010 + chạy lại lần 2 (idempotent)
cd web && npx tsc --noEmit && npx next build   # ✓ Compiled successfully
```

**Việc cần VEXIM làm:** chạy migration `0010` trong SQL Editor (sau `0006`/`0007`/`0008`/`0009`),
sau đó thêm schema **`sales`, `finance`, `account_health`** vào Supabase → Settings → API →
*Exposed schemas* để các view `vexim_*` đọc được bằng anon key (worker dùng service_role
nên không phụ thuộc bước này).

## Cách verify nhanh (DEMO MODE)

1. Mở preview (port 3000) → trang đăng nhập → chọn vai trò.
2. Dropdown viền cam (topbar) đổi vai trò → sidebar & phạm vi đổi theo.
3. Thử Operator PPC vào URL `/finance` trực tiếp → bị chặn.

## Chờ VEXIM

- ✅ Tạo project Supabase (`pitmyzovjwflkyoqjbkz`) + set 14 biến môi trường trên Vercel — **xong 12/09**
- ☐ **Chạy `0006` rồi `0007` trong SQL Editor** (dọn fixture test + tạo super_admin/alerts)
- ☐ Chạy `0008` → `0009` → **`0010`** (wrapper RPC · shop production · hạ tầng Module 4/6/7)
- ☐ **Thêm `CRON_SECRET` trên Vercel** (Production + Preview) → Redeploy
- ☐ `AMAZON_LWA_CLIENT_ID` / `_CLIENT_SECRET` / `_REFRESH_TOKEN` khi Developer Profile được duyệt — thiếu 3 biến này thì worker chỉ chạy demo trong bộ nhớ (an toàn, không ghi DB thật)
- ☐ 4 thông tin thật cho landing page (email/phone/địa chỉ/tên pháp lý)
- ☐ Chốt 2–3 shop pilot + file giá vốn theo template CSV
- ☐ Hải Anh: báo ngày nộp hồ sơ + tạo Sandbox Application ngay sau khi nộp

### Biến môi trường Vercel: cái nào code thật sự đọc

Code chỉ đọc **5 tên** này (`grep -rn "process.env" web/src`):

| Biến | Dùng ở | Trạng thái |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | supabase client/server, login, invite-user | ✅ đã set |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | supabase client/server, login | ✅ đã set |
| `SUPABASE_SERVICE_ROLE_KEY` | invite-user, worker | ✅ đã set |
| `CRON_SECRET` | cron inventory-sync | ❌ **THIẾU** |
| `AMAZON_LWA_CLIENT_ID/_SECRET/_REFRESH_TOKEN` | spapi client, worker | ⬜ chờ Amazon duyệt |

9 biến còn lại trên Vercel (`POSTGRES_*`, `SUPABASE_PUBLISHABLE_KEY`,
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_ANON_KEY`,
`SUPABASE_URL`, `SUPABASE_JWT_SECRET`) **code không đọc** — không gây hại, có thể để nguyên.
