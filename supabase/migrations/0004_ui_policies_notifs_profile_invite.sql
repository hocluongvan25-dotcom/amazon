-- ============================================================
-- Migration 0004 — Bổ sung RLS + helper cho UI chuông thông báo,
-- trang profile, và tạo/mời user từ giao diện (admin invite).
--
-- Chạy sau 0001_init, 0002_task_workflows, 0003_cost_inputs.
-- ============================================================

-- Bảng ops.alerts ban đầu chỉ có policy UPDATE, chưa có SELECT.
-- Thêm policy đọc: user được đọc alerts của các shop mà mình có quyền xem,
-- HOẶC alert được gán trực tiếp cho mình (assigned_to = auth.uid()).
alter table ops.alerts enable row level security;

drop policy if exists rls_sel_alerts on ops.alerts;
create policy rls_sel_alerts on ops.alerts for select to authenticated
  using (
    assigned_to = auth.uid()
    or iam.can_read_seller_account(seller_account_id)
  );

-- iam.user_profiles đã có policy đọc chính mình / super_admin đọc hết — đủ cho trang profile.
-- Bổ sung policy cho phép user cập nhật display_name/phone của chính mình (trang profile).
alter table iam.user_profiles enable row level security;

-- Thêm cột phone vào iam.user_profiles (để trang profile có thể lưu số điện thoại)
alter table iam.user_profiles add column if not exists phone text;
alter table iam.user_profiles add column if not exists avatar_url text;
alter table iam.user_profiles add column if not exists mfa_enabled boolean not null default false;
alter table iam.user_profiles add column if not exists last_login_at timestamptz;

drop policy if exists rls_upd_user_profiles_self on iam.user_profiles;
create policy rls_upd_user_profiles_self on iam.user_profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- iam.departments cho mọi user đăng nhập được xem (để render select phòng ban)
drop policy if exists rls_sel_departments_all on iam.departments;
create policy rls_sel_departments_all on iam.departments for select to authenticated
  using (true);

-- connections.seller_accounts đã có policy đọc theo phân quyền (hàm iam.can_read_seller_account),
-- nhưng để form tạo user hiển thị danh sách shop cho super_admin/org_admin, cần đảm bảo policy đó có.
-- Không thêm ở đây nếu policy tự động của shop đã phủ; kiểm tra bằng tên cố định:
drop policy if exists rls_sel_seller_accounts on connections.seller_accounts;
create policy rls_sel_seller_accounts on connections.seller_accounts for select to authenticated
  using (iam.can_read_seller_account(id));

-- iam.role_assignments và iam.assignments đã có sẵn SELECT cho chính mình/super_admin.
-- Cho phép super_admin/org_admin INSERT role_assignments + assignments khi tạo user.
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

-- Cho phép admin tạo profile cho user mới khi invite (id trong auth.users đã được tạo bởi admin invite API)
drop policy if exists rls_ins_user_profiles_admin on iam.user_profiles;
create policy rls_ins_user_profiles_admin on iam.user_profiles for insert to authenticated
  with check (
    exists (
      select 1 from iam.role_assignments ra
      where ra.user_id = auth.uid()
        and ra.role in ('super_admin','org_admin','dept_lead')
    )
  );

-- Cho phép admin cập nhật profile của user khác (khi mời user, đổi tên/phone cho nhân viên)
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

-- Tạo helper function mapping department_code → name (dễ hiển thị trên UI)
create or replace function iam.department_label(code iam.department_code)
returns text language sql stable as $$
  select case code
    when 'ops_health'   then 'Vận hành & Health'
    when 'listing'      then 'Listing & Nội dung'
    when 'ppc'          then 'Quảng cáo (PPC)'
    when 'fulfillment'  then 'Kho vận & FBA'
    when 'orders_care'  then 'Đơn hàng & CSKH'
    when 'finance'      then 'Tài chính & Đối soát'
  end
$$;

-- Helper: lấy role + department của 1 user (cho trang profile)
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
  (select ra.role from iam.role_assignments ra where ra.user_id = up.id order by ra.created_at limit 1) as role,
  (select iam.department_label(d.code)
     from iam.role_assignments ra
     join iam.departments d on d.id = ra.department_id
     where ra.user_id = up.id
     limit 1) as department
from iam.user_profiles up
where up.id = auth.uid();

-- Helper: alerts join shop label (cho chuông thông báo có đủ metadata)
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

grant select on iam.my_profile to authenticated;
grant select on iam.departments to authenticated;
grant select on ops.my_alerts to authenticated;
grant select on connections.seller_accounts to authenticated;
