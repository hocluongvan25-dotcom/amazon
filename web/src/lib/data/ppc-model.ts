/**
 * Hợp đồng dữ liệu cho màn A1 — Quảng cáo (PPC) đọc từ view `public.vexim_ads_*`
 * của migration 0020. Tách khỏi `ppc.ts` (phần đọc) để test được phần tính toán
 * mà không cần Supabase.
 *
 * NGUYÊN TẮC SỐ LIỆU (đúng theo 0020 — đọc kỹ trước khi sửa):
 *   • ACOS/ROAS/CPC/CTR là SỐ SUY RA (view tính từ cost ÷ sales). Reporting v3
 *     KHÔNG trả các cột này — đừng đi tìm cột trong DB rồi kết luận "chưa sync".
 *   • Cửa sổ 7/14/30 ngày tính theo NGÀY CÓ SỐ MỚI NHẤT của shop, không phải 7
 *     ngày theo lịch: shop tạm dừng quảng cáo thì "7 ngày" là 7 ngày cuối cùng
 *     còn chạy — nếu không, mọi chỉ số sẽ tụt về 0 và trông như thảm hoạ.
 *   • NULL khác 0: mẫu số không đọc được (chưa có doanh thu) ⇒ "—", KHÔNG hiện
 *     0.0% (số 0 giả khiến người vận hành tưởng quảng cáo đang lãi).
 *   • Ngân sách: `budget_state='capped'` = chi ≥ 95% ngân sách ngày. Không so
 *     ngân sách USD với số chi CAD — view đã trả 'unknown' cho trường hợp đó.
 */

export type AdsCampaignRaw = {
  seller_account_id: string;
  shop: string;
  ads_profile_id: string | null;
  campaign_id: string;
  campaign_type: string | null;
  name: string;
  state: string | null;
  targeting_type: string | null;
  daily_budget: number | null;
  currency: string | null;
  last_day: string | null;
  spend_yesterday: number | null;
  spend_7d: number | null;
  spend_14d: number | null;
  spend_30d: number | null;
  sales_7d: number | null;
  sales_14d: number | null;
  sales_30d: number | null;
  purchases_7d: number | null;
  units_7d: number | null;
  clicks_7d: number | null;
  impressions_7d: number | null;
  cpc_7d: number | null;
  ctr_7d: number | null;
  acos_7d: number | null;
  acos_14d: number | null;
  acos_30d: number | null;
  roas_7d: number | null;
  budget_usage_yesterday_pct: number | null;
  budget_state: string | null;
  capped_days_30d: number | null;
  last_capped_day: string | null;
};

export type AdsKpiRaw = {
  seller_account_id: string;
  shop: string;
  currency: string | null;
  last_day: string | null;
  spend_7d: number | null;
  spend_14d: number | null;
  spend_30d: number | null;
  sales_7d: number | null;
  sales_14d: number | null;
  sales_30d: number | null;
  purchases_7d: number | null;
  units_7d: number | null;
  clicks_7d: number | null;
  impressions_7d: number | null;
  cpc_7d: number | null;
  acos_7d: number | null;
  acos_14d: number | null;
  acos_30d: number | null;
  roas_7d: number | null;
};

export type AdsBudgetEventRaw = {
  id: string;
  seller_account_id: string;
  shop: string;
  day: string;
  campaign_id: string;
  campaign_name: string | null;
  event_type: string;
  budget_amount: number | null;
  currency: string | null;
  cost: number | null;
  usage_pct: number | null;
  exhausted_hour: number | null;
  hour_source: string | null;
  hour_known: boolean;
  note: string | null;
};

export const ADS_CAMPAIGN_SELECT =
  "seller_account_id,shop,ads_profile_id,campaign_id,campaign_type,name,state,targeting_type," +
  "daily_budget,currency,last_day,spend_yesterday,spend_7d,spend_14d,spend_30d,sales_7d,sales_14d," +
  "sales_30d,purchases_7d,units_7d,clicks_7d,impressions_7d,cpc_7d,ctr_7d,acos_7d,acos_14d," +
  "acos_30d,roas_7d,budget_usage_yesterday_pct,budget_state,capped_days_30d,last_capped_day";

export const ADS_KPI_SELECT =
  "seller_account_id,shop,currency,last_day,spend_7d,spend_14d,spend_30d,sales_7d,sales_14d," +
  "sales_30d,purchases_7d,units_7d,clicks_7d,impressions_7d,cpc_7d,acos_7d,acos_14d,acos_30d,roas_7d";

export const ADS_BUDGET_EVENT_SELECT =
  "id,seller_account_id,shop,day,campaign_id,campaign_name,event_type,budget_amount,currency," +
  "cost,usage_pct,exhausted_hour,hour_source,hour_known,note";

/* ------------------------------------------------------------------ */
/* Định dạng                                                          */
/* ------------------------------------------------------------------ */

/** null/rỗng → "—": KHÔNG hiện 0 giả (0 nghĩa là "đã đo được và bằng 0"). */
export function adsMoney(value: number | null | undefined, currency = ""): string {
  if (value === null || value === undefined) return "—";
  const sym = currency ? `${currency} ` : "";
  return `${sym}${Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** ACOS/CTR/usage: một chữ số thập phân; null → "—". */
export function adsPct(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${Number(value).toFixed(1)}%`;
}

