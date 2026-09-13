# KẾ HOẠCH TRIỂN KHAI CHI TIẾT THEO MODULE — GẮN API AMAZON
## Tài liệu trình duyệt #3 (sau khi thống nhất dashboard tổng quan)

> **Mục đích:** trả lời yêu cầu — *"tác vụ chi tiết để ra được kết quả như các thông tin trên hệ thống: trang listing, trang content..."* — tức **các màn hình làm việc thực tế** nơi nhân viên VEXIM thao tác hằng ngày để tạo ra con số trên dashboard.
>
> **Phương pháp:** mỗi màn hình được thiết kế **bám sát đúng tài liệu Amazon** — đúng tên operation, phiên bản API, loại report, notification, rate limit — để khi có tài khoản seller là "cắm vào chạy được". Mọi API dưới đây đều đã kiểm chứng qua developer-docs.amazon.com (danh sách nguồn ở Phụ lục).
>
> **Trạng thái:** chưa code — chờ VEXIM duyệt từng module (checklist cuối tài liệu).

---

## 0. CÁCH ĐỌC TÀI LIỆU

Mỗi module gồm 6 phần:
1. **Màn hình làm việc** — tên + nội dung chính (bảng, form, hành động)
2. **Ánh xạ API** — dữ liệu/hành động ↔ operation Amazon (đọc/ghi) + tần suất + rate limit
3. **Đồng bộ** — notification theo thời gian thực + report đối soát theo lịch
4. **Đầu ra** — cảnh báo & KPI nuôi dashboard phòng ban
5. **Input VEXIM phải cung cấp** (dữ liệu nội bộ Amazon không có)
6. **Cấp độ & effort** — thuộc đợt nào của lộ trình, ước tính người-tuần

**Quy ước độ ưu tiên build:**
- 🟢 **Đợt 1 (Cấp độ 1, tuần 4–8):** màn hình cần để vận hành ngày 1
- 🟡 **Đợt 2 (Cấp độ 2, tháng 3–4):** tối ưu/tăng trưởng
- 🔵 **Đợt 3 (Cấp độ 3, tháng 5–6):** tự động hóa

**Lưu ý rate limit:** các con số dưới đây theo docs Amazon hiện hành; worker luôn đọc header `x-amzn-RateLimit-Mode`/`Retry-After` thực tế và tự backoff. Nguyên tắc: **1 SKU → PATCH trực tiếp; >100 SKU → feed hàng loạt** (Amazon đang dỡ bỏ flat-file feed cũ, chuẩn mới là `JSON_LISTINGS_FEED`).

---

## MODULE 0 — HẠ TẦNG DÙNG CHUNG (build trước, mọi module dựa vào)

| Màn hình | Nội dung | API Amazon |
|---|---|---|
| **0.1 Trình kết nối shop** (wizard) | Gửi link → seller authorize → tự backfill 30 ngày → smoke test | OAuth LWA (Login with Amazon) + toàn bộ API đọc bên dưới |
| **0.2 Sức khỏe đồng bộ** (sync health) | Trạng thái từng job, độ trễ dữ liệu, số lần retry, lệch đối soát % — *trường hợp nào dữ liệu không mới phải thấy ngay* | — (nội bộ, đọc `sync_jobs`/`notifications_log`) |
| **0.3 Mức dùng API & chi phí** | Số call/ngày theo nhóm API từng shop (kiểm soát chi phí SP-API 2026) | Usage API + `api_usage_daily` |
| **0.4 Nhật ký thao tác (audit log)** | Ai đổi giá/sửa listing/chỉnh campaign gì, lúc nào, trước–sau | — (nội bộ, RLS) |
| **0.5 Quản trị người dùng & gán quyền** | User, vai trò, gán user ↔ shop ↔ module | — (Supabase Auth + RLS) |

**Nền kỹ thuật:** Notifications API v1 (destination EventBridge/SQS + subscription từng loại), Reports API 2021-06-30 (`createReport` → nhận `REPORT_PROCESSING_FINISHED` → `getReportDocument`, không polling), Feeds API 2021-06-30 (`createFeed` JSON_LISTINGS_FEED → `FEED_PROCESSING_FINISHED`), Tokens API (RDT — chỉ bật khi có role restricted).

**Effort:** 3 người-tuần (đã bắt đầu từ Tier 0).

---

## MODULE 1 — LISTING & CONTENT 🏷️

> Nhân viên phòng Listing làm việc chủ yếu ở đây: xem toàn bộ SKU, sửa nội dung, xử lý SKU bị lỗi/ẩn.

### Màn hình

