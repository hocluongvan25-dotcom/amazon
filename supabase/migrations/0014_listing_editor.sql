-- ============================================================================
-- 0014 — MODULE 1 / L3: LISTING EDITOR (form soạn thảo nội bộ)
-- ============================================================================
-- MỤC ĐÍCH (đợt 2, L3 "Trình soạn/sửa listing"):
--   1. Giữ BẢN NHÁP NỘI BỘ (staging) của listing TRƯỚC khi gửi Amazon —
--      không sửa thẳng dữ liệu sống, không gọi thẳng patchListingsItem từ UI.
--   2. LƯU LỊCH SỬ THAY ĐỔI append-only (catalog.listing_draft_revisions):
--      mỗi lần lưu / gửi duyệt / duyệt / từ chối / publish đều thành 1 revision
--      do TRIGGER ghi (không phụ thuộc app nhớ ghi).
--   3. CACHE JSON SCHEMA product type (catalog.listing_product_type_schemas)
--      do worker tải bằng getDefinitionsProductType — nguồn cho form động L3.
--   4. HÀNG ĐỢI PUBLISH (catalog.listing_publish_queue) để worker gửi
--      Listings Items API v2021-08-01 (patchListingsItem / putListingsItem)
--      hoặc JSON_LISTINGS_FEED, rồi ghi lại submissionId + issues.
--
-- CHUẨN AMAZON (đã kiểm chứng developer-docs.amazon.com, 09/2026):
--   • Listings Items API v2021-08-01 — patchListingsItem (partial) /
--     putListingsItem (full). `requirements` ∈ LISTING | LISTING_PRODUCT_ONLY |
--     LISTING_OFFER_ONLY | OFFER.
--     https://developer-docs.amazon.com/sp-api/reference/listings-items-v2021-08-01
--   • Phản hồi submit: status = ACCEPTED | INVALID + submissionId + issues[].
--   • Kiểm tra trước khi gửi: mode=VALIDATION_PREVIEW (không tạo thay đổi thật).
--     https://developer-docs.amazon.com/sp-api/docs/building-listings-management-workflows-guide
--   • Listings Restrictions API **v2021-08-01** (không phải 2023-11-01 như bản
--     kế hoạch cũ ghi): getListingsRestrictions, reasonCode ∈
--     APPROVAL_REQUIRED | ASIN_NOT_FOUND | NOT_ELIGIBLE, rate 5 rps / burst 10.
--     https://developer-docs.amazon.com/sp-api/docs/listings-restrictions-api
--   • Hạn mức nội dung (09/2026) — title_differentiation là attribute mới:
--     item_name ≤ 75 ký tự (trừ media), title_differentiation ≤ 125 ký tự và
--     chỉ dùng được khi item_name ≤ 75; bullet_point 10–255 (policy) / 500
--     (field); product_description 2.000; generic_keyword 249 BYTE (US/UK/EU).
--     https://developer-docs.amazon.com/sp-api/changelog (01/07/2026)
--
-- NGUYÊN TẮC AN TOÀN (theo đúng "sự cố 12/09"):
--   • Không có policy DELETE cho client → bản nháp/từ chối vẫn còn lịch sử.
--   • Cổng validation ở tầng DB: trạng thái pending_approval / approved /
--     publishing / published BẮT BUỘC có validation.errorCount = 0. App có bug
--     cũng không thể đẩy bản lỗi đi duyệt.
--   • Máy trạng thái + 4 mắt (không tự duyệt bản mình gửi) nằm ở TRIGGER —
--     không tin vào UI.
--
-- Idempotent: chạy lại an toàn (create table if not exists / replace / drop
-- policy+trigger trước khi tạo).
-- ============================================================================

begin;

