/**
 * Test tầng ĐỒNG BỘ TÊN SHOP AMAZON (web/src/lib/data/shop-names.ts).
 *
 * Trọng tâm là QUY TẮC AN TOÀN (đây là chỗ dễ ghi sai dữ liệu nhất):
 *   1. Mỗi shop gọi API bằng CHÍNH refresh token của shop đó — không mượn token
 *      shop khác (nếu mượn, tên shop A bị ghi cho shop B).
 *   2. Token self-authorization trong env CHỈ dùng khi seller_id trùng.
 *   3. Shop chưa authorize ⇒ báo "chưa có token", không gọi API, không ghi gì.
 *   4. Tên từng marketplace được ghi ĐÚNG dòng (US ≠ CA).
 *   5. Lỗi API/RPC ⇒ báo rõ, không nuốt thành "không có tên shop".
 *
 * Supabase + Amazon đều được giả lập bằng fetchFn inject — không cần network,
 * không cần credentials.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_SELF_SELLER_ID,
  isMissingRpcError,
  listShopCredentials,
  saveShopStoreName,
  syncShopStoreNames,
  syncStoreNamesWithFreshToken,
  type ShopCredential,
} from "../../web/src/lib/data/shop-names.ts";

const SUPABASE_URL = "https://proj.supabase.co";

type FetchCall = { url: string; init: RequestInit };

/** Thế giới giả: bảng seller_accounts + token, và Sellers API. */
function world(opts: {
  shops: ShopCredential[];
  participations?: Record<string, unknown>;
  lwaStatus?: number;
  lwaBody?: string;
  spapiStatus?: number;
  spapiBody?: string;
  saveStatus?: number;
  listRpcStatus?: number;
}) {
  const calls: FetchCall[] = [];
  const saved: { sellerAccountId: string; storeName: string; source: string }[] = [];
  const lwaTokens: string[] = [];

  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const req = init ?? {};
    calls.push({ url, init: req });

    // ---- Supabase RPC ----
    if (url.includes("/rest/v1/rpc/vexim_worker_list_shop_credentials")) {
      if (opts.listRpcStatus && opts.listRpcStatus >= 400) {
        return new Response(JSON.stringify({ message: "could not find function" }), {
          status: opts.listRpcStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return Response.json(
        opts.shops.map((s) => ({
          seller_account_id: s.sellerAccountId,
          seller_id: s.sellerId,
          marketplace: s.marketplace,
          display_name: s.displayName,
          store_name: s.storeName,
          shop_status: s.shopStatus,
          data_source: s.dataSource,
          has_token: s.hasToken,
          refresh_token: s.refreshToken,
          token_expires_at: s.tokenExpiresAt,
        })),
      );
    }
    if (url.includes("/rest/v1/rpc/vexim_worker_set_shop_store_name")) {
      if (opts.saveStatus && opts.saveStatus >= 400) {
        return new Response(JSON.stringify({ message: "permission denied" }), {
          status: opts.saveStatus,
          headers: { "content-type": "application/json" },
        });
      }
      const body = JSON.parse(String(req.body)) as {
        p_seller: string;
        p_store_name: string;
        p_source: string;
      };
      saved.push({
        sellerAccountId: body.p_seller,
        storeName: body.p_store_name,
        source: body.p_source,
      });
      return Response.json([{ id: body.p_seller, store_name: body.p_store_name, changed: true }]);
    }

    // ---- Amazon LWA ----
    if (url.includes("/auth/o2/token")) {
      const params = new URLSearchParams(String(req.body));
      lwaTokens.push(params.get("refresh_token") ?? "");
      if (opts.lwaStatus && opts.lwaStatus >= 400) {
        return new Response(opts.lwaBody ?? '{"error":"invalid_grant"}', { status: opts.lwaStatus });
      }
      return Response.json({ access_token: `Atza|${params.get("refresh_token")}`, expires_in: 3600 });
    }

    // ---- Amazon SP-API ----
    if (url.includes("marketplaceParticipations")) {
      if (opts.spapiStatus && opts.spapiStatus >= 400) {
        return new Response(opts.spapiBody ?? '{"errors":[{"code":"Unauthorized"}]}', {
          status: opts.spapiStatus,
        });
      }
      return Response.json(
        opts.participations ?? {
          payload: [
            {
              marketplace: { id: "ATVPDKIKX0DER", name: "Amazon.com", countryCode: "US" },
              participation: { isParticipating: true, hasSuspendedListings: false },
              storeName: "VEXIM Store US",
            },
            {
              marketplace: { id: "A2EUQ1WTGCTBG2", name: "Amazon.ca", countryCode: "CA" },
              participation: { isParticipating: true, hasSuspendedListings: false },
              storeName: "VEXIM Store CA",
            },
          ],
        },
      );
    }

    throw new Error(`URL không mong đợi trong test: ${url}`);
  }) as unknown as typeof fetch;

  return { fn, calls, saved, lwaTokens };
}

function shop(over: Partial<ShopCredential>): ShopCredential {
  return {
    sellerAccountId: "acc-1",
    sellerId: "AQMVYI4HJTI4C",
    marketplace: "ATVPDKIKX0DER",
    displayName: "VEXIM US - Chính",
    storeName: null,
    shopStatus: "active",
    dataSource: "production",
    hasToken: true,
    refreshToken: "Atzr|shop-us",
    tokenExpiresAt: null,
    ...over,
  };
}

function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const before = { ...process.env };
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    AMAZON_LWA_CLIENT_ID: "client-id",
    AMAZON_LWA_CLIENT_SECRET: "client-secret",
    ...env,
  });
  return run().finally(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in before)) delete process.env[k];
    }
    Object.assign(process.env, before);
  });
}

