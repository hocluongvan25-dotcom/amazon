/**
 * Test model của khối GHI PPC phía UI (Module 5 Phần 2&3).
 *
 * Tầng này là "người gác cổng thứ nhất": RPC trong 0021 cũng chặn y hệt, nhưng nếu
 * UI chặn trước thì người vận hành thấy lý do bằng tiếng Việt theo TỪNG DÒNG thay vì
 * một lỗi 500. Vì vậy mọi luật ở đây phải khớp luật trong migration:
 *   • sàn/trần là CHẶN HẲN · quá % tối đa là CẦN DUYỆT · giá trị bằng nhau là TRÙNG
 *   • thiếu before_value → luôn cần duyệt (không ai được tự duyệt một con số chưa biết)
 *   • negative keyword: NEGATIVE_EXACT/NEGATIVE_PHRASE, cấp ad group cần ad_group_id
 *   • guardrail vô nghĩa (sàn > trần, cap ≤ 0) → không cho lưu
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALLOWED_PAIRS,
  NEGATIVE_MATCH_LABEL,
  PPC_NEGATIVE_SELECT,
  PPC_POLICY_SELECT,
  PPC_REQUEST_SELECT,
  PPC_SUGGESTION_SELECT,
  buildProposalPayload,
  checkNumberChange,
  groupSuggestions,
  isAllowedPair,
  mapPpcNegative,
  mapPpcPolicy,
  mapPpcRequest,
  mapPpcSuggestion,
  money,
  normalizeMatchType,
  normalizeState,
  pendingApproval,
  policyGuardLines,
  proposalItemFromSuggestion,
  queueStats,
  recentResults,
  requestStatusTone,
  roundMoney,
  signedPct,
  suggestionTone,
  validateNegativeDraft,
  validatePolicyDraft,
  validateProposalItems,
  waitingForCron,
  writeEmptyReason,
  type PpcNegative,
  type PpcPolicy,
  type PpcProposalItem,
  type PpcRequest,
  type PpcSuggestion,
} from "../src/lib/data/ppc-write-model.ts";

const SHOP = "aaaaaaaa-1111-4111-8111-111111111111";

function policy(over: Partial<PpcPolicy> = {}): PpcPolicy {
  return {
    shopId: SHOP,
    shop: "A1 · US",
    marketplace: "ATVPDKIKX0DER",
    hasPolicyRow: true,
    autoApply: false,
    requireApprovalState: true,
    maxBidChangePct: 20,
    maxBudgetChangePct: 30,
    bidFloor: 0.2,
    bidCeiling: 3,
    budgetFloor: 5,
    budgetCeiling: 200,
    dailyChangeCap: 50,
    maxOpenRequests: 100,
    proposalTtlHours: 72,
    suggestionMinClicks: 3,
    suggestionMinSpend: 1,
    suggestionAcosLowerPct: 50,
    bidStepPct: 15,
    currency: "USD",
    notes: null,
    policyUpdatedAt: "2026-09-10T00:00:00Z",
    proposedCount: 2,
    approvedCount: 1,
    applyingCount: 0,
    appliedToday: 3,
    failed24h: 0,
    openCount: 3,
    capLeftToday: 47,
    canEditPolicy: true,
    ...over,
  };
}

function suggestion(over: Partial<PpcSuggestion> = {}): PpcSuggestion {
  return {
    shopId: SHOP,
    shop: "A1 · US",
    kind: "lower_bid",
    kindLabel: "Hạ bid keyword ACOS cao",
    priority: 3,
    suggestionKey: "bid|KW1",
    entityType: "keyword",
    changeType: "bid",
    campaignId: "C1",
    campaignName: "SP main",
    adGroupId: "AG1",
    adGroupName: "Ad group 1",
    amazonEntityId: "KW1",
    label: "mat ong",
    matchType: null,
    keywordType: "BROAD",
    currency: "USD",
    beforeValue: { bid: 1.2 },
    afterValue: { bid: 1.02 },
    currentNumber: 1.2,
    proposedNumber: 1.02,
    deltaPct: -15,
    impressions7: 900,
    clicks7: 12,
    spend7: 14.4,
    sales7: 6,
    adOrders7: 1,
    acos7: 240,
    acosTarget: 25,
    waste7: 8.4,
    daysWithData: 6,
    windowEnd: "2026-09-12",
    reason: "ACOS 7 ngày 240% vượt ngưỡng 25%",
    requiresApproval: true,
    hasOpenRequest: false,
    canDecide: true,
    canPropose: true,
    ...over,
  };
}

function request(over: Partial<PpcRequest> = {}): PpcRequest {
  return {
    id: "r1",
    shopId: SHOP,
    shop: "A1 · US",
    adsProfileId: "111",
    entityType: "keyword",
    changeType: "bid",
    amazonEntityId: "KW1",
    campaignId: "C1",
    campaignName: "SP main",
    campaignType: "SP",
    adGroupId: "AG1",
    label: "mat ong",
    matchType: null,
    currency: "USD",
    beforeValue: { bid: 1.2 },
    afterValue: { bid: 1.02 },
    beforeNumber: 1.2,
    afterNumber: 1.02,
    deltaPct: -15,
    deltaLabel: "-15%",
    summary: "Bid 1.20 → 1.02 USD (-15%)",
    entityLabel: "Keyword",
    requiresApproval: true,
    reason: "ACOS cao",
    source: "suggestion",
    suggestionKey: "bid|KW1",
    status: "proposed",
    statusLabel: "Chờ duyệt",
    isOpen: true,
    isTerminal: false,
    batchId: null,
    proposedBy: "u1",
    proposedByName: "Lan",
    proposedAt: "2026-09-13T01:00:00Z",
    ageHours: 3.4,
    decidedBy: null,
    decidedByName: null,
    decidedAt: null,
    decisionNote: null,
    expiresAt: "2026-09-16T01:00:00Z",
    expiresInHours: 68.6,
    expired: false,
    attempts: 0,
    appliedAt: null,
    lastError: null,
    amazonResponse: null,
    canDecide: true,
    isMine: false,
    ...over,
  };
}

function negative(over: Partial<PpcNegative> = {}): PpcNegative {
  return {
    id: "n1",
    shopId: SHOP,
    shop: "A1 · US",
    campaignId: "C1",
    campaignName: "SP main",
    adGroupId: "AG1",
    adGroupName: "Ad group 1",
    level: "ad_group",
    keywordText: "free sample",
    keywordNorm: "free sample",
    matchType: "NEGATIVE_EXACT",
    matchLabel: NEGATIVE_MATCH_LABEL.NEGATIVE_EXACT,
    amazonNegativeId: "NK1",
    state: "ENABLED",
    source: "vexim",
    changeRequestId: "r9",
    requestStatus: "applied",
    createdAt: "2026-09-12T00:00:00Z",
    lastSyncedAt: "2026-09-12T04:00:00Z",
    ...over,
  };
}

/* ================================================================== */
/* 1. Hợp đồng cột — web đọc bằng select cố định                      */
/* ================================================================== */

