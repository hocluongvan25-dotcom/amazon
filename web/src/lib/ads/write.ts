/**
 * write.ts — Module 5 PHẦN 2&3: GHI lên Amazon Ads (Sponsored Products v3).
 *
 * LUẬT AN TOÀN (mỗi luật đều có test trong tests/ppc-write.test.ts):
 *   1. KHÔNG gọi Amazon nếu chưa bật ADS_WRITE_ENABLED=1 — cron chỉ báo cáo.
 *   2. KHÔNG tự nghĩ ra thay đổi: chỉ áp dụng những dòng ĐÃ DUYỆT trong
 *      ads.change_requests (RPC vexim_worker_ppc_pending_changes "giành" lô).
 *   3. ĐỌC LẠI Amazon trước khi ghi (verify): giá trị hiện tại khác before_value
 *      → SKIP. Ai đó đổi tay trong Ads console thì hệ thống không ghi đè.
 *   4. 429/5xx/lỗi mạng → KHÔNG đánh dấu failed: để nguyên "applying" cho lượt sau
 *      đòi lại (reclaim). Không retry dồn trong cùng một lượt.
 *   5. Mỗi dòng kết quả đều ghi về DB (vexim_worker_ppc_set_result) → trigger audit
 *      trong 0021 tự ghi iam.audit_logs. Không có đường ghi nào quên audit.
 *
 * HỢP ĐỒNG SP v3 (đối chiếu 13/09/2026 qua manifest Airbyte source-amazon-ads +
 * 2 client production + withone.ai/Postman; trang docs chính thức là app JS nên
 * không fetch trực tiếp được):
 *   PUT  /sp/campaigns                  {campaigns:[{campaignId, budget?, state?, name?}]}
 *   PUT  /sp/keywords                   {keywords:[{keywordId, bid?, state?}]}
 *   PUT  /sp/adGroups                   {adGroups:[{adGroupId, state?, defaultBid?}]}
 *   POST /sp/negativeKeywords           {negativeKeywords:[{campaignId, adGroupId, keywordText, matchType, state}]}
 *   POST /sp/campaignNegativeKeywords   {campaignNegativeKeywords:[{campaignId, keywordText, matchType, state}]}
 *   POST /sp/campaigns/list · /sp/keywords/list · /sp/negativeKeywords/list ·
 *   POST /sp/campaignNegativeKeywords/list   (đọc để verify)
 *   media type: application/vnd.sp<Entity>.v3+json — Accept VÀ Content-Type.
 *   response ghi: 207 Multi-Status {<key>:{success:[{index,…}], error:[{index, errors:[{code,message}]}]}}
 *   matchType phủ định là NEGATIVE_EXACT / NEGATIVE_PHRASE (v2 dùng negativeExact —
 *   dùng nhầm Amazon trả 400 chứ không tự hiểu).
 *
 * CHƯA MỞ (cố ý, không đoán hợp đồng):
 *   • đổi bid của TARGET (ASIN/category) qua PUT /sp/targets — không nguồn nào xác
 *     nhận tên khoá của body ghi ({targets} hay {targetingClauses}).
 *   • Sponsored Brands / Sponsored Display: endpoint khác, body khác. Worker tự
 *     skip đề xuất không thuộc SP (RPC 0021 đã skip, đây là lớp chắn thứ hai).
 */
import { ADS_MEDIA, ADS_WRITE_BATCH_SIZE, loadAdsConfig, type AdsRuntimeConfig } from "./config.ts";
import { AdsClient } from "./client.ts";
import { AdsApiError, AdsTokenError } from "./errors.ts";
import { normalizeProfiles, pickProfile, type AdsProfile } from "./profiles.ts";
import { AdsTokenManager, type AdsAccessToken } from "./tokens.ts";
import type { AdsDb, PpcPendingBatch, PpcResultRow } from "./db.ts";

/* ============================ Kiểu dữ liệu ============================ */

export type PpcEntityType =
  | "campaign"
  | "ad_group"
  | "keyword"
  | "negative_keyword"
  | "campaign_negative_keyword";

export type PpcChangeType = "bid" | "budget" | "state" | "name" | "create";

/** Một đề xuất đã duyệt, do RPC vexim_worker_ppc_pending_changes trả về. */
export type PpcChangeRequest = {
  requestId: string;
  sellerAccountId: string;
  shop: string | null;
  adsProfileId: string;
  entityType: PpcEntityType;
  changeType: PpcChangeType;
  amazonEntityId: string;
  campaignId: string;
  adGroupId: string;
  label: string;
  matchType: string | null;
  currency: string | null;
  beforeValue: Record<string, unknown> | null;
  afterValue: Record<string, unknown> | null;
  deltaPct: number | null;
  attempts: number;
  batchId: string | null;
  /** loại campaign theo bảng ads.campaigns — chiều ghi chỉ mở cho SP */
  campaignType: string | null;
  campaignName: string | null;
  campaignState: string | null;
  campaignDailyBudget: number | null;
  status: string | null;
  lastError: string | null;
  proposedAt: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
  claimedAt: string | null;
};

/** Ảnh chụp trạng thái Amazon của shop, đọc TRƯỚC khi ghi (để verify). */
export type AmazonSnapshot = {
  campaigns: Map<string, { budget: number | null; budgetType: string | null; state: string | null; name: string | null }>;
  keywords: Map<string, { bid: number | null; state: string | null; campaignId: string | null; adGroupId: string | null }>;
  negatives: Set<string>;
  /** đọc được bao nhiêu trang / có bị cắt không — để log nói thật về độ phủ */
  keywordsPages: number;
  keywordsTruncated: boolean;
  negativesPages: number;
  campaignsRead: number;
  readErrors: string[];
};

export type VerifyOutcome = {
  ok: boolean;
  /** lý do skip (hiện thẳng lên UI/audit) */
  reason: string | null;
  /** true khi không có before_value để đối chiếu (người duyệt đã chấp nhận) */
  unverifiable: boolean;
  /** giá trị Amazon đang giữ — ghi vào log để đối chiếu */
  current: string | null;
};

export type ApplyItemResult = {
  requestId: string;
  label: string;
  entityType: PpcEntityType;
  changeType: PpcChangeType;
  op: string;
  status: "applied" | "failed" | "skipped" | "deferred";
  createdId: string | null;
  message: string | null;
  verified: boolean;
  httpStatus: number | null;
};

export type AdsApplyShopResult = {
  shopId: string;
  shopName: string;
  profileId: string | null;
  profileReason: string | null;
  tokenSource: "db" | "env" | null;
  claimed: number;
  applied: number;
  failed: number;
  skipped: number;
  deferred: number;
  items: ApplyItemResult[];
  warnings: string[];
  error: string | null;
};

export type AdsApplyCounts = {
  claimed: number;
  applied: number;
  failed: number;
  skipped: number;
  deferred: number;
  verified: number;
  alerts: number;
  apiCalls: number;
};

export type AdsApplyOptions = {
  config?: AdsRuntimeConfig;
  db?: AdsDb | null;
  shops?: string[];
  maxShops?: number;
  limit?: number;
  /** đọc Amazon + dựng payload nhưng KHÔNG gửi và KHÔNG ghi kết quả */
  dryRun?: boolean;
  /** bỏ qua bước đọc lại Amazon (chỉ dùng khi đối soát tay; mặc định LUÔN verify) */
  skipVerify?: boolean;
  fetchFn?: typeof fetch;
  now?: () => Date;
  stdout?: { write: (s: string) => unknown };
};

