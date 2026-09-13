/**
 * Test model Module 0 — trạng thái kết nối (view vexim_connections / vexim_oauth_events).
 *
 * Khoá 3 thứ hay hỏng:
 *   • hợp đồng CỘT với view 0020 (sai một cột → PGRST204, sập trang /module0/connect);
 *   • PostgREST trả số dạng CHUỖI và boolean dạng thật → map sai là đếm ngược sai;
 *   • suy luận "việc phải làm": shop chưa có token, sắp tới hạn, quá hạn — mỗi trạng
 *     thái phải chỉ ra đúng nút, và KHÔNG trạng thái nào được in ra token
 *     (view không có cột token, model cũng không được thêm).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONNECTION_COLUMNS,
  CONNECTION_SELECT,
  EVENT_COLUMNS,
  EVENT_SELECT,
  REAUTH_LABEL,
  REAUTH_TONE,
  SERVICE_SHORT,
  daysLabel,
  eventLine,
  eventTone,
  formatDate,
  formatDateTime,
  groupConnectionsByShop,
  mapConnectionRow,
  mapEventRow,
  nextAction,
  reauthCell,
  summarizeConnections,
  worstReauthState,
  type ConnectionRaw,
  type ConnectionUiRow,
} from "../src/lib/data/connections-model.ts";

const SHOP_A = "11111111-1111-4111-8111-111111111111";
const SHOP_B = "22222222-2222-4222-8222-222222222222";

function rawConn(over: Partial<ConnectionRaw> = {}): ConnectionRaw {
  return {
    seller_account_id: SHOP_A,
    shop: "A1 · US",
    seller_id: "A2XYZDEMO",
    marketplace: "ATVPDKIKX0DER",
    shop_status: "active",
    data_source: "production",
    service: "ads",
    connected: true,
    token_status: "active",
    token_source: "oauth",
    scope: "ads::campaign_management",
    client_id: "amzn1.application-oa2-client.demo",
    selling_partner_id: null,
    ads_account_id: "1234567890",
    authorized_at: "2026-09-12T03:00:00+00:00",
    reauthorize_at: "2027-09-12T03:00:00+00:00",
    reminder_days: "30",
    reminder_sent_at: null,
    last_refresh_at: "2026-09-12T04:00:00+00:00",
    last_used_at: "2026-09-12T04:00:00+00:00",
    last_error: null,
    days_to_reauth: "365",
    reauth_state: "ok",
    needs_connect: false,
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* Hợp đồng cột                                                        */
/* ------------------------------------------------------------------ */
test("CONNECTION_SELECT khớp đúng 24 cột của view vexim_connections (0020)", () => {
  const expected = [
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
  assert.deepEqual([...CONNECTION_COLUMNS], expected);
  assert.equal(CONNECTION_SELECT, expected.join(","));
  assert.equal(EVENT_SELECT, "id,created_at,seller_account_id,shop,service,event,status,detail");
  assert.equal(EVENT_COLUMNS.length, 8);
});

test("không cột nào là token/secret (chỉ token_status + token_source là cờ)", () => {
  for (const col of [...CONNECTION_COLUMNS, ...EVENT_COLUMNS]) {
    const looksSecret = /token|secret|encrypted|credential/i.test(col);
    assert.ok(
      !looksSecret || col === "token_status" || col === "token_source",
      `model không được chọn cột nhạy cảm: ${col}`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* mapRow — kiểu dữ liệu PostgREST trả về                              */
/* ------------------------------------------------------------------ */
test("mapConnectionRow ép số dạng chuỗi, boolean, và service/reauth_state lạ", () => {
  const row = mapConnectionRow(rawConn());
  assert.equal(row.sellerAccountId, SHOP_A);
  assert.equal(row.service, "ads");
  assert.equal(row.connected, true);
  assert.equal(row.reminderDays, 30);
  assert.equal(row.daysToReauth, 365);
  assert.equal(row.reauthState, "ok");
  assert.equal(row.needsConnect, false);
  assert.equal(row.lastError, null);

  const weird = mapConnectionRow(
    rawConn({
      reminder_days: 45,
      days_to_reauth: "-3",
      connected: "t",
      needs_connect: 1,
      service: "quảng cáo",
      reauth_state: "chua_biet",
      shop: "   ",
    }),
  );
  assert.equal(weird.reminderDays, 45);
  assert.equal(weird.daysToReauth, -3, "âm = quá hạn, phải giữ dấu");
  assert.equal(weird.connected, true, "'t' của Postgres là true");
  assert.equal(weird.needsConnect, true);
  assert.equal(weird.service, null, "service lạ → null, không bịa");
  assert.equal(weird.reauthState, "unknown", "giá trị lạ → unknown để UI còn kêu");
  assert.equal(weird.shop, "(chưa đặt tên shop)");
});

test("shop chưa có token: view trả service=null, connected=false, needs_connect=true", () => {
  const row = mapConnectionRow(
    rawConn({
      service: null,
      connected: false,
      token_status: null,
      token_source: null,
      scope: null,
      authorized_at: null,
      reauthorize_at: null,
      reminder_days: null,
      days_to_reauth: null,
      reauth_state: "missing",
      needs_connect: true,
    }),
  );
  assert.equal(row.service, null);
  assert.equal(row.connected, false);
  assert.equal(row.reauthState, "missing");
  assert.equal(row.needsConnect, true);
  assert.equal(row.daysToReauth, null);
});

test("mapEventRow đọc cột `status` (không phải `result`) của view", () => {
  const e = mapEventRow({
    id: "evt-1",
    created_at: "2026-09-12T03:04:05+00:00",
    seller_account_id: SHOP_A,
    shop: "A1 · US",
    service: "ads",
    event: "token_exchange_failed",
    status: "error",
    detail: "invalid_grant",
  });
  assert.equal(e.status, "error");
  assert.equal(e.event, "token_exchange_failed");
  assert.equal(e.service, "ads");
  assert.equal(e.shop, "A1 · US");
  assert.equal(e.detail, "invalid_grant");
});

/* ------------------------------------------------------------------ */
/* Đếm ngược + nhãn                                                    */
/* ------------------------------------------------------------------ */
test("daysLabel: null → '—', 0 → hôm nay, âm → quá hạn, dương → còn", () => {
  assert.equal(daysLabel(null), "—");
  assert.equal(daysLabel(365), "còn 365 ngày");
  assert.equal(daysLabel(0), "hết hạn hôm nay");
  assert.equal(daysLabel(-12), "quá hạn 12 ngày");
});

test("reauthCell ghép ngày hạn + số ngày còn lại; missing thì nói thẳng chưa kết nối", () => {
  assert.equal(reauthCell(mapConnectionRow(rawConn())), "12/09/2027 · còn 365 ngày");
  assert.equal(
    reauthCell(mapConnectionRow(rawConn({ reauth_state: "missing", reauthorize_at: null, days_to_reauth: null }))),
    "chưa kết nối",
  );
  assert.equal(
    reauthCell(mapConnectionRow(rawConn({ reauthorize_at: "rác", days_to_reauth: "7" }))),
    "còn 7 ngày",
    "ngày hỏng thì chỉ in số ngày, không in 'Invalid Date'",
  );
});

test("formatDate/formatDateTime trả '—' cho null và chuỗi hỏng (không hiện Invalid Date)", () => {
  assert.equal(formatDate(null), "—");
  assert.equal(formatDate("không phải ngày"), "—");
  assert.equal(formatDateTime(null), "—");
  assert.equal(formatDateTime("2026-09-12T03:04:05+00:00").length > 8, true);
});

test("mọi trạng thái reauth_state đều có nhãn + màu (thiếu là UI hiện chữ thô)", () => {
  const states = ["ok", "due_soon", "overdue", "expired", "revoked", "error", "missing", "unknown"] as const;
  for (const s of states) {
    assert.ok(REAUTH_LABEL[s], `thiếu nhãn cho ${s}`);
    assert.ok(["green", "amber", "red", "gray"].includes(REAUTH_TONE[s]), `thiếu màu cho ${s}`);
  }
  // trạng thái nguy hiểm phải ĐỎ, không được xanh/vàng nhạt
  assert.equal(REAUTH_TONE.overdue, "red");
  assert.equal(REAUTH_TONE.expired, "red");
  assert.equal(REAUTH_TONE.revoked, "red");
  assert.equal(REAUTH_TONE.due_soon, "amber");
  assert.equal(REAUTH_TONE.ok, "green");
});

/* ------------------------------------------------------------------ */
/* Việc phải làm                                                       */
/* ------------------------------------------------------------------ */
test("nextAction: ok → không phải làm gì; còn hạn thì null", () => {
  assert.equal(nextAction(mapConnectionRow(rawConn())), null);
});

test("nextAction: chưa kết nối → chỉ cách authorize/nạp token", () => {
  const act = nextAction(mapConnectionRow(rawConn({ reauth_state: "missing" })));
  assert.ok(act);
  assert.match(act!, /Authorize|token/);
});

test("nextAction: sắp tới hạn / quá hạn / expired / revoked → GỬI LINK CHO CHỦ SHOP", () => {
  for (const state of ["due_soon", "overdue", "expired", "revoked"]) {
    const act = nextAction(mapConnectionRow(rawConn({ reauth_state: state })));
    assert.ok(act, `${state} phải có hành động`);
    assert.match(act!, /CHỦ SHOP/i, `${state}: chỉ chủ shop mới re-authorize được`);
  }
});

test("nextAction: error thì in lỗi cuối để biết có phải invalid_grant không", () => {
  const act = nextAction(mapConnectionRow(rawConn({ reauth_state: "error", last_error: "invalid_grant: code expired" })));
  assert.match(act!, /invalid_grant/);
  const noDetail = nextAction(mapConnectionRow(rawConn({ reauth_state: "error", last_error: null })));
  assert.match(noDetail!, /nhật ký sự kiện/);
});

/* ------------------------------------------------------------------ */
/* Gom theo shop                                                       */
/* ------------------------------------------------------------------ */
test("worstReauthState xếp đúng thứ tự nghiêm trọng (quá hạn nặng nhất)", () => {
  assert.equal(worstReauthState(["ok", "due_soon"]), "due_soon");
  assert.equal(worstReauthState(["due_soon", "overdue"]), "overdue");
  assert.equal(worstReauthState(["missing", "ok"]), "missing");
  assert.equal(worstReauthState(["expired", "revoked"]), "expired");
  assert.equal(worstReauthState([]), "missing");
});

test("groupConnectionsByShop: shop đủ 2 service → 1 dòng, byService đúng cặp", () => {
  const groups = groupConnectionsByShop([
    mapConnectionRow(rawConn({ service: "ads" })),
    mapConnectionRow(rawConn({ service: "spapi", reauth_state: "due_soon", days_to_reauth: "12" })),
  ]);
  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.equal(g.shop, "A1 · US");
  assert.equal(g.byService.ads?.service, "ads");
  assert.equal(g.byService.spapi?.service, "spapi");
  assert.equal(g.worstState, "due_soon", "một service sắp hết hạn là cả shop phải nhắc");
  assert.equal(g.worstTone, "amber");
  assert.equal(g.actions.length, 1);
  assert.match(g.actions[0], /^SP-API: /);
});

test("groupConnectionsByShop: shop chưa có token (service=null) → cả 2 service missing", () => {
  const groups = groupConnectionsByShop([
    mapConnectionRow(
      rawConn({
        seller_account_id: SHOP_B,
        shop: "B2 · UK",
        service: null,
        connected: false,
        reauth_state: "missing",
        needs_connect: true,
      }),
    ),
  ]);
  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.equal(g.byService.ads, null);
  assert.equal(g.byService.spapi, null);
  assert.equal(g.worstState, "missing");
  assert.equal(g.needsConnect, true);
  assert.equal(g.actions.length, 2, "phải báo cho cả 2 service");
  assert.ok(g.actions.some((a) => a.startsWith(`${SERVICE_SHORT.spapi}: `)));
  assert.ok(g.actions.some((a) => a.startsWith(`${SERVICE_SHORT.ads}: `)));
});

test("groupConnectionsByShop: shop QUÁ HẠN xếp trên shop bình thường", () => {
  const groups = groupConnectionsByShop([
    mapConnectionRow(rawConn({ seller_account_id: SHOP_A, shop: "AAA ổn", reauth_state: "ok" })),
    mapConnectionRow(
      rawConn({
        seller_account_id: SHOP_B,
        shop: "ZZZ chết token",
        reauth_state: "overdue",
        days_to_reauth: "-5",
      }),
    ),
  ]);
  assert.equal(groups[0].shop, "ZZZ chết token", "shop đang cháy phải lên đầu dù tên xếp sau");
  assert.equal(groups[0].worstTone, "red");
  // Shop "ổn" mới chỉ nối Ads, chưa có SP-API → worst vẫn là missing (còn việc phải làm).
  assert.equal(groups[1].worstState, "missing");
  assert.equal(groups[1].byService.ads?.reauthState, "ok");
});

test("summarizeConnections: đếm đúng và tìm token gần tới hạn nhất", () => {
  const rows: ConnectionUiRow[] = [
    mapConnectionRow(rawConn({ seller_account_id: SHOP_A, service: "ads", days_to_reauth: "340" })),
    mapConnectionRow(
      rawConn({
        seller_account_id: SHOP_A,
        service: "spapi",
        reauth_state: "due_soon",
        days_to_reauth: "9",
      }),
    ),
    mapConnectionRow(
      rawConn({
        seller_account_id: SHOP_B,
        shop: "B2 · UK",
        service: null,
        connected: false,
        reauth_state: "missing",
        needs_connect: true,
      }),
    ),
  ];
  const s = summarizeConnections(rows);
  assert.equal(s.shops, 2);
  assert.equal(s.connectedTokens, 2);
  assert.equal(s.ok, 1);
  assert.equal(s.dueSoon, 1);
  assert.equal(s.overdue, 0);
  assert.equal(s.missing, 1);
  assert.equal(s.errored, 0);
  assert.equal(s.nearestDays, 9, "phải lấy token GẦN hạn nhất, không phải trung bình");
  assert.equal(s.nearestShop, "A1 · US · SP-API");
  assert.equal(s.shopsNeedingAction, 2);
  assert.equal(s.worstTone, "amber");
});

/* ------------------------------------------------------------------ */
/* Nhật ký sự kiện                                                     */
/* ------------------------------------------------------------------ */
test("eventTone: sự kiện thành công xanh, thất bại đỏ, bắt đầu xám", () => {
  const tone = (event: string, status: string | null) =>
    eventTone(mapEventRow({ id: "x", created_at: "", service: "ads", event, status }));
  assert.equal(tone("authorize_completed", "ok"), "green");
  assert.equal(tone("token_imported_from_env", "ok"), "green");
  assert.equal(tone("token_exchange_failed", "error"), "red");
  assert.equal(tone("state_reused", "error"), "red");
  assert.equal(tone("authorize_denied", "error"), "amber");
  assert.equal(tone("authorize_started", null), "gray");
  // sự kiện lạ nhưng status=error → đỏ (không được im lặng)
  assert.equal(tone("something_new", "error"), "red");
});

test("eventLine: shop · dịch vụ · nhãn tiếng Việt · chi tiết; event lạ thì in nguyên văn", () => {
  const line = eventLine(
    mapEventRow({
      id: "x",
      created_at: "",
      seller_account_id: SHOP_A,
      shop: "A1 · US",
      service: "ads",
      event: "token_exchange_failed",
      status: "error",
      detail: "invalid_grant",
    }),
  );
  assert.equal(line, "A1 · US · Ads API · Đổi code lấy token thất bại · invalid_grant");

  const unknown = eventLine(
    mapEventRow({ id: "y", created_at: "", seller_account_id: null, shop: null, service: null, event: "evt_moi" }),
  );
  assert.match(unknown, /evt_moi/, "event chưa có nhãn thì in nguyên văn để còn truy vết");
  assert.match(unknown, /không gắn shop/);
});
