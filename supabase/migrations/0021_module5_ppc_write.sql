-- ============================================================================
-- 0021 — MODULE 5 PHẦN 2 & 3: PPC CHIỀU GHI
--        (đổi bid keyword · đổi budget campaign · bật/tắt · negative keyword)
--        + HÀNG ĐỢI DUYỆT THEO NGƯỠNG + AUDIT LOG MỌI THAO TÁC
-- ============================================================================
-- BỐI CẢNH
--   0020 làm xong chiều ĐỌC của Module 5 (Profiles · Campaigns v3 · Reporting v3 ·
--   view A1/A2/A3 · KPI/TACOS · alert ACOS/budget). Phần 2&3 là chiều GHI: sửa thật
--   trên tài khoản quảng cáo của khách. Đây là phần DUY NHẤT trong hệ thống mà một
--   dòng code sai làm MẤT TIỀN THẬT của shop ngay lập tức, nên thiết kế đặt an toàn
--   lên trước tiện lợi:
--
--     1. UI KHÔNG BAO GIỜ gọi Amazon. UI chỉ tạo "đề xuất thay đổi"
--        (ads.change_requests) — một hàng đợi có trạng thái, có người duyệt, có TTL.
--        Cron (web/src/app/api/cron/ads-apply) là thứ duy nhất gọi PUT/POST.
--     2. Mỗi đề xuất lưu before_value (giá trị Amazon ĐANG có lúc đề xuất) và
--        after_value (giá trị muốn đổi). Lúc áp dụng PHẢI đọc lại Amazon và so
--        before_value: khác → SKIP. Lý do: giữa lúc đề xuất và lúc duyệt, người của
--        shop có thể đã đổi tay trong Ads console; ghi đè mù vừa phá việc người khác
--        vừa làm số liệu trong DB lệch với Amazon mà không ai biết.
--     3. Audit bằng TRIGGER, không bằng RPC: mọi chuyển trạng thái của
--        ads.change_requests đều rơi vào iam.audit_logs (before/after jsonb).
--        Viết audit trong RPC nghĩa là chỉ cần một đường ghi mới quên gọi là mất dấu.
--     4. Guardrail nằm TRONG DB (ads.ppc_policies): % thay đổi tối đa, sàn/trần bid
--        & budget, trần số thay đổi/ngày, TTL đề xuất, ngưỡng sinh gợi ý.
--        Đổi guardrail = sửa một dòng, không cần deploy.
--     5. Mặc định TẮT: auto_apply = false (mọi thứ phải có người duyệt) và cron chỉ
--        thật sự gọi Amazon khi env ADS_WRITE_ENABLED=1. Chưa bật thì hệ thống chỉ
--        sinh đề xuất + gợi ý (vẫn hữu ích: đội PPC làm theo danh sách đó).
--
-- NGUỒN ĐÃ ĐỐI CHIẾU CHO CHIỀU GHI SP v3 (13/09/2026)
--   Trang tài liệu chính thức advertising.amazon.com/API/docs/en-us/sp/api-refs/*
--   là app JS (fetch trực tiếp trả 404 "document not found") nên hợp đồng dưới đây
--   được đối chiếu qua 3 nguồn độc lập, KHỚP NHAU:
--     • manifest của Airbyte source-amazon-ads (sinh từ spec Amazon):
--         POST /sp/campaigns/list          Accept+Content-Type application/vnd.spCampaign.v3+json   → {campaigns[], nextToken}
--         POST /sp/keywords/list           application/vnd.spKeyword.v3+json                        → {keywords[], nextToken}
--         POST /sp/negativeKeywords/list   application/vnd.spNegativeKeyword.v3+json                → {negativeKeywords[], nextToken}
--         POST /sp/campaignNegativeKeywords/list  application/vnd.spCampaignNegativeKeyword.v3+json → {campaignNegativeKeywords[]}
--         POST /sp/adGroups/list           application/vnd.spAdGroup.v3+json                        → {adGroups[]}
--         POST /sp/targets/list            application/vnd.spTargetingClause.v3+json
--     • client production pavelmelnikme-coder3/AmazonADS (backend/src/services/amazon/
--       writeback.js + adsClient.js) — cho CHIỀU GHI:
--         PUT  /sp/keywords                {keywords:[{keywordId, bid?, state?}]}   state phải VIẾT HOA (ENABLED/PAUSED)
--         PUT  /sp/campaigns               {campaigns:[{campaignId, budget?, state?, name?}]}
--         PUT  /sp/adGroups                {adGroups:[...]}
--         POST /sp/negativeKeywords        {negativeKeywords:[{keywordText, matchType, state, campaignId, adGroupId}]}
--         POST /sp/campaignNegativeKeywords{campaignNegativeKeywords:[{keywordText, matchType, state, campaignId}]}
--         matchType phủ định của v3 là NEGATIVE_EXACT / NEGATIVE_PHRASE (v2 dùng
--         negativeExact — đừng lẫn; dùng sai Amazon trả 400 chứ không tự hiểu)
--         response ghi là 207 Multi-Status: {<dataKey>:{success:[{..., index}], error:[{errors:[{code,message}], index}]}}
--     • withone.ai knowledge + Postman collection của Amazon: PUT /sp/campaigns trả
--         207 {campaigns:{success:[{campaignId,index}],error:[{errors:[{errorType,errorValue}],index}]}};
--         mutable của campaign = state, budget, name, portfolioId, bidOptimization;
--         permission cần có = advertiser_campaign_edit; header Prefer: return=representation.
--   CHƯA MỞ (cố ý): đổi bid của TARGET (ASIN/category) qua PUT /sp/targets — ba nguồn
--   trên đều chỉ có chiều LIST, không nguồn nào xác nhận tên khoá của body ghi
--   ({targets:…} hay {targetingClauses:…}). Thà thiếu một tính năng còn hơn đoán hợp
--   đồng rồi ghi sai lên tài khoản khách. Keyword bid (PUT /sp/keywords) đã đủ 3 nguồn.
--
-- NGUYÊN TẮC KẾ THỪA (0014..0020)
--   • Khoá NOT NULL DEFAULT '' (NULL không khử trùng trong index unique).
--   • Ghi = RPC; web chỉ có policy SELECT.
--   • KHÔNG CỘNG TIỀN KHÁC TIỀN TỆ: mọi view nhóm/tách theo currency.
--   • Số không đọc được → NULL ("chưa biết"), không đoán 0.
--   • Idempotent: if not exists · create or replace · drop policy if exists.
--   • Chạy SAU 0020.
-- ============================================================================

begin;

-- ============================================================================
-- §C. MODULE 5 PHẦN 2&3 — CHIỀU GHI CÓ DUYỆT
-- ============================================================================

-- ----------------------------------------------------------------------------
-- C0. iam.is_ppc_approver() — ai được DUYỆT thay đổi PPC
-- ----------------------------------------------------------------------------
-- Giống iam.is_listing_approver() của 0014: admin hoặc trưởng phòng đúng chuyên môn.
-- Phòng 'ppc' đã seed từ 0001 ("Quảng cáo (PPC) — Campaign, budget/bid, tối ưu
-- ACOS/TACOS") nên không cần thêm department mới.
create or replace function iam.is_ppc_approver()
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

comment on function iam.is_ppc_approver() is
  'C: admin (super_admin/org_admin) hoặc trưởng phòng PPC (dept_lead, department '
  'code = ppc) được DUYỆT/TỪ CHỐI đề xuất thay đổi quảng cáo và sửa guardrail. '
  'Người đề xuất KHÔNG tự duyệt được đề xuất của chính mình (kiểm tra trong RPC).';

revoke all on function iam.is_ppc_approver() from public, anon;
grant execute on function iam.is_ppc_approver() to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- C0b. iam.user_display(uuid) — tên người thao tác, KHÔNG phá RLS của user_profiles
-- ----------------------------------------------------------------------------
-- 0020 siết iam.user_profiles: user thường chỉ đọc được profile CỦA MÌNH
-- (rls_read_user_profiles_self). View hàng đợi mà join thẳng bảng đó thì cột
-- "người đề xuất" ra NULL với mọi user không phải super_admin — UI mất thông tin
-- quan trọng nhất của luồng duyệt ("ai đề xuất, ai duyệt").
-- Giải pháp theo đúng tiền lệ iam.module_owner() của 0017: hàm SECURITY DEFINER
-- chỉ trả display_name (tên nhân viên VEXIM, không email, không uuid → không phải PII).
create or replace function iam.user_display(p_user uuid)
returns text
language sql stable security definer
set search_path = iam, pg_catalog
as $$
  select up.display_name from iam.user_profiles up where up.id = p_user;
$$;

comment on function iam.user_display(uuid) is
  'C: display_name của một user (cho hàng đợi PPC: ai đề xuất / ai duyệt). SECURITY '
  'DEFINER vì iam.user_profiles chỉ cho user đọc profile của chính mình (0020). '
  'CHỈ trả tên — không email, không uuid, giống iam.module_owner() của 0017.';

revoke all on function iam.user_display(uuid) from public, anon;
grant execute on function iam.user_display(uuid) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- C1. ads.ppc_policies — guardrail theo shop (đổi được, không cần deploy)
-- ----------------------------------------------------------------------------
-- Một shop một dòng. KHÔNG có dòng = dùng mặc định (hàm ads.ppc_policy() bên dưới
-- trả mặc định, không trả NULL) — để shop mới có guardrail ngay từ đề xuất đầu tiên.
create table if not exists ads.ppc_policies (
  seller_account_id           uuid primary key references connections.seller_accounts(id) on delete cascade,
  -- bật/tắt chế độ tự áp dụng (mặc định TẮT: mọi thay đổi cần người duyệt)
  auto_apply                  boolean not null default false,
  -- đổi trạng thái (bật/tắt campaign, pause keyword) LUÔN cần duyệt?
  require_approval_state      boolean not null default true,
  -- % thay đổi tối đa còn được coi là "nhỏ"; vượt = bắt buộc duyệt
  max_bid_change_pct          numeric(6,2) not null default 20,
  max_budget_change_pct       numeric(6,2) not null default 30,
  -- sàn/trần TUYỆT ĐỐI (vượt là chặn hẳn, không phải "cần duyệt")
  bid_floor                   numeric(12,4),
  bid_ceiling                 numeric(12,4),
  budget_floor                numeric(12,2),
  budget_ceiling              numeric(12,2),
  -- trần số thay đổi ÁP DỤNG mỗi ngày cho shop (chặn vòng lặp tự khuếch đại)
  daily_change_cap            int not null default 50,
  -- trần số đề xuất đang mở (proposed/approved/applying) — chống flood
  max_open_requests           int not null default 100,
  -- đề xuất sống bao lâu; quá hạn tự expired (số liệu cũ thì quyết định cũng cũ)
  proposal_ttl_hours          int not null default 72,
  -- ngưỡng SINH GỢI Ý (đọc từ ads.targeting_metrics_daily / ads.search_terms)
  suggestion_min_clicks       int not null default 3,
  suggestion_min_spend        numeric(12,2) not null default 1,
  -- ACOS 7 ngày vượt ngưỡng này (mà VẪN có đơn) → gợi ý HẠ bid
  suggestion_acos_lower_pct   numeric(6,2) not null default 50,
  -- mỗi lần hạ/tăng bid bao nhiêu % (bước nhỏ, dễ hoàn tác)
  bid_step_pct                numeric(6,2) not null default 15,
  currency                    text not null default 'USD',
  notes                       text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  updated_by                  uuid references iam.user_profiles(id),
  constraint ck_ppc_policy_bid_range   check (bid_floor is null or bid_ceiling is null or bid_floor <= bid_ceiling),
  constraint ck_ppc_policy_budget_range check (budget_floor is null or budget_ceiling is null or budget_floor <= budget_ceiling),
  constraint ck_ppc_policy_cap         check (daily_change_cap between 1 and 100000),
  constraint ck_ppc_policy_ttl         check (proposal_ttl_hours between 1 and 720)
);

comment on table ads.ppc_policies is
  'C: guardrail chiều GHI PPC theo shop. Không có dòng = mặc định (auto_apply=false, '
  'bid ±20%, budget ±30%, 50 thay đổi/ngày, TTL 72h). Sàn/trần là CHẶN HẲN; '
  '% thay đổi là NGƯỠNG PHẢI DUYỆT. Mọi cột ngưỡng đều đọc được bằng '
  'ads.ppc_policy(shop) để view/RPC không mỗi nơi một default.';

create index if not exists idx_ppc_policies_updated on ads.ppc_policies (updated_at desc);

-- ----------------------------------------------------------------------------
-- C1b. ads.ppc_policy(shop) — policy HIỆU LỰC (có mặc định) ở MỘT chỗ
-- ----------------------------------------------------------------------------
create or replace function ads.ppc_policy(p_seller uuid)
returns jsonb
language sql stable
set search_path = ads, pg_catalog
as $$
  select jsonb_build_object(
    'seller_account_id',         p_seller,
    'has_row',                   (p.seller_account_id is not null),
    'auto_apply',                coalesce(p.auto_apply, false),
    'require_approval_state',    coalesce(p.require_approval_state, true),
    'max_bid_change_pct',        coalesce(p.max_bid_change_pct, 20),
    'max_budget_change_pct',     coalesce(p.max_budget_change_pct, 30),
    'bid_floor',                 p.bid_floor,
    'bid_ceiling',               p.bid_ceiling,
    'budget_floor',              p.budget_floor,
    'budget_ceiling',            p.budget_ceiling,
    'daily_change_cap',          coalesce(p.daily_change_cap, 50),
    'max_open_requests',         coalesce(p.max_open_requests, 100),
    'proposal_ttl_hours',        coalesce(p.proposal_ttl_hours, 72),
    'suggestion_min_clicks',     coalesce(p.suggestion_min_clicks, 3),
    'suggestion_min_spend',      coalesce(p.suggestion_min_spend, 1),
    'suggestion_acos_lower_pct', coalesce(p.suggestion_acos_lower_pct, 50),
    'bid_step_pct',              coalesce(p.bid_step_pct, 15),
    'currency',                  coalesce(nullif(p.currency, ''), 'USD'),
    'notes',                     p.notes,
    'updated_at',                p.updated_at
  )
  from (select 1 as x) one
  left join ads.ppc_policies p on p.seller_account_id = p_seller;
$$;

comment on function ads.ppc_policy(uuid) is
  'C: trả policy HIỆU LỰC của shop dưới dạng jsonb — shop chưa có dòng policy vẫn '
  'trả đủ mặc định (has_row=false). View gợi ý, RPC đề xuất, RPC worker đều đọc qua '
  'hàm này để KHÔNG có hai nguồn sự thật về ngưỡng.';

revoke all on function ads.ppc_policy(uuid) from public, anon;
grant execute on function ads.ppc_policy(uuid) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- C1c. ads.num_text() — in số tiền/số bid KHÔNG kèm số 0 thừa
-- ----------------------------------------------------------------------------
-- numeric(12,4) của bid in ra "2.0000", delta_pct numeric(8,2) in ra "-15.00".
-- Đưa vào câu mô tả cho người đọc thì phải là "2" và "-15%" — trim_scale làm việc đó.
create or replace function ads.num_text(p_num numeric)
returns text
language sql immutable
set search_path = pg_catalog
as $$
  select case when p_num is null then null else trim_scale(p_num)::text end;
$$;

comment on function ads.num_text(numeric) is
  'C: in số cho người đọc (2.0000 → "2", -15.00 → "-15", 1.70 → "1.7"). NULL → NULL. '
  'Dùng trong summary/reason của view PPC để UI không phải tự cắt số 0.';

revoke all on function ads.num_text(numeric) from public, anon;
grant execute on function ads.num_text(numeric) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- C2. ads.change_requests — HÀNG ĐỢI thay đổi (máy trạng thái)
-- ----------------------------------------------------------------------------
--   proposed → approved → applying → applied
--                    ↘ rejected        ↘ failed → approved (duyệt lại để retry)
--   proposed/approved → expired (quá TTL)        applying → skipped (Amazon đã lệch)
--   proposed/approved → skipped (hệ thống tự bỏ qua: không phải Sponsored Products)
--   applying → approved (cron chết giữa chừng thì lô sau lấy lại hàng)
-- applied / rejected / expired / skipped là TRẠNG THÁI CUỐI.
create table if not exists ads.change_requests (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  /** profileId Ads — '' thì worker tự lấy profile default của shop lúc áp dụng */
  ads_profile_id    text not null default '',
  entity_type       text not null
                    check (entity_type in ('campaign','ad_group','keyword',
                                           'negative_keyword','campaign_negative_keyword')),
  change_type       text not null
                    check (change_type in ('bid','budget','state','name','create')),
  /** id Amazon của thực thể (campaignId/keywordId). Đề xuất TẠO MỚI thì '' */
  amazon_entity_id  text not null default '',
  campaign_id       text not null default '',
  ad_group_id       text not null default '',
  /** nhãn hiển thị: tên campaign / text keyword / search term muốn phủ định */
  label             text not null default '',
  /** NEGATIVE_EXACT | NEGATIVE_PHRASE (chỉ dùng cho negative keyword) */
  match_type        text,
  currency          text not null default 'USD',
  /** giá trị Amazon ĐANG có lúc đề xuất — cron so lại trước khi ghi */
  before_value      jsonb,
  /** giá trị MUỐN đổi sang (ngữ nghĩa; write.ts tự ánh xạ sang wire format Amazon) */
  after_value       jsonb not null default '{}'::jsonb,
  /** % thay đổi của con số chính (bid/budget); NULL khi không tính được */
  delta_pct         numeric(8,2),
  requires_approval boolean not null default true,
  reason            text,
  source            text not null default 'manual'
                    check (source in ('manual','suggestion','import')),
  /** khoá của gợi ý sinh ra đề xuất (vexim_ppc_suggestions.suggestion_key) */
  suggestion_key    text,
  status            text not null default 'proposed'
                    check (status in ('proposed','approved','rejected','expired',
                                      'applying','applied','failed','skipped')),
  /** gom các đề xuất gửi đi trong MỘT lần gọi Amazon (207 trả theo lô) */
  batch_id          uuid,
  proposed_by       uuid references iam.user_profiles(id),
  proposed_at       timestamptz not null default now(),
  decided_by        uuid references iam.user_profiles(id),
  decided_at        timestamptz,
  decision_note     text,
  expires_at        timestamptz,
  attempts          int  not null default 0,
  /** lúc cron "giành" lô (status → applying) — mốc để đòi lại lô kẹt;
      KHÔNG dùng updated_at vì trigger bảo trì updated_at mỗi lần ghi */
  claimed_at        timestamptz,
  applied_at        timestamptz,
  last_error        text,
  /** phản hồi thô của Amazon cho đúng dòng này (lấy theo index của 207) */
  amazon_response   jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table ads.change_requests is
  'C: hàng đợi thay đổi PPC. UI tạo dòng proposed; trưởng phòng PPC duyệt '
  '(approved/rejected); cron ads-apply đọc approved, ĐỌC LẠI Amazon để so '
  'before_value rồi mới PUT/POST, ghi applied/failed/skipped. before_value và '
  'after_value BẤT BIẾN sau khi tạo (trigger chặn) — người duyệt duyệt đúng cái '
  'đã đề xuất, không ai sửa ngầm được. Mọi chuyển trạng thái → iam.audit_logs.';

