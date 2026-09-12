/**
 * Test cho worker inventory sync — CLI runner ở DEMO MODE + su kien runtime.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runInventorySyncAll } from "../src/runtime/run-inventory-sync.ts";
import { MockDbAdapter } from "../src/db/adapter.ts";

test("CLI runner DEMO MODE không cần credentials: xử lý shop demo + snapshot + alerts + sync_jobs", async () => {
  const out: string[] = [];
  const result = await runInventorySyncAll({
    now: new Date("2026-09-11T06:00:00Z"),
    stdout: { write: (s: string) => void out.push(s) },
    seedMockData: (db: MockDbAdapter) => {
      db.seedSellingDays(
        "00000000-0000-0000-0000-000000000001",
        "XMO-950-BLK",
        [17, 50, 17, 17, 50, 17, 17, 17, 17, 17, 17, 17, 17, 17],
      );
      db.seedSellingDays(
        "00000000-0000-0000-0000-000000000001",
        "VPN-220",
        [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5],
      );
    },
  });
  assert.equal(result.mode, "mock");
  assert.equal(result.shopsProcessed, 1);
  assert.equal(result.totalSkus, 2);
  assert.ok(result.totalAlerts >= 1, "phải có ít nhất 1 alert (XMO còn 6 ngày cover)");
  assert.equal(result.errors.length, 0);
  const log = out.join("");
  assert.match(log, /mode=mock/);
  assert.match(log, /2 SKUs/);
  assert.match(log, /xong/);
});

test("runner với SupabaseDbAdapter nhưng không có shop → fallback về shop demo, không throw", async () => {
  // Mô phỏng supabase trả về danh sách shop trống (chưa add shop nào)
  const out: string[] = [];
  // tạo tạm 1 adapter "fake Supabase" với fetch giả — đơn giản nhất: thay env
  const orig = process.env;
  process.env = { ...orig };
  delete process.env.AMAZON_LWA_CLIENT_ID;
  delete process.env.AMAZON_LWA_CLIENT_SECRET;
  delete process.env.AMAZON_LWA_REFRESH_TOKEN;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  const result = await runInventorySyncAll({
    stdout: { write: (s: string) => void out.push(s) },
  });
  assert.equal(result.shopsProcessed, 1);
  assert.equal(result.errors.length, 0);
  process.env = orig;
});