export function adsNum(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return Number(value).toLocaleString("en-US");
}

/* ------------------------------------------------------------------ */
/* UI                                                                 */
/* ------------------------------------------------------------------ */

export type BudgetTone = "red" | "amber" | "gray" | "green";

export type BudgetState = {
  label: string;
  tone: BudgetTone;
  hint: string;
};

/** Trạng thái ngân sách của campaign — luật nằm ở VIEW, ở đây chỉ dịch ra chữ. */
export function budgetStateOf(row: Pick<AdsCampaignRaw, "budget_state" | "budget_usage_yesterday_pct" | "daily_budget" | "currency" | "capped_days_30d">): BudgetState {
  const pct = row.budget_usage_yesterday_pct;
  switch (row.budget_state) {
    case "capped":
      return {
        label: "Cạn ngân sách",
        tone: "red",
        hint:
          `Hôm qua dùng ${adsPct(pct)} ngân sách ngày` +
          (row.capped_days_30d && row.capped_days_30d > 0 ? ` · ${row.capped_days_30d} ngày cạn trong 30 ngày` : "") +
          " — SOP-04: nới ngân sách hoặc siết từ khoá.",
      };
    case "ok":
      return { label: "Còn ngân sách", tone: "green", hint: `Hôm qua dùng ${adsPct(pct)} ngân sách ngày.` };
    case "no_data":
      return {
        label: "Chưa có số",
        tone: "gray",
        hint: "Chưa có dữ liệu chi tiêu cho ngày này (shop có thể đã tạm dừng hoặc report chưa về).",
      };
    case "unknown":
      return {
        label: "Không so được",
        tone: "gray",
        hint:
          row.daily_budget === null || (row.daily_budget ?? 0) <= 0
            ? "Campaign chưa có ngân sách ngày trong dữ liệu Campaign Management."
            : "Ngân sách và số chi KHÁC TIỀN TỆ — không so để tránh kết luận sai.",
      };
    default:
      return { label: "—", tone: "gray", hint: "Chưa đọc được trạng thái ngân sách." };
  }
}

export type CampaignTypeLabel = "SP" | "SB" | "SD" | "—";

export function campaignTypeBadge(campaignType: string | null): { label: CampaignTypeLabel; title: string } {
  const t = (campaignType ?? "").toUpperCase();
  if (t.includes("SPONSORED_PRODUCTS") || t === "SP") return { label: "SP", title: "Sponsored Products" };
  if (t.includes("SPONSORED_BRANDS") || t === "SB") return { label: "SB", title: "Sponsored Brands" };
  if (t.includes("SPONSORED_DISPLAY") || t === "SD") return { label: "SD", title: "Sponsored Display" };
  return { label: "—", title: "Chưa rõ loại campaign" };
}

/** ACOS vượt ngưỡng mục tiêu (mặc định 25% — khớp rule `acos_over_target`). */
export function isAcosOverTarget(acos7d: number | null, targetPct = 25): boolean {
  return acos7d !== null && acos7d > targetPct;
}

export type PpcAlertTone = "red" | "amber" | "green";

/** Dựng danh sách "Cần xử lý ngay" từ số liệu THẬT (không phải câu chữ demo). */
export function ppcAlertsFrom(rows: {
  campaigns: AdsCampaignRaw[];
  budgetEvents: AdsBudgetEventRaw[];
  negativeSuggestionsPending: number;
}): { tone: PpcAlertTone; text: string }[] {
  const out: { tone: PpcAlertTone; text: string }[] = [];

  const capped = rows.campaigns.filter((c) => c.budget_state === "capped");
  if (capped.length > 0) {
    const sample = capped
      .slice(0, 3)
      .map((c) => c.name)
      .join(" · ");
    out.push({
      tone: "red",
      text:
        `${capped.length} campaign cạn ngân sách ngày hôm qua (${sample}` +
        `${capped.length > 3 ? " …" : ""}) — đang mất đơn vào phần còn lại của ngày.`,
    });
  }

  const over = rows.campaigns.filter((c) => isAcosOverTarget(c.acos_7d));
  if (over.length > 0) {
    const worst = over.slice().sort((a, b) => (b.acos_7d ?? 0) - (a.acos_7d ?? 0))[0];
    out.push({
      tone: "amber",
      text:
        `${over.length} campaign ACOS 7 ngày vượt 25% — nặng nhất "${worst.name}" ` +
        `${adsPct(worst.acos_7d)} (chi ${adsMoney(worst.spend_7d, worst.currency ?? "")}) — SOP-05: xem lại bid/từ khoá.`,
    });
  }

  const hourUnknown = rows.budgetEvents.filter((e) => !e.hour_known).length;
  if (out.length === 0 && rows.campaigns.length > 0) {
    out.push({ tone: "green", text: "Không campaign nào vượt ngưỡng ACOS hay cạn ngân sách trong 7 ngày gần nhất." });
  }

  if (rows.negativeSuggestionsPending > 0) {
    out.push({
      tone: "green",
      text:
        `${rows.negativeSuggestionsPending} gợi ý negative keyword đang chờ duyệt (A3) — ` +
        "duyệt để chặn từ khoá đốt tiền mà không ra đơn.",
    });
  } else if (hourUnknown > 0) {
    out.push({
      tone: "amber",
      text:
        `Biết ${hourUnknown} ngày cạn ngân sách nhưng CHƯA biết giờ cạn — Reporting API v3 không có dữ liệu theo giờ ` +
        "(cần Amazon Marketing Stream mới có).",
    });
  }

  return out;
}

