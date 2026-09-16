-- ============================================================================
-- 0029 — MODULE 8 G5: REPORT CANVAS (TipTap narrative, version, lock, ký)
-- ============================================================================
-- Nguyên tắc vàng (docs/ke-hoach... mục 1.4) được ÉP Ở DATABASE:
--   • SỐ là metric token / CÂU TRÍCH là quote chip: validate_report_doc duyệt
--     node whitelist + đối chiếu MỌI quoteChip nguyên văn reviews_raw (dùng
--     lại research.quote_matches_body của 0028). Câu bịa → chặn lưu section.
--   • Version gửi duyệt/trưởng phòng duyệt là BẤT BIẾN (trigger guard); mở
--     lại bằng cách nhân bản version draft mới, không sửa bản đã chốt.
--   • Duyệt báo cáo: đủ section bắt buộc verified + nhìn nhận MỌI veto đỏ.
--   • Khóa bi quan 2 phút khi đang soát (chống 2 người cùng sửa).
--
-- Ghi đi qua RPC security-definer theo PHIÊN NGƯỜI DÙNG (analyst/dept_lead);
-- worker KHÔNG ghi bảng này. llm_runs mở thêm section_key narrative_*.
-- ============================================================================

begin;

-- llm_runs: chấp nhận nhật ký narrative từng section của G5.
alter table research.llm_runs drop constraint if exists llm_runs_section_key_check;
alter table research.llm_runs
  add constraint llm_runs_section_key_check
  check (section_key in ('pain_map','pain_reduce') or section_key ~ '^narrative_.+');

-- ----------------------------------------------------------------------------
-- 1. BẢNG
-- ----------------------------------------------------------------------------

create table if not exists research.report_versions (
  id           uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references research.assessments(id) on delete cascade,
  version_no   int not null check (version_no > 0),
  status       text not null default 'draft'
               check (status in ('draft','in_review','changes_requested','approved','published','stale')),
  title        text,
  snapshot     jsonb,                       -- chụp bất biến khi gửi duyệt/duyệt
  created_by   uuid references iam.user_profiles(id),
  approver_id  uuid references iam.user_profiles(id),
  change_note  text,
  submitted_at timestamptz,
  approved_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (assessment_id, version_no)
);

-- Tối đa 1 bản nháp đang mở cho mỗi hồ sơ.
create unique index if not exists uq_report_draft_one
  on research.report_versions (assessment_id) where status = 'draft';

create index if not exists idx_report_versions_assessment
  on research.report_versions (assessment_id, version_no desc);

create table if not exists research.report_sections (
  id              uuid primary key default gen_random_uuid(),
  assessment_id   uuid not null references research.assessments(id) on delete cascade,
  report_version  int not null,
  section_key     text not null,
  status          text not null default 'drafted'
                  check (status in ('drafted','in_review','verified')),
  content         jsonb not null default '{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb,
  source          text not null default 'empty'
                  check (source in ('empty','ai','human','human_regen')),
  llm_run_id      uuid references research.llm_runs(id) on delete set null,
  generated_model text,
  verified_by     uuid references iam.user_profiles(id),
  verified_name   text,
  verified_at     timestamptz,
  lock_owner      uuid references iam.user_profiles(id),
  lock_owner_name text,
  locked_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (assessment_id, report_version, section_key),
  foreign key (assessment_id, report_version)
    references research.report_versions (assessment_id, version_no) on delete cascade
);

create index if not exists idx_report_sections_version
  on research.report_sections (assessment_id, report_version);

create table if not exists research.veto_acknowledgements (
  id               uuid primary key default gen_random_uuid(),
  assessment_id    uuid not null references research.assessments(id) on delete cascade,
  version_no       int not null,
  rule_code        text not null,
  acknowledged_by  uuid references iam.user_profiles(id),
  acknowledged_name text,
  note             text,
  created_at       timestamptz not null default now(),
  unique (assessment_id, version_no, rule_code)
);

-- ----------------------------------------------------------------------------
-- 2. DANH SÁCH SECTION BẮT BUỘC (khớp REQUIRED_SECTIONS trong domain/report.ts)
-- ----------------------------------------------------------------------------
create or replace function research.report_required_sections()
returns text[]
language sql immutable
as $$
  select array[
    'exec_verdict','fin_pnl','mkt_conclusion','rd_clusters',
    'rd_specsheet','roadmap_gates','risk_register','appendix_signoff'
  ];
$$;

