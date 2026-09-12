/**
 * Job đồng bộ giá — Module 2.
 *
 * Lịch chạy:
 * - getFeaturedOfferExpectedPriceBatch cho nhóm SKU trọng yếu: mỗi giờ (batch 40 SKU/lần)
 * - getCompetitiveSummary / getListingOffersBatch: mỗi 2 giờ (batch 20 SKU/lần)
 * - getMyFeesEstimates (cập nhật giá sàn khi giá vốn hoặc phí đổi): mỗi ngày 03:00
 * - Notification ANY_OFFER_CHANGED / PRICE_HEALTH: realtime (xử lý trong notifications/)
 *
 * File này định nghĩa cấu hình job + pipeline xử lý dữ liệu thô từ SP-API
 * thành record để upsert vào Supabase (trong bản sandbox không gọi API thật,
 * chỉ test được hàm pure).
 */

import {
  computeBoxStatus,
  computeFloorPrice,
  computeMargin,
  marginTone,
  pricingFlag,
  type BoxStatus,
  type FeeBreakdown,
} from "../domain/pricing.ts";

export type PricingSyncConfig = {
  /** Số SKU mỗi batch getFeaturedOfferExpectedPriceBatch */
  foepBatchSize: number; // 40 theo docs SP-API
  /** Số SKU mỗi batch getListingOffersBatch */
  offersBatchSize: number; // 20
  /** Lịch cron cho FOEP */
  foepScheduleCron: string; // "0 * * * *"
  /** Lịch cron cho competitive summary + offers */
  offersScheduleCron: string; // "*/30 * * * *"
  /** Lịch cron cập nhật giá sàn (fees estimate) */
  feesScheduleCron: string; // "0 3 * * *"
  /** Giới hạn tốc độ (request per second) */
  rateLimitRps: number; // 0.5
};

export const DEFAULT_PRICING_SYNC_CONFIG: PricingSyncConfig = {
  foepBatchSize: 40,
  offersBatchSize: 20,
  foepScheduleCron: "0 * * * *",
  offersScheduleCron: "*/30 * * * *",
  feesScheduleCron: "0 3 * * *",
  rateLimitRps: 0.5,
};

/* ---------- Raw input từ SP-API (bản rút gọn) ---------- */

export type RawPricingPayload = {
  sku: string;
  asin: string;
  shop: string;
  myPrice: number;
  /** Giá trị trả về từ getFeaturedOfferExpectedPriceBatch */
  foep: number | null;
  /** Giá landed thấp nhất của đối thủ (không tính mình) */
  lowestCompetitorLanded: number | null;
  /** Mình có đang ở featured offer */
  meFeatured: boolean;
  /** Giá vốn */
  cogs: number;
  /** FBA fulfillment fee */
  fbaFee: number;
  /** Referral fee rate */
  referralFeeRate?: number;
  /** Other fees (closing/storage/...) */
  otherFees?: number;
  /** Biên tối thiểu */
  minMarginRate?: number;
  /** Velocity 30 ngày (đơn/ngày) */
  velocity30d: number;
  /** Số giờ đã mất box (0 nếu đang giữ) */
  lostBoxHours: number;
  /** Thời điểm lấy mẫu */
  sampledAt: string;
};

/* ---------- Row cho bảng sku_pricing (upsert vào Supabase) ---------- */

export type PricingSnapshot = {
  sku: string;
  asin: string;
  shop: string;
  ourPrice: number;
  foep: number | null;
  foepDelta: number | null;
  referencePrice: number | null;
  floorPrice: number;
  currentMargin: number;
  marginTone: "red" | "amber" | "green";
  boxStatus: BoxStatus;
  flag: string;
  velocity30d: number;
  sampledAt: string;
  fees: FeeBreakdown;
};

/**
 * Biến đổi dữ liệu thô từ SP-API thành snapshot để lưu DB.
 * Pure function — dễ unit test.
 */
export function buildPricingSnapshot(raw: RawPricingPayload): PricingSnapshot {
  const fees = computeFloorPrice({
    cogs: raw.cogs,
    fbaFee: raw.fbaFee,
    referralFeeRate: raw.referralFeeRate,
    otherFees: raw.otherFees,
    minMarginRate: raw.minMarginRate,
  });
  const currentMargin = computeMargin(raw.myPrice, fees);
  const boxStatus = computeBoxStatus({
    meFeatured: raw.meFeatured,
    foep: raw.foep,
    myPrice: raw.myPrice,
    lowestCompetitorLanded: raw.lowestCompetitorLanded,
  });
  const flag = pricingFlag({
    status: boxStatus,
    marginPct: currentMargin,
    velocity30d: raw.velocity30d,
    lostBoxHours: raw.lostBoxHours,
  });
  const foepDelta = raw.foep === null ? null : Math.round((raw.myPrice - raw.foep) * 100) / 100;
  return {
    sku: raw.sku,
    asin: raw.asin,
    shop: raw.shop,
    ourPrice: raw.myPrice,
    foep: raw.foep,
    foepDelta,
    referencePrice: raw.lowestCompetitorLanded,
    floorPrice: fees.floorPrice,
    currentMargin,
    marginTone: marginTone(currentMargin),
    boxStatus,
    flag,
    velocity30d: raw.velocity30d,
    sampledAt: raw.sampledAt,
    fees,
  };
}

/**
 * Chia một mảng SKU thành các batch theo size để gọi batch API
 * (getFeaturedOfferExpectedPriceBatch: 40; getListingOffersBatch: 20).
 */
export function chunkBatch<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Backoff theo header x-amzn-RateLimit-Mode / Retry-After (đơn giản).
 * Trong production đọc header thực tế; ở đây trả về delay ms theo số lần retry.
 */
export function retryDelay(retryCount: number, retryAfterSec?: number): number {
  if (retryAfterSec && retryAfterSec > 0) return retryAfterSec * 1000;
  // Exponential: 1s, 2s, 4s, 8s, 16s, tối đa 30s
  return Math.min(1000 * 2 ** retryCount, 30_000);
}
