# TIẾN ĐỘ TRIỂN KHAI — VEXIM OPS

> Cập nhật: 13/09/2026 · Thứ tự build đã chốt: **0 → 7 → 4 → 3 → 1(đọc) → 2 → 6(đọc)** (21 màn Đợt 1)

## Cập nhật 13/09 — MODULE 0: NGƯỜI DÙNG & PHÂN QUYỀN LÀM THẬT (migration 0022)

Anh Hồ Lương Văn mở `/module0/users` và thấy 6 tài khoản (`haianh@vexim.vn`, `mylinh@…`,
`tuan@…`, `ha@…`, `lan@…`, `contact@khacha-a.vn`) cùng 3 nút **Sửa · Quyền · Khóa** bấm
không được. Kiểm tra ra **2 sự thật khác nhau** — cả hai đều phải sửa:

1. **6 tài khoản đó là DỮ LIỆU GIẢ** — chỉ tồn tại trong mảng viết cứng
   `web/src/lib/data/mock.ts`, chưa từng được `insert` vào DB ⇒ **không có mật khẩu, không
   đăng nhập được, không phải nhân viên**. Đã **xoá hẳn** khỏi `mock.ts` (kèm type
   `UserRow`). Chế độ demo (chưa cấu hình Supabase) dùng danh sách giả lập mới
   `(app)/module0/users/demo-users.ts` với email `@vexim.example` và một dải cảnh báo
   "CHẾ ĐỘ DEMO" ngay trên bảng — không thể lẫn với người thật.
2. **3 nút bị `disabled` vì là màn demo**, không phải lỗi phân quyền. Nay chúng gọi RPC
   thật, và **luật quyền nằm ở DB**, không ở giao diện.

### Migration 0022 làm gì

| Phần | Nội dung |
|---|---|
| `iam.user_profiles.status` | `active` · `invited` · `suspended` (+ backfill người chưa từng đăng nhập & chưa có vai trò ⇒ `invited`) |
| `iam.role_level()` · `iam.user_level()` · `iam.is_user_admin()` | cấp bậc vai trò + ai được quản trị người dùng (super_admin/org_admin; trưởng phòng chỉ trong phòng mình) |
| **Khóa = mất quyền THẬT** | vá 4 hàm lõi `iam.has_role` · `iam.current_org_id` · `iam.can_read_seller_account` · `iam.can_write_seller_account`: tài khoản `suspended` ⇒ luôn `false`. Nhờ vậy **mọi** bảng/view/RPC đều chặn, không cần sửa từng policy — và chặn **ngay**, không đợi JWT hết hạn |
| 6 RPC cho web | `vexim_admin_users` (danh sách thật, trả cả `shop_ids`) · `vexim_admin_update_user` (sửa hồ sơ + khóa/mở) · `vexim_admin_set_user_access` (vai trò + phòng + shop) · `vexim_admin_audit` (nhật ký) · `vexim_admin_grant_invited_user` (ghi hồ sơ cho tài khoản vừa mời) · `vexim_touch_login` (điểm danh `invited` → `active`) |

**Luật chống leo thang (đều kiểm bằng SỐ, không so chuỗi):** không ai tự đổi vai trò / tự
khóa mình · không đụng người có cấp cao hơn · chỉ gán được vai trò **thấp hơn** mình (khớp
ma trận `canAssign` sẵn có) · org_admin không đụng super_admin · vai trò vận hành phải thuộc
một phòng ban · tài khoản đang khóa thì không cấp lại quyền (phải mở khóa trước) · tài khoản
đang khóa thì mời lại **không tự hồi sinh**.

### Hai lỗi âm thầm phát hiện thêm khi làm (đã sửa trong cùng đợt)

* **`/api/admin/invite-user` chết trong production.** Route cũ tự kiểm vai trò rồi
  `insert` thẳng vào `iam.user_profiles` / `role_assignments` / `assignments` bằng phiên của
  người dùng — nhưng role `authenticated` **chưa từng được GRANT insert/update** trên các
  bảng đó (0001 chỉ grant `select`) ⇒ mời người dùng sẽ báo `permission denied`. Nay route
  chỉ còn gọi GoTrue (cần `service_role`) rồi để DB ghi qua RPC; luật quyền có **một nguồn
  sự thật**.
* **Policy `rls_upd_user_profiles_self` (0004) là policy chết**: user tự sửa hồ sơ mình
  nhưng thiếu grant cột ⇒ "Thông tin cá nhân" ở chế độ Supabase cũng `permission denied`.
  0022 cấp `UPDATE (display_name, phone, avatar_url, mfa_enabled)` — đúng 4 cột, không cấp
  cả bảng.

Thêm một điểm phải nhớ khi đọc code: trong SUPABASE MODE, `session.persona` **luôn là
`ceo`** (TODO Tier 1 ở `lib/auth/session.ts`) ⇒ **không được** dùng persona để chặn trang
này. Trang gọi RPC và để DB từ chối; người không phải admin thấy màn "Không có quyền" kèm
lý do từ database.

### Kiểm chứng

* `supabase` harness: **592 PASS / 0 FAIL** (BƯỚC 23 mới — 24 phép thử cho 0022, gồm cả
  phép thử **tài khoản bị khóa mất quyền đọc/ghi ở tầng RLS**, leo thang, tự khóa mình,
  mời lại người đang khóa, điểm danh đăng nhập, quyền của trưởng phòng).
* `web`: **184 test** (+10 test `users-admin`: thứ bậc vai trò · luật ẩn/hiện 3 nút ·
  trạng thái · nhãn audit · dữ liệu demo không dùng email thật) · `tsc` sạch · `next build`
  qua · chạy thật ở chế độ demo: `/module0/users` hiện bảng giả lập có dải cảnh báo, đúng
  **3 nút bị tắt kèm lý do** (tự đổi quyền mình · tự khóa mình · tài khoản đang khóa), 0
  email thật còn sót.

### Việc VEXIM cần làm

* ☐ Chạy **`0022_user_admin.sql`** sau 0021 (không phụ thuộc dữ liệu cũ, có DO-block tự soát).
* ☐ Mở `/module0/users` bằng `hocluongvan88@gmail.com` → sẽ thấy **1 dòng thật** (chính anh)
  thay vì 6 tài khoản giả; từ đó "Thêm người dùng" tạo người thật và 3 nút hoạt động.

## Cập nhật 13/09 — VÁ UI MENU TRÁI trước khi bàn giao Ops (active 2 dòng · số mock)

Hai lỗi Ops báo khi nhận Module 5:

1. **Hai mục menu cùng sáng cam.** Ở `/ppc/search-terms` thì cả *Quảng cáo (PPC)* lẫn
   *Search term & chặn (A3)* đều được tô nền — vì logic cũ
   `pathname === href || pathname.startsWith(href + "/")` coi mục CHA là khớp khi đang ở
   mục CON. Sửa bằng cách **chọn href khớp dài nhất** (`activeHrefFor` trong `lib/roles.ts`,
   thuần nên test được): mục con thắng mục cha, trang con không có trong menu
   (`/ppc/campaigns/C-1`) vẫn sáng mục cha gần nhất, và khớp theo **biên đoạn** nên `/ppcx`
   KHÔNG bị tính là `/ppc`. Đã kiểm cho **toàn bộ menu** (mọi href của cả 4 vai trò) chứ
   không chỉ vá mỗi `/ppc`.
2. **Số đỏ cạnh menu là số mock cứng** (5 · 7 · 12 · 3…) nằm trong `roles.ts`. Một con số
   đỏ là *lời hứa* "có 12 việc đang chờ" — bấm vào không thấy thì mất niềm tin cả dashboard.
   Đã **gỡ hẳn trường `count`** khỏi `NavItem` và thay bằng `readNavBadges()`
   (`lib/data/nav-badges.ts`): đếm thật bằng `select("*", { count: "exact", head: true })`
   (Postgres đếm, KHÔNG kéo dòng nào về) trên view có RLS, mỗi badge một dòng trong
   `NAV_BADGE_SPECS`. Hiện nối 2 badge đã có định nghĩa rõ "cần người xử lý":
   `/ppc` = yêu cầu **chờ trưởng phòng duyệt** (`vexim_ads_changes.status='pending_approval'`),
   `/ppc/search-terms` = gợi ý negative **đang chờ duyệt** (`vexim_ads_negative_suggestions.status='pending'`).
   Các mục còn lại **không hiện gì** cho tới khi có query thật (thà trống còn hơn số sai);
   query lỗi ⇒ badge biến mất, không làm sập layout.

**Kiểm chứng:** `web` **174 test** (+5 test menu: chỉ 1 mục sáng · toàn bộ menu · 4 vai trò ·
biên đoạn · không còn số mock) · `tsc` sạch · `next build` qua · chạy thật: 8 đường dẫn
(`/ppc`, `/ppc/search-terms`, `/ppc/approvals`, `/ppc/campaigns/C-DEMO-01`, `/finance/claims`,
`/listing/editor`, `/module0/users/new`, `/dashboard`) đều đúng **1 mục sáng** và **0 badge**
ở chế độ demo.

## Cập nhật 13/09 — MODULE 5 PHẦN 2 & 3 (A2 · A3 · GHI NGƯỢC LÊN AMAZON: hàng đợi duyệt > 30%/ngày · audit · REVERT 1 chạm) — migration 0021

Phần 2 (đọc sâu) và phần 3 (ghi thật) của Module 5 đã xong trong cùng một đợt, vì
**A3 không có nghĩa nếu bấm "chặn" mà không có đường ghi**. Một đường ghi duy nhất:

```
web (RPC 0021)  →  ads.change_requests (hàng đợi + máy trạng thái)
                →  worker:ads-apply / cron 03:00  →  Amazon Ads API v3 (PUT/POST)
                →  ghi kết quả + iam.audit_logs  →  gương DB (campaign/target/negative)
```

### Luật duyệt nằm ở DB, không ở màn hình (SOP-05 bước 4)

- `ads.approval_reason(action, before, after, entity)`: `pct = round((after−before)*100/before, 1)`,
  **> 30 ⇒ "Tăng X%/ngày > 30% (SOP-05 bước 4) ⇒ cần trưởng phòng PPC duyệt."**
- Trigger `ads.change_request_guard` **tính LẠI `requires_approval` khi INSERT** ⇒ client gửi
  `requiresApproval: false` cũng vô ích (đã có test đúng ca này).
- Không đọc được giá trị cũ (before NULL/≤ 0) ⇒ **đòi duyệt** (không đoán).
- Tăng bid > 30% cũng cần duyệt (tiền chảy như nhau); **GIẢM** giá ⇒ tự duyệt.
- `PAUSED → ENABLED` (bật lại) ⇒ cần duyệt; `ENABLED → PAUSED` (chặn chi tiêu) ⇒ tự chạy.
- **Negative keyword KHÔNG cần ngưỡng** (là hành động giảm chi tiêu) nhưng vẫn đi cùng đường ghi
  và vẫn có audit.
- Người yêu cầu CHÍNH LÀ trưởng phòng PPC ⇒ tự duyệt, `decided_by` vẫn ghi rõ (audit đọc được).
- Người duyệt: `iam.is_ads_approver()` = `super_admin`/`org_admin` **hoặc `dept_lead` phòng PPC**
  (trưởng phòng Listing không duyệt được thay đổi quảng cáo — có test chặn).

### Máy trạng thái + chống mất dấu khi Amazon throttle

`pending_approval → approved|rejected|cancelled` · `approved → applying|cancelled` ·
`applying → applied|failed|approved (trả lại hàng đợi khi 429/5xx)` · `failed → approved|cancelled`.
Dòng `applied` **không sửa được nội dung** (bằng chứng audit, trigger chặn UPDATE).
`attempts` tăng mỗi lần claim; RPC `vexim_worker_release_ads_change` đưa dòng `applying` về
`approved` **giữ nguyên số lần thử** ⇒ sáng hôm sau worker gửi tiếp, **không bắt trưởng phòng duyệt lại**.

### Ghi lên Amazon — Ads API v3 (4 lời gọi)

| Việc | API | Ghi chú |
|---|---|---|
| Ngân sách ngày | `PUT /sp/campaigns` | `{campaignId, budget:{budgetType:"DAILY", budget:round2(v)}}` |
| Bid từ khoá | `PUT /sp/keywords` | bid làm tròn 2 chữ số; state `ENABLED`/`PAUSED` |
| Thêm negative | `POST /sp/negativeKeywords` | `NEGATIVE_EXACT`/`NEGATIVE_PHRASE`, `state: ENABLED` |
| Đọc negative | `GET /sp/negativeKeywords` | đồng bộ về gương `ads.negative_keywords` |

**HTTP 200 KHÔNG phải thành công.** Ads v3 trả 200 kèm `[{code:"INVALID_ARGUMENT"}]`; nặng hơn,
có lần trả 200 + `[]` (không phần tử nào). `normalizeWriteResponse` xử lý cả hai:
`ok = sentCount > 0 && items.length > 0 && failed === 0`. Thất bại ⇒ **KHÔNG ghi giá trị cục bộ**
(không để DB khoe số mà Amazon chưa hề nhận) + ghi `error` để người vận hành đọc.

### An toàn dữ liệu của worker (đúng như 2 job Ads trước)

- Chỉ ghi DB thật khi `mode === "production"`; thiếu credential Ads ⇒ `skipped` kèm hướng dẫn,
  **không bắn yêu cầu nào lên Amazon**.
- Thiếu `ads_profile_id` ⇒ dừng yêu cầu đó (không đoán profile — ghi sai shop là tiêu tiền sai shop).
- 401/403 ⇒ **trả lại hàng đợi** (không tính là thất bại, không bắt duyệt lại) + `needsReauth` để
  Module 0 nhắc kết nối lại.
- 429/5xx ⇒ trả lại hàng đợi, tối đa `maxAttempts = 5` rồi mới `failed`.

### Màn hình

- **A2 `/ppc/campaigns/[campaignId]`** — ad group → từ khoá/nhóm sản phẩm: đổi bid, tạm dừng/bật lại
  từ khoá, nới ngân sách campaign, danh sách negative đã chặn. Bấm campaign ở A1 là sang A2.
- **A3 `/ppc/search-terms`** — bảng search term với **bộ lọc mặc định = luật SOP-04** (≥ 5 click ·
  chi ≥ 10 · 0 đơn trong 7 ngày), gợi ý Exact/Phrase kèm **bằng chứng + lý do + độ tin cậy**;
  duyệt/từ chối từng gợi ý; dòng **đã chặn thì không hiện nút** (chống tạo yêu cầu trùng).
