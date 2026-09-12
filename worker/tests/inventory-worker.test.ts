/**
 * Test cho worker inventory sync — CLI runner ở DEMO MODE + su kien runtime
 * + NGUYÊN TẮC AN TOÀN: không bao giờ ghi DB thật khi thiếu LWA credentials.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runInventorySyncAll } from "../src/runtime/run-inventory-sync.ts";
import { loadConfig } from "../src/config.ts";
import { MockDbAdapter } from "../src/db/adapter.ts";

const FULL_PROD_ENV = {
  AMAZON_LWA_CLIENT_ID: "amzn1.application-oa2-client.test",
  AMAZON_LWA_CLIENT_SECRET: "amzn1.oa2-cs.v1.test",
  AMAZON_LWA_REFRESH_TOKEN: "Atzr|test",
  NEXT_PUBLIC_SUPABASE_URL: "https://pitmyzovjwflkyoqjbkz.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
};

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
  assert.equal(result.db, "mock");
  assert.equal(result.shopsProcessed, 1);
  assert.equal(result.totalSkus, 2);
  assert.ok(result.totalAlerts >= 1, "phải có ít nhất 1 alert (XMO còn 6 ngày cover)");
  assert.equal(result.errors.length, 0);
  const log = out.join("");
  assert.match(log, /mode=mock/);
  assert.match(log, /2 SKUs/);
  assert.match(log, /xong/);
});

test("Không có Supabase lẫn LWA → chạy demo trong bộ nhớ, db='mock'", async () => {
  const out: string[] = [];
  const orig = process.env;
  process.env = { ...orig };
  delete process.env.AMAZON_LWA_CLIENT_ID;
  delete process.env.AMAZON_LWA_CLIENT_SECRET;
  delete process.env.AMAZON_LWA_REFRESH_TOKEN;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  try {
    const result = await runInventorySyncAll({
      stdout: { write: (s: string) => void out.push(s) },
    });
    assert.equal(result.mode, "mock");
    assert.equal(result.db, "mock");
    assert.equal(result.shopsProcessed, 1);
    assert.equal(result.errors.length, 0);
  } finally {
    process.env = orig;
  }
});

/**
 * REGRESSION GUARD — sự cố cấu hình thật trên Vercel của VEXIM (12/09/2026):
 * NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY đã set, nhưng
 * AMAZON_LWA_* chưa set. Điều kiện cũ `if (cfg.supabase)` vẫn nối DB THẬT
 * rồi dùng client mock → ghi SKU demo vào DB production.
 */
test("Có Supabase nhưng THIẾU AMAZON_LWA_* → KHÔNG nối/ghi DB thật, chạy demo trong bộ nhớ", async () => {
  const out: string[] = [];
  const orig = process.env;
  process.env = {
    ...orig,
    NEXT_PUBLIC_SUPABASE_URL: "https://127.0.0.1:1",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  };
  delete process.env.AMAZON_LWA_CLIENT_ID;
  delete process.env.AMAZON_LWA_CLIENT_SECRET;
  delete process.env.AMAZON_LWA_REFRESH_TOKEN;
  try {
    const result = await runInventorySyncAll({
      stdout: { write: (s: string) => void out.push(s) },
    });
    const log = out.join("");

    assert.equal(result.db, "mock", "tuyệt đối không được ghi DB thật");
    assert.equal(result.mode, "mock");
    assert.equal(result.shopsProcessed, 1, "vẫn chạy demo shop trong bộ nhớ");
    assert.equal(result.errors.length, 0);

    // Phải đi qua nhánh CHẶN CỨNG, không phải nhánh "kết nối DB thất bại".
    // Nếu ai đó đổi điều kiện về `if (cfg.supabase)`, fetch tới 127.0.0.1:1 sẽ
    // fail và log sẽ chứa thông báo dưới → hai assert này bắt được regression.
    assert.match(log, /KHÔNG ghi DB thật/);
    assert.doesNotMatch(log, /không kết nối được DB/);
  } finally {
    process.env = orig;
  }
});

// ---------------------------------------------------------------------------
// loadConfig: ma trận mode — nền tảng của chốt an toàn ở trên (pure, không I/O)
// ---------------------------------------------------------------------------
test("loadConfig: chỉ đủ 5 biến LWA+Supabase mới là 'production'", () => {
  // Đủ cả 5 → production
  assert.equal(loadConfig({ ...FULL_PROD_ENV }).mode, "production");

  // Thiếu 1 trong 3 biến LWA → KHÔNG được là production.
  // Giá trị kỳ vọng theo đúng logic loadConfig():
  //   hasSandbox = !!(clientId && clientSecret)
  //   → thiếu client id/secret thì hasSandbox=false → "mock"
  //   → thiếu refresh token thì vẫn còn id+secret      → "sandbox"
  const expected: Record<string, "mock" | "sandbox"> = {
    AMAZON_LWA_CLIENT_ID: "mock",
    AMAZON_LWA_CLIENT_SECRET: "mock",
    AMAZON_LWA_REFRESH_TOKEN: "sandbox",
  };
  for (const [k, want] of Object.entries(expected)) {
    const env: Record<string, string> = { ...FULL_PROD_ENV };
    delete env[k];
    assert.equal(loadConfig(env).mode, want, `thiếu ${k} → kỳ vọng '${want}'`);
    assert.notEqual(
      loadConfig(env).mode,
      "production",
      `thiếu ${k} thì TUYỆT ĐỐI không được là production`,
    );
  }

  // Thiếu Supabase → sandbox (không ghi DB được)
  assert.equal(
    loadConfig({
      AMAZON_LWA_CLIENT_ID: "x",
      AMAZON_LWA_CLIENT_SECRET: "y",
      AMAZON_LWA_REFRESH_TOKEN: "z",
    }).mode,
    "sandbox",
  );

  // Chỉ có Supabase, không LWA → mock (đây đúng là cấu hình gây sự cố)
  const onlySb = loadConfig({
    NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "k",
  });
  assert.equal(onlySb.mode, "mock");
  assert.ok(onlySb.supabase, "supabase config vẫn có — chính vì vậy runner phải tự chặn");

  // Không có gì → mock
  assert.equal(loadConfig({}).mode, "mock");
});

test("loadConfig: SUPABASE_URL là fallback hợp lệ cho NEXT_PUBLIC_SUPABASE_URL", () => {
  const cfg = loadConfig({
    AMAZON_LWA_CLIENT_ID: "x",
    AMAZON_LWA_CLIENT_SECRET: "y",
    AMAZON_LWA_REFRESH_TOKEN: "z",
    SUPABASE_URL: "https://fallback.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "k",
  });
  assert.equal(cfg.mode, "production");
  assert.equal(cfg.supabase?.url, "https://fallback.supabase.co");
});
