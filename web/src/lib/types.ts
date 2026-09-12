/**
 * Kiểu dữ liệu dùng chung — khớp schema supabase/migrations/*.sql
 * (bản rút gọn phía UI; bản đầy đủ nằm ở database).
 */

export type AlertSeverity = "red" | "amber" | "green";

export type KpiCardData = {
  label: string;
  value: string;
  sub: string;
  tone?: "up" | "down" | "warn" | "flat";
};

export type ShopHealthRow = {
  shop: string;
  ahr: string;
  odr: string;
  lateShip: string;
  status: "green" | "amber" | "gray";
  statusLabel: string;
};

export type ListingRow = {
  sku: string;
  asin: string;
  shop: string;
  issue: string;
  revenuePerDay: string;
  priority: "red" | "amber" | "gray";
  priorityLabel: string;
  owner: string;
};

export type SkuStockRow = {
  sku: string;
  stock: number;
  coverDays: number;
  coverTone: "red" | "amber";
  perDay: number;
  suggest: number;
};

export type InboundShipment = {
  id: string;
  units: string;
  note: string;
  right: string;
  tone: "flat" | "warn" | "down";
};

export type CampaignRow = {
  name: string;
  spend7d: string;
  acos: string;
  trend: string;
};

export type SkuProfitRow = {
  sku: string;
  revenue: string;
  amazonFees: string;
  cogs: string;
  gross: string;
  tone: "up" | "warn";
};

export type ReimbursementRow = {
  title: string;
  detail: string;
  amount: string;
};

export type MiniItemData = {
  icon: string;
  title: string;
  sub: string;
  right: string;
  tone?: "down" | "warn" | "up" | "flat";
};

export type SyncJobRow = {
  jobType: string;
  shop: string;
  status: "done" | "running" | "pending" | "failed";
  statusLabel: string;
  lastRun: string;
  latency: string;
  retries: number;
};

export type AuditRow = {
  time: string;
  actor: string;
  module: string;
  action: string;
  entity: string;
  change: string;
  result: "ok" | "error";
};

export type ApiUsageRow = {
  apiGroup: string;
  callsToday: number;
  quota: string;
  trend: string;
};

export type UserRow = {
  name: string;
  email: string;
  role: string;
  department: string;
  shops: string;
  status: "active" | "invited";
};

/* ---------- Module 4: Đơn hàng (O1–O4) ---------- */
export type OrderRow = {
  id: string;
  date: string;
  status: "Shipped" | "Pending" | "Cancelled" | "Delivered";
  channel: "AFN" | "MFN";
  itemsCount: number;
  total: string;
  mainSku: string;
  shop: string;
};

export type OrderItemRow = { sku: string; asin: string; qty: number; price: string };

export type OrderDetailMock = {
  id: string;
  date: string;
  status: string;
  channel: string;
  shop: string;
  items: OrderItemRow[];
  timeline: { time: string; event: string }[];
  financials: { label: string; amount: string; tone?: "up" | "down" | "flat" }[];
};

export type FbmRow = {
  id: string;
  shop: string;
  deadline: string;
  countdown: string;
  late: boolean;
};

export type ReturnRow = {
  id: string;
  date: string;
  order: string;
  reasonCode: string;
  reasonLabel: string;
  status: string;
  refund: string;
  shop: string;
};

/* ---------- Module 7: Health chi tiết (H2) ---------- */
export type ViolationRow = {
  type: string;
  severity: "Critical" | "High" | "Medium" | "Low";
  shop: string;
  opened: string;
  status: string;
  owner: string;
  caseId: string;
};

/* ---------- Module 3: Kho vận & FBA (I1–I4) ---------- */
export type InventoryRow = {
  sku: string;
  asin: string;
  shop: string;
  fulfillable: number;
  reserved: number;
  inbound: number;
  velocity: number;
  coverDays: number | null;
  suggest: number | null;
  agedDays: number | null;
  status: "out" | "low" | "ok" | "aged";
  statusLabel: string;
  /* ↓ migration 0017: giá vốn hiệu lực + GIÁ TRỊ TỒN KHO (Σ tồn × unit_cost) */
  /** Giá vốn hiệu lực hôm nay (catalog.effective_cost) — NULL khi chưa nhập. */
  unitCost: number | null;
  costCurrency: string | null;
  costEffectiveFrom: string | null;
  costSource: string | null;
  /** fulfillable × unit_cost. NULL khi thiếu giá vốn — KHÔNG hiện 0 giả. */
  stockValue: number | null;
  /** (fulfillable + reserved + inbound) × unit_cost = vốn đang kẹt ở FC + đang về. */
  totalStockValue: number | null;
  /** Tiền tệ của giá vốn: VEXIM nhập VND, bán USD → không tự quy đổi ở tầng view. */
  valueCurrency: string | null;
  valueBasis: InventoryValueBasis;
};

