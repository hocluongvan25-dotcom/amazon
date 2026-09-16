-- ============================================================================
-- 0031 — TÊN SHOP AMAZON (storeName) ĐỔ VỀ DB + UI
-- ============================================================================
-- VẤN ĐỀ (người dùng báo 16/09/2026):
--   "Đã kết nối được shop nhưng KHÔNG hiển thị tên shop Amazon đã kéo về."
--
--   Điều tra theo mô hình chính thức của Amazon
--   (models/sellers-api-model/sellers.json — repo amzn/selling-partner-api-models):
--
--     getMarketplaceParticipations (GET /sellers/v1/marketplaceParticipations)
--     trả về mảng MarketplaceParticipation, mỗi phần tử BẮT BUỘC có:
--         {
--           "marketplace":   { "id", "name", "countryCode", ... },
--           "participation": { "isParticipating", "hasSuspendedListings" },
--           "storeName":     "The name of the seller's store as displayed in
--                             the marketplace"            ← TÊN SHOP
--         }
--     (storeName có từ changelog SP-API 18/12/2024: "The response now contains
--      a storeName, which you can use to get the name of the seller's store as
--      displayed in the marketplace".)
--
--   Code hiện tại chỉ đọc marketplace.id / marketplace.name (= tên SÀN, ví dụ
--   "Amazon.com") và BỎ QUA storeName ⇒ tên shop Amazon không bao giờ về tới DB,
--   nên không có gì để hiển thị. Không phải lỗi kết nối, không phải lỗi token.
--
--   DB cũng KHÔNG có cột nào chứa tên shop: `display_name` là nhãn vận hành do
--   người dùng đặt ("VEXIM US - Chính"), không phải dữ liệu Amazon trả về.
--
-- NỘI DUNG MIGRATION:
--   1. Cột `store_name` + nguồn + thời điểm đồng bộ trên connections.seller_accounts
--   2. View `public.vexim_shops` phơi thêm store_name (thêm cột ở CUỐI — điều
--      kiện để `create or replace view` không phải drop/cascade)
--   3. RPC `vexim_worker_set_shop_store_name` — worker/callback ghi tên shop
--   4. RPC `vexim_worker_list_shop_credentials` — worker đọc shop + token ĐÓNG
--      để tự đồng bộ tên shop (chỉ service_role, KHÔNG phơi schema connections)
--
-- IDEMPOTENT: `add column if not exists` + `create or replace` ⇒ chạy lại vô hại.
-- THỨ TỰ: chạy SAU 0030.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Cột lưu tên shop Amazon
--    • `store_name`           — NGUYÊN VĂN storeName Amazon trả về cho marketplace
--                               của dòng đó (US và CA có thể khác tên nhau).
--    • `store_name_source`    — 'spapi' (đồng bộ từ API) | 'manual' (vận hành sửa tay)
--    • `store_name_synced_at` — lần cuối lấy được từ Amazon (để biết dữ liệu cũ)
--    KHÔNG ghi đè display_name: nhãn vận hành (VEXIM US - Chính) vẫn giữ nguyên,
--    tên Amazon là TRƯỜNG RIÊNG, hiển thị cạnh nhãn.
-- ---------------------------------------------------------------------------
alter table connections.seller_accounts
  add column if not exists store_name           text,
  add column if not exists store_name_source    text,
  add column if not exists store_name_synced_at timestamptz;

comment on column connections.seller_accounts.store_name is
  'Tên shop trên Amazon (Sellers API v1 — storeName của getMarketplaceParticipations). '
  'KHÁC display_name (nhãn vận hành do VEXIM đặt). Rỗng = chưa đồng bộ được.';
comment on column connections.seller_accounts.store_name_source is
  'nguồn của store_name: spapi | manual';
comment on column connections.seller_accounts.store_name_synced_at is
  'lần cuối store_name được đồng bộ từ SP-API';

-- ---------------------------------------------------------------------------
-- 2. View public.vexim_shops — phơi thêm store_name (+ thời điểm đồng bộ)
--
--    ⚠️ Postgres chỉ cho `create or replace view` khi 10 cột cũ giữ nguyên
--    tên/thứ tự (cột mới chỉ được THÊM Ở CUỐI). Trong khi đó view này đã bị đổi
--    cấu trúc ở migration 0024 (thêm seller_id/display_name/marketplace_id vào
--    GIỮA). Hệ quả: một deployment chỉ chạy tới 0016 mà bị nhảy cóc tới 0031 sẽ
--    lỗi "cannot change name of view column ...". Vì vậy:
--      • nếu view đang ở shape 0024  → create or replace (thêm 2 cột cuối);
--      • nếu view còn ở shape 0016  → dựng lại (drop KHÔNG cascade: có object
--        phụ thuộc thì DỪNG và báo lỗi, tuyệt đối không âm thầm xoá view khác);
--      • đã có store_name (chạy lại) → bỏ qua, giữ nguyên.
--    Đích cuối cùng luôn là MỘT shape: 12 cột, khớp SHOP_SELECT_V3 của
--    web/src/lib/data/oauth.ts.
-- ---------------------------------------------------------------------------
do $$
declare
  v_has_seller_id  boolean;
  v_has_store_name boolean;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'vexim_shops' and column_name = 'seller_id'
  ) into v_has_seller_id;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'vexim_shops' and column_name = 'store_name'
  ) into v_has_store_name;

  if v_has_store_name then
    raise notice '[0031] vexim_shops đã có store_name — giữ nguyên view';
    return;
  end if;

  if not v_has_seller_id then
    -- Shape 0016 (thiếu seller_id/display_name/marketplace_id) ⇒ buộc phải dựng lại.
    raise notice '[0031] vexim_shops đang ở shape 0016 — dựng lại view theo shape 0024 + store_name';
    execute 'drop view if exists public.vexim_shops';
  end if;

  execute $v$
    create or replace view public.vexim_shops
    with (security_invoker = true) as
    select
      sa.id                 as seller_account_id,
      sa.seller_id          as seller_id,
      sa.display_name       as shop,
      sa.display_name       as display_name,
      sa.marketplace        as marketplace,
      sa.marketplace        as marketplace_id,
      sa.status,
      sa.data_source,
      sa.health_status,
      sa.last_sync_at,
      sa.store_name,
      sa.store_name_synced_at
    from connections.seller_accounts sa
  $v$;
