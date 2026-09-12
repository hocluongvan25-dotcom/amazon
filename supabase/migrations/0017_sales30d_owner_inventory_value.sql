-- ============================================================================
-- 0017 — ĐỢT B "HÁI QUẢ NGAY": doanh số 30 ngày · người phụ trách · giá trị tồn
-- ============================================================================
-- 0016 đã mở khoá giá vốn + ghi listing thật. Nhưng trên UI vẫn còn ba chỗ hiển
-- thị số 0 / dấu "—" trong khi DỮ LIỆU ĐÃ CÓ SẴN trong DB:
--
--   (1) P1 `velocity30d = 0`, L1 `revenue30d = 0`
--       `sales.orders` + `sales.order_items` đã được worker orders:sync ghi, chỉ
--       CHƯA có view nào gộp theo SKU. Thiếu 2 số này thì P1 không ước lượng được
--       "mất Buy Box thiệt bao nhiêu đơn/ngày", L1 không xếp ưu tiên sửa listing
--       theo doanh thu (nút sort "Doanh thu 30 ngày" đang sort trên toàn số 0).
--
--   (2) P1/L1/L4 `owner = "—"`
--       `iam.assignments` đã có người phụ trách theo (shop × module), NHƯNG RLS
--       của `iam.user_profiles`/`iam.assignments` chỉ cho đọc CHÍNH MÌNH (hoặc
--       super_admin) → view `security_invoker` join thẳng sẽ ra NULL với mọi user
--       thường. Phải đi qua hàm security definer trả VỀ TÊN (không email, không
--       uuid) — cùng tinh thần `vexim_health_issues` chỉ phơi `owner_id`.
--
--   (3) Module 3 — I3 `unitCost = "—"`, `value = "—"`
--       0016 đã có giá vốn hiệu lực THẬT, nên "giá trị tồn kho" (vốn đang nằm ở
--       FC + đang trên đường về) tính được ngay: Σ tồn × unit_cost.
--
-- NGUYÊN TẮC GIỮ NGUYÊN TỪ 0014/0015/0016:
--   • `create or replace view` chỉ được NỐI THÊM cột ở CUỐI — web đọc bằng chuỗi
--     select cố định (PRICING_SELECT / LISTINGS_SELECT / INVENTORY_SELECT), thêm
--     cột sai chỗ là PostgREST trả PGRST204 và SẬP CẢ TRANG.
--   • View công khai = `security_invoker = true` → RLS bảng gốc vẫn áp.
--   • KHÔNG CÓ DỮ LIỆU → NULL + nhãn nói rõ (`value_basis`, `revenue_currency`),
--     KHÔNG BAO GIỜ đoán 0. "Chưa có đơn nào" ≠ "đã bán 0 đơn".
--   • KHÔNG phơi PII: chỉ tên nhân viên VEXIM phụ trách, không email/không uuid.
--   • Một định nghĩa duy nhất: doanh số 30 ngày nằm ở `vexim_sku_sales_30d`,
--     P1/L1/L4 đều join về đó để ba màn không lệch nhau.
--
-- Idempotent: `create or replace` / `create index if not exists` / grant.
-- Chạy SAU 0016.
-- ============================================================================

begin;

