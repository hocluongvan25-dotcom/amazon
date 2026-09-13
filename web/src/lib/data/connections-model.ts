/**
 * Model cho Module 0 — trạng thái kết nối Amazon (view `vexim_connections` +
 * `vexim_oauth_events`, migration 0020).
 *
 * Leaf module (chỉ `import type`) nên test được bằng `node --test`.
 *
 * Hai việc chính:
 *  1. Khoá hợp đồng CỘT với view: select sai một cột là PGRST204 và sập trang
 *     /module0/connect. View trả `service = null` cho shop CHƯA có token nào
 *     (LEFT JOIN) → phải hiểu đó là "chưa kết nối", không phải lỗi.
 *  2. Biến ngày tháng thành VIỆC PHẢI LÀM: Amazon chỉ gửi email nhắc re-authorize
 *     cho CHỦ SHOP (30 ngày trước hạn), developer không nhận được gì. Nên UI phải
 *     tự đếm ngược và chỉ rõ ai cần bấm nút nào.
 *
 * TUYỆT ĐỐI không có hàm nào đụng tới token: view không phơi, model không nhận.
 */
import type { OAuthService } from "../oauth/state.ts";

export const SERVICES: readonly OAuthService[] = ["spapi", "ads"] as const;

/* ------------------------------------------------------------------ */
/* Hợp đồng cột — vexim_connections (24 cột)                          */
/* ------------------------------------------------------------------ */
export const CONNECTION_COLUMNS = [
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
] as const;

export const CONNECTION_SELECT = CONNECTION_COLUMNS.join(",");

/** Hợp đồng cột — vexim_oauth_events (8 cột). */
export const EVENT_COLUMNS = [
  "id",
  "created_at",
  "seller_account_id",
  "shop",
  "service",
  "event",
  "status",
  "detail",
] as const;

export const EVENT_SELECT = EVENT_COLUMNS.join(",");

export type ConnectionRaw = Record<string, unknown>;
export type EventRaw = Record<string, unknown>;

/** Tập giá trị `reauth_state` do view tính (mất một giá trị là UI hiện "unknown"). */
export type ReauthState =
  | "ok"
  | "due_soon"
  | "overdue"
  | "expired"
  | "revoked"
  | "error"
  | "missing"
  | "unknown";

export type Tone = "green" | "amber" | "red" | "gray";

export type ConnectionUiRow = {
  sellerAccountId: string;
  shop: string;
  sellerId: string | null;
  marketplace: string | null;
  shopStatus: string | null;
  dataSource: string | null;
  /** null = shop này chưa có token nào (LEFT JOIN trong view). */
  service: OAuthService | null;
  connected: boolean;
  tokenStatus: string | null;
  tokenSource: string | null;
  scope: string | null;
  clientId: string | null;
  sellingPartnerId: string | null;
  adsAccountId: string | null;
  authorizedAt: string | null;
  reauthorizeAt: string | null;
  reminderDays: number | null;
  reminderSentAt: string | null;
  lastRefreshAt: string | null;
  lastUsedAt: string | null;
  lastError: string | null;
  daysToReauth: number | null;
  reauthState: ReauthState;
  needsConnect: boolean;
};

export type OAuthEventUiRow = {
  id: string;
  createdAt: string;
  sellerAccountId: string | null;
  shop: string | null;
  service: OAuthService | null;
  event: string;
  status: string | null;
  detail: string | null;
};

/* ------------------------------------------------------------------ */
/* Ép kiểu an toàn: PostgREST trả số dạng chuỗi, boolean dạng thật      */
/* ------------------------------------------------------------------ */
function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function flag(v: unknown): boolean {
  return v === true || v === "true" || v === "t" || v === 1 || v === "1";
}

function service(v: unknown): OAuthService | null {
  const s = text(v);
  return s === "ads" || s === "spapi" ? s : null;
}

const REAUTH_STATES: readonly ReauthState[] = [
  "ok",
  "due_soon",
  "overdue",
  "expired",
  "revoked",
  "error",
  "missing",
  "unknown",
];

function reauthState(v: unknown): ReauthState {
  const s = text(v);
  return (REAUTH_STATES as readonly string[]).includes(s ?? "") ? (s as ReauthState) : "unknown";
}

