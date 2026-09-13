-- ============================================================================
-- 0027 — ĐỔI TÊN SHOP TRÊN UI + TÊN MẶC ĐỊNH GENERIC CHO SHOP KHÁCH MỚI
-- ============================================================================
-- BỐI CẢNH: 0024/0026 đặt tên thân thiện bằng cách HARDCODE theo seller của
-- VEXIM (AQMVYI4HJTI4C → 'VEXIM US - Chính'). Không scale: shop KHÁCH kết nối
-- sau này sẽ lại mang tên mã thô / 'Shop US' chung chung, và không có cách đổi
-- tên ngoài SQL tay.
--
-- PHƯƠNG ÁN:
--   1. connections.default_shop_name(marketplace, seller_id) — tên mặc định
--      generic cho MỌI seller: 'Shop US · AQMV' (mã nước + 4 ký tự đầu
--      seller_id để không trùng khi nhiều khách cùng marketplace).
--   2. Nâng cấp vexim_worker_claim_seller_id (0025): khi callback OAuth điền
--      seller_id lần đầu, nếu display_name đang rỗng/thô thì tự đặt tên mặc
--      định — shop khách mới kết nối là có tên đọc được ngay, không cần seed.
--   3. public.vexim_rename_shop(p_seller, p_name) — người vận hành đổi tên
--      ngay trên UI: admin hoặc người có quyền ghi trên shop; ghi audit_logs.
--
-- IDEMPOTENT: create or replace toàn bộ.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Tên mặc định generic — KHÔNG hardcode theo seller nào
-- ---------------------------------------------------------------------------
create or replace function connections.default_shop_name(p_marketplace text, p_seller_id text)
returns text
language sql
immutable
as $$
  select 'Shop '
    || case p_marketplace
         when 'ATVPDKIKX0DER'  then 'US'
         when 'A2EUQ1WTGCTBG2' then 'CA'
         when 'A1AM78C64UM0Y8' then 'MX'
         when 'A1PA6795UKMFR9' then 'DE'
         when 'A1F83G8C2ARO7P' then 'UK'
         when 'A1RKKUPIHCS9HS' then 'ES'
         when 'A13V1IB3VIYZZH' then 'FR'
         when 'APJ6JRA9NG5V4'  then 'IT'
         when 'A1VC38T7YXB528' then 'JP'
         else left(coalesce(p_marketplace, '?'), 6)
       end
    || case when coalesce(btrim(p_seller_id), '') <> ''
            then ' · ' || left(btrim(p_seller_id), 4)
            else '' end;
$$;

comment on function connections.default_shop_name(text, text) is
  'Tên shop mặc định generic cho MỌI seller (khách lẫn nội bộ): Shop <mã nước> · <4 ký tự seller_id>. '
  'Không hardcode tên riêng — tên thương hiệu do người vận hành tự đặt qua vexim_rename_shop.';

/** display_name có phải tên kỹ thuật thô không (rỗng / mã marketplace / pattern P1·Axxx)? */
create or replace function connections.is_raw_shop_name(p_name text, p_marketplace text)
returns boolean
language sql
immutable
as $$
  select coalesce(btrim(p_name), '') = ''
      or p_name = p_marketplace
      or p_name ~ '^A[A-Z0-9]{8,}$'
      or p_name ~ '^P[0-9]+ ?[·-] ?A[A-Z0-9]{8,}$';
$$;

-- ---------------------------------------------------------------------------
-- 2. Nâng cấp claim_seller_id: shop khách mới tự có tên mặc định
-- ---------------------------------------------------------------------------
create or replace function public.vexim_worker_claim_seller_id(
  p_seller    uuid,
  p_seller_id text
)
returns table (id uuid, seller_id text, claimed boolean, message text)
language plpgsql
security definer
set search_path = connections, public, pg_catalog
as $$
declare
  v_new text := btrim(coalesce(p_seller_id, ''));
  v_cur text;
  v_name text;
  v_mp   text;
