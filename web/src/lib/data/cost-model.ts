/**
 * Model thuần cho trang GIÁ VỐN `/finance/costs` (Đợt A — gỡ chặn F3/F4/P1).
 *
 * KHÔNG import Supabase ở đây (giống finance-model.ts) để test được bằng
 * `node --experimental-strip-types` và dùng chung cho cả demo mode.
 *
 * Ba nguyên tắc số liệu:
 *   1. DB là nơi QUYẾT ĐỊNH luật parse số/ngày (catalog.parse_amount / parse_day).
 *      Bản parse ở đây chỉ để BÁO TRƯỚC lỗi ngay trên form, không phải luật thứ hai.
 *   2. Giá vốn là "bậc thang hiệu lực": một SKU có nhiều bậc, mỗi bậc có
 *      effective_from / effective_to — F4 cần giá vốn TẠI NGÀY BÁN, không chỉ hôm nay.
 *   3. Thiếu giá vốn → để trống "—", KHÔNG suy diễn, KHÔNG tính lãi.
 */

// Import TƯƠNG ĐỐI + đuôi .ts (không dùng alias "@/") để file này test được bằng
// `node --experimental-strip-types` — node không hiểu tsconfig paths.
// Dùng chung parseReportNumber với worker: số kiểu local chỉ có MỘT luật parse.
import { parseReportNumber } from "../worker/db/listing-payload.ts";

/* ============================ Kiểu dữ liệu (khớp view 0016) ============================ */

/** Một dòng của `public.vexim_cost_inputs`. */
export type CostInputRow = {
  id: string;
  seller_account_id: string;
  shop: string;
  sku: string;
  unit_cost: number | null;
  currency: string;
  effective_from: string | null;
  effective_to: string | null;
  source?: string | null;
  source_ref?: string | null;
  note?: string | null;
  imported_by?: string | null;
  updated_by?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  is_current?: boolean;
  is_open_ended?: boolean;
};

/** Một dòng của `public.vexim_cost_coverage` — SKU đang bán và đã có giá vốn chưa. */
export type CostCoverageRow = {
  seller_account_id: string;
  shop: string;
  sku: string;
  asin?: string | null;
  title?: string | null;
  status?: string | null;
  price?: number | null;
  currency?: string | null;
  unit_cost?: number | null;
  cost_currency?: string | null;
  cost_effective_from?: string | null;
  cost_source?: string | null;
  missing_cost?: boolean | null;
  currency_mismatch?: boolean | null;
};

export const COST_SOURCE_VI: Record<string, string> = {
  manual: "Nhập tay",
  csv: "Import CSV",
  api: "API/kho",
};

/** Tiền tệ hay gặp trong luồng nhập hàng — chỉ là gợi ý, DB nhận chuỗi tự do. */
export const COST_CURRENCIES = ["USD", "VND", "CNY", "EUR", "GBP"] as const;

/** Trần số dòng một lần import: RPC nhận jsonb nên phải có giới hạn rõ. */
export const MAX_IMPORT_ROWS = 500;

/* ============================ Template CSV ============================ */

/**
 * Cột của template. Tên cột tiếng Anh trùng tên field RPC để khỏi ánh xạ hai lần;
 * dòng `#` là ghi chú — parser bỏ qua, Excel vẫn mở/ghi lại bình thường.
 */
export const COST_IMPORT_COLUMNS = [
  "sku",
  "unit_cost",
  "currency",
  "effective_from",
  "effective_to",
  "note",
] as const;

export type CostImportColumn = (typeof COST_IMPORT_COLUMNS)[number];

