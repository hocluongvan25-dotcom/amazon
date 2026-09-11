/**
 * MockProvider — dữ liệu giả deterministic cho DEMO MODE.
 * Số liệu khớp bộ wireframe đã duyệt để VEXIM so sánh 1-1.
 * Khi có Supabase + SP-API: mọi số lấy từ database (SupabaseProvider).
 */
import type {
  AlertSeverity,
  ApiUsageRow,
  AuditRow,
  CampaignRow,
  InboundShipment,
  KpiCardData,
  ListingRow,
  MiniItemData,
  ReimbursementRow,
  ShopHealthRow,
  SkuProfitRow,
  SkuStockRow,
  SyncJobRow,
  UserRow,
} from "@/lib/types";

export const dataMode = "mock" as const;

/* ---------- Dashboard tổng quan (CEO) ---------- */
export const ceoKpis: KpiCardData[] = [
  { label: "Doanh thu hôm qua", value: "$12,480", sub: "▲ 8.2% so cùng ngày tuần trước", tone: "up" },
  { label: "Đơn hàng", value: "341", sub: "▲ 4.7%", tone: "up" },
  { label: "Spend QC · TACOS", value: "$862", sub: "TACOS 6.9% · mục tiêu ≤ 8%", tone: "flat" },
  { label: "Shop cần xử lý gấp", value: "2 / 14", sub: "1 sắp hết hàng · 1 health vàng", tone: "down" },
];

export const revenue14d: { label: string; pct: number; today?: boolean }[] = [
  { label: "T", pct: 42 }, { label: "S", pct: 38 }, { label: "B", pct: 35 },
  { label: "K", pct: 47 }, { label: "N", pct: 52 }, { label: "T", pct: 49 },
  { label: "S", pct: 44 }, { label: "B", pct: 41 }, { label: "K", pct: 55 },
  { label: "N", pct: 61 }, { label: "T", pct: 57 }, { label: "S", pct: 53 },
  { label: "B", pct: 50 }, { label: "Hôm qua", pct: 72, today: true },
];

export const redShops = [
  { shop: "Shop A1 · US", issue: "3 SKU sắp hết hàng (cover 5–8 ngày)", impact: "~$410/ngày nếu đứt", dept: "Kho vận", status: "Chờ kế hoạch nhập", tone: "red" as AlertSeverity },
  { shop: "Shop C2 · US", issue: "Account Health vàng — 1 vi phạm IP chưa khiếu nại", impact: "rủi ro khóa shop", dept: "Vận hành & Health", status: "Đang xử lý", tone: "amber" as AlertSeverity },
];

/* ---------- Health ---------- */
export const healthKpis: KpiCardData[] = [
  { label: "Shop khỏe (AHR xanh)", value: "12", sub: "giữ nguyên so với hôm qua", tone: "up" },
  { label: "Shop vàng / đỏ", value: "2", sub: "▲ 1 so với hôm qua", tone: "warn" },
  { label: "Vấn đề mở", value: "5", sub: "2 IP · 1 listing gỡ · 2 KYC", tone: "flat" },
  { label: "Tác vụ quá hạn SLA", value: "3", sub: "cần đẩy ngay hôm nay", tone: "down" },
];

export const shopHealth: ShopHealthRow[] = [
  { shop: "Shop A1 · US", ahr: "780", odr: "0.4%", lateShip: "1.2%", status: "green", statusLabel: "Khỏe" },
  { shop: "Shop C2 · US", ahr: "165", odr: "0.9%", lateShip: "3.8%", status: "amber", statusLabel: "Có rủi ro" },
  { shop: "Shop B1 · DE", ahr: "—", odr: "—", lateShip: "—", status: "gray", statusLabel: "Chưa kết nối" },
];

