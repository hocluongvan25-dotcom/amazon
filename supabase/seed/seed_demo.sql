-- ============================================================
-- seed_demo.sql — Dữ liệu mẫu để giao diện preview có nội dung.
-- Idempotent: chạy bao nhiêu lần cũng không lỗi.
-- Chạy SAU migration 0001..0004 và SAU KHI bạn đã đăng nhập thành công
-- trên web (để auth.uid() map đúng với tài khoản của bạn).
-- ============================================================

-- 1. Tổ chức VEXIM (upsert theo slug — đảm bảo luôn có)
insert into iam.organizations (name, slug, is_internal)
values ('VEXIM', 'vexim', true)
on conflict (slug) do update set name = excluded.name, is_internal = excluded.is_internal;

-- 2. Departments (upsert theo code)
insert into iam.departments (code, name) values
  ('ops_health',  'Vận hành & Health'),
  ('listing',     'Listing & Nội dung'),
  ('ppc',         'Quảng cáo (PPC)'),
  ('fulfillment', 'Kho vận & FBA'),
  ('orders_care', 'Đơn hàng & CSKH'),
  ('finance',     'Tài chính & Đối soát')
on conflict (code) do update set name = excluded.name;

-- 3. Seller accounts — dùng DO block để lookup org id theo slug (tránh phụ thuộc UUID cứng)
do $$
declare
  v_org_id uuid;
begin
  select id into v_org_id from iam.organizations where slug = 'vexim' limit 1;

  insert into connections.seller_accounts (org_id, seller_id, marketplace, display_name, status, data_source, health_status) values
    (v_org_id, 'A2XYZUSDEMO', 'ATVPDKIKX0DER',    'A1 · US', 'active', 'mock', 'green'),
    (v_org_id, 'A2XYZMEXDEM', 'A1AM78C64UM0Y8',   'A2 · MX', 'active', 'mock', 'yellow'),
    (v_org_id, 'B1XYZDEDEMO', 'A1PA6795UKMFR9',   'B1 · DE', 'active', 'mock', 'green'),
    (v_org_id, 'C2XYZUSDEMO', 'ATVPDKIKX0DER',    'C2 · US', 'active', 'mock', 'red'),
    (v_org_id, 'D1XYZUSDEMO', 'ATVPDKIKX0DER',    'D1 · US', 'active', 'mock', 'green'),
    (v_org_id, 'E3XYZCADEMO', 'A2EUQ1WTGCTBG2',   'E3 · CA', 'paused', 'mock', 'red')
  on conflict (seller_id, marketplace) do update
    set display_name = excluded.display_name,
        status = excluded.status,
        health_status = excluded.health_status;
end $$;

-- 4. Tự tạo profile super_admin cho người đang đăng nhập (nếu chưa có)
do $$
declare
  uid uuid;
  uemail text;
  v_org_id uuid;
begin
  select auth.uid() into uid;
  if uid is null then
    raise notice 'Bạn chưa đăng nhập — bỏ qua bước tạo super_admin profile. Hãy đăng nhập trên web rồi chạy lại file này.';
    return;
  end if;

  select id into v_org_id from iam.organizations where slug = 'vexim' limit 1;
  select email into uemail from auth.users where id = uid;

  insert into iam.user_profiles (id, display_name, email, vexim_employee, org_id)
  values (
    uid,
    coalesce(split_part(uemail, '@', 1), 'Admin VEXIM'),
    coalesce(uemail, 'admin@vexim.vn'),
    true,
    v_org_id
  )
  on conflict (id) do update
    set email = excluded.email,
        org_id = coalesce(iam.user_profiles.org_id, excluded.org_id);

  insert into iam.role_assignments (user_id, role, department_id)
  values (uid, 'super_admin', null)
  on conflict (user_id, role, department_id) do nothing;

  -- Gán tất cả shop cho super_admin (module account_health với quyền ghi)
  insert into iam.assignments (user_id, seller_account_id, module, can_write, assigned_by)
  select uid, s.id, 'account_health', true, uid
  from connections.seller_accounts s
  where not exists (
    select 1 from iam.assignments a
    where a.user_id = uid
      and a.seller_account_id = s.id
      and a.module = 'account_health'
  );
