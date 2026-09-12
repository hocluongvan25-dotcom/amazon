-- ============================================================================
-- 0020 — MODULE 0 (OAuth thật + cảnh báo Re-authorize 365 ngày)
--        MODULE 5 PHẦN 1 (PPC đọc/phân tích: Profiles · Campaigns v3 · Reporting v3)
-- ============================================================================
-- BỐI CẢNH
--   Trước 0020, hệ thống chạy SP-API bằng MỘT refresh token duy nhất đặt trong
--   biến môi trường (AMAZON_LWA_REFRESH_TOKEN). Cách đó đủ cho 1 shop của chính
--   VEXIM nhưng KHÔNG đủ cho mô hình agency multi-tenant:
--     • mỗi shop (seller_account) phải có token RIÊNG, và token đó phải hết hạn
--       sau 365 ngày → phải có cơ chế nhắc Re-authorize TRƯỚC khi đứt dữ liệu;
--     • Amazon Ads API là ỨNG DỤNG KHÁC SP-API (client_id/secret khác, scope
--       `ads::campaign_management`, endpoint khác) → một shop cần HAI token;
--     • Module 5 cần profileId của Ads (GET /v2/profiles) trước khi gọi được bất
--       kỳ endpoint nào khác (header Amazon-Advertising-API-Scope).
--   Vì hai việc này dính nhau ở đúng bảng `connections.oauth_tokens`, migration
--   này gộp §A (Module 0) và §B (Module 5 Phần 1) — chạy MỘT lần theo thứ tự.
--
-- NGUỒN ĐÃ KIỂM CHỨNH (12–13/09/2026)
--   • Refresh token SP-API: "The selling partner must re-authorize your application
--     (a process that generates a new refresh token) every 365 days. Amazon sends a
--     reminder email 30 days prior" — developer-docs.amazon.com/sp-api/docs/
--     authorize-public-applications
--   • Authorization code hết hạn sau 5 PHÚT → callback phải đổi token ngay.
--   • Ads Profiles: GET /v2/profiles → profileId · countryCode · currencyCode ·
--     timezone · dailyBudget · accountInfo{marketplaceStringId,id,type,name}
--   • Ads Reporting v3: POST /reporting/reports
--     Content-Type: application/vnd.createasyncreportrequest.v3+json
--     header Amazon-Advertising-API-ClientId + Amazon-Advertising-API-Scope(profileId)
--     body {name,startDate,endDate,configuration{adProduct,groupBy,columns,
--     reportTypeId,timeUnit,format:GZIP_JSON}} → {reportId,status}
--     GET /reporting/reports/{reportId} → status PROCESSING|COMPLETED|FAILURE + url
--     Trần: spCampaigns/spTargeting tối đa 31 ngày, retention 95 ngày;
--           spSearchTerm retention 65 ngày; groupBy searchTerm; format GZIP_JSON.
--   • Sponsored Products Campaigns v3: POST /sp/campaigns/list
--     Content-Type: application/vnd.spCampaign.v3+json
--   • Budget Usage (SP): POST /sp/budgets/budgetUsage → percentageUsed theo ngày
--     (nguồn thật cho "cạn budget lúc mấy giờ" — xem §B6, có nhãn ƯỚC LƯỢNG).
--
-- NGUYÊN TẮC (giữ nguyên từ 0014..0019)
--   • Khoá NOT NULL DEFAULT '' (NULL không khử trùng trong index unique).
--   • Ghi = RPC service_role; web KHÔNG ghi được (chỉ policy SELECT).
--   • KHÔNG CỘNG TIỀN KHÁC TIỀN TỆ: view nhóm theo (shop × currency).
--   • Số không đọc được → NULL ("chưa biết"), không đoán 0.
--   • Idempotent: create … if not exists · create or replace · drop policy if exists.
--   • TOKEN KHÔNG BAO GIỜ RỜI KHỎI service_role: không policy, không view nào
--     select cột token, và KHÔNG lưu raw JSON phản hồi LWA (trong đó có
--     refresh_token — lỗi rất dễ mắc khi "log để debug").
--   • Chạy SAU 0019.
-- ============================================================================

begin;

-- ============================================================================
-- §A. MODULE 0 — OAUTH THẬT, MULTI-TENANT, RE-AUTHORIZE 365 NGÀY
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A0. Helper: iam.is_super_admin() — dùng lại ở nhiều view/RPC bên dưới
-- ----------------------------------------------------------------------------
create or replace function iam.is_super_admin()
returns boolean
language sql stable security definer
set search_path = iam, pg_catalog
as $$
  select exists (select 1 from iam.role_assignments ra
                 where ra.user_id = auth.uid() and ra.role = 'super_admin');
$$;

comment on function iam.is_super_admin() is
  'User hiện tại có vai trò super_admin (đọc từ iam.role_assignments).';

-- ----------------------------------------------------------------------------
-- A0b. DỌN MÌN ĐỆ QUY RLS (phát hiện khi viết view PPC — phải sửa ngay tại đây)
-- ----------------------------------------------------------------------------
-- 0001 viết policy kiểu "tự tra cứu iam.role_assignments ngay trong policy".
-- Postgres phát hiện ĐỆ QUY VÔ HẠN khi một user thường (không bypass RLS) đọc
-- các bảng đó: "infinite recursion detected in policy for relation
-- role_assignments". View PPC (security_invoker) đọc ops.alert_rules để lấy
-- ngưỡng ACOS → vỡ cả màn hình, nên phải chữa tận gốc:
--   (1) policy đọc iam.role_assignments → gọi iam.is_super_admin() (SECURITY
--       DEFINER, chạy bằng owner nên không áp RLS → không đệ quy);
--   (2) policy GHI ops.alert_rules đang là FOR ALL (bao gồm SELECT!) → tách thành
--       insert/update/delete riêng; SELECT đã có policy đọc (using true) lo.
-- Ý nghĩa phân quyền KHÔNG đổi: vẫn đúng "super_admin mới ghi được luật cảnh báo".
drop policy if exists rls_read_role_assignments on iam.role_assignments;
create policy rls_read_role_assignments on iam.role_assignments
  for select to authenticated using (user_id = auth.uid() or iam.is_super_admin());

drop policy if exists rls_read_user_profiles_self on iam.user_profiles;
create policy rls_read_user_profiles_self on iam.user_profiles
  for select to authenticated using (id = auth.uid() or iam.is_super_admin());

drop policy if exists rls_read_assignments on iam.assignments;
create policy rls_read_assignments on iam.assignments
  for select to authenticated using (user_id = auth.uid() or iam.is_super_admin());

-- iam.assignments cũng bị y hệt: policy ghi FOR ALL (gồm cả SELECT) tự tra
-- role_assignments → user thường đọc bảng phân quyền là nổ đệ quy.
drop policy if exists rls_write_assignments_super on iam.assignments;
drop policy if exists rls_ins_assignments_super on iam.assignments;
drop policy if exists rls_upd_assignments_super on iam.assignments;
drop policy if exists rls_del_assignments_super on iam.assignments;
create policy rls_ins_assignments_super on iam.assignments
  for insert to authenticated with check (iam.is_super_admin());
create policy rls_upd_assignments_super on iam.assignments
  for update to authenticated using (iam.is_super_admin())
  with check (iam.is_super_admin());
create policy rls_del_assignments_super on iam.assignments
  for delete to authenticated using (iam.is_super_admin());

drop policy if exists rls_write_alert_rules_super on ops.alert_rules;
drop policy if exists rls_ins_alert_rules_super on ops.alert_rules;
drop policy if exists rls_upd_alert_rules_super on ops.alert_rules;
drop policy if exists rls_del_alert_rules_super on ops.alert_rules;
create policy rls_ins_alert_rules_super on ops.alert_rules
  for insert to authenticated with check (iam.is_super_admin());
create policy rls_upd_alert_rules_super on ops.alert_rules
  for update to authenticated using (iam.is_super_admin())
  with check (iam.is_super_admin());
create policy rls_del_alert_rules_super on ops.alert_rules
  for delete to authenticated using (iam.is_super_admin());

-- ----------------------------------------------------------------------------
-- A1. connections.oauth_tokens — MỘT shop có NHIỀU token (SP-API + Ads)
-- ----------------------------------------------------------------------------
-- 0001 tạo bảng với `seller_account_id unique` → mỗi shop chỉ 1 token. Ads API là
-- ứng dụng LWA KHÁC (client_id khác, scope khác) nên phải mở khoá thành
-- (shop × service). Token cũ được coi là service='spapi' (đúng default).
alter table connections.oauth_tokens add column if not exists service        text not null default 'spapi';
alter table connections.oauth_tokens add column if not exists token_source   text not null default 'oauth';
alter table connections.oauth_tokens add column if not exists client_id      text;
alter table connections.oauth_tokens add column if not exists scope          text;
alter table connections.oauth_tokens add column if not exists status         text not null default 'active';
alter table connections.oauth_tokens add column if not exists selling_partner_id text;
alter table connections.oauth_tokens add column if not exists ads_account_id text;
alter table connections.oauth_tokens add column if not exists authorized_by  uuid references iam.user_profiles(id);
alter table connections.oauth_tokens add column if not exists reauthorize_at timestamptz;
alter table connections.oauth_tokens add column if not exists reminder_days  int  not null default 30;
alter table connections.oauth_tokens add column if not exists reminder_sent_at timestamptz;
alter table connections.oauth_tokens add column if not exists last_refresh_at timestamptz;
alter table connections.oauth_tokens add column if not exists last_used_at   timestamptz;
alter table connections.oauth_tokens add column if not exists last_error     text;
alter table connections.oauth_tokens add column if not exists updated_at     timestamptz not null default now();

-- Bỏ ràng buộc unique cũ trên seller_account_id (tên do Postgres tự sinh).
do $$
declare r record;
begin
  for r in
    select con.conname
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'connections' and c.relname = 'oauth_tokens'
      and con.contype = 'u'
      and (select count(*) from unnest(con.conkey) k) = 1
      and (select a.attname from pg_attribute a
            where a.attrelid = con.conrelid and a.attnum = con.conkey[1]) = 'seller_account_id'
  loop
    execute format('alter table connections.oauth_tokens drop constraint %I', r.conname);
    raise notice '[0020] bỏ ràng buộc unique cũ % (mở khoá 1 shop → nhiều service)', r.conname;
  end loop;
  -- Trường hợp unique được tạo bằng index (không phải constraint)
  for r in
    select indexname from pg_indexes
    where schemaname = 'connections' and tablename = 'oauth_tokens'
      and indexdef like '%UNIQUE%' and indexdef like '%seller_account_id%'
      and indexdef not like '%service%'
  loop
    execute format('drop index if exists connections.%I', r.indexname);
    raise notice '[0020] bỏ index unique cũ %', r.indexname;
  end loop;
end $$;

create unique index if not exists uq_oauth_tokens_shop_service
  on connections.oauth_tokens (seller_account_id, service);
create index if not exists idx_oauth_tokens_reauth
  on connections.oauth_tokens (reauthorize_at) where status = 'active';

-- Dữ liệu cũ: suy reauthorize_at từ expires_at (0001 đã bắt buộc NOT NULL,
-- ghi chú là "LWA refresh token: 1 năm").
update connections.oauth_tokens
   set reauthorize_at = coalesce(reauthorize_at, expires_at, authorized_at + interval '365 days'),
       service        = coalesce(nullif(service, ''), 'spapi'),
       updated_at     = now()
 where reauthorize_at is null;

comment on table connections.oauth_tokens is
  'Refresh token đã MÃ HOÁ (AES-256-GCM ở tầng app, tiền tố enc:v1:) theo shop × service '
  '(spapi|ads). KHÔNG có policy cho client — chỉ service_role đọc được. '
  'reauthorize_at = authorized_at + 365 ngày (đúng chính sách Amazon); '
  'KHÔNG lưu raw JSON phản hồi LWA vì trong đó có refresh_token.';

comment on column connections.oauth_tokens.service is
  'spapi = Selling Partner API · ads = Amazon Ads API (ứng dụng LWA riêng, scope ads::campaign_management).';
comment on column connections.oauth_tokens.token_source is
  'oauth = qua luồng authorize thật · env = nhập từ biến môi trường (bootstrap) · manual = dán tay.';
comment on column connections.oauth_tokens.status is
  'active · expired (quá 365 ngày hoặc Amazon từ chối) · revoked (seller gỡ app) · error.';

-- ----------------------------------------------------------------------------
-- A2. connections.oauth_states — state chống CSRF cho luồng authorize
-- ----------------------------------------------------------------------------
-- State ĐƯỢC KÝ (HMAC) nên app vẫn chạy khi chưa có Supabase; bảng này chỉ để
-- (1) đánh dấu đã dùng (chống replay) và (2) truy vết ai bấm kết nối lúc nào.
create table if not exists connections.oauth_states (
  state             text primary key,
  service           text not null default 'spapi',
  seller_account_id uuid references connections.seller_accounts(id) on delete cascade,
  redirect_uri      text not null default '',
  scope             text,
  actor_id          uuid references iam.user_profiles(id),
  seller_hint       text,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null default (now() + interval '10 minutes'),
  consumed_at       timestamptz,
  result            text
);

comment on table connections.oauth_states is
  'State của luồng OAuth (chống CSRF + chống replay). Sống 10 phút, dùng 1 lần. '
  'Không chứa secret — chỉ state đã ký, service, shop đích và redirect URI.';

create index if not exists idx_oauth_states_pending
  on connections.oauth_states (created_at desc) where consumed_at is null;

-- ----------------------------------------------------------------------------
-- A3. connections.oauth_events — nhật ký luồng kết nối (append-only)
-- ----------------------------------------------------------------------------
create table if not exists connections.oauth_events (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid references connections.seller_accounts(id) on delete cascade,
  service           text not null default 'spapi',
  event             text not null,
  status            text not null default 'ok',
  detail            text,
  actor_id          uuid references iam.user_profiles(id),
  created_at        timestamptz not null default now()
);

comment on table connections.oauth_events is
  'Nhật ký luồng kết nối: authorize_started · callback_received · token_exchanged · '
  'token_stored · token_invalid · profiles_synced · reauth_alert. '
  'CẤM ghi token/code vào detail (detail chỉ mô tả, vd "invalid_grant").';

create index if not exists idx_oauth_events_shop
  on connections.oauth_events (seller_account_id, created_at desc);
create index if not exists idx_oauth_events_recent
  on connections.oauth_events (created_at desc);

-- ----------------------------------------------------------------------------
-- A4. ops.alerts.entity_key — khoá khử trùng để alert KHÔNG nhân đôi mỗi lần chạy
-- ----------------------------------------------------------------------------
-- Trước đây worker tự dedupe trong code (MockDbAdapter) nên mỗi job phải nhớ luật.
-- Có khoá cứng ở DB thì mọi nguồn (SQL scan, worker TS) đều dedupe giống nhau.
alter table ops.alerts add column if not exists entity_key text;

create unique index if not exists uq_alerts_open_entity
  on ops.alerts (seller_account_id, rule_id, entity_key)
  where status = 'open' and entity_key is not null;

comment on column ops.alerts.entity_key is
  'Đối tượng sinh alert (vd campaign:123, sku:XMO-950, token:ads). NULL = alert cũ '
  'chưa phân loại. Index unique một phần (status=open) → cùng một đối tượng chỉ có '
  'MỘT alert đang mở, chạy lại job không nhân đôi.';

