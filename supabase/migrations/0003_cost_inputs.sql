-- ============================================================================
-- VEXIM OPS — MIGRATION 0003: GIÁ VỐN THEO KHOẢNG THỜI GIAN HIỆU LỰC
-- Theo quyết định #4 ("tối ưu nhưng đầy đủ"): giá vốn nhập qua import
-- Excel/CSV hoặc form tay; lưu effective-dated vì giá vốn thay đổi theo
-- từng đợt nhập hàng — tính lãi SKU (F4) phải đúng theo thời điểm.
-- Chạy sau 0001_init.sql và 0002_task_workflows.sql
-- ============================================================================

-- btree_gist: cần cho ràng buộc EXCLUDE trên cost_inputs (so sánh = của
-- uuid/text nằm trong index GIST) — Supabase hỗ trợ sẵn extension này
create extension if not exists btree_gist;

create table catalog.cost_inputs (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  sku               text not null,
  unit_cost         numeric(12,4) not null check (unit_cost >= 0),
  currency          text not null default 'USD',
  effective_from    date not null,
  effective_to      date,                             -- null = hiện hành
  source            text not null default 'csv',      -- csv | manual | api
  imported_by       uuid references iam.user_profiles(id),
  note              text,
  created_at        timestamptz not null default now(),
  -- một SKU chỉ có 1 giá vốn hiệu lực tại một thời điểm
  exclude using gist (
    seller_account_id with =, sku with =,
    daterange(effective_from, effective_to, '[)') with &&
  )
);

-- hàm tra giá vốn hiệu lực tại thời điểm t (dùng cho F4 lợi nhuận SKU)
create or replace function catalog.effective_cost(
  p_seller uuid, p_sku text, p_on date default current_date)
returns numeric
language sql stable security definer
set search_path = catalog
as $$
  select unit_cost from catalog.cost_inputs
  where seller_account_id = p_seller and sku = p_sku
    and effective_from <= p_on
    and (effective_to is null or effective_to > p_on)
  order by effective_from desc limit 1;
$$;

-- index phục vụ tra cứu + RLS (đọc theo shop như các bảng nghiệp vụ)
create index idx_cost_inputs_sku on catalog.cost_inputs (seller_account_id, sku, effective_from desc);

alter table catalog.cost_inputs enable row level security;
create policy rls_read_cost_inputs on catalog.cost_inputs
  for select using (iam.can_read_seller_account(seller_account_id));
create policy rls_write_cost_inputs on catalog.cost_inputs
  for all to authenticated using (iam.can_write_seller_account(seller_account_id))
  with check (iam.can_write_seller_account(seller_account_id));

grant select on catalog.cost_inputs to authenticated;
grant all on catalog.cost_inputs to service_role;
