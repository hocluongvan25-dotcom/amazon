# BÁO CÁO: "Đã kết nối được shop nhưng KHÔNG hiển thị tên shop Amazon đã kéo về"

Ngày điều tra: **16/09/2026** · Người báo: chủ dự án VEXIM · Phạm vi: Module 0 (kết nối shop, SOP-11) + tầng dữ liệu `connections.seller_accounts`.

---

## 1. Kết luận (đọc 30 giây)

**Không phải lỗi API Amazon.** API vẫn trả đúng và đủ dữ liệu, trong đó **có sẵn tên shop**.

Lỗi nằm ở phía mình, 3 chỗ nối tiếp nhau:

| # | Chỗ sai | Hệ quả |
|---|---|---|
| 1 | `parseMarketplaces()` (web/src/lib/spapi/whoami.ts) chỉ đọc `marketplace.id` + `marketplace.name` = **"Amazon.com"** (tên SÀN) và **bỏ qua `storeName`** (tên SHOP) | Tên shop không bao giờ đi tiếp |
| 2 | DB **không có cột nào** chứa tên shop. `connections.seller_accounts.display_name` là **nhãn vận hành do VEXIM tự đặt** ("P1 · US" → "VEXIM US - Chính"), không phải dữ liệu Amazon trả về | Không có chỗ để lưu tên shop |
| 3 | UI màn Kết nối shop chỉ hiển thị `display_name` | Nhìn vào tưởng "shop không có tên" |

**Đã sửa**: đọc `storeName` từ Sellers API v1 → lưu vào cột mới `connections.seller_accounts.store_name` (migration `0031_shop_store_name.sql`) → hiển thị ngay trên màn Kết nối shop, kèm nút **[⤓ Đồng bộ tên shop Amazon]** và tự lấy tên **ngay sau khi shop authorize** (callback OAuth).

---

## 2. Bằng chứng từ mô hình chính thức của Amazon