export function mapConnectionRow(raw: ConnectionRaw): ConnectionUiRow {
  return {
    sellerAccountId: String(raw.seller_account_id ?? ""),
    shop: text(raw.shop) ?? "(chưa đặt tên shop)",
    sellerId: text(raw.seller_id),
    marketplace: text(raw.marketplace),
    shopStatus: text(raw.shop_status),
    dataSource: text(raw.data_source),
    service: service(raw.service),
    connected: flag(raw.connected),
    tokenStatus: text(raw.token_status),
    tokenSource: text(raw.token_source),
    scope: text(raw.scope),
    clientId: text(raw.client_id),
    sellingPartnerId: text(raw.selling_partner_id),
    adsAccountId: text(raw.ads_account_id),
    authorizedAt: text(raw.authorized_at),
    reauthorizeAt: text(raw.reauthorize_at),
    reminderDays: num(raw.reminder_days),
    reminderSentAt: text(raw.reminder_sent_at),
    lastRefreshAt: text(raw.last_refresh_at),
    lastUsedAt: text(raw.last_used_at),
    lastError: text(raw.last_error),
    daysToReauth: num(raw.days_to_reauth),
    reauthState: reauthState(raw.reauth_state),
    needsConnect: flag(raw.needs_connect),
  };
}

export function mapEventRow(raw: EventRaw): OAuthEventUiRow {
  return {
    id: String(raw.id ?? ""),
    createdAt: String(raw.created_at ?? ""),
    sellerAccountId: text(raw.seller_account_id),
    shop: text(raw.shop),
    service: service(raw.service),
    event: text(raw.event) ?? "unknown",
    status: text(raw.status),
    detail: text(raw.detail),
  };
}

/* ------------------------------------------------------------------ */
/* Nhãn + màu theo trạng thái                                         */
/* ------------------------------------------------------------------ */
export const SERVICE_LABEL: Record<OAuthService, string> = {
  spapi: "SP-API (đơn hàng · tồn kho · phí)",
  ads: "Ads API (PPC · báo cáo quảng cáo)",
};

export const SERVICE_SHORT: Record<OAuthService, string> = {
  spapi: "SP-API",
  ads: "Ads API",
};

export const REAUTH_LABEL: Record<ReauthState, string> = {
  ok: "Đang kết nối",
  due_soon: "Sắp tới hạn re-authorize",
  overdue: "QUÁ HẠN re-authorize",
  expired: "Token đã hết hạn",
  revoked: "Chủ shop đã thu hồi",
  error: "Lỗi khi gọi Amazon",
  missing: "Chưa kết nối",
  unknown: "Không rõ hạn",
};

export const REAUTH_TONE: Record<ReauthState, Tone> = {
  ok: "green",
  due_soon: "amber",
  overdue: "red",
  expired: "red",
  revoked: "red",
  error: "red",
  missing: "gray",
  unknown: "amber",
};

/** Vì sao trạng thái này nguy hiểm — in ngay dưới badge, không để người dùng đoán. */
export const REAUTH_HINT: Partial<Record<ReauthState, string>> = {
  due_soon:
    "Amazon chỉ gửi email nhắc cho CHỦ SHOP (30 ngày trước hạn). Quá hạn là mất quyền và KHÔNG backfill được dữ liệu cũ.",
  overdue:
    "Refresh token đã chết: mọi job đồng bộ của shop này đang dừng. Phải nhờ chủ shop bấm Re-authorize.",
  expired: "Token chết — nhờ chủ shop authorize lại, sau đó hệ thống tự đóng cảnh báo.",
  revoked: "Chủ shop đã gỡ quyền trong Seller Central → Manage your Apps. Cần authorize lại.",
  error: "Xem cột lỗi cuối cùng; nếu là invalid_grant thì phải re-authorize.",
  missing: "Chưa có refresh token → module này chưa có dữ liệu thật cho shop.",
  unknown: "Không tính được hạn re-authorize (thiếu ngày authorize) — kiểm tra lại token.",
};

/** Số ngày in kiểu người Việt: "còn 340 ngày", "QUÁ HẠN 5 ngày", "hôm nay". */
export function daysLabel(days: number | null): string {
  if (days === null) return "—";
  if (days > 0) return `còn ${days.toLocaleString("vi-VN")} ngày`;
  if (days === 0) return "hết hạn hôm nay";
  return `quá hạn ${Math.abs(days).toLocaleString("vi-VN")} ngày`;
}

/** Chữ trong ô hạn re-authorize: gộp ngày + mốc 365. */
export function reauthCell(row: ConnectionUiRow): string {
  if (row.reauthState === "missing") return "chưa kết nối";
  const left = daysLabel(row.daysToReauth);
  // Ngày hỏng/không có → chỉ in phần còn đọc được, KHÔNG in "— · còn 7 ngày".
  const when = row.reauthorizeAt ? formatDate(row.reauthorizeAt) : "—";
  if (when === "—") return left === "—" ? "không rõ hạn" : left;
  return left === "—" ? when : `${when} · ${left}`;
}