-- ----------------------------------------------------------------------------
-- A5. ops.raise_alert / ops.resolve_alert — một cửa cho MỌI nguồn sinh alert
-- ----------------------------------------------------------------------------
create or replace function ops.raise_alert(
  p_seller     uuid,
  p_rule_code  text,
  p_entity_key text,
  p_severity   ops.alert_severity,
  p_title      text,
  p_detail     text default null,
  p_assigned_to uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ops, iam, public, pg_catalog
as $$
declare
  v_rule  uuid;
  v_alert uuid;
begin
  if p_seller is null or p_rule_code is null or p_title is null then
    raise exception '[ALERT] thiếu seller / rule_code / title'
      using errcode = 'invalid_parameter_value';
  end if;

  select id into v_rule from ops.alert_rules
   where rule_code = p_rule_code and is_active
   limit 1;
  if v_rule is null then
    -- Rule chưa seed: vẫn phải sinh alert (thà có alert "mồ côi" còn hơn im lặng),
    -- nhưng ghi rõ vào detail để người vận hành biết phải thêm rule.
    insert into ops.alerts (seller_account_id, rule_id, severity, title, detail,
                            status, assigned_to, entity_key, fired_at)
    values (p_seller, null, coalesce(p_severity, 'amber'), p_title,
            coalesce(p_detail, '') || ' [chưa có alert_rule ' || p_rule_code || ']',
            'open', p_assigned_to, nullif(p_entity_key, ''), now())
    returning id into v_alert;
    return v_alert;
  end if;

  if nullif(p_entity_key, '') is null then
    -- Không có entity_key → không dedupe được bằng index; dedupe thủ công
    -- theo (shop, rule, title) đang mở.
    select id into v_alert from ops.alerts
     where seller_account_id = p_seller and rule_id = v_rule
       and status = 'open' and title = p_title
     order by fired_at desc limit 1;
    if v_alert is not null then
      update ops.alerts
         set severity = coalesce(p_severity, severity),
             detail   = coalesce(p_detail, detail),
             fired_at = now()
       where id = v_alert;
      return v_alert;
    end if;
    insert into ops.alerts (seller_account_id, rule_id, severity, title, detail,
                            status, assigned_to, fired_at)
    values (p_seller, v_rule, coalesce(p_severity, 'amber'), p_title, p_detail,
            'open', p_assigned_to, now())
    returning id into v_alert;
    return v_alert;
  end if;

  insert into ops.alerts as a (seller_account_id, rule_id, severity, title, detail,
                               status, assigned_to, entity_key, fired_at)
  values (p_seller, v_rule, coalesce(p_severity, 'amber'), p_title, p_detail,
          'open', p_assigned_to, p_entity_key, now())
  on conflict (seller_account_id, rule_id, entity_key)
      where status = 'open' and entity_key is not null
  do update set
    severity    = coalesce(excluded.severity, a.severity),
    title       = excluded.title,
    detail      = coalesce(excluded.detail, a.detail),
    assigned_to = coalesce(excluded.assigned_to, a.assigned_to),
    fired_at    = now()
  returning a.id into v_alert;

  return v_alert;
end;
$$;

comment on function ops.raise_alert(uuid, text, text, ops.alert_severity, text, text, uuid) is
  'Sinh/cập nhật alert, dedupe theo (shop, rule, entity_key) khi alert còn open. '
  'Mọi nguồn (worker TS, scan SQL) gọi qua đây để luật dedupe chỉ có MỘT bản.';

create or replace function ops.resolve_alert(
  p_seller     uuid,
  p_rule_code  text,
  p_entity_key text default null
)
returns int
language plpgsql
security definer
set search_path = ops, public, pg_catalog
as $$
declare n int := 0;
begin
  update ops.alerts a
     set status = 'resolved', resolved_at = now()
    from ops.alert_rules r
   where a.rule_id = r.id
     and r.rule_code = p_rule_code
     and a.status in ('open','ack')
     and (p_seller is null or a.seller_account_id = p_seller)
     and (p_entity_key is null or a.entity_key = p_entity_key);
  get diagnostics n = row_count;
  return n;
end;
$$;

comment on function ops.resolve_alert(uuid, text, text) is
  'Đóng alert khi điều kiện hết đúng (token đã re-auth, ACOS về dưới ngưỡng…). '
  'Trả số dòng đã đóng — worker log ra để biết alert có thật sự tắt.';

revoke all on function ops.raise_alert(uuid, text, text, ops.alert_severity, text, text, uuid)
  from public, anon, authenticated;
grant execute on function ops.raise_alert(uuid, text, text, ops.alert_severity, text, text, uuid)
  to service_role;
revoke all on function ops.resolve_alert(uuid, text, text) from public, anon, authenticated;
grant execute on function ops.resolve_alert(uuid, text, text) to service_role;

-- ----------------------------------------------------------------------------
-- A6. Alert rules mới (2 rule ads đã có sẵn từ 0001 — chỉ hiệu chỉnh ngưỡng)
-- ----------------------------------------------------------------------------
insert into ops.alert_rules (rule_code, module, description, threshold, comparator, severity, is_active)
values
  ('reauth_required', 'tasks',
   'Refresh token sắp hết hạn 365 ngày — cần chủ shop Re-authorize (SP-API và Ads API)',
   30, 'lte', 'amber', true),
  ('ads_sync_stale', 'ads',
   'Dữ liệu quảng cáo cũ hơn ngưỡng (giờ) — cron Ads không chạy được',
   36, 'gte', 'amber', true)
on conflict (rule_code) do update set
  module      = excluded.module,
  description = excluded.description,
  threshold   = excluded.threshold,
  comparator  = excluded.comparator,
  severity    = excluded.severity,
  is_active   = true;

-- budget_exhausted của 0001 chưa có ngưỡng (lúc đó chưa có nguồn dữ liệu).
-- Giờ có Budget Usage API (percentageUsed) → chốt ngưỡng 100%.
update ops.alert_rules
   set threshold   = 100,
       comparator  = 'gte',
       description = 'Campaign chạm/cạn ngân sách ngày (percentageUsed ≥ 100% từ Budget Usage API)'
 where rule_code = 'budget_exhausted'
   and (threshold is null or comparator is null);

-- ----------------------------------------------------------------------------
-- A7. RPC — lưu token (chỉ service_role; token PHẢI đã mã hoá ở tầng app)
-- ----------------------------------------------------------------------------
create or replace function public.vexim_oauth_upsert_token(p_payload jsonb)
returns table (id uuid, service text, status text, reauthorize_at timestamptz, days_to_reauth int)
language plpgsql
security definer
set search_path = connections, public, pg_catalog
as $$
  -- `use_column`: hàm returns table(...) nên tên cột OUT (id, status, service, days…)
  -- trùng tên cột thật → trong MỌI biểu thức SQL, tên trùng được hiểu là CỘT.
  -- (Biến nội bộ đều có tiền tố v_/p_ nên không bị đổi nghĩa; thiếu dòng này thì
  -- on conflict (…, service) nổ "column reference service is ambiguous" lúc chạy.)
  #variable_conflict use_column
declare
  v_seller  uuid;
  v_service text;
  v_token   text;
  v_auth    timestamptz;
  v_expiry  timestamptz;
  v_id      uuid;
  v_status  text;
  v_reauth  timestamptz;
begin
  if auth.uid() is not null then
    raise exception '[OAUTH] RPC này chỉ dành cho server (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_payload is null then
    raise exception '[OAUTH] thiếu payload' using errcode = 'invalid_parameter_value';
  end if;

  begin
    v_seller := nullif(btrim(coalesce(p_payload ->> 'sellerAccountId', '')), '')::uuid;
  exception when others then
    raise exception '[OAUTH] sellerAccountId không phải uuid (%)',
      coalesce(p_payload ->> 'sellerAccountId', 'NULL') using errcode = 'invalid_parameter_value';
  end;
  if v_seller is null then
    raise exception '[OAUTH] thiếu sellerAccountId' using errcode = 'invalid_parameter_value';
  end if;
  -- `sa.id` PHẢI có alias: hàm returns table(id …) nên `id` trần bị plpgsql hiểu
  -- nhầm là biến OUT → "column reference id is ambiguous" lúc chạy.
  if not exists (select 1 from connections.seller_accounts sa where sa.id = v_seller) then
    raise exception '[OAUTH] shop % không tồn tại', v_seller using errcode = 'foreign_key_violation';
  end if;

  v_service := lower(btrim(coalesce(p_payload ->> 'service', 'spapi')));
  if v_service not in ('spapi','ads') then
    raise exception '[OAUTH] service phải là spapi hoặc ads (nhận %)', v_service
      using errcode = 'invalid_parameter_value';
  end if;

  v_token := btrim(coalesce(p_payload ->> 'encryptedRefreshToken', ''));
  -- CHỐT: từ chối token chưa mã hoá. Lưu plaintext vào Postgres là lộ credential
  -- cho bất kỳ ai đọc được DB (backup, log, SQL Editor) — thà báo lỗi rõ ràng.
  if v_token = '' then
    raise exception '[OAUTH] thiếu encryptedRefreshToken' using errcode = 'invalid_parameter_value';
  end if;
  -- 'enc:v1:' = 7 ký tự (đếm sai 1 ký tự là TỪ CHỐI MỌI token hợp lệ — đã từng lỗi).
  if left(v_token, 7) <> 'enc:v1:' and left(v_token, 4) <> 'Atzr' then
    raise exception '[OAUTH] token phải được mã hoá (tiền tố enc:v1:). Nhận chuỗi lạ — từ chối lưu.'
      using errcode = 'invalid_parameter_value';
  end if;
  if left(v_token, 4) = 'Atzr' then
    raise exception '[OAUTH] phát hiện refresh token PLAINTEXT (Atzr…). Bật OAUTH_TOKEN_ENC_KEY '
      'rồi mã hoá trước khi gọi RPC này.' using errcode = 'invalid_parameter_value';
  end if;

  v_status := lower(btrim(coalesce(p_payload ->> 'status', 'active')));
  if v_status not in ('active','expired','revoked','error') then v_status := 'active'; end if;

  -- Ngày authorize: payload đưa thì dùng, không thì now().
  v_auth := coalesce(
    nullif(btrim(coalesce(p_payload ->> 'authorizedAt', '')), '')::timestamptz, now());

  -- Hạn re-authorize = NGÀY AUTHORIZE + 365 (đúng chính sách Amazon). KHÔNG lấy
  -- now(): nhập lại token cũ (vd chỉ để đổi clientId) mà tính từ now() thì hệ thống
  -- tự cộng thêm 1 năm và IM LẶNG mất cảnh báo đúng lúc token chết.
  v_reauth := coalesce(
    nullif(btrim(coalesce(p_payload ->> 'reauthorizeAt', '')), '')::timestamptz,
    nullif(btrim(coalesce(p_payload ->> 'expiresAt', '')), '')::timestamptz,
    v_auth + interval '365 days');
  v_expiry := coalesce(
    nullif(btrim(coalesce(p_payload ->> 'expiresAt', '')), '')::timestamptz,
    v_reauth);

  insert into connections.oauth_tokens as t (
    seller_account_id, service, encrypted_refresh_token, authorized_at, expires_at,
    rotate_reminder_sent, token_source, client_id, scope, status,
    selling_partner_id, ads_account_id, authorized_by, reauthorize_at,
    reminder_days, last_refresh_at, last_error, updated_at
  )
  values (
    v_seller, v_service, v_token,
    v_auth,
    v_expiry,
    false,
    lower(btrim(coalesce(p_payload ->> 'tokenSource', 'oauth'))),
    nullif(btrim(coalesce(p_payload ->> 'clientId', '')), ''),
    nullif(btrim(coalesce(p_payload ->> 'scope', '')), ''),
    v_status,
    nullif(btrim(coalesce(p_payload ->> 'sellingPartnerId', '')), ''),
    nullif(btrim(coalesce(p_payload ->> 'adsAccountId', '')), ''),
    nullif(btrim(coalesce(p_payload ->> 'authorizedBy', '')), '')::uuid,
    v_reauth,
    coalesce(nullif(btrim(coalesce(p_payload ->> 'reminderDays', '')), '')::int, 30),
    now(),
    null,
    now()
  )
  on conflict (seller_account_id, service) do update set
    encrypted_refresh_token = excluded.encrypted_refresh_token,
    authorized_at           = excluded.authorized_at,
    expires_at              = excluded.expires_at,
    reauthorize_at          = excluded.reauthorize_at,
    status                  = excluded.status,
    token_source            = excluded.token_source,
    client_id               = coalesce(excluded.client_id, t.client_id),
    scope                   = coalesce(excluded.scope, t.scope),
    selling_partner_id      = coalesce(excluded.selling_partner_id, t.selling_partner_id),
    ads_account_id          = coalesce(excluded.ads_account_id, t.ads_account_id),
    authorized_by           = coalesce(excluded.authorized_by, t.authorized_by),
    reminder_days           = excluded.reminder_days,
    -- Re-auth thành công → xoá dấu "đã nhắc" và lỗi cũ
    rotate_reminder_sent    = false,
    reminder_sent_at        = null,
    last_refresh_at         = now(),
    last_error              = null,
    updated_at              = now()
  returning t.id, t.status, t.reauthorize_at into v_id, v_status, v_reauth;

  -- Token mới → đóng alert Re-authorize cũ của đúng service đó (nếu có).
  perform ops.resolve_alert(v_seller, 'reauth_required', 'token:' || v_service);

  return query
    select v_id, v_service, v_status, v_reauth,
           ceil(extract(epoch from (v_reauth - now())) / 86400)::int;
end;
$$;

comment on function public.vexim_oauth_upsert_token(jsonb) is
  'Lưu refresh token ĐÃ MÃ HOÁ cho (shop × service). Từ chối plaintext. '
  'Tự đóng alert reauth_required của service đó. Chỉ service_role.';

revoke all on function public.vexim_oauth_upsert_token(jsonb) from public, anon, authenticated;
grant execute on function public.vexim_oauth_upsert_token(jsonb) to service_role;

-- ----------------------------------------------------------------------------
-- A8. RPC — ghi sự kiện luồng kết nối + state
-- ----------------------------------------------------------------------------
create or replace function public.vexim_oauth_record_event(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = connections, public, pg_catalog
as $$
declare
  v_id     uuid;
  v_seller uuid;
  v_detail text;
begin
  if auth.uid() is not null then
    raise exception '[OAUTH] RPC này chỉ dành cho server (service_role)'
      using errcode = 'insufficient_privilege';
  end if;

  begin
    v_seller := nullif(btrim(coalesce(p_payload ->> 'sellerAccountId', '')), '')::uuid;
  exception when others then
    v_seller := null;
  end;

  v_detail := nullif(btrim(coalesce(p_payload ->> 'detail', '')), '');
  -- Chặn ghi nhầm credential vào nhật ký (chi tiết nhỏ, hậu quả lớn).
  if v_detail ~ '(Atzr\||Atza\||refresh_token|client_secret|spapi_oauth_code)' then
    v_detail := '[đã chặn: detail chứa chuỗi giống credential]';
  end if;

  insert into connections.oauth_events (seller_account_id, service, event, status, detail, actor_id)
  values (
    v_seller,
    lower(btrim(coalesce(p_payload ->> 'service', 'spapi'))),
    lower(btrim(coalesce(p_payload ->> 'event', 'unknown'))),
    case when lower(btrim(coalesce(p_payload ->> 'status', 'ok'))) in ('ok','error')
         then lower(btrim(coalesce(p_payload ->> 'status', 'ok'))) else 'ok' end,
    v_detail,
    nullif(btrim(coalesce(p_payload ->> 'actorId', '')), '')::uuid
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.vexim_oauth_record_event(jsonb) is
  'Append-only nhật ký luồng OAuth. Tự chặn detail chứa chuỗi giống token/code. Chỉ service_role.';

create or replace function public.vexim_oauth_set_state(p_payload jsonb)
returns text
language plpgsql
security definer
set search_path = connections, public, pg_catalog
as $$
declare
  v_state text;
begin
  if auth.uid() is not null then
    raise exception '[OAUTH] RPC này chỉ dành cho server (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  v_state := btrim(coalesce(p_payload ->> 'state', ''));
  if v_state = '' then
    raise exception '[OAUTH] thiếu state' using errcode = 'invalid_parameter_value';
  end if;

  insert into connections.oauth_states as s (
    state, service, seller_account_id, redirect_uri, scope, actor_id, seller_hint, expires_at
  )
  values (
    v_state,
    lower(btrim(coalesce(p_payload ->> 'service', 'spapi'))),
    nullif(btrim(coalesce(p_payload ->> 'sellerAccountId', '')), '')::uuid,
    btrim(coalesce(p_payload ->> 'redirectUri', '')),
    nullif(btrim(coalesce(p_payload ->> 'scope', '')), ''),
    nullif(btrim(coalesce(p_payload ->> 'actorId', '')), '')::uuid,
    nullif(btrim(coalesce(p_payload ->> 'sellerHint', '')), ''),
    coalesce(nullif(btrim(coalesce(p_payload ->> 'expiresAt', '')), '')::timestamptz,
             now() + interval '10 minutes')
  )
  on conflict (state) do update set
    consumed_at = null,
    result      = null,
    expires_at  = excluded.expires_at;

  return v_state;
end;
$$;

comment on function public.vexim_oauth_set_state(jsonb) is
  'Ghi state của lượt authorize (chống replay). Chỉ service_role.';

create or replace function public.vexim_oauth_consume_state(
  p_state text,
  p_result text
)
returns table (service text, seller_account_id uuid, redirect_uri text, expired boolean, already_used boolean)
language plpgsql
security definer
set search_path = connections, public, pg_catalog
as $$
  -- `use_column`: hàm returns table(...) nên tên cột OUT (id, status, service, days…)
  -- trùng tên cột thật → trong MỌI biểu thức SQL, tên trùng được hiểu là CỘT.
  -- (Biến nội bộ đều có tiền tố v_/p_ nên không bị đổi nghĩa; thiếu dòng này thì
  -- on conflict (…, service) nổ "column reference service is ambiguous" lúc chạy.)
  #variable_conflict use_column
declare r record;
begin
  if auth.uid() is not null then
    raise exception '[OAUTH] RPC này chỉ dành cho server (service_role)'
      using errcode = 'insufficient_privilege';
  end if;

  select s.service, s.seller_account_id, s.redirect_uri,
         (s.expires_at < now())      as expired,
         (s.consumed_at is not null) as already_used
    into r
    from connections.oauth_states s
   where s.state = btrim(coalesce(p_state, ''))
   for update;

  if not found then
    return query select 'spapi'::text, null::uuid, ''::text, false, false;
    return;
  end if;

  update connections.oauth_states
     set consumed_at = now(), result = btrim(coalesce(p_result, 'consumed'))
   where state = btrim(coalesce(p_state, ''))
     and consumed_at is null;

  -- Hàm returns table(...) → phải gán biến OUT rồi `return next;` (RETURN NEXT
  -- KHÔNG nhận tham số), và cũng không viết `select r.service` được vì r là
  -- RECORD của plpgsql chứ không phải bảng trong FROM.
  service           := r.service;
  seller_account_id := r.seller_account_id;
  redirect_uri      := r.redirect_uri;
  expired           := r.expired;
  already_used      := r.already_used;
  return next;
end;
$$;

comment on function public.vexim_oauth_consume_state(text, text) is
  'Đánh dấu state đã dùng (một lần duy nhất) và trả thông tin lượt authorize. '
  'Không tìm thấy state → service=''spapi'', seller NULL: tầng app phải tự kiểm '
  'chữ ký HMAC của state (app vẫn chạy khi chưa có Supabase).';

revoke all on function public.vexim_oauth_record_event(jsonb)        from public, anon, authenticated;
revoke all on function public.vexim_oauth_set_state(jsonb)           from public, anon, authenticated;
revoke all on function public.vexim_oauth_consume_state(text, text)  from public, anon, authenticated;
grant execute on function public.vexim_oauth_record_event(jsonb)       to service_role;
grant execute on function public.vexim_oauth_set_state(jsonb)          to service_role;
grant execute on function public.vexim_oauth_consume_state(text, text) to service_role;

-- ----------------------------------------------------------------------------
-- A9. RPC — QUÉT RE-AUTHORIZE (cơ chế 365 ngày, chạy từ cron mỗi ngày)
-- ----------------------------------------------------------------------------
-- Amazon: refresh token phải được TÁI AUTHORIZE mỗi 365 ngày, và Amazon chỉ gửi
-- email nhắc cho CHỦ SHOP (không gửi cho developer). Nếu VEXIM không tự đếm ngày
-- thì dữ liệu của shop đó đứt đúng 1 năm sau ngày kết nối — và khoảng trống đó
-- KHÔNG backfill được (Reports API chỉ giữ 60–95 ngày, Ads 65–95 ngày).
-- Nên: hệ thống PHẢI tự nhắc trước 30 ngày (mặc định), chuyển đỏ khi quá hạn.
create or replace function public.vexim_oauth_reauth_scan(
  p_notice_days int default 30,
  p_service     text default null
)
returns table (
  shop_id         uuid,
  shop_name       text,
  token_service   text,
  token_status    text,
  days_to_reauth  int,
  alert_severity  text,
  alert_id        uuid,
  next_action     text
)
language plpgsql
security definer
set search_path = connections, ops, iam, public, pg_catalog
as $$
  -- `use_column`: hàm returns table(...) nên tên cột OUT (id, status, service, days…)
  -- trùng tên cột thật → trong MỌI biểu thức SQL, tên trùng được hiểu là CỘT.
  -- (Biến nội bộ đều có tiền tố v_/p_ nên không bị đổi nghĩa; thiếu dòng này thì
  -- on conflict (…, service) nổ "column reference service is ambiguous" lúc chạy.)
  #variable_conflict use_column
declare
  v_notice int := coalesce(nullif(p_notice_days, 0), 30);
  r        record;
  v_days   int;
  v_sev    ops.alert_severity;
  v_alert  uuid;
  v_action text;
begin
  if auth.uid() is not null then
    raise exception '[OAUTH] RPC này chỉ dành cho server (service_role)'
      using errcode = 'insufficient_privilege';
  end if;

  for r in
    select t.id                 as token_id,
           t.seller_account_id  as shop,
           t.service            as svc,
           t.status             as st,
           t.reauthorize_at     as reauth_at,
           sa.display_name      as shop_label,
           (select a.user_id
              from iam.assignments a
              join iam.user_profiles up on up.id = a.user_id
             where a.seller_account_id = t.seller_account_id
               and a.module = case t.service when 'ads' then 'ads'::iam.module_code
                                             else 'tasks'::iam.module_code end
               and up.vexim_employee = true
             order by a.can_write desc, a.created_at asc
             limit 1)           as owner_user
      from connections.oauth_tokens t
      join connections.seller_accounts sa on sa.id = t.seller_account_id
     where (p_service is null or t.service = lower(btrim(p_service)))
       and sa.status = 'active'
     order by t.reauthorize_at nulls last
  loop
    v_days := ceil(extract(epoch from
                (coalesce(r.reauth_at, now() + interval '365 days') - now())) / 86400)::int;

    if v_days <= 0 then
      v_sev    := 'red';
      v_action := 'reauthorize_now';
      -- Quá hạn → đánh dấu expired để worker KHÔNG gọi API bằng token chết
      -- (gọi chỉ nhận invalid_grant và làm nhiễu log/trần tốc độ).
      update connections.oauth_tokens ot
         set status     = 'expired',
             last_error = coalesce(ot.last_error,
                           'quá hạn re-authorize ' || abs(v_days) || ' ngày (chu kỳ 365 ngày)'),
             updated_at = now()
       where ot.id = r.token_id
         and ot.status <> 'expired';
    elsif v_days <= v_notice then
      v_sev    := 'amber';
      v_action := 'send_reauth_link';
    else
      v_sev    := null;
      v_action := 'none';
    end if;

    if v_sev is null then
      -- Còn xa hạn → đóng alert cũ (vd shop vừa re-authorize xong).
      perform ops.resolve_alert(r.shop, 'reauth_required', 'token:' || r.svc);
      v_alert := null;
    else
      v_alert := ops.raise_alert(
        r.shop,
        'reauth_required',
        'token:' || r.svc,
        v_sev,
        format('Cần Re-authorize %s — shop %s (còn %s ngày)',
               case r.svc when 'ads' then 'Amazon Ads API' else 'SP-API' end,
               r.shop_label, v_days::text),
        format('Refresh token %s hết hạn sau 365 ngày (hạn %s). Gửi link /module0/connect cho chủ shop. '
               'Quá hạn thì MỌI job đồng bộ của shop này dừng và khoảng trống dữ liệu KHÔNG backfill được '
               '(Reports API chỉ giữ 60–95 ngày).',
               r.svc, to_char(coalesce(r.reauth_at, now()), 'YYYY-MM-DD')),
        r.owner_user
      );
      update connections.oauth_tokens ot
         set reminder_sent_at     = coalesce(ot.reminder_sent_at, now()),
             rotate_reminder_sent = true,
             updated_at           = now()
       where ot.id = r.token_id;
    end if;

    shop_id        := r.shop;
    shop_name      := r.shop_label;
    token_service  := r.svc;
    token_status   := r.st;
    days_to_reauth := v_days;
    alert_severity := v_sev::text;
    alert_id       := v_alert;
    next_action    := v_action;
    return next;
  end loop;
end;
$$;

comment on function public.vexim_oauth_reauth_scan(int, text) is
  'Quét mọi token: còn ≤ p_notice_days (mặc định 30) → alert amber; quá hạn → alert '
  'red + status=expired; còn xa → đóng alert cũ. Chạy mỗi ngày từ /api/cron/ads-sync?stage=oauth '
  'hoặc /api/cron/oauth-reauth. Chỉ service_role.';

revoke all on function public.vexim_oauth_reauth_scan(int, text) from public, anon, authenticated;
grant execute on function public.vexim_oauth_reauth_scan(int, text) to service_role;

-- ----------------------------------------------------------------------------
-- A10. RLS + VIEW cho §A
-- ----------------------------------------------------------------------------
alter table connections.oauth_states enable row level security;
alter table connections.oauth_events enable row level security;

-- oauth_states: KHÔNG policy nào cho client (giống oauth_tokens) — chứa luồng
-- bảo mật, chỉ service_role đọc/ghi.
-- oauth_events: cho đọc qua VIEW có lọc (bên dưới), bảng gốc vẫn khoá.

grant select on connections.oauth_events to authenticated;
grant all    on connections.oauth_states, connections.oauth_events to service_role;

-- View trạng thái kết nối: SECURITY DEFINER vì bảng gốc (oauth_tokens) cấm client.
-- Nguyên tắc: CHỈ trả trạng thái + ngày tháng, TUYỆT ĐỐI không có cột token.
create or replace view public.vexim_connections as
select
  sa.id                                     as seller_account_id,
  sa.display_name                           as shop,
  sa.seller_id,
  sa.marketplace,
  sa.status                                 as shop_status,
  sa.data_source,
  t.service,
  (t.id is not null)                        as connected,
  t.status                                  as token_status,
  t.token_source,
  t.scope,
  t.client_id,
  t.selling_partner_id,
  t.ads_account_id,
  t.authorized_at,
  t.reauthorize_at,
  t.reminder_days,
  t.reminder_sent_at,
  t.last_refresh_at,
  t.last_used_at,
  t.last_error,
  case when t.reauthorize_at is null then null
       else ceil(extract(epoch from (t.reauthorize_at - now())) / 86400)::int
  end                                       as days_to_reauth,
  case
    when t.id is null                    then 'missing'
    when t.status = 'revoked'            then 'revoked'
    when t.status = 'expired'            then 'expired'
    when t.status = 'error'              then 'error'
    when t.reauthorize_at is null        then 'unknown'
    when t.reauthorize_at <= now()       then 'overdue'
    when t.reauthorize_at <= now() + (t.reminder_days || ' days')::interval then 'due_soon'
    else 'ok'
  end                                       as reauth_state,
  (sa.data_source = 'production'
   and t.id is null)                        as needs_connect
from connections.seller_accounts sa
left join connections.oauth_tokens t on t.seller_account_id = sa.id
where iam.can_read_seller_account(sa.id);

comment on view public.vexim_connections is
  'Trạng thái kết nối từng shop × service (spapi|ads): đã authorize chưa, hạn '
  're-authorize 365 ngày còn bao lâu (reauth_state: ok|due_soon|overdue|expired|'
  'revoked|missing). SECURITY DEFINER vì đọc oauth_tokens — nhưng KHÔNG phơi cột '
  'token nào (kiểm bằng self-check §D).';

create or replace view public.vexim_oauth_events as
select
  e.id,
  e.seller_account_id,
  sa.display_name as shop,
  e.service,
  e.event,
  e.status,
  e.detail,
  e.created_at
from connections.oauth_events e
left join connections.seller_accounts sa on sa.id = e.seller_account_id
where e.seller_account_id is null
   or iam.can_read_seller_account(e.seller_account_id);

comment on view public.vexim_oauth_events is
  'Nhật ký luồng kết nối (không chứa token — RPC ghi đã chặn chuỗi giống credential).';

grant select on public.vexim_connections, public.vexim_oauth_events to authenticated, service_role;

-- ============================================================================
-- §B. MODULE 5 PHẦN 1 — PPC ĐỌC/PHÂN TÍCH (Profiles · Campaigns v3 · Reporting v3)
-- ============================================================================
-- Ba nguồn dữ liệu, BA BẢN CHẤT KHÁC NHAU (nhầm là sai số liệu):
--   (1) GET /v2/profiles           → profileId, currency, timezone, accountInfo
--       ĐỒNG BỘ, gọi khi kết nối + mỗi ngày. Không có profileId thì KHÔNG gọi
--       được bất cứ endpoint Ads nào (header Amazon-Advertising-API-Scope).
--   (2) POST /sp/campaigns/list    → TRẠNG THÁI & CẤU HÌNH (tên, state, budget,
--       targetingType, ngày chạy). KHÔNG có metrics.
--   (3) POST /reporting/reports    → METRICS (impressions/clicks/cost/sales7d…).
--       BẤT ĐỒNG BỘ: PROCESSING → COMPLETED (+url) → FAILURE. Phải nhớ reportId
--       giữa các lần chạy cron (bảng ads.report_requests, giống 0019).
--   (4) POST /sp/budgets/budgetUsage → % ngân sách đã dùng (nguồn cho alert
--       budget_exhausted). Chụp theo giờ → SUY RA giờ cạn budget (có nhãn ước lượng).
--
-- TIỀN TỆ: mỗi profile có currencyCode riêng (shop US = USD, CA = CAD). KHÔNG cộng
-- gộp khác tiền tệ — mọi view nhóm theo (shop × currency).

-- ----------------------------------------------------------------------------
-- B1. ads.ad_profiles — profile Ads của từng shop (0001 đã tạo khung)
-- ----------------------------------------------------------------------------
alter table ads.ad_profiles add column if not exists country_code   text;
alter table ads.ad_profiles add column if not exists timezone       text;
alter table ads.ad_profiles add column if not exists account_id     text;
alter table ads.ad_profiles add column if not exists account_type   text;
alter table ads.ad_profiles add column if not exists account_name   text;
alter table ads.ad_profiles add column if not exists daily_budget   numeric(12,2);
alter table ads.ad_profiles add column if not exists is_default     boolean not null default false;
alter table ads.ad_profiles add column if not exists first_seen_at  timestamptz not null default now();
alter table ads.ad_profiles add column if not exists last_synced_at timestamptz;
alter table ads.ad_profiles add column if not exists source         text not null default 'api';

comment on table ads.ad_profiles is
  'Profile Amazon Ads (GET /v2/profiles). ads_profile_id = giá trị đưa vào header '
  'Amazon-Advertising-API-Scope; marketplace = accountInfo.marketplaceStringId; '
  'account_id = accountInfo.id (seller id — Amazon cảnh báo KHÔNG unique giữa các '
  'marketplace nên khoá vẫn là shop × profileId).';

create index if not exists idx_ads_profiles_shop
  on ads.ad_profiles (seller_account_id, is_default desc, country_code);

-- ----------------------------------------------------------------------------
-- B2. ads.campaigns — trạng thái & cấu hình campaign (Campaigns v3)
-- ----------------------------------------------------------------------------
alter table ads.campaigns add column if not exists cost_type        text;
alter table ads.campaigns add column if not exists targeting_type   text;
alter table ads.campaigns add column if not exists budget_type      text;
alter table ads.campaigns add column if not exists budget_currency  text;
alter table ads.campaigns add column if not exists start_date       date;
alter table ads.campaigns add column if not exists end_date         date;
alter table ads.campaigns add column if not exists portfolio_id     text;
alter table ads.campaigns add column if not exists tactics          text;
alter table ads.campaigns add column if not exists dynamic_bidding  text;
alter table ads.campaigns add column if not exists ad_type          text;
alter table ads.campaigns add column if not exists first_seen_at    timestamptz not null default now();
alter table ads.campaigns add column if not exists last_synced_at   timestamptz;
alter table ads.campaigns add column if not exists source           text not null default 'api';

comment on table ads.campaigns is
  'Cấu hình campaign từ POST /sp/campaigns/list (v3). KHÔNG chứa metrics — metrics '
  'ở ads.ad_metrics_daily (từ Reporting v3). state: ENABLED|PAUSED|ARCHIVED.';

create index if not exists idx_ads_campaigns_shop_state
  on ads.campaigns (seller_account_id, state, campaign_type);

-- ----------------------------------------------------------------------------
-- B3. ads.ad_metrics_daily — metrics theo ngày × campaign (Reporting v3)
-- ----------------------------------------------------------------------------
-- 0001 đã có (impressions, clicks, spend, sales, orders). Giữ NGUYÊN hợp đồng đó
-- và mở rộng: `sales`/`orders` = giá trị quy đổi 7 NGÀY (sales7d/purchases7d) vì
-- đó là con số VEXIM dùng tính ACOS; các cửa sổ 1/14/30 ngày nằm ở cột riêng.
alter table ads.ad_metrics_daily add column if not exists ads_profile_id  text not null default '';
alter table ads.ad_metrics_daily add column if not exists campaign_name   text;
alter table ads.ad_metrics_daily add column if not exists campaign_type   text not null default 'sp';
alter table ads.ad_metrics_daily add column if not exists campaign_status text;
alter table ads.ad_metrics_daily add column if not exists currency        text not null default 'USD';
alter table ads.ad_metrics_daily add column if not exists budget_amount   numeric(12,2);
alter table ads.ad_metrics_daily add column if not exists sales1d         numeric(14,2);
alter table ads.ad_metrics_daily add column if not exists sales7d         numeric(14,2);
alter table ads.ad_metrics_daily add column if not exists sales14d        numeric(14,2);
alter table ads.ad_metrics_daily add column if not exists sales30d        numeric(14,2);
alter table ads.ad_metrics_daily add column if not exists purchases1d     int;
alter table ads.ad_metrics_daily add column if not exists purchases7d     int;
alter table ads.ad_metrics_daily add column if not exists purchases14d    int;
alter table ads.ad_metrics_daily add column if not exists purchases30d    int;
alter table ads.ad_metrics_daily add column if not exists units_sold7d    int;
alter table ads.ad_metrics_daily add column if not exists ctr             numeric(8,5);
alter table ads.ad_metrics_daily add column if not exists cpc             numeric(12,4);
alter table ads.ad_metrics_daily add column if not exists acos7d          numeric(8,4);
alter table ads.ad_metrics_daily add column if not exists roas7d          numeric(12,4);
alter table ads.ad_metrics_daily add column if not exists report_id       text;
alter table ads.ad_metrics_daily add column if not exists source          text not null default 'report';
alter table ads.ad_metrics_daily add column if not exists imported_at     timestamptz not null default now();

comment on table ads.ad_metrics_daily is
  'Metrics ngày × campaign từ Reporting v3 (reportTypeId=spCampaigns, timeUnit=DAILY). '
  'spend = cột cost của Amazon; sales/orders = cửa sổ 7 NGÀY (sales7d/purchases7d) '
  'vì ACOS của VEXIM tính theo 7 ngày. acos7d/roas7d/ctr/cpc: Amazon trả sẵn thì giữ, '
  'không trả thì worker tính (NULL khi không đủ dữ liệu — không đoán 0).';

create index if not exists idx_ads_metrics_shop_day
  on ads.ad_metrics_daily (seller_account_id, day desc, spend desc);

-- ----------------------------------------------------------------------------
-- B4. ads.targeting_metrics_daily — theo keyword/target (reportTypeId=spTargeting)
-- ----------------------------------------------------------------------------
create table if not exists ads.targeting_metrics_daily (
  seller_account_id  uuid not null references connections.seller_accounts(id) on delete cascade,
  day                date not null,
  ads_profile_id     text not null default '',
  campaign_id        text not null default '',
  campaign_name      text,
  ad_group_id        text not null default '',
  ad_group_name      text,
  /** khoá khử trùng: keywordId nếu có, không thì targetId/hash của expression */
  targeting_key      text not null default '',
  keyword_id         text,
  keyword_text       text,
  match_type         text,
  keyword_type       text,          -- BROAD|PHRASE|EXACT|TARGETING_EXPRESSION(_PREDEFINED)
  targeting_expression text,
  bid                numeric(12,4),
  impressions        int  not null default 0,
  clicks             int  not null default 0,
  cost               numeric(14,2) not null default 0,
  sales7d            numeric(14,2),
  purchases7d        int,
  units_sold7d       int,
  acos7d             numeric(8,4),
  roas7d             numeric(12,4),
  currency           text not null default 'USD',
  report_id          text,
  imported_at        timestamptz not null default now(),
  primary key (seller_account_id, day, campaign_id, ad_group_id, targeting_key)
);

comment on table ads.targeting_metrics_daily is
  'A2 (Phần 2 sẽ dùng): metrics theo keyword/target từ spTargeting (groupBy=targeting). '
  'keyword_type phân biệt KEYWORD (BROAD/PHRASE/EXACT) với TARGETING_EXPRESSION '
  '(ASIN/category) — Amazon lọc bằng filter keywordType.';

create index if not exists idx_ads_targeting_shop_day
  on ads.targeting_metrics_daily (seller_account_id, day desc, cost desc);

-- ----------------------------------------------------------------------------
-- B5. ads.search_terms — thuật ngữ người dùng gõ (reportTypeId=spSearchTerm)
-- ----------------------------------------------------------------------------
-- 0001 tạo bảng tối giản (term, match_type, 4 chỉ số) và KHÔNG có khoá khử trùng →
-- nhập lại cùng ngày sẽ NHÂN ĐÔI. Dọn trùng trước khi tạo index unique.
alter table ads.search_terms add column if not exists ads_profile_id text not null default '';
alter table ads.search_terms add column if not exists campaign_id    text not null default '';
alter table ads.search_terms add column if not exists campaign_name  text;
alter table ads.search_terms add column if not exists ad_group_id    text not null default '';
alter table ads.search_terms add column if not exists ad_group_name  text;
alter table ads.search_terms add column if not exists keyword_id     text;
alter table ads.search_terms add column if not exists keyword_text   text;
alter table ads.search_terms add column if not exists keyword_type   text;
alter table ads.search_terms add column if not exists targeting      text;
alter table ads.search_terms add column if not exists bid            numeric(12,4);
alter table ads.search_terms add column if not exists ad_keyword_status text;
alter table ads.search_terms add column if not exists currency       text not null default 'USD';
alter table ads.search_terms add column if not exists sales7d        numeric(14,2);
alter table ads.search_terms add column if not exists purchases7d    int;
alter table ads.search_terms add column if not exists units_sold7d   int;
alter table ads.search_terms add column if not exists acos7d         numeric(8,4);
alter table ads.search_terms add column if not exists roas7d         numeric(12,4);
alter table ads.search_terms add column if not exists report_id      text;
alter table ads.search_terms add column if not exists imported_at    timestamptz not null default now();

-- Dọn dòng trùng (giữ dòng mới nhất) TRƯỚC khi siết khoá, nếu không migration fail.
delete from ads.search_terms a
 using ads.search_terms b
 where a.ctid < b.ctid
   and a.seller_account_id = b.seller_account_id
   and a.day = b.day
   and coalesce(a.term, '') = coalesce(b.term, '')
   and coalesce(a.match_type, '') = coalesce(b.match_type, '');

create unique index if not exists uq_search_terms_key
  on ads.search_terms (seller_account_id, day, campaign_id, ad_group_id, term,
                       coalesce(keyword_id, ''), coalesce(match_type, ''));
create index if not exists idx_search_terms_shop_day
  on ads.search_terms (seller_account_id, day desc, spend desc);

comment on table ads.search_terms is
  'A3: search term report (spSearchTerm, groupBy=searchTerm). Amazon chỉ trả các '
  'impression CÓ ÍT NHẤT 1 CLICK; placement không gắn từ khoá thì term = "*". '
  'Gợi ý negative keyword (Phần 2) đọc từ đây.';

-- ----------------------------------------------------------------------------
-- B6. ads.advertised_product_daily — spend theo ASIN/SKU (nuôi F4 ads_spend)
-- ----------------------------------------------------------------------------
create table if not exists ads.advertised_product_daily (
  seller_account_id  uuid not null references connections.seller_accounts(id) on delete cascade,
  day                date not null,
  ads_profile_id     text not null default '',
  campaign_id        text not null default '',
  ad_group_id        text not null default '',
  advertised_asin    text not null default '',
  advertised_sku     text not null default '',
  impressions        int  not null default 0,
  clicks             int  not null default 0,
  cost               numeric(14,2) not null default 0,
  sales7d            numeric(14,2),
  purchases7d        int,
  units_sold7d       int,
  currency           text not null default 'USD',
  report_id          text,
  imported_at        timestamptz not null default now(),
  primary key (seller_account_id, day, campaign_id, ad_group_id, advertised_asin, advertised_sku)
);

comment on table ads.advertised_product_daily is
  'reportTypeId=spAdvertisedProduct (groupBy=advertiser): spend theo sản phẩm được '
  'quảng cáo. Đây là NGUỒN THẬT của finance.sku_profit_daily.ads_spend (F4) — '
  'khớp ASIN→SKU qua catalog.listings, giống cách 0019 suy SKU cho phí lưu kho.';

create index if not exists idx_ads_advertised_shop_day
  on ads.advertised_product_daily (seller_account_id, day desc, cost desc);

-- ----------------------------------------------------------------------------
-- B7. ads.budget_usage — % ngân sách đã dùng, chụp nhiều lần/ngày
-- ----------------------------------------------------------------------------
create table if not exists ads.budget_usage (
  id                 uuid primary key default gen_random_uuid(),
  seller_account_id  uuid not null references connections.seller_accounts(id) on delete cascade,
  ads_profile_id     text not null default '',
  day                date not null,
  campaign_id        text not null default '',
  campaign_name      text,
  budget_type        text not null default 'DAILY',
  budget             numeric(12,2),
  spend              numeric(14,2),
  percentage_used    numeric(8,4),
  delivered_clicks   int,
  delivered_impressions int,
  currency           text not null default 'USD',
  captured_at        timestamptz not null default now(),
  source             text not null default 'budget_usage_api'
);

comment on table ads.budget_usage is
  'POST /sp/budgets/budgetUsage (percentageUsed) + có thể nạp từ report intraday. '
  'Chụp THEO GIỜ (khoá theo giờ) → view vexim_ads_budget_usage suy ra giờ cạn '
  'ngân sách: đó là ƯỚC LƯỢNG (khoảng giữa 2 lần chụp), không phải giờ chính xác.';

/**
 * Bucket THEO GIỜ của thời điểm chụp — phải là hàm IMMUTABLE thì mới đưa vào
 * unique index được (date_trunc(text, timestamptz) là STABLE vì phụ thuộc
 * TimeZone của phiên → Postgres từ chối). Neo cứng về UTC: cùng một thời điểm
 * tuyệt đối thì bucket luôn giống nhau, không đổi theo múi giờ người chạy.
 */
create or replace function ads.hour_bucket(p_ts timestamptz)
returns timestamptz
language sql immutable
as $$
  select date_trunc('hour', p_ts at time zone 'UTC') at time zone 'UTC';
$$;

comment on function ads.hour_bucket(timestamptz) is
  'Làm tròn thời điểm về đầu GIỜ (UTC). Immutable để dùng trong unique index '
  'ads.budget_usage → chụp nhiều lần trong một giờ thì cập nhật, không phình bảng.';

create unique index if not exists uq_budget_usage_hour
  on ads.budget_usage (seller_account_id, campaign_id, day, ads.hour_bucket(captured_at));
create index if not exists idx_budget_usage_shop_day
  on ads.budget_usage (seller_account_id, day desc, captured_at desc);

-- ----------------------------------------------------------------------------
-- B8. ads.report_requests — trạng thái report bất đồng bộ của Ads (Reporting v3)
-- ----------------------------------------------------------------------------
create table if not exists ads.report_requests (
  id                 uuid primary key default gen_random_uuid(),
  seller_account_id  uuid not null references connections.seller_accounts(id) on delete cascade,
  ads_profile_id     text not null default '',
  report_type_id     text not null,       -- spCampaigns | spTargeting | spSearchTerm | spAdvertisedProduct
  ad_product         text not null default 'SPONSORED_PRODUCTS',
  group_by           text not null default '',
  time_unit          text not null default 'DAILY',
  date_start         date,
  date_end           date,
  /** reportId của Ads (KHÁC reportId SP-API) */
  ads_report_id      text,
  /** requested → processing → completed (có url) → imported · failure · no_data · failed · throttled */
  status             text not null default 'requested',
  failure_reason     text,
  download_url       text,
  rows_imported      int,
  attempts           int not null default 0,
  last_error         text,
  requested_at       timestamptz,
  completed_at       timestamptz,
  imported_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table ads.report_requests is
  'Nhật ký yêu cầu report Ads (bất đồng bộ). Khoá (shop × profile × loại report × '
  'groupBy × timeUnit × khoảng ngày) để cron chạy lại POLL tiếp reportId cũ thay vì '
  'xin report mới — trần tốc độ Reporting Ads tính theo hàng đợi của cả region, '
  'xin thừa là tự làm mình bị 429.';

create unique index if not exists uq_ads_report_requests_key
  on ads.report_requests (seller_account_id, ads_profile_id, report_type_id, group_by,
                          time_unit, coalesce(date_start, date '1900-01-01'),
                          coalesce(date_end, date '1900-01-01'));
create index if not exists idx_ads_report_requests_status
  on ads.report_requests (seller_account_id, status, requested_at desc);

-- ----------------------------------------------------------------------------
-- B9. RLS cho các bảng Ads mới (bảng cũ đã có policy từ vòng lặp 0001)
-- ----------------------------------------------------------------------------
alter table ads.targeting_metrics_daily     enable row level security;
alter table ads.advertised_product_daily    enable row level security;
alter table ads.budget_usage                enable row level security;
alter table ads.report_requests             enable row level security;

drop policy if exists "ads_targeting: đọc theo shop" on ads.targeting_metrics_daily;
create policy "ads_targeting: đọc theo shop" on ads.targeting_metrics_daily
  for select to authenticated using (iam.can_read_seller_account(seller_account_id));

drop policy if exists "ads_advertised: đọc theo shop" on ads.advertised_product_daily;
create policy "ads_advertised: đọc theo shop" on ads.advertised_product_daily
  for select to authenticated using (iam.can_read_seller_account(seller_account_id));

drop policy if exists "ads_budget_usage: đọc theo shop" on ads.budget_usage;
create policy "ads_budget_usage: đọc theo shop" on ads.budget_usage
  for select to authenticated using (iam.can_read_seller_account(seller_account_id));

drop policy if exists "ads_report_requests: đọc theo shop" on ads.report_requests;
create policy "ads_report_requests: đọc theo shop" on ads.report_requests
  for select to authenticated using (iam.can_read_seller_account(seller_account_id));

grant select on ads.ad_profiles, ads.campaigns, ads.ad_metrics_daily, ads.search_terms,
                ads.targeting_metrics_daily, ads.advertised_product_daily,
                ads.budget_usage, ads.report_requests to authenticated;
grant all on ads.ad_profiles, ads.campaigns, ads.ad_metrics_daily, ads.search_terms,
             ads.targeting_metrics_daily, ads.advertised_product_daily,
             ads.budget_usage, ads.report_requests to service_role;

-- ----------------------------------------------------------------------------
-- B10. Helper đọc số (bản của schema ads — giống finance.num_or_null của 0019)
-- ----------------------------------------------------------------------------
create or replace function ads.num_or_null(p_text text)
returns numeric
language sql immutable
as $$
  select case
    when btrim(coalesce(p_text, '')) ~ '^-?[0-9]+(\.[0-9]+)?$'
      then btrim(p_text)::numeric
    when btrim(coalesce(p_text, '')) ~ '^-?[0-9]{1,3}(,[0-9]{3})+(\.[0-9]+)?$'
      then replace(btrim(p_text), ',', '')::numeric
    when btrim(coalesce(p_text, '')) ~ '^-?[0-9]+(\.[0-9]+)?%$'
      then replace(btrim(p_text), '%', '')::numeric
  end;
$$;

comment on function ads.num_or_null(text) is
  'Ép chuỗi trong report Ads về numeric (nhận cả "1,234.56" và "18.2%"); '
  'không đọc được → NULL. KHÔNG ném lỗi để một dòng rác không làm mất cả lô.';

create or replace function ads.date_or_null(p_text text)
returns date
language sql immutable
as $$
  select case
    -- ISO: "2026-09-11", "2026-09-11T00:00:00Z" (report Metrics trả kiểu này)
    when btrim(coalesce(p_text, '')) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
      then left(btrim(p_text), 10)::date
    -- Gọn: "20260911" (startDate/endDate của Campaigns v3 trả yyyyMMdd)
    when btrim(coalesce(p_text, '')) ~ '^[0-9]{8}$'
      then to_date(btrim(p_text), 'YYYYMMDD')
    -- Epoch milli giây: creationDate/lastUpdatedDate của Campaigns v3
    when btrim(coalesce(p_text, '')) ~ '^[0-9]{13}$'
      then (to_timestamp(btrim(p_text)::bigint / 1000.0) at time zone 'UTC')::date
  end;
$$;

comment on function ads.date_or_null(text) is
  'Lấy ngày từ chuỗi Ads API: ISO "2026-09-11[T00:00:00Z]", gọn "20260911" '
  '(startDate Campaigns v3), epoch millis "1789123456789" (creationDate v3). '
  'Sai định dạng → NULL (không nổ cả lô nhập).';

-- ----------------------------------------------------------------------------
-- B11. RPC — nhập profiles (GET /v2/profiles)
-- ----------------------------------------------------------------------------
create or replace function public.vexim_worker_upsert_ads_profiles(
  p_seller uuid,
  p_rows   jsonb
)
returns table (inserted int, updated int, skipped int, profiles int, merged int)
language plpgsql
security definer
set search_path = ads, public, pg_catalog
as $$
  -- `use_column`: hàm returns table(...) nên tên cột OUT (id, status, service, days…)
  -- trùng tên cột thật → trong MỌI biểu thức SQL, tên trùng được hiểu là CỘT.
  -- (Biến nội bộ đều có tiền tố v_/p_ nên không bị đổi nghĩa; thiếu dòng này thì
  -- on conflict (…, service) nổ "column reference service is ambiguous" lúc chạy.)
  #variable_conflict use_column
declare
  v_clean  jsonb;
  v_total  int := 0;
  v_valid  int := 0;
  v_exists int := 0;
  v_bad    int := 0;
begin
  if auth.uid() is not null then
    raise exception '[ADS] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_seller is null then
    raise exception '[ADS] thiếu seller_account_id' using errcode = 'invalid_parameter_value';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '[ADS] p_rows phải là JSON array (nhận %)',
      coalesce(jsonb_typeof(p_rows), 'NULL') using errcode = 'invalid_parameter_value';
  end if;

  v_total := jsonb_array_length(p_rows);

  -- Dòng RÁC (không profileId → không biết ghi vào đâu) đếm RIÊNG: `skipped` là
  -- "mất dữ liệu", `merged` là "gộp trùng khoá" — 2 con số nói 2 chuyện khác nhau.
  select count(*) into v_bad
  from jsonb_array_elements(p_rows) r
  where btrim(coalesce(r ->> 'profileId', '')) = '';

  select coalesce(jsonb_agg(jsonb_build_object(
           'profileId',   g.profile_id,
           'marketplace', g.marketplace,
           'countryCode', g.country_code,
           'currency',    g.currency,
           'timezone',    g.timezone,
           'accountId',   g.account_id,
           'accountType', g.account_type,
           'accountName', g.account_name,
           'dailyBudget', g.daily_budget,
           'isDefault',   g.is_default,
           'source',      g.src
         )), '[]'::jsonb)
    into v_clean
  from (
    select n.profile_id,
           max(n.marketplace)  as marketplace,
           max(n.country_code) as country_code,
           max(n.currency)     as currency,
           max(n.timezone)     as timezone,
           max(n.account_id)   as account_id,
           max(n.account_type) as account_type,
           max(n.account_name) as account_name,
           max(n.daily_budget) as daily_budget,
           bool_or(n.is_default) as is_default,
           max(n.src)          as src
    from (
      select
        btrim(coalesce(r ->> 'profileId', ''))                      as profile_id,
        nullif(upper(btrim(coalesce(r ->> 'marketplaceStringId', r ->> 'marketplace', ''))), '') as marketplace,
        nullif(upper(btrim(coalesce(r ->> 'countryCode', ''))), '')  as country_code,
        nullif(upper(btrim(coalesce(r ->> 'currencyCode', r ->> 'currency',
                                    r -> 'dailyBudget' ->> 'currency', ''))), '') as currency,
        nullif(btrim(coalesce(r ->> 'timezone', '')), '')            as timezone,
        -- GET /v2/profiles trả NESTED: accountInfo{id,type,name}, dailyBudget{currency,amount}.
        -- Vẫn nhận bản phẳng (accountId/dailyBudget) để worker flatten trước cũng được.
        nullif(btrim(coalesce(r -> 'accountInfo' ->> 'id', r ->> 'accountId', '')), '')   as account_id,
        nullif(lower(btrim(coalesce(r -> 'accountInfo' ->> 'type', r ->> 'accountType', ''))), '') as account_type,
        nullif(btrim(coalesce(r -> 'accountInfo' ->> 'name', r ->> 'accountName', '')), '')        as account_name,
        coalesce(ads.num_or_null(r -> 'dailyBudget' ->> 'amount'),
                 ads.num_or_null(r ->> 'dailyBudget'))                as daily_budget,
        case when lower(btrim(coalesce(r ->> 'isDefault', '')))
                  in ('true','t','1','yes','y') then true else false end as is_default,
        coalesce(nullif(btrim(coalesce(r ->> 'source', '')), ''), 'api') as src
      from jsonb_array_elements(p_rows) r
    ) n
    where n.profile_id <> ''
    group by 1
  ) g;

  v_valid := jsonb_array_length(v_clean);

  -- Đếm dòng ĐÃ có trước khi ghi → trả inserted/updated thật (log không nói dối).
  select count(*) into v_exists
  from ads.ad_profiles p
  where p.seller_account_id = p_seller
    and p.ads_profile_id in (select c ->> 'profileId' from jsonb_array_elements(v_clean) c);

  insert into ads.ad_profiles as t (
    seller_account_id, ads_profile_id, marketplace, currency, country_code, timezone,
    account_id, account_type, account_name, daily_budget, is_default, source, last_synced_at
  )
  select p_seller,
         c ->> 'profileId',
         coalesce(c ->> 'marketplace', ''),
         coalesce(c ->> 'currency', 'USD'),
         c ->> 'countryCode',
         c ->> 'timezone',
         c ->> 'accountId',
         c ->> 'accountType',
         c ->> 'accountName',
         ads.num_or_null(c ->> 'dailyBudget'),
         case when lower(btrim(coalesce(c ->> 'isDefault', '')))
                   in ('true','t','1','yes','y') then true else false end,
         coalesce(c ->> 'source', 'api'),
         now()
  from jsonb_array_elements(v_clean) c
  on conflict (seller_account_id, ads_profile_id) do update set
    marketplace    = coalesce(nullif(excluded.marketplace, ''), t.marketplace),
    currency       = coalesce(nullif(excluded.currency, ''), t.currency),
    country_code   = coalesce(excluded.country_code, t.country_code),
    timezone       = coalesce(excluded.timezone, t.timezone),
    account_id     = coalesce(excluded.account_id, t.account_id),
    account_type   = coalesce(excluded.account_type, t.account_type),
    account_name   = coalesce(excluded.account_name, t.account_name),
    daily_budget   = coalesce(excluded.daily_budget, t.daily_budget),
    is_default     = excluded.is_default,
    source         = excluded.source,
    last_synced_at = now();

  inserted := greatest(v_valid - v_exists, 0);
  updated  := least(v_exists, v_valid);
  skipped  := coalesce(v_bad, 0);
  profiles := v_valid;
  merged   := greatest(v_total - coalesce(v_bad, 0) - v_valid, 0);
  return next;
end;
$$;

comment on function public.vexim_worker_upsert_ads_profiles(uuid, jsonb) is
  'Nhập profiles từ GET /v2/profiles. Khoá (shop × ads_profile_id). '
  'Trả profiles = số profile hợp lệ, inserted/updated đếm bằng cách so trước khi ghi, '
  'skipped = số dòng thiếu profileId.';

revoke all on function public.vexim_worker_upsert_ads_profiles(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.vexim_worker_upsert_ads_profiles(uuid, jsonb) to service_role;

-- ----------------------------------------------------------------------------
-- B12. RPC — nhập campaigns (POST /sp/campaigns/list, v3)
-- ----------------------------------------------------------------------------
create or replace function public.vexim_worker_upsert_ads_campaigns(
  p_seller uuid,
  p_rows   jsonb
)
returns table (inserted int, updated int, skipped int, campaigns int, merged int)
language plpgsql
security definer
set search_path = ads, public, pg_catalog
as $$
  -- `use_column`: hàm returns table(...) nên tên cột OUT (id, status, service, days…)
  -- trùng tên cột thật → trong MỌI biểu thức SQL, tên trùng được hiểu là CỘT.
  -- (Biến nội bộ đều có tiền tố v_/p_ nên không bị đổi nghĩa; thiếu dòng này thì
  -- on conflict (…, service) nổ "column reference service is ambiguous" lúc chạy.)
  #variable_conflict use_column
declare
  v_clean  jsonb;
  v_total  int := 0;
  v_valid  int := 0;
  v_exists int := 0;
  v_bad    int := 0;
begin
  if auth.uid() is not null then
    raise exception '[ADS] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_seller is null then
    raise exception '[ADS] thiếu seller_account_id' using errcode = 'invalid_parameter_value';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '[ADS] p_rows phải là JSON array (nhận %)',
      coalesce(jsonb_typeof(p_rows), 'NULL') using errcode = 'invalid_parameter_value';
  end if;

  v_total := jsonb_array_length(p_rows);

  select count(*) into v_bad
  from jsonb_array_elements(p_rows) r
  where btrim(coalesce(r ->> 'campaignId', '')) = '';

  select coalesce(jsonb_agg(jsonb_build_object(
           'profileId',     g.profile_id,
           'campaignId',    g.campaign_id,
           'name',          g.name,
           'type',          g.ctype,
           'state',         g.state,
           'budget',        g.budget,
           'budgetType',    g.budget_type,
           'budgetCurrency',g.budget_currency,
           'costType',      g.cost_type,
           'targetingType', g.targeting_type,
           'startDate',     g.start_date,
           'endDate',       g.end_date,
           'portfolioId',   g.portfolio_id,
           'tactics',       g.tactics,
           'dynamicBidding',g.dynamic_bidding,
           'adType',        g.ad_type,
           'source',        g.src
         )), '[]'::jsonb)
    into v_clean
  from (
    select n.campaign_id,
           max(n.profile_id)      as profile_id,
           max(n.name)            as name,
           max(n.ctype)           as ctype,
           max(n.state)           as state,
           max(n.budget)          as budget,
           max(n.budget_type)     as budget_type,
           max(n.budget_currency) as budget_currency,
           max(n.cost_type)       as cost_type,
           max(n.targeting_type)  as targeting_type,
           max(n.start_date)      as start_date,
           max(n.end_date)        as end_date,
           max(n.portfolio_id)    as portfolio_id,
           max(n.tactics)         as tactics,
           max(n.dynamic_bidding) as dynamic_bidding,
           max(n.ad_type)         as ad_type,
           max(n.src)             as src
    from (
      select
        btrim(coalesce(r ->> 'campaignId', ''))                       as campaign_id,
        btrim(coalesce(r ->> 'adsProfileId', r ->> 'profileId', ''))   as profile_id,
        nullif(btrim(coalesce(r ->> 'name', '')), '')                  as name,
        lower(btrim(coalesce(r ->> 'campaignType', 'sp')))             as ctype,
        upper(btrim(coalesce(r ->> 'state', 'ENABLED')))               as state,
        -- v3 trả budget là OBJECT: {"budget":10,"currencyCode":"USD","budgetType":"DAILY"}.
        -- Đọc nested trước, rơi về bản phẳng (dailyBudget/budget) nếu worker đã flatten.
        coalesce(ads.num_or_null(r -> 'budget' ->> 'budget'),
                 ads.num_or_null(r ->> 'dailyBudget'),
                 ads.num_or_null(r ->> 'budget'))                      as budget,
        nullif(upper(btrim(coalesce(r -> 'budget' ->> 'budgetType',
                                    r ->> 'budgetType', ''))), '')      as budget_type,
        nullif(upper(btrim(coalesce(r -> 'budget' ->> 'currencyCode',
                                    r ->> 'budgetCurrency', r ->> 'currency', ''))), '') as budget_currency,
        nullif(upper(btrim(coalesce(r ->> 'costType', ''))), '')       as cost_type,
        nullif(upper(btrim(coalesce(r ->> 'targetingType', ''))), '')  as targeting_type,
        ads.date_or_null(r ->> 'startDate')                            as start_date,
        ads.date_or_null(r ->> 'endDate')                              as end_date,
        nullif(btrim(coalesce(r ->> 'portfolioId', '')), '')           as portfolio_id,
        nullif(upper(btrim(coalesce(r ->> 'tactics', ''))), '')        as tactics,
        nullif(upper(btrim(coalesce(r ->> 'dynamicBidding', ''))), '') as dynamic_bidding,
        nullif(upper(btrim(coalesce(r ->> 'adType', ''))), '')         as ad_type,
        coalesce(nullif(btrim(coalesce(r ->> 'source', '')), ''), 'api') as src
      from jsonb_array_elements(p_rows) r
    ) n
    -- Không có campaignId thì không biết ghi vào đâu → bỏ, đếm skipped.
    where n.campaign_id <> ''
    group by 1
  ) g;

  v_valid := jsonb_array_length(v_clean);

  select count(*) into v_exists
  from ads.campaigns c
  where c.seller_account_id = p_seller
    and c.campaign_id in (select x ->> 'campaignId' from jsonb_array_elements(v_clean) x);

  insert into ads.campaigns as t (
    seller_account_id, ads_profile_id, campaign_id, campaign_type, name, state,
    daily_budget, budget_type, budget_currency, cost_type, targeting_type,
    start_date, end_date, portfolio_id, tactics, dynamic_bidding, ad_type,
    source, first_seen_at, last_synced_at
  )
  select p_seller,
         coalesce(c ->> 'profileId', ''),
         c ->> 'campaignId',
         coalesce(c ->> 'type', 'sp'),
         coalesce(c ->> 'name', ''),
         coalesce(c ->> 'state', 'ENABLED'),
         ads.num_or_null(c ->> 'budget'),
         c ->> 'budgetType',
         c ->> 'budgetCurrency',
         c ->> 'costType',
         c ->> 'targetingType',
         ads.date_or_null(c ->> 'startDate'),
         ads.date_or_null(c ->> 'endDate'),
         c ->> 'portfolioId',
         c ->> 'tactics',
         c ->> 'dynamicBidding',
         c ->> 'adType',
         coalesce(c ->> 'source', 'api'),
         now(),
         now()
  from jsonb_array_elements(v_clean) c
  on conflict (seller_account_id, campaign_id) do update set
    ads_profile_id  = coalesce(nullif(excluded.ads_profile_id, ''), t.ads_profile_id),
    campaign_type   = coalesce(nullif(excluded.campaign_type, ''), t.campaign_type),
    name            = coalesce(nullif(excluded.name, ''), t.name),
    state           = coalesce(nullif(excluded.state, ''), t.state),
    -- Ngân sách: 0 là GIÁ TRỊ THẬT (campaign bị hạ về 0) nên KHÔNG coalesce về cũ.
    daily_budget    = excluded.daily_budget,
    budget_type     = coalesce(excluded.budget_type, t.budget_type),
    budget_currency = coalesce(excluded.budget_currency, t.budget_currency),
    cost_type       = coalesce(excluded.cost_type, t.cost_type),
    targeting_type  = coalesce(excluded.targeting_type, t.targeting_type),
    start_date      = coalesce(excluded.start_date, t.start_date),
    end_date        = coalesce(excluded.end_date, t.end_date),
    portfolio_id    = coalesce(excluded.portfolio_id, t.portfolio_id),
    tactics         = coalesce(excluded.tactics, t.tactics),
    dynamic_bidding = coalesce(excluded.dynamic_bidding, t.dynamic_bidding),
    ad_type         = coalesce(excluded.ad_type, t.ad_type),
    source          = excluded.source,
    last_synced_at  = now();

  inserted  := greatest(v_valid - v_exists, 0);
  updated   := least(v_exists, v_valid);
  skipped   := coalesce(v_bad, 0);
  campaigns := v_valid;
  merged    := greatest(v_total - coalesce(v_bad, 0) - v_valid, 0);
  return next;
end;
$$;

comment on function public.vexim_worker_upsert_ads_campaigns(uuid, jsonb) is
  'Nhập campaigns từ POST /sp/campaigns/list (v3). Khoá (shop × campaign_id). '
  'daily_budget ghi đè kể cả 0 (hạ ngân sách về 0 là thao tác thật, không phải "chưa biết").';

revoke all on function public.vexim_worker_upsert_ads_campaigns(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.vexim_worker_upsert_ads_campaigns(uuid, jsonb) to service_role;

-- ----------------------------------------------------------------------------
-- B13. RPC — nhập metrics ngày × campaign (reportTypeId=spCampaigns)
-- ----------------------------------------------------------------------------
create or replace function public.vexim_worker_upsert_ads_metrics(
  p_seller uuid,
  p_rows   jsonb
)
returns table (inserted int, updated int, skipped int, days int, currencies text,
                   merged int)
language plpgsql
security definer
set search_path = ads, public, pg_catalog
as $$
  -- `use_column`: hàm returns table(...) nên tên cột OUT (id, status, service, days…)
  -- trùng tên cột thật → trong MỌI biểu thức SQL, tên trùng được hiểu là CỘT.
  -- (Biến nội bộ đều có tiền tố v_/p_ nên không bị đổi nghĩa; thiếu dòng này thì
  -- on conflict (…, service) nổ "column reference service is ambiguous" lúc chạy.)
  #variable_conflict use_column
declare
  v_clean jsonb;
  v_total int := 0;
  v_valid int := 0;
  v_days  int := 0;
  v_curr  text;
  v_bad   int := 0;
  v_exists int := 0;
begin
  if auth.uid() is not null then
    raise exception '[ADS] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_seller is null then
    raise exception '[ADS] thiếu seller_account_id' using errcode = 'invalid_parameter_value';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '[ADS] p_rows phải là JSON array (nhận %)',
      coalesce(jsonb_typeof(p_rows), 'NULL') using errcode = 'invalid_parameter_value';
  end if;

  v_total := jsonb_array_length(p_rows);

  -- Dòng RÁC = thiếu ngày hoặc thiếu campaignId (không biết ghi vào đâu).
  -- Đếm riêng khỏi `merged` (dòng trùng khoá bị gộp bằng max trong cùng lô).
  select count(*) into v_bad
  from jsonb_array_elements(p_rows) r
  where ads.date_or_null(coalesce(r ->> 'date', r ->> 'day')) is null
     or btrim(coalesce(r ->> 'campaignId', '')) = '';

  select coalesce(jsonb_agg(jsonb_build_object(
           'day',            g.day,
           'campaignId',     g.campaign_id,
           'profileId',      g.profile_id,
           'campaignName',   g.campaign_name,
           'campaignType',   g.campaign_type,
           'campaignStatus', g.campaign_status,
           'currency',       g.currency,
           'budgetAmount',   g.budget_amount,
           'impressions',    g.impressions,
           'clicks',         g.clicks,
           'cost',           g.cost,
           'sales1d',        g.sales1d,  'sales7d',  g.sales7d,
           'sales14d',       g.sales14d, 'sales30d', g.sales30d,
           'purchases1d',    g.purchases1d,  'purchases7d',  g.purchases7d,
           'purchases14d',   g.purchases14d, 'purchases30d', g.purchases30d,
           'unitsSold7d',    g.units_sold7d,
           'ctr',            g.ctr, 'cpc', g.cpc,
           'acos7d',         g.acos7d, 'roas7d', g.roas7d,
           'reportId',       g.report_id,
           'source',         g.src
         )), '[]'::jsonb),
         count(distinct g.day),
         string_agg(distinct g.currency, ',' order by g.currency)
    into v_clean, v_days, v_curr
  from (
    select n.day, n.campaign_id,
           max(n.profile_id)      as profile_id,
           max(n.campaign_name)   as campaign_name,
           max(n.campaign_type)   as campaign_type,
           max(n.campaign_status) as campaign_status,
           max(n.currency)        as currency,
           max(n.budget_amount)   as budget_amount,
           -- Chỉ số: trùng khoá thì lấy max (KHÔNG cộng — report chồng khoảng ngày
           -- sẽ nhân đôi tiền, đó là lỗi số liệu nguy hiểm nhất của module này).
           max(n.impressions)     as impressions,
           max(n.clicks)          as clicks,
           max(n.cost)            as cost,
           max(n.sales1d)         as sales1d,
           max(n.sales7d)         as sales7d,
           max(n.sales14d)        as sales14d,
           max(n.sales30d)        as sales30d,
           max(n.purchases1d)     as purchases1d,
           max(n.purchases7d)     as purchases7d,
           max(n.purchases14d)    as purchases14d,
           max(n.purchases30d)    as purchases30d,
           max(n.units_sold7d)    as units_sold7d,
           max(n.ctr)             as ctr,
           max(n.cpc)             as cpc,
           max(n.acos7d)          as acos7d,
           max(n.roas7d)          as roas7d,
           max(n.report_id)       as report_id,
           max(n.src)             as src
    from (
      select
        ads.date_or_null(coalesce(r ->> 'date', r ->> 'day'))          as day,
        btrim(coalesce(r ->> 'campaignId', ''))                        as campaign_id,
        btrim(coalesce(r ->> 'adsProfileId', r ->> 'profileId', ''))    as profile_id,
        nullif(btrim(coalesce(r ->> 'campaignName', '')), '')          as campaign_name,
        lower(btrim(coalesce(r ->> 'campaignType', 'sp')))             as campaign_type,
        nullif(upper(btrim(coalesce(r ->> 'campaignStatus', ''))), '') as campaign_status,
        coalesce(nullif(upper(btrim(coalesce(r ->> 'currency', r ->> 'currencyCode',
                                         r ->> 'campaignBudgetCurrencyCode', ''))), ''), 'USD') as currency,
        ads.num_or_null(coalesce(r ->> 'campaignBudgetAmount', r ->> 'campaignBudget',
                                 r ->> 'budgetAmount'))                  as budget_amount,
        coalesce(ads.num_or_null(r ->> 'impressions'), 0)::int         as impressions,
        coalesce(ads.num_or_null(r ->> 'clicks'), 0)::int              as clicks,
        ads.num_or_null(r ->> 'cost')                                  as cost,
        ads.num_or_null(coalesce(r ->> 'sales1d', r ->> 'attributedSales1d'))                               as sales1d,
        ads.num_or_null(coalesce(r ->> 'sales7d', r ->> 'attributedSales7d'))                               as sales7d,
        ads.num_or_null(coalesce(r ->> 'sales14d', r ->> 'attributedSales14d'))                              as sales14d,
        ads.num_or_null(coalesce(r ->> 'sales30d', r ->> 'attributedSales30d'))                              as sales30d,
        ads.num_or_null(coalesce(r ->> 'purchases1d', r ->> 'attributedConversions1d'))::int                      as purchases1d,
        ads.num_or_null(coalesce(r ->> 'purchases7d', r ->> 'attributedConversions7d'))::int                      as purchases7d,
        ads.num_or_null(coalesce(r ->> 'purchases14d', r ->> 'attributedConversions14d'))::int                     as purchases14d,
        ads.num_or_null(coalesce(r ->> 'purchases30d', r ->> 'attributedConversions30d'))::int                     as purchases30d,
        ads.num_or_null(coalesce(r ->> 'unitsSold7d', r ->> 'unitsSoldClicks7d'))::int as units_sold7d,
        ads.num_or_null(r ->> 'clickThroughRate')                      as ctr,
        ads.num_or_null(r ->> 'costPerClick')                          as cpc,
        ads.num_or_null(r ->> 'acosClicks7d')                          as acos7d,
        ads.num_or_null(r ->> 'roasClicks7d')                          as roas7d,
        nullif(btrim(coalesce(r ->> 'reportId', '')), '')              as report_id,
        coalesce(nullif(btrim(coalesce(r ->> 'source', '')), ''), 'report') as src
      from jsonb_array_elements(p_rows) r
    ) n
    where n.day is not null and n.campaign_id <> ''
    group by 1, 2
  ) g;

  v_valid := jsonb_array_length(v_clean);

  -- Đếm dòng ĐÃ có trước khi ghi → log nói đúng "thêm mới N / cập nhật M".
  select count(*) into v_exists
  from ads.ad_metrics_daily m
  where m.seller_account_id = p_seller
    and (m.day, m.campaign_id) in (
      select (c ->> 'day')::date, c ->> 'campaignId' from jsonb_array_elements(v_clean) c);

  insert into ads.ad_metrics_daily as t (
    seller_account_id, day, campaign_id, ads_profile_id, campaign_name, campaign_type,
    campaign_status, currency, budget_amount, impressions, clicks, spend,
    sales, orders,
    sales1d, sales7d, sales14d, sales30d,
    purchases1d, purchases7d, purchases14d, purchases30d, units_sold7d,
    ctr, cpc, acos7d, roas7d, report_id, source, imported_at
  )
  select p_seller,
         (c ->> 'day')::date,
         c ->> 'campaignId',
         coalesce(c ->> 'profileId', ''),
         c ->> 'campaignName',
         coalesce(c ->> 'campaignType', 'sp'),
         c ->> 'campaignStatus',
         coalesce(c ->> 'currency', 'USD'),
         ads.num_or_null(c ->> 'budgetAmount'),
         coalesce(ads.num_or_null(c ->> 'impressions'), 0)::int,
         coalesce(ads.num_or_null(c ->> 'clicks'), 0)::int,
         coalesce(ads.num_or_null(c ->> 'cost'), 0),
         coalesce(ads.num_or_null(c ->> 'sales7d'), 0),
         coalesce(ads.num_or_null(c ->> 'purchases7d'), 0)::int,
         ads.num_or_null(c ->> 'sales1d'),
         ads.num_or_null(c ->> 'sales7d'),
         ads.num_or_null(c ->> 'sales14d'),
         ads.num_or_null(c ->> 'sales30d'),
         ads.num_or_null(c ->> 'purchases1d')::int,
         ads.num_or_null(c ->> 'purchases7d')::int,
         ads.num_or_null(c ->> 'purchases14d')::int,
         ads.num_or_null(c ->> 'purchases30d')::int,
         ads.num_or_null(c ->> 'unitsSold7d')::int,
         -- Amazon có trả ctr/cpc/acos/roas thì giữ; không thì TỰ TÍNH từ cost/
         -- clicks/impressions/sales7d. Chia 0 → NULL ("chưa biết"), không phải 0.
         coalesce(ads.num_or_null(c ->> 'ctr'),
                  round(100.0 * coalesce(ads.num_or_null(c ->> 'clicks'), 0)
                        / nullif(coalesce(ads.num_or_null(c ->> 'impressions'), 0), 0), 5)),
         coalesce(ads.num_or_null(c ->> 'cpc'),
                  round(coalesce(ads.num_or_null(c ->> 'cost'), 0)
                        / nullif(coalesce(ads.num_or_null(c ->> 'clicks'), 0), 0), 4)),
         coalesce(ads.num_or_null(c ->> 'acos7d'),
                  case when coalesce(ads.num_or_null(c ->> 'sales7d'), 0) > 0
                       then round(100.0 * coalesce(ads.num_or_null(c ->> 'cost'), 0)
                                  / nullif(ads.num_or_null(c ->> 'sales7d'), 0), 4) end),
         coalesce(ads.num_or_null(c ->> 'roas7d'),
                  case when coalesce(ads.num_or_null(c ->> 'cost'), 0) > 0
                       then round(coalesce(ads.num_or_null(c ->> 'sales7d'), 0)
                                  / nullif(ads.num_or_null(c ->> 'cost'), 0), 4) end),
         c ->> 'reportId',
         coalesce(c ->> 'source', 'report'),
         now()
  from jsonb_array_elements(v_clean) c
  on conflict (seller_account_id, day, campaign_id) do update set
    ads_profile_id  = coalesce(nullif(excluded.ads_profile_id, ''), t.ads_profile_id),
    campaign_name   = coalesce(excluded.campaign_name, t.campaign_name),
    campaign_type   = coalesce(nullif(excluded.campaign_type, ''), t.campaign_type),
    campaign_status = coalesce(excluded.campaign_status, t.campaign_status),
    currency        = coalesce(nullif(excluded.currency, ''), t.currency),
    budget_amount   = coalesce(excluded.budget_amount, t.budget_amount),
    impressions     = excluded.impressions,
    clicks          = excluded.clicks,
    spend           = excluded.spend,
    sales           = excluded.sales,
    orders          = excluded.orders,
    sales1d         = excluded.sales1d,
    sales7d         = excluded.sales7d,
    sales14d        = excluded.sales14d,
    sales30d        = excluded.sales30d,
    purchases1d     = excluded.purchases1d,
    purchases7d     = excluded.purchases7d,
    purchases14d    = excluded.purchases14d,
    purchases30d    = excluded.purchases30d,
    units_sold7d    = excluded.units_sold7d,
    ctr             = excluded.ctr,
    cpc             = excluded.cpc,
    acos7d          = excluded.acos7d,
    roas7d          = excluded.roas7d,
    report_id       = coalesce(excluded.report_id, t.report_id),
    source          = excluded.source,
    imported_at     = now();

  inserted   := greatest(v_valid - v_exists, 0);
  updated    := least(v_exists, v_valid);
  skipped    := coalesce(v_bad, 0);
  days       := coalesce(v_days, 0);
  currencies := coalesce(v_curr, '');
  merged     := greatest(v_total - coalesce(v_bad, 0) - v_valid, 0);
  return next;
end;
$$;

comment on function public.vexim_worker_upsert_ads_metrics(uuid, jsonb) is
  'Nhập metrics ngày × campaign (Reporting v3 spCampaigns, timeUnit=DAILY). '
  'Ghi ĐÈ theo (shop, ngày, campaign) — nhập lại cùng khoảng ngày KHÔNG nhân đôi. '
  'ACOS/ROAS/CTR/CPC: Amazon không trả thì tự tính, chia 0 → NULL. '
  'KHÔNG trả tổng tiền: nhiều currency thì cộng là vô nghĩa (xem cột currencies).';

revoke all on function public.vexim_worker_upsert_ads_metrics(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.vexim_worker_upsert_ads_metrics(uuid, jsonb) to service_role;

-- ----------------------------------------------------------------------------
-- B14. RPC — nhập targeting (reportTypeId=spTargeting, groupBy=targeting)
-- ----------------------------------------------------------------------------
create or replace function public.vexim_worker_upsert_ads_targeting(
  p_seller uuid,
  p_rows   jsonb
)
returns table (rows_written int, skipped int, days int, merged int)
language plpgsql
security definer
set search_path = ads, public, pg_catalog
as $$
  -- `use_column`: hàm returns table(...) nên tên cột OUT (id, status, service, days…)
  -- trùng tên cột thật → trong MỌI biểu thức SQL, tên trùng được hiểu là CỘT.
  -- (Biến nội bộ đều có tiền tố v_/p_ nên không bị đổi nghĩa; thiếu dòng này thì
  -- on conflict (…, service) nổ "column reference service is ambiguous" lúc chạy.)
  #variable_conflict use_column
declare
  v_total int := 0;
  v_valid int := 0;
  v_days  int := 0;
  v_bad   int := 0;
begin
  if auth.uid() is not null then
    raise exception '[ADS] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_seller is null then
    raise exception '[ADS] thiếu seller_account_id' using errcode = 'invalid_parameter_value';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '[ADS] p_rows phải là JSON array (nhận %)',
      coalesce(jsonb_typeof(p_rows), 'NULL') using errcode = 'invalid_parameter_value';
  end if;

  v_total := jsonb_array_length(p_rows);

  -- Rác: thiếu ngày, thiếu campaign, hoặc không có khoá nào (keywordId /
  -- targetingExpression / keywordText) → không biết dòng này của target nào.
  select count(*) into v_bad
  from jsonb_array_elements(p_rows) r
  where ads.date_or_null(coalesce(r ->> 'date', r ->> 'day')) is null
     or btrim(coalesce(r ->> 'campaignId', '')) = ''
     or (btrim(coalesce(r ->> 'keywordId', r ->> 'targetingId', '')) = ''
         and btrim(coalesce(r ->> 'targetingExpression', '')) = ''
         and btrim(coalesce(r ->> 'keywordText', r ->> 'keyword', '')) = '');

  with norm as (
    select
      ads.date_or_null(coalesce(r ->> 'date', r ->> 'day'))            as day,
      btrim(coalesce(r ->> 'campaignId', ''))                          as campaign_id,
      btrim(coalesce(r ->> 'adGroupId', ''))                           as ad_group_id,
      btrim(coalesce(r ->> 'keywordId', r ->> 'targetingId', ''))      as keyword_id,
      nullif(btrim(coalesce(r ->> 'targetingExpression', '')), '')     as expression,
      nullif(btrim(coalesce(r ->> 'keywordText', r ->> 'keyword', '')), '') as keyword_text,
      nullif(upper(btrim(coalesce(r ->> 'matchType', ''))), '')        as match_type,
      nullif(upper(btrim(coalesce(r ->> 'keywordType', ''))), '')      as keyword_type,
      btrim(coalesce(r ->> 'adsProfileId', r ->> 'profileId', ''))      as profile_id,
      nullif(btrim(coalesce(r ->> 'campaignName', '')), '')            as campaign_name,
      nullif(btrim(coalesce(r ->> 'adGroupName', '')), '')             as ad_group_name,
      ads.num_or_null(r ->> 'keywordBid')                              as bid,
      coalesce(ads.num_or_null(r ->> 'impressions'), 0)::int           as impressions,
      coalesce(ads.num_or_null(r ->> 'clicks'), 0)::int                as clicks,
      coalesce(ads.num_or_null(r ->> 'cost'), 0)                       as cost,
      ads.num_or_null(coalesce(r ->> 'sales7d', r ->> 'attributedSales7d'))                                 as sales7d,
      ads.num_or_null(coalesce(r ->> 'purchases7d', r ->> 'attributedConversions7d'))::int                        as purchases7d,
      ads.num_or_null(coalesce(r ->> 'unitsSold7d', r ->> 'unitsSoldClicks7d'))::int as units_sold7d,
      ads.num_or_null(r ->> 'acosClicks7d')                            as acos7d,
      ads.num_or_null(r ->> 'roasClicks7d')                            as roas7d,
      coalesce(nullif(upper(btrim(coalesce(r ->> 'currency', r ->> 'currencyCode',
                                         r ->> 'campaignBudgetCurrencyCode', ''))), ''), 'USD') as currency,
      nullif(btrim(coalesce(r ->> 'reportId', '')), '')                as report_id
    from jsonb_array_elements(p_rows) r
  ),
  keyed as (
    select n.*,
           -- Khoá: ưu tiên keywordId/targetingId; không có thì hash của expression
           -- (targeting ASIN/category không có keywordId). Rỗng cả hai → bỏ dòng.
           coalesce(nullif(n.keyword_id, ''),
                    nullif(md5(coalesce(n.expression, '') || '|' || coalesce(n.keyword_text, '')), ''),
                    '') as targeting_key
    from norm n
    where n.day is not null and n.campaign_id <> ''
      and (n.keyword_id <> '' or coalesce(n.expression, '') <> '' or coalesce(n.keyword_text, '') <> '')
  ),
  agg as (
    select k.day, k.campaign_id, k.ad_group_id, k.targeting_key,
           max(k.keyword_id) as keyword_id, max(k.expression) as expression,
           max(k.keyword_text) as keyword_text, max(k.match_type) as match_type,
           max(k.keyword_type) as keyword_type, max(k.profile_id) as profile_id,
           max(k.campaign_name) as campaign_name, max(k.ad_group_name) as ad_group_name,
           max(k.bid) as bid, max(k.impressions) as impressions, max(k.clicks) as clicks,
           max(k.cost) as cost, max(k.sales7d) as sales7d, max(k.purchases7d) as purchases7d,
           max(k.units_sold7d) as units_sold7d, max(k.acos7d) as acos7d, max(k.roas7d) as roas7d,
           max(k.currency) as currency, max(k.report_id) as report_id
    from keyed k
    group by 1, 2, 3, 4
  )
  insert into ads.targeting_metrics_daily as t (
    seller_account_id, day, ads_profile_id, campaign_id, campaign_name,
    ad_group_id, ad_group_name, targeting_key, keyword_id, keyword_text,
    match_type, keyword_type, targeting_expression, bid,
    impressions, clicks, cost, sales7d, purchases7d, units_sold7d,
    acos7d, roas7d, currency, report_id, imported_at
  )
  select p_seller, a.day, coalesce(a.profile_id, ''), a.campaign_id, a.campaign_name,
         coalesce(a.ad_group_id, ''), a.ad_group_name, a.targeting_key, a.keyword_id,
         a.keyword_text, a.match_type, a.keyword_type, a.expression, a.bid,
         a.impressions, a.clicks, a.cost, a.sales7d, a.purchases7d, a.units_sold7d,
         coalesce(a.acos7d, case when coalesce(a.sales7d, 0) > 0
                                 then round(100.0 * a.cost / nullif(a.sales7d, 0), 4) end),
         coalesce(a.roas7d, case when a.cost > 0
                                 then round(coalesce(a.sales7d, 0) / nullif(a.cost, 0), 4) end),
         a.currency, a.report_id, now()
  from agg a
  on conflict (seller_account_id, day, campaign_id, ad_group_id, targeting_key) do update set
    ads_profile_id       = coalesce(nullif(excluded.ads_profile_id, ''), t.ads_profile_id),
    campaign_name        = coalesce(excluded.campaign_name, t.campaign_name),
    ad_group_name        = coalesce(excluded.ad_group_name, t.ad_group_name),
    keyword_id           = coalesce(excluded.keyword_id, t.keyword_id),
    keyword_text         = coalesce(excluded.keyword_text, t.keyword_text),
    match_type           = coalesce(excluded.match_type, t.match_type),
    keyword_type         = coalesce(excluded.keyword_type, t.keyword_type),
    targeting_expression = coalesce(excluded.targeting_expression, t.targeting_expression),
    bid                  = coalesce(excluded.bid, t.bid),
    impressions          = excluded.impressions,
    clicks               = excluded.clicks,
    cost                 = excluded.cost,
    sales7d              = excluded.sales7d,
    purchases7d          = excluded.purchases7d,
    units_sold7d         = excluded.units_sold7d,
    acos7d               = excluded.acos7d,
    roas7d               = excluded.roas7d,
    currency             = excluded.currency,
    report_id            = coalesce(excluded.report_id, t.report_id),
    imported_at          = now();

  get diagnostics v_valid = row_count;

  select count(distinct a.day) into v_days
  from jsonb_array_elements(p_rows) r
  cross join lateral (select ads.date_or_null(coalesce(r ->> 'date', r ->> 'day')) as day) a
  where a.day is not null;

  rows_written := v_valid;
  skipped      := coalesce(v_bad, 0);
  days         := coalesce(v_days, 0);
  merged       := greatest(v_total - coalesce(v_bad, 0) - v_valid, 0);
  return next;
end;
$$;

comment on function public.vexim_worker_upsert_ads_targeting(uuid, jsonb) is
  'Nhập spTargeting (keyword/target). Khoá (shop, ngày, campaign, adGroup, targeting_key) '
  'với targeting_key = keywordId/targetingId hoặc md5(expression|keywordText).';

revoke all on function public.vexim_worker_upsert_ads_targeting(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.vexim_worker_upsert_ads_targeting(uuid, jsonb) to service_role;

-- ----------------------------------------------------------------------------
-- B15. RPC — nhập search terms (reportTypeId=spSearchTerm, groupBy=searchTerm)
-- ----------------------------------------------------------------------------
create or replace function public.vexim_worker_upsert_ads_search_terms(
  p_seller uuid,
  p_rows   jsonb
)
returns table (rows_written int, skipped int, days int, terms int, merged int)
language plpgsql
security definer
set search_path = ads, public, pg_catalog
as $$
  -- `use_column`: hàm returns table(...) nên tên cột OUT (id, status, service, days…)
  -- trùng tên cột thật → trong MỌI biểu thức SQL, tên trùng được hiểu là CỘT.
  -- (Biến nội bộ đều có tiền tố v_/p_ nên không bị đổi nghĩa; thiếu dòng này thì
  -- on conflict (…, service) nổ "column reference service is ambiguous" lúc chạy.)
  #variable_conflict use_column
declare
  v_total int := 0;
  v_valid int := 0;
  v_days  int := 0;
  v_terms int := 0;
  v_bad   int := 0;
begin
  if auth.uid() is not null then
    raise exception '[ADS] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_seller is null then
    raise exception '[ADS] thiếu seller_account_id' using errcode = 'invalid_parameter_value';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '[ADS] p_rows phải là JSON array (nhận %)',
      coalesce(jsonb_typeof(p_rows), 'NULL') using errcode = 'invalid_parameter_value';
  end if;

  v_total := jsonb_array_length(p_rows);

  -- Rác: thiếu ngày hoặc thiếu searchTerm. Lưu ý term = '*' KHÔNG phải rác
  -- (đó là placement không gắn từ khoá — bỏ đi là thiếu spend).
  select count(*) into v_bad
  from jsonb_array_elements(p_rows) r
  where ads.date_or_null(coalesce(r ->> 'date', r ->> 'day')) is null
     or btrim(coalesce(r ->> 'searchTerm', r ->> 'term', '')) = '';

  with norm as (
    select
      ads.date_or_null(coalesce(r ->> 'date', r ->> 'day'))            as day,
      -- Amazon trả term = "*" khi placement không gắn từ khoá (product page).
      -- GIỮ NGUYÊN "*" — đó là dữ liệu thật, không phải rác (bỏ đi sẽ thiếu spend).
      btrim(coalesce(r ->> 'searchTerm', r ->> 'term', ''))            as term,
      btrim(coalesce(r ->> 'campaignId', ''))                          as campaign_id,
      btrim(coalesce(r ->> 'adGroupId', ''))                           as ad_group_id,
      btrim(coalesce(r ->> 'keywordId', ''))                           as keyword_id,
      nullif(upper(btrim(coalesce(r ->> 'matchType', ''))), '')        as match_type,
      nullif(upper(btrim(coalesce(r ->> 'keywordType', ''))), '')      as keyword_type,
      nullif(btrim(coalesce(r ->> 'keywordText', r ->> 'keyword', '')), '') as keyword_text,
      nullif(btrim(coalesce(r ->> 'targeting', '')), '')               as targeting,
      nullif(upper(btrim(coalesce(r ->> 'adKeywordStatus', ''))), '')  as ad_keyword_status,
      btrim(coalesce(r ->> 'adsProfileId', r ->> 'profileId', ''))      as profile_id,
      nullif(btrim(coalesce(r ->> 'campaignName', '')), '')            as campaign_name,
      nullif(btrim(coalesce(r ->> 'adGroupName', '')), '')             as ad_group_name,
      ads.num_or_null(r ->> 'keywordBid')                              as bid,
      coalesce(ads.num_or_null(r ->> 'impressions'), 0)::int           as impressions,
      coalesce(ads.num_or_null(r ->> 'clicks'), 0)::int                as clicks,
      coalesce(ads.num_or_null(r ->> 'cost'), 0)                       as cost,
      ads.num_or_null(coalesce(r ->> 'sales7d', r ->> 'attributedSales7d'))                                 as sales7d,
      ads.num_or_null(coalesce(r ->> 'purchases7d', r ->> 'attributedConversions7d'))::int                        as purchases7d,
      ads.num_or_null(coalesce(r ->> 'unitsSold7d', r ->> 'unitsSoldClicks7d'))::int as units_sold7d,
      ads.num_or_null(r ->> 'acosClicks7d')                            as acos7d,
      ads.num_or_null(r ->> 'roasClicks7d')                            as roas7d,
      coalesce(nullif(upper(btrim(coalesce(r ->> 'currency', r ->> 'currencyCode',
                                         r ->> 'campaignBudgetCurrencyCode', ''))), ''), 'USD') as currency,
      nullif(btrim(coalesce(r ->> 'reportId', '')), '')                as report_id
    from jsonb_array_elements(p_rows) r
  ),
  agg as (
    select n.day, n.campaign_id, n.ad_group_id, n.term,
           coalesce(n.keyword_id, '') as keyword_id,
           coalesce(n.match_type, '') as match_type,
           max(n.keyword_type) as keyword_type, max(n.keyword_text) as keyword_text,
           max(n.targeting) as targeting, max(n.ad_keyword_status) as ad_keyword_status,
           max(n.profile_id) as profile_id, max(n.campaign_name) as campaign_name,
           max(n.ad_group_name) as ad_group_name, max(n.bid) as bid,
           max(n.impressions) as impressions, max(n.clicks) as clicks, max(n.cost) as cost,
           max(n.sales7d) as sales7d, max(n.purchases7d) as purchases7d,
           max(n.units_sold7d) as units_sold7d, max(n.acos7d) as acos7d, max(n.roas7d) as roas7d,
           max(n.currency) as currency, max(n.report_id) as report_id
    from norm n
    where n.day is not null and n.term <> ''
    group by 1, 2, 3, 4, 5, 6
  )
  insert into ads.search_terms as t (
    seller_account_id, day, term, match_type, impressions, clicks, spend, sales,
    ads_profile_id, campaign_id, campaign_name, ad_group_id, ad_group_name,
    keyword_id, keyword_text, keyword_type, targeting, bid, ad_keyword_status,
    currency, sales7d, purchases7d, units_sold7d, acos7d, roas7d, report_id, imported_at
  )
  select p_seller, a.day, a.term, a.match_type, a.impressions, a.clicks, a.cost,
         coalesce(a.sales7d, 0),
         coalesce(a.profile_id, ''), a.campaign_id, a.campaign_name,
         coalesce(a.ad_group_id, ''), a.ad_group_name,
         nullif(a.keyword_id, ''), a.keyword_text, a.keyword_type, a.targeting, a.bid,
         a.ad_keyword_status, a.currency, a.sales7d, a.purchases7d, a.units_sold7d,
         coalesce(a.acos7d, case when coalesce(a.sales7d, 0) > 0
                                 then round(100.0 * a.cost / nullif(a.sales7d, 0), 4) end),
         coalesce(a.roas7d, case when a.cost > 0
                                 then round(coalesce(a.sales7d, 0) / nullif(a.cost, 0), 4) end),
         a.report_id, now()
  from agg a
  on conflict (seller_account_id, day, campaign_id, ad_group_id, term,
               coalesce(keyword_id, ''), coalesce(match_type, '')) do update set
    impressions       = excluded.impressions,
    clicks            = excluded.clicks,
    spend             = excluded.spend,
    sales             = excluded.sales,
    ads_profile_id    = coalesce(nullif(excluded.ads_profile_id, ''), t.ads_profile_id),
    campaign_name     = coalesce(excluded.campaign_name, t.campaign_name),
    ad_group_name     = coalesce(excluded.ad_group_name, t.ad_group_name),
    keyword_text      = coalesce(excluded.keyword_text, t.keyword_text),
    keyword_type      = coalesce(excluded.keyword_type, t.keyword_type),
    targeting         = coalesce(excluded.targeting, t.targeting),
    bid               = coalesce(excluded.bid, t.bid),
    ad_keyword_status = coalesce(excluded.ad_keyword_status, t.ad_keyword_status),
    currency          = excluded.currency,
    sales7d           = excluded.sales7d,
    purchases7d       = excluded.purchases7d,
    units_sold7d      = excluded.units_sold7d,
    acos7d            = excluded.acos7d,
    roas7d            = excluded.roas7d,
    report_id         = coalesce(excluded.report_id, t.report_id),
    imported_at       = now();

  get diagnostics v_valid = row_count;

  select count(distinct d.day), count(distinct d.term) into v_days, v_terms
  from (select ads.date_or_null(coalesce(r ->> 'date', r ->> 'day')) as day,
               btrim(coalesce(r ->> 'searchTerm', r ->> 'term', '')) as term
        from jsonb_array_elements(p_rows) r) d
  where d.day is not null and d.term <> '';

  rows_written := v_valid;
  skipped      := coalesce(v_bad, 0);
  days         := coalesce(v_days, 0);
  terms        := coalesce(v_terms, 0);
  merged       := greatest(v_total - coalesce(v_bad, 0) - v_valid, 0);
  return next;
end;
$$;

comment on function public.vexim_worker_upsert_ads_search_terms(uuid, jsonb) is
  'Nhập spSearchTerm. Giữ term="*" (placement không gắn từ khoá — bỏ đi là thiếu spend). '
  'Khoá (shop, ngày, campaign, adGroup, term, keywordId, matchType).';

revoke all on function public.vexim_worker_upsert_ads_search_terms(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.vexim_worker_upsert_ads_search_terms(uuid, jsonb) to service_role;

-- ----------------------------------------------------------------------------
-- B16. RPC — nhập spend theo sản phẩm quảng cáo (spAdvertisedProduct) → nguồn F4
-- ----------------------------------------------------------------------------
create or replace function public.vexim_worker_upsert_ads_advertised(
  p_seller uuid,
  p_rows   jsonb
)
returns table (rows_written int, skipped int, days int, merged int)
language plpgsql
security definer
set search_path = ads, public, pg_catalog
as $$
  -- `use_column`: hàm returns table(...) nên tên cột OUT (id, status, service, days…)
  -- trùng tên cột thật → trong MỌI biểu thức SQL, tên trùng được hiểu là CỘT.
  -- (Biến nội bộ đều có tiền tố v_/p_ nên không bị đổi nghĩa; thiếu dòng này thì
  -- on conflict (…, service) nổ "column reference service is ambiguous" lúc chạy.)
  #variable_conflict use_column
declare
  v_total int := 0;
  v_valid int := 0;
  v_days  int := 0;
  v_bad   int := 0;
begin
  if auth.uid() is not null then
    raise exception '[ADS] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_seller is null then
    raise exception '[ADS] thiếu seller_account_id' using errcode = 'invalid_parameter_value';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '[ADS] p_rows phải là JSON array (nhận %)',
      coalesce(jsonb_typeof(p_rows), 'NULL') using errcode = 'invalid_parameter_value';
  end if;

  v_total := jsonb_array_length(p_rows);

  -- Rác: thiếu ngày, hoặc không có cả ASIN lẫn SKU → không quy được spend cho
  -- sản phẩm nào thì KHÔNG GHI (ghi vào "SKU rỗng" sẽ làm F4 sai âm thầm).
  select count(*) into v_bad
  from jsonb_array_elements(p_rows) r
  where ads.date_or_null(coalesce(r ->> 'date', r ->> 'day')) is null
     or (upper(btrim(coalesce(r ->> 'advertisedAsin', r ->> 'asin', ''))) = ''
         and upper(btrim(coalesce(r ->> 'advertisedSku', r ->> 'sku', ''))) = '');

  with agg as (
    select
      ads.date_or_null(coalesce(r ->> 'date', r ->> 'day'))            as day,
      btrim(coalesce(r ->> 'campaignId', ''))                          as campaign_id,
      btrim(coalesce(r ->> 'adGroupId', ''))                           as ad_group_id,
      upper(btrim(coalesce(r ->> 'advertisedAsin', r ->> 'asin', ''))) as asin,
      upper(btrim(coalesce(r ->> 'advertisedSku', r ->> 'sku', '')))   as sku,
      max(btrim(coalesce(r ->> 'adsProfileId', r ->> 'profileId', ''))) as profile_id,
      max(coalesce(ads.num_or_null(r ->> 'impressions'), 0)::int)      as impressions,
      max(coalesce(ads.num_or_null(r ->> 'clicks'), 0)::int)           as clicks,
      max(coalesce(ads.num_or_null(r ->> 'cost'), 0))                  as cost,
      max(ads.num_or_null(coalesce(r ->> 'sales7d', r ->> 'attributedSales7d')))                            as sales7d,
      max(ads.num_or_null(coalesce(r ->> 'purchases7d', r ->> 'attributedConversions7d'))::int)                   as purchases7d,
      max(ads.num_or_null(coalesce(r ->> 'unitsSold7d', r ->> 'unitsSoldClicks7d'))::int) as units_sold7d,
      max(coalesce(nullif(upper(btrim(coalesce(r ->> 'currency', r ->> 'currencyCode',
                                         r ->> 'campaignBudgetCurrencyCode', ''))), ''), 'USD')) as currency,
      max(nullif(btrim(coalesce(r ->> 'reportId', '')), ''))           as report_id
    from jsonb_array_elements(p_rows) r
    where ads.date_or_null(coalesce(r ->> 'date', r ->> 'day')) is not null
      and (upper(btrim(coalesce(r ->> 'advertisedAsin', r ->> 'asin', ''))) <> ''
        or upper(btrim(coalesce(r ->> 'advertisedSku', r ->> 'sku', ''))) <> '')
    group by 1, 2, 3, 4, 5
  )
  insert into ads.advertised_product_daily as t (
    seller_account_id, day, ads_profile_id, campaign_id, ad_group_id,
    advertised_asin, advertised_sku, impressions, clicks, cost,
    sales7d, purchases7d, units_sold7d, currency, report_id, imported_at
  )
  select p_seller, a.day, coalesce(a.profile_id, ''), coalesce(a.campaign_id, ''),
         coalesce(a.ad_group_id, ''), a.asin, a.sku, a.impressions, a.clicks, a.cost,
         a.sales7d, a.purchases7d, a.units_sold7d, a.currency, a.report_id, now()
  from agg a
  on conflict (seller_account_id, day, campaign_id, ad_group_id, advertised_asin, advertised_sku)
  do update set
    ads_profile_id = coalesce(nullif(excluded.ads_profile_id, ''), t.ads_profile_id),
    impressions    = excluded.impressions,
    clicks         = excluded.clicks,
    cost           = excluded.cost,
    sales7d        = excluded.sales7d,
    purchases7d    = excluded.purchases7d,
    units_sold7d   = excluded.units_sold7d,
    currency       = excluded.currency,
    report_id      = coalesce(excluded.report_id, t.report_id),
    imported_at    = now();

  get diagnostics v_valid = row_count;

  select count(distinct ads.date_or_null(coalesce(r ->> 'date', r ->> 'day')))
    into v_days
  from jsonb_array_elements(p_rows) r;

  rows_written := v_valid;
  skipped      := coalesce(v_bad, 0);
  days         := coalesce(v_days, 0);
  merged       := greatest(v_total - coalesce(v_bad, 0) - v_valid, 0);
  return next;
end;
$$;

comment on function public.vexim_worker_upsert_ads_advertised(uuid, jsonb) is
  'Nhập spAdvertisedProduct (spend theo ASIN/SKU được quảng cáo) — nguồn THẬT của '
  'finance.sku_profit_daily.ads_spend (F4). Không có ASIN cũng không có SKU → bỏ dòng.';

revoke all on function public.vexim_worker_upsert_ads_advertised(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.vexim_worker_upsert_ads_advertised(uuid, jsonb) to service_role;

-- ----------------------------------------------------------------------------
-- B17. RPC — nhập budget usage (% ngân sách đã dùng, chụp theo giờ)
-- ----------------------------------------------------------------------------
create or replace function public.vexim_worker_upsert_ads_budget_usage(
  p_seller uuid,
  p_rows   jsonb
)
returns table (rows_written int, skipped int, exhausted int, merged int)
language plpgsql
security definer
set search_path = ads, public, pg_catalog
as $$
  -- `use_column`: hàm returns table(...) nên tên cột OUT (id, status, service, days…)
  -- trùng tên cột thật → trong MỌI biểu thức SQL, tên trùng được hiểu là CỘT.
  -- (Biến nội bộ đều có tiền tố v_/p_ nên không bị đổi nghĩa; thiếu dòng này thì
  -- on conflict (…, service) nổ "column reference service is ambiguous" lúc chạy.)
  #variable_conflict use_column
declare
  v_total     int := 0;
  v_valid     int := 0;
  v_exhausted int := 0;
  v_bad       int := 0;
begin
  if auth.uid() is not null then
    raise exception '[ADS] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_seller is null then
    raise exception '[ADS] thiếu seller_account_id' using errcode = 'invalid_parameter_value';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '[ADS] p_rows phải là JSON array (nhận %)',
      coalesce(jsonb_typeof(p_rows), 'NULL') using errcode = 'invalid_parameter_value';
  end if;

  v_total := jsonb_array_length(p_rows);

  select count(*) into v_bad
  from jsonb_array_elements(p_rows) r
  where ads.date_or_null(coalesce(r ->> 'date', r ->> 'day')) is null
     or btrim(coalesce(r ->> 'campaignId', '')) = '';

  with norm as (
    select
      ads.date_or_null(coalesce(r ->> 'date', r ->> 'day'))            as day,
      btrim(coalesce(r ->> 'campaignId', ''))                          as campaign_id,
      nullif(btrim(coalesce(r ->> 'campaignName', '')), '')            as campaign_name,
      btrim(coalesce(r ->> 'adsProfileId', r ->> 'profileId', ''))      as profile_id,
      upper(btrim(coalesce(r ->> 'budgetType', 'DAILY')))              as budget_type,
      ads.num_or_null(coalesce(r ->> 'budget', r ->> 'campaignBudget')) as budget,
      ads.num_or_null(r ->> 'spend')                                   as spend,
      ads.num_or_null(coalesce(r ->> 'percentageUsed', r ->> 'budgetUsagePercent')) as pct,
      ads.num_or_null(r ->> 'deliveredClicks')::int                    as clicks,
      ads.num_or_null(r ->> 'deliveredImpressions')::int               as impressions,
      coalesce(nullif(upper(btrim(coalesce(r ->> 'currency', r ->> 'currencyCode',
                                         r ->> 'campaignBudgetCurrencyCode', ''))), ''), 'USD') as currency,
      coalesce(nullif(btrim(coalesce(r ->> 'capturedAt', '')), '')::timestamptz, now()) as captured_at,
      coalesce(nullif(btrim(coalesce(r ->> 'source', '')), ''), 'budget_usage_api')     as src
    from jsonb_array_elements(p_rows) r
  )
  , one_per_hour as (
    -- Cùng một GIỜ chỉ giữ lần chụp MUỘN NHẤT (khoá của unique index).
    select distinct on (n.day, n.campaign_id, ads.hour_bucket(n.captured_at)) n.*
    from norm n
    where n.day is not null and n.campaign_id <> ''
    order by n.day, n.campaign_id, ads.hour_bucket(n.captured_at), n.captured_at desc
  )
  insert into ads.budget_usage as t (
    seller_account_id, ads_profile_id, day, campaign_id, campaign_name, budget_type,
    budget, spend, percentage_used, delivered_clicks, delivered_impressions,
    currency, captured_at, source
  )
  select p_seller, coalesce(h.profile_id, ''), h.day, h.campaign_id, h.campaign_name,
         h.budget_type, h.budget, h.spend, h.pct, h.clicks, h.impressions,
         h.currency, h.captured_at, h.src
  from one_per_hour h
  on conflict (seller_account_id, campaign_id, day, ads.hour_bucket(captured_at))
  do update set
    ads_profile_id        = coalesce(nullif(excluded.ads_profile_id, ''), t.ads_profile_id),
    campaign_name         = coalesce(excluded.campaign_name, t.campaign_name),
    budget_type           = excluded.budget_type,
    budget                = coalesce(excluded.budget, t.budget),
    spend                 = coalesce(excluded.spend, t.spend),
    percentage_used       = coalesce(excluded.percentage_used, t.percentage_used),
    delivered_clicks      = coalesce(excluded.delivered_clicks, t.delivered_clicks),
    delivered_impressions = coalesce(excluded.delivered_impressions, t.delivered_impressions),
    currency              = excluded.currency,
    captured_at           = excluded.captured_at,
    source                = excluded.source;

  get diagnostics v_valid = row_count;

  -- "Đã cạn" tính trên NGÀY DỮ LIỆU MỚI NHẤT của shop, không phải current_date:
  -- cron chạy bù sáng hôm sau cho ngày hôm qua mà so với current_date thì luôn = 0.
  select count(*) into v_exhausted
  from ads.budget_usage b
  where b.seller_account_id = p_seller
    and b.day = (select max(b2.day) from ads.budget_usage b2
                  where b2.seller_account_id = p_seller)
    and b.percentage_used >= 100;

  rows_written := v_valid;
  skipped      := coalesce(v_bad, 0);
  exhausted    := coalesce(v_exhausted, 0);
  merged       := greatest(v_total - coalesce(v_bad, 0) - v_valid, 0);
  return next;
end;
$$;

comment on function public.vexim_worker_upsert_ads_budget_usage(uuid, jsonb) is
  'Nhập Budget Usage (POST /sp/budgets/budgetUsage). Khoá theo GIỜ của captured_at → '
  'chạy nhiều lần trong một giờ thì cập nhật, không phình bảng. '
  'exhausted = số campaign ĐÃ chạm 100% ngân sách hôm nay.';

revoke all on function public.vexim_worker_upsert_ads_budget_usage(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.vexim_worker_upsert_ads_budget_usage(uuid, jsonb) to service_role;

-- ----------------------------------------------------------------------------
-- B18. RPC — ghi trạng thái report Ads (bất đồng bộ, cron nối tiếp được)
-- ----------------------------------------------------------------------------
create or replace function public.vexim_worker_set_ads_report_request(
  p_seller uuid,
  p_req    jsonb
)
returns table (id uuid, status text, ads_report_id text)
language plpgsql
security definer
set search_path = ads, public, pg_catalog
as $$
  -- `use_column`: hàm returns table(...) nên tên cột OUT (id, status, service, days…)
  -- trùng tên cột thật → trong MỌI biểu thức SQL, tên trùng được hiểu là CỘT.
  -- (Biến nội bộ đều có tiền tố v_/p_ nên không bị đổi nghĩa; thiếu dòng này thì
  -- on conflict (…, service) nổ "column reference service is ambiguous" lúc chạy.)
  #variable_conflict use_column
declare
  v_type   text;
  v_status text;
  v_group  text;
  v_unit   text;
  v_id     uuid;
  v_rid    text;
begin
  if auth.uid() is not null then
    raise exception '[ADS] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_seller is null or p_req is null then
    raise exception '[ADS] thiếu seller_account_id hoặc payload'
      using errcode = 'invalid_parameter_value';
  end if;

  v_type := btrim(coalesce(p_req ->> 'reportTypeId', ''));
  if v_type = '' then
    raise exception '[ADS] thiếu reportTypeId' using errcode = 'invalid_parameter_value';
  end if;

  v_group := btrim(coalesce(p_req ->> 'groupBy', ''));
  v_unit  := upper(btrim(coalesce(p_req ->> 'timeUnit', 'DAILY')));
  if v_unit not in ('SUMMARY','DAILY') then v_unit := 'DAILY'; end if;

  v_status := lower(btrim(coalesce(p_req ->> 'status', '')));
  -- Amazon trả PROCESSING/COMPLETED/FAILURE; trạng thái nội bộ thêm
  -- requested/imported/no_data/throttled/failed để cron biết phải làm gì tiếp.
  if v_status = 'completed' then v_status := 'completed';
  elsif v_status not in ('requested','processing','completed','failure',
                         'imported','no_data','throttled','failed') then
    v_status := 'failed';
  end if;

  v_rid := nullif(btrim(coalesce(p_req ->> 'adsReportId', p_req ->> 'reportId', '')), '');

  insert into ads.report_requests as t (
    seller_account_id, ads_profile_id, report_type_id, ad_product, group_by, time_unit,
    date_start, date_end, ads_report_id, status, failure_reason, download_url,
    rows_imported, attempts, last_error, requested_at, completed_at, imported_at, updated_at
  )
  values (
    p_seller,
    btrim(coalesce(p_req ->> 'adsProfileId', '')),
    v_type,
    upper(btrim(coalesce(p_req ->> 'adProduct', 'SPONSORED_PRODUCTS'))),
    v_group,
    v_unit,
    ads.date_or_null(p_req ->> 'dateStart'),
    ads.date_or_null(p_req ->> 'dateEnd'),
    v_rid,
    v_status,
    nullif(btrim(coalesce(p_req ->> 'failureReason', '')), ''),
    nullif(btrim(coalesce(p_req ->> 'downloadUrl', '')), ''),
    nullif(btrim(coalesce(p_req ->> 'rowsImported', '')), '')::int,
    coalesce(nullif(btrim(coalesce(p_req ->> 'attempts', '')), '')::int, 1),
    nullif(btrim(coalesce(p_req ->> 'lastError', '')), ''),
    coalesce(nullif(btrim(coalesce(p_req ->> 'requestedAt', '')), '')::timestamptz, now()),
    nullif(btrim(coalesce(p_req ->> 'completedAt', '')), '')::timestamptz,
    nullif(btrim(coalesce(p_req ->> 'importedAt', '')), '')::timestamptz,
    now()
  )
  on conflict (seller_account_id, ads_profile_id, report_type_id, group_by, time_unit,
               coalesce(date_start, date '1900-01-01'), coalesce(date_end, date '1900-01-01'))
  do update set
    ads_report_id  = coalesce(excluded.ads_report_id, t.ads_report_id),
    status         = excluded.status,
    failure_reason = coalesce(excluded.failure_reason, t.failure_reason),
    download_url   = coalesce(excluded.download_url, t.download_url),
    rows_imported  = coalesce(excluded.rows_imported, t.rows_imported),
    attempts       = t.attempts + 1,
    last_error     = excluded.last_error,
    requested_at   = coalesce(t.requested_at, excluded.requested_at),
    completed_at   = coalesce(excluded.completed_at, t.completed_at),
    imported_at    = coalesce(excluded.imported_at, t.imported_at),
    updated_at     = now()
  returning t.id, t.status, t.ads_report_id into v_id, v_status, v_rid;

  id            := v_id;
  status        := v_status;
  ads_report_id := v_rid;
  return next;
end;
$$;

comment on function public.vexim_worker_set_ads_report_request(uuid, jsonb) is
  'Ghi/cập nhật trạng thái một lần yêu cầu report Ads. Khoá (shop, profile, loại '
  'report, groupBy, timeUnit, khoảng ngày) → cron chạy lại POLL tiếp reportId cũ, '
  'không xin report mới (trần tốc độ Reporting Ads tính theo hàng đợi region).';

revoke all on function public.vexim_worker_set_ads_report_request(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.vexim_worker_set_ads_report_request(uuid, jsonb) to service_role;

-- ----------------------------------------------------------------------------
-- B19. RPC — đọc các report Ads đang chờ (cho cron lần sau poll tiếp)
-- ----------------------------------------------------------------------------
create or replace function public.vexim_worker_pending_ads_reports(
  p_seller   uuid default null,
  p_statuses text default 'requested,processing',
  p_limit    int  default 50
)
returns jsonb
language plpgsql
security definer
set search_path = ads, public, pg_catalog
as $$
declare
  v_out jsonb;
begin
  if auth.uid() is not null then
    raise exception '[ADS] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;

  select coalesce(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb) into v_out
  from (
    select r.seller_account_id,
           r.ads_profile_id,
           r.report_type_id,
           r.ad_product,
           r.group_by,
           r.time_unit,
           r.date_start,
           r.date_end,
           r.ads_report_id,
           r.status,
           r.attempts,
           r.last_error,
           r.requested_at,
           sa.marketplace
    from ads.report_requests r
    join connections.seller_accounts sa on sa.id = r.seller_account_id
    where (p_seller is null or r.seller_account_id = p_seller)
      and (p_statuses is null
           or r.status = any (string_to_array(replace(lower(p_statuses), ' ', ''), ',')))
      and r.ads_report_id is not null
    order by r.requested_at asc
    limit greatest(coalesce(p_limit, 50), 1)
  ) x;

  return coalesce(v_out, '[]'::jsonb);
end;
$$;

comment on function public.vexim_worker_pending_ads_reports(uuid, text, int) is
  'Danh sách report Ads đang chờ (mặc định requested,processing) để cron lần sau '
  'gọi GET /reporting/reports/{id} tiếp. Chỉ service_role.';

revoke all on function public.vexim_worker_pending_ads_reports(uuid, text, int) from public, anon, authenticated;
grant execute on function public.vexim_worker_pending_ads_reports(uuid, text, int) to service_role;

-- ----------------------------------------------------------------------------
-- B20. RPC — TỰ NỔ ALERT ACOS / BUDGET / SYNC STALE (chạy sau mỗi lần nhập)
-- ----------------------------------------------------------------------------
-- Vì sao nổ alert ở SQL chứ không ở worker:
--   • ngưỡng nằm sẵn trong ops.alert_rules (người vận hành đổi được, không cần deploy);
--   • cron chạy hụt (Vercel timeout) thì lần chạy sau vẫn nổ đúng, không mất alert;
--   • dedupe đi qua ops.raise_alert → MỘT luật duy nhất cho cả hệ.
-- ACOS cửa sổ 7 ngày = 100 × Σcost / Σsales7d (đúng cách console Amazon tính cho
-- một khoảng ngày: mỗi dòng ngày là sales quy đổi của click NGÀY ĐÓ trong 7 ngày).
create or replace function public.vexim_ads_raise_alerts(
  p_seller uuid default null,
  p_day    date default null
)
returns table (
  shop_id     uuid,
  shop_name   text,
  rule_code   text,
  entity_key  text,
  severity    text,
  metric      numeric,
  threshold   numeric,
  alert_id    uuid,
  next_action text
)
language plpgsql
security definer
set search_path = ads, ops, connections, public, pg_catalog
as $$
  -- `use_column`: hàm returns table(...) nên tên cột OUT (id, status, service, days…)
  -- trùng tên cột thật → trong MỌI biểu thức SQL, tên trùng được hiểu là CỘT.
  -- (Biến nội bộ đều có tiền tố v_/p_ nên không bị đổi nghĩa; thiếu dòng này thì
  -- on conflict (…, service) nổ "column reference service is ambiguous" lúc chạy.)
  #variable_conflict use_column
declare
  v_day        date := coalesce(p_day, current_date - 1);
  v_acos_thr   numeric;
  v_budget_thr numeric;
  v_stale_hrs  numeric;
  r            record;
  v_alert      uuid;
  v_closed     int;
begin
  if auth.uid() is not null then
    raise exception '[ADS] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;

  select threshold into v_acos_thr   from ops.alert_rules where rule_code = 'acos_over_target'   and is_active;
  select threshold into v_budget_thr from ops.alert_rules where rule_code = 'budget_exhausted'   and is_active;
  select threshold into v_stale_hrs  from ops.alert_rules where rule_code = 'ads_sync_stale'     and is_active;
  v_acos_thr   := coalesce(v_acos_thr, 25);
  v_budget_thr := coalesce(v_budget_thr, 100);
  v_stale_hrs  := coalesce(v_stale_hrs, 36);

  -- (1) ACOS 7 ngày vượt ngưỡng — chỉ xét campaign CÓ spend (0 spend thì ACOS vô nghĩa)
  for r in
    select m.seller_account_id as shop,
           sa.display_name     as shop_label,
           m.campaign_id       as cid,
           max(coalesce(c.name, m.campaign_name)) as cname,
           max(m.currency)     as curr,
           sum(m.spend)        as spend7,
           sum(coalesce(m.sales7d, m.sales, 0)) as sales7,
           case when sum(coalesce(m.sales7d, m.sales, 0)) > 0
                then round(100.0 * sum(m.spend) / sum(coalesce(m.sales7d, m.sales, 0)), 2)
           end as acos7
    from ads.ad_metrics_daily m
    join connections.seller_accounts sa on sa.id = m.seller_account_id
    left join ads.campaigns c
           on c.seller_account_id = m.seller_account_id and c.campaign_id = m.campaign_id
    where m.day between (v_day - 6) and v_day
      and (p_seller is null or m.seller_account_id = p_seller)
      and sa.status = 'active'
    group by m.seller_account_id, sa.display_name, m.campaign_id
    having sum(m.spend) > 0
  loop
    if r.acos7 is not null and r.acos7 > v_acos_thr then
      v_alert := ops.raise_alert(
        r.shop, 'acos_over_target', 'campaign:' || r.cid, 'amber',
        -- format() của Postgres KHÔNG có %.1f (chỉ %s/%I/%L/%%) → làm tròn trước.
        format('ACOS 7 ngày %s%% — campaign %s', round(r.acos7, 1)::text,
               coalesce(nullif(r.cname, ''), r.cid)),
        format('Cửa sổ %s → %s: spend %s %s, doanh thu ads 7 ngày %s %s, ACOS %s%% '
               '(ngưỡng %s%%). SOP-04: giảm bid / thêm negative trước khi tăng ngân sách.',
               to_char(v_day - 6, 'YYYY-MM-DD'), to_char(v_day, 'YYYY-MM-DD'),
               round(r.spend7, 2)::text, r.curr, round(r.sales7, 2)::text, r.curr,
               round(r.acos7, 2)::text, round(v_acos_thr)::text),
        null);
      shop_id    := r.shop;   shop_name  := r.shop_label;
      rule_code  := 'acos_over_target';
      entity_key := 'campaign:' || r.cid;
      severity   := 'amber';
      metric     := r.acos7;  threshold  := v_acos_thr;
      alert_id   := v_alert;  next_action := 'review_bid_or_negative';
      return next;
    else
      -- Về dưới ngưỡng → đóng alert cũ (không để chuông reo mãi).
      v_closed := ops.resolve_alert(r.shop, 'acos_over_target', 'campaign:' || r.cid);
      if v_closed > 0 then
        shop_id    := r.shop;   shop_name := r.shop_label;
        rule_code  := 'acos_over_target';
        entity_key := 'campaign:' || r.cid;
        severity   := 'green';
        metric     := r.acos7;  threshold := v_acos_thr;
        alert_id   := null;     next_action := 'resolved';
        return next;
      end if;
    end if;
  end loop;

  -- (2) Cạn ngân sách ngày — từ Budget Usage (percentageUsed) hoặc spend ≥ budget
  for r in
    select b.seller_account_id as shop,
           sa.display_name     as shop_label,
           b.campaign_id       as cid,
           max(coalesce(b.campaign_name, c.name)) as cname,
           max(b.currency)     as curr,
           max(b.budget)       as budget,
           max(b.spend)        as spend,
           max(b.percentage_used) as pct,
           max(b.day)          as d
    from ads.budget_usage b
    join connections.seller_accounts sa on sa.id = b.seller_account_id
    left join ads.campaigns c
           on c.seller_account_id = b.seller_account_id and c.campaign_id = b.campaign_id
    where b.day = v_day
      and (p_seller is null or b.seller_account_id = p_seller)
    group by b.seller_account_id, sa.display_name, b.campaign_id
  loop
    if coalesce(r.pct, 0) >= v_budget_thr
       or (r.budget is not null and r.budget > 0 and coalesce(r.spend, 0) >= r.budget) then
      v_alert := ops.raise_alert(
        r.shop, 'budget_exhausted', 'budget:' || r.cid, 'amber',
        format('Campaign %s cạn ngân sách ngày %s', coalesce(nullif(r.cname, ''), r.cid), to_char(r.d, 'DD/MM')),
        format('Đã dùng %s%% ngân sách (%s / %s %s) ngày %s. SOP-05: kiểm tra ACOS trước khi '
               'tăng ngân sách — campaign lãi thì tăng, lỗ thì hạ bid. '
               'Giờ cạn là ƯỚC LƯỢNG theo lần chụp gần nhất (xem vexim_ads_budget_usage).',
               coalesce(round(r.pct, 1)::text, '≥100'),
               coalesce(round(r.spend, 2)::text, '?'), coalesce(round(r.budget, 2)::text, '?'),
               r.curr, to_char(r.d, 'YYYY-MM-DD')),
        null);
      shop_id    := r.shop;   shop_name := r.shop_label;
      rule_code  := 'budget_exhausted';
      entity_key := 'budget:' || r.cid;
      severity   := 'amber';
      metric     := coalesce(r.pct, 100); threshold := v_budget_thr;
      alert_id   := v_alert;  next_action := 'review_budget';
      return next;
    else
      v_closed := ops.resolve_alert(r.shop, 'budget_exhausted', 'budget:' || r.cid);
      if v_closed > 0 then
        shop_id    := r.shop;   shop_name := r.shop_label;
        rule_code  := 'budget_exhausted';
        entity_key := 'budget:' || r.cid;
        severity   := 'green';
        metric     := r.pct;    threshold := v_budget_thr;
        alert_id   := null;     next_action := 'resolved';
        return next;
      end if;
    end if;
  end loop;

  -- (3) Dữ liệu Ads cũ hơn ngưỡng → nói thẳng là cron không chạy được
  for r in
    select sa.id as shop, sa.display_name as shop_label,
           max(m.day) as last_day,
           round(extract(epoch from (now() - max(m.imported_at))) / 3600.0, 1) as age_hours
    from connections.seller_accounts sa
    join ads.ad_profiles p on p.seller_account_id = sa.id
    left join ads.ad_metrics_daily m on m.seller_account_id = sa.id
    where sa.status = 'active' and sa.data_source = 'production'
      and (p_seller is null or sa.id = p_seller)
    group by sa.id, sa.display_name
  loop
    if r.last_day is null then
      v_alert := ops.raise_alert(
        r.shop, 'ads_sync_stale', 'ads_sync', 'amber',
        format('Chưa có metrics quảng cáo nào — shop %s', r.shop_label),
        'Đã có profile Ads nhưng ads.ad_metrics_daily trống. Kiểm tra cron /api/cron/ads-sync '
        'và trạng thái report trong vexim_ads_report_requests.', null);
      shop_id := r.shop; shop_name := r.shop_label; rule_code := 'ads_sync_stale';
      entity_key := 'ads_sync'; severity := 'amber';
      metric := null; threshold := v_stale_hrs; alert_id := v_alert;
      next_action := 'check_cron';
      return next;
    elsif coalesce(r.age_hours, 0) >= v_stale_hrs then
      v_alert := ops.raise_alert(
        r.shop, 'ads_sync_stale', 'ads_sync', 'amber',
        format('Dữ liệu quảng cáo cũ %s giờ — shop %s', r.age_hours::text, r.shop_label),
        format('Lần nhập gần nhất %s (ngày dữ liệu cuối %s), ngưỡng %s giờ. '
               'Số ACOS/TACOS trên dashboard là số CŨ — đừng ra quyết định theo đó.',
               to_char(now() - (r.age_hours || ' hours')::interval, 'YYYY-MM-DD HH24:MI'),
               to_char(r.last_day, 'YYYY-MM-DD'), v_stale_hrs::text), null);
      shop_id := r.shop; shop_name := r.shop_label; rule_code := 'ads_sync_stale';
      entity_key := 'ads_sync'; severity := 'amber';
      metric := r.age_hours; threshold := v_stale_hrs; alert_id := v_alert;
      next_action := 'check_cron';
      return next;
    else
      v_closed := ops.resolve_alert(r.shop, 'ads_sync_stale', 'ads_sync');
      if v_closed > 0 then
        shop_id := r.shop; shop_name := r.shop_label; rule_code := 'ads_sync_stale';
        entity_key := 'ads_sync'; severity := 'green';
        metric := r.age_hours; threshold := v_stale_hrs; alert_id := null;
        next_action := 'resolved';
        return next;
      end if;
    end if;
  end loop;
end;
$$;

comment on function public.vexim_ads_raise_alerts(uuid, date) is
  'Nổ/đóng alert PPC: acos_over_target (7 ngày), budget_exhausted (ngày p_day), '
  'ads_sync_stale (dữ liệu cũ hơn ngưỡng giờ). Ngưỡng đọc từ ops.alert_rules — '
  'đổi ngưỡng không cần deploy. Trả từng dòng để cron log được. Chỉ service_role.';

revoke all on function public.vexim_ads_raise_alerts(uuid, date) from public, anon, authenticated;
grant execute on function public.vexim_ads_raise_alerts(uuid, date) to service_role;

-- ----------------------------------------------------------------------------
-- B21. RPC — LẤP ads_spend THẬT VÀO F4 (finance.sku_profit_daily)
-- ----------------------------------------------------------------------------
-- 0015 để ads_spend = NULL vì chưa có Module 5. Giờ đã có spend theo ASIN/SKU:
-- khớp SKU theo 2 bậc (advertisedSku → ASIN qua catalog.listings) rồi cập nhật.
-- KHÔNG đụng gross_profit: theo thiết kế 0015, ads_spend là cột riêng (không trừ
-- vào lãi gộp) — TACOS/lãi ròng tính ở tầng view.
create or replace function public.vexim_worker_fill_profit_ads_spend(
  p_seller uuid,
  p_from   date default null,
  p_to     date default null
)
returns table (rows_updated int, days int, skus int, unmatched int, currencies text)
language plpgsql
security definer
set search_path = ads, finance, catalog, public, pg_catalog
as $$
  -- `use_column`: hàm returns table(...) nên tên cột OUT (id, status, service, days…)
  -- trùng tên cột thật → trong MỌI biểu thức SQL, tên trùng được hiểu là CỘT.
  -- (Biến nội bộ đều có tiền tố v_/p_ nên không bị đổi nghĩa; thiếu dòng này thì
  -- on conflict (…, service) nổ "column reference service is ambiguous" lúc chạy.)
  #variable_conflict use_column
declare
  v_from date := coalesce(p_from, current_date - 30);
  v_to   date := coalesce(p_to, current_date);
  v_upd  int  := 0;
  v_days int  := 0;
  v_skus int  := 0;
  v_unm  int  := 0;
  v_curr text;
begin
  if auth.uid() is not null then
    raise exception '[ADS] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_seller is null then
    raise exception '[ADS] thiếu seller_account_id' using errcode = 'invalid_parameter_value';
  end if;
  if v_from > v_to then
    raise exception '[ADS] khoảng ngày ngược: % > %', v_from, v_to
      using errcode = 'invalid_parameter_value';
  end if;

  -- Bảng tạm sống trong phiên; xoá trước khi nạp để gọi lại không cộng dồn.
  create temporary table if not exists tmp_ads_spend (
    sku text, day date, currency text, cost numeric
  );
  delete from tmp_ads_spend;

  insert into tmp_ads_spend (sku, day, currency, cost)
  select coalesce(nullif(ap.advertised_sku, ''), l.sku) as sku,
         ap.day,
         ap.currency,
         sum(ap.cost) as cost
  from ads.advertised_product_daily ap
  left join lateral (
    select li.sku
    from catalog.listings li
    where li.seller_account_id = ap.seller_account_id
      and upper(coalesce(li.asin, '')) = upper(ap.advertised_asin)
      and coalesce(ap.advertised_asin, '') <> ''
    order by li.last_synced_at desc nulls last, li.sku
    limit 1
  ) l on true
  where ap.seller_account_id = p_seller
    and ap.day between v_from and v_to
    -- Không suy được SKU (không có advertisedSku, ASIN chưa ánh xạ listing) thì
    -- KHÔNG GHI: thà để ads_spend NULL ("chưa biết") còn hơn gán nhầm cho SKU khác.
    and coalesce(nullif(ap.advertised_sku, ''), l.sku) is not null
  group by 1, 2, 3;

  update finance.sku_profit_daily t
     set ads_spend   = s.cost,
         computed_at = now()
  from tmp_ads_spend s
  where t.seller_account_id = p_seller
    and t.sku   = s.sku
    and t.day   = s.day
    and t.currency = s.currency;
  get diagnostics v_upd = row_count;

  select count(distinct s.day), count(distinct s.sku),
         (select string_agg(distinct s2.currency, ',') from tmp_ads_spend s2)
    into v_days, v_skus, v_curr
  from tmp_ads_spend s;

  -- Spend có mà F4 KHÔNG có dòng tương ứng → không âm thầm bỏ qua: đếm để worker
  -- log "chưa khớp" (thường do settlement chưa về, hoặc ASIN chưa ánh xạ SKU).
  select count(*) into v_unm
  from tmp_ads_spend s
  where not exists (select 1 from finance.sku_profit_daily t
                     where t.seller_account_id = p_seller
                       and t.sku = s.sku and t.day = s.day and t.currency = s.currency);

  rows_updated := v_upd;
  days         := coalesce(v_days, 0);
  skus         := coalesce(v_skus, 0);
  unmatched    := coalesce(v_unm, 0);
  currencies   := coalesce(v_curr, '');
  return next;
end;
$$;

comment on function public.vexim_worker_fill_profit_ads_spend(uuid, date, date) is
  'Lấp ads_spend vào finance.sku_profit_daily (F4) từ ads.advertised_product_daily. '
  'Khớp SKU: advertisedSku trước, không có thì ASIN → catalog.listings (mới nhất). '
  'unmatched = số dòng spend CHƯA có dòng lợi nhuận tương ứng (log ra, không bỏ qua). '
  'Không đổi gross_profit (ads_spend là cột riêng theo thiết kế 0015).';

revoke all on function public.vexim_worker_fill_profit_ads_spend(uuid, date, date) from public, anon, authenticated;
grant execute on function public.vexim_worker_fill_profit_ads_spend(uuid, date, date) to service_role;

-- ============================================================================
-- §C. VIEW CHO WEB (mọi view đều security_invoker → RLS bảng gốc vẫn áp:
--     user chỉ thấy shop mình được gán, đúng mô hình multi-tenant)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- C1. vexim_ads_profiles — profile Ads của shop (profileId = scope của mọi call)
-- ----------------------------------------------------------------------------
create or replace view public.vexim_ads_profiles
with (security_invoker = true) as
select
  p.seller_account_id,
  sa.display_name                     as shop,
  p.ads_profile_id,
  nullif(p.marketplace, '')           as marketplace,
  p.country_code,
  p.currency,
  p.timezone,
  p.account_id,
  p.account_type,
  p.account_name,
  p.daily_budget,
  p.is_default,
  p.source,
  p.first_seen_at,
  p.last_synced_at,
  (select count(*) from ads.campaigns c
    where c.seller_account_id = p.seller_account_id
      and c.ads_profile_id = p.ads_profile_id) as campaigns_known,
  (select max(m.day) from ads.ad_metrics_daily m
    where m.seller_account_id = p.seller_account_id) as last_metrics_day
from ads.ad_profiles p
join connections.seller_accounts sa on sa.id = p.seller_account_id;

comment on view public.vexim_ads_profiles is
  'Profile Amazon Ads (GET /v2/profiles). ads_profile_id là giá trị BẮT BUỘC của '
  'header Amazon-Advertising-API-Scope cho mọi call Ads của shop đó.';

-- ----------------------------------------------------------------------------
-- C2. vexim_ads_campaigns — A1: campaign + cấu hình + metrics 7 ngày + cờ cảnh báo
-- ----------------------------------------------------------------------------
create or replace view public.vexim_ads_campaigns
with (security_invoker = true) as
with win as (
  select m.seller_account_id, max(m.day) as last_day
  from ads.ad_metrics_daily m
  group by 1
),
w7 as (
  select m.seller_account_id, m.campaign_id,
         max(m.currency)                        as currency,
         sum(m.spend)                           as spend7,
         sum(coalesce(m.sales7d, m.sales, 0))   as sales7,
         sum(coalesce(m.orders, 0))             as orders7,
         sum(coalesce(m.units_sold7d, 0))       as units7,
         sum(m.impressions)                     as impressions7,
         sum(m.clicks)                          as clicks7,
         count(*)                               as days_with_data,
         max(m.day)                             as metrics_last_day
  from ads.ad_metrics_daily m
  join win w on w.seller_account_id = m.seller_account_id
  where m.day between w.last_day - 6 and w.last_day
  group by 1, 2
),
p7 as (
  select m.seller_account_id, m.campaign_id,
         sum(m.spend)                         as spend_prev,
         sum(coalesce(m.sales7d, m.sales, 0)) as sales_prev
  from ads.ad_metrics_daily m
  join win w on w.seller_account_id = m.seller_account_id
  where m.day between w.last_day - 13 and w.last_day - 7
  group by 1, 2
),
d1 as (
  select distinct on (m.seller_account_id, m.campaign_id)
         m.seller_account_id, m.campaign_id, m.day, m.spend, m.impressions, m.clicks,
         m.sales7d, m.acos7d, m.campaign_name
  from ads.ad_metrics_daily m
  order by m.seller_account_id, m.campaign_id, m.day desc
),
bu as (
  select distinct on (b.seller_account_id, b.campaign_id)
         b.seller_account_id, b.campaign_id, b.day as usage_day,
         b.budget, b.spend as usage_spend, b.percentage_used,
         b.delivered_clicks, b.captured_at as usage_captured_at
  from ads.budget_usage b
  order by b.seller_account_id, b.campaign_id, b.day desc, b.captured_at desc
),
exh as (
  select b.seller_account_id, b.campaign_id, b.day, min(b.captured_at) as exhausted_at
  from ads.budget_usage b
  where b.percentage_used >= 100
  group by 1, 2, 3
),
thr as (
  select r.threshold as acos_target
  from ops.alert_rules r
  where r.rule_code = 'acos_over_target' and r.is_active
  limit 1
)
select
  c.seller_account_id,
  sa.display_name                              as shop,
  c.ads_profile_id,
  c.campaign_id,
  coalesce(nullif(c.name, ''), d1.campaign_name, c.campaign_id) as campaign_name,
  c.campaign_type,
  c.state,
  c.targeting_type,
  c.cost_type,
  c.daily_budget,
  c.budget_type,
  coalesce(w7.currency, c.budget_currency, p.currency) as currency,
  c.start_date,
  c.end_date,
  c.portfolio_id,
  -- ngày dữ liệu
  d1.day                                       as last_metrics_day,
  w7.metrics_last_day,
  w7.days_with_data,
  -- hôm qua
  d1.spend                                     as spend_yesterday,
  d1.impressions                               as impressions_yesterday,
  d1.clicks                                    as clicks_yesterday,
  -- 7 ngày (cửa sổ kết thúc ở ngày dữ liệu mới nhất)
  w7.spend7,
  w7.sales7,
  w7.orders7                                   as ad_orders7,
  w7.units7                                    as ad_units7,
  w7.impressions7,
  w7.clicks7,
  case when coalesce(w7.sales7, 0) > 0
       then round(100.0 * w7.spend7 / w7.sales7, 2) end          as acos7,
  case when coalesce(w7.spend7, 0) > 0
       then round(w7.sales7 / w7.spend7, 2) end                  as roas7,
  case when coalesce(w7.impressions7, 0) > 0
       then round(100.0 * w7.clicks7 / w7.impressions7, 3) end   as ctr7,
  case when coalesce(w7.clicks7, 0) > 0
       then round(w7.spend7 / w7.clicks7, 3) end                 as cpc7,
  -- 7 ngày trước đó → xu hướng ACOS (điểm %, dương = xấu đi)
  case when coalesce(p7.sales_prev, 0) > 0
       then round(100.0 * p7.spend_prev / p7.sales_prev, 2) end  as acos_prev7,
  case when coalesce(p7.sales_prev, 0) > 0 and coalesce(w7.sales7, 0) > 0
       then round(100.0 * w7.spend7 / w7.sales7
                  - 100.0 * p7.spend_prev / p7.sales_prev, 2) end as acos_trend_pts,
  -- ngân sách
  coalesce(bu.percentage_used,
           case when coalesce(c.daily_budget, 0) > 0 and d1.spend is not null
                then round(100.0 * d1.spend / c.daily_budget, 2) end) as budget_used_pct,
  bu.usage_day                                 as budget_usage_day,
  bu.usage_spend                               as budget_usage_spend,
  bu.budget                                    as budget_usage_budget,
  bu.usage_captured_at,
  exh.exhausted_at                             as exhausted_at_estimate,
  (exh.exhausted_at is not null
   or coalesce(bu.percentage_used, 0) >= 100)  as budget_exhausted,
  -- cờ vượt ngưỡng ACOS (chỉ khi CÓ spend; không spend thì ACOS vô nghĩa)
  (coalesce(w7.spend7, 0) > 0
   and coalesce(w7.sales7, 0) > 0
   and round(100.0 * w7.spend7 / w7.sales7, 2) > coalesce(thr.acos_target, 25)) as over_acos_target,
  coalesce(thr.acos_target, 25)                as acos_target,
  c.first_seen_at,
  c.last_synced_at,
  c.source
from ads.campaigns c
join connections.seller_accounts sa on sa.id = c.seller_account_id
-- lateral + limit 1: campaign chỉ khớp MỘT profile (ưu tiên đúng profileId, sau đó
-- tới profile default). Join thường với `or p.is_default` làm campaign của profile
-- phụ bị NHÂN ĐÔI (một dòng khớp profileId, một dòng khớp is_default).
left join lateral (
  select pr.currency
  from ads.ad_profiles pr
  where pr.seller_account_id = c.seller_account_id
    and (pr.ads_profile_id = c.ads_profile_id
         or (coalesce(c.ads_profile_id, '') = '' and pr.is_default))
  order by (pr.ads_profile_id = c.ads_profile_id) desc, pr.is_default desc
  limit 1
) p on true
left join w7  on w7.seller_account_id  = c.seller_account_id and w7.campaign_id  = c.campaign_id
left join p7  on p7.seller_account_id  = c.seller_account_id and p7.campaign_id  = c.campaign_id
left join d1  on d1.seller_account_id  = c.seller_account_id and d1.campaign_id  = c.campaign_id
left join bu  on bu.seller_account_id  = c.seller_account_id and bu.campaign_id  = c.campaign_id
left join exh on exh.seller_account_id = c.seller_account_id
             and exh.campaign_id       = c.campaign_id
             and exh.day               = bu.usage_day
-- left join (không phải cross join): rule bị tắt thì view vẫn hiện số, ngưỡng về 25.
left join thr on true;

comment on view public.vexim_ads_campaigns is
  'A1: campaign (cấu hình từ Campaigns v3) + metrics cửa sổ 7 NGÀY kết thúc ở ngày '
  'dữ liệu mới nhất của shop (không hardcode "hôm qua" — cron hụt thì số vẫn đúng '
  'cửa sổ). acos7/roas7/ctr7/cpc7 tự tính khi Amazon không trả. budget_exhausted: '
  'percentageUsed ≥ 100 (Budget Usage API) hoặc spend ≥ daily_budget. '
  'exhausted_at_estimate là ƯỚC LƯỢNG (lần chụp đầu tiên thấy ≥100%).';

-- ----------------------------------------------------------------------------
-- C3. vexim_ads_campaign_daily — chuỗi ngày cho biểu đồ / đối chiếu
-- ----------------------------------------------------------------------------
create or replace view public.vexim_ads_campaign_daily
with (security_invoker = true) as
select
  m.seller_account_id,
  sa.display_name                    as shop,
  m.day,
  m.campaign_id,
  coalesce(nullif(c.name, ''), m.campaign_name, m.campaign_id) as campaign_name,
  coalesce(m.campaign_type, lower(coalesce(c.campaign_type, 'sp'))) as campaign_type,
  m.currency,
  m.impressions,
  m.clicks,
  m.spend,
  coalesce(m.sales7d, m.sales)       as sales7d,
  coalesce(m.purchases7d, m.orders)  as ad_orders7d,
  m.units_sold7d,
  m.acos7d,
  m.roas7d,
  m.ctr,
  m.cpc,
  m.budget_amount,
  m.campaign_status,
  m.ads_profile_id,
  m.report_id,
  m.imported_at
from ads.ad_metrics_daily m
join connections.seller_accounts sa on sa.id = m.seller_account_id
left join ads.campaigns c
       on c.seller_account_id = m.seller_account_id and c.campaign_id = m.campaign_id;

comment on view public.vexim_ads_campaign_daily is
  'Metrics theo ngày × campaign (nguồn cho biểu đồ trend và đối chiếu với Ads console).';

-- ----------------------------------------------------------------------------
-- C4. vexim_ads_kpis — KPI PPC + TACOS (theo shop × currency, KHÔNG cộng khác tiền)
-- ----------------------------------------------------------------------------
create or replace view public.vexim_ads_kpis
with (security_invoker = true) as
with win as (
  select m.seller_account_id, max(m.day) as last_day
  from ads.ad_metrics_daily m
  group by 1
),
ads7 as (
  select m.seller_account_id, m.currency,
         sum(m.spend)                         as spend7,
         sum(coalesce(m.sales7d, m.sales, 0)) as sales7,
         sum(coalesce(m.orders, 0))           as orders7,
         sum(m.clicks)                        as clicks7,
         sum(m.impressions)                   as impressions7
  from ads.ad_metrics_daily m
  join win w on w.seller_account_id = m.seller_account_id
  where m.day between w.last_day - 6 and w.last_day
  group by 1, 2
),
ads1 as (
  select m.seller_account_id, m.currency, m.day,
         sum(m.spend)   as spend_day,
         sum(m.clicks)  as clicks_day
  from ads.ad_metrics_daily m
  join win w on w.seller_account_id = m.seller_account_id and w.last_day = m.day
  group by 1, 2, 3
),
tot7 as (
  -- Tổng doanh thu của shop (mọi kênh) cùng cửa sổ 7 ngày → mẫu số của TACOS.
  select o.seller_account_id, o.currency,
         sum(o.sales_amount) as total_sales7,
         sum(o.orders_count) as total_orders7
  from sales.order_daily o
  join win w on w.seller_account_id = o.seller_account_id
  where o.day between w.last_day - 6 and w.last_day
  group by 1, 2
),
cmp as (
  select v.seller_account_id, v.currency,
         count(*)                                        filter (where v.state = 'ENABLED') as campaigns_enabled,
         count(*)                                        filter (where v.over_acos_target)   as campaigns_over_target,
         count(*)                                        filter (where v.budget_exhausted)   as campaigns_exhausted,
         sum(coalesce(v.daily_budget, 0))                filter (where v.state = 'ENABLED') as budget_daily_total
  from public.vexim_ads_campaigns v
  group by 1, 2
),
fresh as (
  select m.seller_account_id,
         max(m.day)         as last_day,
         max(m.imported_at) as last_import
  from ads.ad_metrics_daily m
  group by 1
),
thr as (
  select r.threshold as stale_hours
  from ops.alert_rules r
  where r.rule_code = 'ads_sync_stale' and r.is_active
  limit 1
)
select
  sa.id                                            as seller_account_id,
  sa.display_name                                  as shop,
  sa.status                                        as shop_status,
  a.currency,
  a1.day                                           as metrics_day,
  a1.spend_day                                     as spend_yesterday,
  a1.clicks_day                                    as clicks_yesterday,
  a.spend7,
  a.sales7                                         as ad_sales7,
  a.orders7                                        as ad_orders7,
  a.clicks7,
  a.impressions7,
  case when coalesce(a.sales7, 0) > 0
       then round(100.0 * a.spend7 / a.sales7, 2) end  as acos7,
  case when coalesce(a.spend7, 0) > 0
       then round(a.sales7 / a.spend7, 2) end          as roas7,
  case when coalesce(a.impressions7, 0) > 0
       then round(100.0 * a.clicks7 / a.impressions7, 3) end as ctr7,
  case when coalesce(a.clicks7, 0) > 0
       then round(a.spend7 / a.clicks7, 3) end         as cpc7,
  t.total_sales7,
  t.total_orders7,
  -- TACOS = spend ads / TỔNG doanh thu (mọi kênh) cùng cửa sổ, CÙNG tiền tệ.
  case when coalesce(t.total_sales7, 0) > 0
       then round(100.0 * a.spend7 / t.total_sales7, 2) end as tacos7,
  (t.total_sales7 is null)                         as tacos_unknown,
  coalesce(c.campaigns_enabled, 0)                 as campaigns_enabled,
  coalesce(c.campaigns_over_target, 0)             as campaigns_over_target,
  coalesce(c.campaigns_exhausted, 0)               as campaigns_exhausted,
  coalesce(c.budget_daily_total, 0)                as budget_daily_total,
  f.last_day                                       as last_metrics_day,
  f.last_import                                    as last_imported_at,
  case when f.last_import is null then null
       else round(extract(epoch from (now() - f.last_import)) / 3600.0, 1) end as hours_since_import,
  (f.last_import is not null
   and extract(epoch from (now() - f.last_import)) / 3600.0
       >= coalesce(thr.stale_hours, 36))            as is_stale
from connections.seller_accounts sa
join ads7 a   on a.seller_account_id = sa.id
left join ads1 a1 on a1.seller_account_id = a.seller_account_id and a1.currency = a.currency
left join tot7 t  on t.seller_account_id  = a.seller_account_id and t.currency  = a.currency
left join cmp  c  on c.seller_account_id  = a.seller_account_id and c.currency  = a.currency
left join fresh f on f.seller_account_id  = a.seller_account_id
left join thr on true;

comment on view public.vexim_ads_kpis is
  'KPI PPC theo shop × CURRENCY (không cộng tiền khác tiền tệ): spend hôm qua, '
  'spend/sales/ACOS/ROAS/CTR/CPC 7 ngày, TACOS = spend7 / tổng doanh thu 7 ngày '
  '(sales.order_daily). tacos_unknown = true khi chưa có doanh thu tổng (Module 4 '
  'chưa đồng bộ) → UI hiện "—" thay vì bịa 0%. is_stale theo ngưỡng ads_sync_stale.';

-- ----------------------------------------------------------------------------
-- C5. vexim_ads_search_terms — A3 (dữ liệu; luồng gợi ý negative là Phần 2)
-- ----------------------------------------------------------------------------
create or replace view public.vexim_ads_search_terms
with (security_invoker = true) as
with win as (
  select s.seller_account_id, max(s.day) as last_day
  from ads.search_terms s
  group by 1
),
agg as (
  select s.seller_account_id, s.term, s.campaign_id,
         max(s.currency)                    as currency,
         sum(s.impressions)                 as impressions,
         sum(s.clicks)                      as clicks,
         sum(s.spend)                       as spend,
         sum(coalesce(s.sales7d, s.sales, 0)) as sales7,
         sum(coalesce(s.purchases7d, 0))    as ad_orders7,
         count(distinct s.day)              as days_with_data,
         min(s.day)                         as first_day,
         max(s.day)                         as last_day,
         max(s.keyword_text)                as keyword_text,
         max(s.match_type)                  as match_type,
         max(s.keyword_type)                as keyword_type,
         max(s.campaign_name)               as campaign_name,
         max(s.ad_group_name)               as ad_group_name,
         max(s.bid)                         as bid,
         max(s.ad_keyword_status)           as ad_keyword_status
  from ads.search_terms s
  join win w on w.seller_account_id = s.seller_account_id
  where s.day between w.last_day - 6 and w.last_day
  group by 1, 2, 3
)
select
  a.seller_account_id,
  sa.display_name                              as shop,
  a.term                                       as search_term,
  (a.term = '*')                               as is_placement_without_keyword,
  a.campaign_id,
  a.campaign_name,
  a.ad_group_name,
  a.keyword_text,
  a.match_type,
  a.keyword_type,
  a.currency,
  a.impressions,
  a.clicks,
  a.spend,
  a.sales7,
  a.ad_orders7,
  case when coalesce(a.impressions, 0) > 0
       then round(100.0 * a.clicks / a.impressions, 3) end as ctr,
  case when coalesce(a.clicks, 0) > 0
       then round(a.spend / a.clicks, 3) end               as cpc,
  case when coalesce(a.sales7, 0) > 0
       then round(100.0 * a.spend / a.sales7, 2) end       as acos7,
  a.days_with_data,
  a.first_day,
  a.last_day,
  a.bid,
  a.ad_keyword_status,
  -- TÍN HIỆU thô cho gợi ý negative (Phần 2 mới có luồng duyệt + audit):
  -- có click, có spend, KHÔNG có đơn → đang đốt tiền. Ngưỡng cứng 3 click để
  -- không kết luận từ 1 click may rủi.
  (coalesce(a.clicks, 0) >= 3 and coalesce(a.sales7, 0) = 0 and coalesce(a.spend, 0) > 0)
                                                 as wasted_spend_signal
from agg a
join connections.seller_accounts sa on sa.id = a.seller_account_id;

comment on view public.vexim_ads_search_terms is
  'A3: search term gộp 7 ngày (cửa sổ kết thúc ở ngày dữ liệu mới nhất). '
  'term="*" = placement không gắn từ khoá (is_placement_without_keyword=true) — '
  'dữ liệu thật, KHÔNG phải rác. wasted_spend_signal chỉ là TÍN HIỆU (≥3 click, 0 đơn); '
  'gợi ý negative + luồng duyệt thuộc Phần 2.';

-- ----------------------------------------------------------------------------
-- C6. vexim_ads_targeting — A2: keyword/target
-- ----------------------------------------------------------------------------
create or replace view public.vexim_ads_targeting
with (security_invoker = true) as
with win as (
  select t.seller_account_id, max(t.day) as last_day
  from ads.targeting_metrics_daily t
  group by 1
)
select
  t.seller_account_id,
  sa.display_name                    as shop,
  t.day,
  t.campaign_id,
  t.campaign_name,
  t.ad_group_id,
  t.ad_group_name,
  coalesce(nullif(t.keyword_text, ''), t.targeting_expression, t.targeting_key) as target_label,
  t.keyword_id,
  t.keyword_text,
  t.match_type,
  t.keyword_type,
  (t.keyword_type in ('TARGETING_EXPRESSION','TARGETING_EXPRESSION_PREDEFINED')) as is_product_targeting,
  t.targeting_expression,
  t.bid,
  t.currency,
  t.impressions,
  t.clicks,
  t.cost                             as spend,
  t.sales7d,
  t.purchases7d                      as ad_orders7d,
  t.units_sold7d,
  t.acos7d,
  t.roas7d,
  t.report_id,
  t.imported_at
from ads.targeting_metrics_daily t
join connections.seller_accounts sa on sa.id = t.seller_account_id
join win w on w.seller_account_id = t.seller_account_id
where t.day between w.last_day - 6 and w.last_day;

comment on view public.vexim_ads_targeting is
  'A2: metrics theo keyword/target, cửa sổ 7 ngày. is_product_targeting phân biệt '
  'target ASIN/category với keyword (Amazon dùng keywordType).';

-- ----------------------------------------------------------------------------
-- C7. vexim_ads_budget_usage — % ngân sách + GIỜ CẠN (ước lượng)
-- ----------------------------------------------------------------------------
create or replace view public.vexim_ads_budget_usage
with (security_invoker = true) as
with latest as (
  select distinct on (b.seller_account_id, b.campaign_id, b.day)
         b.seller_account_id, b.campaign_id, b.day, b.budget, b.spend,
         b.percentage_used, b.delivered_clicks, b.delivered_impressions,
         b.currency, b.captured_at, b.source, b.ads_profile_id, b.budget_type,
         b.campaign_name
  from ads.budget_usage b
  order by b.seller_account_id, b.campaign_id, b.day desc, b.captured_at desc
),
first_full as (
  select b.seller_account_id, b.campaign_id, b.day,
         min(b.captured_at) as exhausted_at,
         count(*)           as snapshots
  from ads.budget_usage b
  where b.percentage_used >= 100
  group by 1, 2, 3
)
select
  l.seller_account_id,
  sa.display_name                       as shop,
  l.day,
  l.campaign_id,
  coalesce(nullif(l.campaign_name, ''), c.name, l.campaign_id) as campaign_name,
  c.state                               as campaign_state,
  l.ads_profile_id,
  l.budget_type,
  l.currency,
  l.budget,
  l.spend,
  l.percentage_used,
  l.delivered_clicks,
  l.delivered_impressions,
  l.captured_at                         as last_captured_at,
  l.source,
  f.exhausted_at                        as exhausted_at_estimate,
  f.snapshots                           as snapshots_over_100pct,
  (f.exhausted_at is not null
   or coalesce(l.percentage_used, 0) >= 100) as budget_exhausted,
  -- Nhãn để UI KHÔNG nói quá: giờ cạn là suy ra từ lần chụp, không phải số Amazon đưa.
  'Ước lượng từ lần chụp đầu tiên thấy ≥100% (chụp theo giờ)' as exhausted_note
from latest l
join connections.seller_accounts sa on sa.id = l.seller_account_id
left join ads.campaigns c
       on c.seller_account_id = l.seller_account_id and c.campaign_id = l.campaign_id
left join first_full f
       on f.seller_account_id = l.seller_account_id
      and f.campaign_id       = l.campaign_id
      and f.day               = l.day;

comment on view public.vexim_ads_budget_usage is
  'Ngân sách đã dùng theo campaign × ngày (lần chụp mới nhất) + exhausted_at_estimate '
  '= lần chụp ĐẦU TIÊN thấy ≥100%. Đây là ƯỚC LƯỢNG (Amazon không trả giờ cạn); '
  'exhausted_note ghi rõ để UI không trình bày như số chính xác.';

-- ----------------------------------------------------------------------------
-- C8. vexim_ads_report_requests — cron Ads đang ở đâu (Module 0 · Sync health)
-- ----------------------------------------------------------------------------
create or replace view public.vexim_ads_report_requests
with (security_invoker = true) as
select
  r.id,
  r.seller_account_id,
  sa.display_name                    as shop,
  r.ads_profile_id,
  r.report_type_id,
  r.ad_product,
  nullif(r.group_by, '')             as group_by,
  r.time_unit,
  r.date_start,
  r.date_end,
  r.ads_report_id,
  r.status,
  r.failure_reason,
  r.rows_imported,
  r.attempts,
  r.last_error,
  r.requested_at,
  r.completed_at,
  r.imported_at,
  case when r.requested_at is null then null
       else round(extract(epoch from (now() - r.requested_at)) / 60)::int end as age_minutes,
  -- Report Ads thường xong trong vài phút; chờ quá 2 giờ là bất thường.
  (r.status in ('requested','processing')
   and r.requested_at is not null
   and r.requested_at < now() - interval '2 hours') as is_stale
from ads.report_requests r
join connections.seller_accounts sa on sa.id = r.seller_account_id;

comment on view public.vexim_ads_report_requests is
  'Trạng thái report Ads (Reporting v3) — màn Sync health: đang chờ / đã nhập / lỗi, '
  'kèm is_stale khi chờ quá 2 giờ. download_url KHÔNG phơi ra view (URL có token truy cập).';

-- ----------------------------------------------------------------------------
-- C9. GRANTS
-- ----------------------------------------------------------------------------
grant select on
  public.vexim_ads_profiles,
  public.vexim_ads_campaigns,
  public.vexim_ads_campaign_daily,
  public.vexim_ads_kpis,
  public.vexim_ads_search_terms,
  public.vexim_ads_targeting,
  public.vexim_ads_budget_usage,
  public.vexim_ads_report_requests
to authenticated, service_role;

-- ============================================================================
-- §D. TỰ KIỂM TRA (fail ngay trong migration, không để lỗi im lặng lên production)
-- ============================================================================
do $$
declare
  n      int;
  v_fn   text;
  v_view text;
  v_cols text;
begin
  -- D1. bảng mới có RLS
  select count(*) into n
  from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
  where (ns.nspname, c.relname) in (('ads','targeting_metrics_daily'),
                                    ('ads','advertised_product_daily'),
                                    ('ads','budget_usage'),
                                    ('ads','report_requests'),
                                    ('connections','oauth_states'),
                                    ('connections','oauth_events'))
    and c.relrowsecurity;
  if n <> 6 then
    raise exception '[0020] FAIL: thiếu bảng hoặc chưa bật RLS (có %/6)', n;
  end if;

  -- D2. index unique khử trùng
  select count(*) into n from pg_indexes
  where indexname in ('uq_oauth_tokens_shop_service','uq_search_terms_key',
                      'uq_budget_usage_hour','uq_ads_report_requests_key',
                      'uq_alerts_open_entity')
    and indexdef like '%UNIQUE%';
  if n <> 5 then
    raise exception '[0020] FAIL: thiếu index unique (có %/5)', n;
  end if;

  -- D3. TOKEN KHÔNG ĐỌC ĐƯỢC TỪ CLIENT: oauth_tokens + oauth_states không có
  --     policy nào cho authenticated/anon (đúng thiết kế 0001, giữ nguyên ở 0020).
  select count(*) into n
  from pg_policies p
  where p.schemaname = 'connections'
    and p.tablename in ('oauth_tokens','oauth_states')
    and (p.roles::text like '%authenticated%' or p.roles::text like '%anon%'
         or p.roles::text like '%public%');
  if n <> 0 then
    raise exception '[0020] FAIL: có % policy client trên oauth_tokens/oauth_states — LỘ TOKEN', n;
  end if;

  -- D4. không view nào phơi cột token
  select count(*) into n
  from information_schema.columns c
  where c.table_schema = 'public'
    and (c.column_name ilike '%refresh_token%' or c.column_name ilike '%encrypted%'
         or c.column_name ilike '%access_token%' or c.column_name = 'download_url');
  if n <> 0 then
    raise exception '[0020] FAIL: % cột token/URL có token bị phơi ra view public', n;
  end if;

  -- D5. RPC: security definer + chỉ service_role
  foreach v_fn in array array['vexim_oauth_upsert_token','vexim_oauth_record_event',
                              'vexim_oauth_set_state','vexim_oauth_consume_state',
                              'vexim_oauth_reauth_scan',
                              'vexim_worker_upsert_ads_profiles','vexim_worker_upsert_ads_campaigns',
                              'vexim_worker_upsert_ads_metrics','vexim_worker_upsert_ads_targeting',
                              'vexim_worker_upsert_ads_search_terms','vexim_worker_upsert_ads_advertised',
                              'vexim_worker_upsert_ads_budget_usage','vexim_worker_set_ads_report_request',
                              'vexim_worker_pending_ads_reports','vexim_ads_raise_alerts',
                              'vexim_worker_fill_profit_ads_spend'] loop
    select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = v_fn and p.prosecdef
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and has_function_privilege('service_role', p.oid, 'EXECUTE');
    if n <> 1 then
      raise exception '[0020] FAIL: RPC % thiếu / không security definer / sai quyền', v_fn;
    end if;
  end loop;

  -- D6. 8 view Ads là security_invoker (RLS bảng gốc vẫn áp — multi-tenant)
  select count(*) into n
  from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public'
    and c.relname in ('vexim_ads_profiles','vexim_ads_campaigns','vexim_ads_campaign_daily',
                      'vexim_ads_kpis','vexim_ads_search_terms','vexim_ads_targeting',
                      'vexim_ads_budget_usage','vexim_ads_report_requests')
    and 'security_invoker=true' = any (c.reloptions);
  if n <> 8 then
    raise exception '[0020] FAIL: %/8 view Ads không phải security_invoker', n;
  end if;

  -- D7. 2 view OAuth là security DEFINER (bảng gốc cấm client) nhưng có lọc
  --     iam.can_read_seller_account trong định nghĩa.
  select count(*) into n
  from pg_views v
  where v.schemaname = 'public'
    and v.viewname in ('vexim_connections','vexim_oauth_events')
    and v.definition like '%can_read_seller_account%';
  if n <> 2 then
    raise exception '[0020] FAIL: view OAuth thiếu lọc can_read_seller_account (có %/2)', n;
  end if;

  -- D8. alert rules
  select count(*) into n from ops.alert_rules
  where rule_code in ('reauth_required','ads_sync_stale','acos_over_target','budget_exhausted')
    and is_active;
  if n <> 4 then
    raise exception '[0020] FAIL: thiếu alert rule PPC/re-auth (có %/4)', n;
  end if;
  select count(*) into n from ops.alert_rules
  where rule_code = 'budget_exhausted' and threshold = 100 and comparator = 'gte';
  if n <> 1 then
    raise exception '[0020] FAIL: budget_exhausted chưa có ngưỡng 100%% (gte)';
  end if;

  -- D9. helper đọc số/ngày an toàn
  if ads.num_or_null('1,234.56') <> 1234.56
     or ads.num_or_null('18.2%') <> 18.2
     or ads.num_or_null('N/A') is not null
     or ads.num_or_null('') is not null
     or ads.date_or_null('2026-09-11T07:00:00Z') <> date '2026-09-11'
     or ads.date_or_null('11/09/2026') is not null then
    raise exception '[0020] FAIL: ads.num_or_null / ads.date_or_null sai hành vi';
  end if;

  -- D10. token cũ đã có reauthorize_at (không để NULL rồi im lặng hết hạn)
  select count(*) into n from connections.oauth_tokens where reauthorize_at is null;
  if n <> 0 then
    raise exception '[0020] FAIL: còn % token chưa có reauthorize_at', n;
  end if;
  select count(*) into n from connections.oauth_tokens where service not in ('spapi','ads');
  if n <> 0 then
    raise exception '[0020] FAIL: còn % token có service lạ', n;
  end if;

  -- D11. hợp đồng cột của 2 view chính (web đọc theo tên cột — đổi là vỡ UI)
  select string_agg(column_name, ',' order by ordinal_position) into v_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'vexim_ads_kpis';
  if v_cols <>
     'seller_account_id,shop,shop_status,currency,metrics_day,spend_yesterday,clicks_yesterday,'
     || 'spend7,ad_sales7,ad_orders7,clicks7,impressions7,acos7,roas7,ctr7,cpc7,'
     || 'total_sales7,total_orders7,tacos7,tacos_unknown,campaigns_enabled,campaigns_over_target,'
     || 'campaigns_exhausted,budget_daily_total,last_metrics_day,last_imported_at,'
     || 'hours_since_import,is_stale' then
    raise exception '[0020] FAIL: vexim_ads_kpis sai hợp đồng cột: %', v_cols;
  end if;

  select string_agg(column_name, ',' order by ordinal_position) into v_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'vexim_connections';
  if v_cols <>
     'seller_account_id,shop,seller_id,marketplace,shop_status,data_source,service,connected,'
     || 'token_status,token_source,scope,client_id,selling_partner_id,ads_account_id,'
     || 'authorized_at,reauthorize_at,reminder_days,reminder_sent_at,last_refresh_at,'
     || 'last_used_at,last_error,days_to_reauth,reauth_state,needs_connect' then
    raise exception '[0020] FAIL: vexim_connections sai hợp đồng cột: %', v_cols;
  end if;

  -- D11b. Không còn policy ÁP CHO SELECT (cmd = SELECT hoặc ALL) nào tự tra
  -- iam.role_assignments — đó chính là cặp policy gây "infinite recursion
  -- detected in policy" khi user thường đọc (view security_invoker vỡ theo).
  -- Policy chỉ-ghi (insert/update/delete) không ảnh hưởng SELECT nên không tính.
  select count(*) into n
  from pg_policies p
  where (p.schemaname, p.tablename) in (('iam','role_assignments'),('iam','user_profiles'),
                                        ('iam','assignments'),('ops','alert_rules'))
    and (p.cmd = 'ALL' or p.cmd = 'SELECT')
    and coalesce(p.qual, '') || coalesce(p.with_check, '') like '%role_assignments%';
  if n <> 0 then
    raise exception '[0020] FAIL: còn % policy đọc được tự tra role_assignments (đệ quy vô hạn)', n;
  end if;

  -- D12. regression: view 0019 vẫn nguyên
  foreach v_view in array array['vexim_storage_fees','vexim_storage_fee_by_fc',
                                'vexim_inbound_issues','vexim_report_requests'] loop
    select count(*) into n
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relname = v_view
      and 'security_invoker=true' = any (c.reloptions);
    if n <> 1 then
      raise exception '[0020] FAIL: mất view % của 0019', v_view;
    end if;
  end loop;

  raise notice '[0020] OK: OAuth multi-tenant + re-auth 365 ngày + PPC đọc/phân tích sẵn sàng';
end;
$$;

commit;
