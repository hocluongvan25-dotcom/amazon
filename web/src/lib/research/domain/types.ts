/**
 * Khai báo kiểu dữ liệu lõi cho MODULE 8 — PRODUCT RESEARCH & THẨM ĐỊNH R&D.
 *
 * Phần này KHÔNG phụ thuộc React/Supabase/Amazon — chỉ là hợp đồng dữ liệu
 * thuần để cả worker (job thu thập/tính toán), web (editor) và test dùng chung.
 *
 * Tài liệu thiết kế: docs/ke-hoach-module-8-tham-dinh-rnd-san-pham.md
 */

/* ============================ KỊCH BẢN GIÁ ============================ */

export type ScenarioKey = "pessimistic" | "base" | "optimistic";

export const SCENARIO_ORDER: ScenarioKey[] = ["pessimistic", "base", "optimistic"];

export const SCENARIO_LABEL: Record<ScenarioKey, string> = {
  pessimistic: "Bi quan",
  base: "Cơ sở",
  optimistic: "Quan tâm",
};

/* ============================ ĐÓNG GÓI ============================ */

/** Kích thước/khối lượng ĐƠN VỊ ĐÓNG GÓI (packed unit) — inch và pound, chuẩn FBA US. */
export type PackDimensions = {
  /** Cạnh dài nhất (inch) — đã gồm bao bì */
  lengthIn: number;
  /** Cạnh trung vị (inch) */
  widthIn: number;
  /** Cạnh ngắn nhất (inch) */
  heightIn: number;
  /** Khối lượng cân được cả bao bì (lb) */
  weightLb: number;
};

/* ============================ GIẢ ĐỊNH ĐẦU VÀO ============================ */

/**
 * Toàn bộ giả định cho 1 hồ sơ thẩm định ngách. Giai đoạn 1 (G1): tài chính +
 * logistics do chuyên viên nhập; G2+: các trường đối thủ/thị trường do job
 * Rainforest điền và KHÓA lại (không cho gõ tay trong editor).
 */
export type AssessmentAssumptions = {
  marketplace: string; // "US" | "UK" | ... (G1 mới có bảng phí US)
  currency: string; // "USD"
  title: string; // tên ngách/sản phẩm
  keywords: string[]; // từ khóa ngách dùng để quét SERP
  seedAsin?: string | null; // ASIN hạt nhân (tùy chọn)
  categoryNode?: string | null; // category node (tùy chọn)

  /** Giá bán 3 kịch bản (USD) */
  prices: Record<ScenarioKey, number>;
  /** Giá vốn tận xưởng/đơn vị (USD) */
  cogsPerUnit: number;
  /** Cước vận chuyển VN → FBA phân bổ/đơn vị (USD) → cộng vào landed cost */
  inboundFreightPerUnit: number;

  /** Kích thước/khối lượng đóng gói */
  packDims: PackDimensions;

  /** Tỷ lệ referral fee (mặc định 15%) */
  referralRate?: number;
  /**
   * Phí FBA fulfilment/đơn vị do SP-API Product Fees trả về (con số CHUẨN).
   * Null = engine tự ước lượng theo bảng phí hằng năm (đánh dấu nguồn estimated).
   */
  fbaFeeOverride?: number | null;

  /**
   * Phí lưu kho/đơn vị cho 1 THÁNG tồn trung bình, tự tính từ khối lượng nếu
   * không nhập; có thể nhập tay 2 mùa thấp/cao điểm.
   */
  storagePerUnitMonthLow?: number | null;
  storagePerUnitMonthPeak?: number | null;
  /** Số tháng tồn trung bình giả định khi tính storage/đơn (mặc định 1) */
  storageMonthsAssumed?: number;

  /** CPC ngách giả định (USD/click) — G2 có thể lấy từ Ads thật */
  cpc?: number | null;
  /** Tỉ lệ chuyển đổi giả định (0.12 = 12%) */
  conversionRate?: number | null;
  /** Tỉ lệ trả hàng/dự phòng (mặc định 4%) */
  returnRate?: number;
  /** Chi phí khác/đơn vị (vật tư, phụ kiện, phí khác) */
  otherPerUnit?: number;

  /** Cờ logistics/R&D (chuyên viên tick khi thẩm định) */
  fragile?: boolean; // dễ vỡ
  certificationRequired?: boolean; // cần chứng nhận (điện, trẻ em, thực phẩm…)
  patentRisk?: boolean; // nghi ngờ bằng sáng chế/rào cản pháp lý chưa gỡ

  /** Đơn/ngày theo kịch bản BI QUAN (G1 nhập tay; G2+ điền từ sales estimation) */
  pessimisticUnitsPerDay?: number | null;
  /** Số ngày phủ hàng của lô test (mặc định 45, dải hợp lý 30–45) */
  testCoverDays?: number;
  /** Ngân sách ads thăm dò/ngày (USD); null = tự gợi ý từ CPC/CR/velocity */
  adsBudgetPerDay?: number | null;
  /** Số ngày chạy ads thăm dò (mặc định 45) */
  adsTestDays?: number;
};

