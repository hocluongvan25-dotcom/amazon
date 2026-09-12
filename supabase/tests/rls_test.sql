-- ============================================================================
-- BỘ TEST RLS MULTI-TENANT — VEXIM OPS
-- CHỈ CHẠY TRÊN POSTGRES LOCAL (sau shim + migrations 0001→0005).
-- Mỗi test FAIL sẽ RAISE EXCEPTION → runner báo lỗi; PASS in ra notice.
--
-- Kịch bản (khớp 4 persona của app):
--   U1 = Operator PPC  — chỉ được gán shop S1 (module ads)
--   U2 = Super Admin
--   U3 = Client Viewer — thuộc org "Doanh nghiệp A" (S1, S2)
--   Shop: S1, S2 thuộc org A · S3 thuộc org B
--
-- ============================================================================
-- ⚠️⚠️ HAI CHỐT AN TOÀN (thêm 12/09/2026 sau sự cố) ⚠️⚠️
-- ============================================================================
-- SỰ CỐ: file này từng kết thúc bằng `commit;`. Khi bị chạy nhầm trong
--   Supabase SQL Editor trên project production, toàn bộ fixture test
--   (2 org giả, 3 shop giả, 3 auth user giả, 7 listing TEST-S*-…) bị
--   COMMIT VĨNH VIỄN vào DB thật. Phải dọn bằng migration 0006.
--
-- CHỐT 1 — cuối file là `rollback;` (không phải `commit;`): fixture chỉ tồn
--   tại trong transaction test, không bao giờ ghi xuống đĩa.
--
-- CHỐT 2 — phải BẬT CỜ chủ động thì file mới chạy (xem ngay bên dưới).
--
-- CÁCH CHẠY ĐÚNG (local, một phiên psql duy nhất):
--   psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -c "select set_config('vexim.allow_rls_test','on',false);" \
--     -f supabase/tests/rls_test.sql
--
-- KHÔNG chạy file này trên project Supabase thật.
-- ============================================================================

do $$
begin
  if coalesce(current_setting('vexim.allow_rls_test', true), 'off') <> 'on' then
    raise exception
      'TỪ CHỐI chạy rls_test.sql: chưa bật cờ vexim.allow_rls_test. '
      'File này chèn fixture test và CHỈ dành cho Postgres local. '
      'Bật bằng: select set_config(''vexim.allow_rls_test'',''on'',false); '
      'trong CÙNG phiên psql, rồi chạy lại.';
  end if;
  raise notice 'rls_test.sql: cờ cho phép đã bật — chạy trên Postgres local.';
end $$;

begin;

-- ---------------------------------------------------------------------------
-- TỰ DỌN TRƯỚC KHI SEED: nếu lần chạy trước bị commit (sự cố đã xảy ra),
-- fixture còn sót sẽ làm lần chạy này vỡ "duplicate key". Xoá theo đúng thứ tự
-- FK, chỉ đụng 3 nhóm UUID cố định của test.
-- ---------------------------------------------------------------------------
do $$
declare
  v_users uuid[] := array[
    'cccc0000-0000-4000-8000-000000000001',
    'cccc0000-0000-4000-8000-000000000002',
    'cccc0000-0000-4000-8000-000000000003'
  ];
  v_shops uuid[] := array[
    'bbbb0000-0000-4000-8000-000000000001',
    'bbbb0000-0000-4000-8000-000000000002',
    'bbbb0000-0000-4000-8000-000000000003'
  ];
  v_orgs  uuid[] := array[
    'aaaa0000-0000-4000-8000-000000000002',
    'aaaa0000-0000-4000-8000-000000000003'
  ];
