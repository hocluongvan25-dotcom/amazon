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

/* ---------- Module 0: users ----------
 * ĐÃ XOÁ 13/09/2026: mảng `users` 6 tài khoản viết cứng (haianh@vexim.vn, mylinh@…)
 * KHÔNG hề tồn tại trong DB mà vẫn hiện trên màn Người dùng ⇒ người dùng thật
 * tưởng đó là nhân viên đã mời. Màn `/module0/users` nay đọc
 * `public.vexim_admin_users()` (migration 0022); chế độ demo dùng dữ liệu giả lập
 * ghi rõ trong `(app)/module0/users/demo-users.ts`.
 */

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
  { sku: "XMO-950-BLK", asin: "B0C…31F", shop: "A1", fulfillable: 88, reserved: 12, inbound: 60, velocity: 17, coverDays: 5, suggest: 520, agedDays: null, status: "out", statusLabel: "Hết hàng — chờ lô về", unitCost: 2.65, costCurrency: "USD", costEffectiveFrom: "2026-09-01", costSource: "csv", stockValue: 233.2, totalStockValue: 424, valueCurrency: "USD", valueBasis: "cost" },
  { sku: "XMO-950-WHT", asin: "B0C…31G", shop: "A1", fulfillable: 0, reserved: 0, inbound: 300, velocity: 12, coverDays: 0, suggest: 0, agedDays: null, status: "out", statusLabel: "Hết hàng — chờ lô về", unitCost: 2.65, costCurrency: "USD", costEffectiveFrom: "2026-09-01", costSource: "csv", stockValue: 0, totalStockValue: 795, valueCurrency: "USD", valueBasis: "cost" },
  { sku: "VPN-220", asin: "B0B…77K", shop: "A1", fulfillable: 140, reserved: 8, inbound: 100, velocity: 18, coverDays: 8, suggest: 540, agedDays: null, status: "low", statusLabel: "Sắp hết (cover 7–14)", unitCost: 1.2, costCurrency: "USD", costEffectiveFrom: "2026-09-01", costSource: "csv", stockValue: 168, totalStockValue: 297.6, valueCurrency: "USD", valueBasis: "cost" },
  { sku: "KCH-118-W", asin: "B0C…52D", shop: "C2", fulfillable: 210, reserved: 15, inbound: 0, velocity: 19, coverDays: 11, suggest: 570, agedDays: null, status: "low", statusLabel: "Sắp hết (cover 7–14)", unitCost: 0.95, costCurrency: "USD", costEffectiveFrom: "2026-09-01", costSource: "csv", stockValue: 199.5, totalStockValue: 213.75, valueCurrency: "USD", valueBasis: "cost" },
  { sku: "KCH-118-BLK", asin: "B0C…52E", shop: "C2", fulfillable: 45, reserved: 5, inbound: 0, velocity: 4, coverDays: 11, suggest: 130, agedDays: null, status: "low", statusLabel: "Sắp hết (cover 7–14)", unitCost: 0.95, costCurrency: "USD", costEffectiveFrom: "2026-09-01", costSource: "csv", stockValue: 42.75, totalStockValue: 47.5, valueCurrency: "USD", valueBasis: "cost" },
  { sku: "DRF-300", asin: "B0A…14M", shop: "A2", fulfillable: 640, reserved: 22, inbound: 0, velocity: 6, coverDays: 107, suggest: null, agedDays: null, status: "ok", statusLabel: "Đủ hàng", unitCost: 7.4, costCurrency: "USD", costEffectiveFrom: "2026-09-01", costSource: "csv", stockValue: 4736, totalStockValue: 4898.8, valueCurrency: "USD", valueBasis: "cost" },
  { sku: "XMO-951", asin: "B0D…88C", shop: "A1", fulfillable: 96, reserved: 4, inbound: 0, velocity: 2, coverDays: 48, suggest: null, agedDays: null, status: "ok", statusLabel: "Đủ hàng", unitCost: 3.1, costCurrency: "USD", costEffectiveFrom: "2026-09-01", costSource: "csv", stockValue: 297.6, totalStockValue: 310, valueCurrency: "USD", valueBasis: "cost" },
  { sku: "DRF-300-OLD", asin: "B0A…15N", shop: "A2", fulfillable: 820, reserved: 0, inbound: 0, velocity: 1.4, coverDays: 585, suggest: null, agedDays: 410, status: "aged", statusLabel: "Tồn lâu >365 ngày", unitCost: 7.4, costCurrency: "USD", costEffectiveFrom: "2026-09-01", costSource: "csv", stockValue: 6068, totalStockValue: 6068, valueCurrency: "USD", valueBasis: "cost" },
  { sku: "VPN-221", asin: "B0B…78L", shop: "A1", fulfillable: 1200, reserved: 0, inbound: 0, velocity: 3, coverDays: 400, suggest: null, agedDays: 380, status: "aged", statusLabel: "Tồn lâu >365 ngày", unitCost: null, costCurrency: null, costEffectiveFrom: null, costSource: null, stockValue: null, totalStockValue: null, valueCurrency: null, valueBasis: "missing" },
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

import type { ListingDetailMock, ListingListRow, ListingQueueItem } from "@/lib/types";

/* ---------- Module 1 — Listing (L1/L2/L4) ---------- */

