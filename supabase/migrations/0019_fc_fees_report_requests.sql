-- ============================================================================
-- 0019 — PHÍ THEO FC: phí lưu kho + phí inbound không tuân thủ + trạng thái report
-- ============================================================================
-- BỐI CẢNH
--   0018 đã trả lời "hàng nằm ở FC nào, nhận bao nhiêu". Hai câu hỏi TIỀN còn lại:
--     (1) Hàng nằm ở FC đó TỐN BAO NHIÊU phí lưu kho? (để quyết định rút hàng,
--        thanh lý, hay nhập thêm vào FC nào)
--     (2) Lô nhập bị Amazon tính phí gì vì sai quy cách, và họ nói expected vs
--         received bao nhiêu?
--   Nguồn (đều là report, API không có):
--
--   ┌ (1) FBA Storage Fees Report
--   │   reportType: GET_FBA_STORAGE_FEE_CHARGES_DATA  (request HOẶC schedule được)
--   │   Cột: asin · fnsku · product_name · fulfillment_center · country_code ·
--   │        longest_side · median_side · shortest_side · measurement_units ·
--   │        weight · weight_units · item_volume · volume_units ·
--   │        product_size_tier · average_quantity_on_hand ·
--   │        average_quantity_pending_removal · estimated_total_item_volume ·
--   │        month_of_charge · storage_rate · currency ·
--   │        estimated_monthly_storage_fee · dangerous_goods_storage_type ·
--   │        eligible_for_inventory_discount · qualifies_for_inventory_discount ·
--   │        total_incentive_fee_amount · breakdown_incentive_fee_amount ·
--   │        average_quantity_customer_orders
--   │   ⚠ Report này KHÔNG có cột seller SKU → phải suy SKU qua FNSKU/ASIN
--   │     (xem view 6A: có nhãn `sku_source`, không âm thầm đoán).
--   │
--   └ (2) FBA Inbound Performance Report
--       reportType: GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA
--       Cột: issue-reported-date · shipment-creation-date · fba-shipment-id ·
--            fba-carton-id · fulfillment-center-id · sku · fnsku · asin ·
--            product-name · problem-type · problem-quantity · expected-quantity ·
--            received-quantity · performance-measurement-unit · coaching-level ·
--            fee-type · currency · fee-total · problem-level · alert-status
--
--   ┌ (3) connections.report_requests — TRẠNG THÁI yêu cầu report
--       Report FBA dạng daily có trần **1 lần / 4 giờ** và report chạy bất đồng bộ
--       (IN_QUEUE → IN_PROGRESS → DONE). Vercel Cron chạy mỗi ngày nên PHẢI nhớ
--       "đã yêu cầu reportId nào, đang chờ hay đã nhập xong" — nếu không mỗi lần
--       cron chạy sẽ xin report mới (vượt trần, và mất dấu vết khi lỗi).
--
--   NGUỒN CỘT: developer-docs.amazon.com/sp-api/docs/report-type-values-fba
--   (mục "FBA Inventory Reports" / "FBA Inbound Performance Report").
--
-- NGUYÊN TẮC (giữ nguyên từ 0014..0018)
--   • Khoá NOT NULL DEFAULT '' (NULL không khử trùng trong index unique).
--   • Ghi = RPC service_role; web KHÔNG ghi được (chỉ policy SELECT).
--   • KHÔNG CỘNG TIỀN KHÁC TIỆM TỆ: RPC trả danh sách tiền tệ, view nhóm theo
--     (shop × tháng × FC × currency) và tính % trong cùng một currency.
--   • Số không đọc được → NULL ("chưa biết"), không đoán 0.
--   • Idempotent: create … if not exists · create or replace · drop policy if exists.
--   • Chạy SAU 0018.
-- ============================================================================

begin;

-- ============================================================================
-- 1. finance.storage_fees — phí lưu kho hằng tháng theo ASIN × FC
-- ============================================================================
create table if not exists finance.storage_fees (
  id                              uuid primary key default gen_random_uuid(),
  seller_account_id               uuid not null references connections.seller_accounts(id) on delete cascade,
  /** YYYY-MM — parser chuẩn hoá từ month_of_charge của report */
  month_of_charge                 text not null,
  asin                            text not null default '',
  fnsku                           text not null default '',
  product_name                    text,
  fulfillment_center              text not null default '',
  country_code                    text,
  product_size_tier               text,
  average_quantity_on_hand        numeric,
  average_quantity_pending_removal numeric,
  average_quantity_customer_orders numeric,
  estimated_total_item_volume     numeric,
  volume_units                    text,
  item_volume                     numeric,
  longest_side                    numeric,
  median_side                     numeric,
  shortest_side                   numeric,
  measurement_units               text,
  weight                          numeric,
  weight_units                    text,
  storage_rate                    numeric,
  currency                        text,
  estimated_monthly_storage_fee   numeric,
  dangerous_goods_storage_type    text not null default '',
  eligible_for_inventory_discount boolean,
  qualifies_for_inventory_discount boolean,
  total_incentive_fee_amount      numeric,
  breakdown_incentive_fee_amount  numeric,
  source                          text not null default 'report',
  imported_at                     timestamptz not null default now(),
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now()
);

comment on table finance.storage_fees is
  'Phí lưu kho FBA hằng tháng, nhập từ report GET_FBA_STORAGE_FEE_CHARGES_DATA. '
  'Khoá: shop × tháng × ASIN × FNSKU × FC × loại hàng nguy hiểm. '
  'Report KHÔNG có seller SKU → SKU được suy qua FNSKU/ASIN ở tầng view (có nhãn nguồn).';

comment on column finance.storage_fees.month_of_charge is
  'YYYY-MM (parser chuẩn hoá; report có thể ghi "September 2026"). Không đúng dạng → dòng bị bỏ.';

create unique index if not exists uq_storage_fees_key
  on finance.storage_fees
     (seller_account_id, month_of_charge, asin, fnsku, fulfillment_center, dangerous_goods_storage_type);
create index if not exists idx_storage_fees_month
  on finance.storage_fees (seller_account_id, month_of_charge desc, fulfillment_center);
create index if not exists idx_storage_fees_fnsku
  on finance.storage_fees (seller_account_id, fnsku, month_of_charge desc);

