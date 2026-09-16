# KẾ HOẠCH XÂY DỰNG MODULE 8 — PRODUCT RESEARCH & THẨM ĐỊNH R&D SẢN PHẨM

> Ngày lập: 15/09/2026 · Trạng thái: **ĐỀ XUẤT — chờ VEXIM chốt trước khi code**
> Liên quan: `docs/ke-hoach-trien-khai-theo-module.md` (Module 0–7), `docs/ke-hoach-xay-dung-song-song-trong-luc-cho-duyet.md`
>
> **Lưu ý đặt tên:** mã "F4" trong hệ thống hiện tại ĐÃ được dùng cho màn *Lợi nhuận SKU* (Module 6 Tài chính, migration 0015). Module mới này là **MODULE 8 — PRODUCT RESEARCH (PR)**, route `/research`, schema `research.*`. Không dùng tên F4 để tránh nhầm trong tài liệu, menu và migration.

---

## 0. TÓM TẮT ĐIỀU HÀNH

1. **Tổ hợp dữ liệu:** Amazon SP-API (phí thật cho kịch bản tài chính) + **Rainforest API** (SERP đối thủ, offers/1P, sales estimation, review 1–3★) + **LLM** (gom điểm đau, soạn thảo nhận định) + engine tài chính có sẵn (`worker/src/domain/pricing.ts`, `finance.sku_profit_daily`, `catalog.cost_inputs`).
2. **Triết lý vận hành:** AI **soạn nháp và điền sẵn** báo cáo trên một Web Editor; chuyên viên VEXIM **sửa câu chữ, thẩm định từng phần, ký tên**; nút **Xuất PDF** chỉ mở khóa khi đủ chữ ký. Đây KHÔNG phải tính năng AI xuất PDF tự động gửi khách.
3. **Quyết định kiến trúc trọng tâm (trả lời câu hỏi VEXIM):** làm editor **dạng khối có cấu trúc (structured block canvas), KHÔNG phải Notion/Google Docs tự do trên toàn tài liệu** — xem mục 1.
4. **Lộ trình:** 7 giai đoạn, ~**11–12 người-tuần** với 1 fullstack (≈ 6–7 tuần nếu 2 người), trong đó **lát cắt tài chính (G1) chạy được sau 2 tuần** và hoàn toàn độc lập với Rainforest/LLM. Có thể bắt đầu NGAY bằng MockProvider + bản trial Rainforest 100 request, **không chặn bước duyệt Amazon Ads/SP-API**.
5. **Việc con người phải làm trước (G0):** kích hoạt Amazon Ads (đang chờ), đăng ký Rainforest trial tại `app.rainforestapi.com/signup` (100 request, không cần thẻ), tạo khóa LLM pay-as-you-go.

---

## 1. QUYẾT ĐỊNH KIẾN TRÚC TRỌNG TÂM: WEB EDITOR AI SOẠN NHÁP — CÓ, NHƯNG KHÔNG PHẢI NOTION TỰ DO

### 1.1. Vì sao mô hình "AI điền nháp → người thẩm định → xuất PDF" là BẮT BUỘC (không chỉ là lựa chọn UI)

| Lý do | Dẫn chứng từ chính hệ thống/dữ liệu |
|---|---|
| Dữ liệu đối thủ là **ước tính, sai số 20–40%** (sales estimation suy từ BSR) | Không một con số nào được phép trình khách như "sự thật kế toán" nếu chưa qua người soát |
| LLM có thể bịa số, gán nhãn sai quote | Mọi trích dẫn phải truy được về review gốc đã lưu trong DB |
| Báo cáo là **sản phẩm có chữ ký trách nhiệm** của agency | Đã có tiền lệ văn hóa: hàng đợi duyệt Ads (`ads.change_requests`: `pending_approval → approved`, `decided_by`, trigger guard ở migration 0021), `iam.audit_logs` append-only |
| Điểm bán hàng của VEXIM là dịch vụ thẩm định, không phải phần mềm dump PDF | Giá trị nằm ở phần chuyên viên **đổi nhận định, thêm hiểu biết nhà máy/thị trường, chịu trách nhiệm** |
| Khách (chủ doanh nghiệp) đọc 3 trang đầu rồi quyết định bỏ vốn | Câu kết luận và 3 lý do/3 rủi ro phải được người Việt viết lại cho đúng giọng, đúng khách |

### 1.2. Ba phương án editor

| | **A — Tài liệu tự do kiểu Notion/Google Docs** (BlockNote/TipTap full page) | **B — Khối có cấu trúc + vùng văn bản ràng buộc** ⭐ KHUYẾN NGHỊ | **C — Form tĩnh + template PDF** (không sửa được câu chữ trên web) |
|---|---|---|---|
| Cảm giác soạn thảo | Tự do nhất, kéo thả mọi thứ | Giống Notion ở các đoạn **nhận định**; bảng/biểu đồ/scorecard là **khối dựng sẵn** | Như điền biểu mẫu |
| Truy nguồn số liệu (traceability) | ❌ Người soát có thể gõ đè/sửa số mà hệ thống không phân biệt được số tính toán và số gõ tay | ✅ Khối số liệu **khóa theo snapshot**, có chip nguồn; muốn đổi phải đổi **giả định đầu vào** rồi tính lại | ✅ mặc nhiên |
| Chống LLM bịa | ❌ Khó — văn bản tự do chứa số không ràng buộc | ✅ Quote bắt buộc gắn `review_id`; số trong đoạn văn bản chèn dưới dạng "biến" (metric token), không gõ tay được | ✅ nhưng cứng |
| Làm mới 1 phần khi dữ liệu đổi | ❌ Regenerate phá nội dung người đã sửa | ✅ Mỗi khối regenerate độc lập, giữ phần người sửa, hiển thị diff | ✅ nhưng mất công sửa câu chữ |
| Đồng nhất bộ nhận diện 24 trang | ❌ Dễ trôi layout, mỗi báo cáo một kiểu | ✅ Template khóa, mọi báo cáo cùng cấu trúc (yêu cầu đóng gói dịch vụ lặp lại) | ✅ |
| Công sức build | Cao (collab, block tùy biến, PDF khớp WYSIWYG) | Trung bình | Thấp |
| Rủi ro pháp lý/thương mại khi nhân bản hàng loạt | Cao | Thấp | Thấp nhưng sản phẩm kém giá trị |

### 1.3. Phương án chọn: **B — "Report Canvas" gồm các KHỐI (block) có kiểu**

Tài liệu báo cáo = danh sách có thứ tự các **block có kiểu**, đúng cấu trúc 24 trang đã chốt:

- **Khối DỮ LIỆU (không sửa chữ/số trực tiếp):** `scorecard`, `pnl_table`, `fee_breakdown`, `competitor_table`, `market_share_chart`, `review_cluster_table`, `quote_list`, `spec_sheet`, `roadmap_gantt`, `risk_register`. Render từ dữ liệu tính toán/snapshot; mỗi con số có **chip nguồn** (SP-API/Rainforest/LLM/người nhập + ngày lấy).
- **Khối NHẬN ĐỊNH (sửa được, rich-text nhẹ):** `narrative` (kết luận cạnh tranh, bình luận cụm điểm đau, lý do nên/rủi ro…) do LLM điền nháp bằng TipTap, chuyên viên sửa tự do.
- **Khối GHI CHÚ CỦA CHUYÊN VIÊN:** `analyst_note` (không phải output AI, in đậm trong PDF phần phụ lục hoặc tại chỗ).
- **Biến số trong văn bản:** khi LLM/người muốn viết "CR₃ = **72%**", con số chèn dưới dạng **metric token khóa theo `metric_id`**; token tự cập nhật khi tính lại và không thể gõ tay thành số khác.
- **Mọi khối có vòng đời:** `drafted (AI) → in_review → verified` với `verified_by`, `verified_at`. Nút **Xuất PDF** bị khóa cho tới khi (a) mọi section bắt buộc `verified`, (b) mọi cờ veto được xác nhận đã nhìn thấy, (c) có người duyệt cấp lãnh đạo.

> Sau này muốn nâng cấp lên trải nghiệm kéo-thả/đa người soát như Notion thì chỉ cần mở rộng trình render block; **dữ liệu báo cáo không phải viết lại**. Đây là kiến trúc "lắp sau" đúng như adapter Mock → Sandbox → Production của toàn hệ thống.

### 1.4. Sáu nguyên tắc vàng của editor (đưa vào định nghĩa "xong")

1. **Tách SỐ và CHỮ.** Số = từ engine/snapshot, không gõ tay đè được. Chữ = LLM nháp, người sửa. Nếu chuyên viên muốn thay một con số (ví dụ CPC ngách), họ sửa ở màn **giả định đầu vào** → engine tính lại cả báo cáo; hành động này ghi audit.
2. **Mọi trích dẫn review phải truy gốc.** Khi lưu, hệ thống đối chiếu TỪNG chuỗi quote có tồn tại nguyên văn trong bảng `research.reviews_raw` không; không khớp → từ chối lưu khối. LLM không tự bịa được câu trích dẫn.
3. **Cờ veto không "bấm cho xanh" được.** Net margin < 20%, CR₃ > 65%, Amazon 1P trong Top 3 là do engine tính; chuyên viên chỉ có thể **ghi nhận biên bản phản biện** (justification) kèm chữ ký, không gỡ được cờ. PDF luôn in cả cờ lẫn biên bản.
4. **Ký theo từng phần, không ký một cục.** Mỗi Tab (Tài chính / Cạnh tranh / R&D / Roadmap) có nút "Tôi đã kiểm chứng phần này" gắn người + thời gian; tái sử dụng văn hóa `verified/decided_by` của migration 0021.
5. **Thiếu dữ liệu hiện "chưa đủ cơ sở", không bịa 0** — đúng quy ước hiện tại của codebase (F3/F4 để trống khi thiếu giá vốn; badge không có số thật thì ẩn).
6. **Mọi thay đổi lưu vết:** nội dung LLM gốc (model + version + prompt hash), nội dung sau khi người sửa, ai sửa, khi nào; append-only như `iam.audit_logs`. PDF ghi rõ phần nào "AI soạn nháp – chuyên viên hiệu đính".

### 1.5. Công nghệ editor

- **TipTap v2 (ProseMirror)** cho riêng các khối `narrative` (rich-text gọn: đậm, gạch đầu dòng, link, metric token, quote chip); React 19/Next 15 tương thích từ bản TipTap mới — phải khóa version và kiểm `next build` ngay G5.
- Các khối dữ liệu là **React component thường** (bảng, biểu đồ) — KHÔNG nhét vào ProseMirror, tránh địa ngục WYSIWYG khi xuất PDF.
- **Không làm real-time cộng tác (CRDT/Yjs) ở v1:** chưa cần (mỗi ngách 1 chuyên viên chính + 1 người duyệt); thay bằng **khóa mở bản nháp** (pessimistic lock kiểu "Đang có Hải Anh soát") + lịch sử phiên bản. Yjs để dành Cấp độ sau.
- Biểu đồ trong báo cáo: **SVG tự dựng bằng component** (không thêm thư viện chart nặng), vì (a) phải in chuẩn khi xuất PDF, (b) toàn bộ dashboard hiện tại cũng theo hướng tối giản dependency.
- Lưu tự động (autosave debounced 1,5s) + nút lưu thủ công; mỗi lần "Gửi duyệt" chụp một **version** bất biến.

---

## 2. LUỒNG NGHIỆP VỤ END-TO-END (7 BƯỚC)

```
1. Tạo ngách        → /research/new: keyword(s), marketplace, category node, ASIN hạt nhân (tùy chọn),
                      COGS/landed cost, khối lượng-kích thước, CPC giả định, kịch bản giá
2. Thu thập dữ liệu → job Rainforest Collections (SERP organic 2-3 trang → offers/sales_estimation
                      cho 20-50 ASIN → reviews all_critical top N) + feesEstimate SP-API;
                      tiến độ hiện như màn Sync Health; tốn bao nhiêu credits hiển thị rõ
3. Tính toán thô     → engine pure: P&L 3 kịch bản, size-tier, CR3/CR5/HHI, phân bố BSR,
                      confidence, scorecard 5 trụ + veto
4. AI soạn nháp      → job LLM: cụm điểm pain + chọn quote có nguồn + viết narrative từng section
5. Chuyên viên soát  → Report Canvas: đọc, sửa chữ ở khối narrative, xác minh từng khối,
                      điền spec sheet gửi xưởng, chốt roadmap, ký từng Tab
6. Trưởng phòng duyệt→ khóa version, xem lại veto, nút "Phê duyệt xuất bản"
7. Xuất & bàn giao   → 2 PDF (Executive 2-4 tr. + Full ~24 tr.), watermark bảo mật,
                      đẩy lên Supabase Storage + ghi ops.client_reports; Client Portal tải được
```

Báo cáo có **TTL 30 ngày** (hạn dùng số liệu in ngay bìa). Hết hạn chuyển trạng thái `stale`; muốn gia hạn thì chạy lại bước 2–3 (cache theo ASIN/keyword nên rẻ) và tạo version mới.

---

## 3. KIẾN TRÚC TỔNG THỂ

