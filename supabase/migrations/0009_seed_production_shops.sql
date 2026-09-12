-- ============================================================================
-- 0009 — ĐĂNG KÝ SHOP PRODUCTION THẬT (seller AQMVYI4HJTI4C · US + CA)
-- ============================================================================
-- LÝ DO:
--   Cron /api/cron/inventory-sync chỉ đồng bộ những shop thoả
--       status = 'active' AND data_source = 'production'
--   (xem connections.active_production_shops() ở migration 0005 và wrapper
--   public.active_production_shops() ở 0008).
--
--   Trước migration này DB chỉ có 6 shop data_source='mock' từ seed_demo.sql
--   (A1 · US, A2 · MX, B1 · DE, C2 · US, D1 · US, E3 · CA) → worker log
--   "mode=production nhưng KHÔNG có shop nào thoả … Không sync gì cả",
--   shopsProcessed = 0. Đó là nửa còn lại của sự cố cron (nửa đầu là PGRST205
--   đã xử lý ở 0008).
--
--   Shop production thật do chủ shop cung cấp (xác nhận qua
--   GET /api/amazon/whoami — SellerId lấy từ
--   feesEstimate.FeesEstimateIdentifier.SellerId):
--       seller_id   = AQMVYI4HJTI4C
--       marketplace = ATVPDKIKX0DER (US) + A2EUQ1WTGCTBG2 (CA)
--
-- IDEMPOTENT: upsert theo unique (seller_id, marketplace) — chạy lại không
--   tạo dòng trùng, không đổi org, không xoá dữ liệu.
-- THỨ TỰ: chạy SAU 0008.
-- ============================================================================

begin;

do $$
declare
  v_org_id uuid;
  n int;
begin
  select id into v_org_id
  from iam.organizations
  where slug = 'vexim'
  limit 1;

  -- Nếu vì lý do gì đó chưa có org VEXIM (0007 chưa chạy) → lấy org nội bộ đầu tiên.
  if v_org_id is null then
    select id into v_org_id
    from iam.organizations
    where is_internal
    order by created_at
    limit 1;
  end if;

  if v_org_id is null then
    raise exception
      '[0009] Không tìm thấy iam.organizations (slug=''vexim'' hoặc is_internal=true). Chạy 0007 trước.';
  end if;

  insert into connections.seller_accounts
    (org_id, seller_id, marketplace, display_name, status, data_source, health_status)
  values
    (v_org_id, 'AQMVYI4HJTI4C', 'ATVPDKIKX0DER',  'P1 · US', 'active', 'production', 'green'),
    (v_org_id, 'AQMVYI4HJTI4C', 'A2EUQ1WTGCTBG2', 'P2 · CA', 'active', 'production', 'green')
  on conflict (seller_id, marketplace) do update
    set display_name  = excluded.display_name,
        status        = 'active',
        data_source   = 'production',
        health_status = excluded.health_status,
        org_id        = excluded.org_id;

  get diagnostics n = row_count;
  raise notice '[0009] seller_accounts production upsert: % dòng', n;
end
$$;

-- ---------------------------------------------------------------------------
-- Kiểm chứng: worker phải nhìn thấy đúng 2 shop production
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  select count(*) into n from public.active_production_shops();

  if n <> 2 then
    raise exception
      '[0009] FAIL: public.active_production_shops() trả % shop (kỳ vọng 2: US + CA)', n;
  end if;

  raise notice '[0009] XONG. active_production_shops() = % shop (US + CA), data_source=production', n;
end
$$;

commit;