-- ============================================================================
-- 2. inventory.inbound_noncompliance — vấn đề lô nhập + phí kèm theo
-- ============================================================================
create table if not exists inventory.inbound_noncompliance (
  id                        uuid primary key default gen_random_uuid(),
  seller_account_id         uuid not null references connections.seller_accounts(id) on delete cascade,
  issue_reported_date       date not null,
  shipment_creation_date    date,
  fba_shipment_id           text not null default '',
  fba_carton_id             text not null default '',
  fulfillment_center_id     text not null default '',
  sku                       text not null default '',
  fnsku                     text,
  asin                      text,
  product_name              text,
  problem_type              text not null default '',
  problem_quantity          int,
  expected_quantity         int,
  received_quantity         int,
  performance_measurement_unit text,
  coaching_level            text,
  fee_type                  text,
  currency                  text,
  fee_total                 numeric,
  problem_level             text,
  alert_status              text,
  source                    text not null default 'report',
  imported_at               timestamptz not null default now(),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

comment on table inventory.inbound_noncompliance is
  'Vấn đề khi nhập kho FBA + phí Amazon tính, từ report '
  'GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA. Khoá: shop × ngày báo × lô × carton × SKU × loại vấn đề.';

comment on column inventory.inbound_noncompliance.expected_quantity is
  'Số Amazon nói là KẾ HOẠCH của dòng có vấn đề (không phải của cả lô) — '
  'vì vậy KHÔNG được cộng dồn theo lô để đối soát; đối soát cả lô dùng 0018.';

create unique index if not exists uq_inbound_noncompliance_key
  on inventory.inbound_noncompliance
     (seller_account_id, issue_reported_date, fba_shipment_id, fba_carton_id, sku, problem_type);
create index if not exists idx_inbound_noncompliance_shipment
  on inventory.inbound_noncompliance (seller_account_id, fba_shipment_id);
create index if not exists idx_inbound_noncompliance_date
  on inventory.inbound_noncompliance (seller_account_id, issue_reported_date desc);

-- ============================================================================
-- 3. connections.report_requests — trạng thái yêu cầu report (cho cron)
-- ============================================================================
create table if not exists connections.report_requests (
  id                 uuid primary key default gen_random_uuid(),
  seller_account_id  uuid not null references connections.seller_accounts(id) on delete cascade,
  report_type        text not null,
  marketplace_id     text,
  data_start         date,
  data_end           date,
  /** reportId Amazon trả về từ createReport — dùng để getReport/getReportDocument */
  report_id          text,
  report_document_id text,
  /**
   * requested → in_queue/in_progress (Amazon đang tạo) → done (có document)
   * → imported (đã parse + ghi) · no_data (report rỗng) · failed/fatal/cancelled
   */
  status             text not null default 'requested',
  rows_imported      int,
  attempts           int  not null default 0,
  last_error         text,
  requested_at       timestamptz,
  completed_at       timestamptz,
  imported_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table connections.report_requests is
  'Nhật ký yêu cầu report qua Reports API. Khoá (shop × loại report × khoảng ngày) '
  'để cron chạy lại KHÔNG xin report mới (report FBA daily có trần 1 lần/4 giờ) '
  'và để lần chạy sau tiếp tục POLL đúng reportId đang chờ.';

create unique index if not exists uq_report_requests_key
  on connections.report_requests
     (seller_account_id, report_type, coalesce(data_start, date '1900-01-01'), coalesce(data_end, date '1900-01-01'));
create index if not exists idx_report_requests_status
  on connections.report_requests (seller_account_id, status, requested_at desc);

-- ============================================================================
-- 4. RLS — đọc theo shop, không có đường ghi cho web
-- ============================================================================
alter table finance.storage_fees               enable row level security;
alter table inventory.inbound_noncompliance    enable row level security;
alter table connections.report_requests        enable row level security;

drop policy if exists "storage_fees: đọc theo shop" on finance.storage_fees;
create policy "storage_fees: đọc theo shop" on finance.storage_fees
  for select to authenticated
  using (iam.can_read_seller_account(seller_account_id));

drop policy if exists "inbound_noncompliance: đọc theo shop" on inventory.inbound_noncompliance;
create policy "inbound_noncompliance: đọc theo shop" on inventory.inbound_noncompliance
  for select to authenticated
  using (iam.can_read_seller_account(seller_account_id));

drop policy if exists "report_requests: đọc theo shop" on connections.report_requests;
create policy "report_requests: đọc theo shop" on connections.report_requests
  for select to authenticated
  using (iam.can_read_seller_account(seller_account_id));

grant select on finance.storage_fees, inventory.inbound_noncompliance, connections.report_requests
  to authenticated;
grant all on finance.storage_fees, inventory.inbound_noncompliance, connections.report_requests
  to service_role;

-- ============================================================================
-- 5. Helper: đọc số từ report mà KHÔNG làm nổ cả lô khi gặp giá trị lạ
-- ============================================================================
-- Report là file do Amazon sinh: có thể gặp "1,234.56", "N/A", "", "n/a". Ép kiểu
-- thẳng (::numeric) sẽ NÉM lỗi và mất cả lô nhập. Không đọc được → NULL
-- ("chưa biết"), đúng quy ước toàn repo.
create or replace function finance.num_or_null(p_text text)
returns numeric
language sql
immutable
as $$
  select case
    when btrim(coalesce(p_text, '')) ~ '^-?[0-9]+(\.[0-9]+)?$'
      then btrim(p_text)::numeric
    when btrim(coalesce(p_text, '')) ~ '^-?[0-9]{1,3}(,[0-9]{3})+(\.[0-9]+)?$'
      then replace(btrim(p_text), ',', '')::numeric
  end;
$$;

comment on function finance.num_or_null(text) is
  'Ép chuỗi trong report về numeric; không đọc được → NULL (không ném lỗi).';

/** true/false trong report có thể là TRUE/True/yes/1 — không ép ::boolean thẳng */
create or replace function finance.bool_or_null(p_text text)
returns boolean
language sql
immutable
as $$
  select case lower(btrim(coalesce(p_text, '')))
    when 'true'  then true  when 't' then true  when 'yes' then true
    when 'y'     then true  when '1'  then true
    when 'false' then false when 'f' then false when 'no'  then false
    when 'n'     then false when '0'  then false
  end;
$$;

comment on function finance.bool_or_null(text) is
  'Ép chuỗi true/false trong report về boolean; không đọc được → NULL.';

-- ============================================================================
-- 6. RPC worker — nhập report phí lưu kho
-- ============================================================================
-- KHÔNG trả về tổng tiền: report có thể chứa nhiều tiền tệ (shop bán US + CA),
-- cộng gộp là ra con số vô nghĩa. Trả `currencies` để log nói rõ.
create or replace function public.vexim_worker_upsert_storage_fees(
  p_seller uuid,
  p_rows   jsonb
)
returns table (inserted int, updated int, skipped int, merged int, months int, currencies text)
language plpgsql
security definer
set search_path = finance, public, pg_catalog
as $$
declare
  v_clean jsonb;
  v_total int := 0;
  v_valid int := 0;
  v_raw   int := 0;
  v_upd   int := 0;
  v_rows  int := 0;
  v_months int := 0;
  v_curr  text;
begin
  if auth.uid() is not null then
    raise exception '[M3-FEE] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_seller is null then
    raise exception '[M3-FEE] thiếu seller_account_id' using errcode = 'invalid_parameter_value';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '[M3-FEE] p_rows phải là JSON array (nhận %)',
      coalesce(jsonb_typeof(p_rows), 'NULL') using errcode = 'invalid_parameter_value';
  end if;

  v_total := jsonb_array_length(p_rows);

  select coalesce(jsonb_agg(jsonb_build_object(
           'month',          g.month_of_charge,
           'asin',           g.asin,
           'fnsku',          g.fnsku,
           'fc',             g.fc,
           'dg',             g.dg,
           'productName',    g.product_name,
           'countryCode',    g.country_code,
           'sizeTier',       g.product_size_tier,
           'avgOnHand',      g.avg_on_hand,
           'avgPendingRemoval', g.avg_pending_removal,
           'avgCustomerOrders', g.avg_customer_orders,
           'totalVolume',    g.total_volume,
           'volumeUnits',    g.volume_units,
           'itemVolume',     g.item_volume,
           'longestSide',    g.longest_side,
           'medianSide',     g.median_side,
           'shortestSide',   g.shortest_side,
           'measurementUnits', g.measurement_units,
           'weight',         g.weight,
           'weightUnits',    g.weight_units,
           'storageRate',    g.storage_rate,
           'currency',       g.currency,
           'monthlyFee',     g.monthly_fee,
           'eligibleDiscount', g.eligible_discount,
           'qualifiesDiscount', g.qualifies_discount,
           'incentiveTotal', g.incentive_total,
           'incentiveBreakdown', g.incentive_breakdown,
           'source',         g.src,
           'rows',           g.raw_rows
         )), '[]'::jsonb)
    into v_clean
  from (
    select
      n.month_of_charge, n.asin, n.fnsku, n.fc, n.dg,
      count(*)                          as raw_rows,
      max(n.product_name)               as product_name,
      max(n.country_code)               as country_code,
      max(n.product_size_tier)          as product_size_tier,
      -- số đo: trùng khoá thì lấy dòng có số (không cộng — đây là số đo, không phải tiền)
      max(n.avg_on_hand)                as avg_on_hand,
      max(n.avg_pending_removal)        as avg_pending_removal,
      max(n.avg_customer_orders)        as avg_customer_orders,
      max(n.total_volume)               as total_volume,
      max(n.volume_units)               as volume_units,
      max(n.item_volume)                as item_volume,
      max(n.longest_side)               as longest_side,
      max(n.median_side)                as median_side,
      max(n.shortest_side)              as shortest_side,
      max(n.measurement_units)          as measurement_units,
      max(n.weight)                     as weight,
      max(n.weight_units)               as weight_units,
      max(n.storage_rate)               as storage_rate,
      max(n.currency)                   as currency,
      max(n.monthly_fee)                as monthly_fee,
      bool_or(n.eligible_discount)      as eligible_discount,
      bool_or(n.qualifies_discount)     as qualifies_discount,
      max(n.incentive_total)            as incentive_total,
      max(n.incentive_breakdown)        as incentive_breakdown,
      max(n.src)                        as src
    from (
      select
        case when btrim(coalesce(r ->> 'monthOfCharge', '')) ~ '^[0-9]{4}-[0-9]{2}$'
             then btrim(r ->> 'monthOfCharge') end                    as month_of_charge,
        upper(btrim(coalesce(r ->> 'asin', '')))                      as asin,
        upper(btrim(coalesce(r ->> 'fnsku', '')))                     as fnsku,
        upper(btrim(coalesce(r ->> 'fulfillmentCenter', '')))         as fc,
        upper(btrim(coalesce(r ->> 'dangerousGoodsStorageType', ''))) as dg,
        nullif(btrim(coalesce(r ->> 'productName', '')), '')          as product_name,
        upper(btrim(coalesce(r ->> 'countryCode', '')))               as country_code,
        nullif(btrim(coalesce(r ->> 'productSizeTier', '')), '')      as product_size_tier,
        num_or_null(r ->> 'averageQuantityOnHand')        as avg_on_hand,
        num_or_null(r ->> 'averageQuantityPendingRemoval') as avg_pending_removal,
        num_or_null(r ->> 'averageQuantityCustomerOrders') as avg_customer_orders,
        num_or_null(r ->> 'estimatedTotalItemVolume')     as total_volume,
        nullif(btrim(coalesce(r ->> 'volumeUnits', '')), '')          as volume_units,
        num_or_null(r ->> 'itemVolume')  as item_volume,
        num_or_null(r ->> 'longestSide') as longest_side,
        num_or_null(r ->> 'medianSide')  as median_side,
        num_or_null(r ->> 'shortestSide') as shortest_side,
        nullif(btrim(coalesce(r ->> 'measurementUnits', '')), '')     as measurement_units,
        num_or_null(r ->> 'weight')      as weight,
        nullif(btrim(coalesce(r ->> 'weightUnits', '')), '')          as weight_units,
        num_or_null(r ->> 'storageRate') as storage_rate,
        nullif(upper(btrim(coalesce(r ->> 'currency', ''))), '')      as currency,
        num_or_null(r ->> 'estimatedMonthlyStorageFee')   as monthly_fee,
        bool_or_null(r ->> 'eligibleForInventoryDiscount') as eligible_discount,
        bool_or_null(r ->> 'qualifiesForInventoryDiscount') as qualifies_discount,
        num_or_null(r ->> 'totalIncentiveFeeAmount')      as incentive_total,
        num_or_null(r ->> 'breakdownIncentiveFeeAmount')  as incentive_breakdown,
        coalesce(nullif(btrim(coalesce(r ->> 'source', '')), ''), 'report')            as src
      from jsonb_array_elements(p_rows) r
    ) n
    -- Khoá tối thiểu: tháng + (FNSKU hoặc ASIN). Không có cả hai → không biết
    -- phí này của sản phẩm nào → bỏ, đếm skipped.
    where n.month_of_charge is not null
      and (n.fnsku <> '' or n.asin <> '')
    group by 1, 2, 3, 4, 5
  ) g;

  v_valid := jsonb_array_length(v_clean);

  select count(distinct e ->> 'month')::int,
         coalesce(string_agg(distinct nullif(e ->> 'currency', ''), ','
                             order by nullif(e ->> 'currency', '')), '')::text,
         coalesce(sum((e ->> 'rows')::int), 0)::int
    into v_months, v_curr, v_raw
  from jsonb_array_elements(v_clean) e;

  select count(*) into v_upd
  from jsonb_array_elements(v_clean) e
  where exists (
    select 1 from finance.storage_fees x
     where x.seller_account_id            = p_seller
       and x.month_of_charge              = e ->> 'month'
       and x.asin                         = coalesce(e ->> 'asin', '')
       and x.fnsku                        = coalesce(e ->> 'fnsku', '')
       and x.fulfillment_center           = coalesce(e ->> 'fc', '')
       and x.dangerous_goods_storage_type = coalesce(e ->> 'dg', '')
  );

  insert into finance.storage_fees as t (
    seller_account_id, month_of_charge, asin, fnsku, product_name, fulfillment_center,
    country_code, product_size_tier, average_quantity_on_hand,
    average_quantity_pending_removal, average_quantity_customer_orders,
    estimated_total_item_volume, volume_units, item_volume,
    longest_side, median_side, shortest_side, measurement_units, weight, weight_units,
    storage_rate, currency, estimated_monthly_storage_fee, dangerous_goods_storage_type,
    eligible_for_inventory_discount, qualifies_for_inventory_discount,
    total_incentive_fee_amount, breakdown_incentive_fee_amount,
    source, imported_at, updated_at
  )
  select
    p_seller,
    e ->> 'month',
    coalesce(e ->> 'asin', ''),
    coalesce(e ->> 'fnsku', ''),
    nullif(e ->> 'productName', ''),
    coalesce(e ->> 'fc', ''),
    nullif(e ->> 'countryCode', ''),
    nullif(e ->> 'sizeTier', ''),
    nullif(e ->> 'avgOnHand', '')::numeric,
    nullif(e ->> 'avgPendingRemoval', '')::numeric,
    nullif(e ->> 'avgCustomerOrders', '')::numeric,
    nullif(e ->> 'totalVolume', '')::numeric,
    nullif(e ->> 'volumeUnits', ''),
    nullif(e ->> 'itemVolume', '')::numeric,
    nullif(e ->> 'longestSide', '')::numeric,
    nullif(e ->> 'medianSide', '')::numeric,
    nullif(e ->> 'shortestSide', '')::numeric,
    nullif(e ->> 'measurementUnits', ''),
    nullif(e ->> 'weight', '')::numeric,
    nullif(e ->> 'weightUnits', ''),
    nullif(e ->> 'storageRate', '')::numeric,
    nullif(e ->> 'currency', ''),
    nullif(e ->> 'monthlyFee', '')::numeric,
    coalesce(e ->> 'dg', ''),
    nullif(e ->> 'eligibleDiscount', '')::boolean,
    nullif(e ->> 'qualifiesDiscount', '')::boolean,
    nullif(e ->> 'incentiveTotal', '')::numeric,
    nullif(e ->> 'incentiveBreakdown', '')::numeric,
    coalesce(nullif(e ->> 'source', ''), 'report'),
    now(),
    now()
  from jsonb_array_elements(v_clean) e
  on conflict (seller_account_id, month_of_charge, asin, fnsku, fulfillment_center, dangerous_goods_storage_type)
  do update set
    product_name                     = coalesce(excluded.product_name, t.product_name),
    country_code                     = coalesce(excluded.country_code, t.country_code),
    product_size_tier                = coalesce(excluded.product_size_tier, t.product_size_tier),
    average_quantity_on_hand         = coalesce(excluded.average_quantity_on_hand, t.average_quantity_on_hand),
    average_quantity_pending_removal = coalesce(excluded.average_quantity_pending_removal, t.average_quantity_pending_removal),
    average_quantity_customer_orders = coalesce(excluded.average_quantity_customer_orders, t.average_quantity_customer_orders),
    estimated_total_item_volume      = coalesce(excluded.estimated_total_item_volume, t.estimated_total_item_volume),
    volume_units                     = coalesce(excluded.volume_units, t.volume_units),
    item_volume                      = coalesce(excluded.item_volume, t.item_volume),
    storage_rate                     = coalesce(excluded.storage_rate, t.storage_rate),
    currency                         = coalesce(excluded.currency, t.currency),
    estimated_monthly_storage_fee    = coalesce(excluded.estimated_monthly_storage_fee, t.estimated_monthly_storage_fee),
    eligible_for_inventory_discount  = coalesce(excluded.eligible_for_inventory_discount, t.eligible_for_inventory_discount),
    qualifies_for_inventory_discount = coalesce(excluded.qualifies_for_inventory_discount, t.qualifies_for_inventory_discount),
    total_incentive_fee_amount       = coalesce(excluded.total_incentive_fee_amount, t.total_incentive_fee_amount),
    breakdown_incentive_fee_amount   = coalesce(excluded.breakdown_incentive_fee_amount, t.breakdown_incentive_fee_amount),
    source                           = excluded.source,
    imported_at                      = excluded.imported_at,
    updated_at                       = excluded.updated_at;

  get diagnostics v_rows = row_count;

  return query
    select greatest(v_rows - v_upd, 0), v_upd, greatest(v_total - v_raw, 0),
           greatest(v_raw - v_valid, 0), v_months, v_curr;
end;
$$;

comment on function public.vexim_worker_upsert_storage_fees(uuid, jsonb) is
  'Nhập report GET_FBA_STORAGE_FEE_CHARGES_DATA — chỉ service_role. Idempotent theo '
  '(shop, tháng, ASIN, FNSKU, FC, loại hàng nguy hiểm). Không cộng tiền khác tiền tệ.';

-- ============================================================================
-- 7. RPC worker — nhập report inbound noncompliance
-- ============================================================================
create or replace function public.vexim_worker_upsert_noncompliance(
  p_seller uuid,
  p_rows   jsonb
)
returns table (inserted int, updated int, skipped int, merged int, shipments int, currencies text)
language plpgsql
security definer
set search_path = inventory, public, pg_catalog
as $$
declare
  v_clean jsonb;
  v_total int := 0;
  v_valid int := 0;
  v_raw   int := 0;
  v_upd   int := 0;
  v_rows  int := 0;
  v_ships int := 0;
  v_curr  text;
begin
  if auth.uid() is not null then
    raise exception '[M3-INB] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_seller is null then
    raise exception '[M3-INB] thiếu seller_account_id' using errcode = 'invalid_parameter_value';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '[M3-INB] p_rows phải là JSON array (nhận %)',
      coalesce(jsonb_typeof(p_rows), 'NULL') using errcode = 'invalid_parameter_value';
  end if;

  v_total := jsonb_array_length(p_rows);

  select coalesce(jsonb_agg(jsonb_build_object(
           'reportedDate',   g.issue_reported_date,
           'creationDate',   g.shipment_creation_date,
           'shipmentId',     g.fba_shipment_id,
           'cartonId',       g.fba_carton_id,
           'sku',            g.sku,
           'problemType',    g.problem_type,
           'fc',             g.fc,
           'fnsku',          g.fnsku,
           'asin',           g.asin,
           'productName',    g.product_name,
           'problemQty',     g.problem_quantity,
           'expectedQty',    g.expected_quantity,
           'receivedQty',    g.received_quantity,
           'unit',           g.performance_measurement_unit,
           'coachingLevel',  g.coaching_level,
           'feeType',        g.fee_type,
           'currency',       g.currency,
           'feeTotal',       g.fee_total,
           'problemLevel',   g.problem_level,
           'alertStatus',    g.alert_status,
           'source',         g.src,
           'rows',           g.raw_rows
         )), '[]'::jsonb)
    into v_clean
  from (
    select
      n.issue_reported_date, n.fba_shipment_id, n.fba_carton_id, n.sku, n.problem_type,
      count(*)                        as raw_rows,
      max(n.shipment_creation_date)   as shipment_creation_date,
      max(n.fc)                       as fc,
      max(n.fnsku)                    as fnsku,
      max(n.asin)                     as asin,
      max(n.product_name)             as product_name,
      -- số lượng của cùng một vấn đề: lấy dòng có số (không cộng — cùng một sự việc)
      max(n.problem_quantity)         as problem_quantity,
      max(n.expected_quantity)        as expected_quantity,
      max(n.received_quantity)        as received_quantity,
      max(n.performance_measurement_unit) as performance_measurement_unit,
      max(n.coaching_level)           as coaching_level,
      max(n.fee_type)                 as fee_type,
      max(n.currency)                 as currency,
      max(n.fee_total)                as fee_total,
      max(n.problem_level)            as problem_level,
      max(n.alert_status)             as alert_status,
      max(n.src)                      as src
    from (
      select
        case when btrim(coalesce(r ->> 'issueReportedDate', '')) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
             then btrim(r ->> 'issueReportedDate')::date end          as issue_reported_date,
        case when btrim(coalesce(r ->> 'shipmentCreationDate', '')) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
             then btrim(r ->> 'shipmentCreationDate')::date end       as shipment_creation_date,
        upper(btrim(coalesce(r ->> 'fbaShipmentId', '')))             as fba_shipment_id,
        upper(btrim(coalesce(r ->> 'fbaCartonId', '')))               as fba_carton_id,
        btrim(coalesce(r ->> 'sku', ''))                              as sku,
        upper(btrim(coalesce(r ->> 'problemType', '')))               as problem_type,
        upper(btrim(coalesce(r ->> 'fulfillmentCenterId', '')))       as fc,
        nullif(upper(btrim(coalesce(r ->> 'fnsku', ''))), '')         as fnsku,
        nullif(upper(btrim(coalesce(r ->> 'asin', ''))), '')          as asin,
        nullif(btrim(coalesce(r ->> 'productName', '')), '')          as product_name,
        case when btrim(coalesce(r ->> 'problemQuantity', '')) ~ '^-?[0-9]+$'
             then btrim(r ->> 'problemQuantity')::int end             as problem_quantity,
        case when btrim(coalesce(r ->> 'expectedQuantity', '')) ~ '^-?[0-9]+$'
             then btrim(r ->> 'expectedQuantity')::int end            as expected_quantity,
        case when btrim(coalesce(r ->> 'receivedQuantity', '')) ~ '^-?[0-9]+$'
             then btrim(r ->> 'receivedQuantity')::int end            as received_quantity,
        nullif(btrim(coalesce(r ->> 'performanceMeasurementUnit', '')), '') as performance_measurement_unit,
        nullif(upper(btrim(coalesce(r ->> 'coachingLevel', ''))), '') as coaching_level,
        nullif(upper(btrim(coalesce(r ->> 'feeType', ''))), '')       as fee_type,
        nullif(upper(btrim(coalesce(r ->> 'currency', ''))), '')      as currency,
        case when btrim(coalesce(r ->> 'feeTotal', '')) ~ '^-?[0-9]+(\.[0-9]+)?$'
             then btrim(r ->> 'feeTotal')::numeric end                as fee_total,
        nullif(upper(btrim(coalesce(r ->> 'problemLevel', ''))), '')  as problem_level,
        nullif(upper(btrim(coalesce(r ->> 'alertStatus', ''))), '')   as alert_status,
        coalesce(nullif(btrim(coalesce(r ->> 'source', '')), ''), 'report') as src
      from jsonb_array_elements(p_rows) r
    ) n
    where n.issue_reported_date is not null
    group by 1, 2, 3, 4, 5
  ) g;

  v_valid := jsonb_array_length(v_clean);

  select count(distinct e ->> 'shipmentId') filter (where coalesce(e ->> 'shipmentId', '') <> '')::int,
         coalesce(string_agg(distinct nullif(e ->> 'currency', ''), ','
                             order by nullif(e ->> 'currency', '')), '')::text,
         coalesce(sum((e ->> 'rows')::int), 0)::int
    into v_ships, v_curr, v_raw
  from jsonb_array_elements(v_clean) e;

  select count(*) into v_upd
  from jsonb_array_elements(v_clean) e
  where exists (
    select 1 from inventory.inbound_noncompliance x
     where x.seller_account_id   = p_seller
       and x.issue_reported_date = (e ->> 'reportedDate')::date
       and x.fba_shipment_id     = coalesce(e ->> 'shipmentId', '')
       and x.fba_carton_id       = coalesce(e ->> 'cartonId', '')
       and x.sku                 = coalesce(e ->> 'sku', '')
       and x.problem_type        = coalesce(e ->> 'problemType', '')
  );

  insert into inventory.inbound_noncompliance as t (
    seller_account_id, issue_reported_date, shipment_creation_date, fba_shipment_id,
    fba_carton_id, fulfillment_center_id, sku, fnsku, asin, product_name, problem_type,
    problem_quantity, expected_quantity, received_quantity, performance_measurement_unit,
    coaching_level, fee_type, currency, fee_total, problem_level, alert_status,
    source, imported_at, updated_at
  )
  select
    p_seller,
    (e ->> 'reportedDate')::date,
    nullif(e ->> 'creationDate', '')::date,
    coalesce(e ->> 'shipmentId', ''),
    coalesce(e ->> 'cartonId', ''),
    coalesce(e ->> 'fc', ''),
    coalesce(e ->> 'sku', ''),
    nullif(e ->> 'fnsku', ''),
    nullif(e ->> 'asin', ''),
    nullif(e ->> 'productName', ''),
    coalesce(e ->> 'problemType', ''),
    nullif(e ->> 'problemQty', '')::int,
    nullif(e ->> 'expectedQty', '')::int,
    nullif(e ->> 'receivedQty', '')::int,
    nullif(e ->> 'unit', ''),
    nullif(e ->> 'coachingLevel', ''),
    nullif(e ->> 'feeType', ''),
    nullif(e ->> 'currency', ''),
    nullif(e ->> 'feeTotal', '')::numeric,
    nullif(e ->> 'problemLevel', ''),
    nullif(e ->> 'alertStatus', ''),
    coalesce(nullif(e ->> 'source', ''), 'report'),
    now(),
    now()
  from jsonb_array_elements(v_clean) e
  on conflict (seller_account_id, issue_reported_date, fba_shipment_id, fba_carton_id, sku, problem_type)
  do update set
    shipment_creation_date       = coalesce(excluded.shipment_creation_date, t.shipment_creation_date),
    fulfillment_center_id        = coalesce(excluded.fulfillment_center_id, t.fulfillment_center_id),
    fnsku                        = coalesce(excluded.fnsku, t.fnsku),
    asin                         = coalesce(excluded.asin, t.asin),
    product_name                 = coalesce(excluded.product_name, t.product_name),
    problem_quantity             = coalesce(excluded.problem_quantity, t.problem_quantity),
    expected_quantity            = coalesce(excluded.expected_quantity, t.expected_quantity),
    received_quantity            = coalesce(excluded.received_quantity, t.received_quantity),
    performance_measurement_unit = coalesce(excluded.performance_measurement_unit, t.performance_measurement_unit),
    coaching_level               = coalesce(excluded.coaching_level, t.coaching_level),
    fee_type                     = coalesce(excluded.fee_type, t.fee_type),
    currency                     = coalesce(excluded.currency, t.currency),
    fee_total                    = coalesce(excluded.fee_total, t.fee_total),
    problem_level                = coalesce(excluded.problem_level, t.problem_level),
    alert_status                 = coalesce(excluded.alert_status, t.alert_status),
    source                       = excluded.source,
    imported_at                  = excluded.imported_at,
    updated_at                   = excluded.updated_at;

  get diagnostics v_rows = row_count;

  return query
    select greatest(v_rows - v_upd, 0), v_upd, greatest(v_total - v_raw, 0),
           greatest(v_raw - v_valid, 0), v_ships, v_curr;
end;
$$;

comment on function public.vexim_worker_upsert_noncompliance(uuid, jsonb) is
  'Nhập report GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA — chỉ service_role. '
  'Idempotent theo (shop, ngày báo, lô, carton, SKU, loại vấn đề).';

-- ============================================================================
-- 8. RPC worker — ghi trạng thái yêu cầu report (cho cron nối tiếp được)
-- ============================================================================
create or replace function public.vexim_worker_set_report_request(
  p_seller uuid,
  p_req    jsonb
)
returns table (id uuid, status text, report_id text)
language plpgsql
security definer
set search_path = connections, public, pg_catalog
as $$
declare
  v_type   text;
  v_start  date;
  v_end    date;
  v_status text;
  v_rid    text;
  v_id     uuid;
begin
  if auth.uid() is not null then
    raise exception '[REPORT] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_seller is null or p_req is null then
    raise exception '[REPORT] thiếu seller_account_id hoặc payload'
      using errcode = 'invalid_parameter_value';
  end if;

  v_type := btrim(coalesce(p_req ->> 'reportType', ''));
  if v_type = '' then
    raise exception '[REPORT] thiếu reportType' using errcode = 'invalid_parameter_value';
  end if;

  v_start := case when btrim(coalesce(p_req ->> 'dataStart', '')) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                  then btrim(p_req ->> 'dataStart')::date end;
  v_end   := case when btrim(coalesce(p_req ->> 'dataEnd', '')) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                  then btrim(p_req ->> 'dataEnd')::date end;

  -- Trạng thái LẠ → 'failed' kèm lỗi gốc, không ghi chuỗi tự do (view lọc theo status)
  v_status := lower(btrim(coalesce(p_req ->> 'status', '')));
  if v_status not in ('requested','in_queue','in_progress','done','imported','no_data','failed','fatal','cancelled') then
    v_status := 'failed';
  end if;

  v_rid := nullif(btrim(coalesce(p_req ->> 'reportId', '')), '');

  insert into connections.report_requests as t (
    seller_account_id, report_type, marketplace_id, data_start, data_end,
    report_id, report_document_id, status, rows_imported, attempts, last_error,
    requested_at, completed_at, imported_at, updated_at
  )
  values (
    p_seller,
    v_type,
    nullif(upper(btrim(coalesce(p_req ->> 'marketplaceId', ''))), ''),
    v_start,
    v_end,
    v_rid,
    nullif(btrim(coalesce(p_req ->> 'reportDocumentId', '')), ''),
    v_status,
    nullif(btrim(coalesce(p_req ->> 'rowsImported', '')), '')::int,
    coalesce(nullif(btrim(coalesce(p_req ->> 'attempts', '')), '')::int, 1),
    nullif(btrim(coalesce(p_req ->> 'lastError', '')), ''),
    coalesce(nullif(btrim(coalesce(p_req ->> 'requestedAt', '')), '')::timestamptz, now()),
    nullif(btrim(coalesce(p_req ->> 'completedAt', '')), '')::timestamptz,
    nullif(btrim(coalesce(p_req ->> 'importedAt', '')), '')::timestamptz,
    now()
  )
  on conflict (seller_account_id, report_type, coalesce(data_start, date '1900-01-01'), coalesce(data_end, date '1900-01-01'))
  do update set
    marketplace_id     = coalesce(excluded.marketplace_id, t.marketplace_id),
    report_id          = coalesce(excluded.report_id, t.report_id),
    report_document_id = coalesce(excluded.report_document_id, t.report_document_id),
    status             = excluded.status,
    rows_imported      = coalesce(excluded.rows_imported, t.rows_imported),
    attempts           = t.attempts + 1,
    last_error         = excluded.last_error,
    requested_at       = coalesce(t.requested_at, excluded.requested_at),
    completed_at       = coalesce(excluded.completed_at, t.completed_at),
    imported_at        = coalesce(excluded.imported_at, t.imported_at),
    updated_at         = excluded.updated_at
  returning t.id, t.status, t.report_id into v_id, v_status, v_rid;

  return query select v_id, v_status, v_rid;
end;
$$;

comment on function public.vexim_worker_set_report_request(uuid, jsonb) is
  'Ghi/cập nhật trạng thái một lần yêu cầu report (Reports API). Khoá '
  '(shop, loại report, khoảng ngày) → cron chạy lại không xin report mới, '
  'mỗi lần chạm tăng attempts. Chỉ service_role.';

revoke all on function public.vexim_worker_upsert_storage_fees(uuid, jsonb)   from public, anon, authenticated;
grant  execute on function public.vexim_worker_upsert_storage_fees(uuid, jsonb) to service_role;
revoke all on function public.vexim_worker_upsert_noncompliance(uuid, jsonb)   from public, anon, authenticated;
grant  execute on function public.vexim_worker_upsert_noncompliance(uuid, jsonb) to service_role;
revoke all on function public.vexim_worker_set_report_request(uuid, jsonb)     from public, anon, authenticated;
grant  execute on function public.vexim_worker_set_report_request(uuid, jsonb)  to service_role;

-- ============================================================================
-- 9. VIEW 9A — vexim_storage_fees: phí lưu kho kèm SKU suy ra (có nhãn nguồn)
-- ============================================================================
-- Report phí lưu kho KHÔNG có seller SKU. Suy SKU theo 2 bậc, và NÓI RÕ lấy từ đâu:
--   1) FNSKU → SKU từ inventory.fc_allocation (report 0018, mới nhất)
--   2) ASIN  → SKU từ catalog.listings (0016, last_synced_at mới nhất)
-- Không khớp được → sku NULL + sku_source = 'none' (UI hiện "— chưa ánh xạ được").
create or replace view public.vexim_storage_fees
with (security_invoker = true) as
with fnsku_map as (
  select distinct on (seller_account_id, fnsku)
         seller_account_id, fnsku, sku
  from inventory.fc_allocation
  where fnsku is not null and fnsku <> ''
  order by seller_account_id, fnsku, snapshot_date desc
),
asin_map as (
  select distinct on (seller_account_id, asin)
         seller_account_id, asin, sku
  from catalog.listings
  where asin is not null and asin <> ''
  order by seller_account_id, asin, last_synced_at desc nulls last
)
select
  f.seller_account_id,
  sa.display_name as shop,
  f.month_of_charge,
  nullif(f.fnsku, '') as fnsku,
  nullif(f.asin, '')  as asin,
  coalesce(fm.sku, am.sku) as sku,
  case when fm.sku is not null then 'fnsku'
       when am.sku is not null then 'asin'
       else 'none' end as sku_source,
  f.product_name,
  nullif(f.fulfillment_center, '') as fc,
  f.country_code,
  f.product_size_tier,
  f.average_quantity_on_hand,
  f.average_quantity_pending_removal,
  f.average_quantity_customer_orders,
  f.estimated_total_item_volume,
  f.volume_units,
  f.storage_rate,
  f.currency,
  f.estimated_monthly_storage_fee,
  f.dangerous_goods_storage_type,
  f.eligible_for_inventory_discount,
  f.qualifies_for_inventory_discount,
  f.total_incentive_fee_amount,
  f.source,
  f.imported_at
