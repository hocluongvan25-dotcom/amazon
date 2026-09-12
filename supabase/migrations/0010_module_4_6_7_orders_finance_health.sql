-- ============================================================================
-- 0010 — HẠ TẦNG DỮ LIỆU MODULE 4 (ĐƠN HÀNG) · 6 (TÀI CHÍNH) · 7 (ACCOUNT HEALTH)
-- ============================================================================
--
-- BỐI CẢNH:
--   Migration 0001 đã tạo bảng cho sales/finance nhưng ở mức tối thiểu (đủ cho
--   thiết kế ban đầu), và Module 7 (Account Health) chưa có bảng nào — trong khi
--   3 màn hình O1–O4 / F1–F2 / H1–H2 đã chạy mock từ PR #1, PR #2.
--   Migration này bổ sung đúng những cột/bảng mà tầng sync (worker) cần để
--   "cắm là chạy" khi có dữ liệu thật, KHÔNG đổi/không xoá cột cũ.
--
-- ĐỐI CHIẾU API AMAZON (đã kiểm chứng developer-docs.amazon.com):
--   • Report GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL (order-tracking,
--     KHÔNG có thông tin định danh người mua) → amazon-order-id, merchant-order-id,
--     order-status, order-item-id, fulfillment-channel, sku, asin, item-status,
--     quantity, currency, item-price…, ship-state, ship-country, is-business-order.
--   • Report GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE → Amazon RMA ID, Return Reason,
--     Resolution, Refunded Amount…
--   • Report GET_V2_SELLER_PERFORMANCE_REPORT (Account Health) → accountStatuses[],
--     lateShipmentRate/orderDefectRate/validTrackingRate…, warningStates{accountHealthRating,
--     10 nhóm vi phạm}.
--   • Report GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2 (bản _FLAT_FILE/_XML đã deprecated)
--     → settlement-id, deposit-date, total-amount, amount-type/amount-description/amount.
--
-- QUYẾT ĐỊNH PII (v1.1 — không xin role restricted):
--   KHÔNG có cột nào cho tên/địa chỉ/điện thoại/mã bưu chính người mua. Chỉ giữ
--   ship_state + ship_country (mức vùng). Worker bóc PII trước khi ghi (xem
--   worker/src/reports/all-orders.parser.ts + notifications/orders.handler.ts),
--   và cột `pii_stripped` đánh dấu dòng nào đi qua đường đó.
--
-- IDEMPOTENT: mọi câu lệnh đều `if not exists` / `create or replace` / upsert.
-- THỨ TỰ: chạy SAU 0009.
-- ============================================================================

begin;

-- ============================================================================
-- 1. MODULE 4 — ĐƠN HÀNG
-- ============================================================================

-- 1.1 sales.orders — bổ sung cột cho đơn delta + queue FBM
alter table sales.orders add column if not exists merchant_order_id  text;
alter table sales.orders add column if not exists last_updated_date  timestamptz;
alter table sales.orders add column if not exists marketplace_id     text;
alter table sales.orders add column if not exists ship_state         text;
alter table sales.orders add column if not exists ship_country       text;
-- true = dòng được ghi qua đường đã bóc PII (report tracking / notification)
alter table sales.orders add column if not exists pii_stripped       boolean not null default true;

comment on column sales.orders.pii_stripped is
  'Dòng này chưa từng chứa PII người mua (report tracking + notification đã bóc) — quyết định v1.1';

create index if not exists idx_orders_shop_status    on sales.orders (seller_account_id, status);
create index if not exists idx_orders_purchase_date  on sales.orders (seller_account_id, purchase_date desc);
-- Queue FBM (O3): chỉ đơn chưa ship cần đếm ngược
create index if not exists idx_orders_fbm_open
  on sales.orders (seller_account_id, last_updated_date desc)
  where channel = 'MFN' and status in ('Pending', 'Unshipped', 'PartiallyShipped');

-- 1.2 sales.order_items — thêm khoá tự nhiên của Amazon để chống nhân đôi
alter table sales.order_items add column if not exists amazon_order_item_id text;
alter table sales.order_items add column if not exists item_name            text;
alter table sales.order_items add column if not exists item_status          text;

create unique index if not exists uq_order_items_amazon
  on sales.order_items (order_id, amazon_order_item_id)
  where amazon_order_item_id is not null;