-- ============================================================================
-- 1. BẢNG STAGING: catalog.listing_drafts — bản nháp đang làm việc (1 shop+SKU)
-- ============================================================================
create table if not exists catalog.listing_drafts (
  id                 uuid primary key default gen_random_uuid(),
  seller_account_id  uuid not null references connections.seller_accounts(id) on delete cascade,
  sku                text not null,
  asin               text,
  marketplace_id     text not null default 'ATVPDKIKX0DER',   -- US mặc định
  product_type       text not null default 'PRODUCT',
  requirements       text not null default 'LISTING'
                     check (requirements in ('LISTING','LISTING_PRODUCT_ONLY','LISTING_OFFER_ONLY','OFFER')),
  locale             text not null default 'en_US',
  status             text not null default 'draft'
                     check (status in ('draft','pending_approval','approved','rejected',
                                       'publishing','published','failed')),
  -- attributes theo product type schema (item_name, title_differentiation,
  -- bullet_point[], product_description, generic_keyword, images,
  -- variation, fulfillment_availability, purchasable_offer…)
  payload            jsonb not null default '{}'::jsonb,
  -- snapshot kết quả kiểm tra: { checkedAt, source, errorCount, warningCount, issues[] }
  validation         jsonb,
  revision           int  not null default 1,
  created_by         uuid references iam.user_profiles(id),
  updated_by         uuid references iam.user_profiles(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  submitted_at       timestamptz,
  submitted_by       uuid references iam.user_profiles(id),
  decided_at         timestamptz,
  decided_by         uuid references iam.user_profiles(id),
  decision_note      text,
  published_at       timestamptz,
  publish_submission_id text,
  publish_status     text,           -- ACCEPTED | INVALID (theo phản hồi Amazon)
  publish_issues     jsonb,
  unique (seller_account_id, sku)
);

comment on table catalog.listing_drafts is
  'L3 staging: bản nháp listing nội bộ theo luồng Draft → Trưởng phòng duyệt → Publish (SOP-03).';

-- ============================================================================
-- 2. BẢNG STAGING: catalog.listing_draft_revisions — lịch sử append-only
-- ============================================================================
create table if not exists catalog.listing_draft_revisions (
  id                uuid primary key default gen_random_uuid(),
  draft_id          uuid not null references catalog.listing_drafts(id) on delete cascade,
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  revision          int  not null,
  stage             text not null
                    check (stage in ('created','saved','submitted','approved','rejected',
                                     'publishing','published','failed','reopened')),
  actor_id          uuid references iam.user_profiles(id),
  actor_email       text,                       -- nội bộ VEXIM; KHÔNG phơi ra view public
  note              text,
  changed_fields    text[] not null default '{}',
  before_payload    jsonb,
  after_payload     jsonb,
  validation        jsonb,
  created_at        timestamptz not null default now(),
  unique (draft_id, revision)
);

comment on table catalog.listing_draft_revisions is
  'L3 staging: lịch sử thay đổi append-only — do trigger ghi, client không insert/update/delete.';

-- ============================================================================
-- 3. BẢNG STAGING: catalog.listing_publish_queue — hàng đợi gửi Amazon
-- ============================================================================
create table if not exists catalog.listing_publish_queue (
  id                uuid primary key default gen_random_uuid(),
  draft_id          uuid not null references catalog.listing_drafts(id) on delete cascade,
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  sku               text not null,
  asin              text,
  marketplace_id    text not null,
  product_type      text not null,
  requirements      text not null
                    check (requirements in ('LISTING','LISTING_PRODUCT_ONLY','LISTING_OFFER_ONLY','OFFER')),
  method            text not null default 'patch' check (method in ('patch','put','feed')),
  payload           jsonb not null,        -- { productType, patches[] } hoặc { productType, attributes }
  status            text not null default 'queued'
                    check (status in ('queued','blocked','sent','accepted','invalid','failed')),
  block_reason      text,                  -- APPROVAL_REQUIRED | NOT_ELIGIBLE | VALIDATION_ERRORS | SELFTEST…
  attempts          int  not null default 0,
  submission_id     text,
  issues            jsonb,
  last_error        text,
  created_by        uuid references iam.user_profiles(id),
  created_at        timestamptz not null default now(),
  processed_at      timestamptz
);

comment on table catalog.listing_publish_queue is
  'L3 staging: hàng đợi publish — worker đọc, kiểm tra restrictions, gọi patchListingsItem/putListingsItem, ghi kết quả.';

create index if not exists idx_listing_drafts_status
  on catalog.listing_drafts (status, updated_at desc);
create index if not exists idx_listing_drafts_shop
  on catalog.listing_drafts (seller_account_id, status);
create index if not exists idx_listing_revisions_draft
  on catalog.listing_draft_revisions (draft_id, revision desc);
create index if not exists idx_listing_queue_pending
  on catalog.listing_publish_queue (status, created_at) where status in ('queued','sent');

-- ============================================================================
-- 3B. CACHE SCHEMA: catalog.listing_product_type_schemas — JSON Schema Amazon
-- ============================================================================
-- Form động theo product type cần `required` / `maxLength` / `enum` THẬT từ
-- getDefinitionsProductType (Product Type Definitions API 2020-09-01).
-- Web không gọi SP-API trực tiếp (không có credential) → worker tải schema rồi
-- ghi vào cache này, web đọc lại qua view public. Đây là dữ liệu công khai của
-- Amazon (không phải dữ liệu tenant) nên mọi authenticated đọc được; CHỈ worker
-- ghi qua RPC service_role ở mục 7C.
create table if not exists catalog.listing_product_type_schemas (
  marketplace_id text not null default 'ATVPDKIKX0DER',
  product_type   text not null,
  requirements   text not null default 'LISTING'
                 check (requirements in ('LISTING','LISTING_PRODUCT_ONLY','LISTING_OFFER_ONLY','OFFER')),
  schema         jsonb not null,
  source         text not null default 'getDefinitionsProductType',
  fetched_at     timestamptz not null default now(),
  primary key (marketplace_id, product_type, requirements)
);

comment on table catalog.listing_product_type_schemas is
  'Cache JSON Schema product type (Product Type Definitions API 2020-09-01) cho form động L3 — worker ghi, web đọc.';

alter table catalog.listing_product_type_schemas enable row level security;

drop policy if exists rls_read_listing_product_type_schemas on catalog.listing_product_type_schemas;
create policy rls_read_listing_product_type_schemas
  on catalog.listing_product_type_schemas for select
  to authenticated
  using (true);   -- schema công khai của Amazon, không phải dữ liệu của shop nào

-- ============================================================================
-- 4. HELPER: ai được duyệt listing (trưởng phòng Listing / admin)
-- ============================================================================
create or replace function iam.is_listing_approver()
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
             and d.code = 'listing'
         );
