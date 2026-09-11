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
};

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
  | "Reserve";

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
  floorPrice: number; // giá sàn = vốn + referral fee + FBA fee + biên tối thiểu
  currentMargin: number; // % biên hiện tại (ourPrice - floorCost) / ourPrice
  marginTone: "red" | "amber" | "green"; // <0 đỏ · <biên tối thiểu vàng
  boxStatus: BoxStatus;
  competitorCount: number;
  velocity30d: number; // đơn/ngày — để ước tính tổn thất khi mất box
  lastPriceChange: string;
  owner: string;
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

export type ListingStatus = "ACTIVE" | "INACTIVE" | "STRANDED" | "SUPPRESSED";

export type ListingListRow = {
  sku: string;
  asin: string;
  title: string;
  shop: string;
  brand: string;
  status: ListingStatus;
  price: string;
  stock: number;
  issueErrors: number;
  issueWarnings: number;
  owner: string;
  revenue30d: number; // USD — để sort
  updated: string;
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
  priority: "red" | "amber" | "gray";
  priorityLabel: string;
};