-- ============================================================================
-- 1. iam.module_owner() — AI PHỤ TRÁCH shop này ở module nào
-- ============================================================================
-- Vì sao security definer: RLS `rls_read_assignments` / `rls_read_user_profiles_self`
-- (0001) chỉ cho user đọc assignment + hồ sơ CỦA CHÍNH MÌNH. Nếu view join thẳng
-- thì operator thấy owner = NULL cho đồng nghiệp của mình → cột "Phụ trách" chết.
-- Hàm này chỉ trả VỀ TÊN HIỂN THỊ (không email, không user_id) và tự chặn:
--   • user của KHÁCH HÀNG (`vexim_employee = false`) không bao giờ bị nêu tên;
--   • user không đọc được shop (`iam.can_read_seller_account`) → NULL, kể cả khi
--     gọi thẳng hàm để dò tên người phụ trách của shop lạ;
--   • `auth.uid() is null` = worker/service_role → cho qua (không có ngữ cảnh user).
-- Ưu tiên người được `can_write` (người THẬT SỰ xử lý), rồi tới người gán sớm nhất.
create or replace function iam.module_owner(p_seller uuid, p_module iam.module_code)
returns text
language sql stable security definer
set search_path = iam, pg_catalog
as $$
  select up.display_name
  from iam.assignments a
  join iam.user_profiles up on up.id = a.user_id
  where a.seller_account_id = p_seller
    and a.module = p_module
    and up.vexim_employee = true
    and (auth.uid() is null or iam.can_read_seller_account(p_seller))
  order by a.can_write desc, a.created_at asc, up.display_name asc
  limit 1;
$$;

comment on function iam.module_owner(uuid, iam.module_code) is
  'P1/L1/L4: tên nhân viên VEXIM phụ trách shop ở module này (ưu tiên can_write). '
  'KHÔNG trả email/uuid — không phải PII. NULL khi chưa gán ai.';

revoke all on function iam.module_owner(uuid, iam.module_code) from public, anon;
grant execute on function iam.module_owner(uuid, iam.module_code) to authenticated, service_role;

-- ============================================================================
-- 2. catalog.effective_cost_row() — tra giá vốn KHÔNG PHÂN BIỆT HOA/THƯỜNG
-- ============================================================================
-- Lỗ hổng còn lại của 0016: `catalog.cost_inputs.sku` LUÔN viết hoa
-- (`apply_cost_input` chuẩn hoá `upper(btrim(p_sku))`), còn `catalog.listings.sku`
-- và `inventory.inventory_snapshots.sku` giữ NGUYÊN xi như report ghi
-- (worker chỉ `btrim`). SKU lẫn một chữ thường → P1/Module 3 báo "thiếu giá vốn"
-- dù đã nhập. Sửa ở MỘT chỗ (hàm lõi) để `effective_cost()`, `vexim_pricing`,
-- `vexim_cost_coverage` và view tồn kho mới đều hưởng.
create or replace function catalog.effective_cost_row(
  p_seller uuid, p_sku text, p_on date default current_date)
returns table (
  cost_input_id  uuid,
  unit_cost      numeric,
  currency       text,
  effective_from date,
  effective_to   date,
  source         text
)
language sql stable security definer
set search_path = catalog, pg_catalog
as $$
  select ci.id, ci.unit_cost, ci.currency, ci.effective_from, ci.effective_to, ci.source
  from catalog.cost_inputs ci
  where ci.seller_account_id = p_seller
    -- cost_inputs.sku đã được chuẩn hoá VIẾT HOA khi ghi → so sánh ở dạng viết hoa
    and ci.sku = upper(btrim(coalesce(p_sku, '')))
    and ci.effective_from <= p_on
    and (ci.effective_to is null or ci.effective_to > p_on)
  order by ci.effective_from desc
  limit 1;
$$;

comment on function catalog.effective_cost_row(uuid, text, date) is
  'Bậc giá vốn hiệu lực tại ngày p_on (kèm tiền tệ + mốc) — lõi của catalog.effective_cost(). '
  'SKU so sánh không phân biệt hoa/thường (0017).';

-- ============================================================================
-- 3. Index cho join đơn hàng → dòng đơn (aggregate 30 ngày đi qua đường này)
-- ============================================================================
-- `sales.order_items` chưa có index nào ngoài PK: aggregate 30 ngày phải quét
-- toàn bộ dòng đơn mỗi lần mở P1/L1.
create index if not exists idx_order_items_order on sales.order_items (order_id);

