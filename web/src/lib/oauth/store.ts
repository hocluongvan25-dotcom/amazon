/**
 * Ghi/đọc dữ liệu OAuth qua PostgREST bằng SERVICE ROLE (Module 0).
 *
 * Vì sao không dùng @supabase/supabase-js:
 *   • `connections.oauth_tokens` KHÔNG có policy SELECT cho client (chủ đích của
 *     0001, giữ nguyên ở 0020) → chỉ service_role bypass RLS mới đọc/ghi được.
 *   • Route handler gọi thẳng REST + RPC, giống web/src/lib/worker/db/supabase.ts
 *     (một pattern duy nhất trong repo, dễ soát).
 *
 * RPC dùng ở đây (migration 0020):
 *   vexim_oauth_upsert_token(jsonb)      → lưu token ĐÃ mã hoá (enc:v1:…)
 *   vexim_oauth_record_event(jsonb)      → audit từng bước luồng OAuth
 *   vexim_oauth_set_state(jsonb)         → ghi state (một lần dùng)
 *   vexim_oauth_consume_state(text,text) → đổi state lấy shop/service
 *   vexim_oauth_reauth_scan(int,text)    → quét hạn re-authorize 365 ngày
 *   vexim_connections (view)             → trạng thái kết nối, KHÔNG có cột token
 */
import type { OAuthService } from "./state.ts";

export type SupabaseAdminConfig = {
  url: string;
  serviceRoleKey: string;
};

export type UpsertTokenInput = {
  sellerAccountId: string;
  service: OAuthService;
  /** ĐÃ mã hoá bằng encryptToken() — RPC từ chối plaintext. */
  encryptedRefreshToken: string;
  authorizedAt?: string;
  expiresAt?: string;
  reauthorizeAt?: string;
  clientId?: string;
  scope?: string;
  sellingPartnerId?: string;
  adsAccountId?: string;
  tokenSource?: "oauth" | "env" | "manual";
  authorizedBy?: string;
  status?: "active" | "expired" | "revoked" | "error";
  reminderDays?: number;
};

export type UpsertTokenResult = {
  id: string;
  service: OAuthService;
  status: string;
  reauthorizeAt: string | null;
  daysToReauth: number | null;
};

/**
 * PostgREST trả ĐÚNG tên cột SQL (snake_case) — phải map sang camelCase trước khi
 * đưa lên UI. Ba kiểu Raw dưới đây là "hợp đồng" với migration 0020; đổi tên cột
 * trong view/RPC là phải sửa ở đây (tests/oauth.test.ts khoá hợp đồng này).
 */
type UpsertTokenRow = {
  id: string;
  service?: string;
  status?: string;
  reauthorize_at?: string | null;
  days_to_reauth?: number | string | null;
};

type ConsumeStateRow = {
  service?: string;
  seller_account_id?: string | null;
  redirect_uri?: string | null;
  expired?: boolean | string;
  already_used?: boolean | string;
};

type ReauthScanRowRaw = {
  shop_id: string;
  shop_name?: string | null;
  token_service?: string;
  token_status?: string | null;
  days_to_reauth?: number | string | null;
  alert_severity?: string | null;
  alert_id?: string | null;
  next_action?: string | null;
};

export type ConsumeStateResult = {
  service: OAuthService;
  sellerAccountId: string | null;
  redirectUri: string | null;
  expired: boolean;
  alreadyUsed: boolean;
};

export type ReauthScanRow = {
  shopId: string;
  shopName: string | null;
  tokenService: OAuthService;
  tokenStatus: string | null;
  daysToReauth: number | null;
  alertSeverity: "amber" | "red" | null;
  alertId: string | null;
  nextAction: string | null;
};

export type ConnectionRow = {
  sellerAccountId: string;
  shop: string;
  sellerId: string | null;
  marketplace: string | null;
  shopStatus: string | null;
  dataSource: string | null;
  service: OAuthService;
  connected: boolean;
  tokenStatus: string | null;
  tokenSource: string | null;
  scope: string | null;
  sellingPartnerId: string | null;
  adsAccountId: string | null;
  authorizedAt: string | null;
  reauthorizeAt: string | null;
  reminderDays: number | null;
  reminderSentAt: string | null;
  lastRefreshAt: string | null;
  lastError: string | null;
  daysToReauth: number | null;
  reauthState: "ok" | "due_soon" | "overdue" | "expired" | "revoked" | "error" | "missing" | "unknown";
  needsConnect: boolean;
};

