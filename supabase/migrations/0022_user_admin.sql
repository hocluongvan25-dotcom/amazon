-- ============================================================================
-- 0022 — MODULE 0: QUẢN TRỊ NGƯỜI DÙNG & QUYỀN (THẬT, KHÔNG CÒN NÚT TRANG TRÍ)
-- ============================================================================
-- LÝ DO TỒN TẠI (bối cảnh 13/09/2026):
--   Màn `/module0/users` trước đây đọc một MẢNG MOCK viết cứng trong
--   `web/src/lib/data/mock.ts` (6 người: haianh@vexim.vn, tai… ) nên:
--     • người dùng thật (super_admin duy nhất: hocluongvan88@gmail.com) mở màn
--       này thấy 6 tài khoản KHÔNG TỒN TẠI và tưởng đó là nhân viên đã mời;
--     • 3 nút "Sửa / Quyền / Khóa" đều `disabled` — nhìn như lỗi phân quyền.
--   Migration này đưa màn đó lên dữ liệu THẬT + 3 thao tác THẬT có kiểm quyền,
--   có audit, và quan trọng nhất: **Khóa tài khoản = mất quyền thật ở tầng RLS**
--   (không chỉ đổi màu chip trên giao diện).
--
-- PHẠM VI
--   §1 `iam.user_profiles.status` (active | invited | suspended)
--   §2 `iam.is_user_admin()` — ai được quản trị người dùng
--   §3 QUYỀN BỊ KHÓA PHẢI MẤT THẬT: vá `iam.has_role` · `iam.current_org_id` ·
--      `iam.can_read_seller_account` · `iam.can_write_seller_account`
--   §4 5 RPC cho web: danh sách · sửa · khóa/mở · cấp quyền · nhật ký + 1 RPC cho
--      luồng mời (đi cùng `/api/admin/invite-user`)
--   §5 GRANT + RLS (không mở thêm đường ghi bảng: mọi thứ qua RPC)
--   §6 TỰ SOÁT (DO-block) — sai thì NỔ ngay, không im lặng
--
-- NGUYÊN TẮC AN TOÀN (đọc trước khi sửa):
--   • KHÔNG tự nâng quyền: không ai đổi được vai trò/trạng thái của CHÍNH MÌNH
--     (tự hạ quyền thì mất đường về; tự nâng là leo thang đặc quyền).
--   • Không ai thao tác được lên người có cấp CAO HƠN mình (org_admin không đụng
--     được super_admin) — so bằng `iam.role_level()`, không so chuỗi.
--   • Người bị `suspended` mất quyền NGAY ở tầng hàm RLS ⇒ mọi bảng/view đều chặn,
--     kể cả API — đây mới là "khóa", không phải ẩn nút.
-- ============================================================================

-- ============================================================================
-- 1. TRẠNG THÁI TÀI KHOẢN
-- ============================================================================
alter table iam.user_profiles
  add column if not exists status text not null default 'active';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'user_profiles_status_check'
       and conrelid = 'iam.user_profiles'::regclass
  ) then
    alter table iam.user_profiles
      add constraint user_profiles_status_check
      check (status in ('active','invited','suspended'));
  end if;
end $$;

-- Enum `iam.module_code` chưa có nhánh cho audit nhân sự ⇒ thêm 'iam'.
-- LƯU Ý: `alter type ... add value` cần COMMIT trước khi giá trị được DÙNG, nên
-- migration này chỉ thêm — các RPC ghi audit module 'iam' lúc chạy (transaction khác).
alter type iam.module_code add value if not exists 'iam';

comment on column iam.user_profiles.status is
  'M0: active = đang hoạt động · invited = đã mời, chưa đăng nhập lần nào · '
  'suspended = ĐÃ KHÓA (mất quyền thật ở tầng RLS, xem iam.has_role).';

-- Đăng nhập/khóa tra theo email rất nhiều ⇒ index (không unique: email có thể
-- trùng giữa nhân viên và khách hàng? KHÔNG — email là định danh đăng nhập, phải
-- duy nhất; nhưng chỉ tạo unique nếu dữ liệu hiện tại đã sạch).
create index if not exists user_profiles_email_lower_idx
  on iam.user_profiles (lower(email));

do $$
declare n int;
begin
  select count(*) into n from (
    select lower(email) from iam.user_profiles group by 1 having count(*) > 1
  ) d;
  if n = 0 and not exists (
    select 1 from pg_constraint where conname = 'user_profiles_email_lower_key'
      and conrelid = 'iam.user_profiles'::regclass
  ) then
    create unique index user_profiles_email_lower_key on iam.user_profiles (lower(email));
  end if;
end $$;

-- Backfill: hồ sơ chưa từng đăng nhập (last_login_at null) mà KHÔNG có role nào
-- ⇒ coi như lời mời còn treo. Chỉ đụng đúng nhóm đó, không sửa dữ liệu khác.
update iam.user_profiles p
   set status = 'invited'
 where p.status = 'active'
   and p.last_login_at is null
   and not exists (select 1 from iam.role_assignments ra where ra.user_id = p.id);

