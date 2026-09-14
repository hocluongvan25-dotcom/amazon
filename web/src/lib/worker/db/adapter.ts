/**
 * DbAdapter — interface worker ↔ database.
 * MockDbAdapter: chạy in-memory (test + dev không cần Supabase).
 * SupabaseDbAdapter: ghi qua REST (service_role) vào Supabase — xem
 * ./supabase.ts. Khớp migrations 0001–0005.
 */
export type InventorySnapshotRow = {
  sellerAccountId: string;
  sku: string;
  asin: string | null;
  fulfillable: number;
  reserved: number;
  inbound: number; // working + shipped + receiving
  capturedAt: Date;
};

export type InventoryDailyRow = {
  sellerAccountId: string;
  day: string; // YYYY-MM-DD
  sku: string;
  units: number;
  daysOfCover: number | null;
  inStock: boolean;
};

export type NotificationRecord = {
  sellerAccountId: string;
  notificationType: string;
  raw: unknown;
  normalized: unknown;
  receivedAt: Date;
};

/** Trạng thái vòng đời listing cho màn L1/L4 (Đợt 1) */
export type ListingLifecycleStatus = "ACTIVE" | "INACTIVE" | "SUPPRESSED" | "STRANDED";

/**
 * Một issue đúng shape Amazon trả về (getListingsItem · includedData=issues).
 * Lưu NGUYÊN VĂN vào `catalog.listings.issues` để màn L2 hiện đúng mã lỗi
 * (8541, 90220…) thay vì một con số đếm vô danh.
 */
export type ListingIssueRecord = {
  code?: string;
  message?: string;
  severity?: "ERROR" | "WARNING" | "INFO";
  attributeNames?: string[];
  categories?: string[];
  enforcements?: { actions?: string[]; exemption?: { status?: string } };
};

/** Nguồn đã ghi dòng listing — hiện trên L1 để biết số này từ đâu ra. */
export type ListingSource = "report" | "api" | "notification" | "manual";

/**
 * Trạng thái listing mà worker biết tại một thời điểm.
 *
 * QUY TẮC null (khớp RPC `public.vexim_worker_upsert_listings` của migration 0016):
 *   • `undefined` / `null`  → NGUỒN KHÔNG CHO BIẾT → DB GIỮ giá trị cũ.
 *   • `issues: []`          → ĐÃ XÁC NHẬN không còn issue → thay thế.
 *   • `strandedReason: null` (key có mặt) → hết stranded → xoá lý do cũ.
 */
export type ListingStateRow = {
  sellerAccountId: string;
  sku: string;
  asin?: string | null;
  itemName?: string | null; // itemName CÓ THỂ null từ Amazon (đã ghi nhận thực tế)
  status: ListingLifecycleStatus | null;
  buyable?: boolean | null;
  discoverable?: boolean | null;
  productType?: string | null;
  /** Mảng issue chi tiết (L2). undefined/null = chưa biết. */
  issues?: ListingIssueRecord[] | null;
  issueErrors?: number;
  issueWarnings?: number;
  enforcementActions?: string[];
  /** Chuỗi thô từ report ("129.99" / "1.299,99") — tầng ghi sẽ parse. */
  price?: string | null;
  currency?: string | null;
  quantity?: number | null;
  strandedReason?: string | null;
  source?: ListingSource | null;
  updatedAt: Date;
};

export type ActiveShop = {
  id: string;
  sellerId: string;
  marketplace: string;
  displayName: string;
  leadDays: number;
  safetyDays: number;
};

export type SyncJobRecord = {
  id?: string;
  sellerAccountId: string;
  jobType: string;
  status: "pending" | "running" | "done" | "failed";
  attempts?: number;
  lastError?: string | null;
  startedAt?: Date;
  finishedAt?: Date;
  payload?: unknown;
};

export type AlertRowInput = {
  sellerAccountId: string;
  ruleCode: string;
  severity: "red" | "amber" | "green";
  title: string;
  detail?: string | null;
  assignedTo?: string | null;
  /** chỉ dùng ở MockDbAdapter — Supabase lưu cột status/resolved_at */
  resolvedAt?: Date | null;
};

/* ============================================================================
 * MODULE 4 — ĐƠN HÀNG (khớp migration 0010)
 * Nguyên tắc PII (quyết định v1.1): KHÔNG có trường tên/địa chỉ/điện thoại/mã bưu
 * chính của người mua trong bất kỳ type nào dưới đây.
 * ==========================================================================*/

export type OrderItemInput = {
  amazonOrderItemId: string;
  sku: string | null;
  asin: string | null;
  itemName: string | null;
  quantity: number;
  itemPrice: number;
  itemStatus: string | null;
};

export type OrderRowInput = {
  sellerAccountId: string;
  amazonOrderId: string;
  merchantOrderId?: string | null;
  status: string; // trạng thái Amazon gốc (Unshipped, Shipped, Canceled…)
  channel?: string | null; // AFN | MFN
  purchaseDate: Date;
  lastUpdatedDate?: Date | null;
  orderTotal?: number | null;
  currency?: string;
  itemsCount: number;
  marketplaceId?: string | null;
  /** chỉ mức vùng (không phải PII) */
  shipState?: string | null;
  shipCountry?: string | null;
  orderItems: OrderItemInput[];
};

export type ReturnRowInput = {
  sellerAccountId: string;
  amazonOrderId: string;
  amazonRmaId?: string | null;
  returnDate: Date;
  reason: string;
  reasonLabel: string;
  reasonGroup: string;
  status?: string | null;
  resolution?: string | null;
  refundAmount?: number | null;
  currency?: string;
  sku?: string | null;
  asin?: string | null;
  quantity?: number;
  /** khoá chống trùng khi import lại cùng kỳ report (RMA id hoặc hash nội dung) */
  dedupeKey: string;
};

export type OrderDailyRowInput = {
  sellerAccountId: string;
  day: string; // YYYY-MM-DD
  ordersCount: number;
  units: number;
  salesAmount: number;
  currency: string;
  fbmUnshipped: number;
  fbmOverdue: number;
  returnsCount: number;
  returnsAmount: number;
};

/* ============================================================================
 * MODULE 7 — ACCOUNT HEALTH
 * ==========================================================================*/

export type AccountHealthSnapshotRowInput = {
  sellerAccountId: string;
  day: string;
  marketplaceId: string;
  accountStatus: string | null; // NORMAL | AT_RISK | DEACTIVATED
  ahrStatus: string | null;
  tone: string; // green | amber | red
  score: number; // điểm nội bộ 0–100 (KHÔNG phải AHR của Amazon)
  rates: unknown; // JSONB: chỉ số + ngưỡng + tông
  issues: unknown; // JSONB: bản chụp vi phạm tại thời điểm lấy
  sourceReportId: string | null;
  capturedAt: Date;
};

export type AccountHealthIssueRowInput = {
  sellerAccountId: string;
  marketplaceId: string;
  category: string; // khóa warningStates của Amazon
  label: string;
  severity: string; // Critical | High | Medium | Low
  groupName: string; // ip | restricted | quality | other
  defectsCount: number;
  status: string | null;
  reportingFrom?: string | null;
  reportingTo?: string | null;
};

/* ============================================================================
 * MODULE 6 — TÀI CHÍNH
 * ==========================================================================*/

export type SettlementRowInput = {
  sellerAccountId: string;
  settlementId: string;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string;
  depositDate?: string | null;
  totalAmount: number;
  currency: string;
  status: string; // deposited | processing | open
  breakdown: unknown; // JSONB: nhóm phí cấp 1 + children
  reconcileDiff: number | null; // null = khớp trong dung sai 1% (SOP-10)
  reconciledAt?: Date | null;
};

export type FinancialEventRowInput = {
  sellerAccountId: string;
  settlementId?: string | null;
  eventType: string;
  eventDate: Date;
  amount: number;
  currency: string;
  sku?: string | null;
  amountType?: string | null;
  amountDescription?: string | null;
  orderId?: string | null;
  quantity?: number | null;
  marketplaceName?: string | null;
  /** khoá chống trùng nội bộ (dùng khi append từng dòng) */
  dedupeKey?: string | null;
  raw?: unknown;
};

/* ---- Module 3 (L3): hàng đợi publish listing ---- */

/** JSON Schema product type (Product Type Definitions API) — nguồn cho form động L3. */
export type ProductTypeSchemaInput = {
  marketplaceId: string;
  productType: string;
  requirements: string;
  /** JSON Schema THẬT (không phải wrapper getDefinitionsProductType) */
  schema: Record<string, unknown>;
};

/* ---- Module 6 Đợt 2: F3 bồi hoàn FBA + F4 lợi nhuận SKU ---- */

/** Dòng report GET_FBA_REIMBURSEMENTS_DATA (đã parse) — idempotent theo dedupeKey. */
export type ReimbursementRowInput = {
  reimbursementId: string | null;
  caseId: string | null;
  reason: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  condition: string | null;
  currency: string | null;
  amountPerUnit: number | null;
  amountTotal: number | null;
  quantityReimbursedCash: number | null;
  quantityReimbursedInventory: number | null;
  quantityReimbursedTotal: number | null;
  approvalDate: string | null;
  originalReimbursementId: string | null;
  originalReimbursementType: string | null;
  dedupeKey: string;
  marketplaceId: string | null;
};

/** Khoản nghi ngờ bồi hoàn (SOP-09) — worker chỉ chèn mới/refresh dòng suspected. */
export type ReimbursementClaimRowInput = {
  sku: string;
  fnsku: string | null;
  asin: string | null;
  category: string;
  source: string;
  sourceRef: string;
  sourceDate: string | null;
  sourceReason: string | null;
  quantity: number;
  currency: string;
  unitCost: number | null;
  estimatedAmount: number | null;
  marketplaceId: string;
};

/** Claim hiện có (đọc lại để đối chiếu + cảnh báo quá hạn SOP-09). */
export type ReimbursementClaimRow = {
  id: string;
  sku: string | null;
  status: string;
  reimbursedAmount: number | null;
  reimbursementId: string | null;
  detectedAt: string;
  filedAt: string | null;
  ageHours: number | null;
};

/** Lợi nhuận SKU/ngày (F4) — worker tính, web chỉ đọc. */
export type SkuProfitRowInput = {
  sku: string;
  day: string;
  currency: string;
  units: number;
  revenue: number;
  refunds: number;
  amazonFees: number;
  promo: number;
  cogs: number | null;
  adsSpend: number | null;
  grossProfit: number | null;
  unitCost: number | null;
  feeSource: string;
};

/** Giá vốn hiệu lực (catalog.cost_inputs) cho worker tính F4/SOP-09 bước 3. */
export type EffectiveCostRow = { sku: string; unitCost: number | null; currency: string };

/** Dòng tiền đã quyết toán trong kỳ — đầu vào tính lợi nhuận SKU (F4). */
export type FinancialEventQueryRow = {
  sku: string | null;
  eventType: string;
  amountType: string | null;
  amountDescription: string | null;
  amount: number;
  quantity: number | null;
  currency: string | null;
  eventDate: Date | string;
};

/** Một dòng hàng đợi publish do web đẩy vào (catalog.listing_publish_queue). */
export type ListingPublishQueueRow = {
  queueId: string;
  sellerAccountId: string;
  draftId: string;
  sku: string;
  asin: string | null;
  marketplaceId: string;
  productType: string;
  requirements: string;
  /** patch = listing đã tồn tại; put = tạo mới */
  method: "patch" | "put" | "feed" | string;
  /** body đã dựng sẵn (patches cho patch, attributes cho put) */
  payload: Record<string, unknown>;
  attempts: number;
};