export const listingList: ListingListRow[] = [
  { sku: "XMO-950-BLK", asin: "B0C7T31F", title: "XMO 950 Hardside Spinner Đen 28\"", shop: "A1", brand: "XMO Home", status: "SUPPRESSED", price: "$129.99", stock: 142, issueErrors: 1, issueWarnings: 1, owner: "Lan", revenue30d: 2880, revenueCurrency: "USD", units30d: 22, lastOrderAt: "2026-09-12T02:00:00Z", updated: "2 giờ trước", issues: [{ code: "—", severity: "ERROR", message: "Ảnh biến thể (swatch) thiếu — biến thể không hiển thị trên trang cha, listing bị ẩn khỏi tìm kiếm", attributeNames: ["main_image", "other_image_url_2"], enforcement: "SEARCH_SUPPRESSED" }, { code: "8541", severity: "WARNING", message: "Attributes tagged as relevant_attributes are incomplete. Provide values for: item_diameter, theme", attributeNames: ["item_diameter", "theme"] }], productType: "LUGGAGE", buyable: false, discoverable: true, strandedReason: null, enforcementActions: ["SEARCH_SUPPRESSED"], lastSource: "api", lastSyncedAt: "2026-09-12T02:00:00Z" },
  { sku: "XMO-950-BLU", asin: "B0C7T31G", title: "XMO 950 Hardside Spinner Xanh 28\"", shop: "A1", brand: "XMO Home", status: "ACTIVE", price: "$129.99", stock: 96, issueErrors: 0, issueWarnings: 0, owner: "Lan", revenue30d: 1710, revenueCurrency: "USD", units30d: 13, lastOrderAt: "2026-09-12T02:00:00Z", updated: "2 giờ trước", issues: [], productType: "LUGGAGE", buyable: true, discoverable: true, strandedReason: null, enforcementActions: [], lastSource: "api", lastSyncedAt: "2026-09-12T02:00:00Z" },
  { sku: "VPN-220", asin: "B0B2X77K", title: "VPNova 220 Máy xay sinh tố 1.5L", shop: "A1", brand: "VPNova", status: "STRANDED", price: "$59.90", stock: 214, issueErrors: 1, issueWarnings: 0, owner: "Minh", revenue30d: 2130, revenueCurrency: "USD", units30d: 36, lastOrderAt: "2026-09-12T02:00:00Z", updated: "5 giờ trước", issues: [{ code: "90220", severity: "ERROR", message: "Missing required attribute: product_description", attributeNames: ["product_description"] }], productType: null, buyable: false, discoverable: false, strandedReason: "Stranded — còn hàng tại FC không bán được", enforcementActions: ["LISTING_SUPPRESSED"], lastSource: "report", lastSyncedAt: "2026-09-12T02:00:00Z" },
  { sku: "VPN-220-PRO", asin: "B0B2X77L", title: "VPNova 220 Pro Máy xay 2L", shop: "A1", brand: "VPNova", status: "ACTIVE", price: "$89.00", stock: 58, issueErrors: 0, issueWarnings: 1, owner: "Minh", revenue30d: 1245, revenueCurrency: "USD", units30d: 14, lastOrderAt: "2026-09-12T02:00:00Z", updated: "5 giờ trước", issues: [{ code: "8541", severity: "WARNING", message: "Attribute item_name is missing keywords recommended for this product type", attributeNames: ["item_name"] }], productType: null, buyable: true, discoverable: true, strandedReason: null, enforcementActions: [], lastSource: "report", lastSyncedAt: "2026-09-12T02:00:00Z" },
  { sku: "KCH-118-W", asin: "B0C4K52D", title: "KChef 118 Nồi chiên không dầu 5.5L Trắng", shop: "C2", brand: "KChef", status: "ACTIVE", price: "$79.99", stock: 310, issueErrors: 0, issueWarnings: 2, owner: "Lan", revenue30d: 1140, revenueCurrency: "USD", units30d: 14, lastOrderAt: "2026-09-12T02:00:00Z", updated: "hôm qua", issues: [{ code: "8541", severity: "WARNING", message: "Tiêu đề thiếu từ khóa chính của danh mục", attributeNames: ["item_name"] }, { code: "90220", severity: "WARNING", message: "bullet_point nên có tối thiểu 3 ý theo checklist danh mục", attributeNames: ["bullet_point"] }], productType: null, buyable: true, discoverable: true, strandedReason: null, enforcementActions: [], lastSource: "report", lastSyncedAt: "2026-09-11T02:00:00Z" },
  { sku: "KCH-118-BK", asin: "B0C4K52E", title: "KChef 118 Nồi chiên không dầu 5.5L Đen", shop: "C2", brand: "KChef", status: "INACTIVE", price: "$79.99", stock: 0, issueErrors: 1, issueWarnings: 0, owner: "Tuấn", revenue30d: 320, revenueCurrency: "USD", units30d: 4, lastOrderAt: "2026-09-12T02:00:00Z", updated: "hôm qua", issues: [{ code: "OUT_OF_STOCK", severity: "ERROR", message: "Hết tồn FBA — listing tự chuyển INACTIVE", attributeNames: ["fulfillment_availability"] }], productType: null, buyable: false, discoverable: true, strandedReason: null, enforcementActions: [], lastSource: "notification", lastSyncedAt: "2026-09-12T01:20:00Z" },
  { sku: "DRF-300", asin: "B0A9F14M", title: "DriftLine 300 Ghế camping gấp", shop: "A2", brand: "DriftLine", status: "INACTIVE", price: "$45.50", stock: 87, issueErrors: 1, issueWarnings: 0, owner: "Tuấn", revenue30d: 360, revenueCurrency: "USD", units30d: 8, lastOrderAt: "2026-09-12T02:00:00Z", updated: "3 ngày trước", issues: [{ code: "8541", severity: "ERROR", message: "Thuộc tính expiration_date bắt buộc thiếu (danh mục cắm trại)", attributeNames: ["expiration_date"] }], productType: null, buyable: false, discoverable: true, strandedReason: null, enforcementActions: [], lastSource: "report", lastSyncedAt: "2026-09-09T02:00:00Z" },
  { sku: "DRF-300-XL", asin: "B0A9F14N", title: "DriftLine 300 XL Ghế camping", shop: "A2", brand: "DriftLine", status: "ACTIVE", price: "$59.00", stock: 41, issueErrors: 0, issueWarnings: 0, owner: "Tuấn", revenue30d: 690, revenueCurrency: "USD", units30d: 12, lastOrderAt: "2026-09-12T02:00:00Z", updated: "3 ngày trước", issues: [], productType: null, buyable: true, discoverable: true, strandedReason: null, enforcementActions: [], lastSource: "report", lastSyncedAt: "2026-09-09T02:00:00Z" },
  { sku: "AQR-12-TOW", asin: "B0D1Q88A", title: "Aqura 12 Khăn tắm microfiber", shop: "C2", brand: "Aqura", status: "ACTIVE", price: "$19.99", stock: 520, issueErrors: 0, issueWarnings: 0, owner: "Minh", revenue30d: 480, revenueCurrency: "USD", units30d: 24, lastOrderAt: "2026-09-12T02:00:00Z", updated: "hôm qua", issues: [], productType: null, buyable: true, discoverable: true, strandedReason: null, enforcementActions: [], lastSource: "report", lastSyncedAt: "2026-09-11T02:00:00Z" },
  { sku: "AQR-12-SET", asin: "B0D1Q88B", title: "Aqura 12 Bộ 4 khăn microfiber", shop: "C2", brand: "Aqura", status: "STRANDED", price: "$34.99", stock: 63, issueErrors: 1, issueWarnings: 0, owner: "—", revenue30d: 95, revenueCurrency: "USD", units30d: 3, lastOrderAt: "2026-09-12T02:00:00Z", updated: "6 giờ trước", issues: [{ code: "CATALOG_ITEM_REMOVED", severity: "ERROR", message: "ASIN bị gộp khỏi catalog sau dọn danh mục — còn 63 đơn vị kẹt FC", attributeNames: ["item_name"] }], productType: null, buyable: false, discoverable: false, strandedReason: "Stranded — ASIN bị gộp khỏi catalog sau dọn danh mục", enforcementActions: [], lastSource: "report", lastSyncedAt: "2026-09-12T02:00:00Z" },
];

export const listingDetails: Record<string, ListingDetailMock> = {
  "XMO-950-BLK": {
    sku: "XMO-950-BLK",
    asin: "B0C7T31F",
    shop: "A1",
    productType: "LUGGAGE",
    conditionType: "new_new",
    statusFlags: ["DISCOVERABLE"], // mất BUYABLE → bị ẩn khỏi mua
    createdDate: "2024-08-12",
    lastUpdatedDate: "2026-09-09",
    attributes: [
      { name: "item_name", value: "XMO 950 Hardside Spinner Đen 28\" — Tương hành lý cấp độ hàng không" },
      { name: "brand", value: "XMO Home" },
      { name: "item_type_keyword", value: "hardside-spinner-luggage" },
      { name: "color", value: "Black" },
      { name: "material", value: "Polycarbonate" },
      { name: "item_weight", value: "4.3 kg" },
      { name: "item_package_quantity", value: "1" },
      { name: "purchasable_offer", value: "USD 129.99 · audience: All" },
      { name: "fulfillment_availability", value: "FBA (AMAZON_NA) · 142" },
      { name: "product_description", value: "Vỏ polycarbonate kép, khóa TSA, bánh xe 360°…" },
    ],
    issues: [
      {
        code: "—",
        severity: "ERROR",
        message: "Ảnh biến thể (swatch) thiếu — biến thể không hiển thị trên trang cha, listing bị ẩn khỏi tìm kiếm",
        attributeNames: ["main_image", "other_image_url_2"],
        enforcement: "SEARCH_SUPPRESSED",
      },
      {
        code: "8541",
        severity: "WARNING",
        message: "Attributes tagged as relevant_attributes are incomplete. Provide values for: item_diameter, theme",
        attributeNames: ["item_diameter", "theme"],
      },
    ],
    offer: { buyBox: false, price: "$129.99", offerCount: 4 },
    revenue30d: "$2,880",
    history: [
      { time: "09/09 14:20", actor: "Lan (Listing)", change: "Sửa tiêu đề — thêm từ khóa \"hardside spinner\"" },
      { time: "08/09 09:05", actor: "Amazon", change: "Issue mới: SEARCH_SUPPRESSED (ảnh swatch thiếu)" },
      { time: "05/09 17:40", actor: "Lan (Listing)", change: "Cập nhật giá $134.99 → $129.99 (tại Seller Central)" },
      { time: "01/09 11:00", actor: "Hệ thống", change: "Đồng bộ report Merchant Listings — trạng thái ACTIVE" },
    ],
  },
  "VPN-220": {
    sku: "VPN-220",
    asin: "B0B2X77K",
    shop: "A1",
    productType: "BLENDER",
    conditionType: "new_new",
    statusFlags: [], // không BUYABLE/DISCOVERABLE — listing tách khỏi tồn kho
    createdDate: "2023-11-02",
    lastUpdatedDate: "2026-08-28",
    attributes: [
      { name: "item_name", value: "VPNova 220 Máy xay sinh tố 1.5L — Lưỡi thép không gỉ 6 cánh" },
      { name: "brand", value: "VPNova" },
      { name: "model_number", value: "VPN-220" },
      { name: "capacity", value: "1.5 liter" },
      { name: "item_power", value: "800 watt" },
      { name: "purchasable_offer", value: "USD 59.90 · audience: All" },
      { name: "fulfillment_availability", value: "FBA (AMAZON_NA) · 214 (stranded)" },
      { name: "product_description", value: "Máy xay 800W, cốc Tritan, 2 cối kèm theo…" },
    ],
    issues: [
      {
        code: "90220",
        severity: "ERROR",
        message: "'product_description' is required but not supplied.",
        attributeNames: ["product_description"],
        enforcement: "LISTING_SUPPRESSED",
      },
    ],
    offer: { buyBox: false, price: "$59.90", offerCount: 1 },
    revenue30d: "$2,130",
    history: [
      { time: "28/08 10:12", actor: "Amazon", change: "Listing chuyển INACTIVE — thiếu product_description" },
      { time: "28/08 10:12", actor: "Hệ thống", change: "214 đơn vị tồn tại FC trở thành stranded (SOP-03)" },
      { time: "15/08 16:30", actor: "Minh (Listing)", change: "Bổ sung thuộc tính capacity, item_power" },
    ],
  },
};