export const overdueTasks: MiniItemData[] = [
  { icon: "⏰", title: "KYC Shop D1", sub: "hạn 2 ngày · phòng Vận hành", right: "quá hạn 1 ngày", tone: "down" },
  { icon: "📄", title: "Khiếu nại vi phạm IP — Shop C2", sub: "hạn hôm qua · phòng Vận hành", right: "quá hạn 1 ngày", tone: "down" },
  { icon: "🔁", title: "Bàn giao shop E3 cho PPC mới", sub: "hạn 3 ngày · điều phối", right: "hết hôm nay", tone: "warn" },
];

/* ---------- Listing ---------- */
export const listingKpis: KpiCardData[] = [
  { label: "Listing active", value: "1,240", sub: "▲ 12 listing mới", tone: "up" },
  { label: "Inactive / stranded", value: "18", sub: "▼ 6 so với hôm qua", tone: "up" },
  { label: "Listing có lỗi", value: "7", sub: "3 lỗi ảnh · 2 thiếu thuộc tính", tone: "down" },
  { label: "Chờ duyệt nội dung", value: "12", sub: "trưởng phòng duyệt trước 12h", tone: "flat" },
];

export const listingQueue: ListingRow[] = [
  { sku: "XMO-950-BLK", asin: "B0C…31F", shop: "A1", issue: "Thiếu ảnh swatch — bị ẩn biến thể", revenuePerDay: "$96/ngày", priority: "red", priorityLabel: "Cao", owner: "Lan" },
  { sku: "VPN-220", asin: "B0B…77K", shop: "A1", issue: "Stranded — còn hàng tại FC không bán được", revenuePerDay: "$71/ngày", priority: "red", priorityLabel: "Cao", owner: "Minh" },
  { sku: "KCH-118-W", asin: "B0C…52D", shop: "C2", issue: "Tiêu đề thiếu từ khóa chính", revenuePerDay: "$38/ngày", priority: "amber", priorityLabel: "Vừa", owner: "Lan" },
  { sku: "DRF-300", asin: "B0A…14M", shop: "A2", issue: "Thuộc tính expiration bắt buộc thiếu", revenuePerDay: "$12/ngày", priority: "gray", priorityLabel: "Thấp", owner: "Tuấn" },
];

/* ---------- PPC ---------- */
export const ppcKpis: KpiCardData[] = [
  { label: "Spend hôm qua", value: "$862", sub: "91% ngân sách ngày", tone: "flat" },
  { label: "ACOS 7 ngày", value: "18.2%", sub: "▼ 0.8 điểm · mục tiêu ≤ 20%", tone: "up" },
  { label: "TACOS", value: "6.9%", sub: "▼ 0.4 điểm", tone: "up" },
  { label: "Đơn từ quảng cáo", value: "96", sub: "▲ 6 đơn", tone: "up" },
];

export const ppcAlerts: { tone: AlertSeverity; text: string }[] = [
  { tone: "red", text: "2 campaign hết budget trước 18h hôm qua — đang mất cơ hội đơn" },
  { tone: "amber", text: 'Campaign "XMO-950 Exact" ACOS 34% (vượt ngưỡng 25%) 3 ngày liên tiếp' },
  { tone: "green", text: "5 từ khóa gợi ý negative sẵn sàng duyệt (click 42 · 0 đơn)" },
];

export const campaignsOver: CampaignRow[] = [
  { name: "XMO-950 Exact", spend7d: "$312", acos: "34.0%", trend: "▲ 3 ngày" },
  { name: "VPN-220 Broad", spend7d: "$198", acos: "28.7%", trend: "▲ 2 ngày" },
  { name: "KCH-118 Auto", spend7d: "$87", acos: "25.9%", trend: "bằng phẳng" },
];

/* ---------- Fulfillment ---------- */
export const fulfillKpis: KpiCardData[] = [
  { label: "SKU sắp hết hàng", value: "5", sub: "cover < 14 ngày", tone: "down" },
  { label: "Tồn khả dụng", value: "48,220", sub: "đơn vị · toàn shop", tone: "flat" },
  { label: "Lô hàng đang về", value: "6", sub: "2 lô sắp đến FC", tone: "flat" },
  { label: "Tồn > 365 ngày", value: "12 SKU", sub: "chuẩn bị removal để tránh phí dài hạn", tone: "warn" },
];

