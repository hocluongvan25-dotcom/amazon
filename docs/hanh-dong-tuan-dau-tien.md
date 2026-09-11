# KẾ HOẠCH HÀNH ĐỘNG TUẦN ĐẦU TIÊN — VEXIM

> Trích từ đề xuất triển khai v1.0 (mục 7 — Cấp độ 0). Tài liệu này tách riêng để VEXIM bắt tay làm **ngay trong tuần này**, không cần chờ thống nhất toàn bộ.

> ✅ **Cập nhật Day 0 — đã chốt với VEXIM:** PIC hồ sơ: **Nguyễn Hải Anh** (check Case Log/email 2 lần/ngày) · Tài khoản Seller Central Professional đã sẵn sàng · Shop pilot + Checklist 12 mục: hoàn thành trước **Ngày 5** · Team dev bàn giao **Landing Page** (`landing/index.html`) và **bản nháp use case/PII** (`docs/ho-so-developer-profile-ban-nhap.md`) đúng hạn **Ngày 3**.

---

## ⚠️ VIỆC KHẨN CẤP SỐ 1 — NỘP HỒ SƠ AMAZON DEVELOPER PROFILE

**Đăng ký "Public Developer" cho Selling Partner API (SP-API).**

### Tại sao phải là việc đầu tiên, trước mọi việc khác?

1. **Đây là gốc rễ của hệ thống** — không có sự duyệt này của Amazon thì không kết nối được API thật với bất kỳ tài khoản seller nào, mọi thứ khác đều phải chờ nó.
2. **Amazon xét duyệt mất 2–8 tuần, hoàn toàn ngoài kiểm soát của ta** — nộp muộn 1 tuần là go-live muộn 1 tuần. Đây là "đường găng" (critical path) của toàn bộ dự án.
3. **VEXIM quản lý hộ nhiều seller** → theo quy định Amazon bắt buộc đăng ký **Public Developer** (loại private chỉ dùng nội bộ 1 tổ chức, không áp dụng được cho khách hàng).
4. Sau khi được duyệt, app chưa lên Appstore vẫn cho **25 seller authorize** — đủ cho toàn bộ giai đoạn pilot.

### 5 bước cụ thể

| Bước | Việc cần làm | Ai làm | Kết quả |
|------|--------------|--------|---------|
| 1 | Chuẩn bị **tài khoản Seller Central** (dùng shop của VEXIM hoặc shop pilot với sự đồng ý của chủ shop) + chỉ định 1 người phụ trách hồ sơ | VEXIM | Có tài khoản truy cập Seller Central |
| 2 | Dựng **landing page công khai** giới thiệu "VEXIM Ops" (HTTPS, mô tả rõ dịch vụ ứng dụng). *Amazon sẽ kiểm tra: website phải truy cập được, không "đang xây dựng", không bắt đăng nhập* | Đội dev | URL nộp kèm hồ sơ |
| 3 | Điền **Developer Profile** trên Seller Central: thông tin doanh nghiệp, liên hệ, chọn loại **Public Developer** | VEXIM (dev hỗ trợ) | Hồ sơ đã nộp |
| 4 | Chọn **roles (quyền dữ liệu)** theo bộ đã chốt trong `docs/ho-so-developer-profile-ban-nhap.md` v1.1: **Inventory and Order Tracking, Product Listing, Pricing, Selling Partner Insights, Finance and Accounting** (+ Amazon Fulfillment nếu chốt làm FBA nhập hàng sớm) — **không xin role restricted lần đầu** | Dev tư vấn, VEXIM xác nhận | Danh sách roles khớp thiết kế |
| 5 | Viết **mô tả use case & xử lý PII** (dựa mục 3.3–3.4 của tài liệu đề xuất — đã soạn sẵn tư liệu) | Dev soạn, VEXIM duyệt | Đoạn trả lời < 500 ký tự/mục |

> **Lưu ý bắt buộc:** nếu Amazon gửi câu hỏi bổ sung qua case, **phải trả lời trong 5 ngày** — quá hạn case bị đóng và phải nộp lại từ đầu. Người phụ trách phải check email/Seller Central hằng ngày.

---

## CÁC VIỆC SONG SONG TRONG TUẦN ĐẦU (không cần chờ Amazon duyệt)

| # | Việc | Ai làm | Vì sao làm ngay |
|---|------|--------|-----------------|
| 2 | Đăng ký **Amazon Advertising API** (tài khoản dev riêng, duyệt thường nhanh hơn SP-API) | Dev + VEXIM | Để kịp dữ liệu quảng cáo ở Cấp độ 2 |
| 3 | Chốt **2–3 shop pilot** + người cung cấp dữ liệu nội bộ (giá vốn, lead time nhập hàng, ngưỡng cảnh báo) | VEXIM | Input cho Cấp độ 1 |
| 4 | Trả lời **checklist 12 mục** cuối tài liệu đề xuất (marketplace, cơ cấu phòng ban, Brand Registry…) | VEXIM | Chốt đặc tả v1.1 |
| 5 | Dựng **wireframe Figma** cho 8 dashboard + design system | Đội dev (UX) | Duyệt UI trước khi code |
| 6 | Khởi tạo **Supabase** (Auth, RLS, schemas) + khung Next.js + CI/CD | Đội dev | Sẵn sàng nối API thật ngay khi được duyệt |
| 7 | Kiểm thử tích hợp trên **SP-API sandbox** (Amazon có môi trường chính thức) | Đội dev | Không mất thời gian chờ duyệt |

---

## PHÂN CÔNG TÓM TẮT

```
VEXIM làm ngay:    ① nộp Developer Profile (bước 1, 3, 4 — cùng dev)
                   ③ chốt shop pilot + dữ liệu nội bộ
                   ④ trả lời checklist 12 mục
Đội dev làm ngay:  ② landing page   ⑤ Figma   ⑥ Supabase + khung app
                   ⑦ tích hợp sandbox   (soạn sẵn hồ sơ PII cho VEXIM)
Cùng làm:          Đăng ký Ads API
```

## TIMELINE TUẦN ĐẦU (đề xuất)

| Ngày | Cột mốc |
|------|---------|
| Ngày 1–2 | VEXIM chỉ định người phụ trách + tài khoản Seller Central; dev bắt đầu landing page & Figma |
| Ngày 3–4 | **Nộp Developer Profile** (không trễ hơn cuối tuần này); chốt shop pilot |
| Ngày 5–7 | Khởi tạo Supabase + khung app; kiểm thử sandbox; VEXIM trả lời checklist 12 mục |

## ĐỊNH NGHĨA HOÀN THÀNH TUẦN ĐẦU

> 📌 **Quyết định đã chốt:** hệ thống **build ngay trong lúc chờ Amazon duyệt** (không chờ API chính thức) — kế hoạch chi tiết phân tầng công việc + điều kiện "cắm là chạy" xem tại `docs/ke-hoach-xay-dung-song-song-trong-luc-cho-duyet.md`.

- ☐ Hồ sơ Developer Profile **đã nộp** (và theo dõi case hằng ngày)
- ☐ Landing page công khai hoạt động
- ☐ 2–3 shop pilot đã chốt
- ☐ Đã đăng ký Ads API
- ☐ Checklist 12 mục đã có trả lời của VEXIM
- ☐ Khung hệ thống (Supabase + Next.js) chạy được trên môi trường dev/sandbox

> Trong 2–8 tuần chờ Amazon duyệt, đội dev vẫn xây dựng đầy đủ Cấp độ 0–1 trên sandbox → khi duyệt xong là **cắm shop thật vào chạy ngay**.