-- Chỉ MỘT đề xuất đang mở cho cùng một thực thể + cùng loại thay đổi. Không có khoá
-- này thì bấm hai lần (hoặc hai người cùng đề xuất) → cron gọi Amazon hai lần.
create unique index if not exists uq_change_requests_open
  on ads.change_requests (
    seller_account_id, entity_type, change_type, amazon_entity_id,
    lower(coalesce(ad_group_id, '')), lower(coalesce(label, ''))
  )
  where status in ('proposed','approved','applying');

create index if not exists idx_change_requests_status
  on ads.change_requests (status, decided_at nulls first, proposed_at);
create index if not exists idx_change_requests_shop
  on ads.change_requests (seller_account_id, status, proposed_at desc);
create index if not exists idx_change_requests_batch
  on ads.change_requests (batch_id) where batch_id is not null;
create index if not exists idx_change_requests_suggestion
  on ads.change_requests (seller_account_id, suggestion_key) where suggestion_key is not null;

-- ----------------------------------------------------------------------------
-- C2b. TRIGGER máy trạng thái + bất biến before/after
-- ----------------------------------------------------------------------------
create or replace function ads.change_request_guard()
returns trigger
language plpgsql
set search_path = ads, pg_catalog
as $$
declare
  v_ok boolean := false;
begin
  if tg_op = 'INSERT' then
    -- Chỉ RPC mới INSERT; vẫn chặn trạng thái "sinh ra đã xong" (applied/failed…)
    -- vì đó là dấu hiệu code gọi sai và sẽ làm mất dấu audit.
    if new.status not in ('proposed','approved') then
      raise exception '[PPC] đề xuất mới phải ở trạng thái proposed/approved, không phải %', new.status
        using errcode = 'check_violation';
    end if;
    if new.after_value is null or new.after_value = '{}'::jsonb then
      raise exception '[PPC] đề xuất phải có after_value (giá trị muốn đổi sang)'
        using errcode = 'not_null_violation';
    end if;
    new.updated_at := now();
    return new;
  end if;

  -- UPDATE: khoá các cột NGỮ NGHĨA. Đổi chúng = đổi nội dung đã duyệt.
  if (old.before_value is distinct from new.before_value)
     or (old.after_value is distinct from new.after_value)
     or old.entity_type  <> new.entity_type
     or old.change_type  <> new.change_type
     or old.amazon_entity_id <> new.amazon_entity_id
     or old.seller_account_id <> new.seller_account_id then
    raise exception '[PPC] không được sửa nội dung đề xuất sau khi tạo '
                    '(before_value/after_value/entity/change/id) — hãy từ chối rồi đề xuất lại'
      using errcode = 'check_violation';
  end if;

  if old.status = new.status then
    new.updated_at := now();
    return new;                      -- chỉ cập nhật attempts/error/response: cho phép
  end if;

  -- 'skipped' từ proposed/approved là do HỆ THỐNG tự bỏ qua (không phải người duyệt
  -- từ chối): campaign không thuộc Sponsored Products, hoặc cron phát hiện Amazon đã
  -- lệch trước khi kịp giành lô. Phân biệt với 'rejected' để audit đọc ra ai quyết.
  v_ok := case old.status
            when 'proposed' then new.status in ('approved','rejected','expired','skipped')
            when 'approved' then new.status in ('applying','rejected','expired','skipped')
            -- applying → approved: cron "giành" lô rồi chết giữa chừng (timeout
            -- Vercel, deploy…) thì lô sau phải lấy lại được, không kẹt vĩnh viễn.
            when 'applying' then new.status in ('applied','failed','skipped','approved')
            -- failed cho phép quay lại approved/applying để retry CÓ chủ đích
            when 'failed'   then new.status in ('approved','applying','expired')
            else false               -- applied/rejected/expired/skipped = cuối
          end;

  if not v_ok then
    raise exception '[PPC] chuyển trạng thái % → % không hợp lệ', old.status, new.status
      using errcode = 'check_violation';
  end if;

  -- Ràng buộc kèm theo từng trạng thái (thiếu là dữ liệu không truy vết được)
  if new.status in ('approved','rejected') and new.decided_at is null then
    new.decided_at := now();
  end if;
  if new.status = 'applied' and new.applied_at is null then
    new.applied_at := now();
  end if;
  if new.status in ('applied','failed','skipped') and new.batch_id is null then
    -- batch_id là bằng chứng "dòng này đi cùng lô gọi Amazon nào"; worker luôn đặt.
    new.batch_id := gen_random_uuid();
  end if;

  new.updated_at := now();
  return new;
end;
$$;

comment on function ads.change_request_guard() is
  'C: (1) chặn chuyển trạng thái sai máy trạng thái; (2) khoá before_value/'
  'after_value/entity/change_type/amazon_entity_id sau khi tạo — người duyệt phải '
  'duyệt đúng nội dung đã đề xuất; (3) tự điền decided_at/applied_at/batch_id.';

drop trigger if exists trg_change_request_guard on ads.change_requests;
create trigger trg_change_request_guard
  before insert or update on ads.change_requests
  for each row execute function ads.change_request_guard();

-- ----------------------------------------------------------------------------
-- C2c. TRIGGER audit — MỌI chuyển trạng thái đều vào iam.audit_logs
-- ----------------------------------------------------------------------------
create or replace function ads.change_request_audit()
returns trigger
language plpgsql
set search_path = ads, iam, public, pg_catalog
as $$
declare
  v_actor  uuid;
  v_action text;
  v_before jsonb;
  v_after  jsonb;
  v_result text := 'ok';
  v_entity text;
begin
  v_entity := coalesce(nullif(new.label, ''), nullif(new.amazon_entity_id, ''),
                       nullif(new.campaign_id, ''), new.id::text);

  if tg_op = 'INSERT' then
    v_actor  := new.proposed_by;
    v_action := 'ppc.propose';
    v_before := null;
    v_after  := jsonb_build_object(
      'status', new.status, 'entity_type', new.entity_type, 'change_type', new.change_type,
      'amazon_entity_id', new.amazon_entity_id, 'campaign_id', new.campaign_id,
      'ad_group_id', new.ad_group_id, 'match_type', new.match_type,
      'before_value', new.before_value, 'after_value', new.after_value,
      'delta_pct', new.delta_pct, 'requires_approval', new.requires_approval,
      'source', new.source, 'reason', new.reason, 'expires_at', new.expires_at);
  else
    if old.status = new.status then
      return new;                    -- không đổi trạng thái → không audit (tránh rác)
    end if;
    -- actor: phiên đăng nhập nếu có; cron thì NULL và ghi rõ "by=cron"
    v_actor := coalesce(auth.uid(),
                        case when new.decided_by is distinct from old.decided_by
                             then new.decided_by end);
    v_action := 'ppc.' || new.status;
    v_before := jsonb_build_object('status', old.status, 'attempts', old.attempts,
                                   'last_error', old.last_error);
    v_after  := jsonb_build_object(
      'status', new.status, 'entity_type', new.entity_type, 'change_type', new.change_type,
      'amazon_entity_id', new.amazon_entity_id, 'campaign_id', new.campaign_id,
      'ad_group_id', new.ad_group_id, 'before_value', new.before_value,
      'after_value', new.after_value, 'delta_pct', new.delta_pct,
      'attempts', new.attempts, 'batch_id', new.batch_id,
      'decision_note', new.decision_note, 'amazon_response', new.amazon_response,
      'by', case when auth.uid() is null then 'cron' else 'user' end);
    if new.status in ('failed','skipped') then
      v_result := 'error: ' || coalesce(nullif(new.last_error, ''), new.status);
    end if;
  end if;

  insert into iam.audit_logs (actor_id, seller_account_id, module, action, entity,
                              before_value, after_value, result)
  values (v_actor, new.seller_account_id, 'ads', v_action, v_entity,
          v_before, v_after, v_result);

  return new;
end;
$$;

comment on function ads.change_request_audit() is
  'C: audit tự động cho hàng đợi PPC — ghi iam.audit_logs (module=ads) lúc tạo đề '
  'xuất (ppc.propose) và mỗi lần đổi trạng thái (ppc.approved / ppc.rejected / '
  'ppc.applying / ppc.applied / ppc.failed / ppc.skipped / ppc.expired) kèm '
  'before/after jsonb. Cron chạy không có auth.uid() → actor_id NULL và '
  'after_value.by = "cron" (không mạo danh người duyệt).';

drop trigger if exists trg_change_request_audit on ads.change_requests;
create trigger trg_change_request_audit
  after insert or update on ads.change_requests
  for each row execute function ads.change_request_audit();

-- ----------------------------------------------------------------------------
-- C3. ads.negative_keywords — bản sao từ khoá phủ định đang có hiệu lực
-- ----------------------------------------------------------------------------
-- Vì sao cần bảng này (chứ không chỉ dựa vào danh sách gợi ý):
--   • gợi ý negative KHÔNG được lặp lại từ khoá đã phủ định (đỡ rác + đỡ gọi Amazon
--     để rồi nhận lỗi duplicate);
--   • khi Amazon trả 207 success cho POST /sp/negativeKeywords, phải lưu id thật
--     (negativeKeywordId) để sau này bật/tắt/xoá;
--   • đối chiếu: cron đọc POST /sp/negativeKeywords/list sẽ upsert lại (source='api').
create table if not exists ads.negative_keywords (
  id                 uuid primary key default gen_random_uuid(),
  seller_account_id  uuid not null references connections.seller_accounts(id) on delete cascade,
  ads_profile_id     text not null default '',
  campaign_id        text not null default '',
  campaign_name      text,
  /** '' = phủ định cấp CAMPAIGN (sp/campaignNegativeKeywords) */
  ad_group_id        text not null default '',
  ad_group_name      text,
  keyword_text       text not null,
  match_type         text not null default 'NEGATIVE_EXACT'
                     check (match_type in ('NEGATIVE_EXACT','NEGATIVE_PHRASE')),
  level              text not null default 'ad_group'
                     check (level in ('ad_group','campaign')),
  /** id Amazon: negativeKeywordId hoặc campaignNegativeKeywordId */
  amazon_negative_id text not null default '',
  state              text not null default 'ENABLED'
                     check (state in ('ENABLED','PAUSED')),
  source             text not null default 'vexim' check (source in ('vexim','api','import')),
  change_request_id  uuid references ads.change_requests(id) on delete set null,
  created_at         timestamptz not null default now(),
  last_synced_at     timestamptz,
  updated_at         timestamptz not null default now()
);

comment on table ads.negative_keywords is
  'C: từ khoá phủ định đã THÊM (hoặc đã có sẵn trên Amazon, source=api). Khoá khử '
  'trùng theo (shop, campaign, ad_group, lower(keyword_text), match_type) — một từ '
  'phủ định ở ad_group khác là một dòng khác. level=campaign thì ad_group_id = "".';

create unique index if not exists uq_negative_keywords_key
  on ads.negative_keywords (seller_account_id, campaign_id, ad_group_id,
                            lower(btrim(keyword_text)), match_type);
create index if not exists idx_negative_keywords_shop
  on ads.negative_keywords (seller_account_id, created_at desc);
create index if not exists idx_negative_keywords_request
  on ads.negative_keywords (change_request_id) where change_request_id is not null;

create or replace function ads.negative_keyword_touch()
returns trigger
language plpgsql
set search_path = ads, pg_catalog
as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' and new.source = 'api' then
    new.last_synced_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_negative_keyword_touch on ads.negative_keywords;
create trigger trg_negative_keyword_touch
  before insert or update on ads.negative_keywords
  for each row execute function ads.negative_keyword_touch();

-- ----------------------------------------------------------------------------
-- C3b. RLS cho 3 bảng mới (đọc theo shop; GHI chỉ qua RPC/service_role)
-- ----------------------------------------------------------------------------
alter table ads.ppc_policies     enable row level security;
alter table ads.change_requests  enable row level security;
alter table ads.negative_keywords enable row level security;

drop policy if exists "ppc_policies: đọc theo shop" on ads.ppc_policies;
create policy "ppc_policies: đọc theo shop" on ads.ppc_policies
  for select to authenticated using (iam.can_read_seller_account(seller_account_id));

-- CỐ Ý KHÔNG có policy insert/update cho authenticated trên ads.ppc_policies:
-- đổi guardrail phải đi qua public.vexim_ppc_set_policy() để (a) chỉ approver làm
-- được, (b) có audit before/after. Ghi thẳng qua PostgREST sẽ không để lại dấu vết
-- mà guardrail lại là thứ quyết định tiền có bị đốt hay không.
drop policy if exists "change_requests: đọc theo shop" on ads.change_requests;
create policy "change_requests: đọc theo shop" on ads.change_requests
  for select to authenticated using (iam.can_read_seller_account(seller_account_id));