$$;

comment on function iam.is_listing_approver() is
  'L3: trưởng phòng Listing (dept_lead) hoặc admin được duyệt/từ chối bản nháp.';

-- ============================================================================
-- 5. MÁY TRẠNG THÁI + CỔNG VALIDATION (trigger BEFORE)
-- ============================================================================
create or replace function catalog.listing_draft_guard()
returns trigger
language plpgsql
security definer
set search_path = catalog, iam, pg_catalog
as $$
declare
  v_actor      uuid := auth.uid();
  v_service    boolean := v_actor is null;          -- service_role (worker) không có JWT sub
  v_actor_email text;
  v_errors     int;
begin
  if v_actor is not null then
    select up.email into v_actor_email from iam.user_profiles up where up.id = v_actor;
  end if;

  if tg_op = 'INSERT' then
    -- Bản nháp mới luôn bắt đầu ở draft; không cho tạo thẳng trạng thái đã duyệt.
    if new.status <> 'draft' then
      raise exception '[L3] bản nháp mới phải ở trạng thái draft (nhận: %)', new.status
        using errcode = 'check_violation';
    end if;
    new.created_by := coalesce(new.created_by, v_actor);
    new.updated_by := coalesce(new.updated_by, v_actor);
    new.created_at := coalesce(new.created_at, now());
    new.updated_at := now();
    return new;
  end if;

  -- ----- UPDATE -----
  new.updated_at := now();
  if v_actor is not null then
    new.updated_by := v_actor;
  end if;

  -- Không cho sửa các mốc lịch sử bằng tay (giữ tính append-only của quy trình)
  new.created_at := old.created_at;
  new.created_by := old.created_by;
  new.seller_account_id := old.seller_account_id;
  new.sku := old.sku;

  -- 5.1 Máy trạng thái (transition hợp lệ)
  if new.status <> old.status then
    if not (
         (old.status = 'draft'           and new.status in ('pending_approval'))
      or (old.status = 'rejected'        and new.status in ('draft','pending_approval'))
      or (old.status = 'pending_approval' and new.status in ('approved','rejected','draft'))
      or (old.status = 'approved'        and new.status in ('publishing','draft'))
      or (old.status = 'publishing'      and new.status in ('published','failed'))
      or (old.status = 'failed'          and new.status in ('draft','pending_approval'))
      or (old.status = 'published'       and new.status in ('draft'))
    ) then
      raise exception '[L3] chuyển trạng thái không hợp lệ: % → %', old.status, new.status
        using errcode = 'check_violation';
    end if;

    -- 5.2 Quyền theo từng bước
    if not v_service then
      if new.status in ('pending_approval','draft') and old.status <> 'draft' then
        -- người sửa/gửi duyệt phải có quyền ghi shop
        if not iam.can_write_seller_account(old.seller_account_id) then
          raise exception '[L3] không có quyền ghi trên shop này'
            using errcode = 'insufficient_privilege';
        end if;
      end if;

      if new.status in ('approved','rejected') and old.status = 'pending_approval' then
        if not iam.is_listing_approver() then
          raise exception '[L3] chỉ trưởng phòng Listing / admin được duyệt hoặc từ chối'
            using errcode = 'insufficient_privilege';
        end if;
        -- 4 mắt: không tự duyệt bản do chính mình gửi
        if old.submitted_by is not null and old.submitted_by = v_actor then
          raise exception '[L3] không tự duyệt bản nháp do chính mình gửi (4 mắt)'
            using errcode = 'insufficient_privilege';
        end if;
      end if;

      if new.status = 'published' and not iam.is_listing_approver() then
        raise exception '[L3] chỉ trưởng phòng Listing / admin được đánh dấu đã publish'
          using errcode = 'insufficient_privilege';
      end if;
    end if;

    -- 5.3 Ghi mốc thời gian theo bước
    if new.status = 'pending_approval' then
      new.submitted_at := now();
      new.submitted_by := coalesce(v_actor, old.submitted_by);
      new.decided_at := null;
      new.decided_by := null;
    elsif new.status in ('approved','rejected') then
      new.decided_at := now();
      new.decided_by := coalesce(v_actor, old.decided_by);
    elsif new.status = 'published' then
      new.published_at := coalesce(new.published_at, now());
    end if;
  elsif old.status not in ('draft','rejected','failed') then
    -- Sửa nội dung khi đang chờ duyệt / đã duyệt / đã publish: chỉ chấp nhận
    -- nếu KHÔNG đổi payload (ví dụ worker ghi kết quả publish) — nếu đổi payload
    -- thì phải quay về draft trước (tránh sửa lén sau khi đã duyệt).
    if (new.payload is distinct from old.payload)
       or (new.validation is distinct from old.validation)
       or (new.product_type is distinct from old.product_type)
       or (new.requirements is distinct from old.requirements) then
      raise exception '[L3] đang ở trạng thái % — phải đưa về draft trước khi sửa nội dung', old.status
        using errcode = 'check_violation';
    end if;
  end if;

  -- 5.4 Cổng validation: không đẩy bản còn lỗi ERROR đi duyệt/publish
  if new.status in ('pending_approval','approved','publishing','published') then
    v_errors := coalesce((new.validation->>'errorCount')::int, null);
    if v_errors is null then
      raise exception '[L3] thiếu kết quả kiểm tra (validation.errorCount) — chạy kiểm tra trước khi gửi duyệt'
        using errcode = 'check_violation';
    end if;
    if v_errors > 0 then
      raise exception '[L3] còn % lỗi ERROR theo hạn mức Amazon — sửa hết trước khi gửi duyệt', v_errors
        using errcode = 'check_violation';
    end if;
  end if;

  -- 5.5 Tăng revision khi có thay đổi nội dung hoặc trạng thái
  if new.payload is distinct from old.payload
     or new.status is distinct from old.status
     or new.validation is distinct from old.validation then
    new.revision := old.revision + 1;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_listing_draft_guard on catalog.listing_drafts;
