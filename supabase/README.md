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

> ⚠️ **Phải áp ĐỦ CHUỖI theo thứ tự.** Mỗi migration sau phụ thuộc các migration
> trước — ví dụ `0025_module_8_research_core.sql` dùng schema `iam` (tạo ở 0001),
> enum `iam.module_code` và hàm `iam.has_role` (0022). Nếu dán riêng 0025 vào
> project mới/trống sẽ gặp:
> `ERROR: 3F000: schema "iam" does not exist`.
> Kiểm tra nhanh project đang ở mức nào:
> ```sql
> select s.schema_name,
>        (select count(*) from information_schema.tables t where t.table_schema = s.schema_name) as bang
>   from unnest(array['iam','connections','catalog','sales','inventory','ads','finance','ops','research']) as s(schema_name);
> ```
> Thiếu schema `iam` (hoảng các schema trên) = project chưa chạy chuỗi migration
> → bắt đầu từ 0001, KHÔNG nhảy cóc.

**Cách 1 — Script psql (nhanh nhất, áp đúng thứ tự cả chuỗi):**
```bash
# Lấy URI ở Dashboard → Project Settings → Database → Connection string → "Session"
export DATABASE_URL="postgres://postgres:[MẬT KHẨU]@db.<ref>.supabase.co:5432/postgres"
# (mạng IPv6/Vercel cổng 5432 không vào được thì dùng Session Pooler:
#  postgres://postgres.<ref>:[MẬT KHẨU]@aws-0-<region>.pooler.supabase.com:5432/postgres)
bash supabase/apply-migrations.sh           # 0001 → mới nhất, dừng ngay nếu lỗi
bash supabase/apply-migrations.sh --seed    # kèm seed.sql (12 SOP template)
```
Script idempotent (`IF NOT EXISTS`/`CREATE OR REPLACE`) nên chạy lại an toàn.

**Cách 2 — Supabase CLI:**
```bash
supabase link --project-ref <ref>
supabase db push        # tự chạy theo thứ tự
# sau đó chạy seed.sql qua SQL Editor (hoặc cấu hình seed cho supabase db reset)
```

**Cách 3 — Dashboard SQL Editor:** mở **SQL Editor** trên supabase.com, dán & chạy **lần lượt theo thứ tự tên file** trong thư mục `migrations/` (bắt đầu từ `0001_init.sql` cho tới file số cao nhất hiện có), cuối cùng chạy `seed.sql`. Riêng các file 0025–0027 (Module 8) bắt buộc chạy SAU khi đã có đủ 0001–0024.

> **`0031_shop_store_name.sql`** — tên shop Amazon (Sellers API v1 · `storeName`) đổ về
> `connections.seller_accounts.store_name` + view `vexim_shops` + 2 RPC `service_role`
> (`vexim_worker_set_shop_store_name`, `vexim_worker_list_shop_credentials`).
> Chạy SAU 0030. Idempotent; tự dựng lại view được cả khi deployment cũ chưa chạy 0024.
> Chi tiết điều tra & cách kiểm chứng: `docs/bao-cao-loi-ten-shop-amazon.md`.

> **`0032_shop_admin.sql`** — quản lý shop trên màn Module 0: `seller_accounts.seller_id`
> bỏ NOT NULL (thêm shop trước, authorize sau), 3 RPC `vexim_admin_create_shop` /
> `vexim_admin_delete_shop` (xoá 2 bước) / `vexim_worker_claim_shop_seller_id` (chỉ
> callback), và **ẩn 6 shop mock** (`status='revoked'`). Chạy SAU 0031. Idempotent;
> nhật ký xoá shop được giữ lại (ghi với `seller_account_id = null`).
> Chi tiết: `docs/tien-do-trien-khai.md` mục 16/09/2026.

> `seed/seed_demo.sql` **không còn cần** cho phần admin/alerts — 0007 đã thay thế
> vì nó không phụ thuộc `auth.uid()` (thứ khiến seed_demo âm thầm bỏ qua trong SQL Editor).

### Sự cố thường gặp sau khi áp migration

**Lỗi web: `Could not find the table 'public.vexim_research_assessments' in the schema cache`**
(các RPC `vexim_research_*` đã có nhưng web vẫn báo thiếu bảng). Nguyên nhân: đoạn
`CREATE VIEW` cuối file 0025/0026 không được áp (chạy thiếu khối khi dán thủ công),
hoặc PostgREST chưa nạp lại schema cache. Xử lý:

1. Chạy file vá sẵn có **trong SQL Editor** (idempotent, đã test trên PGlite):
   `repair/recreate_research_public_views.sql` — dựng lại đủ 10 view public + grant
   + `notify pgrst, 'reload schema'`.
2. Nếu vẫn lỗi: Dashboard → **Settings → API → "Reload schema cache"** (hoạch đợi
   vài giây rồi tải lại trang).
3. Kiểm tra biến `NEXT_PUBLIC_SUPABASE_URL` của web có trỏ ĐÚNG project vừa áp
   migration không (dán nhầm project khác cũng gây đúng triệu chứng này).

> ⚠️ **KHÔNG** chạy file `tests/0000_local_compat_shim.sql` trên Supabase thật — nó chỉ giả lập `auth` schema & roles cho Postgres thường; Supabase đã có sẵn các thành phần đó.

## Kiểm chứng lại ở local (không cần Docker/Supabase)

```bash
cd supabase
npm install     # cài PGlite (PostgreSQL 18 biên dịch sang WASM)
npm test        # toàn bộ BƯỚC 1..26 PASS / 0 FAIL
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
