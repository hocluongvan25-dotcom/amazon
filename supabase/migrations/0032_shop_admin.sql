-- ============================================================================
-- 0032 — QUẢN LÝ SHOP (Module 0 · SOP-11): THÊM SHOP MỚI · XOÁ SHOP · ẨN SHOP DEMO
-- ============================================================================
-- YÊU CẦU (chủ dự án, 16/09/2026):
--   1. "Xoá giúp mình những shop demo" — giao diện Kết nối shop đang lẫn 6 shop
--      mock (A1/B1/C2/D1/E3, data_source='mock') với 2 shop thật.
--   2. "Thêm một nút thêm shop mới cho VEXIM để sau này kết nối cho dễ"
--      — hiện muốn có shop mới phải chạy SQL tay (0009) hoặc seed.
--   3. "Giao diện gọn hơn".
--
-- NỘI DUNG:
--   §1  seller_id được phép NULL — shop mới tạo KHI CHƯA biết seller id
--   §2  public.vexim_admin_create_shop(...)  — tạo shop (chỉ admin, có audit)
--   §3  public.vexim_admin_delete_shop(...)  — xoá shop CÓ CỔNG AN TOÀN (đếm dữ
--       liệu phụ thuộc trước, buộc xác nhận 2 bước khi shop đã có token/dữ liệu)
--   §4  public.vexim_worker_claim_shop_seller_id(...) — callback OAuth tự "nhận"
--       seller id thật của shop khi tạo shop chưa có seller id
--   §5  ẨN SHOP DEMO: 6 shop mock chuyển status='revoked' (không xoá dữ liệu —
--       xoá hẳn thì dùng nút [Xoá] trên màn Kết nối shop, xem §6)
--   §6  TỰ SOÁT (DO-block)
--
-- VÌ SAO seller_id CHO PHÉP NULL:
--   Seller id (merchant id) chỉ lộ ra ở bước OAuth authorize, qua
--   `selling_partner_id` mà Amazon gửi kèm callback. Bắt buộc nhập seller id
--   ngay lúc tạo shop ⇒ người vận hành phải "bịa" một mã, hoặc không tạo được
--   shop. Cho NULL + tự điền ở callback (§4) là luồng thật:
--     thêm shop  →  gửi link authorize  →  shop bấm Authorize  →  hệ thống nhận
--     seller id thật + refresh token, rồi lấy luôn tên shop (storeName, 0031).
--
-- AN TOÀN (đọc trước khi sửa):
--   • Mọi thay đổi đi qua RPC security definer — web KHÔNG có policy ghi nào
--     trên connections.seller_accounts (giữ nguyên nguyên tắc của 0022/0031).
--   • Tạo/xoá shop yêu cầu `iam.is_user_admin()` (super_admin/org_admin, không bị
--     khoá) — giống màn Người dùng & phân quyền.
--   • XOÁ là thật: `connections.seller_accounts` có 51 khoá ngoại ON DELETE
--     CASCADE ⇒ xoá shop là xoá token, listing, đơn hàng, tồn kho, cảnh báo của
--     shop đó. Vì vậy §3 đếm trước, trả `requires_force`, và chỉ xoá khi
--     p_force = true.
--   • Shop mới tạo ra ở trạng thái `paused` — worker chỉ đồng bộ shop
--     status='active' AND data_source='production' (xem 0005/0009). Lý do:
--     cron hiện dùng MỘT refresh token chung (env AMAZON_LWA_REFRESH_TOKEN), nên
--     bật active cho shop của khách sẽ kéo dữ liệu của shop khác vào — chỉ bật
--     sau khi worker hỗ trợ token riêng theo shop.
--
-- IDEMPOTENT: chạy lại vô hại (không tạo trùng, không xoá gì thêm).
-- THỨ TỰ: chạy SAU 0031.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- §1. seller_id cho phép NULL
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'connections' and table_name = 'seller_accounts'
      and column_name = 'seller_id' and is_nullable = 'NO'
  ) then
    alter table connections.seller_accounts alter column seller_id drop not null;
    raise notice '[0032] connections.seller_accounts.seller_id → cho phép NULL (shop mới chưa authorize)';
  else
    raise notice '[0032] seller_id đã cho phép NULL — bỏ qua';
  end if;
end
$$;

comment on column connections.seller_accounts.seller_id is
  'Merchant id của Amazon. NULL = shop vừa tạo, CHƯA authorize (Amazon chỉ trả '
  'selling_partner_id ở callback OAuth → RPC vexim_worker_claim_shop_seller_id tự điền).';

