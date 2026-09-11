# BẢN NHÁP HỒ SƠ AMAZON DEVELOPER PROFILE — v1.1 (đã soát theo review độc lập)

| | |
|---|---|
| **Mục đích** | Tư liệu hoàn chỉnh để **Nguyễn Hải Anh (PIC)** điền & bấm submit Developer Profile trên Seller Central |
| **Phiên bản** | **1.1** — đã đối chiếu với review của VEXIM và kiểm chứng lại bằng tài liệu chính thức của Amazon (Role Mappings, Merchant Fulfillment API, Messaging API). Thay thế toàn bộ v1.0. |
| **Kèm theo** | Landing page `landing/index.html` · Kiến trúc: `docs/de-xuat-trien-khai-he-thong-vexim.md` |

---

## 0. THAY ĐỔI CỦA v1.1 SO VỚI v1.0 — PIC ĐỌC PHẦN NÀY TRƯỚC

| # | Thay đổi | Lý do (đã kiểm chứng) |
|---|----------|----------------------|
| 1 | **Đổi toàn bộ tên role về tên chính thức của Amazon** (Inventory and Order Tracking, Product Listing, Pricing, Selling Partner Insights, Finance and Accounting, Amazon Fulfillment, Buyer Communication, Buyer Solicitation…) | Tên trong v1.0 là tên nghiệp vụ tự đặt — Amazon cấp quyền theo tên role chính thức |
| 2 | **Chuyển hẳn sang Phương án B: không xin bất kỳ role restricted nào lần đầu** | Role restricted (Direct to Consumer Shipping, Tax Invoicing, Tax Remittance) kích hoạt quy trình duyệt nghiêm ngặt: business verification + architecture review; kinh nghiệm cộng đồng cho thấy cộng thêm ~4–8 tuần. Nguyên tắc Amazon: role phải khớp tính năng thật |
| 3 | **Bỏ "Account Health API"** — tên API này không tồn tại độc lập trong SP-API | Dữ liệu sức khỏe tài khoản lấy qua **Selling Partner Insights**: báo cáo `GET_V1_SELLER_PERFORMANCE_REPORT` + notification `ACCOUNT_STATUS_CHANGED` |
| 4 | **Merchant Fulfillment API → Shipping API v2** (nếu làm Buy Shipping) | Amazon ghi rõ trong docs MF API: *"For new integrations, use the Shipping API v2 instead"*; các operation mua label cần role Direct to Consumer Shipping (Restricted) → hoãn |
| 5 | **Câu trả lời PII đổi sang "bản đầu không truy cập PII"** | Câu v1.0 hứa xử lý FBM/PII mà module chưa tồn tại → rủi ro bị hỏi lại chi tiết không demo được |
| 6 | **Câu "không chia sẻ dữ liệu" diễn đạt lại đúng mô hình agency** | "We never sell or share seller data" không đúng thực tế agency (nhân viên VEXIM phải truy cập dữ liệu theo ủy quyền của seller) |
| 7 | Bổ sung: Messaging API **chỉ gửi được** message theo template, không đọc được hộp thư | Amazon xác nhận chính thức trên GitHub — ảnh hưởng thiết kế dashboard CSKH (đã sửa tài liệu kiến trúc) |

---

## 1. THÔNG TIN TỔ CHỨC — VEXIM ĐIỀN (mục "Contact Information" trong form)

| Trường trong form | Giá trị cần điền | Trạng thái |
|---|---|---|
| Organization name | Tên pháp lý công ty VEXIM (đúng giấy phép KD) | ☐ VEXIM điền |
| Website URL | URL HTTPS của landing page sau khi deploy (vd `https://ops.vexim.vn`) | ☐ Chờ deploy |
| Country | Vietnam | ✔ |
| Primary contact | Nguyen Hai Anh + email + số điện thoại (email kiểm tra được 2 lần/ngày) | ✔ đã có PIC |
| Loại developer | **Public Developer** — "I build and offer publicly available applications that are used by other sellers" | ✔ chốt |

> **Lưu ý:** chọn đúng Public Developer ngay từ đầu. Đổi từ private → public sau này phải làm lại hồ sơ xét duyệt.

---

## 2. ROLES — BỘ NỘP LẦN ĐẦU (đã chốt theo review v1.1)

### 2.1. Bảng role chính thức

