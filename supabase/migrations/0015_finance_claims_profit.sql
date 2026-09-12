-- ============================================================================
-- 0015 — MODULE 6 (Đợt 2): F3 BỒI HOÀN FBA (CLAIMS) + F4 LỢI NHUẬN SKU
-- ============================================================================
-- MỤC ĐÍCH (docs/ke-hoach-trien-khai-theo-module.md mục Module 6, cấp 🟡):
--   F3 — Hàng đợi claim bồi hoàn FBA theo SOP-09:
--        1. đối chiếu tồn/thực nhận → danh sách KHOẢN NGHI NGỜ
--        2. phân loại (mất tại FC · hư khi nhập · thu sai phí · mất khi trả hàng)
--        3. ước tính giá trị (nhân giá vốn hiệu lực — KHÔNG bịa nếu thiếu giá vốn)
--        4. nộp case trên Seller Central → ghi mã case vào hệ thống
--        5. theo dõi (48h không phản hồi thì đẩy)
--        6. ghi nhận tiền về, đối chiếu với dữ liệu reimbursement của Amazon
--   F4 — Lợi nhuận SKU: doanh thu − phí Amazon − giá vốn −(ads) = lãi gộp & %,
--        sort tìm SKU lỗ; giá vốn lấy từ catalog.cost_inputs (effective-dated).
--
-- CHUẨN AMAZON (kiểm chứng developer-docs.amazon.com, 12/09/2026):
--   • Report `GET_FBA_REIMBURSEMENTS_DATA` (FBA Reimbursements Report) —
--     role Pricing / Amazon Fulfillment, tab-delimited, cập nhật hằng ngày.
--     Cột: approval-date, reimbursement-id, case-id, amazon-order-id, reason,
--     sku, fnsku, asin, product-name, condition, currency-unit, amount-per-unit,
--     amount-total, quantity-reimbursed-cash, quantity-reimbursed-inventory,
--     quantity-reimbursed-total, original-reimbursement-id,
--     original-reimbursement-type.
--     https://developer-docs.amazon.com/sp-api/docs/report-type-values-fba
--   • Report `GET_LEDGER_DETAIL_VIEW_DATA` (Inventory Ledger — Detailed View) —
--     nguồn phát hiện khoản nghi ngờ: EventType (Adjustments/CustomerReturns/
--     Receipts/Shipments/…), Reason, Disposition, Quantity, ReferenceID,
--     ReconciledQuantity/UnreconciledQuantity. Role Amazon Fulfillment.
--   • Product Fees API v0 — `getMyFeesEstimates` (batch ≤ 20 SKU/ASIN, role
--     Pricing/Product Listing) để ƯỚC TÍNH phí khi chưa có phí thật đã quyết
--     toán; docs ghi rõ "estimated fees are not guaranteed" → hệ thống lưu
--     `fee_source` để người dùng biết số nào là phí THẬT, số nào là ước tính.
--     https://developer-docs.amazon.com/sp-api/docs/product-fees-api
--   • Finances API: bản hiện hành là **v2024-06-19** (listTransactions /
--     listBalances / listSummary); bản **v0** (listFinancialEvents) vẫn còn và
--     worker đang dùng cho delta/backfill — KHÔNG dùng cho đối soát kỳ đã chốt
--     (kỳ đã chốt lấy từ report settlement, xem 0010).
--
-- NGUYÊN TẮC AN TOÀN (kế thừa 0014):
--   • Worker (service_role, `auth.uid() is null`) CHỈ được:
--       – upsert dòng reimbursement do Amazon trả (idempotent theo dedupe_key);
--       – chèn/refresh khoản nghi ngờ CÒN Ở trạng thái `suspected`;
--       – ghi lại bảng lợi nhuận SKU đã tính.
--     Worker KHÔNG được đụng vào khoản con người đã chuyển trạng thái.
--   • Web ghi DUY NHẤT qua RPC public (bài học PGRST202 của 0008) + RLS theo shop.
--   • Mọi thay đổi trạng thái claim do TRIGGER ghi lịch sử append-only.
--   • Không phơi PII (view chỉ có dữ liệu nghiệp vụ; `actor_email` không ra view).
--
-- Idempotent: create table/index/view `if not exists` / `create or replace`,
-- policy+trigger drop trước khi tạo. Chạy SAU 0014.
-- ============================================================================

begin;

-- ============================================================================
-- 1. finance.reimbursements — MỞ RỘNG ĐỂ IMPORT REPORT CỦA AMAZON
-- ============================================================================
-- Bảng đã có từ 0001 (case_id, reimbursement_type, amount, status…) nhưng thiếu
-- cột để import đúng report + chống trùng khi chạy lại hằng tuần (SOP-09).
alter table finance.reimbursements add column if not exists reimbursement_id  text;
alter table finance.reimbursements add column if not exists sku               text;
alter table finance.reimbursements add column if not exists fnsku             text;
alter table finance.reimbursements add column if not exists asin              text;
alter table finance.reimbursements add column if not exists reason            text;
alter table finance.reimbursements add column if not exists condition         text;
alter table finance.reimbursements add column if not exists amount_per_unit   numeric(12,4);
alter table finance.reimbursements add column if not exists quantity_reimbursed_cash      int;
alter table finance.reimbursements add column if not exists quantity_reimbursed_inventory int;
alter table finance.reimbursements add column if not exists quantity_reimbursed_total     int;
alter table finance.reimbursements add column if not exists approval_date     date;
alter table finance.reimbursements add column if not exists original_reimbursement_id   text;
alter table finance.reimbursements add column if not exists original_reimbursement_type text;
alter table finance.reimbursements add column if not exists marketplace_id    text;
alter table finance.reimbursements add column if not exists dedupe_key        text not null default '';
alter table finance.reimbursements add column if not exists imported_at       timestamptz;

