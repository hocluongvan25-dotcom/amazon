# BÁO CÁO — MODULE QUẢNG CÁO (PPC / AMAZON ADS): ĐÃ KẾT NỐI CHƯA, CÓ ĐÚNG KHÔNG?

> Ngày: 16/09/2026 · Người thực hiện: team build VEXIM OPS
> Nguồn đối chiếu (theo yêu cầu chủ dự án): repo chính thức **https://github.com/amzn/ads-advanced-tools-docs**
> (2 collection Postman + README) · tài liệu Amazon Ads API (`advertising.amazon.com/API/docs`) ·
> connector `source-amazon-ads` của Airbyte (bản chạy thật) · issues #324/#338 của repo chính thức.

---

## 1. TRẢ LỜI NGẮN (đọc 30 giây)

| Câu hỏi | Trả lời |
|---|---|
| Module PPC đã **kết nối** Amazon Ads chưa? | **Chưa** — trên Vercel chưa có credential Amazon Ads ⇒ phần Ads **không chạy**, job trả `skipped` (bỏ qua, không phải lỗi). |
| Vì sao màn `/ppc` trống? | Vì chưa bao giờ có dữ liệu được nhập: chưa có credential ⇒ chưa từng chạy sync/pull/cron thành công. Màn hình chỉ nói "Chưa có dữ liệu Amazon Ads" mà **không nói tắc ở đâu** ⇒ đã sửa (mục 4). |
| Code gọi API có **đúng chuẩn** không? | Tầng HTTP (`amazon/ads.ts`) khớp Postman chính thức về **đường dẫn/body/auth**. Đã tìm & sửa **3 nhóm sai hợp đồng**: (a) 2 lỗi `groupBy`/tên cột report (mục 2.2), (b) **thiếu media type v3** ở mọi lời gọi `/sp/*` (mục 8.1), (c) **gương negative keyword chưa được nối** vào job sync (mục 8.2). Nếu để nguyên, khi bật credential sẽ ăn **400/415** của Amazon. |
| Cần làm gì để có số liệu thật? | (1) Thêm 3 biến env Ads trên Vercel → Redeploy; (2) bấm nút **"▶ Chạy đồng bộ Amazon Ads ngay"** trên `/ppc` (hoặc `npm run worker:ads-sync` / `worker:ads-pull`); (3) report v3 là **bất đồng bộ** — lần đầu có thể phải chờ/bấm lại. Chi tiết ở mục 5. |

---

## 2. ĐỐI CHIẾU CODE VỚI TÀI LIỆU CHÍNH THỨC

### 2.1. Tầng HTTP — ĐÚNG về đường dẫn/body/auth; **media type v3 thì SAI — đã vá ở mục 8.1**

File: `web/src/lib/worker/amazon/ads.ts` (801 dòng). Đối chiếu từng điểm với Postman
`Amazon_Ads_API.postman_collection.json` + `Amazon_Ads_API_Environment.postman_environment.json`
trong repo chính thức:

| Hạng mục | Amazon quy định (Postman/tài liệu) | Code ta | Kết luận |
|---|---|---|---|
| Token endpoint | `POST https://api.amazon.com/auth/o2/token`, body `grant_type=refresh_token` + `refresh_token` + `client_id` + `client_secret` | giống hệt (`LWA_TOKEN_URL`, `getAccessToken`) | ✅ |
| Cache token | nên cache (token sống ~1 h, endpoint bị giới hạn tốc độ) | cache trong bộ nhớ + `expires_in` | ✅ |
| Header mọi request | `Authorization: Bearer <token>` + `Amazon-Advertising-API-ClientId: <client_id>` + `Amazon-Advertising-API-Scope: <profileId>` (API theo profile) | đủ cả 3, thiếu `Scope` chỉ khi gọi endpoint cấp tài khoản | ✅ |
| Host theo vùng | NA `advertising-api.amazon.com`, EU `advertising-api-eu.amazon.com`, FE `advertising-api-fe.amazon.com` | `adsHostForRegion()` đúng 3 vùng | ✅ |
| Campaign Management v3 | `POST /sp/campaigns/list`, `/sp/adGroups/list`, `/sp/keywords/list`, `/sp/targets/list`, `/sp/negativeKeywords/list`; sửa bằng `PUT /sp/campaigns`, `PUT /sp/keywords`, `POST /sp/negativeKeywords` | gọi đúng các endpoint này | ✅ |
| Reporting v3 | `POST /reporting/reports` body `{name,startDate,endDate,configuration{adProduct,groupBy,columns,reportTypeId,timeUnit,format}}` → `GET /reporting/reports/{reportId}` → tải file nén GZIP khi `COMPLETED` | đúng luồng, có poll + giải nén | ✅ |
| Lỗi | 401/`invalid_grant` = token hết hạn ⇒ phải re-authorize; 429/5xx ⇒ chờ & thử lại | phân loại lỗi + retry 429/5xx, 401 báo "kết nối lại shop" | ✅ |
| Vùng dữ liệu | `format`, `timeUnit` (`SUMMARY`/`DAILY`) theo report | đúng theo từng report trong `registry.ts` | ✅ |