-- ----------------------------------------------------------------------------
-- 3. DUYỆT HÌNH THÁI TIPTAP DOC + ĐỐI CHIẾU QUOTE NGAY TẠI DB
-- ----------------------------------------------------------------------------

/** Duyệt đệ quy MỌI node trong TipTap doc, trả 1 dòng/node. */
create or replace function research.doc_nodes(p_doc jsonb)
returns table(n jsonb)
language plpgsql
immutable
as $$
begin
  return query
  with recursive walk as (
    select value as n
      from jsonb_array_elements(coalesce(p_doc->'content', '[]'::jsonb))
    union all
    select child.value
      from walk w
      cross join lateral
        jsonb_array_elements(case when jsonb_typeof(w.n->'content') = 'array'
                                  then w.n->'content' else '[]'::jsonb end) child
  )
  select w.n from walk w;
end;
$$;

/**
 * Kiểm 1 section content:
 *  - gốc type='doc'; node/mark nằm trong whitelist;
 *  - metricToken đủ key+value; quoteChip đủ reviewId+quote;
 *  - MỌI quoteChip trỏ đúng source_review_id của hồ sơ và câu trích khớp
 *    nguyên văn reviews_raw (research.quote_matches_body, 0028).
 */
create or replace function research.validate_report_doc(
  p_assessment uuid,
  p_content    jsonb
)
returns void
language plpgsql
as $$
declare
  v_allowed_nodes text[] := array[
    'doc','paragraph','heading','bulletList','orderedList','listItem',
    'text','metricToken','quoteChip','hardBreak'];
  v_allowed_marks text[] := array['bold','italic','link'];
  n jsonb;
  mk jsonb;
  v_body text;
  v_asin text;
begin
  if p_content is null or p_content->>'type' is distinct from 'doc' then
    raise exception '[M8-R] nội dung section phải là TipTap doc có type=doc';
  end if;

  for n in select research.doc_nodes(p_content)
  loop
    if not (n->>'type') = any(v_allowed_nodes) then
      raise exception '[M8-R] node không được phép trong báo cáo: %', coalesce(n->>'type','?');
    end if;

    if (n->>'type') = 'metricToken' then
      if nullif(n->'attrs'->>'key','') is null or nullif(n->'attrs'->>'value','') is null then
        raise exception '[M8-R] metric chip thiếu key/value';
      end if;
    end if;

    if (n->>'type') = 'quoteChip' then
      if nullif(n->'attrs'->>'reviewId','') is null or nullif(n->'attrs'->>'quote','') is null then
        raise exception '[M8-R] quote chip thiếu reviewId/quote';
      end if;
      select body, asin into v_body, v_asin
        from research.reviews_raw
       where assessment_id = p_assessment
         and source_review_id = n->'attrs'->>'reviewId'
       limit 1;
      if not found then
        raise exception '[M8-R] quote trỏ review % không thuộc hồ sơ này', n->'attrs'->>'reviewId';
      end if;
      if not research.quote_matches_body(n->'attrs'->>'quote', v_body) then
        raise exception '[M8-R] câu trích không truy nguyên văn review gốc (%)', n->'attrs'->>'reviewId';
      end if;
      if nullif(n->'attrs'->>'asin','') is not null and n->'attrs'->>'asin' <> v_asin then
        raise exception '[M8-R] quote gắn sai ASIN so với review gốc (%)', n->'attrs'->>'reviewId';
      end if;
    end if;

    if jsonb_typeof(n->'marks') = 'array' then
      for mk in select * from jsonb_array_elements(n->'marks')
      loop
        if not (mk->>'type') = any(v_allowed_marks) then
          raise exception '[M8-R] mark không được phép: %', mk->>'type';
        end if;
      end loop;
    end if;
  end loop;
end;
$$;