-- ============================================================================
-- 2. AI ĐƯỢC QUẢN TRỊ NGƯỜI DÙNG
-- ============================================================================
create or replace function iam.role_level(p_role text)
returns int
language sql immutable
as $$
  select case p_role
    when 'super_admin'   then 100
    when 'org_admin'     then 80
    when 'dept_lead'     then 50
    when 'operator'      then 30
    when 'analyst'       then 20
    when 'client_viewer' then 10
    else 0
  end;
$$;

comment on function iam.role_level(text) is
  'M0: cấp của vai trò (khớp bảng RBAC trên màn Người dùng). So bằng SỐ, không so chuỗi.';

/** Cấp CAO NHẤT của một user (0 = chưa có vai trò nào). */
create or replace function iam.user_level(p_user uuid)
returns int
language sql stable security definer
set search_path = iam, pg_catalog
as $$
  -- Cố ý KHÔNG lọc theo status: một super_admin đang bị khóa VẪN là cấp 100, nếu
  -- không thì org_admin (80) sẽ mở khóa được super_admin — đúng đường leo thang.
  -- Người bị khóa tự mất quyền qua is_user_admin()/has_role(), không qua hàm này.
  select coalesce(max(iam.role_level(ra.role::text)), 0)
    from iam.role_assignments ra
   where ra.user_id = p_user;
$$;

/** Ai được quản trị người dùng: super_admin hoặc org_admin (KHÔNG dept_lead). */
create or replace function iam.is_user_admin()
returns boolean
language sql stable security definer
set search_path = iam, pg_catalog
as $$
  select exists (
    select 1 from iam.role_assignments ra
     join iam.user_profiles p on p.id = ra.user_id
    where ra.user_id = auth.uid()
      and p.status <> 'suspended'
      and ra.role in ('super_admin','org_admin')
  );
$$;

comment on function iam.is_user_admin() is
  'M0: người đang đăng nhập là super_admin/org_admin KHÔNG BỊ KHÓA ⇒ được sửa '
  'hồ sơ · khóa/mở · cấp vai trò người khác (vẫn bị chặn bởi cấp bậc, xem vem_…).';

grant execute on function iam.role_level(text)  to authenticated, service_role;
grant execute on function iam.user_level(uuid)  to authenticated, service_role;
grant execute on function iam.is_user_admin()   to authenticated, service_role;

-- ============================================================================
-- 3. KHÓA = MẤT QUYỀN THẬT (vá 4 hàm lõi mà MỌI policy/RPC đang dựa vào)
-- ============================================================================
-- Vì sao vá ở đây: 4 hàm này là "cửa" của toàn bộ RLS. Chỉ cần mỗi hàm thêm điều
-- kiện `status = 'active'` là MỌI bảng/view/route đều tự chặn người bị khóa —
-- kể cả khi họ còn giữ cookie phiên hợp lệ (Supabase không thu hồi JWT ngay).
create or replace function iam.has_role(p_roles text[])
returns boolean
language sql stable security definer
set search_path = iam, pg_catalog
as $$
  select exists (
    select 1 from iam.role_assignments ra
     join iam.user_profiles p on p.id = ra.user_id
    where ra.user_id = auth.uid()
      and p.status <> 'suspended'      -- M0: CHỈ tài khoản bị khóa mới mất vai trò
                                       -- (người vừa được mời vẫn phải vào được hệ thống)
      and ra.role::text = any (p_roles)
  );
$$;

comment on function iam.has_role(text[]) is
  'M5 P3 + M0: user hiện tại có một trong các vai trò này không. SECURITY DEFINER để '
  'policy dùng được mà không đệ quy. Tài khoản suspended ⇒ LUÔN false (khóa là mất quyền); '
  'tài khoản invited/active vẫn làm việc bình thường.';

create or replace function iam.current_org_id()
returns uuid
language sql stable security definer
set search_path = iam, pg_catalog
as $$
  select up.org_id from iam.user_profiles up
   where up.id = auth.uid() and up.status <> 'suspended';
$$;

create or replace function iam.can_read_seller_account(p_seller uuid)
returns boolean
language sql stable security definer
set search_path = iam, connections, pg_catalog
as $$
  select exists (
           select 1 from iam.user_profiles p
            where p.id = auth.uid() and p.status <> 'suspended'
         )
     and (
       exists (select 1 from iam.role_assignments ra
                where ra.user_id = auth.uid() and ra.role = 'super_admin')
       or exists (select 1 from connections.seller_accounts sa
                   join iam.user_profiles up on up.id = auth.uid()
                  where sa.id = p_seller and up.org_id = sa.org_id
                    and up.status <> 'suspended')
       or exists (select 1 from iam.assignments a
                   where a.user_id = auth.uid() and a.seller_account_id = p_seller)
     );
$$;

comment on function iam.can_read_seller_account(uuid) is
  'M0: đọc được shop này không. Tài khoản suspended ⇒ false (mất quyền thật, không phải ẩn UI).';

create or replace function iam.can_write_seller_account(p_seller uuid)
returns boolean
language sql stable security definer
set search_path = iam, pg_catalog
as $$
  select exists (
           select 1 from iam.user_profiles p
            where p.id = auth.uid() and p.status <> 'suspended'
         )
     and (
       exists (select 1 from iam.role_assignments ra
                where ra.user_id = auth.uid() and ra.role = 'super_admin')
       or exists (select 1 from iam.assignments a
                   where a.user_id = auth.uid() and a.seller_account_id = p_seller
                     and a.can_write = true)
     );
