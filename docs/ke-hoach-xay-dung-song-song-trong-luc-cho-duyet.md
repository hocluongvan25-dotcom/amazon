# KẾ HOẠCH XÂY DỰNG SONG SONG TRONG LÚC CHỜ AMAZON DUYỆT API

> Trả lời câu hỏi: *"Trong quá trình chờ API của Amazon thì có nên build luôn không, hay phải có API chính thức mới bắt tay vào làm hệ thống?"*
>
> **Câu trả lời: BUILD NGAY.** Chờ duyệt xong mới build = lãng phí thuần túy 2–8 tuần lịch. Tài liệu này chốt phương án, phân tầng công việc và điều kiện "cắm là chạy" cho hai bên thống nhất.

---

## 1. VÌ SAO KHÔNG ĐƯỢC CHỜ — 3 LÝ DO CỐT LÕI

### 1.1. Chờ duyệt và build phần nền mất cùng một khoảng thời gian → chạy song song gần như "miễn phí"

```
Kịch bản CHỜ:   [Amazon duyệt 2-8 tuần][────────── build 6-8 tuần──────────] → go-live tuần 10-16
Kịch bản SONG SONG:
                [Amazon duyệt 2-8 tuần]
                [──── build nền + UI + mock (6-8 tuần) ────] → duyệt xong là cắm shop thật → go-live tuần 8-10
```

Thời gian chờ duyệt nằm trên **đường găng (critical path)** của dự án nhưng **hoàn toàn không chặn** việc build. Chỉ có ~20–30% codebase (tầng gọi Amazon) thực sự cần credentials; 70–80% còn lại không phụ thuộc gì vào Amazon.

### 1.2. Amazon công khai toàn bộ "hợp đồng" của API trước khi có quyền truy cập

- Bộ **Swagger/OpenAPI models chính thức** của mọi SP-API được Amazon đăng công khai tại `github.com/amzn/selling-partner-api-models` → đội dev **generate typed client + biết chính xác cấu trúc dữ liệu ngay từ hôm nay**, không cần chờ duyệt, không phải đoán.
- **Sandbox là bước chuẩn trong onboarding** của Amazon (theo Onboarding as a Developer): đăng ký sandbox app → gọi thử sandbox trước khi setup OAuth production.
- Các **file mẫu báo cáo** (All Orders, Settlement, Sales & Traffic…) cũng công khai trong docs → viết parser trước được.

### 1.3. Kiến trúc đã thiết kế đúng kiểu "lắp sau" (adapter pattern)

Mục 3 tài liệu đề xuất đã tách **lớp kết nối Amazon** thành một tầng riêng. Ta triển khai nó dưới dạng interface với 3 implementation:

```
interface AmazonProvider { getOrders(); getInventory(); getListings(); getPricing();
                           getFinancialEvents(); getSellerPerformance(); getAdsMetrics(); ... }

MockProvider        ← dữ liệu giả deterministic — dùng từ ngày đầu, cho UI + logic
SandboxProvider     ← cấu hình sandbox SP-API — khi có sandbox app
ProductionProvider  ← credentials thật + LWA token seller — khi được duyệt & có shop pilot
```

Toàn bộ hệ thống (dashboard, alerts, tasks, RBAC, worker) code chống interface — **không có dòng nào "chờ API" mới viết được**.

### 1.4. Dứt điểm 3 hiểu lầm về trình tự "hồ sơ ↔ website ↔ build"

**Hiểu lầm 1 — "Xây xong rồi nộp 1 thể để được duyệt nhanh":** không tồn tại lựa chọn này. Amazon **không review phần mềm** của ta — hồ sơ được đánh giá trên thông tin công ty, website, use case, roles và câu trả lời PII. Đồng hồ duyệt (2–8 tuần) chạy từ lúc bấm submit → nộp muộn bao lâu thì go-live lùi bấy lâu, build xong trước không đổi được điều đó.