create trigger trg_listing_draft_guard
  before insert or update on catalog.listing_drafts
  for each row execute function catalog.listing_draft_guard();

-- ============================================================================
-- 6. GHI LỊCH SỬ TỰ ĐỘNG (trigger AFTER — append-only)
-- ============================================================================
create or replace function catalog.listing_draft_history()
returns trigger
language plpgsql
security definer
set search_path = catalog, iam, pg_catalog
as $$
declare
  v_actor  uuid := auth.uid();
  v_email  text;
  v_stage  text;
  v_fields text[] := '{}';
  v_key    text;
begin
  select up.email into v_email from iam.user_profiles up where up.id = v_actor;

  if tg_op = 'INSERT' then
    v_stage := 'created';
  elsif new.status is distinct from old.status then
    v_stage := case new.status
                 when 'pending_approval' then 'submitted'
                 when 'approved'         then 'approved'
                 when 'rejected'         then 'rejected'
                 when 'publishing'       then 'publishing'
                 when 'published'        then 'published'
                 when 'failed'           then 'failed'
                 when 'draft'            then 'reopened'
                 else 'saved'
               end;
  else
    v_stage := 'saved';
  end if;

  -- Danh sách attribute đã đổi (so sánh theo từng key của payload)
  if tg_op = 'UPDATE' then
    for v_key in
      select k from (
        select jsonb_object_keys(coalesce(new.payload, '{}'::jsonb)) as k
        union
        select jsonb_object_keys(coalesce(old.payload, '{}'::jsonb)) as k
      ) s
    loop
      if (new.payload -> v_key) is distinct from (old.payload -> v_key) then
        v_fields := array_append(v_fields, v_key);
      end if;
    end loop;
  else
    select coalesce(array_agg(k), '{}')
      into v_fields
      from jsonb_object_keys(coalesce(new.payload, '{}'::jsonb)) k;
  end if;

  insert into catalog.listing_draft_revisions (
    draft_id, seller_account_id, revision, stage, actor_id, actor_email,
    note, changed_fields, before_payload, after_payload, validation
  )
  values (
    new.id, new.seller_account_id, new.revision, v_stage, v_actor, v_email,
    case when v_stage in ('approved','rejected') then new.decision_note else null end,
    v_fields,
    case when tg_op = 'UPDATE' then old.payload else null end,
    new.payload,
    new.validation
  )
  on conflict (draft_id, revision) do nothing;

  return null;
end;
$$;

drop trigger if exists trg_listing_draft_history on catalog.listing_drafts;
create trigger trg_listing_draft_history
  after insert or update on catalog.listing_drafts
  for each row execute function catalog.listing_draft_history();

-- ============================================================================
-- 7. RLS — MULTI-TENANT (theo đúng mô hình 0001)
-- ============================================================================
alter table catalog.listing_drafts             enable row level security;
alter table catalog.listing_draft_revisions    enable row level security;
alter table catalog.listing_publish_queue      enable row level security;

-- 7.1 Đọc: ai đọc được shop thì đọc được bản nháp + lịch sử
drop policy if exists rls_read_listing_drafts on catalog.listing_drafts;
create policy rls_read_listing_drafts on catalog.listing_drafts
  for select to authenticated
  using (iam.can_read_seller_account(seller_account_id));

drop policy if exists rls_read_listing_draft_revisions on catalog.listing_draft_revisions;
create policy rls_read_listing_draft_revisions on catalog.listing_draft_revisions
  for select to authenticated
  using (iam.can_read_seller_account(seller_account_id));

drop policy if exists rls_read_listing_publish_queue on catalog.listing_publish_queue;
create policy rls_read_listing_publish_queue on catalog.listing_publish_queue
  for select to authenticated
  using (iam.can_read_seller_account(seller_account_id));

-- 7.2 Ghi bản nháp: cần quyền ghi shop (trigger siết thêm theo trạng thái/vai trò)
drop policy if exists rls_ins_listing_drafts on catalog.listing_drafts;
create policy rls_ins_listing_drafts on catalog.listing_drafts
  for insert to authenticated
  with check (iam.can_write_seller_account(seller_account_id));

-- Trưởng phòng Listing / admin ĐỌC được shop nào thì được duyệt shop đó
-- (phạm vi đọc = phạm vi giám sát; vai trò duyệt do trigger kiểm tra riêng).
drop policy if exists rls_upd_listing_drafts on catalog.listing_drafts;
create policy rls_upd_listing_drafts on catalog.listing_drafts
  for update to authenticated
  using (
    iam.can_write_seller_account(seller_account_id)
    or (iam.is_listing_approver() and iam.can_read_seller_account(seller_account_id))
  )
  with check (
    iam.can_write_seller_account(seller_account_id)
    or (iam.is_listing_approver() and iam.can_read_seller_account(seller_account_id))
  );

