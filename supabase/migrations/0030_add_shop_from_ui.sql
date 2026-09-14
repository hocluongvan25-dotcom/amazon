-- ============================================================================
-- 0030 — THÊM SHOP / THỊ TRƯỜNG NGAY TRÊN UI (nút "+ Thêm shop")
-- ============================================================================
-- Yêu cầu vận hành: muốn kết nối shop thứ 2 (hoặc thị trường mới) thì bấm
-- "+ Thêm shop / thị trường" → chọn marketplace → Kết nối. KHÔNG seed sẵn
-- hàng loạt dòng "chưa kết nối" gây rối mắt.
--
-- RPC public.vexim_add_shop(p_marketplace, p_name):
--   • Chỉ admin (iam.is_user_admin) — thêm shop là thao tác quản trị.
--   • org_id lấy từ hồ sơ người gọi; seller_id để RỖNG — callback OAuth sẽ
--     điền qua vexim_worker_claim_seller_id (0025/0027) khi kết nối xong.
--   • Tên: người dùng đặt (manual) hoặc mặc định 'Shop <nước>' (default);
--     kết nối xong 0028 tự nâng lên storeName thật từ Amazon.
--   • unique(seller_id, marketplace): mỗi marketplace chỉ 1 shop đang chờ
--     kết nối (seller_id='') — trùng thì báo lỗi thân thiện, không nổ 500.
--
-- IDEMPOTENT: create or replace + grant/revoke.
-- ============================================================================

begin;

create or replace function public.vexim_add_shop(
  p_marketplace text,
  p_name        text default null
)
returns table (id uuid, display_name text, marketplace text, message text)
language plpgsql
security definer
set search_path = connections, iam, public, pg_catalog
as $$
declare
  v_mp   text := btrim(coalesce(p_marketplace, ''));
  v_name text := btrim(coalesce(p_name, ''));
  v_org  uuid;
  v_id   uuid;
  v_final_name text;
  v_manual boolean := false;
begin
  if auth.uid() is null then
    raise exception '[M0] phải đăng nhập mới thêm được shop'
      using errcode = 'insufficient_privilege';
  end if;
  if not iam.is_user_admin() then
    raise exception '[M0] chỉ quản trị viên (super_admin/org_admin) được thêm shop mới'
      using errcode = 'insufficient_privilege';
  end if;
  if v_mp !~ '^A[A-Z0-9]{8,13}$' then
    raise exception '[M0] marketplace id không hợp lệ (vd US = ATVPDKIKX0DER)'
      using errcode = 'invalid_parameter_value';
  end if;

  -- org_id: hồ sơ người gọi (khách hàng) → org của các shop production hiện
  -- có → org nội bộ VEXIM (nhân viên VEXIM có org_id NULL trong hồ sơ).
  select up.org_id into v_org from iam.user_profiles up where up.id = auth.uid();
  if v_org is null then
    select sa.org_id into v_org
    from connections.seller_accounts sa
    where sa.data_source = 'production'
    order by sa.created_at desc
    limit 1;
  end if;
  if v_org is null then
    select o.id into v_org from iam.organizations o
    where o.is_internal order by o.created_at limit 1;
  end if;
  if v_org is null then
    raise exception '[M0] chưa có tổ chức nào trong hệ thống — liên hệ quản trị viên'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Tên: người dùng đặt (2–80 ký tự, không phải mã thô) hoặc mặc định generic
  if v_name <> '' then
    if char_length(v_name) < 2 or char_length(v_name) > 80 then
      raise exception '[M0] tên shop phải từ 2 đến 80 ký tự'
        using errcode = 'invalid_parameter_value';
    end if;
    if connections.is_raw_shop_name(v_name, v_mp) then
      raise exception '[M0] tên này trông như mã kỹ thuật — hãy đặt tên dễ nhận biết (vd: "Cửa hàng ABC - US")'
        using errcode = 'invalid_parameter_value';
    end if;
    v_final_name := v_name;
    v_manual := true;
  else
    v_final_name := connections.default_shop_name(v_mp, '');
  end if;

  begin
    insert into connections.seller_accounts (org_id, seller_id, marketplace, display_name, status, data_source, name_source)
    values (v_org, '', v_mp, v_final_name, 'active', 'production', case when v_manual then 'manual' else 'default' end)
    returning seller_accounts.id into v_id;
  exception when unique_violation then
    -- unique(seller_id, marketplace): đã có 1 shop marketplace này chờ kết nối
    raise exception '[M0] đã có một shop % đang chờ kết nối — hãy kết nối shop đó trước, seller_id sẽ được điền và bạn thêm shop tiếp theo được ngay',
      coalesce(nullif(connections.default_shop_name(v_mp, ''), ''), v_mp)
      using errcode = 'unique_violation';
  end;

  insert into iam.audit_logs (actor_id, seller_account_id, action, entity, after_value, result)
  values (auth.uid(), v_id, 'shop.add', v_final_name,
          jsonb_build_object('marketplace', v_mp, 'display_name', v_final_name), 'ok');

  return query select v_id, v_final_name, v_mp,
    format('Đã thêm "%s" — bấm Kết nối để authorize với Amazon.', v_final_name);
end;
$$;

comment on function public.vexim_add_shop(text, text) is
  'M0: thêm shop/thị trường mới từ UI (nút "+ Thêm shop"). Chỉ admin. seller_id để rỗng — '
  'callback OAuth điền khi kết nối (0025/0027), tên thật từ Amazon nâng cấp sau (0028). '
  'Audit action=shop.add.';

-- Postgres mặc định grant execute cho PUBLIC khi create function → phải thu
-- hồi từ public TRƯỚC rồi mới grant đích danh, nếu không anon vẫn gọi được.
revoke all on function public.vexim_add_shop(text, text) from public, anon;
grant execute on function public.vexim_add_shop(text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- TỰ KIỂM TRA
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  select count(*) into n
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.proname = 'vexim_add_shop' and p.prosecdef;
  if n <> 1 then raise exception '[0030] FAIL: thiếu RPC vexim_add_shop'; end if;

  if has_function_privilege('anon', 'public.vexim_add_shop(text, text)', 'execute') then
    raise exception '[0030] FAIL: anon vẫn execute được vexim_add_shop';
  end if;

  raise notice '[0030] OK: vexim_add_shop (thêm shop từ UI, chỉ admin, audit shop.add)';
end $$;

commit;
