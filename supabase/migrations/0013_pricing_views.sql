-- ============================================================================
-- 0013 — VIEW MODULE 2: GIÁ & FEATURED OFFER (P1, P2, P3)
-- ============================================================================
-- View đọc công khai cho Module 2 — Pricing.
--   • vexim_pricing: listings + offer gần nhất + fees estimate
--   • vexim_price_approvals: placeholder cho hàng chờ duyệt giá
--
-- catalog.listings + catalog.listing_offers + catalog.fees_estimates
-- đã có từ 0001.
--
-- security_invoker = true → RLS của bảng gốc vẫn áp.
-- Idempotent: create or replace view.
-- ============================================================================

begin;

-- ============================================================================
-- 1. VIEW: vexim_pricing — mỗi SKU 1 dòng, join offer + fees mới nhất
-- ============================================================================
create or replace view public.vexim_pricing
with (security_invoker = true) as
select
  l.id,
  l.seller_account_id,
  sa.display_name           as shop,
  l.sku,
  l.asin,
  l.title,
  l.price                   as our_price,
  l.currency,
  l.updated_at,
  -- Offer gần nhất
  o.buy_box_won,
  o.buy_box_price,
  o.competitor_price,
  o.captured_at             as offer_captured_at,
  -- Fees estimate gần nhất
  f.referral_fee,
  f.fba_fee,
  f.total_fee               as total_fees,
  f.estimated_at            as fees_estimated_at
from catalog.listings l
join connections.seller_accounts sa on sa.id = l.seller_account_id
left join lateral (
  select lo.buy_box_won, lo.buy_box_price, lo.competitor_price, lo.captured_at
  from catalog.listing_offers lo
  where lo.seller_account_id = l.seller_account_id
    and lo.sku = l.sku
  order by lo.captured_at desc
  limit 1
) o on true
left join lateral (
  select fe.referral_fee, fe.fba_fee, fe.total_fee, fe.estimated_at
  from catalog.fees_estimates fe
  where fe.seller_account_id = l.seller_account_id
    and fe.sku = l.sku
  order by fe.estimated_at desc
  limit 1
) f on true;

-- ============================================================================
-- 2. GRANTS
-- ============================================================================
grant select on
  public.vexim_pricing
to authenticated, service_role;

-- ============================================================================
-- 3. KIỂM CHỨNG
-- ============================================================================
do $$
declare
  n_views int;
begin
  select count(*) into n_views
  from information_schema.views
  where table_schema = 'public'
    and table_name = 'vexim_pricing';

  if n_views <> 1 then
    raise exception '[0013] FAIL: vexim_pricing view chưa tạo được';
  end if;

  raise notice '[0013] XONG: 1 view pricing cho Module 2';
end
$$;

commit;
