-- ============================================================================
-- 0028 — LẤY TÊN CỬA HÀNG THẬT TỪ AMAZON (Sellers API storeName)
-- ============================================================================
-- TRẢ LỜI CÂU HỎI VẬN HÀNH: "API không kéo được tên shop thực tế về à?"
-- → CÓ. Sellers API GET /sellers/v1/marketplaceParticipations trả storeName
--   cho từng marketplace. Callback OAuth có sẵn access token ngay sau khi đổi
--   code (trước đây vứt đi không dùng) — gọi luôn 1 phát là có tên thật,
--   không tốn thêm lượt authorize nào.
--
-- THỨ TỰ ƯU TIÊN TÊN SHOP (từ cao xuống thấp):
--   1. Tên người vận hành TỰ ĐẶT qua vexim_rename_shop (0027)  — không bao giờ bị ghi đè
--   2. storeName từ Amazon (RPC này)                            — ghi đè tên mặc định/thô
--   3. Tên mặc định generic 'Shop US · AQMV' (0027)             — khi Amazon không trả storeName
--   4. Tên kỹ thuật thô                                          — đã bị 0026 dọn
--
-- Cần phân biệt (1) với (3): thêm cột name_source đánh dấu nguồn tên.
--   'manual'  — người vận hành đặt (vexim_rename_shop)
--   'amazon'  — lấy từ storeName
--   'default' — hệ thống tự sinh / seed / migration
--
-- IDEMPOTENT: add column if not exists + create or replace.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Cột name_source — biết tên hiện tại do ai đặt để quyết định ghi đè
-- ---------------------------------------------------------------------------
alter table connections.seller_accounts
  add column if not exists name_source text not null default 'default'
  check (name_source in ('manual', 'amazon', 'default'));

comment on column connections.seller_accounts.name_source is
  'Nguồn của display_name: manual (người vận hành đặt — không tự ghi đè) · '
  'amazon (storeName từ Sellers API) · default (hệ thống tự sinh/seed).';

-- ---------------------------------------------------------------------------
-- 2. vexim_rename_shop (0027) — nâng cấp: đánh dấu name_source='manual'
-- ---------------------------------------------------------------------------
create or replace function public.vexim_rename_shop(
  p_seller uuid,
  p_name   text
)
returns table (id uuid, display_name text, message text)
language plpgsql
security definer
set search_path = connections, iam, public, pg_catalog
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_old  text;
  v_mp   text;
begin
  if auth.uid() is null then
    raise exception '[M0] phải đăng nhập mới đổi tên shop'
      using errcode = 'insufficient_privilege';
  end if;
  if not (iam.is_user_admin() or iam.can_write_seller_account(p_seller)) then
    raise exception '[M0] bạn không có quyền ghi trên shop này'
      using errcode = 'insufficient_privilege';
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 80 then
    raise exception '[M0] tên shop phải từ 2 đến 80 ký tự'
      using errcode = 'invalid_parameter_value';
  end if;

  select sa.display_name, sa.marketplace into v_old, v_mp
  from connections.seller_accounts sa
  where sa.id = p_seller;
  if not found then
    raise exception '[M0] shop không tồn tại' using errcode = 'invalid_parameter_value';
  end if;
  if connections.is_raw_shop_name(v_name, v_mp) then
    raise exception '[M0] tên này trông như mã kỹ thuật — hãy đặt tên dễ nhận biết (vd: "Cửa hàng ABC - US")'
      using errcode = 'invalid_parameter_value';
  end if;

  update connections.seller_accounts sa
  set display_name = v_name,
      name_source  = 'manual'          -- tên tay: Amazon storeName sẽ không ghi đè nữa
  where sa.id = p_seller;

  insert into iam.audit_logs (actor_id, seller_account_id, action, entity, before_value, after_value, result)
  values (auth.uid(), p_seller, 'shop.rename', v_name,
          jsonb_build_object('display_name', v_old),
          jsonb_build_object('display_name', v_name), 'ok');

  return query select p_seller, v_name, format('Đã đổi tên shop thành "%s".', v_name);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. vexim_worker_set_shop_name — callback OAuth lưu storeName từ Amazon
-- ---------------------------------------------------------------------------
create or replace function public.vexim_worker_set_shop_name(
  p_seller uuid,
  p_name   text
)
returns table (id uuid, display_name text, updated boolean, message text)
language plpgsql
security definer
set search_path = connections, public, pg_catalog
as $$
declare
  v_name   text := btrim(coalesce(p_name, ''));
  v_cur    text;
  v_source text;
  v_mp     text;