$$;

comment on function iam.can_write_seller_account(uuid) is
  'M0: ghi được shop này không. Tài khoản suspended ⇒ false.';

-- ============================================================================
-- 4. RPC CHO WEB
-- ============================================================================
-- 4.1 Danh sách người dùng THẬT (không phải view: đây là dữ liệu nhân sự, chỉ
--     admin đọc được; view `security_invoker` sẽ phải mở RLS rộng hơn).
create or replace function public.vexim_admin_users()
returns table (
  user_id uuid,
  email text,
  display_name text,
  phone text,
  status text,
  role text,
  role_level int,
  roles text[],
  department text,
  department_code text,
  shop_count int,
  shop_ids uuid[],
  can_write_shops boolean,
  vexim_employee boolean,
  org_name text,
  last_login_at timestamptz,
  last_sign_in_at timestamptz,
  created_at timestamptz,
  is_self boolean
)
language plpgsql
stable
security definer
set search_path = iam, connections, auth, public, pg_catalog
as $$
begin
  if auth.uid() is null then
    raise exception '[M0] cần đăng nhập' using errcode = 'insufficient_privilege';
  end if;
  -- CHỈ admin người dùng. Cố ý không nới thành "ai có hồ sơ cũng xem được": hàm này
  -- trả TOÀN BỘ danh sách nhân sự (email, phòng, quyền) — đó là dữ liệu quản trị.
  -- Người khác bị TỪ CHỐI, không trả bảng rỗng (rỗng khiến tưởng "chưa có ai").
  if not iam.is_user_admin() then
    raise exception '[M0] chỉ super_admin/org_admin xem được danh sách người dùng'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    p.id,
    p.email,
    p.display_name,
    p.phone,
    p.status,
    coalesce(highest.role, '')                as role,
    coalesce(highest.lvl, 0)                  as role_level,
    coalesce(agg.roles, array[]::text[])      as roles,
    coalesce(agg.department, '')              as department,
    coalesce(agg.department_code, '')         as department_code,
    coalesce(cnt.shops, 0)::int               as shop_count,
    coalesce(cnt.shop_ids, array[]::uuid[])   as shop_ids,
    coalesce(cnt.can_write, false)            as can_write_shops,
    p.vexim_employee,
    o.name                                    as org_name,
    p.last_login_at,
    -- Đọc qua jsonb để KHÔNG phụ thuộc phiên bản GoTrue (có bản không có cột này).
    (to_jsonb(u.*) ->> 'last_sign_in_at')::timestamptz as last_sign_in_at,
    p.created_at,
    (p.id = auth.uid())                       as is_self
  from iam.user_profiles p
  left join iam.organizations o on o.id = p.org_id
  left join auth.users u on u.id = p.id
  left join lateral (
    select array_agg(ra.role::text order by iam.role_level(ra.role::text) desc) as roles,
           max(iam.role_level(ra.role::text))                                      as lvl,
           (array_agg(ra.role::text order by iam.role_level(ra.role::text) desc))[1] as role,
           max(d.name)                                                             as department,
           max(d.code::text)                                                       as department_code
      from iam.role_assignments ra
      left join iam.departments d on d.id = ra.department_id
     where ra.user_id = p.id
  ) agg on true
  left join lateral (
    select agg.role as role, agg.lvl as lvl
  ) highest on true
  left join lateral (
    select count(distinct a.seller_account_id)                        as shops,
           array_agg(distinct a.seller_account_id)                    as shop_ids,
           bool_or(a.can_write)                                       as can_write
      from iam.assignments a
     where a.user_id = p.id
  ) cnt on true
  -- Người đang đăng nhập luôn lên đầu; sau đó theo cấp quyền giảm dần.
  order by (p.id = auth.uid()) desc, coalesce(highest.lvl, 0) desc, p.created_at;
end;
$$;

comment on function public.vexim_admin_users() is
  'M0: danh sách người dùng THẬT (hồ sơ + vai trò + phòng + shop được gán + lần đăng '
  'nhập cuối). Trả kèm `shop_ids` để hộp thoại Phân quyền CHỌN SẴN đúng shop hiện có — '
  'thiếu nó thì lần lưu nào cũng ghi đè danh sách shop về rỗng. Chỉ admin người dùng '
  'gọi được; người khác bị TỪ CHỐI, không trả rỗng.';

-- 4.2 Sửa hồ sơ / khóa / mở khóa
create or replace function public.vexim_admin_update_user(
  p_user_id      uuid,
  p_display_name text default null,
  p_phone        text default null,
  p_status       text default null
)
returns table (user_id uuid, status text, message text)
language plpgsql
security definer
set search_path = iam, public, pg_catalog
as $$
#variable_conflict use_column
declare
  v_actor     uuid := auth.uid();
  v_actor_lvl int;
  v_target    iam.user_profiles%rowtype;
  v_target_lvl int;
  v_name      text := nullif(btrim(coalesce(p_display_name, '')), '');
  v_phone     text := nullif(btrim(coalesce(p_phone, '')), '');
  v_status    text := nullif(btrim(coalesce(p_status, '')), '');