> ⚠️ **ĐÍNH CHÍNH 16/09/2026 (vòng rà trang A3 — xem mục 8.1):** dòng *"Campaign Management v3"* ở bảng trên
> đúng về **đường dẫn**, nhưng khi đó code **chưa gửi media type riêng của từng tài nguyên** (`Accept` +
> `Content-Type` dạng `application/vnd.sp*.v3+json`). Với Amazon Ads API v3, media type là **một phần của hợp
> đồng**, không phải tùy chọn: gửi `application/json` có thể ăn **415/400** hoặc bị đọc sai kiểu dữ liệu.
> Đây chính là chỗ báo cáo này từng kết luận *"không sửa gì"* — kết luận đó **sai một phần**; đã sửa và có test mục 7.

> Lưu ý tương lai (không phải lỗi hiện tại): Amazon đã giới thiệu **Unified API** (`/adsApi/v1`, header
> `Amazon-Ads-AccountId`) và README của repo chính thức khuyến nghị cho *tích hợp mới*. Bộ API theo
> profile (`/sp/*`, `/reporting/*`) mà ta đang dùng vẫn được hỗ trợ và phù hợp hơn với dữ liệu
> marketplace của shop. Ghi ở đây để biết đường chuyển đổi, **chưa cần làm**.

### 2.2. Tầng cấu hình report — có **2 lỗi sai hợp đồng**, đã sửa

File lỗi: `web/src/lib/worker/ads/registry.ts` (mỗi report khai báo `reportTypeId`, `groupBy`, `columns`).

| Report | Trước (SAI) | Sau (ĐÚNG) | Căn cứ |
|---|---|---|---|
| `spPurchasedProduct` (purchased-products) | `groupBy: ["purchasedAsin"]` | `groupBy: ["asin"]` | Postman + tài liệu: `purchasedAsin` là groupBy của **Sponsored Brands**; SP dùng `asin`. Issue **#324** của repo chính thức dùng `"groupBy":["asin"]`, manifest Airbyte `source-amazon-ads` (đã chạy thật) cũng vậy. |
| `spTargeting` (targeting) | cột `"targetingExpression"` | cột `"targeting"` + thêm `"keywordType"` | Tài liệu report `spTargeting` chỉ có cột `targeting`; `targetingExpression` **không tồn tại** với SP. Airbyte cũng khai `targeting`/`keywordType`. |

Hệ quả nếu không sửa: khi bật credential, Amazon trả **400 Invalid column/groupBy** cho 2 report này
(lỗi cũ chỉ nằm trong log cron nên không ai thấy — đúng loại lỗi "im lặng" khó chịu nhất).

**Chống tái phát:** thêm **mục 6 — "HỢP ĐỒNG VỚI TÀI LIỆU AMAZON"** vào
`worker/tests/ads-engine.test.ts`: bảng `DOC_GROUP_BY` (5 `reportTypeId` chuẩn) + `DOC_COLUMNS`
(danh sách cột hợp lệ sinh từ tài liệu từng report). Test sẽ **fail** nếu ai đó đổi `groupBy`/thêm cột
sai chuẩn ⇒ thêm cột mới bắt buộc phải cập nhật bảng đối chiếu trước.

**Bằng chứng test thật sự bắt lỗi** (không phải test cho có):
- Bình thường: `worker` **19/19 pass**.
- Cố tình **tiêm lại 2 lỗi cũ** vào `registry.ts` → `# pass 17 / # fail 2` — đúng 2 test mới fail.
- Khôi phục bản gốc và kiểm lại bằng grep: `groupBy: ["asin"]` đã về đúng dòng 191.