test("SELECT của 4 view khớp hợp đồng cột đã chốt trong supabase/tests/run-migrations.mjs", () => {
  assert.equal(
    PPC_POLICY_SELECT,
    "seller_account_id,shop,marketplace,shop_status,has_policy_row,auto_apply,require_approval_state," +
      "max_bid_change_pct,max_budget_change_pct,bid_floor,bid_ceiling,budget_floor,budget_ceiling," +
      "daily_change_cap,max_open_requests,proposal_ttl_hours,suggestion_min_clicks,suggestion_min_spend," +
      "suggestion_acos_lower_pct,bid_step_pct,currency,notes,policy_updated_at,proposed_count," +
      "approved_count,applying_count,applied_today,failed_24h,open_count,cap_left_today,can_edit_policy",
  );
  assert.equal(
    PPC_REQUEST_SELECT,
    "id,seller_account_id,shop,ads_profile_id,entity_type,change_type,amazon_entity_id,campaign_id," +
      "campaign_name,campaign_type,ad_group_id,label,match_type,currency,before_value,after_value," +
      "before_number,after_number,delta_pct,delta_label,summary,entity_label,requires_approval,reason," +
      "source,suggestion_key,status,status_label,is_open,is_terminal,batch_id,proposed_by," +
      "proposed_by_name,proposed_at,age_hours,decided_by,decided_by_name,decided_at,decision_note," +
      "expires_at,expires_in_hours,expired,attempts,applied_at,last_error,amazon_response," +
      "can_decide,is_mine",
  );
  assert.equal(
    PPC_SUGGESTION_SELECT,
    "seller_account_id,shop,kind,priority,suggestion_key,entity_type,change_type,campaign_id," +
      "campaign_name,ad_group_id,ad_group_name,amazon_entity_id,label,match_type,keyword_type," +
      "currency,before_value,after_value,current_number,proposed_number,delta_pct,impressions7," +
      "clicks7,spend7,sales7,ad_orders7,acos7,acos_target,waste7,days_with_data,window_end,reason," +
      "requires_approval,has_open_request,kind_label,can_decide,can_propose",
  );
  assert.equal(
    PPC_NEGATIVE_SELECT,
    "id,seller_account_id,shop,ads_profile_id,campaign_id,campaign_name,ad_group_id,ad_group_name," +
      "level,keyword_text,keyword_norm,match_type,match_label,amazon_negative_id,state,source," +
      "change_request_id,request_status,created_at,last_synced_at",
  );
});

test("SELECT không trùng cột, không tiền tố schema, không khoảng trắng thừa", () => {
  for (const [name, select] of Object.entries({
    PPC_POLICY_SELECT,
    PPC_REQUEST_SELECT,
    PPC_SUGGESTION_SELECT,
    PPC_NEGATIVE_SELECT,
  })) {
    const cols = select.split(",");
    assert.equal(new Set(cols).size, cols.length, `${name} có cột trùng`);
    assert.equal(cols.some((c) => c.includes(".")), false, `${name} không được có tiền tố schema`);
    assert.equal(cols.some((c) => c !== c.trim() || c === ""), false, `${name} có khoảng trắng thừa`);
    assert.equal(cols.some((c) => c === "*"), false, `${name} không được select * (đổi view là vỡ âm thầm)`);
  }
});

/* ================================================================== */
/* 2. Mapper                                                          */
/* ================================================================== */

test("mapPpcPolicy: numeric/boolean từ PostgREST (chuỗi '20.00', 'true') → số/bool thật", () => {
  const p = mapPpcPolicy({
    seller_account_id: SHOP,
    shop: "A1 · US",
    marketplace: "ATVPDKIKX0DER",
    shop_status: "active",
    has_policy_row: "true",
    auto_apply: "false",
    require_approval_state: "true",
    max_bid_change_pct: "20.00",
    max_budget_change_pct: "30.00",
    bid_floor: "0.20",
    bid_ceiling: null,
    budget_floor: null,
    budget_ceiling: "200.00",
    daily_change_cap: "50",
    max_open_requests: "100",
    proposal_ttl_hours: "72",
    suggestion_min_clicks: "3",
    suggestion_min_spend: "1.00",
    suggestion_acos_lower_pct: "50.00",
    bid_step_pct: "15.00",
    currency: "USD",
    notes: "thử nghiệm",
    policy_updated_at: "2026-09-10T00:00:00Z",
    proposed_count: "2",
    approved_count: "1",
    applying_count: "0",
    applied_today: "3",
    failed_24h: "1",
    open_count: "3",
    cap_left_today: "47",
    can_edit_policy: "false",
  } as never);
  assert.equal(p.maxBidChangePct, 20);
  assert.equal(p.bidCeiling, null, "trần null = không chặn, không được suy ra 0");
  assert.equal(p.autoApply, false);
  assert.equal(p.requireApprovalState, true);
  assert.equal(p.canEditPolicy, false);
  assert.equal(p.capLeftToday, 47);
  assert.equal(p.failed24h, 1);
});