/** 'cost' = đã định giá được · 'missing' = chưa có giá vốn (I3 để "—", không đoán). */
export type InventoryValueBasis = "cost" | "missing";

export type InventoryDetailMock = {
  sku: string;
  asin: string;
  fnsku: string;
  shop: string;
  unitCost: string;
  stock90: { label: string; pct: number }[];
  sales90: { label: string; pct: number }[];
  fcAllocation: { fc: string; units: number; disposition: string }[];
  receipts: { date: string; shipment: string; expected: number; received: number }[];
  inboundComing: { id: string; units: number; eta: string }[];
};

export type RestockRow = {
  sku: string;
  shop: string;
  suggest: number;
  unitCost: string;
  value: string;
  step: string;
  stepLabel: string;
  tone: "red" | "amber" | "gray" | "green";
};

export type InboundRow = {
  id: string;
  shop: string;
  status: string;
  statusTone: "green" | "amber" | "gray" | "blue";
  units: number;
  fc: string;
  eta: string;
  reconcile: string;
  reconcileTone: "up" | "down" | "flat" | "warn";
};

/* ---------- Module 3 nâng cao (migration 0018): phân bổ FC + lịch sử nhận ---------- */

/**
 * I2 — một trung tâm fulfilment đang giữ hàng của SKU.
 * Nguồn: report GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA (snapshot mới nhất),
 * KHÔNG phải API realtime — API chỉ trả tổng theo SKU, không tách theo FC.
 */
export type FcAllocationRow = {
  sku: string;
  /** "(không rõ FC)" khi report không có mã FC — không bịa mã */
  fc: string;
  units: number;
  /** disposition = SELLABLE */
  sellable: number;
  /** disposition khác rỗng và khác SELLABLE (hỏng / không bán được) */
  unsellable: number;
  /** disposition RỖNG = report không cho biết → đếm riêng, không tính là bán được */
  unknown: number;
  /** NULL khi tổng tồn của SKU = 0 (không có hàng để chia) — không bịa 0% */
  sharePct: number | null;
  shareLabel: string;
  snapshotDate: string;
};

/** I2 — một lần Amazon thực nhận hàng của SKU (report receipts). */
export type ReceiptRow = {
  sku: string;
  date: string;
  daysAgo: number | null;
  dateLabel: string;
  /** NULL = report không gắn mã lô (không đối soát theo lô được) */
  shipment: string | null;
  fc: string | null;
  units: number;
};

/**
 * I4 — đối soát nhận theo lô: thực nhận (report receipts) so với số gửi
 * (inventory.inbound_shipments do worker inventory:sync ghi từ Inbound API).
 * `expected = null` nghĩa là CHƯA RÕ số gửi — khác với "nhận đủ".
 */
export type ReceiptShipmentRow = {
  shipmentId: string;
  fc: string | null;
  received: number;
  expected: number | null;
  diff: number | null;
  ratePct: number | null;
  state: "matched" | "short" | "over" | "unknown_expected";
  label: string;
  tone: "up" | "down" | "flat" | "warn";
  expectedSource: "inbound_shipments" | "none";
  firstDate: string | null;
  lastDate: string | null;
  skuCount: number;
};

/* ---------- Chuông thông báo & Profile & Quản trị user ---------- */

export type NotificationItem = {
  id: string;
  tone: AlertSeverity;
  icon: string;
  title: string;
  detail: string;
  time: string; // tương đối: "5 phút trước"
  href?: string; // link điều hướng khi click
  read: boolean;
  category: "alert" | "approval" | "system";
};