-- ---------------------------------------------------------------------------
-- §2. TẠO SHOP MỚI — public.vexim_admin_create_shop
-- ---------------------------------------------------------------------------
-- Trả `created = false` khi shop đã tồn tại (unique seller_id + marketplace)
-- để UI báo "shop này đã có rồi" thay vì lỗi 500 khó hiểu.
create or replace function public.vexim_admin_create_shop(
  p_display_name text,
  p_marketplace  text,
  p_seller_id    text default null,
  p_org_id       uuid default null,
  p_data_source  text default 'production'
)
returns table (
  seller_account_id uuid,
  display_name      text,
  marketplace       text,
  seller_id         text,
  status            text,
  data_source       text,
  created           boolean
)
language plpgsql
security definer
set search_path = connections, iam, public, pg_catalog
as $$
declare
  v_name  text;
  v_mp    text;
  v_sid   text;
  v_src   connections.data_source;
  v_org   uuid;
  v_id    uuid;
  v_found record;
begin
  -- service_role (auth.uid() null) hoặc admin đang đăng nhập
  if auth.uid() is not null and not iam.is_user_admin() then
    raise exception '[SHOP] Chỉ quản trị viên (super_admin/org_admin) được thêm shop'
      using errcode = 'insufficient_privilege';
  end if;

  v_name := nullif(btrim(coalesce(p_display_name, '')), '');
  if v_name is null then
    raise exception '[SHOP] Thiếu tên gọi nội bộ của shop'
      using errcode = 'invalid_parameter_value';
  end if;
  if length(v_name) > 120 then
    raise exception '[SHOP] Tên gọi quá dài (tối đa 120 ký tự)'
      using errcode = 'invalid_parameter_value';
  end if;

  v_mp := upper(nullif(btrim(coalesce(p_marketplace, '')), ''));
  if v_mp is null then
    raise exception '[SHOP] Thiếu marketplace (ví dụ ATVPDKIKX0DER = Amazon US)'
      using errcode = 'invalid_parameter_value';
  end if;
  if length(v_mp) > 32 then
    raise exception '[SHOP] Marketplace id không hợp lệ: %', v_mp
      using errcode = 'invalid_parameter_value';
  end if;

  v_sid := nullif(btrim(coalesce(p_seller_id, '')), '');
  if v_sid is not null and v_sid !~ '^[A-Za-z0-9]{6,32}$' then
    raise exception
      '[SHOP] Seller ID "%" không hợp lệ — Amazon merchant id chỉ gồm chữ và số (6–32 ký tự). '
      'Để trống nếu chưa biết: hệ thống tự điền khi shop authorize.', v_sid
      using errcode = 'invalid_parameter_value';
  end if;

  begin
    v_src := coalesce(nullif(btrim(coalesce(p_data_source, '')), ''), 'production')::connections.data_source;
  exception
    when invalid_text_representation then
      raise exception '[SHOP] data_source không hợp lệ (chỉ nhận: mock | sandbox | production)'
        using errcode = 'invalid_parameter_value';
  end;

  -- Tổ chức: ưu tiên tham số → org VEXIM → org nội bộ đầu tiên → org của người gọi
  v_org := p_org_id;
  if v_org is null then
    select o.id into v_org from iam.organizations o where o.slug = 'vexim' limit 1;
  end if;
  if v_org is null then
    select o.id into v_org from iam.organizations o where o.is_internal order by o.created_at limit 1;
  end if;
  if v_org is null then
    -- Nhân viên VEXIM có org_id = NULL ⇒ bước này thường vẫn NULL (đúng thiết kế)
    v_org := iam.current_org_id();
  end if;
  if v_org is null then
    raise exception '[SHOP] Không xác định được tổ chức — chạy migration 0007 (tạo org VEXIM) trước'
      using errcode = 'no_data_found';
  end if;

  -- Đã có shop cùng seller_id + marketplace? → KHÔNG tạo trùng, KHÔNG sửa gì
  if v_sid is not null then
    select sa.id, sa.display_name, sa.marketplace, sa.seller_id, sa.status, sa.data_source::text as data_source
      into v_found
      from connections.seller_accounts sa
     where sa.seller_id = v_sid and sa.marketplace = v_mp
     limit 1;
    if found then
      return query
        select v_found.id, v_found.display_name, v_found.marketplace, v_found.seller_id,
               v_found.status, v_found.data_source, false;
      return;
    end if;
  end if;

  begin
    insert into connections.seller_accounts
      (org_id, seller_id, marketplace, display_name, status, data_source)
    values
      -- `paused`: chưa kết nối ⇒ worker KHÔNG đồng bộ (xem đầu file)
      (v_org, v_sid, v_mp, v_name, 'paused', v_src)
    returning id into v_id;
  exception
    when unique_violation then
      -- Hai người bấm [Thêm shop] cùng lúc ⇒ người sau nhận bản ghi đã có
      select sa.id, sa.display_name, sa.marketplace, sa.seller_id, sa.status, sa.data_source::text as data_source
        into v_found
        from connections.seller_accounts sa
       where sa.seller_id = v_sid and sa.marketplace = v_mp
       limit 1;
      if found then
        return query
          select v_found.id, v_found.display_name, v_found.marketplace, v_found.seller_id,
                 v_found.status, v_found.data_source, false;
        return;
      end if;
      raise;
  end;

  insert into iam.audit_logs (
    actor_id, seller_account_id, module, action, entity, after_value, result
  ) values (
    auth.uid(), v_id, null, 'shop.create', v_name,
    jsonb_build_object(
      'seller_id', v_sid, 'marketplace', v_mp, 'status', 'paused',
      'data_source', v_src::text, 'org_id', v_org
    ),
    'ok'
  );

  return query select v_id, v_name, v_mp, v_sid, 'paused'::text, v_src::text, true;
