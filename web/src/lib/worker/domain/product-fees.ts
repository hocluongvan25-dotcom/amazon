/**
 * Module 8 G1+ — mapper THUẦN cho Product Fees API v0 (getMyFeesEstimateForASIN).
 *
 * VÌ SAO CẦN (sự cố so sánh 16/09/2026, ASIN B074VBLKSL):
 *   Revenue Calculator của Amazon cho biên +50.6% nhưng engine Vexim phán
 *   −14.9% vì (1) referral mặc định 15% trong khi danh mục này 8% ($0.79 thay
 *   vì $1.48) và (2) phí FBA bảng ước lượng $5.90 trong khi số chuẩn $3.91 —
 *   lệch ~$2.7/đơn, ĐẢO NGƯỢC kết luận GO/NO-GO. Số chuẩn duy nhất đến từ
 *   endpoint này; bảng 2026 chỉ là fallback khi chưa gọi được.
 *
 * Hợp đồng lấy từ model chính thức `amzn/selling-partner-api-models`
 * (`models/product-fees-api-model/productFeesV0.json`):
 *   • Request: { FeesEstimateRequest: { MarketplaceId*, Identifier*,
 *     IsAmazonFulfilled?, PriceToEstimateFees: { ListingPrice*: {CurrencyCode,
 *     Amount} } } }
 *   • Response: { payload: { Status, FeesEstimate: { TotalFeesEstimate,
 *     FeeDetailList[], TimeOfFeesEstimation* }, Error? } | errors[] }
 *   • Rate: 1 rps · burst 2 (trang Product Fees API Rate Limits).
 */

export const SP_API_FEE_TYPES = {
  referral: "ReferralFee",
  fulfillment: "FulfillmentFees",
  /** Shape response thật (2023+): phí FBA nằm trong FeeType "FBAFees", kèm
   * IncludedFeeDetailList (FBAPickAndPack…) — KHÔNG đọc phần included để khỏi nhân đôi. */
  fba: "FBAFees",
  /** Một số response tách riêng phí handling khối lượng khỏi FulfillmentFees. */
  weightHandling: "FBAWeightHandlingFee",
  variableClosing: "VariableClosingFee",
} as const;

export type SpApiFeeLine = {
  feeType: string;
  /** FeeAmount gốc (trước khuyến phí) */
  amount: number | null;
  /** FinalFee — con số Amazon thực thu, dùng cho tính toán */
  finalFee: number | null;
};

export type SpApiFeesEstimate = {
  ok: boolean;
  /** mã lỗi Amazon (ClientError/InvalidParameterValue…) khi ok=false */
  errorCode: string | null;
  errorMessage: string | null;
  /** Phí giới thiệu (referral) — FinalFee của ReferralFee */
  referralFee: number | null;
  /** Phí hoàn thiện FBA — FulfillmentFees + FBAWeightHandlingFee (nếu tách riêng) */
  fulfillmentFee: number | null;
  variableClosingFee: number | null;
  /** TotalFeesEstimate — tổng mọi phí Amazon thu trên đơn */
  totalFees: number | null;
  currency: string | null;
  lines: SpApiFeeLine[];
  timeOfEstimation: string | null;
  sellerId: string | null;
};

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Tiền: luôn 2 chữ số thập phân — tránh nhiễu float khi cộng dồn phí. */
const R2 = (n: number): number => Math.round(n * 100) / 100;

function moneyAmount(v: unknown): number | null {
  const m = asObj(v);
  if (!m) return null;
  const n = m.Amount;
  return typeof n === "number" && Number.isFinite(n) ? R2(n) : null;
}

/**
 * Response getMyFeesEstimate* → SpApiFeesEstimate. KHÔNG ném lỗi — mọi nhánh
 * lỗi của Amazon (payload.Status ≠ Success, payload.Error, errors[] cấp ngoài)
 * đều quy về ok=false kèm mã + thông điệp để UI nói rõ.
 *
 * HAI SHAPE phải xử lý (sự cố "Unknown" 16/09/2026):
 *  • Model swagger: payload.{Status, FeesEstimate, Error} — phẳng;
 *  • Response THẬT: payload.FeesEstimateResult.{Status, FeesEstimate, Error}
 *    (bọc thêm 1 lớp — mẫu response thật trên selling-partner-api-docs #3487).
 */
