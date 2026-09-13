/**
 * Data model cho Module 5 PHẦN 2&3 (chiều GHI PPC) — migration 0021.
 *
 * File này THUẦN TUÝ (không fetch, không Supabase, không "use server") để mọi
 * luật an toàn đều test được bằng `node --test`:
 *
 *  1. Guardrail là CHẶN HẲN, không phải cảnh báo: bid/budget ngoài sàn–trần của
 *     policy thì không sinh đề xuất (RPC cũng chặn — kiểm tra ở đây để người dùng
 *     biết TRƯỚC khi bấm, chứ không phải nhận lỗi sau khi gửi).
 *  2. Quá % thay đổi tối đa KHÔNG bị chặn → thành đề xuất cần duyệt. Hệ thống
 *     không tự ý đổi bid 60% mà không có người ký.
 *  3. CHƯA BIẾT GIÁ HIỆN TẠI (before_value thiếu số) → luôn cần duyệt, và UI phải
 *     nói rõ "chưa biết Amazon đang để bao nhiêu" để người duyệt không tưởng nhầm
 *     là đã đối chiếu.
 *  4. Negative keyword: match_type theo SP v3 là NEGATIVE_EXACT / NEGATIVE_PHRASE.
 *     Người dùng gõ "exact"/"phrase" thì chuẩn hoá; gõ cái lạ thì báo sai, không đoán.
 *  5. Không tự nghĩ ra con số: đề xuất sinh từ view vexim_ppc_suggestions (đã tính
 *     sẵn before/after/reason từ số liệu thật). Nhập tay thì phải có id Amazon.
 */

import { flag, int, num, str } from "./ads-model.ts";

export const NEGATIVE_MATCH_TYPES = ["NEGATIVE_EXACT", "NEGATIVE_PHRASE"] as const;
export const NEGATIVE_MATCH_LABEL: Record<string, string> = {
  NEGATIVE_EXACT: "Phủ định chính xác",
  NEGATIVE_PHRASE: "Phủ định theo cụm",
};


/* ------------------------------------------------------------------ */
/* Cột đọc từ 4 view của 0021 (SELECT cố định — đổi tên cột là lộ ngay) */
/* ------------------------------------------------------------------ */

export const PPC_POLICY_SELECT = [
  "seller_account_id",
  "shop",
  "marketplace",
  "shop_status",
  "has_policy_row",
  "auto_apply",
  "require_approval_state",
  "max_bid_change_pct",
  "max_budget_change_pct",
  "bid_floor",
  "bid_ceiling",
  "budget_floor",
  "budget_ceiling",
  "daily_change_cap",
  "max_open_requests",
  "proposal_ttl_hours",
  "suggestion_min_clicks",
  "suggestion_min_spend",
  "suggestion_acos_lower_pct",
  "bid_step_pct",
  "currency",
  "notes",
  "policy_updated_at",
  "proposed_count",
  "approved_count",
  "applying_count",
  "applied_today",
  "failed_24h",
  "open_count",
  "cap_left_today",
  "can_edit_policy",
].join(",");

export const PPC_REQUEST_SELECT = [
  "id",
  "seller_account_id",
  "shop",
  "ads_profile_id",
  "entity_type",
  "change_type",
  "amazon_entity_id",
  "campaign_id",
  "campaign_name",
  "campaign_type",
  "ad_group_id",
  "label",
  "match_type",
  "currency",
  "before_value",
  "after_value",
  "before_number",
  "after_number",
  "delta_pct",
  "delta_label",
  "summary",
  "entity_label",
  "requires_approval",
  "reason",
  "source",
  "suggestion_key",
  "status",
  "status_label",
  "is_open",
  "is_terminal",
  "batch_id",
  "proposed_by",
  "proposed_by_name",
  "proposed_at",
  "age_hours",
  "decided_by",
  "decided_by_name",
  "decided_at",
  "decision_note",
  "expires_at",
  "expires_in_hours",
  "expired",
  "attempts",
  "applied_at",
  "last_error",
  "amazon_response",
  "can_decide",
  "is_mine",
].join(",");

export const PPC_SUGGESTION_SELECT = [
  "seller_account_id",
  "shop",
  "kind",
  "priority",
  "suggestion_key",
  "entity_type",
  "change_type",
  "campaign_id",
  "campaign_name",
  "ad_group_id",
  "ad_group_name",
  "amazon_entity_id",
  "label",
  "match_type",
  "keyword_type",
  "currency",
  "before_value",
  "after_value",
  "current_number",
  "proposed_number",
  "delta_pct",
  "impressions7",
  "clicks7",
  "spend7",
  "sales7",
  "ad_orders7",
  "acos7",
  "acos_target",
  "waste7",
  "days_with_data",
  "window_end",
  "reason",
  "requires_approval",
  "has_open_request",
  "kind_label",
  "can_decide",
  "can_propose",
].join(",");

export const PPC_NEGATIVE_SELECT = [
  "id",
  "seller_account_id",
  "shop",
  "ads_profile_id",
  "campaign_id",
  "campaign_name",
  "ad_group_id",
  "ad_group_name",
  "level",
  "keyword_text",
  "keyword_norm",
  "match_type",
  "match_label",
  "amazon_negative_id",
  "state",
  "source",
  "change_request_id",
  "request_status",
  "created_at",
  "last_synced_at",
].join(",");

/* ------------------------------------------------------------------ */
/* Dòng thô (snake_case, đúng như PostgREST trả)                       */
/* ------------------------------------------------------------------ */

export type PpcPolicyDbRow = Record<string, unknown> & { seller_account_id: string };
export type PpcRequestDbRow = Record<string, unknown> & { id: string };
export type PpcSuggestionDbRow = Record<string, unknown> & { seller_account_id: string };
export type PpcNegativeDbRow = Record<string, unknown> & { id: string };

/* ------------------------------------------------------------------ */
/* Kiểu miền                                                           */
/* ------------------------------------------------------------------ */

export type PpcEntityType =
  | "campaign"
  | "ad_group"
  | "keyword"
  | "negative_keyword"
  | "campaign_negative_keyword";

export type PpcChangeType = "bid" | "budget" | "state" | "name" | "create";

export type PpcRequestStatus =
  | "proposed"
  | "approved"
  | "applying"
  | "applied"
  | "failed"
  | "rejected"
  | "expired"
  | "skipped";