export const skuStock: SkuStockRow[] = [
  { sku: "XMO-950-BLK", stock: 88, coverDays: 5, coverTone: "red", perDay: 17, suggest: 520 },
  { sku: "VPN-220", stock: 140, coverDays: 8, coverTone: "red", perDay: 18, suggest: 540 },
  { sku: "KCH-118-W", stock: 210, coverDays: 11, coverTone: "amber", perDay: 19, suggest: 570 },
];

export const inboundShipments: InboundShipment[] = [
  { id: "FBA15G…K3QX", units: "520 đơn vị", note: "Shop A1 · đang giao đến FC ONT8", right: "ETA 4 ngày", tone: "flat" },
  { id: "FBA15G…9DLP", units: "540 đơn vị", note: "Shop A1 · đang nhận tại FC LAX9", right: "ETA 1 ngày", tone: "warn" },
  { id: "FBA14Q…2XZT", units: "32 đơn vị thiếu khi nhận", note: "cần mở case điều tra bồi hoàn", right: "cần xử lý", tone: "down" },
];

/* ---------- Orders & CSKH ---------- */
export const ordersKpis: KpiCardData[] = [
  { label: "Đơn hôm nay", value: "341", sub: "FBA 320 · FBM 21", tone: "flat" },
  { label: "FBM chờ xác nhận", value: "4", sub: "còn 3h trước hạn ship", tone: "warn" },
  { label: "Tin nhắn chưa trả lời", value: "2", sub: "1 tin gần 21h — SLA 24h", tone: "warn" },
  { label: "Return mới", value: "3", sub: "1 refund chờ duyệt", tone: "flat" },
];

export const shipMetrics = [
  { name: "ODR", current: "0.8%", threshold: "< 1%", safe: true },
  { name: "Late Shipment Rate", current: "2.1%", threshold: "< 4%", safe: true },
  { name: "Valid Tracking Rate", current: "97%", threshold: "> 95%", safe: true },
];

export const ordersAlerts: { tone: AlertSeverity; text: string }[] = [
  { tone: "amber", text: "4 đơn FBM chờ xác nhận — hết hạn sau 3 giờ" },
  { tone: "amber", text: "Tin nhắn buyer #114-… về đổi kích cỡ — 21h chưa trả lời" },
  { tone: "red", text: "1 feedback 1★ mới cho Shop A1 — xem chính sách phản hồi" },
];

/* ---------- Finance ---------- */
export const financeKpis: KpiCardData[] = [
  { label: "Tiền về kỳ gần nhất", value: "$42,180", sub: "kỳ 27/08–09/09 · 14 shop", tone: "flat" },
  { label: "Phí Amazon kỳ này", value: "$9,340", sub: "referral 6,1k · FBA 2,5k · storage 0,7k", tone: "flat" },
  { label: "Doanh thu chưa thanh toán", value: "$18,900", sub: "kỳ hiện tại", tone: "flat" },
  { label: "Bồi hoàn cần claim", value: "6 khoản", sub: "≈ $1,240 hồi về", tone: "up" },
];

export const skuProfit: SkuProfitRow[] = [
  { sku: "XMO-950-BLK", revenue: "$2,880", amazonFees: "−$712", cogs: "−$1,380", gross: "+$788 (27%)", tone: "up" },
  { sku: "VPN-220", revenue: "$1,260", amazonFees: "−$318", cogs: "−$640", gross: "+$302 (24%)", tone: "up" },
  { sku: "KCH-118-W", revenue: "$740", amazonFees: "−$205", cogs: "−$470", gross: "+$65 (9%)", tone: "warn" },
];