**Hiểu lầm 2 — "Phải có web chính thức (hệ thống) mới nộp được":** "Website" Amazon yêu cầu là **trang công khai mô tả dịch vụ ứng dụng** — không được "đang xây", không login-only — chứ **không phải hệ thống vận hành hoàn chỉnh**. Landing page `landing/index.html` đã dựng xong chính là trang này; chỉ cần VEXIM thay 4 thông tin thật + deploy HTTPS (~1 ngày) là đủ điều kiện nộp.

**Hiểu lầm 3 — "Chờ duyệt xong mới có API để test":** sai theo tài liệu chính thức của Amazon. Trình tự onboarding là: tạo Developer Profile (bước 3) → **ngay lập tức đăng ký Sandbox Application (bước 4)** — Amazon ghi rõ sandbox app *"lets you start testing API calls immediately, even while your developer profile is under review"*, có luôn LWA credentials và gọi được SP-API sandbox **không cần seller authorize**. Tức là nộp hồ sơ xong vài ngày là đội dev đã có "API thật bản sandbox" để test (Tier 2) — thứ duy nhất phải chờ duyệt là **production app + OAuth seller thật** (Tier 3).

---

## 2. PHÂN TẦNG CÔNG VIỆC THEO MỨC PHỤ THUỘC AMAZON

| Tầng | Phụ thuộc | Công việc | Thời điểm |
|------|-----------|-----------|-----------|
| **Tier 0 — 0% phụ thuộc** | Không cần gì từ Amazon | • Supabase: schema, RLS, Auth, RBAC 6 vai trò, Vault, pg_cron<br>• Next.js + design system + khung app + CI/CD<br>• **UI đầy đủ 8 dashboard** (chạy với MockProvider)<br>• Hệ alerts + alert_rules, tasks liên phòng, audit log<br>• Khung sync worker + hàng đợi + retry/backoff<br>• Module dữ liệu nội bộ: giá vốn, lead time, ngưỡng cảnh báo (nhập tay)<br>• Landing page (✅ đã xong) | Tuần 1 → làm ngay |
| **Tier 1 — build trước với mock/mẫu** | Chỉ cần Swagger models công khai | • Typed clients cho toàn bộ API mục 4.3 (generate từ Swagger)<br>• Parser các loại báo cáo (dùng file mẫu)<br>• Notification receiver (EventBridge webhook) — test bằng payload giả theo đúng schema Amazon<br>• Logic đồng bộ 3 tầng + đối soát (chạy với mock data)<br>• Contract tests: schema dữ liệu Amazon ↔ schema DB | Tuần 2–5 |
| **Tier 2 — cần sandbox app** | Sandbox SP-API | • End-to-end từng API (lưu ý: một số API chỉ có static sandbox, một số dynamic, không phải operation nào mô phỏng đủ như production)<br>• Xử lý lỗi thật, rate limit thật (token bucket theo header Amazon)<br>• OAuth flow test với state/redirect thật | Tuần 3–6 (khi có sandbox app) |
| **Tier 3 — cần được duyệt + shop thật** | Production approval + seller authorize | • "Kết nối Amazon" thật với shop pilot (OAuth LWA)<br>• Backfill 30 ngày + đăng ký notifications<br>• **Đối soát ≥ 99% với Seller Central trong 3 ngày liên tục**<br>• Pilot vận hành thật 2 tuần | Khi Amazon duyệt (dự kiến tuần 4–8) |

> **Nếu đến tuần 8 mà Amazon chưa duyệt xong:** đội dev không bao giờ rảnh — chuyển sang gia cố Tier 0–1 (e2e tests, hiệu năng, security review nội bộ, module tác vụ nội bộ đưa VEXIM dùng thử với quy trình thủ công + nhập liệu tay). Còn nếu duyệt sớm (tuần 4) thì rút ngắn lịch pilot tương ứng.

---

## 3. NHỮNG GÌ KHÔNG BUILD TRƯỚC (tránh tốn công đổ vỡ)

