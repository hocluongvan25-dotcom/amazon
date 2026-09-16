-- ============================================================================
-- 0028 — MODULE 8 G4: LLM PAIN-POINT CLUSTERING & TRACEABILITY QUOTES
-- ============================================================================
-- Bảng mới (schema research):
--   • llm_runs           — nhật ký MỌI lượt gọi LLM (model, token, chi phí,
--                          prompt_hash, output, trạng thái) để truy vết + kiểm
--                          chi phí; không bao giờ xóa khi phân tích lại.
--   • pain_clusters      — 3 cụm Quality / Expectation Gap / Logistics.
--   • pain_items         — top 3–5 pain (tần suất/nghiêm trọng do HỆ THỐNG
--                          tính lại, gợi ý xử lý do LLM nháp, người sửa được).
--   • pain_quotes        — trích dẫn BẮT BUỘC truy gốc về reviews_raw; trigger
--                          đối chiếu chuỗi từ nguyên văn, không khớp → chặn.
--   • improvement_specs  — spec sheet gửi xưởng (LLM gợi ý, người xác nhận).
--
-- RPC:
--   • vexim_research_worker_record_llm_run   (service_role) ghi nhật ký 1 call.
--   • vexim_research_worker_save_pain_analysis(service_role) THAY THẾ toàn bộ
--     kết quả pain của hồ sơ (idempotent theo từng lượt phân tích).
--   • vexim_research_update_pain_item        (analyst/dept_lead theo phiên) sửa
--     ưu tiên/yêu cầu kỹ thuật sau khi thẩm định gợi ý LLM.
--   • vexim_research_enqueue_run (thay thế 0026) bổ sung kind 'analyze' và
--     tham số nhà cung cấp (rainforest|llm).
--
-- View web (security_invoker): pain_clusters/pain_items/pain_quotes/
--   improvement_specs/llm_runs — đặt tên vexim_research_*.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. BẢNG
-- ----------------------------------------------------------------------------

create table if not exists research.llm_runs (
  id           uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references research.assessments(id) on delete cascade,
  section_key  text not null check (section_key in ('pain_map','pain_reduce')),
  chunk_index  int,
  provider     text not null,                       -- openai | mock
  model        text not null,
  prompt_hash  text,
  input_refs   jsonb not null default '{}'::jsonb,
  output       jsonb,
  tokens_in    int not null default 0 check (tokens_in >= 0),
  tokens_out   int not null default 0 check (tokens_out >= 0),
  cost_usd     numeric(10,6) not null default 0 check (cost_usd >= 0),
  status       text not null default 'ok' check (status in ('ok','failed')),
  error        text,
  created_by   text not null default 'ai' check (created_by in ('ai','human_regen')),
  created_at   timestamptz not null default now()
);

create index if not exists idx_research_llm_runs_assessment
  on research.llm_runs (assessment_id, created_at desc);

comment on table research.llm_runs is
  'M8 G4: nhật ký mọi lượt gọi LLM; output của pain_map có thể chứa trích dẫn, RLS chỉ cho người đọc hồ sơ.';

create table if not exists research.pain_clusters (
  id            uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references research.assessments(id) on delete cascade,
  code          text not null check (code in ('quality','expectation_gap','logistics')),
  share_pct     numeric(6,2) not null default 0,   -- % review có pain thuộc cụm
  review_count  int not null default 0,
  item_count    int not null default 0,
  severity_avg_stars numeric(3,2),
  narrative     text,
  model         text,
  llm_run_id    uuid references research.llm_runs(id) on delete set null,
  updated_at    timestamptz not null default now(),
  unique (assessment_id, code)
);

