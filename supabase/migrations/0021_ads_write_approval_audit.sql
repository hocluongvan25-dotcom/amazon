-- ============================================================================
-- 0021 — MODULE 5 PHẦN 2 & 3: CHIỀU GHI (bid · budget · negative) + DUYỆT + AUDIT + REVERT
-- ============================================================================
-- Nguyên tắc xuyên suốt file này — đọc trước khi sửa bất cứ dòng nào:
--
--   1. NGƯỜI DUYỆT LÀ CON NGƯỜI, MÁY CHỈ ĐỀ XUẤT. Không có đường nào để job tự
--      đổi ngân sách/bid/negative mà không có một dòng `ads.change_requests` do
--      người tạo (kèm lý do) hoặc do người duyệt gợi ý A3 (SOP-04 bước 5).
--   2. NGƯỠNG DUYỆT NẰM Ở DB, KHÔNG NẰM Ở UI. Tăng ngân sách/bid > 30%/ngày phải
--      có trưởng phòng PPC duyệt (SOP-05 bước 4). Luật nằm trong
--      `ads.approval_reason()` và được TRIGGER TÍNH LẠI — sửa UI không lách được.
--   3. KHÔNG SỬA SAU KHI ĐÃ ÁP DỤNG. Dòng `applied` là bằng chứng: trigger chặn
--      mọi thay đổi nội dung. Muốn đảo lại thì tạo yêu cầu MỚI (revert) — cũng
--      phải qua đúng ngưỡng duyệt đó.
--   4. MỌI BƯỚC GHI `iam.audit_logs`: yêu cầu · duyệt/từ chối · áp dụng · lỗi ·
--      revert. Kể cả bị từ chối cũng phải có dấu.
--   5. WORKER KHÔNG TỰ QUYẾT: chỉ `claim` dòng đã `approved` rồi ghi kết quả
--      Amazon trả về. Ghi cục bộ (campaigns/targets/negative_keywords) chỉ để màn
--      hình đúng ngay; lần sync sau Amazon vẫn là nguồn sự thật.
-- ============================================================================

-- ============================================================================
-- 0. VÁ LỖI RLS TỰ THAM CHIẾU (phát hiện khi làm P2/P3 — chặn hiển thị tên người duyệt)
-- ============================================================================
-- Triệu chứng thật gặp trong lúc dựng hàng đợi duyệt:
--   select * from public.vexim_ads_changes;   -- (role authenticated)
--   → ERROR: infinite recursion detected in policy for relation "role_assignments"
--
-- Nguyên nhân: 10 policy của 0001/0002/0004 kiểm quyền bằng SUBQUERY trực tiếp trên
-- `iam.role_assignments` (hoặc `iam.user_profiles`). Khi user thật đọc bảng, PostgreSQL
-- phải áp RLS cho chính bảng trong subquery đó ⇒ policy lại gọi policy ⇒ đệ quy vô hạn.
-- Hậu quả: KHÔNG đọc được iam.user_profiles / iam.assignments / iam.role_assignments /
-- ops.alert_rules / ops.client_reports / ops.task_templates ⇒ màn duyệt không có tên
-- người yêu cầu, nhật ký audit không có tên người thao tác.
--
-- Cách vá: giữ NGUYÊN ngữ nghĩa, chỉ chuyển phần kiểm quyền vào hàm SECURITY DEFINER
-- (`iam.has_role`, `iam.current_org_id`). Hàm definer chạy bằng quyền chủ sở hữu nên RLS
-- không áp lại lên role_assignments ⇒ hết đệ quy.
-- (Đây là hàm dùng chung — 0022+ nên dùng lại, đừng viết subquery role_assignments mới.)

create or replace function iam.has_role(p_roles text[])
returns boolean
language sql stable security definer
set search_path = iam, pg_catalog
as $$
  select exists (
    select 1 from iam.role_assignments ra
     where ra.user_id = auth.uid()
       and ra.role::text = any (p_roles)
  );
$$;

comment on function iam.has_role(text[]) is
  'M5 P3: user hiện tại có một trong các vai trò này không. SECURITY DEFINER để policy '
  'dùng được mà không đệ quy (xem khối 0 của 0021). Dùng hàm này thay vì subquery trực tiếp.';

create or replace function iam.current_org_id()
returns uuid
language sql stable security definer
set search_path = iam, pg_catalog
as $$
  select up.org_id from iam.user_profiles up where up.id = auth.uid();
$$;

comment on function iam.current_org_id() is
  'M5 P3: org của user hiện tại (null với nhân viên VEXIM). SECURITY DEFINER — cùng lý do trên.';

grant execute on function iam.has_role(text[]) to authenticated, service_role;
grant execute on function iam.current_org_id() to authenticated, service_role;

-- iam.user_profiles
drop policy if exists rls_read_user_profiles_self on iam.user_profiles;
create policy rls_read_user_profiles_self on iam.user_profiles
  for select using (id = auth.uid() or iam.has_role(array['super_admin']));

drop policy if exists rls_ins_user_profiles_admin on iam.user_profiles;
create policy rls_ins_user_profiles_admin on iam.user_profiles for insert to authenticated
  with check (iam.has_role(array['super_admin','org_admin','dept_lead']));

drop policy if exists rls_upd_user_profiles_admin on iam.user_profiles;
create policy rls_upd_user_profiles_admin on iam.user_profiles for update to authenticated
  using (id = auth.uid() or iam.has_role(array['super_admin','org_admin']))
  with check (id = auth.uid() or iam.has_role(array['super_admin','org_admin']));

-- iam.role_assignments
drop policy if exists rls_read_role_assignments on iam.role_assignments;
create policy rls_read_role_assignments on iam.role_assignments
  for select using (user_id = auth.uid() or iam.has_role(array['super_admin']));

drop policy if exists rls_ins_role_assignments_admin on iam.role_assignments;
create policy rls_ins_role_assignments_admin on iam.role_assignments for insert to authenticated
  with check (iam.has_role(array['super_admin','org_admin','dept_lead']));

-- iam.assignments
drop policy if exists rls_read_assignments on iam.assignments;
create policy rls_read_assignments on iam.assignments
  for select using (user_id = auth.uid() or iam.has_role(array['super_admin']));

drop policy if exists rls_write_assignments_super on iam.assignments;
create policy rls_write_assignments_super on iam.assignments
  for all using (iam.has_role(array['super_admin']))
  with check (iam.has_role(array['super_admin']));

drop policy if exists rls_ins_assignments_admin on iam.assignments;
create policy rls_ins_assignments_admin on iam.assignments for insert to authenticated
  with check (iam.has_role(array['super_admin','org_admin']));

-- ops.alert_rules · ops.client_reports · ops.task_templates
drop policy if exists rls_write_alert_rules_super on ops.alert_rules;
create policy rls_write_alert_rules_super on ops.alert_rules
  for all to authenticated
  using (iam.has_role(array['super_admin']))
  with check (iam.has_role(array['super_admin']));

drop policy if exists rls_read_client_reports on ops.client_reports;
create policy rls_read_client_reports on ops.client_reports
  for select using (org_id = iam.current_org_id() or iam.has_role(array['super_admin']));

drop policy if exists rls_write_task_templates_super on ops.task_templates;
create policy rls_write_task_templates_super on ops.task_templates
  for all to authenticated
  using (iam.has_role(array['super_admin']))
  with check (iam.has_role(array['super_admin']));

