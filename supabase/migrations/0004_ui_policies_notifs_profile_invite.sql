-- Migration 0004 - Bo sung RLS + helper views cho UI
-- Chay sau 0001_init, 0002_task_workflows, 0003_cost_inputs
-- Idempotent: chay lai nhieu lan khong loi.

-- 1. Bo sung cot vao iam.user_profiles (neu chua co)
alter table iam.user_profiles add column if not exists phone text;
alter table iam.user_profiles add column if not exists avatar_url text;
alter table iam.user_profiles add column if not exists mfa_enabled boolean not null default false;
alter table iam.user_profiles add column if not exists last_login_at timestamptz;

-- 2. RLS cho ops.alerts: user doc duoc alerts gan cho minh hoac thuoc shop minh co quyen xem
drop policy if exists rls_sel_alerts on ops.alerts;
create policy rls_sel_alerts on ops.alerts for select to authenticated
  using (
    assigned_to = auth.uid()
    or iam.can_read_seller_account(seller_account_id)
  );

-- 3. RLS cho iam.user_profiles
--    - user cap nhat duoc chinh minh (phone/display_name/avatar_url/mfa_enabled)
--    - super_admin/org_admin cap nhat/insert duoc user khac (khi moi nhan vien)
drop policy if exists rls_upd_user_profiles_self on iam.user_profiles;
create policy rls_upd_user_profiles_self on iam.user_profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

drop policy if exists rls_ins_user_profiles_admin on iam.user_profiles;
create policy rls_ins_user_profiles_admin on iam.user_profiles for insert to authenticated
  with check (
    exists (
      select 1 from iam.role_assignments ra
      where ra.user_id = auth.uid()
        and ra.role in ('super_admin','org_admin','dept_lead')
    )
  );

drop policy if exists rls_upd_user_profiles_admin on iam.user_profiles;
create policy rls_upd_user_profiles_admin on iam.user_profiles for update to authenticated
  using (
    id = auth.uid()
    or exists (
      select 1 from iam.role_assignments ra
      where ra.user_id = auth.uid()
        and ra.role in ('super_admin','org_admin')
    )
  )
  with check (
    id = auth.uid()
    or exists (
      select 1 from iam.role_assignments ra
      where ra.user_id = auth.uid()
        and ra.role in ('super_admin','org_admin')
    )
  );

-- 4. RLS cho iam.departments: moi authenticated user xem duoc (de render select)
drop policy if exists rls_sel_departments_all on iam.departments;
create policy rls_sel_departments_all on iam.departments for select to authenticated
  using (true);

-- 5. RLS cho connections.seller_accounts: doc theo phan quyen
drop policy if exists rls_sel_seller_accounts on connections.seller_accounts;
create policy rls_sel_seller_accounts on connections.seller_accounts for select to authenticated
  using (iam.can_read_seller_account(id));

-- 6. RLS cho iam.role_assignments va iam.assignments: admin duoc insert khi tao user
drop policy if exists rls_ins_role_assignments_admin on iam.role_assignments;
create policy rls_ins_role_assignments_admin on iam.role_assignments for insert to authenticated
  with check (
    exists (
      select 1 from iam.role_assignments ra
      where ra.user_id = auth.uid()
        and ra.role in ('super_admin','org_admin','dept_lead')
    )
  );

drop policy if exists rls_ins_assignments_admin on iam.assignments;
create policy rls_ins_assignments_admin on iam.assignments for insert to authenticated
  with check (
    exists (
      select 1 from iam.role_assignments ra
      where ra.user_id = auth.uid()
        and ra.role in ('super_admin','org_admin')
    )
  );

-- 7. Helper function: department_code -> label tieng Viet
create or replace function iam.department_label(code iam.department_code)
returns text language sql stable as $$
  select case code
    when 'ops_health'   then 'Van hanh & Health'
    when 'listing'      then 'Listing & Noi dung'
    when 'ppc'          then 'Quang cao (PPC)'
    when 'fulfillment'  then 'Kho van & FBA'
    when 'orders_care'  then 'Don hang & CSKH'
    when 'finance'      then 'Tai chinh & Doi soat'
  end
$$;

-- 8. View: profile cua chinh user dang dang nhap (co role + department)
drop view if exists iam.my_profile;
create or replace view iam.my_profile as
select
  up.id,
  up.display_name,
  up.email,
  up.phone,
  up.avatar_url,
  up.mfa_enabled,
  up.vexim_employee,
  up.org_id,
  up.created_at,
  up.last_login_at,
  (
    select ra.role
    from iam.role_assignments ra
    where ra.user_id = up.id
    order by
      case ra.role
        when 'super_admin' then 1
        when 'org_admin' then 2
        when 'dept_lead' then 3
        when 'operator' then 4
        when 'analyst' then 5
        when 'client_viewer' then 6
      end
    limit 1
  ) as role,
  (
    select iam.department_label(d.code)
    from iam.role_assignments ra
    join iam.departments d on d.id = ra.department_id
    where ra.user_id = up.id
    order by ra.created_at
    limit 1
  ) as department
from iam.user_profiles up
where up.id = auth.uid();

-- 9. View: alerts + ten shop cua user (cho chuong thong bao)
drop view if exists ops.my_alerts;
create or replace view ops.my_alerts as
select
  a.id,
  a.severity,
  a.title,
  a.detail,
  a.status,
  a.fired_at,
  a.resolved_at,
  a.assigned_to,
  a.seller_account_id,
  sa.display_name as seller_label
from ops.alerts a
left join connections.seller_accounts sa on sa.id = a.seller_account_id
where a.assigned_to = auth.uid()
   or iam.can_read_seller_account(a.seller_account_id)
order by a.fired_at desc;

-- 10. Grant select tren cac view cho authenticated
grant select on iam.my_profile to authenticated;
grant select on ops.my_alerts to authenticated;
