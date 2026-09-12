/**
 * Test Module 4 — domain Đơn hàng (worker/src/domain/orders.ts).
 * Khoá hành vi: trạng thái, hạn ship FBM, KPI, returns lý do, cửa sổ delta, alert.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_HANDLING_HOURS,
  DELTA_OVERLAP_MINUTES,
  buildFbmQueue,
  countdownLabel,
  fbmRisk,
  fbmShipAlert,
  fbmShipDeadline,
  hoursUntilDeadline,
  isFbm,
  normalizeOrderStatus,
  normalizeReasonKey,
  onTimeShipRate,
  orderDeltaWindow,
  orderKpis,
  returnHotspots,
  returnRatePct,
  returnReasonLabel,
  returnsBreakdown,
} from "../src/domain/orders.ts";

describe("normalizeOrderStatus — trạng thái Amazon → UI", () => {
  test("Canceled/Cancelled → Cancelled", () => {
    assert.equal(normalizeOrderStatus("Canceled"), "Cancelled");
    assert.equal(normalizeOrderStatus("cancelled"), "Cancelled");
  });
  test("Shipped và PartiallyShipped → Shipped", () => {
    assert.equal(normalizeOrderStatus("Shipped"), "Shipped");
    assert.equal(normalizeOrderStatus("PartiallyShipped"), "Shipped");
  });
  test("Unshipped/Pending/PendingAvailability/UpComing → Pending", () => {
    for (const s of ["Unshipped", "Pending", "PendingAvailability", "UpComing", "InvoiceUnconfirmed", "Unfulfillable"]) {
      assert.equal(normalizeOrderStatus(s), "Pending", s);
    }
  });
  test("KHÔNG tự đoán Delivered (Amazon không trả trạng thái này)", () => {
    assert.equal(normalizeOrderStatus("Delivered"), "Pending");
  });
});

describe("isFbm — kênh fulfill", () => {
  test("MFN = FBM (seller tự ship)", () => {
    assert.equal(isFbm("MFN"), true);
    assert.equal(isFbm("mfn"), true);
  });
  test("AFN = FBA, không phải FBM", () => {
    assert.equal(isFbm("AFN"), false);
    assert.equal(isFbm(null), false);
  });
});

describe("fbmShipDeadline — hạn ship", () => {
  test("ưu tiên LatestShipDate của Amazon (không phải ước lượng)", () => {
    const d = fbmShipDeadline({ purchaseDate: "2026-09-01T00:00:00Z", latestShipDate: "2026-09-03T00:00:00Z" });
    assert.equal(d.assumed, false);
    assert.equal(d.deadline.toISOString(), "2026-09-03T00:00:00.000Z");
  });
  test("thiếu LatestShipDate → purchaseDate + handling, đánh dấu assumed", () => {
    const d = fbmShipDeadline({ purchaseDate: "2026-09-01T00:00:00Z" });
    assert.equal(d.assumed, true);
    assert.equal(d.deadline.toISOString(), "2026-09-02T00:00:00.000Z");
    assert.equal(DEFAULT_HANDLING_HOURS, 24);
  });
  test("handlingHours tuỳ chỉnh", () => {
    const d = fbmShipDeadline({ purchaseDate: "2026-09-01T00:00:00Z", handlingHours: 48 });
    assert.equal(d.deadline.toISOString(), "2026-09-03T00:00:00.000Z");
  });
  test("latestShipDate hỏng → rơi về ước lượng", () => {
    const d = fbmShipDeadline({ purchaseDate: "2026-09-01T00:00:00Z", latestShipDate: "không-phải-ngày" });
    assert.equal(d.assumed, true);
  });
});

describe("fbmRisk / countdownLabel — mức gấp của queue O3", () => {
  const NOW = new Date("2026-09-10T12:00:00Z");
  test("quá hạn (<0h) → overdue", () => {
    assert.equal(fbmRisk(-0.1), "overdue");
  });
  test("< 4h → critical, < 12h → warning, còn lại ok", () => {
    assert.equal(fbmRisk(3.9), "critical");
    assert.equal(fbmRisk(4), "warning");
    assert.equal(fbmRisk(11.9), "warning");
    assert.equal(fbmRisk(12), "ok");
  });
  test("hoursUntilDeadline đếm đúng và làm tròn 1 chữ số", () => {
    assert.equal(hoursUntilDeadline(new Date("2026-09-10T15:20:00Z"), NOW), 3.3);
    assert.equal(hoursUntilDeadline(new Date("2026-09-10T10:00:00Z"), NOW), -2);
  });
  test("countdownLabel: còn hạn và quá hạn", () => {
    assert.equal(countdownLabel(3.5), "3h 30m");
    assert.equal(countdownLabel(0.5), "30m");
    assert.equal(countdownLabel(-5.25), "quá hạn 5h 15m");
  });
});

describe("orderKpis — KPI O1", () => {
  const orders = [
    { amazonOrderId: "1", status: "Unshipped", fulfillmentChannel: "MFN", purchaseDate: "2026-09-01T00:00:00Z", orderTotal: 100, itemsCount: 2 },
    { amazonOrderId: "2", status: "Shipped", fulfillmentChannel: "MFN", purchaseDate: "2026-09-01T00:00:00Z", orderTotal: 50.5, itemsCount: 1 },
    { amazonOrderId: "3", status: "Shipped", fulfillmentChannel: "AFN", purchaseDate: "2026-09-01T00:00:00Z", orderTotal: 75.25, itemsCount: 3 },
    { amazonOrderId: "4", status: "Canceled", fulfillmentChannel: "AFN", purchaseDate: "2026-09-01T00:00:00Z", orderTotal: 20, itemsCount: 1 },
  ];

  test("đếm đơn/đơn vị/tiền và tách FBM/FBA", () => {
    const k = orderKpis(orders);
    assert.equal(k.orders, 4);
    assert.equal(k.units, 7);
    assert.equal(k.sales, 245.75);
    assert.equal(k.fbmUnshipped, 1);
    assert.equal(k.fbmShipped, 1);
    assert.equal(k.afnOrders, 2);
    assert.equal(k.cancelled, 1);
  });

  test("đơn rỗng → mọi chỉ số 0, currency mặc định USD", () => {
    const k = orderKpis([]);
    assert.deepEqual(k, {
      orders: 0, units: 0, sales: 0, currency: "USD",
      fbmUnshipped: 0, fbmShipped: 0, afnOrders: 0, cancelled: 0,
    });
  });
});

describe("onTimeShipRate — tỷ lệ ship đúng hạn", () => {
  test("tính đúng % (đúng hạn = shippedAt ≤ latestShipDate)", () => {
    const rate = onTimeShipRate([
      { shippedAt: "2026-09-01T10:00:00Z", latestShipDate: "2026-09-02T00:00:00Z" },
      { shippedAt: "2026-09-03T00:00:00Z", latestShipDate: "2026-09-02T00:00:00Z" },
      { shippedAt: "2026-09-02T00:00:00Z", latestShipDate: "2026-09-02T00:00:00Z" },
      { shippedAt: "2026-09-04T00:00:00Z", latestShipDate: "2026-09-02T00:00:00Z" },
    ]);
    assert.equal(rate, 50);
  });
  test("không có dữ liệu → null (không báo động giả 0%)", () => {
    assert.equal(onTimeShipRate([]), null);
    assert.equal(onTimeShipRate([{ shippedAt: "", latestShipDate: "" }]), null);
  });
});

describe("buildFbmQueue — queue O3", () => {
  const NOW = new Date("2026-09-10T12:00:00Z");

  test("chỉ lấy đơn FBM chưa ship, xếp hạn gần nhất lên đầu", () => {
    const queue = buildFbmQueue(
      [
        { amazonOrderId: "A", status: "Unshipped", fulfillmentChannel: "MFN", purchaseDate: "2026-09-10T06:00:00Z", itemsCount: 1 },
        { amazonOrderId: "B", status: "Unshipped", fulfillmentChannel: "MFN", purchaseDate: "2026-09-09T00:00:00Z", itemsCount: 2 },
        { amazonOrderId: "C", status: "Shipped", fulfillmentChannel: "MFN", purchaseDate: "2026-09-09T00:00:00Z" },
        { amazonOrderId: "D", status: "Unshipped", fulfillmentChannel: "AFN", purchaseDate: "2026-09-09T00:00:00Z" },
      ],
      NOW,
      { handlingHours: 12 },
    );
    assert.deepEqual(queue.map((q) => q.amazonOrderId), ["B", "A"]);
    assert.equal(queue[0].risk, "overdue"); // hạn 2026-09-09T12:00 → trễ 24h
    assert.equal(queue[1].risk, "warning"); // hạn 2026-09-10T18:00 → còn 6h (< 12h)
    assert.equal(queue[0].deadlineAssumed, true);
  });

  test("includeShipped = true trả cả đơn đã ship (đối soát)", () => {
    const queue = buildFbmQueue(
      [{ amazonOrderId: "C", status: "Shipped", fulfillmentChannel: "MFN", purchaseDate: "2026-09-09T00:00:00Z" }],
      NOW,
      { includeShipped: true },
    );
    assert.equal(queue.length, 1);
  });

  test("nguồn hạn THẬT (latestShipDate) → deadlineAssumed = false", () => {
    const queue = buildFbmQueue(
      [{ amazonOrderId: "E", status: "Unshipped", fulfillmentChannel: "MFN", purchaseDate: "2026-09-10T00:00:00Z", latestShipDate: "2026-09-11T00:00:00Z" }],
      NOW,
    );
    assert.equal(queue[0].deadlineAssumed, false);
    // Đúng 12h: biên của dải "warning" là < 12h → 12h vẫn là ok (không báo động sớm)
    assert.equal(queue[0].risk, "ok");
  });
});

describe("returnReasonLabel — dịch lý do trả hàng Amazon", () => {
  test("text tiếng Anh thông dụng → nhãn tiếng Việt + nhóm", () => {
    assert.deepEqual(returnReasonLabel("No longer needed").group, "remorse");
    assert.equal(returnReasonLabel("Item defective or doesn't work").group, "quality");
    assert.equal(returnReasonLabel("Arrived too late").group, "logistics");
    assert.equal(returnReasonLabel("Too small").group, "size");
  });
  test("mã dạng UPPER_SNAKE vẫn nhận", () => {
    assert.equal(returnReasonLabel("APPAREL_TOO_LARGE").group, "size");
    assert.equal(returnReasonLabel("UNAUTHORIZED_PURCHASE").group, "logistics");
    assert.equal(returnReasonLabel("MISSING_PARTS").group, "quality");
  });
  test("lý do lạ → giữ nguyên chuỗi gốc, nhóm other (không nuốt dữ liệu)", () => {
    const info = returnReasonLabel("Lý do nội bộ VEXIM tự nhập");
    assert.equal(info.label, "Lý do nội bộ VEXIM tự nhập");
    assert.equal(info.group, "other");
  });
  test("rỗng → 'Không rõ lý do'", () => {
    assert.equal(returnReasonLabel("").label, "Không rõ lý do");
  });
  test("normalizeReasonKey bỏ dấu câu/gạch dưới", () => {
    assert.equal(normalizeReasonKey("No_Longer-Needed!"), "no longer needed");
  });
});

describe("returnsBreakdown / returnHotspots / returnRatePct — O4", () => {
  const returns = [
    { sku: "XMO-950-BLK", returnDate: "2026-09-01T00:00:00Z", reason: "Item defective or doesn't work", refundAmount: 129.99 },
    { sku: "XMO-950-BLK", returnDate: "2026-09-02T00:00:00Z", reason: "Item defective or doesn't work", refundAmount: 129.99 },
    { sku: "XMO-950-BLK", returnDate: "2026-09-03T00:00:00Z", reason: "No longer needed", refundAmount: 120 },
    { sku: "VPN-220-PRO", returnDate: "2026-09-03T00:00:00Z", reason: "Arrived too late", refundAmount: 60 },
  ];

  test("gộp theo mã lý do, sắp theo số lượng, có % và tổng tiền", () => {
    const rows = returnsBreakdown(returns);
    assert.equal(rows.length, 3);
    const defect = rows.find((r) => r.label === "Hàng lỗi / hư hỏng / thiếu phụ kiện")!;
    assert.equal(defect.count, 2);
    assert.equal(defect.refundAmount, 259.98);
    assert.equal(defect.sharePct, 50);
  });

  test("hotspot: ≥3 đơn trả trong kỳ", () => {
    const hot = returnHotspots(returns);
    assert.equal(hot[0].sku, "XMO-950-BLK");
    assert.equal(hot[0].hot, true);
    assert.equal(hot.find((h) => h.sku === "VPN-220-PRO")!.hot, false);
  });

  test("hotspot theo tỷ lệ: 2 đơn trả / 30 bán = 6.7% ≥ 5% → hot", () => {
    const hot = returnHotspots(
      [
        { sku: "S1", returnDate: "2026-09-01T00:00:00Z", reason: "Damaged" },
        { sku: "S1", returnDate: "2026-09-02T00:00:00Z", reason: "Damaged" },
      ],
      { S1: 30 },
    );
    assert.equal(hot[0].ratePct, 6.7);
    assert.equal(hot[0].hot, true);
  });

  test("returnRatePct: mẫu số 0 → null (không chia cho 0)", () => {
    assert.equal(returnRatePct(0, 5), null);
    assert.equal(returnRatePct(200, 3), 1.5);
  });
});

describe("orderDeltaWindow — cửa sổ kéo delta", () => {
  const now = new Date("2026-09-10T12:00:00Z");
  test("lần đầu (chưa sync) → backfill 30 ngày", () => {
    const w = orderDeltaWindow(null, now);
    assert.equal(w.lastUpdatedAfter.toISOString(), "2026-08-11T12:00:00.000Z");
    assert.equal(w.watermark.toISOString(), now.toISOString());
  });
  test("các lần sau → lùi 5 phút chồng lấn (tránh sót đơn cập nhật trễ)", () => {
    const w = orderDeltaWindow(new Date("2026-09-10T11:00:00Z"), now);
    assert.equal(w.lastUpdatedAfter.toISOString(), "2026-09-10T10:55:00.000Z");
    assert.equal(DELTA_OVERLAP_MINUTES, 5);
  });
});

describe("fbmShipAlert — sinh cảnh báo rule fbm_late_ship", () => {
  test("không có đơn gấp → null", () => {
    assert.equal(fbmShipAlert([]), null);
  });
  test("có đơn quá hạn → severity red, nêu đích danh đơn gấp nhất", () => {
    const queue = buildFbmQueue(
      [
        { amazonOrderId: "111-1", status: "Unshipped", fulfillmentChannel: "MFN", purchaseDate: "2026-09-08T00:00:00Z", itemsCount: 1 },
        { amazonOrderId: "111-2", status: "Unshipped", fulfillmentChannel: "MFN", purchaseDate: "2026-09-11T23:00:00Z", itemsCount: 1 },
      ],
      new Date("2026-09-10T12:00:00Z"),
    );
    const alert = fbmShipAlert(queue)!;
    assert.equal(alert.ruleCode, "fbm_late_ship");
    assert.equal(alert.severity, "red");
    assert.match(alert.title, /ĐÃ TRỄ/);
    assert.match(alert.detail, /111-1/);
    assert.match(alert.detail, /ước lượng/);
  });
});
