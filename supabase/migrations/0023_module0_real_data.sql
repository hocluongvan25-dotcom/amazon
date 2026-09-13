-- ============================================================================
-- 0023 — MODULE 0: ĐƯA 3 MÀN CÒN LẠI LÊN DỮ LIỆU THẬT (audit-log, sync-health, api-usage)
-- ============================================================================
-- BỐI CẢNH 13/09/2026:
--   3 màn /module0/* vẫn hiện băng vàng "DỮ LIỆU MINH HOẠ" trên production:
--     • /audit-log: đọc mảng cứng lib/data/mock.ts, trong khi iam.audit_logs đã có thật (0022)
--     • /sync-health: bảng Job đồng bộ vẫn mock, dù connections.sync_jobs đã có và worker ghi thật
--     • /api-usage: bảng api_usage_daily chưa có nguồn ghi, worker chưa từng ghi
--   Thứ tự ưu tiên fix: audit-log → sync-health → api-usage (api-usage cần worker ghi).
--
-- PHẠM VI:
--   §1 RLS cho sync_jobs và api_usage_daily (trước đó enable RLS nhưng không có policy → 0 dòng)
--   §2 Policy bổ sung cho audit_logs module iam (trước đó chỉ cho phép theo seller_account_id)
--   §3 Views public security_invoker: vexim_sync_jobs, vexim_api_usage_daily, vexim_audit_logs
--   §4 RPC public.vexim_audit_all (admin xem toàn bộ, có lọc module/search) + public.vexim_api_usage_summary
--   §5 GRANT + tự soát
-- ============================================================================

-- ============================================================================
-- 1. RLS POLICIES
-- ============================================================================

-- 1.1 sync_jobs: đọc theo quyền shop
drop policy if exists rls_read_sync_jobs on connections.sync_jobs;
create policy rls_read_sync_jobs on connections.sync_jobs
  for select to authenticated
  using (iam.can_read_seller_account(seller_account_id));

-- service_role (worker) vẫn bypass RLS, nhưng để rõ ràng vẫn cho insert/update/delete cho authenticated có can_write?
-- Theo 0001, worker dùng service_role nên không cần grant thêm, nhưng cho admin đọc được là đủ.
-- Không mở thêm insert/update cho authenticated — worker ghi bằng service_role.

-- 1.2 api_usage_daily: đọc theo quyền shop
drop policy if exists rls_read_api_usage on connections.api_usage_daily;
create policy rls_read_api_usage on connections.api_usage_daily
  for select to authenticated
  using (iam.can_read_seller_account(seller_account_id));

-- 1.3 audit_logs: bổ sung cho module iam (không có seller_account_id)
--     Policy cũ chỉ check can_read_seller_account(seller_account_id) → với seller null thì chỉ super_admin qua được.
--     Thêm policy cho phép super_admin/org_admin đọc được log module iam.
drop policy if exists rls_read_audit_logs_iam on iam.audit_logs;
create policy rls_read_audit_logs_iam on iam.audit_logs
  for select to authenticated
  using (
    module = 'iam' and iam.is_user_admin()
  );

-- Giữ policy cũ cho các module khác (theo seller)
-- rls_read_audit_logs đã tồn tại: using (iam.can_read_seller_account(seller_account_id))

-- ============================================================================
-- 2. VIEWS PUBLIC (security_invoker = true → RLS vẫn áp theo người đăng nhập)
-- ============================================================================

-- 2.1 vexim_sync_jobs — job đồng bộ gần nhất, join tên shop
create or replace view public.vexim_sync_jobs
with (security_invoker = true) as
select
  j.id,
  j.seller_account_id,
  sa.display_name as shop,
  sa.seller_id,
  sa.marketplace,
  j.job_type,
  j.status,
  j.attempts,
  j.last_error,
  j.started_at,
  j.finished_at,
  j.created_at,
  -- độ trễ tính từ finished_at hoặc started_at
  case
    when j.finished_at is not null then extract(epoch from (now() - j.finished_at))/60.0
    when j.started_at is not null then extract(epoch from (now() - j.started_at))/60.0
    else null
  end as age_minutes
from connections.sync_jobs j
join connections.seller_accounts sa on sa.id = j.seller_account_id
order by coalesce(j.started_at, j.created_at) desc;

comment on view public.vexim_sync_jobs is
  'Module 0 — Sức khỏe đồng bộ: job gần nhất, RLS theo iam.can_read_seller_account. Worker ghi bằng service_role.';

-- 2.2 vexim_api_usage_daily — chi tiết theo ngày/shop/api_group
create or replace view public.vexim_api_usage_daily
with (security_invoker = true) as
select
  u.seller_account_id,
  sa.display_name as shop,
  u.day,
  u.api_group,
  u.calls
from connections.api_usage_daily u
join connections.seller_accounts sa on sa.id = u.seller_account_id
order by u.day desc, u.calls desc;

comment on view public.vexim_api_usage_daily is
  'Module 0 — Mức dùng API theo ngày, RLS theo shop. Worker ghi qua recordApiUsage.';

-- 2.3 vexim_api_usage_summary — tổng hợp hôm nay theo api_group (cho màn api-usage)
create or replace view public.vexim_api_usage_summary
with (security_invoker = true) as
select
  u.api_group,
  sum(u.calls)::int as calls_today,
  count(distinct u.seller_account_id)::int as shops,
  max(u.day) as latest_day
from connections.api_usage_daily u
where u.day = current_date
group by u.api_group
order by calls_today desc;

comment on view public.vexim_api_usage_summary is
  'Module 0 — Tổng hợp calls hôm nay theo nhóm API (đọc từ api_usage_daily).';

-- 2.4 vexim_audit_logs — toàn bộ audit (không chỉ iam), join actor + shop
create or replace view public.vexim_audit_logs
with (security_invoker = true) as
select
  a.id,
  a.created_at,
  a.actor_id,
  up.display_name as actor_name,
  up.email as actor_email,
  a.seller_account_id,
  sa.display_name as shop,
  a.module,
  a.action,
  a.entity,
  a.before_value,
  a.after_value,
  a.result
from iam.audit_logs a
left join iam.user_profiles up on up.id = a.actor_id
left join connections.seller_accounts sa on sa.id = a.seller_account_id
order by a.created_at desc;

comment on view public.vexim_audit_logs is
  'Module 0 — Nhật ký thao tác toàn hệ thống (mọi module), RLS: iam module cần is_user_admin, các module khác theo can_read_seller_account.';

-- ============================================================================
-- 3. RPCs
-- ============================================================================

-- 3.1 vexim_audit_all — admin xem toàn bộ, có lọc module/search, limit 1..200
create or replace function public.vexim_audit_all(
  p_limit int default 100,
  p_module text default null,
  p_search text default null
)
returns table (
  id uuid,
  created_at timestamptz,
  actor_name text,
  actor_email text,
  shop text,
  module iam.module_code,
  action text,
  entity text,
  before_value jsonb,
  after_value jsonb,
  result text
)
language plpgsql
stable
security definer
set search_path = iam, public, pg_catalog
as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_module text := nullif(btrim(coalesce(p_module, '')), '');
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
begin
  -- Chỉ admin người dùng hoặc người có thể đọc ít nhất 1 shop mới xem được audit
  if not iam.is_user_admin() and not exists (
    select 1 from connections.seller_accounts sa where iam.can_read_seller_account(sa.id)
  ) then
    raise exception '[M0] bạn không có quyền xem nhật ký'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    a.id,
    a.created_at,
    up.display_name::text,
    up.email::text,
    sa.display_name::text,
    a.module,
    a.action::text,
    a.entity::text,
    a.before_value,
    a.after_value,
    a.result::text
  from iam.audit_logs a
  left join iam.user_profiles up on up.id = a.actor_id
  left join connections.seller_accounts sa on sa.id = a.seller_account_id
  where
    (v_module is null or a.module::text = v_module)
    and (
      v_search is null
      or lower(coalesce(a.entity, '')) like '%' || lower(v_search) || '%'
      or lower(coalesce(up.email, '')) like '%' || lower(v_search) || '%'
      or lower(coalesce(up.display_name, '')) like '%' || lower(v_search) || '%'
      or lower(coalesce(a.action, '')) like '%' || lower(v_search) || '%'
    )
    and (
      -- iam module: cần is_user_admin
      (a.module = 'iam' and iam.is_user_admin())
      -- các module khác: cần quyền đọc shop hoặc super_admin
      or (a.seller_account_id is not null and iam.can_read_seller_account(a.seller_account_id))
      or exists (select 1 from iam.role_assignments ra where ra.user_id = auth.uid() and ra.role = 'super_admin')
      -- trường hợp audit không có seller (cũ) nhưng là admin thì vẫn cho xem
      or (a.seller_account_id is null and iam.is_user_admin())
    )
  order by a.created_at desc
  limit v_limit;
end;
$$;

comment on function public.vexim_audit_all(int, text, text) is
  'Module 0 — Nhật ký toàn hệ thống (mọi module), có lọc module/search, RLS trong hàm.';

-- 3.2 vexim_api_usage_summary RPC (cho phép lọc theo ngày)
create or replace function public.vexim_api_usage_summary_rpc(
  p_day date default current_date
)
returns table (
  seller_account_id uuid,
  shop text,
  day date,
  api_group text,
  calls int
)
language sql
stable
security definer
set search_path = connections, iam, public, pg_catalog
as $$
  select
    u.seller_account_id,
    sa.display_name::text as shop,
    u.day,
    u.api_group::text,
    u.calls
  from connections.api_usage_daily u
  join connections.seller_accounts sa on sa.id = u.seller_account_id
  where u.day = coalesce(p_day, current_date)
    and iam.can_read_seller_account(u.seller_account_id)
  order by u.calls desc;
$$;

comment on function public.vexim_api_usage_summary_rpc(date) is
  'Module 0 — API usage theo ngày, RLS theo shop.';

-- 3.3 Worker ghi api_usage_daily: tăng calls (upsert)
create or replace function public.vexim_worker_record_api_usage(
  p_seller_account_id uuid,
  p_day date,
  p_api_group text,
  p_calls int default 1
)
returns void
language plpgsql
security definer
set search_path = connections, pg_catalog
as $$
begin
  if p_seller_account_id is null or p_day is null or p_api_group is null then
    return;
  end if;
  insert into connections.api_usage_daily (seller_account_id, day, api_group, calls)
  values (p_seller_account_id, p_day, p_api_group, greatest(coalesce(p_calls, 1), 1))
  on conflict (seller_account_id, day, api_group)
  do update set calls = connections.api_usage_daily.calls + greatest(coalesce(p_calls, 1), 1);
end;
$$;

comment on function public.vexim_worker_record_api_usage(uuid, date, text, int) is
  'Worker ghi mức dùng API: tăng calls theo ngày/shop/nhóm.';

-- ============================================================================
-- 4. GRANTS
-- ============================================================================
grant select on public.vexim_sync_jobs to authenticated, service_role;
grant select on public.vexim_api_usage_daily to authenticated, service_role;
grant select on public.vexim_api_usage_summary to authenticated, service_role;
grant select on public.vexim_audit_logs to authenticated, service_role;

revoke all on function public.vexim_audit_all(int, text, text) from public, anon;
grant execute on function public.vexim_audit_all(int, text, text) to authenticated, service_role;

revoke all on function public.vexim_api_usage_summary_rpc(date) from public, anon;
grant execute on function public.vexim_api_usage_summary_rpc(date) to authenticated, service_role;

revoke all on function public.vexim_worker_record_api_usage(uuid, date, text, int) from public, anon;
grant execute on function public.vexim_worker_record_api_usage(uuid, date, text, int) to authenticated, service_role;

-- ============================================================================
-- 5. TỰ SOÁT
-- ============================================================================
do $$
declare
  n int;
  v_def text;
begin
  -- 5.1 Policies tồn tại
  select count(*) into n from pg_policies
   where schemaname = 'connections' and tablename = 'sync_jobs' and policyname = 'rls_read_sync_jobs';
  if n <> 1 then raise exception '[0023] FAIL: thiếu policy rls_read_sync_jobs'; end if;

  select count(*) into n from pg_policies
   where schemaname = 'connections' and tablename = 'api_usage_daily' and policyname = 'rls_read_api_usage';
  if n <> 1 then raise exception '[0023] FAIL: thiếu policy rls_read_api_usage'; end if;

  select count(*) into n from pg_policies
   where schemaname = 'iam' and tablename = 'audit_logs' and policyname = 'rls_read_audit_logs_iam';
  if n <> 1 then raise exception '[0023] FAIL: thiếu policy rls_read_audit_logs_iam'; end if;

  -- 5.2 Views tồn tại
  select count(*) into n from information_schema.views
   where table_schema = 'public' and table_name in ('vexim_sync_jobs','vexim_api_usage_daily','vexim_api_usage_summary','vexim_audit_logs');
  if n <> 4 then raise exception '[0023] FAIL: thiếu view Module 0 real data: %/4', n; end if;

  -- 5.3 RPCs tồn tại
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname in ('vexim_audit_all','vexim_api_usage_summary_rpc','vexim_worker_record_api_usage');
  if n <> 3 then raise exception '[0023] FAIL: thiếu RPC Module 0: %/3', n; end if;

  -- 5.4 audit_logs không bị mở ghi thêm cho anon
  select count(*) into n from information_schema.role_table_grants
   where table_schema = 'iam' and table_name = 'audit_logs' and grantee = 'anon' and privilege_type in ('INSERT','UPDATE','DELETE');
  if n > 0 then raise exception '[0023] FAIL: anon vẫn ghi được audit_logs'; end if;

  raise notice '[0023] tự soát OK: 3 policies · 4 views · 3 RPCs · audit-log/sync-health/api-usage lên dữ liệu thật';
end $$;
