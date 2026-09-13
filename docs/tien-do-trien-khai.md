# TIẾN ĐỘ TRIỂN KHAI — VEXIM OPS

> Cập nhật: 13/09/2026 · Thứ tự build đã chốt: **0 → 7 → 4 → 3 → 1(đọc) → 2 → 6(đọc)** (21 màn Đợt 1)

## Cập nhật 13/09 (đợt 2) — MODULE 5 PHẦN 2 & 3 (PPC chiều GHI): migration 0021 · hàng đợi đề xuất + guardrail + audit · cron ads-apply · /ppc có khối duyệt thay đổi

Phần 1 trả lời “campaign nào đang đốt tiền”. Phần 2 & 3 cho phép **sửa nó trên Amazon** — nên nguyên tắc
thiết kế là *không có đường nào ghi lên Amazon mà không đi qua một người ký và một lần đối chiếu*:

1. **`0021_module5_ppc_write.sql`** — 3 bảng mới (`ads.ppc_policies` guardrail, `ads.change_requests`
   hàng đợi có máy trạng thái, `ads.negative_keywords` bảng gương từ khoá phủ định), **4 view cho UI**
   (`vexim_ppc_policies`, `vexim_ppc_change_requests`, `vexim_ppc_suggestions`, `vexim_ads_negative_keywords`),
   **4 RPC cho người dùng** (`vexim_ppc_propose_changes`, `decide_change`, `decide_bulk`, `set_policy`) và
   **3 RPC cho worker** (`vexim_worker_ppc_pending_changes` giành lô + quét TTL + đòi lô kẹt,
   `vexim_worker_ppc_set_result`, `vexim_ppc_raise_alerts`). `before_value`/`after_value` **BẤT BIẾN** sau
   khi tạo (trigger chặn) — người duyệt duyệt đúng cái đã đề xuất, không ai sửa ngầm được. Mọi chuyển
   trạng thái ghi `iam.audit_logs`; 2 alert rule mới: `ppc_pending_approval` (chờ duyệt quá 24h) và
   `ppc_change_failed` (áp dụng thất bại).
2. **`web/src/lib/ads/write.ts`** — hợp đồng ghi **Sponsored Products v3** đóng băng thành bảng
   `ADS_WRITE_OPS` (5 operation: `PUT /sp/campaigns`, `PUT /sp/keywords`, `PUT /sp/adGroups`,
   `POST /sp/negativeKeywords`, `POST /sp/campaignNegativeKeywords`; media type
   `application/vnd.sp<Entity>.v3+json`; body bọc `{campaigns|keywords|adGroups|negativeKeywords|campaignNegativeKeywords: […]}`;
   `budget` là OBJECT lồng `{budget, budgetType}`; state viết HOA; `matchType` là
   `NEGATIVE_EXACT`/`NEGATIVE_PHRASE`; mỗi lô ≤ 100). Đọc phản hồi **207 Multi-Status** theo `index`,
   dòng nào Amazon không trả kết quả thì coi là FAILED chứ không đoán.
3. **Verify-before-write**: trước khi ghi, cron ĐỌC LẠI Amazon (`POST /sp/campaigns/list`,
   `/sp/keywords/list`, `/sp/negativeKeywords/list`, `/sp/campaignNegativeKeywords/list` — filter bị từ
   chối thì lùi về đọc không filter + phân trang, và nói rõ độ phủ). Amazon đang khác `before_value` →
   **SKIP** (ai đó đổi tay trong Ads console thì hệ thống không ghi đè); campaign `ARCHIVED` → skip;
   từ khoá đã bị phủ định rồi → skip.
4. **Cron `/api/cron/ads-apply`** (`vercel.json` lúc **04:20 UTC**, chạy SAU `ads-sync` 04:00 để verify
   bằng số liệu vừa nhập): lấy lô đã duyệt theo `daily_change_cap` của từng shop, đổi token theo shop,
   chốt `profileId` (từ hàng đợi hoặc `GET /v2/profiles`), gửi từng lô, ghi kết quả từng dòng, nổ/đóng
   alert. `?dryRun=1` đọc hàng đợi + đọc Amazon + in payload mà **không gửi, không giành lô**.
5. **UI `/ppc`** thêm khối “Thay đổi PPC”: gợi ý sinh từ số liệu (5 loại: phủ định search term đốt tiền,
   tắt keyword/campaign không ra đơn, hạ bid ACOS cao, tăng ngân sách campaign cạn mà ACOS đạt) → chọn
   dòng → tạo đề xuất; hàng đợi duyệt (duyệt/từ chối từng dòng hoặc cả lô, kèm ghi chú lưu vào audit);
   form guardrail (chỉ approver); form thêm từ khoá phủ định; kết quả áp dụng kèm **nguyên văn lỗi Amazon**.
   Quyền do DB tính (`can_propose`, `can_decide`, `can_edit_policy`) nên nút chỉ hiện với người được phép.

**Năm chốt an toàn (mỗi chốt đều có test):**

| Chốt | Hành vi |
|---|---|
| `ADS_WRITE_ENABLED` chưa bật | Cron trả `ok` + hint, **không gọi Amazon và không giành lô** — đề xuất đã duyệt vẫn nằm chờ |
| Chỉ áp dụng cái đã DUYỆT | Không có đường nào tự sinh thay đổi rồi gửi; `pendingChanges` chỉ lấy dòng `approved` |
| Đối chiếu trước khi ghi | Lệch `before_value` → `skipped` + lý do; không có token/profile → `failed` + alert (không treo im lặng) |
| 429/5xx/lỗi mạng | Giữ trạng thái `applying` để **reclaim** lượt sau (`ADS_WRITE_STALE_MINUTES`, mặc định 30) — không retry dồn |
| Audit | Kết quả ghi qua RPC → trigger ghi `iam.audit_logs`; negative keyword áp dụng thành công thì upsert `ads.negative_keywords` với **id Amazon thật** |

### Việc VEXIM cần làm để chiều ghi chạy thật

1. Chạy **`0021`** trong SQL Editor (sau `0020`). Migration tự soát hợp đồng ở cuối nên sai là fail ngay.
2. Supabase → Settings → API → Exposed schemas: đã có `ads` + `connections` từ đợt 0020 (không cần thêm).
3. Biến môi trường mới trên Vercel:

| Biến | Dùng làm gì | Bắt buộc |
|---|---|---|
| `ADS_WRITE_ENABLED` | `1`/`true`/`yes`/`on` → cron ads-apply MỚI được gọi Amazon. **Mặc định TẮT** | ✅ để ghi thật |
| `ADS_WRITE_BATCH_LIMIT` | Số đề xuất tối đa mỗi shop mỗi lượt (mặc định 100, trần 500) | ⬜ |
| `ADS_WRITE_STALE_MINUTES` | Phút một lô `applying` bị coi là kẹt và được đòi lại (mặc định 30) | ⬜ |

4. Cấp quyền duyệt: `iam.role_assignments` cho trưởng phòng PPC (`dept_lead` module `ppc`) hoặc
   `super_admin` — `iam.is_ppc_approver()` quyết định ai thấy nút Duyệt và ai sửa được guardrail.
5. Chạy thử theo thứ tự: `curl -H "Authorization: Bearer $CRON_SECRET" "$APP/api/cron/ads-apply?dryRun=1"`
   (xem payload sẽ gửi) → đặt `ADS_WRITE_ENABLED=1` + Redeploy → chạy tay
   `?shop=<uuid>&limit=1` cho MỘT shop, kiểm tra trong Ads console → mới để cron tự chạy.

### Verify nhanh (không cần Amazon)

- `cd supabase && npm test` → **675 PASS** (125 mục cho 0021: máy trạng thái, guardrail chặn ở đâu, RPC
  worker giành lô/đòi lô kẹt/trần ngày, RLS, audit, và **9 mục chốt hợp đồng cột web ↔ DB** cho 4 view mới).
- `cd web && npm test` → **411 PASS** (thêm 55 test luồng ghi + 37 test model UI), `npx tsc --noEmit` sạch,
  `npm run build` OK, không có secret nào lọt vào bundle client.

### Cố ý CHƯA mở (không đoán hợp đồng)

- `PUT /sp/targets` (đổi bid của target ASIN/category): không nguồn nào xác nhận tên khoá của body ghi
  (`{targets}` hay `{targetingClauses}`) → worker tự `skipped` kèm lý do thay vì gửi bậy.
- Sponsored Brands / Sponsored Display: endpoint + body khác; RPC đã tự skip đề xuất không thuộc SP, và
  `write.ts` có lớp chắn thứ hai (`isSponsoredProducts`).
- Đổi `defaultBid` của ad group, đổi bid của placement, và **bảng quyết định tuần (A4)**.

## Cập nhật 13/09 — MODULE 0 (OAuth & multi-tenant) + MODULE 5 PHẦN 1 (PPC đọc/phân tích): migration 0020 · luồng authorize thật · cron ads-sync · /ppc số liệu thật · F4 có ads_spend + TACOS

Hai module đi cùng nhau vì **refresh token là nền của cả SP-API lẫn Ads API**: không có luồng authorize
thật thì mọi con số PPC đều phải dán tay. Bốn đợt commit:

1. **`0020_module0_oauth_module5_ppc_read.sql`** — bảng `connections.oauth_tokens` (token mã hoá
   AES-256-GCM, **không có policy SELECT cho client**), `oauth_states`, `oauth_events`; 4 bảng ads mới
   (`targeting_metrics_daily`, `advertised_product_daily`, `budget_usage`, `report_requests`);
   **16 RPC public** cho worker (`vexim_oauth_*`, `vexim_worker_upsert_ads_*`, `set_ads_report_request`,
   `pending_ads_reports`, `vexim_ads_raise_alerts`, `vexim_worker_fill_profit_ads_spend`);
   **8 view đọc** `vexim_ads_*` (security_invoker + RLS theo shop) và 2 view Module 0
   (`vexim_connections`, `vexim_oauth_events`).
