/** Public view projection: no raw payloads or buyer PII. */
export type DataRow = { id: string; [key: string]: unknown };
export type Column = {
  key: string;
  label: string;
  money?: string;
  link?: string;
};
export type Screen =
  | "orders"
  | "fbm"
  | "returns"
  | "settlements"
  | "events"
  | "items";
export const screens: Record<
  Screen,
  {
    view: string;
    title: string;
    columns: Column[];
    select: string;
    amount?: string;
  }
> = {
  orders: {
    view: "vexim_orders",
    title: "Đơn hàng",
    amount: "order_total",
    select:
      "id,seller_account_id,shop,amazon_order_id,status,channel,purchase_date,last_updated_date,latest_ship_date,order_total,currency,items_count,marketplace_id,ship_state,ship_country,main_sku",
    columns: [
      { key: "amazon_order_id", label: "Mã đơn", link: "/orders/detail" },
      { key: "shop", label: "Shop" },
      { key: "marketplace_id", label: "Marketplace" },
      { key: "purchase_date", label: "Ngày mua" },
      { key: "status", label: "Trạng thái" },
      { key: "channel", label: "Kênh" },
      { key: "items_count", label: "Số món" },
      { key: "order_total", label: "Giá trị", money: "currency" },
      { key: "main_sku", label: "SKU chính" },
      { key: "last_updated_date", label: "Cập nhật nguồn" },
    ],
  },
  fbm: {
    view: "vexim_fbm_queue",
    title: "Queue FBM",
    amount: "order_total",
    select:
      "id,seller_account_id,shop,amazon_order_id,status,channel,purchase_date,last_updated_date,latest_ship_date,order_total,currency,items_count,main_sku",
    columns: [
      { key: "amazon_order_id", label: "Mã đơn", link: "/orders/detail" },
      { key: "shop", label: "Shop" },
      { key: "status", label: "Trạng thái" },
      { key: "main_sku", label: "SKU" },
      { key: "order_total", label: "Giá trị", money: "currency" },
      { key: "deadline", label: "Hạn ship (UTC)" },
      { key: "deadlineSource", label: "Nguồn hạn" },
      { key: "countdown", label: "Còn lại tại lúc tải" },
    ],
  },
  returns: {
    view: "vexim_returns",
    title: "Returns & Refunds",
    amount: "refund_amount",
    select:
      "id,seller_account_id,shop,amazon_order_id,return_date,reason,reason_label,reason_group,status,resolution,refund_amount,currency,sku,asin,quantity,amazon_rma_id",
    columns: [
      { key: "amazon_order_id", label: "Mã đơn" },
      { key: "shop", label: "Shop" },
      { key: "return_date", label: "Ngày trả" },
      { key: "sku", label: "SKU" },
      { key: "quantity", label: "Số lượng" },
      { key: "reason", label: "Mã lý do" },
      { key: "reason_label", label: "Lý do" },
      { key: "reason_group", label: "Nhóm" },
      { key: "status", label: "Trạng thái" },
      { key: "resolution", label: "Xử lý" },
      { key: "refund_amount", label: "Hoàn tiền", money: "currency" },
    ],
  },
  settlements: {
    view: "vexim_settlements",
    title: "Kỳ settlement",
    amount: "total_amount",
    select:
      "id,seller_account_id,shop,settlement_id,period_start,period_end,deposit_date,total_amount,currency,status,breakdown,reconcile_diff,reconciled_at,posted_at",
    columns: [
      {
        key: "settlement_id",
        label: "Kỳ",
        link: "/finance/settlements/detail",
      },
      { key: "shop", label: "Shop" },
      { key: "period_start", label: "Từ" },
      { key: "period_end", label: "Đến" },
      { key: "deposit_date", label: "Ngày chuyển" },
      { key: "status", label: "Trạng thái" },
      { key: "total_amount", label: "Tổng kỳ", money: "currency" },
      { key: "reconciliation", label: "Đối soát" },
      { key: "reconcile_diff", label: "Chênh lệch", money: "currency" },
      { key: "posted_at", label: "Ghi nhận" },
    ],
  },
  events: {
    view: "vexim_financial_events",
    title: "Dòng tài chính",
    amount: "amount",
    select:
      "id,seller_account_id,shop,settlement_id,event_type,event_date,amount,currency,sku,amount_type,amount_description,order_id,quantity,marketplace_name",
    columns: [
      { key: "event_date", label: "Ngày" },
      { key: "shop", label: "Shop" },
      { key: "event_type", label: "Loại" },
      { key: "amount_type", label: "Nhóm tiền" },
      { key: "amount_description", label: "Mô tả" },
      { key: "sku", label: "SKU" },
      { key: "order_id", label: "Mã đơn" },
      { key: "amount", label: "Số tiền", money: "currency" },
      { key: "marketplace_name", label: "Marketplace" },
    ],
  },
  items: {
    view: "vexim_order_items",
    title: "Dòng hàng",
    select:
      "id,order_id,seller_account_id,shop,amazon_order_id,sku,asin,quantity,item_price,item_status,currency",
    columns: [
      { key: "sku", label: "SKU" },
      { key: "asin", label: "ASIN" },
      { key: "quantity", label: "Số lượng" },
      { key: "item_price", label: "Giá trị dòng hàng", money: "currency" },
      { key: "item_status", label: "Trạng thái" },
    ],
  },
};
export function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "—";
}
export function numeric(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim()))
    return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