```
[Chuyên viên VEXIM]
      │  /research/new (giả định đầu vào)
      ▼
[Next.js Web]  ── tạo assessment (status=collecting)
      │
      ├─► [Cron/CLI Job: research:collect]  (web/src/lib/worker/jobs/research-*.job.ts)
      │        │
      │        ├─► RainforestProvider  (interface IntelligenceProvider)
      │        │      • type=search (exclude_sponsored=true)
      │        │      • type=product / offers / sales_estimation
      │        │      • type=reviews & review_stars=all_critical
      │        │      • Collections API khi > ~20 request (bulk, webhook)
      │        ├─► SP-API feesEstimate (tái dùng /products/fees/v0 — đã chạy ở whoami)
      │        └─► raw JSONB lưu research.collection_runs (replay được, không sửa UI)
      │
      ├─► [Engine pure functions]  web/src/lib/research/domain/*.ts (unit test như pricing.ts)
      │        pnl.ts · size-tier.ts · concentration.ts (CR3/CR5/HHI)
      │        scorecard.ts (5 trụ, veto, confidence) · roadmap.ts
      │
      ├─► [Job: research:analyze]  → LLMProvider (mock | openai | anthropic)
      │        map: phân cụm review theo ASIN → reduce: 3-5 pain + chọn quote + narratives
      │        (mọi quote validate ngược với reviews_raw trước khi lưu)
      │
      ▼
[Report Canvas /research/[id]/editor]  ── khối dữ liệu (khóa) + narrative (TipTap) + autosave
      │  verified từng section → approved (state machine trong DB, trigger guard)
      ▼
[Xuất PDF]  v1: print CSS (Chromium "Save as PDF")  ·  v2: job render Chromium phía server
           → Supabase Storage → ops.client_reports → Client Portal
```

**Bám khuôn hiện hữu:**

- Provider: thêm tầng `web/src/lib/intelligence/` (Rainforest) và `web/src/lib/ai/` (LLM) theo đúng interface Mock → Sandbox → Production (`web/src/lib/data/provider.ts`). Demo mode chạy bằng mock deterministic, **không cần key vẫn demo/training được** như 261 bài test hiện nay.
- Job: đặt trong `web/src/lib/worker/jobs/` để **Vercel Cron + CLI dùng chung một bộ luật** (bài học migration 0019: shim `worker/src/config.ts`); thêm CLI `worker:research:*`.
- Cron: route mới `web/src/app/api/cron/research/route.ts`, bảo vệ bằng `CRON_SECRET`, `maxDuration = 60`, **không ngồi chờ** — tạo collection/poll 2 lần/ghi `research.collection_runs`, lần sau poll tiếp (đúng pattern `/api/cron/report-pull`). Việc quét hàng trăm call nên chạy CLI hoặc Rainforest Collections + webhook.

---

## 4. MÔ HÌNH DỮ LIỆU — MIGRATION `0025_module_8_product_research.sql`

Schema mới **`research`** — cố ý KHÔNG gắn `seller_account_id` (dữ liệu ngách/đối thủ không thuộc shop nào), phân quyền theo **`org_id`** như `ops.client_reports`; RLS theo đúng mẫu 0001/0022.

| Bảng | Vai trò | Khóa/ghi chú chính |
|---|---|---|
| `research.assessments` | Bản thẩm định ngách (1 dòng = 1 báo cáo) | `id, org_id, code (PR-2026-009…), title, marketplace, keywords jsonb, category_node, seed_asin, status, analyst_id, approver_id, data_expires_at = now()+30d, settings jsonb (kịch bản giá, CPC giả định, ngưỡng), created/updated` |
| `research.assessment_inputs` | Giả định đầu vào, **lưu version** | COGS, landed cost, dims/weight đóng gói, 3 kịch bản giá, CPC/CTR/CR, tỷ lệ trả hàng; `version, valid_from, changed_by` — tương tự `catalog.cost_inputs` hiệu lực theo thời gian |
| `research.collection_runs` | Nhật ký lần quét Rainforest/SP-API (giống `connections.report_requests`) | `kind (serp/products/offers/sales/reviews/fees), params jsonb, status (queued/running/done/no_data/failed), credits_used int, external_id (collection id), raw jsonb, error, started/finished` |
| `research.competitor_snapshots` | Top 20–50 listing theo từng lần quét | `assessment_id, run_id, position, is_sponsored bool, asin, parent_asin, brand, price, rating, reviews_count, bsr jsonb, est_units_month, est_revenue_month, buybox_seller, is_amazon_1p bool, dimensions jsonb, payload jsonb`; unique `(assessment_id, asin, run_id)` |
| `research.reviews_raw` | Review 1–3★ thô | `assessment_id, asin, source_review_id unique, stars, title, body, review_date, helpful_count, verified bool, photos jsonb, url, payload jsonb`; **đã loại thông tin nhận dạng reviewer khi parse**; dedupe theo `source_review_id` qua RPC idempotent |
| `research.pain_clusters` | Cụm điểm đau LLM phân loại | `assessment_id, code (quality/expectation_gap/logistics/…), share_pct, severity_avg_stars, trend, sample_size, model, llm_run_id` |
| `research.pain_items` | Top 3–5 điểm pain chi tiết | `cluster_id, title, frequency, severity, factory_requirement (sửa được), listing_fix (sửa mô tả), priority (must/should/skip), quote_ids jsonb` |
| `research.pain_quotes` | Trích dẫn **bắt buộc truy gốc** | `pain_item_id, review_id → reviews_raw, quote (nguyên văn), asin, stars, review_date, url`; khi insert có trigger đối chiếu chuỗi con trong `reviews_raw.body` |
| `research.improvement_specs` | Spec sheet gửi xưởng (người điền/chỉnh) | `pain_item_id, requirement, test_method, acceptance_standard, cost_impact_estimate, owner` |
| `research.scorecards` | Điểm 5 trụ | `assessment_id, pillar (1..5), score numeric(3,1), weight, confidence (high/med/low), reason, metrics jsonb (chốt giá trị đầu vào), computed_at`; unique assessment+pilar |
| `research.veto_flags` | Các cờ phủ định cứng | `assessment_id, rule_code (margin_below_20 / cr3_above_65 / amazon1p_top3 / cert_barrier…), severity, evidence jsonb, acknowledged_by, acknowledgement_note, acknowledged_at` — **không có cột "dismiss"** |
| `research.roadmap` | Lộ trình validate | `assessment_id, competitor_samples_to_buy, test_order_qty, ads_budget_per_day, test_days, breakeven_acos, gates jsonb, kill_criteria jsonb, max_loss_amount, updated_by` |
| `research.risk_register` | Sổ rủi ro 8–12 dòng | `assessment_id, category, risk, level, signal, mitigation, owner` |
| `research.llm_runs` | Nhật ký mọi lần gọi LLM (truy vết + kiểm chi phí) | `assessment_id, section_key, model, provider, prompt_hash, input_refs jsonb, output jsonb, tokens_in/out, cost_est, status, created_by ('ai'|'human_regen')` |
| `research.report_sections` | Trạng thái & hiệu đính từng section (khối narrative) | `assessment_id, report_version, section_key, status (drafted/in_review/verified), edited_content jsonb (TipTap doc JSON), llm_run_id, verified_by, verified_at, updated_at`; unique 3 cột |
| `research.report_versions` | Phiên bản bất biến khi gửi duyệt/xuất bản | `assessment_id, version, snapshot jsonb (toàn bộ số liệu tại thời điểm chốt), status (in_review/approved/published), created_by, approved_by, approved_at` |
| `research.credit_ledger` | Sổ cái credits Rainforest | `org_id, ts, delta, reason, run_id, balance_after` — cảnh báo ngưỡng chi/tháng |
| `ops.client_reports` (CÓ SẴN) | Bản PDF bàn giao | Tận dụng: thêm `report_type='rnd_assessment'`, `storage_path` trỏ PDF full; thêm bản executive (2 dòng hoặc cột `kind`) |

