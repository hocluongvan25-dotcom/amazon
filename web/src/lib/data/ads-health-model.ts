/**
 * PHẦN THUẦN của chẩn đoán kết nối Amazon Ads — không import Supabase/Next để
 * `node --test` kiểm được (cùng kiểu ppc-model.ts / listing-model.ts).
 *
 * Luật quan trọng nhất ở đây: **không bao giờ trả GIÁ TRỊ của credential** — chỉ
 * trả `true/false` từng biến, để panel chẩn đoán không thể vô tình phơi token ra
 * màn hình hay log.
 */

export type AdsReportRequestRaw = {
  shop: string | null;
  report_type: string;
  status: string;
  rows_imported: number | null;
  last_error: string | null;
  requested_at: string | null;
  age_minutes: number | null;
  is_stale: boolean | null;
};

export type AdsCounts = {
  profiles: number | null;
  campaigns: number | null;
  targets: number | null;
  searchTerms: number | null;
  /** số dòng metrics theo ngày (ads.ad_metrics_daily qua view account_daily) */
  metricRows: number | null;
  lastMetricDay: string | null;
};

export type AdsCredentialsPresence = {
  clientId: boolean;
  clientSecret: boolean;
  refreshToken: boolean;
  region: string;
  complete: boolean;
};

export type AdsGateKey =
  | "credentials"
  | "shop_profile"
  | "structure"
  | "metrics"
  | "last_report";

export type AdsGate = {
  key: AdsGateKey;
  label: string;
  ok: boolean;
  /** true = chưa tới lượt kiểm (cổng trước chưa mở) — UI hiện mờ */
  blocked: boolean;
  detail: string;
  /** việc cần làm khi cổng chưa mở */
  fix: string;
};

export const ADS_ENV = {
  clientId: "AMAZON_ADS_CLIENT_ID",
  clientSecret: "AMAZON_ADS_CLIENT_SECRET",
  refreshToken: "AMAZON_ADS_REFRESH_TOKEN",
  region: "AMAZON_ADS_REGION",
} as const;

/** Đọc CÓ/KHÔNG của từng biến (không bao giờ trả giá trị). */
export function readAdsCredentialsPresence(
  env: Record<string, string | undefined> = process.env,
): AdsCredentialsPresence {
  const has = (key: string) => String(env[key] ?? "").trim() !== "";
  const clientId = has(ADS_ENV.clientId) || has("ADS_LWA_CLIENT_ID");
  const clientSecret = has(ADS_ENV.clientSecret) || has("ADS_LWA_CLIENT_SECRET");
  const refreshToken = has(ADS_ENV.refreshToken) || has("ADS_LWA_REFRESH_TOKEN");
  const region = (
    env[ADS_ENV.region] ??
    env.AMAZON_SP_API_REGION ??
    "NA"
  ).toUpperCase();
  return {
    clientId,
    clientSecret,
    refreshToken,
    region,
    // Cả 3 mới dùng được — thiếu 1 là `loadConfig().ads === null` và job trả `skipped`.
    complete: clientId && clientSecret && refreshToken,
  };
}

