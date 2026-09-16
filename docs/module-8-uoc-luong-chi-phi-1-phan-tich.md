# Module 8 — Ước lượng chi phí 1 hồ sơ thẩm định (Rainforest + LLM)

> Ngày tính: **16/09/2026**. Mọi đơn giá lấy từ bảng giá công khai tại thời điểm
> đó (mục Nguồn cuối file). Chi phí LLM là **ƯỚC LƯỢNG theo thiết kế G4**; khi
> G4 hoàn thiện, bảng `research.llm_runs` sẽ ghi thật `prompt_tokens /
> completion_tokens / model / cost_usd` cho từng lượt — con số thực tế sẽ luôn
> truy được, không dùng số ước lượng để báo cáo.

## 1. Trả lời nhanh: thêm key GPT là AI chạy ngay?

**Chưa.** Đến G3 mới chỉ có engine tài chính (G1), đường ống Rainforest (G2) và
engine tập trung thị phần (G3). G4 chưa code: adapter LLM, job map/reduce 3 cụm
pain (Quality / Expectation Gap / Logistics), bộ kiểm định trích dẫn gốc, bảng
`llm_runs`, narrative/spec sheet/ma trận impact×effort. Dán `LLM_API_KEY` vào
giờ không gây lỗi nhưng cũng chưa kích hoạt gì (provider mặc định `mock`).

## 2. Rainforest API — chi phí thu thập dữ liệu

Client của mình chỉ dùng loại request cơ bản, **1 request = 1 credit**
(search/product/offers/sales_estimation/reviews đều 1 credit; Collections tính
y hệt request lẻ). Các tham số nhân hệ số 2–3× (`variant_prices`, `import_fees`,
`include_html`, `include_safety_product_resources`) đã được tránh từ G2.

### 2.1. Số credit/1 hồ sơ theo gói chạy

| Bước | Gói TEST ĐẦU (mặc định panel mới) | Gói ĐẦY ĐỦ (chuẩn báo cáo G4) |
|---|---|---|
| SERP (1 từ khóa) | 1 trang = **1** | 2–3 trang = **2–3** |
| Product + Offers + Sales ước lượng | 10 ASIN × 3 = **30** | 30–50 ASIN × 3 = **90–150** |
| Reviews 1–3★ (`all_critical`, ~10 review/trang) | 5 ASIN × 1 trang = **5** (~50 review) | 10 ASIN × tối đa 5 trang, dừng sớm khi đủ ≈ **30–60** (~300–500 review) |
| **Tổng** | **≈ 36 credits** | **≈ 160–300 credits** (lấy mốc tính 200) |

Lượt quét lại sau 30 ngày rẻ hơn (chỉ quét ASIN biến động, tận dụng kết quả
Collection lưu 14 ngày và cache).

### 2.2. Bảng giá Rainforest (Traject Data), công khai 09/2026

| Gói | Giá/tháng (annual) | Giá/tháng (monthly) | Credits/tháng | Vượt gói |
|---|---|---|---|---|
| Trial | $0 | — | 100 (một lần) | — |
| Hobbyist | $18 | $23 | 500 | $0.06/credit |
| **Starter** | **$66** | **$83** | **10.000** | **$0.0118/credit** |
| Production | $300 | $375 | 250.000 | $0.003/credit |
| BigData | $800 | $1.000 | 1.000.000 | $0.002/credit |

Quy đổi chi phí/1 hồ sơ:

| Gói chạy | Trên Trial còn 99 credit | Trong gói Starter (~$0,0066–0,0083/credit) | Vượt gói Starter ($0,0118) | Trong gói Production (~$0,0012–0,0015) |
|---|---|---|---|---|
| Test 36 credits | $0 (chạy được 2 lượt) | **~$0,24–0,30** | ~$0,42 | ~$0,05 |
| Đầy đủ 160–300 | không đủ | **~$1,1–2,5** | ~$1,9–3,5 | **~$0,2–0,45** |

> ⚠️ Không dùng gói Hobbyist cho luồng này: vượt gói $0,06/credit (đắt gấp 5×
> Starter); 500 credits chỉ chạy được ~2 báo cáo full.

## 3. LLM (GPT) — chi phí phân tích review

### 3.1. Thiết kế map/reduce G4 và mô hình token

Giả định: review 1–3★ trung bình ~130 token (tiêu đề + thân ~60–90 từ + metadata
ASIN/sao/ngày/link). Các đầu ra cố định mỗi hồ sơ: bảng 3 cụm pain, danh sách
trích dẫn gốc, spec sheet cho xưởng, ma trận impact×effort, narrative tiếng Việt.

| Khối | Cách làm | Input ước tính | Output ước tính |
|---|---|---|---|
| MAP | chẻ review thành khối ~30 review/lượt, trích pain + câu gốc kèm truy nguồn | ~80k (500 review + prompt) | ~18–20k JSON |
| KIỂM ĐỊNH TRÍCH DẪN | đối chiếu từng câu trích có đúng trong review gốc, loại câu bịa | ~20–30k | ~1–2k |
| REDUCE + SPEC SHEET + MA TRẬN + NARRATIVE | gom 3 cụm Quality/Expectation Gap/Logistics, xuất deliverable tiếng Việt | ~30–40k | ~8–10k |
| **Tổng/1 hồ sơ ĐẦY ĐỦ** | | **~120–160k token** | **~25–35k token** |
| Gói TEST (~50 review) | map 2 lượt, các bước sau giữ nguyên | **~20–25k** | **~7–10k** |

### 3.2. Đơn giá model (OpenAI, 2026, USD/1 triệu token, vào/ra)

