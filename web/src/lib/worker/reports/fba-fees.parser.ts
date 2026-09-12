/**
 * Parser 2 report PHÍ của FBA (migration 0019) — "hàng nằm ở FC đó tốn bao nhiêu".
 *
 * ┌ (1) FBA Storage Fees Report — PHÍ LƯU KHO THEO FC
 * │   reportType : GET_FBA_STORAGE_FEE_CHARGES_DATA
 * │   Cột (đúng tên của Amazon, GẠCH DƯỚI — khác report tồn kho dùng gạch nối):
 * │     asin · fnsku · product_name · fulfillment_center · country_code ·
 * │     longest_side · median_side · shortest_side · measurement_units · weight ·
 * │     weight_units · item_volume · volume_units · product_size_tier ·
 * │     average_quantity_on_hand · average_quantity_pending_removal ·
 * │     estimated_total_item_volume · month_of_charge · storage_rate · currency ·
 * │     estimated_monthly_storage_fee · dangerous_goods_storage_type ·
 * │     eligible_for_inventory_discount · qualifies_for_inventory_discount ·
 * │     total_incentive_fee_amount · breakdown_incentive_fee_amount ·
 * │     average_quantity_customer_orders
 * │   ⚠ KHÔNG có cột seller SKU → tầng DB suy SKU qua FNSKU/ASIN (view 0019 có
 * │     nhãn `sku_source`, không âm thầm đoán).
 * │   ⚠ Report này có THỂ chứa nhiều tiền tệ (shop bán US + CA): parser không
 * │     bao giờ cộng phí khác tiền tệ — mọi tổng đều tách theo currency.
 * │
 * └ (2) FBA Inbound Performance Report — PHÍ INBOUND SAI QUY CÁCH
 *     reportType : GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA
 *     Cột: issue-reported-date · shipment-creation-date · fba-shipment-id ·
 *          fba-carton-id · fulfillment-center-id · sku · fnsku · asin ·
 *          product-name · problem-type · problem-quantity · expected-quantity ·
 *          received-quantity · performance-measurement-unit · coaching-level ·
 *          fee-type · currency · fee-total · problem-level · alert-status
 *     ⚠ expected/received là của DÒNG có vấn đề, không phải của cả lô → parser
 *       KHÔNG cộng dồn hai cột này (đối soát cả lô là việc của report 0018).
 *
 * NGUỒN CỘT: developer-docs.amazon.com/sp-api/docs/report-type-values-fba
 *
 * QUY ƯỚC (giống fba-inventory.parser.ts)
 *   • Đọc không được → null ("chưa biết"), KHÔNG đoán 0.
 *   • Dòng rác bị BỎ và ĐẾM (skipped) + cảnh báo có mẫu thật để debug.
 *   • Số có dấu phẩy nghìn ("1,234.56") vẫn đọc được — report xuất từ Seller
 *     Central hay có định dạng này, trong khi report từ API thì không.
 */
import {
  columnIndex,
  intOrNull,
  pushWarning,
  readTsv,
  toIsoDate,
  type ReportSource,
  type TsvTable,
} from "./fba-inventory.parser.ts";

// ============================================================================
// Kiểu dữ liệu
// ============================================================================

/** Một dòng phí lưu kho (khoá: tháng × ASIN/FNSKU × FC × loại hàng nguy hiểm). */
export type StorageFeeRow = {
  /** YYYY-MM — đã chuẩn hoá, RPC từ chối mọi dạng khác */
  monthOfCharge: string;
  asin: string;
  fnsku: string;
  fulfillmentCenter: string;
  dangerousGoodsStorageType: string;
  productName?: string | null;
  countryCode?: string | null;
  productSizeTier?: string | null;
  averageQuantityOnHand?: number | null;
  averageQuantityPendingRemoval?: number | null;
  averageQuantityCustomerOrders?: number | null;
  estimatedTotalItemVolume?: number | null;
  volumeUnits?: string | null;
  itemVolume?: number | null;
  longestSide?: number | null;
  medianSide?: number | null;
  shortestSide?: number | null;
  measurementUnits?: string | null;
  weight?: number | null;
  weightUnits?: string | null;
  storageRate?: number | null;
  currency?: string | null;
  estimatedMonthlyStorageFee?: number | null;
  eligibleForInventoryDiscount?: boolean | null;
  qualifiesForInventoryDiscount?: boolean | null;
  totalIncentiveFeeAmount?: number | null;
  breakdownIncentiveFeeAmount?: number | null;
  source: ReportSource;
};

