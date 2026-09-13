/**
 * AdsTokenManager — lấy access token Ads API cho TỪNG SHOP (Module 0 nuôi, Module 5 dùng).
 *
 * Nguyên tắc:
 *   • Refresh token nằm trong DB ở dạng MÃ HOÁ (enc:v1:, AES-256-GCM). Manager giải
 *     mã trong bộ nhớ, đổi lấy access token 1 giờ, rồi CACHE TRONG TIẾN TRÌNH.
 *   • KHÔNG lưu access token xuống DB: nó là bearer credential sống 1 giờ; lưu ra là
 *     thêm một chỗ có thể rò. Mỗi lần cron chạy (tiến trình mới) → 1 call LWA/shop.
 *     LWA cho phép vậy, và trần tốc độ token endpoint không phải vấn đề ở tần suất này.
 *   • Shop chưa có token trong DB → fallback AMAZON_ADS_REFRESH_TOKEN (đúng chỉ đạo:
 *     code phải đọc được token Ads có sẵn), kèm CẢNH BÁO vì token env không gắn shop
 *     nào: dữ liệu sẽ vào shop được chỉ định, không tự nhân bản sang shop khác.
 *   • invalid_grant → đánh dấu token 'expired' trong DB + nói rõ là CHỦ SHOP phải bấm
 *     Re-authorize (mình không tự sửa được). 429 → retryable, KHÔNG đổi trạng thái.
 */
import { decryptToken, TokenCryptoError } from "../oauth/crypto.ts";
import { refreshAccessToken, type AmazonRegion } from "../oauth/lwa.ts";
import { AdsTokenError } from "./errors.ts";

/** Một dòng connections.oauth_tokens (service='ads') — chỉ field manager cần. */
export type AdsTokenRow = {
  id: string;
  sellerAccountId: string;
  encryptedRefreshToken: string;
  status: string | null;
  expiresAt: string | null;
  reauthorizeAt: string | null;
  lastRefreshAt: string | null;
  lastError: string | null;
  clientId: string | null;
  scope: string | null;
  adsAccountId: string | null;
};

export type TokenStore = {
  getAdsToken(shopId: string): Promise<AdsTokenRow | null>;
  /** Cập nhật last_refresh_at / last_error / status sau mỗi lần đổi token. */
  touchAdsToken(
    id: string,
    patch: { lastRefreshAt?: string; lastError?: string | null; status?: string },
  ): Promise<void>;
};

export type AdsAccessToken = {
  accessToken: string;
  expiresAt: Date;
  /** db = token của riêng shop · env = token chung từ biến môi trường. */
  source: "db" | "env";
  tokenId: string | null;
  shopId: string;
  /** client_id dùng khi đổi token (token của app nào phải đổi bằng app đó). */
  clientId: string;
  scope: string | null;
  /** ads_account_id đã lưu (nếu có) — dùng làm gợi ý profileId. */
  adsAccountId: string | null;
};

export type AdsTokenManagerConfig = {
  clientId: string;
  clientSecret: string;
  region: AmazonRegion;
  tokenKey: string | null;
  envRefreshToken: string | null;
  tokenUrl?: string | null;
};

type CacheEntry = { token: AdsAccessToken; expiresAt: number };

/** Đổi token trước hạn thật 60s để không dính token chết giữa chừng một lô gọi. */
const SAFETY_MS = 60_000;

export class AdsTokenManager {
  private readonly cfg: AdsTokenManagerConfig;
  private readonly store: TokenStore | null;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly cache = new Map<string, CacheEntry>();
  /** Cảnh báo tích luỹ (token env, self-heal…) để cron in ra log. */
  readonly warnings: string[] = [];

