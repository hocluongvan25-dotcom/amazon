-- ============================================================================
-- VEXIM OPS — MIGRATION 0001: KHỞI TẠO NỀN TẢNG DỮ LIỆU (Tier 0)
-- Đích: Supabase (PostgreSQL 15+). Chạy qua Supabase SQL Editor hoặc CLI:
--   supabase db push   /   supabase migration up
--
-- Nội dung: 8 schema · bảng nghiệp vụ · enum · RLS multi-tenant · seed
-- Theo thiết kế mục 5 tài liệu docs/de-xuat-trien-khai-he-thong-vexim.md
-- Lưu ý v1.1: KHÔNG có bảng nào chứa PII người mua (đã defer role restricted)
-- ============================================================================

create extension if not exists pgcrypto;

-- ============================================================================
-- 1. SCHEMAS
-- ============================================================================
create schema if not exists iam;          -- định danh & phân quyền
create schema if not exists connections;  -- kết nối Amazon & đồng bộ
create schema if not exists catalog;      -- sản phẩm & listing
create schema if not exists sales;        -- đơn hàng & CSKH
create schema if not exists inventory;    -- tồn kho & FBA inbound
create schema if not exists ads;          -- quảng cáo
create schema if not exists finance;      -- tài chính & đối soát
create schema if not exists ops;          -- vận hành: KPI, cảnh báo, tác vụ

-- ============================================================================
-- 2. ENUMS
-- ============================================================================
create type iam.app_role as enum
  ('super_admin','org_admin','dept_lead','operator','analyst','client_viewer');

create type iam.department_code as enum
  ('ops_health','listing','ppc','fulfillment','orders_care','finance');

create type iam.module_code as enum
  ('orders','listings','pricing','inventory','ads','finance','account_health','tasks');

create type connections.data_source as enum ('mock','sandbox','production');

create type connections.sync_status as enum ('pending','running','done','failed');

create type ops.alert_severity as enum ('red','amber','green');

create type ops.alert_status as enum ('open','ack','resolved');

create type ops.task_status as enum ('open','in_progress','blocked','done','cancelled');

-- ============================================================================
-- 3. SCHEMA iam — ĐỊNH DANH & PHÂN QUYỀN
-- ============================================================================

-- Tổ chức: VEXIM (nội bộ) + các khách hàng doanh nghiệp
create table iam.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  is_internal boolean not null default false,   -- true = chính VEXIM
  created_at  timestamptz not null default now()
);

-- Tài khoản seller Amazon (tạo TRƯỚC các bảng iam tham chiếu nó)
create table connections.seller_accounts (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references iam.organizations(id) on delete cascade,
  seller_id     text not null,              -- merchant id Amazon
  marketplace   text not null,              -- vd: 'ATVPDKIKX0DER' (US)
  display_name  text not null,
  status        text not null default 'active',   -- active | paused | revoked
  data_source   connections.data_source not null default 'mock', -- mock→sandbox→production
  health_status text,                       -- green | yellow | red (từ Seller Performance Report)
  last_sync_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique (seller_id, marketplace)
);


-- Hồ sơ người dùng (map 1-1 với Supabase auth.users)
create table iam.user_profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null,
  email         text not null,
  vexim_employee boolean not null default true,  -- false = user của khách hàng
  org_id        uuid references iam.organizations(id), -- null nếu là nhân viên VEXIM
  created_at    timestamptz not null default now()
);

-- 6 phòng ban
create table iam.departments (
  id          uuid primary key default gen_random_uuid(),
  code        iam.department_code not null unique,
  name        text not null,
  description text
);

-- Vai trò hệ thống của user (super_admin, dept_lead, ...)
create table iam.role_assignments (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references iam.user_profiles(id) on delete cascade,
  role          iam.app_role not null,
  department_id uuid references iam.departments(id),   -- cho dept_lead/operator
  created_at    timestamptz not null default now(),
  unique (user_id, role, department_id)
);

-- Gán user ↔ shop ↔ module (ai phụ trách shop nào, mảng nào, có quyền ghi không)
create table iam.assignments (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references iam.user_profiles(id) on delete cascade,
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  module            iam.module_code not null,
  can_write         boolean not null default false,
  assigned_by       uuid references iam.user_profiles(id),
  created_at        timestamptz not null default now(),
  unique (user_id, seller_account_id, module)
);

