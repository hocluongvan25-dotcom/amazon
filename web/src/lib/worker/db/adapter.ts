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

export type ListingStateRow = {
  sellerAccountId: string;
  sku: string;
  asin?: string | null;
  itemName?: string | null; // itemName CÓ THỂ null từ Amazon (đã ghi nhận thực tế)
  status: ListingLifecycleStatus | null;
  buyable?: boolean | null;
  discoverable?: boolean | null;
  issueErrors?: number;
  issueWarnings?: number;
  enforcementActions?: string[];
  price?: string | null;
  quantity?: number | null;
  strandedReason?: string | null;
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
  upsertListing(row: ListingStateRow): Promise<void>;
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
    const i = this.listings.findIndex(
      (l) => l.sellerAccountId === row.sellerAccountId && l.sku === row.sku,
    );
    if (i >= 0) this.listings[i] = { ...this.listings[i], ...row };
    else this.listings.push(row);
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
}