from finance.storage_fees f
join connections.seller_accounts sa on sa.id = f.seller_account_id
left join fnsku_map fm
       on fm.seller_account_id = f.seller_account_id and fm.fnsku = f.fnsku
left join asin_map am
       on am.seller_account_id = f.seller_account_id and am.asin = f.asin;

comment on view public.vexim_storage_fees is
  'Phí lưu kho theo ASIN/FNSKU × FC × tháng. sku + sku_source: SKU được SUY RA '
  '(report không có cột SKU) — ''none'' nghĩa là chưa ánh xạ được, không đoán.';

-- ============================================================================
-- 10. VIEW 9B — vexim_storage_fee_by_fc: PHÂN BỔ PHÍ THEO FC (shop × tháng × FC × tiền)
-- ============================================================================
-- Nhóm theo currency để KHÔNG cộng tiền khác tiền tệ; % tính trong cùng currency.
create or replace view public.vexim_storage_fee_by_fc
with (security_invoker = true) as
with agg as (
  select
    f.seller_account_id,
    f.month_of_charge,
    f.fulfillment_center,
    f.currency,
    -- KHÔNG coalesce(...,0): nếu phí/thể tích của cả nhóm không đọc được thì
    -- tổng là NULL ("chưa biết"), không phải 0 ("không tốn phí").
    sum(f.estimated_monthly_storage_fee)               as storage_fee,
    sum(f.estimated_total_item_volume)                 as total_volume,
    sum(f.average_quantity_on_hand)                    as avg_units_on_hand,
    count(*)                                           as product_lines,
    count(distinct nullif(f.fnsku, '') )               as fnsku_count,
    max(f.volume_units)                                as volume_units,
    max(f.imported_at)                                 as imported_at
  from finance.storage_fees f
  group by 1, 2, 3, 4
)
select
  a.seller_account_id,
  sa.display_name as shop,
  a.month_of_charge,
  nullif(a.fulfillment_center, '') as fc,
  a.currency,
  a.storage_fee,
  a.total_volume,
  a.avg_units_on_hand,
  a.product_lines,
  a.fnsku_count,
  a.volume_units,
  sum(a.storage_fee) over (partition by a.seller_account_id, a.month_of_charge, a.currency) as month_fee_total,
  count(*)           over (partition by a.seller_account_id, a.month_of_charge, a.currency) as month_fc_count,
  case when sum(a.storage_fee) over (partition by a.seller_account_id, a.month_of_charge, a.currency) > 0
       then round(a.storage_fee * 100
                  / sum(a.storage_fee) over (partition by a.seller_account_id, a.month_of_charge, a.currency), 1)
  end as fee_share_pct,
  a.imported_at