-- Audit log toàn bộ thao tác (append-only, KHÔNG có update/delete)
create table iam.audit_logs (
  id                uuid primary key default gen_random_uuid(),
  actor_id          uuid references iam.user_profiles(id),
  seller_account_id uuid references connections.seller_accounts(id) on delete cascade,
  module            iam.module_code,
  action            text not null,          -- vd: 'price.update', 'listing.patch'
  entity            text,                   -- vd: 'SKU-ABC123'
  before_value      jsonb,
  after_value       jsonb,
  result            text,                   -- 'ok' | 'error: ...'
  created_at        timestamptz not null default now()
);

-- ============================================================================
-- 4. SCHEMA connections — KẾT NỐI AMAZON & ĐỒNG BỘ
-- ============================================================================

-- LWA refresh token (MÃ HÓA — production dùng Supabase Vault; KHÔNG bao giờ select từ client)
create table connections.oauth_tokens (
  id                      uuid primary key default gen_random_uuid(),
  seller_account_id       uuid not null unique references connections.seller_accounts(id) on delete cascade,
  encrypted_refresh_token text not null,    -- pgencrypt / Vault secret reference
  authorized_at           timestamptz not null default now(),
  expires_at              timestamptz not null,   -- LWA refresh token: 1 năm
  rotate_reminder_sent    boolean not null default false
);

-- Hàng đợi đồng bộ (worker dùng; service role ghi, người đọc)
create table connections.sync_jobs (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  job_type          text not null,           -- 'orders.pull', 'report.request', ...
  payload           jsonb,
  status            connections.sync_status not null default 'pending',
  attempts          int not null default 0,
  last_error        text,
  started_at        timestamptz,
  finished_at       timestamptz,
  created_at        timestamptz not null default now()
);

-- Raw notifications từ Amazon (EventBridge/SQS) — giữ nguyên payload để replay
create table connections.notifications_log (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid references connections.seller_accounts(id) on delete cascade,
  notification_type text not null,           -- ORDER_CHANGE, ANY_OFFER_CHANGED, ...
  raw               jsonb not null,
  received_at       timestamptz not null default now(),
  processed_at      timestamptz
);

-- Mức dùng API theo ngày (kiểm soát chi phí SP-API 2026)
create table connections.api_usage_daily (
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  day               date not null,
  api_group         text not null,           -- 'orders', 'reports', 'pricing', ...
  calls             int not null default 0,
  primary key (seller_account_id, day, api_group)
);

-- ============================================================================
-- 5. SCHEMA catalog — SẢN PHẨM & LISTING
-- ============================================================================
create table catalog.listings (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  sku               text not null,
  asin              text,
  title             text,
  status            text not null default 'active',  -- active | inactive | stranded | removed
  issues            jsonb,                             -- listings issues từ Amazon
  price             numeric(12,2),
  currency          text not null default 'USD',
  updated_at        timestamptz not null default now(),
  unique (seller_account_id, sku)
);

create table catalog.listing_offers (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  sku               text not null,
  buy_box_won       boolean,
  buy_box_price     numeric(12,2),
  competitor_price  numeric(12,2),
  captured_at       timestamptz not null default now()
);

create table catalog.fees_estimates (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  sku               text not null,
  referral_fee      numeric(12,2),
  fba_fee           numeric(12,2),
  total_fee         numeric(12,2),
  currency          text not null default 'USD',
  estimated_at      timestamptz not null default now()
);

-- ============================================================================
-- 6. SCHEMA sales — ĐƠN HÀNG & CSKH (không PII theo v1.1)
-- ============================================================================
create table sales.orders (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  amazon_order_id   text not null,
  status            text not null,             -- Pending, Shipped, Cancelled...
  channel           text,                      -- AFN (FBA) | MFN (FBM)
  purchase_date     timestamptz not null,
  order_total       numeric(12,2),
  currency          text not null default 'USD',
  items_count       int default 0,
  raw               jsonb,                     -- giữ nguyên phản hồi API/report
  updated_at        timestamptz not null default now(),
  unique (seller_account_id, amazon_order_id)
);

create table sales.order_items (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references sales.orders(id) on delete cascade,
  asin        text,
  sku         text,
  quantity    int not null default 1,
  item_price  numeric(12,2)
);

create table sales.returns_refunds (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  amazon_order_id   text,
  return_date       timestamptz not null,
  reason            text,
  status            text,
  refund_amount     numeric(12,2),
  currency          text not null default 'USD'
);

