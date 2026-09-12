-- ============================================================================
-- 0018 — MODULE 3 NÂNG CAO: phân bổ tồn theo FC + lịch sử nhận hàng (receipts)
-- ============================================================================
-- BỐI CẢNH
--   I2 (chi tiết SKU) có hai khối đang treo nhãn "chưa có dữ liệu":
--     (1) "Phân bổ theo trung tâm fulfilment" — hàng của SKU đang nằm ở FC nào,
--         mỗi FC bao nhiêu đơn vị, chiếm bao nhiêu %.
--     (2) "Lịch sử nhận hàng" — Amazon thực nhận bao nhiêu, ngày nào, lô nào.
--   Cả hai số này KHÔNG có trong API đang dùng:
--     • getFulfillmentInboundShipment / listInventorySummaries chỉ trả TỔNG theo
--       SKU (fulfillable/reserved/inbound), không tách theo FC.
--     • Không có endpoint "lịch sử đã nhận" — Inbound API chỉ cho trạng thái lô
--       ĐANG mở (WORKING/SHIPPED/RECEIVING), lô CLOSED thì mất số liệu chi tiết.
--   Nguồn đúng của hai khối này là REPORT (Seller Central → Reports → Fulfillment):
--
--   ┌ (1) FBA Daily Inventory History Report
--   │   reportType: GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA
--   │   Cột: snapshot-date · fnsku · sku · product-name · quantity ·
--   │        fulfillment-center-id · detailed-disposition · country
--   │   (mỗi ngày một snapshot; cùng SKU có thể nằm ở nhiều FC, mỗi FC nhiều
--   │    dòng theo disposition: Sellable / Unsellable / Damaged …)
--   │
--   └ (2) FBA Received Inventory Report
--       reportType: GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA
--       Cột: received-date · fnsku · sku · product-name · quantity ·
--            fba-shipment-id · fulfillment-center-id
--       (các lần nhận ĐÃ HOÀN TẤT tại FC; nội dung cập nhật mỗi ngày)
--
--   NGUỒN CỘT: developer-docs.amazon.com/sp-api/docs/report-type-values-fba
--   (mục "FBA Inventory Reports"). Hai report này KHÔNG chứa PII người mua →
--   không cần Restricted Data Token, chỉ cần role "Amazon Fulfillment".
--
-- QUYẾT ĐỊNH THIẾT KẾ
--   • Report là SNAPSHOT/LỊCH SỬ, không phải "trạng thái hiện tại duy nhất":
--     giữ ĐÚNG khoá tự nhiên của report (ngày × SKU × FC × disposition) để còn
--     đối chiếu được "hôm qua 120, hôm nay 95" và để import lại KHÔNG nhân đôi.
--     View chỉ phơi snapshot MỚI NHẤT của mỗi shop (UI không phải tự lọc).
--   • "Số gửi" (expected) KHÔNG có trong report receipts. Nó nằm ở
--     inventory.inbound_shipments.quantity (worker inventory:sync ghi từ Inbound
--     API). Vì vậy view đối soát LEFT JOIN: có lô trong I4 thì tính được
--     thiếu/thừa; KHÔNG có thì để NULL + nhãn nguồn 'none' — không bao giờ suy
--     ra "gửi = nhận" (suy như vậy là tự che mất hàng thiếu, đúng chỗ đau nhất
--     của FBA).
--   • Khoá NOT NULL DEFAULT '' cho FC/disposition/shipment: NULL trong unique
--     index KHÔNG khử trùng (hai dòng cùng SKU, disposition NULL sẽ thành 2 dòng)
--     → import lại phình bảng. View đổi '' thành NULL khi hiển thị.
--   • Ghi = RPC service_role (như 0014/0015/0016). Web KHÔNG ghi được:
--     bảng chỉ có policy SELECT, không có policy INSERT/UPDATE/DELETE.
--   • Idempotent: create table if not exists · create index if not exists ·
--     create or replace view/function · drop policy if exists · grant.
--   • Chạy SAU 0017.
-- ============================================================================

begin;

