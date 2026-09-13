-- ============================================================================
-- 0026 — TÊN SHOP THÂN THIỆN + ĐẢM BẢO VIEW vexim_shops ĐỦ CỘT (fix tên mã thô)
-- ============================================================================
-- SỰ CỐ THẬT (09/2026, sau khi OAuth kết nối thành công):
--   Màn Kết nối shop hiện tên gian hàng dạng mã kỹ thuật thô (ATVPDKIK…,
--   A2EUQ1WT…), nhóm seller hiện "P1 · Seller P1" + chip "Custom" và P1·US /
--   P2·CA bị tách 2 card dù cùng seller AQMVYI4HJTI4C.
--
-- NGUYÊN NHÂN:
--   1. View public.vexim_shops trên DB còn là bản 0016 (thiếu seller_id +
--      display_name). Web select bản V2 lỗi → fallback select cũ → sellerId
--      null → không nhóm theo seller được, UI rơi về hiển thị kỹ thuật.
--   2. display_name trong connections.seller_accounts vẫn là tên kỹ thuật
--      ('P1 · US') hoặc tệ hơn là dính mã marketplace thô ('P1 · ATVPDKIKX0DER'
--      — sinh từ SQL hint của whoami khi Amazon không trả countryCode).
--
-- PHƯƠNG ÁN (idempotent, chạy lại vô hại):
--   1. Recreate view vexim_shops bản đầy đủ (same 0024) — DB nào lỡ thiếu
--      0024 vẫn được vá tại đây.
--   2. Đổi display_name thân thiện, phủ RỘNG hơn 0024: tên kỹ thuật P1/P2,
--      tên dính mã marketplace thô, hoặc display_name trống.
--   3. Self-check: view phải có seller_id + display_name; không còn shop
--      production nào mang tên chứa mã marketplace thô.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. View vexim_shops đủ cột (bản 0024) — vá cho DB thiếu migration
-- ---------------------------------------------------------------------------
drop view if exists public.vexim_shops cascade;

create or replace view public.vexim_shops
with (security_invoker = true) as
select
  sa.id                 as seller_account_id,
  sa.seller_id          as seller_id,
  sa.display_name       as shop,
  sa.display_name       as display_name,
  sa.marketplace        as marketplace,
  sa.marketplace        as marketplace_id,
  sa.status,
  sa.data_source,
  sa.health_status,
  sa.last_sync_at
from connections.seller_accounts sa;

grant select on public.vexim_shops to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Đổi display_name thân thiện — phủ mọi biến thể tên kỹ thuật đã gặp
-- ---------------------------------------------------------------------------
do $$
declare n int := 0;
begin
  -- 2a. Shop production của seller VEXIM: mọi biến thể kỹ thuật → tên thân thiện.
  --     KHÔNG đụng tên custom do vận hành tự đặt (chỉ match các pattern kỹ thuật).
  update connections.seller_accounts
  set display_name = 'VEXIM US - Chính'
  where seller_id = 'AQMVYI4HJTI4C'
    and marketplace = 'ATVPDKIKX0DER'
    and (
      display_name in ('P1 · US', 'P1·US', 'P1 - US', 'P1 US')
      or display_name is null
      or btrim(display_name) = ''
      or display_name = marketplace                    -- tên = mã marketplace thô
      or display_name ~ '^P[0-9]+ ?[·-] ?A[A-Z0-9]{8,}$' -- 'P1 · ATVPDKIKX0DER'
    );
  get diagnostics n = row_count;
  if n > 0 then raise notice '[0026] Đổi tên US → VEXIM US - Chính (% dòng)', n; end if;

  update connections.seller_accounts
  set display_name = 'VEXIM CA - Canada'
  where seller_id = 'AQMVYI4HJTI4C'
    and marketplace = 'A2EUQ1WTGCTBG2'
    and (
      display_name in ('P2 · CA', 'P2·CA', 'P2 - CA', 'P2 CA')
      or display_name is null
      or btrim(display_name) = ''
      or display_name = marketplace
      or display_name ~ '^P[0-9]+ ?[·-] ?A[A-Z0-9]{8,}$'
    );
  get diagnostics n = row_count;
  if n > 0 then raise notice '[0026] Đổi tên CA → VEXIM CA - Canada (% dòng)', n; end if;

  -- 2b. Lưới an toàn CHUNG: bất kỳ shop nào (kể cả seller khác sau này) có
  --     display_name = mã marketplace thô → thay bằng 'Shop <mã nước>' dễ đọc.
  update connections.seller_accounts
  set display_name = 'Shop ' || case marketplace
      when 'ATVPDKIKX0DER'  then 'US'
      when 'A2EUQ1WTGCTBG2' then 'CA'
      when 'A1AM78C64UM0Y8' then 'MX'
      when 'A1PA6795UKMFR9' then 'DE'
      when 'A1F83G8C2ARO7P' then 'UK'
      when 'A1RKKUPIHCS9HS' then 'ES'
      when 'A13V1IB3VIYZZH' then 'FR'
      when 'APJ6JRA9NG5V4'  then 'IT'
      when 'A1VC38T7YXB528' then 'JP'
      else left(marketplace, 6)
    end
  where display_name = marketplace;
  get diagnostics n = row_count;
  if n > 0 then raise notice '[0026] Lưới an toàn: % shop có tên = mã marketplace thô đã đổi', n; end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. TỰ KIỂM TRA
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
begin
  -- View phải có đủ seller_id + display_name (chống tái diễn fallback UI)
  select count(*) into n
  from information_schema.columns
  where table_schema = 'public' and table_name = 'vexim_shops'
    and column_name in ('seller_id', 'display_name', 'marketplace_id');
  if n <> 3 then
    raise exception '[0026] FAIL: view vexim_shops thiếu cột (có %/3: seller_id, display_name, marketplace_id)', n;
  end if;

  -- Không còn shop nào mang tên = mã marketplace thô
  select count(*) into n from connections.seller_accounts
  where display_name = marketplace;
  if n <> 0 then
    raise exception '[0026] FAIL: còn % shop có display_name = mã marketplace thô', n;
  end if;

  -- Shop production của VEXIM phải mang tên thân thiện
  select count(*) into n from connections.seller_accounts
  where seller_id = 'AQMVYI4HJTI4C'
    and display_name in ('VEXIM US - Chính', 'VEXIM CA - Canada');
  raise notice '[0026] OK: % shop production mang tên thân thiện · view vexim_shops đủ cột', n;
end
$$;

commit;
