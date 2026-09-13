-- ============================================================================
-- 0025 — FIX PGRST205 Ở CALLBACK OAUTH: đọc/ghi seller_accounts qua RPC public
-- ============================================================================
-- SỰ CỐ THẬT (09/2026, sau khi OAuth Amazon đã redirect về thành công):
--
--   Thanh đỏ trên /module0/connect:
--     "Không đọc được shop: Could not find the table 'public.seller_accounts'
--      in the schema cache"   (PGRST205)
--
--   NGUYÊN NHÂN: KHÔNG phải bảng chưa tạo / chưa push migration. Bảng nằm ở
--   connections.seller_accounts (0001) từ đầu. Lỗi do route callback
--   (web/src/app/api/oauth/amazon/callback/route.ts) gọi REST trực tiếp:
--       GET   /rest/v1/seller_accounts?...       (đọc shop)
--       PATCH /rest/v1/seller_accounts?...       (điền seller_id lần đầu)
--   mà KHÔNG gửi header Accept-Profile/Content-Profile: connections
--   → PostgREST tìm trong schema mặc định `public` → PGRST205.
--
--   Đây đúng bài học 0008 (worker từng dính y hệt 12/09/2026): kể cả gửi
--   header đúng, schema `connections` vẫn phải nằm trong "Exposed schemas"
--   của project (mặc định KHÔNG phơi) → cách bền vững là WRAPPER RPC trong
--   schema public, giống vexim_worker_consume_oauth_state / set_oauth_token
--   (0020) — hai RPC đó chạy OK ngay trước bước đọc shop trong cùng luồng,
--   càng chứng minh chỉ mỗi truy cập bảng trực tiếp là gãy.
--
-- PHƯƠNG ÁN: 2 RPC public, security definer, CHỈ service_role (chặn khi
-- auth.uid() có giá trị — giống các vexim_worker_* khác):
--   1. vexim_worker_get_shop(p_seller)            — đọc id/display_name/seller_id
--   2. vexim_worker_claim_seller_id(p_seller, p_seller_id)
--      — điền seller_id Amazon lần đầu (chỉ khi đang rỗng, không ghi đè;
--        đụng unique (seller_id, marketplace) thì trả claimed=false kèm lý do
--        thay vì ném lỗi để callback vẫn hiển thị được thông báo).
--
-- IDEMPOTENT: create or replace + revoke/grant chạy lại vô hại.
-- THỨ TỰ: sau 0001 (bảng) — độc lập với 0023/0024.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. public.vexim_worker_get_shop — callback đọc shop sau khi consume state
-- ---------------------------------------------------------------------------
create or replace function public.vexim_worker_get_shop(p_seller uuid)
returns table (id uuid, display_name text, seller_id text)
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
    select sa.id, sa.display_name, sa.seller_id
    from connections.seller_accounts sa
    where sa.id = p_seller;
end;
$$;

comment on function public.vexim_worker_get_shop(uuid) is
  'Callback OAuth đọc shop (id/display_name/seller_id) — chỉ service_role. '
  'Wrapper public thay cho GET /rest/v1/seller_accounts (PGRST205 vì bảng ở schema connections).';

-- ---------------------------------------------------------------------------
-- 2. public.vexim_worker_claim_seller_id — điền seller_id Amazon lần đầu
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

  select sa.seller_id into v_cur
  from connections.seller_accounts sa
  where sa.id = p_seller;
  if not found then
    return query select p_seller, null::text, false, 'shop không tồn tại';
    return;
  end if;

  -- Chỉ điền khi đang rỗng — KHÔNG ghi đè seller_id đã có (callback tự chặn
  -- mismatch trước đó, nhưng RPC vẫn phải tự bảo vệ mình).
  if coalesce(btrim(v_cur), '') <> '' then
    return query select p_seller, v_cur,
      (v_cur = v_new),
      case when v_cur = v_new then 'seller_id đã đúng từ trước'
           else 'shop đã có seller_id khác — không ghi đè' end;
    return;
  end if;

  begin
    update connections.seller_accounts sa
    set seller_id = v_new
    where sa.id = p_seller;
  exception when unique_violation then
    -- unique (seller_id, marketplace): seller này đã gắn với shop khác cùng
    -- marketplace. Trả lý do thay vì ném lỗi — callback vẫn báo được cho user.
    return query select p_seller, v_cur, false,
      format('seller_id %s đã gắn với shop khác cùng marketplace (unique seller_id+marketplace)', v_new);
    return;
  end;

  return query select p_seller, v_new, true, 'đã điền seller_id lần đầu';
end;
$$;

comment on function public.vexim_worker_claim_seller_id(uuid, text) is
  'Callback OAuth điền seller_id Amazon lần đầu (chỉ khi đang rỗng, không ghi đè) — chỉ service_role. '
  'Wrapper public thay cho PATCH /rest/v1/seller_accounts (PGRST205 vì bảng ở schema connections).';

-- ---------------------------------------------------------------------------
-- 3. Quyền: chỉ service_role (giống các vexim_worker_* trong 0020)
-- ---------------------------------------------------------------------------
do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'vexim_worker_get_shop(uuid)',
    'vexim_worker_claim_seller_id(uuid, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', v_fn);
    execute format('grant execute on function public.%s to service_role', v_fn);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 4. TỰ KIỂM TRA
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
begin
  select count(*) into n
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public'
    and p.proname in ('vexim_worker_get_shop', 'vexim_worker_claim_seller_id')
    and p.prosecdef;  -- phải là security definer
  if n <> 2 then
    raise exception '[0025] FAIL: thiếu RPC hoặc không phải security definer (%/2)', n;
  end if;

  -- anon/authenticated KHÔNG được execute
  if has_function_privilege('anon', 'public.vexim_worker_get_shop(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.vexim_worker_get_shop(uuid)', 'execute')
     or has_function_privilege('anon', 'public.vexim_worker_claim_seller_id(uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'public.vexim_worker_claim_seller_id(uuid, text)', 'execute') then
    raise exception '[0025] FAIL: anon/authenticated vẫn execute được RPC worker';
  end if;

  raise notice '[0025] OK: 2 RPC public cho callback OAuth (get_shop + claim_seller_id), chỉ service_role';
end $$;

commit;