begin
  delete from iam.audit_logs         where actor_id = any (v_users);
  delete from ops.task_events        where actor_id = any (v_users);
  delete from iam.assignments        where user_id = any (v_users)
                                       or assigned_by = any (v_users)
                                       or seller_account_id = any (v_shops);
  delete from iam.role_assignments   where user_id = any (v_users);
  delete from catalog.cost_inputs    where seller_account_id = any (v_shops)
                                       or imported_by = any (v_users);
  delete from ops.tasks              where seller_account_id = any (v_shops)
                                       or assignee_id = any (v_users)
                                       or created_by = any (v_users);
  delete from ops.alerts             where assigned_to = any (v_users);
  delete from catalog.fees_estimates where seller_account_id = any (v_shops);
  delete from catalog.listing_offers where seller_account_id = any (v_shops);
  delete from catalog.listings       where seller_account_id = any (v_shops);
  delete from connections.oauth_tokens where seller_account_id = any (v_shops);
  delete from iam.user_profiles      where id = any (v_users);
  delete from auth.users             where id = any (v_users);
  delete from connections.seller_accounts where id = any (v_shops);
  delete from iam.organizations      where id = any (v_orgs);
end $$;

-- `on commit drop` + `if not exists`: cho phép chạy lại trong CÙNG phiên psql.
-- Thiếu hai thứ này thì lần chạy thứ hai vỡ ngay ở đây ("already exists").
create temp table if not exists test_results (name text, ok boolean) on commit drop;
truncate test_results;

-- ---------------------------------------------------------------------------
-- SEED dữ liệu test (id cố định để chạy lặp được)
-- ---------------------------------------------------------------------------
insert into iam.organizations (id, name, slug, is_internal) values
  ('aaaa0000-0000-4000-8000-000000000002', 'Doanh nghiệp A', 'dna', false),
  ('aaaa0000-0000-4000-8000-000000000003', 'Doanh nghiệp B', 'dnb', false);
-- (org VEXIM 'vexim' đã được migration 0001 seed sẵn)

insert into connections.seller_accounts
  (id, org_id, seller_id, marketplace, display_name) values
  ('bbbb0000-0000-4000-8000-000000000001', 'aaaa0000-0000-4000-8000-000000000002', 'A1SELLER', 'ATVPDKIKX0DER', 'Shop A1 · US'),
  ('bbbb0000-0000-4000-8000-000000000002', 'aaaa0000-0000-4000-8000-000000000002', 'A2SELLER', 'A1AM78C64UM0Y8',  'Shop A2 · MX'),
  ('bbbb0000-0000-4000-8000-000000000003', 'aaaa0000-0000-4000-8000-000000000003', 'B1SELLER', 'ATVPDKIKX0DER', 'Shop B1 · US');

insert into auth.users (id, email) values
  ('cccc0000-0000-4000-8000-000000000001', 'u1@vexim.vn'),
  ('cccc0000-0000-4000-8000-000000000002', 'u2@vexim.vn'),
  ('cccc0000-0000-4000-8000-000000000003', 'client@dna.vn');

insert into iam.user_profiles (id, display_name, email, vexim_employee, org_id) values
  ('cccc0000-0000-4000-8000-000000000001', 'Operator PPC', 'u1@vexim.vn', true, null),
  ('cccc0000-0000-4000-8000-000000000002', 'Super Admin', 'u2@vexim.vn', true, null),
  ('cccc0000-0000-4000-8000-000000000003', 'Client A', 'client@dna.vn', false, 'aaaa0000-0000-4000-8000-000000000002');

insert into iam.role_assignments (user_id, role) values
  ('cccc0000-0000-4000-8000-000000000001', 'operator'),
  ('cccc0000-0000-4000-8000-000000000002', 'super_admin'),
  ('cccc0000-0000-4000-8000-000000000003', 'client_viewer');

-- U1 chỉ được gán S1, module ads, CHƯA có quyền ghi
insert into iam.assignments (user_id, seller_account_id, module, can_write) values
  ('cccc0000-0000-4000-8000-000000000001', 'bbbb0000-0000-4000-8000-000000000001', 'ads', false);

