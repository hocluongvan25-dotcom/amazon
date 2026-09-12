-- ============================================================================
-- 0007 — SEED ADMIN + ALERTS (KHÔNG phụ thuộc auth.uid())
-- ============================================================================
-- LÝ DO:
--   seed_demo.sql mục 4 & 5 đều mở đầu bằng:
--       select auth.uid() into uid;
--       if uid is null then raise notice '...'; return; end if;
--   Trong Supabase SQL Editor KHÔNG có user session → auth.uid() = NULL
--   → cả hai mục ÂM THẦM BỎ QUA. Đã xác nhận trên project VEXIM 12/09/2026:
--       iam.user_profiles = 3  (chỉ 3 fixture của rls_test, không có user thật)
--       iam.role_assignments = 3 (không có super_admin nào)
--       ops.alerts = 0         (chuông thông báo rơi về dữ liệu mock)
--
--   File này thay thế 2 mục đó bằng cách NHẬN DANH SÁCH EMAIL TƯỜNG MINH,
--   không cần phiên đăng nhập.
--
-- IDEMPOTENT: chạy bao nhiêu lần cũng an toàn, không tạo dòng trùng.
-- THỨ TỰ: chạy SAU 0001..0006.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Đảm bảo org + departments + shop mẫu tồn tại
--    (idempotent — để bước chèn alerts không vỡ khoá ngoại nếu seed_demo
--     chưa từng chạy thành công)
-- ---------------------------------------------------------------------------
insert into iam.organizations (name, slug, is_internal)
values ('VEXIM', 'vexim', true)
on conflict (slug) do update set name = excluded.name, is_internal = excluded.is_internal;

insert into iam.departments (code, name) values
  ('ops_health',  'Vận hành & Health'),
  ('listing',     'Listing & Nội dung'),
  ('ppc',         'Quảng cáo (PPC)'),
  ('fulfillment', 'Kho vận & FBA'),
  ('orders_care', 'Đơn hàng & CSKH'),
  ('finance',     'Tài chính & Đối soát')
on conflict (code) do update set name = excluded.name;

do $$
declare v_org_id uuid; n int;
begin
  select id into v_org_id from iam.organizations where slug = 'vexim' limit 1;

  insert into connections.seller_accounts
    (org_id, seller_id, marketplace, display_name, status, data_source, health_status) values
    (v_org_id, 'A2XYZUSDEMO', 'ATVPDKIKX0DER',  'A1 · US', 'active', 'mock', 'green'),
    (v_org_id, 'A2XYZMEXDEM', 'A1AM78C64UM0Y8', 'A2 · MX', 'active', 'mock', 'yellow'),
    (v_org_id, 'B1XYZDEDEMO', 'A1PA6795UKMFR9', 'B1 · DE', 'active', 'mock', 'green'),
    (v_org_id, 'C2XYZUSDEMO', 'ATVPDKIKX0DER',  'C2 · US', 'active', 'mock', 'red'),
    (v_org_id, 'D1XYZUSDEMO', 'ATVPDKIKX0DER',  'D1 · US', 'active', 'mock', 'green'),
    (v_org_id, 'E3XYZCADEMO', 'A2EUQ1WTGCTBG2', 'E3 · CA', 'paused', 'mock', 'red')
  on conflict (seller_id, marketplace) do update
    set display_name  = excluded.display_name,
        status        = excluded.status,
        health_status = excluded.health_status;
  get diagnostics n = row_count;
  raise notice '[0007] seller_accounts upsert: % dòng', n;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Tạo iam.user_profiles cho các email admin + cấp super_admin
-- ---------------------------------------------------------------------------
-- ⚠️ THÊM/SỬA EMAIL ADMIN TẠI ĐÂY.
--    Đã điền sẵn tài khoản thật đang có trong auth.users của project VEXIM.
--    KHÔNG cấp quyền theo domain @vexim.vn — admin thật dùng gmail.
do $$
declare
  v_admin_emails text[] := array[
    'hocluongvan88@gmail.com'
    -- , 'nguoi_khac@example.com'   -- bỏ dấu comment và thêm email nếu cần
  ];
  v_org_id uuid;
  n int;
