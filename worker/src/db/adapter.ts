/**
 * DbAdapter — interface worker ↔ database.
 * MockDbAdapter: chạy in-memory (test + dev không cần Supabase).
 * SupabaseAdapter: TODO khi có project — ghi qua REST (service_role) vào
 * các bảng: inventory.inventory_snapshots / inventory_daily,
 * connections.notifications_log / sync_jobs (khớp migrations 0001–0003).
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
  status: ListingLifecycleStatus | null; // null = chưa biết (bỏ qua, không ghi đè)
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

export interface DbAdapter {
  upsertInventorySnapshot(row: InventorySnapshotRow): Promise<void>;
  upsertInventoryDaily(row: InventoryDailyRow): Promise<void>;
  recordNotification(row: NotificationRecord): Promise<void>;
  upsertListing(row: ListingStateRow): Promise<void>;
  /** Đơn vị bán theo ngày gần nhất (đầu tiên = gần nhất) — dùng tính velocity */
  getSellingDays(sellerAccountId: string, sku: string, days: number): Promise<number[]>;
}

/** In-memory — cho test & DEMO MODE */
export class MockDbAdapter implements DbAdapter {
  snapshots: InventorySnapshotRow[] = [];
  daily: InventoryDailyRow[] = [];
  notifications: NotificationRecord[] = [];
  listings: ListingStateRow[] = [];
  private sellingDays: Record<string, number[]> = {};

  seedSellingDays(sellerAccountId: string, sku: string, days: number[]): void {
    this.sellingDays[`${sellerAccountId}:${sku}`] = days;
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
}
