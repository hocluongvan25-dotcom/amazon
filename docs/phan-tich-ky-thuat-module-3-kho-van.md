# PHÂN TÍCH KỸ THUẬT MODULE 3 — KHO VẬN & FBA (bản triển khai)

> Đi kèm lần triển khai màn hình I1–I4. Mọi API/report dưới đây đã kiểm chứng qua tài liệu chính thức Amazon (nguồn ở cuối). Tham chiếu kế hoạch tổng: `docs/ke-hoach-trien-khai-theo-module.md` (Module 3) · SOP-01/09: `docs/luong-van-hanh-chuan.md`.

---

## 1. NGUỒN DỮ LIỆU (đã kiểm chứng)

### 1.1. Tồn kho — 3 tầng đồng bộ

| Tầng | Cơ chế | Nguồn | Tần suất |
|---|---|---|---|
| **Realtime** | Notification **`FBA_INVENTORY_AVAILABILITY_CHANGES`** (EventBridge/SQS) — Amazon đẩy khi số lượng FBA thay đổi, payload có SellerId/SKU/FNSKU/ASIN + `FulfillmentInventoryByMarketplace` + **ReservedQuantityBreakdown** | Notifications API v1 | theo sự kiện (giây–phút) |
| **Theo lịch** | **`getInventorySummaries`** — FBA Inventory API v1 (granularity `MARKETPLACE`, details tổng hợp: fulfillable / reserved / inbound working / inbound shipped) | SP-API | mỗi 30–60 phút/shop (rate 2 rps · 30 burst) |
| **Đối soát ngày** | Report **`GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA`** — bộ cột chuẩn: `afn-warehouse-quantity = fulfillable + unsellable + reserved`; `afn-total-quantity = warehouse + inbound-working + inbound-shipped + inbound-receiving` | Reports API | 2h sáng hằng ngày |

> ⚠️ **Cảnh báo thực tế đã ghi nhận** (Seller Central forum 2025): một số kỳ report có cột `afn-reserved-*` rỗng làm tổng lệch. → Tầng đối soát phải **so 3 nguồn** (notification ∕ getInventorySummaries ∕ report) và đánh dấu lệch thay vì tự tin đè số — hiển thị trên màn Sync Health.

### 1.2. Tồn theo fulfillment center & lịch sử nhận hàng (màn I2)

| Dữ liệu | Report | Ghi chú |
|---|---|---|
| Phân bổ theo FC (số lượng + disposition) | **`GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA`** | snapshot hằng ngày theo từng FC |
| Lịch sử nhận hàng tại FC | **`GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA`** | đối soát "thực nhận vs kế hoạch" |
| Biến động tồn (bán/return/mất/tìm thấy) | `GET_LEDGER_DETAIL_VIEW_DATA` | dùng chung cho SOP-09 bồi hoàn |
| Điều chỉnh mất/hư/sửa số | `GET_FBA_FULFILLMENT_INVENTORY_ADJUSTMENTS_DATA` | input claim SOP-09 |
| Tồn dư/thừa khuyến nghị xử lý | `GET_EXCESS_INVENTORY_DATA` + `GET_FBA_INVENTORY_AGED_DATA` (aged 90/180/270/365+) | panel "tồn lâu" của I1 |

### 1.3. Nhập hàng (I3 ghi / I4 theo dõi)

- **Fulfillment Inbound API v2024-03-20** — tạo & vận hành inbound plan: `createInboundPlan` → `setPackingInformation` → `generatePackingOptions` → `confirmPackingOption` → `generatePlacementOptions` → `confirmPlacementOption` → `generateTransportationOptions` → `confirmTransportationOptions`; theo dõi: `getInboundPlan` / `listInboundPlans` / `getShipment` / `listShipmentItems`.
- **Role yêu cầu: Amazon Fulfillment** — đã chốt NỘP KÈM trong Developer Profile.
- Trạng thái shipment chuẩn Amazon để hiển thị ở I4: `WORKING → SHIPPED → IN_TRANSIT → DELIVERED → CHECKED_IN → RECEIVING → CLOSED` (+ `CANCELLED`).

---

## 2. LOGIC NGHIỆP VỤ (tính phía VEXIM, không có sẵn của Amazon)

### 2.1. Các chỉ số dẫn xuất

```
velocity_14d      = (đơn vị bán 14 ngày gần nhất, đã loại 2 ngày đỉnh outlier) / 14
days_of_cover     = fulfillable / velocity_14d          (velocity = 0 → ∞, hiển thị "—")
in_stock %        = SKU có fulfillable > 0 / tổng SKU đang bán
giá trị tồn       = Σ (fulfillable + reserved + inbound) × unit_cost (bảng cost_inputs)
                    ✅ ĐÃ CÓ (migration 0017): view vexim_inventory_latest trả stock_value,
                    total_stock_value, unit_cost, value_currency, value_basis ('cost'|'missing').
                    Thiếu giá vốn → NULL + 'missing', KHÔNG hiện 0. Tính theo tiền của giá vốn.
```

### 2.2. Đề xuất nhập hàng (I3) — công thức đã chốt ở SOP-01