export type PpcKpiCard = { label: string; value: string; sub: string; tone: "up" | "down" | "flat" | "warn" };

/** KPI cho màn A1 — gộp theo shop để không cộng chéo tiền tệ. */
export function kpiCardsFrom(kpis: AdsKpiRaw[], tacosPct: number | null): PpcKpiCard[] {
  if (kpis.length === 0) return [];
  // Cùng shop có thể có nhiều dòng (mỗi tiền tệ một dòng) — hiện dòng lớn nhất,
  // ghi rõ tiền tệ, KHÔNG cộng USD với CAD thành một con số.
  const main = kpis.slice().sort((a, b) => (b.spend_7d ?? 0) - (a.spend_7d ?? 0))[0];
  const cur = main.currency ?? "";
  const cards: PpcKpiCard[] = [
    {
      label: "Chi tiêu 7 ngày",
      value: adsMoney(main.spend_7d, cur),
      sub: `Ngày mới nhất ${main.last_day ?? "—"} · ${adsNum(main.clicks_7d)} click`,
      tone: "flat",
    },
    {
      label: "ACOS 7 ngày",
      value: adsPct(main.acos_7d),
      sub: `14 ngày ${adsPct(main.acos_14d)} · 30 ngày ${adsPct(main.acos_30d)}`,
      tone: isAcosOverTarget(main.acos_7d) ? "down" : "up",
    },
    {
      label: "ROAS 7 ngày",
      value: main.roas_7d === null ? "—" : `${Number(main.roas_7d).toFixed(2)}×`,
      sub: `Doanh thu ${adsMoney(main.sales_7d, cur)}`,
      tone: main.roas_7d !== null && main.roas_7d >= 4 ? "up" : "flat",
    },
  ];
  cards.push(
    tacosPct === null
      ? {
          label: "TACOS",
          value: "—",
          sub: "Thiếu doanh thu sản phẩm cùng kỳ (F4) để tính",
          tone: "warn",
        }
      : {
          label: "TACOS",
          value: `${tacosPct.toFixed(1)}%`,
          sub: `Chi ads ÷ doanh thu sản phẩm 7 ngày (F4) · ${cur}`,
          tone: tacosPct <= 8 ? "up" : "warn",
        },
  );
  cards.push({
    label: "Đơn từ quảng cáo",
    value: adsNum(main.purchases_7d),
    sub: `${adsNum(main.units_7d)} sản phẩm · CPC ${adsMoney(main.cpc_7d, cur)}`,
    tone: "flat",
  });
  return cards;
}

/**
 * TACOS thật = tổng chi ads ÷ tổng doanh thu sản phẩm TRONG CÙNG 7 NGÀY CÓ SỐ
 * (không dùng doanh thu toàn shop khác kỳ: TACOS sai kỳ là TACOS vô nghĩa).
 * Trả null khi thiếu một trong hai, hoặc khi tiền tệ lệch nhau.
 */
export type TacosInput = {
  last_day: string | null;
  currency: string | null;
  spend_7d: number | null;
};

export function computeTacos(
  kpi: TacosInput | undefined,
  revenueRows: { day: string; currency: string; revenue: number | null }[],
): number | null {
  if (!kpi || kpi.spend_7d === null || kpi.spend_7d === undefined || kpi.last_day === null) return null;
  const last = Date.parse(`${kpi.last_day}T00:00:00Z`);
  if (Number.isNaN(last)) return null;
  const from = new Date(last - 6 * 86_400_000).toISOString().slice(0, 10);
  const currency = (kpi.currency ?? "").toUpperCase();
  if (currency === "") return null;

  let revenue = 0;
  let seen = 0;
  for (const r of revenueRows) {
    if (r.day < from || r.day > String(kpi.last_day)) continue;
    if ((r.currency ?? "").toUpperCase() !== currency) continue; // KHÔNG trộn tiền tệ
    revenue += Number(r.revenue ?? 0);
    seen++;
  }
  if (seen === 0 || revenue <= 0) return null;
  return (Number(kpi.spend_7d) / revenue) * 100;
}

/* ==================================================================== */
/* MODULE 5 PHẦN 2 & 3 — A2 (ad group/target) · A3 (search term) · P3  */
/* (hàng đợi duyệt · revert · audit)                                   */
/* ==================================================================== */
/*
 * NGUYÊN TẮC (đọc trước khi sửa):
 *   • A2/A3 KHÔNG tự quyết định ngưỡng duyệt: DB (trigger 0021 §5) tính lại
 *     `requires_approval` từ before/after thật. UI chỉ hiển thị lời DB trả về —
 *     hiển thị "cần duyệt" mà DB cho auto-approve (hoặc ngược lại) là tự lừa.
 *   • `before_value`/`after_value` là JSONB `{value: ...}` ⇒ đọc bằng `*_text`,
 *     KHÔNG so sánh số trực tiếp trên `before_value` (jsonb không so sánh =).
 *   • `pending_*` của A3 là gợi ý ĐANG CHỜ; `negative_keyword_id` là ĐÃ CHẶN.
 *     Chỉ hiện nút "Thêm negative" khi CHƯA chặn; đã chặn thì hiện nhãn.
 */