- **P3 `/ppc/approvals`** — 3 nhóm: *chờ trưởng phòng duyệt* (chưa gửi gì lên Amazon) · *đã duyệt
  chờ worker gửi* · *đã xong*; nút Duyệt/Từ chối/Huỷ + **REVERT 1 chạm** cho Ops; kèm nhật ký
  `iam.audit_logs` đọc từ `vexim_ads_audit`.
- Web **không** dùng service_role, **không** ghi thẳng bảng: mọi nút đi qua 5 RPC `vexim_*` của 0021
  (RLS + `iam.can_write_seller_account` quyết định quyền). Hai hàm hỏi quyền
  (`vexim_can_ads_approve`, `vexim_can_write_ads`) chỉ để **ẩn/hiện nút cho đúng** — không phải phân quyền.

### REVERT 1 chạm (Ops)

Revert **không sửa dòng cũ**: nó tạo một yêu cầu MỚI đi ngược lại (`payload.revertOf = id gốc`), dòng gốc
được đánh dấu `reverted_by` và **mất nút Revert** (chống đảo hai lần). Đảo một lần giảm giá ⇒ tự duyệt;
đảo một lần tăng ngân sách ⇒ vẫn phải qua trưởng phòng. Negative keyword **không revert qua API**
(Amazon không có endpoint xoá theo cách này) — DB từ chối và nói rõ phải xoá trên console rồi sync lại.

### Vá lỗi RLS tự tham chiếu (phát hiện khi đọc tên người duyệt)

Khi làm hàng đợi duyệt thì thấy **không đọc được tên người yêu cầu/người duyệt**: policy đọc của
`iam.user_profiles` / `iam.role_assignments` / `iam.assignments` (và 3 policy của `ops.*`) **truy vấn
vòng tròn chính bảng bị RLS bảo vệ** ⇒ Postgres báo `infinite recursion detected in policy for relation`
và **mọi câu SELECT trên các bảng đó đều lỗi** cho user thật (không phải lỗi quyền — là lỗi hạ tầng).
0021 §0 vá bằng 2 hàm `SECURITY DEFINER` (`iam.has_role(text[])`, `iam.current_org_id()`) rồi tạo lại
11 policy với **đúng ngữ nghĩa cũ**; harness có test cho cả hai chiều (đọc được hồ sơ của mình +
không thấy hồ sơ người khác, hết đệ quy ⇒ đọc được `ops.alert_rules`).

### Kiểm chứng đợt này

```bash
cd supabase && npm test    # BƯỚC 22 của 0021: 551 kiểm tra — TẤT CẢ PASS (gồm 429→release→thử lại, revert, RLS, tự soát)
cd worker   && npm test    # 443 test (39 test mới cho chiều GHI: payload v3 · 200-vẫn-là-lỗi · claim chỉ dòng đã duyệt · release khi throttle)
cd web      && npm test    # 169 test (8 test mới: bộ lọc SOP-04 · nhãn trạng thái · % hiển thị · hợp đồng cột)
cd web      && npx tsc --noEmit && npx next build   # sạch
```

### CÒN LẠI của Module 5

1. Chạy `0021` trên Supabase rồi `npm run worker:ads-sync` → `ads:pull` → **`ads:apply`** (lần đầu nên
   `--dry-run` để xem worker sẽ gửi gì).
2. Gợi ý negative do job tổng hợp sinh trong `ads.negative_suggestions` (0020) — phần A3 chỉ **duyệt**;
   muốn tinh chỉnh ngưỡng gợi ý thì sửa rule `ads.negative_suggestions` của 0020.
3. Amazon Marketing Stream (giờ cạn ngân sách) vẫn là hạng mục chưa làm — Reporting v3 không có hourly.

## Cập nhật 13/09 — MODULE 5 PHẦN 1 (AMAZON ADS: campaign số thật + cảnh báo ACOS/ngân sách + ads_spend → F4/TACOS) + MODULE 0: KẾT NỐI SHOP THẬT (migration 0020)

Module 5 chia 3 phần như cách đã làm với Module 3. **Phần 1 (đợt này) = đọc + A1 chạy số thật**:
cấu trúc campaign/ad group/từ khoá + 5 report metrics theo ngày + cảnh báo tự nổ + tiền quảng cáo
chảy vào F4 để có TACOS thật. Phần 2 (A2 chi tiết campaign · A3 search term & gợi ý negative) và
phần 3 (ghi ngược lên Amazon: đổi ngân sách/bid, thêm negative — cần ngưỡng duyệt + audit log) làm sau.

### Vì sao Ads phải làm KHÁC SP-API (ba sự thật chi phối toàn bộ thiết kế)

1. **Ads là đăng ký riêng** — LWA client/secret/refresh token riêng, KHÔNG dùng chung app SP-API.
   Vì vậy `config.ts` đọc `AMAZON_ADS_*` (có fallback `ADS_LWA_*`), và `AMAZON_ADS_REGION` quyết định
   host: `advertising-api.amazon.com` (NA) / `-eu` / `-fe`. Thiếu credential ⇒ job trả `skipped` kèm
   hướng dẫn, KHÔNG throw (một biến môi trường thiếu không được làm đỏ dashboard).
2. **Reporting v3 CHỈ có `DAILY` và `SUMMARY`** — không có `HOURLY`. Nên `budget_exhausted` biết *ngày*
   cạn ngân sách nhưng **không biết giờ**: `ads.budget_events.hour_source='unavailable'`,
   `exhausted_hour=NULL`, và giao diện nói thẳng "chưa biết giờ" thay vì bịa. Muốn có giờ phải dùng
   Amazon Marketing Stream (chưa làm).
3. **v3 không trả ACOS/ROAS/CPC/CTR** — đây là *số suy ra*. Hệ thống KHÔNG lưu chúng vào bảng
   (lưu là chúng lệch ngay sau lần nhập lại) mà tính trong view từ `cost ÷ sales`.
   Ngoài ra API chỉ giữ dữ liệu ~60 ngày ⇒ `lookbackDays` mặc định 30.

### Migration `0020_ads_ppc.sql` (~3.200 dòng, idempotent + DO-block tự soát 21 mục)

- **7 bảng mới + 1 bảng trạng thái**: `ads.profiles` · `ads.campaigns` (mở rộng) · **`ads.ad_groups`** ·
  **`ads.targets`** (keyword + product target chung một bảng) · **`ads.campaign_metrics_daily`** ·
  **`ads.target_metrics_daily`** · **`ads.search_terms`** (theo campaign × ad group × từ khoá) ·
  **`ads.advertised_product_metrics_daily`** · **`ads.purchased_product_metrics_daily`** ·
  **`ads.budget_events`** · **`ads.negative_suggestions`** + **`connections.oauth_states`** (state OAuth
  dùng một lần).
- **Cửa sổ quy đổi lưu riêng**: `sales_7d/14d/30d`, `purchases_7d/14d/30d`, `units_sold_clicks_*`
  (≡`units_7d`) — **tuyệt đối không cộng chéo các cửa sổ** (cộng là ra "doanh thu ảo" gấp 3).
- **16 RPC `vexim_worker_*` service_role**: upsert profile/campaign/ad group/target/metrics theo campaign/
  metrics theo target/search term/sản phẩm được quảng cáo/sản phẩm đã mua/campaign gợi ý negative/sự kiện
  ngân sách, **`apply_ads_spend`** (lấp `finance.sku_profit_daily.ads_spend`), và 5 RPC Module 0
  (`set_oauth_token`, `create_oauth_state`, `consume_oauth_state`, `mark_oauth_notice`, `oauth_soon`).
  Mọi RPC trả bộ đếm `inserted/updated/skipped/merged` (+`days`,`currencies`) — nhập lại cùng dữ liệu là
  `updated`, **không phình bảng**.
- **10 view**: `vexim_ads_profiles` · **`vexim_ads_campaigns`** (A1: spend hôm qua/7/14/30 ngày, ACOS
  7/14/30 + ROAS 7 suy ra, `budget_state` capped/ok/no_data/unknown, số ngày cạn 30 ngày) ·
  `vexim_ads_targets` (A2) · `vexim_ads_search_terms` (A3 + gợi ý negative đang chờ) ·
  `vexim_ads_negative_suggestions` · `vexim_ads_budget_events` (`hour_known`) · `vexim_ads_sku_spend`
  (`sku_source`) · `vexim_ads_account_daily` · `vexim_ads_kpi` (TACOS) · `vexim_oauth_connections`.
  9 view `security_invoker` (RLS bảng gốc vẫn áp); riêng view token KHÔNG invoker vì
  `connections.oauth_tokens` không có policy cho client — nó tự lọc bằng
  `iam.can_read_seller_account()` và **không phơi cột token**.
- **3 rule cảnh báo**: `acos_over_target` (ACOS 7 ngày > 25%) · `budget_exhausted` (dùng ≥ 95% ngân sách
  ngày) · `oauth_reauth_due` (token còn ≤ 30 ngày). Lưu ý `iam.module_code` **không có `ppc`** ⇒ rule
  quảng cáo nằm ở module `'ads'`, rule token nằm ở `'account_health'`.

### Engine worker (web/src/lib/worker — Vercel Cron chạy trong `web/`)

- **`amazon/ads.ts`** — `AdsClient` (LWA riêng, cache access token, retry ≤30s khi 429/5xx) với
  `/v2/profiles` và Campaign Management v3 `list` (campaign · ad group · keyword + target, đi hết phân
  trang `nextToken`), Reporting v3 `createReport`/`getReport`/`downloadReport` (tự giải nén GZIP_JSON).
  `AdsApiRequestError.isThrottled` (429 — thử lại sau) tách hẳn khỏi `isAuthError` (401/403 — **phải
  re-authorize ở Module 0**); lẫn hai cái này là hỏng cả SOP-11.
- **`ads/registry.ts`** — 5 report (`spCampaigns` · `spTargeting` · `spSearchTerm` · `spAdvertisedProduct` ·
  `spPurchasedProduct`) khai một chỗ: `reportTypeId`, `groupBy`, cột (chỉ cột v3 thật có), `lookbackDays`
  30, `cooldownHours` 4; parser đọc được **mảng JSON · JSON-lines · object bọc mảng**, dòng thiếu khoá bị
  **bỏ + đếm**, không tự tính ACOS.
- **`jobs/ads-sync.job.ts`** — profile → campaign → ad group → target. Ghi **hết** profile token nhìn
  thấy (shop US+CA có 2 profile), ưu tiên profile khớp marketplace.
- **`jobs/ads-report-pull.job.ts`** — clone đúng luật 0019: `cooldownHours` + **poll-không-tạo-mới** qua
  `connections.report_requests` + report rỗng ⇒ `no_data` (không phải lỗi) + `--dry-run` không ghi gì.
  Khác 0019 ở **bước nghiệp vụ sau khi nhập**: tự tạo cảnh báo `acos_over_target` /
  `budget_exhausted` (**tiêu đề cố định** để dedupe 24h không sinh cảnh báo mới mỗi ngày; có ngưỡng tối
  thiểu click/chi để không nhiễu vì campaign nhỏ), ghi `ads.budget_events` (`capped`,
  `hour_source='unavailable'`), và **`apply_ads_spend`** cho report `spAdvertisedProduct` (chỉ UPDATE dòng
  F4 đã có — không tạo dòng lợi nhuận mới, không trộn tiền tệ; SKU thiếu dòng F4 thì **cảnh báo rõ** để
  người vận hành chạy F4 cho ngày đó trước).
- **`run-ads.ts`** (runner dùng chung) + CLI: `npm run worker:ads-sync` · `npm run worker:ads-pull`
  (`--kind=…` `--days=30` `--poll=3` `--dry-run`; nạp file tay bằng `--campaigns=<file.json>` …) ·
  `npm run worker:oauth-soon` (`--mark` mới tạo cảnh báo).
- **Cron** `/api/cron/report-pull` giờ chạy 3 bước: report FBA → cấu trúc Ads → report Ads
  (`?ads=0` để tắt, `?adsKinds=campaigns,targeting` để giới hạn). **Vercel Hobby chỉ cho 2 cron/ngày** nên
  không thêm cron thứ ba; cron vẫn poll tối đa 2 lần rồi ghi trạng thái để lần chạy sau nối tiếp.

### A1 chạy số thật + TACOS thật

- `web/src/lib/data/ppc.ts` + `ppc-model.ts` đọc `vexim_ads_kpi`, `vexim_ads_campaigns`,
  `vexim_ads_budget_events`, `vexim_ads_negative_suggestions`, `vexim_sku_profit`.
- Màn **`/ppc`**: KPI (chi 7 ngày · ACOS 7 ngày · ROAS · **TACOS** · đơn từ quảng cáo), bảng campaign
  (trạng thái ngân sách + ACOS 7/14 + ROAS + CTR/CPC + đơn), panel "Vì sao hết đơn giữa ngày"
  (ngày cạn ngân sách, nói rõ *chưa biết giờ*), và danh sách việc phần 2/3 còn thiếu. Demo mode vẫn là
  dữ liệu minh hoạ; **chưa có dữ liệu Ads ⇒ màn hình hiện đúng 2 lệnh cần chạy**, không hiện số 0 giả.
- **Dashboard CEO** thêm thẻ "Chi ads 7 ngày · ACOS · TACOS" (NULL khi chưa nối Ads). TACOS dùng chung
  một công thức với màn PPC (`computeTacos`): cùng tiền tệ + cùng cửa sổ 7 ngày có số, thiếu một trong
  hai thì trả NULL chứ không đoán.

### Module 0 — từ trang mô tả thành luồng authorize THẬT (SOP-11)

- `GET /api/oauth/amazon/start?seller=<uuid>`: kiểm tra quyền đọc shop (RLS `vexim_shops`) → gọi RPC
  `create_oauth_state` (state dùng một lần, TTL 30 phút) → chuyển sang Seller Central
  (`/apps/authorize/consent?application_id=…&state=…&redirect_uri=…`, host theo vùng).
- `GET /api/oauth/amazon/callback`: **5 chốt an toàn** — (1) state dùng một lần/đã hết hạn ⇒ dừng;
  (2) `selling_partner_id` Amazon trả về phải khớp shop đang nối, **lệch ⇒ KHÔNG lưu token** (chống nối
  nhầm shop); (3) token rỗng bị chặn (cả ở route lẫn RPC); (4) đổi code xong mới ghi DB; (5) luôn quay về
  màn hình kèm lý do cụ thể (kể cả `access_denied`, `invalid_grant` — dịch sang tiếng Việt dễ hiểu).
- `/module0/connect` giờ là **công cụ thật**: danh sách shop + trạng thái token (còn mấy ngày, cần
  re-auth chưa, có profile Ads chưa) + nút Kết nối/Kết nối lại; DEMO mode vẫn hiện wizard mô tả như cũ.