end;
$$;

comment on function public.vexim_admin_create_shop(text, text, text, uuid, text) is
  'Module 0: thêm shop mới cho VEXIM (màn Kết nối shop). Chỉ admin. Shop tạo ra ở '
  'trạng thái paused (chưa kết nối) — bấm [Kết nối] để authorize, Amazon trả '
  'selling_partner_id thì hệ thống tự điền seller_id. created=false = shop đã tồn tại.';

-- ---------------------------------------------------------------------------
-- §3. XOÁ SHOP — public.vexim_admin_delete_shop (2 bước, có đếm dữ liệu)
-- ---------------------------------------------------------------------------
-- Bước 1: p_force = false → CHỈ đọc: đếm dữ liệu phụ thuộc + cho biết có cần
--         xác nhận mạnh không. KHÔNG xoá gì.
-- Bước 2: p_force = true (sau khi người dùng xác nhận) → xoá thật.
create or replace function public.vexim_admin_delete_shop(
  p_seller_account_id uuid,
  p_force             boolean default false
)
returns table (
  deleted        boolean,
  requires_force boolean,
  shop           text,
  summary        jsonb,
  message        text
)
language plpgsql
security definer
set search_path = connections, iam, public, pg_catalog
as $$
declare
  v_shop        record;
  v_has_token   boolean;
  v_summary     jsonb := '{}'::jsonb;
  v_sql         text;
  v_any_rows    boolean := false;
begin
  if auth.uid() is not null and not iam.is_user_admin() then
    raise exception '[SHOP] Chỉ quản trị viên (super_admin/org_admin) được xoá shop'
      using errcode = 'insufficient_privilege';
  end if;
  if p_seller_account_id is null then
    raise exception '[SHOP] thiếu seller_account_id'
      using errcode = 'invalid_parameter_value';
  end if;

  select sa.id, sa.display_name, sa.seller_id, sa.marketplace, sa.status, sa.data_source::text as data_source
    into v_shop
    from connections.seller_accounts sa
   where sa.id = p_seller_account_id;
  if not found then
    return query select false, false, null::text, '{}'::jsonb, 'Shop không tồn tại (có thể đã bị xoá).';
    return;
  end if;

  select exists (
    select 1 from connections.oauth_tokens t where t.seller_account_id = p_seller_account_id
  ) into v_has_token;

  -- Đếm dữ liệu phụ thuộc ĐỘNG: mọi bảng nghiệp vụ có cột seller_account_id.
  -- (Không liệt kê tay — thêm bảng mới ở migration sau là tự được đếm.)
  select string_agg(
           format(
             'select %L::text as tbl, count(*)::bigint as cnt from %I.%I where seller_account_id = $1',
             ns.nspname || '.' || c.relname, ns.nspname, c.relname
           ),
           ' union all '
         )
    into v_sql
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'seller_account_id'
                       and a.attnum > 0 and not a.attisdropped
   where c.relkind = 'r'
     and ns.nspname in ('connections', 'catalog', 'sales', 'inventory', 'ads',
                        'finance', 'ops', 'account_health', 'research', 'iam');

  if v_sql is not null then
    execute format(
      'select coalesce(jsonb_object_agg(tbl, cnt), ''{}''::jsonb) from (select * from (%s) s) t where cnt > 0',
      v_sql
    ) into v_summary using p_seller_account_id;
  end if;

  select exists (select 1 from jsonb_each(v_summary)) into v_any_rows;

  if (v_has_token or v_any_rows) and not p_force then
    return query select
      false,
      true,
      v_shop.display_name,
      v_summary,
      case
        when v_has_token then
          'Shop đang có refresh token (đã kết nối) — xoá sẽ mất kết nối và toàn bộ dữ liệu đã đồng bộ. Xác nhận để xoá hẳn.'
        else
          'Shop đang có dữ liệu đã đồng bộ — xoá sẽ mất toàn bộ dữ liệu đó. Xác nhận để xoá hẳn.'
      end;
    return;
  end if;

  -- Ghi nhật ký TRƯỚC khi xoá, và KHÔNG gắn seller_account_id (khoá ngoại có
  -- ON DELETE CASCADE ⇒ nhật ký sẽ bị xoá theo). Thông tin shop nằm trong entity.
  insert into iam.audit_logs (
    actor_id, seller_account_id, module, action, entity, before_value, result
  ) values (
    auth.uid(), null, null, 'shop.delete',
    format('%s · %s · %s', v_shop.display_name, coalesce(v_shop.seller_id, '(chưa có seller id)'), v_shop.marketplace),
    jsonb_build_object(
      'seller_account_id', v_shop.id, 'display_name', v_shop.display_name,
      'seller_id', v_shop.seller_id, 'marketplace', v_shop.marketplace,
      'status', v_shop.status, 'data_source', v_shop.data_source,
      'had_token', v_has_token, 'dependents', v_summary
    ),
    'ok'
  );

  delete from connections.seller_accounts where id = p_seller_account_id;

  return query select
    true, false, v_shop.display_name, v_summary,
    format('Đã xoá shop "%s" (kèm dữ liệu đã đồng bộ).', v_shop.display_name);