export type Profile = {
  name: string;
  email: string;
  role: string;
  department: string;
  phone: string;
  avatarInitials: string;
  joinedAt: string;
  lastLogin: string;
  mfaEnabled: boolean;
};

export type Department =
  | "Vận hành & Health"
  | "Listing & Nội dung"
  | "Quảng cáo (PPC)"
  | "Kho vận & FBA"
  | "Đơn hàng & CSKH"
  | "Tài chính & Đối soát"
  | "Điều phối";

export type AppRole =
  | "super_admin"
  | "org_admin"
  | "dept_lead"
  | "operator"
  | "analyst"
  | "client_viewer";

export const ROLE_LABEL: Record<AppRole, string> = {
  super_admin: "Super Admin",
  org_admin: "Org Admin",
  dept_lead: "Dept Lead",
  operator: "Operator",
  analyst: "Analyst / Viewer",
  client_viewer: "Client Viewer",
};

/* ---------- Module 6 — Tài chính & Đối soát (F1–F4) ---------- */

export type SettlementStatus = "deposited" | "processing" | "open";

export type SettlementRow = {
  id: string; // settlementId từ Amazon (vd 120400000000000)
  shop: string;
  depositDate: string;
  startDate: string;
  endDate: string;
  status: SettlementStatus;
  sales: number; // tổng bán hàng (product charges + shipping + gift wrap)
  refunds: number; // tiền hoàn lại cho buyer
  amazonFeesTotal: number; // referral + FBA + storage + other fees (âm)
  advertisingFees: number; // PPC spend (âm)
  otherCharges: number; // adjustments, reimbursements
  transferAmount: number; // số tiền chuyển về tài khoản ngân hàng
  currency: string;
  accountDeposit: string; // thông tin tài khoản nhận cuối
};

export type SettlementEventGroup = {
  label: string; // Product sales / Shipping credits / FBA fees / ...
  amount: number;
  tone: "up" | "down" | "flat";
  children?: { label: string; amount: number }[];
};

export type SettlementDetailMock = {
  id: string;
  shop: string;
  depositDate: string;
  startDate: string;
  endDate: string;
  transferAmount: number;
  accountDeposit: string;
  currency: string;
  groups: SettlementEventGroup[];
  skuBreakdown: {
    sku: string;
    quantity: number;
    productSales: number;
    amazonFees: number;
    net: number;
  }[];
};

export type FinancialEventType =
  | "ProductSale"
  | "ShippingCredit"
  | "Refund"
  | "ReferralFee"
  | "FBAFee"
  | "StorageFee"
  | "AdvertisingFee"
  | "Reimbursement"
  | "Adjustment"
  | "ServiceFee"
  | "Subscription"
  | "Reserve"
  /* bổ sung từ report settlement V2 (module 6, đợt sync thật) */
  | "Transfer"
  | "PromotionRebate";

export type FinancialEventRow = {
  id: string;
  postedAt: string;
  shop: string;
  type: FinancialEventType;
  typeLabel: string;
  description: string;
  orderId?: string;
  sku?: string;
  amount: number; // dương = tiền vào, âm = tiền ra
  settlementId?: string;
};

/* ---------- Module 2 — Giá & Featured Offer (P1–P4) ---------- */

export type BoxStatus = "holding" | "at_risk" | "lost" | "no_box";

/**
 * Nguồn số liệu của giá sàn/biên (cột `cost_basis` của view vexim_pricing, migration 0016).
 * Người dùng phải biết số nào tính từ giá vốn thật, số nào chỉ từ phí ước tính.
 */
export type CostBasis =
  | "cost+fees" // giá vốn hiệu lực + phí Amazon thật/ước tính → tin được nhất
  | "cost_only" // có giá vốn, chưa có fees estimate → referral dùng tỷ lệ cấu hình
  | "fees_only" // CHƯA có giá vốn → không tính được sàn/biên (đang chặn P1)
  | "currency_mismatch" // giá vốn khác tiền tệ giá bán → không cộng được
  | "unavailable"; // chưa có gì