-- `iam.module_owner()` tra theo (shop × module); unique index cũ dẫn đầu bằng
-- user_id nên KHÔNG dùng được cho hướng tra cứu này — mỗi dòng listing/pricing
-- gọi hàm một lần, thiếu index là quét bảng assignments nghìn lần.
create index if not exists idx_assignments_shop_module
  on iam.assignments (seller_account_id, module);

-- ============================================================================
-- 4. VIEW vexim_sku_sales_30d — MỘT định nghĩa doanh số 30 ngày theo SKU
-- ============================================================================
-- Đếm những đơn KHÔNG bị huỷ: loại 'Cancelled'/'Canceled' (report lẫn API dùng cả
-- hai cách viết) và 'Unfulfillable' (đơn không giao được). Đơn 'Pending'/'Unshipped'
-- VẪN TÍNH vì P1 cần "cầu thật" để ước lượng thiệt hại khi mất Buy Box, L1 cần
-- biết listing nào đang ra tiền.
--   ⚠ KHÁC `inventory.units_sold_per_day()` (0005): hàm đó chỉ đếm Shipped/Delivered
--     trong 14 ngày để tính velocity NHẬP HÀNG (Module 3) — hai con số phục vụ hai
--     quyết định khác nhau, cố ý không gộp làm một.
-- Doanh thu = Σ item_price × quantity của dòng đơn. Nếu shop có đơn ở >1 tiền tệ
-- (thực tế không xảy ra — 1 shop 1 marketplace) thì KHÔNG cộng gộp bừa:
-- `currency_mixed = true` để tầng trên hiện "—" thay vì một con số sai tiền tệ.
create or replace view public.vexim_sku_sales_30d
with (security_invoker = true) as
select
  o.seller_account_id,
  sa.display_name                                     as shop,
  upper(btrim(oi.sku))                                as sku,
  sum(coalesce(oi.quantity, 0))::int                  as units_30d,
  count(distinct o.id)::int                           as orders_30d,
  round(sum(coalesce(oi.item_price, 0) * coalesce(oi.quantity, 0)), 2) as revenue_30d,
  min(o.currency)                                     as currency,
  (count(distinct o.currency) > 1)                    as currency_mixed,
  max(o.purchase_date)                                as last_order_at
from sales.orders o
join sales.order_items oi          on oi.order_id = o.id
join connections.seller_accounts sa on sa.id = o.seller_account_id
where o.purchase_date >= now() - interval '30 days'
  and upper(coalesce(o.status, '')) not in ('CANCELLED','CANCELED','UNFULFILLABLE')
  and nullif(btrim(coalesce(oi.sku, '')), '') is not null
group by o.seller_account_id, sa.display_name, upper(btrim(oi.sku));

comment on view public.vexim_sku_sales_30d is
  'P1/L1/L4: đơn vị · số đơn · doanh thu 30 ngày theo (shop × SKU), loại đơn huỷ. '
  'NULL/không có dòng = chưa có đơn nào trong 30 ngày (không suy ra 0 giả).';

-- ============================================================================
-- 5. VIEW vexim_pricing (P1) — nối THÊM 7 cột ở CUỐI
-- ============================================================================
-- Giữ NGUYÊN định nghĩa 0016 (giá vốn hiệu lực + giá sàn + biên), chỉ nối thêm
-- doanh số 30 ngày và người phụ trách module pricing.
create or replace view public.vexim_pricing
with (security_invoker = true) as
select
  b.id,
  b.seller_account_id,
  b.shop,
  b.sku,
  b.asin,
  b.title,
  b.our_price,
  b.currency,
  b.updated_at,
  b.buy_box_won,
  b.buy_box_price,
  b.competitor_price,
  b.offer_captured_at,
  b.referral_fee,
  b.fba_fee,
  b.total_fees,
  b.fees_estimated_at,
  b.unit_cost,
  b.cost_currency,
  b.cost_effective_from,
  b.cost_source,
  b.referral_rate_used,
  b.min_margin_rate,
  b.other_fee_per_unit,
  b.floor_price,
  b.gross_profit,
  b.margin_pct,
  b.below_floor,
  b.cost_basis,
  -- ↓ cột mới (0017) — phải nằm CUỐI để không phá cột web đang đọc
  b.units_30d,
  b.orders_30d,
  b.revenue_30d,
  b.revenue_currency,
  b.velocity_30d,
  b.last_order_at,
  b.owner