begin
  if v_actor is null then
    raise exception '[M0] cần đăng nhập' using errcode = 'insufficient_privilege';
  end if;
  if not iam.is_user_admin() then
    raise exception '[M0] chỉ super_admin/org_admin được sửa người dùng'
      using errcode = 'insufficient_privilege';
  end if;
  if v_status is not null and v_status not in ('active','invited','suspended') then
    raise exception '[M0] trạng thái không hợp lệ: %', v_status
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_target from iam.user_profiles p where p.id = p_user_id;
  if not found then
    raise exception '[M0] không có người dùng %', p_user_id using errcode = 'no_data_found';
  end if;

  v_actor_lvl  := iam.user_level(v_actor);
  v_target_lvl := iam.user_level(p_user_id);

  -- Tự khóa mình = tự loại mình khỏi hệ thống (không ai mở lại được nếu chỉ có
  -- 1 admin) ⇒ chặn. Tự sửa tên/điện thoại thì được.
  if p_user_id = v_actor and v_status = 'suspended' then
    raise exception '[M0] không thể tự khóa tài khoản của chính mình'
      using errcode = 'invalid_parameter_value';
  end if;
  -- Không đụng được người có cấp cao hơn (org_admin không sửa super_admin).
  if p_user_id <> v_actor and v_target_lvl > v_actor_lvl then
    raise exception '[M0] không thể sửa người có cấp quyền CAO HƠN mình'
      using errcode = 'insufficient_privilege';
  end if;
  -- Chỉ super_admin được đụng vào super_admin khác.
  if v_target_lvl >= 100 and v_actor_lvl < 100 then
    raise exception '[M0] chỉ super_admin được thay đổi super_admin khác'
      using errcode = 'insufficient_privilege';
  end if;

  update iam.user_profiles p
     set display_name = coalesce(v_name, p.display_name),
         phone        = coalesce(v_phone, p.phone),
         status       = coalesce(v_status, p.status)
   where p.id = p_user_id;

  insert into iam.audit_logs (actor_id, module, action, entity, before_value, after_value, result)
  values (v_actor, 'iam',
          case
            when v_status = 'suspended' then 'user.suspend'
            when v_status = 'active'    then 'user.activate'
            else 'user.update'
          end,
          v_target.email,
          jsonb_build_object('display_name', v_target.display_name, 'phone', v_target.phone,
                             'status', v_target.status),
          jsonb_build_object('display_name', coalesce(v_name, v_target.display_name),
                             'phone', coalesce(v_phone, v_target.phone),
                             'status', coalesce(v_status, v_target.status)),
          'ok');

  return query select p_user_id, coalesce(v_status, v_target.status),
    case
      when v_status = 'suspended' then 'Đã khóa: người này mất quyền ngay ở tầng dữ liệu.'
      when v_status = 'active'    then 'Đã mở khóa: quyền theo vai trò hiện có được phục hồi.'
      else 'Đã lưu thông tin.'
    end;
end;
$$;

comment on function public.vexim_admin_update_user(uuid, text, text, text) is
  'M0: sửa hồ sơ + khóa/mở khóa tài khoản (audit user.update/suspend/activate). '
  'Chặn: tự khóa mình · đụng người cấp cao hơn · org_admin đụng super_admin.';

-- 4.3 Cấp quyền: vai trò + phòng + phạm vi shop (một lời gọi = một trạng thái rõ)
create or replace function public.vexim_admin_set_user_access(
  p_user_id    uuid,
  p_role       text,
  p_department text default null,
  p_shop_ids   uuid[] default null
)
returns table (user_id uuid, role text, department text, shop_count int, message text)
language plpgsql
security definer
set search_path = iam, connections, public, pg_catalog
as $$
#variable_conflict use_column
declare
  v_actor       uuid := auth.uid();
  v_actor_lvl   int;
  v_target      iam.user_profiles%rowtype;
  v_target_lvl  int;
  v_role        text := nullif(btrim(coalesce(p_role, '')), '');
  v_dept_code   text := nullif(btrim(coalesce(p_department, '')), '');
  v_dept_id     uuid;
  v_dept_name   text;
  v_shops       uuid[] := coalesce(p_shop_ids, array[]::uuid[]);
  v_shop_count  int := 0;
  v_can_write   boolean;
  v_modules     iam.module_code[];
  v_shop        uuid;
  v_mod         iam.module_code;
  v_is_admin    boolean;
  v_actor_dept  text;
