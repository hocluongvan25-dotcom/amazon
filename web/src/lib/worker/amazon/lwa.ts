/**
 * Login with Amazon (LWA) — lấy access token cho SP-API.
 * SP-API (ứng dụng mới) chỉ cần LWA Bearer token, không cần AWS SigV4.
 * Rate limit token endpoint: đừng gọi dồn dập — cache token tới gần hạn.
 */
const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

export type LwaCredentials = {
  clientId: string;
  clientSecret: string;
  /** refresh token của seller (OAuth authorize); thiếu = grantless ops */
  refreshToken?: string;
};

export type AccessToken = { accessToken: string; expiresAt: Date };

export class LwaTokenManager {
  private cached: AccessToken | null = null;
  private readonly creds: LwaCredentials;
  private readonly fetchFn: typeof fetch;

  constructor(creds: LwaCredentials, fetchFn: typeof fetch = fetch) {
    this.creds = creds;
    this.fetchFn = fetchFn;
  }

  /** grant_type=client_credentials (grantless) hoặc refresh_token (seller scope) */
  async getAccessToken(force = false): Promise<string> {
    if (!force && this.cached && this.cached.expiresAt > new Date(Date.now() + 60_000)) {
      return this.cached.accessToken;
    }
    const body = new URLSearchParams({
      grant_type: this.creds.refreshToken ? "refresh_token" : "client_credentials",
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
    });
    if (this.creds.refreshToken) body.set("refresh_token", this.creds.refreshToken);

    const res = await this.fetchFn(LWA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      throw new Error(`LWA token lỗi HTTP ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.cached = {
      accessToken: json.access_token,
      expiresAt: new Date(Date.now() + json.expires_in * 1000),
    };
    return this.cached.accessToken;
  }
}