begin
  select id into v_org_id from iam.organizations where slug = 'vexim' limit 1;

  -- 2a. Tạo profile cho email admin nào đã có trong auth.users nhưng chưa có profile
  insert into iam.user_profiles (id, display_name, email, vexim_employee, org_id)
  select
    u.id,
    coalesce(
      nullif(u.raw_user_meta_data->>'full_name', ''),
      nullif(u.raw_user_meta_data->>'name', ''),
      nullif(split_part(u.email, '@', 1), ''),
      'Admin VEXIM'
    ),
    u.email,
    true,
    null            -- null = nhân viên VEXIM (không thuộc org khách hàng)
  from auth.users u
  where lower(u.email) = any (select lower(e) from unnest(v_admin_emails) e)
    and not exists (select 1 from iam.user_profiles p where p.id = u.id);
  get diagnostics n = row_count;
  raise notice '[0007] user_profiles mới tạo: %', n;

  -- 2b. Cấp super_admin.
  --     LƯU Ý: unique(user_id, role, department_id) KHÔNG chặn được trùng khi
  --     department_id = NULL (Postgres mặc định NULLS DISTINCT) → phải dùng
  --     NOT EXISTS thay vì ON CONFLICT, nếu không mỗi lần chạy sẽ thêm 1 dòng.
  insert into iam.role_assignments (user_id, role, department_id)
  select p.id, 'super_admin'::iam.app_role, null
  from iam.user_profiles p
  where lower(p.email) = any (select lower(e) from unnest(v_admin_emails) e)
    and not exists (
      select 1 from iam.role_assignments ra
      where ra.user_id = p.id
        and ra.role = 'super_admin'
        and ra.department_id is null
    );
  get diagnostics n = row_count;
  raise notice '[0007] super_admin mới cấp: %', n;

  -- 2c. Gán mọi shop cho super_admin (module account_health, có quyền ghi)
  insert into iam.assignments (user_id, seller_account_id, module, can_write, assigned_by)
  select ra.user_id, s.id, 'account_health'::iam.module_code, true, ra.user_id
  from iam.role_assignments ra
  cross join connections.seller_accounts s
  where ra.role = 'super_admin'
    and ra.department_id is null
    and not exists (
      select 1 from iam.assignments a
      where a.user_id = ra.user_id
        and a.seller_account_id = s.id
        and a.module = 'account_health'
    );
  get diagnostics n = row_count;
  raise notice '[0007] assignments (user × shop) mới tạo: %', n;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Alerts mẫu — chỉ chèn khi bảng ops.alerts đang TRỐNG
--    (không bao giờ ghi đè cảnh báo thật do worker sinh ra)
-- ---------------------------------------------------------------------------
do $$
declare
  cnt int;
  uid uuid;
  v_a1 uuid; v_a2 uuid; v_b1 uuid; v_c2 uuid; v_d1 uuid; v_e3 uuid;
  n int;