from (
  select
    s.*,
    -- giá sàn: chỉ tính khi có giá vốn cùng tiền tệ
    case
      when s.unit_cost is null then null
      when s.currency_mismatch then null
      when (1 - s.referral_rate_used - s.min_margin_rate) <= 0 then null
      else round(
             (s.unit_cost + coalesce(s.fba_fee, 0) + s.other_fee_per_unit)
             / (1 - s.referral_rate_used - s.min_margin_rate), 2)
    end as floor_price,
    -- lãi gộp tại giá hiện tại
    case
      when s.unit_cost is null or s.our_price is null then null
      when s.currency_mismatch then null
      else round(s.our_price - s.unit_cost
                   - coalesce(s.referral_fee, round(s.our_price * s.referral_rate_used, 2))
                   - coalesce(s.fba_fee, 0)
                   - s.other_fee_per_unit, 2)
    end as gross_profit,
    case
      when s.unit_cost is null or s.our_price is null or s.our_price <= 0 then null
      when s.currency_mismatch then null
      when (1 - s.referral_rate_used - s.min_margin_rate) <= 0 then null
      else round(
             (s.our_price - s.unit_cost
                - coalesce(s.referral_fee, round(s.our_price * s.referral_rate_used, 2))
                - coalesce(s.fba_fee, 0) - s.other_fee_per_unit)
             / s.our_price * 100, 1)
    end as margin_pct,
    case
      when s.unit_cost is null or s.our_price is null then null
      when s.currency_mismatch then null
      when (1 - s.referral_rate_used - s.min_margin_rate) <= 0 then null
      else s.our_price < round(
             (s.unit_cost + coalesce(s.fba_fee, 0) + s.other_fee_per_unit)
             / (1 - s.referral_rate_used - s.min_margin_rate), 2)
    end as below_floor,
    case
      when s.unit_cost is not null and s.currency_mismatch      then 'currency_mismatch'
      when s.unit_cost is not null and s.fees_estimated_at is not null then 'cost+fees'
      when s.unit_cost is not null                              then 'cost_only'
      when s.unit_cost is null and s.fees_estimated_at is not null then 'fees_only'
      else 'unavailable'
    end as cost_basis
  from (
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
      o.buy_box_won,
      o.buy_box_price,
      o.competitor_price,
      o.captured_at             as offer_captured_at,
      f.referral_fee,
      f.fba_fee,
      f.total_fee               as total_fees,
      f.estimated_at            as fees_estimated_at,
      c.unit_cost,
      c.currency                as cost_currency,
      c.effective_from          as cost_effective_from,
      c.source                  as cost_source,
      cfg.min_margin_rate,
      cfg.other_fee_per_unit,
      (c.unit_cost is not null and c.currency <> l.currency) as currency_mismatch,
      -- tỷ lệ referral: suy ra từ phí Amazon thật nếu có, thiếu thì dùng cấu hình
      case
        when f.referral_fee is not null and l.price is not null and l.price > 0
          then round(f.referral_fee / l.price, 4)
        else cfg.referral_fee_rate
      end as referral_rate_used,
      -- ↓ doanh số 30 ngày (0017): NULL = chưa có đơn nào, KHÔNG phải 0
      s30.units_30d,
      s30.orders_30d,
      s30.revenue_30d,
      case when s30.currency_mixed then null else s30.currency end as revenue_currency,
      case
        when s30.units_30d is null then null
        else round(s30.units_30d / 30.0, 2)
      end                       as velocity_30d,
      s30.last_order_at,
      iam.module_owner(l.seller_account_id, 'pricing') as owner
    from catalog.listings l
    join connections.seller_accounts sa on sa.id = l.seller_account_id
    cross join catalog.pricing_defaults cfg
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
    ) f on true
    -- GIÁ VỐN HIỆU LỰC (catalog.effective_cost_row = lõi của catalog.effective_cost)
    left join lateral (
      select r.unit_cost, r.currency, r.effective_from, r.source
      from catalog.effective_cost_row(l.seller_account_id, l.sku, current_date) r
    ) c on true
    -- DOANH SỐ 30 NGÀY theo SKU (join bằng SKU viết hoa — report ghi hoa/thường lẫn lộn)
    left join public.vexim_sku_sales_30d s30
      on s30.seller_account_id = l.seller_account_id
     and s30.sku = upper(btrim(l.sku))
    where cfg.id = 1
  ) s
) b;

