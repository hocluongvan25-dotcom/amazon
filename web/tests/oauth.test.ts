/**
 * Test Module 0 — OAuth & multi-tenant (lib/oauth).
 *
 * Năm thứ phải khoá bằng test, vì sai một cái là MẤT QUYỀN TRUY CẬP DỮ LIỆU shop
 * hoặc LỘ refresh token:
 *   1. Refresh token xuống DB PHẢI ở dạng enc:v1: (AES-256-GCM). Plaintext/Atzr…
 *      bị từ chối ở cả tầng app lẫn RPC 0020; sai khoá → lỗi rõ ràng, KHÔNG trả rác.
 *   2. `state` có chữ ký HMAC + TTL: sửa shop/service trong state là fail, hết hạn
 *      là fail, dùng lại (replay) do DB chặn (đã test ở harness 0020).
 *   3. Endpoint THEO VÙNG (NA/EU/FE) và theo SERVICE: SP-API → trang consent của
 *      Seller Central (nhận `spapi_oauth_code`), Ads → LWA /ap/oa (nhận `code`).
 *      Nhận sai tên tham số = mất token của chủ shop.
 *   4. Lỗi LWA phải dịch ra HÀNH ĐỘNG (invalid_grant → cần Re-authorize, 429 →
 *      không retry dồn, unauthorized_client → redirect_uri chưa khớp).
 *   5. Hợp đồng cột với migration 0020: chuỗi select `vexim_connections` và ánh xạ
 *      snake_case → camelCase của 3 RPC. Sai là PGRST204/sập trang.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ADS_SCOPE,
  OAuthStoreError,
  SPAPI_SCOPE,
  TokenCryptoError,
  asAmazonRegion,
  buildAuthorizeUrl,
  buildStartLink,
  createOAuthStore,
  createState,
  decryptToken,
  describeLwaFailure,
  encryptToken,
  exchangeAuthorizationCode,
  isEncryptedToken,
  loadOAuthConfig,
  looksLikePlainRefreshToken,
  pickAuthorizationCode,
  readState,
  refreshAccessToken,
  requireOAuthConfig,
  resolveBaseUrl,
  resolveRedirectUri,
  safeEqual,
  sanitizeRedirect,
  startLinkSignature,
  tokenEndpoint,
  verifyStartLinkSignature,
} from "../src/lib/oauth/index.ts";

const KEY = "0".repeat(64); // 64 hex = 32 byte
const SECRET = "state-secret-demo-0020";
const SHOP = "11111111-2222-3333-4444-555555555555";

// ============================================================================
// 1. Mã hoá refresh token
// ============================================================================
test("encryptToken sinh đúng định dạng enc:v1: và giải mã ngược lại", () => {
  const plain = "Atzr|IwEBIJ-neu-demo-refresh-token";
  const enc = encryptToken(plain, KEY);
  assert.ok(enc.startsWith("enc:v1:"), `thiếu tiền tố: ${enc.slice(0, 12)}`);
  assert.ok(isEncryptedToken(enc));
  assert.ok(!enc.includes("Atzr"), "bản mã hoá KHÔNG được chứa plaintext");
  assert.equal(decryptToken(enc, KEY), plain);
});

test("cùng một token mã hoá 2 lần ra 2 bản KHÁC nhau (iv ngẫu nhiên)", () => {
  const plain = "Atzr|same-token";
  const a = encryptToken(plain, KEY);
  const b = encryptToken(plain, KEY);
  assert.notEqual(a, b, "iv trùng nhau → lộ thông tin (cùng token cho ra cùng ciphertext)");
  assert.equal(decryptToken(a, KEY), plain);
  assert.equal(decryptToken(b, KEY), plain);
});

test("sai khoá → TokenCryptoError decrypt_failed, không trả chuỗi rác", () => {
  const enc = encryptToken("Atzr|secret", KEY);
  assert.throws(
    () => decryptToken(enc, "f".repeat(64)),
    (e: unknown) => e instanceof TokenCryptoError && e.code === "decrypt_failed",
  );
});

test("sửa 1 byte trong bản mã hoá → GCM phát hiện (decrypt_failed)", () => {
  const enc = encryptToken("Atzr|secret", KEY);
  const body = enc.slice("enc:v1:".length);
  const flipped = (body[body.length - 1] === "A" ? "B" : "A") + body.slice(1);
  assert.throws(
    () => decryptToken(`enc:v1:${flipped}`, KEY),
    (e: unknown) => e instanceof TokenCryptoError && e.code === "decrypt_failed",
  );
});

test("từ chối plaintext: chuỗi Atzr… không tiền tố → bad_payload", () => {
  assert.ok(looksLikePlainRefreshToken("Atzr|IwEBI..."));
  assert.ok(looksLikePlainRefreshToken("Atza|IwEBI..."));
  assert.ok(!looksLikePlainRefreshToken("enc:v1:abc"));
  assert.throws(
    () => decryptToken("Atzr|IwEBI-plaintext", KEY),
    (e: unknown) => e instanceof TokenCryptoError && e.code === "bad_payload",
  );
});

test("thiếu khoá → missing_key kèm lệnh sinh khoá (fail-closed, không 'tiện thể' bỏ qua)", () => {
  assert.throws(
    () => encryptToken("Atzr|x", "   "),
    (e: unknown) =>
      e instanceof TokenCryptoError &&
      e.code === "missing_key" &&
      e.message.includes("randomBytes(32)"),
  );
});

test("khoá nhận cả hex 64 ký tự, base64 32 byte và passphrase (SHA-256)", () => {
  const plain = "Atzr|multi-format";
  const passphrase = "vexim-demo-passphrase";
  const b64 = Buffer.alloc(32, 7).toString("base64");
  for (const key of [KEY, b64, passphrase]) {
    assert.equal(decryptToken(encryptToken(plain, key), key), plain, `khoá ${key.slice(0, 8)}…`);
  }
  // đổi khoá là KHÔNG đọc được bản cũ (không có "khoá vạn năng")
  assert.throws(() => decryptToken(encryptToken(plain, passphrase), b64));
});

test("safeEqual so khớp không lộ độ dài", () => {
  assert.ok(safeEqual("abc", "abc"));
  assert.ok(!safeEqual("abc", "abd"));
  assert.ok(!safeEqual("abc", "ab"));
  assert.ok(!safeEqual("", "x"));
});

// ============================================================================
// 2. state — chữ ký HMAC + TTL
// ============================================================================
test("createState/readState giữ đúng service + shop + redirect", () => {
  const state = createState({ service: "ads", shop: SHOP, redirect: "/ppc" }, SECRET);
  const read = readState(state, SECRET);
  assert.ok(read.ok);
  if (!read.ok) return;
  assert.equal(read.claims.service, "ads");
  assert.equal(read.claims.shop, SHOP);
  assert.equal(read.claims.redirect, "/ppc");
  assert.ok(read.claims.nonce.length >= 16);
  assert.ok(read.claims.exp > read.claims.iat);
});

test("sửa shop trong state → bad_signature (không cho gắn token vào shop khác)", () => {
  const state = createState({ service: "ads", shop: SHOP }, SECRET);
  const [payload, sig] = state.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { shop: string };
  claims.shop = "99999999-9999-4999-8999-999999999999";
  const forged = `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${sig}`;
  const read = readState(forged, SECRET);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.reason, "bad_signature");
});

test("state ký bằng secret khác → bad_signature; hết TTL → expired", () => {
  const state = createState({ service: "spapi", shop: SHOP }, SECRET);
  const wrong = readState(state, "other-secret");
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.reason, "bad_signature");

  const now = Date.now();
  const expired = readState(state, SECRET, { now: now + 11 * 60 * 1000 });
  assert.equal(expired.ok, false);
  if (!expired.ok) {
    assert.equal(expired.reason, "expired");
    assert.match(expired.detail, /hết hạn/);
  }
  // còn trong TTL thì vẫn ok
  assert.ok(readState(state, SECRET, { now: now + 9 * 60 * 1000 }).ok);
});

test("state rác → malformed, không ném lỗi", () => {
  for (const bad of ["", "abc", "abc.", ".abc", "a.b", Buffer.from("{}").toString("base64url") + ".x"]) {
    const read = readState(bad, SECRET);
    assert.equal(read.ok, false, `chuỗi "${bad}" phải bị từ chối`);
  }
});

test("sanitizeRedirect chỉ nhận path nội bộ (chặn open-redirect)", () => {
  assert.equal(sanitizeRedirect("/module0/connect"), "/module0/connect");
  assert.equal(sanitizeRedirect("  /ppc?tab=1  "), "/ppc?tab=1");
  for (const bad of [
    "https://evil.example/x",
    "//evil.example/x",
    "/\\evil.example",
    "http://localhost/x",
    "",
    null,
  ]) {
    assert.equal(sanitizeRedirect(bad as string | null), undefined, `phải chặn: ${String(bad)}`);
  }
});

test("state không mang được redirect ngoài app", () => {
  const state = createState(
    { service: "ads", shop: SHOP, redirect: "https://evil.example/steal" },
    SECRET,
  );
  const read = readState(state, SECRET);
  assert.ok(read.ok);
  if (read.ok) assert.equal(read.claims.redirect, undefined);
});

// ============================================================================
// 3. Link authorize theo service + region
// ============================================================================
test("SP-API có application_id → trang consent Seller Central, callback là spapi_oauth_code", () => {
  const { url, flow } = buildAuthorizeUrl({
    service: "spapi",
    region: "NA",
    clientId: "amzn1.application-oa2-client.demo",
    redirectUri: "https://ops.vexim.vn/api/amazon/oauth/callback",
    state: "state-1",
    applicationId: "amzn1.sp.solution.demo",
  });
  assert.equal(flow, "seller_central_consent");
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://sellercentral.amazon.com/apps/authorize/consent");
  assert.equal(u.searchParams.get("application_id"), "amzn1.sp.solution.demo");
  assert.equal(u.searchParams.get("version"), "beta");
  assert.equal(u.searchParams.get("state"), "state-1");
  assert.equal(u.searchParams.get("redirect_uri"), "https://ops.vexim.vn/api/amazon/oauth/callback");
});

test("SP-API không có application_id → rơi về LWA /ap/oa với scope sellingpartnerapi::all", () => {
  const { url, flow } = buildAuthorizeUrl({
    service: "spapi",
    region: "NA",
    clientId: "amzn1.application-oa2-client.demo",
    redirectUri: "https://ops.vexim.vn/cb",
    state: "s",
  });
  assert.equal(flow, "lwa");
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://www.amazon.com/ap/oa");
  assert.equal(u.searchParams.get("scope"), SPAPI_SCOPE);
  assert.equal(u.searchParams.get("response_type"), "code");
});

test("Ads → LWA /ap/oa với scope ads::campaign_management, endpoint theo vùng", () => {
  const na = new URL(
    buildAuthorizeUrl({
      service: "ads",
      region: "NA",
      clientId: "ads-client",
      redirectUri: "https://ops.vexim.vn/cb",
      state: "s",
    }).url,
  );
  assert.equal(na.origin, "https://www.amazon.com");
  assert.equal(na.searchParams.get("scope"), ADS_SCOPE);
  assert.equal(na.searchParams.get("client_id"), "ads-client");

  const eu = new URL(
    buildAuthorizeUrl({
      service: "ads",
      region: "EU",
      clientId: "ads-client",
      redirectUri: "https://ops.vexim.vn/cb",
      state: "s",
    }).url,
  );
  assert.equal(eu.origin, "https://eu.account.amazon.com");

  const fe = new URL(
    buildAuthorizeUrl({
      service: "ads",
      region: "FE",
      clientId: "ads-client",
      redirectUri: "https://ops.vexim.vn/cb",
      state: "s",
    }).url,
  );
  assert.equal(fe.origin, "https://apac.account.amazon.com");
});

test("endpoint token/consent đổi theo vùng (app EU không đổi về NA được)", () => {
  assert.equal(tokenEndpoint("NA"), "https://api.amazon.com/auth/o2/token");
  assert.equal(tokenEndpoint("EU"), "https://api.amazon.co.uk/auth/o2/token");
  assert.equal(tokenEndpoint("FE"), "https://api.amazon.co.jp/auth/o2/token");
  assert.equal(tokenEndpoint("EU", "https://custom.example/token"), "https://custom.example/token");
  assert.equal(asAmazonRegion("gb"), "EU");
  assert.equal(asAmazonRegion("JP"), "FE");
  assert.equal(asAmazonRegion("US"), "NA");
  assert.equal(asAmazonRegion(""), "NA");
  assert.equal(asAmazonRegion("MARS", "EU"), "EU");
});

test("pickAuthorizationCode nhận cả spapi_oauth_code (SP-API) và code (Ads/LWA)", () => {
  assert.equal(pickAuthorizationCode(new URLSearchParams("spapi_oauth_code=ANxyz&state=s")), "ANxyz");
  assert.equal(pickAuthorizationCode(new URLSearchParams("code=ANabc&state=s")), "ANabc");
  // SP-API gửi cả hai → ưu tiên spapi_oauth_code
  assert.equal(
    pickAuthorizationCode(new URLSearchParams("code=khac&spapi_oauth_code=ANxyz")),
    "ANxyz",
  );
  assert.equal(pickAuthorizationCode(new URLSearchParams("state=s")), null);
  assert.equal(pickAuthorizationCode(new URLSearchParams("code=%20")), null);
});

// ============================================================================
// 4. Đổi code lấy token + dịch lỗi LWA
// ============================================================================
test("exchangeAuthorizationCode gửi form-urlencoded đúng kiểu tới endpoint vùng", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        access_token: "Atza|access",
        refresh_token: "Atzr|refresh",
        token_type: "bearer",
        expires_in: 3600,
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const tokens = await exchangeAuthorizationCode({
    code: "ANxyz",
    redirectUri: "https://ops.vexim.vn/cb",
    region: "EU",
    clientId: "cid",
    clientSecret: "csec",
    fetchFn: fakeFetch,
  });
  assert.equal(tokens.refresh_token, "Atzr|refresh");
  assert.equal(tokens.expires_in, 3600);

  assert.equal(calls[0].url, "https://api.amazon.co.uk/auth/o2/token");
  assert.equal(calls[0].init.method, "POST");
  const body = new URLSearchParams(String(calls[0].init.body));
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "ANxyz");
  assert.equal(body.get("redirect_uri"), "https://ops.vexim.vn/cb");
  assert.equal(body.get("client_id"), "cid");
  assert.equal(body.get("client_secret"), "csec");
});

test("refreshAccessToken dùng grant_type=refresh_token và KHÔNG đòi redirect_uri", async () => {
  // giữ trong object để TypeScript không "narrow" biến bị gán trong closure về null
  const captured: { body: URLSearchParams | null } = { body: null };
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    captured.body = new URLSearchParams(String(init.body));
    return new Response(JSON.stringify({ access_token: "Atza|new", expires_in: 3600, token_type: "bearer" }), {
      status: 200,
    });
  }) as unknown as typeof fetch;

  const tokens = await refreshAccessToken({
    refreshToken: "Atzr|old",
    region: "NA",
    clientId: "cid",
    clientSecret: "csec",
    fetchFn: fakeFetch,
  });
  assert.equal(tokens.access_token, "Atza|new");
  assert.equal(captured.body?.get("grant_type"), "refresh_token");
  assert.equal(captured.body?.get("refresh_token"), "Atzr|old");
  assert.equal(captured.body?.get("redirect_uri"), null);
});

test("LWA lỗi → thông dịch ra HÀNH ĐỘNG, kèm cờ retryable cho 429/5xx", async () => {
  const failing = (status: number, payload: unknown) =>
    (async () => new Response(JSON.stringify(payload), { status })) as unknown as typeof fetch;

  const grant = describeLwaFailure(400, JSON.stringify({ error: "invalid_grant" }));
  assert.match(grant.message, /Re-authorize/);
  assert.equal(grant.retryable, false);

  const client = describeLwaFailure(401, JSON.stringify({ error: "invalid_client" }));
  assert.match(client.message, /client_id\/client_secret/);

  const redirectMismatch = describeLwaFailure(400, JSON.stringify({ error: "unauthorized_client" }));
  assert.match(redirectMismatch.message, /redirect_uri/);

  const throttled = describeLwaFailure(429, JSON.stringify({ error: "slow_down" }));
  assert.equal(throttled.retryable, true);
  assert.match(throttled.message, /KHÔNG retry dồn/);

  const server = describeLwaFailure(503, "upstream");
  assert.equal(server.retryable, true);

  // route phải nhận được lỗi có .lwa để phân loại
  await assert.rejects(
    () =>
      exchangeAuthorizationCode({
        code: "ANxyz",
        redirectUri: "https://ops.vexim.vn/cb",
        region: "NA",
        clientId: "cid",
        clientSecret: "csec",
        fetchFn: failing(400, { error: "invalid_grant", error_description: "code expired" }),
      }),
    (e: unknown) => {
      const err = e as { lwa?: { code: string; status: number; retryable: boolean } };
      return err.lwa?.code === "invalid_grant" && err.lwa.status === 400 && err.lwa.retryable === false;
    },
  );
});

// ============================================================================
// 5. Config từ env
// ============================================================================
const FULL_ENV = {
  APP_BASE_URL: "https://ops.vexim.vn",
  OAUTH_TOKEN_ENC_KEY: KEY,
  OAUTH_STATE_SECRET: SECRET,
  NEXT_PUBLIC_SUPABASE_URL: "https://demo.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  AMAZON_LWA_CLIENT_ID: "spapi-client",
  AMAZON_LWA_CLIENT_SECRET: "spapi-secret",
  AMAZON_SP_API_APPLICATION_ID: "amzn1.sp.solution.demo",
  AMAZON_SP_API_REGION: "NA",
  AMAZON_ADS_CLIENT_ID: "ads-client",
  AMAZON_ADS_CLIENT_SECRET: "ads-secret",
  AMAZON_ADS_REFRESH_TOKEN: "Atzr|ads-env-token",
  AMAZON_ADS_REGION: "EU",
};

test("loadOAuthConfig: đủ env → 2 service ready, redirect_uri ghép từ APP_BASE_URL", () => {
  const cfg = loadOAuthConfig(FULL_ENV);
  assert.equal(cfg.baseUrl, "https://ops.vexim.vn");
  assert.equal(cfg.redirectUri, "https://ops.vexim.vn/api/amazon/oauth/callback");
  assert.equal(cfg.tokenKey, KEY);
  assert.equal(cfg.stateSecret, SECRET);
  assert.ok(cfg.supabase);
  assert.equal(cfg.services.spapi?.ready, true);
  assert.equal(cfg.services.spapi?.applicationId, "amzn1.sp.solution.demo");
  assert.equal(cfg.services.spapi?.region, "NA");
  assert.equal(cfg.services.ads?.ready, true);
  assert.equal(cfg.services.ads?.region, "EU");
  assert.equal(cfg.services.ads?.envRefreshToken, "Atzr|ads-env-token");
  assert.equal(cfg.services.ads?.scope, ADS_SCOPE);
  assert.equal(cfg.problems.length, 0, JSON.stringify(cfg.problems));
});

test("loadOAuthConfig: OAUTH_REDIRECT_URI ghi đè; thiếu APP_BASE_URL thì lấy VERCEL", () => {
  assert.equal(
    resolveRedirectUri({ ...FULL_ENV, OAUTH_REDIRECT_URI: "https://cb.vexim.vn/amazon" }),
    "https://cb.vexim.vn/amazon",
  );
  assert.equal(
    resolveBaseUrl({ VERCEL_PROJECT_PRODUCTION_URL: "vexim-ops.vercel.app/" }),
    "https://vexim-ops.vercel.app",
  );
  assert.equal(resolveBaseUrl({}), "http://localhost:3000");
  assert.equal(resolveBaseUrl({ PORT: "4000" }), "http://localhost:4000");
});

test("loadOAuthConfig: thiếu gì thì problems nói thẳng thứ đó (kèm cách sinh khoá)", () => {
  const cfg = loadOAuthConfig({});
  assert.equal(cfg.services.spapi, null);
  assert.equal(cfg.services.ads, null);
  assert.equal(cfg.tokenKey, null);
  assert.ok(cfg.problems.some((p) => p.includes("OAUTH_TOKEN_ENC_KEY")));
  assert.ok(cfg.problems.some((p) => p.includes("OAUTH_STATE_SECRET")));
  assert.ok(cfg.problems.some((p) => p.includes("AMAZON_ADS_CLIENT_ID")));
  assert.ok(cfg.problems.some((p) => p.includes("randomBytes(32)")));
  assert.throws(() => requireOAuthConfig({}), /OAUTH_TOKEN_ENC_KEY/);
  // có CRON_SECRET thì stateSecret fallback (vẫn chạy được, problems không kêu)
  assert.equal(loadOAuthConfig({ CRON_SECRET: "cron-x" }).stateSecret, "cron-x");
});

test("chỉ có credential Ads (không SP-API) → ads ready, spapi null", () => {
  const cfg = loadOAuthConfig({
    ...FULL_ENV,
    AMAZON_LWA_CLIENT_ID: undefined,
    AMAZON_LWA_CLIENT_SECRET: undefined,
  });
  assert.equal(cfg.services.ads?.ready, true);
  assert.equal(cfg.services.spapi, null);
});

// ============================================================================
// 6. Link /start có chữ ký (gửi chủ shop không cần session)
// ============================================================================
test("buildStartLink + verify: đúng chữ ký mới được sinh link authorize", () => {
  const link = buildStartLink({ baseUrl: "https://ops.vexim.vn", service: "ads", shop: SHOP, secret: SECRET });
  const u = new URL(link);
  const sig = u.searchParams.get("sig") ?? "";
  assert.ok(sig.length > 20);
  assert.ok(
    verifyStartLinkSignature(
      { service: "ads", shop: SHOP, redirect: null },
      sig,
      SECRET,
    ),
  );
  // đổi shop trong link → chữ ký không còn đúng
  assert.ok(
    !verifyStartLinkSignature(
      { service: "ads", shop: "99999999-9999-4999-8999-999999999999", redirect: null },
      sig,
      SECRET,
    ),
  );
  // đổi service cũng fail
  assert.ok(!verifyStartLinkSignature({ service: "spapi", shop: SHOP, redirect: null }, sig, SECRET));
  assert.ok(!verifyStartLinkSignature({ service: "ads", shop: SHOP, redirect: null }, "sig-sai", SECRET));
  assert.ok(!verifyStartLinkSignature({ service: "ads", shop: SHOP, redirect: null }, null, SECRET));
  // redirect là một phần của chữ ký
  const withRedirect = buildStartLink({
    baseUrl: "https://ops.vexim.vn",
    service: "ads",
    shop: SHOP,
    redirect: "/ppc",
    secret: SECRET,
  });
  const u2 = new URL(withRedirect);
  assert.equal(u2.searchParams.get("redirect"), "/ppc");
  assert.ok(
    verifyStartLinkSignature({ service: "ads", shop: SHOP, redirect: "/ppc" }, u2.searchParams.get("sig") ?? "", SECRET),
  );
  assert.ok(
    !verifyStartLinkSignature({ service: "ads", shop: SHOP, redirect: "/ppc" }, sig, SECRET),
  );
  assert.throws(() => startLinkSignature({ service: "ads", shop: SHOP }, ""), /OAUTH_STATE_SECRET|CRON_SECRET/);
});

// ============================================================================
// 7. Store — hợp đồng RPC/view với migration 0020
// ============================================================================
type Call = { url: string; init?: RequestInit };

function fakeSupabase(
  responder: (call: Call) => { status?: number; body: unknown },
): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    const res = responder(call);
    return new Response(typeof res.body === "string" ? res.body : JSON.stringify(res.body), {
      status: res.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const STORE_CFG = { url: "https://demo.supabase.co/", serviceRoleKey: "service-key" };

test("upsertToken gọi đúng RPC và map snake_case → camelCase", async () => {
  const { fetchFn, calls } = fakeSupabase(() => ({
    body: [
      {
        id: "token-id-1",
        service: "ads",
        status: "active",
        reauthorize_at: "2027-09-12T00:00:00+00:00",
        days_to_reauth: "365",
      },
    ],
  }));
  const store = createOAuthStore(STORE_CFG, fetchFn);
  const saved = await store.upsertToken({
    sellerAccountId: SHOP,
    service: "ads",
    encryptedRefreshToken: "enc:v1:abc",
    authorizedAt: "2026-09-12T00:00:00.000Z",
    tokenSource: "oauth",
  });
  assert.equal(calls[0].url, "https://demo.supabase.co/rest/v1/rpc/vexim_oauth_upsert_token");
  assert.equal(calls[0].init?.method, "POST");
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer service-key");
  assert.equal(headers.apikey, "service-key");
  const payload = (JSON.parse(String(calls[0].init?.body)) as { p_payload: Record<string, unknown> }).p_payload;
  assert.equal(payload.sellerAccountId, SHOP);
  assert.equal(payload.service, "ads");
  assert.equal(payload.encryptedRefreshToken, "enc:v1:abc");
  assert.equal(payload.reminderDays, 30, "mặc định nhắc trước 30 ngày (như email Amazon)");

  assert.equal(saved.id, "token-id-1");
  assert.equal(saved.service, "ads");
  assert.equal(saved.reauthorizeAt, "2027-09-12T00:00:00+00:00");
  assert.equal(saved.daysToReauth, 365, "PostgREST trả số dạng chuỗi → phải ép Number");
});

test("RPC chưa có (PGRST202) → nói thẳng 'migration 0020 chưa chạy'", async () => {
  const { fetchFn } = fakeSupabase(() => ({
    status: 404,
    body: { code: "PGRST202", message: "Could not find the function public.vexim_oauth_upsert_token" },
  }));
  const store = createOAuthStore(STORE_CFG, fetchFn);
  await assert.rejects(
    () => store.upsertToken({ sellerAccountId: SHOP, service: "ads", encryptedRefreshToken: "enc:v1:x" }),
    (e: unknown) => e instanceof OAuthStoreError && e.code === "missing_rpc" && /0020/.test(e.message),
  );
});

test("recordEvent nuốt lỗi (audit không được làm hỏng luồng authorize)", async () => {
  const { fetchFn } = fakeSupabase(() => ({ status: 500, body: { message: "boom" } }));
  const store = createOAuthStore(STORE_CFG, fetchFn);
  const id = await store.recordEvent({ service: "ads", event: "authorize_started" });
  assert.equal(id, null);
});

test("consumeState map đủ 5 cột của RPC (chống replay dùng ở callback)", async () => {
  const { fetchFn, calls } = fakeSupabase(() => ({
    body: [
      {
        service: "ads",
        seller_account_id: SHOP,
        redirect_uri: "/ppc",
        expired: false,
        already_used: true,
      },
    ],
  }));
  const store = createOAuthStore(STORE_CFG, fetchFn);
  const res = await store.consumeState("state-x", "code_received");
  assert.equal(calls[0].url, "https://demo.supabase.co/rest/v1/rpc/vexim_oauth_consume_state");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    p_state: "state-x",
    p_result: "code_received",
  });
  assert.equal(res.service, "ads");
  assert.equal(res.sellerAccountId, SHOP);
  assert.equal(res.redirectUri, "/ppc");
  assert.equal(res.alreadyUsed, true);
  assert.equal(res.expired, false);
});

test("scanReauth map 8 cột OUT của vexim_oauth_reauth_scan", async () => {
  const { fetchFn, calls } = fakeSupabase(() => ({
    body: [
      {
        shop_id: SHOP,
        shop_name: "A1 · US",
        token_service: "ads",
        token_status: "active",
        days_to_reauth: "12",
        alert_severity: "amber",
        alert_id: "alert-1",
        next_action: "send_reauth_link",
      },
    ],
  }));
  const store = createOAuthStore(STORE_CFG, fetchFn);
  const rows = await store.scanReauth({ noticeDays: 45, service: "ads" });
  assert.equal(calls[0].url, "https://demo.supabase.co/rest/v1/rpc/vexim_oauth_reauth_scan");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { p_notice_days: 45, p_service: "ads" });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    shopId: SHOP,
    shopName: "A1 · US",
    tokenService: "ads",
    tokenStatus: "active",
    daysToReauth: 12,
    alertSeverity: "amber",
    alertId: "alert-1",
    nextAction: "send_reauth_link",
  });
});

/** Hợp đồng cột của view — harness BƯỚC 21 soát trên Postgres thật, test này khoá
 *  phía TypeScript: sai một cột là PGRST204 và sập trang /module0/connect. */