export const listingQueueFull: ListingQueueItem[] = [
  { sku: "XMO-950-BLK", asin: "B0C7T31F", shop: "A1", cause: "Thiếu ảnh swatch biến thể — ẩn khỏi tìm kiếm", causeCode: "SEARCH_SUPPRESSED", suggestion: "Tải lên ảnh swatch 500×500+ cho biến thể Đen (SOP-03 bước 2: soạn bản sửa → duyệt → publish)", owner: "Lan", slaLabel: "còn 9h (SLA 24h)", revenuePerDay: "$96/ngày", revenue30d: 2880, priority: "red", priorityLabel: "Cao" },
  { sku: "VPN-220", asin: "B0B2X77K", shop: "A1", cause: "Stranded — thiếu product_description, 214 đơn vị kẹt tại FC", causeCode: "90220", suggestion: "Bổ sung product_description rồi relist (sửa tại Seller Central theo SOP-03)", owner: "Minh", slaLabel: "còn 14h (SLA 24h)", revenuePerDay: "$71/ngày", revenue30d: 2130, priority: "red", priorityLabel: "Cao" },
  { sku: "KCH-118-W", asin: "B0C4K52D", shop: "C2", cause: "Tiêu đề thiếu từ khóa chính — cảnh báo chất lượng", causeCode: "8541 (WARNING)", suggestion: "Viết lại item_name theo formula checklist (SOP-03 bước 7 nếu lặp ≥3 lần)", owner: "Lan", slaLabel: "hôm nay", revenuePerDay: "$38/ngày", revenue30d: 1140, priority: "amber", priorityLabel: "Vừa" },
  { sku: "DRF-300", asin: "B0A9F14M", shop: "A2", cause: "Thuộc tính expiration_date bắt buộc thiếu (danh mục cắm trại)", causeCode: "8541", suggestion: "Bổ sung expiration_date qua patch thuộc tính (Đợt 2) hoặc Seller Central", owner: "Tuấn", slaLabel: "3 ngày", revenuePerDay: "$12/ngày", revenue30d: 360, priority: "amber", priorityLabel: "Vừa" },
  { sku: "KCH-118-BK", asin: "B0C4K52E", shop: "C2", cause: "Inactive — hết hàng từ 12/09, listing tự đóng", causeCode: "OUT_OF_STOCK", suggestion: "Chờ lô inbound KCH-118 nhận hàng — listing tự active lại khi có tồn", owner: "Tuấn", slaLabel: "theo inbound", revenuePerDay: "$11/ngày", revenue30d: 330, priority: "gray", priorityLabel: "Thấp" },
  { sku: "AQR-12-SET", asin: "B0D1Q88B", shop: "C2", cause: "Stranded — ASIN bị gộp khỏi catalog sau dọn danh mục", causeCode: "CATALOG_ITEM_REMOVED", suggestion: "Tạo lại offer trên ASIN mới hoặc chuyển removal (phối Kho vận — SOP-03 bước 6)", owner: "—", slaLabel: "chưa gán", revenuePerDay: "$3/ngày", revenue30d: 90, priority: "amber", priorityLabel: "Vừa" },
];

/* ---------- Module 2 — Giá & Featured Offer (P1–P3) ---------- */
import type { PriceApprovalItem, PricingDetailMock, PricingRow } from "@/lib/types";

export const pricingKpis: KpiCardData[] = [
  { label: "SKU đang giữ Buy Box", value: "918 / 1,240", sub: "74% · ▼ 2 điểm so với hôm qua", tone: "down" },
  { label: "SKU mất box", value: "47", sub: "23 SKU có đối thủ hạ giá >$0.50", tone: "down" },
  { label: "SKU sắp mất box (<=FOEP)", value: "32", sub: "cần theo dõi trong 2h tới", tone: "warn" },
  { label: "SKU dưới giá sàn", value: "6", sub: "biên âm · cần xử lý ngay", tone: "down" },
];

export const pricingAlerts: { tone: AlertSeverity; text: string }[] = [
  { tone: "red", text: "6 SKU dưới giá sàn (biên âm) — XMO-950-BLK biên −2.1% sau khi đối thủ hạ giá" },
  { tone: "amber", text: "47 SKU mất Buy Box — ước tính rò rỉ ~$420/ngày doanh thu đối thủ ăn" },
  { tone: "amber", text: "Job getFeaturedOfferExpectedPriceBatch cho Shop C2 bị lỗi lần 3 (03:10)" },
  { tone: "green", text: "12 đề xuất áp giá chờ duyệt · 8 đề xuất ≤2% (operator tự duyệt)" },
];

