-- ============================================================================
-- 0006 — DỌN DỮ LIỆU TEST của supabase/tests/rls_test.sql
-- ============================================================================
-- LÝ DO:
--   rls_test.sql được viết để chạy trên Postgres local (xem header của file đó)
--   và kết thúc bằng `commit;` — nên khi chạy nhầm trên project Supabase thật,
--   toàn bộ fixture test bị COMMIT VĨNH VIỄN vào DB production.
--
--   Đã xác nhận trên project của VEXIM ngày 12/09/2026:
--     auth.users chứa u1@vexim.vn, u2@vexim.vn, client@dna.vn (fixture)
--       + hocluongvan88@gmail.com (user THẬT — không được đụng tới)
--     iam.organizations 3 (1 vexim thật + 2 giả 'dna'/'dnb')
--     connections.seller_accounts 9 (6 seed_demo + 3 giả A1/A2/B1SELLER)
--     catalog.listings +7 (TEST-S*-), ops.tasks +3, catalog.cost_inputs +2
--     connections.oauth_tokens +1 ('ENCRYPTED-DUMMY'), iam.audit_logs +1
--
--   Fixture dùng UUID CỐ ĐỊNH nên xoá theo id là chính xác tuyệt đối —
--   không pattern-match, không đụng dữ liệu thật.
--
-- IDEMPOTENT: chạy bao nhiêu lần cũng an toàn.
-- THỨ TỰ: chạy SAU 0001..0005, TRƯỚC 0007.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Ghi nhận số dòng trước khi dọn
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
  n_org int; n_shop int; n_user int; n_list int; n_task int;
begin
  select count(*) into n_org  from iam.organizations       where id = any (v_orgs);
  select count(*) into n_shop from connections.seller_accounts where id = any (v_shops);
  select count(*) into n_user from iam.user_profiles       where id = any (v_users);
  select count(*) into n_list from catalog.listings        where seller_account_id = any (v_shops);
  select count(*) into n_task from ops.tasks               where seller_account_id = any (v_shops);

  raise notice '[0006] TRƯỚC — org giả:% shop giả:% profile giả:% listing giả:% task giả:%',
    n_org, n_shop, n_user, n_list, n_task;

  if n_org + n_shop + n_user + n_list + n_task = 0 then
    raise notice '[0006] Không còn fixture rls_test.sql — DB sạch, các bước dưới là no-op.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Xoá theo đúng thứ tự phụ thuộc khoá ngoại.
--    Đa số FK seller_account_id là ON DELETE CASCADE, nhưng các FK trỏ tới
--    iam.user_profiles SAU ĐÂY KHÔNG cascade → phải xoá thủ công TRƯỚC:
--      iam.audit_logs.actor_id          (0001:119)
--      iam.assignments.assigned_by      (0001:111)
--      ops.tasks.assignee_id/created_by (0001:432-433)
--      ops.task_events.actor_id         (0002:35)
--      catalog.cost_inputs.imported_by  (0003:22)
--      ops.alerts.assigned_to           (0001:419)
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
  n int;