comment on column finance.reimbursements.dedupe_key is
  'Khoá chống trùng khi import lại report GET_FBA_REIMBURSEMENTS_DATA (reimbursement-id + sku + reason).';
comment on column finance.reimbursements.reimbursement_id is
  'reimbursement-id của Amazon — dùng để đối chiếu tiền về với claim nội bộ (SOP-09 bước 6).';

create unique index if not exists uq_reimbursements_dedupe
  on finance.reimbursements (seller_account_id, dedupe_key);

create index if not exists idx_reimbursements_sku
  on finance.reimbursements (seller_account_id, sku);
create index if not exists idx_reimbursements_approval
  on finance.reimbursements (seller_account_id, approval_date desc);

-- ============================================================================
-- 2. finance.reimbursement_claims — HÀNG ĐỢI CLAIM (SOP-09)
-- ============================================================================
create table if not exists finance.reimbursement_claims (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  marketplace_id    text not null default 'ATVPDKIKX0DER',
  sku               text not null,
  fnsku             text,
  asin              text,
  -- Phân loại SOP-09 bước 2; 'other' để người dùng tự phân loại lại (kèm lý do gốc)
  category          text not null default 'other'
                    check (category in ('lost_fc','damaged_fc','inbound_missing',
                                        'fee_error','return_missing','other')),
  -- Nguồn phát hiện
  source            text not null default 'manual'
                    check (source in ('ledger','inbound','adjustment','manual')),
  -- Khoá nguồn (ReferenceID của ledger / shipment-id của inbound / mã tự sinh)
  source_ref        text not null default '',
  source_date       date,
  source_reason     text,                     -- lý do gốc Amazon trả về (chưa diễn giải)
  quantity          int check (quantity is null or quantity > 0),
  currency          text not null default 'USD',
  -- Giá vốn hiệu lực tại ngày phát hiện (catalog.effective_cost). NULL = chưa có
  -- giá vốn → estimated_amount cũng NULL (KHÔNG bịa số).
  unit_cost         numeric(12,4) check (unit_cost is null or unit_cost >= 0),
  estimated_amount  numeric(12,2) check (estimated_amount is null or estimated_amount >= 0),
  status            text not null default 'suspected'
                    check (status in ('suspected','to_claim','filed','approved',
                                      'rejected','paid','closed')),
  amazon_case_id    text,
  filed_at          timestamptz,
  filed_by          uuid references iam.user_profiles(id),
  decided_at        timestamptz,
  decided_by        uuid references iam.user_profiles(id),
  decision_note     text,
  -- Tiền thực về (đối chiếu bước 6) + mã reimbursement của Amazon
  reimbursed_amount numeric(12,2),
  reimbursement_id  text,
  evidence          jsonb,                    -- ảnh chụp/ghi chú/link case (không chứa PII người mua)
  note              text,
  created_by        uuid references iam.user_profiles(id),
  updated_by        uuid references iam.user_profiles(id),
  detected_at       timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (seller_account_id, source, source_ref, sku)
);

comment on table finance.reimbursement_claims is
  'F3/SOP-09: hàng đợi claim bồi hoàn FBA — khoản nghi ngờ → nộp case → kết luận → tiền về.';

create index if not exists idx_reimb_claims_status
  on finance.reimbursement_claims (seller_account_id, status, detected_at desc);
create index if not exists idx_reimb_claims_sku
  on finance.reimbursement_claims (seller_account_id, sku);

-- ============================================================================
-- 3. finance.reimbursement_claim_events — LỊCH SỬ APPEND-ONLY
-- ============================================================================
create table if not exists finance.reimbursement_claim_events (
  id                uuid primary key default gen_random_uuid(),
  claim_id          uuid not null references finance.reimbursement_claims(id) on delete cascade,
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  stage             text not null
                    check (stage in ('detected','to_claim','filed','approved','rejected',
                                     'paid','closed','updated')),
  from_status       text,
  to_status         text,
  actor_id          uuid references iam.user_profiles(id),
  actor_email       text,                     -- nội bộ VEXIM; KHÔNG phơi ra view public
  note              text,
  created_at        timestamptz not null default now()
);

comment on table finance.reimbursement_claim_events is
  'F3: lịch sử claim do trigger ghi — client không insert/update/delete.';

create index if not exists idx_reimb_claim_events_claim
  on finance.reimbursement_claim_events (claim_id, created_at desc);

