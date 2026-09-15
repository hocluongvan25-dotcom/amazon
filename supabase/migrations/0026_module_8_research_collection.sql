-- ============================================================================
-- 0026 — MODULE 8 PRODUCT RESEARCH: G2 — THU THẬP ĐỐI THỦ & REVIEW (RAINFOREST)
-- ============================================================================
-- TÀI LIỆU: docs/ke-hoach-module-8-tham-dinh-rnd-san-pham.md (mục 4, 6, phụ lục A)
--
-- PHẠM VI GIAI ĐOẠN 2:
--   • research.competitor_snapshots — top 20–50 listing organic/sponsored theo
--     từng lần quét (giữ LỊCH SỬ theo run để so sánh về sau).
--   • research.reviews_raw           — review 1–3★ thô, ĐÃ LOẠI thông tin nhận
--     dạng reviewer ngay ở parser (không có cột tên/avatar/profile URL).
--   • research.credit_ledger         — sổ cái credit Rainforest theo org/tháng.
--   • RPC cho 2 phía:
--       - analyst (authenticated) xếp hàng quét: vexim_research_enqueue_run;
--       - worker (service_role) nhận việc/ghi kết quả/ghi sổ cái.
--   • 4 view public vexim_research_* bật security_invoker cho web.
--
-- NGUYÊN TẮC:
--   • Worker chạy bằng service_role KHÔNG kèm JWT người dùng → RPC kiểm
--     auth.uid() IS NULL để chặn web mạo danh (đúng mẫu 0019).
--   • authenticated chỉ SELECT trực tiếp; MỌI ghi đi qua RPC.
--   • Idempotent: chạy lại 2 lần sạch; upsert ON CONFLICT, review dedupe theo
--     (assessment_id, asin, source_review_id).
-- ============================================================================

begin;

-- ============================================================================
-- 1. SNAPSHOT ĐỐI THỦ (1 run = 1 lần quét SERP; giữ lịch sử)
-- ============================================================================
create table if not exists research.competitor_snapshots (
  id                 uuid primary key default gen_random_uuid(),
  assessment_id      uuid not null references research.assessments(id) on delete cascade,
  run_id             uuid not null references research.collection_runs(id) on delete cascade,
  position           int not null,            -- thứ tự trên SERP (sponsored vẫn giữ vị trí)
  is_sponsored       boolean not null default false,
  asin               text not null,
  parent_asin        text,
  brand              text,
  title              text,
  price              numeric(10,2),
  currency           text not null default 'USD',
  rating             numeric(2,1),
  ratings_total      int,
  bsr_rank           int,
  bsr_category       text,
  est_units_month    int,                     -- sales estimation (đánh dấu sai số 20–40%)
  est_revenue_month  numeric(14,2),
  buybox_seller      text,
  is_amazon_1p       boolean,                 -- buybox/sold by Amazon
  variation_count    int,
  length_in          numeric(8,2),
  width_in           numeric(8,2),
  height_in          numeric(8,2),
  weight_lb          numeric(8,2),
  data_source        text not null default 'rainforest', -- rainforest | mock
  payload            jsonb not null default '{}'::jsonb,  -- payload gốc để replay
  created_at         timestamptz not null default now(),
  unique (assessment_id, run_id, asin)
);

create index if not exists idx_research_comp_assessment
  on research.competitor_snapshots (assessment_id, run_id, position);
create index if not exists idx_research_comp_brand
  on research.competitor_snapshots (assessment_id, lower(brand));

comment on table research.competitor_snapshots is
  'M8 G2: snapshot listing đối thủ từng lần quét SERP. Gộp variation theo brand ở tầng engine (G3), không gộp khi lưu.';

-- ============================================================================
-- 2. REVIEW 1–3★ THÔ — KHÔNG lưu thông tin nhận dạng reviewer (PII by design)
-- ============================================================================
create table if not exists research.reviews_raw (
  id                 uuid primary key default gen_random_uuid(),
  assessment_id      uuid not null references research.assessments(id) on delete cascade,
  run_id             uuid not null references research.collection_runs(id) on delete cascade,
  asin               text not null,
  source_review_id   text not null,           -- id review của Amazon (không phải id người review)
  stars              numeric(2,1),
  title              text,
  body               text not null default '',
  review_date        date,
  helpful_count      int not null default 0,
  verified           boolean not null default false,
  photos_count       int not null default 0,
  url                text,
  data_source        text not null default 'rainforest',
  payload            jsonb not null default '{}'::jsonb,
  fetched_at         timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  unique (assessment_id, asin, source_review_id)
);