test("1. shop có token: gọi Participations bằng CHÍNH token shop, lưu tên theo từng marketplace", async () => {
  const w = world({
    shops: [
      shop({ sellerAccountId: "acc-us", marketplace: "ATVPDKIKX0DER", refreshToken: "Atzr|token-us" }),
      shop({ sellerAccountId: "acc-ca", marketplace: "A2EUQ1WTGCTBG2", refreshToken: "Atzr|token-us" }),
    ],
  });

  const r = await withEnv({}, () => syncShopStoreNames({ fetchFn: w.fn, region: "NA" }));

  assert.equal(r.updated, 2);
  assert.equal(r.failed, 0);
  assert.equal(r.skipped, 0);
  assert.deepEqual(
    r.rows.map((x) => [x.sellerAccountId, x.storeName, x.status, x.tokenSource]),
    [
      ["acc-us", "VEXIM Store US", "updated", "shop-token"],
      ["acc-ca", "VEXIM Store CA", "updated", "shop-token"],
    ],
    "US và CA nhận ĐÚNG tên của từng marketplace",
  );
  assert.deepEqual(w.saved.map((s) => [s.sellerAccountId, s.storeName]), [
    ["acc-us", "VEXIM Store US"],
    ["acc-ca", "VEXIM Store CA"],
  ]);
  assert.equal(w.lwaTokens[0], "Atzr|token-us", "dùng token của shop, không phải token khác");
  // 1 lần gọi LWA + 1 lần Participations cho CẢ seller (không gọi 2 lần)
  assert.equal(w.calls.filter((c) => c.url.includes("/auth/o2/token")).length, 1);
  assert.equal(w.calls.filter((c) => c.url.includes("marketplaceParticipations")).length, 1);
});

test("2. shop CHƯA authorize ⇒ skipped, KHÔNG gọi Amazon, KHÔNG ghi DB", async () => {
  const w = world({
    shops: [
      shop({ sellerAccountId: "acc-us", hasToken: true, refreshToken: "Atzr|token-us" }),
      shop({
        sellerAccountId: "acc-new",
        sellerId: "AOTHERSELLER",
        marketplace: "A1AM78C64UM0Y8",
        displayName: "Shop mới - MX",
        hasToken: false,
        refreshToken: null,
      }),
    ],
  });

  const r = await withEnv({ AMAZON_SELF_SELLER_ID: DEFAULT_SELF_SELLER_ID }, () =>
    syncShopStoreNames({ fetchFn: w.fn, region: "NA" }),
  );

  assert.equal(r.updated, 1);
  assert.equal(r.skipped, 1);
  const skipped = r.rows.find((x) => x.sellerAccountId === "acc-new");
  assert.equal(skipped?.status, "skipped_no_token");
  assert.equal(skipped?.tokenSource, "none");
  assert.match(skipped?.message ?? "", /chưa authorize|Kết nối/i);
  assert.deepEqual(w.saved.map((s) => s.sellerAccountId), ["acc-us"], "không ghi gì cho shop chưa có token");
  // Không hề gọi Amazon cho seller chưa có token (chỉ 1 LWA + 1 participations cho seller kia)
  assert.equal(w.calls.filter((c) => c.url.includes("/auth/o2/token")).length, 1);
});