test("mapPpcPolicy: requireApprovalState mặc định BẬT khi DB trả null (an toàn hơn)", () => {
  const p = mapPpcPolicy({ seller_account_id: SHOP, require_approval_state: null } as never);
  assert.equal(p.requireApprovalState, true);
});

test("mapPpcRequest: jsonb trước/sau thành object, numeric thành số, cờ quyền giữ nguyên", () => {
  const r = mapPpcRequest({
    id: "r1",
    seller_account_id: SHOP,
    shop: "A1 · US",
    ads_profile_id: "",
    entity_type: "negative_keyword",
    change_type: "create",
    amazon_entity_id: "",
    campaign_id: "C1",
    campaign_name: "SP main",
    campaign_type: "SP",
    ad_group_id: "AG1",
    label: "free sample",
    match_type: "NEGATIVE_EXACT",
    currency: "USD",
    before_value: null,
    after_value: { keyword_text: "free sample", match_type: "NEGATIVE_EXACT" },
    before_number: null,
    after_number: null,
    delta_pct: null,
    delta_label: null,
    summary: 'Phủ định "free sample" (NEGATIVE_EXACT) cấp ad group',
    entity_label: "Negative keyword (ad group)",
    requires_approval: "true",
    reason: "12 click 0 đơn",
    source: "suggestion",
    suggestion_key: "neg|C1|AG1|free sample",
    status: "proposed",
    status_label: "Chờ duyệt",
    is_open: "true",
    is_terminal: "false",
    batch_id: null,
    proposed_by: "u1",
    proposed_by_name: "Lan",
    proposed_at: "2026-09-13T01:00:00Z",
    age_hours: "3.40",
    decided_by: null,
    decided_by_name: null,
    decided_at: null,
    decision_note: null,
    expires_at: "2026-09-16T01:00:00Z",
    expires_in_hours: "68.60",
    expired: "false",
    attempts: "0",
    applied_at: null,
    last_error: null,
    amazon_response: null,
    can_decide: "true",
    is_mine: "false",
  } as never);
  assert.equal(r.adsProfileId, null, "chuỗi rỗng → null (worker tự chốt profile)");
  assert.equal(r.beforeValue, null);
  assert.deepEqual(r.afterValue, { keyword_text: "free sample", match_type: "NEGATIVE_EXACT" });
  assert.equal(r.ageHours, 3.4);
  assert.equal(r.expiresInHours, 68.6);
  assert.equal(r.canDecide, true);
  assert.equal(r.isMine, false);
  assert.equal(r.entityType, "negative_keyword");
});

test("mapPpcSuggestion + mapPpcNegative: đủ nhãn cho UI, level suy ra từ ad_group_id", () => {
  const s = mapPpcSuggestion({
    seller_account_id: SHOP,
    shop: "A1 · US",
    kind: "negative_keyword",
    priority: "1",
    suggestion_key: "neg|C1",
    entity_type: "campaign_negative_keyword",
    change_type: "create",
    campaign_id: "C1",
    campaign_name: "SP main",
    ad_group_id: "",
    ad_group_name: null,
    amazon_entity_id: "",
    label: "free sample",
    match_type: "NEGATIVE_EXACT",
    keyword_type: null,
    currency: "USD",
    before_value: null,
    after_value: { keyword_text: "free sample", match_type: "NEGATIVE_EXACT" },
    current_number: null,
    proposed_number: null,
    delta_pct: null,
    impressions7: "800",
    clicks7: "11",
    spend7: "8.40",
    sales7: "0.00",
    ad_orders7: "0",
    acos7: null,
    acos_target: "25.00",
    waste7: "8.40",
    days_with_data: "5",
    window_end: "2026-09-12",
    reason: "11 click, 0 đơn — đốt 8.40 USD",
    requires_approval: "true",
    has_open_request: "false",
    kind_label: "Phủ định search term đốt tiền",
    can_decide: "true",
    can_propose: "true",
  } as never);
  assert.equal(s.waste7, 8.4);
  assert.equal(s.acos7, null, "0 đơn thì ACOS là null, không phải 0%");
  assert.equal(s.kindLabel, "Phủ định search term đốt tiền");
  assert.equal(s.canPropose, true);

  const n = mapPpcNegative({ id: "n1", seller_account_id: SHOP, campaign_id: "C1", ad_group_id: "", keyword_text: "  Cheap  ", match_type: "NEGATIVE_PHRASE" } as never);
  assert.equal(n.level, "campaign", "ad_group_id rỗng → cấp campaign");
  assert.equal(n.keywordNorm, "cheap", "chuẩn hoá để so trùng không phân biệt hoa/thường");
  assert.equal(n.matchLabel, NEGATIVE_MATCH_LABEL.NEGATIVE_PHRASE, "thiếu nhãn từ view thì tự dịch, không để ô trống");
});

/* ================================================================== */
/* 3. Chuẩn hoá đầu vào                                               */
/* ================================================================== */