-- Log tin nhắn người mua (NỘI BỘ — SP-API không đọc được hộp thư, v1.1)
create table sales.buyer_messages (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  channel           text not null default 'email_log',   -- nguồn: email log / nhập tay
  subject           text,
  received_at       timestamptz not null,
  answered_at       timestamptz,
  handler_id        uuid references iam.user_profiles(id)
);

-- ============================================================================
-- 7. SCHEMA inventory — TỒN KHO & FBA INBOUND
-- ============================================================================
create table inventory.inventory_snapshots (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  sku               text not null,
  asin              text,
  fulfillable       int not null default 0,
  reserved          int not null default 0,
  inbound           int not null default 0,
  captured_at       timestamptz not null default now()
);

-- Snapshot chốt mỗi ngày — dashboard đọc bảng này (load nhanh)
create table inventory.inventory_daily (
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  day               date not null,
  sku               text not null,
  units             int not null default 0,
  days_of_cover     numeric(6,1),
  in_stock          boolean not null default true,
  primary key (seller_account_id, day, sku)
);

create table inventory.inbound_shipments (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  shipment_id       text not null,
  status            text,                      -- WORKING | SHIPPED | RECEIVING | CLOSED...
  quantity          int,
  eta_date          date,
  created_at        timestamptz not null default now(),
  unique (seller_account_id, shipment_id)
);

-- ============================================================================
-- 8. SCHEMA ads — QUẢNG CÁO (Amazon Ads API)
-- ============================================================================
create table ads.ad_profiles (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  ads_profile_id    text not null,
  marketplace       text not null,
  currency          text not null default 'USD',
  unique (seller_account_id, ads_profile_id)
);

create table ads.campaigns (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  ads_profile_id    text not null,
  campaign_id       text not null,
  campaign_type     text not null,             -- sp | sb | sd
  name              text not null,
  state             text not null default 'ENABLED',
  daily_budget      numeric(10,2),
  unique (seller_account_id, campaign_id)
);

create table ads.ad_metrics_daily (
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  day               date not null,
  campaign_id       text not null,
  impressions       int not null default 0,
  clicks            int not null default 0,
  spend             numeric(10,2) not null default 0,
  sales             numeric(12,2) not null default 0,
  orders            int not null default 0,
  primary key (seller_account_id, day, campaign_id)
);

create table ads.search_terms (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  day               date not null,
  term              text not null,
  match_type        text,
  impressions       int default 0,
  clicks            int default 0,
  spend             numeric(10,2) default 0,
  sales             numeric(12,2) default 0
);

-- ============================================================================
-- 9. SCHEMA finance — TÀI CHÍNH & ĐỐI SOÁT (append-only cho dòng tiền)
-- ============================================================================
create table finance.settlements (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  settlement_id     text not null,
  period_start      date not null,
  period_end        date not null,
  total_amount      numeric(12,2),
  currency          text not null default 'USD',
  posted_at         timestamptz,
  unique (seller_account_id, settlement_id)
);

create table finance.financial_events (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  settlement_id     text,
  event_type        text not null,             -- Charge | Refund | ServiceFee | Adjustment...
  event_date        timestamptz not null,
  amount            numeric(12,2) not null,
  currency          text not null default 'USD',
  raw               jsonb
);

create table finance.reimbursements (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  case_id           text,
  reimbursement_type text,                     -- Lost | Damaged | Lost_Inbound ...
  amount            numeric(12,2),
  currency          text not null default 'USD',
  status            text not null default 'to_claim',   -- to_claim | filed | approved | rejected
  opened_at         timestamptz,
  resolved_at       timestamptz
);

-- ============================================================================
-- 10. SCHEMA ops — KPI, CẢNH BÁO, TÁC VỤ, BÁO CÁO
-- ============================================================================

-- Snapshot KPI mỗi ngày mỗi shop — dashboard chỉ đọc bảng này
create table ops.kpi_daily (
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  day               date not null,
  metrics           jsonb not null,
  -- vd metrics: {"revenue":12480,"units":341,"sessions":8200,"cr":4.2,
  --             "spend":862,"acos":18.2,"tacos":6.9,"buybox_pct":93,"odr":0.8}
  primary key (seller_account_id, day)
);

create table ops.alert_rules (
  id          uuid primary key default gen_random_uuid(),
  rule_code   text not null unique,
  module      iam.module_code not null,
  description text not null,
  threshold   numeric(12,2),
  comparator  text,                            -- lt | gt | lte | gte | ne
  severity    ops.alert_severity not null default 'amber',
  is_active   boolean not null default true
);

