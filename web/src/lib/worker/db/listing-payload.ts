/**
 * Dựng payload ghi listing xuống Supabase (RPC `public.vexim_worker_upsert_listings`
 * của migration 0016).
 *
 * Tách ra file riêng vì đây là chỗ DỄ SAI NHẤT của luồng ghi listing:
 *
 *   1. `null` nghĩa là "NGUỒN KHÔNG CHO BIẾT" → DB phải GIỮ giá trị cũ.
 *      Report Merchant Listings trả "Closed"/"Deleted" → parser cho status null;
 *      nếu ghi null đè lên trạng thái mà notification vừa set thì L1 hiển thị sai.
 *   2. `issues` là mảng (kể cả `[]`) → thay thế. `[]` = "đã xác nhận hết lỗi"
 *      (getListingsItem trả về), KHÁC HẲN null = "chưa biết".
 *   3. `stranded_reason`: key CÓ MẶT thì ghi kể cả null — hết stranded phải xoá
 *      được lý do cũ, nếu không L4 giữ oan SKU trong hàng đợi.
 *   4. Giá trong report là CHUỖI và có thể theo kiểu local ("1.299,99").
 *      Không đọc được → null (chưa biết), KHÔNG làm hỏng cả lô đồng bộ.
 *
 * Các quy tắc 1–3 được thực thi trong RPC; file này chỉ đảm bảo payload nói rõ
 * "không biết" (vắng key) khác với "biết là rỗng" (key có giá trị null/[]).
 */
import type { ListingStateRow } from "./adapter.ts";

/** Khoá của payload — snake_case, khớp contract của RPC 0016. */
export type ListingUpsertPayload = {
  sku: string;
  asin?: string | null;
  title?: string | null;
  status?: string | null;
  price?: number | null;
  currency?: string | null;
  quantity?: number | null;
  product_type?: string | null;
  issues?: unknown[] | null;
  issue_errors?: number | null;
  issue_warnings?: number | null;
  enforcement_actions?: string[] | null;
  buyable?: boolean | null;
  discoverable?: boolean | null;
  /** key vắng = giữ nguyên; null = hết stranded (xoá lý do cũ) */
  stranded_reason?: string | null;
  source?: string | null;
  synced_at?: string;
  updated_at?: string;
};

/**
 * Chuỗi giá/số lượng trong report → số.
 * Chấp nhận cả kiểu local: "129.99", "129,99", "1.299,99", "1,299.99", "$129.99".
 * Không đọc được → null ("chưa biết"), KHÔNG ném lỗi: một dòng rác trong report
 * không được phép làm hỏng cả lần đồng bộ.
 */
export function parseReportNumber(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;

  let t = raw.trim().replace(/[^0-9.,\-]/g, "");
  if (t === "" || t === "-" || t === "." || t === ",") return null;

  const comma = t.indexOf(",");
  const dot = t.indexOf(".");
  if (comma >= 0 && dot >= 0) {
    // dấu phân cách HÀNG NGHÌN là dấu xuất hiện TRƯỚC
    if (comma < dot) t = t.replace(/,/g, "");
    else t = t.replace(/\./g, "").replace(",", ".");
  } else if (comma >= 0) {
    // "129,99" (VN/EU) — nhưng "1,299" kiểu Mỹ cũng ra 1.299; cả hai đều là
    // số hợp lệ nên không cần phân biệt thêm.
    t = t.replace(",", ".");
  }

  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * ListingStateRow → payload 1 dòng.
 * `source` là tên nguồn ghi (report | api | notification) để màn L1/0.2 nói rõ
 * số này từ đâu ra.
 */
export function buildListingPayload(
  row: ListingStateRow,
  opts?: { source?: string | null },
): ListingUpsertPayload {
  const payload: ListingUpsertPayload = { sku: row.sku };

  // `undefined` = không đưa key vào JSON → RPC hiểu là "chưa biết, giữ nguyên".
  if (row.asin !== undefined) payload.asin = row.asin;
  if (row.itemName !== undefined) payload.title = row.itemName;
  if (row.status !== undefined) payload.status = row.status;
  if (row.price !== undefined) payload.price = parseReportNumber(row.price);
  if (row.currency !== undefined) payload.currency = row.currency;
  if (row.quantity !== undefined) payload.quantity = row.quantity;
  if (row.productType !== undefined) payload.product_type = row.productType;
  if (row.buyable !== undefined) payload.buyable = row.buyable;
  if (row.discoverable !== undefined) payload.discoverable = row.discoverable;
  if (row.enforcementActions !== undefined) {
    payload.enforcement_actions = row.enforcementActions;
  }

  // issues: mảng (kể cả rỗng) → thay thế; không có → null (giữ nguyên)
  if (row.issues !== undefined) payload.issues = row.issues;
  if (row.issueErrors !== undefined) payload.issue_errors = row.issueErrors;
  if (row.issueWarnings !== undefined) payload.issue_warnings = row.issueWarnings;

  // stranded_reason: LUÔN đưa key vào khi row có nêu (kể cả null) để xoá được
  if (row.strandedReason !== undefined) payload.stranded_reason = row.strandedReason;

  const source = opts?.source ?? row.source ?? null;
  if (source) payload.source = source;

  const iso = row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt;
  if (iso) {
    payload.synced_at = iso;
    payload.updated_at = iso;
  }

  return payload;
}

/** Nhiều dòng → 1 payload mảng (RPC nhận jsonb array, ghi 1 lượt). */
export function buildListingsPayload(
  rows: ListingStateRow[],
  opts?: { source?: string | null },
): ListingUpsertPayload[] {
  return rows.map((r) => buildListingPayload(r, opts));
}
