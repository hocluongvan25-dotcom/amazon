-- ============================================================================
-- 0011 — VIEW ĐỌC CÔNG KHAI CHO WEB (nối các trang vào DB thật)
-- ============================================================================
--
-- BỐI CẢNH:
--   Migration 0010 đã tạo 4 view public đầu tiên (vexim_shop_health, vexim_health_issues,
--   vexim_order_daily, vexim_fbm_queue) để web đọc dữ liệu thật KHÔNG phụ thuộc cấu hình
--   "Exposed schemas" của Supabase. Migration này mở rộng cho các màn còn lại:
--     • Module 4: O1 danh sách đơn · O2 chi tiết đơn · O4 returns
--     • Module 6: F1 settlements · F2 financial events
--     • Module 3: I1 tồn theo SKU (kèm velocity/cover/đề xuất nhập) · I4 inbound
--
--   Quy tắc giữ nguyên:
--     1. `security_invoker = true` → RLS của bảng gốc vẫn áp theo người đăng nhập
--        (không rò dữ liệu giữa các tenant/khách hàng).
--     2. KHÔNG có cột PII người mua (quyết định v1.1) — view chỉ phơi đúng những cột
--        nghiệp vụ; `ship_state`/`ship_country` là mức vùng, được phép.
--     3. View chỉ ĐỌC. Mọi đường ghi vẫn đi qua worker (service_role).
--
-- HAI CỘT DỮ LIỆU BỔ SUNG (để màn hình thật có đủ số, không phải suy diễn):
--   • sales.orders.latest_ship_date — hạn ship THẬT của Amazon (ORDER_CHANGE/getOrders).
--     Không có cột này thì queue FBM luôn phải suy hạn từ purchase_date + 24h và
--     người dùng không phân biệt được "hạn thật" với "hạn ước lượng".
--   • inventory.inventory_daily.velocity + suggest_restock — worker đã tính sẵn khi sync
--     (domain/inventory-metrics.ts) nhưng trước đây không lưu → màn I1 không có số thật.
--
-- IDEMPOTENT: mọi câu lệnh đều `if not exists` / `create or replace view`.
-- THỨ TỰ: chạy SAU 0010.
-- ============================================================================

begin;

-- ============================================================================
-- 1. CỘT DỮ LIỆU BỔ SUNG
-- ============================================================================
alter table sales.orders add column if not exists latest_ship_date timestamptz;

comment on column sales.orders.latest_ship_date is
  'Hạn ship Amazon yêu cầu (ShipDate/LatestShipDate từ getOrders hoặc ORDER_CHANGE). '
  'NULL = report không trả cột này → UI phải hiển thị hạn ƯỚC LƯỢNG (purchase_date + handling).';

create index if not exists idx_orders_fbm_deadline
  on sales.orders (seller_account_id, latest_ship_date)
  where channel = 'MFN' and status in ('Pending', 'Unshipped', 'PartiallyShipped');

alter table inventory.inventory_daily add column if not exists velocity        numeric(10,2);
alter table inventory.inventory_daily add column if not exists suggest_restock int;

comment on column inventory.inventory_daily.velocity is
  'Đơn vị bán/ngày (14 ngày, đã loại 2 ngày đỉnh) — worker tính khi sync (domain/inventory-metrics.ts)';
comment on column inventory.inventory_daily.suggest_restock is
  'Số lượng đề xuất nhập theo SOP-01; NULL = chưa tính được (SKU mới chưa có lịch sử bán → KHÔNG tự bịa số)';

-- ============================================================================
-- 2. VIEW MODULE 4 — ĐƠN HÀNG
-- ============================================================================

-- O1/O2 — danh sách & chi tiết đơn. main_sku = SKU của dòng có số lượng lớn nhất.
create or replace view public.vexim_orders
with (security_invoker = true) as
select
  o.id,
  o.seller_account_id,
  sa.display_name           as shop,
  o.amazon_order_id,
  o.merchant_order_id,
  o.status,
  o.channel,
  o.purchase_date,
  o.last_updated_date,
  o.latest_ship_date,
  o.order_total,
  o.currency,
  o.items_count,
  o.marketplace_id,
  o.ship_state,
  o.ship_country,
  o.pii_stripped,
  i.sku                     as main_sku