2. **OAuth web** (`web/src/lib/oauth` + 3 route + cron `oauth-reauth`): state ký HMAC TTL 10 phút,
   link `/start` ký sẵn để GỬI CHỦ SHOP tự authorize, callback nhận cả `spapi_oauth_code` lẫn `code`,
   đếm ngược hạn **365 ngày** + nhắc trước 30 ngày, ô nạp refresh token có sẵn.
3. **Ads worker** (`web/src/lib/ads` 9 module + cron `/api/cron/ads-sync` 04:00 UTC): LWA đổi access
   token theo shop, tự lấy `profileId` qua `GET /v2/profiles`, Reporting v3 async cho 4 loại report,
   **PHA POLL trước PHA REQUEST** (không ngồi chờ Amazon trong serverless 60s), tự bớt cột khi Amazon
   chê, 425 = trùng (không phải lỗi), 429 = không retry dồn.
4. **UI đọc số liệu thật** (`web/src/lib/data/ads-model.ts` + `ads.ts`, `/ppc` mới, Dashboard, F4):
   KPI spend/ACOS/**TACOS**/CPC theo **shop × tiền tệ** (không cộng khác tiền tệ, tỷ lệ tổng = tổng/tổng),
   campaign vượt ngưỡng ACOS, ngân sách cạn, search term đốt tiền (loại placement `*`), biểu đồ spend
   theo ngày, tiến trình report + profile đã đồng bộ; Dashboard CEO có card Ads/TACOS + card phòng ban
   PPC; **F4 thêm cột Ads + TACOS** (ads_spend là cột riêng, KHÔNG trừ vào lãi gộp).

**Ba quy ước dữ liệu giữ chặt ở cả DB lẫn UI:** chưa biết ≠ 0 (`NULL` → hiện “—”); không cộng tiền khác
tiền tệ; số ƯỚC LƯỢNG phải gắn nhãn (giờ cạn ngân sách, % ngân sách khi SP không có Budget Usage API,
TACOS tính trên một phần shop).

### Việc VEXIM cần làm để Module 5 chạy thật

1. Chạy **`0020`** trong SQL Editor (sau `0019`). Migration có DO-block tự soát nên sai là fail ngay.
2. Supabase → Settings → API → **Exposed schemas**: thêm **`connections`** (worker dùng
   `Accept-Profile: connections` để đọc `oauth_tokens`/`seller_accounts` bằng service role).
   Web chỉ đọc view trong `public` nên không cần expose `ads`.
3. Biến môi trường trên Vercel (Production + Preview) → Redeploy:

| Biến | Dùng làm gì | Bắt buộc |
|---|---|---|
| `AMAZON_ADS_CLIENT_ID` / `AMAZON_ADS_CLIENT_SECRET` | LWA + header `Amazon-Ads-ClientId` | ✅ để gọi Ads API |
| `AMAZON_ADS_REFRESH_TOKEN` | Fallback khi shop chưa có token trong DB (kèm cảnh báo “không gắn shop”) | ⬜ nên có để chạy thử |
| `AMAZON_ADS_REGION` | `NA` / `EU` / `FE` → chọn host `advertising-api[-eu|-fe].amazon.com` | ⬜ mặc định NA |
| `OAUTH_TOKEN_ENC_KEY` | Khoá AES-256-GCM (32 byte hex) mã hoá refresh token | ✅ để lưu/đọc token |
| `OAUTH_STATE_SECRET` | Ký state chống CSRF + ký link `/start` gửi chủ shop | ✅ cho luồng OAuth |
| `APP_BASE_URL` (hoặc `OAUTH_REDIRECT_URI`) | Redirect URI phải KHỚP ĐÚNG cái đã khai trong Developer Console | ✅ cho luồng OAuth |
| `AMAZON_SP_API_APPLICATION_ID` | SP-API dùng trang consent Seller Central (callback trả `spapi_oauth_code`) | ⬜ cho Module 3/4 |
| `AMAZON_ADS_ATTRIBUTION_DAYS` | `7` (seller) hay `14` (vendor/author) — sai là ACOS lệch hẳn | ⬜ mặc định 7 |
| `AMAZON_ADS_PROFILE_TYPE` | `seller` (mặc định) — vendor bị loại khi chọn profile | ⬜ |
| `AMAZON_ADS_ACCOUNT_ID` | Header `Amazon-Ads-AccountId` (chỉ gửi khi đặt) | ⬜ |
| `CRON_SECRET` | Bảo vệ 5 cron: inventory-sync, report-pull, oauth-reauth, **ads-sync**, **ads-apply** | ✅ |
| `ADS_WRITE_ENABLED` | Chiều GHI PPC (đợt 2): `1` thì cron `ads-apply` mới gọi Amazon — **mặc định TẮT** | ⬜ bật khi sẵn sàng |
| `ADS_WRITE_BATCH_LIMIT` / `ADS_WRITE_STALE_MINUTES` | Trần đề xuất mỗi lượt (100) / phút coi một lô là kẹt (30) | ⬜ |

4. **Authorize Ads cho từng shop**: `/module0/connect` → nút Authorize (hoặc gửi link `/start` cho chủ
   shop) → nếu đã có refresh token thì dùng ô Import. Shop có NHIỀU tài khoản Ads thì điền luôn ô
   **“Profile ID Ads”** (lưu vào `oauth_tokens.ads_account_id`) — hệ thống KHÔNG tự đoán profileId.
5. Chạy cron: `curl -H "Authorization: Bearer $CRON_SECRET" "$APP/api/cron/ads-sync"` (hoặc
   `?dryRun=1&shop=<uuid>` để thử mà không ghi DB). Lần đầu chỉ XIN report; chạy
   `?phase=poll` sau vài phút để nhập số.

### Verify nhanh (không cần Amazon)

- `cd supabase && npm test` → **550 PASS** (đợt 1; đợt 2 nâng lên 675), gồm **15 mục chốt hợp đồng cột web ↔ DB**: mọi cột trong
  `ADS_*_SELECT` và mọi cột web dùng để sắp xếp/lọc phải tồn tại trong view (sai một tên cột là
  PostgREST trả 400 lúc chạy thật, nên bắt ngay trong test).
- `cd web && npm test` → **319 PASS** (đợt 1; đợt 2 nâng lên 411 — thêm 76 test Ads API + 37 test model UI/F4/Dashboard),
  `npx tsc --noEmit` sạch, `npm run build` OK.
- Trên app: `/module0/connect` (kết nối + đếm ngược 365 ngày) → `/ppc` (KPI, campaign, search term,
  tiến trình report) → `/finance/profit` (cột Ads + TACOS) → `/dashboard` (card Ads + card PPC).
  Chưa đồng bộ thì các trang hiện “—” kèm LÝ DO và việc cần làm, không hiện 0.

### Còn thiếu (đã chốt làm sau)

- **Module 5 Phần 2 & 3**: ✅ đã làm ở đợt 2 ngay bên trên (migration 0021 + cron `ads-apply` + khối
  duyệt thay đổi trên `/ppc`). Còn lại: bid của **target** (ASIN/category), SB/SD, và bảng quyết định
  tuần (A4).
- TACOS cần **Module 4** đồng bộ `sales.order_daily` (tổng doanh thu mọi kênh): thiếu thì `tacos_unknown`
  và UI hiện “—” + nói rõ bao nhiêu shop đang thiếu.
- SB/SD reports (v3 đang preview) và intraday metrics theo giờ.

## Cập nhật 12/09 — MODULE 3 NÂNG CAO (phần 2): PHÍ theo FC + phí inbound noncompliance + cron tự kéo Reports API (migration 0019)

Phần 1 (0018) trả lời "hàng nằm ở đâu, nhận đủ chưa" nhưng vẫn phải **tải file TSV bằng tay** và
vẫn **chưa thấy TIỀN**. Phần 2 đóng cả hai khoảng trống:

1. **Phí lưu kho theo FC** — `GET_FBA_STORAGE_FEE_CHARGES_DATA`: Amazon thu bao nhiêu cho hàng nằm ở
   từng FC, theo từng tháng (`storage_rate`, `estimated_monthly_storage_fee`, tồn bình quân, thể tích,
   size tier, phí khuyến khích, hàng nguy hiểm).
2. **Phí/vấn đề inbound noncompliance** — `GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA`: lô nào bị
   Amazon bắt lỗi (thiếu nhãn, sai thùng, gửi dư/thiếu…), lỗi gì, bao nhiêu đơn vị, **phạt bao nhiêu
   tiền**, mức coaching, trạng thái cảnh báo.
3. **Tự động hoá Reports API** — không ai phải vào Seller Central tải file nữa: `createReport` →
   `getReport` (poll) → `getReportDocument` (tải, tự giải nén GZIP) cho **cả 4 report** (2 report của
   0018 + 2 report phí của 0019), chạy bằng **Vercel Cron** mỗi ngày 03:00 UTC.

