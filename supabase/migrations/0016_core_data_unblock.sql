-- ============================================================================
-- 0016 — ĐỢT A: GỠ CHẶN DỮ LIỆU LÕI (giá vốn · ghi listing · pricing thật)
-- ============================================================================
-- Ba việc chặn nhau theo đúng một chuỗi nhân quả:
--
--   (1) KHÔNG CÓ GIÁ VỐN  → F3 để trống "giá trị ước tính", F4 để trống lãi gộp,
--       P1 không tính được giá sàn (0013 đang lấy floor ≈ phí, tức là coi vốn = 0).
--       → migration này mở đường NHẬP giá vốn từ web: RPC upsert tay + RPC import
--         CSV theo template + view đọc + view "độ phủ giá vốn" (SKU nào còn thiếu).
--
--   (2) LISTING KHÔNG GHI ĐƯỢC  → L1/L2/L4 chỉ có số 0: `catalog.listings` thiếu
--       cột để chứa những gì worker thật sự biết (issues, tồn, lý do stranded,
--       buyable/discoverable) và `SupabaseDbAdapter.upsertListing()` là STUB RỖNG.
--       → bổ sung cột (có `issues jsonb`), RPC ghi cho worker (service_role),
--         cập nhật 2 view L1/L2/L4, và khoá luật "không biết thì KHÔNG đè".
--
--   (3) PRICING DÙNG TẠM PHÍ  → `vexim_pricing` không hề đọc giá vốn.
--       → view dùng tra cứu giá vốn hiệu lực (`catalog.effective_cost_row()`,
--         cùng một định nghĩa với `catalog.effective_cost()` của 0003) và tính
--         GIÁ SÀN + BIÊN theo đúng công thức worker/src/domain/pricing.ts.
--
-- NGUYÊN TẮC GIỮ NGUYÊN TỪ 0014/0015:
--   • Web ghi DUY NHẤT qua RPC trong schema `public` (bài học PGRST202/205 của
--     0008) — KHÔNG cần thêm schema `catalog` vào "Exposed schemas".
--   • Worker (service_role, `auth.uid() is null`) có RPC riêng; revoke khỏi
--     public/anon/authenticated.
--   • View đọc công khai = `security_invoker = true` → RLS bảng gốc vẫn áp.
--   • THIẾU DỮ LIỆU → để NULL và nói rõ nguồn (`cost_basis`), KHÔNG BAO GIỜ đoán.
--   • Mọi lần ghi giá vốn đều để lại dấu trong `iam.audit_logs`.
--
-- Idempotent: `add column if not exists` / `create table if not exists` /
-- `create or replace` / policy+trigger drop trước khi tạo. Chạy SAU 0015.
-- ============================================================================

begin;

-- ============================================================================
-- 1. catalog.listings — ĐỦ CỘT ĐỂ GHI DỮ LIỆU THẬT (L1 / L2 / L4)
-- ============================================================================
-- `issues jsonb` đã có từ 0001 nhưng CHƯA từng được ghi (upsertListing là stub).
-- Khai báo lại `if not exists` để migration này tự đủ trên DB đã drift.
alter table catalog.listings add column if not exists issues jsonb;

-- Trạng thái chi tiết theo Listings Items API (summaries[].status)
alter table catalog.listings add column if not exists buyable      boolean;
alter table catalog.listings add column if not exists discoverable boolean;
alter table catalog.listings add column if not exists product_type text;

-- Số liệu hằng ngày từ report Merchant Listings / Stranded Inventory
alter table catalog.listings add column if not exists quantity        int;
alter table catalog.listings add column if not exists stranded_reason text;

-- Bộ đếm issue khi NGUỒN CHỈ CHO SỐ (notification LISTINGS_ITEM_ISSUES_CHANGE
-- không kèm chi tiết — theo docs phải gọi getListingsItem mới có `issues`).
-- NULL = chưa biết; view ưu tiên đếm từ `issues` khi có mảng chi tiết.
alter table catalog.listings add column if not exists issue_errors   int;
alter table catalog.listings add column if not exists issue_warnings int;
alter table catalog.listings add column if not exists enforcement_actions jsonb;

-- Vết đồng bộ: biết dòng này do nguồn nào ghi và lúc nào (màn 0.2 / L1)
alter table catalog.listings add column if not exists last_source    text;
alter table catalog.listings add column if not exists last_synced_at timestamptz;

comment on column catalog.listings.issues is
  'L2: mảng issue THẬT của Amazon (getListingsItem includedData=issues) — [{code,message,severity,attributeNames,categories,enforcements}]. NULL = chưa biết (KHÔNG phải "không có lỗi").';
comment on column catalog.listings.issue_errors is
  'Số issue severity=ERROR. Chỉ dùng khi nguồn không kèm chi tiết (notification ISSUES_CHANGE); khi có `issues` thì view đếm từ mảng.';
comment on column catalog.listings.issue_warnings is
  'Số issue severity=WARNING — cùng quy tắc với issue_errors.';
comment on column catalog.listings.stranded_reason is
  'L4/SOP-03: lý do stranded từ GET_STRANDED_INVENTORY_UI_DATA. NULL = không stranded.';
comment on column catalog.listings.quantity is
  'L1: tồn theo report Merchant Listings (quantity) — KHÔNG thay tồn FBA thật của Module 3.';
comment on column catalog.listings.last_source is
  'Nguồn ghi gần nhất: report | api | notification | manual.';

create index if not exists idx_listings_status
  on catalog.listings (seller_account_id, upper(status));
create index if not exists idx_listings_synced
  on catalog.listings (seller_account_id, last_synced_at desc);

-- ============================================================================
-- 2. catalog.cost_inputs — cột vết + khoá để upsert tất định
-- ============================================================================
alter table catalog.cost_inputs add column if not exists updated_at  timestamptz;
alter table catalog.cost_inputs add column if not exists updated_by  uuid references iam.user_profiles(id);
alter table catalog.cost_inputs add column if not exists source_ref  text;

comment on column catalog.cost_inputs.source_ref is
  'Tên file CSV / mã lô nhập — truy vết ngược khi số liệu bị nghi ngờ.';
comment on column catalog.cost_inputs.source is
  'csv = import theo template · manual = nhập tay trên /finance/costs · api = đồng bộ tự động.';

-- Khoá tất định cho upsert: một SKU chỉ có MỘT bậc giá vốn tại một mốc hiệu lực.
-- (Ràng buộc EXCLUDE của 0003 chặn khoảng chồng lấn, nhưng hai khoảng RỖNG
--  [x,x) vẫn lọt — unique index này bịt nốt và cho `on conflict` một đích rõ ràng.)
do $$
declare
  v_dup text;