-- ----------------------------------------------------------------------------
-- 4. TRIGGER BẤT BIẾN CHO VERSION ĐÃ GỬI/DUYỆT
-- ----------------------------------------------------------------------------
create or replace function research.report_version_guard()
returns trigger
language plpgsql
as $$
begin
  if current_setting('app.report_guard', true) = 'bypass' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception '[M8-R] không xóa được version đã gửi duyệt/duyệt (v%, %)',
        old.version_no, old.status using errcode = 'insufficient_privilege';
    end if;
    return old;
  end if;
  -- UPDATE
  if old.status in ('in_review','approved','published') then
    -- trạng thái được LUỒN CHÍNH THỐNG chuyển: in_review→(changes/approved),
    -- approved→published (G6). Mọi thay đổi nội dung khác đều bị chặn.
    if new.status = old.status then
      raise exception '[M8-R] version % (%) đã chốt, không sửa nội dung được',
        old.version_no, old.status using errcode = 'insufficient_privilege';
    end if;
    if not (
      (old.status = 'in_review' and new.status in ('changes_requested','approved'))
      or (old.status = 'approved' and new.status in ('published','stale'))
    ) then
      raise exception '[M8-R] chuyển trạng thái bất hợp lệ: % → %', old.status, new.status
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_report_version_guard on research.report_versions;
create trigger trg_report_version_guard
  before update or delete on research.report_versions
  for each row execute function research.report_version_guard();

create or replace function research.report_section_guard()
returns trigger
language plpgsql
as $$
declare v_status text;
begin
  if current_setting('app.report_guard', true) = 'bypass' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  select status into v_status from research.report_versions v
   where v.assessment_id = case when tg_op='DELETE' then old.assessment_id else new.assessment_id end
     and v.version_no    = case when tg_op='DELETE' then old.report_version else new.report_version end;
  if v_status is not null and v_status <> 'draft' then
    raise exception '[M8-R] section của version đã % là bất biến', v_status
      using errcode = 'insufficient_privilege';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists trg_report_section_guard on research.report_sections;
create trigger trg_report_section_guard
  before update or delete on research.report_sections
  for each row execute function research.report_section_guard();

-- ----------------------------------------------------------------------------
-- 5. RLS
-- ----------------------------------------------------------------------------
alter table research.report_versions      enable row level security;
alter table research.report_sections      enable row level security;
alter table research.veto_acknowledgements enable row level security;

do $$
declare t text;
begin
  foreach t in array array['report_versions','report_sections','veto_acknowledgements'] loop
    execute format('drop policy if exists rls_read_research_%1$s on research.%1$I', t);
    execute format($f$
      create policy rls_read_research_%1$s on research.%1$I
        for select using (exists (
          select 1 from research.assessments a where a.id = assessment_id
            and research.can_read_assessment(a.org_id)))
    $f$, t);
  end loop;
end $$;

grant select on research.report_versions, research.report_sections,
  research.veto_acknowledgements to authenticated, anon, service_role;
grant all on research.report_versions, research.report_sections,
  research.veto_acknowledgements to service_role;

-- ----------------------------------------------------------------------------
-- 6. RPC: MỞ BẢN NHÁP
-- ----------------------------------------------------------------------------
create or replace function public.vexim_research_report_open_draft(p_assessment uuid)
returns jsonb
language plpgsql security definer
set search_path = research, iam, public, pg_catalog
as $$
declare
  v_org uuid; v_no int; v_status text; v_me uuid; v_name text;
begin
  if auth.uid() is null then raise exception '[M8] yêu cầu chưa đăng nhập'; end if;
  if not research.can_manage_assessment() then
    raise exception '[M8] vai trò không được soát báo cáo';
  end if;
  select org_id into v_org from research.assessments where id = p_assessment;
  if v_org is null or not research.can_read_assessment(v_org) then
    raise exception '[M8] không thấy hồ sơ hợp lệ';
  end if;
  v_me := auth.uid();
  v_name := (select display_name from iam.user_profiles where id = v_me);

  select version_no, status into v_no, v_status from research.report_versions
   where assessment_id = p_assessment and status = 'draft' limit 1;
  if found then
    return jsonb_build_object('ok', true, 'versionNo', v_no, 'status', v_status, 'created', false);
  end if;

  select coalesce(max(version_no),0)+1 into v_no from research.report_versions
   where assessment_id = p_assessment;
  -- Nếu version cuối là changes_requested/in_review cũ kẹt (không có draft do
  -- request_changes đã nhân bản sẵn) vẫn tạo đúng số tiếp theo.
  insert into research.report_versions (assessment_id, version_no, status, created_by, title)
  values (p_assessment, v_no, 'draft', v_me,
          (select 'Báo cáo thẩm định v' || v_no))
  on conflict (assessment_id, version_no) do nothing;

  insert into iam.audit_logs (actor_id, module, action, entity, after_value, result)
  values (v_me, 'm8_research', 'report.draft_open', p_assessment::text,
          jsonb_build_object('versionNo', v_no), 'ok');
  return jsonb_build_object('ok', true, 'versionNo', v_no, 'status', 'draft', 'created', true);