-- ============================================================================
-- 6. VIEW vexim_listings (L1/L2) + vexim_listing_queue (L4) — nối THÊM 7 cột
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
  -- Đếm issue: ưu tiên mảng chi tiết; chỉ dùng bộ đếm khi nguồn không kèm chi tiết
  (case
     when jsonb_typeof(l.issues) = 'array' then
       (select count(*) from jsonb_array_elements(l.issues) e where e ->> 'severity' = 'ERROR')
     else coalesce(l.issue_errors, 0)
   end)::bigint             as error_count,
  (case
     when jsonb_typeof(l.issues) = 'array' then
       (select count(*) from jsonb_array_elements(l.issues) e where e ->> 'severity' = 'WARNING')
     else coalesce(l.issue_warnings, 0)
   end)::bigint             as warning_count,
  l.issues,
  o.buy_box_won,
  o.buy_box_price,
  o.competitor_price,
  o.captured_at             as offer_captured_at,
  l.product_type,
  l.buyable,
  l.discoverable,
  l.quantity,
  l.stranded_reason,
  l.enforcement_actions,
  l.last_source,
  l.last_synced_at,
  -- ↓ cột mới (0017) — CUỐI
  s30.units_30d,
  s30.orders_30d,
  s30.revenue_30d,
  case when s30.currency_mixed then null else s30.currency end as revenue_currency,
  case
    when s30.units_30d is null then null
    else round(s30.units_30d / 30.0, 2)
  end                       as velocity_30d,
  s30.last_order_at,
  iam.module_owner(l.seller_account_id, 'listings') as owner
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
left join public.vexim_sku_sales_30d s30
  on s30.seller_account_id = l.seller_account_id
 and s30.sku = upper(btrim(l.sku));

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
  (case
     when jsonb_typeof(l.issues) = 'array' then
       (select count(*) from jsonb_array_elements(l.issues) e where e ->> 'severity' = 'ERROR')
     else coalesce(l.issue_errors, 0)
   end)::bigint             as error_count,
  (case
     when jsonb_typeof(l.issues) = 'array' then
       (select count(*) from jsonb_array_elements(l.issues) e where e ->> 'severity' = 'WARNING')
     else coalesce(l.issue_warnings, 0)
   end)::bigint             as warning_count,
  l.quantity,
  l.stranded_reason,
  l.enforcement_actions,
  l.product_type,
  l.last_source,
  l.last_synced_at,
  -- BUYABLE/DISCOVERABLE: L4 phải nói được "report ghi ACTIVE mà không mua được"
  l.buyable,
  l.discoverable,
  -- ↓ cột mới (0017) — CUỐI: L4 xếp ưu tiên theo tiền đang mất + biết ai xử lý
  s30.units_30d,
  s30.orders_30d,
  s30.revenue_30d,
  case when s30.currency_mixed then null else s30.currency end as revenue_currency,
  case
    when s30.units_30d is null then null
    else round(s30.units_30d / 30.0, 2)
  end                       as velocity_30d,
  s30.last_order_at,
  iam.module_owner(l.seller_account_id, 'listings') as owner
