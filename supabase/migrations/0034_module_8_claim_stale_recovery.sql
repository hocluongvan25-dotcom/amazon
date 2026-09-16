-- ============================================================================
-- 0034 — MODULE 8: THU HỒI LƯỢT QUÉT KẸT 'running' (stale-run recovery)
-- ============================================================================
-- SỰ CỐ TIỀM ẨN phát hiện khi tư vấn chạy hàng đợi bằng cron ngoài
-- (cron-job.org, 16/09/2026): vexim_research_worker_claim_run (0026) đặt
-- status='running' khi nhận việc, nhưng KHÔNG có đường thu hồi nếu worker chết
-- giữa chừng — Vercel cắt hàm ở trần 60s, rớt mạng, hết credits Rainforest…
-- Lượt quét sẽ nằm 'running' VĨNH VIỄN, và RPC xếp hàng chặn trùng theo
-- (queued|running) cùng kind ⇒ kind đó của hồ sơ TẮC CỨNG, không xếp lại được.
--
-- SỬA: khi claim, mọi lượt 'running' đã bắt đầu quá 10 phút được coi là chết
-- → đặt lại 'queued' để lượt claim này (hoặc lượt sau) nhặt chạy lại. 10 phút
-- dài hơn mọi lượt quét hợp lệ trên Vercel (trần 60s) và cả lượt CLI dài
-- (reviews nhiều trang ~vài phút), nên không thu hồi nhầm việc đang chạy thật.
--
-- Chỉ ĐỊNH NGHĨA LẠI hàm (cùng signature), không đụng bảng/RLS/policy.
-- ============================================================================

begin;

create or replace function public.vexim_research_worker_claim_run(p_kind text default null)
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

commit;