const CONNECTIONS_COLUMNS = [
  "seller_account_id",
  "shop",
  "seller_id",
  "marketplace",
  "shop_status",
  "data_source",
  "service",
  "connected",
  "token_status",
  "token_source",
  "scope",
  "client_id",
  "selling_partner_id",
  "ads_account_id",
  "authorized_at",
  "reauthorize_at",
  "reminder_days",
  "reminder_sent_at",
  "last_refresh_at",
  "last_used_at",
  "last_error",
  "days_to_reauth",
  "reauth_state",
  "needs_connect",
];

test("listConnections: chuỗi select là TẬP CON hợp đồng cột vexim_connections, không có cột token", async () => {
  const { fetchFn, calls } = fakeSupabase(() => ({
    body: [
      {
        seller_account_id: SHOP,
        shop: "A1 · US",
        seller_id: "A2XYZ",
        marketplace: "ATVPDKIKX0DER",
        shop_status: "active",
        data_source: "production",
        service: "ads",
        connected: true,
        token_status: "active",
        token_source: "oauth",
        scope: "ads::campaign_management",
        selling_partner_id: null,
        ads_account_id: "1234567890",
        authorized_at: "2026-09-12T00:00:00+00:00",
        reauthorize_at: "2027-09-12T00:00:00+00:00",
        reminder_days: "30",
        reminder_sent_at: null,
        last_refresh_at: null,
        last_error: null,
        days_to_reauth: "365",
        reauth_state: "ok",
        needs_connect: false,
      },
    ],
  }));
  const store = createOAuthStore(STORE_CFG, fetchFn);
  const rows = await store.listConnections();
  const query = new URL(calls[0].url).searchParams;
  const selected = (query.get("select") ?? "").split(",");
  for (const col of selected) {
    assert.ok(CONNECTIONS_COLUMNS.includes(col), `cột lạ trong select: ${col}`);
    assert.ok(
      !/token|encrypted|secret/i.test(col) || col === "token_status" || col === "token_source",
      `không được select cột token: ${col}`,
    );
  }
  assert.ok(selected.includes("reauth_state") && selected.includes("days_to_reauth"));
  assert.equal(query.get("order"), "shop.asc,service.asc");

  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.sellerAccountId, SHOP);
  assert.equal(row.service, "ads");
  assert.equal(row.connected, true);
  assert.equal(row.reauthState, "ok");
  assert.equal(row.daysToReauth, 365);
  assert.equal(row.reminderDays, 30);
  assert.equal(row.needsConnect, false);
  assert.equal((row as unknown as Record<string, unknown>).encrypted_refresh_token, undefined);
});

test("listConnections lọc theo shop khi cần (màn hình chi tiết 1 shop)", async () => {
  const { fetchFn, calls } = fakeSupabase(() => ({ body: [] }));
  const store = createOAuthStore(STORE_CFG, fetchFn);
  await store.listConnections({ shopId: SHOP });
  const query = new URL(calls[0].url).searchParams;
  assert.equal(query.get("seller_account_id"), `eq.${SHOP}`);
});