**Quy ước triển khai (giống 0015–0021):**

- Idempotent `create table if not exists` / `create or replace`; RPC ghi bằng `security definer` với `search_path` cố định, service_role mới gọi được ghi; view cho web dạng `security_invoker` đặt tên `vexim_research_*`.
- **Trigger guard state machine** trên `research.assessments` và `research.report_versions`, mô phỏng `ads.change_request_guard` (0021): ví dụ không cho `published` khi còn section bắt buộc chưa `verified`, hoặc chưa `approver_id`, hoặc còn veto chưa `acknowledged`; luật nằm ở DB, không ở UI.
- RLS: `analyst`/`dept_lead` theo `org_id` được gán (mở rộng mẫu `iam.can_read_seller_account` thành bản theo org); `client_viewer` chỉ đọc `report_versions đã published` + `ops.client_reports` của org mình; reviewer không có quyền ghi.
- Tài khoản khóa (`suspended`, migration 0022) tự động mất quyền trên schema mới vì đi qua chính các hàm lõi `iam.*`.

---

## 5. TẦNG PROVIDER MỚI & BIẾN MÔI TRƯỜNG

### 5.1. Rainforest

- `web/src/lib/intelligence/types.ts` — interface `IntelligenceProvider { search(); getProduct(); getOffers(); getSalesEstimate(); getCriticalReviews(); runCollection(); }`.
- `…/rainforest/client.ts` — server-only, GET `https://api.rainforestapi.com/request` (JSON mặc định), Collections `PUT /collections/{id}` + webhook nhận kết quả; xử lý 429 (tuần tự khi tạo collection theo docs), timeout/retry có backoff, **không gọi trong request UI** (chỉ job).
- `…/mock-intelligence.ts` — dữ liệu giả deterministic cho 1–2 ngách mẫu (giống `mock.ts`), gắn nhãn `data_source='mock'` để không ai nhầm.
- Endpoint dùng (đã kiểm chứng docs): `type=search&exclude_sponsored=true` · `type=product` · `type=offers` · `type=sales_estimation` (ASIN hoặc BSR+category) · `type=reviews&review_stars=all_critical` (phân trang, lấy ngày/sao/nội dung/ảnh/helpful). Tránh tham số nhân 2–3 credits (`variant_prices`, `include_html`…).
- Webhook Collections: route `web/src/app/api/webhooks/rainforest/route.ts` (thêm vào `bypassPaths` ở `api/version` middleware), ký bằng shared secret riêng.

### 5.2. LLM

- `web/src/lib/ai/types.ts` — `LlmProvider { clusterReviews(); draftSection(); }`; 2 implementation `openai.ts` (GPT-4o-mini) / `anthropic.ts` (Claude Haiku) + `mock-llm.ts` trả JSON theo đúng schema để test/đào tạo không tốn tiền.
- Chạy **chỉ trong job server-side**; structured output (JSON schema ràng buộc), temperature thấp; mọi response ghi `research.llm_runs`.
- Chọn model theo việc: model nhỏ cho phân cụm/hàng loạt; cân nhắc model lớn hơn chỉ cho đoạn kết luận điều hành nếu chất lượng chưa đạt — đo bằng A/B nội bộ, mặc định giữ model nhỏ để rẻ (2–5s/request như PRD).

### 5.3. Biến môi trường (server-only, thêm vào `web/.env.example` + Vercel)