export const reimbursements: ReimbursementRow[] = [
  { title: "Hàng mất tại FC ONT8", detail: "18 đơn vị · XMO-950 · phát hiện khi đối soát tồn", amount: "+$324" },
  { title: "Hư hỏng khi nhập FBA15G…9DLP", detail: "7 đơn vị · VPN-220", amount: "+$126" },
  { title: "Thu sai phí lưu kho dài hạn", detail: "kỳ 08/2026 · Shop C2", amount: "+$210" },
];

/* ---------- Client Viewer ---------- */
export const clientKpis: KpiCardData[] = [
  { label: "Doanh thu tháng này", value: "$186,400", sub: "▲ 11% so tháng trước", tone: "up" },
  { label: "Đơn hàng tháng", value: "5,120", sub: "▲ 6%", tone: "up" },
  { label: "Sức khỏe tài khoản", value: "Tốt", sub: "AHR 780 · không vi phạm", tone: "up" },
  { label: "Kỳ thanh toán tới", value: "$23,900", sub: "chiếu toán 24/09", tone: "flat" },
];

export const clientReports: MiniItemData[] = [
  { icon: "📄", title: "Báo cáo tuần 37", sub: "doanh thu · quảng cáo · tồn kho · 3 hành động đề xuất", right: "đã gửi 08/09", tone: "flat" },
  { icon: "📄", title: "Báo cáo tháng 08", sub: "đầy đủ settlement & lợi nhuận SKU", right: "đã gửi 02/09", tone: "flat" },
];

/* ---------- Module 0: sync health ---------- */
export const syncJobs: SyncJobRow[] = [
  { jobType: "orders.pull (delta)", shop: "Shop A1 · US", status: "done", statusLabel: "Xong", lastRun: "06:00", latency: "12 phút trước", retries: 0 },
  { jobType: "inventory.getInventorySummaries", shop: "Shop A1 · US", status: "done", statusLabel: "Xong", lastRun: "05:45", latency: "27 phút trước", retries: 0 },
  { jobType: "report.all_orders", shop: "Shop C2 · US", status: "running", statusLabel: "Đang chạy", lastRun: "02:00", latency: "đang xử lý", retries: 0 },
  { jobType: "pricing.getListingOffersBatch", shop: "Shop A1 · US", status: "failed", statusLabel: "Lỗi", lastRun: "03:10", latency: "4 giờ trước", retries: 3 },
  { jobType: "notifications.ORDER_CHANGE", shop: "Shop A2 · MX", status: "done", statusLabel: "Xong", lastRun: "realtime", latency: "1 phút trước", retries: 0 },
];

/* ---------- Module 0: API usage ---------- */
export const apiUsage: ApiUsageRow[] = [
  { apiGroup: "Orders API", callsToday: 128, quota: "~0.0167 rps/shop", trend: "ổn định" },
  { apiGroup: "FBA Inventory API", callsToday: 54, quota: "2 rps · 30 burst", trend: "ổn định" },
  { apiGroup: "Product Pricing API", callsToday: 41, quota: "0.5 rps · batch 20", trend: "cần theo dõi" },
  { apiGroup: "Reports API", callsToday: 12, quota: "theo lịch", trend: "ổn định" },
  { apiGroup: "Notifications API", callsToday: 8, quota: "1 rps", trend: "ổn định" },
];

/* ---------- Module 0: audit log ---------- */
export const auditLogs: AuditRow[] = [
  { time: "11/09 09:41", actor: "Minh (Kho vận)", module: "pricing", action: "price.update", entity: "VPN-220", change: "$14.99 → $14.64 (−2.3%)", result: "ok" },
  { time: "11/09 09:12", actor: "Tuấn (PPC)", module: "ads", action: "campaign.budget", entity: "XMO-950 Exact", change: "$40 → $52 (+30%) · đã duyệt trưởng phòng", result: "ok" },
  { time: "11/09 08:47", actor: "Lan (Listing)", module: "listings", action: "listing.draft", entity: "KCH-118-W", change: "tạo bản nháp sửa tiêu đề", result: "ok" },
  { time: "10/09 17:22", actor: "Hà (CSKH)", module: "orders", action: "fbm.confirm", entity: "114-8823117-221", change: "đã gửi tracking", result: "ok" },
  { time: "10/09 16:03", actor: "Minh (Kho vận)", module: "pricing", action: "price.update", entity: "XMO-950-BLK", change: "$29.99 → $31.99 (+6.7%)", result: "error" },
];

