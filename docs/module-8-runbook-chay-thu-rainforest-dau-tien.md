# Module 8 — Runbook lượt chạy Rainforest thật đầu tiên

> Cập nhật **16/09/2026**: key trial đã được đối chứng hoạt động (1 request
> `type=search` trên amazon.com trả dữ liệu thật: PandaEar B08GFCX964, 4.8⭐ /
> 21.125 ratings; `credits_remaining = 99/100`). Sandbox Arena **chặn egress**
> tới `api.rainforestapi.com` và `*.supabase.co` nên mọi lượt chạy THẬT phải
> thực hiện trên **Vercel** hoặc **máy dev/VPS của VEXIM**, không chạy trong
> preview Arena được.

## 1. Biến môi trường

Đã dán vào `web/.env.local` (gitignored, KHÔNG commit):

| Biến | Giá trị | Ghi chú |
|---|---|---|
| `RAINFOREST_API_KEY` | ✅ đã nạp | trial 100 credits, còn ~99 |
| `RAINFOREST_WEBHOOK_SECRET` | ✅ đã nạp | chỉ dùng cho Collections (cách B) |
| `RAINFOREST_WEBHOOK_BASE_URL` | ⬜ **còn trống** | domain công khai, không có trailing slash. Chỉ bắt buộc khi chạy products kiểu Collection bất đồng bộ |
| `LLM_PROVIDER` | `mock` | G4 mới nối LLM thật |
| `RESEARCH_CREDIT_BUDGET_MONTHLY` | `2000` | ngưỡng cảnh báo trên view `vexim_research_credit_monthly` |

Để worker ghi được DB thật, **bổ sung thêm** trên Vercel (Project → Settings →
Environment Variables, áp cho môi trường đang test — nên tách Preview/Production):

| Biến | Bắt buộc cho |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` = `https://pitmyzovjwflkyoqjbkz.supabase.co` | mọi luồng |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | phiên người dùng trên UI |
| `SUPABASE_SERVICE_ROLE_KEY` | worker/cron/webhook ghi DB qua RPC |
| `CRON_SECRET` | gọi endpoint `/api/cron/research-collect` |
| `NEXT_PUBLIC_SITE_URL` | nên đặt = domain Vercel (dùng làm base webhook nếu trỏ thẳng) |

Vercel CLI (từ thư mục `web/`):
```bash
vercel env add RAINFOREST_API_KEY preview        # dán giá trị khi được hỏi
vercel env add RAINFOREST_WEBHOOK_SECRET preview
# ... các biến còn lại; redeploy sau khi thêm.
```

## 2. Cách A — DIRECT đồng bộ (khuyến nghị cho lượt test đầu, KHÔNG cần webhook)

Tốn ~**36 credits**, dữ liệu về ngay trong lượt worker, dễ đối chiếu field.

1. Mở `/research`, tạo 1 hồ sơ thẩm định với từ khóa ngách thử (ví dụ
   "silicone baby bib"), marketplace US.
2. Trên trang chi tiết, panel **"Thu thập dữ liệu (G2 — Rainforest)"** giờ có
   ô chọn tham số + ước tính credits. Chạy **lần lượt**, mỗi bước xác nhận
   `done` trong bảng lịch sử rồi mới xếp bước kế:
   1. **SERP** — 1 trang → xếp hàng (≈ **1 credit**).
   2. Kích hoạt worker để nhận hàng đợi (xem mục 3).
   3. **Product + Offers + Sales** — topN `10`, giữ tick **direct đồng bộ**
      (≈ **30 credits**, 3 request/ASIN: product + offers + sales_estimation).
   4. Worker chạy tiếp; sau đó G3 tự chấm trụ cạnh tranh (CR3/CR5/HHI, veto).
   5. **Review 1–3★** — 5 ASIN × 1 trang (≤ **5 credits**).
3. Tổng: ≤ **36 credits**. Tránh bấm products với topN 30 + bỏ tick direct:
   mặc định đó sẽ tạo Collection 90 request bất đồng bộ (xem cách B).

### 3. Kích hoạt worker nhận hàng đợi

Hai lựa chọn (cùng code `drainResearchQueue`):

- **Vercel/hosted (khuyến nghị)** — gọi endpoint cron bằng Bearer CRON_SECRET:
  ```bash
  curl -H "Authorization: Bearer $CRON_SECRET" \
    "https://<domain-vercel>/api/cron/research-collect?kinds=serp,products,reviews&max=5"
  ```
  Mỗi lượt tối đa 5 run để nằm trong trần 60s của Vercel Hobby; gọi lại nếu
  hàng còn tồn. Chưa thêm route này vào `vercel.json` crons tự động (cố ý —
  tránh tự phát sinh credits); mới chỉ có inventory-sync và report-pull.