begin
  if auth.uid() is not null then
    raise exception '[OAUTH] RPC này chỉ dành cho server (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_seller is null then
    raise exception '[OAUTH] thiếu seller_account_id'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_new = '' then
    return query select p_seller, null::text, false, 'selling_partner_id rỗng — không có gì để điền';
    return;
  end if;

  select sa.seller_id, sa.display_name, sa.marketplace into v_cur, v_name, v_mp
  from connections.seller_accounts sa
  where sa.id = p_seller;
  if not found then
    return query select p_seller, null::text, false, 'shop không tồn tại';
    return;
  end if;

  if coalesce(btrim(v_cur), '') <> '' then
    -- seller_id đã có: không ghi đè, nhưng vẫn vá tên nếu đang là tên thô
    if connections.is_raw_shop_name(v_name, v_mp) then
      update connections.seller_accounts sa
      set display_name = connections.default_shop_name(v_mp, v_cur)
      where sa.id = p_seller;
    end if;
    return query select p_seller, v_cur,
      (v_cur = v_new),
      case when v_cur = v_new then 'seller_id đã đúng từ trước'
           else 'shop đã có seller_id khác — không ghi đè' end;
    return;
  end if;

  begin
    update connections.seller_accounts sa
    set seller_id = v_new,
        -- Shop khách mới: nếu tên đang rỗng/thô → đặt tên mặc định generic
        display_name = case
          when connections.is_raw_shop_name(sa.display_name, sa.marketplace)
            then connections.default_shop_name(sa.marketplace, v_new)
          else sa.display_name
        end
    where sa.id = p_seller;
  exception when unique_violation then
    return query select p_seller, v_cur, false,
      format('seller_id %s đã gắn với shop khác cùng marketplace (unique seller_id+marketplace)', v_new);
    return;
  end;

  return query select p_seller, v_new, true, 'đã điền seller_id lần đầu';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. RPC đổi tên shop từ UI — phân quyền + audit
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
  -- Quyền: admin toàn cục HOẶC được gán quyền ghi trên chính shop này
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
  -- Chặn tự đặt lại thành tên mã thô (mất công fix)
  if connections.is_raw_shop_name(v_name, v_mp) then
    raise exception '[M0] tên này trông như mã kỹ thuật — hãy đặt tên dễ nhận biết (vd: "Cửa hàng ABC - US")'
      using errcode = 'invalid_parameter_value';
  end if;

  update connections.seller_accounts sa
  set display_name = v_name
  where sa.id = p_seller;

  insert into iam.audit_logs (actor_id, seller_account_id, action, entity, before_value, after_value, result)
  values (auth.uid(), p_seller, 'shop.rename', v_name,
          jsonb_build_object('display_name', v_old),
          jsonb_build_object('display_name', v_name), 'ok');

  return query select p_seller, v_name, format('Đã đổi tên shop thành "%s".', v_name);
end;
$$;

comment on function public.vexim_rename_shop(uuid, text) is
  'Người vận hành đổi tên hiển thị của shop trên UI — admin hoặc người có can_write trên shop. '
  'Ghi iam.audit_logs (shop.rename). Chặn tên trông như mã kỹ thuật.';

revoke all on function public.vexim_rename_shop(uuid, text) from public, anon;
grant execute on function public.vexim_rename_shop(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. TỰ KIỂM TRA
-- ---------------------------------------------------------------------------
do $$
declare n int; v text;
begin
  v := connections.default_shop_name('ATVPDKIKX0DER', 'A3EXAMPLE99');
  if v <> 'Shop US · A3EX' then
    raise exception '[0027] FAIL: default_shop_name trả "%" (kỳ vọng "Shop US · A3EX")', v;
  end if;
  if not connections.is_raw_shop_name('ATVPDKIKX0DER', 'ATVPDKIKX0DER') then
    raise exception '[0027] FAIL: is_raw_shop_name không bắt được mã marketplace';
  end if;
  if connections.is_raw_shop_name('Cửa hàng ABC - US', 'ATVPDKIKX0DER') then
    raise exception '[0027] FAIL: is_raw_shop_name bắt nhầm tên thân thiện';
  end if;

  select count(*) into n
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.proname = 'vexim_rename_shop' and p.prosecdef;
  if n <> 1 then raise exception '[0027] FAIL: thiếu RPC vexim_rename_shop'; end if;

  if has_function_privilege('anon', 'public.vexim_rename_shop(uuid, text)', 'execute') then
    raise exception '[0027] FAIL: anon vẫn execute được vexim_rename_shop';
  end if;

  raise notice '[0027] OK: default_shop_name generic + claim tự đặt tên + rename RPC (authenticated, có audit)';
end $$;

commit;
