/**
 * Test MODULE 0 — THÊM / XOÁ SHOP (nút [+ Thêm shop mới] và [Xoá], migration 0032).
 *
 * Khoá những luật dễ sai nhất:
 *   1. Kiểm tra dữ liệu ở model dùng CHUNG cho client (form) và server (action):
 *      tên bắt buộc, marketplace phải thuộc danh sách, seller ID để trống được.
 *   2. Tạo shop: KHÔNG tạo khi dữ liệu sai (không gọi RPC); RPC trả `created=false`
 *      ⇒ UI báo "đã có trong hệ thống", không phải lỗi.
 *   3. Xoá shop: gọi lần đầu (force=false) KHÔNG xoá gì — chỉ đếm dữ liệu phụ
 *      thuộc; chỉ xoá khi force=true. Câu tóm tắt dữ liệu phải đọc được.
 *   4. Lỗi hạ tầng (chưa chạy 0032 / sai key) ⇒ nói đích danh việc cần làm.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SHOP_MARKETPLACES,
  marketplaceOptionLabel,
  validateNewShop,
} from "../src/lib/data/shop-admin-model.ts";
import {
  claimShopSellerId,
  createShop,
  deleteShop,
  describeDependents,
} from "../src/lib/data/shop-admin.ts";

function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const before = { ...process.env };
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://proj.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    ...env,
  });
  return run().finally(() => {
    for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
    Object.assign(process.env, before);
  });
}

/** fetch giả cho PostgREST RPC. */
function rpcFetch(handlers: Record<string, (body: Record<string, unknown>) => { status: number; body: unknown }>) {
  const calls: { fn: string; body: Record<string, unknown> }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const name = url.split("/rest/v1/rpc/")[1] ?? "";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ fn: name, body });
    const handler = handlers[name];
    if (!handler) return new Response(JSON.stringify({ message: `no handler for ${name}` }), { status: 404 });
    const r = handler(body);
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("1. validateNewShop: luật dùng chung form + server", () => {
  const ok = validateNewShop({ displayName: "  VEXIM US   - Chính ", marketplace: "ATVPDKIKX0DER", sellerId: "aqmvyi4hjti4c" });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.displayName, "VEXIM US - Chính", "gộp khoảng trắng thừa");
  assert.equal(ok.value.sellerId, "AQMVYI4HJTI4C", "seller id chuẩn hoá chữ HOA");

  const noName = validateNewShop({ displayName: "   ", marketplace: "ATVPDKIKX0DER" });
  assert.equal(noName.ok, false);
  assert.match(noName.errors.displayName ?? "", /tên gọi nội bộ/i);

  const noMp = validateNewShop({ displayName: "Shop A", marketplace: "" });
  assert.equal(noMp.ok, false);
  assert.match(noMp.errors.marketplace ?? "", /marketplace/i);

  const badMp = validateNewShop({ displayName: "Shop A", marketplace: "KHONG-CO" });
  assert.equal(badMp.ok, false);
  assert.match(badMp.errors.marketplace ?? "", /không nằm trong danh sách/i);

  // seller id để trống = hợp lệ (Amazon trả ở bước authorize)
  const blankSeller = validateNewShop({ displayName: "Shop khách A", marketplace: "A2EUQ1WTGCTBG2", sellerId: "" });
  assert.equal(blankSeller.ok, true);
  assert.equal(blankSeller.value.sellerId, null);

  // seller id sai định dạng ⇒ báo lỗi, KHÔNG gửi lên server
  const badSeller = validateNewShop({ displayName: "Shop A", marketplace: "ATVPDKIKX0DER", sellerId: "ABC-12" });
  assert.equal(badSeller.ok, false);
  assert.match(badSeller.errors.sellerId ?? "", /chữ và số/i);

  const long = validateNewShop({ displayName: "x".repeat(121), marketplace: "ATVPDKIKX0DER" });
  assert.equal(long.ok, false);
  assert.match(long.errors.displayName ?? "", /120/);
});