| # | Màn hình | Nội dung chính | Cấp |
|---|---|---|---|
| L1 | **Danh sách listing** | Bảng: ảnh, SKU, ASIN, tiêu đề, trạng thái (ACTIVE/INACTIVE/STRANDED…), giá, tồn, số issues, người phụ trách. Filter: shop / trạng thái / loại lỗi / brand. Tìm kiếm, sort theo doanh thu/SKU. Hành động hàng loạt: export, gán người xử lý · ✅ **0017**: doanh thu + đơn vị 30 ngày (`vexim_sku_sales_30d`) và người phụ trách (`iam.module_owner`) — hết cảnh sort theo toàn số 0 | 🟢 |
| L2 | **Chi tiết listing** | Đầy đủ thuộc tính hiện có trên Amazon (theo product type), danh sách **issues** đúng mã lỗi Amazon (thiếu ảnh, thiếu thuộc tính bắt buộc…), lịch sử thay đổi, tình trạng offer & Buy Box, doanh thu 30 ngày của SKU | 🟢 |
| L3 | **Trình soạn/sửa listing** (content editor) | Form **động theo product type** (trường bắt buộc/bắt buộc có điều kiện lấy từ schema Amazon): tiêu đề, bullet points, mô tả, từ khóa backend, ảnh, variation, `fulfillment_availability`, `purchasable_offer`. Luồng: **Draft → Trưởng phòng duyệt → Publish**. Kiểm tra hạn chế danh mục trước khi đăng | 🟡 |
| L4 | **Hàng đợi inactive/stranded** | Queue theo SOP-03: mỗi dòng = 1 SKU lỗi + nguyên nhân + đề xuất sửa + ai giữ · ✅ **0017**: thêm "tiền đang mất"/ngày và xếp hàng đợi theo mức ưu tiên → doanh thu 30 ngày | 🟢 |
| L5 | **A+ Content** | Danh sách & quản lý A+ của shop (yêu cầu Brand Registry) | 🔵 |

### Ánh xạ API (đã kiểm chứng docs Amazon)

| Dữ liệu / hành động | Operation (version) | Loại | Tần suất / rate |
|---|---|---|---|
| Đọc 1 listing + issues | `getListingsItem` — Listings Items API **2021-08-01** (issues, attributes, summaries, procurement) | Đọc | theo yêu cầu (5 rps/10 burst) |
| Sửa từng phần 1 SKU (giá, ảnh, thuộc tính, tồn số lượng FBM) | `patchListingsItem` — PATCH `replace` `/attributes/…` (vd `/attributes/purchasable_offer` với `audience`, `currency`, `our_price`) | **Ghi** | theo tác vụ (5 rps/10 burst) |
| Tạo/đè toàn bộ 1 SKU | `putListingsItem` (requirements: `LISTING` / `LISTING_OFFER_ONLY` / `OFFER`) | **Ghi** | theo tác vụ |
| Sửa/tao hàng loạt (>100 SKU) | Feeds API 2021-06-30 → **`JSON_LISTINGS_FEED`** (tối đa **25.000 message**/feed, cấu trúc giống put/patch) | **Ghi** | theo đợt |
| Schema product type (form động) | `getDefinitionsProductType`, `searchDefinitionsProductTypes` — Product Type Definitions API 2020-09-01 | Đọc | cache theo loại |
| Tra ASIN/danh mục, ảnh, thương hiệu | `getCatalogItem`, `searchCatalogItems` — Catalog Items API **2022-04-01** | Đọc | 2 rps/2 burst |
| Kiểm tra bị hạn chế đăng danh mục nào | `getListingsRestrictions` — Listings Restrictions API 2023-11-01 | Đọc | theo yêu cầu |
| A+ Content | A+ Content API **2020-11-01** (`getContentDocuments`, `postContentDocument`, `searchContentDocuments`) | Đọc/Ghi | 📌 cần Brand Registry |
| Danh sách toàn bộ listing mỗi ngày | Report `GET_MERCHANT_LISTINGS_ALL_DATA`; inactive: `GET_MERCHANT_LISTINGS_INACTIVE_DATA`; **stranded**: `GET_STRANDED_INVENTORY_UI_DATA` | Report | hằng ngày 2h sáng |

### Đồng bộ realtime
- Notification **`LISTINGS_ITEM_STATUS_CHANGE`** → SKU chuyển trạng thái → cập nhật L1 + sinh cảnh báo `listing_inactive`
- Notification **`LISTINGS_ITEM_ISSUES_CHANGE`** → có issue mới → đẩy vào L4
- Notification **`PRODUCT_TYPE_DEFINITIONS_CHANGE`** → invalidate cache schema

### Đầu ra cho dashboard
KPI: số active/inactive/stranded, số lỗi mới hôm nay, thời gian xử lý trung bình. Alert: `listing_inactive`. Task: theo SOP-03.

### Input VEXIM cung cấp
Checklist nội dung chuẩn khi tạo listing mới (tiêu đề theo formula, số ảnh, bullet chuẩn) — lưu thành template trong L3.

**Effort:** L1+L2+L4: 3 người-tuần (🟢) · L3: 3 người-tuần (🟡) · L5: 2 người-tuần (🔵)

---

## MODULE 2 — GIÁ & FEATURED OFFER (PRICING) 💲

### Màn hình

| # | Màn hình | Nội dung chính | Cấp |
|---|---|---|---|
| P1 | **Bảng giá & Featured Offer** | Mỗi SKU: giá hiện tại, **FOEP** (giá để vào Featured Offer), giá cạnh tranh tham chiếu, đang giữ box hay không, **giá sàn** (vốn + phí + biên tối thiểu), biên lãi hiện tại. Lọc: SKU mất box / sắp mất / dưới giá sàn · ✅ **0017**: velocity 30 ngày (đơn vị/ngày) + doanh thu 30 ngày để ước thiệt hại khi mất box, và người phụ trách module pricing | 🟢 |
| P2 | **Chi tiết giá 1 SKU** | Lịch sử giá 30–90 ngày, danh sách offer đối thủ (giá + vận chuyển + kênh fulfil), breakdown giá sàn: giá vốn + referral fee + FBA fee + biên | 🟢 |
| P3 | **Duyệt & áp giá** | Hàng chờ duyệt: SKU, giá cũ → mới, % thay đổi, lý do (đề xuất tự động hoặc thủ công). Áp: ≤2% operator tự duyệt, >2% trưởng phòng duyệt. Ghi audit + rollback được | 🟢 |
| P4 | **Quy tắc giá tự động** | Luật kiểu "nếu mất box > 2h và còn dư trên giá sàn → điều theo FOEP" (chạy có giới hạn + duyệt) | 🔵 |