-- 1.3 sales.returns_refunds — cột report trả hàng + khoá chống trùng khi import lại
alter table sales.returns_refunds add column if not exists sku           text;
alter table sales.returns_refunds add column if not exists asin          text;
alter table sales.returns_refunds add column if not exists quantity      int;
alter table sales.returns_refunds add column if not exists amazon_rma_id text;
alter table sales.returns_refunds add column if not exists reason_label  text;
alter table sales.returns_refunds add column if not exists reason_group  text;
alter table sales.returns_refunds add column if not exists resolution    text;
alter table sales.returns_refunds add column if not exists dedupe_key    text;

-- Dòng cũ (nếu có) lấy khoá tạm theo id, không đụng dữ liệu hiện hữu
update sales.returns_refunds
   set dedupe_key = coalesce(amazon_rma_id, 'LEGACY:' || id::text)
 where dedupe_key is null;

create unique index if not exists uq_returns_dedupe
  on sales.returns_refunds (seller_account_id, dedupe_key);

create index if not exists idx_returns_shop_date on sales.returns_refunds (seller_account_id, return_date desc);
create index if not exists idx_returns_shop_sku  on sales.returns_refunds (seller_account_id, sku);

-- 1.4 sales.order_daily — rollup KPI đơn hàng/ngày (dashboard đọc bảng này)
create table if not exists sales.order_daily (
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  day               date not null,
  orders_count      int  not null default 0,
  units             int  not null default 0,
  sales_amount      numeric(14,2) not null default 0,
  currency          text not null default 'USD',
  fbm_unshipped     int  not null default 0,
  fbm_overdue       int  not null default 0,
  returns_count     int  not null default 0,
  returns_amount    numeric(14,2) not null default 0,
  primary key (seller_account_id, day)
);

-- ============================================================================
-- 2. MODULE 7 — ACCOUNT HEALTH (schema mới)
-- ============================================================================
create schema if not exists account_health;

-- 2.1 Ảnh chụp sức khỏe shop theo ngày × marketplace
create table if not exists account_health.snapshots (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  day               date not null,
  marketplace_id    text not null,
  account_status    text,          -- NORMAL | AT_RISK | DEACTIVATED
  ahr_status        text,          -- Account Health Rating (Amazon trả chuỗi/số)
  tone              text not null default 'green',  -- green | amber | red (đánh giá của hệ thống)
  score             int,           -- điểm nội bộ 0–100 để xếp hạng ưu tiên (KHÔNG phải AHR)
  rates             jsonb,         -- chỉ số + ngưỡng + tông + nguồn ngưỡng
  issues            jsonb,         -- bản chụp vi phạm tại thời điểm lấy
  source_report_id  text,          -- reportId của Report API (truy vết)
  captured_at       timestamptz not null default now(),
  unique (seller_account_id, day, marketplace_id)
);

create index if not exists idx_ahr_snapshots_latest
  on account_health.snapshots (seller_account_id, day desc);

-- 2.2 Danh sách vi phạm mở (H2) — 1 dòng / nhóm vi phạm (warningStates của Amazon)
create table if not exists account_health.issues (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  marketplace_id    text not null,
  category          text not null,        -- khóa warningStates: receivedIntellectualPropertyComplaints…
  label             text not null,        -- nhãn tiếng Việt
  severity          text not null default 'Medium',  -- Critical | High | Medium | Low
  group_name        text,                 -- ip | restricted | quality | performance | other
  defects_count     int not null default 0,
  status            text,                 -- status thô Amazon trả
  reporting_from    text,
  reporting_to      text,
  case_id           text,                 -- case đã mở trên Seller Central (nhập tay)
  owner_id          uuid references iam.user_profiles(id),
  resolved_at       timestamptz,
  updated_at        timestamptz not null default now(),
  unique (seller_account_id, marketplace_id, category)
);

create index if not exists idx_ahr_issues_open
  on account_health.issues (seller_account_id, severity)
  where resolved_at is null;

-- ============================================================================
-- 3. MODULE 6 — TÀI CHÍNH
-- ============================================================================

-- 3.1 finance.settlements — cột kỳ settlement thật (deposit-date, breakdown, đối soát)
alter table finance.settlements add column if not exists deposit_date    date;
alter table finance.settlements add column if not exists status          text not null default 'open';
alter table finance.settlements add column if not exists breakdown       jsonb;
alter table finance.settlements add column if not exists reconcile_diff  numeric(12,2);
alter table finance.settlements add column if not exists reconciled_at   timestamptz;