-- KHÔNG có policy DELETE → bản nháp/từ chối vẫn giữ lịch sử.

-- 7.3 Lịch sử: chỉ đọc. Trigger (security definer) là đường ghi duy nhất.
revoke insert, update, delete on catalog.listing_draft_revisions from authenticated, anon;

-- 7.4 Hàng đợi publish: user có quyền ghi shop được ĐẨY vào hàng đợi;
--     chỉ service_role (worker) được cập nhật kết quả.
drop policy if exists rls_ins_listing_publish_queue on catalog.listing_publish_queue;
create policy rls_ins_listing_publish_queue on catalog.listing_publish_queue
  for insert to authenticated
  with check (
    iam.can_write_seller_account(seller_account_id)
    or (iam.is_listing_approver() and iam.can_read_seller_account(seller_account_id))
  );
revoke update, delete on catalog.listing_publish_queue from authenticated, anon;

-- ============================================================================
-- 7B. RPC PUBLIC — web ghi qua public schema (bài học PGRST202/205 của 0008)
-- ============================================================================
-- PostgREST chỉ resolve chắc chắn các đối tượng nằm trong schema được phơi
-- (public). Web gọi 2 RPC này thay vì ghi thẳng catalog.* → không phụ thuộc
-- việc project có expose schema `catalog` hay không.
-- Cả hai đều SECURITY DEFINER và TỰ KIỂM TRA QUYỀN (không tin client);
-- trigger 0014 vẫn là chốt cuối (máy trạng thái + 4 mắt + cổng validation).

create or replace function public.vexim_save_listing_draft(
  p_draft_id       uuid,
  p_seller         uuid,
  p_sku            text,
  p_product_type   text,
  p_requirements   text,
  p_marketplace_id text,
  p_locale         text,
  p_payload        jsonb,
  p_validation     jsonb,
  p_asin           text default null
)
returns table (draft_id uuid, revision int, created boolean)
language plpgsql
security definer
set search_path = catalog, iam, public, pg_catalog
as $$
declare
  v_allowed boolean;
  v_id      uuid;
  v_rev     int;
  v_created boolean := false;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception '[L3] payload phải là JSON object' using errcode = 'invalid_parameter_value';
  end if;

  v_allowed := iam.can_write_seller_account(p_seller)
            or (iam.is_listing_approver() and iam.can_read_seller_account(p_seller));
  if not v_allowed then
    raise exception '[L3] không có quyền soạn bản nháp cho shop này'
      using errcode = 'insufficient_privilege';
  end if;

  if p_draft_id is null then
    insert into catalog.listing_drafts as d
      (seller_account_id, sku, asin, product_type, requirements, marketplace_id, locale, payload, validation)
    values
      (p_seller, p_sku, p_asin, p_product_type, p_requirements, p_marketplace_id, p_locale, p_payload, p_validation)
    returning d.id, d.revision into v_id, v_rev;
    v_created := true;
  else
    update catalog.listing_drafts d
       set payload      = p_payload,
           validation   = p_validation,
           product_type = p_product_type,
           requirements = p_requirements,
           asin         = coalesce(p_asin, d.asin)
     where d.id = p_draft_id
    returning d.id, d.revision into v_id, v_rev;
    if v_id is null then
      raise exception '[L3] không tìm thấy bản nháp %', p_draft_id using errcode = 'no_data_found';
    end if;
  end if;

  return query select v_id, v_rev, v_created;
end;
$$;

comment on function public.vexim_save_listing_draft is
  'L3: lưu bản nháp (tạo mới khi p_draft_id null). Kiểm tra quyền + để trigger 0014 ghi lịch sử.';

create or replace function public.vexim_transition_listing_draft(
  p_draft_id uuid,
  p_action   text,
  p_note     text default null
)
returns table (draft_id uuid, status text, revision int)
language plpgsql
security definer
set search_path = catalog, iam, public, pg_catalog
as $$
declare
  v_row        catalog.listing_drafts%rowtype;
  v_target     text;
  v_new_status text;
  v_rev        int;
  v_can_write  boolean;
  v_is_appr    boolean;
