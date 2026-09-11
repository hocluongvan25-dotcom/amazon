-- ============================================================
-- seed_demo.sql — Dữ liệu mẫu để giao diện preview có nội dung.
-- CHẠY MỘT LẦN sau khi đã chạy đủ migration 0001..0004
-- ============================================================

-- 1. Tổ chức VEXIM (cần slug + is_internal)
insert into iam.organizations (id, name, slug, is_internal)
values ('00000000-0000-0000-0000-0000000000ff', 'VEXIM', 'vexim', true)
on conflict (slug) do nothing;

-- 2. Departments (cột đúng là code + name, không có org_id/parent_id)
insert into iam.departments (code, name) values
  ('ops_health',  'Vận hành & Health'),
  ('listing',     'Listing & Nội dung'),
  ('ppc',         'Quảng cáo (PPC)'),
  ('fulfillment', 'Kho vận & FBA'),
  ('orders_care', 'Đơn hàng & CSKH'),
  ('finance',     'Tài chính & Đối soát')
on conflict (code) do nothing;

-- 3. Seller accounts
insert into connections.seller_accounts (id, org_id, seller_id, marketplace, display_name, status, data_source, health_status) values
  ('11111111-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000ff', 'A2XYZUSDEMO', 'ATVPDKIKX0DER', 'A1 · US', 'active', 'mock', 'green'),
  ('11111111-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000ff', 'A2XYZMEXDEM', 'A1AM78C64UM0Y8', 'A2 · MX', 'active', 'mock', 'yellow'),
  ('11111111-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000ff', 'B1XYZDEDEMO', 'A1PA6795UKMFR9', 'B1 · DE', 'active', 'mock', 'green'),
  ('11111111-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000ff', 'C2XYZUSDEMO', 'ATVPDKIKX0DER', 'C2 · US', 'active', 'mock', 'red'),
  ('11111111-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000ff', 'D1XYZUSDEMO', 'ATVPDKIKX0DER', 'D1 · US', 'active', 'mock', 'green'),
  ('11111111-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000ff', 'E3XYZCADEMO', 'A2EUQ1WTGCTBG2', 'E3 · CA', 'paused', 'mock', 'red')
on conflict (id) do nothing;

-- 4. Tự tạo profile super_admin cho người đang đăng nhập
do $$
declare
  uid uuid;
  uemail text;
  vexim_org uuid;
begin
  select auth.uid() into uid;
  select id into vexim_org from iam.organizations where slug = 'vexim' limit 1;
  if uid is not null then
    select email into uemail from auth.users where id = uid;
    insert into iam.user_profiles (id, display_name, email, vexim_employee, org_id)
    values (uid, coalesce(split_part(uemail,'@',1),'Admin VEXIM'), coalesce(uemail,'admin@vexim.vn'), true, vexim_org)
    on conflict (id) do update set email = excluded.email;

    insert into iam.role_assignments (user_id, role, department_id)
    values (uid, 'super_admin', null)
    on conflict do nothing;

    insert into iam.assignments (user_id, seller_account_id, module, can_write, assigned_by)
    select uid, s.id, 'account_health', true, uid
    from connections.seller_accounts s
    where not exists (
      select 1 from iam.assignments a
      where a.user_id = uid and a.seller_account_id = s.id and a.module = 'account_health'
    );
  end if;
end $$;

-- 5. Alerts mẫu (gán cho user đang đăng nhập, chỉ khi bảng trống)
do $$
declare
  uid uuid;
  cnt int;
begin
  select auth.uid() into uid;
  select count(*) into cnt from ops.alerts;
  if uid is not null and cnt = 0 then
    insert into ops.alerts (seller_account_id, rule_id, severity, title, detail, status, assigned_to, fired_at) values
      ('11111111-0000-0000-0000-0000000000c2', null, 'red',   'ODR vượt ngưỡng 1% trên Shop C2',
        'Order Defect Rate = 1.4% · rủi ro khóa shop · case CS-10238741 đang mở', 'open', uid, now() - interval '1 hour'),
      ('11111111-0000-0000-0000-0000000000a1', null, 'red',   'Top SKU XMO-950-BLK còn 5 ngày cover trên Shop A1',
        'Velocity 28 đơn/ngày, fulfillable 140 đơn, inbound chưa đến', 'open', uid, now() - interval '28 minutes'),
      ('11111111-0000-0000-0000-0000000000a1', null, 'amber', 'Margin XMO-951-ACC dưới sàn',
        'Đang biên âm −2.4% sau khi đối thủ hạ giá — gợi ý theo FOEP', 'open', uid, now() - interval '12 minutes'),
      ('11111111-0000-0000-0000-0000000000b1', null, 'amber', '2 campaign hết budget sớm trên Shop B1',
        'SP Exact và SP Broad hết budget lúc 14:20 · bỏ lỡ ~$180 doanh thu dự kiến', 'open', uid, now() - interval '1 hour'),
      ('11111111-0000-0000-0000-0000000000e3', null, 'red',   'API E3 · CA bị paused',
        'SP-API 401 Unauthorized — token đã hết hạn, cần reconnect', 'open', uid, now() - interval '3 hours'),
      ('11111111-0000-0000-0000-0000000000a1', null, 'amber', '8 đề xuất giá ≤2% chờ duyệt',
        'Operator tự duyệt · 4 đề xuất cần trưởng phòng (margin dưới sàn kèm lý do)', 'open', uid, now() - interval '2 hours'),
      ('11111111-0000-0000-0000-0000000000a1', null, 'red',   '3 FBM đơn trễ hạn trên Shop A1',
        'Còn 3 giờ trước deadline ship — chủ động FBM, cần giao cho đơn vị vận chuyển', 'open', uid, now() - interval '3 hours'),
      ('11111111-0000-0000-0000-0000000000a1', null, 'green', 'Settlement kỳ 27/08–09/09 đã về',
        '$14,820.45 về tài khoản ****4218 — sẵn sàng đối soát', 'resolved', uid, now() - interval '1 day'),
      ('11111111-0000-0000-0000-0000000000a1', null, 'amber', 'Inbound FBA15G…9DLP lệch 7 đơn vị',
        'VPN-220 — đề xuất mở SAFE-T claim sau khi reconcile', 'open', uid, now() - interval '4 hours');
  end if;
end $$;