-- listings: 2 SKU mỗi shop
insert into catalog.listings (seller_account_id, sku, asin, title, price) values
  ('bbbb0000-0000-4000-8000-000000000001', 'TEST-S1-1', 'B0TEST0001', 'S1 listing 1', 29.99),
  ('bbbb0000-0000-4000-8000-000000000001', 'TEST-S1-2', 'B0TEST0002', 'S1 listing 2', 19.99),
  ('bbbb0000-0000-4000-8000-000000000002', 'TEST-S2-1', 'B0TEST0003', 'S2 listing 1', 24.99),
  ('bbbb0000-0000-4000-8000-000000000002', 'TEST-S2-2', 'B0TEST0004', 'S2 listing 2', 14.99),
  ('bbbb0000-0000-4000-8000-000000000003', 'TEST-S3-1', 'B0TEST0005', 'S3 listing 1', 34.99),
  ('bbbb0000-0000-4000-8000-000000000003', 'TEST-S3-2', 'B0TEST0006', 'S3 listing 2', 44.99);

-- token (đã mã hóa giả lập) — không role client nào được đọc
insert into connections.oauth_tokens (seller_account_id, encrypted_refresh_token, expires_at) values
  ('bbbb0000-0000-4000-8000-000000000001', 'ENCRYPTED-DUMMY', now() + interval '300 days');

insert into ops.tasks (seller_account_id, title, status) values
  ('bbbb0000-0000-4000-8000-000000000001', 'Test task S1', 'open'),
  ('bbbb0000-0000-4000-8000-000000000002', 'Test task S2', 'open');

-- ---------------------------------------------------------------------------
-- HÀM TIỆN: chạy 1 query với vai trò + uid rồi trả về đếm
-- ---------------------------------------------------------------------------
create or replace function pg_temp.count_as(p_role text, p_uid text, p_sql text)
returns bigint
language plpgsql
as $$
declare n bigint;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), false);
  execute format('set role %I', p_role);
  execute p_sql into n;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', false);
  return n;
end $$;

create or replace function pg_temp.try_as(p_role text, p_uid text, p_sql text)
returns boolean  -- true nếu THÀNH CÔNG, false nếu bị từ chối/lỗi
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), false);
  execute format('set role %I', p_role);
  begin
    execute p_sql;
    execute 'reset role';
    perform set_config('request.jwt.claim.sub', '', false);
    return true;
  exception when others then
    execute 'reset role';
    perform set_config('request.jwt.claim.sub', '', false);
    return false;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- T1: Operator U1 chỉ thấy 2 listing của shop được gán (S1)
do $$
declare n bigint;
begin
  n := pg_temp.count_as('authenticated', 'cccc0000-0000-4000-8000-000000000001',
    'select count(*) from catalog.listings');
  insert into test_results values ('T1 Operator chỉ thấy shop được gán (2/6)', n = 2);
  if n <> 2 then raise exception 'T1 FAIL: n=%', n; end if;
  raise notice 'PASS T1 — Operator chỉ thấy 2/6 listing';
end $$;

-- T2: Client Viewer U3 (org A) thấy S1+S2, không thấy S3 của org B
do $$
declare n bigint;
begin
  n := pg_temp.count_as('authenticated', 'cccc0000-0000-4000-8000-000000000003',
    'select count(*) from catalog.listings');
  insert into test_results values ('T2 Client thấy đúng org mình (4/6)', n = 4);
  if n <> 4 then raise exception 'T2 FAIL: n=%', n; end if;
  raise notice 'PASS T2 — Client Viewer thấy 4/6 listing (2 shop của org mình)';
end $$;

-- T3: Super Admin thấy tất cả
do $$
declare n bigint;
begin
  n := pg_temp.count_as('authenticated', 'cccc0000-0000-4000-8000-000000000002',
    'select count(*) from catalog.listings');
  insert into test_results values ('T3 Super Admin thấy tất cả (6/6)', n = 6);
  if n <> 6 then raise exception 'T3 FAIL: n=%', n; end if;
  raise notice 'PASS T3 — Super Admin thấy 6/6 listing';