export type StorageFeeParseResult = {
  rows: StorageFeeRow[];
  warnings: string[];
  /** số dòng bị bỏ (tháng không đọc được / không có ASIN lẫn FNSKU) */
  skipped: number;
  /** các tháng có trong file, đã sắp xếp — để biết report phủ tới đâu */
  months: string[];
  /** tiền tệ xuất hiện trong file (không cộng gộp qua lại) */
  currencies: string[];
  /**
   * Phí theo "tháng|FC|currency" — in ra khi dry-run để đối chiếu bằng mắt.
   * CÓ tháng trong khoá vì phí lưu kho tính theo tháng: gộp 2026-08 với 2026-09
   * sẽ ra một con số không tương ứng kỳ phí nào của Amazon.
   */
  byMonthFcCurrency: Record<string, { fee: number; lines: number; volume: number }>;
};

/** Một dòng vấn đề khi Amazon nhận lô (khoá: ngày × lô × carton × SKU × loại vấn đề). */
export type NoncomplianceRow = {
  /** YYYY-MM-DD */
  issueReportedDate: string;
  shipmentCreationDate?: string | null;
  fbaShipmentId: string;
  fbaCartonId: string;
  fulfillmentCenterId: string;
  sku: string;
  fnsku?: string | null;
  asin?: string | null;
  productName?: string | null;
  problemType: string;
  problemQuantity?: number | null;
  expectedQuantity?: number | null;
  receivedQuantity?: number | null;
  performanceMeasurementUnit?: string | null;
  coachingLevel?: string | null;
  feeType?: string | null;
  currency?: string | null;
  feeTotal?: number | null;
  problemLevel?: string | null;
  alertStatus?: string | null;
  source: ReportSource;
};

export type NoncomplianceParseResult = {
  rows: NoncomplianceRow[];
  warnings: string[];
  skipped: number;
  shipments: string[];
  /** phí theo "loại phí|currency" — đây là số tiền thật bị mất vì làm sai quy cách */
  feeByType: Record<string, { fee: number; lines: number }>;
  problemTypes: string[];
};

// ============================================================================
// Helper đọc số/chữ/tháng
// ============================================================================

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9,
  sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Tháng trong report phí gặp 4 dạng:
 *   • 2026-08          (API — dạng chuẩn)
 *   • 2026-08-01       (một số bản xuất kèm ngày đầu tháng)
 *   • August 2026      (Seller Central xuất file chữ)
 *   • 08/2026          (MM/YYYY; nếu số đầu > 12 thì rõ ràng là YYYY/MM)
 * Trả về YYYY-MM hoặc null. Dạng số có gạch chéo được đánh dấu ambiguous để
 * tầng trên cảnh báo MỘT lần — không âm thầm đoán lịch.
 */