create table ops.alerts (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  rule_id           uuid references ops.alert_rules(id),
  severity          ops.alert_severity not null,
  title             text not null,
  detail            text,
  status            ops.alert_status not null default 'open',
  assigned_to       uuid references iam.user_profiles(id),
  fired_at          timestamptz not null default now(),
  resolved_at       timestamptz
);

create table ops.tasks (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  department_id     uuid references iam.departments(id),
  title             text not null,
  description       text,
  status            ops.task_status not null default 'open',
  due_at            timestamptz,
  assignee_id       uuid references iam.user_profiles(id),
  created_by        uuid references iam.user_profiles(id),
  created_at        timestamptz not null default now()
);

create table ops.client_reports (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references iam.organizations(id) on delete cascade,
  period       text not null,                  -- '2026-W37', '2026-09'
  report_type  text not null default 'weekly',
  generated_at timestamptz not null default now(),
  storage_path text                            -- đường dẫn file trên Supabase Storage
);

-- ============================================================================
-- 11. INDEX phục vụ dashboard
-- ============================================================================
create index idx_orders_purchase    on sales.orders (seller_account_id, purchase_date desc);
create index idx_alerts_open        on ops.alerts (seller_account_id, status) where status = 'open';
create index idx_tasks_due          on ops.tasks (due_at) where status in ('open','in_progress');
create index idx_sync_jobs_pending  on connections.sync_jobs (status) where status in ('pending','running');
create index idx_metrics_campaign   on ads.ad_metrics_daily (seller_account_id, day desc);
create index idx_notifications_unproc on connections.notifications_log (received_at) where processed_at is null;

-- ============================================================================
-- 12. RLS — MULTI-TENANT BẰNG ROW LEVEL SECURITY
-- ============================================================================
-- Mô hình quyền:
--   super_admin  : toàn hệ thống
--   org_admin / client_viewer : mọi shop thuộc org của mình
--   dept_lead / operator / analyst : chỉ shop được gán qua iam.assignments
-- Ghi dữ liệu: worker dùng service_role (bypass RLS) — người dùng chỉ ghi ops.*

-- Hàm đọc: user hiện tại có được đọc shop này không?
create or replace function iam.can_read_seller_account(p_seller uuid)
returns boolean
language sql stable security definer
set search_path = iam, connections
as $$
  select exists (select 1 from iam.role_assignments ra
                 where ra.user_id = auth.uid() and ra.role = 'super_admin')
  or exists (select 1 from connections.seller_accounts sa
             join iam.user_profiles up on up.id = auth.uid()
             where sa.id = p_seller and up.org_id = sa.org_id)
  or exists (select 1 from iam.assignments a
             where a.user_id = auth.uid() and a.seller_account_id = p_seller);
$$;

-- Hàm ghi (thao tác vận hành trên shop): cần assignment có can_write
create or replace function iam.can_write_seller_account(p_seller uuid)
returns boolean
language sql stable security definer
set search_path = iam
as $$
  select exists (select 1 from iam.role_assignments ra
                 where ra.user_id = auth.uid() and ra.role = 'super_admin')
  or exists (select 1 from iam.assignments a
             where a.user_id = auth.uid() and a.seller_account_id = p_seller
               and a.can_write = true);
$$;

-- 12.1 Bật RLS toàn bộ
alter table iam.organizations      enable row level security;
alter table iam.user_profiles      enable row level security;
alter table iam.departments        enable row level security;
alter table iam.role_assignments   enable row level security;
alter table iam.assignments        enable row level security;
alter table iam.audit_logs         enable row level security;
alter table connections.seller_accounts enable row level security;
alter table connections.oauth_tokens    enable row level security;
alter table connections.sync_jobs       enable row level security;
alter table connections.notifications_log enable row level security;
alter table connections.api_usage_daily enable row level security;
alter table catalog.listings       enable row level security;
alter table catalog.listing_offers enable row level security;
alter table catalog.fees_estimates enable row level security;
alter table sales.orders           enable row level security;
alter table sales.order_items      enable row level security;
alter table sales.returns_refunds  enable row level security;
alter table sales.buyer_messages   enable row level security;
alter table inventory.inventory_snapshots enable row level security;
alter table inventory.inventory_daily     enable row level security;
alter table inventory.inbound_shipments   enable row level security;
alter table ads.ad_profiles        enable row level security;
alter table ads.campaigns          enable row level security;
alter table ads.ad_metrics_daily   enable row level security;
alter table ads.search_terms       enable row level security;
alter table finance.settlements    enable row level security;
alter table finance.financial_events enable row level security;
alter table finance.reimbursements  enable row level security;
alter table ops.kpi_daily          enable row level security;
alter table ops.alert_rules        enable row level security;
alter table ops.alerts             enable row level security;
alter table ops.tasks              enable row level security;
alter table ops.client_reports     enable row level security;