/* ============================ SIZE TIER ============================ */

export type SizeTierCode =
  | "large_envelope"
  | "small_standard"
  | "large_standard"
  | "small_bulky"
  | "large_bulky"
  | "extra_large";

export type SizeTierResult = {
  tier: SizeTierCode;
  label: string;
  /** Cạnh đã sắp xếp: [dài nhất, trung vị, ngắn nhất] */
  sides: [number, number, number];
  unitWeightLb: number;
  dimensionalWeightLb: number;
  /** Khối lượng tính phí = max(unit, dimensional) theo quy tắc tier */
  billableWeightLb: number;
  /** Dài + vòng bụng (length + girth) = L + 2M + 2S */
  lengthPlusGirthIn: number;
  /** True khi rơi vào nhóm bulky/oversize (ngoài standard size) */
  isOversize: boolean;
  /** Các mép ngưỡng đang ở rất gần (≤5% dung sai) → cảnh báo bao bì */
  nearBoundaries: string[];
};

/* ============================ P&L ============================ */

export type FeeSource = "spapi" | "estimated_table" | "manual";

export type ScenarioPnl = {
  scenario: ScenarioKey;
  price: number;
  landedCost: number; // cogs + inbound freight
  referralFee: number; // price × referralRate
  fbaFee: number;
  fbaFeeSource: FeeSource;
  storageFee: number; // storage/tháng × số tháng giả định
  ppcPerOrder: number | null; // CPC / CR (null khi thiếu CPC hoặc CR)
  returnReserve: number; // price × returnRate
  otherPerUnit: number;
  totalCosts: number;
  netProfit: number;
  netMarginPct: number; // 1 chữ số thập phân
  /** ACOS hòa vốn = biên TRƯỚC PPC (%), là mức ACOS tối đa chấp nhận được */
  breakEvenAcosPct: number;
};

export type MonthlySimulation = {
  unitsPerMonth: number;
  revenue: number;
  netProfit: number;
  adSpend: number | null;
};

export type PackagingOption = {
  label: string;
  dims: PackDimensions;
  tier: SizeTierCode;
  tierLabel: string;
  billableWeightLb: number;
  fbaFee: number;
  /** Chênh lệch phí/đơn vị so với phương án hiện tại (âm = tiết kiệm) */
  savingPerUnit: number | null;
  savingPerYear: number | null; // quy đổi theo velocity×365 nếu có
};

export type FinancialResult = {
  scenarios: Record<ScenarioKey, ScenarioPnl>;
  monthly: MonthlySimulation[]; // mốc 300/500/1.000 đơn (kịch bản cơ sở)
  currentPackaging: PackagingOption;
  packagingSuggestions: PackagingOption[];
  storage: {
    cubicFeet: number;
    lowPerMonth: number;
    peakPerMonth: number;
    monthsAssumed: number;
    source: string;
  };
  feeTableVersion: string;
  warnings: string[];
};

/* ================ NGƯỠNG CHỊU ĐỰNG ADS & ĐỘ NHẠY CPC×CR ================ */

/**
 * Bài toán ngược cho các ẩn số KHÔNG THỂ biết trước ở G1 (CPC, CR, velocity):
 * thay vì bắt nhập một con số để đoán, engine tính NGƯỠNG mà ẩn số phải đạt
 * để kịch bản (mặc định BI QUAN) còn sống — từ những gì ĐÃ biết (giá, COGS,
 * cước, kích thước). Mọi giá trị "cần giả định" đều ghi rõ `assumed`.
 */