- **Migration `0019_fc_fees_report_requests.sql`** (idempotent + DO-block tự soát **8 mục**: RLS 3 bảng ·
  index unique · KHÔNG có policy ghi · 3 RPC `security definer` chỉ service_role · 5 view
  `security_invoker` · hợp đồng cột từng view · helper đọc số · regression 0018):
  - Bảng **`finance.storage_fees`** ← report phí lưu kho. Khoá unique (shop × `month_of_charge` × ASIN ×
    FNSKU × FC × `dangerous_goods_storage_type`). `month_of_charge` được parser chuẩn hoá về `YYYY-MM`
    (report có thể ghi `September 2026`).
  - Bảng **`inventory.inbound_noncompliance`** ← report lỗi nhập kho. Khoá unique (shop ×
    `issue_reported_date` × lô × carton × SKU × `problem_type`).
  - Bảng **`connections.report_requests`** — **sổ tay trạng thái từng lần yêu cầu report**: reportId,
    documentId, `status` (requested/in_queue/in_progress/done/imported/no_data/failed/fatal/cancelled),
    `rows_imported`, `attempts`, `last_error`, kỳ dữ liệu. Nhờ bảng này cron **nối tiếp được**: lần sau
    poll đúng reportId đang chờ thay vì xin report mới (Amazon chỉ cho xin report daily **1 lần/4 giờ**
    cho mỗi loại).
  - 3 RPC **`vexim_worker_upsert_storage_fees`** / **`vexim_worker_upsert_noncompliance`** /
    **`vexim_worker_set_report_request`** (`security definer`, revoke khỏi `authenticated`, nhận JSON
    **camelCase** như quy ước 0015): set-based, trả `inserted · updated · skipped` (+ `groups` và danh
    sách `currencies` với RPC phí). Nhập lại cùng file → `updated`, **không phình bảng**.
  - 5 view `security_invoker`: **`vexim_storage_fees`** (phí theo SKU/FNSKU/ASIN × FC × tháng, kèm
    **`sku` SUY RA + nhãn `sku_source`** = `fnsku` / `asin` / `none` — report phí **không có SKU người
    bán**, hệ thống nối qua `inventory.fc_allocation` (0018) rồi `catalog.listings`, không âm thầm đoán),
    **`vexim_storage_fee_by_fc`** (shop × tháng × FC × **currency**: `storage_fee`, `fee_share_pct`,
    `avg_units_on_hand`, `total_volume`, `month_fee_total`), **`vexim_inbound_issues`** (từng dòng lỗi +
    `days_ago`), **`vexim_inbound_issue_shipments`** (gộp theo lô: `issue_count`, `fee_total`,
    `problem_units`, `problem_types`, `coaching_levels`, `alert_statuses`), **`vexim_report_requests`**
    (+ `age_minutes`, `is_stale` — màn Sync health đọc).
  - Helper **`finance.num_or_null`** / **`finance.bool_or_null`**: giá trị report lạ (`N/A`, `1,234.56`,
    `abc`, rỗng) → **NULL** chứ không làm nổ cả lô nhập.
  - RLS: 3 bảng mới **chỉ có policy SELECT** theo `iam.can_read_seller_account` (self-check đếm và
    **fail nếu có bất kỳ policy ghi nào**); mọi đường ghi đi qua RPC service_role.
- **Engine (đặt trong `web/src/lib/worker/` vì Vercel Cron phải tự chứa trong `web/`; `worker/src/*`
  là shim re-export)**:
  - `amazon/reports.ts` — **ReportsClient**: `createReport` → poll `getReport` → `getReportDocument`
    (tải nội dung, tự giải nén **GZIP** qua `node:zlib`), nhận diện throttle (`SpApiRequestError
    .isThrottled`) để cron không đốt quota.
  - `reports/registry.ts` — khai báo 4 report: `fc` (2 ngày) · `receipts` (30 ngày) · `storage-fees`
    (**95 ngày** — Amazon giữ ~3 kỳ phí) · `noncompliance` (60 ngày); **mọi loại `cooldownHours = 4`**
    đúng trần của Amazon.
  - `reports/fba-fees.parser.ts` — đọc cột **THEO TÊN** (Amazon đổi thứ tự cột vẫn chạy), gom
    `byMonthFcCurrency` (khoá `tháng|FC|tiền tệ`) và `feeByType` (khoá `loại phí|tiền tệ`), tiền làm tròn
    2 số để `0.30 + 0.55` không thành `0.8500000000000001`; dòng rác đếm `skipped` kèm số dòng, trần 20
    cảnh báo.
  - `jobs/report-pull.job.ts` + `run-report-pull.ts` — luật: tôn trọng cooldown **theo từng loại
    report**; trạng thái còn làm được (requested/in_queue/in_progress/done) thì **POLL tiếp, không tạo
    report mới**; report DONE nhưng rỗng → `no_data` (không phải lỗi); kỳ dữ liệu tính theo **UTC**;
    `--dry-run` **không ghi gì**; `rowsImported = inserted + updated`.
  - CLI **`npm run worker:reports-pull -- [--type=all|fc|receipts|storage-fees|noncompliance] [--days=N]
    [--seller=<uuid>] [--poll=N] [--dry-run]`** — có credential Amazon thì gọi API thật; hoặc nạp file đã
    tải tay: `--fc=<tsv> --receipts=<tsv> --storage-fees=<tsv> --noncompliance=<tsv>` (bỏ qua Amazon).
- **Cron**: route **`/api/cron/report-pull`** (GET/POST, `?kinds=` · `?days=` · `?dryRun=`), bảo vệ bằng
  `Authorization: Bearer <CRON_SECRET>` — **dùng lại biến đã có** của `/api/cron/inventory-sync`, nên
  **vẫn không cần thêm biến môi trường nào** (chỉ `AMAZON_LWA_*` + Supabase). Thiếu `CRON_SECRET` trên
  production → trả **500 kèm hướng dẫn** thay vì 401 mơ hồ. `maxDuration = 60` và **chỉ poll 2 lần cách
  nhau 5 giây**: report chưa xong thì ghi trạng thái vào `report_requests` để lần sau poll tiếp — cron
  KHÔNG ngồi chờ. `web/vercel.json` nay có 2 cron (02:00 inventory-sync · **03:00 report-pull** UTC).
- **Web UI (4 chỗ mới, đều đọc TÁCH BIỆT để trang không sập khi DB chưa chạy 0019):**
  - **Tổng quan kho vận**: panel **"Phí lưu kho theo FC"** — kỳ mới nhất, mỗi **tiền tệ một khối riêng**
    (tổng kỳ · % từng FC · số dòng sản phẩm · tồn bình quân · thể tích), không cộng chéo tiền tệ.
  - **I2 Chi tiết tồn SKU**: panel **"Phí lưu kho theo FC"** của riêng SKU đó — bảng kỳ mới nhất theo FC
    + bảng **chênh lệch kỳ phí** (so kỳ trước, chỉ so khi cùng tiền tệ), khớp phí theo **SKU HOẶC FNSKU
    HOẶC ASIN** vì report phí không có SKU người bán; cảnh báo khi có dòng phí chưa ánh xạ được SKU.
  - **I4 Inbound shipments**: cột mới **"Phí / vấn đề inbound"** trên bảng lô (`N vấn đề · $X`, `—` khi
    chưa biết) + header đếm tổng vấn đề/tổng phí + 3 panel: **lô nặng nhất** (sắp theo mức độ/phí),
    **từng vấn đề** (loại lỗi · đơn vị · coaching · phí, ghi rõ `expected/received` là **theo DÒNG** chứ
    không phải cả lô), **lô mồ côi** (report có lỗi nhưng lô không còn trong danh sách Inbound API).
  - **Module 0 → Sức khỏe đồng bộ**: panel **"Report đã kéo qua Reports API"** — từng loại report × shop ×
    kỳ dữ liệu × trạng thái × số dòng đã nhập × số lần chạm × tuổi (nhãn **CHỜ QUÁ LÂU** khi > 6 giờ) ×
    lỗi gần nhất, kèm giải thích trần 4 giờ và vì sao "Lần chạm" tăng là bình thường. Ba trạng thái
    hiển thị riêng: **chưa nối Supabase** (chế độ demo) / **chưa đọc được view** (thiếu 0019 hoặc quyền) /
    **chưa có lần yêu cầu nào**.
- **Số trung thực (không bịa):** phí **NULL ≠ 0** — dòng không đọc được tiền thì để "chưa biết", không
  đếm vào tổng; **không cộng tiền khác tiền tệ** ở bất kỳ tầng nào (parser · RPC · view · UI);
  `fee_share_pct` chỉ tính trong cùng một tiền tệ của cùng kỳ; `expected/received` của report lỗi là
  **theo dòng vấn đề**, KHÔNG được cộng ra "cả lô" (đối soát lô vẫn dùng 0018); lô có vấn đề nhưng
  không đọc được phí → hiện `—`, không hiện `$0`.
- **Kiểm chứng local (chạy thật):** `supabase npm test` **TẤT CẢ PASS (428 mục)** — BƯỚC 20 chạy trên
  Postgres thật (PGlite): nhập phí lưu kho 2 lần vẫn 5 dòng (không phình), dòng `month_of_charge =
  "September 2026"` được chuẩn hoá, dòng thiếu ASIN+FNSKU và dòng `fee = "abc"` bị `skipped`,
  USD/CAD **không bị cộng chung**, `authenticated` bị chặn ghi thẳng và bị chặn gọi cả 3 RPC, người lạ
  không thấy gì, 0019 chạy 2 lần không lỗi · `worker npm test` **391/391** (+70 test parser/registry/
  job/runner: cooldown, poll-không-tạo-mới, DONE rỗng → no_data, dry-run không ghi, GZIP, throttle) ·
  `web npm test` **152/152** (+24 test `fees-model`: hợp đồng SELECT 5 view, ép số dạng chuỗi, không cộng
  chéo tiền tệ, khớp SKU/FNSKU/ASIN, gộp vấn đề vào lô, nhãn trạng thái report + `is_stale`) ·
  `npx tsc --noEmit` sạch · `npm run build` sạch.

### Chờ VEXIM (Module 3 nâng cao phần 2)

- ☐ Chạy `supabase/migrations/0019_fc_fees_report_requests.sql` trong SQL Editor (sau `0018`).
- ☐ Kiểm tra role **Amazon Fulfillment** đã được Amazon cấp (đã nộp trong Developer Profile) — thiếu
  role thì `createReport` cho 2 report phí sẽ bị chặn.
- ☐ Chạy tay lần đầu để xem số mà **không ghi DB**: `npm run worker:reports-pull -- --type=all
  --dry-run`. Ưng ý thì bỏ `--dry-run` (worker chỉ ghi DB thật khi shop có `data_source = 'production'`).