end;
$$;

grant execute on function public.vexim_research_report_open_draft(uuid)
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 7. RPC: KHÓA / NHẢ KHÓA SECTION (khóa bi quan, hết hạn sau 2 phút)
-- ----------------------------------------------------------------------------
create or replace function public.vexim_research_report_section_lock(
  p_assessment uuid,
  p_version    int,
  p_section    text,
  p_release    boolean default false
)
returns jsonb
language plpgsql security definer
set search_path = research, iam, public, pg_catalog
as $$
declare
  v_me uuid; v_name text; v_row research.report_sections%rowtype;
  v_version_status text;
begin
  if auth.uid() is null then raise exception '[M8] yêu cầu chưa đăng nhập'; end if;
  if not research.can_manage_assessment() then
    raise exception '[M8] vai trò không được khóa section';
  end if;
  select status into v_version_status from research.report_versions
   where assessment_id = p_assessment and version_no = p_version;
  if v_version_status is null then raise exception '[M8] không thấy version %', p_version; end if;
  if v_version_status <> 'draft' then
    raise exception '[M8] version đã %, không khóa section để sửa được', v_version_status;
  end if;

  v_me := auth.uid();
  v_name := (select display_name from iam.user_profiles where id = v_me);

  -- section row có thể chưa tồn tại (chưa lưu lần nào): tạo rỗng để giữ khóa.
  insert into research.report_sections (assessment_id, report_version, section_key)
  values (p_assessment, p_version, p_section)
  on conflict (assessment_id, report_version, section_key) do nothing;

  select * into v_row from research.report_sections
   where assessment_id = p_assessment and report_version = p_version and section_key = p_section;

  if p_release then
    if v_row.lock_owner = v_me then
      update research.report_sections set lock_owner = null, lock_owner_name = null, locked_at = null
       where id = v_row.id;
    end if;
    return jsonb_build_object('ok', true, 'mine', true, 'lockOwner', null);
  end if;

  if v_row.lock_owner is not null
     and v_row.lock_owner <> v_me
     and v_row.locked_at > now() - interval '2 minutes' then
    return jsonb_build_object(
      'ok', false, 'mine', false,
      'lockOwner', v_row.lock_owner_name,
      'lockedAt', v_row.locked_at,
      'message', 'Đang có ' || coalesce(v_row.lock_owner_name, 'người khác') || ' soát section này');
  end if;

  perform set_config('app.report_guard','bypass', true);
  update research.report_sections
     set lock_owner = v_me, lock_owner_name = v_name, locked_at = now()
   where id = v_row.id;
  return jsonb_build_object('ok', true, 'mine', true, 'lockOwner', v_name, 'lockedAt', now());
end;
$$;