end;
$$;

comment on function public.vexim_admin_delete_shop(uuid, boolean) is
  'Module 0: xoá shop khỏi hệ thống (SOP-11). Chỉ admin. p_force=false = CHỈ đếm dữ '
  'liệu phụ thuộc và báo cần xác nhận (requires_force) — không xoá gì; p_force=true = '
  'xoá thật (51 khoá ngoại ON DELETE CASCADE ⇒ mất token + dữ liệu của shop).';

-- ---------------------------------------------------------------------------
-- §4. CALLBACK OAUTH — tự nhận seller id thật cho shop tạo thiếu seller_id
-- ---------------------------------------------------------------------------
create or replace function public.vexim_worker_claim_shop_seller_id(
  p_seller    uuid,
  p_seller_id text
)
returns table (
  seller_account_id uuid,
  seller_id         text,
  matches           boolean,
  adopted           boolean,
  message           text
)
language plpgsql
security definer
set search_path = connections, public, pg_catalog
as $$
declare
  v_sid  text;
  v_cur  text;
  v_name text;
begin
  if auth.uid() is not null then
    raise exception '[SHOP] RPC này chỉ dành cho server (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_seller is null then
    raise exception '[SHOP] thiếu seller_account_id' using errcode = 'invalid_parameter_value';
  end if;

  v_sid := nullif(btrim(coalesce(p_seller_id, '')), '');
  if v_sid is null then
    raise exception '[SHOP] thiếu selling_partner_id từ Amazon' using errcode = 'invalid_parameter_value';
  end if;

  select sa.seller_id, sa.display_name into v_cur, v_name
    from connections.seller_accounts sa where sa.id = p_seller;
  if not found then
    raise exception '[SHOP] không tìm thấy seller_account %', p_seller using errcode = 'no_data_found';
  end if;

  -- Đã có seller id
  if v_cur is not null and btrim(v_cur) <> '' then
    return query select
      p_seller, v_cur, (v_cur = v_sid), false,
      case when v_cur = v_sid
           then 'Seller ID khớp shop đã khai.'
           else format('Bạn vừa authorize shop KHÁC: Amazon trả %s, shop "%s" đang khai %s.', v_sid, v_name, v_cur)
      end;
    return;
  end if;

  begin
    update connections.seller_accounts sa
       set seller_id = v_sid
     where sa.id = p_seller;
  exception
    when unique_violation then
      -- Đã có shop khác cùng (seller_id, marketplace) ⇒ KHÔNG nhân bản dữ liệu
      return query select
        p_seller, null::text, false, false,
        format('Đã có shop khác cùng seller id %s + marketplace — dùng shop đó, không tạo thêm.', v_sid);
      return;
  end;

  return query select
    p_seller, v_sid, true, true,
    format('Đã nhận seller id thật %s cho shop "%s".', v_sid, v_name);
end;
$$;