test("2. Danh sách marketplace cho form: có US + CA, nhãn kèm cờ", () => {
  const ids = SHOP_MARKETPLACES.map((m) => m.id);
  assert.ok(ids.includes("ATVPDKIKX0DER") && ids.includes("A2EUQ1WTGCTBG2"));
  assert.equal(marketplaceOptionLabel("ATVPDKIKX0DER"), "🇺🇸 US · Hoa Kỳ");
  // marketplace lạ: trả nguyên id, không bịa tên
  assert.equal(marketplaceOptionLabel("AZZZZ"), "AZZZZ");
});

test("3. createShop: hợp lệ ⇒ gọi RPC đúng tham số, shop mới ở trạng thái paused", async () => {
  const w = rpcFetch({
    vexim_admin_create_shop: (body) => {
      assert.equal(body.p_display_name, "VEXIM US - Mới");
      assert.equal(body.p_marketplace, "ATVPDKIKX0DER");
      assert.equal(body.p_seller_id, null, "để trống seller id ⇒ gửi null");
      assert.equal(body.p_data_source, "production");
      return {
        status: 200,
        body: [
          {
            seller_account_id: "11111111-1111-4111-8111-111111111111",
            display_name: "VEXIM US - Mới",
            marketplace: "ATVPDKIKX0DER",
            seller_id: null,
            status: "paused",
            data_source: "production",
            created: true,
          },
        ],
      };
    },
  });

  const res = await withEnv({}, () =>
    createShop({ displayName: "VEXIM US - Mới", marketplace: "ATVPDKIKX0DER" }, { fetchFn: w.fn }),
  );

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.shop.created, true);
  assert.equal(res.shop.status, "paused", "shop mới KHÔNG đồng bộ cho tới khi kết nối");
  assert.equal(res.shop.sellerId, null);
  assert.equal(w.calls.length, 1);
});

test("4. createShop: dữ liệu sai ⇒ KHÔNG gọi RPC (không tạo rác trong DB)", async () => {
  const w = rpcFetch({});
  const res = await withEnv({}, () =>
    createShop({ displayName: "", marketplace: "ATVPDKIKX0DER" }, { fetchFn: w.fn }),
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.ok(res.fieldErrors.displayName);
  assert.equal(w.calls.length, 0, "chưa qua validate thì không tốn request nào");
});

test("5. createShop: shop đã tồn tại ⇒ created=false (không phải lỗi)", async () => {
  const w = rpcFetch({
    vexim_admin_create_shop: () => ({
      status: 200,
      body: [
        {
          seller_account_id: "22222222-2222-4222-8222-222222222222",
          display_name: "VEXIM US - Chính",
          marketplace: "ATVPDKIKX0DER",
          seller_id: "AQMVYI4HJTI4C",
          status: "active",
          data_source: "production",
          created: false,
        },
      ],
    }),
  });
  const res = await withEnv({}, () =>
    createShop({ displayName: "VEXIM US - Chính", marketplace: "ATVPDKIKX0DER", sellerId: "AQMVYI4HJTI4C" }, { fetchFn: w.fn }),
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.shop.created, false);
  assert.equal(res.shop.sellerId, "AQMVYI4HJTI4C");
});

test("6. createShop: chưa chạy migration 0032 ⇒ hint chỉ đúng file cần chạy", async () => {
  const w = rpcFetch({
    vexim_admin_create_shop: () => ({
      status: 404,
      body: { message: "Could not find the function public.vexim_admin_create_shop" },
    }),
  });
  const res = await withEnv({}, () =>
    createShop({ displayName: "Shop A", marketplace: "ATVPDKIKX0DER" }, { fetchFn: w.fn }),
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.hint ?? "", /0032_shop_admin\.sql/);
});

test("7. deleteShop: lần đầu CHỈ đếm dữ liệu (force=false), chưa xoá", async () => {
  const w = rpcFetch({
    vexim_admin_delete_shop: (body) => {
      assert.equal(body.p_force, false);
      return {
        status: 200,
        body: [
          {
            deleted: false,
            requires_force: true,
            shop: "VEXIM US - Chính",
            summary: { "sales.orders": 128, "catalog.listings": 42, "connections.oauth_tokens": 1 },
            message: "Shop đang có refresh token (đã kết nối) — xoá sẽ mất kết nối...",
          },
        ],
      };
    },
  });

  const res = await withEnv({}, () => deleteShop({ sellerAccountId: "abc", fetchFn: w.fn }));
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.deleted, false, "chưa xoá gì ở bước 1");
  assert.equal(res.requiresForce, true);
  assert.deepEqual(res.dependents, { "sales.orders": 128, "catalog.listings": 42, "connections.oauth_tokens": 1 });
});