-- ============================================================================
-- 4. finance.sku_profit_daily — LỢI NHUẬN SKU THEO NGÀY (worker tính, web đọc)
-- ============================================================================
create table if not exists finance.sku_profit_daily (
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  sku               text not null,
  day               date not null,
  currency          text not null default 'USD',
  units             int not null default 0,
  revenue           numeric(12,2) not null default 0,   -- bán (đã trừ hoàn) — xem refunds
  refunds           numeric(12,2) not null default 0,   -- số âm/dương nguyên theo report
  amazon_fees       numeric(12,2) not null default 0,
  promo             numeric(12,2) not null default 0,
  cogs              numeric(12,2),                      -- NULL = chưa có giá vốn
  ads_spend         numeric(12,2),                      -- NULL = Module 5 chưa có dữ liệu
  gross_profit      numeric(12,2),                      -- NULL khi thiếu giá vốn
  unit_cost         numeric(12,4),
  -- Nguồn số liệu để người dùng biết số nào là THẬT, số nào là ƯỚC TÍNH
  fee_source        text not null default 'settled'
                    check (fee_source in ('settled','fees_api','unavailable')),
  computed_at       timestamptz not null default now(),
  primary key (seller_account_id, sku, day, currency)
);

comment on table finance.sku_profit_daily is
  'F4: lợi nhuận gộp theo SKU/ngày — doanh thu & phí từ dòng settlement đã quyết toán; '
  'cogs từ catalog.cost_inputs; ads_spend chỉ có khi Module 5 (PPC) đồng bộ.';

create index if not exists idx_sku_profit_day
  on finance.sku_profit_daily (seller_account_id, day desc);

-- ============================================================================
-- 5. HELPER: ai được kết luận claim (trưởng phòng Tài chính / admin)
-- ============================================================================
create or replace function iam.is_finance_editor()
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
             and d.code = 'finance'
         );
$$;

comment on function iam.is_finance_editor() is
  'F3/SOP-09: trưởng phòng Tài chính (hoặc admin) — người kết luận claim (approve/reject/paid/close).';

-- ============================================================================
-- 6. MÁY TRẠNG THÁI + LỊCH SỬ (trigger)
-- ============================================================================
create or replace function finance.reimbursement_claim_guard()
returns trigger
language plpgsql
security definer
set search_path = finance, iam, pg_catalog
as $$
declare
  v_actor       uuid := auth.uid();
  v_service     boolean := v_actor is null;     -- service_role (worker) không có JWT sub
  v_actor_email text;
  v_valid       boolean;
begin
  if v_actor is not null then
    select up.email into v_actor_email from iam.user_profiles up where up.id = v_actor;
  end if;

  if tg_op = 'INSERT' then
    if new.status not in ('suspected','to_claim') then
      raise exception '[F3] khoản claim mới chỉ được ở trạng thái suspected/to_claim (nhận %)', new.status
        using errcode = 'check_violation';
    end if;
    if new.status = 'to_claim' and coalesce(new.estimated_amount, 0) <= 0 then
      raise exception '[F3] muốn chuyển sang "cần nộp" phải có giá trị ước tính > 0 (thiếu giá vốn thì bổ sung trước)'
        using errcode = 'check_violation';
    end if;
    new.created_by := coalesce(new.created_by, v_actor);
    new.updated_by := coalesce(new.updated_by, v_actor);
    return new;
  end if;

  -- ---------- UPDATE ----------
  -- Khoá nguồn phát hiện: không cho đổi shop/SKU/nguồn (chống "di chuyển" claim)
  if new.seller_account_id <> old.seller_account_id
     or new.sku <> old.sku
     or new.source <> old.source
     or new.source_ref <> old.source_ref then
    raise exception '[F3] không được đổi shop / SKU / nguồn phát hiện của khoản claim'
      using errcode = 'check_violation';
  end if;

  -- Worker chỉ được refresh khoản còn 'suspected'
  if v_service and old.status <> 'suspected' then
    raise exception '[F3] worker chỉ cập nhật được khoản còn ở trạng thái suspected (khoản đang % là việc của con người)', old.status
      using errcode = 'insufficient_privilege';
  end if;

  if new.status <> old.status then
    v_valid := (old.status, new.status) in (
      ('suspected','to_claim'), ('suspected','closed'),
      ('to_claim','filed'), ('to_claim','closed'),
      ('filed','approved'), ('filed','rejected'), ('filed','closed'),
      ('approved','paid'), ('approved','closed'),
      ('rejected','to_claim'), ('rejected','closed'),   -- nộp lại sau khi bị từ chối
      ('paid','closed')
    );
    if not v_valid then
      raise exception '[F3] chuyển trạng thái không hợp lệ: % → %', old.status, new.status
        using errcode = 'check_violation';
    end if;

    if new.status = 'filed' then
      if coalesce(btrim(new.amazon_case_id), '') = '' then
        raise exception '[F3] phải ghi mã case Amazon (SOP-09 bước 4) trước khi đánh dấu đã nộp'
          using errcode = 'check_violation';
      end if;
      new.filed_at := coalesce(new.filed_at, now());
      new.filed_by := coalesce(new.filed_by, v_actor);
    end if;

    if new.status in ('approved','rejected') then
      if coalesce(btrim(new.decision_note), '') = '' then
        raise exception '[F3] phải ghi kết luận của Amazon khi đánh dấu %', new.status
          using errcode = 'check_violation';
      end if;
      new.decided_at := coalesce(new.decided_at, now());
      new.decided_by := coalesce(new.decided_by, v_actor);
    end if;

    if new.status = 'paid' and new.reimbursed_amount is null then
      raise exception '[F3] phải ghi số tiền thực nhận (SOP-09 bước 6) trước khi đánh dấu đã về tiền'
        using errcode = 'check_violation';
    end if;
  end if;

  new.updated_at := now();
  new.updated_by := coalesce(v_actor, old.updated_by);
  new.created_by := old.created_by;
  new.detected_at := old.detected_at;
  return new;
