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
 *   9. Kiểm chứng 0010 dựng hạ tầng Module 4/6/7 (order_daily, account_health,
 *      rule cảnh báo, view public) + chốt PII + tính idempotent
 *  10. Kiểm chứng 0014 — L3 Listing Editor: staging + lịch sử + máy trạng thái
 *      + RPC cho web/worker + cache JSON Schema product type (form động)
 *  11. Kiểm chứng 0015..0017 — F3/F4 bồi hoàn + lợi nhuận · Đợt A gỡ chặn dữ liệu
 *      lõi · Đợt B doanh số 30 ngày / người phụ trách / giá trị tồn
 *  12. Kiểm chứng 0018 — Module 3 nâng cao: phân bổ tồn theo FC + lịch sử nhận
 *      hàng từ report, RPC worker idempotent, đối soát nhận với số gửi của I4
 *
 * Không cần Docker, không cần Supabase project, không cần credentials.
 */
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { screens } from "../../web/src/lib/data/operations-model.ts";
// Hợp đồng cột web ↔ DB cho Module 5: web đọc bằng select CỐ ĐỊNH, sai một tên cột
// là PostgREST trả 400 ngay trên production nên phải chốt ở đây (chạy trên PG thật).
import {
  ADS_BUDGET_SELECT,
  ADS_CAMPAIGN_SELECT,
  ADS_DAILY_SELECT,
  ADS_KPI_SELECT,
  ADS_PROFILE_SELECT,
  ADS_REPORT_REQUEST_SELECT,
  ADS_SEARCH_TERM_SELECT,
} from "../../web/src/lib/data/ads-model.ts";
import {
  PPC_NEGATIVE_SELECT,
  PPC_POLICY_SELECT,
  PPC_REQUEST_SELECT,
  PPC_SUGGESTION_SELECT,
} from "../../web/src/lib/data/ppc-write-model.ts";

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

/**
 * Kiểm tra một lệnh PHẢI bị chặn, mà KHÔNG làm abort transaction đang test.
 *
 * Vì sao cần: helper `ex()` gọi `rollback` khi gặp lỗi — điều đó xoá luôn
 * fixture và cả `set local role`, khiến các test sau chạy nhầm bằng superuser.
 * Ở đây lỗi được bắt trong DO-block (subtransaction) nên transaction ngoài
 * vẫn sống; nếu lệnh KHÔNG bị chặn thì ta raise để test fail đúng chỗ.
 */
