-- ============================================================================
-- 0027 — MODULE 8 G3: WORKER GHI ĐIỂM TRỤ & VETO TỪ DỮ LIỆU THU THẬP
-- ============================================================================
-- Sau bước products/sales (0026), engine tập trung thị phần (concentration.ts)
-- chấm trụ "competition" và sinh veto cr3_above_65 / amazon1p_top3. Worker
-- (service_role) ghi xuống qua 2 RPC idempotent này; web KHÔNG gọi được.
--
-- Vì sao idempotent theo (assessment_id, rule_code): chạy lại collection
-- không được nhân đôi cờ veto; điểm trụ chỉ giữ giá trị MỚI NHẤT.
-- ============================================================================

begin;

-- Mỗi luật veto tối đa 1 dòng/hồ sơ (phục vụ upsert idempotent của worker).
create unique index if not exists uq_research_veto_assessment_rule
  on research.veto_flags (assessment_id, rule_code);

-- ----------------------------------------------------------------------------
-- RPC 1: set điểm 1 trụ scorecard (worker). Score NULL = chưa đủ cơ sở.
-- ----------------------------------------------------------------------------
create or replace function public.vexim_research_worker_set_pillar(
  p_assessment uuid,
  p_pillar     text,
  p_score      numeric,
  p_confidence text,
  p_reason     text,
  p_metrics    jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql security definer
set search_path = research, iam, public, pg_catalog
as $$
begin
  perform research.worker_only();
  if p_pillar not in ('finance','competition','demand','differentiation','logistics') then
    raise exception '[M8-W] trụ không hợp lệ: %', p_pillar;
  end if;
  if p_score is not null and (p_score < 1 or p_score > 10) then
    raise exception '[M8-W] điểm trụ phải trong khoảng 1..10 (nhận %)', p_score;
  end if;
  if not exists (select 1 from research.assessments where id = p_assessment) then
    raise exception '[M8-W] không thấy hồ sơ %', p_assessment;
  end if;

  insert into research.scorecards
    (assessment_id, pillar, weight, score, confidence, reason, metrics, computed_at)
  values (
    p_assessment, p_pillar,
    case p_pillar when 'finance' then 0.25 when 'competition' then 0.25
                  when 'demand' then 0.2 when 'differentiation' then 0.2
                  when 'logistics' then 0.1 end,
    p_score,
    nullif(p_confidence, ''),
    coalesce(p_reason, ''),
    coalesce(p_metrics, '{}'::jsonb),
    now()
  )
  on conflict (assessment_id, pillar) do update set
    score = excluded.score,
    confidence = excluded.confidence,
    reason = excluded.reason,
    metrics = excluded.metrics,
    computed_at = now();

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.vexim_research_worker_set_pillar(uuid, text, numeric, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.vexim_research_worker_set_pillar(uuid, text, numeric, text, text, jsonb)
  to service_role;

-- ----------------------------------------------------------------------------
-- RPC 2: ghi cờ veto idempotent theo (assessment_id, rule_code) (worker).
-- ----------------------------------------------------------------------------
create or replace function public.vexim_research_worker_add_veto(
  p_assessment uuid,
  p_rule_code  text,
  p_severity   text,
  p_title      text,
  p_detail     text,
  p_evidence   jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql security definer
set search_path = research, iam, public, pg_catalog
as $$
declare
  v_red int;
  v_total int;
begin
  perform research.worker_only();
  if p_rule_code not in ('margin_below_20','cr3_above_65','amazon1p_top3','cert_barrier','oversize') then
    raise exception '[M8-W] mã veto không hợp lệ: %', p_rule_code;
  end if;
  if p_severity not in ('red','warning') then
    raise exception '[M8-W] mức veto không hợp lệ: %', p_severity;
  end if;

  insert into research.veto_flags
    (assessment_id, rule_code, severity, title, detail, evidence)
  values (p_assessment, p_rule_code, p_severity, coalesce(p_title,''), coalesce(p_detail,''),
          coalesce(p_evidence, '{}'::jsonb))
  on conflict (assessment_id, rule_code) do update set
    severity = excluded.severity,
    title = excluded.title,
    detail = excluded.detail,
    evidence = excluded.evidence,
    created_at = now();

  -- Cập nhật bộ đếm trên bảng hồ sơ để list không phải đếm lại.
  select count(*), count(*) filter (where severity = 'red')
    into v_total, v_red
    from research.veto_flags where assessment_id = p_assessment;
  update research.assessments
     set veto_count = v_total, red_veto_count = v_red
   where id = p_assessment;

  return jsonb_build_object('ok', true, 'vetoCount', v_total, 'redVetoCount', v_red);
end;
$$;

revoke all on function public.vexim_research_worker_add_veto(uuid, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.vexim_research_worker_add_veto(uuid, text, text, text, text, jsonb)
  to service_role;

-- Gỡ các cờ veto do engine tính mà lần quét MỚI NHẤT không còn xác nhận
-- (vd thị trường thay đổi sau khi quét lại). Chỉ worker gọi; giữ nguyên các
-- cờ G1 (margin_below_20, cert_barrier, oversize) vì chúng thuộc giả định.
create or replace function public.vexim_research_worker_clear_vetoes(
  p_assessment uuid,
  p_rule_codes text[]
)
returns jsonb
language plpgsql security definer
set search_path = research, iam, public, pg_catalog
as $$
declare
  v_red int;
  v_total int;
begin
  perform research.worker_only();
  delete from research.veto_flags
   where assessment_id = p_assessment
     and rule_code = any (coalesce(p_rule_codes, array['cr3_above_65','amazon1p_top3']));

  select count(*), count(*) filter (where severity = 'red')
    into v_total, v_red
    from research.veto_flags where assessment_id = p_assessment;
  update research.assessments
     set veto_count = v_total, red_veto_count = v_red
   where id = p_assessment;
  return jsonb_build_object('ok', true, 'vetoCount', v_total, 'redVetoCount', v_red);
end;
$$;

revoke all on function public.vexim_research_worker_clear_vetoes(uuid, text[])
  from public, anon, authenticated;
grant execute on function public.vexim_research_worker_clear_vetoes(uuid, text[])
  to service_role;

commit;
