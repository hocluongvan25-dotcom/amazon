-- ============================================================================
-- 0012 — VIEW MODULE 1: LISTING & CONTENT (L1, L2, L4)
-- ============================================================================
-- View đọc công khai cho Module 1 — Listing.
--   • vexim_listings: danh sách listing + issues đếm + offer gần nhất
--   • vexim_listing_queue: listing có vấn đề (inactive/stranded/suppressed + có issues)
--
-- BỐI CẢNH:
--   catalog.listings + catalog.listing_offers đã có từ 0001.
--   Cần view public để web đọc bằng anon key + RLS enforced.
--
-- security_invoker = true → RLS của bảng gốc vẫn áp.
-- GRANT SELECT cho authenticated, service_role.
-- Idempotent: create or replace view.
-- ============================================================================

begin;

-- ============================================================================
-- 1. VIEW: vexim_listings — danh sách listing + issues + offer
-- ============================================================================
create or replace view public.vexim_listings
with (security_invoker = true) as
select
  l.id,
  l.seller_account_id,
  sa.display_name           as shop,
  l.sku,
  l.asin,
  l.title,
  l.status,
  l.price,
  l.currency,
  l.updated_at,
  -- Issues đếm từ JSONB array
  coalesce((
    select count(*)
    from jsonb_array_elements(coalesce(l.issues, '[]'::jsonb)) e
    where e->>'severity' = 'ERROR'
  ), 0)                     as error_count,
  coalesce((
    select count(*)
    from jsonb_array_elements(coalesce(l.issues, '[]'::jsonb)) e
    where e->>'severity' = 'WARNING'
  ), 0)                     as warning_count,
  -- Issues array (để L2 chi tiết)
  l.issues,
  -- Offer gần nhất
  o.buy_box_won,
  o.buy_box_price,
  o.competitor_price,
  o.captured_at             as offer_captured_at
from catalog.listings l
join connections.seller_accounts sa on sa.id = l.seller_account_id
left join lateral (
  select lo.buy_box_won, lo.buy_box_price, lo.competitor_price, lo.captured_at
  from catalog.listing_offers lo
  where lo.seller_account_id = l.seller_account_id
    and lo.sku = l.sku
  order by lo.captured_at desc
  limit 1
) o on true;

-- ============================================================================
-- 2. VIEW: vexim_listing_queue — listing có vấn đề (cho L4 + overview)
-- ============================================================================
create or replace view public.vexim_listing_queue
with (security_invoker = true) as
select
  l.id,
  l.seller_account_id,
  sa.display_name           as shop,
  l.sku,
  l.asin,
  l.title,
  l.status,
  l.price,
  l.currency,
  l.updated_at,
  l.issues,
  coalesce((
    select count(*)
    from jsonb_array_elements(coalesce(l.issues, '[]'::jsonb)) e
    where e->>'severity' = 'ERROR'
  ), 0)                     as error_count,
  coalesce((
    select count(*)
    from jsonb_array_elements(coalesce(l.issues, '[]'::jsonb)) e
    where e->>'severity' = 'WARNING'
  ), 0)                     as warning_count
from catalog.listings l
join connections.seller_accounts sa on sa.id = l.seller_account_id
where l.status in ('inactive', 'stranded', 'suppressed', 'INACTIVE', 'STRANDED', 'SUPPRESSED')
   or l.issues is not null and jsonb_array_length(coalesce(l.issues, '[]'::jsonb)) > 0;

-- ============================================================================
-- 3. GRANTS
-- ============================================================================
grant select on
  public.vexim_listings,
  public.vexim_listing_queue
to authenticated, service_role;

-- ============================================================================
-- 4. KIỂM CHỨNG (fail sớm)
-- ============================================================================
do $$
declare
  n_views int;
begin
  select count(*) into n_views
  from information_schema.views
  where table_schema = 'public'
    and table_name in ('vexim_listings', 'vexim_listing_queue');

  if n_views <> 2 then
    raise exception '[0012] FAIL: chỉ thấy % / 2 view mới cho Module 1', n_views;
  end if;

  -- Không phơi PII
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name like 'vexim_listing%'
      and column_name in ('buyer_name', 'buyer_email', 'buyer_phone_number',
                          'ship_address_1', 'recipient_name')
  ) then
    raise exception '[0012] FAIL: view phơi cột PII';
  end if;

  raise notice '[0012] XONG: 2 view listing cho Module 1';
end
$$;

commit;