const mustBlock = async (sql) => {
  const wrapped = `do $do$
begin
  execute $q$${sql}$q$;
  raise exception 'VEXIM_TEST_NOT_BLOCKED';
exception
  when others then
    if sqlerrm = 'VEXIM_TEST_NOT_BLOCKED' then
      raise exception '[test] lệnh KHÔNG bị chặn: %', sqlerrm;
    end if;
end
$do$;`;
  return ex(wrapped);
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

// ===========================================================================
console.log("\n=== BƯỚC 9: migration 0010 — hạ tầng Module 4/6/7 ===");
// ===========================================================================
ok(
  await ex(rd("migrations/0010_module_4_6_7_orders_finance_health.sql"), "0010_module_4_6_7_orders_finance_health.sql"),
  "0010 chạy sạch (DO-block tự kiểm tra bảng/rule/view/PII)",
);

await cmp(
  "bảng mới sales.order_daily",
  "select count(*) n from information_schema.tables where table_schema='sales' and table_name='order_daily'",
  1,
);
await cmp(
  "schema account_health có 2 bảng",
  "select count(*) n from information_schema.tables where table_schema='account_health'",
  2,
);
await cmp(
  "rule cảnh báo mới (fbm_late_ship, return_reason_spike, reconciliation_mismatch)",
  "select count(*) n from ops.alert_rules where rule_code in ('fbm_late_ship','return_reason_spike','reconciliation_mismatch')",
  3,
);
await cmp(
  "module_code của rule mới hợp lệ (orders/finance)",
  "select count(*) n from ops.alert_rules where rule_code='fbm_late_ship' and module='orders'",
  1,
);
await cmp(
  "view public cho web (4)",
  "select count(*) n from information_schema.views where table_schema='public' and table_name in ('vexim_shop_health','vexim_health_issues','vexim_order_daily','vexim_fbm_queue')",
  4,
);
await cmp(
  "RLS bật trên 3 bảng mới",
  "select count(*) n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('sales','account_health') and c.relname in ('order_daily','snapshots','issues') and c.relrowsecurity",
  3,
);

// Cột phục vụ sync phải tồn tại
await cmp(
  "sales.orders có ship_state + last_updated_date + pii_stripped",
  "select count(*) n from information_schema.columns where table_schema='sales' and table_name='orders' and column_name in ('ship_state','last_updated_date','pii_stripped')",
  3,
);
await cmp(
  "finance.financial_events có amount_type + dedupe_key",
  "select count(*) n from information_schema.columns where table_schema='finance' and table_name='financial_events' and column_name in ('amount_type','dedupe_key')",
  2,
);

// Chốt PII (quyết định v1.1): không có cột định danh người mua
await cmp(
  "KHÔNG có cột PII trong sales/finance/account_health",
  "select count(*) n from information_schema.columns where table_schema in ('sales','finance','account_health') and column_name in ('buyer_name','buyer_email','buyer_phone_number','ship_address_1','recipient_name','ship_city','ship_postal_code')",
  0,
);

// View đọc được dữ liệu thật (join shop production) — đọc order_daily vừa ghi thử
const usShop = (
  await db.query("select id from connections.seller_accounts where marketplace = 'ATVPDKIKX0DER' limit 1")
).rows[0].id;
ok(
  await ex(
    `insert into sales.order_daily (seller_account_id, day, orders_count, units, sales_amount, fbm_unshipped, fbm_overdue, returns_count, returns_amount)
     values ('${usShop}', '2026-09-12', 12, 18, 1875.50, 3, 1, 2, 199.98)
     on conflict (seller_account_id, day) do update set orders_count = excluded.orders_count`,
    "seed order_daily 12/09",
  ),
  "ghi thử sales.order_daily",
);
const dailyView = await one(
  "select orders_count, fbm_overdue, returns_amount from public.vexim_order_daily where day = '2026-09-12'",
);
ok(
  Number(dailyView.orders_count) === 12 && Number(dailyView.fbm_overdue) === 1,
  `view vexim_order_daily đọc đúng dữ liệu thật (orders_count=${dailyView.orders_count}, fbm_overdue=${dailyView.fbm_overdue})`,
);

// Snapshot account_health + view H1
ok(
  await ex(
    `insert into account_health.snapshots (seller_account_id, day, marketplace_id, account_status, ahr_status, tone, score, rates)
     values ('${usShop}', '2026-09-12', 'ATVPDKIKX0DER', 'AT_RISK', 'FAIR', 'amber', 62,
             '[{"key":"orderDefectRate","rate":1.4,"targetValue":1,"targetCondition":"lt","tone":"red"}]'::jsonb)
     on conflict (seller_account_id, day, marketplace_id) do update set tone = excluded.tone`,
    "seed account_health.snapshots",
  ),
  "ghi thử account_health.snapshots",
);
const healthView = await one(
  "select account_status, tone, score from public.vexim_shop_health where marketplace_id = 'ATVPDKIKX0DER'",
);
ok(
  healthView.account_status === "AT_RISK" && healthView.tone === "amber",
  `view vexim_shop_health đọc đúng (status=${healthView.account_status}, tone=${healthView.tone})`,
);

// Idempotent: chạy lại 0010 không nhân đôi rule / không lỗi
ok(
  await ex(rd("migrations/0010_module_4_6_7_orders_finance_health.sql"), "0010 chạy LẦN 2"),
  "0010 idempotent",
);
await cmp(
  "0010 lần 2: vẫn đúng 3 rule mới (không nhân đôi)",
  "select count(*) n from ops.alert_rules where rule_code in ('fbm_late_ship','return_reason_spike','reconciliation_mismatch')",
  3,
);
await cmp(
  "0010 lần 2: view vẫn 4 (create or replace)",
  "select count(*) n from information_schema.views where table_schema='public' and table_name in ('vexim_shop_health','vexim_health_issues','vexim_order_daily','vexim_fbm_queue')",
  4,
);

// 0011 supplied by the operator; local in-memory DB only.
console.log("\n=== BƯỚC 10: 0011 public web views + RLS ===");
ok(await ex(rd("migrations/0011_web_public_views.sql"), "0011"), "0011 migration");
ok(await ex(rd("migrations/0011_web_public_views.sql"), "0011 lần 2"), "0011 idempotent");
await cmp("0011: 8 views security_invoker", `select count(*) n from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname in ('vexim_orders','vexim_order_items','vexim_returns','vexim_fbm_queue','vexim_settlements','vexim_financial_events','vexim_inventory_latest','vexim_inbound_shipments')
 and 'security_invoker=true'=any(c.reloptions)`, 8);
await cmp("0011: no PII or raw in web views", `select count(*) n from information_schema.columns where table_schema='public' and table_name like 'vexim_%' and column_name in ('raw','buyer_name','buyer_email','ship_address_1','recipient_name','ship_city','ship_postal_code')`, 0);

await ex("begin");
const otherShop = (await one(`select id from connections.seller_accounts where id <> '${usShop}' limit 1`)).id;
const limitedUser = 'eeee0000-0000-4000-8000-000000000011';
ok(await ex(`insert into auth.users(id,email) values ('${limitedUser}','local-only-0011@example.test');
 insert into iam.user_profiles(id,display_name,email) values ('${limitedUser}','Local view test','local-only-0011@example.test');
 insert into iam.assignments(user_id,seller_account_id,module) values ('${limitedUser}','${usShop}','orders');`), "0011 local restricted user");
for (const shop of [usShop, otherShop]) {
  ok(await ex(`insert into sales.orders(seller_account_id,amazon_order_id,status,channel,purchase_date,latest_ship_date,order_total)
    values ('${shop}','LOCAL-0011','Unshipped','MFN','2026-09-10','2026-09-13',30);
    insert into sales.order_items(order_id,sku,quantity,item_price)
    select id,'SKU-SMALL',1,10 from sales.orders where seller_account_id='${shop}' and amazon_order_id='LOCAL-0011';
    insert into sales.order_items(order_id,sku,quantity,item_price)
    select id,'SKU-MAIN',2,20 from sales.orders where seller_account_id='${shop}' and amazon_order_id='LOCAL-0011';
    insert into sales.returns_refunds(seller_account_id,amazon_order_id,return_date,reason) values ('${shop}','LOCAL-0011','2026-09-12','DEFECTIVE');
    insert into finance.settlements(seller_account_id,settlement_id,period_start,period_end,total_amount)
    values ('${shop}','LOCAL-SETTLEMENT','2026-09-01','2026-09-12',30);
    insert into finance.financial_events(seller_account_id,settlement_id,event_type,event_date,amount)
    values ('${shop}','LOCAL-SETTLEMENT','ProductSale','2026-09-12',30);`), "0011 fixtures for shop " + shop);
}
await ex(`set local role authenticated; select set_config('request.jwt.claim.sub','${limitedUser}',true);`);
for (const view of ['vexim_orders','vexim_order_items','vexim_returns','vexim_fbm_queue','vexim_settlements','vexim_financial_events']) {
  await cmp(`0011 RLS ${view}: forbidden shop hidden`, `select count(*) n from public.${view} where seller_account_id='${otherShop}'`, 0);
  const n = view === 'vexim_order_items' ? 2 : 1;
  await cmp(`0011 RLS ${view}: assigned shop visible`, `select count(*) n from public.${view} where seller_account_id='${usShop}'`, n);
}
const orderProjection = await one("select main_sku,latest_ship_date from public.vexim_orders where amazon_order_id='LOCAL-0011'");
ok(orderProjection?.main_sku === 'SKU-MAIN' && orderProjection?.latest_ship_date, "0011 lateral main SKU + real deadline");
await cmp("0011 settlement events join by external ID AND shop", `select count(*) n from public.vexim_financial_events e join public.vexim_settlements s on s.settlement_id=e.settlement_id and s.seller_account_id=e.seller_account_id where s.settlement_id='LOCAL-SETTLEMENT'`, 1);
for (const [screen, spec] of Object.entries(screens)) {
  ok(await ex(`select ${spec.select} from public.${spec.view} order by id limit 1`), `0011 web projection ${screen} readable as authenticated`);
}
await ex("reset role; rollback;");

// ===========================================================================
console.log("\n=== BƯỚC 11: 0012 + 0013 — view Module 1 (L1/L2/L4) & Module 2 ===");
// ===========================================================================
for (const m of ["0012_listings_views", "0013_pricing_views"]) {
  ok(await ex(rd(`migrations/${m}.sql`), m), `${m} chạy sạch (DO-block tự kiểm tra)`);
  ok(await ex(rd(`migrations/${m}.sql`), `${m} lần 2`), `${m} idempotent`);
}
await cmp(
  "0012: 2 view listing (vexim_listings, vexim_listing_queue)",
  "select count(*) n from information_schema.views where table_schema='public' and table_name in ('vexim_listings','vexim_listing_queue')",
  2,
);
await cmp(
  "0013: 1 view pricing (vexim_pricing — đúng những gì web đang đọc)",
  "select count(*) n from information_schema.views where table_schema='public' and table_name='vexim_pricing'",
  1,
);
await cmp(
  "0012+0013: view public đều security_invoker (RLS giữ nguyên)",
  `select count(*) n from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relname in ('vexim_listings','vexim_listing_queue','vexim_pricing')
     and 'security_invoker=true'=any(c.reloptions)`,
  3,
);
await cmp(
  "0012: KHÔNG phơi PII trong view listing",
  `select count(*) n from information_schema.columns where table_schema='public' and table_name like 'vexim_listing%'
     and column_name in ('buyer_name','buyer_email','buyer_phone_number','ship_address_1','recipient_name','raw')`,
  0,
);

await ex("begin");
const viewShop = (await one("select id from connections.seller_accounts order by seller_id limit 1")).id;
const viewOtherShop = (await one(`select id from connections.seller_accounts where id <> '${viewShop}' limit 1`)).id;
const viewUser = "ffff0000-0000-4000-8000-000000000021";
ok(
  await ex(`insert into auth.users(id,email) values ('${viewUser}','local-only-l3@example.test');
   insert into iam.user_profiles(id,display_name,email) values ('${viewUser}','Local L3 test','local-only-l3@example.test');
   insert into iam.assignments(user_id,seller_account_id,module,can_write) values ('${viewUser}','${viewShop}','listings',true);
   insert into catalog.listings(seller_account_id,sku,asin,title,status) values
     ('${viewShop}','LOCAL-L3-IN','B0LOCAL001','Local listing assigned shop','active'),
     ('${viewOtherShop}','LOCAL-L3-OUT','B0LOCAL002','Local listing other shop','active');`),
  "0012 fixture: 2 shop + user chỉ gán shop 1 (can_write)",
);
await ex(`set local role authenticated; select set_config('request.jwt.claim.sub','${viewUser}',true);`);
await cmp(
  "0012 RLS vexim_listings: shop ngoài quyền bị ẩn",
  `select count(*) n from public.vexim_listings where seller_account_id='${viewOtherShop}'`,
  0,
);
await cmp(
  "0012 RLS vexim_listings: shop được gán đọc được",
  `select count(*) n from public.vexim_listings where seller_account_id='${viewShop}' and sku='LOCAL-L3-IN'`,
  1,
);
await ex("reset role; rollback;");

// ===========================================================================
console.log("\n=== BƯỚC 12: 0014 — L3 Listing Editor (staging + lịch sử + máy trạng thái) ===");
// ===========================================================================
ok(
  await ex(rd("migrations/0014_listing_editor.sql"), "0014_listing_editor.sql"),
  "0014 chạy sạch (DO-block tự kiểm tra bảng/trigger/view/PII)",
);
await cmp(
  "0014: 3 bảng staging L3",
  "select count(*) n from information_schema.tables where table_schema='catalog' and table_name in ('listing_drafts','listing_draft_revisions','listing_publish_queue')",
  3,
);
await cmp(
  "0014: 3 view public cho web",
  "select count(*) n from information_schema.views where table_schema='public' and table_name in ('vexim_listing_drafts','vexim_listing_draft_history','vexim_listing_publish_queue')",
  3,
);
await cmp(
  "0014: 2 trigger (máy trạng thái + ghi lịch sử) — đếm distinct tên",
  "select count(distinct trigger_name) n from information_schema.triggers where event_object_schema='catalog' and event_object_table='listing_drafts' and trigger_name in ('trg_listing_draft_guard','trg_listing_draft_history')",
  2,
);
await cmp(
  "0014: 3 bảng staging đều bật RLS",
  "select count(*) n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='catalog' and c.relname in ('listing_drafts','listing_draft_revisions','listing_publish_queue') and c.relrowsecurity",
  3,
);
await cmp(
  "0014: view public không phơi email nội bộ/PII",
  `select count(*) n from information_schema.columns where table_schema='public' and table_name like 'vexim_listing_draft%'
     and column_name in ('actor_email','buyer_name','buyer_email','ship_address_1','recipient_name')`,
  0,
);
await cmp(
  "0014: chưa có policy DELETE trên listing_drafts (giữ lịch sử)",
  "select count(*) n from pg_policies where schemaname='catalog' and tablename='listing_drafts' and cmd='DELETE'",
  0,
);

// --- Chạy lần 2: idempotent, không nhân đôi policy/trigger ------------------
ok(await ex(rd("migrations/0014_listing_editor.sql"), "0014 lần 2"), "0014 idempotent");
await cmp(
  "0014 lần 2: policy listing_drafts không nhân đôi",
  "select count(*) n from pg_policies where schemaname='catalog' and tablename='listing_drafts'",
  3,
);

// --- Fixtures cho luồng draft → duyệt → publish ----------------------------
await ex("begin");
const l3Shop = (await one("select id from connections.seller_accounts order by seller_id limit 1")).id;
const l3Other = (await one(`select id from connections.seller_accounts where id <> '${l3Shop}' limit 1`)).id;
const operator = "ffff0000-0000-4000-8000-000000000031";
const lead = "ffff0000-0000-4000-8000-000000000032";
const outsider = "ffff0000-0000-4000-8000-000000000033";
ok(
  await ex(`insert into auth.users(id,email) values
     ('${operator}','local-l3-operator@example.test'),
     ('${lead}','local-l3-lead@example.test'),
     ('${outsider}','local-l3-outsider@example.test');
   insert into iam.user_profiles(id,display_name,email) values
     ('${operator}','L3 operator','local-l3-operator@example.test'),
     ('${lead}','L3 lead','local-l3-lead@example.test'),
     ('${outsider}','L3 outsider','local-l3-outsider@example.test');
   insert into iam.assignments(user_id,seller_account_id,module,can_write) values
     ('${operator}','${l3Shop}','listings',true),
     -- trưởng phòng: chỉ ĐỌC shop (can_write=false) → chứng minh nhánh
     -- "is_listing_approver() + can_read" của policy 0014 là đủ để duyệt
     ('${lead}','${l3Shop}','listings',false),
     ('${outsider}','${l3Other}','listings',true);
   insert into iam.role_assignments(user_id,role,department_id)
     select '${lead}','dept_lead',d.id from iam.departments d where d.code='listing';`),
  "0014 fixture: operator (shop 1, can_write) + dept_lead Listing + outsider (shop 2)",
);

// Operator tạo bản nháp
await ex(`set local role authenticated; select set_config('request.jwt.claim.sub','${operator}',true);`);
ok(
  await ex(`insert into catalog.listing_drafts(seller_account_id,sku,asin,product_type,payload)
            values ('${l3Shop}','LOCAL-L3-DRAFT','B0LOCAL003','PRODUCT',
                    '{"item_name":[{"value":"Local Draft","language_tag":"en_US"}]}'::jsonb);`),
  "0014 operator tạo bản nháp (draft hợp lệ)",
);
await cmp(
  "0014 revision #1 được ghi tự động (stage=created)",
  "select count(*) n from catalog.listing_draft_revisions r join catalog.listing_drafts d on d.id=r.draft_id where d.sku='LOCAL-L3-DRAFT' and r.stage='created'",
  1,
);
// Tạo thẳng trạng thái đã duyệt → chặn
ok(
  await mustBlock(`insert into catalog.listing_drafts(seller_account_id,sku,status,payload)
                 values ('${l3Shop}','LOCAL-L3-BAD','approved','{}'::jsonb);`),
  "0014 CHẶN: không tạo được bản nháp ở trạng thái approved",
);
// Gửi duyệt khi chưa có kết quả kiểm tra → chặn (cổng validation)
ok(
  await mustBlock(`update catalog.listing_drafts set status='pending_approval' where sku='LOCAL-L3-DRAFT';`),
  "0014 CHẶN: gửi duyệt khi thiếu validation",
);
ok(
  await mustBlock(`update catalog.listing_drafts
                 set status='pending_approval',
                     validation='{"errorCount":2,"warningCount":1,"issues":[]}'::jsonb
                 where sku='LOCAL-L3-DRAFT';`),
  "0014 CHẶN: gửi duyệt khi còn lỗi ERROR",
);
ok(
  await ex(`update catalog.listing_drafts
            set status='pending_approval',
                validation='{"errorCount":0,"warningCount":1,"issues":[],"source":"vexim-policy-v1"}'::jsonb
            where sku='LOCAL-L3-DRAFT';`),
  "0014 cho gửi duyệt khi validation.errorCount = 0",
);
await cmp(
  "0014 revision #2 stage=submitted",
  "select count(*) n from catalog.listing_draft_revisions r join catalog.listing_drafts d on d.id=r.draft_id where d.sku='LOCAL-L3-DRAFT' and r.stage='submitted'",
  1,
);
// Nhảy trạng thái thẳng sang published → chặn
ok(
  await mustBlock(`update catalog.listing_drafts set status='published' where sku='LOCAL-L3-DRAFT';`),
  "0014 CHẶN: pending_approval → published (nhảy bước)",
);
// Tác giả tự duyệt → chặn (4 mắt)
ok(
  await mustBlock(`update catalog.listing_drafts
                 set status='approved', decided_by='${operator}'
                 where sku='LOCAL-L3-DRAFT';`),
  "0014 CHẶN: tự duyệt bản do chính mình gửi (4 mắt)",
);
// Sửa nội dung khi đang chờ duyệt → chặn
ok(
  await mustBlock(`update catalog.listing_drafts
                 set payload=jsonb_set(payload,'{item_name}','[{"value":"Sua len khi cho duyet"}]'::jsonb)
                 where sku='LOCAL-L3-DRAFT';`),
  "0014 CHẶN: sửa nội dung khi đang chờ duyệt",
);

// User shop khác không duyệt được (RLS che dòng → 0 dòng đổi, không phải lỗi)
await ex(`select set_config('request.jwt.claim.sub','${outsider}',true);`);
await ex(`update catalog.listing_drafts set status='approved' where sku='LOCAL-L3-DRAFT';`);
await ex("reset role;");   // về superuser để đọc trung thực trạng thái thật của dòng
await cmp(
  "0014 RLS: user shop khác KHÔNG đổi được trạng thái bản nháp (vẫn pending_approval)",
  "select count(*) n from catalog.listing_drafts where sku='LOCAL-L3-DRAFT' and status='pending_approval'",
  1,
);
await ex(`set local role authenticated; select set_config('request.jwt.claim.sub','${outsider}',true);`);
await cmp(
  "0014 RLS: user shop khác không ĐỌC được bản nháp shop 1",
  "select count(*) n from catalog.listing_drafts where seller_account_id='" + l3Shop + "'",
  0,
);
await cmp(
  "0014 RLS: user shop khác không đọc được lịch sử shop 1",
  "select count(*) n from catalog.listing_draft_revisions where seller_account_id='" + l3Shop + "'",
  0,
);

// Trưởng phòng Listing duyệt
await ex(`select set_config('request.jwt.claim.sub','${lead}',true);`);
ok(
  await ex(`update catalog.listing_drafts
            set status='approved', decision_note='OK — đúng checklist nội dung'
            where sku='LOCAL-L3-DRAFT';`),
  "0014 trưởng phòng Listing duyệt được (khác người gửi)",
);
await cmp(
  "0014 revision #3 stage=approved + ghi lý do",
  "select count(*) n from catalog.listing_draft_revisions r join catalog.listing_drafts d on d.id=r.draft_id where d.sku='LOCAL-L3-DRAFT' and r.stage='approved' and r.note like 'OK%'",
  1,
);

// Đẩy hàng đợi publish + chặn update kết quả từ client
ok(
  await ex(`insert into catalog.listing_publish_queue(draft_id,seller_account_id,sku,marketplace_id,product_type,requirements,payload)
            select id,seller_account_id,sku,marketplace_id,product_type,requirements,
                   jsonb_build_object('productType',product_type,'patches','[]'::jsonb)
            from catalog.listing_drafts where sku='LOCAL-L3-DRAFT';`),
  "0014 đẩy được bản đã duyệt vào hàng đợi publish",
);
ok(
  await mustBlock(`update catalog.listing_publish_queue set status='accepted', submission_id='FAKE' where sku='LOCAL-L3-DRAFT';`),
  "0014 CHẶN: client không được sửa kết quả publish trong hàng đợi (revoke UPDATE)",
);
await ex(`set local role authenticated; select set_config('request.jwt.claim.sub','${lead}',true);`);
await cmp(
  "0014 RLS: view vexim_listing_drafts chỉ thấy shop được gán",
  `select count(*) n from public.vexim_listing_drafts where seller_account_id <> '${l3Shop}'`,
  0,
);
await ex("reset role;");

// service_role (worker) ghi kết quả publish — không cần JWT
await ex("begin; set local role service_role;");
ok(
  await ex(`update catalog.listing_publish_queue
            set status='accepted', submission_id='LOCAL-SUB-1', processed_at=now(), attempts=1
            where sku='LOCAL-L3-DRAFT';`),
  "0014 service_role (worker) ghi được kết quả publish",
);
ok(
  await ex(`update catalog.listing_drafts set status='publishing' where sku='LOCAL-L3-DRAFT';`),
  "0014 service_role chuyển approved → publishing",
);
ok(
  await ex(`update catalog.listing_drafts
            set status='published', published_at=now(), publish_status='ACCEPTED',
                publish_submission_id='LOCAL-SUB-1'
            where sku='LOCAL-L3-DRAFT';`),
  "0014 service_role đánh dấu published",
);
await cmp(
  "0014 lịch sử đủ 5 mốc (created/submitted/approved/publishing/published)",
  `select count(distinct r.stage) n from catalog.listing_draft_revisions r
    join catalog.listing_drafts d on d.id=r.draft_id
   where d.sku='LOCAL-L3-DRAFT'
     and r.stage in ('created','submitted','approved','publishing','published')`,
  5,
);
await cmp(
  "0014 revision tăng đơn điệu, không trùng số",
  "select count(*) n from (select draft_id, revision from catalog.listing_draft_revisions group by 1,2 having count(*) > 1) x",
  0,
);
// Lịch sử append-only với client: sửa/xoá revision bị chặn
await ex("reset role;");
await ex(`set local role authenticated; select set_config('request.jwt.claim.sub','${lead}',true);`);
ok(
  await mustBlock(`update catalog.listing_draft_revisions set note='sửa lén' where draft_id is not null;`),
  "0014 CHẶN: không sửa được lịch sử (revoke UPDATE)",
);
ok(
  await mustBlock(`delete from catalog.listing_draft_revisions where draft_id is not null;`),
  "0014 CHẶN: không xoá được lịch sử (revoke DELETE)",
);
await ex("reset role; rollback;");

// ===========================================================================
console.log("\n=== BƯỚC 13: 0014 — RPC public mà WEB dùng (tránh PGRST202/205) ===");
// ===========================================================================
await ex("begin");
const rpcShop = (await one("select id from connections.seller_accounts order by seller_id limit 1")).id;
const rpcOperator = "ffff0000-0000-4000-8000-000000000041";
const rpcLead = "ffff0000-0000-4000-8000-000000000042";
ok(
  await ex(`insert into auth.users(id,email) values
     ('${rpcOperator}','local-rpc-operator@example.test'),('${rpcLead}','local-rpc-lead@example.test');
   insert into iam.user_profiles(id,display_name,email) values
     ('${rpcOperator}','RPC operator','local-rpc-operator@example.test'),
     ('${rpcLead}','RPC lead','local-rpc-lead@example.test');
   insert into iam.assignments(user_id,seller_account_id,module,can_write) values
     ('${rpcOperator}','${rpcShop}','listings',true),
     ('${rpcLead}','${rpcShop}','listings',false);
   insert into iam.role_assignments(user_id,role,department_id)
     select '${rpcLead}','dept_lead',d.id from iam.departments d where d.code='listing';`),
  "0014 RPC fixture: operator (can_write) + trưởng phòng Listing (chỉ đọc shop)",
);

await ex(`set local role authenticated; select set_config('request.jwt.claim.sub','${rpcOperator}',true);`);
const saved = await one(`select * from public.vexim_save_listing_draft(
  null, '${rpcShop}', 'LOCAL-L3-RPC', 'PRODUCT', 'LISTING', 'ATVPDKIKX0DER', 'en_US',
  '{"item_name":[{"value":"RPC draft"}],"bullet_point":[{"value":"RPC bullet hop le"}]}'::jsonb,
  '{"errorCount":0,"warningCount":0,"issues":[],"source":"vexim-policy-v1"}'::jsonb, null)`);
ok(Boolean(saved?.draft_id) && saved?.created === true, "0014 RPC save: operator tạo được bản nháp");
const rpcDraftId = saved?.draft_id;
await cmp(
  "0014 RPC save ghi lịch sử revision #1 (stage=created)",
  `select count(*) n from catalog.listing_draft_revisions where draft_id='${rpcDraftId}' and stage='created'`,
  1,
);

// Operator gửi duyệt qua RPC
const submitted = await one(`select * from public.vexim_transition_listing_draft('${rpcDraftId}','submit',null)`);
ok(submitted?.status === "pending_approval", "0014 RPC submit: operator gửi duyệt được");

// Operator tự duyệt → trigger 4 mắt chặn
ok(
  await mustBlock(
    `select * from public.vexim_transition_listing_draft('${rpcDraftId}','approve','tự duyệt')`,
  ),
  "0014 RPC CHẶN: operator tự duyệt bản của mình (4 mắt)",
);

// Action không hợp lệ → chặn
ok(
  await mustBlock(`select * from public.vexim_transition_listing_draft('${rpcDraftId}','nuke',null)`),
  "0014 RPC CHẶN: action không hợp lệ",
);

// Trưởng phòng duyệt + publish qua RPC (không cần grant bảng cho client)
await ex(`select set_config('request.jwt.claim.sub','${rpcLead}',true);`);
const approved = await one(`select * from public.vexim_transition_listing_draft('${rpcDraftId}','approve','OK qua RPC')`);
ok(approved?.status === "approved", "0014 RPC approve: trưởng phòng Listing duyệt được");
const published = await one(`select * from public.vexim_transition_listing_draft('${rpcDraftId}','publish',null)`);
ok(published?.status === "publishing", "0014 RPC publish: chuyển approved → publishing");
await cmp(
  "0014 RPC publish đẩy 1 dòng vào hàng đợi (status=queued)",
  `select count(*) n from catalog.listing_publish_queue where draft_id='${rpcDraftId}' and status='queued'`,
  1,
);
await cmp(
  "0014 RPC publish KHÔNG nhân đôi hàng đợi khi gọi lại",
  `select count(*) n from catalog.listing_publish_queue where draft_id='${rpcDraftId}'`,
  1,
);
// User không thuộc shop gọi RPC save → chặn ở lớp quyền của RPC
const rpcOutsider = "ffff0000-0000-4000-8000-000000000043";
await ex("reset role;"); // tạo fixture bằng superuser rồi mới nhập vai user ngoài shop
await ex(`insert into auth.users(id,email) values ('${rpcOutsider}','local-rpc-out@example.test');
   insert into iam.user_profiles(id,display_name,email) values ('${rpcOutsider}','RPC outsider','local-rpc-out@example.test');`);
await ex(`set local role authenticated; select set_config('request.jwt.claim.sub','${rpcOutsider}',true);`);
ok(
  await mustBlock(`select * from public.vexim_save_listing_draft(
     null, '${rpcShop}', 'LOCAL-L3-HACK', 'PRODUCT', 'LISTING', 'ATVPDKIKX0DER', 'en_US',
     '{}'::jsonb, '{"errorCount":0,"warningCount":0,"issues":[]}'::jsonb, null)`),
  "0014 RPC CHẶN: user ngoài shop không lưu được bản nháp",
);
await ex("reset role; rollback;");

// ===========================================================================
console.log("\n=== BƯỚC 14: 0014 — RPC cho WORKER (claim + ghi kết quả publish) ===");
// ===========================================================================
await ex("begin");
const wShop = (await one("select id from connections.seller_accounts order by seller_id limit 1")).id;
const wOperator = "ffff0000-0000-4000-8000-000000000051";
const wLead = "ffff0000-0000-4000-8000-000000000052";
await ex("reset role;");
ok(
  await ex(`insert into auth.users(id,email) values
     ('${wOperator}','local-w-operator@example.test'),('${wLead}','local-w-lead@example.test');
   insert into iam.user_profiles(id,display_name,email) values
     ('${wOperator}','Worker operator','local-w-operator@example.test'),
     ('${wLead}','Worker lead','local-w-lead@example.test');
   insert into iam.assignments(user_id,seller_account_id,module,can_write) values
     ('${wOperator}','${wShop}','listings',true),('${wLead}','${wShop}','listings',false);
   insert into iam.role_assignments(user_id,role,department_id)
     select '${wLead}','dept_lead',d.id from iam.departments d where d.code='listing';`),
  "0014 worker fixture: operator + trưởng phòng Listing",
);

async function makePublishedDraft(sku, asin) {
  await ex("reset role;");
  await ex(`set local role authenticated; select set_config('request.jwt.claim.sub','${wOperator}',true);`);
  const saved = await one(`select * from public.vexim_save_listing_draft(
    null, '${wShop}', '${sku}', 'PRODUCT', 'LISTING', 'ATVPDKIKX0DER', 'en_US',
    '{"item_name":[{"value":"VEXIM Worker Test"}],"purchase_price":[{"value":10}]}'::jsonb,
    '{"errorCount":0,"warningCount":0,"issues":[]}'::jsonb, ${asin ? `'${asin}'` : "null"})`);
  await one(`select * from public.vexim_transition_listing_draft('${saved.draft_id}','submit',null)`);
  await ex(`select set_config('request.jwt.claim.sub','${wLead}',true);`);
  await one(`select * from public.vexim_transition_listing_draft('${saved.draft_id}','approve','ok')`);
  await one(`select * from public.vexim_transition_listing_draft('${saved.draft_id}','publish',null)`);
  return saved.draft_id;
}

const draftWithAsin = await makePublishedDraft("W-PATCH-1", "B0AAAAAAAA");
const draftNoAsin = await makePublishedDraft("W-PUT-1", null);
const qPatch = await one(`select method, payload from catalog.listing_publish_queue where draft_id='${draftWithAsin}'`);
ok(qPatch?.method === "patch", "0014 worker: ASIN có sẵn → hàng đợi dùng method=patch");
ok(
  Array.isArray(qPatch?.payload?.patches) &&
    qPatch.payload.patches.length === 2 &&
    qPatch.payload.patches.every((p) => p.op === "replace" && String(p.path).startsWith("/attributes/")),
  "0014 worker: patch body đúng JSON Patch (op/path/value), KHÔNG có marketplaceIds trong body",
);
const qPut = await one(`select method, payload from catalog.listing_publish_queue where draft_id='${draftNoAsin}'`);
ok(
  qPut?.method === "put" &&
    qPut?.payload?.requirements === "LISTING" &&
    qPut?.payload?.attributes?.item_name?.[0]?.value === "VEXIM Worker Test",
  "0014 worker: chưa có ASIN → hàng đợi dùng method=put (productType+requirements+attributes)",
);

// authenticated KHÔNG được gọi RPC worker
await ex(`select set_config('request.jwt.claim.sub','${wOperator}',true);`);
ok(
  await mustBlock(`select * from public.vexim_worker_claim_listing_publish('${wShop}', 10)`),
  "0014 worker CHẶN: RPC claim chỉ dành cho service_role",
);

// service_role: claim + ghi kết quả ACCEPTED
await ex("reset role;");
await ex("set local role service_role; select set_config('request.jwt.claim.sub','',true);");
const claimed = await one(`select * from public.vexim_worker_claim_listing_publish('${wShop}', 10)`);
ok(!claimed?.error, `0014 worker: claim chạy được bằng service_role (lỗi: ${claimed?.error ?? "không"})`);
const claimRows = await one(`select count(*)::int n from public.vexim_worker_claim_listing_publish('${wShop}', 10)`);
ok(claimRows?.n === 2, `0014 worker: claim trả đúng 2 dòng queued (nhận ${claimRows?.n})`);
const claimedRow = await one(`select * from public.vexim_worker_claim_listing_publish('${wShop}', 10) limit 1`);
ok(typeof claimedRow?.queue_id === "string" && typeof claimedRow?.payload === "object",
   "0014 worker: claim trả queue_id + payload để gọi SP-API");

const accepted = await one(`select * from public.vexim_worker_record_publish_result(
  '${claimedRow.queue_id}', 'accepted', 'SUBMISSION-123',
  '[{"code":"90220","severity":"WARNING","message":"cảnh báo"}]'::jsonb, null, null)`);
ok(accepted?.queue_status === "accepted" && accepted?.draft_status === "published",
   "0014 worker: ACCEPTED → queue accepted, bản nháp published");
await cmp(
  "0014 worker: kết quả ghi vào lịch sử (stage=published)",
  `select count(*) n from catalog.listing_draft_revisions
    where draft_id='${claimedRow.draft_id}' and stage='published'`,
  1,
);
const blockedRow = await one(`select * from public.vexim_worker_claim_listing_publish('${wShop}', 10) limit 1`);
const restricted = await one(`select * from public.vexim_worker_record_publish_result(
  '${blockedRow.queue_id}', 'blocked', null, '[]'::jsonb, null,
  'NOT_ELIGIBLE: Amazon không cho bán ASIN này')`);
ok(restricted?.queue_status === "blocked" && restricted?.draft_status === "publishing",
   "0014 worker: bị hạn chế danh mục → queue blocked, bản nháp giữ publishing để người xử lý");
const qBlock = await one(`select block_reason from catalog.listing_publish_queue where id='${blockedRow.queue_id}'`);
ok(String(qBlock?.block_reason ?? "").startsWith("NOT_ELIGIBLE"),
   "0014 worker: block_reason lưu lý do hạn chế danh mục");
ok(
  await mustBlock(`select * from public.vexim_worker_record_publish_result(
     '${blockedRow.queue_id}', 'nonsense', null, '[]'::jsonb, null, null)`),
  "0014 worker CHẶN: trạng thái publish ngoài enum",
);
await ex("reset role; rollback;");

// ============================================================================
console.log("\n=== BƯỚC 15: 0014 — cache JSON Schema product type (form động L3) ===");
// ============================================================================
// Web KHÔNG gọi SP-API (không có credential) → worker tải schema bằng
// getDefinitionsProductType rồi ghi vào cache; web đọc lại qua view public để
// dựng form động (required/maxLength/enum thật thay vì bảng hạn mức nội bộ).
// Lưu ý: BƯỚC 14 vừa `rollback` (đóng transaction) → dùng set_config/set role ở mức
// SESSION cho khối này, vì thiết lập LOCAL sẽ bị xoá ngay khi transaction đóng.
await ex("reset role;");
await ex("select set_config('request.jwt.claim.sub','',false);");
await ex("set role service_role;");
const schemaUpsert = await one(`select * from public.vexim_worker_upsert_product_type_schema(
  'ATVPDKIKX0DER', 'LUGGAGE', 'LISTING',
  '{"type":"object","required":["item_name","brand"],"properties":{"item_name":{"type":"array","maxLength":75}}}'::jsonb)`);
ok(
  schemaUpsert?.product_type === "LUGGAGE" && schemaUpsert?.marketplace_id === "ATVPDKIKX0DER",
  `0014 schema cache: service_role upsert được JSON Schema (lỗi: ${schemaUpsert?.error ?? "không"})`,
);
ok(
  await mustBlock(
    `select * from public.vexim_worker_upsert_product_type_schema('ATVPDKIKX0DER','HACK','LISTING','[]'::jsonb)`,
  ),
  "0014 schema cache CHẶN: chỉ nhận JSON object (mảng/chuỗi bị từ chối)",
);

await ex("reset role;");
await ex(`select set_config('request.jwt.claim.sub','${wOperator}',false);`);
await ex("set role authenticated;");
const cachedSchema = await one(`select product_type,
    schema->'properties'->'item_name'->>'maxLength' as max_len
  from public.vexim_listing_product_type_schemas
 where marketplace_id='ATVPDKIKX0DER' and product_type='LUGGAGE'`);
ok(
  cachedSchema?.max_len === "75",
  `0014 schema cache: authenticated đọc được schema qua view (maxLength=${cachedSchema?.max_len ?? "?"})`,
);
ok(
  await mustBlock(`insert into catalog.listing_product_type_schemas (marketplace_id, product_type, schema)
    values ('ATVPDKIKX0DER','HACK','{}'::jsonb)`),
  "0014 schema cache CHẶN: authenticated không ghi thẳng vào cache",
);
ok(
  await mustBlock(
    `select * from public.vexim_worker_upsert_product_type_schema('ATVPDKIKX0DER','HACK','LISTING','{"a":1}'::jsonb)`,
  ),
  "0014 schema cache CHẶN: RPC upsert chỉ dành cho service_role",
);
await ex("reset role;");
await ex("select set_config('request.jwt.claim.sub','',false);");
await ex("rollback;");

// ============================================================================
console.log("\n=== BƯỚC 16: 0015 — F3 bồi hoàn FBA (claims) + F4 lợi nhuận SKU ===");
// ============================================================================
ok(
  await ex(rd("migrations/0015_finance_claims_profit.sql"), "0015_finance_claims_profit.sql"),
  "0015 chạy sạch (DO-block tự kiểm tra bảng/trigger/view/RPC/PII)",
);
await cmp(
  "0015: 3 bảng F3-F4",
  "select count(*) n from information_schema.tables where table_schema='finance' and table_name in ('reimbursement_claims','reimbursement_claim_events','sku_profit_daily')",
  3,
);
await cmp(
  "0015: 4 view public cho web",
  "select count(*) n from information_schema.views where table_schema='public' and table_name in ('vexim_reimbursements','vexim_reimbursement_claims','vexim_reimbursement_claim_events','vexim_sku_profit')",
  4,
);
await cmp(
  "0015: 2 trigger (máy trạng thái + lịch sử) — đếm distinct tên",
  "select count(distinct trigger_name) n from information_schema.triggers where event_object_schema='finance' and event_object_table='reimbursement_claims' and trigger_name in ('trg_reimbursement_claim_guard','trg_reimbursement_claim_history')",
  2,
);
await cmp(
  "0015: 3 bảng F3-F4 đều bật RLS",
  "select count(*) n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='finance' and c.relname in ('reimbursement_claims','reimbursement_claim_events','sku_profit_daily') and c.relrowsecurity",
  3,
);
await cmp(
  "0015: sku_profit_daily KHÔNG cho authenticated ghi (worker tính)",
  "select count(*) n from pg_policies where schemaname='finance' and tablename='sku_profit_daily' and cmd <> 'SELECT'",
  0,
);
await cmp(
  "0015: view F3 không phơi email nội bộ/PII",
  `select count(*) n from information_schema.columns where table_schema='public' and table_name like 'vexim_reimbursement%'
     and column_name in ('actor_email','buyer_name','buyer_email','ship_address_1','recipient_name')`,
  0,
);
ok(
  await ex(rd("migrations/0015_finance_claims_profit.sql"), "0015 lần 2"),
  "0015 idempotent",
);
await cmp(
  "0015 lần 2: policy reimbursement_claims không nhân đôi",
  "select count(*) n from pg_policies where schemaname='finance' and tablename='reimbursement_claims'",
  3,
);

// --- F3: import report → khoản nghi ngờ → nộp case → duyệt → tiền về --------
await ex("begin");
const f3Shop = (await one("select id from connections.seller_accounts order by seller_id limit 1")).id;
const f3Operator = "e1000000-0000-4000-8000-000000000001";
const f3Lead     = "e1000000-0000-4000-8000-000000000002";
const f3Outsider = "e1000000-0000-4000-8000-000000000003";
await ex("reset role;");
ok(
  await ex(`insert into auth.users(id,email) values
     ('${f3Operator}','local-f3-operator@example.test'),
     ('${f3Lead}','local-f3-lead@example.test'),
     ('${f3Outsider}','local-f3-outsider@example.test');
   insert into iam.user_profiles(id,display_name,email) values
     ('${f3Operator}','F3 operator','local-f3-operator@example.test'),
     ('${f3Lead}','F3 trưởng phòng Tài chính','local-f3-lead@example.test'),
     ('${f3Outsider}','F3 outsider','local-f3-outsider@example.test');
   insert into iam.assignments(user_id,seller_account_id,module,can_write) values
     ('${f3Operator}','${f3Shop}','finance',true),
     ('${f3Lead}','${f3Shop}','finance',true);
   insert into iam.role_assignments(user_id,role)
     values ('${f3Operator}','operator');
   insert into iam.role_assignments(user_id,role,department_id)
     select '${f3Lead}','dept_lead',d.id from iam.departments d where d.code='finance';`),
  "0015 F3 fixture: operator + trưởng phòng Tài chính + outsider",
);

// 1) worker import report GET_FBA_REIMBURSEMENTS_DATA (idempotent theo dedupe_key)
await ex("reset role;");
await ex("select set_config('request.jwt.claim.sub','',false);");
await ex("set role service_role;");
const f3Import = await one(`select * from public.vexim_worker_upsert_reimbursements('${f3Shop}', '[
  {"reimbursementId":"REIMB-1","caseId":"CASE-AMZ-1","reason":"Lost","sku":"SKU-F3","asin":"B0F3",
   "currency":"USD","amountPerUnit":12.5,"amountTotal":25,"quantityReimbursedCash":2,
   "approvalDate":"2026-09-01","dedupeKey":"REIMB-1:SKU-F3:Lost"},
  {"reimbursementId":"REIMB-2","caseId":"CASE-AMZ-2","reason":"Damaged","sku":"SKU-F3","asin":"B0F3",
   "currency":"USD","amountPerUnit":9.99,"amountTotal":9.99,"quantityReimbursedInventory":1,
   "approvalDate":"2026-09-02","dedupeKey":"REIMB-2:SKU-F3:Damaged"}]'::jsonb)`);
ok(f3Import?.inserted === 2, `0015 F3: import 2 dòng reimbursement (nhận ${f3Import?.inserted})`);
const f3Import2 = await one(`select * from public.vexim_worker_upsert_reimbursements('${f3Shop}', '[
  {"reimbursementId":"REIMB-1","reason":"Lost","sku":"SKU-F3","amountTotal":25,"dedupeKey":"REIMB-1:SKU-F3:Lost"}]'::jsonb)`);
ok(
  f3Import2?.inserted === 0 && f3Import2?.updated === 1,
  `0015 F3: import lại KHÔNG nhân đôi (inserted=${f3Import2?.inserted}, updated=${f3Import2?.updated})`,
);

// 2) worker ghi khoản NGHI NGỜ (chưa có giá vốn → estimated_amount NULL, không bịa số)
const f3Claims = await one(`select * from public.vexim_worker_upsert_claims('${f3Shop}', '[
  {"sku":"SKU-F3","fnsku":"X00F3","asin":"B0F3","category":"lost_fc","source":"ledger",
   "sourceRef":"LEDGER-REF-1","sourceDate":"2026-09-05","sourceReason":"MISSING","quantity":3,
   "currency":"USD"}]'::jsonb)`);
ok(f3Claims?.inserted === 1, `0015 F3: worker chèn 1 khoản nghi ngờ (nhận ${f3Claims?.inserted})`);
const f3Claim = await one(`select id, status, estimated_amount, unit_cost from finance.reimbursement_claims where seller_account_id='${f3Shop}' and source_ref='LEDGER-REF-1'`);
ok(
  f3Claim?.status === "suspected" && f3Claim?.estimated_amount === null,
  `0015 F3: thiếu giá vốn → estimated_amount NULL (nhận ${JSON.stringify(f3Claim?.estimated_amount)})`,
);

// 3) worker ĐƯỢC refresh khoản còn suspected
const f3Refresh = await one(`select * from public.vexim_worker_upsert_claims('${f3Shop}', '[
  {"sku":"SKU-F3","category":"lost_fc","source":"ledger","sourceRef":"LEDGER-REF-1",
   "quantity":3,"unitCost":12.5,"estimatedAmount":37.5}]'::jsonb)`);
const f3Claim2 = await one(`select estimated_amount from finance.reimbursement_claims where id='${f3Claim.id}'`);
ok(
  f3Refresh?.refreshed === 1 && Number(f3Claim2?.estimated_amount) === 37.5,
  `0015 F3: refresh khoản suspected + giá trị ước tính 37.5 (nhận ${f3Claim2?.estimated_amount})`,
);

// 4) người dùng: suspected → to_claim → filed (phải có mã case) → approved (phải có kết luận)
await ex("reset role;");
await ex(`select set_config('request.jwt.claim.sub','${f3Operator}',false);`);
await ex("set role authenticated;");
const f3ToClaim = await one(`select * from public.vexim_update_reimbursement_claim('${f3Claim.id}', 'to_claim', null, null, 'Đủ căn cứ nộp')`);
ok(f3ToClaim?.status === "to_claim", `0015 F3: suspected → to_claim (nhận ${f3ToClaim?.status})`);
ok(
  await mustBlock(`select * from public.vexim_update_reimbursement_claim('${f3Claim.id}', 'file', null, null, null)`),
  "0015 F3 CHẶN: nộp case mà không có mã case Amazon",
);
const f3File = await one(`select * from public.vexim_update_reimbursement_claim('${f3Claim.id}', 'file', 'CASE-VEXIM-77', null, 'Đã nộp Seller Central')`);
ok(f3File?.status === "filed", `0015 F3: to_claim → filed kèm mã case (nhận ${f3File?.status})`);
ok(
  await mustBlock(`select * from public.vexim_update_reimbursement_claim('${f3Claim.id}', 'approve', null, null, null)`),
  "0015 F3 CHẶN: operator thường không được kết luận claim",
);
await ex("reset role;");
await ex(`select set_config('request.jwt.claim.sub','${f3Lead}',false);`);
await ex("set role authenticated;");
const f3Approve = await one(`select * from public.vexim_update_reimbursement_claim('${f3Claim.id}', 'approve', 'CASE-VEXIM-77', null, 'Amazon đã duyệt')`);
ok(f3Approve?.status === "approved", `0015 F3: trưởng phòng Tài chính duyệt được (nhận ${f3Approve?.status})`);
ok(
  await mustBlock(`select * from public.vexim_update_reimbursement_claim('${f3Claim.id}', 'paid', null, null, 'xong')`),
  "0015 F3 CHẶN: đánh dấu đã về tiền mà không có số tiền thực nhận",
);
const f3Paid = await one(`select * from public.vexim_update_reimbursement_claim('${f3Claim.id}', 'paid', null, 37.5, 'Nhận đủ qua Finances')`);
ok(f3Paid?.status === "paid", `0015 F3: approved → paid (nhận ${f3Paid?.status})`);
const f3Age = await one(`select age_hours from public.vexim_reimbursement_claims where id='${f3Claim.id}'`);
ok(typeof f3Age?.age_hours === "number" || f3Age?.age_hours !== undefined,
   `0015 F3: view trả age_hours để áp SLA 48h (nhận ${f3Age?.age_hours})`);
// Lịch sử: detected (insert) + updated (worker refresh) + 4 lần đổi trạng thái
const f3Stages = await one(`select string_agg(distinct stage, ',' order by stage) stages,
    count(*)::int total from finance.reimbursement_claim_events where claim_id='${f3Claim.id}'`);
ok(
  f3Stages?.stages === "approved,detected,filed,paid,to_claim,updated" && f3Stages?.total === 6,
  `0015 F3: lịch sử claim đủ mốc (${f3Stages?.stages} · ${f3Stages?.total} dòng)`,
);

// 5) nhảy bước trái phép + đổi khoá nguồn — chạy bằng người CÓ quyền ghi trên
//    shop, nếu không RLS chỉ làm câu lệnh khớp 0 dòng và trigger không được test.
await ex("reset role;");
await ex(`select set_config('request.jwt.claim.sub','${f3Operator}',false);`);
await ex("set role authenticated;");
ok(
  await mustBlock(`update finance.reimbursement_claims set status='filed' where id='${f3Claim.id}'`),
  "0015 F3 CHẶN: paid → filed (ngoài máy trạng thái)",
);
ok(
  await mustBlock(`update finance.reimbursement_claims set sku='SKU-DOI-TEN' where id='${f3Claim.id}'`),
  "0015 F3 CHẶN: đổi SKU của khoản claim",
);
// worker cũng không được đụng khoản con người đang giữ
await ex("reset role;");
await ex("select set_config('request.jwt.claim.sub','',false);");
await ex("set role service_role;");
await one(`select * from public.vexim_worker_upsert_claims('${f3Shop}', '[
  {"sku":"SKU-F3","category":"lost_fc","source":"ledger","sourceRef":"LEDGER-REF-1",
   "quantity":99,"estimatedAmount":999}]'::jsonb)`);
const f3AfterWorker = await one(`select quantity, estimated_amount from finance.reimbursement_claims where id='${f3Claim.id}'`);
ok(
  Number(f3AfterWorker?.quantity) === 3 && Number(f3AfterWorker?.estimated_amount) !== 999,
  `0015 F3 CHẶN: worker không refresh được khoản đã rời suspected (quantity=${f3AfterWorker?.quantity})`,
);

// 6) RLS: user không được gán shop không đọc/ghi được claim
await ex("reset role;");
await ex(`select set_config('request.jwt.claim.sub','${f3Outsider}',false);`);
await ex("set role authenticated;");
await cmp(
  "0015 F3: user ngoài shop thấy 0 khoản claim (RLS)",
  `select count(*) n from public.vexim_reimbursement_claims where seller_account_id='${f3Shop}'`,
  0,
);
ok(
  await mustBlock(`select * from public.vexim_update_reimbursement_claim('${f3Claim.id}', 'close', null, null, 'x')`),
  "0015 F3 CHẶN: user ngoài shop không ghi được claim",
);

// --- F4: giá vốn hiệu lực + lợi nhuận SKU ----------------------------------
await ex("reset role;");
await ex("select set_config('request.jwt.claim.sub','',false);");
await ex("set role service_role;");
await ex(`insert into catalog.cost_inputs (seller_account_id, sku, unit_cost, currency, effective_from, effective_to)
  values ('${f3Shop}','SKU-F4',10.00,'USD','2026-08-01','2026-09-01'),
         ('${f3Shop}','SKU-F4',12.00,'USD','2026-09-01',null)`);
const f4Cost = await one(`select * from public.vexim_worker_effective_costs('${f3Shop}', '2026-09-05')`);
ok(
  f4Cost?.sku === "SKU-F4" && Number(f4Cost?.unit_cost) === 12,
  `0015 F4: giá vốn hiệu lực theo ngày = 12 (nhận ${f4Cost?.unit_cost})`,
);
const f4Old = await one(`select * from public.vexim_worker_effective_costs('${f3Shop}', '2026-08-15')`);
ok(Number(f4Old?.unit_cost) === 10, `0015 F4: giá vốn hiệu lực ngày cũ = 10 (nhận ${f4Old?.unit_cost})`);

const f4Profit = await one(`select * from public.vexim_worker_upsert_profit('${f3Shop}', '[
  {"sku":"SKU-F4","day":"2026-09-05","currency":"USD","units":4,"revenue":200,"refunds":0,
   "amazonFees":30,"promo":5,"cogs":48,"grossProfit":117,"unitCost":12,"feeSource":"settled"},
  {"sku":"SKU-NOCOST","day":"2026-09-05","currency":"USD","units":1,"revenue":25,
   "amazonFees":4,"feeSource":"settled"}]'::jsonb)`);
ok(f4Profit?.upserted === 2, `0015 F4: worker ghi 2 dòng lợi nhuận (nhận ${f4Profit?.upserted})`);
const f4Row = await one(`select gross_profit, cogs, fee_source from finance.sku_profit_daily
   where seller_account_id='${f3Shop}' and sku='SKU-F4' and day='2026-09-05'`);
ok(Number(f4Row?.gross_profit) === 117 && f4Row?.fee_source === "settled",
   `0015 F4: lãi gộp lưu đúng (${f4Row?.gross_profit} · ${f4Row?.fee_source})`);
const f4NoCost = await one(`select cogs, gross_profit from finance.sku_profit_daily
   where seller_account_id='${f3Shop}' and sku='SKU-NOCOST'`);
ok(f4NoCost?.cogs === null && f4NoCost?.gross_profit === null,
   `0015 F4: thiếu giá vốn → lãi gộp NULL, KHÔNG bịa số (cogs=${f4NoCost?.cogs})`);
// worker ghi lại cùng ngày → replace, không cộng dồn
await one(`select * from public.vexim_worker_upsert_profit('${f3Shop}', '[
  {"sku":"SKU-F4","day":"2026-09-05","currency":"USD","units":4,"revenue":200,"amazonFees":30,
   "cogs":48,"grossProfit":122,"feeSource":"fees_api"}]'::jsonb)`);
const f4Again = await one(`select count(*)::int n, max(gross_profit) gp from finance.sku_profit_daily
   where seller_account_id='${f3Shop}' and sku='SKU-F4' and day='2026-09-05'`);
ok(f4Again?.n === 1 && Number(f4Again?.gp) === 122,
   `0015 F4: ghi lại cùng ngày thay thế (không cộng dồn) — ${f4Again?.n} dòng, lãi ${f4Again?.gp}`);

// authenticated KHÔNG gọi được RPC worker của F4
await ex("reset role;");
await ex(`select set_config('request.jwt.claim.sub','${f3Operator}',false);`);
await ex("set role authenticated;");
ok(
  await mustBlock(`select * from public.vexim_worker_upsert_profit('${f3Shop}', '[]'::jsonb)`),
  "0015 F4 CHẶN: RPC ghi lợi nhuận chỉ dành cho service_role",
);
ok(
  await mustBlock(`insert into finance.sku_profit_daily (seller_account_id, sku, day)
     values ('${f3Shop}','SKU-F4','2026-09-06')`),
  "0015 F4 CHẶN: authenticated không ghi thẳng bảng lợi nhuận",
);

await ex("reset role; rollback;");

// ============================================================================
console.log("\n=== BƯỚC 17: 0016 — ĐỢT A gỡ chặn dữ liệu lõi (giá vốn · listing · pricing) ===");
// ============================================================================
ok(
  await ex(rd("migrations/0016_core_data_unblock.sql"), "0016_core_data_unblock.sql"),
  "0016 chạy sạch (DO-block tự kiểm tra cột/view/RPC/quyền/PII)",
);
await cmp(
  "0016: catalog.listings đủ 11 cột để GHI dữ liệu thật (L1/L2/L4)",
  `select count(*) n from information_schema.columns
    where table_schema='catalog' and table_name='listings'
      and column_name in ('issues','buyable','discoverable','product_type','quantity',
                          'stranded_reason','issue_errors','issue_warnings',
                          'enforcement_actions','last_source','last_synced_at')`,
  11,
);
// Web đọc hai view này bằng chuỗi select cố định (LISTINGS_SELECT / LISTING_QUEUE_SELECT
// trong web/src/lib/data/listing-model.ts) → thiếu 1 cột là PostgREST trả PGRST204 và
// SẬP CẢ TRANG, nên chốt ở đây thay vì để production phát hiện.
await cmp(
  "0016: vexim_listings phơi đủ 8 cột mới cho L1/L2 (web select bằng tên)",
  `select count(*) n from information_schema.columns
    where table_schema='public' and table_name='vexim_listings'
      and column_name in ('product_type','buyable','discoverable','quantity',
                          'stranded_reason','enforcement_actions','last_source','last_synced_at')`,
  8,
);
await cmp(
  "0016: vexim_listing_queue phơi đủ 10 cột mới cho L4 (kể cả buyable/discoverable)",
  `select count(*) n from information_schema.columns
    where table_schema='public' and table_name='vexim_listing_queue'
      and column_name in ('product_type','buyable','discoverable','quantity','stranded_reason',
                          'enforcement_actions','last_source','last_synced_at','issues','error_count')`,
  10,
);
await cmp(
  "0016: queue KHÔNG có cột offer (web dùng select riêng — tránh PGRST204)",
  `select count(*) n from information_schema.columns
    where table_schema='public' and table_name='vexim_listing_queue'
      and column_name in ('buy_box_won','buy_box_price','competitor_price','offer_captured_at')`,
  0,
);
await cmp(
  "0016: catalog.cost_inputs có cột vết (updated_at/updated_by/source_ref)",
  `select count(*) n from information_schema.columns
    where table_schema='catalog' and table_name='cost_inputs'
      and column_name in ('updated_at','updated_by','source_ref')`,
  3,
);
await cmp(
  "0016: 6 view public (2 listing + pricing + 2 giá vốn + shops)",
  `select count(*) n from information_schema.views where table_schema='public'
     and table_name in ('vexim_listings','vexim_listing_queue','vexim_pricing',
                        'vexim_cost_inputs','vexim_cost_coverage','vexim_shops')`,
  6,
);
await cmp(
  "0016: vexim_pricing có giá vốn + giá sàn + biên + nhãn nguồn",
  `select count(*) n from information_schema.columns
    where table_schema='public' and table_name='vexim_pricing'
      and column_name in ('unit_cost','cost_currency','cost_effective_from','floor_price',
                          'gross_profit','margin_pct','below_floor','cost_basis',
                          'referral_rate_used','min_margin_rate')`,
  10,
);
await cmp(
  "0016: cả 6 view đều security_invoker (RLS bảng gốc vẫn áp)",
  `select count(*) n from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public'
      and c.relname in ('vexim_listings','vexim_listing_queue','vexim_pricing',
                        'vexim_cost_inputs','vexim_cost_coverage','vexim_shops')
      and 'security_invoker=true'=any(c.reloptions)`,
  6,
);
await cmp(
  "0016: RPC worker bị revoke khỏi authenticated (chỉ service_role)",
  `select count(*) n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname='public'
      and p.proname = 'vexim_worker_upsert_listings'
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')`,
  0,
);
await cmp(
  "0016: view mới KHÔNG phơi PII/email nội bộ/merchant token",
  `select count(*) n from information_schema.columns where table_schema='public'
     and table_name in ('vexim_listings','vexim_listing_queue','vexim_pricing',
                        'vexim_cost_inputs','vexim_cost_coverage','vexim_shops')
     and column_name in ('buyer_name','buyer_email','buyer_phone_number','ship_address_1',
                         'recipient_name','actor_email','email','imported_by_email','seller_id')`,
  0,
);
ok(
  await ex(rd("migrations/0016_core_data_unblock.sql"), "0016 lần 2"),
  "0016 idempotent",
);
await cmp(
  "0016 lần 2: policy không nhân đôi",
  "select count(*) n from pg_policies where schemaname='catalog' and tablename='cost_inputs'",
  2,
);
await cmp(
  "0016 lần 2: pricing_defaults vẫn đúng 1 dòng cấu hình",
  "select count(*) n from catalog.pricing_defaults",
  1,
);

// PGlite trả cột `date` dưới dạng Date → chuẩn về chuỗi để so sánh
const dstr = (v) => (v && typeof v.toISOString === "function" ? v.toISOString() : String(v ?? ""));
/** gọi hàm returns jsonb và bóc kết quả (select f(...) → 1 cột tên hàm) */
const rpc = async (sql) => (await one(`select ${sql} as res`)).res;

await ex("begin");
const aShop = (await one("select id from connections.seller_accounts order by seller_id limit 1")).id;
const aOtherShop = (await one(`select id from connections.seller_accounts where id <> '${aShop}' limit 1`)).id;
const aFin      = "a1000000-0000-4000-8000-000000000001";  // operator module finance
const aListing  = "a1000000-0000-4000-8000-000000000002";  // operator module listings
const aStranger = "a1000000-0000-4000-8000-000000000003";  // không được gán shop
await ex("reset role;");
ok(
  await ex(`insert into auth.users(id,email) values
     ('${aFin}','local-a-fin@example.test'),
     ('${aListing}','local-a-listing@example.test'),
     ('${aStranger}','local-a-stranger@example.test');
   insert into iam.user_profiles(id,display_name,email) values
     ('${aFin}','A finance','local-a-fin@example.test'),
     ('${aListing}','A listing','local-a-listing@example.test'),
     ('${aStranger}','A stranger','local-a-stranger@example.test');
   insert into iam.assignments(user_id,seller_account_id,module,can_write) values
     ('${aFin}','${aShop}','finance',true),
     ('${aListing}','${aShop}','listings',true);
   insert into iam.role_assignments(user_id,role) values
     ('${aFin}','operator'),('${aListing}','operator');`),
  "0016 fixture: 3 user (finance / listings / ngoài shop)",
);
const asA = async (u) => {
  await ex("reset role;");
  await ex(`select set_config('request.jwt.claim.sub','${u ?? ""}',false);`);
  await ex("set role authenticated;");
};

// --- 1. Nhập giá vốn TAY: thang hiệu lực, không nhân đôi ---------------------
await asA(aFin);
let res = await rpc(`public.vexim_upsert_cost_input('${aShop}','sku-a',10,'USD','2026-08-01',null,'lô 1')`);
ok(res?.inserted === 1, `0016 giá vốn: nhập bậc đầu (inserted=${res?.inserted})`);
res = await rpc(`public.vexim_upsert_cost_input('${aShop}','sku-a',12,'USD','2026-09-01',null,'lô 2')`);
ok(res?.inserted === 1 && res?.closed_previous === 1,
   `0016 giá vốn: bậc mới TỰ cắt ngọn bậc cũ tại mốc hiệu lực (closed=${res?.closed_previous})`);
const ladder = await db.query(
  `select unit_cost, effective_from, effective_to from catalog.cost_inputs
    where seller_account_id='${aShop}' and sku='SKU-A' order by effective_from`);
ok(
  ladder.rows.length === 2 &&
  dstr(ladder.rows[0].effective_to).startsWith("2026-09-01") &&
  ladder.rows[1].effective_to === null,
  `0016 giá vốn: thang 2 bậc [08-01→09-01) = 10, [09-01→∞) = 12 — ${JSON.stringify(ladder.rows.map(r => [r.unit_cost, dstr(r.effective_to)]))}`,
);
res = await rpc(`public.vexim_upsert_cost_input('${aShop}','sku-a',13,'USD','2026-09-01',null,'sửa lô 2')`);
ok(res?.updated === 1 && res?.superseded === 1,
   `0016 giá vốn: nhập lại cùng mốc = CẬP NHẬT, không nhân đôi bậc (updated=${res?.updated})`);
await cmp(
  "0016 giá vốn: vẫn đúng 2 bậc sau khi sửa",
  `select count(*) n from catalog.cost_inputs where seller_account_id='${aShop}' and sku='SKU-A'`,
  2,
);
ok(
  Number((await one(`select catalog.effective_cost('${aShop}','SKU-A','2026-09-05') as v`)).v) === 13,
  "0016 giá vốn: effective_cost() ngày hiện hành = 13",
);
ok(
  Number((await one(`select catalog.effective_cost('${aShop}','SKU-A','2026-08-15') as v`)).v) === 10,
  "0016 giá vốn: effective_cost() ngày cũ = 10 (F4 tính đúng theo thời điểm)",
);
ok(
  await mustBlock(`select public.vexim_upsert_cost_input('${aShop}','sku-b',5,'USD','2026-09-01','2026-08-01',null)`),
  "0016 giá vốn CHẶN: effective_to trước effective_from",
);
ok(
  await mustBlock(`select public.vexim_upsert_cost_input('${aShop}','SKU-A',-1,'USD','2026-10-01',null,null)`),
  "0016 giá vốn CHẶN: giá vốn âm",
);
ok(
  await mustBlock(`select public.vexim_upsert_cost_input('${aShop}','AAAAAAAAAA-BBBBBBBBBB-CCCCCCCCCC-DDDDDDDDDDD',1,'USD','2026-10-01',null,null)`),
  "0016 giá vốn CHẶN: SKU dài hơn 40 ký tự (giới hạn seller-sku Amazon)",
);

// --- 2. Quyền nhập giá vốn --------------------------------------------------
await asA(aListing);
ok(
  await mustBlock(`select public.vexim_upsert_cost_input('${aShop}','sku-c',7,'USD','2026-09-01',null,null)`),
  "0016 giá vốn CHẶN: user có can_write nhưng KHÔNG thuộc module finance",
);
await asA(aStranger);
ok(
  await mustBlock(`select public.vexim_upsert_cost_input('${aOtherShop}','sku-c',7,'USD','2026-09-01',null,null)`),
  "0016 giá vốn CHẶN: user ngoài shop (RLS + can_write_seller_account)",
);
await ex("reset role;");
await ex("select set_config('request.jwt.claim.sub','',false);");
await ex("set role service_role;");
ok(
  await mustBlock(`select public.vexim_upsert_cost_input('${aShop}','sku-c',7,'USD','2026-09-01',null,null)`),
  "0016 giá vốn CHẶN: worker (không phiên đăng nhập) không dùng RPC nhập tay",
);

// --- 3. Import CSV: parse số/ngày kiểu local + ATOMIC -----------------------
await asA(aFin);
res = await rpc(`public.vexim_import_cost_inputs('${aShop}', '[
  {"sku":"CSV-1","unit_cost":"9,5","currency":"usd","effective_from":"2026-07-01","effective_to":"","note":"lô 7"},
  {"sku":"CSV-2","unit_cost":"1.234,56","currency":"USD","effective_from":"01/07/2026"},
  {"sku":"CSV-3","unit_cost":4.2,"currency":"USD","effective_from":"2026-07-01"}
]'::jsonb, 'gia-von-2026-07.csv')`);
ok(res?.ok === true && res?.rows === 3 && res?.inserted === 3,
   `0016 CSV: import 3 dòng thành công (${JSON.stringify(res)})`);
const csv2 = await one(`select unit_cost, effective_from, currency from catalog.cost_inputs
   where seller_account_id='${aShop}' and sku='CSV-2'`);
ok(Number(csv2?.unit_cost) === 1234.56 && dstr(csv2?.effective_from).startsWith("2026-07-01"),
   `0016 CSV: parse số "1.234,56" → 1234.56 và ngày "01/07/2026" → 2026-07-01 (nhận ${csv2?.unit_cost} · ${dstr(csv2?.effective_from)})`);
const csv1 = await one(`select unit_cost, currency, source, source_ref from catalog.cost_inputs
   where seller_account_id='${aShop}' and sku='CSV-1'`);
ok(Number(csv1?.unit_cost) === 9.5 && csv1?.currency === "USD" && csv1?.source === "csv"
     && csv1?.source_ref === "gia-von-2026-07.csv",
   `0016 CSV: parse "9,5", chuẩn hoá currency thường → USD, ghi source + tên file (nhận ${JSON.stringify(csv1)})`);

const nBefore = (await one("select count(*)::int n from catalog.cost_inputs")).n;
res = await rpc(`public.vexim_import_cost_inputs('${aShop}', '[
  {"sku":"CSV-OK","unit_cost":"3","currency":"USD","effective_from":"2026-07-01"},
  {"sku":"CSV-BAD","unit_cost":"abc","currency":"USD","effective_from":"2026-07-01"},
  {"sku":"","unit_cost":"3","currency":"USD","effective_from":"2026-07-01"}
]'::jsonb, 'loi.csv')`);
const nAfter = (await one("select count(*)::int n from catalog.cost_inputs")).n;
ok(res?.ok === false && Array.isArray(res?.errors) && res.errors.length === 2
     && res.errors[0].line === 2 && res.errors[1].line === 3,
   `0016 CSV: lô có lỗi → ok=false + báo đúng SỐ DÒNG (${JSON.stringify(res?.errors)})`);
ok(nBefore === nAfter, `0016 CSV ATOMIC: có 1 dòng lỗi thì KHÔNG ghi dòng nào (${nBefore} → ${nAfter})`);
res = await rpc(`public.vexim_import_cost_inputs('${aShop}', '[
  {"sku":"CSV-MMDD","unit_cost":"3","currency":"USD","effective_from":"07/20/2026"}]'::jsonb, null)`);
ok(res?.ok === false && /tháng > 12/.test(res?.errors?.[0]?.message ?? ""),
   `0016 CSV: từ chối MM/DD/YYYY mơ hồ thay vì đoán (${res?.errors?.[0]?.message})`);

// --- 4. Kết thúc hiệu lực / xoá + audit ------------------------------------
const closeId = (await one(`select id from catalog.cost_inputs
   where seller_account_id='${aShop}' and sku='CSV-1'`)).id;
res = await rpc(`public.vexim_close_cost_input('${closeId}','2026-08-15','hết lô')`);
const closedRow = await one(`select effective_to, note from catalog.cost_inputs where id='${closeId}'`);
ok(res?.ok === true && dstr(closedRow?.effective_to).startsWith("2026-08-15") && closedRow?.note === "hết lô",
   `0016 giá vốn: kết thúc hiệu lực một bậc (không xoá lịch sử) — ${dstr(closedRow?.effective_to)}`);
ok(
  await mustBlock(`select public.vexim_close_cost_input('${closeId}','2026-07-01',null)`),
  "0016 giá vốn CHẶN: ngày kết thúc trước ngày hiệu lực",
);
ok(
  await mustBlock(`select public.vexim_delete_cost_input('${closeId}')`),
  "0016 giá vốn CHẶN: operator không được XOÁ bậc giá vốn (chỉ admin/trưởng phòng Tài chính)",
);
// 3 lần nhập tay + 3 lần import (1 thành công, 2 lô lỗi cũng PHẢI log) + 1 lần kết thúc
await cmp(
  "0016 giá vốn: mọi thao tác (kể cả lô import BỊ TỪ CHỐI) đều để lại audit log",
  `select count(*) n from iam.audit_logs
    where action in ('cost.upsert','cost.import','cost.close') and seller_account_id='${aShop}'`,
  7,
);
await cmp(
  "0016 giá vốn: lô import lỗi cũng bị ghi log với kết quả error",
  `select count(*) n from iam.audit_logs
    where action='cost.import' and result like 'error:%' and seller_account_id='${aShop}'`,
  2,
);

// --- 5. Worker GHI listing (thay stub rỗng) --------------------------------
await ex("reset role;");
await ex("select set_config('request.jwt.claim.sub','',false);");
await ex("set role service_role;");
res = await one(`select * from public.vexim_worker_upsert_listings('${aShop}', '[
  {"sku":"L-1","asin":"B0001","title":"Vali 20","status":"active","price":"129.99","currency":"usd",
   "quantity":"142","product_type":"LUGGAGE",
   "issues":[{"code":"8541","message":"thiếu thuộc tính","severity":"ERROR","attributeNames":["item_name"]},
             {"code":"90220","message":"thiếu mô tả","severity":"WARNING"}],
   "stranded_reason":null,"source":"report","synced_at":"2026-09-12T02:00:00Z"}]'::jsonb)`);
ok(res?.upserted === 1 && res?.active_count === 1,
   `0016 listing: worker ghi được listing (upserted=${res?.upserted})`);
const l1 = await one(`select status, price, currency, quantity, product_type, issue_errors, issue_warnings,
   stranded_reason, last_source from catalog.listings where seller_account_id='${aShop}' and sku='L-1'`);
ok(l1?.status === "ACTIVE" && Number(l1?.price) === 129.99 && l1?.currency === "USD"
     && l1?.quantity === 142 && l1?.issue_errors === 1 && l1?.issue_warnings === 1
     && l1?.last_source === "report",
   `0016 listing: chuẩn hoá status/price/currency + ĐẾM issue từ mảng jsonb — ${JSON.stringify(l1)}`);

await one(`select * from public.vexim_worker_upsert_listings('${aShop}', '[
  {"sku":"L-1","status":null,"price":null,"title":null,"source":"report"}]'::jsonb)`);
const l2 = await one(`select status, price, title, issue_errors from catalog.listings
   where seller_account_id='${aShop}' and sku='L-1'`);
ok(l2?.status === "ACTIVE" && Number(l2?.price) === 129.99 && l2?.title === "Vali 20" && l2?.issue_errors === 1,
   `0016 listing: NULL = "chưa biết" → KHÔNG đè dữ liệu cũ — ${JSON.stringify(l2)}`);

await one(`select * from public.vexim_worker_upsert_listings('${aShop}', '[{"sku":"L-1","issues":[]}]'::jsonb)`);
const l3 = await one(`select issues, issue_errors, issue_warnings from catalog.listings
   where seller_account_id='${aShop}' and sku='L-1'`);
ok(JSON.stringify(l3?.issues) === "[]" && l3?.issue_errors === 0 && l3?.issue_warnings === 0,
   `0016 listing: issues=[] nghĩa là "đã xác nhận hết lỗi" → xoá bộ đếm cũ (${JSON.stringify(l3)})`);

await one(`select * from public.vexim_worker_upsert_listings('${aShop}', '[
  {"sku":"L-1","issues":null,"issue_errors":2,"issue_warnings":1,
   "enforcement_actions":["SEARCH_SUPPRESSED"]}]'::jsonb)`);
const l4 = await one(`select issues, issue_errors from catalog.listings
   where seller_account_id='${aShop}' and sku='L-1'`);
const v4 = await one(`select error_count, warning_count from public.vexim_listings
   where seller_account_id='${aShop}' and sku='L-1'`);
ok(l4?.issues === null && Number(v4?.error_count) === 2 && Number(v4?.warning_count) === 1,
   `0016 listing: notification chỉ cho SỐ → xoá mảng chi tiết lỗi thời, view đếm = 2/1 (${JSON.stringify(v4)})`);

await one(`select * from public.vexim_worker_upsert_listings('${aShop}', '[
  {"sku":"L-1","status":"STRANDED","stranded_reason":"Listing error (product type invalid)"}]'::jsonb)`);
ok((await one(`select stranded_reason from catalog.listings
   where seller_account_id='${aShop}' and sku='L-1'`)).stranded_reason?.startsWith("Listing error"),
   "0016 listing: ghi lý do stranded cho L4/SOP-03");
await one(`select * from public.vexim_worker_upsert_listings('${aShop}', '[
  {"sku":"L-1","status":"ACTIVE","stranded_reason":null}]'::jsonb)`);
ok((await one(`select stranded_reason from catalog.listings
   where seller_account_id='${aShop}' and sku='L-1'`)).stranded_reason === null,
   "0016 listing: hết stranded → XOÁ lý do (key có mặt + null), không giữ oan trong queue");
await one(`select * from public.vexim_worker_upsert_listings('${aShop}', '[
  {"sku":"L-2","status":"INACTIVE","stranded_reason":"No listing exists for inventory"}]'::jsonb)`);
await one(`select * from public.vexim_worker_upsert_listings('${aShop}', '[{"sku":"L-2","status":"INACTIVE"}]'::jsonb)`);
ok((await one(`select stranded_reason from catalog.listings
   where seller_account_id='${aShop}' and sku='L-2'`)).stranded_reason === "No listing exists for inventory",
   "0016 listing: key VẮNG → giữ nguyên lý do stranded cũ");
await one(`select * from public.vexim_worker_upsert_listings('${aShop}', '[{"sku":"L-4"}]'::jsonb)`);
ok((await one(`select status from catalog.listings
   where seller_account_id='${aShop}' and sku='L-4'`)).status === "UNKNOWN",
   "0016 listing: dòng mới chưa rõ trạng thái → 'UNKNOWN', KHÔNG bịa 'active'");
ok(
  await mustBlock(`select public.vexim_worker_upsert_listings('${aShop}', '[{"sku":"L-5","status":"Banana"}]'::jsonb)`),
  "0016 listing CHẶN: trạng thái ngoài tập hợp lệ",
);
const queueSkus = (await db.query(
  `select sku from public.vexim_listing_queue where seller_account_id='${aShop}' order by sku`)).rows.map(r => r.sku);
ok(queueSkus.join(",") === "L-1,L-2",
   `0016 L4: queue chỉ chứa dòng có vấn đề (L-1 còn 2 lỗi, L-2 inactive; L-4 UNKNOWN thì không) — ${queueSkus.join(",")}`);
await asA(aFin);
ok(
  await mustBlock(`select public.vexim_worker_upsert_listings('${aShop}', '[]'::jsonb)`),
  "0016 listing CHẶN: authenticated không gọi RPC ghi của worker",
);

// --- 6. vexim_pricing dùng GIÁ VỐN HIỆU LỰC (thay floor ≈ phí của 0013) -----
await ex("reset role;");
await ex("select set_config('request.jwt.claim.sub','',false);");
await ex("set role service_role;");
await ex(`insert into catalog.listings(seller_account_id,sku,asin,title,status,price,currency) values
  ('${aShop}','P-COST','B0P1','có vốn + có phí','ACTIVE',100,'USD'),
  ('${aShop}','P-NOCOST','B0P2','không vốn','ACTIVE',100,'USD'),
  ('${aShop}','P-COSTONLY','B0P3','có vốn, chưa có phí','ACTIVE',100,'USD'),
  ('${aShop}','P-FX','B0P4','vốn EUR, giá bán USD','ACTIVE',100,'USD');
 insert into catalog.fees_estimates(seller_account_id,sku,referral_fee,fba_fee,total_fee,currency,estimated_at) values
  ('${aShop}','P-COST',15,5.5,20.5,'USD',now()),
  ('${aShop}','P-NOCOST',15,5.5,20.5,'USD',now());`);
await asA(aFin);
await rpc(`public.vexim_upsert_cost_input('${aShop}','P-COST',40,'USD','2026-09-01',null,null)`);
await rpc(`public.vexim_upsert_cost_input('${aShop}','P-COSTONLY',40,'USD','2026-09-01',null,null)`);
await rpc(`public.vexim_upsert_cost_input('${aShop}','P-FX',40,'EUR','2026-09-01',null,null)`);
const pricing = {};
for (const row of (await db.query(
  `select sku, unit_cost, cost_basis, floor_price, gross_profit, margin_pct, below_floor, referral_rate_used
     from public.vexim_pricing where seller_account_id='${aShop}' and sku like 'P-%' order by sku`)).rows) {
  pricing[row.sku] = row;
}
ok(Number(pricing["P-COST"]?.unit_cost) === 40 && pricing["P-COST"]?.cost_basis === "cost+fees",
   `0016 P1: view đọc giá vốn hiệu lực (40) + nhãn nguồn cost+fees — ${JSON.stringify(pricing["P-COST"])}`);
ok(Number(pricing["P-COST"]?.floor_price) === 60.67,
   `0016 P1: giá sàn = (40 vốn + 5.5 FBA) / (1 − 0.15 referral − 0.10 biên) = 60.67 (nhận ${pricing["P-COST"]?.floor_price})`);
ok(Number(pricing["P-COST"]?.gross_profit) === 39.5 && Number(pricing["P-COST"]?.margin_pct) === 39.5
     && pricing["P-COST"]?.below_floor === false,
   `0016 P1: lãi gộp 39.50 / biên 39.5% (nhận ${pricing["P-COST"]?.gross_profit} · ${pricing["P-COST"]?.margin_pct})`);
ok(pricing["P-NOCOST"]?.unit_cost === null && pricing["P-NOCOST"]?.floor_price === null
     && pricing["P-NOCOST"]?.margin_pct === null && pricing["P-NOCOST"]?.cost_basis === "fees_only",
   `0016 P1: THIẾU giá vốn → sàn/biên NULL + basis fees_only (không lấy phí làm sàn như 0013) — ${JSON.stringify(pricing["P-NOCOST"])}`);
ok(pricing["P-COSTONLY"]?.cost_basis === "cost_only" && Number(pricing["P-COSTONLY"]?.floor_price) === 53.33
     && Number(pricing["P-COSTONLY"]?.gross_profit) === 45,
   `0016 P1: chưa có fees estimate → dùng tỷ lệ cấu hình 15% (sàn 53.33, lãi 45) — ${JSON.stringify(pricing["P-COSTONLY"])}`);
ok(pricing["P-FX"]?.cost_basis === "currency_mismatch" && pricing["P-FX"]?.floor_price === null,
   `0016 P1: vốn EUR ≠ giá bán USD → KHÔNG cộng, báo currency_mismatch (${JSON.stringify(pricing["P-FX"])})`);
await ex("reset role;");
await ex("select set_config('request.jwt.claim.sub','',false);");
await ex("set role service_role;");
await ex(`update catalog.listings set price = 50 where seller_account_id='${aShop}' and sku='P-COST'`);
const belowFloor = await one(`select below_floor, margin_pct from public.vexim_pricing
   where seller_account_id='${aShop}' and sku='P-COST'`);
ok(belowFloor?.below_floor === true && Number(belowFloor?.margin_pct) < 0,
   `0016 P1: hạ giá 50 < sàn 60.67 → below_floor=true, biên âm (${belowFloor?.margin_pct}%)`);
await cmp(
  "0016 P1: vexim_pricing.unit_cost KHỚP catalog.effective_cost() ở MỌI dòng",
  `select count(*) n from public.vexim_pricing p
    where p.unit_cost is distinct from catalog.effective_cost(p.seller_account_id, p.sku, current_date)`,
  0,
);

// --- 7. RLS view giá vốn + độ phủ ------------------------------------------
await ex("reset role;");
await ex(`select set_config('request.jwt.claim.sub','${aStranger}',false);`);
await ex("set role authenticated;");
await cmp(
  "0016 RLS: user ngoài shop KHÔNG thấy giá vốn",
  `select count(*) n from public.vexim_cost_inputs where seller_account_id='${aShop}'`,
  0,
);
await cmp(
  "0016 RLS: user ngoài shop KHÔNG thấy độ phủ giá vốn",
  `select count(*) n from public.vexim_cost_coverage where seller_account_id='${aShop}'`,
  0,
);
await ex(`select set_config('request.jwt.claim.sub','${aFin}',false);`);
const coverage = await one(`select count(*)::int total,
   count(*) filter (where missing_cost)::int missing
   from public.vexim_cost_coverage where seller_account_id='${aShop}'`);
ok(coverage?.total >= 4 && coverage?.missing >= 1,
   `0016 độ phủ: liệt kê SKU còn THIẾU giá vốn để gỡ chặn F3/F4/P1 (${coverage?.missing}/${coverage?.total} SKU)`);
await cmp(
  "0016 độ phủ: SKU đã nhập giá vốn thì missing_cost = false",
  `select count(*) n from public.vexim_cost_coverage
    where seller_account_id='${aShop}' and sku='P-COST' and missing_cost = false`,
  1,
);

// --- 8. vexim_shops: bộ chọn shop trên /finance/costs -----------------------
// Người dùng PHẢI thấy shop mình được gán kể cả khi shop chưa có listing/giá vốn nào
// (nếu không thì trang giá vốn không chọn được shop để nhập lần đầu).
await cmp(
  "0016 vexim_shops: người được gán finance thấy shop của mình",
  `select count(*) n from public.vexim_shops where seller_account_id='${aShop}'`,
  1,
);
await cmp(
  "0016 vexim_shops: user ngoài KHÔNG thấy shop lạ (RLS seller_accounts vẫn áp)",
  `select count(*) n from public.vexim_shops where seller_account_id='${aShop}'
     and not iam.can_read_seller_account(seller_account_id)`,
  0,
);
await cmp(
  "0016 vexim_shops: không phơi merchant token (seller_id)",
  `select count(*) n from information_schema.columns
    where table_schema='public' and table_name='vexim_shops' and column_name='seller_id'`,
  0,
);
await ex(`select set_config('request.jwt.claim.sub','${aStranger}',false);`);
await cmp(
  "0016 RLS vexim_shops: user lạ không thấy shop nào của org",
  `select count(*) n from public.vexim_shops where seller_account_id='${aShop}'`,
  0,
);

await ex("reset role; rollback;");

// ============================================================================
console.log("\n=== BƯỚC 18: 0017 — ĐỢT B hái quả ngay (doanh số 30 ngày · phụ trách · giá trị tồn) ===");
// ============================================================================
ok(
  await ex(rd("migrations/0017_sales30d_owner_inventory_value.sql"), "0017_sales30d_owner_inventory_value.sql"),
  "0017 chạy sạch (DO-block tự soát: cột nối CUỐI view · quyền · PII · công thức)",
);

// Web đọc các view này bằng chuỗi select cố định (PRICING_SELECT / LISTINGS_SELECT /
// LISTING_QUEUE_SELECT / INVENTORY_SELECT) → cột mới PHẢI nằm cuối, đúng thứ tự;
// thiếu/sai 1 cột là PostgREST trả PGRST204 và SẬP CẢ TRANG.
const tailCols = async (view, n) =>
  (await one(`select string_agg(column_name, ',' order by ordinal_position) c
     from information_schema.columns
    where table_schema='public' and table_name='${view}'
      and ordinal_position > (select max(ordinal_position) - ${n}
                                from information_schema.columns
                               where table_schema='public' and table_name='${view}')`)).c;

const SALES_TAIL =
  "units_30d,orders_30d,revenue_30d,revenue_currency,velocity_30d,last_order_at,owner";
for (const v of ["vexim_pricing", "vexim_listings", "vexim_listing_queue"]) {
  ok((await tailCols(v, 7)) === SALES_TAIL, `0017: ${v} nối 7 cột mới Ở CUỐI (không đảo cột 0016)`);
}
ok(
  (await tailCols("vexim_inventory_latest", 8)) ===
    "unit_cost,cost_currency,cost_effective_from,cost_source,stock_value,total_stock_value,value_currency,value_basis",
  "0017: vexim_inventory_latest nối 8 cột giá trị tồn Ở CUỐI",
);
await cmp(
  "0017: vexim_sku_sales_30d là security_invoker (RLS bảng gốc vẫn áp)",
  `select count(*) n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
    where ns.nspname='public' and c.relname='vexim_sku_sales_30d'
      and 'security_invoker=true' = any (c.reloptions)`,
  1,
);

// ---- fixture: người phụ trách · listing · đơn hàng · tồn kho · giá vốn -------
await ex("begin");
await ex("reset role;");
const bShop = (await one("select id from connections.seller_accounts order by seller_id limit 1")).id;
const bPricingRw = "b1000000-0000-4000-8000-000000000001"; // pricing, can_write — gán SAU
const bPricingRo = "b1000000-0000-4000-8000-000000000002"; // pricing, chỉ đọc — gán TRƯỚC
const bListing   = "b1000000-0000-4000-8000-000000000003"; // listings
const bCustomer  = "b1000000-0000-4000-8000-000000000004"; // user của KHÁCH HÀNG
const bStranger  = "b1000000-0000-4000-8000-000000000005"; // không được gán shop
ok(
  await ex(`insert into auth.users(id,email) values
     ('${bPricingRw}','local-b-prw@example.test'),
     ('${bPricingRo}','local-b-pro@example.test'),
     ('${bListing}','local-b-listing@example.test'),
     ('${bCustomer}','local-b-customer@example.test'),
     ('${bStranger}','local-b-stranger@example.test');
   insert into iam.user_profiles(id,display_name,email,vexim_employee) values
     ('${bPricingRw}','Minh giá','local-b-prw@example.test',true),
     ('${bPricingRo}','An chỉ đọc','local-b-pro@example.test',true),
     ('${bListing}','Lan listing','local-b-listing@example.test',true),
     ('${bCustomer}','Khách của VEXIM','local-b-customer@example.test',false),
     ('${bStranger}','Người lạ','local-b-stranger@example.test',true);
   insert into iam.assignments(user_id,seller_account_id,module,can_write,created_at) values
     ('${bPricingRo}','${bShop}','pricing',false, now() - interval '10 days'),
     ('${bPricingRw}','${bShop}','pricing',true,  now() - interval '1 day'),
     ('${bListing}',  '${bShop}','listings',true, now() - interval '3 days'),
     ('${bCustomer}', '${bShop}','inventory',true, now() - interval '3 days');
   insert into iam.role_assignments(user_id,role) values
     ('${bPricingRw}','operator'),('${bPricingRo}','operator'),('${bListing}','operator');`),
  "0017 fixture: 5 user (pricing rw/ro · listings · khách hàng · người lạ)",
);

await ex("reset role;");
await ex("select set_config('request.jwt.claim.sub','',false);");
await ex("set role service_role;");
ok(
  await ex(`insert into catalog.listings(seller_account_id,sku,asin,title,status,price,currency,quantity) values
     ('${bShop}','QW-SELL','B0QW1','bán chạy','ACTIVE',50,'USD',100),
     ('${bShop}','QW-DEAD','B0QW2','không có đơn nào','INACTIVE',30,'USD',50),
     ('${bShop}','QW-CANCEL','B0QW3','chỉ có đơn huỷ','ACTIVE',25,'USD',10),
     ('${bShop}','qw-lowcase','B0QW4','SKU viết thường','ACTIVE',20,'USD',7);
   insert into sales.orders(id,seller_account_id,amazon_order_id,status,channel,purchase_date,order_total,currency,items_count) values
     ('b2000000-0000-4000-8000-000000000001','${bShop}','B-OK-1','Shipped','AFN',   now() - interval '5 days',  150,'USD',3),
     ('b2000000-0000-4000-8000-000000000002','${bShop}','B-OK-2','Pending','AFN',   now() - interval '10 days', 100,'USD',2),
     ('b2000000-0000-4000-8000-000000000003','${bShop}','B-CANCEL','Cancelled','AFN',now() - interval '2 days', 450,'USD',9),
     ('b2000000-0000-4000-8000-000000000004','${bShop}','B-OLD','Shipped','AFN',    now() - interval '40 days', 350,'USD',7),
     ('b2000000-0000-4000-8000-000000000005','${bShop}','B-CASE','Shipped','AFN',   now() - interval '1 day',   50,'USD',1),
     ('b2000000-0000-4000-8000-000000000006','${bShop}','B-CANCEL2','Canceled','MFN',now() - interval '3 days', 25,'USD',1);
   insert into sales.order_items(order_id,asin,sku,quantity,item_price) values
     ('b2000000-0000-4000-8000-000000000001','B0QW1','QW-SELL',3,50),
     ('b2000000-0000-4000-8000-000000000002','B0QW1','QW-SELL',2,50),
     ('b2000000-0000-4000-8000-000000000003','B0QW1','QW-SELL',9,50),
     ('b2000000-0000-4000-8000-000000000004','B0QW1','QW-SELL',7,50),
     ('b2000000-0000-4000-8000-000000000005','B0QW1','qw-sell',1,50),
     ('b2000000-0000-4000-8000-000000000006','B0QW3','QW-CANCEL',1,25);
   insert into inventory.inventory_snapshots(seller_account_id,sku,asin,fulfillable,reserved,inbound,captured_at) values
     ('${bShop}','QW-SELL','B0QW1',100,20,30, now()),
     ('${bShop}','QW-DEAD','B0QW2',50,0,0, now()),
     ('${bShop}','qw-lowcase','B0QW4',7,0,0, now());
   insert into catalog.cost_inputs(seller_account_id,sku,unit_cost,currency,effective_from,source) values
     ('${bShop}','QW-SELL',10,'USD',    current_date - 30,'csv'),
     ('${bShop}','QW-LOWCASE',4,'USD',  current_date - 30,'manual');`),
  "0017 fixture: 4 listing · 6 đơn (2 huỷ · 1 quá 30 ngày · 1 SKU viết thường) · 3 tồn kho · 2 giá vốn",
);

// --- 1. iam.module_owner: đúng người · đúng module · ưu tiên can_write --------
const ownerOf = async (u, moduleCode) => {
  await ex("reset role;");
  await ex(`select set_config('request.jwt.claim.sub','${u ?? ""}',false);`);
  await ex("set role authenticated;");
  return (await one(`select iam.module_owner('${bShop}','${moduleCode}') as v`)).v;
};
ok((await ownerOf(bPricingRw, "pricing")) === "Minh giá",
   "0017 owner: ưu tiên người can_write dù gán SAU (không lấy bừa người gán đầu tiên)");
ok((await ownerOf(bListing, "listings")) === "Lan listing",
   "0017 owner: đúng phạm vi module — hỏi 'listings' ra người phụ trách listing");
ok((await ownerOf(bPricingRw, "ads")) === null,
   "0017 owner: module chưa gán ai → NULL (không đoán bừa người phụ trách)");
ok((await ownerOf(bPricingRw, "inventory")) === null,
   "0017 owner: user của KHÁCH HÀNG (vexim_employee=false) không bị nêu tên phụ trách");
ok((await ownerOf(bStranger, "pricing")) === null,
   "0017 owner: người không đọc được shop KHÔNG dò được tên người phụ trách");

await ex("reset role;");
await ex("select set_config('request.jwt.claim.sub','',false);");
await ex("set role anon;");
ok(
  await mustBlock(`select iam.module_owner('${bShop}','pricing')`),
  "0017 owner CHẶN: anon không gọi được iam.module_owner",
);

// --- 2. vexim_sku_sales_30d: cửa sổ 30 ngày · loại đơn huỷ · bất chấp hoa/thường
await ex("reset role;");
await ex(`select set_config('request.jwt.claim.sub','${bListing}',false);`);
await ex("set role authenticated;");
const sales = {};
for (const r of (await db.query(
  `select sku, units_30d, orders_30d, revenue_30d, currency, currency_mixed, last_order_at
     from public.vexim_sku_sales_30d
    where seller_account_id='${bShop}' and sku like 'QW%' order by sku`)).rows) {
  sales[r.sku] = r;
}
ok(sales["QW-SELL"]?.units_30d === 6 && sales["QW-SELL"]?.orders_30d === 3
     && Number(sales["QW-SELL"]?.revenue_30d) === 300,
   `0017 doanh số: Shipped 3 + Pending 2 + SKU viết thường 1 = 6 đơn vị · 3 đơn · 300.00 (đơn huỷ 9 + đơn 40 ngày 7 bị loại) — ${JSON.stringify(sales["QW-SELL"])}`);
ok(sales["QW-CANCEL"] === undefined,
   "0017 doanh số: SKU chỉ có đơn huỷ ('Cancelled' + 'Canceled') → KHÔNG có dòng");
ok(sales["QW-DEAD"] === undefined,
   "0017 doanh số: SKU không có đơn → KHÔNG có dòng (để NULL, không suy ra 0 giả)");
await cmp(
  "0017 doanh số: last_order_at = đơn KHÔNG huỷ gần nhất (1 ngày trước)",
  `select count(*) n from public.vexim_sku_sales_30d
    where seller_account_id='${bShop}' and sku='QW-SELL'
      and last_order_at between now() - interval '25 hours' and now() - interval '23 hours'`,
  1,
);

// --- 3. P1 (vexim_pricing): velocity30d + owner thay cho 0 / "—" ------------
const p17 = {};
for (const r of (await db.query(
  `select sku, units_30d, orders_30d, revenue_30d, revenue_currency, velocity_30d, owner, unit_cost, cost_basis
     from public.vexim_pricing
    where seller_account_id='${bShop}'
      and sku in ('QW-SELL','QW-DEAD','QW-CANCEL','qw-lowcase') order by sku`)).rows) {
  p17[r.sku] = r;
}
ok(Number(p17["QW-SELL"]?.velocity_30d) === 0.2 && p17["QW-SELL"]?.units_30d === 6,
   `0017 P1: velocity30d = 6 đơn vị / 30 ngày = 0.20 đơn/ngày (thay cho số 0 hard-code) — ${JSON.stringify(p17["QW-SELL"])}`);
ok(p17["QW-SELL"]?.owner === "Minh giá",
   `0017 P1: user THƯỜNG thấy tên đồng nghiệp phụ trách nhờ hàm security definer (owner=${p17["QW-SELL"]?.owner})`);
ok(Number(p17["QW-SELL"]?.revenue_30d) === 300 && p17["QW-SELL"]?.revenue_currency === "USD",
   "0017 P1: doanh thu 30 ngày 300.00 kèm tiền tệ (không cộng gộp khác tiền)");
ok(p17["QW-DEAD"]?.units_30d === null && p17["QW-DEAD"]?.velocity_30d === null
     && p17["QW-DEAD"]?.revenue_30d === null && p17["QW-DEAD"]?.revenue_currency === null,
   `0017 P1: SKU chưa có đơn → velocity/revenue NULL chứ không phải 0 — ${JSON.stringify(p17["QW-DEAD"])}`);
ok(Number(p17["qw-lowcase"]?.unit_cost) === 4,
   `0017 P1: listing SKU viết thường vẫn thấy giá vốn nhập VIẾT HOA (sửa lỗ hổng 0016) — ${JSON.stringify(p17["qw-lowcase"])}`);

// --- 4. L1 (vexim_listings) + L4 (vexim_listing_queue) ----------------------
const listings = {};
for (const r of (await db.query(
  `select sku, units_30d, revenue_30d, owner from public.vexim_listings
    where seller_account_id='${bShop}'
      and sku in ('QW-SELL','QW-DEAD') order by sku`)).rows) {
  listings[r.sku] = r;
}
ok(Number(listings["QW-SELL"]?.revenue_30d) === 300 && listings["QW-SELL"]?.owner === "Lan listing",
   `0017 L1: revenue30d 300.00 + owner module listings (nút sort "Doanh thu 30 ngày" hết sort trên số 0) — ${JSON.stringify(listings["QW-SELL"])}`);
const queue = await one(`select sku, owner, revenue_30d, units_30d from public.vexim_listing_queue
   where seller_account_id='${bShop}' and sku='QW-DEAD'`);
ok(queue?.owner === "Lan listing" && queue?.revenue_30d === null,
   `0017 L4: queue có người phụ trách + doanh thu NULL cho listing INACTIVE — ${JSON.stringify(queue)}`);

// --- 5. Module 3: GIÁ TRỊ TỒN KHO = Σ tồn × giá vốn hiệu lực ----------------
const inv = {};
for (const r of (await db.query(
  `select sku, fulfillable, reserved, inbound, unit_cost, cost_currency, stock_value,
          total_stock_value, value_currency, value_basis
     from public.vexim_inventory_latest
    where seller_account_id='${bShop}' and sku in ('QW-SELL','QW-DEAD','qw-lowcase') order by sku`)).rows) {
  inv[r.sku] = r;
}
ok(Number(inv["QW-SELL"]?.stock_value) === 1000 && Number(inv["QW-SELL"]?.total_stock_value) === 1500
     && inv["QW-SELL"]?.value_basis === "cost" && inv["QW-SELL"]?.value_currency === "USD",
   `0017 Module 3: 100 × 10 = 1.000 · (100+20+30) × 10 = 1.500 USD — ${JSON.stringify(inv["QW-SELL"])}`);
ok(inv["QW-DEAD"]?.unit_cost === null && inv["QW-DEAD"]?.stock_value === null
     && inv["QW-DEAD"]?.total_stock_value === null && inv["QW-DEAD"]?.value_basis === "missing",
   `0017 Module 3: THIẾU giá vốn → giá trị NULL + nhãn 'missing' (I3 không hiện 0 giả) — ${JSON.stringify(inv["QW-DEAD"])}`);
ok(Number(inv["qw-lowcase"]?.unit_cost) === 4 && Number(inv["qw-lowcase"]?.stock_value) === 28,
   `0017 Module 3: tồn kho SKU viết thường vẫn định giá được (7 × 4 = 28) — ${JSON.stringify(inv["qw-lowcase"])}`);

// --- 6. RLS: người lạ không thấy gì qua các view mới ------------------------
await ex(`select set_config('request.jwt.claim.sub','${bStranger}',false);`);
await cmp(
  "0017 RLS: người lạ không thấy doanh số 30 ngày của shop",
  `select count(*) n from public.vexim_sku_sales_30d where seller_account_id='${bShop}'`,
  0,
);
await cmp(
  "0017 RLS: người lạ không thấy giá trị tồn kho của shop",
  `select count(*) n from public.vexim_inventory_latest where seller_account_id='${bShop}'`,
  0,
);
await cmp(
  "0017 RLS: người lạ không thấy dòng P1 của shop",
  `select count(*) n from public.vexim_pricing where seller_account_id='${bShop}'`,
  0,
);

await ex("reset role; rollback;");

// --- 7. idempotent ----------------------------------------------------------
ok(
  await ex(rd("migrations/0017_sales30d_owner_inventory_value.sql"), "0017 lần 2"),
  "0017 idempotent",
);
ok((await tailCols("vexim_pricing", 7)) === SALES_TAIL, "0017 lần 2: 7 cột vẫn nối cuối, không nhân đôi");
await cmp(
  "0017 lần 2: index order_items không bị tạo trùng",
  `select count(*) n from pg_indexes where tablename='order_items' and indexname='idx_order_items_order'`,
  1,
);

// ============================================================================
console.log("\n=== BƯỚC 19: 0018 — Module 3 nâng cao (phân bổ tồn theo FC · lịch sử nhận hàng) ===");
// ============================================================================
// `db.query` NÉM lỗi (khác `one()` có bắt). Nếu 0018 fail, ta muốn thấy từng
// mục FAIL để biết thiếu gì — không muốn harness chết giữa chừng.
// PGlite trả cột `date` về thành JS Date (toISOString kèm giờ). So sánh nguyên
// chuỗi sẽ là "Fri Sep 11 2026…" ≠ "2026-09-11" → phải chuẩn về 10 ký tự ISO.
const d10 = (v) => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

const rows19 = async (sql) => {
  try {
    return (await db.query(sql)).rows;
  } catch (e) {
    return [{ error: e.message.split("\n")[0] }];
  }
};
ok(
  await ex(rd("migrations/0018_fc_allocation_receipts.sql"), "0018_fc_allocation_receipts.sql"),
  "0018 chạy sạch (DO-block tự soát: bảng · RLS · RPC · view · hợp đồng cột)",
);

// Web đọc 4 view mới bằng chuỗi select cố định → chốt hợp đồng ngay tại đây.
const colsOf = async (view) =>
  (await one(`select string_agg(column_name, ',' order by ordinal_position) c
     from information_schema.columns
    where table_schema='public' and table_name='${view}'`)).c;
ok(
  (await colsOf("vexim_inventory_fc")) ===
    "seller_account_id,shop,snapshot_date,sku,fnsku,product_name,fc,country,quantity," +
    "sellable_qty,unsellable_qty,unknown_qty,sku_total_qty,sku_fc_count,fc_share_pct,source,imported_at",
  "0018: vexim_inventory_fc đúng hợp đồng cột (I2 đọc bằng tên)",
);
ok(
  (await colsOf("vexim_inbound_receipt_shipments")) ===
    "seller_account_id,shop,shipment_id,fc,first_received_date,last_received_date,received_units," +
    "sku_count,shipment_status,expected_eta,expected_units,diff_units,receipt_rate_pct," +
    "reconcile_state,expected_source",
  "0018: vexim_inbound_receipt_shipments đúng hợp đồng cột (đối soát nhận hàng)",
);
await cmp(
  "0018: 2 bảng mới bật RLS",
  `select count(*) n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
    where ns.nspname='inventory' and c.relname in ('fc_allocation','receipts') and c.relrowsecurity`,
  2,
);
await cmp(
  "0018: index unique đúng khoá report (nhập lại không nhân đôi)",
  `select count(*) n from pg_indexes where schemaname='inventory'
     and indexname in ('uq_fc_allocation_key','uq_receipts_key') and indexdef like '%UNIQUE%'`,
  2,
);
await cmp(
  "0018: KHÔNG có policy ghi nào cho web trên 2 bảng mới",
  `select count(*) n from pg_policies where schemaname='inventory'
     and tablename in ('fc_allocation','receipts') and cmd <> 'SELECT'`,
  0,
);
await cmp(
  "0018: 2 RPC worker = security definer và chỉ service_role execute được",
  `select count(*) n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname='public'
      and p.proname in ('vexim_worker_upsert_fc_allocation','vexim_worker_upsert_receipts')
      and p.prosecdef
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and has_function_privilege('service_role', p.oid, 'EXECUTE')`,
  2,
);
await cmp(
  "0018: 4 view công khai đều security_invoker (RLS bảng gốc vẫn áp)",
  `select count(*) n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
    where ns.nspname='public'
      and c.relname in ('vexim_inventory_fc','vexim_inventory_fc_rows',
                        'vexim_inventory_receipts','vexim_inbound_receipt_shipments')
      and 'security_invoker=true'=any(c.reloptions)`,
  4,
);

// ---- fixture: user kho (có shop) + người lạ ---------------------------------
await ex("begin");
await ex("reset role;");
const cShop = (await one("select id from connections.seller_accounts order by seller_id limit 1")).id;
const cWhUser   = "c1000000-0000-4000-8000-000000000001";
const cStranger = "c1000000-0000-4000-8000-000000000002";
ok(
  await ex(`insert into auth.users(id,email) values
     ('${cWhUser}','local-c-kho@example.test'),
     ('${cStranger}','local-c-stranger@example.test');
   insert into iam.user_profiles(id,display_name,email,vexim_employee) values
     ('${cWhUser}','Kho VEXIM','local-c-kho@example.test',true),
     ('${cStranger}','Người lạ','local-c-stranger@example.test',true);
   insert into iam.assignments(user_id,seller_account_id,module,can_write,created_at) values
     ('${cWhUser}','${cShop}','inventory',true, now() - interval '1 day');
   insert into iam.role_assignments(user_id,role) values ('${cWhUser}','operator');`),
  "0018 fixture: 1 user kho được gán shop + 1 người lạ",
);

await ex("reset role;");
await ex("select set_config('request.jwt.claim.sub','',false);");
await ex("set role service_role;");

// ---- 1. Import report phân bổ FC --------------------------------------------
// Lô nhập cố ý có: 2 snapshot (chỉ snapshot MỚI NHẤT được phơi ra UI), 1 SKU nằm
// 2 FC, disposition hỏng (DAMAGED), disposition RỖNG (không rõ), 2 dòng trùng khoá
// (phải cộng dồn, không được nổ lỗi "affect row a second time"), 3 dòng RÁC
// (quantity không phải số / ngày sai định dạng / thiếu SKU), và 1 SKU tổng = 0.
const fcReport = JSON.stringify([
  { snapshotDate: "2026-09-10", sku: "FC-SKU", fnsku: "X001FC", productName: "Vali 20 inch", quantity: 60, fulfillmentCenterId: "ont8", detailedDisposition: "Sellable", country: "us" },
  { snapshotDate: "2026-09-11", sku: "FC-SKU", fnsku: "X001FC", productName: "Vali 20 inch", quantity: 40, fulfillmentCenterId: "ONT8", detailedDisposition: "SELLABLE", country: "US" },
  { snapshotDate: "2026-09-11", sku: "FC-SKU", quantity: 10, fulfillmentCenterId: "ONT8", detailedDisposition: "DAMAGED", country: "US" },
  { snapshotDate: "2026-09-11", sku: "FC-SKU", quantity: 25, fulfillmentCenterId: "PHX7", detailedDisposition: "Sellable", country: "US" },
  { snapshotDate: "2026-09-11", sku: "FC-SKU", quantity: 5,  fulfillmentCenterId: "PHX7", detailedDisposition: "", country: "US" },
  { snapshotDate: "2026-09-11", sku: "FC-SKU", quantity: 5,  fulfillmentCenterId: "phx7", country: "US" },
  { snapshotDate: "2026-09-11", sku: "FC-SKU", quantity: "abc", fulfillmentCenterId: "MDW2", detailedDisposition: "SELLABLE" },
  { snapshotDate: "11/09/2026", sku: "FC-SKU", quantity: 7, fulfillmentCenterId: "MDW2", detailedDisposition: "SELLABLE" },
  { snapshotDate: "2026-09-11", sku: "", quantity: 7, fulfillmentCenterId: "MDW2", detailedDisposition: "SELLABLE" },
  { snapshotDate: "2026-09-11", sku: "FC-EMPTY", quantity: 0, fulfillmentCenterId: "ONT8", detailedDisposition: "SELLABLE" },
]);
const fcNum = (r) => ({
  inserted: Number(r?.inserted), updated: Number(r?.updated), skipped: Number(r?.skipped),
  merged: Number(r?.merged), units: Number(r?.units), snapshots: Number(r?.snapshots),
});
const fc1 = fcNum(await one(`select * from public.vexim_worker_upsert_fc_allocation('${cShop}', '${fcReport}'::jsonb)`));
ok(
  fc1.inserted === 6 && fc1.updated === 0 && fc1.skipped === 3 && fc1.merged === 1
    && fc1.units === 145 && fc1.snapshots === 2,
  `0018 RPC FC: ghi 6 dòng · bỏ 3 dòng rác · gộp 1 cặp trùng khoá · 145 đơn vị · 2 snapshot — ${JSON.stringify(fc1)}`,
);
const fc2 = fcNum(await one(`select * from public.vexim_worker_upsert_fc_allocation('${cShop}', '${fcReport}'::jsonb)`));
ok(
  fc2.inserted === 0 && fc2.updated === 6,
  `0018 RPC FC: nhập LẠI cùng file → 6 update / 0 insert (idempotent) — ${JSON.stringify(fc2)}`,
);
await cmp(
  "0018: nhập 2 lần vẫn đúng 6 dòng, không phình bảng",
  `select count(*) n from inventory.fc_allocation where seller_account_id='${cShop}'`,
  6,
);
await cmp(
  "0018: 2 dòng trùng khoá được CỘNG dồn (5+5=10), không ghi 2 dòng",
  `select coalesce(sum(quantity),-1) n from inventory.fc_allocation
    where seller_account_id='${cShop}' and sku='FC-SKU' and fulfillment_center_id='PHX7'
      and detailed_disposition='' and snapshot_date=date '2026-09-11'`,
  10,
);

// ---- 2. View phân bổ FC: chỉ snapshot mới nhất + tỉ trọng --------------------
const fcView = (await rows19(
  `select sku, fc, quantity, sellable_qty, unsellable_qty, unknown_qty, sku_total_qty,
          sku_fc_count, fc_share_pct, snapshot_date
     from public.vexim_inventory_fc where seller_account_id='${cShop}' order by sku, fc`));
const fcOf = (sku, fc) => fcView.find((r) => r.sku === sku && r.fc === fc);
ok(fcView.length === 3, `0018 view FC: 3 dòng (2 FC của FC-SKU + 1 SKU rỗng) — nhận ${fcView.length}`);
ok(
  fcView.every((r) => d10(r.snapshot_date) === "2026-09-11"),
  "0018 view FC: chỉ phơi snapshot MỚI NHẤT (snapshot 2026-09-10 không lọt ra UI)",
);
const ont = fcOf("FC-SKU", "ONT8");
ok(
  Number(ont?.quantity) === 50 && Number(ont?.sellable_qty) === 40 && Number(ont?.unsellable_qty) === 10
    && Number(ont?.unknown_qty) === 0 && Number(ont?.sku_total_qty) === 85
    && Number(ont?.sku_fc_count) === 2 && Number(ont?.fc_share_pct) === 58.8,
  `0018 view FC: ONT8 = 40 bán được + 10 hỏng = 50/85 (58,8%) — ${JSON.stringify(ont)}`,
);
const phx = fcOf("FC-SKU", "PHX7");
ok(
  Number(phx?.quantity) === 35 && Number(phx?.sellable_qty) === 25 && Number(phx?.unknown_qty) === 10
    && Number(phx?.fc_share_pct) === 41.2,
  `0018 view FC: PHX7 = 25 bán được + 10 KHÔNG RÕ disposition = 35/85 (41,2%) — ${JSON.stringify(phx)}`,
);
ok(
  Number(ont?.fc_share_pct) + Number(phx?.fc_share_pct) === 100,
  "0018 view FC: tỉ trọng 2 FC cộng đủ 100% (không lệch do làm tròn)",
);
const empty = fcOf("FC-EMPTY", "ONT8");
ok(
  Number(empty?.quantity) === 0 && empty?.fc_share_pct === null,
  `0018 view FC: SKU tổng = 0 → fc_share_pct NULL, KHÔNG bịa 0% — ${JSON.stringify(empty)}`,
);

const fcDetail = (await rows19(
  `select fc, disposition, disposition_group, quantity
     from public.vexim_inventory_fc_rows
    where seller_account_id='${cShop}' and sku='FC-SKU' order by fc, disposition_group`));
ok(
  fcDetail.length === 4
    && fcDetail.some((r) => r.fc === "ONT8" && r.disposition_group === "unsellable" && Number(r.quantity) === 10)
    && fcDetail.some((r) => r.fc === "PHX7" && r.disposition === null && r.disposition_group === "unknown"),
  `0018 view FC chi tiết: drill-down ra đúng 4 dòng disposition (hỏng 10 · không rõ → NULL) — ${JSON.stringify(fcDetail)}`,
);

// ---- 3. Import report lịch sử nhận hàng + đối soát với số gửi (I4) -----------
ok(
  await ex(`insert into inventory.inbound_shipments(seller_account_id,shipment_id,status,quantity,eta_date) values
     ('${cShop}','FBA15ABC','CLOSED',50,     current_date - 8),
     ('${cShop}','FBA15SHORT','RECEIVING',25, current_date - 5),
     ('${cShop}','FBA15OVER','CLOSED',20,     current_date - 4),
     ('${cShop}','FBA15NULLQTY','WORKING',null, current_date - 2);`),
  "0018 fixture: 4 lô inbound (FBA15NOPLAN cố ý KHÔNG có để thử nhánh thiếu số gửi)",
);

const rxReport = JSON.stringify([
  { receivedDate: "2026-09-05", sku: "FC-SKU", fnsku: "X001FC", productName: "Vali 20 inch", quantity: 40, fbaShipmentId: "fba15abc", fulfillmentCenterId: "ont8" },
  { receivedDate: "2026-09-06", sku: "FC-SKU", quantity: 10, fbaShipmentId: "FBA15ABC", fulfillmentCenterId: "ONT8" },
  { receivedDate: "2026-09-08", sku: "RX-SHORT", quantity: 18, fbaShipmentId: "FBA15SHORT", fulfillmentCenterId: "PHX7" },
  { receivedDate: "2026-09-09", sku: "RX-NOPLAN", quantity: 12, fbaShipmentId: "FBA15NOPLAN", fulfillmentCenterId: "MDW2" },
  { receivedDate: "2026-09-09", sku: "RX-OVER", quantity: 30, fbaShipmentId: "FBA15OVER", fulfillmentCenterId: "ONT8" },
  { receivedDate: "2026-09-09", sku: "RX-NULLQTY", quantity: 6, fbaShipmentId: "FBA15NULLQTY", fulfillmentCenterId: "ONT8" },
  { receivedDate: "2026-09-09", sku: "RX-NOSHIP", quantity: 4, fulfillmentCenterId: "ONT8" },
  { receivedDate: "09/09/2026", sku: "RX-BAD", quantity: 4, fbaShipmentId: "FBA15BAD" },
  { receivedDate: "2026-09-09", sku: "RX-BADQTY", quantity: "n/a", fbaShipmentId: "FBA15BAD2" },
]);
const rxNum = (r) => ({
  inserted: Number(r?.inserted), updated: Number(r?.updated), skipped: Number(r?.skipped),
  merged: Number(r?.merged), units: Number(r?.units), shipments: Number(r?.shipments),
});
const rx1 = rxNum(await one(`select * from public.vexim_worker_upsert_receipts('${cShop}', '${rxReport}'::jsonb)`));
ok(
  rx1.inserted === 7 && rx1.updated === 0 && rx1.skipped === 2 && rx1.merged === 0
    && rx1.units === 120 && rx1.shipments === 5,
  `0018 RPC receipts: ghi 7 dòng · bỏ 2 dòng rác · 120 đơn vị · 5 lô — ${JSON.stringify(rx1)}`,
);
const rx2 = rxNum(await one(`select * from public.vexim_worker_upsert_receipts('${cShop}', '${rxReport}'::jsonb)`));
ok(
  rx2.inserted === 0 && rx2.updated === 7,
  `0018 RPC receipts: nhập LẠI → 7 update / 0 insert (idempotent) — ${JSON.stringify(rx2)}`,
);
await cmp(
  "0018: receipts nhập 2 lần vẫn 7 dòng",
  `select count(*) n from inventory.receipts where seller_account_id='${cShop}'`,
  7,
);

const recon = (await rows19(
  `select shipment_id, fc, first_received_date, last_received_date, received_units, sku_count,
          shipment_status, expected_units, diff_units, receipt_rate_pct, reconcile_state, expected_source
     from public.vexim_inbound_receipt_shipments
    where seller_account_id='${cShop}' order by shipment_id`));
const recOf = (id) => recon.find((r) => r.shipment_id === id);
ok(recon.length === 5, `0018 đối soát: 5 lô (dòng không có mã lô không vào bảng đối soát) — nhận ${recon.length}`);
const abc = recOf("FBA15ABC");
ok(
  Number(abc?.received_units) === 50 && Number(abc?.expected_units) === 50 && Number(abc?.diff_units) === 0
    && Number(abc?.receipt_rate_pct) === 100 && abc?.reconcile_state === "matched"
    && abc?.expected_source === "inbound_shipments" && Number(abc?.sku_count) === 1
    && d10(abc?.first_received_date) === "2026-09-05"
    && d10(abc?.last_received_date) === "2026-09-06"
    && abc?.fc === "ONT8",
  `0018 đối soát: lô nhận 2 đợt 40+10 = 50/50 → matched, FC viết thường được chuẩn hoá — ${JSON.stringify(abc)}`,
);
const short = recOf("FBA15SHORT");
ok(
  Number(short?.received_units) === 18 && Number(short?.diff_units) === -7
    && Number(short?.receipt_rate_pct) === 72 && short?.reconcile_state === "short",
  `0018 đối soát: gửi 25 nhận 18 → THIẾU 7 (72%) — chỗ đau thật của FBA — ${JSON.stringify(short)}`,
);
const over = recOf("FBA15OVER");
ok(
  Number(over?.diff_units) === 10 && over?.reconcile_state === "over" && Number(over?.receipt_rate_pct) === 150,
  `0018 đối soát: gửi 20 nhận 30 → THỪA 10 (150%), không âm thầm coi là đủ — ${JSON.stringify(over)}`,
);
const noplan = recOf("FBA15NOPLAN");
ok(
  noplan?.expected_units === null && noplan?.diff_units === null && noplan?.receipt_rate_pct === null
    && noplan?.reconcile_state === "unknown_expected" && noplan?.expected_source === "none",
  `0018 đối soát: không có dòng lô trong I4 → expected NULL + nhãn 'none' (không suy "gửi = nhận") — ${JSON.stringify(noplan)}`,
);
const nullqty = recOf("FBA15NULLQTY");
ok(
  nullqty?.expected_units === null && nullqty?.reconcile_state === "unknown_expected"
    && nullqty?.expected_source === "inbound_shipments",
  `0018 đối soát: có lô nhưng quantity NULL → vẫn 'chưa rõ số gửi', nguồn = inbound_shipments — ${JSON.stringify(nullqty)}`,
);

const rxView = (await rows19(
  `select sku, quantity, shipment_id, fc, received_date, days_ago
     from public.vexim_inventory_receipts where seller_account_id='${cShop}' order by received_date, sku`));
const dbToday = d10((await one("select current_date as d")).d);
const wantDays = Math.round((Date.parse(dbToday) - Date.parse("2026-09-05")) / 86400000);
ok(
  rxView.length === 7
    && rxView.some((r) => r.sku === "RX-NOSHIP" && r.shipment_id === null)
    && Number(rxView[0]?.days_ago) === wantDays,
  `0018 view receipts: 7 dòng · lô trống → shipment_id NULL · days_ago=${rxView[0]?.days_ago} (JS tính ${wantDays})`,
);

// ---- 4. RLS: user kho đọc được, người lạ không, web không ghi được ----------
await ex("reset role;");
await ex(`select set_config('request.jwt.claim.sub','${cWhUser}',false);`);
await ex("set role authenticated;");
await cmp(
  "0018 RLS: user kho đọc được phân bổ FC của shop mình",
  `select count(*) n from public.vexim_inventory_fc where seller_account_id='${cShop}'`,
  3,
);
await cmp(
  "0018 RLS: user kho đọc được đối soát nhận hàng",
  `select count(*) n from public.vexim_inbound_receipt_shipments where seller_account_id='${cShop}'`,
  5,
);
ok(
  await mustBlock(`insert into inventory.receipts(seller_account_id,received_date,sku,quantity)
     values ('${cShop}', date '2026-09-11','HACK',1)`),
  "0018 CHẶN: authenticated không ghi thẳng lịch sử nhận hàng (chỉ worker qua RPC)",
);
ok(
  await mustBlock(`update inventory.fc_allocation set quantity=999 where seller_account_id='${cShop}'`),
  "0018 CHẶN: authenticated không sửa được tồn theo FC",
);
ok(
  await mustBlock(`select * from public.vexim_worker_upsert_receipts('${cShop}', '[]'::jsonb)`),
  "0018 CHẶN: RPC nhập receipts chỉ dành cho service_role",
);
ok(
  await mustBlock(`select * from public.vexim_worker_upsert_fc_allocation('${cShop}', '[]'::jsonb)`),
  "0018 CHẶN: RPC nhập phân bổ FC chỉ dành cho service_role",
);

await ex(`select set_config('request.jwt.claim.sub','${cStranger}',false);`);
await cmp(
  "0018 RLS: người lạ không thấy phân bổ FC của shop",
  `select count(*) n from public.vexim_inventory_fc where seller_account_id='${cShop}'`,
  0,
);
await cmp(
  "0018 RLS: người lạ không thấy lịch sử nhận hàng của shop",
  `select count(*) n from public.vexim_inventory_receipts where seller_account_id='${cShop}'`,
  0,
);
await cmp(
  "0018 RLS: người lạ không thấy đối soát lô của shop",
  `select count(*) n from public.vexim_inbound_receipt_shipments where seller_account_id='${cShop}'`,
  0,
);

await ex("reset role; rollback;");

// ---- 5. idempotent ----------------------------------------------------------
ok(
  await ex(rd("migrations/0018_fc_allocation_receipts.sql"), "0018 lần 2"),
  "0018 idempotent (chạy lại không lỗi, không đổi hợp đồng)",
);
ok(
  (await colsOf("vexim_inventory_fc")).endsWith("fc_share_pct,source,imported_at"),
  "0018 lần 2: hợp đồng cột view FC giữ nguyên",
);
await cmp(
  "0018 lần 2: index unique không bị tạo trùng",
  `select count(*) n from pg_indexes where schemaname='inventory'
     and indexname in ('uq_fc_allocation_key','uq_receipts_key')`,
  2,
);


// ============================================================================
console.log("\n=== BƯỚC 20: 0019 — phí lưu kho theo FC · phí inbound · trạng thái report ===");
// ============================================================================
ok(
  await ex(rd("migrations/0019_fc_fees_report_requests.sql"), "0019_fc_fees_report_requests.sql"),
  "0019 chạy sạch (DO-block tự soát: bảng · RLS · RPC · view · helper đọc số · hợp đồng cột)",
);

// Web đọc 5 view mới bằng chuỗi select cố định → chốt hợp đồng ngay tại đây.
ok(
  (await colsOf("vexim_storage_fees")) ===
    "seller_account_id,shop,month_of_charge,fnsku,asin,sku,sku_source,product_name,fc," +
    "country_code,product_size_tier,average_quantity_on_hand,average_quantity_pending_removal," +
    "average_quantity_customer_orders,estimated_total_item_volume,volume_units,storage_rate," +
    "currency,estimated_monthly_storage_fee,dangerous_goods_storage_type," +
    "eligible_for_inventory_discount,qualifies_for_inventory_discount,total_incentive_fee_amount," +
    "source,imported_at",
  "0019: vexim_storage_fees đúng hợp đồng cột (kèm sku + sku_source)",
);
ok(
  (await colsOf("vexim_storage_fee_by_fc")) ===
    "seller_account_id,shop,month_of_charge,fc,currency,storage_fee,total_volume," +
    "avg_units_on_hand,product_lines,fnsku_count,volume_units,month_fee_total," +
    "month_fc_count,fee_share_pct,imported_at",
  "0019: vexim_storage_fee_by_fc đúng hợp đồng cột (phân bổ phí theo FC)",
);
ok(
  (await colsOf("vexim_inbound_issues")) ===
    "seller_account_id,shop,issue_reported_date,days_ago,shipment_creation_date,shipment_id," +
    "carton_id,fc,sku,fnsku,asin,product_name,problem_type,problem_quantity,expected_quantity," +
    "received_quantity,performance_measurement_unit,coaching_level,fee_type,currency,fee_total," +
    "problem_level,alert_status,source,imported_at",
  "0019: vexim_inbound_issues đúng hợp đồng cột",
);
ok(
  (await colsOf("vexim_inbound_issue_shipments")) ===
    "seller_account_id,shop,shipment_id,fc,shipment_creation_date,currency,issue_count," +
    "fee_total,problem_units,sku_count,first_issue_date,last_issue_date,problem_types," +
    "coaching_levels,alert_statuses,shipment_status,imported_at",
  "0019: vexim_inbound_issue_shipments đúng hợp đồng cột",
);
ok(
  (await colsOf("vexim_report_requests")) ===
    "id,seller_account_id,shop,report_type,marketplace_id,data_start,data_end,report_id," +
    "report_document_id,status," +
    "rows_imported,attempts,last_error,requested_at,completed_at,imported_at,age_minutes,is_stale",
  "0019: vexim_report_requests đúng hợp đồng cột (màn Sync health đọc)",
);

await cmp(
  "0019: 3 bảng mới bật RLS",
  `select count(*) n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
    where (ns.nspname,c.relname) in (('finance','storage_fees'),
          ('inventory','inbound_noncompliance'),('connections','report_requests'))
      and c.relrowsecurity`,
  3,
);
await cmp(
  "0019: index unique đúng khoá report (nhập lại không nhân đôi)",
  `select count(*) n from pg_indexes where indexname in
     ('uq_storage_fees_key','uq_inbound_noncompliance_key','uq_report_requests_key')
     and indexdef like '%UNIQUE%'`,
  3,
);
await cmp(
  "0019: KHÔNG có policy ghi nào cho web trên 3 bảng mới",
  `select count(*) n from pg_policies
    where (schemaname,tablename) in (('finance','storage_fees'),
          ('inventory','inbound_noncompliance'),('connections','report_requests'))
      and cmd <> 'SELECT'`,
  0,
);
await cmp(
  "0019: 3 RPC worker = security definer và chỉ service_role execute được",
  `select count(*) n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname='public'
      and p.proname in ('vexim_worker_upsert_storage_fees','vexim_worker_upsert_noncompliance',
                        'vexim_worker_set_report_request')
      and p.prosecdef
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and has_function_privilege('service_role', p.oid, 'EXECUTE')`,
  3,
);
await cmp(
  "0019: 5 view công khai đều security_invoker (RLS bảng gốc vẫn áp)",
  `select count(*) n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
    where ns.nspname='public'
      and c.relname in ('vexim_storage_fees','vexim_storage_fee_by_fc','vexim_inbound_issues',
                        'vexim_inbound_issue_shipments','vexim_report_requests')
      and 'security_invoker=true'=any(c.reloptions)`,
  5,
);

// ---- fixture: user kho + người lạ + ánh xạ FNSKU (từ 0018) ------------------
await ex("begin");
await ex("reset role;");
const fUser     = "d1000000-0000-4000-8000-000000000001";
const fStranger = "d1000000-0000-4000-8000-000000000002";
ok(
  await ex(`insert into auth.users(id,email) values
     ('${fUser}','local-d-kho@example.test'),
     ('${fStranger}','local-d-stranger@example.test');
   insert into iam.user_profiles(id,display_name,email,vexim_employee) values
     ('${fUser}','Kho VEXIM','local-d-kho@example.test',true),
     ('${fStranger}','Người lạ','local-d-stranger@example.test',true);
   insert into iam.assignments(user_id,seller_account_id,module,can_write,created_at) values
     ('${fUser}','${cShop}','inventory',true, now() - interval '1 day');
   insert into iam.role_assignments(user_id,role) values ('${fUser}','operator');`),
  "0019 fixture: 1 user kho được gán shop + 1 người lạ",
);
await ex("reset role;");
await ex("select set_config('request.jwt.claim.sub','',false);");
await ex("set role service_role;");

// Ánh xạ FNSKU → SKU lấy từ report 0018 (view phí lưu kho suy SKU qua đường này)
ok(
  await ex(`select * from public.vexim_worker_upsert_fc_allocation('${cShop}', '[
     {"snapshotDate":"2026-09-11","sku":"FEE-SKU","fnsku":"X00FEE1","quantity":120,
      "fulfillmentCenterId":"ONT8","detailedDisposition":"SELLABLE"}]'::jsonb)`) === true,
  "0019 fixture: 1 dòng phân bổ FC để ánh xạ FNSKU → SKU",
);
// ASIN trong catalog — nhánh suy SKU thứ 2 (report phí không có SKU).
// Shop fixture của harness chưa chắc có listing, nên TỰ cấy 1 dòng cho chắc ăn.
const fAsin = "B0TESTASIN19";
await ex("reset role;");
ok(
  await ex(`insert into catalog.listings(seller_account_id,sku,asin,title,status,currency)
     values ('${cShop}','ASIN-SKU-19','${fAsin}','Demo ASIN 0019','active','USD')
     on conflict (seller_account_id,sku) do update set asin=excluded.asin`),
  `0019 fixture: cấy listing SKU ASIN-SKU-19 ↔ ASIN ${fAsin} (để test suy SKU qua ASIN)`,
);
await ex("set role service_role;");

// ---- 1. Import report phí lưu kho --------------------------------------------
// Cố ý có: 2 tiền tệ cùng FC (USD + CAD — KHÔNG được cộng), 1 tháng khác (trend),
// 1 dòng chỉ có ASIN (suy SKU qua catalog), tháng sai định dạng ("September 2026"),
// 1 dòng không có cả FNSKU lẫn ASIN (không biết phí của ai → bỏ), 1 dòng số lạ.
const feeReport = JSON.stringify([
  { monthOfCharge: "2026-08", asin: "B0DEMOA1", fnsku: "X00FEE1", fulfillmentCenter: "ONT8", countryCode: "US", productName: "Mat ong 500ml", productSizeTier: "STANDARD", averageQuantityOnHand: "120.5", averageQuantityPendingRemoval: "0", averageQuantityCustomerOrders: "30", estimatedTotalItemVolume: "12.4", volumeUnits: "cubic feet", itemVolume: "0.103", storageRate: "0.87", currency: "USD", estimatedMonthlyStorageFee: "10.79", eligibleForInventoryDiscount: "true", qualifiesForInventoryDiscount: "false", totalIncentiveFeeAmount: "1.20", source: "report" },
  { monthOfCharge: "2026-08", asin: "B0DEMOA2", fnsku: "X00FEE2", fulfillmentCenter: "ONT8", averageQuantityOnHand: "40", estimatedTotalItemVolume: "3.0", volumeUnits: "cubic feet", storageRate: "1.20", currency: "CAD", estimatedMonthlyStorageFee: "3.60", source: "report" },
  { monthOfCharge: "2026-08", asin: fAsin, fnsku: "X00NEW", fulfillmentCenter: "PHX7", averageQuantityOnHand: "15", estimatedTotalItemVolume: "1.5", volumeUnits: "cubic feet", storageRate: "0.87", currency: "USD", estimatedMonthlyStorageFee: "1.31", source: "report" },
  { monthOfCharge: "2026-09", asin: "B0DEMOA1", fnsku: "X00FEE1", fulfillmentCenter: "ONT8", averageQuantityOnHand: "90", estimatedTotalItemVolume: "9.3", volumeUnits: "cubic feet", storageRate: "2.40", currency: "USD", estimatedMonthlyStorageFee: "22.32", dangerousGoodsStorageType: "NON_DG", source: "report" },
  { monthOfCharge: "September 2026", asin: "B0DEMOA1", fnsku: "X00FEE1", fulfillmentCenter: "ONT8", estimatedMonthlyStorageFee: "5.00", currency: "USD", source: "report" },
  { monthOfCharge: "2026-08", asin: "", fnsku: "", fulfillmentCenter: "ONT8", estimatedMonthlyStorageFee: "9.99", currency: "USD", source: "report" },
  { monthOfCharge: "2026-08", asin: "B0DEMOA3", fnsku: "X00FEE3", fulfillmentCenter: "MDW2", averageQuantityOnHand: "N/A", storageRate: "1,234.56", currency: "USD", estimatedMonthlyStorageFee: "abc", source: "report" },
]);
const feeNum = (r) => ({
  inserted: Number(r?.inserted), updated: Number(r?.updated), skipped: Number(r?.skipped),
  merged: Number(r?.merged), months: Number(r?.months), currencies: r?.currencies,
});
const fee1 = feeNum(await one(`select * from public.vexim_worker_upsert_storage_fees('${cShop}', '${feeReport}'::jsonb)`));
ok(
  fee1.inserted === 5 && fee1.updated === 0 && fee1.skipped === 2 && fee1.merged === 0
    && fee1.months === 2 && fee1.currencies === "CAD,USD",
  `0019 RPC phí lưu kho: 5 dòng · bỏ 2 (tháng sai định dạng + không có ASIN/FNSKU) · 2 tháng · tiền CAD,USD (xếp theo thứ tự chữ cái) — ${JSON.stringify(fee1)}`,
);
const feeAgain = JSON.stringify([JSON.parse(feeReport)[0]]);
const fee2 = feeNum(await one(`select * from public.vexim_worker_upsert_storage_fees('${cShop}', '${feeAgain}'::jsonb)`));
ok(fee2.inserted === 0 && fee2.updated === 1, `0019 RPC phí lưu kho: nhập LẠI → 1 update / 0 insert — ${JSON.stringify(fee2)}`);
await cmp(
  "0019: nhập 2 lần vẫn 5 dòng, không phình bảng",
  `select count(*) n from finance.storage_fees where seller_account_id='${cShop}'`,
  5,
);

// ---- 2. View phí lưu kho: SKU SUY RA phải nói rõ nguồn ------------------------
const feeView = await rows19(
  `select month_of_charge, fnsku, asin, sku, sku_source, fc, currency, storage_rate,
          estimated_monthly_storage_fee as fee, average_quantity_on_hand,
          eligible_for_inventory_discount, total_incentive_fee_amount
     from public.vexim_storage_fees where seller_account_id='${cShop}'
    order by month_of_charge, fc, fnsku`);
ok(feeView.length === 5, `0019 view phí: 5 dòng (nhận ${feeView.length})`);
const feeOf = (month, fnsku) => feeView.find((r) => r.month_of_charge === month && r.fnsku === fnsku);
const f1 = feeOf("2026-08", "X00FEE1");
ok(
  f1?.sku === "FEE-SKU" && f1?.sku_source === "fnsku"
    && Number(f1?.storage_rate) === 0.87 && Number(f1?.fee) === 10.79
    && Number(f1?.average_quantity_on_hand) === 120.5
    && f1?.eligible_for_inventory_discount === true && Number(f1?.total_incentive_fee_amount) === 1.2,
  `0019 view phí: suy SKU qua FNSKU (report phí KHÔNG có cột SKU) — ${JSON.stringify(f1)}`,
);
const f2 = feeOf("2026-08", "X00NEW");
ok(
  f2?.sku_source === "asin" && typeof f2?.sku === "string" && f2.sku.length > 0,
  `0019 view phí: FNSKU chưa ánh xạ → suy qua ASIN của catalog (${f2?.sku}) — ${JSON.stringify(f2)}`,
);
const f3 = feeOf("2026-08", "X00FEE3");
ok(
  f3?.sku_source === "none" && f3?.sku === null
    && f3?.average_quantity_on_hand === null && Number(f3?.storage_rate) === 1234.56 && f3?.fee === null,
  `0019 view phí: số lạ → NULL ("chưa biết"), "1,234.56" vẫn đọc được, không nổ lô nhập — ${JSON.stringify(f3)}`,
);

const byFc = await rows19(
  `select fc, currency, storage_fee, total_volume, product_lines, month_fee_total,
          month_fc_count, fee_share_pct
     from public.vexim_storage_fee_by_fc
    where seller_account_id='${cShop}' and month_of_charge='2026-08'
    order by currency desc, fc`);
const fcOf2 = (fc, cur) => byFc.find((r) => r.fc === fc && r.currency === cur);
ok(byFc.length === 4, `0019 phân bổ phí 2026-08: 4 dòng (ONT8-USD, ONT8-CAD, PHX7-USD, MDW2-USD) — nhận ${byFc.length}`);
ok(
  Number(fcOf2("ONT8", "USD")?.storage_fee) === 10.79 && Number(fcOf2("ONT8", "CAD")?.storage_fee) === 3.6,
  "0019 phân bổ phí: KHÔNG cộng tiền khác tiền tệ (USD và CAD là 2 dòng riêng)",
);
ok(
  Number(fcOf2("ONT8", "USD")?.fee_share_pct) === 89.2
    && Number(fcOf2("ONT8", "USD")?.month_fee_total) === 12.1
    && Number(fcOf2("ONT8", "USD")?.month_fc_count) === 3
    && Number(fcOf2("PHX7", "USD")?.fee_share_pct) === 10.8,
  `0019 phân bổ phí: ONT8 = 10.79/12.10 USD = 89,2% · PHX7 = 10,8% — ${JSON.stringify(fcOf2("ONT8", "USD"))}`,
);
ok(
  Number(fcOf2("ONT8", "USD")?.fee_share_pct) + Number(fcOf2("PHX7", "USD")?.fee_share_pct) === 100,
  "0019 phân bổ phí: 2 FC cùng tiền tệ cộng đủ 100%",
);
ok(
  fcOf2("MDW2", "USD")?.fee_share_pct === null && fcOf2("MDW2", "USD")?.storage_fee === null
    && fcOf2("MDW2", "USD")?.total_volume === null && Number(fcOf2("MDW2", "USD")?.product_lines) === 1,
  `0019 phân bổ phí: FC không đọc được phí → fee/share NULL ("chưa biết"), không bịa 0 — ${JSON.stringify(fcOf2("MDW2", "USD"))}`,
);
const feeSep = await one(
  `select storage_fee, storage_rate from (select sum(storage_fee) storage_fee, max(1) storage_rate
     from public.vexim_storage_fee_by_fc
    where seller_account_id='${cShop}' and month_of_charge='2026-09' and currency='USD') x`);
ok(Number(feeSep?.storage_fee) === 22.32, `0019 trend phí: 2026-09 = 22.32 USD (Q4 rate 2.40 cao hơn 0.87) — ${JSON.stringify(feeSep)}`);

// ---- 3. Import report phí inbound không tuân thủ ------------------------------
const ncReport = JSON.stringify([
  { issueReportedDate: "2026-09-08", shipmentCreationDate: "2026-09-01", fbaShipmentId: "fba15dg9wjkr", fbaCartonId: "FBA15DG9WJKR000001", fulfillmentCenterId: "ont8", sku: "FEE-SKU", fnsku: "X00FEE1", asin: "B0DEMOA1", productName: "Mat ong 500ml", problemType: "oversized_carton", problemQuantity: "2", expectedQuantity: "100", receivedQuantity: "93", performanceMeasurementUnit: "UNIT", coachingLevel: "level_2", feeType: "manual_processing", currency: "usd", feeTotal: "0.30", problemLevel: "CARTON", alertStatus: "alert", source: "report" },
  { issueReportedDate: "2026-09-08", shipmentCreationDate: "2026-09-01", fbaShipmentId: "FBA15DG9WJKR", fbaCartonId: "FBA15DG9WJKR000002", fulfillmentCenterId: "ONT8", sku: "FEE-SKU", problemType: "MISSING_LABEL", problemQuantity: "5", expectedQuantity: "80", receivedQuantity: "80", coachingLevel: "LEVEL_1", feeType: "MANUAL_PROCESSING", currency: "USD", feeTotal: "0.55", problemLevel: "ITEM", alertStatus: "ALERT", source: "report" },
  { issueReportedDate: "2026-09-09", fbaShipmentId: "FBA17XYZ", fulfillmentCenterId: "PHX7", sku: "RX-NOSHIP", problemType: "DAMAGED_ITEM", problemQuantity: "1", currency: "USD", feeTotal: "2.00", coachingLevel: "LEVEL_3", alertStatus: "CRITICAL", source: "report" },
  { issueReportedDate: "", fbaShipmentId: "FBA17XYZ", sku: "RX-NOSHIP", problemType: "DAMAGED_ITEM", feeTotal: "1.00", currency: "USD", source: "report" },
  { issueReportedDate: "2026-09-08", fbaShipmentId: "FBA15DG9WJKR", fbaCartonId: "FBA15DG9WJKR000001", sku: "FEE-SKU", problemType: "OVERSIZED_CARTON", problemQuantity: "3", currency: "USD", feeTotal: "0.45", source: "report" },
]);
const ncNum = (r) => ({
  inserted: Number(r?.inserted), updated: Number(r?.updated), skipped: Number(r?.skipped),
  merged: Number(r?.merged), shipments: Number(r?.shipments), currencies: r?.currencies,
});
const nc1 = ncNum(await one(`select * from public.vexim_worker_upsert_noncompliance('${cShop}', '${ncReport}'::jsonb)`));
ok(
  nc1.inserted === 3 && nc1.updated === 0 && nc1.skipped === 1 && nc1.merged === 1
    && nc1.shipments === 2 && nc1.currencies === "USD",
  `0019 RPC phí inbound: 3 dòng · bỏ 1 (thiếu ngày báo) · gộp 1 cặp trùng khoá · 2 lô — ${JSON.stringify(nc1)}`,
);
const issues = await rows19(
  `select shipment_id, carton_id, sku, problem_type, problem_quantity, expected_quantity,
          received_quantity, coaching_level, fee_total, alert_status, fc, problem_level, days_ago
     from public.vexim_inbound_issues where seller_account_id='${cShop}'
    order by issue_reported_date, shipment_id, carton_id`);
ok(issues.length === 3, `0019 view vấn đề nhập: 3 dòng (nhận ${issues.length})`);
const is1 = issues.find((r) => r.carton_id === "FBA15DG9WJKR000001");
ok(
  is1?.shipment_id === "FBA15DG9WJKR" && is1?.fc === "ONT8" && is1?.problem_type === "OVERSIZED_CARTON",
  `0019 view vấn đề nhập: mã lô/FC/loại vấn đề được CHUẨN HOÁ (input viết thường) — ${JSON.stringify(is1)}`,
);
ok(
  Number(is1?.expected_quantity) === 100 && Number(is1?.received_quantity) === 93
    && Number(is1?.problem_quantity) === 3 && Number(is1?.fee_total) === 0.45,
  `0019 view vấn đề nhập: expected/received giữ nguyên để đối chiếu; dòng trùng khoá lấy số mới — ${JSON.stringify(is1)}`,
);
ok(
  is1?.coaching_level === "LEVEL_2" && is1?.alert_status === "ALERT" && is1?.problem_level === "CARTON"
    && Number(is1?.days_ago) >= 0,
  "0019 view vấn đề nhập: kèm coaching level + alert status + problem level + days_ago",
);

// Nhập LẠI file cũ sau khi đã đọc view: chứng minh (a) không nhân đôi,
// (b) file cũ GHI ĐÈ số mới (last-write-wins) — nên cron luôn tải report mới nhất.
const nc2 = ncNum(await one(`select * from public.vexim_worker_upsert_noncompliance('${cShop}', '${JSON.stringify([JSON.parse(ncReport)[0]])}'::jsonb)`));
ok(nc2.inserted === 0 && nc2.updated === 1, `0019 RPC phí inbound: nhập LẠI → 1 update / 0 insert — ${JSON.stringify(nc2)}`);
await cmp(
  "0019: nhập 2 lần vẫn 3 dòng vấn đề, không phình bảng",
  `select count(*) n from inventory.inbound_noncompliance where seller_account_id='${cShop}'`,
  3,
);

const ncShip = await rows19(
  `select shipment_id, issue_count, fee_total, problem_units, sku_count, problem_types,
          coaching_levels, alert_statuses, shipment_status, currency, first_issue_date, last_issue_date
     from public.vexim_inbound_issue_shipments where seller_account_id='${cShop}' order by shipment_id`);
ok(ncShip.length === 2, `0019 gộp vấn đề theo lô: 2 lô (nhận ${ncShip.length})`);
const ns1 = ncShip.find((r) => r.shipment_id === "FBA15DG9WJKR");
ok(
  Number(ns1?.issue_count) === 2 && Number(ns1?.fee_total) === 0.85 && Number(ns1?.problem_units) === 7
    && ns1?.currency === "USD" && Number(ns1?.sku_count) === 1,
  `0019 gộp theo lô: 2 vấn đề · phí 0.30+0.55 = 0.85 USD · 7 đơn vị có vấn đề (file cũ ghi đè 0.45/3) — ${JSON.stringify(ns1)}`,
);
ok(
  ns1?.problem_types === "MISSING_LABEL, OVERSIZED_CARTON" && ns1?.coaching_levels === "LEVEL_1, LEVEL_2"
    && ns1?.alert_statuses === "ALERT",
  `0019 gộp theo lô: liệt kê loại vấn đề + coaching + alert để biết cần sửa gì — ${JSON.stringify(ns1?.problem_types)}`,
);
ok(
  d10(ns1?.first_issue_date) === "2026-09-08" && ns1?.shipment_status === null,
  "0019 gộp theo lô: lô chưa có trong I4 → shipment_status NULL (không bịa trạng thái)",
);

// ---- 4. Trạng thái yêu cầu report (để Vercel Cron nối tiếp được) --------------
const rr1 = await one(`select * from public.vexim_worker_set_report_request('${cShop}',
   '{"reportType":"GET_FBA_STORAGE_FEE_CHARGES_DATA","marketplaceId":"atvpdkikx0der",
     "dataStart":"2026-08-01","dataEnd":"2026-08-31","reportId":"ID3-REP-1",
     "status":"REQUESTED","requestedAt":"${new Date().toISOString()}"}'::jsonb)`);
ok(
  rr1?.status === "requested" && rr1?.report_id === "ID3-REP-1",
  `0019 trạng thái report: ghi lần đầu, status chuẩn hoá chữ thường — ${JSON.stringify(rr1)}`,
);
const rr2 = await one(`select * from public.vexim_worker_set_report_request('${cShop}',
   '{"reportType":"GET_FBA_STORAGE_FEE_CHARGES_DATA","dataStart":"2026-08-01","dataEnd":"2026-08-31",
     "reportId":"ID3-REP-1","status":"IN_PROGRESS"}'::jsonb)`);
ok(
  rr2?.id === rr1?.id && rr2?.status === "in_progress",
  "0019 trạng thái report: cùng khoảng ngày → CẬP NHẬT đúng 1 dòng (cron không xin report mới, trần 1 lần/4 giờ)",
);
await one(`select * from public.vexim_worker_set_report_request('${cShop}',
   '{"reportType":"GET_FBA_STORAGE_FEE_CHARGES_DATA","dataStart":"2026-08-01","dataEnd":"2026-08-31",
     "reportId":"ID3-REP-1","reportDocumentId":"amzn1.spdoc.1.4.demo","status":"IMPORTED",
     "rowsImported":"5","completedAt":"${new Date().toISOString()}","importedAt":"${new Date().toISOString()}"}'::jsonb)`);
const rrView = await one(
  `select status, rows_imported, attempts, report_document_id, marketplace_id, age_minutes, is_stale, data_start
     from public.vexim_report_requests
    where seller_account_id='${cShop}' and report_type='GET_FBA_STORAGE_FEE_CHARGES_DATA'`);
ok(
  rrView?.status === "imported" && Number(rrView?.rows_imported) === 5 && Number(rrView?.attempts) === 3
    && rrView?.report_document_id === "amzn1.spdoc.1.4.demo" && rrView?.marketplace_id === "ATVPDKIKX0DER"
    && rrView?.is_stale === false && d10(rrView?.data_start) === "2026-08-01",
  `0019 trạng thái report: imported · 5 dòng · 3 lần chạm · marketplace chuẩn hoá · is_stale=false — ${JSON.stringify(rrView)}`,
);
const rrBad = await one(`select * from public.vexim_worker_set_report_request('${cShop}',
   '{"reportType":"GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA","dataStart":"2026-09-01",
     "dataEnd":"2026-09-12","status":"KHONG_RO","lastError":"429 QuotaExceeded: rate limit"}'::jsonb)`);
ok(rrBad?.status === "failed", `0019 trạng thái report: status lạ → 'failed' (view lọc được) — ${JSON.stringify(rrBad)}`);
const rrBadView = await one(
  `select last_error, status from public.vexim_report_requests
    where seller_account_id='${cShop}' and report_type='GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA'`);
ok(
  String(rrBadView?.last_error).includes("429") && rrBadView?.status === "failed",
  "0019 trạng thái report: lỗi 429 được ghi lại để biết bị trần tốc độ",
);
// Report chờ quá 6 giờ = bất thường (report daily thường xong trong vài phút)
const staleAt = new Date(Date.now() - 8 * 3600 * 1000).toISOString();
await one(`select * from public.vexim_worker_set_report_request('${cShop}',
   '{"reportType":"GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA","dataStart":"2026-09-11",
     "dataEnd":"2026-09-11","reportId":"ID3-STALE","status":"IN_PROGRESS",
     "requestedAt":"${staleAt}"}'::jsonb)`);
await cmp(
  "0019: cờ is_stale bật đúng 1 report đang chờ quá 6 giờ",
  `select count(*) n from public.vexim_report_requests
    where seller_account_id='${cShop}' and is_stale`,
  1,
);
const staleRow = await one(
  `select status, age_minutes, is_stale from public.vexim_report_requests
    where seller_account_id='${cShop}' and report_id='ID3-STALE'`);
ok(
  staleRow?.status === "in_progress" && Number(staleRow?.age_minutes) >= 470 && staleRow?.is_stale === true,
  `0019: report chờ 8 giờ → is_stale=true, age_minutes=${staleRow?.age_minutes} (màn Sync health báo đỏ)`,
);
await cmp(
  "0019: 3 lần yêu cầu report = 3 dòng (mỗi khoảng ngày 1 dòng)",
  `select count(*) n from public.vexim_report_requests where seller_account_id='${cShop}'`,
  3,
);

// ---- 5. RLS: user kho đọc được, người lạ không, web không ghi được ------------
// KHÔNG được `rollback` ở đây: user kho + listing fixture đang sống trong
// transaction này — rollback là mất fixture và mọi test RLS sẽ đọc ra 0 dòng
// (kết quả GIẢ: trông như "chặn đúng" nhưng thật ra là không có dữ liệu).
// Nếu một câu phía trên ném lỗi thì txn ABORTED và phần này sẽ fail lộ liễu —
// đó là điều ta muốn, còn hơn là pass giả.
await ex("reset role;");
await ex(`select set_config('request.jwt.claim.sub','${fUser}',false);`);
await ex("set role authenticated;");
await cmp(
  "0019 RLS: user kho đọc được phân bổ phí FC của shop mình",
  `select count(*) n from public.vexim_storage_fee_by_fc where seller_account_id='${cShop}'`,
  5,
);
await cmp(
  "0019 RLS: user kho đọc được vấn đề nhập kho",
  `select count(*) n from public.vexim_inbound_issues where seller_account_id='${cShop}'`,
  3,
);
ok(
  await mustBlock(`insert into finance.storage_fees(seller_account_id,month_of_charge,asin,fnsku,fulfillment_center)
     values ('${cShop}','2026-08','HACK','HACK','HACK')`),
  "0019 CHẶN: authenticated không ghi thẳng phí lưu kho (chỉ worker qua RPC)",
);
ok(
  await mustBlock(`insert into inventory.inbound_noncompliance(seller_account_id,issue_reported_date,problem_type)
     values ('${cShop}', date '2026-09-12','HACK')`),
  "0019 CHẶN: authenticated không ghi thẳng phí inbound",
);
ok(
  await mustBlock(`update finance.storage_fees set estimated_monthly_storage_fee=0 where seller_account_id='${cShop}'`),
  "0019 CHẶN: authenticated không sửa được phí lưu kho",
);
ok(
  await mustBlock(`insert into connections.report_requests(seller_account_id,report_type,status)
     values ('${cShop}','GET_FBA_STORAGE_FEE_CHARGES_DATA','imported')`),
  "0019 CHẶN: authenticated không ghi được trạng thái report",
);
ok(
  await mustBlock(`select * from public.vexim_worker_upsert_storage_fees('${cShop}','[]'::jsonb)`),
  "0019 CHẶN: RPC nhập phí lưu kho chỉ dành cho service_role",
);
ok(
  await mustBlock(`select * from public.vexim_worker_upsert_noncompliance('${cShop}','[]'::jsonb)`),
  "0019 CHẶN: RPC nhập phí inbound chỉ dành cho service_role",
);
ok(
  await mustBlock(`select * from public.vexim_worker_set_report_request('${cShop}','{}'::jsonb)`),
  "0019 CHẶN: RPC ghi trạng thái report chỉ dành cho service_role",
);

await ex("reset role;");
await ex(`select set_config('request.jwt.claim.sub','${fStranger}',false);`);
await ex("set role authenticated;");
await cmp(
  "0019 RLS: người lạ không thấy phí theo FC của shop",
  `select count(*) n from public.vexim_storage_fee_by_fc where seller_account_id='${cShop}'`,
  0,
);
await cmp(
  "0019 RLS: người lạ không thấy vấn đề nhập kho của shop",
  `select count(*) n from public.vexim_inbound_issues where seller_account_id='${cShop}'`,
  0,
);
await cmp(
  "0019 RLS: người lạ không thấy trạng thái report của shop",
  `select count(*) n from public.vexim_report_requests where seller_account_id='${cShop}'`,
  0,
);

await ex("rollback;");
await ex("reset role;");

// ---- 6. idempotent ------------------------------------------------------------
ok(
  await ex(rd("migrations/0019_fc_fees_report_requests.sql"), "0019 lần 2"),
  "0019 idempotent (chạy lại không lỗi, không đổi hợp đồng)",
);
ok(
  (await colsOf("vexim_storage_fee_by_fc")).endsWith("fee_share_pct,imported_at"),
  "0019 lần 2: hợp đồng cột view phân bổ phí giữ nguyên",
);
await cmp(
  "0019 lần 2: index unique không bị tạo trùng",
  `select count(*) n from pg_indexes where indexname in
     ('uq_storage_fees_key','uq_inbound_noncompliance_key','uq_report_requests_key')`,
  3,
);

// Toàn bộ phần 0020 nằm TRONG KHỐI {} riêng: biến fixture (t1, cv, bu, over…)
// không đụng tên biến của các BƯỚC trước ở phạm vi module.
{
// ============================================================================
console.log("\n=== BƯỚC 21: 0020 — Module 0 OAuth multi-tenant · Module 5 PPC (đọc/phân tích) ===");
// ============================================================================
ok(
  await ex(rd("migrations/0020_module0_oauth_module5_ppc_read.sql"), "0020_module0_oauth_module5_ppc_read.sql"),
  "0020 chạy sạch (DO-block tự soát: RLS · index unique · token không lộ · RPC · view · hợp đồng cột)",
);

// ---- 0. Hợp đồng cột: web đọc bằng select cố định → chốt tại đây --------------
ok(
  (await colsOf("vexim_connections")) ===
    "seller_account_id,shop,seller_id,marketplace,shop_status,data_source,service,connected," +
    "token_status,token_source,scope,client_id,selling_partner_id,ads_account_id,authorized_at," +
    "reauthorize_at,reminder_days,reminder_sent_at,last_refresh_at,last_used_at,last_error," +
    "days_to_reauth,reauth_state,needs_connect",
  "0020: vexim_connections đúng hợp đồng cột (2 service/shop, KHÔNG có cột token)",
);
ok(
  (await colsOf("vexim_oauth_events")) ===
    "id,seller_account_id,shop,service,event,status,detail,created_at",
  "0020: vexim_oauth_events đúng hợp đồng cột (audit luồng OAuth)",
);
ok(
  (await colsOf("vexim_ads_profiles")) ===
    "seller_account_id,shop,ads_profile_id,marketplace,country_code,currency,timezone,account_id," +
    "account_type,account_name,daily_budget,is_default,source,first_seen_at,last_synced_at," +
    "campaigns_known,last_metrics_day",
  "0020: vexim_ads_profiles đúng hợp đồng cột (profileId = scope của mọi call Ads)",
);
ok(
  (await colsOf("vexim_ads_campaigns")).startsWith(
    "seller_account_id,shop,ads_profile_id,campaign_id,campaign_name,campaign_type,state," +
    "targeting_type,cost_type,daily_budget,budget_type,currency,start_date,end_date,portfolio_id," +
    "last_metrics_day,metrics_last_day,days_with_data,spend_yesterday,impressions_yesterday," +
    "clicks_yesterday,spend7,sales7,ad_orders7,ad_units7,impressions7,clicks7,acos7,roas7,ctr7,cpc7," +
    "acos_prev7,acos_trend_pts,budget_used_pct,budget_usage_day,budget_usage_spend," +
    "budget_usage_budget,usage_captured_at,exhausted_at_estimate,budget_exhausted," +
    "over_acos_target,acos_target,first_seen_at,last_synced_at,source"),
  "0020: vexim_ads_campaigns đúng hợp đồng cột (A1: cấu hình + 7 ngày + cờ cảnh báo)",
);
ok(
  (await colsOf("vexim_ads_kpis")) ===
    "seller_account_id,shop,shop_status,currency,metrics_day,spend_yesterday,clicks_yesterday," +
    "spend7,ad_sales7,ad_orders7,clicks7,impressions7,acos7,roas7,ctr7,cpc7,total_sales7," +
    "total_orders7,tacos7,tacos_unknown,campaigns_enabled,campaigns_over_target," +
    "campaigns_exhausted,budget_daily_total,last_metrics_day,last_imported_at,hours_since_import,is_stale",
  "0020: vexim_ads_kpis đúng hợp đồng cột (KPI PPC + TACOS theo shop × currency)",
);
ok(
  (await colsOf("vexim_ads_search_terms")) ===
    "seller_account_id,shop,search_term,is_placement_without_keyword,campaign_id,campaign_name," +
    "ad_group_name,keyword_text,match_type,keyword_type,currency,impressions,clicks,spend,sales7," +
    "ad_orders7,ctr,cpc,acos7,days_with_data,first_day,last_day,bid,ad_keyword_status," +
    "wasted_spend_signal",
  "0020: vexim_ads_search_terms đúng hợp đồng cột (A3)",
);
ok(
  (await colsOf("vexim_ads_targeting")) ===
    "seller_account_id,shop,day,campaign_id,campaign_name,ad_group_id,ad_group_name,target_label," +
    "keyword_id,keyword_text,match_type,keyword_type,is_product_targeting,targeting_expression,bid," +
    "currency,impressions,clicks,spend,sales7d,ad_orders7d,units_sold7d,acos7d,roas7d,report_id," +
    "imported_at",
  "0020: vexim_ads_targeting đúng hợp đồng cột (A2)",
);
ok(
  (await colsOf("vexim_ads_budget_usage")) ===
    "seller_account_id,shop,day,campaign_id,campaign_name,campaign_state,ads_profile_id,budget_type," +
    "currency,budget,spend,percentage_used,delivered_clicks,delivered_impressions,last_captured_at," +
    "source,exhausted_at_estimate,snapshots_over_100pct,budget_exhausted,exhausted_note",
  "0020: vexim_ads_budget_usage đúng hợp đồng cột (giờ cạn = ƯỚC LƯỢNG, có nhãn)",
);
ok(
  (await colsOf("vexim_ads_report_requests")) ===
    "id,seller_account_id,shop,ads_profile_id,report_type_id,ad_product,group_by,time_unit," +
    "date_start,date_end,ads_report_id,status,failure_reason,rows_imported,attempts,last_error," +
    "requested_at,completed_at,imported_at,age_minutes,is_stale",
  "0020: vexim_ads_report_requests đúng hợp đồng cột (không phơi download_url)",
);
ok(
  (await colsOf("vexim_ads_campaign_daily")) ===
    "seller_account_id,shop,day,campaign_id,campaign_name,campaign_type,currency,impressions," +
    "clicks,spend,sales7d,ad_orders7d,units_sold7d,acos7d,roas7d,ctr,cpc,budget_amount," +
    "campaign_status,ads_profile_id,report_id,imported_at",
  "0020: vexim_ads_campaign_daily đúng hợp đồng cột (chuỗi ngày cho biểu đồ)",
);

// ---- 1. Metadata: web KHÔNG ghi được, token KHÔNG lộ -------------------------
await cmp(
  "0020: bảng Ads mới chỉ cho web ĐỌC (không policy ghi nào)",
  `select count(*) n from pg_policies where schemaname='ads'
     and tablename in ('targeting_metrics_daily','advertised_product_daily','budget_usage','report_requests')
     and cmd <> 'SELECT'`,
  0,
);
await cmp(
  "0020: 1 shop giữ được 2 token (SP-API + Ads) — unique theo (shop, service)",
  `select count(*) n from pg_indexes where indexname='uq_oauth_tokens_shop_service'
     and indexdef like '%UNIQUE%' and indexdef like '%service%'`,
  1,
);
await cmp(
  "0020: alert khử trùng theo entity_key (1 alert MỞ / luật / đối tượng)",
  `select count(*) n from pg_indexes where indexname='uq_alerts_open_entity'
     and indexdef like '%UNIQUE%' and indexdef like '%open%'`,
  1,
);
await cmp(
  "0020: không view public nào phơi cột token",
  `select count(*) n from information_schema.columns where table_schema='public'
     and (column_name ilike '%refresh_token%' or column_name ilike '%access_token%'
          or column_name ilike '%encrypted%' or column_name='download_url')`,
  0,
);
await cmp(
  "0020: ngưỡng budget_exhausted đã có số (100%) để RPC tự nổ alert",
  `select count(*) n from ops.alert_rules
     where rule_code='budget_exhausted' and threshold=100 and comparator='gte'`,
  1,
);

// ---- 2. Fixture: 1 user được gán shop + 1 người lạ ---------------------------
await ex("begin");
await ex("reset role;");
const oUser     = "d2000000-0000-4000-8000-000000000001";
const oStranger = "d2000000-0000-4000-8000-000000000002";
ok(
  await ex(`insert into auth.users(id,email) values
     ('${oUser}','local-e-ads@example.test'),
     ('${oStranger}','local-e-stranger@example.test');
   insert into iam.user_profiles(id,display_name,email,vexim_employee) values
     ('${oUser}','Vận hành Ads','local-e-ads@example.test',true),
     ('${oStranger}','Người lạ','local-e-stranger@example.test',true);
   insert into iam.assignments(user_id,seller_account_id,module,can_write,created_at) values
     ('${oUser}','${cShop}','ads',false, now() - interval '1 day');
   insert into iam.role_assignments(user_id,role) values ('${oUser}','operator');
   update connections.seller_accounts set data_source='production' where id='${cShop}';
   delete from ads.ad_metrics_daily      where seller_account_id='${cShop}';
   delete from ads.campaigns             where seller_account_id='${cShop}';
   delete from ads.budget_usage          where seller_account_id='${cShop}';
   delete from ads.search_terms          where seller_account_id='${cShop}';
   delete from ads.ad_profiles           where seller_account_id='${cShop}';
   delete from ads.report_requests       where seller_account_id='${cShop}';
   delete from connections.oauth_tokens  where seller_account_id='${cShop}'`),
  "0020 fixture: user vận hành Ads + người lạ + shop production + dọn dữ liệu Ads cũ (số đếm xác định)",
);
await ex("reset role;");
await ex("select set_config('request.jwt.claim.sub','',false);");
await ex("set role service_role;");

// ---- 3. MODULE 0 — token: CHẶN plaintext, nhận bản đã mã hoá -----------------
const ENC = (tag) => `enc:v1:${Buffer.from(`demo-iv|${tag}`).toString("base64")}`;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
const upToken = (o) =>
  one(`select * from public.vexim_oauth_upsert_token('${JSON.stringify(o)}'::jsonb)`);

ok(
  await mustBlock(`select * from public.vexim_oauth_upsert_token(
     '{"sellerAccountId":"${cShop}","service":"spapi","encryptedRefreshToken":"Atzr|PLAINTEXT"}'::jsonb)`),
  "0020 CHẶN: refresh token PLAINTEXT (Atzr…) không được lưu — bắt buộc tiền tố enc:v1:",
);
ok(
  await mustBlock(`select * from public.vexim_oauth_upsert_token(
     '{"sellerAccountId":"${cShop}","service":"spapi"}'::jsonb)`),
  "0020 CHẶN: thiếu encryptedRefreshToken → từ chối (không lưu token rỗng)",
);

const t1 = await upToken({
  sellerAccountId: cShop, service: "spapi", encryptedRefreshToken: ENC("spapi-340d"),
  authorizedAt: iso(340), expiresAt: iso(-25), clientId: "amzn1.application-oa2-client.demo",
  scope: "sellingpartnerapi::all", sellingPartnerId: "A2XYZUSDEMO", tokenSource: "oauth",
  authorizedBy: oUser,
});
ok(
  t1?.service === "spapi" && t1?.status === "active" && Number(t1?.days_to_reauth) >= 24
    && Number(t1?.days_to_reauth) <= 26,
  `0020: token SP-API lưu được, hạn re-authorize = authorized + 365 ngày (còn ${t1?.days_to_reauth} ngày)`,
);
const t1row = await one(`select encrypted_refresh_token, authorized_at, reauthorize_at, reminder_days,
     rotate_reminder_sent, token_source, selling_partner_id
     from connections.oauth_tokens where seller_account_id='${cShop}' and service='spapi'`);
ok(
  String(t1row?.encrypted_refresh_token).startsWith("enc:v1:")
    && Number(t1row?.reminder_days) === 30 && t1row?.rotate_reminder_sent === false
    && t1row?.token_source === "oauth",
  `0020: token lưu DẠNG MÃ HOÁ + reminder 30 ngày (giống email Amazon gửi chủ shop) — ${JSON.stringify(t1row)}`,
);
ok(
  (await one(`select (reauthorize_at - authorized_at) as span,
       ((reauthorize_at - authorized_at) = interval '365 days') as exact365
       from connections.oauth_tokens where seller_account_id='${cShop}' and service='spapi'`)).exact365 === true,
  "0020: reauthorize_at - authorized_at = ĐÚNG 365 ngày (chu kỳ Amazon)",
);

const t2 = await upToken({
  sellerAccountId: cShop, service: "ads", encryptedRefreshToken: ENC("ads-350d"),
  authorizedAt: iso(350), clientId: "amzn1.application-oa2-client.ads",
  scope: "ads::campaign_management", adsAccountId: "1234567890", tokenSource: "env",
});
ok(t2?.service === "ads" && Number(t2?.days_to_reauth) <= 16,
   `0020: token Ads là DÒNG RIÊNG của cùng shop (còn ${t2?.days_to_reauth} ngày → sắp đỏ)`);
await cmp(
  "0020: 1 shop = 2 token (SP-API + Ads), không đè nhau",
  `select count(*) n from connections.oauth_tokens where seller_account_id='${cShop}'`,
  2,
);

// re-authorize lại → hạn lùi 365 ngày, alert cũ tự đóng
const t3 = await upToken({
  sellerAccountId: cShop, service: "spapi", encryptedRefreshToken: ENC("spapi-fresh"),
  authorizedAt: iso(0), clientId: "amzn1.application-oa2-client.demo",
  scope: "sellingpartnerapi::all", tokenSource: "oauth",
});
await cmp(
  "0020: upsert lại = UPDATE đúng dòng (không nhân bản token)",
  `select count(*) n from connections.oauth_tokens where seller_account_id='${cShop}'`,
  2,
);
ok(Number(t3?.days_to_reauth) >= 364,
   `0020: vừa re-authorize → hạn mới còn ${t3?.days_to_reauth} ngày (hết cảnh báo)`);

// ---- 4. MODULE 0 — audit event + state chống CSRF/replay --------------------
await one(`select public.vexim_oauth_record_event(
   '{"sellerAccountId":"${cShop}","service":"ads","event":"token_refresh","status":"ok",
     "detail":"LWA refresh 200, expires_in 3600"}'::jsonb)`);
await one(`select public.vexim_oauth_record_event(
   '{"sellerAccountId":"${cShop}","service":"ads","event":"report_throttled","status":"error",
     "detail":"429 QuotaExceeded, Retry-After 30 — KHÔNG retry dồn"}'::jsonb)`);
await cmp(
  "0020: audit luồng OAuth ghi vào connections.oauth_events",
  `select count(*) n from connections.oauth_events where seller_account_id='${cShop}'`,
  2,
);
const stRes = await one(`select public.vexim_oauth_set_state(
   '{"state":"state-demo-0020","service":"ads","sellerAccountId":"${cShop}",
     "redirectUri":"/ppc","scope":"ads::campaign_management","sellerHint":"A2XYZUSDEMO"}'::jsonb) s`);
ok(stRes?.s === "state-demo-0020", `0020: state ghi nhận cho lượt authorize (${stRes?.s})`);
const cs1 = await one(`select * from public.vexim_oauth_consume_state('state-demo-0020','ok')`);
ok(
  cs1?.service === "ads" && cs1?.seller_account_id === cShop && cs1?.redirect_uri === "/ppc"
    && cs1?.expired === false && cs1?.already_used === false,
  `0020: consume state lần 1 → đúng shop + redirect — ${JSON.stringify(cs1)}`,
);
const cs2 = await one(`select * from public.vexim_oauth_consume_state('state-demo-0020','ok')`);
ok(cs2?.already_used === true,
   "0020: state dùng LẦN 2 → already_used=true (chống replay/CSRF: 1 code chỉ đổi 1 lần)");

// ---- 5. MODULE 0 — quét re-authorize 365 ngày + dedupe alert -----------------
const scan1 = await rows19(`select * from public.vexim_oauth_reauth_scan(30)`);
const scanAds = scan1.find((r) => r.shop_id === cShop && r.token_service === "ads");
ok(
  scanAds && scanAds.token_service === "ads" && scanAds.alert_severity === "amber"
    && scanAds.next_action === "send_reauth_link" && scanAds.alert_id,
  `0020: quét re-auth thấy token Ads còn ~15 ngày → amber + gửi link — ${JSON.stringify(scanAds)}`,
);
const scanSpapi = scan1.filter((r) => r.shop_id === cShop && r.token_service === "spapi")[0];
ok(
  scanSpapi?.alert_severity === null && scanSpapi?.next_action === "none",
  `0020: token SP-API vừa re-authorize → không cảnh báo (${scanSpapi?.days_to_reauth} ngày)`,
);
await cmp(
  "0020: alert reauth_required nổ đúng 1 cái cho shop",
  `select count(*) n from ops.alerts a join ops.alert_rules r on r.id=a.rule_id
    where a.seller_account_id='${cShop}' and r.rule_code='reauth_required' and a.status='open'`,
  1,
);
const scan2 = await rows19(`select * from public.vexim_oauth_reauth_scan(30)`);
ok(
  scan2.filter((r) => r.shop_id === cShop && r.token_service === "ads")[0]?.alert_id
    === scanAds?.alert_id,
  "0020: quét LẦN 2 → cùng alert_id (dedupe, không spam chuông)",
);
await cmp(
  "0020: quét 2 lần vẫn 1 alert mở (entity_key = token:<service>)",
  `select count(*) n from ops.alerts a join ops.alert_rules r on r.id=a.rule_id
    where a.seller_account_id='${cShop}' and r.rule_code='reauth_required' and a.status='open'`,
  1,
);
ok(
  (await one(`select reminder_sent_at is not null as sent, rotate_reminder_sent
     from connections.oauth_tokens where seller_account_id='${cShop}' and service='ads'`)).sent === true,
  "0020: đã đánh dấu reminder_sent_at (không gửi nhắc lại mỗi ngày)",
);

// quá hạn → token chuyển expired để worker KHÔNG gọi API bằng token chết
await upToken({
  sellerAccountId: cShop, service: "ads", encryptedRefreshToken: ENC("ads-400d"),
  authorizedAt: iso(400), tokenSource: "oauth",
});
const scan3 = await rows19(`select * from public.vexim_oauth_reauth_scan(30,'ads')`);
const over = scan3.find((r) => r.shop_id === cShop);
ok(
  over && over.alert_severity === "red" && over.next_action === "reauthorize_now"
    && Number(over.days_to_reauth) < 0,
  `0020: quá hạn 365 ngày → ĐỎ + reauthorize_now (${over?.days_to_reauth} ngày)`,
);
const dead = await one(`select status, last_error from connections.oauth_tokens
   where seller_account_id='${cShop}' and service='ads'`);
ok(
  dead?.status === "expired" && /quá hạn/.test(String(dead?.last_error ?? "")),
  `0020: token quá hạn tự chuyển EXPIRED — worker dừng gọi API bằng token chết (${dead?.last_error})`,
);

// ---- 6. MODULE 5 — profiles (GET /v2/profiles, bản NESTED thật của Amazon) ----
const prof = await one(`select * from public.vexim_worker_upsert_ads_profiles('${cShop}', '[
  {"profileId":"1234567890","countryCode":"US","currencyCode":"USD","timezone":"America/Los_Angeles",
   "marketplaceStringId":"ATVPDKIKX0DER","accountId":"amzn1.account.ABC",
   "accountInfo":{"id":"A2XYZUSDEMO","type":"seller","name":"VEXIM Demo US"},
   "dailyBudget":{"currency":"USD","amount":500},"isDefault":true},
  {"profileId":"9876543210","countryCode":"CA","currencyCode":"CAD","timezone":"America/Toronto",
   "accountInfo":{"id":"A2XYZCADEMO","type":"seller","name":"VEXIM Demo CA"},"isDefault":false},
  {"profileId":"5555555555","countryCode":"US","currencyCode":"USD",
   "accountInfo":{"id":"VENDOR-DEMO","type":"vendor","name":"VEXIM Vendor"}},
  {"countryCode":"US","accountInfo":{"id":"no-profile","type":"seller"}}
]'::jsonb)`);
ok(
  Number(prof?.inserted) === 3 && Number(prof?.updated) === 0 && Number(prof?.skipped) === 1
    && Number(prof?.profiles) === 3 && Number(prof?.merged) === 0,
  `0020 profiles: 3 profile (bỏ 1 dòng không có profileId) — ${JSON.stringify(prof)}`,
);
const profRow = await one(`select account_id, account_type, account_name, daily_budget, currency,
     is_default, marketplace from public.vexim_ads_profiles
     where seller_account_id='${cShop}' and ads_profile_id='1234567890'`);
ok(
  profRow?.account_type === "seller" && profRow?.account_name === "VEXIM Demo US"
    && profRow?.account_id === "A2XYZUSDEMO" && Number(profRow?.daily_budget) === 500
    && profRow?.is_default === true,
  `0020 profiles: đọc được accountInfo{} + dailyBudget{} NESTED của Amazon — ${JSON.stringify(profRow)}`,
);
const profVendor = await one(`select account_type from public.vexim_ads_profiles
   where seller_account_id='${cShop}' and ads_profile_id='5555555555'`);
ok(profVendor?.account_type === "vendor",
   "0020 profiles: profile VENDOR vẫn lưu + gắn nhãn (worker tự chọn profile seller, không xoá dữ liệu)");
const profAgain = await one(`select * from public.vexim_worker_upsert_ads_profiles('${cShop}', '[
  {"profileId":"1234567890","countryCode":"US","currencyCode":"USD",
   "accountInfo":{"id":"A2XYZUSDEMO","type":"seller","name":"VEXIM Demo US (đổi tên)"},"isDefault":true}
]'::jsonb)`);
ok(Number(profAgain?.inserted) === 0 && Number(profAgain?.updated) === 1,
   `0020 profiles: nhập lại = UPDATE — ${JSON.stringify(profAgain)}`);

// ---- 7. MODULE 5 — campaigns (POST /sp/campaigns/list v3, budget NESTED) -----
const camp = await one(`select * from public.vexim_worker_upsert_ads_campaigns('${cShop}', '[
  {"campaignId":"C1","name":"SP - Mat ong 500ml","state":"ENABLED","costType":"CPC",
   "targetingType":"MANUAL","startDate":"20260801","adsProfileId":"1234567890",
   "budget":{"budget":25.00,"currencyCode":"USD","budgetType":"DAILY"}},
  {"campaignId":"C2","name":"SP - ROAS tot","state":"ENABLED","costType":"CPC",
   "targetingType":"AUTO","startDate":"20260715","adsProfileId":"1234567890",
   "budget":{"budget":40,"currencyCode":"USD","budgetType":"DAILY"}},
  {"campaignId":"C3","name":"SP - CAD","state":"PAUSED","adsProfileId":"9876543210",
   "budget":{"budget":15,"currencyCode":"CAD","budgetType":"DAILY"}},
  {"name":"thieu campaignId","state":"ENABLED"}
]'::jsonb)`);
ok(
  Number(camp?.inserted) === 3 && Number(camp?.skipped) === 1 && Number(camp?.campaigns) === 3
    && Number(camp?.merged) === 0,
  `0020 campaigns: 3 campaign (bỏ 1 dòng không campaignId) — ${JSON.stringify(camp)}`,
);
const c1 = await one(`select daily_budget, budget_currency, budget_type, start_date, state, targeting_type
   from ads.campaigns where seller_account_id='${cShop}' and campaign_id='C1'`);
ok(
  Number(c1?.daily_budget) === 25 && c1?.budget_currency === "USD" && c1?.budget_type === "DAILY"
    && d10(c1?.start_date) === "2026-08-01",
  `0020 campaigns: budget{} NESTED + startDate "20260801" (yyyyMMdd) đọc đúng — ${JSON.stringify({ ...c1, start_date: d10(c1?.start_date) })}`,
);
await one(`select * from public.vexim_worker_upsert_ads_campaigns('${cShop}', '[
  {"campaignId":"C3","name":"SP - CAD","state":"PAUSED","adsProfileId":"9876543210",
   "budget":{"budget":0,"currencyCode":"CAD","budgetType":"DAILY"}}]'::jsonb)`);
ok(
  Number((await one(`select daily_budget from ads.campaigns
     where seller_account_id='${cShop}' and campaign_id='C3'`)).daily_budget) === 0,
  "0020 campaigns: ngân sách về 0 được GHI ĐÈ (0 là thông tin thật, không phải 'thiếu dữ liệu')",
);

// ---- 8. MODULE 5 — metrics ngày (Reporting v3, spCampaigns) ------------------
const M_DAYS = ["2026-09-05","2026-09-06","2026-09-07","2026-09-08","2026-09-09","2026-09-10"];
const metricRows = [
  // C1 lỗ (ACOS 50%): Amazon KHÔNG trả ctr/cpc/acos → DB phải tự tính
  ...M_DAYS.map((d) => ({ date: d, campaignId: "C1", campaignName: "SP - Mat ong 500ml",
    impressions: 1000, clicks: 10, cost: 10, sales7d: 20, purchases7d: 2,
    unitsSoldClicks7d: 2, currencyCode: "USD", campaignStatus: "enabled", reportId: "rep-c1" })),
  { date: "2026-09-11", campaignId: "C1", campaignName: "SP - Mat ong 500ml", impressions: 1200,
    clicks: 12, cost: 12, sales7d: 25, purchases7d: 3, unitsSoldClicks7d: 3, currencyCode: "USD",
    campaignStatus: "enabled", campaignBudgetAmount: "25.00", reportId: "rep-c1b" },
  // trùng ngày (report chồng khoảng) → KHÔNG được cộng dồn tiền
  { date: "2026-09-11", campaignId: "C1", impressions: 1200, clicks: 12, cost: 12, sales7d: 25,
    purchases7d: 3, currencyCode: "USD", reportId: "rep-c1c" },
  // C2 lãi (ACOS ~7%)
  ...M_DAYS.map((d) => ({ date: d, campaignId: "C2", campaignName: "SP - ROAS tot", impressions: 2000,
    clicks: 20, cost: 5, sales7d: 70, purchases7d: 5, currency: "USD" })),
  { date: "2026-09-11", campaignId: "C2", impressions: 2000, clicks: 20, cost: 5, sales7d: 70,
    purchases7d: 5, currency: "USD" },
  // C3 = CAD → KHÔNG cộng chung với USD
  { date: "2026-09-11", campaignId: "C3", impressions: 100, clicks: 4, cost: 8, sales7d: 40,
    purchases7d: 1, currencyCode: "CAD" },
  // rác: thiếu ngày / thiếu campaignId
  { campaignId: "C1", cost: 99, currencyCode: "USD" },
  { date: "2026-09-11", cost: 99, currencyCode: "USD" },
];
const m1 = await one(`select * from public.vexim_worker_upsert_ads_metrics('${cShop}', '${JSON.stringify(metricRows)}'::jsonb)`);
ok(
  Number(m1?.inserted) === 15 && Number(m1?.updated) === 0 && Number(m1?.skipped) === 2
    && Number(m1?.merged) === 1 && Number(m1?.days) === 7 && m1?.currencies === "CAD,USD",
  `0020 metrics: 15 dòng mới · 1 cặp trùng ngày GỘP bằng max (không cộng dồn tiền) · bỏ 2 rác · tiền tệ CAD,USD — ${JSON.stringify(m1)}`,
);
const dup = await one(`select * from public.vexim_worker_upsert_ads_metrics('${cShop}', '${JSON.stringify(metricRows)}'::jsonb)`);
ok(Number(dup?.inserted) === 0 && Number(dup?.updated) === 15 && Number(dup?.skipped) === 2,
   `0020 metrics: nhập LẠI cùng lô → 15 update / 0 insert (không nhân đôi tiền) — ${JSON.stringify(dup)}`);
await cmp(
  "0020 metrics: 2 lần nhập vẫn 15 dòng, ngày 09-11 của C1 không bị cộng dồn",
  `select count(*) n from ads.ad_metrics_daily where seller_account_id='${cShop}'`,
  15,
);
const d11 = await one(`select spend, sales7d, orders, clicks, impressions, ctr, cpc, acos7d, roas7d,
     budget_amount, currency from ads.ad_metrics_daily
     where seller_account_id='${cShop}' and campaign_id='C1' and day='2026-09-11'`);
ok(
  Number(d11?.spend) === 12 && Number(d11?.sales7d) === 25 && Number(d11?.orders) === 3
    && Number(d11?.ctr) === 1 && Number(d11?.cpc) === 1 && Number(d11?.acos7d) === 48
    && Number(d11?.roas7d) === 2.0833 && Number(d11?.budget_amount) === 25,
  `0020 metrics: Amazon không trả ctr/cpc/acos/roas → DB TỰ TÍNH (ctr 1% · cpc 1 · ACOS 48% · ROAS 2.08) — ${JSON.stringify(d11)}`,
);

// ---- 9. A1 — view campaign: cửa sổ 7 ngày + cờ vượt ngưỡng + ngân sách -------
const cv = await rows19(`select campaign_id, currency, state, daily_budget, spend_yesterday, spend7,
     sales7, acos7, roas7, ctr7, cpc7, ad_orders7, days_with_data, over_acos_target, acos_target,
     budget_used_pct, budget_exhausted, last_metrics_day
     from public.vexim_ads_campaigns where seller_account_id='${cShop}' order by campaign_id`);
ok(cv.length === 3, `0020 view campaign: 3 dòng (nhận ${cv.length})`);
const cvOf = (id) => cv.find((r) => r.campaign_id === id);
ok(
  Number(cvOf("C1")?.spend7) === 72 && Number(cvOf("C1")?.sales7) === 145
    && Number(cvOf("C1")?.acos7) === 49.66 && Number(cvOf("C1")?.roas7) === 2.01
    && Number(cvOf("C1")?.days_with_data) === 7 && Number(cvOf("C1")?.spend_yesterday) === 12,
  `0020 view campaign: C1 gộp 7 ngày spend 72 / sales 145 → ACOS 49.66% · ROAS 2.01 — ${JSON.stringify(cvOf("C1"))}`,
);
ok(
  cvOf("C1")?.over_acos_target === true && Number(cvOf("C1")?.acos_target) === 25
    && cvOf("C2")?.over_acos_target === false,
  "0020 view campaign: C1 vượt ngưỡng ACOS 25% (cờ đỏ cho UI) · C2 thì không",
);
ok(
  Number(cvOf("C1")?.ctr7) === 1 && Number(cvOf("C1")?.cpc7) === 1
    && Number(cvOf("C2")?.acos7) === 7.14,
  `0020 view campaign: ctr7/cpc7 gộp từ tổng (không trung bình của trung bình) · C2 ACOS 7.14% — ${JSON.stringify(cvOf("C2"))}`,
);
ok(
  cvOf("C3")?.currency === "CAD" && Number(cvOf("C3")?.spend7) === 8
    && Number(cvOf("C1")?.spend7) === 72,
  "0020 view campaign: CAD và USD là 2 DÒNG RIÊNG — không cộng tiền khác tiền tệ",
);

// ---- 10. Budget usage: % đã dùng + GIỜ CẠN (ước lượng) ----------------------
const bu = await one(`select * from public.vexim_worker_upsert_ads_budget_usage('${cShop}', '[
  {"date":"2026-09-11","campaignId":"C1","campaignName":"SP - Mat ong 500ml","budget":25,
   "spend":12.5,"percentageUsed":50,"currency":"USD","deliveredClicks":12,
   "capturedAt":"2026-09-11T10:05:00Z","adsProfileId":"1234567890"},
  {"date":"2026-09-11","campaignId":"C1","budget":25,"spend":25,"percentageUsed":100,
   "currency":"USD","capturedAt":"2026-09-11T14:05:00Z"},
  {"date":"2026-09-11","campaignId":"C1","budget":25,"spend":25,"percentageUsed":100,
   "currency":"USD","capturedAt":"2026-09-11T14:35:00Z"},
  {"date":"2026-09-11","campaignId":"C2","budget":40,"spend":5,"percentageUsed":12.5,
   "currency":"USD","capturedAt":"2026-09-11T14:05:00Z"},
  {"date":"khong hop le","campaignId":"C9","percentageUsed":10}
]'::jsonb)`);
ok(
  Number(bu?.rows_written) === 3 && Number(bu?.skipped) === 1 && Number(bu?.merged) === 1
    && Number(bu?.exhausted) === 1,
  `0020 budget: 3 lần chụp ghi được (2 lần cùng GIỜ gộp còn 1) · bỏ 1 rác · 1 campaign đã cạn — ${JSON.stringify(bu)}`,
);
await cmp(
  "0020 budget: 2 lần chụp CÙNG GIỜ → 1 dòng (khoá theo giờ, bảng không phình)",
  `select count(*) n from ads.budget_usage where seller_account_id='${cShop}' and campaign_id='C1'`,
  2,
);
const bv = await one(`select campaign_id, percentage_used, budget, spend, budget_exhausted,
     snapshots_over_100pct, exhausted_note,
     to_char(exhausted_at_estimate at time zone 'UTC','YYYY-MM-DD HH24') as exhausted_hour
     from public.vexim_ads_budget_usage
     where seller_account_id='${cShop}' and campaign_id='C1'`);
ok(
  bv?.budget_exhausted === true && bv?.exhausted_hour === "2026-09-11 14"
    && Number(bv?.snapshots_over_100pct) === 1 && Number(bv?.percentage_used) === 100,
  `0020 budget view: C1 cạn lúc ~14h (ƯỚC LƯỢNG từ lần chụp đầu ≥100%) — ${JSON.stringify(bv)}`,
);
ok(String(bv?.exhausted_note).includes("Ước lượng"),
   `0020 budget view: có nhãn nói rõ đây là ước lượng ("${bv?.exhausted_note}")`);
ok(
  Number(cvOf("C1")?.budget_used_pct) === 50
    || Number((await one(`select budget_used_pct from public.vexim_ads_campaigns
         where seller_account_id='${cShop}' and campaign_id='C1'`)).budget_used_pct) === 100,
  "0020 view campaign: budget_used_pct lấy từ Budget Usage (lần chụp mới nhất)",
);

// ---- 11. Alert ACOS / BUDGET tự nổ + tự đóng khi hết vi phạm ----------------
const al1 = await rows19(`select * from public.vexim_ads_raise_alerts('${cShop}','2026-09-11')`);
const alAcos = al1.find((r) => r.rule_code === "acos_over_target");
const alBudget = al1.find((r) => r.rule_code === "budget_exhausted");
ok(
  alAcos?.severity === "amber" && alAcos?.entity_key === "campaign:C1"
    && Number(alAcos?.metric) === 49.66 && Number(alAcos?.threshold) === 25 && alAcos?.alert_id,
  `0020 alert: ACOS 49.66% > 25% → nổ amber cho campaign C1 — ${JSON.stringify(alAcos)}`,
);
ok(
  alBudget?.severity === "amber" && alBudget?.entity_key === "budget:C1" && alBudget?.alert_id,
  `0020 alert: cạn ngân sách → nổ amber — ${JSON.stringify(alBudget)}`,
);
ok(
  !al1.some((r) => r.entity_key === "campaign:C2"),
  "0020 alert: C2 (ACOS 7.14%) KHÔNG bị cảnh báo — ngưỡng đọc từ ops.alert_rules",
);
await cmp(
  "0020 alert: đúng 2 alert PPC mở cho shop",
  `select count(*) n from ops.alerts a join ops.alert_rules r on r.id=a.rule_id
    where a.seller_account_id='${cShop}' and a.status='open'
      and r.rule_code in ('acos_over_target','budget_exhausted')`,
  2,
);
const al2 = await rows19(`select * from public.vexim_ads_raise_alerts('${cShop}','2026-09-11')`);
ok(
  al2.find((r) => r.rule_code === "acos_over_target")?.alert_id === alAcos?.alert_id,
  "0020 alert: chạy LẠI → cùng alert_id (dedupe theo entity_key, không spam)",
);

// C1 được tối ưu: sales tăng → ACOS về 4.97% → alert phải TỰ ĐÓNG
const goodRows = [
  ...M_DAYS.map((d) => ({ date: d, campaignId: "C1", impressions: 1000, clicks: 10, cost: 10,
    sales7d: 200, purchases7d: 20, currencyCode: "USD" })),
  { date: "2026-09-11", campaignId: "C1", impressions: 1200, clicks: 12, cost: 12, sales7d: 250,
    purchases7d: 25, currencyCode: "USD" },
];
await one(`select * from public.vexim_worker_upsert_ads_metrics('${cShop}', '${JSON.stringify(goodRows)}'::jsonb)`);
const al3 = await rows19(`select * from public.vexim_ads_raise_alerts('${cShop}','2026-09-11')`);
ok(
  al3.find((r) => r.rule_code === "acos_over_target")?.next_action === "resolved",
  `0020 alert: ACOS về 4.97% (< 25%) → TỰ ĐÓNG alert — ${JSON.stringify(al3.find((r) => r.rule_code === "acos_over_target"))}`,
);
await cmp(
  "0020 alert: alert ACOS chuyển resolved (chuông hết reo)",
  `select count(*) n from ops.alerts a join ops.alert_rules r on r.id=a.rule_id
    where a.seller_account_id='${cShop}' and r.rule_code='acos_over_target' and a.status='resolved'`,
  1,
);
ok(
  (await one(`select over_acos_target from public.vexim_ads_campaigns
     where seller_account_id='${cShop}' and campaign_id='C1'`)).over_acos_target === false,
  "0020 view campaign: cờ over_acos_target tắt theo dữ liệu mới",
);

// ---- 12. A3 — search term (giữ term "*", gộp 7 ngày, tín hiệu đốt tiền) -----
const stRows = [
  { date: "2026-09-11", searchTerm: "mat ong 500ml", campaignId: "C1", adGroupId: "AG1",
    keywordId: "K1", keywordText: "mat ong", matchType: "BROAD", keywordType: "BROAD",
    impressions: 100, clicks: 4, cost: 4, sales7d: 40, purchases7d: 2, keywordBid: 1.0,
    currencyCode: "USD", campaignName: "SP - Mat ong 500ml", adGroupName: "Ad group 1" },
  { date: "2026-09-10", searchTerm: "mat ong 500ml", campaignId: "C1", adGroupId: "AG1",
    keywordId: "K1", matchType: "BROAD", impressions: 50, clicks: 2, cost: 2, sales7d: 20,
    purchases7d: 1, currencyCode: "USD" },
  { date: "2026-09-11", searchTerm: "sua rua mat re tien", campaignId: "C1", adGroupId: "AG1",
    keywordId: "K2", matchType: "BROAD", impressions: 80, clicks: 5, cost: 7.5, sales7d: 0,
    purchases7d: 0, currencyCode: "USD" },
  { date: "2026-09-11", searchTerm: "*", campaignId: "C1", adGroupId: "AG1", impressions: 30,
    clicks: 1, cost: 1, sales7d: 10, purchases7d: 1, currencyCode: "USD" },
  { date: "2026-09-11", campaignId: "C1", clicks: 1, cost: 0.5 },
];
const st = await one(`select * from public.vexim_worker_upsert_ads_search_terms('${cShop}', '${JSON.stringify(stRows)}'::jsonb)`);
ok(
  Number(st?.rows_written) === 4 && Number(st?.skipped) === 1 && Number(st?.terms) === 3
    && Number(st?.merged) === 0,
  `0020 search term: 4 dòng · 3 term · bỏ 1 dòng thiếu term — ${JSON.stringify(st)}`,
);
const stv = await rows19(`select search_term, is_placement_without_keyword, clicks, spend, sales7,
     acos7, days_with_data, wasted_spend_signal
     from public.vexim_ads_search_terms where seller_account_id='${cShop}' order by spend desc`);
const stOf = (t) => stv.find((r) => r.search_term === t);
ok(
  Number(stOf("mat ong 500ml")?.clicks) === 6 && Number(stOf("mat ong 500ml")?.spend) === 6
    && Number(stOf("mat ong 500ml")?.sales7) === 60 && Number(stOf("mat ong 500ml")?.acos7) === 10
    && Number(stOf("mat ong 500ml")?.days_with_data) === 2
    && stOf("mat ong 500ml")?.wasted_spend_signal === false,
  `0020 search term view: gộp 2 ngày (6 click · 6$ · sales 60$ · ACOS 10%) — ${JSON.stringify(stOf("mat ong 500ml"))}`,
);
ok(
  stOf("sua rua mat re tien")?.wasted_spend_signal === true
    && Number(stOf("sua rua mat re tien")?.clicks) === 5
    && Number(stOf("sua rua mat re tien")?.sales7) === 0,
  `0020 search term view: 5 click · 0 đơn → cờ "đốt tiền" cho gợi ý negative (Phần 2 mới có luồng duyệt) — ${JSON.stringify(stOf("sua rua mat re tien"))}`,
);
ok(
  stOf("*")?.is_placement_without_keyword === true && Number(stOf("*")?.spend) === 1,
  '0020 search term view: term "*" = placement không gắn từ khoá → GIỮ LẠI (bỏ là thiếu spend)',
);

// ---- 13. A2 — targeting (keyword vs target ASIN/category) -------------------
const tg = await one(`select * from public.vexim_worker_upsert_ads_targeting('${cShop}', '[
  {"date":"2026-09-11","campaignId":"C1","adGroupId":"AG1","adGroupName":"Ad group 1",
   "keywordId":"K1","keywordText":"mat ong","matchType":"BROAD","keywordType":"BROAD",
   "impressions":100,"clicks":4,"cost":4,"sales7d":40,"purchases7d":2,"keywordBid":1.0,
   "currencyCode":"USD","adsProfileId":"1234567890","reportId":"rep-tg"},
  {"date":"2026-09-11","campaignId":"C1","adGroupId":"AG1",
   "targetingExpression":"b0demoasin9","keywordType":"TARGETING_EXPRESSION_PREDEFINED",
   "impressions":50,"clicks":2,"cost":2,"sales7d":0,"purchases7d":0,"currencyCode":"USD"},
  {"date":"2026-09-11","campaignId":"C1","adGroupId":"AG1","impressions":10,"clicks":1,"cost":1}
]'::jsonb)`);
ok(Number(tg?.rows_written) === 2 && Number(tg?.skipped) === 1 && Number(tg?.merged) === 0,
   `0020 targeting: 2 dòng (keyword + target ASIN) · bỏ 1 dòng không khoá được — ${JSON.stringify(tg)}`);
const tgv = await rows19(`select target_label, keyword_text, is_product_targeting, clicks, spend, acos7d
   from public.vexim_ads_targeting where seller_account_id='${cShop}' order by target_label`);
ok(
  tgv.find((r) => r.target_label === "b0demoasin9")?.is_product_targeting === true
    && tgv.find((r) => r.target_label === "mat ong")?.is_product_targeting === false,
  `0020 targeting view: phân biệt keyword với target ASIN/category — ${JSON.stringify(tgv)}`,
);

// ---- 14. F4 — lấp ads_spend THẬT (cột riêng, KHÔNG trừ vào lãi gộp) ----------
await one(`select * from public.vexim_worker_upsert_profit('${cShop}', '[
  {"sku":"ADS-SKU-1","day":"2026-09-11","currency":"USD","units":5,"revenue":250,
   "amazonFees":40,"cogs":100,"grossProfit":110,"feeSource":"settled"}]'::jsonb)`);
await ex("reset role;");
ok(
  await ex(`insert into catalog.listings(seller_account_id,sku,asin,title,status,currency)
     values ('${cShop}','ADS-SKU-2','B0ADSDEMO02','Demo ASIN 0020','active','USD')
     on conflict (seller_account_id,sku) do update set asin=excluded.asin`),
  "0020 fixture: listing ADS-SKU-2 ↔ B0ADSDEMO02 (để test suy SKU qua ASIN)",
);
await ex("set role service_role;");
const adv = await one(`select * from public.vexim_worker_upsert_ads_advertised('${cShop}', '[
  {"date":"2026-09-11","campaignId":"C1","adGroupId":"AG1","advertisedAsin":"B0ADSDEMO01",
   "advertisedSku":"ADS-SKU-1","impressions":100,"clicks":5,"cost":6.50,"sales7d":60,
   "purchases7d":3,"currencyCode":"USD","adsProfileId":"1234567890","reportId":"rep-adv"},
  {"date":"2026-09-11","campaignId":"C1","adGroupId":"AG1","advertisedAsin":"B0ADSDEMO02",
   "cost":3.25,"currencyCode":"USD"},
  {"date":"2026-09-11","campaignId":"C1","adGroupId":"AG1","advertisedAsin":"B0CHUACO",
   "cost":2.00,"currencyCode":"USD"},
  {"date":"2026-09-11","campaignId":"C1","adGroupId":"AG1","cost":9.99,"currencyCode":"USD"}
]'::jsonb)`);
ok(
  Number(adv?.rows_written) === 3 && Number(adv?.skipped) === 1 && Number(adv?.days) === 1
    && Number(adv?.merged) === 0,
  `0020 advertised product: 3 dòng · bỏ 1 dòng không ASIN không SKU — ${JSON.stringify(adv)}`,
);
const fill = await one(`select * from public.vexim_worker_fill_profit_ads_spend('${cShop}','2026-09-01','2026-09-30')`);
ok(
  Number(fill?.rows_updated) === 1 && Number(fill?.days) === 1 && Number(fill?.skus) === 2
    && Number(fill?.unmatched) === 1 && fill?.currencies === "USD",
  `0020 F4: lấp ads_spend 1 dòng · suy được 2 SKU (1 qua advertisedSku, 1 qua ASIN) · 1 dòng CHƯA khớp (báo ra, không bỏ qua) — ${JSON.stringify(fill)}`,
);
const f4 = await one(`select ads_spend, gross_profit, revenue from finance.sku_profit_daily
   where seller_account_id='${cShop}' and sku='ADS-SKU-1' and day='2026-09-11'`);
ok(
  Number(f4?.ads_spend) === 6.5 && Number(f4?.gross_profit) === 110,
  `0020 F4: ads_spend=6.5 là CỘT RIÊNG — gross_profit vẫn 110 (không trừ ads vào lãi gộp) — ${JSON.stringify(f4)}`,
);
await cmp(
  "0020 F4: SKU chưa có dòng lợi nhuận thì KHÔNG bịa (không insert hộ)",
  `select count(*) n from finance.sku_profit_daily where seller_account_id='${cShop}'`,
  1,
);

// ---- 15. Report Ads bất đồng bộ: ghi trạng thái → cron sau POLL tiếp --------
const rr1 = await one(`select * from public.vexim_worker_set_ads_report_request('${cShop}',
  '{"reportTypeId":"spCampaigns","adProduct":"SPONSORED_PRODUCTS","groupBy":"campaign",
    "timeUnit":"DAILY","dateStart":"2026-09-05","dateEnd":"2026-09-11","adsProfileId":"1234567890",
    "adsReportId":"amzn-rid-1","status":"PROCESSING","requestedAt":"2026-09-11T20:00:00Z"}'::jsonb)`);
ok(rr1?.status === "processing" && rr1?.ads_report_id === "amzn-rid-1",
   `0020 report Ads: yêu cầu report → ghi trạng thái PROCESSING — ${JSON.stringify(rr1)}`);
const pend = await one(`select public.vexim_worker_pending_ads_reports('${cShop}') items`);
ok(
  Array.isArray(pend?.items) && pend.items.length === 1
    && pend.items[0].ads_report_id === "amzn-rid-1" && pend.items[0].report_type_id === "spCampaigns",
  `0020 report Ads: cron lần sau tìm đúng report đang chờ để POLL tiếp (không xin report mới) — ${JSON.stringify(pend?.items)}`,
);
const rr2 = await one(`select * from public.vexim_worker_set_ads_report_request('${cShop}',
  '{"reportTypeId":"spCampaigns","groupBy":"campaign","timeUnit":"DAILY","dateStart":"2026-09-05",
    "dateEnd":"2026-09-11","adsProfileId":"1234567890","adsReportId":"amzn-rid-1",
    "status":"COMPLETED","downloadUrl":"https://advertising.amazon.com/download?token=SECRET",
    "rowsImported":15,"completedAt":"2026-09-11T20:05:00Z"}'::jsonb)`);
ok(rr2?.status === "completed", `0020 report Ads: poll thấy COMPLETED → cập nhật cùng dòng — ${JSON.stringify(rr2)}`);
await cmp(
  "0020 report Ads: cùng khoá (shop×profile×loại×groupBy×timeUnit×khoảng ngày) = 1 dòng",
  `select count(*) n from ads.report_requests where seller_account_id='${cShop}'`,
  1,
);
const rrv = await one(`select status, attempts, rows_imported, is_stale,
     (select count(*) from information_schema.columns c
       where c.table_schema='public' and c.table_name='vexim_ads_report_requests'
         and c.column_name='download_url') as url_exposed
     from public.vexim_ads_report_requests where seller_account_id='${cShop}'`);
ok(
  rrv?.status === "completed" && Number(rrv?.attempts) === 2 && Number(rrv?.rows_imported) === 15
    && Number(rrv?.url_exposed) === 0,
  `0020 report Ads view: 2 lần chạm · 15 dòng nhập · KHÔNG phơi download_url (URL có token) — ${JSON.stringify(rrv)}`,
);
await cmp(
  "0020 report Ads: hết report chờ → cron sau không poll thừa",
  `select jsonb_array_length(public.vexim_worker_pending_ads_reports('${cShop}')) n`,
  0,
);

// ---- 16. KPI + TACOS: chưa có doanh thu tổng → NULL, không bịa 0% -----------
const kpi0 = await rows19(`select currency, spend_yesterday, spend7, ad_sales7, acos7, roas7, ctr7,
     cpc7, total_sales7, tacos7, tacos_unknown, campaigns_enabled, campaigns_over_target,
     campaigns_exhausted, budget_daily_total, is_stale, metrics_day
     from public.vexim_ads_kpis where seller_account_id='${cShop}' order by currency`);
ok(kpi0.length === 2, `0020 KPI: 2 dòng = 2 tiền tệ (CAD, USD) — nhận ${kpi0.length}`);
const kOf = (rows, c) => rows.find((r) => r.currency === c);
ok(
  kOf(kpi0, "USD")?.tacos_unknown === true && kOf(kpi0, "USD")?.tacos7 === null,
  `0020 KPI: chưa đồng bộ doanh thu tổng → TACOS NULL + cờ tacos_unknown (KHÔNG bịa 0%) — ${JSON.stringify(kOf(kpi0, "USD"))}`,
);
ok(
  Number(kOf(kpi0, "USD")?.spend_yesterday) === 17 && Number(kOf(kpi0, "USD")?.spend7) === 107
    && Number(kOf(kpi0, "USD")?.ad_sales7) === 1940 && Number(kOf(kpi0, "USD")?.acos7) === 5.52
    && Number(kOf(kpi0, "USD")?.roas7) === 18.13 && Number(kOf(kpi0, "USD")?.campaigns_enabled) === 2
    && Number(kOf(kpi0, "USD")?.campaigns_exhausted) === 1
    && Number(kOf(kpi0, "USD")?.budget_daily_total) === 65,
  `0020 KPI USD: spend hôm qua 17 · 7 ngày 107 · sales ads 1940 · ACOS 5.52% · ROAS 18.13 — ${JSON.stringify(kOf(kpi0, "USD"))}`,
);
ok(
  Number(kOf(kpi0, "CAD")?.spend7) === 8 && Number(kOf(kpi0, "CAD")?.acos7) === 20
    && kOf(kpi0, "CAD")?.is_stale === false,
  `0020 KPI CAD: tách riêng (spend 8 · ACOS 20%) — ${JSON.stringify(kOf(kpi0, "CAD"))}`,
);
await ex(`insert into sales.order_daily(seller_account_id,day,orders_count,units,sales_amount,currency)
   select '${cShop}', d, 6, 8, 142.86, 'USD'
   from generate_series(date '2026-09-05', date '2026-09-11', interval '1 day') d
   on conflict (seller_account_id, day) do update
     set sales_amount = excluded.sales_amount, orders_count = excluded.orders_count`);
const kpi1 = await one(`select total_sales7, tacos7, tacos_unknown from public.vexim_ads_kpis
   where seller_account_id='${cShop}' and currency='USD'`);
ok(
  Number(kpi1?.total_sales7) === 1000.02 && Number(kpi1?.tacos7) === 10.7 && kpi1?.tacos_unknown === false,
  `0020 TACOS: có doanh thu tổng 1000.02 USD → TACOS = 107/1000.02 = 10.7% (đúng định nghĩa TACOS) — ${JSON.stringify(kpi1)}`,
);

// ---- 17. RLS: user được gán shop đọc được, người lạ 0 dòng, token KHÔNG đọc được
await ex("reset role;");
await ex(`select set_config('request.jwt.claim.sub','${oUser}',false);`);
await ex("set role authenticated;");
await cmp(
  "0020 RLS: user vận hành Ads thấy KPI của shop mình",
  `select count(*) n from public.vexim_ads_kpis where seller_account_id='${cShop}'`,
  2,
);
await cmp(
  "0020 RLS: user vận hành Ads thấy campaign + search term + targeting",
  `select (select count(*) from public.vexim_ads_campaigns where seller_account_id='${cShop}')
        + (select count(*) from public.vexim_ads_search_terms where seller_account_id='${cShop}')
        + (select count(*) from public.vexim_ads_targeting where seller_account_id='${cShop}') n`,
  8,
);
const conn = await rows19(`select service, connected, token_status, token_source, days_to_reauth,
     reauth_state, needs_connect from public.vexim_connections
     where seller_account_id='${cShop}' order by service`);
ok(
  conn.length === 2 && conn.every((r) => !("encrypted_refresh_token" in r))
    && conn.find((r) => r.service === "ads")?.connected === true
    && conn.find((r) => r.service === "ads")?.token_status === "expired"
    && conn.find((r) => r.service === "ads")?.reauth_state === "expired"
    && conn.find((r) => r.service === "spapi")?.reauth_state === "ok",
  `0020 RLS: view kết nối trả 2 service + trạng thái re-auth, KHÔNG lộ cột token — ${JSON.stringify(conn)}`,
);
await cmp(
  "0020 RLS: authenticated thấy 0 token (bảng KHÔNG có policy SELECT cho client)",
  `select count(*) n from connections.oauth_tokens`,
  0,
);
await cmp(
  "0020 RLS: authenticated thấy 0 oauth_states",
  `select count(*) n from connections.oauth_states`,
  0,
);
ok(
  await mustBlock(`insert into connections.oauth_tokens(seller_account_id,service,encrypted_refresh_token,expires_at)
     values ('${cShop}','spapi','enc:v1:x', now() + interval '365 days')`),
  "0020 CHẶN: authenticated không ghi được oauth_tokens",
);
ok(
  await mustBlock(`select * from public.vexim_oauth_upsert_token('{}'::jsonb)`),
  "0020 CHẶN: RPC lưu token chỉ dành cho service_role",
);
ok(
  await mustBlock(`select * from public.vexim_worker_upsert_ads_metrics('${cShop}','[]'::jsonb)`),
  "0020 CHẶN: RPC nhập metrics Ads chỉ dành cho service_role",
);
ok(
  await mustBlock(`select * from public.vexim_ads_raise_alerts('${cShop}',null)`),
  "0020 CHẶN: RPC nổ alert PPC chỉ dành cho service_role",
);
ok(
  await mustBlock(`select * from public.vexim_worker_fill_profit_ads_spend('${cShop}',null,null)`),
  "0020 CHẶN: RPC lấp ads_spend vào F4 chỉ dành cho service_role",
);
ok(
  await mustBlock(`insert into ads.ad_metrics_daily(seller_account_id,day,campaign_id)
     values ('${cShop}','2026-09-11','C1')`),
  "0020 CHẶN: authenticated không ghi thẳng bảng metrics Ads",
);

await ex("reset role;");
await ex(`select set_config('request.jwt.claim.sub','${oStranger}',false);`);
await ex("set role authenticated;");
await cmp(
  "0020 RLS: người lạ không thấy KPI PPC của shop",
  `select count(*) n from public.vexim_ads_kpis where seller_account_id='${cShop}'`,
  0,
);
await cmp(
  "0020 RLS: người lạ không thấy campaign / search term / trạng thái report Ads",
  `select (select count(*) from public.vexim_ads_campaigns where seller_account_id='${cShop}')
        + (select count(*) from public.vexim_ads_search_terms where seller_account_id='${cShop}')
        + (select count(*) from public.vexim_ads_report_requests where seller_account_id='${cShop}') n`,
  0,
);
await cmp(
  "0020 RLS: người lạ không thấy kết nối OAuth của shop",
  `select count(*) n from public.vexim_connections where seller_account_id='${cShop}'`,
  0,
);
await ex("rollback;");
await ex("reset role;");

// ---- 17b. HỢP ĐỒNG CỘT web ↔ DB (Module 5): mọi cột trong select của web phải tồn tại ----
{
  const webSelects = {
    vexim_ads_kpis: ADS_KPI_SELECT,
    vexim_ads_campaigns: ADS_CAMPAIGN_SELECT,
    vexim_ads_campaign_daily: ADS_DAILY_SELECT,
    vexim_ads_search_terms: ADS_SEARCH_TERM_SELECT,
    vexim_ads_budget_usage: ADS_BUDGET_SELECT,
    vexim_ads_report_requests: ADS_REPORT_REQUEST_SELECT,
    vexim_ads_profiles: ADS_PROFILE_SELECT,
  };
  for (const [view, select] of Object.entries(webSelects)) {
    const wanted = select.split(",").map((c) => c.trim()).filter(Boolean);
    const have = new Set((await colsOf(view)).split(","));
    const missing = wanted.filter((c) => !have.has(c));
    ok(
      missing.length === 0,
      `0020: ${view} đủ ${wanted.length} cột mà web select` +
        (missing.length > 0 ? ` — THIẾU: ${missing.join(", ")}` : ""),
    );
  }
  // Cột mà reader web dùng để ORDER BY / lọc (ads.ts) — cũng phải tồn tại, vì
  // PostgREST trả 400 cho order trên cột không có, và lỗi này chỉ nổ lúc chạy thật.
  const webOrderFilters = {
    vexim_ads_kpis: ["currency", "spend7"],
    vexim_ads_campaigns: ["spend7", "campaign_name", "seller_account_id"],
    vexim_ads_campaign_daily: ["day", "seller_account_id"],
    vexim_ads_search_terms: ["spend", "seller_account_id", "wasted_spend_signal"],
    vexim_ads_budget_usage: ["percentage_used", "seller_account_id"],
    vexim_ads_report_requests: ["requested_at", "seller_account_id"],
    vexim_ads_profiles: ["shop", "is_default", "seller_account_id"],
  };
  for (const [view, wanted] of Object.entries(webOrderFilters)) {
    const have = new Set((await colsOf(view)).split(","));
    const missing = wanted.filter((c) => !have.has(c));
    ok(
      missing.length === 0,
      `0020: ${view} có đủ cột web dùng để sắp xếp/lọc` +
        (missing.length > 0 ? ` — THIẾU: ${missing.join(", ")}` : ""),
    );
  }

  // Ngược lại: cột mới thêm vào view mà web KHÔNG đọc → không fail, chỉ nhắc
  // (để biết UI đang bỏ sót thông tin Amazon đã trả).
  const kpiCols = (await colsOf("vexim_ads_kpis")).split(",");
  const kpiRead = new Set(ADS_KPI_SELECT.split(",").map((c) => c.trim()));
  const kpiUnused = kpiCols.filter((c) => !kpiRead.has(c));
  ok(
    kpiUnused.length <= 1,
    `0020: vexim_ads_kpis gần như được web đọc hết (bỏ qua: ${kpiUnused.join(", ") || "không"})`,
  );
}

// ---- 18. idempotent ----------------------------------------------------------
ok(
  await ex(rd("migrations/0020_module0_oauth_module5_ppc_read.sql"), "0020 lần 2"),
  "0020 idempotent (chạy lại không lỗi, không đổi hợp đồng)",
);
ok(
  (await colsOf("vexim_ads_kpis")).endsWith("hours_since_import,is_stale"),
  "0020 lần 2: hợp đồng cột view KPI giữ nguyên",
);
await cmp(
  "0020 lần 2: index unique không bị tạo trùng",
  `select count(*) n from pg_indexes where indexname in
     ('uq_oauth_tokens_shop_service','uq_search_terms_key','uq_budget_usage_hour',
      'uq_ads_report_requests_key','uq_alerts_open_entity')`,
  5,
);
await cmp(
  "0020 lần 2: alert rule re-auth vẫn đúng ngưỡng (30 ngày nhắc, 365 ngày hạn)",
  `select count(*) n from ops.alert_rules
     where rule_code='reauth_required' and threshold=30 and is_active`,
  1,
);
}


// ===========================================================================
{
console.log("\n=== BƯỚC 22: 0021 — Module 5 Phần 2&3: PPC chiều GHI (hàng đợi duyệt · guardrail · audit) ===");
// ===========================================================================
ok(
  await ex(rd("migrations/0021_module5_ppc_write.sql"), "0021_module5_ppc_write.sql"),
  "0021 chạy sạch (DO-block tự soát: RLS · policy · view · RPC · trigger · alert rule · hợp đồng cột)",
);

const rows = async (sql) => {
  try { return (await db.query(sql)).rows; } catch (e) { return [{ error: e.message.split("\n")[0] }]; }
};
/** gọi RPC trả jsonb: select fn(…) as r → object (PGlite có thể trả string) */
const rpc = async (fn, arg) => {
  const r = await one(`select public.${fn}(${arg}) as r`);
  if (r && r.error) return { error: r.error };
  const v = r ? r.r : null;
  if (v === null || v === undefined) return {};
  return typeof v === "string" ? JSON.parse(v) : v;
};
/**
 * Gọi RPC MONG ĐỢI THẤT BẠI mà không phá transaction đang test.
 * Vì sao không dùng rpc(): một exception trong transaction làm PG abort cả txn;
 * helper ex() thấy lỗi sẽ `rollback` → mất fixture. Ở đây bọc savepoint rồi
 * rollback đúng về savepoint đó, và vẫn đọc được thông báo lỗi để assert.
 */
const rpcFail = async (fn, arg) => {
  await db.exec("savepoint sp_expect_fail");
  const r = await one(`select public.${fn}(${arg}) as r`);
  await db.exec("rollback to savepoint sp_expect_fail");
  return { error: r && r.error ? r.error : null, value: r ? r.r : null };
};

const asUser = async (uid) => {
  await ex("reset role;");
  await ex(`select set_config('request.jwt.claim.sub','${uid ?? ""}',false);`);
  await ex("set role authenticated;");
};
const asWorker = async () => {
  await ex("reset role;");
  await ex("select set_config('request.jwt.claim.sub','',false);");
  await ex("set role service_role;");
};

// ---- 1. Hợp đồng cột của 4 view mới (web đọc bằng select cố định) -------------
ok(
  (await colsOf("vexim_ppc_policies")) ===
    "seller_account_id,shop,marketplace,shop_status,has_policy_row,auto_apply,require_approval_state," +
    "max_bid_change_pct,max_budget_change_pct,bid_floor,bid_ceiling,budget_floor,budget_ceiling," +
    "daily_change_cap,max_open_requests,proposal_ttl_hours,suggestion_min_clicks,suggestion_min_spend," +
    "suggestion_acos_lower_pct,bid_step_pct,currency,notes,policy_updated_at,proposed_count," +
    "approved_count,applying_count,applied_today,failed_24h,open_count,cap_left_today,can_edit_policy",
  "0021: vexim_ppc_policies đúng hợp đồng cột (guardrail hiệu lực + trạng thái hàng đợi)",
);
ok(
  (await colsOf("vexim_ppc_change_requests")) ===
    "id,seller_account_id,shop,ads_profile_id,entity_type,change_type,amazon_entity_id,campaign_id," +
    "campaign_name,campaign_type,ad_group_id,label,match_type,currency,before_value,after_value," +
    "before_number,after_number,delta_pct,delta_label,summary,entity_label,requires_approval,reason," +
    "source,suggestion_key,status,status_label,is_open,is_terminal,batch_id,proposed_by," +
    "proposed_by_name,proposed_at,age_hours,decided_by,decided_by_name,decided_at,decision_note," +
    "expires_at,expires_in_hours,expired,attempts,applied_at,last_error,amazon_response,created_at," +
    "updated_at,can_decide,is_mine",
  "0021: vexim_ppc_change_requests đúng hợp đồng cột (summary/status_label/can_decide cho UI)",
);
ok(
  (await colsOf("vexim_ppc_suggestions")) ===
    "seller_account_id,shop,kind,priority,suggestion_key,entity_type,change_type,campaign_id," +
    "campaign_name,ad_group_id,ad_group_name,amazon_entity_id,label,match_type,keyword_type," +
    "currency,before_value,after_value,current_number,proposed_number,delta_pct,impressions7," +
    "clicks7,spend7,sales7,ad_orders7,acos7,acos_target,waste7,days_with_data,window_end,reason," +
    "requires_approval,has_open_request,kind_label,can_decide,can_propose",
  "0021: vexim_ppc_suggestions đúng hợp đồng cột (gợi ý trả sẵn before/after/reason)",
);
ok(
  (await colsOf("vexim_ads_negative_keywords")) ===
    "id,seller_account_id,shop,ads_profile_id,campaign_id,campaign_name,ad_group_id,ad_group_name," +
    "level,keyword_text,keyword_norm,match_type,match_label,amazon_negative_id,state,source," +
    "change_request_id,request_status,created_at,last_synced_at,updated_at",
  "0021: vexim_ads_negative_keywords đúng hợp đồng cột",
);

// ---- 2. Chốt an toàn về quyền ----------------------------------------------
await cmp(
  "0021: 3 bảng mới bật RLS",
  `select count(*) n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
    where (ns.nspname,c.relname) in (('ads','ppc_policies'),('ads','change_requests'),
                                     ('ads','negative_keywords')) and c.relrowsecurity`,
  3,
);
await cmp(
  "0021: KHÔNG có policy ghi nào cho client trên bảng PPC chiều ghi (mọi đường ghi qua RPC)",
  `select count(*) n from pg_policies where schemaname='ads'
     and tablename in ('ppc_policies','change_requests','negative_keywords') and cmd <> 'SELECT'`,
  0,
);
await cmp(
  "0021: 2 trigger trên hàng đợi (guard máy trạng thái + audit)",
  `select count(*) n from pg_trigger t join pg_class c on c.oid=t.tgrelid
    where c.relname='change_requests' and not t.tgisinternal
      and t.tgname in ('trg_change_request_guard','trg_change_request_audit')`,
  2,
);
await cmp(
  "0021: khoá chống đề xuất trùng là unique index CÓ ĐIỀU KIỆN (chỉ chặn đề xuất đang mở)",
  `select count(*) n from pg_indexes where schemaname='ads'
     and indexname='uq_change_requests_open' and indexdef like '%UNIQUE%' and indexdef like '%WHERE%'`,
  1,
);
await cmp(
  "0021: khoá khử trùng negative keyword (1 từ / campaign / ad group / match type)",
  `select count(*) n from pg_indexes where schemaname='ads'
     and indexname='uq_negative_keywords_key' and indexdef like '%UNIQUE%' and indexdef like '%lower%'`,
  1,
);
await cmp(
  "0021: 4 RPC người dùng = security definer, authenticated gọi được, anon thì KHÔNG",
  `select count(*) n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname='public' and p.proname in
      ('vexim_ppc_propose_changes','vexim_ppc_decide_change','vexim_ppc_decide_bulk',
       'vexim_ppc_set_policy')
      and p.prosecdef
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and not has_function_privilege('anon', p.oid, 'EXECUTE')`,
  4,
);
await cmp(
  "0021: 3 RPC worker CHỈ service_role (client không gọi được)",
  `select count(*) n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname='public' and p.proname in
      ('vexim_worker_ppc_pending_changes','vexim_worker_ppc_set_result','vexim_ppc_raise_alerts')
      and p.prosecdef
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')`,
  3,
);
await cmp(
  "0021: 2 alert rule mới đã seed đúng ngưỡng (chờ duyệt 24 giờ · thất bại ≥ 1 lần)",
  `select count(*) n from ops.alert_rules where is_active
     and ((rule_code='ppc_pending_approval' and threshold=24 and severity='amber')
       or (rule_code='ppc_change_failed' and threshold=1 and severity='red'))`,
  2,
);

// ---- 3. Policy mặc định (shop CHƯA có dòng policy vẫn được bảo vệ) ------------
{
  const d = await one(`select (ads.ppc_policy(null::uuid)) as p`);
  const p = typeof d.p === "string" ? JSON.parse(d.p) : d.p;
  ok(
    p.has_row === false && p.auto_apply === false && p.require_approval_state === true
      && Number(p.max_bid_change_pct) === 20 && Number(p.max_budget_change_pct) === 30
      && Number(p.daily_change_cap) === 50 && Number(p.proposal_ttl_hours) === 72
      && Number(p.suggestion_min_clicks) === 3 && Number(p.suggestion_acos_lower_pct) === 50
      && Number(p.bid_step_pct) === 15 && p.currency === "USD",
    `0021: shop chưa có policy → mặc định AN TOÀN (auto_apply=false, bid ±20%, budget ±30%, 50 thay đổi/ngày, TTL 72h) — ${JSON.stringify(p)}`,
  );
}

// ---- 4. Fixture: user + dữ liệu Ads (campaign/keyword/search term/budget) -----
await ex("begin");
await ex("reset role;");
const wShop = (await one("select id, org_id from connections.seller_accounts order by seller_id limit 1")).id;
const wProposer = "d2100000-0000-4000-8000-000000000001";
const wApprover = "d2100000-0000-4000-8000-000000000002";
const wStranger = "d2100000-0000-4000-8000-000000000003";
const wReadOnly = "d2100000-0000-4000-8000-000000000004";
ok(
  await ex(`insert into auth.users(id,email) values
     ('${wProposer}','local-w-ppc@example.test'),
     ('${wApprover}','local-w-lead@example.test'),
     ('${wStranger}','local-w-stranger@example.test'),
     ('${wReadOnly}','local-w-readonly@example.test')
     on conflict (id) do nothing;
   insert into iam.user_profiles(id,display_name,email,vexim_employee) values
     ('${wProposer}','Nhân viên PPC','local-w-ppc@example.test',true),
     ('${wApprover}','Trưởng phòng PPC','local-w-lead@example.test',true),
     ('${wStranger}','Người lạ','local-w-stranger@example.test',true),
     ('${wReadOnly}','Chỉ xem','local-w-readonly@example.test',true)
     on conflict (id) do nothing;
   insert into iam.assignments(user_id,seller_account_id,module,can_write) values
     ('${wProposer}','${wShop}','ads',true),
     ('${wApprover}','${wShop}','ads',true),
     ('${wReadOnly}','${wShop}','ads',false)
     on conflict (user_id,seller_account_id,module) do update set can_write=excluded.can_write;
   insert into iam.role_assignments(user_id,role) values ('${wProposer}','operator')
     on conflict do nothing;
   insert into iam.role_assignments(user_id,role,department_id)
     values ('${wApprover}','dept_lead',(select id from iam.departments where code='ppc'))
     on conflict do nothing;
   delete from ads.change_requests          where seller_account_id='${wShop}';
   delete from ads.negative_keywords        where seller_account_id='${wShop}';
   delete from ads.ppc_policies             where seller_account_id='${wShop}';
   delete from ads.targeting_metrics_daily  where seller_account_id='${wShop}';
   delete from ads.search_terms             where seller_account_id='${wShop}';
   delete from ads.budget_usage             where seller_account_id='${wShop}';
   delete from ads.ad_metrics_daily         where seller_account_id='${wShop}';
   delete from ads.campaigns                where seller_account_id='${wShop}';
   delete from ads.ad_profiles              where seller_account_id='${wShop}';
   delete from iam.audit_logs               where seller_account_id='${wShop}' and module='ads';
   delete from ops.alerts                   where seller_account_id='${wShop}'`),
  "0021 fixture: người đề xuất (can_write) · trưởng phòng PPC (dept_lead) · người lạ · người chỉ xem + dọn dữ liệu cũ",
);
ok(
  (await one(`select iam.is_ppc_approver() as a from (select 1) x`)) !== undefined,
  "0021: iam.is_ppc_approver() gọi được (superuser = true)",
);
await ex("reset role;");
await asWorker();

// profiles + campaigns (v3: budget NESTED)
await one(`select * from public.vexim_worker_upsert_ads_profiles('${wShop}', '[
  {"profileId":"1234567890","countryCode":"US","currencyCode":"USD","timezone":"America/Los_Angeles",
   "accountInfo":{"id":"A2XYZUSDEMO","type":"seller","name":"VEXIM Demo US"},"isDefault":true}]'::jsonb)`);
await one(`select * from public.vexim_worker_upsert_ads_campaigns('${wShop}', '[
  {"campaignId":"W1","name":"SP - Mat ong 500ml","state":"ENABLED","costType":"CPC","targetingType":"MANUAL",
   "startDate":"20260801","adsProfileId":"1234567890","budget":{"budget":25,"currencyCode":"USD","budgetType":"DAILY"}},
  {"campaignId":"W2","name":"SP - ROAS tot","state":"ENABLED","costType":"CPC","targetingType":"AUTO",
   "adsProfileId":"1234567890","budget":{"budget":40,"currencyCode":"USD","budgetType":"DAILY"}},
  {"campaignId":"W3","name":"SP - dang tat","state":"PAUSED","adsProfileId":"1234567890",
   "budget":{"budget":20,"currencyCode":"USD","budgetType":"DAILY"}},
  {"campaignId":"W5","name":"SP - dot tien","state":"ENABLED","adsProfileId":"1234567890",
   "budget":{"budget":20,"currencyCode":"USD","budgetType":"DAILY"}}]'::jsonb)`);
// campaign Sponsored Brands: chiều ghi CHƯA mở → worker phải tự skip
await ex(`insert into ads.campaigns(seller_account_id,ads_profile_id,campaign_id,campaign_type,name,state,daily_budget,budget_currency)
   values ('${wShop}','1234567890','W9','sb','SB - Video','ENABLED',30,'USD')
   on conflict (seller_account_id,campaign_id) do update set campaign_type='sb'`);

// metrics 7 ngày
const WD = ["2026-09-05","2026-09-06","2026-09-07","2026-09-08","2026-09-09","2026-09-10","2026-09-11"];
const wMetrics = [
  ...WD.map((d) => ({ date: d, campaignId: "W1", campaignName: "SP - Mat ong 500ml", impressions: 1000,
    clicks: 10, cost: 10, sales7d: 200, purchases7d: 20, currencyCode: "USD", campaignStatus: "enabled" })),
  ...WD.map((d) => ({ date: d, campaignId: "W2", campaignName: "SP - ROAS tot", impressions: 2000,
    clicks: 20, cost: 5, sales7d: 70, purchases7d: 5, currencyCode: "USD" })),
  ...WD.map((d) => ({ date: d, campaignId: "W5", campaignName: "SP - dot tien", impressions: 500,
    clicks: 8, cost: 12, sales7d: 0, purchases7d: 0, currencyCode: "USD" })),
];
await one(`select * from public.vexim_worker_upsert_ads_metrics('${wShop}', '${JSON.stringify(wMetrics)}'::jsonb)`);
// budget usage: W1 CẠN (100%) mà ACOS thấp → gợi ý tăng ngân sách
await one(`select * from public.vexim_worker_upsert_ads_budget_usage('${wShop}', '[
  {"date":"2026-09-11","campaignId":"W1","budget":25,"spend":25,"percentageUsed":100,"currency":"USD",
   "capturedAt":"2026-09-11T14:05:00Z","adsProfileId":"1234567890"},
  {"date":"2026-09-11","campaignId":"W2","budget":40,"spend":5,"percentageUsed":12.5,"currency":"USD",
   "capturedAt":"2026-09-11T14:05:00Z"}]'::jsonb)`);
// search terms: 1 term đốt tiền, 1 term tốt, 1 term TRÙNG keyword, "*", 1 term ít click
await one(`select * from public.vexim_worker_upsert_ads_search_terms('${wShop}', '[
  {"date":"2026-09-11","searchTerm":"free sample","campaignId":"W1","adGroupId":"AG1","keywordId":"K1",
   "keywordText":"mat ong","matchType":"BROAD","impressions":80,"clicks":5,"cost":7.5,"sales7d":0,
   "purchases7d":0,"currencyCode":"USD","campaignName":"SP - Mat ong 500ml","adGroupName":"Ad group 1"},
  {"date":"2026-09-11","searchTerm":"mat ong 500ml","campaignId":"W1","adGroupId":"AG1","keywordId":"K1",
   "keywordText":"mat ong","matchType":"BROAD","impressions":100,"clicks":6,"cost":6,"sales7d":60,
   "purchases7d":3,"currencyCode":"USD"},
  {"date":"2026-09-11","searchTerm":"mat ong","campaignId":"W1","adGroupId":"AG1","keywordId":"K1",
   "keywordText":"mat ong","matchType":"BROAD","impressions":90,"clicks":5,"cost":5,"sales7d":0,
   "purchases7d":0,"currencyCode":"USD"},
  {"date":"2026-09-11","searchTerm":"*","campaignId":"W1","adGroupId":"AG1","impressions":30,"clicks":1,
   "cost":1,"sales7d":10,"purchases7d":1,"currencyCode":"USD"},
  {"date":"2026-09-11","searchTerm":"re qua","campaignId":"W1","adGroupId":"AG1","keywordId":"K1",
   "impressions":20,"clicks":2,"cost":2,"sales7d":0,"purchases7d":0,"currencyCode":"USD"},
  {"date":"2026-09-11","searchTerm":"gift set","campaignId":"W1","adGroupId":"AG1","keywordId":"K1",
   "impressions":60,"clicks":4,"cost":4,"sales7d":0,"purchases7d":0,"currencyCode":"USD"}]'::jsonb)`);
// targeting: K1 ổn · K2 ACOS cao (hạ bid) · K3 nhiều click 0 đơn (tắt) · K4 ít click · 1 target ASIN
await one(`select * from public.vexim_worker_upsert_ads_targeting('${wShop}', '[
  {"date":"2026-09-11","campaignId":"W1","adGroupId":"AG1","adGroupName":"Ad group 1","keywordId":"K1",
   "keywordText":"mat ong","matchType":"BROAD","keywordType":"BROAD","impressions":100,"clicks":4,
   "cost":4,"sales7d":40,"purchases7d":2,"keywordBid":1.0,"currencyCode":"USD","adsProfileId":"1234567890"},
  {"date":"2026-09-11","campaignId":"W1","adGroupId":"AG1","keywordId":"K2","keywordText":"sua rua mat",
   "matchType":"BROAD","keywordType":"BROAD","impressions":300,"clicks":5,"cost":25,"sales7d":30,
   "purchases7d":1,"keywordBid":2.0,"currencyCode":"USD","adsProfileId":"1234567890"},
  {"date":"2026-09-11","campaignId":"W1","adGroupId":"AG1","keywordId":"K3","keywordText":"dau goi free",
   "matchType":"PHRASE","keywordType":"PHRASE","impressions":400,"clicks":8,"cost":12,"sales7d":0,
   "purchases7d":0,"keywordBid":1.5,"currencyCode":"USD","adsProfileId":"1234567890"},
  {"date":"2026-09-11","campaignId":"W1","adGroupId":"AG1","keywordId":"K4","keywordText":"it click",
   "matchType":"EXACT","keywordType":"EXACT","impressions":50,"clicks":1,"cost":1,"sales7d":0,
   "purchases7d":0,"keywordBid":1.0,"currencyCode":"USD"},
  {"date":"2026-09-11","campaignId":"W1","adGroupId":"AG1","targetingExpression":"b0demoasin9",
   "keywordType":"TARGETING_EXPRESSION_PREDEFINED","impressions":50,"clicks":2,"cost":2,"sales7d":0,
   "purchases7d":0,"currencyCode":"USD"}]'::jsonb)`);
// "gift set" ĐÃ được phủ định từ trước (do đồng bộ Amazon về) → gợi ý không được lặp lại
await ex(`insert into ads.negative_keywords(seller_account_id,ads_profile_id,campaign_id,ad_group_id,
     keyword_text,match_type,level,amazon_negative_id,source)
   values ('${wShop}','1234567890','W1','AG1','gift set','NEGATIVE_EXACT','ad_group','nk-999','api')`);

// ---- 5. VIEW GỢI Ý — sinh từ số liệu, không ghi gì ---------------------------
await asUser(wProposer);
const sug = await rows(`select kind, priority, suggestion_key, entity_type, change_type, campaign_id,
     ad_group_id, amazon_entity_id, label, match_type, currency, before_value, after_value,
     current_number, proposed_number, delta_pct, clicks7, spend7, sales7, acos7, acos_target, waste7,
     reason, requires_approval, has_open_request, kind_label, can_propose, can_decide
   from public.vexim_ppc_suggestions where seller_account_id='${wShop}' order by priority, spend7 desc`);
ok(sug.length === 5, `0021 gợi ý: đúng 5 gợi ý từ fixture (nhận ${sug.length}) — ${JSON.stringify(sug.map((s) => s.kind))}`);
const sg = (k) => sug.find((s) => s.kind === k);
ok(
  sg("negative_keyword")?.label === "free sample"
    && sg("negative_keyword")?.entity_type === "negative_keyword"
    && sg("negative_keyword")?.change_type === "create"
    && sg("negative_keyword")?.match_type === "NEGATIVE_EXACT"
    && sg("negative_keyword")?.after_value?.keyword_text === "free sample"
    && sg("negative_keyword")?.after_value?.level === "ad_group"
    && Number(sg("negative_keyword")?.waste7) === 7.5
    && Number(sg("negative_keyword")?.clicks7) === 5
    && sg("negative_keyword")?.requires_approval === true,
  `0021 gợi ý negative: "free sample" 5 click · 7.5$ · 0 đơn → phủ định NEGATIVE_EXACT cấp ad group, cần duyệt — ${JSON.stringify(sg("negative_keyword"))}`,
);
ok(
  String(sg("negative_keyword")?.reason).includes("KHÔNG có đơn")
    && String(sg("negative_keyword")?.reason).includes("mat ong"),
  `0021 gợi ý negative: reason nói rõ vì sao + keyword nào đã khớp ("${sg("negative_keyword")?.reason}")`,
);
ok(
  !sug.some((s) => s.kind === "negative_keyword" && ["mat ong", "*", "re qua", "gift set"].includes(s.label)),
  "0021 gợi ý negative: LOẠI term trùng keyword đang chạy, term \"*\", term dưới ngưỡng click, và term ĐÃ phủ định",
);
ok(
  sg("lower_bid")?.amazon_entity_id === "K2" && Number(sg("lower_bid")?.current_number) === 2
    && Number(sg("lower_bid")?.proposed_number) === 1.7 && Number(sg("lower_bid")?.delta_pct) === -15
    && Number(sg("lower_bid")?.before_value?.bid) === 2
    && sg("lower_bid")?.after_value?.bid === 1.7
    && Number(sg("lower_bid")?.acos7) === 83.33,
  `0021 gợi ý hạ bid: K2 ACOS 83.33% > 50% → bid 2.00 → 1.70 (-15% = bước của policy) — ${JSON.stringify(sg("lower_bid"))}`,
);
ok(
  sg("pause_keyword")?.amazon_entity_id === "K3"
    && sg("pause_keyword")?.after_value?.state === "PAUSED"
    && sg("pause_keyword")?.change_type === "state"
    && Number(sg("pause_keyword")?.clicks7) === 8,
  `0021 gợi ý tắt keyword: K3 8 click · 0 đơn → state PAUSED — ${JSON.stringify(sg("pause_keyword"))}`,
);
ok(
  sg("pause_campaign")?.campaign_id === "W5" && sg("pause_campaign")?.after_value?.state === "PAUSED"
    && Number(sg("pause_campaign")?.spend7) === 84,
  `0021 gợi ý tắt campaign: W5 spend 84$ · 0 đơn (7 ngày) → PAUSED — ${JSON.stringify(sg("pause_campaign"))}`,
);
ok(
  sg("raise_budget")?.campaign_id === "W1" && Number(sg("raise_budget")?.current_number) === 25
    && Number(sg("raise_budget")?.proposed_number) === 28.75
    && Number(sg("raise_budget")?.delta_pct) === 15
    && sg("raise_budget")?.before_value?.budget === 25
    && sg("raise_budget")?.after_value?.budget === 28.75,
  `0021 gợi ý tăng ngân sách: W1 CẠN budget (100%) mà ACOS 5% ≤ mục tiêu 25% → 25 → 28.75 (+15% = nửa trần policy) — ${JSON.stringify(sg("raise_budget"))}`,
);
ok(
  !sug.some((s) => s.campaign_id === "W2" && s.kind === "raise_budget")
    && !sug.some((s) => s.campaign_id === "W3")
    && !sug.some((s) => s.campaign_id === "W9"),
  "0021 gợi ý: KHÔNG tăng ngân sách cho campaign chưa cạn (W2) · bỏ qua campaign đang TẮT (W3) · bỏ qua Sponsored Brands (W9)",
);
ok(
  sug.every((s) => s.can_propose === true) && sug.every((s) => s.can_decide === false)
    && sug.every((s) => s.has_open_request === false),
  "0021 gợi ý: nhân viên PPC thấy can_propose=true nhưng can_decide=false (không tự duyệt được)",
);
ok(
  new Set(sug.map((s) => s.currency)).size === 1 && sg("negative_keyword").currency === "USD"
    && ["nk|W1|AG1|free sample", "bid|K2", "pause|K3", "pausecamp|W5", "budget|W1"]
      .every((k) => sug.some((s) => s.suggestion_key === k)),
  `0021 gợi ý: suggestion_key ổn định để chống đề xuất trùng — ${JSON.stringify(sug.map((s) => s.suggestion_key))}`,
);

// ---- 6. RPC ĐỀ XUẤT — phân quyền + validate ngưỡng ---------------------------
await asUser(wStranger);
const badItem = `jsonb_build_object('seller_account_id','${wShop}','items',
   jsonb_build_array(jsonb_build_object('entity_type','campaign','change_type','state',
     'amazon_entity_id','W1','campaign_id','W1','after_value',jsonb_build_object('state','PAUSED'))))`;
ok(
  String((await rpcFail("vexim_ppc_propose_changes", badItem)).error).includes("quyền") === true,
  "0021 CHẶN: người lạ không đề xuất được thay đổi PPC",
);
await asUser(wReadOnly);
ok(
  String((await rpcFail("vexim_ppc_propose_changes", badItem)).error).includes("quyền ghi") === true,
  "0021 CHẶN: người CHỈ XEM (assignment can_write=false) không đề xuất được",
);

await asUser(wProposer);
// (a) gửi thẳng 2 gợi ý từ view (đúng luồng UI: chọn gợi ý → tạo đề xuất)
const sgNk = sg("negative_keyword");
const sgBid = sg("lower_bid");
const itemOf = (s) => ({
  entity_type: s.entity_type, change_type: s.change_type, amazon_entity_id: s.amazon_entity_id,
  campaign_id: s.campaign_id, ad_group_id: s.ad_group_id ?? "", label: s.label,
  match_type: s.match_type ?? null, currency: s.currency, before_value: s.before_value ?? null,
  after_value: s.after_value, reason: s.reason, suggestion_key: s.suggestion_key,
});
const pr1 = await rpc("vexim_ppc_propose_changes", `'${JSON.stringify({
  seller_account_id: wShop, ads_profile_id: "1234567890", source: "suggestion",
  reason: "Dọn từ khoá đốt tiền và hạ bid keyword lỗ",
  items: [itemOf(sgNk), itemOf(sgBid)],
}).replace(/'/g, "''")}'::jsonb`);
ok(
  Number(pr1.inserted) === 2 && Number(pr1.duplicates) === 0 && Number(pr1.blocked) === 0
    && Array.isArray(pr1.ids) && pr1.ids.length === 2 && pr1.auto_applied === false,
  `0021 đề xuất: gửi 2 gợi ý → 2 đề xuất chờ duyệt (auto_apply=false) — ${JSON.stringify(pr1).slice(0, 300)}`,
);
const idNk = pr1.ids[0];
const idBid = pr1.ids[1];
ok(
  pr1.policy?.max_bid_change_pct === 20 && Number(pr1.policy?.daily_change_cap) === 50
    && pr1.expires_at,
  `0021 đề xuất: trả kèm policy hiệu lực + hạn duyệt (TTL 72h) để UI hiện countdown — ${pr1.expires_at}`,
);
await cmp(
  "0021 đề xuất: delta_pct tự tính từ before/after (K2: 2.00 → 1.70 = -15%)",
  `select count(*) n from ads.change_requests where id='${idBid}'
     and delta_pct = -15 and requires_approval = true and status='proposed'
     and (before_value->>'bid')::numeric = 2 and (after_value->>'bid')::numeric = 1.7`,
  1,
);
await cmp(
  "0021 đề xuất: negative keyword được chuẩn hoá match_type + level + đủ khoá",
  `select count(*) n from ads.change_requests where id='${idNk}'
     and entity_type='negative_keyword' and change_type='create' and match_type='NEGATIVE_EXACT'
     and campaign_id='W1' and ad_group_id='AG1' and amazon_entity_id=''
     and after_value->>'keyword_text'='free sample' and source='suggestion'
     and suggestion_key='nk|W1|AG1|free sample'`,
  1,
);
await cmp(
  "0021 audit: tạo đề xuất ghi iam.audit_logs (module=ads, action=ppc.propose, có after_value)",
  `select count(*) n from iam.audit_logs where seller_account_id='${wShop}' and module='ads'
     and action='ppc.propose' and actor_id='${wProposer}' and after_value->>'change_type' is not null`,
  2,
);

// (b) gửi LẠI đúng 2 gợi ý đó → không nhân đôi (khoá unique theo đề xuất đang mở)
const pr2 = await rpc("vexim_ppc_propose_changes", `'${JSON.stringify({
  seller_account_id: wShop, source: "suggestion", items: [itemOf(sgNk), itemOf(sgBid)],
}).replace(/'/g, "''")}'::jsonb`);
ok(
  Number(pr2.inserted) === 0 && Number(pr2.duplicates) === 2 && (pr2.ids ?? []).length === 0
    && pr2.warnings?.length === 2,
  `0021 đề xuất trùng: 0 insert · 2 duplicates · KHÔNG gọi Amazon hai lần cho cùng một việc — ${JSON.stringify(pr2.warnings)}`,
);
ok(
  (await rows(`select has_open_request from public.vexim_ppc_suggestions
     where seller_account_id='${wShop}' and suggestion_key in ('nk|W1|AG1|free sample','bid|K2')`))
    .every((r) => r.has_open_request === true),
  "0021 gợi ý: has_open_request bật TRUE sau khi đã đề xuất (UI disable nút, không gửi lại)",
);

// (c) validate: sai cặp entity×change, thiếu id Amazon, bid vượt trần, negative trùng
await asUser(wApprover);
const polRes1 = await rpc("vexim_ppc_set_policy", `'${JSON.stringify({
  seller_account_id: wShop, policy: { bid_ceiling: 3.0, bid_floor: 0.05, daily_change_cap: 50 },
}).replace(/'/g, "''")}'::jsonb`);
ok(
  polRes1.ok === true && Number(polRes1.policy?.bid_ceiling) === 3
    && Number(polRes1.policy?.bid_floor) === 0.05 && polRes1.policy?.has_row === true
    && polRes1.before?.has_row === false,
  `0021 policy: trưởng phòng PPC đặt sàn/trần bid (0.05..3.00) — before/after trả đủ để UI hiện diff — ${JSON.stringify(polRes1.policy).slice(0, 200)}`,
);
await asUser(wProposer);
const prBad = await rpc("vexim_ppc_propose_changes", `'${JSON.stringify({
  seller_account_id: wShop,
  items: [
    { entity_type: "keyword", change_type: "budget", amazon_entity_id: "K1", campaign_id: "W1",
      after_value: { budget: 10 } },                                    // cặp sai
    { entity_type: "campaign", change_type: "budget", campaign_id: "W1",
      after_value: { budget: 30 } },                                    // thiếu amazon_entity_id
    { entity_type: "keyword", change_type: "bid", amazon_entity_id: "K2", campaign_id: "W1",
      label: "sua rua mat", before_value: { bid: 2 }, after_value: { bid: 4.5 } }, // vượt trần 3.0
    { entity_type: "keyword", change_type: "bid", amazon_entity_id: "K1", campaign_id: "W1",
      label: "mat ong", before_value: { bid: 1 }, after_value: { bid: 1 } },        // không đổi gì
    { entity_type: "keyword", change_type: "state", amazon_entity_id: "K1", campaign_id: "W1",
      label: "mat ong", after_value: { state: "DELETED" } },            // state lạ
    { entity_type: "negative_keyword", change_type: "create", campaign_id: "W1",
      ad_group_id: "AG1", label: "gift set", match_type: "NEGATIVE_EXACT",
      after_value: {} },                                                // đã phủ định rồi
    { entity_type: "negative_keyword", change_type: "create", campaign_id: "W1",
      label: "thieu ad group", match_type: "NEGATIVE_EXACT", after_value: {} }, // thiếu adGroupId
  ],
}).replace(/'/g, "''")}'::jsonb`);
ok(
  Number(prBad.inserted) === 0 && Number(prBad.blocked) === 5 && Number(prBad.duplicates) === 2
    && prBad.warnings?.length === 7,
  `0021 validate: 7 đề xuất rác → 0 insert · 5 blocked · 2 duplicate — ${JSON.stringify(prBad.warnings?.map((w) => w.blocked ?? w.duplicate))}`,
);
ok(
  prBad.warnings?.some((w) => String(w.blocked).includes("vượt sàn/trần"))
    && prBad.warnings?.some((w) => String(w.blocked).includes("amazon_entity_id"))
    && prBad.warnings?.some((w) => String(w.duplicate).includes("ĐÃ được phủ định"))
    && prBad.warnings?.some((w) => String(w.duplicate).includes("bằng giá trị hiện tại")),
  `0021 validate: lý do chặn NÓI RÕ bằng tiếng Việt (UI chỉ đúng dòng sai) — ${JSON.stringify(prBad.warnings)}`,
);
// negative match_type kiểu v2 (negativeExact) phải được CHUẨN HOÁ sang v3
const prMt = await rpc("vexim_ppc_propose_changes", `'${JSON.stringify({
  seller_account_id: wShop,
  items: [{ entity_type: "campaign_negative_keyword", change_type: "create", campaign_id: "W2",
    label: " wholesale ", match_type: "negativePhrase", after_value: {} }],
}).replace(/'/g, "''")}'::jsonb`);
ok(
  Number(prMt.inserted) === 1,
  `0021 negative cấp campaign: nhận match_type kiểu v2 ("negativePhrase") → chuẩn hoá v3 — ${JSON.stringify(prMt.warnings)}`,
);
await cmp(
  "0021 negative cấp campaign: match_type = NEGATIVE_PHRASE, ad_group_id rỗng, label đã trim",
  `select count(*) n from ads.change_requests where entity_type='campaign_negative_keyword'
     and match_type='NEGATIVE_PHRASE' and ad_group_id='' and label='wholesale'
     and after_value->>'level'='campaign' and after_value->>'keyword_text'='wholesale'`,
  1,
);

// (d) auto_apply: trong ngưỡng → approved ngay; vượt ngưỡng → vẫn phải duyệt
await asUser(wApprover);
await rpc("vexim_ppc_set_policy", `'${JSON.stringify({
  seller_account_id: wShop, policy: { auto_apply: true, require_approval_state: true, bid_ceiling: 3.0 },
}).replace(/'/g, "''")}'::jsonb`);
await asUser(wProposer);
const prAuto = await rpc("vexim_ppc_propose_changes", `'${JSON.stringify({
  seller_account_id: wShop,
  items: [
    { entity_type: "keyword", change_type: "bid", amazon_entity_id: "K4", campaign_id: "W1",
      ad_group_id: "AG1", label: "it click", currency: "USD", before_value: { bid: 1 },
      after_value: { bid: 0.9 } },                                      // -10% ≤ 20% → tự duyệt
    { entity_type: "keyword", change_type: "bid", amazon_entity_id: "K3", campaign_id: "W1",
      ad_group_id: "AG1", label: "dau goi free", currency: "USD", before_value: { bid: 1.5 },
      after_value: { bid: 0.75 } },                                     // -50% > 20% → phải duyệt
    { entity_type: "keyword", change_type: "state", amazon_entity_id: "K4", campaign_id: "W1",
      ad_group_id: "AG1", label: "it click", after_value: { state: "PAUSED" } }, // state → phải duyệt
    { entity_type: "keyword", change_type: "bid", amazon_entity_id: "K1", campaign_id: "W1",
      ad_group_id: "AG1", label: "mat ong", currency: "USD", after_value: { bid: 0.8 } }, // không biết bid cũ
  ],
}).replace(/'/g, "''")}'::jsonb`);
ok(Number(prAuto.inserted) === 4, `0021 auto_apply: 4 đề xuất ghi được — ${JSON.stringify(prAuto).slice(0, 200)}`);
const autoRows = await rows(`select amazon_entity_id, change_type, status, requires_approval, decision_note
   from ads.change_requests
   where id = any (array[${prAuto.ids.map((i) => `'${i}'`).join(",")}]::uuid[])
   order by change_type, amazon_entity_id`);
const ar = (id, ct) => autoRows.find((r) => r.amazon_entity_id === id && r.change_type === ct);
ok(
  ar("K4", "bid")?.status === "approved" && ar("K4", "bid")?.requires_approval === false
    && String(ar("K4", "bid")?.decision_note).includes("tự duyệt theo policy"),
  `0021 auto_apply: bid -10% (trong ngưỡng 20%) → APPROVED ngay, ghi rõ lý do tự duyệt — ${JSON.stringify(ar("K4", "bid"))}`,
);
ok(
  ar("K3", "bid")?.status === "proposed" && ar("K3", "bid")?.requires_approval === true,
  "0021 auto_apply: bid -50% VƯỢT ngưỡng 20% → vẫn phải có người duyệt (auto_apply không phải toàn quyền)",
);
ok(
  ar("K4", "state")?.status === "proposed" && ar("K1", "bid")?.status === "proposed",
  "0021 auto_apply: đổi state LUÔN cần duyệt (require_approval_state) · bid mà KHÔNG biết giá hiện tại cũng cần duyệt",
);
// tắt auto_apply trở lại (mặc định an toàn) + siết trần 2 thay đổi/ngày cho test worker
await asUser(wApprover);
await rpc("vexim_ppc_set_policy", `'${JSON.stringify({
  seller_account_id: wShop, policy: { auto_apply: false, daily_change_cap: 2, bid_ceiling: 3.0 },
}).replace(/'/g, "''")}'::jsonb`);

// ---- 7. RPC DUYỆT — chỉ approver, có audit, tự duyệt bị ghi chú --------------
const idWholesale = prMt.ids[0];
const idK3Bid = (await one(`select id from ads.change_requests where seller_account_id='${wShop}'
   and amazon_entity_id='K3' and change_type='bid'`)).id;
const idK1Bid = (await one(`select id from ads.change_requests where seller_account_id='${wShop}'
   and amazon_entity_id='K1' and change_type='bid'`)).id;
const idK4Bid = (await one(`select id from ads.change_requests where seller_account_id='${wShop}'
   and amazon_entity_id='K4' and change_type='bid'`)).id;

await asUser(wProposer);
ok(
  String((await rpcFail("vexim_ppc_decide_change", `'${idNk}','approve',null`)).error)
    .includes("trưởng phòng PPC") === true,
  "0021 CHẶN: người đề xuất (không phải approver) KHÔNG tự duyệt được đề xuất",
);
await asUser(wStranger);
ok(
  String((await rpcFail("vexim_ppc_decide_change", `'${idNk}','approve',null`)).error)
    .includes("duyệt thay đổi quảng cáo") === true,
  "0021 CHẶN: người lạ (không phải approver) không duyệt được đề xuất của shop",
);
await asUser(wApprover);
const dc1 = await rpc("vexim_ppc_decide_change", `'${idNk}','approve','Đồng ý — term này đốt 7.5 USD mỗi tuần'`);
ok(
  dc1.ok === true && dc1.status === "approved" && dc1.label === "free sample"
    && dc1.decided_by === wApprover && String(dc1.note).includes("Đồng ý"),
  `0021 duyệt: approver approve đề xuất negative keyword — ${JSON.stringify(dc1)}`,
);
const dc2 = await rpc("vexim_ppc_decide_change", `'${idBid}','approve',null`);
const dc3 = await rpc("vexim_ppc_decide_change", `'${idWholesale}','approve',null`);
ok(dc2.status === "approved" && dc3.status === "approved", "0021 duyệt: approve thêm 2 đề xuất (bid K2 · negative cấp campaign W2)");
const dc4 = await rpc("vexim_ppc_decide_change", `'${idK3Bid}','reject','Chưa đủ dữ liệu — chờ thêm 7 ngày'`);
ok(dc4.status === "rejected", `0021 từ chối: reject đề xuất hạ bid K3 — ${JSON.stringify(dc4)}`);
ok(
  String((await rpcFail("vexim_ppc_decide_change", `'${idK3Bid}','approve',null`)).error).includes("rejected") === true,
  "0021 CHẶN: đề xuất ĐÃ bị từ chối thì không duyệt lại được (máy trạng thái)",
);
ok(
  String((await rpcFail("vexim_ppc_decide_change", `'${idNk}','maybe',null`)).error).includes("approve hoặc reject") === true,
  "0021 CHẶN: p_decision lạ (maybe) bị từ chối",
);
// tự duyệt đề xuất của CHÍNH MÌNH → được nhưng bị ghi chú thẳng vào audit
const selfProp = await rpc("vexim_ppc_propose_changes", `'${JSON.stringify({
  seller_account_id: wShop, source: "manual", reason: "Tạm dừng campaign W2 để kiểm thử",
  items: [{ entity_type: "campaign", change_type: "state", amazon_entity_id: "W2", campaign_id: "W2",
    label: "SP - ROAS tot", currency: "USD", before_value: { state: "ENABLED", budget: 40 },
    after_value: { state: "PAUSED" } }],
}).replace(/'/g, "''")}'::jsonb`);
const idSelf = selfProp.ids?.[0];
const dcSelf = await rpc("vexim_ppc_decide_change", `'${idSelf}','approve','Can theo mùa'`);
ok(
  idSelf && String(dcSelf.note).includes("tự duyệt đề xuất của chính mình"),
  `0021 tự duyệt: cho phép (team nhỏ) nhưng GHI RÕ vào decision_note — "${dcSelf.note}"`,
);
// duyệt theo lô: 2 dòng hợp lệ + 1 id sai + 1 dòng đã duyệt
const idK4State = (await one(`select id from ads.change_requests where seller_account_id='${wShop}'
   and amazon_entity_id='K4' and change_type='state'`)).id;
const dcBulk = await rpc("vexim_ppc_decide_bulk", `'${JSON.stringify([
  idK4State, idK1Bid, "00000000-0000-4000-8000-0000000000ff", idNk,
]).replace(/'/g, "''")}'::jsonb,'reject','Dọn hàng đợi trước khi test worker'`);
ok(
  Number(dcBulk.decided) === 2 && Number(dcBulk.failed) === 2 && dcBulk.errors?.length === 2,
  `0021 duyệt lô: 2 được · 2 lỗi (id không tồn tại + đã duyệt rồi) — lỗi KHÔNG làm hỏng cả lô — ${JSON.stringify(dcBulk.errors)}`,
);
await cmp(
  "0021 audit: mỗi lần duyệt/từ chối đều có dòng trong iam.audit_logs (kèm before/after)",
  `select count(*) n from iam.audit_logs where seller_account_id='${wShop}' and module='ads'
     and action in ('ppc.approved','ppc.rejected')`,
  7,
);
ok(
  (await rows(`select actor_id, after_value->>'by' as by_whom, before_value->>'status' as old_status
     from iam.audit_logs where seller_account_id='${wShop}' and action='ppc.approved'
       and after_value->>'status'='approved' limit 3`))
    .every((r) => r.actor_id === wApprover && r.old_status === "proposed"),
  "0021 audit: dòng duyệt ghi ĐÚNG người duyệt (actor_id) + trạng thái trước đó (before_value)",
);
// view hàng đợi: chữ người đọc được
const qv = await rows(`select id, status, status_label, summary, delta_label, entity_label, can_decide,
     is_mine, proposed_by_name, decided_by_name, decision_note, expires_in_hours, is_open
   from public.vexim_ppc_change_requests where seller_account_id='${wShop}'
   order by proposed_at`);
const qOf = (id) => qv.find((r) => r.id === id);
ok(
  qOf(idNk)?.status_label === "Đã duyệt — chờ cron"
    && qOf(idNk)?.summary === 'Phủ định "free sample" (NEGATIVE_EXACT) cấp ad group'
    && qOf(idNk)?.entity_label === "Negative keyword (ad group)"
    && qOf(idNk)?.proposed_by_name === "Nhân viên PPC"
    && qOf(idNk)?.decided_by_name === "Trưởng phòng PPC"
    && qOf(idNk)?.is_open === true && Number(qOf(idNk)?.expires_in_hours) > 70,
  `0021 view hàng đợi: summary/status_label/tên người là CHỮ đọc được (UI không phải tự ghép) — ${JSON.stringify(qOf(idNk))}`,
);
ok(
  qOf(idBid)?.summary === "Bid 2 → 1.7 USD (-15%)" && qOf(idBid)?.delta_label === "-15%",
  `0021 view hàng đợi: summary bid hiển thị đúng trước → sau + % ("${qOf(idBid)?.summary}")`,
);
ok(
  qOf(idSelf)?.summary === "Trạng thái ENABLED → PAUSED"
    && String(qOf(idSelf)?.decision_note).includes("tự duyệt đề xuất của chính mình")
    && qOf(idSelf)?.is_mine === true,
  `0021 view hàng đợi: summary đổi trạng thái + ghi chú tự duyệt hiện ngay trên dòng ("${qOf(idSelf)?.decision_note}")`,
);
ok(
  qv.every((r) => r.can_decide === false),
  "0021 view hàng đợi: mọi dòng ĐÃ quyết (approved/rejected) đều can_decide=false — UI ẩn nút duyệt",
);

// ---- 8. Máy trạng thái + bất biến nội dung đề xuất ---------------------------
ok(
  await mustBlock(`update ads.change_requests set status='applied' where id='${idK1Bid}'`),
  "0021 CHẶN: nhảy proposed → applied (bỏ qua duyệt) — không ai tự áp dụng được",
);
ok(
  await mustBlock(`update ads.change_requests set after_value='{"bid":0.01}'::jsonb where id='${idBid}'`),
  "0021 CHẶN: sửa after_value sau khi duyệt (người duyệt phải duyệt đúng nội dung đã đề xuất)",
);
ok(
  await mustBlock(`update ads.change_requests set before_value='{"bid":9}'::jsonb where id='${idBid}'`),
  "0021 CHẶN: sửa before_value sau khi tạo",
);
ok(
  await mustBlock(`update ads.change_requests set status='proposed' where id='${idNk}'`),
  "0021 CHẶN: approved → proposed (quay ngược máy trạng thái)",
);
ok(
  await mustBlock(`insert into ads.change_requests(seller_account_id,entity_type,change_type,after_value,status)
     values ('${wShop}','campaign','state','{"state":"PAUSED"}'::jsonb,'applied')`),
  "0021 CHẶN: insert một đề xuất sinh ra đã applied (mất dấu audit)",
);
ok(
  await mustBlock(`insert into ads.change_requests(seller_account_id,entity_type,change_type,status)
     values ('${wShop}','campaign','state','proposed')`),
  "0021 CHẶN: insert đề xuất không có after_value (không biết đổi thành gì)",
);

// ---- 9. WORKER: lấy lô đã duyệt (trần ngày · TTL · skip SB · đòi lô kẹt) -----
await asUser(wProposer);
const wErr1 = String((await rpcFail("vexim_worker_ppc_pending_changes", `null, 100, 30`)).error);
ok(
  /permission denied|service_role/i.test(wErr1),
  `0021 CHẶN: client không gọi được RPC worker (chỉ service_role) — "${wErr1}"`,
);
const wErr2 = String((await rpcFail("vexim_worker_ppc_set_result", `'{}'::jsonb`)).error);
ok(
  /permission denied|service_role/i.test(wErr2),
  `0021 CHẶN: client không ghi được kết quả áp dụng — "${wErr2}"`,
);
ok(
  /permission denied|service_role/i.test(String((await rpcFail("vexim_ppc_raise_alerts", `null`)).error)),
  "0021 CHẶN: client không tự nổ/đóng alert của hàng đợi PPC",
);
await asWorker();
// (a) một đề xuất QUÁ TTL và (b) một đề xuất trên campaign Sponsored Brands
await ex(`insert into ads.change_requests(seller_account_id,ads_profile_id,entity_type,change_type,
     amazon_entity_id,campaign_id,ad_group_id,label,currency,before_value,after_value,status,
     proposed_by,expires_at)
   values ('${wShop}','1234567890','keyword','bid','K9','W1','AG1','keyword het han','USD',
           '{"bid":1}'::jsonb,'{"bid":0.8}'::jsonb,'proposed','${wProposer}',
           now() - interval '1 hour')`);
await ex(`insert into ads.change_requests(seller_account_id,ads_profile_id,entity_type,change_type,
     amazon_entity_id,campaign_id,label,currency,before_value,after_value,status,proposed_by,expires_at)
   values ('${wShop}','1234567890','campaign','state','W9','W9','SB - Video','USD',
           '{"state":"ENABLED"}'::jsonb,'{"state":"PAUSED"}'::jsonb,'approved','${wApprover}',
           now() + interval '72 hours')`);
// now() của Postgres là THỜI ĐIỂM BẮT ĐẦU TRANSACTION → trong test mọi decided_at
// bằng nhau. Đặt lại mốc duyệt cho 2 dòng để kiểm chứng đúng thứ tự ưu tiên.
await ex(`update ads.change_requests set decided_at = now() - interval '2 hours'
   where id='${idK4Bid}';
   update ads.change_requests set decided_at = now() - interval '1 hour'
   where id='${idNk}';
   update ads.change_requests set decided_at = now() - interval '30 minutes'
   where id='${idBid}';
   update ads.change_requests set decided_at = now() - interval '20 minutes'
   where id='${idWholesale}';
   update ads.change_requests set decided_at = now() - interval '10 minutes'
   where id='${idSelf}'`);
const pend1 = await rpc("vexim_worker_ppc_pending_changes", `'${wShop}'::uuid, 100, 30`);
ok(
  Number(pend1.count) === 2 && Number(pend1.expired) === 1 && Number(pend1.skipped_unsupported) === 1
    && pend1.batch_id && pend1.requests.length === 2,
  `0021 worker: trần 2 thay đổi/ngày → lấy đúng 2 (dù có 4 đã duyệt) · tự expire đề xuất quá TTL · tự skip campaign Sponsored Brands — ${JSON.stringify(pend1).slice(0, 600)}`,
);
ok(
  pend1.requests.every((r) => r.batch_id === pend1.batch_id)
    && pend1.requests[0].amazon_entity_id === "K4"
    && pend1.requests[1].label === "free sample",
  `0021 worker: lô ưu tiên đề xuất DUYỆT TRƯỚC, cả lô cùng một batch_id — ${JSON.stringify(pend1.requests.map((r) => r.amazon_entity_id || r.label))}`,
);
const rqNk = pend1.requests.find((r) => r.label === "free sample");
const rqK4 = pend1.requests.find((r) => r.amazon_entity_id === "K4");
ok(
  rqNk.ads_profile_id === "1234567890" && rqNk.match_type === "NEGATIVE_EXACT"
    && rqNk.after_value?.keyword_text === "free sample" && rqNk.before_value === null
    && Number(rqK4.after_value?.bid) === 0.9 && rqK4.campaign_type === "sp",
  `0021 worker: trả đủ before/after + profileId + campaign_type để cron gọi Amazon mà không phải tra thêm — ${JSON.stringify(rqNk).slice(0, 200)}`,
);
await cmp(
  "0021 worker: giành lô = status applying + attempts=1 (hai cron chạy song song cũng không áp dụng trùng)",
  `select count(*) n from ads.change_requests where seller_account_id='${wShop}'
     and status='applying' and batch_id='${pend1.batch_id}' and attempts=1`,
  2,
);
const pend2 = await rpc("vexim_worker_ppc_pending_changes", `'${wShop}'::uuid, 100, 30`);
ok(
  Number(pend2.count) === 0 && Number(pend2.cap_left?.[0]?.daily_cap) === 2
    && Number(pend2.cap_left?.[0]?.used_today) === 2
    && Number(pend2.cap_left?.[0]?.waiting) === 3,
  `0021 worker: gọi LẠI ngay → 0 dòng, và cap_left nói rõ LÝ DO (trần 2/ngày đã dùng hết 2, còn 3 việc chờ) — ${JSON.stringify(pend2.cap_left)}`,
);

// ---- 10. WORKER ghi kết quả: applied · failed · skipped ----------------------
const resNk = await rpc("vexim_worker_ppc_set_result", `'${JSON.stringify({
  id: rqNk.request_id, status: "applied", batch_id: pend1.batch_id,
  created_id: "nk-2468", amazon_response: { negativeKeywordId: "nk-2468", index: 0 },
}).replace(/'/g, "''")}'::jsonb`);
ok(
  resNk.ok === true && resNk.status === "applied" && resNk.created_id === "nk-2468",
  `0021 worker: negative keyword áp dụng thành công (207 success) — ${JSON.stringify(resNk)}`,
);
await cmp(
  "0021 applied: từ khoá phủ định được GƯƠNG vào ads.negative_keywords kèm id Amazon thật",
  `select count(*) n from ads.negative_keywords where seller_account_id='${wShop}'
     and keyword_text='free sample' and match_type='NEGATIVE_EXACT' and level='ad_group'
     and campaign_id='W1' and ad_group_id='AG1' and amazon_negative_id='nk-2468'
     and source='vexim' and change_request_id='${rqNk.request_id}'`,
  1,
);
ok(
  (await rows(`select keyword_norm, match_label, request_status from public.vexim_ads_negative_keywords
     where seller_account_id='${wShop}' and keyword_text='free sample'`))
    .every((r) => r.keyword_norm === "free sample" && r.match_label === "Phủ định chính xác"
      && r.request_status === "applied"),
  "0021 view negative: nhãn tiếng Việt + trạng thái của đề xuất đã sinh ra nó",
);
await cmp(
  "0021 gợi ý: sau khi phủ định xong, gợi ý cho term đó BIẾN MẤT (không đề xuất lặp lại)",
  `select count(*) n from public.vexim_ppc_suggestions
    where seller_account_id='${wShop}' and label='free sample'`,
  0,
);
const resFail = await rpc("vexim_worker_ppc_set_result", `'${JSON.stringify({
  id: rqK4.request_id, status: "failed", batch_id: pend1.batch_id,
  error: "400 INVALID_ARGUMENT: bid must be at least 0.02 (Amazon từ chối)",
  amazon_response: { errors: [{ code: "INVALID_ARGUMENT", message: "bid too low" }] },
}).replace(/'/g, "''")}'::jsonb`);
ok(resFail.ok === false && resFail.status === "failed" && resFail.alert_id,
   `0021 worker: áp dụng THẤT BẠI → nổ alert ngay, không im lặng — ${JSON.stringify(resFail)}`);
await cmp(
  "0021 alert: ppc_change_failed mở, entity_key khử trùng theo shop (chạy lại không spam)",
  `select count(*) n from ops.alerts a join ops.alert_rules r on r.id=a.rule_id
    where r.rule_code='ppc_change_failed' and a.seller_account_id='${wShop}' and a.status='open'
      and a.entity_key='ppc_failed:${wShop}'`,
  1,
);
await cmp(
  "0021 audit: thất bại ghi result='error: …', actor_id NULL và after_value.by='cron' (không mạo danh người duyệt)",
  `select count(*) n from iam.audit_logs where seller_account_id='${wShop}'
     and action='ppc.failed' and result like 'error:%INVALID_ARGUMENT%'
     and actor_id is null and after_value->>'by'='cron'`,
  1,
);
const pend3 = await rpc("vexim_worker_ppc_pending_changes", `'${wShop}'::uuid, 100, 30`);
ok(
  Number(pend3.count) === 1 && pend3.requests[0].label === "sua rua mat"
    && Number(pend3.requests[0].delta_pct) === -15,
  `0021 worker: dòng FAILED không tính vào trần ngày → còn 1 slot cho đề xuất kế (bid K2 -15%) — ${JSON.stringify(pend3.requests.map((r) => r.label))}`,
);
const rqK2 = pend3.requests[0];
// cron chết giữa chừng: dòng applying để quá 30 phút → lô sau phải lấy lại được
await ex(`update ads.change_requests set claimed_at = now() - interval '2 hours'
   where id='${rqK2.request_id}'`);
const pend4 = await rpc("vexim_worker_ppc_pending_changes", `'${wShop}'::uuid, 100, 30`);
ok(
  Number(pend4.reclaimed) === 1 && Number(pend4.count) === 1
    && pend4.requests[0].request_id === rqK2.request_id
    && Number(pend4.requests[0].attempts) === 2,
  `0021 worker: đòi lại lô kẹt (applying > 30 phút) → trả về hàng đợi rồi lấy lại, attempts=2 — ${JSON.stringify({ reclaimed: pend4.reclaimed, count: pend4.count, attempts: pend4.requests[0]?.attempts })}`,
);
const resSkip = await rpc("vexim_worker_ppc_set_result", `'${JSON.stringify({
  id: rqK2.request_id, status: "skipped", batch_id: pend4.batch_id,
  error: "Amazon đang để bid 1.85 khác before_value 2.00 — có người đã đổi tay trong Ads console, không ghi đè",
  amazon_response: { currentBid: 1.85 },
}).replace(/'/g, "''")}'::jsonb`);
ok(resSkip.status === "skipped",
   `0021 worker: before_value LỆCH Amazon → SKIP thay vì ghi đè mù — ${JSON.stringify(resSkip)}`);
ok(
  (await one(`select status_label, last_error from public.vexim_ppc_change_requests
     where id='${rqK2.request_id}'`)).status_label === "Bỏ qua (lệch Amazon)",
  "0021 view hàng đợi: skipped có nhãn rõ + lý do (người duyệt biết vì sao không áp dụng)",
);
ok(
  await mustBlock(`select * from public.vexim_worker_ppc_set_result(
     '{"id":"${rqK2.request_id}","status":"applied"}'::jsonb)`),
  "0021 CHẶN: skipped/applied là trạng thái CUỐI — không ghi kết quả lần hai",
);

// ---- 11. Negative cấp campaign + cron áp dụng tiếp lô còn lại ----------------
const pend5 = await rpc("vexim_worker_ppc_pending_changes", `'${wShop}'::uuid, 100, 30`);
ok(
  Number(pend5.count) === 1 && pend5.requests[0].label === "wholesale"
    && pend5.requests[0].entity_type === "campaign_negative_keyword",
  `0021 worker: lô kế tiếp là negative cấp campaign — ${JSON.stringify(pend5.requests.map((r) => r.label))}`,
);
const resWs = await rpc("vexim_worker_ppc_set_result", `'${JSON.stringify({
  id: pend5.requests[0].request_id, status: "applied", batch_id: pend5.batch_id,
  created_id: "cnk-1357",
}).replace(/'/g, "''")}'::jsonb`);
ok(resWs.status === "applied", `0021 worker: áp dụng negative cấp campaign — ${JSON.stringify(resWs)}`);
await cmp(
  "0021 applied: negative cấp CAMPAIGN lưu level='campaign', ad_group_id rỗng, id Amazon thật",
  `select count(*) n from ads.negative_keywords where seller_account_id='${wShop}'
     and keyword_text='wholesale' and level='campaign' and ad_group_id=''
     and match_type='NEGATIVE_PHRASE' and amazon_negative_id='cnk-1357' and campaign_id='W2'`,
  1,
);
await cmp(
  "0021 audit: đủ 4 mốc của MỘT vòng đời (propose → approved → applying → applied)",
  `select count(distinct action) n from iam.audit_logs where seller_account_id='${wShop}'
     and action in ('ppc.propose','ppc.approved','ppc.applying','ppc.applied')`,
  4,
);
await cmp(
  "0021: 2 từ khoá phủ định đã thêm, không nhân đôi khi nhập lại",
  `select count(*) n from ads.negative_keywords where seller_account_id='${wShop}'
     and source='vexim'`,
  2,
);

// ---- 12. Alert của hàng đợi: chờ duyệt quá 24 giờ → nổ; duyệt xong → tự đóng --
await ex(`insert into ads.change_requests(seller_account_id,ads_profile_id,entity_type,change_type,
     amazon_entity_id,campaign_id,ad_group_id,label,currency,before_value,after_value,status,
     proposed_by,proposed_at,expires_at)
   values ('${wShop}','1234567890','keyword','bid','K1','W1','AG1','mat ong','USD',
           '{"bid":1}'::jsonb,'{"bid":0.8}'::jsonb,'proposed','${wProposer}',
           now() - interval '30 hours', now() + interval '42 hours')`);
await asUser(wApprover);
await cmp(
  "0021 view hàng đợi: dòng proposed còn hạn → approver thấy can_decide=true (nút duyệt hiện)",
  `select count(*) n from public.vexim_ppc_change_requests
    where seller_account_id='${wShop}' and status='proposed' and can_decide`,
  1,
);
await asWorker();
const al1 = await rows(`select * from public.vexim_ppc_raise_alerts('${wShop}')`);
const alPend = al1.find((r) => r.rule_code === "ppc_pending_approval");
const alFail = al1.find((r) => r.rule_code === "ppc_change_failed");
ok(
  alPend?.next_action === "raised" && alPend.severity === "amber"
    && Number(alPend.threshold) === 24 && alPend.entity_key === `ppc_pending:${wShop}`
    && String(alPend.shop_name).length > 0,
  `0021 alert hàng đợi: đề xuất chờ duyệt 30 giờ (> ngưỡng 24) → nổ amber — ${JSON.stringify(alPend)}`,
);
ok(
  alFail?.next_action === "raised" && alFail.severity === "red"
    && String(alFail.metric) !== "" && alFail.alert_id,
  `0021 alert hàng đợi: có thay đổi áp dụng thất bại trong 24h → nổ red — ${JSON.stringify(alFail)}`,
);
const al2 = await rows(`select * from public.vexim_ppc_raise_alerts('${wShop}')`);
ok(
  al2.find((r) => r.rule_code === "ppc_pending_approval")?.alert_id === alPend.alert_id,
  "0021 alert hàng đợi: chạy LẠI → cùng alert_id (dedupe theo entity_key, không spam chuông)",
);
// duyệt nốt đề xuất cũ → alert chờ duyệt phải TỰ ĐÓNG
await asUser(wApprover);
const idOld = (await one(`select id from ads.change_requests where seller_account_id='${wShop}'
   and status='proposed' and proposed_at < now() - interval '24 hours' limit 1`)).id;
await rpc("vexim_ppc_decide_change", `'${idOld}','reject','Hết hạn dữ liệu'`);
await asWorker();
const al3 = await rows(`select * from public.vexim_ppc_raise_alerts('${wShop}')`);
ok(
  al3.find((r) => r.rule_code === "ppc_pending_approval")?.next_action === "resolved",
  `0021 alert hàng đợi: duyệt/từ chối hết đề xuất cũ → TỰ ĐÓNG alert — ${JSON.stringify(al3.find((r) => r.rule_code === "ppc_pending_approval"))}`,
);
ok(
  al3.find((r) => r.rule_code === "ppc_change_failed")?.next_action === "raised",
  "0021 alert hàng đợi: alert thất bại VẪN mở (còn dòng failed trong 24h) — không đóng nhầm",
);

// ---- 13. View policy: guardrail hiệu lực + trạng thái hàng đợi + quyền --------
await asUser(wApprover);
const pol2 = await rpc("vexim_ppc_set_policy", `'${JSON.stringify({
  seller_account_id: wShop,
  policy: { bid_floor: 0.1, bid_ceiling: 2.5, budget_ceiling: 60, daily_change_cap: 20,
            max_open_requests: 5, proposal_ttl_hours: 48, suggestion_min_clicks: 4,
            suggestion_acos_lower_pct: 40, bid_step_pct: 10, currency: "usd",
            notes: "Guardrail Q3 của VEXIM" },
}).replace(/'/g, "''")}'::jsonb`);
ok(
  pol2.ok === true && Number(pol2.policy?.bid_ceiling) === 2.5
    && pol2.policy?.currency === "USD" && pol2.policy?.notes === "Guardrail Q3 của VEXIM"
    && Number(pol2.before?.bid_ceiling) === 3,
  `0021 policy: sửa được guardrail (currency viết thường → CHUẨN HOÁ USD), trả before/after để UI hiện diff — ${JSON.stringify(pol2.before).slice(0, 120)}`,
);
await cmp(
  "0021 policy: đổi guardrail có AUDIT (before/after toàn bộ policy)",
  `select count(*) n from iam.audit_logs where seller_account_id='${wShop}'
     and action='ppc.policy.update' and before_value->>'bid_ceiling' is not null
     and after_value->>'notes'='Guardrail Q3 của VEXIM'`,
  1,
);
const pv = await one(`select auto_apply, bid_floor, bid_ceiling, daily_change_cap, max_open_requests,
     proposal_ttl_hours, suggestion_min_clicks, bid_step_pct, has_policy_row, proposed_count,
     approved_count, applied_today, failed_24h, open_count, cap_left_today, can_edit_policy, currency
   from public.vexim_ppc_policies where seller_account_id='${wShop}'`);
ok(
  pv?.has_policy_row === true && pv?.auto_apply === false && Number(pv?.bid_ceiling) === 2.5
    && Number(pv?.daily_change_cap) === 20 && Number(pv?.applied_today) === 2
    && Number(pv?.failed_24h) === 1 && Number(pv?.cap_left_today) === 18
    && pv?.can_edit_policy === true && pv?.currency === "USD",
  `0021 view policy: guardrail + trạng thái hàng đợi (đã áp dụng hôm nay 2 · thất bại 1 · trần còn 18/20) — ${JSON.stringify(pv)}`,
);
await asUser(wProposer);
ok(
  (await one(`select can_edit_policy from public.vexim_ppc_policies
     where seller_account_id='${wShop}'`)).can_edit_policy === false,
  "0021 view policy: nhân viên PPC thấy can_edit_policy=false (UI ẩn nút sửa guardrail)",
);
ok(
  String((await rpcFail("vexim_ppc_set_policy", `'${JSON.stringify({
    seller_account_id: wShop, policy: { auto_apply: true } }).replace(/'/g, "''")}'::jsonb`)).error)
    .includes("guardrail") === true,
  "0021 CHẶN: người không phải approver không tự mở auto_apply (tự duyệt thay đổi tiền bạc)",
);
ok(
  await mustBlock(`select * from public.vexim_ppc_set_policy(
     '{"seller_account_id":"${wShop}","policy":{"bid_floor":5,"bid_ceiling":1}}'::jsonb)`),
  "0021 CHẶN: policy vô nghĩa (sàn bid 5 > trần 1) bị CHECK của bảng chặn",
);
// trần đề xuất đang mở: max_open_requests = 5 mà hàng đợi đang mở nhiều hơn
await asUser(wApprover);
await rpc("vexim_ppc_set_policy", `'${JSON.stringify({
  seller_account_id: wShop, policy: { max_open_requests: 1 } }).replace(/'/g, "''")}'::jsonb`);
await asUser(wProposer);
ok(
  String((await rpcFail("vexim_ppc_propose_changes", `'${JSON.stringify({
    seller_account_id: wShop,
    items: [{ entity_type: "keyword", change_type: "bid", amazon_entity_id: "K1", campaign_id: "W1",
      ad_group_id: "AG1", label: "mat ong", currency: "USD", before_value: { bid: 1 },
      after_value: { bid: 0.95 } }] }).replace(/'/g, "''")}'::jsonb`)).error)
    .includes("vượt trần") === true,
  "0021 CHẶN: quá trần đề xuất đang mở (max_open_requests) → báo rõ phải duyệt bớt, không nhận thêm",
);

// ---- 14. RLS: người lạ không thấy gì; client không ghi thẳng bảng ------------
await asUser(wStranger);
await cmp(
  "0021 RLS: người lạ không thấy đề xuất / gợi ý / guardrail / negative của shop",
  `select (select count(*) from public.vexim_ppc_change_requests where seller_account_id='${wShop}')
        + (select count(*) from public.vexim_ppc_suggestions where seller_account_id='${wShop}')
        + (select count(*) from public.vexim_ppc_policies where seller_account_id='${wShop}')
        + (select count(*) from public.vexim_ads_negative_keywords where seller_account_id='${wShop}') n`,
  0,
);
await asUser(wReadOnly);
ok(
  (await rows(`select can_propose, can_decide from public.vexim_ppc_suggestions
     where seller_account_id='${wShop}'`)).every((r) => r.can_propose === false && r.can_decide === false),
  "0021 RLS: người CHỈ XEM thấy gợi ý nhưng can_propose/can_decide đều false (UI ẩn nút)",
);
await cmp(
  "0021 RLS: người chỉ xem vẫn ĐỌC được hàng đợi (để biết việc đang chờ)",
  `select count(*) n from public.vexim_ppc_change_requests where seller_account_id='${wShop}'`,
  (await rows(`select count(*) n from ads.change_requests where seller_account_id='${wShop}'`))[0].n,
);
await asUser(wProposer);
ok(
  await mustBlock(`insert into ads.change_requests(seller_account_id,entity_type,change_type,after_value)
     values ('${wShop}','campaign','state','{"state":"PAUSED"}'::jsonb)`),
  "0021 CHẶN: authenticated không ghi THẲNG bảng hàng đợi (phải qua RPC để còn validate + audit)",
);
ok(
  await mustBlock(`update ads.change_requests set status='applied'
     where seller_account_id='${wShop}'`),
  "0021 CHẶN: authenticated không tự đổi trạng thái đề xuất trên bảng gốc",
);
ok(
  await mustBlock(`delete from ads.change_requests where seller_account_id='${wShop}'`),
  "0021 CHẶN: authenticated không xoá được lịch sử đề xuất (mất dấu audit)",
);
ok(
  await mustBlock(`insert into ads.ppc_policies(seller_account_id,auto_apply) values ('${wShop}',true)`),
  "0021 CHẶN: authenticated không ghi thẳng guardrail (phải qua RPC có audit)",
);
ok(
  await mustBlock(`insert into ads.negative_keywords(seller_account_id,campaign_id,keyword_text)
     values ('${wShop}','W1','tu them tay')`),
  "0021 CHẶN: authenticated không tự thêm từ khoá phủ định vào bảng gương",
);

await ex("rollback;");
await ex("reset role;");
await ex("select set_config('request.jwt.claim.sub','',false);");

// ---- 15. Idempotent ----------------------------------------------------------
ok(
  await ex(rd("migrations/0021_module5_ppc_write.sql"), "0021 lần 2"),
  "0021 idempotent (chạy lại không lỗi, không đổi hợp đồng)",
);
ok(
  (await colsOf("vexim_ppc_change_requests")).endsWith("can_decide,is_mine")
    && (await colsOf("vexim_ppc_suggestions")).endsWith("kind_label,can_decide,can_propose"),
  "0021 lần 2: hợp đồng cột 2 view chính giữ nguyên",
);
await cmp(
  "0021 lần 2: index unique không bị tạo trùng, trigger không nhân đôi",
  `select (select count(*) from pg_indexes where schemaname='ads'
             and indexname in ('uq_change_requests_open','uq_negative_keywords_key'))
        + (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid
             where c.relname='change_requests' and not t.tgisinternal) n`,
  4,
);
await cmp(
  "0021 lần 2: alert rule PPC không nhân đôi",
  `select count(*) n from ops.alert_rules where rule_code in ('ppc_pending_approval','ppc_change_failed')`,
  2,
);

// ---- 15b. HỢP ĐỒNG CỘT web ↔ DB (Module 5 Phần 2&3) --------------------------
// ppc-write.ts đọc 4 view của 0021 bằng chuỗi select cố định. Thiếu/sai một cột là
// PostgREST trả PGRST202/PGRST204 lúc CHẠY THẬT (build không bắt được), nên kiểm
// thẳng vào DB đã migrate ở đây.
{
  const webSelects = {
    vexim_ppc_policies: PPC_POLICY_SELECT,
    vexim_ppc_change_requests: PPC_REQUEST_SELECT,
    vexim_ppc_suggestions: PPC_SUGGESTION_SELECT,
    vexim_ads_negative_keywords: PPC_NEGATIVE_SELECT,
  };
  for (const [view, select] of Object.entries(webSelects)) {
    const wanted = select.split(",").map((c) => c.trim()).filter(Boolean);
    const have = new Set((await colsOf(view)).split(","));
    const missing = wanted.filter((c) => !have.has(c));
    ok(
      missing.length === 0,
      `0021: ${view} đủ ${wanted.length} cột mà web select`
        + (missing.length > 0 ? ` — THIẾU: ${missing.join(", ")}` : ""),
    );
  }
  // Cột web dùng để ORDER BY / lọc: PostgREST trả 400 cho cột không tồn tại.
  const webOrderFilters = {
    vexim_ppc_policies: ["shop", "seller_account_id"],
    vexim_ppc_change_requests: ["is_open", "proposed_at", "seller_account_id", "status"],
    vexim_ppc_suggestions: ["priority", "waste7", "spend7", "seller_account_id", "kind", "has_open_request"],
    vexim_ads_negative_keywords: ["last_synced_at", "keyword_text", "seller_account_id"],
  };
  for (const [view, wanted] of Object.entries(webOrderFilters)) {
    const have = new Set((await colsOf(view)).split(","));
    const missing = wanted.filter((c) => !have.has(c));
    ok(
      missing.length === 0,
      `0021: ${view} có đủ cột web dùng để sắp xếp/lọc`
        + (missing.length > 0 ? ` — THIẾU: ${missing.join(", ")}` : ""),
    );
  }
  // Khoá mà db.ts đọc từ RPC vexim_worker_ppc_pending_changes (thừa khoá không sao,
  // THIẾU khoá là mapper trả undefined âm thầm) → gọi RPC thật rồi so.
  await asWorker();
  const pending = await one(`select public.vexim_worker_ppc_pending_changes(null, 1, 30) as r`);
  const pendingKeys = Object.keys((pending && pending.r) || {}).sort().join(",");
  ok(
    pendingKeys === "batch_id,cap_left,count,expired,ok,reclaimed,requests,skipped_unsupported",
    `0021: RPC hàng đợi trả đúng 8 khoá mà db.ts đọc (${pendingKeys})`,
  );
}

}

console.log(`\n${"=".repeat(70)}`);
console.log(fails === 0 ? "TẤT CẢ PASS" : `${fails} MỤC FAIL`);
console.log("=".repeat(70));
await db.close();
process.exit(fails === 0 ? 0 : 1);
