# Module 8 (Product Research) — Tài liệu vận hành

> Phiên bản **G1–G7**, cập nhật **16/09/2026**. Tài liệu này mô tả luồng vận
> hành hằng ngày của module Thẩm định R&D sản phẩm: ai làm gì, bấm ở đâu,
> dữ liệu đi qua những bước nào, nhân viên review nội dung ở màn hình nào,
> và cảnh báo chi phí Rainforest/Keepa. Không cần code lên hệ thống để đọc
> tài liệu này — mọi thao tác của nhân viên đều trên giao diện web.

---

## 1. Module này làm gì

Một nhân viên R&D nhập ý tưởng sản phẩm (từ khoá tìm kiếm trên Amazon, ASIN
hạt giống, thị trường) → hệ thống tự thu thập dữ liệu đối thủ qua Rainforest
API, chấm điểm cạnh tranh, trích điểm đau khách hàng từ review, tính P&L 3
kịch bản, dựng báo cáo thẩm định. Người soát (trưởng phòng/người duyệt) đọc
trên web, kiểm lại các cảnh báo và xuất bản in (Print → PDF của trình duyệt
ở v1; PDF server tự động để giai đoạn sau).

Nguyên tắc bất biến: **"chưa đủ cơ sở" thì hệ thống không bịa số**; mọi ước
tính (sales từ BSR sai số 20–40%, phí FBA bảng ước lượng) đều được gắn nhãn
nguồn + độ tin cậy; **veto đỏ chỉ được xác nhận (ack), không ai được gỡ trên
giao diện**.

## 2. Các vai trò

| Vai trò | Được làm gì |
|---|---|
| **analyst** (nhân viên R&D) | Tạo assessment, chạy thu thập, nhập/sửa narrative trên editor, in báo cáo |
| **dept_lead** (trưởng phòng) | Mọi quyền của analyst + duyệt/ack veto đỏ, chốt assessment |
| **admin** | Toàn quyền; theo dõi chi tiêu credits của cả tổ chức |
| **client_viewer / user thường** | Không truy cập được dữ liệu research (chặn ở RLS database) |

Phân quyền nằm ở **database (RLS + RPC `security definer`)**, không phải ở web;
web không dùng `service_role` cho thao tác theo phiên người dùng.

## 3. Luồng vận hành end-to-end

### Bước 1 — Tạo đề xuất (analyst)

1. Vào menu **Nghiên cứu → `/research`**, bấm tạo mới.
2. Trang **`/research/new`** điền: tên sản phẩm/ngách, marketplace (hiện hỗ
   trợ chính US), từ khoá tìm kiếm, ASIN hạt giống (nếu có), giá dự kiến, chi
   phí mục tiêu. Form nhập liệu và màn phân tích là **2 trang riêng**.
3. Máy tính what-if tính P&L ngay tại chỗ để loại sớm ý tưởng lỗ.

### Bước 2 — Thu thập dữ liệu (worker tự động)

- Khi tạo, hệ thống xếp các **collection run** vào hàng đợi (`research.collection_runs`):
  `serp → products → offers → sales → reviews → analyze`.
- Worker chạy qua:
  - **Cron Vercel**: `GET /api/cron/research-collect`, lịch `17 4 * * *` UTC
    (00:07 giờ VN — khai báo trong `web/vercel.json`), gọi kèm `CRON_SECRET`.
  - Chạy tay trên VPS dev: gọi đúng endpoint cron với header
    `Authorization: Bearer <CRON_SECRET>`.
- Hai cách lấy dữ liệu (xem chi tiết ở
  `docs/module-8-runbook-chay-thu-rainforest-dau-tien.md`):
  - **DIRECT đồng bộ** (khuyến nghị): worker gọi Rainforest và ghi ngay.
  - **Collection bất đồng bộ qua webhook** (`/api/webhooks/rainforest`): dùng
    khi lô lớn; webhook phải kèm `RAINFOREST_WEBHOOK_SECRET`.

### Bước 3 — Engine chấm điểm & trích pain (tự động)

- Sau bước `products`: engine thuần trong `web/src/lib/research/domain/` chạy:
  - CR3/CR5/CR10, HHI theo doanh thu ước lượng, phát hiện Amazon 1P, mật độ
    sponsored, rào review, vận tốc review giữa 2 lần quét;
  - **trụ cạnh tranh/demand** (thang 1–10); thiếu dữ liệu là `null` kèm lý do;
  - **veto đỏ** (CR3 > 65%, Amazon 1P chiếm top 3…).