/** P1 — bảng giá & Featured Offer (dữ liệu khớp listingList về SKU/ASIN/shop) */
export const pricingRows: PricingRow[] = [
  {
    sku: "XMO-950-BLK", asin: "B0C7T31F", shop: "A1",
    title: "XMO 950 Hardside Spinner Đen 28\"",
    ourPrice: 129.99, currency: "USD",
    foep: 127.49, foepDelta: 2.50,
    referencePrice: 125.99,
    floorPrice: 102.40,
    currentMargin: 21.2, marginTone: "green",
    unitCost: 76.8, costCurrency: "USD", costEffectiveFrom: "2026-09-01", costSource: "csv",
    grossProfit: 27.56, belowFloor: false,
    referralRateUsed: 0.15, minMarginRate: 0.10, otherFeePerUnit: 0,
    costBasis: "cost+fees",
    boxStatus: "at_risk",
    competitorCount: 4, velocity30d: 0.73,
    lastPriceChange: "05/09 17:40", owner: "Minh",
    units30d: 22, orders30d: 18, revenue30d: 2880,
    revenueCurrency: "USD", lastOrderAt: "2026-09-12T02:00:00Z",
  },
  {
    sku: "XMO-950-BLU", asin: "B0C7T31G", shop: "A1",
    title: "XMO 950 Hardside Spinner Xanh 28\"",
    ourPrice: 129.99, currency: "USD",
    foep: 129.99, foepDelta: 0,
    referencePrice: 132.50,
    floorPrice: 102.40,
    currentMargin: 21.2, marginTone: "green",
    unitCost: 76.8, costCurrency: "USD", costEffectiveFrom: "2026-09-01", costSource: "csv",
    grossProfit: 27.56, belowFloor: false,
    referralRateUsed: 0.15, minMarginRate: 0.10, otherFeePerUnit: 0,
    costBasis: "cost+fees",
    boxStatus: "holding",
    competitorCount: 3, velocity30d: 0.43,
    lastPriceChange: "28/08 10:00", owner: "Minh",
    units30d: 13, orders30d: 11, revenue30d: 1710,
    revenueCurrency: "USD", lastOrderAt: "2026-09-12T02:00:00Z",
  },
  {
    sku: "VPN-220", asin: "B0B2X77K", shop: "A1",
    title: "VPNova 220 Máy xay sinh tố 1.5L",
    ourPrice: 59.90, currency: "USD",
    foep: null, foepDelta: null, // listing stranded → không có offer
    referencePrice: null,
    floorPrice: null,
    currentMargin: null, marginTone: "gray",
    unitCost: null, costCurrency: null, costEffectiveFrom: null, costSource: null,
    grossProfit: null, belowFloor: null,
    referralRateUsed: 0.15, minMarginRate: 0.10, otherFeePerUnit: 0,
    costBasis: "fees_only", // chưa nhập giá vốn → P1 không tính được sàn/biên
    boxStatus: "no_box",
    competitorCount: 0, velocity30d: 1.2,
    lastPriceChange: "15/08 16:30", owner: "Minh",
    units30d: 36, orders30d: 30, revenue30d: 2130,
    revenueCurrency: "USD", lastOrderAt: "2026-09-12T02:00:00Z",
  },
  {
    sku: "VPN-220-PRO", asin: "B0B2X77L", shop: "A1",
    title: "VPNova 220 Pro Máy xay 2L",
    ourPrice: 89.00, currency: "USD",
    foep: 86.95, foepDelta: 2.05,
    referencePrice: 84.99,
    floorPrice: 72.10,
    currentMargin: 19.0, marginTone: "green",
    unitCost: 54.07, costCurrency: "USD", costEffectiveFrom: "2026-09-01", costSource: "csv",
    grossProfit: 16.91, belowFloor: false,
    referralRateUsed: 0.15, minMarginRate: 0.10, otherFeePerUnit: 0,
    costBasis: "cost+fees",
    boxStatus: "lost",
    competitorCount: 5, velocity30d: 0.47,
    lastPriceChange: "01/09 09:20", owner: "Minh",
    units30d: 14, orders30d: 12, revenue30d: 1245,
    revenueCurrency: "USD", lastOrderAt: "2026-09-12T02:00:00Z",
  },
  {
    sku: "KCH-118-W", asin: "B0C4K52D", shop: "C2",
    title: "KChef 118 Nồi chiên không dầu 5.5L Trắng",
    ourPrice: 79.99, currency: "USD",
    foep: 79.99, foepDelta: 0,
    referencePrice: 81.50,
    floorPrice: 56.30,
    currentMargin: 29.6, marginTone: "green",
    unitCost: 42.22, costCurrency: "USD", costEffectiveFrom: "2026-09-01", costSource: "csv",
    grossProfit: 23.68, belowFloor: false,
    referralRateUsed: 0.15, minMarginRate: 0.10, otherFeePerUnit: 0,
    costBasis: "cost+fees",
    boxStatus: "holding",
    competitorCount: 6, velocity30d: 0.47,
    lastPriceChange: "30/08 14:10", owner: "Lan",
    units30d: 14, orders30d: 12, revenue30d: 1140,
    revenueCurrency: "USD", lastOrderAt: "2026-09-12T02:00:00Z",
  },
  {
    sku: "KCH-118-BK", asin: "B0C4K52E", shop: "C2",
    title: "KChef 118 Nồi chiên không dầu 5.5L Đen",
    ourPrice: 79.99, currency: "USD",
    foep: null, foepDelta: null,
    referencePrice: null,
    floorPrice: 56.30,
    currentMargin: 29.6, marginTone: "green",
    unitCost: 42.22, costCurrency: "USD", costEffectiveFrom: "2026-09-01", costSource: "csv",
    grossProfit: 23.68, belowFloor: false,
    referralRateUsed: 0.15, minMarginRate: 0.10, otherFeePerUnit: 0,
    costBasis: "cost+fees",
    boxStatus: "no_box",
    competitorCount: 0, velocity30d: 0.13,
    lastPriceChange: "—", owner: "Tuấn",
    units30d: 4, orders30d: 3, revenue30d: 320,
    revenueCurrency: "USD", lastOrderAt: "2026-09-12T02:00:00Z",
  },
  {
    sku: "DRF-300", asin: "B0A9F14M", shop: "A2",
    title: "DriftLine 300 Ghế camping gấp",
    ourPrice: 45.50, currency: "USD",
    foep: 43.99, foepDelta: 1.51,
    referencePrice: 42.00,
    floorPrice: 31.80,
    currentMargin: 30.1, marginTone: "green",
    unitCost: 23.85, costCurrency: "USD", costEffectiveFrom: "2026-09-01", costSource: "csv",
    grossProfit: 13.7, belowFloor: false,
    referralRateUsed: 0.15, minMarginRate: 0.10, otherFeePerUnit: 0,
    costBasis: "cost+fees",
    boxStatus: "at_risk",
    competitorCount: 8, velocity30d: 0.27,
    lastPriceChange: "09/09 08:00", owner: "Tuấn",
    units30d: 8, orders30d: 7, revenue30d: 360,
    revenueCurrency: "USD", lastOrderAt: "2026-09-12T02:00:00Z",
  },
  {
    sku: "DRF-300-XL", asin: "B0A9F14N", shop: "A2",
    title: "DriftLine 300 XL Ghế camping",
    ourPrice: 59.00, currency: "USD",
    foep: 59.00, foepDelta: 0,
    referencePrice: 61.99,
    floorPrice: 40.20,
    currentMargin: 31.9, marginTone: "green",
    unitCost: 30.15, costCurrency: "USD", costEffectiveFrom: "2026-09-01", costSource: "csv",
    grossProfit: 18.82, belowFloor: false,
    referralRateUsed: 0.15, minMarginRate: 0.10, otherFeePerUnit: 0,
    costBasis: "cost+fees",
    boxStatus: "holding",
    competitorCount: 4, velocity30d: 0.4,
    lastPriceChange: "25/08 11:00", owner: "Tuấn",
    units30d: 12, orders30d: 10, revenue30d: 690,
    revenueCurrency: "USD", lastOrderAt: "2026-09-12T02:00:00Z",
  },
  {
    sku: "AQR-12-TOW", asin: "B0D1Q88A", shop: "C2",
    title: "Aqura 12 Khăn tắm microfiber",
    ourPrice: 19.99, currency: "USD",
    foep: 18.95, foepDelta: 1.04,
    referencePrice: 17.99,
    floorPrice: 13.40,
    currentMargin: 33.0, marginTone: "green",
    unitCost: 10.05, costCurrency: "USD", costEffectiveFrom: "2026-09-01", costSource: "csv",
    grossProfit: 6.6, belowFloor: false,
    referralRateUsed: 0.15, minMarginRate: 0.10, otherFeePerUnit: 0,
    costBasis: "cost+fees",
    boxStatus: "lost",
    competitorCount: 12, velocity30d: 0.8,
    lastPriceChange: "07/09 16:45", owner: "Minh",
    units30d: 24, orders30d: 20, revenue30d: 480,
    revenueCurrency: "USD", lastOrderAt: "2026-09-12T02:00:00Z",
  },
  {
    sku: "AQR-12-SET", asin: "B0D1Q88B", shop: "C2",
    title: "Aqura 12 Bộ 4 khăn microfiber",
    ourPrice: 34.99, currency: "USD",
    foep: null, foepDelta: null,
    referencePrice: null,
    floorPrice: null,
    currentMargin: null, marginTone: "gray",
    unitCost: null, costCurrency: null, costEffectiveFrom: null, costSource: null,
    grossProfit: null, belowFloor: null,
    referralRateUsed: 0.15, minMarginRate: 0.10, otherFeePerUnit: 0,
    costBasis: "fees_only", // chưa nhập giá vốn → P1 không tính được sàn/biên
    boxStatus: "no_box",
    competitorCount: 0, velocity30d: 0.1,
    lastPriceChange: "—", owner: "—",
    units30d: 3, orders30d: 2, revenue30d: 95,
    revenueCurrency: "USD", lastOrderAt: "2026-09-12T02:00:00Z",
  },
  {
    sku: "XMO-951-ACC", asin: "B0D88C001", shop: "A1",
    title: "XMO 951 Phụ kiện khóa TSA + cover",
    ourPrice: 24.99, currency: "USD",
    foep: 24.49, foepDelta: 0.50,
    referencePrice: 23.99,
    floorPrice: 25.60,
    currentMargin: -2.4, marginTone: "red",
    unitCost: 19.2, costCurrency: "USD", costEffectiveFrom: "2026-09-01", costSource: "csv",
    grossProfit: -0.6, belowFloor: true,
    referralRateUsed: 0.15, minMarginRate: 0.10, otherFeePerUnit: 0,
    costBasis: "cost+fees",
    boxStatus: "at_risk",
    competitorCount: 7, velocity30d: 0.87,
    lastPriceChange: "10/09 11:00", owner: "Minh",
    units30d: 26, orders30d: 22, revenue30d: 660,
    revenueCurrency: "USD", lastOrderAt: "2026-09-12T02:00:00Z",
  },
  {
    sku: "VPN-FILT-3", asin: "B0B77K099", shop: "A1",
    title: "VPNova Lọc thay thế bộ 3",
    ourPrice: 12.99, currency: "USD",
    foep: 12.99, foepDelta: 0,
    referencePrice: 13.50,
    floorPrice: 13.20,
    currentMargin: -1.6, marginTone: "red",
    unitCost: 9.9, costCurrency: "USD", costEffectiveFrom: "2026-09-01", costSource: "csv",
    grossProfit: -0.21, belowFloor: true,
    referralRateUsed: 0.15, minMarginRate: 0.10, otherFeePerUnit: 0,
    costBasis: "cost+fees",
    boxStatus: "holding",
    competitorCount: 3, velocity30d: 2.63,
    lastPriceChange: "08/09 09:30", owner: "Minh",
    units30d: 79, orders30d: 66, revenue30d: 1020,
    revenueCurrency: "USD", lastOrderAt: "2026-09-12T02:00:00Z",
  },
];