from sales.orders o
join connections.seller_accounts sa on sa.id = o.seller_account_id
left join lateral (
  select oi.sku
  from sales.order_items oi
  where oi.order_id = o.id
  order by oi.quantity desc nulls last, oi.sku
  limit 1
) i on true;

-- O2 — dòng hàng của đơn (ASIN/SKU/số lượng/giá)
create or replace view public.vexim_order_items
with (security_invoker = true) as
select
  oi.id,
  oi.order_id,
  o.amazon_order_id,
  o.seller_account_id,
  sa.display_name        as shop,
  oi.amazon_order_item_id,
  oi.sku,
  oi.asin,
  oi.item_name,
  oi.quantity,
  oi.item_price,
  oi.item_status,
  o.currency,
  o.status               as order_status
from sales.order_items oi
join sales.orders o on o.id = oi.order_id
join connections.seller_accounts sa on sa.id = o.seller_account_id;

-- O4 — returns & refunds (mã lý do Amazon + nhãn tiếng Việt + nhóm)
create or replace view public.vexim_returns
with (security_invoker = true) as
select
  r.id,
  r.seller_account_id,
  sa.display_name      as shop,
  r.amazon_order_id,
  r.return_date,
  r.reason,
  r.reason_label,
  r.reason_group,
  r.status,
  r.resolution,
  r.refund_amount,
  r.currency,
  r.sku,
  r.asin,
  r.quantity,
  r.amazon_rma_id,
  r.dedupe_key
from sales.returns_refunds r
join connections.seller_accounts sa on sa.id = r.seller_account_id;

-- O3 — queue FBM: view của 0010 chỉ có cột để LỌC, thiếu cột để HIỂN THỊ
-- (giá trị đơn, tiền tệ, SKU chính) và thiếu hạn ship THẬT. Màn O3 đọc cùng
-- mapper với O1 nên nếu thiếu các cột này thì cột "Giá trị"/"Tiền tệ"/"SKU"
-- sẽ trống khi chạy dữ liệu thật.
-- LƯU Ý: `create or replace view` của PostgreSQL chỉ cho THÊM cột ở CUỐI danh sách
-- (không đổi tên/không chèn giữa) → cột mới phải nằm sau `hours_since_update`.
create or replace view public.vexim_fbm_queue
with (security_invoker = true) as
select
  o.seller_account_id,
  sa.display_name as shop,
  o.amazon_order_id,
  o.status,
  o.purchase_date,
  o.last_updated_date,
  o.ship_state,
  o.ship_country,
  o.items_count,
  round(extract(epoch from (o.last_updated_date - now())) / 3600.0, 1) as hours_since_update,
  o.latest_ship_date,
  o.id,
  o.channel,
  o.order_total,
  o.currency,
  i.sku as main_sku
from sales.orders o
join connections.seller_accounts sa on sa.id = o.seller_account_id
left join lateral (
  select oi.sku
  from sales.order_items oi
  where oi.order_id = o.id
  order by oi.quantity desc nulls last, oi.sku
  limit 1
) i on true
where o.channel = 'MFN'
  and o.status in ('Pending', 'Unshipped', 'PartiallyShipped');

-- ============================================================================
-- 3. VIEW MODULE 6 — TÀI CHÍNH
-- ============================================================================

-- F1 — kỳ settlement (breakdown jsonb do worker ghi: groups/calcTotal/transferSource)
create or replace view public.vexim_settlements
with (security_invoker = true) as
select
  s.id,
  s.seller_account_id,
  sa.display_name as shop,
  s.settlement_id,
  s.period_start,
  s.period_end,
  s.deposit_date,
  s.total_amount,
  s.currency,
  s.status,
  s.breakdown,
  s.reconcile_diff,
  s.reconciled_at,
  s.posted_at
from finance.settlements s
join connections.seller_accounts sa on sa.id = s.seller_account_id;

-- F2 — dòng tiền (append-only theo kỳ settlement)
create or replace view public.vexim_financial_events
with (security_invoker = true) as
select
  e.id,
  e.seller_account_id,
  sa.display_name      as shop,
  e.settlement_id,
  e.event_type,
  e.event_date,
  e.amount,
  e.currency,
  e.sku,
  e.amount_type,
  e.amount_description,
  e.order_id,
  e.quantity,
  e.marketplace_name,
  e.dedupe_key
