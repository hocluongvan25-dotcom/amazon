# TÀI LIỆU TRAINING NHÂN VIÊN — VEXIM OPS · ĐỢT 1 (DEMO)

> **Phiên bản:** DEMO DATA · 11/09/2026
> **Đối tượng:** Toàn bộ nhân viên vận hành VEXIM (operator, trưởng phòng, ban điều hành) + khách hàng dùng Client Viewer
> **Thời lượng training đề xuất:** 90 phút (30 phút giới thiệu + 45 phút thực hành theo kịch bản + 15 phút hỏi đáp)
> **Đường dẫn:** Mở **VEXIM Ops** → trang Đăng nhập → chọn **DEMO MODE**
>
> 📌 *Bản DEMO dùng dữ liệu giả cố định để training quy trình. Khi hệ thống chuyển sang **SUPABASE MODE** (gắn shop Amazon thật + đồng bộ SP-API), giao diện và luồng thao tác sẽ **giữ nguyên 100%** — chỉ thay nguồn dữ liệu từ mock sang Amazon thật.*

---

## MỤC LỤC

1. [Làm quen trong 5 phút](#1-làm-quen-trong-5-phút)
2. [Tổng quan giao diện](#2-tổng-quan-giao-diện)
3. [Module 7 — Vận hành & Account Health (H1–H2)](#3-module-7--vận-hành--account-health)
4. [Module 4 — Đơn hàng & CSKH (O1–O4)](#4-module-4--đơn-hàng--cskh)
5. [Module 3 — Kho vận & FBA (I1–I4)](#5-module-3--kho-vận--fba)
6. [Module 1 — Listing & Nội dung (L1–L4)](#6-module-1--listing--nội-dung)
7. [Module 2 — Giá & Buy Box (P1–P3)](#7-module-2--giá--buy-box)
8. [Module 6 — Tài chính & Đối soát (F1–F2)](#8-module-6--tài-chính--đối-soát)
9. [Module 0 — Hạ tầng vận hành (chỉ Admin/CEO)](#9-module-0--hạ-tầng-vận-hành)
10. [Chuông thông báo + Trang cá nhân](#10-chuông-thông-báo--trang-cá-nhân)
11. [Kịch bản thực hành theo vai trò](#11-kịch-bản-thực-hành-theo-vai-trò)
12. [Quy tắc màu / chip / badge nhớ nhanh](#12-quy-tắc-màu--chip--badge-nhớ-nhanh)
13. [FAQ — Các lỗi thường gặp](#13-faq--các-lỗi-thường-gặp)

---

## 1. Làm quen trong 5 phút

### Cách vào hệ thống (DEMO MODE)

1. Mở link preview VEXIM Ops trên trình duyệt (khuyến nghị Chrome/Edge bản mới nhất).
2. Ở trang **Đăng nhập**, bạn không cần nhập email/mật khẩu. Chỉ cần nhấn nút **🟠 VÀO DEMO** (hoặc chọn 1 trong 4 vai trò mẫu bên dưới).
3. Bạn sẽ được đưa vào màn hình Tổng quan của vai trò đang chọn.

### 4 vai trò DEMO — chọn đúng khi training

| Vai trò (dropdown viền cam trên topbar) | Ai dùng | Thấy gì |
|---|---|---|
| 👑 **Ban điều hành VEXIM (CEO)** | Giám đốc, quản lý cấp cao | Toàn quyền — tất cả phòng ban, tất cả 14 shop, tất cả màn hình hạ tầng |
| 📦 **Trưởng phòng Kho vận & FBA** | Trưởng/Phó phòng Kho vận | Chỉ thấy module Kho vận, 9 shop có FBA |
| 📈 **Operator PPC** | Nhân viên quảng cáo | Chỉ thấy module Quảng cáo, 5 shop được gán |
| 🏢 **Client Viewer — Doanh nghiệp A** | Khách hàng | Chỉ đọc · chỉ 2 shop của doanh nghiệp mình, không thấy nội bộ VEXIM |

> 💡 **Mẹo demo:** Dropdown viền cam ở topbar cho bạn **chuyển vai trò tức thì** không cần đăng nhập lại. Dùng nó để kiểm chứng phân quyền khi training.

### Thử nghiệm phân quyền (phút thứ 5)

1. Đăng nhập với vai trò **Operator PPC**.
2. Gõ trực tiếp URL `/finance` vào thanh địa chỉ → bạn sẽ bị đá về Dashboard kèm banner đỏ "Bạn không có quyền truy cập trang này…".
3. Chuyển sang **CEO** → vào `/finance` bình thường.
4. Quay lại **Operator PPC** → sidebar chỉ hiện 2 mục: **Quảng cáo (PPC)** và **Trang cá nhân**.

*Mục đích:* Nắm được hệ thống **RBAC + RLS** hoạt động từ tầng giao diện đến tầng database → nhân viên sẽ không nhìn thấy dữ liệu ngoài phạm vi được giao.

---

## 2. Tổng quan giao diện

Hệ thống dùng 1 bộ khung (shell) duy nhất cho mọi vai trò:

```
┌──────────────────────────────────────────────────────────────┐
│  V  VEXIM Ops  [vai trò] [org] [shop] [range]  🔔(chuông) 👤 │  ← Topbar (sticky)
├──────────────┬───────────────────────────────────────────────┤
│              │  Breadcrumb · Page header                     │
│  📊 Tổng quan├───────────────────────────────────────────────┤
│  🛡️ Health   │                                               │
│  🏷️ Listing  │                                               │
│  💲 Giá      │          NỘI DUNG TRANG                       │
│  📈 PPC      │                                               │
│  📦 Kho vận  │                                               │
│  💬 Đơn hàng │                                               │
│  💰 Tài chính│                                               │
│  🏢 Client   │                                               │
│  ─────────── │                                               │
│  🔌 Kết nối  │                                               │
│  ❤️ Sync     │                                               │
│  🧮 API      │                                               │
│  🧾 Audit    │                                               │
│  👥 Users    │                                               │
│  ─────────── │                                               │
│  👤 Profile  │                                               │
└──────────────┴───────────────────────────────────────────────┘
```

### Các thành phần trên Topbar

| Thành phần | Dùng để làm gì |
|---|---|
| **V VEXIM Ops** (logo) | Nhấn → về Dashboard của vai trò hiện tại |
| **Dropdown vai trò** (viền cam) | Chỉ hiện ở **DEMO MODE** — dùng để chuyển vai trò, không có ở production |
| **Khách hàng** | Lọc theo khách hàng (phạm vi tổ chức). CEO có thể đổi; role khác bị khóa theo phân quyền |
| **Shop** | Lọc theo shop. Client chỉ thấy shop của mình; operator chỉ thấy shop được gán |
| **Khoảng thời gian** | Hôm qua / 7 ngày / 30 ngày — áp dụng cho mọi biểu đồ & bảng trên trang hiện tại |
| 🔔 **Chuông thông báo** | Xem cảnh báo realtime, đánh dấu đã đọc, nhảy đến trang xử lý (chi tiết tại mục 10) |
| 👤 **Avatar** | Nhấn → Trang cá nhân (không có nút đăng xuất cạnh avatar — đăng xuất nằm trong trang profile) |

### Sidebar — nguyên tắc nhóm

- **Dashboard**: Trang Tổng quan (chỉ CEO có).
- **Phòng ban**: 7 module chuyên môn — chỉ những module nhân viên được phân công mới hiện.
- **Khách hàng**: Client Viewer (cho khách hàng đăng nhập xem dữ liệu của riêng họ).
- **Hạ tầng vận hành**: 5 màn hình quản trị (kết nối shop, sức khỏe đồng bộ, API usage, audit log, người dùng & quyền) — **chỉ CEO thấy**.
- **Tài khoản**: Trang cá nhân — mọi vai trò đều có.

### Banner trạng thái (dưới topbar, nền xanh nhạt)

- 🔒 **Vai trò: … · DEMO MODE** → đang xem dữ liệu giả.
- 🔒 **Đăng nhập: {email} · SUPABASE MODE** → đang dùng dữ liệu thật từ Supabase.
- 🚨 Banner đỏ chỉ hiện khi bạn vào URL ngoài phạm vi quyền → tự động đá về sau 3 giây.

---

## 3. Module 7 — Vận hành & Account Health

> **Mục tiêu:** Theo dõi *sức khỏe tài khoản* toàn bộ shop theo thời gian thực — đây là module ưu tiên cao nhất vì vi phạm Amazon có thể dẫn đến khóa shop.

### H1. Health theo shop — `/health`

**Cách vào:** Sidebar → 🛡️ Vận hành & Health.

**Bạn sẽ thấy:**
- Hàng **KPI trên cùng**:
  - Tổng shop đang theo dõi
  - Số shop Critical / At Risk / Good
  - Tổng vi phạm đang mở theo severity (Critical / High / Medium / Low)
  - Thời gian phản hồi trung bình của team
- **Bảng Shop Health**: 1 dòng/shop với các chỉ số:
  - `AHR` (Account Health Rating) — Good / At Risk / Critical
  - `ODR` (Order Defect Rate) — ngưỡng 1%
  - `Late Ship` (Tỉ lệ giao trễ) — ngưỡng 4%
  - Cột **Trạng thái** có màu: 🟢 Good · 🟡 At Risk · 🔴 Critical
- **Bộ lọc**: theo shop, theo trạng thái, theo marketplace (US/MX/DE/CA).

**Thao tác:**
- Nhấn vào tên shop → nhảy sang H2 chi tiết các vi phạm của shop đó.
- Nhấn nút **Xuất CSV** (góc trên phải) để tải danh sách cho báo cáo tuần.

### H2. Chi tiết vấn đề đang mở — `/health/violations`

**Cách vào:** Từ H1 nhấn vào shop, hoặc sidebar → Vận hành & Health → tab *Vi phạm đang mở*.

**Bạn sẽ thấy:**
- Bảng liệt kê tất cả vi phạm đang mở với các cột:
  - `Loại` (Policy Warning / IP Complaint / ASIN Restricted / Late Ship Rate / …)
  - `Severity` — Critical / High / Medium / Low (màu đỏ/cam/xanh lá/xám)
  - `Shop`, `Opened` (ngày mở), `Trạng thái` (New / In progress / Appeal submitted / Resolved)
  - `Chủ phụ trách`, `Case ID` (mã vụ việc trên Amazon để đối chiếu)
- Bộ lọc: theo severity, shop, chủ phụ trách, SOP (SOP-08 Vi phạm tài khoản).

**Thao tác:**
- Nhấn vào dòng vi phạm → mở modal/panel chi tiết với:
  - Nguồn gốc cảnh báo (Amazon Notification / tự quét)
  - **Hướng xử lý theo SOP-08** (các bước appeal, mẫu email có sẵn)
  - Nút **Nhận xử lý** (gán cho tôi) / **Chuyển trưởng phòng**.
- Đếm ngược SLA: Critical ≤ 4h, High ≤ 24h, Medium ≤ 72h.

> ⚠️ **Lưu ý cho nhân viên:** Mọi thao tác trên vi phạm đều được ghi vào **Nhật ký thao tác** (audit log) — không xóa được.

---

## 4. Module 4 — Đơn hàng & CSKH

> **Mục tiêu:** Quản lý đơn AFN (FBA) / MFN (FBM), hàng đợi FBM phải giao đúng SLA, returns & refunds.

### O1. Danh sách đơn — `/orders`

**Cách vào:** Sidebar → 💬 Đơn hàng & CSKH.

**Các tab trên đầu:** Tất cả · Shipped · Pending · Cancelled · Delivered.
**Bộ lọc:** shop, channel (AFN/MFN), khoảng ngày, SKU/Order ID, trạng thái.
**Cột chính:** Mã đơn · Ngày · Channel · Số items · Tổng tiền · SKU chính · Shop · Trạng thái.

**Quy tắc PII:**
- Email/địa chỉ/số điện thoại người mua bị **KHÓA** (ô màu xám) trên bản danh sách — để xem chi tiết PII phải vào trang chi tiết đơn và có quyền CSKH (operator CSKH / dept_lead / CEO).
- Bấm vào mã đơn xem chi tiết (O2).

### O2. Chi tiết đơn — `/orders/detail?id=...`

**Nội dung chia 4 khối:**
1. **Thông tin đơn** (trạng thái, channel, ngày đặt, ngày giao dự kiến).
2. **Khối PII** (khóa mặc định với nhân viên không có quyền): họ tên, địa chỉ, điện thoại, email. Nhấn **🔓 Xem PII** để mở — thao tác này sẽ được ghi vào audit log.
3. **Danh sách SKU** trong đơn: ảnh, tên, ASIN, số lượng, giá.
4. **Timeline**: trạng thái vận chuyển (Ordered → Shipped → Out for delivery → Delivered) + tracking.
5. **Financials**: tổng giá hàng, phí ship, thuế, phí FBA, lợi nhuận ước tính.

### O3. Queue FBM (đếm ngược) — `/orders/fbm`

> 🚨 **Màn hình cấp bách — ưu tiên xử lý đầu ca.**

- Chỉ hiện các đơn MFN (FBM) chưa shipped có **thời gian đếm ngược SLA 24h** (Amazon yêu cầu xác nhận ship trong 24h).
- Các đơn quá hạn → đỏ · dưới 3h → cam · còn trên 6h → xanh lá.
- **Thao tác hàng ngày:**
  1. Mở `/orders/fbm` đầu ca làm việc.
  2. Lọc các đơn màu đỏ/cam trước.
  3. Nhấn **Xác nhận đã giao cho ĐVVC** → điền tracking ID → lưu.
  4. Hết ca kiểm tra lại — không để đơn nào quá giờ.

### O4. Returns — `/orders/returns`

- Bảng các đơn trả hàng: `Return ID` · Ngày · Order gốc · Mã lý do (theo mã chuẩn Amazon: DEFECTIVE, UNWANTED, WRONG_ITEM, …) · Shop · Trạng thái (Requested / Approved / Rejected / Refunded) · Tiền hoàn.
- Tab cần xử lý / đã duyệt / đã từ chối.
- Thao tác: **Duyệt hoàn** (Refund), **Từ chối** (kèm lý do để appeal nếu cần).

---

## 5. Module 3 — Kho vận & FBA

> **Mục tiêu:** Theo dõi tồn kho FBA theo thời gian thực, dự báo cover days, đề xuất nhập hàng, quản lý inbound shipment, đối soát hàng vào FC.
> **Căn cứ kỹ thuật:** Dữ liệu lấy từ *FBA Inventory Availability* notification + *Manage Inventory* report + *MYI report* phân bổ theo FC (xem thêm chi tiết trong `docs/phan-tich-ky-thuat-module-3-kho-van.md`).

### I1. Tồn theo SKU — `/fulfillment/inventory`

- **Bộ lọc:** shop, tình trạng (out / low / ok / aged), SKU/ASIN, phòng/người phụ trách.
- **Các cột chính:**
  - `SKU`, `ASIN`, `Shop`
  - `Fulfillable` (hiện có thể bán)
  - `Reserved` (đang chuyển/delivery hold)
  - `Inbound` (đang trên đường vào FC)
  - `Velocity` (đơn/ngày — trung bình 30 ngày)
  - `Cover days` = Fulfillable / Velocity (🔴 <7 ngày · 🟡 7–14 ngày · 🟢 ≥14 ngày)
  - `Đề xuất nhập` (số đơn vị cần đặt dựa trên lead time 30 ngày)
- Nút **Xuất CSV** để gửi NCC/mua hàng.
- Nhấn vào SKU vào chi tiết tồn (I2).

### I2. Chi tiết tồn — `/fulfillment/inventory/detail?sku=...`

Gồm 5 tab:
1. **Tổng quan**: tồn fulfillable/reserved/inbound/aged · velocity · cover · giá trị tồn kho.
2. **Phân bổ tồn kho 90 ngày**: biểu đồ cột số ngày hàng đã ở FC.
3. **Phân bổ theo FC**: bảng số lượng trên từng Fulfillment Center (ONT8, LAX9, …) → hữu ích phát hiện hàng kẹt tại 1 FC.
4. **Biên nhận / Receipts**: các lần nhận hàng gần đây (số lượng dự kiến / thực nhận / chênh lệch).
5. **Inbound đang về**: các shipment đang trên đường.

### I3. Kế hoạch nhập hàng (Restock) — `/fulfillment/restock`

> Chức năng quan trọng nhất của phòng Kho vận — theo SOP-01 Đặt hàng NCC.

- Hàng loạt SKU được đề xuất nhập dựa trên:
  - Cover days hiện tại
  - Lead time NCC mặc định 30 ngày
  - Tồn an toàn = velocity × 14 ngày
- **Cột:** SKU · Shop · Đề xuất nhập · Giá vốn · Giá trị đơn · Bước xử lý (Operator đề xuất / Trưởng phòng duyệt / Đã gửi NCC) · Chip trạng thái màu.
- Thao tác:
  - Operator: tick các dòng đề xuất → nhấn **Gửi duyệt**.
  - Trưởng phòng (lead_fulfill): tab *Chờ duyệt* → xem giá trị đơn → **Duyệt** hoặc **Từ chối (ghi lý do)**.
- ⚠️ **Đợt 1 chỉ đọc**: nút Tạo PO đổ NCC sẽ mở ở Đợt 2.

### I4. Inbound shipment — `/fulfillment/inbound`

- Bảng tất cả inbound shipment đang đi: Shipment ID · Shop · Trạng thái (WORKING / READY_TO_SHIP / SHIPPED / RECEIVING / CLOSED / CANCELLED — màu tương ứng) · Số units · FC đích · ETA · Biện nhận (đã nhận/đối soát xong/chênh lệch).
- Nhấn shipment ID xem chi tiết boxes, contents, reconciliation.

---

## 6. Module 1 — Listing & Nội dung

> **Mục tiêu:** Quản lý danh sách listing trên Amazon, xử lý listing bị lỗi/suppressed/stranded kịp thời theo SOP-03.

### L1. Danh sách listing — `/listing/list`

- **Bộ lọc:** shop, trạng thái (ACTIVE / INACTIVE / STRANDED / SUPPRESSED), loại lỗi (errors/warnings count), brand, tìm kiếm theo SKU/ASIN/title, sort theo doanh thu 30 ngày.
- **Cột:** SKU · ASIN · Tên sản phẩm · Shop · Brand · Trạng thái (badge màu) · Giá · Tồn · Số lỗi errors/warnings · Người phụ trách · Doanh thu 30 ngày · Cập nhật lần cuối.
- Nút **Xuất CSV** xuất danh sách kèm lỗi.
- Nhấn vào SKU vào trang chi tiết (L2).

### L2. Chi tiết listing — `/listing/detail?sku=...`

Gồm 5 phần:
1. **Header**: SKU · ASIN · trạng thái · flags BUYABLE/DISCOVERABLE · ngày tạo · ngày cập nhật cuối.
2. **Offer & Buy Box**: giá hiện tại, chúng ta có Buy Box không, số sellers trên listing.
3. **Thuộc tính sản phẩm**: bảng key-value theo product type (title, brand, bullet points, description, size, material…).
4. **Issues (lỗi)**:
   - Mã lỗi chuẩn Amazon (8541, 90220, 99010, …)
   - Severity ERROR/WARNING/INFO
   - Enforcement: LISTING_SUPPRESSED / SEARCH_SUPPRESSED / …
   - Mô tả + hướng sửa theo catalog.
5. **Lịch sử thay đổi**: ai sửa gì khi nào — từ Listing sync, từ Amazon, từ operator.

### L4. Hàng đợi inactive/stranded — `/listing/queue`

> Luồng xử lý chính cho team Listing theo **SOP-03 Stranded/Inactive SKU**.

Mỗi dòng hiển thị:
- SKU · ASIN · Shop
- **Nguyên nhân** (stranded reason hoặc error code, ví dụ `90220: MISSING_TITLE`)
- **Đề xuất sửa theo SOP-03** (vd: "Bổ sung product_description rồi relist theo SOP-03")
- **Chủ phụ trách**
- **SLA đếm ngược**: SKU doanh thu cao (≥$100/ngày) ≤ 24h (đỏ); SKU khác ≤ 72h (cam); không doanh thu (xám).
- Doanh thu/ngày (để ưu tiên xử lý hàng nào trước).

Thao tác:
- Nhấn **Nhận xử lý** → chuyển sang tab *Đang xử lý của tôi* → sau khi sửa trên Seller Central → nhấn **Đã sửa, chờ Amazon phản hồi**.

---

## 7. Module 2 — Giá & Buy Box

> **Mục tiêu:** Theo dõi giá trên từng SKU, đảm bảo không bán dưới giá sàn (floor price), duy trì Featured Offer (Buy Box), và duyệt các đề xuất đổi giá tự động theo phân cấp (SOP-02 Phê duyệt giá).
> **Căn cứ công thức:** floor price = vốn + referral fee + FBA fee + biên tối thiểu. Đề xuất đổi giá FOEP đi theo giới hạn 2% operator / >2% trưởng phòng.

### P1. Bảng giá — `/pricing`

- **Bộ lọc:** shop, tình trạng Buy Box (holding / at_risk / lost / no_box), margin dưới sàn, SKU/ASIN, tìm kiếm.
- **Các cột:** SKU · ASIN · Shop · Tên · Giá hiện tại · FOEP (Featured Offer Expected Price — giá Amazon đề xuất để lấy box) · Độ lệch FOEP · Giá sàn · Biên hiện tại (%) · Tình trạng Buy Box · Số đối thủ · Velocity 30 ngày (đơn/ngày) · Lần đổi giá cuối · Phụ trách.
- **Màu tình trạng:**
  - 🔴 **Mất box** / Dưới sàn
  - 🟡 **Có rủi ro** (margin quá thấp / FOEP thấp hơn sàn)
  - 🟢 **Giữ box**, margin OK
- Nhấn dòng → chi tiết giá (P2).

### P2. Chi tiết giá — `/pricing/detail?sku=...`

- Biểu đồ **30 ngày giá**: giá chúng ta · giá Buy Box · giá đối thủ thấp nhất (cùng fulfillment).
- **Offers đối thủ**: bảng seller (Amazon.com / chúng ta / seller khác), fulfillment (FBA/FBM/AMZ), giá landed, rating số feedback, đang hold box không.
- **Breakdown giá sàn**: giá vốn · referral fee % và $ · FBA fee · other fees · biên tối thiểu % · giá sàn cuối cùng.
- **Cảnh báo**: nếu giá hiện tại dưới sàn → đỏ cảnh báo KHÔNG DUYỆT.

### P3. Duyệt & áp giá — `/pricing/approve`

Hệ thống Pricing engine tự động sinh đề xuất đổi giá (theo FOEP, theo đối thủ, theo tồn kho):
- Đề xuất ≤ 2% so với giá hiện tại → **Operator tự duyệt** (cột "Người duyệt" sẽ ghi tên operator).
- Đề xuất > 2% → phải **Trưởng phòng duyệt** (trạng thái chờ duyệt, màu cam).
- Đề xuất đưa giá **dưới sàn** → KHÓA, không cho duyệt, cảnh báo đỏ.

**Thao tác:**
1. Vào `/pricing/approve`.
2. Tab **Chờ tôi duyệt**:
   - Operator thấy các đề xuất ≤ 2% cho mình.
   - Trưởng phòng thấy tất cả đề xuất > 2% phòng mình.
3. Xem lý do thay đổi (auto-follow-foep / manual / raise-to-floor).
4. Nhấn **Duyệt** (sẽ push giá lên Amazon sau khi sync worker chạy) hoặc **Từ chối** (ghi lý do).
5. Tab **Lịch sử duyệt** để đối chiếu khi có tranh chấp.

---

## 8. Module 6 — Tài chính & Đối soát

> **Mục tiêu:** So sánh số dư nội bộ VEXIM với Amazon Settlement, đối soát các khoản phí, xem chi tiết financial events theo từng shop/từng SKU — theo SOP-10 Đối soát settlement.
> **Căn cứ:** Dung sai đối soát 1% (chênh lệch dưới 1% được chấp nhận).

### F1. Danh sách kỳ settlement — `/finance/settlements`

- **Bộ lọc:** shop, trạng thái (deposited / processing / open), khoảng ngày bắt đầu/kết thúc.
- **Các cột:** Settlement ID · Shop · Ngày dự kiến chuyển về · Kỳ (start → end) · Trạng thái · Tổng bán · Hoàn tiền · Tổng phí Amazon · Phí quảng cáo · Khác · **Thực nhận** (số tiền về tài khoản) · Tiền tệ · Tài khoản nhận.
- Chip trạng thái: 🟢 Deposited · 🟡 Processing · ⚪ Open.
- Nhấn dòng → chi tiết kỳ.

### F1. Chi tiết kỳ settlement — `/finance/settlements/detail?id=...`

3 phần chính:
1. **Tổng quan kỳ:** tổng bán, hoàn, phí, ads, adjustments, reimbursement, transfer amount, dung sai so với nội bộ.
   - Nếu chênh lệch dưới 1% → 🟢 *Khớp theo SOP-10*
   - Nếu 1–3% → 🟡 *Cần rà*
   - Nếu trên 3% → 🔴 *Cần đối soát ngay*
2. **Phân loại nhóm phí:** Product Sales · Shipping Credits · Refunds · Referral Fees · FBA Fees · Storage Fees · Advertising Fees · Reimbursements · Adjustments · Subscription · Reserve Hold — mỗi nhóm có số tiền âm/dương và take rate % theo doanh thu.
3. **Breakdown theo SKU**: top SKU có net cao nhất/thấp nhất — tìm các SKU bị lỗ do phí ẩn.

### F2. Financial events — `/finance/events`

- Dòng thời gian tất cả events tài chính theo thời gian thực (khi Amazon ghi vào settlement), không đợt chờ settlement đóng kỳ.
- **Bộ lọc:** loại event (ProductSale / ReferralFee / FBAFee / StorageFee / AdvertisingFee / Reimbursement / Refund / Adjustment / Subscription / ServiceFee / Reserve / ShippingCredit), shop, order ID, SKU, khoảng ngày.
- Tổng hợp đầu bảng: tổng tiền vào / tiền ra / net trong khoảng lọc.
- Dùng cho đối soát từng khoản vãng lai (vd: tại sao bị trừ phí SAFE-T? → lọc Adjustments + shop + ngày).

---

## 9. Module 0 — Hạ tầng vận hành (CHỈ CEO/Admin)

> ⚠️ Tất cả nhân viên không phải admin sẽ không thấy nhóm này trên sidebar. Nếu gõ trực tiếp URL sẽ bị chặn và ghi audit log.

### 0.1 Kết nối shop — `/module0/connect`

Wizard 5 bước kết nối seller Amazon mới qua SP-API OAuth:
1. **Chọn marketplace** (US / MX / DE / CA / …).
2. **Điều kiện tiên quyết** (developer profile, Seller Central admin access, …) — checklist.
3. **OAuth Authorize** chuyển sang Amazon → cấp quyền → redirect về.
4. **Chạy test kết nối**: lấy token, test gọi 1 endpoint.
5. **Gán phụ trách**: chọn phòng ban + nhân viên được thao tác shop.

### 0.2 Sức khỏe đồng bộ — `/module0/sync-health`

Hiển thị tất cả sync jobs (inventory, pricing, listing, orders, ads, finance, health) theo 3 tầng:
- 🟢 Tier 1: Notification (webhook realtime Amazon push).
- 🟡 Tier 2: Polling API định kỳ (vd 15 phút 1 lần).
- 🔴 Tier 3: Report parser chênh lệch (chạy hàng ngày, quét lệch dữ liệu).
Mỗi job có: trạng thái (running/done/failed/pending), lần chạy cuối, độ trễ, số lần retry.

### 0.3 Mức dùng API — `/module0/api-usage`

Theo dõi calls/ngày theo nhóm API (Orders / Listings / Pricing / Reports / FBA Inventory / …) đối với quota SP-API (Amazon giới hạn calls/second theo loại). Dùng để cảnh báo trước khi bị Amazon throttle.

### 0.4 Nhật ký thao tác — `/module0/audit-log`

Append-only log — KHÔNG xóa, KHÔNG sửa được. Cột: Thời gian · Người thao tác · Module · Hành động · Đối tượng · Thay đổi (JSON) · Kết quả (ok/error).
Dùng để đối chiếu khi xảy ra lỗi nghiệp vụ, khiếu nại khách hàng, hoặc điều tra.

### 0.5 Người dùng & phân quyền — `/module0/users`

- Bảng tất cả nhân viên + client users: Họ tên · Email · Vai trò · Phòng · Shop được gán · Trạng thái (active / invited).
- Nút **＋ Tạo người dùng** → vào `/module0/users/new`:
  - Điền họ tên / email / số điện thoại.
  - Chọn vai trò (super_admin / org_admin / dept_lead / operator / analyst / client_viewer).
  - Nếu không phải super_admin → chọn phòng ban.
  - Chọn shop được gán (super_admin có sẵn mọi shop).
  - Checkbox gửi email mời đặt mật khẩu.
- **Phân cấp quyền (quan trọng):**
  - super_admin (chỉ 1–2 người sáng lập/CTO) → tạo được mọi role.
  - org_admin → không được tạo super_admin, không được nâng quyền mình.
  - dept_lead → chỉ tạo operator/analyst trong phòng mình.
  - operator / analyst / client_viewer → không tạo được ai.

---

## 10. Chuông thông báo + Trang cá nhân

### 🔔 Chuông thông báo

- Badge đỏ hiện số cảnh báo chưa đọc (tối đa 99+).
- Nhấn vào chuông → sổ panel phải:
  - Header: **Thông báo** + nhãn **● LIVE DB** (màu xanh) / **DEMO** (màu cam) + nút ↻ tải lại + *Đánh dấu đã đọc*.
  - Mỗi dòng thông báo: icon 🚨 (đỏ) / ⚠️ (cam) / ✅ (xanh lá), tiêu đề, mô tả ngắn (shop + chi tiết), thời gian tương đối ("12 phút trước"), chấm màu cho chưa đọc.
  - Nhấn vào thông báo → chuyển thẳng đến trang xử lý tương ứng (trang vi phạm, hàng FBM trễ, duyệt giá,…).
  - Link cuối panel: *Xem tất cả cảnh báo & sức khỏe hệ thống →* dẫn vào `/health`.
- **Mark read:** Khi bạn mở panel, hệ thống tự đánh dấu ack các cảnh báo đang mở (đổi badge thành đã đọc).

### 👤 Trang cá nhân — `/profile`

- Mọi vai trò đều xem được, chỉ bạn và admin mới thấy trang này.
- Các khối:
  1. **Header**: ảnh đại diện (default 2 chữ cái đầu tên), họ tên, email, các chip (vai trò · phòng · trạng thái 2FA).
  2. **Thông tin cá nhân**: họ tên, email, điện thoại, vai trò, phòng ban, ngày tham gia, đăng nhập cuối. Nút **✏️ Chỉnh sửa thông tin** cho phép đổi họ tên/số điện thoại tại chỗ.
  3. **Bảo mật**: 2FA (bật/tắt — chờ bản sau), **Gửi link reset mật khẩu**, quản lý phiên đăng nhập (chờ bản sau).
  4. **Tùy chọn**: ngôn ngữ (Tiếng Việt), múi giờ, tiền tệ hiển thị (USD), tùy chọn email cảnh báo.
  5. **Phiên làm việc hiện tại**: chế độ (DEMO / SUPABASE), vai trò đang xem, user ID.
  6. **Đăng xuất** (panel đỏ ở cuối): ấn để đăng xuất khỏi thiết bị này.

> ⚠️ **Không có nút đăng xuất cạnh avatar** — phải vào trang `/profile` mới đăng xuất được.

---

## 11. Kịch bản thực hành theo vai trò

### 🎯 Kịch bản A — CEO/Admin (toàn quyền), 20 phút

1. Vào DEMO với vai trò **Ban điều hành**.
2. Mở 📊 Tổng quan → xem 8 KPI chính → click 1 KPI vào module tương ứng.
3. Vào 🛡️ Health → nhấp 1 shop Critical → xem chi tiết vi phạm H2.
4. Mở chuông 🔔 → xem 7 thông báo mẫu → nhấp "ODR vượt ngưỡng 1%" vào trang vi phạm.
5. Vào 💰 Tài chính → Settlement → xem kỳ mới nhất → xem breakdown SKU.
6. Vào 👥 Người dùng → Tạo người dùng mới → thử chọn vai trò dept_lead, chọn phòng Kho vận, chọn 3 shop → *Lưu* (thành công với thông báo xanh).
7. Vào 👤 Trang cá nhân → đổi họ tên/số điện thoại → Lưu → xem chip "DB connected".
8. Vào /profile → Đăng xuất (chuyển sang form đăng nhập).

### 🎯 Kịch bản B — Trưởng phòng Kho vận, 15 phút

1. Chuyển vai trò sang **Trưởng phòng Kho vận**.
2. Kiểm tra sidebar: chỉ còn Tổng quan (nếu được xem), Kho vận & FBA, Trang cá nhân.
3. Vào 📦 Kho vận → Tồn → lọc cover <7 ngày → xem SKU sắp hết.
4. Vào Restock → tab Chờ duyệt → duyệt 1 đề xuất.
5. Vào Inbound → xem shipment đang đi ETA gần nhất.
6. Thử gõ `/finance` trên URL → bị chặn (banner đỏ).

### 🎯 Kịch bản C — Operator PPC, 15 phút

1. Chuyển sang **Operator PPC**.
2. Sidebar chỉ còn Quảng cáo + Trang cá nhân.
3. Vào 📈 PPC → xem chiến dịch hết budget mẫu.
4. Thử vào `/module0/users` → bị chặn.
5. Mở profile → xem vai trò "Operator PPC — 5 shop được gán".

### 🎯 Kịch bản D — Client Viewer, 10 phút

1. Chuyển sang **Client Viewer**.
2. Sidebar chỉ còn Client Viewer + Trang cá nhân.
3. Vào 🏢 Client → chỉ thấy 2 shop của doanh nghiệp A, không có link đến các phòng ban nội bộ.
4. Thử vào `/health`, `/finance` → đều bị chặn.

---

## 12. Quy tắc màu / chip / badge nhớ nhanh

| Màu | Nghĩa |
|---|---|
| 🔴 Đỏ | Critical / quá hạn / dưới sàn / mất box / lỗi nghiêm trọng — xử lý NGAY |
| 🟠 Cam (amber) | Warning / sắp đến hạn / rủi ro — xử lý trong ca |
| 🟢 Xanh lá | Good / OK / đã giải quyết / đã duyệt |
| 🔵 Xanh dương | Thông tin / link / vai trò |
| ⚪ Xám | Không hoạt động / tắt / chưa áp dụng |
| 🟣 Tím | Brand accent (VEXIM) — nút thao tác chính |

**Badge trạng thái đơn/shipment/listing:** dùng màu theo trạng thái, không cần học thuộc văn bản — xem màu là biết việc có gấp không.

**Chấm xanh ● LIVE DB / chấm cam DEMO** ở chuông thông báo:
- ● LIVE DB = dữ liệu từ Supabase/Amazon thật.
- DEMO = đang xem dữ liệu giả dùng cho training.

---

## 13. FAQ — Các lỗi thường gặp

**Q1. Tôi vừa gõ URL `/finance` nhưng bị đá về Dashboard với banner đỏ?**
A. Bạn không có quyền xem module đó. Kiểm tra lại vai trò đang chọn ở dropdown viền cam (DEMO MODE) hoặc liên hệ admin nếu ở SUPABASE MODE để được cấp quyền.

**Q2. Tôi thấy thông báo "không có dữ liệu" trong một bảng?**
A. Ở DEMO MODE điều đó không xảy ra (đã seed đủ dữ liệu). Ở SUPABASE MODE:
- Kiểm tra bộ lọc shop/khoảng thời gian đang chọn.
- Kiểm tra bạn có được gán shop đó không.
- Vẫn trống → báo admin xem sync job tại `/module0/sync-health`.

**Q3. Nhấn chuông nhưng panel không sổ xuống?**
A. Hard refresh (Ctrl+Shift+R) — có thể trình duyệt giữ JS cũ. Nếu vẫn lỗi vào `/diag` chụp màn hình gửi đội kỹ thuật.

**Q4. Tôi nhấn "Đổi ảnh đại diện" / "Cài đặt 2FA" / "Quản lý phiên" mà bị disabled?**
A. Các chức năng này sẽ mở ở bản sau. Đợt 1 đã hoạt động: chỉnh sửa thông tin cơ bản, gửi link reset mật khẩu, đăng xuất, toàn bộ các module đọc dữ liệu/phê duyệt giá/nhận xử lý vi phạm.

**Q5. DEMO MODE và SUPABASE MODE khác gì? Tôi đang ở mode nào?**
A. Xem banner dưới topbar:
- Viền cam + chữ DEMO MODE → dữ liệu giả (dùng để training).
- Viền xanh + chữ SUPABASE MODE → dữ liệu thật từ Supabase + SP-API.
Cách hoạt động và giao diện **hoàn toàn giống nhau** — chỉ khác nguồn dữ liệu.

**Q6. Tôi tạo nhầm user / muốn đổi vai trò nhân viên?**
A. Vào `/module0/users` → click dòng nhân viên → đổi vai trò/phòng/shop. Lưu ý phân cấp: bạn không thể nâng quyền người khác lên cao hơn quyền của chính mình. Audit log sẽ ghi lại mọi thay đổi.

**Q7. Làm sao đăng xuất?**
A. Vào sidebar → Trang cá nhân → lăn xuống panel đỏ cuối trang → **Đăng xuất**. (Không có nút đăng xuất ở topbar để tránh nhấn nhầm.)

---

## PHỤ LỤC — Tóm tắt 21 màn hình Đợt 1 theo luồng xử lý

| # | Màn | Đường dẫn | Vai trò chính thao tác |
|---|---|---|---|
| 1 | Đăng nhập & chọn vai trò | `/login` | Tất cả |
| 2 | Tổng quan CEO | `/dashboard` | CEO |
| 3 | Health theo shop (H1) | `/health` | CEO, Trưởng phòng Ops |
| 4 | Vi phạm chi tiết (H2) | `/health/violations` | Operator Ops, Lead Ops |
| 5 | Danh sách đơn (O1) | `/orders/list` | CSKH, CEO |
| 6 | Chi tiết đơn (O2) | `/orders/detail` | CSKH |
| 7 | Queue FBM đếm ngược (O3) | `/orders/fbm` | CSKH (ưu tiên hàng ngày) |
| 8 | Returns (O4) | `/orders/returns` | CSKH |
| 9 | Tồn kho SKU (I1) | `/fulfillment/inventory` | Kho vận |
| 10 | Chi tiết tồn kho (I2) | `/fulfillment/inventory/detail` | Kho vận, Mua hàng |
| 11 | Kế hoạch nhập hàng (I3) | `/fulfillment/restock` | Lead Kho vận, Mua hàng |
| 12 | Inbound shipment (I4) | `/fulfillment/inbound` | Kho vận |
| 13 | Danh sách listing (L1) | `/listing/list` | Listing |
| 14 | Chi tiết listing (L2) | `/listing/detail` | Listing |
| 15 | Hàng đợi inactive/stranded (L4) | `/listing/queue` | Listing (ưu tiên theo SLA) |
| 16 | Bảng giá & Buy Box (P1) | `/pricing` | Pricing |
| 17 | Chi tiết giá (P2) | `/pricing/detail` | Pricing, Lead Pricing |
| 18 | Duyệt giá (P3) | `/pricing/approve` | Operator ≤2% · Lead >2% |
| 19 | Danh sách settlement (F1) | `/finance/settlements` | Tài chính |
| 20 | Chi tiết settlement (F1 detail) | `/finance/settlements/detail` | Tài chính |
| 21 | Financial events (F2) | `/finance/events` | Tài chính, Đối soát |

*Ngoài ra còn các trang hỗ trợ không tính trong 21 màn chính: Trang cá nhân `/profile`, Chuông thông báo (global), 5 trang hạ tầng admin, Client Viewer `/client`, Trang chẩn đoán `/diag` (sẽ xóa sau khi bàn giao).*

---

*Tài liệu sẽ cập nhật theo từng đợt triển khai. Mọi thắc mắc trong quá trình training vui lòng liên hệ đội kỹ thuật VEXIM.*