from catalog.listings l
join connections.seller_accounts sa on sa.id = l.seller_account_id
left join public.vexim_sku_sales_30d s30
  on s30.seller_account_id = l.seller_account_id
 and s30.sku = upper(btrim(l.sku))
-- upper() để nhận cả 'active' (seed cũ) lẫn 'ACTIVE' (worker ghi)
where upper(l.status) in ('INACTIVE','STRANDED','SUPPRESSED','REMOVED')
   or (jsonb_typeof(l.issues) = 'array' and jsonb_array_length(l.issues) > 0)
   or coalesce(l.issue_errors, 0) > 0;

-- ============================================================================
-- 7. VIEW vexim_inventory_latest (Module 3) — nối THÊM giá vốn + GIÁ TRỊ TỒN KHO
-- ============================================================================
-- Giá trị tồn = vốn đang nằm ở kho Amazon:
--   stock_value       = fulfillable × unit_cost          (hàng bán được ngay)
--   total_stock_value = (fulfillable + reserved + inbound) × unit_cost
--                       (toàn bộ vốn kẹt ở FC + đang trên đường về — con số F3/I3
--                        cần để quyết "có nên nhập thêm không")
-- Đơn vị tiền = TIỀN TỆ CỦA GIÁ VỐN (`value_currency`), KHÔNG đổi sang tiền bán:
-- VEXIM nhập hàng bằng VND và bán bằng USD, tự quy đổi ở tầng view là đoán tỷ giá.
-- Thiếu giá vốn → `value_basis = 'missing'` + các cột giá trị NULL (không hiện 0).
create or replace view public.vexim_inventory_latest
with (security_invoker = true) as
select
  x.seller_account_id,
  x.shop,
  x.sku,
  x.asin,
  x.fulfillable,
  x.reserved,
  x.inbound,
  x.captured_at,
  x.day,
  x.days_of_cover,
  x.velocity,
  x.suggest_restock,
  x.in_stock,
  -- ↓ cột mới (0017) — CUỐI
  c.unit_cost,
  c.currency                as cost_currency,
  c.effective_from          as cost_effective_from,
  c.source                  as cost_source,
  case
    when c.unit_cost is null then null
    else round(x.fulfillable * c.unit_cost, 2)
  end                       as stock_value,
  case
    when c.unit_cost is null then null
    else round((coalesce(x.fulfillable, 0) + coalesce(x.reserved, 0) + coalesce(x.inbound, 0))
               * c.unit_cost, 2)
  end                       as total_stock_value,
  c.currency                as value_currency,
  case when c.unit_cost is null then 'missing' else 'cost' end as value_basis
from (
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
  order by s.seller_account_id, s.sku, s.captured_at desc
) x
-- Tra giá vốn NGOÀI khối distinct-on: mỗi (shop × SKU) chỉ tra MỘT lần
left join lateral (
  select r.unit_cost, r.currency, r.effective_from, r.source
  from catalog.effective_cost_row(x.seller_account_id, x.sku, current_date) r
) c on true;

comment on view public.vexim_inventory_latest is
  'I1/I3: tồn kho mới nhất theo (shop × SKU) + velocity/cover của worker, '
  'từ 0017 kèm giá vốn hiệu lực và GIÁ TRỊ TỒN (stock_value / total_stock_value).';

-- ============================================================================
-- 8. QUYỀN ĐỌC
-- ============================================================================
grant select on public.vexim_sku_sales_30d to authenticated, service_role;
grant select on public.vexim_pricing,
              public.vexim_listings,
              public.vexim_listing_queue,
              public.vexim_inventory_latest
  to authenticated, service_role;

