# VEXIM OPS — Hệ thống quản trị vận hành sàn Amazon

Nền tảng quản trị vận hành Amazon cho VEXIM (agency quản lý hộ tài khoản seller cho doanh nghiệp Việt): dashboard chỉ số theo phòng ban, tác vụ theo luồng vận hành chuẩn (SOP), kết nối **API chính thức của Amazon (SP-API + Ads API)**, database **Supabase**.

## Trạng thái (11/09/2026)

| Hạng mục | Trạng thái |
|---|---|
| Đề xuất triển khai + lộ trình 4 cấp độ | ✅ đã thống nhất với VEXIM |
| Hồ sơ Amazon Developer Profile | 🟠 đã nộp, chờ duyệt (2–8 tuần) |
| Database Supabase (3 migrations + seed) | ✅ **đã kiểm chứng trên Postgres 18 — 10/10 test RLS multi-tenant PASS** |
| Web app Next.js (Phase 1 — 27 routes) | ✅ đang chạy DEMO MODE (MockProvider), tự chuyển sang dữ liệu thật khi có Supabase |

## Cấu trúc repo

```
docs/        Tài liệu triển khai (đề xuất, hồ sơ Amazon, SOP, phân tích module, tiến độ)
supabase/    Migrations + seed + bộ test RLS (hướng dẫn: supabase/README.md)
web/         Ứng dụng Next.js 15 + Tailwind + Supabase Auth (hướng dẫn: web/README.md)
worker/      Sync worker Module 3 — đồng bộ tồn kho FBA 3 tầng (hướng dẫn: worker/README.md)
landing/     Landing page "VEXIM Ops" — điều kiện nộp Developer Profile
wireframes/  Wireframe 8 dashboard (bản duyệt thiết kế — tham chiếu)
```

## Chạy web app

```bash
cd web
npm install
npm run dev          # http://localhost:3000 — DEMO MODE: chọn 1 trong 4 vai trò
```

Chuyển sang dữ liệu thật: tạo project Supabase → push `supabase/migrations/*.sql` + `seed.sql` → điền env theo `web/.env.example`.

## Tài liệu chính

- `docs/de-xuat-trien-khai-he-thong-vexim.md` — đề xuất tổng thể (phân tích vận hành Amazon, kiến trúc, RBAC, lộ trình)
- `docs/ke-hoach-trien-khai-theo-module.md` — kế hoạch từng module gắn API Amazon thật (đã chốt)
- `docs/luong-van-hanh-chuan.md` — 12 SOP vận hành
- `docs/ho-so-developer-profile-ban-nhap.md` — hồ sơ Amazon Developer (v1.1)
- `docs/tien-do-trien-khai.md` — bảng tiến độ cập nhật
