import { test } from "node:test";
import assert from "node:assert/strict";
import { rateText, healthTone, sortIssues, readAll, healthErrorHint, type HealthIssue } from "../src/lib/data/health-model.ts";

test("missing rates stay unknown; zero is a real observation", () => {
  for (const input of [null, {}, [], [{ key: "odr", rate: null }], [{ key: "odr", rate: "0" }]]) assert.equal(rateText(input, "odr"), "—");
  assert.equal(rateText([{ key: "odr", rate: 0 }], "odr"), "0%");
  assert.equal(rateText([{ key: "odr", rate: 0.4 }], "odr"), "0.4%");
});
test("red remains red, unknown never becomes green", () => {
  assert.equal(healthTone("red"), "red");
  assert.equal(healthTone(null), "gray");
  assert.equal(healthTone("unknown"), "gray");
});
test("severity sort is stable by issue id, not nullable case_id", () => {
  const rows = ["Low", "High", "Critical", "Medium"].map((severity, n) => ({ id: String(n), severity, case_id: null } as HealthIssue));
  assert.deepEqual(sortIssues(rows).map(r => r.severity), ["Critical", "High", "Medium", "Low"]);
  assert.equal(rows[0].severity, "Low");
});
test("empty DB stays empty", async () => {
  assert.deepEqual(await readAll(async () => ({ data: [], error: null })), []);
});
test("DB errors reject instead of returning demo or partial data", async () => {
  await assert.rejects(readAll(async () => ({ data: null, error: { code: "42501" } })));
  await assert.rejects(readAll(async from => from === 0 ? { data: Array(500).fill({}), error: null } : { data: null, error: { code: "PGRST205" } }));
});
test("pagination includes records beyond PostgREST default cap", async () => {
  const source = Array.from({ length: 1201 }, (_, id) => ({ id }));
  const rows = await readAll(async (from, to) => ({ data: source.slice(from, to + 1), error: null }));
  assert.deepEqual(rows, source);
});
test("readAll: giữ mã lỗi Supabase trong message (PGRST205, 42501) để chẩn đoán được", async () => {
  await assert.rejects(
    readAll(async () => ({ data: null, error: { code: "PGRST205", message: "Could not find the table" } })),
    /PGRST205.*Could not find the table/,
  );
  await assert.rejects(
    readAll(async () => ({ data: null, error: { code: "42501", message: "permission denied for view vexim_shop_health" } })),
    /42501.*permission denied/,
  );
});
test("healthErrorHint: PGRST205 → thiếu migration; 42501 → nêu cả khả năng phiên anon; lỗi lạ → hướng dẫn chung", () => {
  assert.match(healthErrorHint("PGRST205 · Could not find the table"), /supabase db push|migration 0010/);
  assert.match(healthErrorHint("42501 · permission denied for view"), /đăng xuất\/đăng nhập lại/);
  assert.match(healthErrorHint("42501 · permission denied for view"), /GRANT/);
  assert.match(healthErrorHint("JWT expired"), /đăng nhập lại/);
  assert.match(healthErrorHint("Supabase not configured"), /NEXT_PUBLIC_SUPABASE_URL/);
  assert.match(healthErrorHint("fetch failed"), /Không kết nối được/);
  assert.match(healthErrorHint("something weird"), /RLS\/GRANT/);
});