test("3. token env CHỈ dùng khi seller_id trùng (self-authorization)", async () => {
  const w = world({
    shops: [
      shop({ sellerAccountId: "acc-prod", hasToken: false, refreshToken: null }),
      shop({
        sellerAccountId: "acc-other",
        sellerId: "AOTHERSELLER",
        hasToken: false,
        refreshToken: null,
      }),
    ],
  });

  const r = await withEnv(
    { AMAZON_LWA_REFRESH_TOKEN: "Atzr|env", AMAZON_SELF_SELLER_ID: DEFAULT_SELF_SELLER_ID },
    () => syncShopStoreNames({ fetchFn: w.fn, region: "NA" }),
  );

  const prod = r.rows.find((x) => x.sellerAccountId === "acc-prod");
  const other = r.rows.find((x) => x.sellerAccountId === "acc-other");
  assert.equal(prod?.tokenSource, "env-token");
  assert.equal(prod?.storeName, "VEXIM Store US");
  assert.equal(other?.status, "skipped_no_token", "seller khác KHÔNG được mượn token env");
  assert.deepEqual(w.lwaTokens, ["Atzr|env"]);
});

test("4. mỗi seller dùng token riêng — không lẫn tên shop giữa 2 seller", async () => {
  const w = world({
    shops: [
      shop({ sellerAccountId: "acc-a", sellerId: "ASELLERA", marketplace: "ATVPDKIKX0DER" }),
      shop({
        sellerAccountId: "acc-b",
        sellerId: "ASELLERB",
        marketplace: "ATVPDKIKX0DER",
        refreshToken: "Atzr|token-b",
      }),
    ],
  });

  await withEnv({}, () => syncShopStoreNames({ fetchFn: w.fn, region: "NA" }));

  assert.deepEqual(w.lwaTokens.sort(), ["Atzr|shop-us", "Atzr|token-b"].sort());
  // 2 seller ⇒ 2 lần gọi participations (không gộp nhầm)
  assert.equal(w.calls.filter((c) => c.url.includes("marketplaceParticipations")).length, 2);
});

test("5. token hỏng (invalid_grant) ⇒ error + nhắc authorize lại, KHÔNG ghi tên rỗng", async () => {
  const w = world({
    shops: [shop({ sellerAccountId: "acc-us", storeName: "Tên cũ giữ nguyên" })],
    lwaStatus: 400,
    lwaBody: JSON.stringify({ error: "invalid_grant" }),
  });

  const r = await withEnv({}, () => syncShopStoreNames({ fetchFn: w.fn, region: "NA" }));

  assert.equal(r.ok, false);
  assert.equal(r.failed, 1);
  assert.deepEqual(w.saved, [], "không ghi gì khi token hỏng");
  const row = r.rows[0];
  assert.equal(row.status, "error");
  assert.equal(row.previousStoreName, "Tên cũ giữ nguyên");
  assert.match(row.message, /Kết nối lại/);
});

test("6. SP-API 403 ⇒ error kèm nguyên nhân, không ghi DB", async () => {
  const w = world({ shops: [shop({})], spapiStatus: 403 });
  const r = await withEnv({}, () => syncShopStoreNames({ fetchFn: w.fn, region: "NA" }));
  assert.equal(r.failed, 1);
  assert.match(r.rows[0].message, /403/);
  assert.match(r.rows[0].message, /Test Accounts|authorize/i);
  assert.deepEqual(w.saved, []);
});