- Bước `analyze`: LLM **gpt-4.1-mini** map/reduce review critical → cụm điểm
  đau → trích dẫn nguyên văn; rồi sinh narrative các chương. Mọi lời LLM đều
  là **bản nháp chờ người soát**, không tự khoá.

### Bước 4 — Nhân viên review nội dung (analyst → dept_lead) — MÀN HÌNH CHÍNH

Tất cả review nội dung làm tại **trang chi tiết `/research/[id]`** (và trình
sửa văn bản `/research/[id]/editor`):

| Khu vực trên màn hình | Nội dung cần người đọc |
|---|---|
| Tab **Tổng quan/P&L** | Đối chiếu giả định đầu vào, đọc 3 kịch bản; chỗ nào là phí FBA Ước lượng (`FBA-US-2026-approx`) cần ghi chú khi trình khách |
| Tab **Cạnh tranh** (`MarketConcentrationPanel`) | CR3/CR5/HHI, thị phần brand, veto đỏ, ghi chú "sales suy từ BSR sai 20–40%" |
| Tab **Điểm đau khách hàng** | Các cụm pain + trích dẫn nguyên văn + link review gốc; kiểm trích dẫn có đúng ngữ cảnh không trước khi đưa vào báo cáo |
| Tab **Mùa vụ & BSR (G7)** (`SeasonalityPanel`) | Xem mục 5 dưới đây |
| Tab **Ngân sách credits (G7)** (`CreditBudgetPanel`) | Xem mục 6 dưới đây |
| **Editor narrative** (`/research/[id]/editor`) | Sửa/chấp nhận bản nháp LLM cho từng chương (`mkt_definition`, `mkt_toplist`, `mkt_share`, `mkt_structure`, `mkt_conclusion`…) |
| **Báo cáo in** (`/research/[id]/report`) | Bản trình bày cuối; nhân viên bấm **Ctrl+P → Lưu thành PDF** ở v1 |

Quy tắc review:

1. Mọi con số ước tính phải còn nguyên nhãn nguồn + ngày khi in.
2. **Veto đỏ**: dept_lead chỉ bấm **ack/ghi nhận**; không có nút xoá veto. Muốn
   đi tiếp phải có quyết định ngoài hệ thống được lưu bằng narrative.
3. Chỗ nào ghi "chưa đủ cơ sở" thì **không được điền số thay thế** trên editor;
   có thể bổ sung lần quét sau (lịch sử BSR cần nhiều lần quét mới đủ).

### Bước 5 — Hoàn tất & bàn giao

- In báo cáo từ `/research/[id]/report` (Print CSS đã định sẵn khổ A4, gồm cả
  phụ lục mùa vụ G7).
- PDF server render 1 chạm (Playwright/Chromium + `ops.client_reports` +
  Client Portal) **chưa làm trong giai đoạn này** — sẽ triển khai trên
  worker/VPS riêng (Chromium không chạy được trên serverless).

## 4. Hai chế độ chạy dữ liệu

- **DEMO mode**: khi 3 biến `NEXT_PUBLIC_SUPABASE_*` để trống, web dùng
  `MockIntelligenceProvider`/`MockKeepaProvider` — số liệu mô phỏng, luôn gắn
  nhãn DEMO trên UI. Dùng để demo, không phải thị trường thật.
- **SUPABASE mode**: đặt đủ 3 biến Supabase + key Rainforest/LLM trên Vercel
  (xem runbook). Mọi ghi DB đi qua RPC `vexim_research_*` theo phiên đăng
  nhập; worker dùng `SUPABASE_SERVICE_ROLE_KEY` qua các RPC `…_worker_…`.

## 5. G7 — Mùa vụ & lịch sử BSR (cách dùng & cách vận hành)

**Mục tiêu**: biết tháng cao điểm/tháng thấp điểm để khuyến nghị lịch nhập
hàng (hàng về kho 8 tuần trước mùa).

**Nguồn dữ liệu** (bảng `research.bsr_history`, view đọc
`public.vexim_research_bsr_history`):