### Ánh xạ API (đã kiểm chứng — gồm cả bản 2022-05-01 mới)

| Dữ liệu / hành động | Operation (version) | Loại | Tần suất / rate |
|---|---|---|---|
| Giá + offers của SKU mình | `getPricing` (nhận tối đa 20 SKU/lần) — Product Pricing API v0 | Đọc | 0.5 rps/1 burst → dùng lịch + hàng đợi |
| Offers chi tiết theo SKU (đối thủ cùng trang) | `getListingOffers` / hàng loạt `getListingOffersBatch` (batch 20) | Đọc | 1 rps/2 burst; batch 0.5/1 |
| Offers theo ASIN | `getItemOffers` / `getItemOffersBatch` | Đọc | 0.5/1; batch 0.5/1 |
| **Tóm tắt cạnh tranh mới** (featured buying options + referencePrices + lowest offers) | `getCompetitiveSummary` — Product Pricing API **2022-05-01**. Từ 30/09/2025 dùng **CompetitivePrice** (JP vẫn trả CompetitivePriceThreshold) | Đọc | theo lịch |
| **Giá kỳ vọng vào Featured Offer** | `getFeaturedOfferExpectedPriceBatch` — batch tối đa **40 SKU** | Đọc | theo lịch (mỗi giờ nhóm SKU trọng yếu) |
| Biên/định giá sàn | `getMyFeesEstimateForSKU` / batch `getMyFeesEstimates` (20 SKU) — Product Fees API v0 | Đọc | 1/2; batch 0.5/1 |
| **Áp giá 1 SKU** | `patchListingsItem` (Listings Items 2021-08-01) — PATCH `/attributes/purchasable_offer` (`audience: ALL` + `currency` + `our_price`) | **Ghi** | tức thời |
| **Áp giá hàng loạt** | Feeds API → `JSON_LISTINGS_FEED` (PATCH purchasable_offer) | **Ghi** | theo đợt |

### Đồng bộ realtime
- Notification **`ANY_OFFER_CHANGED`** (đăng ký theo SKU trọng yếu — Amazon giới hạn số subscription) → đối thủ đổi giá → cập nhật P1/P2, đánh giá mất box
- Notification **`PRICE_HEALTH`** → giá mình cao hơn ngưỡng cạnh tranh → cảnh báo sớm mất box

### Đầu ra cho dashboard
Alert `buybox_lost` (P1 phát hiện) → SOP-02. KPI: % SKU giữ box, biên trung bình.

### Input VEXIM
Giá vốn từng SKU (import Excel/API nội bộ), biên tối thiểu %, ngưỡng % đổi giá cần duyệt.

**Effort:** P1–P3: 3 người-tuần (🟢) · P4: 2 người-tuần (🔵)

---

## MODULE 3 — KHO VẬN & FBA 📦

### Màn hình

| # | Màn hình | Nội dung chính | Cấp |
|---|---|---|---|
| I1 | **Tồn kho theo SKU** | Bảng: SKU, ảnh, tồn khả dụng / reserved / đang về (inbound), **days of cover**, velocity 14 ngày, SKU sắp hết (đỏ), tồn lâu. Sort theo doanh thu/SKU · ✅ **0017**: **giá trị tồn kho** = Σ (khả dụng + reserved + đang về) × giá vốn hiệu lực, theo tiền của giá vốn; SKU thiếu giá vốn hiện "—" và đếm riêng ở KPI | 🟢 |
| I2 | **Chi tiết tồn 1 SKU** | Biểu đồ tồn + doanh số 90 ngày, phân bổ theo fulfillment center, lịch sử nhận hàng · ✅ **0017**: panel "Giá trị tồn kho" diễn giải vốn hiệu lực → khả dụng × vốn → cộng reserved + đang về · ✅ **0018**: **phân bổ theo FC** (FC · tổng · % của SKU · bán được/không bán được/không rõ) và **lịch sử nhận hàng** (ngày · lô · FC · thực nhận) chạy bằng số thật từ 2 report FBA — API không có hai số này · ✅ **0019**: thêm khối **Phí lưu kho theo FC** của SKU (kỳ mới nhất + chênh lệch kỳ phí, khớp theo SKU ∨ FNSKU ∨ ASIN vì report phí không có SKU người bán) | 🟢 |
| I3 | **Kế hoạch nhập hàng** | Danh sách SKU cần nhập (đề xuất tự động = velocity × (lead time + safety) − tồn − đang về) → chốt số lượng + giá vốn → duyệt → **tạo inbound plan** → theo dõi · ✅ **0017**: cột giá vốn + **giá trị lô** = đề xuất × giá vốn hiệu lực (thiếu giá vốn thì ghi rõ "— chưa có giá vốn", không in $0) | 🟡 (đọc 🟢) |
| I4 | **Inbound shipments** | Bảng lô hàng: trạng thái (WORKING/SHIPPED/RECEIVING/CLOSED…), số lượng, FC đích, ETA; cảnh báo "nhận thiếu so với kế hoạch" · ✅ **0018**: cột *FC đích* + *Đối soát nhận* hết placeholder — ghép report receipts theo mã lô (Nhận đủ / Thiếu → SOP-09 / Thừa / Chưa rõ số gửi) và panel "lô có số nhận nhưng không còn trong danh sách" · ✅ **0019**: cột **Phí / vấn đề inbound** (số vấn đề + tiền phạt của lô) + 3 panel *lô nặng nhất* · *từng vấn đề kèm coaching & phí* · *lô mồ côi* từ report noncompliance | 🟡 (đọc 🟢) |

