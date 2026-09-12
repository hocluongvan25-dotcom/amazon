-- Migration 0005 — Helper RPC cho worker đồng bộ tồn kho (tính velocity)
-- Chay sau 0001..0004. Idempotent.

-- 1. Cấp quyền cho authenticator gọi RPC trên schema inventory (Supabase dùng role authenticator cho cả service_role).
grant usage on schema inventory to service_role;
grant all on all tables in schema inventory to service_role;
grant all on all tables in schema sales to service_role;
grant all on all tables in schema connections to service_role;
grant all on all tables in schema ops to service_role;

-- 2. Helper RPC: tra cứu doanh số theo ngày cho 1 SKU trong N ngày qua (dùng tính velocity).
create or replace function inventory.units_sold_per_day(
  p_seller uuid,
  p_sku text,
  p_days int
) returns table(d date, q bigint)
language sql stable
as $$
  select date_trunc('day', o.purchase_date)::date as d,
         coalesce(sum(oi.quantity), 0)::bigint as q
  from sales.orders o
  join sales.order_items oi on oi.order_id = o.id
  where o.seller_account_id = p_seller
    and oi.sku = p_sku
    and o.status in ('Shipped','Delivered')
    and o.purchase_date >= now() - (p_days || ' days')::interval
  group by 1
  order by 1 desc;
$$;

-- 3. Helper RPC: lấy seller_accounts đang active + data_source = 'production' để worker chạy sync.
create or replace function connections.active_production_shops()
returns table(
  id uuid,
  seller_id text,
  marketplace text,
  display_name text,
  lead_days int,
  safety_days int
)
language sql stable
as $$
  select sa.id, sa.seller_id, sa.marketplace, sa.display_name, 32, 14
  from connections.seller_accounts sa
  where sa.status = 'active' and sa.data_source = 'production';
$$;