/* ---------- Module 0: users ---------- */
export const users: UserRow[] = [
  { name: "Nguyễn Hải Anh", email: "haianh@vexim.vn", role: "Dept Lead", department: "Vận hành & Health", shops: "14 shop", status: "active" },
  { name: "Trần Mỹ Linh", email: "mylinh@vexim.vn", role: "Dept Lead", department: "Kho vận & FBA", shops: "9 shop", status: "active" },
  { name: "Lê Tuấn", email: "tuan@vexim.vn", role: "Operator", department: "PPC", shops: "5 shop được gán", status: "active" },
  { name: "Nguyễn Hà", email: "ha@vexim.vn", role: "Operator", department: "Đơn hàng & CSKH", shops: "6 shop", status: "active" },
  { name: "Trịnh Lan", email: "lan@vexim.vn", role: "Operator", department: "Listing & Nội dung", shops: "14 shop", status: "active" },
  { name: "Đại diện Doanh nghiệp A", email: "contact@khacha-a.vn", role: "Client Viewer", department: "—", shops: "2 shop (chỉ đọc)", status: "invited" },
];

/* ---------- Module 4: Đơn hàng (O1–O4) — mock ---------- */
import type { FbmRow, OrderDetailMock, OrderRow, ReturnRow, ViolationRow } from "@/lib/types";

export const ordersList: OrderRow[] = [
  { id: "114-8823117-2217014", date: "11/09 08:41", status: "Pending", channel: "MFN", itemsCount: 2, total: "$43.98", mainSku: "XMO-950-BLK", shop: "A1" },
  { id: "113-5541209-1140233", date: "11/09 08:12", status: "Shipped", channel: "AFN", itemsCount: 1, total: "$29.99", mainSku: "XMO-950-BLK", shop: "A1" },
  { id: "113-9982107-3309812", date: "11/09 07:55", status: "Shipped", channel: "AFN", itemsCount: 3, total: "$52.97", mainSku: "VPN-220", shop: "A1" },
  { id: "112-7710455-2205641", date: "11/09 07:31", status: "Pending", channel: "MFN", itemsCount: 1, total: "$19.99", mainSku: "KCH-118-W", shop: "C2" },
  { id: "112-3309881-4471205", date: "11/09 06:58", status: "Delivered", channel: "AFN", itemsCount: 1, total: "$34.99", mainSku: "DRF-300", shop: "A2" },
  { id: "111-8890123-9987110", date: "11/09 06:40", status: "Shipped", channel: "AFN", itemsCount: 2, total: "$39.98", mainSku: "XMO-950-BLK", shop: "A1" },
  { id: "111-2233008-1155440", date: "10/09 22:15", status: "Cancelled", channel: "AFN", itemsCount: 1, total: "$0.00", mainSku: "VPN-220", shop: "A1" },
  { id: "110-9901122-3344556", date: "10/09 21:03", status: "Shipped", channel: "MFN", itemsCount: 1, total: "$24.99", mainSku: "KCH-118-W", shop: "C2" },
];

