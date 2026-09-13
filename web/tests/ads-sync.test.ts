/**
 * Test Module 5 — token Ads theo shop, cổng ghi Supabase, và luồng đồng bộ.
 *
 * Ba chỗ hỏng là mất dữ liệu hoặc mất quyền truy cập:
 *   • AdsTokenManager: giải mã sai khoá, token quá hạn 365 ngày, LWA invalid_grant
 *     → mỗi trường hợp phải ra HÀNH ĐỘNG đúng (không gọi Amazon bằng token chết,
 *     không đánh dấu chết khi chỉ bị 429, không tự bịa token).
 *   • AdsDb: đường dẫn PostgREST (không tiền tố schema + header Accept-Profile) và
 *     ánh xạ snake_case ↔ camelCase với RPC 0020.
 *   • runAdsSync: thứ tự POLL → REQUEST (không bao giờ ngồi chờ Amazon), 425/429
 *     không phải lỗi chết, report rỗng = no_data, và mọi bước đều ghi trạng thái
 *     vào ads.report_requests để lần chạy sau biết phải làm gì.
 */
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { test } from "node:test";

import { encryptToken } from "../src/lib/oauth/crypto.ts";
import {
  AdsDbError,
  AdsTokenError,
  AdsTokenManager,
  budgetRowsFromCampaignRows,
  createAdsDb,
  kindForReportTypeId,
  runAdsSync,
  type AdsDb,
  type AdsTokenRow,
  type PendingAdsReport,
  type TokenStore,
  type UpsertCounts,
} from "../src/lib/ads/index.ts";

const KEY = "b".repeat(64);
const SHOP = "aaaaaaaa-1111-4111-8111-111111111111";
const REFRESH = "Atzr|IwEBI-ads-refresh-demo";
const SB = { url: "https://demo.supabase.co/", serviceRoleKey: "service-key" };

function tokenRow(over: Partial<AdsTokenRow> = {}): AdsTokenRow {
  return {
    id: "tok-1",
    sellerAccountId: SHOP,
    encryptedRefreshToken: encryptToken(REFRESH, KEY),
    status: "active",
    expiresAt: "2027-09-12T00:00:00+00:00",
    reauthorizeAt: "2027-09-12T00:00:00+00:00",
    lastRefreshAt: null,
    lastError: null,
    clientId: null,
    scope: "ads::campaign_management",
    adsAccountId: null,
    ...over,
  };
}

function fakeStore(row: AdsTokenRow | null, opts: { failTouch?: boolean } = {}) {
  const touches: { id: string; patch: Record<string, unknown> }[] = [];
  const store: TokenStore = {
    async getAdsToken() {
      return row;
    },
    async touchAdsToken(id, patch) {
      if (opts.failTouch) throw new Error("db offline");
      touches.push({ id, patch: patch as unknown as Record<string, unknown> });
    },
  };
  return { store, touches };
}

type LwaCall = { url: string; body: URLSearchParams };

function lwaFetch(responder: (n: number) => { status: number; body: unknown }) {
  const calls: LwaCall[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: new URLSearchParams(String(init.body)) });
    const r = responder(calls.length);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const OK_TOKEN = { access_token: "Atza|access-1h", expires_in: 3600, token_type: "bearer" };

/* ================================================================== */
/* 1. AdsTokenManager                                                 */
/* ================================================================== */
const MGR_CFG = {
  clientId: "ads-client-id",
  clientSecret: "ads-client-secret",
  region: "NA" as const,
  tokenKey: KEY,
  envRefreshToken: null,
};

test("token trong DB: giải mã → đổi access token → cache (không gọi LWA lần 2)", async () => {
  const { store, touches } = fakeStore(tokenRow());
  const { fetchFn, calls } = lwaFetch(() => ({ status: 200, body: OK_TOKEN }));
  const mgr = new AdsTokenManager(MGR_CFG, { store, fetchFn, now: () => new Date("2026-09-13T00:00:00Z") });

  const t = await mgr.accessToken(SHOP);
  assert.equal(t.accessToken, "Atza|access-1h");
  assert.equal(t.source, "db");
  assert.equal(t.tokenId, "tok-1");
  assert.equal(t.shopId, SHOP);

  assert.equal(calls[0].url, "https://api.amazon.com/auth/o2/token");
  assert.equal(calls[0].body.get("grant_type"), "refresh_token");
  assert.equal(calls[0].body.get("refresh_token"), REFRESH, "phải giải mã ra đúng refresh token đã lưu");
  assert.equal(calls[0].body.get("client_id"), "ads-client-id");

  // ghi lại last_refresh_at + status active để /module0/connect hiện "vừa làm mới"
  assert.equal(touches.length, 1);
  assert.equal(touches[0].id, "tok-1");
  assert.equal(touches[0].patch.status, "active");
  assert.equal(touches[0].patch.lastError, null);
  assert.equal(touches[0].patch.lastRefreshAt, "2026-09-13T00:00:00.000Z");

  // lần 2 dùng cache (access token sống 1 giờ)
  const t2 = await mgr.accessToken(SHOP);
  assert.equal(t2.accessToken, "Atza|access-1h");
  assert.equal(calls.length, 1, "không được gọi LWA lần nữa khi token còn hạn");
  assert.equal(touches.length, 1);

  // force → gọi lại
  await mgr.accessToken(SHOP, { force: true });
  assert.equal(calls.length, 2);
});

test("token của app nào đổi bằng app đó: client_id trong DB thắng client_id env", async () => {
  const { store } = fakeStore(tokenRow({ clientId: "app-cu-client-id" }));
  const { fetchFn, calls } = lwaFetch(() => ({ status: 200, body: OK_TOKEN }));
  const mgr = new AdsTokenManager(MGR_CFG, { store, fetchFn });
  const t = await mgr.accessToken(SHOP);
  assert.equal(t.clientId, "app-cu-client-id");
  assert.equal(calls[0].body.get("client_id"), "app-cu-client-id");
});

test("quá hạn re-authorize + status expired → KHÔNG gọi Amazon, nói rõ chủ shop phải bấm", async () => {
  const { store } = fakeStore(
    tokenRow({ status: "expired", reauthorizeAt: "2026-01-01T00:00:00+00:00" }),
  );
  const { fetchFn, calls } = lwaFetch(() => ({ status: 200, body: OK_TOKEN }));
  const mgr = new AdsTokenManager(MGR_CFG, { store, fetchFn, now: () => new Date("2026-09-13T00:00:00Z") });
  await assert.rejects(
    () => mgr.accessToken(SHOP),
    (e: unknown) =>
      e instanceof AdsTokenError &&
      e.code === "token_expired" &&
      /CHỦ SHOP|chủ shop/.test(e.hint ?? "") &&
      /365/.test(e.hint ?? ""),
  );
  assert.equal(calls.length, 0, "gọi LWA bằng token đã chết chỉ tổ tốn quota + log rác");
});

