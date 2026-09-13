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