begin
  if auth.uid() is not null then
    raise exception '[OAUTH] RPC này chỉ dành cho server (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_seller is null then
    raise exception '[OAUTH] thiếu seller_account_id'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_name = '' or char_length(v_name) > 200 then
    return query select p_seller, null::text, false, 'storeName rỗng hoặc quá dài — bỏ qua';
    return;
  end if;

  select sa.display_name, sa.name_source, sa.marketplace into v_cur, v_source, v_mp
  from connections.seller_accounts sa
  where sa.id = p_seller;
  if not found then
    return query select p_seller, null::text, false, 'shop không tồn tại';
    return;
  end if;

  -- Tên do người vận hành TỰ ĐẶT: không ghi đè (trừ khi họ rename lại)
  if v_source = 'manual' and not connections.is_raw_shop_name(v_cur, v_mp) then
    return query select p_seller, v_cur, false,
      'giữ tên do người vận hành đặt (name_source=manual) — storeName Amazon không ghi đè';
    return;
  end if;
  -- Tên đã đúng rồi thì thôi
  if v_cur = v_name then
    return query select p_seller, v_cur, false, 'tên đã khớp storeName Amazon từ trước';
    return;
  end if;

  update connections.seller_accounts sa
  set display_name = left(v_name, 80),
      name_source  = 'amazon'
  where sa.id = p_seller;

  return query select p_seller, left(v_name, 80), true,
    format('đã cập nhật tên shop từ Amazon storeName: "%s"', left(v_name, 80));
end;
$$;

comment on function public.vexim_worker_set_shop_name(uuid, text) is
  'Callback OAuth lưu storeName từ Sellers API getMarketplaceParticipations — chỉ service_role. '
  'KHÔNG ghi đè tên name_source=manual (người vận hành đặt). Tên mặc định/thô thì thay bằng tên thật.';

revoke all on function public.vexim_worker_set_shop_name(uuid, text) from public, anon, authenticated;
grant execute on function public.vexim_worker_set_shop_name(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. vexim_worker_get_shop (0025) — thêm cột marketplace để callback chọn đúng
--    storeName theo marketplace của shop (US lấy tên store US, CA lấy CA…)
--    Đổi return type nên phải DROP trước (create or replace không đổi được OUT).
-- ---------------------------------------------------------------------------
drop function if exists public.vexim_worker_get_shop(uuid);

create or replace function public.vexim_worker_get_shop(p_seller uuid)
returns table (id uuid, display_name text, seller_id text, marketplace text, name_source text)
language plpgsql
stable
security definer
set search_path = connections, public, pg_catalog
as $$
begin
  if auth.uid() is not null then
    raise exception '[OAUTH] RPC này chỉ dành cho server (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_seller is null then
    raise exception '[OAUTH] thiếu seller_account_id'
      using errcode = 'invalid_parameter_value';
  end if;

  return query
    select sa.id, sa.display_name, sa.seller_id, sa.marketplace, sa.name_source
    from connections.seller_accounts sa
    where sa.id = p_seller;
end;
$$;

comment on function public.vexim_worker_get_shop(uuid) is
  'Callback OAuth đọc shop (id/display_name/seller_id/marketplace/name_source) — chỉ service_role. '
  'Wrapper public thay cho GET /rest/v1/seller_accounts (PGRST205 vì bảng ở schema connections).';

revoke all on function public.vexim_worker_get_shop(uuid) from public, anon, authenticated;
grant execute on function public.vexim_worker_get_shop(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. TỰ KIỂM TRA
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  select count(*) into n
  from information_schema.columns
  where table_schema = 'connections' and table_name = 'seller_accounts' and column_name = 'name_source';
  if n <> 1 then raise exception '[0028] FAIL: thiếu cột name_source'; end if;

  select count(*) into n
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.proname = 'vexim_worker_set_shop_name' and p.prosecdef;
  if n <> 1 then raise exception '[0028] FAIL: thiếu RPC vexim_worker_set_shop_name'; end if;

  if has_function_privilege('anon', 'public.vexim_worker_set_shop_name(uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'public.vexim_worker_set_shop_name(uuid, text)', 'execute') then
    raise exception '[0028] FAIL: anon/authenticated vẫn execute được RPC worker';
  end if;

  -- get_shop bản mới phải trả 5 cột (có marketplace + name_source)
  select count(*) into n
  from information_schema.parameters
  where specific_schema = 'public'
    and specific_name like 'vexim_worker_get_shop%'
    and parameter_mode = 'OUT'
    and parameter_name in ('id', 'display_name', 'seller_id', 'marketplace', 'name_source');
  if n <> 5 then
    raise exception '[0028] FAIL: vexim_worker_get_shop trả %/5 cột kỳ vọng', n;
  end if;

  raise notice '[0028] OK: name_source + set_shop_name (storeName Amazon, không đè tên manual) + get_shop có marketplace';
end $$;

commit;
