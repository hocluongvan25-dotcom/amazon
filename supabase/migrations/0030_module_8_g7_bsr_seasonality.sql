-- ============================================================================
-- 0030_module_8_g7_bsr_seasonality.sql
-- Module 8 — G7: lịch sử BSR & mùa vụ + trạng thái ngân sách credits.
--
--   1. research.bsr_history  — chuỗi BSR theo ASIN/ngày, gộp mọi hồ sơ cùng
--      org: nạp từ competitor_snapshots (Rainforest tích lũy, không tốn thêm
--      credit) HOẶC backfill Keepa (sau này, cần KEEPA_API_KEY).
--   2. RPC worker: upsert điểm BSR, refresh từ snapshot, truy vấn credit tháng.
--   3. View public.vexim_research_bsr_history (security_invoker + RLS).
--
-- Quy ước an toàn giữ nguyên như G2/G5: worker dùng service_role qua RPC;
-- khách chỉ đọc dữ liệu org mình; thiếu điểm → engine trả "chưa đủ cơ sở".
-- Chạy idempotent.
-- ============================================================================

-- ============================================================================
-- 1. BẢNG LỊCH SỬ BSR
-- ============================================================================
create table if not exists research.bsr_history (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references iam.organizations(id) on delete cascade,
  assessment_id  uuid references research.assessments(id) on delete set null,
  asin           text not null,
  observed_at    date not null,
  bsr_rank       int,                          -- null khi nguồn không có rank (Keepa -1)
  source         text not null default 'rainforest'
                 check (source in ('rainforest','keepa')),
  payload        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  -- mỗi ASIN/org/ngày/nguồn chỉ 1 điểm (gộp các lần quét trong ngày)
  unique (org_id, asin, observed_at, source)
);

create index if not exists idx_research_bsr_assessment
  on research.bsr_history (assessment_id, asin, observed_at);
create index if not exists idx_research_bsr_org_date
  on research.bsr_history (org_id, asin, observed_at desc);

comment on table research.bsr_history is
  'M8 G7: chuỗi BSR phục vụ mùa vụ/xu hướng; nạp từ snapshot Rainforest (0 credit) hoặc backfill Keepa. Engine web tính seasonality, thiếu điểm thì "chưa đủ cơ sở".';

alter table research.bsr_history enable row level security;

drop policy if exists rls_read_bsr_history on research.bsr_history;
create policy rls_read_bsr_history on research.bsr_history
  for select using (exists (
    select 1 from iam.user_profiles up
     where up.id = auth.uid()
       and (iam.has_role(array['super_admin'])
            or up.vexim_employee = true
            or up.org_id = bsr_history.org_id)
  ));

grant select on research.bsr_history to authenticated;
grant all on research.bsr_history to service_role;

-- ============================================================================
-- 2. RPC WORKER: UPSERT ĐIỂM BSR (Keepa backfill hoặc nguồn khác)
-- ============================================================================
-- p_points: [{ "asin": text, "observedAt": ISO/date, "bsrRank": int|null,
--              "source": "keepa"|"rainforest", "assessmentId": uuid|null }]
create or replace function public.vexim_research_worker_upsert_bsr_points(
  p_org    uuid,
  p_points jsonb
)
returns jsonb
language plpgsql security definer
set search_path = research, iam, public, pg_catalog
as $$
declare v_n int := 0; v_pt jsonb;
begin
  perform research.worker_only();
  if p_org is null then raise exception '[M8] thiếu org cho điểm BSR'; end if;
  if not exists (select 1 from iam.organizations where id = p_org) then
    raise exception '[M8] org % không tồn tại', p_org;
  end if;

  for v_pt in select jsonb_array_elements(coalesce(p_points, '[]'::jsonb))
  loop
    insert into research.bsr_history (org_id, assessment_id, asin, observed_at, bsr_rank, source, payload)
    values (
      p_org,
      nullif(v_pt->>'assessmentId', '')::uuid,
      v_pt->>'asin',
      (v_pt->>'observedAt')::timestamptz::date,
      case when v_pt->>'bsrRank' is null or v_pt->>'bsrRank' = '' then null
           else (v_pt->>'bsrRank')::int end,
      coalesce(nullif(v_pt->>'source', ''), 'keepa'),
      coalesce(v_pt->'payload', '{}'::jsonb)
    )
    on conflict (org_id, asin, observed_at, source) do update
      set bsr_rank = coalesce(excluded.bsr_rank, research.bsr_history.bsr_rank),
          assessment_id = coalesce(excluded.assessment_id, research.bsr_history.assessment_id),
          payload = excluded.payload;
    v_n := v_n + 1;
  end loop;

  return jsonb_build_object('ok', true, 'points', v_n);
end;
$$;

revoke all on function public.vexim_research_worker_upsert_bsr_points(uuid, jsonb) from public, anon;
grant execute on function public.vexim_research_worker_upsert_bsr_points(uuid, jsonb) to service_role;