export const COST_TEMPLATE_CSV = [
  "# Template nhập giá vốn VEXIM Ops — lưu UTF-8, phân cách bằng dấu phẩy.",
  "# sku: bắt buộc (tối đa 40 ký tự, đúng seller-sku trên Amazon, không phân biệt hoa thường).",
  "# unit_cost: bắt buộc, ≥ 0 — chấp nhận 12.5 / 12,5 / \"1.234,56\".",
  "# currency: USD (mặc định) | VND | CNY | EUR | GBP.",
  "# effective_from: bắt buộc — YYYY-MM-DD (hoặc DD/MM/YYYY). KHÔNG dùng MM/DD/YYYY (mơ hồ).",
  "# effective_to: để TRỐNG = còn hiệu lực tới khi có bậc mới (bậc cũ tự được cắt ngọn).",
  "# note: ghi chú tuỳ ý (vd: giá FOB lô T9, chưa gồm phí đầu VN).",
  "#",
  "# Luật bậc thang: bậc mới có hiệu lực từ X sẽ TỰ cắt ngọn bậc cũ tại X.",
  "# Có lỗi → KHÔNG ghi dòng nào (all-or-nothing), hệ thống báo lỗi theo số dòng.",
  COST_IMPORT_COLUMNS.join(","),
  "TG-LUG-20-BLK,41.50,USD,2026-09-01,,Giá FOB lô T9",
  "TG-LUG-20-BLK,43.20,USD,2026-10-01,,Tăng giá nhà máy — bậc cũ tự kết thúc 01/10",
  "TG-POUCH-07-GRY,\"1.234,56\",VND,2026-09-01,2026-12-31,Hàng nội địa",
  "TG-CABLE-2M,3.10,CNY,2026-09-12,,Chưa gồm thuế nhập",
].join("\n");

/** Tên file tải về (có ngày để không lẫn với bản cũ trong Downloads). */
export function costTemplateFilename(now = new Date()): string {
  return `vexim-gia-von-template-${now.toISOString().slice(0, 10)}.csv`;
}

/* ============================ Parse cho form (báo lỗi sớm) ============================ */

export type ParseResult = { value: string | null; error?: string };

/**
 * Ngày → 'YYYY-MM-DD' | null.
 * Nhại đúng `catalog.parse_day`: nhận YYYY-MM-DD, YYYY/MM/DD và DD/MM/YYYY;
 * từ chối MM/DD/YYYY vì mơ hồ (09/12 là 9 tháng 12 hay 12 tháng 9?).
 */
export function parseCostDay(raw: string | null | undefined): ParseResult {
  const t = (raw ?? "").trim();
  if (t === "") return { value: null };

  const iso = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    const d = Number(iso[3]);
    if (m < 1 || m > 12) return { value: null, error: `ngày "${t}" có tháng ngoài 1–12` };
    if (d < 1 || d > 31) return { value: null, error: `ngày "${t}" có ngày ngoài 1–31` };
    return { value: `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` };
  }

  const dmy = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmy) {
    const d = Number(dmy[1]);
    const m = Number(dmy[2]);
    const y = Number(dmy[3]);
    if (m > 12) return { value: null, error: `ngày "${t}" có tháng > 12 — dùng YYYY-MM-DD hoặc DD/MM/YYYY` };
    if (d > 31) return { value: null, error: `ngày "${t}" có ngày > 31` };
    return { value: `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` };
  }

  return { value: null, error: `ngày "${t}" sai định dạng — dùng YYYY-MM-DD (hoặc DD/MM/YYYY)` };
}

/** Số tiền → number | null. Cùng một luật với worker + DB (parseReportNumber). */
export function parseCostAmount(raw: string | number | null | undefined): number | null {
  return parseReportNumber(raw);
}

/* ============================ Parse file CSV ============================ */

export type CostImportRow = {
  sku: string;
  unit_cost: string;
  currency: string;
  effective_from: string;
  effective_to: string;
  note: string;
};

export type CostImportError = { line: number; sku: string; message: string };

export type CostImportParse = {
  rows: CostImportRow[];
  errors: CostImportError[];
  /** Số dòng dữ liệu đã bỏ qua vì thiếu cột bắt buộc / trùng lặp định dạng. */
  skipped: number;
};