export const orderDetails: Record<string, OrderDetailMock> = {
  "114-8823117-2217014": {
    id: "114-8823117-2217014",
    date: "11/09 08:41",
    status: "Pending — chờ xác nhận",
    channel: "MFN (FBM)",
    shop: "Shop A1 · US",
    items: [
      { sku: "XMO-950-BLK", asin: "B0C…31F", qty: 1, price: "$29.99" },
      { sku: "XMO-950-CASE", asin: "B0C…32G", qty: 1, price: "$13.99" },
    ],
    timeline: [
      { time: "11/09 08:41", event: "Đơn được tạo (ORDER_CHANGE realtime)" },
      { time: "11/09 08:41", event: "Hệ thống nhận notification — đẩy vào queue FBM" },
    ],
    financials: [
      { label: "Tổng tiền hàng", amount: "$43.98" },
      { label: "Referral fee (ước tính)", amount: "−$6.60", tone: "down" },
      { label: "Tạm giữ tới khi giao", amount: "$37.38", tone: "flat" },
    ],
  },
  "113-5541209-1140233": {
    id: "113-5541209-1140233",
    date: "11/09 08:12",
    status: "Shipped",
    channel: "AFN (FBA)",
    shop: "Shop A1 · US",
    items: [{ sku: "XMO-950-BLK", asin: "B0C…31F", qty: 1, price: "$29.99" }],
    timeline: [
      { time: "11/09 08:12", event: "Đơn được tạo" },
      { time: "11/09 09:30", event: "Amazon FC giao cho hãng vận chuyển" },
    ],
    financials: [
      { label: "Tổng tiền hàng", amount: "$29.99" },
      { label: "Referral fee", amount: "−$4.50", tone: "down" },
      { label: "FBA fulfillment fee", amount: "−$5.20", tone: "down" },
    ],
  },
};

export const fbmQueue: FbmRow[] = [
  { id: "114-8823117-2217014", shop: "A1", deadline: "hôm nay 15:00", countdown: "còn 3h 12m", late: false },
  { id: "112-7710455-2205641", shop: "C2", deadline: "hôm nay 14:30", countdown: "còn 2h 42m", late: false },
  { id: "110-5566778-9900112", shop: "A2", deadline: "hôm nay 12:00", countdown: "QUÁ HẠN 40 phút", late: true },
  { id: "110-1122334-5566778", shop: "A1", deadline: "hôm nay 17:00", countdown: "còn 5h 12m", late: false },
];

export const returnsList: ReturnRow[] = [
  { id: "R1", date: "11/09", order: "113-2201455-8890012", reasonCode: "NOT_AS_DESCRIBED", reasonLabel: "Không đúng mô tả", status: "Chờ nhận hàng về", refund: "$29.99", shop: "A1" },
  { id: "R2", date: "10/09", order: "112-9981023-4451109", reasonCode: "DEFECTIVE", reasonLabel: "Lỗi sản phẩm", status: "Đã nhận · duyệt refund", refund: "$19.99", shop: "C2" },
  { id: "R3", date: "10/09", order: "111-3345678-9902231", reasonCode: "NO_LONGER_NEEDED", reasonLabel: "Không còn cần", status: "Chờ nhận hàng về", refund: "$34.99", shop: "A2" },
  { id: "R4", date: "09/09", order: "110-7766541-2201987", reasonCode: "BETTER_PRICE_AVAILABLE", reasonLabel: "Thấy giá tốt hơn", status: "Đã hoàn tiền", refund: "$24.99", shop: "A1" },
];

export const returnReasonSummary = [
  { reason: "Không còn cần", count: 9, pct: 32 },
  { reason: "Thấy giá tốt hơn", count: 7, pct: 25 },
  { reason: "Không đúng mô tả", count: 6, pct: 21 },
  { reason: "Lỗi sản phẩm", count: 4, pct: 14 },
  { reason: "Khác", count: 2, pct: 8 },
];

/* ---------- Module 7: Health chi tiết (H2) — mock ---------- */
export const healthViolations: ViolationRow[] = [
  { type: "IP Complaint — nhãn hiệu", severity: "High", shop: "Shop C2 · US", opened: "08/09", status: "Đang thu bằng chứng", owner: "Hải Anh", caseId: "CS-10238741" },
  { type: "Listing gỡ — hàng hạn chế", severity: "Medium", shop: "Shop C2 · US", opened: "06/09", status: "Đang khiếu nại", owner: "Hải Anh", caseId: "CS-10235512" },
  { type: "KYC — yêu cầu giấy tờ", severity: "High", shop: "Shop D1 · US", opened: "04/09", status: "Quá hạn — cần đẩy", owner: "Hải Anh", caseId: "CS-10221140" },
  { type: "Chất lượng listing (Listing Quality)", severity: "Low", shop: "Shop A2 · MX", opened: "02/09", status: "Đã xử lý — chờ Amazon gỡ", owner: "Trịnh Lan", caseId: "CS-10199033" },
];