export type PricingRow = {
  sku: string;
  asin: string;
  shop: string;
  title: string;
  ourPrice: number; // USD
  currency: string; // "USD"
  foep: number | null; // Featured Offer Expected Price
  foepDelta: number | null; // ourPrice - foep (dương = đang cao hơn FOEP → nguy cơ mất box)
  referencePrice: number | null; // giá tham chiếu thấp nhất của đối thủ (landed)
  /**
   * Giá sàn = (giá vốn + FBA fee + phí khác) / (1 − tỷ lệ referral − biên tối thiểu).
   * NULL khi chưa có giá vốn hoặc lệch tiền tệ — KHÔNG lấy phí làm sàn (lỗi của 0013).
   */
  floorPrice: number | null;
  /** % biên tại giá hiện tại; NULL khi chưa tính được (cùng điều kiện với floorPrice). */
  currentMargin: number | null;
  marginTone: "red" | "amber" | "green" | "gray"; // <0 đỏ · <biên tối thiểu vàng · gray = chưa tính được
  boxStatus: BoxStatus;
  competitorCount: number;
  /**
   * Đơn vị bán/ngày trong 30 ngày (units_30d ÷ 30) — để ước tính tổn thất khi mất box.
   * NULL = chưa có đơn nào trong 30 ngày (hoặc shop chưa sync Orders) — KHÔNG phải 0.
   */
  velocity30d: number | null;
  lastPriceChange: string;
  /** Người phụ trách module pricing của shop (iam.assignments) — "—" khi chưa gán. */
  owner: string;
  /* ↓ migration 0017: doanh số 30 ngày theo SKU (nguồn: vexim_sku_sales_30d) */
  units30d: number | null;
  orders30d: number | null;
  /** Doanh thu 30 ngày (Σ item_price × quantity, loại đơn huỷ). NULL = chưa có đơn. */
  revenue30d: number | null;
  /** NULL khi đơn của shop lẫn >1 tiền tệ → không cộng gộp được, UI báo rõ. */
  revenueCurrency: string | null;
  lastOrderAt: string | null;
  /* ↓ migration 0016: giá vốn hiệu lực + các thành phần của công thức sàn */
  unitCost: number | null; // giá vốn hiệu lực hôm nay (catalog.effective_cost)
  costCurrency: string | null;
  costEffectiveFrom: string | null; // bậc giá vốn bắt đầu từ ngày nào
  costSource: string | null; // manual | csv | api
  grossProfit: number | null; // lãi gộp/đơn vị tại giá hiện tại
  belowFloor: boolean | null; // giá đang DƯỚI sàn → phải xử lý trước khi áp giá
  referralRateUsed: number | null; // tỷ lệ referral thật sự dùng (suy ra từ phí hoặc cấu hình)
  minMarginRate: number | null; // biên tối thiểu theo cấu hình (catalog.pricing_defaults)
  otherFeePerUnit: number | null; // phí khác/đơn vị (đóng gói, đầu VN…)
  costBasis: CostBasis;
};

export type CompetitorOffer = {
  sellerId: string;
  sellerLabel: string; // e.g., "Amazon.com", "XYZ-Seller", "Chúng tôi"
  isMe: boolean;
  fulfillment: "FBA" | "FBM" | "AMZ";
  price: number;
  shipping: number;
  landedPrice: number;
  rating: number | null;
  feedbackCount: number | null;
  isFeatured: boolean;
  condition: string;
};

export type PriceHistoryPoint = {
  date: string; // "09/09"
  myPrice: number;
  buyBoxPrice: number;
  lowestCompetitor: number;
};

export type FeeBreakdown = {
  cogs: number; // giá vốn
  referralFeeRate: number; // % referral fee (thường 15%)
  referralFeeAmount: number;
  fbaFee: number; // FBA fulfillment fee
  otherFees: number; // closing fee, storage, ...
  minMarginRate: number; // % biên tối thiểu (cấu hình theo shop/SKU)
  minMarginAmount: number;
  floorPrice: number; // giá sàn
};

export type PricingDetailMock = {
  sku: string;
  asin: string;
  shop: string;
  history: PriceHistoryPoint[];
  offers: CompetitorOffer[];
  fees: FeeBreakdown;
  alerts: { tone: AlertSeverity; text: string }[];
};

export type PriceApprovalItem = {
  id: string;
  sku: string;
  asin: string;
  shop: string;
  oldPrice: number;
  newPrice: number;
  deltaPct: number;
  reason: string; // lý do: "auto-follow-foep" / "manual" / "raise-to-floor"
  source: "auto" | "manual";
  requestedBy: string;
  requestedAt: string;
  minMarginAfter: number; // % biên sau khi áp — để kiểm tra dưới sàn
  belowFloor: boolean;
};