/** Tách một dòng CSV có tôn trọng dấu nháy kép ("a,b" là 1 ô). */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === "," || ch === ";") {
      // chấp nhận cả file Excel VN lưu bằng dấu chấm phẩy
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/**
 * Đọc file template thành các dòng gửi lên RPC `vexim_import_cost_inputs`.
 *
 * Gửi CHUỖI thô lên DB (không tự convert) để luật parse chỉ có một bản; ở đây chỉ
 * chặn những lỗi nhìn thấy được (thiếu cột, thiếu SKU, số âm, ngày kết thúc ≤ ngày
 * bắt đầu) nhằm khỏi tốn một round-trip khi file sai rành rành.
 */
export function parseCostImportCsv(text: string): CostImportParse {
  const rows: CostImportRow[] = [];
  const errors: CostImportError[] = [];
  let skipped = 0;

  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r\n|\r|\n/)
    .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  if (lines.length === 0) {
    return { rows, errors, skipped };
  }

  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, "_"));
  const indexOf = (name: string) => header.indexOf(name);
  const iSku = indexOf("sku");
  const iCost = indexOf("unit_cost") >= 0 ? indexOf("unit_cost") : indexOf("cost");
  const iFrom = indexOf("effective_from") >= 0 ? indexOf("effective_from") : indexOf("from");
  if (iSku < 0 || iCost < 0 || iFrom < 0) {
    return {
      rows,
      errors: [
        {
          line: 1,
          sku: "",
          message: `thiếu cột bắt buộc trong header (cần: sku, unit_cost, effective_from) — nhận được: ${header.join(", ")}`,
        },
      ],
      skipped,
    };
  }
  const iCur = indexOf("currency");
  const iTo = indexOf("effective_to");
  const iNote = indexOf("note");

  for (let n = 1; n < lines.length; n++) {
    const cells = splitCsvLine(lines[n]);
    const line = n + 1;
    const sku = (cells[iSku] ?? "").toUpperCase();
    const rawCost = cells[iCost] ?? "";
    const rawFrom = cells[iFrom] ?? "";
    const rawTo = iTo >= 0 ? (cells[iTo] ?? "") : "";

    if (!sku) {
      errors.push({ line, sku: "", message: "thiếu SKU" });
      skipped++;
      continue;
    }
    if (sku.length > 40) {
      errors.push({ line, sku, message: `SKU dài hơn 40 ký tự (giới hạn seller-sku của Amazon)` });
      skipped++;
      continue;
    }

    const cost = parseCostAmount(rawCost);
    if (rawCost === "") {
      errors.push({ line, sku, message: "thiếu giá vốn (unit_cost)" });
      skipped++;
      continue;
    }
    if (cost === null) {
      errors.push({ line, sku, message: `không đọc được giá vốn "${rawCost}"` });
      skipped++;
      continue;
    }
    if (cost < 0) {
      errors.push({ line, sku, message: `giá vốn phải ≥ 0 (nhận ${rawCost})` });
      skipped++;
      continue;
    }

    const from = parseCostDay(rawFrom);
    if (!rawFrom) {
      errors.push({ line, sku, message: "thiếu ngày hiệu lực (effective_from)" });
      skipped++;
      continue;
    }
    if (from.error || !from.value) {
      errors.push({ line, sku, message: from.error ?? `ngày hiệu lực "${rawFrom}" không hợp lệ` });
      skipped++;
      continue;
    }

    let to = "";
    if (rawTo) {
      const parsedTo = parseCostDay(rawTo);
      if (parsedTo.error || !parsedTo.value) {
        errors.push({ line, sku, message: parsedTo.error ?? `ngày kết thúc "${rawTo}" không hợp lệ` });
        skipped++;
        continue;
      }
      if (parsedTo.value <= from.value) {
        errors.push({ line, sku, message: `effective_to (${rawTo}) phải SAU effective_from (${rawFrom})` });
        skipped++;
        continue;
      }
      to = parsedTo.value;
    }

    rows.push({
      sku,
      unit_cost: rawCost,
      currency: (iCur >= 0 ? (cells[iCur] ?? "") : "").toUpperCase() || "USD",
      effective_from: from.value,
      effective_to: to,
      note: iNote >= 0 ? (cells[iNote] ?? "") : "",
    });
  }

  if (rows.length > MAX_IMPORT_ROWS) {
    errors.push({
      line: 0,
      sku: "",
      message: `file có ${rows.length} dòng — tối đa ${MAX_IMPORT_ROWS} dòng/lần import, hãy chia nhỏ`,
    });
    return { rows: rows.slice(0, MAX_IMPORT_ROWS), errors, skipped };
  }

  return { rows, errors, skipped };
}

