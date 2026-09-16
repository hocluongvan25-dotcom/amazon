-- ============================================================================
-- 0025 — MODULE 8: PRODUCT RESEARCH & THẨM ĐỊNH R&D (GIAI ĐOẠN 1 — TÀI CHÍNH)
-- ============================================================================
-- TÀI LIỆU: docs/ke-hoach-module-8-tham-dinh-rnd-san-pham.md
--
-- PHẠM VI GIAI ĐOẠN 1 (chạy được NGAY, chưa cần Rainforest/LLM):
--   • research.assessments      — hồ sơ thẩm định ngách (1 dòng = 1 báo cáo)
--   • research.assessment_inputs — giả định đầu vào, LƯU VERSION (như cost_inputs)
--   • research.pnl_snapshots    — kết quả engine tài chính (P&L 3 kịch bản…)
--   • research.scorecards       — điểm 5 trụ (G1 mới có finance + logistics)
--   • research.veto_flags       — cờ phủ định cứng (KHÔNG có thao tác "gỡ cờ")
--   • research.roadmap          — lô test, ngân sách ads, mức lỗ tối đa
--   • research.collection_runs  — sẵn cho G2 (nhật ký quét Rainforest/SP-API)
--
-- NGUYÊN TẮC (kế thừa 0015–0022):
--   • Dữ liệu ngách KHÔNG thuộc seller account nào → khoá theo org_id (như
--     ops.client_reports), KHÔNG theo seller_account_id.
--   • Web ghi DUY NHẤT qua RPC public.vexim_research_create_assessment bằng
--     phiên đăng nhập; các bảng research.* chỉ cấp SELECT cho authenticated.
--   • Nhân viên VEXIM (analyst/dept_lead/admin) tạo báo cáo cho org khách;
--     khách (client_viewer) chỉ đọc được hồ sơ của org mình.
--   • Mọi con số engine tính ở web rồi gửi kèm (engine thuần TypeScript có
--     test); DB là lớp lưu trữ + phân quyền + audit, không tính lại tài chính.
--   • Veto KHÔNG có cột dismiss: chuyên viên chỉ ghi acknowledgement_note.
--
-- Idempotent: create if not exists / create or replace; drop policy/trigger
-- trước khi tạo lại. Chạy SAU 0024.
-- ============================================================================

-- Thêm mã module cho audit_logs. ALTER TYPE ADD VALUE phải nằm NGOÀI
-- transaction block (Postgres không cho dùng giá trị mới trong cùng tx); giá
-- trị chỉ được tham chiếu lúc RPC chạy (sau commit) nên an toàn.
alter type iam.module_code add value if not exists 'm8_research';

begin;

create schema if not exists research;

grant usage on schema research to authenticated, service_role;

-- ============================================================================
-- 1. BẢNG HỒ SƠ THẨM ĐỊNH
-- ============================================================================
create table if not exists research.assessments (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references iam.organizations(id) on delete cascade,
  code               text not null,             -- PR-202609-0001
  title              text not null,
  marketplace        text not null default 'US',
  currency           text not null default 'USD',
  keywords           jsonb not null default '[]'::jsonb,
  seed_asin          text,
  category_node      text,
  -- collecting (G1) → drafting → in_review → approved → published → stale (TTL 30 ngày)
  status             text not null default 'collecting'
                     check (status in ('collecting','drafting','in_review','approved',
                                       'published','stale')),
  verdict            text check (verdict is null or verdict in
                     ('go_test','improve','do_not_invest','insufficient_data')),
  -- Tóm tắt engine để list không cần join toàn bộ snapshot
  overall_score      numeric(3,1),
  base_margin_pct    numeric(5,1),
  pess_margin_pct    numeric(5,1),
  size_tier          text,
  veto_count         int not null default 0,
  red_veto_count     int not null default 0,
  analyst_id         uuid references iam.user_profiles(id) on delete set null,
  approver_id        uuid references iam.user_profiles(id) on delete set null,
  data_expires_at    timestamptz not null default (now() + interval '30 days'),
  engine_version     text,
  created_by         uuid references iam.user_profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, code)
);

comment on table research.assessments is
  'Module 8: hồ sơ thẩm định rủi ro ngách sản phẩm. org-scoped (không gắn shop). TTL số liệu 30 ngày.';