from agg a
join connections.seller_accounts sa on sa.id = a.seller_account_id;

comment on view public.vexim_storage_fee_by_fc is
  'PHÂN BỔ PHÍ LƯU KHO THEO FC (shop × tháng × FC × tiền tệ). fee_share_pct NULL '
  'khi tổng phí của tháng = 0 hoặc không đọc được. storage_fee NULL khi cả FC '
  'không đọc được phí (không bịa 0). Không bao giờ cộng hai tiền tệ trong một dòng.';

-- ============================================================================
-- 11. VIEW 9C — vexim_inbound_issues: từng vấn đề nhập kho (I4 drill-down)
-- ============================================================================
create or replace view public.vexim_inbound_issues
with (security_invoker = true) as
select
  n.seller_account_id,
  sa.display_name as shop,
  n.issue_reported_date,
  (current_date - n.issue_reported_date) as days_ago,
  n.shipment_creation_date,
  nullif(n.fba_shipment_id, '')       as shipment_id,
  nullif(n.fba_carton_id, '')         as carton_id,
  nullif(n.fulfillment_center_id, '') as fc,
  nullif(n.sku, '')                   as sku,
  n.fnsku,
  n.asin,
  n.product_name,
  nullif(n.problem_type, '') as problem_type,
  n.problem_quantity,
  n.expected_quantity,
  n.received_quantity,
  n.performance_measurement_unit,
  n.coaching_level,
  n.fee_type,
  n.currency,
  n.fee_total,
  n.problem_level,
  n.alert_status,
  n.source,
  n.imported_at