export type AdsAdGroupRaw = {
  seller_account_id: string;
  shop: string;
  ads_profile_id: string | null;
  campaign_id: string;
  campaign_name: string | null;
  campaign_state: string | null;
  ad_group_id: string;
  name: string;
  state: string | null;
  default_bid: number | null;
  currency: string | null;
  last_day: string | null;
  spend_7d: number | null;
  sales_7d: number | null;
  purchases_7d: number | null;
  clicks_7d: number | null;
  impressions_7d: number | null;
  target_count: number | null;
  enabled_targets: number | null;
  cpc_7d: number | null;
  ctr_7d: number | null;
  acos_7d: number | null;
  roas_7d: number | null;
  updated_at: string | null;
};

export const ADS_AD_GROUP_SELECT =
  "seller_account_id,shop,ads_profile_id,campaign_id,campaign_name,campaign_state,ad_group_id," +
  "name,state,default_bid,currency,last_day,spend_7d,sales_7d,purchases_7d,clicks_7d,impressions_7d," +
  "target_count,enabled_targets,cpc_7d,ctr_7d,acos_7d,roas_7d,updated_at";

export type AdsTargetRaw = {
  seller_account_id: string;
  shop: string;
  ads_profile_id: string | null;
  campaign_id: string;
  campaign_name: string | null;
  ad_group_id: string;
  ad_group_name: string | null;
  target_kind: string;
  target_key: string;
  keyword_text: string | null;
  match_type: string | null;
  expression_type: string | null;
  expression_value: string | null;
  bid: number | null;
  state: string | null;
  currency: string | null;
  last_day: string | null;
  spend_7d: number | null;
  sales_7d: number | null;
  purchases_7d: number | null;
  units_7d: number | null;
  clicks_7d: number | null;
  impressions_7d: number | null;
  cpc_7d: number | null;
  ctr_7d: number | null;
  acos_7d: number | null;
  roas_7d: number | null;
  updated_at: string | null;
};

export const ADS_TARGET_SELECT =
  "seller_account_id,shop,ads_profile_id,campaign_id,campaign_name,ad_group_id,ad_group_name," +
  "target_kind,target_key,keyword_text,match_type,expression_type,expression_value,bid,state," +
  "currency,last_day,spend_7d,sales_7d,purchases_7d,units_7d,clicks_7d,impressions_7d,cpc_7d," +
  "ctr_7d,acos_7d,roas_7d,updated_at";

export type AdsSearchTermRaw = {
  seller_account_id: string;
  shop: string;
  campaign_id: string;
  campaign_name: string | null;
  campaign_state: string | null;
  ad_group_id: string;
  ad_group_name: string | null;
  keyword_id: string | null;
  keyword_text: string | null;
  term: string | null;
  match_type: string | null;
  currency: string | null;
  last_day: string | null;
  impressions_7d: number | null;
  clicks_7d: number | null;
  spend_7d: number | null;
  sales_7d: number | null;
  purchases_7d: number | null;
  units_7d: number | null;
  spend_14d: number | null;
  sales_14d: number | null;
  has_orders_7d: boolean | null;
  last_order_day: string | null;
  cpc_7d: number | null;
  ctr_7d: number | null;
  acos_7d: number | null;
  roas_7d: number | null;
  acos_14d: number | null;
  pending_suggestion_id: string | null;
  pending_suggestion_type: string | null;
  pending_confidence: number | null;
  pending_confidence_label: string | null;
  pending_reasons: unknown;
  pending_evidence: unknown;
  negative_keyword_id: string | null;
  negative_match_type: string | null;
};

export const ADS_SEARCH_TERM_SELECT =
  "seller_account_id,shop,campaign_id,campaign_name,campaign_state,ad_group_id,ad_group_name," +
  "keyword_id,keyword_text,term,match_type,currency,last_day,impressions_7d,clicks_7d,spend_7d," +
  "sales_7d,purchases_7d,units_7d,spend_14d,sales_14d,has_orders_7d,last_order_day,cpc_7d,ctr_7d," +
  "acos_7d,roas_7d,acos_14d,pending_suggestion_id,pending_suggestion_type,pending_confidence," +
  "pending_confidence_label,pending_reasons,pending_evidence,negative_keyword_id,negative_match_type";

export type AdsChangeRaw = {
  id: string;
  seller_account_id: string;
  shop: string;
  ads_profile_id: string | null;
  entity_type: string;
  entity_key: string;
  campaign_id: string | null;
  ad_group_id: string | null;
  entity_label: string | null;
  action: string;
  payload: unknown;
  before_value: unknown;
  after_value: unknown;
  before_text: string | null;
  after_text: string | null;
  currency: string | null;
  reason: string | null;
  suggestion_id: string | null;
  requires_approval: boolean;
  approval_reason: string | null;
  status: string;
  requested_by: string | null;
  requested_by_name: string | null;
  requested_at: string | null;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  applied_at: string | null;
  error: string | null;
  attempts: number | null;
  revert_of: string | null;
  reverted_by: string | null;
  source: string | null;
  is_open: boolean | null;
  can_revert: boolean | null;
  created_at: string | null;
  updated_at: string | null;
};

