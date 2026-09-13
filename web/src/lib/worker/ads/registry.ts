/**
 * Bảng đăng ký 5 report Amazon Ads mà VEXIM tự kéo (Module 5 phần 1).
 *
 *   kind                 reportTypeId          nhóm (groupBy)   nuôi màn
 *   ───────────────────  ────────────────────  ────────────────  ─────────────
 *   campaigns            spCampaigns           campaign          A1 · KPI
 *   targeting            spTargeting           targeting         A2
 *   search-terms         spSearchTerm          searchTerm        A3
 *   advertised-products  spAdvertisedProduct   advertiser        A3 · F4 (ads_spend)
 *   purchased-products   spPurchasedProduct    purchasedAsin     A3 (đơn từ SP khác)
 *
 * Vì sao gộp một chỗ (giống 0019): CLI (`worker ads:pull`), Vercel Cron và test
 * phải dùng CÙNG một định nghĩa — reportTypeId, groupBy, cột, khoảng ngày mặc
 * định, trần tốc độ, parser nào, ghi qua hàm nào của adapter.
 *
 * BA LUẬT CỦA REPORT V3 (ghi ra đây để không ai "sáng kiến" trái):
 *   1. `timeUnit` CHỈ có DAILY hoặc SUMMARY — KHÔNG có HOURLY.
 *   2. Số liệu quy đổi theo CỬA SỔ (sales7d/14d/30d, purchases…): mỗi cửa sổ là
 *      một cột riêng, TUYỆT ĐỐI không cộng chúng lại với nhau.
 *   3. v3 KHÔNG trả acos/roas/cpc — chúng được SUY RA ở view; parser cũng không
 *      tự tính rồi nhét vào DB (số dẫn xuất lưu lại sẽ lệch sau mỗi lần nhập lại).
 *
 * TRẦN TỐC ĐỘ: Reporting v3 thoáng hơn SP-API nhưng KHÔNG phải vô hạn. Job dùng
 * `cooldownHours` để quyết định xin report mới hay poll cái đang chờ — và nhờ
 * `connections.report_requests` (0019) mà cron chạy lại KHÔNG xin trùng.
 */
import type {
  AdsAdGroupRowInput,
  AdsBudgetEventRowInput,
  AdsCampaignRowInput,
  AdsEntityCounts,
  AdsMetricCounts,
  AdsProductMetricRowInput,
  AdsProfileRowInput,
  AdsSearchTermRowInput,
  AdsTargetMetricRowInput,
  AdsTargetRowInput,
  DbAdapter,
} from "../db/adapter.ts";

export type AdsReportKind =
  | "campaigns"
  | "targeting"
  | "search-terms"
  | "advertised-products"
  | "purchased-products";

export type AdsReportSpec = {
  kind: AdsReportKind;
  /** reportTypeId của Reporting v3 — gửi nguyên văn */
  reportTypeId: string;
  /** adProduct của Sponsors */
  adProduct: string;
  /** groupBy của v3 — sai giá trị này Amazon trả 400 */
  groupBy: string[];
  /** cột yêu cầu (tên cột v3) */
  columns: string[];
  label: string;
  screen: string;
  /** kéo lùi bao nhiêu ngày (Ads giữ dữ liệu ~60 ngày → mặc định 30) */
  lookbackDays: number;
  /** trần yêu cầu lại (giờ) — dưới mức này thì POLL report cũ, không xin mới */
  cooldownHours: number;
};

const METRIC_COLUMNS_CORE = [
  "impressions",
  "clicks",
  "cost",
  "sales7d",
  "sales14d",
  "sales30d",
  "purchases7d",
  "purchases14d",
  "purchases30d",
  "unitsSoldClicks7d",
  "unitsSoldClicks14d",
  "unitsSoldClicks30d",
];