Nguồn: repo `amzn/selling-partner-api-models` → `models/sellers-api-model/sellers.json`
(link chủ dự án gửi: https://github.com/amzn/selling-partner-api-models).

### 2.1 Endpoint trả tên shop

```
GET https://sellingpartnerapi-na.amazon.com/sellers/v1/marketplaceParticipations
Header: x-amz-access-token: <LWA access token>
```

Response (200):

```json
{
  "payload": [
    {
      "marketplace": {
        "id": "ATVPDKIKX0DER",
        "name": "Amazon.com",          ← TÊN SÀN (không phải tên shop)
        "countryCode": "US",
        "defaultCurrencyCode": "USD",
        "defaultLanguageCode": "en_US",
        "domainName": "www.amazon.com"
      },
      "participation": { "isParticipating": true, "hasSuspendedListings": false },
      "storeName": "BestSellerStore"   ← TÊN SHOP TRÊN AMAZON (thứ đang bị thiếu)
    }
  ]
}
```

Definition chính thức (trích nguyên văn `sellers.json`):

```json
"MarketplaceParticipation": {
  "type": "object",
  "required": ["marketplace", "participation", "storeName"],
  "properties": {
    "marketplace": { "$ref": "#/definitions/Marketplace" },
    "participation": { "$ref": "#/definitions/Participation" },
    "storeName": {
      "type": "string",
      "description": "The name of the seller's store as displayed in the marketplace."
    }
  }
}
```

→ `storeName` là **field bắt buộc**, và Amazon ghi rõ nó CHÍNH LÀ tên shop hiển thị trên sàn. `marketplace.name` chỉ là tên sàn.

### 2.2 Từ khi nào có field này

Changelog SP-API **18/12/2024** ("New: Introducing SP-API support for third-party providers"), mục *Sellers API v1*:

> `getMarketplaceParticipations`: Returns a list of marketplaces where the seller can list items and information about the seller's participation in those marketplaces. **The response now contains a `storeName`, which you can use to get the name of the seller's store as displayed in the marketplace.**

→ Token/app authorize **trước** mốc này có thể chưa thấy field. Cách xử lý: authorize lại shop (nút [Kết nối lại]) — bản sửa đã báo đúng tình huống này trong UI.

### 2.3 Role & rate limit (không phải nguyên nhân, nhưng cần biết)

- `getMarketplaceParticipations`: **không cần role đặc biệt**, rate limit **0.016 request/giây (burst 15)** — đừng bấm đồng bộ liên tục.
- `getAccount` (`GET /sellers/v1/account`) là API **khác**, trả `business.name` (tên pháp lý) + `sellingPlan`, nhưng **đòi role Account Information Service Provider (AISP)**. Bản sửa **không dùng** endpoint này — không cần xin thêm role, vì `storeName` đã nằm trong Participations.

---

## 3. Trước khi sửa: dữ liệu rơi ở đâu

```
Amazon (storeName: "VEXIM Store US")
   │  GET /sellers/v1/marketplaceParticipations    ✅ Amazon trả về bình thường
   ▼
parseMarketplaces()                                 ❌ bỏ qua storeName
   │  → { id, name: "Amazon.com", countryCode, currencyCode, domainName, isSuspended }
   ▼
discoverSellerIdentity()                            ❌ không có field storeName trong kết quả
   ▼
/api/amazon/whoami  → JSON chẩn đoán                ❌ không trả tên shop
   ▼
DB connections.seller_accounts                      ❌ không có cột store_name
   │  display_name = 'VEXIM US - Chính' (seed tay ở 0009/0024)
   ▼
Màn /module0/connect (ShopConnectTable)             ⚠️ chỉ hiện display_name → "không thấy tên shop Amazon"
```

Bằng chứng trong code (trước khi sửa): `grep -ri "storeName" .` → **0 kết quả** trong toàn repo.

---

## 4. Đã kiểm tra & xác nhận KHÔNG lỗi (checklist API)

| Hạng mục | Kết quả |
|---|---|
| Host theo vùng | ✅ NA → `sellingpartnerapi-na.amazon.com` (US/CA đúng vùng NA) |
| Path | ✅ `/sellers/v1/marketplaceParticipations` khớp đặc tả |
| Header auth | ✅ `x-amz-access-token` (SP-API mới không cần SigV4) |
| Lấy access token | ✅ `POST https://api.amazon.com/auth/o2/token`, `grant_type=refresh_token` |
| `Accept` / `User-Agent` | ✅ có, đúng chuẩn |
| Role cho Participations | ✅ không cần role riêng |
| Rate limit | ✅ 0.016 rps — luồng hiện tại gọi 1 lần/ngày, không vượt |
| OAuth (lấy refresh token) | ✅ `spapi_oauth_code` + `selling_partner_id` đọc đúng — **kết nối thành công chính là bằng chứng** |
| Kết nối ra Amazon từ server | ✅ cron/worker đã gọi SP-API thành công |
| `storeName` trong response | ❌ **bị code bỏ qua** ← đây là lỗi duy nhất |

**Các lỗi API khác có thể làm mất tên shop** đã được dịch thành câu tiếng Việt cụ thể (thay vì im lặng):

| Lỗi | Câu hiển thị |
|---|---|
| `invalid_grant` | "Refresh token của shop không còn hiệu lực… Vào Kết nối shop, bấm [Kết nối lại]" |
| HTTP 403 | "SP-API từ chối 403… app chưa được cấp quyền / Draft thiếu Test Accounts" |
| HTTP 401 | "Kiểm tra AMAZON_SP_API_REGION (US/CA phải là NA) và refresh token" |
| HTTP 429 | "Vượt rate limit 0.016 request/giây — chờ vài giây rồi bấm lại" |
| 200 nhưng thiếu `storeName` | "storeName có từ 18/12/2024 — token tạo trước đó chưa có field; thử authorize lại shop" |
| Chưa chạy migration 0031 | "Chạy migration supabase/migrations/0031_shop_store_name.sql" |
| Shop chưa authorize | "Shop chưa authorize app (không có refresh token) — bấm [Kết nối]" |

---

## 5. Bản sửa đã thực hiện

### 5.1 Đọc & mang tên shop đi tiếp

| File | Thay đổi |
|---|---|
| `web/src/lib/spapi/whoami.ts` | `MarketplaceInfo` thêm `storeName`; `normalizeStoreName()`; `storeNameForMarketplace()`; `storeNameTable()`; `WhoamiResult` thêm `storeName` + `storeNames[]` theo từng marketplace; `sqlHint` sinh kèm cột `store_name` (có escape `'O''Brien'`); không bao giờ lấy `marketplace.name` thay cho tên shop |
| `web/src/lib/spapi/shop-name.ts` **(mới)** | Module thuần + injectable `fetch`: đổi refresh token → access token → gọi Participations; `extractStoreNames()`, `storeNameOf()`, `explainStoreNameFailure()`; host theo vùng |
| `worker/src/amazon/sellers.ts` | Hết stub "sau này sẽ gọi getMarketplaceParticipations" → client thật: `getMarketplaceParticipations()`, `getStoreName()`, `explainParticipationsError()` |
| `web/src/app/api/amazon/whoami/route.ts` | Trả thêm `storeName` + `storeNames[]` + ghi chú giải thích từng marketplace |

### 5.2 Lưu vào DB — migration `0031_shop_store_name.sql`

- 3 cột mới trên `connections.seller_accounts`: `store_name`, `store_name_source` (`spapi`/`manual`), `store_name_synced_at`.
- View `public.vexim_shops` phơi thêm `store_name` + `store_name_synced_at` (thêm ở cuối, khớp `SHOP_SELECT_V3`).
- RPC `public.vexim_worker_set_shop_store_name(uuid, text, text)` — chỉ `service_role`, **tên rỗng không ghi đè** (Amazon thiếu field thì giữ tên cũ).
- RPC `public.vexim_worker_list_shop_credentials()` — chỉ `service_role`, trả shop + token để lấy tên bằng **đúng token của shop đó**.
- **Không** thêm policy ghi nào cho web (RLS `seller_accounts` vẫn select-only); **không** đụng `display_name`.

### 5.3 Lấy tên ngay khi kết nối + đồng bộ tay

| File | Thay đổi |
|---|---|
| `web/src/app/api/oauth/amazon/callback/route.ts` | Sau khi lưu refresh token: gọi Participations bằng **chính token vừa đổi được** → lưu `store_name`; lỗi bước này **không làm hỏng kết nối**; redirect kèm `shop`/`store`/`storeMsg` |
| `web/src/lib/data/shop-names.ts` **(mới)** | `syncShopStoreNames()` (quét 1 hoặc tất cả shop) · `syncStoreNamesWithFreshToken()` (callback) · `listShopCredentials()` · `saveShopStoreName()`; gom theo `seller_id` nên 2 marketplace US+CA chỉ tốn 1 lần gọi API |
| `web/src/app/(app)/module0/connect/actions.ts` **(mới)** | Server action `syncStoreNamesAction()` — chỉ quản trị (persona `ceo`) + phiên Supabase |
| `web/src/app/(app)/module0/connect/ShopConnectTable.tsx` | Hiện "🏪 Tên trên Amazon: …" từng shop · nút **[⤓ Đồng bộ tên shop Amazon]** · nút riêng từng shop khi chưa có tên · banner kết quả |
| `web/src/app/(app)/module0/connect/page.tsx` | Banner sau OAuth nói rõ tên shop vừa lấy được (hoặc lý do chưa có) |
| `web/src/lib/data/oauth.ts` | `SHOP_SELECT_V3` (có `store_name`) → tự lùi V2/V1 nếu chưa chạy 0031 ⇒ deploy code trước migration không vỡ màn |

### 5.4 Quy tắc an toàn khi ghi tên shop

1. **Mỗi shop dùng đúng refresh token của shop đó** (bảng `oauth_tokens`) — không mượn token shop khác ⇒ không thể ghi tên shop A cho shop B.
2. Token self-authorization trong env (`AMAZON_LWA_REFRESH_TOKEN`) **chỉ** dùng khi `seller_id` của shop trùng seller của token (`AMAZON_SELF_SELLER_ID`, mặc định `AQMVYI4HJTI4C`).
3. `storeName` là **theo từng marketplace** (US và CA có thể đặt tên khác nhau) ⇒ tra đúng `marketplace` của từng dòng.
4. Chỉ ghi khi Amazon thật sự trả tên; **không** ghi chuỗi rỗng, **không** xoá tên cũ.

---

## 6. Kiểm chứng (đã chạy thật)

| Bộ test | Kết quả |
|---|---|
| `cd worker && npm test` | **481/481 PASS** — gồm `tests/shop-name.test.ts` (9 test mới) + `tests/shop-name-sync.test.ts` (12 test mới) + `tests/whoami.test.ts` (13 test, thêm 3 test `storeName`) |
| `cd supabase && npm test` | **TẤT CẢ PASS** — BƯỚC 31 mới kiểm chứng 0031 trên Postgres 18 (PGlite): chạy 2 lần idempotent, hợp đồng 12 cột của view, chặn web gọi RPC, tên rỗng không ghi đè, web đọc được qua view, và đường "nhảy cóc 0024" vẫn dựng lại được view |
| `cd web && npx tsc --noEmit` | ✅ sạch |
| `cd web && npm test` | ✅ 357/357 PASS |
| `cd web && npm run build` | ✅ build thành công (route `/module0/connect` + server action mới) |

Sửa thêm 2 test đỏ sẵn có (không liên quan tên shop): `worker/tests/ads-jobs.test.ts` phần `oauth-reminder` dùng mốc thời gian cứng `2026-09-13` trong khi mock đếm ngày bằng đồng hồ thật ⇒ đỏ dần theo lịch. Nay fixture tính theo `Date.now()`.

---

## 7. VEXIM cần làm (3 bước, ~5 phút)

1. **Chạy migration 0031** — Supabase → SQL Editor → dán `supabase/migrations/0031_shop_store_name.sql` → Run
   (hoặc `bash supabase/apply-migrations.sh`). Migration idempotent, chạy lại vô hại.
2. **Redeploy web** (Vercel) để nhận code mới.
3. Mở **Module 0 → Kết nối shop** → bấm **[⤓ Đồng bộ tên shop Amazon]**:
   - Thấy `🏪 Tên trên Amazon: "…"` ⇒ xong.
   - Không thấy ⇒ banner vàng nói rõ lý do (token hỏng / 403 / chưa kết nối / chưa chạy migration).

### Kiểm tra bằng SQL

```sql
select seller_id, marketplace, display_name,
       store_name, store_name_source, store_name_synced_at
from connections.seller_accounts
where status <> 'revoked'
order by seller_id, marketplace;
```

### Kiểm tra bằng API (không cần vào web)

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  https://<domain>/api/amazon/whoami | jq '{storeName, storeNames, sellerId}'
```

---

## 8. Câu hỏi thường gặp sau khi sửa

**Nhãn shop vẫn là "VEXIM US - Chính", không phải tên Amazon?**
Đúng theo thiết kế: `display_name` là nhãn vận hành VEXIM đặt (dùng trong báo cáo, phân quyền, SOP), `store_name` là tên Amazon. Màn Kết nối shop hiện **cả hai**. Nếu muốn dùng tên Amazon làm nhãn chính:

```sql
update connections.seller_accounts
set display_name = store_name
where store_name is not null and display_name is distinct from store_name;
```

**Có phải xin thêm role với Amazon không?** Không. `storeName` nằm trong `getMarketplaceParticipations` mà app đã dùng.

**Shop báo "Chưa có tên Amazon — bấm để lấy" nhưng bấm không ra?**
Xem banner vàng: lỗi được dịch sẵn (mục 4). Hay gặp nhất là shop chưa authorize (chưa có refresh token) hoặc token đã bị thu hồi → bấm [Kết nối lại].

**Bấm nhiều lần có sao không?** Rate limit 0.016 req/giây; nút tự khoá trong lúc chạy, nhưng đừng bấm liên tục — thấy 429 thì chờ vài giây.

**Tên shop tự cập nhật mỗi ngày?** Hiện lấy ở 2 thời điểm: ngay sau khi authorize + khi bấm nút đồng bộ. Muốn chạy tự động định kỳ thì nối `syncShopStoreNames()` vào cron (hàm đã sẵn, chỉ cần gọi).

---

## 9. Tóm tắt một câu

> Kết nối shop vẫn đúng, token vẫn tốt — chỉ là code **chưa từng đọc field `storeName`** mà Amazon vẫn trả về, và DB/UI cũng chưa có chỗ cho nó. Nay tên shop được lấy đúng theo từng marketplace, lưu vào `store_name`, hiển thị ngay trên màn Kết nối shop, và mọi lỗi phát sinh đều được nói rõ nguyên nhân thay vì im lặng.