-- CỐ Ý KHÔNG có policy insert/update/delete cho authenticated trên change_requests:
-- mọi đường ghi phải đi qua RPC (để còn validate ngưỡng + không tự duyệt được).
drop policy if exists "negative_keywords: đọc theo shop" on ads.negative_keywords;
create policy "negative_keywords: đọc theo shop" on ads.negative_keywords
  for select to authenticated using (iam.can_read_seller_account(seller_account_id));

grant select on ads.ppc_policies, ads.change_requests, ads.negative_keywords to authenticated;
grant all    on ads.ppc_policies, ads.change_requests, ads.negative_keywords to service_role;

-- ----------------------------------------------------------------------------
-- C4. RPC — ĐỀ XUẤT thay đổi (người dùng; validate ngưỡng ngay tại đây)
-- ----------------------------------------------------------------------------
-- p_payload:
-- {
--   "seller_account_id": "uuid",
--   "ads_profile_id": "1234567890",        -- tuỳ chọn; '' thì worker tự tìm default
--   "source": "manual" | "suggestion" | "import",
--   "reason": "ACOS 7 ngày 78% vượt ngưỡng 25%",
--   "items": [
--     { "entity_type":"keyword", "change_type":"bid",
--       "amazon_entity_id":"1234", "campaign_id":"999", "ad_group_id":"888",
--       "label":"dầu gội thảo dược", "currency":"USD",
--       "before_value":{"bid":1.20,"state":"ENABLED"}, "after_value":{"bid":1.02},
--       "reason":"…", "suggestion_key":"bid|1234" },
--     { "entity_type":"negative_keyword", "change_type":"create",
--       "campaign_id":"999", "ad_group_id":"888", "label":"free sample",
--       "match_type":"NEGATIVE_EXACT", "after_value":{"keyword_text":"free sample"} }
--   ]
-- }
-- Trả: {ok, inserted, duplicates, blocked, ids[], warnings[], policy}
create or replace function public.vexim_ppc_propose_changes(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ads, iam, connections, public, pg_catalog
as $$
declare
  v_actor   uuid := auth.uid();
  v_shop    uuid;
  v_pol     jsonb;
  v_profile text;
  v_source  text;
  v_reason  text;
  v_items   jsonb;
  v_item    jsonb;
  v_entity  text;  v_change text;  v_amz text;
  v_campaign text; v_adgroup text; v_label text; v_match text; v_currency text; v_key text;
  v_before  jsonb; v_after jsonb; v_num_field text;
  v_num_before numeric; v_num_after numeric; v_delta numeric;
  v_max_pct numeric; v_floor numeric; v_ceiling numeric;
  v_req     boolean; v_status text; v_note text; v_id uuid;
  v_expires timestamptz;
  v_ids     uuid[] := array[]::uuid[];
  v_warnings jsonb := '[]'::jsonb;
  n_ins int := 0; n_dup int := 0; n_block int := 0;
  v_open int; v_max_open int;
begin
  if v_actor is null then
    raise exception '[PPC] RPC này cần phiên đăng nhập' using errcode = 'insufficient_privilege';
  end if;

  begin
    v_shop := nullif(btrim(coalesce(p_payload->>'seller_account_id', '')), '')::uuid;
  exception when others then
    raise exception '[PPC] seller_account_id không phải uuid hợp lệ'
      using errcode = 'invalid_parameter_value';
  end;
  if v_shop is null then
    raise exception '[PPC] thiếu seller_account_id' using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select 1 from connections.seller_accounts s where s.id = v_shop) then
    raise exception '[PPC] không tìm thấy shop %', v_shop using errcode = 'no_data_found';
  end if;
  if not iam.can_write_seller_account(v_shop) then
    raise exception '[PPC] bạn không có quyền ghi trên shop này (cần assignment can_write '
                    'ở module ads, hoặc vai super_admin)'
      using errcode = 'insufficient_privilege';
  end if;

  v_pol     := ads.ppc_policy(v_shop);
  v_profile := btrim(coalesce(p_payload->>'ads_profile_id', ''));
  v_source  := lower(btrim(coalesce(p_payload->>'source', 'manual')));
  if v_source not in ('manual','suggestion','import') then v_source := 'manual'; end if;
  v_reason  := nullif(btrim(coalesce(p_payload->>'reason', '')), '');
  v_items   := coalesce(p_payload->'items', '[]'::jsonb);
  if jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) = 0 then
    raise exception '[PPC] thiếu items (mảng đề xuất) hoặc mảng rỗng'
      using errcode = 'invalid_parameter_value';
  end if;
  if jsonb_array_length(v_items) > 500 then
    raise exception '[PPC] tối đa 500 đề xuất mỗi lần (đang gửi %) — chia nhỏ để dễ duyệt',
                    jsonb_array_length(v_items)
      using errcode = 'program_limit_exceeded';
  end if;

  v_expires  := now() + make_interval(hours => (v_pol->>'proposal_ttl_hours')::int);
  v_max_open := (v_pol->>'max_open_requests')::int;
  select count(*) into v_open
  from ads.change_requests r
  where r.seller_account_id = v_shop
    and r.status in ('proposed','approved','applying');
  if v_open >= v_max_open then
    raise exception '[PPC] shop đang có % đề xuất mở — vượt trần % trong policy. '
                    'Duyệt/từ chối bớt (hoặc tăng max_open_requests) rồi đề xuất tiếp.',
                    v_open, v_max_open
      using errcode = 'program_limit_exceeded';
  end if;

  for v_item in select * from jsonb_array_elements(v_items) loop
    v_entity   := lower(btrim(coalesce(v_item->>'entity_type', '')));
    v_change   := lower(btrim(coalesce(v_item->>'change_type', '')));
    v_amz      := btrim(coalesce(v_item->>'amazon_entity_id', ''));
    v_campaign := btrim(coalesce(v_item->>'campaign_id', ''));
    v_adgroup  := btrim(coalesce(v_item->>'ad_group_id', ''));
    v_label    := btrim(coalesce(v_item->>'label', ''));
    v_match    := nullif(upper(btrim(coalesce(v_item->>'match_type', ''))), '');
    v_currency := upper(btrim(coalesce(nullif(v_item->>'currency', ''), v_pol->>'currency', 'USD')));
    v_key      := nullif(btrim(coalesce(v_item->>'suggestion_key', '')), '');
    v_before   := case when jsonb_typeof(v_item->'before_value') = 'object'
                       then v_item->'before_value' end;
    v_after    := case when jsonb_typeof(v_item->'after_value') = 'object'
                       then v_item->'after_value' else '{}'::jsonb end;
    v_note     := nullif(btrim(coalesce(v_item->>'reason', '')), '');
    v_delta    := null;
    v_num_before := null; v_num_after := null;
    v_floor := null; v_ceiling := null; v_max_pct := null;

    -- (1) cặp entity_type × change_type hợp lệ?
    if not (
         (v_entity = 'campaign'                 and v_change in ('budget','state','name'))
      or (v_entity = 'keyword'                  and v_change in ('bid','state'))
      or (v_entity = 'ad_group'                 and v_change = 'state')
      or (v_entity = 'negative_keyword'         and v_change = 'create')
      or (v_entity = 'campaign_negative_keyword' and v_change = 'create')
    ) then
      v_warnings := v_warnings || jsonb_build_object(
        'label', v_label, 'blocked',
        format('cặp entity_type=%s × change_type=%s không hỗ trợ', v_entity, v_change));
      n_block := n_block + 1;
      continue;
    end if;

    -- (2) id Amazon bắt buộc với thay đổi trên thực thể CÓ SẴN
    if v_change <> 'create' and v_amz = '' then
      v_warnings := v_warnings || jsonb_build_object(
        'label', v_label, 'blocked',
        'thiếu amazon_entity_id (campaignId/keywordId) — không biết sửa cái gì trên Amazon');
      n_block := n_block + 1;
      continue;
    end if;
    if v_change = 'create' and v_entity like '%negative_keyword' and v_label = '' then
      v_warnings := v_warnings || jsonb_build_object(
        'label', v_label, 'blocked', 'thiếu keyword_text cho negative keyword');
      n_block := n_block + 1;
      continue;
    end if;

    -- (3) negative keyword: chuẩn hoá match_type + level theo SP v3
    if v_entity in ('negative_keyword','campaign_negative_keyword') then
      if v_match is null then
        v_match := 'NEGATIVE_EXACT';
      elsif v_match in ('NEGATIVEEXACT','NEGATIVE EXACT','EXACT') then
        v_match := 'NEGATIVE_EXACT';
      elsif v_match in ('NEGATIVEPHRASE','NEGATIVE PHRASE','PHRASE') then
        v_match := 'NEGATIVE_PHRASE';
      elsif v_match not in ('NEGATIVE_EXACT','NEGATIVE_PHRASE') then
        v_warnings := v_warnings || jsonb_build_object(
          'label', v_label, 'blocked',
          format('match_type %s không hợp lệ (SP v3 chỉ nhận NEGATIVE_EXACT/NEGATIVE_PHRASE)', v_match));
        n_block := n_block + 1;
        continue;
      end if;
      if v_entity = 'campaign_negative_keyword' then v_adgroup := ''; end if;
      if v_entity = 'negative_keyword' and v_adgroup = '' then
        v_warnings := v_warnings || jsonb_build_object(
          'label', v_label, 'blocked',
          'negative keyword cấp ad_group cần ad_group_id (cấp campaign thì dùng '
          'entity_type=campaign_negative_keyword)');
        n_block := n_block + 1;
        continue;
      end if;
      if v_campaign = '' then
        v_warnings := v_warnings || jsonb_build_object(
          'label', v_label, 'blocked', 'negative keyword cần campaign_id');
        n_block := n_block + 1;
        continue;
      end if;
      -- đã phủ định rồi thì đừng đề xuất nữa (Amazon sẽ trả lỗi duplicate)
      if exists (select 1 from ads.negative_keywords nk
                  where nk.seller_account_id = v_shop
                    and nk.campaign_id = v_campaign
                    and nk.ad_group_id = v_adgroup
                    and lower(btrim(nk.keyword_text)) = lower(btrim(v_label))
                    and nk.match_type = v_match
                    and nk.state = 'ENABLED') then
        v_warnings := v_warnings || jsonb_build_object(
          'label', v_label, 'duplicate', 'từ này ĐÃ được phủ định rồi');
        n_dup := n_dup + 1;
        continue;
      end if;
      v_after := v_after
        || jsonb_build_object('keyword_text', v_label, 'match_type', v_match,
                              'campaign_id', v_campaign, 'ad_group_id', v_adgroup,
                              'level', case when v_adgroup = '' then 'campaign' else 'ad_group' end);
    end if;

    -- (4) bid/budget: đọc con số, tính delta, kiểm sàn/trần
    if v_change in ('bid','budget') then
      v_num_field  := case when v_change = 'bid' then 'bid' else 'budget' end;
      v_num_before := ads.num_or_null(v_before->>v_num_field);
      v_num_after  := ads.num_or_null(v_after->>v_num_field);
      if v_num_after is null or v_num_after <= 0 then
        v_warnings := v_warnings || jsonb_build_object(
          'label', v_label, 'blocked',
          format('after_value.%s phải là số dương', v_num_field));
        n_block := n_block + 1;
        continue;
      end if;
      if v_num_before is not null and v_num_before > 0 then
        v_delta := round(100.0 * (v_num_after - v_num_before) / v_num_before, 2);
      end if;
      if v_change = 'bid' then
        v_floor   := (v_pol->>'bid_floor')::numeric;
        v_ceiling := (v_pol->>'bid_ceiling')::numeric;
        v_max_pct := (v_pol->>'max_bid_change_pct')::numeric;
      else
        v_floor   := (v_pol->>'budget_floor')::numeric;
        v_ceiling := (v_pol->>'budget_ceiling')::numeric;
        v_max_pct := (v_pol->>'max_budget_change_pct')::numeric;
      end if;
      if (v_floor is not null and v_num_after < v_floor)
         or (v_ceiling is not null and v_num_after > v_ceiling) then
        v_warnings := v_warnings || jsonb_build_object(
          'label', v_label, 'blocked',
          format('%s = %s vượt sàn/trần trong policy (%s..%s) — sửa policy trước',
                 v_num_field, v_num_after,
                 coalesce(v_floor::text, '-'), coalesce(v_ceiling::text, '-')));
        n_block := n_block + 1;
        continue;
      end if;
      if v_delta is not null and v_delta = 0 then
        v_warnings := v_warnings || jsonb_build_object(
          'label', v_label, 'duplicate', 'giá trị mới bằng giá trị hiện tại — không có gì để đổi');
        n_dup := n_dup + 1;
        continue;
      end if;
    end if;

    -- (5) state: chỉ nhận trạng thái Amazon hiểu
    if v_change = 'state' then
      v_after := v_after || jsonb_build_object(
        'state', upper(btrim(coalesce(v_after->>'state', ''))));
      if coalesce(v_after->>'state', '') not in ('ENABLED','PAUSED','ARCHIVED') then
        v_warnings := v_warnings || jsonb_build_object(
          'label', v_label, 'blocked',
          'after_value.state phải là ENABLED / PAUSED / ARCHIVED');
        n_block := n_block + 1;
        continue;
      end if;
    end if;

    -- (6) có cần duyệt không?
    if v_change in ('bid','budget') then
      v_req := not ((v_pol->>'auto_apply')::boolean
                    and v_delta is not null
                    and abs(v_delta) <= v_max_pct);
    else
      -- state/name/create: chỉ tự duyệt khi policy MỞ CẢ HAI khoá
      v_req := not ((v_pol->>'auto_apply')::boolean
                    and not (v_pol->>'require_approval_state')::boolean);
    end if;
    -- before_value chưa biết (NULL/không có số) → KHÔNG tự duyệt: cron sẽ phải so
    -- lại Amazon, và người duyệt cần nhìn thấy "chưa biết giá hiện tại".
    if v_change in ('bid','budget') and v_num_before is null then
      v_req := true;
    end if;

    v_status := case when v_req then 'proposed' else 'approved' end;
    v_note   := case when v_req then v_note
                     else coalesce(v_note || ' · ', '') || 'tự duyệt theo policy (trong ngưỡng)'
                end;

    insert into ads.change_requests (
      seller_account_id, ads_profile_id, entity_type, change_type, amazon_entity_id,
      campaign_id, ad_group_id, label, match_type, currency, before_value, after_value,
      delta_pct, requires_approval, reason, source, suggestion_key, status,
      proposed_by, expires_at, decided_at, decision_note)
    values (
      v_shop, v_profile, v_entity, v_change, v_amz,
      v_campaign, v_adgroup, v_label, v_match, v_currency, v_before, v_after,
      v_delta, v_req, coalesce(v_note, v_reason), v_source, v_key, v_status,
      v_actor, v_expires, case when v_req then null else now() end,
      case when v_req then null else v_note end)
    on conflict (seller_account_id, entity_type, change_type, amazon_entity_id,
                 lower(coalesce(ad_group_id, '')), lower(coalesce(label, '')))
         where status in ('proposed','approved','applying')
    do nothing
    returning id into v_id;

    if v_id is null then
      n_dup := n_dup + 1;
      v_warnings := v_warnings || jsonb_build_object(
        'label', v_label, 'duplicate', 'đã có đề xuất MỞ cho đúng thực thể + loại thay đổi này');
    else
      n_ins := n_ins + 1;
      v_ids := v_ids || v_id;
      v_id  := null;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true, 'seller_account_id', v_shop,
    'inserted', n_ins, 'duplicates', n_dup, 'blocked', n_block,
    'ids', to_jsonb(v_ids), 'warnings', v_warnings,
    'open_before', v_open, 'expires_at', v_expires,
    'auto_applied', (v_pol->>'auto_apply')::boolean,
    'policy', v_pol);
end;
$$;