/* ---------- Module 1 — Listing (L1/L2/L4) ---------- */

/**
 * Trạng thái listing — đúng tập worker/RPC 0016 chấp nhận, cộng UNKNOWN cho dòng
 * report ghi trạng thái không đọc được (KHÔNG suy diễn thành ACTIVE/INACTIVE).
 */
export type ListingStatus =
  | "ACTIVE"
  | "INACTIVE"
  | "STRANDED"
  | "SUPPRESSED"
  | "REMOVED"
  | "CLOSED"
  | "DELETED"
  | "UNKNOWN";

/** Nguồn ghi dòng listing gần nhất (cột last_source của 0016). */
export type ListingSource = "report" | "api" | "notification" | "manual";

export type ListingListRow = {
  sku: string;
  asin: string;
  title: string;
  shop: string;
  brand: string;
  status: ListingStatus;
  price: string;
  /** Tồn theo report/API; NULL = chưa biết (không hiện 0 giả). */
  stock: number | null;
  issueErrors: number;
  issueWarnings: number;
  /** Người phụ trách module listings của shop (iam.assignments) — "—" khi chưa gán. */
  owner: string;
  /**
   * Doanh thu 30 ngày theo SKU (migration 0017, nguồn vexim_sku_sales_30d).
   * NULL = chưa có đơn nào trong 30 ngày — KHÔNG suy ra 0.
   */
  revenue30d: number | null;
  /** NULL khi đơn của shop lẫn >1 tiền tệ (không cộng gộp được). */
  revenueCurrency: string | null;
  units30d: number | null;
  lastOrderAt: string | null;
  updated: string;
  /* ↓ migration 0016: chi tiết để L1/L2 giải thích được "vì sao" */
  /** Issue nguyên văn từ Amazon, đã chuẩn hoá để hiển thị (L2). */
  issues: ListingIssueItem[];
  productType: string | null;
  buyable: boolean | null; // mất BUYABLE → không mua được dù listing "ACTIVE"
  discoverable: boolean | null; // mất DISCOVERABLE → bị ẩn khỏi tìm kiếm
  /** Lý do stranded từ report Stranded — có lý do mới biết sửa gì (SOP-03 bước 6). */
  strandedReason: string | null;
  /** Hành động Amazon đang áp: LISTING_SUPPRESSED / SEARCH_SUPPRESSED… */
  enforcementActions: string[];
  lastSource: ListingSource | string | null;
  lastSyncedAt: string | null;
};

export type ListingIssueItem = {
  code: string; // mã lỗi Amazon (8541, 90220…) — "—" nếu chưa gắn mã
  severity: "ERROR" | "WARNING" | "INFO";
  message: string;
  attributeNames: string[];
  enforcement?: string; // LISTING_SUPPRESSED, SEARCH_SUPPRESSED…
};

export type ListingDetailMock = {
  sku: string;
  asin: string;
  shop: string;
  productType: string;
  conditionType: string;
  statusFlags: string[]; // BUYABLE / DISCOVERABLE theo Listings Items API
  createdDate: string;
  lastUpdatedDate: string;
  attributes: { name: string; value: string }[];
  issues: ListingIssueItem[];
  offer: { buyBox: boolean; price: string; offerCount: number };
  revenue30d: string;
  history: { time: string; actor: string; change: string }[];
};

export type ListingQueueItem = {
  sku: string;
  asin: string;
  shop: string;
  cause: string; // nguyên nhân (issues / stranded reason)
  causeCode: string; // mã lỗi Amazon hoặc stranded-reason
  suggestion: string; // đề xuất sửa theo SOP-03
  owner: string;
  slaLabel: string; // SLA còn lại theo SOP-03 (SKU doanh thu cao ≤ 24h)
  revenuePerDay: string;
  /**
   * Doanh thu 30 ngày (migration 0017) — để L4 xếp "đang mất bao nhiêu tiền".
   * NULL = chưa có đơn nào trong 30 ngày.
   */
  revenue30d: number | null;
  priority: "red" | "amber" | "gray";
  priorityLabel: string;
};