end $$;

-- T4: đã đăng nhập role authenticated nhưng KHÔNG set uid → 0 dòng
do $$
declare n bigint;
begin
  n := pg_temp.count_as('authenticated', null, 'select count(*) from catalog.listings');
  insert into test_results values ('T4 Không có uid → 0 dòng', n = 0);
  if n <> 0 then raise exception 'T4 FAIL: n=%', n; end if;
  raise notice 'PASS T4 — không uid: 0 dòng';
end $$;

-- T5: oauth_tokens — KHÔNG ai đọc được qua client (kể cả super_admin persona)
do $$
declare n bigint;
begin
  n := pg_temp.count_as('authenticated', 'cccc0000-0000-4000-8000-000000000002',
    'select count(*) from connections.oauth_tokens');
  insert into test_results values ('T5 Token OAuth bị khóa với client', n = 0);
  if n <> 0 then raise exception 'T5 FAIL: n=%', n; end if;
  raise notice 'PASS T5 — oauth_tokens: 0 dòng với authenticated (kể cả super_admin)';
end $$;

-- T6: authenticated không thể ghi bảng nghiệp vụ (chỉ service_role/worker ghi)
do $t6$
declare ok boolean;
begin
  ok := pg_temp.try_as('authenticated', 'cccc0000-0000-4000-8000-000000000001',
    $sql$insert into catalog.listings (seller_account_id, sku) values
      ('bbbb0000-0000-4000-8000-000000000001', 'HACK-1')$sql$);
  insert into test_results values ('T6 Client không ghi được listings', not ok);
  if ok then raise exception 'T6 FAIL: insert thành công (không được phép)'; end if;
  raise notice 'PASS T6 — insert listings với authenticated bị từ chối';
end $t6$;

-- T7: service_role (worker) ghi được — bypass RLS đúng thiết kế
do $$
declare n bigint;
begin
  perform set_config('request.jwt.claim.sub', '', false);
  execute 'set role service_role';
  insert into catalog.listings (seller_account_id, sku) values
    ('bbbb0000-0000-4000-8000-000000000001', 'WORKER-ROW');
  execute 'reset role';
  select count(*) into n from catalog.listings where sku = 'WORKER-ROW';
  insert into test_results values ('T7 service_role ghi được (worker)', n = 1);
  if n <> 1 then raise exception 'T7 FAIL'; end if;
  raise notice 'PASS T7 — service_role (worker đồng bộ) ghi được';
end $$;

-- T8: ghi ops.tasks cần assignment can_write=true VÀ đúng shop
do $t8$
declare ok1 boolean; ok2 boolean; ok3 boolean;
begin
  -- chưa có quyền ghi → từ chối
  ok1 := not pg_temp.try_as('authenticated', 'cccc0000-0000-4000-8000-000000000001',
    $sql$insert into ops.tasks (seller_account_id, title) values
      ('bbbb0000-0000-4000-8000-000000000001', 'T8 no-write')$sql$);
  -- cấp quyền ghi cho S1 (module orders)
  insert into iam.assignments (user_id, seller_account_id, module, can_write) values
    ('cccc0000-0000-4000-8000-000000000001', 'bbbb0000-0000-4000-8000-000000000001', 'orders', true);
  -- S1: cho phép
  ok2 := pg_temp.try_as('authenticated', 'cccc0000-0000-4000-8000-000000000001',
    $sql$insert into ops.tasks (seller_account_id, title) values
      ('bbbb0000-0000-4000-8000-000000000001', 'T8 with-write')$sql$);
  -- S2 (ngoài gán): từ chối
  ok3 := not pg_temp.try_as('authenticated', 'cccc0000-0000-4000-8000-000000000001',
    $sql$insert into ops.tasks (seller_account_id, title) values
      ('bbbb0000-0000-4000-8000-000000000002', 'T8 hack S2')$sql$);
  insert into test_results values ('T8 Ghi tasks cần can_write + đúng shop', ok1 and ok2 and ok3);
  if not (ok1 and ok2 and ok3) then raise exception 'T8 FAIL: % % %', ok1, ok2, ok3; end if;
  raise notice 'PASS T8 — ghi tasks: chặn khi chưa có quyền, cho khi có, chặn shop khác';