export type ListingPublishResultInput = {
  queueId: string;
  /**
   * sent = đã gửi, chờ xử lý; accepted/invalid = Amazon trả ngay;
   * blocked = bị hạn chế danh mục (getListingsRestrictions); failed = lỗi mạng/5xx
   */
  status: "sent" | "accepted" | "invalid" | "blocked" | "failed";
  submissionId?: string | null;
  issues?: unknown[];
  error?: string | null;
  /** Lý do chặn trước khi gửi (thường là reasonCode của Listings Restrictions) */
  blockReason?: string | null;
};

/* ---- Module 3 nâng cao (migration 0018) ---- */
/**
 * Kết quả nhập một lô dòng report. Bốn số này PHẢI tách bạch:
 *  • skipped = dòng thiếu khoá / số không đọc được → KHÔNG được ghi (log nói rõ)
 *  • merged  = dòng trùng khoá trong CÙNG file → đã cộng dồn thành 1 dòng
 * Gộp hai số đó làm một sẽ che mất "file report có vấn đề".
 */
export type ReportUpsertCounts = {
  inserted: number;
  updated: number;
  skipped: number;
  merged: number;
};

/** Một dòng GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA (đã parse + chuẩn hoá). */
export type FcAllocationRowInput = {
  /** YYYY-MM-DD — ngày Amazon chụp snapshot */
  snapshotDate: string;
  sku: string;
  fnsku?: string | null;
  productName?: string | null;
  quantity: number;
  /** Rỗng = report không cho biết FC */
  fulfillmentCenterId?: string;
  /** Rỗng = report không cho biết disposition (không được đếm là bán được) */
  detailedDisposition?: string;
  country?: string | null;
  source?: string;
};

/** Một dòng GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA (đã parse + chuẩn hoá). */
export type ReceiptRowInput = {
  /** YYYY-MM-DD — ngày Amazon hoàn tất nhận */
  receivedDate: string;
  sku: string;
  fnsku?: string | null;
  productName?: string | null;
  quantity: number;
  /** Rỗng = report không gắn lô → không đối soát theo lô được */
  fbaShipmentId?: string;
  fulfillmentCenterId?: string;
  source?: string;
};

/**
 * Kết quả nhập report PHÍ (0019). Ngoài 4 số đếm như 0018, trả thêm:
 *  • groups     = số tháng (phí lưu kho) hoặc số lô (phí inbound) trong lô nhập
 *  • currencies = tiền tệ có mặt, đã sắp xếp
 * KHÔNG trả tổng tiền: report có thể chứa nhiều tiền tệ (shop US + CA) và cộng
 * gộp hai tiền tệ là ra con số vô nghĩa — tầng view mới là nơi cộng, theo
 * từng currency một.
 */
export type FeeUpsertCounts = ReportUpsertCounts & {
  groups: number;
  currencies: string[];
};

/** Một dòng GET_FBA_STORAGE_FEE_CHARGES_DATA (đã parse + chuẩn hoá). */
export type StorageFeeRowInput = {
  /** YYYY-MM — RPC từ chối mọi dạng khác (kể cả "August 2026") */
  monthOfCharge: string;
  /** Report phí KHÔNG có seller SKU — DB suy SKU qua fnsku/asin */
  asin?: string;
  fnsku?: string;
  fulfillmentCenter?: string;
  dangerousGoodsStorageType?: string;
  productName?: string | null;
  countryCode?: string | null;
  productSizeTier?: string | null;
  averageQuantityOnHand?: number | null;
  averageQuantityPendingRemoval?: number | null;
  averageQuantityCustomerOrders?: number | null;
  estimatedTotalItemVolume?: number | null;
  volumeUnits?: string | null;
  itemVolume?: number | null;
  longestSide?: number | null;
  medianSide?: number | null;
  shortestSide?: number | null;
  measurementUnits?: string | null;
  weight?: number | null;
  weightUnits?: string | null;
  storageRate?: number | null;
  currency?: string | null;
  estimatedMonthlyStorageFee?: number | null;
  eligibleForInventoryDiscount?: boolean | null;
  qualifiesForInventoryDiscount?: boolean | null;
  totalIncentiveFeeAmount?: number | null;
  breakdownIncentiveFeeAmount?: number | null;
  source?: string;
};

/** Một dòng GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA (đã parse + chuẩn hoá). */
export type NoncomplianceRowInput = {
  /** YYYY-MM-DD — ngày Amazon báo vấn đề */
  issueReportedDate: string;
  shipmentCreationDate?: string | null;
  fbaShipmentId?: string;
  fbaCartonId?: string;
  fulfillmentCenterId?: string;
  sku?: string;
  fnsku?: string | null;
  asin?: string | null;
  productName?: string | null;
  problemType?: string;
  problemQuantity?: number | null;
  /** của DÒNG có vấn đề — không cộng dồn theo lô để đối soát */
  expectedQuantity?: number | null;
  receivedQuantity?: number | null;
  performanceMeasurementUnit?: string | null;
  coachingLevel?: string | null;
  feeType?: string | null;
  currency?: string | null;
  feeTotal?: number | null;
  problemLevel?: string | null;
  alertStatus?: string | null;
  source?: string;
};

/**
 * Vòng đời một lần yêu cầu report (Reports API chạy bất đồng bộ):
 *   requested → in_queue / in_progress → done → imported
 *                                     ↘ no_data (report rỗng)
 *   failed / fatal / cancelled = Amazon hoặc ta bỏ cuộc (ghi kèm lastError)
 */
export type ReportRequestStatus =
  | "requested" | "in_queue" | "in_progress" | "done"
  | "imported" | "no_data" | "failed" | "fatal" | "cancelled";

export const REPORT_REQUEST_STATUSES: readonly ReportRequestStatus[] = [
  "requested", "in_queue", "in_progress", "done",
  "imported", "no_data", "failed", "fatal", "cancelled",
];

/** Trạng thái một lần yêu cầu report — khoá (shop × loại report × khoảng ngày). */
export type ReportRequestInput = {
  reportType: string;
  marketplaceId?: string | null;
  /** YYYY-MM-DD; null = report không cần khoảng ngày (ví dụ current inventory) */
  dataStart?: string | null;
  dataEnd?: string | null;
  reportId?: string | null;
  reportDocumentId?: string | null;
  status: ReportRequestStatus;
  rowsImported?: number | null;
  lastError?: string | null;
  /** ISO string */
  requestedAt?: string | null;
  completedAt?: string | null;
  importedAt?: string | null;
};

export type ReportRequestRow = ReportRequestInput & {
  id: string;
  sellerAccountId: string;
  /** số lần cron chạm vào dòng này — >1 là bình thường (poll nhiều lần) */
  attempts: number;
};


/* ============================================================================
 * MODULE 5 PHẦN 1 — AMAZON ADS (khớp migration 0020)
 *
 * Luật ghi giống 0016..0019: `null` = "nguồn không cho biết"; khoá tự nhiên
 * NOT NULL DEFAULT '' ở DB nên adapter truyền chuỗi rỗng chứ không truyền null.
 * ==========================================================================*/

/** (inserted, updated, skipped = thiếu khoá, merged = trùng khoá trong cùng lô) */
export type AdsEntityCounts = {
  inserted: number;
  updated: number;
  skipped: number;
  merged: number;
};

/** Metrics: thêm số ngày + danh sách tiền tệ (log "kéo được mấy ngày, tiền gì"). */
export type AdsMetricCounts = AdsEntityCounts & {
  days: number | null;
  currencies: string | null;
};

/** Gợi ý negative: `kept` = số gợi ý ĐÃ CÓ QUYẾT ĐỊNH của con người nên giữ nguyên. */
export type AdsSuggestionCounts = {
  inserted: number;
  updated: number;
  skipped: number;
  kept: number;
};

/** Lấp ads_spend vào F4: chỉ UPDATE dòng lợi nhuận đã có, không tạo dòng mới. */
export type AdsSpendCounts = {
  updated: number;
  skippedNoRow: number;
  skippedCurrency: number;
};

/* ---- Module 5 phần 3 (0021): HÀNG ĐỢI GHI lên Amazon Ads ---- */

export type AdsChangeAction =
  | "set_budget"
  | "set_bid"
  | "set_state"
  | "add_negative_exact"
  | "add_negative_phrase";

/**
 * Một yêu cầu ghi đã được DUYỆT, worker vừa nhận (claim) để thực thi.
 * `beforeValue`/`afterValue` là jsonb `{value: …}` — giữ nguyên dạng của DB để
 * job không phải đoán kiểu (số cho bid/budget, chuỗi cho state/negative).
 */
export type AdsChangeRow = {
  changeId: string;
  entityType: string;
  entityKey: string;
  campaignId: string;
  adGroupId: string;
  action: AdsChangeAction;
  payload: Record<string, unknown>;
  beforeValue: Record<string, unknown> | null;
  afterValue: Record<string, unknown> | null;
  adsProfileId: string;
  currency: string | null;
  entityLabel: string;
  suggestionId: string | null;
  attempts: number;
};

export type AdsChangeRecordInput = {
  changeId: string;
  ok: boolean;
  /** phản hồi Amazon (đã rút gọn) — lưu vào api_response để đối chiếu về sau */
  api?: Record<string, unknown> | null;
  error?: string | null;
};

export type AdsChangeRecordResult = {
  changeId: string;
  status: "applied" | "failed" | string;
  /** true = đã cập nhật bản ghi cục bộ (campaigns/targets/negative_keywords) */
  mirrored: boolean;
  keywordId: string | null;
  /** true = gợi ý A3 gắn với yêu cầu này đã được đóng (applied) */
  suggestionApplied: boolean;
};

export type AdsChangeReleaseResult = {
  changeId: string;
  status: string;
  attempts: number;
};

export type AdsProfileRowInput = {
  adsProfileId: string;
  marketplace: string;
  currency?: string | null;
  countryCode?: string | null;
  accountType?: string | null;
  managerAccountId?: string | null;
  source?: string | null;
};

/**
 * Profile Ads đã lưu (đọc qua view `public.vexim_ads_profiles` của 0020).
 * Runner dùng để biết profile nào + tiền tệ nào cho report (report v3 không trả
 * cột currency, mà tiền tệ sai thì mọi con số ACOS/TACOS đều sai theo).
 */
export type AdsProfileRow = {
  adsProfileId: string;
  marketplace: string;
  currency: string | null;
};

export type AdsCampaignRowInput = {
  campaignId: string;
  name: string;
  adsProfileId?: string | null;
  campaignType?: string | null;
  state?: string | null;
  targetingType?: string | null;
  portfolioId?: string | null;
  dailyBudget?: number | string | null;
  budgetCurrency?: string | null;
  budgetType?: string | null;
  biddingStrategy?: string | null;
  startDate?: string | null;
  /** null CÓ CHỦ Ý = campaign đã gỡ hạn (0020 ghi đè được bằng NULL) */
  endDate?: string | null;
};

export type AdsAdGroupRowInput = {
  adGroupId: string;
  campaignId?: string | null;
  name?: string | null;
  state?: string | null;
  defaultBid?: number | null;
  adsProfileId?: string | null;
  currency?: string | null;
};

export type AdsTargetRowInput = {
  targetKey: string;
  targetKind: "keyword" | "product_target";
  adGroupId?: string | null;
  campaignId?: string | null;
  keywordText?: string | null;
  matchType?: string | null;
  expressionType?: string | null;
  expressionValue?: string | null;
  bid?: number | null;
  state?: string | null;
  adsProfileId?: string | null;
};