| Model | Input | Output | Hợp với bước nào |
|---|---|---|---|
| gpt-4o-mini (legacy rẻ nhất) | $0,15 | $0,60 | MAP/kiểm định (tiếng Việt ổn) |
| gpt-4.1-nano | $0,10 | $0,40 | trích xuất/phân loại — bước MAP rẻ nhất |
| gpt-5-mini | $0,25 | $2,00 | reduce/tổng hợp chất lượng cao |
| **gpt-4.1-mini** (khuyến nghị) | **$0,40** | **$1,60** | chạy đều cả pipeline, tiếng Việt tốt |
| gpt-4.1 (full) | $2,00 | $8,00 | chỉ dùng nếu mini sai giọng/phân tích |

Batch API giảm **50%** — G4 chạy bất đồng bộ qua worker nên phần MAP (tốn token
nhất, không cần trả ngay) có thể đẩy qua Batch, cắt gần nửa chi phí.

### 3.3. Chi phí LLM/1 hồ sơ

| Chiến lược model | Gói TEST (~50 review) | Gói ĐẦY ĐỦ (~500 review) |
|---|---|---|
| Toàn bộ gpt-4o-mini | ~$0,01 | **~$0,04** |
| Lai: nano cho MAP + gpt-5-mini cho tổng hợp | ~$0,01–0,02 | **~$0,04–0,06** |
| **Toàn bộ gpt-4.1-mini (khuyến nghị)** | **~$0,02** | **~$0,10** |
| Toàn bộ gpt-4.1 (chất lượng cao nhất) | ~$0,10 | ~$0,49 |
| gpt-4.1-mini + Batch API cho MAP | ~$0,015 | **~$0,06–0,07** |

## 4. Tổng chi phí 1 hồ sơ (Rainforest + LLM)

| Gói | Gói TEST | Gói ĐẦY ĐỦ (mốc 200 credits) |
|---|---|---|
| Rainforest (trong gói Starter) | ~$0,24–0,30 | ~$1,3–1,7 |
| Rainforest (giá vượt gói) | ~$0,42 | ~$2,36 |
| LLM (gpt-4.1-mini, kể cả Batch cho MAP) | ~$0,015–0,02 | ~$0,06–0,10 |
| **TỔNG/1 hồ sơ** | **≈ $0,25–0,45** | **≈ $1,4–2,5 (Starter); ~$0,3–0,55 (Production)** |

## 5. Kịch bản theo tháng (gói đầy đủ ~200 credits + ~$0,08 LLM)

| Số hồ sơ/tháng | Credits Rainforest | Gói hợp lý | Tổng/tháng | Chi phí thực/cái (đã gồm phí gói) |
|---|---|---|---|---|
| 5 (giai đoạn chạy thử) | ~1.000 | Starter (dư) | ~$66–83 + $0,4 LLM | ~$13–17/cái (phí gói chưa dùng hết) |
| 15 | ~3.300 | **Starter** | ~$66–83 + ~$1,2 | **~$4,5–5,6/cái** |
| 30 | ~6.600 | **Starter** | ~$66–83 + ~$2,4 | **~$2,3–2,8/cái** |
| 45 | ~9.900 | sát trần Starter | ~$70–87 + $3,6 | ~$1,5–2/cái |
| 100 | ~20.000 | Starter + vượt gói: $66 + 10k×$0,0118 ≈ **$192** (rẻ hơn Production $308) | ~$192 + $8 LLM | **~$2/cái** |
| ≥150 (≈30k credits) | ~30.000+ | **Production** ($300/250k) | ~$308 trở lên | ~$2→$0,3/cái khi tăng dần về 1.000 hồ sơ |

Điểm hòa vốn Starter (+vượt gói $0,0118) → Production rơi vào khoảng
**~30.000 credits/tháng ≈ 140–150 hồ sơ full/tháng** — giai đoạn đầu chắc chắn
chưa chạm. Với nhịp dự kiến 5–15 hồ sơ/tháng của team R&D, **gói Starter
$66–83/tháng là lựa chọn đúng**, trial 100 credits hiện tại đủ chạy 2 gói test
để đối chứng field trước khi mua.

## 6. Cấu hình đề xuất khi code G4

```bash
LLM_PROVIDER=openai
LLM_API_KEY=sk-...            # nạp khi bắt đầu G4
LLM_MODEL=gpt-4.1-mini        # mặc định toàn pipeline
# tùy chọn sau khi đo thực tế:
# LLM_MAP_MODEL=gpt-4.1-nano  # bước map rẻ hơn
# LLM_REDUCE_MODEL=gpt-5-mini # bước tổng hợp kỹ hơn
# LLM_USE_BATCH=true          # map qua Batch API −50% (chấp nhận chậm hơn)
```

Nguyên tắc G4 giữ đúng văn hóa codebase: model trả thiếu/sai trích dẫn → để
null/"chưa đủ cơ sở", bộ kiểm định loại câu dẫn không khớp nguồn; mọi token/cost
ghi thật vào `llm_runs`; không có LLM key thì job trả `skipped`, không đỏ
dashboard.

## Nguồn (truy cập 16/09/2026)

- Bảng gói Rainforest: https://trajectdata.com/ecommerce/rainforest-api/ ;
  bảng đối chiếu giá monthly/annual: https://www.openwebninja.com/blog/best-ecommerce-apis-2026
- Quy ước credit (search 1 credit, +credit cho include):
  https://docs.trajectdata.com/rainforestapi/product-data-api/parameters/search ;
  Collections tính theo request: https://www.rainforestapi.com/docs/collections-api
- Giá OpenAI 2026: https://pecollective.com/tools/openai-api-pricing/ ;
  gpt-4.1-mini: https://pricepertoken.com/pricing-page/model/openai-gpt-4.1-mini ;
  gpt-4o-mini: https://devtk.ai/en/models/gpt-4o-mini/