end
$$;

grant select on public.vexim_shops to authenticated, service_role;

comment on view public.vexim_shops is
  'Shop người dùng đọc được (RLS của connections.seller_accounts vẫn áp). '
  'display_name/shop = nhãn vận hành; store_name = tên shop Amazon (storeName) '
  'lấy từ Sellers API v1 (migration 0031).';

-- ---------------------------------------------------------------------------
-- 3. RPC ghi tên shop — CHỈ service_role (callback OAuth + server action + cron)
--    • Không bao giờ ghi tên rỗng (Amazon trả thiếu storeName thì giữ giá trị cũ).
--    • `changed` cho biết có đổi tên không (UI/log biết đây là tin mới hay cũ).
-- ---------------------------------------------------------------------------
create or replace function public.vexim_worker_set_shop_store_name(
  p_seller     uuid,
  p_store_name text,
  p_source     text default 'spapi'
)
returns table (id uuid, store_name text, changed boolean)
language plpgsql
security definer
set search_path = connections, public, pg_catalog
as $$
declare
  v_name text;
  v_src  text;
  v_old  text;
begin
  -- Chặn người dùng web: service_role không có auth.uid()
  if auth.uid() is not null then
    raise exception '[SHOP] RPC này chỉ dành cho server (service_role)'
      using errcode = 'insufficient_privilege';
  end if;

  if p_seller is null then
    raise exception '[SHOP] thiếu seller_account_id'
      using errcode = 'invalid_parameter_value';
  end if;

  v_name := nullif(btrim(coalesce(p_store_name, '')), '');
  if v_name is null then
    -- Amazon không trả storeName (app cũ / field thiếu): KHÔNG xoá tên đang có.
    return query select p_seller, null::text, false;
    return;
  end if;

  v_src := lower(btrim(coalesce(p_source, 'spapi')));
  if v_src not in ('spapi', 'manual') then
    v_src := 'spapi';
  end if;

  select sa.store_name into v_old
  from connections.seller_accounts sa
  where sa.id = p_seller;

  if not found then
    raise exception '[SHOP] không tìm thấy seller_account %', p_seller
      using errcode = 'no_data_found';
  end if;

  update connections.seller_accounts sa
     set store_name           = v_name,
         store_name_source    = v_src,
         store_name_synced_at = now()
   where sa.id = p_seller;

  return query select p_seller, v_name, (v_old is distinct from v_name);
end;
$$;

comment on function public.vexim_worker_set_shop_store_name(uuid, text, text) is
  'Ghi tên shop Amazon (storeName của getMarketplaceParticipations) vào '
  'connections.seller_accounts.store_name — chỉ service_role. Tên rỗng bị bỏ qua '
  '(không xoá dữ liệu cũ). Trả `changed` để biết có đổi tên hay không.';