begin
  if v_actor is null then
    raise exception '[M0] cần đăng nhập' using errcode = 'insufficient_privilege';
  end if;
  v_is_admin := iam.is_user_admin();
  if not v_is_admin then
    -- Trưởng phòng cũng cấp quyền được, nhưng CHỈ trong phòng mình; luật "chỉ gán
    -- được vai trò thấp hơn mình" ở dưới vẫn là chốt chặn cuối.
    if not iam.has_role(array['dept_lead']) then
      raise exception '[M0] chỉ super_admin/org_admin/trưởng phòng được cấp quyền'
        using errcode = 'insufficient_privilege';
    end if;
    select d.code::text into v_actor_dept
      from iam.role_assignments ra
      join iam.departments d on d.id = ra.department_id
     where ra.user_id = v_actor and ra.role = 'dept_lead'
     limit 1;
    if v_actor_dept is null then
      raise exception '[M0] trưởng phòng chưa được gán phòng ⇒ không thể cấp quyền'
        using errcode = 'insufficient_privilege';
    end if;
    if coalesce(v_dept_code, '') <> v_actor_dept then
      raise exception '[M0] trưởng phòng chỉ cấp quyền trong phòng của mình (%)', v_actor_dept
        using errcode = 'insufficient_privilege';
    end if;
    -- Người đã có vai trò ở phòng khác thì trưởng phòng không được đụng vào.
    if exists (select 1 from iam.role_assignments ra where ra.user_id = p_user_id)
       and not exists (
         select 1 from iam.role_assignments ra
          join iam.departments d on d.id = ra.department_id
         where ra.user_id = p_user_id and d.code::text = v_actor_dept
       ) then
      raise exception '[M0] người này không thuộc phòng % của bạn', v_actor_dept
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  if v_role is null or iam.role_level(v_role) = 0 then
    raise exception '[M0] vai trò không hợp lệ: %', coalesce(v_role, '(rỗng)')
      using errcode = 'invalid_parameter_value';
  end if;

  v_actor_lvl  := iam.user_level(v_actor);
  v_target_lvl := iam.user_level(p_user_id);

  -- Không tự đổi vai trò mình: tự hạ = mất đường về, tự nâng = leo thang đặc quyền.
  if p_user_id = v_actor then
    raise exception '[M0] không thể tự đổi vai trò của chính mình — nhờ một admin khác'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_target_lvl > v_actor_lvl then
    raise exception '[M0] không thể đổi quyền người có cấp CAO HƠN mình'
      using errcode = 'insufficient_privilege';
  end if;
  -- Chỉ gán được vai trò THẤP HƠN mình (khớp ma trận canAssign của /api/admin/invite-user).
  if iam.role_level(v_role) >= v_actor_lvl then
    raise exception '[M0] không thể gán vai trò ngang hoặc cao hơn cấp của mình (%)',
      v_role using errcode = 'insufficient_privilege';
  end if;

  select * into v_target from iam.user_profiles p where p.id = p_user_id;
  if not found then
    raise exception '[M0] không có người dùng %', p_user_id using errcode = 'no_data_found';
  end if;
  if v_target.status = 'suspended' then
    raise exception '[M0] tài khoản đang bị KHÓA — mở khóa trước rồi mới cấp quyền'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Phòng ban: bắt buộc với các vai trò vận hành (trừ admin và khách hàng xem).
  if v_dept_code is not null then
    select d.id, d.code::text, d.name into v_dept_id, v_dept_code, v_dept_name
      from iam.departments d where d.code::text = v_dept_code;
    if not found then
      raise exception '[M0] không có phòng ban mã %', v_dept_code
        using errcode = 'no_data_found';
    end if;
  elsif v_role in ('dept_lead','operator','analyst') then
    raise exception '[M0] vai trò % phải thuộc một phòng ban', v_role
      using errcode = 'invalid_parameter_value';
  end if;

  -- 4.3a Thay vai trò: dọn vai trò cũ của user rồi gán vai trò mới (UI quản 1 vai
  --      trò/người; nhiều vai trò vẫn đọc được ở cột roles[]).
  delete from iam.role_assignments ra where ra.user_id = p_user_id;
  insert into iam.role_assignments (user_id, role, department_id)
  values (p_user_id, v_role::iam.app_role, v_dept_id);

  -- 4.3b Phạm vi shop: xoá gán cũ, gán lại theo danh sách mới. `super_admin` không
  --      cần assignment (RLS cho toàn quyền) nên bỏ qua để tránh rác.
  delete from iam.assignments a where a.user_id = p_user_id;
  v_can_write := v_role in ('dept_lead','operator');
  if v_role <> 'super_admin' and array_length(v_shops, 1) is not null then
    -- Module nào cũng gán: người của phòng nào thì RLS theo module đó, nhưng bảng
    -- `iam.assignments` không có "phòng" nên gán đủ 8 module là cách duy nhất để
    -- một người phụ trách shop ở đúng mảng của mình mà không phải khai lại.
    v_modules := array['orders','listings','pricing','inventory','ads','finance','account_health','tasks']::iam.module_code[];
    foreach v_shop in array v_shops loop
      if not exists (select 1 from connections.seller_accounts sa where sa.id = v_shop) then
        raise exception '[M0] shop % không tồn tại', v_shop using errcode = 'no_data_found';
      end if;
      v_shop_count := v_shop_count + 1;
      foreach v_mod in array v_modules loop
        insert into iam.assignments (user_id, seller_account_id, module, can_write, assigned_by)
        values (p_user_id, v_shop, v_mod, v_can_write, v_actor)
        on conflict (user_id, seller_account_id, module) do update
          set can_write = excluded.can_write;
      end loop;
    end loop;
  end if;

  insert into iam.audit_logs (actor_id, module, action, entity, before_value, after_value, result)
  values (v_actor, 'iam', 'user.role_change', v_target.email,
          jsonb_build_object('role_level', v_target_lvl, 'shop_count', (
            select count(distinct a.seller_account_id) from iam.assignments a
             where a.user_id = p_user_id and a.assigned_by is distinct from v_actor
          )),
          jsonb_build_object('role', v_role, 'department', v_dept_code,
                             'shop_count', v_shop_count, 'can_write', v_can_write),
          'ok');

  return query
  select h.user_id, h.role, h.department, h.shop_count, h.message
    from (values (p_user_id, v_role, coalesce(v_dept_name, '—'), v_shop_count,
    case
      when v_role = 'super_admin'
        then 'Đã cấp super_admin: toàn quyền hệ thống, KHÔNG cần gán shop.'
      when v_shop_count = 0
        then 'Đã gán vai trò nhưng CHƯA gán shop nào ⇒ người này chưa thấy dữ liệu shop nào.'
      else format('Đã gán vai trò + %s shop (quyền ghi: %s).', v_shop_count,
                  case when v_can_write then 'có' else 'chỉ đọc' end)
    end)) as h(user_id, role, department, shop_count, message);