export function mapFeesEstimateResponse(json: unknown): SpApiFeesEstimate {
  const empty: SpApiFeesEstimate = {
    ok: false,
    errorCode: null,
    errorMessage: null,
    referralFee: null,
    fulfillmentFee: null,
    variableClosingFee: null,
    totalFees: null,
    currency: null,
    lines: [],
    timeOfEstimation: null,
    sellerId: null,
  };

  const root = asObj(json);
  if (!root) return { ...empty, errorCode: "InvalidResponse", errorMessage: "SP-API trả về không phải JSON" };

  // Lỗi cấp ngoài (token sai, thiếu quyền…) — shape { errors: [{code,message}] }
  const topErrors = Array.isArray(root.errors) ? (root.errors as unknown[]) : null;
  if (topErrors && topErrors.length > 0) {
    const first = asObj(topErrors[0]);
    return {
      ...empty,
      errorCode: typeof first?.code === "string" ? first.code : "SpApiError",
      errorMessage: typeof first?.message === "string" ? first.message : "SP-API trả lỗi không rõ nội dung",
    };
  }

  const payload = asObj(root.payload);
  if (!payload) return { ...empty, errorCode: "InvalidResponse", errorMessage: "SP-API thiếu payload" };

  // Response THẬT bọc thêm lớp FeesEstimateResult; model swagger thì phẳng.
  const result = asObj(payload.FeesEstimateResult) ?? payload;

  const status = typeof result.Status === "string" ? result.Status : "";
  if (status !== "Success") {
    const err = asObj(result.Error);
    const rawCode = typeof err?.Code === "string" && err.Code ? err.Code : null;
    const rawMsg = typeof err?.Message === "string" && err.Message ? err.Message : null;
    return {
      ...empty,
      errorCode: status || rawCode || "Unknown",
      errorMessage:
        rawMsg ??
        // ĐỪNG bao giờ giấu lỗi thật: kèm trích đoạn payload để còn chẩn đoán
        // (bài học vụ "Unknown": mapper cũ nuốt mất nội dung Amazon trả về).
        `Amazon từ chối ước tính phí cho ASIN/giá này (trạng thái: ${status || "không rõ"}). ` +
        "Trích đoạn response: " +
        JSON.stringify(payload).slice(0, 220),
    };
  }

  const estimate = asObj(result.FeesEstimate) ?? {};
  const identifier = asObj(result.FeesEstimateIdentifier);
  const total = asObj(estimate.TotalFeesEstimate);
  const detailList = Array.isArray(estimate.FeeDetailList) ? (estimate.FeeDetailList as unknown[]) : [];

  const lines: SpApiFeeLine[] = [];
  let referralFee: number | null = null;
  let fulfillmentFee: number | null = null;
  let variableClosingFee: number | null = null;

  for (const raw of detailList) {
    const d = asObj(raw);
    if (!d || typeof d.FeeType !== "string") continue;
    const finalFee = moneyAmount(d.FinalFee);
    const amount = moneyAmount(d.FeeAmount);
    lines.push({ feeType: d.FeeType, amount, finalFee });
    const fee = finalFee ?? amount;
    if (fee === null) continue;
    if (d.FeeType === SP_API_FEE_TYPES.referral) referralFee = fee;
    else if (d.FeeType === SP_API_FEE_TYPES.variableClosing) variableClosingFee = fee;
    else if (
      d.FeeType === SP_API_FEE_TYPES.fulfillment ||
      d.FeeType === SP_API_FEE_TYPES.fba ||
      d.FeeType === SP_API_FEE_TYPES.weightHandling
    ) {
      fulfillmentFee = R2((fulfillmentFee ?? 0) + fee);
    }
  }

  return {
    ok: true,
    errorCode: null,
    errorMessage: null,
    referralFee,
    fulfillmentFee,
    variableClosingFee,
    totalFees: moneyAmount(total),
    currency: typeof total?.CurrencyCode === "string" ? total.CurrencyCode : null,
    lines,
    timeOfEstimation: typeof estimate.TimeOfFeesEstimation === "string" ? estimate.TimeOfFeesEstimation : null,
    sellerId: typeof identifier?.SellerId === "string" ? identifier.SellerId : null,
  };
}

/** % referral suy từ phí chuẩn — điền ngược vào form (engine nhân giá × %). */
export function referralRatePctFromFee(referralFee: number | null, price: number): number | null {
  if (referralFee === null || !(price > 0)) return null;
  return Math.round((referralFee / price) * 1000) / 10;
}