export type PpcPolicy = {
  shopId: string;
  shop: string;
  marketplace: string | null;
  hasPolicyRow: boolean;
  autoApply: boolean;
  requireApprovalState: boolean;
  maxBidChangePct: number | null;
  maxBudgetChangePct: number | null;
  bidFloor: number | null;
  bidCeiling: number | null;
  budgetFloor: number | null;
  budgetCeiling: number | null;
  dailyChangeCap: number | null;
  maxOpenRequests: number | null;
  proposalTtlHours: number | null;
  suggestionMinClicks: number | null;
  suggestionMinSpend: number | null;
  suggestionAcosLowerPct: number | null;
  bidStepPct: number | null;
  currency: string;
  notes: string | null;
  policyUpdatedAt: string | null;
  proposedCount: number;
  approvedCount: number;
  applyingCount: number;
  appliedToday: number;
  failed24h: number;
  openCount: number;
  capLeftToday: number;
  canEditPolicy: boolean;
};

export type PpcRequest = {
  id: string;
  shopId: string;
  shop: string;
  adsProfileId: string | null;
  entityType: PpcEntityType;
  changeType: PpcChangeType;
  amazonEntityId: string;
  campaignId: string;
  campaignName: string | null;
  campaignType: string | null;
  adGroupId: string;
  label: string;
  matchType: string | null;
  currency: string;
  beforeValue: Record<string, unknown> | null;
  afterValue: Record<string, unknown> | null;
  beforeNumber: number | null;
  afterNumber: number | null;
  deltaPct: number | null;
  deltaLabel: string | null;
  summary: string | null;
  entityLabel: string | null;
  requiresApproval: boolean;
  reason: string | null;
  source: string | null;
  suggestionKey: string | null;
  status: PpcRequestStatus;
  statusLabel: string | null;
  isOpen: boolean;
  isTerminal: boolean;
  batchId: string | null;
  proposedBy: string | null;
  proposedByName: string | null;
  proposedAt: string | null;
  ageHours: number | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  expiresAt: string | null;
  expiresInHours: number | null;
  expired: boolean;
  attempts: number;
  appliedAt: string | null;
  lastError: string | null;
  amazonResponse: Record<string, unknown> | null;
  canDecide: boolean;
  isMine: boolean;
};

export type PpcSuggestionKind =
  | "negative_keyword"
  | "pause_keyword"
  | "pause_campaign"
  | "lower_bid"
  | "raise_budget";

export type PpcSuggestion = {
  shopId: string;
  shop: string;
  kind: PpcSuggestionKind | string;
  kindLabel: string;
  priority: number;
  suggestionKey: string | null;
  entityType: PpcEntityType;
  changeType: PpcChangeType;
  campaignId: string;
  campaignName: string | null;
  adGroupId: string;
  adGroupName: string | null;
  amazonEntityId: string;
  label: string;
  matchType: string | null;
  keywordType: string | null;
  currency: string;
  beforeValue: Record<string, unknown> | null;
  afterValue: Record<string, unknown> | null;
  currentNumber: number | null;
  proposedNumber: number | null;
  deltaPct: number | null;
  impressions7: number;
  clicks7: number;
  spend7: number;
  sales7: number;
  adOrders7: number;
  acos7: number | null;
  acosTarget: number | null;
  waste7: number;
  daysWithData: number;
  windowEnd: string | null;
  reason: string | null;
  requiresApproval: boolean;
  hasOpenRequest: boolean;
  canDecide: boolean;
  canPropose: boolean;
};

export type PpcNegative = {
  id: string;
  shopId: string;
  shop: string;
  campaignId: string;
  campaignName: string | null;
  adGroupId: string;
  adGroupName: string | null;
  level: "campaign" | "ad_group" | string;
  keywordText: string;
  keywordNorm: string;
  matchType: string;
  matchLabel: string | null;
  amazonNegativeId: string | null;
  state: string | null;
  source: string | null;
  changeRequestId: string | null;
  requestStatus: string | null;
  createdAt: string | null;
  lastSyncedAt: string | null;
};

/* ------------------------------------------------------------------ */
/* Mapper                                                              */
/* ------------------------------------------------------------------ */