- **Nhắc re-authorize**: job `oauth-reminder.job.ts` đọc RPC `vexim_worker_oauth_soon` (view token lọc
  theo `auth.uid()` nên service_role đọc ra 0 dòng — luật "còn ≤ notice_days là phải nhắc" nằm ở DB),
  tạo cảnh báo `oauth_reauth_due` **một lần cho mỗi đợt** rồi `mark_oauth_notice`; authorize lại sẽ tự
  reset cờ. Cron chạy bước này đầu tiên (token chết là mọi bước sau hỏng).

### Kiểm chứng đợt này

- `supabase/` (PGlite): **BƯỚC 21 mới — 490 kiểm tra, TẤT CẢ PASS** (bảng · RLS SELECT-only · 16 RPC chỉ
  service_role · 10 view + hợp đồng cột · luật nhập (merge/skip/currency) · `apply_ads_spend` chỉ UPDATE ·
  rule cảnh báo · `oauth_soon`).
- `worker/` **427 test** (+38 test mới: AdsClient/registry/parser + 2 job Ads + job nhắc re-auth),
  `web/` **161 test** (+9 test model A1), `npx tsc --noEmit` sạch, `next build` qua (thêm 2 route OAuth).
- Đã commit: `71ed3b0` (0020) · `e0adcf5` (engine Ads) · `ab8d264` (job + Module 0 OAuth).

### CÒN LẠI (đúng thứ tự)

1. **Điền biến môi trường** (`.env.example` đã cập nhật): `AMAZON_ADS_*`, `AMAZON_SP_API_APP_ID`,
   `AMAZON_SP_API_REDIRECT_URI`, `CRON_SECRET`. Sau đó chạy `worker:ads-sync` → `worker:ads-pull` là A1
   có số thật.
2. **Phần 2 Module 5**: A2 (chi tiết campaign, ad group → từ khoá/nhóm sản phẩm — dữ liệu đã có sẵn
   trong `ads.targets` + `vexim_ads_targets`) và A3 (search term + duyệt negative, `ads.negative_suggestions`
   đã có cột bằng chứng + độ tin cậy).
3. **Phần 3 Module 5 (ghi)**: đổi ngân sách/bid/state + thêm negative lên Amazon — kèm **ngưỡng duyệt**
   (tăng ngân sách > 30%/ngày cần trưởng phòng, SOP-05 bước 4) và ghi `iam.audit_logs` như `listing:publish`.

## Cập nhật 12/09 — MODULE 3 NÂNG CAO (phần 2): PHÍ theo FC + phí inbound noncompliance + cron tự kéo Reports API (migration 0019)

Phần 1 (0018) trả lời "hàng nằm ở đâu, nhận đủ chưa" nhưng vẫn phải **tải file TSV bằng tay** và
vẫn **chưa thấy TIỀN**. Phần 2 đóng cả hai khoảng trống:

1. **Phí lưu kho theo FC** — `GET_FBA_STORAGE_FEE_CHARGES_DATA`: Amazon thu bao nhiêu cho hàng nằm ở
   từng FC, theo từng tháng (`storage_rate`, `estimated_monthly_storage_fee`, tồn bình quân, thể tích,
   size tier, phí khuyến khích, hàng nguy hiểm).
2. **Phí/vấn đề inbound noncompliance** — `GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA`: lô nào bị
   Amazon bắt lỗi (thiếu nhãn, sai thùng, gửi dư/thiếu…), lỗi gì, bao nhiêu đơn vị, **phạt bao nhiêu
   tiền**, mức coaching, trạng thái cảnh báo.
3. **Tự động hoá Reports API** — không ai phải vào Seller Central tải file nữa: `createReport` →
   `getReport` (poll) → `getReportDocument` (tải, tự giải nén GZIP) cho **cả 4 report** (2 report của
   0018 + 2 report phí của 0019), chạy bằng **Vercel Cron** mỗi ngày 03:00 UTC.

- **Migration `0019_fc_fees_report_requests.sql`** (idempotent + DO-block tự soát **8 mục**: RLS 3 bảng ·
  index unique · KHÔNG có policy ghi · 3 RPC `security definer` chỉ service_role · 5 view
  `security_invoker` · hợp đồng cột từng view · helper đọc số · regression 0018):
  - Bảng **`finance.storage_fees`** ← report phí lưu kho. Khoá unique (shop × `month_of_charge` × ASIN ×
    FNSKU × FC × `dangerous_goods_storage_type`). `month_of_charge` được parser chuẩn hoá về `YYYY-MM`
    (report có thể ghi `September 2026`).
  - Bảng **`inventory.inbound_noncompliance`** ← report lỗi nhập kho. Khoá unique (shop ×
    `issue_reported_date` × lô × carton × SKU × `problem_type`).
  - Bảng **`connections.report_requests`** — **sổ tay trạng thái từng lần yêu cầu report**: reportId,
    documentId, `status` (requested/in_queue/in_progress/done/imported/no_data/failed/fatal/cancelled),
    `rows_imported`, `attempts`, `last_error`, kỳ dữ liệu. Nhờ bảng này cron **nối tiếp được**: lần sau
    poll đúng reportId đang chờ thay vì xin report mới (Amazon chỉ cho xin report daily **1 lần/4 giờ**
    cho mỗi loại).
  - 3 RPC **`vexim_worker_upsert_storage_fees`** / **`vexim_worker_upsert_noncompliance`** /
    **`vexim_worker_set_report_request`** (`security definer`, revoke khỏi `authenticated`, nhận JSON
    **camelCase** như quy ước 0015): set-based, trả `inserted · updated · skipped` (+ `groups` và danh
    sách `currencies` với RPC phí). Nhập lại cùng file → `updated`, **không phình bảng**.
  - 5 view `security_invoker`: **`vexim_storage_fees`** (phí theo SKU/FNSKU/ASIN × FC × tháng, kèm
    **`sku` SUY RA + nhãn `sku_source`** = `fnsku` / `asin` / `none` — report phí **không có SKU người
    bán**, hệ thống nối qua `inventory.fc_allocation` (0018) rồi `catalog.listings`, không âm thầm đoán),
    **`vexim_storage_fee_by_fc`** (shop × tháng × FC × **currency**: `storage_fee`, `fee_share_pct`,
    `avg_units_on_hand`, `total_volume`, `month_fee_total`), **`vexim_inbound_issues`** (từng dòng lỗi +
    `days_ago`), **`vexim_inbound_issue_shipments`** (gộp theo lô: `issue_count`, `fee_total`,
    `problem_units`, `problem_types`, `coaching_levels`, `alert_statuses`), **`vexim_report_requests`**
    (+ `age_minutes`, `is_stale` — màn Sync health đọc).
  - Helper **`finance.num_or_null`** / **`finance.bool_or_null`**: giá trị report lạ (`N/A`, `1,234.56`,
    `abc`, rỗng) → **NULL** chứ không làm nổ cả lô nhập.
  - RLS: 3 bảng mới **chỉ có policy SELECT** theo `iam.can_read_seller_account` (self-check đếm và
    **fail nếu có bất kỳ policy ghi nào**); mọi đường ghi đi qua RPC service_role.
- **Engine (đặt trong `web/src/lib/worker/` vì Vercel Cron phải tự chứa trong `web/`; `worker/src/*`
  là shim re-export)**:
  - `amazon/reports.ts` — **ReportsClient**: `createReport` → poll `getReport` → `getReportDocument`
    (tải nội dung, tự giải nén **GZIP** qua `node:zlib`), nhận diện throttle (`SpApiRequestError
    .isThrottled`) để cron không đốt quota.
  - `reports/registry.ts` — khai báo 4 report: `fc` (2 ngày) · `receipts` (30 ngày) · `storage-fees`
    (**95 ngày** — Amazon giữ ~3 kỳ phí) · `noncompliance` (60 ngày); **mọi loại `cooldownHours = 4`**
    đúng trần của Amazon.
  - `reports/fba-fees.parser.ts` — đọc cột **THEO TÊN** (Amazon đổi thứ tự cột vẫn chạy), gom
    `byMonthFcCurrency` (khoá `tháng|FC|tiền tệ`) và `feeByType` (khoá `loại phí|tiền tệ`), tiền làm tròn
    2 số để `0.30 + 0.55` không thành `0.8500000000000001`; dòng rác đếm `skipped` kèm số dòng, trần 20
    cảnh báo.
  - `jobs/report-pull.job.ts` + `run-report-pull.ts` — luật: tôn trọng cooldown **theo từng loại
    report**; trạng thái còn làm được (requested/in_queue/in_progress/done) thì **POLL tiếp, không tạo
    report mới**; report DONE nhưng rỗng → `no_data` (không phải lỗi); kỳ dữ liệu tính theo **UTC**;
    `--dry-run` **không ghi gì**; `rowsImported = inserted + updated`.
  - CLI **`npm run worker:reports-pull -- [--type=all|fc|receipts|storage-fees|noncompliance] [--days=N]
    [--seller=<uuid>] [--poll=N] [--dry-run]`** — có credential Amazon thì gọi API thật; hoặc nạp file đã
    tải tay: `--fc=<tsv> --receipts=<tsv> --storage-fees=<tsv> --noncompliance=<tsv>` (bỏ qua Amazon).
- **Cron**: route **`/api/cron/report-pull`** (GET/POST, `?kinds=` · `?days=` · `?dryRun=`), bảo vệ bằng
  `Authorization: Bearer <CRON_SECRET>` — **dùng lại biến đã có** của `/api/cron/inventory-sync`, nên
  **vẫn không cần thêm biến môi trường nào** (chỉ `AMAZON_LWA_*` + Supabase). Thiếu `CRON_SECRET` trên
  production → trả **500 kèm hướng dẫn** thay vì 401 mơ hồ. `maxDuration = 60` và **chỉ poll 2 lần cách
  nhau 5 giây**: report chưa xong thì ghi trạng thái vào `report_requests` để lần sau poll tiếp — cron
  KHÔNG ngồi chờ. `web/vercel.json` nay có 2 cron (02:00 inventory-sync · **03:00 report-pull** UTC).
- **Web UI (4 chỗ mới, đều đọc TÁCH BIỆT để trang không sập khi DB chưa chạy 0019):**
  - **Tổng quan kho vận**: panel **"Phí lưu kho theo FC"** — kỳ mới nhất, mỗi **tiền tệ một khối riêng**
    (tổng kỳ · % từng FC · số dòng sản phẩm · tồn bình quân · thể tích), không cộng chéo tiền tệ.
  - **I2 Chi tiết tồn SKU**: panel **"Phí lưu kho theo FC"** của riêng SKU đó — bảng kỳ mới nhất theo FC
    + bảng **chênh lệch kỳ phí** (so kỳ trước, chỉ so khi cùng tiền tệ), khớp phí theo **SKU HOẶC FNSKU
    HOẶC ASIN** vì report phí không có SKU người bán; cảnh báo khi có dòng phí chưa ánh xạ được SKU.
  - **I4 Inbound shipments**: cột mới **"Phí / vấn đề inbound"** trên bảng lô (`N vấn đề · $X`, `—` khi
    chưa biết) + header đếm tổng vấn đề/tổng phí + 3 panel: **lô nặng nhất** (sắp theo mức độ/phí),
    **từng vấn đề** (loại lỗi · đơn vị · coaching · phí, ghi rõ `expected/received` là **theo DÒNG** chứ
    không phải cả lô), **lô mồ côi** (report có lỗi nhưng lô không còn trong danh sách Inbound API).
  - **Module 0 → Sức khỏe đồng bộ**: panel **"Report đã kéo qua Reports API"** — từng loại report × shop ×
    kỳ dữ liệu × trạng thái × số dòng đã nhập × số lần chạm × tuổi (nhãn **CHỜ QUÁ LÂU** khi > 6 giờ) ×
    lỗi gần nhất, kèm giải thích trần 4 giờ và vì sao "Lần chạm" tăng là bình thường. Ba trạng thái
    hiển thị riêng: **chưa nối Supabase** (chế độ demo) / **chưa đọc được view** (thiếu 0019 hoặc quyền) /
    **chưa có lần yêu cầu nào**.
- **Số trung thực (không bịa):** phí **NULL ≠ 0** — dòng không đọc được tiền thì để "chưa biết", không
  đếm vào tổng; **không cộng tiền khác tiền tệ** ở bất kỳ tầng nào (parser · RPC · view · UI);
  `fee_share_pct` chỉ tính trong cùng một tiền tệ của cùng kỳ; `expected/received` của report lỗi là
  **theo dòng vấn đề**, KHÔNG được cộng ra "cả lô" (đối soát lô vẫn dùng 0018); lô có vấn đề nhưng
  không đọc được phí → hiện `—`, không hiện `$0`.
- **Kiểm chứng local (chạy thật):** `supabase npm test` **TẤT CẢ PASS (428 mục)** — BƯỚC 20 chạy trên
  Postgres thật (PGlite): nhập phí lưu kho 2 lần vẫn 5 dòng (không phình), dòng `month_of_charge =
  "September 2026"` được chuẩn hoá, dòng thiếu ASIN+FNSKU và dòng `fee = "abc"` bị `skipped`,
  USD/CAD **không bị cộng chung**, `authenticated` bị chặn ghi thẳng và bị chặn gọi cả 3 RPC, người lạ
  không thấy gì, 0019 chạy 2 lần không lỗi · `worker npm test` **391/391** (+70 test parser/registry/
  job/runner: cooldown, poll-không-tạo-mới, DONE rỗng → no_data, dry-run không ghi, GZIP, throttle) ·
  `web npm test` **152/152** (+24 test `fees-model`: hợp đồng SELECT 5 view, ép số dạng chuỗi, không cộng
  chéo tiền tệ, khớp SKU/FNSKU/ASIN, gộp vấn đề vào lô, nhãn trạng thái report + `is_stale`) ·
  `npx tsc --noEmit` sạch · `npm run build` sạch.

### Chờ VEXIM (Module 3 nâng cao phần 2)

- ☐ Chạy `supabase/migrations/0019_fc_fees_report_requests.sql` trong SQL Editor (sau `0018`).
- ☐ Kiểm tra role **Amazon Fulfillment** đã được Amazon cấp (đã nộp trong Developer Profile) — thiếu
  role thì `createReport` cho 2 report phí sẽ bị chặn.
- ☐ Chạy tay lần đầu để xem số mà **không ghi DB**: `npm run worker:reports-pull -- --type=all
  --dry-run`. Ưng ý thì bỏ `--dry-run` (worker chỉ ghi DB thật khi shop có `data_source = 'production'`).