create index if not exists idx_research_reviews_assessment
  on research.reviews_raw (assessment_id, asin, stars);
create index if not exists idx_research_reviews_date
  on research.reviews_raw (assessment_id, review_date desc nulls last);

comment on table research.reviews_raw is
  'M8 G2: review 1–3★ để LLM phân cụm pain (G4). CỐ Ý không có cột tên/ảnh/profile reviewer — parser phải loại trước khi gọi RPC.';

-- ============================================================================
-- 3. SỔ CÁI CREDIT RAINFOREST (chi/tháng theo org)
-- ============================================================================
create table if not exists research.credit_ledger (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references iam.organizations(id) on delete cascade,
  run_id        uuid references research.collection_runs(id) on delete set null,
  delta         int not null,                 -- âm = đã tiêu (vd -2), dương = cấp thêm
  reason        text not null default '',
  balance_after int not null,                 -- lũy kế toàn thời gian của org
  created_by    uuid references iam.user_profiles(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists idx_research_credit_org
  on research.credit_ledger (org_id, created_at desc);

comment on table research.credit_ledger is
  'M8 G2: sổ cái credit Rainforest; cảnh báo ngưỡng RESEARCH_CREDIT_BUDGET_MONTHLY tính ở view tổng hợp tháng.';

-- ============================================================================
-- 4. RLS — đọc theo hồ sơ (tái dùng hàm research.can_read_assessment của 0025)
-- ============================================================================
alter table research.competitor_snapshots enable row level security;
alter table research.reviews_raw            enable row level security;
alter table research.credit_ledger          enable row level security;

drop policy if exists rls_read_research_competitors on research.competitor_snapshots;
create policy rls_read_research_competitors on research.competitor_snapshots
  for select using (exists (
    select 1 from research.assessments a where a.id = assessment_id
      and research.can_read_assessment(a.org_id)));

drop policy if exists rls_read_research_reviews on research.reviews_raw;
create policy rls_read_research_reviews on research.reviews_raw
  for select using (exists (
    select 1 from research.assessments a where a.id = assessment_id
      and research.can_read_assessment(a.org_id)));

drop policy if exists rls_read_research_credit on research.credit_ledger;
create policy rls_read_research_credit on research.credit_ledger
  for select using (exists (
    select 1 from iam.user_profiles up
     where up.id = auth.uid()
       and (iam.has_role(array['super_admin']) or up.vexim_employee = true or up.org_id = org_id)));

grant select on research.competitor_snapshots, research.reviews_raw, research.credit_ledger
  to authenticated;
grant all on research.competitor_snapshots, research.reviews_raw, research.credit_ledger
  to service_role;

-- ============================================================================
-- 5. RPC NGƯỜI DÙNG: XẾP HÀNG QUÉT (analyst/dept_lead/admin, theo phiên đăng nhập)
-- ============================================================================
create or replace function public.vexim_research_enqueue_run(
  p_assessment uuid,
  p_kind       text,
  p_params     jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql security definer
set search_path = research, iam, public, pg_catalog
as $$
declare
  v_org  uuid;
  v_run  uuid;
begin
  if auth.uid() is null then
    raise exception '[M8] yêu cầu chưa đăng nhập';
  end if;
  if not research.can_manage_assessment() then
    raise exception '[M8] vai trò hiện tại không được xếp hàng thu thập dữ liệu';
  end if;
  if p_kind is null or p_kind not in ('serp','products','offers','sales','reviews','fees') then
    raise exception '[M8] loại quét p_kind không hợp lệ: %', p_kind;
  end if;

  select org_id into v_org from research.assessments where id = p_assessment;
  if v_org is null or not research.can_read_assessment(v_org) then
    raise exception '[M8] không tìm thấy hồ sơ hợp lệ để xếp hàng quét';
  end if;

  -- Không xếp trùng: còn dòng queued/running cùng kind cho hồ sơ này.
  if exists (
    select 1 from research.collection_runs
     where assessment_id = p_assessment and kind = p_kind
       and status in ('queued','running')
  ) then
    raise exception '[M8] đã có lượt quét % đang chờ/chạy cho hồ sơ này', p_kind
      using errcode = 'duplicate_object';
  end if;

  insert into research.collection_runs (assessment_id, kind, status, provider, params, started_at)
  values (p_assessment, p_kind, 'queued', 'rainforest', coalesce(p_params, '{}'::jsonb), null)
  returning id into v_run;

  insert into iam.audit_logs (actor_id, module, action, entity, after_value, result)
  values (auth.uid(), 'm8_research', 'collection.enqueue', p_assessment::text,
          jsonb_build_object('run', v_run, 'kind', p_kind), 'ok');

  return jsonb_build_object('ok', true, 'run_id', v_run, 'status', 'queued');
end;
$$;

grant execute on function public.vexim_research_enqueue_run(uuid, text, jsonb)
  to authenticated, service_role;

-- ============================================================================
-- 6. RPC WORKER (service_role): NHẬN VIỆC, HOÀN THÀNH, GHI DỮ LIỆU, SỔ CÁI
-- ============================================================================
create or replace function research.worker_only()
returns void
language plpgsql
as $$
begin
  if auth.uid() is not null then
    raise exception '[M8-W] RPC chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
end;
$$;

-- 6.1 Nhận 1 lượt quét đang queued (đơn vị nhỏ nhất, không bao giờ quét chồng)
create or replace function public.vexim_research_worker_claim_run(p_kind text default null)
returns jsonb
language plpgsql security definer
set search_path = research, iam, public, pg_catalog
as $$
declare
  v_run record;
begin
  perform research.worker_only();
  select r.*, a.org_id, a.marketplace, a.keywords, a.seed_asin, a.category_node, a.title
    into v_run
    from research.collection_runs r
    join research.assessments a on a.id = r.assessment_id
   where r.status = 'queued'
     and (p_kind is null or r.kind = p_kind)
   order by r.created_at
   limit 1
   for update skip locked;
  if not found then
    return jsonb_build_object('ok', true, 'run', null);
  end if;
  update research.collection_runs
     set status = 'running', started_at = now()
   where id = v_run.id;
  return jsonb_build_object(
    'ok', true,
    'run', jsonb_build_object(
      'id', v_run.id, 'assessmentId', v_run.assessment_id, 'orgId', v_run.org_id,
      'kind', v_run.kind, 'params', v_run.params,
      'title', v_run.title, 'marketplace', v_run.marketplace,
      'keywords', v_run.keywords, 'seedAsin', v_run.seed_asin,
      'categoryNode', v_run.category_node));
end;
$$;

revoke all on function public.vexim_research_worker_claim_run(text) from public, anon, authenticated;
grant execute on function public.vexim_research_worker_claim_run(text) to service_role;

-- 6.2 Cập nhật trạng thái run + credit tiêu thụ (credits_used >= 0)
create or replace function public.vexim_research_worker_finish_run(
  p_run_id       uuid,
  p_status       text,
  p_credits_used int default 0,
  p_external_id  text default null,
  p_error        text default null,
  p_raw          jsonb default null
)
returns jsonb
language plpgsql security definer
set search_path = research, iam, public, pg_catalog
as $$
declare
  v_assessment uuid;
  v_org uuid;
begin
  perform research.worker_only();
  if p_status not in ('done','no_data','failed') then
    raise exception '[M8-W] trạng thái kết thúc không hợp lệ: %', p_status;
  end if;
  select assessment_id into v_assessment from research.collection_runs where id = p_run_id;
  if v_assessment is null then
    raise exception '[M8-W] không thấy run %', p_run_id;
  end if;

  update research.collection_runs
     set status = p_status,
         finished_at = now(),
         credits_used = greatest(coalesce(p_credits_used, 0), 0),
         external_id = coalesce(p_external_id, external_id),
         error = nullif(p_error, ''),
         raw = coalesce(p_raw, raw)
   where id = p_run_id;

  if coalesce(p_credits_used, 0) > 0 then
    select org_id into v_org from research.assessments where id = v_assessment;
    -- balance_after = lũy kế toàn thời gian của org (tính cả dòng đang ghi).
    insert into research.credit_ledger (org_id, run_id, delta, reason, balance_after)
    select v_org, p_run_id, -p_credits_used, 'rainforest:' || r.kind,
           coalesce((select sum(delta) from research.credit_ledger where org_id = v_org), 0)
             - p_credits_used
      from research.collection_runs r
     where r.id = p_run_id;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.vexim_research_worker_finish_run(uuid, text, int, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.vexim_research_worker_finish_run(uuid, text, int, text, text, jsonb)
  to service_role;

-- 6.3 Upsert hàng loạt snapshot đối thủ (idempotent theo assessment+run+asin)
create or replace function public.vexim_research_worker_upsert_competitors(
  p_run_id uuid,
  p_rows   jsonb
)
returns jsonb
language plpgsql security definer
set search_path = research, iam, public, pg_catalog
as $$
declare
  v_assessment uuid;
  v_ins int := 0;
  r record;
begin
  perform research.worker_only();
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception '[M8-W] p_rows phải là JSON array';
  end if;
  select assessment_id into v_assessment from research.collection_runs where id = p_run_id;
  if v_assessment is null then
    raise exception '[M8-W] không thấy run %', p_run_id;
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    insert into research.competitor_snapshots (
      assessment_id, run_id, position, is_sponsored, asin, parent_asin, brand, title,
      price, currency, rating, ratings_total, bsr_rank, bsr_category,
      est_units_month, est_revenue_month, buybox_seller, is_amazon_1p, variation_count,
      length_in, width_in, height_in, weight_lb, data_source, payload
    ) values (
      v_assessment, p_run_id,
      coalesce(nullif(r.value->>'position','')::int, 0),
      coalesce((r.value->>'isSponsored')::boolean, false),
      r.value->>'asin',
      nullif(r.value->>'parentAsin',''),
      nullif(r.value->>'brand',''),
      nullif(r.value->>'title',''),
      nullif(r.value->>'price','')::numeric,
      coalesce(nullif(r.value->>'currency',''), 'USD'),
      nullif(r.value->>'rating','')::numeric,
      nullif(r.value->>'ratingsTotal','')::int,
      nullif(r.value->>'bsrRank','')::int,
      nullif(r.value->>'bsrCategory',''),
      nullif(r.value->>'estUnitsMonth','')::int,
      nullif(r.value->>'estRevenueMonth','')::numeric,
      nullif(r.value->>'buyboxSeller',''),
      coalesce((r.value->>'isAmazon1p')::boolean, false),
      nullif(r.value->>'variationCount','')::int,
      nullif(r.value->>'lengthIn','')::numeric,
      nullif(r.value->>'widthIn','')::numeric,
      nullif(r.value->>'heightIn','')::numeric,
      nullif(r.value->>'weightLb','')::numeric,
      coalesce(nullif(r.value->>'dataSource',''), 'rainforest'),
      coalesce(r.value->'payload', '{}'::jsonb)
    )
    on conflict (assessment_id, run_id, asin) do update set
      position = excluded.position, is_sponsored = excluded.is_sponsored,
      parent_asin = excluded.parent_asin, brand = excluded.brand, title = excluded.title,
      price = excluded.price, currency = excluded.currency, rating = excluded.rating,
      ratings_total = excluded.ratings_total, bsr_rank = excluded.bsr_rank,
      bsr_category = excluded.bsr_category, est_units_month = excluded.est_units_month,
      est_revenue_month = excluded.est_revenue_month, buybox_seller = excluded.buybox_seller,
      is_amazon_1p = excluded.is_amazon_1p, variation_count = excluded.variation_count,
      length_in = excluded.length_in, width_in = excluded.width_in,
      height_in = excluded.height_in, weight_lb = excluded.weight_lb,
      data_source = excluded.data_source, payload = excluded.payload;
    v_ins := v_ins + 1;
  end loop;

  return jsonb_build_object('ok', true, 'rows', v_ins);
end;
$$;

revoke all on function public.vexim_research_worker_upsert_competitors(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.vexim_research_worker_upsert_competitors(uuid, jsonb)
  to service_role;

-- 6.4 Upsert review 1–3★ (dedupe; parser đã loại PII reviewer)
create or replace function public.vexim_research_worker_upsert_reviews(
  p_run_id uuid,
  p_rows   jsonb
)
returns jsonb
language plpgsql security definer
set search_path = research, iam, public, pg_catalog
as $$
declare
  v_assessment uuid;
  v_ins int := 0;
  v_skip int := 0;
  r record;
begin
  perform research.worker_only();
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception '[M8-W] p_rows phải là JSON array';
  end if;
  select assessment_id into v_assessment from research.collection_runs where id = p_run_id;
  if v_assessment is null then
    raise exception '[M8-W] không thấy run %', p_run_id;
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    -- Chốt chặn cuối: KHÔNG nhận payload mang danh tính reviewer.
    if r.value ? 'reviewerName' or r.value ? 'reviewerProfileUrl' or r.value ? 'reviewerId' then
      raise exception '[M8-W] payload review chứa thông tin nhận dạng reviewer — từ chối';
    end if;
    insert into research.reviews_raw (
      assessment_id, run_id, asin, source_review_id, stars, title, body, review_date,
      helpful_count, verified, photos_count, url, data_source, payload
    ) values (
      v_assessment, p_run_id, r.value->>'asin', r.value->>'sourceReviewId',
      nullif(r.value->>'stars','')::numeric, nullif(r.value->>'title',''),
      coalesce(r.value->>'body',''), nullif(r.value->>'reviewDate','')::date,
      coalesce(nullif(r.value->>'helpfulCount','')::int, 0),
      coalesce((r.value->>'verified')::boolean, false),
      coalesce(nullif(r.value->>'photosCount','')::int, 0),
      nullif(r.value->>'url',''),
      coalesce(nullif(r.value->>'dataSource',''), 'rainforest'),
      coalesce(r.value->'payload', '{}'::jsonb)
    )
    on conflict (assessment_id, asin, source_review_id) do nothing;
    if found then
      v_ins := v_ins + 1;
    else
      v_skip := v_skip + 1;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'inserted', v_ins, 'duplicatesSkipped', v_skip);
end;
$$;

revoke all on function public.vexim_research_worker_upsert_reviews(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.vexim_research_worker_upsert_reviews(uuid, jsonb)
  to service_role;

-- ============================================================================
-- 7. VIEW PUBLIC CHO WEB (security_invoker)
-- ============================================================================
create or replace view public.vexim_research_runs
with (security_invoker = true) as
select r.id as run_id, r.assessment_id, a.code, a.title as assessment_title,
       a.org_id, r.kind, r.status, r.provider, r.params, r.external_id,
       r.credits_used, r.error, r.started_at, r.finished_at, r.created_at
  from research.collection_runs r
  join research.assessments a on a.id = r.assessment_id;

create or replace view public.vexim_research_competitors
with (security_invoker = true) as
select c.assessment_id, c.run_id, a.code, c.position, c.is_sponsored, c.asin,
       c.parent_asin, c.brand, c.title, c.price, c.currency, c.rating,
       c.ratings_total, c.bsr_rank, c.bsr_category, c.est_units_month,
       c.est_revenue_month, c.buybox_seller, c.is_amazon_1p, c.variation_count,
       c.length_in, c.width_in, c.height_in, c.weight_lb, c.data_source, c.created_at
  from research.competitor_snapshots c
  join research.assessments a on a.id = c.assessment_id;

create or replace view public.vexim_research_reviews
with (security_invoker = true) as
select w.assessment_id, w.run_id, a.code, w.asin, w.source_review_id, w.stars,
       w.title, w.body, w.review_date, w.helpful_count, w.verified,
       w.photos_count, w.url, w.data_source, w.fetched_at
  from research.reviews_raw w
  join research.assessments a on a.id = w.assessment_id;

-- Tổng hợp chi/tháng + cảnh báo vượt ngưỡng (ngưỡng để mặc định 2.000 credit;
-- giá trị thật do app truyền từ RESEARCH_CREDIT_BUDGET_MONTHLY khi hiển thị).
create or replace view public.vexim_research_credit_monthly
with (security_invoker = true) as
select o.id as org_id, o.name as org_name,
       to_char(date_trunc('month', l.created_at), 'YYYY-MM') as month,
       sum(case when l.delta < 0 then -l.delta else 0 end) as credits_spent,
       count(distinct l.run_id) as runs_count,
       max(l.created_at) as last_spend_at
  from research.credit_ledger l
  join iam.organizations o on o.id = l.org_id
 group by o.id, o.name, date_trunc('month', l.created_at);

grant select on public.vexim_research_runs, public.vexim_research_competitors,
  public.vexim_research_reviews, public.vexim_research_credit_monthly
  to authenticated, anon, service_role;

commit;