---

## 3. VÌ SAO MÀN HÌNH TRỐNG — CHUỖI NHÂN QUẢ ĐẦY ĐỦ

1. Trên Vercel **chưa có** `AMAZON_ADS_CLIENT_ID` / `AMAZON_ADS_CLIENT_SECRET` / `AMAZON_ADS_REFRESH_TOKEN`
   (xem `web/.env.example` dòng 43–48).
2. `loadConfig()` (`web/src/lib/worker/config.ts`) vì thế trả `ads = null`.
3. Mọi job Ads (`ads-sync`, `ads-report-pull`, `ads-apply`) thấy `ads === null` ⇒ trả `skipped` kèm câu
   hướng dẫn. **Đây là thiết kế đúng** (không nổ lỗi), nhưng kết quả là **chưa từng** có lần chạy nào.
4. Cron `/api/cron/report-pull` cũng vì thế mà phần Ads luôn bị bỏ qua.
5. `/ppc` đọc các view `vexim_ads_*` → rỗng → hiện "Chưa có dữ liệu Amazon Ads".

⇒ **Không phải lỗi code, không phải lỗi migration**: dữ liệu chưa từng được nhập vì thiếu credential.

> ⚠️ Điểm rất dễ sai: Amazon Ads là **đăng ký ứng dụng RIÊNG**, **không dùng chung** app SP-API.
> Client id/secret của SP-API **không** dùng được cho Ads; refresh token cũng phải lấy từ luồng
> authorize của ứng dụng Ads (scope `advertising::campaign_management`).

---

## 4. ĐÃ SỬA GÌ TRONG LẦN NÀY (để lần sau không phải đoán)

Màn `/ppc` giờ **tự chẩn đoán 5 cổng** theo đúng thứ tự truy vết, ngay khi chưa có dữ liệu:

| Cổng | Kiểm gì | Nguồn đọc |
|---|---|---|
| 1. Credential | đủ 3 biến env chưa (chỉ trả **có/không**, không bao giờ trả giá trị token) | env |
| 2. Profile Ads | shop đã nhìn thấy profile Ads chưa | `vexim_ads_profiles` |
| 3. Cấu trúc | campaign đã đồng bộ chưa | `vexim_ads_campaigns` |
| 4. Metrics | dòng số liệu theo ngày + ngày mới nhất | `vexim_ads_account_daily`, `vexim_ads_kpi.last_day` |
| 5. Report gần nhất | có lần xin report nào **lỗi** không — và in **NGUYÊN VĂN** `last_error` của Amazon | `vexim_report_requests` |

Nguyên tắc: cổng trước chưa mở thì cổng sau hiện trạng thái **"chờ"** (không dọa người dùng bằng
một loạt lỗi không liên quan). Cảnh báo 400/401/429 được dịch thành việc cần làm cụ thể.

Kèm theo:
- **Nút "▶ Chạy đồng bộ Amazon Ads ngay"** trên `/ppc` (server action, chỉ `ceo`/`op_ppc`, chế độ
  Supabase) — chạy sync→pull ngay không cần chờ cron, in nhật ký từng bước.
- Khi **đã có** dữ liệu, panel chẩn đoán thu gọn trong mục `<details>` để không làm rối màn chính.
- `maxDuration = 60` cho trang vì server action chạy job (giống trần của cron).
- **9 test mới** (`web/tests/ads-health.test.ts`) khoá 4 luật: env chỉ trả boolean · thứ tự 5 cổng ·
  cổng sau "chờ" khi cổng trước chưa mở · lỗi Amazon hiện nguyên văn.
- `last_error` của Amazon được **hiện thẳng lên UI**, gồm cả lỗi 400 "Invalid groupBy/column" — chính là
  loại lỗi đã xảy ra ở mục 2.2 nhưng trước đây bị chôn trong log.

---

## 5. BẬT DỮ LIỆU THẬT — CÁC BƯỚC THEO THỨ TỰ

**Bước 1 — Khai báo credential (chỉ chủ dự án làm được).**
Vercel → Project → Settings → Environment Variables → thêm cho **cả Production và Preview**:

| Biến | Ý nghĩa |
|---|---|
| `AMAZON_ADS_CLIENT_ID` | client id **của app Amazon Ads** (không phải app SP-API) |
| `AMAZON_ADS_CLIENT_SECRET` | client secret của app Ads |
| `AMAZON_ADS_REFRESH_TOKEN` | refresh token lấy từ luồng authorize của app Ads (scope `advertising::campaign_management`) |
| `AMAZON_ADS_REGION` *(tùy chọn)* | `NA` (mặc định) · `EU` · `FE` — chọn theo marketplace shop bán |

→ **Redeploy** (biến môi trường chỉ đọc lúc khởi động; đổi biến mà không redeploy là vẫn `skipped`).

**Bước 2 — Chạy đồng bộ.** Chọn 1 trong 3, khuyến nghị (a):

- **(a)** Mở `/ppc` → bấm **"▶ Chạy đồng bộ Amazon Ads ngay"** (nhanh nhất, xem được nhật ký ngay trên màn).
- **(b)** Tại máy chủ/CLI: **`cd worker`** rồi chạy `npm run worker:ads-sync` và `npm run worker:ads-pull`.
  ⚠️ Hai script này khai trong `worker/package.json` ⇒ **phải đứng trong thư mục `worker/`**; chạy ở `web/` sẽ báo
  "Missing script" (xem mục 8.6).
- **(c)** Chờ cron `/api/cron/report-pull` (có thể gọi kèm tham số: `?adsKinds=`, `?days=`, `?dryRun=1` để thử).

**Bước 3 — Đợi report v3.** Reporting v3 là **bất đồng bộ**: xin report → Amazon tạo file → ta tải.
Lần chạy đầu có thể chưa xong (`PENDING`); bấm nút lần nữa sau 1–2 phút, hoặc để cron xử lý tiếp
(job có cơ chế **resume** và cooldown 4 giờ nên không xin trùng).

**Sau khi xong**, `/ppc` sẽ hiện KPI + bảng campaign thật; cổng 4–5 trên panel chuyển xanh. Nếu còn đỏ,
panel nói rõ tắc ở cổng nào + nguyên văn lỗi Amazon.

---

## 6. KẾT QUẢ KIỂM CHỨNG LẦN NÀY

| Hạng mục | Kết quả |
|---|---|
| `web npm test` | **390/390 pass** (trước 381; +9 test chẩn đoán Ads) |
| `web npx tsc --noEmit` | sạch |
| `web npm run build` | ✓ biên dịch thành công (`/ppc` 1.07 kB) |
| `worker npm test` | **483/483 pass** (trong đó `ads-engine.test.ts` 19/19, gồm 2 test hợp đồng tài liệu Amazon) |
| `supabase npm test` | TẤT CẢ PASS |
| Test tiêm lỗi (mutation) | tiêm lại 2 lỗi cũ → 2 test FAIL đúng như thiết kế, sau đó đã khôi phục |

---

## 7. CÒN LẠI / GIỚI HẠN — NÓI THẲNG

1. **Chưa chứng minh bằng call API thật**: trong môi trường build không có credential Ads nên không thể
   gọi Amazon để chứng minh "chạy được". Căn cứ hiện tại = Postman + tài liệu chính thức + connector
   Airbyte đã chạy thật + issues chính thức + test hợp đồng. **Sau khi có credential, lần chạy đầu chính là
   phép thử cuối** — nếu Amazon trả 400, panel chẩn đoán sẽ in nguyên văn lỗi ngay trên `/ppc`.
2. **Cột dẫn xuất của Amazon chưa thêm**: tài liệu có `acosClicks7d/14d`, `roasClicks7d/14d`,
   `costPerClick`, `clickThroughRate` — ta **không** thêm vì hệ thống tự suy ra từ cost ÷ sales
   (`ppc-model.ts`) và test cấm trùng lặp cột dẫn xuất. Muốn thêm sau này ⇒ cập nhật `DOC_COLUMNS`
   trong test trước.
3. **Unified API (`/adsApi/v1`)**: chưa dùng, chỉ ghi nhận là hướng cho tích hợp mới.
4. **Cron Ads mặc định đang bật** cùng cron report: ai muốn tắt nhanh thì thêm `?ads=0` vào URL cron.

---

## 8. BỔ SUNG 16/09/2026 — RÀ TRANG A3 (`/ppc/search-terms`) VÀ 2 LỖI TẦNG WORKER