begin
  select string_agg(t.k, ' · ') into v_dup
  from (
    select c.seller_account_id || '/' || c.sku || '/' || c.effective_from as k
    from catalog.cost_inputs c
    group by c.seller_account_id, c.sku, c.effective_from
    having count(*) > 1
    limit 5
  ) t;

  if v_dup is not null then
    raise exception
      '[0016] KHÔNG tạo được unique index trên catalog.cost_inputs — có bậc giá vốn trùng mốc hiệu lực: %. Xoá/gộp các dòng trùng rồi chạy lại migration.', v_dup
      using errcode = 'unique_violation';
  end if;
end
$$;

create unique index if not exists uq_cost_inputs_slot
  on catalog.cost_inputs (seller_account_id, sku, effective_from);

-- ============================================================================
-- 3. catalog.pricing_defaults — tỷ lệ dùng cho giá sàn (P1)
-- ============================================================================
-- Worker có hằng số DEFAULT_REFERRAL_RATE = 0.15 và DEFAULT_MIN_MARGIN_RATE = 0.10
-- (worker/src/domain/pricing.ts). View cần ĐÚNG hai số đó, nhưng không hard-code
-- trong SQL để VEXIM đổi được theo danh mục/shop mà không cần migration mới.
create table if not exists catalog.pricing_defaults (
  id                 int primary key default 1 check (id = 1),
  referral_fee_rate  numeric(5,4) not null default 0.1500
                     check (referral_fee_rate >= 0 and referral_fee_rate < 1),
  min_margin_rate    numeric(5,4) not null default 0.1000
                     check (min_margin_rate >= 0 and min_margin_rate < 1),
  other_fee_per_unit numeric(12,4) not null default 0
                     check (other_fee_per_unit >= 0),
  updated_at         timestamptz not null default now(),
  -- referral + biên tối thiểu phải < 100%, nếu không công thức giá sàn vô nghiệm
  check (referral_fee_rate + min_margin_rate < 1)
);

comment on table catalog.pricing_defaults is
  'P1: tỷ lệ referral fee / biên tối thiểu / phí khác trên mỗi đơn vị — đầu vào của giá sàn. Một dòng duy nhất (id=1).';

insert into catalog.pricing_defaults (id)
values (1)
on conflict (id) do nothing;

alter table catalog.pricing_defaults enable row level security;

drop policy if exists rls_read_pricing_defaults on catalog.pricing_defaults;
create policy rls_read_pricing_defaults on catalog.pricing_defaults
  for select using (true);          -- cấu hình công khai nội bộ, không chứa dữ liệu shop
-- KHÔNG có policy ghi cho authenticated: đổi tỷ lệ là việc của service_role/admin
-- (tránh một user đổi biên tối thiểu của cả hệ thống mà không qua audit).

grant select on catalog.pricing_defaults to authenticated, service_role;
grant all    on catalog.pricing_defaults to service_role;

-- ============================================================================
-- 4. HÀM TRA GIÁ VỐN HIỆU LỰC — một định nghĩa duy nhất
-- ============================================================================
-- 0003 có `catalog.effective_cost()` trả VỀ MỘT SỐ. View P1 cần thêm tiền tệ +
-- mốc hiệu lực để (a) không cộng vốn USD vào giá bán EUR và (b) nói rõ giá vốn
-- đang lấy từ bậc nào. Vì vậy tách phần lõi ra `effective_cost_row()` và biến
-- `effective_cost()` thành wrapper — HAI HÀM LUÔN TRẢ CÙNG MỘT KẾT QUẢ.
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
    and ci.sku = p_sku
    and ci.effective_from <= p_on
    and (ci.effective_to is null or ci.effective_to > p_on)
  order by ci.effective_from desc
  limit 1;
$$;

comment on function catalog.effective_cost_row(uuid, text, date) is
  'Bậc giá vốn hiệu lực tại ngày p_on (kèm tiền tệ + mốc) — lõi của catalog.effective_cost().';

create or replace function catalog.effective_cost(
  p_seller uuid, p_sku text, p_on date default current_date)
returns numeric
language sql stable security definer
set search_path = catalog, pg_catalog
as $$
  select r.unit_cost from catalog.effective_cost_row(p_seller, p_sku, p_on) r;
$$;

comment on function catalog.effective_cost(uuid, text, date) is
  'F4/P1: giá vốn hiệu lực tại ngày p_on — wrapper của catalog.effective_cost_row().';

grant execute on function catalog.effective_cost_row(uuid, text, date) to authenticated, service_role;
grant execute on function catalog.effective_cost(uuid, text, date)     to authenticated, service_role;