test("normalizeMatchType: nhận cách viết thường gặp, KHÔNG đoán khi lạ", () => {
  assert.equal(normalizeMatchType("exact"), "NEGATIVE_EXACT");
  assert.equal(normalizeMatchType("NEGATIVE PHRASE"), "NEGATIVE_PHRASE");
  assert.equal(normalizeMatchType("negative-phrase"), "NEGATIVE_PHRASE");
  assert.equal(normalizeMatchType(""), "NEGATIVE_EXACT", "để trống = chính xác (an toàn hơn phủ định cả cụm)");
  assert.equal(normalizeMatchType("broad"), null);
  assert.equal(normalizeMatchType(null), "NEGATIVE_EXACT");
});

test("normalizeState: chỉ 3 trạng thái Amazon hiểu", () => {
  assert.equal(normalizeState("paused"), "PAUSED");
  assert.equal(normalizeState("ENABLED"), "ENABLED");
  assert.equal(normalizeState("tắt"), "PAUSED");
  assert.equal(normalizeState("STOPPED"), null);
  assert.equal(normalizeState(""), null);
});

test("isAllowedPair: đúng 5 cặp entity × change mà cả RPC lẫn Amazon hỗ trợ", () => {
  assert.equal(isAllowedPair("campaign", "budget"), true);
  assert.equal(isAllowedPair("campaign", "bid"), false);
  assert.equal(isAllowedPair("keyword", "bid"), true);
  assert.equal(isAllowedPair("keyword", "budget"), false);
  assert.equal(isAllowedPair("ad_group", "state"), true);
  assert.equal(isAllowedPair("negative_keyword", "create"), true);
  assert.equal(isAllowedPair("campaign_negative_keyword", "create"), true);
  assert.equal(isAllowedPair("target", "bid"), false, "chưa mở target — không được tự cho phép");
  assert.equal(ALLOWED_PAIRS.length, 5);
});

/* ================================================================== */
/* 4. Guardrail áp lên MỘT thay đổi số                                */
/* ================================================================== */

test("checkNumberChange: ngoài sàn/trần là CHẶN (không sinh đề xuất)", () => {
  const low = checkNumberChange({ changeType: "bid", before: 1.2, after: 0.05, policy: policy() });
  assert.equal(low.outOfRange, true);
  assert.match(low.message ?? "", /sàn\/trần/);

  const high = checkNumberChange({ changeType: "budget", before: 25, after: 500, policy: policy() });
  assert.equal(high.outOfRange, true);
  assert.match(high.message ?? "", /5 … 200/);

  const bad = checkNumberChange({ changeType: "bid", before: 1.2, after: "abc", policy: policy() });
  assert.equal(bad.outOfRange, true);
  assert.match(bad.message ?? "", /số dương/);
});

test("checkNumberChange: quá % tối đa → vẫn gửi được nhưng BẮT BUỘC duyệt", () => {
  const out = checkNumberChange({ changeType: "bid", before: 1, after: 2, policy: policy({ autoApply: true }) });
  assert.equal(out.outOfRange, false);
  assert.equal(out.exceedsMaxPct, true);
  assert.equal(out.deltaPct, 100);
  assert.equal(out.requiresApproval, true, "auto_apply cũng không được tự đổi bid gấp đôi");
  assert.match(out.message ?? "", /vượt mức tự động 20%/);
});

test("checkNumberChange: trong ngưỡng + auto_apply → không cần duyệt; thiếu before → LUÔN cần duyệt", () => {
  const within = checkNumberChange({ changeType: "bid", before: 1.2, after: 1.02, policy: policy({ autoApply: true }) });
  assert.equal(within.requiresApproval, false);
  assert.equal(within.deltaPct, -15);

  const noAuto = checkNumberChange({ changeType: "bid", before: 1.2, after: 1.02, policy: policy({ autoApply: false }) });
  assert.equal(noAuto.requiresApproval, true, "auto_apply tắt thì mọi thay đổi cần người ký");

  const unknown = checkNumberChange({ changeType: "budget", before: null, after: 30, policy: policy({ autoApply: true }) });
  assert.equal(unknown.unknownBefore, true);
  assert.equal(unknown.requiresApproval, true);
  assert.match(unknown.message ?? "", /Chưa biết/);
});

test("checkNumberChange: giá trị mới bằng giá trị cũ → trùng, không tạo việc cho người duyệt", () => {
  const same = checkNumberChange({ changeType: "bid", before: 1.2, after: 1.2, policy: policy() });
  assert.equal(same.noChange, true);
  assert.match(same.message ?? "", /không có gì để đổi/);
});

/* ================================================================== */
/* 5. Validate cả lô đề xuất                                          */
/* ================================================================== */

test("validateProposalItems: rỗng / quá 500 / quá trần đề xuất mở → không gửi", () => {
  assert.equal(validateProposalItems([], policy()).ok, false);
  const many = Array.from({ length: 501 }, (_, i) => ({
    entity_type: "keyword" as const,
    change_type: "bid" as const,
    amazon_entity_id: `K${i}`,
    after_value: { bid: 1 },
    before_value: { bid: 1.1 },
  }));
  const tooMany = validateProposalItems(many as PpcProposalItem[], policy());
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.message, /500/);

  const full = validateProposalItems([proposalItemFromSuggestion(suggestion())], policy({ openCount: 100, maxOpenRequests: 100 }));
  assert.equal(full.ok, false);
  assert.match(full.message, /vượt trần 100/);
});

