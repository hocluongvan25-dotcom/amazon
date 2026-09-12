# TIẾN ĐỘ TRIỂN KHAI — VEXIM OPS

> Cập nhật: 12/09/2026 · Thứ tự build đã chốt: **0 → 7 → 4 → 3 → 1(đọc) → 2 → 6(đọc)** (21 màn Đợt 1)

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
- ☐ ✅ `0011`/`0012`/`0013` đã chạy · ☐ **`0014`** (trình soạn listing L3) · ☐ **`0015`** (bồi hoàn FBA + lợi nhuận SKU) · ☐ **`0016`** (Đợt A: giá vốn + ghi listing + `vexim_pricing` dùng giá vốn)
- ☐ **Thêm `CRON_SECRET` trên Vercel** (Production + Preview) → Redeploy
- ☐ `AMAZON_LWA_CLIENT_ID` / `_CLIENT_SECRET` / `_REFRESH_TOKEN` khi Developer Profile được duyệt — thiếu 3 biến này thì worker chỉ chạy demo trong bộ nhớ (an toàn, không ghi DB thật)
- ☐ 4 thông tin thật cho landing page (email/phone/địa chỉ/tên pháp lý)
- ☐ Chốt 2–3 shop pilot + file giá vốn theo template CSV (tải template ngay trong app:
  `/finance/costs` → “⬇ Tải template CSV”, hoặc `GET /api/finance/cost-template`)
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
