-- ============================================================================
-- VEXIM OPS — MIGRATION 0002: TASK WORKFLOW THEO LUỒNG VẬN HÀNH CHUẨN (SOP)
-- Bổ sung theo phản hồi VEXIM: tác vụ phải chạy theo LUỒNG CHI TIẾT từng bước,
-- không chỉ tổng quan. Định nghĩa 12 SOP: docs/luong-van-hanh-chuan.md
-- Chạy sau 0001_init.sql
-- ============================================================================

-- 1. Template SOP (kèm bước dạng JSONB)
create table ops.task_templates (
  id            uuid primary key default gen_random_uuid(),
  sop_code      text not null unique,            -- 'SOP-01'
  name          text not null,
  department_id uuid references iam.departments(id),
  trigger_rule  text references ops.alert_rules(rule_code),  -- alert sinh task
  sla_hours     int,
  steps         jsonb not null,
  -- steps: [{"n":1,"name":"Xác nhận tốc độ bán 14 ngày","who":"Kho vận",
  --          "data":"Sales & Traffic Report"}]
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

-- 2. Task gắn với template + bước hiện tại
alter table ops.tasks
  add column template_id uuid references ops.task_templates(id),
  add column current_step int not null default 1;

-- 3. Audit từng bước (append-only)
create table ops.task_events (
  id                uuid primary key default gen_random_uuid(),
  task_id           uuid not null references ops.tasks(id) on delete cascade,
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  step              int,
  event             text not null,     -- 'step_done' | 'assigned' | 'note' | 'escalated' | 'reopened'
  actor_id          uuid references iam.user_profiles(id),
  detail            text,
  created_at        timestamptz not null default now()
);

create index idx_task_events_task on ops.task_events (task_id, created_at);
create index idx_tasks_template on ops.tasks (template_id) where status in ('open','in_progress');

-- 4. RLS
alter table ops.task_templates enable row level security;
alter table ops.task_events    enable row level security;

-- Template: mọi user đã đăng nhập đọc được (chỉ nội bộ VEXIM dùng)
create policy rls_read_task_templates on ops.task_templates
  for select to authenticated using (true);
create policy rls_write_task_templates_super on ops.task_templates
  for all to authenticated using (
    exists (select 1 from iam.role_assignments ra
            where ra.user_id = auth.uid() and ra.role = 'super_admin')
  ) with check (
    exists (select 1 from iam.role_assignments ra
            where ra.user_id = auth.uid() and ra.role = 'super_admin')
  );

-- Event: đọc theo shop (tự động theo cột seller_account_id), chỉ insert qua server
create policy rls_read_task_events on ops.task_events
  for select using (iam.can_read_seller_account(seller_account_id));
create policy rls_ins_task_events on ops.task_events
  for insert to authenticated
  with check (iam.can_read_seller_account(seller_account_id));
revoke update, delete on ops.task_events from authenticated, anon;

grant select on ops.task_templates, ops.task_events to authenticated;
grant all on ops.task_templates, ops.task_events to service_role;

-- 5. Seed: 2 template mẫu (đủ nhóm khác nhau để duyệt cấu trúc; 10 SOP còn lại
--    seed sau khi VEXIM duyệt chi tiết docs/luong-van-hanh-chuan.md)
insert into ops.task_templates (sop_code, name, department_id, trigger_rule, sla_hours, steps)
select 'SOP-01', 'Xử lý SKU sắp hết hàng',
       (select id from iam.departments where code = 'fulfillment'),
       'stockout_risk', 24,
  '[{"n":1,"name":"Xác nhận tốc độ bán 14 ngày","who":"Kho vận","data":"Sales & Traffic Report"},
    {"n":2,"name":"Kiểm tra lô hàng đang về + ETA","who":"Kho vận","data":"FBA Inbound"},
    {"n":3,"name":"Tính đề xuất nhập","who":"Hệ thống","data":"velocity × (lead time + safety) − tồn − đang về"},
    {"n":4,"name":"Chốt số lượng + giá vốn với khách hàng","who":"Kho vận + Khách hàng","data":"task client"},
    {"n":5,"name":"Trưởng phòng duyệt lô > ngưỡng","who":"Trưởng phòng Kho vận","data":"màn duyệt"},
    {"n":6,"name":"Tạo inbound shipment","who":"Hệ thống → Amazon","data":"Fulfillment Inbound API"},
    {"n":7,"name":"Theo dõi nhận hàng tại FC","who":"Kho vận","data":"inbound status"},
    {"n":8,"name":"Đối soát số nhận vs kế hoạch","who":"Kho vận + Tài chính","data":"thiếu → SOP-09"}]'::jsonb
where not exists (select 1 from ops.task_templates where sop_code = 'SOP-01');

insert into ops.task_templates (sop_code, name, department_id, trigger_rule, sla_hours, steps)
select 'SOP-04', 'Tối ưu campaign ACOS vượt ngưỡng',
       (select id from iam.departments where code = 'ppc'),
       'acos_over_target', 24,
  '[{"n":1,"name":"Xác nhận vượt ngưỡng ≥3 ngày","who":"Hệ thống","data":"Ads metrics 7/14 ngày"},
    {"n":2,"name":"Phân rã campaign → ad group → keyword","who":"PPC","data":"Ads API"},
    {"n":3,"name":"Đọc search term report","who":"PPC","data":"Reporting v3"},
    {"n":4,"name":"Duyệt gợi ý negative/bid/budget","who":"PPC (operator)","data":"gợi ý của hệ thống"},
    {"n":5,"name":"Áp dụng lên Amazon","who":"Hệ thống","data":"Ads API"},
    {"n":6,"name":"Theo dõi 3–7 ngày","who":"PPC","data":"metrics"},
    {"n":7,"name":"Chốt kết quả + ngưỡng học được","who":"PPC","data":"kpi_daily"}]'::jsonb
where not exists (select 1 from ops.task_templates where sop_code = 'SOP-04');