create table if not exists research.pain_items (
  id                  uuid primary key default gen_random_uuid(),
  assessment_id       uuid not null references research.assessments(id) on delete cascade,
  cluster_id          uuid references research.pain_clusters(id) on delete cascade,
  item_key            text not null,
  cluster_code        text not null check (cluster_code in ('quality','expectation_gap','logistics')),
  title               text not null,
  sub_label           text,
  frequency           int not null default 0,
  frequency_pct       numeric(6,2) not null default 0,
  avg_stars           numeric(3,2),
  severity            numeric(4,1) not null default 0,
  impact_score        numeric(4,1) not null default 0,
  effort_score        numeric(4,1) not null default 0,
  priority            text not null default 'should'
                        check (priority in ('must','should','skip')),
  effort_hint         smallint check (effort_hint between 1 and 3),
  -- Gợi ý LLM (đánh nhãn llm_suggested), người thẩm định được sửa:
  factory_requirement text,
  listing_fix         text,
  source              text not null default 'llm_suggested'
                        check (source in ('llm_suggested','human_confirmed')),
  updated_by          uuid references iam.user_profiles(id),
  updated_at          timestamptz not null default now(),
  unique (assessment_id, item_key)
);

create index if not exists idx_research_pain_items_cluster
  on research.pain_items (assessment_id, cluster_code);

create table if not exists research.pain_quotes (
  id               uuid primary key default gen_random_uuid(),
  assessment_id    uuid not null references research.assessments(id) on delete cascade,
  pain_item_id     uuid not null references research.pain_items(id) on delete cascade,
  review_id        uuid not null references research.reviews_raw(id) on delete cascade,
  source_review_id text not null,
  quote            text not null,
  asin             text not null,
  stars            numeric(2,1),
  review_date      date,
  url              text,
  verified         boolean not null default false,
  helpful_count    int not null default 0,
  photos_count     int not null default 0,
  created_at       timestamptz not null default now(),
  unique (pain_item_id, review_id)
);

create index if not exists idx_research_pain_quotes_item
  on research.pain_quotes (pain_item_id);

create table if not exists research.improvement_specs (
  id                  uuid primary key default gen_random_uuid(),
  assessment_id       uuid not null references research.assessments(id) on delete cascade,
  pain_item_id        uuid references research.pain_items(id) on delete cascade,
  item_key            text not null,
  cluster_code        text not null,
  pain_title          text not null,
  requirement         text,
  test_method         text,
  acceptance_standard text,
  cost_impact_estimate text,
  owner               uuid references iam.user_profiles(id),
  source              text not null default 'llm_suggested'
                        check (source in ('llm_suggested','human_confirmed')),
  confirmed_by        uuid references iam.user_profiles(id),
  confirmed_at        timestamptz,
  updated_at          timestamptz not null default now(),
  unique (assessment_id, item_key)
);

-- ----------------------------------------------------------------------------
-- 2. CHỐT CHẶN DETERMINISTIC Ở DB: quote PHẢI truy nguyên văn reviews_raw.body
-- ----------------------------------------------------------------------------

/**
 * Đối chiếu 1 câu trích với body review (tái hiện extractVerbatimQuote của
 * domain/pain.ts): tách theo dấu ba chấm, MỌI đoạn 2..25 từ phải xuất hiện
 * đúng thứ tự; giữa 2 từ cho phép ≤12 ký tự không phải chữ-số; không biệt
 * hoa thường. Từ tách theo [^[:alnum:]] nên chỉ chứa chữ-số (an toàn regex),
 * khớp cách \p{L}\p{N} tách câu ở TypeScript (vd "don't" -> don + t).
 */
create or replace function research.quote_matches_body(p_quote text, p_body text)
returns boolean
language plpgsql
immutable
as $$
declare
  v_segment text;
  v_words   text[];
  v_pattern text;
  v_tail    text := p_body;
  i         int;