test("proposalItemFromSuggestion: giữ đủ id + before/after + suggestion_key để RPC không tính lại", () => {
  const item = proposalItemFromSuggestion(suggestion());
  assert.equal(item.entity_type, "keyword");
  assert.equal(item.change_type, "bid");
  assert.equal(item.amazon_entity_id, "KW1");
  assert.equal(item.campaign_id, "C1");
  assert.equal(item.ad_group_id, "AG1");
  assert.equal(item.suggestion_key, "bid|KW1");
  assert.deepEqual(item.before_value, { bid: 1.2 });
  assert.deepEqual(item.after_value, { bid: 1.02 });
  assert.equal(item.currency, "USD");

  const neg = proposalItemFromSuggestion(
    suggestion({ kind: "negative_keyword", entityType: "campaign_negative_keyword", changeType: "create", amazonEntityId: "", adGroupId: "", matchType: "NEGATIVE_EXACT" }),
  );
  assert.equal("amazon_entity_id" in neg, false, "đề xuất tạo mới không có id Amazon");
  assert.equal(neg.match_type, "NEGATIVE_EXACT");
});

test("validateProposalItems: cặp lạ / thiếu id Amazon → blocked, không gửi dòng đó", () => {
  const out = validateProposalItems(
    [
      { entity_type: "target" as never, change_type: "bid" as never, amazon_entity_id: "T1", after_value: { bid: 1 } },
      { entity_type: "keyword", change_type: "bid", after_value: { bid: 1 }, before_value: { bid: 1.1 } },
    ] as PpcProposalItem[],
    policy(),
  );
  assert.equal(out.items.length, 0);
  assert.equal(out.ok, false);
  assert.equal(out.warnings.filter((w) => w.kind === "blocked").length, 2);
  assert.match(out.warnings[0].message, /không hỗ trợ/);
  assert.match(out.warnings[1].message, /thiếu id Amazon/);
});

test("validateProposalItems: bid ngoài sàn/trần bị chặn, bid hợp lệ được làm tròn 2 chữ số", () => {
  const out = validateProposalItems(
    [
      { entity_type: "keyword", change_type: "bid", amazon_entity_id: "K1", before_value: { bid: 1.2 }, after_value: { bid: 0.01 } },
      { entity_type: "keyword", change_type: "bid", amazon_entity_id: "K2", before_value: { bid: 1.2 }, after_value: { bid: 1.005 } },
    ] as PpcProposalItem[],
    policy(),
  );
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].after_value?.bid, 1.01, "làm tròn để Amazon không từ chối");
  assert.match(out.warnings.find((w) => w.kind === "blocked")?.message ?? "", /sàn\/trần/);
});

test("validateProposalItems: negative trùng trong danh sách hiện có → duplicate (không gọi Amazon tạo lỗi)", () => {
  const item: PpcProposalItem = {
    entity_type: "negative_keyword",
    change_type: "create",
    campaign_id: "C1",
    ad_group_id: "AG1",
    label: "Free Sample",
    match_type: "negative exact",
    after_value: {},
  };
  const out = validateProposalItems([item], policy(), { negatives: [negative()] });
  assert.equal(out.ok, false);
  assert.equal(out.warnings[0].kind, "duplicate");
  assert.match(out.warnings[0].message, /ĐÃ được phủ định/);

  const fresh = validateProposalItems([{ ...item, label: "cheap stuff" }], policy(), { negatives: [negative()] });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.items[0].match_type, "NEGATIVE_EXACT", "chuẩn hoá match_type trước khi gửi");
  assert.deepEqual(fresh.items[0].after_value, {
    keyword_text: "cheap stuff",
    match_type: "NEGATIVE_EXACT",
    campaign_id: "C1",
    ad_group_id: "AG1",
    level: "ad_group",
  });
});

test("validateProposalItems: negative cấp campaign bỏ ad_group_id; cấp ad group thiếu id thì chặn", () => {
  const campaignLevel = validateProposalItems(
    [{ entity_type: "campaign_negative_keyword", change_type: "create", campaign_id: "C1", ad_group_id: "AG1", label: "cheap", match_type: "NEGATIVE_PHRASE", after_value: {} }] as PpcProposalItem[],
    policy(),
  );
  assert.equal(campaignLevel.ok, true);
  assert.equal(campaignLevel.items[0].ad_group_id, "");
  assert.equal(campaignLevel.items[0].after_value?.level, "campaign");

  const missing = validateProposalItems(
    [{ entity_type: "negative_keyword", change_type: "create", campaign_id: "C1", label: "cheap", after_value: {} }] as PpcProposalItem[],
    policy(),
  );
  assert.equal(missing.ok, false);
  assert.match(missing.warnings[0].message, /cần ad_group_id/);

  const badMatch = validateProposalItems(
    [{ entity_type: "negative_keyword", change_type: "create", campaign_id: "C1", ad_group_id: "AG1", label: "cheap", match_type: "broad", after_value: {} }] as PpcProposalItem[],
    policy(),
  );
  assert.equal(badMatch.ok, false);
  assert.match(badMatch.warnings[0].message, /NEGATIVE_EXACT \/ NEGATIVE_PHRASE/);
});

test("validateProposalItems: state chuẩn hoá + trùng trạng thái hiện tại là duplicate", () => {
  const out = validateProposalItems(
    [{ entity_type: "campaign", change_type: "state", amazon_entity_id: "C1", before_value: { state: "ENABLED" }, after_value: { state: "paused" } }] as PpcProposalItem[],
    policy(),
  );
  assert.equal(out.ok, true);
  assert.equal(out.items[0].after_value?.state, "PAUSED");
  assert.ok(out.warnings.some((w) => w.kind === "approval" && /luôn cần người duyệt/.test(w.message)));

  const same = validateProposalItems(
    [{ entity_type: "campaign", change_type: "state", amazon_entity_id: "C1", before_value: { state: "PAUSED" }, after_value: { state: "PAUSED" } }] as PpcProposalItem[],
    policy(),
  );
  assert.equal(same.ok, false);
  assert.equal(same.warnings[0].kind, "duplicate");

  const bad = validateProposalItems(
    [{ entity_type: "campaign", change_type: "state", amazon_entity_id: "C1", after_value: { state: "STOP" } }] as PpcProposalItem[],
    policy(),
  );
  assert.equal(bad.ok, false);
  assert.match(bad.warnings[0].message, /ENABLED \/ PAUSED \/ ARCHIVED/);
});