end;
$$;

comment on function finance.reimbursement_claim_guard() is
  'F3: máy trạng thái claim + chốt dữ liệu bắt buộc (case id khi nộp, kết luận khi duyệt/từ chối, số tiền khi đã về).';

drop trigger if exists trg_reimbursement_claim_guard on finance.reimbursement_claims;
create trigger trg_reimbursement_claim_guard
  before insert or update on finance.reimbursement_claims
  for each row execute function finance.reimbursement_claim_guard();

create or replace function finance.reimbursement_claim_history()
returns trigger
language plpgsql
security definer
set search_path = finance, iam, pg_catalog
as $$
declare
  v_actor uuid := auth.uid();
  v_email text;
  v_stage text;
begin
  if v_actor is not null then
    select up.email into v_email from iam.user_profiles up where up.id = v_actor;
  end if;

  if tg_op = 'INSERT' then
    v_stage := 'detected';
  elsif new.status <> old.status then
    v_stage := new.status;
  else
    v_stage := 'updated';
  end if;

  insert into finance.reimbursement_claim_events (
    claim_id, seller_account_id, stage, from_status, to_status, actor_id, actor_email, note
  ) values (
    new.id, new.seller_account_id, v_stage,
    case when tg_op = 'INSERT' then null else old.status end,
    new.status, v_actor, v_email,
    nullif(btrim(coalesce(new.decision_note, new.note, '')), '')
  );
  return null;   -- AFTER trigger
end;
$$;

comment on function finance.reimbursement_claim_history() is
  'F3: ghi lịch sử claim append-only (detected / đổi trạng thái / cập nhật).';

drop trigger if exists trg_reimbursement_claim_history on finance.reimbursement_claims;
create trigger trg_reimbursement_claim_history
  after insert or update on finance.reimbursement_claims
  for each row execute function finance.reimbursement_claim_history();

-- ============================================================================
-- 7. RLS
-- ============================================================================
alter table finance.reimbursement_claims        enable row level security;
alter table finance.reimbursement_claim_events  enable row level security;
alter table finance.sku_profit_daily            enable row level security;

-- Đọc theo shop (kế thừa mô hình 0001 — bảng mới phải tự khai policy vì DO-block
-- tự động của 0001 chỉ chạy một lần ở thời điểm đó).
drop policy if exists rls_read_reimbursement_claims on finance.reimbursement_claims;
create policy rls_read_reimbursement_claims on finance.reimbursement_claims
  for select using (iam.can_read_seller_account(seller_account_id));

drop policy if exists rls_write_reimbursement_claims on finance.reimbursement_claims;
create policy rls_write_reimbursement_claims on finance.reimbursement_claims
  for update to authenticated
  using (iam.can_write_seller_account(seller_account_id))
  with check (iam.can_write_seller_account(seller_account_id));

drop policy if exists rls_insert_reimbursement_claims on finance.reimbursement_claims;
create policy rls_insert_reimbursement_claims on finance.reimbursement_claims
  for insert to authenticated
  with check (iam.can_write_seller_account(seller_account_id));

drop policy if exists rls_read_reimbursement_claim_events on finance.reimbursement_claim_events;
create policy rls_read_reimbursement_claim_events on finance.reimbursement_claim_events
  for select using (iam.can_read_seller_account(seller_account_id));

drop policy if exists rls_read_sku_profit_daily on finance.sku_profit_daily;
create policy rls_read_sku_profit_daily on finance.sku_profit_daily
  for select using (iam.can_read_seller_account(seller_account_id));
-- KHÔNG có policy ghi cho authenticated: bảng lợi nhuận do worker tính (service_role).

-- ============================================================================
-- 8A. RPC CHO WEB — cập nhật trạng thái claim (1 cửa duy nhất)
-- ============================================================================
create or replace function public.vexim_update_reimbursement_claim(
  p_claim_id uuid,
  p_action   text,                    -- to_claim | file | approve | reject | paid | close | reopen
  p_case_id  text default null,
  p_amount   numeric default null,
  p_note     text default null,
  p_evidence jsonb default null
)
returns table (claim_id uuid, status text, claim_event text)
language plpgsql
security definer
set search_path = finance, iam, public, pg_catalog
as $$
declare
  v_row   finance.reimbursement_claims%rowtype;
  v_actor uuid := auth.uid();
  v_next  text;