/**
 * Làm tròn tiền/bid về 2 chữ số thập phân — PHẢI giống roundBid() của
 * lib/ads/write.ts (cộng Number.EPSILON trước khi nhân, không thì 1.005 thành 1.00
 * và con số UI hứa khác con số cron gửi Amazon). tests/ppc-write-ui.test.ts so trực
 * tiếp hai hàm này trên cùng một dãy số.
 */
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function obj(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

export function mapPpcPolicy(row: PpcPolicyDbRow): PpcPolicy {
  return {
    shopId: String(row.seller_account_id ?? ""),
    shop: str(row.shop) ?? String(row.seller_account_id ?? "").slice(0, 8),
    marketplace: str(row.marketplace),
    hasPolicyRow: flag(row.has_policy_row) === true,
    autoApply: flag(row.auto_apply) === true,
    requireApprovalState: flag(row.require_approval_state) !== false,
    maxBidChangePct: num(row.max_bid_change_pct),
    maxBudgetChangePct: num(row.max_budget_change_pct),
    bidFloor: num(row.bid_floor),
    bidCeiling: num(row.bid_ceiling),
    budgetFloor: num(row.budget_floor),
    budgetCeiling: num(row.budget_ceiling),
    dailyChangeCap: int(row.daily_change_cap),
    maxOpenRequests: int(row.max_open_requests),
    proposalTtlHours: int(row.proposal_ttl_hours),
    suggestionMinClicks: int(row.suggestion_min_clicks),
    suggestionMinSpend: num(row.suggestion_min_spend),
    suggestionAcosLowerPct: num(row.suggestion_acos_lower_pct),
    bidStepPct: num(row.bid_step_pct),
    currency: str(row.currency) ?? "USD",
    notes: str(row.notes),
    policyUpdatedAt: str(row.policy_updated_at),
    proposedCount: int(row.proposed_count) ?? 0,
    approvedCount: int(row.approved_count) ?? 0,
    applyingCount: int(row.applying_count) ?? 0,
    appliedToday: int(row.applied_today) ?? 0,
    failed24h: int(row.failed_24h) ?? 0,
    openCount: int(row.open_count) ?? 0,
    capLeftToday: int(row.cap_left_today) ?? 0,
    canEditPolicy: flag(row.can_edit_policy) === true,
  };
}

export function mapPpcRequest(row: PpcRequestDbRow): PpcRequest {
  return {
    id: String(row.id ?? ""),
    shopId: String(row.seller_account_id ?? ""),
    shop: str(row.shop) ?? "",
    adsProfileId: str(row.ads_profile_id),
    entityType: (str(row.entity_type) ?? "campaign") as PpcEntityType,
    changeType: (str(row.change_type) ?? "bid") as PpcChangeType,
    amazonEntityId: str(row.amazon_entity_id) ?? "",
    campaignId: str(row.campaign_id) ?? "",
    campaignName: str(row.campaign_name),
    campaignType: str(row.campaign_type),
    adGroupId: str(row.ad_group_id) ?? "",
    label: str(row.label) ?? "",
    matchType: str(row.match_type),
    currency: str(row.currency) ?? "USD",
    beforeValue: obj(row.before_value),
    afterValue: obj(row.after_value),
    beforeNumber: num(row.before_number),
    afterNumber: num(row.after_number),
    deltaPct: num(row.delta_pct),
    deltaLabel: str(row.delta_label),
    summary: str(row.summary),
    entityLabel: str(row.entity_label),
    requiresApproval: flag(row.requires_approval) !== false,
    reason: str(row.reason),
    source: str(row.source),
    suggestionKey: str(row.suggestion_key),
    status: (str(row.status) ?? "proposed") as PpcRequestStatus,
    statusLabel: str(row.status_label),
    isOpen: flag(row.is_open) === true,
    isTerminal: flag(row.is_terminal) === true,
    batchId: str(row.batch_id),
    proposedBy: str(row.proposed_by),
    proposedByName: str(row.proposed_by_name),
    proposedAt: str(row.proposed_at),
    ageHours: num(row.age_hours),
    decidedBy: str(row.decided_by),
    decidedByName: str(row.decided_by_name),
    decidedAt: str(row.decided_at),
    decisionNote: str(row.decision_note),
    expiresAt: str(row.expires_at),
    expiresInHours: num(row.expires_in_hours),
    expired: flag(row.expired) === true,
    attempts: int(row.attempts) ?? 0,
    appliedAt: str(row.applied_at),
    lastError: str(row.last_error),
    amazonResponse: obj(row.amazon_response),
    canDecide: flag(row.can_decide) === true,
    isMine: flag(row.is_mine) === true,
  };
}

export function mapPpcSuggestion(row: PpcSuggestionDbRow): PpcSuggestion {
  return {
    shopId: String(row.seller_account_id ?? ""),
    shop: str(row.shop) ?? "",
    kind: str(row.kind) ?? "unknown",
    kindLabel: str(row.kind_label) ?? str(row.kind) ?? "gợi ý",
    priority: int(row.priority) ?? 9,
    suggestionKey: str(row.suggestion_key),
    entityType: (str(row.entity_type) ?? "keyword") as PpcEntityType,
    changeType: (str(row.change_type) ?? "bid") as PpcChangeType,
    campaignId: str(row.campaign_id) ?? "",
    campaignName: str(row.campaign_name),
    adGroupId: str(row.ad_group_id) ?? "",
    adGroupName: str(row.ad_group_name),
    amazonEntityId: str(row.amazon_entity_id) ?? "",
    label: str(row.label) ?? "",
    matchType: str(row.match_type),
    keywordType: str(row.keyword_type),
    currency: str(row.currency) ?? "USD",
    beforeValue: obj(row.before_value),
    afterValue: obj(row.after_value),
    currentNumber: num(row.current_number),
    proposedNumber: num(row.proposed_number),
    deltaPct: num(row.delta_pct),
    impressions7: int(row.impressions7) ?? 0,
    clicks7: int(row.clicks7) ?? 0,
    spend7: num(row.spend7) ?? 0,
    sales7: num(row.sales7) ?? 0,
    adOrders7: int(row.ad_orders7) ?? 0,
    acos7: num(row.acos7),
    acosTarget: num(row.acos_target),
    waste7: num(row.waste7) ?? 0,
    daysWithData: int(row.days_with_data) ?? 0,
    windowEnd: str(row.window_end),
    reason: str(row.reason),
    requiresApproval: flag(row.requires_approval) !== false,
    hasOpenRequest: flag(row.has_open_request) === true,
    canDecide: flag(row.can_decide) === true,
    canPropose: flag(row.can_propose) === true,
  };
}

export function mapPpcNegative(row: PpcNegativeDbRow): PpcNegative {
  return {
    id: String(row.id ?? ""),
    shopId: String(row.seller_account_id ?? ""),
    shop: str(row.shop) ?? "",
    campaignId: str(row.campaign_id) ?? "",
    campaignName: str(row.campaign_name),
    adGroupId: str(row.ad_group_id) ?? "",
    adGroupName: str(row.ad_group_name),
    level: str(row.level) ?? (str(row.ad_group_id) ? "ad_group" : "campaign"),
    keywordText: str(row.keyword_text) ?? "",
    keywordNorm: str(row.keyword_norm) ?? (str(row.keyword_text) ?? "").toLowerCase(),
    matchType: str(row.match_type) ?? "NEGATIVE_EXACT",
    // view đã dịch nhãn; nếu nhãn thiếu (match_type lạ) thì tự dịch để UI không hiện ô trống
    matchLabel: str(row.match_label) ?? NEGATIVE_MATCH_LABEL[str(row.match_type) ?? ""] ?? null,
    amazonNegativeId: str(row.amazon_negative_id),
    state: str(row.state),
    source: str(row.source),
    changeRequestId: str(row.change_request_id),
    requestStatus: str(row.request_status),
    createdAt: str(row.created_at),
    lastSyncedAt: str(row.last_synced_at),
  };
}

/* ------------------------------------------------------------------ */
/* Đề xuất (payload của vexim_ppc_propose_changes)                     */
/* ------------------------------------------------------------------ */

/** MỘT phần tử của `items` — đúng tên khoá RPC đọc (snake_case, không đổi). */
export type PpcProposalItem = {
  entity_type: PpcEntityType;
  change_type: PpcChangeType;
  amazon_entity_id?: string;
  campaign_id?: string;
  ad_group_id?: string;
  label?: string;
  match_type?: string;
  currency?: string;
  before_value?: Record<string, unknown> | null;
  after_value?: Record<string, unknown>;
  reason?: string;
  suggestion_key?: string;
};

export type PpcProposalPayload = {
  seller_account_id: string;
  ads_profile_id?: string;
  source?: "manual" | "suggestion" | "import";
  reason?: string;
  items: PpcProposalItem[];
};

export type PpcWarning = {
  /** vị trí trong danh sách người dùng vừa chọn (−1 = lỗi chung) */
  index: number;
  label: string;
  /** blocked = không gửi · duplicate = trùng, bỏ qua · approval = sẽ cần duyệt */
  kind: "blocked" | "duplicate" | "approval";
  message: string;
};

export type ProposalValidation = {
  ok: boolean;
  message: string;
  items: PpcProposalItem[];
  warnings: PpcWarning[];
};

/** Cặp entity × change mà cả RPC lẫn Amazon đều hiểu (một nguồn sự thật cho UI). */
export const ALLOWED_PAIRS: [PpcEntityType, PpcChangeType[]][] = [
  ["campaign", ["budget", "state", "name"]],
  ["keyword", ["bid", "state"]],
  ["ad_group", ["state"]],
  ["negative_keyword", ["create"]],
  ["campaign_negative_keyword", ["create"]],
];

export function isAllowedPair(entityType: string, changeType: string): boolean {
  return ALLOWED_PAIRS.some(([e, list]) => e === entityType && list.includes(changeType as PpcChangeType));
}

/**
 * Chuẩn hoá match_type người dùng gõ. Trả null khi KHÔNG nhận ra — thà bắt gõ lại
 * còn hơn tự suy ra "chắc là exact" rồi phủ định sai từ.
 */
export function normalizeMatchType(input: unknown): string | null {
  const raw = String(input ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (raw === "") return "NEGATIVE_EXACT";
  if (raw === "EXACT" || raw === "NEGATIVEEXACT") return "NEGATIVE_EXACT";
  if (raw === "PHRASE" || raw === "NEGATIVEPHRASE") return "NEGATIVE_PHRASE";
  return (NEGATIVE_MATCH_TYPES as readonly string[]).includes(raw) ? raw : null;
}

export const ALLOWED_STATES = ["ENABLED", "PAUSED", "ARCHIVED"] as const;

export function normalizeState(input: unknown): string | null {
  const raw = String(input ?? "").trim().toUpperCase();
  if (raw === "") return null;
  if (raw === "ON" || raw === "ACTIVE" || raw === "BẬT") return "ENABLED";
  if (raw === "OFF" || raw === "TẮT") return "PAUSED";
  return (ALLOWED_STATES as readonly string[]).includes(raw) ? raw : null;
}

/** Gợi ý của view đã tính sẵn before/after → chỉ việc đóng gói gửi RPC. */
export function proposalItemFromSuggestion(s: PpcSuggestion): PpcProposalItem {
  const item: PpcProposalItem = {
    entity_type: s.entityType,
    change_type: s.changeType,
    label: s.label,
    currency: s.currency,
    before_value: s.beforeValue,
    after_value: s.afterValue ?? {},
    reason: s.reason ?? s.kindLabel,
  };
  if (s.amazonEntityId) item.amazon_entity_id = s.amazonEntityId;
  if (s.campaignId) item.campaign_id = s.campaignId;
  if (s.adGroupId) item.ad_group_id = s.adGroupId;
  if (s.matchType) item.match_type = s.matchType;
  if (s.suggestionKey) item.suggestion_key = s.suggestionKey;
  return item;
}

export type DeltaCheck = {
  /** % thay đổi so với before (null khi không có before để so) */
  deltaPct: number | null;
  /** before_value không có con số → KHÔNG biết Amazon đang để bao nhiêu */
  unknownBefore: boolean;
  /** vượt sàn/trần policy → CHẶN, không gửi */
  outOfRange: boolean;
  rangeText: string | null;
  /** vượt % tối đa → vẫn gửi được nhưng BẮT BUỘC có người duyệt */
  exceedsMaxPct: boolean;
  maxPct: number | null;
  /** giá trị mới bằng giá trị cũ → không có gì để làm */
  noChange: boolean;
  requiresApproval: boolean;
  message: string | null;
};

/**
 * Soi MỘT thay đổi số (bid/budget) qua guardrail — cùng luật với
 * `vexim_ppc_propose_changes`, chạy ở UI để người dùng thấy trước kết quả.
 */
export function checkNumberChange(input: {
  changeType: "bid" | "budget";
  before: unknown;
  after: unknown;
  policy: PpcPolicy;
}): DeltaCheck {
  const { changeType, policy } = input;
  const before = num(input.before);
  const after = num(input.after);
  const floor = changeType === "bid" ? policy.bidFloor : policy.budgetFloor;
  const ceiling = changeType === "bid" ? policy.bidCeiling : policy.budgetCeiling;
  const maxPct = changeType === "bid" ? policy.maxBidChangePct : policy.maxBudgetChangePct;
  const field = changeType === "bid" ? "bid" : "ngân sách";

  const base: DeltaCheck = {
    deltaPct: null,
    unknownBefore: before === null,
    outOfRange: false,
    rangeText: floor !== null || ceiling !== null ? `${floor ?? "—"} … ${ceiling ?? "—"}` : null,
    exceedsMaxPct: false,
    maxPct,
    noChange: false,
    requiresApproval: true,
    message: null,
  };

  if (after === null || after <= 0) {
    return { ...base, outOfRange: true, message: `${field} mới phải là số dương (đang để "${String(input.after ?? "")}").` };
  }
  if ((floor !== null && after < floor) || (ceiling !== null && after > ceiling)) {
    return {
      ...base,
      outOfRange: true,
      message: `${field} ${after} ${policy.currency} vượt sàn/trần trong guardrail (${base.rangeText}) — sửa guardrail trước nếu thật sự muốn vậy.`,
    };
  }
  if (before !== null && before > 0) {
    base.deltaPct = Math.round(((after - before) / before) * 10000) / 100;
    if (base.deltaPct === 0) {
      return { ...base, noChange: true, message: `${field} mới bằng giá trị hiện tại — không có gì để đổi.` };
    }
    if (maxPct !== null && Math.abs(base.deltaPct) > maxPct) {
      base.exceedsMaxPct = true;
      base.requiresApproval = true;
      base.message = `${field} đổi ${base.deltaPct > 0 ? "+" : ""}${base.deltaPct}% — vượt mức tự động ${maxPct}%, bắt buộc có người duyệt.`;
      return base;
    }
  }
  // auto_apply + trong ngưỡng → RPC có thể tự duyệt; nhưng thiếu before thì KHÔNG.
  base.requiresApproval = !(policy.autoApply && base.deltaPct !== null && !base.exceedsMaxPct) || base.unknownBefore;
  if (base.unknownBefore) {
    base.message = `Chưa biết ${field} Amazon đang để bao nhiêu (thiếu before_value) — đề xuất sẽ cần duyệt và cron phải đọc lại Amazon trước khi ghi.`;
  }
  return base;
}

/**
 * Kiểm tra cả lô đề xuất TRƯỚC khi gọi RPC.
 *
 * Trả về `items` là những dòng GỬI ĐƯỢC (đã chuẩn hoá match_type/state) và
 * `warnings` giải thích từng dòng bị loại. ok=false khi không còn dòng nào.
 */
export function validateProposalItems(
  items: PpcProposalItem[],
  policy: PpcPolicy,
  opts: { negatives?: PpcNegative[]; openKeys?: Set<string> } = {},
): ProposalValidation {
  const warnings: PpcWarning[] = [];
  const kept: PpcProposalItem[] = [];
  const negatives = opts.negatives ?? [];

  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, message: "Chưa chọn thay đổi nào.", items: [], warnings };
  }
  if (items.length > 500) {
    return {
      ok: false,
      message: `Tối đa 500 đề xuất mỗi lần (đang gửi ${items.length}) — chia nhỏ để dễ duyệt.`,
      items: [],
      warnings,
    };
  }
  if (policy.maxOpenRequests !== null && policy.openCount >= policy.maxOpenRequests) {
    return {
      ok: false,
      message: `Shop đang có ${policy.openCount} đề xuất mở — vượt trần ${policy.maxOpenRequests} trong guardrail. Duyệt/từ chối bớt rồi đề xuất tiếp.`,
      items: [],
      warnings: [{ index: -1, label: "", kind: "blocked", message: "vượt trần đề xuất mở" }],
    };
  }

  items.forEach((raw, index) => {
    const label = String(raw.label ?? raw.amazon_entity_id ?? `dòng ${index + 1}`);
    const entityType = String(raw.entity_type ?? "").trim().toLowerCase();
    const changeType = String(raw.change_type ?? "").trim().toLowerCase();

    if (!isAllowedPair(entityType, changeType)) {
      warnings.push({ index, label, kind: "blocked", message: `cặp ${entityType || "?"} × ${changeType || "?"} không hỗ trợ.` });
      return;
    }

    // after_value LUÔN là object ở đây (RPC cũng ép '{}' khi thiếu) → khai báo
    // riêng để TS không bắt null-check mỗi lần đọc khoá con.
    const afterValue: Record<string, unknown> = { ...(raw.after_value ?? {}) };
    const item: PpcProposalItem = {
      entity_type: entityType as PpcEntityType,
      change_type: changeType as PpcChangeType,
      label: String(raw.label ?? "").trim(),
      currency: String(raw.currency ?? policy.currency ?? "USD").toUpperCase(),
      before_value: raw.before_value ?? null,
      after_value: afterValue,
    };
    if (raw.amazon_entity_id) item.amazon_entity_id = String(raw.amazon_entity_id).trim();
    if (raw.campaign_id) item.campaign_id = String(raw.campaign_id).trim();
    if (raw.ad_group_id) item.ad_group_id = String(raw.ad_group_id).trim();
    if (raw.suggestion_key) item.suggestion_key = String(raw.suggestion_key);
    if (raw.reason) item.reason = String(raw.reason);

    // ---- id Amazon bắt buộc với thực thể CÓ SẴN -----------------------------
    if (changeType !== "create" && !item.amazon_entity_id) {
      warnings.push({
        index,
        label,
        kind: "blocked",
        message: "thiếu id Amazon (campaignId/keywordId) — không biết sửa cái gì.",
      });
      return;
    }

    // ---- negative keyword ---------------------------------------------------
    if (entityType === "negative_keyword" || entityType === "campaign_negative_keyword") {
      const text = String(raw.label ?? "").trim();
      if (!text) {
        warnings.push({ index, label, kind: "blocked", message: "thiếu từ khoá cần phủ định." });
        return;
      }
      if (text.length > 100) {
        warnings.push({ index, label, kind: "blocked", message: "từ khoá phủ định dài hơn 100 ký tự — Amazon sẽ từ chối." });
        return;
      }
      const matchType = normalizeMatchType(raw.match_type);
      if (!matchType) {
        warnings.push({
          index,
          label,
          kind: "blocked",
          message: `match_type "${String(raw.match_type ?? "")}" không hợp lệ — SP v3 chỉ nhận NEGATIVE_EXACT / NEGATIVE_PHRASE.`,
        });
        return;
      }
      if (!item.campaign_id) {
        warnings.push({ index, label, kind: "blocked", message: "thiếu campaign_id cho từ khoá phủ định." });
        return;
      }
      if (entityType === "campaign_negative_keyword") item.ad_group_id = "";
      if (entityType === "negative_keyword" && !item.ad_group_id) {
        warnings.push({
          index,
          label,
          kind: "blocked",
          message: "phủ định cấp ad group cần ad_group_id — hoặc chọn cấp campaign.",
        });
        return;
      }
      const adGroup = item.ad_group_id ?? "";
      const dup = negatives.find(
        (n) =>
          n.campaignId === item.campaign_id &&
          (n.adGroupId ?? "") === adGroup &&
          n.keywordNorm === text.toLowerCase() &&
          n.matchType === matchType &&
          (n.state ?? "ENABLED").toUpperCase() === "ENABLED",
      );
      if (dup) {
        warnings.push({ index, label, kind: "duplicate", message: `từ này ĐÃ được phủ định (${NEGATIVE_MATCH_LABEL[matchType] ?? matchType}).` });
        return;
      }
      item.match_type = matchType;
      // Object.assign chứ không gán lại: item.after_value phải trỏ đúng object này.
      Object.assign(afterValue, {
        keyword_text: text,
        match_type: matchType,
        campaign_id: item.campaign_id,
        ad_group_id: adGroup,
        level: adGroup === "" ? "campaign" : "ad_group",
      });
      kept.push(item);
      return;
    }

    // ---- bid / budget -------------------------------------------------------
    if (changeType === "bid" || changeType === "budget") {
      const field = changeType === "bid" ? "bid" : "budget";
      const check = checkNumberChange({
        changeType,
        before: item.before_value ? item.before_value[field] : null,
        after: afterValue[field],
        policy,
      });
      if (check.outOfRange || check.noChange) {
        warnings.push({ index, label, kind: check.noChange ? "duplicate" : "blocked", message: check.message ?? "không hợp lệ." });
        return;
      }
      // Amazon nhận 2 chữ số thập phân: gửi 1.7000001 là bị từ chối cả lô.
      afterValue[field] = roundMoney(Number(afterValue[field]));
      if (check.message) warnings.push({ index, label, kind: "approval", message: check.message });
      kept.push(item);
      return;
    }

    // ---- state / name -------------------------------------------------------
    if (changeType === "state") {
      const state = normalizeState(afterValue.state);
      if (!state) {
        warnings.push({
          index,
          label,
          kind: "blocked",
          message: `trạng thái "${String(afterValue.state ?? "")}" không hợp lệ — chỉ ENABLED / PAUSED / ARCHIVED.`,
        });
        return;
      }
      const beforeState = item.before_value ? str(item.before_value.state) : null;
      if (beforeState && beforeState.toUpperCase() === state) {
        warnings.push({ index, label, kind: "duplicate", message: `đang ở trạng thái ${state} rồi.` });
        return;
      }
      afterValue.state = state;
      if (policy.requireApprovalState || !policy.autoApply) {
        warnings.push({
          index,
          label,
          kind: "approval",
          message: `bật/tắt ${entityType === "campaign" ? "campaign" : entityType === "keyword" ? "keyword" : "ad group"} luôn cần người duyệt (guardrail require_approval_state).`,
        });
      }
      kept.push(item);
      return;
    }

    // name
    const name = str(afterValue.name);
    if (!name) {
      warnings.push({ index, label, kind: "blocked", message: "thiếu tên mới." });
      return;
    }
    afterValue.name = name;
    kept.push(item);
  });

  const blocked = warnings.filter((w) => w.kind === "blocked").length;
  const dup = warnings.filter((w) => w.kind === "duplicate").length;
  const needApproval = warnings.filter((w) => w.kind === "approval").length;

  if (kept.length === 0) {
    return {
      ok: false,
      message: `Không gửi được dòng nào: ${blocked} bị guardrail chặn${dup > 0 ? `, ${dup} trùng/không có gì để đổi` : ""}.`,
      items: [],
      warnings,
    };
  }

  const parts = [`${kept.length} đề xuất`];
  if (blocked > 0) parts.push(`${blocked} bị chặn`);
  if (dup > 0) parts.push(`${dup} trùng`);
  if (needApproval > 0) parts.push(`${needApproval} cần duyệt`);
  return { ok: true, message: parts.join(" · "), items: kept, warnings };
}

