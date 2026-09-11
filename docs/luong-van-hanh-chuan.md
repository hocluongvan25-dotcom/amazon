# LUỒNG VẬN HÀNH CHUẨN (SOP) — 12 QUI TRÌNH CỐT LÕI CỦA VEXIM OPS

> **Mục đích:** trả lời phản hồi của VEXIM — *"mới chỉ có thông tin tổng quan, chưa có luồng vận hành chi tiết thực tế cho từng công việc"*. Tài liệu này định nghĩa luồng chạy thật cho từng loại công việc hằng ngày: kích hoạt bằng gì → các bước → ai làm → dữ liệu từ API nào → SLA → khi nào đóng task → bàn giao phòng nào.
>
> **Thay đổi phạm vi:** theo phản hồi VEXIM, **hệ tác vụ chạy theo SOP được đưa từ Cấp độ 2 lên Cấp độ 1** (dashboard không chỉ "chỉ số" mà là "chỉ số → việc → từng bước").

---

## 0. NGUYÊN TẮC CHUNG CỦA MỌI LUỒNG

```
Cảnh báo (alert) ──► Tác vụ (task) ──► Các bước (steps) ──► Đóng task
     │                    │                  │
  tự động từ          gán người/           mỗi bước ghi audit:
  alert_rules         phòng + SLA          ai · lúc nào · kết quả gì
                                            │
                              bàn giao liên phòng = bước có nhiều phòng
```

1. **Mỗi cảnh báo đỏ/vàng sinh 1 task** theo template SOP tương ứng (bảng `ops.task_templates`).
2. **Task có tiến độ hiển thị dạng bước** (ví dụ "bước 3/8") — trưởng phòng nhìn 1 giây biết việc đang kẹt ở đâu, kẹt vì ai.
3. **Mỗi bước ghi vào `ops.task_events`** (audit trail) — không còn tình trạng "không biết ai đã xử lý gì".
4. **Bước ghi ra Amazon** (đổi giá, tạo shipment, chỉnh campaign) luôn có bước **duyệt** trước nếu vượt ngưỡng.
5. **SLA mặc định** theo SOP;_vp trưởng phòng chỉnh được theo shop/khách hàng.

---

## NHÓM KHO VẬN & FBA

### SOP-01 · Xử lý SKU sắp hết hàng ⏱ SLA: alert đỏ ≤ 24h có kế hoạch nhập

| | |
|---|---|
| **Kích hoạt** | Alert `stockout_risk` (days of cover < 14) |
| **Dữ liệu** | FBA Inventory API · report Sales & Traffic · Fulfillment Inbound |
| **Phòng** | Kho vận (chủ trì) · Tài chính (đối soát) · Khách hàng (xác nhận) |

| # | Bước | Ai | Dữ liệu / hành động | Xong khi |
|---|------|----|--------------------|----------|
| 1 | Xác nhận tốc độ bán 14 ngày (loại bỏ đột biến mùa vụ) | Kho vận | Sales & Traffic theo SKU | velocity chốt |
| 2 | Kiểm tra lô hàng đang về + ETA | Kho vận | FBA Inbound | còn thiếu = đề xuất nhập |
| 3 | Hệ thống tính đề xuất: velocity × (lead time + safety 14 ngày) − tồn − đang về | Tự động | kpi_daily + inventory_daily | số đề xuất hiện ra |
| 4 | Chốt số lượng + giá vốn với khách hàng | Kho vận | task liên quan client (nếu hợp đồng yêu cầu) | khách xác nhận |
| 5 | Trưởng phòng duyệt (giá trị lô > ngưỡng $) | Trưởng phòng Kho vận | màn duyệt trong hệ thống | duyệt xong |
| 6 | Tạo inbound shipment | Hệ thống → Amazon | **Fulfillment Inbound API** (role Amazon Fulfillment) | shipment_id sinh ra |
| 7 | Theo dõi vận chuyển & nhận hàng tại FC | Kho vận | inbound status | trạng thái CLOSED |
| 8 | Đối soát số nhận vs kế hoạch — thiếu/mất → mở **SOP-09** | Kho vận + Tài chính | đối chiếu | lệch = 0 hoặc đã mở claim |

### SOP-09 · Claim bồi hoàn FBA ⏱ chu kỳ hằng tuần

| | |
|---|---|
| **Kích hoạt** | Đối chiếu tồn (bước 8 của SOP-01) · rà tuần tự thứ Hai |
| **Dữ liệu** | FBA reports (Reimbursements, Ledger, Inventory Aged) |
| **Phòng** | Tài chính (chủ trì) · Kho vận |