begin
  if v_actor is null then
    raise exception '[F3] RPC này cần phiên đăng nhập (worker dùng RPC riêng)'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_row from finance.reimbursement_claims where id = p_claim_id for update;
  if not found then
    raise exception '[F3] không tìm thấy khoản claim %', p_claim_id
      using errcode = 'no_data_found';
  end if;
  if not iam.can_write_seller_account(v_row.seller_account_id) then
    raise exception '[F3] bạn không có quyền ghi trên shop của khoản claim này'
      using errcode = 'insufficient_privilege';
  end if;

  -- Kết luận claim là việc của trưởng phòng Tài chính (SOP-09: Tài chính chủ trì)
  if p_action in ('approve','reject','paid','close') and not iam.is_finance_editor() then
    raise exception '[F3] chỉ trưởng phòng Tài chính (hoặc admin) được kết luận claim'
      using errcode = 'insufficient_privilege';
  end if;

  v_next := case p_action
              when 'to_claim' then 'to_claim'
              when 'file'     then 'filed'
              when 'approve'  then 'approved'
              when 'reject'   then 'rejected'
              when 'paid'     then 'paid'
              when 'close'    then 'closed'
              when 'reopen'   then 'to_claim'
              else null
            end;
  if v_next is null then
    raise exception '[F3] action không hợp lệ: %', p_action
      using errcode = 'invalid_parameter_value';
  end if;

  update finance.reimbursement_claims c
     set status            = v_next,
         amazon_case_id    = coalesce(nullif(btrim(coalesce(p_case_id, '')), ''), c.amazon_case_id),
         reimbursed_amount = coalesce(p_amount, c.reimbursed_amount),
         decision_note     = coalesce(nullif(btrim(coalesce(p_note, '')), ''), c.decision_note),
         note              = coalesce(nullif(btrim(coalesce(p_note, '')), ''), c.note),
         evidence          = coalesce(p_evidence, c.evidence)
   where c.id = p_claim_id;

  return query
    select p_claim_id,
           (select c.status from finance.reimbursement_claims c where c.id = p_claim_id),
           (select e.stage from finance.reimbursement_claim_events e
             where e.claim_id = p_claim_id order by e.created_at desc limit 1);
end;
$$;

comment on function public.vexim_update_reimbursement_claim is
  'F3: web chuyển trạng thái claim theo SOP-09 (trigger là chốt cuối về luật + lịch sử).';

grant execute on function public.vexim_update_reimbursement_claim(uuid, text, text, numeric, text, jsonb)
  to authenticated, service_role;

-- ============================================================================
-- 8B. RPC CHO WORKER — nhập report + ghi lợi nhuận (chỉ service_role)
-- ============================================================================
-- Worker chạy service_role, `auth.uid()` = NULL. Ba RPC dưới đây là cửa duy
-- nhất để worker ghi dữ liệu F3/F4.

-- 8B.1 Import report GET_FBA_REIMBURSEMENTS_DATA (idempotent theo dedupe_key)
create or replace function public.vexim_worker_upsert_reimbursements(
  p_seller uuid,
  p_rows   jsonb
)
returns table (inserted int, updated int)
language plpgsql
security definer
set search_path = finance, public, pg_catalog
as $$
declare
  v_ins int := 0;
  v_upd int := 0;
begin
  if auth.uid() is not null then
    raise exception '[F3] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '[F3] p_rows phải là JSON array (nhận %)',
      coalesce(jsonb_typeof(p_rows), 'NULL')
      using errcode = 'invalid_parameter_value';
  end if;

  -- Đếm dòng đã tồn tại TRƯỚC khi ghi để trả về số liệu trung thực cho log.
  select count(*) into v_upd
    from jsonb_array_elements(p_rows) r
   where exists (
     select 1 from finance.reimbursements x
      where x.seller_account_id = p_seller
        and x.dedupe_key = coalesce(r->>'dedupeKey', '')
   );

  insert into finance.reimbursements as t (
    seller_account_id, reimbursement_id, case_id, reimbursement_type, sku, fnsku, asin,
    reason, condition, amount_per_unit, amount, currency,
    quantity_reimbursed_cash, quantity_reimbursed_inventory, quantity_reimbursed_total,
    approval_date, original_reimbursement_id, original_reimbursement_type,
    marketplace_id, dedupe_key, status, opened_at, resolved_at, imported_at
  )
  select
    p_seller,
    nullif(r->>'reimbursementId', ''),
    nullif(r->>'caseId', ''),
    nullif(r->>'reason', ''),                       -- Lost | Damaged | Lost_Inbound …
    nullif(r->>'sku', ''),
    nullif(r->>'fnsku', ''),
    nullif(r->>'asin', ''),
    nullif(r->>'reason', ''),
    nullif(r->>'condition', ''),
    nullif(r->>'amountPerUnit', '')::numeric,
    nullif(r->>'amountTotal', '')::numeric,
    coalesce(nullif(r->>'currency', ''), 'USD'),
    nullif(r->>'quantityReimbursedCash', '')::int,
    nullif(r->>'quantityReimbursedInventory', '')::int,
    nullif(r->>'quantityReimbursedTotal', '')::int,
    nullif(r->>'approvalDate', '')::date,
    nullif(r->>'originalReimbursementId', ''),
    nullif(r->>'originalReimbursementType', ''),
    nullif(r->>'marketplaceId', ''),
    coalesce(r->>'dedupeKey', ''),
    'approved',            -- tiền Amazon đã trả (report là các khoản đã được duyệt/trả)
    nullif(r->>'approvalDate', '')::date,
    nullif(r->>'approvalDate', '')::timestamptz,
    now()
  from jsonb_array_elements(p_rows) r
  -- Dùng danh sách cột (index unique, KHÔNG phải constraint) — ở đây không đụng
  -- tên tham số OUT nào nên không bị lỗi ambiguous như trường hợp 0014 §7C.
  on conflict (seller_account_id, dedupe_key)
  do update set
    amount        = excluded.amount,
    amount_per_unit = excluded.amount_per_unit,
    quantity_reimbursed_total = excluded.quantity_reimbursed_total,
    approval_date = excluded.approval_date,
    status        = excluded.status,
    resolved_at   = excluded.resolved_at,
    imported_at   = excluded.imported_at;

  get diagnostics v_ins = row_count;
  v_ins := greatest(v_ins - v_upd, 0);

  return query select v_ins, v_upd;