from inventory.inbound_noncompliance n
join connections.seller_accounts sa on sa.id = n.seller_account_id;

comment on view public.vexim_inbound_issues is
  'Vấn đề khi Amazon nhận lô (report Inbound Performance) + phí kèm theo. '
  'expected/received là của DÒNG có vấn đề, không phải của cả lô.';

-- ============================================================================
-- 12. VIEW 9D — vexim_inbound_issue_shipments: gộp theo lô (I4)
-- ============================================================================
-- KHÔNG cộng expected/received/problem_quantity theo lô: mỗi dòng là một sự việc
-- riêng, cộng lại sẽ thành con số không ai giải thích được. Chỉ cộng TIỀN (cùng
-- currency) và đếm số vấn đề.
create or replace view public.vexim_inbound_issue_shipments
with (security_invoker = true) as
with agg as (
  select
    n.seller_account_id,
    n.fba_shipment_id,
    n.currency,
    count(*)                                        as issue_count,
    sum(coalesce(n.fee_total, 0))                   as fee_total,
    sum(coalesce(n.problem_quantity, 0))            as problem_units,
    min(n.issue_reported_date)                      as first_issue_date,
    max(n.issue_reported_date)                      as last_issue_date,
    max(nullif(n.fulfillment_center_id, ''))        as fc,
    max(nullif(n.shipment_creation_date, date '1900-01-01')) as shipment_creation_date,
    string_agg(distinct nullif(n.problem_type, ''), ', ')    as problem_types,
    string_agg(distinct nullif(n.coaching_level, ''), ', ')  as coaching_levels,
    string_agg(distinct nullif(n.alert_status, ''), ', ')    as alert_statuses,
    count(distinct nullif(n.sku, ''))               as sku_count,
    max(n.imported_at)                              as imported_at
  from inventory.inbound_noncompliance n
  where n.fba_shipment_id <> ''
  group by 1, 2, 3
)
select
  a.seller_account_id,
  sa.display_name as shop,
  a.fba_shipment_id as shipment_id,
  a.fc,
  case when a.shipment_creation_date = date '1900-01-01' then null
       else a.shipment_creation_date end as shipment_creation_date,
  a.currency,
  a.issue_count,
  a.fee_total,
  a.problem_units,
  a.sku_count,
  a.first_issue_date,
  a.last_issue_date,
  a.problem_types,
  a.coaching_levels,
  a.alert_statuses,
  b.status as shipment_status,
  a.imported_at