-- ============================================================================
-- 9. TỰ KIỂM TRA (fail sớm — không để migration "chạy xong mà thiếu")
-- ============================================================================
do $$
declare
  n      int;
  v_view text;
  v_cols text;
begin
  -- 9.1 view doanh số 30 ngày tồn tại + security_invoker
  select count(*) into n
  from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public' and c.relname = 'vexim_sku_sales_30d'
    and 'security_invoker=true' = any (c.reloptions);
  if n <> 1 then
    raise exception '[0017] FAIL: vexim_sku_sales_30d thiếu hoặc không security_invoker';
  end if;

  -- 9.2 ba view listing/pricing phải có ĐỦ 7 cột mới, NỐI Ở CUỐI, ĐÚNG THỨ TỰ
  --     (web select bằng tên: sai thứ tự không sao, nhưng thiếu/sửa chỗ là PGRST204)
  foreach v_view in array array['vexim_pricing','vexim_listings','vexim_listing_queue'] loop
    select string_agg(column_name, ',' order by ordinal_position) into v_cols
    from information_schema.columns
    where table_schema = 'public' and table_name = v_view
      and ordinal_position > (
        select max(ordinal_position) - 7 from information_schema.columns
        where table_schema = 'public' and table_name = v_view);
    if v_cols is distinct from
       'units_30d,orders_30d,revenue_30d,revenue_currency,velocity_30d,last_order_at,owner' then
      raise exception '[0017] FAIL: % nối 7 cột cuối sai: %', v_view, v_cols;
    end if;
  end loop;

  -- 9.3 view tồn kho phải có ĐỦ 8 cột mới ở CUỐI
  select string_agg(column_name, ',' order by ordinal_position) into v_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'vexim_inventory_latest'
    and ordinal_position > (
      select max(ordinal_position) - 8 from information_schema.columns
      where table_schema = 'public' and table_name = 'vexim_inventory_latest');
  if v_cols is distinct from
     'unit_cost,cost_currency,cost_effective_from,cost_source,stock_value,total_stock_value,value_currency,value_basis' then
    raise exception '[0017] FAIL: vexim_inventory_latest nối 8 cột cuối sai: %', v_cols;
  end if;

  -- 9.4 KHÔNG phá cột 0016 (regression: pricing vẫn còn giá vốn + giá sàn)
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'vexim_pricing'
     and column_name in ('unit_cost','cost_currency','cost_effective_from','floor_price',
                         'gross_profit','margin_pct','below_floor','cost_basis',
                         'referral_rate_used','min_margin_rate');
  if n <> 10 then
    raise exception '[0017] FAIL: vexim_pricing mất cột giá vốn/giá sàn của 0016 (có %/10)', n;
  end if;

  -- 9.5 queue vẫn KHÔNG có cột offer (web dùng LISTING_QUEUE_SELECT riêng)
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'vexim_listing_queue'
     and column_name in ('buy_box_won','buy_box_price','competitor_price','offer_captured_at');
  if n <> 0 then
    raise exception '[0017] FAIL: vexim_listing_queue lộ cột offer — sẽ làm sập L4 (PGRST204)';
  end if;

  -- 9.6 iam.module_owner: security definer, authenticated gọi được, anon thì KHÔNG
  select count(*) into n
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'iam' and p.proname = 'module_owner'
    and p.prosecdef
    and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and not has_function_privilege('anon', p.oid, 'EXECUTE');
  if n <> 1 then
    raise exception '[0017] FAIL: iam.module_owner chưa đúng (definer/quyền)';
  end if;

  -- 9.7 KHÔNG phơi PII / email nội bộ trên các view đụng tới
  select count(*) into n from information_schema.columns
   where table_schema = 'public'
     and table_name in ('vexim_sku_sales_30d','vexim_pricing','vexim_listings',
                        'vexim_listing_queue','vexim_inventory_latest')
     and column_name in ('buyer_name','buyer_email','buyer_phone_number','ship_address_1',
                         'recipient_name','actor_email','email','seller_id','owner_id','user_id');
  if n <> 0 then
    raise exception '[0017] FAIL: view phơi cột PII/email/uuid người dùng';
  end if;

  -- 9.8 số liệu view PHẢI khớp truy vấn thẳng bảng gốc (bắt lỗi sai công thức/lệch bộ lọc)
  select count(*) into n
  from (select seller_account_id, sku, units_30d, orders_30d, revenue_30d
          from public.vexim_sku_sales_30d) v
  full join (
    select o.seller_account_id,
           upper(btrim(oi.sku)) as sku,
           sum(coalesce(oi.quantity, 0))::int as units_30d,
           count(distinct o.id)::int as orders_30d,
           round(sum(coalesce(oi.item_price, 0) * coalesce(oi.quantity, 0)), 2) as revenue_30d
    from sales.orders o
    join sales.order_items oi on oi.order_id = o.id
    where o.purchase_date >= now() - interval '30 days'
      and upper(coalesce(o.status, '')) not in ('CANCELLED','CANCELED','UNFULFILLABLE')
      and nullif(btrim(coalesce(oi.sku, '')), '') is not null
    group by 1, 2
  ) t using (seller_account_id, sku)
  where v.units_30d   is distinct from t.units_30d
     or v.orders_30d  is distinct from t.orders_30d
     or v.revenue_30d is distinct from t.revenue_30d;
  if n > 0 then
    raise exception '[0017] FAIL: vexim_sku_sales_30d lệch bảng gốc ở % dòng', n;
  end if;

  -- 9.9 giá trị tồn kho phải đúng công thức + nhãn nguồn khớp việc có/không giá vốn
  select count(*) into n from public.vexim_inventory_latest
   where (value_basis = 'cost') is distinct from (unit_cost is not null)
      or (unit_cost is not null and (
            stock_value is distinct from round(fulfillable * unit_cost, 2)
         or total_stock_value is distinct from
            round((fulfillable + reserved + inbound) * unit_cost, 2)
         or value_currency is distinct from cost_currency))
      or (unit_cost is null and (stock_value is not null or total_stock_value is not null));
  if n > 0 then
    raise exception '[0017] FAIL: giá trị tồn kho sai công thức/nhãn ở % dòng', n;
  end if;

  -- 9.10 P1/L1/L4 phải dùng MỘT nguồn doanh số (không tự tính lại lệch nhau)
  select count(*) into n
  from public.vexim_pricing p
  where p.units_30d is distinct from (
          select s.units_30d from public.vexim_sku_sales_30d s
           where s.seller_account_id = p.seller_account_id
             and s.sku = upper(btrim(p.sku)));
  if n > 0 then
    raise exception '[0017] FAIL: vexim_pricing.units_30d lệch vexim_sku_sales_30d ở % dòng', n;
  end if;

  -- 9.11 index cho hai đường tra mới (aggregate đơn hàng + owner theo shop×module)
  select count(*) into n from pg_indexes
   where indexname in ('idx_order_items_order','idx_assignments_shop_module');
  if n <> 2 then
    raise exception '[0017] FAIL: thiếu index (có %/2)', n;
  end if;

  -- 9.12 sửa 0016: SKU lẫn chữ thường vẫn tra được giá vốn
  select count(*) into n
  from public.vexim_cost_coverage cc
  where cc.missing_cost
    and catalog.effective_cost(cc.seller_account_id, lower(cc.sku), current_date) is not null;
  if n > 0 then
    raise exception '[0017] FAIL: vẫn còn % SKU bị coi là thiếu giá vốn chỉ vì hoa/thường', n;
  end if;

  raise notice '[0017] XONG: doanh số 30 ngày (P1/L1/L4) · người phụ trách theo module · '
               'giá trị tồn kho (Module 3) · tra giá vốn không phân biệt hoa/thường';
end
$$;

commit;