comment on function public.vexim_worker_claim_shop_seller_id(uuid, text) is
  'Callback OAuth: điền seller_id thật (selling_partner_id của Amazon) cho shop tạo '
  'trước khi authorize (seller_id NULL). Chỉ service_role. matches=false ⇒ caller PHẢI '
  'từ chối lưu token (authorize sai shop hoặc trùng shop khác).';

-- ---------------------------------------------------------------------------
-- §5. ẨN SHOP DEMO (data_source='mock') — yêu cầu "xoá shop demo, giao diện gọn hơn"
-- ---------------------------------------------------------------------------
-- Dùng status='revoked' (KHÔNG xoá): mọi màn hình đã lọc bỏ shop revoked
-- (readConnectShops, view/RLS, bộ chọn shop) nên shop demo biến mất khỏi UI ngay,
-- nhưng dữ liệu demo vẫn còn nếu cần đối chiếu. Muốn xoá hẳn: nút [Xoá] trên màn
-- Kết nối shop (hoặc chạy §6.3 trong SQL Editor).
do $$
declare n int;
begin
  update connections.seller_accounts
     set status = 'revoked'
   where data_source = 'mock'
     and status <> 'revoked';
  get diagnostics n = row_count;
  raise notice '[0032] Ẩn % shop demo (data_source=mock → status=revoked)', n;
end
$$;

-- ---------------------------------------------------------------------------
-- §6. QUYỀN + TỰ KIỂM TRA
-- ---------------------------------------------------------------------------
revoke all on function public.vexim_admin_create_shop(text, text, text, uuid, text)
  from public, anon;
grant  execute on function public.vexim_admin_create_shop(text, text, text, uuid, text)
  to authenticated, service_role;

revoke all on function public.vexim_admin_delete_shop(uuid, boolean)
  from public, anon;
grant  execute on function public.vexim_admin_delete_shop(uuid, boolean)
  to authenticated, service_role;

revoke all on function public.vexim_worker_claim_shop_seller_id(uuid, text)
  from public, anon, authenticated;
grant  execute on function public.vexim_worker_claim_shop_seller_id(uuid, text)
  to service_role;

do $$
declare
  n     int;
  v_fn  text;
begin
  -- 6.1 seller_id cho phép NULL
  select count(*) into n
  from information_schema.columns
  where table_schema = 'connections' and table_name = 'seller_accounts'
    and column_name = 'seller_id' and is_nullable = 'YES';
  if n <> 1 then
    raise exception '[0032] FAIL: seller_id vẫn NOT NULL — không tạo được shop trước khi authorize';
  end if;

  -- 6.2 Không có shop demo nào lọt ra màn Kết nối shop nữa
  select count(*) into n
  from connections.seller_accounts
  where data_source = 'mock' and status <> 'revoked';
  if n <> 0 then
    raise exception '[0032] FAIL: còn % shop demo chưa ẩn', n;
  end if;

  -- 6.3 Ba RPC mới: security definer + đúng quyền
  foreach v_fn in array array[
    'vexim_admin_create_shop(text, text, text, uuid, text)',
    'vexim_admin_delete_shop(uuid, boolean)',
    'vexim_worker_claim_shop_seller_id(uuid, text)'
  ] loop
    select count(*) into n
    from pg_proc p
    where p.oid = to_regprocedure('public.' || v_fn)
      and p.prosecdef
      and not has_function_privilege('anon', p.oid, 'EXECUTE');
    if n <> 1 then
      raise exception '[0032] FAIL: RPC % thiếu / không security definer / anon vẫn gọi được', v_fn;
    end if;
  end loop;

  -- RPC worker (điền seller_id) KHÔNG được cho người dùng web gọi
  select count(*) into n
  from pg_proc p
  where p.oid = to_regprocedure('public.vexim_worker_claim_shop_seller_id(uuid, text)')
    and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and has_function_privilege('service_role', p.oid, 'EXECUTE');
  if n <> 1 then
    raise exception '[0032] FAIL: vexim_worker_claim_shop_seller_id phải chỉ service_role';
  end if;

  -- 6.4 Web vẫn KHÔNG ghi thẳng được bảng shop (mọi thứ qua RPC)
  select count(*) into n
  from pg_policies
  where schemaname = 'connections' and tablename = 'seller_accounts' and cmd <> 'SELECT';
  if n <> 0 then
    raise exception '[0032] FAIL: có % policy ghi trên connections.seller_accounts — web phải KHÔNG ghi được', n;
  end if;

  raise notice '[0032] OK — thêm/xoá shop qua RPC admin · shop demo đã ẩn';
end
$$;

commit;