| Không làm | Lý do |
|-----------|-------|
| Module phụ thuộc PII/restricted (địa chỉ buyer, Buy Shipping, messaging) | Đã defer khỏi hồ sơ — không có ở bản đầu (decision v1.1) |
| Tối ưu hiệu năng cho quy mô lớn (hàng trăm shop) | Chưa có dữ liệu thật để đo; pilot 2–3 shop trước |
| Cho rằng mock = thật | MockProvider phải tách bạch tuyệt đối, đánh dấu rõ `data_source = mock` để không ai nhầm số liệu trong demo |
| Đóng băng thiết kế DB trước khi thấy dữ liệu thật | Giữ bảng raw JSONB + khả năng replay → khi có dữ liệu thật chỉ sửa tầng ETL, không sửa UI/dashboard |

## 4. KỊCH BẢN XẤU: NẾU AMAZON TỪ CHỐI HỒ SƠ THÌ CÔNG BUILD CÓ MẤT TRẮNG?

**Không.** Xét 3 trường hợp:

1. **Bị hỏi lại / yêu cầu bổ sung** (khả năng cao nhất): trả lời trong 5 ngày — không ảnh hưởng gì tiến độ build.
2. **Bị từ chối** (hiếm): nộp lại với chỉnh sửa. Toàn bộ Tier 0–1 vẫn nguyên giá trị — nền tảng không phụ thuộc việc duyệt.
3. **Trường hợp xấu nhất** (gần như không xảy ra với hồ sơ sạch, không-restricted): VEXIM vẫn có (a) nền tảng vận hành nội bộ + tác vụ liên phòng dùng ngay, (b) **Amazon Ads API duyệt riêng và thường nhanh hơn** — module quảng cáo vẫn lấy dữ liệu thật được, (c) luồng nhập báo cáo CSV thủ công làm phương án dự phòng trong khi khiếu nại.

## 5. ĐIỀU KIỆN "CẮM LÀ CHẠY" — DEFINITION OF READY TO PLUG

Checklist kiểm tra khi Amazon duyệt hồ sơ — hoàn thành đủ 6 mục là shop thật vào vận hành:

- ☐ ProductionProvider cấu hình xong, LWA credentials vào Vault (không bao giờ nằm trong code)
- ☐ OAuth authorize flow chạy thật với shop pilot của VEXIM (refresh token thu về, lưu Vault)
- ☐ Backfill 30 ngày (orders, inventory, listings, settlement) hoàn tất cho shop pilot
- ☐ Đăng ký notifications: ORDER_CHANGE, ANY_OFFER_CHANGED, REPORT_PROCESSING_FINISHED, ACCOUNT_STATUS_CHANGED
- ☐ **Đối soát 3 ngày liên tục: số liệu hệ thống khớp Seller Central ≥ 99%**
- ☐ 8 dashboard phòng ban đọc dữ liệu thật (bật/tắt cờ `data_source = production`)

## 6. PHÂN CÔNG THEO 2 LANE

| Tuần | Lane Amazon (PIC: Hải Anh) | Lane Dev (team phát triển) |
|------|---------------------------|----------------------------|
| 1 | Nộp Developer Profile + deploy landing page | Tier 0: Supabase + khung app + design system |
| 2–3 | Theo dõi case 2 lần/ngày, trả lời trong 24h | Tier 0 xong + Figma 8 dashboard duyệt + Tier 1 typed clients |
| 3–6 | (nếu mời) chuẩn bị demo architecture review | Tier 1: mock e2e + parser + worker · Tier 2: sandbox từng API |
| 4–8 | **Nhận duyệt** → tạo app, lấy credentials | Tier 3: cắm shop pilot → đối soát → pilot 2 tuần → onboarding các shop còn lại |

> **Nguyên tắc chốt:** mỗi ngày chờ không build là một ngày go-live lùi lại. Mỗi ngày build mà không theo hợp đồng API công khai (Swagger models) của Amazon là một ngày rủi ro làm lại. Kế hoạch này tránh cả hai.