export type OAuthStore = {
  upsertToken(input: UpsertTokenInput): Promise<UpsertTokenResult>;
  recordEvent(input: {
    sellerAccountId?: string | null;
    service: OAuthService;
    event: string;
    status?: "ok" | "error";
    detail?: string;
    actorId?: string | null;
  }): Promise<string | null>;
  setState(input: {
    state: string;
    service: OAuthService;
    sellerAccountId?: string | null;
    redirectUri?: string | null;
    scope?: string | null;
    actorId?: string | null;
    sellerHint?: string | null;
    expiresAt?: string | null;
  }): Promise<void>;
  consumeState(state: string, result: string): Promise<ConsumeStateResult>;
  scanReauth(input?: { noticeDays?: number; service?: OAuthService | null }): Promise<ReauthScanRow[]>;
  listConnections(input?: { shopId?: string | null }): Promise<ConnectionRow[]>;
};

/** Lỗi có mã để route phân biệt "chưa chạy migration" với "sai dữ liệu". */
export class OAuthStoreError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "store_error", status = 500) {
    super(message);
    this.name = "OAuthStoreError";
    this.code = code;
    this.status = status;
  }
}

const RPC = {
  upsertToken: "vexim_oauth_upsert_token",
  recordEvent: "vexim_oauth_record_event",
  setState: "vexim_oauth_set_state",
  consumeState: "vexim_oauth_consume_state",
  reauthScan: "vexim_oauth_reauth_scan",
} as const;

const CONNECTIONS_SELECT = [
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
  "selling_partner_id",
  "ads_account_id",
  "authorized_at",
  "reauthorize_at",
  "reminder_days",
  "reminder_sent_at",
  "last_refresh_at",
  "last_error",
  "days_to_reauth",
  "reauth_state",
  "needs_connect",
].join(",");

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s || null;
}

function bool(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}