| Role chính thức của Amazon | API / dữ liệu chính | Tính năng VEXIM | Nộp lần này? |
|---|---|---|:---:|
| **Inventory and Order Tracking** | Orders API (đọc, không PII), FBA Inventory (đọc tồn kho), reports/notifications về đơn & tồn | Dashboard đơn hàng + tồn kho + cảnh báo hết hàng | ✅ **CÓ** |
| **Product Listing** | Listings Items, Catalog Items, Product Type Definitions, listing reports/feeds | Quản lý listing/SKU | ✅ **CÓ** |
| **Pricing** | Product Pricing, Product Fees, pricing reports/feeds | Giá, Featured Offer (Buy Box), biên lãi ước tính | ✅ **CÓ** |
| **Selling Partner Insights** | Sellers API, báo cáo `GET_V1_SELLER_PERFORMANCE_REPORT` | Marketplace participation + dashboard performance/sức khỏe tài khoản | ✅ **CÓ** |
| **Finance and Accounting** | Finances API + financial reports | Settlement, phí, đối soát, bồi hoàn | ✅ **CÓ** (MVP có dashboard tài chính) |
| **Amazon Fulfillment** | Fulfillment Inbound (tạo/theo dõi lô nhập hàng), Fulfillment Outbound, write-ops của FBA Inventory | Quản lý nhập hàng FBA (Cấp độ 2) | ⚠️ **VEXIM chốt** — khuyến nghị: CÓ (xem 2.3) |
| Buyer Communication | Messaging API (**chỉ gửi** theo template) | Gửi email buyer | ❌ Cấp độ 2+ |
| Buyer Solicitation | Solicitations API | Xin review/feedback | ❌ Chưa |
| Direct to Consumer Shipping **(Restricted)** | Shipping API v2 / labels, `getOrderAddress`, `getOrderBuyerInfo` (PII) | Mua label, địa chỉ buyer | ❌ Chưa — khi có module FBM thật |
| Tax Invoicing **(Restricted)** / Tax Remittance **(Restricted)** | Hóa đơn/thuế | — | ❌ Chưa |
| *Ngoài scope:* Professional Services (Restricted), Brand Analytics, Amazon Warehousing and Distribution | | | — |

### 2.2. Vì sao không xin role restricted lần đầu

1. Role restricted đưa hồ sơ vào quy trình duyệt **nhiềm giai đoạn**: business verification + architecture review (có thể phải demo screen-share).
2. Kinh nghiệm cộng đồng developer (GitHub amzn/selling-partner-api-models, 2026): restricted role "routinely adds 4-8 weeks" vào thời gian chờ.
3. Nguyên tắc của Amazon: role phải **khớp use case thật**. Version đầu của VEXIM Ops không có chức năng nào dùng PII/label/thuế.
4. Muốn thêm role sau: cập nhật Developer Profile → vòng duyệt bổ sung (bình thường, không phải hình phạt) — sẽ làm đúng lúc xây module tương ứng ở Cấp độ 2+.

### 2.3. Quyết định duy nhất còn bỏ ngỏ: Amazon Fulfillment

**Phân tích (dựa trên Role Mappings chính thức):**

- Dashboard tồn kho FBA Cấp độ 1 (`getInventorySummaries` — days of cover, cảnh báo hết hàng) **không cần** Amazon Fulfillment — đã nằm trong nhóm Inventory and Order Tracking / Product Listing.
- Amazon Fulfillment chỉ bắt buộc khi: tạo/theo dõi **inbound shipment** (Fulfillment Inbound API v2024-03-20) và write-ops FBA Inventory — theo lộ trình là **Cấp độ 2** (tháng 3–4).

**Khuyến nghị của đội dev: NỘP KÈM lúc này**, vì:
- ✅ Là role **không restricted** → không kéo theo architecture review, không làm chậm hồ sơ.
- ✅ Use case thật, dễ chứng minh: VEXIM là agency quản lý nhập hàng FBA hộ khách hàng — inbound là nghiệp vụ VEXIM đang làm tay từng ngày qua Seller Central, hệ thống chỉ số hóa nghiệp vụ đó.
- ✅ Nếu để sau: đúng lúc cần cho Cấp độ 2 lại phải chờ thêm vòng duyệt profile update — trùng đúng giai đoạn giao tính năng.