| # | Bước | Ai | Xong khi |
|---|------|----|----------|
| 1 | Đối chiếu tồn báo cáo vs thực nhận từng lô | Tài chính | danh sách khoản nghi ngờ |
| 2 | Phân loại: mất tại FC · hư khi nhập · thu sai phí · mất khi trả hàng | Tài chính | phân loại xong |
| 3 | Ước tính giá trị từng khoản | Tài chính | tổng $ hiện ra |
| 4 | Nộp case trên Seller Central + đính kèm bằng chứng | Tài chính | case ID ghi vào hệ thống |
| 5 | Theo dõi case (48h không phản hồi thì đẩy) | Tài chính | có kết luận |
| 6 | Ghi nhận tiền về — đối chiếu Finances API (reimbursement events) | Tài chính + hệ thống | khớp số |
| 7 | Tổng hợp vào báo cáo khách hàng tuần (**SOP-12**) | Tài chính | đã đưa vào report |

## NHÓM GIÁ & QUẢNG CÁO

### SOP-02 · Giữ/lấy lại Featured Offer (Buy Box) ⏱ SLA: xử lý trong 4h giờ Mỹ

| | |
|---|---|
| **Kích hoạt** | Alert `buybox_lost` (từ ANY_OFFER_CHANGED / Pricing API) |
| **Dữ liệu** | Product Pricing API · Product Fees API · giá vốn nội bộ |
| **Phòng** | Kho vận/Giá (chủ trì) · PPC (nếu đổi chiến lược thay vì đua giá) |

| # | Bước | Ai | Dữ liệu / hành động | Xong khi |
|---|------|----|--------------------|----------|
| 1 | Xác nhận mất box thật (không phải gián đoạn ngắn) | Hệ thống | Pricing API, xác nhận 2 lần cách 30 phút | cảnh báo hợp lệ |
| 2 | Phân tích giá đối thủ + chênh lệch | Hệ thống | ANY_OFFER_CHANGED | chênh lệch rõ |
| 3 | Tính giá sàn = vốn + phí Amazon (Fees API) + biên tối thiểu | Hệ thống | fees_estimates + giá vốn | giá sàn hiện ra |
| 4 | **Rẽ nhánh:** đối thủ < giá sàn → KHÔNG đua giá, chuyển chiến lược (bundle, ads); ngược lại → đề xuất giá mới | Kho vận | quy tắc tự động | có phương án |
| 5 | Duyệt giá (giảm ≤2%: operator tự duyệt; >2%: trưởng phòng) | theo ngưỡng | màn duyệt + audit log | duyệt xong |
| 6 | Cập nhật giá lên Amazon | Hệ thống | pricing feed / JSON_LISTINGS_FEED | giá mới live |
| 7 | Xác nhận lấy lại box trong 1–2h + ghi precedent vào SOP | Kho vận | Pricing API | box xanh |

### SOP-04 · Tối ưu campaign ACOS vượt ngưỡng ⏱ SLA: phương án trong 24h

| | |
|---|---|
| **Kích hoạt** | Alert `acos_over_target` (ACOS 7 ngày > ngưỡng, ≥3 ngày liên tiếp) |
| **Dữ liệu** | Ads API: campaign metrics · search term report v3 |
| **Phòng** | PPC |

| # | Bước | Ai | Xong khi |
|---|------|----|----------|
| 1 | Xác nhận vượt ngưỡng (metrics 7 & 14 ngày) | Hệ thống | cảnh báo hợp lệ |
| 2 | Phân rã: campaign → ad group → keyword/target | PPC (tool hỗ trợ) | tìm được ổ lãng phí |
| 3 | Đọc search term report: từ khóa click cao · 0 đơn | PPC | danh sách từ khóa |
| 4 | Hệ thống gợi ý: negative keyword · giảm bid · giảm budget | Hệ thống (AI chỉ gợi ý) | gợi ý kèm tin cậy |
| 5 | Operator duyệt/chỉnh danh sách | PPC | danh sách chốt |
| 6 | Áp dụng lên Amazon | Hệ thống | **Ads API** ghi xong |
| 7 | Theo dõi 3–7 ngày | PPC | ACOS về ngưỡng |
| 8 | Chốt kết quả + cập nhật ngưỡng học được | PPC | ghi vào kpi_daily |

### SOP-05 · Campaign hết budget sớm ⏱ SLA: quyết định trước 10h giờ Mỹ