1. **Miễn phí từ Rainforest**: mỗi lần cron chạy lại một assessment, BSR tại
   thời điểm quét được lưu. Sau khi chấm điểm cạnh tranh, worker tự gọi
   `vexim_research_worker_refresh_bsr_from_snapshots` để dựng chuỗi từ snapshot
   (cả ở luồng DIRECT lẫn webhook). Vì vậy **phải quét lặp lại mỗi 7–14 ngày**;
   một lần quét không thể nói lên mùa vụ.
2. **Keepa (lịch sử nhiều năm, có phí ~€19/tháng)**:
   - Đặt `KEEPA_API_KEY` trên Vercel;
   - Bật `RESEARCH_KEEPA_BACKFILL=1` để worker nạp 365 ngày BSR (lô 50 ASIN/lần)
     ngay sau bước products. Mặc định **TẮT** (`0`) — chưa mua Keepa thì giữ
     nguyên.

**Ngưỡng engine** (không chỉnh trên UI, sửa ở `domain/seasonality.ts`):

- ≥12 điểm BSR, trải ≥56 ngày, ≥2 tháng có điểm mới nhận diện mùa vụ;
- độ lệch đỉnh/đáy ≥25% (tỉ lệ <0,75) mới coi là "có mùa rõ";
- cần ≥2 năm dữ liệu mới chấm độ tin cậy "cao"; 8–12 tháng là "vừa";
- dữ liệu mỏng hơn vẫn cho bảng BSR trung vị 30/90 ngày + xu hướng từng ASIN,
  nhưng không kết luận mùa vụ.

**Nhân viên đọc gì trên `SeasonalityPanel`**:

- 3 thẻ: tháng cao điểm, độ sâu mùa vụ (BSR đỉnh/đáy), độ tin cậy;
- khuyến nghị lịch nhập hàng (chốt đơn xưởng trước mùa 8 tuần);
- bảng từng ASIN: BSR hiện tại, trung vị 30/90 ngày, xu hướng (đi ngang/bán
  chạy hơn/chậm lại kèm R²), số điểm và số ngày trải.
- Bản in (`PrintSeasonality`) nằm ngay sau mục cấu trúc thị trường. Nếu chưa
  đủ dữ liệu, khối in ghi rõ "chưa đủ cơ sở" — không tự suy diễn.

## 6. G7 — Kiểm soát chi phí Rainforest

Hạ tầng đang dùng: **gói Starter annual 10.000 credits/tháng (~$66/tháng)**,
vượt tính $0,0118/credit. Quy ước: search/product/offers/sales/reviews =
1 credit/request; `include_products_count=N` tốn thêm N; tránh các tham số
nhân hệ số 2–3 (`variant_prices`, `include_html`, `import_fees`).

**Cơ chế chặn trong worker** (`research-collect.job.ts`, chạy TRƯỚC mỗi run):

| Mức | Biến môi trường | Mặc định | Hành vi |
|---|---|---|---|
| Cảnh báo nội bộ | `RESEARCH_CREDIT_BUDGET_MONTHLY` | `2000` | Ghi log cảnh báo, **vẫn chạy** |
| Trần chặn cứng | `RESEARCH_CREDIT_HARD_CAP_MONTHLY` | `10000` | Run đánh `failed` với lý do `[budget]…trần…`, **không gọi Rainforest** |
| Lỗi đọc sổ cái | — | — | Bỏ qua cảnh báo, cho chạy (không để lỗi thống kê chặn nhầm nghiệp vụ) |

Ước tính chi phí mỗi run: SERP = 1; products/offers/sales = 1 + 3×số ASIN;
reviews = số ASIN × số trang review. Con số tiêu thụ thực đọc từ bảng
`research.credit_ledger` qua RPC `vexim_research_credit_status(p_org, p_month)`
và view `public.vexim_research_credit_monthly`.

**Trên giao diện**: tab **Ngân sách credits** (`CreditBudgetPanel` ở
`/research/[id]`) hiển thị credits đã tiêu theo tháng, số lượt chạy, lần tiêu
gần nhất theo từng tổ chức; cảnh báo khi gần mức 2.000 và khi chạm trần. Admin
theo dõi đầu tháng để quyết định nâng gói hoặc tạm dừng bớt assessment.

Nếu worker báo `failed` vì budget: **không retry được trong tháng đó** cho tới
khi admin nâng biến `RESEARCH_CREDIT_HARD_CAP_MONTHLY` (redeploy) hoặc sang
tháng mới (sổ cái theo tháng tự reset).