begin
  select * into v_row from catalog.listing_drafts where id = p_draft_id;
  if not found then
    raise exception '[L3] không tìm thấy bản nháp %', p_draft_id using errcode = 'no_data_found';
  end if;

  v_can_write := iam.can_write_seller_account(v_row.seller_account_id);
  v_is_appr   := iam.is_listing_approver() and iam.can_read_seller_account(v_row.seller_account_id);

  v_target := case p_action
                when 'submit'         then 'pending_approval'
                when 'approve'        then 'approved'
                when 'reject'         then 'rejected'
                when 'withdraw'       then 'draft'
                when 'publish'        then 'publishing'
                when 'mark_published' then 'published'
                when 'reopen'         then 'draft'
                else null
              end;
  if v_target is null then
    raise exception '[L3] action không hợp lệ: %', p_action using errcode = 'invalid_parameter_value';
  end if;

  -- Quyền theo bước (trigger cũng kiểm tra lại — đây là lớp thứ nhất)
  if p_action in ('submit', 'withdraw', 'reopen') then
    if not (v_can_write or (v_row.submitted_by = auth.uid()) or (v_row.created_by = auth.uid())) then
      raise exception '[L3] không có quyền % bản nháp này', p_action using errcode = 'insufficient_privilege';
    end if;
  elsif p_action in ('approve', 'reject', 'publish', 'mark_published') then
    if not (v_is_appr or v_can_write) then
      raise exception '[L3] chỉ trưởng phòng Listing / admin được % bản nháp này', p_action
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  update catalog.listing_drafts d
     set status        = v_target,
         decision_note = coalesce(nullif(p_note, ''), d.decision_note)
   where d.id = p_draft_id
  returning d.status, d.revision into v_new_status, v_rev;

  -- Publish: đẩy bản đã duyệt vào hàng đợi cho worker.
  --   • ASIN đã tồn tại → method 'patch' (JSON Patch theo từng attribute,
  --     KHÔNG kèm marketplaceIds trong body — đó là query param của SP-API)
  --   • Chưa có ASIN → method 'put' (tạo mới: productType + requirements + attributes)
  -- Chống trùng: một bản nháp chỉ có tối đa 1 dòng đang chờ/gửi.
  if p_action = 'publish' then
    insert into catalog.listing_publish_queue
      (draft_id, seller_account_id, sku, asin, marketplace_id, product_type, requirements,
       method, payload, status, created_by)
    select d.id, d.seller_account_id, d.sku, d.asin, d.marketplace_id, d.product_type,
           d.requirements,
           case when d.asin is null then 'put' else 'patch' end,
           case
             when d.asin is null then jsonb_build_object(
               'productType', d.product_type,
               'requirements', d.requirements,
               'attributes', d.payload
             )
             else jsonb_build_object(
               'productType', d.product_type,
               'patches', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'op', 'replace',
                          'path', '/attributes/' || k,
                          'value', d.payload -> k))
                   from jsonb_object_keys(coalesce(d.payload, '{}'::jsonb)) k
               ), '[]'::jsonb)
             )
           end,
           'queued', auth.uid()
      from catalog.listing_drafts d
     where d.id = p_draft_id
       and not exists (
         select 1 from catalog.listing_publish_queue q
          where q.draft_id = p_draft_id and q.status in ('queued', 'sent')
       );
  end if;

  return query select p_draft_id, v_new_status, v_rev;
end;
$$;

comment on function public.vexim_transition_listing_draft is
  'L3: chuyển trạng thái bản nháp theo action (submit/approve/reject/withdraw/publish/mark_published/reopen) + enqueue publish.';

grant execute on function public.vexim_save_listing_draft      to authenticated, service_role;
grant execute on function public.vexim_transition_listing_draft to authenticated, service_role;

-- ============================================================================
-- 7C. RPC CHO WORKER — nhận hàng đợi + ghi kết quả publish (service_role)
-- ============================================================================
-- Worker (Vercel Cron / CLI) chạy bằng service_role, KHÔNG có JWT sub →
-- auth.uid() is null. Hai RPC dưới đây là cửa duy nhất để worker:
--   1) nhận các dòng 'queued' của một shop;
--   2) ghi kết quả Amazon trả về (ACCEPTED/INVALID + issues) và chuyển
--      trạng thái bản nháp publishing → published / failed / blocked.
-- Trigger 0014 vẫn là chốt cuối (máy trạng thái + cổng validation).

create or replace function public.vexim_worker_claim_listing_publish(
  p_seller uuid,
  p_limit  int default 20
)
returns table (
  queue_id      uuid,
  draft_id      uuid,
  sku           text,
  asin          text,
  marketplace_id text,
  product_type  text,
  requirements  text,
  method        text,
  payload       jsonb,
  attempts      int
)
language plpgsql
security definer
set search_path = catalog, public, pg_catalog
as $$
begin
  if auth.uid() is not null then
    raise exception '[L3] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;

  return query
    select q.id, q.draft_id, q.sku, q.asin, q.marketplace_id, q.product_type,
           q.requirements, q.method, q.payload, q.attempts
      from catalog.listing_publish_queue q
     where q.seller_account_id = p_seller
       and q.status = 'queued'
     order by q.created_at
     limit greatest(1, least(coalesce(p_limit, 20), 100));
end;
$$;

comment on function public.vexim_worker_claim_listing_publish is
  'L3: worker lấy các dòng hàng đợi publish đang chờ của một shop (chỉ service_role).';

create or replace function public.vexim_worker_record_publish_result(
  p_queue_id      uuid,
  p_status        text,                       -- sent | accepted | invalid | blocked | failed
  p_submission_id text default null,
  p_issues        jsonb default '[]'::jsonb,
  p_error         text default null,
  p_block_reason  text default null
)
returns table (queue_id uuid, queue_status text, draft_status text)
language plpgsql
security definer
set search_path = catalog, public, pg_catalog
as $$
declare
  v_row   catalog.listing_publish_queue%rowtype;
  v_draft text;