test("status expired nhưng CHƯA quá 365 ngày → thử refresh, được thì tự đặt lại active", async () => {
  const { store, touches } = fakeStore(
    tokenRow({ status: "expired", reauthorizeAt: "2027-01-01T00:00:00+00:00", lastError: "lỗi cũ" }),
  );
  const { fetchFn } = lwaFetch(() => ({ status: 200, body: OK_TOKEN }));
  const mgr = new AdsTokenManager(MGR_CFG, { store, fetchFn, now: () => new Date("2026-09-13T00:00:00Z") });
  const t = await mgr.accessToken(SHOP);
  assert.equal(t.source, "db");
  assert.equal(touches[0].patch.status, "active");
  assert.ok(mgr.warnings.some((w) => /tự đặt lại 'active'/.test(w)), "phải nói rõ đã self-heal");
});

test("revoked → dừng ngay, chỉ cách authorize lại", async () => {
  const { store } = fakeStore(tokenRow({ status: "revoked" }));
  const { fetchFn, calls } = lwaFetch(() => ({ status: 200, body: OK_TOKEN }));
  const mgr = new AdsTokenManager(MGR_CFG, { store, fetchFn });
  await assert.rejects(
    () => mgr.accessToken(SHOP),
    (e: unknown) => e instanceof AdsTokenError && e.code === "token_revoked" && /gỡ quyền/.test(e.hint ?? ""),
  );
  assert.equal(calls.length, 0);
});

test("sai khoá giải mã → decrypt_failed, đánh dấu token 'error', KHÔNG trả chuỗi rác", async () => {
  const { store, touches } = fakeStore(tokenRow());
  const { fetchFn, calls } = lwaFetch(() => ({ status: 200, body: OK_TOKEN }));
  const mgr = new AdsTokenManager({ ...MGR_CFG, tokenKey: "c".repeat(64) }, { store, fetchFn });
  await assert.rejects(
    () => mgr.accessToken(SHOP),
    (e: unknown) =>
      e instanceof AdsTokenError && e.code === "decrypt_failed" && /OAUTH_TOKEN_ENC_KEY/.test(e.hint ?? ""),
  );
  assert.equal(calls.length, 0);
  assert.equal(touches[0].patch.status, "error");
  assert.match(String(touches[0].patch.lastError), /decrypt_failed/);
});

test("thiếu OAUTH_TOKEN_ENC_KEY → nói thẳng, không âm thầm bỏ qua shop", async () => {
  const { store } = fakeStore(tokenRow());
  const mgr = new AdsTokenManager({ ...MGR_CFG, tokenKey: null }, { store, fetchFn: lwaFetch(() => ({ status: 200, body: OK_TOKEN })).fetchFn });
  await assert.rejects(
    () => mgr.accessToken(SHOP),
    (e: unknown) => e instanceof AdsTokenError && e.code === "decrypt_failed" && /randomBytes\(32\)/.test(e.hint ?? ""),
  );
});

test("shop chưa có token → fallback AMAZON_ADS_REFRESH_TOKEN kèm CẢNH BÁO (token env không gắn shop)", async () => {
  const { store, touches } = fakeStore(null);
  const { fetchFn, calls } = lwaFetch(() => ({ status: 200, body: OK_TOKEN }));
  const mgr = new AdsTokenManager({ ...MGR_CFG, envRefreshToken: "Atzr|env-token" }, { store, fetchFn });
  const t = await mgr.accessToken(SHOP);
  assert.equal(t.source, "env");
  assert.equal(t.tokenId, null);
  assert.equal(calls[0].body.get("refresh_token"), "Atzr|env-token");
  assert.equal(touches.length, 0, "không có dòng trong DB thì không được PATCH bừa");
  assert.ok(mgr.warnings.some((w) => /KHÔNG gắn shop/.test(w) && /oauth\/import/.test(w)));
});

test("không token DB, không token env → no_token kèm 2 cách sửa", async () => {
  const { store } = fakeStore(null);
  const { fetchFn, calls } = lwaFetch(() => ({ status: 200, body: OK_TOKEN }));
  const mgr = new AdsTokenManager(MGR_CFG, { store, fetchFn });
  await assert.rejects(
    () => mgr.accessToken(SHOP),
    (e: unknown) =>
      e instanceof AdsTokenError &&
      e.code === "no_token" &&
      /module0\/connect/.test(e.hint ?? "") &&
      /oauth\/import/.test(e.hint ?? ""),
  );
  assert.equal(calls.length, 0);
});

test("LWA invalid_grant → đánh dấu token 'expired' + invalidate cache, KHÔNG retryable", async () => {
  const { store, touches } = fakeStore(tokenRow());
  const { fetchFn, calls } = lwaFetch(() => ({
    status: 400,
    body: { error: "invalid_grant", error_description: "refresh token revoked" },
  }));
  const mgr = new AdsTokenManager(MGR_CFG, { store, fetchFn });
  await assert.rejects(
    () => mgr.accessToken(SHOP),
    (e: unknown) =>
      e instanceof AdsTokenError &&
      e.code === "refresh_failed" &&
      e.retryable === false &&
      /Re-authorize/.test(e.hint ?? ""),
  );
  assert.equal(calls.length, 1);
  assert.equal(touches[0].patch.status, "expired");
  assert.match(String(touches[0].patch.lastError), /invalid_grant/);
});

test("LWA 429 → retryable, KHÔNG đổi trạng thái token (chết oan là mất kết nối)", async () => {
  const { store, touches } = fakeStore(tokenRow());
  const { fetchFn } = lwaFetch(() => ({ status: 429, body: { error: "slow_down" } }));
  const mgr = new AdsTokenManager(MGR_CFG, { store, fetchFn });
  await assert.rejects(
    () => mgr.accessToken(SHOP),
    (e: unknown) => e instanceof AdsTokenError && e.retryable === true && /KHÔNG retry dồn|tốc độ/.test(e.hint ?? ""),
  );
  assert.equal(touches.length, 0, "429 không phải lý do để đánh dấu token chết");
});

test("ghi DB hỏng khi touch → vẫn trả token, chỉ thêm cảnh báo (audit không chặn luồng)", async () => {
  const { store } = fakeStore(tokenRow(), { failTouch: true });
  const { fetchFn } = lwaFetch(() => ({ status: 200, body: OK_TOKEN }));
  const mgr = new AdsTokenManager(MGR_CFG, { store, fetchFn });
  const t = await mgr.accessToken(SHOP);
  assert.equal(t.accessToken, "Atza|access-1h");
  assert.ok(mgr.warnings.some((w) => /Không cập nhật được oauth_tokens/.test(w)));
});