- ☐ Trên Vercel: redeploy để `vercel.json` nhận cron thứ hai (`/api/cron/report-pull`, 03:00 UTC) —
  `CRON_SECRET` dùng lại cái đã có; gói Hobby giới hạn **2 cron/ngày chạy theo lịch**, đủ cho 2 job này.
- ☐ Sau 1–2 ngày, vào **Module 0 → Sức khỏe đồng bộ** xem panel "Report đã kéo qua Reports API": trạng
  thái `imported` là xong; `in_queue`/`in_progress` là Amazon đang tạo (cron poll tiếp); **CHỜ QUÁ LÂU**
  (> 6 giờ) thì chạy `npm run worker:reports-pull -- --type=storage-fees` để poll tay.

## Cập nhật 12/09 — MODULE 3 NÂNG CAO: phân bổ tồn theo FC + lịch sử nhận hàng (migration 0018)

I2 có hai khối treo nhãn "chưa có dữ liệu" từ Đợt 1, và lý do không phải "chưa làm" mà là **API không
có số này**: `listInventorySummaries`/`getFulfillmentInventory` chỉ trả TỔNG theo SKU (không tách
theo FC), còn Inbound API chỉ mô tả lô ĐANG mở (lô CLOSED thì không còn số nhận chi tiết). Nguồn thật
là 2 report FBA — nay đã nối xong report → DB → màn hình:

- **Migration `0018_fc_allocation_receipts.sql`** (idempotent + self-check 11 mục: bảng · RLS · quyền
  RPC · `security_invoker` · hợp đồng cột view · regression 0017):
  - Bảng **`inventory.fc_allocation`** ← report `GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA`
    (cột: `snapshot-date · fnsku · sku · product-name · quantity · fulfillment-center-id ·
    detailed-disposition · country`). Khoá unique (shop × ngày snapshot × SKU × FC × disposition).
  - Bảng **`inventory.receipts`** ← report `GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA`
    (cột: `received-date · fnsku · sku · product-name · quantity · fba-shipment-id ·
    fulfillment-center-id`). Khoá unique (shop × ngày nhận × SKU × lô × FC).
  - 2 RPC **`vexim_worker_upsert_fc_allocation`** / **`vexim_worker_upsert_receipts`** (`security
    definer`, revoke khỏi `authenticated`): set-based (1 câu INSERT…SELECT cho cả lô), trả
    `inserted · updated · skipped · merged · units · snapshots|shipments`. Dòng trùng khoá trong cùng
    file → **CỘNG dồn** (nếu ghi 2 lần Postgres báo "cannot affect row a second time"); dòng thiếu
    khoá/số không đọc được → `skipped`; nhập lại cùng file → `updated`, **không phình bảng**.
  - 4 view `security_invoker`: **`vexim_inventory_fc`** (SKU × FC của snapshot MỚI NHẤT +
    `sellable_qty`/`unsellable_qty`/`unknown_qty` + `sku_total_qty` + `sku_fc_count` +
    `fc_share_pct`), **`vexim_inventory_fc_rows`** (drill-down theo disposition),
    **`vexim_inventory_receipts`** (từng lần nhận + `days_ago`),
    **`vexim_inbound_receipt_shipments`** (đối soát theo lô: thực nhận vs số gửi + `diff_units` +
    `receipt_rate_pct` + `reconcile_state` + `expected_source`).
  - RLS: 2 bảng mới **chỉ có policy SELECT** theo `iam.can_read_seller_account` — không có policy ghi,
    web không ghi được; mọi đường ghi đi qua RPC service_role (như `catalog.listings` của 0016).
- **Worker**: parser `worker/src/reports/fba-inventory.parser.ts` (đọc cột **THEO TÊN** nên Amazon đổi
  thứ tự cột vẫn chạy; ngày về `YYYY-MM-DD`; dòng rác bỏ kèm số dòng; trần 20 cảnh báo để file lỗi
  không làm ngập log), job `inventory-fc-sync.job.ts`, runner `run-inventory-fc-sync.ts`, lệnh mới
  **`worker inventory:fc --fc=<file> [--receipts=<file>] [--seller=<uuid>] [--top-fc=10] [--dry-run]`**
  (script `npm run worker:inventory-fc`). **Không cần thêm biến env nào**; chỉ ghi DB thật khi
  `mode = production` và không `--dry-run`.
- **Web**: I2 (live) thay 2 panel "chưa có dữ liệu" bằng bảng **Phân bổ theo FC** (FC · Tổng · % của
  SKU · bán được · không bán được · không rõ) và **Lịch sử nhận hàng** (ngày · lô · FC · thực nhận);
  mỗi panel đọc tách biệt nên nếu DB chưa chạy 0018 thì panel tự giải thích, **không sập cả trang**.
  I4 (live) hết placeholder ở cột **FC đích** và **Đối soát nhận**: ghép
  `vexim_inbound_receipt_shipments` theo mã lô → "Nhận đủ 50/50" · "Thiếu 7 (nhận 18/25) → SOP-09" ·
  "Thừa 10 (nhận 30/20)" · "Chưa rõ số gửi (đã nhận 12)", kèm panel "lô có số nhận nhưng không còn
  trong danh sách" (lô CLOSED trước khi worker kịp sync).
- **Số trung thực**: `fc_share_pct` **NULL** khi tổng tồn của SKU = 0 (không hiện 0%); disposition rỗng
  đếm riêng `unknown_qty`, KHÔNG gộp vào "bán được"; report receipts **không có cột số gửi** →
  `expected_units` NULL + `expected_source = 'none'` chứ không suy "gửi = nhận"; ngày kiểu
  `09/11/2026` hiểu theo MM/DD/YYYY nhưng **có cảnh báo** trong log.
- **Kiểm chứng local (chạy thật):** `supabase npm test` **TẤT CẢ PASS** — BƯỚC 19 chạy trên Postgres
  thật (PGlite): nhập 10 dòng FC → ghi 6 · bỏ 3 dòng rác · gộp 1 cặp trùng khoá · 145 đơn vị ·
  2 snapshot; nhập lại → 6 update/0 insert; view chỉ phơi snapshot mới nhất; ONT8 50/85 = 58,8% +
  PHX7 41,2% = tròn 100%; SKU tổng 0 → % NULL; đối soát 5 lô (matched · short −7 · over +10 ·
  unknown_expected vì không có dòng lô · unknown_expected vì `quantity` NULL); `authenticated` bị chặn
  ghi thẳng + bị chặn gọi cả 2 RPC; người lạ không thấy gì; 0018 chạy 2 lần không lỗi ·
  `worker npm test` **321/321** (+28 test parser/job/runner) · `web npm test` **128/128** (+15 test
  model) · `npx tsc --noEmit` sạch.

### Chờ VEXIM (Module 3 nâng cao)

- ☐ Chạy `supabase/migrations/0018_fc_allocation_receipts.sql` trong SQL Editor (sau `0017`).
- ☐ Tải 2 report rồi nhập: Seller Central → **Reports → Fulfillment → Inventory** →
  *FBA Daily Inventory History* (phân bổ FC) và *FBA Received Inventory* (lịch sử nhận), định dạng TSV →
  `npm run worker:inventory-fc -- --fc=<daily-inventory.tsv> --receipts=<received-inventory.tsv>`
  (thêm `--seller=<uuid>` nếu có >1 shop; chạy `--dry-run` trước để xem số mà không ghi DB).
- ☑ ~~Đợt 2 sẽ tự đặt lịch qua Reports API~~ → **đã làm ngay trong phần 2 (0019, xem mục trên)**: cron
  `/api/cron/report-pull` tự `createReport` → poll `getReport` → `getReportDocument`, tôn trọng trần
  **mỗi 4 giờ cho mỗi loại report**; vẫn **không cần thêm biến env** (dùng lại `AMAZON_LWA_*` +
  `CRON_SECRET` + role **Amazon Fulfillment** đã nộp trong Developer Profile). Nhập tay bằng file TSV
  vẫn chạy được như cũ (`--fc=` / `--receipts=` / `--storage-fees=` / `--noncompliance=`).

## Cập nhật 12/09 — ĐỢT B: "hái quả ngay" (migration 0017 · doanh số 30 ngày · người phụ trách · giá trị tồn kho)

Đợt A mở khoá giá vốn + ghi listing thật. Đợt B lấy nốt **ba thứ dữ liệu ĐÃ CÓ SẴN trong DB nhưng
UI vẫn để số 0 / dấu "—"**, không phải chờ thêm API nào của Amazon:

- **Migration `0017_sales30d_owner_inventory_value.sql`** (idempotent + self-check 11 mục: cột nối
  CUỐI view / quyền / PII / công thức / khớp bảng gốc / idempotent):
  - **`public.vexim_sku_sales_30d`** (mới, `security_invoker`): MỘT định nghĩa doanh số 30 ngày theo
    (shop × SKU) từ `sales.orders ⋈ sales.order_items` — `units_30d`, `orders_30d`, `revenue_30d`
    (Σ `item_price × quantity`), `currency` + cờ `currency_mixed`, `last_order_at`. **Loại đơn huỷ**
    (cả hai cách viết `Cancelled`/`Canceled` của report lẫn API) và `Unfulfillable`; đơn `Pending`
    VẪN TÍNH vì P1 cần "cầu thật" để ước thiệt hại khi mất Buy Box. SKU không có đơn → **không có
    dòng** (view để NULL, không suy ra 0). *Khác `inventory.units_sold_per_day()` (0005): hàm đó chỉ
    đếm Shipped/Delivered 14 ngày để tính velocity NHẬP HÀNG — hai con số cho hai quyết định khác nhau.*
  - **`iam.module_owner(p_seller, p_module)`**: tên nhân viên VEXIM phụ trách shop ở module đó
    (ưu tiên `can_write`, rồi người gán sớm nhất). Bắt buộc là **`security definer`** vì RLS của
    `iam.assignments`/`iam.user_profiles` chỉ cho đọc CHÍNH MÌNH — join thẳng trong view
    `security_invoker` sẽ ra NULL với mọi user thường và cột "Phụ trách" chết. Chỉ trả **tên hiển thị**
    (không email, không uuid → không phải PII), bỏ qua user của khách hàng (`vexim_employee = false`),
    trả NULL nếu người gọi không đọc được shop, và **revoke khỏi `public`/`anon`**.
  - **`vexim_pricing` (P1) · `vexim_listings` (L1/L2) · `vexim_listing_queue` (L4)** nối THÊM 7 cột ở
    CUỐI: `units_30d, orders_30d, revenue_30d, revenue_currency, velocity_30d, last_order_at, owner`
    (P1 lấy owner module `pricing`, L1/L4 lấy module `listings`; `velocity_30d = units_30d / 30`).
    Nối cuối để web đang select theo tên không vỡ (bài học PGRST204).
  - **`vexim_inventory_latest` (Module 3)** nối THÊM 8 cột ở CUỐI: `unit_cost, cost_currency,
    cost_effective_from, cost_source, stock_value, total_stock_value, value_currency, value_basis`.
    `stock_value = fulfillable × giá vốn`, `total_stock_value = (fulfillable + reserved + inbound) ×
    giá vốn` — tra giá vốn NGOÀI khối `distinct on` để mỗi (shop × SKU) chỉ tra một lần. Tính theo
    **TIỀN CỦA GIÁ VỐN** (VEXIM nhập VND, bán USD → không tự quy đổi); thiếu giá vốn →
    `value_basis = 'missing'` + các cột giá trị NULL.
  - **Sửa lỗ hổng còn lại của 0016:** `catalog.effective_cost_row()` nay so SKU
    **không phân biệt hoa/thường** (`cost_inputs.sku` luôn VIẾT HOA vì `apply_cost_input` chuẩn hoá,
    còn `listings.sku`/`inventory_snapshots.sku` giữ nguyên xi như report) — hết cảnh "đã nhập giá vốn
    mà P1/Module 3 vẫn báo thiếu" chỉ vì một chữ thường. Sửa ở MỘT chỗ nên `effective_cost()`,
    `vexim_pricing`, `vexim_cost_coverage` và view tồn kho cùng hưởng.
  - Index `idx_order_items_order` (aggregate 30 ngày đi qua join `order_id`, trước đó bảng chỉ có PK).
- **Web — số thật thay cho 0/"—" (demo và live dùng chung một model):**
  - **P1**: cột mới **"Bán 30 ngày"** (đơn vị · số đơn · velocity/ngày · doanh thu 30 ngày), owner hiện
    "— chưa gán" khi DB chưa gán ai; sort "Velocity cao" và điểm rủi ro **null-safe** (SKU chưa có đơn
    xếp CUỐI, không chen lên đầu như thể bán kém nhất). `velocity30d` đổi sang `number | null`.
  - **L1**: cột mới **"Doanh thu 30 ngày"** + **"Phụ trách"** → nút sort "Doanh thu 30 ngày" hết xếp
    theo toàn số 0; `revenue30d` thành `number | null`.
  - **L4**: thêm cột **"Tiền đang mất"** (doanh thu/ngày + tổng 30 ngày) và **xếp hàng đợi theo tiền**:
    cùng mức ưu tiên thì listing đang mất nhiều tiền hơn lên trước (`sortQueueByRisk` dùng chung cho
    cả overview); owner + SLA hết là "—".
  - **Module 3**: I1 thêm KPI **"Giá trị tồn kho"** · **"SKU chưa có giá vốn"** và 2 cột
    *Giá vốn* / *Giá trị tồn* (kèm phần chỉ tính khả dụng); I2 thêm panel **"Giá trị tồn kho"** diễn giải
    từng bước (giá vốn hiệu lực · khả dụng × vốn · cộng reserved + đang về); I3 hết cảnh
    `unitCost: "—", value: "—"` — giá trị lô = đề xuất nhập × giá vốn, thiếu giá vốn thì ghi thẳng
    "— chưa có giá vốn" + nhãn "Nháp — thiếu giá vốn" (vàng) và KPI đếm số lô chưa định giá được.
    Cộng tiền **theo từng tiền tệ** (`summarizeInventoryValue`) — không bao giờ cộng VND với USD.
- **Kiểm chứng local (chạy thật, không suy luận):** `supabase npm test` **TẤT CẢ PASS** (BƯỚC 1..18;
  BƯỚC 18 dựng 5 user + 4 listing + 6 đơn (2 huỷ · 1 quá 30 ngày · 1 SKU viết thường) + 3 tồn kho +
  2 giá vốn rồi soát: `velocity_30d = 6/30 = 0.20`, doanh thu 300.00, đơn huỷ/đơn 40 ngày bị loại,
  SKU không có đơn → NULL chứ không phải 0, owner đúng theo module + ưu tiên `can_write`, user lạ
  KHÔNG dò được tên, `anon` bị chặn gọi hàm, `100 × 10 = 1.000` và `(100+20+30) × 10 = 1.500`,
  thiếu giá vốn → NULL + `missing`, SKU viết thường vẫn định giá được, RLS 3 view, 0017 chạy 2 lần) ·
  `web npm test` **113/113** (+30 test: `inventory-model.test.ts` mới 13 test + mở rộng
  pricing/listing model) · `worker npm test` **293/293** · `npx tsc --noEmit` sạch · 8 trang
  (`/pricing`, `/listing/list`, `/listing/queue`, `/fulfillment`, `/fulfillment/inventory`,
  `/fulfillment/inventory/detail`, `/fulfillment/restock`, `/finance/costs`) trả HTTP 200.

### Chờ VEXIM (Đợt B)

- ☐ Chạy `supabase/migrations/0017_sales30d_owner_inventory_value.sql` trong SQL Editor (sau `0016`).
- ☐ **Gán người phụ trách** trong `iam.assignments` theo (shop × module `pricing` / `listings` /
  `inventory`) — chưa gán thì cột "Phụ trách" hiện "— chưa gán" (có chủ đích, không tự bịa tên).
- ☐ Chạy `orders:sync` để có đơn 30 ngày: chưa có đơn thì P1/L1 hiện "—" chứ không hiện 0.
- ☐ Nhập giá vốn cho SKU còn tồn (`/finance/costs`): SKU thiếu giá vốn sẽ hiện "— chưa định giá"
  ở I1/I2 và "— chưa có giá vốn" ở I3, đồng thời bị đếm trong KPI "SKU chưa có giá vốn".

## Cập nhật 12/09 — ĐỢT A: gỡ chặn dữ liệu lõi (migration 0016 · giá vốn · ghi listing · P1 dùng giá vốn)

Ba việc chặn nhau suốt Đợt 1 đã được gỡ theo đúng thứ tự **giá vốn → ghi listing → pricing**:

- **Migration `0016_core_data_unblock.sql`** (idempotent + self-check 11 mục: cột / 6 view / 6 RPC /
  quyền / PII / `pricing_defaults` / `effective_cost()` khớp `cost_inputs`):
  - `catalog.listings` thêm **11 cột** để GHI được dữ liệu thật: `issues jsonb` (issue nguyên văn Amazon),
    `buyable`, `discoverable`, `product_type`, `quantity`, `stranded_reason`, `issue_errors`,
    `issue_warnings`, `enforcement_actions jsonb`, `last_source`, `last_synced_at` + 2 index.
  - `catalog.cost_inputs` thêm cột vết (`updated_at`, `updated_by`, `source_ref`) + unique
    `(shop, sku, effective_from)` để **import lại không nhân đôi** bậc giá vốn.
  - `catalog.pricing_defaults` (1 dòng cấu hình: referral 15% · biên tối thiểu 10% · phí khác 0) và
    `catalog.effective_cost_row()` / `catalog.effective_cost()` — **một luật giá vốn hiệu lực duy nhất**.
  - `public.vexim_worker_upsert_listings(p_seller, p_rows)` — RPC ghi listing cho worker (**chỉ
    `service_role`**): whitelist trạng thái (`ACTIVE|INACTIVE|SUPPRESSED|STRANDED|REMOVED|CLOSED|DELETED`,
    dòng mới chưa rõ → `UNKNOWN` chứ không bịa `ACTIVE`), `issues` dạng mảng = **thay** chi tiết,
    `null` = **giữ** dữ liệu cũ, chỉ có số đếm thì **xoá** mảng issue cũ, `stranded_reason` theo
    “key có mặt” để hết stranded là xoá được lý do, parse số an toàn (`1.299,99` → 1299.99, rác → NULL).
  - View: `vexim_listings` / `vexim_listing_queue` (đếm issue **ưu tiên mảng chi tiết**, queue nối thêm
    `buyable`/`discoverable`), `vexim_cost_inputs` (+`is_current`), `vexim_cost_coverage` (SKU đang bán
    **thiếu giá vốn / lệch tiền tệ** — chính là danh sách gỡ chặn), `vexim_shops` (bộ chọn shop, RLS lọc
    sẵn, **không phơi `seller_id`**). Tất cả `security_invoker = true`.
  - RPC giá vốn cho web: `iam.is_cost_editor()`, `vexim_upsert_cost_input`, `vexim_import_cost_inputs`
    (**chạy thử → hoàn tác → ghi thật**: 1 dòng lỗi thì KHÔNG ghi dòng nào, trả lỗi theo số dòng),
    `vexim_close_cost_input`, `vexim_delete_cost_input` (chỉ admin/trưởng phòng Tài chính) — mỗi lần ghi
    đều có `iam.audit_logs`. Helper parse đặt ở DB (`catalog.parse_amount`, `catalog.parse_day`: nhận
    `YYYY-MM-DD` và `DD/MM/YYYY`, **từ chối `MM/DD/YYYY` mơ hồ**) để luật parse chỉ có một bản.
  - **`vexim_pricing` nay dùng giá vốn hiệu lực** thay vì “giá sàn ≈ tổng phí” của 0013: thêm `unit_cost`,
    `cost_currency`, `cost_effective_from`, `cost_source`, `referral_rate_used`, `min_margin_rate`,
    `other_fee_per_unit`, `floor_price`, `gross_profit`, `margin_pct`, `below_floor`, `cost_basis`
    (`cost+fees | cost_only | fees_only | currency_mismatch`). Thiếu giá vốn → **NULL + nhãn lý do**,
    không lấy phí làm sàn. Công thức khớp `worker/src/domain/pricing.ts`:
    `floor = (vốn + FBA + khác) / (1 − referral − biên tối thiểu)`.