begin
  if auth.uid() is not null then
    raise exception '[L3] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;

  if p_status not in ('sent', 'accepted', 'invalid', 'blocked', 'failed') then
    raise exception '[L3] trạng thái publish không hợp lệ: %', p_status
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_row from catalog.listing_publish_queue where id = p_queue_id for update;
  if not found then
    raise exception '[L3] không tìm thấy dòng hàng đợi %', p_queue_id
      using errcode = 'no_data_found';
  end if;

  update catalog.listing_publish_queue q
     set status        = p_status,
         submission_id = coalesce(p_submission_id, q.submission_id),
         issues        = coalesce(p_issues, q.issues),
         last_error    = p_error,
         block_reason  = coalesce(p_block_reason, q.block_reason),
         attempts      = q.attempts + 1,
         processed_at  = case when p_status = 'sent' then q.processed_at else now() end
   where q.id = p_queue_id;

  -- accepted → draft published; invalid/failed → draft failed (sửa rồi gửi lại);
  -- sent/blocked → giữ nguyên publishing để worker tiếp tục theo dõi.
  v_draft := case p_status
               when 'accepted' then 'published'
               when 'invalid'  then 'failed'
               when 'failed'   then 'failed'
               else 'publishing'
             end;

  update catalog.listing_drafts d
     set status                = v_draft,
         publish_submission_id = coalesce(p_submission_id, d.publish_submission_id),
         publish_status        = p_status,
         publish_issues        = coalesce(p_issues, d.publish_issues),
         updated_by            = coalesce(d.updated_by, d.submitted_by)
   where d.id = v_row.draft_id;

  return query
    select p_queue_id,
           (select q.status from catalog.listing_publish_queue q where q.id = p_queue_id),
           v_draft;
end;
$$;

comment on function public.vexim_worker_record_publish_result is
  'L3: worker ghi kết quả publish (ACCEPTED/INVALID/issues) và cập nhật trạng thái bản nháp.';