comment on column finance.settlements.reconcile_diff is
  'NULL = khớp trong dung sai 1% (SOP-10); khác NULL = lệch USD cần điều tra';
comment on column finance.settlements.status is 'deposited | processing | open';

create index if not exists idx_settlements_deposit on finance.settlements (seller_account_id, deposit_date desc);

-- 3.2 finance.financial_events — cột dòng tiền theo report settlement V2
alter table finance.financial_events add column if not exists sku                text;
alter table finance.financial_events add column if not exists amount_type        text;
alter table finance.financial_events add column if not exists amount_description text;
alter table finance.financial_events add column if not exists order_id           text;
alter table finance.financial_events add column if not exists quantity           int;
alter table finance.financial_events add column if not exists marketplace_name   text;
alter table finance.financial_events add column if not exists dedupe_key         text;

create index if not exists idx_fin_events_settlement on finance.financial_events (settlement_id);
create index if not exists idx_fin_events_date       on finance.financial_events (seller_account_id, event_date desc);
create index if not exists idx_fin_events_sku        on finance.financial_events (seller_account_id, sku);

-- ============================================================================
-- 4. RULE CẢNH BÁO MỚI (worker sinh alert theo rule_code)
-- ============================================================================
insert into ops.alert_rules (rule_code, module, description, threshold, comparator, severity) values
  ('fbm_late_ship',          'orders',    'Đơn FBM sắp hết hạn ship hoặc đã trễ',        4, null, 'red'),
  ('return_reason_spike',    'orders',    'SKU bị trả hàng nhiều trong kỳ (≥3 đơn hoặc ≥5%)', 3, 'gt', 'amber'),
  ('reconciliation_mismatch','finance',   'Đối soát kỳ settlement lệch > dung sai 1%',     1, 'gt',  'red')
on conflict (rule_code) do nothing;

-- ============================================================================
-- 5. RLS + GRANTS
-- ============================================================================
-- 5.1 Bảng mới có seller_account_id → policy SELECT theo iam.can_read_seller_account()
--     (vòng lặp tự động của 0001 chạy trước khi các bảng này tồn tại → phải khai tay)
alter table sales.order_daily            enable row level security;
alter table account_health.snapshots     enable row level security;
alter table account_health.issues        enable row level security;

drop policy if exists rls_read_order_daily on sales.order_daily;
create policy rls_read_order_daily on sales.order_daily
  for select using (iam.can_read_seller_account(seller_account_id));

drop policy if exists rls_read_ahr_snapshots on account_health.snapshots;
create policy rls_read_ahr_snapshots on account_health.snapshots
  for select using (iam.can_read_seller_account(seller_account_id));

drop policy if exists rls_read_ahr_issues on account_health.issues;
create policy rls_read_ahr_issues on account_health.issues
  for select using (iam.can_read_seller_account(seller_account_id));

-- 5.2 Cho phép người dùng cập nhật vòng xử lý vi phạm (case_id / owner / resolved_at)
drop policy if exists rls_write_ahr_issues on account_health.issues;
create policy rls_write_ahr_issues on account_health.issues
  for update using (iam.can_read_seller_account(seller_account_id))
  with check (iam.can_read_seller_account(seller_account_id));

-- 5.3 Grants (PostgREST dùng role authenticated / service_role)
grant usage on schema account_health to authenticated, service_role;
grant select on all tables in schema account_health to authenticated;
grant all    on all tables in schema account_health to service_role;

-- bảng mới trong schema cũ cần grant lại (grant của 0001 chỉ áp cho bảng đã tồn tại)
grant select on all tables in schema sales, finance to authenticated;
grant all    on all tables in schema sales, finance to service_role;

alter default privileges in schema account_health
  grant select on tables to authenticated;

-- ============================================================================
-- 6. VIEW ĐỌC CHO WEB (schema public — không phụ thuộc "Exposed schemas")
-- ============================================================================
-- LÝ DO (bài học 0008 + sự cố PGRST205): browser client của Supabase chỉ gọi được
-- schema nằm trong "Exposed schemas". Để màn H1/H2/O1 không phụ thuộc cấu hình đó,
-- tạo view trong public; `security_invoker = true` để RLS của bảng gốc vẫn được
-- áp theo người đăng nhập (KHÔNG rò dữ liệu giữa các tenant).
-- ============================================================================