- **CLI trên máy có mạng ra Rainforest + Supabase**:
  ```bash
  cd web
  npm run worker:research-collect -- --kinds=serp,products,reviews --max=20
  ```
  Script tự nạp `.env.local`; kết thúc in `mode: "production"` khi đủ cả 3
  nhóm biến Rainforest + Supabase. Thoát mã 1 khi rơi về demo (thiếu biến).

## 4. Cách B — Collection bất đồng bộ (sau này, khi quét quy mô lớn)

1. Đặt `RAINFOREST_WEBHOOK_BASE_URL` = domain Vercel **không có dấu `/` cuối**
   (ví dụ `https://vexim-ops-git-....vercel.app`). Client tự dựng callback
   `${BASE}/api/webhooks/rainforest?secret=<RAINFOREST_WEBHOOK_SECRET>`;
   route đã nằm trong `bypassPaths` của middleware (không cần cookie phiên).
2. Redeploy để worker đọc biến mới.
3. Xếp hàng products **bỏ tick** "direct đồng bộ" → worker PUT Collection
   (tối đa 1.000 request, tạo tuần tự để tránh 429 gói trial); run ở trạng thái
   `collection_created/running`, **chưa ghi credit**; khi Rainforest gọi
   webhook, hệ thống GET lại kết quả (không tin payload), parse qua
   `parseProductCollectionResults`, ghi competitors + credits rồi tự chấm trụ
   cạnh tranh.
4. Test webhook thủ công (giả lập Rainforest):
   ```bash
   curl -X POST "https://<domain>/api/webhooks/rainforest?secret=$RAINFOREST_WEBHOOK_SECRET" \
     -H "content-type: application/json" \
     -d '{"collection":{"id":"<collection-id-thật>","status":"complete"}}'
   ```
   Sai/thiếu secret phải nhận HTTP 401.

## 5. Đối chiếu sau mỗi bước

```sql
-- trạng thái run + credits ghi nhận
select kind, status, credits_used, external_id, error, finished_at
  from public.vexim_research_runs
 where code = '<mã hồ sơ>' order by created_at;

-- số liệu đối thủ (data_source phải là 'rainforest', không phải 'mock')
select position, asin, brand, price, rating, ratings_total,
       est_units_month, est_revenue_month, is_amazon_1p, data_source
  from public.vexim_research_competitors
 where code = '<mã hồ sơ>' order by run_id, position limit 15;

-- review 1–3★, không được có cột danh tính reviewer
select stars, asin, review_date, left(body, 80)
  from public.vexim_research_reviews where code = '<mã hồ sơ>' limit 10;

-- tổng chi credits tháng của org
select * from public.vexim_research_credit_monthly order by month desc;
```

Đối chiếu chéo với con số `credits_remaining` Rainforest trả trong
`request_info` của mỗi lần chạy (chênh lệch = requests lỗi/không ghi được).
Quy ước trung thực: field nào Rainforest không trả thì để `null` / hiển thị
"chưa có dữ liệu" — **không nội suy, không bịa số**.

## 6. Xử lý sự cố nhanh

| Triệu chứng | Nguyên nhân/xử lý |
|---|---|
| Worker trả `mode: "demo"`, provider mock | Thiếu `RAINFOREST_API_KEY` trong env của tiến trình chạy worker (Vercel: redeploy sau khi thêm biến) |
| `db: "noop"` dù có key Rainforest | Thiếu `NEXT_PUBLIC_SUPABASE_URL` hoặc `SUPABASE_SERVICE_ROLE_KEY` |
| Cron 401 "Sai Bearer" | `CRON_SECRET` ở Vercel khác giá trị dùng trong lệnh curl |
| Products kẹt `collection_created` | Chưa đặt `RAINFOREST_WEBHOOK_BASE_URL`/secret, hoặc domain không nhận POST; dùng cách A (direct) cho lượt test |
| Rainforest HTTP 429 | Gói trial tạo Collection song song/quá nhanh — client đã retry; tạo collection tuần tự, giảm `max` |
| View `public.vexim_research_*` không tồn tại | Chạy `supabase/repair/recreate_research_public_views.sql` (xem mục sự cố trong `supabase/README.md`) |

## 7. Bảo mật

- `.env.local` đã nằm trong `.gitignore` (`.env*.local`); không dán key vào
  file mẫu, không log full URL có `api_key`.
- Nếu key bị lộ qua kênh không an toàn: rotate ngay trên app.rainforestapi.com
  rồi cập nhật lại Vercel + `.env.local`.