export function buildProposalPayload(input: {
  shopId: string;
  items: PpcProposalItem[];
  adsProfileId?: string | null;
  source?: "manual" | "suggestion" | "import";
  reason?: string | null;
}): PpcProposalPayload {
  const payload: PpcProposalPayload = {
    seller_account_id: input.shopId,
    source: input.source ?? "manual",
    items: input.items,
  };
  if (input.adsProfileId) payload.ads_profile_id = input.adsProfileId;
  if (input.reason) payload.reason = input.reason;
  return payload;
}

/* ------------------------------------------------------------------ */
/* Negative keyword nhập tay                                           */
/* ------------------------------------------------------------------ */

export type NegativeDraft = {
  campaignId: string;
  adGroupId?: string;
  keywordText: string;
  matchType: string;
  /** ad_group = phủ định trong 1 ad group · campaign = cả campaign */
  level: "ad_group" | "campaign";
  reason?: string;
};

export type NegativeDraftResult =
  | { ok: true; item: PpcProposalItem; message: string }
  | { ok: false; item: null; message: string };

/** Form "thêm từ khoá phủ định" → MỘT đề xuất (vẫn phải qua duyệt). */
export function validateNegativeDraft(draft: NegativeDraft, opts: { negatives?: PpcNegative[] } = {}): NegativeDraftResult {
  const text = String(draft.keywordText ?? "").trim();
  if (!text) return { ok: false, item: null, message: "Chưa nhập từ khoá cần phủ định." };
  if (text.length > 100) return { ok: false, item: null, message: "Từ khoá dài hơn 100 ký tự — Amazon sẽ từ chối." };
  if (!draft.campaignId) return { ok: false, item: null, message: "Chưa chọn campaign." };
  if (draft.level === "ad_group" && !draft.adGroupId) {
    return { ok: false, item: null, message: "Phủ định cấp ad group thì phải chọn ad group (hoặc chuyển sang cấp campaign)." };
  }
  const matchType = normalizeMatchType(draft.matchType);
  if (!matchType) {
    return {
      ok: false,
      item: null,
      message: `Không nhận ra kiểu phủ định "${draft.matchType}" — chọn "Phủ định chính xác" hoặc "Phủ định theo cụm".`,
    };
  }
  const adGroup = draft.level === "campaign" ? "" : String(draft.adGroupId ?? "").trim();
  const dup = (opts.negatives ?? []).find(
    (n) =>
      n.campaignId === draft.campaignId &&
      (n.adGroupId ?? "") === adGroup &&
      n.keywordNorm === text.toLowerCase() &&
      n.matchType === matchType &&
      (n.state ?? "ENABLED").toUpperCase() === "ENABLED",
  );
  if (dup) {
    return { ok: false, item: null, message: `"${text}" đã nằm trong danh sách phủ định của ${adGroup ? "ad group" : "campaign"} này.` };
  }
  const entityType: PpcEntityType = draft.level === "campaign" ? "campaign_negative_keyword" : "negative_keyword";
  const item: PpcProposalItem = {
    entity_type: entityType,
    change_type: "create",
    campaign_id: draft.campaignId,
    ad_group_id: adGroup,
    label: text,
    match_type: matchType,
    after_value: { keyword_text: text, match_type: matchType, campaign_id: draft.campaignId, ad_group_id: adGroup, level: draft.level },
    reason: draft.reason?.trim() ? draft.reason.trim() : `Phủ định "${text}" để dừng chi cho search term không ra đơn`,
  };
  return {
    ok: true,
    item,
    message: `Sẽ đề xuất phủ định "${text}" (${NEGATIVE_MATCH_LABEL[matchType]}) cấp ${draft.level === "campaign" ? "campaign" : "ad group"}.`,
  };
}