### Ánh xạ API (đã kiểm chứng)

| Dữ liệu / hành động | Operation (version) | Loại | Tần suất / rate |
|---|---|---|---|
| Tồn kho tổng hợp | `getInventorySummaries` — **FBA Inventory API v1** (granularity Marketplace, details: sumária khả dụng/reserved/inbound) | Đọc | mỗi 30–60 phút (2 rps/30 burst) |
| Tồn chi tiết theo FC | Report `GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA` (có reserved) | Report | hằng ngày |
| Hàng tồn lâu | Report `GET_FBA_INVENTORY_AGED_DATA` (aged 90/180/270/365+ ngày) | Report | hằng tuần |
| Stranded | Report `GET_STRANDED_INVENTORY_UI_DATA` | Report | hằng ngày (dùng chung Module 1) |
| **Tạo & vận hành inbound plan** | Fulfillment Inbound API **v2024-03-20**: `createInboundPlan` → `setPackingInformation` → `generatePackingOptions` → `confirmPackingOption` → `generatePlacementOptions` → `confirmPlacementOption` → `generateTransportationOptions` → `confirmTransportationOptions`; theo dõi: `getInboundPlan`, `listInboundPlans`, `getShipment`, `listShipmentItems`; `getDeliveryChallanDocument`, `scheduleSelfShipAppointment` | **Ghi** (cần role **Amazon Fulfillment**) | theo tác vụ 📌 quyết định đang chờ VEXIM chốt |
| Đặt/hủy hàng đa kênh (MCF) | Fulfillment Outbound API 2020-07-01 | — | ❌ ngoài scope, không làm |

### Đồng bộ realtime
- Notification **`FBA_INVENTORY`** (thay đổi tồn) → cập nhật I1
- Notification **`FBA_SHIPMENT_STATUS`**? — dùng báo cáo + `getShipment` theo lịch cho I4 (an toàn hơn vì không phải shop nào cũng có notification type này)

### Đầu ra cho dashboard
Alert `stockout_risk` → SOP-01 (toàn bộ vòng đời nằm ở I3). KPI: số SKU sắp hết, in-stock %, giá trị tồn (✅ **0017** đã tính được từ giá vốn hiệu lực), số lô nhận thiếu so với số gửi (✅ **0018** — `vexim_inbound_receipt_shipments.reconcile_state = 'short'` → đầu vào SOP-09), **phí lưu kho theo FC** và **tiền phạt inbound noncompliance** (✅ **0019** — `vexim_storage_fee_by_fc`, `vexim_inbound_issue_shipments`; đầu vào SOP-09 và quyết định chuyển FC / xả hàng tồn lâu).

### Input VEXIM
Lead time nhập hàng (VN→US theo từng đường: nhanh/chậm), tồn kho ngoài Amazon (nếu có), safety stock chuẩn.

**Effort:** I1+I2: 2.5 người-tuần (🟢) · I3+I4: 3 người-tuần (🟡, nếu chốt role Amazon Fulfillment)

---

## MODULE 4 — ĐƠN HÀNG & CSKH 💬

### Màn hình

| # | Màn hình | Nội dung chính | Cấp |
|---|---|---|---|
| O1 | **Danh sách đơn** | Bảng: mã đơn, ngày, trạng thái (Pending/Shipped/Cancelled…), kênh **AFN/MFN**, số món, tổng tiền, SKU chính. Filter: shop/trạng thái/kênh/khoảng ngày. ⚠️ *không hiển thị tên/địa chỉ buyer (PII — chưa xin role restricted)* | 🟢 |
| O2 | **Chi tiết đơn** | Danh sách item (ASIN, SKU, số lượng, giá), dòng tiền, timeline trạng thái. Trường địa chỉ/điện thoại **ẩn sẳn** — chỉ mở khóa khi VEXIM được duyệt role Direct to Consumer Shipping | 🟢 |
| O3 | **Queue FBM** | Đơn FBM chờ xác nhận, **đếm ngược thời hạn ship**, trạng thái tracking. Hành động: đánh dấu đã xử lý (thao tác ship thực tế làm ở phía vận chuyển riêng của VEXIM) | 🟢 |
| O4 | **Returns & Refunds** | Bảng: ngày return, đơn, lý do (mã lý do Amazon), trạng thái hoàn tiền, giá trị. Phân tích lý do lặp lại nhiều | 🟢 |
| O5 | **Log tin nhắn & feedback** | Log tin nhắn buyer **nhập/liên kết nội bộ** (SP-API không đọc hộp thư — quyết định v1.1) + danh sách feedback 1–3★ mới | 🟡 |

