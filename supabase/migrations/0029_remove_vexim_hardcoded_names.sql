-- ============================================================================
-- 0029 — GỠ TÊN SHOP HARDCODE "VEXIM" KHỎI DỮ LIỆU
-- ============================================================================
-- Bối cảnh: migration 0024/0026 (thời chỉ có 1 seller) đã hardcode display_name
-- 'VEXIM US - Chính' / 'VEXIM CA - Canada' cho seller AQMVYI4HJTI4C. Hệ thống
-- nay quản lý NHIỀU shop của NHIỀU khách — tên shop không được phép hardcode
-- theo bất kỳ seller nào.
--
-- Sau 0029, tên shop đi theo đúng chuỗi ưu tiên của 0027+0028:
--   1. Tên người vận hành TỰ ĐẶT (vexim_rename_shop, name_source='manual')
--   2. storeName THẬT từ Amazon (callback OAuth → vexim_worker_set_shop_name,
--      name_source='amazon') — kết nối/kết nối lại là tự có
--   3. Tên mặc định generic 'Shop US · AQMV' (default_shop_name, 0027)
--
-- Việc của 0029: các dòng còn mang tên hardcode VEXIM mà KHÔNG phải do người
-- vận hành đặt (name_source <> 'manual') → reset về tên generic (3). Lần
-- kết nối lại tiếp theo, callback sẽ nâng lên tên thật từ Amazon (2).
--
-- IDEMPOTENT: update có điều kiện — chạy lại không đổi gì thêm.
-- ============================================================================

begin;

do $$
declare n int;
begin
  update connections.seller_accounts
  set display_name = connections.default_shop_name(marketplace, seller_id),
      name_source  = 'default'
  where display_name in ('VEXIM US - Chính', 'VEXIM CA - Canada')
    and coalesce(name_source, 'default') <> 'manual';
  get diagnostics n = row_count;
  if n > 0 then
    raise notice '[0029] Gỡ tên hardcode VEXIM: % shop reset về tên generic (kết nối lại sẽ lấy tên thật từ Amazon)', n;
  else
    raise notice '[0029] Không còn shop nào mang tên hardcode VEXIM — bỏ qua';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- TỰ KIỂM TRA: không còn dòng nào mang tên hardcode cũ (trừ khi manual —
-- người vận hành cố tình đặt thì tôn trọng)
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  select count(*) into n
  from connections.seller_accounts
  where display_name in ('VEXIM US - Chính', 'VEXIM CA - Canada')
    and coalesce(name_source, 'default') <> 'manual';
  if n <> 0 then
    raise exception '[0029] FAIL: vẫn còn % shop mang tên hardcode VEXIM', n;
  end if;
  raise notice '[0029] OK: dữ liệu sạch tên hardcode — tên shop giờ 100%% dynamic (manual > amazon > default)';
end $$;

commit;