```
suggest = ceil_to_case_pack(
  velocity_14d × (lead_time_days + safety_days) − (fulfillable + reserved + inbound)
)
  · lead_time_days: theo đường nhập của VEXIM (nhanh/chậm) — nhập tay theo shop
  · safety_days mặc định 14 — trưởng phòng chỉnh theo shop được
  · nếu kết quả ≤ 0 → "Đủ hàng — không cần nhập"
```

### 2.3. Ngưỡng cảnh báo (alert_rules đã seed ở migration 0001)

| Rule | Ngưỡng | Severity |
|---|---|---|
| `stockout_risk` | days_of_cover < **14** | đỏ nếu < 7, vàng nếu 7–14 |
| Hết hàng thật | fulfillable = 0 (và đang bán) | đỏ + task SOP-01 khẩn |
| Tồn lâu | aged > 365 ngày | vàng → đề xuất removal/liquidation |
| Nhận thiếu | thực nhận < kế hoạch > ngưỡng % | task SOP-09 (claim bồi hoàn) |

### 2.4. Trường hợp biên (đã thiết kế xử lý)

1. **SKU mới chưa có lịch sử bán** (velocity = 0): đề xuất nhập theo kế hoạch launch của phòng (nhập tay), không tự sinh số ảo.
2. **Reserved không tính là khả dụng**: cover chỉ dùng fulfillable — reserved (đang pick/ship) là "sắp hết chỗ đứng" cần theo dõi riêng.
3. **Đang về (inbound) phải trừ** khỏi đề xuất để không nhập chồng — cột riêng ở I1.
4. **Shop chưa sync / sync lỗi**: dòng hiển thị trạng thái "dữ liệu cũ X giờ" thay vì số sai.
5. **Đơn vị lẻ / case pack**: làm tròn lên bội số đóng gói theo cấu hình SKU.

---

## 3. ÁNH XẠ DATABASE (đã có ở migrations)

| Bảng | Vai trò trong module |
|---|---|
| `inventory.inventory_snapshots` | mỗi lần sync ghi 1 snapshot (fulfillable/reserved/inbound) — vẽ I2 90 ngày |
| `inventory.inventory_daily` | chốt ngày + days_of_cover + in_stock — dashboard & I1 đọc nhanh |
| `inventory.inbound_shipments` | I4: shipment + trạng thái + ETA + số nhận đối soát |
| `catalog.cost_inputs` | giá vốn theo khoảng hiệu lực → giá trị tồn & giá trị lô nhập |
| `ops.alerts` (rule `stockout_risk`) | sinh task SOP-01 |
| `ops.tasks` + `ops.task_templates` | chạy vòng đời 8 bước của kế hoạch nhập (I3) |
| `connections.sync_jobs` / `api_usage_daily` | giám sát & chi phí |

---

## 4. THÔNG SỐ MÀN HÌNH (triển khai đợt này — bản đọc, mock)

| Màn | Route | Nội dung chính |
|---|---|---|
| **I1** Tồn kho theo SKU | `/fulfillment/inventory` | Bảng: SKU/ASIN, shop, fulfillable, reserved, đang về, velocity, cover (màu), đề xuất nhập, trạng thái (Hết/Sắp hết/Đủ/Tồn lâu). Filter chips. Click SKU → I2 |
| **I2** Chi tiết tồn SKU | `/fulfillment/inventory/detail?sku=` | Biểu đồ tồn & doanh số 90 ngày · phân bổ theo FC · lịch sử nhận hàng (đủ/thiếu) · lô đang về · giá vốn hiện hành |
| **I3** Kế hoạch nhập hàng | `/fulfillment/restock` | Các dòng theo bước SOP-01 (nháp → chốt giá vốn → duyệt → đã tạo inbound) · tổng giá trị · **nút ghi bị khóa: Đợt 2** (cần production API + role Amazon Fulfillment) |
| **I4** Inbound shipments | `/fulfillment/inbound` | Bảng theo trạng thái chuẩn Amazon + FC + ETA + kết quả đối soát nhận hàng |

**Cổng ghi (write gating):** Đợt 1 chỉ đọc + đề xuất. Nút "Duyệt & tạo inbound plan" hiện disabled kèm lý do — bật khi: (1) profile được duyệt, (2) role Amazon Fulfillment active, (3) pilot đối soát ≥ 99%. Mọi thao tác ghi sau đó vẫn đi qua duyệt + audit log như thiết kế.

---

## NGUỒN KIỂM CHỨNG

1. Notification type values (FBAInventoryAvailabilityChangeNotification + ReservedQuantityBreakdown): developer-docs.amazon.com/sp-api/docs/notification-type-values
2. Cột & công thức GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA: tài liệu report types SP-API + Seller Central forum (cảnh báo cột reserved rỗng)
3. Report theo FC / nhận hàng / điều chỉnh: GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA · GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA · GET_FBA_FULFILLMENT_INVENTORY_ADJUSTMENTS_DATA (FBA report types)
4. Fulfillment Inbound API v2024-03-20 + role Amazon Fulfillment: developer-docs.amazon.com/sp-api/docs/fulfillment-inbound-api · /docs/role-mappings
5. FBA Inventory API v1 getInventorySummaries: developer-docs.amazon.com/sp-api/docs/fba-inventory-api-v1-reference