begin
  if p_quote is null or p_body is null or btrim(p_quote) = '' then
    return false;
  end if;

  for v_segment in
    select btrim(seg)
      from unnest(regexp_split_to_array(p_quote, '…|\.\.\.')) as seg
  loop
    v_words := array(
      select w from unnest(regexp_split_to_array(v_segment, '[^[:alnum:]]+')) as w
       where w <> ''
    );
    if array_length(v_words, 1) is null then
      continue;
    end if;
    if array_length(v_words, 1) < 2 or array_length(v_words, 1) > 25 then
      return false;
    end if;

    v_pattern := '(^|[^[:alnum:]])';
    for i in 1..array_length(v_words, 1) loop
      if i > 1 then
        v_pattern := v_pattern || '[^[:alnum:]]{0,12}?';
      end if;
      v_pattern := v_pattern || v_words[i];
    end loop;
    v_pattern := '(?i)' || v_pattern || '($|[^[:alnum:]])';

    if v_tail !~ v_pattern then
      return false;
    end if;
    -- Đẩy cursor qua sau từ cuối của đoạn để đoạn sau bám đúng thứ tự.
    v_tail := regexp_replace(
      v_tail,
      '^(.*?' || v_words[array_length(v_words, 1)] || ')',
      '',
      'i'
    );
  end loop;

  return true;
end;
$$;

create or replace function research.guard_pain_quote()
returns trigger
language plpgsql
security definer
set search_path = research, pg_catalog
as $$
declare
  v_body text;
  v_review_assessment uuid;
begin
  select body, assessment_id into v_body, v_review_assessment
    from research.reviews_raw
   where id = new.review_id;

  if not found then
    raise exception '[M8] pain_quote trỏ review không tồn tại (review_id=%)', new.review_id
      using errcode = 'foreign_key_violation';
  end if;
  if v_review_assessment <> new.assessment_id then
    raise exception '[M8] pain_quote lấy review của hồ sơ khác';
  end if;
  if not research.quote_matches_body(new.quote, v_body) then
    raise exception '[M8] trích dẫn không truy nguyên văn được review gốc (review=%): %',
      new.source_review_id, left(new.quote, 80);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_pain_quote on research.pain_quotes;
create trigger trg_guard_pain_quote
  before insert or update on research.pain_quotes
  for each row execute function research.guard_pain_quote();

-- ----------------------------------------------------------------------------
-- 3. RLS
-- ----------------------------------------------------------------------------

alter table research.llm_runs          enable row level security;
alter table research.pain_clusters     enable row level security;
alter table research.pain_items        enable row level security;
alter table research.pain_quotes       enable row level security;
alter table research.improvement_specs enable row level security;

do $$
declare t text;
begin
  foreach t in array array['llm_runs','pain_clusters','pain_items','pain_quotes','improvement_specs'] loop
    execute format('drop policy if exists rls_read_research_%1$s on research.%1$I', t);
    execute format($f$
      create policy rls_read_research_%1$s on research.%1$I
        for select using (exists (
          select 1 from research.assessments a where a.id = assessment_id
            and research.can_read_assessment(a.org_id)))
    $f$, t);
  end loop;
end $$;

-- Worker (service_role) ghi qua RPC security definer; vẫn cấp trực tiếp cho
-- service_role như các bảng G2/G3 (BYPASSRLS) để migration/sửa chữa chạy được.
grant select on research.llm_runs, research.pain_clusters, research.pain_items,
  research.pain_quotes, research.improvement_specs
  to authenticated, anon, service_role;
grant all on research.llm_runs, research.pain_clusters, research.pain_items,
  research.pain_quotes, research.improvement_specs
  to service_role;

-- ----------------------------------------------------------------------------
-- 4. RPC WORKER: nhật ký 1 lượt gọi LLM
-- ----------------------------------------------------------------------------
create or replace function public.vexim_research_worker_record_llm_run(p_run jsonb)
returns jsonb
language plpgsql
security definer
set search_path = research, iam, public, pg_catalog
as $$
declare
  v_id uuid;