/* ------------------------------------------------------------------ */
/* Guardrail (policy)                                                  */
/* ------------------------------------------------------------------ */

export type PolicyDraft = {
  autoApply: string | boolean;
  requireApprovalState: string | boolean;
  maxBidChangePct: string | number;
  maxBudgetChangePct: string | number;
  bidFloor: string | number;
  bidCeiling: string | number;
  budgetFloor: string | number;
  budgetCeiling: string | number;
  dailyChangeCap: string | number;
  maxOpenRequests: string | number;
  proposalTtlHours: string | number;
  bidStepPct: string | number;
  currency: string;
  notes: string;
};

export type PolicyValidation =
  | { ok: true; message: string; policy: Record<string, unknown> }
  | { ok: false; message: string; policy: null };

function toBool(v: string | boolean): boolean {
  return v === true || ["1", "true", "yes", "on", "bật"].includes(String(v).trim().toLowerCase());
}

/**
 * Kiểm tra form guardrail. RPC có CHECK ở bảng (sai là nổ), nhưng bắt ở đây để
 * người dùng nhận lý do tiếng Việt thay vì "23514 check constraint".
 */
export function validatePolicyDraft(draft: PolicyDraft): PolicyValidation {
  const autoApply = toBool(draft.autoApply);
  const requireApprovalState = toBool(draft.requireApprovalState);
  const maxBid = num(draft.maxBidChangePct);
  const maxBudget = num(draft.maxBudgetChangePct);
  const bidFloor = num(draft.bidFloor);
  const bidCeiling = num(draft.bidCeiling);
  const budgetFloor = num(draft.budgetFloor);
  const budgetCeiling = num(draft.budgetCeiling);
  const cap = int(draft.dailyChangeCap);
  const maxOpen = int(draft.maxOpenRequests);
  const ttl = int(draft.proposalTtlHours);
  const step = num(draft.bidStepPct);

  if (maxBid === null || maxBid <= 0 || maxBid > 100) {
    return { ok: false, message: "% thay đổi bid tối đa phải từ 0 đến 100.", policy: null };
  }
  if (maxBudget === null || maxBudget <= 0 || maxBudget > 500) {
    return { ok: false, message: "% thay đổi ngân sách tối đa phải từ 0 đến 500.", policy: null };
  }
  if (bidFloor !== null && bidCeiling !== null && bidFloor > bidCeiling) {
    return { ok: false, message: `Sàn bid (${bidFloor}) đang lớn hơn trần (${bidCeiling}).`, policy: null };
  }
  if (budgetFloor !== null && budgetCeiling !== null && budgetFloor > budgetCeiling) {
    return { ok: false, message: `Sàn ngân sách (${budgetFloor}) đang lớn hơn trần (${budgetCeiling}).`, policy: null };
  }
  if (bidFloor !== null && bidFloor < 0) return { ok: false, message: "Sàn bid không thể âm.", policy: null };
  if (budgetFloor !== null && budgetFloor < 0) return { ok: false, message: "Sàn ngân sách không thể âm.", policy: null };
  if (cap === null || cap < 1 || cap > 500) {
    return { ok: false, message: "Trần thay đổi mỗi ngày phải từ 1 đến 500.", policy: null };
  }
  if (maxOpen === null || maxOpen < 1 || maxOpen > 2000) {
    return { ok: false, message: "Trần đề xuất đang mở phải từ 1 đến 2000.", policy: null };
  }
  if (ttl === null || ttl < 1 || ttl > 720) {
    return { ok: false, message: "Hạn duyệt đề xuất (giờ) phải từ 1 đến 720.", policy: null };
  }
  if (step !== null && (step < 0 || step > 100)) {
    return { ok: false, message: "Bước bid của gợi ý (%) phải từ 0 đến 100.", policy: null };
  }
  const currency = String(draft.currency ?? "USD").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    return { ok: false, message: "Tiền tệ phải là mã 3 chữ (USD, VND, EUR…).", policy: null };
  }

  const policy: Record<string, unknown> = {
    auto_apply: autoApply,
    require_approval_state: requireApprovalState,
    max_bid_change_pct: maxBid,
    max_budget_change_pct: maxBudget,
    daily_change_cap: cap,
    max_open_requests: maxOpen,
    proposal_ttl_hours: ttl,
    currency,
  };
  // null = "bỏ ràng buộc" → phải GỬI khoá để RPC xoá, không phải bỏ qua khoá.
  policy.bid_floor = bidFloor;
  policy.bid_ceiling = bidCeiling;
  policy.budget_floor = budgetFloor;
  policy.budget_ceiling = budgetCeiling;
  if (step !== null) policy.bid_step_pct = step;
  const notes = String(draft.notes ?? "").trim();
  policy.notes = notes === "" ? null : notes;

  return {
    ok: true,
    message: autoApply
      ? `Đã lưu guardrail — AUTO_APPLY đang BẬT: thay đổi trong ±${maxBid}% bid / ±${maxBudget}% ngân sách sẽ tự duyệt. Cron vẫn phải đọc lại Amazon trước khi ghi.`
      : `Đã lưu guardrail — mọi thay đổi đều cần người duyệt (auto_apply tắt).`,
    policy,
  };
}