- ☐ Trên Vercel: redeploy để `vercel.json` nhận cron thứ hai (`/api/cron/report-pull`, 03:00 UTC) —
  `CRON_SECRET` dùng lại cái đã có; gói Hobby giới hạn **2 cron/ngày chạy theo lịch**, đủ cho 2 job này.
- ☐ Sau 1–2 ngày, vào **Module 0 → Sức khỏe đồng bộ** xem panel "Report đã kéo qua Reports API": trạng
  thái `imported` là xong; `in_queue`/`in_progress` là Amazon đang tạo (cron poll tiếp); **CHỜ QUÁ LÂU**
  (> 6 giờ) thì chạy `npm run worker:reports-pull -- --type=storage-fees` để poll tay.

## Cập nhật 12/09 — MODULE 3 NÂNG CAO: phân bổ tồn theo FC + lịch sử nhận hàng (migration 0018)

I2 có hai khối treo nhãn "chưa có dữ liệu" từ Đợt 1, và lý do không phải "chưa làm" mà là **API không
có số này**: `listInventorySummaries`/`getFulfillmentInventory` chỉ trả TỔNG theo SKU (không tách
theo FC), còn Inbound API chỉ mô tả lô ĐANG mở (lô CLOSED thì không còn số nhận chi tiết). Nguồn thật
là 2 report FBA — nay đã nối xong report → DB → màn hình:

- **Migration `0018_fc_allocation_receipts.sql`** (idempotent + self-check 11 mục: bảng · RLS · quyền
  RPC · `security_invoker` · hợp đồng cột view · regression 0017):
  - Bảng **`inventory.fc_allocation`** ← report `GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA`
    (cột: `snapshot-date · fnsku · sku · product-name · quantity · fulfillment-center-id ·
    detailed-disposition · country`). Khoá unique (shop × ngày snapshot × SKU × FC × disposition).
  - Bảng **`inventory.receipts`** ← report `GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA`
    (cột: `received-date · fnsku · sku · product-name · quantity · fba-shipment-id ·
    fulfillment-center-id`). Khoá unique (shop × ngày nhận × SKU × lô × FC).
  - 2 RPC **`vexim_worker_upsert_fc_allocation`** / **`vexim_worker_upsert_receipts`** (`security
    definer`, revoke khỏi `authenticated`): set-based (1 câu INSERT…SELECT cho cả lô), trả
    `inserted · updated · skipped · merged · units · snapshots|shipments`. Dòng trùng khoá trong cùng
    file → **CỘNG dồn** (nếu ghi 2 lần Postgres báo "cannot affect row a second time"); dòng thiếu
    khoá/số không đọc được → `skipped`; nhập lại cùng file → `updated`, **không phình bảng**.
  - 4 view `security_invoker`: **`vexim_inventory_fc`** (SKU × FC của snapshot MỚI NHẤT +
    `sellable_qty`/`unsellable_qty`/`unknown_qty` + `sku_total_qty` + `sku_fc_count` +
    `fc_share_pct`), **`vexim_inventory_fc_rows`** (drill-down theo disposition),
    **`vexim_inventory_receipts`** (từng lần nhận + `days_ago`),
    **`vexim_inbound_receipt_shipments`** (đối soát theo lô: thực nhận vs số gửi + `diff_units` +
    `receipt_rate_pct` + `reconcile_state` + `expected_source`).
  - RLS: 2 bảng mới **chỉ có policy SELECT** theo `iam.can_read_seller_account` — không có policy ghi,
    web không ghi được; mọi đường ghi đi qua RPC service_role (như `catalog.listings` của 0016).
- **Worker**: parser `worker/src/reports/fba-inventory.parser.ts` (đọc cột **THEO TÊN** nên Amazon đổi
  thứ tự cột vẫn chạy; ngày về `YYYY-MM-DD`; dòng rác bỏ kèm số dòng; trần 20 cảnh báo để file lỗi
  không làm ngập log), job `inventory-fc-sync.job.ts`, runner `run-inventory-fc-sync.ts`, lệnh mới
  **`worker inventory:fc --fc=<file> [--receipts=<file>] [--seller=<uuid>] [--top-fc=10] [--dry-run]`**
  (script `npm run worker:inventory-fc`). **Không cần thêm biến env nào**; chỉ ghi DB thật khi
  `mode = production` và không `--dry-run`.
- **Web**: I2 (live) thay 2 panel "chưa có dữ liệu" bằng bảng **Phân bổ theo FC** (FC · Tổng · % của
  SKU · bán được · không bán được · không rõ) và **Lịch sử nhận hàng** (ngày · lô · FC · thực nhận);
  mỗi panel đọc tách biệt nên nếu DB chưa chạy 0018 thì panel tự giải thích, **không sập cả trang**.
  I4 (live) hết placeholder ở cột **FC đích** và **Đối soát nhận**: ghép
  `vexim_inbound_receipt_shipments` theo mã lô → "Nhận đủ 50/50" · "Thiếu 7 (nhận 18/25) → SOP-09" ·
  "Thừa 10 (nhận 30/20)" · "Chưa rõ số gửi (đã nhận 12)", kèm panel "lô có số nhận nhưng không còn
  trong danh sách" (lô CLOSED trước khi worker kịp sync).
- **Số trung thực**: `fc_share_pct` **NULL** khi tổng tồn của SKU = 0 (không hiện 0%); disposition rỗng
  đếm riêng `unknown_qty`, KHÔNG gộp vào "bán được"; report receipts **không có cột số gửi** →
  `expected_units` NULL + `expected_source = 'none'` chứ không suy "gửi = nhận"; ngày kiểu
  `09/11/2026` hiểu theo MM/DD/YYYY nhưng **có cảnh báo** trong log.
- **Kiểm chứng local (chạy thật):** `supabase npm test` **TẤT CẢ PASS** — BƯỚC 19 chạy trên Postgres
  thật (PGlite): nhập 10 dòng FC → ghi 6 · bỏ 3 dòng rác · gộp 1 cặp trùng khoá · 145 đơn vị ·
  2 snapshot; nhập lại → 6 update/0 insert; view chỉ phơi snapshot mới nhất; ONT8 50/85 = 58,8% +
  PHX7 41,2% = tròn 100%; SKU tổng 0 → % NULL; đối soát 5 lô (matched · short −7 · over +10 ·
  unknown_expected vì không có dòng lô · unknown_expected vì `quantity` NULL); `authenticated` bị chặn
  ghi thẳng + bị chặn gọi cả 2 RPC; người lạ không thấy gì; 0018 chạy 2 lần không lỗi ·
  `worker npm test` **321/321** (+28 test parser/job/runner) · `web npm test` **128/128** (+15 test
  model) · `npx tsc --noEmit` sạch.

### Chờ VEXIM (Module 3 nâng cao)

- ☐ Chạy `supabase/migrations/0018_fc_allocation_receipts.sql` trong SQL Editor (sau `0017`).
- ☐ Tải 2 report rồi nhập: Seller Central → **Reports → Fulfillment → Inventory** →
  *FBA Daily Inventory History* (phân bổ FC) và *FBA Received Inventory* (lịch sử nhận), định dạng TSV →
  `npm run worker:inventory-fc -- --fc=<daily-inventory.tsv> --receipts=<received-inventory.tsv>`
  (thêm `--seller=<uuid>` nếu có >1 shop; chạy `--dry-run` trước để xem số mà không ghi DB).
- ☑ ~~Đợt 2 sẽ tự đặt lịch qua Reports API~~ → **đã làm ngay trong phần 2 (0019, xem mục trên)**: cron
  `/api/cron/report-pull` tự `createReport` → poll `getReport` → `getReportDocument`, tôn trọng trần
  **mỗi 4 giờ cho mỗi loại report**; vẫn **không cần thêm biến env** (dùng lại `AMAZON_LWA_*` +
  `CRON_SECRET` + role **Amazon Fulfillment** đã nộp trong Developer Profile). Nhập tay bằng file TSV
  vẫn chạy được như cũ (`--fc=` / `--receipts=` / `--storage-fees=` / `--noncompliance=`).

## Cập nhật 12/09 — ĐỢT B: "hái quả ngay" (migration 0017 · doanh số 30 ngày · người phụ trách · giá trị tồn kho)

Đợt A mở khoá giá vốn + ghi listing thật. Đợt B lấy nốt **ba thứ dữ liệu ĐÃ CÓ SẴN trong DB nhưng
UI vẫn để số 0 / dấu "—"**, không phải chờ thêm API nào của Amazon:

- **Migration `0017_sales30d_owner_inventory_value.sql`** (idempotent + self-check 11 mục: cột nối
  CUỐI view / quyền / PII / công thức / khớp bảng gốc / idempotent):
  - **`public.vexim_sku_sales_30d`** (mới, `security_invoker`): MỘT định nghĩa doanh số 30 ngày theo
    (shop × SKU) từ `sales.orders ⋈ sales.order_items` — `units_30d`, `orders_30d`, `revenue_30d`
    (Σ `item_price × quantity`), `currency` + cờ `currency_mixed`, `last_order_at`. **Loại đơn huỷ**
    (cả hai cách viết `Cancelled`/`Canceled` của report lẫn API) và `Unfulfillable`; đơn `Pending`
    VẪN TÍNH vì P1 cần "cầu thật" để ước thiệt hại khi mất Buy Box. SKU không có đơn → **không có
    dòng** (view để NULL, không suy ra 0). *Khác `inventory.units_sold_per_day()` (0005): hàm đó chỉ
    đếm Shipped/Delivered 14 ngày để tính velocity NHẬP HÀNG — hai con số cho hai quyết định khác nhau.*
  - **`iam.module_owner(p_seller, p_module)`**: tên nhân viên VEXIM phụ trách shop ở module đó
    (ưu tiên `can_write`, rồi người gán sớm nhất). Bắt buộc là **`security definer`** vì RLS của
    `iam.assignments`/`iam.user_profiles` chỉ cho đọc CHÍNH MÌNH — join thẳng trong view
    `security_invoker` sẽ ra NULL với mọi user thường và cột "Phụ trách" chết. Chỉ trả **tên hiển thị**
    (không email, không uuid → không phải PII), bỏ qua user của khách hàng (`vexim_employee = false`),
    trả NULL nếu người gọi không đọc được shop, và **revoke khỏi `public`/`anon`**.
  - **`vexim_pricing` (P1) · `vexim_listings` (L1/L2) · `vexim_listing_queue` (L4)** nối THÊM 7 cột ở
    CUỐI: `units_30d, orders_30d, revenue_30d, revenue_currency, velocity_30d, last_order_at, owner`
    (P1 lấy owner module `pricing`, L1/L4 lấy module `listings`; `velocity_30d = units_30d / 30`).
    Nối cuối để web đang select theo tên không vỡ (bài học PGRST204).
  - **`vexim_inventory_latest` (Module 3)** nối THÊM 8 cột ở CUỐI: `unit_cost, cost_currency,
    cost_effective_from, cost_source, stock_value, total_stock_value, value_currency, value_basis`.
    `stock_value = fulfillable × giá vốn`, `total_stock_value = (fulfillable + reserved + inbound) ×
    giá vốn` — tra giá vốn NGOÀI khối `distinct on` để mỗi (shop × SKU) chỉ tra một lần. Tính theo
    **TIỀN CỦA GIÁ VỐN** (VEXIM nhập VND, bán USD → không tự quy đổi); thiếu giá vốn →
    `value_basis = 'missing'` + các cột giá trị NULL.
  - **Sửa lỗ hổng còn lại của 0016:** `catalog.effective_cost_row()` nay so SKU
    **không phân biệt hoa/thường** (`cost_inputs.sku` luôn VIẾT HOA vì `apply_cost_input` chuẩn hoá,
    còn `listings.sku`/`inventory_snapshots.sku` giữ nguyên xi như report) — hết cảnh "đã nhập giá vốn
    mà P1/Module 3 vẫn báo thiếu" chỉ vì một chữ thường. Sửa ở MỘT chỗ nên `effective_cost()`,
    `vexim_pricing`, `vexim_cost_coverage` và view tồn kho cùng hưởng.
  - Index `idx_order_items_order` (aggregate 30 ngày đi qua join `order_id`, trước đó bảng chỉ có PK).
- **Web — số thật thay cho 0/"—" (demo và live dùng chung một model):**
  - **P1**: cột mới **"Bán 30 ngày"** (đơn vị · số đơn · velocity/ngày · doanh thu 30 ngày), owner hiện
    "— chưa gán" khi DB chưa gán ai; sort "Velocity cao" và điểm rủi ro **null-safe** (SKU chưa có đơn
    xếp CUỐI, không chen lên đầu như thể bán kém nhất). `velocity30d` đổi sang `number | null`.
  - **L1**: cột mới **"Doanh thu 30 ngày"** + **"Phụ trách"** → nút sort "Doanh thu 30 ngày" hết xếp
    theo toàn số 0; `revenue30d` thành `number | null`.
  - **L4**: thêm cột **"Tiền đang mất"** (doanh thu/ngày + tổng 30 ngày) và **xếp hàng đợi theo tiền**:
    cùng mức ưu tiên thì listing đang mất nhiều tiền hơn lên trước (`sortQueueByRisk` dùng chung cho
    cả overview); owner + SLA hết là "—".
  - **Module 3**: I1 thêm KPI **"Giá trị tồn kho"** · **"SKU chưa có giá vốn"** và 2 cột
    *Giá vốn* / *Giá trị tồn* (kèm phần chỉ tính khả dụng); I2 thêm panel **"Giá trị tồn kho"** diễn giải
    từng bước (giá vốn hiệu lực · khả dụng × vốn · cộng reserved + đang về); I3 hết cảnh
    `unitCost: "—", value: "—"` — giá trị lô = đề xuất nhập × giá vốn, thiếu giá vốn thì ghi thẳng
    "— chưa có giá vốn" + nhãn "Nháp — thiếu giá vốn" (vàng) và KPI đếm số lô chưa định giá được.
    Cộng tiền **theo từng tiền tệ** (`summarizeInventoryValue`) — không bao giờ cộng VND với USD.
- **Kiểm chứng local (chạy thật, không suy luận):** `supabase npm test` **TẤT CẢ PASS** (BƯỚC 1..18;
  BƯỚC 18 dựng 5 user + 4 listing + 6 đơn (2 huỷ · 1 quá 30 ngày · 1 SKU viết thường) + 3 tồn kho +
  2 giá vốn rồi soát: `velocity_30d = 6/30 = 0.20`, doanh thu 300.00, đơn huỷ/đơn 40 ngày bị loại,
  SKU không có đơn → NULL chứ không phải 0, owner đúng theo module + ưu tiên `can_write`, user lạ
  KHÔNG dò được tên, `anon` bị chặn gọi hàm, `100 × 10 = 1.000` và `(100+20+30) × 10 = 1.500`,
  thiếu giá vốn → NULL + `missing`, SKU viết thường vẫn định giá được, RLS 3 view, 0017 chạy 2 lần) ·
  `web npm test` **113/113** (+30 test: `inventory-model.test.ts` mới 13 test + mở rộng
  pricing/listing model) · `worker npm test` **293/293** · `npx tsc --noEmit` sạch · 8 trang
  (`/pricing`, `/listing/list`, `/listing/queue`, `/fulfillment`, `/fulfillment/inventory`,
  `/fulfillment/inventory/detail`, `/fulfillment/restock`, `/finance/costs`) trả HTTP 200.