/* ---------- Module 3: Kho vận & FBA (I1–I4) — mock ---------- */
import type { InboundRow, InventoryDetailMock, InventoryRow, RestockRow } from "@/lib/types";

export const inventoryRows: InventoryRow[] = [
  { sku: "XMO-950-BLK", asin: "B0C…31F", shop: "A1", fulfillable: 88, reserved: 12, inbound: 60, velocity: 17, coverDays: 5, suggest: 520, agedDays: null, status: "out", statusLabel: "Hết hàng — chờ lô về" },
  { sku: "XMO-950-WHT", asin: "B0C…31G", shop: "A1", fulfillable: 0, reserved: 0, inbound: 300, velocity: 12, coverDays: 0, suggest: 0, agedDays: null, status: "out", statusLabel: "Hết hàng — chờ lô về" },
  { sku: "VPN-220", asin: "B0B…77K", shop: "A1", fulfillable: 140, reserved: 8, inbound: 100, velocity: 18, coverDays: 8, suggest: 540, agedDays: null, status: "low", statusLabel: "Sắp hết (cover 7–14)" },
  { sku: "KCH-118-W", asin: "B0C…52D", shop: "C2", fulfillable: 210, reserved: 15, inbound: 0, velocity: 19, coverDays: 11, suggest: 570, agedDays: null, status: "low", statusLabel: "Sắp hết (cover 7–14)" },
  { sku: "KCH-118-BLK", asin: "B0C…52E", shop: "C2", fulfillable: 45, reserved: 5, inbound: 0, velocity: 4, coverDays: 11, suggest: 130, agedDays: null, status: "low", statusLabel: "Sắp hết (cover 7–14)" },
  { sku: "DRF-300", asin: "B0A…14M", shop: "A2", fulfillable: 640, reserved: 22, inbound: 0, velocity: 6, coverDays: 107, suggest: null, agedDays: null, status: "ok", statusLabel: "Đủ hàng" },
  { sku: "XMO-951", asin: "B0D…88C", shop: "A1", fulfillable: 96, reserved: 4, inbound: 0, velocity: 2, coverDays: 48, suggest: null, agedDays: null, status: "ok", statusLabel: "Đủ hàng" },
  { sku: "DRF-300-OLD", asin: "B0A…15N", shop: "A2", fulfillable: 820, reserved: 0, inbound: 0, velocity: 1.4, coverDays: 585, suggest: null, agedDays: 410, status: "aged", statusLabel: "Tồn lâu >365 ngày" },
  { sku: "VPN-221", asin: "B0B…78L", shop: "A1", fulfillable: 1200, reserved: 0, inbound: 0, velocity: 3, coverDays: 400, suggest: null, agedDays: 380, status: "aged", statusLabel: "Tồn lâu >365 ngày" },
];