export type AdsCampaignMetricRowInput = {
  day: string;
  campaignId: string;
  adsProfileId?: string | null;
  impressions?: number | null;
  clicks?: number | null;
  cost?: number | null;
  sales7d?: number | null;
  sales14d?: number | null;
  sales30d?: number | null;
  purchases7d?: number | null;
  purchases14d?: number | null;
  purchases30d?: number | null;
  unitsSoldClicks7d?: number | null;
  unitsSoldClicks14d?: number | null;
  unitsSoldClicks30d?: number | null;
  units7d?: number | null;
  currency?: string | null;
  budgetAmount?: number | null;
};

export type AdsTargetMetricRowInput = AdsCampaignMetricRowInput & {
  adGroupId: string;
  targetKey: string;
  targetKind?: string | null;
  keywordText?: string | null;
  matchType?: string | null;
  expressionType?: string | null;
  expressionValue?: string | null;
};

export type AdsSearchTermRowInput = AdsCampaignMetricRowInput & {
  adGroupId: string;
  searchTerm: string;
  keywordId?: string | null;
  keywordText?: string | null;
  matchType?: string | null;
};

export type AdsProductMetricRowInput = AdsCampaignMetricRowInput & {
  adGroupId?: string | null;
  advertisedAsin?: string | null;
  advertisedSku?: string | null;
  /** chỉ có ở report `purchased` */
  purchasedAsin?: string | null;
  keywordText?: string | null;
  matchType?: string | null;
  salesOtherSku7d?: number | null;
  salesOtherSku14d?: number | null;
  salesOtherSku30d?: number | null;
  unitsSoldOtherSku7d?: number | null;
  unitsSoldOtherSku14d?: number | null;
  unitsSoldOtherSku30d?: number | null;
};

export type AdsBudgetEventRowInput = {
  day: string;
  campaignId: string;
  eventType: string;
  adsProfileId?: string | null;
  budgetAmount?: number | null;
  currency?: string | null;
  cost?: number | null;
  usagePct?: number | null;
  /** null khi hourSource='unavailable' (report v3 không có giờ) */
  exhaustedHour?: number | null;
  hourSource?: string | null;
  note?: string | null;
};

export type AdsSuggestionRowInput = {
  campaignId: string;
  term: string;
  suggestionType: string;
  adGroupId?: string | null;
  matchType?: string | null;
  confidence?: number | null;
  confidenceLabel?: string | null;
  windowDays?: number | null;
  evidence?: unknown;
  reasons?: unknown;
  keywordId?: string | null;
  keywordText?: string | null;
  targetKind?: string | null;
  adsProfileId?: string | null;
};

/* ---- Module 0: token platform + luồng re-authorize ---- */

export type OauthTokenInput = {
  refreshToken: string;
  authScope?: string | null;
  authorizedAt?: string | null;
  expiresAt?: string | null;
  /** số ngày nhắc trước khi hết hạn (clamp 1..120 → mặc định 30) */
  noticeDays?: number | null;
  connectedBy?: string | null;
};

export type OauthTokenResult = {
  id: string;
  authorizedAt: string | null;
  expiresAt: string | null;
  daysLeft: number | null;
  refreshCount: number | null;
  /** true = đã THAY token cũ (re-authorize), false = lần authorize đầu */
  replaced: boolean;
};

export type OauthStateResult = { state: string; expiresAt: string | null };

export type OauthConsumeResult = {
  ok: boolean;
  sellerAccountId: string | null;
  redirectTo: string | null;
  message: string;
};

export type OauthSoonRow = {
  sellerAccountId: string;
  shop: string | null;
  sellerId: string | null;
  marketplace: string | null;
  authorizedAt: string | null;
  expiresAt: string | null;
  daysLeft: number | null;
  noticeDays: number | null;
  needsReauth: boolean;
  alreadyNoticed: boolean;
  tokenActive: boolean;
  adsProfiles: number;
};

export interface DbAdapter {
  upsertInventorySnapshot(row: InventorySnapshotRow): Promise<void>;
  upsertInventoryDaily(row: InventoryDailyRow): Promise<void>;
  recordNotification(row: NotificationRecord): Promise<void>;
  /**
   * Ghi 1 listing. `null` = "nguồn không cho biết" → GIỮ giá trị cũ (luật của
   * RPC 0016). MockDbAdapter áp đúng luật đó để test không "đẹp giả".
   */
  upsertListing(row: ListingStateRow): Promise<void>;
  /** Ghi theo LÔ (1 lần gọi = 1 request) — report Merchant Listings có thể vài nghìn SKU. */
  upsertListings(rows: ListingStateRow[]): Promise<void>;
  /** Đơn vị bán theo ngày gần nhất (đầu tiên = gần nhất) — dùng tính velocity */
  getSellingDays(sellerAccountId: string, sku: string, days: number): Promise<number[]>;
  /** Danh sách shop active production để worker lặp qua */
  listActiveProductionShops(): Promise<ActiveShop[]>;
  /** Cập nhật sync_jobs (bắt đầu/kết thúc/lỗi) */
  recordSyncJob(job: SyncJobRecord): Promise<void>;
  /** Tạo alert trùng thì không insert lại (dedupe theo rule+sku+shop+status=open) */
  upsertAlert(alert: AlertRowInput): Promise<void>;
  /**
   * Đóng alert đang mở của một rule (vd trạng thái tài khoản về NORMAL).
   * `note` chỉ mang tính ghi chú vận hành (log/test) — ops.alerts chưa có cột note.
   */
  resolveAlerts(input: {
    sellerAccountId: string;
    ruleCode: string;
    note?: string | null;
    resolvedAt?: Date;
  }): Promise<void>;

  /* ---- Module 4 ---- */
  /** Ghi theo LÔ: upsert đơn + THAY thế toàn bộ order_items của các đơn đó */
  upsertOrders(rows: OrderRowInput[]): Promise<void>;
  /** Ghi theo lô, chống trùng bằng dedupe_key */
  upsertReturns(rows: ReturnRowInput[]): Promise<void>;
  upsertOrderDaily(row: OrderDailyRowInput): Promise<void>;

  /* ---- Module 7 ---- */
  upsertAccountHealthSnapshot(row: AccountHealthSnapshotRowInput): Promise<void>;
  upsertAccountHealthIssue(row: AccountHealthIssueRowInput): Promise<void>;

  /* ---- Module 6 ---- */
  upsertSettlement(row: SettlementRowInput): Promise<void>;
  /**
   * Thay TOÀN BỘ dòng tiền của một kỳ settlement.
   * Kỳ settlement đã chốt là dữ liệu bất biến → import lại phải thay, không cộng dồn
   * (tránh nhân đôi tiền khi chạy lại job).
   */
  replaceFinancialEvents(
    sellerAccountId: string,
    settlementId: string,
    rows: FinancialEventRowInput[],
  ): Promise<void>;

  /* ---- Module 3 (L3) ---- */
  /** Lấy các dòng publish đang chờ của một shop (chỉ worker/service_role) */
  listListingPublishQueue(sellerAccountId: string, limit?: number): Promise<ListingPublishQueueRow[]>;
  /** Ghi kết quả publish: queue + trạng thái bản nháp + lịch sử */
  recordListingPublishResult(result: ListingPublishResultInput): Promise<void>;
  /** Ghi/cập nhật cache JSON Schema product type cho form động L3 */
  upsertProductTypeSchema(input: ProductTypeSchemaInput): Promise<void>;

  /* ---- Module 3 nâng cao (0018): phân bổ FC + lịch sử nhận hàng ---- */
  /**
   * Nhập report GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA.
   * Idempotent theo (shop, snapshot_date, sku, FC, disposition) — nhập lại cùng
   * file phải ra updated, KHÔNG nhân đôi tồn.
   */
  upsertFcAllocation(
    sellerAccountId: string,
    rows: FcAllocationRowInput[],
  ): Promise<ReportUpsertCounts>;
  /**
   * Nhập report GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA.
   * Idempotent theo (shop, received_date, sku, lô, FC).
   */
  upsertReceipts(
    sellerAccountId: string,
    rows: ReceiptRowInput[],
  ): Promise<ReportUpsertCounts>;

  /* ---- Module 3 nâng cao (0019): phí theo FC + trạng thái report ---- */
  /**
   * Nhập report GET_FBA_STORAGE_FEE_CHARGES_DATA (phí lưu kho theo ASIN/FNSKU × FC × tháng).
   * Idempotent theo (shop, tháng, ASIN, FNSKU, FC, loại hàng nguy hiểm).
   */
  upsertStorageFees(
    sellerAccountId: string,
    rows: StorageFeeRowInput[],
  ): Promise<FeeUpsertCounts>;
  /**
   * Nhập report GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA (phí inbound sai quy cách).
   * Idempotent theo (shop, ngày báo, lô, carton, SKU, loại vấn đề).
   */
  upsertNoncompliance(
    sellerAccountId: string,
    rows: NoncomplianceRowInput[],
  ): Promise<FeeUpsertCounts>;
  /**
   * Ghi/cập nhật trạng thái một lần yêu cầu report.
   * Vì sao cần: report FBA daily có TRẦN 1 lần / 4 giờ và chạy bất đồng bộ —
   * cron phải nhớ reportId đang chờ để lần sau POLL tiếp thay vì xin report mới.
   */
  setReportRequest(
    sellerAccountId: string,
    req: ReportRequestInput,
  ): Promise<ReportRequestRow>;
  /** Đọc trạng thái report để quyết định: poll tiếp · xin mới · hay bỏ qua. */
  listReportRequests(
    sellerAccountId: string,
    opts?: { reportType?: string; limit?: number },
  ): Promise<ReportRequestRow[]>;

  /* ---- Module 6 Đợt 2 (F3/F4) ---- */
  /** Nhập report GET_FBA_REIMBURSEMENTS_DATA (idempotent theo dedupeKey) */
  upsertReimbursements(
    sellerAccountId: string,
    rows: ReimbursementRowInput[],
  ): Promise<{ inserted: number; updated: number }>;
  /** Ghi khoản nghi ngờ SOP-09; KHÔNG đụng khoản con người đang xử lý */
  upsertReimbursementClaims(
    sellerAccountId: string,
    rows: ReimbursementClaimRowInput[],
  ): Promise<{ inserted: number; refreshed: number; kept: number }>;
  /** Đọc claim hiện có để đối chiếu với report reimbursement */
  listReimbursementClaims(sellerAccountId: string, limit?: number): Promise<ReimbursementClaimRow[]>;
  /** Ghi lợi nhuận SKU/ngày (thay thế theo khoá, không cộng dồn) */
  upsertSkuProfit(sellerAccountId: string, rows: SkuProfitRowInput[]): Promise<number>;
  /** Giá vốn hiệu lực tại một ngày (catalog.cost_inputs) */
  listEffectiveCosts(sellerAccountId: string, on: string): Promise<EffectiveCostRow[]>;
  /** Dòng tiền đã quyết toán trong khoảng ngày (đầu vào F4) */
  listFinancialEvents(
    sellerAccountId: string,
    from: string,
    to: string,
    limit?: number,
  ): Promise<FinancialEventQueryRow[]>;