/* ================================================================== */
/* 2. AdsDb — PostgREST + RPC 0020                                    */
/* ================================================================== */
type DbCall = { url: string; method: string; headers: Record<string, string>; body: unknown };

function dbFetch(responder: (call: DbCall) => { status?: number; body: unknown }) {
  const calls: DbCall[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const call: DbCall = {
      url: String(url),
      method: String(init.method ?? "GET"),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const r = responder(call);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

test("getAdsToken: chọn schema bằng HEADER, path không tiền tố schema (chống PGRST205)", async () => {
  let n = 0;
  const { fetchFn, calls } = dbFetch(() => {
    n += 1;
    if (n > 1) return { body: [] };
    return {
    body: [
      {
        id: "tok-1",
        seller_account_id: SHOP,
        encrypted_refresh_token: "enc:v1:abc",
        status: "active",
        expires_at: "2027-09-12T00:00:00+00:00",
        reauthorize_at: "2027-09-12T00:00:00+00:00",
        last_refresh_at: null,
        last_error: null,
        client_id: "cid",
        scope: "ads::campaign_management",
        ads_account_id: null,
      },
    ],
    };
  });
  const db = createAdsDb(SB, fetchFn);
  const row = await db.getAdsToken(SHOP);
  assert.equal(row?.id, "tok-1");
  assert.equal(row?.encryptedRefreshToken, "enc:v1:abc");
  assert.equal(row?.reauthorizeAt, "2027-09-12T00:00:00+00:00");

  const path = new URL(calls[0].url).pathname;
  assert.equal(path, "/rest/v1/oauth_tokens", "không được có 'connections.' trong path");
  assert.equal(calls[0].headers["Accept-Profile"], "connections");
  assert.equal(calls[0].headers["Content-Profile"], "connections");
  assert.equal(calls[0].headers.Authorization, "Bearer service-key");
  const q = new URL(calls[0].url).searchParams;
  assert.equal(q.get("service"), "eq.ads");
  assert.equal(q.get("seller_account_id"), `eq.${SHOP}`);
  assert.match(q.get("select") ?? "", /encrypted_refresh_token/);

  // mọi call khác cũng không được dính dấu chấm trong path
  assert.equal(await db.getAdsToken("khong-co"), null);
  for (const c of calls) assert.ok(!new URL(c.url).pathname.split("/").pop()!.includes("."));
});

test("RPC chưa có (PGRST202) → AdsDbError missing_rpc, hint chỉ migration 0020 + Exposed schemas", async () => {
  const { fetchFn } = dbFetch(() => ({
    status: 404,
    body: { code: "PGRST202", message: "Could not find the function public.vexim_worker_upsert_ads_metrics" },
  }));
  const db = createAdsDb(SB, fetchFn);
  await assert.rejects(
    () => db.upsertMetrics(SHOP, [{ date: "2026-09-01" }]),
    (e: unknown) => e instanceof AdsDbError && e.code === "missing_rpc" && /0020/.test(e.hint ?? "") && /Exposed schemas/.test(e.hint ?? ""),
  );
});

test("touchAdsToken: PATCH theo id, chỉ gửi field có thật, Prefer return=minimal", async () => {
  const { fetchFn, calls } = dbFetch(() => ({ body: "" }));
  const db = createAdsDb(SB, fetchFn);
  await db.touchAdsToken("tok-9", { lastRefreshAt: "2026-09-13T00:00:00Z", lastError: null, status: "active" });
  assert.equal(calls[0].method, "PATCH");
  assert.equal(new URL(calls[0].url).search, "?id=eq.tok-9");
  assert.equal(calls[0].headers.Prefer, "return=minimal");
  const body = calls[0].body as Record<string, unknown>;
  assert.equal(body.last_refresh_at, "2026-09-13T00:00:00Z");
  assert.equal(body.last_error, null);
  assert.equal(body.status, "active");
  assert.ok(body.updated_at, "phải cập nhật updated_at để biết token còn sống");
  assert.equal(body.encrypted_refresh_token, undefined, "không được ghi đè token");
});

test("upsert*: rows rỗng → KHÔNG gọi RPC (tránh 1 call vô ích cho mỗi loại report)", async () => {
  const { fetchFn, calls } = dbFetch(() => ({ body: { inserted: 0 } }));
  const db = createAdsDb(SB, fetchFn);
  const c = await db.upsertSearchTerms(SHOP, []);
  assert.deepEqual(c, { inserted: 0, updated: 0, rowsWritten: 0, skipped: 0, merged: 0, days: null, extra: {} });
  assert.equal(calls.length, 0);
});

test("upsert*: đúng tên RPC + payload {p_seller,p_rows}; ép số PostgREST trả dạng chuỗi", async () => {
  const { fetchFn, calls } = dbFetch((call) =>
    call.url.includes("metrics")
      ? { body: { inserted: "3", updated: "1", skipped: "0", days: "7", currencies: "USD", merged: "2" } }
      : { body: { rows_written: "12", skipped: "1", days: "4", merged: "0" } },
  );
  const db = createAdsDb(SB, fetchFn);

  const m = await db.upsertMetrics(SHOP, [{ date: "2026-09-01", cost: 1 }]);
  assert.equal(new URL(calls[0].url).pathname, "/rest/v1/rpc/vexim_worker_upsert_ads_metrics");
  assert.deepEqual(calls[0].body, { p_seller: SHOP, p_rows: [{ date: "2026-09-01", cost: 1 }] });
  assert.equal(calls[0].headers.Prefer, "params=single-object");
  assert.deepEqual(m, { inserted: 3, updated: 1, rowsWritten: 0, skipped: 0, merged: 2, days: 7, extra: { currencies: "USD" } });

  const st = await db.upsertSearchTerms(SHOP, [{ searchTerm: "*" }]);
  assert.equal(new URL(calls[1].url).pathname, "/rest/v1/rpc/vexim_worker_upsert_ads_search_terms");
  assert.equal(st.rowsWritten, 12);
  assert.equal(st.skipped, 1, "skipped = dòng RÁC, phải hiện ra để biết Amazon trả thiếu cột gì");

  // đủ 7 RPC ghi của 0020
  await db.upsertProfiles(SHOP, [{}]);
  await db.upsertCampaigns(SHOP, [{}]);
  await db.upsertTargeting(SHOP, [{}]);
  await db.upsertAdvertised(SHOP, [{}]);
  await db.upsertBudgetUsage(SHOP, [{}]);
  const paths = calls.slice(2).map((c) => new URL(c.url).pathname.split("/").pop());
  assert.deepEqual(paths, [
    "vexim_worker_upsert_ads_profiles",
    "vexim_worker_upsert_ads_campaigns",
    "vexim_worker_upsert_ads_targeting",
    "vexim_worker_upsert_ads_advertised",
    "vexim_worker_upsert_ads_budget_usage",
  ]);
});

test("setReportRequest: payload camelCase đúng khoá RPC, đọc lại id/status/ads_report_id", async () => {
  const { fetchFn, calls } = dbFetch(() => ({ body: [{ id: "req-1", status: "imported", ads_report_id: "rpt-1" }] }));
  const db = createAdsDb(SB, fetchFn);
  const out = await db.setReportRequest(SHOP, {
    reportTypeId: "spCampaigns",
    adsProfileId: "111",
    groupBy: "campaign",
    timeUnit: "DAILY",
    dateStart: "2026-09-01",
    dateEnd: "2026-09-07",
    adsReportId: "rpt-1",
    status: "imported",
    rowsImported: 42,
  });
  assert.equal(new URL(calls[0].url).pathname, "/rest/v1/rpc/vexim_worker_set_ads_report_request");
  const body = calls[0].body as { p_seller: string; p_req: Record<string, unknown> };
  assert.equal(body.p_seller, SHOP);
  assert.equal(body.p_req.reportTypeId, "spCampaigns");
  assert.equal(body.p_req.adsProfileId, "111");
  assert.equal(body.p_req.groupBy, "campaign");
  assert.equal(body.p_req.rowsImported, 42);
  assert.equal(body.p_req.adProduct, "SPONSORED_PRODUCTS", "mặc định SP");
  assert.deepEqual(out, { id: "req-1", status: "imported", adsReportId: "rpt-1" });
});

test("pendingReports: map 13 cột snake_case → camelCase, attempts là số", async () => {
  const { fetchFn, calls } = dbFetch(() => ({
    body: [
      {
        seller_account_id: SHOP,
        ads_profile_id: "111",
        report_type_id: "spSearchTerm",
        ad_product: "SPONSORED_PRODUCTS",
        group_by: "searchTerm",
        time_unit: "DAILY",
        date_start: "2026-09-01",
        date_end: "2026-09-07",
        ads_report_id: "rpt-9",
        status: "processing",
        attempts: "2",
        last_error: null,
        requested_at: "2026-09-08T04:00:00+00:00",
        marketplace: "ATVPDKIKX0DER",
      },
    ],
  }));
  const db = createAdsDb(SB, fetchFn);
  const rows = await db.pendingReports({ limit: 20 });
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].body)), {
    p_seller: null,
    p_statuses: "requested,processing",
    p_limit: 20,
  });
  const r = rows[0];
  assert.equal(r.sellerAccountId, SHOP);
  assert.equal(r.adsProfileId, "111");
  assert.equal(r.reportTypeId, "spSearchTerm");
  assert.equal(r.groupBy, "searchTerm");
  assert.equal(r.adsReportId, "rpt-9");
  assert.equal(r.attempts, 2);
  assert.equal(r.marketplace, "ATVPDKIKX0DER");
});