export const ADS_REPORT_SPECS: Record<AdsReportKind, AdsReportSpec> = {
  campaigns: {
    kind: "campaigns",
    reportTypeId: "spCampaigns",
    adProduct: "SPONSORED_PRODUCTS",
    groupBy: ["campaign"],
    columns: [
      "date",
      "campaignId",
      "campaignName",
      "campaignStatus",
      "campaignBudgetAmount",
      "campaignBudgetCurrencyCode",
      ...METRIC_COLUMNS_CORE,
    ],
    label: "Hiệu quả theo campaign (spCampaigns)",
    screen: "A1 · Campaigns",
    lookbackDays: 30,
    cooldownHours: 4,
  },
  targeting: {
    kind: "targeting",
    reportTypeId: "spTargeting",
    adProduct: "SPONSORED_PRODUCTS",
    groupBy: ["targeting"],
    columns: [
      "date",
      "campaignId",
      "adGroupId",
      "keywordId",
      "keyword",
      "matchType",
      "targetingExpression",
      ...METRIC_COLUMNS_CORE,
    ],
    label: "Hiệu quả theo từ khoá/nhóm sản phẩm (spTargeting)",
    screen: "A2 · Chi tiết campaign",
    lookbackDays: 30,
    cooldownHours: 4,
  },
  "search-terms": {
    kind: "search-terms",
    reportTypeId: "spSearchTerm",
    adProduct: "SPONSORED_PRODUCTS",
    groupBy: ["searchTerm"],
    columns: [
      "date",
      "campaignId",
      "adGroupId",
      "keywordId",
      "keyword",
      "matchType",
      "searchTerm",
      ...METRIC_COLUMNS_CORE,
    ],
    label: "Từ khoá người mua thật gõ (spSearchTerm)",
    screen: "A3 · Search terms",
    lookbackDays: 30,
    cooldownHours: 4,
  },
  "advertised-products": {
    kind: "advertised-products",
    reportTypeId: "spAdvertisedProduct",
    adProduct: "SPONSORED_PRODUCTS",
    groupBy: ["advertiser"],
    columns: [
      "date",
      "campaignId",
      "adGroupId",
      "advertisedAsin",
      "advertisedSku",
      ...METRIC_COLUMNS_CORE,
    ],
    label: "Hiệu quả theo ASIN/SKU được quảng cáo (spAdvertisedProduct)",
    screen: "A3 · F4 (ads_spend theo SKU)",
    lookbackDays: 30,
    cooldownHours: 4,
  },
  "purchased-products": {
    kind: "purchased-products",
    reportTypeId: "spPurchasedProduct",
    adProduct: "SPONSORED_PRODUCTS",
    groupBy: ["purchasedAsin"],
    columns: [
      "date",
      "campaignId",
      "adGroupId",
      "advertisedAsin",
      "advertisedSku",
      "purchasedAsin",
      "sales7d",
      "sales14d",
      "sales30d",
      "purchases7d",
      "purchases14d",
      "purchases30d",
      "unitsSoldClicks7d",
      "unitsSoldClicks14d",
      "unitsSoldClicks30d",
      "salesOtherSku7d",
      "salesOtherSku14d",
      "salesOtherSku30d",
      "unitsSoldOtherSku7d",
      "unitsSoldOtherSku14d",
      "unitsSoldOtherSku30d",
    ],
    label: "Đơn phát sinh cho ASIN khác (spPurchasedProduct)",
    screen: "A3 · doanh thu chéo",
    lookbackDays: 30,
    cooldownHours: 4,
  },
};

export const ADS_ALL_KINDS: readonly AdsReportKind[] = [
  "campaigns",
  "targeting",
  "search-terms",
  "advertised-products",
  "purchased-products",
];

export function isAdsReportKind(value: string | null | undefined): value is AdsReportKind {
  return (ADS_ALL_KINDS as readonly string[]).includes(String(value ?? ""));
}

export function adsSpecOf(kind: AdsReportKind): AdsReportSpec {
  return ADS_REPORT_SPECS[kind];
}

export function adsKindOfReportType(reportTypeId: string): AdsReportKind | null {
  const found = ADS_ALL_KINDS.find((k) => ADS_REPORT_SPECS[k].reportTypeId === reportTypeId);
  return found ?? null;
}

// ============================================================================
// PARSE — chuỗi JSON (đã giải nén GZIP) → dòng đúng shape RPC
// ============================================================================

export type AdsParsedReport = {
  kind: AdsReportKind;
  /** dòng đúng khoá mà RPC `vexim_worker_upsert_ads_*` đọc */
  rows: Record<string, unknown>[];
  warnings: string[];
  /** dòng bị bỏ (thiếu khoá bắt buộc / không đọc được) */
  skipped: number;
  summary: string;
  /** số ngày dữ liệu, để log "kéo được mấy ngày" */
  days: number;
};