export type AdsApplyResult = {
  enabled: boolean;
  ready: boolean;
  db: "supabase" | "none";
  dryRun: boolean;
  region: string;
  host: string;
  shopsProcessed: number;
  counts: AdsApplyCounts;
  outcomes: AdsApplyShopResult[];
  warnings: string[];
  errors: string[];
  problems: string[];
  hint: string | null;
};

/* ====================== Bảng operation của SP v3 ====================== */

export type WriteOpKey =
  | "updateCampaigns"
  | "updateKeywords"
  | "updateAdGroups"
  | "createNegativeKeywords"
  | "createCampaignNegativeKeywords";

export type WriteOp = {
  key: WriteOpKey;
  method: "PUT" | "POST";
  path: string;
  media: string;
  /** khoá bọc mảng trong body gửi đi */
  bodyKey: string;
  /** khoá chứa {success, error} trong phản hồi 207 */
  resultKey: string;
  /** trường id Amazon của thực thể (để lấy id khi TẠO mới) */
  idField: string;
  /** id trong body để đối chiếu index → request khi Amazon không trả index */
  requestIndexField: string | null;
};

export const ADS_WRITE_OPS: Record<WriteOpKey, WriteOp> = {
  updateCampaigns: {
    key: "updateCampaigns",
    method: "PUT",
    path: "/sp/campaigns",
    media: ADS_MEDIA.spCampaign,
    bodyKey: "campaigns",
    resultKey: "campaigns",
    idField: "campaignId",
    requestIndexField: "campaignId",
  },
  updateKeywords: {
    key: "updateKeywords",
    method: "PUT",
    path: "/sp/keywords",
    media: ADS_MEDIA.spKeyword,
    bodyKey: "keywords",
    resultKey: "keywords",
    idField: "keywordId",
    requestIndexField: "keywordId",
  },
  updateAdGroups: {
    key: "updateAdGroups",
    method: "PUT",
    path: "/sp/adGroups",
    media: ADS_MEDIA.spAdGroup,
    bodyKey: "adGroups",
    resultKey: "adGroups",
    idField: "adGroupId",
    requestIndexField: "adGroupId",
  },
  createNegativeKeywords: {
    key: "createNegativeKeywords",
    method: "POST",
    path: "/sp/negativeKeywords",
    media: ADS_MEDIA.spNegativeKeyword,
    bodyKey: "negativeKeywords",
    resultKey: "negativeKeywords",
    idField: "negativeKeywordId",
    requestIndexField: null,
  },
  createCampaignNegativeKeywords: {
    key: "createCampaignNegativeKeywords",
    method: "POST",
    path: "/sp/campaignNegativeKeywords",
    media: ADS_MEDIA.spCampaignNegativeKeyword,
    bodyKey: "campaignNegativeKeywords",
    resultKey: "campaignNegativeKeywords",
    idField: "campaignNegativeKeywordId",
    requestIndexField: null,
  },
};

/**
 * Ánh xạ (entity_type, change_type) → operation Amazon.
 * NULL = chưa hỗ trợ (worker phải skip có lý do, KHÔNG đoán endpoint).
 */
export function opForRequest(req: PpcChangeRequest): WriteOp | null {
  if (req.entityType === "campaign") {
    if (req.changeType === "budget" || req.changeType === "state" || req.changeType === "name") {
      return ADS_WRITE_OPS.updateCampaigns;
    }
    return null;
  }
  if (req.entityType === "keyword") {
    if (req.changeType === "bid" || req.changeType === "state") return ADS_WRITE_OPS.updateKeywords;
    return null;
  }
  if (req.entityType === "ad_group") {
    if (req.changeType === "state") return ADS_WRITE_OPS.updateAdGroups;
    return null;
  }
  if (req.entityType === "negative_keyword" && req.changeType === "create") {
    return ADS_WRITE_OPS.createNegativeKeywords;
  }
  if (req.entityType === "campaign_negative_keyword" && req.changeType === "create") {
    return ADS_WRITE_OPS.createCampaignNegativeKeywords;
  }
  return null;
}

/* ====================== Dựng payload gửi Amazon ====================== */

export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
}

export function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** SP v3 chỉ hiểu hai giá trị này — gửi "negativeExact" (kiểu v2) là 400 CẢ LÔ. */
export const NEGATIVE_MATCH_TYPES = ["NEGATIVE_EXACT", "NEGATIVE_PHRASE"] as const;

/**
 * Chuẩn hoá match_type phủ định sang wire format SP v3.
 * Chấp nhận cách viết cũ (negativeExact / "negative phrase" / PHRASE) vì dữ liệu có
 * thể đến từ import hoặc từ bảng ads.negative_keywords nạp qua đường khác; trả null
 * khi KHÔNG nhận ra để caller đánh dấu failed thay vì đoán rồi bị Amazon từ chối.
 */