test("raiseAlerts + fillProfitAdsSpend: map đúng cột OUT của RPC", async () => {
  const { fetchFn, calls } = dbFetch((call) =>
    call.url.includes("raise_alerts")
      ? {
          body: [
            {
              shop_id: SHOP,
              shop_name: "A1 · US",
              rule_code: "acos_over_target",
              entity_key: "campaign:123",
              severity: "amber",
              metric: "31.4",
              threshold: "25",
              alert_id: "al-1",
              next_action: "review_bids",
            },
          ],
        }
      : { body: [{ rows_updated: "8", days: "7", skus: "5", unmatched: "2", currencies: "USD,CAD" }] },
  );
  const db = createAdsDb(SB, fetchFn);

  const alerts = await db.raiseAlerts(SHOP, "2026-09-12");
  assert.deepEqual(calls[0].body, { p_seller: SHOP, p_day: "2026-09-12" });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].ruleCode, "acos_over_target");
  assert.equal(alerts[0].metric, 31.4);
  assert.equal(alerts[0].threshold, 25);
  assert.equal(alerts[0].nextAction, "review_bids");

  const fill = await db.fillProfitAdsSpend(SHOP, { from: null, to: null });
  assert.deepEqual(fill, { rowsUpdated: 8, days: 7, skus: 5, unmatched: 2, currencies: ["USD", "CAD"] });
});

test("recordEvent nuốt lỗi (audit không được làm hỏng đồng bộ)", async () => {
  const ok = dbFetch(() => ({ body: '"evt-1"' }));
  assert.equal(await createAdsDb(SB, ok.fetchFn).recordEvent({ sellerAccountId: SHOP, event: "ads_sync_done" }), "evt-1");

  const bad = dbFetch(() => ({ status: 500, body: { message: "boom" } }));
  assert.equal(await createAdsDb(SB, bad.fetchFn).recordEvent({ event: "x" }), null);
});

test("listShops: đọc connections.seller_accounts đang active", async () => {
  const { fetchFn, calls } = dbFetch(() => ({
    body: [{ id: SHOP, display_name: "A1 · US", marketplace: "ATVPDKIKX0DER", status: "active", data_source: "production" }],
  }));
  const db = createAdsDb(SB, fetchFn);
  const shops = await db.listShops();
  assert.equal(shops[0].displayName, "A1 · US");
  assert.equal(shops[0].dataSource, "production");
  assert.equal(new URL(calls[0].url).pathname, "/rest/v1/seller_accounts");
  assert.equal(new URL(calls[0].url).searchParams.get("status"), "eq.active");
  assert.equal(calls[0].headers["Accept-Profile"], "connections");
});

/* ================================================================== */
/* 3. Helpers thuần                                                   */
/* ================================================================== */
test("kindForReportTypeId ánh xạ ngược reportTypeId → loại report nội bộ", () => {
  assert.equal(kindForReportTypeId("spCampaigns"), "campaigns");
  assert.equal(kindForReportTypeId("spAdvertisedProduct"), "advertised");
  assert.equal(kindForReportTypeId("spSearchTerm"), "searchTerms");
  assert.equal(kindForReportTypeId("spTargeting"), "targeting");
  assert.equal(kindForReportTypeId("sbCampaigns"), null, "loại lạ → null, cron bỏ qua kèm lý do");
});

