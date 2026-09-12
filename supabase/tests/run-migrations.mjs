/**
 * KIỂM CHỨNG MIGRATIONS TRÊN POSTGRES THẬT (PGlite — PostgreSQL 18 biên dịch WASM).
 *
 * Chạy:  cd supabase && npm install && npm test
 *
 * Harness này:
 *   1. Tạo DB trống, chạy shim + migrations 0001..0005 + seed.sql
 *   2. TÁI HIỆN đúng trạng thái DB production của VEXIM ngày 12/09/2026
 *      (rls_test.sql bản cũ có `commit;` đã ghi fixture test xuống DB thật)
 *      và đối chiếu từng bảng với dump do VEXIM cung cấp
 *   3. Kiểm chứng 2 chốt an toàn mới của rls_test.sql (cờ + rollback)
 *   4. Kiểm chứng 0006 dọn sạch fixture, giữ nguyên user thật
 *   5. Kiểm chứng 0007 tạo super_admin + alerts (không phụ thuộc auth.uid())
 *   6. Kiểm chứng view 0004 + RPC 0005 đọc được dữ liệu thật
 *   7. Kiểm chứng 0008 tạo wrapper RPC trong schema public (chữa PGRST202)
 *   8. Kiểm chứng 0009 đăng ký shop production AQMVYI4HJTI4C (US + CA)
 *
 * Không cần Docker, không cần Supabase project, không cần credentials.
 */
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => readFileSync(join(ROOT, p), "utf8");

const db = new PGlite({ extensions: { pgcrypto, btree_gist } });
let fails = 0;

const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) fails++;
};

/** exec một script; reset transaction nếu lỗi (lỗi cố ý để lại txn aborted) */
const ex = async (sql, label) => {
  try {
    await db.exec(sql);
    if (label) console.log(`   ran: ${label}`);
    return true;
  } catch (e) {
    console.log(`   ERROR${label ? ` in ${label}` : ""}: ${e.message.split("\n")[0]}`);
    try { await db.exec("rollback"); } catch { /* ignore */ }
    return false;
  }
};

const one = async (sql) => {
  try {
    return (await db.query(sql)).rows[0];
  } catch (e) {
    return { error: e.message.split("\n")[0] };
  }
};

const cmp = async (label, sql, want) => {
  const raw = (await one(sql)).n;
  const got = Number(raw);
  ok(got === want, `${label} = ${Number.isNaN(got) ? raw : got} (kỳ vọng ${want})`);
};

// ===========================================================================
console.log("\n=== BƯỚC 1: shim + migrations 0001..0005 + seed.sql ===");
// ===========================================================================
await ex(rd("tests/0000_local_compat_shim.sql"), "0000 shim");
for (const m of [
  "0001_init",
  "0002_task_workflows",
  "0003_cost_inputs",
  "0004_ui_policies_notifs_profile_invite",
  "0005_worker_inventory_rpc",
]) {
  const ran = await ex(rd(`migrations/${m}.sql`), m);
  ok(ran, `migration ${m} chạy sạch`);
}
await ex(rd("seed.sql"), "seed.sql");

// ===========================================================================
console.log("\n=== BƯỚC 2: TÁI HIỆN trạng thái DB production VEXIM 12/09/2026 ===");
// ===========================================================================
// rls_test.sql bản CŨ: bật cờ (chốt 2) rồi đổi rollback->commit (tái hiện chốt 1 cũ)
await ex("select set_config('vexim.allow_rls_test','on',false)");
const rlsSrc = rd("tests/rls_test.sql");
const rlsOld = rlsSrc.replace(/^rollback;$/m, "commit;");
if (rlsOld === rlsSrc) {
  console.log("   !! không tìm thấy dòng 'rollback;' — harness cần cập nhật");
  fails++;
}
await ex(rlsOld, "rls_test (bản CŨ, commit)");

// tài khoản thật
await ex(
  `insert into auth.users (id, email, raw_user_meta_data)
   values ('dddd0000-0000-4000-8000-000000000001','hocluongvan88@gmail.com',
           '{"full_name":"Ho Luong Van"}'::jsonb)`,
);

// seed_demo.sql trong SQL Editor: auth.uid() = NULL (không set jwt claim)
await ex(rd("seed/seed_demo.sql"), "seed_demo.sql (auth.uid()=NULL)");

