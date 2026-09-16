/**
 * Test TÊN SHOP AMAZON (Sellers API v1 — `storeName`) — sự cố 16/09/2026:
 * "đã kết nối shop nhưng không hiển thị tên shop Amazon đã kéo về".
 *
 * Kiểm chứng 3 tầng, KHÔNG cần network:
 *   1. Parse: getMarketplaceParticipations có storeName → parseMarketplaces giữ lại,
 *      và PHÂN BIỆT tên shop (`storeName`) với tên sàn (`marketplace.name`).
 *   2. Gọi API: fetchStoreNamesWithToken đổi refresh token → access token rồi gọi
 *      /sellers/v1/marketplaceParticipations; lỗi được dịch thành câu hành động được.
 *   3. Chọn theo marketplace: shop US/CA có thể đặt tên khác nhau — không lấy tên
 *      của US gán cho CA.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  extractApiErrors,
  extractStoreNames,
  explainMissingStoreName,
  explainStoreNameFailure,
  fetchStoreNamesWithToken,
  spapiHostForRegion,
  storeNameOf,
} from "../../web/src/lib/spapi/shop-name.ts";
import {
  parseMarketplaces,
  storeNameForMarketplace,
  storeNameTable,
} from "../../web/src/lib/spapi/whoami.ts";

/** Payload THẬT theo mô hình sellers.json (US có tên, CA đặt tên khác). */
const PARTICIPATIONS = {
  payload: [
    {
      marketplace: {
        id: "ATVPDKIKX0DER",
        name: "Amazon.com",
        countryCode: "US",
        defaultCurrencyCode: "USD",
        defaultLanguageCode: "en_US",
        domainName: "www.amazon.com",
      },
      participation: { isParticipating: true, hasSuspendedListings: false },
      storeName: "VEXIM Store US",
    },
    {
      marketplace: {
        id: "A2EUQ1WTGCTBG2",
        name: "Amazon.ca",
        countryCode: "CA",
        defaultCurrencyCode: "CAD",
        defaultLanguageCode: "en_CA",
        domainName: "www.amazon.ca",
      },
      participation: { isParticipating: true, hasSuspendedListings: false },
      storeName: "  VEXIM Store   CA  ",
    },
  ],
};

/** fetch giả: định tuyến theo URL để kiểm chứng cả LWA lẫn SP-API. */
function fakeFetch(handlers: {
  lwa?: (init: RequestInit) => { status: number; body: string };
  spapi?: (url: string, init: RequestInit) => { status: number; body: string };
}): { fn: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const req = init ?? {};
    calls.push({ url, init: req });
    const r = url.includes("/auth/o2/token")
      ? (handlers.lwa ?? (() => ({ status: 200, body: JSON.stringify({ access_token: "Atza|token", expires_in: 3600 }) })))(req)
      : (handlers.spapi ?? (() => ({ status: 200, body: JSON.stringify(PARTICIPATIONS) })))(url, req);
    return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("1. parse giữ storeName và PHÂN BIỆT với tên sàn (marketplace.name)", () => {
  const list = parseMarketplaces(PARTICIPATIONS);
  assert.equal(list.length, 2);
  assert.equal(list[0].name, "Amazon.com", "name = tên SÀN, không phải tên shop");
  assert.equal(list[0].storeName, "VEXIM Store US");
  // khoảng trắng thừa bị chuẩn hoá
  assert.equal(list[1].storeName, "VEXIM Store CA");
  assert.equal(storeNameForMarketplace(list, "A2EUQ1WTGCTBG2"), "VEXIM Store CA");
  assert.equal(storeNameForMarketplace(list, "ATVPDKIKX0DER"), "VEXIM Store US");
  assert.equal(storeNameForMarketplace(list, "KHONG-CO"), null);
  assert.deepEqual(storeNameTable(list).map((r) => r.marketplaceId), [
    "ATVPDKIKX0DER",
    "A2EUQ1WTGCTBG2",
  ]);
});

test("2. thiếu storeName (token/app cũ) ⇒ null, KHÔNG lấy tên sàn thay thế", () => {
  const legacy = {
    payload: [
      {
        marketplace: {
          id: "ATVPDKIKX0DER",
          name: "Amazon.com",
          countryCode: "US",
          defaultCurrencyCode: "USD",
          domainName: "www.amazon.com",
        },
        participation: { isParticipating: true, hasSuspendedListings: false },
      },
      {
        marketplace: { id: "A1F83G8C2ARO7P", name: "Amazon.co.uk", countryCode: "GB" },
        participation: { isParticipating: true, hasSuspendedListings: false },
        storeName: "   ",
      },
    ],
  };
  const list = parseMarketplaces(legacy);
  assert.equal(list[0].storeName, null, "thiếu storeName ⇒ null (không bịa từ name)");
  assert.equal(list[1].storeName, null, "storeName toàn khoảng trắng ⇒ null");
  assert.deepEqual(extractStoreNames(legacy), [], "không có tên shop nào để lưu");
  assert.match(explainMissingStoreName().error, /không có storeName/i);
});

test("3. fetchStoreNamesWithToken: LWA → Sellers API, trả tên shop theo marketplace", async () => {
  const { fn, calls } = fakeFetch({});
  const r = await fetchStoreNamesWithToken({
    clientId: "amzn1.application-oa2-client.xxx",
    clientSecret: "secret",
    refreshToken: "Atzr|refresh",
    region: "NA",
    fetchFn: fn,
  });

  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.storeNames, [
    { marketplaceId: "ATVPDKIKX0DER", countryCode: "US", storeName: "VEXIM Store US", isSuspended: false },
    { marketplaceId: "A2EUQ1WTGCTBG2", countryCode: "CA", storeName: "VEXIM Store CA", isSuspended: false },
  ]);
  assert.equal(r.missingStoreName, false);

  // 1) LWA token endpoint: grant_type=refresh_token + token của shop
  assert.equal(calls[0].url, "https://api.amazon.com/auth/o2/token");
  const body = String(calls[0].init.body);
  assert.match(body, /grant_type=refresh_token/);
  assert.match(body, /refresh_token=Atzr%7Crefresh/);

  // 2) Sellers API đúng host vùng NA + header x-amz-access-token
  assert.equal(calls[1].url, "https://sellingpartnerapi-na.amazon.com/sellers/v1/marketplaceParticipations");
  const headers = calls[1].init.headers as Record<string, string>;
  assert.equal(headers["x-amz-access-token"], "Atza|token");
});