/* ============================ Kiểm tra form nhập tay ============================ */

export type CostFormInput = {
  sellerAccountId: string;
  sku: string;
  unitCost: string;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string;
  note: string;
};

export type CostFormValidated =
  | { ok: true; payload: {
      p_seller: string;
      p_sku: string;
      p_unit_cost: number;
      p_currency: string;
      p_effective_from: string;
      p_effective_to: string | null;
      p_note: string | null;
    } }
  | { ok: false; message: string };

/** Kiểm tra form trước khi gọi RPC — RPC vẫn là người quyết định cuối cùng. */
export function validateCostForm(input: CostFormInput): CostFormValidated {
  const sku = input.sku.trim().toUpperCase();
  if (!input.sellerAccountId) return { ok: false, message: "Chưa chọn shop." };
  if (!sku) return { ok: false, message: "Thiếu SKU." };
  if (sku.length > 40) return { ok: false, message: "SKU dài hơn 40 ký tự." };

  const cost = parseCostAmount(input.unitCost);
  if (input.unitCost.trim() === "") return { ok: false, message: "Thiếu giá vốn." };
  if (cost === null) return { ok: false, message: `Không đọc được giá vốn "${input.unitCost}".` };
  if (cost < 0) return { ok: false, message: "Giá vốn phải ≥ 0." };

  const from = parseCostDay(input.effectiveFrom);
  if (!input.effectiveFrom.trim()) return { ok: false, message: "Thiếu ngày hiệu lực." };
  if (from.error || !from.value) return { ok: false, message: from.error ?? "Ngày hiệu lực không hợp lệ." };

  let to: string | null = null;
  if (input.effectiveTo.trim()) {
    const parsed = parseCostDay(input.effectiveTo);
    if (parsed.error || !parsed.value) return { ok: false, message: parsed.error ?? "Ngày kết thúc không hợp lệ." };
    if (parsed.value <= from.value) {
      return { ok: false, message: "Ngày kết thúc phải SAU ngày hiệu lực." };
    }
    to = parsed.value;
  }

  return {
    ok: true,
    payload: {
      p_seller: input.sellerAccountId,
      p_sku: sku,
      p_unit_cost: cost,
      p_currency: input.currency.trim().toUpperCase() || "USD",
      p_effective_from: from.value,
      p_effective_to: to,
      p_note: input.note.trim() || null,
    },
  };
}

/* ============================ Tóm tắt cho KPI ============================ */

export type CostInputSummary = {
  total: number;
  current: number;
  upcoming: number;
  expired: number;
  skus: number;
  shops: number;
  /** SKU có ≥1 bậc giá vốn. */
  coveredSkus: number;
};