-- ============================================================================
-- 1. ads.change_requests — HÀNG ĐỢI YÊU CẦU GHI
-- ============================================================================
create table if not exists ads.change_requests (
  id                 uuid primary key default gen_random_uuid(),
  seller_account_id  uuid not null references connections.seller_accounts(id) on delete cascade,
  ads_profile_id     text not null default '',

  /** đối tượng bị tác động — quyết định APP NÀO của Ads API sẽ được gọi */
  entity_type        text not null
                     check (entity_type in ('campaign','ad_group','keyword','product_target','search_term')),
  /** khoá tự nhiên: campaignId | adGroupId | keywordId/targetId | term */
  entity_key         text not null default '',
  campaign_id        text not null default '',
  ad_group_id        text not null default '',
  entity_label       text not null default '',   -- tên người đọc được (campaign/keyword/term)

  action             text not null
                     check (action in ('set_budget','set_bid','set_state',
                                       'add_negative_exact','add_negative_phrase')),
  payload            jsonb not null default '{}'::jsonb,
  before_value       jsonb,
  after_value        jsonb,
  currency           text,

  reason             text,
  suggestion_id      uuid,   -- FK thêm sau khi chắc chắn bảng gợi ý tồn tại (0020)

  requires_approval  boolean not null default false,
  approval_reason    text,

  status             text not null default 'pending_approval'
                     check (status in ('pending_approval','approved','rejected','cancelled',
                                       'applying','applied','failed')),
  requested_by       uuid references iam.user_profiles(id),
  requested_at       timestamptz not null default now(),
  decided_by         uuid references iam.user_profiles(id),
  decided_at         timestamptz,
  decision_note      text,
  applied_at         timestamptz,
  api_response       jsonb,
  error              text,
  attempts           int not null default 0,
  /** dòng này là REVERT của dòng nào (đảo giá trị before/after) */
  revert_of          uuid references ads.change_requests(id) on delete set null,
  /** dòng này ĐÃ bị đảo bởi dòng nào */
  reverted_by        uuid references ads.change_requests(id) on delete set null,
  source             text not null default 'web'
                     check (source in ('web','suggestion','revert','cli')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table ads.change_requests is
  'Hàng đợi GHI lên Amazon Ads (SOP-04 bước 6 · SOP-05 bước 5): mỗi yêu cầu đổi '
  'ngân sách/bid/state/thêm negative là MỘT dòng ở đây, kèm người yêu cầu, lý do, '
  'giá trị trước/sau, người duyệt và phản hồi Amazon. Worker chỉ `claim` dòng đã approved '
  '— không có đường ghi nào khác.';

-- FK tới gợi ý A3 (bảng 0020) — thêm riêng để file này vẫn chạy được trên DB đã có 0020.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'change_requests_suggestion_id_fkey'
      and conrelid = 'ads.change_requests'::regclass
  ) then
    alter table ads.change_requests
      add constraint change_requests_suggestion_id_fkey
      foreign key (suggestion_id) references ads.negative_suggestions(id) on delete set null;
  end if;
end $$;

create index if not exists idx_ads_changes_status
  on ads.change_requests (seller_account_id, status, requested_at desc);
create index if not exists idx_ads_changes_entity
  on ads.change_requests (seller_account_id, entity_type, entity_key);
create index if not exists idx_ads_changes_pending
  on ads.change_requests (status, requested_at) where status in ('pending_approval','approved');
-- Chống double-apply: một đối tượng + một hành động chỉ có tối đa 1 yêu cầu đang bay.
create unique index if not exists uq_ads_changes_inflight
  on ads.change_requests (seller_account_id, entity_type, entity_key, action)
  where status in ('pending_approval','approved','applying');

-- ============================================================================
-- 2. ads.negative_keywords — GƯƠNG của negative đã đẩy lên Amazon
-- ============================================================================
create table if not exists ads.negative_keywords (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  ads_profile_id    text not null default '',
  campaign_id       text not null default '',
  ad_group_id       text not null default '',
  keyword_id        text not null default '',      -- Amazon trả về khi tạo
  keyword_text      text not null,
  match_type        text not null
                    check (match_type in ('NEGATIVE_EXACT','NEGATIVE_PHRASE')),
  state             text not null default 'ENABLED',
  source            text not null default 'suggestion'
                    check (source in ('suggestion','manual','api')),
  change_request_id uuid references ads.change_requests(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table ads.negative_keywords is
  'Negative keyword ĐÃ đẩy lên Amazon (để trả lời "từ khoá này đã bị chặn chưa, chặn từ bao giờ, do ai"). '
  'Khoá tự nhiên: shop + ad_group + lower(keyword_text) + match_type.';

create unique index if not exists uq_ads_negative_keywords_key
  on ads.negative_keywords (seller_account_id, ad_group_id, lower(keyword_text), match_type);
create index if not exists idx_ads_negative_keywords_campaign
  on ads.negative_keywords (seller_account_id, campaign_id);

-- ============================================================================
-- 3. HELPER: ai được DUYỆT thay đổi quảng cáo (trưởng phòng PPC / admin)
-- ============================================================================
create or replace function iam.is_ads_approver()
returns boolean
language sql stable security definer
set search_path = iam, pg_catalog
as $$
  select exists (
           select 1 from iam.role_assignments ra
           where ra.user_id = auth.uid()
             and ra.role in ('super_admin','org_admin')
         )
      or exists (
           select 1 from iam.role_assignments ra
           join iam.departments d on d.id = ra.department_id
           where ra.user_id = auth.uid()
             and ra.role = 'dept_lead'
             and d.code = 'ppc'
         );
$$;

comment on function iam.is_ads_approver() is
  'M5 P3: trưởng phòng PPC (dept_lead · iam.departments.code = ''ppc'') hoặc admin được '
  'duyệt/từ chối thay đổi quảng cáo (ngưỡng > 30%/ngày — SOP-05 bước 4).';

-- ============================================================================
-- 4. LUẬT NGƯỠNG DUYỆT — một chỗ duy nhất (DB)
-- ============================================================================
-- Vì sao tách 2 hàm: ngân sách/bid so theo SỐ (%), còn trạng thái so theo CHUỖI.
-- Gộp một hàm là sớm muộn cũng có người truyền "ENABLED" vào tham số numeric.
create or replace function ads.approval_reason(
  p_action      text,
  p_before      numeric,
  p_after       numeric,
  p_entity_type text
)
returns text
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  v_pct numeric;
begin
  -- Thêm negative keyword: GIẢM chi tiêu ⇒ không cần duyệt, chỉ cần audit.
  if p_action in ('add_negative_exact','add_negative_phrase') then
    return null;
  end if;
  if p_action not in ('set_budget','set_bid') then
    return null;   -- set_state do ads.approval_reason_state() quyết định
  end if;

  if p_before is null or p_before <= 0 then
    return 'Không đọc được giá trị hiện tại trong DB ⇒ phải có người duyệt trước khi ghi lên Amazon.';
  end if;
  if p_after is null then
    return 'Thiếu giá trị mới ⇒ không có gì để ghi lên Amazon.';
  end if;

  v_pct := round((p_after - p_before) * 100 / p_before, 1);
  if v_pct > 30 then
    return format('Tăng %s%%/ngày > 30%% (SOP-05 bước 4) ⇒ cần trưởng phòng PPC duyệt.', v_pct);
  end if;
  return null;
end;
$$;

comment on function ads.approval_reason(text, numeric, numeric, text) is
  'Luật ngưỡng duyệt cho ngân sách/bid: tăng > 30% ⇒ cần duyệt (SOP-05 b4). '
  'Thêm negative ⇒ KHÔNG cần duyệt (hành động giảm chi tiêu). Trả NULL = tự động duyệt.';

create or replace function ads.approval_reason_state(
  p_action text,
  p_before text,
  p_after  text
)
returns text
language plpgsql
immutable
set search_path = pg_catalog
as $$
begin
  if p_action <> 'set_state' then
    return null;
  end if;
  if p_after is null or btrim(p_after) = '' then
    return 'Thiếu trạng thái mới ⇒ không có gì để ghi lên Amazon.';
  end if;
  -- Bật lại (ENABLED) làm tiền bắt đầu chảy ⇒ cần duyệt. Tạm dừng thì KHÔNG cần
  -- (đó là hành động chặn chi tiêu — càng nhanh càng tốt).
  if upper(btrim(p_after)) = 'ENABLED' and upper(btrim(coalesce(p_before, ''))) <> 'ENABLED' then
    return 'Bật lại campaign/keyword đang dừng ⇒ cần trưởng phòng PPC duyệt (SOP-05).';
  end if;
  return null;
end;
$$;

comment on function ads.approval_reason_state(text, text, text) is
  'Luật ngưỡng duyệt cho đổi trạng thái: bật lại (ENABLED) cần duyệt; tạm dừng thì không.';

-- ============================================================================
-- 5. MÁY TRẠNG THÁI + BẤT BIẾN SAU KHI ÁP DỤNG (trigger BEFORE)
-- ============================================================================
create or replace function ads.change_request_guard()
returns trigger
language plpgsql
security definer
set search_path = ads, pg_catalog
as $$
begin
  if tg_op = 'INSERT' then
    if new.entity_key = '' and new.entity_type <> 'search_term' then
      raise exception '[M5P3] thiếu entity_key cho %', new.entity_type
        using errcode = 'invalid_parameter_value';
    end if;

    -- Ngưỡng duyệt được TÍNH LẠI ở đây (không tin giá trị RPC/client truyền vào):
    -- sửa UI hay gọi thẳng RPC cũng không qua được cổng này.
    if new.action = 'set_state' then
      new.approval_reason := ads.approval_reason_state(
        new.action,
        new.before_value ->> 'value',
        new.after_value   ->> 'value'
      );
    elsif new.action in ('add_negative_exact','add_negative_phrase') then
      -- `value` ở đây là CHUỖI (search term) — cast sang numeric là nổ ngay.
      new.approval_reason := ads.approval_reason(new.action, null, null, new.entity_type);
    else
      new.approval_reason := ads.approval_reason(
        new.action,
        nullif(new.before_value ->> 'value', '')::numeric,
        nullif(new.after_value   ->> 'value', '')::numeric,
        new.entity_type
      );
    end if;
    new.requires_approval := new.approval_reason is not null;

    if new.status not in ('pending_approval', 'approved') then
      raise exception '[M5P3] yêu cầu mới chỉ được ở pending_approval/approved (nhận: %)', new.status
        using errcode = 'invalid_parameter_value';
    end if;
    -- Yêu cầu vượt ngưỡng mà đã 'approved' ⇒ bắt buộc có người duyệt (chống tự duyệt lén).
    if new.requires_approval and new.status = 'approved' and new.decided_by is null then
      raise exception '[M5P3] yêu cầu vượt ngưỡng phải có người duyệt (decided_by)'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- ============================ UPDATE ============================
  -- Bất biến: dòng đã ghi lên Amazon là BẰNG CHỨNG — không sửa nội dung.
  if old.status = 'applied' then
    if new.status <> 'applied' then
      raise exception '[M5P3] dòng đã applied — muốn đảo lại thì tạo yêu cầu revert'
        using errcode = 'check_violation';
    end if;
    if new.payload       is distinct from old.payload
       or new.before_value is distinct from old.before_value
       or new.after_value  is distinct from old.after_value
       or new.action       is distinct from old.action
       or new.entity_key   is distinct from old.entity_key then
      raise exception '[M5P3] không được sửa nội dung yêu cầu đã applied'
        using errcode = 'check_violation';
    end if;
  end if;

  if new.status <> old.status then
    if not (
         (old.status = 'pending_approval' and new.status in ('approved','rejected','cancelled'))
      or (old.status = 'approved'         and new.status in ('applying','cancelled'))
      or (old.status = 'applying'         and new.status in ('applied','failed'))
      or (old.status = 'failed'           and new.status in ('approved','cancelled'))
    ) then
      raise exception '[M5P3] chuyển trạng thái không hợp lệ: % → %', old.status, new.status
        using errcode = 'check_violation';
    end if;

    if new.status = 'approved' and old.status = 'pending_approval' and old.requires_approval
       and new.decided_by is null then
      raise exception '[M5P3] yêu cầu vượt ngưỡng phải có người duyệt (decided_by)'
        using errcode = 'check_violation';
    end if;
    if new.status = 'rejected' and new.decided_by is null then
      raise exception '[M5P3] từ chối yêu cầu phải có người quyết định'
        using errcode = 'check_violation';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

comment on function ads.change_request_guard() is
  'M5P3: chốt cuối của hàng đợi ghi — tính lại ngưỡng duyệt, ép máy trạng thái, và cấm '
  'sửa nội dung yêu cầu đã applied (bằng chứng audit).';

drop trigger if exists trg_ads_change_requests_guard on ads.change_requests;
create trigger trg_ads_change_requests_guard
  before insert or update on ads.change_requests
  for each row execute function ads.change_request_guard();

-- ============================================================================
-- 6. RPC CHO WEB — yêu cầu · duyệt · huỷ · revert · quyết định gợi ý
-- ============================================================================
-- Vì sao security definer + kiểm tra quyền tường minh: mọi đường ghi phải đi qua
-- MỘT cửa để không bỏ sót audit log; quyền của người dùng kiểm bằng auth.uid().

create or replace function public.vexim_request_ads_change(
  p_seller uuid,
  p_req    jsonb
)
returns table (
  change_id uuid, status text, requires_approval boolean, approval_reason text,
  before_value jsonb, after_value jsonb, currency text
)
language plpgsql
security definer
set search_path = ads, iam, connections, public, pg_catalog
as $$
-- `approval_reason` vừa là cột của ads.change_requests vừa là cột OUT của hàm:
-- ưu tiên CỘT, mọi biến trong hàm đều đã có tiền tố v_/p_ nên không bị che.
#variable_conflict use_column
declare
  v_action    text := btrim(coalesce(p_req ->> 'action', ''));
  v_etype     text := btrim(coalesce(p_req ->> 'entityType', ''));
  v_ekey      text := btrim(coalesce(p_req ->> 'entityKey', ''));
  v_camp      text := btrim(coalesce(p_req ->> 'campaignId', ''));
  v_ag        text := btrim(coalesce(p_req ->> 'adGroupId', ''));
  v_value     text := btrim(coalesce(p_req ->> 'value', ''));
  v_reason    text := nullif(btrim(coalesce(p_req ->> 'reason', '')), '');
  v_label     text := nullif(btrim(coalesce(p_req ->> 'label', '')), '');
  v_profile   text := btrim(coalesce(p_req ->> 'adsProfileId', ''));
  v_sugg      uuid;
  v_before    jsonb;
  v_after     jsonb;
  v_currency  text;
  v_num       numeric;
  v_id        uuid;
  v_reason_calc text;
  v_approver  boolean := iam.is_ads_approver();
  v_dup       boolean;
begin
  if p_seller is null then
    raise exception '[M5P3] thiếu seller_account_id' using errcode = 'invalid_parameter_value';
  end if;
  if not iam.can_write_seller_account(p_seller) then
    raise exception '[M5P3] bạn không có quyền ghi cho shop này' using errcode = 'insufficient_privilege';
  end if;
  if v_action not in ('set_budget','set_bid','set_state','add_negative_exact','add_negative_phrase') then
    raise exception '[M5P3] action không hợp lệ: %', coalesce(nullif(v_action,''), '(rỗng)')
      using errcode = 'invalid_parameter_value';
  end if;
  if v_value = '' then
    raise exception '[M5P3] thiếu `value` — không ghi lên Amazon khi chưa biết giá trị mới'
      using errcode = 'invalid_parameter_value';
  end if;
  if (p_req ->> 'suggestionId') ~ '^[0-9a-fA-F-]{36}$' then
    v_sugg := (p_req ->> 'suggestionId')::uuid;
  end if;

  -- ---- đọc GIÁ TRỊ HIỆN TẠI từ DB (không tin client) ------------------------
  if v_action = 'set_budget' then
    if v_etype <> 'campaign' then
      raise exception '[M5P3] set_budget chỉ áp dụng cho campaign (nhận: %)', v_etype
        using errcode = 'invalid_parameter_value';
    end if;
    v_num := nullif(v_value, '')::numeric;
    if v_num is null or v_num <= 0 then
      raise exception '[M5P3] ngân sách mới phải là số > 0 (nhận: %)', v_value
        using errcode = 'invalid_parameter_value';
    end if;
    select c.daily_budget, coalesce(nullif(v_profile,''), c.ads_profile_id, ''), c.budget_currency,
           coalesce(v_label, c.name)
      into v_num, v_profile, v_currency, v_label
      from ads.campaigns c
     where c.seller_account_id = p_seller and c.campaign_id = v_ekey;
    if not found then
      raise exception '[M5P3] campaign % không có trong DB — chạy `worker:ads-sync` trước', v_ekey
        using errcode = 'no_data_found';
    end if;
    -- v_num giờ là giá trị CŨ (select ... into đè) — dựng lại giá trị mới:
    v_before := jsonb_build_object('value', v_num);
    v_after  := jsonb_build_object('value', nullif(v_value, '')::numeric);
    if v_camp = '' then v_camp := v_ekey; end if;

  elsif v_action = 'set_bid' then
    if v_etype <> 'keyword' then
      raise exception '[M5P3] set_bid chỉ áp dụng cho keyword (nhận: %)', v_etype
        using errcode = 'invalid_parameter_value';
    end if;
    v_num := nullif(v_value, '')::numeric;
    if v_num is null or v_num <= 0 then
      raise exception '[M5P3] bid mới phải là số > 0 (nhận: %)', v_value
        using errcode = 'invalid_parameter_value';
    end if;
    select t.bid, coalesce(nullif(v_profile,''), t.ads_profile_id, ''), t.currency,
           coalesce(v_label, t.keyword_text, t.target_key), t.campaign_id, t.ad_group_id
      into v_num, v_profile, v_currency, v_label, v_camp, v_ag
      from ads.targets t
     where t.seller_account_id = p_seller and t.target_kind = 'keyword' and t.target_key = v_ekey;
    if not found then
      raise exception '[M5P3] keyword % không có trong DB — chạy `worker:ads-sync` trước', v_ekey
        using errcode = 'no_data_found';
    end if;
    v_before := jsonb_build_object('value', v_num);
    v_after  := jsonb_build_object('value', nullif(v_value, '')::numeric);

  elsif v_action = 'set_state' then
    if v_etype = 'campaign' then
      select jsonb_build_object('value', c.state), coalesce(nullif(v_profile,''), c.ads_profile_id, ''),
             coalesce(v_label, c.name)
        into v_before, v_profile, v_label
        from ads.campaigns c
       where c.seller_account_id = p_seller and c.campaign_id = v_ekey;
      if not found then
        raise exception '[M5P3] campaign % không có trong DB', v_ekey using errcode = 'no_data_found';
      end if;
      if v_camp = '' then v_camp := v_ekey; end if;
    elsif v_etype = 'keyword' then
      select jsonb_build_object('value', t.state), coalesce(nullif(v_profile,''), t.ads_profile_id, ''),
             coalesce(v_label, t.keyword_text, t.target_key), t.campaign_id, t.ad_group_id
        into v_before, v_profile, v_label, v_camp, v_ag
        from ads.targets t
       where t.seller_account_id = p_seller and t.target_kind = 'keyword' and t.target_key = v_ekey;
      if not found then
        raise exception '[M5P3] keyword % không có trong DB', v_ekey using errcode = 'no_data_found';
      end if;
    else
      raise exception '[M5P3] set_state chỉ áp dụng cho campaign/keyword (nhận: %)', v_etype
        using errcode = 'invalid_parameter_value';
    end if;
    v_after := jsonb_build_object('value', upper(v_value));

  else  -- add_negative_exact | add_negative_phrase
    if v_etype <> 'search_term' then
      raise exception '[M5P3] thêm negative phải xuất phát từ search term (nhận: %)', v_etype
        using errcode = 'invalid_parameter_value';
    end if;
    if v_ag = '' then
      raise exception '[M5P3] thiếu ad_group_id — negative keyword phải thuộc một ad group'
        using errcode = 'invalid_parameter_value';
    end if;
    v_ekey := lower(v_value);
    select coalesce(nullif(v_profile,''), c.ads_profile_id, ''), c.budget_currency,
           coalesce(v_label, c.name)
      into v_profile, v_currency, v_label
      from ads.campaigns c
     where c.seller_account_id = p_seller and c.campaign_id = v_camp;
    v_before := null;
    v_after  := jsonb_build_object('value', v_ekey);
  end if;

  -- ---- chống trùng: đã có yêu cầu đang bay cho cùng đối tượng + hành động ----
  select exists (
    select 1 from ads.change_requests r
     where r.seller_account_id = p_seller
       and r.entity_type = v_etype
       and r.entity_key  = v_ekey
       and r.action      = v_action
       and r.status in ('pending_approval','approved','applying')
  ) into v_dup;
  if v_dup then
    raise exception '[M5P3] đã có yêu cầu % cho % đang chờ/chạy — chờ xử lý xong rồi tạo yêu cầu mới',
      v_action, v_ekey using errcode = 'unique_violation';
  end if;

  -- Vì sao bọc trong CTE: tên cột `approval_reason` trùng với cột OUT của hàm ⇒
  -- `returning approval_reason` sẽ báo "column reference is ambiguous".
  with ins as (
    insert into ads.change_requests (
      seller_account_id, ads_profile_id, entity_type, entity_key, campaign_id, ad_group_id,
      entity_label, action, payload, before_value, after_value, currency, reason, suggestion_id,
      requested_by, source, status
    ) values (
      p_seller, v_profile, v_etype, v_ekey, v_camp, v_ag,
      coalesce(v_label, v_ekey), v_action,
      jsonb_build_object('sellerAccountId', p_seller, 'adsProfileId', v_profile,
                         'entityType', v_etype, 'entityKey', v_ekey,
                         'campaignId', v_camp, 'adGroupId', v_ag,
                         'action', v_action, 'value', v_after -> 'value'),
      v_before, v_after, v_currency, v_reason, v_sugg,
      auth.uid(),
      case when v_sugg is not null then 'suggestion' else 'web' end,
      'pending_approval'
    )
    returning id, approval_reason
  )
  select ins.id, ins.approval_reason into v_id, v_reason_calc from ins;

  -- Tự chạy khi KHÔNG vượt ngưỡng; hoặc khi người yêu cầu CHÍNH LÀ người có quyền
  -- duyệt (trưởng phòng PPC tự làm — vẫn ghi rõ decided_by để audit đọc được).
  if v_reason_calc is null or v_approver then
    update ads.change_requests r
       set status = 'approved',
           decided_by = auth.uid(),
           decided_at = now(),
           decision_note = case when v_reason_calc is null
                                then 'Tự động duyệt: không vượt ngưỡng 30%/ngày (SOP-05 b4).'
                                else 'Trưởng phòng PPC tự duyệt yêu cầu của mình (có ghi audit).'
                           end
     where r.id = v_id;
  end if;

  insert into iam.audit_logs (actor_id, seller_account_id, module, action, entity, before_value, after_value, result)
  values (auth.uid(), p_seller, 'ads',
          case v_action
            when 'set_budget' then 'ads.budget_change_request'
            when 'set_bid'    then 'ads.bid_change_request'
            when 'set_state'  then 'ads.state_change_request'
            else 'ads.negative_add_request'
          end,
          coalesce(v_label, v_ekey), v_before, v_after,
          case when v_reason_calc is null or v_approver then 'ok' else 'pending_approval' end);

  return query
    select r.id, r.status, r.requires_approval, r.approval_reason, r.before_value, r.after_value, r.currency
      from ads.change_requests r where r.id = v_id;
end;
$$;

comment on function public.vexim_request_ads_change(uuid, jsonb) is
  'M5P3: tạo yêu cầu ghi lên Amazon Ads. Tự đọc giá trị hiện tại từ DB, TỰ TÍNH ngưỡng '
  'duyệt (trigger tính lại lần nữa), tự duyệt khi không vượt ngưỡng, luôn ghi audit log. '
  'Chỉ người có quyền ghi shop mới gọi được.';

create or replace function public.vexim_decide_ads_change(
  p_change_id uuid,
  p_decision  text,
  p_note      text default null
)
returns table (change_id uuid, status text, decided_by uuid)
language plpgsql
security definer
set search_path = ads, iam, public, pg_catalog
as $$
declare
  v_row    ads.change_requests%rowtype;
  v_action text := lower(btrim(coalesce(p_decision, '')));
  v_target text;
begin
  if v_action not in ('approve','reject') then
    raise exception '[M5P3] quyết định không hợp lệ: % (approve|reject)', p_decision
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_row from ads.change_requests r where r.id = p_change_id for update;
  if not found then
    raise exception '[M5P3] không tìm thấy yêu cầu %', p_change_id using errcode = 'no_data_found';
  end if;
  if v_row.status <> 'pending_approval' then
    raise exception '[M5P3] yêu cầu đang ở trạng thái % — chỉ duyệt được yêu cầu đang chờ', v_row.status
      using errcode = 'check_violation';
  end if;
  if not iam.is_ads_approver() then
    raise exception '[M5P3] chỉ trưởng phòng PPC / admin được duyệt thay đổi quảng cáo'
      using errcode = 'insufficient_privilege';
  end if;
  if not iam.can_read_seller_account(v_row.seller_account_id) then
    raise exception '[M5P3] bạn không có quyền với shop của yêu cầu này'
      using errcode = 'insufficient_privilege';
  end if;

  v_target := case v_action when 'approve' then 'approved' else 'rejected' end;
  update ads.change_requests r
     set status = v_target,
         decided_by = auth.uid(),
         decided_at = now(),
         decision_note = nullif(btrim(coalesce(p_note, '')), '')
   where r.id = p_change_id;

  insert into iam.audit_logs (actor_id, seller_account_id, module, action, entity, before_value, after_value, result)
  values (auth.uid(), v_row.seller_account_id, 'ads',
          case v_action when 'approve' then 'ads.change_approve' else 'ads.change_reject' end,
          coalesce(nullif(v_row.entity_label,''), v_row.entity_key),
          v_row.before_value, v_row.after_value,
          coalesce(nullif(btrim(coalesce(p_note,'')), ''), v_target));

  return query select p_change_id, v_target, auth.uid();
end;
$$;

comment on function public.vexim_decide_ads_change(uuid, text, text) is
  'M5P3: trưởng phòng PPC/admin duyệt hoặc từ chối yêu cầu vượt ngưỡng (SOP-05 b4). '
  'Mọi quyết định đều ghi audit log, kể cả từ chối.';

create or replace function public.vexim_cancel_ads_change(
  p_change_id uuid,
  p_note      text default null
)
returns table (change_id uuid, status text)
language plpgsql
security definer
set search_path = ads, iam, public, pg_catalog
as $$
declare
  v_row ads.change_requests%rowtype;
begin
  select * into v_row from ads.change_requests r where r.id = p_change_id for update;
  if not found then
    raise exception '[M5P3] không tìm thấy yêu cầu %', p_change_id using errcode = 'no_data_found';
  end if;
  if v_row.status not in ('pending_approval','approved','failed') then
    raise exception '[M5P3] không huỷ được yêu cầu ở trạng thái %', v_row.status
      using errcode = 'check_violation';
  end if;
  if not (v_row.requested_by = auth.uid() or iam.is_ads_approver()) then
    raise exception '[M5P3] chỉ người tạo yêu cầu hoặc trưởng phòng PPC mới huỷ được'
      using errcode = 'insufficient_privilege';
  end if;

  update ads.change_requests r set status = 'cancelled' where r.id = p_change_id;

  insert into iam.audit_logs (actor_id, seller_account_id, module, action, entity, before_value, result)
  values (auth.uid(), v_row.seller_account_id, 'ads', 'ads.change_cancel',
          coalesce(nullif(v_row.entity_label,''), v_row.entity_key), v_row.before_value,
          coalesce(nullif(btrim(coalesce(p_note,'')), ''), 'cancelled'));

  return query select p_change_id, 'cancelled'::text;
end;
$$;

comment on function public.vexim_cancel_ads_change(uuid, text) is
  'M5P3: huỷ yêu cầu chưa gửi Amazon (người tạo huặc trưởng phòng PPC) + audit log.';

create or replace function public.vexim_revert_ads_change(
  p_change_id uuid,
  p_note      text default null
)
returns table (
  change_id uuid, status text, requires_approval boolean, approval_reason text,
  before_value jsonb, after_value jsonb
)
language plpgsql
security definer
set search_path = ads, iam, public, pg_catalog
as $$
-- `approval_reason` vừa là cột của ads.change_requests vừa là cột OUT của hàm:
-- ưu tiên CỘT, mọi biến trong hàm đều đã có tiền tố v_/p_ nên không bị che.
#variable_conflict use_column
declare
  v_row     ads.change_requests%rowtype;
  v_new_id  uuid;
  v_reason  text;
  v_etype   text;
  v_ekey    text;
begin
  select * into v_row from ads.change_requests r where r.id = p_change_id for update;
  if not found then
    raise exception '[M5P3] không tìm thấy yêu cầu %', p_change_id using errcode = 'no_data_found';
  end if;
  if v_row.status <> 'applied' then
    raise exception '[M5P3] chỉ revert được yêu cầu ĐÃ áp dụng lên Amazon (đang: %)', v_row.status
      using errcode = 'check_violation';
  end if;
  if v_row.action not in ('set_budget','set_bid','set_state') then
    raise exception '[M5P3] chưa hỗ trợ revert negative keyword qua API — xoá trực tiếp trên '
                    'Amazon Ads console rồi sync lại (hệ thống ghi nhận vào audit).'
      using errcode = 'feature_not_supported';
  end if;
  if not iam.can_write_seller_account(v_row.seller_account_id) then
    raise exception '[M5P3] bạn không có quyền ghi cho shop này' using errcode = 'insufficient_privilege';
  end if;

  v_etype := v_row.entity_type;
  v_ekey  := v_row.entity_key;

  -- Đảo giá trị: before ↔ after. Kết quả revert có thể VƯỢT NGƯỠNG (ví dụ đảo một
  -- lần giảm ngân sách) — khi đó phải chờ duyệt như mọi yêu cầu khác.
  with ins as (
    insert into ads.change_requests (
      seller_account_id, ads_profile_id, entity_type, entity_key, campaign_id, ad_group_id,
      entity_label, action, payload, before_value, after_value, currency, reason,
      requested_by, source, status, revert_of
    ) values (
      v_row.seller_account_id, v_row.ads_profile_id, v_etype, v_ekey,
      v_row.campaign_id, v_row.ad_group_id, v_row.entity_label, v_row.action,
      jsonb_build_object('sellerAccountId', v_row.seller_account_id, 'adsProfileId', v_row.ads_profile_id,
                         'entityType', v_etype, 'entityKey', v_ekey,
                         'campaignId', v_row.campaign_id, 'adGroupId', v_row.ad_group_id,
                         'action', v_row.action, 'value', v_row.before_value -> 'value'),
      v_row.after_value, v_row.before_value, v_row.currency,
      coalesce(nullif(btrim(coalesce(p_note,'')), ''),
               format('Revert yêu cầu %s ngày %s', left(v_row.id::text, 8), to_char(v_row.applied_at, 'DD/MM HH24:MI'))),
      auth.uid(), 'revert', 'pending_approval', v_row.id
    )
    returning id, approval_reason
  )
  select ins.id, ins.approval_reason into v_new_id, v_reason from ins;

  update ads.change_requests r
     set status = 'approved',
         decided_by = auth.uid(),
         decided_at = now(),
         decision_note = case when v_reason is null
                              then 'Revert không vượt ngưỡng ⇒ tự động duyệt.'
                              else 'Trưởng phòng PPC duyệt yêu cầu revert.'
                         end
   where r.id = v_new_id and (v_reason is null or iam.is_ads_approver());

  update ads.change_requests r set reverted_by = v_new_id where r.id = p_change_id;

  insert into iam.audit_logs (actor_id, seller_account_id, module, action, entity, before_value, after_value, result)
  values (auth.uid(), v_row.seller_account_id, 'ads', 'ads.change_revert_request',
          coalesce(nullif(v_row.entity_label,''), v_ekey), v_row.after_value, v_row.before_value,
          case when v_reason is null then 'ok' else 'pending_approval' end);

  return query
    select r.id, r.status, r.requires_approval, r.approval_reason, r.before_value, r.after_value
      from ads.change_requests r where r.id = v_new_id;
end;
$$;

comment on function public.vexim_revert_ads_change(uuid, text) is
  'M5P3: revert 1-click — tạo yêu cầu MỚI đảo before/after của một yêu cầu đã applied '
  '(không sửa dòng cũ). Nếu lần đảo đó vượt ngưỡng 30% thì lại phải chờ trưởng phòng duyệt.';

create or replace function public.vexim_decide_ads_suggestion(
  p_suggestion_id uuid,
  p_decision      text,
  p_note          text default null
)
returns table (suggestion_id uuid, status text, change_id uuid, message text)
language plpgsql
security definer
set search_path = ads, iam, public, pg_catalog
as $$
declare
  v_sug     ads.negative_suggestions%rowtype;
  v_decision text := lower(btrim(coalesce(p_decision, '')));
  v_status  text;
  v_change  uuid;
begin
  if v_decision not in ('approve','reject','dismiss') then
    raise exception '[M5P3] quyết định không hợp lệ: % (approve|reject|dismiss)', p_decision
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_sug from ads.negative_suggestions s where s.id = p_suggestion_id for update;
  if not found then
    raise exception '[M5P3] không tìm thấy gợi ý %', p_suggestion_id using errcode = 'no_data_found';
  end if;
  if v_sug.status <> 'pending' then
    raise exception '[M5P3] gợi ý đang ở trạng thái % — chỉ xử lý được gợi ý đang chờ', v_sug.status
      using errcode = 'check_violation';
  end if;
  if not iam.can_write_seller_account(v_sug.seller_account_id) then
    raise exception '[M5P3] bạn không có quyền ghi cho shop này' using errcode = 'insufficient_privilege';
  end if;

  v_status := case v_decision
                when 'approve' then 'approved'
                when 'reject'  then 'rejected'
                else 'dismissed'
              end;

  if v_decision = 'approve' and v_sug.suggestion_type in ('negative_exact','negative_phrase') then
    -- Duyệt gợi ý ⇒ SINH yêu cầu ghi (đi đúng một đường với mọi thay đổi khác):
    -- hàng đợi → worker → Ads API → audit. Negative không cần duyệt ngưỡng.
    insert into ads.change_requests (
      seller_account_id, ads_profile_id, entity_type, entity_key, campaign_id, ad_group_id,
      entity_label, action, payload, after_value, reason, suggestion_id, requested_by, source, status
    ) values (
      v_sug.seller_account_id, v_sug.ads_profile_id, 'search_term', lower(v_sug.term),
      v_sug.campaign_id, v_sug.ad_group_id,
      coalesce(nullif(v_sug.term, ''), v_sug.keyword_text, 'search term'),
      case v_sug.suggestion_type when 'negative_phrase' then 'add_negative_phrase' else 'add_negative_exact' end,
      jsonb_build_object('sellerAccountId', v_sug.seller_account_id, 'adsProfileId', v_sug.ads_profile_id,
                         'entityType', 'search_term', 'entityKey', lower(v_sug.term),
                         'campaignId', v_sug.campaign_id, 'adGroupId', v_sug.ad_group_id,
                         'action', case v_sug.suggestion_type when 'negative_phrase' then 'add_negative_phrase' else 'add_negative_exact' end,
                         'value', lower(v_sug.term)),
      jsonb_build_object('value', lower(v_sug.term)),
      coalesce(nullif(btrim(coalesce(p_note,'')), ''),
               format('Duyệt gợi ý A3 (%s · tin cậy %s)', v_sug.suggestion_type, coalesce(v_sug.confidence_label, '—'))),
      v_sug.id, auth.uid(), 'suggestion', 'pending_approval'
    )
    returning id into v_change;

    update ads.change_requests r
       set status = 'approved', decided_by = auth.uid(), decided_at = now(),
           decision_note = 'Tự động duyệt: thêm negative là hành động giảm chi tiêu (không cần ngưỡng).'
     where r.id = v_change;
  end if;

  update ads.negative_suggestions s
     set status = v_status, decided_by = auth.uid(), decided_at = now(),
         decision_note = nullif(btrim(coalesce(p_note, '')), ''), updated_at = now()
   where s.id = p_suggestion_id;

  insert into iam.audit_logs (actor_id, seller_account_id, module, action, entity, after_value, result)
  values (auth.uid(), v_sug.seller_account_id, 'ads',
          case v_decision
            when 'approve' then 'ads.suggestion_approve'
            when 'reject'  then 'ads.suggestion_reject'
            else 'ads.suggestion_dismiss'
          end,
          coalesce(nullif(v_sug.term, ''), v_sug.keyword_text, v_sug.suggestion_type),
          jsonb_build_object('suggestionType', v_sug.suggestion_type, 'confidence', v_sug.confidence,
                             'changeRequestId', v_change),
          v_status);

  return query select p_suggestion_id, v_status, v_change,
    case
      when v_decision <> 'approve' then 'Đã ' || v_status || ' gợi ý.'
      when v_change is not null then 'Đã tạo yêu cầu thêm negative và đưa vào hàng đợi ghi Amazon.'
      else 'Gợi ý loại ' || v_sug.suggestion_type || ' chưa hỗ trợ ghi tự động — dùng màn A2 để sửa bid/tạm dừng keyword.'
    end;
end;
$$;

comment on function public.vexim_decide_ads_suggestion(uuid, text, text) is
  'M5P3: duyệt/từ chối/bỏ qua gợi ý A3. Duyệt gợi ý negative ⇒ tự sinh yêu cầu ghi '
  '(đi cùng một đường: hàng đợi → worker → Ads API → audit). Chỉ người có quyền ghi.';

-- ============================================================================
-- 7. RPC CHO WORKER — claim · ghi kết quả · gương negative
-- ============================================================================
create or replace function public.vexim_worker_claim_ads_changes(
  p_seller uuid,
  p_limit  int default 20
)
returns table (
  change_id uuid, entity_type text, entity_key text, campaign_id text, ad_group_id text,
  action text, payload jsonb, before_value jsonb, after_value jsonb,
  ads_profile_id text, currency text, entity_label text, suggestion_id uuid, attempts int
)
language plpgsql
security definer
set search_path = ads, public, pg_catalog
as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 200);
begin
  if auth.uid() is not null then
    raise exception '[M5P3] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_seller is null then
    raise exception '[M5P3] thiếu seller_account_id' using errcode = 'invalid_parameter_value';
  end if;

  return query
  with claimed as (
    select r.id
      from ads.change_requests r
     where r.seller_account_id = p_seller
       and r.status = 'approved'
     order by r.requested_at, r.id   -- id làm chỗ phá thế bằng khi cùng thời điểm (test/cron đua nhau)
     limit v_limit
     for update skip locked
  )
  update ads.change_requests r
     set status = 'applying', attempts = r.attempts + 1
    from claimed c
   where r.id = c.id
  returning r.id, r.entity_type, r.entity_key, r.campaign_id, r.ad_group_id, r.action,
            r.payload, r.before_value, r.after_value, r.ads_profile_id, r.currency,
            r.entity_label, r.suggestion_id, r.attempts;
end;
$$;

comment on function public.vexim_worker_claim_ads_changes(uuid, int) is
  'M5P3: worker nhận các yêu cầu ĐÃ duyệt của một shop (chuyển approved → applying, '
  'skip locked ⇒ chạy song song không giẫm nhau). Chỉ service_role.';

create or replace function public.vexim_worker_record_ads_change(
  p_change_id uuid,
  p_ok        boolean,
  p_api       jsonb default null,
  p_error     text default null
)
returns table (change_id uuid, status text, mirrored boolean, keyword_id text, suggestion_applied boolean)
language plpgsql
security definer
set search_path = ads, iam, public, pg_catalog
as $$
declare
  v_row      ads.change_requests%rowtype;
  v_kw_id    text := nullif(btrim(coalesce(p_api ->> 'keywordId', '')), '');
  v_mirrored boolean := false;
  v_sugg     boolean := false;
  v_status   text;
begin
  if auth.uid() is not null then
    raise exception '[M5P3] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_row from ads.change_requests r where r.id = p_change_id for update;
  if not found then
    raise exception '[M5P3] không tìm thấy yêu cầu %', p_change_id using errcode = 'no_data_found';
  end if;
  if v_row.status <> 'applying' then
    raise exception '[M5P3] yêu cầu đang ở % — chỉ ghi kết quả cho dòng đang applying', v_row.status
      using errcode = 'check_violation';
  end if;

  if not coalesce(p_ok, false) then
    update ads.change_requests r
       set status = 'failed',
           error = coalesce(nullif(btrim(coalesce(p_error, '')), ''), 'Amazon từ chối (không có thông báo)'),
           api_response = p_api
     where r.id = p_change_id;

    insert into iam.audit_logs (actor_id, seller_account_id, module, action, entity, before_value, after_value, result)
    values (null, v_row.seller_account_id, 'ads', 'ads.change_failed',
            coalesce(nullif(v_row.entity_label,''), v_row.entity_key),
            v_row.before_value, v_row.after_value,
            'error: ' || coalesce(nullif(btrim(coalesce(p_error, '')), ''), 'Amazon từ chối'));

    return query select p_change_id, 'failed'::text, false, null::text, false;
    return;
  end if;

  -- ---- Áp dụng thành công: ghi dấu + cập nhật cục bộ để màn hình đúng ngay ----
  update ads.change_requests r
     set status = 'applied', applied_at = now(), api_response = p_api, error = null
   where r.id = p_change_id;

  if v_row.action = 'set_budget' then
    update ads.campaigns c
       set daily_budget = (v_row.after_value ->> 'value')::numeric, updated_at = now()
     where c.seller_account_id = v_row.seller_account_id and c.campaign_id = v_row.entity_key;
    v_mirrored := found;
  elsif v_row.action = 'set_bid' then
    update ads.targets t
       set bid = (v_row.after_value ->> 'value')::numeric, updated_at = now()
     where t.seller_account_id = v_row.seller_account_id
       and t.target_kind = 'keyword' and t.target_key = v_row.entity_key;
    v_mirrored := found;
  elsif v_row.action = 'set_state' then
    if v_row.entity_type = 'campaign' then
      update ads.campaigns c
         set state = upper(v_row.after_value ->> 'value'), updated_at = now()
       where c.seller_account_id = v_row.seller_account_id and c.campaign_id = v_row.entity_key;
    else
      update ads.targets t
         set state = upper(v_row.after_value ->> 'value'), updated_at = now()
       where t.seller_account_id = v_row.seller_account_id
         and t.target_kind = 'keyword' and t.target_key = v_row.entity_key;
    end if;
    v_mirrored := found;
  else
    -- negative: ghi vào GƯƠNG để trả lời "đã chặn chưa, chặn từ bao giờ"
    insert into ads.negative_keywords (
      seller_account_id, ads_profile_id, campaign_id, ad_group_id, keyword_id,
      keyword_text, match_type, state, source, change_request_id
    ) values (
      v_row.seller_account_id, v_row.ads_profile_id, v_row.campaign_id, v_row.ad_group_id,
      coalesce(v_kw_id, ''), v_row.after_value ->> 'value',
      case v_row.action when 'add_negative_phrase' then 'NEGATIVE_PHRASE' else 'NEGATIVE_EXACT' end,
      'ENABLED', 'suggestion', v_row.id
    )
    on conflict (seller_account_id, ad_group_id, lower(keyword_text), match_type) do update
       set keyword_id = coalesce(nullif(excluded.keyword_id, ''), ads.negative_keywords.keyword_id),
           state = 'ENABLED', updated_at = now();
    v_mirrored := true;
  end if;

  if v_row.suggestion_id is not null then
    update ads.negative_suggestions s
       set status = 'applied', applied_at = now(), updated_at = now()
     where s.id = v_row.suggestion_id and s.status in ('approved','pending');
    v_sugg := found;
  end if;

  insert into iam.audit_logs (actor_id, seller_account_id, module, action, entity, before_value, after_value, result)
  values (null, v_row.seller_account_id, 'ads',
          case v_row.action
            when 'set_budget' then 'ads.budget_change_applied'
            when 'set_bid'    then 'ads.bid_change_applied'
            when 'set_state'  then 'ads.state_change_applied'
            else 'ads.negative_add_applied'
          end,
          coalesce(nullif(v_row.entity_label,''), v_row.entity_key),
          v_row.before_value, v_row.after_value,
          jsonb_build_object('keywordId', v_kw_id, 'aws', p_api)::text);

  return query select p_change_id, 'applied'::text, v_mirrored, v_kw_id, v_sugg;
end;
$$;

comment on function public.vexim_worker_record_ads_change(uuid, boolean, jsonb, text) is
  'M5P3: worker ghi kết quả Amazon trả về (applied/failed) + cập nhật cục bộ '
  '(campaigns.daily_budget, targets.bid/state, negative_keywords) + audit log + đóng gợi ý A3. '
  'Chỉ service_role.';

create or replace function public.vexim_worker_upsert_ads_negative_keywords(
  p_seller uuid,
  p_rows   jsonb
)
returns table (inserted int, updated int, skipped int)
language plpgsql
security definer
set search_path = ads, public, pg_catalog
as $$
declare
  v_ins int := 0;
  v_upd int := 0;
  v_skip int := 0;
  v_is_insert boolean := true;
  r     record;
begin
  if auth.uid() is not null then
    raise exception '[M5P3] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_seller is null then
    raise exception '[M5P3] thiếu seller_account_id' using errcode = 'invalid_parameter_value';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '[M5P3] p_rows phải là mảng JSON' using errcode = 'invalid_parameter_value';
  end if;

  for r in
    select
      btrim(coalesce(x ->> 'adGroupId', ''))                       as ad_group_id,
      btrim(coalesce(x ->> 'campaignId', ''))                      as campaign_id,
      btrim(coalesce(x ->> 'adsProfileId', ''))                    as ads_profile_id,
      btrim(coalesce(x ->> 'keywordId', ''))                       as keyword_id,
      btrim(coalesce(x ->> 'keywordText', ''))                     as keyword_text,
      upper(btrim(coalesce(x ->> 'matchType', 'NEGATIVE_EXACT')))  as match_type,
      upper(btrim(coalesce(x ->> 'state', 'ENABLED')))             as state
    from jsonb_array_elements(p_rows) x
  loop
    if r.keyword_text = '' then
      v_skip := v_skip + 1;
      continue;   -- negative không có chữ thì vô nghĩa
    end if;
    if r.match_type not in ('NEGATIVE_EXACT','NEGATIVE_PHRASE') then
      v_skip := v_skip + 1;
      continue;
    end if;

    insert into ads.negative_keywords (
      seller_account_id, ads_profile_id, campaign_id, ad_group_id, keyword_id,
      keyword_text, match_type, state, source
    ) values (
      p_seller, r.ads_profile_id, r.campaign_id, r.ad_group_id, r.keyword_id,
      r.keyword_text, r.match_type, r.state, 'api'
    )
    on conflict (seller_account_id, ad_group_id, lower(keyword_text), match_type) do update
       set keyword_id = coalesce(nullif(excluded.keyword_id,''), ads.negative_keywords.keyword_id),
           state = excluded.state,
           updated_at = now()
    -- `xmax = 0` là cách phân biệt INSERT với UPDATE trong câu ON CONFLICT của Postgres.
    returning (xmax = 0) into v_is_insert;
    if v_is_insert then
      v_ins := v_ins + 1;
    else
      v_upd := v_upd + 1;
    end if;
  end loop;

  return query select v_ins, v_upd, v_skip;
end;
$$;

comment on function public.vexim_worker_upsert_ads_negative_keywords(uuid, jsonb) is
  'M5P3: đồng bộ danh sách negative keyword hiện có trên Amazon về gương ads.negative_keywords. '
  'Dòng thiếu chữ hoặc sai match type bị BỎ và đếm (không tạo rác). Chỉ service_role.';

-- ============================================================================
-- 8. VIEW
-- ============================================================================
-- 8.1 vexim_ads_ad_groups — A2: ad group + hiệu quả 7 ngày
create or replace view public.vexim_ads_ad_groups
with (security_invoker = true) as
with last_day as (
  select seller_account_id, max(day) as day from ads.target_metrics_daily group by 1
),
agg as (
  select
    m.seller_account_id, m.ad_group_id, m.currency,
    max(m.day)                                                 as last_metric_day,
    sum(m.cost)     filter (where m.day > ld.day - 7)          as spend_7d,
    sum(m.sales_7d) filter (where m.day > ld.day - 7)          as sales_7d,
    sum(m.purchases_7d) filter (where m.day > ld.day - 7)      as purchases_7d,
    sum(m.clicks)   filter (where m.day > ld.day - 7)          as clicks_7d,
    sum(m.impressions) filter (where m.day > ld.day - 7)       as impressions_7d
  from ads.target_metrics_daily m
  join last_day ld on ld.seller_account_id = m.seller_account_id
  group by 1, 2, 3
),
targets as (
  select seller_account_id, ad_group_id, count(*) as target_count,
         count(*) filter (where state = 'ENABLED') as enabled_targets
  from ads.targets group by 1, 2
)
select
  g.seller_account_id,
  sa.display_name as shop,
  g.ads_profile_id,
  g.campaign_id,
  c.name          as campaign_name,
  c.state         as campaign_state,
  g.ad_group_id,
  g.name,
  g.state,
  g.default_bid,
  coalesce(g.currency, c.budget_currency, a.currency) as currency,
  a.last_metric_day as last_day,
  a.spend_7d,
  a.sales_7d,
  a.purchases_7d,
  a.clicks_7d,
  a.impressions_7d,
  coalesce(t.target_count, 0)    as target_count,
  coalesce(t.enabled_targets, 0) as enabled_targets,
  round(a.spend_7d / nullif(a.clicks_7d, 0), 2)                      as cpc_7d,
  round(a.clicks_7d::numeric * 100 / nullif(a.impressions_7d, 0), 2) as ctr_7d,
  round(a.spend_7d * 100 / nullif(a.sales_7d, 0), 2)                 as acos_7d,
  round(a.sales_7d / nullif(a.spend_7d, 0), 2)                       as roas_7d,
  g.updated_at
from ads.ad_groups g
join connections.seller_accounts sa on sa.id = g.seller_account_id
left join ads.campaigns c
       on c.seller_account_id = g.seller_account_id and c.campaign_id = g.campaign_id
left join agg a
       on a.seller_account_id = g.seller_account_id and a.ad_group_id = g.ad_group_id
left join targets t
       on t.seller_account_id = g.seller_account_id and t.ad_group_id = g.ad_group_id;

comment on view public.vexim_ads_ad_groups is
  'A2 — ad group trong campaign kèm hiệu quả 7 ngày (CPC/CTR/ACOS/ROAS suy ra) và số keyword/target.';

-- 8.2 vexim_ads_changes — hàng đợi + lịch sử thay đổi
create or replace view public.vexim_ads_changes
with (security_invoker = true) as
select
  r.id,
  r.seller_account_id,
  sa.display_name as shop,
  r.ads_profile_id,
  r.entity_type,
  r.entity_key,
  r.campaign_id,
  r.ad_group_id,
  r.entity_label,
  r.action,
  r.payload,
  r.before_value,
  r.after_value,
  r.before_value ->> 'value' as before_text,
  r.after_value  ->> 'value' as after_text,
  r.currency,
  r.reason,
  r.suggestion_id,
  r.requires_approval,
  r.approval_reason,
  r.status,
  r.requested_by,
  up.display_name          as requested_by_name,
  r.requested_at,
  r.decided_by,
  ud.display_name          as decided_by_name,
  r.decided_at,
  r.decision_note,
  r.applied_at,
  r.error,
  r.attempts,
  r.revert_of,
  r.reverted_by,
  r.source,
  (r.status in ('pending_approval','approved','applying')) as is_open,
  (r.status = 'applied' and r.reverted_by is null
     and r.action in ('set_budget','set_bid','set_state'))   as can_revert,
  r.created_at,
  r.updated_at
from ads.change_requests r
join connections.seller_accounts sa on sa.id = r.seller_account_id
left join iam.user_profiles up on up.id = r.requested_by
left join iam.user_profiles ud on ud.id = r.decided_by;

comment on view public.vexim_ads_changes is
  'A4/duyệt: hàng đợi thay đổi quảng cáo kèm người yêu cầu/người duyệt, giá trị trước–sau, '
  'lý do ngưỡng duyệt và cờ can_revert (chỉ dòng đã áp dụng và chưa bị đảo).';

-- 8.3 vexim_ads_negative_keywords — đã chặn gì rồi
create or replace view public.vexim_ads_negative_keywords
with (security_invoker = true) as
select
  n.id,
  n.seller_account_id,
  sa.display_name as shop,
  n.campaign_id,
  c.name          as campaign_name,
  n.ad_group_id,
  g.name          as ad_group_name,
  n.keyword_id,
  n.keyword_text,
  n.match_type,
  n.state,
  n.source,
  n.change_request_id,
  n.created_at,
  n.updated_at
from ads.negative_keywords n
join connections.seller_accounts sa on sa.id = n.seller_account_id
left join ads.campaigns c
       on c.seller_account_id = n.seller_account_id and c.campaign_id = n.campaign_id
left join ads.ad_groups g
       on g.seller_account_id = n.seller_account_id and g.ad_group_id = n.ad_group_id;

comment on view public.vexim_ads_negative_keywords is
  'Negative keyword đã đẩy lên Amazon (nguồn: gợi ý A3 / nhập tay / đồng bộ từ API).';

-- 8.4 vexim_ads_audit — nhật ký thao tác quảng cáo (từ iam.audit_logs)
create or replace view public.vexim_ads_audit
with (security_invoker = true) as
select
  a.id,
  a.created_at,
  a.seller_account_id,
  sa.display_name as shop,
  a.module,
  a.action,
  a.entity,
  a.before_value,
  a.after_value,
  a.before_value ->> 'value' as before_text,
  a.after_value  ->> 'value' as after_text,
  a.result,
  a.actor_id,
  up.display_name as actor_name
from iam.audit_logs a
left join connections.seller_accounts sa on sa.id = a.seller_account_id
left join iam.user_profiles up on up.id = a.actor_id
where a.module = 'ads';

comment on view public.vexim_ads_audit is
  'Nhật ký thao tác quảng cáo (Module 5) đọc từ iam.audit_logs: ai · lúc nào · trước/sau · kết quả.';

-- 8.5 Bổ sung `pending_suggestion_id` cho A3 (drop+create vì view không thêm cột giữa được)
drop view if exists public.vexim_ads_search_terms;
create view public.vexim_ads_search_terms
with (security_invoker = true) as
with last_day as (
  select seller_account_id, max(day) as day
  from ads.search_terms
  group by 1
),
agg as (
  select
    s.seller_account_id, s.campaign_id, s.ad_group_id, s.keyword_id, s.term, s.match_type,
    max(s.keyword_text)                                      as keyword_text,
    max(s.currency)                                          as currency,
    max(s.day)                                               as last_metric_day,
    sum(s.impressions) filter (where s.day > ld.day - 7)     as impressions_7d,
    sum(s.clicks)      filter (where s.day > ld.day - 7)     as clicks_7d,
    sum(s.cost)        filter (where s.day > ld.day - 7)     as spend_7d,
    sum(s.sales_7d)    filter (where s.day > ld.day - 7)     as sales_7d,
    sum(s.purchases_7d) filter (where s.day > ld.day - 7)    as purchases_7d,
    sum(s.units_sold_clicks_7d) filter (where s.day > ld.day - 7) as units_7d,
    sum(s.sales_14d)   filter (where s.day > ld.day - 14)    as sales_14d,
    sum(s.cost)        filter (where s.day > ld.day - 14)    as spend_14d,
    max(s.day) filter (where coalesce(s.purchases_7d, 0) > 0) as last_order_day
  from ads.search_terms s
  join last_day ld on ld.seller_account_id = s.seller_account_id
  group by 1, 2, 3, 4, 5, 6
)
select
  a.seller_account_id,
  sa.display_name as shop,
  a.campaign_id,
  c.name          as campaign_name,
  c.state         as campaign_state,
  a.ad_group_id,
  g.name          as ad_group_name,
  a.keyword_id,
  a.keyword_text,
  a.term,
  a.match_type,
  a.currency,
  a.last_metric_day as last_day,
  a.impressions_7d,
  a.clicks_7d,
  a.spend_7d,
  a.sales_7d,
  a.purchases_7d,
  a.units_7d,
  a.spend_14d,
  a.sales_14d,
  (coalesce(a.purchases_7d, 0) > 0) as has_orders_7d,
  a.last_order_day,
  round(a.spend_7d / nullif(a.clicks_7d, 0), 2)                    as cpc_7d,
  round(a.clicks_7d::numeric * 100 / nullif(a.impressions_7d, 0), 2) as ctr_7d,
  round(a.spend_7d * 100 / nullif(a.sales_7d, 0), 2)               as acos_7d,
  round(a.sales_7d / nullif(a.spend_7d, 0), 2)                     as roas_7d,
  round(a.spend_14d * 100 / nullif(a.sales_14d, 0), 2)             as acos_14d,
  sug.id                 as pending_suggestion_id,
  sug.suggestion_type    as pending_suggestion_type,
  sug.confidence         as pending_confidence,
  sug.confidence_label   as pending_confidence_label,
  sug.reasons            as pending_reasons,
  sug.evidence           as pending_evidence,
  neg.id                 as negative_keyword_id,
  neg.match_type         as negative_match_type
from agg a
join connections.seller_accounts sa on sa.id = a.seller_account_id
left join ads.campaigns c
       on c.seller_account_id = a.seller_account_id and c.campaign_id = a.campaign_id
left join ads.ad_groups g
       on g.seller_account_id = a.seller_account_id and g.ad_group_id = a.ad_group_id
left join lateral (
  select n.id, n.suggestion_type, n.confidence, n.confidence_label, n.reasons, n.evidence
  from ads.negative_suggestions n
  where n.seller_account_id = a.seller_account_id
    and n.campaign_id = a.campaign_id
    and n.ad_group_id = a.ad_group_id
    and n.term        = a.term
    and n.match_type  = a.match_type
    and n.status = 'pending'
  order by n.confidence desc nulls last
  limit 1
) sug on true
left join lateral (
  select k.id, k.match_type
  from ads.negative_keywords k
  where k.seller_account_id = a.seller_account_id
    and k.ad_group_id = a.ad_group_id
    and lower(k.keyword_text) = lower(a.term)
  limit 1
) neg on true;

comment on view public.vexim_ads_search_terms is
  'A3 — search term 7/14 ngày + has_orders_7d (dấu hiệu đốt tiền), GỢI Ý đang chờ duyệt '
  '(id + loại + mức tin cậy + bằng chứng) và cờ đã chặn (negative_keyword_id).';

-- ============================================================================
-- 9. RLS + GRANTS
-- ============================================================================
alter table ads.change_requests   enable row level security;
alter table ads.negative_keywords enable row level security;

drop policy if exists "change_requests: đọc theo shop" on ads.change_requests;
create policy "change_requests: đọc theo shop" on ads.change_requests
  for select to authenticated using (iam.can_read_seller_account(seller_account_id));

drop policy if exists "negative_keywords: đọc theo shop" on ads.negative_keywords;
create policy "negative_keywords: đọc theo shop" on ads.negative_keywords
  for select to authenticated using (iam.can_read_seller_account(seller_account_id));

-- Bảng mới tạo ở migration này ⇒ phải grant lại (0001 grant `all tables` chỉ áp cho bảng
-- đã tồn tại lúc đó). authenticated: chỉ SELECT (ghi phải qua RPC); service_role: toàn quyền.
grant select on ads.change_requests, ads.negative_keywords to authenticated;
grant all    on ads.change_requests, ads.negative_keywords to service_role;

grant select on public.vexim_ads_ad_groups, public.vexim_ads_changes,
                public.vexim_ads_negative_keywords, public.vexim_ads_audit,
                public.vexim_ads_search_terms
  to authenticated, service_role;

revoke all on function public.vexim_worker_claim_ads_changes(uuid, int)          from public, anon, authenticated;
revoke all on function public.vexim_worker_record_ads_change(uuid, boolean, jsonb, text) from public, anon, authenticated;
revoke all on function public.vexim_worker_upsert_ads_negative_keywords(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.vexim_worker_claim_ads_changes(uuid, int)        to service_role;
grant execute on function public.vexim_worker_record_ads_change(uuid, boolean, jsonb, text) to service_role;
grant execute on function public.vexim_worker_upsert_ads_negative_keywords(uuid, jsonb) to service_role;

grant execute on function public.vexim_request_ads_change(uuid, jsonb)       to authenticated, service_role;
grant execute on function public.vexim_decide_ads_change(uuid, text, text)   to authenticated, service_role;
grant execute on function public.vexim_cancel_ads_change(uuid, text)         to authenticated, service_role;
grant execute on function public.vexim_revert_ads_change(uuid, text)         to authenticated, service_role;
grant execute on function public.vexim_decide_ads_suggestion(uuid, text, text) to authenticated, service_role;

-- ============================================================================
-- 10. TỰ SOÁT (DO-block) — migration sai thì phải NỔ ngay, không im lặng
-- ============================================================================
do $$
declare
  n int;
  v_id uuid;
  v_reason text;
begin
  -- 10.1 hai bảng mới + RLS + policy đọc
  if not exists (select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
                 where ns.nspname = 'ads' and c.relname = 'change_requests') then
    raise exception '[0021] FAIL: thiếu bảng ads.change_requests';
  end if;
  if not exists (select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
                 where ns.nspname = 'ads' and c.relname = 'negative_keywords') then
    raise exception '[0021] FAIL: thiếu bảng ads.negative_keywords';
  end if;

  select count(*) into n from pg_policies
   where schemaname = 'ads' and tablename in ('change_requests','negative_keywords') and cmd = 'SELECT';
  if n < 2 then
    raise exception '[0021] FAIL: thiếu policy đọc cho bảng mới (%/2)', n;
  end if;
  select count(*) into n from pg_policies
   where schemaname = 'ads' and tablename in ('change_requests','negative_keywords')
     and cmd in ('INSERT','UPDATE','DELETE');
  if n <> 0 then
    raise exception '[0021] FAIL: bảng mới KHÔNG được có policy ghi (chỉ ghi qua RPC), thấy %', n;
  end if;

  -- 10.1b KHÔNG còn policy nào tham chiếu trực tiếp role_assignments/user_profiles
  --       (còn là còn đệ quy ⇒ không đọc được tên người dùng ở hàng đợi duyệt)
  select count(*) into n from pg_policies
   where qual like '%role_assignments%' or coalesce(with_check,'') like '%role_assignments%'
      or qual like '%user_profiles%'   or coalesce(with_check,'') like '%user_profiles%';
  if n <> 0 then
    raise exception '[0021] FAIL: còn % policy tự tham chiếu iam (xem khối 0)', n;
  end if;
  if not (iam.has_role(array['super_admin']) is false or iam.has_role(array['super_admin']) is true) then
    raise exception '[0021] FAIL: iam.has_role không dùng được với auth.uid() = NULL';
  end if;

  -- 10.2 luật ngưỡng 30%
  if ads.approval_reason('set_budget', 100, 125, 'campaign') is not null then
    raise exception '[0021] FAIL: tăng 25%% không được đòi duyệt';
  end if;
  if ads.approval_reason('set_budget', 100, 131, 'campaign') is null then
    raise exception '[0021] FAIL: tăng 31%% PHẢI đòi duyệt (SOP-05 b4)';
  end if;
  if ads.approval_reason('set_bid', 1.0, 1.4, 'keyword') is null then
    raise exception '[0021] FAIL: tăng bid 40%% PHẢI đòi duyệt';
  end if;
  if ads.approval_reason('add_negative_exact', null, null, 'search_term') is not null then
    raise exception '[0021] FAIL: thêm negative KHÔNG được đòi duyệt';
  end if;
  if ads.approval_reason_state('set_state', 'PAUSED', 'ENABLED') is null then
    raise exception '[0021] FAIL: bật lại campaign PHẢI đòi duyệt';
  end if;
  if ads.approval_reason_state('set_state', 'ENABLED', 'PAUSED') is not null then
    raise exception '[0021] FAIL: tạm dừng KHÔNG được đòi duyệt (hành động chặn chi tiêu)';
  end if;

  -- 10.3 trigger chặn sửa nội dung dòng đã applied
  if not exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                 join pg_namespace ns on ns.oid = c.relnamespace
                 where ns.nspname = 'ads' and c.relname = 'change_requests'
                   and t.tgname = 'trg_ads_change_requests_guard' and not t.tgisinternal) then
    raise exception '[0021] FAIL: thiếu trigger trg_ads_change_requests_guard';
  end if;

  -- 10.4 view mới + hợp đồng cột A3 (phải có id gợi ý để duyệt được)
  if not exists (
    select 1 from information_schema.views
     where table_schema = 'public' and table_name = 'vexim_ads_search_terms'
  ) then
    raise exception '[0021] FAIL: view A3 chưa được tạo lại';
  end if;
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'vexim_ads_search_terms'
     and column_name in ('pending_suggestion_id','negative_keyword_id');
  if n <> 2 then
    raise exception '[0021] FAIL: view A3 thiếu cột gợi ý/đã chặn (%/2)', n;
  end if;

  select count(*) into n from information_schema.views
   where table_schema = 'public'
     and table_name in ('vexim_ads_ad_groups','vexim_ads_changes','vexim_ads_negative_keywords','vexim_ads_audit');
  if n <> 4 then
    raise exception '[0021] FAIL: thiếu view mới (%/4)', n;
  end if;

  -- 10.4b grant: authenticated chỉ SELECT (không ghi thẳng bảng), service_role toàn quyền
  if not has_table_privilege('authenticated', 'ads.change_requests', 'SELECT')
     or has_table_privilege('authenticated', 'ads.change_requests', 'INSERT')
     or has_table_privilege('authenticated', 'ads.change_requests', 'UPDATE')
     or has_table_privilege('authenticated', 'ads.change_requests', 'DELETE')
     or has_table_privilege('authenticated', 'ads.negative_keywords', 'INSERT')
     or has_table_privilege('authenticated', 'ads.negative_keywords', 'DELETE') then
    raise exception '[0021] FAIL: grant bảng mới sai (authenticated chỉ được SELECT)';
  end if;
  if not (has_table_privilege('service_role', 'ads.change_requests', 'SELECT')
          and has_table_privilege('service_role', 'ads.change_requests', 'INSERT')
          and has_table_privilege('service_role', 'ads.change_requests', 'UPDATE')
          and has_table_privilege('service_role', 'ads.change_requests', 'DELETE'))
     or not has_table_privilege('service_role', 'ads.negative_keywords', 'INSERT') then
    raise exception '[0021] FAIL: service_role phải có toàn quyền trên bảng mới';
  end if;

  -- 10.5 RPC đúng chữ ký
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and p.proname in ('vexim_request_ads_change','vexim_decide_ads_change','vexim_cancel_ads_change',
                       'vexim_revert_ads_change','vexim_decide_ads_suggestion',
                       'vexim_worker_claim_ads_changes','vexim_worker_record_ads_change',
                       'vexim_worker_upsert_ads_negative_keywords');
  if n <> 8 then
    raise exception '[0021] FAIL: thiếu RPC (%/8)', n;
  end if;

  -- 10.6 helper duyệt + ngưỡng đọc được
  if ads.approval_reason('set_budget', null, 50, 'campaign') is null then
    raise exception '[0021] FAIL: không đọc được giá trị cũ ⇒ phải đòi duyệt';
  end if;

  -- 10.7 regression: bảng/view 0020 còn nguyên
  select count(*) into n from information_schema.views
   where table_schema = 'public' and table_name like 'vexim_ads_%';
  if n < 9 then
    raise exception '[0021] FAIL: mất view ads của 0020 (còn %)', n;
  end if;
end $$;
