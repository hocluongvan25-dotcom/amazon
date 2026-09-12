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

console.log(`\n${"=".repeat(70)}`);
console.log(fails === 0 ? "TẤT CẢ PASS" : `${fails} MỤC FAIL`);
console.log("=".repeat(70));
await db.close();
process.exit(fails === 0 ? 0 : 1);
