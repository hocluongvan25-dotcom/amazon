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

console.log(`\n${"=".repeat(70)}`);
console.log(fails === 0 ? "TẤT CẢ PASS" : `${fails} MỤC FAIL`);
console.log("=".repeat(70));
await db.close();
process.exit(fails === 0 ? 0 : 1);
