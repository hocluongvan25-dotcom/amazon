/**
 * Job Module 0 — NHẮC RE-AUTHORIZE trước khi refresh token hết hạn (SOP-11).
 *
 * Vì sao phải có việc này: LWA refresh token sống 365 ngày. Hết hạn KHÔNG có
 * thông báo nào từ Amazon — mọi module tự dưng ngừng đồng bộ, và triệu chứng
 * (dashboard cũ, report không mới) rất dễ bị đoán nhầm thành lỗi cron. Luật là:
 *   còn ≤ notice_days ngày  →  tạo cảnh báo `oauth_reauth_due` + nhắc 1 lần/ngày.
 *
 * Ai đọc dữ liệu hạn token: RPC `vexim_worker_oauth_soon(p_days)` (0020) — view
 * `vexim_oauth_connections` lọc theo auth.uid() nên service_role đọc ra 0 dòng.
 * Luật "≤ notice_days là phải nhắc" nằm ở DB, JS chỉ gọi và ghi cảnh báo.
 *
 * Idempotent: chỉ nhắc shop chưa được nhắc trong đợt này (`already_noticed=false`),
 * sau khi nhắc thì gọi `mark_oauth_notice` để lần chạy sau KHÔNG nhắc lại —
 * authorize lại sẽ tự reset cờ này (0020).
 */
import type { DbAdapter, OauthSoonRow } from "../db/adapter.ts";

export type OauthNotice = {
  sellerAccountId: string;
  shop: string | null;
  expiresAt: string | null;
  daysLeft: number | null;
  needsReauth: boolean;
  alreadyNoticed: boolean;
  adsProfiles: number;
  /** token còn dùng được (chưa hết hạn, chưa thu hồi) — false = đồng bộ đang DỪNG */
  tokenActive: boolean;
};

export type OauthReminderResult = {
  checked: number;
  /** shop tới hạn nhắc nhưng CHƯA nhắc (đã tạo cảnh báo trong lần chạy này) */
  due: OauthNotice[];
  /** shop đã nhắc rồi — không nhắc lại */
  alreadyNoticed: OauthNotice[];
  /** shop đã hết hạn — càng phải nhắc gấp */
  expired: OauthNotice[];
  alertsCreated: number;
  marked: number;
  dryRun: boolean;
  message: string;
};

export type OauthReminderOptions = {
  db: DbAdapter;
  /** mặc định null = dùng notice_days của từng shop */
  days?: number | null;
  /** chỉ đọc để xem (cron kiểm tra), không tạo cảnh báo và không đánh dấu */
  dryRun?: boolean;
  log?: (s: string) => void;
  now?: Date;
};

export async function runOauthReminder(opts: OauthReminderOptions): Promise<OauthReminderResult> {
  const log = opts.log ?? (() => {});
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? new Date();

  const rows: OauthSoonRow[] = await opts.db.listOauthSoon(opts.days ?? null);

  const toNotice = (r: OauthSoonRow): OauthNotice => ({
    sellerAccountId: r.sellerAccountId,
    shop: r.shop,
    expiresAt: r.expiresAt,
    daysLeft: r.daysLeft,
    needsReauth: r.needsReauth,
    alreadyNoticed: r.alreadyNoticed,
    adsProfiles: r.adsProfiles,
    tokenActive: r.tokenActive,
  });

  const expired = rows.filter((r) => !r.tokenActive).map(toNotice);
  const alreadyNoticed = rows.filter((r) => r.tokenActive && r.alreadyNoticed).map(toNotice);
  const due = rows.filter((r) => r.tokenActive && !r.alreadyNoticed && r.needsReauth);

  log(
    `[oauth-soon] ${rows.length} shop tới hạn nhắc` +
      `${opts.days ? ` (trong ${opts.days} ngày)` : " (theo notice_days từng shop)"} · ` +
      `${due.length} chưa nhắc · ${alreadyNoticed.length} đã nhắc · ${expired.length} đã hết hạn\n`,
  );

  if (dryRun) {
    for (const r of [...expired, ...due]) {
      log(
        `[oauth-soon] ··· ${r.shop ?? r.sellerAccountId}: hết hạn ${r.expiresAt ?? "?"} ` +
          `(còn ${r.daysLeft ?? "?"} ngày)${r.tokenActive ? "" : " — TOKEN ĐÃ HẾT HẠN"}\n`,
      );
    }
    return {
      checked: rows.length,
      due,
      alreadyNoticed,
      expired,
      alertsCreated: 0,
      marked: 0,
      dryRun: true,
      message: "dry-run: chỉ đọc, không tạo cảnh báo và không đánh dấu đã nhắc.",
    };
  }

  let alertsCreated = 0;
  let marked = 0;

  for (const r of [...expired, ...due]) {
    const days = r.daysLeft ?? 0;
    const shopLabel = r.shop ?? r.sellerAccountId;
    try {
      await opts.db.upsertAlert({
        sellerAccountId: r.sellerAccountId,
        ruleCode: "oauth_reauth_due",
        severity: "amber",
        // Tiêu đề CỐ ĐỊNH (không kèm số ngày): worker dedupe theo title trong 24h,
        // thêm số ngày vào title là mỗi ngày một cảnh báo mới.
        title: `oauth_reauth_due · ${shopLabel}`,
        detail:
          (r.tokenActive
            ? `Refresh token LWA của ${shopLabel} còn ${days} ngày (hết hạn ${r.expiresAt ?? "?"}).`
            : `Refresh token LWA của ${shopLabel} ĐÃ HẾT HẠN (${r.expiresAt ?? "?"}) — đồng bộ đang dừng.`) +
          ` Vào Module 0 → Kết nối shop để authorize lại (SOP-11).` +
          (r.adsProfiles > 0
            ? ` Shop này đang có ${r.adsProfiles} profile Amazon Ads dùng chung token.`
            : ""),
      });
      alertsCreated++;
    } catch (e) {
      log(`[oauth-soon] ⚠ không tạo được cảnh báo cho ${shopLabel}: ${(e as Error).message.split("\n")[0]}\n`);
    }

    try {
      await opts.db.markOauthNotice(r.sellerAccountId);
      marked++;
      log(
        `[oauth-soon] OK  ${shopLabel}: đã nhắc re-authorize (còn ${days} ngày, ` +
          `kiểm tra lúc ${now.toISOString()})\n`,
      );
    } catch (e) {
      log(`[oauth-soon] ⚠ không đánh dấu được đã nhắc cho ${shopLabel}: ${(e as Error).message.split("\n")[0]}\n`);
    }
  }

  return {
    checked: rows.length,
    due,
    alreadyNoticed,
    expired,
    alertsCreated,
    marked,
    dryRun: false,
    message:
      rows.length === 0
        ? "không shop nào tới hạn — không cần nhắc."
        : `đã nhắc ${marked} shop (trong đó ${expired.length} đã hết hạn).`,
  };
}