export function money(value: unknown, currency: unknown): string {
  const n = numeric(value);
  return n === null
    ? "—"
    : `${n.toLocaleString("vi-VN", { maximumFractionDigits: 4 })} ${text(currency)}`;
}
export function deadline(row: DataRow, now: number): DataRow {
  const actual =
    typeof row.latest_ship_date === "string"
      ? Date.parse(row.latest_ship_date)
      : NaN;
  const purchase =
    typeof row.purchase_date === "string" ? Date.parse(row.purchase_date) : NaN;
  const at = Number.isFinite(actual)
    ? actual
    : Number.isFinite(purchase)
      ? purchase + 24 * 3600000
      : NaN;
  const hours = (at - now) / 3600000;
  return {
    ...row,
    deadlineSort: Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER,
    deadline: Number.isFinite(at) ? new Date(at).toISOString() : null,
    deadlineSource: Number.isFinite(actual)
      ? "Amazon"
      : Number.isFinite(at)
        ? "Ước lượng: ngày mua + 24h (giả định, chưa có handling shop)"
        : "Chưa có hạn",
    countdown: !Number.isFinite(hours)
      ? "—"
      : hours < 0
        ? `Quá hạn ${Math.abs(hours).toFixed(1)} giờ`
        : `${hours.toFixed(1)} giờ`,
  };
}
export function reconciliation(row: DataRow): string {
  const breakdown = row.breakdown;
  if (
    !row.reconciled_at ||
    (breakdown &&
      typeof breakdown === "object" &&
      "transferSource" in breakdown &&
      breakdown.transferSource === "none")
  )
    return "Chưa đủ dữ liệu đối soát";
  const diff = numeric(row.reconcile_diff);
  return diff !== null && diff !== 0
    ? "Có chênh lệch"
    : "Trong dung sai (theo worker)";
}
export function totals(rows: DataRow[], key: string, excludeTransfer = false) {
  const grouped = new Map<string, { total: number; missing: number }>();
  for (const row of rows) {
    if (excludeTransfer && row.event_type === "Transfer") continue;
    const currency = text(row.currency);
    const group = grouped.get(currency) ?? { total: 0, missing: 0 };
    const value = numeric(row[key]);
    if (value === null) group.missing++;
    else group.total += value;
    grouped.set(currency, group);
  }
  return [...grouped].map(([currency, value]) => ({ currency, ...value }));
}
export function filterRows(
  rows: DataRow[],
  filters: { q: string; shop: string; status: string; type: string },
) {
  const q = filters.q.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (!filters.shop || r.seller_account_id === filters.shop) &&
      (!filters.status || r.status === filters.status) &&
      (!filters.type || r.event_type === filters.type) &&
      (!q ||
        [
          r.amazon_order_id,
          r.order_id,
          r.sku,
          r.main_sku,
          r.settlement_id,
          r.reason,
          r.reason_label,
          r.amount_description,
        ].some((v) => text(v).toLowerCase().includes(q))),
  );
}
export function breakdownRows(value: unknown): DataRow[] {
  if (
    !value ||
    typeof value !== "object" ||
    !("groups" in value) ||
    !Array.isArray(value.groups)
  )
    return [];
  return value.groups.flatMap((g: unknown, i: number) =>
    g && typeof g === "object" && "label" in g && "amount" in g
      ? [{ id: String(i), label: text(g.label), amount: numeric(g.amount) }]
      : [],
  );
}
export function validId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  );
}