/** Guardrail hiện hành → chữ người đọc được (UI không tự ghép luật). */
export function policyGuardLines(policy: PpcPolicy): string[] {
  const lines: string[] = [];
  lines.push(
    policy.autoApply
      ? `AUTO_APPLY BẬT: thay đổi trong ±${policy.maxBidChangePct ?? "?"}% bid / ±${policy.maxBudgetChangePct ?? "?"}% ngân sách được tự duyệt (vẫn ghi audit + cron vẫn đối chiếu Amazon).`
      : "AUTO_APPLY TẮT: mọi đề xuất đều chờ người duyệt.",
  );
  lines.push(
    `Bid ${policy.bidFloor ?? "không sàn"} … ${policy.bidCeiling ?? "không trần"} ${policy.currency} · Ngân sách ngày ${
      policy.budgetFloor ?? "không sàn"
    } … ${policy.budgetCeiling ?? "không trần"} ${policy.currency} — ngoài khoảng này là CHẶN, không sinh đề xuất.`,
  );
  lines.push(
    `Trần ${policy.dailyChangeCap ?? "?"} thay đổi/ngày (hôm nay đã áp dụng ${policy.appliedToday}, còn ${policy.capLeftToday}) · Tối đa ${
      policy.maxOpenRequests ?? "?"
    } đề xuất mở (đang mở ${policy.openCount}).`,
  );
  lines.push(
    `Đề xuất hết hạn sau ${policy.proposalTtlHours ?? "?"} giờ — quá hạn thì cron KHÔNG áp dụng (số liệu cũ), phải sinh lại từ dữ liệu mới.`,
  );
  lines.push(
    policy.requireApprovalState
      ? "Bật/tắt campaign, keyword, ad group LUÔN cần người duyệt."
      : "Bật/tắt có thể tự duyệt khi auto_apply bật (cẩn thận: tắt nhầm campaign là mất doanh thu).",
  );
  return lines;
}