### Chờ VEXIM (Đợt B)

- ☐ Chạy `supabase/migrations/0017_sales30d_owner_inventory_value.sql` trong SQL Editor (sau `0016`).
- ☐ **Gán người phụ trách** trong `iam.assignments` theo (shop × module `pricing` / `listings` /
  `inventory`) — chưa gán thì cột "Phụ trách" hiện "— chưa gán" (có chủ đích, không tự bịa tên).
- ☐ Chạy `orders:sync` để có đơn 30 ngày: chưa có đơn thì P1/L1 hiện "—" chứ không hiện 0.
- ☐ Nhập giá vốn cho SKU còn tồn (`/finance/costs`): SKU thiếu giá vốn sẽ hiện "— chưa định giá"
  ở I1/I2 và "— chưa có giá vốn" ở I3, đồng thời bị đếm trong KPI "SKU chưa có giá vốn".

## Cập nhật 12/09 — ĐỢT A: gỡ chặn dữ liệu lõi (migration 0016 · giá vốn · ghi listing · P1 dùng giá vốn)

Ba việc chặn nhau suốt Đợt 1 đã được gỡ theo đúng thứ tự **giá vốn → ghi listing → pricing**:

- **Migration `0016_core_data_unblock.sql`** (idempotent + self-check 11 mục: cột / 6 view / 6 RPC /
  quyền / PII / `pricing_defaults` / `effective_cost()` khớp `cost_inputs`):
  - `catalog.listings` thêm **11 cột** để GHI được dữ liệu thật: `issues jsonb` (issue nguyên văn Amazon),
    `buyable`, `discoverable`, `product_type`, `quantity`, `stranded_reason`, `issue_errors`,
    `issue_warnings`, `enforcement_actions jsonb`, `last_source`, `last_synced_at` + 2 index.
  - `catalog.cost_inputs` thêm cột vết (`updated_at`, `updated_by`, `source_ref`) + unique
    `(shop, sku, effective_from)` để **import lại không nhân đôi** bậc giá vốn.
  - `catalog.pricing_defaults` (1 dòng cấu hình: referral 15% · biên tối thiểu 10% · phí khác 0) và
    `catalog.effective_cost_row()` / `catalog.effective_cost()` — **một luật giá vốn hiệu lực duy nhất**.
  - `public.vexim_worker_upsert_listings(p_seller, p_rows)` — RPC ghi listing cho worker (**chỉ
    `service_role`**): whitelist trạng thái (`ACTIVE|INACTIVE|SUPPRESSED|STRANDED|REMOVED|CLOSED|DELETED`,
    dòng mới chưa rõ → `UNKNOWN` chứ không bịa `ACTIVE`), `issues` dạng mảng = **thay** chi tiết,
    `null` = **giữ** dữ liệu cũ, chỉ có số đếm thì **xoá** mảng issue cũ, `stranded_reason` theo
    “key có mặt” để hết stranded là xoá được lý do, parse số an toàn (`1.299,99` → 1299.99, rác → NULL).
  - View: `vexim_listings` / `vexim_listing_queue` (đếm issue **ưu tiên mảng chi tiết**, queue nối thêm
    `buyable`/`discoverable`), `vexim_cost_inputs` (+`is_current`), `vexim_cost_coverage` (SKU đang bán
    **thiếu giá vốn / lệch tiền tệ** — chính là danh sách gỡ chặn), `vexim_shops` (bộ chọn shop, RLS lọc
    sẵn, **không phơi `seller_id`**). Tất cả `security_invoker = true`.
  - RPC giá vốn cho web: `iam.is_cost_editor()`, `vexim_upsert_cost_input`, `vexim_import_cost_inputs`
    (**chạy thử → hoàn tác → ghi thật**: 1 dòng lỗi thì KHÔNG ghi dòng nào, trả lỗi theo số dòng),
    `vexim_close_cost_input`, `vexim_delete_cost_input` (chỉ admin/trưởng phòng Tài chính) — mỗi lần ghi
    đều có `iam.audit_logs`. Helper parse đặt ở DB (`catalog.parse_amount`, `catalog.parse_day`: nhận
    `YYYY-MM-DD` và `DD/MM/YYYY`, **từ chối `MM/DD/YYYY` mơ hồ**) để luật parse chỉ có một bản.
  - **`vexim_pricing` nay dùng giá vốn hiệu lực** thay vì “giá sàn ≈ tổng phí” của 0013: thêm `unit_cost`,
    `cost_currency`, `cost_effective_from`, `cost_source`, `referral_rate_used`, `min_margin_rate`,
    `other_fee_per_unit`, `floor_price`, `gross_profit`, `margin_pct`, `below_floor`, `cost_basis`
    (`cost+fees | cost_only | fees_only | currency_mismatch`). Thiếu giá vốn → **NULL + nhãn lý do**,
    không lấy phí làm sàn. Công thức khớp `worker/src/domain/pricing.ts`:
    `floor = (vốn + FBA + khác) / (1 − referral − biên tối thiểu)`.
- **Worker — `upsertListing()` hết là stub rỗng, có runner `listings:sync`:**
  - `web/src/lib/worker/db/listing-payload.ts` (mới): dựng payload theo luật
    *undefined = không gửi (DB giữ nguyên)* / *null = chưa biết* / *`[]` = biết là rỗng*;
    `parseReportNumber` đọc số kiểu local. `DbAdapter.upsertListings()` (ghi cả lô) +
    `MockDbAdapter` **nhại đúng ngữ nghĩa RPC** để test không xanh giả.
  - `db/supabase.ts`: `upsertListing`/`upsertListings` gọi `POST /rest/v1/rpc/vexim_worker_upsert_listings`
    (nhóm theo shop, **không prefix schema**, không `Content-Profile` — đúng bài học sự cố 12/09).
  - `jobs/listings-sync.job.ts` viết lại: gộp report ALL + INACTIVE + STRANDED → **một lần ghi lô**,
    dựng hàng đợi L4 (`buildListingQueueEntry`), hook `fetchDetail` gọi `getListingsItem` cho **SKU có
    vấn đề** (trần mặc định 50, throttle ~4,5 rps) để lấy `issues`/`productType`/cờ BUYABLE,
    alert `listing_inactive` (đỏ nếu có stranded) hoặc tự đóng khi sạch, `sync_jobs` kiểu `listings.sync`.
  - `amazon/listings.ts`: `extractListingState` trả **mảng issue nguyên văn Amazon**
    (code/message/severity/attributeNames/categories/enforcements.actions) thay vì chỉ số đếm.
  - Runner mới `runtime/run-listings-sync.ts` + CLI `worker listings:sync --all=<listings.tsv>
    [--inactive=…] [--stranded=…] [--seller=<uuid>] [--details] [--detail-limit=50] [--dry-run]`
    (script `npm run worker:listings-sync`); **chỉ ghi DB thật khi production + đủ credentials**,
    còn lại chạy trong bộ nhớ và in rõ “KHÔNG ghi DB thật”.
- **Web — `/finance/costs` (mới) để NHẬP giá vốn thật:**
  - Nhập tay một bậc (SKU · giá vốn · tiền tệ · hiệu lực từ/đến · ghi chú) + **import CSV theo template**
    (tải ở `/api/finance/cost-template`): xem trước số dòng hợp lệ/lỗi theo số dòng **trước khi ghi**,
    all-or-nothing; “Kết thúc hiệu lực” (giữ lịch sử cho F4) và “Xoá” (chỉ admin/trưởng phòng Tài chính).
  - Panel **“SKU đang bán nhưng chưa dùng được giá vốn”** (từ `vexim_cost_coverage`) kèm nút nhập nhanh —
    đây chính là danh sách đang chặn F3/F4/P1; thang giá vốn theo SKU có nhãn *đang áp dụng / sắp hiệu lực*.
  - Ghi qua Server Action → RPC 0016 bằng anon client + phiên đăng nhập (quyền do
    `iam.can_write_seller_account()` + `iam.is_cost_editor()` chốt ở DB, web không dùng `service_role`).
    Thêm mục nav “Giá vốn (F3/F4/P1)” + chip ở `/finance`.
  - **P1/P2 dùng số thật:** `pricing-model` đọc 12 cột mới, ô giá sàn/biên hiện “—” kèm nhãn
    `cost_basis` và link sang `/finance/costs` khi thiếu giá vốn, thêm bộ lọc “Chưa có giá vốn”,
    KPI “SKU dưới giá sàn” đếm theo `below_floor`, breakdown giá sàn ở trang chi tiết liệt kê
    vốn hiệu lực + FBA + phí khác + tỷ lệ referral + biên tối thiểu.
  - **L1/L2/L4 dùng số thật:** tồn theo `quantity` (hết cảnh 0 giả), product type, cờ BUYABLE/DISCOVERABLE,
    lý do stranded, enforcement Amazon, nguồn ghi gần nhất; L2 chuẩn hoá `enforcements.actions`
    (trước đây cột enforcement luôn trống); L4 nêu nguyên nhân theo thứ tự
    *stranded → enforcement → mã issue → trạng thái* và đề xuất sửa đúng bệnh; trạng thái lạ → `UNKNOWN`
    (không ép về INACTIVE). Sửa luôn `readListingQueue` dùng select riêng vì view queue **không có**
    cột `buy_box_*` (select thừa cột là PostgREST trả PGRST204 → sập cả trang L4).
- **Kiểm chứng local (chạy thật, không suy luận):** `supabase npm test` **TẤT CẢ PASS** (BƯỚC 1..17;
  BƯỚC 17 chạy 0016 hai lần để kiểm idempotent + thang giá vốn + import CSV lỗi/atomic + quyền
  close/delete + ngữ nghĩa upsert listing + queue + `vexim_pricing` ra sàn 60.67/biên 39.5% +
  `unit_cost ≡ effective_cost()` ở mọi dòng + RLS + độ phủ + `vexim_shops`) · `worker npm test`
  **293/293** · `web npm test` **83/83** · `npx tsc --noEmit` sạch · 6 trang demo trả HTTP 200 ·
  chạy thử `listings:sync --dry-run` trên report mẫu: 4 listing / 2 stranded / 4 SKU vào hàng đợi L4.

### Chờ VEXIM (Đợt A)

- ☐ Chạy `supabase/migrations/0016_core_data_unblock.sql` trong SQL Editor (sau `0015`).
  **Không cần** thêm schema `catalog` vào *Exposed schemas*: web chỉ gọi RPC/view trong `public`.
- ☐ Vào `/finance/costs` → tải template → **nhập giá vốn** cho SKU đang bán (tay hoặc CSV).
  Chưa nhập thì F3 để trống giá trị claim, F4 để trống lãi gộp và P1 để trống giá sàn/biên (có chủ đích).
- ☐ Chỉnh `catalog.pricing_defaults` (id=1) nếu tỷ lệ referral / biên tối thiểu của VEXIM khác 15% / 10%.
- ☐ Tải 3 report trong Seller Central rồi nạp: `npm run worker:listings-sync -- --seller=<uuid>
  --all=<merchant-listings-all.tsv> --inactive=<inactive.tsv> --stranded=<stranded.tsv>`
  (thêm `--details` khi đã có `AMAZON_LWA_*` để lấy issue chi tiết cho L2).
- ☐ Cấp quyền nhập giá vốn: user Tài chính cần `role_assignments` (admin / `dept_lead` phòng `finance`)
  hoặc `iam.assignments` module `finance` + `can_write = true` trên đúng shop đó.
- ⚠ Đã biết: `getListingsItem` giới hạn ~5 rps (burst 10) nên `--details` chỉ soi SKU có vấn đề,
  trần mặc định 50 lần chạy (`--detail-limit` để đổi); report Merchant Listings chỉ cho **số đếm** issue,
  muốn có mã lỗi/nội dung thật thì phải gọi API.

## Cập nhật 12/09 — Module 6 Đợt 2: F3 bồi hoàn FBA + F4 lợi nhuận SKU (migration 0015)

- **Migration `0015_finance_claims_profit.sql`** (idempotent + self-check 3 bảng / 4 view / 2 trigger / 6 RPC):
  - `finance.reimbursements` — mở rộng theo đúng cột report: `reimbursement_id`, `case_id`,
    `amazon_order_id`, `reason`, `condition`, `amount_per_unit`, `amount_total`,
    `quantity_reimbursed_cash|inventory|total`, `original_reimbursement_id|type` + `dedupe_key`
    (unique theo shop) để **nhập lại report không nhân đôi**.
  - `finance.reimbursement_claims` — khoản nghi ngờ/đang khiếu nại: `category`
    (lost_fc/damaged_fc/inbound_missing/fee_error/return_missing/other), `source`
    (ledger/inbound/adjustment/manual) + `source_ref`, `quantity`, `unit_cost`, `estimated_amount`
    (**NULL khi chưa có giá vốn**), `status`, `amazon_case_id`, `reimbursed_amount`, `reimbursement_id`;
    unique theo `(shop, source, source_ref, sku)`.
  - `finance.reimbursement_claim_events` — lịch sử **append-only** (actor ghi trong bảng, view public
    không lộ email — đúng luật không PII).
  - `finance.sku_profit_daily` — PK `(shop, sku, ngày, tiền tệ)`; `cogs`/`gross_profit`/`ads_spend`
    **nullable**, `fee_source` ∈ `settled|fees_api|unavailable` để nói rõ độ tin cậy của phí.
  - Trigger giữ **máy trạng thái SOP-09**: `filed` phải có mã case · `approved/rejected/close` phải có
    ghi chú **và** quyền `iam.is_finance_editor()` · `paid` phải có số tiền · worker chỉ refresh khoản
    còn `suspected` (không ghi đè việc người đã xử lý).
  - Web ghi qua RPC `public.vexim_update_reimbursement_claim(...)`; worker ghi qua 5 RPC
    `vexim_worker_*` (chỉ `service_role`, đã revoke EXECUTE khỏi public/anon/authenticated).