-- Chỉ worker: không cho anon/authenticated gọi hai RPC này.
revoke all on function public.vexim_worker_claim_listing_publish(uuid, int) from public, anon, authenticated;
revoke all on function public.vexim_worker_record_publish_result(uuid, text, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.vexim_worker_claim_listing_publish(uuid, int) to service_role;
grant execute on function public.vexim_worker_record_publish_result(uuid, text, text, jsonb, text, text) to service_role;

-- Worker tải getDefinitionsProductType rồi upsert vào cache (form động L3).
-- p_schema phải là JSON object (phòng ghi nhầm mảng/chuỗi làm hỏng form).
create or replace function public.vexim_worker_upsert_product_type_schema(
  p_marketplace  text,
  p_product_type text,
  p_requirements text default 'LISTING',
  p_schema       jsonb default null
)
returns table (marketplace_id text, product_type text, requirements text, fetched_at timestamptz)
language plpgsql
security definer
set search_path = catalog, public, pg_catalog
as $$
begin
  if auth.uid() is not null then
    raise exception '[L3] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;

  if p_schema is null or jsonb_typeof(p_schema) <> 'object' then
    raise exception '[L3] schema product type phải là JSON object (nhận %)',
      coalesce(jsonb_typeof(p_schema), 'NULL')
      using errcode = 'invalid_parameter_value';
  end if;

  -- Dùng tên constraint thay vì liệt kê cột: trong PL/pgSQL, `on conflict (marketplace_id…)`
  -- đụng tên tham số OUT cùng tên → "column reference is ambiguous".
  insert into catalog.listing_product_type_schemas as t
    (marketplace_id, product_type, requirements, schema)
  values (p_marketplace, p_product_type, p_requirements, p_schema)
  on conflict on constraint listing_product_type_schemas_pkey
  do update set schema = excluded.schema, fetched_at = now();

  return query
    select s.marketplace_id, s.product_type, s.requirements, s.fetched_at
      from catalog.listing_product_type_schemas s
     where s.marketplace_id = p_marketplace
       and s.product_type   = p_product_type
       and s.requirements   = p_requirements;
end;
$$;

comment on function public.vexim_worker_upsert_product_type_schema is
  'L3: worker ghi/cập nhật JSON Schema product type (getDefinitionsProductType) để form động dùng lại — chỉ service_role.';

revoke all on function public.vexim_worker_upsert_product_type_schema(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.vexim_worker_upsert_product_type_schema(text, text, text, jsonb) to service_role;

-- ============================================================================
-- 8. VIEW PUBLIC (web đọc bằng anon key + RLS enforced)
-- ============================================================================
create or replace view public.vexim_listing_drafts
with (security_invoker = true) as
select
  d.id,
  d.seller_account_id,
  sa.display_name            as shop,
  sa.seller_id,
  d.sku,
  d.asin,
  d.marketplace_id,
  d.product_type,
  d.requirements,
  d.locale,
  d.status,
  d.payload,
  d.validation,
  d.revision,
  d.created_by,
  d.updated_by,
  d.created_at,
  d.updated_at,
  d.submitted_at,
  d.submitted_by,
  d.decided_at,
  d.decided_by,
  d.decision_note,
  d.published_at,
  d.publish_submission_id,
  d.publish_status,
  d.publish_issues,
  -- thuận tiện cho L3: tiêu đề hiện tại trong bản nháp (không phải bản sống)
  d.payload -> 'item_name'               as item_name,
  d.payload -> 'title_differentiation'   as title_differentiation
from catalog.listing_drafts d
join connections.seller_accounts sa on sa.id = d.seller_account_id;

create or replace view public.vexim_listing_draft_history
with (security_invoker = true) as
select
  r.id,
  r.draft_id,
  r.seller_account_id,
  sa.display_name            as shop,
  d.sku,
  r.revision,
  r.stage,
  r.actor_id,
  r.note,
  r.changed_fields,
  r.after_payload,
  r.validation,
  r.created_at
from catalog.listing_draft_revisions r
join catalog.listing_drafts d on d.id = r.draft_id
join connections.seller_accounts sa on sa.id = r.seller_account_id;

create or replace view public.vexim_listing_publish_queue
with (security_invoker = true) as
select
  q.id,
  q.draft_id,
  q.seller_account_id,
  sa.display_name            as shop,
  q.sku,
  q.marketplace_id,
  q.product_type,
  q.requirements,
  q.method,
  q.status,
  q.block_reason,
  q.attempts,
  q.submission_id,
  q.issues,
  q.last_error,
  q.created_at,
  q.processed_at
from catalog.listing_publish_queue q
join connections.seller_accounts sa on sa.id = q.seller_account_id;

create or replace view public.vexim_listing_product_type_schemas
with (security_invoker = true) as
select
  s.marketplace_id,
  s.product_type,
  s.requirements,
  s.schema,
  s.source,
  s.fetched_at
from catalog.listing_product_type_schemas s;

-- ============================================================================
-- 9. GRANTS
-- ============================================================================
grant select, insert, update on catalog.listing_drafts          to authenticated;
grant select                  on catalog.listing_draft_revisions to authenticated;
grant select, insert          on catalog.listing_publish_queue   to authenticated;
grant all on catalog.listing_drafts,
             catalog.listing_draft_revisions,
             catalog.listing_publish_queue,
             catalog.listing_product_type_schemas
  to service_role;

grant select on catalog.listing_product_type_schemas to authenticated;

grant select on
  public.vexim_listing_drafts,
  public.vexim_listing_draft_history,
  public.vexim_listing_publish_queue,
  public.vexim_listing_product_type_schemas
to authenticated, service_role;

-- ============================================================================
-- 10. KIỂM CHỨNG (fail sớm nếu thiếu thành phần)
-- ============================================================================
do $$
declare
  n_tables int;
  n_views  int;
  n_trg    int;
begin
  select count(*) into n_tables
  from information_schema.tables
  where table_schema = 'catalog'
    and table_name in ('listing_drafts','listing_draft_revisions','listing_publish_queue',
                       'listing_product_type_schemas');

  if n_tables <> 4 then
    raise exception '[0014] FAIL: chỉ thấy % / 4 bảng staging L3', n_tables;
  end if;

  select count(*) into n_views
  from information_schema.views
  where table_schema = 'public'
    and table_name in ('vexim_listing_drafts','vexim_listing_draft_history','vexim_listing_publish_queue',
                       'vexim_listing_product_type_schemas');

  if n_views <> 4 then
    raise exception '[0014] FAIL: chỉ thấy % / 4 view public cho L3', n_views;
  end if;

  -- information_schema.triggers có 1 dòng cho MỖI event (INSERT/UPDATE) → đếm distinct tên
  select count(distinct trigger_name) into n_trg
  from information_schema.triggers
  where event_object_schema = 'catalog'
    and event_object_table = 'listing_drafts'
    and trigger_name in ('trg_listing_draft_guard','trg_listing_draft_history');

  if n_trg <> 2 then
    raise exception '[0014] FAIL: thiếu trigger máy trạng thái / ghi lịch sử (% / 2)', n_trg;
  end if;

  -- 4 RPC public: 2 cho web ghi (bài học PGRST202 của 0008) + 2 cho worker
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'vexim_save_listing_draft', 'vexim_transition_listing_draft',
      'vexim_worker_claim_listing_publish', 'vexim_worker_record_publish_result',
      'vexim_worker_upsert_product_type_schema')
    group by n.nspname having count(distinct p.proname) = 5
  ) then
    raise exception '[0014] FAIL: thiếu RPC public cho web/worker trên bảng staging L3';
  end if;

  -- RPC worker KHÔNG được cấp cho authenticated (chỉ service_role)
  if has_function_privilege('authenticated',
       'public.vexim_worker_claim_listing_publish(uuid,int)', 'EXECUTE')
     or has_function_privilege('authenticated',
       'public.vexim_worker_record_publish_result(uuid,text,text,jsonb,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated',
       'public.vexim_worker_upsert_product_type_schema(text,text,text,jsonb)', 'EXECUTE')
  then
    raise exception '[0014] FAIL: RPC worker bị cấp EXECUTE cho authenticated';
  end if;

  -- Không phơi PII người mua và không phơi email nội bộ ra view public
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name like 'vexim_listing_draft%'
      and column_name in ('buyer_name','buyer_email','buyer_phone_number',
                          'ship_address_1','recipient_name','actor_email')
  ) then
    raise exception '[0014] FAIL: view L3 phơi PII';
  end if;

  raise notice '[0014] XONG: 4 bảng staging + 2 trigger + 4 view cho L3 Listing Editor';
end
$$;

commit;