- **Worker — `upsertListing()` hết là stub rỗng, có runner `listings:sync`:**
  - `web/src/lib/worker/db/listing-payload.ts` (mới): dựng payload theo luật
    *undefined = không gửi (DB giữ nguyên)* / *null = chưa biết* / *`[]` = biết là rỗng*;
    `parseReportNumber` đọc số kiểu local. `DbAdapter.upsertListings()` (ghi cả lô) +
    `MockDbAdapter` **nhại đúng ngữ nghĩa RPC** để test không xanh giả.
  - `db/supabase.ts`: `upsertListing`/`upsertListings` gọi `POST /rest/v1/rpc/vexim_worker_upsert_listings`
    (nhóm theo shop, **không prefix schema**, không `Content-Profile` — đúng bài học sự cố 12/09).
  - `jobs/listings-sync.job.ts` viết lại: gộp report ALL + INACTIVE + STRANDED → **một lần ghi lô**,
    dựng hàng đợi L4 (`buildListingQueueEntry`), hook `fetchDetail` gọi `getListingsItem` cho **SKU có
    vấn đề** (trần mặc định 50, throttle ~4,5 rps) để lấy `issues`/`productType`/cờ BUYABLE,
    alert `listing_inactive` (đỏ nếu có stranded) hoặc tự đóng khi sạch, `sync_jobs` kiểu `listings.sync`.
  - `amazon/listings.ts`: `extractListingState` trả **mảng issue nguyên văn Amazon**
    (code/message/severity/attributeNames/categories/enforcements.actions) thay vì chỉ số đếm.
  - Runner mới `runtime/run-listings-sync.ts` + CLI `worker listings:sync --all=<listings.tsv>
    [--inactive=…] [--stranded=…] [--seller=<uuid>] [--details] [--detail-limit=50] [--dry-run]`
    (script `npm run worker:listings-sync`); **chỉ ghi DB thật khi production + đủ credentials**,
    còn lại chạy trong bộ nhớ và in rõ “KHÔNG ghi DB thật”.
- **Web — `/finance/costs` (mới) để NHẬP giá vốn thật:**
  - Nhập tay một bậc (SKU · giá vốn · tiền tệ · hiệu lực từ/đến · ghi chú) + **import CSV theo template**
    (tải ở `/api/finance/cost-template`): xem trước số dòng hợp lệ/lỗi theo số dòng **trước khi ghi**,
    all-or-nothing; “Kết thúc hiệu lực” (giữ lịch sử cho F4) và “Xoá” (chỉ admin/trưởng phòng Tài chính).
  - Panel **“SKU đang bán nhưng chưa dùng được giá vốn”** (từ `vexim_cost_coverage`) kèm nút nhập nhanh —
    đây chính là danh sách đang chặn F3/F4/P1; thang giá vốn theo SKU có nhãn *đang áp dụng / sắp hiệu lực*.
  - Ghi qua Server Action → RPC 0016 bằng anon client + phiên đăng nhập (quyền do
    `iam.can_write_seller_account()` + `iam.is_cost_editor()` chốt ở DB, web không dùng `service_role`).
    Thêm mục nav “Giá vốn (F3/F4/P1)” + chip ở `/finance`.
  - **P1/P2 dùng số thật:** `pricing-model` đọc 12 cột mới, ô giá sàn/biên hiện “—” kèm nhãn
    `cost_basis` và link sang `/finance/costs` khi thiếu giá vốn, thêm bộ lọc “Chưa có giá vốn”,
    KPI “SKU dưới giá sàn” đếm theo `below_floor`, breakdown giá sàn ở trang chi tiết liệt kê
    vốn hiệu lực + FBA + phí khác + tỷ lệ referral + biên tối thiểu.
  - **L1/L2/L4 dùng số thật:** tồn theo `quantity` (hết cảnh 0 giả), product type, cờ BUYABLE/DISCOVERABLE,
    lý do stranded, enforcement Amazon, nguồn ghi gần nhất; L2 chuẩn hoá `enforcements.actions`
    (trước đây cột enforcement luôn trống); L4 nêu nguyên nhân theo thứ tự
    *stranded → enforcement → mã issue → trạng thái* và đề xuất sửa đúng bệnh; trạng thái lạ → `UNKNOWN`
    (không ép về INACTIVE). Sửa luôn `readListingQueue` dùng select riêng vì view queue **không có**
    cột `buy_box_*` (select thừa cột là PostgREST trả PGRST204 → sập cả trang L4).
- **Kiểm chứng local (chạy thật, không suy luận):** `supabase npm test` **TẤT CẢ PASS** (BƯỚC 1..17;
  BƯỚC 17 chạy 0016 hai lần để kiểm idempotent + thang giá vốn + import CSV lỗi/atomic + quyền
  close/delete + ngữ nghĩa upsert listing + queue + `vexim_pricing` ra sàn 60.67/biên 39.5% +
  `unit_cost ≡ effective_cost()` ở mọi dòng + RLS + độ phủ + `vexim_shops`) · `worker npm test`
  **293/293** · `web npm test` **83/83** · `npx tsc --noEmit` sạch · 6 trang demo trả HTTP 200 ·
  chạy thử `listings:sync --dry-run` trên report mẫu: 4 listing / 2 stranded / 4 SKU vào hàng đợi L4.

### Chờ VEXIM (Đợt A)

- ☐ Chạy `supabase/migrations/0016_core_data_unblock.sql` trong SQL Editor (sau `0015`).
  **Không cần** thêm schema `catalog` vào *Exposed schemas*: web chỉ gọi RPC/view trong `public`.
- ☐ Vào `/finance/costs` → tải template → **nhập giá vốn** cho SKU đang bán (tay hoặc CSV).
  Chưa nhập thì F3 để trống giá trị claim, F4 để trống lãi gộp và P1 để trống giá sàn/biên (có chủ đích).
- ☐ Chỉnh `catalog.pricing_defaults` (id=1) nếu tỷ lệ referral / biên tối thiểu của VEXIM khác 15% / 10%.
- ☐ Tải 3 report trong Seller Central rồi nạp: `npm run worker:listings-sync -- --seller=<uuid>
  --all=<merchant-listings-all.tsv> --inactive=<inactive.tsv> --stranded=<stranded.tsv>`
  (thêm `--details` khi đã có `AMAZON_LWA_*` để lấy issue chi tiết cho L2).
- ☐ Cấp quyền nhập giá vốn: user Tài chính cần `role_assignments` (admin / `dept_lead` phòng `finance`)
  hoặc `iam.assignments` module `finance` + `can_write = true` trên đúng shop đó.
- ⚠ Đã biết: `getListingsItem` giới hạn ~5 rps (burst 10) nên `--details` chỉ soi SKU có vấn đề,
  trần mặc định 50 lần chạy (`--detail-limit` để đổi); report Merchant Listings chỉ cho **số đếm** issue,
  muốn có mã lỗi/nội dung thật thì phải gọi API.

## Cập nhật 12/09 — Module 6 Đợt 2: F3 bồi hoàn FBA + F4 lợi nhuận SKU (migration 0015)

- **Migration `0015_finance_claims_profit.sql`** (idempotent + self-check 3 bảng / 4 view / 2 trigger / 6 RPC):
  - `finance.reimbursements` — mở rộng theo đúng cột report: `reimbursement_id`, `case_id`,
    `amazon_order_id`, `reason`, `condition`, `amount_per_unit`, `amount_total`,
    `quantity_reimbursed_cash|inventory|total`, `original_reimbursement_id|type` + `dedupe_key`
    (unique theo shop) để **nhập lại report không nhân đôi**.
  - `finance.reimbursement_claims` — khoản nghi ngờ/đang khiếu nại: `category`
    (lost_fc/damaged_fc/inbound_missing/fee_error/return_missing/other), `source`
    (ledger/inbound/adjustment/manual) + `source_ref`, `quantity`, `unit_cost`, `estimated_amount`
    (**NULL khi chưa có giá vốn**), `status`, `amazon_case_id`, `reimbursed_amount`, `reimbursement_id`;
    unique theo `(shop, source, source_ref, sku)`.
  - `finance.reimbursement_claim_events` — lịch sử **append-only** (actor ghi trong bảng, view public
    không lộ email — đúng luật không PII).
  - `finance.sku_profit_daily` — PK `(shop, sku, ngày, tiền tệ)`; `cogs`/`gross_profit`/`ads_spend`
    **nullable**, `fee_source` ∈ `settled|fees_api|unavailable` để nói rõ độ tin cậy của phí.
  - Trigger giữ **máy trạng thái SOP-09**: `filed` phải có mã case · `approved/rejected/close` phải có
    ghi chú **và** quyền `iam.is_finance_editor()` · `paid` phải có số tiền · worker chỉ refresh khoản
    còn `suspected` (không ghi đè việc người đã xử lý).
  - Web ghi qua RPC `public.vexim_update_reimbursement_claim(...)`; worker ghi qua 5 RPC
    `vexim_worker_*` (chỉ `service_role`, đã revoke EXECUTE khỏi public/anon/authenticated).
