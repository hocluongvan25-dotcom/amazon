/**
 * Handler notification ACCOUNT_STATUS_CHANGED (Tầng 1 — realtime) cho Module 7.
 *
 * Payload (developer-docs.amazon.com/sp-api/docs/notification-type-values):
 *   {
 *     "notificationVersion": "1.0",
 *     "notificationType": "ACCOUNT_STATUS_CHANGED",
 *     "payloadVersion": "2021-01-01",
 *     "eventTime": "2020-12-11T19:42:04.284Z",
 *     "payload": {
 *       "accountStatusChangeNotification": {
 *         "previousAccountStatus": "NORMAL",
 *         "currentAccountStatus": "AT_RISK"
 *       }
 *     },
 *     "notificationMetadata": { … }
 *   }
 *
 * Giá trị hợp lệ: NORMAL | AT_RISK | DEACTIVATED — Amazon KHÔNG gửi marketplaceId
 * trong payload; subscription là theo cặp seller × marketplace, nên handler BẮT BUỘC
 * nhận `marketplaceId` từ context (destination subscription / mapping shop).
 *
 * Vì sao quan trọng: đây là tín hiệu sớm nhất khi Amazon khoá/mở tài khoản —
 * SLA SOP-08 là ≤ 24h cho mức nghiêm trọng.
 */
import type { AccountHealthSnapshotRowInput, DbAdapter } from "../db/adapter.ts";
import { accountStatusTone, evaluateShopHealth, type HealthTone } from "../domain/account-health.ts";

export type AccountStatusChangedNotification = {
  previousAccountStatus?: string;
  currentAccountStatus?: string;
};

export type AccountStatusChangedEnvelope = {
  EventTime?: string;
  eventTime?: string;
  Payload?: { AccountStatusChangedNotification?: AccountStatusChangedNotification };
  payload?: { accountStatusChangeNotification?: AccountStatusChangedNotification };
};

const VALID_STATUSES = ["NORMAL", "AT_RISK", "DEACTIVATED"] as const;

/** Bóc phần thân payload ở cả hai kiểu casing (PascalCase của Amazon, camelCase của SQS/EventBridge). */
export function extractAccountStatusChange(payload: unknown): AccountStatusChangedNotification | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as AccountStatusChangedEnvelope;
  const body = p.payload?.accountStatusChangeNotification ?? p.Payload?.AccountStatusChangedNotification;
  if (!body) return null;
  const current = String(body.currentAccountStatus ?? "").toUpperCase();
  if (!VALID_STATUSES.includes(current as (typeof VALID_STATUSES)[number])) return null;
  return {
    previousAccountStatus: body.previousAccountStatus
      ? String(body.previousAccountStatus).toUpperCase()
      : undefined,
    currentAccountStatus: current,
  };
}

/** Kiểm tra có phải notification ACCOUNT_STATUS_CHANGED không. */
export function isAccountStatusChanged(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as { notificationType?: string; NotificationType?: string };
  const type = p.notificationType ?? p.NotificationType;
  if (type && type !== "ACCOUNT_STATUS_CHANGED") return false;
  return extractAccountStatusChange(payload) !== null;
}

export type AccountStatusChangeResult = {
  previousStatus: string | null;
  currentStatus: string;
  tone: HealthTone;
  /** DEACTIVATED/AT_RISK có tạo alert không */
  alertCreated: boolean;
  /** NORMAL có tự đóng alert không */
  alertsResolved: boolean;
};

/**
 * Xử lý notification: ghi log → cập nhật snapshot → alert (hoặc tự đóng alert khi NORMAL).
 */
export async function handleAccountStatusChanged(
  payload: unknown,
  adapter: DbAdapter,
  opts: { sellerAccountId: string; marketplaceId: string; now?: Date },
): Promise<AccountStatusChangeResult | null> {
  const change = extractAccountStatusChange(payload);
  if (!change) return null;
  const now = opts.now ?? new Date();
  const currentStatus = change.currentAccountStatus!;
  const tone = accountStatusTone(currentStatus) as HealthTone;

  await adapter.recordNotification({
    sellerAccountId: opts.sellerAccountId,
    notificationType: "ACCOUNT_STATUS_CHANGED",
    raw: payload,
    normalized: {
      previousAccountStatus: change.previousAccountStatus ?? null,
      currentAccountStatus: currentStatus,
      marketplaceId: opts.marketplaceId,
      tone,
    },
    receivedAt: now,
  });

  const health = evaluateShopHealth({
    accountStatus: currentStatus,
    ahrStatus: null,
    rates: [],
    issues: [],
  });

  const row: AccountHealthSnapshotRowInput = {
    sellerAccountId: opts.sellerAccountId,
    day: now.toISOString().slice(0, 10),
    marketplaceId: opts.marketplaceId,
    accountStatus: currentStatus,
    ahrStatus: null,
    tone,
    score: health.score,
    rates: [],
    issues: [],
    sourceReportId: null,
    capturedAt: now,
  };
  await adapter.upsertAccountHealthSnapshot(row);

  let alertCreated = false;
  if (currentStatus === "DEACTIVATED" || currentStatus === "AT_RISK") {
    await adapter.upsertAlert({
      sellerAccountId: opts.sellerAccountId,
      ruleCode: "account_health",
      severity: tone,
      title:
        currentStatus === "DEACTIVATED"
          ? "TÀI KHOẢN BỊ KHOÁ (DEACTIVATED) — SOP-08 khẩn"
          : "Tài khoản AT_RISK — SOP-08",
      detail:
        `ACCOUNT_STATUS_CHANGED: ${change.previousAccountStatus ?? "?"} → ${currentStatus} ` +
        `(marketplace ${opts.marketplaceId}, lúc ${now.toISOString()}). ` +
        (currentStatus === "DEACTIVATED"
          ? "Kiểm tra ngay email/case Amazon, chuẩn bị hồ sơ appeal trong 24h."
          : "Rà vi phạm mở + chỉ số vượt ngưỡng; theo dõi sát trong ngày."),
    });
    alertCreated = true;
  }

  let alertsResolved = false;
  if (currentStatus === "NORMAL" && change.previousAccountStatus !== "NORMAL") {
    await adapter.resolveAlerts({
      sellerAccountId: opts.sellerAccountId,
      ruleCode: "account_health",
      note: `Amazon trả NORMAL (trước: ${change.previousAccountStatus ?? "?"})`,
      resolvedAt: now,
    });
    alertsResolved = true;
  }

  return {
    previousStatus: change.previousAccountStatus ?? null,
    currentStatus,
    tone,
    alertCreated,
    alertsResolved,
  };
}