  /* ---- Module 5 phần 1 (0020): Amazon Ads ---- */
  /** /v2/profiles — 1 shop có thể có nhiều profile (mỗi marketplace một cái). */
  upsertAdsProfiles(sellerAccountId: string, rows: AdsProfileRowInput[]): Promise<AdsEntityCounts>;
  /** Đọc lại profile đã lưu (runner cần ads_profile_id + currency cho report). */
  listAdsProfiles(sellerAccountId: string): Promise<AdsProfileRow[]>;
  /** Campaign Management v3 `/sp/campaigns/list` */
  upsertAdsCampaigns(sellerAccountId: string, rows: AdsCampaignRowInput[]): Promise<AdsEntityCounts>;
  /** Campaign Management v3 `/sp/adGroups/list` */
  upsertAdsAdGroups(sellerAccountId: string, rows: AdsAdGroupRowInput[]): Promise<AdsEntityCounts>;
  /** Keywords + product targets (một hàm vì màn A2 hiển thị chung một bảng) */
  upsertAdsTargets(sellerAccountId: string, rows: AdsTargetRowInput[]): Promise<AdsEntityCounts>;
  /** Metrics campaign theo NGÀY (report spCampaigns, cửa sổ 7/14/30 ngày) */
  upsertAdsCampaignMetrics(
    sellerAccountId: string,
    rows: AdsCampaignMetricRowInput[],
  ): Promise<AdsMetricCounts>;
  /** Metrics theo keyword/target (report spTargeting) */
  upsertAdsTargetMetrics(
    sellerAccountId: string,
    rows: AdsTargetMetricRowInput[],
  ): Promise<AdsMetricCounts>;
  /** Search term thật của người mua (report spSearchTerm) */
  upsertAdsSearchTerms(
    sellerAccountId: string,
    rows: AdsSearchTermRowInput[],
  ): Promise<AdsMetricCounts>;
  /** Theo ASIN/SKU: `advertised` (spAdvertisedProduct) hoặc `purchased` (spPurchasedProduct) */
  upsertAdsProductMetrics(
    sellerAccountId: string,
    level: "advertised" | "purchased",
    rows: AdsProductMetricRowInput[],
  ): Promise<AdsMetricCounts>;
  /** Sự kiện ngân sách (capped/under_delivery/budget_increased…) */
  upsertAdsBudgetEvents(
    sellerAccountId: string,
    rows: AdsBudgetEventRowInput[],
  ): Promise<AdsEntityCounts>;
  /**
   * Gợi ý negative của worker. Gợi ý đã được con người quyết (approved/rejected)
   * thì job KHÔNG ghi đè — trả về ở `kept` (SOP-04 bước 3).
   */
  upsertAdsSuggestions(
    sellerAccountId: string,
    rows: AdsSuggestionRowInput[],
  ): Promise<AdsSuggestionCounts>;
  /**
   * Lấp `finance.sku_profit_daily.ads_spend` từ report spAdvertisedProduct.
   * CHỈ cập nhật dòng đã có (không tạo dòng lợi nhuận) và CHỈ cùng tiền tệ.
   */
  applyAdsSpend(sellerAccountId: string, from: string, to: string): Promise<AdsSpendCounts>;

  /* ---- Module 5 phần 3 (0021): chiều GHI lên Amazon Ads ---- */
  /**
   * Nhận các yêu cầu ĐÃ DUYỆT của một shop (approved → applying, +1 attempts).
   * KHÔNG bao giờ trả về dòng `pending_approval`: ngưỡng 30%/ngày phải được
   * người duyệt TRƯỚC khi có request nào gửi lên Amazon (SOP-05 bước 4).
   */
  claimAdsChanges(sellerAccountId: string, limit?: number): Promise<AdsChangeRow[]>;
  /** Ghi kết quả Amazon trả về (applied/failed) + cập nhật cục bộ + audit. */
  recordAdsChange(input: AdsChangeRecordInput): Promise<AdsChangeRecordResult>;
  /** 429/5xx: trả yêu cầu về 'approved' để lần chạy sau thử tiếp. */
  releaseAdsChange(changeId: string, reason: string): Promise<AdsChangeReleaseResult>;

  /* ---- Module 0 (0020): token platform + re-authorize ---- */
  saveOauthToken(sellerAccountId: string, token: OauthTokenInput): Promise<OauthTokenResult>;
  createOauthState(
    sellerAccountId: string,
    redirectTo?: string | null,
    ttlMinutes?: number | null,
  ): Promise<OauthStateResult>;
  consumeOauthState(state: string): Promise<OauthConsumeResult>;
  markOauthNotice(sellerAccountId: string): Promise<{ rotateReminderSent: boolean }>;
  /** Shop sắp/đã hết hạn token — cron nhắc re-auth dùng hàm này (service_role). */
  listOauthSoon(days?: number | null): Promise<OauthSoonRow[]>;

  /** Module 0 — ghi mức dùng API (SP-API, Ads) theo ngày/shop/nhóm */
  recordApiUsage(input: { sellerAccountId: string; day: string; apiGroup: string; calls?: number }): Promise<void>;
}

/* ---- helper cho luật nhập report PHÍ (0019) trong MockDbAdapter ---- */

const MONTH_RE = /^\d{4}-\d{2}$/;

function storageFeeKey(r: {
  monthOfCharge?: string | null; asin?: string | null; fnsku?: string | null;
  fulfillmentCenter?: string | null; dangerousGoodsStorageType?: string | null;
}): string {
  return [
    r.monthOfCharge ?? "", r.asin ?? "", r.fnsku ?? "",
    r.fulfillmentCenter ?? "", r.dangerousGoodsStorageType ?? "",
  ].join("\u0000");
}

function noncomplianceKey(r: {
  issueReportedDate?: string | null; fbaShipmentId?: string | null;
  fbaCartonId?: string | null; sku?: string | null; problemType?: string | null;
}): string {
  return [
    r.issueReportedDate ?? "", r.fbaShipmentId ?? "", r.fbaCartonId ?? "",
    r.sku ?? "", r.problemType ?? "",
  ].join("\u0000");
}

function reportRequestKey(r: {
  reportType: string; dataStart?: string | null; dataEnd?: string | null;
}): string {
  return [r.reportType, r.dataStart ?? "", r.dataEnd ?? ""].join("\u0000");
}

/** Tiền tệ có mặt, đã sắp xếp — không cộng gộp, chỉ liệt kê. */
function distinctSorted(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.map((v) => (v ?? "").trim()).filter((v) => v !== ""))].sort();
}

/** Số lớn hơn thắng (RPC dùng max()) — cùng một sự việc đo 2 lần, không cộng. */
function biggerOf<T>(a: T | null | undefined, b: T | null | undefined): T | null | undefined {
  if (a === null || a === undefined) return b;
  if (b === null || b === undefined) return a;
  if (typeof a === "number" && typeof b === "number") return a >= b ? a : b;
  if (typeof a === "boolean" && typeof b === "boolean") return a || b ? (a ? a : b) : a;
  return String(a) >= String(b) ? a : b;
}

/** Gộp 2 dòng trùng khoá trong CÙNG file: mỗi trường lấy giá trị lớn hơn / khác rỗng. */
function maxFeeRow<T extends Record<string, unknown>>(prev: T, next: T): T {
  const out: Record<string, unknown> = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    if (k === "source" || k === "monthOfCharge" || k === "issueReportedDate") {
      out[k] = v ?? out[k];
      continue;
    }
    out[k] = biggerOf(out[k] as never, v as never) ?? out[k];
  }
  return out as T;
}

/** Ghi đè dòng đã có: số mới KHÁC NULL thắng, null GIỮ số cũ (đúng luật coalesce của RPC). */
function coalesceFeeRow<T extends Record<string, unknown>>(prev: T, next: T): T {
  const out: Record<string, unknown> = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out as T;
}

/** Trạng thái lạ → "failed" (RPC cũng vậy) để view lọc được theo status. */
export function normalizeReportRequestStatus(status: string | null | undefined): ReportRequestStatus {
  const s = (status ?? "").trim().toLowerCase();
  return (REPORT_REQUEST_STATUSES as readonly string[]).includes(s)
    ? (s as ReportRequestStatus)
    : "failed";
}

/** Tháng hợp lệ để Mock từ chối đúng như RPC (YYYY-MM). */
export function isValidReportMonth(month: string | null | undefined): boolean {
  return MONTH_RE.test((month ?? "").trim());
}

/**
 * Luật nhập report của RPC 0018, áp y hệt trong MockDbAdapter để test không
 * "xanh giả" so với production:
 *   1. dòng không dựng được khoá (thiếu SKU / ngày sai / quantity không phải số)
 *      → BỎ QUA, đếm `skipped`;
 *   2. trùng khoá trong cùng lô → CỘNG quantity, đếm `merged` (nếu ghi 2 lần
 *      Postgres sẽ báo "cannot affect row a second time");
 *   3. khoá đã có trong bảng → đè số mới, đếm `updated` (không phình bảng).
 */
