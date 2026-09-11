# SUPABASE — NỀN TẢNG DỮ LIỆU VEXIM OPS

## Trạng thái: ✅ đã kiểm chứng trên Postgres 18 thật (11/09/2026)

| Chỉ số | Kết quả |
|---|---|
| Migrations chạy sạch (DB mới từ đầu) | ✅ 0001 → 0002 → 0003 + seed |
| Bộ test RLS multi-tenant | ✅ **10/10 PASS** |
| Bảng tạo được | **36 bảng** · 8 schema |
| RLS policies | **44 policies** |
| SOP templates seed | **12/12** |

**Lỗi bắt được & đã sửa trong quá trình kiểm chứng** (đây là lý do phải test thật, không chỉ viết SQL):
1. `iam.assignments` tham chiếu `connections.seller_accounts` trước khi bảng đó được tạo → đã đảo thứ tự tạo bảng.
2. Migration 0003 thiếu extension `btree_gist` (cần cho ràng buộc EXCLUDE của giá vốn).
3. `iam.audit_logs` nằm ngoài vòng lặp policy tự động (chỉ phủ 7 schema nghiệp vụ) → thêm policy đọc riêng.
4. Token OAuth: xác nhận KHÔNG role client nào đọc được (kể cả super_admin persona) — đúng thiết kế.

## Cấu trúc

```
supabase/
├── migrations/
│   ├── 0001_init.sql             # 8 schema · 36 bảng · RLS · seed phòng ban + 8 luật cảnh báo
│   ├── 0002_task_workflows.sql   # task_templates (SOP) + task_events (audit từng bước)
│   └── 0003_cost_inputs.sql      # giá vốn effective-dated + hàm effective_cost()
├── seed.sql                      # đủ 12 SOP template (chạy sau migrations)
└── tests/
    ├── 0000_local_compat_shim.sql  # ⚠️ CHỈ dùng test local (giả lập auth/roles của Supabase)
    └── rls_test.sql                # 10 test cô lập dữ liệu multi-tenant
```

## Cách đưa vào Supabase khi có project (VEXIM làm 1 lần)

**Cách 1 — Supabase CLI (khuyến nghị):**
```bash
supabase link --project-ref <ref>
supabase db push        # tự chạy 0001 → 0002 → 0003
# sau đó chạy seed.sql qua SQL Editor (hoặc supabase db reset với seed cấu hình)
```

**Cách 2 — Dashboard:** mở **SQL Editor** trên supabase.com, dán & chạy theo thứ tự:
1. `migrations/0001_init.sql` → 2. `migrations/0002_task_workflows.sql` → 3. `migrations/0003_cost_inputs.sql` → 4. `seed.sql`

> ⚠️ **KHÔNG** chạy file `tests/0000_local_compat_shim.sql` trên Supabase thật — nó chỉ giả lập `auth` schema & roles cho Postgres thường; Supabase đã có sẵn các thành phần đó.

## Kiểm chứng lại ở local (không cần Docker/Supabase)

Đã dùng binary Postgres nhúng (`npm i embedded-postgres`) + client `pg`:

1. `initdb` → start postgres port 5433
2. Chạy lần lượt: `tests/0000_local_compat_shim.sql` → `migrations/0001..0003` → `seed.sql`
3. Chạy `tests/rls_test.sql` — kỳ vọng **10 dòng PASS**

Kết quả gần nhất:
```
PASS T1 — Operator chỉ thấy 2/6 listing (shop được gán)
PASS T2 — Client Viewer thấy 4/6 listing (đúng org mình)
PASS T3 — Super Admin thấy 6/6 listing
PASS T4 — không uid: 0 dòng
PASS T5 — oauth_tokens: 0 dòng với client (kể cả super_admin persona)
PASS T6 — insert listings với authenticated bị từ chối
PASS T7 — service_role (worker) ghi được (bypassrls)
PASS T8 — ghi tasks: chặn khi chưa có quyền, cho khi có, chặn shop khác
PASS T9 — giá vốn: chặn chồng lấp, tra đúng theo thời điểm
PASS T10 — audit log: operator thấy đúng bản ghi shop mình
```

## Mô hình phân quyền (đã test)

```
super_admin (persona)           → mọi shop (qua hàm RLS)
org_admin / client_viewer       → shop thuộc org của mình
operator / analyst              → chỉ shop được gán (iam.assignments)
oauth_tokens                    → KHÔNG policy nào cho client (chỉ service_role)
finance.financial_events, iam.audit_logs, ops.task_events → append-only
Worker đồng bộ                  → service_role (bypassrls) — đúng như Supabase thật
```

## Sau khi push lên Supabase (bước tiếp của dev)

1. Tạo user đầu tiên (Supabase Dashboard → Authentication) → insert `iam.user_profiles` + `role_assignments` tương ứng.
2. Bật Realtime cho `ops.alerts`, `ops.tasks`.
3. Bật pg_cron: job chốt `kpi_daily` 6h sáng + đối soát 2h sáng (SOP-10).
4. Web app tự chuyển DEMO MODE → SUPABASE MODE khi điền `NEXT_PUBLIC_SUPABASE_URL` + `ANON_KEY` vào `web/.env.local`.
