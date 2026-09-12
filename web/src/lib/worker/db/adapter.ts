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
}
