# LANDING PAGE "VEXIM OPS" — Phiên bản tiếng Việt gắn vào hệ thống

Landing page là **điều kiện bắt buộc** khi nộp Amazon Developer Profile (Amazon yêu cầu website công khai, HTTPS, mô tả rõ dịch vụ mà ứng dụng cung cấp cho người bán) và đồng thời là **trang chủ marketing** của hệ thống khi chưa đăng nhập.

## Nội dung hiện tại (đã Việt hoá & khớp dự án)

Trang `index.html` đã được chuyển sang tiếng Việt, dùng ngôn từ marketing chuẩn ngành Amazon/e-commerce:

- **Hero**: Value proposition "Vận hành Amazon tập trung & đo được" + USP multi-tenant, RBAC 6 vai trò, 12 SOP, audit log & RLS.
- **Nền tảng**: 3 bước "Kết nối chính thức → Đồng bộ 3 tầng (Realtime/Incremental/Daily) → Hành động theo cảnh báo".
- **6 phòng ban**: Vận hành & Health, Listing, Định giá & Buy Box, Kho vận & FBA, Quảng cáo PPC, Đơn hàng & CSKH — mỗi phòng có KPI hằng ngày.
- **8 module chính**: Dashboard CEO, Sức khỏe tài khoản, Listing, Định giá & Phê duyệt, Tồn kho & Nhập hàng, PPC & Search Term (Ads API v3, Negative Exact/Phrase SOP-04, revert 1 chạm), Đơn hàng FBM & Returns, Tài chính & Đối soát + Client Portal.
- **Bảo mật**: SP-API & Ads API chính thức, OAuth 2.0, mã hoá Vault, tối thiểu hoá PII, RBAC + audit log không xoá, xoá dữ liệu khi thu hồi.
- **Về VEXIM**: định vị agency vận hành marketplace, 4 lợi ích (giảm thất thoát, tăng biên lợi nhuận, chuẩn hoá SOP, minh bạch client).

Nội dung khớp 100% với kiến trúc đã chốt trong `docs/de-xuat-trien-khai-he-thong-vexim.md` và 30+ route trong `web/src/app/(app)/`.

## Gắn vào hệ thống Next.js

Landing không còn là file tĩnh tách rời — đã được tích hợp vào web app:

- `web/src/components/landing/ViLanding.tsx`: component React dùng chung (client, có reveal on scroll, mobile nav).
- `web/src/app/landing/page.tsx`: route `/landing` public, luôn hiển thị landing.
- `web/src/app/page.tsx` (root `/`): nếu chưa đăng nhập → hiển thị landing tiếng Việt; nếu đã đăng nhập (supabase hoặc demo) → redirect `/dashboard` như cũ.
- `web/src/middleware.ts`: `PUBLIC_PATHS` bao gồm `/`, `/landing`, `/login`, `/invite`, `/auth/confirm` — để trang chủ public không bị đá về login.

Truy cập:
- `/` → landing nếu chưa login, dashboard nếu đã login
- `/landing` → luôn landing
- `/login` → đăng nhập

## ⚠️ PHẢI THAY THẾ TRƯỚC KHI CÔNG BỐ (giá trị tạm)

| # | Nội dung | Vị trí | Giá trị hiện tại (tạm) |
|---|----------|--------|------------------------|
| 1 | Email liên hệ | Contact (`ops@vexim.vn`) | email thật của VEXIM |
| 2 | Số điện thoại | Contact (`+84 28 1234 5678`) | hotline thật |
| 3 | Địa chỉ văn phòng | Contact (`TP. Hồ Chí Minh`) | địa chỉ thật |
| 4 | Tên pháp lý công ty | footer (`VEXIM Co., Ltd.`) | tên pháp lý đúng ĐKKD |
| 5 | Nội dung "About VEXIM" | About | kiểm tra lại số lượng shop/khách hàng thực tế |
| 6 | (Khuyến nghị) Trang Privacy Policy riêng | — | thêm `/privacy` trước khi nộp hồ sơ để tăng tỷ lệ duyệt |

## Lưu ý Amazon Developer Profile

- Amazon reviewer đọc tiếng Anh tốt nhất. Nếu cần nộp bản tiếng Anh, có thể giữ bản cũ tại `landing/en/index.html` hoặc dùng `/landing` tiếng Việt kèm bản tiếng Anh `/en`.
- Hiện tại trang tiếng Việt đã đủ chuẩn marketing cho khách hàng nội địa và vẫn mô tả đúng SP-API, OAuth, data protection — có thể nộp nếu bổ sung Privacy Policy.

## Xem thử cục bộ

**File tĩnh:**
```bash
cd landing && python3 -m http.server 8080
# http://localhost:8080
```

**Tích hợp trong Next.js:**
```bash
cd web && npm run dev
# http://localhost:3000/ → landing khi chưa login
# http://localhost:3000/landing → luôn landing
```

## Triển khai

| Cách | Thao tác | Ghi chú |
|------|----------|---------|
| **Vercel (khuyến nghị)** | Deploy cả `web/` — landing đã nằm trong Next.js, tự có HTTPS | gắn custom domain `ops.vexim.vn` |
| **File tĩnh riêng** | `npx vercel` trong `landing/` | nếu muốn domain riêng cho landing |
| **Netlify / Cloudflare Pages** | Kéo-thả `landing/` | nhanh, free tier |

**Bắt buộc:** domain phải có **HTTPS**. URL nộp cho Amazon phải là URL HTTPS công khai, không đăng nhập, không "đang xây dựng".

## Checklist trước khi nộp URL vào Developer Profile

- ☐ Đã thay đủ 6 mục ở bảng trên
- ☐ Đã deploy lên HTTPS, truy cập được từ trình duyệt ẩn danh
- ☐ Trang load < 3s, hiển thị đúng mobile (đã responsive)
- ☐ Đã thêm Privacy Policy riêng (khuyến nghị)
- ☐ Nội dung khớp với 8 module và 6 phòng ban trong app thật