/** `today` dạng 'YYYY-MM-DD' để so sánh chuỗi ngày (khớp cách view tính is_current). */
export function isoDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function summarizeCostInputs(rows: CostInputRow[], today = isoDay()): CostInputSummary {
  let current = 0;
  let upcoming = 0;
  let expired = 0;
  const skus = new Set<string>();
  const shops = new Set<string>();
  const covered = new Set<string>();

  for (const r of rows) {
    shops.add(r.seller_account_id);
    const key = `${r.seller_account_id}:${r.sku}`;
    skus.add(key);
    const from = r.effective_from ?? "";
    const to = r.effective_to ?? null;
    const isCurrent = r.is_current ?? (from <= today && (to === null || to > today));
    if (isCurrent) {
      current++;
      covered.add(key);
    } else if (from > today) upcoming++;
    else expired++;
  }

  return {
    total: rows.length,
    current,
    upcoming,
    expired,
    skus: skus.size,
    shops: shops.size,
    coveredSkus: covered.size,
  };
}

export type CostCoverageSummary = {
  total: number;
  covered: number;
  missing: number;
  mismatch: number;
  /** % SKU có giá vốn dùng được (không thiếu, không lệch tiền tệ). */
  coveragePct: number | null;
};

export function summarizeCoverage(rows: CostCoverageRow[]): CostCoverageSummary {
  let covered = 0;
  let missing = 0;
  let mismatch = 0;
  for (const r of rows) {
    // `??` phải có ngoặc khi trộn với `||` — và fallback để test/demo không cần cột view
    const isMissing = r.missing_cost ?? (r.unit_cost === null || r.unit_cost === undefined);
    const isMismatch = r.currency_mismatch ?? (r.unit_cost != null && r.cost_currency != null && r.currency != null && r.cost_currency !== r.currency);
    if (isMissing) missing++;
    else if (isMismatch) mismatch++;
    else covered++;
  }
  return {
    total: rows.length,
    covered,
    missing,
    mismatch,
    coveragePct: rows.length === 0 ? null : covered / rows.length,
  };
}

/** Gộp theo SKU: bậc đang áp dụng + bậc sắp tới (để hiển thị lịch sử giá gọn). */
export function groupCostLadder(rows: CostInputRow[], today = isoDay()): {
  sku: string;
  sellerAccountId: string;
  shop: string;
  steps: CostInputRow[];
  current: CostInputRow | null;
  next: CostInputRow | null;
}[] {
  const map = new Map<string, CostInputRow[]>();
  for (const r of rows) {
    const key = `${r.seller_account_id}::${r.sku}`;
    const list = map.get(key) ?? [];
    list.push(r);
    map.set(key, list);
  }
  const out: ReturnType<typeof groupCostLadder> = [];
  for (const [, steps] of map) {
    steps.sort((a, b) => (a.effective_from ?? "").localeCompare(b.effective_from ?? ""));
    const first = steps[0];
    const current = steps.find((s) => (s.effective_from ?? "") <= today && (s.effective_to === null || s.effective_to > today)) ?? null;
    const next = steps.find((s) => (s.effective_from ?? "") > today) ?? null;
    out.push({
      sku: first.sku,
      sellerAccountId: first.seller_account_id,
      shop: first.shop,
      steps,
      current,
      next,
    });
  }
  return out.sort((a, b) => a.sku.localeCompare(b.sku));
}

/** Thông điệp kết quả import (RPC trả jsonb) → tiếng Việt cho người dùng. */
export function formatImportResult(res: {
  ok?: boolean;
  rows?: number;
  inserted?: number;
  updated?: number;
  closed_previous?: number;
  superseded?: number;
}): string {
  if (res.ok === false) return "Không ghi dòng nào — xem lỗi bên dưới.";
  const parts = [`${res.rows ?? 0} dòng`];
  if (res.inserted) parts.push(`${res.inserted} bậc mới`);
  if (res.updated) parts.push(`${res.updated} bậc cập nhật`);
  if (res.closed_previous) parts.push(`${res.closed_previous} bậc cũ đã cắt ngọn`);
  if (res.superseded) parts.push(`${res.superseded} bậc bị thay`);
  return `Đã ghi ${parts.join(" · ")}.`;
}