/** P2 — chi tiết giá 1 SKU (dùng XMO-950-BLK mặc định) */
export const pricingDetails: Record<string, PricingDetailMock> = {
  "XMO-950-BLK": {
    sku: "XMO-950-BLK", asin: "B0C7T31F", shop: "Shop A1 · US",
    history: [
      { date: "11/09", myPrice: 129.99, buyBoxPrice: 127.49, lowestCompetitor: 125.99 },
      { date: "10/09", myPrice: 129.99, buyBoxPrice: 129.99, lowestCompetitor: 128.50 },
      { date: "09/09", myPrice: 129.99, buyBoxPrice: 129.99, lowestCompetitor: 130.00 },
      { date: "08/09", myPrice: 129.99, buyBoxPrice: 129.99, lowestCompetitor: 132.00 },
      { date: "07/09", myPrice: 134.99, buyBoxPrice: 134.99, lowestCompetitor: 134.99 },
      { date: "06/09", myPrice: 134.99, buyBoxPrice: 134.99, lowestCompetitor: 135.00 },
      { date: "05/09", myPrice: 134.99, buyBoxPrice: 132.99, lowestCompetitor: 132.99 },
      { date: "04/09", myPrice: 134.99, buyBoxPrice: 134.99, lowestCompetitor: 136.00 },
      { date: "03/09", myPrice: 134.99, buyBoxPrice: 134.99, lowestCompetitor: 139.99 },
      { date: "02/09", myPrice: 134.99, buyBoxPrice: 134.99, lowestCompetitor: 139.99 },
      { date: "01/09", myPrice: 134.99, buyBoxPrice: 134.99, lowestCompetitor: 139.99 },
      { date: "31/08", myPrice: 134.99, buyBoxPrice: 134.99, lowestCompetitor: 139.99 },
      { date: "30/08", myPrice: 134.99, buyBoxPrice: 134.99, lowestCompetitor: 139.99 },
      { date: "29/08", myPrice: 139.99, buyBoxPrice: 139.99, lowestCompetitor: 142.00 },
      { date: "28/08", myPrice: 139.99, buyBoxPrice: 139.99, lowestCompetitor: 144.99 },
      { date: "27/08", myPrice: 139.99, buyBoxPrice: 139.99, lowestCompetitor: 144.99 },
      { date: "26/08", myPrice: 139.99, buyBoxPrice: 139.99, lowestCompetitor: 144.99 },
      { date: "25/08", myPrice: 139.99, buyBoxPrice: 139.99, lowestCompetitor: 144.99 },
      { date: "24/08", myPrice: 139.99, buyBoxPrice: 139.99, lowestCompetitor: 144.99 },
      { date: "23/08", myPrice: 139.99, buyBoxPrice: 139.99, lowestCompetitor: 144.99 },
      { date: "22/08", myPrice: 139.99, buyBoxPrice: 139.99, lowestCompetitor: 144.99 },
      { date: "21/08", myPrice: 139.99, buyBoxPrice: 139.99, lowestCompetitor: 144.99 },
      { date: "20/08", myPrice: 139.99, buyBoxPrice: 139.99, lowestCompetitor: 144.99 },
      { date: "19/08", myPrice: 139.99, buyBoxPrice: 139.99, lowestCompetitor: 144.99 },
      { date: "18/08", myPrice: 139.99, buyBoxPrice: 139.99, lowestCompetitor: 144.99 },
      { date: "17/08", myPrice: 139.99, buyBoxPrice: 139.99, lowestCompetitor: 144.99 },
      { date: "16/08", myPrice: 139.99, buyBoxPrice: 139.99, lowestCompetitor: 144.99 },
      { date: "15/08", myPrice: 139.99, buyBoxPrice: 139.99, lowestCompetitor: 144.99 },
      { date: "14/08", myPrice: 139.99, buyBoxPrice: 139.99, lowestCompetitor: 144.99 },
      { date: "13/08", myPrice: 139.99, buyBoxPrice: 139.99, lowestCompetitor: 144.99 },
    ],
    offers: [
      { sellerId: "ME", sellerLabel: "VEXIM (chúng tôi)", isMe: true, fulfillment: "FBA", price: 129.99, shipping: 0, landedPrice: 129.99, rating: null, feedbackCount: null, isFeatured: false, condition: "New" },
      { sellerId: "AMZ", sellerLabel: "Amazon.com", isMe: false, fulfillment: "AMZ", price: 127.49, shipping: 0, landedPrice: 127.49, rating: null, feedbackCount: null, isFeatured: true, condition: "New" },
      { sellerId: "S1", sellerLabel: "TravelHouse Direct", isMe: false, fulfillment: "FBA", price: 125.99, shipping: 0, landedPrice: 125.99, rating: 4.6, feedbackCount: 8420, isFeatured: false, condition: "New" },
      { sellerId: "S2", sellerLabel: "LuggageWorld", isMe: false, fulfillment: "FBM", price: 124.00, shipping: 4.95, landedPrice: 128.95, rating: 4.2, feedbackCount: 1203, isFeatured: false, condition: "New" },
      { sellerId: "S3", sellerLabel: "BagDeals LLC", isMe: false, fulfillment: "FBA", price: 128.99, shipping: 0, landedPrice: 128.99, rating: 3.9, feedbackCount: 420, isFeatured: false, condition: "New — hộp hư nhẹ" },
    ],
    fees: {
      cogs: 62.50,
      referralFeeRate: 15,
      referralFeeAmount: 19.50,
      fbaFee: 15.40,
      otherFees: 0,
      minMarginRate: 10,
      minMarginAmount: 12.99,
      floorPrice: 102.40, // 62.50 + 19.50 + 15.40 + ~5 (làm tròn biên tối thiểu 10%)
    },
    alerts: [
      { tone: "amber", text: "Đang cao hơn FOEP $2.50 — Amazon.com vừa vào box lúc 02:15 hôm nay" },
      { tone: "green", text: "Giá hiện tại trên giá sàn $27.59 (biên 21.2%)" },
      { tone: "amber", text: "Đối thủ TravelHouse Direct đang ở $125.99 (FBA) — thấp nhất bảng" },
    ],
  },
  "VPN-220-PRO": {
    sku: "VPN-220-PRO", asin: "B0B2X77L", shop: "Shop A1 · US",
    history: [
      { date: "11/09", myPrice: 89.00, buyBoxPrice: 84.99, lowestCompetitor: 84.99 },
      { date: "10/09", myPrice: 89.00, buyBoxPrice: 85.99, lowestCompetitor: 85.99 },
      { date: "09/09", myPrice: 89.00, buyBoxPrice: 87.50, lowestCompetitor: 86.00 },
      { date: "08/09", myPrice: 89.00, buyBoxPrice: 89.00, lowestCompetitor: 89.00 },
      { date: "07/09", myPrice: 89.00, buyBoxPrice: 89.00, lowestCompetitor: 89.00 },
      { date: "06/09", myPrice: 89.00, buyBoxPrice: 89.00, lowestCompetitor: 89.00 },
      { date: "05/09", myPrice: 89.00, buyBoxPrice: 89.00, lowestCompetitor: 89.99 },
    ],
    offers: [
      { sellerId: "ME", sellerLabel: "VEXIM (chúng tôi)", isMe: true, fulfillment: "FBA", price: 89.00, shipping: 0, landedPrice: 89.00, rating: null, feedbackCount: null, isFeatured: false, condition: "New" },
      { sellerId: "S1", sellerLabel: "KitchenPro Deals", isMe: false, fulfillment: "FBA", price: 84.99, shipping: 0, landedPrice: 84.99, rating: 4.8, feedbackCount: 15204, isFeatured: true, condition: "New" },
      { sellerId: "S2", sellerLabel: "HomeGoods US", isMe: false, fulfillment: "FBA", price: 86.95, shipping: 0, landedPrice: 86.95, rating: 4.5, feedbackCount: 3200, isFeatured: false, condition: "New" },
    ],
    fees: {
      cogs: 45.00, referralFeeRate: 15, referralFeeAmount: 13.35, fbaFee: 10.20, otherFees: 0, minMarginRate: 10, minMarginAmount: 8.90, floorPrice: 72.10,
    },
    alerts: [
      { tone: "red", text: "Mất box từ 09/09 sau khi KitchenPro Deals hạ từ $89 → $84.99" },
      { tone: "green", text: "Giá sàn $72.10 — còn biên điều chỉnh để giành lại box (xuống $84.99 → biên 15.1%)" },
    ],
  },
};