## 7. Biến môi trường tóm tắt (đặt trên Vercel, KHÔNG commit)

| Biến | Bắt buộc | Ghi chú |
|---|---|---|
| `RAINFOREST_API_KEY` | cho thu thập thật | trial/starter |
| `RAINFOREST_WEBHOOK_SECRET`, `RAINFOREST_WEBHOOK_BASE_URL` | chỉ khi dùng Collection | |
| `LLM_PROVIDER` + key OpenAI | cho bước analyze | Model chốt: **gpt-4.1-mini** cho mọi bước map/reduce/narrative (`LLM_MODEL=gpt-4.1-mini`) |
| `NEXT_PUBLIC_SUPABASE_URL` / `ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase mode | để trống = DEMO |
| `CRON_SECRET` | cron | |
| `RESEARCH_CREDIT_BUDGET_MONTHLY` | nên đặt | mặc định 2000 (warn) |
| `RESEARCH_CREDIT_HARD_CAP_MONTHLY` | nên đặt | mặc định 10000 (block) |
| `KEEPA_API_KEY` | chỉ khi mua Keepa | trống = không backfill |
| `RESEARCH_KEEPA_BACKFILL` | | `1` mới nạp lịch sử Keepa; mặc định `0` |

Mẫu khai báo: `web/.env.example` và `web/.env.local.example`. File
`web/.env.local` được gitignore — **không bao giờ dán key thật vào chat/ticket;
key đã lộ phải revoke và tạo lại ngay**.

## 8. Lịch vận hành gợi ý

| Tần suất | Việc |
|---|---|
| Hàng ngày | Kiểm tra cron 04:17 UTC có chạy (log Vercel); review assessment mới ở `/research` |
| Mỗi 7–14 ngày | Chạy lại (re-scan) các assessment đang theo dõi để tích điểm BSR miễn phí |
| Khi mua Keepa | Đặt `KEEPA_API_KEY`, bật `RESEARCH_KEEPA_BACKFILL=1`, backfill một lượt rồi cân nhắc tắt để tiết kiệm |
| Cuối tháng | Admin xem `CreditBudgetPanel`/view `vexim_research_credit_monthly`: tổng credits, assessment nào tốn nhiều nhất, quyết định ngân sách tháng sau |
| Trước mùa cao điểm của ngách | Đối chiếu khuyến nghị "chốt đơn xưởng" trên `SeasonalityPanel` với kế hoạch mua hàng |

## 9. Xử lý sự cố thường gặp

| Triệu chứng | Nguyên nhân / cách xử lý |
|---|---|
| Run `failed [budget]…trần` | Đã vượt `RESEARCH_CREDIT_HARD_CAP_MONTHLY`; xem mục 6 |
| Tab mùa vụ báo "chưa đủ cơ sở" dù đã quét nhiều lần | Kiểm tra số điểm/ASIN trên panel; cần ≥12 điểm trải ≥8 tuần; hoặc bật Keepa backfill |
| BSR có điểm nhưng panel trống ở Supabase mode | Chạy lại RPC refresh (worker tự gọi sau products); kiểm tra view `vexim_research_bsr_history` và RLS theo org |
| Narrative LLM trống | Kiểm tra `LLM_PROVIDER`, key, số dư OpenAI; LLM lỗi không chặn thu thập — chạy lại riêng bước analyze |
| Webhook Rainforest 401 | Sai/thiếu `RAINFOREST_WEBHOOK_SECRET` hoặc base URL |
| Màn hình hiện dải băng "DEMO" | 3 biến Supabase đang để trống — đây là dữ liệu giả, không trình khách |
| Cấm mạng tới api ngoài trong preview Arena | Đúng thiết kế: chạy thật trên Vercel/VPS của VEXIM, không chạy trong sandbox |

## 10. Hạng mục còn để dành (không nằm trong G1–G7)

- PDF server render 1 chạm + lưu `ops.client_reports` + Client Portal
  (cần Playwright/Chromium trên worker riêng).
- Đa marketplace (hiện chủ yếu US; Keepa/Rainforest đã có mã domain UK/DE/FR/JP/CA).
- Yjs cộng tác nhiều người trên editor.
- Tự kiểm chứng key LLM/API còn hạn (nhân viên/admin tự cấu hình, không dán
  key vào kênh chat).
