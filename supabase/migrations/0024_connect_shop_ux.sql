-- ============================================================================
-- 0024 — FIX UX KẾT NỐI SHOP (SOP-11): nhóm theo seller, tên thân thiện, chống ghi đè
-- ============================================================================
-- VẤN ĐỀ:
--   - Seed cố định 8 dòng (A1·US, C2·US, P1·US...) → dễ bấm nhầm [Kết nối] ghi đè Refresh Token sai shop
--   - Mã A1/B1/P1 mang tính kỹ thuật, người dùng không nhận biết gian hàng nào
--   - Nhiều dòng "Chưa kết nối" gây rối mắt
--
-- PHƯƠNG ÁN:
--   1. View vexim_shops thêm seller_id + display_name để UI nhóm P1·US + P2·CA cùng seller AQMVYI4HJTI4C
--   2. Đổi display_name production thành tên thân thiện: VEXIM US - Chính, VEXIM CA - Canada
--   3. Giữ mock shops nhưng UI sẽ ẩn mặc định (data_source=mock) để tránh nhầm
--   4. Thêm cột marketplace meta để UI hiện cờ 🇺🇸 🇨🇦
--
-- IDEMPOTENT: chạy lại không tạo trùng
-- ============================================================================

begin;

-- 1. Cập nhật view vexim_shops để có seller_id và display_name riêng (trước shop = display_name)
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

-- 2. Đổi tên thân thiện cho 2 shop production thật (thay cho P1·US / P2·CA kỹ thuật)
do $$
begin
  -- Chỉ đổi nếu đang là tên kỹ thuật cũ, tránh ghi đè tên custom do vận hành đặt
  update connections.seller_accounts
  set display_name = 'VEXIM US - Chính'
  where seller_id = 'AQMVYI4HJTI4C'
    and marketplace = 'ATVPDKIKX0DER'
    and display_name in ('P1 · US', 'P1·US', 'P1 - US', 'P1 US');

  update connections.seller_accounts
  set display_name = 'VEXIM CA - Canada'
  where seller_id = 'AQMVYI4HJTI4C'
    and marketplace = 'A2EUQ1WTGCTBG2'
    and display_name in ('P2 · CA', 'P2·CA', 'P2 - CA', 'P2 CA');

  -- Nếu chưa có display_name thân thiện (lần đầu chạy 0009), set luôn
  update connections.seller_accounts
  set display_name = 'VEXIM US - Chính'
  where seller_id = 'AQMVYI4HJTI4C'
    and marketplace = 'ATVPDKIKX0DER'
    and (display_name is null or display_name = '');

  update connections.seller_accounts
  set display_name = 'VEXIM CA - Canada'
  where seller_id = 'AQMVYI4HJTI4C'
    and marketplace = 'A2EUQ1WTGCTBG2'
    and (display_name is null or display_name = '');

  raise notice '[0024] Đổi tên production shops thành thân thiện (VEXIM US/CA)';
end
$$;

-- 3. Đổi tên mock shops thành tên dễ hiểu hơn (nếu vẫn giữ lại để test)
do $$
begin
  update connections.seller_accounts
  set display_name = 'Demo US - A1'
  where seller_id = 'A2XYZUSDEMO' and marketplace = 'ATVPDKIKX0DER' and display_name = 'A1 · US';

  update connections.seller_accounts
  set display_name = 'Demo MX - A2'
  where display_name = 'A2 · MX';

  update connections.seller_accounts
  set display_name = 'Demo DE - B1'
  where display_name = 'B1 · DE';

  update connections.seller_accounts
  set display_name = 'Demo US - C2'
  where display_name = 'C2 · US';

  update connections.seller_accounts
  set display_name = 'Demo US - D1'
  where display_name = 'D1 · US';

  update connections.seller_accounts
  set display_name = 'Demo CA - E3'
  where display_name = 'E3 · CA';

  raise notice '[0024] Đổi tên mock shops thành Demo ...';
exception when others then
  raise notice '[0024] Bỏ qua đổi tên mock (có thể chưa có seed_demo): %', SQLERRM;
end
$$;

-- 4. Kiểm chứng
do $$
declare
  n_prod int;
  n_total int;
begin
  select count(*) into n_prod from connections.seller_accounts where data_source='production' and status='active';
  select count(*) into n_total from connections.seller_accounts where status != 'revoked';

  raise notice '[0024] production active: %, total active: %', n_prod, n_total;

  -- Đảm bảo view mới có seller_id
  perform 1 from public.vexim_shops where seller_id is not null limit 1;
  if not found then
    raise notice '[0024] WARN: vexim_shops chưa có seller_id (có thể chưa có data)';
  end if;
end
$$;

commit;