export function toWireMatchType(v: unknown): string | null {
  const raw = String(v ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (raw === "") return "NEGATIVE_EXACT";
  if (raw === "EXACT" || raw === "NEGATIVEEXACT") return "NEGATIVE_EXACT";
  if (raw === "PHRASE" || raw === "NEGATIVEPHRASE") return "NEGATIVE_PHRASE";
  return (NEGATIVE_MATCH_TYPES as readonly string[]).includes(raw) ? raw : null;
}

/** Amazon nhận bid 2 chữ số thập phân; gửi 1.7000001 là bị từ chối. */
export function roundBid(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

/**
 * Dựng MỘT phần tử của mảng gửi đi (wire format Amazon).
 * Trả null khi thiếu dữ liệu bắt buộc → caller đánh dấu failed kèm lý do.
 */
export function buildWriteItem(req: PpcChangeRequest): { item: Record<string, unknown> | null; reason: string | null } {
  const after = req.afterValue ?? {};
  const before = req.beforeValue ?? {};

  if (req.entityType === "campaign") {
    if (!req.amazonEntityId) return { item: null, reason: "thiếu campaignId" };
    const item: Record<string, unknown> = { campaignId: req.amazonEntityId };
    if (req.changeType === "budget") {
      // SP v3: budget là OBJECT lồng {budget, budgetType} — gửi số trần là 400.
      const budget = numOrNull(after.budget);
      if (budget === null || budget <= 0) return { item: null, reason: "after_value.budget không phải số dương" };
      item.budget = { budget: roundBid(budget), budgetType: strOrNull(after.budget_type) ?? strOrNull(before.budget_type) ?? "DAILY" };
      return { item, reason: null };
    }
    if (req.changeType === "state") {
      const state = strOrNull(after.state)?.toUpperCase() ?? null;
      if (!state || !["ENABLED", "PAUSED", "ARCHIVED"].includes(state)) {
        return { item: null, reason: `after_value.state không hợp lệ (${String(after.state ?? "rỗng")})` };
      }
      item.state = state;
      return { item, reason: null };
    }
    if (req.changeType === "name") {
      const name = strOrNull(after.name) ?? strOrNull(req.label);
      if (!name) return { item: null, reason: "thiếu tên mới" };
      item.name = name;
      return { item, reason: null };
    }
    return { item: null, reason: `change_type '${req.changeType}' chưa hỗ trợ cho campaign` };
  }

  if (req.entityType === "keyword") {
    if (!req.amazonEntityId) return { item: null, reason: "thiếu keywordId" };
    const item: Record<string, unknown> = { keywordId: req.amazonEntityId };
    if (req.changeType === "bid") {
      const bid = numOrNull(after.bid);
      if (bid === null || bid <= 0) return { item: null, reason: "after_value.bid không phải số dương" };
      item.bid = roundBid(bid);
      return { item, reason: null };
    }
    if (req.changeType === "state") {
      const state = strOrNull(after.state)?.toUpperCase() ?? null;
      if (!state || !["ENABLED", "PAUSED", "ARCHIVED"].includes(state)) {
        return { item: null, reason: `after_value.state không hợp lệ (${String(after.state ?? "rỗng")})` };
      }
      item.state = state;
      return { item, reason: null };
    }
    return { item: null, reason: `change_type '${req.changeType}' chưa hỗ trợ cho keyword` };
  }

  if (req.entityType === "ad_group") {
    if (!req.amazonEntityId) return { item: null, reason: "thiếu adGroupId" };
    const item: Record<string, unknown> = { adGroupId: req.amazonEntityId };
    const state = strOrNull(after.state)?.toUpperCase() ?? null;
    if (!state || !["ENABLED", "PAUSED", "ARCHIVED"].includes(state)) {
      return { item: null, reason: `after_value.state không hợp lệ (${String(after.state ?? "rỗng")})` };
    }
    item.state = state;
    return { item, reason: null };
  }

  if (req.entityType === "negative_keyword" || req.entityType === "campaign_negative_keyword") {
    const text = strOrNull(after.keyword_text) ?? strOrNull(req.label);
    if (!text) return { item: null, reason: "thiếu keywordText" };
    if (!req.campaignId) return { item: null, reason: "thiếu campaignId" };
    const rawMatch = strOrNull(after.match_type) ?? strOrNull(req.matchType) ?? "NEGATIVE_EXACT";
    const matchType = toWireMatchType(rawMatch);
    if (!matchType) {
      return { item: null, reason: `matchType '${rawMatch}' không hợp lệ với SP v3 (chỉ NEGATIVE_EXACT/NEGATIVE_PHRASE)` };
    }
    const item: Record<string, unknown> = {
      campaignId: req.campaignId,
      keywordText: text,
      matchType,
      state: "ENABLED",
    };
    if (req.entityType === "negative_keyword") {
      if (!req.adGroupId) return { item: null, reason: "negative keyword cấp ad group cần adGroupId" };
      item.adGroupId = req.adGroupId;
    }
    return { item, reason: null };
  }

  return { item: null, reason: `entity_type '${req.entityType}' chưa hỗ trợ` };
}

/** Gom đề xuất theo operation (một lần gọi Amazon cho mỗi op, tối đa 100 phần tử). */
export function groupByOp(requests: PpcChangeRequest[]): Map<WriteOpKey, PpcChangeRequest[]> {
  const out = new Map<WriteOpKey, PpcChangeRequest[]>();
  for (const r of requests) {
    const op = opForRequest(r);
    if (!op) continue;
    const list = out.get(op.key) ?? [];
    list.push(r);
    out.set(op.key, list);
  }
  return out;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/* ====================== Đọc phản hồi 207 Multi-Status ====================== */

export type MultiStatusEntry = {
  index: number | null;
  id: string | null;
  raw: Record<string, unknown>;
};

export type MultiStatusError = {
  index: number | null;
  code: string;
  message: string;
};

export type MultiStatus = {
  success: MultiStatusEntry[];
  errors: MultiStatusError[];
  /** Amazon trả mảng trần (bản cũ) chứ không phải {success, error} */
  bare: boolean;
  /** phản hồi không đọc được cấu trúc — caller phải coi như lỗi cả lô */
  unparsed: boolean;
};

/**
 * Tách phản hồi 207 của SP v3.
 * Amazon có thể trả:
 *   {campaigns:{success:[{index, campaignId, …}], error:[{index, errors:[{code,message}]}]}}
 *   {campaigns:[…]}                       (một số tài khoản/bản cũ)
 *   [{…}]                                 (mảng trần)
 *   {errors:[{code,message}]}             (lỗi cả lô)
 * Không đọc được → unparsed=true (caller đánh dấu failed, KHÔNG coi là thành công).
 */
export function parseMultiStatus(raw: unknown, resultKey: string, idField: string): MultiStatus {
  const empty: MultiStatus = { success: [], errors: [], bare: false, unparsed: false };
  if (raw === null || raw === undefined) return { ...empty, unparsed: true };

  if (Array.isArray(raw)) {
    return {
      ...empty,
      bare: true,
      success: (raw as Record<string, unknown>[]).map((r, i) => ({
        index: typeof r?.index === "number" ? r.index : i,
        id: strOrNull(r?.[idField]) ?? strOrNull(r?.[`${idField}`]) ?? null,
        raw: r ?? {},
      })),
    };
  }

  const rec = raw as Record<string, unknown>;
  // lỗi cả lô (400/403 trả body {errors:[…]} mà vẫn 200 ở một số cạnh)
  if (Array.isArray(rec.errors) && rec[resultKey] === undefined) {
    return {
      ...empty,
      unparsed: true,
      errors: (rec.errors as Record<string, unknown>[]).map((e) => ({
        index: numOrNull(e?.index),
        code: strOrNull(e?.code) ?? strOrNull(e?.errorType) ?? "error",
        message: strOrNull(e?.message) ?? strOrNull(e?.errorValue) ?? JSON.stringify(e),
      })),
    };
  }

  const body = (rec[resultKey] ?? rec) as Record<string, unknown> | unknown[];
  if (Array.isArray(body)) {
    return {
      ...empty,
      bare: true,
      success: (body as Record<string, unknown>[]).map((r, i) => ({
        index: typeof r?.index === "number" ? r.index : i,
        id: strOrNull(r?.[idField]) ?? null,
        raw: r ?? {},
      })),
    };
  }

  const b = body as Record<string, unknown>;
  const successRaw = Array.isArray(b.success) ? (b.success as Record<string, unknown>[]) : [];
  const errorRaw = Array.isArray(b.error) ? (b.error as Record<string, unknown>[]) : [];
  if (successRaw.length === 0 && errorRaw.length === 0 && Object.keys(b).length === 0) {
    return { ...empty, unparsed: true };
  }

  const success: MultiStatusEntry[] = successRaw.map((r, i) => {
    const nested = (r?.[idField] ?? r?.campaign ?? r?.keyword ?? r?.negativeKeyword ?? {}) as Record<string, unknown>;
    return {
      index: numOrNull(r?.index) ?? i,
      id: strOrNull(r?.[idField]) ?? strOrNull(nested?.[idField]) ?? null,
      raw: r ?? {},
    };
  });
  const errors: MultiStatusError[] = errorRaw.map((r) => {
    const list = Array.isArray(r?.errors) ? (r.errors as Record<string, unknown>[]) : [r];
    const first = list[0] ?? {};
    return {
      index: numOrNull(r?.index),
      code: strOrNull(first?.code) ?? strOrNull(first?.errorType) ?? "error",
      message:
        list.map((e) => strOrNull(e?.message) ?? strOrNull(e?.errorValue) ?? "").filter(Boolean).join("; ") ||
        JSON.stringify(r),
    };
  });
  return { success, errors, bare: false, unparsed: false };
}

/** Nối index của phản hồi về đúng đề xuất (Amazon có thể không trả index). */
export function matchResults(
  batch: PpcChangeRequest[],
  parsed: MultiStatus,
  op: WriteOp,
): Map<string, ApplyItemResult> {
  const out = new Map<string, ApplyItemResult>();
  const baseFor = (r: PpcChangeRequest): ApplyItemResult => ({
    requestId: r.requestId,
    label: r.label || r.amazonEntityId || r.campaignId,
    entityType: r.entityType,
    changeType: r.changeType,
    op: op.key,
    status: "failed",
    createdId: null,
    message: null,
    verified: true,
    httpStatus: 207,
  });

  if (parsed.unparsed) {
    for (const r of batch) {
      const base = baseFor(r);
      base.message =
        parsed.errors.length > 0
          ? parsed.errors.map((e) => `${e.code}: ${e.message}`).join("; ")
          : "Amazon trả phản hồi không đọc được cấu trúc {success,error} — không dám coi là thành công";
      base.httpStatus = null;
      out.set(r.requestId, base);
    }
    return out;
  }

  for (const s of parsed.success) {
    const idx = s.index ?? null;
    const r =
      (idx !== null && idx >= 0 && idx < batch.length ? batch[idx] : null) ??
      (s.id ? batch.find((x) => x.amazonEntityId === s.id) : null) ??
      null;
    if (!r) continue;
    const base = baseFor(r);
    base.status = "applied";
    base.createdId = s.id;
    base.message = null;
    out.set(r.requestId, base);
  }

  for (const e of parsed.errors) {
    const idx = e.index ?? null;
    const r = idx !== null && idx >= 0 && idx < batch.length ? batch[idx] : null;
    if (!r) continue;
    const base = baseFor(r);
    base.status = "failed";
    base.message = `${e.code}: ${e.message}`.slice(0, 500);
    out.set(r.requestId, base);
  }

  // dòng không nằm trong success cũng không nằm trong error → KHÔNG đoán
  for (const r of batch) {
    if (out.has(r.requestId)) continue;
    const base = baseFor(r);
    base.status = "failed";
    base.message = "Amazon không trả kết quả cho dòng này trong phản hồi 207 — coi như chưa áp dụng";
    base.httpStatus = null;
    out.set(r.requestId, base);
  }
  return out;
}

/* ====================== Đọc Amazon để đối chiếu (verify) ====================== */

export function emptySnapshot(): AmazonSnapshot {
  return {
    campaigns: new Map(),
    keywords: new Map(),
    negatives: new Set(),
    keywordsPages: 0,
    keywordsTruncated: false,
    negativesPages: 0,
    campaignsRead: 0,
    readErrors: [],
  };
}

/** khoá khử trùng của một từ khoá phủ định (giống khoá unique trong 0021). */
export function negativeKey(campaignId: string, adGroupId: string, text: string, matchType: string): string {
  return `${campaignId}|${adGroupId}|${text.trim().toLowerCase()}|${matchType.toUpperCase()}`;
}

async function postList(
  client: AdsClient,
  path: string,
  media: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return client.request<Record<string, unknown>>("POST", path, {
    body,
    contentType: media,
    accept: media,
  });
}

function pickArray(rec: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const v = rec?.[key];
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

/**
 * Đọc trạng thái THẬT trên Amazon cho những thực thể sắp bị ghi.
 * Có filter thì dùng filter (ít trang); Amazon từ chối filter thì LÙI về đọc không
 * filter + phân trang (thà đọc thừa còn hơn ghi mù). Mọi lỗi đọc đều được ghi lại
 * trong snapshot.readErrors để log nói thật là verify được bao nhiêu.
 */
export async function readSnapshot(
  client: AdsClient,
  requests: PpcChangeRequest[],
  opts: { maxPages?: number; log?: (s: string) => unknown } = {},
): Promise<AmazonSnapshot> {
  const snap = emptySnapshot();
  const maxPages = opts.maxPages ?? 10;

  const campaignIds = [...new Set(requests.filter((r) => r.entityType === "campaign" && r.amazonEntityId).map((r) => r.amazonEntityId))];
  const keywordCampaignIds = [...new Set(requests.filter((r) => r.entityType === "keyword").map((r) => r.campaignId).filter(Boolean))];
  const keywordIds = [...new Set(requests.filter((r) => r.entityType === "keyword" && r.amazonEntityId).map((r) => r.amazonEntityId))];
  const negativeCampaignIds = [
    ...new Set(
      requests
        .filter((r) => r.entityType === "negative_keyword" || r.entityType === "campaign_negative_keyword")
        .map((r) => r.campaignId)
        .filter(Boolean),
    ),
  ];

  // ---- campaigns -----------------------------------------------------------
  if (campaignIds.length > 0) {
    try {
      const res = await postList(client, "/sp/campaigns/list", ADS_MEDIA.spCampaign, {
        campaignIdFilter: { include: campaignIds },
        count: ADS_WRITE_BATCH_SIZE,
      });
      for (const c of pickArray(res, "campaigns")) ingestCampaign(snap, c);
      snap.campaignsRead = snap.campaigns.size;
    } catch (e) {
      // filter không được tài khoản này chấp nhận → đọc tất cả rồi lọc tại chỗ
      try {
        const all = await client.listAllSpCampaigns({ maxPages });
        for (const c of all.campaigns) ingestCampaign(snap, c);
        snap.campaignsRead = snap.campaigns.size;
        snap.readErrors.push(
          `campaignIdFilter bị từ chối (${describe(e)}) → đã đọc ${all.campaigns.length} campaign không filter.`,
        );
      } catch (e2) {
        snap.readErrors.push(`Không đọc được campaign từ Amazon: ${describe(e2)}`);
      }
    }
  }

  // ---- keywords ------------------------------------------------------------
  if (keywordIds.length > 0) {
    const attempts: Record<string, unknown>[] = keywordCampaignIds.length > 0
      ? [{ campaignIdFilter: { include: keywordCampaignIds }, maxResults: ADS_WRITE_BATCH_SIZE }]
      : [];
    attempts.push({ maxResults: ADS_WRITE_BATCH_SIZE });

    let done = false;
    for (const body of attempts) {
      if (done) break;
      let nextToken: string | null = null;
      let pages = 0;
      try {
        do {
          const res = await postList(client, "/sp/keywords/list", ADS_MEDIA.spKeyword, {
            ...body,
            ...(nextToken ? { nextToken } : {}),
          });
          for (const k of pickArray(res, "keywords")) ingestKeyword(snap, k);
          nextToken = strOrNull(res?.nextToken);
          pages += 1;
        } while (nextToken && pages < maxPages);
        snap.keywordsPages = pages;
        snap.keywordsTruncated = !!nextToken;
        done = true;
      } catch (e) {
        snap.readErrors.push(`Không đọc được keyword (${JSON.stringify(Object.keys(body))}): ${describe(e)}`);
      }
    }
  }

  // ---- negative keywords (để không tạo trùng) ------------------------------
  if (negativeCampaignIds.length > 0) {
    const negBodies: { path: string; media: string; key: string; level: "ad_group" | "campaign" }[] = [
      { path: "/sp/negativeKeywords/list", media: ADS_MEDIA.spNegativeKeyword, key: "negativeKeywords", level: "ad_group" },
      {
        path: "/sp/campaignNegativeKeywords/list",
        media: ADS_MEDIA.spCampaignNegativeKeyword,
        key: "campaignNegativeKeywords",
        level: "campaign",
      },
    ];
    for (const nb of negBodies) {
      let nextToken: string | null = null;
      let pages = 0;
      try {
        do {
          const res = await postList(client, nb.path, nb.media, {
            campaignIdFilter: { include: negativeCampaignIds },
            maxResults: ADS_WRITE_BATCH_SIZE,
            ...(nextToken ? { nextToken } : {}),
          });
          for (const row of pickArray(res, nb.key)) {
            const cid = strOrNull(row.campaignId) ?? "";
            if (cid !== "" && !negativeCampaignIds.includes(cid)) continue;
            const text = strOrNull(row.keywordText);
            if (!text) continue;
            snap.negatives.add(
              negativeKey(cid, nb.level === "campaign" ? "" : (strOrNull(row.adGroupId) ?? ""), text,
                strOrNull(row.matchType) ?? "NEGATIVE_EXACT"),
            );
          }
          nextToken = strOrNull(res?.nextToken);
          pages += 1;
        } while (nextToken && pages < maxPages);
        snap.negativesPages += pages;
      } catch (e) {
        snap.readErrors.push(`Không đọc được negative keyword (${nb.path}): ${describe(e)}`);
      }
    }
  }

  opts.log?.(
    `[verify] campaign=${snap.campaigns.size} keyword=${snap.keywords.size} negative=${snap.negatives.size}` +
      `${snap.readErrors.length > 0 ? ` · ${snap.readErrors.length} lỗi đọc` : ""}\n`,
  );
  return snap;
}

function ingestCampaign(snap: AmazonSnapshot, c: Record<string, unknown>): void {
  const id = strOrNull(c?.campaignId);
  if (!id) return;
  const budget = (c?.budget ?? {}) as Record<string, unknown>;
  snap.campaigns.set(id, {
    budget: numOrNull(budget?.budget) ?? numOrNull(c?.budget),
    budgetType: strOrNull(budget?.budgetType) ?? strOrNull(c?.budgetType),
    state: strOrNull(c?.state)?.toUpperCase() ?? null,
    name: strOrNull(c?.name),
  });
}

function ingestKeyword(snap: AmazonSnapshot, k: Record<string, unknown>): void {
  const id = strOrNull(k?.keywordId);
  if (!id) return;
  snap.keywords.set(id, {
    bid: numOrNull(k?.bid),
    state: strOrNull(k?.state)?.toUpperCase() ?? null,
    campaignId: strOrNull(k?.campaignId),
    adGroupId: strOrNull(k?.adGroupId),
  });
}

function describe(e: unknown): string {
  if (e instanceof AdsApiError) return `${e.code} ${e.message}`.slice(0, 200);
  return (e instanceof Error ? e.message : String(e)).slice(0, 200);
}

/** Sai số cho phép khi so tiền/bid (Amazon làm tròn 2 chữ số). */
export const VERIFY_TOLERANCE = 0.005;

/**
 * Đối chiếu MỘT đề xuất với ảnh chụp Amazon.
 * Trả ok=false → SKIP (không ghi), kèm lý do người duyệt đọc hiểu được.
 */
export function verifyRequest(req: PpcChangeRequest, snap: AmazonSnapshot): VerifyOutcome {
  const before = req.beforeValue ?? {};
  const after = req.afterValue ?? {};

  if (req.entityType === "campaign") {
    const cur = snap.campaigns.get(req.amazonEntityId);
    if (!cur) {
      return {
        ok: false,
        reason: `Không đọc được campaign ${req.amazonEntityId} từ Amazon${
          snap.readErrors.length > 0 ? ` (${snap.readErrors[0]})` : ""
        } — không ghi khi chưa đối chiếu được.`,
        unverifiable: true,
        current: null,
      };
    }
    if (cur.state === "ARCHIVED") {
      return { ok: false, reason: "Campaign đã ARCHIVED trên Amazon — không sửa được nữa.", unverifiable: false, current: cur.state };
    }
    if (req.changeType === "budget") {
      const beforeBudget = numOrNull(before.budget);
      if (beforeBudget === null) {
        return { ok: true, reason: null, unverifiable: true, current: cur.budget === null ? null : String(cur.budget) };
      }
      if (cur.budget === null) {
        return { ok: false, reason: "Amazon không trả ngân sách hiện tại — không đối chiếu được.", unverifiable: true, current: null };
      }
      if (Math.abs(cur.budget - beforeBudget) > VERIFY_TOLERANCE) {
        return {
          ok: false,
          reason: `Amazon đang để ngân sách ${cur.budget} ${req.currency ?? ""} khác before_value ${beforeBudget} — có người đã đổi tay, không ghi đè.`,
          unverifiable: false,
          current: String(cur.budget),
        };
      }
      return { ok: true, reason: null, unverifiable: false, current: String(cur.budget) };
    }
    // state / name
    const beforeState = strOrNull(before.state)?.toUpperCase() ?? null;
    const targetState = strOrNull(after.state)?.toUpperCase() ?? null;
    if (targetState && cur.state === targetState) {
      return { ok: false, reason: `Campaign đã ở trạng thái ${targetState} trên Amazon — không cần đổi.`, unverifiable: false, current: cur.state };
    }
    if (beforeState && cur.state && cur.state !== beforeState) {
      return {
        ok: false,
        reason: `Amazon đang để trạng thái ${cur.state} khác before_value ${beforeState} — có người đã đổi tay.`,
        unverifiable: false,
        current: cur.state,
      };
    }
    return { ok: true, reason: null, unverifiable: !beforeState, current: cur.state };
  }

  if (req.entityType === "keyword" || req.entityType === "ad_group") {
    if (req.entityType === "ad_group") {
      // Chiều ghi ad group mới mở cho state; không có ảnh chụp riêng → không đoán.
      return {
        ok: false,
        reason: "Chưa đọc trạng thái ad group để đối chiếu (chiều ghi ad group chưa mở) — bỏ qua.",
        unverifiable: true,
        current: null,
      };
    }
    const cur = snap.keywords.get(req.amazonEntityId);
    if (!cur) {
      return {
        ok: false,
        reason: `Không thấy keyword ${req.amazonEntityId} trong dữ liệu đọc được${
          snap.keywordsTruncated ? ` (bị cắt ở ${snap.keywordsPages} trang)` : ""
        }${snap.readErrors.length > 0 ? ` — ${snap.readErrors[0]}` : ""}. Không ghi khi chưa đối chiếu được.`,
        unverifiable: true,
        current: null,
      };
    }
    if (req.changeType === "bid") {
      const beforeBid = numOrNull(before.bid);
      if (beforeBid === null) {
        return { ok: true, reason: null, unverifiable: true, current: cur.bid === null ? null : String(cur.bid) };
      }
      if (cur.bid === null) {
        return { ok: false, reason: "Amazon không trả bid hiện tại của keyword — không đối chiếu được.", unverifiable: true, current: null };
      }
      if (Math.abs(cur.bid - beforeBid) > VERIFY_TOLERANCE) {
        return {
          ok: false,
          reason: `Amazon đang để bid ${cur.bid} khác before_value ${beforeBid} — có người đã đổi tay trong Ads console, không ghi đè.`,
          unverifiable: false,
          current: String(cur.bid),
        };
      }
      return { ok: true, reason: null, unverifiable: false, current: String(cur.bid) };
    }
    const beforeState = strOrNull(before.state)?.toUpperCase() ?? null;
    const targetState = strOrNull(after.state)?.toUpperCase() ?? null;
    if (targetState && cur.state === targetState) {
      return { ok: false, reason: `Keyword đã ở trạng thái ${targetState} trên Amazon — không cần đổi.`, unverifiable: false, current: cur.state };
    }
    if (beforeState && cur.state && cur.state !== beforeState) {
      return {
        ok: false,
        reason: `Amazon đang để trạng thái ${cur.state} khác before_value ${beforeState} — có người đã đổi tay.`,
        unverifiable: false,
        current: cur.state,
      };
    }
    return { ok: true, reason: null, unverifiable: !beforeState, current: cur.state };
  }

  // negative keyword: verify = Amazon CHƯA có từ này
  const text = strOrNull(after.keyword_text) ?? strOrNull(req.label);
  if (!text) return { ok: false, reason: "thiếu keywordText", unverifiable: false, current: null };
  const matchType = toWireMatchType(strOrNull(after.match_type) ?? strOrNull(req.matchType)) ?? "NEGATIVE_EXACT";
  const adGroup = req.entityType === "campaign_negative_keyword" ? "" : req.adGroupId;
  if (snap.readErrors.some((e) => e.includes("negative keyword"))) {
    return {
      ok: false,
      reason: `Không đọc được danh sách phủ định từ Amazon (${snap.readErrors.find((e) => e.includes("negative keyword"))}) — không tạo mù.`,
      unverifiable: true,
      current: null,
    };
  }
  if (snap.negatives.has(negativeKey(req.campaignId, adGroup, text, matchType))) {
    return {
      ok: false,
      reason: `Amazon đã có "${text}" (${matchType}) trong danh sách phủ định — không tạo trùng.`,
      unverifiable: false,
      current: "exists",
    };
  }
  return { ok: true, reason: null, unverifiable: false, current: null };
}

/* ============================ Luồng áp dụng ============================ */

function newShopResult(shopId: string, shopName: string): AdsApplyShopResult {
  return {
    shopId,
    shopName,
    profileId: null,
    profileReason: null,
    tokenSource: null,
    claimed: 0,
    applied: 0,
    failed: 0,
    skipped: 0,
    deferred: 0,
    items: [],
    warnings: [],
    error: null,
  };
}

/**
 * "Retryable" = lỗi tạm thời (429/5xx/mạng, hoặc LWA bị throttle). Những lỗi này
 * KHÔNG đánh dấu failed: dòng giữ nguyên "applying" để reclaim của lượt sau lấy lại.
 * invalid_grant / hết quyền → KHÔNG retryable → failed + alert để người vào sửa.
 */
function isRetryable(e: unknown): boolean {
  if (e instanceof AdsApiError) return e.retryable === true;
  if (e instanceof AdsTokenError) return e.retryable === true;
  return false;
}

/**
 * Áp dụng các đề xuất ĐÃ DUYỆT lên Amazon.
 *
 * Không bật ADS_WRITE_ENABLED → trả về ngay, KHÔNG giành lô (hàng đợi nguyên trạng).
 * dryRun → đọc hàng đợi + đọc Amazon + dựng payload, KHÔNG gửi và KHÔNG ghi kết quả.
 */
export async function runAdsApply(opts: AdsApplyOptions = {}): Promise<AdsApplyResult> {
  const config = opts.config ?? loadAdsConfig();
  const dryRun = opts.dryRun === true;
  const skipVerify = opts.skipVerify === true;
  const db: AdsDb | null = opts.db ?? null;
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? (() => new Date());
  const log = (s: string) => opts.stdout?.write(s);
  const limit = Math.max(1, Math.min(opts.limit ?? config.writeBatchLimit, 500));
  const counts: AdsApplyCounts = {
    claimed: 0,
    applied: 0,
    failed: 0,
    skipped: 0,
    deferred: 0,
    verified: 0,
    alerts: 0,
    apiCalls: 0,
  };
  const warnings: string[] = [];
  const errors: string[] = [];
  const outcomes: AdsApplyShopResult[] = [];

  const result: AdsApplyResult = {
    enabled: config.writeEnabled,
    ready: config.ready,
    db: db ? "supabase" : "none",
    dryRun,
    region: config.region,
    host: config.host,
    shopsProcessed: 0,
    counts,
    outcomes,
    warnings,
    errors,
    problems: config.problems,
    hint: null,
  };

  if (!config.writeEnabled && !dryRun) {
    result.hint =
      "ADS_WRITE_ENABLED chưa bật → cron KHÔNG gọi Amazon (hàng đợi giữ nguyên). " +
      "Xem trước những gì sẽ gửi: /api/cron/ads-apply?dryRun=1. " +
      "Bật thật: đặt ADS_WRITE_ENABLED=1 trên Vercel rồi Redeploy.";
    warnings.push("Chiều ghi PPC đang TẮT (ADS_WRITE_ENABLED). Đề xuất đã duyệt vẫn nằm trong hàng đợi.");
    log?.(`[ads-apply] DỪNG: ${result.hint}\n`);
    return result;
  }

  if (!config.clientId || !config.clientSecret) {
    errors.push(
      "Chưa có AMAZON_ADS_CLIENT_ID/SECRET → không gọi được Ads API. " +
        "Lấy ở advertising.amazon.com → Developer Console → Security profile (loại Web app).",
    );
    log?.(`[ads-apply] DỪNG: ${errors[0]}\n`);
    return result;
  }
  if (!db) {
    errors.push("Cần Supabase service role để đọc hàng đợi thay đổi (ads.change_requests).");
    log?.(`[ads-apply] DỪNG: ${errors[0]}\n`);
    return result;
  }

  const tokenManager = new AdsTokenManager(
    {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      region: config.region,
      tokenKey: config.tokenKey,
      envRefreshToken: config.envRefreshToken,
    },
    { store: db, fetchFn, now },
  );

  let shops: { id: string; displayName: string }[] = [];
  try {
    const all = await db.listShops();
    shops = all
      .filter((s) => (opts.shops && opts.shops.length > 0 ? opts.shops.includes(s.id) : true))
      .slice(0, opts.maxShops ?? 50)
      .map((s) => ({ id: s.id, displayName: s.displayName }));
  } catch (e) {
    errors.push(`Không đọc được danh sách shop: ${(e as Error).message}`);
    log?.(`[ads-apply] DỪNG: ${errors[0]}\n`);
    return result;
  }

  log?.(
    `[ads-apply] host=${config.host} region=${config.region} · ${shops.length} shop · limit=${limit}/shop · ` +
      `dryRun=${dryRun} · verify=${!skipVerify}\n`,
  );

  for (const shop of shops) {
    result.shopsProcessed += 1;
    const out = newShopResult(shop.id, shop.displayName);
    outcomes.push(out);

    // ---- 1. lấy đề xuất (dryRun thì chỉ ĐỌC, không giành lô) ----------------
    let requests: PpcChangeRequest[] = [];
    try {
      if (dryRun) {
        requests = await db.listApprovedChanges(shop.id, limit);
      } else {
        const batch: PpcPendingBatch = await db.pendingChanges(shop.id, limit, config.writeStaleMinutes);
        requests = batch.requests;
        if (batch.expired > 0) out.warnings.push(`Tự hết hạn ${batch.expired} đề xuất quá TTL.`);
        if (batch.reclaimed > 0) out.warnings.push(`Đòi lại ${batch.reclaimed} lô kẹt từ lượt trước.`);
        if (batch.skippedUnsupported > 0) {
          out.warnings.push(`Tự bỏ qua ${batch.skippedUnsupported} đề xuất không thuộc Sponsored Products.`);
        }
        for (const c of batch.capLeft) {
          if (c.usedToday >= c.dailyCap && c.waiting > 0) {
            out.warnings.push(
              `Trần ngày đã dùng hết (${c.usedToday}/${c.dailyCap}) mà còn ${c.waiting} việc chờ — tăng daily_change_cap nếu cần.`,
            );
          }
        }
      }
    } catch (e) {
      out.error = `Không đọc được hàng đợi: ${(e as Error).message}`;
      errors.push(`Shop ${shop.displayName}: ${out.error}`);
      log?.(`[ads-apply] ${shop.displayName}: ${out.error}\n`);
      continue;
    }

    out.claimed = requests.length;
    counts.claimed += requests.length;
    if (requests.length === 0) {
      log?.(`[ads-apply] ${shop.displayName}: không có đề xuất đã duyệt nào.\n`);
      continue;
    }

    // ---- 2. token + profileId ----------------------------------------------
    let token: AdsAccessToken;
    try {
      token = await tokenManager.accessToken(shop.id);
      out.tokenSource = token.source;
    } catch (e) {
      out.error = `Không lấy được access token Ads: ${(e as Error).message}`;
      errors.push(`Shop ${shop.displayName}: ${out.error}`);
      // Không có token thì KHÔNG được để lô hàng kẹt ở "applying" im lặng:
      // trả về hàng đợi để lượt sau thử lại (lỗi token thường do chưa re-authorize).
      if (!dryRun) {
        out.failed += await failBatch(db, requests, `${out.error} Sửa xong vào /ppc → tab Thay đổi để duyệt lại.`, log);
        counts.failed += out.failed;
      }
      log?.(`[ads-apply] ${shop.displayName}: ${out.error}\n`);
      continue;
    }

    const baseClient = new AdsClient({
      host: config.host,
      clientId: token.clientId,
      accountId: config.accountId,
      getAccessToken: async () => token.accessToken,
      fetchFn,
    });

    let profileId = requests.find((r) => r.adsProfileId)?.adsProfileId ?? null;
    if (!profileId) {
      try {
        counts.apiCalls += 1;
        const raw = await baseClient.listProfiles();
        const profiles: AdsProfile[] = normalizeProfiles(raw);
        const decision = pickProfile(profiles, {
          profileId: token.adsAccountId ?? null,
          marketplaceId: null,
          countryCode: config.countryCodeHint,
          accountType: config.profileTypeHint,
        });
        profileId = decision.profile?.profileId ?? null;
        out.profileReason = decision.reason;
        out.warnings.push(...decision.warnings);
      } catch (e) {
        out.error = `Không lấy được /v2/profiles: ${describe(e)}`;
        errors.push(`Shop ${shop.displayName}: ${out.error}`);
        if (!dryRun) {
          const n = await failBatch(db, requests, out.error, log);
          out.failed += n;
          counts.failed += n;
        }
        log?.(`[ads-apply] ${shop.displayName}: ${out.error}\n`);
        continue;
      }
    } else {
      out.profileReason = "profileId lấy từ hàng đợi (ads.ad_profiles)";
    }
    if (!profileId) {
      out.error = "Không chốt được profileId → không biết ghi lên tài khoản quảng cáo nào.";
      errors.push(`Shop ${shop.displayName}: ${out.error}`);
      if (!dryRun) {
        const n = await failBatch(db, requests, `${out.error} ${out.profileReason ?? ""}`.trim(), log);
        out.failed += n;
        counts.failed += n;
      }
      continue;
    }
    out.profileId = profileId;

    // nhóm theo profileId: một shop có thể có nhiều tài khoản quảng cáo
    const byProfile = new Map<string, PpcChangeRequest[]>();
    for (const r of requests) {
      const pid = r.adsProfileId || profileId;
      const list = byProfile.get(pid) ?? [];
      list.push(r);
      byProfile.set(pid, list);
    }

    for (const [pid, group] of byProfile) {
      const client = baseClient.withProfile(pid);
      await applyGroup({
        client,
        db,
        dryRun,
        skipVerify,
        shop,
        out,
        counts,
        requests: group,
        log,
        warnings,
        errors,
      });
    }

    // ---- 3. alert của hàng đợi ---------------------------------------------
    if (!dryRun) {
      try {
        const raised = await db.raisePpcAlerts(shop.id);
        counts.alerts += raised.length;
        for (const a of raised) {
          log?.(`[ads-apply] ${shop.displayName}: alert ${a.ruleCode} ${a.nextAction ?? ""}\n`);
        }
      } catch (e) {
        out.warnings.push(`Không cập nhật được alert hàng đợi PPC: ${(e as Error).message}`);
      }
    }

    log?.(
      `[ads-apply] ${shop.displayName}: claimed=${out.claimed} applied=${out.applied} ` +
        `failed=${out.failed} skipped=${out.skipped} deferred=${out.deferred}\n`,
    );
  }

  if (dryRun) {
    result.hint =
      "dryRun: đã đọc Amazon và dựng payload nhưng KHÔNG gửi, KHÔNG ghi kết quả — " +
      "hàng đợi vẫn ở trạng thái cũ.";
  } else if (counts.applied === 0 && counts.claimed > 0) {
    result.hint =
      "Không áp dụng được dòng nào: xem skipped (Amazon đã lệch / đã ở trạng thái đó) " +
      "và failed (Amazon từ chối) trong outcomes.";
  }
  return result;
}

/**
 * Đánh dấu FAILED cho cả lô khi shop không xử lý được (thiếu token/profile).
 *
 * Vì sao không để nguyên "applying": RPC vexim_worker_ppc_set_result chỉ nhận
 * applied/failed/skipped, còn đường về "approved" là do reclaim của LƯỢT SAU tự làm
 * (chỉ khi lô quá staleMinutes). Lỗi token/profile là lỗi DỨT KHOÁT, không phải
 * "chưa kịp" → ghi failed để alert ppc_change_failed nổ ngay, người vận hành vào
 * /module0 re-authorize rồi duyệt lại (failed → approved là cạnh hợp lệ của máy
 * trạng thái). Im lặng để lô treo là cách nhanh nhất để tiền vẫn đốt mà không ai biết.
 */
async function failBatch(
  db: AdsDb,
  requests: PpcChangeRequest[],
  reason: string,
  log?: (s: string) => unknown,
): Promise<number> {
  let n = 0;
  for (const r of requests) {
    try {
      await db.setChangeResult({
        id: r.requestId,
        status: "failed",
        batchId: r.batchId,
        error: reason.slice(0, 500),
        verifiedBefore: false,
      });
      n += 1;
    } catch (e) {
      log?.(`[ads-apply] không ghi được thất bại cho đề xuất ${r.requestId}: ${(e as Error).message}\n`);
    }
  }
  return n;
}

type ApplyGroupArgs = {
  client: AdsClient;
  db: AdsDb;
  dryRun: boolean;
  skipVerify: boolean;
  shop: { id: string; displayName: string };
  out: AdsApplyShopResult;
  counts: AdsApplyCounts;
  requests: PpcChangeRequest[];
  log?: (s: string) => unknown;
  warnings: string[];
  errors: string[];
};

async function applyGroup(a: ApplyGroupArgs): Promise<void> {
  const { client, dryRun, shop, out, counts, requests, log } = a;

  // ---- verify: đọc Amazon TRƯỚC khi ghi ------------------------------------
  let snap = emptySnapshot();
  if (!a.skipVerify) {
    try {
      counts.apiCalls += 1;
      snap = await readSnapshot(client, requests, { log });
      for (const e of snap.readErrors) out.warnings.push(e);
    } catch (e) {
      out.warnings.push(`Không đọc được trạng thái Amazon: ${describe(e)} — mọi đề xuất sẽ bị SKIP (không ghi mù).`);
      snap.readErrors.push(describe(e));
    }
  } else {
    out.warnings.push("skipVerify=1: bỏ qua đối chiếu Amazon — chỉ nên dùng khi đối soát tay.");
  }

  // ---- phân loại: skip / payload lỗi / gửi được -----------------------------
  const items: { req: PpcChangeRequest; item: Record<string, unknown> }[] = [];
  for (const req of requests) {
    const op = opForRequest(req);
    if (!op) {
      await finish(a, req, {
        requestId: req.requestId,
        label: req.label,
        entityType: req.entityType,
        changeType: req.changeType,
        op: "unsupported",
        status: "skipped",
        createdId: null,
        message: `entity_type=${req.entityType} × change_type=${req.changeType} chưa hỗ trợ chiều ghi`,
        verified: false,
        httpStatus: null,
      });
      continue;
    }
    if (String(req.campaignType ?? "").toLowerCase() !== "" && !isSponsoredProducts(req.campaignType)) {
      await finish(a, req, {
        requestId: req.requestId,
        label: req.label,
        entityType: req.entityType,
        changeType: req.changeType,
        op: op.key,
        status: "skipped",
        createdId: null,
        message: `chiều ghi mới mở cho Sponsored Products (campaign này là ${req.campaignType})`,
        verified: false,
        httpStatus: null,
      });
      continue;
    }

    if (!a.skipVerify) {
      const v = verifyRequest(req, snap);
      if (!v.ok) {
        await finish(a, req, {
          requestId: req.requestId,
          label: req.label,
          entityType: req.entityType,
          changeType: req.changeType,
          op: op.key,
          status: "skipped",
          createdId: null,
          message: v.reason,
          verified: false,
          httpStatus: null,
        });
        continue;
      }
      counts.verified += 1;
      if (v.unverifiable) {
        out.warnings.push(
          `${req.label || req.amazonEntityId}: áp dụng mà KHÔNG đối chiếu được before_value ` +
            `(Amazon hiện tại: ${v.current ?? "không rõ"}) — người duyệt đã chấp nhận.`,
        );
      }
    }

    const built = buildWriteItem(req);
    if (!built.item) {
      await finish(a, req, {
        requestId: req.requestId,
        label: req.label,
        entityType: req.entityType,
        changeType: req.changeType,
        op: op.key,
        status: "failed",
        createdId: null,
        message: `payload không hợp lệ: ${built.reason}`,
        verified: !a.skipVerify,
        httpStatus: null,
      });
      continue;
    }
    items.push({ req, item: built.item });
  }

  if (items.length === 0) {
    log?.(`[ads-apply] ${shop.displayName}: không có dòng nào gửi được (skip/fail khi kiểm tra).\n`);
    return;
  }

  // ---- gửi theo operation, mỗi lô ≤ 100 ------------------------------------
  const byOp = new Map<WriteOpKey, { req: PpcChangeRequest; item: Record<string, unknown> }[]>();
  for (const it of items) {
    const op = opForRequest(it.req);
    if (!op) continue;
    const list = byOp.get(op.key) ?? [];
    list.push(it);
    byOp.set(op.key, list);
  }

  for (const [opKey, list] of byOp) {
    const op = ADS_WRITE_OPS[opKey];
    for (const part of chunk(list, ADS_WRITE_BATCH_SIZE)) {
      const batchReqs = part.map((p) => p.req);
      const body = { [op.bodyKey]: part.map((p) => p.item) };

      if (dryRun) {
        for (const p of part) {
          out.items.push({
            requestId: p.req.requestId,
            label: p.req.label || p.req.amazonEntityId,
            entityType: p.req.entityType,
            changeType: p.req.changeType,
            op: op.key,
            status: "deferred",
            createdId: null,
            message: `dryRun: sẽ gửi ${op.method} ${op.path} · ${JSON.stringify(p.item)}`,
            verified: !a.skipVerify,
            httpStatus: null,
          });
          out.deferred += 1;
          counts.deferred += 1;
        }
        log?.(
          `[ads-apply] dryRun ${shop.displayName}: ${op.method} ${op.path} ` +
            `(${part.length} dòng) · body=${JSON.stringify(body).slice(0, 400)}\n`,
        );
        continue;
      }

      let raw: unknown = null;
      try {
        counts.apiCalls += 1;
        raw = await client.request<unknown>(op.method, op.path, {
          body,
          contentType: op.media,
          accept: op.media,
        });
      } catch (e) {
        const retryable = isRetryable(e);
        const msg = describe(e);
        if (retryable) {
          // 429/5xx/mạng: GIỮ nguyên "applying" → reclaim của lượt sau lấy lại.
          for (const r of batchReqs) {
            out.deferred += 1;
            counts.deferred += 1;
            out.items.push({
              requestId: r.requestId,
              label: r.label || r.amazonEntityId,
              entityType: r.entityType,
              changeType: r.changeType,
              op: op.key,
              status: "deferred",
              createdId: null,
              message: `chưa gửi được (retryable): ${msg} — để lượt sau đòi lại, KHÔNG retry dồn`,
              verified: !a.skipVerify,
              httpStatus: null,
            });
          }
          a.warnings.push(`Shop ${shop.displayName}: ${op.method} ${op.path} bị ${msg} → dời lô ${batchReqs.length} dòng sang lượt sau.`);
          log?.(`[ads-apply] ${shop.displayName}: ${op.path} retryable (${msg}) → dời ${batchReqs.length} dòng.\n`);
        } else {
          // Lỗi Amazon trả lời dứt khoát (400/403/404…): đọc body để lấy lý do từng
          // dòng; không đọc được cấu trúc thì coi CẢ LÔ thất bại kèm thông báo gốc.
          const httpStatus = e instanceof AdsApiError ? e.status : null;
          let parsed = parseMultiStatus(e instanceof AdsApiError ? tryJson(e.raw) : null, op.resultKey, op.idField);
          if (parsed.unparsed && parsed.errors.length === 0) {
            parsed = {
              ...parsed,
              errors: [{ index: null, code: e instanceof AdsApiError ? e.code : "error", message: msg }],
            };
          }
          const matched = matchResults(batchReqs, parsed, op);
          for (const r of batchReqs) {
            const m = matched.get(r.requestId);
            await finish(a, r, {
              requestId: r.requestId,
              label: r.label || r.amazonEntityId,
              entityType: r.entityType,
              changeType: r.changeType,
              op: op.key,
              status: "failed",
              createdId: null,
              message: m?.message ?? msg,
              verified: !a.skipVerify,
              httpStatus: m?.httpStatus ?? httpStatus,
            });
          }
        }
        continue;
      }

      const parsed = parseMultiStatus(raw, op.resultKey, op.idField);
      const matched = matchResults(batchReqs, parsed, op);
      for (const r of batchReqs) {
        const m = matched.get(r.requestId);
        if (!m) continue;
        await finish(a, r, { ...m, verified: !a.skipVerify, httpStatus: 207 });
      }
      log?.(
        `[ads-apply] ${shop.displayName}: ${op.method} ${op.path} → ${parsed.success.length} ok / ${parsed.errors.length} lỗi` +
          `${parsed.bare ? " (phản hồi mảng trần)" : ""}\n`,
      );
    }
  }
}

function tryJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function isSponsoredProducts(campaignType: string | null): boolean {
  const t = String(campaignType ?? "").toLowerCase();
  return t === "" || t === "sp" || t === "sponsoredproducts" || t === "sponsored_products";
}

/** Ghi MỘT kết quả về DB (dryRun thì chỉ đếm, không ghi). */
async function finish(a: ApplyGroupArgs, req: PpcChangeRequest, item: ApplyItemResult): Promise<void> {
  a.out.items.push(item);
  if (item.status === "applied") {
    a.out.applied += 1;
    a.counts.applied += 1;
  } else if (item.status === "failed") {
    a.out.failed += 1;
    a.counts.failed += 1;
  } else if (item.status === "skipped") {
    a.out.skipped += 1;
    a.counts.skipped += 1;
  } else {
    a.out.deferred += 1;
    a.counts.deferred += 1;
  }

  if (a.dryRun) return;
  if (item.status === "deferred") return; // giữ "applying" cho lượt sau đòi lại

  const row: PpcResultRow = {
    id: req.requestId,
    status: item.status,
    batchId: req.batchId,
    error: item.message,
    createdId: item.createdId,
    amazonResponse: null,
    verifiedBefore: item.verified,
  };
  try {
    await a.db.setChangeResult(row);
  } catch (e) {
    const msg = `Không ghi được kết quả cho ${req.requestId}: ${(e as Error).message}`;
    a.out.warnings.push(msg);
    a.errors.push(`Shop ${a.shop.displayName}: ${msg}`);
    a.log?.(`[ads-apply] ${msg}\n`);
  }
}