end;
$$;

comment on function public.vexim_admin_set_user_access(uuid, text, text, uuid[]) is
  'M0: đổi vai trò + phòng ban + phạm vi shop của một người (audit user.role_change). '
  'Người gọi: super_admin/org_admin (mọi phòng) hoặc trưởng phòng (CHỈ trong phòng mình). '
  'Chặn: tự đổi mình · gán vai trò ≥ cấp của mình · sửa người cấp cao hơn · vai trò '
  'vận hành mà thiếu phòng ban · tài khoản đang bị khóa.';

-- 4.4 Nhật ký thao tác quản trị (cho khối "Nhật ký" dưới màn Người dùng)
create or replace function public.vexim_admin_audit(
  p_limit int default 50,
  p_user  text default null
)
returns table (
  id uuid, created_at timestamptz, actor_name text, actor_email text,
  action text, entity text, before_value jsonb, after_value jsonb, result text
)
language plpgsql
stable
security definer
set search_path = iam, public, pg_catalog
as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_user  text := nullif(btrim(coalesce(p_user, '')), '');
begin
  if not iam.is_user_admin() then
    raise exception '[M0] chỉ super_admin/org_admin xem được nhật ký quản trị'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select a.id, a.created_at, up.display_name, up.email, a.action, a.entity,
         a.before_value, a.after_value, a.result
    from iam.audit_logs a
    left join iam.user_profiles up on up.id = a.actor_id
   where a.module = 'iam'
     and (v_user is null or lower(a.entity) = lower(v_user))
   order by a.created_at desc
   limit v_limit;
end;
$$;

comment on function public.vexim_admin_audit(int, text) is
  'M0: nhật ký thao tác quản trị người dùng (module iam) — ai đổi gì, cho ai, lúc nào. '
  'Không xoá được (iam.audit_logs là append-only).';

-- 4.5 Hoàn tất lời mời (đi cùng /api/admin/invite-user: GoTrue tạo tài khoản auth,
--     còn hồ sơ + vai trò + shop + audit ghi ở đây để kiểm quyền ở DB, không ở route).
create or replace function public.vexim_admin_grant_invited_user(
  p_user_id      uuid,
  p_email        text,
  p_display_name text,
  p_phone        text default null,
  p_role         text default 'operator',
  p_department   text default null,
  p_shop_ids     uuid[] default null
)
returns table (user_id uuid, email text, role text, status text, message text)
language plpgsql
security definer
set search_path = iam, public, pg_catalog
as $$
#variable_conflict use_column
declare
  v_email      text := lower(btrim(coalesce(p_email, '')));
  v_name       text := nullif(btrim(coalesce(p_display_name, '')), '');
  v_role       text := coalesce(nullif(btrim(coalesce(p_role, '')), ''), 'operator');
  v_is_admin   boolean;
  v_actor_dept text;
  v_res        record;
begin
  v_is_admin := iam.is_user_admin();
  -- Trưởng phòng được mời người cho PHÒNG MÌNH (năng lực này có từ 0004/route cũ);
  -- không phải admin thì vẫn bị luật cấp bậc chặn ở dưới (chỉ gán được vai trò
  -- thấp hơn mình) và phải ĐÚNG phòng của mình.
  if not v_is_admin then
    if not iam.has_role(array['dept_lead']) then
      raise exception '[M0] chỉ super_admin/org_admin/trưởng phòng được mời người dùng'
        using errcode = 'insufficient_privilege';
    end if;
    select d.code::text into v_actor_dept
      from iam.role_assignments ra
      join iam.departments d on d.id = ra.department_id
     where ra.user_id = auth.uid() and ra.role = 'dept_lead'
     limit 1;
    if p_department is distinct from v_actor_dept then
      raise exception '[M0] trưởng phòng chỉ mời được người cho phòng của mình (%)',
        coalesce(v_actor_dept, 'chưa gán phòng') using errcode = 'insufficient_privilege';
    end if;
  end if;
  if v_email = '' or v_name is null then
    raise exception '[M0] thiếu email hoặc tên hiển thị' using errcode = 'invalid_parameter_value';
  end if;

  -- Người đang bị khóa: KHÔNG tự mở khóa qua đường mời (mở khóa là quyết định riêng,
  -- có audit riêng) — báo lỗi rõ ràng thay vì lặng lẽ hồi sinh tài khoản.
  if exists (
    select 1 from iam.user_profiles p
     where p.id = p_user_id and p.status = 'suspended'
  ) then
    raise exception '[M0] % đang bị KHÓA — mở khóa ở nút "Mở khóa" trước khi cấp lại quyền',
      v_email using errcode = 'invalid_parameter_value';
  end if;

  -- Hồ sơ: nếu đã có (mời lại / user tự đăng nhập trước) thì cập nhật, không tạo trùng.
  insert into iam.user_profiles (id, display_name, email, phone, vexim_employee, org_id, status)
  values (p_user_id, v_name, v_email, nullif(btrim(coalesce(p_phone, '')), ''),
          v_role <> 'client_viewer', null, 'invited')
  on conflict (id) do update
    set display_name = excluded.display_name,
        email        = excluded.email,
        phone        = coalesce(excluded.phone, iam.user_profiles.phone),
        vexim_employee = excluded.vexim_employee,
        status       = 'invited';   -- đã chặn ở trên nếu hồ sơ đang 'suspended'

  -- Cấp quyền qua đúng hàm đã kiểm cấp bậc (không viết lại luật ở hai nơi).
  select * into v_res from public.vexim_admin_set_user_access(
    p_user_id, v_role, p_department, p_shop_ids
  );

  insert into iam.audit_logs (actor_id, module, action, entity, after_value, result)
  values (auth.uid(), 'iam', 'user.invite', v_email,
          jsonb_build_object('role', v_role, 'department', p_department,
                             'shop_count', coalesce(v_res.shop_count, 0)),
          'ok');

  return query select p_user_id, v_email, v_role,
    (select p.status from iam.user_profiles p where p.id = p_user_id),
    'Đã tạo hồ sơ + quyền. Người được mời sẽ nhận email đặt mật khẩu.';