-- ============================================================================
-- 5. RPC GHI LISTING CHO WORKER (chỉ service_role) — thay stub rỗng
-- ============================================================================
-- LUẬT GHI (quan trọng hơn cả câu SQL — đọc trước khi sửa):
--   • giá trị null / key vắng  → GIỮ NGUYÊN giá trị đang có
--     (report "Closed"/"Unknown" không cho biết trạng thái → không được xoá
--      trạng thái mà notification vừa ghi; đây là nguyên tắc "3 nguồn ghi lên
--      cùng một listing state" của job listings-sync).
--   • `issues` là MẢNG (kể cả `[]`) → thay thế. `[]` nghĩa là "đã xác nhận không
--     còn issue" (getListingsItem trả về), khác hẳn null = "chưa biết".
--   • `stranded_reason`: key CÓ MẶT thì ghi kể cả null — hết stranded phải xoá
--     được lý do cũ, nếu không L4 sẽ giữ oan SKU trong hàng đợi.
--   • `issue_errors/warnings`: khi có mảng `issues` thì ĐẾM LẠI từ mảng (nguồn
--     chi tiết thắng nguồn chỉ-có-số).
create or replace function public.vexim_worker_upsert_listings(
  p_seller uuid,
  p_rows   jsonb
)
returns table (upserted int, active_count int, flagged_count int)
language plpgsql
security definer
set search_path = catalog, public, pg_catalog
as $$
declare
  v_row        jsonb;
  v_sku        text;
  v_asin       text;
  v_title      text;
  v_status     text;
  v_currency   text;
  v_product    text;
  v_source     text;
  v_issues     jsonb;
  v_errors     int;
  v_warnings   int;
  v_clear_issues boolean;
  v_enf        jsonb;
  v_stranded   text;
  v_keep_str   boolean;
  v_buyable    boolean;
  v_discover   boolean;
  v_price_txt  text;
  v_price      numeric;
  v_qty_txt    text;
  v_qty        int;
  v_synced_at  timestamptz;
  v_updated_at timestamptz;
  v_upserted   int := 0;
  v_active     int := 0;
  v_flagged    int := 0;
begin
  if auth.uid() is not null then
    raise exception '[L1] RPC này chỉ dành cho worker (service_role) — web không ghi listing trực tiếp'
      using errcode = 'insufficient_privilege';
  end if;

  if p_seller is null then
    raise exception '[L1] thiếu seller_account_id' using errcode = 'invalid_parameter_value';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '[L1] p_rows phải là jsonb array' using errcode = 'invalid_parameter_value';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_sku := btrim(coalesce(v_row ->> 'sku', ''));
    if v_sku = '' then
      raise exception '[L1] dòng listing thiếu "sku": %', left(v_row::text, 120)
        using errcode = 'invalid_parameter_value';
    end if;

    v_status := nullif(upper(btrim(coalesce(v_row ->> 'status', ''))), '');
    if v_status is not null and v_status not in
       ('ACTIVE','INACTIVE','SUPPRESSED','STRANDED','REMOVED','CLOSED','DELETED') then
      raise exception '[L1] SKU %: trạng thái không hợp lệ "%"', v_sku, v_status
        using errcode = 'invalid_parameter_value';
    end if;

    -- issues: chỉ nhận mảng; key vắng / null = "chưa biết" → giữ nguyên.
    -- `[]` = ĐÃ XÁC NHẬN không còn issue (getListingsItem trả về) → thay thế.
    -- Nếu nguồn CHỈ cho bộ đếm (notification ISSUES_CHANGE không kèm chi tiết)
    -- thì mảng chi tiết đang lưu đã LỖI THỜI → phải xoá, nếu không view sẽ đếm
    -- ra 0 từ mảng cũ và L4 bỏ sót SKU đang có lỗi thật.
    if jsonb_typeof(v_row -> 'issues') = 'array' then
      v_issues := v_row -> 'issues';
      v_clear_issues := false;
      select count(*) filter (where e ->> 'severity' = 'ERROR'),
             count(*) filter (where e ->> 'severity' = 'WARNING')
        into v_errors, v_warnings
      from jsonb_array_elements(v_issues) e;
    else
      v_issues   := null;
      v_errors   := nullif(v_row ->> 'issue_errors', '')::int;
      v_warnings := nullif(v_row ->> 'issue_warnings', '')::int;
      v_clear_issues := v_errors is not null or v_warnings is not null;
    end if;

    v_enf := case when jsonb_typeof(v_row -> 'enforcement_actions') = 'array'
                  then v_row -> 'enforcement_actions' end;

    -- stranded_reason: key CÓ MẶT thì ghi kể cả null (hết stranded phải xoá được
    -- lý do cũ, nếu không L4 giữ oan SKU trong hàng đợi)
    v_keep_str := not jsonb_exists(v_row, 'stranded_reason');
    v_stranded := case when v_keep_str then null
                       else nullif(btrim(coalesce(v_row ->> 'stranded_reason', '')), '') end;

    -- Số không đọc được → NULL ("chưa biết"), KHÔNG làm hỏng cả lô đồng bộ.
    -- Chuẩn hoá "1.299,99" là việc của tầng parse report phía worker.
    v_price_txt := btrim(coalesce(v_row ->> 'price', ''));
    v_price := case when v_price_txt ~ '^-?[0-9]+(\.[0-9]+)?$' then v_price_txt::numeric end;
    v_qty_txt := btrim(coalesce(v_row ->> 'quantity', ''));
    v_qty   := case when v_qty_txt ~ '^-?[0-9]+$' then v_qty_txt::int end;

    v_asin     := nullif(btrim(coalesce(v_row ->> 'asin', '')), '');
    v_title    := nullif(btrim(coalesce(v_row ->> 'title', '')), '');
    v_currency := nullif(upper(btrim(coalesce(v_row ->> 'currency', ''))), '');
    v_product  := nullif(btrim(coalesce(v_row ->> 'product_type', '')), '');
    v_source   := nullif(btrim(coalesce(v_row ->> 'source', '')), '');
    v_buyable  := case when jsonb_exists(v_row, 'buyable')
                       then nullif(v_row ->> 'buyable', '')::boolean end;
    v_discover := case when jsonb_exists(v_row, 'discoverable')
                       then nullif(v_row ->> 'discoverable', '')::boolean end;
    v_synced_at  := coalesce(nullif(v_row ->> 'synced_at', '')::timestamptz, now());
    v_updated_at := coalesce(nullif(v_row ->> 'updated_at', '')::timestamptz, v_synced_at);

    -- LƯU Ý NOT NULL: `status`/`currency`/`updated_at` của catalog.listings là
    -- NOT NULL có DEFAULT. Truyền NULL tường minh sẽ VÔ HIỆU default và vỡ ràng
    -- buộc (lỗi thật đã gặp khi dựng migration này) → dòng MỚI phải có giá trị,
    -- còn nhánh UPDATE thì dùng biến (null = giữ nguyên) chứ không dùng `excluded`.
    insert into catalog.listings as l (
      seller_account_id, sku, asin, title, status, price, currency, quantity,
      issues, issue_errors, issue_warnings, enforcement_actions,
      buyable, discoverable, product_type, stranded_reason,
      last_source, last_synced_at, updated_at
    )
    values (
      p_seller,
      v_sku,
      v_asin,
      v_title,
      -- dòng MỚI mà nguồn không cho biết trạng thái → 'UNKNOWN' (không bịa 'active')
      coalesce(v_status, 'UNKNOWN'),
      v_price,
      coalesce(v_currency, 'USD'),      -- default của bảng (0001)
      v_qty,
      v_issues,
      v_errors,
      v_warnings,
      v_enf,
      v_buyable,
      v_discover,
      v_product,
      v_stranded,
      v_source,
      v_synced_at,
      v_updated_at
    )
    on conflict (seller_account_id, sku) do update set
      asin                = coalesce(v_asin, l.asin),
      title               = coalesce(v_title, l.title),
      status              = coalesce(v_status, l.status),
      price               = coalesce(v_price, l.price),
      currency            = coalesce(v_currency, l.currency),
      quantity            = coalesce(v_qty, l.quantity),
      issues              = case when v_clear_issues then null
                                 else coalesce(v_issues, l.issues) end,
      issue_errors        = coalesce(v_errors, l.issue_errors),
      issue_warnings      = coalesce(v_warnings, l.issue_warnings),
      enforcement_actions = coalesce(v_enf, l.enforcement_actions),
      buyable             = coalesce(v_buyable, l.buyable),
      discoverable        = coalesce(v_discover, l.discoverable),
      product_type        = coalesce(v_product, l.product_type),
      stranded_reason     = case when v_keep_str then l.stranded_reason else v_stranded end,
      last_source         = coalesce(v_source, l.last_source),
      last_synced_at      = coalesce(v_synced_at, l.last_synced_at),
      updated_at          = v_updated_at;

    v_upserted := v_upserted + 1;
    if v_status = 'ACTIVE' then
      v_active := v_active + 1;
    elsif v_status is not null then
      v_flagged := v_flagged + 1;
    end if;
  end loop;

  return query select v_upserted, v_active, v_flagged;
end;
$$;

comment on function public.vexim_worker_upsert_listings(uuid, jsonb) is
  'L1/L2/L4: worker ghi trạng thái listing (report + getListingsItem + notification). Null = "chưa biết" và KHÔNG đè dữ liệu cũ.';

revoke all on function public.vexim_worker_upsert_listings(uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.vexim_worker_upsert_listings(uuid, jsonb) to service_role;

-- ============================================================================
-- 6. VIEW L1/L2/L4 — thêm cột mới (create or replace chỉ được NỐI THÊM cột)
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
  -- ↓ cột mới (0016) — phải nằm CUỐI để không phá cột web đang đọc
  l.product_type,
  l.buyable,
  l.discoverable,
  l.quantity,
  l.stranded_reason,
  l.enforcement_actions,
  l.last_source,
  l.last_synced_at
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
  -- ↓ cột mới (0016)
  l.quantity,
  l.stranded_reason,
  l.enforcement_actions,
  l.product_type,
  l.last_source,
  l.last_synced_at,
  -- BUYABLE/DISCOVERABLE: L4 phải nói được "report ghi ACTIVE mà không mua được"
  l.buyable,
  l.discoverable
from catalog.listings l
join connections.seller_accounts sa on sa.id = l.seller_account_id
-- upper() để nhận cả 'active' (seed cũ) lẫn 'ACTIVE' (worker ghi)
where upper(l.status) in ('INACTIVE','STRANDED','SUPPRESSED','REMOVED')
   or (jsonb_typeof(l.issues) = 'array' and jsonb_array_length(l.issues) > 0)
   or coalesce(l.issue_errors, 0) > 0;

grant select on public.vexim_listings, public.vexim_listing_queue to authenticated, service_role;

-- ============================================================================
-- 7. VIEW GIÁ VỐN + ĐỘ PHỦ (đầu vào F3/F4/P1)
-- ============================================================================
create or replace view public.vexim_cost_inputs
with (security_invoker = true) as
select
  c.id,
  c.seller_account_id,
  sa.display_name           as shop,
  c.sku,
  c.unit_cost,
  c.currency,
  c.effective_from,
  c.effective_to,
  c.source,
  c.source_ref,
  c.note,
  c.imported_by,
  c.updated_by,
  c.created_at,
  c.updated_at,
  -- bậc đang áp dụng hôm nay (để web tô đậm + F3/F4/P1 biết số nào đang dùng)
  (c.effective_from <= current_date
     and (c.effective_to is null or c.effective_to > current_date))  as is_current,
  (c.effective_to is null)                                          as is_open_ended
from catalog.cost_inputs c
join connections.seller_accounts sa on sa.id = c.seller_account_id;

-- SKU đang bán mà CHƯA có giá vốn → chính là danh sách "gỡ chặn" F3/F4/P1.
create or replace view public.vexim_cost_coverage
with (security_invoker = true) as
select
  l.seller_account_id,
  sa.display_name           as shop,
  l.sku,
  l.asin,
  l.title,
  l.status,
  l.price,
  l.currency,
  c.unit_cost,
  c.currency                as cost_currency,
  c.effective_from          as cost_effective_from,
  c.source                  as cost_source,
  (c.unit_cost is null)     as missing_cost,
  (c.unit_cost is not null and c.currency <> l.currency) as currency_mismatch
from catalog.listings l
join connections.seller_accounts sa on sa.id = l.seller_account_id
left join lateral (
  select r.unit_cost, r.currency, r.effective_from, r.source
  from catalog.effective_cost_row(l.seller_account_id, l.sku, current_date) r
) c on true;

grant select on public.vexim_cost_inputs, public.vexim_cost_coverage to authenticated, service_role;

-- Danh sách shop người dùng ĐỌC ĐƯỢC — bộ chọn shop trên /finance/costs và các trang
-- cần lọc theo shop. security_invoker → RLS của connections.seller_accounts (0004)
-- vẫn áp: iam.can_read_seller_account(id). KHÔNG phơi seller_id (merchant token Amazon).
create or replace view public.vexim_shops
with (security_invoker = true) as
select
  sa.id                 as seller_account_id,
  sa.display_name       as shop,
  sa.marketplace,
  sa.status,
  sa.data_source,
  sa.health_status,
  sa.last_sync_at
from connections.seller_accounts sa;

grant select on public.vexim_shops to authenticated, service_role;

-- ============================================================================
-- 8. RPC NHẬP GIÁ VỐN CHO WEB (1 cửa duy nhất — không insert/update thẳng)
-- ============================================================================
create or replace function iam.is_cost_editor(p_seller uuid)
returns boolean
language sql stable security definer
set search_path = iam, pg_catalog
as $$
  select exists (
           select 1 from iam.role_assignments ra
           where ra.user_id = auth.uid()
             and ra.role in ('super_admin','org_admin')
         )
      or exists (
           select 1 from iam.role_assignments ra
           join iam.departments d on d.id = ra.department_id
           where ra.user_id = auth.uid()
             and ra.role = 'dept_lead'
             and d.code = 'finance'
         )
      -- operator/analyst ĐƯỢC gán module tài chính trên đúng shop đó
      or exists (
           select 1 from iam.assignments a
           where a.user_id = auth.uid()
             and a.seller_account_id = p_seller
             and a.module = 'finance'
             and a.can_write = true
         );
$$;

comment on function iam.is_cost_editor(uuid) is
  'Ai được nhập/sửa giá vốn của một shop: admin, trưởng phòng Tài chính, hoặc người được gán module finance (can_write) trên shop đó.';

-- 8A. Lõi áp một bậc giá vốn (dùng chung cho nhập tay + import CSV)
--     Ngữ nghĩa "bậc thang hiệu lực":
--       • bậc cũ bắt đầu TRƯỚC mốc mới và còn phủ qua mốc mới → cắt ngọn tại mốc mới
--       • bậc cũ nằm TRONG khoảng của bậc mới → bị thay thế (xoá, có đếm)
--       • ghi bậc mới; trùng (sku, effective_from) thì tính là CẬP NHẬT
create or replace function catalog.apply_cost_input(
  p_seller     uuid,
  p_sku        text,
  p_unit_cost  numeric,
  p_currency   text,
  p_from       date,
  p_to         date,
  p_source     text,
  p_actor      uuid,
  p_note       text,
  p_source_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = catalog, iam, pg_catalog
as $$
declare
  v_sku        text := upper(btrim(coalesce(p_sku, '')));
  v_currency   text := upper(btrim(coalesce(p_currency, 'USD')));
  v_source     text := lower(btrim(coalesce(p_source, 'manual')));
  v_existed    boolean;
  v_closed     int := 0;
  v_superseded int := 0;
  v_id         uuid;
begin
  if v_sku = '' then
    raise exception 'thiếu SKU' using errcode = 'invalid_parameter_value';
  end if;
  if length(v_sku) > 40 then
    raise exception 'SKU "%" dài hơn 40 ký tự (giới hạn seller-sku của Amazon)', v_sku
      using errcode = 'invalid_parameter_value';
  end if;
  if p_unit_cost is null then
    raise exception 'thiếu giá vốn (unit_cost) của SKU %', v_sku
      using errcode = 'invalid_parameter_value';
  end if;
  if p_unit_cost < 0 then
    raise exception 'giá vốn của SKU % phải ≥ 0 (nhận %)', v_sku, p_unit_cost
      using errcode = 'invalid_parameter_value';
  end if;
  if p_from is null then
    raise exception 'thiếu ngày hiệu lực (effective_from) của SKU %', v_sku
      using errcode = 'invalid_parameter_value';
  end if;
  if p_to is not null and p_to <= p_from then
    raise exception 'SKU %: effective_to (%) phải SAU effective_from (%)', v_sku, p_to, p_from
      using errcode = 'invalid_parameter_value';
  end if;
  if v_source not in ('csv','manual','api') then
    raise exception 'nguồn không hợp lệ: % (chỉ nhận csv | manual | api)', v_source
      using errcode = 'invalid_parameter_value';
  end if;

  select exists (
    select 1 from catalog.cost_inputs c
    where c.seller_account_id = p_seller and c.sku = v_sku and c.effective_from = p_from
  ) into v_existed;

  -- (1) cắt ngọn bậc cũ đang phủ qua mốc mới
  with t as (
    update catalog.cost_inputs c
       set effective_to = p_from,
           updated_at   = now(),
           updated_by   = p_actor
     where c.seller_account_id = p_seller
       and c.sku = v_sku
       and c.effective_from < p_from
       and (c.effective_to is null or c.effective_to > p_from)
    returning 1
  ) select count(*) into v_closed from t;

  -- (2) gỡ các bậc nằm trong khoảng của bậc mới (kể cả bậc trùng mốc — sẽ ghi lại)
  with d as (
    delete from catalog.cost_inputs c
     where c.seller_account_id = p_seller
       and c.sku = v_sku
       and c.effective_from >= p_from
       and (p_to is null or c.effective_from < p_to)
    returning 1
  ) select count(*) into v_superseded from d;

  -- (3) ghi bậc mới
  insert into catalog.cost_inputs (
    seller_account_id, sku, unit_cost, currency, effective_from, effective_to,
    source, imported_by, note, source_ref, updated_by, updated_at
  ) values (
    p_seller, v_sku, p_unit_cost, v_currency, p_from, p_to,
    v_source, p_actor, nullif(btrim(coalesce(p_note, '')), ''),
    nullif(btrim(coalesce(p_source_ref, '')), ''), p_actor, now()
  )
  returning id into v_id;

  return jsonb_build_object(
    'id',               v_id,
    'sku',              v_sku,
    'effective_from',   to_char(p_from, 'YYYY-MM-DD'),
    'inserted',         case when v_existed then 0 else 1 end,
    'updated',          case when v_existed then 1 else 0 end,
    'closed_previous',  v_closed,
    'superseded',       v_superseded
  );
end;
$$;

comment on function catalog.apply_cost_input(uuid, text, numeric, text, date, date, text, uuid, text, text) is
  'Lõi ghi một bậc giá vốn theo khoảng hiệu lực (cắt ngọn bậc cũ + thay bậc nằm trong khoảng). KHÔNG tự kiểm quyền — caller phải kiểm.';

-- 8B. Nhập TAY một bậc giá vốn (form trên /finance/costs)
create or replace function public.vexim_upsert_cost_input(
  p_seller       uuid,
  p_sku          text,
  p_unit_cost    numeric,
  p_currency     text default 'USD',
  p_effective_from date default current_date,
  p_effective_to   date default null,
  p_note         text default null
)
returns jsonb
language plpgsql
security definer
set search_path = catalog, iam, public, pg_catalog
as $$
declare
  v_actor uuid := auth.uid();
  v_res   jsonb;
begin
  if v_actor is null then
    raise exception '[giá vốn] RPC này cần phiên đăng nhập (worker dùng RPC riêng)'
      using errcode = 'insufficient_privilege';
  end if;
  if not iam.can_write_seller_account(p_seller) then
    raise exception '[giá vốn] bạn không có quyền ghi trên shop này'
      using errcode = 'insufficient_privilege';
  end if;
  if not iam.is_cost_editor(p_seller) then
    raise exception '[giá vốn] chỉ Tài chính (hoặc admin) được nhập giá vốn — xem SOP-09 bước 3'
      using errcode = 'insufficient_privilege';
  end if;

  v_res := catalog.apply_cost_input(
    p_seller, p_sku, p_unit_cost, p_currency,
    p_effective_from, p_effective_to, 'manual', v_actor, p_note, null);

  insert into iam.audit_logs (actor_id, seller_account_id, module, action, entity, after_value, result)
  values (v_actor, p_seller, 'finance', 'cost.upsert',
          coalesce(v_res ->> 'sku', p_sku), v_res, 'ok');

  return v_res;
end;
$$;

comment on function public.vexim_upsert_cost_input(uuid, text, numeric, text, date, date, text) is
  'F3/F4/P1: nhập tay một bậc giá vốn (catalog.cost_inputs) — ghi audit log.';

-- 8C. Helper parse số/ngày từ CSV — đặt ở DB để luật parse chỉ có MỘT bản
create or replace function catalog.parse_amount(p_value jsonb)
returns numeric
language plpgsql immutable
set search_path = pg_catalog
as $$
declare
  t text;
  n numeric;
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then return null; end if;
  if jsonb_typeof(p_value) = 'number' then return (p_value #>> '{}')::numeric; end if;

  t := btrim(p_value #>> '{}');
  t := replace(replace(replace(t, '"', ''), ' ', ''), 'USD', '');
  t := replace(replace(t, 'VND', ''), '₫', '');
  if t = '' then return null; end if;

  -- số kiểu local: 1.234,56 (VN/EU) và 1,234.56 (US) — dấu phân cách HÀNG NGHÌN
  -- là dấu xuất hiện TRƯỚC.
  if position(',' in t) > 0 and position('.' in t) > 0 then
    if position(',' in t) < position('.' in t) then
      t := replace(t, ',', '');
    else
      t := replace(replace(t, '.', ''), ',', '.');
    end if;
  elsif position(',' in t) > 0 then
    t := replace(t, ',', '.');
  end if;

  begin
    n := t::numeric;
  exception when others then
    raise exception 'không đọc được số "%"', (p_value #>> '{}')
      using errcode = 'invalid_parameter_value';
  end;
  return n;
end;
$$;

create or replace function catalog.parse_day(p_value jsonb)
returns date
language plpgsql immutable
set search_path = pg_catalog
as $$
declare
  t text;
  p text[];
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then return null; end if;
  if jsonb_typeof(p_value) <> 'string' then
    raise exception 'ngày phải là chuỗi (YYYY-MM-DD hoặc DD/MM/YYYY)'
      using errcode = 'invalid_parameter_value';
  end if;

  t := btrim(p_value #>> '{}');
  if t = '' then return null; end if;

  -- ISO: 2026-09-01 (chấp nhận cả 2026/09/01)
  if t ~ '^\d{4}[-/]\d{1,2}[-/]\d{1,2}$' then
    return replace(t, '/', '-')::date;
  end if;

  -- DD/MM/YYYY (quy ước VN) — KHÔNG đoán MM/DD/YYYY
  if t ~ '^\d{1,2}[-/]\d{1,2}[-/]\d{4}$' then
    p := string_to_array(replace(t, '/', '-'), '-');
    if p[2]::int > 12 then
      raise exception 'ngày "%" có tháng > 12 — template yêu cầu YYYY-MM-DD hoặc DD/MM/YYYY', t
        using errcode = 'invalid_parameter_value';
    end if;
    if p[1]::int > 31 then
      raise exception 'ngày "%" có ngày > 31', t using errcode = 'invalid_parameter_value';
    end if;
    return make_date(p[3]::int, p[2]::int, p[1]::int);
  end if;

  raise exception 'ngày "%" sai định dạng — dùng YYYY-MM-DD (hoặc DD/MM/YYYY)', t
    using errcode = 'invalid_parameter_value';
end;
$$;

comment on function catalog.parse_amount(jsonb) is 'CSV → numeric: chấp nhận 12.5 / 12,5 / 1.234,56 / "$12.5"; không đọc được thì raise (không đoán).';
comment on function catalog.parse_day(jsonb)    is 'CSV → date: chấp nhận YYYY-MM-DD và DD/MM/YYYY; từ chối MM/DD/YYYY mơ hồ.';

-- 8D. IMPORT CSV (nhiều dòng, ATOMIC: có lỗi thì không ghi gì)
create or replace function public.vexim_import_cost_inputs(
  p_seller     uuid,
  p_rows       jsonb,
  p_source_ref text default null
)
returns jsonb
language plpgsql
security definer
set search_path = catalog, iam, public, pg_catalog
as $$
declare
  v_actor   uuid := auth.uid();
  v_row     jsonb;
  v_line    int := 1;
  v_errors  jsonb := '[]'::jsonb;
  v_res     jsonb;
  v_inserted int := 0;
  v_updated  int := 0;
  v_closed   int := 0;
  v_super    int := 0;
  v_rows     int := 0;
begin
  if v_actor is null then
    raise exception '[giá vốn] RPC này cần phiên đăng nhập (worker dùng RPC riêng)'
      using errcode = 'insufficient_privilege';
  end if;
  if not iam.can_write_seller_account(p_seller) then
    raise exception '[giá vốn] bạn không có quyền ghi trên shop này'
      using errcode = 'insufficient_privilege';
  end if;
  if not iam.is_cost_editor(p_seller) then
    raise exception '[giá vốn] chỉ Tài chính (hoặc admin) được nhập giá vốn — xem SOP-09 bước 3'
      using errcode = 'insufficient_privilege';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '[giá vốn] p_rows phải là jsonb array'
      using errcode = 'invalid_parameter_value';
  end if;

  -- VÒNG 1 — CHẠY THỬ để gom lỗi theo số dòng, RỒI ROLLBACK TOÀN BỘ.
  -- Vì sao phải vậy: `apply_cost_input` cắt ngọn/thay bậc ngay khi chạy, nên nếu
  -- vừa kiểm tra vừa ghi thì một dòng lỗi ở cuối file sẽ để lại nửa lô đã ghi.
  -- Khối con có EXCEPTION = một subtransaction: raise ở cuối khối sẽ hoàn tác mọi
  -- thứ đã ghi bên trong, còn biến plpgsql (v_errors/v_rows) thì VẪN GIỮ.
  begin
    for v_row in select * from jsonb_array_elements(p_rows)
    loop
      begin
        if btrim(coalesce(v_row ->> 'sku', '')) = '' then
          raise exception 'thiếu SKU';
        end if;
        perform catalog.apply_cost_input(
          p_seller,
          v_row ->> 'sku',
          catalog.parse_amount(v_row -> 'unit_cost'),
          coalesce(nullif(btrim(coalesce(v_row ->> 'currency', '')), ''), 'USD'),
          catalog.parse_day(v_row -> 'effective_from'),
          catalog.parse_day(v_row -> 'effective_to'),
          'csv', v_actor, v_row ->> 'note', p_source_ref);
        v_rows := v_rows + 1;
      exception when others then
        v_errors := v_errors || jsonb_build_object(
          'line', v_line, 'sku', coalesce(v_row ->> 'sku', ''), 'message', sqlerrm);
      end;
      v_line := v_line + 1;
    end loop;

    raise exception 'VEXIM_COST_TRIAL_DONE';
  exception when others then
    if sqlerrm <> 'VEXIM_COST_TRIAL_DONE' then
      raise;    -- lỗi thật ngoài dự kiến (không phải chốt hoàn tác) → báo lên
    end if;
  end;

  if jsonb_array_length(v_errors) > 0 then
    insert into iam.audit_logs (actor_id, seller_account_id, module, action, entity, after_value, result)
    values (v_actor, p_seller, 'finance', 'cost.import', p_source_ref,
            jsonb_build_object('rows', jsonb_array_length(p_rows), 'errors', jsonb_array_length(v_errors)),
            'error: ' || (v_errors -> 0 ->> 'message'));
    return jsonb_build_object(
      'ok', false, 'rows', 0, 'inserted', 0, 'updated', 0,
      'closed_previous', 0, 'superseded', 0, 'errors', v_errors);
  end if;

  -- VÒNG 2: ghi thật (đã biết chắc không còn lỗi)
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_res := catalog.apply_cost_input(
      p_seller,
      v_row ->> 'sku',
      catalog.parse_amount(v_row -> 'unit_cost'),
      coalesce(nullif(btrim(coalesce(v_row ->> 'currency', '')), ''), 'USD'),
      catalog.parse_day(v_row -> 'effective_from'),
      catalog.parse_day(v_row -> 'effective_to'),
      'csv', v_actor, v_row ->> 'note', p_source_ref);
    v_inserted := v_inserted + coalesce((v_res ->> 'inserted')::int, 0);
    v_updated  := v_updated  + coalesce((v_res ->> 'updated')::int, 0);
    v_closed   := v_closed   + coalesce((v_res ->> 'closed_previous')::int, 0);
    v_super    := v_super    + coalesce((v_res ->> 'superseded')::int, 0);
  end loop;

  insert into iam.audit_logs (actor_id, seller_account_id, module, action, entity, after_value, result)
  values (v_actor, p_seller, 'finance', 'cost.import', p_source_ref,
          jsonb_build_object('rows', v_rows, 'inserted', v_inserted, 'updated', v_updated,
                             'closed_previous', v_closed, 'superseded', v_super),
          'ok');

  return jsonb_build_object(
    'ok', true, 'rows', v_rows, 'inserted', v_inserted, 'updated', v_updated,
    'closed_previous', v_closed, 'superseded', v_super, 'errors', '[]'::jsonb);
end;
$$;

comment on function public.vexim_import_cost_inputs(uuid, jsonb, text) is
  'Import giá vốn theo template CSV: kiểm tra hết → ghi hết (atomic). Có 1 dòng lỗi thì KHÔNG ghi dòng nào và trả về danh sách lỗi theo số dòng.';

-- 8E. Kết thúc một bậc giá vốn (hết hiệu lực từ ngày X)
create or replace function public.vexim_close_cost_input(
  p_cost_input_id uuid,
  p_effective_to  date,
  p_note          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = catalog, iam, public, pg_catalog
as $$
declare
  v_actor uuid := auth.uid();
  v_row   catalog.cost_inputs%rowtype;
begin
  if v_actor is null then
    raise exception '[giá vốn] RPC này cần phiên đăng nhập' using errcode = 'insufficient_privilege';
  end if;

  select * into v_row from catalog.cost_inputs where id = p_cost_input_id for update;
  if not found then
    raise exception '[giá vốn] không tìm thấy bậc giá vốn %', p_cost_input_id
      using errcode = 'no_data_found';
  end if;
  if not iam.can_write_seller_account(v_row.seller_account_id) then
    raise exception '[giá vốn] bạn không có quyền ghi trên shop này'
      using errcode = 'insufficient_privilege';
  end if;
  if not iam.is_cost_editor(v_row.seller_account_id) then
    raise exception '[giá vốn] chỉ Tài chính (hoặc admin) được sửa giá vốn'
      using errcode = 'insufficient_privilege';
  end if;
  if p_effective_to is null or p_effective_to <= v_row.effective_from then
    raise exception '[giá vốn] ngày kết thúc phải SAU ngày hiệu lực (%)', v_row.effective_from
      using errcode = 'invalid_parameter_value';
  end if;

  update catalog.cost_inputs c
     set effective_to = p_effective_to,
         note         = coalesce(nullif(btrim(coalesce(p_note, '')), ''), c.note),
         updated_at   = now(),
         updated_by   = v_actor
   where c.id = p_cost_input_id;

  insert into iam.audit_logs (actor_id, seller_account_id, module, action, entity, before_value, after_value, result)
  values (v_actor, v_row.seller_account_id, 'finance', 'cost.close', v_row.sku,
          jsonb_build_object('effective_to', v_row.effective_to),
          jsonb_build_object('effective_to', to_char(p_effective_to, 'YYYY-MM-DD')), 'ok');

  return jsonb_build_object('ok', true, 'id', p_cost_input_id, 'sku', v_row.sku,
                            'effective_to', to_char(p_effective_to, 'YYYY-MM-DD'));
end;
$$;

comment on function public.vexim_close_cost_input(uuid, date, text) is
  'Kết thúc hiệu lực một bậc giá vốn (không xoá lịch sử — F4 cần giá vốn tại ngày cũ).';

-- 8F. Xoá bậc giá vốn NHẬP SAI — chỉ admin/trưởng phòng Tài chính, có audit
create or replace function public.vexim_delete_cost_input(p_cost_input_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = catalog, iam, public, pg_catalog
as $$
declare
  v_actor uuid := auth.uid();
  v_row   catalog.cost_inputs%rowtype;
begin
  if v_actor is null then
    raise exception '[giá vốn] RPC này cần phiên đăng nhập' using errcode = 'insufficient_privilege';
  end if;

  select * into v_row from catalog.cost_inputs where id = p_cost_input_id for update;
  if not found then
    raise exception '[giá vốn] không tìm thấy bậc giá vốn %', p_cost_input_id
      using errcode = 'no_data_found';
  end if;
  if not (
       exists (select 1 from iam.role_assignments ra
                where ra.user_id = v_actor and ra.role in ('super_admin','org_admin'))
    or exists (select 1 from iam.role_assignments ra
                join iam.departments d on d.id = ra.department_id
                where ra.user_id = v_actor and ra.role = 'dept_lead' and d.code = 'finance')
  ) then
    raise exception '[giá vốn] chỉ admin hoặc trưởng phòng Tài chính được XOÁ bậc giá vốn (dùng "Kết thúc hiệu lực" nếu chỉ muốn chốt mốc)'
      using errcode = 'insufficient_privilege';
  end if;

  delete from catalog.cost_inputs c where c.id = p_cost_input_id;

  insert into iam.audit_logs (actor_id, seller_account_id, module, action, entity, before_value, result)
  values (v_actor, v_row.seller_account_id, 'finance', 'cost.delete', v_row.sku,
          jsonb_build_object('unit_cost', v_row.unit_cost, 'currency', v_row.currency,
                             'effective_from', to_char(v_row.effective_from, 'YYYY-MM-DD'),
                             'effective_to', to_char(v_row.effective_to, 'YYYY-MM-DD'),
                             'source', v_row.source),
          'ok');

  return jsonb_build_object('ok', true, 'id', p_cost_input_id, 'sku', v_row.sku);
end;
$$;

comment on function public.vexim_delete_cost_input(uuid) is
  'Xoá bậc giá vốn nhập sai (admin/trưởng phòng Tài chính) — để lại audit log với giá trị đã xoá.';

grant execute on function public.vexim_upsert_cost_input(uuid, text, numeric, text, date, date, text) to authenticated, service_role;
grant execute on function public.vexim_import_cost_inputs(uuid, jsonb, text)                          to authenticated, service_role;
grant execute on function public.vexim_close_cost_input(uuid, date, text)                             to authenticated, service_role;
grant execute on function public.vexim_delete_cost_input(uuid)                                        to authenticated, service_role;

-- ============================================================================
-- 9. (CỐ Ý KHÔNG THÊM RPC ĐỌC GIÁ VỐN CHO WORKER)
-- ============================================================================
-- 0015 đã có `public.vexim_worker_effective_costs(p_seller, p_on)` và worker ĐANG dùng
-- nó (web/src/lib/worker/db/supabase.ts → listEffectiveCosts) cho F3/F4. Thêm một RPC
-- đọc thứ hai trùng chức năng chỉ làm tăng bề mặt security_definer mà không ai gọi.
-- Khi nào F3/F4 cần biết "giá vốn lấy từ BẬC nào" (effective_from/source) thì mở rộng
-- RPC của 0015 thay vì tạo hàm mới.

-- ============================================================================
-- 10. VIEW vexim_pricing — DÙNG GIÁ VỐN HIỆU LỰC (thay "floor ≈ phí" của 0013)
-- ============================================================================
-- Công thức GIỐNG HỆT worker/src/domain/pricing.ts để web và worker không lệch:
--   floor = (cogs + fba + other) / (1 − referralRate − minMarginRate)
--   margin = (price − cogs − fba − other − price×referralRate) / price
-- referralRate: ưu tiên SUY RA từ phí Amazon thật (referral_fee / price của
-- fees estimate gần nhất), thiếu thì dùng tỷ lệ cấu hình (mặc định 15%).
-- THIẾU GIÁ VỐN → floor/margin NULL + cost_basis nói rõ, KHÔNG lấy phí làm sàn.
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
  -- ↓ cột mới (0016): giá vốn hiệu lực + giá sàn + biên
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
  b.cost_basis
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
      end as referral_rate_used
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
    where cfg.id = 1
  ) s
) b;

grant select on public.vexim_pricing to authenticated, service_role;

-- ============================================================================
-- 11. RLS: giữ policy cũ của 0003, siết lại cho rõ (drop trước để idempotent)
-- ============================================================================
drop policy if exists rls_read_cost_inputs on catalog.cost_inputs;
create policy rls_read_cost_inputs on catalog.cost_inputs
  for select using (iam.can_read_seller_account(seller_account_id));

drop policy if exists rls_write_cost_inputs on catalog.cost_inputs;
create policy rls_write_cost_inputs on catalog.cost_inputs
  for all to authenticated
  using (iam.can_write_seller_account(seller_account_id))
  with check (iam.can_write_seller_account(seller_account_id));

-- ============================================================================
-- 12. TỰ KIỂM TRA (fail sớm — không để migration "chạy xong mà thiếu")
-- ============================================================================
do $$
declare
  n int;
  v_bad text;
begin
  -- 12.1 catalog.listings đủ cột để ghi
  select count(*) into n from information_schema.columns
   where table_schema = 'catalog' and table_name = 'listings'
     and column_name in ('issues','buyable','discoverable','product_type','quantity',
                         'stranded_reason','issue_errors','issue_warnings',
                         'enforcement_actions','last_source','last_synced_at');
  if n <> 11 then
    raise exception '[0016] FAIL: catalog.listings thiếu cột (có %/11)', n;
  end if;

  -- 12.2 catalog.cost_inputs đủ cột vết
  select count(*) into n from information_schema.columns
   where table_schema = 'catalog' and table_name = 'cost_inputs'
     and column_name in ('updated_at','updated_by','source_ref');
  if n <> 3 then
    raise exception '[0016] FAIL: catalog.cost_inputs thiếu cột vết (có %/3)', n;
  end if;

  -- 12.3 view công khai
  select count(*) into n from information_schema.views
   where table_schema = 'public'
     and table_name in ('vexim_listings','vexim_listing_queue','vexim_pricing',
                        'vexim_cost_inputs','vexim_cost_coverage','vexim_shops');
  if n <> 6 then
    raise exception '[0016] FAIL: chỉ thấy %/6 view public', n;
  end if;

  -- 12.4 vexim_pricing PHẢI có cột giá vốn + giá sàn + biên
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'vexim_pricing'
     and column_name in ('unit_cost','cost_currency','cost_effective_from','floor_price',
                         'gross_profit','margin_pct','below_floor','cost_basis',
                         'referral_rate_used','min_margin_rate');
  if n <> 10 then
    raise exception '[0016] FAIL: vexim_pricing thiếu cột giá vốn/giá sàn (có %/10)', n;
  end if;

  -- 12.5 vexim_listings phải phơi cột mới cho L1/L2/L4
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'vexim_listings'
     and column_name in ('product_type','buyable','discoverable','quantity',
                         'stranded_reason','enforcement_actions','last_source','last_synced_at');
  if n <> 8 then
    raise exception '[0016] FAIL: vexim_listings thiếu cột mới (có %/8)', n;
  end if;

  -- 12.6 RPC
  select count(*) into n from pg_proc p
   join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and p.proname in ('vexim_worker_upsert_listings','vexim_upsert_cost_input',
                       'vexim_import_cost_inputs','vexim_close_cost_input',
                       'vexim_delete_cost_input');
  if n <> 5 then
    raise exception '[0016] FAIL: chỉ thấy %/5 RPC mới trong schema public', n;
  end if;

  -- 12.7 RPC worker phải CHỈ service_role gọi được
  select string_agg(proname, ', ') into v_bad
  from (
    select p.proname
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.proname = 'vexim_worker_upsert_listings'
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) t;
  if v_bad is not null then
    raise exception '[0016] FAIL: RPC worker vẫn mở cho authenticated: %', v_bad;
  end if;

  -- 12.8 tất cả view public mới đều security_invoker (RLS bảng gốc vẫn áp)
  select count(*) into n
  from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public'
    and c.relname in ('vexim_listings','vexim_listing_queue','vexim_pricing',
                      'vexim_cost_inputs','vexim_cost_coverage','vexim_shops')
    and 'security_invoker=true' = any (c.reloptions);
  if n <> 6 then
    raise exception '[0016] FAIL: %/6 view là security_invoker', n;
  end if;

  -- 12.9 không phơi PII / email nội bộ
  select count(*) into n from information_schema.columns
   where table_schema = 'public'
     and table_name in ('vexim_listings','vexim_listing_queue','vexim_pricing',
                        'vexim_cost_inputs','vexim_cost_coverage','vexim_shops')
     and column_name in ('buyer_name','buyer_email','buyer_phone_number','ship_address_1',
                         'recipient_name','actor_email','imported_by_email','email','seller_id');
  if n <> 0 then
    raise exception '[0016] FAIL: view phơi cột PII/email';
  end if;

  -- 12.10 cấu hình giá sàn đã seed
  select count(*) into n from catalog.pricing_defaults where id = 1;
  if n <> 1 then
    raise exception '[0016] FAIL: catalog.pricing_defaults chưa có dòng cấu hình id=1';
  end if;

  -- 12.11 hai hàm giá vốn PHẢI khớp nhau (effective_cost là wrapper)
  select count(*) into n
  from catalog.cost_inputs ci
  where catalog.effective_cost(ci.seller_account_id, ci.sku, ci.effective_from) is distinct from ci.unit_cost;
  if n > 0 then
    raise exception '[0016] FAIL: catalog.effective_cost() lệch với dữ liệu cost_inputs ở % dòng', n;
  end if;

  raise notice '[0016] XONG: listing ghi được (11 cột + RPC worker) · giá vốn nhập được (4 RPC + 2 view) · vexim_pricing dùng giá vốn hiệu lực';
end
$$;

commit;