- Secret webhook nằm trong query URL của callback (đúng thiết kế route); nếu
  Rainforest đổi sang cơ chế header chữ ký ở G7, cập nhật cả client lẫn route.

## 8. G4 — phân tích điểm đau bằng LLM (gpt-4.1-mini)

### 8.1. Áp migration 0028 (bảng pain + llm_runs + trigger truy vết quote)

```bash
bash supabase/apply-migrations.sh   # chạy đủ chuỗi; KHÔNG áp lẻ từng file
```

Sau khi áp, reload PostgREST schema cache (Supabase Dashboard → API →
"Reload schema cache", hoặc RPC `NOTIFY pgrst, 'reload schema'`) để 5 view mới
xuất hiện: `vexim_research_pain_clusters`, `..._pain_items`, `..._pain_quotes`,
`..._improvement_specs`, `..._llm_runs`.

### 8.2. Biến môi trường LLM (chỉ server, KHÔNG tiền tố NEXT_PUBLIC_)

```bash
# .env.local (máy chạy worker) và Vercel Environment Variables
LLM_API_KEY=sk-...            # nạp $10 OpenAI là đủ ~80–100 hồ sơ 500 review
LLM_MODEL=gpt-4.1-mini        # CHỐT: 1 model cho toàn bộ map/reduce/narrative
LLM_PROVIDER=                  # để trống: có key là tự chạy OpenAI; =mock để ép giả lập
```

Không có key, worker vẫn chạy được nhưng mọi kết quả gắn `provider='mock'` —
UI hiện chip "dữ liệu MOCK minh họa", không được dùng cho quyết định sản xuất.

### 8.3. Đủ mẫu review rồi mới phân tích

- Mục tiêu ~500 review 1–3★/ngách: panel G2 đặt **10 ASIN × 5 trang**
  (≈50 credits reviews, mỗi trang 1 credit).
- Dưới 30 review, trụ "khác biệt hóa" để **null – chưa đủ cơ sở** (không chấm bừa).

### 8.4. Chạy phân tích

1. Trên trang hồ sơ `/research/<id>`, panel "Điểm đau khách hàng (G4)" bấm
   **"+ Xếp hàng phân tích pain (LLM)"** (RPC `vexim_research_enqueue_run`
   kind=`analyze`, provider=`llm`, cần vai trò analyst/dept_lead).
2. Worker nhận run: CLI
   `npm run worker:research-collect -- --kinds=analyze --max=2`, hoặc cron
   `/api/cron/research-collect?kinds=analyze&max=2` (đảm bảo đủ thời gian:
   500 review ≈ 20 lô map tuần tự; Vercel cron nên tách riêng kind=analyze).

### 8.5. Đối chiếu kết quả

```sql
-- 3 cụm pain + narrative
select cluster_code, review_count, share_pct, item_count, severity_avg_stars
  from public.vexim_research_pain_clusters where code='<mã hồ sơ>';

-- pain ưu tiên + hướng xử lý gợi ý
select cluster_code, item_key, title, frequency, frequency_pct, severity,
       impact_score, effort_score, priority, source
  from public.vexim_research_pain_items where code='<mã hồ sơ>'
 order by priority, frequency desc;

-- MỌI trích dẫn phải mở được link review gốc; đối chiếu câu là nguyên văn
select i.title, q.asin, q.stars, q.review_date, q.quote, q.url
  from public.vexim_research_pain_quotes q
  join public.vexim_research_pain_items i on i.item_key = q.item_key
 where q.code='<mã hồ sơ>';

-- token/chi phí thực từng lượt (không có dòng nào là "không rõ chi phí")
select section_key, chunk_index, model, tokens_in, tokens_out, cost_usd, status
  from public.vexim_research_llm_runs
 where code='<mã hồ sơ>' order by created_at;
```

### 8.6. Chốt an toàn

- Trigger `trg_guard_pain_quote` đối chiếu câu trích với `reviews_raw.body`
  (≤25 từ, đúng thứ tự, cho cách ≤12 ký tự dấu câu); câu bịa/thuộc review
  khác bị **chặn cả lượt lưu**, không có pain "ma" trên UI.
- Tần suất/sao trung bình/nghiêm trọng/impact×effort **hệ thống tính lại** từ
  dữ liệu gốc — LLM chỉ gợi ý tên pain, câu trích và hướng xử lý.
- Spec gửi xưởng mặc định `llm_suggested`; analyst đổi ưu tiên/sửa yêu cầu
  (RPC `vexim_research_update_pain_item`) mới chuyển `human_confirmed` và ghi
  audit log. Không coi gợi ý AI là chỉ thị sản xuất khi chưa có người ký.