| # | Bước | Ai | Xong khi |
|---|------|----|----------|
| 1 | Xác nhận budget cạn trước 18h hôm trước (alert `budget_exhausted`) | Hệ thống | hợp lệ |
| 2 | Xem hiệu quả 7 ngày của campaign | PPC | phân loại tốt/xấu |
| 3 | Tốt → đề xuất tăng budget X% · Xấu → chuyển **SOP-04** | PPC | phương án |
| 4 | Duyệt (tăng >30%/ngày cần trưởng phòng) | theo ngưỡng | duyệt xong |
| 5 | Áp dụng + theo dõi chiều cùng ngày | Hệ thống + PPC | không cạn sớm nữa |

## NHÓM LISTING

### SOP-03 · Khôi phục listing inactive/stranded ⏱ SLA: SKU doanh thu cao ≤ 24h

| | |
|---|---|
| **Kích hoạt** | Alert `listing_inactive` · notification LISTINGS_ITEM_STATUS_CHANGE / ISSUES_CHANGE |
| **Dữ liệu** | Listings Items API · Merchant Listings Inactive report · Stranded report |
| **Phòng** | Listing (chủ trì) · Kho vận (nếu stranded do tồn) |

| # | Bước | Ai | Xong khi |
|---|------|----|----------|
| 1 | Xác định nguyên nhân (issues list từ Amazon) | Hệ thống | lỗi rõ (thuộc tính/ảnh/chính sách) |
| 2 | Soạn bản sửa trong draft của hệ thống | Listing | draft xong |
| 3 | Trưởng phòng duyệt nội dung | Trưởng phòng Listing | duyệt xong |
| 4 | Publish lên Amazon | Hệ thống | **Listings Items API (patch)** |
| 5 | Theo dõi 24h xác nhận active | Hệ thống | trạng thái ACTIVE |
| 6 | Stranded do tồn không trển → phối Kho vận xử lý tồn | Listing + Kho vận | SKU bán lại được |
| 7 | Lỗi lặp ≥3 lần → cập nhật checklist tạo listing mới | Trưởng phòng | SOP sống lại |

## NHÓM ĐƠN HÀNG & CSKH

### SOP-06 · Đơn FBM chờ xác nhận + tin nhắn người mua ⏱ SLA: trước cutoff ship · tin nhắn < 24h

| | |
|---|---|
| **Kích hoạt** | Queue realtime (ORDER_CHANGE) · log tin nhắn nội bộ *(SP-API không đọc hộp thư — v1.1)* |
| **Dữ liệu** | Orders API · buyer_messages (log nội bộ/email) |
| **Phòng** | Đơn hàng & CSKH |

| # | Bước | Ai | Xong khi |
|---|------|----|----------|
| 1 | Xác nhận đơn FBM theo thứ tự hạn (đếm ngược) | CSKH | 0 đơn quá hạn |
| 2 | Gửi vận đơn / cập nhật tracking | CSKH + hệ thống | tracking live |
| 3 | Trả lời tin nhắn theo template (giao chậm/đổi trả/hỏi sản phẩm) | CSKH | < 24h, ghi log |
| 4 | Khó → escalation trưởng phòng | Trưởng phòng | có hướng xử lý |
| 5 | Theo dõi ODR / Late Shipment / Valid Tracking vs ngưỡng hằng ngày | Hệ thống | alert nếu gần ngưỡng |

### SOP-07 · Feedback/Review xấu mới ⏱ SLA: phân loại trong 4h

| # | Bước | Ai | Xong khi |
|---|------|----|----------|
| 1 | Phân loại: sản phẩm / logistics / dịch vụ | CSKH | phân loại xong |
| 2 | Feedback vi phạm chính sách → yêu cầu gỡ (Messaging API `createNegativeFeedbackRemoval` khi có role Buyer Communication — hiện làm qua Seller Central) | CSKH | đã nộp yêu cầu |
| 3 | Liên hệ giải quyết buyer (đền/bớt/đổi) | CSKH | buyer phản hồi |
| 4 | Lỗi sản phẩm lặp ≥2 lần → mở task phòng Listing/nuôi hàng | Trưởng phòng CSKH | task mở |
| 5 | Ghi note nội bộ + theo dõi chỉ số feedback | CSKH | xong |

## NHÓM VẬN HÀNH & ACCOUNT HEALTH

### SOP-08 · Account Health rớt / vi phạm mới ⏱ SLA: nghiêm trọng ≤ 24h