grant execute on function public.vexim_research_report_section_lock(uuid, int, text, boolean)
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 8. RPC: LƯU SECTION (autosave/thủ công/AI regen đều đi qua đây)
-- ----------------------------------------------------------------------------
create or replace function public.vexim_research_report_section_save(
  p_assessment uuid,
  p_version    int,
  p_section    text,
  p_content    jsonb,
  p_source     text default 'human',       -- human | ai | human_regen
  p_llm_run_id uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = research, iam, public, pg_catalog
as $$
declare
  v_me uuid; v_name text; v_row research.report_sections%rowtype;
  v_status text; v_model text;
begin
  if auth.uid() is null then raise exception '[M8] yêu cầu chưa đăng nhập'; end if;
  if not research.can_manage_assessment() then
    raise exception '[M8] vai trò không được sửa báo cáo';
  end if;
  if p_source not in ('human','ai','human_regen') then
    raise exception '[M8] nguồn nội dung không hợp lệ: %', p_source;
  end if;
  perform research.validate_report_doc(p_assessment, p_content);

  select status into v_status from research.report_versions
   where assessment_id = p_assessment and version_no = p_version;
  if v_status is null then raise exception '[M8] không thấy version %', p_version; end if;
  if v_status <> 'draft' then
    raise exception '[M8] version đã %, không sửa được — tạo bản nháp mới', v_status;
  end if;

  v_me := auth.uid();
  v_name := (select display_name from iam.user_profiles where id = v_me);
  if p_llm_run_id is not null then
    select model into v_model from research.llm_runs where id = p_llm_run_id;
  end if;

  insert into research.report_sections (assessment_id, report_version, section_key)
  values (p_assessment, p_version, p_section)
  on conflict (assessment_id, report_version, section_key) do nothing;
  select * into v_row from research.report_sections
   where assessment_id = p_assessment and report_version = p_version and section_key = p_section;

  if v_row.lock_owner is not null and v_row.lock_owner <> v_me
     and v_row.locked_at > now() - interval '2 minutes' then
    raise exception '[M8] section đang bị khóa bởi %', coalesce(v_row.lock_owner_name,'người khác');
  end if;

  perform set_config('app.report_guard','bypass', true);
  update research.report_sections set
    content = p_content,
    -- nguồn phản ánh NGƯỜI GHI BẢN GẦN NHẤT: sửa tay=human, seed AI=ai,
    -- người bấm regenerate rồi chấp nhận=human_regen.
    source = p_source,
    llm_run_id = case when p_llm_run_id is not null then p_llm_run_id else llm_run_id end,
    generated_model = coalesce(v_model, generated_model),
    -- nội dung đổi sau khi ký: chữ ký mất hiệu lực, phải ký lại
    status = case when status = 'verified' then 'drafted' else status end,
    verified_by = case when status = 'verified' then null else verified_by end,
    verified_name = case when status = 'verified' then null else verified_name end,
    verified_at = case when status = 'verified' then null else verified_at end,
    lock_owner = v_me, lock_owner_name = v_name, locked_at = now(),
    updated_at = now()
  where id = v_row.id;

  insert into iam.audit_logs (actor_id, module, action, entity, after_value, result)
  values (v_me, 'm8_research', 'report.section_save', p_assessment::text,
          jsonb_build_object('versionNo', p_version, 'section', p_section,
                             'source', p_source, 'llmRun', p_llm_run_id), 'ok');

  return jsonb_build_object('ok', true, 'savedAt', now());
end;
$$;

grant execute on function public.vexim_research_report_section_save(uuid, int, text, jsonb, text, uuid)
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 9. RPC: GHI NHẬT KÝ LLM NARRATIVE BẰNG PHIÊN NGƯỜI DÙNG (regen từ UI)
-- ----------------------------------------------------------------------------
create or replace function public.vexim_research_record_narrative_run(p_run jsonb)
returns jsonb
language plpgsql security definer
set search_path = research, iam, public, pg_catalog
as $$
declare v_id uuid; v_org uuid;
begin
  if auth.uid() is null then raise exception '[M8] yêu cầu chưa đăng nhập'; end if;
  if not research.can_manage_assessment() then
    raise exception '[M8] vai trò không được chạy LLM cho báo cáo';
  end if;
  select org_id into v_org from research.assessments where id = (p_run->>'assessmentId')::uuid;
  if v_org is null or not research.can_read_assessment(v_org) then
    raise exception '[M8] không thấy hồ sơ hợp lệ';
  end if;

  insert into research.llm_runs (
    assessment_id, section_key, chunk_index, provider, model, prompt_hash,
    input_refs, output, tokens_in, tokens_out, cost_usd, status, error, created_by
  ) values (
    (p_run->>'assessmentId')::uuid,
    p_run->>'sectionKey', null,
    coalesce(p_run->>'provider','openai'),
    coalesce(p_run->>'model','unknown'),
    nullif(p_run->>'promptHash',''),
    coalesce(p_run->'inputRefs','{}'::jsonb),
    p_run->'output',
    coalesce((p_run->>'tokensIn')::int,0),
    coalesce((p_run->>'tokensOut')::int,0),
    coalesce((p_run->>'costUsd')::numeric,0),
    coalesce(p_run->>'status','ok'),
    nullif(p_run->>'error',''),
    'human_regen'
  ) returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

grant execute on function public.vexim_research_record_narrative_run(jsonb)
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 10. RPC: KÝ / BỎ KÝ SECTION
-- ----------------------------------------------------------------------------
create or replace function public.vexim_research_report_verify_section(
  p_assessment uuid,
  p_version    int,
  p_section    text,
  p_verify     boolean
)
returns jsonb
language plpgsql security definer
set search_path = research, iam, public, pg_catalog
as $$
declare
  v_me uuid; v_name text; v_row research.report_sections%rowtype; v_status text;
begin
  if auth.uid() is null then raise exception '[M8] yêu cầu chưa đăng nhập'; end if;
  if not research.can_manage_assessment() then
    raise exception '[M8] vai trò không được ký section';
  end if;
  select status into v_status from research.report_versions
   where assessment_id = p_assessment and version_no = p_version;
  if v_status <> 'draft' then
    raise exception '[M8] chỉ ký được khi bản nháp đang mở';
  end if;
  select * into v_row from research.report_sections
   where assessment_id = p_assessment and report_version = p_version and section_key = p_section;
  if not found then raise exception '[M8] chưa có nội dung section % để ký', p_section; end if;

  v_me := auth.uid();
  v_name := (select display_name from iam.user_profiles where id = v_me);
  perform set_config('app.report_guard','bypass', true);

  if p_verify then
    -- Nội dung phải có chữ/hoặc chip (không ký được khối trống)
    if not exists (select 1 from research.doc_nodes(v_row.content) n
                    where n->>'type' in ('text','metricToken','quoteChip'))
       or not exists (select 1 from research.doc_nodes(v_row.content) n
                      where (n->>'type'='text' and coalesce(length(btrim(n->>'text')),0) > 0)
                         or n->>'type' in ('metricToken','quoteChip')) then
      raise exception '[M8] section % đang trống, không thể ký', p_section;
    end if;
    update research.report_sections
       set status = 'verified', verified_by = v_me, verified_name = v_name,
           verified_at = now(), updated_at = now()
     where id = v_row.id;
  else
    update research.report_sections
       set status = 'drafted', verified_by = null, verified_name = null,
           verified_at = null, updated_at = now()
     where id = v_row.id;
  end if;

  insert into iam.audit_logs (actor_id, module, action, entity, after_value, result)
  values (v_me, 'm8_research', 'report.section_verify', p_assessment::text,
          jsonb_build_object('versionNo', p_version, 'section', p_section, 'verify', p_verify), 'ok');
  return jsonb_build_object('ok', true, 'status', case when p_verify then 'verified' else 'drafted' end);
end;
$$;

grant execute on function public.vexim_research_report_verify_section(uuid, int, text, boolean)
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 11. RPC: NHÌN NHẬN VETO ĐỎ (không gỡ cờ — chỉ xác nhận đã thấy cho version)
-- ----------------------------------------------------------------------------
create or replace function public.vexim_research_report_ack_veto(
  p_assessment uuid,
  p_version    int,
  p_rule_code  text,
  p_note       text default null
)
returns jsonb
language plpgsql security definer
set search_path = research, iam, public, pg_catalog
as $$
declare v_me uuid; v_name text;
begin
  if auth.uid() is null then raise exception '[M8] yêu cầu chưa đăng nhập'; end if;
  if not research.can_manage_assessment() then
    raise exception '[M8] vai trò không được ghi nhận veto';
  end if;
  if not exists (select 1 from research.veto_flags
                  where assessment_id = p_assessment and rule_code = p_rule_code) then
    raise exception '[M8] không thấy cờ veto % của hồ sơ', p_rule_code;
  end if;
  v_me := auth.uid();
  v_name := (select display_name from iam.user_profiles where id = v_me);

  insert into research.veto_acknowledgements
    (assessment_id, version_no, rule_code, acknowledged_by, acknowledged_name, note)
  values (p_assessment, p_version, p_rule_code, v_me, v_name, nullif(p_note,''))
  on conflict (assessment_id, version_no, rule_code) do update
    set note = excluded.note, created_at = now();

  insert into iam.audit_logs (actor_id, module, action, entity, after_value, result)
  values (v_me, 'm8_research', 'report.veto_ack', p_assessment::text,
          jsonb_build_object('versionNo', p_version, 'rule', p_rule_code), 'ok');
  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.vexim_research_report_ack_veto(uuid, int, text, text)
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 12. RPC: GỬI DUYỆT (chụp version bất biến)
-- ----------------------------------------------------------------------------
create or replace function public.vexim_research_report_submit(p_assessment uuid)
returns jsonb
language plpgsql security definer
set search_path = research, iam, public, pg_catalog
as $$
declare
  v_me uuid; v_no int; v_missing text[]; v_snapshot jsonb;
begin
  if auth.uid() is null then raise exception '[M8] yêu cầu chưa đăng nhập'; end if;
  if not research.can_manage_assessment() then
    raise exception '[M8] vai trò không được gửi duyệt báo cáo';
  end if;
  select version_no into v_no from research.report_versions
   where assessment_id = p_assessment and status = 'draft' limit 1;
  if v_no is null then raise exception '[M8] chưa có bản nháp đang mở để gửi duyệt'; end if;

  select coalesce(array_agg(k order by k), array[]::text[]) into v_missing
    from unnest(research.report_required_sections()) as k
   where not exists (
     select 1 from research.report_sections s
      where s.assessment_id = p_assessment and s.report_version = v_no
        and s.section_key = k and s.status = 'verified');
  if array_length(v_missing,1) is not null then
    raise exception '[M8] còn % section bắt buộc chưa ký: %', array_length(v_missing,1),
      array_to_string(v_missing, ', ');
  end if;

  select jsonb_build_object(
    'versionNo', v_no, 'submittedAt', now()::text, 'submittedBy',
    (select display_name from iam.user_profiles where id = auth.uid()),
    'sections', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'sectionKey', section_key, 'status', status, 'source', source,
        'verifiedBy', verified_name, 'verifiedAt', verified_at, 'content', content)
        order by section_key), '[]'::jsonb)
        from research.report_sections
       where assessment_id = p_assessment and report_version = v_no),
    'vetoAcks', (
      select coalesce(jsonb_agg(jsonb_build_object('ruleCode', rule_code, 'by', acknowledged_name, 'at', created_at)), '[]'::jsonb)
        from research.veto_acknowledgements
       where assessment_id = p_assessment and version_no = v_no)
  ) into v_snapshot;

  perform set_config('app.report_guard','bypass', true);
  update research.report_versions
     set status = 'in_review', submitted_at = now(), snapshot = v_snapshot, updated_at = now()
   where assessment_id = p_assessment and version_no = v_no and status = 'draft';

  v_me := auth.uid();
  insert into iam.audit_logs (actor_id, module, action, entity, after_value, result)
  values (v_me, 'm8_research', 'report.submit', p_assessment::text,
          jsonb_build_object('versionNo', v_no), 'ok');
  return jsonb_build_object('ok', true, 'versionNo', v_no, 'status', 'in_review');