- **Worker (đã có test):**
  - `reports/reimbursements.parser.ts` — bám **`GET_FBA_REIMBURSEMENTS_DATA`**: cột thật của Amazon,
    đọc số kiểu local (95,00), bỏ BOM, khoá chống trùng `reimbursement-id|sku|reason|amount-total`.
  - `reports/inventory-ledger.parser.ts` — bám **`GET_LEDGER_DETAIL_VIEW_DATA`** (18 tháng),
    chuẩn hoá tiêu đề, đếm theo EventType.
  - `domain/finance-claims.ts` — phân loại claim từ sổ cái (chỉ dòng **số âm**, lý do `FOUND` không tính),
    gộp dòng cùng tham chiếu, ước tính = SL × giá vốn hiệu lực (**thiếu giá vốn → NULL, không đoán**),
    tuổi claim + quá hạn 48h, tổng hợp, đối soát claim ↔ reimbursement, dựng bảng lợi nhuận SKU.
  - `jobs/finance-claims.job.ts` + runner `worker:finance-claims -- --ledger=<file>
    --reimbursements=<file> [--month=YYYY-MM] [--dry-run]`; chỉ ghi DB thật khi `mode = production`.
- **Web:** `/finance/claims` (hàng đợi SOP-09: lọc theo trạng thái/nguyên nhân/shop, sắp theo mức quá hạn,
  mở rộng xem lịch sử, nộp case/duyệt/ghi tiền về qua Server Action → RPC) và `/finance/profit`
  (chọn tháng, gộp theo SKU, **SKU lỗ lên đầu**, cột “Nguồn phí”, ô “—” khi thiếu giá vốn).
  Hai chip khoá ở `/finance` đã thay bằng liên kết thật; thêm 2 mục nav.
- **Kiểm chứng local:** `supabase npm test` **TẤT CẢ PASS** (BƯỚC 1..16, BƯỚC 16 chạy 0015 lần 2 để
  kiểm idempotent + toàn bộ vòng đời claim + F4) · `worker npm test` 275/275 · `web npm test` 45/45 ·
  `npx tsc --noEmit` sạch · `next build` PASS.

### Chờ VEXIM (Module 6 Đợt 2)

- ☐ Chạy `supabase/migrations/0015_finance_claims_profit.sql` trong SQL Editor (sau `0014`).
- ☐ ~~Thêm schema `catalog` vào *Exposed schemas*~~ — **không cần**: Đợt A (0016) đã có trang
  `/finance/costs` ghi qua RPC trong schema `public` (xem mục ĐỢT A ở đầu file).
- ☐ **Nhập giá vốn** cho các SKU đang bán tại **`/finance/costs`** (nhập tay hoặc CSV theo template) —
  chưa có giá vốn thì F3 để trống “giá trị ước tính” và F4 để trống lãi gộp (hệ thống cố ý không đoán).
- ☐ Khi có credentials SP-API: chạy `npm run worker:finance-claims -- --seller=<uuid> --ledger=<file>`
  (và `--reimbursements=<file>`) theo nhịp tuần cho SOP-09; F4 chạy lại sau mỗi kỳ settlement.
- ⚠ Đã biết: `GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA` (Fee Preview) chỉ cho **1 request/ngày/seller** và
  `dataStartTime` phải lùi ≥72h — hiện F4 ưu tiên phí thật từ settlement, chỉ dùng ước tính khi chưa có.

## Cập nhật 12/09 — L3: Trình soạn listing (Đợt 2, migration 0014)

- **Migration `0014_listing_editor.sql`** (mới, idempotent + self-check):
  - `catalog.listing_drafts` — bản nháp theo (shop, SKU): `payload`/`validation` jsonb,
    trạng thái `draft → pending_approval → approved → publishing → published/failed`.
  - `catalog.listing_draft_revisions` — lịch sử **append-only**: mỗi lần lưu/gửi/duyệt/
    từ chối/publish là 1 revision + danh sách attribute thay đổi + before/after payload.
  - `catalog.listing_publish_queue` — hàng đợi publish: `method` patch/put/feed, `status`
    queued/blocked/sent/accepted/invalid/failed, `submission_id`, `issues`, `block_reason`.
  - `catalog.listing_product_type_schemas` — cache JSON Schema product type để form động
    dùng `required`/`maxLength` THẬT của Amazon.
  - Trigger giữ **máy trạng thái + 4 mắt + cổng `validation.errorCount = 0`**; RLS theo shop;
    không có policy DELETE (giữ lịch sử); web ghi qua RPC public (§7B), worker qua RPC §7C
    (chỉ service_role).
- **Hạn mức kiểm chứng tài liệu Amazon 09/2026** (`web/src/lib/listing/amazon-limits.ts`):
  tiêu đề 75 ký tự (media 200; hiệu lực 27/07/2026), Item Highlight (`title_differentiation`)
  125, bullet 10–255 × tối đa 5, mô tả 2.000, từ khóa backend **249 BYTE** (JP 500, IN 200),
  9 ảnh. File ghi kèm `AMAZON_SOURCES` (URL + ngày kiểm chứng).
- **Web:** trang `/listing/editor` (nav "Soạn listing (L3)") + `/api/listing/drafts`: lưu nháp,
  gửi trưởng phòng duyệt, duyệt/từ chối (kèm lý do), publish (đẩy hàng đợi), xem lịch sử.
  DEMO MODE xem/kiểm tra được nhưng KHÔNG lưu giả (thiếu Supabase → API trả 409).
- **Worker:** `listing:publish` gọi `getListingsRestrictions` **TRƯỚC** khi gửi (blocked nếu
  APPROVAL_REQUIRED/ASIN_NOT_FOUND/NOT_ELIGIBLE), rồi `patchListingsItem`/`putListingsItem`,
  ghi ACCEPTED/INVALID + issues vào hàng đợi + lịch sử; `listing:schema` tải
  `getDefinitionsProductType` vào cache. Cả hai chỉ gọi Amazon + ghi DB thật khi
  `mode = production` và không `--dry-run`.
- **Kiểm chứng local:** `supabase npm test` **TẤT CẢ PASS** (BƯỚC 1..15) · `worker npm test`
  256/256 · `web npm test` 36/36 · `npx tsc --noEmit` sạch · `next build` 41/41 trang.

### Chờ VEXIM (L3)

- ☐ Chạy `supabase/migrations/0014_listing_editor.sql` trong SQL Editor (sau `0013`).
- ☐ Khi có credentials SP-API: `npm run worker:listing-schema -- --product-type=<loại>` cho các
  product type đang bán (form động mới có schema thật), rồi `npm run worker:listing-publish`.
- ⚠ Đã biết: `op: "merge"` của Amazon chỉ hỗ trợ `fulfillment_availability.quantity` +
  `purchasable_offer` (hiện patch theo whole-attribute); notification
  `LISTINGS_ITEM_ISSUES_CHANGE` v1.0 đã bị Amazon ngừng (14–26/08/2026) — rà lại khi cấu hình
  notification thật.

## Cập nhật 12/09 — migration 0011 + Module 4/6 đọc Supabase

- Đã lưu **nguyên nội dung SQL VEXIM cung cấp** vào
  `supabase/migrations/0011_web_public_views.sql`. Không chạy lại trên production.
  Ghi chú thiếu file 0011 ở đợt trước đã được giải quyết.
- **Module 4:** `/orders`, `/orders/list`, `/orders/detail`, `/orders/fbm`,
  `/orders/returns` chuyển sang đọc public views trong Supabase mode.
  Overview hiện là danh sách đơn thật; không giữ KPI/alerts/tin nhắn demo.
- **Module 6:** `/finance`, `/finance/settlements`,
  `/finance/settlements/detail`, `/finance/events` chuyển sang đọc public views.
  Overview hiện là danh sách kỳ thật; không suy lợi nhuận/COGS/TACOS/bồi hoàn.
- Bộ lọc client theo shop UUID, trạng thái, loại dòng tiền, tìm mã đơn/SKU/kỳ;
  hiển thị 50 dòng/trang. Đọc DB theo batch 500 dòng, tổng hợp trên toàn bộ dữ
  liệu được RLS cho phép. Phù hợp pilot; cần chuyển sang phân trang/tổng hợp
  server khi backfill lớn. Các tổng là toàn kỳ DB/bộ lọc, không gắn nhãn hôm nay.
- Tiền giữ nguyên currency; tổng tách theo tiền tệ, báo thiếu giá trị, không
  quy đổi; dòng `Transfer` không cộng vào tổng events để tránh cộng kép.
- FBM ưu tiên `latest_ship_date`, sắp hạn gần nhất trước. Thiếu thì ghi rõ
  **ƯỚC LƯỢNG = purchase_date + 24h giả định**, không phải handling cấu hình
  của shop. Thiếu cả ngày mua thì không bịa hạn. Countdown tại lúc tải trang,
  không chạy realtime; có nút tải lại. Report-sync hiện chưa ghi hạn Amazon,
  nên chỉ có hạn thật khi DB đã được nguồn khác ghi `latest_ship_date`.
- Chi tiết dùng UUID nội bộ lấy từ danh sách; thiếu/sai/ngoài quyền → không
  tìm thấy, không fallback bản ghi demo. Dòng hàng lọc `order_id` + shop;
  events của settlement lọc **settlement_id Amazon + seller_account_id**
  (không nhầm UUID nội bộ, không lẫn hai shop có cùng mã kỳ).
- Settlement detail có breakdown nhóm tiền từ worker + các events thuộc kỳ.
  Không coi NULL `reconcile_diff` là khớp nếu thiếu `reconciled_at` hoặc
  breakdown chỉ ra `transferSource=none`.
- Dùng session anon client; không service_role, không PII/raw. DB trống,
  lỗi query và không tìm thấy có trạng thái riêng; demo vẫn giữ riêng và gắn
  nhãn DEMO. Không bật thao tác ghi Amazon/refund/ship.

### Kiểm chứng local

- `cd web && npm test`: **13/13 PASS** (6 Health + 7 Operations).
- `cd web && npm run typecheck && npm run build`: PASS, 39/39 trang được sinh.
- `cd supabase && npm test`: TẤT CẢ PASS trên PGlite, gồm 0011 chạy lại lần 2,
  8 security-invoker views, chốt không PII/raw, main SKU theo quantity,
  deadline thật và RLS của 6 view Module 4/6 với user chỉ gán 1 shop.
- Test DB chạy đúng các SELECT projection từ web dưới role authenticated;
  fixture hai shop có cùng mã settlement xác nhận phải ghép mã kỳ + shop.
  Chỉ DB local trong bộ nhớ; fixture rollback, không chạm Supabase production.

### Checklist sau deploy

1. Login thật → mở 9 route trên: nhãn SUPABASE, không có số demo, empty state
   nếu chưa import report. Click detail từ danh sách (UUID nội bộ).
2. Import report qua pipeline hiện có → đối chiếu order/items/returns,
   settlement groups/events, tiền tệ, ngày cập nhật với nguồn gốc.
3. Đối chiếu queue MFN Pending/Unshipped/PartiallyShipped; phân biệt hạn Amazon
   với ước lượng. Không dùng ước lượng làm bằng chứng vi phạm SLA.
4. User chỉ được gán shop A không thấy dữ liệu shop B, kể cả sửa UUID URL.
5. Trên môi trường test, thu hồi SELECT view → báo lỗi, không chuyển sang mock.
6. Kiểm thử tương tác trình duyệt (lọc, tìm kiếm, phân trang), và production
   RLS chưa thực hiện từ sandbox này; không coi local tests là xác nhận live.

**Tiếp theo:** nối Module 3 qua hai view mới; bổ sung pipeline ghi hạn ship
Amazon, hoàn thiện RBAC session và dashboard KPI theo kỳ/nguồn đã đối soát.

## Cập nhật tiếp nối 12/09 — Module 7 đọc Supabase (H1/H2)

- **VEXIM xác nhận:** đã chạy migration 0010, 0011 và expose đủ 11 schemas.
  Đây là xác nhận của người vận hành, chưa kiểm tra trực tiếp DB từ phiên dev này.
- **Lưu ý đồng bộ repo:** `origin/main` ở commit `3866fed` chỉ có migration đến
  `0010`; cần bổ sung bản SQL `0011` đã chạy vào Git để có thể tái lập DB.
  Đợt này không tạo/chạy lại migration và không thay đổi DB production.
- `/health` và `/health/violations`: khi session ở Supabase mode, đọc
  `public.vexim_shop_health` và `public.vexim_health_issues` bằng anon client
  kèm cookie của user; giữ nguyên RLS/security-invoker, không dùng service role.
- Demo mode vẫn có dữ liệu mẫu, gắn nhãn DEMO. DB trống có empty state;
  truy vấn lỗi có error state và **không fallback mock**. KPI lấy từ dữ liệu
  đọc được, phân biệt shop với shop/marketplace và nhóm vi phạm với case.
- Hiển thị ngày báo cáo, thời điểm thu thập, AHR/ODR/late ship; null là “—”,
  giữ nguyên màu đỏ và unknown. H2 sort severity, dùng issue UUID làm key,
  không gọi reporting_from là ngày mở case. Đã sửa nguồn report V1 → V2.
- Phân trang truy vấn 500 dòng để không cắt KPI ở giới hạn mặc định PostgREST.
- Không hiển thị tác vụ/SLA demo trong màn thật. Luồng ghi/appeal vẫn không bật.

**Kiểm chứng local:** `cd web && npm test` (6/6 PASS),
`npm run typecheck` PASS, `npm run build` PASS (39/39 trang sinh thành công).
Chưa kiểm chứng trình duyệt đăng nhập production hoặc RLS trên project thật.
`npm ci` báo 2 advisory dependency (1 moderate, 1 high); chưa thay dependency
ngoài phạm vi tính năng này.

**Kiểm tra sau deploy:**
1. Đăng nhập Supabase → `/health`, `/health/violations`: có nhãn SUPABASE,
   không còn số shop/case/tác vụ demo. DB chưa import report thì hiển thị trống.
2. Sau sync report thật: so AHR/ODR/late ship, marketplace và ngày với report;
   xác nhận các nhóm Critical/High lên đầu H2.
3. Đăng nhập user giới hạn shop: chỉ thấy snapshot/issue được RLS cho phép.
4. Trên môi trường test, mô phỏng mất quyền view → thông báo lỗi, không mock.

**Tiếp theo:** nối Module 4 (Orders/FBM/Returns), rồi Module 6
(Settlements/Financial events); hoàn thiện RBAC session (code hiện vẫn gán
persona `ceo` cho user Supabase — phạm vi dữ liệu ở hai màn trên do RLS quyết định).
Không coi Module 7 là đã kiểm chứng production trước các bước kiểm tra trên.

## ⚠️ SỰ CỐ 12/09 — fixture test lọt vào DB production (ĐÃ SỬA)