-- ============================================================================
-- 2. GIẢ ĐỊNH ĐẦU VÀO (VERSIONED) — như catalog.cost_inputs, giữ lịch sử
-- ============================================================================
create table if not exists research.assessment_inputs (
  id           uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references research.assessments(id) on delete cascade,
  version      int not null default 1,
  inputs       jsonb not null,
  changed_by   uuid references iam.user_profiles(id) on delete set null,
  changed_at   timestamptz not null default now(),
  unique (assessment_id, version)
);

-- ============================================================================
-- 3. SNAPSHOT TÀI CHÍNH (engine TypeScript tính, DB lưu để tái lập báo cáo)
-- ============================================================================
create table if not exists research.pnl_snapshots (
  assessment_id   uuid primary key references research.assessments(id) on delete cascade,
  inputs_version  int not null default 1,
  result          jsonb not null,
  fee_table_version text,
  computed_at     timestamptz not null default now()
);

-- ============================================================================
-- 4. SCORECARD 5 TRỤ — score NULL = "chưa đủ cơ sở" (G1: G2–G4 mới điền)
-- ============================================================================
create table if not exists research.scorecards (
  assessment_id uuid not null references research.assessments(id) on delete cascade,
  pillar        text not null check (pillar in
                ('finance','competition','demand','differentiation','logistics')),
  weight        numeric(4,3) not null,
  score         numeric(3,1) check (score is null or (score between 1 and 10)),
  confidence    text check (confidence is null or confidence in ('high','medium','low')),
  reason        text not null default '',
  metrics       jsonb,
  computed_at   timestamptz not null default now(),
  primary key (assessment_id, pillar)
);

-- ============================================================================
-- 5. VETO FLAGS — phủ định cứng; chỉ ghi nhận (acknowledge), KHÔNG gỡ
-- ============================================================================
create table if not exists research.veto_flags (
  id                   uuid primary key default gen_random_uuid(),
  assessment_id        uuid not null references research.assessments(id) on delete cascade,
  rule_code            text not null check (rule_code in
                       ('margin_below_20','cr3_above_65','amazon1p_top3','cert_barrier','oversize')),
  severity             text not null check (severity in ('red','warning')),
  title                text not null,
  detail               text not null default '',
  evidence             jsonb,
  acknowledged_by      uuid references iam.user_profiles(id) on delete set null,
  acknowledged_note    text,
  acknowledged_at      timestamptz,
  created_at           timestamptz not null default now()
);

create index if not exists idx_research_veto_assessment
  on research.veto_flags (assessment_id, severity);

-- ============================================================================
-- 6. ROADMAP VALIDATE (lô test / ads / mức lỗ tối đa)
-- ============================================================================
create table if not exists research.roadmap (
  assessment_id        uuid primary key references research.assessments(id) on delete cascade,
  test_order_qty       int check (test_order_qty is null or test_order_qty > 0),
  cover_days           int not null default 45,
  lot_capital          numeric(14,2),
  ads_budget_per_day   numeric(10,2),
  test_days            int not null default 45,
  ads_test_spend       numeric(12,2),
  breakeven_acos_pct   numeric(6,2),
  max_loss_amount      numeric(14,2),
  gates                jsonb not null default '[]'::jsonb,
  kill_criteria        jsonb not null default '[]'::jsonb,
  notes                jsonb not null default '[]'::jsonb,
  updated_by          uuid references iam.user_profiles(id) on delete set null,
  updated_at          timestamptz not null default now()
);