end;
$$;

comment on function public.vexim_admin_grant_invited_user(uuid, text, text, text, text, text, uuid[]) is
  'M0: ghi hồ sơ + vai trò + shop cho tài khoản auth vừa được GoTrue mời. Quyền được '
  'kiểm ở DB (iam.is_user_admin + cấp bậc), route /api/admin/invite-user không tự quyết.';

-- 4.6 "Điểm danh" lần đăng nhập: người mới được mời đăng nhập lần đầu thì hồ sơ
--     chuyển `invited` → `active` và ghi `last_login_at`. Trước 0022 KHÔNG có chỗ
--     nào ghi 2 thông tin này ⇒ màn Người dùng mãi hiển thị "chưa đăng nhập".
create or replace function public.vexim_touch_login()
returns table (status text, last_login_at timestamptz, changed boolean)
language plpgsql
security definer
set search_path = iam, public, pg_catalog
as $$
declare
  v_row iam.user_profiles%rowtype;
  v_changed boolean := false;
begin
  if auth.uid() is null then
    return;   -- chưa đăng nhập ⇒ không có gì để điểm danh
  end if;

  select * into v_row from iam.user_profiles p where p.id = auth.uid();
  if not found then
    return;   -- tài khoản auth chưa có hồ sơ (đang trong luồng mời) ⇒ bỏ qua
  end if;

  -- Chỉ ghi khi thật sự cần: tránh 1 lượt UPDATE mỗi lần tải trang.
  if v_row.status = 'invited' or v_row.last_login_at is null
     or v_row.last_login_at < now() - interval '5 minutes' then
    update iam.user_profiles p
       set status = case when p.status = 'invited' then 'active' else p.status end,
           last_login_at = now()
     where p.id = auth.uid();
    v_changed := true;
  end if;

  select * into v_row from iam.user_profiles p where p.id = auth.uid();
  return query select v_row.status, v_row.last_login_at, v_changed;
end;
$$;

comment on function public.vexim_touch_login() is
  'M0: điểm danh lần đăng nhập — hồ sơ invited ⇒ active + last_login_at = now(). '
  'Không đụng gì tới tài khoản đang suspended. Gọi 1 lần mỗi lần tải trang trong app.';

-- ============================================================================
-- 5. GRANT
-- ============================================================================
-- 5.1 Vá một lỗ HỞ ÂM THẦM của 0001/0004: policy `rls_upd_user_profiles_self`
--     (user tự sửa hồ sơ mình) đã có từ 0004, nhưng role `authenticated` chỉ được
--     GRANT SELECT trên iam.user_profiles ⇒ màn "Thông tin cá nhân" ở chế độ
--     Supabase cập nhật là bị `permission denied` (tính năng có policy mà không chạy).
--     Cấp ĐÚNG các cột được phép sửa — không cấp cả bảng, nên không thể đổi email,
--     org_id, vexim_employee qua đường này. RLS vẫn giới hạn ở hồ sơ CỦA MÌNH.
grant update (display_name, phone, avatar_url, mfa_enabled)
  on iam.user_profiles to authenticated;

revoke all on function public.vexim_admin_users()                                  from public, anon;
revoke all on function public.vexim_admin_update_user(uuid, text, text, text)       from public, anon;
revoke all on function public.vexim_admin_set_user_access(uuid, text, text, uuid[]) from public, anon;
revoke all on function public.vexim_admin_audit(int, text)                          from public, anon;
revoke all on function public.vexim_admin_grant_invited_user(uuid, text, text, text, text, text, uuid[]) from public, anon;
revoke all on function public.vexim_touch_login()                                          from public, anon;