end;
$$;

grant execute on function public.vexim_research_report_submit(uuid)
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 13. RPC: YÊU CẦU SỬA → nhân bản bản nháp mới (giữ nguyên version cũ)
-- ----------------------------------------------------------------------------
create or replace function public.vexim_research_report_request_changes(
  p_assessment uuid, p_note text default null
)
returns jsonb
language plpgsql security definer
set search_path = research, iam, public, pg_catalog
as $$
declare
  v_me uuid; v_old int; v_new int;
begin
  if auth.uid() is null then raise exception '[M8] yêu cầu chưa đăng nhập'; end if;
  -- Chỉ cấp duyệt (trưởng phòng trở lên) được trả hồ sơ để sửa.
  if not iam.has_role(array['super_admin','org_admin','dept_lead']) then
    raise exception '[M8] chỉ trưởng phòng trở lên mới được yêu cầu sửa';
  end if;
  select version_no into v_old from research.report_versions
   where assessment_id = p_assessment and status = 'in_review' limit 1;
  if v_old is null then raise exception '[M8] không có version đang chờ duyệt'; end if;

  perform set_config('app.report_guard','bypass', true);
  update research.report_versions
     set status = 'changes_requested', change_note = nullif(p_note,''), updated_at = now()
   where assessment_id = p_assessment and version_no = v_old;

  select coalesce(max(version_no),0)+1 into v_new from research.report_versions
   where assessment_id = p_assessment;
  insert into research.report_versions
    (assessment_id, version_no, status, created_by, title)
  values (p_assessment, v_new, 'draft', auth.uid(), 'Báo cáo thẩm định v' || v_new);

  -- Nhân bản nội dung; chữ ký cũ không mang theo (phải ký lại trên bản mới).
  insert into research.report_sections (
    assessment_id, report_version, section_key, status, content, source,
    llm_run_id, generated_model)
  select p_assessment, v_new, section_key, 'drafted', content, source,
         llm_run_id, generated_model
    from research.report_sections
   where assessment_id = p_assessment and report_version = v_old;

  v_me := auth.uid();
  insert into iam.audit_logs (actor_id, module, action, entity, after_value, result)
  values (v_me, 'm8_research', 'report.request_changes', p_assessment::text,
          jsonb_build_object('fromVersion', v_old, 'newVersion', v_new, 'note', p_note), 'ok');
  return jsonb_build_object('ok', true, 'oldVersion', v_old, 'newVersion', v_new);