test("validateProposalItems: đổi tên thiếu tên mới → blocked; đủ thì giữ nguyên", () => {
  const bad = validateProposalItems([{ entity_type: "campaign", change_type: "name", amazon_entity_id: "C1", after_value: {} }] as PpcProposalItem[], policy());
  assert.equal(bad.ok, false);
  assert.match(bad.warnings[0].message, /thiếu tên mới/);

  const okOut = validateProposalItems(
    [{ entity_type: "campaign", change_type: "name", amazon_entity_id: "C1", after_value: { name: "  SP main 2026  " } }] as PpcProposalItem[],
    policy(),
  );
  assert.equal(okOut.items[0].after_value?.name, "SP main 2026");
});

test("validateProposalItems: lô trộn nhiều loại → giữ dòng đúng, loại dòng sai, message đếm đủ", () => {
  const out = validateProposalItems(
    [
      { entity_type: "keyword", change_type: "bid", amazon_entity_id: "K1", before_value: { bid: 1.2 }, after_value: { bid: 1.02 } },
      { entity_type: "keyword", change_type: "bid", amazon_entity_id: "K2", before_value: { bid: 1.2 }, after_value: { bid: 1.2 } },
      { entity_type: "campaign", change_type: "budget", amazon_entity_id: "C1", before_value: { budget: 25 }, after_value: { budget: 999 } },
    ] as PpcProposalItem[],
    policy(),
  );
  assert.equal(out.ok, true);
  assert.equal(out.items.length, 1);
  assert.match(out.message, /1 đề xuất/);
  assert.match(out.message, /1 bị chặn/);
  assert.match(out.message, /1 trùng/);
});

test("buildProposalPayload: đúng tên khoá RPC đọc, không kèm khoá thừa", () => {
  const payload = buildProposalPayload({ shopId: SHOP, items: [{ entity_type: "keyword", change_type: "bid", after_value: { bid: 1 } }], reason: "ACOS cao" });
  assert.deepEqual(Object.keys(payload).sort(), ["items", "reason", "seller_account_id", "source"]);
  assert.equal(payload.seller_account_id, SHOP);
  assert.equal(payload.source, "manual");
  assert.equal("ads_profile_id" in payload, false, "không có profileId thì không gửi khoá rỗng");

  const withProfile = buildProposalPayload({ shopId: SHOP, items: [], adsProfileId: "111", source: "suggestion" });
  assert.equal(withProfile.ads_profile_id, "111");
  assert.equal(withProfile.source, "suggestion");
});

/* ================================================================== */
/* 6. Phủ định nhập tay                                               */
/* ================================================================== */

test("validateNegativeDraft: thiếu dữ liệu / trùng / kiểu lạ → báo đúng lý do", () => {
  assert.equal(validateNegativeDraft({ campaignId: "C1", keywordText: "", matchType: "NEGATIVE_EXACT", level: "campaign" }).ok, false);
  assert.match(
    String((validateNegativeDraft({ campaignId: "", keywordText: "x", matchType: "NEGATIVE_EXACT", level: "campaign" }) as { message: string }).message),
    /Chưa chọn campaign/,
  );
  const noGroup = validateNegativeDraft({ campaignId: "C1", adGroupId: "", keywordText: "x", matchType: "NEGATIVE_EXACT", level: "ad_group" });
  assert.equal(noGroup.ok, false);
  assert.match(noGroup.message, /ad group/);

  const badMatch = validateNegativeDraft({ campaignId: "C1", keywordText: "x", matchType: "broad", level: "campaign" });
  assert.equal(badMatch.ok, false);
  assert.match(badMatch.message, /Không nhận ra kiểu phủ định/);

  const dup = validateNegativeDraft({ campaignId: "C1", adGroupId: "AG1", keywordText: "FREE SAMPLE", matchType: "NEGATIVE_EXACT", level: "ad_group" }, { negatives: [negative()] });
  assert.equal(dup.ok, false);
  assert.match(dup.message, /đã nằm trong danh sách phủ định/);

  const long = validateNegativeDraft({ campaignId: "C1", keywordText: "x".repeat(101), matchType: "NEGATIVE_EXACT", level: "campaign" });
  assert.equal(long.ok, false);
  assert.match(long.message, /100 ký tự/);
});

test("validateNegativeDraft: hợp lệ → sinh đúng MỘT đề xuất create, cấp campaign không kèm ad_group", () => {
  const out = validateNegativeDraft({ campaignId: "C1", keywordText: "  free gift  ", matchType: "phrase", level: "campaign", reason: "đốt tiền" });
  assert.equal(out.ok, true);
  if (!out.ok || !out.item) throw new Error("unreachable");
  assert.equal(out.item.entity_type, "campaign_negative_keyword");
  assert.equal(out.item.change_type, "create");
  assert.equal(out.item.label, "free gift");
  assert.equal(out.item.match_type, "NEGATIVE_PHRASE");
  assert.equal(out.item.ad_group_id, "");
  assert.equal(out.item.reason, "đốt tiền");
  assert.equal(out.item.after_value?.level, "campaign");
});

/* ================================================================== */
/* 7. Guardrail form                                                  */
/* ================================================================== */

