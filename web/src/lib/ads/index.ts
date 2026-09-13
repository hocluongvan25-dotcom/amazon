/**
 * Barrel cho `lib/ads` — Amazon Ads API (Module 5).
 *
 * Import relative CÓ đuôi `.ts` để `node --experimental-strip-types --test` chạy
 * được các module này trực tiếp (Node ESM không tự đoán đuôi file).
 */
export {
  ADS_HOSTS,
  ADS_MEDIA,
  ADS_REPORT_MAX_DAYS,
  ADS_REPORT_RETENTION_DAYS,
  adsHostForRegion,
  loadAdsConfig,
  type AdsRuntimeConfig,
} from "./config.ts";

export {
  AdsApiError,
  AdsTokenError,
  describeAdsFailure,
  parseBadColumns,
  type AdsErrorCode,
  type AdsFailure,
  type AdsTokenErrorCode,
} from "./errors.ts";

export { AdsClient, normalizeCampaignPage, type AdsClientOptions, type SpCampaignPage } from "./client.ts";

export {
  MARKETPLACE_COUNTRY,
  countryFromMarketplace,
  normalizeProfile,
  normalizeProfileList,
  normalizeProfiles,
  pickProfile,
  toProfileRpcRows,
  type AdsProfile,
  type AdsProfileRaw,
  type PickProfileInput,
  type ProfileDecision,
} from "./profiles.ts";

export {
  ADS_REPORT_KINDS,
  REPORT_TYPE_IDS,
  RPC_FOR_KIND,
  buildReportRequest,
  clampWindowToRetention,
  classifyReportStatus,
  createReport,
  createReportWithColumnFallback,
  decorateRows,
  downloadReportRows,
  getReport,
  isAdsReportKind,
  normalizeReportTicket,
  parseReportBytes,
  parseReportText,
  reportSpec,
  reportWindow,
  type AdsReportKind,
  type CreateReportOutcome,
  type ReportRange,
  type ReportSpec,
  type ReportState,
  type ReportTicket,
} from "./reports.ts";

export { AdsTokenManager, type AdsAccessToken, type AdsTokenRow, type TokenStore } from "./tokens.ts";

export {
  ADS_RPC,
  AdsDbError,
  SHOP_SELECT,
  createAdsDb,
  type AdsAlertRow,
  type AdsDb,
  type AdsDbConfig,
  type AdsReportRequestInput,
  type AdsReportRequestRow,
  type AdsShop,
  type FillAdsSpendResult,
  type PendingAdsReport,
  type UpsertCounts,
} from "./db.ts";

export {
  budgetRowsFromCampaignRows,
  kindForReportTypeId,
  runAdsSync,
  type AdsSyncAction,
  type AdsSyncOptions,
  type AdsSyncResult,
  type AdsSyncShopResult,
  type AdsSyncStep,
} from "./sync.ts";
