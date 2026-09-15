-- ============================================================================
-- cleanup_demo_data.sql — XOÁ TOÀN BỘ DỮ LIỆU DEMO/MOCK khỏi production
-- ============================================================================
-- CHẠY Ở ĐÂU: Supabase Dashboard → SQL Editor (service role).
--
-- XOÁ GÌ:
--   1. 6 shop mock từ seed_demo.sql / 0007 (A1·US, A2·MX, B1·DE, C2·US,
--      D1·US, E3·CA) — nhận diện bằng data_source = 'mock', KHÔNG dựa vào
--      tên hay seller_id để không bao giờ đụng nhầm shop thật.
--   2. MỌI dữ liệu con của các shop đó: alerts, orders, inventory, listings,
--      ads, finance, sync_jobs, assignments… — tự xoá theo FK on delete
--      cascade (đã kiểm: 51/51 FK về seller_accounts đều cascade).
--
-- GIỮ LẠI GÌ (không đụng tới):
--   • Shop production thật (data_source = 'production', seller AQMVYI4HJTI4C).
--   • iam.organizations / departments / user_profiles / role_assignments —
--     đây là hạ tầng phân quyền thật, không phải dữ liệu demo.
--   • Mọi dữ liệu con của shop production.
--
-- KHÔNG HOÀN TÁC ĐƯỢC — script bọc trong transaction: đọc kỹ phần NOTICE
-- kiểm đếm; nếu số liệu bất thường thì thay COMMIT cuối file bằng ROLLBACK.
-- IDEMPOTENT: chạy lại lần 2 chỉ báo "0 shop mock" rồi thoát êm.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- BƯỚC 1 · Kiểm đếm TRƯỚC khi xoá — đối chiếu bằng mắt trong tab Messages
-- ---------------------------------------------------------------------------
do $$
declare
  n_mock int;
  n_prod int;
  r record;
begin
  select count(*) into n_mock from connections.seller_accounts where data_source = 'mock';
  select count(*) into n_prod from connections.seller_accounts where data_source = 'production';

  raise notice '=== TRƯỚC KHI XOÁ ===';
  raise notice 'Shop mock  (sẽ XOÁ): %', n_mock;
  raise notice 'Shop thật  (GIỮ)   : %', n_prod;

  for r in
    select display_name, seller_id, marketplace
    from connections.seller_accounts
    where data_source = 'mock'
    order by display_name
  loop
    raise notice '  → xoá: % (% · %)', r.display_name, r.seller_id, r.marketplace;
  end loop;

  if n_mock = 0 then
    raise notice 'Không còn shop mock nào — DB đã sạch dữ liệu demo. Không có gì để xoá.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- BƯỚC 2 · Xoá shop mock — cascade kéo theo TOÀN BỘ dữ liệu con
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  delete from connections.seller_accounts where data_source = 'mock';
  get diagnostics n = row_count;
  raise notice 'Đã xoá % shop mock (kèm toàn bộ alerts/orders/inventory/ads/finance… của chúng theo cascade).', n;
end $$;

-- ---------------------------------------------------------------------------
-- BƯỚC 3 · Dọn nốt alerts demo còn sót (phòng khi có alert demo gắn nhầm
-- vào shop thật — nhận diện theo đúng tiêu đề mẫu của seed 0007/seed_demo)
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  delete from ops.alerts
  where title in (
    'ODR vượt ngưỡng 1% trên Shop C2',
    'Top SKU XMO-950-BLK còn 5 ngày cover trên Shop A1',
    'Margin XMO-951-ACC dưới sàn',
    '2 campaign hết budget sớm trên Shop B1',
    'API E3 · CA bị paused',
    '8 đề xuất giá ≤2% chờ duyệt',
    '3 FBM đơn trễ hạn trên Shop A1',
    'Settlement kỳ 27/08–09/09 đã về',
    'Inbound FBA15G…9DLP lệch 7 đơn vị'
  );
  get diagnostics n = row_count;
  if n > 0 then
    raise notice 'Dọn thêm % alert demo sót lại trên shop thật.', n;
  else
    raise notice 'Không có alert demo sót — OK.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- BƯỚC 4 · Kiểm đếm SAU khi xoá — phải còn ĐÚNG các shop production
-- ---------------------------------------------------------------------------
do $$
declare
  n_mock int;
  n_prod int;
  r record;
begin
  select count(*) into n_mock from connections.seller_accounts where data_source = 'mock';
  select count(*) into n_prod from connections.seller_accounts where data_source = 'production';

  raise notice '=== SAU KHI XOÁ ===';
  raise notice 'Shop mock còn lại : % (kỳ vọng 0)', n_mock;
  raise notice 'Shop thật còn lại : %', n_prod;

  for r in
    select display_name, seller_id, marketplace, status
    from connections.seller_accounts
    order by display_name
  loop
    raise notice '  giữ: % (% · % · %)', r.display_name, r.seller_id, r.marketplace, r.status;
  end loop;

  if n_mock <> 0 then
    raise exception 'FAIL: vẫn còn % shop mock — transaction sẽ tự ROLLBACK, không mất gì.', n_mock;
  end if;
  if n_prod = 0 then
    raise exception 'FAIL: không còn shop production nào — có gì đó rất sai, ROLLBACK toàn bộ.';
  end if;
end $$;

commit;
-- Nếu muốn CHẠY THỬ trước (xem NOTICE mà không xoá thật):
-- đổi dòng `commit;` phía trên thành `rollback;`, chạy, đọc log, rồi đổi lại.