end;
$$;

comment on function public.vexim_worker_upsert_reimbursements is
  'F3: worker nhập report GET_FBA_REIMBURSEMENTS_DATA (idempotent theo dedupe_key) — chỉ service_role.';

-- 8B.2 Ghi khoản NGHI NGỜ — chỉ chèn mới / refresh dòng còn 'suspected'
create or replace function public.vexim_worker_upsert_claims(
  p_seller uuid,
  p_rows   jsonb
)
returns table (inserted int, refreshed int, kept int)
language plpgsql
security definer
set search_path = finance, public, pg_catalog
as $$
declare
  v_total int := 0;
  v_ins   int := 0;
  v_upd   int := 0;
begin
  if auth.uid() is not null then
    raise exception '[F3] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '[F3] p_rows phải là JSON array'
      using errcode = 'invalid_parameter_value';
  end if;

  select count(*) into v_total from jsonb_array_elements(p_rows);

  -- 1) refresh dòng CÒN suspected (worker được cập nhật số liệu phát hiện)
  update finance.reimbursement_claims c
     set quantity         = nullif(s->>'quantity', '')::int,
         unit_cost        = nullif(s->>'unitCost', '')::numeric,
         estimated_amount = nullif(s->>'estimatedAmount', '')::numeric,
         source_date      = nullif(s->>'sourceDate', '')::date,
         source_reason    = nullif(s->>'sourceReason', ''),
         category         = coalesce(nullif(s->>'category', ''), c.category),
         fnsku            = coalesce(nullif(s->>'fnsku', ''), c.fnsku),
         asin             = coalesce(nullif(s->>'asin', ''), c.asin),
         updated_at       = now()
    from jsonb_array_elements(p_rows) s
   where c.seller_account_id = p_seller
     and c.source     = coalesce(nullif(s->>'source', ''), 'ledger')
     and c.source_ref = coalesce(s->>'sourceRef', '')
     and c.sku        = coalesce(s->>'sku', '')
     and c.status     = 'suspected';
  get diagnostics v_upd = row_count;

  -- 2) chèn dòng mới; đụng khoá = đã có (kể cả dòng con người đang giữ) → bỏ qua
  insert into finance.reimbursement_claims (
    seller_account_id, marketplace_id, sku, fnsku, asin, category, source, source_ref,
    source_date, source_reason, quantity, currency, unit_cost, estimated_amount, status
  )
  select
    p_seller,
    coalesce(nullif(s->>'marketplaceId', ''), 'ATVPDKIKX0DER'),
    s->>'sku',
    nullif(s->>'fnsku', ''),
    nullif(s->>'asin', ''),
    coalesce(nullif(s->>'category', ''), 'other'),
    coalesce(nullif(s->>'source', ''), 'ledger'),
    coalesce(s->>'sourceRef', ''),
    nullif(s->>'sourceDate', '')::date,
    nullif(s->>'sourceReason', ''),
    nullif(s->>'quantity', '')::int,
    coalesce(nullif(s->>'currency', ''), 'USD'),
    nullif(s->>'unitCost', '')::numeric,
    nullif(s->>'estimatedAmount', '')::numeric,
    'suspected'
  from jsonb_array_elements(p_rows) s
  where coalesce(s->>'sku', '') <> ''
  on conflict (seller_account_id, source, source_ref, sku) do nothing;
  get diagnostics v_ins = row_count;

  return query select v_ins, v_upd, greatest(v_total - v_ins - v_upd, 0);
end;
$$;

comment on function public.vexim_worker_upsert_claims is
  'F3: worker ghi khoản nghi ngờ mới + refresh khoản còn suspected; KHÔNG đụng khoản con người đang xử lý.';

-- 8B.3 Ghi lợi nhuận SKU theo ngày (worker tính từ settlement + giá vốn)
create or replace function public.vexim_worker_upsert_profit(
  p_seller uuid,
  p_rows   jsonb
)
returns table (upserted int)
language plpgsql
security definer
set search_path = finance, public, pg_catalog
as $$
declare
  v_n int := 0;