export function formatDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("vi-VN", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" });
}

export function formatDateTime(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Việc phải làm tiếp — trả null khi không cần làm gì. */
export function nextAction(row: ConnectionUiRow): string | null {
  switch (row.reauthState) {
    case "ok":
      return null;
    case "missing":
      return "Bấm Authorize để lấy refresh token (hoặc nạp token có sẵn ở ô bên dưới).";
    case "due_soon":
    case "overdue":
    case "expired":
    case "revoked":
      return "Gửi link Re-authorize cho CHỦ SHOP (link có chữ ký ở nút “Link cho chủ shop”).";
    case "error":
      return row.lastError
        ? `Lỗi Amazon: ${row.lastError.slice(0, 140)}`
        : "Có lỗi khi gọi Amazon — kiểm tra nhật ký sự kiện bên dưới.";
    default:
      return "Kiểm tra lại ngày authorize để tính hạn 365 ngày.";
  }
}

/* ------------------------------------------------------------------ */
/* Gom theo shop (mỗi shop có tối đa 2 dòng: spapi + ads)             */
/* ------------------------------------------------------------------ */
export type ShopConnection = {
  sellerAccountId: string;
  shop: string;
  marketplace: string | null;
  dataSource: string | null;
  rows: ConnectionUiRow[];
  byService: Record<OAuthService, ConnectionUiRow | null>;
  /** Trạng thái xấu nhất trong 2 service — dùng cho badge dòng + sắp xếp. */
  worstState: ReauthState;
  worstTone: Tone;
  actions: string[];
  /** Shop production chưa kết nối gì → phải lên đầu danh sách. */
  needsConnect: boolean;
};

const STATE_RANK: Record<ReauthState, number> = {
  overdue: 0,
  expired: 1,
  revoked: 2,
  error: 3,
  due_soon: 4,
  unknown: 5,
  missing: 6,
  ok: 7,
};

export function worstReauthState(states: ReauthState[]): ReauthState {
  if (states.length === 0) return "missing";
  return states.reduce((a, b) => (STATE_RANK[b] < STATE_RANK[a] ? b : a));
}

/**
 * Gom dòng theo shop. View trả 1 dòng cho MỖI cặp (shop × token); shop chưa có
 * token nào vẫn có 1 dòng với `service = null` → coi như cả 2 service đều missing.
 */
export function groupConnectionsByShop(rows: ConnectionUiRow[]): ShopConnection[] {
  const byShop = new Map<string, ConnectionUiRow[]>();
  for (const r of rows) {
    const list = byShop.get(r.sellerAccountId) ?? [];
    list.push(r);
    byShop.set(r.sellerAccountId, list);
  }

  const shops: ShopConnection[] = [];
  for (const [sellerAccountId, list] of byShop) {
    const byService: Record<OAuthService, ConnectionUiRow | null> = { spapi: null, ads: null };
    for (const r of list) {
      if (r.service) byService[r.service] = r;
    }
    const states: ReauthState[] = SERVICES.map((s) => byService[s]?.reauthState ?? "missing");
    const worst = worstReauthState(states);
    const actions: string[] = [];
    for (const s of SERVICES) {
      const row = byService[s];
      if (!row) {
        actions.push(`${SERVICE_SHORT[s]}: chưa kết nối — bấm Authorize hoặc nạp token có sẵn.`);
        continue;
      }
      const act = nextAction(row);
      if (act) actions.push(`${SERVICE_SHORT[s]}: ${act}`);
    }
    shops.push({
      sellerAccountId,
      shop: list[0]?.shop ?? "(chưa đặt tên)",
      marketplace: list.find((r) => r.marketplace)?.marketplace ?? null,
      dataSource: list.find((r) => r.dataSource)?.dataSource ?? null,
      rows: list,
      byService,
      worstState: worst,
      worstTone: REAUTH_TONE[worst],
      actions,
      needsConnect: list.some((r) => r.needsConnect),
    });
  }

  // Ưu tiên shop đang CÓ VẤN ĐỀ lên đầu; cùng mức thì theo tên để bảng không nhảy.
  return shops.sort((a, b) => {
    const rank = STATE_RANK[a.worstState] - STATE_RANK[b.worstState];
    if (rank !== 0) return rank;
    return a.shop.localeCompare(b.shop, "vi");
  });
}

export type ConnectionSummary = {
  shops: number;
  connectedTokens: number;
  ok: number;
  dueSoon: number;
  overdue: number;
  missing: number;
  errored: number;
  shopsNeedingAction: number;
  /** Số ngày gần hạn nhất (dương = còn hạn) — dùng cho KPI "gần tới hạn nhất". */
  nearestDays: number | null;
  nearestShop: string | null;
  worstTone: Tone;
};

export function summarizeConnections(rows: ConnectionUiRow[]): ConnectionSummary {
  const shops = new Set(rows.map((r) => r.sellerAccountId));
  const tokens = rows.filter((r) => r.connected);
  const withDays = tokens.filter((r) => r.daysToReauth !== null) as (ConnectionUiRow & { daysToReauth: number })[];
  const nearest = withDays.length > 0 ? withDays.reduce((a, b) => (b.daysToReauth < a.daysToReauth ? b : a)) : null;
  const grouped = groupConnectionsByShop(rows);

  return {
    shops: shops.size,
    connectedTokens: tokens.length,
    ok: tokens.filter((r) => r.reauthState === "ok").length,
    dueSoon: tokens.filter((r) => r.reauthState === "due_soon").length,
    overdue: tokens.filter((r) => ["overdue", "expired", "revoked"].includes(r.reauthState)).length,
    missing: rows.filter((r) => r.reauthState === "missing").length,
    errored: tokens.filter((r) => r.reauthState === "error").length,
    shopsNeedingAction: grouped.filter((s) => s.actions.length > 0).length,
    nearestDays: nearest?.daysToReauth ?? null,
    nearestShop: nearest ? `${nearest.shop} · ${nearest.service ? SERVICE_SHORT[nearest.service] : "?"}` : null,
    worstTone: REAUTH_TONE[worstReauthState(tokens.map((r) => r.reauthState))],
  };
}

/* ------------------------------------------------------------------ */
/* Nhật ký sự kiện OAuth                                              */
/* ------------------------------------------------------------------ */
export const EVENT_LABEL: Record<string, string> = {
  authorize_started: "Mở link authorize",
  authorize_completed: "Authorize thành công",
  authorize_denied: "Chủ shop từ chối cấp quyền",
  callback_missing_code: "Amazon trả về không kèm code",
  callback_missing_shop: "Không xác định được shop trong state",
  callback_missing_credential: "Thiếu client_id/client_secret trên server",
  state_rejected: "State không hợp lệ (chữ ký sai hoặc hết hạn)",
  state_reused: "State bị dùng lại (chống replay chặn)",
  no_refresh_token: "Amazon không trả refresh token",
  token_exchange_failed: "Đổi code lấy token thất bại",
  token_store_failed: "Lưu token thất bại",
  token_imported_from_env: "Nạp refresh token từ biến môi trường",
  token_imported_manual: "Nạp refresh token thủ công",
  token_import_failed: "Nạp refresh token thất bại",
};

export function eventLabel(event: string): string {
  return EVENT_LABEL[event] ?? event;
}

/** Sự kiện nào là TIN XẤU (đỏ) / bình thường (xanh) — không tô đỏ nhật ký thông thường. */
export const EVENT_TONE: Record<string, Tone> = {
  authorize_completed: "green",
  token_imported_from_env: "green",
  token_imported_manual: "green",
  authorize_started: "gray",
  authorize_denied: "amber",
  callback_missing_code: "amber",
  no_refresh_token: "amber",
  callback_missing_shop: "red",
  callback_missing_credential: "red",
  state_rejected: "red",
  state_reused: "red",
  token_exchange_failed: "red",
  token_store_failed: "red",
  token_import_failed: "red",
};

export function eventTone(row: OAuthEventUiRow): Tone {
  if (row.status === "error") return EVENT_TONE[row.event] === "gray" ? "red" : (EVENT_TONE[row.event] ?? "red");
  if (row.status === "ok" || row.status === "success") return EVENT_TONE[row.event] ?? "gray";
  return EVENT_TONE[row.event] ?? "gray";
}

export function eventLine(row: OAuthEventUiRow): string {
  const who = row.shop ?? (row.sellerAccountId ? "shop không rõ tên" : "không gắn shop");
  const svc = row.service ? SERVICE_SHORT[row.service] : "—";
  const detail = row.detail ? ` · ${row.detail}` : "";
  return `${who} · ${svc} · ${eventLabel(row.event)}${detail}`;
}