test("7. Amazon 200 nhưng thiếu storeName ⇒ status missing (nói rõ field có từ 18/12/2024)", async () => {
  const w = world({
    shops: [shop({})],
    participations: {
      payload: [
        {
          marketplace: { id: "ATVPDKIKX0DER", name: "Amazon.com", countryCode: "US" },
          participation: { isParticipating: true, hasSuspendedListings: false },
        },
      ],
    },
  });
  const r = await withEnv({}, () => syncShopStoreNames({ fetchFn: w.fn, region: "NA" }));
  assert.equal(r.missing, 1);
  assert.equal(r.rows[0].status, "missing");
  assert.match(r.rows[0].message, /18\/12\/2024/);
  assert.deepEqual(w.saved, []);
});

test("8. RPC lưu lỗi ⇒ error nêu tên tên đọc được nhưng không lưu được", async () => {
  const w = world({ shops: [shop({})], saveStatus: 403 });
  const r = await withEnv({}, () => syncShopStoreNames({ fetchFn: w.fn, region: "NA" }));
  assert.equal(r.failed, 1);
  assert.match(r.rows[0].message, /KHÔNG lưu được/);
  assert.match(r.rows[0].message, /VEXIM Store US/);
});

test("9. syncStoreNamesWithFreshToken: chỉ áp cho seller vừa authorize", async () => {
  const w = world({
    shops: [
      shop({ sellerAccountId: "acc-a", sellerId: "ASELLERA", marketplace: "ATVPDKIKX0DER" }),
      shop({
        sellerAccountId: "acc-b",
        sellerId: "ASELLERB",
        marketplace: "ATVPDKIKX0DER",
        hasToken: false,
        refreshToken: null,
      }),
    ],
  });

  const r = await withEnv({}, () =>
    syncStoreNamesWithFreshToken({
      sellerId: "ASELLERA",
      refreshToken: "Atzr|fresh-a",
      fetchFn: w.fn,
      region: "NA",
    }),
  );

  assert.equal(r.rows.length, 1, "chỉ đụng tới shop của seller vừa authorize");
  assert.equal(r.rows[0].sellerAccountId, "acc-a");
  assert.equal(r.rows[0].storeName, "VEXIM Store US");
  assert.deepEqual(w.lwaTokens, ["Atzr|fresh-a"], "dùng đúng token vừa đổi được");
  assert.equal(w.saved.length, 1);
});

test("10. đọc helper: listShopCredentials map snake_case, saveShopStoreName bỏ tên rỗng", async () => {
  const w = world({ shops: [shop({ sellerAccountId: "acc-us", storeName: "Tên cũ" })] });
  await withEnv({}, async () => {
    const listed = await listShopCredentials({ fetchFn: w.fn });
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    assert.deepEqual(listed.shops[0], {
      sellerAccountId: "acc-us",
      sellerId: "AQMVYI4HJTI4C",
      marketplace: "ATVPDKIKX0DER",
      displayName: "VEXIM US - Chính",
      storeName: "Tên cũ",
      shopStatus: "active",
      dataSource: "production",
      hasToken: true,
      refreshToken: "Atzr|shop-us",
      tokenExpiresAt: null,
    });

    const blank = await saveShopStoreName({
      sellerAccountId: "acc-us",
      storeName: "   ",
      fetchFn: w.fn,
    });
    assert.equal(blank.ok, false, "không ghi tên rỗng (không xoá tên cũ)");
    assert.deepEqual(w.saved, []);
  });
});

test("11. isMissingRpcError nhận diện đúng lúc chưa chạy migration 0031", () => {
  assert.equal(isMissingRpcError("Could not find the function public.vexim_worker_list_shop_credentials", 404), true);
  assert.equal(isMissingRpcError("PGRST202", null), true);
  assert.equal(isMissingRpcError("permission denied for function", 403), false);
});

test("12. chưa cấu hình Supabase ⇒ báo rõ, không throw", async () => {
  const w = world({ shops: [shop({})] });
  const before = { ...process.env };
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const r = await syncShopStoreNames({ fetchFn: w.fn });
    assert.equal(r.ok, false);
    assert.match(r.message, /Không đọc được danh sách shop/);
    assert.match(r.message, /SUPABASE_SERVICE_ROLE_KEY/);
  } finally {
    Object.assign(process.env, before);
  }
});