begin
  if auth.uid() is not null then
    raise exception '[F4] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '[F4] p_rows phải là JSON array'
      using errcode = 'invalid_parameter_value';
  end if;

  insert into finance.sku_profit_daily as t (
    seller_account_id, sku, day, currency, units, revenue, refunds, amazon_fees, promo,
    cogs, ads_spend, gross_profit, unit_cost, fee_source, computed_at
  )
  select
    p_seller,
    s->>'sku',
    (s->>'day')::date,
    coalesce(nullif(s->>'currency', ''), 'USD'),
    coalesce(nullif(s->>'units', '')::int, 0),
    coalesce(nullif(s->>'revenue', '')::numeric, 0),
    coalesce(nullif(s->>'refunds', '')::numeric, 0),
    coalesce(nullif(s->>'amazonFees', '')::numeric, 0),
    coalesce(nullif(s->>'promo', '')::numeric, 0),
    nullif(s->>'cogs', '')::numeric,
    nullif(s->>'adsSpend', '')::numeric,
    nullif(s->>'grossProfit', '')::numeric,
    nullif(s->>'unitCost', '')::numeric,
    coalesce(nullif(s->>'feeSource', ''), 'settled'),
    now()
  from jsonb_array_elements(p_rows) s
  where coalesce(s->>'sku', '') <> ''
    and coalesce(s->>'day', '') <> ''
  on conflict (seller_account_id, sku, day, currency)
  do update set
    units        = excluded.units,
    revenue      = excluded.revenue,
    refunds      = excluded.refunds,
    amazon_fees  = excluded.amazon_fees,
    promo        = excluded.promo,
    cogs         = excluded.cogs,
    ads_spend    = excluded.ads_spend,
    gross_profit = excluded.gross_profit,
    unit_cost    = excluded.unit_cost,
    fee_source   = excluded.fee_source,
    computed_at  = excluded.computed_at;

  get diagnostics v_n = row_count;
  return query select v_n;
end;
$$;

comment on function public.vexim_worker_upsert_profit is
  'F4: worker ghi lợi nhuận SKU/ngày — chỉ service_role.';

-- 8B.4 Đọc dữ liệu để tính (worker không query thẳng bảng nghiệp vụ)
create or replace function public.vexim_worker_financial_events(
  p_seller uuid,
  p_from   date,
  p_to     date,
  p_limit  int default 50000
)
returns table (
  sku                text,
  event_type         text,
  amount_type        text,
  amount_description text,
  amount             numeric,
  quantity           int,
  currency           text,
  event_date         timestamptz
)
language plpgsql
security definer
set search_path = finance, public, pg_catalog
as $$
begin
  if auth.uid() is not null then
    raise exception '[F4] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;

  return query
    select e.sku, e.event_type, e.amount_type, e.amount_description,
           e.amount, e.quantity, e.currency, e.event_date
      from finance.financial_events e
     where e.seller_account_id = p_seller
       and e.event_date >= p_from::timestamptz
       and e.event_date <  (p_to + 1)::timestamptz
     order by e.event_date
     limit greatest(1, least(coalesce(p_limit, 50000), 200000));
end;
$$;

comment on function public.vexim_worker_financial_events is
  'F4: worker đọc dòng tiền trong kỳ để tính lợi nhuận SKU (chỉ service_role).';

create or replace function public.vexim_worker_effective_costs(
  p_seller uuid,
  p_on     date default current_date
)
returns table (sku text, unit_cost numeric, currency text)
language plpgsql
security definer
set search_path = catalog, public, pg_catalog
as $$
begin
  if auth.uid() is not null then
    raise exception '[F4] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;

  return query
    select c.sku, c.unit_cost, c.currency
      from catalog.cost_inputs c
     where c.seller_account_id = p_seller
       and c.effective_from <= p_on
       and (c.effective_to is null or c.effective_to > p_on)
     order by c.sku, c.effective_from desc;
end;
$$;

comment on function public.vexim_worker_effective_costs is
  'F4: giá vốn hiệu lực tại một ngày (catalog.cost_inputs) cho worker (chỉ service_role).';