end;
$$;

grant execute on function public.vexim_research_report_request_changes(uuid, text)
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 14. RPC: PHÊ DUYỆT XUẤT BẢN (đủ chữ ký + nhìn nhận mọi veto đỏ)
-- ----------------------------------------------------------------------------
create or replace function public.vexim_research_report_approve(p_assessment uuid)
returns jsonb
language plpgsql security definer
set search_path = research, iam, public, pg_catalog
as $$
declare
  v_me uuid; v_no int; v_missing text[]; v_red text[]; v_snapshot jsonb;
begin
  if auth.uid() is null then raise exception '[M8] yêu cầu chưa đăng nhập'; end if;
  if not iam.has_role(array['super_admin','org_admin','dept_lead']) then
    raise exception '[M8] chỉ trưởng phòng trở lên mới được phê duyệt';
  end if;
  select version_no into v_no from research.report_versions
   where assessment_id = p_assessment and status = 'in_review' limit 1;
  if v_no is null then raise exception '[M8] không có version đang chờ duyệt'; end if;

  select coalesce(array_agg(k order by k), array[]::text[]) into v_missing
    from unnest(research.report_required_sections()) as k
   where not exists (
     select 1 from research.report_sections s
      where s.assessment_id = p_assessment and s.report_version = v_no
        and s.section_key = k and s.status = 'verified');
  if array_length(v_missing,1) is not null then
    raise exception '[M8] chưa đủ chữ ký section bắt buộc: %', array_to_string(v_missing, ', ');
  end if;

  -- Mọi veto ĐỎ phải được nhìn nhận trên CHÍNH version này (không gỡ cờ).
  select coalesce(array_agg(rule_code order by rule_code), array[]::text[]) into v_red
    from research.veto_flags v
   where assessment_id = p_assessment and severity = 'red'
     and not exists (
       select 1 from research.veto_acknowledgements a
        where a.assessment_id = p_assessment and a.version_no = v_no
          and a.rule_code = v.rule_code);
  if array_length(v_red,1) is not null then
    raise exception '[M8] còn veto đỏ chưa nhìn nhận: %', array_to_string(v_red, ', ');
  end if;

  select jsonb_set(
    coalesce(snapshot, jsonb_build_object('versionNo', v_no)),
    '{approvedAt}', to_jsonb(now()::text))
    into v_snapshot
    from research.report_versions
   where assessment_id = p_assessment and version_no = v_no;

  perform set_config('app.report_guard','bypass', true);
  update research.report_versions
     set status = 'approved', approver_id = auth.uid(), approved_at = now(),
         snapshot = v_snapshot, updated_at = now()
   where assessment_id = p_assessment and version_no = v_no;

  -- Phê duyệt báo cáo cũng gắn trạng thái hồ sơ ('approved' theo CHECK 0025).
  update research.assessments
     set status = 'approved'
   where id = p_assessment and status <> 'approved';

  v_me := auth.uid();
  insert into iam.audit_logs (actor_id, module, action, entity, after_value, result)
  values (v_me, 'm8_research', 'report.approve', p_assessment::text,
          jsonb_build_object('versionNo', v_no), 'ok');
  return jsonb_build_object('ok', true, 'versionNo', v_no, 'status', 'approved');
