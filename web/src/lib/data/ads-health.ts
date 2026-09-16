/**
 * CHẨN ĐOÁN KẾT NỐI AMAZON ADS cho màn A1 (`/ppc`) — phần ĐỌC (server-only).
 *
 * Luật nghiệp vụ + câu chữ "việc cần làm" nằm ở `ads-health-model.ts` (thuần,
 * có test). File này chỉ: đếm dữ liệu thật trong DB rồi ghép thành 5 cổng.
 *
 *   1. Credential Ads trong env (Ads là ĐĂNG KÝ RIÊNG — không dùng app SP-API)
 *   2. Shop đã nhìn thấy profile Ads (`connections.ad_profiles`)
 *   3. Cấu trúc campaign đã đồng bộ (`ads.campaigns`)
 *   4. Metrics đã nhập (`ads.ad_metrics_daily`)
 *   5. Lỗi ở lần xin report gần nhất (`connections.report_requests`) — nơi phơi
 *      ra các lỗi 400 "Invalid groupBy/column" mà trước đây bị chôn trong log cron
 *
 * Chỉ ĐỌC — không ghi gì, không cần service_role, không lộ token.
 */
import { createClient } from "@/lib/supabase/server";
import {
  buildGates,
  readAdsCredentialsPresence,
  type AdsCounts,
  type AdsCredentialsPresence,
  type AdsGate,
  type AdsReportRequestRaw,
} from "./ads-health-model.ts";

export {
  ADS_ENV,
  buildGates,
  readAdsCredentialsPresence,
} from "./ads-health-model.ts";
export type {
  AdsCounts,
  AdsCredentialsPresence,
  AdsGate,
  AdsGateKey,
  AdsReportRequestRaw,
} from "./ads-health-model.ts";

export type AdsDiagnostics = {
  /** true = đọc được Supabase */
  ok: boolean;
  error: string | null;
  credentials: AdsCredentialsPresence;
  counts: AdsCounts;
  gates: AdsGate[];
  /** cổng đầu tiên CHƯA mở — UI lấy câu này làm tiêu đề */
  firstBlocked: AdsGate | null;
  requests: AdsReportRequestRaw[];
};

async function countRows(
  table: string,
  opts: { select?: string; gte?: { column: string; value: string } } = {},
): Promise<number | null> {
  const client = await createClient();
  if (!client) return null;
  let q = client.from(table).select(opts.select ?? "seller_account_id", { count: "exact", head: true });
  if (opts.gte) q = q.gte(opts.gte.column, opts.gte.value);
  const { count, error } = await q;
  if (error) return null;
  return count ?? 0;
}

/** Ngày metrics mới nhất — dùng view KPI (đã có sẵn `last_day`). */
async function lastAdsMetricDay(): Promise<string | null> {
  const client = await createClient();
  if (!client) return null;
  const { data, error } = await client
    .from("vexim_ads_kpi")
    .select("last_day")
    .order("last_day", { ascending: false, nullsFirst: false })
    .limit(1);
  if (error || !data || data.length === 0) return null;
  const day = (data[0] as { last_day?: string | null }).last_day;
  return day ?? null;
}

export async function readAdsDiagnostics(): Promise<AdsDiagnostics> {
  const credentials = readAdsCredentialsPresence();
  const empty: AdsDiagnostics = {
    ok: false,
    error: null,
    credentials,
    counts: { profiles: null, campaigns: null, targets: null, searchTerms: null, metricRows: null, lastMetricDay: null },
    gates: [],
    firstBlocked: null,
    requests: [],
  };

  const client = await createClient();
  if (!client)
    return { ...empty, error: "Chưa cấu hình Supabase (chế độ demo) — không chẩn đoán được." };

  // Chỉ dùng những VIEW thật có trong 0020 (không đoán tên bảng): thiếu view ⇒
  // countRows trả null và cổng tương ứng hiện "chưa đọc được", không sập trang.
  const [profiles, campaigns, targets, searchTerms, metricRows, lastMetricDay] = await Promise.all([
    countRows("vexim_ads_profiles", { select: "ads_profile_id" }),
    countRows("vexim_ads_campaigns", { select: "campaign_id" }),
    countRows("vexim_ads_targets", { select: "target_key" }),
    countRows("vexim_ads_search_terms", { select: "search_term" }),
    countRows("vexim_ads_account_daily", { select: "day" }),
    lastAdsMetricDay(),
  ]);

  let requests: AdsReportRequestRaw[] = [];
  let requestsError: string | null = null;
  {
    const { data, error } = await client
      .from("vexim_report_requests")
      .select("shop,report_type,status,rows_imported,last_error,requested_at,age_minutes,is_stale")
      .in("report_type", [
        "spCampaigns",
        "spTargeting",
        "spSearchTerm",
        "spAdvertisedProduct",
        "spPurchasedProduct",
      ])
      .order("requested_at", { ascending: false, nullsFirst: false })
      .limit(10);
    if (error) requestsError = error.message;
    else requests = (data ?? []) as AdsReportRequestRaw[];
  }

  const counts = { profiles, campaigns, targets, searchTerms, metricRows, lastMetricDay };
  const gates = buildGates(credentials, counts, requests);
  return {
    ok: true,
    error: requestsError,
    credentials,
    counts,
    gates,
    firstBlocked: gates.find((g) => !g.ok && !g.blocked) ?? null,
    requests,
  };
}