test("budgetRowsFromCampaignRows: % ngân sách = cost/budget, bỏ dòng không có budget", () => {
  const rows = budgetRowsFromCampaignRows(
    [
      { date: "2026-09-01", campaignId: "1", campaignName: "SP main", cost: 42, campaignBudgetAmount: 50, campaignBudgetCurrencyCode: "USD", adsProfileId: "111" },
      { date: "2026-09-01", campaignId: "2", cost: 10 }, // không có budget → bỏ
      { date: "2026-09-01", campaignId: "3", cost: 10, campaignBudgetAmount: 0 }, // budget 0 → bỏ (chia 0)
      { campaignId: "4", cost: 10, campaignBudgetAmount: 20 }, // không có ngày → bỏ
      { date: "2026-09-01", campaignId: "5", cost: 30, campaignBudgetAmount: 20 }, // vượt ngân sách
    ],
    { profileId: "111", capturedAt: "2026-09-13T00:00:00Z" },
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].percentageUsed, 84);
  assert.equal(rows[0].budget, 50);
  assert.equal(rows[0].spend, 42);
  assert.equal(rows[0].day, "2026-09-01");
  assert.equal(rows[0].source, "sp_campaigns_report_estimate", "phải đánh dấu là ƯỚC LƯỢNG từ report ngày");
  assert.equal(rows[0].currencyCode, "USD");
  assert.equal(rows[1].percentageUsed, 150, "vượt 100% thì giữ nguyên 150 để alert budget_exhausted bắt được");
});

/* ================================================================== */
/* 4. runAdsSync                                                      */
/* ================================================================== */
const PROFILES = [
  {
    profileId: "111",
    countryCode: "US",
    currencyCode: "USD",
    accountInfo: { id: "ENTITY_US", type: "seller", name: "VEXIM US", marketplaceStringId: "ATVPDKIKX0DER" },
  },
];

type SyncCall = { url: string; method: string; body: unknown };