function upsertReportBatch<R, T extends { quantity: number }>(spec: {
  store: (T & { sellerAccountId: string })[];
  sellerAccountId: string;
  rows: R[];
  /** null = dòng không hợp lệ → skipped */
  project: (row: R) => T | null;
  /** khoá tự nhiên của report, dùng được cho cả dòng mới và dòng đang lưu */
  key: (row: T) => string;
}): ReportUpsertCounts {
  const { store, sellerAccountId, rows, project, key } = spec;
  let skipped = 0;
  let merged = 0;
  const batch = new Map<string, T>();
  for (const row of rows) {
    const value = project(row);
    if (value === null) {
      skipped++;
      continue;
    }
    const k = key(value);
    const prev = batch.get(k);
    if (prev) {
      prev.quantity += value.quantity;
      merged++;
    } else {
      batch.set(k, value);
    }
  }
  let inserted = 0;
  let updated = 0;
  for (const [k, value] of batch) {
    const i = store.findIndex(
      (r) => r.sellerAccountId === sellerAccountId && key(r) === k,
    );
    if (i >= 0) {
      store[i] = { ...store[i], ...value, sellerAccountId };
      updated++;
    } else {
      store.push({ ...value, sellerAccountId });
      inserted++;
    }
  }
  return { inserted, updated, skipped, merged };
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Ngày + SKU + số nguyên hợp lệ? RPC 0018 cũng từ chối đúng ba thứ này. */
function validReportKey(date: unknown, sku: unknown, quantity: unknown): boolean {
  return (
    typeof date === "string" &&
    ISO_DATE_RE.test(date) &&
    typeof sku === "string" &&
    sku.trim() !== "" &&
    typeof quantity === "number" &&
    Number.isInteger(quantity)
  );
}

/** In-memory — cho test & DEMO MODE */
export class MockDbAdapter implements DbAdapter {
  snapshots: InventorySnapshotRow[] = [];
  daily: InventoryDailyRow[] = [];
  notifications: NotificationRecord[] = [];
  listings: ListingStateRow[] = [];
  jobs: SyncJobRecord[] = [];
  alerts: AlertRowInput[] = [];
  shops: ActiveShop[] = [];
  /* Module 4/6/7 */
  orders: OrderRowInput[] = [];
  returns: ReturnRowInput[] = [];
  orderDaily: OrderDailyRowInput[] = [];
  healthSnapshots: AccountHealthSnapshotRowInput[] = [];
  /* Module 3 (L3) */
  publishQueue: ListingPublishQueueRow[] = [];
  publishResults: ListingPublishResultInput[] = [];
  productTypeSchemas: ProductTypeSchemaInput[] = [];
  /* Module 3 nâng cao (0018) */
  fcAllocation: (FcAllocationRowInput & { sellerAccountId: string })[] = [];
  receipts: (ReceiptRowInput & { sellerAccountId: string })[] = [];
  /* Module 3 nâng cao (0019): phí theo FC + trạng thái report */
  storageFees: (StorageFeeRowInput & { sellerAccountId: string })[] = [];
  noncompliance: (NoncomplianceRowInput & { sellerAccountId: string })[] = [];
  reportRequests: ReportRequestRow[] = [];
  /* Module 6 Đợt 2 (F3/F4) */
  reimbursements: (ReimbursementRowInput & { sellerAccountId: string })[] = [];
  reimbursementClaims: (ReimbursementClaimRowInput & { id: string; sellerAccountId: string; status: string })[] = [];
  skuProfit: (SkuProfitRowInput & { sellerAccountId: string })[] = [];
  effectiveCosts: (EffectiveCostRow & { sellerAccountId: string; effectiveFrom: string; effectiveTo: string | null })[] = [];
  healthIssues: AccountHealthIssueRowInput[] = [];
  settlements: SettlementRowInput[] = [];
  financialEvents: FinancialEventRowInput[] = [];

  /* ---- Module 5 phần 1 (0020): Amazon Ads ---- */
  adsProfiles: (AdsProfileRowInput & { sellerAccountId: string })[] = [];
  adsCampaigns: (AdsCampaignRowInput & { sellerAccountId: string })[] = [];
  adsAdGroups: (AdsAdGroupRowInput & { sellerAccountId: string })[] = [];
  adsTargets: (AdsTargetRowInput & { sellerAccountId: string })[] = [];
  adsCampaignMetrics: (AdsCampaignMetricRowInput & { sellerAccountId: string })[] = [];
  adsTargetMetrics: (AdsTargetMetricRowInput & { sellerAccountId: string })[] = [];
  adsSearchTerms: (AdsSearchTermRowInput & { sellerAccountId: string })[] = [];
  adsAdvertisedProducts: (AdsProductMetricRowInput & { sellerAccountId: string })[] = [];
  adsPurchasedProducts: (AdsProductMetricRowInput & { sellerAccountId: string })[] = [];
  adsBudgetEvents: (AdsBudgetEventRowInput & { sellerAccountId: string })[] = [];
  adsSuggestions: (AdsSuggestionRowInput & { sellerAccountId: string; status: string })[] = [];
  /* Module 5 phần 3 (0021) — hàng đợi ghi + gương negative */
  adsChanges: (Omit<AdsChangeRow, "changeId"> & {
    changeId: string;
    sellerAccountId: string;
    status: string;
    apiResponse: Record<string, unknown> | null;
    error: string | null;
    appliedAt: string | null;
  })[] = [];
  adsNegativeKeywords: {
    sellerAccountId: string;
    adsProfileId: string;
    campaignId: string;
    adGroupId: string;
    keywordId: string;
    keywordText: string;
    matchType: string;
    changeRequestId: string;
  }[] = [];
  oauthTokens: (OauthTokenInput & {
    sellerAccountId: string;
    authorizedAt: string;
    expiresAt: string;
    refreshCount: number;
    rotateReminderSent: boolean;
    noticeSentAt: string | null;
    lastRefreshAt: string | null;
  })[] = [];
  oauthStates: {
    state: string;
    sellerAccountId: string;
    redirectTo: string | null;
    expiresAt: string;
    usedAt: string | null;
  }[] = [];
  apiUsage: { sellerAccountId: string; day: string; apiGroup: string; calls: number }[] = [];
  private oauthStateSeq = 0;
  private sellingDays: Record<string, number[]> = {};

  seedSellingDays(sellerAccountId: string, sku: string, days: number[]): void {
    this.sellingDays[`${sellerAccountId}:${sku}`] = days;
  }
  seedShops(shops: ActiveShop[]): void {
    this.shops = shops;
  }

  async upsertInventorySnapshot(row: InventorySnapshotRow): Promise<void> {
    const i = this.snapshots.findIndex(
      (s) => s.sellerAccountId === row.sellerAccountId && s.sku === row.sku,
    );
    if (i >= 0) this.snapshots[i] = row;
    else this.snapshots.push(row);
  }

  async upsertInventoryDaily(row: InventoryDailyRow): Promise<void> {
    const i = this.daily.findIndex(
      (d) =>
        d.sellerAccountId === row.sellerAccountId &&
        d.sku === row.sku &&
        d.day === row.day,
    );
    if (i >= 0) this.daily[i] = row;
    else this.daily.push(row);
  }

  async recordNotification(row: NotificationRecord): Promise<void> {
    this.notifications.push(row);
  }

  async upsertListing(row: ListingStateRow): Promise<void> {
    await this.upsertListings([row]);
  }

  /**
   * Áp ĐÚNG luật ghi của RPC `public.vexim_worker_upsert_listings` (0016):
   * null/undefined = "chưa biết" → giữ giá trị cũ. Nếu mock cứ ghi đè null thì
   * test sẽ xanh trong khi bản Supabase thật lại hành xử khác — loại lỗi đó đã
   * xảy ra với upsertListing() stub rỗng, nên mock phải khó tính như DB thật.
   */
  async upsertListings(rows: ListingStateRow[]): Promise<void> {
    for (const row of rows) {
      const i = this.listings.findIndex(
        (l) => l.sellerAccountId === row.sellerAccountId && l.sku === row.sku,
      );
      if (i < 0) {
        this.listings.push({ ...row });
        continue;
      }
      const merged: ListingStateRow = { ...this.listings[i] };
      const keepIfNull = [
        "asin",
        "itemName",
        "status",
        "price",
        "currency",
        "quantity",
        "productType",
        "buyable",
        "discoverable",
        "issueErrors",
        "issueWarnings",
        "enforcementActions",
        "source",
      ] as const;
      for (const key of keepIfNull) {
        const v = row[key];
        if (v !== undefined && v !== null) {
          (merged as unknown as Record<string, unknown>)[key] = v;
        }
      }
      // issues: mảng (kể cả RỖNG) = đã xác nhận → thay thế; null/undefined = giữ
      if (Array.isArray(row.issues)) merged.issues = row.issues;
      // strandedReason: key CÓ MẶT thì ghi kể cả null (hết stranded → xoá lý do)
      if ("strandedReason" in row) merged.strandedReason = row.strandedReason ?? null;
      merged.updatedAt = row.updatedAt;
      this.listings[i] = merged;
    }
  }

  async getSellingDays(sellerAccountId: string, sku: string, days: number): Promise<number[]> {
    const all = this.sellingDays[`${sellerAccountId}:${sku}`] ?? [];
    return all.slice(0, days);
  }

  async listActiveProductionShops(): Promise<ActiveShop[]> {
    return this.shops;
  }

  async recordSyncJob(job: SyncJobRecord): Promise<void> {
    // Mô phỏng đúng SupabaseDbAdapter: có id → UPDATE dòng cũ; chưa có id →
    // INSERT và GÁN id vào object. Trước đây mock chỉ push() nên test không
    // bắt được bug "dòng running mồ côi" (caller quên dùng lại object job).
    if (job.id) {
      const i = this.jobs.findIndex((j) => j.id === job.id);
      if (i >= 0) this.jobs[i] = { ...job };
      else this.jobs.push({ ...job });
      return;
    }
    job.id = `mock-sync-job-${this.jobs.length + 1}`;
    this.jobs.push({ ...job });
  }

  async upsertAlert(alert: AlertRowInput): Promise<void> {
    const exists = this.alerts.find(
      (a) =>
        a.sellerAccountId === alert.sellerAccountId &&
        a.ruleCode === alert.ruleCode &&
        a.title === alert.title,
    );
    if (!exists) this.alerts.push(alert);
  }

  /* ---- Module 4 ---- */
  async upsertOrders(rows: OrderRowInput[]): Promise<void> {
    for (const row of rows) {
      const i = this.orders.findIndex(
        (o) => o.sellerAccountId === row.sellerAccountId && o.amazonOrderId === row.amazonOrderId,
      );
      if (i >= 0) this.orders[i] = row;
      else this.orders.push(row);
    }
  }

  async upsertReturns(rows: ReturnRowInput[]): Promise<void> {
    for (const row of rows) {
      const i = this.returns.findIndex(
        (r) => r.sellerAccountId === row.sellerAccountId && r.dedupeKey === row.dedupeKey,
      );
      if (i >= 0) this.returns[i] = row;
      else this.returns.push(row);
    }
  }

  async upsertOrderDaily(row: OrderDailyRowInput): Promise<void> {
    const i = this.orderDaily.findIndex(
      (d) => d.sellerAccountId === row.sellerAccountId && d.day === row.day,
    );
    if (i >= 0) this.orderDaily[i] = row;
    else this.orderDaily.push(row);
  }

  /* ---- Module 7 ---- */
  async upsertAccountHealthSnapshot(row: AccountHealthSnapshotRowInput): Promise<void> {
    const i = this.healthSnapshots.findIndex(
      (s) =>
        s.sellerAccountId === row.sellerAccountId &&
        s.day === row.day &&
        s.marketplaceId === row.marketplaceId,
    );
    if (i >= 0) this.healthSnapshots[i] = row;
    else this.healthSnapshots.push(row);
  }

  async upsertAccountHealthIssue(row: AccountHealthIssueRowInput): Promise<void> {
    const i = this.healthIssues.findIndex(
      (s) =>
        s.sellerAccountId === row.sellerAccountId &&
        s.marketplaceId === row.marketplaceId &&
        s.category === row.category,
    );
    if (i >= 0) this.healthIssues[i] = row;
    else this.healthIssues.push(row);
  }

  /* ---- Module 6 ---- */
  async upsertSettlement(row: SettlementRowInput): Promise<void> {
    const i = this.settlements.findIndex(
      (s) => s.sellerAccountId === row.sellerAccountId && s.settlementId === row.settlementId,
    );
    if (i >= 0) this.settlements[i] = row;
    else this.settlements.push(row);
  }

  async replaceFinancialEvents(
    sellerAccountId: string,
    settlementId: string,
    rows: FinancialEventRowInput[],
  ): Promise<void> {
    this.financialEvents = this.financialEvents.filter(
      (e) => !(e.sellerAccountId === sellerAccountId && e.settlementId === settlementId),
    );
    this.financialEvents.push(...rows);
  }

  /* ---- Alerts ---- */
  resolveAlerts(input: {
    sellerAccountId: string;
    ruleCode: string;
    note?: string | null;
    resolvedAt?: Date;
  }): Promise<void> {
    for (const a of this.alerts) {
      if (
        a.sellerAccountId === input.sellerAccountId &&
        a.ruleCode === input.ruleCode &&
        !a.resolvedAt
      ) {
        a.resolvedAt = input.resolvedAt ?? new Date();
      }
    }
    return Promise.resolve();
  }
  async listListingPublishQueue(sellerAccountId: string, limit = 20): Promise<ListingPublishQueueRow[]> {
    return this.publishQueue.filter((row) => row.sellerAccountId === sellerAccountId).slice(0, limit);
  }

  async recordListingPublishResult(result: ListingPublishResultInput): Promise<void> {
    this.publishResults.push(result);
  }

  async upsertProductTypeSchema(input: ProductTypeSchemaInput): Promise<void> {
    const key = `${input.marketplaceId}:${input.productType}:${input.requirements}`;
    this.productTypeSchemas = this.productTypeSchemas.filter(
      (row) => `${row.marketplaceId}:${row.productType}:${row.requirements}` !== key,
    );
    this.productTypeSchemas.push(input);
  }

  /* ---- Module 6 Đợt 2 (F3/F4) ---- */

  async upsertFcAllocation(
    sellerAccountId: string,
    rows: FcAllocationRowInput[],
  ): Promise<ReportUpsertCounts> {
    return upsertReportBatch<FcAllocationRowInput, FcAllocationRowInput>({
      store: this.fcAllocation,
      sellerAccountId,
      rows,
      project: (r) =>
        validReportKey(r.snapshotDate, r.sku, r.quantity)
          ? {
              snapshotDate: r.snapshotDate,
              sku: r.sku.trim(),
              fnsku: r.fnsku ?? null,
              productName: r.productName ?? null,
              quantity: r.quantity,
              fulfillmentCenterId: (r.fulfillmentCenterId ?? "").trim().toUpperCase(),
              detailedDisposition: (r.detailedDisposition ?? "").trim().toUpperCase(),
              country: r.country ?? null,
              source: r.source ?? "report",
            }
          : null,
      key: (r) =>
        [r.snapshotDate, r.sku, r.fulfillmentCenterId ?? "", r.detailedDisposition ?? ""].join("\u0000"),
    });
  }

  async upsertReceipts(
    sellerAccountId: string,
    rows: ReceiptRowInput[],
  ): Promise<ReportUpsertCounts> {
    return upsertReportBatch<ReceiptRowInput, ReceiptRowInput>({
      store: this.receipts,
      sellerAccountId,
      rows,
      project: (r) =>
        validReportKey(r.receivedDate, r.sku, r.quantity)
          ? {
              receivedDate: r.receivedDate,
              sku: r.sku.trim(),
              fnsku: r.fnsku ?? null,
              productName: r.productName ?? null,
              quantity: r.quantity,
              fbaShipmentId: (r.fbaShipmentId ?? "").trim().toUpperCase(),
              fulfillmentCenterId: (r.fulfillmentCenterId ?? "").trim().toUpperCase(),
              source: r.source ?? "report",
            }
          : null,
      key: (r) =>
        [r.receivedDate, r.sku, r.fbaShipmentId ?? "", r.fulfillmentCenterId ?? ""].join("\u0000"),
    });
  }

  /* ---- Module 3 nâng cao (0019): phí theo FC + trạng thái report ---- */

  /**
   * Luật của RPC 0019, áp y hệt trong Mock để test không "xanh giả":
   *   1. tháng sai dạng / không có cả ASIN lẫn FNSKU → BỎ, đếm skipped;
   *   2. trùng khoá trong cùng file → lấy giá trị LỚN HƠN cho số đo (RPC dùng
   *      max()), đếm merged — vì đây là số đo của cùng một sự việc, không phải
   *      số lượng để cộng dồn như 0018;
   *   3. khoá đã có → số mới KHÁC NULL đè số cũ, null GIỮ số cũ (coalesce).
   */
  async upsertStorageFees(
    sellerAccountId: string,
    rows: StorageFeeRowInput[],
  ): Promise<FeeUpsertCounts> {
    let skipped = 0;
    let merged = 0;
    const batch = new Map<string, StorageFeeRowInput>();
    for (const r of rows) {
      const month = (r.monthOfCharge ?? "").trim();
      const asin = (r.asin ?? "").trim().toUpperCase();
      const fnsku = (r.fnsku ?? "").trim().toUpperCase();
      if (!/^\d{4}-\d{2}$/.test(month) || (asin === "" && fnsku === "")) {
        skipped++;
        continue;
      }
      const clean: StorageFeeRowInput = {
        ...r,
        monthOfCharge: month,
        asin,
        fnsku,
        fulfillmentCenter: (r.fulfillmentCenter ?? "").trim().toUpperCase(),
        dangerousGoodsStorageType: (r.dangerousGoodsStorageType ?? "").trim().toUpperCase(),
        currency: r.currency ? r.currency.trim().toUpperCase() : null,
        source: r.source ?? "report",
      };
      const k = storageFeeKey(clean);
      const prev = batch.get(k);
      batch.set(k, prev ? maxFeeRow(prev, clean) : clean);
      if (prev) merged++;
    }
    const valid = [...batch.values()];
    let inserted = 0;
    let updated = 0;
    for (const row of valid) {
      const k = storageFeeKey(row);
      const i = this.storageFees.findIndex(
        (x) => x.sellerAccountId === sellerAccountId && storageFeeKey(x) === k,
      );
      if (i >= 0) {
        this.storageFees[i] = coalesceFeeRow(this.storageFees[i], { ...row, sellerAccountId });
        updated++;
      } else {
        this.storageFees.push({ ...row, sellerAccountId });
        inserted++;
      }
    }
    return {
      inserted,
      updated,
      skipped,
      merged,
      groups: new Set(valid.map((r) => r.monthOfCharge)).size,
      currencies: distinctSorted(valid.map((r) => r.currency)),
    };
  }

  async upsertNoncompliance(
    sellerAccountId: string,
    rows: NoncomplianceRowInput[],
  ): Promise<FeeUpsertCounts> {
    let skipped = 0;
    let merged = 0;
    const batch = new Map<string, NoncomplianceRowInput>();
    for (const r of rows) {
      const date = (r.issueReportedDate ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        skipped++;
        continue;
      }
      const clean: NoncomplianceRowInput = {
        ...r,
        issueReportedDate: date,
        fbaShipmentId: (r.fbaShipmentId ?? "").trim().toUpperCase(),
        fbaCartonId: (r.fbaCartonId ?? "").trim().toUpperCase(),
        fulfillmentCenterId: (r.fulfillmentCenterId ?? "").trim().toUpperCase(),
        sku: (r.sku ?? "").trim(),
        problemType: (r.problemType ?? "").trim().toUpperCase(),
        fnsku: r.fnsku ? r.fnsku.trim().toUpperCase() : null,
        asin: r.asin ? r.asin.trim().toUpperCase() : null,
        currency: r.currency ? r.currency.trim().toUpperCase() : null,
        coachingLevel: r.coachingLevel ? r.coachingLevel.trim().toUpperCase() : null,
        feeType: r.feeType ? r.feeType.trim().toUpperCase() : null,
        alertStatus: r.alertStatus ? r.alertStatus.trim().toUpperCase() : null,
        problemLevel: r.problemLevel ? r.problemLevel.trim().toUpperCase() : null,
        source: r.source ?? "report",
      };
      const k = noncomplianceKey(clean);
      const prev = batch.get(k);
      batch.set(k, prev ? maxFeeRow(prev, clean) : clean);
      if (prev) merged++;
    }
    const valid = [...batch.values()];
    let inserted = 0;
    let updated = 0;
    for (const row of valid) {
      const k = noncomplianceKey(row);
      const i = this.noncompliance.findIndex(
        (x) => x.sellerAccountId === sellerAccountId && noncomplianceKey(x) === k,
      );
      if (i >= 0) {
        this.noncompliance[i] = coalesceFeeRow(this.noncompliance[i], { ...row, sellerAccountId });
        updated++;
      } else {
        this.noncompliance.push({ ...row, sellerAccountId });
        inserted++;
      }
    }
    return {
      inserted,
      updated,
      skipped,
      merged,
      groups: new Set(valid.map((r) => r.fbaShipmentId).filter((v) => v !== "")).size,
      currencies: distinctSorted(valid.map((r) => r.currency)),
    };
  }

  /** Luật của RPC vexim_worker_set_report_request: cùng khoảng ngày → 1 dòng, attempts++. */
  async setReportRequest(
    sellerAccountId: string,
    req: ReportRequestInput,
  ): Promise<ReportRequestRow> {
    const type = (req.reportType ?? "").trim();
    if (!type) throw new Error("setReportRequest: thiếu reportType");
    const status = normalizeReportRequestStatus(req.status);
    const k = reportRequestKey({ ...req, reportType: type });
    const i = this.reportRequests.findIndex(
      (x) => x.sellerAccountId === sellerAccountId && reportRequestKey(x) === k,
    );
    if (i >= 0) {
      const prev = this.reportRequests[i];
      const next: ReportRequestRow = {
        ...prev,
        marketplaceId: req.marketplaceId ?? prev.marketplaceId ?? null,
        reportId: req.reportId ?? prev.reportId ?? null,
        reportDocumentId: req.reportDocumentId ?? prev.reportDocumentId ?? null,
        status,
        rowsImported: req.rowsImported ?? prev.rowsImported ?? null,
        lastError: req.lastError ?? null,
        attempts: prev.attempts + 1,
        requestedAt: prev.requestedAt ?? req.requestedAt ?? new Date().toISOString(),
        completedAt: req.completedAt ?? prev.completedAt ?? null,
        importedAt: req.importedAt ?? prev.importedAt ?? null,
      };
      this.reportRequests[i] = next;
      return next;
    }
    const row: ReportRequestRow = {
      ...req,
      id: `mock-report-request-${this.reportRequests.length + 1}`,
      sellerAccountId,
      reportType: type,
      status,
      attempts: 1,
      requestedAt: req.requestedAt ?? new Date().toISOString(),
      rowsImported: req.rowsImported ?? null,
      lastError: req.lastError ?? null,
      completedAt: req.completedAt ?? null,
      importedAt: req.importedAt ?? null,
    };
    this.reportRequests.push(row);
    return row;
  }

  async listReportRequests(
    sellerAccountId: string,
    opts?: { reportType?: string; limit?: number },
  ): Promise<ReportRequestRow[]> {
    const limit = opts?.limit ?? 200;
    return this.reportRequests
      .filter((r) => r.sellerAccountId === sellerAccountId)
      .filter((r) => (opts?.reportType ? r.reportType === opts.reportType : true))
      .sort((a, b) => String(b.requestedAt ?? "").localeCompare(String(a.requestedAt ?? "")))
      .slice(0, limit);
  }

  async upsertReimbursements(
    sellerAccountId: string,
    rows: ReimbursementRowInput[],
  ): Promise<{ inserted: number; updated: number }> {
    let inserted = 0;
    let updated = 0;
    for (const row of rows) {
      const index = this.reimbursements.findIndex(
        (r) => r.sellerAccountId === sellerAccountId && r.dedupeKey === row.dedupeKey,
      );
      if (index >= 0) {
        this.reimbursements[index] = { ...row, sellerAccountId };
        updated++;
      } else {
        this.reimbursements.push({ ...row, sellerAccountId });
        inserted++;
      }
    }
    return { inserted, updated };
  }

  async upsertReimbursementClaims(
    sellerAccountId: string,
    rows: ReimbursementClaimRowInput[],
  ): Promise<{ inserted: number; refreshed: number; kept: number }> {
    let inserted = 0;
    let refreshed = 0;
    let kept = 0;
    for (const row of rows) {
      const index = this.reimbursementClaims.findIndex(
        (c) =>
          c.sellerAccountId === sellerAccountId &&
          c.source === row.source &&
          c.sourceRef === row.sourceRef &&
          c.sku === row.sku,
      );
      if (index < 0) {
        this.reimbursementClaims.push({
          ...row,
          id: `claim-${this.reimbursementClaims.length + 1}`,
          sellerAccountId,
          status: "suspected",
        });
        inserted++;
      } else if (this.reimbursementClaims[index].status === "suspected") {
        this.reimbursementClaims[index] = { ...this.reimbursementClaims[index], ...row };
        refreshed++;
      } else {
        kept++;
      }
    }
    return { inserted, refreshed, kept };
  }

  async listReimbursementClaims(sellerAccountId: string, limit = 500): Promise<ReimbursementClaimRow[]> {
    return this.reimbursementClaims
      .filter((c) => c.sellerAccountId === sellerAccountId)
      .slice(0, limit)
      .map((c) => ({
        id: c.id,
        sku: c.sku,
        status: c.status,
        reimbursedAmount: null,
        reimbursementId: null,
        detectedAt: new Date().toISOString(),
        filedAt: null,
        ageHours: null,
      }));
  }

  async upsertSkuProfit(sellerAccountId: string, rows: SkuProfitRowInput[]): Promise<number> {
    for (const row of rows) {
      const index = this.skuProfit.findIndex(
        (r) =>
          r.sellerAccountId === sellerAccountId &&
          r.sku === row.sku &&
          r.day === row.day &&
          r.currency === row.currency,
      );
      if (index >= 0) this.skuProfit[index] = { ...row, sellerAccountId };
      else this.skuProfit.push({ ...row, sellerAccountId });
    }
    return rows.length;
  }

  async listFinancialEvents(
    sellerAccountId: string,
    from: string,
    to: string,
    limit = 50000,
  ): Promise<FinancialEventQueryRow[]> {
    return this.financialEvents
      .filter((row) => {
        if (row.sellerAccountId !== sellerAccountId) return false;
        const day = new Date(row.eventDate).toISOString().slice(0, 10);
        return day >= from && day <= to;
      })
      .slice(0, limit)
      .map((row) => ({
        sku: row.sku ?? null,
        eventType: row.eventType,
        amountType: row.amountType ?? null,
        amountDescription: row.amountDescription ?? null,
        amount: row.amount,
        quantity: row.quantity ?? null,
        currency: row.currency,
        eventDate: row.eventDate,
      }));
  }

  async listEffectiveCosts(sellerAccountId: string, on: string): Promise<EffectiveCostRow[]> {
    const bySku = new Map<string, EffectiveCostRow & { effectiveFrom: string }>();
    for (const row of this.effectiveCosts) {
      if (row.sellerAccountId !== sellerAccountId) continue;
      if (row.effectiveFrom > on) continue;
      if (row.effectiveTo !== null && row.effectiveTo <= on) continue;
      const current = bySku.get(row.sku);
      if (!current || row.effectiveFrom > current.effectiveFrom) {
        bySku.set(row.sku, { sku: row.sku, unitCost: row.unitCost, currency: row.currency, effectiveFrom: row.effectiveFrom });
      }
    }
    return [...bySku.values()].map(({ sku, unitCost, currency }) => ({ sku, unitCost, currency }));
  }

  /* ==========================================================================
   * MODULE 5 PHẦN 1 (0020) — Amazon Ads
   * Mock giữ ĐÚNG luật của RPC trong DB (idempotent theo khoá tự nhiên, `null`
   * = chưa biết, KHÔNG trộn tiền tệ, quyết định của con người bất khả xâm phạm)
   * để test job không "xanh giả".
   * ========================================================================*/

  private adsKey(sellerAccountId: string, parts: unknown[]): string {
    return [sellerAccountId, ...parts.map((v) => String(v ?? ""))].join("\u0001");
  }

  private adsUpsert<T extends object>(
    store: (T & { sellerAccountId: string })[],
    sellerAccountId: string,
    rows: T[],
    keyOf: (row: T & { sellerAccountId: string }) => string,
    isValid: (row: T & { sellerAccountId: string }) => boolean,
  ): AdsEntityCounts {
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let merged = 0;
    const seen = new Set<string>();
    for (const raw of rows) {
      const row = { ...(raw as object), sellerAccountId } as T & { sellerAccountId: string };
      if (!isValid(row)) {
        skipped++;
        continue;
      }
      const key = keyOf(row);
      if (seen.has(key)) {
        merged++;
        continue;
      }
      seen.add(key);
      const i = store.findIndex((x) => keyOf(x) === key);
      if (i >= 0) {
        store[i] = { ...store[i], ...row };
        updated++;
      } else {
        store.push(row);
        inserted++;
      }
    }
    return { inserted, updated, skipped, merged };
  }

  private adsMetricSummary<T extends { day?: string; currency?: string | null }>(
    rows: (T & { sellerAccountId: string })[],
  ): { days: number | null; currencies: string | null } {
    const days = new Set(rows.map((r) => String(r.day ?? "")).filter((d) => d !== ""));
    const currencies = new Set(
      rows.map((r) => String(r.currency ?? "").toUpperCase()).filter((c) => c !== ""),
    );
    return {
      days: days.size,
      currencies: [...currencies].sort().join(", ") || null,
    };
  }

  async upsertAdsProfiles(
    sellerAccountId: string,
    rows: AdsProfileRowInput[],
  ): Promise<AdsEntityCounts> {
    return this.adsUpsert(
      this.adsProfiles,
      sellerAccountId,
      rows,
      (r) => this.adsKey(r.sellerAccountId, [r.adsProfileId, r.marketplace]),
      (r) => r.adsProfileId !== "" && r.marketplace !== "",
    );
  }

  async listAdsProfiles(sellerAccountId: string): Promise<AdsProfileRow[]> {
    return this.adsProfiles
      .filter((p) => p.sellerAccountId === sellerAccountId)
      .map((p) => ({
        adsProfileId: p.adsProfileId,
        marketplace: p.marketplace,
        currency: p.currency ?? null,
      }));
  }

  async upsertAdsCampaigns(
    sellerAccountId: string,
    rows: AdsCampaignRowInput[],
  ): Promise<AdsEntityCounts> {
    return this.adsUpsert(
      this.adsCampaigns,
      sellerAccountId,
      rows,
      (r) => this.adsKey(r.sellerAccountId, [r.campaignId]),
      (r) => r.campaignId !== "" && String(r.name ?? "") !== "",
    );
  }

  async upsertAdsAdGroups(
    sellerAccountId: string,
    rows: AdsAdGroupRowInput[],
  ): Promise<AdsEntityCounts> {
    return this.adsUpsert(
      this.adsAdGroups,
      sellerAccountId,
      rows,
      (r) => this.adsKey(r.sellerAccountId, [r.adGroupId]),
      (r) => r.adGroupId !== "",
    );
  }

  async upsertAdsTargets(
    sellerAccountId: string,
    rows: AdsTargetRowInput[],
  ): Promise<AdsEntityCounts> {
    return this.adsUpsert(
      this.adsTargets,
      sellerAccountId,
      rows,
      (r) => this.adsKey(r.sellerAccountId, [r.adGroupId, r.targetKind, r.targetKey, r.matchType]),
      (r) => r.targetKey !== "",
    );
  }

  async upsertAdsCampaignMetrics(
    sellerAccountId: string,
    rows: AdsCampaignMetricRowInput[],
  ): Promise<AdsMetricCounts> {
    const counts = this.adsUpsert(
      this.adsCampaignMetrics,
      sellerAccountId,
      rows,
      (r) => this.adsKey(r.sellerAccountId, [r.day, r.campaignId]),
      (r) => r.day !== "" && r.campaignId !== "",
    );
    return { ...counts, ...this.adsMetricSummary(this.adsCampaignMetrics) };
  }

  async upsertAdsTargetMetrics(
    sellerAccountId: string,
    rows: AdsTargetMetricRowInput[],
  ): Promise<AdsMetricCounts> {
    const counts = this.adsUpsert(
      this.adsTargetMetrics,
      sellerAccountId,
      rows,
      (r) => this.adsKey(r.sellerAccountId, [r.day, r.adGroupId, r.targetKey, r.matchType]),
      (r) => r.day !== "" && r.adGroupId !== "" && r.targetKey !== "",
    );
    return { ...counts, ...this.adsMetricSummary(this.adsTargetMetrics) };
  }

  async upsertAdsSearchTerms(
    sellerAccountId: string,
    rows: AdsSearchTermRowInput[],
  ): Promise<AdsMetricCounts> {
    const counts = this.adsUpsert(
      this.adsSearchTerms,
      sellerAccountId,
      rows,
      (r) => this.adsKey(r.sellerAccountId, [r.day, r.searchTerm.toLowerCase()]),
      (r) => r.day !== "" && String(r.searchTerm ?? "").trim() !== "",
    );
    return { ...counts, ...this.adsMetricSummary(this.adsSearchTerms) };
  }

  async upsertAdsProductMetrics(
    sellerAccountId: string,
    level: "advertised" | "purchased",
    rows: AdsProductMetricRowInput[],
  ): Promise<AdsMetricCounts> {
    if (level !== "advertised" && level !== "purchased") {
      throw new Error(`upsertAdsProductMetrics: level lạ "${level}" (chỉ advertised | purchased)`);
    }
    const store = level === "advertised" ? this.adsAdvertisedProducts : this.adsPurchasedProducts;
    const counts = this.adsUpsert(
      store,
      sellerAccountId,
      rows,
      (r) =>
        this.adsKey(r.sellerAccountId, [
          r.day,
          r.advertisedSku || r.advertisedAsin,
          level === "purchased" ? r.purchasedAsin : "",
        ]),
      (r) =>
        r.day !== "" &&
        (String(r.advertisedSku ?? "") !== "" || String(r.advertisedAsin ?? "") !== "") &&
        (level === "advertised" || String(r.purchasedAsin ?? "") !== ""),
    );
    return { ...counts, ...this.adsMetricSummary(store) };
  }

  async upsertAdsBudgetEvents(
    sellerAccountId: string,
    rows: AdsBudgetEventRowInput[],
  ): Promise<AdsEntityCounts> {
    const ALLOWED = new Set([
      "capped",
      "exhausted_suspected",
      "under_delivery",
      "budget_increased",
    ]);
    return this.adsUpsert(
      this.adsBudgetEvents,
      sellerAccountId,
      rows,
      (r) => this.adsKey(r.sellerAccountId, [r.day, r.campaignId, r.eventType]),
      (r) => r.day !== "" && r.campaignId !== "" && ALLOWED.has(r.eventType),
    );
  }

  async upsertAdsSuggestions(
    sellerAccountId: string,
    rows: AdsSuggestionRowInput[],
  ): Promise<AdsSuggestionCounts> {
    const ALLOWED = new Set([
      "negative_exact",
      "negative_phrase",
      "pause_keyword",
      "lower_bid",
    ]);
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let kept = 0;
    for (const raw of rows) {
      const row = { ...raw, sellerAccountId };
      if (!ALLOWED.has(row.suggestionType) || String(row.term ?? "").trim() === "") {
        skipped++;
        continue;
      }
      const key = this.adsKey(sellerAccountId, [
        row.campaignId,
        row.adGroupId,
        row.term.toLowerCase(),
        row.matchType,
        row.suggestionType,
      ]);
      const i = this.adsSuggestions.findIndex((x) => this.adsKey(x.sellerAccountId, [
        x.campaignId, x.adGroupId, x.term.toLowerCase(), x.matchType, x.suggestionType,
      ]) === key);
      if (i >= 0) {
        // Con người đã quyết (approved/rejected) ⇒ worker KHÔNG ghi đè.
        if (this.adsSuggestions[i].status !== "pending") {
          kept++;
          continue;
        }
        this.adsSuggestions[i] = { ...this.adsSuggestions[i], ...row };
        updated++;
      } else {
        this.adsSuggestions.push({ ...row, status: "pending" });
        inserted++;
      }
    }
    return { inserted, updated, skipped, kept };
  }

  async applyAdsSpend(
    sellerAccountId: string,
    from: string,
    to: string,
  ): Promise<AdsSpendCounts> {
    const spend = new Map<string, { day: string; sku: string; currency: string; cost: number }>();
    for (const r of this.adsAdvertisedProducts) {
      if (r.sellerAccountId !== sellerAccountId) continue;
      const sku = String(r.advertisedSku ?? "").trim();
      const day = String(r.day ?? "");
      const currency = String(r.currency ?? "").toUpperCase();
      if (sku === "" || day === "" || currency === "" || r.cost === null || r.cost === undefined) continue;
      if (day < from || day > to) continue;
      const key = `${day}|${sku}|${currency}`;
      const prev = spend.get(key);
      spend.set(key, { day, sku, currency, cost: (prev?.cost ?? 0) + Number(r.cost) });
    }
    let updated = 0;
    let skippedNoRow = 0;
    let skippedCurrency = 0;
    for (const s of spend.values()) {
      const sameDay = this.skuProfit.filter(
        (p) => p.sellerAccountId === sellerAccountId && p.day === s.day && p.sku === s.sku,
      );
      if (sameDay.length === 0) {
        skippedNoRow++;
        continue;
      }
      const sameCurrency = sameDay.filter((p) => p.currency.toUpperCase() === s.currency);
      if (sameCurrency.length === 0) {
        skippedCurrency++;
        continue;
      }
      for (const p of sameCurrency) {
        p.adsSpend = s.cost;
        updated++;
      }
    }
    return { updated, skippedNoRow, skippedCurrency };
  }

  /* ---- Module 0: token platform + re-authorize ---- */

  /* ==========================================================================
   * MODULE 5 PHẦN 3 (0021) — HÀNG ĐỢI GHI
   * Mock giữ đúng luật của DB: chỉ claim dòng 'approved'; ghi kết quả mới đổi
   * trạng thái + cập nhật bản ghi cục bộ; thất bại thì KHÔNG ghi giá trị chưa
   * được Amazon nhận (nếu không, test sẽ "xanh" trên một DB đang sai).
   * ========================================================================*/

  /** Dựng sẵn một yêu cầu cho test/job (thay cho RPC request của web). */
  seedAdsChange(
    row: Omit<AdsChangeRow, "changeId"> & {
      changeId?: string;
      sellerAccountId: string;
      status?: string;
    },
  ): AdsChangeRow {
    const changeId = row.changeId ?? `chg-${this.adsChanges.length + 1}`;
    this.adsChanges.push({
      ...row,
      changeId,
      status: row.status ?? "approved",
      apiResponse: null,
      error: null,
      appliedAt: null,
    });
    return { ...row, changeId } as AdsChangeRow;
  }

  async claimAdsChanges(sellerAccountId: string, limit = 20): Promise<AdsChangeRow[]> {
    const max = Math.min(Math.max(limit, 1), 200);
    const out: AdsChangeRow[] = [];
    for (const c of this.adsChanges) {
      if (out.length >= max) break;
      if (c.sellerAccountId !== sellerAccountId) continue;
      if (c.status !== "approved") continue;
      c.status = "applying";
      c.attempts += 1;
      out.push(this.adsChangeView(c));
    }
    return out;
  }

  async recordAdsChange(input: AdsChangeRecordInput): Promise<AdsChangeRecordResult> {
    const c = this.adsChanges.find((x) => x.changeId === input.changeId);
    if (!c) throw new Error(`recordAdsChange: không thấy yêu cầu ${input.changeId}`);
    if (c.status !== "applying") {
      throw new Error(`recordAdsChange: yêu cầu đang ở '${c.status}' — chỉ ghi kết quả cho dòng đang applying`);
    }

    if (!input.ok) {
      c.status = "failed";
      c.error = input.error ?? "Amazon từ chối (không có thông báo)";
      c.apiResponse = input.api ?? null;
      return { changeId: c.changeId, status: "failed", mirrored: false, keywordId: null, suggestionApplied: false };
    }

    c.status = "applied";
    c.appliedAt = new Date().toISOString();
    c.apiResponse = input.api ?? null;
    c.error = null;

    const after = String(c.afterValue?.value ?? "");
    let mirrored = false;
    let keywordId: string | null = null;

    if (c.action === "set_budget") {
      const camp = this.adsCampaigns.find(
        (x) => x.sellerAccountId === c.sellerAccountId && x.campaignId === c.entityKey,
      );
      if (camp) {
        camp.dailyBudget = Number(after);
        mirrored = true;
      }
    } else if (c.action === "set_bid") {
      const t = this.adsTargets.find(
        (x) => x.sellerAccountId === c.sellerAccountId && x.targetKind === "keyword" && x.targetKey === c.entityKey,
      );
      if (t) {
        t.bid = Number(after);
        mirrored = true;
      }
    } else if (c.action === "set_state") {
      if (c.entityType === "campaign") {
        const camp = this.adsCampaigns.find(
          (x) => x.sellerAccountId === c.sellerAccountId && x.campaignId === c.entityKey,
        );
        if (camp) {
          camp.state = after;
          mirrored = true;
        }
      } else {
        const t = this.adsTargets.find(
          (x) => x.sellerAccountId === c.sellerAccountId && x.targetKind === "keyword" && x.targetKey === c.entityKey,
        );
        if (t) {
          t.state = after;
          mirrored = true;
        }
      }
    } else {
      keywordId = String(input.api?.keywordId ?? "") || null;
      this.adsNegativeKeywords.push({
        sellerAccountId: c.sellerAccountId,
        adsProfileId: c.adsProfileId,
        campaignId: c.campaignId,
        adGroupId: c.adGroupId,
        keywordId: keywordId ?? "",
        keywordText: after,
        matchType: c.action === "add_negative_phrase" ? "NEGATIVE_PHRASE" : "NEGATIVE_EXACT",
        changeRequestId: c.changeId,
      });
      mirrored = true;
    }

    // Mock không tự sinh uuid như DB ⇒ tìm gợi ý theo id (nếu có) hoặc theo
    // (campaign, term) — đúng khoá tự nhiên mà RPC 0020 dùng để gộp dòng.
    let suggestionApplied = false;
    if (c.suggestionId) {
      const sug =
        this.adsSuggestions.find((x) => (x as { id?: string }).id === c.suggestionId) ??
        this.adsSuggestions.find(
          (x) => x.campaignId === c.campaignId && x.term.toLowerCase() === c.entityKey.toLowerCase(),
        );
      if (sug) {
        sug.status = "applied";
        suggestionApplied = true;
      }
    }

    return { changeId: c.changeId, status: "applied", mirrored, keywordId, suggestionApplied };
  }

  async releaseAdsChange(changeId: string, reason: string): Promise<AdsChangeReleaseResult> {
    const c = this.adsChanges.find((x) => x.changeId === changeId);
    if (!c) throw new Error(`releaseAdsChange: không thấy yêu cầu ${changeId}`);
    if (c.status !== "applying") {
      throw new Error(`releaseAdsChange: chỉ trả lại hàng đợi được dòng đang applying (đang: ${c.status})`);
    }
    c.status = "approved";
    c.apiResponse = { released: true, reason, attempts: c.attempts };
    return { changeId: c.changeId, status: "approved", attempts: c.attempts };
  }

  private adsChangeView(c: MockDbAdapter["adsChanges"][number]): AdsChangeRow {
    const {
      changeId, entityType, entityKey, campaignId, adGroupId, action, payload,
      beforeValue, afterValue, adsProfileId, currency, entityLabel, suggestionId, attempts,
    } = c;
    return {
      changeId, entityType, entityKey, campaignId, adGroupId, action,
      payload: payload ?? {}, beforeValue, afterValue, adsProfileId,
      currency: currency ?? null, entityLabel, suggestionId: suggestionId ?? null, attempts,
    };
  }

  async saveOauthToken(
    sellerAccountId: string,
    token: OauthTokenInput,
  ): Promise<OauthTokenResult> {
    const refreshToken = String(token.refreshToken ?? "").trim();
    if (refreshToken === "") {
      throw new Error("saveOauthToken: refreshToken rỗng — từ chối ghi đè token tốt bằng chuỗi rỗng");
    }
    const authorizedAt = token.authorizedAt ?? new Date().toISOString();
    const expiresAt =
      token.expiresAt ?? new Date(Date.parse(authorizedAt) + 365 * 86_400_000).toISOString();
    const noticeDaysRaw = Number(token.noticeDays ?? 30);
    const noticeDays = noticeDaysRaw >= 1 && noticeDaysRaw <= 120 ? noticeDaysRaw : 30;
    const existing = this.oauthTokens.find((t) => t.sellerAccountId === sellerAccountId);
    const replaced = existing !== undefined;
    const row = {
      ...token,
      refreshToken,
      sellerAccountId,
      noticeDays,
      authorizedAt,
      expiresAt,
      refreshCount: (existing?.refreshCount ?? 0) + 1,
      rotateReminderSent: false,
      noticeSentAt: null,
      lastRefreshAt: new Date().toISOString(),
    };
    if (existing) this.oauthTokens[this.oauthTokens.indexOf(existing)] = row;
    else this.oauthTokens.push(row);
    return {
      id: `mock-oauth-${sellerAccountId}`,
      authorizedAt,
      expiresAt,
      daysLeft: Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 86_400_000)),
      refreshCount: row.refreshCount,
      replaced,
    };
  }

  async createOauthState(
    sellerAccountId: string,
    redirectTo?: string | null,
    ttlMinutes?: number | null,
  ): Promise<OauthStateResult> {
    const ttl = Math.min(Math.max(Math.round(ttlMinutes ?? 30), 1), 1440);
    this.oauthStateSeq += 1;
    const state = `mock-state-${this.oauthStateSeq}-${Math.random().toString(16).slice(2, 10)}`;
    const expiresAt = new Date(Date.now() + ttl * 60_000).toISOString();
    this.oauthStates.push({ state, sellerAccountId, redirectTo: redirectTo ?? null, expiresAt, usedAt: null });
    return { state, expiresAt };
  }

  async consumeOauthState(state: string): Promise<OauthConsumeResult> {
    const row = this.oauthStates.find((s) => s.state === state);
    if (!row) {
      return { ok: false, sellerAccountId: null, redirectTo: null, message: "state không tồn tại (có thể đã bị dùng hoặc hết hạn)" };
    }
    if (row.usedAt !== null) {
      return { ok: false, sellerAccountId: null, redirectTo: null, message: "state đã được dùng rồi" };
    }
    if (Date.parse(row.expiresAt) <= Date.now()) {
      return { ok: false, sellerAccountId: null, redirectTo: null, message: "state đã hết hạn" };
    }
    row.usedAt = new Date().toISOString();
    return { ok: true, sellerAccountId: row.sellerAccountId, redirectTo: row.redirectTo, message: "ok" };
  }

  async markOauthNotice(sellerAccountId: string): Promise<{ rotateReminderSent: boolean }> {
    const row = this.oauthTokens.find((t) => t.sellerAccountId === sellerAccountId);
    if (!row) throw new Error("markOauthNotice: shop chưa có token — không có gì để nhắc");
    row.rotateReminderSent = true;
    row.noticeSentAt = new Date().toISOString();
    return { rotateReminderSent: true };
  }

  async listOauthSoon(days?: number | null): Promise<OauthSoonRow[]> {
    const now = Date.now();
    return this.oauthTokens
      .filter((t) => {
        const limitDays = days ?? t.noticeDays ?? 30;
        return Date.parse(t.expiresAt) <= now + limitDays * 86_400_000;
      })
      .map((t) => {
        const daysLeft = Math.max(0, Math.floor((Date.parse(t.expiresAt) - now) / 86_400_000));
        return {
          sellerAccountId: t.sellerAccountId,
          shop: null,
          sellerId: null,
          marketplace: null,
          authorizedAt: t.authorizedAt,
          expiresAt: t.expiresAt,
          daysLeft,
          noticeDays: t.noticeDays ?? 30,
          needsReauth: daysLeft <= (t.noticeDays ?? 30),
          alreadyNoticed: t.rotateReminderSent,
          tokenActive: Date.parse(t.expiresAt) > now,
          adsProfiles: this.adsProfiles.filter((p) => p.sellerAccountId === t.sellerAccountId).length,
        };
      })
      .sort((a, b) => String(a.expiresAt).localeCompare(String(b.expiresAt)));
  }

  async recordApiUsage(input: { sellerAccountId: string; day: string; apiGroup: string; calls?: number }): Promise<void> {
    const calls = Math.max(1, Math.round(input.calls ?? 1));
    const key = `${input.sellerAccountId}|${input.day}|${input.apiGroup}`;
    const idx = this.apiUsage.findIndex((u) => `${u.sellerAccountId}|${u.day}|${u.apiGroup}` === key);
    if (idx >= 0) {
      this.apiUsage[idx].calls += calls;
    } else {
      this.apiUsage.push({ sellerAccountId: input.sellerAccountId, day: input.day, apiGroup: input.apiGroup, calls });
    }
  }
}