export const ADS_CHANGE_SELECT =
  "id,seller_account_id,shop,ads_profile_id,entity_type,entity_key,campaign_id,ad_group_id," +
  "entity_label,action,payload,before_value,after_value,before_text,after_text,currency,reason," +
  "suggestion_id,requires_approval,approval_reason,status,requested_by,requested_by_name," +
  "requested_at,decided_by,decided_by_name,decided_at,decision_note,applied_at,error,attempts," +
  "revert_of,reverted_by,source,is_open,can_revert,created_at,updated_at";

export type AdsNegativeKeywordRaw = {
  id: string;
  seller_account_id: string;
  shop: string;
  campaign_id: string | null;
  campaign_name: string | null;
  ad_group_id: string | null;
  ad_group_name: string | null;
  keyword_id: string | null;
  keyword_text: string;
  match_type: string | null;
  state: string | null;
  source: string | null;
  change_request_id: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export const ADS_NEGATIVE_KEYWORD_SELECT =
  "id,seller_account_id,shop,campaign_id,campaign_name,ad_group_id,ad_group_name,keyword_id," +
  "keyword_text,match_type,state,source,change_request_id,created_at,updated_at";

export type AdsAuditRaw = {
  id: string;
  created_at: string | null;
  seller_account_id: string | null;
  shop: string | null;
  module: string | null;
  action: string;
  entity: string | null;
  before_value: unknown;
  after_value: unknown;
  before_text: string | null;
  after_text: string | null;
  result: string | null;
  actor_id: string | null;
  actor_name: string | null;
};

export const ADS_AUDIT_SELECT =
  "id,created_at,seller_account_id,shop,module,action,entity,before_value,after_value," +
  "before_text,after_text,result,actor_id,actor_name";

/* ---------------- Nhãn & suy diễn (thuần, test được) ---------------- */

export function targetKindLabel(kind: string | null): string {
  switch ((kind ?? "").toLowerCase()) {
    case "keyword":
      return "Từ khoá";
    case "product":
      return "Nhóm sản phẩm";
    case "auto":
      return "Tự động (auto)";
    case "asin":
      return "ASIN";
    case "category":
      return "Ngành hàng";
    default:
      return kind ?? "—";
  }
}

export function matchTypeLabel(matchType: string | null): string {
  switch ((matchType ?? "").toUpperCase()) {
    case "BROAD":
      return "Rộng";
    case "PHRASE":
      return "Cụm từ";
    case "EXACT":
      return "Chính xác";
    case "NEGATIVE_EXACT":
      return "Chặn chính xác";
    case "NEGATIVE_PHRASE":
      return "Chặn cụm từ";
    case "AUTO":
      return "Tự động";
    default:
      return matchType ?? "—";
  }
}

/** Chữ hiển thị cho một target: keyword_text → expression_value → target_key. */
export function targetText(row: {
  keyword_text?: string | null;
  expression_value?: string | null;
  target_key?: string | null;
}): string {
  return (
    row.keyword_text?.trim() ||
    row.expression_value?.trim() ||
    row.target_key?.trim() ||
    "(không có tên)"
  );
}

export type ChangeStatusMeta = { label: string; tone: "red" | "amber" | "green" | "gray" | "blue"; hint: string };

export function changeStatusMeta(status: string | null): ChangeStatusMeta {
  switch (status) {
    case "pending_approval":
      return {
        label: "Chờ trưởng phòng duyệt",
        tone: "amber",
        hint: "Chưa gửi gì lên Amazon. Tăng > 30%/ngày phải được trưởng phòng PPC duyệt trước (SOP-05 bước 4).",
      };
    case "approved":
      return {
        label: "Đã duyệt — chờ worker gửi",
        tone: "blue",
        hint: "Worker (worker:ads-apply / cron 03:00) sẽ gửi lên Amazon Ads; chưa chắc Amazon đã nhận.",
      };
    case "applying":
      return {
        label: "Đang gửi Amazon",
        tone: "blue",
        hint: "Worker đã nhận yêu cầu và đang gọi API. Throttle 429 thì tự trả lại hàng đợi (không mất dấu).",
      };
    case "applied":
      return { label: "Amazon đã nhận", tone: "green", hint: "API đã trả SUCCESS cho mọi phần tử." };
    case "failed":
      return {
        label: "Amazon từ chối",
        tone: "red",
        hint: "Xem cột lỗi. Giá trị cục bộ GIỮ NGUYÊN — hệ thống không ghi số chưa được Amazon nhận.",
      };
    case "rejected":
      return { label: "Bị từ chối", tone: "red", hint: "Trưởng phòng từ chối; không gửi lên Amazon." };
    case "cancelled":
      return { label: "Đã huỷ", tone: "gray", hint: "Người yêu cầu tự huỷ trước khi gửi." };
    default:
      return { label: status ?? "—", tone: "gray", hint: "Trạng thái không nhận dạng được." };
  }
}

/** Chữ cho hành động (khớp `action` trong ads.change_requests). */
export function changeActionLabel(action: string | null): string {
  switch (action) {
    case "set_budget":
      return "Đổi ngân sách ngày";
    case "set_bid":
      return "Đổi bid từ khoá";
    case "set_state":
      return "Bật/tạm dừng";
    case "add_negative_exact":
      return "Thêm negative (chính xác)";
    case "add_negative_phrase":
      return "Thêm negative (cụm từ)";
    default:
      return action ?? "—";
  }
}

/**
 * % thay đổi so với giá trị cũ — DÙNG ĐỂ HIỂN THỊ.
 * Không dùng để quyết định "cần duyệt": DB đã quyết (xem `requires_approval`).
 * Trả null khi không so được (thiếu giá trị cũ, giá trị cũ ≤ 0, không phải số).
 */
export function changePct(before: string | null | undefined, after: string | null | undefined): number | null {
  const b = Number(before);
  const a = Number(after);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
  return Math.round(((a - b) * 100 * 10) / b) / 10;
}

export function changePctLabel(before: string | null | undefined, after: string | null | undefined): string {
  const pct = changePct(before, after);
  if (pct === null) return "—";
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

/** "Ngân sách ngày 100 → 120 (+20.0%)" — một dòng đọc được trong hàng đợi. */
export function changeSummary(row: Pick<AdsChangeRaw, "action" | "before_text" | "after_text" | "currency">): string {
  const cur = row.currency ? `${row.currency} ` : "";
  const b = row.before_text ?? "—";
  const a = row.after_text ?? "—";
  if (row.action === "set_state") return `${b} → ${a}`;
  if (row.action?.startsWith("add_negative")) return `Chặn "${a}"`;
  return `${cur}${b} → ${cur}${a} (${changePctLabel(row.before_text, row.after_text)})`;
}

export type SuggestionType = "negative_exact" | "negative_phrase" | string;

export function suggestionMatchLabel(suggestionType: SuggestionType | null): string {
  return suggestionType === "negative_phrase" ? "Negative Phrase (cụm từ)" : "Negative Exact (chính xác)";
}

/** Nhãn ngắn để hiện trên chip: "Exact" / "Phrase". */
export function suggestionShortLabel(suggestionType: SuggestionType | null): string {
  return suggestionType === "negative_phrase" ? "Phrase" : "Exact";
}

/* ---------------- A3: bộ lọc tự động theo SOP-04 ---------------- */

export type A3Filter = {
  /** Chi tối thiểu trong 7 ngày (đơn vị tiền của shop) — mặc định 10. */
  minSpend: number;
  /** Click tối thiểu trong 7 ngày — mặc định 5 (dưới 5 click thì chưa kết luận). */
  minClicks: number;
  /** Chỉ lấy dòng KHÔNG ra đơn trong 7 ngày (SOP-04: đốt tiền mà không chuyển đổi). */
  onlyNoOrders: boolean;
  /** Từ khoá tìm trong term/keyword/ad group. */
  q?: string;
  /** Lọc theo một campaign (A2 → A3 của campaign đó). */
  campaignId?: string;
  /** Lọc theo shop. */
  sellerAccountId?: string;
};

export const A3_DEFAULT_FILTER: A3Filter = { minSpend: 10, minClicks: 5, onlyNoOrders: true };

/**
 * Bộ lọc A3 — "search term đốt tiền": có click, chi ≥ ngưỡng, KHÔNG ra đơn.
 * Dòng đã được chặn rồi (`negative_keyword_id`) vẫn hiện để đối chiếu nhưng UI
 * đánh dấu "đã chặn"; hàm này KHÔNG loại chúng (loại là quyết định hiển thị).
 */
export function filterSearchTerms(rows: AdsSearchTermRaw[], filter: Partial<A3Filter> = {}): AdsSearchTermRaw[] {
  const f = { ...A3_DEFAULT_FILTER, ...filter };
  const needle = (f.q ?? "").trim().toLowerCase();
  return rows.filter((r) => {
    if (f.sellerAccountId && r.seller_account_id !== f.sellerAccountId) return false;
    if (f.campaignId && r.campaign_id !== f.campaignId) return false;
    if (f.onlyNoOrders && (r.purchases_7d ?? 0) > 0) return false;
    if ((r.clicks_7d ?? 0) < f.minClicks) return false;
    if ((r.spend_7d ?? 0) < f.minSpend) return false;
    if (needle) {
      const hay = [r.term ?? "", r.keyword_text ?? "", r.ad_group_name ?? "", r.campaign_name ?? ""]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

/** Bằng chứng SOP-04 cho một dòng search term: "12 click · 0 đơn · 18.40 USD · 7 ngày". */
export function a3Evidence(row: AdsSearchTermRaw): string {
  const cur = row.currency ? `${row.currency} ` : "";
  const spend = row.spend_7d === null || row.spend_7d === undefined ? "—" : `${cur}${Number(row.spend_7d).toFixed(2)}`;
  return `${adsNum(row.clicks_7d)} click · ${adsNum(row.purchases_7d)} đơn · ${spend} · 7 ngày`;
}

/**
 * Dòng A3 đáng chặn mà CHƯA ai làm gì (để nhắc "bấm mở A3").
 *
 * `inFlight` (tuỳ chọn): bản đồ yêu cầu chặn đang bay. Phải truyền vào, nếu không
 * thì sau khi duyệt gợi ý (pending_suggestion_id = null, gương negative chưa có)
 * dòng vẫn bị đếm là "chưa ai làm gì" — đúng cái nhầm đã dẫn tới chặn trùng.
 * Dòng đã LỖI vẫn nằm trong danh sách này vì nó vẫn cần người xử lý (thử lại).
 */
export function a3ReadyToBlock(
  rows: AdsSearchTermRaw[],
  filter: Partial<A3Filter> = {},
  inFlight: Record<string, A3InFlight> = {},
): AdsSearchTermRaw[] {
  return filterSearchTerms(rows, filter).filter(
    (r) =>
      r.negative_keyword_id === null &&
      r.pending_suggestion_id === null &&
      a3HasOpenChange(inFlight, r) === null,
  );
}

/* ---------------- A3: dữ liệu này CŨ tới đâu? (chống đọc số cũ rồi chặn oan) ---------------- */

/**
 * Ngày dữ liệu mới nhất trong tập search term.
 *
 * Vì sao phải hiện con số này: các cột `*_7d` của view KHÔNG phải "7 ngày gần
 * hôm nay" mà là "7 ngày cuối cùng CÓ dữ liệu" (`last_day` theo từng shop). Cron
 * ngừng chạy 3 tuần thì màn vẫn hiện "chi 7 ngày" của 3 tuần trước — nhìn như số
 * mới. Nói rõ ngày dữ liệu là cách duy nhất để người vận hành không chặn từ khoá
 * dựa trên số cũ.
 */
export function a3LatestDay(rows: AdsSearchTermRaw[]): string | null {
  let max: string | null = null;
  for (const r of rows) {
    const d = r.last_day;
    if (!d) continue;
    if (max === null || d > max) max = d;
  }
  return max;
}

export type A3Freshness = {
  /** ngày dữ liệu mới nhất (null = chưa có dòng nào) */
  day: string | null;
  /** số ngày kể từ ngày dữ liệu tới hôm nay (null = không tính được) */
  ageDays: number | null;
  /** true = dữ liệu đứng quá lâu (cron không chạy) — phải cảnh báo TRƯỚC khi chặn */
  stale: boolean;
  label: string;
};

/** Ngưỡng coi là "cũ": report Ads theo ngày, trễ 2 ngày là bình thường (T-1 + giờ Amazon). */
export const A3_STALE_DAYS = 2;

export function a3Freshness(rows: AdsSearchTermRaw[], today: Date = new Date()): A3Freshness {
  const day = a3LatestDay(rows);
  if (day === null) {
    return { day: null, ageDays: null, stale: false, label: "chưa có ngày dữ liệu" };
  }
  const parsed = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed)) {
    return { day, ageDays: null, stale: false, label: `dữ liệu tới ${day}` };
  }
  const todayUtc = Date.parse(`${today.toISOString().slice(0, 10)}T00:00:00Z`);
  const ageDays = Math.round((todayUtc - parsed) / 86_400_000);
  const stale = ageDays > A3_STALE_DAYS;
  return {
    day,
    ageDays,
    stale,
    label:
      ageDays <= 0
        ? `dữ liệu tới ${day} (hôm nay)`
        : `dữ liệu tới ${day} · cách đây ${ageDays} ngày${stale ? " — CŨ" : ""}`,
  };
}

/**
 * Cảnh báo CHẶN OAN cho một dòng: bộ lọc SOP-04 chỉ soi 7 ngày
 * (`purchases_7d = 0`), nhưng view có sẵn doanh số 14 ngày. Dòng nào 14 ngày CÓ
 * doanh số thì chặn là cắt luôn phần đang ra đơn ⇒ phải nói ra trước khi bấm.
 */
export function a3BlockRisk(row: AdsSearchTermRaw): string | null {
  const sales14 = row.sales_14d;
  if (sales14 === null || sales14 === undefined || Number(sales14) <= 0) return null;
  if ((row.purchases_7d ?? 0) > 0) return null;
  return `Có doanh số trong 14 ngày (${adsMoney(sales14, row.currency ?? "")}) — 7 ngày qua không đơn: chặn là cắt phần này.`;
}

/* ---------------- A3: yêu cầu chặn ĐANG BAY (chống chặn trùng) ---------------- */

/** Hành động của A3 trong hàng đợi: chỉ 2 loại này mới liên quan search term. */
const A3_NEGATIVE_ACTIONS = ["add_negative_exact", "add_negative_phrase"] as const;

/** Khoá tự nhiên nối 1 dòng A3 với yêu cầu ghi: campaign · ad group · chữ đã chặn. */
export function a3ChangeKey(campaignId: string | null, adGroupId: string | null, term: string | null): string {
  return [campaignId ?? "", adGroupId ?? "", (term ?? "").trim().toLowerCase()].join("|");
}

export type A3InFlight = {
  changeId: string;
  status: string;
  /** lỗi Amazon của lần ghi trước (chỉ có khi status = failed) */
  error: string | null;
};

/**
 * Gom các yêu cầu chặn CÒN BAY (`pending_approval` / `approved` / `applying`) và
 * cả dòng `failed` — để A3 biết một term ĐÃ có yêu cầu rồi.
 *
 * Vì sao cần: sau khi duyệt, `pending_suggestion_id` biến mất còn gương negative
 * chỉ có sau khi worker ghi THÀNH CÔNG. Khoảng giữa đó, nếu màn chỉ nhìn 2 cột ấy
 * thì dòng trông y như "chưa làm gì" ⇒ người vận hành bấm "Chặn (Exact)" lần nữa và
 * Amazon trả lỗi trùng (hoặc tệ hơn: tạo 2 yêu cầu cho cùng một chữ).
 */
export function a3InFlightMap(changes: AdsChangeRaw[]): Record<string, A3InFlight> {
  const out: Record<string, A3InFlight> = {};
  for (const c of changes) {
    if (!(A3_NEGATIVE_ACTIONS as readonly string[]).includes(c.action)) continue;
    if (c.entity_type !== "search_term") continue;
    // `entity_key` là `text not null default ''` trong DB ⇒ chuỗi RỖNG là ca thật,
    // không phải null. Rỗng thì lấy chữ đã chặn từ after_value.value (view trả sẵn).
    const rawTerm = (c.entity_key ?? "").trim() !== "" ? c.entity_key : c.after_text;
    const key = a3ChangeKey(c.campaign_id, c.ad_group_id, rawTerm ?? null);
    const next: A3InFlight = {
      changeId: c.id,
      status: c.status,
      error: c.error ?? null,
    };
    // Cùng một term có thể có nhiều dòng: ưu tiên dòng ĐANG BAY hơn dòng đã lỗi
    // (nếu lần trước lỗi mà lần này đã duyệt lại thì cái đang bay mới là sự thật).
    const cur = out[key];
    if (!cur || !isOpenChangeStatus(cur.status)) out[key] = next;
  }
  return out;
}

/** Trạng thái "đang bay": chưa tới Amazon (hoặc Amazon chưa trả lời) — TS gọn cho UI. */
export function isOpenChangeStatus(status: string | null | undefined): boolean {
  return status === "pending_approval" || status === "approved" || status === "applying";
}

/** Dòng A3 có yêu cầu chặn đang bay (KHÔNG được tạo thêm) hay không. */
export function a3HasOpenChange(map: Record<string, A3InFlight>, row: AdsSearchTermRaw): A3InFlight | null {
  const hit = map[a3ChangeKey(row.campaign_id, row.ad_group_id, row.term)];
  return hit && isOpenChangeStatus(hit.status) ? hit : null;
}

/** Yêu cầu chặn của dòng này đã LỖI ở lần ghi trước (được phép thử lại). */
export function a3FailedChange(map: Record<string, A3InFlight>, row: AdsSearchTermRaw): A3InFlight | null {
  const hit = map[a3ChangeKey(row.campaign_id, row.ad_group_id, row.term)];
  return hit && hit.status === "failed" ? hit : null;
}

/* ---------------- Hàng đợi duyệt (P3) ---------------- */

/** Chia hàng đợi thành 3 nhóm hiển thị: chờ duyệt · đang bay · đã xong. */
export function splitQueue(rows: AdsChangeRaw[]): {
  pending: AdsChangeRaw[];
  inflight: AdsChangeRaw[];
  done: AdsChangeRaw[];
} {
  const pending: AdsChangeRaw[] = [];
  const inflight: AdsChangeRaw[] = [];
  const done: AdsChangeRaw[] = [];
  for (const r of rows) {
    if (r.status === "pending_approval") pending.push(r);
    else if (r.status === "approved" || r.status === "applying") inflight.push(r);
    else done.push(r);
  }
  return { pending, inflight, done };
}

/** Dòng có thể bấm Revert 1 phát (Ops) — đúng luật `can_revert` của view. */
export function revertible(rows: AdsChangeRaw[]): AdsChangeRaw[] {
  return rows.filter((r) => r.can_revert === true);
}

export const AUDIT_ACTION_LABEL: Record<string, string> = {
  "ads.change_request": "Tạo yêu cầu thay đổi",
  "ads.budget_change_request": "Yêu cầu đổi ngân sách",
  "ads.bid_change_request": "Yêu cầu đổi bid",
  "ads.state_change_request": "Yêu cầu bật/tạm dừng",
  "ads.negative_add_request": "Yêu cầu thêm negative",
  "ads.change_approve": "Trưởng phòng duyệt",
  "ads.change_reject": "Trưởng phòng từ chối",
  "ads.change_cancel": "Huỷ yêu cầu",
  "ads.change_applied": "Amazon đã nhận",
  "ads.change_failed": "Amazon từ chối",
  "ads.change_released": "Trả lại hàng đợi (throttle)",
  "ads.change_revert": "Ops đảo thay đổi",
  "ads.suggestion_approve": "Duyệt gợi ý A3",
  "ads.suggestion_reject": "Từ chối gợi ý A3",
  "ads.suggestion_dismiss": "Bỏ qua gợi ý A3",
};

export function auditActionLabel(action: string | null): string {
  return AUDIT_ACTION_LABEL[action ?? ""] ?? action ?? "—";
}
