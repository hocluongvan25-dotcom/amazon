-- ============================================================================
-- [CHỈ DÙNG CHO TEST LOCAL VỚI POSTGRES THƯỜNG]
-- Shim mô phỏng môi trường Supabase để chạy migrations 0001–0003 ngoài platform:
--   - roles: anon / authenticated / service_role
--   - schema auth + bảng auth.users + hàm auth.uid()
-- ⚠️ KHÔNG chạy file này trên project Supabase thật — Supabase đã có sẵn các
--    thành phần này. Trên Supabase chỉ chạy 0001 → 0002 → 0003.
-- ============================================================================

-- (idempotent: chạy nhiều lần không lỗi)
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
  -- giống Supabase thật: service_role bypass RLS (dùng cho worker đồng bộ)
  execute 'alter role service_role bypassrls';
end
$$;

create schema if not exists auth;

create table if not exists auth.users (
  id       uuid primary key,
  email    text,
  created_at timestamptz default now()
);

-- Giả lập JWT: test đặt người dùng bằng
--   set request.jwt.claim.sub = '<uuid>'
create or replace function auth.uid()
returns uuid
language sql stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;
