# VEXIM OPS — WEB APP (Phase 1)

Ứng dụng Next.js của hệ thống quản trị vận hành Amazon. Đang chạy **DEMO MODE** (MockProvider — dữ liệu giả theo wireframe đã duyệt), sẵn sàng chuyển sang dữ liệu thật khi có Supabase + SP-API mà **không đổi giao diện**.

## Chạy

```bash
cd web
npm install
npm run dev        # dev: http://localhost:3000
npm run build && npm run start   # production
```

**Đăng nhập DEMO MODE:** chọn 1 trong 4 vai trò (Ban điều hành / Trưởng phòng Kho vận / Operator PPC / Client Viewer). Trong app, dùng dropdown viền cam trên topbar để đổi vai trò — kiểm chứng phân quyền theo phòng.

## Hai chế độ

| | DEMO MODE (hiện tại) | SUPABASE MODE (khi có project) |
|---|---|---|
| Điều kiện | chưa set env | `.env.local` có `NEXT_PUBLIC_SUPABASE_URL` + ANON_KEY |
| Đăng nhập | chọn persona demo | email/password qua Supabase Auth |
| Dữ liệu | `lib/data/mock.ts` | Postgres + RLS (migrations ở `../supabase/`) |
| Chuyển đổi | điền env → tự động | — |

## Cấu trúc

```
src/
├── app/
│   ├── (auth)/login/          # đăng nhập (demo persona / supabase)
│   ├── (app)/                 # mọi trang phía sau AppShell
│   │   ├── dashboard/         # Tổng quan CEO
│   │   ├── health | listing | ppc | fulfillment | orders | finance | client/
│   │   └── module0/           # connect · sync-health · api-usage · audit-log · users
│   ├── layout.tsx · page.tsx (redirect) · globals.css
├── components/
│   ├── ui.tsx                 # KpiCard, Panel, Chip, AlertList, Bars, MiniList…
│   └── shell/                 # AppShell, Topbar (role switcher), Sidebar (RBAC)
├── lib/
│   ├── roles.ts               # 4 persona demo + nav theo quyền
│   ├── auth/session.ts        # demo cookie | Supabase Auth
│   ├── supabase/              # client browser/server (@supabase/ssr)
│   ├── data/mock.ts           # MockProvider (số liệu khớp wireframe)
│   └── data/provider.ts       # adapter Mock → Supabase (đã chốt trong kiến trúc)
└── middleware.ts              # chặn truy cập chưa đăng nhập
```

## Phân quyền

- UI: `lib/roles.ts` lọc sidebar + `NoAccess` khi vào sai trang.
- Thực thi thật: **RLS ở tầng database** (migrations 0001–0003) — UI chỉ là lớp hiển thị, cố gọi API lấy shop ngoài phạm vi vẫn trả 0 dòng.

## Roadmap kỹ thuật gần nhất

1. SupabaseProvider cho các trang (đọc `kpi_daily`, `alerts`, `sync_jobs`…)
2. Map persona từ `iam.role_assignments` (supabase mode)
3. Màn hình Module 7 (Health) → Module 4 (Orders) theo thứ tự đã chốt
4. Typed clients SP-API từ Swagger models (Tier 1) + sandbox

## Module 4/6 — Supabase read mode (migration 0011)

Các route Orders và Finance dùng cookie session + anon key để đọc public views.
Không dùng service role hay fallback mock khi DB trống/lỗi. Bản demo chỉ dùng khi
session mode là demo. Mã `id` của trang chi tiết là UUID nội bộ từ link danh sách,
không phải mã đơn/kỳ Amazon. Đơn vị tiền tệ không quy đổi; countdown FBM tại lúc tải.

Kiểm tra: `npm test`, `npm run typecheck`, `npm run build`; kiểm tra SQL/RLS và
projection UI: `cd ../supabase && npm test` (Node 22.22+, PGlite local trong bộ nhớ).
Chưa chạy test trình duyệt/production tự động. Checklist live trong
`docs/tien-do-trien-khai.md`.
