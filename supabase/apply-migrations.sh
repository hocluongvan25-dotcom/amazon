#!/usr/bin/env bash
# ============================================================================
# Áp TOÀN BỘ migrations lên Supabase/Postgres thật theo đúng thứ tự 0001 → cao nhất.
#
# VÌ SAO CÓ SCRIPT NÀY:
#   Các migration sau PHỤ THUỘC migration trước (vd 0025 dùng schema iam, enum
#   iam.module_code, hàm iam.has_role... tạo ở 0001/0022). Dán riêng file 0025
#   vào project trống sẽ lỗi:  ERROR: 3F000: schema "iam" does not exist.
#   Project mới phải chạy ĐỦ CHUỖI, không chỉ file cuối.
#
# DÙNG:
#   1. Lấy Connection string (Dashboard → Project Settings → Database →
#      Connection string → URI, chọn mode "Session" / port 5432):
#        postgres://postgres:[MẬT KHẨU]@db.<ref>.supabase.co:5432/postgres
#   2. export DATABASE_URL='...'
#   3. bash supabase/apply-migrations.sh           # chỉ migrations
#      bash supabase/apply-migrations.sh --seed    # migrations + seed.sql
#
# Ghi chú:
#   - Bật ON_ERROR_STOP: gặp lỗi là dừng ngay, không áp dở dang.
#   - Idempotent: chạy lại toàn bộ nhiều lần an toàn (các file đều IF NOT EXISTS /
#     CREATE OR REPLACE).
#   - TUYỆT ĐỐI KHÔNG chạy tests/0000_local_compat_shim.sql ở đây (chỉ dành cho
#     PGlite local; Supabase thật đã có sẵn schema auth + roles).
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v psql >/dev/null 2>&1; then
  echo "Chưa có psql. Cài postgresql-client (Debian/Ubuntu: apt-get install -y postgresql-client; macOS: brew install libpq)." >&2
  exit 1
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "Thiếu biến DATABASE_URL (connection string Postgres của project Supabase)." >&2
  echo 'Ví dụ: export DATABASE_URL="postgres://postgres:****@db.<ref>.supabase.co:5432/postgres"' >&2
  exit 1
fi

shopt -s nullglob
files=(migrations/[0-9]*.sql)
if [ "${#files[@]}" -eq 0 ]; then
  echo "Không tìm thấy file migrations/*.sql" >&2
  exit 1
fi

echo ">> Sẽ áp ${#files[@]} migration theo thứ tự:"
printf '   %s\n' "${files[@]##*/}"

for f in "${files[@]}"; do
  echo ">> Áp ${f##*/} ..."
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"
done

if [ "${1:-}" = "--seed" ]; then
  echo ">> Áp seed.sql (SOP templates) ..."
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f seed.sql
fi

echo ">> XONG. Kiểm chứng lại bằng: cd supabase && npm test (PGlite, không đụng DB thật)."
