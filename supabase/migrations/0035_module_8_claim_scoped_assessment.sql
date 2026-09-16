-- ============================================================================
-- 0035 — MODULE 8: claim lượt quét THEO HỒ SƠ (assessment-scoped claim)
-- ============================================================================
-- SỰ CỐ 17/09/2026: bấm "▶ Phân tích pain bằng LLM (chạy ngay)" trên hồ sơ A
-- nhưng kết quả hiện ở hồ sơ khác / hàng đợi hồ sơ A vẫn 'queued'. Nguyên
-- nhân: vexim_research_worker_claim_run chỉ lọc theo kind và lấy lượt queued
-- CŨ NHẤT TOÀN CỤC (mọi hồ sơ) — nút "chạy ngay" của hồ sơ này có thể nhặt
-- trúng lượt của hồ sơ khác.
--
-- SỬA: thêm tham số p_assessment (null = không lọc, giữ hành vi cron/CLI vét
-- toàn cục). Định nghĩa lại hàm với signature MỚI (text, uuid) và XOÁ bản
-- (text) cũ để chỉ còn một đường claim duy nhất. Giữ nguyên khối thu hồi lượt
-- kẹt 'running' quá 10 phút của 0034.
-- ============================================================================

begin;

drop function if exists public.vexim_research_worker_claim_run(text);

create or replace function public.vexim_research_worker_claim_run(
  p_kind text default null,
  p_assessment uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = research, iam, public, pg_catalog
as $$
declare
  v_run record;
begin
  perform research.worker_only();

  -- Thu hồi lượt kẹt: worker chết giữa chừng (Vercel cắt ở 60s, rớt mạng…)
  -- để lại status='running' vĩnh viễn; enqueue lại bị chặn trùng theo kind.
  update research.collection_runs
     set status = 'queued', started_at = null
   where status = 'running'
     and started_at < now() - interval '10 minutes';

  select r.*, a.org_id, a.marketplace, a.keywords, a.seed_asin, a.category_node, a.title
    into v_run
    from research.collection_runs r
    join research.assessments a on a.id = r.assessment_id
   where r.status = 'queued'
     and (p_kind is null or r.kind = p_kind)
     and (p_assessment is null or r.assessment_id = p_assessment)
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

revoke all on function public.vexim_research_worker_claim_run(text, uuid) from public, anon, authenticated;
grant execute on function public.vexim_research_worker_claim_run(text, uuid) to service_role;

commit;
