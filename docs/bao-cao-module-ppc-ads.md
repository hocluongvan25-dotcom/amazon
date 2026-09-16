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
| Code gọi API có **đúng chuẩn** không? | Tầng HTTP (`amazon/ads.ts`) **khớp Postman chính thức**, không cần sửa. Nhưng có **2 lỗi sai hợp đồng API** ở tầng cấu hình report (sai `groupBy`/tên cột) ⇒ **đã sửa** (mục 3). Nếu để nguyên, khi bật credential lên 2/5 report sẽ ăn lỗi **400** của Amazon. |
| Cần làm gì để có số liệu thật? | (1) Thêm 3 biến env Ads trên Vercel → Redeploy; (2) bấm nút **"▶ Chạy đồng bộ Amazon Ads ngay"** trên `/ppc` (hoặc `npm run worker:ads-sync` / `worker:ads-pull`); (3) report v3 là **bất đồng bộ** — lần đầu có thể phải chờ/bấm lại. Chi tiết ở mục 5. |

---

## 2. ĐỐI CHIẾU CODE VỚI TÀI LIỆU CHÍNH THỨC

### 2.1. Tầng HTTP — ĐÚNG, không sửa gì

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
- **(b)** Tại máy chủ/CLI: trong `web/` chạy `npm run worker:ads-sync` rồi `npm run worker:ads-pull`.
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