/* ------------------------------------------------------------------ */
/* Gom nhóm / hiển thị                                                 */
/* ------------------------------------------------------------------ */

export type PpcQueueStats = {
  proposed: number;
  approved: number;
  applying: number;
  applied: number;
  failed: number;
  skipped: number;
  rejected: number;
  expired: number;
  total: number;
};

export function queueStats(requests: PpcRequest[]): PpcQueueStats {
  const stats: PpcQueueStats = {
    proposed: 0,
    approved: 0,
    applying: 0,
    applied: 0,
    failed: 0,
    skipped: 0,
    rejected: 0,
    expired: 0,
    total: requests.length,
  };
  const keys: (keyof PpcQueueStats)[] = [
    "proposed","approved","applying","applied","failed","skipped","rejected","expired",
  ];
  for (const r of requests) {
    if (keys.includes(r.status as keyof PpcQueueStats)) stats[r.status as keyof PpcQueueStats] += 1;
  }
  return stats;
}

const REQUEST_TONE: Record<string, "red" | "amber" | "green" | "gray" | "blue"> = {
  proposed: "amber",
  approved: "blue",
  applying: "blue",
  applied: "green",
  failed: "red",
  skipped: "gray",
  rejected: "gray",
  expired: "gray",
};

export function requestStatusTone(status: string): "red" | "amber" | "green" | "gray" | "blue" {
  return REQUEST_TONE[status] ?? "gray";
}