-- ============================================================================
-- 7. COLLECTION RUNS — sẵn sàng cho G2 (Rainforest search/offers/sales/reviews)
-- ============================================================================
create table if not exists research.collection_runs (
  id              uuid primary key default gen_random_uuid(),
  assessment_id   uuid references research.assessments(id) on delete cascade,
  kind            text not null check (kind in
                  ('serp','products','offers','sales','reviews','fees','llm')),
  status          text not null default 'queued'
                  check (status in ('queued','running','done','no_data','failed')),
  provider        text not null default 'rainforest',
  external_id     text,                   -- collection id của Rainforest
  params          jsonb not null default '{}'::jsonb,
  credits_used    int not null default 0,
  raw             jsonb,                   -- payload thô để replay (không sửa UI)
  error           text,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists idx_research_runs_assessment
  on research.collection_runs (assessment_id, created_at desc);

-- ============================================================================
-- 8. updated_at TỰ ĐỘNG
-- ============================================================================
create or replace function research.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_research_assessments_touch on research.assessments;
create trigger trg_research_assessments_touch
  before update on research.assessments
  for each row execute function research.touch_updated_at();

-- ============================================================================
-- 9. PHÂN QUYỀN
-- ============================================================================
-- Đọc hồ sơ:
--   • super_admin: tất cả;
--   • nhân viên VEXIM (vexim_employee = true): tất cả hồ sơ (agency sản xuất);
--   • người dùng khác: cùng org_id với hồ sơ.
-- Ghi: CHỈ qua RPC (mục 10) — thu hồi write trực tiếp từ authenticated.
alter table research.assessments        enable row level security;
alter table research.assessment_inputs  enable row level security;
alter table research.pnl_snapshots      enable row level security;
alter table research.scorecards         enable row level security;
alter table research.veto_flags         enable row level security;
alter table research.roadmap            enable row level security;
alter table research.collection_runs    enable row level security;

create or replace function research.can_read_assessment(p_org uuid)
returns boolean
language sql stable security definer
set search_path = research, iam, pg_catalog
as $$
  select iam.has_role(array['super_admin'])
      or exists (
           select 1 from iam.user_profiles up
          where up.id = auth.uid()
            and (up.vexim_employee = true or up.org_id = p_org)
         );
$$;

create or replace function research.can_manage_assessment()
returns boolean
language sql stable security definer
set search_path = research, iam, pg_catalog
as $$
  -- Tạo/sửa hồ sơ thẩm định: admin hoặc vai trò nghiệp vụ nghiên cứu/điều phối.
  select iam.has_role(array['super_admin','org_admin','dept_lead','analyst']);
$$;

grant execute on function research.can_read_assessment(uuid)  to authenticated, service_role;
grant execute on function research.can_manage_assessment()   to authenticated, service_role;

drop policy if exists rls_read_research_assessments on research.assessments;
create policy rls_read_research_assessments on research.assessments
  for select using (research.can_read_assessment(org_id));

-- Bảng con: quyền theo assessment cha
drop policy if exists rls_read_research_inputs on research.assessment_inputs;
create policy rls_read_research_inputs on research.assessment_inputs
  for select using (exists (
    select 1 from research.assessments a where a.id = assessment_id
      and research.can_read_assessment(a.org_id)));

drop policy if exists rls_read_research_pnl on research.pnl_snapshots;
create policy rls_read_research_pnl on research.pnl_snapshots
  for select using (exists (
    select 1 from research.assessments a where a.id = assessment_id
      and research.can_read_assessment(a.org_id)));

drop policy if exists rls_read_research_scorecards on research.scorecards;
create policy rls_read_research_scorecards on research.scorecards
  for select using (exists (
    select 1 from research.assessments a where a.id = assessment_id
      and research.can_read_assessment(a.org_id)));

drop policy if exists rls_read_research_veto on research.veto_flags;
create policy rls_read_research_veto on research.veto_flags
  for select using (exists (
    select 1 from research.assessments a where a.id = assessment_id
      and research.can_read_assessment(a.org_id)));

drop policy if exists rls_read_research_roadmap on research.roadmap;
create policy rls_read_research_roadmap on research.roadmap
  for select using (exists (
    select 1 from research.assessments a where a.id = assessment_id
      and research.can_read_assessment(a.org_id)));

drop policy if exists rls_read_research_runs on research.collection_runs;
create policy rls_read_research_runs on research.collection_runs
  for select using (exists (
    select 1 from research.assessments a where a.id = assessment_id
      and research.can_read_assessment(a.org_id)));

-- Chỉ cấp SELECT cho authenticated; ghi đi qua RPC security definer.
grant select on research.assessments, research.assessment_inputs,
  research.pnl_snapshots, research.scorecards, research.veto_flags,
  research.roadmap, research.collection_runs
  to authenticated;
grant all on research.assessments, research.assessment_inputs,
  research.pnl_snapshots, research.scorecards, research.veto_flags,
  research.roadmap, research.collection_runs
  to service_role;

-- ============================================================================
-- 10. RPC TẠO HỒ SƠ (web gọi; kiểm validation tối thiểu, engine tính ở TS)
-- ============================================================================
create or replace function public.vexim_research_create_assessment(p_payload jsonb)
returns jsonb
language plpgsql security definer
set search_path = research, iam, public, pg_catalog
as $$
declare
  v_org      uuid;
  v_actor    uuid := auth.uid();
  v_code     text;
  v_id       uuid;
  v_a        jsonb := coalesce(p_payload->'assumptions', '{}'::jsonb);
  v_title    text := coalesce(nullif(trim(p_payload->>'title'), ''),
                              nullif(trim(v_a->>'title'), ''));
  v_keywords jsonb := coalesce(p_payload->'keywords', v_a->'keywords', '[]'::jsonb);
  v_prices   jsonb := v_a->'prices';
  v_result   jsonb := p_payload->'result';
  v_now      timestamptz := now();
  v_month    text := to_char(v_now, 'YYYYMM');
  v_seq      int;
  v_p        record;
  v_v        record;
begin
  if v_actor is null then
    raise exception '[M8] yêu cầu chưa đăng nhập';
  end if;
  if not research.can_manage_assessment() then
    raise exception '[M8] vai trò hiện tại không được tạo hồ sơ thẩm định';
  end if;
  if v_title is null then
    raise exception '[M8] thiếu title (tên ngách)';
  end if;
  if jsonb_typeof(v_keywords) <> 'array' or jsonb_array_length(v_keywords) = 0 then
    raise exception '[M8] cần ít nhất 1 từ khóa ngách';
  end if;
  if v_prices is null or coalesce((v_prices->>'base')::numeric, 0) <= 0 then
    raise exception '[M8] giá kịch bản cơ sở phải lớn hơn 0';
  end if;
  if coalesce((v_a->>'cogsPerUnit')::numeric, -1) < 0 then
    raise exception '[M8] giá vốn/đơn vị không hợp lệ';
  end if;
  if v_result is null then
    raise exception '[M8] thiếu kết quả engine (result)';
  end if;

  -- Org: lấy từ payload nếu người tạo có quyền đọc org đó, mặc định org của người tạo.
  v_org := nullif(p_payload->>'orgId', '')::uuid;
  if v_org is null then
    v_org := (select org_id from iam.user_profiles where id = v_actor);
  end if;
  if v_org is null or not research.can_read_assessment(v_org) then
    raise exception '[M8] không xác định được tổ chức hợp lệ cho báo cáo';
  end if;

  -- Mã PR-YYYYMM-#### theo tuần tự trong org/tháng.
  select count(*)::int + 1 into v_seq
    from research.assessments
   where org_id = v_org and code like 'PR-' || v_month || '-%';
  v_code := 'PR-' || v_month || '-' || lpad(v_seq::text, 4, '0');

  insert into research.assessments (
    org_id, code, title, marketplace, currency, keywords, seed_asin, category_node,
    status, verdict, overall_score, base_margin_pct, pess_margin_pct, size_tier,
    veto_count, red_veto_count, analyst_id, engine_version, created_by
  ) values (
    v_org, v_code, v_title,
    coalesce(nullif(p_payload->>'marketplace',''), 'US'),
    coalesce(nullif(p_payload->>'currency',''), 'USD'),
    v_keywords,
    nullif(p_payload->>'seedAsin', ''),
    nullif(p_payload->>'categoryNode', ''),
    'collecting',
    nullif(v_result->'scorecard'->>'verdict', '') ,
    nullif(v_result->'scorecard'->>'overallScore', '')::numeric,
    nullif(v_result #>> '{financial,scenarios,base,netMarginPct}', '')::numeric,
    nullif(v_result #>> '{financial,scenarios,pessimistic,netMarginPct}', '')::numeric,
    nullif(v_result #>> '{financial,currentPackaging,tier}', ''),
    (select count(*) from jsonb_array_elements(coalesce(v_result->'scorecard'->'vetoes','[]'::jsonb))),
    (select count(*) from jsonb_array_elements(coalesce(v_result->'scorecard'->'vetoes','[]'::jsonb)) e
      where e->>'severity' = 'red'),
    v_actor,
    p_payload->>'engineVersion',
    v_actor
  )
  returning id into v_id;

  insert into research.assessment_inputs (assessment_id, version, inputs, changed_by)
  values (v_id, 1, p_payload->'assumptions', v_actor);

  insert into research.pnl_snapshots
    (assessment_id, inputs_version, result, fee_table_version)
  values (
    v_id, 1, v_result->'financial',
    nullif(v_result #>> '{financial,feeTableVersion}', '')
  );

  -- 5 trụ điểm (trụ chưa đủ dữ liệu có score null)
  for v_p in select * from jsonb_array_elements(v_result->'scorecard'->'pillars') loop
    insert into research.scorecards
      (assessment_id, pillar, weight, score, confidence, reason, metrics)
    values (
      v_id,
      v_p.value->>'pillar',
      coalesce((v_p.value->>'weight')::numeric, 0),
      nullif(v_p.value->>'score', '')::numeric,
      nullif(v_p.value->>'confidence', ''),
      coalesce(v_p.value->>'reason', ''),
      v_p.value->'metrics'
    );
  end loop;

  for v_v in select * from jsonb_array_elements(coalesce(v_result->'scorecard'->'vetoes','[]'::jsonb)) loop
    insert into research.veto_flags
      (assessment_id, rule_code, severity, title, detail, evidence)
    values (
      v_id,
      v_v.value->>'code',
      v_v.value->>'severity',
      coalesce(v_v.value->>'title',''),
      coalesce(v_v.value->>'detail',''),
      v_v.value->'evidence'
    );
  end loop;

  insert into research.roadmap (
    assessment_id, test_order_qty, cover_days, lot_capital, ads_budget_per_day,
    test_days, ads_test_spend, breakeven_acos_pct, max_loss_amount,
    gates, kill_criteria, notes, updated_by
  ) values (
    v_id,
    nullif(v_result #>> '{roadmap,testOrderQty}', '')::int,
    coalesce(nullif(v_result #>> '{roadmap,coverDays}', '')::int, 45),
    nullif(v_result #>> '{roadmap,lotCapital}', '')::numeric,
    nullif(v_result #>> '{roadmap,adsBudgetPerDay}', '')::numeric,
    coalesce(nullif(v_result #>> '{roadmap,adsTestDays}', '')::int, 45),
    nullif(v_result #>> '{roadmap,adsTestSpend}', '')::numeric,
    nullif(v_result #>> '{roadmap,breakEvenAcosPct}', '')::numeric,
    nullif(v_result #>> '{roadmap,maxLossAmount}', '')::numeric,
    coalesce(v_result->'roadmap'->'gates', '[]'::jsonb),
    coalesce(v_result->'roadmap'->'killCriteria', '[]'::jsonb),
    coalesce(v_result->'roadmap'->'notes', '[]'::jsonb),
    v_actor
  );

  insert into iam.audit_logs (actor_id, module, action, entity, after_value, result)
  values (v_actor, 'm8_research', 'assessment.create', v_code,
          jsonb_build_object('id', v_id, 'title', v_title), 'ok');

  return jsonb_build_object('ok', true, 'id', v_id, 'code', v_code);
end;
$$;

grant execute on function public.vexim_research_create_assessment(jsonb)
  to authenticated, service_role;

-- ============================================================================
-- 11. VIEW PUBLIC CHO WEB (security_invoker → RLS bảng gốc vẫn áp)
-- ============================================================================
create or replace view public.vexim_research_assessments
with (security_invoker = true) as
select a.id, a.org_id, o.name as org_name, a.code, a.title, a.marketplace,
       a.currency, a.keywords, a.seed_asin, a.category_node,
       a.status, a.verdict, a.overall_score,
       a.base_margin_pct, a.pess_margin_pct, a.size_tier,
       a.veto_count, a.red_veto_count,
       a.analyst_id, an.display_name as analyst_name,
       a.approver_id, ap.display_name as approver_name,
       a.data_expires_at, a.engine_version, a.created_at, a.updated_at
  from research.assessments a
  join iam.organizations o on o.id = a.org_id
  left join iam.user_profiles an on an.id = a.analyst_id
  left join iam.user_profiles ap on ap.id = a.approver_id;

create or replace view public.vexim_research_scorecards
with (security_invoker = true) as
select s.assessment_id, s.pillar, s.weight, s.score, s.confidence, s.reason, s.metrics, s.computed_at
  from research.scorecards s;

create or replace view public.vexim_research_vetoes
with (security_invoker = true) as
select v.assessment_id, v.rule_code, v.severity, v.title, v.detail, v.evidence,
       v.acknowledged_by, v.acknowledged_note, v.acknowledged_at
  from research.veto_flags v;

create or replace view public.vexim_research_roadmap
with (security_invoker = true) as
select r.* from research.roadmap r;

create or replace view public.vexim_research_inputs
with (security_invoker = true) as
select i.assessment_id, i.version, i.inputs, i.changed_by, i.changed_at
  from research.assessment_inputs i;

create or replace view public.vexim_research_pnl
with (security_invoker = true) as
select p.assessment_id, p.inputs_version, p.result, p.fee_table_version, p.computed_at
  from research.pnl_snapshots p;

grant select on public.vexim_research_assessments, public.vexim_research_scorecards,
  public.vexim_research_vetoes, public.vexim_research_roadmap,
  public.vexim_research_inputs, public.vexim_research_pnl
  to authenticated, anon, service_role;

commit;
