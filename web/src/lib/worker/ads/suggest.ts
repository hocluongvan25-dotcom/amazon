/**
 * SINH GỢI Ý NEGATIVE KEYWORD từ report search term (Module 5 P2 · SOP-04).
 *
 * VÌ SAO CÓ FILE NÀY:
 *   Toàn bộ đường ống A3 đã sẵn — bảng ads.negative_suggestions (0020), RPC
 *   vexim_worker_upsert_ads_suggestions, view vexim_ads_search_terms trả
 *   pending_suggestion_id, UI có nút "Duyệt & chặn" — NHƯNG không có job nào
 *   SINH gợi ý cả. Cột "Gợi ý" trên màn A3 vĩnh viễn là "không có gợi ý".
 *   File này là mắt xích thiếu: chạy ngay sau khi nhập report search-terms.
 *
 * LUẬT SOP-04 (khớp bộ lọc mặc định của màn A3 — A3_DEFAULT_FILTER):
 *   • cửa sổ 7 ngày tính từ ngày MỚI NHẤT trong report (không phải hôm nay —
 *     report Ads trễ 1-2 ngày là bình thường);
 *   • ≥ 5 click · chi ≥ 10 (đơn vị tiền của shop) · 0 đơn trong cửa sổ;
 *   • gợi ý NEGATIVE_EXACT theo đúng search term người mua gõ.
 *
 * KHÔNG "AI đoán": mỗi gợi ý kèm evidence (click/chi/đơn/cửa sổ) + reasons
 * chữ người đọc được. Con người vẫn là người bấm duyệt (RPC 0021 kiểm quyền);
 * dòng đã được quyết rồi thì RPC upsert giữ nguyên (không ghi đè).
 */
import type { AdsSuggestionRowInput } from "../db/adapter.ts";

/** Ngưỡng SOP-04 có thể nới/siết khi gọi (test, hoặc shop chi tiêu lớn). */
export type SuggestRules = {
  windowDays: number;
  minClicks: number;
  minSpend: number;
  maxSuggestions: number;
};

/** Ngưỡng SOP-04 — cùng con số với A3_DEFAULT_FILTER ở web (ppc-model.ts). */
export const SUGGEST_RULES: SuggestRules = {
  windowDays: 7,
  minClicks: 5,
  minSpend: 10,
  /** chỉ giữ N gợi ý chi nhiều nhất mỗi lần chạy — tránh dội 5000 dòng vào màn duyệt */
  maxSuggestions: 200,
};

/** Một dòng search term đã parse (shape của parseAdsReportText kind=search-terms). */
export type SearchTermDailyRow = {
  day: string;
  campaignId: string;
  adGroupId: string;
  searchTerm: string;
  keywordId?: string | null;
  keywordText?: string | null;
  matchType?: string | null;
  clicks?: number | null;
  cost?: number | null;
  purchases7d?: number | null;
  currency?: string | null;
  adsProfileId?: string | null;
};

/**
 * Gộp theo (campaign, ad group, term) trong cửa sổ 7 ngày rồi áp luật SOP-04.
 * Trả về mảng cho db.upsertAdsSuggestions — rỗng nếu không có gì đáng chặn
 * (đó là tin tốt, không phải lỗi).
 */
export function buildNegativeSuggestions(
  rows: readonly SearchTermDailyRow[],
  opts: { rules?: Partial<SuggestRules> } = {},
): AdsSuggestionRowInput[] {
  const rules = { ...SUGGEST_RULES, ...opts.rules };
  if (rows.length === 0) return [];

  // Cửa sổ tính từ ngày mới nhất TRONG DỮ LIỆU (report Ads luôn trễ vài ngày).
  const lastDay = rows.reduce((m, r) => (r.day > m ? r.day : m), rows[0].day);
  const cutoff = shiftDay(lastDay, -(rules.windowDays - 1));

  type Agg = {
    campaignId: string;
    adGroupId: string;
    term: string;
    keywordId: string | null;
    keywordText: string | null;
    matchType: string | null;
    adsProfileId: string | null;
    currency: string | null;
    clicks: number;
    spend: number;
    purchases: number;
  };
  const byTerm = new Map<string, Agg>();

  for (const r of rows) {
    const term = (r.searchTerm ?? "").trim();
    if (!term || !r.campaignId || !r.adGroupId) continue;
    if (r.day < cutoff || r.day > lastDay) continue;
    const key = [r.campaignId, r.adGroupId, term.toLowerCase()].join("\u0000");
    let a = byTerm.get(key);
    if (!a) {
      a = {
        campaignId: r.campaignId,
        adGroupId: r.adGroupId,
        term,
        keywordId: r.keywordId ?? null,
        keywordText: r.keywordText ?? null,
        matchType: r.matchType ?? null,
        adsProfileId: r.adsProfileId ?? null,
        currency: r.currency ?? null,
        clicks: 0,
        spend: 0,
        purchases: 0,
      };
      byTerm.set(key, a);
    }
    a.clicks += Number(r.clicks ?? 0);
    a.spend += Number(r.cost ?? 0);
    a.purchases += Number(r.purchases7d ?? 0);
  }

  const out: AdsSuggestionRowInput[] = [];
  for (const a of byTerm.values()) {
    if (a.purchases > 0) continue; // có đơn → không phải "đốt tiền"
    if (a.clicks < rules.minClicks) continue; // chưa đủ bằng chứng thống kê
    if (a.spend < rules.minSpend) continue;

    // Tin cậy: càng nhiều click không ra đơn càng chắc — 5 click là ngưỡng
    // tối thiểu (0.5), từ 20 click trở lên coi như chắc chắn (1.0).
    const confidence = Math.min(1, 0.5 + ((a.clicks - rules.minClicks) / 30));
    const spendText = `${a.currency ? `${a.currency} ` : ""}${a.spend.toFixed(2)}`;
    out.push({
      campaignId: a.campaignId,
      adGroupId: a.adGroupId,
      term: a.term,
      matchType: a.matchType ?? "",
      keywordId: a.keywordId,
      keywordText: a.keywordText,
      targetKind: "search_term",
      suggestionType: "negative_exact",
      confidence: Math.round(confidence * 1000) / 1000,
      confidenceLabel: confidence >= 0.8 ? "cao" : confidence >= 0.6 ? "trung bình" : "đủ ngưỡng",
      windowDays: rules.windowDays,
      adsProfileId: a.adsProfileId,
      evidence: {
        clicks: a.clicks,
        spend: Math.round(a.spend * 100) / 100,
        purchases: a.purchases,
        windowDays: rules.windowDays,
        from: cutoff,
        to: lastDay,
      },
      reasons: [
        `${a.clicks} click nhưng 0 đơn trong ${rules.windowDays} ngày (${cutoff} → ${lastDay})`,
        `đã chi ${spendText} cho từ khoá này mà không có chuyển đổi`,
        `đạt ngưỡng SOP-04 (≥ ${rules.minClicks} click · chi ≥ ${rules.minSpend})`,
      ],
    });
  }

  // Chi nhiều nhất lên trước; cắt trần để màn duyệt không bị dội.
  out.sort((x, y) => Number((y.evidence as { spend: number }).spend) - Number((x.evidence as { spend: number }).spend));
  return out.slice(0, rules.maxSuggestions);
}

/** Cộng/trừ ngày trên chuỗi YYYY-MM-DD (UTC — ngày report Ads không có giờ). */
function shiftDay(day: string, delta: number): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  return new Date(t + delta * 86_400_000).toISOString().slice(0, 10);
}