**Đánh đổi nếu bỏ:** hồ sơ tối giản tuyệt đối hơn ~1 dòng use case, nhưng tháng 3–4 phải đề nghị thêm role và chờ duyệt trong lúc đang cần ship tính năng. Không ảnh hưởng gì đến Cấp độ 1.

### 2.4. Ghi chú kỹ thuật về roles

- **Reports / Feeds / Notifications / Tokens API không phải role riêng** — chúng là cơ chế dùng chung; quyền thật phụ thuộc vào report type / feed type / notification type + role tương ứng.
- **Amazon Advertising API không nằm trong hồ sơ này** — đăng ký riêng tại advertising.amazon.com/API.
- **Fulfillment Outbound** (bán đa kênh MCF) **không trong scope** của VEXIM — không xin cho đủ.
- `getOrderAddress` / `getOrderBuyerInfo` của Orders API là **operation restricted (PII)** — đội dev sẽ chặn (blocklist) 2 endpoint này trong code cho đến khi được duyệt role Direct to Consumer Shipping.

---

## 3. CÁC CÂU TRẢ LỜI FREE-FORM v1.1 (đã đếm ký tự — giới hạn của Amazon là < 500)

### 3.1. "Describe your application and how it will use SP-API"

**Biến thể A — nếu chốt NỘP kèm Amazon Fulfillment** *(497 ký tự)*

> VEXIM Ops is a web-based operations platform built by VEXIM, a Vietnam-based agency that manages Amazon seller accounts for client businesses. Sellers authorize the application through Amazon OAuth. It retrieves orders, listings, FBA inventory and inbound shipments, pricing, seller performance and financial data to provide operational dashboards, stockout and pricing alerts, and reconciliation. Data is isolated by seller account and used only to provide authorized account management services.

**Biến thể B — nếu KHÔNG xin Amazon Fulfillment** *(471 ký tự)*

> VEXIM Ops is a web-based operations platform built by VEXIM, a Vietnam-based agency that manages Amazon seller accounts for client businesses. Sellers authorize the application through Amazon OAuth. It retrieves orders, listings, inventory, pricing, seller performance and financial data to provide operational dashboards, stockout and pricing alerts, and reconciliation. Data is isolated by seller account and used only to provide authorized account management services.

### 3.2. "How will your application use PII?" — **bản v1.1: không truy cập PII ở bản đầu** *(318 ký tự)*

> The initial release does not access buyer PII. If a future release requires buyer PII for authorized fulfillment or buyer communication workflows, VEXIM will request the applicable restricted roles, implement Restricted Data Token controls, and complete the required architecture review before enabling those features.

### 3.3. "What security measures do you have in place?" *(440 ký tự)*

> All traffic uses TLS; data is stored in PostgreSQL (Supabase) encrypted at rest. Login-with-Amazon refresh tokens are encrypted and stored in a secrets vault, accessible only server-side. We enforce multi-factor authentication, role-based access control with row-level security, full audit logging of all write actions, least-privilege access, and a documented incident-response runbook. Production access is limited to trained VEXIM staff.

### 3.4. "Data retention & deletion" *(285 ký tự — đã bỏ phần PII cho nhất quán với 3.2)*

> Operational data is retained while the selling partner's authorization is active. On revocation, OAuth tokens are deleted immediately and seller data is purged within 30 days, except where retention is legally required. The initial release does not access or store buyer personal data.

### 3.5. Câu chuẩn về chia sẻ dữ liệu (dùng ở bất kỳ mục nào hỏi về sharing) *(212 ký tự)*

> We do not sell seller data or share it with unrelated third parties. Authorized VEXIM personnel may access seller data only to provide the account management services explicitly authorized by the selling partner.

> ⚠️ **Nguyên tắc:** những gì viết trong form phải đúng sự thật đang triển khai. Câu 3.3 mô tả đúng kiến trúc sẽ build (TLS, Vault, RLS, audit log). Câu 3.2 cố tình không hứa PII vì module chưa tồn tại.

---

## 4. QUÁ TRÌNH SAU KHI BẤM SUBMIT — PIC CẦN BIẾT