function draft(over: Record<string, unknown> = {}) {
  return {
    autoApply: false,
    requireApprovalState: true,
    maxBidChangePct: "20",
    maxBudgetChangePct: "30",
    bidFloor: "0.2",
    bidCeiling: "3",
    budgetFloor: "5",
    budgetCeiling: "200",
    dailyChangeCap: "50",
    maxOpenRequests: "100",
    proposalTtlHours: "72",
    bidStepPct: "15",
    currency: "usd",
    notes: "",
    ...over,
  } as never;
}

test("validatePolicyDraft: guardrail vô nghĩa bị chặn với lý do tiếng Việt", () => {
  assert.match(String((validatePolicyDraft(draft({ bidFloor: "5", bidCeiling: "1" })) as { message: string }).message), /Sàn bid/);
  assert.match(String((validatePolicyDraft(draft({ budgetFloor: "300", budgetCeiling: "200" })) as { message: string }).message), /Sàn ngân sách/);
  assert.match(String((validatePolicyDraft(draft({ maxBidChangePct: "0" })) as { message: string }).message), /% thay đổi bid/);
  assert.match(String((validatePolicyDraft(draft({ maxBidChangePct: "150" })) as { message: string }).message), /% thay đổi bid/);
  assert.match(String((validatePolicyDraft(draft({ dailyChangeCap: "0" })) as { message: string }).message), /Trần thay đổi mỗi ngày/);
  assert.match(String((validatePolicyDraft(draft({ dailyChangeCap: "900" })) as { message: string }).message), /Trần thay đổi mỗi ngày/);
  assert.match(String((validatePolicyDraft(draft({ proposalTtlHours: "0" })) as { message: string }).message), /Hạn duyệt/);
  assert.match(String((validatePolicyDraft(draft({ maxOpenRequests: "-1" })) as { message: string }).message), /đề xuất đang mở/);
  assert.match(String((validatePolicyDraft(draft({ currency: "US" })) as { message: string }).message), /mã 3 chữ/);
  assert.match(String((validatePolicyDraft(draft({ bidStepPct: "200" })) as { message: string }).message), /Bước bid/);
});

test("validatePolicyDraft: hợp lệ → payload đúng tên khoá, null vẫn GỬI để xoá ràng buộc", () => {
  const out = validatePolicyDraft(draft({ bidCeiling: "", notes: "  " }));
  assert.equal(out.ok, true);
  if (!out.ok || !out.policy) throw new Error("unreachable");
  assert.equal(out.policy.currency, "USD", "chuẩn hoá mã tiền tệ viết hoa");
  assert.equal(out.policy.auto_apply, false);
  assert.equal(out.policy.max_bid_change_pct, 20);
  assert.equal("bid_ceiling" in out.policy, true, "để trống trần = XOÁ ràng buộc, phải gửi khoá với null");
  assert.equal(out.policy.bid_ceiling, null);
  assert.equal(out.policy.notes, null);
  assert.equal(out.policy.bid_floor, 0.2);
  assert.match(out.message, /auto_apply tắt/);

  const auto = validatePolicyDraft(draft({ autoApply: "1" }));
  assert.equal(auto.ok, true);
  if (auto.ok) assert.match(auto.message, /AUTO_APPLY đang BẬT/);
});

test("policyGuardLines: nói rõ sàn/trần, trần ngày còn lại, TTL và luật bật/tắt", () => {
  const lines = policyGuardLines(policy());
  assert.equal(lines.length, 5);
  assert.match(lines[0], /AUTO_APPLY TẮT/);
  assert.match(lines[1], /0\.2 … 3 USD/);
  assert.match(lines[2], /hôm nay đã áp dụng 3, còn 47/);
  assert.match(lines[3], /72 giờ/);
  assert.match(lines[4], /LUÔN cần người duyệt/);

  const auto = policyGuardLines(policy({ autoApply: true }));
  assert.match(auto[0], /AUTO_APPLY BẬT/);
  assert.match(auto[0], /±20% bid/);
  const noCeiling = policyGuardLines(policy({ bidCeiling: null }));
  assert.match(noCeiling[1], /không trần/);
});

/* ================================================================== */
/* 8. Gom nhóm hàng đợi cho UI                                        */
/* ================================================================== */

test("queueStats: đếm đúng từng trạng thái, total là tổng số dòng", () => {
  const s = queueStats([
    request({ id: "1", status: "proposed" }),
    request({ id: "2", status: "approved" }),
    request({ id: "3", status: "applying" }),
    request({ id: "4", status: "applied" }),
    request({ id: "5", status: "failed" }),
    request({ id: "6", status: "skipped" }),
    request({ id: "7", status: "expired" }),
    request({ id: "8", status: "rejected" }),
  ]);
  assert.deepEqual(s, { proposed: 1, approved: 1, applying: 1, applied: 1, failed: 1, skipped: 1, rejected: 1, expired: 1, total: 8 });
  assert.deepEqual(queueStats([]), { proposed: 0, approved: 0, applying: 0, applied: 0, failed: 0, skipped: 0, rejected: 0, expired: 0, total: 0 });
});

test("pendingApproval: bỏ dòng quá hạn, chờ LÂU NHẤT lên đầu (sắp hết TTL thì phải duyệt trước)", () => {
  const list = pendingApproval([
    request({ id: "new", ageHours: 1 }),
    request({ id: "old", ageHours: 60 }),
    request({ id: "mid", ageHours: 20 }),
    request({ id: "gone", ageHours: 90, expired: true }),
    request({ id: "done", status: "applied", ageHours: 99 }),
  ]);
  assert.deepEqual(list.map((r) => r.id), ["old", "mid", "new"]);
});