console.log("\n--- Đối chiếu dump VEXIM cung cấp ---");
await cmp("organizations",   "select count(*) n from iam.organizations", 3);
await cmp("departments",     "select count(*) n from iam.departments", 6);
await cmp("seller_accounts", "select count(*) n from connections.seller_accounts", 9);
await cmp("auth.users",      "select count(*) n from auth.users", 4);
await cmp("user_profiles",   "select count(*) n from iam.user_profiles", 3);
await cmp("role_assignments","select count(*) n from iam.role_assignments", 3);
await cmp("assignments",     "select count(*) n from iam.assignments", 2);
await cmp("listings",        "select count(*) n from catalog.listings", 7);
await cmp("tasks",           "select count(*) n from ops.tasks", 3);
await cmp("cost_inputs",     "select count(*) n from catalog.cost_inputs", 2);
await cmp("audit_logs",      "select count(*) n from iam.audit_logs", 1);
await cmp("oauth_tokens",    "select count(*) n from connections.oauth_tokens", 1);
await cmp("alert_rules",     "select count(*) n from ops.alert_rules", 8);
await cmp("task_templates",  "select count(*) n from ops.task_templates", 12);
await cmp("alerts",          "select count(*) n from ops.alerts", 0);

const emails = (await db.query("select email from auth.users order by email")).rows.map((r) => r.email);
console.log("   auth.users emails:", emails.join(", "));
ok(
  emails.length === 4 && emails.includes("hocluongvan88@gmail.com"),
  "tái hiện đúng 4 email trong dump VEXIM",
);

// ===========================================================================
console.log("\n=== BƯỚC 3: hai chốt an toàn của rls_test.sql ===");
// ===========================================================================
// Chốt 2 — TẮT cờ thì phải từ chối
await ex("select set_config('vexim.allow_rls_test','off',false)");
const blocked = !(await ex(rlsSrc, "rls_test KHÔNG bật cờ (kỳ vọng FAIL)"));
ok(blocked, "chốt 2: rls_test.sql tự từ chối khi chưa bật cờ vexim.allow_rls_test");

// Chốt 1 — bật cờ thì chạy được, và rollback giữ DB nguyên vẹn
await ex("select set_config('vexim.allow_rls_test','on',false)");
const SNAP = `select
  (select count(*) from catalog.listings)            as listings,
  (select count(*) from iam.organizations)           as orgs,
  (select count(*) from connections.seller_accounts) as shops,
  (select count(*) from auth.users)                  as users,
  (select count(*) from iam.user_profiles)           as profiles,
  (select count(*) from ops.tasks)                   as tasks`;
const before = await one(SNAP);
const ranRls = await ex(rlsSrc, "rls_test CÓ bật cờ");
const after = await one(SNAP);
ok(ranRls, "rls_test.sql chạy thành công khi đã bật cờ (10 test, không exception)");
ok(
  JSON.stringify(before) === JSON.stringify(after),
  `chốt 1: rollback giữ DB nguyên vẹn\n        trước=${JSON.stringify(before)}\n        sau =${JSON.stringify(after)}`,
);
// chạy lại trong cùng phiên không được vỡ (temp table on commit drop + tự dọn)
ok(await ex(rlsSrc, "rls_test lần 2 cùng phiên"), "rls_test.sql idempotent trong cùng phiên");

// ===========================================================================
console.log("\n=== BƯỚC 4: migration 0006 dọn fixture ===");
// ===========================================================================
ok(
  await ex(rd("migrations/0006_cleanup_rls_test_fixtures.sql"), "0006_cleanup_rls_test_fixtures.sql"),
  "0006 chạy sạch",
);
console.log("\n--- Sau 0006 ---");
await cmp("organizations (còn vexim)", "select count(*) n from iam.organizations", 1);
await cmp("seller_accounts (còn seed_demo)", "select count(*) n from connections.seller_accounts", 6);
await cmp("auth.users (còn user thật)", "select count(*) n from auth.users", 1);
await cmp("user_profiles", "select count(*) n from iam.user_profiles", 0);
await cmp("listings", "select count(*) n from catalog.listings", 0);
await cmp("tasks", "select count(*) n from ops.tasks", 0);
await cmp("cost_inputs", "select count(*) n from catalog.cost_inputs", 0);
await cmp("audit_logs", "select count(*) n from iam.audit_logs", 0);
await cmp("oauth_tokens", "select count(*) n from connections.oauth_tokens", 0);
await cmp("role_assignments", "select count(*) n from iam.role_assignments", 0);
await cmp("assignments", "select count(*) n from iam.assignments", 0);
ok(
  (await one("select email from auth.users")).email === "hocluongvan88@gmail.com",
  "user thật sống sót sau khi dọn fixture",
);
ok(
  await ex(rd("migrations/0006_cleanup_rls_test_fixtures.sql"), "0006 chạy LẦN 2"),
  "0006 idempotent",
);

// ===========================================================================
console.log("\n=== BƯỚC 5: migration 0007 seed admin + alerts ===");
// ===========================================================================
ok(
  await ex(rd("migrations/0007_seed_admin_and_alerts.sql"), "0007_seed_admin_and_alerts.sql"),
  "0007 chạy sạch",
);
console.log("\n--- Sau 0007 ---");
const prof = await one("select display_name, email, vexim_employee from iam.user_profiles");
ok(prof?.email === "hocluongvan88@gmail.com", `user_profile tạo cho user thật (${prof?.display_name})`);
ok(prof?.vexim_employee === true, "vexim_employee = true");
await cmp("super_admin", "select count(*) n from iam.role_assignments where role='super_admin' and department_id is null", 1);
await cmp("alerts", "select count(*) n from ops.alerts", 9);
await cmp("assignments (1 admin × 6 shop)", "select count(*) n from iam.assignments", 6);