### Ánh xạ API (đã kiểm chứng)

| Dữ liệu / hành động | Operation (version) | Loại | Tần suất / rate |
|---|---|---|---|
| Danh sách đơn (delta) | `getOrders` — Orders API **v0** (filter CreatedAfter/LastUpdatedAfter) | Đọc | mỗi 15–30 phút (~0.0167 rps duy trì/20 burst) |
| Chi tiết 1 đơn | `getOrder`, `getOrderItems` (+ `getOrderAddress`/`getOrderBuyerInfo` = **restricted — khóa cho tới khi duyệt role**) | Đọc | theo yêu cầu |
| Đơn realtime | Notification **`ORDER_CHANGE`** → kéo chi tiết đơn thay đổi | Đọc | realtime |
| Đối soát đầy đủ | Report `GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL` | Report | hằng ngày 2h sáng |
| Trả hàng | Report `GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE` | Report | hằng ngày |
| Gửi email buyer theo mẫu | Messaging API v1 (`createConfirmOrderDetails`, `createLegalDisclosure`…) — **chỉ gửi, không đọc**; cần role Buyer Communication | **Ghi** | 🟡 defer |
| Xin gỡ feedback | Messaging `createNegativeFeedbackRemoval` | **Ghi** | 🟡 defer |

### Đầu ra cho dashboard
KPI: đơn/ngày, FBM đúng hạn, returns theo lý do. Alert: `message_aging` (từ log O5), FBM sắp trễ. Task: SOP-06, SOP-07.

### Input VEXIM
Nguồn log tin nhắn (email shared mailbox? nhập tay?) — **cần VEXIM chốt** để thiết kế O5.

**Effort:** O1–O4: 3 người-tuần (🟢) · O5: 1.5 người-tuần (🟡)

---

## MODULE 5 — QUẢNG CÁO (PPC) 📈

### Màn hình

| # | Màn hình | Nội dung chính | Cấp |
|---|---|---|---|
| A1 | **Campaigns** | Bảng: loại (SP/SB/SD), trạng thái, ngân sách/ngày, spend hôm qua + 7 ngày, ACOS 7/14 ngày, đơn từ ads, **đã cạn budget lúc mấy giờ hôm qua**. Hành động: bật/tắt, đổi budget/bid (ghi audit, duyệt theo ngưỡng) | 🟡 ✅ *P1 13/09 (0020)* |
| A2 | **Chi tiết campaign** | Ad groups, keywords/targets (match type, bid, impressions, CTR, CPC, ACOS từng từ), placements | 🟡 ✅ *P2 13/09 (0021 · `/ppc/campaigns/[id]` — đổi bid · tạm dừng · nới ngân sách)* |
| A3 | **Search terms** | Thuật ngữ người dùng gõ: clicks, spend, sales, đơn — **gợi ý negative keyword** (mức tin cậy kèm theo, người duyệt) | 🟡 ✅ *P2/P3 13/09 (0021 · `/ppc/search-terms` — bộ lọc SOP-04, duyệt là chặn)* |
| A4 | **Bảng quyết định tuần** | Tổng hợp đề xuất tuần: tăng/giảm budget, giảm bid, negative — duyệt hàng loạt 1 click | 🔵 |

### Ánh xạ API (Amazon Ads API — đăng ký riêng, không thuộc SP-API)

