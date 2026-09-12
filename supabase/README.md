# SUPABASE — NỀN TẢNG DỮ LIỆU VEXIM OPS

## Trạng thái: ✅ đã kiểm chứng trên PostgreSQL 18.3 (12/09/2026)

| Chỉ số | Kết quả |
|---|---|
| Migrations chạy sạch (DB mới từ đầu) | ✅ 0001 → 0002 → 0003 → 0004 → 0005 + seed |
| Bộ kiểm chứng tự động `npm test` | ✅ **53 PASS / 0 FAIL** |
| Bộ test RLS multi-tenant | ✅ **10/10 PASS** |
| Bảng tạo được | **36 bảng** · 8 schema |
| RLS policies | **44 policies** |
| SOP templates seed | **12/12** |

## ⚠️ SỰ CỐ 12/09/2026 — fixture test lọt vào DB production

`tests/rls_test.sql` được viết cho Postgres local nhưng **kết thúc bằng `commit;`**.
Khi bị chạy trong SQL Editor trên project Supabase thật, toàn bộ fixture test bị
commit vĩnh viễn: 2 org giả, 3 shop giả, 3 auth user giả (`u1@`/`u2@vexim.vn`,
`client@dna.vn`), 7 listing `TEST-S*-`, 3 task, 2 giá vốn, 1 oauth token dummy.

Cùng lúc, `seed/seed_demo.sql` mục 4 & 5 **âm thầm bỏ qua** vì chúng mở đầu bằng
`if auth.uid() is null then return` — mà trong SQL Editor `auth.uid()` luôn NULL.
Hệ quả: không có `super_admin`, `ops.alerts` = 0, chuông thông báo rơi về mock.

**Đã sửa (migration 0006 + 0007, và 2 chốt an toàn trong rls_test.sql).**
Xem `docs/tien-do-trien-khai.md` mục "Sự cố 12/09".

**VEXIM cần chạy trong SQL Editor, theo đúng thứ tự:**
1. `migrations/0006_cleanup_rls_test_fixtures.sql` — dọn fixture test
2. `migrations/0007_seed_admin_and_alerts.sql` — tạo super_admin + 9 alerts
   (email admin đã điền sẵn `hocluongvan88@gmail.com`; sửa trong file nếu cần thêm)
3. Thêm biến môi trường **`CRON_SECRET`** trên Vercel (Production + Preview) rồi Redeploy

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
│   ├── 0003_cost_inputs.sql      # giá vốn effective-dated + hàm effective_cost()
│   ├── 0004_ui_policies_notifs_profile_invite.sql  # RLS cho UI + 2 view my_profile/my_alerts
│   ├── 0005_worker_inventory_rpc.sql               # RPC units_sold_per_day + active_production_shops
│   ├── 0006_cleanup_rls_test_fixtures.sql          # ⚠️ dọn fixture test lọt vào DB thật
│   └── 0007_seed_admin_and_alerts.sql              # super_admin + 9 alerts (không cần auth.uid())
├── seed.sql                      # đủ 12 SOP template (chạy sau migrations)
├── seed/seed_demo.sql            # dữ liệu demo (mục 4+5 cần auth.uid() → xem 0007 thay thế)
├── package.json                  # devDependency PGlite cho bộ kiểm chứng
└── tests/
    ├── 0000_local_compat_shim.sql  # ⚠️ CHỈ dùng test local (giả lập auth/roles của Supabase)
    ├── rls_test.sql                # 10 test cô lập multi-tenant — có 2 chốt an toàn
    └── run-migrations.mjs          # harness kiểm chứng toàn bộ (PGlite, không cần Docker)
```

## Cách đưa vào Supabase khi có project (VEXIM làm 1 lần)

**Cách 1 — Supabase CLI (khuyến nghị):**
```bash
supabase link --project-ref <ref>
supabase db push        # tự chạy 0001 → 0007 theo thứ tự
# sau đó chạy seed.sql qua SQL Editor (hoặc supabase db reset với seed cấu hình)
```

**Cách 2 — Dashboard:** mở **SQL Editor** trên supabase.com, dán & chạy theo thứ tự:
1. `migrations/0001_init.sql`
2. `migrations/0002_task_workflows.sql`
3. `migrations/0003_cost_inputs.sql`
4. `migrations/0004_ui_policies_notifs_profile_invite.sql`
5. `migrations/0005_worker_inventory_rpc.sql`
6. `migrations/0006_cleanup_rls_test_fixtures.sql` *(dọn fixture test — idempotent)*
7. `migrations/0007_seed_admin_and_alerts.sql` *(super_admin + alerts)*
8. `seed.sql`

> `seed/seed_demo.sql` **không còn cần** cho phần admin/alerts — 0007 đã thay thế
> vì nó không phụ thuộc `auth.uid()` (thứ khiến seed_demo âm thầm bỏ qua trong SQL Editor).

> ⚠️ **KHÔNG** chạy file `tests/0000_local_compat_shim.sql` trên Supabase thật — nó chỉ giả lập `auth` schema & roles cho Postgres thường; Supabase đã có sẵn các thành phần đó.

## Kiểm chứng lại ở local (không cần Docker/Supabase)

```bash
cd supabase
npm install     # cài PGlite (PostgreSQL 18 biên dịch sang WASM)
npm test        # 53 PASS / 0 FAIL
```

Harness `tests/run-migrations.mjs` chạy **Postgres thật** trong bộ nhớ và:

1. Tạo DB trống → shim → `0001..0005` → `seed.sql`
2. **Tái hiện đúng trạng thái DB production VEXIM 12/09/2026** bằng cách chạy
   `rls_test.sql` bản cũ (`rollback;` → `commit;`) rồi đối chiếu **15 bảng** với
   dump thật: `organizations=3, seller_accounts=9, auth.users=4, user_profiles=3,
   role_assignments=3, assignments=2, listings=7, tasks=3, cost_inputs=2,
   audit_logs=1, oauth_tokens=1, alert_rules=8, task_templates=12, alerts=0` — khớp toàn bộ
3. Kiểm **chốt 2**: không bật cờ `vexim.allow_rls_test` thì file tự từ chối
4. Kiểm **chốt 1**: bật cờ thì 10 test chạy, và `rollback;` giữ DB nguyên vẹn
   (so sánh 6 số đếm trước/sau — phải giống hệt)
5. Kiểm `0006` dọn sạch fixture, **giữ nguyên user thật** `hocluongvan88@gmail.com`
6. Kiểm `0007` tạo `super_admin` + 9 alerts + 6 assignments, và **idempotent**
7. Kiểm view `iam.my_profile` / `ops.my_alerts` và RPC `connections.active_production_shops()`

Kết quả bộ test RLS (chạy trong harness):
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

### Chạy `rls_test.sql` thủ công bằng psql

File có chốt an toàn nên **phải bật cờ trong cùng phiên**:
```bash
psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "select set_config('vexim.allow_rls_test','on',false);" \
  -f supabase/tests/rls_test.sql
```
File kết thúc bằng `rollback;` nên không bao giờ ghi fixture xuống đĩa.

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