from agg a
join connections.seller_accounts sa on sa.id = a.seller_account_id
left join inventory.inbound_shipments b
       on b.seller_account_id = a.seller_account_id
      and b.shipment_id       = a.fba_shipment_id;

comment on view public.vexim_inbound_issue_shipments is
  'Gộp vấn đề nhập kho theo lô (và theo tiền tệ). fee_total chỉ cộng trong cùng '
  'currency; problem_units là tổng số đơn vị có vấn đề (không phải số thiếu cả lô).';

-- ============================================================================
-- 13. VIEW 9E — vexim_report_requests: cron report đang ở đâu (Module 0)
-- ============================================================================
create or replace view public.vexim_report_requests
with (security_invoker = true) as
select
  r.id,
  r.seller_account_id,
  sa.display_name as shop,
  r.report_type,
  r.marketplace_id,
  r.data_start,
  r.data_end,
  r.report_id,
  r.report_document_id,
  r.status,
  r.rows_imported,
  r.attempts,
  r.last_error,
  r.requested_at,
  r.completed_at,
  r.imported_at,
  case when r.requested_at is null then null
       else round(extract(epoch from (now() - r.requested_at)) / 60)::int end as age_minutes,
  -- "đang chờ" quá 6 giờ = bất thường (report daily thường xong trong vài phút)
  (r.status in ('requested','in_queue','in_progress')
   and r.requested_at is not null
   and r.requested_at < now() - interval '6 hours') as is_stale