begin
  -- 1a. audit_logs theo actor (KHÔNG cascade)
  delete from iam.audit_logs where actor_id = any (v_users);
  get diagnostics n = row_count; raise notice '[0006]   iam.audit_logs          -%', n;

  -- 1b. task_events theo actor (KHÔNG cascade)
  delete from ops.task_events where actor_id = any (v_users);
  get diagnostics n = row_count; raise notice '[0006]   ops.task_events           -%', n;

  -- 1c. assignments: theo user, theo assigned_by (KHÔNG cascade), theo shop
  delete from iam.assignments
  where user_id = any (v_users)
     or assigned_by = any (v_users)
     or seller_account_id = any (v_shops);
  get diagnostics n = row_count; raise notice '[0006]   iam.assignments           -%', n;

  -- 1d. role_assignments (cascade, xoá tường minh cho rõ log)
  delete from iam.role_assignments where user_id = any (v_users);
  get diagnostics n = row_count; raise notice '[0006]   iam.role_assignments      -%', n;

  -- 1e. cost_inputs: theo shop + theo imported_by (KHÔNG cascade)
  delete from catalog.cost_inputs
  where seller_account_id = any (v_shops) or imported_by = any (v_users);
  get diagnostics n = row_count; raise notice '[0006]   catalog.cost_inputs       -%', n;

  -- 1f. tasks: theo shop + assignee_id/created_by (KHÔNG cascade)
  delete from ops.tasks
  where seller_account_id = any (v_shops)
     or assignee_id = any (v_users)
     or created_by = any (v_users);
  get diagnostics n = row_count; raise notice '[0006]   ops.tasks                 -%', n;

  -- 1g. alerts gán cho user test (assigned_to KHÔNG cascade)
  delete from ops.alerts where assigned_to = any (v_users);
  get diagnostics n = row_count; raise notice '[0006]   ops.alerts                -%', n;

  -- 1h. catalog: fees_estimates, listing_offers, listings (đều có seller_account_id)
  delete from catalog.fees_estimates where seller_account_id = any (v_shops);
  get diagnostics n = row_count; raise notice '[0006]   catalog.fees_estimates    -%', n;

  delete from catalog.listing_offers where seller_account_id = any (v_shops);
  get diagnostics n = row_count; raise notice '[0006]   catalog.listing_offers    -%', n;

  delete from catalog.listings where seller_account_id = any (v_shops);
  get diagnostics n = row_count; raise notice '[0006]   catalog.listings          -%', n;

  -- 1i. oauth_tokens fixture 'ENCRYPTED-DUMMY'
  delete from connections.oauth_tokens where seller_account_id = any (v_shops);
  get diagnostics n = row_count; raise notice '[0006]   connections.oauth_tokens  -%', n;

  -- -----------------------------------------------------------------------
  -- 2. Xoá entity gốc (sau bước 1 không còn FK nào chặn)
  -- -----------------------------------------------------------------------
  delete from iam.user_profiles where id = any (v_users);
  get diagnostics n = row_count; raise notice '[0006]   iam.user_profiles         -%', n;

  -- auth.users: CHỈ 3 id fixture cố định. User thật (hocluongvan88@gmail.com)
  -- có UUID khác nên KHÔNG bị ảnh hưởng.
  delete from auth.users where id = any (v_users);
  get diagnostics n = row_count; raise notice '[0006]   auth.users                -%', n;

  delete from connections.seller_accounts where id = any (v_shops);
  get diagnostics n = row_count; raise notice '[0006]   connections.seller_accounts -%', n;

  delete from iam.organizations where id = any (v_orgs);
  get diagnostics n = row_count; raise notice '[0006]   iam.organizations         -%', n;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Kiểm chứng — không được còn dấu vết nào
-- ---------------------------------------------------------------------------
do $$
declare leftover int;
begin
  select
    (select count(*) from iam.organizations       where id::text like 'aaaa0000-0000-4000-8000-%')
  + (select count(*) from connections.seller_accounts where id::text like 'bbbb0000-0000-4000-8000-%')
  + (select count(*) from iam.user_profiles       where id::text like 'cccc0000-0000-4000-8000-%')
  + (select count(*) from catalog.listings        where sku like 'TEST-S%')
  + (select count(*) from ops.tasks               where title like 'Test task %' or title like 'T8 %')
  into leftover;

  if leftover > 0 then
    raise exception '[0006] FAIL: vẫn còn % dòng fixture sau khi dọn', leftover;
  end if;

  raise notice '[0006] XONG. Còn lại: organizations=% seller_accounts=% user_profiles=% listings=% alerts=% auth_users=%',
    (select count(*) from iam.organizations),
    (select count(*) from connections.seller_accounts),
    (select count(*) from iam.user_profiles),
    (select count(*) from catalog.listings),
    (select count(*) from ops.alerts),
    (select count(*) from auth.users);
end $$;

commit;
