-- ============================================================================
-- VÁ NHANH: thiếu view public.vexim_research_* sau khi áp 0025/0026
-- ----------------------------------------------------------------------------
-- Triệu chứng: web báo
--   "Could not find the table 'public.vexim_research_assessments'
--    in the schema cache"
-- trong khi các RPC vexim_research_* vẫn gọi được (đoạn CREATE VIEW cuối
-- các file 0025/0026 không được áp, hoặc áp theo từng khối bị thiếu).
--
-- File này CHỈ chứa CREATE OR REPLACE VIEW + GRANT lấy nguyên từ mục 11 của
-- 0025 (6 view) và mục 7 của 0026 (4 view) → idempotent, chạy lại bao nhiêu
-- lần cũng an toàn, không động tới dữ liệu. Chạy bằng Supabase Dashboard →
-- SQL Editor trên ĐÚNG project mà NEXT_PUBLIC_SUPABASE_URL của web đang trỏ
-- tới. Yêu cầu: 0025 và 0026 đã được áp (bảng research.assessments,
-- research.collection_runs, research.competitor_snapshots, reviews_raw,
-- credit_ledger phải tồn tại).
-- ============================================================================

-- ---------- 6 view của 0025_module_8_research_core.sql (mục 11) -----------

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

-- ---------- 4 view của 0026_module_8_research_collection.sql (mục 7) ------

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


-- =================== Module 8 G4 (migration 0028) =========================
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

create or replace view public.vexim_research_llm_runs
with (security_invoker = true) as
select l.assessment_id, a.code, l.section_key, l.chunk_index, l.provider, l.model,
       l.prompt_hash, l.tokens_in, l.tokens_out, l.cost_usd, l.status, l.error,
       l.created_by, l.created_at
  from research.llm_runs l
  join research.assessments a on a.id = l.assessment_id;

grant select on public.vexim_research_runs, public.vexim_research_competitors,
  public.vexim_research_reviews, public.vexim_research_credit_monthly
  to authenticated, anon, service_role;


create or replace view public.vexim_research_report_versions
with (security_invoker = true) as
select v.assessment_id, a.code, v.version_no, v.status, v.title, v.snapshot,
       v.change_note, v.submitted_at, v.approved_at,
       cu.display_name as created_name, ap.display_name as approver_name,
       v.created_at, v.updated_at
  from research.report_versions v
  join research.assessments a on a.id = v.assessment_id
  left join iam.user_profiles cu on cu.id = v.created_by
  left join iam.user_profiles ap on ap.id = v.approver_id;

create or replace view public.vexim_research_report_sections
with (security_invoker = true) as
select s.assessment_id, a.code, s.report_version, s.section_key, s.status,
       s.content, s.source, s.generated_model,
       s.verified_name, s.verified_at, s.updated_at,
       s.lock_owner_name as lock_owner, s.locked_at,
       (s.lock_owner = auth.uid()) as lock_is_mine,
       (s.lock_owner is not null and s.lock_owner <> auth.uid()
         and s.locked_at > now() - interval '2 minutes') as lock_active_other
  from research.report_sections s
  join research.assessments a on a.id = s.assessment_id;

create or replace view public.vexim_research_veto_acks
with (security_invoker = true) as
select k.assessment_id, a.code, k.version_no, k.rule_code,
       k.acknowledged_name, k.note, k.created_at
  from research.veto_acknowledgements k
  join research.assessments a on a.id = k.assessment_id;

-- G7 (0030): lịch sử BSR cho engine mùa vụ
create or replace view public.vexim_research_bsr_history
with (security_invoker = true) as
select h.id, h.assessment_id, h.org_id, h.asin, h.observed_at,
       h.bsr_rank, h.source, h.created_at
  from research.bsr_history h;

grant select on
  public.vexim_research_pain_clusters, public.vexim_research_pain_items,
  public.vexim_research_pain_quotes, public.vexim_research_improvement_specs,
  public.vexim_research_llm_runs,
  public.vexim_research_report_versions, public.vexim_research_report_sections,
  public.vexim_research_veto_acks, public.vexim_research_bsr_history
  to authenticated, anon, service_role;

-- Bắt PostgREST nạp lại schema cache (bắt buộc sau khi tạo view thủ công)
notify pgrst, 'reload schema';

-- Kiểm chứng (phải trả về ĐỦ 10 dòng):
-- select table_name from information_schema.views
--  where table_schema = 'public' and table_name like 'vexim_research_%'
--  order by table_name;
--
-- assessments, competitors, credit_monthly, inputs, pnl, roadmap,
-- reviews, runs, scorecards, vetoes,
-- pain_clusters, pain_items, pain_quotes, improvement_specs, llm_runs (G4),
-- report_versions, report_sections, veto_acks (G5, 18 view)