export function createOAuthStore(config: SupabaseAdminConfig, fetchFn: typeof fetch = fetch): OAuthStore {
  const base = config.url.replace(/\/+$/, "");

  async function rpc<T>(fn: string, body: unknown): Promise<T> {
    const res = await fetchFn(`${base}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        // RPC nằm trong schema public → không cần Content-Profile.
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 500);
      try {
        const json = JSON.parse(text) as { message?: string; code?: string; hint?: string };
        detail = [json.message, json.hint].filter(Boolean).join(" · ") || detail;
        if (json.code === "PGRST202") {
          throw new OAuthStoreError(
            `RPC ${fn} chưa tồn tại — migration 0020 chưa chạy trên project này. ${detail}`,
            "missing_rpc",
            500,
          );
        }
      } catch (e) {
        if (e instanceof OAuthStoreError) throw e;
      }
      throw new OAuthStoreError(`RPC ${fn} lỗi HTTP ${res.status}: ${detail}`, "rpc_failed", res.status);
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  async function select<T>(path: string, query: URLSearchParams): Promise<T[]> {
    const res = await fetchFn(`${base}/rest/v1/${path}?${query.toString()}`, {
      method: "GET",
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });
    const text = await res.text();
    if (!res.ok) {
      throw new OAuthStoreError(`Đọc ${path} lỗi HTTP ${res.status}: ${text.slice(0, 400)}`, "select_failed", res.status);
    }
    const json = JSON.parse(text) as T[];
    return Array.isArray(json) ? json : [];
  }

  return {
    async upsertToken(input) {
      const rows = await rpc<UpsertTokenRow[] | UpsertTokenRow>(RPC.upsertToken, {
        p_payload: {
          sellerAccountId: input.sellerAccountId,
          service: input.service,
          encryptedRefreshToken: input.encryptedRefreshToken,
          authorizedAt: input.authorizedAt,
          expiresAt: input.expiresAt,
          reauthorizeAt: input.reauthorizeAt,
          clientId: input.clientId,
          scope: input.scope,
          sellingPartnerId: input.sellingPartnerId,
          adsAccountId: input.adsAccountId,
          tokenSource: input.tokenSource ?? "oauth",
          authorizedBy: input.authorizedBy,
          status: input.status ?? "active",
          reminderDays: input.reminderDays ?? 30,
        },
      });
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (!row?.id) throw new OAuthStoreError("vexim_oauth_upsert_token không trả về id token", "bad_response");
      return {
        id: String(row.id),
        service: (String(row.service ?? input.service) as OAuthService),
        status: String(row.status ?? "active"),
        reauthorizeAt: str(row.reauthorize_at),
        daysToReauth: num(row.days_to_reauth),
      };
    },

    async recordEvent(input) {
      try {
        const id = await rpc<string | null>(RPC.recordEvent, {
          p_payload: {
            sellerAccountId: input.sellerAccountId ?? undefined,
            service: input.service,
            event: input.event,
            status: input.status ?? "ok",
            detail: input.detail,
            actorId: input.actorId ?? undefined,
          },
        });
        return str(id);
      } catch {
        // Audit KHÔNG được làm hỏng luồng chính: lỗi ghi event thì bỏ qua,
        // route vẫn trả kết quả authorize cho chủ shop.
        return null;
      }
    },

    async setState(input) {
      await rpc<string>(RPC.setState, {
        p_payload: {
          state: input.state,
          service: input.service,
          sellerAccountId: input.sellerAccountId ?? undefined,
          redirectUri: input.redirectUri ?? undefined,
          scope: input.scope ?? undefined,
          actorId: input.actorId ?? undefined,
          sellerHint: input.sellerHint ?? undefined,
          expiresAt: input.expiresAt ?? undefined,
        },
      });
    },

    async consumeState(state, result) {
      const rows = await rpc<ConsumeStateRow[]>(RPC.consumeState, {
        p_state: state,
        p_result: result,
      });
      const row = Array.isArray(rows) ? rows[0] : (rows as unknown as ConsumeStateRow);
      return {
        service: (String(row?.service ?? "spapi") as OAuthService),
        sellerAccountId: str(row?.seller_account_id),
        redirectUri: str(row?.redirect_uri),
        expired: bool(row?.expired),
        alreadyUsed: bool(row?.already_used),
      };
    },

    async scanReauth(input = {}) {
      const rows = await rpc<ReauthScanRowRaw[]>(RPC.reauthScan, {
        p_notice_days: input.noticeDays ?? 30,
        p_service: input.service ?? null,
      });
      if (!Array.isArray(rows)) return [];
      return rows.map((r) => ({
        shopId: String(r.shop_id),
        shopName: str(r.shop_name),
        tokenService: String(r.token_service) as OAuthService,
        tokenStatus: str(r.token_status),
        daysToReauth: num(r.days_to_reauth),
        alertSeverity: (str(r.alert_severity) as "amber" | "red" | null) ?? null,
        alertId: str(r.alert_id),
        nextAction: str(r.next_action),
      }));
    },

    async listConnections(input = {}) {
      const query = new URLSearchParams({ select: CONNECTIONS_SELECT, order: "shop.asc,service.asc" });
      if (input.shopId) query.set("seller_account_id", `eq.${input.shopId}`);
      const rows = await select<Record<string, unknown>>("vexim_connections", query);
      return rows.map((r) => ({
        sellerAccountId: String(r.seller_account_id),
        shop: String(r.shop ?? ""),
        sellerId: str(r.seller_id),
        marketplace: str(r.marketplace),
        shopStatus: str(r.shop_status),
        dataSource: str(r.data_source),
        service: String(r.service) as OAuthService,
        connected: bool(r.connected),
        tokenStatus: str(r.token_status),
        tokenSource: str(r.token_source),
        scope: str(r.scope),
        sellingPartnerId: str(r.selling_partner_id),
        adsAccountId: str(r.ads_account_id),
        authorizedAt: str(r.authorized_at),
        reauthorizeAt: str(r.reauthorize_at),
        reminderDays: num(r.reminder_days),
        reminderSentAt: str(r.reminder_sent_at),
        lastRefreshAt: str(r.last_refresh_at),
        lastError: str(r.last_error),
        daysToReauth: num(r.days_to_reauth),
        reauthState: String(r.reauth_state ?? "missing") as ConnectionRow["reauthState"],
        needsConnect: bool(r.needs_connect),
      }));
    },
  };
}