-- ---------------------------------------------------------------------------
-- 4. RPC đọc shop + token cho worker/callback (self-service đồng bộ tên shop)
--    Vì sao cần: refresh token nằm ở connections.oauth_tokens — bảng KHÔNG có
--    policy RLS và không phơi ra PostgREST cho web. Muốn lấy tên shop của ĐÚNG
--    shop đó thì phải gọi Participations bằng CHÍNH token của shop (không dùng
--    token shop khác, nếu không sẽ ghi tên shop A cho shop B).
--    Hàm này trả cả refresh_token ⇒ revoke khỏi public/anon/authenticated,
--    CHỈ service_role, và tự kiểm tra quyền ngay trong thân hàm.
-- ---------------------------------------------------------------------------
create or replace function public.vexim_worker_list_shop_credentials()
returns table (
  seller_account_id uuid,
  seller_id         text,
  marketplace       text,
  display_name      text,
  store_name        text,
  shop_status       text,
  data_source       text,
  has_token         boolean,
  refresh_token     text,
  token_expires_at  timestamptz
)
language plpgsql
security definer
set search_path = connections, public, pg_catalog
as $$
begin
  if auth.uid() is not null then
    raise exception '[SHOP] RPC này chỉ dành cho server (service_role)'
      using errcode = 'insufficient_privilege';
  end if;

  return query
    select sa.id,
           sa.seller_id,
           sa.marketplace,
           sa.display_name,
           sa.store_name,
           sa.status,
           sa.data_source::text,
           (t.id is not null),
           t.encrypted_refresh_token,
           t.expires_at
    from connections.seller_accounts sa
    left join connections.oauth_tokens t on t.seller_account_id = sa.id
    where sa.status <> 'revoked'
    order by sa.seller_id, sa.marketplace;
end;
$$;

comment on function public.vexim_worker_list_shop_credentials() is
  'Danh sách shop + refresh token (nếu đã authorize) cho tác vụ đồng bộ tên shop '
  '(storeName). CHỈ service_role — không phơi ra web. Trả nguyên refresh token nên '
  'tuyệt đối không grant cho authenticated/anon.';

-- ---------------------------------------------------------------------------
-- 5. Quyền: hai RPC trên chỉ service_role
-- ---------------------------------------------------------------------------
revoke all on function public.vexim_worker_set_shop_store_name(uuid, text, text)
  from public, anon, authenticated;
grant  execute on function public.vexim_worker_set_shop_store_name(uuid, text, text)
  to service_role;

revoke all on function public.vexim_worker_list_shop_credentials()
  from public, anon, authenticated;
grant  execute on function public.vexim_worker_list_shop_credentials()
  to service_role;

-- ---------------------------------------------------------------------------
-- 6. TỰ KIỂM TRA
-- ---------------------------------------------------------------------------
do $$
declare
  n     int;
  v_col text;
begin
  -- 6.1 Ba cột mới có mặt trên connections.seller_accounts
  foreach v_col in array array['store_name', 'store_name_source', 'store_name_synced_at'] loop
    select count(*) into n
    from information_schema.columns
    where table_schema = 'connections'
      and table_name = 'seller_accounts'
      and column_name = v_col;
    if n <> 1 then
      raise exception '[0031] FAIL: connections.seller_accounts thiếu cột %', v_col;
    end if;
  end loop;

  -- 6.2 View public.vexim_shops phơi store_name (và GIỮ đủ 10 cột cũ)
  select count(*) into n
  from information_schema.columns
  where table_schema = 'public' and table_name = 'vexim_shops'
    and column_name in ('seller_account_id','seller_id','shop','display_name',
                        'marketplace','marketplace_id','status','data_source',
                        'health_status','last_sync_at','store_name','store_name_synced_at');
  if n <> 12 then
    raise exception '[0031] FAIL: public.vexim_shops có %/12 cột mong đợi', n;
  end if;

  -- 6.3 Hai RPC security definer + chỉ service_role gọi được
  foreach v_col in array array[
    'vexim_worker_set_shop_store_name(uuid, text, text)',
    'vexim_worker_list_shop_credentials()'
  ] loop
    select count(*) into n
    from pg_proc p
    where p.oid = to_regprocedure('public.' || v_col)
      and p.prosecdef
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and not has_function_privilege('anon', p.oid, 'EXECUTE')
      and has_function_privilege('service_role', p.oid, 'EXECUTE');
    if n <> 1 then
      raise exception '[0031] FAIL: RPC % thiếu / không security definer / sai quyền', v_col;
    end if;
  end loop;

  -- 6.4 Không được có policy ghi mới nào trên connections.seller_accounts
  --     (web vẫn KHÔNG ghi thẳng được — mọi thứ đi qua RPC service_role)
  select count(*) into n
  from pg_policies
  where schemaname = 'connections' and tablename = 'seller_accounts' and cmd <> 'SELECT';
  if n <> 0 then
    raise exception
      '[0031] FAIL: có % policy ghi trên connections.seller_accounts — web phải KHÔNG ghi được', n;
  end if;

  raise notice '[0031] OK — cột store_name + view vexim_shops + 2 RPC service_role';
end
$$;

commit;
