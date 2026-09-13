/**
 * Module 0 — OAuth & multi-tenant: một chỗ import duy nhất.
 *
 *   import { loadOAuthConfig, createState, encryptToken } from "@/lib/oauth";
 *
 * CHỈ dùng ở server (route handler / server component / worker). Không file nào
 * trong này được import vào client component: chúng đụng crypto + service role key.
 */
export {
  TOKEN_CIPHER_PREFIX,
  TokenCryptoError,
  decryptToken,
  deriveTokenKey,
  encryptToken,
  isEncryptedToken,
  looksLikePlainRefreshToken,
  safeEqual,
  suggestTokenKey,
} from "./crypto.ts";

export {
  OAUTH_SERVICES,
  SERVICE_LABEL,
  STATE_TTL_SECONDS,
  createState,
  isOAuthService,
  peekState,
  readState,
  sanitizeRedirect,
  type OAuthService,
  type OAuthStateClaims,
  type StateReadResult,
} from "./state.ts";

export {
  ADS_SCOPE,
  AMAZON_REGIONS,
  SPAPI_SCOPE,
  asAmazonRegion,
  authorizeEndpoint,
  buildAuthorizeUrl,
  consentEndpoint,
  describeLwaFailure,
  exchangeAuthorizationCode,
  pickAuthorizationCode,
  refreshAccessToken,
  tokenEndpoint,
  type AmazonRegion,
  type AuthorizeLinkInput,
  type LwaError,
  type LwaTokenResponse,
} from "./lwa.ts";

export {
  DEFAULT_REDIRECT_PATH,
  loadOAuthConfig,
  requireOAuthConfig,
  resolveBaseUrl,
  resolveRedirectUri,
  type OAuthConfig,
  type OAuthServiceConfig,
} from "./config.ts";

export {
  OAuthStoreError,
  createOAuthStore,
  type ConnectionRow,
  type ConsumeStateResult,
  type OAuthStore,
  type ReauthScanRow,
  type SupabaseAdminConfig,
  type UpsertTokenInput,
  type UpsertTokenResult,
} from "./store.ts";

export {
  buildStartLink,
  startLinkSignature,
  verifyStartLinkSignature,
  type StartLinkParts,
} from "./start-link.ts";