/** P3 — hàng chờ duyệt giá */
export const priceApprovalQueue: PriceApprovalItem[] = [
  {
    id: "APR-001", sku: "XMO-950-BLK", asin: "B0C7T31F", shop: "A1",
    oldPrice: 129.99, newPrice: 127.49, deltaPct: -1.9,
    reason: "Theo FOEP để giữ box (Amazon.com đang ở $127.49)",
    source: "auto", requestedBy: "Hệ thống (rule: giữ box)", requestedAt: "11/09 06:00",
    minMarginAfter: 19.7, belowFloor: false,
  },
  {
    id: "APR-002", sku: "VPN-220-PRO", asin: "B0B2X77L", shop: "A1",
    oldPrice: 89.00, newPrice: 84.99, deltaPct: -4.5,
    reason: "Giành lại Buy Box từ KitchenPro Deals ($84.99) — đã mất box 2 ngày",
    source: "manual", requestedBy: "Minh (Vận hành)", requestedAt: "11/09 08:32",
    minMarginAfter: 15.1, belowFloor: false,
  },
  {
    id: "APR-003", sku: "AQR-12-TOW", asin: "B0D1Q88A", shop: "C2",
    oldPrice: 19.99, newPrice: 18.49, deltaPct: -7.5,
    reason: "Đối thủ BeddingsCo hạ $17.99 — thử theo FOEP để giành lại box",
    source: "auto", requestedBy: "Hệ thống (rule: mất box > 24h)", requestedAt: "11/09 04:15",
    minMarginAfter: 27.5, belowFloor: false,
  },
  {
    id: "APR-004", sku: "XMO-951-ACC", asin: "B0D88C001", shop: "A1",
    oldPrice: 24.99, newPrice: 26.49, deltaPct: 6.0,
    reason: "Nâng về trên giá sàn (đang biên âm −2.4% do phí FBA tăng)",
    source: "manual", requestedBy: "Minh (Vận hành)", requestedAt: "11/09 09:05",
    minMarginAfter: 3.4, belowFloor: false,
  },
  {
    id: "APR-005", sku: "DRF-300", asin: "B0A9F14M", shop: "A2",
    oldPrice: 45.50, newPrice: 44.99, deltaPct: -1.1,
    reason: "Theo FOEP $43.99 — giảm nhẹ để ở ngưỡng an toàn",
    source: "auto", requestedBy: "Hệ thống (rule: at-risk)", requestedAt: "11/09 07:00",
    minMarginAfter: 29.3, belowFloor: false,
  },
  {
    id: "APR-006", sku: "VPN-FILT-3", asin: "B0B77K099", shop: "A1",
    oldPrice: 12.99, newPrice: 13.99, deltaPct: 7.7,
    reason: "Giá vốn + phí tăng — dưới sàn $13.20, cần nâng",
    source: "manual", requestedBy: "Trưởng phòng", requestedAt: "11/09 08:10",
    minMarginAfter: 5.6, belowFloor: false,
  },
  {
    id: "APR-007", sku: "KCH-118-W", asin: "B0C4K52D", shop: "C2",
    oldPrice: 79.99, newPrice: 78.99, deltaPct: -1.3,
    reason: "Đối thủ HomeEase vào $79.50 — giữ vị trí box",
    source: "auto", requestedBy: "Hệ thống", requestedAt: "11/09 05:30",
    minMarginAfter: 28.7, belowFloor: false,
  },
  {
    id: "APR-008", sku: "XMO-950-BLU", asin: "B0C7T31G", shop: "A1",
    oldPrice: 129.99, newPrice: 128.99, deltaPct: -0.8,
    reason: "Match đối thủ TopBag $129.00",
    source: "auto", requestedBy: "Hệ thống", requestedAt: "11/09 07:45",
    minMarginAfter: 20.6, belowFloor: false,
  },
];

/* ---------- Module 6 — Tài chính & Đối soát (F1–F2) ---------- */
import type {
  FinancialEventRow,
  FinancialEventType,
  SettlementDetailMock,
  SettlementRow,
} from "@/lib/types";

/** F1 — Danh sách kỳ settlement (mỗi shop, 2 kỳ gần nhất để demo) */
export const settlementList: SettlementRow[] = [
  {
    id: "12948510001", shop: "A1",
    depositDate: "09/09/2026", startDate: "27/08/2026", endDate: "09/09/2026",
    status: "deposited",
    sales: 62_840.50, refunds: -3_120.30,
    amazonFeesTotal: -9_340.10,
    advertisingFees: -4_860.20,
    otherCharges: 430.10,
    transferAmount: 42_950.00,
    currency: "USD",
    accountDeposit: "VEXIM LLC · Chk ****4218",
  },
  {
    id: "12948508001", shop: "C2",
    depositDate: "09/09/2026", startDate: "27/08/2026", endDate: "09/09/2026",
    status: "deposited",
    sales: 18_240.90, refunds: -720.40,
    amazonFeesTotal: -2_810.50,
    advertisingFees: -1_310.10,
    otherCharges: 120.00,
    transferAmount: 13_520.00,
    currency: "USD",
    accountDeposit: "VEXIM LLC · Chk ****4218",
  },
  {
    id: "12948507001", shop: "A2",
    depositDate: "06/09/2026", startDate: "24/08/2026", endDate: "06/09/2026",
    status: "deposited",
    sales: 6_820.40, refunds: -210.00,
    amazonFeesTotal: -1_050.20,
    advertisingFees: -410.30,
    otherCharges: -80.00,
    transferAmount: 5_070.00,
    currency: "USD",
    accountDeposit: "VEXIM LLC · Chk ****4218",
  },
  {
    id: "OPEN-A1", shop: "A1",
    depositDate: "—", startDate: "10/09/2026", endDate: "đang mở",
    status: "open",
    sales: 4_820.40, refunds: -180.20,
    amazonFeesTotal: -720.80,
    advertisingFees: -380.40,
    otherCharges: 0,
    transferAmount: 0,
    currency: "USD",
    accountDeposit: "chưa đóng kỳ",
  },
  {
    id: "12948498001", shop: "A1",
    depositDate: "26/08/2026", startDate: "13/08/2026", endDate: "26/08/2026",
    status: "deposited",
    sales: 58_120.00, refunds: -2_840.00,
    amazonFeesTotal: -8_710.00,
    advertisingFees: -4_420.00,
    otherCharges: 210.00,
    transferAmount: 39_360.00,
    currency: "USD",
    accountDeposit: "VEXIM LLC · Chk ****4218",
  },
  {
    id: "12948497001", shop: "C2",
    depositDate: "26/08/2026", startDate: "13/08/2026", endDate: "26/08/2026",
    status: "deposited",
    sales: 15_980.00, refunds: -540.00,
    amazonFeesTotal: -2_470.00,
    advertisingFees: -1_180.00,
    otherCharges: 80.00,
    transferAmount: 11_870.00,
    currency: "USD",
    accountDeposit: "VEXIM LLC · Chk ****4218",
  },
  {
    id: "12948496001", shop: "A2",
    depositDate: "23/08/2026", startDate: "10/08/2026", endDate: "23/08/2026",
    status: "deposited",
    sales: 6_120.00, refunds: -240.00,
    amazonFeesTotal: -950.00,
    advertisingFees: -360.00,
    otherCharges: 0,
    transferAmount: 4_570.00,
    currency: "USD",
    accountDeposit: "VEXIM LLC · Chk ****4218",
  },
];