ok(
  await ex(rd("migrations/0007_seed_admin_and_alerts.sql"), "0007 chạy LẦN 2"),
  "0007 idempotent",
);
await cmp("0007 lần 2: super_admin", "select count(*) n from iam.role_assignments where role='super_admin' and department_id is null", 1);
await cmp("0007 lần 2: alerts", "select count(*) n from ops.alerts", 9);
await cmp("0007 lần 2: assignments", "select count(*) n from iam.assignments", 6);
await cmp("0007 lần 2: user_profiles", "select count(*) n from iam.user_profiles", 1);

// ===========================================================================
console.log("\n=== BƯỚC 6: view 0004 + RPC 0005 đọc dữ liệu thật ===");
// ===========================================================================
await ex("select set_config('request.jwt.claim.sub','dddd0000-0000-4000-8000-000000000001',false)");
ok((await one("select role from iam.my_profile")).role === "super_admin", "iam.my_profile.role = super_admin");
await cmp("ops.my_alerts thấy đủ", "select count(*) n from ops.my_alerts", 9);
await cmp(
  "active_production_shops() (mọi shop data_source='mock')",
  "select count(*) n from connections.active_production_shops()",
  0,
);

// ===========================================================================
console.log("\n=== BƯỚC 7: migration 0008 — public RPC wrappers (chữa PGRST202) ===");
// ===========================================================================
ok(
  await ex(rd("migrations/0008_public_rpc_wrappers.sql"), "0008_public_rpc_wrappers.sql"),
  "0008 chạy sạch",
);
// 0005 tạo RPC trong schema connections/inventory. PostgREST chỉ resolve mặc
// định schema public → worker gọi /rest/v1/rpc/connections.active_production_shops
// bị PGRST202. 0008 bọc lại trong public.
await cmp(
  "public.active_production_shops() (chưa có shop production)",
  "select count(*) n from public.active_production_shops()",
  0,
);
await cmp(
  "public.units_sold_per_day() trả đúng kiểu (probe rỗng)",
  "select count(*) n from public.units_sold_per_day('00000000-0000-0000-0000-000000000001','__probe__',14)",
  0,
);
const fnSig = await one(
  `select count(*) n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname in ('active_production_shops','units_sold_per_day')`,
);
ok(Number(fnSig.n) === 2, `2 wrapper nằm trong schema public (thấy ${fnSig.n})`);
ok(
  await ex(rd("migrations/0008_public_rpc_wrappers.sql"), "0008 chạy LẦN 2"),
  "0008 idempotent",
);

// ===========================================================================
console.log("\n=== BƯỚC 8: migration 0009 — shop production AQMVYI4HJTI4C (US + CA) ===");
// ===========================================================================
ok(
  await ex(rd("migrations/0009_seed_production_shops.sql"), "0009_seed_production_shops.sql"),
  "0009 chạy sạch",
);
await cmp(
  "public.active_production_shops() sau 0009",
  "select count(*) n from public.active_production_shops()",
  2,
);
const prodShops = await db.query(
  "select seller_id, marketplace, display_name from public.active_production_shops() order by marketplace",
);
console.log("   shop production:", JSON.stringify(prodShops.rows));
ok(
  prodShops.rows.every((r) => r.seller_id === "AQMVYI4HJTI4C"),
  "cả 2 shop đều mang seller_id AQMVYI4HJTI4C",
);
ok(
  prodShops.rows.map((r) => r.marketplace).sort().join(",") === "A2EUQ1WTGCTBG2,ATVPDKIKX0DER",
  "đúng 2 marketplace: US (ATVPDKIKX0DER) + CA (A2EUQ1WTGCTBG2)",
);
await cmp(
  "connections.active_production_shops() (hàm gốc, cùng kết quả)",
  "select count(*) n from connections.active_production_shops()",
  2,
);
await cmp(
  "shop mock không bị nâng cấp nhầm",
  "select count(*) n from connections.seller_accounts where data_source = 'mock'",
  6,
);
ok(
  await ex(rd("migrations/0009_seed_production_shops.sql"), "0009 chạy LẦN 2"),
  "0009 idempotent",
);
await cmp(
  "0009 lần 2: vẫn đúng 2 shop production",
  "select count(*) n from public.active_production_shops()",
  2,
);
await cmp(
  "0009 lần 2: không tạo thêm seller_accounts",
  "select count(*) n from connections.seller_accounts",
  8,
);

console.log(`\n${"=".repeat(70)}`);
console.log(fails === 0 ? "TẤT CẢ PASS" : `${fails} MỤC FAIL`);
console.log("=".repeat(70));
await db.close();
process.exit(fails === 0 ? 0 : 1);
