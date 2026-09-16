-- ============================================================================
-- 0033 — MODULE 8: SỬA LỖI '[M8] không xác định được tổ chức hợp lệ cho báo cáo'
-- ============================================================================
-- SỰ CỐ 16/09/2026: bấm 'Lưu hồ sơ thẩm định' trên /research/new/phan-tich ra
-- lỗi '[M8] không xác định được tổ chức hợp lệ cho báo cáo'.
--
-- NGUYÊN NHÂN: vexim_research_create_assessment (0025, mục 10) chỉ đọc org từ
-- iam.user_profiles.org_id. Nhân viên VEXIM có org_id = NULL THEO THIẾT KẾ
-- (chú thích cột ở 0001: 'null nếu là nhân viên VEXIM') nên RPC không còn org
-- để gắn hồ sơ — dù research.can_read_assessment() chấp nhận vexim_employee.
--
-- SỬA: chuỗi fallback ĐÚNG THÔNG LỆ đã dùng ở 0032_shop_admin:
--   payload.orgId → org của người tạo → org slug 'vexim' → org nội bộ đầu tiên.
-- Chỉ ĐỊNH NGHĨA LẠI hàm (cùng signature), không đụng bảng/RLS/chính sách nào.
-- ============================================================================

begin;

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

  -- Org: ưu tiên payload.orgId → org của người tạo → org VEXIM → org nội bộ đầu
  -- tiên. Thông lệ 0032_shop_admin: nhân viên VEXIM có org_id = NULL THEO THIẾT KẾ
  -- (sự cố 16/09/2026: bấm Lưu hồ sơ thẩm định ra '[M8] không xác định được tổ
  -- chức hợp lệ cho báo cáo' vì RPC cũ chỉ đọc org_id từ user_profiles).
  v_org := nullif(p_payload->>'orgId', '')::uuid;
  if v_org is null then
    v_org := (select org_id from iam.user_profiles where id = v_actor);
  end if;
  if v_org is null then
    select o.id into v_org from iam.organizations o where o.slug = 'vexim' limit 1;
  end if;
  if v_org is null then
    select o.id into v_org
      from iam.organizations o where o.is_internal order by o.created_at limit 1;
  end if;
  if v_org is null or not research.can_read_assessment(v_org) then
    raise exception '[M8] không xác định được tổ chức hợp lệ cho báo cáo — chạy migration 0007 (tạo org VEXIM) trước';
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

commit;