-- ============================================================================
-- 1. inventory.fc_allocation — tồn theo FC từ report snapshot ngày
-- ============================================================================
create table if not exists inventory.fc_allocation (
  id                    uuid primary key default gen_random_uuid(),
  seller_account_id     uuid not null references connections.seller_accounts(id) on delete cascade,
  snapshot_date         date not null,
  sku                   text not null,
  fnsku                 text,
  product_name          text,
  quantity              int  not null default 0,
  fulfillment_center_id text not null default '',
  detailed_disposition  text not null default '',
  country               text,
  source                text not null default 'report',
  imported_at           timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table inventory.fc_allocation is
  'M3 nâng cao: phân bổ tồn theo trung tâm fulfilment, nhập từ report '
  'GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA (mỗi ngày một snapshot). '
  'Khoá: shop × ngày × SKU × FC × disposition.';

comment on column inventory.fc_allocation.detailed_disposition is
  'Giá trị gốc của report (SELLABLE / UNSELLABLE / DAMAGED / …), đã upper(). '
  'Rỗng = report không cho biết → view đếm vào unknown_qty, KHÔNG gộp vào sellable.';

comment on column inventory.fc_allocation.snapshot_date is
  'Ngày Amazon chụp snapshot (cột snapshot-date). KHÔNG phải ngày nhập file.';

-- Khoá tự nhiên của report. FC/disposition là NOT NULL DEFAULT '' → index unique
-- khử trùng được (NULL thì không).
create unique index if not exists uq_fc_allocation_key
  on inventory.fc_allocation
     (seller_account_id, snapshot_date, sku, fulfillment_center_id, detailed_disposition);

-- Đọc theo SKU (I2 mở 1 SKU → các FC của SKU đó) và theo ngày (tìm snapshot mới nhất)
create index if not exists idx_fc_allocation_sku
  on inventory.fc_allocation (seller_account_id, sku, snapshot_date desc);
create index if not exists idx_fc_allocation_snapshot
  on inventory.fc_allocation (seller_account_id, snapshot_date desc);

-- ============================================================================
-- 2. inventory.receipts — lịch sử Amazon thực nhận hàng
-- ============================================================================
create table if not exists inventory.receipts (
  id                    uuid primary key default gen_random_uuid(),
  seller_account_id     uuid not null references connections.seller_accounts(id) on delete cascade,
  received_date         date not null,
  sku                   text not null,
  fnsku                 text,
  product_name          text,
  quantity              int  not null default 0,
  fba_shipment_id       text not null default '',
  fulfillment_center_id text not null default '',
  source                text not null default 'report',
  imported_at           timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table inventory.receipts is
  'M3 nâng cao: lịch sử nhận hàng (inbound receipts), nhập từ report '
  'GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA. Khoá: shop × ngày nhận × SKU × lô × FC.';

comment on column inventory.receipts.fba_shipment_id is
  'Mã lô FBA (FBA15…). Rỗng = report không gắn lô (vd nhận từ kênh khác) '
  '→ không đối soát được với inbound_shipments, view để expected = NULL.';

create unique index if not exists uq_receipts_key
  on inventory.receipts
     (seller_account_id, received_date, sku, fba_shipment_id, fulfillment_center_id);

create index if not exists idx_receipts_sku
  on inventory.receipts (seller_account_id, sku, received_date desc);
create index if not exists idx_receipts_shipment
  on inventory.receipts (seller_account_id, fba_shipment_id);

-- ============================================================================
-- 3. RLS — đọc theo shop; KHÔNG có đường ghi nào cho web
-- ============================================================================
alter table inventory.fc_allocation enable row level security;
alter table inventory.receipts      enable row level security;

drop policy if exists "fc_allocation: đọc theo shop" on inventory.fc_allocation;
create policy "fc_allocation: đọc theo shop" on inventory.fc_allocation
  for select to authenticated
  using (iam.can_read_seller_account(seller_account_id));

drop policy if exists "receipts: đọc theo shop" on inventory.receipts;
create policy "receipts: đọc theo shop" on inventory.receipts
  for select to authenticated
  using (iam.can_read_seller_account(seller_account_id));

-- CHỦ Ý: không tạo policy insert/update/delete. Web chỉ đọc qua view
-- (security_invoker → RLS bảng gốc vẫn áp). Worker dùng service_role
-- (BYPASSRLS) và đi qua RPC ở mục 4 — giống catalog.listings của 0016.
grant select on inventory.fc_allocation, inventory.receipts to authenticated;
grant all    on inventory.fc_allocation, inventory.receipts to service_role;

-- ============================================================================
-- 4. RPC worker — nhập report phân bổ FC
-- ============================================================================
-- Vì sao set-based (không loop từng dòng): report này là SKU × FC × disposition,
-- catalog vài nghìn SKU dễ ra vài chục nghìn dòng; 1 câu INSERT…SELECT nhanh hơn
-- hàng chục nghìn round-trip trong plpgsql.
--
-- Luật trung thực:
--   • Dòng thiếu khoá (sku rỗng / snapshot_date không phải YYYY-MM-DD / quantity
--     không phải số nguyên) → KHÔNG ghi, đếm vào `skipped` để log nói rõ.
--   • Hai dòng trùng khoá trong cùng file → CỘNG quantity (report có thể tách
--     nhiều dòng), đồng thời tránh lỗi "cannot affect row a second time".
--     Số dòng bị gộp trả về ở `merged` — KHÔNG tính vào `skipped` (gộp khác bỏ).
--   • Nhập lại cùng file → updated, không phình bảng (khoá unique ở mục 1).
create or replace function public.vexim_worker_upsert_fc_allocation(
  p_seller uuid,
  p_rows   jsonb
)
returns table (inserted int, updated int, skipped int, merged int, units int, snapshots int)
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
  v_units int := 0;
  v_snaps int := 0;
begin
  if auth.uid() is not null then
    raise exception '[M3-FC] RPC này chỉ dành cho worker (service_role) — web không ghi tồn FC trực tiếp'
      using errcode = 'insufficient_privilege';
  end if;
  if p_seller is null then
    raise exception '[M3-FC] thiếu seller_account_id' using errcode = 'invalid_parameter_value';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '[M3-FC] p_rows phải là JSON array (nhận %)',
      coalesce(jsonb_typeof(p_rows), 'NULL')
      using errcode = 'invalid_parameter_value';
  end if;

  v_total := jsonb_array_length(p_rows);

  -- Chuẩn hoá + khử trùng khoá MỘT lần; các bước sau chỉ đọc v_clean.
  select coalesce(jsonb_agg(jsonb_build_object(
           'snapshotDate', g.snapshot_date,
           'sku',           g.sku,
           'fc',            g.fc,
           'disp',          g.disp,
           'qty',           g.qty,
           'fnsku',         g.fnsku,
           'productName',  g.product_name,
           'country',       g.country,
           'source',        g.src,
           'rows',          g.raw_rows
         )), '[]'::jsonb)
    into v_clean
  from (
    select
      n.snapshot_date,
      n.sku,
      n.fc,
      n.disp,
      sum(n.qty)                     as qty,
      count(*)                       as raw_rows,
      max(nullif(n.fnsku, ''))       as fnsku,
      max(nullif(n.product_name, '')) as product_name,
      max(nullif(n.country, ''))     as country,
      max(n.src)                     as src
    from (
      select
        case when btrim(coalesce(r ->> 'snapshotDate', '')) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
             then btrim(r ->> 'snapshotDate')::date end            as snapshot_date,
        btrim(coalesce(r ->> 'sku', ''))                            as sku,
        upper(btrim(coalesce(r ->> 'fulfillmentCenterId', '')))   as fc,
        upper(btrim(coalesce(r ->> 'detailedDisposition', '')))    as disp,
        case when btrim(coalesce(r ->> 'quantity', '')) ~ '^-?[0-9]+$'
             then btrim(r ->> 'quantity')::int end                  as qty,
        btrim(coalesce(r ->> 'fnsku', ''))                          as fnsku,
        btrim(coalesce(r ->> 'productName', ''))                   as product_name,
        upper(btrim(coalesce(r ->> 'country', '')))                 as country,
        coalesce(nullif(btrim(coalesce(r ->> 'source', '')), ''), 'report') as src
      from jsonb_array_elements(p_rows) r
    ) n
    where n.snapshot_date is not null
      and n.sku <> ''
      and n.qty is not null
    group by 1, 2, 3, 4
  ) g;

  v_valid := jsonb_array_length(v_clean);

  select coalesce(sum((e ->> 'qty')::int), 0)::int,
         count(distinct e ->> 'snapshotDate')::int,
         coalesce(sum((e ->> 'rows')::int), 0)::int
    into v_units, v_snaps, v_raw
  from jsonb_array_elements(v_clean) e;

  -- Đếm dòng SẼ là update (đã có sẵn khoá) TRƯỚC khi ghi → số liệu log trung thực
  select count(*) into v_upd
  from jsonb_array_elements(v_clean) e
  where exists (
    select 1 from inventory.fc_allocation x
     where x.seller_account_id     = p_seller
       and x.snapshot_date         = (e ->> 'snapshotDate')::date
       and x.sku                   = e ->> 'sku'
       and x.fulfillment_center_id = e ->> 'fc'
       and x.detailed_disposition  = e ->> 'disp'
  );

  insert into inventory.fc_allocation as t (
    seller_account_id, snapshot_date, sku, fnsku, product_name, quantity,
    fulfillment_center_id, detailed_disposition, country, source, imported_at, updated_at
  )
  select
    p_seller,
    (e ->> 'snapshotDate')::date,
    e ->> 'sku',
    nullif(e ->> 'fnsku', ''),
    nullif(e ->> 'productName', ''),
    coalesce((e ->> 'qty')::int, 0),
    coalesce(e ->> 'fc', ''),
    coalesce(e ->> 'disp', ''),
    nullif(e ->> 'country', ''),
    coalesce(nullif(e ->> 'source', ''), 'report'),
    now(),
    now()
  from jsonb_array_elements(v_clean) e
  on conflict (seller_account_id, snapshot_date, sku, fulfillment_center_id, detailed_disposition)
  do update set
    quantity     = excluded.quantity,
    fnsku        = coalesce(excluded.fnsku, t.fnsku),
    product_name = coalesce(excluded.product_name, t.product_name),
    country      = coalesce(excluded.country, t.country),
    source       = excluded.source,
    imported_at  = excluded.imported_at,
    updated_at   = excluded.updated_at;

  get diagnostics v_rows = row_count;

  return query
    select greatest(v_rows - v_upd, 0),   -- inserted
           v_upd,                         -- updated (khoá đã có → ghi đè)
           greatest(v_total - v_raw, 0),  -- skipped (thiếu khoá / số không đọc được)
           greatest(v_raw - v_valid, 0),  -- merged  (trùng khoá trong file → cộng dồn)
           v_units,
           v_snaps;
end;
$$;

comment on function public.vexim_worker_upsert_fc_allocation(uuid, jsonb) is
  'M3 nâng cao: worker nhập report GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA '
  '(phân bổ tồn theo FC). Idempotent theo (shop, ngày, SKU, FC, disposition) — chỉ service_role.';

-- ============================================================================
-- 5. RPC worker — nhập report lịch sử nhận hàng
-- ============================================================================
create or replace function public.vexim_worker_upsert_receipts(
  p_seller uuid,
  p_rows   jsonb
)
returns table (inserted int, updated int, skipped int, merged int, units int, shipments int)
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
  v_units int := 0;
  v_ships int := 0;
begin
  if auth.uid() is not null then
    raise exception '[M3-RX] RPC này chỉ dành cho worker (service_role) — web không ghi lịch sử nhận hàng trực tiếp'
      using errcode = 'insufficient_privilege';
  end if;
  if p_seller is null then
    raise exception '[M3-RX] thiếu seller_account_id' using errcode = 'invalid_parameter_value';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '[M3-RX] p_rows phải là JSON array (nhận %)',
      coalesce(jsonb_typeof(p_rows), 'NULL')
      using errcode = 'invalid_parameter_value';
  end if;

  v_total := jsonb_array_length(p_rows);

  select coalesce(jsonb_agg(jsonb_build_object(
           'receivedDate', g.received_date,
           'sku',           g.sku,
           'shipment_id',   g.shipment_id,
           'fc',            g.fc,
           'qty',           g.qty,
           'fnsku',         g.fnsku,
           'productName',  g.product_name,
           'source',        g.src,
           'rows',          g.raw_rows
         )), '[]'::jsonb)
    into v_clean
  from (
    select
      n.received_date,
      n.sku,
      n.shipment_id,
      n.fc,
      sum(n.qty)                      as qty,
      count(*)                        as raw_rows,
      max(nullif(n.fnsku, ''))        as fnsku,
      max(nullif(n.product_name, '')) as product_name,
      max(n.src)                      as src
    from (
      select
        case when btrim(coalesce(r ->> 'receivedDate', '')) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
             then btrim(r ->> 'receivedDate')::date end            as received_date,
        btrim(coalesce(r ->> 'sku', ''))                            as sku,
        upper(btrim(coalesce(r ->> 'fbaShipmentId', '')))         as shipment_id,
        upper(btrim(coalesce(r ->> 'fulfillmentCenterId', '')))   as fc,
        case when btrim(coalesce(r ->> 'quantity', '')) ~ '^-?[0-9]+$'
             then btrim(r ->> 'quantity')::int end                  as qty,
        btrim(coalesce(r ->> 'fnsku', ''))                          as fnsku,
        btrim(coalesce(r ->> 'productName', ''))                   as product_name,
        coalesce(nullif(btrim(coalesce(r ->> 'source', '')), ''), 'report') as src
      from jsonb_array_elements(p_rows) r
    ) n
    where n.received_date is not null
      and n.sku <> ''
      and n.qty is not null
    group by 1, 2, 3, 4
  ) g;

  v_valid := jsonb_array_length(v_clean);

  select coalesce(sum((e ->> 'qty')::int), 0)::int,
         count(distinct e ->> 'shipment_id') filter (where coalesce(e ->> 'shipment_id', '') <> '')::int,
         coalesce(sum((e ->> 'rows')::int), 0)::int
    into v_units, v_ships, v_raw
  from jsonb_array_elements(v_clean) e;

  select count(*) into v_upd
  from jsonb_array_elements(v_clean) e
  where exists (
    select 1 from inventory.receipts x
     where x.seller_account_id     = p_seller
       and x.received_date         = (e ->> 'receivedDate')::date
       and x.sku                   = e ->> 'sku'
       and x.fba_shipment_id       = coalesce(e ->> 'shipment_id', '')
       and x.fulfillment_center_id = coalesce(e ->> 'fc', '')
  );

  insert into inventory.receipts as t (
    seller_account_id, received_date, sku, fnsku, product_name, quantity,
    fba_shipment_id, fulfillment_center_id, source, imported_at, updated_at
  )
  select
    p_seller,
    (e ->> 'receivedDate')::date,
    e ->> 'sku',
    nullif(e ->> 'fnsku', ''),
    nullif(e ->> 'productName', ''),
    coalesce((e ->> 'qty')::int, 0),
    coalesce(e ->> 'shipment_id', ''),
    coalesce(e ->> 'fc', ''),
    coalesce(nullif(e ->> 'source', ''), 'report'),
    now(),
    now()
  from jsonb_array_elements(v_clean) e
  on conflict (seller_account_id, received_date, sku, fba_shipment_id, fulfillment_center_id)
  do update set
    quantity     = excluded.quantity,
    fnsku        = coalesce(excluded.fnsku, t.fnsku),
    product_name = coalesce(excluded.product_name, t.product_name),
    source       = excluded.source,
    imported_at  = excluded.imported_at,
    updated_at   = excluded.updated_at;

  get diagnostics v_rows = row_count;

  return query
    select greatest(v_rows - v_upd, 0),   -- inserted
           v_upd,                         -- updated (khoá đã có → ghi đè)
           greatest(v_total - v_raw, 0),  -- skipped (thiếu khoá / số không đọc được)
           greatest(v_raw - v_valid, 0),  -- merged  (trùng khoá trong file → cộng dồn)
           v_units,
           v_ships;
end;
$$;

comment on function public.vexim_worker_upsert_receipts(uuid, jsonb) is
  'M3 nâng cao: worker nhập report GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA '
  '(lịch sử nhận hàng). Idempotent theo (shop, ngày nhận, SKU, lô, FC) — chỉ service_role.';

revoke all on function public.vexim_worker_upsert_fc_allocation(uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.vexim_worker_upsert_fc_allocation(uuid, jsonb) to service_role;
revoke all on function public.vexim_worker_upsert_receipts(uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.vexim_worker_upsert_receipts(uuid, jsonb) to service_role;

-- ============================================================================
-- 6. VIEW 6A — vexim_inventory_fc: phân bổ theo FC (snapshot MỚI NHẤT, gộp disposition)
-- ============================================================================
-- Mỗi dòng = 1 SKU × 1 FC. Kèm tổng của SKU đó để UI tính % mà không phải
-- cộng lại phía client (hai nơi cộng hai kiểu là nguồn gốc số lệch nhau).
create or replace view public.vexim_inventory_fc
with (security_invoker = true) as
with latest as (
  select seller_account_id, max(snapshot_date) as snapshot_date
  from inventory.fc_allocation
  group by 1
),
agg as (
  select
    a.seller_account_id,
    a.snapshot_date,
    a.sku,
    a.fulfillment_center_id,
    max(nullif(a.fnsku, ''))        as fnsku,
    max(nullif(a.product_name, '')) as product_name,
    max(nullif(a.country, ''))      as country,
    sum(a.quantity)                 as quantity,
    sum(a.quantity) filter (where a.detailed_disposition = 'SELLABLE')                        as sellable_qty,
    sum(a.quantity) filter (where a.detailed_disposition <> '' and a.detailed_disposition <> 'SELLABLE') as unsellable_qty,
    sum(a.quantity) filter (where a.detailed_disposition = '')                                as unknown_qty,
    max(a.source)                   as source,
    max(a.imported_at)              as imported_at
  from inventory.fc_allocation a
  join latest l
    on l.seller_account_id = a.seller_account_id
   and l.snapshot_date     = a.snapshot_date
  group by 1, 2, 3, 4
)
select
  g.seller_account_id,
  sa.display_name as shop,
  g.snapshot_date,
  g.sku,
  g.fnsku,
  g.product_name,
  g.fulfillment_center_id as fc,
  g.country,
  g.quantity,
  coalesce(g.sellable_qty, 0)   as sellable_qty,
  coalesce(g.unsellable_qty, 0) as unsellable_qty,
  coalesce(g.unknown_qty, 0)    as unknown_qty,
  sum(g.quantity) over (partition by g.seller_account_id, g.sku) as sku_total_qty,
  count(*)        over (partition by g.seller_account_id, g.sku) as sku_fc_count,
  -- Tổng = 0 (hàng đã rút hết / toàn dòng 0) → NULL, không phải 0%: "không có
  -- hàng để chia" khác với "FC này chiếm 0%".
  case when sum(g.quantity) over (partition by g.seller_account_id, g.sku) > 0
       then round(g.quantity::numeric * 100
                  / sum(g.quantity) over (partition by g.seller_account_id, g.sku), 1)
  end as fc_share_pct,
  g.source,
  g.imported_at
from agg g
join connections.seller_accounts sa on sa.id = g.seller_account_id;

comment on view public.vexim_inventory_fc is
  'M3/I2: hàng của SKU đang nằm ở FC nào (snapshot mới nhất của report '
  'GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA). fc_share_pct NULL = tổng SKU = 0.';

-- ============================================================================
-- 7. VIEW 6B — vexim_inventory_fc_rows: chi tiết theo disposition (drill-down)
-- ============================================================================
-- Vì sao cần: 6A gộp disposition để UI gọn; khi người dùng hỏi "20 đơn vị kia
-- là gì?" thì phải chỉ được đúng dòng report (SELLABLE 100, DAMAGED 20 …).
create or replace view public.vexim_inventory_fc_rows
with (security_invoker = true) as
with latest as (
  select seller_account_id, max(snapshot_date) as snapshot_date
  from inventory.fc_allocation
  group by 1
)
select
  a.seller_account_id,
  sa.display_name as shop,
  a.snapshot_date,
  a.sku,
  a.fnsku,
  a.product_name,
  nullif(a.fulfillment_center_id, '') as fc,
  nullif(a.detailed_disposition, '')  as disposition,
  case
    when a.detailed_disposition = 'SELLABLE' then 'sellable'
    when a.detailed_disposition = ''         then 'unknown'
    else 'unsellable'
  end as disposition_group,
  a.quantity,
  nullif(a.country, '') as country,
  a.source,
  a.imported_at
from inventory.fc_allocation a
join latest l
  on l.seller_account_id = a.seller_account_id
 and l.snapshot_date     = a.snapshot_date
join connections.seller_accounts sa on sa.id = a.seller_account_id;

comment on view public.vexim_inventory_fc_rows is
  'M3/I2 drill-down: từng dòng report phân bổ FC (giữ disposition), snapshot mới nhất.';

-- ============================================================================
-- 8. VIEW 6C — vexim_inventory_receipts: lịch sử nhận hàng (từng dòng)
-- ============================================================================
create or replace view public.vexim_inventory_receipts
with (security_invoker = true) as
select
  r.seller_account_id,
  sa.display_name as shop,
  r.received_date,
  (current_date - r.received_date) as days_ago,
  r.sku,
  r.fnsku,
  r.product_name,
  r.quantity,
  nullif(r.fba_shipment_id, '')       as shipment_id,
  nullif(r.fulfillment_center_id, '') as fc,
  r.source,
  r.imported_at
from inventory.receipts r
join connections.seller_accounts sa on sa.id = r.seller_account_id;

comment on view public.vexim_inventory_receipts is
  'M3/I2: lịch sử Amazon thực nhận hàng, từ report '
  'GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA. shipment_id NULL = report không gắn lô.';

-- ============================================================================
-- 9. VIEW 6D — vexim_inbound_receipt_shipments: đối soát nhận theo lô
-- ============================================================================
-- Đây là chỗ biến "lịch sử nhận" thành quyết định được: nhận đủ / thiếu / thừa.
-- expected lấy từ inventory.inbound_shipments.quantity (worker ghi từ Inbound API,
-- màn I4 đang hiển thị). LEFT JOIN nên:
--   • có lô trong I4 → tính diff_units, receipt_rate_pct, reconcile_state
--   • KHÔNG có (lô cũ đã CLOSED trước khi sync, hoặc report gắn lô lạ) →
--     expected_units = NULL, expected_source = 'none', state = 'unknown_expected'
--     → UI phải nói "chưa rõ số gửi", không được hiện "nhận đủ".
create or replace view public.vexim_inbound_receipt_shipments
with (security_invoker = true) as
with rec as (
  select
    r.seller_account_id,
    r.fba_shipment_id,
    max(nullif(r.fulfillment_center_id, '')) as fc,
    min(r.received_date)                     as first_received_date,
    max(r.received_date)                     as last_received_date,
    sum(r.quantity)                          as received_units,
    count(distinct r.sku)                    as sku_count
  from inventory.receipts r
  where r.fba_shipment_id <> ''
  group by 1, 2
)
select
  rec.seller_account_id,
  sa.display_name as shop,
  rec.fba_shipment_id as shipment_id,
  rec.fc,
  rec.first_received_date,
  rec.last_received_date,
  rec.received_units,
  rec.sku_count,
  b.status   as shipment_status,
  b.eta_date as expected_eta,
  b.quantity as expected_units,
  case when b.quantity is null then null
       else rec.received_units - b.quantity end as diff_units,
  case when b.quantity is null or b.quantity <= 0 then null
       else round(rec.received_units::numeric * 100 / b.quantity, 1) end as receipt_rate_pct,
  case
    when b.quantity is null then 'unknown_expected'
    when rec.received_units = b.quantity then 'matched'
    when rec.received_units < b.quantity then 'short'
    else 'over'
  end as reconcile_state,
  case when b.id is null then 'none' else 'inbound_shipments' end as expected_source
from rec
join connections.seller_accounts sa on sa.id = rec.seller_account_id
left join inventory.inbound_shipments b
       on b.seller_account_id = rec.seller_account_id
      and b.shipment_id       = rec.fba_shipment_id;

comment on view public.vexim_inbound_receipt_shipments is
  'M3/I4: đối soát số Amazon thực nhận (report receipts) với số gửi đã ghi ở '
  'inventory.inbound_shipments. expected_units NULL = chưa rõ số gửi (không suy diễn).';

-- ============================================================================
-- 10. GRANTS cho view
-- ============================================================================
grant select on
  public.vexim_inventory_fc,
  public.vexim_inventory_fc_rows,
  public.vexim_inventory_receipts,
  public.vexim_inbound_receipt_shipments
to authenticated, service_role;

-- ============================================================================
-- 11. TỰ KIỂM TRA (fail sớm — không để migration "chạy xong mà thiếu")
-- ============================================================================
do $$
declare
  n      int;
  v_view text;
  v_cols text;
begin
  -- 11.1 hai bảng tồn tại, có RLS, có index unique đúng khoá
  select count(*) into n
  from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'inventory'
    and c.relname in ('fc_allocation', 'receipts')
    and c.relrowsecurity;
  if n <> 2 then
    raise exception '[0018] FAIL: inventory.fc_allocation / inventory.receipts thiếu hoặc chưa bật RLS (có %/2)', n;
  end if;

  select count(*) into n from pg_indexes
  where schemaname = 'inventory'
    and indexname in ('uq_fc_allocation_key', 'uq_receipts_key')
    and indexdef like '%UNIQUE%';
  if n <> 2 then
    raise exception '[0018] FAIL: thiếu index unique khử trùng import (có %/2)', n;
  end if;

  -- 11.2 KHÔNG có policy ghi nào cho web (chỉ SELECT)
  select count(*) into n from pg_policies
  where schemaname = 'inventory'
    and tablename in ('fc_allocation', 'receipts')
    and cmd <> 'SELECT';
  if n <> 0 then
    raise exception '[0018] FAIL: có % policy ghi trên fc_allocation/receipts — web phải KHÔNG ghi được', n;
  end if;

  -- 11.3 hai RPC tồn tại, security definer, và authenticated KHÔNG execute được
  --      (dạng 3 tham số — giống 0016; PGlite không có biến thể missing_ok)
  foreach v_view in array array[
    'vexim_worker_upsert_fc_allocation',
    'vexim_worker_upsert_receipts'
  ] loop
    select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.proname = v_view
      and p.prosecdef
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and has_function_privilege('service_role', p.oid, 'EXECUTE');
    if n <> 1 then
      raise exception '[0018] FAIL: RPC % thiếu / không security definer / sai quyền execute', v_view;
    end if;
  end loop;

  -- 11.4 bốn view công khai tồn tại + security_invoker (RLS bảng gốc vẫn áp)
  select count(*) into n
  from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public'
    and c.relname in ('vexim_inventory_fc', 'vexim_inventory_fc_rows',
                      'vexim_inventory_receipts', 'vexim_inbound_receipt_shipments')
    and 'security_invoker=true' = any (c.reloptions);
  if n <> 4 then
    raise exception '[0018] FAIL: thiếu view hoặc view không security_invoker (có %/4)', n;
  end if;

  -- 11.5 hợp đồng cột — web select bằng chuỗi cố định, sai một cột là PGRST204
  select string_agg(column_name, ',' order by ordinal_position) into v_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'vexim_inventory_fc';
  if v_cols is distinct from
     'seller_account_id,shop,snapshot_date,sku,fnsku,product_name,fc,country,quantity,'
     || 'sellable_qty,unsellable_qty,unknown_qty,sku_total_qty,sku_fc_count,fc_share_pct,source,imported_at' then
    raise exception '[0018] FAIL: vexim_inventory_fc sai hợp đồng cột: %', v_cols;
  end if;

  select string_agg(column_name, ',' order by ordinal_position) into v_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'vexim_inventory_receipts';
  if v_cols is distinct from
     'seller_account_id,shop,received_date,days_ago,sku,fnsku,product_name,quantity,'
     || 'shipment_id,fc,source,imported_at' then
    raise exception '[0018] FAIL: vexim_inventory_receipts sai hợp đồng cột: %', v_cols;
  end if;

  select string_agg(column_name, ',' order by ordinal_position) into v_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'vexim_inbound_receipt_shipments';
  if v_cols is distinct from
     'seller_account_id,shop,shipment_id,fc,first_received_date,last_received_date,'
     || 'received_units,sku_count,shipment_status,expected_eta,expected_units,diff_units,'
     || 'receipt_rate_pct,reconcile_state,expected_source' then
    raise exception '[0018] FAIL: vexim_inbound_receipt_shipments sai hợp đồng cột: %', v_cols;
  end if;

  -- 11.6 regression: view I1/I4 của 0011/0017 không bị đụng
  select count(*) into n
  from information_schema.columns
  where table_schema = 'public' and table_name = 'vexim_inventory_latest'
    and column_name in ('stock_value','total_stock_value','value_currency','value_basis');
  if n <> 4 then
    raise exception '[0018] FAIL: vexim_inventory_latest mất cột giá trị tồn của 0017 (có %/4)', n;
  end if;

  select count(*) into n
  from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public' and c.relname = 'vexim_inbound_shipments';
  if n <> 1 then
    raise exception '[0018] FAIL: mất view vexim_inbound_shipments (I4)';
  end if;

  raise notice '[0018] OK: fc_allocation + receipts + 2 RPC worker + 4 view đã sẵn sàng';
end;
$$;

commit;