test("8. deleteShop: force=true mới xoá thật", async () => {
  const w = rpcFetch({
    vexim_admin_delete_shop: (body) => {
      assert.equal(body.p_force, true);
      assert.equal(body.p_seller_account_id, "abc");
      return {
        status: 200,
        body: [{ deleted: true, requires_force: false, shop: "Shop A", summary: {}, message: 'Đã xoá shop "Shop A".' }],
      };
    },
  });
  const res = await withEnv({}, () => deleteShop({ sellerAccountId: "abc", force: true, fetchFn: w.fn }));
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.deleted, true);
  assert.match(res.message, /Đã xoá shop/);
});

test("9. deleteShop: thiếu id ⇒ không gọi RPC; lỗi 403 ⇒ nói rõ chỉ admin", async () => {
  const empty = rpcFetch({});
  const res1 = await withEnv({}, () => deleteShop({ sellerAccountId: "  ", fetchFn: empty.fn }));
  assert.equal(res1.ok, false);
  assert.equal(empty.calls.length, 0);

  const forbidden = rpcFetch({
    vexim_admin_delete_shop: () => ({
      status: 403,
      body: { message: "Chỉ quản trị viên (super_admin/org_admin) được xoá shop" },
    }),
  });
  const res2 = await withEnv({}, () => deleteShop({ sellerAccountId: "abc", fetchFn: forbidden.fn }));
  assert.equal(res2.ok, false);
  if (res2.ok) return;
  assert.match(res2.error, /quản trị viên/i);
});

test("10. describeDependents: đọc được, sắp xếp theo số lượng, có câu cho shop trống", () => {
  assert.match(
    describeDependents({ "catalog.listings": 42, "sales.orders": 128 }),
    /^orders: 128 · listings: 42$/,
  );
  assert.match(describeDependents({}), /Không có dữ liệu/);
});

test("11. claimShopSellerId: khớp / lệch / điền mới (callback OAuth)", async () => {
  const matched = rpcFetch({
    vexim_worker_claim_shop_seller_id: () => ({
      status: 200,
      body: [{ seller_account_id: "s1", seller_id: "AQMVYI4HJTI4C", matches: true, adopted: false, message: "Seller ID khớp shop đã khai." }],
    }),
  });
  const r1 = await withEnv({}, () =>
    claimShopSellerId({ sellerAccountId: "s1", sellerIdFromAmazon: "AQMVYI4HJTI4C", fetchFn: matched.fn }),
  );
  assert.equal(r1.ok, true);
  assert.equal(r1.matches, true);
  assert.equal(r1.adopted, false);

  const adopted = rpcFetch({
    vexim_worker_claim_shop_seller_id: () => ({
      status: 200,
      body: [{ seller_account_id: "s2", seller_id: "A2NEWSELLER", matches: true, adopted: true, message: "Đã nhận seller id thật." }],
    }),
  });
  const r2 = await withEnv({}, () =>
    claimShopSellerId({ sellerAccountId: "s2", sellerIdFromAmazon: "A2NEWSELLER", fetchFn: adopted.fn }),
  );
  assert.equal(r2.matches, true);
  assert.equal(r2.adopted, true);

  const mismatch = rpcFetch({
    vexim_worker_claim_shop_seller_id: () => ({
      status: 200,
      body: [{ seller_account_id: "s3", seller_id: "AOTHER", matches: false, adopted: false, message: "Bạn vừa authorize shop KHÁC." }],
    }),
  });
  const r3 = await withEnv({}, () =>
    claimShopSellerId({ sellerAccountId: "s3", sellerIdFromAmazon: "AOTHER", fetchFn: mismatch.fn }),
  );
  assert.equal(r3.matches, false, "callback phải từ chối lưu token khi matches=false");
  assert.match(r3.message, /authorize shop KHÁC/);
});