/** fetch giả routing theo URL: LWA, profiles, campaigns, report create/get, S3. */
function adsFetch(opts: {
  rows?: Record<string, unknown>[];
  reportStatus?: string;
  createStatus?: number;
  createBody?: unknown;
  getStatus?: number;
  statusBody?: unknown;
  campaignRows?: Record<string, unknown>[];
}) {
  const calls: SyncCall[] = [];
  const rows = opts.rows ?? [
    { date: "2026-09-12", campaignId: "1", campaignName: "SP main", impressions: 100, clicks: 8, cost: 12.5, sales7d: 90, purchases7d: 4, campaignBudgetAmount: 25 },
  ];
  const gz = gzipSync(Buffer.from(JSON.stringify(rows), "utf8"));

  const fetchFn = (async (url: string, init: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: String(init.method ?? "GET"), body: init.body ? safeJson(String(init.body)) : undefined });

    if (u.includes("/auth/o2/token")) {
      return new Response(JSON.stringify(OK_TOKEN), { status: 200 });
    }
    if (u.includes("/v2/profiles")) {
      return new Response(JSON.stringify(PROFILES), { status: 200 });
    }
    if (u.includes("/sp/campaigns/list")) {
      return new Response(
        JSON.stringify({
          campaigns: opts.campaignRows ?? [
            {
              campaignId: "1",
              name: "SP main",
              state: "ENABLED",
              startDate: "20260101",
              budget: { budget: 25, budgetType: "DAILY" },
              costType: "CPC",
              targetingType: "MANUAL",
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (u.endsWith("/reporting/reports") && init.method === "POST") {
      const status = opts.createStatus ?? 200;
      const body = opts.createBody ?? { reportId: "rpt-new", status: "PENDING", url: null };
      return new Response(JSON.stringify(body), { status });
    }
    if (u.includes("/reporting/reports/") && !u.includes("/rows")) {
      const status = opts.getStatus ?? 200;
      const body =
        opts.statusBody ??
        (opts.reportStatus === "PROCESSING"
          ? { reportId: "rpt-old", status: "PROCESSING", url: null }
          : { reportId: "rpt-old", status: "COMPLETED", url: "https://s3.example/r.gz", urlExpiresAt: "2026-09-13T12:00:00Z", rowCount: rows.length });
      return new Response(JSON.stringify(body), { status });
    }
    if (u.startsWith("https://s3.example")) {
      return new Response(gz, { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** DB giả trong bộ nhớ — ghi lại mọi call để assert. */
function fakeDb(over: Partial<AdsDb> = {}) {
  const log: { fn: string; args: unknown[] }[] = [];
  const rec = (fn: string) => (...args: unknown[]) => {
    log.push({ fn, args });
    return undefined;
  };
  const counts: UpsertCounts = { inserted: 1, updated: 0, rowsWritten: 1, skipped: 0, merged: 0, days: 7, extra: {} };
  const pending: PendingAdsReport[] = [];
  const db = {
    async listShops() {
      rec("listShops")();
      return [{ id: SHOP, displayName: "A1 · US", marketplace: "ATVPDKIKX0DER", status: "active", dataSource: "production" }];
    },
    async getAdsToken() {
      rec("getAdsToken")();
      return tokenRow();
    },
    async touchAdsToken(id: string, patch: unknown) {
      rec("touchAdsToken")(id, patch);
    },
    async upsertProfiles(s: string, rows: unknown[]) {
      rec("upsertProfiles")(s, rows);
      return counts;
    },
    async upsertCampaigns(s: string, rows: unknown[]) {
      rec("upsertCampaigns")(s, rows);
      return counts;
    },
    async upsertMetrics(s: string, rows: unknown[]) {
      rec("upsertMetrics")(s, rows);
      return counts;
    },
    async upsertTargeting(s: string, rows: unknown[]) {
      rec("upsertTargeting")(s, rows);
      return counts;
    },
    async upsertSearchTerms(s: string, rows: unknown[]) {
      rec("upsertSearchTerms")(s, rows);
      return counts;
    },
    async upsertAdvertised(s: string, rows: unknown[]) {
      rec("upsertAdvertised")(s, rows);
      return counts;
    },
    async upsertBudgetUsage(s: string, rows: unknown[]) {
      rec("upsertBudgetUsage")(s, rows);
      return counts;
    },
    async setReportRequest(s: string, req: unknown) {
      rec("setReportRequest")(s, req);
      return { id: "req-1", status: (req as { status?: string }).status ?? "requested", adsReportId: null };
    },
    async pendingReports() {
      rec("pendingReports")();
      return pending;
    },
    async raiseAlerts(s: string | null, day?: string | null) {
      rec("raiseAlerts")(s, day);
      return [
        {
          shopId: SHOP,
          shopName: "A1 · US",
          ruleCode: "acos_over_target",
          entityKey: "campaign:1",
          severity: "amber",
          metric: 31,
          threshold: 25,
          alertId: "al-1",
          nextAction: "review_bids",
        },
      ];
    },
    async fillProfitAdsSpend(s: string) {
      rec("fillProfitAdsSpend")(s);
      return { rowsUpdated: 6, days: 7, skus: 4, unmatched: 1, currencies: ["USD"] };
    },
    async recordEvent(input: unknown) {
      rec("recordEvent")(input);
      return "evt-1";
    },
    ...over,
    __log: log,
    __pending: pending,
  };
  return db as unknown as AdsDb & { __log: typeof log; __pending: PendingAdsReport[] };
}

function syncConfig(over: Record<string, unknown> = {}) {
  return {
    region: "NA" as const,
    host: "https://advertising-api.amazon.com",
    clientId: "ads-client-id",
    clientSecret: "ads-secret",
    scope: "ads::campaign_management",
    tokenKey: KEY,
    supabase: SB,
    envRefreshToken: null,
    accountId: null,
    countryCodeHint: null,
    profileTypeHint: "seller",
    attributionDays: 7 as const,
    reportDays: 7,
    ready: true,
    problems: [],
    ...over,
  };
}

test("runAdsSync: thiếu credential Ads → dừng ngay, không gọi gì, báo đúng việc phải làm", async () => {
  const { fetchFn, calls } = adsFetch({});
  const res = await runAdsSync({ config: syncConfig({ clientId: null, clientSecret: null }) as never, db: fakeDb(), fetchFn });
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], /AMAZON_ADS_CLIENT_ID/);
  assert.equal(calls.length, 0);
  assert.equal(res.shopsProcessed, 0);
});

test("runAdsSync dry-run (không db): vẫn gọi Amazon + parse, KHÔNG ghi, báo rõ giới hạn", async () => {
  const { fetchFn, calls } = adsFetch({});
  const res = await runAdsSync({
    // dry-run không đọc DB được → token phải lấy từ AMAZON_ADS_REFRESH_TOKEN
    // (đúng tình huống user đã có sẵn refresh token Ads trong env).
    config: syncConfig({ envRefreshToken: "Atzr|env-demo" }) as never,
    db: null,
    fetchFn,
    shops: [SHOP],
    phase: "request",
    dryRun: true,
    now: () => new Date("2026-09-13T00:00:00Z"),
  });
  assert.equal(res.dryRun, true);
  assert.equal(res.db, "none");
  assert.equal(res.outcomes[0].tokenSource, "env");
  assert.equal(res.counts.created, 4, "4 loại report: campaigns/advertised/searchTerms/targeting");
  assert.equal(res.outcomes[0].profileId, "111");
  assert.ok(res.warnings.some((w) => /dry-run/.test(w)));
  // KHÔNG có call nào tới Supabase
  assert.ok(!calls.some((c) => c.url.includes("supabase")));
  // đủ 4 reportTypeId, đúng khoảng ngày kết thúc ở HÔM QUA
  const bodies = calls.filter((c) => c.url.endsWith("/reporting/reports")).map((c) => c.body as Record<string, unknown>);
  assert.equal(bodies.length, 4);
  const typeIds = bodies.map((b) => (b.configuration as Record<string, unknown>).reportTypeId).sort();
  assert.deepEqual(typeIds, ["spAdvertisedProduct", "spCampaigns", "spSearchTerm", "spTargeting"]);
  for (const b of bodies) {
    assert.equal(b.endDate, "2026-09-12");
    assert.equal(b.startDate, "2026-09-06");
  }
});

test("runAdsSync pha REQUEST: profiles → campaigns → 4 report, mỗi bước ghi trạng thái", async () => {
  const { fetchFn, calls } = adsFetch({});
  const db = fakeDb();
  const res = await runAdsSync({
    config: syncConfig() as never,
    db,
    fetchFn,
    phase: "request",
    now: () => new Date("2026-09-13T00:00:00Z"),
  });
  assert.equal(res.shopsProcessed, 1);
  assert.equal(res.counts.profiles, 1);
  assert.equal(res.counts.campaigns, 1);
  assert.equal(res.counts.created, 4);
  assert.equal(res.counts.failed, 0);
  assert.equal(res.outcomes[0].profileId, "111");
  assert.match(res.outcomes[0].profileReason, /marketplaceStringId/);

  const fns = db.__log.map((l) => l.fn);
  assert.ok(fns.includes("upsertProfiles") && fns.includes("upsertCampaigns"));
  // campaign đẩy lên phải kèm profileId + source (RPC cần biết của tài khoản nào)
  const campaigns = db.__log.find((l) => l.fn === "upsertCampaigns")!.args[1] as Record<string, unknown>[];
  assert.equal(campaigns[0].adsProfileId, "111");
  assert.equal(campaigns[0].source, "sp_campaigns_list");
  assert.deepEqual(campaigns[0].budget, { budget: 25, budgetType: "DAILY" }, "giữ nguyên nested budget của Amazon");

  // profile rows có isDefault đúng cái được chọn
  const profiles = db.__log.find((l) => l.fn === "upsertProfiles")!.args[1] as Record<string, unknown>[];
  assert.equal(profiles[0].isDefault, true);

  // mỗi loại report: ghi 'requested' TRƯỚC khi gọi Amazon, rồi cập nhật reportId
  const reqCalls = db.__log.filter((l) => l.fn === "setReportRequest");
  assert.ok(reqCalls.length >= 8, `phải có ≥8 lần ghi trạng thái (4 loại × 2), nhận ${reqCalls.length}`);
  const first = reqCalls[0].args[1] as Record<string, unknown>;
  assert.equal(first.status, "requested");
  assert.equal(first.reportTypeId, "spCampaigns");
  assert.equal(first.adsProfileId, "111");
  assert.equal(first.dateStart, "2026-09-06");
  assert.equal(first.dateEnd, "2026-09-12");
  const second = reqCalls[1].args[1] as Record<string, unknown>;
  assert.equal(second.adsReportId, "rpt-new", "phải lưu reportId để lần sau poll tiếp");

  // alert + fill F4 chạy ở cuối
  assert.equal(res.alerts, 1);
  assert.equal(res.profitRows, 6);
  assert.ok(db.__log.some((l) => l.fn === "raiseAlerts"));
  assert.ok(db.__log.some((l) => l.fn === "fillProfitAdsSpend"));
  assert.ok(
    res.outcomes[0].steps.some((s) => s.kind === "profit" && /KHÔNG khớp listings/.test(s.message)),
    "unmatched SKU phải được nói rõ, không âm thầm bỏ",
  );
  assert.ok(calls.some((c) => c.url.includes("/v2/profiles")));
});

test("runAdsSync pha POLL: report COMPLETED → tải gzip → upsertMetrics → status 'imported'", async () => {
  const { fetchFn } = adsFetch({});
  const db = fakeDb();
  db.__pending.push({
    sellerAccountId: SHOP,
    adsProfileId: "111",
    reportTypeId: "spCampaigns",
    adProduct: "SPONSORED_PRODUCTS",
    groupBy: "campaign",
    timeUnit: "DAILY",
    dateStart: "2026-09-06",
    dateEnd: "2026-09-12",
    adsReportId: "rpt-old",
    status: "requested",
    attempts: 1,
    lastError: null,
    requestedAt: "2026-09-12T04:00:00Z",
    marketplace: "ATVPDKIKX0DER",
  });

  const res = await runAdsSync({
    config: syncConfig() as never,
    db,
    fetchFn,
    phase: "poll",
    now: () => new Date("2026-09-13T00:00:00Z"),
  });
  assert.equal(res.counts.imported, 1);
  assert.equal(res.rowsImported, 1);
  assert.equal(res.shopsProcessed, 0, "pha poll không tính là xử lý shop mới");

  const metrics = db.__log.find((l) => l.fn === "upsertMetrics");
  assert.ok(metrics, "phải ghi vào vexim_worker_upsert_ads_metrics");
  const rows = metrics!.args[1] as Record<string, unknown>[];
  assert.equal(rows[0].adsProfileId, "111");
  assert.equal(rows[0].reportId, "rpt-old");
  assert.equal(rows[0].cost, 12.5, "giữ nguyên số liệu Amazon");
  assert.equal(rows[0].sales7d, 90);
  assert.equal(rows[0].source, "ads_reporting_v3");

  // budget_usage ước lượng từ chính lô campaign này
  const budget = db.__log.find((l) => l.fn === "upsertBudgetUsage");
  assert.ok(budget, "campaigns report phải sinh thêm budget_usage ước lượng");
  const brows = budget!.args[1] as Record<string, unknown>[];
  assert.equal(brows[0].percentageUsed, 50, "12.5/25 = 50%");
  assert.equal(brows[0].source, "sp_campaigns_report_estimate");
  assert.ok(res.warnings.some((w) => /ƯỚC LƯỢNG/.test(w)));

  // trạng thái report → imported, kèm số dòng + url
  const setReq = db.__log.filter((l) => l.fn === "setReportRequest");
  const last = setReq[setReq.length - 1].args[1] as Record<string, unknown>;
  assert.equal(last.status, "imported");
  assert.equal(last.rowsImported, 1);
  assert.equal(last.downloadUrl, "https://s3.example/r.gz");
  assert.ok(last.importedAt);
  // pha poll KHÔNG xin report mới
  assert.equal(res.counts.created, 0);
});

test("runAdsSync pha POLL: report RỖNG → no_data (không phải lỗi, không xin lại)", async () => {
  const { fetchFn } = adsFetch({ rows: [] });
  const db = fakeDb();
  db.__pending.push({
    sellerAccountId: SHOP,
    adsProfileId: "111",
    reportTypeId: "spSearchTerm",
    adProduct: "SPONSORED_PRODUCTS",
    groupBy: "searchTerm",
    timeUnit: "DAILY",
    dateStart: "2026-09-06",
    dateEnd: "2026-09-12",
    adsReportId: "rpt-old",
    status: "requested",
    attempts: 1,
    lastError: null,
    requestedAt: null,
    marketplace: null,
  });
  const res = await runAdsSync({ config: syncConfig() as never, db, fetchFn, phase: "poll" });
  assert.equal(res.counts.no_data, 1);
  assert.equal(res.counts.imported, 0);
  assert.equal(res.counts.failed, 0);
  const setReq = db.__log.filter((l) => l.fn === "setReportRequest");
  assert.equal((setReq[setReq.length - 1].args[1] as Record<string, unknown>).status, "no_data");
  assert.match(res.outcomes[0].steps[0].message, /RỖNG/);
});

test("runAdsSync pha POLL: còn PROCESSING → status 'processing', lần sau poll tiếp", async () => {
  const { fetchFn, calls } = adsFetch({ reportStatus: "PROCESSING" });
  const db = fakeDb();
  db.__pending.push({
    sellerAccountId: SHOP,
    adsProfileId: "111",
    reportTypeId: "spCampaigns",
    adProduct: "SPONSORED_PRODUCTS",
    groupBy: "campaign",
    timeUnit: "DAILY",
    dateStart: "2026-09-06",
    dateEnd: "2026-09-12",
    adsReportId: "rpt-old",
    status: "requested",
    attempts: 1,
    lastError: null,
    requestedAt: null,
    marketplace: null,
  });
  const res = await runAdsSync({ config: syncConfig() as never, db, fetchFn, phase: "poll" });
  assert.equal(res.counts.polled, 1);
  assert.equal(res.counts.imported, 0);
  const setReq = db.__log.filter((l) => l.fn === "setReportRequest");
  const last = setReq[setReq.length - 1].args[1] as Record<string, unknown>;
  assert.equal(last.status, "processing");
  assert.ok(!calls.some((c) => c.url.startsWith("https://s3.example")), "chưa xong thì KHÔNG tải gì cả");
  assert.match(res.outcomes[0].steps[0].message, /lần chạy sau poll tiếp/);
});

test("runAdsSync pha POLL: quá 3 lần poll mà vẫn chưa xong → failed để xin report mới", async () => {
  const { fetchFn } = adsFetch({ reportStatus: "PROCESSING" });
  const db = fakeDb();
  db.__pending.push({
    sellerAccountId: SHOP,
    adsProfileId: "111",
    reportTypeId: "spCampaigns",
    adProduct: "SPONSORED_PRODUCTS",
    groupBy: "campaign",
    timeUnit: "DAILY",
    dateStart: "2026-09-01",
    dateEnd: "2026-09-07",
    adsReportId: "rpt-old",
    status: "processing",
    attempts: 3,
    lastError: null,
    requestedAt: null,
    marketplace: null,
  });
  const res = await runAdsSync({ config: syncConfig() as never, db, fetchFn, phase: "poll" });
  assert.equal(res.counts.failed, 1);
  const setReq = db.__log.filter((l) => l.fn === "setReportRequest");
  assert.equal((setReq[setReq.length - 1].args[1] as Record<string, unknown>).status, "failed");
});

test("runAdsSync: Amazon báo FAILED → status 'failed' kèm failureReason", async () => {
  const { fetchFn } = adsFetch({
    statusBody: { reportId: "rpt-old", status: "FAILED", failureReason: "No data for the given period" },
  });
  const db = fakeDb();
  db.__pending.push({
    sellerAccountId: SHOP,
    adsProfileId: "111",
    reportTypeId: "spTargeting",
    adProduct: "SPONSORED_PRODUCTS",
    groupBy: "targeting",
    timeUnit: "DAILY",
    dateStart: "2026-09-01",
    dateEnd: "2026-09-07",
    adsReportId: "rpt-old",
    status: "requested",
    attempts: 1,
    lastError: null,
    requestedAt: null,
    marketplace: null,
  });
  const res = await runAdsSync({ config: syncConfig() as never, db, fetchFn, phase: "poll" });
  assert.equal(res.counts.failed, 1);
  const setReq = db.__log.filter((l) => l.fn === "setReportRequest");
  const last = setReq[setReq.length - 1].args[1] as Record<string, unknown>;
  assert.equal(last.status, "failed");
  assert.equal(last.failureReason, "No data for the given period");
});

test("runAdsSync: 425 (report trùng) → 'duplicate', KHÔNG đếm là failed", async () => {
  const { fetchFn } = adsFetch({ createStatus: 425, createBody: { message: "Too soon to make the additional request" } });
  const db = fakeDb();
  const res = await runAdsSync({
    config: syncConfig() as never,
    db,
    fetchFn,
    phase: "request",
    kinds: ["campaigns"],
  });
  assert.equal(res.counts.duplicate, 1);
  assert.equal(res.counts.failed, 0);
  const setReq = db.__log.filter((l) => l.fn === "setReportRequest");
  assert.equal((setReq[setReq.length - 1].args[1] as Record<string, unknown>).status, "processing");
});

test("runAdsSync: 429 → 'throttled', ghi trạng thái, KHÔNG retry trong cùng lượt", async () => {
  const { fetchFn, calls } = adsFetch({ createStatus: 429, createBody: { code: "TOO_MANY_REQUESTS" } });
  const db = fakeDb();
  const res = await runAdsSync({
    config: syncConfig() as never,
    db,
    fetchFn,
    phase: "request",
    kinds: ["campaigns"],
    raiseAlerts: false,
    fillProfit: false,
  });
  assert.equal(res.counts.throttled, 1);
  const reportPosts = calls.filter((c) => c.url.endsWith("/reporting/reports"));
  assert.equal(reportPosts.length, 1, "chỉ gọi 1 lần — retry dồn làm nghẽn hàng đợi vùng");
  const setReq = db.__log.filter((l) => l.fn === "setReportRequest");
  assert.equal((setReq[setReq.length - 1].args[1] as Record<string, unknown>).status, "throttled");
});

test("runAdsSync: shop chưa có token Ads → skipped + ghi audit, KHÔNG gọi Amazon", async () => {
  const { fetchFn, calls } = adsFetch({});
  const db = fakeDb({
    async getAdsToken() {
      return null;
    },
  } as Partial<AdsDb>);
  const res = await runAdsSync({
    config: syncConfig({ envRefreshToken: null }) as never,
    db,
    fetchFn,
    phase: "request",
  });
  assert.equal(res.counts.skipped, 1);
  assert.equal(res.counts.created, 0);
  assert.ok(!calls.some((c) => c.url.includes("/v2/profiles")), "không có token thì đừng gọi Amazon");
  assert.match(res.outcomes[0].error ?? "", /chưa có refresh token/);
  const evt = db.__log.find((l) => l.fn === "recordEvent")!.args[0] as Record<string, unknown>;
  assert.equal(evt.event, "ads_sync_no_token");
  assert.equal(evt.status, "error");
  assert.match(String(evt.detail), /module0\/connect/);
});

test("runAdsSync: không chốt được profileId → dừng shop đó, nói rõ lý do, không xin report", async () => {
  const twoProfiles = [
    { profileId: "111", countryCode: "US", accountInfo: { type: "seller", marketplaceStringId: "ATVPDKIKX0DER" } },
    { profileId: "222", countryCode: "GB", accountInfo: { type: "seller", marketplaceStringId: "A1F83G8C2ARO7P" } },
  ];
  const { fetchFn, calls } = adsFetch({});
  const db = fakeDb();
  // shop ở marketplace Đức → không profile nào khớp
  const patched = {
    ...db,
    async listShops() {
      return [{ id: SHOP, displayName: "A3 · DE", marketplace: "A1PA6795UKMFR9", status: "active", dataSource: "production" }];
    },
  } as unknown as AdsDb;
  const origFetch = fetchFn;
  const wrappedFetch = (async (url: string, init: RequestInit) => {
    if (String(url).includes("/v2/profiles")) {
      return new Response(JSON.stringify(twoProfiles), { status: 200 });
    }
    return origFetch(url as never, init as never);
  }) as unknown as typeof fetch;

  const res = await runAdsSync({ config: syncConfig() as never, db: patched, fetchFn: wrappedFetch, phase: "request" });
  assert.equal(res.counts.created, 0, "không có profileId thì KHÔNG được xin report (sẽ ghi nhầm tài khoản)");
  assert.equal(res.counts.skipped, 1);
  assert.match(res.outcomes[0].error ?? "", /Không đoán|không xác định được profile/i);
  assert.ok(!calls.some((c) => c.url.endsWith("/reporting/reports")));
});

test("runAdsSync: pollAttempts>0 thì poll ngay sau khi xin report, nhập được luôn trong 1 lượt", async () => {
  const { fetchFn } = adsFetch({
    // report tạo ra là COMPLETED luôn (report nhỏ, Amazon làm xong trong vài giây)
    createBody: { reportId: "rpt-fast", status: "COMPLETED", url: "https://s3.example/r.gz" },
    statusBody: { reportId: "rpt-fast", status: "COMPLETED", url: "https://s3.example/r.gz", rowCount: 1 },
  });
  const db = fakeDb();
  const res = await runAdsSync({
    config: syncConfig() as never,
    db,
    fetchFn,
    phase: "request",
    kinds: ["campaigns"],
    pollAttempts: 2,
    pollDelayMs: 1000,
    raiseAlerts: false,
    fillProfit: false,
  });
  assert.equal(res.counts.created, 1);
  assert.equal(res.counts.imported, 1, "nhập ngay trong cùng lượt khi Amazon đã xong");
  const metrics = db.__log.find((l) => l.fn === "upsertMetrics");
  assert.ok(metrics);
  assert.equal((metrics!.args[1] as Record<string, unknown>[])[0].reportId, "rpt-fast");
});

test("runAdsSync: campaign rỗng → no_data, không phải lỗi", async () => {
  const { fetchFn } = adsFetch({ campaignRows: [] });
  const db = fakeDb();
  const res = await runAdsSync({
    config: syncConfig() as never,
    db,
    fetchFn,
    phase: "request",
    kinds: [],
    raiseAlerts: false,
    fillProfit: false,
  });
  assert.equal(res.counts.no_data, 1);
  assert.match(res.outcomes[0].steps.find((s) => s.kind === "campaigns")!.message, /chưa có campaign/);
});

test("runAdsSync: dry-run không có shop nào để chạy → cảnh báo rõ, không im lặng trả 0", async () => {
  const { fetchFn } = adsFetch({});
  const res = await runAdsSync({ config: syncConfig() as never, db: null, fetchFn, dryRun: true });
  assert.equal(res.shopsProcessed, 0);
  assert.ok(res.warnings.some((w) => /dry-run/.test(w) && /shop/.test(w)));
});