begin
  select count(*) into cnt from ops.alerts;
  if cnt > 0 then
    raise notice '[0007] ops.alerts đã có % dòng — KHÔNG chèn alerts mẫu.', cnt;
    return;
  end if;

  -- Người nhận: super_admin đầu tiên (theo created_at)
  select ra.user_id into uid
  from iam.role_assignments ra
  where ra.role = 'super_admin' and ra.department_id is null
  order by ra.created_at
  limit 1;

  if uid is null then
    raise notice '[0007] Chưa có super_admin nào — bỏ qua alerts. Kiểm tra bước 2.';
    return;
  end if;

  select id into v_a1 from connections.seller_accounts where seller_id = 'A2XYZUSDEMO' limit 1;
  select id into v_a2 from connections.seller_accounts where seller_id = 'A2XYZMEXDEM' limit 1;
  select id into v_b1 from connections.seller_accounts where seller_id = 'B1XYZDEDEMO' limit 1;
  select id into v_c2 from connections.seller_accounts where seller_id = 'C2XYZUSDEMO' limit 1;
  select id into v_d1 from connections.seller_accounts where seller_id = 'D1XYZUSDEMO' limit 1;
  select id into v_e3 from connections.seller_accounts where seller_id = 'E3XYZCADEMO' limit 1;

  insert into ops.alerts (seller_account_id, rule_id, severity, title, detail, status, assigned_to, fired_at) values
    (v_c2, null, 'red',   'ODR vượt ngưỡng 1% trên Shop C2',
      'Order Defect Rate = 1.4% · rủi ro khóa shop · case CS-10238741 đang mở',
      'open', uid, now() - interval '1 hour'),
    (v_a1, null, 'red',   'Top SKU XMO-950-BLK còn 5 ngày cover trên Shop A1',
      'Velocity 28 đơn/ngày, fulfillable 140 đơn, inbound chưa đến',
      'open', uid, now() - interval '28 minutes'),
    (v_a1, null, 'amber', 'Margin XMO-951-ACC dưới sàn',
      'Đang biên âm −2.4% sau khi đối thủ hạ giá — gợi ý theo FOEP',
      'open', uid, now() - interval '12 minutes'),
    (v_b1, null, 'amber', '2 campaign hết budget sớm trên Shop B1',
      'SP Exact và SP Broad hết budget lúc 14:20 · bỏ lỡ ~$180 doanh thu dự kiến',
      'open', uid, now() - interval '1 hour'),
    (v_e3, null, 'red',   'API E3 · CA bị paused',
      'SP-API 401 Unauthorized — token đã hết hạn, cần reconnect',
      'open', uid, now() - interval '3 hours'),
    (v_a1, null, 'amber', '8 đề xuất giá ≤2% chờ duyệt',
      'Operator tự duyệt · 4 đề xuất cần trưởng phòng (margin dưới sàn kèm lý do)',
      'open', uid, now() - interval '2 hours'),
    (v_a1, null, 'red',   '3 FBM đơn trễ hạn trên Shop A1',
      'Còn 3 giờ trước deadline ship — chủ động FBM, cần giao cho đơn vị vận chuyển',
      'open', uid, now() - interval '3 hours'),
    (v_a1, null, 'green', 'Settlement kỳ 27/08–09/09 đã về',
      '$14,820.45 về tài khoản ****4218 — sẵn sàng đối soát',
      'resolved', uid, now() - interval '1 day'),
    (v_a1, null, 'amber', 'Inbound FBA15G…9DLP lệch 7 đơn vị',
      'VPN-220 — đề xuất mở SAFE-T claim sau khi reconcile',
      'open', uid, now() - interval '4 hours');
  get diagnostics n = row_count;
  raise notice '[0007] Đã chèn % alerts mẫu cho super_admin.', n;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Kiểm chứng cuối
-- ---------------------------------------------------------------------------
do $$
declare
  n_admin int; n_profile int; n_alert int; n_assign int;
begin
  select count(*) into n_admin  from iam.role_assignments
    where role = 'super_admin' and department_id is null;
  select count(*) into n_profile from iam.user_profiles;
  select count(*) into n_alert  from ops.alerts;
  select count(*) into n_assign from iam.assignments;

  raise notice '[0007] KẾT QUẢ — super_admin:% user_profiles:% alerts:% assignments:%',
    n_admin, n_profile, n_alert, n_assign;

  if n_admin = 0 then
    raise exception '[0007] FAIL: không có super_admin nào. Email trong v_admin_emails phải TỒN TẠI trong auth.users (đã đăng ký/đăng nhập ít nhất 1 lần).';
  end if;
end $$;

commit;