| Giai đoạn | Việc | Ai |
|---|---|---|
| Ngay sau nộp | Nhận case ID qua Seller Central Case Log + email. **Check 2 lần/ngày (sáng/chiều)** như đã cam kết | PIC (Hải Anh) |
| Trong 5 ngày nếu Amazon hỏi thêm | Trả lời ngay trong 24h — quá 5 ngày không trả lời, case bị **đóng** và phải nộp lại từ đầu | PIC + dev hỗ trợ soạn |
| Nếu được mời **architecture review** | Với bộ role không-restricted này, khả năng gặp vòng này thấp; nếu có, demo theo sơ đồ kiến trúc mục 3 tài liệu đề xuất | Dev chính + PIC |
| Nếu bị từ chối | Đọc lý do, hiệu chỉnh, nộp lại — không ảnh hưởng vĩnh viễn | Dev + PIC |
| Khi được duyệt | Làm tiếp các bước mục 5 | Dev |

---

## 5. SAU KHI ĐƯỢC DUYỆT — CÁC BƯỚC KẾ TIẾP (đã làm rõ trình tự đúng)

1. Vào **Developer Central** trên Seller Central → **tạo ứng dụng** "VEXIM Ops" → gán đúng các role đã duyệt ở mục 2.
2. Khi tạo app, lấy **LWA credentials của app** (Client ID / Client Secret) — lưu vào biến môi trường server. *Lưu ý: đây là credentials của ứng dụng, dùng chung cho mọi seller; mỗi sellerauthorize sẽ sinh một refresh token riêng.*
3. Cấu hình **OAuth redirect URL** về domain hệ thống (callback `/api/amazon/callback`).
4. Kiểm thử từng API trong **sandbox nếu API đó hỗ trợ** (một số có static sandbox, một số có dynamic sandbox, một số nghiệp vụ không mô phỏng đầy đủ như production) — sau đó **pilot production với 1 seller được ủy quyền** (dùng shop pilot của VEXIM).
5. Kết nối **25 seller đầu tiên** (giới hạn OAuth authorization của app public chưa list — là giới hạn giai đoạn unlisted pilot, không phải giới hạn lâu dài; public developer phải list app lên Selling Partner Appstore theo quy định, lúc đó giới hạn được bỏ).
6. Đăng ký listing lên **Selling Partner Appstore** khi Cấp độ 1 ổn định.
7. Đăng ký **Amazon Ads API** riêng (nếu chưa xong ở tuần đầu).

---

## 6. CHECKLIST TRƯỚC KHI BẤM SUBMIT (v1.1)

- ✅ **Chốt Amazon Fulfillment: NỘP KÈM** (quyết định ngày 11/09 — "tối ưu nhưng đầy đủ") → dùng **biến thể A** (497 ký tự) ở mục 3.1. Nếu hồ sơ đã nộp mà thiếu role này: đề nghị bổ sung ngay sau khi được duyệt.
- ☐ VEXIM duyệt 5 câu trả lời free-form mục 3 (đảm bảo đúng sự thật)
- ☐ Landing page đã deploy HTTPS, đã thay email/điện thoại/địa chỉ/tên pháp lý thật (xem `landing/README.md`)
- ☐ PIC xác nhận lịch check Case Log 2 lần/ngày + thông báo ngày nộp cho đội dev

---

## PHỤ LỤC — NGUỒN KIỂM CHỨNG CHO CÁC THAY ĐỔI v1.1

1. Role Mappings (tên role chính thức & API映射): https://developer-docs.amazon.com/sp-api/docs/role-mappings
2. Merchant Fulfillment API — ghi chú "For new integrations, use the Shipping API v2 instead" + role restricted cho createShipment: https://developer-docs.amazon.com/sp-api/docs/merchant-fulfillment-api
3. Messaging API chỉ gửi được, không đọc hộp thư (Amazon xác nhận trên GitHub): https://github.com/amzn/selling-partner-api-models/discussions/3487
4. FBA Inventory Dynamic Sandbox Guide (FBA Inventory gắn role Inventory and Order Tracking / Product Listing): https://developer-docs.amazon.com/sp-api/docs/fba-inventory-api-v1-dynamic-sandbox-guide
5. ACCOUNT_STATUS_CHANGED notification + performance metrics (ODR, Late Shipment…): https://developer-docs.amazon.com/sp-api-blog/docs/ensuring-healthy-seller-account-status
6. Kinh nghiệm cộng đồng: restricted role cộng 4–8 tuần duyệt hồ sơ: https://github.com/amzn/selling-partner-api-models/discussions/5221
7. Selling Partner Insights / GET_V1_SELLER_PERFORMANCE_REPORT: https://developer-docs.amazon.com/sp-api/docs/roles-in-the-selling-partner-api
