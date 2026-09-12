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
  /* Module 6 Đợt 2 (F3/F4) */
  reimbursements: (ReimbursementRowInput & { sellerAccountId: string })[] = [];
  reimbursementClaims: (ReimbursementClaimRowInput & { id: string; sellerAccountId: string; status: string })[] = [];
  skuProfit: (SkuProfitRowInput & { sellerAccountId: string })[] = [];
  effectiveCosts: (EffectiveCostRow & { sellerAccountId: string; effectiveFrom: string; effectiveTo: string | null })[] = [];
  healthIssues: AccountHealthIssueRowInput[] = [];
  settlements: SettlementRowInput[] = [];
  financialEvents: FinancialEventRowInput[] = [];
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
    this.jobs.push(job);
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
}