Vòng rà này xuất phát từ yêu cầu *"trang search-terms có bị thiếu hay sai gì không?"*.
Kết quả: **giao diện thiếu 6 chỗ** (đã bù) và **tầng gọi Amazon sai/thiếu 2 chỗ** (đã sửa, có test).

### 8.1. LỖI NẶNG — mọi lời gọi `/sp/*` thiếu **media type v3** (đã sửa)

Amazon Ads API v3 không dùng `application/json` cho các tài nguyên `/sp/*`: mỗi tài nguyên có media type riêng,
và phải gửi ở **cả `Accept` lẫn `Content-Type`**. Trước đây `amazon/ads.ts` chỉ gửi `Authorization` + 2 header
client/scope ⇒ request hoặc bị **415 Unsupported Media Type**, hoặc Amazon trả **200 nhưng body rỗng/khác kiểu**.

Đã thêm hằng `ADS_SP_MEDIA_TYPE` + `spOpts()` trong `web/src/lib/worker/amazon/ads.ts`, và truyền media type
vào `listAll()` cùng **7 call site** `/sp/*`:

| Tài nguyên | Media type |
|---|---|
| `/sp/campaigns/list` | `application/vnd.spCampaign.v3+json` |
| `/sp/adGroups/list` | `application/vnd.spAdGroup.v3+json` |
| `/sp/keywords/list` | `application/vnd.spKeyword.v3+json` |
| `/sp/targets/list` | `application/vnd.spTargetingClause.v3+json` |
| `/sp/negativeKeywords/list` + `POST /sp/negativeKeywords` | `application/vnd.spNegativeKeyword.v3+json` |
| `/sp/campaigns/budget/usage` | **chỉ `Accept`**: `application/vnd.spcampaignbudgetusage.v1+json` (v1, không phải v3) |

**Bằng chứng:** mục **7** mới của `worker/tests/ads-engine.test.ts` khoá đúng hợp đồng này (server giả bắt
*"sai media type thì trả 415"*), `ads-engine` **23/23 pass**.

### 8.2. THIẾU — gương `ads.negative_keywords` chưa được nối vào job (đã nối)

`vexim_worker_record_ads_change` (0021) **có** ghi gương negative khi change action là `add_negative_*`, nhưng
`ads-sync.job.ts` **chưa bao giờ kéo ngược danh sách negative từ Amazon về**. Hệ quả: negative đã chặn thật trên
Amazon mà UI A3 vẫn hiện như "chưa chặn" ⇒ dễ chặn lại lần hai (Amazon báo lỗi trùng), và cột "đã chặn" sai.

Đã nối `pullNegativeKeywords()` vào cuối `ads-sync`:

- Nhịp 1: `listNegativeKeywords(profileId, {})` — hỏi gộp theo profile.
- Nếu Amazon trả **400/415** (API có profile không hỗ trợ hỏi gộp): nhịp 2 hỏi **từng campaign**, có trần
  `NEGATIVE_KEYWORD_FALLBACK_CAMPAIGNS = 25` và **ghi rõ trong message** là *"CHỈ hỏi 25/N campaign"* để không ai
  tưởng đã đủ.
- Ghi về DB qua RPC `vexim_worker_upsert_ads_negative_keywords` (adapter `upsertAdsNegativeKeywords`).
- **Mọi lỗi đều vào `out.errors`** với tiền tố `"gương negative keyword có thể THIẾU"` ⇒ không im lặng, vì đây
  đúng là loại dữ liệu mà "thiếu" nguy hiểm hơn "sai".
- Bộ đếm mới `negativeKeywords` trong nhật ký job (`AdsSyncCounts`).

**Test:** `worker/tests/ads-jobs.test.ts` **22/22 pass**, thêm 3 test (kéo được · nhịp 2 khi lỗi · lỗi luôn báo).

### 8.3. Soát lại toàn bộ cột/`groupBy` của 5 report — 5/5 HỢP LỆ

Đối chiếu lần hai (từng tên cột một, không chỉ `groupBy`) với tài liệu Amazon + manifest Airbyte:

| Report | `groupBy` | Số cột dùng | Kết quả |
|---|---|---|---|
| `spCampaigns` | `[campaign]` | 18/49 | ✅ hợp lệ 100% |
| `spTargeting` | `[targeting]` | 20/60 | ✅ |
| `spSearchTerm` | `[searchTerm]` | 19/60 | ✅ |
| `spAdvertisedProduct` | `[advertiser]` | 17/56 | ✅ (có `date` + `advertisedAsin`/`advertisedSku`) |
| `spPurchasedProduct` | `[asin]` | 21/48 | ✅ (max 31 ngày/lần xin) |