| | |
|---|---|
| **Kích hoạt** | Notification `ACCOUNT_STATUS_CHANGED` · Seller Performance Report (AHR vàng/đỏ) |
| **Phòng** | Vận hành & Health (chủ trì) · phòng liên quan đến nguyên nhân |

| # | Bước | Ai | Xong khi |
|---|------|----|----------|
| 1 | Đọc chi tiết vi phạm + mức nghiêm trọng | Vận hành | rõ vấn đề |
| 2 | Phân loại: IP · hàng hạn chế · chất lượng · hiệu suất giao hàng | Vận hành | phân loại xong |
| 3 | Thu thập bằng chứng (hóa đơn, chứng nhận, nhật ký vận hành từ hệ thống) | Vận hành + phòng liên quan | bộ hồ sơ |
| 4 | Nộp appeal trên Seller Central | Vận hành | case mở |
| 5 | Theo dõi 48h/lần đẩy | Vận hành | có kết luận |
| 6 | Post-mortem + quy trình phòng ngừa (thêm alert/quy tắc nếu thiếu) | Trưởng phòng | SOP cập nhật |

### SOP-11 · Kết nối shop mới (onboarding) ⏱ SLA: < 48h từ authorize đến go-live

| # | Bước | Ai | Xong khi |
|---|------|----|----------|
| 1 | Gửi link "Kết nối Amazon" cho chủ shop | Vận hành | seller nhận link |
| 2 | Seller authorize (OAuth LWA) | Khách hàng | refresh token hợp lệ |
| 3 | Backfill 30 ngày + đăng ký notifications | Hệ thống | dữ liệu đủ |
| 4 | Nhập cấu hình: giá vốn, lead time, ngưỡng cảnh báo | Vận hành + Khách hàng | cấu hình xong |
| 5 | Gán phòng ban/nhân viên phụ trách | Trưởng phòng | assignments xong |
| 6 | Smoke test 8 dashboard + chạy 12 SOP rà nhanh | Vận hành | khớp Seller Central |
| 7 | Bàn giao vận hành chính thức | Vận hành | shop "active" |

### SOP-12 · Báo cáo khách hàng tuần ⏱ 8h sáng thứ Hai

| # | Bước | Ai | Xong khi |
|---|------|----|----------|
| 1 | Tự sinh báo cáo từ kpi_daily (doanh thu, ads, tồn, 3 hành động đề xuất) | Hệ thống | draft xong |
| 2 | Trưởng phòng kiểm duyệt | Trưởng phòng | duyệt xong |
| 3 | Gửi email khách + lưu vào `ops.client_reports` | Hệ thống | đã gửi |
| 4 | Ghi nhận phản hồi của khách vào tuần sau | Vận hành | xong |

## NHÓM TÀI CHÍNH

### SOP-10 · Đối soát kỳ settlement ⏱ 2h sáng hằng ngày (chốt KPI 6h sáng)

| # | Bước | Ai | Xong khi |
|---|------|----|----------|
| 1 | Kéo settlement report + All Orders của ngày trước | Hệ thống (pg_cron) | raw vào DB |
| 2 | Đối chiếu 3 nguồn: hệ thống vs settlement vs Seller Central | Hệ thống | báo cáo lệch |
| 3 | Đánh dấu lệch > 1% để điều tra | Tài chính | danh sách lệch |
| 4 | Lỗi hệ thống → sửa pipeline · Lỗi Amazon → mở case | Dev / Tài chính | xử lý xong |
| 5 | Chốt `kpi_daily` — 6h sáng dashboard có số chuẩn | Hệ thống | snapshot xong |

---

## ÁNH XẠ VÀO HỆ THỐNG (ĐÃ BỔ SUNG DATABASE)

| Thành phần DB | Vai trò |
|---|---|
| `ops.task_templates` (mới — migration 0002) | 12 SOP: mã, phòng, trigger rule, SLA, các bước (JSONB) |
| `ops.tasks` (+ cột `template_id`, `current_step`) | task thực tế sinh từ alert, chạy theo template |
| `ops.task_events` (mới) | audit từng bước: ai, lúc nào, kết quả, ghi chú |
| `ops.alerts` → sinh task | mỗi alert đỏ/vàng tự mở task theo mapping rule → SOP |

**Thứ tự ưu tiên triển khai (Cấp độ 1):** SOP-01, 02, 04, 06, 10 trước (chạm doanh thu/nguy cơ mỗi ngày) → 03, 05, 08, 11 → 07, 09, 12.
