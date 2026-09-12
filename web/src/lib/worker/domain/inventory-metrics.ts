/**
 * Chỉ số nghiệp vụ kho vận — ĐÚNG công thức docs/phan-tich-ky-thuat-module-3-kho-van.md mục 2.
 * Đây là logic phía VEXIM (Amazon không cung cấp sẵn).
 */
export const SAFETY_DAYS_DEFAULT = 14;
export const VELOCITY_WINDOW_DAYS = 14;
export const VELOCITY_OUTLIER_DAYS = 2; // loại 2 ngày đỉnh
export const COVER_ALERT_THRESHOLD = 14; // < 14 → cảnh báo

/**
 * velocity_14d = (tổng bán 14 ngày gần nhất − 2 ngày đỉnh outlier) / 14
 * @param dailyUnits mảng đơn vị bán theo ngày, PHẦN TỬ ĐẦU = gần nhất
 */
export function computeVelocity14(dailyUnits: number[]): number {
  const window = dailyUnits.slice(0, VELOCITY_WINDOW_DAYS);
  if (window.length < VELOCITY_WINDOW_DAYS) {
    // SKU mới / thiếu dữ liệu: tính trên số ngày có — nhỏ hơn 7 ngày trả 0 (không đủ tin cậy)
    if (window.length < 7) return 0;
  }
  const sorted = [...window].sort((a, b) => b - a);
  const outliers = sorted.slice(0, VELOCITY_OUTLIER_DAYS);
  const outlierSum = outliers.reduce((s, v) => s + v, 0);
  const sum = window.reduce((s, v) => s + v, 0);
  return (sum - outlierSum) / VELOCITY_WINDOW_DAYS;
}

/** days_of_cover = floor(fulfillable / velocity); velocity 0 → null ("—") */
export function daysOfCover(fulfillable: number, velocity: number): number | null {
  if (velocity <= 0) return null;
  return Math.floor(fulfillable / velocity);
}

export type RestockInput = {
  velocity: number;
  leadDays: number; // đường nhập của VEXIM (nhanh/chậm) — cấu hình theo shop
  safetyDays?: number;
  fulfillable: number;
  reserved: number;
  inbound: number;
  casePack?: number; // bội số đóng gói, mặc định 1
};

/**
 * Đề xuất nhập = ceil theo case pack của:
 *   velocity × (leadDays + safetyDays) − (fulfillable + reserved + inbound)
 * Kết quả ≤ 0 → null ("Đủ hàng — không cần nhập")
 */
export function restockSuggestion(input: RestockInput): number | null {
  const safety = input.safetyDays ?? SAFETY_DAYS_DEFAULT;
  const casePack = Math.max(1, input.casePack ?? 1);
  const need =
    input.velocity * (input.leadDays + safety) -
    (input.fulfillable + input.reserved + input.inbound);
  if (need <= 0) return null;
  return Math.ceil(need / casePack) * casePack;
}

/** Màu cảnh báo theo cover: <7 đỏ · 7–13 vàng · ≥14 (hoặc null) không cảnh báo */
export function stockoutSeverity(
  coverDays: number | null,
): "red" | "amber" | null {
  if (coverDays === null) return null;
  if (coverDays < 7) return "red";
  if (coverDays < COVER_ALERT_THRESHOLD) return "amber";
  return null;
}