comment on function public.vexim_ppc_propose_changes(jsonb) is
  'C: tạo đề xuất thay đổi PPC (bid/budget/state/name/negative keyword). Validate tại '
  'chỗ: cặp entity×change hợp lệ, id Amazon bắt buộc, match_type phủ định theo SP v3 '
  '(NEGATIVE_EXACT/NEGATIVE_PHRASE), sàn/trần bid & budget là CHẶN HẲN, % thay đổi '
  'quá ngưỡng thì requires_approval=true. Không insert được vì trùng đề xuất đang mở '
  '→ đếm duplicates (không nổ cả lô). Trả warnings để UI chỉ đúng dòng sai.';

revoke all on function public.vexim_ppc_propose_changes(jsonb) from public, anon;
grant execute on function public.vexim_ppc_propose_changes(jsonb) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- C5. RPC — DUYỆT / TỪ CHỐI một đề xuất (chỉ approver; có audit)
-- ----------------------------------------------------------------------------
create or replace function public.vexim_ppc_decide_change(
  p_request_id uuid,
  p_decision   text,
  p_note       text default null)
returns jsonb
language plpgsql
security definer
set search_path = ads, iam, public, pg_catalog
as $$
declare
  v_actor uuid := auth.uid();
  v_dec   text := lower(btrim(coalesce(p_decision, '')));
  v_row   ads.change_requests%rowtype;
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
  v_new   text;
begin
  if v_actor is null then
    raise exception '[PPC] RPC này cần phiên đăng nhập' using errcode = 'insufficient_privilege';
  end if;
  if not iam.is_ppc_approver() then
    raise exception '[PPC] chỉ admin hoặc trưởng phòng PPC được duyệt thay đổi quảng cáo'
      using errcode = 'insufficient_privilege';
  end if;
  if v_dec not in ('approve','reject') then
    raise exception '[PPC] p_decision phải là approve hoặc reject (nhận %)', p_decision
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_row from ads.change_requests where id = p_request_id for update;
  if not found then
    raise exception '[PPC] không tìm thấy đề xuất %', p_request_id using errcode = 'no_data_found';
  end if;
  if not iam.can_read_seller_account(v_row.seller_account_id) then
    raise exception '[PPC] bạn không có quyền trên shop của đề xuất này'
      using errcode = 'insufficient_privilege';
  end if;
  if v_row.status not in ('proposed','failed') then
    raise exception '[PPC] đề xuất đang ở trạng thái % — không duyệt/từ chối được nữa',
                    v_row.status
      using errcode = 'check_violation';
  end if;
  if v_row.expires_at is not null and v_row.expires_at < now() then
    raise exception '[PPC] đề xuất đã quá hạn (%) — số liệu cũ, hãy sinh đề xuất mới '
                    'từ dữ liệu mới nhất', to_char(v_row.expires_at, 'YYYY-MM-DD HH24:MI')
      using errcode = 'check_violation';
  end if;
  -- Tự duyệt: cho phép (team nhỏ một người vừa đề xuất vừa duyệt) nhưng GHI RÕ vào
  -- decision_note → hiện trên UI và nằm trong audit log.
  if v_row.proposed_by = v_actor then
    v_note := coalesce(v_note || ' · ', '') || 'tự duyệt đề xuất của chính mình';
  end if;

  v_new := case when v_dec = 'approve' then 'approved' else 'rejected' end;

  update ads.change_requests r
     set status        = v_new,
         decided_by    = v_actor,
         decided_at    = now(),
         decision_note = v_note
   where r.id = p_request_id;

  return jsonb_build_object(
    'ok', true, 'id', p_request_id, 'status', v_new,
    'label', v_row.label, 'entity_type', v_row.entity_type,
    'change_type', v_row.change_type, 'delta_pct', v_row.delta_pct,
    'currency', v_row.currency, 'decided_by', v_actor, 'note', v_note);
end;
$$;

comment on function public.vexim_ppc_decide_change(uuid, text, text) is
  'C: approve/reject MỘT đề xuất. Chỉ approver (admin hoặc dept_lead phòng ppc); '
  'chỉ duyệt được khi còn proposed/failed và CHƯA quá TTL. Tự duyệt đề xuất của '
  'chính mình thì bị ghi chú thẳng vào decision_note + audit log.';

-- ----------------------------------------------------------------------------
-- C5b. RPC — duyệt/từ chối THEO LÔ (một item lỗi không làm hỏng cả lô)
-- ----------------------------------------------------------------------------
create or replace function public.vexim_ppc_decide_bulk(
  p_request_ids jsonb,
  p_decision    text,
  p_note        text default null)