| Dữ liệu / hành động | Operation | Loại | Tần suất |
|---|---|---|---|
| Profiles của seller | Profiles API | Đọc | khi kết nối |
| Danh sách campaigns/keywords/budget | Sponsored Products/SB/SD **Campaigns v3** (`listCampaigns`, `updateCampaigns`…) | Đọc/**Ghi** | mỗi giờ / thao tác tức thời |
| Ghi ngân sách/bid/negative | `PUT /sp/campaigns` · `PUT /sp/keywords` · `POST /sp/negativeKeywords` (v3) | **Ghi** | ✅ *P3 13/09 (0021 · worker `ads:apply`, chỉ ghi yêu cầu ĐÃ duyệt)* |
| Metrics theo ngày (impressions, clicks, cost, sales7d/14d/30d, ACOS, ROAS, CTR, CPC…) | **Reporting API v3** — async: tạo report (`campaigns`, `targeting`, `searchTerms`, `advertisedProduct`, `purchasedProduct`) → nhận xong → tải về | Đọc | metrics hằng ngày; intraday theo giờ cho nhóm trọng yếu |
| Ngân sách cạn sớm | Ads notifications / budget usage | Đọc | trong ngày |

### Đầu ra cho dashboard
KPI: spend, ACOS, TACOS, đơn từ ads. Alert: `acos_over_target`, `budget_exhausted` → SOP-04, SOP-05.

**Trạng thái 13/09:** A1 ✅ (P1 · 0020) · A2 + A3 ✅ (P2 · 0021) · **phần 3 — ghi ngược lên Amazon + hàng đợi duyệt
> 30%/ngày + audit + REVERT 1 chạm ✅** (P3 · 0021, worker `worker:ads-apply`, cron `/api/cron/report-pull` bước 3).
Còn lại: A4 (bảng quyết định tuần — duyệt hàng loạt) và giờ cạn ngân sách (cần Amazon Marketing Stream).

**Effort:** A1–A3: 4 người-tuần (🟡) · A4: 1.5 người-tuần (🔵)

---

## MODULE 6 — TÀI CHÍNH & ĐỐI SOÁT 💰

### Màn hình

| # | Màn hình | Nội dung chính | Cấp |
|---|---|---|---|
| F1 | **Settlements** | Danh sách kỳ thanh toán (mỗi shop): kỳ, tổng thu, từng nhóm phí (referral/FBA/storage/ads…), tiền về. Drill vào 1 kỳ: mọi dòng tiền | 🟢 |
| F2 | **Financial events** | Dòng chi tiết lọc theo loại (Charge/Refund/ServiceFee/Adjustment…), ngày, SKU; append-only | 🟢 |
| F3 | **Bồi hoàn FBA (claims)** ✅ *đã build 12/09 (0015)* | Danh sách khoản nghi ngờ (đối chiếu tự động tồn vs thực nhận vs reimbursement) + trạng thái claim (to_claim/filed/approved) + giá trị | 🟡 |
| F4 | **Lợi nhuận SKU** ✅ *đã build 12/09 (0015)* | Bảng: doanh thu, phí Amazon (từ Fees API), giá vốn (VEXIM nhập), spend ads phân bổ, **lãi gộp & %**; sort tìm SKU lỗ | 🟡 |

### Ánh xạ API (đã kiểm chứng)

| Dữ liệu | Operation / Report | Loại | Tần suất / rate |
|---|---|---|---|
| Dòng tài chính | `listFinancialEvents`, `listFinancialEventGroups`, `listFinancialEventsByGroupId` — Finances API **v0** | Đọc | 0.5 rps/burst 30 — hàng đợi cẩn thận |
| Kỳ settlement chuẩn | Report `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2` (⚠️ *hiệu chỉnh 12/09: bản `…_FLAT_FILE` và `…_XML` đã bị Amazon deprecated; đã implement bản V2 trong `worker/src/reports/settlement.parser.ts`*) | Report | khi có kỳ mới |
| Sổ cái chi tiết | Report `GET_LEDGER_DETAIL_VIEW_DATA` | Report | hằng ngày |
| Bồi hoàn | Report `GET_FBA_REIMBURSEMENTS_DATA` | Report | hằng tuần |
| Phí theo SKU | `getMyFeesEstimates` (Product Fees, dùng chung Module 2) | Đọc | theo yêu cầu |

### Đầu ra cho dashboard
KPI: tiền về, phí, doanh thu chưa thanh toán, giá trị claim. Alert: lệch đối soát >1%. Task: SOP-09, SOP-10.

**Effort:** F1–F2: 2.5 người-tuần (🟢) · F3–F4: 3 người-tuần (🟡)

#### Ghi chú triển khai F3–F4 (12/09/2026)

- **Máy trạng thái F3** (migration `0015`, rộng hơn spec để phủ hết SOP-09):
  `suspected → to_claim → filed → approved → paid → closed`; `rejected → to_claim` khi nộp lại.
  Chuyển `filed` **bắt buộc có mã case Amazon**; `approve/reject/close` **bắt buộc có ghi chú** và
  chỉ vai trò `iam.is_finance_editor()` (trưởng phòng Tài chính) được làm; `paid` **bắt buộc có số tiền**.
  Worker chỉ được **refresh** khoản còn `suspected` — không được ghi đè việc con người đã xử lý.
- **Nguồn F3**: `GET_LEDGER_DETAIL_VIEW_DATA` (EventType/Reason/Disposition/Quantity) để phát hiện,
  `GET_FBA_REIMBURSEMENTS_DATA` để khớp tiền đã về (dedupe theo `reimbursement-id|sku|reason|amount-total`).
  Phân loại: `Receipts|VendorReturns` → `inbound_missing`; `CustomerReturns` → `lost_fc`/`damaged_fc`/`return_missing`;
  `Adjustments` → `lost_fc`/`damaged_fc`/`fee_error`/`other` (lý do `FOUND` không tính là claim).
- **F4**: `finance.sku_profit_daily` (PK shop+sku+ngày+tiền tệ), ghi kiểu **replace theo ngày** (không cộng dồn).
  `gross = ProductSale + ShippingCredit + Reimbursement + Refund + PromotionRebate + phí (âm) − giá vốn`;
  **ads_spend là cột riêng, không trừ vào lãi gộp** (Module 5 chưa đồng bộ → `NULL`, không mặc định 0).
  Thiếu giá vốn → `cogs`/`gross_profit` = **NULL** để web hiện “—” thay vì bịa số.
  `fee_source` ghi rõ `settled` (từ settlement) hay `fees_api` (ước tính Product Fees).

---

## MODULE 7 — SỨC KHỎE TÀI KHOẢN 🛡️

### Màn hình

| # | Màn hình | Nội dung chính | Cấp |
|---|---|---|---|
| H1 | **Health theo shop** | Mỗi shop: Account Health Rating, các rate (ODR, Late Shipment, Valid Tracking, Pre-fulfillment Cancellation), số vi phạm mở theo severity, KYC/document requests | 🟢 |
| H2 | **Chi tiết vấn đề** | Từng vi phạm: loại (IP/restricted/chất lượng), severity, trạng thái, người xử lý, link case; tài liệu đính kèm | 🟢 |

### Ánh xạ API (đã kiểm chứng)

| Dữ liệu | Operation / Report | Loại | Tần suất |
|---|---|---|---|
| Marketplace tham gia | `getMarketplaceParticipations` — Sellers API v1 | Đọc | khi kết nối + kiểm tra sức khỏe định kỳ |
| Toàn bộ chỉ số performance | Report **`GET_V2_SELLER_PERFORMANCE_REPORT`** (AHR, ODR, LSR, VTR, IP complaints, listing policy violations, document requests…) — ⚠️ *hiệu chỉnh 12/09: `GET_V1_…` là bản **XML** cũ (chỉ vài chỉ số, không có warningStates/AHR); bản V2 chính là dữ liệu Account Health dashboard, đã implement trong `worker/src/reports/seller-performance.parser.ts`* | Report | hằng ngày |
| Trạng thái tài khoản realtime | Notification **`ACCOUNT_STATUS_CHANGED`** (NORMAL/AT_RISK/DEACTIVATED) | Đọc | realtime |

### Đầu ra cho dashboard
Alert `account_health`, `odr_threshold` → SOP-08. KPI: số shop xanh/vàng/đỏ.

**Effort:** 1.5 người-tuần (🟢)

---

## TỔNG HỢP — THỨ TỰ BUILD & EFFORT

| Module | Màn hình | API chính | Đợt | Effort (người-tuần) |
|---|---|---|---|---|
| 0. Hạ tầng dùng chung | 5 | OAuth, Notifications, Reports, Feeds | 🟢 | 3 (đang làm) |
| 7. Account Health | 2 | Seller Performance Report, ACCOUNT_STATUS_CHANGED | 🟢 | 1.5 |
| 4. Đơn hàng & CSKH | 4 (+1 defer) | Orders v0, ORDER_CHANGE, All Orders report | 🟢 | 3 (+1.5) |
| 3. Kho vận & FBA (đọc) | 2 | FBA Inventory v1, aged report | 🟢 | 2.5 |
| 2. Giá & Featured Offer | 3 (+1) | Pricing v0 + 2022-05-01, Fees, patchListingsItem | 🟢 | 3 (+2) |
| 1. Listing (đọc + queue) | 3 | Listings Items, Merchant Listings reports | 🟢 | 3 |
| 6. Tài chính (đọc) | 2 | Finances v0, Settlement report | 🟢 | 2.5 |
| 6. Tài chính (claims + lợi nhuận) | 2 | Reimbursements, Ledger, Fees | 🟡 | 3 |
| 1. Listing (editor + publish) | 1–2 | patchListingsItem, Product Type Definitions, JSON_LISTINGS_FEED | 🟡 | 3 (+2 A+) |
| 3. Kho vận (inbound write) | 2 | Fulfillment Inbound 2024-03-20 ⚠️ cần role Amazon Fulfillment | 🟡 | 3 |
| 5. Quảng cáo | 3 (+1) | Ads Campaigns v3 + Reporting v3 | 🟡 | 4 (+1.5) |
| 4. CSKH (messaging defer) | 1 | Messaging/Solicitations ⚠️ role Buyer Communication | 🟡→🔵 | 1.5 |
| 2. Quy tắc giá tự động | 1 | tái sử dụng toàn bộ trên | 🔵 | 2 |

**Tổng:** 🟢 Đợt 1 ≈ **18.5 người-tuần** (đúng khung Cấp độ 1 với 2 fullstack + 1 backend ≈ 6–7 tuần) · 🟡 Đợt 2 ≈ 16.5 · 🔵 Đợt 3 ≈ 5.5

---

## QUYẾT ĐỊNH ĐÃ CHỐT ✅ (theo phương châm "tối ưu nhưng đầy đủ" — quyết định của team dev thay VEXIM)

| # | Vấn đề | Quyết định chốt |
|---|---|---|
| 1 | Danh sách màn hình | **Giữ đúng 21 màn Đợt 1** — không thêm, không bớt. Editor content (L3) ở Đợt 2: Đợt 1 phòng Listing dùng L1+L2+L4 (hiển thị + hàng đợi + checklist sửa, thao tác sửa tại Seller Central) |
| 2 | Role Amazon Fulfillment | **NỘP KÈM trong Developer Profile** (biến thể A, 497 ký tự). Nếu hồ sơ đã nộp thiếu role: đề nghị bổ sung ngay sau khi được duyệt, trước khi bắt đầu Đợt 2 |
| 3 | Log tin nhắn buyer (O5) | **Đợt 1: form nhập thủ công 30 giây/tin** (CSKH). **Đợt 2: inbound email parse tự động** (Postmark/Resend webhook → Supabase Edge Function → `buyer_messages`) |
| 4 | Giá vốn | **Import Excel/CSV theo template + nhập tay SKU lẻ** — lưu theo khoảng thời gian hiệu lực (bảng `catalog.cost_inputs`, migration 0003). API nội bộ: cân nhắc ở Đợt 3 · ✅ **ĐÃ XONG (Đợt A, 12/09)**: trang `/finance/costs` + template CSV tải trong app + import atomic (migration 0016) |
| 5 | Thứ tự build Đợt 1 | **0 → 7 → 4 → 3 → 1(đọc) → 2 → 6(đọc)** — Listing-đọc lên trước Giá (là dữ liệu nền SKU master cho Giá & Kho) |
| 6 | Doanh số 30 ngày · người phụ trách · giá trị tồn | ✅ **ĐÃ XONG (Đợt B, 12/09)** — migration `0017`: view `vexim_sku_sales_30d` (loại đơn huỷ, SKU không có đơn → NULL chứ không 0), `iam.module_owner()` (security definer vì RLS `iam.*` chỉ cho đọc chính mình; chỉ trả TÊN, không email/uuid), 7 cột nối cuối `vexim_pricing`/`vexim_listings`/`vexim_listing_queue`, 8 cột giá trị nối cuối `vexim_inventory_latest`, và sửa `effective_cost_row()` tra SKU không phân biệt hoa/thường |
| 7 | Phân bổ tồn theo FC · lịch sử nhận hàng (Module 3 nâng cao) | ✅ **ĐÃ XONG (12/09)** — migration `0018`: 2 bảng `inventory.fc_allocation` + `inventory.receipts` (khoá đúng theo report, RLS chỉ đọc, ghi qua 2 RPC service_role idempotent + cộng dòng trùng khoá), 4 view `security_invoker` (`vexim_inventory_fc`, `vexim_inventory_fc_rows`, `vexim_inventory_receipts`, `vexim_inbound_receipt_shipments` đối soát thực nhận vs số gửi của Inbound API), worker `inventory:fc` (parser đọc cột theo tên · ngày về ISO · dòng rác đếm `skipped`), I2/I4 hết placeholder. **Không cần thêm biến env**; Đợt 2 mới tự đặt lịch report qua Reports API (trần 4 giờ/lần với report daily) |
| 8 | Phí lưu kho theo FC · phí inbound noncompliance · tự động kéo Reports API (Module 3 nâng cao phần 2) | ✅ **ĐÃ XONG (12/09)** — migration `0019`: 3 bảng `finance.storage_fees` + `inventory.inbound_noncompliance` + `connections.report_requests` (khoá đúng theo report · RLS chỉ đọc · 3 RPC service_role idempotent nhận JSON camelCase · helper `num_or_null`/`bool_or_null` để giá trị lạ thành NULL chứ không đoán 0), 5 view `security_invoker` (`vexim_storage_fees` kèm `sku` suy ra + nhãn `sku_source`, `vexim_storage_fee_by_fc` nhóm theo shop × tháng × FC × **currency**, `vexim_inbound_issues`, `vexim_inbound_issue_shipments`, `vexim_report_requests`); engine Reports API (`createReport` → poll `getReport` → `getReportDocument` + gunzip) đặt trong `web/src/lib/worker/` để **Vercel Cron** `/api/cron/report-pull` (03:00 UTC) và CLI `npm run worker:reports-pull` dùng chung một bộ luật: cooldown **4 giờ/loại report**, đang chờ thì **poll tiếp reportId cũ** chứ không tạo mới, `DONE` rỗng → `no_data`, `FATAL`/`CANCELLED` → ghi lỗi, `--dry-run` không ghi gì. UI: overview *Phí lưu kho theo FC* · I2 *phí của SKU + chênh lệch kỳ* · I4 *cột phí/vấn đề + 3 panel* · Module 0 *Report đã kéo qua Reports API*. **Không thêm biến env** (dùng lại `AMAZON_LWA_*` + Supabase + `CRON_SECRET` đã có) |
| + | Buyer Communication, A+ (L5), auto-pricing (P4), MCF | **Defer đúng kế hoạch** 🟡/🔵 — không xin role/module trước khi có tính năng thật |

---

## PHỤ LỤC — NGUỒN TÀI LIỆU AMAZON ĐÃ DÙNG KIỂM CHỨNG

1. Listings Items API v2021-08-01 + patch `purchasable_offer` (audience bắt buộc): developer-docs.amazon.com/sp-api/docs/listings-items-api-v2021-08-01-reference
2. JSON_LISTINGS_FEED (25.000 message, thay flat-file): developer-docs.amazon.com/sp-api/docs/listings-feed-type-values
3. Product Pricing API v0 + rate limits điều chỉnh 2022 (getPricing 0.5/1, batch 20): developer-docs.amazon.com/sp-api/changelog/sp-api-throttling-adjustments
4. Product Pricing API v2022-05-01 `getCompetitiveSummary` + CompetitivePrice (thay CompetitivePriceThreshold từ 30/09/2025): developer-docs.amazon.com/sp-api/changelog (June 2025)
5. Pricing FAQ — FOEP batch 40 SKU, ANY_OFFER_CHANGED + PRICE_HEALTH: developer-docs.amazon.com/sp-api/docs/pricing-faq
6. Fulfillment Inbound API v2024-03-20 (đầy đủ operation + role Amazon Fulfillment): developer-docs.amazon.com/sp-api/docs/fulfillment-inbound-api
7. Role Mappings: developer-docs.amazon.com/sp-api/docs/role-mappings
8. Orders API v0 (getOrderAddress/BuyerInfo = restricted): developer-docs.amazon.com/sp-api/docs/orders-api-v0-reference
9. Seller Performance Report + ACCOUNT_STATUS_CHANGED: developer-docs.amazon.com/sp-api-blog/docs/ensuring-healthy-seller-account-status
10. Ads API Campaigns v3 + Reporting v3: advertising.amazon.com/API/docs/en-us
11. Finances API v0: developer-docs.amazon.com/sp-api/docs/finances-api-v0-reference
12. FBA Inventory API v1: developer-docs.amazon.com/sp-api/docs/fba-inventory-api-v1-reference
