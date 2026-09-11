# TIẾN ĐỘ TRIỂN KHAI — VEXIM OPS

> Cập nhật: 11/09/2026 · Thứ tự build đã chốt: **0 → 7 → 4 → 3 → 1(đọc) → 2 → 6(đọc)** (21 màn Đợt 1)

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
| **4. Đơn hàng** | O1 Danh sách đơn (không PII) · O2 Chi tiết đơn (PII khóa) · O3 Queue FBM (đếm ngược) · O4 Returns (mã lý do Amazon) | ✅ (mock) |
| **3. Kho vận (đọc)** | I1 Tồn theo SKU (filter, cover, đề xuất) · I2 Chi tiết tồn (90 ngày, FC, nhận hàng) · I3 Kế hoạch nhập (SOP-01, ghi khóa Đợt 2) · I4 Inbound (trạng thái chuẩn Amazon + đối soát) — kèm **phân tích kỹ thuật** `docs/phan-tich-ky-thuat-module-3-kho-van.md` (đã kiểm chứng: notification FBA_INVENTORY_AVAILABILITY_CHANGES, cột report MYI, report theo FC) | ✅ (mock) |
| | **Sync layer 3 tầng** (worker/): notification → getInventorySummaries → report MYI đối soát; chỉ số velocity/cover/đề xuất nhập đúng công thức §2 | ✅ Tier 1 (mock, 16/16 test) |
| **1. Listing (đọc)** | L1 Danh sách listing (filter trạng thái/shop/loại lỗi/brand, tìm kiếm, sort, xuất CSV) · L2 Chi tiết (thuộc tính theo product type, issues đúng mã lỗi Amazon, lịch sử, offer & Buy Box, doanh thu 30 ngày) · L4 Hàng đợi inactive/stranded theo SOP-03 | ✅ (mock) |
| | **Sync layer Listing** (worker/): getListingsItem + LISTINGS_ITEM_STATUS_CHANGE/ISSUES_CHANGE + 3 report parser (Merchant ALL/INACTIVE, Stranded) | ✅ (mock, 12 test) |
| **2. Giá & Buy Box** | P1–P3 | ⬜ |
| **6. Tài chính (đọc)** | F1–F2 | ⬜ |

**Kiểm chứng build (11/09):** `next build` pass 16 routes · middleware chặn chưa đăng nhập (307 → /login) · CEO xem được /dashboard · Operator PPC vào /finance bị chặn "Không có quyền truy cập" ✅

## Cách verify nhanh (DEMO MODE)

1. Mở preview (port 3000) → trang đăng nhập → chọn vai trò.
2. Dropdown viền cam (topbar) đổi vai trò → sidebar & phạm vi đổi theo.
3. Thử Operator PPC vào URL `/finance` trực tiếp → bị chặn.

## Chờ VEXIM

- ☐ Tạo project Supabase + mời dev (xem `supabase/README.md`) — để push migrations + bật SUPABASE MODE
- ☐ 4 thông tin thật cho landing page (email/phone/địa chỉ/tên pháp lý)
- ☐ Chốt 2–3 shop pilot + file giá vốn theo template CSV
- ☐ Hải Anh: báo ngày nộp hồ sơ + tạo Sandbox Application ngay sau khi nộp
