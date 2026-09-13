/**
 * CLIENT PORTAL — LUẬT TÍNH & ĐỊNH DẠNG (pure, không I/O).
 *
 * VÌ SAO CÓ FILE NÀY (13/09/2026):
 *   Trang `/client` trước đây render 4 KPI và 2 "báo cáo" VIẾT CỨNG trong
 *   `web/src/lib/data/mock.ts` ($186,400 · 5,120 đơn · AHR 780 · $23,900…) và
 *   hiển thị nguyên như vậy cả khi hệ thống đã nối Supabase — khách hàng mở link
 *   production là thấy số bịa của một doanh nghiệp không tồn tại.
 *
 *   Nguyên tắc thay thế (giống badge menu & màn Người dùng):
 *     • Có dữ liệu thật ⇒ hiện số thật (tính từ view có RLS theo đúng shop khách được xem).
 *     • KHÔNG có dữ liệu ⇒ hiện "chưa có dữ liệu", TUYỆT ĐỐI không suy diễn ra 0 giả
 *       và không bịa số.
 *   Ở đây chỉ có hàm thuần (định dạng tiền, gộp theo loại tiền, tóm tắt sức khỏe…)
 *   để test được mà không cần DB.
 */

export type CurrencyTotal = { currency: string; total: number };

const SYMBOLS: Record<string, string> = {
  USD: "$",
  CAD: "CA$",
  MXN: "MX$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  VND: "₫",
  AUD: "A$",
  SEK: "kr",
  PLN: "zł",
};

const NO_DATA = "chưa có dữ liệu";

/** Ngày đầu tháng theo giờ địa phương (dạng YYYY-MM-DD để gửi PostgREST). */
export function monthStart(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

/** Gộp tiền theo loại tiền tệ — KHÔNG cộng các loại tiền khác nhau vào một số. */
export function sumByCurrency(
  rows: { amount: number | string | null | undefined; currency: string | null | undefined }[],
): CurrencyTotal[] {
  const map = new Map<string, number>();
  for (const r of rows) {
    const n = Number(r.amount ?? 0);
    if (!Number.isFinite(n) || n === 0) continue;
    const cur = (r.currency ?? "USD").toUpperCase();
    map.set(cur, (map.get(cur) ?? 0) + n);
  }
  return [...map.entries()]
    .map(([currency, total]) => ({ currency, total: Math.round(total * 100) / 100 }))
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
}

/** "$186,400" · "12,345 ₫" · "1,234 XYZ" (loại tiền lạ vẫn đọc được, không nuốt số). */
export function formatMoney(total: number, currency: string): string {
  const n = Number(total);
  if (!Number.isFinite(n)) return NO_DATA;
  const cur = (currency || "USD").toUpperCase();
  const decimals = Math.abs(n) < 1000 && !Number.isInteger(n) ? 2 : 0;
  const num = n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const sym = SYMBOLS[cur];
  return sym ? `${sym}${num}` : `${num} ${cur}`;
}

/** Danh sách nhiều loại tiền ⇒ "$12,300 · CA$1,200"; rỗng ⇒ "chưa có dữ liệu". */
export function formatMoneyList(list: CurrencyTotal[], max = 2): string {
  if (list.length === 0) return NO_DATA;
  const shown = list.slice(0, max).map((t) => formatMoney(t.total, t.currency));
  const rest = list.length - shown.length;
  return rest > 0 ? `${shown.join(" · ")} +${rest} loại tiền` : shown.join(" · ");
}

/** Số nguyên có dấu phân cách; null/không hợp lệ ⇒ "chưa có dữ liệu". */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return NO_DATA;
  return Number(n).toLocaleString("en-US");
}

/** Tỉ lệ hoàn/đơn (%) — không có đơn ⇒ null (KHÔNG trả 0% để khỏi nói sai). */
export function returnRatePct(orders: number, returns: number): number | null {
  if (!Number.isFinite(orders) || orders <= 0) return null;
  return Math.round((returns / orders) * 1000) / 10;
}

export type HealthInput = { tone: string | null; score: number | null }[];

export type HealthSummary = {
  label: string;
  detail: string;
  tone: "up" | "warn" | "down" | "flat";
};

/**
 * Tóm tắt sức khỏe tài khoản từ `vexim_shop_health` (bản ghi mới nhất mỗi shop):
 *   • không có bản ghi ⇒ "chưa có dữ liệu" (KHÔNG mặc định là "Tốt")
 *   • có shop đỏ ⇒ "Cần chú ý" (nêu tên shop đỏ)
 *   • chỉ vàng ⇒ "Theo dõi"
 *   • toàn xanh ⇒ "Tốt" + điểm thấp nhất
 */
export function summarizeHealth(rows: HealthInput, redShops: string[] = []): HealthSummary {
  if (rows.length === 0) {
    return { label: NO_DATA, detail: "chưa đồng bộ snapshot account health", tone: "flat" };
  }
  const tones = rows.map((r) => (r.tone ?? "").toLowerCase());
  const scores = rows.map((r) => Number(r.score)).filter((s) => Number.isFinite(s));
  const minScore = scores.length ? Math.min(...scores) : null;
  const scoreText = minScore === null ? "" : ` · điểm thấp nhất ${minScore}`;

  if (tones.includes("red")) {
    return {
      label: "Cần chú ý",
      detail: `${redShops.length ? redShops.join(", ") : "có shop"} đang ở mức đỏ${scoreText}`,
      tone: "down",
    };
  }
  if (tones.includes("amber") || tones.includes("yellow")) {
    return { label: "Theo dõi", detail: `có shop ở mức vàng${scoreText}`, tone: "warn" };
  }
  return { label: "Tốt", detail: `tất cả shop mức xanh${scoreText}`, tone: "up" };
}

export type SettlementLite = {
  settlementId: string;
  shop: string;
  periodEnd: string | null;
  depositDate: string | null;
  total: number;
  currency: string | null;
};

/** Kỳ thanh toán mới nhất theo `period_end` (null nếu chưa có kỳ nào). */
export function latestSettlement(list: SettlementLite[]): SettlementLite | null {
  if (list.length === 0) return null;
  return [...list].sort((a, b) => String(b.periodEnd ?? "").localeCompare(String(a.periodEnd ?? "")))[0];
}

/** "chiếu toán 24/09" chỉ khi DB có ngày; không có ⇒ nói thẳng là chưa có. */
export function depositText(s: SettlementLite | null): string {
  if (!s) return "chưa có kỳ thanh toán";
  if (!s.depositDate) return "chưa có ngày chi trả";
  const d = new Date(s.depositDate);
  if (Number.isNaN(d.getTime())) return "chưa có ngày chi trả";
  return `chi trả ${d.toLocaleDateString("vi-VN")}`;
}

/** Ngày → "13/09/2026" (dùng cho danh sách báo cáo). */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("vi-VN");
}

/** Nhãn kỳ: "01/08 → 31/08". */
export function periodText(from: string | null, to: string | null): string {
  if (!from && !to) return "—";
  return `${shortDate(from)} → ${shortDate(to)}`;
}