Ghi chú vận hành: report `spAdvertisedProduct` cần **Advertiser ID + Marketplace ID** đúng; nếu thấy `PENDING` mãi
thì **kiểm profile ID trước**, đừng đổi `groupBy` (issue #324/#338 của repo chính thức cho thấy nhiều ca
"đổi groupBy" là chữa sai bệnh).

### 8.4. Giao diện A3 — 6 chỗ thiếu + 1 chỗ chống thao tác trùng

| # | Thiếu gì | Đã bù |
|---|---|---|
| 1 | Bảng rỗng ⇒ chỉ có câu "Chưa có dữ liệu", không nói tắc ở đâu | Hiện **panel chẩn đoán 5 cổng** + nút *"▶ Chạy đồng bộ Amazon Ads ngay"* |
| 2 | Dữ liệu cũ vẫn hiện như mới | Băng cảnh báo khi ngày mới nhất **> 2 ngày** (`A3_STALE_DAYS`) |
| 3 | Không nói làm sao có dữ liệu | Panel *"Nạp dữ liệu search term bằng cách nào"* — 4 cách |
| 4 | Nhiều shop nhưng không rõ dòng của shop nào | Nhãn **tên shop** hiện khi có >1 shop |
| 5 | Cắt bớt dòng mà không báo | Cảnh báo **trần 3.000 dòng** (`ROW_LIMIT`) + `truncated` |
| 6 | Chỉ nhìn `purchases_7d` nên dễ "chặn oan" | Cảnh báo khi **`sales_14d > 0` mà `purchases_7d = 0`** |
| 7 | Duyệt gợi ý xong term biến mất khỏi gợi ý nhưng gương chưa có ⇒ **bấm "Chặn" lần hai** | Cột *Thao tác* khoá theo yêu cầu đang bay: hiện **chip trạng thái** + câu *"Đã có yêu cầu chặn cho term này — KHÔNG tạo thêm để Amazon không báo trùng."*; nếu lần ghi trước **LỖI** thì hiện **nguyên văn lỗi** + nút *"Thử chặn lại (Exact)"* |

**Hai chi tiết dễ bỏ sót (đã làm luôn trong vòng này):**
- Nếu **không đọc được** hàng đợi thay đổi thì màn **không được trắng bảng**: phần đọc này tách khỏi phần đọc search term,
  lỗi chỉ làm mất lớp chống trùng và hiện **băng đỏ** *"Chưa kiểm tra được yêu cầu chặn còn bay … tải lại trang, xem màn
  Duyệt & ghi (A4) trước khi bấm chặn"* — vì lúc đó nút chặn KHÔNG tự khoá được.
- `a3ReadyToBlock(rows, filter, inFlight)`: con số *"N dòng đáng xem chưa ai làm gì"* ở tiêu đề phải **trừ** những dòng đã
  có yêu cầu đang bay, nếu không thì sau khi duyệt gợi ý, dòng vẫn bị đếm là "chưa ai làm gì" — đúng cái nhầm dẫn tới chặn trùng.

**DEMO MODE có đủ 6 trạng thái** để nghiệm thu bằng mắt (mặc định đã hiện sẵn, không phải chỉnh bộ lọc):
chờ duyệt (2 dòng) · **đã chặn** · **có doanh số 14 ngày nhưng 0 đơn 7 ngày** (cảnh báo chặn oan) ·
**đã duyệt — chờ ghi Amazon** (chip khoá, đây là tính năng mới) · **lần ghi trước LỖI** (kèm nguyên văn lỗi
`DUPLICATE_KEYWORD` + nút "Thử chặn lại (Exact)").

Cơ chế chống chặn trùng nằm ở `web/src/lib/data/ppc-model.ts` (thuần, dễ test):
`a3ChangeKey` (khoá `campaign|adGroup|term`) · `a3InFlightMap` (gộp yêu cầu đang bay, ưu tiên dòng đang bay hơn dòng
`failed`) · `isOpenChangeStatus` · `a3HasOpenChange` · `a3FailedChange`. Trang đọc `readAdsChanges` với
`statuses: ["pending_approval","approved","applying","failed"]` — **phải có `failed`**, vì view `is_open` chỉ tính 3
trạng thái đang bay nên nếu chỉ dựa vào `is_open` thì ca "đã lỗi, cần thử lại" sẽ bị ẩn mất.