from finance.financial_events e
join connections.seller_accounts sa on sa.id = e.seller_account_id;

-- ============================================================================
-- 4. VIEW MODULE 3 — KHO VẬN
-- ============================================================================

-- I1/I2 — tồn mới nhất mỗi SKU + chỉ số ngày (velocity/cover/đề xuất do worker tính)
create or replace view public.vexim_inventory_latest
with (security_invoker = true) as
select distinct on (s.seller_account_id, s.sku)
  s.seller_account_id,
  sa.display_name as shop,
  s.sku,
  s.asin,
  s.fulfillable,
  s.reserved,
  s.inbound,
  s.captured_at,
  d.day,
  d.days_of_cover,
  d.velocity,
  d.suggest_restock,
  d.in_stock
from inventory.inventory_snapshots s
join connections.seller_accounts sa on sa.id = s.seller_account_id
left join lateral (
  select dd.day, dd.days_of_cover, dd.velocity, dd.suggest_restock, dd.in_stock
  from inventory.inventory_daily dd
  where dd.seller_account_id = s.seller_account_id
    and dd.sku = s.sku
  order by dd.day desc
  limit 1
) d on true
order by s.seller_account_id, s.sku, s.captured_at desc;

-- I4 — inbound shipments theo trạng thái chuẩn Amazon
create or replace view public.vexim_inbound_shipments
with (security_invoker = true) as
select
  b.id,
  b.seller_account_id,
  sa.display_name as shop,
  b.shipment_id,
  b.status,
  b.quantity,
  b.eta_date,
  b.created_at
from inventory.inbound_shipments b
join connections.seller_accounts sa on sa.id = b.seller_account_id;

-- ============================================================================
-- 5. GRANTS
-- ============================================================================
grant select on
  public.vexim_orders,
  public.vexim_order_items,
  public.vexim_returns,
  public.vexim_fbm_queue,
  public.vexim_settlements,
  public.vexim_financial_events,
  public.vexim_inventory_latest,
  public.vexim_inbound_shipments
to authenticated, service_role;

-- ============================================================================
-- 6. KIỂM CHỨNG (fail sớm — chạy ngay trong migration)
-- ============================================================================
do $$
declare
  n_views int;
  n_cols  int;
begin
  select count(*) into n_views
  from information_schema.views
  where table_schema = 'public'
    and table_name in (
      'vexim_orders', 'vexim_order_items', 'vexim_returns',
      'vexim_settlements', 'vexim_financial_events',
      'vexim_inventory_latest', 'vexim_inbound_shipments'
    );

  if n_views <> 7 then
    raise exception '[0011] FAIL: chỉ thấy % / 7 view mới cho web', n_views;
  end if;

  -- View của 0010 phải còn nguyên (create or replace ở trên không được làm mất)
  if not exists (
    select 1 from information_schema.views
    where table_schema = 'public' and table_name in ('vexim_shop_health', 'vexim_health_issues', 'vexim_order_daily')
    group by table_schema having count(*) = 3
  ) then
    raise exception '[0011] FAIL: view của 0010 bị mất';
  end if;

  select count(*) into n_cols
  from information_schema.columns
  where (table_schema = 'sales' and table_name = 'orders' and column_name = 'latest_ship_date')
     or (table_schema = 'inventory' and table_name = 'inventory_daily'
         and column_name in ('velocity', 'suggest_restock'));

  if n_cols <> 3 then
    raise exception '[0011] FAIL: thiếu cột bổ sung (%/3)', n_cols;
  end if;

  -- Chốt PII lần 2: view KHÔNG được phơi cột định danh người mua
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name like 'vexim\_%'
      and column_name in ('buyer_name', 'buyer_email', 'buyer_phone_number',
                          'ship_address_1', 'recipient_name', 'ship_city', 'ship_postal_code')
  ) then
    raise exception '[0011] FAIL: view phơi cột PII — vi phạm quyết định v1.1';
  end if;

  raise notice '[0011] XONG: 7 view đọc + 3 cột bổ sung, không có PII';
end
$$;

commit;
