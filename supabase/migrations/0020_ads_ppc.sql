-- ============================================================================
-- 0020 — MODULE 5 (PPC) PHẦN 1: nền dữ liệu Amazon Ads + luồng re-authorize
-- ============================================================================
-- BỐI CẢNH
--   0001 đã tạo 4 bảng ads "khung" (ad_profiles · campaigns · ad_metrics_daily ·
--   search_terms) nhưng chúng chưa đủ để chạy thật:
--     • Không có ad group, không có keyword/target (A2 không có gì để hiển thị).
--     • Metrics chỉ có impressions/clicks/spend/sales/orders — Ads API v3 trả
--       theo CỬA SỔ QUY ĐỔI (sales7d/sales14d/sales30d, purchases*, unitsSoldClicks*).
--       Trộn "sales" mà không nói cửa sổ nào là nguồn gốc của mọi tranh cãi số liệu.
--     • Search term không gắn campaign/ad group/keyword → không thể trả lời
--       "từ khoá nào đang đốt tiền" (A3) cũng không có khoá để nhập lại không trùng.
--     • Không có bảng nào giữ: gợi ý negative (kèm mức tin cậy), sự kiện ngân sách,
--       hay chi tiêu theo SKU/ASIN (F4 cần để lấp `finance.sku_profit_daily.ads_spend`).
--     • Chưa có chỗ ghi trạng thái token/re-auth: role Ads là role MỚI nên refresh
--       token cũ KHÔNG dùng được — bắt buộc re-authorize (SOP-11).
--
-- NGUỒN (đã kiểm chứng trước khi viết, KHÔNG đoán):
--   • Reporting API v3 — POST /reporting/reports, Content-Type
--     `application/vnd.createasyncreportrequest.v3+json`; thân request:
--       { name, startDate, endDate,
--         configuration: { adProduct:"SPONSORED_PRODUCTS", groupBy:[...],
--                          columns:[...], reportTypeId, timeUnit:"DAILY",
--                          format:"GZIP_JSON" } }
--     reportTypeId dùng ở đây: spCampaigns · spTargeting · spSearchTerm ·
--     spAdvertisedProduct · spPurchasedProduct.
--   • ⚠️ Bản v3 KHÔNG có cột `acos7d`/`roas7d`: ACOS/ROAS/CPC/CTR phải SUY RA
--     (cost ÷ sales7d …). Vì vậy các cột đó nằm ở VIEW, không lưu trong bảng —
--     lưu số dẫn xuất là mở đường cho nó lệch với cost/sales sau mỗi lần nhập lại.
--   • ⚠️ Reporting API chỉ có DAILY / SUMMARY — KHÔNG có HOURLY (muốn theo giờ
--     phải dùng Amazon Marketing Stream). Nên `ads.budget_events` có
--     `exhausted_hour` + `hour_source`: phần 1 ghi `hour_source='unavailable'`
--     (biết CHẮC là cạn ngân sách, KHÔNG bịa giờ cạn).
--
-- NGUYÊN TẮC (giữ nguyên từ 0014..0019)
--   • Cột khoá NOT NULL DEFAULT '' (NULL không khử trùng trong index unique).
--   • Ghi = RPC service_role; web chỉ có policy SELECT.
--   • KHÔNG CỘNG TIỀN KHÁC TIỀN TỆ ở bất kỳ tầng nào.
--   • Số không đọc được → NULL ("chưa biết"), không đoán 0.
--   • Idempotent: create … if not exists · create or replace · drop policy if exists.
--   • Chạy SAU 0019.
-- ============================================================================

begin;

-- ============================================================================
-- 1. ads.ad_profiles — thêm thông tin profile Ads (A0 · màn Kết nối shop)
-- ============================================================================
alter table ads.ad_profiles add column if not exists country_code      text;
alter table ads.ad_profiles add column if not exists account_type      text;
alter table ads.ad_profiles add column if not exists manager_account_id text;
alter table ads.ad_profiles add column if not exists last_synced_at    timestamptz;
alter table ads.ad_profiles add column if not exists source            text not null default 'api';
alter table ads.ad_profiles add column if not exists imported_at       timestamptz not null default now();
alter table ads.ad_profiles add column if not exists updated_at        timestamptz not null default now();

comment on table ads.ad_profiles is
  'Profile Amazon Ads của shop (Profiles API /v2/profiles). 1 shop có thể có nhiều profile '
  '(mỗi marketplace một profile) — campaign/metrics LUÔN gắn ads_profile_id để không trộn số.';

-- ============================================================================
-- 2. ads.campaigns — thêm thuộc tính Campaign Management v3
-- ============================================================================
alter table ads.campaigns add column if not exists portfolio_id           text;
alter table ads.campaigns add column if not exists targeting_type         text;
alter table ads.campaigns add column if not exists budget_type            text;
alter table ads.campaigns add column if not exists budget_currency        text;
alter table ads.campaigns add column if not exists bidding_strategy       text;
alter table ads.campaigns add column if not exists premium_bid_adjustment numeric;
alter table ads.campaigns add column if not exists start_date             date;
alter table ads.campaigns add column if not exists end_date               date;
alter table ads.campaigns add column if not exists source                 text not null default 'api';
alter table ads.campaigns add column if not exists last_synced_at         timestamptz;
alter table ads.campaigns add column if not exists updated_at             timestamptz not null default now();

comment on column ads.campaigns.daily_budget is
  'Ngân sách/ngày theo currency của campaign. Dùng để suy "cạn ngân sách" (cost ≥ 95% budget) '
  '— KHÔNG dùng để tính tiền tiêu thực tế (số thật nằm ở ads.ad_metrics_daily.cost).';
comment on column ads.campaigns.campaign_type is
  'sp | sb | sd (Sponsored Products / Brands / Display). Phần 1 mới đồng bộ SP.';