test("4. thiếu refresh token ⇒ KHÔNG gọi mạng, nêu đúng thứ còn thiếu", async () => {
  const { fn, calls } = fakeFetch({});
  const r = await fetchStoreNamesWithToken({
    clientId: "id",
    clientSecret: "secret",
    refreshToken: "   ",
    fetchFn: fn,
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /refresh token/i);
  assert.equal(calls.length, 0, "không tốn request nào khi thiếu token");
});

test("5. LWA invalid_grant ⇒ needsReauth + chỉ đúng việc phải làm (authorize lại)", async () => {
  const { fn } = fakeFetch({
    lwa: () => ({ status: 400, body: JSON.stringify({ error: "invalid_grant", error_description: "Refresh Token has been revoked" }) }),
  });
  const r = await fetchStoreNamesWithToken({
    clientId: "id",
    clientSecret: "secret",
    refreshToken: "Atzr|revoked",
    fetchFn: fn,
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.needsReauth, true);
  assert.match(r.error, /invalid_grant|không còn hiệu lực/i);
  assert.match(r.hint ?? "", /Kết nối lại/);
});

test("6. SP-API 403 khi đọc participations ⇒ hint nêu quyền app/test account", async () => {
  const { fn } = fakeFetch({
    spapi: () => ({
      status: 403,
      body: JSON.stringify({ errors: [{ code: "Unauthorized", message: "Access to requested resource is denied." }] }),
    }),
  });
  const r = await fetchStoreNamesWithToken({
    clientId: "id",
    clientSecret: "secret",
    refreshToken: "Atzr|ok",
    fetchFn: fn,
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.status, 403);
  assert.match(r.error, /403/);
  assert.match(r.hint ?? "", /Test Accounts|authorize/i);
  assert.deepEqual(r.apiErrors, ["Unauthorized — Access to requested resource is denied."]);
});

test("7. 200 nhưng thiếu storeName ⇒ ok + missingStoreName (lỗi ở phía Amazon/version)", async () => {
  const noStoreName = {
    payload: [
      {
        marketplace: { id: "ATVPDKIKX0DER", name: "Amazon.com", countryCode: "US" },
        participation: { isParticipating: true, hasSuspendedListings: false },
      },
    ],
  };
  const { fn } = fakeFetch({ spapi: () => ({ status: 200, body: JSON.stringify(noStoreName) }) });
  const r = await fetchStoreNamesWithToken({
    clientId: "id",
    clientSecret: "secret",
    refreshToken: "Atzr|ok",
    fetchFn: fn,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.missingStoreName, true);
  assert.deepEqual(r.storeNames, []);
  assert.equal(r.marketplaces.length, 1);
});

test("8. host theo vùng + storeNameOf + trích errors", () => {
  assert.equal(spapiHostForRegion("NA"), "sellingpartnerapi-na.amazon.com");
  assert.equal(spapiHostForRegion("eu"), "sellingpartnerapi-eu.amazon.com");
  assert.equal(spapiHostForRegion("FE"), "sellingpartnerapi-fe.amazon.com");
  assert.equal(spapiHostForRegion(null), "sellingpartnerapi-na.amazon.com");
  assert.equal(storeNameOf(PARTICIPATIONS, "ATVPDKIKX0DER"), "VEXIM Store US");
  assert.equal(storeNameOf(PARTICIPATIONS, "A2EUQ1WTGCTBG2"), "VEXIM Store CA");
  assert.equal(storeNameOf(PARTICIPATIONS, ""), null);
  assert.deepEqual(
    extractApiErrors({ errors: [{ code: "InvalidInput", message: "Invalid Input", details: "marketplace" }] }),
    ["InvalidInput — Invalid Input — marketplace"],
  );
  assert.deepEqual(extractApiErrors({ payload: [] }), []);
});

test("9. explainStoreNameFailure: 401/429/parse đều có câu trả lời cụ thể", () => {
  assert.match(explainStoreNameFailure({ stage: "spapi", status: 401 }).hint ?? "", /REGION|NA/);
  assert.match(explainStoreNameFailure({ stage: "spapi", status: 429 }).hint ?? "", /rate limit/i);
  assert.match(explainStoreNameFailure({ stage: "lwa", status: 400, body: "invalid_client" }).error, /CLIENT_ID/);
  assert.match(explainMissingStoreName().hint ?? "", /18\/12\/2024/);
});