export type AdFeasibility = {
  scenario: ScenarioKey;
  price: number;
  /** Lời TRƯỚC quảng cáo/đơn = giá − mọi chi phí trừ PPC */
  preAdProfitPerUnit: number;
  /** PPC/đơn tối đa trước khi biên tụt xuống 0% (không phụ thuộc CPC/CR) */
  maxPpcPerOrderBreakEven: number | null;
  /** PPC/đơn tối đa trước khi biên tụt dưới ngưỡng cờ đỏ 20% */
  maxPpcPerOrderRedFlag: number | null;
  /** CR dùng để quy đổi PPC→CPC: của user nhập, hoặc benchmark 10% (assumed) */
  crUsed: { value: number; assumed: boolean };
  maxCpcBreakEven: number | null;
  maxCpcRedFlag: number | null;
  /** CPC dùng để quy đổi PPC→CR — chỉ có khi user nhập CPC (KHÔNG bịa) */
  cpcUsed: number | null;
  /** CR tối thiểu (%) để hoà vốn / để giữ biên ≥20% — null nếu >100% (bất thi) */
  minCrBreakEvenPct: number | null;
  minCrRedFlagPct: number | null;
};

export type CpcCrGridCell = {
  cpc: number;
  crPct: number;
  ppcPerOrder: number;
  netProfit: number;
  netMarginPct: number;
  /** biên ≥ ngưỡng cờ đỏ 20% */
  passRedFlag: boolean;
};

export type CpcCrGrid = {
  scenario: ScenarioKey;
  cpcValues: number[];
  crPctValues: number[];
  /** cells[i][j] theo cpcValues[i] × crPctValues[j] */
  cells: CpcCrGridCell[][];
};

/* ============================ SCORECARD ============================ */

export type PillarKey =
  | "finance"
  | "competition"
  | "demand"
  | "differentiation"
  | "logistics";

export type Confidence = "high" | "medium" | "low" | null;

export type PillarScore = {
  pillar: PillarKey;
  label: string;
  weight: number; // 0..1
  /** null ở G1 khi trụ đó CHƯA có dữ liệu (đối thủ/review) → "chưa đủ cơ sở" */
  score: number | null; // 1..10
  confidence: Confidence;
  reason: string;
};

export type VetoCode =
  | "margin_below_20"
  | "cr3_above_65"
  | "amazon1p_top3"
  | "cert_barrier"
  | "oversize";

export type VetoFlag = {
  code: VetoCode;
  severity: "red" | "warning";
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
};

export type VerdictCode = "go_test" | "improve" | "do_not_invest" | "insufficient_data";

export type ScorecardResult = {
  pillars: PillarScore[];
  /** Điểm tổng có trọng số — null tới khi đủ cả 5 trụ (không tự suy diễn) */
  overallScore: number | null;
  verdict: VerdictCode;
  verdictLabel: string;
  vetoes: VetoFlag[];
};

/* ============================ ROADMAP ============================ */

export type RoadmapResult = {
  /** Số đơn vị lô test đề xuất = velocity bi quan × số ngày phủ (null nếu thiếu velocity) */
  testOrderQty: number | null;
  coverDays: number;
  /** Vốn hàng = testOrderQty × landed cost (kịch bản giá không ảnh hưởng cost) */
  lotCapital: number | null;
  adsBudgetPerDay: number | null;
  adsTestDays: number;
  adsTestSpend: number | null;
  breakEvenAcosPct: number | null;
  /** Mức lỗ tối đa nếu fail: lỗ/đơn kịch bản bi quan × số lượng (nếu lỗ) + tổng ads test */
  maxLossAmount: number | null;
  gates: { week: number; metrics: string[] }[];
  killCriteria: string[];
  notes: string[];
};

/**
 * Bảng "chọn velocity theo vốn" — velocity thật chỉ có ở G2 (Rainforest sales
 * estimation), nên G1 không bắt đoán: bày ra vốn lô test + mức lỗ tối đa tương
 * ứng từng mức velocity để user CHỌN mức chấp nhận được. Cùng công thức với
 * `computeRoadmap` (coverDays, ads đề xuất = velocity × PPC/đơn kịch bản cơ sở).
 */
export type VelocityLadderRow = {
  unitsPerDay: number;
  testOrderQty: number;
  lotCapital: number;
  adsBudgetPerDay: number | null;
  adsTestSpend: number | null;
  maxLoss: number | null;
};

/* ============================ HỒ SƠ THẨM ĐỊNH (OUTPUT G1) ============================ */

export type AssessmentResult = {
  assumptions: AssessmentAssumptions;
  financial: FinancialResult;
  scorecard: ScorecardResult;
  roadmap: RoadmapResult;
  computedAt: string;
  engineVersion: string;
};