- **Worker (đã có test):**
  - `reports/reimbursements.parser.ts` — bám **`GET_FBA_REIMBURSEMENTS_DATA`**: cột thật của Amazon,
    đọc số kiểu local (95,00), bỏ BOM, khoá chống trùng `reimbursement-id|sku|reason|amount-total`.
  - `reports/inventory-ledger.parser.ts` — bám **`GET_LEDGER_DETAIL_VIEW_DATA`** (18 tháng),
    chuẩn hoá tiêu đề, đếm theo EventType.
  - `domain/finance-claims.ts` — phân loại claim từ sổ cái (chỉ dòng **số âm**, lý do `FOUND` không tính),
    gộp dòng cùng tham chiếu, ước tính = SL × giá vốn hiệu lực (**thiếu giá vốn → NULL, không đoán**),
    tuổi claim + quá hạn 48h, tổng hợp, đối soát claim ↔ reimbursement, dựng bảng lợi nhuận SKU.
  - `jobs/finance-claims.job.ts` + runner `worker:finance-claims -- --ledger=<file>
    --reimbursements=<file> [--month=YYYY-MM] [--dry-run]`; chỉ ghi DB thật khi `mode = production`.
- **Web:** `/finance/claims` (hàng đợi SOP-09: lọc theo trạng thái/nguyên nhân/shop, sắp theo mức quá hạn,
  mở rộng xem lịch sử, nộp case/duyệt/ghi tiền về qua Server Action → RPC) và `/finance/profit`
  (chọn tháng, gộp theo SKU, **SKU lỗ lên đầu**, cột “Nguồn phí”, ô “—” khi thiếu giá vốn).
  Hai chip khoá ở `/finance` đã thay bằng liên kết thật; thêm 2 mục nav.
- **Kiểm chứng local:** `supabase npm test` **TẤT CẢ PASS** (BƯỚC 1..16, BƯỚC 16 chạy 0015 lần 2 để
  kiểm idempotent + toàn bộ vòng đời claim + F4) · `worker npm test` 275/275 · `web npm test` 45/45 ·
  `npx tsc --noEmit` sạch · `next build` PASS.

### Chờ VEXIM (Module 6 Đợt 2)

- ☐ Chạy `supabase/migrations/0015_finance_claims_profit.sql` trong SQL Editor (sau `0014`).
- ☐ ~~Thêm schema `catalog` vào *Exposed schemas*~~ — **không cần**: Đợt A (0016) đã có trang
  `/finance/costs` ghi qua RPC trong schema `public` (xem mục ĐỢT A ở đầu file).
- ☐ **Nhập giá vốn** cho các SKU đang bán tại **`/finance/costs`** (nhập tay hoặc CSV theo template) —
  chưa có giá vốn thì F3 để trống “giá trị ước tính” và F4 để trống lãi gộp (hệ thống cố ý không đoán).
- ☐ Khi có credentials SP-API: chạy `npm run worker:finance-claims -- --seller=<uuid> --ledger=<file>`
  (và `--reimbursements=<file>`) theo nhịp tuần cho SOP-09; F4 chạy lại sau mỗi kỳ settlement.
- ⚠ Đã biết: `GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA` (Fee Preview) chỉ cho **1 request/ngày/seller** và
  `dataStartTime` phải lùi ≥72h — hiện F4 ưu tiên phí thật từ settlement, chỉ dùng ước tính khi chưa có.

## Cập nhật 12/09 — L3: Trình soạn listing (Đợt 2, migration 0014)

- **Migration `0014_listing_editor.sql`** (mới, idempotent + self-check):
  - `catalog.listing_drafts` — bản nháp theo (shop, SKU): `payload`/`validation` jsonb,
    trạng thái `draft → pending_approval → approved → publishing → published/failed`.
  - `catalog.listing_draft_revisions` — lịch sử **append-only**: mỗi lần lưu/gửi/duyệt/
    từ chối/publish là 1 revision + danh sách attribute thay đổi + before/after payload.
  - `catalog.listing_publish_queue` — hàng đợi publish: `method` patch/put/feed, `status`
    queued/blocked/sent/accepted/invalid/failed, `submission_id`, `issues`, `block_reason`.
  - `catalog.listing_product_type_schemas` — cache JSON Schema product type để form động
    dùng `required`/`maxLength` THẬT của Amazon.
  - Trigger giữ **máy trạng thái + 4 mắt + cổng `validation.errorCount = 0`**; RLS theo shop;
    không có policy DELETE (giữ lịch sử); web ghi qua RPC public (§7B), worker qua RPC §7C
    (chỉ service_role).
- **Hạn mức kiểm chứng tài liệu Amazon 09/2026** (`web/src/lib/listing/amazon-limits.ts`):
  tiêu đề 75 ký tự (media 200; hiệu lực 27/07/2026), Item Highlight (`title_differentiation`)
  125, bullet 10–255 × tối đa 5, mô tả 2.000, từ khóa backend **249 BYTE** (JP 500, IN 200),
  9 ảnh. File ghi kèm `AMAZON_SOURCES` (URL + ngày kiểm chứng).
- **Web:** trang `/listing/editor` (nav "Soạn listing (L3)") + `/api/listing/drafts`: lưu nháp,
  gửi trưởng phòng duyệt, duyệt/từ chối (kèm lý do), publish (đẩy hàng đợi), xem lịch sử.
  DEMO MODE xem/kiểm tra được nhưng KHÔNG lưu giả (thiếu Supabase → API trả 409).
- **Worker:** `listing:publish` gọi `getListingsRestrictions` **TRƯỚC** khi gửi (blocked nếu
  APPROVAL_REQUIRED/ASIN_NOT_FOUND/NOT_ELIGIBLE), rồi `patchListingsItem`/`putListingsItem`,
  ghi ACCEPTED/INVALID + issues vào hàng đợi + lịch sử; `listing:schema` tải
  `getDefinitionsProductType` vào cache. Cả hai chỉ gọi Amazon + ghi DB thật khi
  `mode = production` và không `--dry-run`.
- **Kiểm chứng local:** `supabase npm test` **TẤT CẢ PASS** (BƯỚC 1..15) · `worker npm test`
  256/256 · `web npm test` 36/36 · `npx tsc --noEmit` sạch · `next build` 41/41 trang.

### Chờ VEXIM (L3)

- ☐ Chạy `supabase/migrations/0014_listing_editor.sql` trong SQL Editor (sau `0013`).
- ☐ Khi có credentials SP-API: `npm run worker:listing-schema -- --product-type=<loại>` cho các
  product type đang bán (form động mới có schema thật), rồi `npm run worker:listing-publish`.
- ⚠ Đã biết: `op: "merge"` của Amazon chỉ hỗ trợ `fulfillment_availability.quantity` +
  `purchasable_offer` (hiện patch theo whole-attribute); notification
  `LISTINGS_ITEM_ISSUES_CHANGE` v1.0 đã bị Amazon ngừng (14–26/08/2026) — rà lại khi cấu hình
  notification thật.

## Cập nhật 12/09 — migration 0011 + Module 4/6 đọc Supabase

- Đã lưu **nguyên nội dung SQL VEXIM cung cấp** vào
  `supabase/migrations/0011_web_public_views.sql`. Không chạy lại trên production.
  Ghi chú thiếu file 0011 ở đợt trước đã được giải quyết.
- **Module 4:** `/orders`, `/orders/list`, `/orders/detail`, `/orders/fbm`,
  `/orders/returns` chuyển sang đọc public views trong Supabase mode.
  Overview hiện là danh sách đơn thật; không giữ KPI/alerts/tin nhắn demo.
- **Module 6:** `/finance`, `/finance/settlements`,
  `/finance/settlements/detail`, `/finance/events` chuyển sang đọc public views.
  Overview hiện là danh sách kỳ thật; không suy lợi nhuận/COGS/TACOS/bồi hoàn.
- Bộ lọc client theo shop UUID, trạng thái, loại dòng tiền, tìm mã đơn/SKU/kỳ;
  hiển thị 50 dòng/trang. Đọc DB theo batch 500 dòng, tổng hợp trên toàn bộ dữ
  liệu được RLS cho phép. Phù hợp pilot; cần chuyển sang phân trang/tổng hợp
  server khi backfill lớn. Các tổng là toàn kỳ DB/bộ lọc, không gắn nhãn hôm nay.
- Tiền giữ nguyên currency; tổng tách theo tiền tệ, báo thiếu giá trị, không
  quy đổi; dòng `Transfer` không cộng vào tổng events để tránh cộng kép.
- FBM ưu tiên `latest_ship_date`, sắp hạn gần nhất trước. Thiếu thì ghi rõ
  **ƯỚC LƯỢNG = purchase_date + 24h giả định**, không phải handling cấu hình
  của shop. Thiếu cả ngày mua thì không bịa hạn. Countdown tại lúc tải trang,
  không chạy realtime; có nút tải lại. Report-sync hiện chưa ghi hạn Amazon,
  nên chỉ có hạn thật khi DB đã được nguồn khác ghi `latest_ship_date`.
- Chi tiết dùng UUID nội bộ lấy từ danh sách; thiếu/sai/ngoài quyền → không
  tìm thấy, không fallback bản ghi demo. Dòng hàng lọc `order_id` + shop;
  events của settlement lọc **settlement_id Amazon + seller_account_id**
  (không nhầm UUID nội bộ, không lẫn hai shop có cùng mã kỳ).
- Settlement detail có breakdown nhóm tiền từ worker + các events thuộc kỳ.
  Không coi NULL `reconcile_diff` là khớp nếu thiếu `reconciled_at` hoặc
  breakdown chỉ ra `transferSource=none`.
- Dùng session anon client; không service_role, không PII/raw. DB trống,
  lỗi query và không tìm thấy có trạng thái riêng; demo vẫn giữ riêng và gắn
  nhãn DEMO. Không bật thao tác ghi Amazon/refund/ship.