end;
$$;

grant execute on function public.vexim_research_report_approve(uuid)
  to authenticated, service_role;

revoke all on function public.vexim_research_report_open_draft(uuid) from public, anon;
revoke all on function public.vexim_research_report_section_lock(uuid,int,text,boolean) from public, anon;
revoke all on function public.vexim_research_report_section_save(uuid,int,text,jsonb,text,uuid) from public, anon;
revoke all on function public.vexim_research_record_narrative_run(jsonb) from public, anon;
revoke all on function public.vexim_research_report_verify_section(uuid,int,text,boolean) from public, anon;
revoke all on function public.vexim_research_report_ack_veto(uuid,int,text,text) from public, anon;
revoke all on function public.vexim_research_report_submit(uuid) from public, anon;
revoke all on function public.vexim_research_report_request_changes(uuid,text) from public, anon;
revoke all on function public.vexim_research_report_approve(uuid) from public, anon;

-- ----------------------------------------------------------------------------
-- 15. VIEW PUBLIC CHO WEB
-- ----------------------------------------------------------------------------
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
       s.lock_owner_name as lock_owner,
       s.locked_at,
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

grant select on
  public.vexim_research_report_versions,
  public.vexim_research_report_sections,
  public.vexim_research_veto_acks
  to authenticated, anon, service_role;

commit;