create or replace view public.vexim_shop_health
with (security_invoker = true) as
select
  s.seller_account_id,
  sa.display_name                as shop,
  s.marketplace_id,
  s.day,
  s.account_status,
  s.ahr_status,
  s.tone,
  s.score,
  s.rates,
  s.issues,
  s.source_report_id,
  s.captured_at
from account_health.snapshots s
join connections.seller_accounts sa on sa.id = s.seller_account_id
where s.day = (
  select max(s2.day) from account_health.snapshots s2
  where s2.seller_account_id = s.seller_account_id
    and s2.marketplace_id = s.marketplace_id
);

create or replace view public.vexim_health_issues
with (security_invoker = true) as
select
  i.id,
  i.seller_account_id,
  sa.display_name as shop,
  i.marketplace_id,
  i.category,
  i.label,
  i.severity,
  i.group_name,
  i.defects_count,
  i.status,
  i.reporting_from,
  i.reporting_to,
  i.case_id,
  i.owner_id,
  i.resolved_at,
  i.updated_at
from account_health.issues i
join connections.seller_accounts sa on sa.id = i.seller_account_id
where i.resolved_at is null;

create or replace view public.vexim_order_daily
with (security_invoker = true) as
select
  d.seller_account_id,
  sa.display_name as shop,
  d.day,
  d.orders_count,
  d.units,
  d.sales_amount,
  d.currency,
  d.fbm_unshipped,
  d.fbm_overdue,
  d.returns_count,
  d.returns_amount
from sales.order_daily d
join connections.seller_accounts sa on sa.id = d.seller_account_id;

-- O3 — queue FBM: hạn ship + số giờ còn lại tính ngay trong DB (nguồn: getOrders/notification)
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
  round(extract(epoch from (o.last_updated_date - now())) / 3600.0, 1) as hours_since_update
from sales.orders o
join connections.seller_accounts sa on sa.id = o.seller_account_id
where o.channel = 'MFN'
  and o.status in ('Pending', 'Unshipped', 'PartiallyShipped');

grant select on public.vexim_shop_health, public.vexim_health_issues,
                public.vexim_order_daily, public.vexim_fbm_queue
  to authenticated, service_role;

-- ============================================================================
-- 7. KIỂM CHỨNG (chạy ngay trong migration — fail sớm, không để lỗi im lặng)
-- ============================================================================
do $$
declare
  n_tables int;
  n_rules  int;
  n_views  int;
begin
  select count(*) into n_tables
  from information_schema.tables
  where (table_schema = 'account_health' and table_name in ('snapshots', 'issues'))
     or (table_schema = 'sales' and table_name = 'order_daily');

  if n_tables <> 3 then
    raise exception '[0010] FAIL: chỉ thấy % / 3 bảng mới', n_tables;
  end if;

  select count(*) into n_rules
  from ops.alert_rules
  where rule_code in ('fbm_late_ship', 'return_reason_spike', 'reconciliation_mismatch');

  if n_rules <> 3 then
    raise exception '[0010] FAIL: thiếu rule cảnh báo mới (%/3)', n_rules;
  end if;

  select count(*) into n_views
  from information_schema.views
  where table_schema = 'public'
    and table_name in ('vexim_shop_health', 'vexim_health_issues', 'vexim_order_daily', 'vexim_fbm_queue');

  if n_views <> 4 then
    raise exception '[0010] FAIL: thiếu view cho web (%/4)', n_views;
  end if;

  -- Cột PII không được lọt vào schema (chốt cứng quyết định v1.1)
  if exists (
    select 1 from information_schema.columns
    where table_schema in ('sales', 'account_health', 'finance')
      and column_name in ('buyer_name', 'buyer_email', 'buyer_phone_number',
                          'ship_address_1', 'recipient_name', 'ship_postal_code', 'ship_city')
  ) then
    raise exception '[0010] FAIL: phát hiện cột PII trong schema nghiệp vụ — vi phạm quyết định v1.1';
  end if;

  raise notice '[0010] XONG: 3 bảng + 3 rule + 4 view, không có cột PII';
end
$$;

commit;