end $$;

-- 5. Alerts mẫu — chỉ chèn nếu bảng alerts đang trống
do $$
declare
  uid uuid;
  cnt int;
  v_a1 uuid; v_a2 uuid; v_b1 uuid; v_c2 uuid; v_d1 uuid; v_e3 uuid;
begin
  select auth.uid() into uid;
  if uid is null then
    raise notice 'Bỏ qua chèn alerts (chưa đăng nhập).';
    return;
  end if;

  select count(*) into cnt from ops.alerts;
  if cnt > 0 then
    raise notice 'Bảng ops.alerts đã có % dòng — bỏ qua chèn alerts mẫu.', cnt;
    return;
  end if;

  -- Lookup shop ids theo seller_id (không hardcode UUID)
  select id into v_a1 from connections.seller_accounts where seller_id = 'A2XYZUSDEMO' limit 1;
  select id into v_a2 from connections.seller_accounts where seller_id = 'A2XYZMEXDEM' limit 1;
  select id into v_b1 from connections.seller_accounts where seller_id = 'B1XYZDEDEMO' limit 1;
  select id into v_c2 from connections.seller_accounts where seller_id = 'C2XYZUSDEMO' limit 1;
  select id into v_d1 from connections.seller_accounts where seller_id = 'D1XYZUSDEMO' limit 1;
  select id into v_e3 from connections.seller_accounts where seller_id = 'E3XYZCADEMO' limit 1;

  insert into ops.alerts (seller_account_id, rule_id, severity, title, detail, status, assigned_to, fired_at) values
    (v_c2, null, 'red',   'ODR vượt ngưỡng 1% trên Shop C2',
      'Order Defect Rate = 1.4% · rủi ro khóa shop · case CS-10238741 đang mở', 'open', uid, now() - interval '1 hour'),
    (v_a1, null, 'red',   'Top SKU XMO-950-BLK còn 5 ngày cover trên Shop A1',
      'Velocity 28 đơn/ngày, fulfillable 140 đơn, inbound chưa đến', 'open', uid, now() - interval '28 minutes'),
    (v_a1, null, 'amber', 'Margin XMO-951-ACC dưới sàn',
      'Đang biên âm −2.4% sau khi đối thủ hạ giá — gợi ý theo FOEP', 'open', uid, now() - interval '12 minutes'),
    (v_b1, null, 'amber', '2 campaign hết budget sớm trên Shop B1',
      'SP Exact và SP Broad hết budget lúc 14:20 · bỏ lỡ ~$180 doanh thu dự kiến', 'open', uid, now() - interval '1 hour'),
    (v_e3, null, 'red',   'API E3 · CA bị paused',
      'SP-API 401 Unauthorized — token đã hết hạn, cần reconnect', 'open', uid, now() - interval '3 hours'),
    (v_a1, null, 'amber', '8 đề xuất giá ≤2% chờ duyệt',
      'Operator tự duyệt · 4 đề xuất cần trưởng phòng (margin dưới sàn kèm lý do)', 'open', uid, now() - interval '2 hours'),
    (v_a1, null, 'red',   '3 FBM đơn trễ hạn trên Shop A1',
      'Còn 3 giờ trước deadline ship — chủ động FBM, cần giao cho đơn vị vận chuyển', 'open', uid, now() - interval '3 hours'),
    (v_a1, null, 'green', 'Settlement kỳ 27/08–09/09 đã về',
      '$14,820.45 về tài khoản ****4218 — sẵn sàng đối soát', 'resolved', uid, now() - interval '1 day'),
    (v_a1, null, 'amber', 'Inbound FBA15G…9DLP lệch 7 đơn vị',
      'VPN-220 — đề xuất mở SAFE-T claim sau khi reconcile', 'open', uid, now() - interval '4 hours');
end $$;