-- 12.2 Policy SELECT tự động cho mọi bảng có cột seller_account_id
--     (trừ oauth_tokens — cấm mọi truy cập từ client)
do $$
declare t record;
begin
  for t in
    select c.table_schema, c.table_name
    from information_schema.columns c
    join information_schema.tables tb
      on tb.table_schema = c.table_schema and tb.table_name = c.table_name
    where c.column_name = 'seller_account_id'
      and tb.table_type = 'BASE TABLE'
      and c.table_schema in ('connections','catalog','sales','inventory','ads','finance','ops')
      and c.table_schema || '.' || c.table_name not in ('connections.oauth_tokens')
  loop
    execute format(
      'create policy %I on %I.%I for select using (iam.can_read_seller_account(seller_account_id))',
      'rls_read_' || t.table_name, t.table_schema, t.table_name
    );
  end loop;
end $$;

-- 12.3 Các policy riêng
-- Bảng neo: seller_accounts (id chính là seller_account_id)
create policy rls_read_seller_accounts on connections.seller_accounts
  for select using (iam.can_read_seller_account(id));

-- order_items: đi qua đơn hàng cha
create policy rls_read_order_items on sales.order_items
  for select using (
    exists (select 1 from sales.orders o
            where o.id = order_items.order_id
              and iam.can_read_seller_account(o.seller_account_id))
  );

-- oauth_tokens: KHÔNG có policy nào — chỉ service_role (bypass RLS) đọc được

-- Cấu hình toàn cục: đọc cho user đã đăng nhập, ghi cho super_admin
create policy rls_read_organizations on iam.organizations
  for select to authenticated using (true);
create policy rls_read_departments on iam.departments
  for select to authenticated using (true);
create policy rls_read_alert_rules on ops.alert_rules
  for select to authenticated using (true);
create policy rls_write_alert_rules_super on ops.alert_rules
  for all to authenticated using (
    exists (select 1 from iam.role_assignments ra
            where ra.user_id = auth.uid() and ra.role = 'super_admin')
  ) with check (
    exists (select 1 from iam.role_assignments ra
            where ra.user_id = auth.uid() and ra.role = 'super_admin')
  );

-- Hồ sơ cá nhân: đọc chính mình; super_admin đọc tất cả
create policy rls_read_user_profiles_self on iam.user_profiles
  for select using (
    id = auth.uid()
    or exists (select 1 from iam.role_assignments ra
               where ra.user_id = auth.uid() and ra.role = 'super_admin')
  );

-- Phân quyền: mỗi user thấy assignment của mình; super_admin quản toàn bộ
create policy rls_read_assignments on iam.assignments
  for select using (
    user_id = auth.uid()
    or exists (select 1 from iam.role_assignments ra
               where ra.user_id = auth.uid() and ra.role = 'super_admin')
  );
create policy rls_write_assignments_super on iam.assignments
  for all using (
    exists (select 1 from iam.role_assignments ra
            where ra.user_id = auth.uid() and ra.role = 'super_admin')
  ) with check (
    exists (select 1 from iam.role_assignments ra
            where ra.user_id = auth.uid() and ra.role = 'super_admin')
  );

create policy rls_read_role_assignments on iam.role_assignments
  for select using (
    user_id = auth.uid()
    or exists (select 1 from iam.role_assignments ra2
               where ra2.user_id = auth.uid() and ra2.role = 'super_admin')
  );

-- Tác vụ & cảnh báo: đọc theo shop (đã có policy tự động), ghi cho ai được gán shop
create policy rls_ins_tasks on ops.tasks for insert to authenticated
  with check (iam.can_write_seller_account(seller_account_id));
create policy rls_upd_tasks on ops.tasks for update to authenticated
  using (iam.can_write_seller_account(seller_account_id));
create policy rls_upd_alerts on ops.alerts for update to authenticated
  using (iam.can_read_seller_account(seller_account_id));