VEXIM tạo project Supabase thật (`pitmyzovjwflkyoqjbkz`) và set 14 biến môi trường trên
Vercel. Đối chiếu dump DB với SQL trong repo phát hiện 3 lỗi chồng nhau:

| # | Lỗi | Bằng chứng | Đã sửa |
|---|---|---|---|
| 1 | `tests/rls_test.sql` kết thúc bằng `commit;` → fixture test bị ghi vĩnh viễn vào DB thật khi chạy nhầm trong SQL Editor | `organizations=3` (2 giả `dna`/`dnb`), `seller_accounts=9` (3 giả), `auth.users` có `u1@`/`u2@vexim.vn`+`client@dna.vn`, `listings=7` (`TEST-S*-`), `tasks=3`, `cost_inputs=2`, `oauth_tokens=1` (`ENCRYPTED-DUMMY`), `audit_logs=1` | migration **0006** + đổi `commit;`→`rollback;` + thêm cờ `vexim.allow_rls_test` |
| 2 | `seed/seed_demo.sql` mục 4+5 mở đầu bằng `if auth.uid() is null then return` — trong SQL Editor `auth.uid()` luôn NULL → **âm thầm bỏ qua** | `user_profiles=3` (đúng bằng 3 fixture test, không có user thật), `role_assignments=3` (không `super_admin` nào), `alerts=0` → chuông thông báo rơi về mock | migration **0007** nhận danh sách email tường minh, không cần phiên đăng nhập |
| 3 | `CRON_SECRET` **không có** trong 14 biến Vercel → `isAuthorized()` trả false trên production → cron 401 im lặng, không bao giờ chạy | `web/src/app/api/cron/inventory-sync/route.ts:16-18` | route trả **500 kèm thông báo nêu đích danh biến thiếu**; VEXIM cần thêm biến |

**Rủi ro thứ 4 (chặn trước khi xảy ra):** điều kiện cũ trong
`worker/src/runtime/run-inventory-sync.ts` là `if (cfg.supabase)`. Với
`NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` đã set nhưng
`AMAZON_LWA_*` chưa set, worker sẽ nối **DB thật** rồi dùng client mock →
ghi SKU demo (`XMO-950-BLK`, `VPN-220`, `B0DEMO0001…`) vào production.
Nay đổi thành `cfg.mode === "production"` (đòi đủ cả 5 biến) + bỏ fallback
`DEMO_SHOP` (UUID `0000…0001` không tồn tại → vỡ FK `inventory_snapshots`).

### Kiểm chứng (chạy thật, không suy luận)

```bash
cd worker && npm test      # 96 tests / 96 pass / 0 fail  (trước đó 93 — thêm 3 test mới)
cd web    && npx next build # ✓ Compiled successfully · 39/39 routes · exit 0
cd supabase && npm test     # 53 PASS / 0 FAIL — PostgreSQL 18.3 (PGlite/WASM)
```

Bộ `supabase/tests/run-migrations.mjs` **tái hiện đúng trạng thái DB của VEXIM**:
khớp **15/15** số đếm bảng và **4/4** email trong dump, rồi chạy 0006 → 0007 và
xác nhận dọn sạch fixture mà **vẫn giữ user thật** `hocluongvan88@gmail.com`.

Test regression có răng: đổi `allowRealDb` về `cfg.supabase !== null` thì test
*"Có Supabase nhưng THIẾU AMAZON_LWA_*"* **FAIL ngay** (đã kiểm chứng bằng cách
revert tạm).

### Việc VEXIM cần làm (theo thứ tự)

1. ✅ SQL Editor → chạy `migrations/0006_cleanup_rls_test_fixtures.sql` — **đã chạy 12/09**
2. ✅ SQL Editor → chạy `migrations/0007_seed_admin_and_alerts.sql` — **đã chạy 12/09**
   (xác nhận: `orgs=1, shops=6, users=1, admins=1, alerts=9, listings=0` — khớp kỳ vọng)
3. ✅ Vercel → thêm `CRON_SECRET` — **đã thêm 12/09**
4. ☐ Merge PR #3 để build Vercel chạy được (xem mục "Build Vercel" dưới)

## Build Vercel fail — nguyên nhân & cách sửa (12/09)

Deployment fail từ **PR #2** (`10974b6`), **không phải** do PR #3:

| Commit | Vercel |
|---|---|
| `6dd39aa` (PR #1) | ✅ success |
| `10974b6` (PR #2) | ❌ failure |
| `8194884`, `38be50c` (PR #3) | ❌ failure |

**Nguyên nhân:** Vercel đặt **Root Directory = `web`**, mà `web/src/lib/worker/index.ts`
import `"../../../../worker/src/runtime/run-inventory-sync"` — vượt ra ngoài `web/`.
Tái hiện bằng cách build `web/` trong thư mục cô lập:

```
./src/lib/worker/index.ts
Module not found: Can't resolve '../../../../worker/src/runtime/run-inventory-sync'
Import trace: ./src/app/api/cron/inventory-sync/route.ts
> Build failed because of webpack errors          BUILD_EXIT=1
```

**Đã sửa:**
- Chuyển 8 file của inventory sync engine vào `web/src/lib/worker/` (closure khép kín,
  không kéo thêm gì): `config`, `amazon/{lwa,fba-inventory}`, `db/{adapter,supabase}`,
  `domain/inventory-metrics`, `jobs/inventory-sync.job`, `run-inventory-sync`
- `worker/src/…` tương ứng thành **shim re-export** → `cli.ts` + 96 test không đổi
- **Dời `vercel.json` từ repo root vào `web/`** — Root Directory = `web` nên file ở
  root **không được Vercel đọc**, cron chưa bao giờ được đăng ký
- Đã loại trừ nguyên nhân khác: `npm ci --dry-run` trong `web/` exit 0 (lockfile đồng bộ)

**Kiểm chứng:** build `web/` cô lập (không có `worker/` bên cạnh) → `BUILD_EXIT=0`,
39/39 routes, có `/api/cron/inventory-sync`. Trước khi sửa: `BUILD_EXIT=1`.

### Nguyên nhân THỨ HAI — `vercel.json` sai vị trí + schedule vượt giới hạn Hobby

Sau khi dời `vercel.json` vào `web/` (bắt buộc, vì Root Directory = `web`), Vercel
**bắt đầu đọc** file đó — và lập tức từ chối vì:

> "Hobby accounts are limited to cron jobs that run once per day... Expressions like
> `0 * * * *` (per-hour) or `*/30 * * * *` (every 30 minutes) will fail deployment."
> — https://vercel.com/docs/cron-jobs/usage-and-pricing

Schedule cũ là `*/30 * * * *`. Trước đây nó **không** gây lỗi chỉ vì file nằm ở repo
root nên Vercel không đọc — tức cron chưa bao giờ được đăng ký.

**Đã đổi thành `0 2 * * *`** (2h sáng — khớp lịch đối soát trong
`docs/phan-tich-ky-thuat-module-3-kho-van.md`). Chạy được trên **mọi** gói Vercel.

Muốn quay lại 30 phút/lần:
- Gói **Pro**: sửa `web/vercel.json` → `"schedule": "*/30 * * * *"`, redeploy
- Gói **Hobby**: giữ route nguyên vẹn và dùng scheduler ngoài (cron-job.org,
  GitHub Actions `schedule`, …) gọi `GET /api/cron/inventory-sync` kèm header
  `Authorization: Bearer <CRON_SECRET>`. Route là HTTP endpoint thường nên
  không phụ thuộc Vercel Cron.

Hiện tại chưa cần 30 phút: `AMAZON_LWA_*` chưa có và cả 6 shop vẫn
`data_source='mock'` → `active_production_shops()` = 0 → sync chưa làm gì.

## Auth — middleware refresh session + `/api/whoami` (12/09)

Hai lỗ hổng khi chuyển sang SUPABASE MODE trên production:

1. **Middleware không refresh phiên.** `web/src/lib/supabase/server.ts` ghi
   *"Server Component đang render — middleware sẽ refresh session"*, nhưng
   middleware cũ chỉ kiểm tra cookie tên `sb-*` **có tồn tại**. Access token
   hết hạn → `getUser()` fail → user bị đá ra `/login` dù refresh token còn hạn.
   Nay gọi `supabase.auth.getUser()` đúng chuẩn `@supabase/ssr` (refresh cookie
   trên response).
2. **Cookie `demo_role` được tin trên production.** Middleware + `getAppSession()`
   ưu tiên `demo_role` trước user Supabase → cookie demo còn sót từ lúc thử
   DEMO MODE sẽ cho vào app mà không cần đăng nhập thật. Nay: đã cấu hình
   Supabase thì **chỉ** nhận `getUser()`; `demo_role` chỉ dùng khi chưa có env.

Endpoint chẩn đoán `GET /api/whoami` (whitelist, không redirect `/login`):
trả cookie **tên** (không value), cờ env (không key), `auth.getUser()`,
`iam.my_profile`, và header `x-vexim-middleware` để biết middleware có chạy.

`GET /api/amazon/whoami` (cũng whitelist; khoá `Authorization: Bearer <CRON_SECRET>`):
tra **seller_id + marketplace** của chính refresh_token (self-authorization) —
3 bước, lỗi từng bước không làm hỏng bước khác:

1. `GET /sellers/v1/marketplaceParticipations`
2. `GET /fba/inventory/v1/summaries` (xác nhận role Inventory, đếm SKU, ASIN mẫu)
3. `POST /products/fees/v0/items/{Asin}/feesEstimate` → `FeesEstimateIdentifier.SellerId`

Amazon không có endpoint whoami chính thức; seller ID chỉ lộ ở feesEstimate
(kể cả khi Status = ClientError). Không trả access token.

Cách gọi (sau khi merge / trên preview của PR, **không** phải domain production
nếu PR chưa merge):

```
curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  https://<host>/api/amazon/whoami
```

## Trạng thái tổng thể

| Luồng việc | Trạng thái |
|---|---|
| **Amazon Developer Profile** (lane Hải Anh) | 🟠 Đã nộp / đang chờ duyệt (2–8 tuần) · role Amazon Fulfillment đã chốt NỘP KÈM · nhớ tạo Sandbox Application ngay sau khi nộp |
| **Landing page** | ✅ Xong (chờ VEXIM thay 4 thông tin thật + deploy HTTPS) |
| **Database (Supabase)** | ✅ **3 migrations + seed đã kiểm chứng trên Postgres 18 thật — 10/10 test RLS multi-tenant PASS** (36 bảng · 44 policies · 12 SOP) · bắt & sửa 3 lỗi SQL trong quá trình test · chỉ còn push lên project khi VEXIM tạo |
| **Web app** | 🟢 Phase 1 đang chạy (xem dưới) |

## Phase 1 — Đợt 1 (Cấp độ 1)

| Module | Màn hình | Trạng thái |
|---|---|---|
| **0. Hạ tầng** | App skeleton + design system (đúng wireframe) | ✅ |
| | Đăng nhập demo 4 vai trò / Supabase Auth (2 mode tự chuyển) | ✅ |
| | Phân quyền UI theo vai trò + chặn trang sai phạm vi + banner phạm vi | ✅ |
| | 0.1 Kết nối shop (wizard 5 bước + checklist điều kiện) | ✅ (bản mock) |
| | 0.2 Sức khỏe đồng bộ (sync jobs, 3 tầng) | ✅ (bản mock) |
| | 0.3 Mức dùng API & chi phí | ✅ (bản mock) |
| | 0.4 Nhật ký thao tác (audit log) | ✅ (bản mock) |
| | 0.5 Người dùng & phân quyền | ✅ (bản mock) |
| | 8 trang dashboard (CEO + 6 phòng + Client) — chuyển từ wireframe sang app thật | ✅ (dữ liệu mock) |
| | SupabaseProvider — trang đọc dữ liệu thật từ Postgres | ⬜ kế tiếp |
| | Typed clients SP-API (từ Swagger models) + sandbox e2e | 🟠 bắt đầu — worker/ Module 3: LWA + FBA Inventory v1 + notification handler + MYI parser (16/16 test, chạy mock; sandbox chờ App duyệt) |
| **7. Account Health** | H1 Health theo shop (dashboard) | ✅ (mock) |
| | H2 Chi tiết vấn đề đang mở (vi phạm theo severity + case SOP-08) | ✅ (mock) |
| | **Domain + sync layer Health** (worker/): ngưỡng Amazon > fallback (đánh dấu nguồn), AHR 0–1000, 10 nhóm vi phạm + severity, SOP-08 (red 24h / amber 72h) · parser report V2 · job snapshot/issue/alert · handler ACCOUNT_STATUS_CHANGED | ✅ 46 test |
| **4. Đơn hàng** | O1 Danh sách đơn (không PII) · O2 Chi tiết đơn (PII khóa) · O3 Queue FBM (đếm ngược) · O4 Returns (mã lý do Amazon) | ✅ (mock) |
| **3. Kho vận (đọc)** | I1 Tồn theo SKU (filter, cover, đề xuất) · I2 Chi tiết tồn (90 ngày, FC, nhận hàng) · I3 Kế hoạch nhập (SOP-01, ghi khóa Đợt 2) · I4 Inbound (trạng thái chuẩn Amazon + đối soát) — kèm **phân tích kỹ thuật** `docs/phan-tich-ky-thuat-module-3-kho-van.md` (đã kiểm chứng: notification FBA_INVENTORY_AVAILABILITY_CHANGES, cột report MYI, report theo FC) | ✅ (mock) |
| | **Sync layer 3 tầng** (worker/): notification → getInventorySummaries → report MYI đối soát; chỉ số velocity/cover/đề xuất nhập đúng công thức §2 | ✅ Tier 1 (mock, 16/16 test) |
| **1. Listing (đọc)** | L1 Danh sách listing (filter trạng thái/shop/loại lỗi/brand, tìm kiếm, sort, xuất CSV) · L2 Chi tiết (thuộc tính theo product type, issues đúng mã lỗi Amazon, lịch sử, offer & Buy Box, doanh thu 30 ngày) · L4 Hàng đợi inactive/stranded theo SOP-03 | ✅ (mock) |
| | **Sync layer Listing** (worker/): getListingsItem + LISTINGS_ITEM_STATUS_CHANGE/ISSUES_CHANGE + 3 report parser (Merchant ALL/INACTIVE, Stranded) | ✅ (mock, 12 test) |
| **2. Giá & Buy Box** | P1 Bảng giá & Featured Offer (FOEP, giá sàn, biên, box status) · P2 Chi tiết giá (30 ngày, breakdown giá sàn, offers đối thủ) · P3 Duyệt & áp giá (≤2% operator / >2% trưởng phòng, khóa dưới sàn, SOP-02) | ✅ mock (PR #2) |
| | **Sync layer Pricing** (worker/): computeFloorPrice / computeMargin / computeBoxStatus / suggestPrice / pricingFlag · buildPricingSnapshot · batch/retry đúng SP-API 2022-05-01 (FOEP batch 40, offers 20, RPS 0.5) | ✅ mock, 73/73 test |
| | **Sync layer Orders** (worker/): parser report All Orders (bỏ cột PII khi parse) + Returns, gom đơn/tiền, queue FBM đếm ngược theo LatestShipDate, KPI/rollup ngày, alert `fbm_late_ship`/`return_reason_spike`, handler ORDER_CHANGE | ✅ 43 test |
| **6. Tài chính (đọc)** | F1 Danh sách kỳ settlement (filter shop/status, tổng tiền vào/ra/phí/ads) · F1 Chi tiết kỳ (phân loại nhóm phí, breakdown SKU, take rate/TACOS) · F2 Financial events (filter loại/shop/search, tổng hợp vào/ra/net) | ✅ mock |
| | **Domain Finance** (worker/): reconcileSettlement (dung sai 1% — SOP-10), totalCredits/Debits/netTransfer, feeTakeRate/TACOS/totalTakeRate, estimateReserveHold/OpenPayout, summarizeEvents | ✅ 91/91 test |
| | **Sync layer Finance** (worker/): parser settlement **V2** (số kiểu local 95,00/1.234,56), nhóm phí khớp domain, đối soát trừ dòng Transfer, replace (không cộng dồn) dòng tiền khi import lại | ✅ 24 test |

**Kiểm chứng build (12/09, sau khi sửa sự cố):** `next build` ✓ Compiled successfully · **39/39 routes** · exit 0 · worker test **96/96** · `supabase` test **53/53** trên PostgreSQL 18.3 ✅

**Cập nhật 11/09 — nối DB thật (sau feedback):**
- ✅ Tạo migration `0004_ui_policies_notifs_profile_invite.sql` bổ sung RLS cho `ops.alerts` (SELECT theo shop được phép), `iam.user_profiles` (self update phone/display_name/avatar_url/mfa_enabled, admin insert/update khi mời user), `iam.departments` & `connections.seller_accounts` cho mọi authenticated user đọc; `iam.role_assignments`/`iam.assignments` cho admin insert.
- ✅ Tạo 2 view tiện ích: `iam.my_profile` (profile + role + department của chính user đang đăng nhập), `ops.my_alerts` (alerts + tên shop của user).
- ✅ Chuông thông báo (`BellWithData.tsx`): query thật từ `ops.my_alerts` qua browser; đánh dấu ack khi mở dropdown; badge "● LIVE DB" khi có dữ liệu DB; fallback mock nếu query lỗi (sandbox) hoặc DB trống.
- ✅ Trang /profile (`ProfileClient.tsx`): đọc từ `iam.my_profile`; cho phép user tự sửa Họ tên / Số điện thoại (update thật xuống `iam.user_profiles`); nút "Gửi link reset mật khẩu" dùng `supabase.auth.resetPasswordForEmail`; panel Đăng xuất đỏ cuối trang.
- ✅ Form tạo user mới (`/module0/users/new`): tải danh sách phòng ban & shop từ DB; gọi `POST /api/admin/invite-user` dùng Supabase Auth Admin API mời email (service_role) + insert `iam.user_profiles`/`iam.role_assignments`/`iam.assignments` + ghi `iam.audit_logs`; kiểm tra phân cấp quyền (super_admin gán mọi role, org_admin không gán được super_admin, dept_lead chỉ được gán operator/analyst).
- ⚠️ ~~Seed `supabase/seed/seed_demo.sql`: tự động tạo super_admin cho tài khoản đang đăng nhập~~ — **SAI**. Mục 4+5 của file này mở đầu bằng `if auth.uid() is null then return`, mà trong SQL Editor `auth.uid()` luôn NULL → âm thầm bỏ qua. Đã thay bằng migration `0007`.
- ✅ Migration `0006_cleanup_rls_test_fixtures.sql` — dọn fixture test theo UUID cố định, idempotent, giữ nguyên user thật.
- ✅ Migration `0007_seed_admin_and_alerts.sql` — tạo profile + super_admin + gán shop + 9 alerts **không cần phiên đăng nhập**; idempotent (dùng `NOT EXISTS` vì `unique(user_id, role, department_id)` không chặn trùng khi `department_id` NULL).
- ✅ `rls_test.sql` — `commit;` → `rollback;`, thêm cờ `vexim.allow_rls_test`, temp table `on commit drop`, tự dọn fixture trước khi seed.
- ✅ `run-inventory-sync.ts` — chỉ ghi DB thật khi `mode === "production"`; bỏ fallback `DEMO_SHOP`; thêm field `db` vào kết quả.
- ✅ `api/cron/inventory-sync/route.ts` — thiếu `CRON_SECRET` trên production → 500 kèm hướng dẫn, không còn 401 im lặng.
- ✅ `supabase/tests/run-migrations.mjs` + `supabase/package.json` — bộ kiểm chứng 53 assertion trên PostgreSQL 18.3.
- ☐ Chờ VEXIM chạy `0006` rồi `0007` trong SQL Editor.
- ☐ Cần thêm **`CRON_SECRET`** trên Vercel (Production + Preview) rồi Redeploy.
- ✅ `SUPABASE_SERVICE_ROLE_KEY` đã có trên Vercel (API invite-user dùng được).

## Hạ tầng Module 4 · 6 · 7 (12/09 — theo thứ tự build 7 → 4 → 6)

Đã dựng **tầng dữ liệu + logic thật** cho 3 module ưu tiên (màn hình đã có từ PR #1/#2,
vẫn đang đọc mock — bước cắm UI vào dữ liệu thật làm ngay sau khi có report thật).

**Migration `0010_module_4_6_7_orders_finance_health.sql`** — bổ sung đúng những gì tầng
sync cần, không đổi/xoá cột cũ:
- `sales.orders` + merchant_order_id/last_updated_date/marketplace_id/ship_state/ship_country/`pii_stripped` + index queue FBM; `sales.order_items` + amazon_order_item_id/item_name/item_status; `sales.returns_refunds` + sku/asin/quantity/amazon_rma_id/reason_label/reason_group/resolution/**dedupe_key** (chống trùng khi import lại)
- bảng mới `sales.order_daily` (KPI ngày: đơn/đơn vị/tiền/FBM quá hạn/returns) và schema mới **`account_health`**: `snapshots` (ngày × marketplace: status, AHR, tone, điểm nội bộ, rates jsonb) + `issues` (vi phạm mở: severity, nhóm, defects_count, case_id, owner, resolved_at)
- `finance.settlements` + deposit_date/status/breakdown/reconcile_diff/reconciled_at; `finance.financial_events` + sku/amount_type/amount_description/order_id/quantity/marketplace_name/dedupe_key
- 3 rule cảnh báo: `fbm_late_ship` (red) · `return_reason_spike` (amber) · `reconciliation_mismatch` (red); RLS + grant; **4 view public** để web đọc không phụ thuộc "Exposed schemas": `vexim_shop_health`, `vexim_health_issues`, `vexim_order_daily`, `vexim_fbm_queue`
- DO-block tự kiểm tra cuối migration: đủ 3 bảng + 3 rule + 4 view, và **raise nếu phát hiện cột PII** trong sales/finance/account_health

**Code worker (đã có test):**
- `domain/orders.ts` (43 test) — chuẩn hoá trạng thái (không tự bịa "Delivered"), hạn ship FBM (dùng LatestShipDate thật; report thiếu thì đánh dấu `assumed`), KPI, hotspot trả hàng (≥3 đơn hoặc ≥5%), cửa sổ delta 15 phút lùi 5 phút chồng lấn, alert theo `rule_code`
- `reports/all-orders.parser.ts` + `reports/returns.parser.ts` — **bỏ `ship-city`/`ship-postal-code` ngay khi parse** (quyết định PII v1.1), gom đơn từ dòng item, dịch mã lý do trả hàng sang tiếng Việt + nhóm
- `jobs/orders-sync.job.ts` — `buildOrdersSnapshot` (thuần, test được) + `runOrdersSync` (ghi orders/items/returns/order_daily/alerts/sync_jobs); giới hạn đúng SP-API: getOrders 0.0167 rps/burst 20, getOrderItems 0.5/30, report all-orders ≤30 ngày, returns ≤60 ngày
- `notifications/orders.handler.ts` — ORDER_CHANGE: **bóc DestinationPostalCode** (PII) trước khi lưu log, upsert đơn, cảnh báo FBM theo hạn ship thật, nhận cả casing PascalCase/camelCase
- `reports/settlement.parser.ts` + `jobs/finance-sync.job.ts` (24 test) — parser bám bản **`GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2`** (bản `_FLAT_FILE`/`_XML` đã deprecated), parse số kiểu local (95,00 → 95), đối soát theo SOP-10: tổng các nhóm **trừ dòng Transfer** vs số tiền chuyển, lệch >1% → alert `reconciliation_mismatch`
- `domain/account-health.ts` + `reports/seller-performance.parser.ts` + `jobs/account-health-sync.job.ts` + `notifications/account-health.handler.ts` (46 test) — parser bám **`GET_V2_SELLER_PERFORMANCE_REPORT`** (bản JSON của Account Health dashboard: accountStatuses, 6 chỉ số, warningStates 10 nhóm vi phạm + AHR) — *tài liệu kế hoạch ghi V1; V1 là bản XML cũ, V2 mới có đủ AHR + vi phạm*; hạ tầng: ưu tiên ngưỡng Amazon, thiếu thì dùng ngưỡng VEXIM và **đánh dấu nguồn**, "thiếu dữ liệu" không bao giờ hiện xanh; ACCOUNT_STATUS_CHANGED về NORMAL → tự đóng alert đang mở
- `db/adapter.ts` + `db/supabase.ts` — 9 method ghi mới cho 3 module (upsertOrders có thay order_items, dedupe returns, snapshot/issue, settlement + **replace** financial_events của kỳ, resolveAlerts); schema `sales|finance|account_health` đã thêm vào gợi ý **Exposed schemas** khi gặp PGRST205/PGRST202
- CLI: `worker orders:sync --file=orders.tsv [--returns=returns.tsv]` · `worker finance:sync --file=settlement.tsv` · `worker account-health:sync --file=performance.json` — chỉ ghi DB thật khi `mode === "production"`; mặc định/`--dry-run` chạy trong bộ nhớ và in bản tóm tắt

**Kiểm chứng (chạy thật):**

```bash
cd worker && npm test     # 241 tests / 241 pass / 0 fail  (trước đó 116)
cd supabase && npm test   # TẤT CẢ PASS — BƯỚC 9 chạy 0010 + chạy lại lần 2 (idempotent)
cd web && npx tsc --noEmit && npx next build   # ✓ Compiled successfully
```

**Việc cần VEXIM làm:** chạy migration `0010` trong SQL Editor (sau `0006`/`0007`/`0008`/`0009`),
sau đó thêm schema **`sales`, `finance`, `account_health`** vào Supabase → Settings → API →
*Exposed schemas* để các view `vexim_*` đọc được bằng anon key (worker dùng service_role
nên không phụ thuộc bước này).

## Cách verify nhanh (DEMO MODE)

1. Mở preview (port 3000) → trang đăng nhập → chọn vai trò.
2. Dropdown viền cam (topbar) đổi vai trò → sidebar & phạm vi đổi theo.
3. Thử Operator PPC vào URL `/finance` trực tiếp → bị chặn.

## Chờ VEXIM

- ✅ Tạo project Supabase (`pitmyzovjwflkyoqjbkz`) + set 14 biến môi trường trên Vercel — **xong 12/09**
- ☐ **Chạy `0006` rồi `0007` trong SQL Editor** (dọn fixture test + tạo super_admin/alerts)
- ☐ Chạy `0008` → `0009` → **`0010`** (wrapper RPC · shop production · hạ tầng Module 4/6/7)
- ☐ **Chạy `0020` rồi `0021`** (Amazon Ads đọc + phần 2/3: hàng đợi duyệt · audit · revert) — 0021 cần chạy SAU 0020
- ☐ **Chạy `0022_user_admin.sql`** (Module 0: quản trị người dùng thật — Sửa · Quyền · Khóa, khóa = mất quyền ở tầng RLS) — chạy SAU 0021
- ☐ ✅ `0011`/`0012`/`0013` đã chạy · ☐ **`0014`** (trình soạn listing L3) · ☐ **`0015`** (bồi hoàn FBA + lợi nhuận SKU) · ☐ **`0016`** (Đợt A: giá vốn + ghi listing + `vexim_pricing` dùng giá vốn) · ☐ **`0017`** (Đợt B: doanh số 30 ngày + người phụ trách + giá trị tồn kho) · ☐ **`0018`** (Module 3 nâng cao: phân bổ tồn theo FC + lịch sử nhận hàng)
- ☐ **Thêm `CRON_SECRET` trên Vercel** (Production + Preview) → Redeploy
- ☐ `AMAZON_LWA_CLIENT_ID` / `_CLIENT_SECRET` / `_REFRESH_TOKEN` khi Developer Profile được duyệt — thiếu 3 biến này thì worker chỉ chạy demo trong bộ nhớ (an toàn, không ghi DB thật)
- ☐ 4 thông tin thật cho landing page (email/phone/địa chỉ/tên pháp lý)
- ☐ Chốt 2–3 shop pilot + file giá vốn theo template CSV (tải template ngay trong app:
  `/finance/costs` → “⬇ Tải template CSV”, hoặc `GET /api/finance/cost-template`)
- ☐ Hải Anh: báo ngày nộp hồ sơ + tạo Sandbox Application ngay sau khi nộp

### Biến môi trường Vercel: cái nào code thật sự đọc

Code chỉ đọc **5 tên** này (`grep -rn "process.env" web/src`):

| Biến | Dùng ở | Trạng thái |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | supabase client/server, login, invite-user | ✅ đã set |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | supabase client/server, login | ✅ đã set |
| `SUPABASE_SERVICE_ROLE_KEY` | invite-user, worker | ✅ đã set |
| `CRON_SECRET` | cron inventory-sync | ❌ **THIẾU** |
| `AMAZON_LWA_CLIENT_ID/_SECRET/_REFRESH_TOKEN` | spapi client, worker | ⬜ chờ Amazon duyệt |

9 biến còn lại trên Vercel (`POSTGRES_*`, `SUPABASE_PUBLISHABLE_KEY`,
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_ANON_KEY`,
`SUPABASE_URL`, `SUPABASE_JWT_SECRET`) **code không đọc** — không gây hại, có thể để nguyên.