/** F1 — Chi tiết 1 kỳ settlement (A1 kỳ gần nhất) */
export const settlementDetails: Record<string, SettlementDetailMock> = {
  "12948510001": {
    id: "12948510001", shop: "Shop A1 · US",
    depositDate: "09/09/2026", startDate: "27/08/2026", endDate: "09/09/2026",
    transferAmount: 42_950.00,
    accountDeposit: "VEXIM LLC · Checking ****4218 (Bank of America)",
    currency: "USD",
    groups: [
      {
        label: "Product sales (chưa gồm ship/gift wrap)",
        amount: 58_240.20, tone: "up",
        children: [
          { label: "Amazon.com (AFN — FBA)", amount: 56_840.20 },
          { label: "Amazon.com (MFN — tự ship)", amount: 1_400.00 },
        ],
      },
      { label: "Shipping credits", amount: 1_240.30, tone: "up" },
      { label: "Gift wrap credits", amount: 42.00, tone: "up" },
      { label: "Promotional rebates", amount: -682.00, tone: "down" },
      { label: "Refunds (chưa gồm phí hoàn lại)", amount: -3_120.30, tone: "down" },
      {
        label: "Amazon Fees",
        amount: -9_340.10, tone: "down",
        children: [
          { label: "Referral fee (15%)", amount: -6_120.40 },
          { label: "FBA fulfillment fee", amount: -2_540.80 },
          { label: "Variable closing fee", amount: -18.90 },
          { label: "Monthly storage fee", amount: -540.00 },
          { label: "High-volume listing fee", amount: -120.00 },
        ],
      },
      { label: "Advertising (SP/SD/SB)", amount: -4_860.20, tone: "down" },
      { label: "FBA Inventory Reimbursement", amount: 324.00, tone: "up" },
      { label: "Adjustments (SAFE-T / customer tax)", amount: 106.10, tone: "flat" },
      { label: "Reserve held (previous reserve release)", amount: 0, tone: "flat" },
    ],
    skuBreakdown: [
      { sku: "XMO-950-BLK", quantity: 112, productSales: 14_558.88, amazonFees: -3_640.20, net: 8_240.00 },
      { sku: "XMO-950-BLU", quantity: 78, productSales: 10_139.22, amazonFees: -2_538.00, net: 5_760.00 },
      { sku: "VPN-220", quantity: 142, productSales: 8_505.80, amazonFees: -2_129.00, net: 4_810.00 },
      { sku: "VPN-220-PRO", quantity: 52, productSales: 4_628.00, amazonFees: -1_158.00, net: 2_620.00 },
      { sku: "XMO-951-ACC", quantity: 210, productSales: 5_247.90, amazonFees: -1_314.00, net: 2_980.00 },
      { sku: "VPN-FILT-3", quantity: 340, productSales: 4_416.60, amazonFees: -1_106.00, net: 2_510.00 },
    ],
  },
};

/** F2 — Dòng tài chính chi tiết (financial events) */
const eventTypeLabels: Record<FinancialEventType, string> = {
  ProductSale: "Product sale",
  ShippingCredit: "Shipping credit",
  Refund: "Refund",
  ReferralFee: "Referral fee",
  FBAFee: "FBA fulfillment fee",
  StorageFee: "Storage fee",
  AdvertisingFee: "Ad spend",
  Reimbursement: "FBA reimbursement",
  Adjustment: "Adjustment",
  ServiceFee: "Service fee",
  Subscription: "Pro subscription",
  Reserve: "Reserve hold/release",
  Transfer: "Chuyển về ngân hàng",
  PromotionRebate: "Promotional rebate",
};

export const financialEvents: FinancialEventRow[] = [
  { id: "FE-1", postedAt: "09/09 18:42", shop: "A1", type: "ProductSale", typeLabel: eventTypeLabels.ProductSale, description: "Order 113-5541209-1140233 · XMO-950-BLK ×1", orderId: "113-5541209-1140233", sku: "XMO-950-BLK", amount: 29.99, settlementId: "OPEN-A1" },
  { id: "FE-2", postedAt: "09/09 18:42", shop: "A1", type: "ReferralFee", typeLabel: eventTypeLabels.ReferralFee, description: "Order 113-5541209-1140233", orderId: "113-5541209-1140233", sku: "XMO-950-BLK", amount: -4.50, settlementId: "OPEN-A1" },
  { id: "FE-3", postedAt: "09/09 18:42", shop: "A1", type: "FBAFee", typeLabel: eventTypeLabels.FBAFee, description: "Order 113-5541209-1140233", orderId: "113-5541209-1140233", sku: "XMO-950-BLK", amount: -5.20, settlementId: "OPEN-A1" },
  { id: "FE-4", postedAt: "09/09 17:50", shop: "A1", type: "ProductSale", typeLabel: eventTypeLabels.ProductSale, description: "Order 111-8890123-9987110 · XMO-950-BLK ×2", orderId: "111-8890123-9987110", sku: "XMO-950-BLK", amount: 59.98, settlementId: "OPEN-A1" },
  { id: "FE-5", postedAt: "09/09 17:50", shop: "A1", type: "ReferralFee", typeLabel: eventTypeLabels.ReferralFee, description: "Order 111-8890123-9987110", orderId: "111-8890123-9987110", amount: -9.00, settlementId: "OPEN-A1" },
  { id: "FE-6", postedAt: "09/09 14:02", shop: "C2", type: "ProductSale", typeLabel: eventTypeLabels.ProductSale, description: "Order 112-7710455-2205641 · KCH-118-W ×1", orderId: "112-7710455-2205641", sku: "KCH-118-W", amount: 79.99, settlementId: "OPEN-C2" },
  { id: "FE-7", postedAt: "09/09 14:02", shop: "C2", type: "ReferralFee", typeLabel: eventTypeLabels.ReferralFee, description: "Order 112-7710455-2205641", orderId: "112-7710455-2205641", amount: -12.00, settlementId: "OPEN-C2" },
  { id: "FE-8", postedAt: "09/09 12:30", shop: "A1", type: "AdvertisingFee", typeLabel: eventTypeLabels.AdvertisingFee, description: "Daily Sponsored Products accrual (09/09)", amount: -312.40 },
  { id: "FE-9", postedAt: "09/09 11:15", shop: "A1", type: "Reimbursement", typeLabel: eventTypeLabels.Reimbursement, description: "FBA reimbursement claim CR-1023 · 18 units XMO-950-BLK lost at FC ONT8", sku: "XMO-950-BLK", amount: 324.00 },
  { id: "FE-10", postedAt: "09/09 09:01", shop: "A1", type: "Refund", typeLabel: eventTypeLabels.Refund, description: "Return 113-2201455-8890012 · XMO-950-BLK ×1", orderId: "113-2201455-8890012", sku: "XMO-950-BLK", amount: -29.99 },
  { id: "FE-11", postedAt: "09/09 06:00", shop: "A1", type: "AdvertisingFee", typeLabel: eventTypeLabels.AdvertisingFee, description: "Daily Sponsored Brands + Display accrual (08/09)", amount: -120.10 },
  { id: "FE-12", postedAt: "08/09 22:10", shop: "A2", type: "ProductSale", typeLabel: eventTypeLabels.ProductSale, description: "Order 112-3309881-4471205 · DRF-300 ×1", orderId: "112-3309881-4471205", sku: "DRF-300", amount: 34.99, settlementId: "12948507001" },
  { id: "FE-13", postedAt: "08/09 18:05", shop: "A1", type: "Adjustment", typeLabel: eventTypeLabels.Adjustment, description: "SAFE-T claim reimbursement FBM order 110-9901122-3344556", orderId: "110-9901122-3344556", amount: 18.20 },
  { id: "FE-14", postedAt: "08/09 13:45", shop: "A1", type: "StorageFee", typeLabel: eventTypeLabels.StorageFee, description: "Monthly storage fee — August 2026", amount: -540.00, settlementId: "12948510001" },
  { id: "FE-15", postedAt: "08/09 03:00", shop: "A1", type: "ServiceFee", typeLabel: eventTypeLabels.ServiceFee, description: "High-volume listing fee (per ASIN >100k listings, pro-rated)", amount: -120.00, settlementId: "12948510001" },
  { id: "FE-16", postedAt: "06/09 00:00", shop: "A1", type: "Subscription", typeLabel: eventTypeLabels.Subscription, description: "Professional selling plan subscription — monthly", amount: -39.99 },
];