  constructor(
    cfg: AdsTokenManagerConfig,
    opts: { store?: TokenStore | null; fetchFn?: typeof fetch; now?: () => Date } = {},
  ) {
    this.cfg = cfg;
    this.store = opts.store ?? null;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  /** Bỏ cache (sau khi đánh dấu token chết, hoặc muốn ép đổi token mới). */
  invalidate(shopId: string): void {
    this.cache.delete(shopId);
  }

  async accessToken(shopId: string, opts: { force?: boolean } = {}): Promise<AdsAccessToken> {
    const nowMs = this.now().getTime();
    if (!opts.force) {
      const hit = this.cache.get(shopId);
      if (hit && hit.expiresAt > nowMs + SAFETY_MS) return hit.token;
    }

    const row = this.store ? await this.store.getAdsToken(shopId) : null;

    // ---- 1. Token trong DB (đúng luồng multi-tenant) -------------------------
    if (row) {
      if ((row.status ?? "").toLowerCase() === "revoked") {
        throw new AdsTokenError(
          "token_revoked",
          `Token Ads của shop ${shopId} đã bị thu hồi (revoked).`,
          {
            shopId,
            hint: "Chủ shop đã gỡ quyền trong Seller Central/Advertising Console → phải authorize lại từ /module0/connect.",
          },
        );
      }
      const expiredMarked = (row.status ?? "").toLowerCase() === "expired";
      const reauthAt = row.reauthorizeAt ? new Date(row.reauthorizeAt).getTime() : null;
      const pastReauth = reauthAt !== null && reauthAt <= nowMs;
      if (expiredMarked && pastReauth) {
        throw new AdsTokenError(
          "token_expired",
          `Token Ads của shop ${shopId} đã quá hạn re-authorize (${row.reauthorizeAt?.slice(0, 10) ?? "?"}).`,
          {
            shopId,
            hint:
              "Amazon bắt re-authorize mỗi 365 ngày và chỉ email nhắc cho CHỦ SHOP. " +
              "Gửi link ở /module0/connect cho chủ shop bấm; cron tự đóng cảnh báo sau khi có token mới.",
          },
        );
      }

      if (!this.cfg.tokenKey) {
        throw new AdsTokenError(
          "decrypt_failed",
          "Không có OAUTH_TOKEN_ENC_KEY nên không giải mã được refresh token trong DB.",
          {
            shopId,
            hint: 'Đặt OAUTH_TOKEN_ENC_KEY ĐÚNG khoá đã dùng khi lưu (mất khoá = phải authorize lại). Sinh khoá: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
          },
        );
      }

      let refreshToken = "";
      try {
        refreshToken = decryptToken(row.encryptedRefreshToken, this.cfg.tokenKey);
      } catch (e) {
        const detail = e instanceof TokenCryptoError ? `${e.code}: ${e.message}` : (e as Error).message;
        await this.safeTouch(row.id, { lastError: `decrypt_failed — ${detail}`.slice(0, 400), status: "error" });
        throw new AdsTokenError("decrypt_failed", `Không giải mã được refresh token của shop ${shopId}.`, {
          shopId,
          hint:
            "Nhiều khả năng OAUTH_TOKEN_ENC_KEY đã đổi sau khi lưu token. " +
            "Cách sửa: đặt lại khoá cũ, HOẶC nhờ chủ shop authorize lại để lưu bằng khoá mới.",
        });
      }

      const clientId = row.clientId?.trim() || this.cfg.clientId;
      const token = await this.refresh(shopId, refreshToken, {
        clientId,
        source: "db",
        tokenId: row.id,
        scope: row.scope,
        adsAccountId: row.adsAccountId,
      });
      await this.safeTouch(row.id, { lastRefreshAt: this.now().toISOString(), lastError: null, status: "active" });
      if (expiredMarked) {
        this.warnings.push(
          `Shop ${shopId}: token từng bị đánh dấu 'expired' nhưng refresh vẫn được → đã tự đặt lại 'active' ` +
            `(reauthorize_at ${row.reauthorizeAt?.slice(0, 10) ?? "?"} chưa tới).`,
        );
      }
      return token;
    }

    // ---- 2. Fallback: refresh token trong env (bootstrap, chưa shop nào authorize)
    if (this.cfg.envRefreshToken) {
      this.warnings.push(
        `Shop ${shopId} chưa có token Ads trong DB → dùng AMAZON_ADS_REFRESH_TOKEN từ env. ` +
          `Token này KHÔNG gắn shop: dữ liệu ghi vào shop đang xử lý. Nên nạp chính thức bằng ` +
          `POST /api/amazon/oauth/import {service:"ads", source:"env"} để có hạn re-authorize + audit.`,
      );
      return this.refresh(shopId, this.cfg.envRefreshToken, { source: "env", tokenId: null });
    }

    throw new AdsTokenError(
      "no_token",
      `Shop ${shopId} chưa có refresh token Ads API (DB trống, AMAZON_ADS_REFRESH_TOKEN cũng không có).`,
      {
        shopId,
        hint:
          "Bấm Authorize ở /module0/connect (Ads API) để chủ shop cấp quyền, " +
          'hoặc POST /api/amazon/oauth/import {"service":"ads","source":"env"} nếu đã có token sẵn.',
      },
    );
  }

  private async refresh(
    shopId: string,
    refreshToken: string,
    meta: { clientId?: string; source: "db" | "env"; tokenId: string | null; scope?: string | null; adsAccountId?: string | null },
  ): Promise<AdsAccessToken> {
    const clientId = meta.clientId ?? this.cfg.clientId;
    let res;
    try {
      res = await refreshAccessToken({
        refreshToken,
        region: this.cfg.region,
        clientId,
        clientSecret: this.cfg.clientSecret,
        tokenUrl: this.cfg.tokenUrl,
        fetchFn: this.fetchFn,
      });
    } catch (e) {
      const lwa = (e as { lwa?: { code: string; status: number; message: string; retryable: boolean } }).lwa;
      const message = lwa?.message ?? (e as Error).message;
      if (lwa?.code === "invalid_grant") {
        if (meta.tokenId) {
          await this.safeTouch(meta.tokenId, {
            status: "expired",
            lastError: `LWA invalid_grant — ${message}`.slice(0, 400),
          });
        }
        this.invalidate(shopId);
        throw new AdsTokenError("refresh_failed", `LWA từ chối refresh token của shop ${shopId}: ${message}`, {
          shopId,
          hint:
            "invalid_grant nghĩa là refresh token đã chết (quá 365 ngày hoặc chủ shop gỡ quyền). " +
            "Đã đánh dấu token 'expired' trong DB — cần chủ shop Re-authorize, không tự sửa được.",
        });
      }
      throw new AdsTokenError(
        "refresh_failed",
        `Đổi access token Ads thất bại cho shop ${shopId}: ${message}`,
        {
          shopId,
          retryable: !!lwa?.retryable,
          hint: lwa?.retryable
            ? "LWA đang chặn tốc độ (429) — cron bỏ qua lượt này, KHÔNG retry dồn."
            : "Kiểm tra AMAZON_ADS_CLIENT_ID/SECRET có đúng bộ của Ads API không (KHÔNG dùng chung với SP-API) và AMAZON_ADS_REGION có khớp vùng token không.",
        },
      );
    }

    if (!res.access_token) {
      throw new AdsTokenError("refresh_failed", `LWA trả 200 nhưng không có access_token cho shop ${shopId}.`, {
        shopId,
        hint: "Phản hồi lạ — kiểm tra client_id/secret.",
      });
    }

    const ttlSec = Number.isFinite(res.expires_in) ? res.expires_in : 3600;
    const token: AdsAccessToken = {
      accessToken: res.access_token,
      expiresAt: new Date(this.now().getTime() + ttlSec * 1000),
      source: meta.source,
      tokenId: meta.tokenId,
      shopId,
      clientId,
      scope: meta.scope ?? null,
      adsAccountId: meta.adsAccountId ?? null,
    };
    this.cache.set(shopId, { token, expiresAt: token.expiresAt.getTime() });
    return token;
  }

  /** Ghi trạng thái token; lỗi ghi DB KHÔNG được chặn luồng lấy token. */
  private async safeTouch(id: string, patch: { lastRefreshAt?: string; lastError?: string | null; status?: string }) {
    if (!this.store) return;
    try {
      await this.store.touchAdsToken(id, patch);
    } catch (e) {
      this.warnings.push(`Không cập nhật được oauth_tokens (${id}): ${(e as Error).message}`.slice(0, 300));
    }
  }
}