export const inventoryDetails: Record<string, InventoryDetailMock> = {
  "XMO-950-BLK": {
    sku: "XMO-950-BLK",
    asin: "B0C…31F",
    fnsku: "X00DEMO01F",
    shop: "Shop A1 · US",
    unitCost: "$2.65 (hiệu lực từ 01/08)",
    stock90: [
      { label: "T1", pct: 96 }, { label: "T2", pct: 88 }, { label: "T3", pct: 82 },
      { label: "T4", pct: 74 }, { label: "T5", pct: 68 }, { label: "T6", pct: 61 },
      { label: "T7", pct: 55 }, { label: "T8", pct: 48 }, { label: "T9", pct: 42 },
      { label: "T10", pct: 36 }, { label: "T11", pct: 28 }, { label: "T12", pct: 22 },
    ],
    sales90: [
      { label: "T1", pct: 55 }, { label: "T2", pct: 62 }, { label: "T3", pct: 58 },
      { label: "T4", pct: 70 }, { label: "T5", pct: 65 }, { label: "T6", pct: 72 },
      { label: "T7", pct: 78 }, { label: "T8", pct: 74 }, { label: "T9", pct: 82 },
      { label: "T10", pct: 88 }, { label: "T11", pct: 85 }, { label: "T12", pct: 92 },
    ],
    fcAllocation: [
      { fc: "ONT8 (CA)", units: 40, disposition: "Khả dụng" },
      { fc: "LAX9 (CA)", units: 28, disposition: "Khả dụng" },
      { fc: "SBD1 (CA)", units: 12, disposition: "Khả dụng" },
      { fc: "ONT8 (CA)", units: 8, disposition: "Reserved" },
      { fc: "LAX9 (CA)", units: 12, disposition: "Reserved (FC transfer)" },
    ],
    receipts: [
      { date: "12/08", shipment: "FBA15G…7QKP", expected: 500, received: 500 },
      { date: "28/07", shipment: "FBA15F…2MZA", expected: 480, received: 476 },
      { date: "10/07", shipment: "FBA15F…9XZT", expected: 32, received: 0 },
    ],
    inboundComing: [
      { id: "FBA15G…K3QX", units: 520, eta: "4 ngày nữa" },
    ],
  },
};

export const restockPlan: RestockRow[] = [
  { sku: "XMO-950-BLK", shop: "A1", suggest: 520, unitCost: "$2.65", value: "$1,378", step: "4/8", stepLabel: "Chờ khách chốt giá vốn", tone: "red" },
  { sku: "VPN-220", shop: "A1", suggest: 540, unitCost: "$1.20", value: "$648", step: "6/8", stepLabel: "Đã tạo inbound plan", tone: "green" },
  { sku: "KCH-118-W", shop: "C2", suggest: 570, unitCost: "$0.95", value: "$542", step: "2/8", stepLabel: "Kiểm tra lô đang về", tone: "amber" },
  { sku: "KCH-118-BLK", shop: "C2", suggest: 130, unitCost: "$0.95", value: "$124", step: "1/8", stepLabel: "Nháp — chưa gửi duyệt", tone: "gray" },
  { sku: "XMO-950-WHT", shop: "A1", suggest: 360, unitCost: "$2.65", value: "$954", step: "6/8", stepLabel: "Đã tạo inbound plan", tone: "green" },
];

export const inboundShipmentsFull: InboundRow[] = [
  { id: "FBA15G…K3QX", shop: "A1", status: "IN_TRANSIT", statusTone: "amber", units: 520, fc: "ONT8", eta: "4 ngày", reconcile: "—", reconcileTone: "flat" },
  { id: "FBA15G…9DLP", shop: "A1", status: "RECEIVING", statusTone: "amber", units: 540, fc: "LAX9", eta: "1 ngày", reconcile: "—", reconcileTone: "flat" },
  { id: "FBA15G…44TN", shop: "A1", status: "CLOSED", statusTone: "green", units: 300, fc: "SBD1", eta: "đã nhận 08/09", reconcile: "Đủ 300/300", reconcileTone: "up" },
  { id: "FBA15F…2MZA", shop: "A1", status: "CLOSED", statusTone: "green", units: 480, fc: "ONT8", eta: "đã nhận 28/07", reconcile: "Thiếu 4 — đã claim", reconcileTone: "warn" },
  { id: "FBA14Q…2XZT", shop: "A2", status: "CLOSED", statusTone: "green", units: 32, fc: "LAX9", eta: "đã nhận 10/07", reconcile: "Thiếu 32 — SOP-09", reconcileTone: "down" },
  { id: "FBA15H…8PLM", shop: "C2", status: "WORKING", statusTone: "gray", units: 570, fc: "— chờ placement", eta: "—", reconcile: "—", reconcileTone: "flat" },
];