end $t8$;

-- T9: giá vốn effective-dated — EXCLUDE chặn khoảng chồng lấp, hàm tra đúng
do $$
declare v numeric; blocked boolean;
begin
  insert into catalog.cost_inputs (seller_account_id, sku, unit_cost, effective_from, effective_to)
    values ('bbbb0000-0000-4000-8000-000000000001', 'TEST-S1-1', 10.00, '2026-01-01', '2026-06-01');
  begin
    insert into catalog.cost_inputs (seller_account_id, sku, unit_cost, effective_from)
      values ('bbbb0000-0000-4000-8000-000000000001', 'TEST-S1-1', 9.00, '2026-03-01');
    blocked := false;
  exception when others then blocked := true;
  end;
  insert into catalog.cost_inputs (seller_account_id, sku, unit_cost, effective_from)
    values ('bbbb0000-0000-4000-8000-000000000001', 'TEST-S1-1', 11.50, '2026-06-01');
  v := catalog.effective_cost('bbbb0000-0000-4000-8000-000000000001', 'TEST-S1-1', '2026-05-15');
  insert into test_results values ('T9 Giá vốn không chồng lấp + tra đúng', blocked and v = 10.00);
  if not blocked then raise exception 'T9 FAIL: chồng lấp không bị chặn'; end if;
  if v <> 10.00 then raise exception 'T9 FAIL: effective_cost=% (kỳ vọng 10)', v; end if;
  v := catalog.effective_cost('bbbb0000-0000-4000-8000-000000000001', 'TEST-S1-1', '2026-07-01');
  if v <> 11.50 then raise exception 'T9 FAIL: effective_cost sau 01/06=% (kỳ vọng 11.5)', v; end if;
  raise notice 'PASS T9 — giá vốn: chặn chồng lấp, tra đúng theo thời điểm';
end $$;

-- T10: audit log — ghi được, đọc đúng phạm vi shop
do $$
declare n bigint;
begin
  perform set_config('request.jwt.claim.sub', '', false);
  insert into iam.audit_logs (actor_id, seller_account_id, module, action, entity)
  values ('cccc0000-0000-4000-8000-000000000001', 'bbbb0000-0000-4000-8000-000000000001', 'ads', 'test.action', 'TEST');
  n := pg_temp.count_as('authenticated', 'cccc0000-0000-4000-8000-000000000001',
    'select count(*) from iam.audit_logs');
  insert into test_results values ('T10 Audit log đọc đúng phạm vi', n = 1);
  if n <> 1 then raise exception 'T10 FAIL: n=%', n; end if;
  raise notice 'PASS T10 — audit log: operator thấy đúng 1 bản ghi shop mình';
end $$;

-- Tổng kết
do $$
declare bad int;
begin
  select count(*) into bad from test_results where not ok;
  if bad > 0 then
    raise exception 'KẾT QUẢ: % test FAIL', bad;
  end if;
  raise notice '=== TẤT CẢ % TEST PASS ===', (select count(*) from test_results);
end $$;

-- ============================================================================
-- CHỐT AN TOÀN 1: ROLLBACK — fixture test KHÔNG BAO GIỜ được ghi xuống đĩa.
-- (Trước đây là `commit;` — nguyên nhân fixture lọt vào DB production.)
-- ============================================================================
rollback;