### Kiểm chứng local

- `cd web && npm test`: **13/13 PASS** (6 Health + 7 Operations).
- `cd web && npm run typecheck && npm run build`: PASS, 39/39 trang được sinh.
- `cd supabase && npm test`: TẤT CẢ PASS trên PGlite, gồm 0011 chạy lại lần 2,
  8 security-invoker views, chốt không PII/raw, main SKU theo quantity,
  deadline thật và RLS của 6 view Module 4/6 với user chỉ gán 1 shop.
- Test DB chạy đúng các SELECT projection từ web dưới role authenticated;
  fixture hai shop có cùng mã settlement xác nhận phải ghép mã kỳ + shop.
  Chỉ DB local trong bộ nhớ; fixture rollback, không chạm Supabase production.

### Checklist sau deploy

1. Login thật → mở 9 route trên: nhãn SUPABASE, không có số demo, empty state
   nếu chưa import report. Click detail từ danh sách (UUID nội bộ).
2. Import report qua pipeline hiện có → đối chiếu order/items/returns,
   settlement groups/events, tiền tệ, ngày cập nhật với nguồn gốc.
3. Đối chiếu queue MFN Pending/Unshipped/PartiallyShipped; phân biệt hạn Amazon
   với ước lượng. Không dùng ước lượng làm bằng chứng vi phạm SLA.
4. User chỉ được gán shop A không thấy dữ liệu shop B, kể cả sửa UUID URL.
5. Trên môi trường test, thu hồi SELECT view → báo lỗi, không chuyển sang mock.
6. Kiểm thử tương tác trình duyệt (lọc, tìm kiếm, phân trang), và production
   RLS chưa thực hiện từ sandbox này; không coi local tests là xác nhận live.

**Tiếp theo:** nối Module 3 qua hai view mới; bổ sung pipeline ghi hạn ship
Amazon, hoàn thiện RBAC session và dashboard KPI theo kỳ/nguồn đã đối soát.

## Cập nhật tiếp nối 12/09 — Module 7 đọc Supabase (H1/H2)

- **VEXIM xác nhận:** đã chạy migration 0010, 0011 và expose đủ 11 schemas.
  Đây là xác nhận của người vận hành, chưa kiểm tra trực tiếp DB từ phiên dev này.
- **Lưu ý đồng bộ repo:** `origin/main` ở commit `3866fed` chỉ có migration đến
  `0010`; cần bổ sung bản SQL `0011` đã chạy vào Git để có thể tái lập DB.
  Đợt này không tạo/chạy lại migration và không thay đổi DB production.
- `/health` và `/health/violations`: khi session ở Supabase mode, đọc
  `public.vexim_shop_health` và `public.vexim_health_issues` bằng anon client
  kèm cookie của user; giữ nguyên RLS/security-invoker, không dùng service role.
- Demo mode vẫn có dữ liệu mẫu, gắn nhãn DEMO. DB trống có empty state;
  truy vấn lỗi có error state và **không fallback mock**. KPI lấy từ dữ liệu
  đọc được, phân biệt shop với shop/marketplace và nhóm vi phạm với case.
- Hiển thị ngày báo cáo, thời điểm thu thập, AHR/ODR/late ship; null là “—”,
  giữ nguyên màu đỏ và unknown. H2 sort severity, dùng issue UUID làm key,
  không gọi reporting_from là ngày mở case. Đã sửa nguồn report V1 → V2.
- Phân trang truy vấn 500 dòng để không cắt KPI ở giới hạn mặc định PostgREST.
- Không hiển thị tác vụ/SLA demo trong màn thật. Luồng ghi/appeal vẫn không bật.

**Kiểm chứng local:** `cd web && npm test` (6/6 PASS),
`npm run typecheck` PASS, `npm run build` PASS (39/39 trang sinh thành công).
Chưa kiểm chứng trình duyệt đăng nhập production hoặc RLS trên project thật.
`npm ci` báo 2 advisory dependency (1 moderate, 1 high); chưa thay dependency
ngoài phạm vi tính năng này.

**Kiểm tra sau deploy:**
1. Đăng nhập Supabase → `/health`, `/health/violations`: có nhãn SUPABASE,
   không còn số shop/case/tác vụ demo. DB chưa import report thì hiển thị trống.
2. Sau sync report thật: so AHR/ODR/late ship, marketplace và ngày với report;
   xác nhận các nhóm Critical/High lên đầu H2.
3. Đăng nhập user giới hạn shop: chỉ thấy snapshot/issue được RLS cho phép.
4. Trên môi trường test, mô phỏng mất quyền view → thông báo lỗi, không mock.

**Tiếp theo:** nối Module 4 (Orders/FBM/Returns), rồi Module 6
(Settlements/Financial events); hoàn thiện RBAC session (code hiện vẫn gán
persona `ceo` cho user Supabase — phạm vi dữ liệu ở hai màn trên do RLS quyết định).
Không coi Module 7 là đã kiểm chứng production trước các bước kiểm tra trên.

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
- ☐ ✅ `0011`/`0012`/`0013` đã chạy · ☐ **`0014`** (trình soạn listing L3) · ☐ **`0015`** (bồi hoàn FBA + lợi nhuận SKU) · ☐ **`0016`** (Đợt A: giá vốn + ghi listing + `vexim_pricing` dùng giá vốn) · ☐ **`0017`** (Đợt B: doanh số 30 ngày + người phụ trách + giá trị tồn kho) · ☐ **`0018`** (Module 3 nâng cao: phân bổ tồn theo FC + lịch sử nhận hàng)
- ☐ **Thêm `CRON_SECRET` trên Vercel** (Production + Preview) → Redeploy
- ☐ `AMAZON_LWA_CLIENT_ID` / `_CLIENT_SECRET` / `_REFRESH_TOKEN` khi Developer Profile được duyệt — thiếu 3 biến này thì worker chỉ chạy demo trong bộ nhớ (an toàn, không ghi DB thật)
- ☐ 4 thông tin thật cho landing page (email/phone/địa chỉ/tên pháp lý)
- ☐ Chốt 2–3 shop pilot + file giá vốn theo template CSV (tải template ngay trong app:
  `/finance/costs` → “⬇ Tải template CSV”, hoặc `GET /api/finance/cost-template`)
- ☐ Hải Anh: báo ngày nộp hồ sơ + tạo Sandbox Application ngay sau khi nộp

### Biến môi trường Vercel: cái nào code thật sự đọc

*(Bảng 12/09 ở dưới đã lỗi thời — từ 13/09 Module 0 + Module 5 thêm nhóm OAuth và Ads.)*
Danh sách đầy đủ lấy bằng `grep -rhoE "(process\.env|env)\.[A-Z][A-Z_0-9]{3,}" web/src`:

| Nhóm | Biến | Ghi chú |
|---|---|---|
| Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | web đọc view bằng anon + RLS |
| | `SUPABASE_SERVICE_ROLE_KEY` (hoặc `SUPABASE_URL` + service key) | worker/cron ghi qua RPC; **không** đưa ra client bundle |
| Cron | `CRON_SECRET` | bảo vệ 4 cron: inventory-sync · report-pull · oauth-reauth · **ads-sync** |
| OAuth (Module 0) | `OAUTH_TOKEN_ENC_KEY` | 32 byte hex — khoá AES-256-GCM mã hoá refresh token. **Mất khoá = mọi shop phải authorize lại** |
| | `OAUTH_STATE_SECRET` | ký state chống CSRF + ký link `/start` gửi chủ shop |
| | `APP_BASE_URL` (fallback `NEXT_PUBLIC_APP_URL`, `VERCEL_PROJECT_PRODUCTION_URL`) · `OAUTH_REDIRECT_URI` (hoặc `NEXT_PUBLIC_OAUTH_REDIRECT_URI`) | redirect URI phải KHỚP Developer Console |
| SP-API | `AMAZON_LWA_CLIENT_ID`/`_CLIENT_SECRET`/`_REFRESH_TOKEN` (alias `SPAPI_LWA_*`), `AMAZON_SP_API_APPLICATION_ID`, `AMAZON_SP_API_REGION`, `AMAZON_LWA_TOKEN_URL`, `AMAZON_APP_ID` | có `APPLICATION_ID` thì dùng trang consent Seller Central (callback trả `spapi_oauth_code`) |
| Ads (Module 5) | `AMAZON_ADS_CLIENT_ID`, `AMAZON_ADS_CLIENT_SECRET`, `AMAZON_ADS_REFRESH_TOKEN`, `AMAZON_ADS_REGION`, `AMAZON_ADS_TOKEN_URL`, `AMAZON_ADS_BASE_URL` | `REFRESH_TOKEN` chỉ là FALLBACK khi shop chưa có token trong DB (kèm cảnh báo “không gắn shop”) |
| | `AMAZON_ADS_ATTRIBUTION_DAYS` (7 seller / 14 vendor), `AMAZON_ADS_REPORT_DAYS` (mặc định 7, trần 31), `AMAZON_ADS_PROFILE_TYPE`, `AMAZON_ADS_COUNTRY`, `AMAZON_ADS_ACCOUNT_ID` | chọn profile + cửa sổ report |
| Nghiệp vụ | `VEXIM_LEAD_DAYS`, `VEXIM_SAFETY_DAYS`, `AMAZON_WHOAMI_FALLBACK_ASIN` | đã có từ trước |

Không có biến `AMAZON_ADS_PROFILE_ID`: profileId là **THEO SHOP** (cột
`connections.oauth_tokens.ads_account_id`, nhập ở `/module0/connect`) — một biến toàn cục sẽ ép nhầm
profile cho mọi shop.

Các biến `POSTGRES_*`, `SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
`SUPABASE_SECRET_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET` **code không đọc** — không gây hại,
có thể để nguyên.