export function toIsoMonth(raw: string | null): { iso: string | null; ambiguous: boolean } {
  if (!raw) return { iso: null, ambiguous: false };
  const s = raw.trim();
  if (s === "") return { iso: null, ambiguous: false };

  const iso = s.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
  if (iso) {
    const m = Number(iso[2]);
    if (m < 1 || m > 12) return { iso: null, ambiguous: false };
    return { iso: `${iso[1]}-${pad2(m)}`, ambiguous: false };
  }

  const word = s.match(/^([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
  if (word) {
    const m = MONTH_NAMES[word[1].toLowerCase()];
    if (m) return { iso: `${word[2]}-${pad2(m)}`, ambiguous: false };
  }
  // "August 1, 2026" / "2026 August"
  const word2 = s.match(/^([A-Za-z]{3,9})\.?\s+\d{1,2},?\s+(\d{4})$/);
  if (word2) {
    const m = MONTH_NAMES[word2[1].toLowerCase()];
    if (m) return { iso: `${word2[2]}-${pad2(m)}`, ambiguous: false };
  }

  const slash = s.match(/^(\d{1,4})[/-](\d{2,4})$/);
  if (slash) {
    let a = Number(slash[1]);
    let b = Number(slash[2]);
    const ambiguous = a <= 12 && b <= 12; // 08/09 — không biết MM/YYYY hay YY/MM
    if (a > 31 && b >= 1 && b <= 12) return { iso: `${a}-${pad2(b)}`, ambiguous: false }; // 2026/08
    if (b > 31 && a >= 1 && a <= 12) return { iso: `${b}-${pad2(a)}`, ambiguous }; // 08/2026
    return { iso: null, ambiguous };
  }

  return { iso: null, ambiguous: false };
}

/**
 * Số thập phân kiểu report phí: "0.87" · "1,234.56" · "-" · "" · "N/A".
 * Không đọc được → null (tầng DB cũng có lưới an toàn `finance.num_or_null`).
 */
export function numOrNull(raw: string | null): number | null {
  if (raw === null) return null;
  const s = raw.trim().replace(/,/g, "");
  if (s === "" || s === "-" || s === "--") return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** "TRUE"/"true"/"Yes"/"1" → true; "FALSE"/"No"/"0" → false; còn lại null. */
export function boolOrNull(raw: string | null): boolean | null {
  if (raw === null) return null;
  switch (raw.trim().toLowerCase()) {
    case "true": case "t": case "yes": case "y": case "1": return true;
    case "false": case "f": case "no": case "n": case "0": return false;
    default: return null;
  }
}

/**
 * Làm tròn khi CỘNG TIỀN trong log/tóm tắt: 0.30 + 0.55 ra 0.8500000000000001
 * theo số học dấu phẩy động. In ra con số đó khiến người vận hành nghi ngờ số
 * liệu (và test thì so không khớp). Phí Amazon có 2 chữ số thập phân.
 */
const round = (n: number, digits = 2): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

function upperOrEmpty(raw: string | null): string {
  return (raw ?? "").trim().toUpperCase();
}

function textOrNull(raw: string | null): string | null {
  const s = (raw ?? "").trim();
  return s === "" ? null : s;
}

function cell(line: string[], idx: number): string | null {
  if (idx < 0) return null;
  const v = line[idx];
  return v === undefined ? null : v;
}

/** Gom cảnh báo trùng nội dung thành một dòng (không spam theo từng dòng report). */
function noteOnce(warnings: string[], prefix: string, msg: string): void {
  if (!warnings.some((w) => w.startsWith(prefix))) warnings.push(msg);
}

// ============================================================================
// (1) GET_FBA_STORAGE_FEE_CHARGES_DATA — phí lưu kho
// ============================================================================

const FEE_COL = {
  asin: "asin",
  fnsku: "fnsku",
  productName: "product-name",
  fc: "fulfillment-center",
  countryCode: "country-code",
  longestSide: "longest-side",
  medianSide: "median-side",
  shortestSide: "shortest-side",
  measurementUnits: "measurement-units",
  weight: "weight",
  weightUnits: "weight-units",
  itemVolume: "item-volume",
  volumeUnits: "volume-units",
  sizeTier: "product-size-tier",
  avgOnHand: "average-quantity-on-hand",
  avgPendingRemoval: "average-quantity-pending-removal",
  avgCustomerOrders: "average-quantity-customer-orders",
  totalVolume: "estimated-total-item-volume",
  month: "month-of-charge",
  storageRate: "storage-rate",
  currency: "currency",
  monthlyFee: "estimated-monthly-storage-fee",
  dangerousGoods: "dangerous-goods-storage-type",
  eligibleDiscount: "eligible-for-inventory-discount",
  qualifiesDiscount: "qualifies-for-inventory-discount",
  incentiveTotal: "total-incentive-fee-amount",
  incentiveBreakdown: "breakdown-incentive-fee-amount",
} as const;

export function parseStorageFeeReport(text: string): StorageFeeParseResult {
  const warnings: string[] = [];
  const empty: StorageFeeParseResult = {
    rows: [],
    warnings,
    skipped: 0,
    months: [],
    currencies: [],
    byMonthFcCurrency: {},
  };

  const table: TsvTable | null = readTsv(text);
  if (!table) {
    warnings.push("Report phí lưu kho rỗng (không có dòng dữ liệu nào)");
    return empty;
  }

  const idx = (name: string) => columnIndex(table.header, name);
  const iMonth = idx(FEE_COL.month);
  const iAsin = idx(FEE_COL.asin);
  const iFnsku = idx(FEE_COL.fnsku);
  const iFc = idx(FEE_COL.fc);

  if (iMonth < 0) {
    warnings.push(
      `Report phí lưu kho thiếu cột "${FEE_COL.month}" — đây có thể không phải ` +
      `GET_FBA_STORAGE_FEE_CHARGES_DATA. Cột đang có: ${table.header.slice(0, 8).join(", ")}…`,
    );
    return empty;
  }
  if (iAsin < 0 && iFnsku < 0) {
    warnings.push(
      `Report phí lưu kho thiếu cả "asin" lẫn "fnsku" — không có cách nào gắn phí ` +
      `với sản phẩm, nên KHÔNG nhập (tránh tạo ra số phí mồ côi).`,
    );
    return empty;
  }
  if (iFc < 0) {
    noteOnce(warnings, "Report phí lưu kho thiếu cột FC",
      `Report phí lưu kho thiếu cột "${FEE_COL.fc}" — phí sẽ không phân bổ được theo FC ` +
      `(mọi dòng về một nhóm "không rõ FC").`);
  }

  const i = {
    productName: idx(FEE_COL.productName),
    countryCode: idx(FEE_COL.countryCode),
    longestSide: idx(FEE_COL.longestSide),
    medianSide: idx(FEE_COL.medianSide),
    shortestSide: idx(FEE_COL.shortestSide),
    measurementUnits: idx(FEE_COL.measurementUnits),
    weight: idx(FEE_COL.weight),
    weightUnits: idx(FEE_COL.weightUnits),
    itemVolume: idx(FEE_COL.itemVolume),
    volumeUnits: idx(FEE_COL.volumeUnits),
    sizeTier: idx(FEE_COL.sizeTier),
    avgOnHand: idx(FEE_COL.avgOnHand),
    avgPendingRemoval: idx(FEE_COL.avgPendingRemoval),
    avgCustomerOrders: idx(FEE_COL.avgCustomerOrders),
    totalVolume: idx(FEE_COL.totalVolume),
    storageRate: idx(FEE_COL.storageRate),
    currency: idx(FEE_COL.currency),
    monthlyFee: idx(FEE_COL.monthlyFee),
    dangerousGoods: idx(FEE_COL.dangerousGoods),
    eligibleDiscount: idx(FEE_COL.eligibleDiscount),
    qualifiesDiscount: idx(FEE_COL.qualifiesDiscount),
    incentiveTotal: idx(FEE_COL.incentiveTotal),
    incentiveBreakdown: idx(FEE_COL.incentiveBreakdown),
  };

  const rows: StorageFeeRow[] = [];
  let skipped = 0;
  const months = new Set<string>();
  const currencies = new Set<string>();
  const byMonthFcCurrency: StorageFeeParseResult["byMonthFcCurrency"] = {};
  let badMonthSample: string | null = null;
  let noIdSample: string | null = null;
  let noFeeCount = 0;

  for (const line of table.lines) {
    const rawMonth = cell(line, iMonth);
    const month = toIsoMonth(rawMonth);
    if (month.ambiguous) {
      noteOnce(warnings, "Report phí lưu kho: tháng dạng",
        `Report phí lưu kho: tháng dạng "${(rawMonth ?? "").trim()}" được hiểu theo MM/YYYY. ` +
        `Nếu file xuất theo YY/MM thì tháng sẽ SAI — kiểm tra lại định dạng xuất.`);
    }
    if (!month.iso) {
      skipped += 1;
      if (!badMonthSample) badMonthSample = (rawMonth ?? "").trim();
      continue;
    }

    const asin = upperOrEmpty(cell(line, iAsin));
    const fnsku = upperOrEmpty(cell(line, iFnsku));
    if (asin === "" && fnsku === "") {
      skipped += 1;
      if (!noIdSample) noIdSample = `tháng ${month.iso}`;
      continue;
    }

    const currency = textOrNull(upperOrEmpty(cell(line, i.currency))) ?? null;
    const fee = numOrNull(cell(line, i.monthlyFee));
    const volume = numOrNull(cell(line, i.totalVolume));
    const fc = upperOrEmpty(cell(line, iFc));

    if (fee === null) noFeeCount += 1;

    months.add(month.iso);
    if (currency) currencies.add(currency);

    const key = `${month.iso}|${fc || "(không rõ FC)"}|${currency ?? "(không rõ tiền)"}`;
    const bucket = byMonthFcCurrency[key] ?? { fee: 0, lines: 0, volume: 0 };
    bucket.fee = round(bucket.fee + (fee ?? 0));
    bucket.volume = round(bucket.volume + (volume ?? 0), 4);
    bucket.lines += 1;
    byMonthFcCurrency[key] = bucket;

    rows.push({
      monthOfCharge: month.iso,
      asin,
      fnsku,
      fulfillmentCenter: fc,
      dangerousGoodsStorageType: upperOrEmpty(cell(line, i.dangerousGoods)),
      productName: textOrNull(cell(line, i.productName)),
      countryCode: textOrNull(upperOrEmpty(cell(line, i.countryCode))),
      productSizeTier: textOrNull(cell(line, i.sizeTier)),
      averageQuantityOnHand: numOrNull(cell(line, i.avgOnHand)),
      averageQuantityPendingRemoval: numOrNull(cell(line, i.avgPendingRemoval)),
      averageQuantityCustomerOrders: numOrNull(cell(line, i.avgCustomerOrders)),
      estimatedTotalItemVolume: volume,
      volumeUnits: textOrNull(cell(line, i.volumeUnits)),
      itemVolume: numOrNull(cell(line, i.itemVolume)),
      longestSide: numOrNull(cell(line, i.longestSide)),
      medianSide: numOrNull(cell(line, i.medianSide)),
      shortestSide: numOrNull(cell(line, i.shortestSide)),
      measurementUnits: textOrNull(cell(line, i.measurementUnits)),
      weight: numOrNull(cell(line, i.weight)),
      weightUnits: textOrNull(cell(line, i.weightUnits)),
      storageRate: numOrNull(cell(line, i.storageRate)),
      currency,
      estimatedMonthlyStorageFee: fee,
      eligibleForInventoryDiscount: boolOrNull(cell(line, i.eligibleDiscount)),
      qualifiesForInventoryDiscount: boolOrNull(cell(line, i.qualifiesDiscount)),
      totalIncentiveFeeAmount: numOrNull(cell(line, i.incentiveTotal)),
      breakdownIncentiveFeeAmount: numOrNull(cell(line, i.incentiveBreakdown)),
      source: "report",
    });
  }

  if (skipped > 0) {
    pushWarning(warnings, skipped,
      `Report phí lưu kho: bỏ ${skipped} dòng không dùng được ` +
      `(tháng không đọc được${badMonthSample ? ` — ví dụ "${badMonthSample}"` : ""}` +
      `${noIdSample ? `; không có ASIN/FNSKU — ví dụ ${noIdSample}` : ""}).`);
  }
  if (noFeeCount > 0) {
    pushWarning(warnings, noFeeCount,
      `Report phí lưu kho: ${noFeeCount} dòng không đọc được cột phí ` +
      `(${FEE_COL.monthlyFee}) → lưu NULL ("chưa biết phí"), không suy ra 0.`);
  }
  if (rows.length === 0 && skipped === 0) {
    warnings.push("Report phí lưu kho có tiêu đề nhưng không có dòng dữ liệu nào.");
  }
  if (currencies.size > 1) {
    warnings.push(
      `Report phí lưu kho có ${currencies.size} tiền tệ (${[...currencies].join(", ")}) — ` +
      `mọi tổng phí đều tách theo tiền tệ, KHÔNG cộng gộp.`,
    );
  }

  return {
    rows,
    warnings,
    skipped,
    months: [...months].sort(),
    currencies: [...currencies].sort(),
    byMonthFcCurrency,
  };
}

// ============================================================================
// (2) GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA — phí inbound sai quy cách
// ============================================================================

const NC_COL = {
  issueDate: "issue-reported-date",
  creationDate: "shipment-creation-date",
  shipmentId: "fba-shipment-id",
  cartonId: "fba-carton-id",
  fc: "fulfillment-center-id",
  sku: "sku",
  fnsku: "fnsku",
  asin: "asin",
  productName: "product-name",
  problemType: "problem-type",
  problemQty: "problem-quantity",
  expectedQty: "expected-quantity",
  receivedQty: "received-quantity",
  unit: "performance-measurement-unit",
  coaching: "coaching-level",
  feeType: "fee-type",
  currency: "currency",
  feeTotal: "fee-total",
  problemLevel: "problem-level",
  alertStatus: "alert-status",
} as const;

export function parseInboundNoncomplianceReport(text: string): NoncomplianceParseResult {
  const warnings: string[] = [];
  const empty: NoncomplianceParseResult = {
    rows: [],
    warnings,
    skipped: 0,
    shipments: [],
    feeByType: {},
    problemTypes: [],
  };

  const table = readTsv(text);
  if (!table) {
    // Report rỗng là CHUYỆN BÌNH THƯỜNG ở đây: không có vấn đề gì = không có dòng.
    warnings.push(
      "Report inbound noncompliance rỗng — nghĩa là không có vấn đề/phí nào được ghi nhận " +
      "(không phải lỗi).",
    );
    return empty;
  }

  const idx = (name: string) => columnIndex(table.header, name);
  const iDate = idx(NC_COL.issueDate);
  const iType = idx(NC_COL.problemType);
  if (iDate < 0) {
    warnings.push(
      `Report inbound noncompliance thiếu cột "${NC_COL.issueDate}" — đây có thể không phải ` +
      `GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA. Cột đang có: ${table.header.slice(0, 8).join(", ")}…`,
    );
    return empty;
  }
  if (iType < 0) {
    warnings.push(
      `Report inbound noncompliance thiếu cột "${NC_COL.problemType}" — mọi dòng sẽ trùng khoá ` +
      `và bị gộp thành 1, nên KHÔNG nhập.`,
    );
    return empty;
  }
  if (idx(NC_COL.shipmentId) < 0) {
    noteOnce(warnings, "Report inbound noncompliance thiếu mã lô",
      `Report inbound noncompliance thiếu cột "${NC_COL.shipmentId}" — không gắn vấn đề với lô ` +
      `nào được; màn I4 sẽ hiện "không rõ lô".`);
  }

  const i = {
    creationDate: idx(NC_COL.creationDate),
    shipmentId: idx(NC_COL.shipmentId),
    cartonId: idx(NC_COL.cartonId),
    fc: idx(NC_COL.fc),
    sku: idx(NC_COL.sku),
    fnsku: idx(NC_COL.fnsku),
    asin: idx(NC_COL.asin),
    productName: idx(NC_COL.productName),
    problemQty: idx(NC_COL.problemQty),
    expectedQty: idx(NC_COL.expectedQty),
    receivedQty: idx(NC_COL.receivedQty),
    unit: idx(NC_COL.unit),
    coaching: idx(NC_COL.coaching),
    feeType: idx(NC_COL.feeType),
    currency: idx(NC_COL.currency),
    feeTotal: idx(NC_COL.feeTotal),
    problemLevel: idx(NC_COL.problemLevel),
    alertStatus: idx(NC_COL.alertStatus),
  };

  const rows: NoncomplianceRow[] = [];
  let skipped = 0;
  const shipments = new Set<string>();
  const problemTypes = new Set<string>();
  const feeByType: NoncomplianceParseResult["feeByType"] = {};
  let badDateSample: string | null = null;
  let ambiguousDates = 0;
  let noSku = 0;
  let withExpected = 0;

  for (const line of table.lines) {
    const rawDate = cell(line, iDate);
    const d = toIsoDate(rawDate);
    if (d.ambiguous) ambiguousDates += 1;
    if (!d.iso) {
      skipped += 1;
      if (!badDateSample) badDateSample = (rawDate ?? "").trim();
      continue;
    }

    const problemType = upperOrEmpty(cell(line, iType));
    const shipmentId = upperOrEmpty(cell(line, i.shipmentId));
    const cartonId = upperOrEmpty(cell(line, i.cartonId));
    const sku = (cell(line, i.sku) ?? "").trim();
    if (sku === "") noSku += 1;

    const creation = toIsoDate(cell(line, i.creationDate));
    const feeType = textOrNull(upperOrEmpty(cell(line, i.feeType)));
    const currency = textOrNull(upperOrEmpty(cell(line, i.currency)));
    const feeTotal = numOrNull(cell(line, i.feeTotal));
    const expectedQty = intOrNull(cell(line, i.expectedQty));
    if (expectedQty !== null) withExpected += 1;

    if (shipmentId) shipments.add(shipmentId);
    if (problemType) problemTypes.add(problemType);

    const feeKey = `${feeType ?? "(không rõ loại phí)"}|${currency ?? "(không rõ tiền)"}`;
    const bucket = feeByType[feeKey] ?? { fee: 0, lines: 0 };
    bucket.fee = round(bucket.fee + (feeTotal ?? 0));
    bucket.lines += 1;
    feeByType[feeKey] = bucket;

    rows.push({
      issueReportedDate: d.iso,
      shipmentCreationDate: creation.iso,
      fbaShipmentId: shipmentId,
      fbaCartonId: cartonId,
      fulfillmentCenterId: upperOrEmpty(cell(line, i.fc)),
      sku,
      fnsku: textOrNull(upperOrEmpty(cell(line, i.fnsku))),
      asin: textOrNull(upperOrEmpty(cell(line, i.asin))),
      productName: textOrNull(cell(line, i.productName)),
      problemType,
      problemQuantity: intOrNull(cell(line, i.problemQty)),
      expectedQuantity: expectedQty,
      receivedQuantity: intOrNull(cell(line, i.receivedQty)),
      performanceMeasurementUnit: textOrNull(cell(line, i.unit)),
      coachingLevel: textOrNull(upperOrEmpty(cell(line, i.coaching))),
      feeType,
      currency,
      feeTotal,
      problemLevel: textOrNull(upperOrEmpty(cell(line, i.problemLevel))),
      alertStatus: textOrNull(upperOrEmpty(cell(line, i.alertStatus))),
      source: "report",
    });
  }

  if (ambiguousDates > 0) {
    noteOnce(warnings, "Report inbound noncompliance: ngày dạng",
      `Report inbound noncompliance: ${ambiguousDates} ngày dạng MM/DD/YYYY được hiểu theo ` +
      `lịch Mỹ. Nếu file xuất ở thị trường DD/MM/YYYY thì ngày sẽ SAI.`);
  }
  if (skipped > 0) {
    pushWarning(warnings, skipped,
      `Report inbound noncompliance: bỏ ${skipped} dòng không đọc được ngày báo vấn đề` +
      `${badDateSample ? ` (ví dụ "${badDateSample}")` : ""}.`);
  }
  if (noSku > 0) {
    pushWarning(warnings, noSku,
      `Report inbound noncompliance: ${noSku} dòng không có SKU — vẫn giữ (vấn đề ở cấp ` +
      `carton/lô thì không gắn SKU nào), nhưng không đối chiếu được với tồn theo SKU.`);
  }
  if (withExpected > 0) {
    noteOnce(warnings, "Report inbound noncompliance có expected/received",
      `Report inbound noncompliance có ${withExpected} dòng kèm expected/received — dùng để ` +
      `đối chiếu DÒNG có vấn đề; đối soát cả lô vẫn lấy từ report nhận hàng (0018), ` +
      `không cộng dồn hai cột này theo lô.`);
  }
  if (rows.length === 0 && skipped === 0) {
    warnings.push("Report inbound noncompliance có tiêu đề nhưng không có dòng nào (không có vấn đề).");
  }

  return {
    rows,
    warnings,
    skipped,
    shipments: [...shipments].sort(),
    feeByType,
    problemTypes: [...problemTypes].sort(),
  };
}
