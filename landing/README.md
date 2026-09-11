# LANDING PAGE "VEXIM OPS" — Hướng dẫn sử dụng & triển khai

Landing page này là **điều kiện bắt buộc** khi nộp Amazon Developer Profile (Amazon yêu cầu website công khai, HTTPS, mô tả rõ dịch vụ mà ứng dụng cung cấp cho người bán).

## ⚠️ PHẢI THAY THẾ TRƯỚC KHI CÔNG BỐ (hiện đang là giá trị tạm)

| # | Nội dung | Vị trí trong `index.html` | Giá trị hiện tại (tạm) |
|---|----------|---------------------------|------------------------|
| 1 | Email liên hệ | mục Contact (`ops@vexim.vn`) | email thật của VEXIM |
| 2 | Số điện thoại | mục Contact (`+84 28 1234 5678`) | hotline thật |
| 3 | Địa chỉ văn phòng | mục Contact (`Ho Chi Minh City, Vietnam`) | địa chỉ thật |
| 4 | Tên pháp lý công ty | footer (`VEXIM Co., Ltd.`) | tên pháp lý đúng theo đăng ký kinh doanh |
| 5 | Nội dung "About VEXIM" | mục About | kiểm tra lại số lượng shop/khách hàng thực tế |
| 6 | (Khuyến nghị) Trang Privacy Policy riêng | — | thêm `/privacy` trước khi nộp hồ sơ để tăng tỷ lệ duyệt |

## Vì sao trang là tiếng Anh?

Người xét duyệt hồ sơ của Amazon đọc tiếng Anh — trang tiếng Anh giúp việc review thông suốt nhất. Có thể bổ sung phiên bản tiếng Việt (`/vn`) sau khi đã được duyệt, phục vụ marketing khách hàng nội địa.

## Xem thử cục bộ

Mở trực tiếp `index.html` bằng trình duyệt, hoặc chạy server tĩnh:

```bash
cd landing && python3 -m http.server 8080
# mở http://localhost:8080
```

## Triển khai (chọn 1 trong các cách, đều miễn phí)

| Cách | Thao tác | Ghi chú |
|------|----------|---------|
| **Vercel** | `npx vercel` trong thư mục `landing/` | gắn custom domain dễ |
| **Netlify** | Kéo-thả thư mục `landing/` vào app.netlify.com | nhanh nhất, không cần git |
| **Cloudflare Pages** | Connect repo, chọn thư mục `landing/` | free tier băng thông lớn |
| **Hosting của VEXIM** | upload `index.html` lên hosting, trỏ subdomain | ví dụ `ops.vexim.vn` |

**Bắt buộc:**域名 phải có **HTTPS** (Vercel/Netlify/Cloudflare tự cấp Let's Encrypt). URL nộp cho Amazon phải là URL HTTPS công khai, không đăng nhập, không "đang xây dựng".

## Checklist trước khi nộp URL vào Developer Profile

- ☐ Đã thay đủ 6 mục ở bảng trên
- ☐ Đã deploy lên HTTPS, truy cập được từ trình duyệt ẩn danh (không cache)
- ☐ Trang load < 3 giây, hiển thị đúng trên mobile
- ☐ (Khuyến nghị) Đã thêm trang Privacy Policy riêng