/**
 * Đọc nội dung report v3. Amazon trả GZIP_JSON — sau khi giải nén, nội dung có
 * thể là mảng JSON, JSON-lines (mỗi dòng một object) hoặc object bọc mảng.
 * Chấp nhận cả ba để không phải đoán; không nhận ra thì báo lỗi RÕ RÀNG.
 */
export function readAdsReportRecords(text: string): Record<string, unknown>[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed.filter(isObject);
      const obj = parsed as Record<string, unknown>;
      for (const key of ["records", "data", "report", "result", "results"]) {
        if (Array.isArray(obj[key])) return (obj[key] as unknown[]).filter(isObject);
      }
      // Object đơn lẻ = 1 dòng dữ liệu (report SUMMARY) — nhưng nếu nó chỉ là
      // metadata (không có cột ngày/khoá) thì coi như rỗng.
      return Object.keys(obj).length > 0 && !looksLikeMetadata(obj) ? [obj] : [];
    } catch (e) {
      // Có thể là JSON-lines: rơi xuống nhánh dưới trước khi bỏ cuộc.
      const lines = trimmed.split("\n").filter((l) => l.trim() !== "");
      const out: Record<string, unknown>[] = [];
      for (const line of lines) {
        try {
          const one = JSON.parse(line) as unknown;
          if (isObject(one)) out.push(one);
        } catch {
          throw new Error(
            `Report Ads: nội dung không phải JSON hợp lệ (${(e as Error).message.split("\n")[0]})`,
          );
        }
      }
      return out;
    }
  }

  // JSON-lines / mỗi dòng một object
  const out: Record<string, unknown>[] = [];
  for (const line of trimmed.split("\n")) {
    const l = line.trim().replace(/,$/, "");
    if (l === "") continue;
    try {
      const one = JSON.parse(l) as unknown;
      if (isObject(one)) out.push(one);
    } catch {
      throw new Error(
        `Report Ads: dòng không phải JSON (${l.slice(0, 80)}…) — kiểm tra định dạng (GZIP_JSON?).`,
      );
    }
  }
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function looksLikeMetadata(o: Record<string, unknown>): boolean {
  const keys = Object.keys(o).map((k) => k.toLowerCase());
  return keys.includes("reportid") && !keys.some((k) => k === "date" || k === "campaignid");
}

/** Đọc giá trị theo nhiều tên cột có thể (Amazon đổi tên giữa v2/v3). */
function pick(row: Record<string, unknown>, ...names: string[]): unknown {
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) lower[k.toLowerCase()] = v;
  for (const n of names) {
    const v = lower[n.toLowerCase()];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return null;
}

