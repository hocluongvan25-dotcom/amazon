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
