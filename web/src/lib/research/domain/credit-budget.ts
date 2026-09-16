/**
 * Module 8 G7 — ngân sách credits Rainforest (hàm thuần, test node:test).
 *
 * Nguồn giá 09/2026 (đã chốt hạ tầng: gói Starter annual $66/tháng):
 *  - 10.000 credits/tháng kèm gói; request cơ bản = 1 credit;
 *  - vượt gói tính $0.0118/credit (Starter annual).
 *
 * Hai lớp ngưỡng:
 *  - softBudget: ngân sách NỘI BỘ (env RESEARCH_CREDIT_BUDGET_MONTHLY,
 *    mặc định 2.000) — vượt là CẢNH BÁO, không chặn.
 *  - hardCap: trần CHẶN CỨNG (mặc định = credits kèm gói) — chặn xếp/xử lý
 *    bước thu thập mới để không phát sinh tiền overage ngoài ý muốn;
 *    có thể nới qua RESEARCH_CREDIT_HARD_CAP_MONTHLY.
 *
 * Quy ước "không bịa": thiếu dữ liệu tháng → mặc định an toàn (spent=0 nhưng
 * hàm nào cần con số thực phải được gọi kèm cờ hasLedger).
 */

export type RainforestPlanCode = "hobbyist" | "starter" | "production" | "bigdata";

export type RainforestPlan = {
  code: RainforestPlanCode;
  label: string;
  monthlyIncluded: number;
  overageUsdPerCredit: number;
};

/** Bảng giá credits/overage TrajectData (Rainforest API) tháng 09/2026. */
export const RAINFOREST_PLANS: Record<RainforestPlanCode, RainforestPlan> = {
  hobbyist: { code: "hobbyist", label: "Hobbyist annual", monthlyIncluded: 500, overageUsdPerCredit: 0.06 },
  starter: { code: "starter", label: "Starter annual ($66/mo)", monthlyIncluded: 10_000, overageUsdPerCredit: 0.0118 },
  production: { code: "production", label: "Production annual ($300/mo)", monthlyIncluded: 250_000, overageUsdPerCredit: 0.003 },
  bigdata: { code: "bigdata", label: "BigData annual ($800/mo)", monthlyIncluded: 1_000_000, overageUsdPerCredit: 0.002 },
};

export const DEFAULT_SOFT_BUDGET = 2_000;

export type BudgetLevel = "ok" | "warn" | "block";

export type CreditBudgetInput = {
  /** credits đã tiêu trong tháng hiện tại (từ view vexim_research_credit_monthly) */
  spentMonth: number;
  /** credits ước tính cho bước sắp chạy (xem estimateCollectCredits) */
  estimatedNextCost?: number;
  /** ngân sách cảnh báo nội bộ; mặc định DEFAULT_SOFT_BUDGET */
  softBudget?: number;
  /** gói đang mua (mặc định starter) */
  plan?: RainforestPlan;
  /** trần chặn cứng; mặc định = số credits kèm gói */
  hardCap?: number;
};

export type CreditBudgetDecision = {
  level: BudgetLevel;
  spentMonth: number;
  projected: number; // spent + ước tính bước kế
  softBudget: number;
  hardCap: number;
  included: number;
  /** số credit còn được chạy trước khi chặn */
  remaining: number;
  /** credits vượt gói sau bước kế → quy ra tiền overage */
  projectedOverageCredits: number;
  projectedOverageUsd: number;
  reasons: string[];
};

export function decideCreditBudget(input: CreditBudgetInput): CreditBudgetDecision {
  const plan = input.plan ?? RAINFOREST_PLANS.starter;
  const softBudget = input.softBudget ?? DEFAULT_SOFT_BUDGET;
  const hardCap = input.hardCap ?? plan.monthlyIncluded;
  const next = Math.max(0, input.estimatedNextCost ?? 0);
  const projected = Math.max(0, input.spentMonth) + next;
  const reasons: string[] = [];

  const projectedOverageCredits = Math.max(0, projected - plan.monthlyIncluded);
  const projectedOverageUsd = projectedOverageCredits * plan.overageUsdPerCredit;

  let level: BudgetLevel = "ok";

  if (projected >= hardCap) {
    level = "block";
    reasons.push(
      `Dự kiến tiêu ${projected.toLocaleString("vi-VN")} credits tháng này, chạm trần chặn ${hardCap.toLocaleString("vi-VN")} — dừng thu thập, chờ duyệt ngân sách.`,
    );
  } else if (input.spentMonth >= hardCap) {
    level = "block";
    reasons.push(`Đã tiêu ${input.spentMonth.toLocaleString("vi-VN")} credits, vượt trần ${hardCap.toLocaleString("vi-VN")}.`);
  } else if (projected >= softBudget) {
    level = "warn";
    reasons.push(
      `Dự kiến tiêu ${projected.toLocaleString("vi-VN")} credits, vượt ngân sách nội bộ ${softBudget.toLocaleString("vi-VN")} — cần trưởng phòng xác nhận.`,
    );
  }

  if (projected >= softBudget && level === "ok") level = "warn";

  if (projectedOverageCredits > 0) {
    reasons.push(
      `Vượt gói ${plan.label}: ~${projectedOverageCredits.toLocaleString("vi-VN")} credits overage ≈ $${projectedOverageUsd.toFixed(2)} (đơn giá $${plan.overageUsdPerCredit}/credit).`,
    );
  }

  const remaining = Math.max(0, hardCap - input.spentMonth);
  return {
    level,
    spentMonth: input.spentMonth,
    projected,
    softBudget,
    hardCap,
    included: plan.monthlyIncluded,
    remaining,
    projectedOverageCredits,
    projectedOverageUsd,
    reasons,
  };
}

/* ----------------------- ƯỚC TÍN CHO 1 HỒ SƠ ---------------------------- */

export type CollectScope = {
  /** số ASIN organic trong mẫu SERP */
  organicAsins: number;
  /** số ASIN sẽ lấy reviews 1–3★ (mặc định top 10) */
  reviewAsins?: number;
  /** số trang reviews mỗi ASIN (mặc định 2) */
  reviewPagesPerAsin?: number;
  /** có dùng sales estimation cho từng ASIN không */
  withSalesEstimate?: boolean;
};

/**
 * Ước tính credits cho 1 lượt thu thập đầy đủ, theo quy ước credit đã kiểm
 * chứng live 15/09/2026: search/product/offers/sales_estimation/reviews = 1
 * credit/request; product+offers+sales gộp trong Collection vẫn = tổng số
 * request. Trả về con số BI QUAN (làm tròn lên) để chặn trước khỏi phí bất ngờ.
 */
export function estimateCollectCredits(scope: CollectScope): number {
  const n = Math.max(0, scope.organicAsins);
  const reviewAsins = Math.min(scope.reviewAsins ?? 10, n);
  const reviewPages = scope.reviewPagesPerAsin ?? 2;
  const withSales = scope.withSalesEstimate !== false;

  // 1 search; mỗi ASIN: product + offers (+sales) = 2 hoặc 3; reviews riêng.
  const search = 1;
  const perAsinBundle = 2 + (withSales ? 1 : 0);
  const products = n * perAsinBundle;
  const reviews = reviewAsins * reviewPages;
  return search + products + reviews;
}

export const formatCredits = (n: number): string => `${Math.round(n).toLocaleString("vi-VN")} credits`;