const SUGGESTION_TONE: Record<string, "red" | "amber" | "green" | "gray" | "blue"> = {
  negative_keyword: "red",
  pause_keyword: "red",
  pause_campaign: "amber",
  lower_bid: "amber",
  raise_budget: "green",
};

export function suggestionTone(kind: string): "red" | "amber" | "green" | "gray" | "blue" {
  return SUGGESTION_TONE[kind] ?? "gray";
}

/** Hàng đợi duyệt: còn quyết định được, cũ nhất trước (chờ lâu = dễ hết hạn). */
export function pendingApproval(requests: PpcRequest[]): PpcRequest[] {
  return requests
    .filter((r) => r.status === "proposed" && !r.expired)
    .sort((a, b) => (b.ageHours ?? 0) - (a.ageHours ?? 0));
}

/** Đã duyệt nhưng cron chưa chạy — người xem cần biết "đang nằm ở đâu". */
export function waitingForCron(requests: PpcRequest[]): PpcRequest[] {
  return requests
    .filter((r) => r.status === "approved" || r.status === "applying")
    .sort((a, b) => (a.decidedAt ?? "").localeCompare(b.decidedAt ?? ""));
}

/** Kết quả gần đây (applied/failed/skipped) — mới nhất trước. */
export function recentResults(requests: PpcRequest[], limit = 25): PpcRequest[] {
  return requests
    .filter((r) => r.status === "applied" || r.status === "failed" || r.status === "skipped" || r.status === "expired")
    .sort((a, b) => (b.appliedAt ?? b.decidedAt ?? "").localeCompare(a.appliedAt ?? a.decidedAt ?? ""))
    .slice(0, limit);
}

export function groupSuggestions(suggestions: PpcSuggestion[]): {
  kind: string;
  kindLabel: string;
  priority: number;
  items: PpcSuggestion[];
}[] {
  const byKind = new Map<string, PpcSuggestion[]>();
  for (const s of suggestions) {
    const list = byKind.get(s.kind) ?? [];
    list.push(s);
    byKind.set(s.kind, list);
  }
  return [...byKind.entries()]
    .map(([kind, items]) => ({
      kind,
      kindLabel: items[0]?.kindLabel ?? kind,
      priority: Math.min(...items.map((i) => i.priority)),
      items: items.sort((a, b) => b.waste7 - a.waste7 || b.spend7 - a.spend7),
    }))
    .sort((a, b) => a.priority - b.priority || b.items[0].waste7 - a.items[0].waste7);
}

/** Vì sao không có gì để áp dụng — nói thẳng, không để người dùng đoán. */
export function writeEmptyReason(input: {
  mode: "supabase" | "demo";
  suggestions: number;
  requests: number;
  policies: number;
  writeEnabled: boolean;
  partialErrors: string[];
}): { title: string; lines: string[] } | null {
  const lines: string[] = [];
  if (input.mode === "demo") {
    return {
      title: "Chưa nối Supabase — chiều ghi PPC không hoạt động",
      lines: [
        "Mọi đề xuất/duyệt đều ghi vào ads.change_requests nên bắt buộc có Supabase.",
        "Cấu hình NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (cho cron) rồi chạy migration 0021.",
      ],
    };
  }
  if (input.partialErrors.length > 0) lines.push(`Một phần dữ liệu chưa đọc được: ${input.partialErrors[0]}`);
  if (input.policies === 0) {
    lines.push("Chưa thấy shop nào trong vexim_ppc_policies — kiểm tra quyền đọc shop (module ads, assignment can_read).");
  }
  if (input.suggestions === 0) {
    lines.push(
      "Chưa có gợi ý nào: cần ads-sync nhập search term + targeting + metrics (report spSearchTerm, spTargeting, spCampaigns) và phải có spend thật trong 7 ngày.",
    );
  }
  if (input.requests === 0 && input.suggestions > 0) {
    lines.push("Có gợi ý nhưng chưa ai tạo đề xuất — chọn dòng ở trên rồi bấm “Tạo đề xuất”.");
  }
  if (!input.writeEnabled) {
    lines.push(
      "Cron chưa được phép ghi: ADS_WRITE_ENABLED chưa bật trên Vercel → đề xuất đã duyệt vẫn nằm chờ, không có gì được gửi lên Amazon.",
    );
  }
  return lines.length > 0 ? { title: "Chưa có gì để áp dụng", lines } : null;
}

/** Số tiền hiển thị theo tiền tệ của dòng (không cộng khác tiền tệ). */
export function money(value: number | null, currency: string | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "−" : "";
  const abs = Math.abs(value);
  const text = abs >= 1000 ? abs.toLocaleString("en-US", { maximumFractionDigits: 0 }) : abs.toFixed(2);
  return `${sign}${text}${currency ? ` ${currency}` : ""}`;
}

export function signedPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
}