export function buildGates(
  credentials: AdsCredentialsPresence,
  counts: AdsCounts,
  requests: AdsReportRequestRaw[],
): AdsGate[] {
  const gates: AdsGate[] = [];
  const credsOk = credentials.complete;
  gates.push({
    key: "credentials",
    label: "1. Credential Amazon Ads trên Vercel",
    ok: credsOk,
    blocked: false,
    detail: credsOk
      ? `đã có đủ 3 biến (client id · secret · refresh token), vùng ${credentials.region}`
      : `thiếu ${[
          credentials.clientId ? null : ADS_ENV.clientId,
          credentials.clientSecret ? null : ADS_ENV.clientSecret,
          credentials.refreshToken ? null : ADS_ENV.refreshToken,
        ]
          .filter(Boolean)
          .join(" · ")}`,
    fix:
      "Ads là đăng ký RIÊNG (không dùng app SP-API): đăng ký Amazon Ads API → lấy client id/secret + refresh token → " +
      "Vercel → Settings → Environment Variables → thêm AMAZON_ADS_CLIENT_ID / AMAZON_ADS_CLIENT_SECRET / " +
      "AMAZON_ADS_REFRESH_TOKEN (và AMAZON_ADS_REGION=NA|EU|FE) cho CẢ Production + Preview → Redeploy. " +
      "Chưa có 3 biến này thì mọi job Ads trả `skipped` và màn này luôn trống (đúng thiết kế, không phải lỗi).",
  });

  const profilesOk = (counts.profiles ?? 0) > 0;
  gates.push({
    key: "shop_profile",
    label: "2. Shop có profile Ads (/v2/profiles)",
    ok: profilesOk,
    blocked: !credsOk,
    detail: credsOk
      ? counts.profiles === null
        ? "chưa đọc được bảng profile Ads"
        : profilesOk
          ? `${counts.profiles} profile Ads đã ghi vào DB`
          : "0 profile — token Ads chưa nhìn thấy tài khoản quảng cáo nào"
      : "chờ cổng 1",
    fix:
      "Sau khi có credential: chạy đồng bộ cấu trúc (cron 03:00 hoặc nút “Chạy đồng bộ ngay” bên dưới). " +
      "0 profile thường là do refresh token chưa được cấp quyền cho đúng tài khoản quảng cáo — vào Amazon Ads " +
      "console kiểm tra app đã được authorize cho advertiser account đó chưa.",
  });

  const structureOk = (counts.campaigns ?? 0) > 0;
  gates.push({
    key: "structure",
    label: "3. Cấu trúc campaign đã đồng bộ",
    ok: structureOk,
    blocked: !profilesOk,
    detail: profilesOk
      ? `${counts.campaigns ?? 0} campaign đã ghi vào ads.campaigns (view vexim_ads_campaigns)`
      : "chờ cổng 2",
    fix:
      "Chạy `worker ads:sync` (hoặc nút chạy ngay). 0 campaign có thể là: tài khoản chưa có campaign nào trên Amazon, " +
      "hoặc profile Ads bị chọn sai marketplace (shop US nhưng profile là CA).",
  });

  const metricsOk = (counts.metricRows ?? 0) > 0 || counts.lastMetricDay !== null;
  gates.push({
    key: "metrics",
    label: "4. Số liệu ngày đã nhập (Reporting v3)",
    ok: metricsOk,
    blocked: !structureOk,
    detail: structureOk
      ? metricsOk
        ? `${counts.metricRows} dòng metrics theo ngày · ngày mới nhất ${counts.lastMetricDay ?? "—"} · ` +
          `${counts.targets ?? 0} từ khoá/nhóm sản phẩm · ${counts.searchTerms ?? 0} search term`
        : "chưa có dòng metrics nào — report chưa về hoặc tạo report bị Amazon từ chối"
      : "chờ cổng 3",
    fix:
      "Chạy `worker ads:pull` (hoặc nút chạy ngay). Report v3 bất đồng bộ: xin report → chờ Amazon tạo → tải file; " +
      "lần chạy đầu thường đã có dữ liệu nhưng có thể phải chờ tới lần cron kế tiếp nếu Amazon còn PENDING.",
  });

  const failed = requests.filter((r) => r.status === "failed" || r.status === "fatal");
  const lastError = failed.find((r) => r.last_error)?.last_error ?? null;
  gates.push({
    key: "last_report",
    label: "5. Lần xin report gần nhất",
    ok: failed.length === 0,
    blocked: !structureOk,
    detail: requests.length === 0
      ? "chưa có yêu cầu report nào được ghi lại"
      : failed.length > 0
        ? `${failed.length} report lỗi — lỗi mới nhất: ${lastError ?? "(không kèm mô tả)"}`
        : `${requests.length} yêu cầu report gần đây, không có lỗi`,
    fix:
      failed.length > 0
        ? "Đọc nguyên văn lỗi Amazon ở trên: 400 “Invalid column/groupBy” là sai hợp đồng API (báo cho team code — " +
          "xem worker/tests/ads-engine.test.ts mục 6), 401/invalid_grant là token hết hạn (kết nối lại shop ở Module 0), " +
          "429 là trần tốc độ (chờ lần cron sau)."
        : "Không có việc cần làm.",
  });

  return gates;
}