function pStr(row: Record<string, unknown>, ...names: string[]): string | null {
  const v = pick(row, ...names);
  if (v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function pNum(row: Record<string, unknown>, ...names: string[]): number | null {
  const v = pick(row, ...names);
  if (v === null) return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function pDay(row: Record<string, unknown>): string | null {
  const s = pStr(row, "date", "day");
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** Cột metrics dùng chung cho cả 5 report — thêm `units7d` như bí danh của RPC. */
function metricFields(row: Record<string, unknown>): Record<string, unknown> {
  const units7 = pNum(row, "unitsSoldClicks7d", "units7d");
  const out: Record<string, unknown> = {
    impressions: pNum(row, "impressions"),
    clicks: pNum(row, "clicks"),
    cost: pNum(row, "cost"),
    sales7d: pNum(row, "sales7d"),
    sales14d: pNum(row, "sales14d"),
    sales30d: pNum(row, "sales30d"),
    purchases7d: pNum(row, "purchases7d"),
    purchases14d: pNum(row, "purchases14d"),
    purchases30d: pNum(row, "purchases30d"),
    unitsSoldClicks7d: units7,
    unitsSoldClicks14d: pNum(row, "unitsSoldClicks14d"),
    unitsSoldClicks30d: pNum(row, "unitsSoldClicks30d"),
  };
  if (units7 !== null) out.units7d = units7;
  return out;
}

export type AdsParseOptions = {
  /** profile Ads đang kéo — DB khoá metrics theo ads_profile_id */
  adsProfileId?: string | null;
  /** tiền tệ của profile (report v3 thường KHÔNG trả cột currency) */
  currency?: string | null;
};

export function parseAdsReportText(
  kind: AdsReportKind,
  text: string,
  opts: AdsParseOptions = {},
): AdsParsedReport {
  const records = readAdsReportRecords(text);
  const warnings: string[] = [];
  const rows: Record<string, unknown>[] = [];
  let skipped = 0;
  const days = new Set<string>();

  const common = {
    ...(opts.adsProfileId ? { adsProfileId: opts.adsProfileId } : {}),
    ...(opts.currency ? { currency: opts.currency } : {}),
  };

  for (const rec of records) {
    const day = pDay(rec);
    const campaignId = pStr(rec, "campaignId");
    if (!day || !campaignId) {
      skipped++;
      continue;
    }
    days.add(day);

    if (kind === "campaigns") {
      const budgetAmount = pNum(rec, "campaignBudgetAmount", "budgetAmount");
      const budgetCurrency = pStr(rec, "campaignBudgetCurrencyCode", "budgetCurrency");
      rows.push({
        day,
        campaignId,
        campaignName: pStr(rec, "campaignName"),
        campaignState: pStr(rec, "campaignStatus", "campaignState"),
        budgetAmount,
        budgetCurrency,
        ...common,
        ...metricFields(rec),
      });
      continue;
    }

    const adGroupId = pStr(rec, "adGroupId");
    if (kind === "targeting") {
      const keywordId = pStr(rec, "keywordId");
      const expression = pStr(rec, "targetingExpression", "targeting", "expressionValue");
      if (!keywordId && !expression) {
        skipped++;
        continue;
      }
      rows.push({
        day,
        campaignId,
        adGroupId,
        targetKind: keywordId ? "keyword" : "product_target",
        targetKey: keywordId ?? expression ?? "",
        keywordText: pStr(rec, "keyword", "keywordText"),
        matchType: pStr(rec, "matchType"),
        expressionType: keywordId ? null : pStr(rec, "expressionType") ?? "expression",
        expressionValue: keywordId ? null : expression,
        ...common,
        ...metricFields(rec),
      });
      continue;
    }

    if (kind === "search-terms") {
      const term = pStr(rec, "searchTerm", "term");
      if (!term || !adGroupId) {
        skipped++;
        continue;
      }
      rows.push({
        day,
        campaignId,
        adGroupId,
        keywordId: pStr(rec, "keywordId"),
        keywordText: pStr(rec, "keyword", "keywordText"),
        matchType: pStr(rec, "matchType"),
        searchTerm: term,
        ...common,
        ...metricFields(rec),
      });
      continue;
    }

    // advertised-products | purchased-products
    const advertisedAsin = pStr(rec, "advertisedAsin");
    const advertisedSku = pStr(rec, "advertisedSku");
    if (!advertisedAsin && !advertisedSku) {
      skipped++;
      continue;
    }
    const base: Record<string, unknown> = {
      day,
      campaignId,
      adGroupId,
      advertisedAsin,
      advertisedSku,
      keywordText: pStr(rec, "keyword", "keywordText"),
      matchType: pStr(rec, "matchType"),
      ...common,
      ...metricFields(rec),
    };
    if (kind === "purchased-products") {
      const purchasedAsin = pStr(rec, "purchasedAsin");
      if (!purchasedAsin) {
        skipped++;
        continue;
      }
      const salesOther7 = pNum(rec, "salesOtherSku7d", "salesOther7d");
      const unitsOther7 = pNum(rec, "unitsSoldOtherSku7d", "unitsOther7d");
      rows.push({
        ...base,
        purchasedAsin,
        salesOtherSku7d: salesOther7,
        salesOtherSku14d: pNum(rec, "salesOtherSku14d", "salesOther14d"),
        salesOtherSku30d: pNum(rec, "salesOtherSku30d", "salesOther30d"),
        unitsSoldOtherSku7d: unitsOther7,
        unitsSoldOtherSku14d: pNum(rec, "unitsSoldOtherSku14d", "unitsOther14d"),
        unitsSoldOtherSku30d: pNum(rec, "unitsSoldOtherSku30d", "unitsOther30d"),
      });
      continue;
    }
    rows.push(base);
  }

  if (skipped > 0) {
    warnings.push(
      `${skipped} dòng bị bỏ: thiếu ngày/campaign (hoặc thiếu khoá riêng của loại report). ` +
        `Xem lại cột đã yêu cầu trong report.`,
    );
  }
  if (records.length === 0) {
    warnings.push(
      "Report không có dòng nào — với ngày không chạy quảng cáo đây là bình thường " +
        "(job sẽ ghi trạng thái no_data, KHÔNG coi là lỗi).",
    );
  }

  return {
    kind,
    rows,
    warnings,
    skipped,
    days: days.size,
    summary:
      `${rows.length} dòng · ${days.size} ngày · ${days.size > 0 ? `mới nhất ${[...days].sort().at(-1)}` : "—"}`,
  };
}

// ============================================================================
// IMPORT — đi qua RPC service_role của 0020
// ============================================================================

export type AdsImportOutcome = {
  inserted: number;
  updated: number;
  skipped: number;
  merged: number;
  days: number | null;
  currencies: string | null;
  kept: number | null;
};

const ZERO_OUTCOME: AdsImportOutcome = {
  inserted: 0,
  updated: 0,
  skipped: 0,
  merged: 0,
  days: null,
  currencies: null,
  kept: null,
};

/** Chặn ghi nhầm dòng của report này sang bảng của report khác. */
function assertRowsMatchKind(kind: AdsReportKind, rows: Record<string, unknown>[]): void {
  if (rows.length === 0) return;
  const first = rows[0];
  const checks: Record<AdsReportKind, () => boolean> = {
    campaigns: () => typeof first.campaignId === "string" && !("adGroupId" in first),
    targeting: () => "targetKey" in first,
    "search-terms": () => "searchTerm" in first,
    "advertised-products": () => "advertisedAsin" in first || "advertisedSku" in first,
    "purchased-products": () => "purchasedAsin" in first,
  };
  if (!checks[kind]()) {
    throw new Error(
      `importAdsReport: rows không phải của report "${kind}" — đã parse nhầm loại? ` +
        `Kiểm tra lại reportTypeId khi createReport.`,
    );
  }
}

export async function importAdsReport(
  db: DbAdapter,
  sellerAccountId: string,
  parsed: AdsParsedReport,
): Promise<AdsImportOutcome> {
  assertRowsMatchKind(parsed.kind, parsed.rows);
  if (parsed.rows.length === 0) return { ...ZERO_OUTCOME, skipped: parsed.skipped };

  switch (parsed.kind) {
    case "campaigns": {
      const c: AdsMetricCounts = await db.upsertAdsCampaignMetrics(
        sellerAccountId,
        parsed.rows as never,
      );
      return toOutcome(c);
    }
    case "targeting": {
      const c: AdsMetricCounts = await db.upsertAdsTargetMetrics(
        sellerAccountId,
        parsed.rows as never,
      );
      return toOutcome(c);
    }
    case "search-terms": {
      const c: AdsMetricCounts = await db.upsertAdsSearchTerms(
        sellerAccountId,
        parsed.rows as never,
      );
      return toOutcome(c);
    }
    case "advertised-products": {
      const c: AdsMetricCounts = await db.upsertAdsProductMetrics(
        sellerAccountId,
        "advertised",
        parsed.rows as never,
      );
      return toOutcome(c);
    }
    case "purchased-products": {
      const c: AdsMetricCounts = await db.upsertAdsProductMetrics(
        sellerAccountId,
        "purchased",
        parsed.rows as never,
      );
      return toOutcome(c);
    }
  }
}

function toOutcome(c: AdsMetricCounts): AdsImportOutcome {
  return {
    inserted: c.inserted,
    updated: c.updated,
    skipped: c.skipped,
    merged: c.merged,
    days: c.days,
    currencies: c.currencies,
    kept: null,
  };
}

/* ============================================================================
 * Tiện ích cho job entity-sync (profiles/campaigns/ad groups/targets)
 * ==========================================================================*/

export type {
  AdsProfileRowInput,
  AdsCampaignRowInput,
  AdsAdGroupRowInput,
  AdsTargetRowInput,
  AdsBudgetEventRowInput,
  AdsProductMetricRowInput,
  AdsSearchTermRowInput,
  AdsTargetMetricRowInput,
  AdsEntityCounts,
  AdsMetricCounts,
};