-- Chỉ worker: không cho anon/authenticated gọi các RPC trên.
revoke all on function public.vexim_worker_upsert_reimbursements(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.vexim_worker_upsert_claims(uuid, jsonb)         from public, anon, authenticated;
revoke all on function public.vexim_worker_upsert_profit(uuid, jsonb)         from public, anon, authenticated;
revoke all on function public.vexim_worker_financial_events(uuid, date, date, int) from public, anon, authenticated;
revoke all on function public.vexim_worker_effective_costs(uuid, date)        from public, anon, authenticated;

grant execute on function public.vexim_worker_upsert_reimbursements(uuid, jsonb) to service_role;
grant execute on function public.vexim_worker_upsert_claims(uuid, jsonb)         to service_role;
grant execute on function public.vexim_worker_upsert_profit(uuid, jsonb)         to service_role;
grant execute on function public.vexim_worker_financial_events(uuid, date, date, int) to service_role;
grant execute on function public.vexim_worker_effective_costs(uuid, date)        to service_role;

-- ============================================================================
-- 9. VIEW PUBLIC (web đọc bằng anon key + RLS enforced)
-- ============================================================================
create or replace view public.vexim_reimbursements
with (security_invoker = true) as
select
  r.id,
  r.seller_account_id,
  sa.display_name            as shop,
  r.reimbursement_id,
  r.case_id,
  r.marketplace_id,
  r.sku,
  r.fnsku,
  r.asin,
  r.reason,
  r.condition,
  r.amount_per_unit,
  r.amount,
  r.currency,
  r.quantity_reimbursed_total,
  r.quantity_reimbursed_cash,
  r.quantity_reimbursed_inventory,
  r.original_reimbursement_type,
  r.approval_date,
  r.status,
  r.imported_at
from finance.reimbursements r
join connections.seller_accounts sa on sa.id = r.seller_account_id;

create or replace view public.vexim_reimbursement_claims
with (security_invoker = true) as
select
  c.id,
  c.seller_account_id,
  sa.display_name            as shop,
  c.marketplace_id,
  c.sku,
  c.fnsku,
  c.asin,
  c.category,
  c.source,
  c.source_ref,
  c.source_date,
  c.source_reason,
  c.quantity,
  c.currency,
  c.unit_cost,
  c.estimated_amount,
  c.status,
  c.amazon_case_id,
  c.filed_at,
  c.filed_by,
  c.decided_at,
  c.decided_by,
  c.decision_note,
  c.reimbursed_amount,
  c.reimbursement_id,
  c.evidence,
  c.note,
  c.detected_at,
  c.updated_at,
  -- tuổi claim (giờ) để web/worker áp SLA 48h của SOP-09 bước 5 mà không cần
  -- đồng hồ của client (client có thể lệch giờ máy)
  round(extract(epoch from (now() - coalesce(c.filed_at, c.detected_at))) / 3600)::int as age_hours
from finance.reimbursement_claims c
join connections.seller_accounts sa on sa.id = c.seller_account_id;

create or replace view public.vexim_reimbursement_claim_events
with (security_invoker = true) as
select
  e.id,
  e.claim_id,
  e.seller_account_id,
  sa.display_name            as shop,
  e.stage,
  e.from_status,
  e.to_status,
  e.actor_id,
  e.note,
  e.created_at
from finance.reimbursement_claim_events e
join connections.seller_accounts sa on sa.id = e.seller_account_id;

create or replace view public.vexim_sku_profit
with (security_invoker = true) as
select
  p.seller_account_id,
  sa.display_name            as shop,
  p.sku,
  p.day,
  p.currency,
  p.units,
  p.revenue,
  p.refunds,
  p.amazon_fees,
  p.promo,
  p.cogs,
  p.ads_spend,
  p.gross_profit,
  p.unit_cost,
  p.fee_source,
  p.computed_at
from finance.sku_profit_daily p
join connections.seller_accounts sa on sa.id = p.seller_account_id;

-- ============================================================================
-- 10. GRANTS
-- ============================================================================
grant select, insert, update on finance.reimbursement_claims       to authenticated;
grant select                  on finance.reimbursement_claim_events to authenticated;
grant select                  on finance.sku_profit_daily           to authenticated;
grant select                  on finance.reimbursements             to authenticated;

grant all on finance.reimbursement_claims,
             finance.reimbursement_claim_events,
             finance.sku_profit_daily,
             finance.reimbursements
  to service_role;

grant select on
  public.vexim_reimbursements,
  public.vexim_reimbursement_claims,
  public.vexim_reimbursement_claim_events,
  public.vexim_sku_profit
to authenticated, service_role;

-- ============================================================================
-- 11. KIỂM CHỨNG (fail sớm nếu thiếu thành phần)
-- ============================================================================
do $$
declare
  n_tables int;
  n_views  int;
  n_trg    int;
  n_rpc    int;
begin
  select count(*) into n_tables
  from information_schema.tables
  where table_schema = 'finance'
    and table_name in ('reimbursement_claims','reimbursement_claim_events','sku_profit_daily');
  if n_tables <> 3 then
    raise exception '[0015] FAIL: chỉ thấy % / 3 bảng F3-F4', n_tables;
  end if;

  select count(*) into n_views
  from information_schema.views
  where table_schema = 'public'
    and table_name in ('vexim_reimbursements','vexim_reimbursement_claims',
                       'vexim_reimbursement_claim_events','vexim_sku_profit');
  if n_views <> 4 then
    raise exception '[0015] FAIL: chỉ thấy % / 4 view public cho F3-F4', n_views;
  end if;

  select count(distinct trigger_name) into n_trg
  from information_schema.triggers
  where event_object_schema = 'finance'
    and event_object_table = 'reimbursement_claims'
    and trigger_name in ('trg_reimbursement_claim_guard','trg_reimbursement_claim_history');
  if n_trg <> 2 then
    raise exception '[0015] FAIL: thiếu trigger máy trạng thái / lịch sử claim (% / 2)', n_trg;
  end if;

  select count(distinct p.proname) into n_rpc
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'vexim_update_reimbursement_claim',
      'vexim_worker_upsert_reimbursements',
      'vexim_worker_upsert_claims',
      'vexim_worker_upsert_profit',
      'vexim_worker_financial_events',
      'vexim_worker_effective_costs');
  if n_rpc <> 6 then
    raise exception '[0015] FAIL: thiếu RPC public cho F3-F4 (% / 6)', n_rpc;
  end if;

  -- RPC worker KHÔNG được cấp cho authenticated (chỉ service_role)
  if has_function_privilege('authenticated', 'public.vexim_worker_upsert_reimbursements(uuid,jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.vexim_worker_upsert_claims(uuid,jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.vexim_worker_upsert_profit(uuid,jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.vexim_worker_financial_events(uuid,date,date,int)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.vexim_worker_effective_costs(uuid,date)', 'EXECUTE')
  then
    raise exception '[0015] FAIL: RPC worker bị cấp EXECUTE cho authenticated';
  end if;

  -- Không phơi PII người mua / email nội bộ ra view public
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name like 'vexim_reimbursement%'
      and column_name in ('buyer_name','buyer_email','buyer_phone_number',
                          'ship_address_1','recipient_name','actor_email')
  ) then
    raise exception '[0015] FAIL: view F3 phơi PII';
  end if;

  raise notice '[0015] XONG: F3 claims (2 bảng + 2 trigger) + F4 lợi nhuận SKU (1 bảng) + 4 view';
end
$$;

commit;