test("waitingForCron: approved + applying, xếp theo lúc duyệt để biết cái nào đi trước", () => {
  const list = waitingForCron([
    request({ id: "b", status: "approved", decidedAt: "2026-09-13T03:00:00Z" }),
    request({ id: "a", status: "applying", decidedAt: "2026-09-13T01:00:00Z" }),
    request({ id: "c", status: "proposed", decidedAt: null }),
  ]);
  assert.deepEqual(list.map((r) => r.id), ["a", "b"]);
});

test("recentResults: chỉ trạng thái cuối, mới nhất trước, có giới hạn", () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    request({ id: `r${i}`, status: "applied" as const, appliedAt: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z` }),
  );
  const list = recentResults([...many, request({ id: "open", status: "proposed" })], 10);
  assert.equal(list.length, 10);
  assert.equal(list.some((r) => r.id === "open"), false);
  assert.equal(String(list[0].appliedAt) > String(list[1].appliedAt), true, "mới nhất trước");
});

test("groupSuggestions: nhóm theo loại, ưu tiên 1 trước, trong nhóm xếp theo tiền đang đốt", () => {
  const groups = groupSuggestions([
    suggestion({ suggestionKey: "a", kind: "lower_bid", kindLabel: "Hạ bid", priority: 3, waste7: 2 }),
    suggestion({ suggestionKey: "b", kind: "negative_keyword", kindLabel: "Phủ định", priority: 1, waste7: 5 }),
    suggestion({ suggestionKey: "c", kind: "negative_keyword", kindLabel: "Phủ định", priority: 1, waste7: 20 }),
    suggestion({ suggestionKey: "d", kind: "raise_budget", kindLabel: "Tăng ngân sách", priority: 4, waste7: 0 }),
  ]);
  assert.deepEqual(groups.map((g) => g.kind), ["negative_keyword", "lower_bid", "raise_budget"]);
  assert.deepEqual(groups[0].items.map((i) => i.suggestionKey), ["c", "b"], "đốt nhiều tiền hơn thì lên trước");
  assert.equal(groups[0].priority, 1);
  assert.deepEqual(groupSuggestions([]), []);
});

test("màu trạng thái: failed đỏ, applied xanh, chờ duyệt vàng — không đổi tuỳ hứng", () => {
  assert.equal(requestStatusTone("failed"), "red");
  assert.equal(requestStatusTone("proposed"), "amber");
  assert.equal(requestStatusTone("applied"), "green");
  assert.equal(requestStatusTone("approved"), "blue");
  assert.equal(requestStatusTone("expired"), "gray");
  assert.equal(requestStatusTone("không rõ"), "gray");
  assert.equal(suggestionTone("negative_keyword"), "red");
  assert.equal(suggestionTone("raise_budget"), "green");
  assert.equal(suggestionTone("pause_campaign"), "amber");
});

test("writeEmptyReason: nói đúng việc phải làm cho từng tình huống, ổn rồi thì trả null", () => {
  const demo = writeEmptyReason({ mode: "demo", suggestions: 0, requests: 0, policies: 0, writeEnabled: false, partialErrors: [] });
  assert.match(demo?.title ?? "", /Chưa nối Supabase/);

  const noSuggestion = writeEmptyReason({ mode: "supabase", suggestions: 0, requests: 0, policies: 1, writeEnabled: true, partialErrors: [] });
  assert.ok(noSuggestion?.lines.some((l) => /ads-sync/.test(l)));

  const notEnabled = writeEmptyReason({ mode: "supabase", suggestions: 3, requests: 1, policies: 1, writeEnabled: false, partialErrors: [] });
  assert.ok(notEnabled?.lines.some((l) => /ADS_WRITE_ENABLED/.test(l)));

  const hasSuggestionsOnly = writeEmptyReason({ mode: "supabase", suggestions: 3, requests: 0, policies: 1, writeEnabled: true, partialErrors: [] });
  assert.ok(hasSuggestionsOnly?.lines.some((l) => /Tạo đề xuất/.test(l)));

  const partial = writeEmptyReason({ mode: "supabase", suggestions: 3, requests: 2, policies: 1, writeEnabled: true, partialErrors: ["không đọc được gợi ý"] });
  assert.ok(partial?.lines.some((l) => /không đọc được gợi ý/.test(l)));

  assert.equal(writeEmptyReason({ mode: "supabase", suggestions: 3, requests: 2, policies: 1, writeEnabled: true, partialErrors: [] }), null);
});

test("roundMoney khớp roundBid của write.ts (UI hứa số nào cron gửi số đó)", async () => {
  const { roundBid } = await import("../src/lib/ads/write.ts");
  for (const v of [1.005, 1.015, 0.07, 30.005, 2.675, 1.0049, 0.1 + 0.2, 12.345, 99.999]) {
    assert.equal(roundMoney(v), roundBid(v), `lệch ở ${v}`);
  }
  // và con số đã làm tròn phải nằm trong after_value gửi lên RPC
  const out = validateProposalItems(
    [{ entity_type: "keyword", change_type: "bid", amazon_entity_id: "K1", before_value: { bid: 1.2 }, after_value: { bid: 1.005 } }] as PpcProposalItem[],
    policy(),
  );
  assert.equal(out.items[0].after_value?.bid, 1.01);
});

test("money + signedPct: không bịa số khi thiếu, không cộng tiền khác tiền tệ", () => {
  assert.equal(money(null, "USD"), "—");
  assert.equal(money(8.4, "USD"), "8.40 USD");
  assert.equal(money(1234.5, "USD"), "1,235 USD");
  assert.equal(money(-3.2, "VND"), "−3.20 VND");
  assert.equal(money(5, null), "5.00");
  assert.equal(signedPct(null), "—");
  assert.equal(signedPct(-15), "-15%");
  assert.equal(signedPct(12.5), "+12.5%");
  assert.equal(signedPct(0), "0%");
});
