-- ============================================================================
-- 0008 — PUBLIC RPC WRAPPERS (chữa PGRST202/PGRST205 trên PostgREST)
-- ============================================================================
-- LÝ DO (sự cố thật trên project VEXIM, 12/09/2026):
--
--   Worker gọi REST theo dạng CÓ DẤU CHẤM:
--       POST /rest/v1/rpc/connections.active_production_shops
--       GET  /rest/v1/connections.seller_accounts
--
--   PostgREST KHÔNG hiểu cú pháp "schema.table" / "schema.rpc". Nó tìm đúng
--   MỘT đối tượng có tên chứa dấu chấm bên trong schema mặc định (public):
--       PGRST205  Could not find the table 'public.connections.seller_accounts'
--                 in the schema cache
--       PGRST202  Could not find the function public.connections.active_...
--   → cron inventory-sync chết từ vòng lặp đầu tiên, log chỉ hiện "0 shop".
--
--   Hai quy tắc PostgREST (đúng chuẩn supabase-js postgrest-js):
--     1. Đường dẫn KHÔNG bao giờ có tiền tố schema:
--          /rest/v1/seller_accounts          (đúng)
--          /rest/v1/connections.seller_accounts (sai → PGRST205)
--     2. Chọn schema bằng HEADER, không phải bằng đường dẫn:
--          GET  → Accept-Profile: connections
--          POST/PATCH/DELETE → Content-Profile: connections
--
--   Riêng RPC có vấn đề thứ hai: schema `connections` / `inventory` chỉ được
--   phơi ra khi project thêm vào "Exposed schemas". RPC nằm trong schema chưa
--   phơi → vẫn PGRST202 dù header đúng. Vì vậy file này tạo WRAPPER trong
--   schema `public` (schema PostgREST luôn resolve mặc định) gọi tiếp hàm
--   thật bên trong. Worker chỉ việc gọi:
--       POST /rest/v1/rpc/active_production_shops
--       POST /rest/v1/rpc/units_sold_per_day
--
-- IDEMPOTENT: chạy bao nhiêu lần cũng an toàn.
-- THỨ TỰ: chạy SAU 0005 (hàm gốc phải tồn tại).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. public.active_production_shops()
--    Worker lấy danh sách shop (status='active' AND data_source='production')
--    để lặp qua đồng bộ tồn kho. Bản gốc: connections.active_production_shops()
-- ---------------------------------------------------------------------------
create or replace function public.active_production_shops()
returns table (
  id           uuid,
  seller_id    text,
  marketplace  text,
  display_name text,
  lead_days    int,
  safety_days  int
)
language sql
stable
security definer
set search_path = pg_catalog, public, connections
as $$
  select sa.id, sa.seller_id, sa.marketplace, sa.display_name, sa.lead_days, sa.safety_days
  from connections.active_production_shops() sa;
$$;

comment on function public.active_production_shops() is
  'Wrapper public (PostgREST) cho connections.active_production_shops() — worker đồng bộ tồn kho gọi qua POST /rest/v1/rpc/active_production_shops.';

-- ---------------------------------------------------------------------------
-- 2. public.units_sold_per_day(p_seller, p_sku, p_days)
--    Bản gốc: inventory.units_sold_per_day() (migration 0005).
-- ---------------------------------------------------------------------------
create or replace function public.units_sold_per_day(
  p_seller uuid,
  p_sku    text,
  p_days   int
)
returns table (d date, q bigint)
language sql
stable
security definer
set search_path = pg_catalog, public, inventory
as $$
  select u.d, u.q
  from inventory.units_sold_per_day(p_seller, p_sku, p_days) u;
$$;

comment on function public.units_sold_per_day(uuid, text, int) is
  'Wrapper public (PostgREST) cho inventory.units_sold_per_day() — worker tính velocity 14 ngày.';

-- ---------------------------------------------------------------------------
-- 3. Quyền — CHỈ service_role (worker) + authenticated (dashboard nội bộ).
--    KHÔNG cấp anon: danh sách shop production là thông tin nhạy cảm
--    (seller_id thật của khách hàng).
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;

revoke all on function public.active_production_shops() from public;
grant execute on function public.active_production_shops() to service_role, authenticated;

revoke all on function public.units_sold_per_day(uuid, text, int) from public;
grant execute on function public.units_sold_per_day(uuid, text, int) to service_role, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Báo PostgREST nạp lại schema cache (nếu đang chạy trên Supabase thật).
--    Ở môi trường không có PostgREST (PGlite/test) câu lệnh này vô hại —
--    bọc trong DO để không bao giờ làm gãy migration.
-- ---------------------------------------------------------------------------
do $$
begin
  notify pgrst, 'reload schema';
exception
  when others then
    raise notice '[0008] bỏ qua notify pgrst (môi trường không có PostgREST): %', sqlerrm;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Kiểm chứng — cả hai wrapper phải gọi được
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  select count(*) into n from public.active_production_shops();
  raise notice '[0008] public.active_production_shops() → % shop production', n;
  select count(*) into n
  from public.units_sold_per_day('00000000-0000-0000-0000-000000000001', '__probe__', 14);
  raise notice '[0008] public.units_sold_per_day() sẵn sàng';
end
$$;

commit;