### 8.5. Kiểm chứng vòng rà này

| Hạng mục | Kết quả |
|---|---|
| `web npm test` | **405/405 pass** (trước 396; `ppc-model` 23 → **30**, `ads-health` 9 → **11**) |
| `web npx tsc --noEmit` | sạch |
| `web npm run build` | ✓ biên dịch thành công (`/ppc/search-terms` 5.02 kB) |
| `worker npm test` | **490/490 pass** (`ads-engine` 23/23 gồm mục 7 media type + negative; `ads-jobs` 22/22) |
| `supabase npm test` | TẤT CẢ PASS |
| Chạy thật trên bản build mới | `/ppc/search-terms` **HTTP 200**, hiện "dữ liệu tới 2026-09-15 · cách đây 1 ngày";
kiểm bằng curl: đủ **6 trạng thái** nêu ở 8.4 (chống chặn trùng · thử lại sau lỗi · cảnh báo chặn oan · đã chặn · chờ duyệt · form chặn) |

### 8.7. `/ppc` và `/ppc/search-terms` từng TRÙNG NHAU khi chưa có dữ liệu (đã tách)

Chủ dự án mở `veximops.com/ppc` và `veximops.com/ppc/search-terms` rồi hỏi *"hai trang này giống hệt nhau à?"* —
**đúng**, và đó là lỗi thiết kế thật: khi chưa có dữ liệu Ads, cả hai màn đều đổ **cùng một panel chẩn đoán 5 cổng**,
khác nhau mỗi dòng tiêu đề. Người dùng không thể biết màn nào dùng để làm gì.

Đã tách vai rõ ràng:

| Màn | Khi chưa có dữ liệu | Khi có dữ liệu |
|---|---|---|
| `/ppc` (A1 — tổng quan) | **Nhà của chẩn đoán**: liệt kê đủ 5 cổng + bảng trạng thái từng lần xin report + nút *"▶ Chạy đồng bộ ngay"* + một dòng chỉ đường sang A3/A4 | KPI · bảng campaign · "Cần xử lý ngay" |
| `/ppc/search-terms` (A3 — hành động) | **Không lặp lại 5 cổng**: panel *"Vì sao màn này chưa có dòng search term nào"* — nói tắc ở cổng NÀO (1 câu, lấy từ `stuckGate()`) + panel *"Nạp dữ liệu search term bằng cách nào"* (4 cách) + link sang A1 để xem chẩn đoán đầy đủ | Bảng search term + duyệt negative + chống chặn trùng (mục 8.4) |

Cốt lõi là 2 hàm thuần mới trong `web/src/lib/data/ads-health-model.ts` (có test):

- `stuckGate(diagnostics)` → cổng ĐANG chặn (không phải cổng "chờ"), `null` nếu không cổng nào chặn.
- `a3EmptyReason(counts, {credentialsOk, hasReadError})` → **vì sao RIÊNG màn search term trống**, phân biệt 5 ca:
  chưa cấu hình Ads · lỗi đọc DB · có profile nhưng 0 campaign · có campaign nhưng 0 keyword/target ·
  **có keyword nhưng 0 dòng search term** (report `spSearchTerm` còn `PENDING` — ca hay gặp nhất).

Hai màn cũng đã có dòng điều hướng chéo, nên không còn cảm giác "một màn hai tên".

### 8.6. Hướng dẫn vận hành — đọc kỹ chỗ này

`worker:ads-sync`, `worker:ads-pull`, `worker:ads-apply`, `worker:reports-pull`, `worker:oauth-soon` được khai
trong **`worker/package.json`** ⇒ câu lệnh đúng là:

```bash
cd worker
npm run worker:ads-sync
npm run worker:ads-pull
```

Chạy ở `web/` sẽ báo *Missing script*. `web/package.json` chỉ có `{dev, build, start, typecheck, test, worker:research-collect}`.
Đã sửa 4 chỗ text hướng dẫn trong UI/comment còn ghi thiếu `cd worker`
(`ppc/actions.ts`, `lib/data/ppc.ts`, `api/cron/report-pull/route.ts`, `ppc/campaigns/[campaignId]/page.tsx`).