| Biến | Bắt buộc | Ghi chú |
|---|---|---|
| `RAINFOREST_API_KEY` | Cho luồng thật | Thiếu → job trả `skipped` kèm hướng dẫn (giống cách job Ads xử lý thiếu `AMAZON_ADS_*`, không làm đỏ dashboard) |
| `RAINFOREST_WEBHOOK_SECRET` | Khi dùng Collections | Khóa xác thực webhook |
| `LLM_PROVIDER` | `openai` \| `anthropic` \| `mock` | Mặc định `mock` ở demo |
| `LLM_API_KEY`, `LLM_MODEL` | Cho luồng thật | VD `gpt-4o-mini` / `claude-3-5-haiku-*`; model được in trong PDF phụ lục phương pháp |
| `RESEARCH_CREDIT_BUDGET_MONTHLY` | khuyến nghị | Ngưỡng cảnh báo sổ cái credits |
| Tái dùng: `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `AMAZON_LWA_*` | có sẵn | Fees estimate dùng LWA sẵn có |

Supabase Storage: tạo bucket riêng `client-reports` (private), phát hành URL có chữ ký ngắn hạn.

---

## 6. JOBS & CRON

| Job (CLI + cron dùng chung) | Việc | Ghi chú giới hạn/chi phí |
|---|---|---|
| `research:collect-serp` | `search` 2–3 trang organic, tách sponsored | ~2–10 credits/ngách |
| `research:collect-products` | Collections: `product`+`offers`+`sales_estimation` cho 20–50 ASIN | Gộp 1 collection ≤ 1.000 request; ghi `credits_used` |
| `research:collect-reviews` | `reviews all_critical` cho 10–20 ASIN top, dừng khi đủ ~500 review | Giới hạn trang/ASIN trong settings; lọc PII reviewer ngay parser |
| `research:collect-fees` | SP-API `feesEstimate` cho ASIN hạt nhân/đối chứng + tính size-tier từ dims người nhập | Không tốn credits Rainforest |
| `research:analyze` | LLM map-reduce: cụm pain, chọn quote, narratives 5 mục | Chunk review ≤ giới hạn token; có thể chạy lại riêng từng section |
| `research:scorecard` | Tính lại 5 trụ + veto + confidence | Pure, chạy cả khi không có LLM |
| `research:render` (v2) | Render PDF server-side | Xem mục 9 |

Chuẩn chung như hệ thống cũ: `--dry-run` không ghi DB; idempotent theo `(assessment_id, kind, phạm vi)`; lỗi/fail ghi rõ nguyên nhân; `no_data` không phải lỗi; mỗi lần chạy tạo dòng `collection_runs` để màn tiến độ hiển thị giống Sync Health. Thêm bước xử lý ở cron tổng (cân nhắc nhánh `?research=1` của `report-pull` để không vượt trần 2 cron/ngày của Vercel Hobby, hoặc nâng gói Vercel).

---

## 7. LLM LAYER — PROMPT, CHỐNG HALLUCINATION, CHI PHÍ

1. **Map (theo ASIN):** đưa từng batch review 1–3★ đã lưu kèm `source_review_id`; yêu cầu gán nhãn 3 nhóm (*Quality / Expectation Gap / Logistics*) + nhãn phụ, trích **nguyên văn** cụm câu ngắn (≤ 25 từ) kèm id; không được thêm thông tin không có trong review.
2. **Reduce (toàn ngách):** tổng hợp cụm theo tần suất + độ nghiêm trọng, chọn 2–3 quote đại diện cho mỗi pain (ưu tiên verified purchase, có ảnh, nhiều helpful votes), xuất Top 3–5 kèm gợi ý yêu cầu kỹ thuật; phần gợi ý này đánh nhãn `llm_suggested` để chuyên viên xác nhận/sửa.
3. **Draft narratives:** viết theo dàn 24 trang bằng tiếng Việt, thuật ngữ Anh để trong ngoặc; số liệu chỉ chèn dưới dạng **metric token** (LLM trả `{metric_id}` chứ không tự viết số); không có dữ liệu → bắt buộc câu "chưa đủ cơ sở".
4. **Chốt chặn khi lưu (deterministic, không tin LLM):**
   - Mọi `quote` phải là chuỗi con của `reviews_raw.body` (so khớp đã normalize) — không khớp thì loại và log;
   - Mọi `metric_id` phải tồn tại trong snapshot tính toán;
   - Output không đạt schema → lưu trạng thái `failed`, không tạo section;
   - LLM không sinh ra được `veto`, `score` (chỉ engine sinh).
5. **Chi phí kỳ vọng:** mỗi ngách ~100–500 review + viết ~10 đoạn ngắn → vài chục nghìn token input, model nhỏ → cỡ **$0,05–0,25/ngách**; bật cache kết quả theo hash input để regenerate không tốn tiền khi dữ liệu không đổi.

---

## 8. SCORECARD ENGINE (PURE FUNCTIONS + TEST)

Đặt ở `web/src/lib/research/domain/`, phong cách giống `worker/src/domain/pricing.ts` (hàm thuần, test bằng `node --test`):

- `pnl.ts`: dựng lại công thức PRD trên nền `computeFloorPrice/computeMargin` sẵn có; 3 kịch bản (bi quan/cơ sở/quan tâm); tính net margin, break-even ACOS = (giá − COGS − phí)/giá; mô phỏng tháng tại 300/500/1.000 đơn; ROI lô test; ngày thu hồi vốn.
- `sizeTier.ts`: bảng size-tier FBA US công bố (hằng số có version theo năm) + hàm phân tier từ dims/weight; mô phỏng "nếu giảm 1 cạnh bao bì xuống X" → chênh lệch $/đơn.
- `concentration.ts`: gộp variation theo brand; CR₃/CR₅/CR₁₀; HHI = Σ(share%)²; phát hiện Amazon 1P (`is_amazon_1p` từ offers); mật độ sponsored (số kết quả quảng cáo / tổng); phân vị giá; rào review top 10; vận tốc review/tháng nếu có ≥ 2 điểm thời gian (giai đoạn Keepa).
- `scorecard.ts`: 5 trụ theo trọng số 25/25/20/20/10; mỗi trụ có bảng tham số điểm công khai (ví dụ margin ≥30%→10, 20–30→…, <20→veto); `confidence` suy từ độ đầy đủ mẫu (số ASIN có sales est., số review, số kịch bản); veto áp ở tầng verdict cuối: dù điểm tổng cao, dính veto cứng thì verdict tối đa là "CẦN CẢI TIẾN" và in cờ đỏ.
- `roadmap.ts`: test order = velocity kịch bản BI QUAN × 30–45 ngày; ads/day gợi ý theo độ dài đuôi từ khóa; max loss = (lô test × lỗ/đơn bi quan) + tổng ngân sách ads test.

Mọi ngưỡng (20%, 65%, số ngày phủ hàng, 30–45 ngày, rating <4 sau 50 đơn…) là **hằng số cấu hình theo marketplace**, không rải rác trong UI.

---

## 9. XUẤT PDF — 2 BƯỚC, TRÁNH BẪY WYSIWYG

| Bước | Khi nào | Cách |
|---|---|---|
| **v1 — Print CSS** (làm ở G6) | Ngay khi editor xong | Route `/research/[id]/report?kind=full\|exec` render đúng component của editor, `@media print` khổ A4, page-break theo section, header/chân trang + mã báo cáo, **watermark "TÀI LIỆU BẢO MẬT — VEXIM"**; chuyên viên bấm In → Lưu PDF. **Không thêm dependency nặng, bản PDF khớp 100% những gì thấy trên web** |
| **v2 — Render server** (sau khi có khách trả phí) | Cần phát hành 1 chạm, archive tự động | Job gọi **Chromium (Playwright) chụp chính route print** → upload Storage. Tránh cài Chromium trên Vercel serverless (nặng, trần 60s): chạy qua CLI worker/VPS nhỏ hoặc dịch vụ render (Browserless/Api2PDF/DocRaptor). KHÔNG dùng @react-pdf/renderer vì phải bảo trì layout lần thứ hai |

Hai template từ cùng một bộ số: **Executive** (bìa rút gọn + verdict + 5 trụ + 3 nên/3 rủi ro + số tiền giám đốc + checklist điều kiện) và **Full 24 trang ±4** theo đặc tả đã chốt. Xuất bản ghi 2 file vào `ops.client_reports`; Client Portal chỉ thấy file sau khi `published`.

---

## 10. DANH SÁCH MÀN HÌNH & ROUTE

| Route | Màn | Ai dùng |
|---|---|---|
| `/research` | Danh sách ngách: trạng thái thu thập/soát/duyệt/hết hạn, credits tháng đã dùng, cờ đỏ | analyst, dept_lead, ceo |
| `/research/new` | Wizard tạo ngách + giả định đầu vào (tái dùng UI nhập COGS/CSV sẵn có) | analyst |
| `/research/[id]` | Trạng thái thu thập (tiến độ từng job, credits, lỗi) — phong cách Sync Health | analyst |
| `/research/[id]/editor` | **Report Canvas** (mục 1.3): tab Scorecard/Tab1–4, panel nguồn dữ liệu, nút ký từng phần, regenerate từng khối kèm diff, khóa bản nháp | analyst (sửa), dept_lead (duyệt) |
| `/research/[id]/report?kind=full\|exec` | Bản in/PDF | tất cả quyền đọc |
| Client Portal (`/client`) | Thêm mục "Báo cáo Thẩm định R&D" tải PDF đã phát hành | client_viewer |
| Module 0 | Theo dõi mức dùng Rainforest credits (cạnh bảng dùng SP-API) + audit log thao tác báo cáo | admin |

---

## 11. PHÂN QUYỀN & LƯU VẾT

Tái dùng enum vai trò có sẵn (`super_admin, org_admin, dept_lead, operator, analyst, client_viewer` — migration 0001), **không phát minh vai trò mới**:

| Hành động | analyst | dept_lead (người duyệt) | org_admin/ceo | client_viewer |
|---|---|---|---|---|
| Tạo ngách, nhập giả định, chạy thu thập | ✅ | ✅ | ✅ | ❌ |
| Sửa narrative, điền spec/roadmap, ký section | ✅ | ✅ (sửa hạn chế) | xem | ❌ |
| Gỡ/biên bản veto | đề xuất | **ký chấp nhận** | ✅ | ❌ |
| Phê duyệt & phát hành PDF | ❌ | ✅ | ✅ | ❌ |
| Xem PDF đã phát hành của org mình | ✅ | ✅ | ✅ | ✅ |

Mọi thao tác ghi `iam.audit_logs` (append-only, sẵn có): đổi giả định, regenerate AI, sửa nội dung (kèm before/after rút gọn), verify/approve/publish, xuất PDF. Đúng nguyên tắc migration 0021: **luật nằm ở DB (trigger/RPC), UI chỉ là mặt trước**.

---

## 12. BẢO MẬT & TUÂN THỦ

1. **Tách bạch tuyệt đối với app SP-API/Ads đang chờ duyệt:** Rainforest/LLM là hợp đồng và khóa riêng, không nhắc use-case nghiên cứu đối thủ trong hồ sơ Amazon; hạ tầng gọi thẳng vendor, không dùng credential LWA. Đây là điều kiện bảo vệ đơn duyệt Ads hiện tại.
2. Khóa chỉ ở server (không tiền tố `NEXT_PUBLIC`); không log khóa; cân nhắc Supabase Vault cho production (đúng ghi chú 0001 về token).
3. **PII review:** không lưu tên/ID/profile reviewer; chỉ lưu nội dung đánh giá và metadata công khai (sao, ngày, verified); ảnh review cân nhắc ẩn avatar.
4. Mỗi báo cáo in sẵn phụ lục giới hạn: số đối thủ là ước tính từ BSR (dải sai số), không phải tư vấn pháp lý/sáng chế — giảm trách nhiệm cho VEXIM.
5. Dữ liệu thô để replay (`raw jsonb`) nhưng tách quyền: client_viewer không đọc được bảng raw, chỉ đọc PDF phát hành.
6. Watermark bảo mật + mã báo cáo + trang ký tên 3 bên (AI draft – chuyên viên – khách xác nhận đã đọc).

---

## 13. LỘ TRÌNH THEO GIAI ĐOẠN

> Tiền đề: **ưu tiên đóng bước Amazon Ads (việc con người, không phụ thuộc module này)** trước; G0 của module có thể làm song song. Mọi giai đoạn code theo phương châm "mock trước, cắm key sau" nên không bị chặn bởi bất kỳ đợt duyệt nào.

| GĐ | Tuần (1 dev) | Nội dung | Ra được gì | Cần VEXIM |
|---|---|---|---|---|
| **G0** | Song song, ~0 công dev | Kích hoạt Ads (submit/scope/3 env/redeploy); đăng ký Rainforest trial; tạo key LLM pay-go | Hết phụ thuộc hạ tầng | ✅ con người làm |
| **G1** | 1–2 | Migration 0025 khung (`assessments`, inputs, scorecards, veto, roadmap); domain thuần `pnl/sizeTier/scorecard/roadmap` + test; màn `/research/new` + **Máy tính biên giả định what-if** (lát cắt tài chính đã thống nhất); mock provider | Chạy được thẩm định **Tài chính** hoàn toàn bằng đầu vào nội bộ + SP-API fees; demo mock | COGS mẫu 1–2 sản phẩm thật |
| **G2** | 3–4 | Rainforest client (mock+thật), 3 job collect (serp/products/reviews) + Collections + credit ledger + `collection_runs`; màn tiến độ; parser + fixture test (như report parsers hiện có) | Thu thập thật bằng 100 credit trial; biết chính xác chất lượng dữ liệu ngách của VEXIM | Cung cấp 2–3 keyword ngách thật |
| **G3** | 5 | `concentration.ts` (CR3/HHI/1P/sponsored), bảng + biểu đồ thị phần SVG, Tab 2 trên web (chưa PDF) | ✅ **PHẦN MÁY XONG (15/09, migration 0027)**: CR3/CR5/HHI gộp variation, veto 1P/CR3, velocity 2 mốc, Tab 2 trên web; xem ghi chú cập nhật cuối mục 13. Phân hệ 2 chạy thật sau trial để quyết mua gói $66 | Quyết định ngân sách $66/tháng |
| **G4** | 6–7 | Job `collect-reviews` hoàn chỉnh (đủ 500 review/ngách), LLM adapter + map/reduce + validate quote + narratives; `llm_runs`; Tab 3 nháp | Phân hệ 3 chạy thật với LLM | Xác nhận giọng văn mẫu báo cáo |
| **G5** | 8–9 | **Report Canvas** (TipTap narrative, khối dữ liệu, autosave, metric token, lock bản nháp, lịch sử version, regenerate+diff từng khối); `report_sections`; trigger state machine + RPC; ký từng phần; audit; RBAC | Editor AI-nháp/người-duyệt hoạt động đúng quy trình 6 nguyên tắc vàng | Đặt người soát + người duyệt mẫu |
| **G6** | 10 | Route print + CSS A4 + watermark; 2 template exec/full; phát hành → Storage + `ops.client_reports`; Client Portal | Xuất được PDF gửi khách đầu tiên (thao tác Save as PDF) | Duyệt mặt thiết kế in/logo |
| **G7** | sau ra mắt | Render PDF server 1 chạm; Keepa (lịch sử BSR/mùa vụ); đa marketplace; cảnh báo ngân sách credits; (cân nhắc) Yjs cộng tác | Sản phẩm đóng gói dịch vụ lặp lại | Feedback 3 khách đầu |

**Tổng effort: ~11–12 người-tuần** (1 fullstack liên tục) hoặc **~6–7 tuần với 2 fullstack** (1 nghiêng data/worker, 1 nghiêng editor/PDF). Lát cắt **cắt sớm khả dụng nội bộ**: G1 (2 tuần, chưa cần Rainforest/LLM). Mốc bán được cho khách: hết G6.

> **✅ Cập nhật 16/09/2026 — G7 ĐÃ XONG PHẦN MÁY (trừ PDF server để dành).** Engine thuần `web/src/lib/research/domain/{credit-budget,seasonality}.ts` (+15 test node:test): ngưỡng mùa vụ ≥12 điểm BSR trải ≥56 ngày/≥2 tháng có điểm, đỉnh–đáy, trung vị 30/90 ngày, xu hướng hồi quy, lịch nhập hàng trước mùa 8 tuần; guard credits warn 2.000/block 10.000 (mặc định theo gói Starter annual, overage $0,0118). Tầng Keepa `web/src/lib/intelligence/keepa/` (client CSV, mock mô phỏng mùa cao điểm 10–11; backfill TẮT mặc định, bật bằng `KEEPA_API_KEY`+`RESEARCH_KEEPA_BACKFILL=1`). Migration `0030_module_8_g7_bsr_seasonality.sql` (bảng `research.bsr_history`, RPC worker upsert/refresh từ snapshots + RPC `vexim_research_credit_status`, 2 view đọc UI; BƯỚC 30 harness PASS) + fix RLS `credit_ledger` trong 0026 (BƯỚC 31: đủ 19 view public). Worker guard budget trước mỗi run (4 test mới), tự refresh BSR sau products (direct + webhook) và backfill Keepa có cờ; cron lặp `17 4 * * *` UTC; tab `SeasonalityPanel` + `CreditBudgetPanel` trên `/research/[id]`; khối in `PrintSeasonality` sau mục cấu trúc thị trường; tài liệu vận hành: `docs/module-8-tai-lieu-van-hanh.md`. Toàn bộ 357 test web xanh, `tsc --noEmit` và `next build` xanh. PDF server 1 chạm (Playwright/Chromium + `ops.client_reports` + Client Portal), đa marketplace, Yjs vẫn để dành.

> **✅ Cập nhật 15/09/2026 — G3 ĐÃ XONG PHẦN MÁY.** `web/src/lib/research/domain/concentration.ts`: gộp variation theo parent ASIN (sales lấy MAX), CR3/CR5/HHI theo doanh thu ước lượng (fallback đơn vị; yêu cầu ≥10 organic + ≥70% có sales estimate, thiếu thì trụ null "chưa đủ cơ sở"), veto đỏ CR3 > 65% và Amazon 1P top 3, mật độ sponsored, review velocity từ 2 lần quét SERP (≥3 ASIN đủ 2 mốc); hàm ghép `mergeCompetitorSnapshots`/`scoreCompetitionFromSnapshots` cho worker + webhook. Migration `0027_module_8_research_scoring.sql`: unique `(assessment_id, rule_code)`, RPC service_role `vexim_research_worker_set_pillar` (null = chưa đủ cơ sở, thang 1–10 siết), `…_add_veto` (idempotent, tự cập nhật bộ đếm), `…_clear_vetoes` (chỉ gỡ veto cạnh tranh khi quét lại, giữ veto tài chính/chứng nhận) — harness BƯỚC 26 PASS. Worker tự chấm sau bước products (direct lẫn webhook Collection); Tab 2 web `MarketConcentrationPanel` trên `/research/[id]` (KPI CR3/CR5/HHI/1P, biểu đồ thị phần brand, điểm trụ, cảnh báo, ghi chú sai số BSR→sales 20–40% + chỗ Keepa G7). Demo dựng dữ liệu từ MockIntelligenceProvider. Engine demand pillar hoàn chỉnh + pain clusters là G4.

> **✅ Cập nhật 15/09/2026 — G2 ĐÃ XONG PHẦN MÁY (chờ thử key thật).** Migration `0026_module_8_research_collection.sql` (3 bảng: competitor_snapshots giữ lịch sử theo run, reviews_raw KHÔNG có cột danh tính reviewer, credit_ledger; RPC `vexim_research_enqueue_run` cho analyst + 4 RPC worker chỉ service_role; 4 view security_invoker; BƯỚC 25 harness PGlite xanh gồm chặn PII/RQL cô lập org). Parser thuần trong `web/src/lib/research/domain/collection.ts`; tầng `web/src/lib/intelligence/` (MockIntelligenceProvider deterministic + RainforestClient REST/Collections/webhook); job `research-collect.job.ts` (serp/products/reviews, drain queue, products thật đi qua Collection bất đồng bộ + webhook `/api/webhooks/rainforest`); CLI `npm run worker:research-collect`; cron `/api/cron/research-collect` (max 5 run/lượt, CRON_SECRET); panel tiến độ + nút xếp hàng trên `/research/[id]`; env `RAINFOREST_API_KEY/RAINFOREST_WEBHOOK_SECRET/RAINFOREST_WEBHOOK_BASE_URL`. Chưa thử API thật (sandbox chặn egress) — việc G0 của VEXIM: nạp trial 100 credit và chạy lượt thật đầu tiên để đối chiếu field.

> **✅ Cập nhật 15/09/2026 — G1 ĐÃ XONG.** Engine thuần `web/src/lib/research/domain/` (pnl/size-tier/scorecard/roadmap + bảng phí FBA US 2026 ƯỚC LƯỢNG, cờ `FBA-US-2026-approx`), 5 file `web/tests/research-*.test.ts`; migration `0025_module_8_research_core.sql` (7 bảng `research.*` gồm `collection_runs` để dành G2, RLS theo org, RPC ghi duy nhất `vexim_research_create_assessment`, 6 view `security_invoker`, audit `m8_research`) với BƯỚC 24 harness PGlite xanh hoàn toàn; UI `/research`, `/research/new` (máy tính what-if tính trực tiếp), `/research/[id]`. Ghi ở Supabase mode qua RPC bằng phiên đăng nhập (analyst/dept_lead/admin); client_viewer và user vô vai trò bị chặn ở DB. Phí FBA là bảng ước lượng — SP-API Product Fees sẽ đè ở G2 qua `fbaFeeOverride`. Chưa thêm dependency nào (đúng nguyên tắc TipTap G5, Playwright G7).

**Cập nhật tài liệu khi triển khai:** thêm dòng Module 8 vào bảng tổng hợp ở `ke-hoach-trien-khai-theo-module.md`; nhật ký tiến độ ghi vào `tien-do-trien-khai.md` theo đúng phong cách "cập nhật DD/MM — migration NNNN — kiểm chứng X test".

---

## 14. KIỂM THỬ & ĐỊNH NGHĨA HOÀN THÀNH

Tiểu chuẩn theo đúng nề nếp hiện tại (worker/web `node --test`, harness SQL đếm PASS):

- **Domain thuần:** bảng test biên (margin đúng từng cent, 3 kịch bản), CR3/HHI với brand trùng/variation, veto cắt verdict, confidence khi thiếu mẫu, size-tier biên kích thước; mục tiêu mỗi hàm ≥ số lượng nhánh như `pricing.ts`.
- **Parser Rainforest:** lưu JSON mẫu thật của 5 loại `type` vào fixtures (giống thư mục parser report), test chuẩn hóa trường, lọc PII, dedupe review, giá trị lạ → NULL (không đoán 0) như helper 0019.
- **LLM:** mock provider trong CI (không gọi mạng); test validate quote (chuỗi không nguyên văn bị loại), metric token không tồn tại bị chặn, thiếu dữ liệu → "chưa đủ cơ sở"; test trần chi phí token/ngách.
- **State machine & RLS:** mở rộng harness `supabase/tests/rls_test.sql`: analyst khác org không đọc được, client_viewer không đọc raw/không thấy section chưa duyệt, tài khoản suspended mất quyền, không publish khi thiếu chữ ký/còn veto chưa xác nhận, không update/delete được version đã published.
- **PDF:** test snapshot layout các trang có dữ liệu biên (bảng dài 50 ASIN, 5 pain, 12 rủi ro) không vỡ page-break; watermark/mã báo cáo hiện mọi trang.
- **Definition of Done mỗi giai đoạn:** `worker npm test` xanh · `web npm test` xanh · harness SQL xanh · `tsc --noEmit` sạch · `next build` qua · chạy demo mode không cần key thật · có mục "Việc VEXIM cần làm" rõ người chịu.

---

## 15. RỦI RO KỸ THUẬT & GIẢM THIỂU

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Sales estimation lệch làm khách mất niềm tin | Cao | In dải ước tính + nguồn + ngày; lấy BSR đa thời điểm (Keepa ở G7); verdict tài chính ưu tiên số phí SP-API thật; cột confidence |
| Rainforest chậm 30–50s/lỗi collection ở gói thấp | TB | Bất bộ tuyệt đối: queue + Collections + webhook, không gọi đồng bộ; sổ cái credits; G2 dùng trial để đo tốc độ thật TRƯỚC khi mua |
| LLM gán nhãn sai/bịa quote | Cao | Chốt chặn deterministic đối chiếu nguyên văn + metric token; LLM chỉ nháp, người ký; mẫu prompt review bởi trưởng phòng |
| Vượt chi credits/tháng | TB | Bảng `credit_ledger` + ngưỡng cảnh báo, cache ASIN/keyword 7–30 ngày, tránh tham số nhân credits, giới hạn trang review trong settings |
| Editor công sức lớn (TipTap/PDF) | TB | Chỉ TipTap cho khối văn bản; v1 print CSS thay vì render server; không collab; khóa template 24 trang |
| Ảnh hưởng hồ sơ Amazon đang chờ | Cao nếu lẫn | Tách key/hạ tầng/mô tả use-case; module chạy độc lập; hoàn tất bước Ads trước, không gộp thông tin |
| Đổi nhà cung cấp dữ liệu | TB | Interface `IntelligenceProvider`; Canopy/Apify là phương án thay thế chỉ cần viết provider mới |
| Khóa LLM/ Rainforest vào client bundle | Nghiêm trọng | Quy ước review: mọi file mới trong `lib/intelligence|ai` chỉ import được từ server/job (thêm kiểm trong test/CI) |
| Báo cáo hết hạn bị khách dùng lại | TB | TTL 30 ngày in bìa + watermark; `stale` sau hạn; PDF cũ vẫn archive nhưng gắn nhãn bản cũ |

---

## 16. VIỆC VEXIM CẦN LÀM (CHECKLIST)

- ☐ Hoàn tất kích hoạt **Amazon Ads API** (Submit Direct Advertiser → Approved → assign `advertising::campaign_management` → set `AMAZON_ADS_CLIENT_ID/_SECRET/_REFRESH_TOKEN` → Redeploy).
- ☐ Đăng ký **Rainforest trial** tại https://app.rainforestapi.com/signup (100 request, không thẻ); gửi dev 2–3 từ khóa ngách thật + ASIN hạt nhân để chạy bộ kiểm chứng ~40–100 credits.
- ☐ Tạo khóa **LLM** pay-as-you-go (OpenAI hoặc Anthropic), nạp mức tối thiểu; chốt model mặc định (khuyến nghị `gpt-4o-mini`).
- ☐ Chuẩn bị số liệu đầu vào mẫu: COGS nội địa, chi phí vận chuyển về FBA, khối lượng/kích thước bao bì cho 1–2 sản phẩm dự kiến.
- ☐ Chốt người vai trò: **chuyên viên soát** (analyst) và **người phê duyệt** (dept_lead) cho báo cáo mẫu; chốt logo/nhận diện cho watermark & PDF.
- ☐ Quyết định ngân sách dữ liệu sau G2–G3: gói Rainforest Starter ~$66/tháng (10.000 credits, đủ 20–40 ngách mới/tháng kèm cache).
- ☐ Cung cấp 1–2 khách thí điểm chấp nhận nhận báo cáo bản thử nghiệm (đổi lấy phản hồi), trước khi đóng gói thành sản phẩm tính phí.

---

## PHỤ LỤC A — HỢP ĐỒNG RAINFOREST & ƯỚC LƯỢNG CREDITS/NGÁCH

- Endpoint gốc: `GET https://api.rainforestapi.com/request?api_key=…&type=…` (JSON mặc định, CSV/HTML tùy chọn).
- Bulk: Collections API — thêm tối đa 1.000 request/lần gọi, tối đa 15.000 request/collection (100 nếu `include_html=true`), kết quả lưu 14 ngày, webhook/S3/GCS/Azure; tạo request phải tuần tự, gọi song sinh 429.
- Bộ gọi kiểm chứng trial (~35–45 credits): search 2–3 trang; offers + sales_estimation cho 5–10 ASIN; product cho 5 ASIN; reviews all_critical 2–3 trang cho 3–5 ASIN.
- Báo cáo đầy đủ (50 ASIN + 500 review top 10–20 ASIN): **~160–300 credits/ngách mới**; lần gia hạn sau 30 ngày rẻ hơn nhờ cache.
- Tham số tốn nhân credits cần tránh ở v1: `variant_prices`, `import_fees`, `include_html`, `include_safety_product_resources`.