-- ============================================================================
-- 3. ads.ad_groups — nhóm quảng cáo (A2)
-- ============================================================================
create table if not exists ads.ad_groups (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  ads_profile_id    text not null default '',
  campaign_id       text not null default '',
  ad_group_id       text not null default '',
  name              text not null default '',
  state             text not null default 'ENABLED',
  default_bid       numeric(10,2),
  currency          text,
  source            text not null default 'api',
  imported_at       timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table ads.ad_groups is
  'Ad group SP (POST /sp/adGroups/list). Khoá (shop, ad_group_id) — Amazon đảm bảo adGroupId duy nhất toàn hệ thống.';

create unique index if not exists uq_ads_ad_groups_key
  on ads.ad_groups (seller_account_id, ad_group_id);
create index if not exists idx_ads_ad_groups_campaign
  on ads.ad_groups (seller_account_id, campaign_id);

-- ============================================================================
-- 4. ads.targets — keyword & product target (A2, Part 3 ghi bid/state)
-- ============================================================================
-- Gộp keyword và product target vào MỘT bảng vì màn A2 hiển thị chung một bảng
-- "ad group → keyword/target"; `target_kind` nói rõ loại, `target_key` là khoá
-- tự nhiên (keywordId hoặc targetId) để nhập lại không nhân đôi.
create table if not exists ads.targets (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  ads_profile_id    text not null default '',
  campaign_id       text not null default '',
  ad_group_id       text not null default '',
  target_kind       text not null default 'keyword'
                    check (target_kind in ('keyword','product_target','auto','unknown')),
  target_key        text not null default '',
  keyword_text      text,
  match_type        text not null default '',
  expression_type   text,
  expression_value  text,
  bid               numeric(10,2),
  state             text not null default 'ENABLED',
  currency          text,
  source            text not null default 'api',
  imported_at       timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table ads.targets is
  'Keyword + product target của SP (POST /sp/keywords/list và /sp/targets/list). '
  'target_key = keywordId (keyword) hoặc targetId (product target); match_type = EXACT/PHRASE/BROAD '
  '(keyword) hoặc "" (product target).';

create unique index if not exists uq_ads_targets_key
  on ads.targets (seller_account_id, ad_group_id, target_kind, target_key, match_type);
create index if not exists idx_ads_targets_campaign
  on ads.targets (seller_account_id, campaign_id, ad_group_id);

-- ============================================================================
-- 5. ads.ad_metrics_daily — MỞ RỘNG theo cột metrics v3 (campaign × ngày)
-- ============================================================================
-- Bảng này đã tồn tại từ 0001 với (impressions, clicks, spend, sales, orders).
-- KHÔNG xoá cột cũ: RPC ghi song song `spend = cost`, `sales = sales_7d`,
-- `orders = purchases_7d` (đúng quy ước cũ) và ghi đủ 3 cửa sổ quy đổi.
alter table ads.ad_metrics_daily add column if not exists ad_profile_id          text not null default '';
alter table ads.ad_metrics_daily add column if not exists currency                text;
alter table ads.ad_metrics_daily add column if not exists cost                    numeric(12,2);
alter table ads.ad_metrics_daily add column if not exists sales_7d                numeric(12,2);
alter table ads.ad_metrics_daily add column if not exists sales_14d               numeric(12,2);
alter table ads.ad_metrics_daily add column if not exists sales_30d               numeric(12,2);
alter table ads.ad_metrics_daily add column if not exists units_sold_clicks_7d    int;
alter table ads.ad_metrics_daily add column if not exists units_sold_clicks_14d   int;
alter table ads.ad_metrics_daily add column if not exists units_sold_clicks_30d   int;
alter table ads.ad_metrics_daily add column if not exists purchases_7d            int;
alter table ads.ad_metrics_daily add column if not exists purchases_14d           int;
alter table ads.ad_metrics_daily add column if not exists purchases_30d           int;
alter table ads.ad_metrics_daily add column if not exists budget_amount           numeric(12,2);
alter table ads.ad_metrics_daily add column if not exists source                  text not null default 'report';
alter table ads.ad_metrics_daily add column if not exists imported_at             timestamptz not null default now();
alter table ads.ad_metrics_daily add column if not exists updated_at              timestamptz not null default now();

comment on column ads.ad_metrics_daily.spend is
  'GIỮ LẠI để tương thích 0001 — RPC luôn ghi spend = cost (cùng một số, không phải hai nguồn).';
comment on column ads.ad_metrics_daily.sales is
  'GIỮ LẠI để tương thích 0001 — RPC ghi sales = sales_7d (cửa sổ quy đổi 7 ngày).';
comment on column ads.ad_metrics_daily.cost is
  'Cột `cost` của Ads API v3. ACOS/ROAS/CPC/CTR KHÔNG lưu ở đây: v3 không trả các cột đó, '
  'chúng được suy ra ở view (cost/sales_7d…) để không bao giờ lệch với cost & sales.';

-- 0001 khai các cột này `not null default 0`: đúng cho thời kỳ chỉ có API v2 (luôn
-- trả đủ cột), nhưng SAI với report v3 — report có thể không trả một cột nào đó, và
-- ép NULL thành 0 là đúng kiểu "xanh giả" mà cả repo đang tránh. Vì vậy nới ràng
-- buộc (không xoá cột, vẫn giữ default 0 cho dòng cũ): NULL = chưa biết.
alter table ads.ad_metrics_daily alter column impressions drop not null;
alter table ads.ad_metrics_daily alter column clicks      drop not null;
alter table ads.ad_metrics_daily alter column spend       drop not null;
alter table ads.ad_metrics_daily alter column sales       drop not null;
alter table ads.ad_metrics_daily alter column orders      drop not null;

comment on column ads.ad_metrics_daily.impressions is
  'NULL = report v3 không trả cột này cho dòng đó (không bịa 0). Cùng luật cho clicks/spend/sales/orders.';

create index if not exists idx_ads_metrics_day
  on ads.ad_metrics_daily (seller_account_id, day desc, campaign_id);
create index if not exists idx_ads_metrics_profile
  on ads.ad_metrics_daily (seller_account_id, ad_profile_id, day desc);

-- ============================================================================
-- 6. ads.target_metrics_daily — metrics theo keyword/target (A2 · spTargeting)
-- ============================================================================
create table if not exists ads.target_metrics_daily (
  id                       uuid primary key default gen_random_uuid(),
  seller_account_id        uuid not null references connections.seller_accounts(id) on delete cascade,
  ads_profile_id           text not null default '',
  day                      date not null,
  campaign_id              text not null default '',
  ad_group_id              text not null default '',
  target_kind              text not null default 'keyword'
                           check (target_kind in ('keyword','product_target','auto','unknown')),
  target_key               text not null default '',
  keyword_text             text,
  match_type               text not null default '',
  expression_type          text,
  expression_value         text,
  impressions              int,
  clicks                   int,
  cost                     numeric(12,2),
  sales_7d                 numeric(12,2),
  sales_14d                numeric(12,2),
  sales_30d                numeric(12,2),
  units_sold_clicks_7d     int,
  units_sold_clicks_14d    int,
  units_sold_clicks_30d    int,
  purchases_7d             int,
  purchases_14d            int,
  purchases_30d            int,
  currency                 text,
  source                   text not null default 'report',
  imported_at              timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

comment on table ads.target_metrics_daily is
  'Metrics theo keyword/target/ngày từ report spTargeting (groupBy: targeting). '
  'target_key = keywordId hoặc targetId; dòng thiếu cả hai bị bỏ (không đoán).';

create unique index if not exists uq_ads_target_metrics_key
  on ads.target_metrics_daily
     (seller_account_id, day, campaign_id, ad_group_id, target_kind, target_key, match_type);
create index if not exists idx_ads_target_metrics_day
  on ads.target_metrics_daily (seller_account_id, day desc);

-- ============================================================================
-- 7. ads.search_terms — MỞ RỘNG: gắn campaign/ad group/keyword + khoá chống trùng
-- ============================================================================
alter table ads.search_terms add column if not exists ad_profile_id        text not null default '';
alter table ads.search_terms add column if not exists campaign_id          text not null default '';
alter table ads.search_terms add column if not exists ad_group_id          text not null default '';
alter table ads.search_terms add column if not exists keyword_id           text not null default '';
alter table ads.search_terms add column if not exists keyword_text         text;
alter table ads.search_terms add column if not exists cost                 numeric(12,2);
alter table ads.search_terms add column if not exists sales_7d             numeric(12,2);
alter table ads.search_terms add column if not exists sales_14d            numeric(12,2);
alter table ads.search_terms add column if not exists sales_30d            numeric(12,2);
alter table ads.search_terms add column if not exists units_sold_clicks_7d int;
alter table ads.search_terms add column if not exists purchases_7d         int;
alter table ads.search_terms add column if not exists currency             text;
alter table ads.search_terms add column if not exists source               text not null default 'report';
alter table ads.search_terms add column if not exists imported_at          timestamptz not null default now();
alter table ads.search_terms add column if not exists updated_at           timestamptz not null default now();

comment on table ads.search_terms is
  'Search term (report spSearchTerm) — câu người mua gõ, gắn campaign/ad group/keyword. '
  'Khoá (shop, ngày, campaign, ad group, keywordId, term, matchType) để nhập lại không nhân đôi. '
  'Cột spend/sales của 0001 được RPC ghi song song (spend=cost, sales=sales_7d).';

-- Bảng 0001 chưa có khoá unique (chưa từng nhập dòng nào) — bổ sung để nhập lại idempotent.
create unique index if not exists uq_ads_search_terms_key
  on ads.search_terms
     (seller_account_id, day, campaign_id, ad_group_id, keyword_id, term, match_type);
create index if not exists idx_ads_search_terms_day
  on ads.search_terms (seller_account_id, day desc, cost desc nulls last);

-- ============================================================================
-- 8. ads.advertised_product_metrics_daily — chi tiêu theo SKU/ASIN (nguồn cho F4)
-- ============================================================================
create table if not exists ads.advertised_product_metrics_daily (
  id                    uuid primary key default gen_random_uuid(),
  seller_account_id     uuid not null references connections.seller_accounts(id) on delete cascade,
  ads_profile_id        text not null default '',
  day                   date not null,
  campaign_id           text not null default '',
  ad_group_id           text not null default '',
  advertised_asin       text not null default '',
  advertised_sku        text not null default '',
  impressions           int,
  clicks                int,
  cost                  numeric(12,2),
  sales_7d              numeric(12,2),
  sales_14d             numeric(12,2),
  sales_30d             numeric(12,2),
  units_sold_clicks_7d  int,
  units_sold_clicks_14d int,
  units_sold_clicks_30d int,
  purchases_7d          int,
  purchases_14d         int,
  purchases_30d         int,
  currency              text,
  source                text not null default 'report',
  imported_at           timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table ads.advertised_product_metrics_daily is
  'Report spAdvertisedProduct (groupBy: advertisedProduct) — chi tiêu theo ASIN/SKU quảng cáo. '
  'Đây là nguồn để LẤP finance.sku_profit_daily.ads_spend (F4) và để biết SKU nào lỗ vì ads.';

create unique index if not exists uq_ads_advertised_product_key
  on ads.advertised_product_metrics_daily
     (seller_account_id, day, campaign_id, ad_group_id, advertised_asin, advertised_sku);
create index if not exists idx_ads_advertised_product_sku
  on ads.advertised_product_metrics_daily (seller_account_id, advertised_sku, day desc);

-- ============================================================================
-- 9. ads.purchased_product_metrics_daily — ASIN ĐÃ MUA (kể cả khác SKU quảng cáo)
-- ============================================================================
create table if not exists ads.purchased_product_metrics_daily (
  id                          uuid primary key default gen_random_uuid(),
  seller_account_id           uuid not null references connections.seller_accounts(id) on delete cascade,
  ads_profile_id              text not null default '',
  day                         date not null,
  campaign_id                 text not null default '',
  ad_group_id                 text not null default '',
  advertised_asin             text not null default '',
  advertised_sku              text not null default '',
  purchased_asin              text not null default '',
  keyword_text                text,
  match_type                  text not null default '',
  cost                        numeric(12,2),
  sales_7d                    numeric(12,2),
  sales_14d                   numeric(12,2),
  sales_30d                   numeric(12,2),
  sales_other_sku_7d          numeric(12,2),
  sales_other_sku_14d         numeric(12,2),
  sales_other_sku_30d         numeric(12,2),
  purchases_7d                int,
  purchases_14d               int,
  purchases_30d               int,
  units_sold_other_sku_7d     int,
  units_sold_other_sku_14d    int,
  units_sold_other_sku_30d    int,
  currency                    text,
  source                      text not null default 'report',
  imported_at                 timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

comment on table ads.purchased_product_metrics_daily is
  'Report spPurchasedProduct — ASIN được mua sau khi bấm ads (kể cả ASIN khác SKU quảng cáo: '
  'sales_other_sku_*). Cần để giải thích "ads bán hàng khác" thay vì gán oan cho SKU quảng cáo.';

create unique index if not exists uq_ads_purchased_product_key
  on ads.purchased_product_metrics_daily
     (seller_account_id, day, campaign_id, ad_group_id, purchased_asin, advertised_asin, advertised_sku);
create index if not exists idx_ads_purchased_product_day
  on ads.purchased_product_metrics_daily (seller_account_id, day desc, purchased_asin);

-- ============================================================================
-- 10. ads.budget_events — sự kiện ngân sách (alert `budget_exhausted`)
-- ============================================================================
create table if not exists ads.budget_events (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  ads_profile_id    text not null default '',
  day               date not null,
  campaign_id       text not null default '',
  event_type        text not null default 'capped'
                    check (event_type in ('capped','exhausted_suspected','under_delivery','budget_increased')),
  budget_amount     numeric(12,2),
  currency          text,
  cost              numeric(12,2),
  usage_pct         numeric(6,2),
  /** Giờ trong ngày (0–23) campaign hết tiền — CHỈ khi có nguồn theo giờ */
  exhausted_hour    int check (exhausted_hour is null or (exhausted_hour between 0 and 23)),
  /**
   * Nguồn của `exhausted_hour`:
   *   unavailable      — Reporting API chỉ có DAILY (phần 1): BIẾT cạn ngân sách,
   *                      KHÔNG biết giờ ⇒ để NULL, không bịa số.
   *   report           — suy từ report có cột giờ (nếu Amazon mở lại)
   *   marketing_stream — Amazon Marketing Stream (kế hoạch sau)
   */
  hour_source       text not null default 'unavailable'
                    check (hour_source in ('unavailable','report','marketing_stream')),
  note              text,
  source            text not null default 'derived',
  detected_at       timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table ads.budget_events is
  'Sự kiện ngân sách theo (shop, ngày, campaign, loại). `capped` = cost ≥ 95% ngân sách ngày ⇒ '
  'có khả năng đã ngừng phân phối sớm. `exhausted_hour` chỉ có khi hour_source <> ''unavailable'' '
  '(Reporting API v3 không trả dữ liệu theo giờ — muốn có giờ phải dùng Amazon Marketing Stream).';

create unique index if not exists uq_ads_budget_events_key
  on ads.budget_events (seller_account_id, day, campaign_id, event_type);
create index if not exists idx_ads_budget_events_day
  on ads.budget_events (seller_account_id, day desc, event_type);

-- ============================================================================
-- 11. ads.negative_suggestions — gợi ý negative keyword KÈM MỨC TIN CẬY (A3)
-- ============================================================================
create table if not exists ads.negative_suggestions (
  id                uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  ads_profile_id    text not null default '',
  campaign_id       text not null default '',
  ad_group_id       text not null default '',
  keyword_id        text not null default '',
  keyword_text      text,
  term              text not null default '',
  match_type        text not null default '',
  target_kind       text not null default 'search_term'
                    check (target_kind in ('search_term','keyword','product_target')),
  suggestion_type   text not null default 'negative_exact'
                    check (suggestion_type in ('negative_exact','negative_phrase','pause_keyword','lower_bid')),
  /** 0..1 — mức tin cậy của gợi ý (tính ở worker, có công thức trong domain/ads.ts) */
  confidence        numeric(5,4) check (confidence is null or (confidence between 0 and 1)),
  confidence_label  text,
  window_days       int not null default 14,
  evidence          jsonb,
  reasons           jsonb,
  status            text not null default 'pending'
                    check (status in ('pending','approved','rejected','applied','dismissed','expired')),
  decided_by        uuid references iam.user_profiles(id),
  decided_at        timestamptz,
  decision_note     text,
  applied_at        timestamptz,
  source            text not null default 'rule',
  generated_at      timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table ads.negative_suggestions is
  'Gợi ý negative keyword / tạm dừng keyword (SOP-04 bước 2–4) kèm mức tin cậy 0..1 '
  '(confidence_label: high ≥0.75 · medium ≥0.5 · low <0.5) và bằng chứng số (evidence jsonb). '
  'Người duyệt là con người: worker CHỈ được ghi/refresh dòng còn `pending`.';

create unique index if not exists uq_ads_negative_suggestions_key
  on ads.negative_suggestions
     (seller_account_id, campaign_id, ad_group_id, term, match_type, suggestion_type, window_days);
create index if not exists idx_ads_negative_suggestions_status
  on ads.negative_suggestions (seller_account_id, status, confidence desc nulls last);

-- ============================================================================
-- 12. connections.oauth_tokens — mở rộng cho luồng re-authorize (SOP-11)
-- ============================================================================
-- Bối cảnh: LWA refresh token sống 1 năm và bị BUỘC đổi khi app xin thêm role
-- (role Ads là role mới). Bảng gốc chỉ có expires_at + rotate_reminder_sent, chưa
-- đủ để: biết token nào sinh từ scope nào, ai kết nối, đã thu hồi chưa, và
-- nhắc re-auth trước bao nhiêu ngày.
alter table connections.oauth_tokens add column if not exists auth_scope        text;
alter table connections.oauth_tokens add column if not exists connected_by      uuid references iam.user_profiles(id);
alter table connections.oauth_tokens add column if not exists notice_days       int not null default 30;
alter table connections.oauth_tokens add column if not exists notice_sent_at    timestamptz;
alter table connections.oauth_tokens add column if not exists last_refresh_at   timestamptz;
alter table connections.oauth_tokens add column if not exists refresh_count     int not null default 0;
alter table connections.oauth_tokens add column if not exists revoked_at        timestamptz;
alter table connections.oauth_tokens add column if not exists created_at        timestamptz not null default now();
alter table connections.oauth_tokens add column if not exists updated_at        timestamptz not null default now();

comment on table connections.oauth_tokens is
  'LWA refresh token theo shop. KHÔNG có policy RLS nào ⇒ client không đọc được (chỉ service_role). '
  'Web đọc TRẠNG THÁI qua view public.vexim_oauth_connections (không chứa token). '
  '⚠️ TODO bảo mật: production nên thay cột này bằng Supabase Vault secret reference.';

comment on column connections.oauth_tokens.notice_days is
  'Nhắc re-authorize trước khi token hết hạn bao nhiêu ngày (LWA refresh token sống 365 ngày).';

-- CSRF/one-time state cho luồng OAuth (login URI → callback)
create table if not exists connections.oauth_states (
  id                uuid primary key default gen_random_uuid(),
  state             text not null unique,
  seller_account_id uuid not null references connections.seller_accounts(id) on delete cascade,
  redirect_to       text,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  used_at           timestamptz,
  used_ip           text
);

comment on table connections.oauth_states is
  'State dùng một lần cho luồng authorize LWA (chống CSRF + biết callback thuộc shop nào). '
  'Cron/tác vụ dọn dòng quá hạn là việc của worker (không tự xoá trong migration).';

create index if not exists idx_oauth_states_expiry
  on connections.oauth_states (expires_at);

-- ============================================================================
-- 13. RULE CẢNH BÁO MỚI (module_code = 'ads' — BẢNG iam.module_code KHÔNG có 'ppc')
-- ============================================================================
insert into ops.alert_rules (rule_code, module, description, threshold, comparator, severity) values
  ('acos_over_target',  'ads', 'ACOS 7 ngày vượt mục tiêu (%) — SOP-05: xem lại bid/từ khoá', 25, 'gt',  'amber'),
  ('budget_exhausted',  'ads', 'Ngân sách ngày bị dùng ≥ ngưỡng (%) — SOP-04: nới ngân sách hoặc siết từ khoá', 95, 'gt', 'amber'),
  -- Module 0 (nền tảng token): LWA refresh token sống 365 ngày ⇒ phải nhắc
  -- re-authorize TRƯỚC khi hết hạn, nếu không MỌI module tự dưng ngừng đồng bộ
  -- và rất khó đoán bệnh. Xếp vào module 'account_health': hết token là vấn đề
  -- sức khoẻ kết nối của shop, không thuộc riêng ads/orders.
  ('oauth_reauth_due',  'account_health', 'Refresh token LWA còn ≤ notice_days ngày — SOP-11: kết nối lại shop', 30, 'lte', 'amber')
on conflict (rule_code) do nothing;

-- ============================================================================
-- 14. RLS + GRANTS
-- ============================================================================
-- Bảng mới: bật RLS + policy SELECT theo iam.can_read_seller_account (vòng lặp
-- tự động của 0001 chạy trước khi các bảng này tồn tại nên phải khai tay).
alter table ads.ad_groups                        enable row level security;
alter table ads.targets                          enable row level security;
alter table ads.target_metrics_daily             enable row level security;
alter table ads.advertised_product_metrics_daily enable row level security;
alter table ads.purchased_product_metrics_daily  enable row level security;
alter table ads.budget_events                    enable row level security;
alter table ads.negative_suggestions             enable row level security;
alter table connections.oauth_states             enable row level security;

drop policy if exists "ad_groups: đọc theo shop" on ads.ad_groups;
create policy "ad_groups: đọc theo shop" on ads.ad_groups
  for select to authenticated using (iam.can_read_seller_account(seller_account_id));

drop policy if exists "targets: đọc theo shop" on ads.targets;
create policy "targets: đọc theo shop" on ads.targets
  for select to authenticated using (iam.can_read_seller_account(seller_account_id));

drop policy if exists "target_metrics_daily: đọc theo shop" on ads.target_metrics_daily;
create policy "target_metrics_daily: đọc theo shop" on ads.target_metrics_daily
  for select to authenticated using (iam.can_read_seller_account(seller_account_id));

drop policy if exists "advertised_product_metrics_daily: đọc theo shop" on ads.advertised_product_metrics_daily;
create policy "advertised_product_metrics_daily: đọc theo shop" on ads.advertised_product_metrics_daily
  for select to authenticated using (iam.can_read_seller_account(seller_account_id));

drop policy if exists "purchased_product_metrics_daily: đọc theo shop" on ads.purchased_product_metrics_daily;
create policy "purchased_product_metrics_daily: đọc theo shop" on ads.purchased_product_metrics_daily
  for select to authenticated using (iam.can_read_seller_account(seller_account_id));

drop policy if exists "budget_events: đọc theo shop" on ads.budget_events;
create policy "budget_events: đọc theo shop" on ads.budget_events
  for select to authenticated using (iam.can_read_seller_account(seller_account_id));

drop policy if exists "negative_suggestions: đọc theo shop" on ads.negative_suggestions;
create policy "negative_suggestions: đọc theo shop" on ads.negative_suggestions
  for select to authenticated using (iam.can_read_seller_account(seller_account_id));

-- oauth_states: KHÔNG policy cho client (giống oauth_tokens) — chỉ service_role.

grant select on
  ads.ad_groups, ads.targets, ads.target_metrics_daily,
  ads.advertised_product_metrics_daily, ads.purchased_product_metrics_daily,
  ads.budget_events, ads.negative_suggestions,
  ads.ad_profiles, ads.campaigns, ads.ad_metrics_daily, ads.search_terms
to authenticated;
grant all on
  ads.ad_groups, ads.targets, ads.target_metrics_daily,
  ads.advertised_product_metrics_daily, ads.purchased_product_metrics_daily,
  ads.budget_events, ads.negative_suggestions,
  ads.ad_profiles, ads.campaigns, ads.ad_metrics_daily, ads.search_terms,
  connections.oauth_states
to service_role;

-- ============================================================================
-- 15. HELPER: đọc số nguyên an toàn (dùng lại finance.num_or_null cho số thực)
-- ============================================================================
create or replace function ads.int_or_null(p_text text)
returns int
language sql
immutable
as $$
  select case when btrim(coalesce(p_text, '')) ~ '^-?[0-9]+$'
              then btrim(p_text)::int end;
$$;

comment on function ads.int_or_null(text) is
  'Ép chuỗi trong report Ads về int; không đọc được → NULL (không ném lỗi, không đoán 0).';


-- ============================================================================
-- 16. HELPER + RPC WORKER — Ads (Profiles · Campaigns · Ad groups · Targets)
-- ============================================================================
-- 12 RPC dưới đây dùng CHUNG một khối kiểm tra đầu vào. Tách thành helper để
-- không có RPC nào "quên" một chốt (bài học từ 0019: mỗi RPC tự chép lại guard
-- thì sớm muộn có cái thiếu).
create or replace function ads.assert_worker(p_seller uuid, p_rows jsonb)
returns void
language plpgsql
security definer
set search_path = ads, pg_catalog
as $$
begin
  if auth.uid() is not null then
    raise exception '[M5-ADS] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_seller is null then
    raise exception '[M5-ADS] thiếu seller_account_id'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '[M5-ADS] p_rows phải là JSON array (nhận %)',
      coalesce(jsonb_typeof(p_rows), 'NULL') using errcode = 'invalid_parameter_value';
  end if;
end;
$$;

comment on function ads.assert_worker(uuid, jsonb) is
  'Chốt dùng chung cho mọi RPC Ads: chỉ service_role, có seller, p_rows là JSON array.';

-- ---------------------------------------------------------------------------
-- 16.1 Profiles (/v2/profiles)
-- ---------------------------------------------------------------------------
create or replace function public.vexim_worker_upsert_ads_profiles(
  p_seller uuid,
  p_rows   jsonb
)
returns table (inserted int, updated int, skipped int, merged int)
language plpgsql
security definer
set search_path = ads, finance, public, pg_catalog
as $$
declare
  v_clean jsonb;
  v_total int;
  v_valid int;
  v_bad   int := 0;
  v_upd   int := 0;
  v_rows  int := 0;
begin
  perform ads.assert_worker(p_seller, p_rows);
  v_total := jsonb_array_length(p_rows);

  -- `skipped` = dòng KHÔNG ĐỦ KHOÁ (không dùng được), `merged` = dòng trùng khoá bị gộp.
  -- Hai số này khác nghĩa: gộp trùng là bình thường, bỏ dòng là dấu hiệu report lạ.
  select count(*) into v_bad
  from jsonb_array_elements(p_rows) r
  where btrim(coalesce(r ->> 'adsProfileId', '')) = ''
        or btrim(coalesce(r ->> 'marketplace', '')) = '';

  select coalesce(jsonb_agg(jsonb_build_object(
           'profileId', g.profile_id, 'marketplace', g.marketplace, 'currency', g.currency,
           'countryCode', g.country_code, 'accountType', g.account_type,
           'managerAccountId', g.manager_account_id, 'src', g.src)), '[]'::jsonb)
    into v_clean
  from (
    select distinct on (s.profile_id)
           s.profile_id, s.marketplace, s.currency, s.country_code,
           s.account_type, s.manager_account_id, s.src
    from (
      select
        btrim(r ->> 'adsProfileId')                                as profile_id,
        upper(btrim(coalesce(r ->> 'marketplace', '')))            as marketplace,
        nullif(upper(btrim(coalesce(r ->> 'currency', ''))), '')   as currency,
        nullif(upper(btrim(coalesce(r ->> 'countryCode', ''))), '') as country_code,
        nullif(btrim(coalesce(r ->> 'accountType', '')), '')       as account_type,
        nullif(btrim(coalesce(r ->> 'managerAccountId', '')), '')  as manager_account_id,
        coalesce(nullif(btrim(coalesce(r ->> 'source', '')), ''), 'api') as src
      from jsonb_array_elements(p_rows) r
      where btrim(coalesce(r ->> 'adsProfileId', '')) <> ''
        and btrim(coalesce(r ->> 'marketplace', '')) <> ''
    ) s
    order by s.profile_id, s.currency nulls last
  ) g;

  v_valid := jsonb_array_length(v_clean);

  select count(*) into v_upd
  from jsonb_array_elements(v_clean) e
  where exists (
    select 1 from ads.ad_profiles x
     where x.seller_account_id = p_seller and x.ads_profile_id = e ->> 'profileId'
  );

  insert into ads.ad_profiles as t (
    seller_account_id, ads_profile_id, marketplace, currency, country_code,
    account_type, manager_account_id, source, last_synced_at, imported_at, updated_at
  )
  select
    p_seller,
    e ->> 'profileId',
    e ->> 'marketplace',
    coalesce(nullif(e ->> 'currency', ''), 'USD'),
    nullif(e ->> 'countryCode', ''),
    nullif(e ->> 'accountType', ''),
    nullif(e ->> 'managerAccountId', ''),
    coalesce(nullif(e ->> 'src', ''), 'api'),
    now(), now(), now()
  from jsonb_array_elements(v_clean) e
  on conflict (seller_account_id, ads_profile_id) do update set
    marketplace        = excluded.marketplace,
    currency           = excluded.currency,
    country_code       = coalesce(excluded.country_code, t.country_code),
    account_type       = coalesce(excluded.account_type, t.account_type),
    manager_account_id = coalesce(excluded.manager_account_id, t.manager_account_id),
    source             = excluded.source,
    last_synced_at     = excluded.last_synced_at,
    updated_at         = excluded.updated_at;

  get diagnostics v_rows = row_count;

  return query select greatest(v_rows - v_upd, 0), v_upd, v_bad,
                      greatest(v_total - v_valid - v_bad, 0);
end;
$$;

comment on function public.vexim_worker_upsert_ads_profiles(uuid, jsonb) is
  'Nhập profile Ads (/v2/profiles) — chỉ service_role. Idempotent theo (shop, ads_profile_id). '
  'Trả (inserted, updated, skipped = thiếu khoá, merged = trùng khoá bị gộp).';

-- ---------------------------------------------------------------------------
-- 16.2 Campaigns (POST /sp/campaigns/list)
-- ---------------------------------------------------------------------------
create or replace function public.vexim_worker_upsert_ads_campaigns(
  p_seller uuid,
  p_rows   jsonb
)
returns table (inserted int, updated int, skipped int, merged int)
language plpgsql
security definer
set search_path = ads, finance, public, pg_catalog
as $$
declare
  v_clean jsonb;
  v_total int;
  v_valid int;
  v_bad   int := 0;
  v_upd   int := 0;
  v_rows  int := 0;
begin
  perform ads.assert_worker(p_seller, p_rows);
  v_total := jsonb_array_length(p_rows);

  -- `skipped` = dòng KHÔNG ĐỦ KHOÁ (không dùng được), `merged` = dòng trùng khoá bị gộp.
  -- Hai số này khác nghĩa: gộp trùng là bình thường, bỏ dòng là dấu hiệu report lạ.
  select count(*) into v_bad
  from jsonb_array_elements(p_rows) r
  where btrim(coalesce(r ->> 'campaignId', '')) = ''
        or btrim(coalesce(r ->> 'name', '')) = '';

  select coalesce(jsonb_agg(jsonb_build_object(
           'campaignId', g.campaign_id, 'profileId', g.profile_id, 'campaignType', g.campaign_type,
           'name', g.name, 'state', g.state, 'dailyBudget', g.daily_budget,
           'budgetCurrency', g.budget_currency, 'portfolioId', g.portfolio_id,
           'targetingType', g.targeting_type, 'budgetType', g.budget_type,
           'biddingStrategy', g.bidding_strategy, 'premiumBid', g.premium_bid,
           'startDate', g.start_date, 'endDate', g.end_date, 'src', g.src)), '[]'::jsonb)
    into v_clean
  from (
    select distinct on (s.campaign_id)
           s.campaign_id, s.profile_id, s.campaign_type, s.name, s.state, s.daily_budget,
           s.budget_currency, s.portfolio_id, s.targeting_type, s.budget_type,
           s.bidding_strategy, s.premium_bid, s.start_date, s.end_date, s.src
    from (
      select
        btrim(r ->> 'campaignId')                                     as campaign_id,
        btrim(coalesce(r ->> 'adsProfileId', ''))                     as profile_id,
        coalesce(nullif(lower(btrim(coalesce(r ->> 'campaignType', ''))), ''), 'sp') as campaign_type,
        nullif(btrim(coalesce(r ->> 'name', '')), '')                 as name,
        coalesce(nullif(upper(btrim(coalesce(r ->> 'state', ''))), ''), 'ENABLED') as state,
        finance.num_or_null(r ->> 'dailyBudget')                      as daily_budget,
        nullif(upper(btrim(coalesce(r ->> 'budgetCurrency', ''))), '') as budget_currency,
        nullif(btrim(coalesce(r ->> 'portfolioId', '')), '')          as portfolio_id,
        nullif(upper(btrim(coalesce(r ->> 'targetingType', ''))), '') as targeting_type,
        nullif(upper(btrim(coalesce(r ->> 'budgetType', ''))), '')    as budget_type,
        nullif(upper(btrim(coalesce(r ->> 'biddingStrategy', ''))), '') as bidding_strategy,
        finance.num_or_null(r ->> 'premiumBidAdjustment')             as premium_bid,
        case when btrim(coalesce(r ->> 'startDate', '')) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
             then btrim(r ->> 'startDate')::date end                  as start_date,
        case when btrim(coalesce(r ->> 'endDate', '')) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
             then btrim(r ->> 'endDate')::date end                    as end_date,
        coalesce(nullif(btrim(coalesce(r ->> 'source', '')), ''), 'api') as src
      from jsonb_array_elements(p_rows) r
      where btrim(coalesce(r ->> 'campaignId', '')) <> ''
        and btrim(coalesce(r ->> 'name', '')) <> ''
    ) s
    order by s.campaign_id, s.src
  ) g;

  v_valid := jsonb_array_length(v_clean);

  select count(*) into v_upd
  from jsonb_array_elements(v_clean) e
  where exists (
    select 1 from ads.campaigns x
     where x.seller_account_id = p_seller and x.campaign_id = e ->> 'campaignId'
  );

  insert into ads.campaigns as t (
    seller_account_id, ads_profile_id, campaign_id, campaign_type, name, state,
    daily_budget, budget_currency, portfolio_id, targeting_type, budget_type,
    bidding_strategy, premium_bid_adjustment, start_date, end_date,
    source, last_synced_at, updated_at
  )
  select
    p_seller,
    coalesce(e ->> 'profileId', ''),
    e ->> 'campaignId',
    e ->> 'campaignType',
    e ->> 'name',
    e ->> 'state',
    nullif(e ->> 'dailyBudget', '')::numeric,
    nullif(e ->> 'budgetCurrency', ''),
    nullif(e ->> 'portfolioId', ''),
    nullif(e ->> 'targetingType', ''),
    nullif(e ->> 'budgetType', ''),
    nullif(e ->> 'biddingStrategy', ''),
    nullif(e ->> 'premiumBid', '')::numeric,
    nullif(e ->> 'startDate', '')::date,
    nullif(e ->> 'endDate', '')::date,
    coalesce(nullif(e ->> 'src', ''), 'api'),
    now(), now()
  from jsonb_array_elements(v_clean) e
  on conflict (seller_account_id, campaign_id) do update set
    ads_profile_id         = coalesce(nullif(excluded.ads_profile_id, ''), t.ads_profile_id),
    campaign_type          = excluded.campaign_type,
    name                   = excluded.name,
    state                  = excluded.state,
    daily_budget           = coalesce(excluded.daily_budget, t.daily_budget),
    budget_currency        = coalesce(excluded.budget_currency, t.budget_currency),
    portfolio_id           = coalesce(excluded.portfolio_id, t.portfolio_id),
    targeting_type         = coalesce(excluded.targeting_type, t.targeting_type),
    budget_type            = coalesce(excluded.budget_type, t.budget_type),
    bidding_strategy       = coalesce(excluded.bidding_strategy, t.bidding_strategy),
    premium_bid_adjustment = coalesce(excluded.premium_bid_adjustment, t.premium_bid_adjustment),
    start_date             = coalesce(excluded.start_date, t.start_date),
    -- ngày kết thúc GHI ĐÈ được bằng NULL: campaign gỡ hạn phải thấy đã gỡ hạn
    end_date               = excluded.end_date,
    source                 = excluded.source,
    last_synced_at         = excluded.last_synced_at,
    updated_at             = excluded.updated_at;

  get diagnostics v_rows = row_count;

  return query select greatest(v_rows - v_upd, 0), v_upd, v_bad,
                      greatest(v_total - v_valid - v_bad, 0);
end;
$$;

comment on function public.vexim_worker_upsert_ads_campaigns(uuid, jsonb) is
  'Nhập campaign SP (POST /sp/campaigns/list) — chỉ service_role. Idempotent theo (shop, campaign_id). '
  '`endDate` ghi đè được bằng NULL (campaign gỡ hạn) — khác các cột khác dùng coalesce (chưa biết = giữ cũ).';

-- ---------------------------------------------------------------------------
-- 16.3 Ad groups (POST /sp/adGroups/list)
-- ---------------------------------------------------------------------------
create or replace function public.vexim_worker_upsert_ads_ad_groups(
  p_seller uuid,
  p_rows   jsonb
)
returns table (inserted int, updated int, skipped int, merged int)
language plpgsql
security definer
set search_path = ads, finance, public, pg_catalog
as $$
declare
  v_clean jsonb;
  v_total int;
  v_valid int;
  v_bad   int := 0;
  v_upd   int := 0;
  v_rows  int := 0;
begin
  perform ads.assert_worker(p_seller, p_rows);
  v_total := jsonb_array_length(p_rows);

  -- `skipped` = dòng KHÔNG ĐỦ KHOÁ (không dùng được), `merged` = dòng trùng khoá bị gộp.
  -- Hai số này khác nghĩa: gộp trùng là bình thường, bỏ dòng là dấu hiệu report lạ.
  select count(*) into v_bad
  from jsonb_array_elements(p_rows) r
  where btrim(coalesce(r ->> 'adGroupId', '')) = '';

  select coalesce(jsonb_agg(jsonb_build_object(
           'adGroupId', g.ad_group_id, 'campaignId', g.campaign_id, 'profileId', g.profile_id,
           'name', g.name, 'state', g.state, 'defaultBid', g.default_bid,
           'currency', g.currency, 'src', g.src)), '[]'::jsonb)
    into v_clean
  from (
    select distinct on (s.ad_group_id)
           s.ad_group_id, s.campaign_id, s.profile_id, s.name, s.state,
           s.default_bid, s.currency, s.src
    from (
      select
        btrim(r ->> 'adGroupId')                                      as ad_group_id,
        btrim(coalesce(r ->> 'campaignId', ''))                       as campaign_id,
        btrim(coalesce(r ->> 'adsProfileId', ''))                     as profile_id,
        coalesce(nullif(btrim(coalesce(r ->> 'name', '')), ''), '')   as name,
        coalesce(nullif(upper(btrim(coalesce(r ->> 'state', ''))), ''), 'ENABLED') as state,
        finance.num_or_null(r ->> 'defaultBid')                       as default_bid,
        nullif(upper(btrim(coalesce(r ->> 'currency', ''))), '')      as currency,
        coalesce(nullif(btrim(coalesce(r ->> 'source', '')), ''), 'api') as src
      from jsonb_array_elements(p_rows) r
      where btrim(coalesce(r ->> 'adGroupId', '')) <> ''
    ) s
    order by s.ad_group_id, s.src
  ) g;

  v_valid := jsonb_array_length(v_clean);

  select count(*) into v_upd
  from jsonb_array_elements(v_clean) e
  where exists (
    select 1 from ads.ad_groups x
     where x.seller_account_id = p_seller and x.ad_group_id = e ->> 'adGroupId'
  );

  insert into ads.ad_groups as t (
    seller_account_id, ads_profile_id, campaign_id, ad_group_id, name, state,
    default_bid, currency, source, imported_at, updated_at
  )
  select
    p_seller, coalesce(e ->> 'profileId', ''), coalesce(e ->> 'campaignId', ''),
    e ->> 'adGroupId', coalesce(e ->> 'name', ''), e ->> 'state',
    nullif(e ->> 'defaultBid', '')::numeric, nullif(e ->> 'currency', ''),
    coalesce(nullif(e ->> 'src', ''), 'api'), now(), now()
  from jsonb_array_elements(v_clean) e
  on conflict (seller_account_id, ad_group_id) do update set
    ads_profile_id = coalesce(nullif(excluded.ads_profile_id, ''), t.ads_profile_id),
    campaign_id    = coalesce(nullif(excluded.campaign_id, ''), t.campaign_id),
    name           = excluded.name,
    state          = excluded.state,
    default_bid    = coalesce(excluded.default_bid, t.default_bid),
    currency       = coalesce(excluded.currency, t.currency),
    source         = excluded.source,
    updated_at     = excluded.updated_at;

  get diagnostics v_rows = row_count;

  return query select greatest(v_rows - v_upd, 0), v_upd, v_bad,
                      greatest(v_total - v_valid - v_bad, 0);
end;
$$;

comment on function public.vexim_worker_upsert_ads_ad_groups(uuid, jsonb) is
  'Nhập ad group SP (POST /sp/adGroups/list) — chỉ service_role. Idempotent theo (shop, ad_group_id). '
  'Trả (inserted, updated, skipped = thiếu adGroupId, merged = trùng khoá bị gộp).';

-- ---------------------------------------------------------------------------
-- 16.4 Targets / keywords (/sp/keywords/list · /sp/targets/list)
-- ---------------------------------------------------------------------------
create or replace function public.vexim_worker_upsert_ads_targets(
  p_seller uuid,
  p_rows   jsonb
)
returns table (inserted int, updated int, skipped int, merged int)
language plpgsql
security definer
set search_path = ads, finance, public, pg_catalog
as $$
declare
  v_clean jsonb;
  v_total int;
  v_valid int;
  v_bad   int := 0;
  v_upd   int := 0;
  v_rows  int := 0;
begin
  perform ads.assert_worker(p_seller, p_rows);
  v_total := jsonb_array_length(p_rows);

  -- `skipped` = dòng KHÔNG ĐỦ KHOÁ (không dùng được), `merged` = dòng trùng khoá bị gộp.
  -- Hai số này khác nghĩa: gộp trùng là bình thường, bỏ dòng là dấu hiệu report lạ.
  select count(*) into v_bad
  from jsonb_array_elements(p_rows) r
  where btrim(coalesce(r ->> 'targetKey', '')) = '';

  select coalesce(jsonb_agg(jsonb_build_object(
           'targetKey', g.target_key, 'targetKind', g.target_kind, 'campaignId', g.campaign_id,
           'adGroupId', g.ad_group_id, 'profileId', g.profile_id, 'keywordText', g.keyword_text,
           'matchType', g.match_type, 'expressionType', g.expression_type,
           'expressionValue', g.expression_value, 'bid', g.bid, 'state', g.state,
           'currency', g.currency, 'src', g.src)), '[]'::jsonb)
    into v_clean
  from (
    select distinct on (s.ad_group_id, s.target_kind, s.target_key, s.match_type)
           s.target_key, s.target_kind, s.campaign_id, s.ad_group_id, s.profile_id,
           s.keyword_text, s.match_type, s.expression_type, s.expression_value,
           s.bid, s.state, s.currency, s.src
    from (
      select
        btrim(r ->> 'targetKey')                                      as target_key,
        case lower(btrim(coalesce(r ->> 'targetKind', '')))
          when 'keyword'        then 'keyword'
          when 'product_target' then 'product_target'
          when 'auto'           then 'auto'
          else 'unknown' end                                          as target_kind,
        btrim(coalesce(r ->> 'campaignId', ''))                       as campaign_id,
        btrim(coalesce(r ->> 'adGroupId', ''))                        as ad_group_id,
        btrim(coalesce(r ->> 'adsProfileId', ''))                     as profile_id,
        nullif(btrim(coalesce(r ->> 'keywordText', '')), '')          as keyword_text,
        upper(btrim(coalesce(r ->> 'matchType', '')))                 as match_type,
        nullif(btrim(coalesce(r ->> 'expressionType', '')), '')       as expression_type,
        nullif(btrim(coalesce(r ->> 'expressionValue', '')), '')      as expression_value,
        finance.num_or_null(r ->> 'bid')                              as bid,
        coalesce(nullif(upper(btrim(coalesce(r ->> 'state', ''))), ''), 'ENABLED') as state,
        nullif(upper(btrim(coalesce(r ->> 'currency', ''))), '')      as currency,
        coalesce(nullif(btrim(coalesce(r ->> 'source', '')), ''), 'api') as src
      from jsonb_array_elements(p_rows) r
      where btrim(coalesce(r ->> 'targetKey', '')) <> ''
    ) s
    order by s.ad_group_id, s.target_kind, s.target_key, s.match_type, s.src
  ) g;

  v_valid := jsonb_array_length(v_clean);

  select count(*) into v_upd
  from jsonb_array_elements(v_clean) e
  where exists (
    select 1 from ads.targets x
     where x.seller_account_id = p_seller
       and x.ad_group_id = e ->> 'adGroupId'
       and x.target_kind = e ->> 'targetKind'
       and x.target_key  = e ->> 'targetKey'
       and x.match_type  = e ->> 'matchType'
  );

  insert into ads.targets as t (
    seller_account_id, ads_profile_id, campaign_id, ad_group_id, target_kind, target_key,
    keyword_text, match_type, expression_type, expression_value, bid, state, currency,
    source, imported_at, updated_at
  )
  select
    p_seller, coalesce(e ->> 'profileId', ''), coalesce(e ->> 'campaignId', ''),
    coalesce(e ->> 'adGroupId', ''), e ->> 'targetKind', e ->> 'targetKey',
    nullif(e ->> 'keywordText', ''), coalesce(e ->> 'matchType', ''),
    nullif(e ->> 'expressionType', ''), nullif(e ->> 'expressionValue', ''),
    nullif(e ->> 'bid', '')::numeric, e ->> 'state', nullif(e ->> 'currency', ''),
    coalesce(nullif(e ->> 'src', ''), 'api'), now(), now()
  from jsonb_array_elements(v_clean) e
  on conflict (seller_account_id, ad_group_id, target_kind, target_key, match_type) do update set
    ads_profile_id   = coalesce(nullif(excluded.ads_profile_id, ''), t.ads_profile_id),
    campaign_id      = coalesce(nullif(excluded.campaign_id, ''), t.campaign_id),
    keyword_text     = coalesce(excluded.keyword_text, t.keyword_text),
    expression_type  = coalesce(excluded.expression_type, t.expression_type),
    expression_value = coalesce(excluded.expression_value, t.expression_value),
    bid              = coalesce(excluded.bid, t.bid),
    state            = excluded.state,
    currency         = coalesce(excluded.currency, t.currency),
    source           = excluded.source,
    updated_at       = excluded.updated_at;

  get diagnostics v_rows = row_count;

  return query select greatest(v_rows - v_upd, 0), v_upd, v_bad,
                      greatest(v_total - v_valid - v_bad, 0);
end;
$$;

comment on function public.vexim_worker_upsert_ads_targets(uuid, jsonb) is
  'Nhập keyword/product target SP — chỉ service_role. Idempotent theo '
  '(shop, ad_group, target_kind, target_key, match_type). Trả (inserted, updated, '
  'skipped = thiếu targetKey, merged = trùng khoá bị gộp).';

-- ============================================================================
-- 17. RPC WORKER — METRICS (5 loại report v3)
-- ============================================================================
-- Quy ước chung cho mọi RPC metrics dưới đây:
--   • Dòng trùng khoá trong CÙNG một lần nhập được CỘNG DỒN (giống 0018/0019):
--     report nhóm theo nhiều chiều có thể trả về nhiều dòng cho cùng một khoá.
--   • Số không đọc được → NULL rồi `sum()` bỏ qua; cả nhóm NULL ⇒ NULL
--     ("chưa biết"), KHÔNG tự thành 0.
--   • Trả (inserted, updated, skipped, merged, days, currencies) để log nói được
--     "bỏ bao nhiêu dòng rác · trải bao nhiêu ngày · có những tiền tệ nào".

-- ---------------------------------------------------------------------------
-- 17.1 Metrics cấp CAMPAIGN × NGÀY (report spCampaigns)
-- ---------------------------------------------------------------------------
create or replace function public.vexim_worker_upsert_ads_campaign_metrics(
  p_seller uuid,
  p_rows   jsonb
)
returns table (inserted int, updated int, skipped int, merged int, days int, currencies text)
language plpgsql
security definer
set search_path = ads, finance, public, pg_catalog
as $$
declare
  v_clean jsonb;
  v_total int;
  v_valid int;
  v_raw   int := 0;
  v_upd   int := 0;
  v_rows  int := 0;
  v_days  int := 0;
  v_curr  text;
begin
  perform ads.assert_worker(p_seller, p_rows);
  v_total := jsonb_array_length(p_rows);

  select coalesce(jsonb_agg(jsonb_build_object(
           'day', g.day, 'campaignId', g.campaign_id, 'profileId', g.profile_id,
           'impressions', g.impressions, 'clicks', g.clicks, 'cost', g.cost,
           'sales7d', g.sales_7d, 'sales14d', g.sales_14d, 'sales30d', g.sales_30d,
           'units7d', g.units_7d, 'units14d', g.units_14d, 'units30d', g.units_30d,
           'purchases7d', g.purchases_7d, 'purchases14d', g.purchases_14d,
           'purchases30d', g.purchases_30d, 'budgetAmount', g.budget_amount,
           'currency', g.currency, 'src', g.src, 'rows', g.raw_rows)), '[]'::jsonb)
    into v_clean
  from (
    select
      n.day, n.campaign_id,
      count(*)                        as raw_rows,
      max(n.profile_id)               as profile_id,
      sum(n.impressions)              as impressions,
      sum(n.clicks)                   as clicks,
      sum(n.cost)                     as cost,
      sum(n.sales_7d)                 as sales_7d,
      sum(n.sales_14d)                as sales_14d,
      sum(n.sales_30d)                as sales_30d,
      sum(n.units_7d)                 as units_7d,
      sum(n.units_14d)                as units_14d,
      sum(n.units_30d)                as units_30d,
      sum(n.purchases_7d)             as purchases_7d,
      sum(n.purchases_14d)            as purchases_14d,
      sum(n.purchases_30d)            as purchases_30d,
      max(n.budget_amount)            as budget_amount,
      max(n.currency)                 as currency,
      max(n.src)                      as src
    from (
      select
        case when btrim(coalesce(r ->> 'day', '')) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
             then btrim(r ->> 'day')::date end                     as day,
        btrim(coalesce(r ->> 'campaignId', ''))                    as campaign_id,
        btrim(coalesce(r ->> 'adsProfileId', ''))                  as profile_id,
        ads.int_or_null(r ->> 'impressions')                       as impressions,
        ads.int_or_null(r ->> 'clicks')                            as clicks,
        finance.num_or_null(r ->> 'cost')                          as cost,
        finance.num_or_null(r ->> 'sales7d')                       as sales_7d,
        finance.num_or_null(r ->> 'sales14d')                      as sales_14d,
        finance.num_or_null(r ->> 'sales30d')                      as sales_30d,
        ads.int_or_null(r ->> 'unitsSoldClicks7d')                 as units_7d,
        ads.int_or_null(r ->> 'unitsSoldClicks14d')                as units_14d,
        ads.int_or_null(r ->> 'unitsSoldClicks30d')                as units_30d,
        ads.int_or_null(r ->> 'purchases7d')                       as purchases_7d,
        ads.int_or_null(r ->> 'purchases14d')                      as purchases_14d,
        ads.int_or_null(r ->> 'purchases30d')                      as purchases_30d,
        finance.num_or_null(r ->> 'budgetAmount')                  as budget_amount,
        nullif(upper(btrim(coalesce(r ->> 'currency', ''))), '')   as currency,
        coalesce(nullif(btrim(coalesce(r ->> 'source', '')), ''), 'report') as src
      from jsonb_array_elements(p_rows) r
    ) n
    where n.day is not null and n.campaign_id <> ''
    group by 1, 2
  ) g;

  v_valid := jsonb_array_length(v_clean);

  select count(distinct e ->> 'day')::int,
         coalesce(string_agg(distinct nullif(e ->> 'currency', ''), ','
                             order by nullif(e ->> 'currency', '')), '')::text,
         coalesce(sum((e ->> 'rows')::int), 0)::int
    into v_days, v_curr, v_raw
  from jsonb_array_elements(v_clean) e;

  select count(*) into v_upd
  from jsonb_array_elements(v_clean) e
  where exists (
    select 1 from ads.ad_metrics_daily x
     where x.seller_account_id = p_seller
       and x.day = (e ->> 'day')::date
       and x.campaign_id = e ->> 'campaignId'
  );

  insert into ads.ad_metrics_daily as t (
    seller_account_id, day, campaign_id, ad_profile_id, currency,
    impressions, clicks, cost,
    sales_7d, sales_14d, sales_30d,
    units_sold_clicks_7d, units_sold_clicks_14d, units_sold_clicks_30d,
    purchases_7d, purchases_14d, purchases_30d, budget_amount,
    -- cột 0001: giữ đồng bộ với số v3 (spend ≡ cost, sales ≡ sales_7d, orders ≡ purchases_7d)
    spend, sales, orders, source, imported_at, updated_at
  )
  select
    p_seller,
    (e ->> 'day')::date,
    e ->> 'campaignId',
    coalesce(e ->> 'profileId', ''),
    nullif(e ->> 'currency', ''),
    nullif(e ->> 'impressions', '')::int,
    nullif(e ->> 'clicks', '')::int,
    nullif(e ->> 'cost', '')::numeric,
    nullif(e ->> 'sales7d', '')::numeric,
    nullif(e ->> 'sales14d', '')::numeric,
    nullif(e ->> 'sales30d', '')::numeric,
    nullif(e ->> 'units7d', '')::int,
    nullif(e ->> 'units14d', '')::int,
    nullif(e ->> 'units30d', '')::int,
    nullif(e ->> 'purchases7d', '')::int,
    nullif(e ->> 'purchases14d', '')::int,
    nullif(e ->> 'purchases30d', '')::int,
    nullif(e ->> 'budgetAmount', '')::numeric,
    nullif(e ->> 'cost', '')::numeric,
    nullif(e ->> 'sales7d', '')::numeric,
    nullif(e ->> 'purchases7d', '')::int,
    coalesce(nullif(e ->> 'src', ''), 'report'),
    now(), now()
  from jsonb_array_elements(v_clean) e
  on conflict (seller_account_id, day, campaign_id) do update set
    ad_profile_id          = coalesce(nullif(excluded.ad_profile_id, ''), t.ad_profile_id),
    currency               = coalesce(excluded.currency, t.currency),
    impressions            = coalesce(excluded.impressions, t.impressions),
    clicks                 = coalesce(excluded.clicks, t.clicks),
    cost                   = coalesce(excluded.cost, t.cost),
    sales_7d               = coalesce(excluded.sales_7d, t.sales_7d),
    sales_14d              = coalesce(excluded.sales_14d, t.sales_14d),
    sales_30d              = coalesce(excluded.sales_30d, t.sales_30d),
    units_sold_clicks_7d   = coalesce(excluded.units_sold_clicks_7d, t.units_sold_clicks_7d),
    units_sold_clicks_14d  = coalesce(excluded.units_sold_clicks_14d, t.units_sold_clicks_14d),
    units_sold_clicks_30d  = coalesce(excluded.units_sold_clicks_30d, t.units_sold_clicks_30d),
    purchases_7d           = coalesce(excluded.purchases_7d, t.purchases_7d),
    purchases_14d          = coalesce(excluded.purchases_14d, t.purchases_14d),
    purchases_30d          = coalesce(excluded.purchases_30d, t.purchases_30d),
    budget_amount          = coalesce(excluded.budget_amount, t.budget_amount),
    spend                  = coalesce(excluded.cost, t.spend),
    sales                  = coalesce(excluded.sales_7d, t.sales),
    orders                 = coalesce(excluded.purchases_7d, t.orders),
    source                 = excluded.source,
    imported_at            = excluded.imported_at,
    updated_at             = excluded.updated_at;

  get diagnostics v_rows = row_count;

  return query
    select greatest(v_rows - v_upd, 0), v_upd, greatest(v_total - v_raw, 0),
           greatest(v_raw - v_valid, 0), v_days, v_curr;
end;
$$;

comment on function public.vexim_worker_upsert_ads_campaign_metrics(uuid, jsonb) is
  'Nhập metrics campaign/ngày (report spCampaigns) — chỉ service_role. Idempotent theo '
  '(shop, ngày, campaignId). Ghi song song spend=cost · sales=sales7d · orders=purchases7d '
  'để không phá vỡ shape của bảng 0001.';

-- ---------------------------------------------------------------------------
-- 17.2 Metrics cấp KEYWORD/TARGET × NGÀY (report spTargeting)
-- ---------------------------------------------------------------------------
create or replace function public.vexim_worker_upsert_ads_target_metrics(
  p_seller uuid,
  p_rows   jsonb
)
returns table (inserted int, updated int, skipped int, merged int, days int, currencies text)
language plpgsql
security definer
set search_path = ads, finance, public, pg_catalog
as $$
declare
  v_clean jsonb;
  v_total int;
  v_valid int;
  v_raw   int := 0;
  v_upd   int := 0;
  v_rows  int := 0;
  v_days  int := 0;
  v_curr  text;
begin
  perform ads.assert_worker(p_seller, p_rows);
  v_total := jsonb_array_length(p_rows);

  select coalesce(jsonb_agg(jsonb_build_object(
           'day', g.day, 'campaignId', g.campaign_id, 'adGroupId', g.ad_group_id,
           'targetKind', g.target_kind, 'targetKey', g.target_key, 'profileId', g.profile_id,
           'keywordText', g.keyword_text, 'matchType', g.match_type,
           'expressionType', g.expression_type, 'expressionValue', g.expression_value,
           'impressions', g.impressions, 'clicks', g.clicks, 'cost', g.cost,
           'sales7d', g.sales_7d, 'sales14d', g.sales_14d, 'sales30d', g.sales_30d,
           'units7d', g.units_7d, 'units14d', g.units_14d, 'units30d', g.units_30d,
           'purchases7d', g.purchases_7d, 'purchases14d', g.purchases_14d,
           'purchases30d', g.purchases_30d, 'currency', g.currency,
           'src', g.src, 'rows', g.raw_rows)), '[]'::jsonb)
    into v_clean
  from (
    select
      n.day, n.campaign_id, n.ad_group_id, n.target_kind, n.target_key, n.match_type,
      count(*)                    as raw_rows,
      max(n.profile_id)           as profile_id,
      max(n.keyword_text)         as keyword_text,
      max(n.expression_type)      as expression_type,
      max(n.expression_value)     as expression_value,
      sum(n.impressions)          as impressions,
      sum(n.clicks)               as clicks,
      sum(n.cost)                 as cost,
      sum(n.sales_7d)             as sales_7d,
      sum(n.sales_14d)            as sales_14d,
      sum(n.sales_30d)            as sales_30d,
      sum(n.units_7d)             as units_7d,
      sum(n.units_14d)            as units_14d,
      sum(n.units_30d)            as units_30d,
      sum(n.purchases_7d)         as purchases_7d,
      sum(n.purchases_14d)        as purchases_14d,
      sum(n.purchases_30d)        as purchases_30d,
      max(n.currency)             as currency,
      max(n.src)                  as src
    from (
      select
        case when btrim(coalesce(r ->> 'day', '')) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
             then btrim(r ->> 'day')::date end                     as day,
        btrim(coalesce(r ->> 'campaignId', ''))                    as campaign_id,
        btrim(coalesce(r ->> 'adGroupId', ''))                     as ad_group_id,
        case lower(btrim(coalesce(r ->> 'targetKind', '')))
          when 'keyword'        then 'keyword'
          when 'product_target' then 'product_target'
          when 'auto'           then 'auto'
          else 'unknown' end                                       as target_kind,
        btrim(coalesce(r ->> 'targetKey', ''))                     as target_key,
        btrim(coalesce(r ->> 'adsProfileId', ''))                  as profile_id,
        nullif(btrim(coalesce(r ->> 'keywordText', '')), '')       as keyword_text,
        upper(btrim(coalesce(r ->> 'matchType', '')))              as match_type,
        nullif(btrim(coalesce(r ->> 'expressionType', '')), '')    as expression_type,
        nullif(btrim(coalesce(r ->> 'expressionValue', '')), '')   as expression_value,
        ads.int_or_null(r ->> 'impressions')                       as impressions,
        ads.int_or_null(r ->> 'clicks')                            as clicks,
        finance.num_or_null(r ->> 'cost')                          as cost,
        finance.num_or_null(r ->> 'sales7d')                       as sales_7d,
        finance.num_or_null(r ->> 'sales14d')                      as sales_14d,
        finance.num_or_null(r ->> 'sales30d')                      as sales_30d,
        ads.int_or_null(r ->> 'unitsSoldClicks7d')                 as units_7d,
        ads.int_or_null(r ->> 'unitsSoldClicks14d')                as units_14d,
        ads.int_or_null(r ->> 'unitsSoldClicks30d')                as units_30d,
        ads.int_or_null(r ->> 'purchases7d')                       as purchases_7d,
        ads.int_or_null(r ->> 'purchases14d')                      as purchases_14d,
        ads.int_or_null(r ->> 'purchases30d')                      as purchases_30d,
        nullif(upper(btrim(coalesce(r ->> 'currency', ''))), '')   as currency,
        coalesce(nullif(btrim(coalesce(r ->> 'source', '')), ''), 'report') as src
      from jsonb_array_elements(p_rows) r
    ) n
    -- Bắt buộc có ad group + khoá target: thiếu thì KHÔNG biết dòng này của từ khoá nào
    where n.day is not null and n.ad_group_id <> '' and n.target_key <> ''
    group by 1, 2, 3, 4, 5, 6
  ) g;

  v_valid := jsonb_array_length(v_clean);

  select count(distinct e ->> 'day')::int,
         coalesce(string_agg(distinct nullif(e ->> 'currency', ''), ','
                             order by nullif(e ->> 'currency', '')), '')::text,
         coalesce(sum((e ->> 'rows')::int), 0)::int
    into v_days, v_curr, v_raw
  from jsonb_array_elements(v_clean) e;

  select count(*) into v_upd
  from jsonb_array_elements(v_clean) e
  where exists (
    select 1 from ads.target_metrics_daily x
     where x.seller_account_id = p_seller
       and x.day = (e ->> 'day')::date
       and x.campaign_id = e ->> 'campaignId'
       and x.ad_group_id = e ->> 'adGroupId'
       and x.target_kind = e ->> 'targetKind'
       and x.target_key  = e ->> 'targetKey'
       and x.match_type  = e ->> 'matchType'
  );

  insert into ads.target_metrics_daily as t (
    seller_account_id, ads_profile_id, day, campaign_id, ad_group_id, target_kind, target_key,
    keyword_text, match_type, expression_type, expression_value,
    impressions, clicks, cost, sales_7d, sales_14d, sales_30d,
    units_sold_clicks_7d, units_sold_clicks_14d, units_sold_clicks_30d,
    purchases_7d, purchases_14d, purchases_30d, currency, source, imported_at, updated_at
  )
  select
    p_seller, coalesce(e ->> 'profileId', ''), (e ->> 'day')::date,
    e ->> 'campaignId', e ->> 'adGroupId', e ->> 'targetKind', e ->> 'targetKey',
    nullif(e ->> 'keywordText', ''), coalesce(e ->> 'matchType', ''),
    nullif(e ->> 'expressionType', ''), nullif(e ->> 'expressionValue', ''),
    nullif(e ->> 'impressions', '')::int, nullif(e ->> 'clicks', '')::int,
    nullif(e ->> 'cost', '')::numeric,
    nullif(e ->> 'sales7d', '')::numeric, nullif(e ->> 'sales14d', '')::numeric,
    nullif(e ->> 'sales30d', '')::numeric,
    nullif(e ->> 'units7d', '')::int, nullif(e ->> 'units14d', '')::int,
    nullif(e ->> 'units30d', '')::int,
    nullif(e ->> 'purchases7d', '')::int, nullif(e ->> 'purchases14d', '')::int,
    nullif(e ->> 'purchases30d', '')::int,
    nullif(e ->> 'currency', ''), coalesce(nullif(e ->> 'src', ''), 'report'), now(), now()
  from jsonb_array_elements(v_clean) e
  on conflict (seller_account_id, day, campaign_id, ad_group_id, target_kind, target_key, match_type)
  do update set
    ads_profile_id         = coalesce(nullif(excluded.ads_profile_id, ''), t.ads_profile_id),
    keyword_text           = coalesce(excluded.keyword_text, t.keyword_text),
    expression_type        = coalesce(excluded.expression_type, t.expression_type),
    expression_value       = coalesce(excluded.expression_value, t.expression_value),
    impressions            = coalesce(excluded.impressions, t.impressions),
    clicks                 = coalesce(excluded.clicks, t.clicks),
    cost                   = coalesce(excluded.cost, t.cost),
    sales_7d               = coalesce(excluded.sales_7d, t.sales_7d),
    sales_14d              = coalesce(excluded.sales_14d, t.sales_14d),
    sales_30d              = coalesce(excluded.sales_30d, t.sales_30d),
    units_sold_clicks_7d   = coalesce(excluded.units_sold_clicks_7d, t.units_sold_clicks_7d),
    units_sold_clicks_14d  = coalesce(excluded.units_sold_clicks_14d, t.units_sold_clicks_14d),
    units_sold_clicks_30d  = coalesce(excluded.units_sold_clicks_30d, t.units_sold_clicks_30d),
    purchases_7d           = coalesce(excluded.purchases_7d, t.purchases_7d),
    purchases_14d          = coalesce(excluded.purchases_14d, t.purchases_14d),
    purchases_30d          = coalesce(excluded.purchases_30d, t.purchases_30d),
    currency               = coalesce(excluded.currency, t.currency),
    source                 = excluded.source,
    imported_at            = excluded.imported_at,
    updated_at             = excluded.updated_at;

  get diagnostics v_rows = row_count;

  return query
    select greatest(v_rows - v_upd, 0), v_upd, greatest(v_total - v_raw, 0),
           greatest(v_raw - v_valid, 0), v_days, v_curr;
end;
$$;

comment on function public.vexim_worker_upsert_ads_target_metrics(uuid, jsonb) is
  'Nhập metrics keyword/target/ngày (report spTargeting) — chỉ service_role. Idempotent theo '
  '(shop, ngày, campaign, ad group, target_kind, target_key, match_type).';

-- ---------------------------------------------------------------------------
-- 17.3 SEARCH TERMS (report spSearchTerm)
-- ---------------------------------------------------------------------------
create or replace function public.vexim_worker_upsert_ads_search_terms(
  p_seller uuid,
  p_rows   jsonb
)
returns table (inserted int, updated int, skipped int, merged int, days int, currencies text)
language plpgsql
security definer
set search_path = ads, finance, public, pg_catalog
as $$
declare
  v_clean jsonb;
  v_total int;
  v_valid int;
  v_raw   int := 0;
  v_upd   int := 0;
  v_rows  int := 0;
  v_days  int := 0;
  v_curr  text;
begin
  perform ads.assert_worker(p_seller, p_rows);
  v_total := jsonb_array_length(p_rows);

  select coalesce(jsonb_agg(jsonb_build_object(
           'day', g.day, 'term', g.term, 'campaignId', g.campaign_id, 'adGroupId', g.ad_group_id,
           'keywordId', g.keyword_id, 'keywordText', g.keyword_text, 'matchType', g.match_type,
           'profileId', g.profile_id, 'impressions', g.impressions, 'clicks', g.clicks,
           'cost', g.cost, 'sales7d', g.sales_7d, 'sales14d', g.sales_14d, 'sales30d', g.sales_30d,
           'units7d', g.units_7d, 'purchases7d', g.purchases_7d,
           'currency', g.currency, 'src', g.src, 'rows', g.raw_rows)), '[]'::jsonb)
    into v_clean
  from (
    select
      n.day, n.term, n.campaign_id, n.ad_group_id, n.keyword_id, n.match_type,
      count(*)                as raw_rows,
      max(n.keyword_text)     as keyword_text,
      max(n.profile_id)       as profile_id,
      sum(n.impressions)      as impressions,
      sum(n.clicks)           as clicks,
      sum(n.cost)             as cost,
      sum(n.sales_7d)         as sales_7d,
      sum(n.sales_14d)        as sales_14d,
      sum(n.sales_30d)        as sales_30d,
      sum(n.units_7d)         as units_7d,
      sum(n.purchases_7d)     as purchases_7d,
      max(n.currency)         as currency,
      max(n.src)              as src
    from (
      select
        case when btrim(coalesce(r ->> 'day', '')) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
             then btrim(r ->> 'day')::date end                     as day,
        lower(btrim(coalesce(r ->> 'searchTerm', '')))             as term,
        btrim(coalesce(r ->> 'campaignId', ''))                    as campaign_id,
        btrim(coalesce(r ->> 'adGroupId', ''))                     as ad_group_id,
        btrim(coalesce(r ->> 'keywordId', ''))                     as keyword_id,
        nullif(btrim(coalesce(r ->> 'keywordText', '')), '')       as keyword_text,
        upper(btrim(coalesce(r ->> 'matchType', '')))              as match_type,
        btrim(coalesce(r ->> 'adsProfileId', ''))                  as profile_id,
        ads.int_or_null(r ->> 'impressions')                       as impressions,
        ads.int_or_null(r ->> 'clicks')                            as clicks,
        finance.num_or_null(r ->> 'cost')                          as cost,
        finance.num_or_null(r ->> 'sales7d')                       as sales_7d,
        finance.num_or_null(r ->> 'sales14d')                      as sales_14d,
        finance.num_or_null(r ->> 'sales30d')                      as sales_30d,
        ads.int_or_null(r ->> 'unitsSoldClicks7d')                 as units_7d,
        ads.int_or_null(r ->> 'purchases7d')                       as purchases_7d,
        nullif(upper(btrim(coalesce(r ->> 'currency', ''))), '')   as currency,
        coalesce(nullif(btrim(coalesce(r ->> 'source', '')), ''), 'report') as src
      from jsonb_array_elements(p_rows) r
    ) n
    where n.day is not null and n.term <> ''
    group by 1, 2, 3, 4, 5, 6
  ) g;

  v_valid := jsonb_array_length(v_clean);

  select count(distinct e ->> 'day')::int,
         coalesce(string_agg(distinct nullif(e ->> 'currency', ''), ','
                             order by nullif(e ->> 'currency', '')), '')::text,
         coalesce(sum((e ->> 'rows')::int), 0)::int
    into v_days, v_curr, v_raw
  from jsonb_array_elements(v_clean) e;

  select count(*) into v_upd
  from jsonb_array_elements(v_clean) e
  where exists (
    select 1 from ads.search_terms x
     where x.seller_account_id = p_seller
       and x.day = (e ->> 'day')::date
       and x.campaign_id = e ->> 'campaignId'
       and x.ad_group_id = e ->> 'adGroupId'
       and x.keyword_id  = e ->> 'keywordId'
       and x.term        = e ->> 'term'
       and x.match_type  = e ->> 'matchType'
  );

  insert into ads.search_terms as t (
    seller_account_id, day, term, match_type, ad_profile_id, campaign_id, ad_group_id,
    keyword_id, keyword_text, impressions, clicks, cost, sales_7d, sales_14d, sales_30d,
    units_sold_clicks_7d, purchases_7d, currency,
    -- cột 0001 giữ đồng bộ: spend ≡ cost, sales ≡ sales_7d
    spend, sales, source, imported_at, updated_at
  )
  select
    p_seller, (e ->> 'day')::date, e ->> 'term', coalesce(e ->> 'matchType', ''),
    coalesce(e ->> 'profileId', ''), coalesce(e ->> 'campaignId', ''),
    coalesce(e ->> 'adGroupId', ''), coalesce(e ->> 'keywordId', ''),
    nullif(e ->> 'keywordText', ''),
    nullif(e ->> 'impressions', '')::int, nullif(e ->> 'clicks', '')::int,
    nullif(e ->> 'cost', '')::numeric,
    nullif(e ->> 'sales7d', '')::numeric, nullif(e ->> 'sales14d', '')::numeric,
    nullif(e ->> 'sales30d', '')::numeric,
    nullif(e ->> 'units7d', '')::int, nullif(e ->> 'purchases7d', '')::int,
    nullif(e ->> 'currency', ''),
    nullif(e ->> 'cost', '')::numeric,
    nullif(e ->> 'sales7d', '')::numeric,
    coalesce(nullif(e ->> 'src', ''), 'report'), now(), now()
  from jsonb_array_elements(v_clean) e
  on conflict (seller_account_id, day, campaign_id, ad_group_id, keyword_id, term, match_type)
  do update set
    ad_profile_id         = coalesce(nullif(excluded.ad_profile_id, ''), t.ad_profile_id),
    keyword_text          = coalesce(excluded.keyword_text, t.keyword_text),
    impressions           = coalesce(excluded.impressions, t.impressions),
    clicks                = coalesce(excluded.clicks, t.clicks),
    cost                  = coalesce(excluded.cost, t.cost),
    sales_7d              = coalesce(excluded.sales_7d, t.sales_7d),
    sales_14d             = coalesce(excluded.sales_14d, t.sales_14d),
    sales_30d             = coalesce(excluded.sales_30d, t.sales_30d),
    units_sold_clicks_7d  = coalesce(excluded.units_sold_clicks_7d, t.units_sold_clicks_7d),
    purchases_7d          = coalesce(excluded.purchases_7d, t.purchases_7d),
    currency              = coalesce(excluded.currency, t.currency),
    spend                 = coalesce(excluded.cost, t.spend),
    sales                 = coalesce(excluded.sales_7d, t.sales),
    source                = excluded.source,
    imported_at           = excluded.imported_at,
    updated_at            = excluded.updated_at;

  get diagnostics v_rows = row_count;

  return query
    select greatest(v_rows - v_upd, 0), v_upd, greatest(v_total - v_raw, 0),
           greatest(v_raw - v_valid, 0), v_days, v_curr;
end;
$$;

comment on function public.vexim_worker_upsert_ads_search_terms(uuid, jsonb) is
  'Nhập search term (report spSearchTerm) — chỉ service_role. Idempotent theo '
  '(shop, ngày, campaign, ad group, keywordId, term, matchType). Term được lower() để '
  '"Vali 20 inch" và "vali 20 inch" không thành hai dòng khác nhau.';

-- ---------------------------------------------------------------------------
-- 17.4 PRODUCT METRICS — spAdvertisedProduct (p_level='advertised') và
--      spPurchasedProduct (p_level='purchased') dùng CHUNG một RPC vì payload
--      giống nhau; khác bảng đích + khoá.
-- ---------------------------------------------------------------------------
create or replace function public.vexim_worker_upsert_ads_product_metrics(
  p_seller uuid,
  p_level  text,
  p_rows   jsonb
)
returns table (inserted int, updated int, skipped int, merged int, days int, currencies text)
language plpgsql
security definer
set search_path = ads, finance, public, pg_catalog
as $$
declare
  v_clean jsonb;
  v_total int;
  v_valid int;
  v_raw   int := 0;
  v_upd   int := 0;
  v_rows  int := 0;
  v_days  int := 0;
  v_curr  text;
  v_level text := lower(btrim(coalesce(p_level, '')));
begin
  perform ads.assert_worker(p_seller, p_rows);
  if v_level not in ('advertised', 'purchased') then
    raise exception '[M5-ADS] p_level phải là advertised hoặc purchased (nhận %)', p_level
      using errcode = 'invalid_parameter_value';
  end if;
  v_total := jsonb_array_length(p_rows);

  select coalesce(jsonb_agg(jsonb_build_object(
           'day', g.day, 'campaignId', g.campaign_id, 'adGroupId', g.ad_group_id,
           'advertisedAsin', g.advertised_asin, 'advertisedSku', g.advertised_sku,
           'purchasedAsin', g.purchased_asin, 'keywordText', g.keyword_text,
           'matchType', g.match_type, 'profileId', g.profile_id,
           'impressions', g.impressions, 'clicks', g.clicks, 'cost', g.cost,
           'sales7d', g.sales_7d, 'sales14d', g.sales_14d, 'sales30d', g.sales_30d,
           'units7d', g.units_7d, 'units14d', g.units_14d, 'units30d', g.units_30d,
           'purchases7d', g.purchases_7d, 'purchases14d', g.purchases_14d,
           'purchases30d', g.purchases_30d,
           'salesOther7d', g.sales_other_7d, 'salesOther14d', g.sales_other_14d,
           'salesOther30d', g.sales_other_30d,
           'unitsOther7d', g.units_other_7d, 'unitsOther14d', g.units_other_14d,
           'unitsOther30d', g.units_other_30d,
           'currency', g.currency, 'src', g.src, 'rows', g.raw_rows)), '[]'::jsonb)
    into v_clean
  from (
    select
      n.day, n.campaign_id, n.ad_group_id, n.advertised_asin, n.advertised_sku,
      n.purchased_asin,
      count(*)                as raw_rows,
      max(n.keyword_text)     as keyword_text,
      max(n.match_type)       as match_type,
      max(n.profile_id)       as profile_id,
      sum(n.impressions)      as impressions,
      sum(n.clicks)           as clicks,
      sum(n.cost)             as cost,
      sum(n.sales_7d)         as sales_7d,
      sum(n.sales_14d)        as sales_14d,
      sum(n.sales_30d)        as sales_30d,
      sum(n.units_7d)         as units_7d,
      sum(n.units_14d)        as units_14d,
      sum(n.units_30d)        as units_30d,
      sum(n.purchases_7d)     as purchases_7d,
      sum(n.purchases_14d)    as purchases_14d,
      sum(n.purchases_30d)    as purchases_30d,
      sum(n.sales_other_7d)   as sales_other_7d,
      sum(n.sales_other_14d)  as sales_other_14d,
      sum(n.sales_other_30d)  as sales_other_30d,
      sum(n.units_other_7d)   as units_other_7d,
      sum(n.units_other_14d)  as units_other_14d,
      sum(n.units_other_30d)  as units_other_30d,
      max(n.currency)         as currency,
      max(n.src)              as src
    from (
      select
        case when btrim(coalesce(r ->> 'day', '')) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
             then btrim(r ->> 'day')::date end                     as day,
        btrim(coalesce(r ->> 'campaignId', ''))                    as campaign_id,
        btrim(coalesce(r ->> 'adGroupId', ''))                     as ad_group_id,
        upper(btrim(coalesce(r ->> 'advertisedAsin', '')))         as advertised_asin,
        upper(btrim(coalesce(r ->> 'advertisedSku', '')))          as advertised_sku,
        upper(btrim(coalesce(r ->> 'purchasedAsin', '')))          as purchased_asin,
        nullif(btrim(coalesce(r ->> 'keywordText', '')), '')       as keyword_text,
        upper(btrim(coalesce(r ->> 'matchType', '')))              as match_type,
        btrim(coalesce(r ->> 'adsProfileId', ''))                  as profile_id,
        ads.int_or_null(r ->> 'impressions')                       as impressions,
        ads.int_or_null(r ->> 'clicks')                            as clicks,
        finance.num_or_null(r ->> 'cost')                          as cost,
        finance.num_or_null(r ->> 'sales7d')                       as sales_7d,
        finance.num_or_null(r ->> 'sales14d')                      as sales_14d,
        finance.num_or_null(r ->> 'sales30d')                      as sales_30d,
        ads.int_or_null(r ->> 'unitsSoldClicks7d')                 as units_7d,
        ads.int_or_null(r ->> 'unitsSoldClicks14d')                as units_14d,
        ads.int_or_null(r ->> 'unitsSoldClicks30d')                as units_30d,
        ads.int_or_null(r ->> 'purchases7d')                       as purchases_7d,
        ads.int_or_null(r ->> 'purchases14d')                      as purchases_14d,
        ads.int_or_null(r ->> 'purchases30d')                      as purchases_30d,
        finance.num_or_null(r ->> 'salesOtherSku7d')               as sales_other_7d,
        finance.num_or_null(r ->> 'salesOtherSku14d')              as sales_other_14d,
        finance.num_or_null(r ->> 'salesOtherSku30d')              as sales_other_30d,
        ads.int_or_null(r ->> 'unitsSoldOtherSku7d')               as units_other_7d,
        ads.int_or_null(r ->> 'unitsSoldOtherSku14d')              as units_other_14d,
        ads.int_or_null(r ->> 'unitsSoldOtherSku30d')              as units_other_30d,
        nullif(upper(btrim(coalesce(r ->> 'currency', ''))), '')   as currency,
        coalesce(nullif(btrim(coalesce(r ->> 'source', '')), ''), 'report') as src
      from jsonb_array_elements(p_rows) r
    ) n
    -- Khoá tối thiểu: phải biết ĐANG quảng cáo SKU/ASIN nào. Với report ASIN đã mua,
    -- thêm yêu cầu có purchasedAsin (thiếu ⇒ không biết đã mua gì → bỏ, đếm skipped).
    where n.day is not null
      and (n.advertised_asin <> '' or n.advertised_sku <> '')
      and (v_level = 'advertised' or n.purchased_asin <> '')
    group by 1, 2, 3, 4, 5, 6
  ) g;

  v_valid := jsonb_array_length(v_clean);

  select count(distinct e ->> 'day')::int,
         coalesce(string_agg(distinct nullif(e ->> 'currency', ''), ','
                             order by nullif(e ->> 'currency', '')), '')::text,
         coalesce(sum((e ->> 'rows')::int), 0)::int
    into v_days, v_curr, v_raw
  from jsonb_array_elements(v_clean) e;

  if v_level = 'advertised' then
    select count(*) into v_upd
    from jsonb_array_elements(v_clean) e
    where exists (
      select 1 from ads.advertised_product_metrics_daily x
       where x.seller_account_id = p_seller
         and x.day = (e ->> 'day')::date
         and x.campaign_id = e ->> 'campaignId'
         and x.ad_group_id = e ->> 'adGroupId'
         and x.advertised_asin = e ->> 'advertisedAsin'
         and x.advertised_sku  = e ->> 'advertisedSku'
    );

    insert into ads.advertised_product_metrics_daily as t (
      seller_account_id, ads_profile_id, day, campaign_id, ad_group_id,
      advertised_asin, advertised_sku, impressions, clicks, cost,
      sales_7d, sales_14d, sales_30d, units_sold_clicks_7d, units_sold_clicks_14d,
      units_sold_clicks_30d, purchases_7d, purchases_14d, purchases_30d,
      currency, source, imported_at, updated_at
    )
    select
      p_seller, coalesce(e ->> 'profileId', ''), (e ->> 'day')::date,
      coalesce(e ->> 'campaignId', ''), coalesce(e ->> 'adGroupId', ''),
      e ->> 'advertisedAsin', e ->> 'advertisedSku',
      nullif(e ->> 'impressions', '')::int, nullif(e ->> 'clicks', '')::int,
      nullif(e ->> 'cost', '')::numeric,
      nullif(e ->> 'sales7d', '')::numeric, nullif(e ->> 'sales14d', '')::numeric,
      nullif(e ->> 'sales30d', '')::numeric,
      nullif(e ->> 'units7d', '')::int, nullif(e ->> 'units14d', '')::int,
      nullif(e ->> 'units30d', '')::int,
      nullif(e ->> 'purchases7d', '')::int, nullif(e ->> 'purchases14d', '')::int,
      nullif(e ->> 'purchases30d', '')::int,
      nullif(e ->> 'currency', ''), coalesce(nullif(e ->> 'src', ''), 'report'), now(), now()
    from jsonb_array_elements(v_clean) e
    on conflict (seller_account_id, day, campaign_id, ad_group_id, advertised_asin, advertised_sku)
    do update set
      ads_profile_id        = coalesce(nullif(excluded.ads_profile_id, ''), t.ads_profile_id),
      impressions           = coalesce(excluded.impressions, t.impressions),
      clicks                = coalesce(excluded.clicks, t.clicks),
      cost                  = coalesce(excluded.cost, t.cost),
      sales_7d              = coalesce(excluded.sales_7d, t.sales_7d),
      sales_14d             = coalesce(excluded.sales_14d, t.sales_14d),
      sales_30d             = coalesce(excluded.sales_30d, t.sales_30d),
      units_sold_clicks_7d  = coalesce(excluded.units_sold_clicks_7d, t.units_sold_clicks_7d),
      units_sold_clicks_14d = coalesce(excluded.units_sold_clicks_14d, t.units_sold_clicks_14d),
      units_sold_clicks_30d = coalesce(excluded.units_sold_clicks_30d, t.units_sold_clicks_30d),
      purchases_7d          = coalesce(excluded.purchases_7d, t.purchases_7d),
      purchases_14d         = coalesce(excluded.purchases_14d, t.purchases_14d),
      purchases_30d         = coalesce(excluded.purchases_30d, t.purchases_30d),
      currency              = coalesce(excluded.currency, t.currency),
      source                = excluded.source,
      imported_at           = excluded.imported_at,
      updated_at            = excluded.updated_at;
  else
    select count(*) into v_upd
    from jsonb_array_elements(v_clean) e
    where exists (
      select 1 from ads.purchased_product_metrics_daily x
       where x.seller_account_id = p_seller
         and x.day = (e ->> 'day')::date
         and x.campaign_id = e ->> 'campaignId'
         and x.ad_group_id = e ->> 'adGroupId'
         and x.purchased_asin  = e ->> 'purchasedAsin'
         and x.advertised_asin = e ->> 'advertisedAsin'
         and x.advertised_sku  = e ->> 'advertisedSku'
    );

    insert into ads.purchased_product_metrics_daily as t (
      seller_account_id, ads_profile_id, day, campaign_id, ad_group_id,
      advertised_asin, advertised_sku, purchased_asin, keyword_text, match_type,
      cost, sales_7d, sales_14d, sales_30d, sales_other_sku_7d, sales_other_sku_14d,
      sales_other_sku_30d, purchases_7d, purchases_14d, purchases_30d,
      units_sold_other_sku_7d, units_sold_other_sku_14d, units_sold_other_sku_30d,
      currency, source, imported_at, updated_at
    )
    select
      p_seller, coalesce(e ->> 'profileId', ''), (e ->> 'day')::date,
      coalesce(e ->> 'campaignId', ''), coalesce(e ->> 'adGroupId', ''),
      coalesce(e ->> 'advertisedAsin', ''), coalesce(e ->> 'advertisedSku', ''),
      e ->> 'purchasedAsin', nullif(e ->> 'keywordText', ''),
      coalesce(e ->> 'matchType', ''),
      nullif(e ->> 'cost', '')::numeric,
      nullif(e ->> 'sales7d', '')::numeric, nullif(e ->> 'sales14d', '')::numeric,
      nullif(e ->> 'sales30d', '')::numeric,
      nullif(e ->> 'salesOther7d', '')::numeric, nullif(e ->> 'salesOther14d', '')::numeric,
      nullif(e ->> 'salesOther30d', '')::numeric,
      nullif(e ->> 'purchases7d', '')::int, nullif(e ->> 'purchases14d', '')::int,
      nullif(e ->> 'purchases30d', '')::int,
      nullif(e ->> 'unitsOther7d', '')::int, nullif(e ->> 'unitsOther14d', '')::int,
      nullif(e ->> 'unitsOther30d', '')::int,
      nullif(e ->> 'currency', ''), coalesce(nullif(e ->> 'src', ''), 'report'), now(), now()
    from jsonb_array_elements(v_clean) e
    on conflict (seller_account_id, day, campaign_id, ad_group_id, purchased_asin, advertised_asin, advertised_sku)
    do update set
      ads_profile_id          = coalesce(nullif(excluded.ads_profile_id, ''), t.ads_profile_id),
      keyword_text            = coalesce(excluded.keyword_text, t.keyword_text),
      match_type              = coalesce(excluded.match_type, t.match_type),
      cost                    = coalesce(excluded.cost, t.cost),
      sales_7d                = coalesce(excluded.sales_7d, t.sales_7d),
      sales_14d               = coalesce(excluded.sales_14d, t.sales_14d),
      sales_30d               = coalesce(excluded.sales_30d, t.sales_30d),
      sales_other_sku_7d      = coalesce(excluded.sales_other_sku_7d, t.sales_other_sku_7d),
      sales_other_sku_14d     = coalesce(excluded.sales_other_sku_14d, t.sales_other_sku_14d),
      sales_other_sku_30d     = coalesce(excluded.sales_other_sku_30d, t.sales_other_sku_30d),
      purchases_7d            = coalesce(excluded.purchases_7d, t.purchases_7d),
      purchases_14d           = coalesce(excluded.purchases_14d, t.purchases_14d),
      purchases_30d           = coalesce(excluded.purchases_30d, t.purchases_30d),
      units_sold_other_sku_7d = coalesce(excluded.units_sold_other_sku_7d, t.units_sold_other_sku_7d),
      units_sold_other_sku_14d = coalesce(excluded.units_sold_other_sku_14d, t.units_sold_other_sku_14d),
      units_sold_other_sku_30d = coalesce(excluded.units_sold_other_sku_30d, t.units_sold_other_sku_30d),
      currency                = coalesce(excluded.currency, t.currency),
      source                  = excluded.source,
      imported_at             = excluded.imported_at,
      updated_at              = excluded.updated_at;
  end if;

  get diagnostics v_rows = row_count;

  return query
    select greatest(v_rows - v_upd, 0), v_upd, greatest(v_total - v_raw, 0),
           greatest(v_raw - v_valid, 0), v_days, v_curr;
end;
$$;

comment on function public.vexim_worker_upsert_ads_product_metrics(uuid, text, jsonb) is
  'Nhập report theo sản phẩm — p_level = advertised (spAdvertisedProduct) hoặc purchased '
  '(spPurchasedProduct) — chỉ service_role. Idempotent theo (shop, ngày, campaign, ad group, ASIN/SKU).';

-- ---------------------------------------------------------------------------
-- 17.5 Sự kiện ngân sách (alert budget_exhausted)
-- ---------------------------------------------------------------------------
create or replace function public.vexim_worker_upsert_ads_budget_events(
  p_seller uuid,
  p_rows   jsonb
)
returns table (inserted int, updated int, skipped int)
language plpgsql
security definer
set search_path = ads, finance, public, pg_catalog
as $$
declare
  v_clean jsonb;
  v_total int;
  v_valid int;
  v_upd   int := 0;
  v_rows  int := 0;
begin
  perform ads.assert_worker(p_seller, p_rows);
  v_total := jsonb_array_length(p_rows);

  select coalesce(jsonb_agg(jsonb_build_object(
           'day', g.day, 'campaignId', g.campaign_id, 'eventType', g.event_type,
           'profileId', g.profile_id, 'budgetAmount', g.budget_amount, 'currency', g.currency,
           'cost', g.cost, 'usagePct', g.usage_pct, 'exhaustedHour', g.exhausted_hour,
           'hourSource', g.hour_source, 'note', g.note, 'src', g.src)), '[]'::jsonb)
    into v_clean
  from (
    select distinct on (s.day, s.campaign_id, s.event_type)
           s.day, s.campaign_id, s.event_type, s.profile_id, s.budget_amount, s.currency,
           s.cost, s.usage_pct, s.exhausted_hour, s.hour_source, s.note, s.src
    from (
      select
        case when btrim(coalesce(r ->> 'day', '')) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
             then btrim(r ->> 'day')::date end                     as day,
        btrim(coalesce(r ->> 'campaignId', ''))                    as campaign_id,
        case lower(btrim(coalesce(r ->> 'eventType', '')))
          when 'capped'             then 'capped'
          when 'exhausted_suspected' then 'exhausted_suspected'
          when 'under_delivery'     then 'under_delivery'
          when 'budget_increased'   then 'budget_increased'
          else null end                                            as event_type,
        btrim(coalesce(r ->> 'adsProfileId', ''))                  as profile_id,
        finance.num_or_null(r ->> 'budgetAmount')                  as budget_amount,
        nullif(upper(btrim(coalesce(r ->> 'currency', ''))), '')   as currency,
        finance.num_or_null(r ->> 'cost')                          as cost,
        finance.num_or_null(r ->> 'usagePct')                      as usage_pct,
        case when btrim(coalesce(r ->> 'exhaustedHour', '')) ~ '^([0-9]|1[0-9]|2[0-3])$'
             then btrim(r ->> 'exhaustedHour')::int end            as exhausted_hour,
        case lower(btrim(coalesce(r ->> 'hourSource', '')))
          when 'report'            then 'report'
          when 'marketing_stream'  then 'marketing_stream'
          else 'unavailable' end                                   as hour_source,
        nullif(btrim(coalesce(r ->> 'note', '')), '')              as note,
        coalesce(nullif(btrim(coalesce(r ->> 'source', '')), ''), 'derived') as src
      from jsonb_array_elements(p_rows) r
    ) s
    where s.day is not null and s.campaign_id <> '' and s.event_type is not null
    order by s.day, s.campaign_id, s.event_type, s.src
  ) g;

  v_valid := jsonb_array_length(v_clean);

  select count(*) into v_upd
  from jsonb_array_elements(v_clean) e
  where exists (
    select 1 from ads.budget_events x
     where x.seller_account_id = p_seller
       and x.day = (e ->> 'day')::date
       and x.campaign_id = e ->> 'campaignId'
       and x.event_type  = e ->> 'eventType'
  );

  insert into ads.budget_events as t (
    seller_account_id, ads_profile_id, day, campaign_id, event_type, budget_amount,
    currency, cost, usage_pct, exhausted_hour, hour_source, note, source, detected_at, updated_at
  )
  select
    p_seller, coalesce(e ->> 'profileId', ''), (e ->> 'day')::date, e ->> 'campaignId',
    e ->> 'eventType', nullif(e ->> 'budgetAmount', '')::numeric,
    nullif(e ->> 'currency', ''), nullif(e ->> 'cost', '')::numeric,
    nullif(e ->> 'usagePct', '')::numeric,
    nullif(e ->> 'exhaustedHour', '')::int,
    coalesce(nullif(e ->> 'hourSource', ''), 'unavailable'),
    nullif(e ->> 'note', ''), coalesce(nullif(e ->> 'src', ''), 'derived'), now(), now()
  from jsonb_array_elements(v_clean) e
  on conflict (seller_account_id, day, campaign_id, event_type) do update set
    ads_profile_id = coalesce(nullif(excluded.ads_profile_id, ''), t.ads_profile_id),
    budget_amount  = coalesce(excluded.budget_amount, t.budget_amount),
    currency       = coalesce(excluded.currency, t.currency),
    cost           = coalesce(excluded.cost, t.cost),
    usage_pct      = coalesce(excluded.usage_pct, t.usage_pct),
    exhausted_hour = coalesce(excluded.exhausted_hour, t.exhausted_hour),
    hour_source    = excluded.hour_source,
    note           = coalesce(excluded.note, t.note),
    source         = excluded.source,
    updated_at     = excluded.updated_at;

  get diagnostics v_rows = row_count;

  return query select greatest(v_rows - v_upd, 0), v_upd, greatest(v_total - v_valid, 0);
end;
$$;

comment on function public.vexim_worker_upsert_ads_budget_events(uuid, jsonb) is
  'Nhập sự kiện ngân sách (worker suy từ cost/ngân sách ngày) — chỉ service_role. '
  'Idempotent theo (shop, ngày, campaign, loại sự kiện). exhaustedHour NULL = chưa biết giờ '
  '(Reporting API v3 không trả dữ liệu theo giờ) — KHÔNG đoán.';

-- ---------------------------------------------------------------------------
-- 17.6 Gợi ý negative keyword (A3 · SOP-04 bước 2–4)
-- ---------------------------------------------------------------------------
create or replace function public.vexim_worker_upsert_ads_suggestions(
  p_seller uuid,
  p_rows   jsonb
)
returns table (inserted int, updated int, skipped int, kept int)
language plpgsql
security definer
set search_path = ads, finance, public, pg_catalog
as $$
declare
  v_clean jsonb;
  v_total int;
  v_valid int;
  v_upd   int := 0;
  v_kept  int := 0;
  v_rows  int := 0;
begin
  perform ads.assert_worker(p_seller, p_rows);
  v_total := jsonb_array_length(p_rows);

  select coalesce(jsonb_agg(jsonb_build_object(
           'campaignId', g.campaign_id, 'adGroupId', g.ad_group_id, 'term', g.term,
           'matchType', g.match_type, 'keywordId', g.keyword_id, 'keywordText', g.keyword_text,
           'targetKind', g.target_kind, 'suggestionType', g.suggestion_type,
           'confidence', g.confidence, 'confidenceLabel', g.confidence_label,
           'windowDays', g.window_days, 'evidence', g.evidence, 'reasons', g.reasons,
           'profileId', g.profile_id, 'src', g.src)), '[]'::jsonb)
    into v_clean
  from (
    select distinct on (s.campaign_id, s.ad_group_id, s.term, s.match_type, s.suggestion_type, s.window_days)
           s.campaign_id, s.ad_group_id, s.term, s.match_type, s.keyword_id, s.keyword_text,
           s.target_kind, s.suggestion_type, s.confidence, s.confidence_label, s.window_days,
           s.evidence, s.reasons, s.profile_id, s.src
    from (
      select
        btrim(coalesce(r ->> 'campaignId', ''))                    as campaign_id,
        btrim(coalesce(r ->> 'adGroupId', ''))                     as ad_group_id,
        lower(btrim(coalesce(r ->> 'term', '')))                   as term,
        upper(btrim(coalesce(r ->> 'matchType', '')))              as match_type,
        btrim(coalesce(r ->> 'keywordId', ''))                     as keyword_id,
        nullif(btrim(coalesce(r ->> 'keywordText', '')), '')       as keyword_text,
        case lower(btrim(coalesce(r ->> 'targetKind', '')))
          when 'keyword'        then 'keyword'
          when 'product_target' then 'product_target'
          else 'search_term' end                                   as target_kind,
        case lower(btrim(coalesce(r ->> 'suggestionType', '')))
          when 'negative_exact'  then 'negative_exact'
          when 'negative_phrase' then 'negative_phrase'
          when 'pause_keyword'   then 'pause_keyword'
          when 'lower_bid'       then 'lower_bid'
          else null end                                            as suggestion_type,
        case when btrim(coalesce(r ->> 'confidence', '')) ~ '^[0-9]+(\.[0-9]+)?$'
             then least(greatest(btrim(r ->> 'confidence')::numeric, 0), 1) end as confidence,
        nullif(btrim(coalesce(r ->> 'confidenceLabel', '')), '')   as confidence_label,
        coalesce(ads.int_or_null(r ->> 'windowDays'), 14)          as window_days,
        case when jsonb_typeof(r -> 'evidence') = 'object' then r -> 'evidence' end as evidence,
        case when jsonb_typeof(r -> 'reasons')  = 'array'  then r -> 'reasons' end  as reasons,
        btrim(coalesce(r ->> 'adsProfileId', ''))                  as profile_id,
        coalesce(nullif(btrim(coalesce(r ->> 'source', '')), ''), 'rule') as src
      from jsonb_array_elements(p_rows) r
    ) s
    where s.suggestion_type is not null
      and (s.term <> '' or s.keyword_id <> '')
    order by s.campaign_id, s.ad_group_id, s.term, s.match_type, s.suggestion_type,
             s.window_days, s.src
  ) g;

  v_valid := jsonb_array_length(v_clean);

  -- Dòng đã được con người quyết (status <> 'pending') KHÔNG bị worker ghi đè.
  select count(*) into v_kept
  from jsonb_array_elements(v_clean) e
  where exists (
    select 1 from ads.negative_suggestions x
     where x.seller_account_id = p_seller
       and x.campaign_id = e ->> 'campaignId'
       and x.ad_group_id = e ->> 'adGroupId'
       and x.term        = e ->> 'term'
       and x.match_type  = e ->> 'matchType'
       and x.suggestion_type = e ->> 'suggestionType'
       and x.window_days = (e ->> 'windowDays')::int
       and x.status <> 'pending'
  );

  select count(*) into v_upd
  from jsonb_array_elements(v_clean) e
  where exists (
    select 1 from ads.negative_suggestions x
     where x.seller_account_id = p_seller
       and x.campaign_id = e ->> 'campaignId'
       and x.ad_group_id = e ->> 'adGroupId'
       and x.term        = e ->> 'term'
       and x.match_type  = e ->> 'matchType'
       and x.suggestion_type = e ->> 'suggestionType'
       and x.window_days = (e ->> 'windowDays')::int
       and x.status = 'pending'
  );

  insert into ads.negative_suggestions as t (
    seller_account_id, ads_profile_id, campaign_id, ad_group_id, keyword_id, keyword_text,
    term, match_type, target_kind, suggestion_type, confidence, confidence_label,
    window_days, evidence, reasons, status, source, generated_at, updated_at
  )
  select
    p_seller, coalesce(e ->> 'profileId', ''), e ->> 'campaignId', e ->> 'adGroupId',
    coalesce(e ->> 'keywordId', ''), nullif(e ->> 'keywordText', ''),
    e ->> 'term', coalesce(e ->> 'matchType', ''), e ->> 'targetKind',
    e ->> 'suggestionType', nullif(e ->> 'confidence', '')::numeric,
    nullif(e ->> 'confidenceLabel', ''),
    (e ->> 'windowDays')::int,
    case when e ->> 'evidence' = '' then null else (e ->> 'evidence')::jsonb end,
    case when e ->> 'reasons'  = '' then null else (e ->> 'reasons')::jsonb end,
    'pending', coalesce(nullif(e ->> 'src', ''), 'rule'), now(), now()
  from jsonb_array_elements(v_clean) e
  on conflict (seller_account_id, campaign_id, ad_group_id, term, match_type, suggestion_type, window_days)
  do update set
    keyword_id       = coalesce(nullif(excluded.keyword_id, ''), t.keyword_id),
    keyword_text     = coalesce(excluded.keyword_text, t.keyword_text),
    target_kind      = excluded.target_kind,
    confidence       = coalesce(excluded.confidence, t.confidence),
    confidence_label = coalesce(excluded.confidence_label, t.confidence_label),
    evidence         = coalesce(excluded.evidence, t.evidence),
    reasons          = coalesce(excluded.reasons, t.reasons),
    source           = excluded.source,
    updated_at       = excluded.updated_at
  where t.status = 'pending';   -- quyết định của con người là BẤT KHẢ XÂM PHẠM

  get diagnostics v_rows = row_count;

  return query
    select greatest(v_rows - v_upd, 0), v_upd, greatest(v_total - v_valid, 0), v_kept;
end;
$$;

comment on function public.vexim_worker_upsert_ads_suggestions(uuid, jsonb) is
  'Nhập/refresh gợi ý negative keyword — chỉ service_role. Ràng buộc: chỉ ghi dòng còn '
  '''pending''; dòng đã approve/reject/dismissed giữ nguyên (đếm ở cột `kept`).';

-- ---------------------------------------------------------------------------
-- 17.7 LẤP ads_spend vào F4 (finance.sku_profit_daily)
-- ---------------------------------------------------------------------------
-- Vì sao là RPC riêng, không ghi thẳng: F4 do luồng tài chính (0015) tính; ads chỉ
-- được ĐIỀN ĐÚNG MỘT CỘT `ads_spend` và CHỈ cho (shop, ngày, sku, tiền tệ) đã tồn
-- tại. Không tự tạo dòng lợi nhuận (thiếu doanh thu/giá vốn thì con số vô nghĩa),
-- không cộng tiền khác tiền tệ (ads USD không được nhét vào dòng CAD).
create or replace function public.vexim_worker_apply_ads_spend(
  p_seller uuid,
  p_from   date,
  p_to     date
)
returns table (updated int, skipped_no_row int, skipped_currency int)
language plpgsql
security definer
set search_path = finance, ads, public, pg_catalog
as $$
declare
  v_upd   int := 0;
  v_norow int := 0;
  v_curr  int := 0;
begin
  if auth.uid() is not null then
    raise exception '[M5-ADS] RPC này chỉ dành cho worker (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_seller is null or p_from is null or p_to is null then
    raise exception '[M5-ADS] thiếu seller_account_id / p_from / p_to'
      using errcode = 'invalid_parameter_value';
  end if;

  -- SKU của dòng quảng cáo: ưu tiên advertised_sku; thiếu thì suy qua ASIN từ
  -- catalog.listings (cùng cách 0019 suy SKU cho report phí — có nhãn nguồn ở view).
  create temporary table if not exists _ads_sku_spend (
    day date, sku text, currency text, cost numeric
  ) on commit drop;
  delete from _ads_sku_spend;

  insert into _ads_sku_spend (day, sku, currency, cost)
  select a.day,
         coalesce(nullif(a.advertised_sku, ''), l.sku) as sku,
         a.currency,
         sum(a.cost)                                   as cost
  from ads.advertised_product_metrics_daily a
  left join lateral (
    select cl.sku
    from catalog.listings cl
    where cl.seller_account_id = a.seller_account_id
      and cl.asin = a.advertised_asin
      and cl.sku is not null
    order by cl.last_synced_at desc nulls last
    limit 1
  ) l on true
  where a.seller_account_id = p_seller
    and a.day between p_from and p_to
    and a.cost is not null
  group by 1, 2, 3;

  select count(*) into v_norow
  from _ads_sku_spend s
  where s.sku is not null
    and not exists (
      select 1 from finance.sku_profit_daily p
       where p.seller_account_id = p_seller and p.day = s.day and p.sku = s.sku
    );

  select count(*) into v_curr
  from _ads_sku_spend s
  where s.sku is not null
    and s.currency is not null
    and exists (
      select 1 from finance.sku_profit_daily p
       where p.seller_account_id = p_seller and p.day = s.day and p.sku = s.sku
    )
    and not exists (
      select 1 from finance.sku_profit_daily p
       where p.seller_account_id = p_seller and p.day = s.day and p.sku = s.sku
         and p.currency = s.currency
    );

  update finance.sku_profit_daily p
     set ads_spend = s.cost,
         computed_at = now()
  from _ads_sku_spend s
  where s.sku is not null
    and s.currency is not null
    and p.seller_account_id = p_seller
    and p.day = s.day
    and p.sku = s.sku
    and p.currency = s.currency;

  get diagnostics v_upd = row_count;

  return query select v_upd, v_norow, v_curr;
end;
$$;

comment on function public.vexim_worker_apply_ads_spend(uuid, date, date) is
  'Lấp finance.sku_profit_daily.ads_spend từ report spAdvertisedProduct trong khoảng ngày — '
  'chỉ service_role. CHỈ cập nhật dòng đã có (không tạo dòng lợi nhuận) và CHỈ cùng tiền tệ '
  '(trả về số dòng bị bỏ vì khác tiền tệ để log nói rõ, không im lặng).';

-- ============================================================================
-- 18. RPC WORKER — LUỒNG RE-AUTHORIZE (SOP-11)
-- ============================================================================
-- Vì sao cần: role Ads (và các role mới khác) KHÔNG dùng được refresh token cũ —
-- Amazon chỉ cấp scope mới khi shop authorize lại. Luồng thật:
--   start   → sinh `state` dùng một lần + dựng login URI
--   callback→ đổi code lấy refresh token, gọi vexim_worker_set_oauth_token
--   nhắc    → cron đọc view vexim_oauth_connections (days_left <= notice_days)
create or replace function public.vexim_worker_set_oauth_token(
  p_seller uuid,
  p_token  jsonb
)
returns table (id uuid, authorized_at timestamptz, expires_at timestamptz,
               days_left int, refresh_count int, replaced boolean)
language plpgsql
security definer
set search_path = connections, public, pg_catalog
as $$
declare
  v_token   text;
  v_scope   text;
  v_auth    timestamptz;
  v_expires timestamptz;
  v_notice  int;
  v_by      uuid;
  v_id      uuid;
  v_count   int := 0;
  v_replace boolean := false;
begin
  if auth.uid() is not null then
    raise exception '[OAUTH] RPC này chỉ dành cho server (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_seller is null or p_token is null then
    raise exception '[OAUTH] thiếu seller_account_id hoặc payload'
      using errcode = 'invalid_parameter_value';
  end if;

  v_token := btrim(coalesce(p_token ->> 'refreshToken', ''));
  if v_token = '' then
    raise exception '[OAUTH] thiếu refreshToken — không lưu token rỗng'
      using errcode = 'invalid_parameter_value';
  end if;

  v_scope := nullif(btrim(coalesce(p_token ->> 'authScope', '')), '');
  v_auth  := coalesce(
    nullif(btrim(coalesce(p_token ->> 'authorizedAt', '')), '')::timestamptz,
    now()
  );
  -- LWA refresh token sống 365 ngày kể từ lúc authorize (Amazon không trả expires_in
  -- cho refresh token) — cho phép ghi đè nếu Amazon đổi chính sách.
  v_expires := coalesce(
    nullif(btrim(coalesce(p_token ->> 'expiresAt', '')), '')::timestamptz,
    v_auth + interval '365 days'
  );
  v_notice := coalesce(ads.int_or_null(p_token ->> 'noticeDays'), 30);
  if v_notice < 1 or v_notice > 120 then v_notice := 30; end if;

  if btrim(coalesce(p_token ->> 'connectedBy', '')) ~
     '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    v_by := btrim(p_token ->> 'connectedBy')::uuid;
  end if;

  select exists (select 1 from connections.oauth_tokens t where t.seller_account_id = p_seller)
    into v_replace;

  insert into connections.oauth_tokens as t (
    seller_account_id, encrypted_refresh_token, authorized_at, expires_at,
    rotate_reminder_sent, auth_scope, connected_by, notice_days,
    notice_sent_at, last_refresh_at, refresh_count, revoked_at, updated_at
  )
  values (
    p_seller, v_token, v_auth, v_expires,
    false, v_scope, v_by, v_notice,
    null, now(), 1, null, now()
  )
  on conflict (seller_account_id) do update set
    encrypted_refresh_token = excluded.encrypted_refresh_token,
    authorized_at           = excluded.authorized_at,
    expires_at              = excluded.expires_at,
    -- authorize LẠI là mốc mới ⇒ phải nhắc lại từ đầu, không giữ cờ cũ
    rotate_reminder_sent    = false,
    notice_sent_at          = null,
    auth_scope              = coalesce(excluded.auth_scope, t.auth_scope),
    connected_by            = coalesce(excluded.connected_by, t.connected_by),
    notice_days             = excluded.notice_days,
    last_refresh_at         = now(),
    refresh_count           = t.refresh_count + 1,
    revoked_at              = null,
    updated_at              = now()
  returning t.id, t.refresh_count into v_id, v_count;

  return query
    select v_id,
           (select t.authorized_at from connections.oauth_tokens t where t.id = v_id),
           (select t.expires_at from connections.oauth_tokens t where t.id = v_id),
           (select greatest(extract(day from (t.expires_at - now()))::int, 0)
              from connections.oauth_tokens t where t.id = v_id),
           v_count,
           v_replace;
end;
$$;

comment on function public.vexim_worker_set_oauth_token(uuid, jsonb) is
  'Lưu refresh token LWA sau khi shop authorize (callback OAuth) — chỉ service_role. '
  'Ghi đè thì reset cờ nhắc re-auth và tăng refresh_count. KHÔNG nhận token rỗng.';

create or replace function public.vexim_worker_create_oauth_state(
  p_seller      uuid,
  p_redirect_to text default null,
  p_ttl_minutes int  default 30
)
returns table (state text, expires_at timestamptz)
language plpgsql
security definer
set search_path = connections, public, pg_catalog
as $$
declare
  v_state   text;
  v_expires timestamptz;
  v_ttl     int := coalesce(p_ttl_minutes, 30);
begin
  if auth.uid() is not null then
    raise exception '[OAUTH] RPC này chỉ dành cho server (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_seller is null then
    raise exception '[OAUTH] thiếu seller_account_id' using errcode = 'invalid_parameter_value';
  end if;
  if v_ttl < 1 or v_ttl > 1440 then v_ttl := 30; end if;

  v_state := encode(gen_random_bytes(24), 'hex');
  v_expires := now() + make_interval(mins => v_ttl);

  insert into connections.oauth_states (state, seller_account_id, redirect_to, expires_at)
  values (v_state, p_seller, nullif(btrim(coalesce(p_redirect_to, '')), ''), v_expires);

  return query select v_state, v_expires;
end;
$$;

comment on function public.vexim_worker_create_oauth_state(uuid, text, int) is
  'Sinh state dùng một lần cho luồng authorize LWA — chỉ service_role (chống CSRF).';

create or replace function public.vexim_worker_consume_oauth_state(p_state text)
returns table (seller_account_id uuid, redirect_to text, ok boolean, message text)
language plpgsql
security definer
set search_path = connections, public, pg_catalog
as $$
declare
  v_state text := btrim(coalesce(p_state, ''));
  v_row   connections.oauth_states%rowtype;
begin
  if auth.uid() is not null then
    raise exception '[OAUTH] RPC này chỉ dành cho server (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if v_state = '' then
    return query select null::uuid, null::text, false, 'thiếu state';
    return;
  end if;

  select * into v_row from connections.oauth_states s where s.state = v_state for update;
  if not found then
    -- Trả ok=false thay vì ném lỗi: callback phải hiển thị được thông báo cho người dùng.
    return query select null::uuid, null::text, false, 'state không tồn tại (link cũ hoặc bị sửa)';
    return;
  end if;
  if v_row.used_at is not null then
    return query select null::uuid, null::text, false, 'state đã được dùng rồi';
    return;
  end if;
  if v_row.expires_at < now() then
    return query select null::uuid, null::text, false, 'state đã hết hạn — bấm Kết nối lại';
    return;
  end if;

  update connections.oauth_states s set used_at = now() where s.id = v_row.id;

  return query select v_row.seller_account_id, v_row.redirect_to, true, 'ok';
end;
$$;

comment on function public.vexim_worker_consume_oauth_state(text) is
  'Đọc + đánh dấu đã dùng state OAuth (một lần) — chỉ service_role. Trả ok=false kèm lý do '
  'thay vì ném lỗi để callback hiển thị được thông báo.';

create or replace function public.vexim_worker_mark_oauth_notice(p_seller uuid)
returns table (notice_sent_at timestamptz, rotate_reminder_sent boolean)
language plpgsql
security definer
set search_path = connections, public, pg_catalog
as $$
declare
  v_sent timestamptz := now();
  v_flag boolean;
begin
  if auth.uid() is not null then
    raise exception '[OAUTH] RPC này chỉ dành cho server (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_seller is null then
    raise exception '[OAUTH] thiếu seller_account_id' using errcode = 'invalid_parameter_value';
  end if;

  update connections.oauth_tokens t
     set notice_sent_at = v_sent, rotate_reminder_sent = true, updated_at = now()
   where t.seller_account_id = p_seller
  returning t.rotate_reminder_sent into v_flag;

  if not found then
    raise exception '[OAUTH] không có token đang hoạt động cho shop %', p_seller
      using errcode = 'no_data_found';
  end if;

  return query select v_sent, coalesce(v_flag, true);
end;
$$;

comment on function public.vexim_worker_mark_oauth_notice(uuid) is
  'Đánh dấu đã nhắc re-authorize cho shop (cron gọi 1 lần/ngày) — chỉ service_role.';

-- ---------------------------------------------------------------------------
-- 18.6 vexim_worker_oauth_soon — cron nhắc re-authorize đọc được
-- ---------------------------------------------------------------------------
-- Vì sao cần RPC riêng: view vexim_oauth_connections lọc theo
-- iam.can_read_seller_account(), mà hàm đó dựa vào auth.uid() ⇒ service_role
-- (auth.uid() = null) đọc view ra 0 dòng. Worker đọc bảng gốc thì được (bỏ qua
-- RLS) nhưng luật "còn ≤ notice_days ngày là phải nhắc" phải nằm ở DB, không
-- rải ra JS. Vậy nên: đúng một RPC cho cron.
create or replace function public.vexim_worker_oauth_soon(p_days int default null)
returns table (
  seller_account_id uuid,
  shop              text,
  seller_id         text,
  marketplace       text,
  authorized_at     timestamptz,
  expires_at        timestamptz,
  days_left         int,
  notice_days       int,
  needs_reauth      boolean,
  already_noticed   boolean,
  token_active      boolean,
  ads_profiles      int
)
language plpgsql
security definer
set search_path = connections, ads, public, pg_catalog
as $$
begin
  if auth.uid() is not null then
    raise exception '[OAUTH] RPC này chỉ dành cho server (service_role)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_days is not null and p_days < 0 then
    raise exception '[OAUTH] p_days không được âm'
      using errcode = 'invalid_parameter_value';
  end if;

  return query
  select t.seller_account_id,
         sa.display_name,
         sa.seller_id,
         sa.marketplace,
         t.authorized_at,
         t.expires_at,
         greatest(extract(day from (t.expires_at - now()))::int, 0),
         t.notice_days,
         (t.expires_at <= now() + make_interval(days => t.notice_days)),
         coalesce(t.rotate_reminder_sent, false),
         (t.revoked_at is null and t.expires_at > now()),
         (select count(*)::int from ads.ad_profiles p
           where p.seller_account_id = t.seller_account_id)
  from connections.oauth_tokens t
  join connections.seller_accounts sa on sa.id = t.seller_account_id
  where t.expires_at <= now() + make_interval(days => coalesce(p_days, t.notice_days))
  order by t.expires_at, t.seller_account_id;
end;
$$;

comment on function public.vexim_worker_oauth_soon(int) is
  'Shop sắp/đã hết hạn refresh token trong vòng notice_days (hoặc p_days chỉ định) để cron '
  'gửi nhắc re-authorize — chỉ service_role. Trả days_left, already_noticed (đã nhắc chưa) '
  'và số profile Ads đã nối, KHÔNG trả token.';

-- ============================================================================
-- 19. VIEWS
-- ============================================================================
-- ---------------------------------------------------------------------------
-- 19.0 vexim_oauth_connections — TRẠNG THÁI token cho màn Kết nối shop
-- ---------------------------------------------------------------------------
-- ⚠️ ĐÂY LÀ VIEW DUY NHẤT TRONG REPO CỐ Ý KHÔNG ĐẶT `security_invoker`:
--    connections.oauth_tokens KHÔNG có policy RLS nào (chỉ service_role đọc) nên
--    một view security_invoker sẽ trả 0 dòng cho mọi người dùng web — trang Kết
--    nối shop không thể hiển thị "token còn 20 ngày" nữa. View này vì vậy:
--      • KHÔNG chọn cột token (chỉ metadata: thời hạn, scope, cờ nhắc),
--      • LỌC TƯỜNG MINH bằng iam.can_read_seller_account(seller_account_id).
--    Self-check cuối migration khẳng định view không chứa cột token và vẫn lọc
--    theo quyền — nếu ai thêm cột token vào đây, migration FAIL ngay.
create or replace view public.vexim_oauth_connections as
select
  t.seller_account_id,
  sa.display_name   as shop,
  sa.seller_id,
  sa.marketplace,
  sa.status         as shop_status,
  sa.data_source,
  t.auth_scope,
  t.authorized_at,
  t.expires_at,
  greatest(extract(day from (t.expires_at - now()))::int, 0) as days_left,
  (t.expires_at <= now())                                    as is_expired,
  (t.expires_at <= now() + make_interval(days => t.notice_days)) as needs_reauth,
  t.notice_days,
  t.rotate_reminder_sent,
  t.notice_sent_at,
  t.last_refresh_at,
  t.refresh_count,
  t.revoked_at,
  (t.revoked_at is null and t.expires_at > now())            as is_active,
  (select count(*) from ads.ad_profiles p where p.seller_account_id = t.seller_account_id) as ads_profiles
from connections.oauth_tokens t
join connections.seller_accounts sa on sa.id = t.seller_account_id
where iam.can_read_seller_account(t.seller_account_id);

comment on view public.vexim_oauth_connections is
  'Trạng thái kết nối (token) của shop cho màn Module 0 → Kết nối shop: hạn token, số ngày còn '
  'lại, có cần re-auth không (needs_reauth khi còn ≤ notice_days ngày), có profile Ads chưa. '
  'KHÔNG chứa token. Lọc theo iam.can_read_seller_account (view cố ý không security_invoker).';

-- ---------------------------------------------------------------------------
-- 19.1 vexim_ads_profiles
-- ---------------------------------------------------------------------------
create or replace view public.vexim_ads_profiles
with (security_invoker = true) as
with last_day as (
  select m.seller_account_id, max(m.day) as day
  from ads.ad_metrics_daily m
  group by 1
)
select
  p.seller_account_id,
  sa.display_name as shop,
  p.ads_profile_id,
  p.marketplace,
  p.currency,
  p.country_code,
  p.account_type,
  p.manager_account_id,
  (select count(*) from ads.campaigns c
    where c.seller_account_id = p.seller_account_id
      and c.ads_profile_id = p.ads_profile_id)                     as campaigns_count,
  (select sum(m.cost) from ads.ad_metrics_daily m
    join last_day ld on ld.seller_account_id = m.seller_account_id
    where m.seller_account_id = p.seller_account_id
      and m.ad_profile_id = p.ads_profile_id
      and m.day > ld.day - 7)                                      as spend_7d,
  (select max(m.day) from ads.ad_metrics_daily m
    where m.seller_account_id = p.seller_account_id
      and m.ad_profile_id = p.ads_profile_id)                      as last_metric_day,
  p.last_synced_at,
  p.updated_at
from ads.ad_profiles p
join connections.seller_accounts sa on sa.id = p.seller_account_id;

comment on view public.vexim_ads_profiles is
  'Profile Ads của shop (màn Kết nối shop + A1): campaign đã đồng bộ, chi tiêu 7 ngày, ngày có số mới nhất.';

-- ---------------------------------------------------------------------------
-- 19.2 vexim_ads_campaigns — A1 (bảng campaign + ACOS 7/14/30 + ngân sách)
-- ---------------------------------------------------------------------------
create or replace view public.vexim_ads_campaigns
with (security_invoker = true) as
with last_day as (
  select seller_account_id, max(day) as day
  from ads.ad_metrics_daily
  group by 1
),
agg as (
  select
    m.seller_account_id,
    m.campaign_id,
    m.currency,
    max(m.day)                                                as last_metric_day,
    sum(m.cost)     filter (where m.day = ld.day)             as spend_yesterday,
    sum(m.cost)     filter (where m.day > ld.day - 7)         as spend_7d,
    sum(m.cost)     filter (where m.day > ld.day - 14)        as spend_14d,
    sum(m.cost)     filter (where m.day > ld.day - 30)        as spend_30d,
    sum(m.sales_7d) filter (where m.day > ld.day - 7)         as sales_7d,
    sum(m.sales_14d) filter (where m.day > ld.day - 14)       as sales_14d,
    sum(m.sales_30d) filter (where m.day > ld.day - 30)       as sales_30d,
    sum(m.purchases_7d) filter (where m.day > ld.day - 7)     as purchases_7d,
    sum(m.units_sold_clicks_7d) filter (where m.day > ld.day - 7) as units_7d,
    sum(m.clicks)   filter (where m.day > ld.day - 7)         as clicks_7d,
    sum(m.impressions) filter (where m.day > ld.day - 7)      as impressions_7d
  from ads.ad_metrics_daily m
  join last_day ld on ld.seller_account_id = m.seller_account_id
  group by 1, 2, 3
),
capped as (
  select
    e.seller_account_id,
    e.campaign_id,
    count(*) filter (where e.day > (select max(x.day) from ads.budget_events x
                                     where x.seller_account_id = e.seller_account_id) - 30)
      as capped_days_30d,
    max(e.day) as last_capped_day
  from ads.budget_events e
  where e.event_type in ('capped', 'exhausted_suspected')
  group by 1, 2
)
select
  c.seller_account_id,
  sa.display_name as shop,
  c.ads_profile_id,
  c.campaign_id,
  c.campaign_type,
  c.name,
  c.state,
  c.targeting_type,
  c.portfolio_id,
  c.daily_budget,
  coalesce(c.budget_currency, a.currency) as currency,
  c.start_date,
  c.end_date,
  a.last_metric_day as last_day,
  a.spend_yesterday,
  a.spend_7d,
  a.spend_14d,
  a.spend_30d,
  a.sales_7d,
  a.sales_14d,
  a.sales_30d,
  a.purchases_7d,
  a.units_7d,
  a.clicks_7d,
  a.impressions_7d,
  round(a.spend_7d / nullif(a.clicks_7d, 0), 2)              as cpc_7d,
  round(a.clicks_7d::numeric * 100 / nullif(a.impressions_7d, 0), 2) as ctr_7d,
  -- ACOS/ROAS SUY RA (v3 không có cột acos7d/roas7d). Mẫu số NULL ⇒ NULL, không bịa.
  round(a.spend_7d * 100 / nullif(a.sales_7d, 0), 2)         as acos_7d,
  round(a.spend_14d * 100 / nullif(a.sales_14d, 0), 2)       as acos_14d,
  round(a.spend_30d * 100 / nullif(a.sales_30d, 0), 2)       as acos_30d,
  round(a.sales_7d / nullif(a.spend_7d, 0), 2)               as roas_7d,
  round(a.spend_yesterday * 100 / nullif(c.daily_budget, 0), 1) as budget_usage_yesterday_pct,
  case
    when c.daily_budget is null or c.daily_budget <= 0 then 'unknown'
    when a.currency is not null and c.budget_currency is not null
         and a.currency <> c.budget_currency then 'unknown'   -- không so tiền khác tiền tệ
    when a.spend_yesterday is null then 'no_data'
    when a.spend_yesterday >= 0.95 * c.daily_budget then 'capped'
    else 'ok'
  end as budget_state,
  coalesce(cp.capped_days_30d, 0) as capped_days_30d,
  cp.last_capped_day,
  c.last_synced_at,
  c.updated_at
from ads.campaigns c
join connections.seller_accounts sa on sa.id = c.seller_account_id
left join agg a on a.seller_account_id = c.seller_account_id and a.campaign_id = c.campaign_id
left join capped cp on cp.seller_account_id = c.seller_account_id and cp.campaign_id = c.campaign_id;

comment on view public.vexim_ads_campaigns is
  'A1 — campaign + spend hôm qua/7/14/30 ngày, ACOS 7/14/30 & ROAS 7 (SUY RA từ cost ÷ sales vì '
  'v3 không trả cột acos), trạng thái ngân sách (capped khi chi ≥ 95% ngân sách ngày). '
  'Mẫu số không đọc được ⇒ NULL, không hiển thị 0 giả.';

-- ---------------------------------------------------------------------------
-- 19.3 vexim_ads_targets — A2 (ad group → keyword/target)
-- ---------------------------------------------------------------------------
create or replace view public.vexim_ads_targets
with (security_invoker = true) as
with last_day as (
  select seller_account_id, max(day) as day
  from ads.target_metrics_daily
  group by 1
),
agg as (
  select
    m.seller_account_id, m.ad_group_id, m.target_kind, m.target_key, m.match_type,
    m.campaign_id, m.currency,
    max(m.day)                                                  as last_metric_day,
    sum(m.cost)     filter (where m.day > ld.day - 7)           as spend_7d,
    sum(m.sales_7d) filter (where m.day > ld.day - 7)           as sales_7d,
    sum(m.purchases_7d) filter (where m.day > ld.day - 7)       as purchases_7d,
    sum(m.units_sold_clicks_7d) filter (where m.day > ld.day - 7) as units_7d,
    sum(m.clicks)   filter (where m.day > ld.day - 7)           as clicks_7d,
    sum(m.impressions) filter (where m.day > ld.day - 7)        as impressions_7d,
    max(m.currency)                                             as metric_currency
  from ads.target_metrics_daily m
  join last_day ld on ld.seller_account_id = m.seller_account_id
  group by 1, 2, 3, 4, 5, 6, 7
)
select
  t.seller_account_id,
  sa.display_name as shop,
  t.ads_profile_id,
  t.campaign_id,
  c.name          as campaign_name,
  t.ad_group_id,
  g.name          as ad_group_name,
  t.target_kind,
  t.target_key,
  t.keyword_text,
  t.match_type,
  t.expression_type,
  t.expression_value,
  t.bid,
  t.state,
  coalesce(g.currency, t.currency, a.metric_currency) as currency,
  a.last_metric_day as last_day,
  a.spend_7d,
  a.sales_7d,
  a.purchases_7d,
  a.units_7d,
  a.clicks_7d,
  a.impressions_7d,
  round(a.spend_7d / nullif(a.clicks_7d, 0), 2)                    as cpc_7d,
  round(a.clicks_7d::numeric * 100 / nullif(a.impressions_7d, 0), 2) as ctr_7d,
  round(a.spend_7d * 100 / nullif(a.sales_7d, 0), 2)               as acos_7d,
  round(a.sales_7d / nullif(a.spend_7d, 0), 2)                     as roas_7d,
  t.updated_at
from ads.targets t
join connections.seller_accounts sa on sa.id = t.seller_account_id
left join ads.campaigns c
       on c.seller_account_id = t.seller_account_id and c.campaign_id = t.campaign_id
left join ads.ad_groups g
       on g.seller_account_id = t.seller_account_id and g.ad_group_id = t.ad_group_id
left join agg a
       on a.seller_account_id = t.seller_account_id
      and a.ad_group_id = t.ad_group_id
      and a.target_kind = t.target_kind
      and a.target_key  = t.target_key
      and a.match_type  = t.match_type;

comment on view public.vexim_ads_targets is
  'A2 — keyword/target của từng ad group (bid, state, match type) + metrics 7 ngày và ACOS/ROAS suy ra.';

-- ---------------------------------------------------------------------------
-- 19.4 vexim_ads_search_terms — A3
-- ---------------------------------------------------------------------------
create or replace view public.vexim_ads_search_terms
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
  sug.suggestion_type    as pending_suggestion_type,
  sug.confidence         as pending_confidence,
  sug.confidence_label   as pending_confidence_label
from agg a
join connections.seller_accounts sa on sa.id = a.seller_account_id
left join ads.campaigns c
       on c.seller_account_id = a.seller_account_id and c.campaign_id = a.campaign_id
left join ads.ad_groups g
       on g.seller_account_id = a.seller_account_id and g.ad_group_id = a.ad_group_id
left join lateral (
  select n.suggestion_type, n.confidence, n.confidence_label
  from ads.negative_suggestions n
  where n.seller_account_id = a.seller_account_id
    and n.campaign_id = a.campaign_id
    and n.ad_group_id = a.ad_group_id
    and n.term        = a.term
    and n.match_type  = a.match_type
    and n.status = 'pending'
  order by n.confidence desc nulls last
  limit 1
) sug on true;

comment on view public.vexim_ads_search_terms is
  'A3 — search term 7/14 ngày + cờ has_orders_7d (dấu hiệu đốt tiền) và GỢI Ý đang chờ duyệt '
  '(pending_suggestion_type · pending_confidence) để A3 hiển thị ngay mức tin cậy.';

-- ---------------------------------------------------------------------------
-- 19.5 vexim_ads_negative_suggestions
-- ---------------------------------------------------------------------------
create or replace view public.vexim_ads_negative_suggestions
with (security_invoker = true) as
select
  n.id,
  n.seller_account_id,
  sa.display_name as shop,
  n.ads_profile_id,
  n.campaign_id,
  c.name as campaign_name,
  n.ad_group_id,
  g.name as ad_group_name,
  n.keyword_id,
  n.keyword_text,
  n.term,
  n.match_type,
  n.target_kind,
  n.suggestion_type,
  n.confidence,
  n.confidence_label,
  n.window_days,
  n.evidence,
  n.reasons,
  n.status,
  n.decided_by,
  up.display_name as decided_by_name,
  n.decided_at,
  n.decision_note,
  n.applied_at,
  n.source,
  n.generated_at,
  n.updated_at,
  (current_date - n.generated_at::date) as age_days
from ads.negative_suggestions n
join connections.seller_accounts sa on sa.id = n.seller_account_id
left join ads.campaigns c
       on c.seller_account_id = n.seller_account_id and c.campaign_id = n.campaign_id
left join ads.ad_groups g
       on g.seller_account_id = n.seller_account_id and g.ad_group_id = n.ad_group_id
left join iam.user_profiles up on up.id = n.decided_by;

comment on view public.vexim_ads_negative_suggestions is
  'A3 — gợi ý negative keyword kèm mức tin cậy + trạng thái duyệt (pending/approved/rejected/'
  'applied/dismissed) và bằng chứng số trong `evidence`.';

-- ---------------------------------------------------------------------------
-- 19.6 vexim_ads_budget_events
-- ---------------------------------------------------------------------------
create or replace view public.vexim_ads_budget_events
with (security_invoker = true) as
select
  e.id,
  e.seller_account_id,
  sa.display_name as shop,
  e.ads_profile_id,
  e.day,
  e.campaign_id,
  c.name  as campaign_name,
  c.state as campaign_state,
  e.event_type,
  e.budget_amount,
  e.currency,
  e.cost,
  e.usage_pct,
  e.exhausted_hour,
  e.hour_source,
  (e.exhausted_hour is not null) as hour_known,
  e.note,
  e.detected_at
from ads.budget_events e
join connections.seller_accounts sa on sa.id = e.seller_account_id
left join ads.campaigns c
       on c.seller_account_id = e.seller_account_id and c.campaign_id = e.campaign_id;

comment on view public.vexim_ads_budget_events is
  'Ngân sách cạn theo ngày (capped / exhausted_suspected). `hour_known=false` nghĩa là biết CẠN '
  'nhưng chưa biết GIỜ — Reporting API v3 không có dữ liệu theo giờ (cần Amazon Marketing Stream).';

-- ---------------------------------------------------------------------------
-- 19.7 vexim_ads_sku_spend — chi tiêu ads theo SKU/ngày (F4 đối chiếu)
-- ---------------------------------------------------------------------------
create or replace view public.vexim_ads_sku_spend
with (security_invoker = true) as
with base as (
  select
    a.seller_account_id, a.day, a.currency,
    a.campaign_id, a.ad_group_id,
    nullif(a.advertised_sku, '') as advertised_sku,
    nullif(a.advertised_asin, '') as advertised_asin,
    a.cost, a.sales_7d, a.units_sold_clicks_7d,
    -- Suy SKU qua ASIN khi report không có SKU người bán (giống cách 0019 suy SKU cho phí FC)
    (select l.sku from catalog.listings l
      where l.seller_account_id = a.seller_account_id
        and l.asin = a.advertised_asin
      order by l.last_synced_at desc nulls last
      limit 1) as asin_sku
  from ads.advertised_product_metrics_daily a
)
select
  b.seller_account_id,
  sa.display_name as shop,
  b.day,
  coalesce(b.advertised_sku, b.asin_sku) as sku,
  case when b.advertised_sku is not null then 'advertised_sku'
       when b.asin_sku is not null then 'asin'
       else 'none' end as sku_source,
  b.advertised_asin as asin,
  b.currency,
  sum(b.cost)                    as cost,
  sum(b.sales_7d)                as sales_7d,
  sum(b.units_sold_clicks_7d)    as units_7d,
  count(distinct b.campaign_id)  as campaigns,
  max(b.campaign_id)             as top_campaign_id
from base b
join connections.seller_accounts sa on sa.id = b.seller_account_id
group by 1, 2, 3, 4, 5, 6, 7;

comment on view public.vexim_ads_sku_spend is
  'Chi tiêu ads theo SKU × ngày (nguồn để lấp finance.sku_profit_daily.ads_spend). '
  'sku_source nói rõ SKU lấy từ cột advertised_sku hay SUY RA qua ASIN hay chưa ánh xạ (none).';

-- ---------------------------------------------------------------------------
-- 19.8 vexim_ads_account_daily + vexim_ads_kpi — dashboard (spend · TACOS)
-- ---------------------------------------------------------------------------
create or replace view public.vexim_ads_account_daily
with (security_invoker = true) as
select
  m.seller_account_id,
  sa.display_name as shop,
  m.day,
  m.currency,
  sum(m.impressions)              as impressions,
  sum(m.clicks)                   as clicks,
  sum(m.cost)                     as cost,
  sum(m.sales_7d)                 as sales_7d,
  sum(m.sales_14d)                as sales_14d,
  sum(m.sales_30d)                as sales_30d,
  sum(m.purchases_7d)             as purchases_7d,
  sum(m.units_sold_clicks_7d)     as units_7d,
  round(sum(m.cost) / nullif(sum(m.clicks), 0), 2)                    as cpc,
  round(sum(m.clicks)::numeric * 100 / nullif(sum(m.impressions), 0), 2) as ctr,
  round(sum(m.cost) * 100 / nullif(sum(m.sales_7d), 0), 2)            as acos_7d,
  round(sum(m.sales_7d) / nullif(sum(m.cost), 0), 2)                  as roas_7d
from ads.ad_metrics_daily m
join connections.seller_accounts sa on sa.id = m.seller_account_id
group by 1, 2, 3, 4;

comment on view public.vexim_ads_account_daily is
  'Chi tiêu/quy đổi ads theo NGÀY và TIỀN TỆ (dashboard + biểu đồ). Không cộng chéo tiền tệ.';

create or replace view public.vexim_ads_kpi
with (security_invoker = true) as
with last_day as (
  select seller_account_id, max(day) as day
  from ads.ad_metrics_daily
  group by 1
),
agg as (
  select
    m.seller_account_id,
    m.currency,
    max(m.day) as last_day,
    sum(m.cost)        filter (where m.day > ld.day - 7)  as spend_7d,
    sum(m.cost)        filter (where m.day > ld.day - 14) as spend_14d,
    sum(m.cost)        filter (where m.day > ld.day - 30) as spend_30d,
    sum(m.sales_7d)    filter (where m.day > ld.day - 7)  as sales_7d,
    sum(m.sales_14d)   filter (where m.day > ld.day - 14) as sales_14d,
    sum(m.sales_30d)   filter (where m.day > ld.day - 30) as sales_30d,
    sum(m.purchases_7d) filter (where m.day > ld.day - 7) as purchases_7d,
    sum(m.units_sold_clicks_7d) filter (where m.day > ld.day - 7) as units_7d,
    sum(m.clicks)      filter (where m.day > ld.day - 7)  as clicks_7d,
    sum(m.impressions) filter (where m.day > ld.day - 7)  as impressions_7d
  from ads.ad_metrics_daily m
  join last_day ld on ld.seller_account_id = m.seller_account_id
  group by 1, 2
)
select
  a.seller_account_id,
  sa.display_name as shop,
  a.currency,
  a.last_day,
  a.spend_7d,
  a.spend_14d,
  a.spend_30d,
  a.sales_7d,
  a.sales_14d,
  a.sales_30d,
  a.purchases_7d,
  a.units_7d,
  a.clicks_7d,
  a.impressions_7d,
  round(a.spend_7d / nullif(a.clicks_7d, 0), 2)              as cpc_7d,
  round(a.spend_7d * 100 / nullif(a.sales_7d, 0), 2)         as acos_7d,
  round(a.spend_14d * 100 / nullif(a.sales_14d, 0), 2)       as acos_14d,
  round(a.spend_30d * 100 / nullif(a.sales_30d, 0), 2)       as acos_30d,
  round(a.sales_7d / nullif(a.spend_7d, 0), 2)               as roas_7d
from agg a
join connections.seller_accounts sa on sa.id = a.seller_account_id;

comment on view public.vexim_ads_kpi is
  'KPI quảng cáo theo shop × tiền tệ (7/14/30 ngày) — dashboard CEO đọc để tính TACOS thật '
  '(TACOS = spend_7d ÷ doanh thu sản phẩm 7 ngày; NULL khi thiếu một trong hai).';

-- ============================================================================
-- 20. GRANTS cho view + khoá quyền RPC về service_role
-- ============================================================================
grant select on
  public.vexim_oauth_connections,
  public.vexim_ads_profiles,
  public.vexim_ads_campaigns,
  public.vexim_ads_targets,
  public.vexim_ads_search_terms,
  public.vexim_ads_negative_suggestions,
  public.vexim_ads_budget_events,
  public.vexim_ads_sku_spend,
  public.vexim_ads_account_daily,
  public.vexim_ads_kpi
to authenticated, service_role;

revoke all on function ads.assert_worker(uuid, jsonb) from public, anon, authenticated;
grant  execute on function ads.assert_worker(uuid, jsonb) to service_role;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'vexim_worker_upsert_ads_profiles(uuid, jsonb)',
    'vexim_worker_upsert_ads_campaigns(uuid, jsonb)',
    'vexim_worker_upsert_ads_ad_groups(uuid, jsonb)',
    'vexim_worker_upsert_ads_targets(uuid, jsonb)',
    'vexim_worker_upsert_ads_campaign_metrics(uuid, jsonb)',
    'vexim_worker_upsert_ads_target_metrics(uuid, jsonb)',
    'vexim_worker_upsert_ads_search_terms(uuid, jsonb)',
    'vexim_worker_upsert_ads_product_metrics(uuid, text, jsonb)',
    'vexim_worker_upsert_ads_budget_events(uuid, jsonb)',
    'vexim_worker_upsert_ads_suggestions(uuid, jsonb)',
    'vexim_worker_apply_ads_spend(uuid, date, date)',
    'vexim_worker_set_oauth_token(uuid, jsonb)',
    'vexim_worker_create_oauth_state(uuid, text, int)',
    'vexim_worker_consume_oauth_state(text)',
    'vexim_worker_mark_oauth_notice(uuid)',
    'vexim_worker_oauth_soon(int)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', v_fn);
    execute format('grant execute on function public.%s to service_role', v_fn);
  end loop;
end $$;

-- ============================================================================
-- 21. TỰ KIỂM TRA
-- ============================================================================
do $$
declare
  n       int;
  v_fn    text;
  v_view  text;
  v_cols  text;
begin
  -- 21.1 bảy bảng ads mới + oauth_states đều bật RLS
  select count(*) into n
  from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
  where (ns.nspname, c.relname) in (
          ('ads','ad_groups'), ('ads','targets'), ('ads','target_metrics_daily'),
          ('ads','advertised_product_metrics_daily'), ('ads','purchased_product_metrics_daily'),
          ('ads','budget_events'), ('ads','negative_suggestions'),
          ('connections','oauth_states'))
    and c.relrowsecurity;
  if n <> 8 then
    raise exception '[0020] FAIL: thiếu bảng hoặc chưa bật RLS (%/8)', n;
  end if;

  -- 21.2 index unique khử trùng (nhập lại report không nhân đôi)
  select count(*) into n from pg_indexes
  where indexname in (
    'uq_ads_ad_groups_key','uq_ads_targets_key','uq_ads_target_metrics_key',
    'uq_ads_search_terms_key','uq_ads_advertised_product_key','uq_ads_purchased_product_key',
    'uq_ads_budget_events_key','uq_ads_negative_suggestions_key')
    and indexdef like '%UNIQUE%';
  if n <> 8 then
    raise exception '[0020] FAIL: thiếu index unique (%/8)', n;
  end if;

  -- 21.3 KHÔNG có policy ghi nào cho web trên bảng ads
  select count(*) into n
  from pg_policies
  where schemaname = 'ads' and cmd <> 'SELECT';
  if n <> 0 then
    raise exception '[0020] FAIL: có % policy ghi trên schema ads — web phải KHÔNG ghi được', n;
  end if;

  -- 21.4 Cột metrics v3 có mặt (tên đúng như report trả về, snake_case)
  foreach v_cols in array array['cost','sales_7d','sales_14d','sales_30d',
                                'units_sold_clicks_7d','purchases_7d','budget_amount'] loop
    select count(*) into n
    from information_schema.columns
    where table_schema = 'ads' and table_name = 'ad_metrics_daily' and column_name = v_cols;
    if n <> 1 then
      raise exception '[0020] FAIL: ads.ad_metrics_daily thiếu cột %', v_cols;
    end if;
  end loop;

  -- 21.5 RPC: security definer + chỉ service_role
  foreach v_fn in array array[
    'vexim_worker_upsert_ads_profiles(uuid, jsonb)',
    'vexim_worker_upsert_ads_campaigns(uuid, jsonb)',
    'vexim_worker_upsert_ads_ad_groups(uuid, jsonb)',
    'vexim_worker_upsert_ads_targets(uuid, jsonb)',
    'vexim_worker_upsert_ads_campaign_metrics(uuid, jsonb)',
    'vexim_worker_upsert_ads_target_metrics(uuid, jsonb)',
    'vexim_worker_upsert_ads_search_terms(uuid, jsonb)',
    'vexim_worker_upsert_ads_product_metrics(uuid, text, jsonb)',
    'vexim_worker_upsert_ads_budget_events(uuid, jsonb)',
    'vexim_worker_upsert_ads_suggestions(uuid, jsonb)',
    'vexim_worker_apply_ads_spend(uuid, date, date)',
    'vexim_worker_set_oauth_token(uuid, jsonb)',
    'vexim_worker_create_oauth_state(uuid, text, int)',
    'vexim_worker_consume_oauth_state(text)',
    'vexim_worker_mark_oauth_notice(uuid)',
    'vexim_worker_oauth_soon(int)'
  ] loop
    select count(*) into n
    from pg_proc p
    where p.oid = to_regprocedure('public.' || v_fn)
      and p.prosecdef
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and has_function_privilege('service_role', p.oid, 'EXECUTE');
    if n <> 1 then
      raise exception '[0020] FAIL: RPC % thiếu / không security definer / sai quyền', v_fn;
    end if;
  end loop;

  -- 21.6 view ads đều security_invoker (RLS bảng gốc vẫn áp)
  foreach v_view in array array['vexim_ads_profiles','vexim_ads_campaigns','vexim_ads_targets',
                                'vexim_ads_search_terms','vexim_ads_negative_suggestions',
                                'vexim_ads_budget_events','vexim_ads_sku_spend',
                                'vexim_ads_account_daily','vexim_ads_kpi'] loop
    select count(*) into n
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relname = v_view
      and 'security_invoker=true' = any (c.reloptions);
    if n <> 1 then
      raise exception '[0020] FAIL: view % thiếu hoặc không security_invoker', v_view;
    end if;
  end loop;

  -- 21.7 vexim_oauth_connections: CỐ Ý không security_invoker → phải tự lọc quyền,
  --      và TUYỆT ĐỐI không được lộ token ra web.
  select count(*) into n
  from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public' and c.relname = 'vexim_oauth_connections'
    and (c.reloptions is null or not ('security_invoker=true' = any (c.reloptions)));
  if n <> 1 then
    raise exception '[0020] FAIL: vexim_oauth_connections phải là view KHÔNG security_invoker (có lọc quyền riêng)';
  end if;

  select count(*) into n
  from information_schema.columns
  where table_schema = 'public' and table_name = 'vexim_oauth_connections'
    and (column_name like '%token%' or column_name like '%secret%' or column_name like '%encrypted%');
  if n <> 0 then
    raise exception '[0020] FAIL: vexim_oauth_connections LỘ token (% cột nghi vấn)', n;
  end if;

  select pg_get_viewdef('public.vexim_oauth_connections'::regclass, true) into v_cols;
  if position('can_read_seller_account' in v_cols) = 0 then
    raise exception '[0020] FAIL: vexim_oauth_connections KHÔNG lọc theo iam.can_read_seller_account';
  end if;

  -- 21.8 hợp đồng cột của 3 view web đọc bằng tên (sai 1 cột là PGRST204)
  select string_agg(column_name, ',' order by ordinal_position) into v_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'vexim_ads_campaigns';
  if v_cols is distinct from
     'seller_account_id,shop,ads_profile_id,campaign_id,campaign_type,name,state,targeting_type,'
     || 'portfolio_id,daily_budget,currency,start_date,end_date,last_day,spend_yesterday,spend_7d,'
     || 'spend_14d,spend_30d,sales_7d,sales_14d,sales_30d,purchases_7d,units_7d,clicks_7d,'
     || 'impressions_7d,cpc_7d,ctr_7d,acos_7d,acos_14d,acos_30d,roas_7d,'
     || 'budget_usage_yesterday_pct,budget_state,capped_days_30d,last_capped_day,'
     || 'last_synced_at,updated_at' then
    raise exception '[0020] FAIL: vexim_ads_campaigns sai hợp đồng cột: %', v_cols;
  end if;

  select string_agg(column_name, ',' order by ordinal_position) into v_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'vexim_oauth_connections';
  if v_cols is distinct from
     'seller_account_id,shop,seller_id,marketplace,shop_status,data_source,auth_scope,'
     || 'authorized_at,expires_at,days_left,is_expired,needs_reauth,notice_days,'
     || 'rotate_reminder_sent,notice_sent_at,last_refresh_at,refresh_count,revoked_at,'
     || 'is_active,ads_profiles' then
    raise exception '[0020] FAIL: vexim_oauth_connections sai hợp đồng cột: %', v_cols;
  end if;

  -- 21.9 helper đọc số: giá trị lạ → NULL, không ném lỗi
  if ads.int_or_null('1,234') is not null or ads.int_or_null('42') <> 42
     or ads.int_or_null('') is not null or ads.int_or_null('12.5') is not null then
    raise exception '[0020] FAIL: ads.int_or_null sai hành vi';
  end if;

  -- 21.10 rule cảnh báo mới (module iam.module_code = 'ads')
  select count(*) into n
  from ops.alert_rules
  where rule_code in ('acos_over_target','budget_exhausted') and module = 'ads';
  if n <> 2 then
    raise exception '[0020] FAIL: thiếu rule cảnh báo PPC (%/2)', n;
  end if;

  -- 21.10b rule nhắc re-authorize (Module 0) — module 'account_health'
  select count(*) into n
  from ops.alert_rules
  where rule_code = 'oauth_reauth_due' and module = 'account_health' and comparator = 'lte';
  if n <> 1 then
    raise exception '[0020] FAIL: thiếu rule cảnh báo oauth_reauth_due (%/1)', n;
  end if;

  -- 21.11 regression: 4 bảng ads của 0001 vẫn còn policy đọc + view 0019 còn nguyên
  select count(*) into n
  from pg_policies
  where schemaname = 'ads'
    and tablename in ('ad_profiles','campaigns','ad_metrics_daily','search_terms')
    and cmd = 'SELECT';
  if n < 4 then
    raise exception '[0020] FAIL: mất policy đọc của bảng ads gốc (0001) — còn %/4', n;
  end if;

  select count(*) into n
  from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public'
    and c.relname in ('vexim_report_requests','vexim_storage_fee_by_fc')
    and 'security_invoker=true' = any (c.reloptions);
  if n <> 2 then
    raise exception '[0020] FAIL: mất view của 0019';
  end if;

  raise notice '[0020] OK: nền Ads (profiles · campaigns · ad groups · targets · metrics v3 · search terms · suggestions · budget events) + luồng re-authorize đã sẵn sàng';
end;
$$;

commit;