-- Audit log: ai cũng ghi được (server kiểm soát); đọc theo shop (policy riêng —
-- iam nằm ngoài vòng lặp tự động vốn chỉ phủ 7 schema nghiệp vụ)
create policy rls_read_audit_logs on iam.audit_logs
  for select using (iam.can_read_seller_account(seller_account_id));
create policy rls_ins_audit on iam.audit_logs for insert to authenticated
  with check (true);

-- Báo cáo khách hàng: theo org
create policy rls_read_client_reports on ops.client_reports
  for select using (
    exists (select 1 from iam.user_profiles up
            where up.id = auth.uid() and up.org_id = client_reports.org_id)
    or exists (select 1 from iam.role_assignments ra
               where ra.user_id = auth.uid() and ra.role = 'super_admin')
  );

-- 12.4 Cấm update/delete dữ liệu tài chính & audit (append-only)
revoke update, delete on finance.financial_events from authenticated, anon;
revoke update, delete on iam.audit_logs from authenticated, anon;

-- ============================================================================
-- 13. GRANTS
-- ============================================================================
grant usage on schema iam, connections, catalog, sales, inventory, ads, finance, ops
  to authenticated, service_role;
grant select on all tables in schema iam, connections, catalog, sales, inventory, ads, finance, ops
  to authenticated;
grant insert, update on ops.tasks, ops.alerts, iam.audit_logs to authenticated;
grant all on all tables in schema iam, connections, catalog, sales, inventory, ads, finance, ops
  to service_role;   -- worker đồng bộ dùng service key (bypass RLS)
alter default privileges in schema iam, connections, catalog, sales, inventory, ads, finance, ops
  grant select on tables to authenticated;

-- ============================================================================
-- 14. SEED — DỮ LIỆU GỐC
-- ============================================================================
insert into iam.departments (code, name, description) values
  ('ops_health',  'Vận hành & Account Health', 'Kết nối shop, sức khỏe tài khoản, điều phối tác vụ'),
  ('listing',     'Listing & Nội dung',        'Tạo/sửa listing, tối ưu SEO/A+, xử lý listing lỗi'),
  ('ppc',         'Quảng cáo (PPC)',           'Campaign, budget/bid, tối ưu ACOS/TACOS'),
  ('fulfillment', 'Kho vận & FBA',             'Dự báo tồn kho, nhập hàng, inbound shipment'),
  ('orders_care', 'Đơn hàng & CSKH',           'Đơn FBM, tin nhắn người mua, returns/refunds'),
  ('finance',     'Tài chính & Đối soát',      'Settlement, phí, bồi hoàn, lợi nhuận SKU');

insert into iam.organizations (name, slug, is_internal) values
  ('VEXIM', 'vexim', true);

-- Bộ luật cảnh báo mặc định (VEXIM chỉnh được sau)
insert into ops.alert_rules (rule_code, module, description, threshold, comparator, severity) values
  ('stockout_risk',    'inventory',     'SKU sắp hết hàng (days of cover dưới ngưỡng)',      14,    'lt',  'red'),
  ('buybox_lost',      'pricing',       'SKU mất Featured Offer (Buy Box)',                  1,     'lt',  'red'),
  ('listing_inactive', 'listings',      'Listing chuyển sang inactive/stranded',             1,     'gt',  'amber'),
  ('acos_over_target', 'ads',           'ACOS 7 ngày vượt ngưỡng mục tiêu (%)',              25,    'gt',  'amber'),
  ('budget_exhausted', 'ads',           'Campaign hết budget trước 18h',                    null,  null,  'amber'),
  ('account_health',   'account_health','Trạng thái tài khoản không xanh (khỏe)',            null,  null,  'red'),
  ('message_aging',    'orders',        'Tin nhắn người mua chưa trả lời gần 24h',           20,    'gt',  'amber'),
  ('odr_threshold',    'account_health','ODR vượt ngưỡng an toàn (%)',                       1,     'gt',  'red');

-- ============================================================================
-- 15. GHI CHÚ TRIỂN KHAI
-- ============================================================================
-- 1. Access token LWA khi đưa lên production: thay bảng oauth_tokens bằng
--    Supabase Vault (ext. supabase_vault) — chỉ service_role mở được.
-- 2. pg_cron: bật extension rồi tạo job chốt kpi_daily lúc 6h sáng & đối soát 2h sáng.
-- 3. Realtime: bật cho ops.alerts & ops.tasks để đẩy cảnh báo tức thời ra UI.
-- 4. Bảng raw jsonb giữ tối thiểu 90 ngày rồi purge theo chính sách retention.