begin
  perform research.worker_only();
  insert into research.llm_runs (
    assessment_id, section_key, chunk_index, provider, model, prompt_hash,
    input_refs, output, tokens_in, tokens_out, cost_usd, status, error, created_by
  ) values (
    (p_run->>'assessmentId')::uuid,
    p_run->>'sectionKey',
    nullif(p_run->>'chunkIndex', '')::int,
    coalesce(p_run->>'provider', 'openai'),
    coalesce(p_run->>'model', 'unknown'),
    nullif(p_run->>'promptHash', ''),
    coalesce(p_run->'inputRefs', '{}'::jsonb),
    p_run->'output',
    coalesce((p_run->>'tokensIn')::int, 0),
    coalesce((p_run->>'tokensOut')::int, 0),
    coalesce((p_run->>'costUsd')::numeric, 0),
    coalesce(p_run->>'status', 'ok'),
    nullif(p_run->>'error', ''),
    coalesce(nullif(p_run->>'createdBy', ''), 'ai')
  )
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

revoke all on function public.vexim_research_worker_record_llm_run(jsonb)
  from public, anon, authenticated;
grant execute on function public.vexim_research_worker_record_llm_run(jsonb)
  to service_role;

-- ----------------------------------------------------------------------------
-- 5. RPC WORKER: lưu (THAY THẾ) toàn bộ kết quả pain 1 lượt phân tích
-- ----------------------------------------------------------------------------
create or replace function public.vexim_research_worker_save_pain_analysis(
  p_assessment uuid,
  p_payload    jsonb,
  p_reduce_run_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = research, iam, public, pg_catalog
as $$
declare
  v_org uuid;
  c jsonb; it jsonb; q jsonb; sp jsonb;
  v_cluster_id uuid;
  v_item_id uuid;
  v_review_id uuid;
  v_spec_id uuid;
  n_cluster int := 0; n_item int := 0; n_quote int := 0; n_spec int := 0;
begin
  perform research.worker_only();
  select org_id into v_org from research.assessments where id = p_assessment;
  if v_org is null then
    raise exception '[M8-W] không thấy hồ sơ %', p_assessment;
  end if;

  -- Thay thế toàn bộ pain cũ (llm_runs giữ nguyên làm lịch sử).
  delete from research.pain_quotes       where assessment_id = p_assessment;
  delete from research.improvement_specs where assessment_id = p_assessment;
  delete from research.pain_items        where assessment_id = p_assessment;
  delete from research.pain_clusters     where assessment_id = p_assessment;

  -- clusters
  for c in select * from jsonb_array_elements(coalesce(p_payload->'clusters', '[]'::jsonb))
  loop
    insert into research.pain_clusters (
      assessment_id, code, share_pct, review_count, item_count,
      severity_avg_stars, narrative, model, llm_run_id
    ) values (
      p_assessment, c->>'code',
      coalesce((c->>'sharePct')::numeric, 0),
      coalesce((c->>'reviewCount')::int, 0),
      coalesce((c->>'itemCount')::int, 0),
      nullif(c->>'avgStars','')::numeric,
      nullif(c->>'narrative',''),
      nullif(p_payload->>'model',''),
      p_reduce_run_id
    ) returning id into v_cluster_id;
    n_cluster := n_cluster + 1;

  end loop;

  -- items
  for it in select * from jsonb_array_elements(coalesce(p_payload->'items','[]'::jsonb))
  loop
    select id into v_cluster_id from research.pain_clusters
      where assessment_id = p_assessment and code = (it->>'cluster')
      limit 1;

    insert into research.pain_items (
      assessment_id, cluster_id, item_key, cluster_code, title, sub_label,
      frequency, frequency_pct, avg_stars, severity, impact_score, effort_score,
      priority, effort_hint, factory_requirement, listing_fix, source, updated_at
    ) values (
      p_assessment, v_cluster_id, it->>'itemKey', it->>'cluster',
      it->>'title', nullif(it->>'subLabel',''),
      coalesce((it->>'frequency')::int, 0),
      coalesce((it->>'frequencyPct')::numeric, 0),
      nullif(it->>'avgStars','')::numeric,
      coalesce((it->>'severity')::numeric, 0),
      coalesce((it->>'impactScore')::numeric, 0),
      coalesce((it->>'effortScore')::numeric, 0),
      coalesce(nullif(it->>'priority',''), 'should'),
      nullif(it->>'effortHint','')::smallint,
      nullif(it->>'factoryRequirement',''),
      nullif(it->>'listingFix',''),
      'llm_suggested', now()
    ) returning id into v_item_id;
    n_item := n_item + 1;

    -- quotes: map source_review_id → reviews_raw.id của ĐÚNG hồ sơ;
    -- trigger guard_pain_quote kiểm nguyên văn.
    for q in select * from jsonb_array_elements(coalesce(it->'quotes','[]'::jsonb))
    loop
      select id into v_review_id from research.reviews_raw
       where assessment_id = p_assessment
         and source_review_id = q->>'reviewId'
       limit 1;
      if v_review_id is null then
        raise exception '[M8-W] quote trỏ source_review_id=% không có trong reviews_raw của hồ sơ',
          q->>'reviewId';
      end if;
      insert into research.pain_quotes (
        assessment_id, pain_item_id, review_id, source_review_id, quote, asin,
        stars, review_date, url, verified, helpful_count, photos_count
      ) values (
        p_assessment, v_item_id, v_review_id, q->>'reviewId', q->>'quote',
        coalesce(nullif(q->>'asin',''), ''),
        nullif(q->>'stars','')::numeric,
        nullif(q->>'reviewDate','')::date,
        nullif(q->>'url',''),
        coalesce((q->>'verified')::boolean, false),
        coalesce((q->>'helpfulCount')::int, 0),
        coalesce((q->>'photosCount')::int, 0)
      );
      n_quote := n_quote + 1;
    end loop;
  end loop;

  -- specs
  for sp in select * from jsonb_array_elements(coalesce(p_payload->'specs','[]'::jsonb))
  loop
    select id into v_item_id from research.pain_items
      where assessment_id = p_assessment and item_key = sp->>'itemKey'
      limit 1;
    insert into research.improvement_specs (
      assessment_id, pain_item_id, item_key, cluster_code, pain_title,
      requirement, test_method, acceptance_standard, cost_impact_estimate, source
    ) values (
      p_assessment, v_item_id, sp->>'itemKey', sp->>'cluster', sp->>'painTitle',
      nullif(sp->>'requirement',''), nullif(sp->>'testMethod',''),
      nullif(sp->>'acceptanceStandard',''), nullif(sp->>'costImpactEstimate',''),
      'llm_suggested'
    ) returning id into v_spec_id;
    n_spec := n_spec + 1;
  end loop;

  insert into iam.audit_logs (actor_id, module, action, entity, after_value, result)
  values (null, 'm8_research', 'pain.analyze', p_assessment::text,
          jsonb_build_object(
            'clusters', n_cluster, 'items', n_item, 'quotes', n_quote,
            'specs', n_spec, 'model', p_payload->>'model',
            'quotesDropped', coalesce((p_payload->>'quotesDropped')::int, 0)),
          'ok');

  return jsonb_build_object(
    'ok', true, 'clusters', n_cluster, 'items', n_item,
    'quotes', n_quote, 'specs', n_spec);
end;
$$;

revoke all on function public.vexim_research_worker_save_pain_analysis(uuid, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.vexim_research_worker_save_pain_analysis(uuid, jsonb, uuid)
  to service_role;

-- ----------------------------------------------------------------------------
-- 6. RPC NGƯỜI DÙNG: sửa priority/gợi ý của pain sau khi thẩm định LLM
-- ----------------------------------------------------------------------------
create or replace function public.vexim_research_update_pain_item(
  p_assessment uuid,
  p_item_key   text,
  p_priority   text default null,    -- must|should|skip|null = giữ nguyên
  p_factory_requirement text default null,  -- null=giữ nguyên, ''=bỏ gợi ý
  p_listing_fix text default null
)
returns jsonb
language plpgsql
security definer
set search_path = research, iam, public, pg_catalog
as $$
declare
  v_org uuid;
  v_n   int;
begin
  if auth.uid() is null then
    raise exception '[M8] yêu cầu chưa đăng nhập';
  end if;
  if not research.can_manage_assessment() then
    raise exception '[M8] vai trò hiện tại không được sửa pain item';
  end if;
  select org_id into v_org from research.assessments where id = p_assessment;
  if v_org is null or not research.can_read_assessment(v_org) then
    raise exception '[M8] không tìm thấy hồ sơ hợp lệ';
  end if;
  if p_priority is not null and p_priority not in ('must','should','skip') then
    raise exception '[M8] priority không hợp lệ: %', p_priority;
  end if;

  update research.pain_items
     set priority = coalesce(p_priority, priority),
         factory_requirement = case when p_factory_requirement is null then factory_requirement
                                   when p_factory_requirement = '' then null
                                   else p_factory_requirement end,
         listing_fix = case when p_listing_fix is null then listing_fix
                            when p_listing_fix = '' then null
                            else p_listing_fix end,
         source = 'human_confirmed',
         updated_by = auth.uid(),
         updated_at = now()
   where assessment_id = p_assessment and item_key = p_item_key;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception '[M8] không thấy pain item % của hồ sơ', p_item_key;
  end if;

  -- Đồng bộ requirement của spec sheet tương ứng.
  update research.improvement_specs
     set requirement = case when p_factory_requirement is null then requirement
                            when p_factory_requirement = '' then null
                            else p_factory_requirement end,
         source = 'human_confirmed',
         confirmed_by = auth.uid(),
         confirmed_at = now(),
         updated_at = now()
   where assessment_id = p_assessment and item_key = p_item_key;

  insert into iam.audit_logs (actor_id, module, action, entity, after_value, result)
  values (auth.uid(), 'm8_research', 'pain.item.update', p_assessment::text,
          jsonb_build_object('itemKey', p_item_key, 'priority', p_priority), 'ok');

  return jsonb_build_object('ok', true, 'updated', v_n);
end;
$$;

revoke all on function public.vexim_research_update_pain_item(uuid, text, text, text, text)
  from public, anon;
grant execute on function public.vexim_research_update_pain_item(uuid, text, text, text, text)
  to authenticated, service_role;

-- Gỡ chữ ký 3 tham số của 0026 (sẽ thay bằng bản 4 tham số bên dưới; không
-- giữ overload 3/4 tham số vì Postgres báo mơ hồ khi gọi thiếu tham số cuối).
drop function if exists public.vexim_research_enqueue_run(uuid, text, jsonb);

-- ----------------------------------------------------------------------------
-- 7. MỞ RỘNG enqueue_run (0026): thêm kind 'analyze' + nhà cung cấp 'llm'
-- ----------------------------------------------------------------------------
-- CHECK kind cũ (0025) chưa có 'analyze' ('llm' giữ chỗ từ thiết kế G2, chưa
-- từng dùng — thay bằng 'analyze' thống nhất với queue drain của worker).
alter table research.collection_runs
  drop constraint if exists collection_runs_kind_check;
alter table research.collection_runs
  add constraint collection_runs_kind_check
  check (kind in ('serp','products','offers','sales','reviews','fees','analyze'));

create or replace function public.vexim_research_enqueue_run(
  p_assessment uuid,
  p_kind       text,
  p_params     jsonb default '{}'::jsonb,
  p_provider   text default null
)
returns jsonb
language plpgsql security definer
set search_path = research, iam, public, pg_catalog
as $$
declare
  v_org  uuid;
  v_run  uuid;
  v_provider text;
begin
  if auth.uid() is null then
    raise exception '[M8] yêu cầu chưa đăng nhập';
  end if;
  if not research.can_manage_assessment() then
    raise exception '[M8] vai trò hiện tại không được xếp hàng thu thập/phân tích';
  end if;
  if p_kind is null or p_kind not in ('serp','products','offers','sales','reviews','fees','analyze') then
    raise exception '[M8] loại run p_kind không hợp lệ: %', p_kind;
  end if;

  v_provider := coalesce(nullif(p_provider,''), case when p_kind = 'analyze' then 'llm' else 'rainforest' end);
  if v_provider not in ('rainforest','llm') then
    raise exception '[M8] provider không hợp lệ: %', v_provider;
  end if;

  select org_id into v_org from research.assessments where id = p_assessment;
  if v_org is null or not research.can_read_assessment(v_org) then
    raise exception '[M8] không tìm thấy hồ sơ hợp lệ để xếp hàng';
  end if;

  if exists (
    select 1 from research.collection_runs
     where assessment_id = p_assessment and kind = p_kind
       and status in ('queued','running')
  ) then
    raise exception '[M8] đã có lượt % đang chờ/chạy cho hồ sơ này', p_kind
      using errcode = 'duplicate_object';
  end if;

  insert into research.collection_runs (assessment_id, kind, status, provider, params, started_at)
  values (p_assessment, p_kind, 'queued', v_provider, coalesce(p_params, '{}'::jsonb), null)
  returning id into v_run;

  insert into iam.audit_logs (actor_id, module, action, entity, after_value, result)
  values (auth.uid(), 'm8_research', 'collection.enqueue', p_assessment::text,
          jsonb_build_object('run', v_run, 'kind', p_kind, 'provider', v_provider), 'ok');

  return jsonb_build_object('ok', true, 'run_id', v_run, 'status', 'queued');
end;
$$;

grant execute on function public.vexim_research_enqueue_run(uuid, text, jsonb, text)
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 8. VIEW PUBLIC CHO WEB (security_invoker — RLS bảng gốc vẫn áp)
-- ----------------------------------------------------------------------------
create or replace view public.vexim_research_pain_clusters
with (security_invoker = true) as
select c.assessment_id, a.code, c.code as cluster_code, c.share_pct,
       c.review_count, c.item_count, c.severity_avg_stars, c.narrative,
       c.model, c.llm_run_id, c.updated_at
  from research.pain_clusters c
  join research.assessments a on a.id = c.assessment_id;

create or replace view public.vexim_research_pain_items
with (security_invoker = true) as
select i.assessment_id, a.code, i.cluster_code, i.item_key, i.title, i.sub_label,
       i.frequency, i.frequency_pct, i.avg_stars, i.severity, i.impact_score,
       i.effort_score, i.priority, i.effort_hint, i.factory_requirement,
       i.listing_fix, i.source, i.updated_by, i.updated_at
  from research.pain_items i
  join research.assessments a on a.id = i.assessment_id;

create or replace view public.vexim_research_pain_quotes
with (security_invoker = true) as
select q.assessment_id, a.code, q.pain_item_id, i.item_key, q.review_id,
       q.source_review_id, q.quote, q.asin, q.stars, q.review_date, q.url,
       q.verified, q.helpful_count, q.photos_count
  from research.pain_quotes q
  join research.assessments a on a.id = q.assessment_id
  join research.pain_items i on i.id = q.pain_item_id;

create or replace view public.vexim_research_improvement_specs
with (security_invoker = true) as
select s.assessment_id, a.code, s.item_key, s.cluster_code, s.pain_title,
       s.requirement, s.test_method, s.acceptance_standard,
       s.cost_impact_estimate, s.owner, s.source, s.confirmed_by, s.confirmed_at
  from research.improvement_specs s
  join research.assessments a on a.id = s.assessment_id;

-- Nhật ký LLM cho màn tiến độ: KHÔNG trả output/input_refs đầy đủ (tránh kéo
-- cả trích dẫn ra danh sách); nội dung chi tiết xem ở bảng qua quyền service.
create or replace view public.vexim_research_llm_runs
with (security_invoker = true) as
select l.assessment_id, a.code, l.section_key, l.chunk_index, l.provider, l.model,
       l.prompt_hash, l.tokens_in, l.tokens_out, l.cost_usd, l.status, l.error,
       l.created_by, l.created_at
  from research.llm_runs l
  join research.assessments a on a.id = l.assessment_id;

grant select on
  public.vexim_research_pain_clusters,
  public.vexim_research_pain_items,
  public.vexim_research_pain_quotes,
  public.vexim_research_improvement_specs,
  public.vexim_research_llm_runs
  to authenticated, anon, service_role;

commit;