grant execute on function public.vexim_admin_users()                                  to authenticated, service_role;
grant execute on function public.vexim_admin_update_user(uuid, text, text, text)       to authenticated, service_role;
grant execute on function public.vexim_admin_set_user_access(uuid, text, text, uuid[]) to authenticated, service_role;
grant execute on function public.vexim_admin_audit(int, text)                          to authenticated, service_role;
grant execute on function public.vexim_admin_grant_invited_user(uuid, text, text, text, text, text, uuid[]) to authenticated, service_role;
grant execute on function public.vexim_touch_login()                                         to authenticated, service_role;

-- ============================================================================
-- 6. TỰ SOÁT — migration sai thì NỔ ngay
-- ============================================================================
do $$
declare
  n int;
  v_admin uuid;
  v_other uuid;
  v_before text;
  v_after  boolean;
begin
  -- 6.1 cột status tồn tại + mặc định 'active'
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'iam' and table_name = 'user_profiles' and column_name = 'status'
  ) then
    raise exception '[0022] FAIL: thiếu cột iam.user_profiles.status';
  end if;

  -- 6.2 hàm mới tồn tại
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'iam'
     and p.proname in ('role_level','user_level','is_user_admin');
  if n <> 3 then
    raise exception '[0022] FAIL: thiếu hàm iam (role_level/user_level/is_user_admin): %/3', n;
  end if;

  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and p.proname in ('vexim_admin_users','vexim_admin_update_user','vexim_admin_set_user_access',
                       'vexim_admin_audit','vexim_admin_grant_invited_user','vexim_touch_login');
  if n <> 6 then
    raise exception '[0022] FAIL: thiếu RPC quản trị người dùng: %/6', n;
  end if;

  -- 6.3 authenticated gọi được (RPC tự kiểm quyền bên trong)
  for n in
    select p.oid from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.proname in ('vexim_admin_users','vexim_admin_update_user','vexim_admin_set_user_access',
                         'vexim_admin_audit','vexim_admin_grant_invited_user','vexim_touch_login')
  loop
    if not has_function_privilege('authenticated', n, 'EXECUTE') then
      raise exception '[0022] FAIL: authenticated không gọi được RPC %', n;
    end if;
  end loop;

  -- 6.4 KHÓA PHẢI MẤT QUYỀN THẬT: mô phỏng bằng cách xét hàm với chính admin?
  --     Không thể đổi auth.uid() trong DO-block ⇒ kiểm gián tiếp: hàm has_role có
  --     tham chiếu user_profiles.status (chuỗi định nghĩa phải chứa 'suspended' guard).
  select pg_get_functiondef(p.oid) into v_before
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'iam' and p.proname = 'has_role';
  if v_before not like '%p.status <> ''suspended''%' then
    raise exception '[0022] FAIL: iam.has_role chưa chặn tài khoản bị khóa';
  end if;
  select pg_get_functiondef(p.oid) into v_before
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'iam' and p.proname = 'can_read_seller_account';
  if v_before not like '%status%' then
    raise exception '[0022] FAIL: iam.can_read_seller_account chưa chặn tài khoản bị khóa';
  end if;

  -- 6.5 luật leo thang: role_level tăng dần theo cấp
  if iam.role_level('super_admin') <= iam.role_level('org_admin')
     or iam.role_level('org_admin') <= iam.role_level('dept_lead')
     or iam.role_level('operator') <= iam.role_level('analyst')
     or iam.role_level('analyst') <= iam.role_level('client_viewer') then
    raise exception '[0022] FAIL: iam.role_level sai thứ bậc';
  end if;

  -- 6.6 enum module 'iam' dùng được cho audit (thêm ở migration này, dùng ở runtime)
  if not exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
     where t.typname = 'module_code' and e.enumlabel = 'iam'
  ) then
    raise exception '[0022] FAIL: chưa thêm module_code ''iam'' cho audit nhân sự';
  end if;

  -- 6.7 KHÔNG mở thêm đường ghi mới trên bảng hồ sơ: mọi policy UPDATE/INSERT
  --     phải hoặc đi qua iam.has_role (admin) hoặc tự giới hạn ở chính mình
  --     (rls_upd_user_profiles_self của 0004 — user sửa tên/điện thoại của mình).
  select count(*) into n from pg_policies
   where schemaname = 'iam' and tablename = 'user_profiles' and cmd in ('UPDATE','INSERT')
     and coalesce(qual,'') || coalesce(with_check,'') not like '%has_role%'
     and coalesce(qual,'') || coalesce(with_check,'') not like '%auth.uid()%';
  if n > 0 then
    raise exception '[0022] FAIL: có % policy ghi user_profiles không rõ ràng quyền', n;
  end if;

  -- 6.8 user phải tự sửa được hồ sơ mình (policy 0004 chỉ sống khi có grant cột)
  select count(*) into n from information_schema.column_privileges
   where grantee = 'authenticated' and table_schema = 'iam' and table_name = 'user_profiles'
     and privilege_type = 'UPDATE' and column_name in ('display_name','phone','avatar_url','mfa_enabled');
  if n <> 4 then
    raise exception '[0022] FAIL: thiếu grant UPDATE 4 cột cho authenticated (%/4)', n;
  end if;

  raise notice '[0022] tự soát OK: status · 3 hàm iam · 5 RPC · khóa-mất-quyền · thứ bậc · audit iam · tự sửa hồ sơ';
end $$;