-- ============================================================================
-- 3. RPC WORKER: GỘP BSR TỪ SNAPSHOT RAINFOREST (0 credit, chạy sau products)
-- ============================================================================
create or replace function public.vexim_research_worker_refresh_bsr_from_snapshots(
  p_assessment uuid
)
returns jsonb
language plpgsql security definer
set search_path = research, iam, public, pg_catalog
as $$
declare v_org uuid; v_n int;
begin
  perform research.worker_only();
  select org_id into v_org from research.assessments where id = p_assessment;
  if v_org is null then raise exception '[M8] không thấy hồ sơ %', p_assessment; end if;

  with latest_per_day as (
    -- mỗi ASIN/ngày lấy lần quét MUỘN NHẤT trong ngày có bsr_rank
    select distinct on (s.asin, s.created_at::date)
           s.asin, s.created_at::date as observed_at, s.bsr_rank
      from research.competitor_snapshots s
     where s.assessment_id = p_assessment
       and s.bsr_rank is not null and s.bsr_rank > 0
     order by s.asin, s.created_at::date, s.created_at desc
  ), ins as (
    insert into research.bsr_history (org_id, assessment_id, asin, observed_at, bsr_rank, source)
    select v_org, p_assessment, l.asin, l.observed_at, l.bsr_rank, 'rainforest'
      from latest_per_day l
    on conflict (org_id, asin, observed_at, source) do update
      set bsr_rank = excluded.bsr_rank,
          assessment_id = coalesce(research.bsr_history.assessment_id, p_assessment)
    returning 1
  )
  select count(*) into v_n from ins;

  return jsonb_build_object('ok', true, 'points', v_n);
end;
$$;

revoke all on function public.vexim_research_worker_refresh_bsr_from_snapshots(uuid) from public, anon;
grant execute on function public.vexim_research_worker_refresh_bsr_from_snapshots(uuid) to service_role;

-- ============================================================================
-- 4. RPC: TRẠNG THÁI CREDIT THÁNG (worker guard + màn hình nội bộ)
-- ============================================================================
-- Worker (service_role) hỏi cho BẤT KỲ org; phiên đăng nhập chỉ hỏi org của
-- mình (khách) hoặc mọi org (nhân viên/super_admin, giống policy sổ cái).
create or replace function public.vexim_research_credit_status(
  p_org   uuid default null,
  p_month text default null
)
returns jsonb
language plpgsql security definer
set search_path = research, iam, public, pg_catalog
as $$
declare
  v_org uuid := p_org;
  v_month text := coalesce(p_month, to_char(now(), 'YYYY-MM'));
  v_spent int; v_runs int; v_last timestamptz;
  v_is_worker boolean;
begin
  v_is_worker := current_setting('role', true) = 'service_role';
  if not v_is_worker then
    if auth.uid() is null then raise exception '[M8] yêu cầu chưa đăng nhập'; end if;
    if v_org is null then
      select org_id into v_org from iam.user_profiles where id = auth.uid();
    end if;
    if v_org is null then
      -- nhân viên không gán org vẫn được xem mọi org; mặc định trả 0/rỗng
      if not exists (
        select 1 from iam.user_profiles up
         where up.id = auth.uid()
           and (iam.has_role(array['super_admin']) or up.vexim_employee = true)
      ) then
        raise exception '[M8] không xác định org để xem credit';
      end if;
    elsif not exists (
      select 1 from iam.user_profiles up
       where up.id = auth.uid()
         and (iam.has_role(array['super_admin']) or up.vexim_employee = true or up.org_id = v_org)
    ) then
      raise exception '[M8] không được xem credit của org khác';
    end if;
  end if;

  if v_org is null then
    return jsonb_build_object(
      'ok', true, 'orgId', null, 'month', v_month,
      'creditsSpent', 0, 'runsCount', 0, 'lastSpendAt', null);
  end if;

  select coalesce(sum(case when l.delta < 0 then -l.delta else 0 end), 0),
         count(distinct l.run_id),
         max(l.created_at)
    into v_spent, v_runs, v_last
    from research.credit_ledger l
   where l.org_id = v_org
     and to_char(date_trunc('month', l.created_at), 'YYYY-MM') = v_month;

  return jsonb_build_object(
    'ok', true, 'orgId', v_org, 'month', v_month,
    'creditsSpent', v_spent, 'runsCount', v_runs, 'lastSpendAt', v_last);
end;
$$;

revoke all on function public.vexim_research_credit_status(uuid, text) from public, anon;
grant execute on function public.vexim_research_credit_status(uuid, text)
  to authenticated, service_role;

-- ============================================================================
-- 5. VIEW ĐỌC LỊCH SỬ BSR (security_invoker để RLS nguyên vẹn)
-- ============================================================================
create or replace view public.vexim_research_bsr_history
with (security_invoker = true) as
select h.id, h.assessment_id, h.org_id, h.asin, h.observed_at,
       h.bsr_rank, h.source, h.created_at
  from research.bsr_history h;

grant select on public.vexim_research_bsr_history
  to authenticated, anon, service_role;