export const eventTypeFilters: { id: FinancialEventType | "all"; label: string }[] = [
  { id: "all", label: "Tất cả" },
  { id: "ProductSale", label: "Product sales" },
  { id: "Refund", label: "Refunds" },
  { id: "ReferralFee", label: "Referral fees" },
  { id: "FBAFee", label: "FBA fees" },
  { id: "AdvertisingFee", label: "Ad spend" },
  { id: "Reimbursement", label: "Reimbursements" },
  { id: "StorageFee", label: "Storage fees" },
  { id: "Adjustment", label: "Adjustments" },
  { id: "PromotionRebate", label: "Promotional rebates" },
  { id: "Transfer", label: "Chuyển tiền về NH" },
];

/* ---------- Notifications chuông (theo persona) ---------- */
import type { Department, NotificationItem, Profile, AppRole } from "@/lib/types";
import { ROLE_LABEL } from "@/lib/types";

/**
 * Chuông thông báo — trả về theo persona đang đăng nhập.
 * Ở DEMO MODE số `bell` trong PERSONAS khớp với số phần tử mảng.
 * Khi có Supabase: query bảng `notifications` (realtime qua presence channel).
 */
export const notificationsByPersona: Record<string, NotificationItem[]> = {
  ceo: [
    {
      id: "N1", tone: "red", icon: "💲", title: "6 SKU dưới giá sàn",
      detail: "XMO-951-ACC đang biên âm −2.4% sau khi đối thủ hạ giá",
      time: "12 phút trước", href: "/pricing?margin=below_floor", read: false, category: "alert",
    },
    {
      id: "N2", tone: "red", icon: "📦", title: "3 SKU sắp hết hàng (cover 5–8 ngày)",
      detail: "Shop A1 · XMO-950-BLK, VPN-220, XMO-950-WHT — ~$410/ngày nếu đứt",
      time: "28 phút trước", href: "/fulfillment/inventory", read: false, category: "alert",
    },
    {
      id: "N3", tone: "red", icon: "🛡️", title: "Account Health vàng — 1 vi phạm IP chưa khiếu nại",
      detail: "Shop C2 · case CS-10238741 · rủi ro khóa shop",
      time: "1 giờ trước", href: "/health/violations", read: false, category: "alert",
    },
    {
      id: "N4", tone: "amber", icon: "✅", title: "12 đề xuất áp giá chờ duyệt",
      detail: "8 đề xuất ≤2% operator tự duyệt · 4 đề xuất cần trưởng phòng",
      time: "2 giờ trước", href: "/pricing/approve", read: false, category: "approval",
    },
    {
      id: "N5", tone: "amber", icon: "💬", title: "4 đơn FBM chờ xác nhận",
      detail: "Còn 3 giờ trước hạn ship",
      time: "3 giờ trước", href: "/orders/fbm", read: false, category: "alert",
    },
    {
      id: "N6", tone: "amber", icon: "📈", title: "2 campaign hết budget trước 18h hôm qua",
      detail: "Đang mất cơ hội đơn — kiểm tra PPC",
      time: "8 giờ trước", href: "/ppc", read: true, category: "alert",
    },
    {
      id: "N7", tone: "green", icon: "🏦", title: "Kỳ settlement $42,950 đã chuyển",
      detail: "Shop A1 · kỳ 27/08–09/09 · về tài khoản ****4218",
      time: "hôm qua", href: "/finance/settlements", read: true, category: "system",
    },
  ],
  lead_fulfill: [
    {
      id: "F1", tone: "red", icon: "📦", title: "3 SKU sắp hết hàng",
      detail: "XMO-950-BLK cover 5 ngày",
      time: "28 phút trước", href: "/fulfillment/inventory", read: false, category: "alert",
    },
    {
      id: "F2", tone: "amber", icon: "🚚", title: "Lô FBA15G…9DLP đang nhận tại FC LAX9",
      detail: "ETA 1 ngày",
      time: "1 giờ trước", href: "/fulfillment/inbound", read: false, category: "system",
    },
  ],
  op_ppc: [
    { id: "P1", tone: "amber", icon: "📈", title: "2 campaign hết budget sớm", detail: "XMO-950 Exact ACOS 34% 3 ngày liên tiếp", time: "1 giờ trước", href: "/ppc", read: false, category: "alert" },
  ],
  client: [],
};

/* ---------- Trang cá nhân ---------- */
export const profileByPersona: Record<string, Profile> = {
  ceo: {
    name: "Nguyễn Hải Anh", email: "haianh@vexim.vn", role: ROLE_LABEL.super_admin,
    department: "Điều phối", phone: "+84 912 345 678", avatarInitials: "NA",
    joinedAt: "01/03/2024", lastLogin: "11/09/2026 13:40", mfaEnabled: true,
  },
  lead_fulfill: {
    name: "Trần Mỹ Linh", email: "mylinh@vexim.vn", role: ROLE_LABEL.dept_lead,
    department: "Kho vận & FBA", phone: "+84 988 765 432", avatarInitials: "MT",
    joinedAt: "15/05/2024", lastLogin: "11/09/2026 08:15", mfaEnabled: true,
  },
  op_ppc: {
    name: "Lê Tuấn", email: "tuan@vexim.vn", role: ROLE_LABEL.operator,
    department: "Quảng cáo (PPC)", phone: "+84 904 111 222", avatarInitials: "TQ",
    joinedAt: "02/01/2025", lastLogin: "11/09/2026 09:02", mfaEnabled: false,
  },
  client: {
    name: "Đại diện Doanh nghiệp A", email: "contact@khacha-a.vn", role: ROLE_LABEL.client_viewer,
    department: "—", phone: "—", avatarInitials: "DA",
    joinedAt: "10/08/2026", lastLogin: "09/09/2026 16:30", mfaEnabled: false,
  },
};

/* ---------- Tạo user mới (danh mục) ---------- */
export const DEPARTMENTS: Department[] = [
  "Điều phối",
  "Vận hành & Health",
  "Listing & Nội dung",
  "Quảng cáo (PPC)",
  "Kho vận & FBA",
  "Đơn hàng & CSKH",
  "Tài chính & Đối soát",
];

export const APP_ROLES: { id: AppRole; label: string; level: number; desc: string; canAssignTo: AppRole[] }[] = [
  {
    id: "super_admin", label: ROLE_LABEL.super_admin, level: 100,
    desc: "Toàn quyền hệ thống VEXIM — thấy mọi shop, mọi module, mọi hành động. Chỉ dành cho 1–2 người sáng lập/CTO.",
    canAssignTo: ["super_admin", "org_admin", "dept_lead", "operator", "analyst", "client_viewer"],
  },
  {
    id: "org_admin", label: ROLE_LABEL.org_admin, level: 80,
    desc: "Admin một doanh nghiệp/khách hàng (nhóm shop). Quản lý nhân viên, shop, xem toàn bộ dữ liệu của org đó.",
    canAssignTo: ["dept_lead", "operator", "analyst", "client_viewer"],
  },
  {
    id: "dept_lead", label: ROLE_LABEL.dept_lead, level: 50,
    desc: "Trưởng phòng — duyệt thao tác rủi ro (đổi giá >2%, ngân sách ads…), quản lý nhân viên trong phòng.",
    canAssignTo: ["operator", "analyst"],
  },
  {
    id: "operator", label: ROLE_LABEL.operator, level: 30,
    desc: "Nhân viên vận hành — đọc + ghi trên shop/module được gán.",
    canAssignTo: [],
  },
  {
    id: "analyst", label: ROLE_LABEL.analyst, level: 20,
    desc: "Chỉ đọc, xuất báo cáo. Không thao tác ghi.",
    canAssignTo: [],
  },
  {
    id: "client_viewer", label: ROLE_LABEL.client_viewer, level: 10,
    desc: "Khách hàng (client) — chỉ đọc shop của mình, không thấy nội bộ VEXIM.",
    canAssignTo: [],
  },
];

export const SHOPS = ["A1 · US", "A2 · MX", "B1 · DE", "C2 · US", "D1 · US", "E3 · CA"];