returns jsonb
language plpgsql
security definer
set search_path = ads, iam, public, pg_catalog
as $$
declare
  v_ids   uuid[];
  v_id    uuid;
  v_one   jsonb;
  n_ok    int := 0;
  n_err   int := 0;
  v_errors jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(coalesce(p_request_ids, '[]'::jsonb)) <> 'array' then
    raise exception '[PPC] p_request_ids phải là mảng uuid' using errcode = 'invalid_parameter_value';
  end if;
  begin
    select array_agg(nullif(btrim(x #>> '{}'), '')::uuid)
      into v_ids
    from jsonb_array_elements(p_request_ids) x;
  exception when others then
    raise exception '[PPC] p_request_ids chứa phần tử không phải uuid'
      using errcode = 'invalid_parameter_value';
  end;
  if v_ids is null or cardinality(v_ids) = 0 then
    return jsonb_build_object('ok', true, 'approved', 0, 'failed', 0, 'errors', '[]'::jsonb);
  end if;
  if cardinality(v_ids) > 500 then
    raise exception '[PPC] tối đa 500 đề xuất mỗi lần duyệt' using errcode = 'program_limit_exceeded';
  end if;

  foreach v_id in array v_ids loop
    begin
      v_one := public.vexim_ppc_decide_change(v_id, p_decision, p_note);
      n_ok  := n_ok + 1;
    exception when others then
      n_err    := n_err + 1;
      v_errors := v_errors || jsonb_build_object('id', v_id, 'error', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('ok', n_err = 0, 'decision', lower(btrim(p_decision)),
                            'decided', n_ok, 'failed', n_err, 'errors', v_errors);
end;
$$;

comment on function public.vexim_ppc_decide_bulk(jsonb, text, text) is
  'C: duyệt/từ chối nhiều đề xuất một lượt (UI "Duyệt tất cả"). Một dòng lỗi (đã '
  'duyệt rồi, quá TTL…) được ghi vào errors và KHÔNG làm rollback cả lô.';

revoke all on function public.vexim_ppc_decide_change(uuid, text, text) from public, anon;
revoke all on function public.vexim_ppc_decide_bulk(jsonb, text, text)   from public, anon;
grant execute on function public.vexim_ppc_decide_change(uuid, text, text) to authenticated, service_role;
grant execute on function public.vexim_ppc_decide_bulk(jsonb, text, text)   to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- C6. RPC — sửa guardrail (policy) + audit
-- ----------------------------------------------------------------------------
create or replace function public.vexim_ppc_set_policy(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ads, iam, connections, public, pg_catalog
as $$
declare
  v_actor uuid := auth.uid();
  v_shop  uuid;
  v_old   jsonb;
  v_new   ads.ppc_policies%rowtype;
  v_patch jsonb;
begin
  if v_actor is null then
    raise exception '[PPC] RPC này cần phiên đăng nhập' using errcode = 'insufficient_privilege';
  end if;
  if not iam.is_ppc_approver() then
    raise exception '[PPC] chỉ admin hoặc trưởng phòng PPC được đổi guardrail'
      using errcode = 'insufficient_privilege';
  end if;
  begin
    v_shop := nullif(btrim(coalesce(p_payload->>'seller_account_id', '')), '')::uuid;
  exception when others then
    raise exception '[PPC] seller_account_id không phải uuid hợp lệ'
      using errcode = 'invalid_parameter_value';
  end;
  if v_shop is null then
    raise exception '[PPC] thiếu seller_account_id' using errcode = 'invalid_parameter_value';
  end if;
  if not iam.can_write_seller_account(v_shop) then
    raise exception '[PPC] bạn không có quyền ghi trên shop này' using errcode = 'insufficient_privilege';
  end if;

  v_old   := ads.ppc_policy(v_shop);
  -- Chỉ nhận đúng các khoá guardrail; khoá lạ bị bỏ qua (không cho ghi cột tuỳ ý).
  v_patch := coalesce(p_payload->'policy', '{}'::jsonb)
             - 'seller_account_id' - 'has_row' - 'updated_at';

  -- INSERT phải áp patch NGAY (shop chưa có dòng policy): nếu chỉ insert khoá rồi
  -- nhờ ON CONFLICT sửa thì lần đặt guardrail ĐẦU TIÊN bị bỏ qua toàn bộ.
  insert into ads.ppc_policies as p (
    seller_account_id, auto_apply, require_approval_state, max_bid_change_pct,
    max_budget_change_pct, bid_floor, bid_ceiling, budget_floor, budget_ceiling,
    daily_change_cap, max_open_requests, proposal_ttl_hours, suggestion_min_clicks,
    suggestion_min_spend, suggestion_acos_lower_pct, bid_step_pct, currency, notes,
    updated_by, updated_at)
  values (
    v_shop,
    coalesce((v_patch->>'auto_apply')::boolean, false),
    coalesce((v_patch->>'require_approval_state')::boolean, true),
    coalesce((v_patch->>'max_bid_change_pct')::numeric, 20),
    coalesce((v_patch->>'max_budget_change_pct')::numeric, 30),
    ads.num_or_null(v_patch->>'bid_floor'),
    ads.num_or_null(v_patch->>'bid_ceiling'),
    ads.num_or_null(v_patch->>'budget_floor'),
    ads.num_or_null(v_patch->>'budget_ceiling'),
    coalesce((v_patch->>'daily_change_cap')::int, 50),
    coalesce((v_patch->>'max_open_requests')::int, 100),
    coalesce((v_patch->>'proposal_ttl_hours')::int, 72),
    coalesce((v_patch->>'suggestion_min_clicks')::int, 3),
    coalesce((v_patch->>'suggestion_min_spend')::numeric, 1),
    coalesce((v_patch->>'suggestion_acos_lower_pct')::numeric, 50),
    coalesce((v_patch->>'bid_step_pct')::numeric, 15),
    coalesce(nullif(upper(btrim(coalesce(v_patch->>'currency', ''))), ''), 'USD'),
    nullif(btrim(coalesce(v_patch->>'notes', '')), ''),
    v_actor, now())
  on conflict (seller_account_id) do update
     set auto_apply                = coalesce((v_patch->>'auto_apply')::boolean, p.auto_apply),
         require_approval_state    = coalesce((v_patch->>'require_approval_state')::boolean, p.require_approval_state),
         max_bid_change_pct        = coalesce((v_patch->>'max_bid_change_pct')::numeric, p.max_bid_change_pct),
         max_budget_change_pct     = coalesce((v_patch->>'max_budget_change_pct')::numeric, p.max_budget_change_pct),
         bid_floor                 = case when v_patch ? 'bid_floor'
                                          then ads.num_or_null(v_patch->>'bid_floor') else p.bid_floor end,
         bid_ceiling               = case when v_patch ? 'bid_ceiling'
                                          then ads.num_or_null(v_patch->>'bid_ceiling') else p.bid_ceiling end,
         budget_floor              = case when v_patch ? 'budget_floor'
                                          then ads.num_or_null(v_patch->>'budget_floor') else p.budget_floor end,
         budget_ceiling            = case when v_patch ? 'budget_ceiling'
                                          then ads.num_or_null(v_patch->>'budget_ceiling') else p.budget_ceiling end,
         daily_change_cap          = coalesce((v_patch->>'daily_change_cap')::int, p.daily_change_cap),
         max_open_requests         = coalesce((v_patch->>'max_open_requests')::int, p.max_open_requests),
         proposal_ttl_hours        = coalesce((v_patch->>'proposal_ttl_hours')::int, p.proposal_ttl_hours),
         suggestion_min_clicks     = coalesce((v_patch->>'suggestion_min_clicks')::int, p.suggestion_min_clicks),
         suggestion_min_spend      = coalesce((v_patch->>'suggestion_min_spend')::numeric, p.suggestion_min_spend),
         suggestion_acos_lower_pct = coalesce((v_patch->>'suggestion_acos_lower_pct')::numeric, p.suggestion_acos_lower_pct),
         bid_step_pct              = coalesce((v_patch->>'bid_step_pct')::numeric, p.bid_step_pct),
         currency                  = coalesce(nullif(upper(btrim(coalesce(v_patch->>'currency', ''))), ''), p.currency),
         notes                     = case when v_patch ? 'notes'
                                        then nullif(btrim(coalesce(v_patch->>'notes', '')), '') else p.notes end,
         updated_by                = v_actor,
         updated_at                = now()
  returning * into v_new;

  insert into iam.audit_logs (actor_id, seller_account_id, module, action, entity,
                              before_value, after_value, result)
  values (v_actor, v_shop, 'ads', 'ppc.policy.update', v_new.currency,
          v_old, ads.ppc_policy(v_shop), 'ok');

  return jsonb_build_object('ok', true, 'seller_account_id', v_shop,
                            'policy', ads.ppc_policy(v_shop), 'before', v_old);
end;
$$;

comment on function public.vexim_ppc_set_policy(jsonb) is
  'C: ghi guardrail PPC của shop (chỉ approver). Nhận {seller_account_id, policy:{…}} '
  '— khoá lạ bị bỏ, khoá vắng mặt giữ nguyên giá trị cũ. Audit before/after toàn bộ '
  'policy vào iam.audit_logs (action ppc.policy.update). Ràng buộc sàn≤trần, cap, TTL '
  'do CHECK của bảng lo (sai là nổ, không lưu policy vô nghĩa).';

revoke all on function public.vexim_ppc_set_policy(jsonb) from public, anon;
grant execute on function public.vexim_ppc_set_policy(jsonb) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- C7. RPC — WORKER lấy lô đề xuất ĐÃ DUYỆT (chỉ service_role)
-- ----------------------------------------------------------------------------
-- Làm 5 việc theo thứ tự, trong MỘT lần gọi (để cron chỉ cần một RPC):
--   1. quét TTL: proposed/approved quá expires_at → expired;
--   2. đòi lại lô kẹt: applying quá p_stale_minutes (cron trước chết giữa chừng) → approved;
--   3. tự skip đề xuất KHÔNG thuộc Sponsored Products (chiều ghi chỉ mở cho SP);
--   4. chọn lô theo TRẦN THAY ĐỔI TRONG NGÀY của từng shop (policy.daily_change_cap
--      trừ số đã áp dụng/đang áp dụng hôm nay) — ưu tiên đề xuất duyệt trước;
--   5. "giành" lô: status approved → applying + batch_id + attempts+1 (hai cron chạy
--      song song cũng không áp dụng trùng vì UPDATE có điều kiện status='approved').
-- Trả jsonb: {ok, batch_id, expired, reclaimed, skipped_unsupported, count, cap_left, requests[]}
create or replace function public.vexim_worker_ppc_pending_changes(
  p_seller        uuid default null,
  p_limit         int  default 100,
  p_stale_minutes int  default 30
)
returns jsonb
language plpgsql
security definer
set search_path = ads, ops, connections, public, pg_catalog
as $$
declare
  v_batch   uuid := gen_random_uuid();
  v_ids     uuid[] := array[]::uuid[];
  v_expired int := 0;
  v_reclaim int := 0;
  v_unsup   int := 0;
  v_rows    jsonb := '[]'::jsonb;
  v_caps    jsonb := '[]'::jsonb;
  v_limit   int := least(greatest(coalesce(p_limit, 100), 1), 500);
begin
  if auth.uid() is not null then
    raise exception '[PPC] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;

  -- (1) quét TTL
  with swept as (
    update ads.change_requests r
       set status     = 'expired',
           last_error = 'quá hạn duyệt (TTL policy) — expires_at '
                        || to_char(r.expires_at, 'YYYY-MM-DD HH24:MI') || ' TZ'
     where r.status in ('proposed','approved')
       and r.expires_at is not null
       and r.expires_at < now()
       and (p_seller is null or r.seller_account_id = p_seller)
    returning r.id)
  select count(*) into v_expired from swept;

  -- (2) đòi lại lô kẹt
  with reclaimed as (
    update ads.change_requests r
       set status     = 'approved',
           batch_id   = null,
           claimed_at = null,
           last_error = 'lô áp dụng trước không hoàn tất trong '
                        || greatest(coalesce(p_stale_minutes, 30), 1) || ' phút — trả về hàng đợi'
     where r.status = 'applying'
       and coalesce(r.claimed_at, r.updated_at)
             < now() - make_interval(mins => greatest(coalesce(p_stale_minutes, 30), 1))
       and (p_seller is null or r.seller_account_id = p_seller)
    returning r.id)
  select count(*) into v_reclaim from reclaimed;

  -- (3) skip đề xuất không phải Sponsored Products
  with unsup as (
    update ads.change_requests r
       set status     = 'skipped',
           last_error = 'chiều ghi PPC mới mở cho Sponsored Products; campaign này là '
                        || coalesce(c.campaign_type, 'chưa rõ (chưa thấy trong ads.campaigns — chạy ads-sync trước)')
      from ads.campaigns c
     where c.seller_account_id = r.seller_account_id
       and c.campaign_id       = r.campaign_id
       and r.status in ('proposed','approved','applying')
       and lower(coalesce(c.campaign_type, '')) not in ('sp','sponsoredproducts','')
       and (p_seller is null or r.seller_account_id = p_seller)
    returning r.id)
  select count(*) into v_unsup from unsup;

  -- (4) chọn lô theo trần ngày của từng shop
  select coalesce(array_agg(t.id), array[]::uuid[]) into v_ids
  from (
    with cand as (
      select r.id, r.seller_account_id,
             row_number() over (
               partition by r.seller_account_id
               order by r.decided_at asc nulls last, r.proposed_at asc, r.id asc) as rn
      from ads.change_requests r
      where r.status = 'approved'
        and (p_seller is null or r.seller_account_id = p_seller)
    )
    select c.id
    from cand c
    join lateral (
      select (ads.ppc_policy(c.seller_account_id)->>'daily_change_cap')::int as cap) pol on true
    join lateral (
      select count(*) as used
      from ads.change_requests d
      where d.seller_account_id = c.seller_account_id
        and d.status in ('applied','applying')
        and coalesce(d.applied_at, d.updated_at) >= date_trunc('day', now())) u on true
    where c.rn <= greatest(pol.cap - u.used, 0)
    order by c.rn
    limit v_limit
  ) t;

  -- (5) giành lô
  if cardinality(v_ids) > 0 then
    with claimed as (
      update ads.change_requests r
         set status     = 'applying',
             batch_id   = v_batch,
             claimed_at = now(),
             attempts   = r.attempts + 1
       where r.id = any (v_ids)
         and r.status = 'approved'
      returning r.id)
    select coalesce(array_agg(id), array[]::uuid[]) into v_ids from claimed;
  end if;

  if cardinality(v_ids) > 0 then
    select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.decided_at asc), '[]'::jsonb)
      into v_rows
    from (
      select r.id                          as request_id,
             r.seller_account_id,
             sa.display_name               as shop,
             coalesce(nullif(r.ads_profile_id, ''), pf.ads_profile_id, '') as ads_profile_id,
             r.entity_type, r.change_type, r.amazon_entity_id,
             r.campaign_id, r.ad_group_id, r.label, r.match_type, r.currency,
             r.before_value, r.after_value, r.delta_pct, r.attempts, r.batch_id,
             r.decided_at, r.proposed_at, r.expires_at, r.claimed_at,
             c.campaign_type, c.name       as campaign_name,
             c.state                       as campaign_state,
             c.daily_budget                as campaign_daily_budget
      from ads.change_requests r
      join connections.seller_accounts sa on sa.id = r.seller_account_id
      left join lateral (
        select pr.ads_profile_id
        from ads.ad_profiles pr
        where pr.seller_account_id = r.seller_account_id
          and coalesce(pr.ads_profile_id, '') <> ''
        order by pr.is_default desc, pr.first_seen_at asc
        limit 1) pf on true
      left join ads.campaigns c
             on c.seller_account_id = r.seller_account_id and c.campaign_id = r.campaign_id
      where r.id = any (v_ids)
    ) x;

  end if;

  -- Trần ngày của từng shop còn việc (kể cả khi lô này RỖNG) — cron log ra để biết
  -- "vì sao không lấy được dòng nào": hết trần ngày hay thật sự không còn gì để làm.
  select coalesce(jsonb_agg(row_to_json(y)::jsonb), '[]'::jsonb) into v_caps
  from (
    select distinct on (x.seller_account_id)
           x.seller_account_id,
           sa.display_name as shop,
           (ads.ppc_policy(x.seller_account_id)->>'daily_change_cap')::int as daily_cap,
           (select count(*) from ads.change_requests d
             where d.seller_account_id = x.seller_account_id
               and d.status in ('applied','applying')
               and coalesce(d.applied_at, d.updated_at) >= date_trunc('day', now())) as used_today,
           (select count(*) from ads.change_requests q
             where q.seller_account_id = x.seller_account_id
               and q.status = 'approved') as waiting
    from ads.change_requests x
    join connections.seller_accounts sa on sa.id = x.seller_account_id
    where x.status in ('approved','applying')
      and (p_seller is null or x.seller_account_id = p_seller)
    order by x.seller_account_id
  ) y;

  return jsonb_build_object(
    'ok', true, 'batch_id', v_batch,
    'expired', v_expired, 'reclaimed', v_reclaim, 'skipped_unsupported', v_unsup,
    'count', cardinality(v_ids), 'cap_left', v_caps, 'requests', v_rows);
end;
$$;

comment on function public.vexim_worker_ppc_pending_changes(uuid, int, int) is
  'C: worker lấy lô đề xuất ĐÃ DUYỆT để gọi Amazon. Tự quét TTL, đòi lại lô kẹt, '
  'skip campaign không phải SP, tôn trọng daily_change_cap của policy, và "giành" lô '
  'bằng cách chuyển approved → applying + batch_id + claimed_at (không cron nào áp '
  'dụng trùng; claimed_at là mốc để đòi lại lô kẹt vì trigger luôn làm mới updated_at). '
  'Chỉ service_role. Trả jsonb để cron log được expired/reclaimed/count.';

revoke all on function public.vexim_worker_ppc_pending_changes(uuid, int, int)
  from public, anon, authenticated;
grant execute on function public.vexim_worker_ppc_pending_changes(uuid, int, int) to service_role;

-- ----------------------------------------------------------------------------
-- C8. RPC — WORKER ghi kết quả áp dụng (applied / failed / skipped) + audit
-- ----------------------------------------------------------------------------
-- p_payload:
-- { "id":"uuid", "status":"applied|failed|skipped",
--   "batch_id":"uuid", "error":"…", "amazon_response":{…},
--   "created_id":"1234567",            -- id Amazon trả về khi TẠO negative keyword
--   "verified_before": true|false }     -- cron đã đọc lại Amazon và khớp before_value
create or replace function public.vexim_worker_ppc_set_result(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ads, ops, connections, iam, public, pg_catalog
as $$
declare
  v_id     uuid;
  v_status text := lower(btrim(coalesce(p_payload->>'status', '')));
  v_row    ads.change_requests%rowtype;
  v_error  text := nullif(btrim(coalesce(p_payload->>'error', '')), '');
  v_resp   jsonb := case when jsonb_typeof(p_payload->'amazon_response') = 'object'
                         then p_payload->'amazon_response'
                         when jsonb_typeof(p_payload->'amazon_response') = 'array'
                         then jsonb_build_object('items', p_payload->'amazon_response') end;
  v_batch  uuid;
  v_created text;
  v_alert  uuid;
  v_lvl    text;
begin
  if auth.uid() is not null then
    raise exception '[PPC] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if v_status not in ('applied','failed','skipped') then
    raise exception '[PPC] status phải là applied/failed/skipped (nhận %)', p_payload->>'status'
      using errcode = 'invalid_parameter_value';
  end if;
  begin
    v_id := nullif(btrim(coalesce(p_payload->>'id', '')), '')::uuid;
  exception when others then
    raise exception '[PPC] id không phải uuid hợp lệ' using errcode = 'invalid_parameter_value';
  end;
  if v_id is null then
    raise exception '[PPC] thiếu id của đề xuất' using errcode = 'invalid_parameter_value';
  end if;
  begin
    v_batch := nullif(btrim(coalesce(p_payload->>'batch_id', '')), '')::uuid;
  exception when others then
    v_batch := null;
  end;

  select * into v_row from ads.change_requests where id = v_id for update;
  if not found then
    raise exception '[PPC] không tìm thấy đề xuất %', v_id using errcode = 'no_data_found';
  end if;
  -- Chỉ dòng cron ĐANG giữ (applying, do vexim_worker_ppc_pending_changes giành) mới
  -- được ghi kết quả. Chặn ở đây để: (a) không ghi lần hai cho dòng đã applied/
  -- rejected/expired/skipped; (b) một cron lạ không "nhảy vào" ghi kết quả cho lô
  -- của cron khác.
  if v_row.status <> 'applying' then
    raise exception '[PPC] đề xuất đang ở trạng thái % — chỉ ghi kết quả cho dòng cron '
                    'đang áp dụng (applying)', v_row.status
      using errcode = 'check_violation';
  end if;

  update ads.change_requests r
     set status          = v_status,
         batch_id        = coalesce(v_batch, r.batch_id),
         applied_at      = case when v_status = 'applied' then now() else r.applied_at end,
         last_error      = v_error,
         amazon_response = coalesce(v_resp, r.amazon_response)
   where r.id = v_id;

  -- Negative keyword áp dụng THÀNH CÔNG → ghi vào bảng phủ định (để gợi ý không lặp
  -- lại và để lần sau bật/tắt được bằng id thật của Amazon).
  if v_status = 'applied' and v_row.entity_type in ('negative_keyword','campaign_negative_keyword') then
    v_created := coalesce(
      nullif(btrim(coalesce(p_payload->>'created_id', '')), ''),
      nullif(btrim(coalesce(v_resp->>'negativeKeywordId', '')), ''),
      nullif(btrim(coalesce(v_resp->>'campaignNegativeKeywordId', '')), ''),
      nullif(btrim(coalesce(v_resp->>'keywordId', '')), ''));

    insert into ads.negative_keywords (
      seller_account_id, ads_profile_id, campaign_id, ad_group_id, keyword_text,
      match_type, level, amazon_negative_id, state, source, change_request_id, last_synced_at)
    values (
      v_row.seller_account_id, v_row.ads_profile_id, v_row.campaign_id, v_row.ad_group_id,
      v_row.label,
      coalesce(v_row.match_type, 'NEGATIVE_EXACT'),
      case when coalesce(v_row.ad_group_id, '') = '' then 'campaign' else 'ad_group' end,
      coalesce(v_created, ''), 'ENABLED', 'vexim', v_row.id, now())
    on conflict (seller_account_id, campaign_id, ad_group_id,
                 lower(btrim(keyword_text)), match_type)
    do update set amazon_negative_id = nullif(excluded.amazon_negative_id, ''),
                  state              = 'ENABLED',
                  source             = excluded.source,
                  change_request_id  = excluded.change_request_id,
                  last_synced_at     = now();
  end if;

  -- Alert: thất bại là phải thấy (im lặng = tiền vẫn đốt mà không ai biết).
  if v_status = 'failed' then
    select coalesce(r.severity::text, 'red') into v_lvl
    from ops.alert_rules r where r.rule_code = 'ppc_change_failed' limit 1;
    v_alert := ops.raise_alert(
      v_row.seller_account_id, 'ppc_change_failed',
      'ppc_failed:' || v_row.seller_account_id::text,
      coalesce(v_lvl, 'red')::ops.alert_severity,
      format('Áp dụng thay đổi PPC thất bại: %s %s',
             v_row.change_type, coalesce(nullif(v_row.label, ''), v_row.amazon_entity_id)),
      format('%s · campaign %s · lỗi: %s',
             v_row.entity_type, coalesce(nullif(v_row.campaign_id, ''), '-'),
             coalesce(v_error, 'không rõ')),
      v_row.decided_by);
  elsif v_status = 'applied' then
    perform ops.resolve_alert(v_row.seller_account_id, 'ppc_change_failed',
                              'ppc_failed:' || v_row.seller_account_id::text);
  end if;

  return jsonb_build_object(
    'ok', v_status <> 'failed', 'id', v_id, 'status', v_status,
    'label', v_row.label, 'entity_type', v_row.entity_type,
    'change_type', v_row.change_type, 'attempts', v_row.attempts,
    'created_id', v_created, 'alert_id', v_alert, 'error', v_error);
end;
$$;

comment on function public.vexim_worker_ppc_set_result(jsonb) is
  'C: worker ghi kết quả sau khi gọi Amazon (applied/failed/skipped) — trigger audit '
  'tự ghi iam.audit_logs. applied + negative keyword → upsert ads.negative_keywords '
  'với id Amazon thật. failed → nổ alert ppc_change_failed; applied kế tiếp → đóng. '
  'Chỉ service_role.';

revoke all on function public.vexim_worker_ppc_set_result(jsonb) from public, anon, authenticated;
grant execute on function public.vexim_worker_ppc_set_result(jsonb) to service_role;

-- ----------------------------------------------------------------------------
-- C9. RPC — nổ/đóng alert của hàng đợi PPC (cron gọi cuối mỗi lượt)
-- ----------------------------------------------------------------------------
-- Cách làm giống vexim_ads_raise_alerts của 0020: duyệt TỪNG SHOP rồi
-- "raise nếu còn đúng / resolve nếu hết đúng". KHÔNG được raise hết rồi mới
-- resolve-all — thứ tự đó đóng luôn alert vừa nổ.
create or replace function public.vexim_ppc_raise_alerts(p_seller uuid default null)
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
  #variable_conflict use_column
declare
  r          record;
  v_alert    uuid;
  v_closed   int;
  v_thr_hrs  numeric;
  v_thr_fail numeric;
begin
  if auth.uid() is not null then
    raise exception '[PPC] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;

  select coalesce(r.threshold, 24) into v_thr_hrs
  from ops.alert_rules r where r.rule_code = 'ppc_pending_approval' and r.is_active limit 1;
  v_thr_hrs := coalesce(v_thr_hrs, 24);

  select coalesce(r.threshold, 1) into v_thr_fail
  from ops.alert_rules r where r.rule_code = 'ppc_change_failed' and r.is_active limit 1;
  v_thr_fail := coalesce(v_thr_fail, 1);

  for r in
    select sa.id           as seller_account_id,
           sa.display_name as shop,
           (select count(*) from ads.change_requests cr
             where cr.seller_account_id = sa.id and cr.status = 'proposed'
               and cr.proposed_at < now() - make_interval(hours => v_thr_hrs::int))::numeric as n_pending,
           (select min(cr.proposed_at) from ads.change_requests cr
             where cr.seller_account_id = sa.id and cr.status = 'proposed'
               and cr.proposed_at < now() - make_interval(hours => v_thr_hrs::int))          as oldest,
           (select count(*) from ads.change_requests cr
             where cr.seller_account_id = sa.id and cr.status = 'failed'
               and cr.updated_at >= now() - interval '24 hours')::numeric                    as n_failed,
           (select max(cr.last_error) from ads.change_requests cr
             where cr.seller_account_id = sa.id and cr.status = 'failed'
               and cr.updated_at >= now() - interval '24 hours')                             as last_error,
           (select max(cr.updated_at) from ads.change_requests cr
             where cr.seller_account_id = sa.id and cr.status = 'failed'
               and cr.updated_at >= now() - interval '24 hours')                             as failed_at
    from connections.seller_accounts sa
    where (p_seller is null or sa.id = p_seller)
      -- chỉ soi shop CÓ VIỆC: còn đề xuất chờ duyệt/thất bại, hoặc còn alert mở
      and ( exists (select 1 from ads.change_requests cr
                     where cr.seller_account_id = sa.id
                       and cr.status in ('proposed','failed'))
            or exists (select 1 from ops.alerts a
                        join ops.alert_rules rr on rr.id = a.rule_id
                        where a.seller_account_id = sa.id
                          and rr.rule_code in ('ppc_pending_approval','ppc_change_failed')
                          and a.status in ('open','ack')) )
  loop
    -- (1) chờ duyệt quá ngưỡng giờ
    if r.n_pending > 0 then
      v_alert := ops.raise_alert(
        r.seller_account_id, 'ppc_pending_approval',
        'ppc_pending:' || r.seller_account_id::text, 'amber',
        format('%s đề xuất PPC chờ duyệt quá %s giờ', r.n_pending::int, v_thr_hrs::int),
        format('Đề xuất cũ nhất lúc %s. Quá TTL policy sẽ tự expired (hết cơ hội áp '
               'dụng) — vào /ppc → tab "Thay đổi" để duyệt hoặc từ chối.',
               to_char(r.oldest, 'YYYY-MM-DD HH24:MI')),
        null);
      shop_id := r.seller_account_id; shop_name := r.shop;
      rule_code := 'ppc_pending_approval';
      entity_key := 'ppc_pending:' || r.seller_account_id::text;
      severity := 'amber'; metric := r.n_pending; threshold := v_thr_hrs;
      alert_id := v_alert; next_action := 'raised';
      return next;
    else
      v_closed := ops.resolve_alert(r.seller_account_id, 'ppc_pending_approval',
                                    'ppc_pending:' || r.seller_account_id::text);
      if v_closed > 0 then
        shop_id := r.seller_account_id; shop_name := r.shop;
        rule_code := 'ppc_pending_approval'; entity_key := null; severity := null;
        metric := v_closed; threshold := v_thr_hrs; alert_id := null;
        next_action := 'resolved';
        return next;
      end if;
    end if;

    -- (2) áp dụng thất bại trong 24h
    if r.n_failed >= v_thr_fail then
      v_alert := ops.raise_alert(
        r.seller_account_id, 'ppc_change_failed',
        'ppc_failed:' || r.seller_account_id::text, 'red',
        format('%s thay đổi PPC áp dụng thất bại trong 24 giờ', r.n_failed::int),
        format('Lỗi gần nhất: %s · lúc %s. Amazon có thể đã đổi giá trị ngoài Ads '
               'console — xem /ppc → tab "Thay đổi" → lọc "Thất bại".',
               coalesce(r.last_error, 'không rõ'),
               to_char(r.failed_at, 'YYYY-MM-DD HH24:MI')),
        null);
      shop_id := r.seller_account_id; shop_name := r.shop;
      rule_code := 'ppc_change_failed';
      entity_key := 'ppc_failed:' || r.seller_account_id::text;
      severity := 'red'; metric := r.n_failed; threshold := v_thr_fail;
      alert_id := v_alert; next_action := 'raised';
      return next;
    else
      v_closed := ops.resolve_alert(r.seller_account_id, 'ppc_change_failed',
                                    'ppc_failed:' || r.seller_account_id::text);
      if v_closed > 0 then
        shop_id := r.seller_account_id; shop_name := r.shop;
        rule_code := 'ppc_change_failed'; entity_key := null; severity := null;
        metric := v_closed; threshold := v_thr_fail; alert_id := null;
        next_action := 'resolved';
        return next;
      end if;
    end if;
  end loop;

  return;
end;
$$;

comment on function public.vexim_ppc_raise_alerts(uuid) is
  'C: nổ/đóng 2 alert của hàng đợi PPC — ppc_pending_approval (đề xuất chờ duyệt quá '
  'ngưỡng giờ, mặc định 24) và ppc_change_failed (áp dụng thất bại trong 24h). Ngưỡng '
  'đọc từ ops.alert_rules. Duyệt từng shop: còn đúng thì raise, hết đúng thì resolve. '
  'Chỉ service_role.';

revoke all on function public.vexim_ppc_raise_alerts(uuid) from public, anon, authenticated;
grant execute on function public.vexim_ppc_raise_alerts(uuid) to service_role;

-- ============================================================================
-- §D. VIEW cho UI (đọc qua PostgREST; security_invoker nên RLS của bảng vẫn áp)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- D1. vexim_ppc_policies — guardrail HIỆU LỰC + trạng thái hàng đợi của shop
-- ----------------------------------------------------------------------------
create or replace view public.vexim_ppc_policies
with (security_invoker = true) as
select
  sa.id                                          as seller_account_id,
  sa.display_name                                as shop,
  sa.marketplace,
  sa.status                                      as shop_status,
  (q.pol->>'has_row')::boolean                   as has_policy_row,
  (q.pol->>'auto_apply')::boolean                as auto_apply,
  (q.pol->>'require_approval_state')::boolean    as require_approval_state,
  (q.pol->>'max_bid_change_pct')::numeric        as max_bid_change_pct,
  (q.pol->>'max_budget_change_pct')::numeric     as max_budget_change_pct,
  (q.pol->>'bid_floor')::numeric                 as bid_floor,
  (q.pol->>'bid_ceiling')::numeric               as bid_ceiling,
  (q.pol->>'budget_floor')::numeric              as budget_floor,
  (q.pol->>'budget_ceiling')::numeric            as budget_ceiling,
  (q.pol->>'daily_change_cap')::int              as daily_change_cap,
  (q.pol->>'max_open_requests')::int             as max_open_requests,
  (q.pol->>'proposal_ttl_hours')::int            as proposal_ttl_hours,
  (q.pol->>'suggestion_min_clicks')::int         as suggestion_min_clicks,
  (q.pol->>'suggestion_min_spend')::numeric      as suggestion_min_spend,
  (q.pol->>'suggestion_acos_lower_pct')::numeric as suggestion_acos_lower_pct,
  (q.pol->>'bid_step_pct')::numeric              as bid_step_pct,
  q.pol->>'currency'                             as currency,
  q.pol->>'notes'                                as notes,
  (q.pol->>'updated_at')                         as policy_updated_at,
  st.proposed_count,
  st.approved_count,
  st.applying_count,
  st.applied_today,
  st.failed_24h,
  st.open_count,
  greatest((q.pol->>'daily_change_cap')::int - st.applied_today - st.applying_count, 0) as cap_left_today,
  iam.is_ppc_approver()                          as can_edit_policy
from connections.seller_accounts sa
cross join lateral (select ads.ppc_policy(sa.id) as pol) q
left join lateral (
  select
    (select count(*)::int from ads.change_requests r
      where r.seller_account_id = sa.id and r.status = 'proposed')  as proposed_count,
    (select count(*)::int from ads.change_requests r
      where r.seller_account_id = sa.id and r.status = 'approved')  as approved_count,
    (select count(*)::int from ads.change_requests r
      where r.seller_account_id = sa.id and r.status = 'applying')  as applying_count,
    (select count(*)::int from ads.change_requests r
      where r.seller_account_id = sa.id and r.status in ('applied','applying')
        and coalesce(r.applied_at, r.updated_at) >= date_trunc('day', now())) as applied_today,
    (select count(*)::int from ads.change_requests r
      where r.seller_account_id = sa.id and r.status = 'failed'
        and r.updated_at >= now() - interval '24 hours')            as failed_24h,
    (select count(*)::int from ads.change_requests r
      where r.seller_account_id = sa.id
        and r.status in ('proposed','approved','applying'))          as open_count
) st on true;

comment on view public.vexim_ppc_policies is
  'C: guardrail PPC HIỆU LỰC của shop (chưa có dòng trong ads.ppc_policies vẫn trả '
  'đủ mặc định) + trạng thái hàng đợi: số chờ duyệt / đã duyệt / đang áp dụng / đã áp '
  'dụng hôm nay / thất bại 24h, và cap_left_today (trần ngày còn lại). can_edit_policy '
  '= iam.is_ppc_approver() để UI ẩn nút sửa với người không có quyền.';

-- ----------------------------------------------------------------------------
-- D2. vexim_ppc_change_requests — hàng đợi thay đổi (dòng UI hiển thị)
-- ----------------------------------------------------------------------------
create or replace view public.vexim_ppc_change_requests
with (security_invoker = true) as
select
  r.id,
  r.seller_account_id,
  sa.display_name                                as shop,
  r.ads_profile_id,
  r.entity_type,
  r.change_type,
  r.amazon_entity_id,
  r.campaign_id,
  coalesce(nullif(c.name, ''), r.label, r.campaign_id) as campaign_name,
  c.campaign_type,
  r.ad_group_id,
  r.label,
  r.match_type,
  r.currency,
  r.before_value,
  r.after_value,
  case r.change_type
    when 'bid'    then ads.num_or_null(r.before_value->>'bid')
    when 'budget' then ads.num_or_null(r.before_value->>'budget')
  end                                            as before_number,
  case r.change_type
    when 'bid'    then ads.num_or_null(r.after_value->>'bid')
    when 'budget' then ads.num_or_null(r.after_value->>'budget')
  end                                            as after_number,
  r.delta_pct,
  case when r.delta_pct is null then null
       else format('%s%s%%', case when r.delta_pct > 0 then '+' else '' end,
                   ads.num_text(r.delta_pct))
  end                                            as delta_label,
  -- câu mô tả người đọc được (UI hiện thẳng, không phải tự ghép)
  case r.change_type
    when 'bid' then format('Bid %s → %s %s%s',
        coalesce(ads.num_text(ads.num_or_null(r.before_value->>'bid')), '?'),
        coalesce(ads.num_text(ads.num_or_null(r.after_value->>'bid')), '?'),
        r.currency,
        case when r.delta_pct is null then ''
             else format(' (%s%s%%)', case when r.delta_pct > 0 then '+' else '' end,
                         ads.num_text(r.delta_pct)) end)
    when 'budget' then format('Ngân sách ngày %s → %s %s%s',
        coalesce(ads.num_text(ads.num_or_null(r.before_value->>'budget')), '?'),
        coalesce(ads.num_text(ads.num_or_null(r.after_value->>'budget')), '?'),
        r.currency,
        case when r.delta_pct is null then ''
             else format(' (%s%s%%)', case when r.delta_pct > 0 then '+' else '' end,
                         ads.num_text(r.delta_pct)) end)
    when 'state' then format('Trạng thái %s → %s',
        coalesce(nullif(r.before_value->>'state', ''), '?'),
        coalesce(nullif(r.after_value->>'state', ''), '?'))
    when 'name' then format('Đổi tên: %s → %s',
        coalesce(nullif(r.before_value->>'name', ''), '?'),
        coalesce(nullif(r.after_value->>'name', ''), r.label))
    when 'create' then format('Phủ định "%s" (%s) cấp %s',
        r.label, coalesce(r.match_type, 'NEGATIVE_EXACT'),
        case when coalesce(r.ad_group_id, '') = '' then 'campaign' else 'ad group' end)
  end                                            as summary,
  case r.entity_type
    when 'campaign'                  then 'Campaign'
    when 'ad_group'                  then 'Ad group'
    when 'keyword'                   then 'Keyword'
    when 'negative_keyword'          then 'Negative keyword (ad group)'
    when 'campaign_negative_keyword' then 'Negative keyword (campaign)'
  end                                            as entity_label,
  r.requires_approval,
  r.reason,
  r.source,
  r.suggestion_key,
  r.status,
  case r.status
    when 'proposed' then 'Chờ duyệt'
    when 'approved' then 'Đã duyệt — chờ cron'
    when 'applying' then 'Đang áp dụng'
    when 'applied'  then 'Đã áp dụng'
    when 'failed'   then 'Thất bại'
    when 'rejected' then 'Đã từ chối'
    when 'expired'  then 'Hết hạn'
    when 'skipped'  then 'Bỏ qua (lệch Amazon)'
  end                                            as status_label,
  r.status in ('proposed','approved','applying')  as is_open,
  r.status in ('applied','rejected','expired','skipped') as is_terminal,
  r.batch_id,
  r.proposed_by,
  iam.user_display(r.proposed_by)                as proposed_by_name,
  r.proposed_at,
  round(extract(epoch from now() - r.proposed_at) / 3600.0, 1)::numeric as age_hours,
  r.decided_by,
  iam.user_display(r.decided_by)                 as decided_by_name,
  r.decided_at,
  r.decision_note,
  r.expires_at,
  case when r.expires_at is null then null
       else round(extract(epoch from r.expires_at - now()) / 3600.0, 1)::numeric
  end                                            as expires_in_hours,
  (r.expires_at is not null and r.expires_at < now()) as expired,
  r.attempts,
  r.applied_at,
  r.last_error,
  r.amazon_response,
  r.created_at,
  r.updated_at,
  -- UI: chỉ approver mới thấy nút Duyệt/Từ chối, và chỉ khi còn duyệt được
  (iam.is_ppc_approver() and r.status in ('proposed','failed')
   and (r.expires_at is null or r.expires_at >= now())) as can_decide,
  (r.proposed_by = auth.uid())                   as is_mine
from ads.change_requests r
join connections.seller_accounts sa on sa.id = r.seller_account_id
left join ads.campaigns c
       on c.seller_account_id = r.seller_account_id and c.campaign_id = r.campaign_id;

comment on view public.vexim_ppc_change_requests is
  'C: hàng đợi thay đổi PPC cho UI — kèm summary/delta_label/entity_label/status_label '
  'là CHỮ người đọc được (không để UI tự ghép), before_number/after_number để sắp xếp, '
  'can_decide (approver + còn duyệt được) và is_mine (để cảnh báo tự duyệt). Tên người '
  'đề xuất/người duyệt lấy qua iam.user_display() vì iam.user_profiles chỉ cho đọc '
  'profile của chính mình.';

-- ----------------------------------------------------------------------------
-- D3. vexim_ads_negative_keywords — từ khoá phủ định đang có hiệu lực
-- ----------------------------------------------------------------------------
create or replace view public.vexim_ads_negative_keywords
with (security_invoker = true) as
select
  nk.id,
  nk.seller_account_id,
  sa.display_name                    as shop,
  nk.ads_profile_id,
  nk.campaign_id,
  coalesce(nullif(c.name, ''), nullif(nk.campaign_name, ''), nk.campaign_id) as campaign_name,
  nk.ad_group_id,
  nk.ad_group_name,
  nk.level,
  nk.keyword_text,
  lower(btrim(nk.keyword_text))      as keyword_norm,
  nk.match_type,
  case nk.match_type
    when 'NEGATIVE_EXACT'  then 'Phủ định chính xác'
    when 'NEGATIVE_PHRASE' then 'Phủ định theo cụm'
  end                                as match_label,
  nk.amazon_negative_id,
  nk.state,
  nk.source,
  nk.change_request_id,
  cr.status                          as request_status,
  nk.created_at,
  nk.last_synced_at,
  nk.updated_at
from ads.negative_keywords nk
join connections.seller_accounts sa on sa.id = nk.seller_account_id
left join ads.campaigns c on c.seller_account_id = nk.seller_account_id and c.campaign_id = nk.campaign_id
left join ads.change_requests cr on cr.id = nk.change_request_id;

comment on view public.vexim_ads_negative_keywords is
  'C: từ khoá phủ định đã thêm (source=vexim) hoặc đã có sẵn trên Amazon (source=api, '
  'do lần đồng bộ sau nạp về). keyword_norm để gợi ý so trùng không phân biệt '
  'hoa/thường. level=campaign thì ad_group_id rỗng.';

-- ----------------------------------------------------------------------------
-- D4. vexim_ppc_suggestions — GỢI Ý thay đổi sinh TỪ SỐ LIỆU (không ghi gì cả)
-- ----------------------------------------------------------------------------
-- 5 loại gợi ý (priority 1 = đáng làm trước):
--   1 negative_keyword : search term đốt tiền (≥ N click, 0 đơn) chưa bị phủ định
--   2 pause_keyword    : keyword ≥ 2N click, 0 đơn → tắt để dừng chảy máu
--   2 pause_campaign   : campaign ≥ 2N click, 0 đơn → tắt
--   3 lower_bid        : keyword ACOS 7 ngày vượt ngưỡng policy mà VẪN có đơn → hạ bid
--   4 raise_budget     : campaign CẠN ngân sách nhưng ACOS ≤ mục tiêu → tăng ngân sách
-- Mỗi dòng trả sẵn before_value/after_value/reason/suggestion_key để UI chỉ việc gửi
-- thẳng vào vexim_ppc_propose_changes (không phải tự tính lại con số).
create or replace view public.vexim_ppc_suggestions
with (security_invoker = true) as
with thr as (
  select r.threshold as acos_target
  from ops.alert_rules r
  where r.rule_code = 'acos_over_target' and r.is_active
  limit 1
),
win_t as (select seller_account_id, max(day) as last_day from ads.targeting_metrics_daily group by 1),
win_s as (select seller_account_id, max(day) as last_day from ads.search_terms group by 1),
win_c as (select seller_account_id, max(day) as last_day from ads.ad_metrics_daily group by 1),
-- bid MỚI NHẤT của keyword (không lấy max 7 ngày: bid có thể đã đổi giữa kỳ)
kw_bid as (
  select distinct on (t.seller_account_id, t.keyword_id)
         t.seller_account_id, t.keyword_id, t.bid, t.day as bid_day
  from ads.targeting_metrics_daily t
  where coalesce(t.keyword_id, '') <> '' and t.bid is not null
  order by t.seller_account_id, t.keyword_id, t.day desc
),
kw as (
  select t.seller_account_id, t.campaign_id, t.ad_group_id, t.keyword_id,
         max(nullif(t.keyword_text, ''))       as keyword_text,
         max(nullif(t.match_type, ''))         as match_type,
         max(nullif(t.keyword_type, ''))       as keyword_type,
         max(nullif(t.campaign_name, ''))      as campaign_name,
         max(nullif(t.ad_group_name, ''))      as ad_group_name,
         max(nullif(t.currency, ''))           as currency,
         sum(t.impressions)                    as impressions,
         sum(t.clicks)                         as clicks,
         sum(t.cost)                           as spend,
         sum(coalesce(t.sales7d, 0))           as sales7,
         sum(coalesce(t.purchases7d, 0))       as orders7,
         max(t.day)                            as last_day,
         count(distinct t.day)                 as days_with_data
  from ads.targeting_metrics_daily t
  join win_t w on w.seller_account_id = t.seller_account_id
  where t.day between w.last_day - 6 and w.last_day
    and coalesce(t.keyword_id, '') <> ''
    -- chỉ keyword thật; target ASIN/category đổi bid qua endpoint KHÁC (chưa mở)
    and coalesce(t.keyword_type, '') not in ('TARGETING_EXPRESSION','TARGETING_EXPRESSION_PREDEFINED')
  group by 1, 2, 3, 4
),
st as (
  select s.seller_account_id, s.term, s.campaign_id, s.ad_group_id,
         max(nullif(s.keyword_text, ''))       as keyword_text,
         max(nullif(s.match_type, ''))         as match_type,
         max(nullif(s.campaign_name, ''))      as campaign_name,
         max(nullif(s.ad_group_name, ''))      as ad_group_name,
         max(nullif(s.currency, ''))           as currency,
         sum(s.impressions)                    as impressions,
         sum(s.clicks)                         as clicks,
         sum(s.spend)                          as spend,
         sum(coalesce(s.sales7d, s.sales, 0))  as sales7,
         sum(coalesce(s.purchases7d, 0))       as orders7,
         max(s.day)                            as last_day,
         count(distinct s.day)                 as days_with_data
  from ads.search_terms s
  join win_s w on w.seller_account_id = s.seller_account_id
  where s.day between w.last_day - 6 and w.last_day
  group by 1, 2, 3, 4
),
cam as (
  select c.seller_account_id, c.campaign_id,
         coalesce(nullif(c.name, ''), m.campaign_name, c.campaign_id) as campaign_name,
         c.campaign_type, c.state, c.daily_budget, c.targeting_type,
         coalesce(nullif(m.currency, ''), nullif(c.budget_currency, '')) as currency,
         m.impressions7, m.clicks7, m.spend7, m.sales7, m.orders7,
         m.last_day, m.days_with_data, m.last_day_spend,
         bu.percentage_used, bu.usage_day
  from ads.campaigns c
  left join lateral (
    select sum(x.impressions)                        as impressions7,
           sum(x.clicks)                             as clicks7,
           sum(x.spend)                              as spend7,
           sum(coalesce(x.sales7d, x.sales, 0))      as sales7,
           sum(coalesce(x.orders, 0))                as orders7,
           max(x.day)                                as last_day,
           count(distinct x.day)                     as days_with_data,
           max(nullif(x.currency, ''))               as currency,
           max(nullif(x.campaign_name, ''))          as campaign_name,
           (array_agg(x.spend order by x.day desc))[1] as last_day_spend
    from ads.ad_metrics_daily x
    join win_c w on w.seller_account_id = x.seller_account_id
    where x.seller_account_id = c.seller_account_id
      and x.campaign_id       = c.campaign_id
      and x.day between w.last_day - 6 and w.last_day
  ) m on true
  left join lateral (
    select b.percentage_used, b.day as usage_day
    from ads.budget_usage b
    where b.seller_account_id = c.seller_account_id and b.campaign_id = c.campaign_id
    order by b.day desc, b.captured_at desc
    limit 1
  ) bu on true
),
pol as (
  select sa.id as seller_account_id, ads.ppc_policy(sa.id) as p
  from connections.seller_accounts sa
),
sug as (
  ------------------------------------------------------------------ (1) negative
  select s.seller_account_id,
         'negative_keyword'                                       as kind,
         1                                                        as priority,
         'nk|' || s.campaign_id || '|' || s.ad_group_id || '|'
           || lower(btrim(s.term))                                as suggestion_key,
         case when coalesce(s.ad_group_id, '') = ''
              then 'campaign_negative_keyword' else 'negative_keyword' end as entity_type,
         'create'                                                 as change_type,
         s.campaign_id, s.campaign_name, s.ad_group_id, s.ad_group_name,
         ''::text                                                 as amazon_entity_id,
         btrim(s.term)                                            as label,
         'NEGATIVE_EXACT'                                         as match_type,
         null::text                                               as keyword_type,
         coalesce(s.currency, po.p->>'currency', 'USD')           as currency,
         null::jsonb                                              as before_value,
         jsonb_build_object('keyword_text', btrim(s.term), 'match_type', 'NEGATIVE_EXACT',
                            'campaign_id', s.campaign_id, 'ad_group_id', s.ad_group_id,
                            'level', case when coalesce(s.ad_group_id, '') = ''
                                          then 'campaign' else 'ad_group' end) as after_value,
         null::numeric                                            as current_number,
         null::numeric                                            as proposed_number,
         null::numeric                                            as delta_pct,
         s.impressions                                            as impressions7,
         s.clicks                                                 as clicks7,
         s.spend                                                  as spend7,
         s.sales7                                                 as sales7,
         s.orders7                                                as ad_orders7,
         null::numeric                                            as acos7,
         s.spend                                                  as waste7,
         s.days_with_data,
         s.last_day                                               as window_end,
         format('Search term "%s" tốn %s %s cho %s click mà KHÔNG có đơn (7 ngày, khớp '
                'qua keyword "%s"). Phủ định chính xác để dừng chi tiêu — không ảnh '
                'hưởng các term khác.',
                btrim(s.term), ads.num_text(s.spend),
                coalesce(s.currency, po.p->>'currency', 'USD'),
                s.clicks, coalesce(s.keyword_text, '-'))            as reason,
         not ((po.p->>'auto_apply')::boolean
              and not (po.p->>'require_approval_state')::boolean)  as requires_approval,
         exists (select 1 from ads.change_requests r
                  where r.seller_account_id = s.seller_account_id
                    and r.suggestion_key = 'nk|' || s.campaign_id || '|' || s.ad_group_id
                                         || '|' || lower(btrim(s.term))
                    and r.status in ('proposed','approved','applying')) as has_open_request
  from st s
  join pol po on po.seller_account_id = s.seller_account_id
  where coalesce(btrim(s.term), '') not in ('', '*')
    and length(btrim(s.term)) >= 2
    and s.clicks >= (po.p->>'suggestion_min_clicks')::int
    and coalesce(s.sales7, 0) = 0
    and s.spend >= (po.p->>'suggestion_min_spend')::numeric
    -- KHÔNG phủ định đúng từ khoá đang chạy (mâu thuẫn với gợi ý pause_keyword)
    and lower(btrim(s.term)) <> lower(btrim(coalesce(s.keyword_text, '')))
    and not exists (
      select 1 from ads.negative_keywords nk
      where nk.seller_account_id = s.seller_account_id
        and nk.campaign_id       = s.campaign_id
        and (nk.ad_group_id = s.ad_group_id or nk.level = 'campaign')
        and lower(btrim(nk.keyword_text)) = lower(btrim(s.term)))

  union all
  ------------------------------------------------------------------ (2) pause kw
  select k.seller_account_id,
         'pause_keyword', 2,
         'pause|' || k.keyword_id,
         'keyword', 'state',
         k.campaign_id, k.campaign_name, k.ad_group_id, k.ad_group_name,
         k.keyword_id, coalesce(k.keyword_text, k.keyword_id),
         k.match_type, k.keyword_type,
         coalesce(k.currency, po.p->>'currency', 'USD'),
         jsonb_build_object('bid', kb.bid),
         jsonb_build_object('state', 'PAUSED'),
         kb.bid, null::numeric, null::numeric,
         k.impressions, k.clicks, k.spend, k.sales7, k.orders7, null::numeric, k.spend,
         k.days_with_data, k.last_day,
         format('Keyword "%s" (%s) tốn %s %s cho %s click mà KHÔNG có đơn (7 ngày) → '
                'tạm dừng. Cron sẽ đọc lại Amazon trước khi ghi; nếu đã PAUSED thì bỏ qua.',
                coalesce(k.keyword_text, k.keyword_id), coalesce(k.match_type, '-'),
                ads.num_text(k.spend), coalesce(k.currency, po.p->>'currency', 'USD'),
                k.clicks),
         not ((po.p->>'auto_apply')::boolean
              and not (po.p->>'require_approval_state')::boolean),
         exists (select 1 from ads.change_requests r
                  where r.seller_account_id = k.seller_account_id
                    and r.entity_type = 'keyword' and r.change_type = 'state'
                    and r.amazon_entity_id = k.keyword_id
                    and r.status in ('proposed','approved','applying'))
  from kw k
  join pol po on po.seller_account_id = k.seller_account_id
  left join kw_bid kb on kb.seller_account_id = k.seller_account_id and kb.keyword_id = k.keyword_id
  where k.clicks >= 2 * (po.p->>'suggestion_min_clicks')::int
    and coalesce(k.sales7, 0) = 0
    and k.spend >= (po.p->>'suggestion_min_spend')::numeric

  union all
  --------------------------------------------------------------- (2b) pause camp
  select c.seller_account_id,
         'pause_campaign', 2,
         'pausecamp|' || c.campaign_id,
         'campaign', 'state',
         c.campaign_id, c.campaign_name, ''::text, null::text,
         c.campaign_id, c.campaign_name,
         null::text, null::text,
         coalesce(c.currency, po.p->>'currency', 'USD'),
         jsonb_build_object('budget', c.daily_budget, 'state', c.state),
         jsonb_build_object('state', 'PAUSED'),
         c.daily_budget, null::numeric, null::numeric,
         c.impressions7, c.clicks7, c.spend7, c.sales7, c.orders7, null::numeric, c.spend7,
         c.days_with_data, c.last_day,
         format('Campaign "%s" tốn %s %s cho %s click mà KHÔNG có đơn (7 ngày) → tạm '
                'dừng cả campaign. Cân nhắc tắt từng keyword trước nếu campaign còn '
                'từ khoá tốt.',
                c.campaign_name, ads.num_text(coalesce(c.spend7, 0)),
                coalesce(c.currency, po.p->>'currency', 'USD'), coalesce(c.clicks7, 0)),
         not ((po.p->>'auto_apply')::boolean
              and not (po.p->>'require_approval_state')::boolean),
         exists (select 1 from ads.change_requests r
                  where r.seller_account_id = c.seller_account_id
                    and r.entity_type = 'campaign' and r.change_type = 'state'
                    and r.amazon_entity_id = c.campaign_id
                    and r.status in ('proposed','approved','applying'))
  from cam c
  join pol po on po.seller_account_id = c.seller_account_id
  where coalesce(c.state, '') = 'ENABLED'
    and lower(coalesce(c.campaign_type, 'sp')) in ('sp','sponsoredproducts','')
    and coalesce(c.clicks7, 0) >= 2 * (po.p->>'suggestion_min_clicks')::int
    and coalesce(c.sales7, 0) = 0
    and coalesce(c.spend7, 0) >= (po.p->>'suggestion_min_spend')::numeric

  union all
  ------------------------------------------------------------------ (3) lower bid
  select k.seller_account_id,
         'lower_bid', 3,
         'bid|' || k.keyword_id,
         'keyword', 'bid',
         k.campaign_id, k.campaign_name, k.ad_group_id, k.ad_group_name,
         k.keyword_id, coalesce(k.keyword_text, k.keyword_id),
         k.match_type, k.keyword_type,
         coalesce(k.currency, po.p->>'currency', 'USD'),
         jsonb_build_object('bid', kb.bid),
         jsonb_build_object('bid', greatest(
             round(kb.bid * (1 - (po.p->>'bid_step_pct')::numeric / 100.0), 2),
             coalesce((po.p->>'bid_floor')::numeric, 0.02))),
         kb.bid,
         greatest(round(kb.bid * (1 - (po.p->>'bid_step_pct')::numeric / 100.0), 2),
                  coalesce((po.p->>'bid_floor')::numeric, 0.02)),
         round(100.0 * (greatest(round(kb.bid * (1 - (po.p->>'bid_step_pct')::numeric / 100.0), 2),
                                 coalesce((po.p->>'bid_floor')::numeric, 0.02)) - kb.bid) / kb.bid, 2),
         k.impressions, k.clicks, k.spend, k.sales7, k.orders7,
         round(100.0 * k.spend / nullif(k.sales7, 0), 2), null::numeric,
         k.days_with_data, k.last_day,
         format('Keyword "%s" (%s) có ACOS 7 ngày %s%% (mục tiêu %s%%) với %s click, '
                'doanh thu %s %s → hạ bid %s → %s (bước %s%% của policy).',
                coalesce(k.keyword_text, k.keyword_id), coalesce(k.match_type, '-'),
                ads.num_text(round(100.0 * k.spend / nullif(k.sales7, 0), 2)),
                ads.num_text(coalesce(t.acos_target, 25)), k.clicks,
                ads.num_text(k.sales7),
                coalesce(k.currency, po.p->>'currency', 'USD'),
                ads.num_text(kb.bid),
                ads.num_text(greatest(round(kb.bid * (1 - (po.p->>'bid_step_pct')::numeric / 100.0), 2),
                                      coalesce((po.p->>'bid_floor')::numeric, 0.02))),
                ads.num_text((po.p->>'bid_step_pct')::numeric)),
         not ((po.p->>'auto_apply')::boolean
              and round(100.0 * abs(greatest(
                      round(kb.bid * (1 - (po.p->>'bid_step_pct')::numeric / 100.0), 2),
                      coalesce((po.p->>'bid_floor')::numeric, 0.02)) - kb.bid) / kb.bid, 2)
                  <= (po.p->>'max_bid_change_pct')::numeric),
         exists (select 1 from ads.change_requests r
                  where r.seller_account_id = k.seller_account_id
                    and r.entity_type = 'keyword' and r.change_type = 'bid'
                    and r.amazon_entity_id = k.keyword_id
                    and r.status in ('proposed','approved','applying'))
  from kw k
  join pol po on po.seller_account_id = k.seller_account_id
  join kw_bid kb on kb.seller_account_id = k.seller_account_id and kb.keyword_id = k.keyword_id
  left join thr t on true
  where kb.bid > 0
    and k.clicks >= (po.p->>'suggestion_min_clicks')::int
    and coalesce(k.sales7, 0) > 0
    and round(100.0 * k.spend / nullif(k.sales7, 0), 2) > (po.p->>'suggestion_acos_lower_pct')::numeric
    -- sàn policy cao hơn bid hiện tại thì không có gì để hạ
    and greatest(round(kb.bid * (1 - (po.p->>'bid_step_pct')::numeric / 100.0), 2),
                 coalesce((po.p->>'bid_floor')::numeric, 0.02)) < kb.bid
    and ((po.p->>'bid_ceiling')::numeric is null or kb.bid <= (po.p->>'bid_ceiling')::numeric)

  union all
  ----------------------------------------------------------------- (4) raise budget
  select c.seller_account_id,
         'raise_budget', 4,
         'budget|' || c.campaign_id,
         'campaign', 'budget',
         c.campaign_id, c.campaign_name, ''::text, null::text,
         c.campaign_id, c.campaign_name,
         null::text, null::text,
         coalesce(c.currency, po.p->>'currency', 'USD'),
         jsonb_build_object('budget', c.daily_budget, 'state', c.state),
         jsonb_build_object('budget', least(
             round(c.daily_budget * (1 + (po.p->>'max_budget_change_pct')::numeric / 200.0), 2),
             coalesce((po.p->>'budget_ceiling')::numeric, 999999999))),
         c.daily_budget,
         least(round(c.daily_budget * (1 + (po.p->>'max_budget_change_pct')::numeric / 200.0), 2),
               coalesce((po.p->>'budget_ceiling')::numeric, 999999999)),
         round(100.0 * (least(round(c.daily_budget * (1 + (po.p->>'max_budget_change_pct')::numeric / 200.0), 2),
                              coalesce((po.p->>'budget_ceiling')::numeric, 999999999))
                        - c.daily_budget) / c.daily_budget, 2),
         c.impressions7, c.clicks7, c.spend7, c.sales7, c.orders7,
         round(100.0 * coalesce(c.spend7, 0) / nullif(c.sales7, 0), 2),
         null::numeric                                            as waste7,
         c.days_with_data, c.last_day,
         format('Campaign "%s" CẠN ngân sách (%s) mà ACOS 7 ngày chỉ %s%% (mục tiêu %s%%) '
                '→ tăng ngân sách ngày %s → %s (+%s%% = một nửa trần %s%% của policy). '
                'Tăng hết trần một lúc khó hoàn tác.',
                c.campaign_name,
                case when coalesce(c.percentage_used, 0) >= 100
                     then format('%s%% ngày %s', ads.num_text(c.percentage_used),
                                 to_char(c.usage_day, 'DD/MM'))
                     else format('spend %s ≥ budget %s ngày %s',
                                 ads.num_text(coalesce(c.last_day_spend, 0)),
                                 ads.num_text(c.daily_budget), to_char(c.last_day, 'DD/MM')) end,
                ads.num_text(round(100.0 * coalesce(c.spend7, 0) / nullif(c.sales7, 0), 2)),
                ads.num_text(coalesce(t.acos_target, 25)),
                ads.num_text(c.daily_budget),
                ads.num_text(least(round(c.daily_budget * (1 + (po.p->>'max_budget_change_pct')::numeric / 200.0), 2),
                                   coalesce((po.p->>'budget_ceiling')::numeric, 999999999))),
                ads.num_text(round((po.p->>'max_budget_change_pct')::numeric / 2.0, 1)),
                ads.num_text((po.p->>'max_budget_change_pct')::numeric)),
         -- bước tăng = MỘT NỬA trần % của policy nên luôn nằm trong ngưỡng;
         -- vì vậy còn lại duy nhất một câu hỏi: shop có bật auto_apply không.
         not (po.p->>'auto_apply')::boolean,
         exists (select 1 from ads.change_requests r
                  where r.seller_account_id = c.seller_account_id
                    and r.entity_type = 'campaign' and r.change_type = 'budget'
                    and r.amazon_entity_id = c.campaign_id
                    and r.status in ('proposed','approved','applying'))
  from cam c
  join pol po on po.seller_account_id = c.seller_account_id
  left join thr t on true
  where coalesce(c.state, '') = 'ENABLED'
    and lower(coalesce(c.campaign_type, 'sp')) in ('sp','sponsoredproducts','')
    and coalesce(c.daily_budget, 0) > 0
    -- cạn ngân sách: Budget Usage API nói ≥100%, hoặc spend ngày cuối ≥ budget
    and (coalesce(c.percentage_used, 0) >= 100
         or coalesce(c.last_day_spend, 0) >= c.daily_budget)
    -- chỉ tăng khi campaign THẬT SỰ hiệu quả (có đơn và ACOS ≤ mục tiêu)
    and coalesce(c.sales7, 0) > 0
    and round(100.0 * c.spend7 / nullif(c.sales7, 0), 2) <= coalesce(t.acos_target, 25)
    and least(round(c.daily_budget * (1 + (po.p->>'max_budget_change_pct')::numeric / 200.0), 2),
              coalesce((po.p->>'budget_ceiling')::numeric, 999999999)) > c.daily_budget
)
select
  u.seller_account_id,
  sa.display_name        as shop,
  u.kind,
  u.priority,
  u.suggestion_key,
  u.entity_type,
  u.change_type,
  u.campaign_id,
  u.campaign_name,
  u.ad_group_id,
  u.ad_group_name,
  u.amazon_entity_id,
  u.label,
  u.match_type,
  u.keyword_type,
  u.currency,
  u.before_value,
  u.after_value,
  u.current_number,
  u.proposed_number,
  u.delta_pct,
  u.impressions7,
  u.clicks7,
  u.spend7,
  u.sales7,
  u.ad_orders7,
  u.acos7,
  coalesce(t.acos_target, 25) as acos_target,
  u.waste7,
  u.days_with_data,
  u.window_end,
  u.reason,
  u.requires_approval,
  u.has_open_request,
  case u.kind
    when 'negative_keyword' then 'Phủ định từ khoá'
    when 'pause_keyword'    then 'Tạm dừng keyword'
    when 'pause_campaign'   then 'Tạm dừng campaign'
    when 'lower_bid'        then 'Hạ bid'
    when 'raise_budget'     then 'Tăng ngân sách'
  end                    as kind_label,
  iam.is_ppc_approver()  as can_decide,
  iam.can_write_seller_account(u.seller_account_id) as can_propose
from sug u
join connections.seller_accounts sa on sa.id = u.seller_account_id
left join thr t on true;

comment on view public.vexim_ppc_suggestions is
  'C: gợi ý thay đổi PPC sinh từ số liệu 7 NGÀY (cửa sổ kết thúc ở ngày dữ liệu mới '
  'nhất của shop, không hardcode hôm qua). Ngưỡng đọc từ ads.ppc_policy(shop) nên đổi '
  'policy là gợi ý đổi theo, không cần deploy. before_value/after_value/reason/'
  'suggestion_key trả sẵn để UI gửi thẳng vào vexim_ppc_propose_changes. '
  'has_open_request=true → đã có đề xuất mở cho đúng việc đó (UI nên disable nút). '
  'VIEW CHỈ ĐỌC — không ghi gì, không gọi Amazon.';

-- ============================================================================
-- §E. ALERT RULES của hàng đợi PPC
-- ============================================================================
-- Ngưỡng ở đây là con số RPC vexim_ppc_raise_alerts đọc (đổi không cần deploy):
--   ppc_pending_approval : threshold = SỐ GIỜ một đề xuất được phép chờ duyệt
--   ppc_change_failed    : threshold = SỐ lần thất bại trong 24h thì nổ alert
insert into ops.alert_rules (rule_code, module, description, threshold, comparator, severity, is_active)
values
  ('ppc_pending_approval', 'ads',
   'Đề xuất thay đổi PPC chờ duyệt quá ngưỡng giờ — quá TTL policy sẽ tự expired (mất cơ hội áp dụng)',
   24, 'gte', 'amber', true),
  ('ppc_change_failed', 'ads',
   'Thay đổi PPC áp dụng lên Amazon thất bại trong 24 giờ (bid/budget/negative keyword)',
   1, 'gte', 'red', true)
on conflict (rule_code) do update set
  module      = excluded.module,
  description = excluded.description,
  threshold   = excluded.threshold,
  comparator  = excluded.comparator,
  severity    = excluded.severity,
  is_active   = true;

-- ============================================================================
-- §F. GRANTS cho view mới
-- ============================================================================
grant select on
  public.vexim_ppc_policies,
  public.vexim_ppc_change_requests,
  public.vexim_ppc_suggestions,
  public.vexim_ads_negative_keywords
to authenticated, service_role;

-- ============================================================================
-- §G. TỰ KIỂM TRA (fail ngay trong migration, không để lỗi im lặng lên production)
-- ============================================================================
do $$
declare
  n      int;
  v_view text;
  v_fn   text;
  v_cols text;
begin
  -- G1. bảng mới có RLS
  select count(*) into n
  from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
  where (ns.nspname, c.relname) in (('ads','ppc_policies'),
                                    ('ads','change_requests'),
                                    ('ads','negative_keywords'))
    and c.relrowsecurity;
  if n <> 3 then
    raise exception '[0021] FAIL: chỉ %/3 bảng PPC chiều ghi có RLS', n;
  end if;

  -- G2. KHÔNG có policy ghi nào cho authenticated trên 3 bảng mới: mọi đường ghi
  -- phải qua RPC (để validate ngưỡng, phân quyền duyệt, và audit).
  select count(*) into n
  from pg_policies p
  where p.schemaname = 'ads'
    and p.tablename in ('change_requests','ppc_policies','negative_keywords')
    and p.cmd <> 'SELECT';
  if n <> 0 then
    raise exception '[0021] FAIL: còn % policy ghi cho client trên bảng PPC chiều ghi — phải xoá', n;
  end if;

  -- G3. view mới là security_invoker (RLS của bảng vẫn áp cho người đọc)
  foreach v_view in array array['vexim_ppc_policies','vexim_ppc_change_requests',
                                'vexim_ppc_suggestions','vexim_ads_negative_keywords'] loop
    select count(*) into n
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relname = v_view
      and c.relkind = 'v'
      and 'security_invoker=true' = any (c.reloptions);
    if n <> 1 then
      raise exception '[0021] FAIL: view % thiếu hoặc không security_invoker', v_view;
    end if;
  end loop;

  -- G4. RPC tồn tại
  foreach v_fn in array array['vexim_ppc_propose_changes','vexim_ppc_decide_change',
                              'vexim_ppc_decide_bulk','vexim_ppc_set_policy',
                              'vexim_worker_ppc_pending_changes','vexim_worker_ppc_set_result',
                              'vexim_ppc_raise_alerts'] loop
    select count(*) into n
    from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
    where ns.nspname = 'public' and pr.proname = v_fn;
    if n = 0 then
      raise exception '[0021] FAIL: thiếu hàm public.%', v_fn;
    end if;
  end loop;

  -- G4b. helper tên người thao tác phải SECURITY DEFINER (không thì view ra NULL
  -- với mọi user không phải super_admin, vì 0020 siết iam.user_profiles về "self")
  select count(*) into n
  from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
  where ns.nspname = 'iam' and pr.proname in ('is_ppc_approver','user_display') and pr.prosecdef;
  if n <> 2 then
    raise exception '[0021] FAIL: iam.is_ppc_approver/iam.user_display phải là security definer (%/2)', n;
  end if;

  -- G5. RPC của worker KHÔNG được cấp cho authenticated/anon
  if has_function_privilege('authenticated',
        'public.vexim_worker_ppc_pending_changes(uuid, integer, integer)', 'execute')
     or has_function_privilege('authenticated',
        'public.vexim_worker_ppc_set_result(jsonb)', 'execute')
     or has_function_privilege('authenticated',
        'public.vexim_ppc_raise_alerts(uuid)', 'execute') then
    raise exception '[0021] FAIL: RPC worker bị grant cho authenticated (client gọi được)';
  end if;

  -- G6. RPC người dùng KHÔNG cấp cho anon
  if has_function_privilege('anon', 'public.vexim_ppc_propose_changes(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.vexim_ppc_decide_change(uuid, text, text)', 'execute') then
    raise exception '[0021] FAIL: RPC đề xuất/duyệt PPC bị grant cho anon';
  end if;

  -- G7. trigger guard + audit phải có (mất audit là mất khả năng truy vết tiền)
  select count(*) into n
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
  where c.relname = 'change_requests' and not t.tgisinternal
    and t.tgname in ('trg_change_request_guard','trg_change_request_audit');
  if n <> 2 then
    raise exception '[0021] FAIL: ads.change_requests chỉ có %/2 trigger (guard + audit)', n;
  end if;

  -- G8. alert rules đã seed
  select count(*) into n from ops.alert_rules
  where rule_code in ('ppc_pending_approval','ppc_change_failed') and is_active;
  if n <> 2 then
    raise exception '[0021] FAIL: thiếu alert rule PPC (%/2)', n;
  end if;

  -- G9. khoá chống đề xuất trùng phải là index UNIQUE có điều kiện (partial)
  select count(*) into n
  from pg_indexes i
  where i.schemaname = 'ads' and i.indexname = 'uq_change_requests_open'
    and i.indexdef like '%UNIQUE%' and i.indexdef like '%WHERE%';
  if n <> 1 then
    raise exception '[0021] FAIL: thiếu unique index partial uq_change_requests_open';
  end if;

  -- G10. hợp đồng cột của view (web đọc theo tên cột — đổi là vỡ UI)
  select string_agg(column_name, ',' order by ordinal_position) into v_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'vexim_ppc_change_requests';
  if v_cols is null or position('summary' in v_cols) = 0
     or position('can_decide' in v_cols) = 0
     or position('before_number' in v_cols) = 0 then
    raise exception '[0021] FAIL: vexim_ppc_change_requests sai hợp đồng cột: %', coalesce(v_cols, '<rỗng>');
  end if;

  select string_agg(column_name, ',' order by ordinal_position) into v_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'vexim_ppc_suggestions';
  if v_cols is null or position('suggestion_key' in v_cols) = 0
     or position('after_value' in v_cols) = 0
     or position('has_open_request' in v_cols) = 0 then
    raise exception '[0021] FAIL: vexim_ppc_suggestions sai hợp đồng cột: %', coalesce(v_cols, '<rỗng>');
  end if;

  select string_agg(column_name, ',' order by ordinal_position) into v_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'vexim_ppc_policies';
  if v_cols is null or position('cap_left_today' in v_cols) = 0
     or position('auto_apply' in v_cols) = 0 then
    raise exception '[0021] FAIL: vexim_ppc_policies sai hợp đồng cột: %', coalesce(v_cols, '<rỗng>');
  end if;

  -- G11. regression: 0020 còn nguyên (view + RPC đọc không bị 0021 đụng)
  foreach v_view in array array['vexim_ads_kpis','vexim_ads_campaigns','vexim_ads_search_terms',
                                'vexim_ads_targeting','vexim_connections'] loop
    select count(*) into n
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relname = v_view;
    if n <> 1 then
      raise exception '[0021] FAIL: mất view % của 0020', v_view;
    end if;
  end loop;
  select count(*) into n
  from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
  where ns.nspname = 'public' and pr.proname like 'vexim_worker_upsert_ads_%';
  if n < 6 then
    raise exception '[0021] FAIL: mất RPC upsert Ads của 0020 (còn %/6)', n;
  end if;

  raise notice '[0021] OK: hàng đợi thay đổi PPC + guardrail + gợi ý + audit sẵn sàng';
end;
$$;

commit;