from connections.report_requests r
join connections.seller_accounts sa on sa.id = r.seller_account_id;

comment on view public.vexim_report_requests is
  'Trạng thái các lần yêu cầu report qua Reports API — để màn Sync health (Module 0) '
  'thấy cron đang chờ / đã nhập / lỗi, kèm cờ is_stale khi chờ quá 6 giờ.';

-- ============================================================================
-- 14. GRANTS
-- ============================================================================
grant select on
  public.vexim_storage_fees,
  public.vexim_storage_fee_by_fc,
  public.vexim_inbound_issues,
  public.vexim_inbound_issue_shipments,
  public.vexim_report_requests
to authenticated, service_role;

-- ============================================================================
-- 15. TỰ KIỂM TRA
-- ============================================================================
do $$
declare
  n      int;
  v_fn   text;
  v_view text;
  v_cols text;
begin
  -- 15.1 ba bảng mới có RLS
  select count(*) into n
  from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
  where (ns.nspname, c.relname) in (('finance','storage_fees'),
                                    ('inventory','inbound_noncompliance'),
                                    ('connections','report_requests'))
    and c.relrowsecurity;
  if n <> 3 then
    raise exception '[0019] FAIL: thiếu bảng hoặc chưa bật RLS (có %/3)', n;
  end if;

  -- 15.2 index unique khử trùng
  select count(*) into n from pg_indexes
  where indexname in ('uq_storage_fees_key','uq_inbound_noncompliance_key','uq_report_requests_key')
    and indexdef like '%UNIQUE%';
  if n <> 3 then
    raise exception '[0019] FAIL: thiếu index unique (có %/3)', n;
  end if;

  -- 15.3 không có policy ghi cho web
  select count(*) into n from pg_policies
  where (schemaname, tablename) in (('finance','storage_fees'),
                                    ('inventory','inbound_noncompliance'),
                                    ('connections','report_requests'))
    and cmd <> 'SELECT';
  if n <> 0 then
    raise exception '[0019] FAIL: có % policy ghi — web phải KHÔNG ghi được', n;
  end if;

  -- 15.4 ba RPC: security definer + chỉ service_role
  foreach v_fn in array array['vexim_worker_upsert_storage_fees',
                              'vexim_worker_upsert_noncompliance',
                              'vexim_worker_set_report_request'] loop
    select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = v_fn and p.prosecdef
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and has_function_privilege('service_role', p.oid, 'EXECUTE');
    if n <> 1 then
      raise exception '[0019] FAIL: RPC % thiếu / không security definer / sai quyền', v_fn;
    end if;
  end loop;

  -- 15.5 năm view security_invoker
  select count(*) into n
  from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public'
    and c.relname in ('vexim_storage_fees','vexim_storage_fee_by_fc','vexim_inbound_issues',
                      'vexim_inbound_issue_shipments','vexim_report_requests')
    and 'security_invoker=true' = any (c.reloptions);
  if n <> 5 then
    raise exception '[0019] FAIL: thiếu view hoặc không security_invoker (có %/5)', n;
  end if;

  -- 15.6 hợp đồng cột (web select bằng tên → sai 1 cột là PGRST204)
  select string_agg(column_name, ',' order by ordinal_position) into v_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'vexim_storage_fee_by_fc';
  if v_cols is distinct from
     'seller_account_id,shop,month_of_charge,fc,currency,storage_fee,total_volume,'
     || 'avg_units_on_hand,product_lines,fnsku_count,volume_units,month_fee_total,'
     || 'month_fc_count,fee_share_pct,imported_at' then
    raise exception '[0019] FAIL: vexim_storage_fee_by_fc sai hợp đồng cột: %', v_cols;
  end if;

  select string_agg(column_name, ',' order by ordinal_position) into v_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'vexim_inbound_issue_shipments';
  if v_cols is distinct from
     'seller_account_id,shop,shipment_id,fc,shipment_creation_date,currency,issue_count,'
     || 'fee_total,problem_units,sku_count,first_issue_date,last_issue_date,problem_types,'
     || 'coaching_levels,alert_statuses,shipment_status,imported_at' then
    raise exception '[0019] FAIL: vexim_inbound_issue_shipments sai hợp đồng cột: %', v_cols;
  end if;

  -- 15.7 helper đọc số an toàn (report lạ không làm nổ lô nhập)
  if finance.num_or_null('1,234.56') <> 1234.56 or finance.num_or_null('N/A') is not null
     or finance.num_or_null('') is not null or finance.bool_or_null('TRUE') is not true
     or finance.bool_or_null('n/a') is not null then
    raise exception '[0019] FAIL: helper num_or_null/bool_or_null sai hành vi';
  end if;

  -- 15.8 regression 0018 vẫn nguyên
  foreach v_view in array array['vexim_inventory_fc','vexim_inventory_receipts',
                                'vexim_inbound_receipt_shipments'] loop
    select count(*) into n
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relname = v_view
      and 'security_invoker=true' = any (c.reloptions);
    if n <> 1 then
      raise exception '[0019] FAIL: mất view % của 0018', v_view;
    end if;
  end loop;

  raise notice '[0019] OK: phí lưu kho + phí inbound + trạng thái report đã sẵn sàng';
end;
$$;

commit;