## PHỤ LỤC B — MAP 24 TRANG PDF → SECTION KEY (khối)

| Trang | `section_key` | Khối chính |
|---|---|---|
| Bìa | `cover` | metadata + TTL + người phụ trách |
| Tóm tắt điều hành | `exec_verdict` | scorecard rút gọn + narrative (3 nên/3 rủi ro) + metric tokens (vốn test, đơn/tháng, biên, max loss) + checklist điều kiện |
| Tab 1 (3–4 tr.) | `fin_assumptions`, `fin_pnl`, `fin_scale`, `fin_packaging` | `pnl_table`, `fee_breakdown`, narrative, size-tier simulation |
| Tab 2 (4–6 tr.) | `mkt_definition`, `mkt_toplist`, `mkt_share`, `mkt_structure`, `mkt_conclusion` | `competitor_table`, `market_share_chart`, narrative (chỗ trống dành cho biểu đồ lịch sử Keepa ở G7) |
| Tab 3 (6–9 tr.) | `rd_method`, `rd_clusters`, `rd_pain_01..05`, `rd_specsheet`, `rd_priority` | `review_cluster_table`, `quote_list`, narrative, `spec_sheet`, ma trận tác động-công sức |
| Tab 4 (2–3 tr.) | `roadmap_phase0`, `roadmap_order`, `roadmap_ads`, `roadmap_gates`, `roadmap_cashflow` | `roadmap_gantt`, kill-criteria, max loss |
| Cuối (3–5 tr.) | `risk_register`, `appendix_method`, `appendix_limits`, `appendix_glossary`, `appendix_signoff` | `risk_register`, nguồn/ngày/model, công thức, bảng 3 chữ ký |

## PHỤ LỤC C — DEPENDENCY MỚI DỰ KIẾN (web)

| Gói | Mục đích | GĐ | Lưu ý |
|---|---|---|---|
| `@tiptap/react` + `@tiptap/starter-kit` (+ extension link) | Rich-text cho khối narrative | G5 | Khóa bản tương thích React 19, kiểm build ngay |
| (không thêm chart lib) | Biểu đồ SVG tự dựng component | G3 | Phục vụ print PDF, gọn bundle |
| Playwright/Chromium | Render PDF server | G7 | Không cài trên serverless; chạy worker/VPS riêng hoặc dùng dịch vụ |
| Không thêm SDK Rainforest/LLV bắt buộc | Gọi REST trực tiếp bằng `fetch` như SP-API client | G2/G4 | Ít dependency, dễ mock/test |
